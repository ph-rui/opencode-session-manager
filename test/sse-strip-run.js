'use strict';
/* server.js「SSE 里也摘 data: 图」的单元断言(移动端设计 §8.47)。
 *
 * 纯逻辑,不需要无头浏览器,也不需要 OpenCode 服务在跑。
 * 三件事:① 只动 type === 'session.tool.success' 的 data: 行;
 *        ② 别的行(event: / 注释 / 心跳 / 别的 session.* / 坏 JSON)一个字节都不动;
 *        ③ 跨 chunk 的行缓冲不许把 JSON 或汉字切坏,帧边界与换行照旧。
 *
 * 用法: node test/sse-strip-run.js
 * 退出码: 0 全部通过;1 有失败。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'server.js'));

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

/* 造一个真形状的 session.tool.success:data.content[] 里既有 text 也有带 base64 的 file。 */
const IMG = 'data:image/png;base64,' + 'A'.repeat(600000);
/* small=true 给「按 1 字节切」那几条用:600KB 逐字节喂会把测试拖到几分钟(纯属喂得慢) */
function toolEvent(small) {
  const img = small ? 'data:image/png;base64,' + 'A'.repeat(200) : IMG;
  return {
    id: 'evt_1',
    type: 'session.tool.success',
    data: {
      sessionID: 'ses_a',
      assistantMessageID: 'msg_1',
      id: 'tool_1',
      content: [
        { type: 'text', text: 'Image read successfully' },
        { type: 'file', uri: img, mime: 'image/png', name: '/tmp/ocsm-probe/chkpage-1.png' },
      ],
      metadata: { title: 'read' },
    },
  };
}

