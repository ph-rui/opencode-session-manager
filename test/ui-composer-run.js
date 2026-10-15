'use strict';
/* 用本地 HTTP 服务 + 无头 Firefox 跑 test/ui-composer.html 里的浏览器内断言(P 组:底板收起/展开)。
 *
 * 用法: node test/ui-composer-run.js
 * 退出码: 0 全部通过;1 有失败;2 未能得到结果;3 超时。
 *
 * 与 ui-mobile-run.js 的分工:那边用固定尺寸 <iframe> 证明「真 390px 视口 → html.narrow」;
 * 这里不需要真视口 —— 底板收起与否的判定源就是 <html>.narrow 这一个类(设计文档 §3),
 * 所以这里把 matchMedia 换成一个只认 window.OCS_NARROW_MQ 的桩来翻面:
 *   桩命中   = 手机
 *   桩不命中 = 桌面
 * 于是两套布局的状态机都能在同一个进程里跑一遍。判定式本身仍是【从 index.html 抠出来的】
 * 那一段线上脚本(见下面 /narrow.js),不是手抄的副本。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PAGE = path.join(__dirname, 'ui-composer.html');
const TIMEOUT_MS = Number(process.env.UI_TIMEOUT_MS || 60000);

/* 从 public/index.html 里抠出那段判定脚本,原样喂给测试页。
 * 谁把 index.html 里的判定式改坏了,这里立刻红。 */
const NARROW_JS = (() => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const m = html.match(/window\.OCS_NARROW_MQ[\s\S]*?(?=<\/script>)/);
  return m ? m[0] : '';
})();

if (spawnSync('sh', ['-c', 'command -v firefox'], { stdio: 'ignore' }).status !== 0) {
  console.log('未找到 firefox,跳过浏览器断言。');
  process.exit(0);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && u.pathname === '/result') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(204);
      res.end();
      console.log(body);
      const lines = body.split('\n').filter(Boolean);
      const fails = lines.filter((l) => l.startsWith('FAIL') || l.startsWith('PAGE-ERROR'));
      console.log('\n结果: ' + (lines.length - fails.length) + ' 通过, ' + fails.length + ' 失败');
      finish(fails.length === 0 ? 0 : 1);
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
  const map = {
    '/test': [PAGE, 'text/html'],
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

let child = null;
let finished = false;
let profileDir = null;
function finish(code) {
  if (finished) return;
  finished = true;
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch (_) {}
  }
  server.close();
  setTimeout(() => {
    if (profileDir) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch (_) {}
    }
    process.exit(code);
  }, 100);
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/test';
  const profile = (profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-composer-ffp-')));
  console.log('服务 ' + url);
  child = spawn('firefox', ['--headless', '--no-remote', '--new-instance', '--profile', profile, url], {
    stdio: 'ignore',
  });
  child.on('exit', (code) => {
    setTimeout(() => {
      if (!finished) {
        console.log('firefox 退出(code=' + code + ')但未收到结果');
        finish(2);
      }
    }, 500);
  });
});

setTimeout(() => {
  if (!finished) {
    console.log('超时:未收到结果');
    finish(3);
  }
}, TIMEOUT_MS);
