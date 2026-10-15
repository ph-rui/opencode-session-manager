'use strict';

/* OpenCode 会话管理器 — 前端逻辑(原生 JS,无框架) */

const store = {
  sessions: new Map(),
  messages: new Map(),
  seenDirs: new Set(),
  selected: null,
  order: 'desc',
  search: '',
  directory: '',
  sessionCursor: null,
  msgOlderCursor: null,
  pending: false,
  running: false,
  asks: new Map(), // key -> { kind:'form'|'permission', id, sessionID, data, busy, error }
  active: new Map(), // sessionID -> 'busy'|'retry'(来自 /api/session/active 与事件)
  inbox: new Map(), // sessionID -> [Session.Inbox.Info]
  agents: new Map(), // directory -> [Agent.Info]
  models: new Map(), // directory -> [Model.Info]
  modelIndex: new Map(), // 'providerID/modelID' -> Model.Info
  delivery: 'queue', // 运行中消息的投递方式
  ctrlKey: '', // 当前会话 agent/model 的指纹,避免回填时覆盖用户输入
  showArchived: false, // 列表是否显示已归档会话
  restoreScroll: null, // 刷新恢复时要还原的滚动锚点(只由 restoreFromHash 设置,renderMessages 消费)
  live: new Map(), // assistantMessageID -> 流式本地缓冲(见「逐 token 流式」)
  uploadDir: '', // 附件暂存目录(来自 /__health)
  attachments: [], // 待发送的附件:[{ id, name, size, mime, path, uri }]
  mentionHits: new Map(), // @ 补全里确认过的条目:'相对路径' -> 绝对路径(H 组 6 A)
  mentionItems: [], // 当前补全列表
  mentionAt: -1, // 补全列表当前高亮项
  mentionRange: null, // 正在补全的 @token 在输入框里的 [start, end)
  commands: new Map(), // directory -> [{ name, description, panel }]服务端真实命令(按工程缓存)
  cmdItems: [], // 命令面板当前展示项
  cmdAt: -1, // 命令面板当前高亮项
  cmdRange: null, // 正在补全的 /token 在输入框里的 [start, end)
  history: new Map(), // sessionID -> [已发送文本](↑/↓ 取用,每会话独立)
  histAt: -1, // 历史游标;-1 = 不在历史里(停在草稿)
  histDraft: '', // 进入历史前暂存的草稿
  pickItems: [], // 选择框对话框的全部条目
  pickShown: [], // 当前过滤后真正显示的条目(↑/↓ 在它里面走)
  pickAt: -1, // 选择框当前高亮项(下标指向 pickShown)
  pickOnPick: null, // 选中回调
};

const $ = (s) => document.querySelector(s);
const enc = encodeURIComponent;

/* ----------------------------- 工具 ----------------------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function rel(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 0) return '刚刚';
  const s = Math.floor(d / 1000);
  if (s < 60) return s + ' 秒前';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const day = Math.floor(h / 24);
  if (day < 30) return day + ' 天前';
  return new Date(ts).toLocaleDateString();
}

function fmtCost(c) {
  return c && c > 0 ? '$' + c.toFixed(2) : '';
}

function fmtTokens(t) {
  if (!t) return '';
  const i = t.input || 0;
  const o = t.output || 0;
  return (i + o).toLocaleString();
}

function dirBase(p) {
  if (!p) return '';
  const parts = String(p).replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const txt = await r.text();
  let j = null;
  try {
    j = JSON.parse(txt);
  } catch (_) {}
  if (!r.ok) {
    const msg = (j && (j.message || j.error)) || 'HTTP ' + r.status;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return j;
}

/* ----------------------------- 健康检查 ----------------------------- */

async function health() {
  const el = $('#status');
  try {
    const j = await api('/__health');
    if (j && j.uploadDir) store.uploadDir = j.uploadDir; // 附件的落盘目录(H 组 6)
    if (j.ok) {
      el.className = 'status ok';
      el.textContent = '已连接 ' + (j.base || '');
      el.title = '配置目录: ' + j.configDir;
    } else {
      el.className = 'status bad';
      el.textContent = '未连接服务:' + (j.detail || 'OpenCode 可能未运行');
    }
  } catch (e) {
    el.className = 'status bad';
    el.textContent = '本地代理异常:' + e.message;
  }
}

/* ----------------------------- 轻量提示 ----------------------------- */

let toastTimer = null;
function flash(msg, kind) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = kind || '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

/* ----------------------------- 会话运行状态 ----------------------------- */

function runStatus(sid) {
  return store.active.get(sid) || null;
}

function isRunning(sid) {
  return !!sid && store.active.has(sid);
}

async function loadActive() {
  let j = null;
  try {
    j = await api('/api/session/active');
  } catch (e) {
    return; // 连接异常由健康检查提示
  }
  const prev = store.active;
  const next = new Map();
  Object.keys((j && j.data) || {}).forEach((sid) => {
    next.set(sid, (j.data[sid] || {}).type === 'retry' ? 'retry' : 'busy');
  });
  let changed = next.size !== prev.size;
  if (!changed) {
    for (const [k, v] of next) {
      if (prev.get(k) !== v) {
        changed = true;
        break;
      }
    }
  }
  store.active = next;
  if (changed) {
    renderSessions();
    updateChatStatus();
  }
  updateComposerControls();
  const sel = store.selected;
  if (sel && isRunning(sel)) {
    // 运行中可能正产生新消息,轻量刷新
    loadMessages({ older: false });
  }
}

/* ----------------------------- 智能体 / 模型 ----------------------------- */

async function loadAgents(dir) {
  const key = dir || '';
  if (store.agents.has(key)) return store.agents.get(key);
  let list = [];
  try {
    const j = await api('/api/agent?location%5Bdirectory%5D=' + enc(key));
    list = (j.data || []).filter((a) => !a.hidden && a.mode !== 'subagent');
  } catch (e) {
    list = [];
  }
  store.agents.set(key, list);
  return list;
}

async function loadModels(dir) {
  const key = dir || '';
  if (store.models.has(key)) return store.models.get(key);
  let list = [];
  try {
    const j = await api('/api/model?location%5Bdirectory%5D=' + enc(key));
    list = (j.data || []).filter((m) => m.enabled !== false);
  } catch (e) {
    list = [];
  }
  list.forEach((m) => store.modelIndex.set(m.providerID + '/' + m.modelID, m));
  store.models.set(key, list);
  return list;
}

function modelKey(ref) {
  return ref && ref.providerID && ref.id ? ref.providerID + '/' + ref.id : '';
}

function ctrlKeyOf(s) {
  return JSON.stringify([(s && s.agent) || '', (s && s.model) || null]);
}

async function renderControls(s) {
  const bar = $('#ctoolbar');
  if (!bar) return;
  if (!s || !store.selected) {
    bar.hidden = true;
    store.ctrlKey = '';
    updateComposerControls();
    return;
  }
  const dir = (s.location && s.location.directory) || '';
  const agentSel = $('#agentSel');
  const modelSel = $('#modelSel');
  const varWrap = $('#variantWrap');
  const varSel = $('#variantSel');

  const [agents, models] = await Promise.all([loadAgents(dir), loadModels(dir)]);
  if (store.selected !== s.id) return; // 期间切换了会话

  // 智能体
  const curAgent = s.agent || '';
  agentSel.innerHTML = agentOptionsHtml(agents, curAgent);
  agentSel.value = curAgent;

  // 模型(按 provider 分组)
  let mHtml = modelOptionsHtml(models);
  const curModel = modelKey(s.model);
  if (curModel && !store.modelIndex.has(curModel)) {
    mHtml += '<option value="' + esc(curModel) + '">' + esc(curModel) + '(当前)</option>';
  }
  modelSel.innerHTML = mHtml;
  modelSel.value = curModel;

  // 变体
  paintVariant(varWrap, varSel, curModel);
  varSel.value = (s.model && s.model.variant) || '';

  bar.hidden = false;
  store.ctrlKey = ctrlKeyOf(s);
  updateComposerControls();
}

async function switchAgent(id) {
  const sid = store.selected;
  if (!sid) return;
  const s = store.sessions.get(sid);
  if (!id) {
    // 服务端不允许清空,回填原值
    flash('智能体不能置空,已保留当前设置', 'warn');
    renderControls(s);
    return;
  }
  try {
    await api('/api/session/' + enc(sid) + '/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: id }),
    });
  } catch (e) {
    flash('切换智能体失败:' + e.message, 'bad');
    renderControls(s);
    return;
  }
  flash('已切换智能体:' + id, 'ok');
  await loadSessions({});
  loadMessages({ older: false });
}

// 切模型只有这一条路径:工具栏那个下拉和服务端命令 /models 都走它
async function applyModel(key, variant) {
  const sid = store.selected;
  if (!sid) return;
  const s = store.sessions.get(sid);
  if (!key) {
    flash('模型不能置空,已保留当前设置', 'warn');
    renderControls(s);
    return;
  }
  const ref = modelRefOf(key, variant);
  try {
    await api('/api/session/' + enc(sid) + '/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ref }),
    });
  } catch (e) {
    flash('切换模型失败:' + e.message, 'bad');
    renderControls(s);
    return;
  }
  flash('已切换模型:' + ref.providerID + '/' + ref.id + (variant ? ' · ' + variant : ''), 'ok');
  await loadSessions({});
  renderControls(store.sessions.get(sid));
  loadMessages({ older: false });
}

async function switchModel() {
  await applyModel($('#modelSel').value, $('#variantSel').value);
}

/* ----------------------------- 投递方式 / 中断 ----------------------------- */

function setDelivery(mode) {
  store.delivery = mode === 'steer' ? 'steer' : 'queue';
  paintDelivery();
}

function paintDelivery() {
  const el = $('#delivery');
  if (!el) return;
  el.querySelectorAll('button[data-delivery]').forEach((b) => {
    b.classList.toggle('active', b.dataset.delivery === store.delivery);
  });
}

function updateComposerControls() {
  const sel = store.selected;
  const busy = !!sel && (isRunning(sel) || store.running);
  const ib = $('#interrupt');
  if (ib) {
    ib.hidden = !busy;
    ib.disabled = false;
  }
  const dl = $('#delivery');
  if (dl) dl.hidden = !busy;
  const send = $('#send');
  if (send) send.disabled = !sel;
  const att = $('#btnAttach');
  if (att) att.disabled = !sel;
}

async function interrupt() {
  const sid = store.selected;
  if (!sid) return;
  const btn = $('#interrupt');
  if (btn) btn.disabled = true;
  try {
    const j = await api('/api/session/' + enc(sid) + '/interrupt', { method: 'POST' });
    if (j && j.interrupted) flash('已中断当前回合', 'ok');
    else flash('当前没有正在执行的回合', 'warn');
  } catch (e) {
    flash('中断失败:' + e.message, 'bad');
  }
  if (btn) btn.disabled = false;
  await loadActive();
}

/* ----------------------------- 待发送队列 ----------------------------- */

async function loadInbox(sid) {
  if (!sid) return;
  let items = [];
  try {
    const j = await api('/api/session/' + enc(sid) + '/inbox');
    items = j.data || [];
  } catch (e) {
    items = [];
  }
  store.inbox.set(sid, items);
  if (store.selected === sid) renderInbox();
}

function inboxKind(it) {
  if (!it) return '待发送';
  if (it.type === 'compaction') return '压缩';
  if (it.type === 'move') return '移动';
  if (it.type === 'synthetic') return '注入';
  return '待发送';
}

function inboxText(it) {
  const p = it && it.payload;
  if (!p) return '';
  if (typeof p.text === 'string') return p.text;
  if (p.location && p.location.directory) return p.location.directory;
  if (p.directory) return p.directory;
  return '';
}

function renderInbox() {
  const box = $('#inbox');
  if (!box) return;
  // synthetic 是服务端注入的内部提醒(例如切换 agent 时的系统提示),不展示也不允许取消
  const items = ((store.selected && store.inbox.get(store.selected)) || []).filter(
    (it) => it && it.type !== 'synthetic'
  );
  box.innerHTML = '';
  if (!items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const it of items) {
    const isSteer = it.delivery === 'steer';
    const el = document.createElement('div');
    el.className = 'inbox-item';
    const text = inboxText(it);
    el.innerHTML =
      '<span class="ib-mark">↳</span>' +
      '<span class="ib-kind">' + esc(inboxKind(it)) + '</span>' +
      '<span class="ib-delivery ' + (isSteer ? 'steer' : 'queue') + '">' +
      (isSteer ? '插话' : '排队') +
      '</span>' +
      '<span class="ib-text" title="' + esc(text) + '">' + esc(text || '(无文本)') + '</span>' +
      '<span class="ib-acts">' +
      '<button type="button" data-inbox-op="toggle">' + (isSteer ? '改为排队' : '改为插话') + '</button>' +
      '<button type="button" data-inbox-op="cancel" class="danger">取消</button>' +
      '</span>';
    el.querySelector('[data-inbox-op="toggle"]').addEventListener('click', () =>
      setInboxDelivery(it, isSteer ? 'queue' : 'steer', el)
    );
    el.querySelector('[data-inbox-op="cancel"]').addEventListener('click', () => cancelInbox(it, el));
    box.appendChild(el);
  }
}

async function setInboxDelivery(it, mode, el) {
  const url = '/api/session/' + enc(it.sessionID) + '/inbox/' + enc(it.id);
  if (el) el.style.opacity = '0.5';
  try {
    await api(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delivery: mode }),
    });
    flash('投递方式已改为:' + (mode === 'steer' ? '插话' : '排队'), 'ok');
  } catch (e) {
    flash('修改投递方式失败:' + e.message, 'bad');
  }
  if (el) el.style.opacity = '';
  await loadInbox(it.sessionID);
}

async function cancelInbox(it, el) {
  const url = '/api/session/' + enc(it.sessionID) + '/inbox/' + enc(it.id);
  if (el) el.style.opacity = '0.5';
  try {
    await api(url, { method: 'DELETE' });
    flash('已取消该条待发送消息', 'ok');
  } catch (e) {
    flash('取消失败:' + e.message, 'bad');
  }
  if (el) el.style.opacity = '';
  await loadInbox(it.sessionID);
}

/* ----------------------------- 通用:选择器片段 ----------------------------- */

// agent 列表 → <option> 片段;当前值不在列表里时补一个「(当前)」项,避免下拉被清空。
function agentOptionsHtml(agents, cur) {
  let html = '<option value="">默认</option>';
  if (cur && !agents.some((a) => a.id === cur)) {
    html += '<option value="' + esc(cur) + '">' + esc(cur) + '(当前)</option>';
  }
  return html + agents.map((a) => '<option value="' + esc(a.id) + '">' + esc(a.name || a.id) + '</option>').join('');
}

// 模型列表 → 按 providerID 分组的 <optgroup> 片段。
function modelOptionsHtml(models) {
  const groups = new Map();
  models.forEach((m) => {
    if (!groups.has(m.providerID)) groups.set(m.providerID, []);
    groups.get(m.providerID).push(m);
  });
  let html = '<option value="">默认</option>';
  for (const [pid, ms] of groups) {
    html +=
      '<optgroup label="' + esc(pid) + '">' +
      ms
        .map(
          (m) =>
            '<option value="' + esc(pid + '/' + m.modelID) + '">' + esc(m.name || m.modelID) + '</option>'
        )
        .join('') +
      '</optgroup>';
  }
  return html;
}

// 把 'providerID/modelID' 还原成 Model.Ref(服务端要求 {id, providerID, variant?})。
function modelRefOf(key, variant) {
  if (!key) return null;
  const info = store.modelIndex.get(key);
  const slash = key.indexOf('/');
  const ref = info
    ? { providerID: info.providerID, id: info.modelID }
    : { providerID: key.slice(0, slash), id: key.slice(slash + 1) };
  if (variant) ref.variant = variant;
  return ref;
}

function paintVariant(wrap, sel, key) {
  const info = store.modelIndex.get(key);
  const variants = (info && info.variants) || [];
  wrap.hidden = !variants.length;
  sel.innerHTML =
    '<option value="">默认</option>' +
    variants.map((v) => '<option value="' + esc(v.id) + '">' + esc(v.id) + '</option>').join('');
}

function setBusy(btn, on, label) {
  if (!btn) return;
  if (on) {
    if (!btn.dataset.idle) btn.dataset.idle = btn.textContent;
    btn.disabled = true;
    if (label) btn.textContent = label;
  } else {
    btn.disabled = false;
    if (btn.dataset.idle) btn.textContent = btn.dataset.idle;
  }
}

/* ----------------------------- 归档(面板级) ----------------------------- */

// OpenCode v2.0.28 没有会话归档接口(Session.Info 虽有 time.archived,但只有 project 能写),
// 因此归档记录在 session.metadata 下,由本面板负责过滤。PATCH metadata 是整体替换,必须读-改-写。
const ARCHIVE_NS = 'ocs';

function isArchived(s) {
  const m = (s && s.metadata) || {};
  return !!(m[ARCHIVE_NS] && m[ARCHIVE_NS].archived);
}

async function setArchived(id, on) {
  const s = store.sessions.get(id);
  if (!s) return;
  const meta = Object.assign({}, s.metadata || {});
  const ns = Object.assign({}, meta[ARCHIVE_NS] || {});
  if (on) ns.archived = Date.now();
  else delete ns.archived;
  if (Object.keys(ns).length) meta[ARCHIVE_NS] = ns;
  else delete meta[ARCHIVE_NS];
  await api('/api/session/' + enc(id), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metadata: meta }),
  });
  s.metadata = meta;
}

async function toggleArchive(id) {
  const s = id && store.sessions.get(id);
  if (!s) return;
  const on = !isArchived(s);
  if (on && !confirm('归档后该会话默认从列表隐藏(仅本面板记录,OpenCode 本身不感知)。继续?')) return;
  try {
    await setArchived(id, on);
  } catch (e) {
    flash('归档失败:' + e.message, 'bad');
    return;
  }
  renderSessions();
  renderChatOps();
  flash(on ? '已归档(勾选左栏「显示已归档」可查看)' : '已取消归档', 'ok');
}

function renderChatOps() {
  const bar = $('#chatOps');
  if (!bar) return;
  const s = store.selected ? store.sessions.get(store.selected) : null;
  if (!s) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const on = isArchived(s);
  const ab = $('#opArchive');
  ab.textContent = on ? '取消归档' : '归档';
  ab.classList.toggle('arch-on', on);
}

/* ----------------------------- 对话框 ----------------------------- */

function openDlg(el) {
  if (!el) return;
  if (typeof el.showModal === 'function') el.showModal();
  else el.setAttribute('open', '');
}

function closeDlg(el) {
  if (!el) return;
  if (typeof el.close === 'function') el.close();
  else el.removeAttribute('open');
}

/* ----------------------------- 新建会话 ----------------------------- */

async function fillNewSelectors() {
  const dir = ($('#newDir').value || '').trim();
  const [agents, models] = await Promise.all([loadAgents(dir), loadModels(dir)]);
  if (($('#newDir').value || '').trim() !== dir) return; // 期间目录又变了
  const mSel = $('#newModel');
  $('#newAgent').innerHTML = agentOptionsHtml(agents, '');
  mSel.innerHTML = modelOptionsHtml(models);
  paintVariant($('#newVariantWrap'), $('#newVariant'), mSel.value);
}

