'use strict';
/* server.js 来源地址白名单(`OCS_ALLOW`)的单元断言。
 *
 * 纯逻辑,不需要无头浏览器,也不需要 OpenCode 服务在跑。
 * `server.js` 的启动被 `require.main === module` 挡住了,require 它只拿纯函数。
 *
 * 用法: node test/netallow-run.js
 * 退出码: 0 全部通过;1 有失败。
 */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const M = require(SERVER);

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

// 在一个【干净的 env】里 require 一次 server.js,读它算出来的白名单状态。
// 模块级常量在 require 时固化,所以配置类断言只能这样验。
function probe(spec, expr) {
  const script =
    'const M=require(' + JSON.stringify(SERVER) + ');' + 'process.stdout.write(JSON.stringify(' + expr + '));';
  const env = Object.assign({}, process.env);
  if (spec === null) delete env.OCS_ALLOW;
  else env.OCS_ALLOW = spec;
  const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) return { __error: String(r.stderr || '').trim() };
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    return { __error: String(r.stdout) };
  }
}
const REQ = (ip) => 'M.sourceAllowed({socket:{remoteAddress:' + JSON.stringify(ip) + '}})';

console.log('=== server.js 来源地址白名单(OCS_ALLOW)===\n');

/* ---- ipToBytes:IPv4 ---- */
ck('ipToBytes 1.2.3.4', Array.from(M.ipToBytes('1.2.3.4') || []), [1, 2, 3, 4]);
ck('ipToBytes 255.255.255.255', Array.from(M.ipToBytes('255.255.255.255') || []), [255, 255, 255, 255]);
ck('ipToBytes 0.0.0.0', Array.from(M.ipToBytes('0.0.0.0') || []), [0, 0, 0, 0]);
ck('ipToBytes 256.1.1.1 → null', M.ipToBytes('256.1.1.1'), null);
ck('ipToBytes 1.2.3 → null', M.ipToBytes('1.2.3'), null);
ck('ipToBytes 1.2.3.4.5 → null', M.ipToBytes('1.2.3.4.5'), null);
ck('ipToBytes a.b.c.d → null', M.ipToBytes('a.b.c.d'), null);
ck('ipToBytes 01.2.3.4 允许前导零', Array.from(M.ipToBytes('01.2.3.4') || []), [1, 2, 3, 4]);

/* ---- ipToBytes:IPv6 ---- */
ck('ipToBytes ::1 长度 16', (M.ipToBytes('::1') || []).length, 16);
ck('ipToBytes ::1 末字节 1', Array.from(M.ipToBytes('::1') || []).slice(14), [0, 1]);
ck('ipToBytes :: 全 0', Array.from(M.ipToBytes('::') || []), new Array(16).fill(0));
ck('ipToBytes ::ffff:192.0.2.5 后四字节', Array.from(M.ipToBytes('::ffff:192.0.2.5') || []).slice(12), [192, 0, 2, 5]);
ck('ipToBytes 全展开 1:2:3:4:5:6:7:8 首字节', Array.from(M.ipToBytes('1:2:3:4:5:6:7:8') || []).slice(0, 2), [0, 1]);
ck('ipToBytes fe80::1 与 fe80::1%eth0 同值', Array.from(M.ipToBytes('fe80::1') || []), Array.from(M.ipToBytes('fe80::1%eth0') || []));
ck('ipToBytes ::1.2.3.4 后四字节', Array.from(M.ipToBytes('::1.2.3.4') || []).slice(12), [1, 2, 3, 4]);
ck('ipToBytes 九组 → null', M.ipToBytes('1:2:3:4:5:6:7:8:9'), null);
ck('ipToBytes ::: → null', M.ipToBytes(':::'), null);
ck('ipToBytes 1:::2 → null', M.ipToBytes('1:::2'), null);
ck('ipToBytes 1:2:3:4:5:6:7: → null(尾随冒号)', M.ipToBytes('1:2:3:4:5:6:7:'), null);
ck('ipToBytes :1:2:3:4:5:6:7 → null(首冒号)', M.ipToBytes(':1:2:3:4:5:6:7'), null);
ck('ipToBytes gggg::1 → null', M.ipToBytes('gggg::1'), null);
ck('ipToBytes 空串 → null', M.ipToBytes(''), null);
ck('ipToBytes null → null', M.ipToBytes(null), null);

