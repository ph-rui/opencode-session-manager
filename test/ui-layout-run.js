'use strict';
/* 用本地 HTTP 服务 + 无头 Firefox 跑 test/ui-layout.html 里的浏览器内断言
 * (会话列表折叠 + 刷新后恢复选中的会话),并把结果打印出来。
 *
 * 用法: node test/ui-layout-run.js
 * 退出码: 0 全部通过;1 有失败;2 未能得到结果;3 超时。
 * 若无 firefox 或不在 Linux,请改用 test/ui-stream-run.js / smoke.sh 覆盖服务端一半。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const PAGE = path.join(__dirname, 'ui-layout.html');
const TIMEOUT_MS = Number(process.env.UI_TIMEOUT_MS || 60000);

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
  const profile = (profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-layout-ffp-')));
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