function openNew() {
  $('#newErr').hidden = true;
  $('#newTitle').value = '';
  if (!$('#newDir').value) $('#newDir').value = store.directory || '';
  openDlg($('#dlgNew'));
  fillNewSelectors();
}

async function submitNew() {
  const err = $('#newErr');
  err.hidden = true;
  const dir = ($('#newDir').value || '').trim();
  if (!dir) return showDlgErr(err, '请填写工程目录');
  if (dir[0] !== '/') return showDlgErr(err, '工程目录需要是绝对路径');

  const body = { location: { directory: dir } };
  const title = ($('#newTitle').value || '').trim();
  if (title) body.title = title;
  const agent = $('#newAgent').value;
  if (agent) body.agent = agent;
  const ref = modelRefOf($('#newModel').value, $('#newVariant').value);
  if (ref) body.model = ref;

  const btn = $('#newOk');
  setBusy(btn, true, '创建中…');
  try {
    const j = await api('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const s = j && j.data;
    if (!s || !s.id) throw new Error('服务端未返回会话信息');
    store.sessions.set(s.id, s);
    store.seenDirs.add(dir);
    closeDlg($('#dlgNew'));
    renderSessions();
    await selectSession(s.id);
    flash('已创建会话:' + (s.title || s.id), 'ok');
  } catch (e) {
    showDlgErr(err, '创建失败:' + e.message);
  }
  setBusy(btn, false);
}

function showDlgErr(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

/* ----------------------------- 导入 / 导出 ----------------------------- */

// 与服务端 Session.ID 的约束一致(只要求以 ses 开头),避免与既有会话撞 ID。
function newSessionID() {
  let s = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return 'ses_' + s;
}

function openImport() {
  $('#importErr').hidden = true;
  if (!$('#importDir').value) $('#importDir').value = store.directory || '';
  openDlg($('#dlgImport'));
}

async function submitImport() {
  const err = $('#importErr');
  err.hidden = true;
  const input = $('#importFile');
  const f = input.files && input.files[0];
  if (!f) return showDlgErr(err, '请选择要导入的 JSON 文件');

  let payload = null;
  try {
    payload = JSON.parse(await f.text());
  } catch (e) {
    return showDlgErr(err, '文件不是合法 JSON:' + e.message);
  }
  // 兼容本面板导出的 {data:{info,messages}} 与服务端原始载荷 {info,messages}
  const data = payload && payload.data ? payload.data : payload;
  if (!data || !data.info || !Array.isArray(data.messages)) {
    return showDlgErr(err, '文件缺少 info / messages 字段(需要本面板「导出」得到的 JSON)');
  }

  const dir = ($('#importDir').value || '').trim();
  if (dir && dir[0] !== '/') return showDlgErr(err, '目标工程目录需要是绝对路径');

  const btn = $('#importOk');
  setBusy(btn, true, '导入中…');
  let lastErr = null;
  // 服务端在 ID 已存在时返回 409,换一个 ID 重试即可。
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { info: Object.assign({}, data.info, { id: newSessionID() }), messages: data.messages };
    if (dir) body.location = { directory: dir };
    try {
      const j = await api('/api/experimental/session/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const s = j && j.data;
      if (!s || !s.id) throw new Error('服务端未返回会话信息');
      if (dir) store.seenDirs.add(dir);
      closeDlg($('#dlgImport'));
      input.value = '';
      await loadSessions({ reset: true });
      // 列表可能是分页/排序的,导入得到的会话不一定落在首页,显式补进缓存再选中
      store.sessions.set(s.id, s);
      renderSessions();
      await selectSession(s.id);
      flash('已导入会话:' + (s.title || s.id), 'ok');
      setBusy(btn, false);
      return;
    } catch (e) {
      lastErr = e;
      if (e.status !== 409) break;
    }
  }
  setBusy(btn, false);
  showDlgErr(err, '导入失败:' + (lastErr ? lastErr.message : '未知错误'));
}

function openExport() {
  $('#exportErr').hidden = true;
  openDlg($('#dlgExport'));
}

function safeName(s) {
  return String(s || '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function submitExport() {
  const sid = store.selected;
  if (!sid) return;
  const err = $('#exportErr');
  err.hidden = true;
  const sanitize = $('#exportSanitize').checked;
  const btn = $('#exportOk');
  setBusy(btn, true, '导出中…');
  try {
    const q = sanitize ? 'true' : 'false';
    const j = await api('/api/experimental/session/' + enc(sid) + '/export?sanitize=' + q);
    const s = store.sessions.get(sid);
    const stem = sanitize ? '' : safeName(s && s.title) + '-';
    const name = (stem || '') + sid + '.json';
    // 与 `opencode session export` 一致:外层 data 包裹 {info, messages}
    downloadJson(name, { data: j && j.data });
    closeDlg($('#dlgExport'));
    flash('已导出 ' + name, 'ok');
  } catch (e) {
    showDlgErr(err, '导出失败:' + e.message);
  }
  setBusy(btn, false);
}

/* ----------------------------- 深链:在 TUI 中打开 ----------------------------- */

function tuiCommand(s, sid) {
  const dir = (s && s.location && s.location.directory) || '';
  const q = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
  return 'opencode --session ' + (sid || '<sessionID>') + (dir ? ' ' + q(dir) : '');
}

function openTui() {
  const sid = store.selected;
  if (!sid) return;
  const cmd = tuiCommand(store.sessions.get(sid), sid);
  $('#tuiCmd').value = cmd;
  openDlg($('#dlgTui'));
  const inp = $('#tuiCmd');
  if (inp.select) inp.select();
}

async function copyTui() {
  const inp = $('#tuiCmd');
  const val = inp.value;
  let ok = false;
  try {
    // 局域网 http 访问不是 secure context,navigator.clipboard 通常不可用,回落到 execCommand。
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(val);
      ok = true;
    } else {
      if (inp.select) inp.select();
      ok = document.execCommand('copy');
    }
  } catch (_) {
    ok = false;
  }
  flash(ok ? '命令已复制' : '已选中命令,请按 Ctrl+C 复制', ok ? 'ok' : 'warn');
}

/* ----------------------------- 会话列表 ----------------------------- */

async function loadSessions(opts) {
  opts = opts || {};
  if (opts.reset) {
    store.sessions.clear();
    store.sessionCursor = null;
  }
  const q = new URLSearchParams({ order: store.order, limit: '50' });
  if (store.search) q.set('search', store.search);
  if (store.directory) q.set('directory', store.directory);
  if (opts.more) {
    if (!store.sessionCursor) return;
    q.set('cursor', store.sessionCursor);
  }
  try {
    const j = await api('/api/session?' + q.toString());
    (j.data || []).forEach((s) => {
      store.sessions.set(s.id, s);
      const d = s.location && s.location.directory;
      if (d) store.seenDirs.add(d);
    });
    store.sessionCursor = (j.cursor && j.cursor.next) || null;
    renderSessions();
  } catch (e) {
    console.error('loadSessions', e);
  }
}

// 当前顶部筛选/排序下,左栏真正列出来的那些会话 —— 会话选择框(/sessions)与左栏共用这一份,
// 保证对话框里看到的永远是同一批、同一序。
function visibleSessions() {
  const all = Array.from(store.sessions.values());
  return (store.showArchived ? all : all.filter((s) => !isArchived(s))).sort((a, b) => {
    const ta = (a.time && a.time.updated) || 0;
    const tb = (b.time && b.time.updated) || 0;
    return store.order === 'asc' ? ta - tb : tb - ta;
  });
}

function renderSessions() {
  const all = Array.from(store.sessions.values());
  const archived = all.filter(isArchived);
  const rows = visibleSessions();
  const tb = $('#list tbody');
  tb.innerHTML = '';
  $('#count').textContent = rows.length;
  const ac = $('#archivedCount');
  if (ac) ac.textContent = archived.length ? '(另 ' + archived.length + ' 个已归档)' : '';
  for (const s of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;
    if (s.id === store.selected) tr.classList.add('selected');
    const arch = isArchived(s);
    if (arch) tr.classList.add('archived');
    const dir = (s.location && s.location.directory) || '';
    const nAsk = askCountFor(s.id);
    const st = runStatus(s.id);
    tr.innerHTML =
      '<td class="title" title="' + esc(s.id) + '">' + esc(s.title || '(无标题)') +
      (st ? ' <span class="run-badge" title="正在执行">' + (st === 'retry' ? '◌ 重试中' : '● 运行中') + '</span>' : '') +
      (arch ? ' <span class="arch-badge" title="已在面板中归档">📦 已归档</span>' : '') +
      (nAsk ? ' <span class="ask-badge" title="有待处理问询">⚑ ' + nAsk + '</span>' : '') +
      '</td>' +
      '<td class="dir" title="' + esc(dir) + '">' + esc(dirBase(dir) || '—') + '</td>' +
      '<td class="upd">' + esc(rel(s.time && s.time.updated)) + '</td>' +
      '<td class="tok">' + esc(fmtTokens(s.tokens)) + '</td>' +
      '<td class="cost">' + esc(fmtCost(s.cost)) + '</td>' +
      '<td class="actions">' +
      '<button data-act="more" class="more" title="更多操作" aria-label="更多操作">⋯</button>' +
      '<button data-act="open">打开</button>' +
      '<button data-act="rename">改名</button>' +
      '<button data-act="move">移动</button>' +
      '<button data-act="fork">分叉</button>' +
      '<button data-act="archive"' + (arch ? ' class="arch-on"' : '') + '>' + (arch ? '取消归档' : '归档') + '</button>' +
      '<button data-act="del" class="danger">删除</button>' +
      '</td>';
    tb.appendChild(tr);
  }
  renderDirOptions();
  renderChatOps();
  $('#loadMore').hidden = !store.sessionCursor;
}

function renderDirOptions() {
  const dirs = Array.from(store.seenDirs).sort();
  // 记住的目录这次可能没出现在结果里(该目录下暂时没有会话),也得能选回去
  if (store.directory && dirs.indexOf(store.directory) < 0) dirs.unshift(store.directory);
  const sel = $('#dirFilter');
  sel.innerHTML = '<option value="">全部</option>';
  dirs.forEach((d) => {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = d;
    sel.appendChild(o);
  });
  sel.value = store.directory;

  // 新建/导入对话框里的目录提示
  const dl = $('#dirList');
  if (dl) dl.innerHTML = dirs.map((d) => '<option value="' + esc(d) + '"></option>').join('');
}

/* ----------------------------- 选择与消息 ----------------------------- */

/* --------- 选中会话的持久化(刷新后回到刚才那个会话) ---------
 * 选中的 id 落在 URL hash(#ses_xxx):刷新、复制链接、书签、在另一个标签打开
 * 都能落到同一会话 —— 与「深链跳回 TUI」是同一个主题。
 *
 * H 组 2:点会话用 pushState,于是浏览器后退/前进能在会话之间来回走;
 * 刷新恢复与「清空选择」用 replaceState,不新增历史项。
 *
 * 两条路都靠 persistSelected 里那句「已经是这个 hash 就直接返回」收口:
 * 点会话时 hash 变了 → pushState 进一格;被后退/前进带回来时浏览器【先】把
 * hash 改好【再】派发 popstate,所以进到 selectSession 时 hash 已经等于目标
 * → 什么都不做,不会把同一格再压一遍。 */

function hashToID(h) {
  const raw = String(h == null ? '' : h).replace(/^#/, '');
  if (!raw) return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw); // 非法 % 转义就按原样用
  } catch (_) {}
  return id.indexOf('ses') === 0 ? id : null;
}

function sessionHash(id) {
  return id ? '#' + encodeURIComponent(id) : '';
}

// mode:'push'(默认,点会话 → 进历史)| 'replace'(刷新恢复 / 清空 → 不动历史)
function persistSelected(id, mode) {
  const hash = sessionHash(id);
  if (location.hash === hash) return; // 已经是这个会话了,不再多压一格
  const url = id ? hash : location.pathname + location.search;
  try {
    if (mode === 'replace') history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  } catch (_) {
    // 极端情况下(例如 file://)改历史不可用,退回直接改 hash
    location.hash = hash;
  }
}

// 取消选中:回到「未选择会话」的空态。删除会话、以及浏览器后退到面板最初那一格,都走这里。
function clearSelection() {
  const id = store.selected;
  store.selected = null;
  persistSelected(null, 'replace');
  store.messages.clear();
  msgEls.clear();
  if (id) dropAsksFor(id);
  $('#messages').innerHTML = '';
  $('#chatTitle').textContent = '未选择会话';
  $('#chatMeta').textContent = '';
  clearAttachments();
  closeMentions();
  closeCommands();
  store.histAt = -1;
  store.histDraft = '';
  store.mentionHits.clear();
  renderAsks();
  renderInbox();
  renderChatOps();
  updateChatStatus();
  syncNarrowView();
}

// 刷新后恢复:只在「还没选过任何会话」时出手,不抢用户已经做出的选择。
// 刻意不要求该会话出现在列表里 —— 它可能落在第二页,selectSession 只要 id 就能拉消息。
async function restoreFromHash() {
  if (store.selected) return;
  const id = hashToID(location.hash);
  if (!id) return;
  const saved = savedAnchor(id); // 有存档就回到读到的位置;没有就按老样子跳到底部
  store.restoreScroll = { sid: id, anchor: saved };
  await selectSession(id);
}

/* --------- 会话内滚动位置(H 组 3)---------
 * 只存「顶部可见的是哪条消息 + 它距容器顶多少像素」,不存纯 scrollTop:
 * 加载更早的消息(或字号/宽度变了)会让绝对像素错位,锚到消息上才稳。
 * 存 sessionStorage 而不是 localStorage —— 这是「本标签页刚才读到哪」,
 * 不该跨标签串味,关掉标签就丢,正好符合直觉。
 * 只在【刷新恢复】时还原;从列表点进某个会话仍然跳到底部(看最新消息)。 */

const SCROLL_KEY = 'ocs.scroll';
const SCROLL_MAX = 20;

function readScrollMap() {
  try {
    const m = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}');
    return m && typeof m === 'object' ? m : {};
  } catch (_) {
    return {};
  }
}

// 当前滚动位置 → 锚点(用 rect 而不是 offsetTop:不依赖 offsetParent)
function scrollAnchor() {
  const box = $('#messages');
  if (!box) return null;
  const boxTop = box.getBoundingClientRect().top;
  const owner = new Map();
  for (const [id, rec] of msgEls) owner.set(rec.el, id);
  for (const el of box.children) {
    const id = owner.get(el);
    if (!id) continue; // 不是消息节点的跳过
    const d = el.getBoundingClientRect().top - boxTop;
    if (d + el.offsetHeight > 0) return { id: id, off: Math.round(d), top: Math.round(box.scrollTop) };
  }
  return { id: null, off: 0, top: Math.round(box.scrollTop) };
}

function saveScrollAnchor() {
  const sid = store.selected;
  if (!sid) return;
  const a = scrollAnchor();
  if (!a) return;
  const m = readScrollMap();
  delete m[sid]; // 先删再插:超额时淘汰的是「最久没用过的」
  m[sid] = a;
  const keys = Object.keys(m);
  for (let i = 0; i < keys.length - SCROLL_MAX; i++) delete m[keys[i]];
  try {
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(m));
  } catch (_) {}
}

function savedAnchor(sid) {
  return readScrollMap()[sid] || null;
}

function applyScrollAnchor(a) {
  const box = $('#messages');
  if (!a) return;
  const rec = a.id ? msgEls.get(a.id) : null;
  if (rec && rec.el && rec.el.parentElement === box) {
    const d = rec.el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop = Math.max(0, box.scrollTop + d - a.off);
    return;
  }
  box.scrollTop = a.top || 0; // 锚点消息已不在(被删 / 掉出这一页)→ 退回像素值
}

function setupScrollMemory() {
  let last = 0;
  // 时间戳节流(不用定时器:滚动过程中一直在派发,丢几帧无所谓,离开时还会兜底存一次)
  $('#messages').addEventListener('scroll', () => {
    const now = Date.now();
    if (now - last < 200) return;
    last = now;
    saveScrollAnchor();
  });
  window.addEventListener('pagehide', saveScrollAnchor); // 关页/刷新前兜一次,避免节流丢掉最后一个位置
}

/* --------- 顶栏筛选/排序/搜索的持久化(H 组 4)---------
 * 与 G 组的分工:URL hash 管「选中哪个会话」,localStorage 管「列表怎么筛」。
 * 启动时【先回填 store 与控件,再 loadSessions】—— 否则会先按默认值拉一次、
 * 再按恢复出来的条件重拉一次,白费一次请求还会闪一下。 */

const FILTER_KEYS = {
  search: 'ocs.q.search',
  dir: 'ocs.q.dir',
  order: 'ocs.q.order',
  archived: 'ocs.q.archived',
};

function readLS(key, dflt) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v;
  } catch (_) {
    return dflt;
  }
}

function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEYS.search, store.search || '');
    localStorage.setItem(FILTER_KEYS.dir, store.directory || '');
    localStorage.setItem(FILTER_KEYS.order, store.order || 'desc');
    localStorage.setItem(FILTER_KEYS.archived, store.showArchived ? '1' : '');
  } catch (_) {}
}

// 回填 store 与顶栏控件。目录下拉的选项要等 loadSessions 回来才有(renderDirOptions 会再选一次)。
function restoreFilters() {
  store.search = readLS(FILTER_KEYS.search, '');
  store.directory = readLS(FILTER_KEYS.dir, '');
  store.order = readLS(FILTER_KEYS.order, 'desc') || 'desc';
  store.showArchived = readLS(FILTER_KEYS.archived, '') === '1';
  $('#search').value = store.search;
  $('#order').value = store.order;
  $('#showArchived').checked = store.showArchived;
  $('#dirFilter').value = store.directory; // 选项还没填时这一步会被忽略,renderDirOptions 再补
}

function setupFilters() {
  restoreFilters(); // 先回填再接线,避免开场用默认值拉一次
  // 只在「取列表」上防抖;store 与存储立即跟上输入框,别让存的值落后于界面
  const reload = debounce(() => loadSessions({ reset: true }), 250);
  $('#search').addEventListener('input', () => {
    store.search = $('#search').value.trim();
    saveFilters();
    reload();
  });
  $('#dirFilter').addEventListener('change', () => {
    store.directory = $('#dirFilter').value;
    saveFilters();
    loadSessions({ reset: true });
  });
  $('#order').addEventListener('change', () => {
    store.order = $('#order').value;
    saveFilters();
    loadSessions({ reset: true });
  });
  $('#showArchived').addEventListener('change', () => {
    store.showArchived = $('#showArchived').checked;
    saveFilters();
    renderSessions();
  });
}

/* 浏览器前进/后退 → 跟着切会话(H 组 2)。
 * 同时听 popstate 与 hashchange:hash 变化两者都会来,但 syncFromHash 先比 store.selected,
 * 第二次进来直接返回,所以重复触发无害;而 fallback 里直接改 location.hash 时只有 hashchange 会来。 */
async function syncFromHash() {
  const id = hashToID(location.hash);
  if (id === store.selected) return;
  if (!id) {
    if (store.selected) {
      clearSelection();
      renderSessions();
    }
    return;
  }
  await selectSession(id);
}

function setupHistoryNav() {
  window.addEventListener('popstate', syncFromHash);
  window.addEventListener('hashchange', syncFromHash);
}