/* ---- unmapIPv4 ---- */
ck('unmap ::ffff:192.0.2.5 → 4 字节', Array.from(M.unmapIPv4(M.ipToBytes('::ffff:192.0.2.5')) || []), [192, 0, 2, 5]);
ck('unmap ::1 保持 16 字节', (M.unmapIPv4(M.ipToBytes('::1')) || []).length, 16);
ck('unmap 1.2.3.4 保持 4 字节', Array.from(M.unmapIPv4(M.ipToBytes('1.2.3.4')) || []), [1, 2, 3, 4]);
ck('unmap null → null', M.unmapIPv4(null), null);

/* ---- parseAllowRule ---- */
ck('rule 192.0.2.0/24 bits', (M.parseAllowRule('192.0.2.0/24') || {}).bits, 24);
ck('rule 192.0.2.0/24 字节', Array.from((M.parseAllowRule('192.0.2.0/24') || {}).bytes || []), [192, 0, 2, 0]);
ck('rule 不带 /nn 按全 32 位', (M.parseAllowRule('192.0.2.5') || {}).bits, 32);
ck('rule ::1 按全 128 位', (M.parseAllowRule('::1') || {}).bits, 128);
ck('rule 192.0.2.0/33 → null(超范围)', M.parseAllowRule('192.0.2.0/33'), null);
ck('rule 192.0.2.0/x → null', M.parseAllowRule('192.0.2.0/x'), null);
ck('rule 空串 → null', M.parseAllowRule(''), null);
ck('rule 垃圾 → null', M.parseAllowRule('not-an-ip'), null);
ck('rule /0 合法(等于全放行)', (M.parseAllowRule('0.0.0.0/0') || {}).bits, 0);

/* ---- matchAllowRule ---- */
const R24 = M.parseAllowRule('192.0.2.0/24');
ckTrue('192.0.2.5 ∈ 192.0.2.0/24', M.matchAllowRule(M.ipToBytes('192.0.2.5'), R24));
ckTrue('192.0.2.255 ∈ 192.0.2.0/24(边界)', M.matchAllowRule(M.ipToBytes('192.0.2.255'), R24));
ck('192.0.3.1 ∉ 192.0.2.0/24', M.matchAllowRule(M.ipToBytes('192.0.3.1'), R24), false);
ck('192.0.1.255 ∉ 192.0.2.0/24', M.matchAllowRule(M.ipToBytes('192.0.1.255'), R24), false);
const R8 = M.parseAllowRule('127.0.0.0/8');
ckTrue('127.0.0.1 ∈ 127.0.0.0/8', M.matchAllowRule(M.ipToBytes('127.0.0.1'), R8));
ck('128.0.0.1 ∉ 127.0.0.0/8', M.matchAllowRule(M.ipToBytes('128.0.0.1'), R8), false);
const R32 = M.parseAllowRule('192.0.2.5');
ckTrue('192.0.2.5 ∈ 192.0.2.5(=32 位)', M.matchAllowRule(M.ipToBytes('192.0.2.5'), R32));
ck('192.0.2.6 ∉ 192.0.2.5', M.matchAllowRule(M.ipToBytes('192.0.2.6'), R32), false);
ck('IPv4 字节不会匹配 IPv6 规则(族不同)', M.matchAllowRule(M.ipToBytes('192.0.2.5'), M.parseAllowRule('::1')), false);
ck('非整字节掩码:192.0.2.1 ∈ 192.0.0.0/9', M.matchAllowRule(M.ipToBytes('192.0.2.1'), M.parseAllowRule('192.0.0.0/9')), true);
ck('非整字节掩码:192.128.0.1 ∉ 192.0.0.0/9', M.matchAllowRule(M.ipToBytes('192.128.0.1'), M.parseAllowRule('192.0.0.0/9')), false);

