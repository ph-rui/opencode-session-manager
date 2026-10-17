'use strict';
/* SSE 摘图的端到端断言(移动端设计 §8.47)。
 *
 * 真的起一份代理(server.js) + 一个假上游:让 session.tool.success 背着 600KB 的
 * data: 图从 SSE 里走一遍,核对:
 *   ① 那一帧里的图被摘掉(uri 空、omitted 是原长度),text / name / mime 原样;
 *   ② 别的帧(server.connected / 心跳注释 / 不相关的 session.* / 坏 JSON)一个字节不变;
 *   ③ 流是活的 —— 早发的帧在后面的帧之前就到了(不是攒到流结束才吐);
 *   ④ 帧边界(空行)一个不少,整段里不再出现 base64。
 *
 * 不碰线上唯一的 OpenCode 服务:上游是本地假货,`opencode service status` 用 PATH 里的
 * 假脚本顶掉,service.json 用 OPENCODE_CONFIG_DIR 指到临时目录。整段毫秒级。
 *
 * 用法: node test/sse-e2e-run.js
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
function ckTrue(label, v) {
  ck(label, !!v, true);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 造一个真形状的 session.tool.success:content[] 里既有 text 也有 600KB 的 data: 图 */
const IMG = 'data:image/png;base64,' + 'A'.repeat(600000);
function toolEvent() {
  return {
    id: 'evt_tool',
    type: 'session.tool.success',
    data: {
      sessionID: 'ses_e2e',
      assistantMessageID: 'msg_1',
      id: 'tool_1',
      content: [
        { type: 'text', text: 'Image read successfully' },
        { type: 'file', uri: IMG, mime: 'image/png', name: '/tmp/shot.png' },
      ],
      metadata: { title: 'read' },
    },
  };
}
/* 一个「与摘图无关」的 session 事件,但身上也挂着 data: —— 它不许被碰 */
const OTHER = {
  id: 'evt_other',
  type: 'session.message.updated',
  data: { sessionID: 'ses_e2e', content: [{ type: 'file', uri: 'data:text/plain;base64,' + 'B'.repeat(40) }] },
};

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

function get(port, p, onChunk) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      const arrived = [];
      res.on('data', (c) => {
        body += c;
        arrived.push({ at: Date.now(), len: c.length });
        if (onChunk) onChunk(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, arrived }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('代理 20s 没结束')));
  });
}