async function selectSession(id) {
  // 离开上一个会话前,先把它读到哪记下来(H 组 3)
  if (store.selected && store.selected !== id) saveScrollAnchor();
  // 只有「刷新恢复」会先塞 store.restoreScroll;从列表点进来一律跳到底部看最新消息
  const rs = store.restoreScroll && store.restoreScroll.sid === id ? store.restoreScroll.anchor : null;
  store.restoreScroll = rs;
  store.selected = id;
  persistSelected(id);
  store.messages.clear();
  store.msgOlderCursor = null;
  store.pending = false;
  store.forceBottom = !rs;
  clearAttachments(); // 待发送附件属于上一个会话,不带过去(H 组 6)
  closeMentions();
  closeCommands();
  // 输入历史是每会话独立的(I 组):切走后不再把游标留在上一条
  store.histAt = -1;
  store.histDraft = '';
  store.mentionHits.clear();
  renderSessions();
  const s = store.sessions.get(id);
  $('#chatTitle').textContent = s ? s.title || '(无标题)' : id;
  $('#chatMeta').textContent = [
    (s && s.location && s.location.directory) || '',
    s && s.time && s.time.updated ? '更新 ' + rel(s.time.updated) : '',
    s && s.projectID ? s.projectID.slice(0, 8) : '',
  ]
    .filter(Boolean)
    .join('  ·  ');
  msgEls.clear();
  $('#messages').innerHTML = '';
  renderAsks();
  renderInbox();
  renderChatOps();
  updateChatStatus();
  syncNarrowView();
  await Promise.all([
    loadMessages({ older: false }),
    loadAsks(id),
    loadInbox(id),
    renderControls(s),
  ]);
}

async function loadMessages(opts) {
  opts = opts || {};
  const id = store.selected;
  if (!id) return;
  const q = new URLSearchParams({ order: 'desc', limit: '100' });
  if (opts.older) {
    if (!store.msgOlderCursor) return;
    q.set('cursor', store.msgOlderCursor);
  }
  try {
    const j = await api('/api/session/' + encodeURIComponent(id) + '/message?' + q.toString());
    (j.data || []).forEach((m) => store.messages.set(m.id, m));
    store.msgOlderCursor = (j.cursor && j.cursor.next) || null;
    pruneLive();
    renderMessages();
  } catch (e) {
    console.error('loadMessages', e);
  }
}

// 服务端一旦给出权威完整版本(time.completed),本地缓冲就失去意义;
// 另外顺手回收「已结束且不属于当前会话」的陈旧缓冲,避免无限增长。
function pruneLive() {
  for (const [id, L] of store.live) {
    const base = store.messages.get(id);
    if (base && base.time && base.time.completed) {
      store.live.delete(id);
      continue;
    }
    if (!L.open && L.sid !== store.selected && !store.messages.has(id)) store.live.delete(id);
  }
}

