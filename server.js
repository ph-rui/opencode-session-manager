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
 *   8. 提供 /__config/diffs 读写 TUI 的 cli.json diffs.view(§8.60,与 TUI 共用偏好)
 *
 * 仅使用 Node 标准库,零依赖。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable, Transform } = require('stream');
const { StringDecoder } = require('string_decoder');

const PKG_VERSION = require('./package.json').version;
const HOST = process.env.OCS_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.OCS_PORT || '49450', 10);
const PANEL_AUTH = process.env.OCS_AUTH || ''; // 形如 "user:pass";设置后需 HTTP Basic 登录
const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
const SERVICE_FILE = path.join(CONFIG_DIR, 'service.json');
const CLI_CONFIG_FILE = path.join(CONFIG_DIR, 'cli.json');
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
// 之所以不改成「只绑某个局域网地址」:那样本机 http://127.0.0.1:49450 会一起断掉,
// 而且服务启动时网卡未必已经就绪(listen 会 EADDRNOTAVAIL)。默认只放行回环,
// 局域网 / VPN 地址必须由部署处通过 OCS_ALLOW 显式列出。
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

/* --------------------- TUI diff 偏好(cli.json,§8.60) ---------------------
 * TUI 把 diff 展示偏好记在 ~/.config/opencode/cli.json 的 diffs.view;面板要和
 * TUI 共用同一本账,所以只读写这一个字段。其它键、键顺序、文件权限都保留。
 * 写文件用同目录临时文件 + rename:TUI 的 watcher 永远读不到半截 JSON。
 */
const DIFF_VIEWS = new Set(['auto', 'split', 'unified']);
const CONFIG_BODY_MAX = 64 * 1024;

function readCliConfig() {
  try {
    const stat = fs.statSync(CLI_CONFIG_FILE);
    const raw = fs.readFileSync(CLI_CONFIG_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: 'cli.json 顶层不是对象' };
    }
    return { ok: true, obj, mode: stat.mode & 0o777, mtime: stat.mtimeMs };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, missing: true, obj: null, mtime: 0 };
    return { ok: false, error: '读不了 cli.json:' + String((e && e.message) || e) };
  }
}

function readDiffView() {
  const r = readCliConfig();
  if (!r.ok) return { view: null, mtime: 0, error: r.error };
  const d = r.obj && r.obj.diffs;
  if (d != null && (typeof d !== 'object' || Array.isArray(d))) {
    return { view: null, mtime: r.mtime || 0, error: 'cli.json 的 diffs 不是对象' };
  }
  const v = d ? d.view : undefined;
  if (v != null && !DIFF_VIEWS.has(v)) {
    return { view: null, mtime: r.mtime || 0, error: 'cli.json 的 diffs.view 不是 auto / split / unified' };
  }
  return { view: v || null, mtime: r.mtime || 0 };
}

function writeDiffView(view) {
  if (!DIFF_VIEWS.has(view)) return { ok: false, status: 400, error: 'view 只能是 auto / split / unified' };
  const cur = readCliConfig();
  if (!cur.ok) return { ok: false, status: 500, error: cur.error };
  const obj = cur.missing ? {} : cur.obj;
  if (obj.diffs == null) obj.diffs = {};
  else if (typeof obj.diffs !== 'object' || Array.isArray(obj.diffs)) {
    return { ok: false, status: 500, error: 'cli.json 的 diffs 不是对象,未写入' };
  }
  obj.diffs.view = view;
  const text = JSON.stringify(obj, null, 2) + '\n';
  const mode = cur.missing ? 0o600 : (cur.mode || 0o600);
  const dir = path.dirname(CLI_CONFIG_FILE);
  const tmp = path.join(dir, '.cli.json.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, CLI_CONFIG_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, status: 500, error: '写 cli.json 失败:' + String((e && e.message) || e) };
  }
  let mtime = 0;
  try { mtime = fs.statSync(CLI_CONFIG_FILE).mtimeMs; } catch (_) {}
  return { ok: true, view, mtime };
}

