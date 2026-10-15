'use strict';
/* 用本地 HTTP 服务 + 无头 Firefox 跑 test/ui-mobile.html 里的浏览器内断言(P 组:手机端窄屏)。
 *
 * 无头 Firefox 有两个坑,这里都绕开了:
 *   ① 它默认视口是 1366x768,而且 `--window-size` 对【非截图】会话无效(实测)。
 *      → 把测试页塞进一个固定尺寸的 <iframe>。媒体查询按 iframe 自己的视口算,
 *        所以拿到的是货真价实的 390px / 894px 布局,不是靠打桩凑出来的数字。
 *   ② 它默认是【细指针】,(pointer:coarse) 永远不命中。
 *      → 在 profile 里写 user.js 把 ui.primaryPointerCapabilities 设成 coarse(实测有效)。
 *
 * 因此判定式的【两半】都能被真实验证:
 *   390x844  → 靠 max-width:860px 那一半命中
 *   894x393  → 宽度 894 > 860,只能靠 max-height:560px and (pointer:coarse) 那一半
 *              这正是设计文档 §3 要防的「手机横屏掉回桌面三栏」。
 *
 * 用法: node test/ui-mobile-run.js
 *   环境变量 UI_CASES 覆盖视口列表(分号分隔,格式 宽,高)
 * 退出码: 0 全部通过;1 有失败;2 未能得到结果;3 超时。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PAGE = path.join(__dirname, 'ui-mobile.html');
const TIMEOUT_MS = Number(process.env.UI_TIMEOUT_MS || 60000);
const CASES = (process.env.UI_CASES || '390,844;894,393').split(';').map((s) => {
  const p = s.split(',');
  return { w: Number.parseInt(p[0], 10), h: Number.parseInt(p[1], 10) };
});

/* 从 public/index.html 里抠出那段窄屏判定脚本,原样喂给测试页。
 * 于是测试断言的是【线上真正跑的那两行】,而不是手抄的副本 ——
 * 谁把 index.html 里的判定式改坏了,A1/A3 立刻红。 */
const NARROW_JS = (() => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const m = html.match(/window\.OCS_NARROW_MQ[\s\S]*?(?=<\/script>)/);
  return m ? m[0] : '';
})();

// 让无头 Firefox 真的表现为触屏设备
const POINTER_USERJS = [
  'user_pref("ui.primaryPointerCapabilities", 1);',
  'user_pref("ui.allPointerCapabilities", 1);',
  '',
].join('\n');

// 外层只负责把内层摆在一个固定尺寸的视口里
const wrapperHTML = (w, h) =>
  '<!doctype html><html><head><meta charset="utf-8"><title>mobile harness ' +
  w + 'x' + h + '</title></head>\n' +
  '<body style="margin:0;background:#333">\n' +
  '<iframe src="/inner" style="width:' + w + 'px;height:' + h + 'px;border:0;display:block"></iframe>\n' +
  '</body></html>\n';

if (spawnSync('sh', ['-c', 'command -v firefox'], { stdio: 'ignore' }).status !== 0) {
  console.log('未找到 firefox,跳过浏览器断言。');
  process.exit(0);
}

let onResult = null; // 当前这一轮在等结果

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'POST' && u.pathname === '/result') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(204);
      res.end();
      const cb = onResult;
      onResult = null;
      if (cb) cb(body);
    });
    return;
  }

  if (u.pathname === '/narrow.js') {
    if (!NARROW_JS) {
      res.writeHead(500);
      res.end('index.html 里没找到 OCS_NARROW_MQ 那段脚本');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(NARROW_JS);
    return;
  }

  if (u.pathname === '/inner') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(PAGE).pipe(res);
    return;
  }

  if (u.pathname === '/test') {
    const w = Number.parseInt(u.searchParams.get('w') || '390', 10);
    const h = Number.parseInt(u.searchParams.get('h') || '844', 10);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(wrapperHTML(w, h));
    return;
  }

  const map = {
    '/app.js': [path.join(PUB, 'app.js'), 'text/javascript'],
    '/styles.css': [path.join(PUB, 'styles.css'), 'text/css'],
  };
  const hit = map[u.pathname];
  if (!hit) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': hit[1] + '; charset=utf-8' });
  fs.createReadStream(hit[0]).pipe(res);
});

const collected = [];
let child = null;
let finished = false;
let caseNo = 0; // 每进一轮自增;回调/定时器靠它判断自己是不是「上一轮」的遗留
let cleanupCurrent = () => {};

function finish(code) {
  if (finished) return;
  finished = true;
  cleanupCurrent();
  server.close();
  setTimeout(() => process.exit(code), 100);
}

function report() {
  const lines = collected
    .join('\n')
    .split('\n')
    .filter(Boolean);
  const heads = lines.filter((l) => l.startsWith('#'));
  const passes = lines.filter((l) => l.startsWith('PASS'));
  const fails = lines.filter((l) => l.startsWith('FAIL') || l.startsWith('PAGE-ERROR'));
  console.log('\n================ 汇总 ================');
  console.log(heads.join('\n'));
  console.log('结果: ' + passes.length + ' 通过, ' + fails.length + ' 失败');
  finish(fails.length === 0 ? 0 : 1);
}

function runCase(i) {
  if (finished) return;
  if (i >= CASES.length) return report();
  const c = CASES[i];
  const mine = ++caseNo;
  const isCurrent = () => !finished && mine === caseNo;
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/test?w=' + c.w + '&h=' + c.h;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mobile-ffp-'));
  fs.writeFileSync(path.join(profile, 'user.js'), POINTER_USERJS);
  console.log('\n--- 视口 ' + c.w + 'x' + c.h + ' ---');

  let proc = null;
  let timer = null;
  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (proc) {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      if (child === proc) child = null;
      proc = null;
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (_) {}
  };
  cleanupCurrent = cleanup;

  const giveUp = (why) => {
    onResult = null;
    cleanup();
    collected.push('PAGE-ERROR ' + why);
    runCase(i + 1);
  };

  onResult = (body) => {
    if (!isCurrent()) return;
    onResult = null;
    cleanup();
    collected.push(body);
    console.log(body);
    setTimeout(() => runCase(i + 1), 150);
  };

  proc = spawn('firefox', ['--headless', '--no-remote', '--new-instance', '--profile', profile, url], {
    stdio: 'ignore',
  });
  child = proc;
  proc.on('exit', () => {
    if (!isCurrent()) return;
    // 进程没了但结果还没到 —— 再宽限 800ms,免得最后一个 fetch 被抢跑
    setTimeout(() => {
      if (!isCurrent() || !onResult) return;
      giveUp('firefox 提前退出且未回报结果(' + c.w + 'x' + c.h + ')');
    }, 800);
  });

  timer = setTimeout(() => {
    if (!isCurrent() || !onResult) return;
    giveUp('视口 ' + c.w + 'x' + c.h + ' 超时未回报结果');
  }, TIMEOUT_MS);
}

server.listen(0, '127.0.0.1', () => {
  console.log('视口序列: ' + CASES.map((c) => c.w + 'x' + c.h).join(' , '));
  runCase(0);
});

setTimeout(() => {
  if (!finished) {
    console.log('超时:整体未完成');
    finish(3);
  }
}, TIMEOUT_MS * (CASES.length + 1));