/* 简易 Markdown 渲染(输入先经 esc 转义,再处理行内标记) */
function renderInline(s) {
  // 先把行内代码换成占位符,这样 **粗体** 跨过 `code` 时仍能配对
  const codes = [];
  let t = String(s).replace(/`([^`]*)`/g, (_, c) => {
    codes.push(c);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  t = t.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, n) => '<code>' + codes[Number(n)] + '</code>');
  return t;
}

/* Markdown 表格 */
function isTableSep(l) {
  return l.includes('|') && l.includes('-') && /^[\s|:-]+$/.test(l);
}
function isTableRow(l) {
  return l.includes('|') && l.trim() !== '';
}
function splitRow(l) {
  let s = String(l).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|');
}
function renderTable(head, aligns, rows) {
  const cell = (c, j, tag) => {
    const a = aligns[j] ? ' class="ta-' + aligns[j] + '"' : '';
    return (
      '<' + tag + a + '>' +
      renderInline(esc(String(c == null ? '' : c).trim())) +
      '</' + tag + '>'
    );
  };
  return (
    '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
    head.map((c, j) => cell(c, j, 'th')).join('') +
    '</tr></thead><tbody>' +
    rows
      .map((r) => '<tr>' + head.map((_, j) => cell(r[j], j, 'td')).join('') + '</tr>')
      .join('') +
    '</tbody></table></div>'
  );
}

function md(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) {
      html += '<p>' + renderInline(para.join('<br>')) + '</p>';
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html +=
        '<' + list.type + '>' +
        list.items.map((it) => '<li>' + renderInline(it) + '</li>').join('') +
        '</' + list.type + '>';
      list = null;
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushAll();
      const lang = fence[1].trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      html +=
        '<pre><code' + (lang ? ' class="lang-' + esc(lang) + '"' : '') + '>' +
        esc(buf.join('\n')) + '</code></pre>';
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushAll();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((a) => {
        const c = a.trim();
        if (/^:.*:$/.test(c)) return 'center';
        if (/:$/.test(c)) return 'right';
        if (/^:/.test(c)) return 'left';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      html += renderTable(head, aligns, rows);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      const lvl = h[1].length;
      html += '<h' + lvl + '>' + renderInline(esc(h[2])) + '</h' + lvl + '>';
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      html += '<hr>';
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushAll();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(esc(lines[i].replace(/^\s*>\s?/, '')));
        i++;
      }
      html += '<blockquote>' + renderInline(buf.join('<br>')) + '</blockquote>';
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(esc(ul[1]));
      i++;
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(esc(ol[1]));
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushAll();
      i++;
      continue;
    }
    flushList();
    para.push(esc(line));
    i++;
  }
  flushAll();
  return html;
}

/* 工具调用与状态 */
function statusInfo(p) {
  const st = (p.state && p.state.status) || (p.executed ? 'completed' : 'running');
  const map = {
    completed: { icon: '✓', cls: 'ok', label: '' },
    error: { icon: '✗', cls: 'err', label: '出错' },
    running: { icon: '●', cls: 'run', label: '运行中' },
    streaming: { icon: '●', cls: 'run', label: '运行中' },
  };
  return map[st] || { icon: '●', cls: 'run', label: String(st) };
}

/* ---------- 工具调用:改动内容(diff / 代码 / 诊断),与 TUI 的卡片对齐 ----------
 *
 * 服务端在 state.metadata 里已经算好了改动内容,前端只负责排版:
 *   edit / patch : {files:[{file, status:added|modified|deleted, additions, deletions, patch}], truncated}
 *   write        : {filepath, exists, diagnostics, truncated},正文在 state.input.content
 *   通用         : {diagnostics:{<绝对路径>: [{range:{start:{line,character}}, message}]}}
 * 下面几个都是纯函数,便于离线断言(见 test/ui-tools-run.js)。
 */

const PATCH_HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const PATCH_META_RE = /^(Index: |diff --git |index [0-9a-f]+\.\.|={3,}$)/;
const SUMMARY_KEYS = ['command', 'id', 'pattern', 'url', 'query', 'path', 'description', 'code'];

// unified diff → 带双向行号的行。
// 行形状:{k:'hunk'|'add'|'del'|'ctx'|'meta', text, oldNo, newNo}
// hunk 之外的 --- / +++ 是文件头,丢掉(路径在卡片头已经显示了)。
function parsePatch(patch) {
  const out = [];
  const lines = String(patch == null ? '' : patch).split(/\r?\n/);
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const push = (k, text, o, n) => out.push({ k: k, text: text, oldNo: o, newNo: n });
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // split 会在末尾多出空串(补丁以换行结尾);真正的空上下文行是 " "(一个空格)
    if (raw === '' && i === lines.length - 1) continue;
    if (PATCH_META_RE.test(raw)) {
      inHunk = false; // 新的一段文件开始
      continue;
    }
    if (!inHunk && /^(---|\+\+\+) /.test(raw)) continue; // 文件头
    const m = PATCH_HUNK_RE.exec(raw);
    if (m) {
      inHunk = true;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      push('hunk', raw, null, null);
      continue;
    }
    if (raw.charAt(0) === '\\') {
      push('meta', raw, null, null); // \ No newline at end of file
      continue;
    }
    if (!inHunk) continue;
    if (raw.charAt(0) === '+') push('add', raw.slice(1), null, newNo++);
    else if (raw.charAt(0) === '-') push('del', raw.slice(1), oldNo++, null);
    else push('ctx', raw.charAt(0) === ' ' ? raw.slice(1) : raw, oldNo++, newNo++);
  }
  return out;
}

function diffRowHtml(r) {
  const ln =
    '<span class="ln o">' + (r.oldNo == null ? '' : r.oldNo) + '</span>' +
    '<span class="ln n">' + (r.newNo == null ? '' : r.newNo) + '</span>';
  const sign = r.k === 'add' ? '+' : r.k === 'del' ? '-' : ' ';
  return '<div class="dl ' + r.k + '">' + ln +
    '<span class="sign">' + (r.k === 'hunk' || r.k === 'meta' ? '' : sign) + '</span>' +
    '<span class="src">' + esc(r.text) + '</span></div>';
}

function diffBadge(status) {
  const map = {
    added: { label: '新建', cls: 'add' },
    deleted: { label: '删除', cls: 'del' },
    modified: { label: '修改', cls: 'mod' },
  };
  return map[status] || { label: '变更', cls: 'mod' };
}

function diffCounts(files) {
  let additions = 0;
  let deletions = 0;
  for (const f of files || []) {
    if (typeof (f && f.additions) === 'number') additions += f.additions;
    if (typeof (f && f.deletions) === 'number') deletions += f.deletions;
  }
  return { additions: additions, deletions: deletions };
}

// 多文件 diff:每文件一块「状态徽标 + 路径 + 增删统计」,下面接统一视图正文。
function diffHtml(files) {
  let html = '';
  for (const f of files || []) {
    const b = diffBadge(f && f.status);
    const rows = parsePatch(f && f.patch);
    const adds = typeof (f && f.additions) === 'number' ? f.additions : rows.filter((r) => r.k === 'add').length;
    const dels = typeof (f && f.deletions) === 'number' ? f.deletions : rows.filter((r) => r.k === 'del').length;
    html +=
      '<div class="dfile">' +
      '<span class="dbadge ' + b.cls + '">' + b.label + '</span>' +
      '<span class="dpath">' + esc((f && f.file) || '') + '</span>' +
      (adds ? '<span class="tadd">+' + adds + '</span>' : '') +
      (dels ? '<span class="tdel">-' + dels + '</span>' : '') +
      '</div>';
    if (!rows.length) {
      html += '<div class="dnote">' + (dels ? '- ' + dels + ' 行' : '(无内容)') + '</div>';
      continue;
    }
    html += '<div class="diff">' + rows.map(diffRowHtml).join('') + '</div>';
  }
  return html;
}

// write 工具的正文:按行号显示,不做增删着色(服务端没给 diff)。
function codeHtml(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return '<div class="diff code">' + lines.map((t, i) =>
    '<div class="dl ctx"><span class="ln o"></span><span class="ln n">' + (i + 1) + '</span>' +
    '<span class="sign"> </span><span class="src">' + esc(t) + '</span></div>'
  ).join('') + '</div>';
}

// 诊断表按文件路径索引;路径可能是绝对或相对,做一次宽松匹配。
function diagnosticsFor(all, path) {
  if (Array.isArray(all[path])) return all[path];
  const p = String(path || '');
  if (!p) return [];
  const key = Object.keys(all).find((k) => k === p || k.endsWith('/' + p) || p.endsWith('/' + k));
  return key && Array.isArray(all[key]) ? all[key] : [];
}

function diagHtml(metadata, path) {
  const all = metadata && metadata.diagnostics;
  if (!all || typeof all !== 'object') return '';
  const list = diagnosticsFor(all, path);
  if (!list.length) return '';
  return '<div class="ddiag">' + list.map((d) => {
    const r = (d && d.range && d.range.start) || {};
    const line = (typeof r.line === 'number' ? r.line : 0) + 1;
    const col = (typeof r.character === 'number' ? r.character : 0) + 1;
    return '<div class="dline">错误 [' + line + ':' + col + '] ' + esc((d && d.message) || '') + '</div>';
  }).join('') + '</div>';
}

// 摘要行取哪个入参:与服务端 TUI 的优先级一致,其余标量作为补充。
function inputSummary(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim();
  if (typeof input !== 'object') return String(input);
  const keys = Object.keys(input);
  const primary = SUMMARY_KEYS.find((k) => keys.indexOf(k) >= 0);
  const scalars = keys.filter((k) => ['string', 'number', 'boolean'].indexOf(typeof input[k]) >= 0);
  const first = scalars.indexOf(primary) >= 0 ? input[primary] : undefined;
  const rest = scalars.filter((k) => k !== primary).map((k) => k + ': ' + String(input[k]));
  return [first === undefined ? '' : String(first)]
    .concat(rest)
    .filter(Boolean)
    .join('  ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toolHead(p, s, desc, counts) {
  return (
    '<span class="tmark">⏺</span>' +
    '<span class="tname">' + esc(p.name || 'tool') + '</span>' +
    (desc ? '<span class="tdesc">' + esc(desc) + '</span>' : '') +
    (counts && counts.additions ? '<span class="tadd">+' + counts.additions + '</span>' : '') +
    (counts && counts.deletions ? '<span class="tdel">-' + counts.deletions + '</span>' : '') +
    '<span class="tstate ' + s.cls + '">' + s.icon + (s.label ? ' ' + esc(s.label) : '') + '</span>'
  );
}

// open=true 的卡片默认展开(改动内容要一眼看到),与 TUI 的 edit / write / patch 一致。
function toolCard(p, s, desc, counts, body, open) {
  return (
    '<details class="tool"' + (open ? ' open' : '') + '><summary>' +
    toolHead(p, s, desc, counts) + '</summary>' +
    '<div class="toolbody">' + body + '</div></details>'
  );
}

function toolHtml(p) {
  const s = statusInfo(p);
  const st = p.state || {};
  const md = st.metadata || {};
  const name = String(p.name || 'tool');
  const input = st.input;
  const files = Array.isArray(md.files) ? md.files : [];
  const path = (input && input.path) || md.filepath || (files[0] && files[0].file) || '';

  // edit / patch:服务端算好的多文件 unified diff
  if (name === 'edit' || name === 'patch') {
    const label = name === 'patch' ? '补丁' : '编辑';
    if (files.length) {
      const desc = files.length > 1 ? '← ' + files.length + ' 个文件' : '← ' + label + ' ' + path;
      return toolCard(p, s, desc, diffCounts(files), diffHtml(files) + diagHtml(md, path), true);
    }
    // 还在跑:服务端尚未给出 files,只显示目标(与服务端 TUI 的「← Edit <path>」一致)
    return '<div class="toolrow">' + toolHead(p, s, path ? '← ' + label + ' ' + path : '← 准备' + label + '…') + '</div>';
  }

  // write:正文在入参里(服务端不给 write 的 diff)
  if (name === 'write') {
    if (input && typeof input.content === 'string') {
      return toolCard(p, s, '# 写入 ' + path, null, codeHtml(input.content) + diagHtml(md, path), true);
    }
    return '<div class="toolrow">' + toolHead(p, s, path ? '# 写入 ' + path : '# 准备写入…') + '</div>';
  }

  // question:已答时展示「问题 → 答案」
  if (name === 'question') {
    const qs = Array.isArray(input && input.questions) ? input.questions : [];
    if (Array.isArray(md.answers)) {
      let body = '<div class="qalist">';
      for (let i = 0; i < qs.length; i++) {
        const a = md.answers[i];
        const ans = Array.isArray(a) && a.length ? a.join(', ') : '(未回答)';
        body +=
          '<div class="qa"><div class="qq">' + esc((qs[i] && qs[i].question) || '') + '</div>' +
          '<div class="aa">' + esc(ans) + '</div></div>';
      }
      return toolCard(p, s, '→ 已提问 ' + qs.length + ' 个问题', null, body + '</div>', true);
    }
    return '<div class="toolrow">' + toolHead(p, s, '→ 提问中…') + '</div>';
  }

  if (name === 'skill') {
    const sk = md.name || (input && input.id) || '';
    return '<div class="toolrow">' + toolHead(p, s, sk ? '→ Skill "' + sk + '"' : '') + '</div>';
  }

  // 其它工具:摘要行 + 点开展开入参/输出(与 TUI 的通用卡片一致)
  let body = '';
  if (input && (typeof input !== 'object' || Object.keys(input).length)) {
    body += '<pre>' + esc(typeof input === 'string' ? input : JSON.stringify(input, null, 2)) + '</pre>';
  }
  if (Array.isArray(st.content)) {
    const txt = st.content.map((c) => (c && c.text) || '').join('\n').trim();
    if (txt) body += '<pre>' + esc(txt) + '</pre>';
  }
  const sum = inputSummary(input);
  const desc = sum ? '→ ' + sum : '';
  if (!body) return '<div class="toolrow">' + toolHead(p, s, desc) + '</div>';
  return toolCard(p, s, desc, null, body, false);
}

// 用户消息上的提及标记:agent(@)与 skill(#)。H 组 5 补的,延续终端风
// (不加气泡,只用色条 + 标记);附件在 H 组 6 一起补。
function userRefsHtml(m) {
  const out = [];
  for (const a of m.agents || []) {
    const name = a && (a.name || a.id);
    if (name) out.push('<span class="ref ref-agent" title="智能体">@' + esc(name) + '</span>');
  }
  for (const s of m.skills || []) {
    const name = s && (s.name || s.id);
    if (name) out.push('<span class="ref ref-skill" title="技能">#' + esc(name) + '</span>');
  }
  return out.length ? '<div class="refs">' + out.join('') + '</div>' : '';
}

// base64 的字节数(服务端不回 size,自己按填充算)
function b64Size(data) {
  const s = String(data || '');
  if (!s) return 0;
  let n = Math.floor((s.length * 3) / 4);
  if (s.endsWith('==')) n -= 2;
  else if (s.endsWith('=')) n -= 1;
  return n > 0 ? n : 0;
}

// 用户消息里的附件(H 组 6)。消息里的形状是 { data(base64), mime, source, name },
// data/mime 是服务端读文件时补的;source.type==='uri' 时把来源路径也显示出来,
// 便于确认到底带了哪个文件。图片直接给缩略图(data: URL)。
function userFilesHtml(m) {
  const files = Array.isArray(m.files) ? m.files : [];
  const out = [];
  for (const f of files) {
    if (!f) continue;
    const src = f.source && f.source.type === 'uri' ? f.source.uri : '';
    const name = f.name || baseName(src) || '附件';
    const mime = f.mime || '';
    const size = b64Size(f.data);
    const meta = [mime, size ? humanSize(size) : ''].filter(Boolean).join(' · ');
    const isImg = /^image\//.test(mime) && f.data;
    out.push(
      '<div class="att">' +
        '<span class="att-name">📎 ' + esc(name) + '</span>' +
        (meta ? '<span class="att-meta">' + esc(meta) + '</span>' : '') +
        (src ? '<span class="att-src">' + esc(src) + '</span>' : '') +
        '</div>' +
        (isImg ? '<img class="att-img" alt="' + esc(name) + '" src="data:' + esc(mime) + ';base64,' + String(f.data) + '">' : '')
    );
  }
  return out.length ? '<div class="atts">' + out.join('') + '</div>' : '';
}

function renderMessage(m, opts) {
  opts = opts || {};
  const el = document.createElement('div');
  el.className = 'msg ' + m.type + (m.live ? ' live' : '');

  if (m.type === 'user') {
    el.innerHTML =
      '<div class="turn-head"><span class="marker">❯</span><span class="who">你</span></div>' +
      '<div class="content">' + esc(m.text || '') + '</div>' +
      userRefsHtml(m) +
      userFilesHtml(m);
    return el;
  }

  if (m.type === 'assistant') {
    const content = m.content || [];
    // 流式时光标落在最后一个文本/思考块上
    let lastBlock = -1;
    for (let i = 0; i < content.length; i++) {
      const q = content[i];
      if (q.type === 'text' || q.type === 'reasoning') lastBlock = i;
    }
    let nText = 0;
    let nReason = 0;
    let html =
      '<div class="turn-head"><span class="marker">⏺</span>' +
      '<span class="who">助手</span>' +
      (opts.showModel && m.model && m.model.id
        ? '<span class="model">' + esc(m.model.id) + '</span>'
        : '') +
      (m.live ? '<span class="live-tag">输出中</span>' : '') +
      '</div>';
    for (let i = 0; i < content.length; i++) {
      const p = content[i];
      const isLast = i === lastBlock;
      // data-lk 让增量重绘定位到对应节点;data-lk-last 标记光标落在哪一块
      const lk = m.live
        ? ' data-lk="' + p.type + ':' + (p.type === 'text' ? nText : nReason) + '"' +
          ' data-lk-last="' + (isLast ? '1' : '0') + '"' +
          ' data-lk-key="' + (p.text || '').length + ':0"'
        : '';
      const body = md(p.text || '');
      const shown = m.live && isLast ? cursorInto(body) : body;
      if (p.type === 'text') {
        nText++;
        html += '<div class="content"' + lk + '>' + shown + '</div>';
      } else if (p.type === 'reasoning') {
        nReason++;
        // 流式期间展开思考块,回合结束后仍回落成折叠态(与服务端版本一致)
        html +=
          '<details class="reasoning"' + (m.live ? ' open' : '') + '><summary>思考</summary>' +
          '<div class="content"' + lk + '>' + shown + '</div></details>';
      } else if (p.type === 'tool') {
        html += toolHtml(p);
      }
    }
    if (m.tokens) {
      html +=
        '<div class="meta">' + esc(fmtTokens(m.tokens)) + ' tokens' +
        (m.cost ? ' · ' + esc(fmtCost(m.cost)) : '') +
        (m.live ? ' · 流式中' : '') +
        '</div>';
    }
    el.innerHTML = html;
    return el;
  }

  if (m.type === 'idle') return el; // 占位,不显示

  el.className = 'msg minor';
  el.textContent = '· ' + m.type + (m.text ? ': ' + m.text : '');
  return el;
}

const msgEls = new Map(); // message id -> { sig, el }

function renderMessages() {
  const box = $('#messages');
  const msgs = Array.from(store.messages.values());
  // 本地流式缓冲里已有、但服务端消息列表还没出现的助手消息,补进渲染列表
  for (const [id, L] of store.live) {
    if (L.sid !== store.selected) continue;
    if (!liveView(id)) continue;
    if (store.messages.has(id)) continue;
    msgs.push(liveMessage(L));
  }
  msgs.sort((a, b) => ((a.time && a.time.created) || 0) - ((b.time && b.time.created) || 0));
  const force = store.forceBottom;
  store.forceBottom = false;
  const pending = store.restoreScroll; // 待还原的滚动锚点:有它就不许跳到底
  const nearBottom = !pending && (force || box.scrollHeight - box.scrollTop - box.clientHeight < 80);

  // 删除已不存在的消息(live 缓冲里的消息不算「不存在」)
  for (const [id, rec] of msgEls) {
    if (!store.messages.has(id) && !liveView(id)) {
      rec.el.remove();
      msgEls.delete(id);
    }
  }

  // 增量渲染:仅重建变化的消息,其余复用 DOM(保留已展开的 details)
  let prev = null;
  let prevModel = null;
  for (const m of msgs) {
    const L = liveView(m.id);
    const view = L ? liveMessage(L) : m;
    const showModel =
      view.type === 'assistant' && !!(view.model && view.model.id) && view.model.id !== prevModel;
    if (view.type === 'assistant' && view.model && view.model.id) prevModel = view.model.id;
    // 流式消息用结构指纹做签名(不含文本长度),文本增量走 paintLiveText 局部重绘
    const liveFp = L ? liveSig(L) : '';
    const sig = (L ? 'live|' + liveFp : JSON.stringify(view)) + '|' + (showModel ? '1' : '0');
    let rec = msgEls.get(m.id);
    if (!rec) {
      rec = { sig: sig, fp: liveFp, el: renderMessage(view, { showModel }) };
      msgEls.set(m.id, rec);
    } else if (rec.sig !== sig) {
      const el = renderMessage(view, { showModel });
      rec.el.replaceWith(el);
      rec.el = el;
      rec.sig = sig;
      rec.fp = liveFp;
    } else {
      rec.fp = liveFp;
      if (L) paintLiveText(rec.el, L);
    }
    const anchor = prev ? prev.nextSibling : box.firstChild;
    if (rec.el !== anchor) box.insertBefore(rec.el, anchor);
    prev = rec.el;
  }

  if (pending && msgs.length) {
    store.restoreScroll = null; // 消费掉:只在这次渲染还原一次
    applyScrollAnchor(pending);
  } else if (nearBottom) {
    box.scrollTop = box.scrollHeight;
  }
  $('#older').hidden = !store.msgOlderCursor;

  const last = msgs[msgs.length - 1];
  if (last && last.type === 'idle') store.pending = false;
  const streaming = !!(last && last.type === 'assistant' && last.time && !last.time.completed);
  store.running = store.pending || streaming || !!liveForSid(store.selected);
  updateChatStatus();
}

/* ------------------- 运行中的状态条(TUI 同款) ------------------- */

const PBAR_CELLS = 8;
const PBAR_FRAMES = 14;
const PBAR_MS = 90;

/* 第 i 帧里哪些格子是实心的。这张表就是 TUI 实测到的 14 帧:
 *   0-5   从左边长出来,1 格长到 6 格
 *   6-12  整段往右滑出去,同时从 6 格缩到 1 格
 *   13    空一拍(整条都是 ⬝)
 * 然后回到第 0 帧。TUI 是 8 格、14 帧一循环,这里逐帧照搬。 */
function progressCells(i) {
  const n = ((i % PBAR_FRAMES) + PBAR_FRAMES) % PBAR_FRAMES;
  const on = [];
  for (let k = 0; k < PBAR_CELLS; k++) on.push(false);
  if (n < 6) {
    for (let k = 0; k <= n; k++) on[k] = true;
  } else if (n < 13) {
    const lo = n - 5;
    for (let k = lo; k <= Math.min(lo + 5, PBAR_CELLS - 1); k++) on[k] = true;
  }
  return on;
}

let pbarTimer = null;
let pbarFrame = 0;

function drawProgressFrame() {
  const el = $('#progress');
  if (!el) return;
  const cells = el.querySelectorAll('.pbar i');
  const on = progressCells(pbarFrame++);
  for (let k = 0; k < cells.length; k++) cells[k].classList.toggle('on', !!on[k]);
}

/* 只由 updateChatStatus() 调 —— 和状态文字共用同一个同步点。
 * mode:false=收起,'run'=正常,'retry'=换琥珀色。
 * 已经在走的时候【不重开】,否则每来一个 SSE 事件都会跳回第 0 帧、看着像卡住。 */
function paintProgressBar(mode) {
  const el = $('#progress');
  if (!el) return; // 测试页可能没这个元素,缺了也不能崩
  if (!mode) {
    if (pbarTimer) { clearInterval(pbarTimer); pbarTimer = null; }
    pbarFrame = 0;
    el.hidden = true;
    el.classList.remove('retry'); // 收起来的时候不留模式痕迹
    return;
  }
  el.hidden = false;
  el.classList.toggle('retry', mode === 'retry');
  if (pbarTimer) return;
  pbarFrame = 0;
  drawProgressFrame();
  // 【一律逐帧推】,不看 prefers-reduced-motion:这条是照 TUI 抄的,终端里没有「减少动画」
  // 这个概念。原先这里给晕动的人让路(钉在中途一格不动),结果系统里「动画效果=关」的电脑上
  // 看到的是一条死掉的状态条,而同一份页面在手机上正常 —— 那条让步已经删掉。
  pbarTimer = setInterval(drawProgressFrame, PBAR_MS);
}

function updateChatStatus() {
  const el = $('#chatState');
  // 文字状态与状态条一起画:两者永远同步,不会各写各的。
  // 第三个参数三态:false=收起,'run'=在跑,'retry'=重试中。
  const paint = (text, cls, bar) => {
    el.textContent = text;
    el.className = cls;
    paintProgressBar(bar);
  };
  if (!store.selected) {
    paint('', 'state', false);
    updateComposerControls();
    return;
  }
  const st = runStatus(store.selected);
  if (st === 'retry') {
    paint('◌ 重试中', 'state retry', 'retry');
  } else if (st || store.running) {
    paint('● 运行中', 'state running', 'run');
  } else {
    paint('空闲', 'state', false);
  }
  updateComposerControls();
}

/* ----------------------------- 问询(表单 / 权限) ----------------------------- */

function askKey(kind, id) {
  return kind + ':' + id;
}

function askCountFor(sid) {
  let n = 0;
  for (const a of store.asks.values()) if (a.sessionID === sid) n++;
  return n;
}

function setAsk(kind, data) {
  if (!data || !data.id) return;
  const key = askKey(kind, data.id);
  const prev = store.asks.get(key);
  store.asks.set(key, {
    kind,
    id: data.id,
    sessionID: data.sessionID,
    data,
    busy: false,
    error: null,
  });
  if (!prev || store.selected === data.sessionID) renderAsks();
  renderSessions();
}

function dropAsk(kind, id) {
  if (!id) return;
  if (store.asks.delete(askKey(kind, id))) {
    renderAsks();
    renderSessions();
  }
}

function dropAsksFor(sid) {
  for (const [key, a] of Array.from(store.asks)) {
    if (a.sessionID === sid) store.asks.delete(key);
  }
}

/* SSE 事件 → 维护待处理问询 */
function handleAskEvent(e) {
  const d = e.data || {};
  if (e.type === 'form.created' && d.form) {
    setAsk('form', d.form);
  } else if (e.type === 'form.replied' || e.type === 'form.cancelled') {
    dropAsk('form', d.id);
  } else if (e.type === 'permission.asked') {
    setAsk('permission', d);
  } else if (e.type === 'permission.replied' || e.type === 'permission.rejected') {
    dropAsk('permission', d.requestID || d.id);
  }
}

/* 打开会话时兜底拉取(避免错过事件) */
async function loadAsks(sid) {
  if (!sid) return;
  let forms = [];
  let perms = [];
  try {
    const r = await api('/api/session/' + encodeURIComponent(sid) + '/form');
    forms = (r && r.data) || [];
  } catch (err) {
    console.warn('loadAsks form', err);
  }
  try {
    const r = await api('/api/session/' + encodeURIComponent(sid) + '/permission');
    perms = (r && r.data) || [];
  } catch (err) {
    console.warn('loadAsks permission', err);
  }
  dropAsksFor(sid);
  for (const x of forms) {
    if (x.state && x.state.status !== 'pending') continue;
    store.asks.set(askKey('form', x.id), {
      kind: 'form',
      id: x.id,
      sessionID: x.sessionID || sid,
      data: x,
      busy: false,
      error: null,
    });
  }
  for (const x of perms) {
    store.asks.set(askKey('permission', x.id), {
      kind: 'permission',
      id: x.id,
      sessionID: x.sessionID || sid,
      data: x,
      busy: false,
      error: null,
    });
  }
  renderAsks();
  renderSessions();
}

/* ----------------------------- 问询渲染 ----------------------------- */

function renderAsks() {
  const box = $('#asks');
  if (!box) return;
  const sid = store.selected;
  const items = sid
    ? Array.from(store.asks.values()).filter((a) => a.sessionID === sid)
    : [];
  box.hidden = items.length === 0;
  box.innerHTML = '';
  for (const a of items) {
    box.appendChild(a.kind === 'form' ? formCard(a) : permCard(a));
  }
}

function fldLabel(f) {
  return f.title || (f.type === 'external' ? f.url : f.key);
}

/* 仅允许 http(s) 作为可点击链接,其余按纯文本显示 */
function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
}

/* 与服务端 fI()/uc()/ac() 等价的条件求值:when 全部满足才算"激活" */
function fldActive(f, values) {
  if (!f.when || !f.when.length) return true;
  return f.when.every((c) => {
    const v = values[c.key];
    if (v === undefined) return false;
    const eq = Array.isArray(v) ? v.some((x) => x === c.value) : v === c.value;
    return c.op === 'eq' ? eq : !eq;
  });
}

function fldOptsHtml(f) {
  const def = Array.isArray(f.default) ? f.default : [];
  const single = f.maxItems === 1;
  return (f.options || [])
    .map((o, i) => {
      const id = 'o_' + f.key + '_' + i;
      return (
        '<label class="opt" for="' + esc(id) + '">' +
        '<input type="' + (single ? 'radio' : 'checkbox') + '" id="' + esc(id) +
        '" name="g_' + esc(f.key) + '" value="' + esc(o.value) + '"' +
        (def.indexOf(o.value) >= 0 ? ' checked' : '') + '>' +
        '<span class="opt-body"><span class="opt-label">' + esc(o.label || o.value) + '</span>' +
        (o.description ? '<span class="opt-desc">' + esc(o.description) + '</span>' : '') +
        '</span></label>'
      );
    })
    .join('');
}

function fldCtlHtml(f) {
  if (f.type === 'multiselect') {
    let out = '<div class="opts">' + fldOptsHtml(f) + '</div>';
    if (f.custom) {
      const d = typeof f.default === 'string' ? f.default : '';
      out +=
        '<input class="custom" type="text" placeholder="其它(自填)…"' +
        (d ? ' value="' + esc(d) + '"' : '') + '>';
    }
    return out;
  }
  if (f.type === 'external') {
    const url = safeUrl(f.url);
    return (
      (url
        ? '<a class="ext" href="' + esc(url) + '" target="_blank" rel="noopener">打开授权页面 ↗</a>'
        : '<span class="ext">' + esc(f.url || '') + '</span>') +
      '<label class="opt"><input type="checkbox"><span class="opt-body">' +
      '<span class="opt-label">我已完成授权</span></span></label>'
    );
  }
  if (f.type === 'boolean') {
    return (
      '<label class="opt"><input type="checkbox"' + (f.default === true ? ' checked' : '') + '>' +
      '<span class="opt-body"><span class="opt-label">' + esc(fldLabel(f)) + '</span></span></label>'
    );
  }
  const ph = f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '';
  if (f.type === 'number' || f.type === 'integer') {
    return (
      '<input type="number"' +
      (f.default !== undefined ? ' value="' + esc(f.default) + '"' : '') +
      (f.minimum !== undefined ? ' min="' + esc(f.minimum) + '"' : '') +
      (f.maximum !== undefined ? ' max="' + esc(f.maximum) + '"' : '') +
      (f.type === 'integer' ? ' step="1"' : ' step="any"') +
      ph + '>'
    );
  }
  /* string:可能带 options(custom=false 必须选;custom=true 可选可填) */
  const val = typeof f.default === 'string' ? f.default : '';
  const valueAttr = val ? ' value="' + esc(val) + '"' : '';
  if (f.options && f.options.length) {
    if (f.custom === true) {
      return (
        '<input type="text" list="dl_' + esc(f.key) + '"' + valueAttr + ph + '>' +
        '<datalist id="dl_' + esc(f.key) + '">' +
        f.options
          .map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label || o.value) + '</option>')
          .join('') +
        '</datalist>'
      );
    }
    return (
      '<select>' +
      '<option value="">— 请选择 —</option>' +
      f.options
        .map(
          (o) =>
            '<option value="' + esc(o.value) + '"' +
            (val && val === o.value ? ' selected' : '') + '>' +
            esc(o.label || o.value) + '</option>'
        )
        .join('') +
      '</select>'
    );
  }
  const t =
    f.format === 'email'
      ? 'email'
      : f.format === 'uri'
      ? 'url'
      : f.format === 'date'
      ? 'date'
      : f.format === 'date-time'
      ? 'datetime-local'
      : 'text';
  return '<input type="' + t + '"' + valueAttr + ph + '>';
}

function fieldHtml(f, idx) {
  const req = f.required ? ' <span class="req">*</span>' : '';
  const desc = f.description ? '<div class="fld-desc">' + esc(f.description) + '</div>' : '';
  const open = '<div class="ask-field" data-idx="' + idx + '">';
  if (f.type === 'boolean') return open + fldCtlHtml(f) + desc + '</div>';
  return (
    open +
    '<div class="fld-title">' + esc(fldLabel(f)) + req + '</div>' +
    desc +
    fldCtlHtml(f) +
    '</div>'
  );
}

/* 条件字段联动:重新计算每个字段的 when 可见性 */
function refreshFields(el) {
  const fields = el.__fields || [];
  const raw = readFieldValues(el);
  el.querySelectorAll('.ask-field').forEach((w) => {
    const fld = fields[Number(w.dataset.idx)];
    if (fld) w.hidden = !fldActive(fld, raw);
  });
}

function formCard(a) {
  const f = a.data || {};
  const fields = f.fields || [];
  const el = document.createElement('div');
  el.className = 'ask ask-form';
  el.__fields = fields;
  let html =
    '<div class="ask-head"><span class="ask-icon">❓</span>' +
    esc(f.title || '需要你的选择') + '</div>';
  html += '<div class="ask-body">';
  fields.forEach((fld, i) => (html += fieldHtml(fld, i)));
  html += '</div>';
  html +=
    '<div class="ask-foot">' +
    '<button class="ask-submit">提交</button>' +
    '<button class="ask-cancel">取消</button>' +
    '<span class="ask-err"' + (a.error ? '' : ' hidden') + '>' + esc(a.error || '') + '</span>' +
    '</div>';
  el.innerHTML = html;

  el.addEventListener('input', () => refreshFields(el));
  el.addEventListener('change', () => refreshFields(el));

  /* 单选 + 自填:二者互斥(question 工具的单选即 maxItems=1 + custom) */
  el.querySelectorAll('.ask-field').forEach((w) => {
    const fld = fields[Number(w.dataset.idx)];
    const custom = w.querySelector('input.custom');
    if (!fld || fld.type !== 'multiselect' || !custom || fld.maxItems !== 1) return;
    w.querySelectorAll('input[type=radio]').forEach((r) =>
      r.addEventListener('change', () => {
        if (r.checked) custom.value = '';
      })
    );
    custom.addEventListener('input', () => {
      if (custom.value.trim())
        w.querySelectorAll('input[type=radio]').forEach((r) => (r.checked = false));
    });
  });

  el.querySelector('.ask-submit').addEventListener('click', () => submitForm(a, el));
  el.querySelector('.ask-cancel').addEventListener('click', () => cancelForm(a, el));
  refreshFields(el);
  if (a.busy) setCardBusy(el, true);
  return el;
}

function permCard(a) {
  const r = a.data || {};
  const el = document.createElement('div');
  el.className = 'ask ask-perm';
  const src = r.source && r.source.type === 'tool' ? r.source : null;
  const res = Array.isArray(r.resources) ? r.resources : [];
  let html =
    '<div class="ask-head"><span class="ask-icon">🔐</span>工具请求授权' +
    (src && src.id ? ' <span class="perm-tool">' + esc(src.id) + '</span>' : '') +
    '</div>';
  html += '<div class="ask-body">';
  if (r.action) html += '<div class="perm-act">' + esc(r.action) + '</div>';
  if (res.length) {
    html +=
      '<div class="perm-res">' +
      res.map((x) => '<code>' + esc(x) + '</code>').join(' ') +
      '</div>';
  }
  if (r.message) html += '<div class="fld-desc">' + esc(r.message) + '</div>';
  html += '</div>';
  html +=
    '<div class="ask-foot">' +
    '<button class="ask-allow">允许一次</button>' +
    '<button class="ask-always">总是允许</button>' +
    '<button class="ask-deny danger">拒绝</button>' +
    '<span class="ask-err"' + (a.error ? '' : ' hidden') + '>' + esc(a.error || '') + '</span>' +
    '</div>';
  el.innerHTML = html;
  el.querySelector('.ask-allow').addEventListener('click', () => replyPerm(a, 'once', el));
  el.querySelector('.ask-always').addEventListener('click', () => replyPerm(a, 'always', el));
  el.querySelector('.ask-deny').addEventListener('click', () => replyPerm(a, 'reject', el));
  if (a.busy) setCardBusy(el, true);
  return el;
}

/* ----------------------------- 问询提交 ----------------------------- */

function readFieldValues(el) {
  const fields = el.__fields || [];
  const vals = {};
  el.querySelectorAll('.ask-field').forEach((w) => {
    const fld = fields[Number(w.dataset.idx)];
    if (!fld) return;
    const v = readFieldValue(w, fld);
    if (v !== undefined) vals[fld.key] = v;
  });
  return vals;
}

function readFieldValue(w, f) {
  if (f.type === 'boolean') {
    const cb = w.querySelector('input[type=checkbox]');
    return !!(cb && cb.checked);
  }
  if (f.type === 'external') {
    const cb = w.querySelector('input[type=checkbox]');
    return cb && cb.checked ? true : undefined;
  }
  if (f.type === 'multiselect') {
    const arr = Array.from(
      w.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked')
    ).map((i) => i.value);
    const custom = w.querySelector('input.custom');
    if (custom && custom.value.trim()) {
      const t = custom.value.trim();
      if (f.maxItems === 1) return [t];
      if (arr.indexOf(t) < 0) arr.push(t);
    }
    return arr.length ? arr : undefined;
  }
  const inp = w.querySelector('input, select, textarea');
  if (!inp) return undefined;
  const raw = String(inp.value).trim();
  if (raw === '') return undefined;
  return f.type === 'number' || f.type === 'integer' ? Number(raw) : raw;
}

/* 组装答案:排除未激活字段(否则服务端 fI() 会拒绝) */
function collectFormAnswer(el) {
  const fields = el.__fields || [];
  const raw = readFieldValues(el);
  const answer = {};
  for (const fld of fields) {
    if (fld.type === 'external') {
      if (raw[fld.key] === true) answer[fld.key] = true;
      continue;
    }
    if (!fldActive(fld, raw)) continue;
    const v = raw[fld.key];
    if (v !== undefined) answer[fld.key] = v;
  }
  return answer;
}

/* 与 TUI 的 Bu() 对齐的本地字段校验 */
function validateField(f, v) {
  if (f.required && (v === '' || (Array.isArray(v) && v.length === 0)))
    return f.type === 'multiselect' ? '请至少选择一项' : '此项必填';
  if (f.type === 'string') {
    if (typeof v !== 'string') return '应为文本';
    if (f.minLength !== undefined && v.length < f.minLength) return '至少 ' + f.minLength + ' 个字符';
    if (f.maxLength !== undefined && v.length > f.maxLength) return '最多 ' + f.maxLength + ' 个字符';
    if (f.pattern !== undefined) {
      try {
        if (!new RegExp(f.pattern).test(v)) return '需匹配 ' + f.pattern;
      } catch (_) {
        return '模式无效';
      }
    }
    if (f.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return '请输入邮箱地址';
    if (f.format === 'uri') {
      try {
        new URL(v);
      } catch (_) {
        return '请输入 URL';
      }
    }
    if (f.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '日期格式 YYYY-MM-DD';
    if (f.format === 'date-time' && Number.isNaN(new Date(v).getTime())) return '请输入日期时间';
    if (f.options && !f.custom && !f.options.some((o) => o.value === v)) return '请选择可选值';
    return null;
  }
  if (f.type === 'number' || f.type === 'integer') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '应为数字';
    if (f.type === 'integer' && !Number.isInteger(v)) return '应为整数';
    if (f.minimum !== undefined && v < f.minimum) return '不得小于 ' + f.minimum;
    if (f.maximum !== undefined && v > f.maximum) return '不得大于 ' + f.maximum;
    return null;
  }
  if (f.type === 'multiselect') {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return '应为选项数组';
    if (f.minItems !== undefined && v.length < f.minItems) return '至少选 ' + f.minItems + ' 项';
    if (f.maxItems !== undefined && v.length > f.maxItems) return '最多选 ' + f.maxItems + ' 项';
    if (f.options && !f.custom) {
      const bad = v.find((x) => !f.options.some((o) => o.value === x));
      if (bad) return '不可选项:' + bad;
    }
    return null;
  }
  return null;
}

function validateAnswer(el) {
  const fields = el.__fields || [];
  const raw = readFieldValues(el);
  for (const fld of fields) {
    if (fld.type === 'external') {
      if (raw[fld.key] !== true) return '请先打开授权页面并勾选"我已完成授权"';
      continue;
    }
    if (!fldActive(fld, raw)) continue;
    const v = raw[fld.key];
    if (v === undefined) {
      if (fld.required)
        return fldLabel(fld) + ':' + (fld.type === 'multiselect' ? '请至少选择一项' : '此项必填');
      continue;
    }
    const err = validateField(fld, v);
    if (err) return fldLabel(fld) + ':' + err;
  }
  return null;
}

function setCardBusy(el, on) {
  el.querySelectorAll('button').forEach((b) => (b.disabled = on));
}

function setCardError(el, msg) {
  const s = el.querySelector('.ask-err');
  if (!s) return;
  s.textContent = msg || '';
  s.hidden = !msg;
}

async function submitForm(a, el) {
  if (a.busy) return;
  const err = validateAnswer(el);
  if (err) {
    a.error = err;
    setCardError(el, err);
    return;
  }
  a.busy = true;
  a.error = null;
  setCardError(el, '');
  setCardBusy(el, true);
  try {
    await api(
      '/api/session/' + encodeURIComponent(a.sessionID) + '/form/' +
        encodeURIComponent(a.id) + '/reply',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: collectFormAnswer(el) }),
      }
    );
    dropAsk('form', a.id);
  } catch (e) {
    if (e.status === 404 || e.status === 409) return dropAsk('form', a.id); // 已被别处应答/取消
    a.busy = false;
    a.error = e.message;
    setCardBusy(el, false);
    setCardError(el, '提交失败:' + e.message);
  }
}

async function cancelForm(a, el) {
  if (a.busy) return;
  a.busy = true;
  a.error = null;
  setCardError(el, '');
  setCardBusy(el, true);
  try {
    await api(
      '/api/session/' + encodeURIComponent(a.sessionID) + '/form/' +
        encodeURIComponent(a.id) + '?message=' + encodeURIComponent('用户在面板取消'),
      { method: 'DELETE' }
    );
    dropAsk('form', a.id);
  } catch (e) {
    if (e.status === 404 || e.status === 409) return dropAsk('form', a.id);
    a.busy = false;
    setCardBusy(el, false);
    setCardError(el, '取消失败:' + e.message);
  }
}

async function replyPerm(a, decision, el) {
  if (a.busy) return;
  a.busy = true;
  a.error = null;
  setCardError(el, '');
  setCardBusy(el, true);
  try {
    await api(
      '/api/session/' + encodeURIComponent(a.sessionID) + '/permission/' +
        encodeURIComponent(a.id) + '/reply',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      }
    );
    dropAsk('permission', a.id);
  } catch (e) {
    if (e.status === 404 || e.status === 409) return dropAsk('permission', a.id);
    a.busy = false;
    setCardBusy(el, false);
    setCardError(el, '应答失败:' + e.message);
  }
}

/* ----------------------------- 操作 ----------------------------- */

async function guard(fn) {
  try {
    await fn();
  } catch (e) {
    alert('操作失败:' + e.message);
  }
}

async function onAction(act, id) {
  const s = store.sessions.get(id);
  if (act === 'open') return selectSession(id);

  // 窄屏:列表行右侧只留一个「⋯」,把这几项收进通用的选择框(桌面那排按钮照旧)
  if (act === 'more') {
    if (!s) return;
    const arch = isArchived(s);
    openPick({
      title: s.title || '(无标题)',
      items: [
        { key: 'open', label: '打开' },
        { key: 'rename', label: '改名' },
        { key: 'move', label: '移动' },
        { key: 'fork', label: '分叉' },
        { key: 'archive', label: arch ? '取消归档' : '归档' },
        { key: 'del', label: '删除' },
      ],
      onPick: (it) => onAction(it.key, id),
    });
    return;
  }

  if (act === 'rename') {
    const t = prompt('新的标题', (s && s.title) || '');
    if (t == null) return;
    await guard(() =>
      api('/api/session/' + id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: t }),
      })
    );
    if (s) s.title = t;
    renderSessions();
    if (store.selected === id) $('#chatTitle').textContent = t;
    return;
  }

  if (act === 'del') {
    if (!confirm('确定删除该会话?此操作不可撤销。')) return;
    await guard(() => api('/api/session/' + id, { method: 'DELETE' }));
    store.sessions.delete(id);
    if (store.selected === id) clearSelection();
    renderSessions();
    return;
  }

  if (act === 'move') {
    const d = prompt('移动到目录(绝对路径)', (s && s.location && s.location.directory) || '');
    if (!d) return;
    await guard(() =>
      api('/api/session/' + id + '/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory: d }),
      })
    );
    if (s) s.location = { directory: d };
    store.seenDirs.add(d);
    renderSessions();
    return;
  }

  if (act === 'archive') {
    await toggleArchive(id);
    return;
  }

  if (act === 'fork') {
    await guard(() =>
      api('/api/session/' + id + '/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    await loadSessions({ reset: true });
    return;
  }
}

/* --------- 文件附件(H 组 6)---------
 * 服务端 prompt 的 files[].uri 必须是 **file: URI**(裸路径 / https 都会被拒),
 * 而文件内容是服务端【自己】读的(读回消息时才带上 data(base64) 与 mime)。
 * 于是两条路都归结成「一个 file: URI」:
 *   A) 正文里的 @路径 —— 补全数据来自 GET /api/fs/find(与 TUI 同源,给的是相对工程目录的路径),
 *      选中后把「相对路径 → 绝对路径」记进 mentionHits;发送时把仍在正文里的 @路径 变成
 *      files[] + mention(start/end/text 锚在提示词里的位置)。
 *   B) 选择 / 拖放 / 粘贴的文件 —— 浏览器手里没有服务端路径,先 POST /api/experimental/fs/write
 *      把字节落到暂存目录(路径由 /__health 告知),再把返回的绝对路径当 uri。
 *      这样代理层不用新增任何上传端点,写盘交给 OpenCode 自己。
 * 只在发送成功后才清空待发送附件 —— 失败还能原样重发。
 */

const UPLOAD_MAX = 32 * 1024 * 1024; // 单个附件上限
const MENTION_LIMIT = 12; // @ 补全一次最多列几条

function fileURI(abs) {
  return 'file://' + String(abs == null ? '' : abs);
}

function baseName(p) {
  const s = String(p == null ? '' : p);
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

function joinDir(dir, rel) {
  return String(dir == null ? '' : dir).replace(/\/+$/, '') + '/' + String(rel == null ? '' : rel).replace(/^\/+/, '');
}

function humanSize(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

// 上传文件名:去掉路径分隔与控制字符(前缀还有时间戳+随机串,不会撞名)。
// 刻意不复用导出用的 safeName —— 那个会把 `.txt` 的扩展名点也换成 '-',附件名就认不出来了。
function uploadName(name) {
  const s = String(name == null ? '' : name)
    .replace(/[/\\\u0000-\u001f\u007f]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (s || 'file').slice(0, 120);
}

function uploadPathFor(name, now, rand) {
  const dir = String(store.uploadDir || '').replace(/\/+$/, '');
  const stamp = now || Date.now();
  const r = rand || Math.random().toString(36).slice(2, 10);
  return dir + '/' + stamp + '-' + r + '-' + uploadName(name);
}

function sessionDir(sid) {
  const s = sid ? store.sessions.get(sid) : null;
  return (s && s.location && s.location.directory) || '';
}

/* 发送前解析正文里的 @ 引用。只认「补全里确认过」的条目:
 * 好处是永远不会发出一个不存在的文件(那会让 prompt 直接 400 整条失败);
 * 代价是手打一个没走过补全的 @路径 不会变成附件 —— 与 TUI 里「@ 是补全入口」是一致的。
 * 匹配方式:拿已确认的路径去正文里找(长路径优先),这样中文正文里紧跟标点也能认出来
 * (不能简单地按空格切:',再改' 这种没有空格)。 */
const MENTION_TAIL = /[\s，。,.、;:!?()[\]{}<>"'`*]/; // 路径后面允许紧跟的收尾字符

