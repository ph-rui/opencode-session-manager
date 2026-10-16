'use strict';
/* server.js「消息列表里摘掉 data: 图」的单元断言(移动端设计 §8.37)。
 *
 * 纯逻辑,不需要无头浏览器,也不需要 OpenCode 服务在跑。
 * 两件事:① 只认「会话消息列表」那一条 URL(别把 SSE/列表/单条消息也吞了);
 *        ② 摘的时候只动 data: 的 uri,text/name/mime 一个不碰,结构还是原样。
 *
 * 用法: node test/strip-run.js
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

/* 造一条「读图」的工具 part:和真响应同形 —— state.content[] 里既有 text 也有带 base64 的 file。 */
const IMG = 'data:image/png;base64,' + 'A'.repeat(600000);
function payload() {
  return {
    data: [
      {
        info: { id: 'm1', role: 'assistant' },
        content: [
          { type: 'text', text: '先看看页面' },
          {
            type: 'tool',
            tool: 'read',
            state: {
              status: 'completed',
              title: 'Image read successfully',
              content: [
                { type: 'text', text: 'Image read successfully' },
                { type: 'file', uri: IMG, mime: 'image/png', name: '/tmp/ocsm-probe/chkpage-1.png' },
              ],
            },
          },
        ],
      },
    ],
  };
}

console.log('=== server.js 消息列表摘图(session message strip)===\n');

/* ---- isMessageListUrl:该摘的 ---- */
const U = '/api/session/ses_abc/message?limit=30&order=desc';
ckTrue('GET 200 json 的消息列表 → 摘', M.isMessageListUrl(U, 'GET', 200, 'application/json'));
ckTrue('带 charset 的 json 也认', M.isMessageListUrl(U, 'GET', 200, 'application/json; charset=utf-8'));
ckTrue('不带查询串的消息列表 → 摘', M.isMessageListUrl('/api/session/ses_abc/message', 'GET', 200, 'application/json'));
ckTrue('会话 id 里带点/横线也认', M.isMessageListUrl('/api/session/ses_1a-2b.3/message?limit=100', 'GET', 200, 'application/json'));

/* ---- isMessageListUrl:不该碰的 ---- */
ck('POST 消息列表 → 不摘', M.isMessageListUrl(U, 'POST', 200, 'application/json'), false);
ck('非 200 → 不摘', M.isMessageListUrl(U, 'GET', 404, 'application/json'), false);
ck('SSE → 不摘', M.isMessageListUrl('/api/event', 'GET', 200, 'text/event-stream'), false);
ck('会话列表(没有 /message)→ 不摘', M.isMessageListUrl('/api/session?limit=50', 'GET', 200, 'application/json'), false);
ck('单条消息(/message/<id>)→ 不摘(面板不用它,别顺手改语义)', M.isMessageListUrl('/api/session/ses_a/message/msg_1', 'GET', 200, 'application/json'), false);
ck('message 后面接别的字(-ish)→ 不摘', M.isMessageListUrl('/api/session/ses_a/messageish', 'GET', 200, 'application/json'), false);
ck('前面带别的段(/x/api/... )→ 不摘', M.isMessageListUrl('/x' + U, 'GET', 200, 'application/json'), false);
ck('非 json 的正文类型 → 不摘', M.isMessageListUrl(U, 'GET', 200, 'text/plain'), false);
ck('没有 content-type → 不摘', M.isMessageListUrl(U, 'GET', 200, ''), false);
ck('没有 url → 不摘', M.isMessageListUrl(undefined, 'GET', 200, 'application/json'), false);

/* ---- stripToolUris:摘 ---- */
const p1 = payload();
ck('真图摘掉 1 处(返回处数)', M.stripToolUris(p1), 1);
const file = p1.data[0].content[1].state.content[1];
ck('uri 清空(大块 base64 不再出网)', file.uri, '');
ck('记下原字节数(将来点开看图还知道多大)', file.omitted, IMG.length);
ck('name 留着', file.name, '/tmp/ocsm-probe/chkpage-1.png');
ck('mime 留着', file.mime, 'image/png');
ck('同一 part 里的 text 一个不碰', p1.data[0].content[1].state.content[0], {
  type: 'text',
  text: 'Image read successfully',
});
ck('消掉的字节能算出来(600KB 级)', IMG.length - file.uri.length, IMG.length);
ckTrue('重排之后总字节掉到 1/100 以下', Buffer.byteLength(JSON.stringify(p1)) < 2000);
ckTrue('摘完之后 data 仍是数组(面板的 Array.isArray 校验)', Array.isArray(p1.data));

/* 一个以上:两条消息各一张 */
const p2 = payload();
p2.data.push(JSON.parse(JSON.stringify(p2.data[0])));
ck('两条消息各一张 → 2 处', M.stripToolUris(p2), 2);

/* data:text/... 也是字节,一样摘 */
const p3 = { data: [{ content: [{ state: { content: [{ uri: 'data:text/plain;base64,' + 'B'.repeat(500) }] } }] }] };
ck('非图片的 data: 也摘(它同样一个字节都不显示)', M.stripToolUris(p3), 1);

/* ---- stripToolUris:不摘 / 不炸 ---- */
const p4 = payload();
p4.data[0].content[1].state.content[1].uri = 'file:///tmp/chkpage-1.png';
ck('file: 路径原样留着', M.stripToolUris(p4), 0);
ck('file: 路径没被改写', p4.data[0].content[1].state.content[1].uri, 'file:///tmp/chkpage-1.png');
ck('没摘到的时候也不加 omitted', 'omitted' in p4.data[0].content[1].state.content[1], false);
ck('http 链接也不摘', M.stripToolUris({ data: [{ content: [{ state: { content: [{ uri: 'https://x/a.png' }] } }] }] }), 0);
ck('uri 是数字也不炸', M.stripToolUris({ data: [{ content: [{ state: { content: [{ uri: 42 }] } }] }] }), 0);
ck('uri 是 null 也不炸', M.stripToolUris({ data: [{ content: [{ state: { content: [{ uri: null }] } }] }] }), 0);
ck('item 是 null 也不炸', M.stripToolUris({ data: [{ content: [{ state: { content: [null] } }] }] }), 0);
ck('content 里有 null 也不炸', M.stripToolUris({ data: [{ content: [null] }] }), 0);
ck('part 没有 state 也不炸', M.stripToolUris({ data: [{ content: [{ type: 'text', text: 'x' }] }] }), 0);
ck('state.content 不是数组也不炸', M.stripToolUris({ data: [{ content: [{ state: { content: 'x' } }] }] }), 0);
ck('data 不是数组 → 0(不炸)', M.stripToolUris({ data: { nope: 1 } }), 0);
ck('没有 data → 0', M.stripToolUris({ error: 'x' }), 0);
ck('null → 0', M.stripToolUris(null), 0);
ck('undefined → 0', M.stripToolUris(undefined), 0);
ck('空对象 → 0', M.stripToolUris({}), 0);

/* ---- 一句话形状:摘前摘后,面板看到的东西一模一样 ---- */
const before = payload();
const after = JSON.parse(JSON.stringify(before));
M.stripToolUris(after);
const visible = (j) =>
  j.data.map((m) => (m.content || []).map((c) => [c.type, (c.state && c.state.content || []).map((i) => i.text || '')]))
    .flat(3);
ck('面板看得见的(text)摘前摘后一致', visible(after), visible(before));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
