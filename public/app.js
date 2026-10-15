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
  live: new Map(), // assistantMessageID -> 流式本地缓冲(见「逐 token 流式」)
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

async function switchModel() {
  const sid = store.selected;
  if (!sid) return;
  const s = store.sessions.get(sid);
  const key = $('#modelSel').value;
  if (!key) {
    flash('模型不能置空,已保留当前设置', 'warn');
    renderControls(s);
    return;
  }
  const info = store.modelIndex.get(key);
  const slash = key.indexOf('/');
  const ref = {
    providerID: info ? info.providerID : key.slice(0, slash),
    id: info ? info.modelID : key.slice(slash + 1),
  };
  const variant = $('#variantSel').value;
  if (variant) ref.variant = variant;
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
  loadMessages({ older: false });
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

function renderSessions() {
  const all = Array.from(store.sessions.values());
  const archived = all.filter(isArchived);
  const rows = (store.showArchived ? all : all.filter((s) => !isArchived(s))).sort((a, b) => {
    const ta = (a.time && a.time.updated) || 0;
    const tb = (b.time && b.time.updated) || 0;
    return store.order === 'asc' ? ta - tb : tb - ta;
  });
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

async function selectSession(id) {
  store.selected = id;
  store.messages.clear();
  store.msgOlderCursor = null;
  store.pending = false;
  store.forceBottom = true;
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

function toolHead(p, s) {
  return (
    '<span class="tmark">⏺</span>' +
    '<span class="tname">' + esc(p.name || 'tool') + '</span>' +
    '<span class="tstate ' + s.cls + '">' + s.icon + (s.label ? ' ' + esc(s.label) : '') + '</span>'
  );
}

function toolHtml(p) {
  const s = statusInfo(p);
  const st = p.state || {};
  let body = '';
  if (st.input && Object.keys(st.input).length) {
    body += '<pre>' + esc(JSON.stringify(st.input, null, 2)) + '</pre>';
  }
  if (Array.isArray(st.content)) {
    const txt = st.content.map((c) => (c && c.text) || '').join('\n').trim();
    if (txt) body += '<pre>' + esc(txt) + '</pre>';
  }
  if (!body) return '<div class="toolrow">' + toolHead(p, s) + '</div>';
  return '<details class="tool"><summary>' + toolHead(p, s) + '</summary>' + body + '</details>';
}

function renderMessage(m, opts) {
  opts = opts || {};
  const el = document.createElement('div');
  el.className = 'msg ' + m.type + (m.live ? ' live' : '');

  if (m.type === 'user') {
    el.innerHTML =
      '<div class="turn-head"><span class="marker">❯</span><span class="who">你</span></div>' +
      '<div class="content">' + esc(m.text || '') + '</div>';
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
  const nearBottom = force || box.scrollHeight - box.scrollTop - box.clientHeight < 80;

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
    const sig = (L ? 'live|' + liveSig(L) : JSON.stringify(view)) + '|' + (showModel ? '1' : '0');
    let rec = msgEls.get(m.id);
    if (!rec) {
      rec = { sig: sig, el: renderMessage(view, { showModel }) };
      msgEls.set(m.id, rec);
    } else if (rec.sig !== sig) {
      const el = renderMessage(view, { showModel });
      rec.el.replaceWith(el);
      rec.el = el;
      rec.sig = sig;
    } else if (L) {
      paintLiveText(rec.el, L);
    }
    const anchor = prev ? prev.nextSibling : box.firstChild;
    if (rec.el !== anchor) box.insertBefore(rec.el, anchor);
    prev = rec.el;
  }

  if (nearBottom) box.scrollTop = box.scrollHeight;
  $('#older').hidden = !store.msgOlderCursor;

  const last = msgs[msgs.length - 1];
  if (last && last.type === 'idle') store.pending = false;
  const streaming = !!(last && last.type === 'assistant' && last.time && !last.time.completed);
  store.running = store.pending || streaming || !!liveForSid(store.selected);
  updateChatStatus();
}

function updateChatStatus() {
  const el = $('#chatState');
  if (!store.selected) {
    el.textContent = '';
    el.className = 'state';
    updateComposerControls();
    return;
  }
  const st = runStatus(store.selected);
  if (st === 'retry') {
    el.textContent = '◌ 重试中';
    el.className = 'state retry';
  } else if (st || store.running) {
    el.textContent = '● 运行中';
    el.className = 'state running';
  } else {
    el.textContent = '空闲';
    el.className = 'state';
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
    if (store.selected === id) {
      store.selected = null;
      store.messages.clear();
      msgEls.clear();
      dropAsksFor(id);
      $('#messages').innerHTML = '';
      renderAsks();
      $('#chatTitle').textContent = '未选择会话';
      $('#chatMeta').textContent = '';
      updateChatStatus();
    }
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

async function send() {
  const text = $('#input').value.trim();
  if (!text || !store.selected) return;
  const sid = store.selected;
  const busy = isRunning(sid) || store.running;
  const willQueue = busy && store.delivery === 'queue';
  const body = { text };
  if (busy) body.delivery = store.delivery;

  $('#input').value = '';
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
function liveSig(L) {
  return (
    L.parts
      .map((p) =>
        p.kind === 'tool'
          ? 't:' + p.id + ':' + ((p.state && p.state.status) || '')
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
      if (store.selected === id) {
        store.selected = null;
        renderInbox();
        updateComposerControls();
      }
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
  // 有本地缓冲的文本事件才算「已经渲染过」;没有缓冲(例如中途接入时才收到 delta)
  // 就退回老的「事件触发重取」路径,不至于把内容漏掉。
  const local = isStreamLocal(e.type) && !!store.live.get((e.data || {}).assistantMessageID || '');
  // 结构变化(新 part / 工具状态)立刻重绘;纯文本变化只刷局部节点
  if (structural && liveForSid(store.selected)) renderMessages();
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
  const leftPane = document.getElementById('filters');
  const listPane = document.getElementById('listpane');
  const r1 = document.getElementById('resizer-left');
  const r2 = document.getElementById('resizer-mid');
  if (!main || !leftPane || !listPane || !r1 || !r2) return;

  const savedLeft = parseInt(localStorage.getItem('ocs.leftW') || '', 10);
  const savedMid = parseInt(localStorage.getItem('ocs.midW') || '', 10);
  if (savedLeft) main.style.setProperty('--left-w', savedLeft + 'px');
  if (savedMid) main.style.setProperty('--mid-w', savedMid + 'px');

  function startDrag(e) {
    const handle = e.currentTarget;
    const isLeft = handle === r1;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    document.body.classList.add('resizing');

    const move = (ev) => {
      const mainRect = main.getBoundingClientRect();
      if (isLeft) {
        let w = ev.clientX - mainRect.left;
        w = Math.max(150, Math.min(480, w));
        main.style.setProperty('--left-w', w + 'px');
      } else {
        const start = listPane.getBoundingClientRect().left;
        let w = ev.clientX - start;
        const maxMid = mainRect.width - leftPane.getBoundingClientRect().width - 12 - 320;
        w = Math.max(280, Math.min(Math.max(280, maxMid), w));
        main.style.setProperty('--mid-w', w + 'px');
      }
    };
    const end = () => {
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      localStorage.setItem('ocs.leftW', Math.round(leftPane.getBoundingClientRect().width));
      localStorage.setItem('ocs.midW', Math.round(listPane.getBoundingClientRect().width));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  r1.addEventListener('pointerdown', startDrag);
  r2.addEventListener('pointerdown', startDrag);

  [r1, r2].forEach((h) =>
    h.addEventListener('dblclick', () => {
      main.style.removeProperty('--left-w');
      main.style.removeProperty('--mid-w');
      localStorage.removeItem('ocs.leftW');
      localStorage.removeItem('ocs.midW');
    })
  );
}

/* ----------------------------- 绑定 ----------------------------- */

function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function init() {
  health();
  setInterval(health, 15000);
  loadSessions({ reset: true });
  loadActive();
  setInterval(loadActive, 8000);
  setupEvents();
  setupResizers();
  paintDelivery();

  $('#search').addEventListener(
    'input',
    debounce(() => {
      store.search = $('#search').value.trim();
      loadSessions({ reset: true });
    }, 250)
  );
  $('#dirFilter').addEventListener('change', () => {
    store.directory = $('#dirFilter').value;
    loadSessions({ reset: true });
  });
  $('#order').addEventListener('change', () => {
    store.order = $('#order').value;
    loadSessions({ reset: true });
  });
  $('#refresh').addEventListener('click', () => {
    health();
    loadSessions({ reset: true });
  });
  $('#loadMore').addEventListener('click', () => loadSessions({ more: true }));
  $('#older').addEventListener('click', () => loadMessages({ older: true }));
  $('#send').addEventListener('click', send);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
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
  $('#showArchived').addEventListener('change', () => {
    store.showArchived = $('#showArchived').checked;
    renderSessions();
  });
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

document.addEventListener('DOMContentLoaded', init);