function resolveMentions(text) {
  const out = [];
  if (!text || !store.mentionHits.size) return out;
  const keys = Array.from(store.mentionHits.keys()).sort((a, b) => b.length - a.length);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    for (const k of keys) {
      if (!text.startsWith(k, i + 1)) continue;
      const after = text[i + 1 + k.length];
      if (after !== undefined && !MENTION_TAIL.test(after)) continue;
      out.push({
        uri: fileURI(store.mentionHits.get(k)),
        name: baseName(k),
        mention: { start: i, end: i + 1 + k.length, text: '@' + k },
      });
      break;
    }
  }
  return out;
}

/* ---- 待发送附件列表(输入框上方那排 chip)---- */

function renderAttachments() {
  const box = $('#attach');
  if (!box) return;
  const inp = $('#input');
  const refs = resolveMentions(inp ? inp.value : '');
  const files = store.attachments;
  box.hidden = !refs.length && !files.length;
  if (box.hidden) {
    box.innerHTML = '';
    syncComposerMeta(); // 收起时细边左侧那两句提示跟着一起变
    return;
  }
  let html = '';
  for (const r of refs) {
    html +=
      '<span class="achip ref" title="正文里的 @ 引用,发送时会作为文件一起带上(删掉正文里的那个 @ 即取消)">' +
      '<span class="achip-name">' + esc(r.name) + '</span>' +
      '<span class="achip-size">@ 引用</span></span>';
  }
  for (const a of files) {
    html +=
      '<span class="achip' + (a.busy ? ' busy' : '') + '" data-id="' + esc(a.id) + '" title="' +
      esc(a.path || a.name) + '">' +
      '<span class="achip-name">' + esc(a.name) + '</span>' +
      '<span class="achip-size">' + esc(a.busy ? '上传中…' : humanSize(a.size)) + '</span>' +
      '<button type="button" class="achip-x" data-remove="' + esc(a.id) + '" title="移除">×</button></span>';
  }
  box.innerHTML = html;
  syncComposerMeta(); // 收起时「📎 n」跟着一起变
}

function clearAttachments() {
  store.attachments = [];
  renderAttachments();
}

function removeAttachment(id) {
  store.attachments = store.attachments.filter((a) => a.id !== id);
  renderAttachments();
}

// 暂存目录来自 /__health;没拿到就问一次(不然刚打开页面就拖文件会失败)
async function ensureUploadDir() {
  if (store.uploadDir) return store.uploadDir;
  const j = await api('/__health');
  if (j && j.uploadDir) store.uploadDir = j.uploadDir;
  if (!store.uploadDir) throw new Error('服务端没有给出附件暂存目录');
  return store.uploadDir;
}

async function uploadFile(file) {
  await ensureUploadDir();
  const want = uploadPathFor(file.name);
  const r = await fetch('/api/experimental/fs/write?' + new URLSearchParams({ path: want }).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const txt = await r.text();
  let j = null;
  try {
    j = JSON.parse(txt);
  } catch (_) {}
  if (!r.ok) throw new Error((j && (j.message || j.error)) || 'HTTP ' + r.status);
  const abs = (j && j.data && j.data.path) || want;
  return { path: abs, uri: fileURI(abs) };
}

async function queueFiles(list) {
  const picked = Array.prototype.slice.call(list || []);
  if (!picked.length || !store.selected) return;
  let failed = 0;
  for (const f of picked) {
    if ((f.size || 0) > UPLOAD_MAX) {
      flash('「' + (f.name || '文件') + '」太大(' + humanSize(f.size) + '),单个上限 ' + humanSize(UPLOAD_MAX), 'bad');
      failed++;
      continue;
    }
    const item = {
      id: 'att' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: f.name || 'file',
      size: f.size || 0,
      mime: f.type || '',
      path: '',
      uri: '',
      busy: true,
    };
    store.attachments.push(item);
    renderAttachments();
    try {
      const up = await uploadFile(f);
      item.path = up.path;
      item.uri = up.uri;
      item.busy = false;
    } catch (e) {
      store.attachments = store.attachments.filter((a) => a !== item);
      flash('上传「' + item.name + '」失败:' + e.message, 'bad');
      failed++;
    }
    renderAttachments();
  }
  if (failed) updateComposerControls();
}

/* ---- @ 文件补全(GET /api/fs/find,与 TUI 同源)---- */

// 光标前最后一个 @token → 它在输入框里的 [start, end) 与查询词
function mentionQuery() {
  const el = $('#input');
  if (!el) return null;
  const caret = el.selectionStart == null ? el.value.length : el.selectionStart;
  const before = el.value.slice(0, caret);
  const m = /@([^\s@]{0,200})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[0].length, end: caret, query: m[1] };
}

function closeMentions() {
  const box = $('#mentions');
  if (box) {
    box.hidden = true;
    box.innerHTML = '';
  }
  store.mentionItems = [];
  store.mentionAt = -1;
  store.mentionRange = null;
}