async function configDiffs(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'GET') {
    const r = readDiffView();
    if (r.error) return sendJson(res, 500, { view: null, mtime: 0, error: r.error });
    return sendJson(res, 200, { view: r.view, mtime: r.mtime });
  }
  if (req.method !== 'PATCH') {
    res.setHeader('allow', 'GET, PATCH');
    return sendJson(res, 405, { error: '只支持 GET / PATCH' });
  }
  let buf;
  try {
    buf = await readRequestBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: '没读完请求体:' + String((e && e.message) || e) });
  }
  if (buf.length > CONFIG_BODY_MAX) return sendJson(res, 413, { error: '请求体太大' });
  let body;
  try {
    body = JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return sendJson(res, 400, { error: '请求体不是合法 JSON' });
  }
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  if (keys.length !== 1 || keys[0] !== 'view' || !DIFF_VIEWS.has(body.view)) {
    return sendJson(res, 400, { error: '只收 {"view":"auto|split|unified"}' });
  }
  const w = writeDiffView(body.view);
  if (!w.ok) return sendJson(res, w.status || 500, { error: w.error });
  return sendJson(res, 200, { view: w.view, mtime: w.mtime });
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

/* --------------------------- 挤掉白传的大块字节 ---------------------------
 * 「会话消息列表」里塞着面板【一个字都不显示】的字节:MCP 工具返回的图,藏在
 * state.content[].uri 的 data: URL 里(base64)。实测那条 PPT 会话
 * (ses_demo_long_c):
 *     手机一页 30 条   2.12 MB 里 1.89 MB 是这个(89%,3 张图,平均一张 630 KB)
 *     桌面一页 100 条 12.90 MB 里 11.87 MB 是这个(92%)
 * 而 public/app.js 的 toolOutputHtml() 只取 content[].text(连文件名都不显示),
 * 也就是说这些字节传到手机上纯属白等 —— 手机上就是「十几秒」和「一秒」的差别。
 *
 * 这里在代理层摘掉:
 *   - 只动 data: 开头的 uri(真的是字节);file:// 之类原样留着;
 *   - 留 name / mime,另记一个字节数(omitted)—— 将来要做「点开看图」还知道有多大;
 *   - 只摘 /api/session/<id>/message 这一条 200 JSON;
 *   - SSE(/api/event)不碰:那是流式的,摘不了。
 * 代价是这一次响应要整体过一遍 JSON.parse/stringify(几 MB ≈ 几十毫秒),
 * 换来 9~13 倍的流量。任何一步出错都原样退回字节 —— 代理不许因为顺手省流量把面板弄坏。 */

const MESSAGE_LIST_RE = /^\/api\/session\/[^/?]+\/message(\?|$)/;

/* §8.54 慢网(VPN)下的传输:静态资源与大块 JSON 一律按客户端能力压一遍。
 * 之前只发了 ETag/no-cache,body 是原样明文 —— 面板首页 363KB、一条 100 条的消息
 * 列表 1MB,走 VPN 时「正在加载」就挂在那儿。brotli q5 实测能到 20~30%,
 * gzip 是兜底;SSE 绝不能压(text/event-stream 不进这条路径)。 */
const BROTLI_OPTS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } };

function acceptedEncoding(req) {
  const ae = String((req.headers && req.headers['accept-encoding']) || '').toLowerCase();
  if (/(^|[,\s])br(\s*;|,|$)/.test(ae)) return 'br';
  if (/(^|[,\s])gzip(\s*;|,|$)/.test(ae)) return 'gzip';
  return '';
}

function encodeBody(buf, enc) {
  if (enc === 'br') return zlib.brotliCompressSync(buf, BROTLI_OPTS);
  if (enc === 'gzip') return zlib.gzipSync(buf, { level: 6 });
  return buf;
}

/* 静态文件的压缩结果按「文件 + ETag + 编码」缓存:app.js 286KB 压一次约 10ms,
 * 没必要每个请求都压。上限很小 —— 面板只有三四个静态文件。 */
const staticEncoded = new Map();
function encodeStatic(file, etag, data, enc) {
  const key = file + '|' + etag + '|' + enc;
  const hit = staticEncoded.get(key);
  if (hit) return hit;
  const out = encodeBody(data, enc);
  if (staticEncoded.size >= 24) staticEncoded.clear();
  staticEncoded.set(key, out);
  return out;
}

function isMessageListUrl(url, method, status, contentType) {
  return (
    method === 'GET' && status === 200 && MESSAGE_LIST_RE.test(url || '') && /json/i.test(contentType || '')
  );
}

/* 就地摘掉消息里 data: 图的大块正文,返回摘掉几处(0 = 没动,调用方原样发)。 */
function stripToolUris(json) {
  const list = json && Array.isArray(json.data) ? json.data : null;
  if (!list) return 0;
  let n = 0;
  for (const msg of list) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const items = part && part.state && Array.isArray(part.state.content) ? part.state.content : null;
      if (!items) continue;
      for (const it of items) {
        if (!it || typeof it.uri !== 'string' || !it.uri.startsWith('data:')) continue;
        it.omitted = it.uri.length;
        it.uri = '';
        n++;
      }
    }
  }
  return n;
}