(async () => {
  console.log('=== SSE 摘图(端到端:真代理 + 假上游) ===\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-sse-e2e-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const cfg = path.join(tmp, 'cfg');
  fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, 'service.json'), JSON.stringify({ password: 'e2e-pass' }));

  /* 上游:发一串帧,帧之间留缝(为了证明「早到的先到」) */
  let upstreamPort = 0;
  const upstream = http.createServer((req, res) => {
    if (!/^\/api\/event/.test(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"nope"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: {"id":"evt_hello","type":"server.connected","data":{}}\n\n');
    setTimeout(() => res.write(': heartbeat\n\n'), 120);
    setTimeout(() => res.write('data: ' + JSON.stringify(OTHER) + '\n\n'), 240);
    setTimeout(() => res.write('data: {"type":"session.tool.success","data"\n\n'), 300); // 半截 JSON:原样
    setTimeout(() => res.write('data: ' + JSON.stringify(toolEvent()) + '\n\n'), 420);
    setTimeout(() => {
      res.write('data: {"id":"evt_bye","type":"server.connected","data":{}}\n\n');
      res.end();
    }, 560);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;

  /* 假 opencode:只回答 `service status`,把上游地址说出来 */
  const fake = path.join(bin, 'opencode');
  fs.writeFileSync(
    fake,
    '#!/bin/sh\n' +
      '# 测试用:让代理以为 OpenCode 在 ' + upstreamPort + '\n' +
      'echo "opencode server: http://127.0.0.1:' + upstreamPort + '  (pid 1)"\n'
  );
  fs.chmodSync(fake, 0o755);

  const proxyPort = await freePort();
  const proxy = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      PATH: bin + ':' + (process.env.PATH || ''),
      OCS_PORT: String(proxyPort),
      OCS_HOST: '127.0.0.1',
      OCS_AUTH: '',
      OCS_ALLOW: '127.0.0.1',
      OPENCODE_CONFIG_DIR: cfg,
      OCS_UPLOAD_DIR: path.join(tmp, 'uploads'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let proxyLog = '';
  proxy.stdout.on('data', (c) => { proxyLog += c; });
  proxy.stderr.on('data', (c) => { proxyLog += c; });

  const cleanup = () => {
    try { proxy.kill('SIGKILL'); } catch (_) {}
    try { upstream.close(); } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  try {
    // 等代理起来
    for (let i = 0; i < 100; i++) {
      const up = await new Promise((r) => {
        const s = http.get({ host: '127.0.0.1', port: proxyPort, path: '/__health' }, (res) => {
          res.resume();
          r(true);
        });
        s.on('error', () => r(false));
        s.setTimeout(1000, () => { s.destroy(); r(false); });
      });
      if (up) break;
      await sleep(100);
    }

    const t0 = Date.now();
    const r = await get(proxyPort, '/api/event');
    const took = Date.now() - t0;

    ck('代理把上游的状态码与 SSE 类型原样送回来', [r.status, /event-stream/.test(r.headers['content-type'] || '')], [200, true]);
    ckTrue('整段里不再有那张 600KB 的图(它确实没出网)', r.body.indexOf('A'.repeat(1000)) < 0);
    ckTrue('整段掉到 5KB 以下(不摘的话光那一帧就 600KB)', r.body.length < 5000, r.body.length);
    ckTrue('整段里还有 server.connected(别的帧没被吞)', r.body.indexOf('"type":"server.connected"') > 0);
    ckTrue('心跳注释原样', r.body.indexOf(': heartbeat') > 0);
    ck('帧边界(空行)一个不少', (r.body.match(/\n\n/g) || []).length, 6);

    /* 那一帧:摘干净了、其余字段原样 */
    const lines = r.body.split('\n').filter((l) => l.indexOf('data: ') === 0);
    const toolLine = lines.filter((l) => l.indexOf('"evt_tool"') > 0)[0] || '';
    const tool = JSON.parse(toolLine.slice(6));
    ck('tool.success 那一帧的图没了(uri 空)', tool.data.content[1].uri, '');
    ck('记下原字节数(omitted)', tool.data.content[1].omitted, IMG.length);
    ck('name / mime / text 原样', [tool.data.content[1].name, tool.data.content[1].mime, tool.data.content[0].text],
      ['/tmp/shot.png', 'image/png', 'Image read successfully']);
    ck('事件自己的字段原样', [tool.id, tool.data.id, tool.data.metadata.title], ['evt_tool', 'tool_1', 'read']);
    ckTrue('那一帧只剩不到 2KB', toolLine.length < 2000);

    /* 与摘图无关的那个 session.* —— 身上也挂着 data:,必须一字不改 */
    const otherLine = lines.filter((l) => l.indexOf('"evt_other"') > 0)[0] || '';
    ck('不相关的 session.* 事件里那条 data: 原样留着', otherLine, 'data: ' + JSON.stringify(OTHER));
    /* 半截 JSON 帧:原样(不许猜) */
    ckTrue('半截 JSON 帧原样放行', r.body.indexOf('data: {"type":"session.tool.success","data"') > 0);

    /* 流是活的:第一帧明显早于结尾 */
    ckTrue('第一帧先到、结尾后到(不是攒完才吐)',
      r.arrived.length >= 3 && r.arrived[0].at - t0 < 400, r.arrived.length + ' 块 / ' + took + 'ms');
    ckTrue('总共 560ms 左右就把流收干净了', took < 5000, took + 'ms');

    /* 同一时间线再走一遍普通接口,确认代理没被这次改写带坏 */
    const health = await get(proxyPort, '/__health');
    ck('静态/健康那条路照旧(200)', health.status, 200);
  } finally {
    cleanup();
  }

  if (fail) console.log('\n代理日志:\n' + proxyLog);
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL: 测试自身抛错 — ' + (e && e.stack));
  process.exit(1);
});