function renderMentions() {
  const box = $('#mentions');
  if (!box) return;
  if (!store.mentionItems.length) {
    box.innerHTML = '<div class="mention-empty">没有匹配的文件</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = store.mentionItems
    .map((it, i) => {
      const cut = it.path.lastIndexOf('/');
      const dir = cut < 0 ? '' : it.path.slice(0, cut + 1);
      const name = cut < 0 ? it.path : it.path.slice(cut + 1);
      return (
        '<div class="mention-item' + (i === store.mentionAt ? ' active' : '') + '" role="option" data-i="' + i + '">' +
        '<span class="mi-path"><span class="mi-dir">' + esc(dir) + '</span><span class="mi-name">' + esc(name) + '</span></span>' +
        (it.type === 'directory' ? '<span class="mi-dir">目录</span>' : '') +
        '</div>'
      );
    })
    .join('');
  box.hidden = false;
  const act = box.querySelector('.mention-item.active');
  if (act && act.scrollIntoView) {
    try {
      act.scrollIntoView({ block: 'nearest' });
    } catch (_) {}
  }
}

let mentionTimer = null;

async function openMentions() {
  const tok = mentionQuery();
  if (!tok || !store.selected) return closeMentions();
  const params = new URLSearchParams({ query: tok.query, type: 'file', limit: String(MENTION_LIMIT) });
  const dir = sessionDir(store.selected);
  if (dir) params.set('location[directory]', dir);
  let j;
  try {
    j = await api('/api/fs/find?' + params.toString());
  } catch (_) {
    return closeMentions();
  }
  if (!j || !Array.isArray(j.data)) return closeMentions();
  const now = mentionQuery();
  if (!now || now.start !== tok.start) return; // 期间又敲了键,等下一次
  const at = (j.location && j.location.directory) || dir || '';
  // 绝对路径用【服务端返回的 location】拼 —— 它才是这一批相对路径的基准
  store.mentionItems = j.data.map((e) => ({ path: e.path, type: e.type, abs: joinDir(at, e.path) }));
  store.mentionRange = { start: tok.start, end: tok.end };
  store.mentionAt = store.mentionItems.length ? 0 : -1;
  renderMentions();
}

function acceptMention(i) {
  const idx = i == null ? store.mentionAt : i;
  const it = store.mentionItems[idx];
  const range = store.mentionRange;
  const el = $('#input');
  if (!it || !range || !el) return;
  const inserted = '@' + it.path + ' ';
  el.value = el.value.slice(0, range.start) + inserted + el.value.slice(range.end);
  const caret = range.start + inserted.length;
  if (el.setSelectionRange) el.setSelectionRange(caret, caret);
  store.mentionHits.set(it.path, it.abs); // 记住「补全确认过」的绝对路径
  closeMentions();
  el.focus();
  renderAttachments();
}

// 补全列表开着时,把方向键/Enter/Tab/Esc 抢过来;返回 true 表示已消费
function mentionKey(e) {
  const box = $('#mentions');
  if (!box || box.hidden || !store.mentionItems.length) return false;
  const n = store.mentionItems.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    store.mentionAt = (store.mentionAt + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderMentions();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    acceptMention();
    return true;
  }
  if (e.key === 'Escape') {
    // 标记「已消费」:全局 Esc 处理器据此不再往下走(否则会顺手把回合中断掉)
    if (e.preventDefault) e.preventDefault();
    closeMentions();
    return true;
  }
  return false;
}

function setupAttachments() {
  const pick = $('#filePick');
  const btn = $('#btnAttach');
  const box = $('#attach');
  const inp = $('#input');
  const set = $('#mentions');
  const comp = $('#composer');

  if (btn && pick) {
    btn.addEventListener('click', () => pick.click());
  }
  if (pick) {
    pick.addEventListener('change', () => {
      queueFiles(pick.files);
      pick.value = ''; // 允许连续选同一个文件
    });
  }
  if (box) {
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove]');
      if (b) removeAttachment(b.dataset.remove);
    });
  }
  if (set) {
    set.addEventListener('click', (e) => {
      const it = e.target.closest('.mention-item');
      if (it) acceptMention(Number(it.dataset.i));
    });
  }
  const cmdBox = $('#cmds');
  if (cmdBox) {
    cmdBox.addEventListener('click', (e) => {
      const it = e.target.closest('.mention-item');
      if (it) acceptCommand(Number(it.dataset.i));
    });
  }
  if (inp) {
    inp.addEventListener('input', () => {
      renderAttachments();
      clearTimeout(mentionTimer);
      // 行首敲 / 走命令面板,否则才看 @ 文件补全
      mentionTimer = setTimeout(() => {
        if (cmdQuery()) {
          closeMentions();
          openCommands();
        } else {
          openMentions();
        }
      }, 120);
    });
    // 粘贴:截图 / 复制的文件直接进待发送列表(普通文本照旧)
    inp.addEventListener('paste', (e) => {
      const f = e.clipboardData && e.clipboardData.files;
      if (f && f.length) queueFiles(f);
      // 这里刻意不调 expandComposer():收起时输入框是 display:none,粘贴根本落不到它身上。
      // 「收起后还能往里塞东西」的只有拖放,那条挂在下面 #composer 的 drop 上。
    });
  }
  if (comp) {
    // 拖放:必须拦 dragover 才有 drop
    comp.addEventListener('dragover', (e) => {
      if (!store.selected) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    comp.addEventListener('drop', (e) => {
      if (!store.selected) return;
      e.preventDefault();
      expandComposer(); // 收起时拖文件进来,顺手把底板拉开(点手柄那一步省了)
      queueFiles(e.dataTransfer && e.dataTransfer.files);
    });
  }
}

/* ================= I 组:命令面板(与 TUI 的 / 命令一致)与 TUI 键位 ================= */

const CMD_LIMIT = 12;
const HISTORY_LIMIT = 50;

// TUI 里是内置动作、但服务端没有对应 command 接口的,由面板映射到已有动作/接口。
// 与服务端命令同名时以服务端为准(见 mergedCommands)。
const PANEL_COMMANDS = [
  { name: 'new', description: '新建会话', run: () => openNew() },
  { name: 'compact', description: '压缩当前会话的上下文', run: (sid) => runCompact(sid) },
  { name: 'interrupt', description: '中断当前正在执行的回合', run: () => interrupt() },
  { name: 'undo', description: '撤销到最后一条用户消息(含该轮文件改动)', run: (sid) => runUndo(sid) },
  { name: 'redo', description: '重做:清除已暂存的撤销', run: (sid) => runRedo(sid) },
  { name: 'rename', description: '重命名当前会话', run: (sid) => onAction('rename', sid) },
  { name: 'delete', description: '删除当前会话(需确认)', run: (sid) => onAction('del', sid) },
  { name: 'export', description: '导出当前会话为 JSON', run: () => openExport() },
  { name: 'archive', description: '归档 / 取消归档当前会话', run: (sid) => toggleArchive(sid) },
  { name: 'tui', description: '在 TUI 中打开当前会话', run: () => openTui() },
  { name: 'copy', description: '复制「在 TUI 打开」的命令', run: () => copyTui() },
  { name: 'sessions', description: '切换会话(列表选择)', run: () => openSessionPick() },
  { name: 'models', description: '选择模型(含推理档位)', run: () => openModelPick() },
  { name: 'agents', description: '选择智能体', run: () => openAgentPick() },
  { name: 'clear', description: '清空输入框(TUI prompt.clear)', run: () => clearInput() },
  { name: 'help', description: '命令与快捷键', run: () => openHelp() },
];

const HELP_KEYS = [
  { sec: '命令' },
  { k: '/', d: '输入框里敲 / 打开命令面板' },
  { k: 'Ctrl+P', d: '随时打开命令面板(对应 TUI command.palette.show)' },
  { k: '↑ / ↓', d: '面板里移动;光标在首行/末行时取输入历史' },
  { k: 'Enter / Tab', d: '选中面板项' },
  { sec: '会话' },
  { k: 'Esc', d: '关命令面板 → 关 @ 补全 → 中断当前回合(对应 TUI session.interrupt)' },
  { k: 'Shift+Tab', d: '切换到下一个智能体(对应 TUI agent.cycle)' },
  { k: 'Enter', d: '发送(Shift+Enter 换行)' },
  { k: '@', d: '补全工程内的文件' },
];

function clearInput() {
  const el = $('#input');
  if (el) el.value = '';
  closeCommands();
  closeMentions();
  renderAttachments();
}

function openHelp() {
  const box = $('#helpKeys');
  if (box) {
    // 小节标题自己跨满两列;不要再补空格子,否则后面每一行都会整体错一格
    box.innerHTML = HELP_KEYS.map((r) =>
      r.sec
        ? '<div class="keys-sec">' + esc(r.sec) + '</div>'
        : '<kbd>' + esc(r.k) + '</kbd><div>' + esc(r.d) + '</div>'
    ).join('');
  }
  openDlg($('#dlgHelp'));
}

function commandsOpen() {
  const b = $('#cmds');
  return !!b && !b.hidden;
}

function mentionsOpen() {
  const b = $('#mentions');
  return !!b && !b.hidden;
}

/* ================= 选择框对话框(/models · /agents · /sessions) =================
 * 这三条命令在 TUI 里都是「弹出列表让你选」。此前面板只是把焦点丢给工具栏里的原生
 * <select> —— 浏览器不会因为 focus() 就展开它,所以看起来什么都没发生。这里用一个
 * 通用选择框把它们统一成 TUI 那种「列表 + ↑/↓ + Enter」。
 */

function picksOpen() {
  const d = $('#dlgPick');
  return !!d && d.open === true;
}

// 过滤后真正显示的条目(↑/↓ 在它里面走,所以 pickAt 是它的下标)
function pickVisible() {
  const q = (store.pickFilter || '').trim().toLowerCase();
  if (!q) return store.pickItems;
  return store.pickItems.filter(
    (it) => ((it.label || '') + ' ' + (it.sub || '')).toLowerCase().indexOf(q) >= 0
  );
}

function renderPick() {
  const box = $('#pickList');
  if (!box) return;
  store.pickShown = pickVisible();
  if (store.pickAt >= store.pickShown.length) store.pickAt = store.pickShown.length - 1;
  if (store.pickAt < 0 && store.pickShown.length) store.pickAt = 0;
  let html = '';
  let lastGroup = null;
  if (!store.pickShown.length) {
    html = '<div class="pick-empty">没有匹配项</div>';
  }
  store.pickShown.forEach((it, i) => {
    if (it.group && it.group !== lastGroup) {
      html += '<div class="pick-group">' + esc(it.group) + '</div>';
      lastGroup = it.group;
    }
    html +=
      '<div class="pick-item' + (i === store.pickAt ? ' active' : '') + (it.disabled ? ' disabled' : '') +
      '" role="option" data-i="' + i + '">' +
      '<span class="pi-label">' + esc(it.label || '') + '</span>' +
      (it.sub ? '<span class="pi-sub">' + esc(it.sub) + '</span>' : '') +
      '</div>';
  });
  box.innerHTML = html;
  const act = box.querySelector('.pick-item.active');
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
}

// 打开选择框:items = [{ key, label, sub?, group?, disabled? }];current 的那项默认高亮。
function openPick(opts) {
  const dlg = $('#dlgPick');
  if (!dlg) return;
  store.pickItems = opts.items || [];
  store.pickOnPick = opts.onPick || null;
  store.pickFilter = '';
  const cur = (opts.items || []).findIndex((it) => it.key === opts.current);
  store.pickAt = cur >= 0 ? cur : 0;
  const t = $('#pickTitle');
  if (t) t.textContent = opts.title || '选择';
  const f = $('#pickFilter');
  if (f) {
    f.hidden = !opts.filter;
    f.value = '';
    f.placeholder = opts.filterHint || '过滤…';
  }
  renderPick();
  openDlg(dlg);
  // 有过滤框就先把光标放进去(直接打字即过滤);没有就把焦点放列表上,↑/↓ 立刻可用
  if (f && opts.filter) f.focus();
  else if ($('#pickList')) $('#pickList').focus();
}

function closePick() {
  closeDlg($('#dlgPick'));
}

// 选中一项:先关框再回调,免得回调里又弹一个选择框(选模型 → 再选变体)时打架
function pickChoose(it) {
  if (!it || it.disabled) return;
  const fn = store.pickOnPick;
  closePick();
  if (fn) fn(it);
}

// 选择框里的键位:↑/↓ 环绕、Enter 选中(Esc 交给 <dialog> 自己关)
function pickKey(e) {
  if (!picksOpen()) return false;
  if (e.target && e.target.closest && e.target.closest('button')) return false; // 别抢「关闭」按钮的 Enter
  const stop = () => {
    if (e.preventDefault) e.preventDefault();
  };
  const n = store.pickShown.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!n) return false;
    stop();
    const d = e.key === 'ArrowDown' ? 1 : -1;
    store.pickAt = (store.pickAt + d + n) % n;
    renderPick();
    return true;
  }
  if (e.key === 'Enter') {
    if (!n) return false;
    stop();
    pickChoose(store.pickShown[store.pickAt]);
    return true;
  }
  return false;
}

function setupPick() {
  const dlg = $('#dlgPick');
  if (!dlg) return;
  const f = $('#pickFilter');
  if (f) {
    f.addEventListener('input', () => {
      store.pickFilter = f.value;
      store.pickAt = 0; // 换了查询词就回到第一条
      renderPick();
    });
    // 过滤框里的 ↑/↓ 不需要单独接线:keydown 会冒泡到 #dlgPick,由下面那个处理器统一接
  }
  const box = $('#pickList');
  if (box) {
    box.addEventListener('click', (e) => {
      const it = e.target.closest('.pick-item');
      if (!it) return;
      pickChoose(store.pickShown[Number(it.dataset.i)]);
    });
  }
  dlg.addEventListener('keydown', pickKey);
  // 关掉之后焦点回输入框(TUI 里也是回到提示框),这样能接着打字
  dlg.addEventListener('close', () => {
    const i = $('#input');
    if (i) i.focus();
  });
}

/* ---------------------- 三条命令各自把数据装配成 items ---------------------- */