/* ----------------------- SSE 里同一批 data: 图也摘掉(§8.47) -----------------------
 * 「消息列表」那条(§8.37)已经摘了,但同一批字节还会从 SSE 走一遍:public/app.js 在
 * session.tool.success 上写着 `p.state.content = d.content` —— 某次工具真返回图,
 * 那【一个】事件就是 600KB 级,而面板一个字都不显示它(只取 content[].text)。
 * 这里在代理层按【行】改写这条流:
 *   - 只认 `data:` 开头的行,只认 type === 'session.tool.success'(唯一带 content 的);
 *   - 其余(event: / 注释 / 心跳 / 别的 session.* / 解析失败)一律原样字节;
 *   - 跨 chunk 的行缓冲(用 StringDecoder,别把多字节汉字切坏);
 *   - 单行超 8MB 还没换行就原样放出去(自保,不无限攒内存)。
 * 任何一步出错都退回原字节 —— SSE 改坏了整条面板就瞎了,省流量不值这个价。 */
const SSE_MAX_LINE = 8 * 1024 * 1024;

/* 就地摘掉一个 SSE 事件里的 data: 图,返回摘掉几处(0 = 没动)。纯函数。 */
function stripSseData(json) {
  if (!json || json.type !== 'session.tool.success') return 0;
  const d = json.data;
  const items = d && Array.isArray(d.content) ? d.content : null;
  if (!items) return 0;
  let n = 0;
  for (const it of items) {
    if (!it || typeof it.uri !== 'string' || !it.uri.startsWith('data:')) continue;
    it.omitted = it.uri.length;
    it.uri = '';
    n++;
  }
  return n;
}

/* 一行 SSE → 可能被改写的一行(其余原样)。纯函数,给测试直接喂。 */
function stripSseLine(line) {
  if (typeof line !== 'string' || line.slice(0, 5) !== 'data:') return line;
  let json;
  try {
    json = JSON.parse(line.slice(5));
  } catch (_) {
    return line; // 不是 JSON(或者只是半截):原样发
  }
  if (!stripSseData(json)) return line;
  return 'data: ' + JSON.stringify(json);
}

/* 把上游 SSE 流接成「按行改写」的 Transform。结构与帧边界一个字节不动,只换 data: 行。 */
function createSseStripper() {
  const dec = new StringDecoder('utf8');
  let buf = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += dec.write(chunk);
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        this.push(stripSseLine(buf.slice(0, i)) + '\n');
        buf = buf.slice(i + 1);
      }
      if (buf.length > SSE_MAX_LINE) {
        this.push(buf); // 一条行长得离谱:原样放出去,别把内存攒爆
        buf = '';
      }
      cb();
    },
    flush(cb) {
      buf += dec.end();
      if (buf) this.push(stripSseLine(buf));
      cb();
    },
  });
}

/* 这一条响应是不是 SSE。按内容类型认(不按 URL 白名单:OpenCode 换路径也不用改代理)。 */
function isEventStream(method, contentType) {
  return method === 'GET' && /event-stream/i.test(contentType || '');
}

