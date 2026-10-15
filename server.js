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
 *   6. 提供 GET /__health 供前端显示连接状态(并告知附件的暂存目录)
 *   7. 维护附件暂存目录(建目录 + 定期清理旧文件)
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
// 面板的「附件粘贴区」:浏览器里选的文件没有服务端路径,而 prompt 的 files[].uri 只认
// file: URI(服务端自己去读文件),所以先把字节挪到磁盘上。落盘这一步用的是 OpenCode 自带的
// POST /api/experimental/fs/write,前端直接把绝对路径给它 —— 于是代理层不用再写任何上传端点。
// 代理这边只负责:① 建目录 ② 把 /__health 的 uploadDir 告诉前端 ③ 定期清理旧文件。
const UPLOAD_DIR =
  process.env.OCS_UPLOAD_DIR || path.join(os.tmpdir(), 'opencode-session-manager-uploads');
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000; // 超过 6 小时的上传文件清掉
const UPLOAD_PRUNE_EVERY_MS = 60 * 60 * 1000; // 最多每小时清一次

// 面板绑的是 0.0.0.0(否则本机 127.0.0.1 也连不上),于是局域网里谁都能摸到它。
// 这里在应用层再收一道:只放行回环与指定网段,其余 403。逗号分隔,支持单个 IP 与 CIDR。
// 之所以不改成「只绑 192.0.2.5」:那样本机 http://127.0.0.1:49450 会一起断掉,
// 而且服务启动时 VPN 网卡未必已经就绪(listen 会 EADDRNOTAVAIL)。
const DEFAULT_ALLOW = '127.0.0.0/8,::1';
const ALLOW_SPEC = process.env.OCS_ALLOW == null ? DEFAULT_ALLOW : process.env.OCS_ALLOW;

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

/* ------------------------- 来源地址白名单 ------------------------- */

// "1.2.3.4" / "::1" / "::ffff:1.2.3.4" -> 字节数组(4 或 16 字节);非法返回 null。
function parseIPv4Bytes(s) {
  const parts = String(s).split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number.parseInt(parts[i], 10);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function ipToBytes(input) {
  const s = String(input == null ? '' : input).trim().replace(/%.*$/, ''); // 去掉 IPv6 zone id
  if (!s) return null;
  if (s.indexOf(':') < 0) return parseIPv4Bytes(s);
  if (/:{3,}/.test(s)) return null; // ":::" 之类:不宽松地当成 "::",否则一个错字会变成「全放行」

  // IPv6 末尾可能内嵌 IPv4(如 ::ffff:192.0.2.5);先换成两个占位 0 组,最后再回填。
  let tail4 = null;
  let v6 = s;
  const lastColon = s.lastIndexOf(':');
  if (s.indexOf('.', lastColon) > 0) {
    tail4 = parseIPv4Bytes(s.slice(lastColon + 1));
    if (!tail4) return null;
    v6 = s.slice(0, lastColon + 1) + '0:0';
  }

  const halves = v6.split('::');
  if (halves.length > 2) return null;
  const split = (p) => (p ? p.split(':').filter((x) => x !== '') : []);
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  const nums = [];
  for (const g of head.concat(tail)) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    nums.push(Number.parseInt(g, 16));
  }

  let full;
  if (halves.length === 1) {
    if (nums.length !== 8) return null;
    full = nums;
  } else {
    if (nums.length > 7) return null; // "::" 至少代表一个 0 组
    const headNums = head.map((g) => Number.parseInt(g, 16));
    const tailNums = tail.map((g) => Number.parseInt(g, 16));
    full = headNums.concat(new Array(8 - nums.length).fill(0), tailNums);
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (full[i] >> 8) & 0xff;
    out[i * 2 + 1] = full[i] & 0xff;
  }
  if (tail4) for (let i = 0; i < 4; i++) out[12 + i] = tail4[i];
  return out;
}

// ::ffff:a.b.c.d 是 IPv4 映射地址,还原成 4 字节才能和 192.0.2.0/24 这类规则比。
function unmapIPv4(bytes) {
  if (!bytes || bytes.length !== 16) return bytes;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return bytes;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return bytes;
  return bytes.slice(12, 16);
}

// "192.0.2.0/24" -> { bytes, bits };不写 /nn 时按整地址(全 32 或 128 位)算。
function parseAllowRule(text) {
  const raw = String(text).trim();
  if (!raw) return null;
  const slash = raw.lastIndexOf('/');
  const ipPart = slash >= 0 ? raw.slice(0, slash) : raw;
  const bitsPart = slash >= 0 ? raw.slice(slash + 1) : null;
  const bytes = ipToBytes(ipPart);
  if (!bytes) return null;
  const maxBits = bytes.length * 8;
  if (bitsPart == null) return { bytes, bits: maxBits };
  if (!/^\d{1,3}$/.test(bitsPart)) return null;
  const bits = Number.parseInt(bitsPart, 10);
  if (bits > maxBits) return null;
  return { bytes, bits };
}