// /sessions:列的就是左栏那批(同一筛选、同一排序),选中即切过去
function openSessionPick() {
  const items = visibleSessions().map((s) => ({
    key: s.id,
    label: s.title || '(无标题)',
    sub: [
      dirBase((s.location && s.location.directory) || ''),
      rel(s.time && s.time.updated),
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  openPick({
    title: '切换会话',
    filter: true,
    filterHint: '按标题过滤…',
    current: store.selected,
    items,
    onPick: (it) => selectSession(it.key),
  });
}

// /models:按 provider 分组;选定后再追问一次变体(模型有 variants 时),与 TUI 一致
async function openModelPick() {
  const s = store.sessions.get(store.selected);
  if (!s) return;
  const dir = (s.location && s.location.directory) || '';
  const models = await loadModels(dir);
  const cur = modelKey(s.model);
  const items = models.map((m) => ({
    key: m.providerID + '/' + m.modelID,
    label: m.name || m.modelID,
    sub: m.modelID,
    group: m.providerID,
    // loadModels 已经把 enabled === false 的滤掉了(与工具栏那个下拉一致),
    // 这里照样标一下,是防它哪天改了过滤规则
    disabled: m.enabled === false,
  }));
  if (cur && !items.some((it) => it.key === cur)) {
    items.unshift({ key: cur, label: cur, sub: '当前', disabled: false });
  }
  openPick({
    title: '选择模型',
    filter: true,
    filterHint: '按名字或 modelID 过滤…',
    current: cur,
    items,
    onPick: (it) => pickVariant(it.key),
  });
}

async function pickVariant(key) {
  const info = store.modelIndex.get(key);
  const variants = (info && info.variants) || [];
  if (!variants.length) return applyModel(key, '');
  const s = store.sessions.get(store.selected);
  const cur = s && modelKey(s.model) === key ? (s.model && s.model.variant) || '' : '';
  openPick({
    title: '选择变体 · ' + ((info && (info.name || info.modelID)) || key),
    filter: false,
    current: cur,
    items: [{ key: '', label: '默认', sub: '' }].concat(
      variants.map((v) => ({ key: v.id, label: v.id, sub: '' }))
    ),
    onPick: (it) => applyModel(key, it.key),
  });
}

// /agents:loadAgents 已滤掉 hidden 与 subagent,所以列出来的就是能切的那些
async function openAgentPick() {
  const s = store.sessions.get(store.selected);
  if (!s) return;
  const dir = (s.location && s.location.directory) || '';
  const agents = await loadAgents(dir);
  const cur = s.agent || '';
  const items = agents.map((a) => ({ key: a.id, label: a.name || a.id, sub: a.id }));
  if (cur && !items.some((it) => it.key === cur)) {
    items.unshift({ key: cur, label: cur, sub: '当前', disabled: false });
  }
  openPick({
    title: '选择智能体',
    filter: false,
    current: cur,
    items,
    onPick: (it) => switchAgent(it.key),
  });
}

// 光标前最后一个 /token(必须在行首)→ 它在输入框里的 [start, end) 与查询词。
// 嵌套命令名里本来就带 /(如 team/review),所以查询词允许再出现 /。
function cmdQuery() {
  const el = $('#input');
  if (!el) return null;
  const caret = el.selectionStart == null ? el.value.length : el.selectionStart;
  const before = el.value.slice(0, caret);
  const m = /(^|\n)\/([^\s]{0,120})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, end: caret, query: m[2] };
}

function closeCommands() {
  const box = $('#cmds');
  if (box) {
    box.hidden = true;
    box.innerHTML = '';
  }
  store.cmdItems = [];
  store.cmdAt = -1;
  store.cmdRange = null;
}

// 服务端命令 + 面板动作;同名时服务端优先
function mergedCommands(dir) {
  const srv = (store.commands.get(dir) || []).map((c) => ({
    name: c.name,
    description: c.description || '',
    panel: false,
  }));
  const taken = new Set(srv.map((c) => c.name));
  const panel = PANEL_COMMANDS.filter((c) => !taken.has(c.name)).map((c) => ({
    name: c.name,
    description: c.description,
    panel: true,
  }));
  return srv.concat(panel);
}

// 只拉一次,按工程目录缓存(命令是随工程走的)
async function loadCommands(dir) {
  if (!dir) return [];
  if (store.commands.has(dir)) return store.commands.get(dir);
  let j = null;
  try {
    j = await api('/api/command?' + new URLSearchParams({ 'location[directory]': dir }).toString());
  } catch (_) {
    return [];
  }
  const list = j && Array.isArray(j.data) ? j.data : [];
  store.commands.set(dir, list);
  return list;
}

function renderCommands() {
  const box = $('#cmds');
  if (!box) return;
  if (!store.cmdItems.length) {
    box.innerHTML = '<div class="mention-empty">没有匹配的命令</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = store.cmdItems
    .map((it, i) =>
      '<div class="cmd-item mention-item' + (i === store.cmdAt ? ' active' : '') + '" role="option" data-i="' + i + '">' +
      '<span class="mi-path"><span class="mi-name">/' + esc(it.name) + '</span></span>' +
      (it.description ? '<span class="mi-dir">' + esc(it.description) + '</span>' : '') +
      (it.panel ? '<span class="cmd-tag">面板</span>' : '') +
      '</div>'
    )
    .join('');
  box.hidden = false;
  const act = box.querySelector('.mention-item.active');
  if (act && act.scrollIntoView) {
    try {
      act.scrollIntoView({ block: 'nearest' });
    } catch (_) {}
  }
}

let cmdTimer = null;

// force=true 用于 Ctrl+P(输入框非空也开)
async function openCommands(opts) {
  opts = opts || {};
  const el = $('#input');
  const sid = store.selected;
  if (!el || !sid) return closeCommands();
  const tok = cmdQuery();
  if (!tok && !opts.force) return closeCommands();
  const dir = sessionDir(sid);
  await loadCommands(dir);
  if (store.selected !== sid) return; // 期间切了会话
  const caret = el.selectionStart == null ? el.value.length : el.selectionStart;
  if (tok) {
    const now = cmdQuery();
    if (!now || now.start !== tok.start || now.end !== caret) return; // 期间又敲了键,等下一次
  }
  const range = tok ? { start: tok.start, end: tok.end } : { start: caret, end: caret };
  const q = (tok ? tok.query : '').toLowerCase();
  const hits = mergedCommands(dir).filter((c) => !q || c.name.toLowerCase().includes(q));
  // 前缀命中的排前面,其余按名字
  hits.sort((a, b) => {
    const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    return pa - pb || a.name.localeCompare(b.name);
  });
  store.cmdItems = hits.slice(0, CMD_LIMIT);
  store.cmdRange = range;
  store.cmdAt = store.cmdItems.length ? 0 : -1;
  renderCommands();
}

function findCommand(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  return mergedCommands(sessionDir(store.selected)).find((c) => c.name.toLowerCase() === n) || null;
}

function acceptCommand(i) {
  const idx = i == null ? store.cmdAt : i;
  const it = store.cmdItems[idx];
  const range = store.cmdRange;
  const el = $('#input');
  if (!it || !range || !el) {
    closeCommands();
    return null;
  }
  const inserted = '/' + it.name + ' ';
  el.value = el.value.slice(0, range.start) + inserted + el.value.slice(range.end);
  const caret = range.start + inserted.length;
  if (el.setSelectionRange) el.setSelectionRange(caret, caret);
  closeCommands();
  el.focus();
  renderAttachments();
  return it;
}

/* 输入框里已经把命令名整个敲完了(后面没有参数)→ Enter 直接执行,不用再按一次。
 * 只敲了前缀时 Enter 仍然只是补全,免得把「想接着打参数」误判成执行。 */
function exactCommand() {
  const el = $('#input');
  const it = store.cmdItems[store.cmdAt];
  if (!el || !it) return false;
  return el.value.trim() === '/' + it.name;
}

// 面板开着时,把方向键/Enter/Tab/Esc 抢过来;返回 true 表示已消费
function commandKey(e) {
  const box = $('#cmds');
  if (!box || box.hidden || !store.cmdItems.length) return false;
  const n = store.cmdItems.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    store.cmdAt = (store.cmdAt + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderCommands();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (e.preventDefault) e.preventDefault();
    if (e.key === 'Enter' && exactCommand()) {
      closeCommands();
      send();
      return true;
    }
    acceptCommand();
    return true;
  }
  if (e.key === 'Escape') {
    if (e.preventDefault) e.preventDefault();
    closeCommands();
    return true;
  }
  return false;
}

/* ---------------------------- 输入历史(↑/↓) ---------------------------- */

function pushHistory(sid, text) {
  const t = String(text || '');
  if (!sid || !t) return;
  const arr = store.history.get(sid) || [];
  if (arr[arr.length - 1] !== t) arr.push(t); // 连续重复只记一次
  while (arr.length > HISTORY_LIMIT) arr.shift();
  store.history.set(sid, arr);
  store.histAt = -1;
  store.histDraft = '';
}

// 只在光标处于首行(↑)/末行(↓)时接管;否则让光标在文本里照常移动
function historyKey(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
  const el = $('#input');
  if (!el) return false;
  const arr = store.history.get(store.selected) || [];
  if (!arr.length) return false;
  const up = e.key === 'ArrowUp';
  if (!up && store.histAt < 0) return false;
  const caret = el.selectionStart == null ? el.value.length : el.selectionStart;
  const atTop = el.value.slice(0, caret).indexOf('\n') < 0;
  const atBottom = el.value.slice(caret).indexOf('\n') < 0;
  if (up ? !atTop : !atBottom) return false;

  if (up && store.histAt < 0) {
    store.histDraft = el.value; // 记住草稿,↓ 能退回来
    store.histAt = 0;
  } else {
    const next = up ? store.histAt + 1 : store.histAt - 1;
    if (next >= arr.length) return true; // 已到最旧一条:吞掉按键,不动
    store.histAt = next;
  }
  const text = store.histAt < 0 ? store.histDraft : arr[arr.length - 1 - store.histAt];
  if (el.value !== text) {
    el.value = text;
    if (el.setSelectionRange) el.setSelectionRange(text.length, text.length);
    renderAttachments();
  }
  return true;
}

/* ---------------------------- 面板动作类命令 ---------------------------- */

async function runCompact(sid) {
  try {
    await api('/api/session/' + enc(sid) + '/compact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    flash('已请求压缩上下文', 'ok');
    loadInbox(sid);
    loadActive();
  } catch (e) {
    flash('压缩失败:' + e.message, 'bad');
  }
}

function lastUserMessageID() {
  let best = null;
  for (const m of store.messages.values()) {
    if (!m || m.type !== 'user') continue;
    if (!best || ((m.time && m.time.created) || 0) >= ((best.time && best.time.created) || 0)) best = m;
  }
  return best ? best.id : '';
}

async function runUndo(sid) {
  if (isRunning(sid) || store.running) {
    flash('会话正在运行,先中断或等它结束再撤销', 'warn');
    return;
  }
  let mid = lastUserMessageID();
  if (!mid) {
    await loadMessages({ older: false });
    mid = lastUserMessageID();
  }
  if (!mid) {
    flash('没有可撤销的用户消息', 'warn');
    return;
  }
  if (!confirm('撤销到最后一条用户消息?这会回退对话边界并还原该轮的文件改动。')) return;
  try {
    await api('/api/session/' + enc(sid) + '/revert/stage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: mid, files: true }),
    });
    flash('已撤销到该消息', 'ok');
    loadMessages({ older: false });
  } catch (e) {
    if (e.status === 409) flash('会话正忙,暂不能撤销', 'warn');
    else flash('撤销失败:' + e.message, 'bad');
  }
}

async function runRedo(sid) {
  if (isRunning(sid) || store.running) {
    flash('会话正在运行,先中断或等它结束再重做', 'warn');
    return;
  }
  try {
    await api('/api/session/' + enc(sid) + '/revert', { method: 'DELETE' });
    flash('已清除撤销', 'ok');
    loadMessages({ older: false });
  } catch (e) {
    // 409 = 当前没有已暂存的撤销,不是错误(TUI 里同样是个空操作)
    if (e.status === 409) flash('没有可重做的撤销', 'warn');
    else flash('重做失败:' + e.message, 'bad');
  }
}

// 正文以 / 开头、且命中命令表 → 走命令通道(未命中一律当普通消息,不会静默失败)
function parseCommand(text) {
  const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  const cmd = findCommand(m[1]);
  if (!cmd) return null;
  return { name: cmd.name, args: m[2] || '', cmd: cmd };
}

// 返回 true 表示这条「命令」被真正执行(调用方据此清理输入与附件)
async function runCommand(parsed, sid, files, busy) {
  pushHistory(sid, '/' + parsed.name + (parsed.args ? ' ' + parsed.args : ''));
  if (parsed.cmd.panel) {
    const def = PANEL_COMMANDS.find((p) => p.name === parsed.name);
    if (def) await def.run(sid, parsed.args);
    return true;
  }
  const body = { name: parsed.name, text: parsed.args };
  if (files && files.length) body.files = files;
  if (busy) body.delivery = store.delivery;
  try {
    await api('/api/session/' + enc(sid) + '/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    flash('已执行 /' + parsed.name, 'ok');
  } catch (e) {
    flash('命令失败:' + e.message, 'bad');
    return false;
  }
  return true;
}

// 输入框内的按键优先级:命令面板 → @ 补全 → 输入历史 → 发送
function setupComposerKeys() {
  const inp = $('#input');
  if (!inp) return;
  inp.addEventListener('keydown', (e) => {
    if (commandKey(e)) return; // 命令面板开着时优先吃方向键/Enter/Tab/Esc
    if (mentionKey(e)) return; // 补全列表开着时,方向键/Enter/Tab/Esc 先给补全
    if (historyKey(e)) return; // 光标在首行/末行时,↑/↓ 取输入历史
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
}

/* ---------------------------- TUI 键位 ---------------------------- */

function anyDialogOpen() {
  return !!document.querySelector('dialog[open]');
}

async function cycleAgent() {
  const sel = $('#agentSel');
  if (!sel || !sel.options.length) return;
  const ids = Array.from(sel.options)
    .map((o) => o.value)
    .filter((v) => v); // 「默认」是空值,服务端不允许置空,跳过它
  if (!ids.length) return;
  const cur = ids.indexOf(sel.value);
  const next = ids[(cur + 1) % ids.length];
  sel.value = next;
  await switchAgent(next);
}

// Esc 的优先级:命令面板 → @ 补全 → 中断(TUI:session.interrupt = escape,一按即断)
function setupTuiKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (anyDialogOpen()) return; // <dialog> 自己处理 Esc
      if (commandsOpen()) {
        e.preventDefault();
        closeCommands();
        return;
      }
      if (mentionsOpen()) {
        e.preventDefault();
        closeMentions();
        return;
      }
      const sid = store.selected;
      if (sid && isRunning(sid)) {
        e.preventDefault();
        interrupt();
      }
      return;
    }
    if (e.key === 'p' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (anyDialogOpen()) return;
      e.preventDefault();
      openCommands({ force: true });
      return;
    }
    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (anyDialogOpen() || commandsOpen() || mentionsOpen()) return;
      e.preventDefault();
      cycleAgent();
    }
  });
}

async function send() {
  const text = $('#input').value.trim();
  if (!text || !store.selected) return;
  const sid = store.selected;
  const busy = isRunning(sid) || store.running;
  const willQueue = busy && store.delivery === 'queue';
  // 附件 = 已上传的文件 + 正文里确认过的 @ 引用
  const files = store.attachments
    .filter((a) => a.uri)
    .map((a) => ({ uri: a.uri, name: a.name }))
    .concat(resolveMentions(text));
  const body = { text };
  if (files.length) body.files = files;
  if (busy) body.delivery = store.delivery;

  // I 组:以 / 开头且命中命令表 → 走命令通道,不当作普通消息
  const parsed = parseCommand(text);
  if (parsed) {
    $('#input').value = '';
    closeCommands();
    closeMentions();
    renderAttachments();
    const ok = await runCommand(parsed, sid, files, busy);
    if (ok && !parsed.cmd.panel) {
      store.mentionHits.clear();
      clearAttachments(); // 服务端命令确实消费了附件,才清空
    }
    updateComposerControls();
    setTimeout(() => {
      loadMessages({ older: false });
      loadActive();
    }, 300);
    return;
  }

  $('#input').value = '';
  closeMentions();
  renderAttachments(); // 正文清了,@ 引用的 chip 也一起消失
  pushHistory(sid, text);
  store.pending = !willQueue;
  updateChatStatus();
  updateComposerControls();
  try {
    const j = await api('/api/session/' + enc(sid) + '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (willQueue || (j && j.data && j.data.delivery === 'queue')) {
      flash('已排队,当前回合结束后执行', 'ok');
      store.pending = false;
    }
    clearAttachments(); // 发送成功才清空(失败还能原样重发)
    store.mentionHits.clear();
  } catch (e) {
    alert('发送失败:' + e.message);
    store.pending = false;
    updateChatStatus();
    return;
  }
  loadInbox(sid);
  setTimeout(() => {
    loadMessages({ older: false });
    loadActive();
  }, 300);
}

/* ----------------------------- 逐 token 流式 ----------------------------- */
//
// 为什么需要本地缓冲:OpenCode 在流式过程中**不会**把半成品文本写进消息接口 ——
// parts 会随 step 出现,但 text 一直是空串,直到整段结束才一次性写入(实测)。
// 所以想要逐字显示,只能在会话里消费增量事件自己拼。
//
// 事件契约(实测 v2.0.28;一个 step = 一条助手消息,assistantMessageID 每 step 不同):
//   session.step.started        {assistantMessageID, agent, model, started}
//   session.reasoning.started   {assistantMessageID, ordinal}
//   session.reasoning.delta     {assistantMessageID, ordinal, delta}
//   session.reasoning.ended     {assistantMessageID, ordinal, text}   ← text 为权威全文
//   session.text.started|delta|ended   同上
//   session.tool.input.started  {assistantMessageID, id, name}
//   session.tool.input.delta    {assistantMessageID, id, delta}
//   session.tool.input.ended    {assistantMessageID, id, text}        ← 完整 JSON 参数
//   session.tool.called         {assistantMessageID, id, input}
//   session.tool.progress       {assistantMessageID, id, metadata}
//   session.tool.success        {assistantMessageID, id, content, metadata}
//   session.tool.failed         {assistantMessageID, id, ...}
//   session.step.ended          {assistantMessageID, finish, cost, tokens}
//   session.usage.updated       {sessionID, cost, tokens}
//
// 注意 `ordinal` 是「同一类型里的第几个」,不是 content 下标:
// 一条消息里 reasoning 与 text 的 ordinal 都会从 0 开始(实测 content=[reasoning, text] 时两者都是 0)。
//
// 对账策略:本地缓冲只在「服务端还没有权威完整版本」时覆盖渲染;
// 一旦服务端消息带上了 time.completed,就丢掉缓冲、回到服务端版本(它是权威)。

function liveRecord(id) {
  return store.live.get(id) || null;
}

function liveBlock(L, type, ordinal) {
  const key = type + ':' + ordinal;
  let p = L.byKey[key];
  if (!p) {
    p = { kind: 'block', type: type, ordinal: ordinal, text: '', final: false };
    L.byKey[key] = p;
    L.parts.push(p);
  }
  return p;
}

function liveTool(L, id) {
  const key = 'tool:' + id;
  let p = L.byKey[key];
  if (!p) {
    p = { kind: 'tool', id: id, name: '', state: { status: 'streaming' }, time: {} };
    L.byKey[key] = p;
    L.parts.push(p);
  }
  return p;
}

function liveStart(e) {
  const d = e.data || {};
  const id = d.assistantMessageID;
  if (!id) return null;
  let L = store.live.get(id);
  if (!L) {
    L = {
      id: id,
      sid: d.sessionID,
      started: d.started || Date.now(),
      agent: d.agent || null,
      model: d.model || null,
      parts: [],
      byKey: {},
      tokens: null,
      cost: null,
      finish: null,
      open: true,
    };
    store.live.set(id, L);
  }
  return L;
}

function liveForSid(sid) {
  for (const L of store.live.values()) {
    if (L.sid === sid && liveView(L.id)) return L;
  }
  return null;
}

// 服务端已有权威完整版本时返回 null,表示不再用本地缓冲覆盖
function liveView(id) {
  const L = store.live.get(id);
  if (!L) return null;
  const base = store.messages.get(id);
  if (base && base.time && base.time.completed) return null;
  return L;
}

// 纯文本增量:本地已经渲染,不需要再拉一次消息接口
function isStreamDelta(t) {
  return t === 'session.text.delta' || t === 'session.reasoning.delta';
}

// 会改动本地缓冲、需要立刻局部重绘的事件(含 *.ended:它用权威全文覆盖)
function isStreamLocal(t) {
  return (
    t === 'session.text.delta' || t === 'session.reasoning.delta' ||
    t === 'session.text.ended' || t === 'session.reasoning.ended'
  );
}

// 事件入口。返回 true 表示「结构变了」(新增 part / 工具状态变化),需要整条重绘;
// 返回 false 表示只是文本增量,交给 paintLiveDelta 做局部重绘。
function handleStreamEvent(e) {
  const t = e.type || '';
  const d = e.data || {};

  if (t.indexOf('session.text.') === 0 || t.indexOf('session.reasoning.') === 0) {
    const kind = t.indexOf('session.text.') === 0 ? 'text' : 'reasoning';
    const id = d.assistantMessageID;
    if (!id) return false;
    if (t === 'session.text.started' || t === 'session.reasoning.started') {
      const L = liveStart(e);
      if (!L) return false;
      liveBlock(L, kind, d.ordinal || 0);
      return true;
    }
    const L = store.live.get(id);
    if (!L) return false;
    const p = liveBlock(L, kind, d.ordinal || 0);
    if (t === 'session.text.delta' || t === 'session.reasoning.delta') {
      p.text += d.delta || '';
      return false;
    }
    if (t === 'session.text.ended' || t === 'session.reasoning.ended') {
      // *.ended 带权威全文(实测与增量累加逐字节一致),以它为准可兜住任何丢包
      if (typeof d.text === 'string') p.text = d.text;
      p.final = true;
      return false;
    }
    return false; // 未知的 session.text.* / session.reasoning.*,不认领
  }

  if (t.indexOf('session.tool.') === 0) {
    if (!d.assistantMessageID) return false;
    // 进度事件不改变结构,也不该凭空造出工具卡片
    if (t === 'session.tool.progress') {
      const L0 = store.live.get(d.assistantMessageID);
      const p0 = L0 && L0.byKey['tool:' + d.id];
      if (p0) p0.state.metadata = d.metadata || p0.state.metadata;
      return false;
    }
    const L = liveStart(e);
    if (!L) return false;
    const p = liveTool(L, d.id);
    if (t === 'session.tool.input.started') {
      p.name = d.name || p.name;
      p.state.status = 'streaming';
    } else if (t === 'session.tool.input.delta') {
      p.state.status = 'streaming';
    } else if (t === 'session.tool.input.ended') {
      p.name = d.name || p.name;
    } else if (t === 'session.tool.called') {
      p.state.status = 'running';
      p.state.input = d.input;
      p.time.ran = Date.now();
    } else if (t === 'session.tool.success') {
      p.state.status = 'completed';
      p.state.content = d.content;
      p.state.metadata = d.metadata;
      p.time.completed = Date.now();
    } else if (t === 'session.tool.failed') {
      p.state.status = 'error';
      if (d.error) p.state.error = d.error;
      p.time.completed = Date.now();
    }
    return true;
  }

  if (t === 'session.step.started') {
    return !!liveStart(e);
  }

  if (t === 'session.step.ended') {
    const L = store.live.get(d.assistantMessageID);
    if (L) {
      L.finish = d.finish || null;
      if (d.tokens) L.tokens = d.tokens;
      if (typeof d.cost === 'number') L.cost = d.cost;
    }
    return !!L;
  }

  if (t === 'session.usage.updated') {
    let any = false;
    for (const L of store.live.values()) {
      if (L.sid !== d.sessionID || !L.open) continue;
      if (d.tokens) L.tokens = d.tokens;
      if (typeof d.cost === 'number') L.cost = d.cost;
      any = true;
    }
    return any;
  }

  if (t.indexOf('session.execution.') === 0) {
    // 回合收束:缓冲标记为关闭(但仍显示,直到服务端给出权威版本)
    let any = false;
    for (const L of store.live.values()) {
      if (L.sid === d.sessionID) {
        L.open = false;
        any = true;
      }
    }
    return any;
  }

  return false;
}

// 把本地缓冲拼成渲染用的助手消息(结构与服务端 Session.Message.Info 对齐)
function liveMessage(L) {
  const base = store.messages.get(L.id) || {};
  return {
    id: L.id,
    type: 'assistant',
    agent: L.agent,
    model: L.model || base.model,
    time: base.time || { created: L.started },
    tokens: L.tokens || base.tokens,
    cost: L.cost != null ? L.cost : base.cost,
    content: L.parts.map((p) =>
      p.kind === 'tool'
        ? { type: 'tool', id: p.id, name: p.name, executed: false, state: p.state, time: p.time }
        : { type: p.type, text: p.text }
    ),
    live: true,
  };
}

// 结构指纹:刻意不含文本长度,这样纯文本增量不会触发整条重建
// 工具 metadata 的指纹:diff / 诊断会随 session.tool.progress 陆续到达,
// 状态没变但内容变了也必须触发重绘(见 handleEvent 里的指纹比对)。
function toolMetaSig(p) {
  const md = p.state && p.state.metadata;
  if (!md || typeof md !== 'object') return '';
  const files = Array.isArray(md.files) ? md.files : null;
  if (!files) return '';
  return files
    .map((f) =>
      (f && f.status) + ':' + ((f && f.additions) | 0) + ':' + ((f && f.deletions) | 0) +
      ':' + String((f && f.patch) || '').length
    )
    .join(',');
}

function liveSig(L) {
  return (
    L.parts
      .map((p) =>
        p.kind === 'tool'
          ? 't:' + p.id + ':' + ((p.state && p.state.status) || '') + ':' + toolMetaSig(p)
          : p.type + ':' + p.ordinal + ':' + (p.final ? 1 : 0)
      )
      .join(',') +
    '|' + (L.tokens ? 1 : 0) +
    '|' + (L.open ? 1 : 0) +
    '|' + (L.finish || '')
  );
}

// 把流式光标放进「最后一段内容」的行内末尾。
// 直接拼在 md() 结果后面会落在块级元素之外(如 </ol> 之后),于是单独占一行。
function cursorInto(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const blocks = tmp.querySelectorAll('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, td, th');
  const host = blocks.length ? blocks[blocks.length - 1] : tmp;
  const c = document.createElement('span');
  c.className = 'cursor';
  c.textContent = '▌';
  host.appendChild(c);
  return tmp.innerHTML;
}

// 纯文本增量:只重刷受影响的 block 节点,不重建整条消息、也不动其它消息
function paintLiveText(el, L) {
  let changed = false;
  for (const p of L.parts) {
    if (p.kind !== 'block') continue;
    const node = el.querySelector('[data-lk="' + p.type + ':' + p.ordinal + '"]');
    if (!node) continue;
    const key = p.text.length + ':' + (p.final ? 1 : 0);
    if (node.dataset.lkKey === key) continue;
    const body = md(p.text);
    node.innerHTML = node.dataset.lkLast === '1' ? cursorInto(body) : body;
    node.dataset.lkKey = key;
    changed = true;
  }
  return changed;
}

function paintLiveDelta() {
  const sid = store.selected;
  if (!sid) return;
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  let changed = false;
  let needFull = false;
  for (const [id, L] of store.live) {
    if (L.sid !== sid || !liveView(id)) continue;
    const rec = msgEls.get(id);
    if (!rec) {
      needFull = true;
      continue;
    }
    if (paintLiveText(rec.el, L)) changed = true;
  }
  if (needFull) {
    renderMessages();
    return;
  }
  if (changed) {
    if (nearBottom) box.scrollTop = box.scrollHeight;
    updateChatStatus();
  }
}

/* ----------------------------- 事件流 ----------------------------- */

let msgTimer = null;
let listTimer = null;
let activeTimer = null;

// 把局部变更合并进会话对象。事件里的 info 可能是扁平 directory(V1 形状),统一补出 location。
function patchSession(id, patch) {
  if (!id) return null;
  const merged = Object.assign({}, store.sessions.get(id) || { id: id }, patch);
  if (!merged.location && merged.directory) merged.location = { directory: merged.directory };
  store.sessions.set(id, merged);
  if (store.selected === id && ctrlKeyOf(merged) !== store.ctrlKey) renderControls(merged);
  return merged;
}

// 维护运行中集合:优先消费 session.status / session.idle,其余事件做兜底重取。
function handleControlEvent(e) {
  const t = e.type;
  const d = e.data || {};
  const sid = d.sessionID;
  let dirty = false;
  let refreshActive = false;

  if (t === 'session.status') {
    const st = (d.status && d.status.type) || null;
    if (sid) {
      if (st === 'busy' || st === 'retry') store.active.set(sid, st);
      else store.active.delete(sid);
      dirty = true;
    }
  } else if (t === 'session.idle') {
    if (sid) {
      store.active.delete(sid);
      dirty = true;
    }
  } else if (t.indexOf('session.execution.') === 0) {
    if (sid) {
      if (t === 'session.execution.started') store.active.set(sid, 'busy');
      else store.active.delete(sid);
      dirty = true;
    }
  } else if (t === 'session.renamed') {
    if (sid) {
      patchSession(sid, { title: d.title || '' });
      dirty = true;
    }
  } else if (t === 'session.agent.selected') {
    if (sid) {
      patchSession(sid, { agent: d.agent || null });
      dirty = true;
    }
  } else if (t === 'session.model.selected') {
    if (sid) {
      patchSession(sid, { model: d.model || null });
      dirty = true;
    }
  } else if (t === 'session.moved') {
    if (sid && e.location && e.location.directory) {
      patchSession(sid, { location: e.location });
      dirty = true;
    }
    refreshActive = true;
  } else if (t === 'session.updated') {
    // 该事件在不同版本里载荷不同:有的带完整 info,有的只有 sessionID
    const info = d.info;
    if (info && typeof info === 'object') {
      const merged = patchSession(info.id || sid, info);
      if (merged) dirty = true;
    } else {
      refreshActive = true;
    }
  } else if (t === 'session.deleted') {
    const info = d.info;
    const id = (info && info.id) || sid;
    if (id) {
      store.sessions.delete(id);
      store.active.delete(id);
      store.inbox.delete(id);
      for (const [mid, L] of store.live) if (L.sid === id) store.live.delete(mid);
      if (store.selected === id) clearSelection();
      dirty = true;
    }
    refreshActive = true;
  } else if (t === 'session.created') {
    refreshActive = true;
  } else if (t.indexOf('session.inbox.') === 0) {
    if (sid && sid === store.selected) loadInbox(sid);
    refreshActive = true;
  }

  if (refreshActive) {
    clearTimeout(activeTimer);
    activeTimer = setTimeout(loadActive, 200);
  }
  if (dirty) {
    renderSessions();
    updateChatStatus();
  }
}

// 单条事件的统一入口(独立出来便于测试,也让 setupEvents 更薄)
function handleEvent(e) {
  if (!e || !e.type) return;
  handleAskEvent(e);
  const structural = handleStreamEvent(e);
  handleControlEvent(e);
  const d = e.data || {};
  const L = d.assistantMessageID ? store.live.get(d.assistantMessageID) : null;
  // 有本地缓冲的文本事件才算「已经渲染过」;没有缓冲(例如中途接入时才收到 delta)
  // 就退回老的「事件触发重取」路径,不至于把内容漏掉。
  const local = isStreamLocal(e.type) && !!L;
  // 除了结构变化,「已渲染的指纹变了」也要整条重绘 —— session.tool.progress 会送来
  // diff / 诊断,这时状态没变、parts 也没变,只有 metadata 变了。
  const rec = L ? msgEls.get(L.id) : null;
  const repaint = structural || (!!L && !!rec && rec.fp !== liveSig(L));
  // 结构变化(新 part / 工具状态 / 元数据)立刻重绘;纯文本变化只刷局部节点
  if (repaint && liveForSid(store.selected)) renderMessages();
  else if (local) paintLiveDelta();
  // 纯文本增量本地已经渲染,不需要再拉一次消息;*.ended 与其它事件保持防抖对账
  if (!(local && isStreamDelta(e.type))) {
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      if (store.selected) loadMessages({ older: false });
    }, 150);
  }
  clearTimeout(listTimer);
  listTimer = setTimeout(() => loadSessions({}), 1500);
}

