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
    throw new Error(msg);
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
    tr.innerHTML =
      '<td class="title" title="' + esc(s.id) + '">' + esc(s.title || '(无标题)') + '</td>' +
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
  $('#messages').innerHTML = '';
  updateChatStatus();
  await loadMessages({ older: false });
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

function toolStatus(p) {
  const st = p.state || {};
  return st.status || st.state || st.type || (p.executed ? 'done' : '…');
}

function renderMessage(m) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.type;

  if (m.type === 'user') {
    el.innerHTML =
      '<div class="role">你</div><div class="bubble">' + esc(m.text || '') + '</div>';
    return el;
  }

  if (m.type === 'assistant') {
    const parts = m.content || [];
    let html =
      '<div class="role">助手' +
      (m.model && m.model.id ? ' · ' + esc(m.model.id) : '') +
      '</div>';
    for (const p of parts) {
      if (p.type === 'text') {
        html += '<div class="bubble">' + esc(p.text || '') + '</div>';
      } else if (p.type === 'reasoning') {
        html +=
          '<details class="reasoning"><summary>思考</summary><pre>' +
          esc(p.text || '') +
          '</pre></details>';
      } else if (p.type === 'tool') {
        html +=
          '<div class="tool">🔧 ' +
          esc(p.name || 'tool') +
          ' <span class="tstate">' +
          esc(toolStatus(p)) +
          '</span></div>';
      }
    }
    if (m.tokens) {
      html +=
        '<div class="meta">' +
        esc(fmtTokens(m.tokens)) +
        ' tokens' +
        (m.cost ? ' · ' + esc(fmtCost(m.cost)) : '') +
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

function renderMessages() {
  const box = $('#messages');
  const msgs = Array.from(store.messages.values()).sort(
    (a, b) => ((a.time && a.time.created) || 0) - ((b.time && b.time.created) || 0)
  );
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = '';
  for (const m of msgs) box.appendChild(renderMessage(m));
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
      $('#messages').innerHTML = '';
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
  es.onmessage = () => {
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
