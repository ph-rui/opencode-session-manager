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
};

const $ = (s) => document.querySelector(s);

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
  const rows = Array.from(store.sessions.values()).sort((a, b) => {
    const ta = (a.time && a.time.updated) || 0;
    const tb = (b.time && b.time.updated) || 0;
    return store.order === 'asc' ? ta - tb : tb - ta;
  });
  const tb = $('#list tbody');
  tb.innerHTML = '';
  $('#count').textContent = rows.length;
  for (const s of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;
    if (s.id === store.selected) tr.classList.add('selected');
    const dir = (s.location && s.location.directory) || '';
    const nAsk = askCountFor(s.id);
    tr.innerHTML =
      '<td class="title" title="' + esc(s.id) + '">' + esc(s.title || '(无标题)') +
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
      '<button data-act="del" class="danger">删除</button>' +
      '</td>';
    tb.appendChild(tr);
  }
  renderDirOptions();
  $('#loadMore').hidden = !store.sessionCursor;
}

function renderDirOptions() {
  const sel = $('#dirFilter');
  sel.innerHTML = '<option value="">全部</option>';
  Array.from(store.seenDirs)
    .sort()
    .forEach((d) => {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = d;
      sel.appendChild(o);
    });
  sel.value = store.directory;
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
  updateChatStatus();
  await Promise.all([loadMessages({ older: false }), loadAsks(id)]);
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
    renderMessages();
  } catch (e) {
    console.error('loadMessages', e);
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
  el.className = 'msg ' + m.type;

  if (m.type === 'user') {
    el.innerHTML =
      '<div class="turn-head"><span class="marker">❯</span><span class="who">你</span></div>' +
      '<div class="content">' + esc(m.text || '') + '</div>';
    return el;
  }

  if (m.type === 'assistant') {
    let html =
      '<div class="turn-head"><span class="marker">⏺</span>' +
      '<span class="who">助手</span>' +
      (opts.showModel && m.model && m.model.id
        ? '<span class="model">' + esc(m.model.id) + '</span>'
        : '') +
      '</div>';
    for (const p of m.content || []) {
      if (p.type === 'text') {
        html += '<div class="content">' + md(p.text || '') + '</div>';
      } else if (p.type === 'reasoning') {
        html +=
          '<details class="reasoning"><summary>▸ 思考</summary>' +
          '<div class="content">' + md(p.text || '') + '</div></details>';
      } else if (p.type === 'tool') {
        html += toolHtml(p);
      }
    }
    if (m.tokens) {
      html +=
        '<div class="meta">' + esc(fmtTokens(m.tokens)) + ' tokens' +
        (m.cost ? ' · ' + esc(fmtCost(m.cost)) : '') + '</div>';
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
  const msgs = Array.from(store.messages.values()).sort(
    (a, b) => ((a.time && a.time.created) || 0) - ((b.time && b.time.created) || 0)
  );
  const force = store.forceBottom;
  store.forceBottom = false;
  const nearBottom = force || box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  // 删除已不存在的消息
  for (const [id, rec] of msgEls) {
    if (!store.messages.has(id)) {
      rec.el.remove();
      msgEls.delete(id);
    }
  }

  // 增量渲染:仅重建变化的消息,其余复用 DOM(保留已展开的 details)
  let prev = null;
  let prevModel = null;
  for (const m of msgs) {
    const showModel =
      m.type === 'assistant' && !!(m.model && m.model.id) && m.model.id !== prevModel;
    if (m.type === 'assistant' && m.model && m.model.id) prevModel = m.model.id;
    const sig = JSON.stringify(m) + '|' + (showModel ? '1' : '0');
    let rec = msgEls.get(m.id);
    if (!rec) {
      rec = { sig, el: renderMessage(m, { showModel }) };
      msgEls.set(m.id, rec);
    } else if (rec.sig !== sig) {
      const el = renderMessage(m, { showModel });
      rec.el.replaceWith(el);
      rec.el = el;
      rec.sig = sig;
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
  store.running = store.pending || streaming;
  updateChatStatus();
}

function updateChatStatus() {
  const el = $('#chatState');
  if (!store.selected) {
    el.textContent = '';
    el.className = 'state';
    return;
  }
  if (store.running) {
    el.textContent = '● 运行中';
    el.className = 'state running';
  } else {
    el.textContent = '空闲';
    el.className = 'state';
  }
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
  $('#input').value = '';
  store.pending = true;
  updateChatStatus();
  try {
    await api('/api/session/' + encodeURIComponent(store.selected) + '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    alert('发送失败:' + e.message);
    store.pending = false;
    updateChatStatus();
    return;
  }
  setTimeout(() => loadMessages({ older: false }), 300);
}

/* ----------------------------- 事件流 ----------------------------- */

let msgTimer = null;
let listTimer = null;

function setupEvents() {
  const es = new EventSource('/api/event');
  es.onmessage = (ev) => {
    let e = null;
    try {
      e = JSON.parse(ev.data);
    } catch (_) {}
    if (e && e.type) handleAskEvent(e);
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      if (store.selected) loadMessages({ older: false });
    }, 150);
    clearTimeout(listTimer);
    listTimer = setTimeout(() => loadSessions({}), 1500);
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
  setupEvents();
  setupResizers();

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