function setupEvents() {
  const es = new EventSource('/api/event');
  es.onmessage = (ev) => {
    let e = null;
    try {
      e = JSON.parse(ev.data);
    } catch (_) {}
    handleEvent(e);
  };
  es.onopen = () => health();
  es.onerror = () => {
    const el = $('#status');
    el.className = 'status bad';
    el.textContent = '事件流断开,重连中…';
  };
}

/* ----------------------------- 分栏拖拽 ----------------------------- */

function setupResizers() {
  const main = document.querySelector('main');
  const listPane = document.getElementById('listpane');
  const r2 = document.getElementById('resizer-mid');
  if (!main || !listPane || !r2) return;

  const savedList = parseInt(localStorage.getItem('ocs.listW') || localStorage.getItem('ocs.midW') || '', 10);
  if (savedList) main.style.setProperty('--list-w', savedList + 'px');

  function startDrag(e) {
    // 手柄是「折叠/展开」的按钮,按到它身上不算拖宽度
    if (e.target.closest && e.target.closest('.handle')) return;
    const handle = e.currentTarget;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    document.body.classList.add('resizing');

    const move = (ev) => {
      const mainRect = main.getBoundingClientRect();
      const start = listPane.getBoundingClientRect().left;
      let w = ev.clientX - start;
      const maxList = mainRect.width - 22 - 320;
      w = Math.max(280, Math.min(Math.max(280, maxList), w));
      main.style.setProperty('--list-w', w + 'px');
    };
    const end = () => {
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      localStorage.setItem('ocs.listW', Math.round(listPane.getBoundingClientRect().width));
      localStorage.removeItem('ocs.midW');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  r2.addEventListener('pointerdown', startDrag);
  r2.addEventListener('dblclick', (e) => {
    // 手柄上双击会顺带触发两次「折叠/展开」,别再叠一次复位宽度
    if (e.target.closest && e.target.closest('.handle')) return;
    main.style.removeProperty('--list-w');
    localStorage.removeItem('ocs.listW');
  });
}

/* 会话列表整列收起 / 展开。
 * 入口就是分栏条顶部那个手柄(#btnList 在 #resizer-mid 里):收起后分栏条本身
 * 会保留成一条 16px 窄槽,所以手柄不会跟着消失,列表随时能拉回来。
 * 收起状态记在 localStorage,与列宽 ocs.listW 并列。 */
function setupListToggle() {
  const main = document.querySelector('main');
  const btn = document.getElementById('btnList');
  if (!main || !btn) return;

  const paint = (hidden) => {
    main.classList.toggle('list-hidden', hidden);
    btn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    btn.setAttribute('aria-label', hidden ? '展开会话列表' : '收起会话列表');
    btn.title = hidden ? '展开会话列表(分栏条上拖动可改宽度)' : '收起会话列表(分栏条上拖动可改宽度)';
  };

  const stored = () => localStorage.getItem('ocs.listHidden') === '1';
  paint(stored());
  // 重复接线只重画(按当前存储),不重复挂监听 —— 否则点一下会触发两次、看起来没反应
  if (btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const next = !stored();
    if (next) localStorage.setItem('ocs.listHidden', '1');
    else localStorage.removeItem('ocs.listHidden');
    paint(next);
  });
}

/* ---------------------- 底板(输入区)收起 / 展开 ----------------------
 * 手机屏幕小,收起后只留一条细边(styles.css 的 #composer.collapsed),高度让给会话内容。
 *
 * 判定源仍然是 <html>.narrow 那一个类;记忆分两份,桌面与手机互不干扰:
 *   ocs.composerHidden        桌面
 *   ocs.composerHiddenNarrow  手机
 * 没记过时:桌面 = 展开(键盘打字是主要入口),手机 = 收起(屏幕小,先让出高度)。
 * 存 '1'/'0' 两种值而不是「有/无」—— 因为两档的默认值不一样,得能把
 * 「手机上显式展开过」与「手机上从没碰过」分开。
 */
const COMPOSER_KEY = 'ocs.composerHidden';
const COMPOSER_KEY_NARROW = 'ocs.composerHiddenNarrow';

function composerStoreKey() {
  return document.documentElement.classList.contains('narrow') ? COMPOSER_KEY_NARROW : COMPOSER_KEY;
}

/* 这一档现在该不该收起:记过就听记的,没记过就看是桌面还是手机。 */
function composerHidden() {
  const v = localStorage.getItem(composerStoreKey());
  if (v === '1') return true;
  if (v === '0') return false;
  return document.documentElement.classList.contains('narrow');
}

/* 收起时细边左侧还得交代两件容易被误会成「丢了」的事:
 * 输入框里的草稿、待发送的附件。不然字被收没了会以为没了。 */
function syncComposerMeta() {
  const el = $('#cstripMeta');
  if (!el) return;
  const inp = $('#input');
  const draft = !!(inp && inp.value.trim());
  const n = (store.attachments || []).length;
  const show = composerIsCollapsed() && (draft || n > 0);
  el.hidden = !show;
  if (!show) {
    el.innerHTML = '';
    return;
  }
  let html = '';
  if (n) html += '<span class="cm-badge" title="待发送的附件">📎 ' + n + '</span>';
  if (draft) html += '<span class="cm-badge" title="输入框里还有没发出去的草稿">● 草稿</span>';
  el.innerHTML = html;
}

/* 现在【实际】是不是收起的 —— 看渲染结果,不再重新推导一遍 */
function composerIsCollapsed() {
  const comp = $('#composer');
  return !!comp && comp.classList.contains('collapsed');
}

/* 按当前存储 / 当前断点画一次(只读,不写存储) */
function paintComposer() {
  const comp = $('#composer');
  const btn = $('#btnComposer');
  /* 手柄不在就【整个不收起】。收起之后唯一的出口就是那个手柄,没有它等于把底板锁死 ——
   * 新 app.js 配上还没更新的旧 index.html 时就是这个情形。 */
  if (!comp || !btn) return;
  const hidden = composerHidden();
  comp.classList.toggle('collapsed', hidden);
  btn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  btn.setAttribute('aria-label', hidden ? '展开输入区' : '收起输入区');
  btn.title = hidden ? '展开输入区(智能体 / 模型 / 附件 / 输入框)' : '收起输入区(只留一条细边)';
  btn.textContent = hidden ? '▴ 输入' : '▾ 收起';
  syncComposerMeta();
}

function setComposerHidden(hidden, opts) {
  if (!$('#btnComposer')) return;
  localStorage.setItem(composerStoreKey(), hidden ? '1' : '0');
  paintComposer();
  if (!hidden && opts && opts.focus) {
    const inp = $('#input');
    if (inp) inp.focus();
  }
}

/* 展开(收起时拖文件进来顺带把底板拉开,不用先去点手柄) */
function expandComposer() {
  if (!$('#btnComposer')) return;
  if (!composerHidden()) return;
  setComposerHidden(false, { focus: true });
}

function setupComposerToggle() {
  const comp = $('#composer');
  const btn = $('#btnComposer');
  if (!comp) return;
  // 重复接线只重画(与 setupListToggle 同款):两次绑定会让一次点击翻两次、看起来没反应
  if (btn && btn.dataset.wired !== '1') {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => setComposerHidden(!composerHidden(), { focus: true }));
  }
  if (comp.dataset.wired !== '1') {
    comp.dataset.wired = '1';
    // 收起时点细边空白处也展开;手柄与「中断」各有各的事,不抢
    comp.addEventListener('click', (e) => {
      if (!composerHidden()) return;
      const t = e.target;
      if (t && t.closest && (t.closest('#btnComposer') || t.closest('#interrupt'))) return;
      setComposerHidden(false, { focus: true });
    });
  }
  paintComposer();
}

/* ----------------------------- 绑定 ----------------------------- */

function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/* --------------------------- 窄屏(手机) ---------------------------
 * 判定源只有一处:index.html 内联脚本里的 window.OCS_NARROW_MQ。
 * 这里只做两件事:
 *   ① 窗口尺寸 / 朝向变了就同步 <html>.narrow
 *   ② 把「现在在哪一屏」同步成 <html>.view-chat(设计文档 §4.2:由 store.selected 派生)
 * 刻意【不引入第二个状态变量】—— 视图跟着 store.selected 走,与 hash 路由天然一致,
 * 于是深链与安卓返回键都免费可用。
 */

function syncNarrowView() {
  document.documentElement.classList.toggle('view-chat', !!store.selected);
}

// 会话列表的点击委托:点按钮走 onAction,点行本身进会话。
// 抽成函数是为了让 test/ui-mobile.html 能单独装上它(那里屏蔽了 init)。
function setupListActions() {
  $('#list tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (btn) {
      e.stopPropagation();
      onAction(btn.dataset.act, tr.dataset.id);
    } else {
      selectSession(tr.dataset.id);
    }
  });
}

function syncNarrowClass() {
  const apply = (cls, mq) => {
    if (!mq || !window.matchMedia) return;
    document.documentElement.classList.toggle(cls, matchMedia(mq).matches);
  };
  apply('narrow', window.OCS_NARROW_MQ);
  apply('short', window.OCS_SHORT_MQ);
  // 跨断点(转屏 / 拉窗口)后重读这一档自己的那份记忆:桌面与手机是两份,别互相串
  paintComposer();
}

function setupNarrow() {
  const mq = window.OCS_NARROW_MQ;
  if (mq && window.matchMedia && matchMedia(mq).addEventListener) {
    // change 只在跨过断点时来一次,不必防抖
    matchMedia(mq).addEventListener('change', syncNarrowClass);
  }
  syncNarrowClass();

  // 与安卓返回键同一条路:清掉 hash → 窄屏回到列表
  const back = $('#backList');
  if (back) {
    back.addEventListener('click', () => {
      clearSelection();
      renderSessions();
    });
  }

  // 顶栏在窄屏把次要控件收起来,点「筛选」才展开(桌面这一节不生效)
  const filt = $('#btnFilters');
  if (filt) {
    filt.addEventListener('click', () => {
      const bar = $('#topbar');
      const open = bar.classList.toggle('filters-open');
      filt.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  syncNarrowView();
}

function init() {
  health();
  setInterval(health, 15000);
  setupFilters(); // 先回填顶栏筛选/排序/搜索,再拉列表(否则会按默认值白拉一次)
  // 恢复顺序:先让列表落地(会话标题/目录要能取到),再回到 hash 里那个会话
  loadSessions({ reset: true }).then(restoreFromHash);
  loadActive();
  setInterval(loadActive, 8000);
  setupEvents();
  setupResizers();
  setupListToggle();
  setupNarrow();
  setupComposerToggle(); // 底板收起/展开(手机默认收起,见上面那一节)
  setupHistoryNav();
  setupScrollMemory();
  setupAttachments();
  setupTuiKeys(); // I 组:全局 Esc 中断 / Ctrl+P 命令面板 / Shift+Tab 切智能体
  setupPick(); // 选择框对话框(/models · /agents · /sessions)
  paintDelivery();

  $('#refresh').addEventListener('click', () => {
    health();
    loadSessions({ reset: true });
  });
  $('#loadMore').addEventListener('click', () => loadSessions({ more: true }));
  $('#older').addEventListener('click', () => loadMessages({ older: true }));
  $('#send').addEventListener('click', send);
  setupComposerKeys();
  $('#agentSel').addEventListener('change', () => switchAgent($('#agentSel').value));
  $('#modelSel').addEventListener('change', switchModel);
  $('#variantSel').addEventListener('change', switchModel);
  $('#interrupt').addEventListener('click', interrupt);
  $('#delivery').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-delivery]');
    if (b) setDelivery(b.dataset.delivery);
  });

  // ---- v2 D 组:新建 / 导入导出 / 归档 / 深链 ----
  $('#btnNew').addEventListener('click', openNew);
  $('#btnImport').addEventListener('click', openImport);
  $('#opExport').addEventListener('click', openExport);
  $('#opTui').addEventListener('click', openTui);
  $('#opArchive').addEventListener('click', () => toggleArchive(store.selected));
  $('#newOk').addEventListener('click', submitNew);
  $('#newDir').addEventListener('change', fillNewSelectors);
  $('#newModel').addEventListener('change', () =>
    paintVariant($('#newVariantWrap'), $('#newVariant'), $('#newModel').value)
  );
  $('#importOk').addEventListener('click', submitImport);
  $('#exportOk').addEventListener('click', submitExport);
  $('#tuiCopy').addEventListener('click', copyTui);
  document.querySelectorAll('dialog.dlg [data-close]').forEach((b) =>
    b.addEventListener('click', () => closeDlg(b.closest('dialog')))
  );

  setupListActions();
}

document.addEventListener('DOMContentLoaded', init);