/* 一帧:event 行(真服务端不发,但 SSE 允许)+ data 行 + 空行 */
function frame(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

/* 把整段喂给 stripper,按给定切法分 chunk,收回全部输出。 */
function through(chunks) {
  return new Promise((resolve, reject) => {
    const st = M.createSseStripper();
    const out = [];
    st.on('data', (c) => out.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    st.on('end', () => resolve(Buffer.concat(out).toString('utf8')));
    st.on('error', reject);
    for (const c of chunks) st.write(Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'));
    st.end();
  });
}

(async () => {
  console.log('=== server.js SSE 摘图 ===\n');

  /* ---- isEventStream ---- */
  ckTrue('GET + text/event-stream → 认', M.isEventStream('GET', 'text/event-stream'));
  ckTrue('带 charset 也认', M.isEventStream('GET', 'text/event-stream; charset=utf-8'));
  ck('POST 的 SSE → 不碰', M.isEventStream('POST', 'text/event-stream'), false);
  ck('JSON → 不碰', M.isEventStream('GET', 'application/json'), false);
  ck('没有 content-type → 不碰', M.isEventStream('GET', ''), false);

  /* ---- stripSseData:摘 ---- */
  const e1 = toolEvent();
  ck('真图摘掉 1 处', M.stripSseData(e1), 1);
  const file = e1.data.content[1];
  ck('uri 清空(大块 base64 不再出网)', file.uri, '');
  ck('记下原字节数', file.omitted, IMG.length);
  ck('name / mime / type 都留着', [file.name, file.mime, file.type],
    ['/tmp/ocsm-probe/chkpage-1.png', 'image/png', 'file']);
  ck('同一事件里的 text 一个不碰', e1.data.content[0], { type: 'text', text: 'Image read successfully' });
  ck('事件自己的字段一个不碰', [e1.id, e1.type, e1.data.id, e1.data.metadata.title],
    ['evt_1', 'session.tool.success', 'tool_1', 'read']);
  ckTrue('重排之后这个事件掉到 2KB 以下', Buffer.byteLength(JSON.stringify(e1)) < 2000);

  const e2 = toolEvent();
  e2.data.content.push({ type: 'file', uri: 'data:image/jpeg;base64,' + 'B'.repeat(1000) });
  ck('一张以上 → 2 处', M.stripSseData(e2), 2);

  /* ---- stripSseData:不该碰的 ---- */
  ck('别的 session.* 事件 → 0', M.stripSseData({ type: 'session.message.updated', data: { content: [{ uri: IMG }] } }), 0);
  ck('session.tool.progress(只有 metadata)→ 0',
    M.stripSseData({ type: 'session.tool.progress', data: { id: 't', metadata: {} } }), 0);
  ck('content 不是数组 → 0', M.stripSseData({ type: 'session.tool.success', data: { content: 'x' } }), 0);
  ck('没有 data → 0', M.stripSseData({ type: 'session.tool.success' }), 0);
  ck('null → 0', M.stripSseData(null), 0);
  ck('undefined → 0', M.stripSseData(undefined), 0);
  ck('file:// 不动', M.stripSseData({ type: 'session.tool.success', data: { content: [{ uri: 'file:///a.png' }] } }), 0);
  ck('https 链接不动', M.stripSseData({ type: 'session.tool.success', data: { content: [{ uri: 'https://x/a.png' }] } }), 0);
  ck('uri 是数字不炸', M.stripSseData({ type: 'session.tool.success', data: { content: [{ uri: 42 }] } }), 0);
  ck('item 是 null 不炸', M.stripSseData({ type: 'session.tool.success', data: { content: [null] } }), 0);

  /* ---- stripSseLine:行级 ---- */
  ck('注释 / 心跳行原样', M.stripSseLine(': heartbeat'), ': heartbeat');
  ck('event: 行原样', M.stripSseLine('event: message'), 'event: message');
  ck('空行原样', M.stripSseLine(''), '');
  ck('id: 行原样', M.stripSseLine('id: 7'), 'id: 7');
  ck('坏 JSON 原样(半截帧不许把流弄坏)', M.stripSseLine('data: {"type":"session.tool.success","data"'),
    'data: {"type":"session.tool.success","data"');
  ck('不是对象的 JSON 原样', M.stripSseLine('data: [1,2,3]'), 'data: [1,2,3]');
  ck('没有 data: 前缀的 JSON 行原样', M.stripSseLine('{"type":"session.tool.success"}'),
    '{"type":"session.tool.success"}');
  ck('server.connected 原样(bytes 相同)',
    M.stripSseLine('data: {"id":"evt_x","type":"server.connected","data":{}}'),
    'data: {"id":"evt_x","type":"server.connected","data":{}}');
  const line = M.stripSseLine('data: ' + JSON.stringify(toolEvent()));
  ckTrue('tool.success 那一行被改写(data: 前缀还在)', line.indexOf('data: ') === 0);
  const back = JSON.parse(line.slice(6));
  ck('改写后 type/id 没变', [back.type, back.id, back.data.id], ['session.tool.success', 'evt_1', 'tool_1']);
  ck('改写后图也没了', back.data.content[1].uri, '');
  ckTrue('改写后的行短得多', line.length < 2000);

  /* ---- createSseStripper:跨 chunk ---- */
  const ev = toolEvent(true); // 逐字节喂的那几条用小图
  const plain = { id: 'evt_2', type: 'server.connected', data: {} };
  const whole = ': hello\n\n' + frame(plain) + frame(ev) + ': heartbeat\n\n';

  const asOne = await through([whole]);
  ckTrue('整段一次喂:tool.success 的图没了', asOne.indexOf('base64') < 0);
  ckTrue('整段一次喂:心跳 / 注释 / 别的帧还在',
    asOne.indexOf(': hello') === 0 && asOne.indexOf(': heartbeat') >= 0 &&
    asOne.indexOf(JSON.stringify(plain)) > 0);
  ck('帧边界与换行没变(空的 \n\n 一个不少)',
    (asOne.match(/\n\n/g) || []).length, (whole.match(/\n\n/g) || []).length);

  /* 把整段按 1 字节切 —— 最狠的切法:JSON 中间、汉字中间、\n 全被切开 */
  const bytes = Buffer.from(whole, 'utf8');
  const oneByte = [];
  for (let i = 0; i < bytes.length; i++) oneByte.push(bytes.subarray(i, i + 1));
  const asByte = await through(oneByte);
  ck('按 1 字节切:输出与整段喂完全一致', asByte, asOne);

  /* 随机切(含跨 chunk 的汉字):造一个带中文的 tool 事件 */
  const zh = toolEvent(true);
  zh.data.content[1].name = '/tmp/ocsm-probe/截图-一.png';
  zh.data.content[0].text = '读到了这张图:第一页';
  const zhWhole = frame(zh) + frame(plain);
  const zhBytes = Buffer.from(zhWhole, 'utf8');
  const cuts = [];
  let at = 0;
  const steps = [1, 2, 3, 5, 8, 13, 21, 34];
  let si = 0;
  while (at < zhBytes.length) {
    const n = steps[si++ % steps.length];
    cuts.push(zhBytes.subarray(at, at + n));
    at += n;
  }
  const zhOut = await through(cuts);
  ckTrue('跨 chunk 切:汉字没被切坏(名字与正文原样)', zhOut.indexOf('/tmp/ocsm-probe/截图-一.png') >= 0 &&
    zhOut.indexOf('读到了这张图:第一页') >= 0);
  ckTrue('跨 chunk 切:图照样摘掉了', zhOut.indexOf('base64') < 0);

  /* 只有 data 行没有结尾换行(流被掐断)也要能出来 */
  const tail = await through(['data: ' + JSON.stringify(toolEvent(true))]);
  ckTrue('没有结尾换行(流被掐断)也照样处理', tail.indexOf('base64') < 0 && tail.indexOf('data: ') === 0);

  /* 半截 JSON 跨 chunk:上一 chunk 是半行、下一 chunk 补齐 —— 只在完整行上改写 */
  const evLine = 'data: ' + JSON.stringify(toolEvent(true)) + '\n';
  const half = Math.floor(evLine.length / 2);
  const split = await through([evLine.slice(0, half), evLine.slice(half)]);
  ckTrue('半行跨 chunk:补齐之后照样摘', split.indexOf('base64') < 0);
  const want = toolEvent(true);
  want.data.content[1].uri = '';
  want.data.content[1].omitted = ('data:image/png;base64,' + 'A'.repeat(200)).length;
  ck('半行跨 chunk:输出仍是「一行」,内容与直接改写一致', split, 'data: ' + JSON.stringify(want) + '\n');

  /* 一行超长又没换行:原样放出去(自保),后面的行照常处理 */
  const big = 'data: ' + JSON.stringify({ type: 'x', pad: 'C'.repeat(9 * 1024 * 1024) });
  const afterBig = await through([big + '\n' + frame(plain)]);
  ckTrue('单行超 8MB 也照常收尾(没把内存攒爆、也没丢后面的帧)',
    afterBig.indexOf(JSON.stringify(plain)) > 0 && afterBig.indexOf('CCCC') > 0);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL: 测试自身抛错 — ' + (e && e.stack));
  process.exit(1);
});