const ALLOW_LIST = ALLOW_SPEC.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOW_RULES = ALLOW_LIST.map(parseAllowRule).filter(Boolean);
// 显式配了东西却一条都没解析出来 —— 属于配错。这时【一律拒绝】而不是放行,
// 免得一个错字把这道防线悄悄变成摆设;启动时会打警告说明。
const ALLOW_BROKEN = ALLOW_LIST.length > 0 && ALLOW_RULES.length === 0;

function matchAllowRule(bytes, rule) {
  if (bytes.length !== rule.bytes.length) return false;
  const wholeBytes = Math.floor(rule.bits / 8);
  const restBits = rule.bits % 8;
  for (let i = 0; i < wholeBytes; i++) if (bytes[i] !== rule.bytes[i]) return false;
  if (restBits) {
    const mask = (0xff << (8 - restBits)) & 0xff;
    if ((bytes[wholeBytes] & mask) !== (rule.bytes[wholeBytes] & mask)) return false;
  }
  return true;
}

// 空配置(OCS_ALLOW="")= 不限制;配错 = 一律拒绝;否则按规则放行。
function sourceAllowed(req) {
  if (!ALLOW_RULES.length) return ALLOW_LIST.length === 0;
  const bytes = unmapIPv4(ipToBytes(req && req.socket && req.socket.remoteAddress));
  if (!bytes) return false;
  return ALLOW_RULES.some((r) => matchAllowRule(bytes, r));
}

function allowStatusText() {
  if (ALLOW_BROKEN) return `配置无效,一律拒绝(检查 OCS_ALLOW=${ALLOW_SPEC})`;
  if (!ALLOW_RULES.length) return '不限制(OCS_ALLOW 为空)';
  return ALLOW_SPEC;
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

// 建上传目录 + 清理旧文件。清理是「顺手做」:失败只记日志,绝不影响健康检查与附件功能。
let lastPrune = 0;
function ensureUploadDir() {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  } catch (e) {
    console.warn('上传目录不可用:', UPLOAD_DIR, String((e && e.message) || e));
  }
}

function pruneUploads(force) {
  const now = Date.now();
  if (!force && now - lastPrune < UPLOAD_PRUNE_EVERY_MS) return;
  lastPrune = now;
  let names;
  try {
    names = fs.readdirSync(UPLOAD_DIR);
  } catch (_) {
    return;
  }
  let removed = 0;
  for (const name of names) {
    const file = path.join(UPLOAD_DIR, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || now - st.mtimeMs < UPLOAD_TTL_MS) continue;
      fs.unlinkSync(file);
      removed++;
    } catch (_) {}
  }
  if (removed) console.log(`  清理上传附件: ${removed} 个`);
}

async function health(res) {
  await ensureDiscovered(true);
  ensureUploadDir();
  pruneUploads(false);
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
    uploadDir: UPLOAD_DIR,
    detail,
  });
}

/* ------------------------------- 路由 ------------------------------- */

const server = http.createServer((req, res) => {
  // 来源白名单放在鉴权之前:不让局域网里的机器连密码都不用试就摸到面板。
  if (!sourceAllowed(req)) {
    // 被挡了却不说是谁、按什么规则挡的,下次再碰上只能靠猜 —— 把来源和白名单一起吐出来。
    const from = req.socket.remoteAddress || '(未知)';
    console.warn(`  拒绝来源地址: ${from}(白名单: ${allowStatusText()})`);
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('来源地址不允许 / source address not allowed\n' +
      `来源: ${from}\n白名单: ${allowStatusText()}`);
    return;
  }
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
    console.log(`  来源白名单: ${allowStatusText()}`);
    if (ALLOW_BROKEN) {
      console.warn(`  ⚠ OCS_ALLOW 无法解析(${ALLOW_SPEC}),已一律拒绝外部访问。`);
    }
    console.log(`  附件暂存: ${UPLOAD_DIR}`);
    console.log('');
  });
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

// 只有 `node server.js` 才起服务;被 require 时只导出纯函数,供 test/netallow-run.js 直接断言。
if (require.main === module) {
  (async () => {
    await ensureDiscovered(true);
    ensureUploadDir();
    pruneUploads(true);
    listen(PORT);
  })();
}

module.exports = {
  DEFAULT_ALLOW,
  ALLOW_SPEC,
  ALLOW_LIST,
  ALLOW_RULES,
  ALLOW_BROKEN,
  ipToBytes,
  unmapIPv4,
  parseAllowRule,
  matchAllowRule,
  sourceAllowed,
  allowStatusText,
};