/* 把上游的响应体整个读成一个 Buffer(读断了返回 null,由调用方收尾)。 */async function readAll(webBody) {
  const chunks = [];
  try {
    for await (const c of Readable.fromWeb(webBody)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  } catch (_) {
    return null;
  }
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
    // expect 必须吞掉:客户端(如 curl 对 >1KB 的 POST)会带 100-continue,转发给上游后
    // 两边都等对方的 100 → 请求永远不返回(本代理已经把体读完、自带 content-length,不需要它)。
    if (['host', 'connection', 'content-length', 'accept-encoding', 'authorization', 'expect'].includes(lk)) {
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

  // API 一律不缓存:会话/消息/状态是活的,别让浏览器(或中间的 http 缓存)拿旧的糊弄。
  outHeaders['cache-control'] = 'no-store';

  /* §8.54 GET 的 JSON 响应统一缓冲后压缩:消息列表还要先摘掉面板不显示的 data: 图
   * (见 stripToolUris)。SSE(text/event-stream)与其它流式响应照旧透传,不碰。 */
  const isJson = /json/i.test(outHeaders['content-type'] || '');
  if (req.method === 'GET' && upstream.status === 200 && isJson) {
    const raw = await readAll(upstream.body);
    if (raw == null) {
      try {
        res.end(); // 读到一半断了(多半是客户端已经走了),体已消费,收工
      } catch (_) {}
      return;
    }
    let out = raw;
    if (isMessageListUrl(req.url, req.method, upstream.status, outHeaders['content-type'])) {
      try {
        const json = JSON.parse(raw.toString('utf8'));
        if (stripToolUris(json)) out = Buffer.from(JSON.stringify(json));
      } catch (_) {
        out = raw; // 不是 JSON / 结构不认识:原样发
      }
    }
    const enc = acceptedEncoding(req);
    if (enc && out.length >= 1024) {
      out = encodeBody(out, enc);
      outHeaders['content-encoding'] = enc;
      // 上游有时已经带了 Vary(Accept-Encoding),别重复追加
      const vary = String(outHeaders['vary'] || '');
      if (!/accept-encoding/i.test(vary)) {
        outHeaders['vary'] = vary ? vary + ', accept-encoding' : 'accept-encoding';
      }
    }
    outHeaders['content-length'] = String(out.length);
    res.writeHead(upstream.status, outHeaders);
    res.end(out);
    return;
  }

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
  if (isEventStream(req.method, outHeaders['content-type'])) {
    // §8.47:SSE 里 session.tool.success 背着的 data: 图按行摘掉,其余帧一个字节不动
    const stripper = createSseStripper();
    stripper.on('error', () => {
      try {
        res.end();
      } catch (_) {}
    });
    res.on('close', () => {
      try {
        stripper.destroy();
      } catch (_) {}
    });
    nodeStream.pipe(stripper).pipe(res);
    return;
  }
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
  // 这里【必须】发校验头。index.html / app.js / styles.css 是三份要配套的文件,
  // 浏览器手里若留着旧的一份,就会出现「新 HTML + 旧 CSS」这种半新半旧的页面 ——
  // 实测过一次:旧 styles.css 里 #progress 还是「贴下沿的 2px 条」(position:absolute
  // + overflow:hidden),配上新 markup 正好把整条状态条裁没了,看起来像功能丢了。
  // 没有 Cache-Control / ETag / Last-Modified 时,浏览器只能靠启发式乱猜,猜错就是这个下场。
  // no-cache = 仍然缓存,但每次用之前必须来问一声;内容没变就回 304,不算重下。
  fs.stat(file, (serr, st) => {
    if (serr || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const lastMod = st.mtime.toUTCString();
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {
        etag, 'cache-control': 'no-cache', 'last-modified': lastMod, vary: 'accept-encoding',
      });
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const enc = acceptedEncoding(req);
      const headers = {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        etag,
        'last-modified': lastMod,
        'cache-control': 'no-cache',
        // 同一份文件按编码各存一份:中间缓存/浏览器协商时才不会把 br 的 body 给 gzip 的客户端
        vary: 'accept-encoding',
      };
      const body = enc ? encodeStatic(file, etag, data, enc) : data;
      if (enc) headers['content-encoding'] = enc;
      headers['content-length'] = String(body.length);
      res.writeHead(200, headers);
      res.end(body);
    });
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
  // §8.60:这里带着 TUI 的 diffs.view,必须是实时值;别让浏览器/代理把它缓存住。
  res.setHeader('cache-control', 'no-store');
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
  const dv = readDiffView();
  sendJson(res, 200, {
    ok,
    base: state.base,
    version: PKG_VERSION,
    hasPassword: !!state.password,
    configDir: CONFIG_DIR,
    uploadDir: UPLOAD_DIR,
    home: os.homedir(), // 提示栏把工程路径缩成 ~/...(照 TUI 的 cm(path, home))
    // §8.60:健康检查本来就每 15s 一次,顺手把 TUI 的 diffs.view 带回来,
    // 面板不必为「TUI 那边改了偏好」再单开一条轮询/SSE。
    diffView: dv.view,
    diffMtime: dv.mtime,
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
  if (url === '/__config/diffs') {
    configDiffs(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(e) });
    });
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
  // 消息列表里摘图(§8.37):纯函数,给 test/strip-run.js 直接断言
  MESSAGE_LIST_RE,
  isMessageListUrl,
  stripToolUris,
  // SSE 里也摘(§8.47):纯函数 + 按行改写的 Transform,给 test/sse-strip-run.js 直接断言
  stripSseData,
  stripSseLine,
  createSseStripper,
  isEventStream,
};
