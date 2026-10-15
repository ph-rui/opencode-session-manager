'use strict';

/*
 * OpenCode 跨工程会话管理器 — 本地代理服务
 *
 * 职责:
 *   1. 发现 OpenCode 后台服务地址(执行 `opencode service status`)
 *   2. 读取 Basic 鉴权密码(~/.config/opencode/service.json)
 *   3. 静态托管 public/
 *   4. 反向代理 /api/* 到 OpenCode 服务,并注入 Authorization: Basic
 *   5. 流式透传 SSE(text/event-stream)
 *   6. 提供 GET /__health 供前端显示连接状态
 *
 * 仅使用 Node 标准库,零依赖。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { Readable } = require('stream');

const HOST = process.env.OCS_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.OCS_PORT || '49450', 10);
const PANEL_AUTH = process.env.OCS_AUTH || ''; // 形如 "user:pass";设置后需 HTTP Basic 登录
const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
const SERVICE_FILE = path.join(CONFIG_DIR, 'service.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const state = {
  base: null, // OpenCode 服务 base URL
  password: null, // Basic 鉴权密码
  discoveredAt: 0, // 上次发现时间(ms)
  error: null,
};

/* ----------------------------- 服务发现 ----------------------------- */

function readPassword() {
  try {
    const raw = fs.readFileSync(SERVICE_FILE, 'utf8');
    const json = JSON.parse(raw);
    state.password = json.password || null;
  } catch (e) {
    state.password = null;
  }
  return state.password;
}

function discoverBase() {
  return new Promise((resolve) => {
    execFile('opencode', ['service', 'status'], { timeout: 8000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const m = String(stdout).match(/https?:\/\/[^\s'"]+/);
      resolve(m ? m[0].replace(/\/+$/, '') : null);
    });
  });
}

async function ensureDiscovered(force) {
  const fresh = Date.now() - state.discoveredAt < 30000;
  if (!force && state.base && state.password && fresh) return;
  readPassword();
  const base = await discoverBase();
  if (base) state.base = base;
  state.discoveredAt = Date.now();
  state.error = base ? null : '`opencode service status` 未返回地址(服务可能未运行)';
}

function authHeader() {
  return 'Basic ' + Buffer.from('opencode:' + (state.password || '')).toString('base64');
}

// 面板访问控制(可选):设置 OCS_AUTH="user:pass" 后,所有请求需 HTTP Basic 登录。
function panelAuthorized(req) {
  if (!PANEL_AUTH) return true;
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  } catch (_) {
    return false;
  }
  const a = Buffer.from(decoded);
  const b = Buffer.from(PANEL_AUTH);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ----------------------------- 工具函数 ----------------------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ------------------------------- 代理 ------------------------------- */

async function proxy(req, res, attempt) {
  attempt = attempt || 0;
  await ensureDiscovered(attempt > 0);

  if (!state.base) {
    return sendJson(res, 502, { error: 'OpenCode 服务不可用', detail: state.error });
  }

  const target = state.base + req.url;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (['host', 'connection', 'content-length', 'accept-encoding', 'authorization'].includes(lk)) {
      continue;
    }
    headers[k] = v;
  }
  headers['authorization'] = authHeader();
  headers['accept-encoding'] = 'identity';

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const buf = await readRequestBody(req);
    body = buf.length ? buf : undefined;
  }

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: ac.signal,
    });
  } catch (e) {
    if (attempt < 1) return proxy(req, res, attempt + 1);
    if (ac.signal.aborted) return; // 客户端已断开
    return sendJson(res, 502, {
      error: '无法连接 OpenCode 服务',
      detail: String((e && e.message) || e),
    });
  }

  // 服务重启会更换密码;重读 service.json 后重试一次
  if (upstream.status === 401 && attempt < 1) {
    return proxy(req, res, attempt + 1);
  }

  const outHeaders = {};
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(lk)) {
      return;
    }
    outHeaders[k] = v;
  });

  res.writeHead(upstream.status, outHeaders);
  res.flushHeaders && res.flushHeaders();

  if (!upstream.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on('error', () => {
    try {
      res.end();
    } catch (_) {}
  });
  res.on('close', () => {
    try {
      nodeStream.destroy();
    } catch (_) {}
  });
  nodeStream.pipe(res);
}

/* ------------------------------- 静态资源 ------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const rel = path.normalize(decodeURIComponent(p)).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ------------------------------- 健康检查 ------------------------------- */

async function health(res) {
  await ensureDiscovered(true);
  let ok = false;
  let detail = null;
  if (state.base && state.password) {
    try {
      const r = await fetch(state.base + '/api/session?limit=1', {
        headers: { authorization: authHeader() },
      });
      ok = r.ok;
      detail = 'HTTP ' + r.status;
    } catch (e) {
      detail = String((e && e.message) || e);
    }
  } else {
    detail = state.error || '未发现服务或缺失密码';
  }
  sendJson(res, 200, {
    ok,
    base: state.base,
    hasPassword: !!state.password,
    configDir: CONFIG_DIR,
    detail,
  });
}

/* ------------------------------- 路由 ------------------------------- */

const server = http.createServer((req, res) => {
  if (!panelAuthorized(req)) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="OpenCode Session Manager", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end('需要登录 / authentication required');
    return;
  }
  const url = req.url.split('?')[0];
  if (url === '/__health') {
    health(res).catch((e) => sendJson(res, 500, { error: String(e) }));
    return;
  }
  if (url.startsWith('/api/')) {
    proxy(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(e) });
    });
    return;
  }
  serveStatic(req, res);
});

/* ------------------------------- 启动 ------------------------------- */

function listen(port) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && port !== 0) {
      console.warn(`端口 ${port} 被占用,改用随机端口`);
      listen(0);
    } else {
      console.error(e);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const addr = server.address();
    console.log('');
    console.log(`  OpenCode 会话管理器已启动:`);
    console.log(`    http://${HOST}:${addr.port}`);
    console.log(`  服务发现: ${state.base || '(未发现)'}`);
    console.log(`  鉴权密码: ${state.password ? '已加载' : '缺失(检查 ' + SERVICE_FILE + ')'}`);
    console.log(`  面板访问: ${PANEL_AUTH ? '需要登录(Basic)' : '无密码'}`);
    console.log('');
  });
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

(async () => {
  await ensureDiscovered(true);
  listen(PORT);
})();