/* ---- 默认配置(本进程没有设 OCS_ALLOW) ---- */
ck('默认白名单字面量', M.DEFAULT_ALLOW, '127.0.0.0/8,::1');
ck('未设 OCS_ALLOW 时用默认值', M.ALLOW_SPEC, M.DEFAULT_ALLOW);
ck('默认配置不算配错', M.ALLOW_BROKEN, false);
ck('默认规则数=2', M.ALLOW_RULES.length, 2);

/* ---- sourceAllowed:默认只放行回环 ---- */
ckTrue('127.0.0.1 放行', M.sourceAllowed({ socket: { remoteAddress: '127.0.0.1' } }));
ckTrue('127.9.9.9 放行(回环 /8)', M.sourceAllowed({ socket: { remoteAddress: '127.9.9.9' } }));
ckTrue('::1 放行', M.sourceAllowed({ socket: { remoteAddress: '::1' } }));
ckTrue('::ffff:127.0.0.1 放行(IPv4 映射)', M.sourceAllowed({ socket: { remoteAddress: '::ffff:127.0.0.1' } }));
ck('192.0.2.5 默认挡住(局域网要显式配 OCS_ALLOW)', M.sourceAllowed({ socket: { remoteAddress: '192.0.2.5' } }), false);
ck('::ffff:192.0.2.7 默认也挡住', M.sourceAllowed({ socket: { remoteAddress: '::ffff:192.0.2.7' } }), false);

/* ---- sourceAllowed:该挡的(这次改动的主要目的) ---- */
ck('192.0.3.1 挡住(差一个网段)', M.sourceAllowed({ socket: { remoteAddress: '192.0.3.1' } }), false);
ck('198.51.100.48 挡住(办公内网)', M.sourceAllowed({ socket: { remoteAddress: '198.51.100.48' } }), false);
ck('172.17.0.1 挡住(docker 网桥)', M.sourceAllowed({ socket: { remoteAddress: '172.17.0.1' } }), false);
ck('203.0.113.70 挡住(其它内网)', M.sourceAllowed({ socket: { remoteAddress: '203.0.113.70' } }), false);
ck('空地址 挡住', M.sourceAllowed({ socket: { remoteAddress: '' } }), false);
ck('垃圾地址 挡住', M.sourceAllowed({ socket: { remoteAddress: 'nonsense' } }), false);
ck('没有 socket 挡住', M.sourceAllowed({}), false);
ck('没有 req 挡住', M.sourceAllowed(undefined), false);

/* ---- 配置类:空配置 / 配错 / 自定义 ---- */
ck('OCS_ALLOW="" = 不限制(127.0.0.1)', probe('', REQ('127.0.0.1')), true);
ck('OCS_ALLOW="" = 不限制(198.51.100.48 也放行)', probe('', REQ('198.51.100.48')), true);
ck('OCS_ALLOW="" 时 ALLOW_RULES 为空', probe('', 'M.ALLOW_RULES.length'), 0);
ck('OCS_ALLOW=192.0.2.0/24 放行 192.0.2.5', probe('192.0.2.0/24', REQ('192.0.2.5')), true);
ck('OCS_ALLOW=192.0.2.0/24 放行映射地址', probe('192.0.2.0/24', REQ('::ffff:192.0.2.7')), true);
ck('OCS_ALLOW=垃圾 判为配错', probe('not-an-ip', 'M.ALLOW_BROKEN'), true);
ck('OCS_ALLOW=垃圾 时一律拒绝(而非放行)', probe('not-an-ip', REQ('127.0.0.1')), false);
ck('OCS_ALLOW=垃圾 时状态文案含「配置无效」', probe('not-an-ip', 'M.allowStatusText().indexOf("配置无效")>=0'), true);
ck('OCS_ALLOW=10.0.0.0/8 放行 10.9.9.9', probe('10.0.0.0/8', REQ('10.9.9.9')), true);
ck('OCS_ALLOW=10.0.0.0/8 挡住 127.0.0.1(自定义会顶掉默认)', probe('10.0.0.0/8', REQ('127.0.0.1')), false);
ck('OCS_ALLOW 允许留空格', probe(' 192.0.2.0/24 , ::1 ', REQ('192.0.2.5')), true);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
