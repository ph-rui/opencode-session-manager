'use strict';
/* TUI diff 偏好共享(移动端设计 §8.60)的端到端断言。
 *
 * 真起一份代理(server.js) + 一个临时 OPENCODE_CONFIG_DIR,核对:
 *   ① /__config/diffs 在鉴权之后,未登录拿不到;
 *   ② GET 读 cli.json 的 diffs.view,GET /__health 也顺手带回同一个值;
 *   ③ PATCH 只改 diffs.view,其它键、键顺序、文件权限原样保留,且原子替换;
 *   ④ auto / split / unified 三档都收,非法值 / 多余字段 / 坏 JSON 都 400;
 *   ⑤ cli.json 缺失时 GET 返回 null、PATCH 能新建;坏文件拒绝写入、原字节不动。
 *
 * 不碰线上那唯一的 OpenCode 服务:`opencode service status` 用 PATH 里的假脚本顶掉,
 * service.json 也留空(这些断言只走本地配置端点)。整段毫秒级。
 *
 * 用法: node test/config-e2e-run.js
 * 退出码: 0 全部通过;1 有失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let pass = 0;
let fail = 0;
function ck(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log('PASS: ' + label);
  } else {
    fail++;
    console.log('FAIL: ' + label + ' — got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }
}
function ckTrue(label, v) { ck(label, !!v, true); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function request(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const body = opts.body == null ? null : Buffer.from(String(opts.body));
    const headers = Object.assign({}, opts.headers);
    if (body) headers['content-length'] = String(body.length);
    const r = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-config-e2e-'));
  const cfg = path.join(tmp, 'cfg');
  const bin = path.join(tmp, 'bin');
  const upload = path.join(tmp, 'uploads');
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  const fake = path.join(bin, 'opencode');
  fs.writeFileSync(fake, '#!/bin/sh\n# 假 opencode:这些断言只走本地配置端点,不需要真上游\nexit 1\n');
  fs.chmodSync(fake, 0o755);

  const cli = path.join(cfg, 'cli.json');
  const initial = {
    $schema: 'https://opencode.ai/v2/cli.json',
    theme: { name: 'opencode' },
    plugins: [],
    diffs: { wrap: 'word', view: 'split' },
    session: { sidebar: 'auto', thinking: 'hide' },
    animations: true,
  };
  fs.writeFileSync(cli, JSON.stringify(initial, null, 2) + '\n', { mode: 0o600 });

  const auth = 'tester:secret';
  const authHeader = 'Basic ' + Buffer.from(auth).toString('base64');
  const withAuth = { authorization: authHeader };
  const jsonAuth = { authorization: authHeader, 'content-type': 'application/json' };

  const port = await freePort();
  const proxy = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PATH: bin + ':' + (process.env.PATH || ''),
      OCS_PORT: String(port),
      OCS_HOST: '127.0.0.1',
      OCS_AUTH: auth,
      OCS_ALLOW: '127.0.0.1',
      OPENCODE_CONFIG_DIR: cfg,
      OCS_UPLOAD_DIR: upload,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proxy.stdout.on('data', (c) => { log += c; });
  proxy.stderr.on('data', (c) => { log += c; });

  const cleanup = () => {
    try { proxy.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  // 等代理起来(鉴权开着,所以带凭据探)
  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request(port, 'GET', '/__config/diffs', { headers: withAuth });
      if (r.status === 200) { up = true; break; }
    } catch (_) {}
    await sleep(100);
  }
  if (!up) {
    console.log('代理没有起来。日志:\n' + log);
    cleanup();
    process.exit(1);
  }

  try {
    /* ① 鉴权在配置端点之前 */
    let r = await request(port, 'GET', '/__config/diffs');
    ck('/__config/diffs:未登录是 401', r.status, 401);
    ckTrue('/__config/diffs:401 带 Basic 挑战', /^Basic /i.test(r.headers['www-authenticate'] || ''));

    /* ② GET 读 cli.json */
    r = await request(port, 'GET', '/__config/diffs', { headers: withAuth });
    ck('/__config/diffs:读出现有 view', r.status, 200);
    ck('/__config/diffs:view=split', r.json && r.json.view, 'split');
    ckTrue('/__config/diffs:mtime 是数字', typeof (r.json && r.json.mtime) === 'number' && r.json.mtime > 0);
    ck('/__config/diffs:不缓存', r.headers['cache-control'], 'no-store');

    /* 健康检查顺手带回同一个值(面板 15s 轮询靠它同步 TUI → 面板) */
    r = await request(port, 'GET', '/__health', { headers: withAuth });
    ck('/__health:带上 diffView', r.status, 200);
    ck('/__health:diffView=split', r.json && r.json.diffView, 'split');
    ckTrue('/__health:diffMtime 是数字', typeof (r.json && r.json.diffMtime) === 'number' && r.json.diffMtime > 0);
    ck('/__health:不缓存', r.headers['cache-control'], 'no-store');

    /* ③ PATCH 只改 view,其它键原样保留 */
    r = await request(port, 'PATCH', '/__config/diffs', {
      headers: jsonAuth, body: JSON.stringify({ view: 'unified' }),
    });
    ck('/__config/diffs:PATCH unified 是 200', r.status, 200);
    ck('/__config/diffs:PATCH 回新值', r.json && r.json.view, 'unified');
    const afterPatch = readJson(cli);
    ck('写回:view 变成 unified', afterPatch && afterPatch.diffs && afterPatch.diffs.view, 'unified');
    ck('写回:wrap 没被动', afterPatch && afterPatch.diffs && afterPatch.diffs.wrap, 'word');
    ck('写回:$schema 没被动', afterPatch && afterPatch.$schema, initial.$schema);
    ck('写回:theme / plugins / session / animations 都在', {
      theme: afterPatch && afterPatch.theme,
      plugins: afterPatch && afterPatch.plugins,
      session: afterPatch && afterPatch.session,
      animations: afterPatch && afterPatch.animations,
    }, { theme: initial.theme, plugins: initial.plugins, session: initial.session, animations: initial.animations });
    ck('写回:文件权限仍是 0600', fs.statSync(cli).mode & 0o777, 0o600);
    ck('写回:末尾有换行', fs.readFileSync(cli, 'utf8').slice(-1), '\n');

    r = await request(port, 'GET', '/__config/diffs', { headers: withAuth });
    ck('/__config/diffs:再读是 unified', r.json && r.json.view, 'unified');

    /* auto 也收 */
    r = await request(port, 'PATCH', '/__config/diffs', {
      headers: jsonAuth, body: JSON.stringify({ view: 'auto' }),
    });
    ck('PATCH auto 是 200', r.status, 200);
    ck('PATCH auto 落盘', readJson(cli).diffs.view, 'auto');

    /* ④ 非法输入 */
    r = await request(port, 'PATCH', '/__config/diffs', {
      headers: jsonAuth, body: JSON.stringify({ view: 'sideways' }),
    });
    ck('非法 view 是 400', r.status, 400);
    ck('非法 view 没写坏文件', readJson(cli).diffs.view, 'auto');

    r = await request(port, 'PATCH', '/__config/diffs', {
      headers: jsonAuth, body: JSON.stringify({ view: 'split', extra: 1 }),
    });
    ck('多余字段是 400', r.status, 400);
    ck('多余字段没写坏文件', readJson(cli).diffs.view, 'auto');

    r = await request(port, 'PATCH', '/__config/diffs', {
      headers: jsonAuth, body: '{oops',
    });
    ck('坏 JSON 是 400', r.status, 400);
    ck('坏 JSON 没写坏文件', readJson(cli).diffs.view, 'auto');

    r = await request(port, 'POST', '/__config/diffs', { headers: withAuth });
    ck('POST 是 405', r.status, 405);
    ck('405 带 Allow', r.headers.allow, 'GET, PATCH');

    /* ⑤ 文件缺失 / 坏文件 */
    fs.unlinkSync(cli);
    r = await request(port, 'GET', '/__config/diffs', { headers: withAuth });
    ck('cli.json 缺失:GET 还是 200', r.status, 200);
    ck('cli.json 缺失:view 是 null', r.json && r.json.view, null);

    r = await request(port, 'PATCH', '/__config/diffs', {
      headers: jsonAuth, body: JSON.stringify({ view: 'split' }),
    });
    ck('cli.json 缺失:PATCH 能新建', r.status, 200);
    ck('新建文件里是 split', readJson(cli).diffs.view, 'split');
    ck('新建文件权限是 0600', fs.statSync(cli).mode & 0o777, 0o600);

    fs.writeFileSync(cli, '{ not json\n', { mode: 0o600 });
    const brokenRaw = fs.readFileSync(cli, 'utf8');
    r = await request(port, 'GET', '/__config/diffs', { headers: withAuth });
    ck('坏 cli.json:GET 是 500', r.status, 500);
    ckTrue('坏 cli.json:带原因', !!(r.json && r.json.error));
    r = await request(port, 'PATCH', '/__config/diffs', {
      headers: jsonAuth, body: JSON.stringify({ view: 'unified' }),
    });
    ck('坏 cli.json:PATCH 是 500', r.status, 500);
    ck('坏 cli.json:原字节不动', fs.readFileSync(cli, 'utf8'), brokenRaw);

    fs.writeFileSync(cli, '{"diffs":"not-an-object"}\n', { mode: 0o600 });
    const badShape = fs.readFileSync(cli, 'utf8');
    r = await request(port, 'PATCH', '/__config/diffs', {
      headers: jsonAuth, body: JSON.stringify({ view: 'split' }),
    });
    ck('diffs 不是对象:PATCH 是 500', r.status, 500);
    ck('diffs 不是对象:原字节不动', fs.readFileSync(cli, 'utf8'), badShape);
  } finally {
    cleanup();
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('PAGE-ERROR', e && e.stack || e);
  process.exit(1);
});
