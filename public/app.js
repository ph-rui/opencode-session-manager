'use strict';

/* OpenCode 会话管理器 — 前端逻辑(原生 JS,无框架) */

/* 运行中发消息的默认投递方式。照 TUI:TUI 里**光按 Enter** 是 `prompt.submit`(插话,
 * 下一个 step 边界就并进当前回合),`<leader>return` 才是 `prompt.queue`(排队,等回合结束)。
 * 也就是说「接着打一句」在 TUI 里本来就发得出去,不用等整个回合。面板原来默认排队,
 * 用户实测「TUI 里发得出去、网页版躺在队列里」,这里对齐成插话(工具栏仍可切回排队)。 */
const DEFAULT_DELIVERY = 'steer';

const store = {
  sessions: new Map(),
  messages: new Map(),
  seenDirs: new Set(),
  selected: null,
  /* §8.59 最近打开的会话标签:[{ id, title }],顺序 = 打开顺序;最多 TABS_MAX 个。
   * 只存 id 与标题快照(不存消息),刷新后先画出来,点开时照常拉消息。 */
  tabs: [],
  order: 'desc',
  search: '',
  directory: '',
  sessionCursor: null,
  msgOlderCursor: null,
  /* §8.55 切回看过的会话:消息先在内存里留一份(只在当前标签页的 JS 堆里,不落
   * localStorage / sessionStorage —— 内容可能很长,也不该持久到磁盘)。
   * key = 会话 id,value = { messages, cursor, at };最多留 MSG_CACHE_MAX 个会话。 */
  msgCache: new Map(),
  /* §8.55 首屏会话列表那一趟实测到的往返时间:内网 < 20ms,VPN 200ms 起步。
   * 只在本次页面里生效,刷新/回到内网会重新量。 */
  netMeasured: false,
  netSlow: false,
  pending: false,
  running: false,
  // 消息区【跟随中】的状态 —— 含义是「跟着最新输出走」这个意图,不是一次几何测量。
  // 只有【用户自己往上滚】才关掉它;内容变长、容器变矮都不算(见 updateJumpLatest)。
  // atBottom() 读 scrollHeight,文档一脏就强制整篇重排版(实测 100 条消息 / 7800 节点:
  // 干净时 0.95ms,脏了 23~29ms)。滚动事件、每次 renderMessages 收尾都会刷新它,
  // 增量重绘只认这个缓存,不再自己去读。
  nearBottom: false,
  // 「上一次看到的 scrollTop」。光看离底多远分不出「用户往上滚了」和「容器变矮 / 内容
  // 变长了」—— 后两者也会让离底距离变大,却完全不该关掉跟随。两次 scrollTop 一比,
  // 只有变小才是用户自己往回翻。只在滚动事件与贴底动作里刷(见 pinBottom)。
  lastTop: 0,
  asks: new Map(), // key -> { kind:'form'|'permission', id, sessionID, data, busy, error }
  active: new Map(), // sessionID -> 'busy'|'retry'(来自 /api/session/active 与事件)
  // 子会话表:子会话ID -> 父会话ID。提示栏的「N subagents」用它数「正在跑的子会话」,
  // 照 TUI 的 session.family(sessionID) + status === "running"。单独放一份是为了不把
  // 子会话塞进 store.sessions —— 那会按顶栏的工程筛选漏进来一些别的工程的子会话。
  subs: new Map(),
  // 活着的持久 shell:shellID -> sessionID(照 TUI 的 shell.list(location) 按
  // metadata.sessionID 过滤)。只由 SSE 的 shell.created / shell.exited / shell.deleted 维护。
  shells: new Map(),
  compacting: new Set(), // sessionID:正在压缩上下文(SSE 的 session.compaction.started/.ended 说了算)
  compactText: new Map(), // sessionID -> 概要正文的流式缓冲(session.compaction.delta 一段段吐出来的)
  inbox: new Map(), // sessionID -> [Session.Inbox.Info]
  agents: new Map(), // directory -> [Agent.Info]
  models: new Map(), // directory -> [Model.Info]
  modelIndex: new Map(), // 'providerID/modelID' -> Model.Info
  delivery: DEFAULT_DELIVERY, // 运行中消息的投递方式(默认插话,见 DEFAULT_DELIVERY)
  ctrlKey: '', // 当前会话 agent/model 的指纹,避免回填时覆盖用户输入
  showArchived: false, // 列表是否显示已归档会话
  restoreScroll: null, // 刷新恢复时要还原的滚动锚点(只由 restoreFromHash 设置,renderMessages 消费)
  live: new Map(), // assistantMessageID -> 流式本地缓冲(见「逐 token 流式」)
  uploadDir: '', // 附件暂存目录(来自 /__health)
  home: '', // 机器 home 目录(来自 /__health),提示栏拿它把路径缩成 ~/...(照 TUI 的 cm)
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
  pickCurrent: undefined, // 「当前值」那一条的 key(照 TUI 的 DialogSelect 印一枚 ●)
  pickOnPick: null, // 选中回调
  msgError: '', // 最近一次拉消息失败的原文(空 = 没在失败);画成 #messages 末尾那条状态行
  msgLoading: false, // 「正在加载消息…」是不是真露出来了(慢到 MSG_LOADING_DELAY_MS 才露)
  msgSeq: 0, // 拉消息的「代」号:切会话或新请求一来,旧的重试/在途响应就作废
  listError: '', // 最近一次拉会话列表失败的原文(空 = 没在失败);画成左栏那条状态行(§8.45)
  listLoading: false, // 「正在加载会话…」是不是真露出来了(慢到 LIST_LOADING_DELAY_MS 才露)
  // 用户最近一次点击的时刻(§8.46 ③):ResizeObserver 补贴底前先看看「是不是用户自己弄高的」
  gestureAt: 0,
  repinWired: false, // 那只 click 监听只挂一次(init 会被反复调)
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

/* 大数缩写(照 TUI 的 zN):155600 → "155.6K"、1234567 → "1.2M"。
 * 上下文用量那块用它,和 TUI 提示栏里的 155.6K (78%) 是同一套算法。 */
function fmtSize(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
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
    /* 服务端的 tagged error 常把话藏在 data.message 里(worktree / location 这批都是),
     * 只看顶层 message 会退化成「HTTP 400」,对话框里就只剩一句编号。 */
    const msg = (j && (j.message || j.error || (j.data && j.data.message))) || 'HTTP ' + r.status;
    const err = new Error(msg);
    err.status = r.status;
    err.data = j && j.data; // §8.61:worktree 删除要靠 data.forceRequired 判断要不要再确认
    throw err;
  }
  /* 正文只下到一半(手机上一个 12MB 的会话首页被掐断过就是这种)时 JSON.parse 会失败。
   * 原来这里一声不响地返回 null,调用方的 `(j.data || [])` 于是把「没拿到」当成
   * 「这个会话没有消息」,消息区就永远空着 —— 必须把两种情形分开:抛出去,让调用方重试/报错。
   * 空正文(204 / 某些 POST)仍是合法的 null,不走这条路。 */
  if (j === null && txt.trim() !== '') {
    const err = new Error('响应不是合法 JSON(可能只下到一半)');
    err.truncated = true;
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
    if (j && j.home && store.home !== j.home) {
      store.home = j.home; // 提示栏把工程路径缩成 ~/...(照 TUI 的 cm)
      if (store.selected) paintContextUsage();
    }
    // §8.60:TUI 在 cli.json 里改了 diffs.view,借现成的 15s health 轮询同步;
    // 没有这个字段的旧代理(或读失败)就不动本地偏好。
    if (j && Object.prototype.hasOwnProperty.call(j, 'diffView')) {
      applyServerDiffPref(j.diffView, j.diffMtime);
    }
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

function clearToast() {
  const el = $('#toast');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
  clearTimeout(toastTimer);
}

/* ----------------------------- 会话运行状态 ----------------------------- */

function runStatus(sid) {
  return store.active.get(sid) || null;
}

function isRunning(sid) {
  return !!sid && (store.active.has(sid) || compactionRunning(sid));
}

/* 「正在压缩上下文吗」—— 两路信号合起来看:
 *   ① SSE 的 session.compaction.started/.ended(权威,压缩期 /api/session/active 会空一拍);
 *   ② 消息列表里最新那条压缩消息还是 running(刷新/重连后的兜底)。
 * 消息列表是权威:它已经收工,就把漏掉的 .ended 留下的标记清掉,免得条一直亮。
 * 别的会话只有 ① 这一路(store.messages 里装的是当前选中会话的消息)。 */
function compactionRunning(sid, msgs) {
  sid = sid || store.selected;
  if (!sid) return false;
  if (sid !== store.selected) return store.compacting.has(sid);
  let latest = null;
  const list = msgs || Array.from(store.messages.values());
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].type === 'compaction') {
      latest = list[i];
      break;
    }
  }
  if (latest && latest.status !== 'running') store.compacting.delete(sid);
  return store.compacting.has(sid) || !!(latest && latest.status === 'running');
}

/* ------------------------- 压缩块的正文(流式) -------------------------
 * 压缩是另一次 LLM 调用,摘要正文一小段一小段地吐出来:一条
 * `session.compaction.delta` 带一个 text 片段,实测一份 8 KB 的摘要来了 140+ 条、
 * 5ms 一条。TUI 是边压边把正文印在块里的(见 §8.11),面板照抄:片段攒起来,
 * 节流重画;`.ended` 那条载荷里带着完整摘要,直接盖上来,不用等消息列表对账。
 */
const COMPACT_TEXT_KEEP = 8; // 最多记几个会话的正文,免得页面长开着一直涨

function pushCompactText(sid, text) {
  if (!sid || !text) return;
  store.compactText.set(sid, (store.compactText.get(sid) || '') + text);
  while (store.compactText.size > COMPACT_TEXT_KEEP) {
    const oldest = store.compactText.keys().next().value;
    if (oldest === sid) break; // 刚塞进去的就是最老的,别再删了
    store.compactText.delete(oldest);
  }
}

/* 压缩块正文:服务端给了摘要就以它为准(权威);还在跑、摘要还没落库时用流式缓冲。 */
function compactionBody(m, sid) {
  if (!m) return '';
  if (m.summary) return m.summary;
  return store.compactText.get(sid || store.selected) || '';
}

let compactPaintedAt = 0;

/* 压缩正文的【局部】重绘 —— 不整表 renderMessages()。
 *
 * 用户报「压缩时不崩了但还卡,输出卡,怀疑进度条一动就卡」。先量了再改:
 *   · 进度条一帧 drawProgressFrame() = 0.007ms,一格都算不上 —— 卡的不是它;
 *   · 一次 renderMessages() 在压缩期 = 70~76ms,其中 ~50ms 是【强制同步排版】:
 *     重建压缩块把 DOM 弄脏,紧接着的 atBottom()/scrollHeight 读就会把 7800 个节点
 *     整篇重排(干净时 atBottom 只要 0.95ms,脏了 23~29ms);
 *   · 节流到 ~8 次/秒 × 6~8 次 = 压缩那几秒里三四百毫秒挤成长任务,进度条那 40ms
 *     一帧自然全被顶掉 —— 看着就像「进度条一动就卡」。
 *
 * 正文只有压缩块这一处在长,照 paintLiveText() 的做法只换那一个正文节点就行:
 * 不重建消息、不重算全表签名。滚动跟随用缓存口径(store.nearBottom),不主动读布局。
 * 结构还没建出来(空正文时块里没有 <details>)才返回 false,让调用方退回整表建一次。 */
function paintCompactBody(sid) {
  const box = $('#messages');
  if (!box) return false;
  let m = null;
  for (const v of store.messages.values()) {
    if (v && v.type === 'compaction' && v.status === 'running') { m = v; break; }
  }
  if (!m) return false;
  const rec = msgEls.get(m.id);
  if (!rec || !rec.el) return false;
  const host = rec.el.querySelector('details.compact > .content');
  if (!host) return false;
  const body = compactionBody(m, sid);
  if (host.dataset.cbodyLen === String(body.length)) return true; // 没长,别白刷
  host.innerHTML = md(body);
  host.dataset.cbodyLen = String(body.length);
  // 只有本来就贴着底时才跟一下 —— 贴底时这一次读已经在上面那次 innerHTML 之后欠下了,
  // 省不掉;不贴底就一次布局都不读。
  if (store.nearBottom) pinBottom(box);
  return true;
}

/* 正文变一次就重画一次的话,压缩那几秒里等于自己打自己(实测一份摘要 140+ 条 delta,
 * 5ms 一条)—— 节流到 ~8 次/秒;只在用户正看着这个会话时才画(别的会话先攒着,切过去就看得见)。
 * 前沿节流:不到 120ms 的后续片段等下一拍(或 .ended 那一下整段收尾)一起上屏。 */
function paintCompactStream(sid) {
  if (sid !== store.selected) return;
  const now = Date.now();
  if (now - compactPaintedAt < 120) return;
  compactPaintedAt = now;
  if (!paintCompactBody(sid)) renderMessages(); // 结构还没建出来 → 整表建一次,之后都走局部
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
  // §8.54:SSE 一直在推,这个 8s 轮询只当「SSE 哑了」的兜底 —— 最近 12s 内已经对过账
  // 就跳过(否则在看一个正在跑的会话时,它会每 8s 再白拉一次 MB 级消息列表)。
  if (sel && isRunning(sel) && Date.now() - msgLastDone > 12000) {
    loadMessages({ older: false, auto: true });
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

/* 选择器清空。会话信息还没到手(深链进来 / 列表那一页还没把它送过来)时宁可空着,
 * 也不许拿上一个会话的 agent/model 冒充 —— 提示栏那几格照 TUI 也是「知道了才印」。 */
function blankControls() {
  const a = $('#agentSel');
  const m = $('#modelSel');
  const vw = $('#variantWrap');
  const v = $('#variantSel');
  if (a) a.innerHTML = '';
  if (m) m.innerHTML = '';
  if (v) v.innerHTML = '';
  if (vw) vw.hidden = true;
}

async function renderControls(s) {
  const bar = $('#ctoolbar');
  if (!bar) return;
  if (!store.selected) {
    bar.hidden = true;
    store.ctrlKey = '';
    blankControls();
    updateComposerControls();
    return;
  }
  /* 先亮出来,再拉选择器要的数据。这条工具栏是细边上 ■ 中断 的家(收起时细边只剩它),
     下面那两个网络往返慢、失败,或者会话信息还没送到,都不许把它整条藏回去(§8.39)。
     选中的会话不在 store.sessions 里(深链 / 列表那一页没送它过来)时就先只亮骨架,
     真值由 refreshSessionInfo() 补画 —— 那些按钮都按会话 id 干活,不依赖这里的选择器。 */
  bar.hidden = false;
  const key = s ? ctrlKeyOf(s) : '';
  if (key !== store.ctrlKey) blankControls(); // 屏上挂着的还是上一个会话的值:先空掉
  if (!s) {
    /* 会话信息还没到:选择器一律空着(连 index.html 里那个占位的「默认」也不留),
     * 免得把「默认」当成这个会话真在用的 —— 真值等 refreshSessionInfo() 补画。 */
    blankControls();
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

  store.ctrlKey = key;
  /* 模型表刚拉回来,上下文用量的百分比这时才算得出来(updateChatStatus 早于这里跑过一遍) */
  paintContextUsage();
  updateComposerControls();
  /* 脚注里的模型名也要拿这张表来查(§8.27)—— 消息往往早于模型表渲染完,这里补一次重绘。
     签名里带了解析出来的模型名,所以只有真变了的那几条会换 DOM。 */
  renderMessages();
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
  // 只认这两个值,其它一律回默认(插话)—— 默认值是 DEFAULT_DELIVERY 一处说了算
  store.delivery = mode === 'queue' ? 'queue' : DEFAULT_DELIVERY;
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

/* ---------------------------- 中断:Esc 要按两下 ----------------------------
 * TUI 的 handleInterrupt 是「按两下」的:第一下只把 interrupt 计数置 1、挂一个 5 秒的
 * 归零定时器(armInterruptTimer),窗口里再按一下才真的打断;输入框一有动静
 * (handleInputClear)也把计数清掉,而且回合一结束(patch 里 phase === "idle")就归零。
 * 面板照抄这套 —— Esc 在面板里还兼职「关命令面板 / 关 @ 补全」,手滑一下就把正在跑的
 * 回合砍了,代价太大。没上膛时提示文案也照 TUI 的 prompt.footer 写法。
 * 「■ 中断」按钮和命令面板里的「中断」是明确动作,照旧一下生效,不走这一套。 */
const INTERRUPT_ARM_MS = 5000;
let interruptArmed = false;
let interruptArmTimer = null;
const PHINT_IDLE = '<b>esc</b> interrupt';
const PHINT_ARMED = '<b>esc</b> again to interrupt';

/* 状态条旁边那句提示(TUI 的 prompt.footer)。这里的 innerHTML 只在「上膛/收回」
 * 两种状态间来回,收回时写回的就是 index.html 里那段原文,不动 DOM 结构。 */
function paintInterruptHint() {
  const el = $('#progress .phint');
  if (!el) return;
  const want = interruptArmed ? PHINT_ARMED : PHINT_IDLE;
  if (el.innerHTML !== want) el.innerHTML = want;
  /* 照 TUI 的 showDetails(`interrupt===0 || width>=80`):上膛等第二下时窄屏把用量
   * 与快捷键提示收掉(《styles.css》里挂在 html.narrow 下,桌面照旧露着)。 */
  const foot = $('#promptFooter');
  if (foot) foot.classList.toggle('armed', interruptArmed);
}

/* 收掉「上膛」状态:按第二下时、5 秒到点时、输入框有动静时、回合结束时都走这里 */
function disarmInterrupt() {
  if (!interruptArmed && !interruptArmTimer) return;
  interruptArmed = false;
  if (interruptArmTimer) {
    clearTimeout(interruptArmTimer);
    interruptArmTimer = null;
  }
  paintInterruptHint();
}

/* Esc 走这里:第一下上膛(5 秒内有效),第二下才真打断 */
function requestInterrupt() {
  if (interruptArmed) {
    disarmInterrupt();
    interrupt();
    return;
  }
  interruptArmed = true;
  if (interruptArmTimer) clearTimeout(interruptArmTimer);
  interruptArmTimer = setTimeout(() => {
    interruptArmTimer = null;
    disarmInterrupt();
  }, INTERRUPT_ARM_MS);
  paintInterruptHint();
  /* 收起的底板上看不见状态条那句提示(styles.css 里 .phint 在收起 / 窄屏时是
   * display:none),这里再补一句 toast,免得「按一下没反应」被当成坏掉。 */
  flash('再按一次 Esc 中断当前回合(5 秒内)', 'warn');
}

async function interrupt() {
  const sid = store.selected;
  if (!sid) return;
  disarmInterrupt();
  const btn = $('#interrupt');
  if (btn) btn.disabled = true;
  try {
    /* resume=true:和 TUI 的 session.interrupt 一模一样 —— 中断之后接着跑「插话」类
     * 待投递输入,以及下一件控制项(压缩 / 移动)。 */
    const j = await api('/api/session/' + enc(sid) + '/interrupt?resume=true', { method: 'POST' });
    if (j && j.interrupted) {
      const n = await resumeQueued(sid);
      flash(n ? '已中断当前回合 · ' + n + ' 条排队消息接着发出' : '已中断当前回合', 'ok');
    } else {
      flash('当前没有正在执行的回合', 'warn');
    }
  } catch (e) {
    flash('中断失败:' + e.message, 'bad');
  }
  if (btn) btn.disabled = false;
  await loadActive();
}

/* 中断之后把「排队中」的消息接着发出去 —— TUI 里看到的就是这个效果。
 * TUI 的输入框默认用 steer 投递,interrupt 又带 resume=true,所以服务器顺手就把那条跑
 * 起来了;面板默认走 queue(排队),而 queue 的语义是「停在原地等下一次回合边界」,回合
 * 被中断之后不会再有下一个边界,那条就一直躺在待发送队列里(真机实测:不推它,30 秒都
 * 不动)。点它的「改为插话」就是「唤醒会话执行」,换成面板的话说就是:接着发。
 * 只推 user 一类:压缩 / 移动这些控制项已经由 interrupt?resume=true 自己接管了。 */
async function resumeQueued(sid) {
  let items = [];
  try {
    const j = await api('/api/session/' + enc(sid) + '/inbox');
    items = j.data || [];
  } catch (e) {
    return 0;
  }
  const queued = items.filter((it) => it && it.type === 'user' && it.delivery === 'queue');
  for (const it of queued) {
    try {
      await api('/api/session/' + enc(sid) + '/inbox/' + enc(it.id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delivery: 'steer' }),
      });
    } catch (e) {
      /* 推不动也不吵:那条还在待发送队列里,用户自己也能点「改为插话」 */
    }
  }
  if (queued.length) await loadInbox(sid);
  return queued.length;
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
  // 现在整块收在一条 details 里,而这份列表每次事件都整块重画 —— 展开态得自己记住,
  // 否则待发送项一动(排队→插话、取消一条)就折回去。
  const wasOpen = !!(box.querySelector('.ibdock') && box.querySelector('.ibdock').open);
  box.innerHTML = '';
  if (!items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  // 行头照 TUI 的 QueuedPromptDock(一条 `N queued · 下一条的正文`,换行压成空格),
  // 点开才是逐条那一列 —— 面板没有 TUI 那个「Queued prompts」对话框,拿 details 顶。
  // 计数:面板这边数的是整张待发送表(排队 / 插话 / 压缩 / 移动都在里面),
  // 只数 delivery=queue 的话行数与展开后对不上。
  const firstText = inboxText(items[0]).replace(/\s+/g, ' ').trim();
  const dock = document.createElement('details');
  dock.className = 'ibdock';
  dock.setAttribute('data-def', '0');
  const sum = document.createElement('summary');
  sum.innerHTML =
    '<span class="ibCount">' + items.length + ' queued</span>' +
    (firstText ? '<span class="ibNext"> · ' + esc(firstText) + '</span>' : '');
  dock.appendChild(sum);
  const list = document.createElement('div');
  list.className = 'iblist';
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
    list.appendChild(el);
  }
  dock.appendChild(list);
  if (wasOpen) dock.open = true;
  box.appendChild(dock);
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
  if (!s) {
    /* 这一栏现在「选中就有」(§8.39),所以会话信息还没到时也可能被按到。归档得先知道
     * 当前状态,补拉一次并明说一声 —— 别让这一下按了跟没按一样。 */
    if (id) refreshSessionInfo(id);
    flash('会话信息还没到,稍等一下再按', 'warn');
    return;
  }
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

/* 头部那一排操作(导出 / 在 TUI 打开 / 归档)+ 紧跟其后的「加载更旧消息」。
 * 判据只有「有没有选中会话」—— 深链进来、或列表那一页还没把这个会话送过来时,它照样得在:
 * 以前这里查 store.sessions,于是列表 / 会话信息任何一次网络往返没回来,整排就永远藏着
 * (手机上看到的就是「导出那一栏不见了」,见 §8.39)。归档的文案拿不准时先按未归档画,
 * refreshSessionInfo() 拿到会话信息后会重画一次校正。 */
function renderChatOps() {
  const bar = $('#chatOps');
  if (!bar) return;
  bar.hidden = !store.selected;
  if (!store.selected) return;
  const s = store.sessions.get(store.selected);
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

/* §8.56 worktree:照 TUI 的 DialogWorktreeName 那三步 —— 起名、生成、确认。
 * 名字规则也一样(全小写、非字母数字变 -、掐掉首尾 -);留空就随机 adjective-noun。
 * §8.61 补齐 TUI Worktrees 对话框的后半段:列出 / 删除 / 把当前会话移进去,入口是
 * /worktrees 命令(与 /diff 一样只走命令面板,不往聊天头部加按钮)。 */
const WT_ADJ = [
  'brave', 'calm', 'clever', 'cosmic', 'crisp', 'curious', 'eager', 'gentle', 'glowing',
  'happy', 'hidden', 'jolly', 'kind', 'lucky', 'mighty', 'misty', 'neon', 'nimble',
  'playful', 'proud', 'quick', 'quiet', 'shiny', 'silent', 'stellar', 'sunny', 'swift',
  'tidy', 'witty',
];
const WT_NOUN = [
  'cabin', 'cactus', 'canyon', 'circuit', 'comet', 'eagle', 'engine', 'falcon', 'forest',
  'garden', 'harbor', 'island', 'knight', 'lagoon', 'meadow', 'moon', 'mountain', 'nebula',
  'orchid', 'otter', 'panda', 'pixel', 'planet', 'river', 'rocket', 'sailor', 'squid',
  'star', 'tiger', 'wizard', 'wolf',
];

function wtSlug() {
  return (
    WT_ADJ[Math.floor(Math.random() * WT_ADJ.length)] +
    '-' +
    WT_NOUN[Math.floor(Math.random() * WT_NOUN.length)]
  );
}

function wtSlugify(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function paintNewWorktree() {
  const box = $('#newWt');
  if (!box) return;
  const on = box.checked;
  const row = $('#newWtRow');
  const hint = $('#newWtHint');
  if (row) row.hidden = !on;
  if (hint) hint.hidden = !on;
  // 勾上就先给一个名字(手机上少打几个字);清空留白则由提交时再随机。
  const name = $('#newWtName');
  if (on && name && !wtSlugify(name.value)) name.value = wtSlug();
}

function openNew() {
  $('#newErr').hidden = true;
  $('#newTitle').value = '';
  if (!$('#newDir').value) $('#newDir').value = store.directory || '';
  if ($('#newWt')) $('#newWt').checked = false;
  if ($('#newWtName')) $('#newWtName').value = '';
  // 上一次「worktree 建好、会话没建成」的重试凭据也清掉(§8.56)
  const dlg = $('#dlgNew');
  if (dlg) {
    delete dlg.dataset.wtDir;
    delete dlg.dataset.wtSrc;
    delete dlg.dataset.wtName;
  }
  paintNewWorktree();
  openDlg($('#dlgNew'));
  fillNewSelectors();
}

async function submitNew() {
  const err = $('#newErr');
  err.hidden = true;
  let dir = ($('#newDir').value || '').trim();
  if (!dir) return showDlgErr(err, '请填写工程目录');
  if (dir[0] !== '/') return showDlgErr(err, '工程目录需要是绝对路径');

  const wtOn = !!($('#newWt') && $('#newWt').checked);
  const btn = $('#newOk');
  const dlg = $('#dlgNew');
  let phase = '会话';
  setBusy(btn, true, wtOn ? '创建 worktree…' : '创建中…');
  try {
    if (wtOn) {
      phase = 'worktree';
      const src = dir;
      const name = wtSlugify($('#newWtName').value) || wtSlug();
      $('#newWtName').value = name;
      /* worktree 已经建好、但会话 POST 失败(手机断一下很常见)时,再点「创建」不能又建一棵。
       * 凭据挂在对话框上:源目录 + 名字都没变就复用上次那个目录;关掉/换名字/换源目录就作废。 */
      const reuse = dlg && dlg.dataset.wtDir && dlg.dataset.wtSrc === src && dlg.dataset.wtName === name;
      if (reuse) {
        dir = dlg.dataset.wtDir;
      } else {
        // 目录 → 工程:worktree 接口只认 projectID,先问 /api/location 要。
        const loc = await api(
          '/api/location?' + new URLSearchParams({ 'location[directory]': src }).toString()
        );
        const projectID = loc && loc.project && loc.project.id;
        if (!projectID) throw new Error('这个目录不属于任何工程(worktree 只支持 git 仓库)');
        const wt = await api('/api/worktree', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectID, name }),
        });
        if (!wt || !wt.directory) throw new Error('服务端没有返回 worktree 目录');
        store.seenDirs.add(src); // 源目录也留在目录下拉里
        dir = wt.directory;
        if (dlg) {
          dlg.dataset.wtSrc = src;
          dlg.dataset.wtName = name;
          dlg.dataset.wtDir = dir;
        }
      }
      phase = '会话';
      setBusy(btn, true, '创建中…');
    }

    const body = { location: { directory: dir } };
    const title = ($('#newTitle').value || '').trim();
    if (title) body.title = title;
    const agent = $('#newAgent').value;
    if (agent) body.agent = agent;
    const ref = modelRefOf($('#newModel').value, $('#newVariant').value);
    if (ref) body.model = ref;

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
    showDlgErr(err, (phase === 'worktree' ? 'worktree ' : '') + '创建失败:' + e.message);
  }
  setBusy(btn, false);
}

/* §8.61 worktree 管理:列出 / 删除 / 把当前会话移进去。
 * 列的是服务端 /api/worktree 给的「根」目录(主检出 + OpenCode 建的 worktree),不把
 * 会话落在根下的子目录再拆成一层 —— TUI 会拆,但面板在手机上多一层只会更难找。
 * 删除只对带 strategy 的 worktree 开放(主检出永远不能删);移入走 session/move。 */
function wtUnder(root, dir) {
  if (!root || !dir) return false;
  const r = normPath(root);
  const d = normPath(dir);
  return d === r || d.indexOf(r + '/') === 0;
}

function wtListOf(j) {
  const raw = Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : [];
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    if (!x || typeof x.directory !== 'string' || !x.directory) continue;
    const dir = normPath(x.directory);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({ directory: dir, strategy: typeof x.strategy === 'string' ? x.strategy : '' });
  }
  return out;
}

function wtCurrentRoot(list, dir) {
  if (!dir) return null;
  let best = null;
  for (const w of list) {
    if (wtUnder(w.directory, dir) && (!best || w.directory.length > best.length)) best = w.directory;
  }
  return best;
}

// 每次都向服务端要一次会话信息:移入 / 删除之后本地 store 可能正被后台列表刷新
// 用旧 location 覆盖(SSE 的 session.moved 与定时 loadSessions 会赛跑),而当前根
// 标错就会把「删掉当前工作树」误判成「删别的」。多这一趟 GET 换准头,值。
async function worktreeSession(sid) {
  const j = await api('/api/session/' + enc(sid));
  const info = j && j.data;
  if (!info || !info.id) throw new Error('拿不到这个会话的工程信息');
  if (!info.location && info.directory) info.location = { directory: info.directory };
  if (store.selected === sid) store.sessions.set(sid, info);
  return info;
}

async function openWorktrees() {
  const sid = store.selected;
  if (!sid) {
    flash('先打开一个会话,再管理工作树', 'warn');
    return;
  }
  flash('正在读取工作树…');
  let s;
  try {
    s = await worktreeSession(sid);
  } catch (e) {
    flash('工作树列表加载失败:' + e.message, 'bad');
    return;
  }
  if (store.selected !== sid) return;
  const projectID = s && s.projectID;
  if (!projectID) {
    flash('这个会话没有工程号,列不了工作树', 'bad');
    return;
  }
  const currentDir = (s.location && s.location.directory) || '';
  // TUI 的 Worktrees 对话框打开时先 refresh 再列;refresh 失败(工程不认 / 不是 git)
  // 不影响下面那次 list,静默跳过。
  try {
    await api('/api/worktree/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectID }),
    });
  } catch (_) {}
  let list;
  try {
    list = wtListOf(
      await api('/api/worktree?' + new URLSearchParams({ projectID }).toString())
    );
  } catch (e) {
    if (store.selected === sid) flash('工作树列表加载失败:' + e.message, 'bad');
    return;
  }
  if (store.selected !== sid) return;
  if (!list.length) {
    flash('这个工程没有工作树', 'warn');
    return;
  }
  const currentRoot = wtCurrentRoot(list, currentDir);
  // 照 TUI:当前所在根排最前;其余主检出在前、worktree 在后,主检出按路径长短。
  list.sort((a, b) => {
    const ac = a.directory === currentRoot;
    const bc = b.directory === currentRoot;
    if (ac !== bc) return ac ? -1 : 1;
    const aw = !!a.strategy;
    const bw = !!b.strategy;
    if (aw !== bw) return aw ? 1 : -1;
    if (!aw && !bw) return a.directory.length - b.directory.length;
    return a.directory.localeCompare(b.directory);
  });
  openPick({
    title: '工作树 · ' + ((s && s.title) || sid),
    filter: true,
    filterHint: '按路径过滤…',
    current: currentRoot,
    items: list.map((w) => ({
      key: w.directory,
      directory: w.directory,
      label: abbrevHome(w.directory),
      sub: w.strategy ? 'worktree' : '主检出',
      strategy: w.strategy,
    })),
    onPick: (it) => openWorktreeActions(it, { sid, projectID, currentDir, currentRoot }),
  });
  clearToast(); // 列表已经打开,别让「正在读取」在框后面挂到 2.6s
}

function openWorktreeActions(it, ctx) {
  if (!it) return;
  const isCurrent = !!ctx.currentDir && normPath(ctx.currentDir) === normPath(it.directory);
  const currentHere = !!ctx.currentRoot && ctx.currentRoot === it.directory;
  const items = [
    {
      key: 'move',
      label: '把当前会话移到这里',
      sub: isCurrent ? '当前就在这个目录' : '',
      disabled: isCurrent,
    },
    {
      key: 'delete',
      label: '删除工作树',
      sub: !it.strategy
        ? '主检出不能删'
        : currentHere
          ? '当前会话在此;删除后回列表'
          : '有未提交改动会再确认',
      disabled: !it.strategy,
    },
    { key: 'refresh', label: '刷新工作树列表' },
  ];
  openPick({
    title: '工作树 · ' + abbrevHome(it.directory),
    filter: false,
    items,
    onPick: (act) => {
      if (!act) return;
      if (act.key === 'move') return moveSessionToWorktree(ctx.sid, it.directory);
      if (act.key === 'delete') return removeWorktree(it, ctx);
      if (act.key === 'refresh') return openWorktrees();
    },
  });
}

async function moveSessionToWorktree(sid, directory) {
  try {
    await api('/api/session/' + enc(sid) + '/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory }),
    });
  } catch (e) {
    flash('移动会话失败:' + e.message, 'bad');
    return;
  }
  let s = store.sessions.get(sid);
  if (!s) s = { id: sid };
  s.location = Object.assign({}, s.location, { directory });
  store.sessions.set(sid, s);
  store.seenDirs.add(directory);
  renderSessions();
  if (store.selected === sid) {
    paintChatHeader(s);
    renderChatOps();
    paintContextUsage();
    renderControls(s);
  }
  flash('已移动到 ' + abbrevHome(directory), 'ok');
}

async function removeWorktree(w, ctx, force) {
  const dir = w.directory;
  try {
    await api('/api/worktree', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectID: ctx.projectID,
        directory: dir,
        force: !!force,
      }),
    });
  } catch (e) {
    if (!force && e.data && e.data.forceRequired === true) {
      if (!confirm('这个工作树有未提交改动,强制删除?')) return;
      return removeWorktree(w, ctx, true);
    }
    flash('删除工作树失败:' + e.message, 'bad');
    return;
  }
  store.seenDirs.delete(dir);
  renderSessions();
  // 删除是异步的,期间用户可能已经切到别的会话;要按【现在选中的】目录判断,
  // 否则会把刚切过去的会话也一起清掉。同一个会话优先信打开动作菜单时刚拿到的
  // ctx.currentDir(store 可能被后台列表刷成旧值)。
  const selDir = store.selected === ctx.sid
    ? ctx.currentDir || sessionDir(ctx.sid) || ''
    : sessionDir(store.selected) || '';
  if (selDir && wtUnder(dir, selDir)) {
    clearSelection();
    flash('工作树已删除;当前会话所在目录没了,已回到列表', 'warn');
    return;
  }
  if (store.selected === ctx.sid) await openWorktrees();
  flash('已删除工作树:' + abbrevHome(dir), 'ok');
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

/* ----------------------- 变更总览(照 TUI 的 /diff,最近一轮) ----------------------- */

// 服务端 /api/session/:id/diff 默认就是「最新一条用户消息那一轮」的净变更:
// 它按 turn 的 idle 快照算,同一个文件在一轮里改了多次也只算最终结果。TUI 的
// diff viewer 把这叫 Last turn;branch / working / committed 三档还没接。
//
// 并发用 diffSeq 兜住:点「刷新」或切会话时旧请求晚到,不能盖掉新结果。
let diffSeq = 0;

function openDiff() {
  const sid = store.selected;
  if (!sid) {
    flash('先选一个会话', 'warn');
    return;
  }
  const err = $('#diffErr');
  if (err) err.hidden = true;
  const stat = $('#diffStat');
  if (stat) stat.textContent = '';
  const body = $('#diffBody');
  if (body) body.innerHTML = '<p class="dlghint">正在加载变更…</p>';
  const dlg = $('#dlgDiff');
  if (!dlg) return; // 老测试页没有这个框
  if (!dlg.open) openDlg(dlg);
  return loadDiff();
}

function renderDiffFiles(files, sid) {
  const body = $('#diffBody');
  const stat = $('#diffStat');
  if (!body) return;
  if (!files.length) {
    body.innerHTML =
      '<p class="dlghint">' +
      (sid && isRunning(sid)
        ? '最近一轮还在跑;这轮改了文件的话,结束后点「刷新」。'
        : '最近一轮没有文件变更。') +
      '</p>';
    if (stat) stat.textContent = '0 个文件';
    return;
  }
  let adds = 0;
  let dels = 0;
  for (const f of files) {
    adds += typeof f.additions === 'number' ? f.additions : 0;
    dels += typeof f.deletions === 'number' ? f.deletions : 0;
  }
  // 不传 pid:框里不出「并排 / 统一」按钮,视图跟消息卡片共享同一个全局偏好。
  body.innerHTML = diffHtml(files);
  if (stat) stat.textContent = files.length + ' 个文件 · +' + adds + ' -' + dels;
}

async function loadDiff() {
  const sid = store.selected;
  const dlg = $('#dlgDiff');
  if (!sid || !dlg) return;
  const seq = ++diffSeq;
  const err = $('#diffErr');
  const body = $('#diffBody');
  const btn = $('#diffReload');
  if (err) err.hidden = true;
  if (body && !body.innerHTML) body.innerHTML = '<p class="dlghint">正在加载变更…</p>';
  setBusy(btn, true, '刷新中…');
  try {
    const j = await api('/api/session/' + enc(sid) + '/diff?context=3');
    if (seq !== diffSeq || store.selected !== sid) return;
    if (!j || !Array.isArray(j.data)) throw new Error('服务端没有返回变更列表');
    renderDiffFiles(j.data, sid);
  } catch (e) {
    if (seq !== diffSeq || store.selected !== sid) return;
    if (err) showDlgErr(err, '加载变更失败:' + e.message);
    if (body) body.innerHTML = '';
    const stat = $('#diffStat');
    if (stat) stat.textContent = '';
  } finally {
    if (seq === diffSeq) setBusy(btn, false);
  }
}

/* ----------------------------- 会话列表 ----------------------------- */

async function loadSessions(opts) {
  opts = opts || {};
  const quiet = !!opts.auto;
  if (quiet) {
    if (sessionLoadBusy) { sessionAutoQueued = true; return; }
    const wait = sessionLastDone ? SESSION_AUTO_GAP_MS - (Date.now() - sessionLastDone) : 0;
    if (wait > 0) { scheduleAutoSessions(wait); return; }
  }
  if (opts.reset) {
    store.sessions.clear();
    store.subs.clear();
    store.sessionCursor = null;
  }
  const q = new URLSearchParams({ order: store.order, limit: '50' });
  if (store.search) q.set('search', store.search);
  if (store.directory) q.set('directory', store.directory);
  if (opts.more) {
    if (!store.sessionCursor) return;
    q.set('cursor', store.sessionCursor);
  }
  if (!quiet) setListLoading(true);
  const gen = ++sessionLoadGen;
  sessionLoadBusy = true;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    const j = await api('/api/session?' + q.toString());
    if (!opts.more) {
      const dt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      noteNetSample(dt); // §8.55 只认第一次(函数内部自己兜住)
    }
    (j.data || []).forEach((s) => {
      store.sessions.set(s.id, s);
      if (s.parentID) store.subs.set(s.id, s.parentID);
      const d = s.location && s.location.directory;
      if (d) store.seenDirs.add(d);
    });
    store.sessionCursor = (j.cursor && j.cursor.next) || null;
    store.listError = '';
    renderSessions();
    if (quiet) paintListState(); // 后台成功:把上一次的失败话撤掉(不新开状态行)
  } catch (e) {
    console.error('loadSessions', e);
    /* §8.45:失败不许只进控制台 —— 左栏会安静地停在旧数据 /「共 0 个会话」上。
     * 原因记下来交给 #listState 画(原因 + 重试),控制台那条照旧留着。
     * 后台(auto)刷新失败不抢占画面:当前列表还能用,下一次事件再试。 */
    if (!quiet) store.listError = String((e && (e.message || e.status)) || e || '未知错误');
  } finally {
    if (!quiet) setListLoading(false); // 成功 / 失败都收尾(文案由 store.listError 决定)
    if (gen === sessionLoadGen) {
      sessionLoadBusy = false;
      sessionLastDone = Date.now();
      if (sessionAutoQueued) {
        sessionAutoQueued = false;
        scheduleAutoSessions(SESSION_AUTO_GAP_MS);
      }
    }
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

/* ----------------------------- 最近会话标签栏(§8.59) -----------------------------
 * 照 TUI 的 session tabs 的骨架,只做手机/桌面都用得上的那部分:
 *   · 打开会话自动进 tab;顺序 = 打开顺序,点 tab 不重排;
 *   · × 只从 tab 栏移除,不归档不删除;关掉当前 tab 自动切右邻居,没有就左邻居;
 *   · 最多 8 个,超出丢最旧的;列表存 localStorage(只存 id + 标题快照);
 *   · 手机也显示,横向滑,不折行;没有 tab 时整条 hidden。
 * 刻意不做:TUI 的拖拽排序 / 未读脉冲 / Ctrl+数字 / global-cwd 分域。 */
const TABS_KEY = 'ocs.tabs';
const TABS_MAX = 8;
let tabsSig = '';
let tabsActiveSeen = null;

function readTabs() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(TABS_KEY) || '[]');
  } catch (_) {
    raw = [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = typeof item === 'string' ? item : item && item.id;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    const title = item && typeof item === 'object' && typeof item.title === 'string' ? item.title : '';
    seen.add(id);
    out.push({ id: id, title: title });
  }
  return out.slice(-TABS_MAX);
}

function saveTabs() {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(store.tabs));
  } catch (_) {}
}

/* 选中一个会话时调用:没有就追加,有就只更新标题(重复选中不会多一个 tab)。 */
function touchTab(id, title) {
  if (!id) return;
  const s = store.sessions.get(id);
  const next = title != null ? String(title || '') : (s && s.title) || '';
  const tab = store.tabs.find((t) => t.id === id);
  if (tab) {
    if (next && next !== tab.title) {
      tab.title = next;
      saveTabs();
    }
  } else {
    store.tabs.push({ id: id, title: next || id });
    while (store.tabs.length > TABS_MAX) store.tabs.shift();
    saveTabs();
  }
  renderTabs();
}

function removeTab(id) {
  const i = store.tabs.findIndex((t) => t.id === id);
  if (i < 0) return false;
  store.tabs.splice(i, 1);
  saveTabs();
  return true;
}

function renderTabs() {
  const nav = document.getElementById('sessionTabs');
  const strip = document.getElementById('tabStrip');
  if (!nav || !strip) return; // 老测试页没有这条栏 —— 什么都不做
  let changed = false;
  for (const t of store.tabs) {
    const s = store.sessions.get(t.id);
    if (s && s.title && s.title !== t.title) {
      t.title = s.title;
      changed = true;
    }
  }
  if (changed) saveTabs();
  nav.hidden = store.tabs.length === 0;
  if (!store.tabs.length) {
    strip.innerHTML = '';
    tabsSig = '';
    tabsActiveSeen = null;
    return;
  }
  const active = store.selected;
  const sig = JSON.stringify([store.tabs.map((t) => [t.id, t.title]), active]);
  if (sig === tabsSig) return;
  const left = strip.scrollLeft;
  strip.innerHTML = store.tabs
    .map((t) => {
      const title = t.title || t.id;
      const on = t.id === active;
      return (
        '<div class="tab' + (on ? ' active' : '') + '" data-id="' + esc(t.id) + '">' +
        '<button type="button" class="tabmain" title="' + esc(title) + '"' +
        (on ? ' aria-current="page"' : '') + '>' +
        '<span class="tabtitle">' + esc(title) + '</span></button>' +
        '<button type="button" class="tabx" title="关闭标签页" aria-label="关闭标签页">×</button>' +
        '</div>'
      );
    })
    .join('');
  tabsSig = sig;
  strip.scrollLeft = left;
  // 当前 tab 换了才把它滚进视野;用户自己横向翻着看的时候不要去拽回来。
  const reveal = !!active && active !== tabsActiveSeen;
  tabsActiveSeen = active;
  if (reveal) revealActiveTab();
}

/* 只动 #tabStrip 自己的 scrollLeft,不碰页面/聊天区的纵向滚动。
 * 窄屏从列表进会话时 #chatpane 还是 display:none,这时量不到宽度 —— 所以
 * selectSession 在 syncNarrowView() 之后会再叫一次(同一个函数,幂等)。 */
function revealActiveTab() {
  const strip = document.getElementById('tabStrip');
  if (!strip) return;
  const el = strip.querySelector('.tab.active');
  if (!el) return;
  const er = el.getBoundingClientRect();
  const sr = strip.getBoundingClientRect();
  if (!er.width || !sr.width) return;
  if (er.left < sr.left) strip.scrollLeft -= sr.left - er.left;
  else if (er.right > sr.right) strip.scrollLeft += er.right - sr.right;
}

/* 关一个 tab:只移出列表,绝不发 DELETE。关的是当前会话时,右邻居优先、再左邻居。 */
function closeTab(id) {
  const i = store.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const wasActive = store.selected === id;
  store.tabs.splice(i, 1);
  saveTabs();
  if (wasActive) {
    const next = store.tabs[i] || store.tabs[i - 1];
    if (next) selectSession(next.id);
    else {
      clearSelection();
      renderSessions();
    }
  }
  renderTabs();
}

function setupSessionTabs() {
  const nav = document.getElementById('sessionTabs');
  if (!nav || nav.dataset.wired === '1') return;
  nav.dataset.wired = '1';
  nav.addEventListener('click', (e) => {
    const x = e.target.closest('.tabx');
    if (x) {
      e.preventDefault();
      e.stopPropagation();
      const tab = x.closest('.tab');
      if (tab) closeTab(tab.dataset.id);
      return;
    }
    if (e.target.closest('#tabNew')) {
      openNew();
      return;
    }
    const tab = e.target.closest('.tab');
    if (!tab) return;
    e.preventDefault();
    const id = tab.dataset.id;
    if (id && id !== store.selected) selectSession(id);
  });
  // 桌面习惯:中键关闭(只移出 tab,不删会话)
  nav.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = e.target.closest('.tab');
    if (tab) {
      e.preventDefault();
      closeTab(tab.dataset.id);
    }
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
    const st = runStatus(s.id) || (compactionRunning(s.id) ? 'busy' : null);
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
  renderTabs();
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
  if (id) cacheCurrentMessages(); // §8.55 取消选中也先留一份(切回来还能秒开)
  store.selected = null;
  persistSelected(null, 'replace');
  store.messages.clear();
  msgEls.clear();
  if (id) dropAsksFor(id);
  $('#messages').innerHTML = ''; // 里面的「跳到最新」按钮由 updateJumpLatest() 自己搬回来
  /* 「加载更旧消息」跟着选中会话走:游标和那一格都清掉 —— 只清 store.messages 的话,这一格
   * 会一直露在头部(没选中会话时点了也没用,loadMessages 会直接返回),而且下一个会话的第一页
   * 还没回来之前它仍带着上一个会话的游标。 */
  store.msgOlderCursor = null;
  $('#older').hidden = true;
  store.msgError = ''; // 没选中会话:失败提示也一并撤掉(否则它会跟着下一个会话)
  store.msgSeq++; // 在途的响应与重试就地作废
  repinSeq++; // 「贴完底再跟几帧」那一轮也一起作废(不然它会去动下一个会话的位置)
  setMsgLoading(false);
  paintMsgState();
  updateJumpLatest(); // 没选中会话了 → 收起来
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
  renderTabs(); // §8.59 取消选中:tab 栏留着(可以直接点回去),只是不再高亮
  syncNarrowView();
}

// 刷新后恢复:只在「还没选过任何会话」时出手,不抢用户已经做出的选择。
// 刻意不要求该会话出现在列表里 —— 它可能落在第二页,selectSession 只要 id 就能拉消息。
async function restoreFromHash() {
  if (store.selected) return;
  const id = hashToID(location.hash);
  if (!id) return;
  const saved = savedAnchor(id); // 有存档就回到读到的位置;没有就按老样子跳到底部
  // 只在【真有存档】时才塞 pending:塞一个 anchor 为 null 的进去会拦住 selectSession 里的
  // forceBottom,于是「没有存档」变成停在最上面 —— 长会话一打开就得自己点一次「跳到最新」,
  // 与这里的本意正好相反。
  if (saved) store.restoreScroll = { sid: id, anchor: saved };
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
    // 量出锚点相对滚动口上沿的差,滚掉它 —— 一步就准:滚完之后锚点正好落在 off 处,
    // 而且接下来重排的是【锚点下方】刚露头那一屏,锚点自己不会动。
    // 上面那些离屏消息即使还按 contain-intrinsic-size 的估值占位,也只是让滚动条比例不准,
    // 不影响锚点在屏上的位置(实测冷刷新后偏 1px)。
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

/* ---------------- 窄屏「滚到顶自动拉更旧」 ----------------
 * 手机上「导出 / 在TUI打开 / 归档 / 加载更旧消息」那一整行按 §8.41 收掉了,翻旧消息全靠
 * 这里:滚到顶就替用户点一次那个按钮 —— 走的是同一段 loadMessages({older:true})(同一套
 * 游标、重试与失败话),只是没有按钮可点。四条节流:窄屏以外不接管(桌面照旧点按钮)、
 * 一次进顶只拉一页(要再拉得先离开顶区)、上一页还在路上不重入、失败之后不自动重来
 * (消息区顶上那句「加载失败 + 重试」还在,由用户决定)。 */
const AUTO_OLDER_TOP = 120; // 离顶多少 px 内算「到顶了」(手指回弹也会经过这里)
let autoOlderArmed = true;  // 上膛:进过顶区没有(离开顶区才重新上膛,免得一页接一页地拉)
let autoOlderBusy = false;  // 上一页还在路上
let autoOlderWired = false; // 重复接线不重复挂监听

async function autoLoadOlder(box) {
  // §8.55 窄屏照旧;桌面只有实测慢链路才接管(慢链路首屏也只拉 30 条,得能接着翻)
  if (!document.documentElement.classList.contains('narrow') && !slowLink()) return;
  if (autoOlderBusy || !autoOlderArmed) return;
  if (!store.msgOlderCursor) return; // 没有更旧的了
  if (store.msgError) return;        // 上一页失败过:让用户按「重试」,别自己循环撞
  if (box.scrollTop > AUTO_OLDER_TOP) return;
  autoOlderArmed = false;
  autoOlderBusy = true;
  const at = scrollAnchor(); // 拉之前:眼前那条是谁、在屏上什么位置
  try {
    await loadMessages({ older: true });
  } finally {
    autoOlderBusy = false;
  }
  /* 新拉的都在眼前这条【上面】。不把人放回原地的话,浏览器会守着 scrollTop(探针实测一直是
   * 0),眼前这一屏就整个换成刚拉回来的那一页 —— 手机上表现成「一滚到顶就被顶到会话开头」。
   * 用现成的锚点那套(applyScrollAnchor):还是这条消息、还在屏上原来的位置。
   * 只在用户没趁机滚走时动手(离原来那个位置在一个顶区之内)。 */
  if (at && at.id && Math.abs($('#messages').scrollTop - at.top) <= AUTO_OLDER_TOP) applyScrollAnchor(at);
  /* 上一页还在路上时用户又挪到过顶区(那时上膛没被消耗掉,因为这一趟还没腾出手):他
   * 停下来就不会再派发 scroll 了,窄屏上那个按钮又已经收起来,所以这里补一发 ——
   * 不补的话他只能再挪一次。上膛在真拉之前就被打掉,所以这条不会自己连拉。 */
  if (autoOlderArmed) autoLoadOlder(box);
}

function setupAutoOlder() {
  if (autoOlderWired) return;
  autoOlderWired = true;
  const box = $('#messages');
  box.addEventListener('scroll', () => {
    if (box.scrollTop > AUTO_OLDER_TOP) { autoOlderArmed = true; return; }
    autoLoadOlder(box);
  }, { passive: true });
}

/* ---------------- 一键回底(TUI 的 "Jump to latest ↓") ----------------
 * TUI 那边是消息区下沿一行右对齐的 "Jump to latest ↓",只在「你没停在最底部」时出现,
 * 键位是 session.last(End / ctrl+alt+g)。这里做成贴在消息区右下角的小片(sticky)。
 *
 * 「在不在底部」只有这一个口径:BOTTOM_SLACK。下面 renderMessages() 与 paintLiveDelta()
 * 的自动跟随也用它 —— 两处各写一个数(80 / 100)迟早会漂移,表现就是「明明跟着跳了,
 * 按钮却还杵在那儿」。往上翻着的时候新内容进来,自动跟随会让路,按钮则露出来。
 */
const BOTTOM_SLACK = 80;

/* 「跳到最新」按钮的引用。#messages 在切会话(selectSession)与取消选中(clearSelection)时会被
 * innerHTML 清空,按钮作为它的子元素会被一起抹掉 —— 所以引用得留在外面,
 * 清空之后由 updateJumpLatest() 自己搬回滚口末尾(别去每个清空点各补一行,那种补法迟早漏一个)。 */
let jumpBtn = null;

/* 纯几何:离底 < BOTTOM_SLACK 就算「停在最底部」。刻意不看任何全局状态 ——
 * 一边是离线可断言(测试直接喂一个 {scrollHeight, scrollTop, clientHeight}),一边是
 * 「容器变矮把离底距离撑大」这件事必须由 updateJumpLatest() 去解释,不能塞在这里。 */
function atBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < BOTTOM_SLACK;
}

/* 「贴底」这个动作只有一个实现:滚到底,并把这次看到的 scrollTop 记下来 ——
 * 下次滚动才分得清「用户自己往上滚」和「内容长长 / 容器变矮」。 */
function pinBottom(box) {
  if (!box) return;
  box.scrollTop = box.scrollHeight;
  store.lastTop = box.scrollTop;
}

/* store.nearBottom(跟随中?)+ 「跳到最新」按钮显隐的唯一写点。atB 是 boolean 时调用方
 * 已经量好了(测试 / 位置已知),其余情况(滚动事件塞进来的是 Event)现量一次。
 *
 * 现量这一次不能把 atBottom() 的结果直接当结论:容器变矮(#状态条出现、底板展开、
 * #asks 弹出、软键盘顶起)与内容变长都会让「离底距离」变大,而那【不是】用户往上滚 ——
 * 直接采信就会把跟随关掉,表现成「明明一直贴在底,忽然不跟了,得点一下跳到最新」。
 * 所以只认两条:离底够近 → 跟随;scrollTop 比上次记下的变小了 → 用户自己往上滚了,让路。
 * 其余(内容变长 / 容器变矮)维持原样,跟随中就把底部重新贴住。 */
function updateJumpLatest(atB) {
  const box = $('#messages');
  if (box) {
    if (typeof atB === 'boolean') {
      store.nearBottom = atB;
    } else {
      const top = box.scrollTop;
      if (atBottom(box)) store.nearBottom = true;
      else if (top < store.lastTop - 1) store.nearBottom = false;
      store.lastTop = top;
    }
  }
  if (!jumpBtn || !box) return store.nearBottom; // 老测试页没有这个按钮 —— 什么都不做
  if (jumpBtn.parentElement !== box) box.appendChild(jumpBtn); // 被清空过 → 搬回末尾
  // 没选中会话、或者已经停在底部 → 收起来(它正是「不在底部」时才该出现的东西)
  jumpBtn.hidden = !store.selected || store.nearBottom;
  return store.nearBottom;
}

function jumpToLatest() {
  pinBottom($('#messages'));
  updateJumpLatest(true); // 刚贴的底,位置已知,不用再量
}

/* cvmany(content-visibility: auto)下 scrollHeight 是【估值】:贴完底之后浏览器才把
 * 离屏元素的估值落定 —— 估值一动 scrollHeight 就变,浏览器还会把 scrollTop 夹回去。
 * 于是「明明贴了底」变成停在最新消息上面几百像素(§8.35 实测竖屏 466px,桌面那档
 * 历史上 1473px),而且【不再有渲染来纠正它】:那条会话要是安静下来,就永远停在那儿。
 *
 * 贴完底之后补几帧,跟到 scrollHeight 稳住为止:
 *   - 只有真的变了才重新贴(干净时读 scrollHeight 是一次廉价读,不白贴);
 *   - 用户一往上滚就停手(store.nearBottom 被滚动监听翻成 false);
 *   - 又渲染/又切会话就作废(repinSeq,见 renderMessages 与 selectSession);
 *   - 短会话压根没有 cvmany,不走这条路。
 *
 * §8.46:原来还压着一个 800ms 的【时间】预算 —— 跟高度没关系,只是赌「估值落定会在
 * 800ms 内」。改成盯高度:
 *   ① 高度连续 REPIN_STABLE_FRAMES 帧没变就收手(估值落定实测 400ms 内,但没必要干等);
 *      REPIN_MAX_MS 只当自保 —— 内容一直在长时别把 rAF 挂到天荒地老;
 *   ② 真正「图迟一步撑开」那种跟时间赌不赢(解码可能几秒后才完):另起一个
 *      ResizeObserver 盯 #messages 里的内容元素 —— 高度一变(估值落定 / 图撑开),
 *      只要还贴着底就补贴一次。没有时间窗口,也不常驻 rAF(空闲时零开销);
 *   ③ 用户自己点开 <details> 也会让内容长高,那不是「迟到的东西」:刚点过的 400ms 内
 *      不抢着贴(以前的时间预算天然躲开了这一类,别在改成盯高度后把它弄丢)。 */
const REPIN_STABLE_FRAMES = 2;
const REPIN_MAX_MS = 3000;
const REPIN_GESTURE_MS = 400;
let repinSeq = 0;

function repinUntilStable(box) {
  if (!box) return;
  const seq = ++repinSeq;
  const t0 = performance.now();
  let prev = -1;
  let stable = 0;
  const step = () => {
    if (seq !== repinSeq || !store.nearBottom) return;
    const h = box.scrollHeight;
    if (h !== prev) {
      prev = h;
      stable = 0;
      pinBottom(box);
    } else if (++stable >= REPIN_STABLE_FRAMES) {
      return; // 高度稳住了:这一轮采样结束(不用等满 REPIN_MAX_MS)
    }
    if (performance.now() - t0 < REPIN_MAX_MS) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* 「盯内容高度」的第二只眼(§8.46 ②):ResizeObserver 盯 #messages 的每个直接子元素。
 * renderMessages 收尾时 sync 一次(新建 / 换掉的节点跟着换);高度一变就补贴一次 ——
 * 判定仍旧只有「还贴着底」(store.nearBottom),用户翻上去了绝不把人拽下来。 */
let repinObs = null;
const repinSeen = new Set();

function syncRepinWatch() {
  const box = $('#messages');
  if (!box || typeof ResizeObserver !== 'function') return;
  if (!repinObs) {
    repinObs = new ResizeObserver(() => {
      if (!store.selected || !store.nearBottom) return;
      // 刚点过(多半是点开 <details> / 点消息里的按钮):内容长高是用户自己要的,别抢
      if (Date.now() - (store.gestureAt || 0) < REPIN_GESTURE_MS) return;
      pinBottom(box);
      updateJumpLatest(true);
    });
  }
  for (const el of Array.from(box.children)) {
    if (repinSeen.has(el)) continue;
    repinSeen.add(el);
    repinObs.observe(el);
  }
  for (const el of repinSeen) {
    if (el.parentElement === box) continue;
    repinSeen.delete(el);
    repinObs.unobserve(el);
  }
}

function setupRepinWatch() {
  syncRepinWatch();
  if (store.repinWired) return;
  store.repinWired = true;
  document.addEventListener('click', () => { store.gestureAt = Date.now(); }, true);
}

function setupJumpLatest() {
  const btn = $('#jumpLatest');
  const box = $('#messages');
  if (!btn || !box) return;
  jumpBtn = btn;
  if (btn.dataset.wired === '1') {
    updateJumpLatest();
    return;
  }
  btn.dataset.wired = '1';
  btn.addEventListener('click', jumpToLatest);
  // 手滚 / 惯性 / 拖滚动条都走这一条。不节流:一次减法加一次 hidden 赋值
  box.addEventListener('scroll', updateJumpLatest, { passive: true });
  // 容器变矮(状态条出现 / 底板展开 / #asks 弹出 / 软键盘顶起)会把底部顶出可视区 ——
  // 跟随状态没变,可是得【立刻】重新贴住,不能等下一次渲染(一条消息都不再来的话就永远贴着不动了)。
  // 只在跟随时贴;用户往上翻着的时候一动不动。
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (store.nearBottom) pinBottom(box);
    }).observe(box);
  }
  updateJumpLatest();
}

/* --------- 消息区末尾那条状态行(正在加载 / 加载失败 + 重试,§8.34)---------
 * 和「跳到最新」同一个套路:#messages 在切会话与取消选中时会被 innerHTML 清空,
 * 所以引用留在外面(paintMsgState 自己搬回末尾),节点本身写在 index.html 里。
 *
 * 两条纪律:
 *   ① 只在这件事【真的值得说】时露面 —— 「正在加载消息…」要慢过 MSG_LOADING_DELAY_MS 才露,
 *      不然本机那种 30ms 就回来的会话每次切都会闪一下;
 *   ② 失败必须留下证据(原因 + 一个「重试」),宁可丑也不能像原来那样一片空白,
 *      让人以为「这个会话本来就没内容」。 */
let msgStateEl = null;
let msgStateText = null;
let msgRetryBtn = null;
let msgLoadingTimer = null;

function setMsgLoading(on) {
  clearTimeout(msgLoadingTimer);
  msgLoadingTimer = null;
  if (!on) {
    store.msgLoading = false;
    paintMsgState(); // 这一下同时把上一次的失败话撤掉(成功收尾走的就是这里)
    return;
  }
  if (store.msgError) {
    store.msgError = ''; // 新的一次拉取开始了:上一次的失败话先撤掉,免得两种状态叠一起
    paintMsgState();
  }
  if (store.msgLoading) return;
  msgLoadingTimer = setTimeout(() => {
    msgLoadingTimer = null;
    store.msgLoading = true;
    paintMsgState();
  }, MSG_LOADING_DELAY_MS);
}

function paintMsgState() {
  const box = $('#messages');
  if (!box || !msgStateEl) return; // 老测试页没有这个节点 —— 什么都不做
  if (msgStateEl.parentElement !== box) box.appendChild(msgStateEl);
  const bad = !!store.msgError;
  const show = bad || store.msgLoading;
  msgStateEl.classList.toggle('bad', bad);
  msgStateEl.hidden = !show;
  if (!show) return;
  msgStateText.textContent = bad ? '加载失败:' + store.msgError : '正在加载消息…';
  if (msgRetryBtn) msgRetryBtn.hidden = !bad;
}

function setupMsgState() {
  msgStateEl = $('#msgState');
  if (!msgStateEl) return;
  msgStateText = $('#msgStateText');
  msgRetryBtn = $('#msRetry');
  if (msgRetryBtn && msgRetryBtn.dataset.wired !== '1') {
    msgRetryBtn.dataset.wired = '1';
    msgRetryBtn.addEventListener('click', () => loadMessages({ older: false }));
  }
  paintMsgState();
}

/* 左栏会话列表的状态行(§8.45)。与上面 #msgState 同一个路子,只是挂在 #listpane 里:
 *   - 失败必须留下证据:原因 + 一个「重试」(以前只有 console.error,左栏安静地停在
 *     旧数据 /「共 0 个会话」上 —— 用户以为「今天真的没有会话」);
 *   - 「正在加载会话…」慢过 LIST_LOADING_DELAY_MS 才露,本机那种几十毫秒就回来的
 *     不闪一下(请求要是挂住不 reject,也是靠它才看得见);
 *   - 重试 = 从头拉一遍(reset):失败那次往往连游标都没拿到,接着往后翻没有意义。 */
const LIST_LOADING_DELAY_MS = 250;
let listStateEl = null;
let listStateText = null;
let listRetryBtn = null;
let listLoadingTimer = null;

function setListLoading(on) {
  clearTimeout(listLoadingTimer);
  listLoadingTimer = null;
  if (!on) {
    store.listLoading = false;
    paintListState(); // 收尾(成功/失败)都走这里:失败话由 store.listError 决定
    return;
  }
  if (store.listError) {
    store.listError = ''; // 新的一次拉取开始了:上一次的失败话先撤掉
    paintListState();
  }
  if (store.listLoading) return;
  listLoadingTimer = setTimeout(() => {
    listLoadingTimer = null;
    store.listLoading = true;
    paintListState();
  }, LIST_LOADING_DELAY_MS);
}

function paintListState() {
  const pane = $('#listpane');
  if (!pane || !listStateEl) return; // 老测试页没有这两个节点 —— 什么都不做
  if (listStateEl.parentElement !== pane) {
    // 被人清空过 #listpane 就搬回来;位置仍按 index.html 的顺序(在 #loadMore 之前)
    const more = $('#loadMore');
    pane.insertBefore(listStateEl, more && more.parentElement === pane ? more : null);
  }
  const bad = !!store.listError;
  const show = bad || store.listLoading;
  listStateEl.classList.toggle('bad', bad);
  listStateEl.hidden = !show;
  if (listStateText) listStateText.textContent = bad ? '加载失败:' + store.listError : '正在加载会话…';
  if (listRetryBtn) listRetryBtn.hidden = !bad;
}

function setupListState() {
  listStateEl = $('#listState');
  if (!listStateEl) return;
  listStateText = $('#listStateText');
  listRetryBtn = $('#lsRetry');
  if (listRetryBtn && listRetryBtn.dataset.wired !== '1') {
    listRetryBtn.dataset.wired = '1';
    listRetryBtn.addEventListener('click', () => loadSessions({ reset: true }));
  }
  paintListState();
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
  const prev = store.selected;
  // 离开上一个会话前,先把它读到哪记下来(H 组 3)
  if (prev && prev !== id) saveScrollAnchor();
  // §8.55 切走的这一份先留在内存里,切回来时先用它顶上(再后台对账)
  if (prev && prev !== id) cacheCurrentMessages();
  // 只有「刷新恢复」会先塞 store.restoreScroll;从列表点进来一律跳到底部看最新消息
  const rs = store.restoreScroll && store.restoreScroll.sid === id ? store.restoreScroll.anchor : null;
  store.restoreScroll = rs;
  store.selected = id;
  persistSelected(id);
  touchTab(id); // §8.59 打开过的会话自动进标签栏
  /* §8.55 从别的会话切回来 → 缓存命中就先画,不空着等请求。
   * prev 为空(首屏 / 刷新恢复 / 取消选中后重选)不走缓存,行为和以前一样。 */
  const cached = prev && prev !== id ? store.msgCache.get(id) : null;
  store.messages.clear();
  if (cached) cached.messages.forEach((m, mid) => store.messages.set(mid, m));
  store.msgOlderCursor = cached ? cached.cursor || null : null;
  store.pending = false;
  store.forceBottom = !rs;
  store.lastTop = 0; // 滚口要清空,上个会话的 scrollTop 不能拿来跟新会话比(会被当成「用户往上滚」)
  clearAttachments(); // 待发送附件属于上一个会话,不带过去(H 组 6)
  closeMentions();
  closeCommands();
  // 输入历史是每会话独立的(I 组):切走后不再把游标留在上一条
  store.histAt = -1;
  store.histDraft = '';
  store.mentionHits.clear();
  renderSessions();
  const s = store.sessions.get(id);
  paintChatHeader(s);
  msgEls.clear();
  $('#messages').innerHTML = '';
  store.msgError = ''; // 切会话了:上一个会话的失败/加载状态都不该跟过来
  store.msgSeq++; // 这一下就把在途的响应与重试作废(下面 loadMessages 还会再记一代)
  repinSeq++; // 上一会话「贴完底再跟几帧」那一轮也作废
  setMsgLoading(false);
  paintMsgState();
  renderAsks();
  renderInbox();
  renderChatOps();
  updateChatStatus();
  syncNarrowView();
  revealActiveTab(); // §8.59 窄屏刚把聊天区露出来,再对齐一次当前标签
  /* 深链(#<sid>)或很久以前的会话可能不在当前列表页里(列表只拉最近一页,这里拿不到
   * 它的 location)。补拉一次会话本身 —— 工具栏的 agent/model、提示栏的工程路径都要它,
   * 头部那排操作也要拿它把「归档 / 取消归档」校正过来(§8.39)。
   * 刻意不 await:不能让这条网络往返改掉选会话的时序(会跟列表刷新抢);
   * 也刻意排在下面那组【之前】——那组里任何一个卡住,都不该把这条一起拖住。 */
  if (!s) refreshSessionInfo(id);
  if (cached) renderMessages(); // §8.55 先把旧内容顶上来,网络那一趟在后台安静跑
  // 缓存很新(刚看过 <1.5s)就不必再对账;其余情况走 quiet + now,不显示加载行、也不等 4s 间隔
  const fresh = cached && Date.now() - cached.at < MSG_CACHE_FRESH_MS;
  await Promise.all([
    fresh ? Promise.resolve() : loadMessages({ older: false, auto: !!cached, now: !!cached }),
    loadAsks(id),
    loadInbox(id),
    renderControls(s),
  ]);
}

/* 头部标题 + 更新时间/项目号。工程目录挪到了输入框下面的提示栏(#promptFooter)里 ——
 * 跟 TUI 的 prompt.footer.location 一个位置,这里只留更新时间与项目号。 */
function paintChatHeader(s) {
  $('#chatTitle').textContent = s ? s.title || '(无标题)' : store.selected || '';
  $('#chatMeta').textContent = [
    s && s.time && s.time.updated ? '更新 ' + rel(s.time.updated) : '',
    s && s.projectID ? s.projectID.slice(0, 8) : '',
  ]
    .filter(Boolean)
    .join('  ·  ');
  syncCtxInfoHome(); // §8.43:深链直接进会话时也把用量那格摆对家(幂等)
}

/* 列表页里没有这个会话时,单独问一次服务端把它补进 store,再补画用到它的几处。
 * 只认「带 id 的对象」—— 服务端对不存在的会话返回的是空数组([]),照单全收会把
 * 真会话冲成一个空壳。 */
function refreshSessionInfo(id) {
  api('/api/session/' + enc(id))
    .then((j) => {
      const info = j && j.data;
      if (!info || typeof info !== 'object' || Array.isArray(info) || !info.id) return;
      if (store.selected !== id) return; // 期间切走了
      const merged = Object.assign({}, info);
      if (!merged.location && merged.directory) merged.location = { directory: merged.directory };
      store.sessions.set(id, merged);
      renderSessions();
      paintChatHeader(merged);
      renderChatOps(); // 「归档 / 取消归档」的文案要拿会话信息才准(§8.39)
      renderControls(merged);
      paintContextUsage();
    })
    .catch(() => {
      /* 拿不到就照旧按空处理 */
    });
}

/* 拉消息失败不许一声不响(§8.34):手机上一个 12MB 的会话首页(工具 part 里塞了整份文件/截图)
 * 可能下几十秒,也可能下到一半被掐断。原来 api() 抛出 → 这里的 catch 一吞,消息区就永远是空的,
 * 而标题、状态、操作行全都好好的 —— 用户看到的就是「打开这个会话一片空白」,等到别的机器上
 * 回了句话、事件把对账重新拉起来,内容才忽然出现。这里改成:自动重试两次(退避 0.8s / 2.5s),
 * 还不行才把原因画到消息区末尾,带一个「重试」按钮。 */
const MSG_TRIES = 3; // 首发 + 2 次重试
const MSG_RETRY_MS = [800, 2500];
const MSG_LOADING_DELAY_MS = 250; // 这么快就回来了就不闪「正在加载消息…」这一下

/* 一页拉多少条:手机的用法是「看一眼」,而首屏体量差得很远 —— 实测某个会话
 * 100 条 = 12.9MB、最新 30 条 = 2.1MB(大头是 tool part 里带回的整份文件与截图,
 * 见 §8.34)。所以窄屏按 30 条一页,桌面照旧 100。翻旧仍然走「加载更旧消息」的游标,
 * 步长跟着这套走(不然翻一页又拉回 12MB)。
 * §8.55:经 VPN 的桌面也算「看一眼」的那一档 —— 首屏那一趟实测慢就按 30 条,
 * 往上滚仍然自动带更旧的一页(autoLoadOlder 同一套判定)。 */
const MSG_PAGE_WIDE = 100;
const MSG_PAGE_NARROW = 30;

/* 首屏会话列表那一趟的往返时间(RTT + 传输 + 解析):内网通常 < 20ms,VPN 是 200ms
 * 起步,两者中间空得很。只量第一次,量到一次就够了。 */
const SLOW_SAMPLE_MS = 180;

function noteNetSample(ms) {
  if (store.netMeasured) return;
  store.netMeasured = true;
  if (ms >= SLOW_SAMPLE_MS) store.netSlow = true;
}

/* navigator.connection 只在 Chromium 系可用(手机/Edge 都有),当个旁证:
 * 真正的判据还是上面那次实测。两项都认不出慢时才回落到 100 条。 */
function slowLink() {
  if (store.netSlow) return true;
  const c = typeof navigator !== 'undefined' &&
    (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
  if (!c) return false;
  if (c.effectiveType && /(^|-)2g$|(^|-)3g$/.test(c.effectiveType)) return true;
  if (typeof c.rtt === 'number' && c.rtt >= 400) return true;
  return false;
}

function msgPageSize() {
  return (document.documentElement.classList.contains('narrow') || slowLink())
    ? MSG_PAGE_NARROW
    : MSG_PAGE_WIDE;
}

/* §8.55 内存缓存:只缓存成功拿到过的消息页(失败的空壳不缓存)。
 * 切走时快照;回来后先画快照,再走一次 quiet 对账。最多留 6 个会话,
 * 超出按插入顺序丢最旧的那个(Map 的 set 会把已存在的键挪到末尾)。 */
const MSG_CACHE_MAX = 6;
const MSG_CACHE_FRESH_MS = 1500;

function cacheCurrentMessages() {
  const id = store.selected;
  if (!id || !store.messages.size || store.msgError) return;
  store.msgCache.delete(id);
  store.msgCache.set(id, {
    messages: new Map(store.messages),
    cursor: store.msgOlderCursor,
    at: Date.now(),
  });
  while (store.msgCache.size > MSG_CACHE_MAX) {
    store.msgCache.delete(store.msgCache.keys().next().value);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadMessages(opts) {
  opts = opts || {};
  const id = store.selected;
  if (!id) return;
  const quiet = !!opts.auto; // 后台对账:不点亮状态行、失败不盖界面
  if (quiet) {
    if (msgLoadBusy) {
      if (!opts.now) { msgAutoQueued = true; return; } // 已有一条在飞:合并成一次
      // 缓存命中后的第一次对账:旧那一代立刻作废,别让它继续占带宽
      try { if (msgAbort) msgAbort.abort(); } catch (_) {}
    }
    if (!opts.now) {
      const wait = msgLastDone ? MSG_AUTO_GAP_MS - (Date.now() - msgLastDone) : 0;
      if (wait > 0) { scheduleAutoMsg(wait); return; } // 刚拉过:隔一会儿再来,别把 VPN 打满
    }
  } else if (msgAbort) {
    // 前台请求(切会话/点重试)优先:上一轮自动对账就地作废,别让它继续占带宽
    try { msgAbort.abort(); } catch (_) {}
  }
  // 带游标时【不能】再带 order:服务端会 400(实测 `Cursor cannot be combined with order`)
  // —— 方向本来就编在游标里(游标是个 base64 的 {id, order, direction})。
  // 原来两样一起发,「加载更旧消息」每次都被打回,点了像没反应(api() 抛出 → 静默 catch)。
  const q = new URLSearchParams({ limit: String(msgPageSize()) });
  if (opts.older) {
    if (!store.msgOlderCursor) return;
    q.set('cursor', store.msgOlderCursor);
  } else {
    q.set('order', 'desc');
    if (!quiet) store.msgError = '';
    autoOlderArmed = true; // 新的一页(切会话/重拉首屏)重新上膛:下一回到顶又能自动拉
  }
  if (!quiet) setMsgLoading(true);
  const url = '/api/session/' + encodeURIComponent(id) + '/message?' + q.toString();
  const seq = ++store.msgSeq; // 这一代请求;再有别的请求进来,这一代(含它的重试)就地作废
  const gen = ++msgLoadGen;
  const ac = new AbortController();
  msgAbort = ac;
  msgLoadBusy = true;
  try {
    for (let attempt = 0; attempt < MSG_TRIES; attempt++) {
      if (attempt) {
        await sleep(MSG_RETRY_MS[attempt - 1] || 2500);
        if (seq !== store.msgSeq || store.selected !== id || gen !== msgLoadGen) return;
      }
      try {
        const j = await api(url, { signal: ac.signal });
        /* 等待期间可能已经切走了(SSE 事件驱动的防抖对账正好压在一次切换上):这份响应属于
         * 上一个会话,写进去就会让新会话显示别人的消息,连头部那枚上下文用量也跟着错。
         * store.messages 只有当前会话一份,所以这里按 id 复查一次再写。 */
        if (seq !== store.msgSeq || store.selected !== id) return;
        // 「空数组」和「没拿到」必须分得开:响应不成形就当失败去重试,别画成「这个会话没有消息」
        if (!j || !Array.isArray(j.data)) throw new Error('响应里没有消息数组');
        j.data.forEach((m) => store.messages.set(m.id, m));
        store.msgOlderCursor = (j.cursor && j.cursor.next) || null;
        pruneLive();
        store.msgError = '';
        setMsgLoading(false);
        renderMessages();
        return;
      } catch (e) {
        if (e && (e.name === 'AbortError' || ac.signal.aborted)) return; // 被新一轮取代,静默收工
        console.error('loadMessages', e);
        if (seq !== store.msgSeq || store.selected !== id || gen !== msgLoadGen) return;
        if (attempt < MSG_TRIES - 1) continue;
        if (quiet) return; // 后台对账失败不打扰画面:下一次事件/轮询会再试
        store.msgError = (e && e.message) || String(e);
        setMsgLoading(false);
        paintMsgState(); // 空着也要把话说清楚:加载失败:<原因> + 一个「重试」
      }
    }
  } finally {
    if (gen === msgLoadGen) {
      msgLoadBusy = false;
      msgLastDone = Date.now();
      if (msgAutoQueued) {
        msgAutoQueued = false;
        scheduleAutoMsg(MSG_AUTO_GAP_MS);
      }
    }
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
  // 运行中/流式【什么都不画】:对话头部那套(标题旁的「● 运行中」+ 进度条)已经把这个状态
  // 说清楚了,工具行再来一个标记就是重复 —— 手机竖屏上那个「运行中」还会折成两行。
  // cls 留着('run')是为了别处按状态分类的代码不用改(见 test/ui-stream.html);
  // toolHead 见 icon/label 双双为空就整个 <span> 都不输出,不留空壳。
  const map = {
    completed: { icon: '✓', cls: 'ok', label: '' },
    error: { icon: '✗', cls: 'err', label: '出错' },
    running: { icon: '', cls: 'run', label: '' },
    streaming: { icon: '', cls: 'run', label: '' },
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

/* ---------- §8.49 diff 行内高亮:成对的 -行/+行里,只有真正变了的字被点亮 ----------
 * 照 TUI 的 diffHighlightAdded / diffHighlightRemoved:统一视图里相邻的删段与增段
 * 按位置配对,先剥掉公共前后缀,中段按字符做 LCS,对不上的字才包 <span class="hl">。
 * 纯函数,离线断言在 test/ui-tools.html。
 */
const HL_MAX_CHARS = 400;    // 剥掉公共前后缀后,单侧还长于这个数就不做 LCS(整段点亮)
const HL_MAX_CELLS = 160000; // 两侧剩余长度的乘积上限(400 × 400)
const HL_MAX_PAIRS = 2000;   // 一张卡片最多算这么多对(超出的整行着色,免得大补丁卡住)
const HL_SURROGATE = /[\uD800-\uDFFF]/; // 代理对按字符切会切坏,直接退回整段

// 把「变了的字符下标」并成升序区间:[[start, end), ...]
function hlFold(idx, off) {
  const out = [];
  for (let i = 0; i < idx.length; i++) {
    const s = off + idx[i];
    const last = out[out.length - 1];
    if (last && last[1] === s) last[1] = s + 1;
    else out.push([s, s + 1]);
  }
  return out;
}

// 两侧「变了」的区间。没有变化时两边都是空数组。
function hlRanges(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  if (a === b) return { del: [], add: [] };
  // 含代理对(emoji 等)的行按 code unit 切会切坏一对,直接整行点亮
  if (HL_SURROGATE.test(a) || HL_SURROGATE.test(b)) {
    return { del: a.length ? [[0, a.length]] : [], add: b.length ? [[0, b.length]] : [] };
  }
  const la = a.length;
  const lb = b.length;
  const lim = Math.min(la, lb);
  let pre = 0;
  while (pre < lim && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  let suf = 0;
  while (suf < lim - pre && a.charCodeAt(la - 1 - suf) === b.charCodeAt(lb - 1 - suf)) suf++;
  const am = a.slice(pre, la - suf);
  const bm = b.slice(pre, lb - suf);
  const whole = () => ({
    del: am.length ? [[pre, pre + am.length]] : [],
    add: bm.length ? [[pre, pre + bm.length]] : [],
  });
  // 纯增 / 纯删,或中段太长:不细算,整段点亮
  if (!am.length || !bm.length) return whole();
  if (am.length > HL_MAX_CHARS || bm.length > HL_MAX_CHARS ||
      am.length * bm.length > HL_MAX_CELLS) return whole();

  // LCS:dp[i][j] = am[i..] 与 bm[j..] 的最长公共子序列长度(倒着算,好回溯)
  const n = am.length;
  const m = bm.length;
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = am.charCodeAt(i) === bm.charCodeAt(j)
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const di = [];
  const ai = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (am.charCodeAt(i) === bm.charCodeAt(j)) { i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) di.push(i++);
    else ai.push(j++);
  }
  while (i < n) di.push(i++);
  while (j < m) ai.push(j++);
  return { del: hlFold(di, pre), add: hlFold(ai, pre) };
}

// 带变更点亮(和语法着色,§8.50)的源码片。ranges/spans 都可缺省。
function paintHtml(text, ranges, spans) {
  text = String(text == null ? '' : text);
  const hl = ranges || [];
  const tk = spans || [];
  if (!hl.length && !tk.length) return esc(text);
  const cuts = [0, text.length];
  for (let k = 0; k < hl.length; k++) { cuts.push(hl[k][0], hl[k][1]); }
  for (let k = 0; k < tk.length; k++) { cuts.push(tk[k].s, tk[k].e); }
  cuts.sort((x, y) => x - y);
  let html = '';
  let hi = 0;
  let ti = 0;
  for (let k = 0; k < cuts.length - 1; k++) {
    const s = cuts[k];
    const e = cuts[k + 1];
    if (e <= s) continue;
    while (hi < hl.length && hl[hi][1] <= s) hi++;
    while (ti < tk.length && tk[ti].e <= s) ti++;
    const on = hi < hl.length && hl[hi][0] <= s;
    const cls = ti < tk.length && tk[ti].s <= s && s < tk[ti].e ? tk[ti].cls : '';
    let piece = esc(text.slice(s, e));
    if (cls) piece = '<span class="tk ' + cls + '">' + piece + '</span>';
    if (on) piece = '<span class="hl">' + piece + '</span>';
    html += piece;
  }
  return html;
}

/* ---------- §8.50 语法着色:逐行分词,只上色不改变排版 ----------
 * 零依赖的极简分词器:注释 / 字符串 / 数字 / 关键字四类,认哪些扩展名见 SYN_EXT。
 * 不追求完备 —— 认错只影响观感,不影响正确性;认不出来(未知扩展名)就纯文本。
 * 逐行处理是刻意的:diff 的 hunk 会跳行,跨行块注释本来也对不上,别假装能追。
 * 纯函数,离线断言在 test/ui-tools.html。
 */
const SYN_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  json: 'json', jsonc: 'json', json5: 'json',
  go: 'go', rs: 'rs',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', ino: 'c',
  sh: 'sh', bash: 'sh', zsh: 'sh', ksh: 'sh',
  py: 'py', pyi: 'py',
  css: 'css', scss: 'css', less: 'css',
  md: 'md', markdown: 'md', mdx: 'md',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
};
const SYN_KW = {
  js: new Set(('as async await break case catch class const continue debugger default delete do else enum ' +
    'export extends false finally for from function get if implements import in instanceof interface let new ' +
    'null of package private protected public readonly return satisfies set static super switch this throw ' +
    'true try typeof undefined var void while with yield type declare namespace abstract infer keyof never ' +
    'unknown any string number boolean object symbol').split(' ')),
  json: new Set(['true', 'false', 'null']),
  go: new Set(('break case chan const continue default defer else fallthrough for func go goto if import ' +
    'interface map package range return select struct switch type var true false nil iota').split(' ')),
  rs: new Set(('as async await break const continue crate dyn else enum extern false fn for if impl in let ' +
    'loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where ' +
    'while').split(' ')),
  c: new Set(('auto break case char const continue default do double else enum extern float for goto if ' +
    'inline int long register restrict return short signed sizeof static struct switch typedef union ' +
    'unsigned void volatile while').split(' ')),
  sh: new Set(('if then else elif fi for while until do done case esac in function export local readonly ' +
    'declare return break continue').split(' ')),
  py: new Set(('and as assert async await break class continue def del elif else except False finally for ' +
    'from global if import in is lambda None nonlocal not or pass raise return True try while with yield').split(' ')),
};
const SYN_CFG = {
  js: { line: '//', block: '/*', quotes: ['"', "'", '`'], kw: 'js' },
  json: { quotes: ['"'], kw: 'json' },
  go: { line: '//', block: '/*', quotes: ['"', "'", '`'], kw: 'go' },
  rs: { line: '//', block: '/*', quotes: ['"'], kw: 'rs' },
  c: { line: '//', block: '/*', quotes: ['"', "'"], kw: 'c' },
  sh: { line: '#', hash: true, quotes: ['"', "'"], kw: 'sh' },
  py: { line: '#', quotes: ['"', "'"], kw: 'py' },
  css: { block: '/*', quotes: ['"', "'"], props: true },
};
const SYN_NUM = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const SYN_WORD = /[A-Za-z_$]/;
const SYN_WORD_REST = /[\w$]/;

// 文件路径 → 语言(认不出来返回空串,渲染时就是纯文本)
function langOf(path) {
  const p = String(path == null ? '' : path);
  const dot = p.lastIndexOf('.');
  if (dot < 0) return '';
  return SYN_EXT[p.slice(dot + 1).toLowerCase()] || '';
}

function synPush(out, s, e, cls) {
  if (e > s) out.push({ s: s, e: e, cls: cls });
}

// 注释 / 字符串 / 数字 / 关键字(js/ts/json/go/rs/c/h/sh/py/css 共用)
function synScanCode(text, cfg, out) {
  const kw = cfg.kw ? SYN_KW[cfg.kw] : null;
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (cfg.block && text.startsWith(cfg.block, i)) {
      const j = text.indexOf('*/', i + cfg.block.length);
      const e = j < 0 ? text.length : j + 2;
      synPush(out, i, e, 'com');
      i = e;
      continue;
    }
    if (cfg.line && text.startsWith(cfg.line, i) &&
        (!cfg.hash || i === 0 || /[\s;|&(]/.test(text.charAt(i - 1)))) {
      synPush(out, i, text.length, 'com');
      break;
    }
    if (cfg.quotes.indexOf(c) >= 0) {
      let j = i + 1;
      while (j < text.length) {
        if (text.charAt(j) === '\\') { j += 2; continue; }
        if (text.charAt(j) === c) { j++; break; }
        j++;
      }
      synPush(out, i, Math.min(j, text.length), 'str');
      i = j;
      continue;
    }
    if (cfg.props && c === '#') { // CSS 的十六进制颜色
      const m = /^#[0-9a-fA-F]{3,8}/.exec(text.slice(i));
      if (m) { synPush(out, i, i + m[0].length, 'num'); i += m[0].length; continue; }
    }
    if (c >= '0' && c <= '9' && (i === 0 || !/[\w$.]/.test(text.charAt(i - 1)))) {
      const m = SYN_NUM.exec(text.slice(i));
      if (m) { synPush(out, i, i + m[0].length, 'num'); i += m[0].length; continue; }
    }
    if (SYN_WORD.test(c)) {
      let j = i + 1;
      while (j < text.length && SYN_WORD_REST.test(text.charAt(j))) j++;
      const w = text.slice(i, j);
      if (cfg.props) {
        // CSS 属性名(color: …)与 @media 这类 at-rule
        let k = j;
        while (k < text.length && /\s/.test(text.charAt(k))) k++;
        if (text.charAt(k) === ':' || (i > 0 && text.charAt(i - 1) === '@')) synPush(out, i, j, 'kw');
      } else if (kw && kw.has(w)) synPush(out, i, j, 'kw');
      i = j;
      continue;
    }
    i++;
  }
}

function synScanMd(text, out) {
  if (/^\s{0,3}#{1,6}\s/.test(text)) { synPush(out, 0, text.length, 'kw'); return; }
  const re = /`[^`]*`/g;
  let m;
  while ((m = re.exec(text))) synPush(out, m.index, m.index + m[0].length, 'str');
}

function synScanHtml(text, out) {
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('<!--', i)) {
      const j = text.indexOf('-->', i + 4);
      const e = j < 0 ? text.length : j + 3;
      synPush(out, i, e, 'com');
      i = e;
      continue;
    }
    const c = text.charAt(i);
    if (c === '<') {
      let j = i + 1;
      if (text.charAt(j) === '/') j++;
      const st = j;
      while (j < text.length && /[A-Za-z0-9:_-]/.test(text.charAt(j))) j++;
      if (j > st) { synPush(out, i, j, 'kw'); i = j; continue; }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== c) j++;
      synPush(out, i, Math.min(j + 1, text.length), 'str');
      i = j + 1;
      continue;
    }
    i++;
  }
}

// 一行 → [{s, e, cls}](升序、互不重叠;空白与普通标识符不入表)
function syntaxSpans(text, lang) {
  const s = String(text == null ? '' : text);
  const out = [];
  if (lang === 'md') synScanMd(s, out);
  else if (lang === 'html') synScanHtml(s, out);
  else if (SYN_CFG[lang]) synScanCode(s, SYN_CFG[lang], out);
  return out;
}

// 每个 hunk 里连续的删段 + 紧随的增段按位置配对(第 i 个 - 对第 i 个 +)。
// 落单的增删不点亮(整行底色已经说了它是新加的 / 去掉的)。
function pairDiffRows(rows) {
  let paired = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].k !== 'del') continue;
    let j = i;
    while (j < rows.length && rows[j].k === 'del') j++;
    let k = j;
    while (k < rows.length && rows[k].k === 'add') k++;
    const n = Math.min(j - i, k - j);
    for (let x = 0; x < n; x++) {
      if (paired++ >= HL_MAX_PAIRS) continue;
      const d = hlRanges(rows[i + x].text, rows[j + x].text);
      rows[i + x].hl = d.del;
      rows[j + x].hl = d.add;
    }
    i = k - 1;
  }
  return rows;
}

function diffRowHtml(r, lang) {
  const ln =
    '<span class="ln o">' + (r.oldNo == null ? '' : r.oldNo) + '</span>' +
    '<span class="ln n">' + (r.newNo == null ? '' : r.newNo) + '</span>';
  const sign = r.k === 'add' ? '+' : r.k === 'del' ? '-' : ' ';
  // 增删行与上下文行都上语法色(行内高亮只落在增删行);hunk / meta 行保持原样
  const src = r.k === 'hunk' || r.k === 'meta'
    ? esc(r.text)
    : paintHtml(r.text, r.hl, syntaxSpans(r.text, lang));
  return '<div class="dl ' + r.k + '">' + ln +
    '<span class="sign">' + (r.k === 'hunk' || r.k === 'meta' ? '' : sign) + '</span>' +
    '<span class="src">' + src + '</span></div>';
}

function diffBadge(status) {
  // 文案照 TUI 的 ApplyPatch 块标题(added → `# Created`、deleted → `# Deleted`、其余 → `← Patched`)
  const map = {
    added: { label: '# Created', cls: 'add' },
    deleted: { label: '# Deleted', cls: 'del' },
    modified: { label: '← Patched', cls: 'mod' },
  };
  return map[status] || { label: '← Patched', cls: 'mod' };
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

// 多文件 diff:每文件一块「状态徽标 + 路径 + 增删统计」,下面接正文(统一视图或并排视图)。
/* §8.53 并排视图照 TUI 的偏好模型收口(§8.52 的后续):
 *   · 偏好是全局的、持久的(TUI 存 diffs.view;面板存 localStorage['ocs.diffView']);
 *   · 没记过 = auto:面板够宽就并排(TUI 的 MIN_SPLIT_WIDTH 是 100 格,折成 760px);
 *   · 只有 modified 的文件分栏(added / deleted 照 TUI 一律统一视图);
 *   · 分栏里长行按字符折行(TUI 的 wrapMode="char"),不再每侧横向滚。
 */
const DIFF_VIEW_KEY = 'ocs.diffView';
const DIFF_SPLIT_MIN_PX = 760;
let diffPrefCache = null;
let diffPrefMtime = 0;
let diffPrefWriting = 0;
let diffPrefSeq = 0;
let diffPrefMigrated = false;

function readLocalDiffPref() {
  try {
    const v = localStorage.getItem(DIFF_VIEW_KEY);
    if (v === 'auto' || v === 'split' || v === 'unified') return v;
  } catch (_) {} // 隐私模式下当「没记过」
  return null;
}

function diffViewPref() {
  if (!diffPrefCache) diffPrefCache = readLocalDiffPref() || 'auto';
  return diffPrefCache;
}

/* §8.60 TUI 在 cli.json 里改了 diffs.view → /__health 每 15s 带回来。
 * 只在「值变了」时重画;正在写回时先让本地乐观值站住,免得旧 health 响应把它打回去。 */
function applyServerDiffPref(view, mtime) {
  if (diffPrefWriting > 0) return false;
  if (view !== 'auto' && view !== 'split' && view !== 'unified') return false;
  const at = Number(mtime) || 0;
  if (at && at < diffPrefMtime) return false;
  const changed = view !== diffViewPref();
  diffPrefCache = view;
  if (at) diffPrefMtime = at;
  try { localStorage.setItem(DIFF_VIEW_KEY, view); } catch (_) {}
  if (changed && document.querySelector('#messages .dswap')) redrawDiffCards('');
  return true;
}

/* 面板里点「⇆ 并排」→ 立即按本地值重画,同时把 diffs.view 写回 cli.json。
 * 写失败只提示一句;下一次 health 会把 TUI 那本账重新同步回来。 */
function diffViewSet(v) {
  const next = (v === 'auto' || v === 'split' || v === 'unified') ? v : 'auto';
  diffPrefCache = next;
  try { localStorage.setItem(DIFF_VIEW_KEY, next); } catch (_) {}
  const seq = ++diffPrefSeq;
  diffPrefWriting++;
  return api('/__config/diffs', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ view: next }),
  }).then((j) => {
    if (seq !== diffPrefSeq) return;
    if (j && (j.view === 'auto' || j.view === 'split' || j.view === 'unified')) {
      diffPrefCache = j.view;
      try { localStorage.setItem(DIFF_VIEW_KEY, j.view); } catch (_) {}
      if (Number(j.mtime)) diffPrefMtime = Number(j.mtime);
    }
  }).catch((e) => {
    if (seq === diffPrefSeq) flash('并排偏好没写进 cli.json:' + ((e && e.message) || e), 'bad');
  }).then(() => {
    diffPrefWriting--;
  });
}

/* 首屏先读服务端那本账;cli.json 里还没有 view(旧版)时,把面板以前记在
 * localStorage 里的偏好迁过去一次 —— 之后两边就以 cli.json 为准。 */
async function loadDiffPref() {
  let j;
  try { j = await api('/__config/diffs'); } catch (_) { return; }
  if (!j) return;
  if (j.view === 'auto' || j.view === 'split' || j.view === 'unified') {
    applyServerDiffPref(j.view, j.mtime);
    return;
  }
  const local = readLocalDiffPref();
  if (!j.error && !diffPrefMigrated && (local === 'split' || local === 'unified')) {
    diffPrefMigrated = true;
    await diffViewSet(local);
  }
}

// 面板(聊天区)够不够宽放两栏;量 #messages,拿不到就退回窗口宽度
function diffWide() {
  const box = document.getElementById('messages');
  const w = box ? box.clientWidth : window.innerWidth;
  return w >= DIFF_SPLIT_MIN_PX;
}

// 渲染时的完整条件:窄屏一票否决,桌面再看宽度
function diffCanSplit() {
  return !document.documentElement.classList.contains('narrow') && diffWide();
}

// 纯判定:文件状态 + 偏好 + 面板宽度 → 分不分栏(断言在 test/ui-tools.html)
function diffViewWanted(status, pref, wide) {
  if (status !== 'modified') return false;
  if (!wide) return false;
  return pref !== 'unified';
}

function splitCellHtml(r, lang, side) {
  if (!r) return '<div class="side empty"></div>';
  const no = side === 'old' ? r.oldNo : r.newNo;
  const sign = r.k === 'add' ? '+' : r.k === 'del' ? '-' : ' ';
  return '<div class="side ' + side + '">' +
    '<span class="ln">' + (no == null ? '' : no) + '</span>' +
    '<span class="sign">' + sign + '</span>' +
    '<span class="src">' + paintHtml(r.text, r.hl, syntaxSpans(r.text, lang)) + '</span></div>';
}

// 并排视图:同一 hunk 里的删段与增段按位置左右对齐;上下文 / hunk / meta 行整行跨两栏。
// 一侧落单就给对面留一个空单元格(照 GitHub 的 split view)。
function splitRowsHtml(rows, lang) {
  let html = '';
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.k === 'del') {
      let j = i;
      while (j < rows.length && rows[j].k === 'del') j++;
      let k = j;
      while (k < rows.length && rows[k].k === 'add') k++;
      const n = Math.max(j - i, k - j);
      for (let x = 0; x < n; x++) {
        html += '<div class="dl pair">' + splitCellHtml(rows[i + x], lang, 'old') +
          splitCellHtml(rows[j + x], lang, 'new') + '</div>';
      }
      i = k;
      continue;
    }
    if (r.k === 'add') {
      html += '<div class="dl pair"><div class="side empty"></div>' +
        splitCellHtml(r, lang, 'new') + '</div>';
      i++;
      continue;
    }
    html += diffRowHtml(r, lang);
    i++;
  }
  return html;
}

function diffHtml(files, opts) {
  let html = '';
  const pid = (opts && opts.pid) || '';
  const pref = diffViewPref();
  // 窄屏永远统一视图(393px 切两条各 190px 没意义);桌面再看偏好与宽度
  const wide = diffCanSplit();
  for (const f of files || []) {
    const b = diffBadge(f && f.status);
    const lang = langOf(f && f.file);
    const rows = pairDiffRows(parsePatch(f && f.patch));
    const adds = typeof (f && f.additions) === 'number' ? f.additions : rows.filter((r) => r.k === 'add').length;
    const dels = typeof (f && f.deletions) === 'number' ? f.deletions : rows.filter((r) => r.k === 'del').length;
    // 没给 status 的(老数据)按 modified 处理,和 diffBadge 的兜底一致
    const status = (f && f.status) || 'modified';
    const split = diffViewWanted(status, pref, wide);
    html +=
      '<div class="dfile">' +
      '<span class="dbadge ' + b.cls + '">' + b.label + '</span>' +
      '<span class="dpath">' + esc(abbrevPath((f && f.file) || '')) + '</span>' +
      (adds ? '<span class="tadd">+' + adds + '</span>' : '') +
      (dels ? '<span class="tdel">-' + dels + '</span>' : '') +
      (rows.length && pid && status === 'modified'
        ? '<button type="button" class="dswap' + (split ? ' on' : '') + '" data-pid="' + esc(pid) +
          '" title="并排 / 统一视图(照 TUI 的 diffs.view)">⇆ 并排</button>'
        : '') +
      '</div>';
    if (!rows.length) {
      html += '<div class="dnote">' + (dels ? '-' + dels + ' line' + (dels !== 1 ? 's' : '') : '(no content)') + '</div>';
      continue;
    }
    html += split
      ? '<div class="diff split">' + splitRowsHtml(rows, lang) + '</div>'
      : '<div class="diff">' + rows.map((r) => diffRowHtml(r, lang)).join('') + '</div>';
  }
  return html;
}

// §8.52 并排 / 统一视图的开关(桌面专属;窄屏不出现按钮,渲染时也强制统一视图)
function findToolPart(pid) {
  for (const m of store.messages.values()) {
    const L = liveView(m.id);
    const list = (L && L.parts) || (m && m.content) || [];
    for (const p of list) if (p && p.id === pid) return p;
  }
  return null;
}

// §8.53 重画消息里所有带切换按钮的 diff 卡片(只动这些卡片,别的 details 不搬)。
// pid 非空时把那张卡片当锚点,高度变了就补滚动,让它留在原处。
function redrawDiffCards(pid) {
  const box = $('#messages');
  if (!box) return null;
  const tops = new Map();
  let anchor = null;
  for (const card of Array.from(box.querySelectorAll('details.tool'))) {
    const b = card.querySelector('.dswap');
    if (!b) continue;
    const id = b.getAttribute('data-pid') || '';
    const p = findToolPart(id);
    if (!p) continue;
    const open = card.open;
    const top = card.getBoundingClientRect().top;
    const tmp = document.createElement('div');
    tmp.innerHTML = toolHtml(p);
    const fresh = tmp.firstElementChild;
    if (!fresh) continue;
    fresh.open = open;
    card.replaceWith(fresh);
    tops.set(fresh, top);
    if (id === pid) anchor = fresh;
  }
  if (anchor && tops.has(anchor)) {
    const delta = anchor.getBoundingClientRect().top - tops.get(anchor);
    if (delta) box.scrollTop += delta;
  }
  return anchor;
}

// §8.53 切换是全局的(照 TUI 的 diff.toggle_view):先记偏好,再把所有 diff 卡片一起重画
// —— 并排是「这一屏的看片方式」,不是某一张卡片的私有状态。
function toggleDiffView(btn) {
  if (!btn || !btn.getAttribute) return false;
  const pid = btn.getAttribute('data-pid') || '';
  const splitNow = diffViewWanted('modified', diffViewPref(), diffCanSplit());
  diffViewSet(splitNow ? 'unified' : 'split');
  redrawDiffCards(pid);
  return true;
}

// §8.53 auto 档要跟着面板宽度走:窗口缩放、拖分栏条都算。只在「够不够宽」翻面时重画
// (TUI 的 splitAvailable() 也是这么随宽度重算的);平时的 resize 不动 DOM。
let diffWideSeen = null;
function syncDiffWidth() {
  const wide = diffCanSplit();
  if (diffWideSeen === null) { diffWideSeen = wide; return; }
  if (wide === diffWideSeen) return;
  diffWideSeen = wide;
  if (document.querySelector('#messages .dswap')) redrawDiffCards('');
}

function setupDiffView() {
  const box = $('#messages');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.dswap');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation(); // 卡片头在 summary 外面,但别让冒泡再触发别的点击处理
    toggleDiffView(btn);
  });
  diffWideSeen = diffCanSplit();
  if (typeof ResizeObserver === 'function') {
    const bump = debounce(syncDiffWidth, 120);
    new ResizeObserver(bump).observe(box);
  } else {
    window.addEventListener('resize', debounce(syncDiffWidth, 120));
  }
}

// write 工具的正文:按行号显示,不做增删着色(服务端没给 diff)。
function codeHtml(text, path) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const lang = langOf(path);
  return '<div class="diff code">' + lines.map((t, i) =>
    '<div class="dl ctx"><span class="ln o"></span><span class="ln n">' + (i + 1) + '</span>' +
    '<span class="sign"> </span><span class="src">' + paintHtml(t, null, syntaxSpans(t, lang)) + '</span></div>'
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
    return '<div class="dline">Error [' + line + ':' + col + '] ' + esc((d && d.message) || '') + '</div>';
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

/* 行首图标照 TUI 的每个工具组件(packages/tui/src/routes/session/index.tsx:
 * Read / Glob / Grep / WebFetch / WebSearch / Write / Edit / ApplyPatch / Shell /
 * Subagent / Question / Skill,其余落进 GenericTool)。别名与 TUI 的
 * packages/tui/src/util/tool-display.ts 里 canonicalToolName 一致。 */
const TOOL_ALIAS = { bash: 'shell', task: 'subagent', apply_patch: 'patch' };
const TOOL_ICONS = {
  read: '→', list: '→',
  glob: '✱', grep: '✱',
  webfetch: '%',
  websearch: '◈',
  write: '←', edit: '←', patch: '←',
  shell: '$',
  subagent: '✓',
  question: '→', skill: '→',
};

function toolKind(p) {
  const n = String((p && p.name) || '').toLowerCase();
  return TOOL_ALIAS[n] || n;
}

// 图标只分「出错 / 其余」两档;运行中由 toolHead 换成 spinner。
function toolIcon(p, override) {
  const st = (p && p.state && p.state.status) || (p && p.executed ? 'completed' : 'running');
  if (st === 'error') return '✗';
  if (override) return override;
  return TOOL_ICONS[toolKind(p)] || '✓';
}

function toolStr(v) {
  return v == null ? '' : String(v);
}

function toolNum(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/* 每个工具那一行的文案照 TUI 拆成两段:
 *   head → .tname(工具词:Read / Glob / # Wrote / …,shell 放命令本身)
 *   tail → .tdesc(余下上下文:路径、模式、命令 …)
 * TUI 是「行首图标 + 整行文案」,这边多切一刀只是让两个 span 各管各的省略号。 */
function toolLine(p) {
  const st = p.state || {};
  const md = st.metadata || {};
  const input = st.input && typeof st.input === 'object' ? st.input : {};
  const files = Array.isArray(md.files) ? md.files : [];
  const path = toolStr(input.path) || toolStr(md.filepath) || toolStr(files[0] && files[0].file);
  const show = abbrevPath(path); // 上屏用的缩略路径(会话目录下取相对、home 下取 ~)
  const kind = toolKind(p);

  if (kind === 'read') {
    let tail = show;
    const off = toolNum(input.offset);
    const lim = toolNum(input.limit);
    if (off !== null || lim !== null) {
      const from = off !== null && off > 0 ? off : 1; // TUI:offset 缺省当下起 1
      tail += ':' + from + (lim ? '-' + (from + lim - 1) : '');
    }
    return { head: 'Read', tail: tail };
  }
  if (kind === 'list') return { head: 'List', tail: show };
  // edit / write / patch:跑起来但还没拿到 files / content 时的那一行(拿到之后的块标题在 toolHtml 里)
  if (kind === 'edit') return { head: 'Edit', tail: show };
  if (kind === 'patch') return { head: 'Patch', tail: files.length > 1 ? files.length + ' files' : show };
  if (kind === 'write') return { head: 'Write', tail: show };
  if (kind === 'glob' || kind === 'grep') {
    let tail = '"' + toolStr(input.pattern) + '"';
    if (toolStr(input.path)) tail += ' in ' + abbrevPath(input.path);
    const n = toolNum(kind === 'glob' ? md.count : md.matches);
    if (n !== null) tail += ' (' + n + (n === 1 ? ' match)' : ' matches)');
    return { head: kind === 'glob' ? 'Glob' : 'Grep', tail: tail };
  }
  if (kind === 'webfetch') return { head: 'WebFetch', tail: toolStr(input.url) };
  if (kind === 'websearch') {
    const via = toolStr(md.provider);
    return { head: 'Web Search', tail: (via ? 'via ' + via + ' ' : '') + '"' + toolStr(input.query) + '"' };
  }
  if (kind === 'shell') {
    // TUI 的 ShellDisplay:命令前面按需接 `cd <workdir> && `,正文留给输出
    const wd = toolStr(input.workdir);
    const cmd = toolStr(input.command);
    const prefix = wd && wd !== '.' ? 'cd ' + wd + ' && ' : '';
    if (!cmd) return { head: '', tail: 'Writing command…' };
    return { head: prefix + cmd, tail: '' };
  }
  if (kind === 'subagent') {
    // TUI:`<Agent> Subagent — <说明> · <模型>`
    const agent = toolStr(input.agent) || toolStr(input.subagent_type) || 'General';
    const desc = toolStr(input.description);
    const model = toolStr(input.model);
    return {
      head: agent.charAt(0).toUpperCase() + agent.slice(1) + ' Subagent',
      tail: desc ? '— ' + desc + (model ? ' · ' + model : '') : model,
    };
  }
  if (kind === 'question') {
    const n = Array.isArray(input.questions) ? input.questions.length : 0;
    return { head: 'Asked ' + n, tail: n === 1 ? 'question' : 'questions' };
  }
  if (kind === 'skill') {
    const sk = toolStr(md.name) || toolStr(input.id);
    return { head: 'Skill', tail: sk ? '"' + sk + '"' : '' };
  }
  // 通用工具:TUI 是 `✓ <工具名> [k=v, …]`,文案沿用面板原来的摘要(更好读)
  return { head: toolStr(p.name) || 'tool', tail: inputSummary(input) };
}

function toolHead(p, line, counts) {
  // 行首标记:运行中时照 TUI 换成会转的 spinner,其余时候是各工具自己的图标
  const s = statusInfo(p);
  const spin = toolRunning(p);
  return (
    '<span class="tmark' + (spin ? ' spin' : '') + '">' +
    (spin ? SPIN_FRAMES[spinFrame] : toolIcon(p, line.icon)) +
    '</span>' +
    (line.head ? '<span class="tname">' + esc(line.head) + '</span>' : '') +
    (line.tail ? '<span class="tdesc">' + esc(line.tail) + '</span>' : '') +
    (counts && counts.additions ? '<span class="tadd">+' + counts.additions + '</span>' : '') +
    (counts && counts.deletions ? '<span class="tdel">-' + counts.deletions + '</span>' : '') +
    // 完成不另画对勾(行首图标已经说了),运行中照旧什么都不画,只有出错留一个字
    (s.label ? '<span class="tstate ' + s.cls + '">' + esc(s.label) + '</span>' : '')
  );
}

// open=true 的卡片默认展开(改动内容要一眼看到),与 TUI 的 edit / write / patch 一致。
// data-def 记下这个默认值,用户手动折/摊的状态才不会在整块重绘后丢掉(见 syncDetailsOpen)。
function toolCard(p, line, counts, body, open) {
  return (
    '<details class="tool" data-def="' + (open ? '1' : '0') + '"' + (open ? ' open' : '') + '><summary>' +
    toolHead(p, line, counts) + '</summary>' +
    '<div class="toolbody">' + body + '</div></details>'
  );
}

/* 工具输出统一拼进 <pre>(shell 与通用工具共用)。 */
function toolOutputHtml(st) {
  if (!Array.isArray(st.content)) return '';
  const txt = st.content.map((c) => (c && c.text) || '').join('\n').trim();
  return txt ? '<pre>' + esc(txt) + '</pre>' : '';
}

function toolHtml(p) {
  const st = p.state || {};
  const md = st.metadata || {};
  const input = st.input;
  const kind = toolKind(p);
  const files = Array.isArray(md.files) ? md.files : [];
  const path = (input && input.path) || md.filepath || (files[0] && files[0].file) || '';
  const line = toolLine(p);

  // edit / patch:服务端算好的多文件 unified diff(TUI 的 BlockTool:edit 是「← Edit <路径>」)
  if (kind === 'edit' || kind === 'patch') {
    if (files.length) {
      return toolCard(p, line, diffCounts(files), diffHtml(files, { pid: p.id }) + diagHtml(md, path), true);
    }
    // 还在跑:服务端尚未给出 files,只显示目标(与服务端 TUI 的「← Edit <path>」一致)
    return '<div class="toolrow">' + toolHead(p, line) + '</div>';
  }

  // write:正文在入参里(服务端不给 write 的 diff),TUI 的块标题是「# Wrote <路径>」
  if (kind === 'write') {
    const wrote = { head: 'Wrote', tail: abbrevPath(path), icon: '#' };
    if (input && typeof input.content === 'string') {
      return toolCard(p, wrote, null, codeHtml(input.content, path) + diagHtml(md, path), true);
    }
    return '<div class="toolrow">' + toolHead(p, line) + '</div>';
  }

  // question:已答时展示「问题 → 答案」(TUI 的 `# Questions` 块)
  if (kind === 'question') {
    const qs = Array.isArray(input && input.questions) ? input.questions : [];
    if (Array.isArray(md.answers)) {
      let body = '<div class="qalist">';
      for (let i = 0; i < qs.length; i++) {
        const a = md.answers[i];
        const ans = Array.isArray(a) && a.length ? a.join(', ') : '(no answer)';
        body +=
          '<div class="qa"><div class="qq">' + esc((qs[i] && qs[i].question) || '') + '</div>' +
          '<div class="aa">' + esc(ans) + '</div></div>';
      }
      return toolCard(p, { head: 'Questions', tail: '', icon: '#' }, null, body + '</div>', true);
    }
    return '<div class="toolrow">' + toolHead(p, line) + '</div>';
  }

  if (kind === 'skill') {
    return '<div class="toolrow">' + toolHead(p, line) + '</div>';
  }

  // shell:TUI 的 ShellDisplay 正文只留输出(命令已经进了标题行)
  if (kind === 'shell') {
    const out = toolOutputHtml(st);
    if (!out) return '<div class="toolrow">' + toolHead(p, line) + '</div>';
    return toolCard(p, line, null, out, false);
  }

  // 其它工具:摘要行 + 点开展开入参/输出(与 TUI 的通用卡片一致)
  let body = '';
  if (input && (typeof input !== 'object' || Object.keys(input).length)) {
    body += '<pre>' + esc(typeof input === 'string' ? input : JSON.stringify(input, null, 2)) + '</pre>';
  }
  body += toolOutputHtml(st);
  if (!body) return '<div class="toolrow">' + toolHead(p, line) + '</div>';
  return toolCard(p, line, null, body, false);
}

/* 探索类工具行的分组,照 TUI 的 exploration 分组。
 *
 * TUI(packages/tui/src/routes/session/grouping/session.ts)里 explorationTools 就是
 * read / glob / grep / webfetch / websearch 这五类:`partPath()` 给它们挂 ["exploration"],
 * 相邻的挂同一条路径的被 grouping/tree.ts 并进一个组;GroupContent(见 group-view.tsx)
 * 在 groupExploration()(默认开着)时把整组折成一行 —— 行首 `→`(跑着时是 spinner)、
 * 词是 Explored/Exploring、后面跟计数,点一下才摊开成原来那一行行的工具行。
 * size=1 的组也是这么折的(GroupContent 的 grouped() 分支没有条数下限),所以这里
 * 不设下限;EXPLORE_MIN_RUN 留着当开关 —— 想「只折两条以上的那种」,把它改成 2 即可。 */
const EXPLORE_MIN_RUN = 1;
const EXPLORE_TOOLS = ['read', 'glob', 'grep', 'webfetch', 'websearch'];

function isExploreTool(p) {
  return EXPLORE_TOOLS.indexOf(toolKind(p)) >= 0;
}

/* 计数照 TUI 的 GroupContent.label():grep / glob / websearch 都算 search,webfetch 算
 * fetch,其余用工具名本身;复数照 TUI —— search/fetch 加 es,别的加 s(1 read / 2 reads,
 * 1 search / 2 searches,1 fetch / 2 fetches),几条之间用 `, ` 连。 */
function exploreLabel(parts) {
  const counts = {};
  for (const p of parts) {
    const k = toolKind(p);
    const name = k === 'grep' || k === 'glob' || k === 'websearch' ? 'search' : k === 'webfetch' ? 'fetch' : k;
    counts[name] = (counts[name] || 0) + 1;
  }
  return Object.keys(counts)
    .map((name) => {
      const n = counts[name];
      const one = n === 1;
      return n + ' ' + (one ? name : name === 'search' || name === 'fetch' ? name + 'es' : name + 's');
    })
    .join(', ');
}

/* 一组探索工具折成一行(TUI 的 InlineToolRow):跑着时行首是 spinner、词是 Exploring,
 * 全部收工后换成 `→` 和 Explored。正文【默认折着】(照 TUI),但原来那些工具行一个都不少,
 * 就挪进 .gbody 里 —— 点开这一行才看得见。data-def 让用户摊开的状态在整块重绘后不丢
 * (见 syncDetailsOpen)。 */
function exploreGroupHtml(parts) {
  const done = !parts.some(toolRunning);
  const word = done ? 'Explored' : 'Exploring';
  return (
    '<details class="explore" data-def="0"><summary>' +
    '<span class="tmark' + (done ? '' : ' spin') + '">' + (done ? '→' : SPIN_FRAMES[spinFrame]) + '</span>' +
    '<span class="tname">' + word + ':</span>' +
    '<span class="tdesc">' + esc(exploreLabel(parts)) + '</span>' +
    '</summary>' +
    '<div class="gbody">' + parts.map((q) => toolHtml(q)).join('') + '</div>' +
    '</details>'
  );
}

// 用户消息上的提及标记:agent(@)与 skill(#)。H 组 5 补的,延续终端风
// (不加气泡,只用色条 + 标记);附件在 H 组 6 一起补。
function userRefsHtml(m) {
  const out = [];
  for (const a of m.agents || []) {
    const name = a && (a.name || a.id);
    if (name) out.push('<span class="ref ref-agent" title="智能体">@' + esc(name) + '</span>');
  }
  // skill 照 TUI 的 UserMessage 画成「徽标 + 名字」两格(徽标 ` skill `、
  // 名字 ` name `);原来只有一个 `#name`,和 TUI 那颗徽标不是一回事。
  for (const s of m.skills || []) {
    const name = s && (s.name || s.id);
    if (name)
      out.push(
        '<span class="ref ref-skill" title="技能"><span class="rBadge">skill</span>' +
          '<span class="rName">' + esc(name) + '</span></span>'
      );
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
// 名字那格照 TUI 的 UserMessage 拆成「徽标 + 名字」:目录 ` dir `、其余 ` file `。
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
    const label = mime === 'application/x-directory' ? 'dir' : 'file';
    out.push(
      '<div class="att">' +
        '<span class="att-name"><span class="rBadge">' + label + '</span>' +
        '<span class="rName">' + esc(name) + '</span></span>' +
        (meta ? '<span class="att-meta">' + esc(meta) + '</span>' : '') +
        (src ? '<span class="att-src">' + esc(src) + '</span>' : '') +
        '</div>' +
        (isImg ? '<img class="att-img" alt="' + esc(name) + '" src="data:' + esc(mime) + ';base64,' + String(f.data) + '">' : '')
    );
  }
  return out.length ? '<div class="atts">' + out.join('') + '</div>' : '';
}

/* 思考块的摘要(照 TUI 的 context/thinking.ts:reasoningSummary):模型有时会把概要标题
 * 加粗放在正文最前面(`**Inspecting PR workflow**\n\n正文…`),TUI 就把那段拎出来单独当
 * 标题使。这里同样只认最前面那一段加粗 + 空行(或整块就到这儿)。 */
const REASONING_TITLE_RE = /^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/;

function reasoningTitle(text) {
  const m = String(text == null ? '' : text).trim().match(REASONING_TITLE_RE);
  return m ? m[1].trim() : '';
}

/* 时长照 TUI 的 Locale.duration(packages/tui/src/util/locale.ts):1s / 1.2s / 1m 5s / 1h 5m / 1d 5h。 */
function fmtDur(ms) {
  if (!(ms > 0)) return '';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm';
  return Math.floor(ms / 86400000) + 'd ' + Math.floor((ms % 86400000) / 3600000) + 'h';
}

/* 思考块摘要的文案(照 TUI 的 ReasoningHeader):收工后是「思考: 标题 · 12.3s」,
 * 标题拿不到就只有「思考」;还在流式时只给标题,不给时长(时长还没有)。 */
/* 思考块的组行(照 TUI 的 reasoning 分组行,group-view.tsx:179-188):
 *   跑着:`Thinking` / `Thinking: <标题>`
 *   收工:`Thought`(+ 折着时 `: <标题>`)(+ 多段时 ` · N steps`)(+ 时长)
 * 标题取「最后一段的加粗首行」(TUI 的 latest():最后一段没标题且已收工就清掉,还在跑就沿用前一段的);
 * 时长照 TUI:组内【各段各自 created→completed 之和】(那边是个 reduce,不是首尾相减)。
 * TUI 在【展开时】不印标题 —— 面板用 CSS 反应(`details[open]` 里收工那款把 `.rTitle` 收起来),
 * 跑着那款照 TUI 一直带着标题。 */
function reasoningRunTitle(run) {
  const last = run[run.length - 1];
  const t = reasoningTitle(last && last.text);
  if (t) return t;
  if (!last || (last.time && last.time.completed !== undefined)) return '';
  for (let i = run.length - 2; i >= 0; i--) {
    const prev = reasoningTitle(run[i] && run[i].text);
    if (prev) return prev;
  }
  return '';
}

function reasoningGroupHtml(run, m, body) {
  const running = !!m.live;
  const title = reasoningRunTitle(run);
  let dur = 0;
  if (!running) {
    for (const p of run) {
      const t = (p && p.time) || {};
      if (t.created !== undefined && t.completed !== undefined) dur += Math.max(0, t.completed - t.created);
    }
  }
  return (
    '<details class="reasoning' + (running ? ' live' : '') + '"' + (running ? ' open' : '') + '>' +
    '<summary><span class="rWord' + (running ? '' : ' rDone') + '">' +
    (running ? 'Thinking' : 'Thought') + '</span>' +
    (title ? '<span class="rTitle">: ' + esc(title) + '</span>' : '') +
    (!running && run.length > 1 ? '<span class="rSteps"> · ' + run.length + ' steps</span>' : '') +
    (dur ? '<span class="rDur"> · ' + esc(fmtDur(dur)) + '</span>' : '') +
    '</summary>' +
    body +
    '</details>'
  );
}

/* ------- 助手消息脚注(照 TUI 的 AssistantFooter,index.tsx:1881 -------
 *
 * TUI 在每条助手消息**收工后**于底部印一行:
 *   Build · DeepSeek V4 Flash · 4.7s · 42.1 tok/s
 * 尾巴可接 `· interrupted`;上面另起两行 —— 出错(且不是中断/重试)时 `Error: <原因>`、
 * 重试中 `⚠ Retrying in Ns · attempt K · <原因>`。窄屏照 TUI 的列宽收:<28 列不印模型,
 * 28~36 列不印时长(终端 1 列 ≈ 1ch,规则写在 styles.css)。
 *
 * 时长与速度都照 TUI 的 turnDuration / turnTokensPerSecond(rows.ts:430/442):
 *   时长 = 本步 time.completed − **本轮输入消息** time.created(整轮,不是本步自己)
 *   速度 = Σ(output+reasoning) / Σ(streamed−created),只算本轮已经走到现在的助手步;
 *          任何一步缺 time.streamed 就整体不印(TUI 就是这么做的)
 */

/* Locale.titlecase(locale.ts:3):每个词首字母大写 —— build → Build */
function titlecase(s) {
  return String(s == null ? '' : s).replace(/\b\w/g, (c) => c.toUpperCase());
}

/* 模型显示名:照 TUI 先去模型表里查 name,查不到退回 providerID/id */
function modelDisplayName(ref) {
  if (!ref || (!ref.id && !ref.providerID)) return '';
  const info = store.modelIndex.get(ref.providerID + '/' + ref.id);
  return (info && info.name) || (ref.providerID ? ref.providerID + '/' + ref.id : ref.id);
}

/* 本轮输入消息的下标(照 TUI 的 inputIndex,rows.ts:469):从 end 往回走,撞上 idle
 * 就把「上一个 idle 之后的第一条输入」交出去;老会话(整条没有 idle)一撞上输入就返回。 */
function turnInputIndex(msgs, end, legacy) {
  let input = -1;
  for (let i = end - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === 'idle') return input;
    if (m.type !== 'user' && m.type !== 'synthetic') continue;
    if (legacy) return i;
    input = i;
  }
  return input;
}

function turnStart(msgs, end) {
  return turnInputIndex(msgs, end, !msgs.some((x) => x.type === 'idle'));
}

function turnDuration(m, msgs, index) {
  if (!m.time || m.time.completed === undefined) return 0;
  const i = index === undefined ? msgs.findIndex((x) => x.id === m.id) : index;
  const input = msgs[turnStart(msgs, i === -1 ? msgs.length : i)];
  return Math.max(0, m.time.completed - ((input && input.time && input.time.created) || m.time.created));
}

function turnTps(m, msgs, index) {
  const i = index === undefined ? msgs.findIndex((x) => x.id === m.id) : index;
  const end = i === -1 ? msgs.length : i + 1;
  const steps = msgs.slice(turnStart(msgs, end) + 1, end).filter((x) => x.type === 'assistant');
  if (!steps.length) return 0;
  let dur = 0;
  let out = 0;
  for (const s of steps) {
    const t = s.time || {};
    if (t.streamed === undefined) return 0; // 缺一块就不算,免得给出偏高的数
    dur += Math.max(0, t.streamed - t.created);
    const tk = s.tokens || {};
    out += (tk.output || 0) + (tk.reasoning || 0);
  }
  if (out <= 0 || dur <= 0) return 0;
  return out / (dur / 1000); // 先加总再除:每步按各自的「供应商活跃时长」加权
}

/* TUI 把中断单独认成 interrupted(二进制原文:error?.message==="Step interrupted"),
 * 面板的 aborted 是同一种东西(服务端给的就是 {type:'aborted',message:'Step interrupted'})。 */
function isInterrupted(m) {
  return !!(m.error && (m.error.message === 'Step interrupted' || m.error.type === 'aborted'));
}

function assistantFooterHtml(m, opts) {
  const msgs = (opts && opts.msgs) || [m];
  const index = opts && opts.index !== undefined ? opts.index : msgs.findIndex((x) => x.id === m.id);
  const interrupted = isInterrupted(m);
  let out = '';
  if (m.error && !interrupted && !m.retry) {
    out += '<div class="afErr">Error: ' + esc(m.error.message || m.error.type || '') + '</div>';
  }
  if (m.retry) {
    const at = m.retry.at || 0;
    const left = at ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : 0;
    out +=
      '<div class="afRetry"' + (at ? ' data-at="' + esc(String(at)) + '"' : '') + '>⚠ <span class="afWhen">' +
      (left > 0 ? 'Retrying in ' + left + 's' : 'Retry due') + '</span> · attempt ' +
      esc(String(m.retry.attempt == null ? '' : m.retry.attempt)) +
      (m.retry.error && m.retry.error.message ? ' · ' + esc(m.retry.error.message) : '') +
      '</div>';
  }
  if (m.live) return out; // 还没收工:照 TUI 这行是 step.ended 之后才有的
  const parts = [];
  const agent = titlecase(m.agent || '');
  if (agent) parts.push('<span class="afAgent' + (m.error ? ' muted' : '') + '">' + esc(agent) + '</span>');
  const model = modelDisplayName(m.model);
  if (model) parts.push('<span class="afModel">' + esc(model) + '</span>');
  const dur = fmtDur(turnDuration(m, msgs, index));
  if (dur) parts.push('<span class="afDur">' + esc(dur) + '</span>');
  const tps = turnTps(m, msgs, index);
  if (tps > 0) parts.push('<span class="afTps">' + esc(tps.toFixed(1)) + ' tok/s</span>');
  if (interrupted) parts.push('<span class="afInt">interrupted</span>');
  if (!parts.length) return out;
  return out + '<div class="afoot">' + parts.join('<span class="afSep"> · </span>') + '</div>';
}

/* ------- Tokens 块(照 TUI 的 TurnTokenUsage,index.tsx:1605 -------
 *
 * TUI 在【每一轮】的收尾处(该轮最后一步的脚注之后)印一行、默认收起:
 *   + Tokens: 2 steps · latest: 1,234 new · 52,000 cached · 53,234 total
 * 点开是一张逐步的表 Step / New / Cached / Total;数字掉了(cache 复用变少)另起一行
 *   ! Likely cache bust: N fewer cached tokens than the previous step
 * 总览那行尾巴接 ` · ! K likely cache bust(s)`。`new` = total − cache.read,
 * `total` = input+output+reasoning+cache.read+cache.write(照 TUI 的 tokenTotal)。
 *
 * 轮次边界照 TUI 的 reduceSessionRows / flushTurn:有 idle 标记的会话【撞上 idle 才收轮】
 * (所以同一轮里可以夹着多条提示词 —— steer 不关轮);老会话(整条没有 idle)遇到【终步】就收
 * (终步 = finish 不是 tool-calls/unknown,或者带 error)。还没收轮的那些步不印块。
 * previousCache(上一轮收尾那步的 cache)照 TUI 带着走,中间遇到【已完成】的 compaction 就作废;
 * 缓存有没有失效照 TUI 的 cacheReuseDrop(换模型不算;openai 的 1024~2048 掉量是它的分桶振动,
 * 不算)。
 *
 * 这一块在 TUI 里挂在 config 的 debug.turn_tokens 上(默认关);面板按拍板的默认【做出来、
 * 默认收起】—— 数字一直在,想看一眼点开就是。
 */
function tokenTotal(t) {
  if (!t) return 0;
  const c = t.cache || {};
  return (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (c.read || 0) + (c.write || 0);
}

/* 照 TUI 的 hasTokenUsage(rows.ts:484):没有 tokens、或者五路加起来是 0 的步不进表 */
function hasTokenUsage(m) {
  return !!(m && m.type === 'assistant' && m.tokens && tokenTotal(m.tokens) > 0);
}

/* 照 TUI 的 cacheReuseDrop(rows.ts:413) */
function cacheReuseDrop(prev, cur) {
  if (!prev) return undefined;
  const a = prev.model || {};
  const b = cur.model || {};
  if (a.providerID !== b.providerID || a.id !== b.id || a.variant !== b.variant) return undefined;
  const drop = (prev.read || 0) - (cur.read || 0);
  // openai 的 cache read 会在一两个 1024 的桶之间晃,不代表真丢复用
  if (b.providerID === 'openai' && drop >= 1024 && drop <= 2048) return undefined;
  return drop > 0 ? drop : undefined;
}

function num(x) {
  return Number(x || 0).toLocaleString('en-US');
}

/* 整张消息表按轮摊平:closed =「收尾那步的 id → 这一轮」,open = 还没收轮的那些步。
 * 按数组引用缓存一次(renderMessages 每趟只造一份 msgs,整趟共用)。 */
let tuArrCache = null;
let tuValCache = null;
function turnInfo(msgs) {
  if (!msgs || !msgs.length) return { closed: new Map(), open: new Set() };
  if (tuArrCache === msgs && tuValCache) return tuValCache;
  const legacy = !msgs.some((x) => x.type === 'idle');
  const closed = new Map();
  const open = new Set();
  let cur = [];
  let prevCache;
  const flush = () => {
    if (!cur.length) return;
    const withTok = cur.filter(hasTokenUsage);
    if (withTok.length) {
      const lastTok = withTok[withTok.length - 1];
      closed.set(cur[cur.length - 1].id, { steps: withTok, prevCache: prevCache });
      prevCache = { read: ((lastTok.tokens || {}).cache || {}).read || 0, model: lastTok.model };
    }
    cur = [];
  };
  for (const m of msgs) {
    if (m.type === 'idle') {
      flush();
      continue;
    }
    if (m.type === 'compaction' && m.status === 'completed') prevCache = undefined;
    if (m.type !== 'assistant') continue;
    cur.push(m);
    const terminal = !!((m.finish && m.finish !== 'tool-calls' && m.finish !== 'unknown') || m.error);
    if (legacy && terminal) flush();
  }
  for (const m of cur) if (m.tokens) open.add(m.id);
  const val = { closed: closed, open: open };
  tuArrCache = msgs;
  tuValCache = val;
  return val;
}

/* 一轮的逐步表:new / cached / total / 掉量提醒(上一趟是 TUI 在组件里现算的) */
function turnUsageRows(seg) {
  let prev = seg.prevCache;
  const rows = [];
  for (const m of seg.steps) {
    const t = m.tokens || {};
    const cached = (t.cache || {}).read || 0;
    const total = tokenTotal(t);
    const cur = { read: cached, model: m.model };
    const drop = cacheReuseDrop(prev, cur);
    prev = cur;
    rows.push({
      finish: m.finish === 'tool-calls' ? 'tool-call' : m.finish || 'unknown',
      newTokens: total - cached,
      cached: cached,
      total: total,
      drop: drop,
    });
  }
  return rows;
}

function tokenBlockHtml(seg) {
  const rows = turnUsageRows(seg);
  if (!rows.length) return '';
  const latest = rows[rows.length - 1];
  const busts = rows.filter((r) => r.drop !== undefined).length;
  const n = rows.length;
  let html =
    '<details class="tokblk" data-def="0"><summary>' +
    '<span class="tokWord">Tokens</span><span class="tokSum">: ' + n + ' ' + (n === 1 ? 'step' : 'steps') +
    ' · latest: ' + num(latest.newTokens) + ' new · ' + num(latest.cached) + ' cached · ' +
    num(latest.total) + ' total</span>' +
    (busts > 0
      ? '<span class="tokBust"> · ! ' + busts + ' likely cache ' + (busts === 1 ? 'bust' : 'busts') + '</span>'
      : '') +
    '</summary><table class="toktab"><thead><tr><th>Step</th><th>New</th><th>Cached</th><th>Total</th></tr></thead><tbody>';
  for (const r of rows) {
    html +=
      '<tr><td>' + esc(r.finish) + '</td><td>' + num(r.newTokens) + '</td><td>' + num(r.cached) + '</td><td>' +
      num(r.total) + '</td></tr>';
    if (r.drop !== undefined) {
      html +=
        '<tr class="tokDrop"><td colspan="4">! Likely cache bust: ' + num(r.drop) +
        ' fewer cached tokens than the previous step</td></tr>';
    }
  }
  return html + '</tbody></table></details>';
}

/* ------- 其它消息种类(照 TUI 的 SessionMessageView,index.tsx:1799 ---------------
 *
 * 面板原来一律画成「· <type>: <text>」一句,跟 TUI 不是一回事。照 TUI 一一对上:
 *
 *   location-switched → SessionSwitchMessageV2:`↳ Moved to <目录>`(目录那格 info 蓝)
 *   agent-switched    → 同上:`Switched agent to <X>` / `Switched agent from <X> to <Y>`
 *                       (两头都 titlecase;previous 跟 agent 相同就只写 to)
 *   model-switched    → switchLabel:`Switched model to <名字>`(名字后面补 (` (档)`,档不是
 *                       default 时);providerID+id 跟 previous 相同(只换档)则
 *                       `Switched variant to <档|default>`;模型表里查不到名字退回
 *                       `providerID/id/variant`
 *   system            → SessionNoticeMessageV2:`◈ <description ?? "Instructions updated">`
 *   synthetic         → 同上;但 metadata.source 是 subagent / shell 的(子会话跑完、shell
 *                       跑完)另画:`↳ Explorer finished · <描述>`(state=completed → finished、
 *                       error → failed;completed 用 ↳,别的用 !;error 红、cancelled 琥珀、
 *                       其余 info 蓝);shell 的描述先把空白压平(照 TUI)
 *   skill             → SessionSkillMessage:`→ Skill <名字>`
 *
 * 另外两种「压根不出行」的照 TUI:① idle(rows.ts 撞上它只收轮、不 push 行);
 * ② synthetic 没有 description 的(rows.ts:383 —— 例如「上一条被打断,接着干」那条原始
 * 指令,正文是给模型看的,显示出来只是噪音)。见 msgHidden()。
 */

/* 照 TUI 的 switchLabel(util/model.ts,二进制里核对过原文) */
function switchLabel(model, previous) {
  const m = model || {};
  if (previous && previous.providerID === m.providerID && previous.id === m.id) {
    return 'Switched variant to ' + (m.variant || 'default');
  }
  const info = store.modelIndex.get(m.providerID + '/' + m.id);
  const name = info && info.name;
  if (name === undefined) {
    return 'Switched model to ' + [m.providerID, m.id, m.variant].filter((x) => x !== undefined).join('/');
  }
  const v = m.variant && m.variant !== 'default' ? ' (' + m.variant + ')' : '';
  return 'Switched model to ' + name + v;
}

/* synthical / system 那一行的正文(照 TUI 的 text():system 没描述时兜底 Instructions updated) */
function noticeText(m) {
  if (m.type === 'system') return m.description || 'Instructions updated';
  return m.description || '';
}

function switchRowHtml(m) {
  if (m.type === 'location-switched') {
    const dir = (m.location && m.location.directory) || '';
    return '<span class="swHead">↳ Moved to </span><span class="swPath">' + esc(dir) + '</span>';
  }
  if (m.type === 'agent-switched') {
    const agent = titlecase(m.agent || '');
    const from = m.previous && m.previous !== m.agent ? titlecase(m.previous) : '';
    return '<span class="swText">Switched agent ' + (from ? 'from ' + esc(from) + ' to ' : 'to ') + esc(agent) + '</span>';
  }
  return '<span class="swText">' + esc(switchLabel(m.model, m.previous)) + '</span>';
}

function noticeRowHtml(m) {
  const meta = (m.type === 'synthetic' && m.metadata) || {};
  const source = typeof meta.source === 'string' ? meta.source : '';
  const state = typeof meta.state === 'string' ? meta.state : '';
  if (source !== 'subagent' && source !== 'shell') {
    return '<div class="toolrow notice"><span class="tmark">◈</span>' +
      '<span class="tdesc">' + esc(noticeText(m)) + '</span></div>';
  }
  const actor = source === 'shell' ? 'Shell' : titlecase(typeof meta.agent === 'string' ? meta.agent : 'Subagent');
  const status = state === 'completed' ? 'finished' : state === 'error' ? 'failed' : state || 'finished';
  const text = source === 'shell' ? noticeText(m).replace(/\s+/g, ' ').trim() : noticeText(m);
  const cls = state === 'error' ? ' err' : state === 'cancelled' ? ' warn' : '';
  return (
    '<div class="completion' + cls + '"><span class="cHead">' + (state === 'completed' ? '↳' : '!') + ' ' +
    esc(actor) + ' ' + esc(status) + '</span>' +
    (text ? '<span class="cSuffix"> · ' + esc(text) + '</span>' : '') + '</div>'
  );
}

/* 整条不出行的(照 TUI 的 rows.ts:383):idle,以及没有 description 的 synthetic */
function msgHidden(m) {
  if (m.type === 'idle') return true;
  if (m.type === 'synthetic' && !noticeText(m).trim()) return true;
  return false;
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
    // 模型名不再印在头部 —— 照 TUI 挪到脚注(AssistantFooter 那行):「谁干的」在末尾交代,
    // 头部只留标记与身份(照 TUI 其实没有这行,是面板自己的阅读用头部,见 §8.27)。
    let html =
      '<div class="turn-head"><span class="marker">⏺</span>' +
      '<span class="who">助手</span>' +
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
        // 相邻的思考段并成【一个】块(照 TUI:tree.ts 把相邻同 kind 的 part 并进同一个组),
        // 组行见 reasoningGroupHtml。正文仍是每段一个 .content,data-lk 的序号照旧按段递增
        // (增量重绘 paintLiveText 就是按「同类型里的第几个」定位的)。
        const run = [p];
        while (i + 1 < content.length && content[i + 1].type === 'reasoning') run.push(content[++i]);
        let rbody = '';
        for (let j = 0; j < run.length; j++) {
          const rp = run[j];
          const at = i - (run.length - 1 - j); // 这一段在 content 里的下标
          const rLast = at === lastBlock;
          const rmd = md(rp.text || '');
          const rlk = m.live
            ? ' data-lk="reasoning:' + nReason + '"' +
              ' data-lk-last="' + (rLast ? '1' : '0') + '"' +
              ' data-lk-key="' + (rp.text || '').length + ':0"'
            : '';
          nReason++;
          rbody += '<div class="content"' + rlk + '>' + (m.live && rLast ? cursorInto(rmd) : rmd) + '</div>';
        }
        html += reasoningGroupHtml(run, m, rbody);
      } else if (p.type === 'tool') {
        // 相邻的探索类工具(read/glob/grep/webfetch/websearch)折成一组,照 TUI 的
        // exploration 分组 —— 见 EXPLORE_TOOLS 那段的说明。
        if (isExploreTool(p)) {
          const run = [p];
          while (i + 1 < content.length && content[i + 1].type === 'tool' && isExploreTool(content[i + 1])) {
            run.push(content[++i]);
          }
          if (run.length >= EXPLORE_MIN_RUN) {
            html += exploreGroupHtml(run);
            continue;
          }
          for (const q of run) html += toolHtml(q);
          continue;
        }
        html += toolHtml(p);
      }
    }
    // 收工后这一轮的数字进了下面那个 Tokens 块,.meta 只留费用(不再重复一份);
    // 还在跑的那一步照旧把 token 数留在 .meta 里 —— 那时候块还没到,看着它涨。
    const tu = opts.msgs ? turnInfo(opts.msgs) : null;
    const bits = [];
    if (m.tokens && (m.live || !tu || tu.open.has(m.id))) bits.push(fmtTokens(m.tokens) + ' tokens');
    if (m.cost) bits.push(fmtCost(m.cost));
    if (m.live) bits.push('流式中');
    if (bits.length) html += '<div class="meta">' + esc(bits.join(' · ')) + '</div>';
    html += assistantFooterHtml(m, opts);
    // Tokens 块排在脚注之后(照 TUI:那是 turn-usage 行,收工那一步才印)
    if (tu && tu.closed.has(m.id)) html += tokenBlockHtml(tu.closed.get(m.id));
    el.innerHTML = html;
    return el;
  }

  if (m.type === 'compaction') {
    // 面板原来把这条画成「· compaction」—— 一句和正文无关的话。照 TUI 的 Compaction
    // 块画:行首标记在压缩时转起来(dots 同款),完了给 tokens,摘要跟着正文印出来。
    // 摘要是【摊开】印的(照 TUI:它把概要原样印在块里,没有折起来这回事),外层
    // 留一个 <details>:摊着也能点一下折起来 —— 实测一份摘要 5~9 KB,手机上想收起来时有个抓手。
    const running = m.status === 'running';
    const aborted = !!(m.error && m.error.type === 'aborted');
    const failed = m.status === 'failed' && !aborted;
    // 压缩进行中时正文是流式缓冲里攒的那份(一条 delta 一段地长),收工后是服务端给的摘要
    const body = compactionBody(m);
    el.className = 'msg compaction' + (running ? ' live' : '');
    el.innerHTML =
      '<div class="turn-head">' +
      (running
        ? '<span class="tmark spin">' + SPIN_FRAMES[spinFrame] + '</span>'
        : '<span class="marker">' + (failed || aborted ? '✗' : '⏺') + '</span>') +
      '<span class="who">上下文压缩</span>' +
      (running ? '<span class="live-tag">进行中</span>' : '') +
      (aborted ? '<span class="live-tag">已取消</span>' : '') +
      (!running && !failed && m.tokens
        ? '<span class="model">' + esc(fmtTokens(m.tokens)) + ' tokens</span>'
        : '') +
      '</div>' +
      (body
        ? '<details class="compact" data-def="1" open><summary>摘要</summary>' +
          '<div class="content">' + md(body) + '</div></details>'
        : '') +
      (failed && m.error && m.error.message
        ? '<div class="content">' + esc(m.error.message) + '</div>'
        : '');
    return el;
  }

  if (m.type === 'idle') return el; // 占位,不显示(renderMessages 根本不会把它插进来)

  // 切换类 / 通知类 / 技能行照 TUI 的 SessionMessageView 一一对上(见上面那一段注释)
  if (m.type === 'location-switched' || m.type === 'agent-switched' || m.type === 'model-switched') {
    el.className = 'msg minor swrow';
    el.innerHTML = switchRowHtml(m);
    return el;
  }
  if (m.type === 'system' || m.type === 'synthetic') {
    el.className = 'msg minor';
    el.innerHTML = noticeRowHtml(m);
    return el;
  }
  if (m.type === 'skill') {
    el.className = 'msg minor';
    el.innerHTML =
      '<div class="toolrow skillmsg"><span class="tmark">→</span><span class="tname">Skill</span>' +
      '<span class="tdesc">' + esc(m.name || '') + '</span></div>';
    return el;
  }

  el.className = 'msg minor';
  el.textContent = '· ' + m.type + (m.text ? ': ' + m.text : '');
  return el;
}

const msgEls = new Map(); // message id -> { sig, el }

/* 签名一变就整块换元素,<details> 的展开状态会跟着丢。渲染出来的每个 details 都带
 * data-def(它【天生】开还是合):新旧一对比,只要旧的开合跟它的默认对不上,就说明用户
 * 动过手,照搬到新元素上(两头都搬 —— 探索组、shell 卡天生是合的,用户摊开了就得留住)。
 * 没带 data-def 的(思考块:开还是合由 m.live 决定)维持老规矩:只搬【用户折起来过】这一种,
 * 反方向不搬 —— 那是渲染的规矩,不是用户的动作(ui-stream 有断言锁着)。 */
function syncDetailsOpen(oldEl, newEl) {
  const o = oldEl.querySelectorAll('details');
  const n = newEl.querySelectorAll('details');
  const len = Math.min(o.length, n.length);
  for (let i = 0; i < len; i++) {
    const def = n[i].getAttribute('data-def');
    if (def === null) {
      if (n[i].open && !o[i].open) n[i].removeAttribute('open');
      continue;
    }
    if (o[i].open === (def === '1')) continue; // 与默认一致 → 用户没动过,维持这次渲染的默认
    if (o[i].open) n[i].setAttribute('open', '');
    else n[i].removeAttribute('open');
  }
}

// 当前会话要渲染的消息全表:服务端消息 + 本地流式缓冲里服务端还没落盘的助手消息,
// 按创建时间排好。渲染与「上下文用量」共用这一份口径 —— 两处口径一旦漂移,顶部那个
// 数字就会和消息流对不上。
function currentMessages() {
  const msgs = Array.from(store.messages.values());
  // 本地流式缓冲里已有、但服务端消息列表还没出现的助手消息,补进渲染列表
  for (const [id, L] of store.live) {
    if (L.sid !== store.selected) continue;
    if (!liveView(id)) continue;
    if (store.messages.has(id)) continue;
    msgs.push(liveMessage(L));
  }
  msgs.sort((a, b) => ((a.time && a.time.created) || 0) - ((b.time && b.time.created) || 0));
  return msgs;
}

/* content-visibility: auto 只对「真长」的会话开(见 styles.css 里 #messages.cvmany > .msg)。
   条数少的时候离屏内容本来就没多少,省不下几个钱,却要拿 contain-intrinsic-size 的估值去
   占位 —— 短会话「压根不用滚」的场景反而会被估值虚高撑出一条假滚动条。所以按条数挂开关,
   阈值取 30:再少的话那次 flush 也就几毫秒,不值得引入估值这个变量。 */
const CV_MIN_MSGS = 30;

function renderMessages() {
  const box = $('#messages');
  const msgs = currentMessages();
  repinSeq++; // 这一轮渲染一来,上一轮「贴完底再跟几帧」就地作废(免得它去动新会话说位置)
  // 够长才让离屏消息跳过渲染(CV_MIN_MSGS);短会话维持原样,滚动行为一个字节都不变
  box.classList.toggle('cvmany', msgs.length >= CV_MIN_MSGS);
  const force = store.forceBottom;
  store.forceBottom = false;
  const pending = store.restoreScroll; // 待还原的滚动锚点:有它就不许跳到底
  // 量一次「跟不跟随」。注意不能拿 atBottom(box) 的结果当结论 —— 容器刚变矮(状态条 /
  // 底板展开 / #asks / 软键盘)也会让离底变远,而那不是用户往上滚(见 updateJumpLatest)。
  const nearBottom = !pending && (force || updateJumpLatest());

  // 删除已不存在的消息(live 缓冲里的消息不算「不存在」)
  for (const [id, rec] of msgEls) {
    if (!store.messages.has(id) && !liveView(id)) {
      rec.el.remove();
      msgEls.delete(id);
    }
  }

  // 增量渲染:仅重建变化的消息,其余复用 DOM(保留已展开的 details)
  let prev = null;
  for (let mi = 0; mi < msgs.length; mi++) {
    const m = msgs[mi];
    const L = liveView(m.id);
    let view = L ? liveMessage(L) : m;
    // idle 与「没有 description 的 synthetic」压根不出行(照 TUI 的 rows.ts:383)。
    // 在这里 continue:不建 DOM、不占 msgEls 记录,也不动 prev —— 整条就像不存在。
    if (!L && msgHidden(view)) continue;
    // 压缩块的正文在压缩期间是流式的(store.compactText 一段段涨):把当前正文并进
    // view 再算签名,签名才会跟着变 —— 不然新攒的正文上不了屏。
    if (!L && view && view.type === 'compaction') {
      view = Object.assign({}, view, { summary: compactionBody(view, store.selected) });
    }
    // 流式消息用结构指纹做签名(不含文本长度),文本增量走 paintLiveText 局部重绘。
    const liveFp = L ? liveSig(L) : '';
    // 脚注里的模型名是从模型表里查出来的(不在消息本体里),得一起进签名 ——
    // 否则模型表晚到一步,脚注就一直停在 providerID/id 的退回形态(TUI 那边是响应式,天然会重画)。
    // model-switched 那行同理(switchLabel 也要查表)。
    let fpExtra = '';
    if (!L && view && view.type === 'assistant') fpExtra = '|' + modelDisplayName(view.model);
    else if (!L && view && view.type === 'model-switched') fpExtra = '|' + switchLabel(view.model, view.previous);
    const sig = L ? 'live|' + liveFp : JSON.stringify(view) + fpExtra;
    // 脚注要按「整轮」算时长与速度,所以把整张消息表与自己在表里的位置一起交下去
    const rOpts = { msgs: msgs, index: mi };
    let rec = msgEls.get(m.id);
    if (!rec) {
      rec = { sig: sig, fp: liveFp, el: renderMessage(view, rOpts) };
      msgEls.set(m.id, rec);
    } else if (rec.sig !== sig) {
      const el = renderMessage(view, rOpts);
      syncDetailsOpen(rec.el, el);
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

  // 收尾时「贴不贴底」其实已经能定下来,直接喂给 updateJumpLatest() —— 省掉它自己再读一次
  // 布局。那次读正好落在刚改完 DOM 之后,是整个 renderMessages() 里最贵的一步
  // (脏树 atBottom 实测 23~29ms)。只有「还原了滚动锚点」这种位置不确定的情况才量一次。
  let atB = null;
  let pinned = false;
  if (pending && msgs.length) {
    store.restoreScroll = null; // 消费掉:只在这次渲染还原一次
    applyScrollAnchor(pending);
    atB = atBottom(box);
  } else if (nearBottom) {
    pinBottom(box);
    atB = true;
    pinned = true;
  } else if (!pending) {
    atB = false; // 没锚点要还原、也没跟底 → 就是不在底部
  }
  $('#older').hidden = !store.msgOlderCursor;
  // 内容高度刚变过,底部判定跟着变 —— 往上翻着的时候新内容进来,这里就把按钮露出来
  updateJumpLatest(atB);
  // 贴完底之后再跟几帧:cvmany 的离屏估值是【贴完之后】才落定的,一落定就把底顶歪(见 repinUntilStable)
  if (pinned && box.classList.contains('cvmany')) repinUntilStable(box);
  syncRepinWatch(); // §8.46:盯内容高度那只眼(新建/换掉的节点跟着换,晚了才撑开的图也接得住)

  const last = msgs[msgs.length - 1];
  if (last && last.type === 'idle') store.pending = false;
  const streaming = !!(last && last.type === 'assistant' && last.time && !last.time.completed);
  const compacting = compactionRunning(store.selected, msgs);
  store.running = store.pending || streaming || compacting || !!liveForSid(store.selected);
  updateChatStatus();
}

/* ------------------- 运行中的状态条(TUI 同款) ------------------- */

const PBAR_CELLS = 8;
const PBAR_FRAMES = 54;
const PBAR_MS = 40;

/* 第 n 个「形状」(n = 0..13)里哪些格子是实心的:
 *   0-5   从左边长出来,1 格长到 6 格
 *   6-12  整段往右滑出去,同时从 6 格缩到 1 格
 *   13    空(整条都是 ⬝)
 * TUI 一个循环就是这 14 个形状按下面的相位拼出来的(pty 抓屏实测 + 反编译
 * bs({style:"blocks",holdStart:30,holdEnd:9}) 对得上,见 §8.10):
 *   0..13   正着走一遍(往右长 → 在右端一边缩一边停)
 *   14..16  空三拍
 *   17..29  倒着重走一遍(12 → 0;那个重复的空拍不再走一遍)
 *   30..53  长空 ~1 秒(holdStart 30 帧里有 6 帧被倒放吃掉了)
 * 54 帧 × 40ms = 2.16s 一圈 —— 之前这里是 14 帧 / 90ms,只取了前半段。 */
function progressShape(n) {
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

function progressCells(i) {
  const n = ((i % PBAR_FRAMES) + PBAR_FRAMES) % PBAR_FRAMES;
  let k;
  if (n < 14) k = n;
  else if (n < 17) k = 13;
  else if (n < 30) k = 13 - (n - 16);
  else k = 13;
  return progressShape(k);
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

/* ---------------- 运行中的工具行:行首标记转起来(TUI 同款) ----------------
 *
 * TUI 实测(pty 抓屏,见 §8.9):工具行行首那个标记在 running 时由 `$` 变成盲文
 * spinner,80ms 一帧、10 帧一循环,跑完回到静态标记。TUI 的帧表 Tz 里 dots 就是这
 * 一组(另有 quadrants / arcs / line,可选);q0 默认用的就是 dots。
 *
 * 注意这和 §8.5 删掉的「行尾 ● 运行中」不是一回事:那是一个**重复的状态文字**
 * (头部已经说了,手机上还会折行);这里是**行首标记的动效**,回答的是「这一行在跑」
 * 这个头部回答不了的问题,位置也照 TUI 放在命令前面。 */
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN_MS = 80;

let spinTimer = null;
let spinFrame = 0;

/* 与 statusInfo() 里 running/streaming 那两条走同一判定,免得两处各写一套。 */
function toolRunning(p) {
  const st = (p.state && p.state.status) || (p.executed ? 'completed' : 'running');
  return st === 'running' || st === 'streaming';
}

function drawSpinFrame() {
  const els = document.querySelectorAll('.tmark.spin');
  if (!els.length) {
    stopSpin();
    return;
  }
  spinFrame = (spinFrame + 1) % SPIN_FRAMES.length;
  const g = SPIN_FRAMES[spinFrame];
  for (const el of els) if (el.textContent !== g) el.textContent = g;
}

function stopSpin() {
  if (spinTimer !== null) {
    clearInterval(spinTimer);
    spinTimer = null;
  }
}

/* 只由渲染后的同步点调(updateChatStatus ← renderMessages)。已经在走的时候【不重开】,
 * 否则每来一个 SSE 事件都会跳回第一帧,看着像卡住 —— 和状态条同一个规矩。
 * 【一律逐帧推】,不看 prefers-reduced-motion:这条是照 TUI 抄的,终端里没这个概念。 */
function syncSpin() {
  if (!document.querySelector('.tmark.spin')) {
    stopSpin();
    return;
  }
  if (spinTimer !== null) return;
  spinTimer = setInterval(drawSpinFrame, SPIN_MS);
}

/* 重试倒计时(脚注上那行 `⚠ Retrying in Ns · attempt K · <原因>`,照 TUI 的 AssistantRetry):
 * TUI 每秒重算一次剩余秒数。这里同一个规矩 —— 只在 DOM 里还有 .afRetry[data-at] 时走,
 * 【一律逐帧推】,不看 prefers-reduced-motion(终端里没有这个概念)。
 * 分工:文字由 assistantFooterHtml 印出时的当下值,之后的每秒靠这里改 .afWhen。 */
let retryTimer = null;

function stopRetryTick() {
  if (retryTimer !== null) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

function drawRetryCountdown() {
  const els = document.querySelectorAll('.afRetry[data-at]');
  if (!els.length) {
    stopRetryTick();
    return;
  }
  const now = Date.now();
  for (const el of els) {
    const span = el.querySelector('.afWhen');
    if (!span) continue;
    const left = Math.max(0, Math.ceil((Number(el.dataset.at || 0) - now) / 1000));
    const text = left > 0 ? 'Retrying in ' + left + 's' : 'Retry due';
    if (span.textContent !== text) span.textContent = text;
  }
}

/* 与 syncSpin 同一个规矩:已经在走的时候不重开,没有目标就停。 */
function syncRetryTick() {
  if (!document.querySelector('.afRetry[data-at]')) {
    stopRetryTick();
    return;
  }
  if (retryTimer !== null) return;
  retryTimer = setInterval(drawRetryCountdown, 1000);
}

function updateChatStatus() {
  // 工具行的行首标记跟着这次渲染一起同步(它只认 DOM 里的 .tmark.spin,自己会收敛)
  syncSpin();
  // 重试倒计时同理(只认 DOM 里的 .afRetry[data-at])
  syncRetryTick();
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
    paintContextUsage();
    updateComposerControls();
    return;
  }
  const st = runStatus(store.selected);
  if (st === 'retry') {
    paint('◌ 重试中', 'state retry', 'retry');
  } else if (st || store.running || compactionRunning()) {
    paint('● 运行中', 'state running', 'run');
  } else {
    /* 回合一结束就不该再留着「Esc 上膛」的痕迹(照 TUI:phase 变 idle 就把 interrupt 归零) */
    disarmInterrupt();
    paint('空闲', 'state', false);
  }
  paintContextUsage();
  updateComposerControls();
}

/* ------------------- 上下文用量(TUI 的 prompt.footer 那块) -------------------
 * TUI 提示栏右边那个 `155.6K (78%)` 不是别处存好的数,而是每次现算(二进制里抠出的原文):
 *
 *   function Us(t,n){let i=n?t.findIndex((a)=>a.id===n):-1;if(n&&i===-1)return;
 *     let s=i===-1?t.length:i,o=t.findLastIndex((a,c)=>a.type==="compaction"&&a.status==="completed"&&c<s);
 *     return t.findLast((a,c)=>a.type==="assistant"&&a.tokens!==void 0&&c>o&&c<s)}
 *   function XN(t,n,i){let s=Us(t,i);if(!s)return;
 *     let o=s.tokens.input+s.tokens.output+s.tokens.reasoning+s.tokens.cache.read+s.tokens.cache.write;
 *     if(o<=0)return; let a=n?.find((c)=>c.providerID===s.model.providerID&&c.id===s.model.id);
 *     return {tokens:o,percent:a?.limit.context?Math.round(o/a.limit.context*100):void 0}}
 *   function d4(t,n){let i=zN(t);return n===void 0?i:`${i} (${n}%)`}
 *
 * 也就是:① 只认「最后一次**已完成**的压缩之后」的 assistant 消息(压缩把上下文清空了,
 * 之前的数不算);② 取最后一条带 tokens 的,求和 input+output+reasoning+cache.read+
 * cache.write;③ 拿这条消息自己记的 (providerID,id) 去**该 location 的模型表**查
 * limit.context 得百分比(模型表按目录分,因为某个模型可能在某个目录被 enabled:false
 * 关掉 —— 全局表会给出这个目录其实不该有的百分比)。第三参是 `session.revert?.messageID`,
 * 撤销暂存时只算到那条消息为止。
 *
 * TUI 另外在 `session.step.ended` 时把 state.usage 直接打上(不等重取);面板这里统一
 * 走现算,`updateChatStatus()` 一个同步点就够(step.ended / usage.updated / 消息落盘
 * 都会经过它)。
 *
 * 显示照 TUI 的两档:`全` = `155.6K (78%)`,`窄` = `78% ctx`(百分比拿不到时退回 `155.6K`)。
 * 两档都印在 DOM 里,由 CSS 按 html.narrow 挑一个 —— 面板宽度变了也不用重画。 */
function lastUsageMessage(msgs, boundID) {
  const bound = boundID ? msgs.findIndex((m) => m.id === boundID) : -1;
  if (boundID && bound === -1) return null;
  const end = bound === -1 ? msgs.length : bound;
  let cut = -1;
  for (let i = end - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === 'compaction' && m.status === 'completed') {
      cut = i;
      break;
    }
  }
  for (let i = end - 1; i > cut; i--) {
    const m = msgs[i];
    if (m.type === 'assistant' && m.tokens) return m;
  }
  return null;
}

function contextUsage(msgs, models, boundID) {
  const m = lastUsageMessage(msgs, boundID);
  if (!m || !m.tokens) return null;
  const cache = m.tokens.cache || {};
  const total =
    (m.tokens.input || 0) + (m.tokens.output || 0) + (m.tokens.reasoning || 0) +
    (cache.read || 0) + (cache.write || 0);
  if (total <= 0) return null;
  const info = m.model && models
    ? models.find((x) => x.providerID === m.model.providerID && x.modelID === m.model.id)
    : null;
  const limit = info && info.limit ? info.limit.context : undefined;
  return { tokens: total, percent: limit ? Math.round((total / limit) * 100) : undefined };
}

/* TUI 提示栏里的工程路径其实是「目录:分支」——`Co()` 先按 home 缩写,再拼
 * `P.location.vcs.info(dir)?.branch.current`(见 §8.20)。分支要问一次服务端,按目录缓存:
 * 问到之前先只印目录,回来再补上 `:分支`;不是 git 仓库就缓存一个空串,不再问。 */
const branchCache = new Map(); // directory -> branch(空串 = 问过了,没有)
const branchPending = new Set();

function cachedBranch(dir) {
  if (!dir) return '';
  if (branchCache.has(dir)) return branchCache.get(dir);
  if (branchPending.has(dir)) return '';
  branchPending.add(dir);
  api('/api/vcs?' + new URLSearchParams({ 'location[directory]': dir }).toString())
    .then((j) => {
      const b = (j && j.data && j.data.branch && j.data.branch.current) || '';
      branchCache.set(dir, b);
    })
    .catch(() => { branchCache.set(dir, ''); })
    .finally(() => {
      branchPending.delete(dir);
      // 回来了补画一次(仍在同一个会话 / 同一个目录上才有意义)
      if (store.selected) paintContextUsage();
    });
  return '';
}

/* TUI 的 `cm(path, home)`:在 home 下面的路径缩成 `~/...`,正好是 home 就是 `~`,
 * 其余(比如挂在 /media 上的工程)原样返回。home 由 /__health 告知(浏览器看不到本机 home)。 */
function abbrevHome(dir) {
  const home = store.home;
  if (!home || !dir) return dir;
  if (dir === home) return '~';
  if (dir.indexOf(home + '/') === 0) return '~/' + dir.slice(home.length + 1);
  return dir;
}

/* 工具行里那些路径照 TUI 的路径格式化缩一下(见 packages/tui/src/util 里的 x4/cm):
 * 先看能不能落到【会话目录】下的相对路径,不能再看在不在 home 下(~/…),都不行就原样。
 * 手机竖屏上一串 /work/example/... 会被省略号截掉半截,缩完才能一眼看出是哪个文件。
 * 会话目录取不到时(离线断言、列表还没回来)原样返回,保证这几个排版函数还是纯的。 */
function normPath(p) {
  const out = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

function abbrevPath(p) {
  const v = toolStr(p);
  if (!v) return v;
  const dir = sessionDir(store.selected);
  if (v.charAt(0) !== '/') return dir ? v.replace(/^\.\//, '') : v;
  const abs = normPath(v);
  if (dir) {
    const base = normPath(dir);
    if (abs === base) return '.';
    if (abs.indexOf(base + '/') === 0) return abs.slice(base.length + 1);
  }
  return abbrevHome(abs);
}

/* 提示栏最左边那格(照 TUI 的 `Ss`):`智能体 · 模型`(有变体再 ` · 变体`)。
 * 工具栏(#ctoolbar)在 #composer 里面 —— 手机把底板收起时它跟着没了,这一格是
 * 收起状态下唯一还能看到「现在是哪个智能体/模型」的地方,所以常驻(只要选中会话)。
 * 取值直接用工具栏那两个 <select> 的当前项文案(它们与模型/智能体下拉同源)。 */
function paintFooterAgent() {
  const el = $('#chatAgent');
  if (!el) return; // 测试页可能没这条
  const a = $('#agentSel');
  const m = $('#modelSel');
  const tb = $('#ctoolbar');
  if (!store.selected || !a || tb && tb.hidden) {
    if (!el.hidden) el.hidden = true;
    if (el.textContent) el.textContent = '';
    return;
  }
  const agent = (a.options[a.selectedIndex] || {}).text || a.value || '';
  const model = (m && m.selectedIndex >= 0 && (m.options[m.selectedIndex] || {}).text) || '';
  const vsel = $('#variantSel');
  const variant = (vsel && vsel.value) || '';
  // 拆成两格:智能体(.agName)和「 · 模型 · 变体」(.agModel)。手机上模型名最长、又是三格里
  // 最不常看的,窄屏那格直接收起来,把宽度让给工程路径(见 styles.css 的 html.narrow 档)。
  // 整条 textContent 仍是「智能体 · 模型 · 变体」,拿它当变更判据照旧。
  const tail = [model, variant && variant !== 'default' ? variant : ''].filter(Boolean).join(' · ');
  const text = [agent, tail].filter(Boolean).join(' · ');
  if (el.textContent !== text) {
    el.innerHTML = agent
      ? '<span class="agName">' + esc(agent) + '</span>' + (tail ? '<span class="agModel"> · ' + esc(tail) + '</span>' : '')
      : '';
  }
  el.hidden = !text;
  if (el.title !== text) el.title = text;
}

/* 提示栏(#promptFooter,照 TUI 的 prompt.footer 放在输入框下面)的工程路径那格。
 * 显示照 TUI:`目录`(按 home 缩成 ~/...) + 有分支时 `:分支`(太长由 CSS 截断,
 * title 里给全路径)。整条只在选中会话时露出来(没会话时它整个收着)。用量那格
 * (#ctxInfo)由下面的 paintContextUsage() 管。 */
function paintPromptFooter(show, dir, known) {
  const foot = $('#promptFooter');
  if (!foot) return; // 测试页可能没这条
  foot.hidden = !show;
  const d = $('#chatDir');
  if (!d) return;
  const branch = show && dir ? cachedBranch(dir) : '';
  /* 【还没到手】与【真没目录】是两回事(§8.44):前者留空,后者才印占位。
   * 深链进来 / 列表那一页还没装这个会话时,store.sessions 里根本查不到它 ——
   * 以前这里印「(未指定工程目录)」,把「还不知道」说成了「这会话没目录」。 */
  const text = dir
    ? abbrevHome(dir) + (branch ? ':' + branch : '')
    : known === false ? '' : '(未指定工程目录)';
  if (d.textContent !== text) d.textContent = text;
  if (d.title !== dir) d.title = dir;
}

/* 正在跑的子会话个数(提示栏那格,照 TUI 的 session.family + status === "running")。
 * 只数是还在跑的 —— TUI 也是这么数(`.filter((g)=>…status(g)==="running")`)。
 * 子会话来自 ① 列表接口里 parentID 的那批;② SSE 的 session.created/updated。 */
function subagentCount(sid) {
  if (!sid) return 0;
  let n = 0;
  for (const cid of store.subs.keys()) {
    if (store.subs.get(cid) === sid && isRunning(cid)) n++;
  }
  return n;
}

/* 这个会话正挂着的持久 shell 个数(提示栏那格,照 TUI 的 shell.list(location) 按
 * metadata.sessionID 过滤;TUI 不过滤状态,活着的都算)。 */
function shellCount(sid) {
  if (!sid) return 0;
  let n = 0;
  for (const owner of store.shells.values()) if (owner === sid) n++;
  return n;
}

/* 提示栏里那个数字:全量文案 + 窄屏文案一起写进去,CSS 按 html.narrow 显示哪一个。
 * 拿不到用量(还没跑过一轮 / 模型不在表里给不出百分比)就收起来 —— 但提示栏本身
 * (路径 + ctrl+p commands)照旧。费用照 TUI 的提示栏:> 0 时在用量后面接 ` · $x.xx`。 */
function paintContextUsage() {
  const sid = store.selected;
  const s = sid ? store.sessions.get(sid) : null;
  const dir = (s && s.location && s.location.directory) || '';
  paintFooterAgent();
  paintPromptFooter(!!sid, dir, !!s);
  const el = $('#ctxInfo');
  if (!el) return; // 测试页可能没这个元素
  const costStr = fmtCost(s && s.cost);
  const u = sid
    ? contextUsage(currentMessages(), store.models.get(dir), (s && s.revert && s.revert.messageID) || '')
    : null;
  // TUI 的提示栏把这句排在用量前面、都用 ` · ` 连(2 subagents · 1 shell · 151.8K (76%))
  const nSub = subagentCount(sid);
  const nShell = shellCount(sid);
  const subParts = [];
  if (nSub) subParts.push(nSub + ' subagent' + (nSub === 1 ? '' : 's'));
  if (nShell) subParts.push(nShell + ' shell' + (nShell === 1 ? '' : 's'));
  const subStr = subParts.join(' · ');
  if (!subStr && !u && !costStr) {
    el.hidden = true;
    el.removeAttribute('title');
    return;
  }
  const size = u ? fmtSize(u.tokens) : '';
  const tokFull = !u ? '' : u.percent === undefined ? size : size + ' (' + u.percent + '%)';
  const tokCompact = !u ? '' : u.percent === undefined ? size : u.percent + '% ctx';
  const full = [subStr, tokFull, costStr].filter(Boolean).join(' · ');
  const compact = [subStr, tokCompact, costStr].filter(Boolean).join(' · ');
  const f = el.querySelector('.ctxFull');
  const c = el.querySelector('.ctxCompact');
  if (f && c) {
    if (f.textContent !== full) f.textContent = full;
    if (c.textContent !== compact) c.textContent = compact;
  } else if (el.textContent !== full) {
    el.textContent = full; // 没有两档子节点(老结构)时的兜底
  }
  const titleParts = [];
  if (u) {
    titleParts.push(
      '上下文用量 ' + u.tokens.toLocaleString() + ' tokens' +
        (u.percent === undefined ? '' : '(' + u.percent + '%)')
    );
    if (costStr) titleParts.push(costStr);
  } else if (costStr) {
    titleParts.push('本会话费用' + ' · ' + costStr);
  }
  if (subStr) titleParts.unshift(subStr + '(正在运行)');
  const title = titleParts.join(' · ');
  if (el.title !== title) el.title = title;
  el.hidden = false;
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

/* forceSingle:type:'string' 带 options 时是单选(question 工具的单选就是这种形状),
 * 它没有 maxItems,所以由调用方显式传 true。 */
function fldOptsHtml(f, forceSingle) {
  const def = Array.isArray(f.default)
    ? f.default
    : typeof f.default === 'string' && f.default
    ? [f.default]
    : [];
  const single = forceSingle === true || f.maxItems === 1;
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
      /* 单选:选项必须**看得见**(question 工具的单选就是 string + options + custom),
       * 手机上没有可点的选项等于没法选 —— TUI 对同一字段也是给选项列表。 */
      return (
        '<div class="opts">' + fldOptsHtml(f, true) + '</div>' +
        '<input class="custom" type="text" placeholder="' +
        esc(f.placeholder || '其它(自填)…') + '"' + valueAttr + '>'
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

  /* 单选 + 自填:二者互斥(question 工具的单选即 string+options / multiselect+maxItems=1) */
  el.querySelectorAll('.ask-field').forEach((w) => {
    const fld = fields[Number(w.dataset.idx)];
    const custom = w.querySelector('input.custom');
    if (!fld || !custom) return;
    const single =
      fld.type === 'multiselect'
        ? fld.maxItems === 1
        : fld.type === 'string' && !!(fld.options || []).length;
    if (!single) return;
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
  if (f.type === 'string' && w.querySelector('input[type=radio]')) {
    /* 单选(选项行):选了就是那个字符串;自填优先,与选项互斥 */
    const custom = w.querySelector('input.custom');
    if (custom && custom.value.trim()) return custom.value.trim();
    const r = w.querySelector('input[type=radio]:checked');
    return r ? r.value : undefined;
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
  // 这几项里有原生 confirm/prompt(改名/移动/删除/归档):一弹就把指针从文档里「抢走」,
  // 列表的临时展开(main.list-peek)会当场被 mouseleave 收掉。动手之前先武装宽限期,
  // 让「删完这一个还能接着删下一个」不至于变成「列表一收就再也拉不回来」。
  if (listPeekHold) listPeekHold();
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
    removeTab(id); // §8.59 真删掉的会话也从标签栏移除
    if (store.selected === id) clearSelection();
    store.msgCache.delete(id); // §8.55 删掉的会话不再留快照(clearSelection 会先快照一次)
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
  { name: 'diff', description: '查看最近一轮变更(照 TUI 的 /diff)', run: () => openDiff() },
  { name: 'worktrees', description: '管理工作树(列出 / 删除 / 把当前会话移进去)', run: () => openWorktrees() },
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
  { k: '/worktrees', d: '列出 / 删除工作树,或把当前会话移进去' },
  { sec: '会话' },
  { k: 'Esc', d: '关命令面板 → 关 @ 补全 → 连按两下中断当前回合(对应 TUI session.interrupt)' },
  { k: 'End', d: '跳回最新消息(对应 TUI session.last);往上翻过头了也能一键回来' },
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
    // 空态照 TUI 的 DialogSelect 分两种:压根没有条目 vs 过滤之后没匹配
    html =
      '<div class="pick-empty">' +
      ((store.pickFilter || '').trim() ? '没有匹配项' : '没有可选项') +
      '</div>';
  }
  store.pickShown.forEach((it, i) => {
    if (it.group && it.group !== lastGroup) {
      html += '<div class="pick-group">' + esc(it.group) + '</div>';
      lastGroup = it.group;
    }
    // 「当前值」那一条照 TUI 的 DialogSelectRow 在最前面钉一枚 ●(挪开高亮之后也认得出);
    // 空着的时候那格也留着,条目名才对得齐。
    const cur = store.pickCurrent !== undefined && it.key === store.pickCurrent;
    html +=
      '<div class="pick-item' + (i === store.pickAt ? ' active' : '') + (cur ? ' current' : '') +
      (it.disabled ? ' disabled' : '') +
      '" role="option" data-i="' + i + '">' +
      '<span class="pi-cur">' + (cur ? '●' : '') + '</span>' +
      '<span class="pi-label">' + esc(it.label || '') + '</span>' +
      (it.sub ? '<span class="pi-sub">' + esc(it.sub) + '</span>' : '') +
      '</div>';
  });
  box.innerHTML = html;
  const act = box.querySelector('.pick-item.active');
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
}

/* 对话框底部那行提示(照 TUI 的 DialogFooter:动作 + 键位)。桌面写键位,手机没有那些键,
 * 换成点哪儿的说法 —— 面板里 #cmdHint 早就是这么分两档的。 */
function paintPickFoot(opts) {
  const foot = $('#pickFoot');
  if (!foot) return;
  const filter = opts && opts.filter ? '打字过滤 · ' : '';
  foot.innerHTML =
    '<span class="hFull">' + esc(filter + '↑↓ 选择 · Enter 选中 · Esc 关闭') + '</span>' +
    '<span class="hNarrow">' + esc(filter + '点条目选中 · 关闭按钮收起') + '</span>';
}

// 打开选择框:items = [{ key, label, sub?, group?, disabled? }];current 的那项默认高亮。
function openPick(opts) {
  const dlg = $('#dlgPick');
  if (!dlg) return;
  store.pickItems = opts.items || [];
  store.pickOnPick = opts.onPick || null;
  store.pickFilter = '';
  store.pickCurrent = opts.current;
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
  paintPickFoot(opts);
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
  // §8.61:动作项的回调可能是异步的(移会话 / 删工作树),把 Promise 透出去方便测,
  // 页面上的点击处理器照样不 await。
  if (fn) return fn(it);
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
  /* 输入框一有动静就把「Esc 上膛」收掉(照 TUI 的 handleInputClear:改了输入就等于
   * 放弃这次中断),免得几秒前的半次 Esc 突然把回合砍了。 */
  inp.addEventListener('input', () => disarmInterrupt());
  inp.addEventListener('keydown', (e) => {
    if (commandKey(e)) return; // 命令面板开着时优先吃方向键/Enter/Tab/Esc
    if (mentionKey(e)) return; // 补全列表开着时,方向键/Enter/Tab/Esc 先给补全
    if (historyKey(e)) return; // 光标在首行/末行时,↑/↓ 取输入历史
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // TUI 里 agent.cycle 就是 tab。补全/命令面板开着时上面已经先把 Tab 吃掉了
      e.preventDefault();
      cycleAgent();
      return;
    }
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

// Esc 的优先级:命令面板 → @ 补全 → 中断(照 TUI:session.interrupt 要按两下,
// 第一下只是「上膛」,见 requestInterrupt)
function setupTuiKeys() {
  // 提示栏里的「⇧tab agents」点了就切下一个智能体(对应 TUI 的 agent.cycle)
  const ahint = $('#agentHint');
  if (ahint && ahint.dataset.wired !== '1') {
    ahint.dataset.wired = '1';
    ahint.addEventListener('click', () => {
      if (anyDialogOpen()) return;
      cycleAgent();
    });
  }
  // 提示栏里的「ctrl+p commands」点了也开命令面板(手机上没 Ctrl 键,这行提示就是入口)
  const hint = $('#cmdHint');
  if (hint && hint.dataset.wired !== '1') {
    hint.dataset.wired = '1';
    hint.addEventListener('click', () => {
      if (anyDialogOpen()) return;
      openCommands({ force: true });
    });
  }
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
        requestInterrupt();
      }
      return;
    }
    if (e.key === 'p' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (anyDialogOpen()) return;
      e.preventDefault();
      openCommands({ force: true });
      return;
    }
    // End = 跳回最新(TUI 的 session.last)。焦点在输入框里时不抢 —— 那儿 End 是「光标到行尾」
    if (e.key === 'End' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const t = e.target;
      const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true);
      if (!inField && !anyDialogOpen() && store.selected) {
        e.preventDefault();
        jumpToLatest();
      }
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
  // 用缓存的贴底判定,别每个 token delta 都去读一次 scrollHeight(文档一脏就是整篇重排)。
  // 滚动事件会把缓存刷掉,用户往上翻了照样立刻停止跟随。
  const nearBottom = store.nearBottom;
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
    if (nearBottom) pinBottom(box);
    updateJumpLatest(nearBottom); // 增量把内容顶长了,按钮的显隐要跟着重算(位置已知道,不再量)
    updateChatStatus();
  }
}

/* ----------------------------- 事件流 ----------------------------- */

let msgTimer = null;
let listTimer = null;
let activeTimer = null;

/* §8.54 慢网(VPN)下的对账节流:SSE 每来一条事件就重拉一次消息列表是 LAN 上的习惯
 * (本机 37ms 回来,用户看不见),但一条 100 条的消息列表在 VPN 上是几百 KB 到 1MB,
 * 事件密一点就会七八条请求一起排队 —— 「正在加载」于是永远挂在那儿。
 * 现在:
 *   · 只对「当前会话 + 真会改消息」的事件排重取(provider/model 与别的会话一律不排);
 *   · 同一时刻只飞一条,飞着的时候再来的合并成一次,落地后隔 MSG_AUTO_GAP_MS 再跑;
 *   · 后台重取不点亮「正在加载消息…」,失败也不把界面盖成错误页(留给下一次);
 *   · 列表刷新同理(SESSION_AUTO_GAP_MS 间隔 + 只认会话行相关事件)。 */
const MSG_AUTO_GAP_MS = 4000;
const SESSION_AUTO_GAP_MS = 2500;
let msgLoadBusy = false;
let msgLoadGen = 0;
let msgAbort = null;
let msgAutoQueued = false;
let msgLastDone = 0;
let msgAutoTimer = null;
let sessionLoadBusy = false;
let sessionLoadGen = 0;
let sessionAutoQueued = false;
let sessionLastDone = 0;
let sessionAutoTimer = null;
let sseConnectedOnce = false;

function scheduleAutoMsg(delay) {
  clearTimeout(msgAutoTimer);
  msgAutoTimer = setTimeout(() => {
    msgAutoTimer = null;
    if (!store.selected) return;
    loadMessages({ older: false, auto: true });
  }, delay);
}

function scheduleAutoSessions(delay) {
  clearTimeout(sessionAutoTimer);
  sessionAutoTimer = setTimeout(() => {
    sessionAutoTimer = null;
    loadSessions({ auto: true });
  }, delay);
}

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
  } else if (t.indexOf('session.compaction.') === 0) {
    // 压缩不是普通回合:实测 /api/session/active 在压缩跑到一半时会空一拍,
    // 只认 status/execution 的话状态条会中途灭掉。这里直接按压缩事件记一笔。
    // 三条事件必须分开对待,合并成一句就会出事:
    //   .started      开工(顺手清掉上一次的流式正文)
    //   .delta        概要正文的增量,【不是】收工信号。原来 else 一把抓:每来一条
    //                 就把压缩标记抹掉 + dirty 一次 → 重画整个左栏。实测一份 8 KB
    //                 的摘要 140+ 条 delta(5ms 一条)触发了 142 次 renderSessions,
    //                 压缩那几秒面板整个假死(用户报的「网页版崩溃无响应」)。
    //                 它只是文本:攒进缓冲、节流重画对话区(照 TUI 边压边印)。
    //   .ended/.failed 收工;载荷里带着完整摘要,直接记下来先印上,不等消息列表对账。
    if (sid && t === 'session.compaction.started') {
      store.compacting.add(sid);
      store.compactText.delete(sid);
      // 立刻往消息流里放一块「进行中」:用事件给的 inputID 当 id,服务端那条真消息
      // 一到就同 id 覆盖(不用干等那次对账拉取 —— 正文流得快时对账会一直被推后)。
      if (d.inputID && sid === store.selected && !store.messages.has(d.inputID)) {
        store.messages.set(d.inputID, {
          id: d.inputID, type: 'compaction', status: 'running', time: { created: Date.now() },
        });
      }
      dirty = true;
    } else if (sid && t === 'session.compaction.delta') {
      pushCompactText(sid, d.text || '');
      paintCompactStream(sid);
    } else if (sid) {
      // .ended / .failed(以后再加别的 .xxx 也按收工处理,免得又漏)
      store.compacting.delete(sid);
      const final = typeof d.text === 'string' && d.text ? d.text : '';
      if (final) store.compactText.set(sid, final);
      // 手里那块还在「进行中」就地收工(真消息随后会原 id 覆盖掉,内容一致)
      if (sid === store.selected) {
        for (const m of store.messages.values()) {
          if (m.type === 'compaction' && m.status === 'running') {
            m.status = t === 'session.compaction.failed' ? 'failed' : 'completed';
            if (final && !m.summary) m.summary = final;
            if (d.error) m.error = d.error;
            if (d.tokens) m.tokens = d.tokens;
          }
        }
      }
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
      if (info.parentID && info.id) store.subs.set(info.id, info.parentID);
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
      store.subs.delete(id);
      store.inbox.delete(id);
      for (const [mid, L] of store.live) if (L.sid === id) store.live.delete(mid);
      if (store.selected === id) clearSelection();
      store.msgCache.delete(id); // §8.55 删掉的会话不再留快照
      dirty = true;
    }
    refreshActive = true;
  } else if (t === 'session.created') {
    // 子会话(照 TUI 的 session.family):记住 子→父,提示栏数「正在跑的子会话」用
    const info = d.info;
    if (info && typeof info === 'object' && info.id && info.parentID) {
      store.subs.set(info.id, info.parentID);
      if (store.selected === info.parentID) dirty = true;
    }
    refreshActive = true;
  } else if (t === 'shell.created') {
    // 持久 shell(照 TUI 的 shell.list(location) 按 metadata.sessionID 数)
    const info = d.info;
    if (info && info.id) {
      const owner = (info.metadata && info.metadata.sessionID) || '';
      store.shells.set(info.id, owner);
      if (owner && owner === store.selected) dirty = true;
    }
  } else if (t === 'shell.exited' || t === 'shell.deleted') {
    const id = d.id || (d.info && d.info.id);
    if (id) {
      const owner = store.shells.get(id);
      store.shells.delete(id);
      if (owner && owner === store.selected) dirty = true;
    }
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

  const t = e.type || '';
  const evSid = d.sessionID || (d.info && d.info.id) || '';
  const mine = !evSid || evSid === store.selected; // 没带会话 id 的按「可能是」处理,宁可多拉一次
  // §8.54 消息对账:只认当前会话 + 真会改消息的事件。
  // provider/model 之类的全局事件、别的会话的流事件、tools 的高频增量,都不值得拉。
  const msgWorthy =
    mine && /^(session\.|message\.)/.test(t) &&
    !/^session\.(created|updated|deleted|renamed|moved|agent\.selected|model\.selected|inbox\.)/.test(t) &&
    t !== 'session.tool.progress' &&
    t !== 'session.tool.input.delta' &&
    t !== 'session.compaction.delta';
  // 断线重连后补一次(第一次连上不算,首屏的 loadMessages 已经在跑)
  const reconnect = t === 'server.connected' && sseConnectedOnce;
  if (t === 'server.connected') sseConnectedOnce = true;
  if ((msgWorthy && !(local && isStreamDelta(t))) || reconnect) {
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      if (store.selected) loadMessages({ older: false, auto: true });
    }, 150);
  }
  // §8.54 列表刷新:只认会改左栏行的那几类事件。原来每条 SSE 都排一次 1500ms
  // (provider.updated 也算),VPN 下等于每 1.5s 白拉一次会话列表。
  const listWorthy =
    /^session\.(created|updated|deleted|renamed|moved|agent\.selected|model\.selected)$/.test(t) ||
    t === 'shell.created' || t === 'shell.exited' || t === 'shell.deleted' || reconnect;
  if (listWorthy) {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => loadSessions({ auto: true }), 1500);
  }
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
 *
 * 「收起」记在 sessionStorage —— 它只活在这【一个标签页】里,于是两句话都成立:
 *   - 刷新(F5)之后还是收起的(用户:「本来是没展开的,刷新之后就展开了」);
 *   - 新开一个标签页是展开的(§8.13 用户:「第一次打开网页时应该展开对话列表」)。
 * 记 localStorage 会把「顺手收过一次」变成跨标签页、跨重启的永久状态(§8.13 那次
 * 困扰就是这么来的);记 sessionStorage 则跟滚动位置(ocs.scroll)一个存法:本标签页的事。
 *
 * 只有【点手柄】才算显式,才写这份记忆;鼠标靠左边缘的临时拉出(list-peek)一个字都不写
 * —— 那是「路过看一眼」。列宽 ocs.listW 照旧记在 localStorage。
 * (v1 把折叠记在 localStorage['ocs.listHidden'];那个键现在没人读,也别再写它。) */
const LIST_KEY = 'ocs.listHiddenTab';

/* 这一档现在该不该收起:记过就听记的;没记过 = 展开(列表是主入口)。 */
function listCollapsed() {
  try {
    return sessionStorage.getItem(LIST_KEY) === '1';
  } catch (_) {
    return false; // 存储被禁(隐私模式)时当作没记过 —— 折叠本身照用
  }
}

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

  paint(listCollapsed()); // 刷新后还是上次的样子;新标签页 / 从没碰过 = 展开
  // 重复接线只重画(画成记住的样子),不重复挂监听 —— 否则点一下会触发两次、看起来没反应
  if (btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  // 以 DOM 上的类为准(别再引一份可能对不上的状态):点一下就是「现在收着就展开、开着就收起」
  btn.addEventListener('click', () => {
    const hidden = !main.classList.contains('list-hidden');
    paint(hidden);
    try {
      if (hidden) sessionStorage.setItem(LIST_KEY, '1');
      else sessionStorage.removeItem(LIST_KEY);
    } catch (_) {} // 记不住就算了,别把折叠本身弄坏
  });
}

/* 临时展开的「宽限期」:动手(改名/移动/删除/归档)会弹原生 confirm/prompt。原生弹窗期间
 * 页面会收到一串看着像「指针跑掉了」的事件 —— mouseleave(指针离开文档),弹窗关掉时
 * 还可能再来一发 mousemove(浏览器拿弹窗里的位置来同步指针状态)。只要有一条落到
 * 「不在分栏槽里」的判定上,临时展开当场就被收掉;更麻烦的是收掉后分栏槽缩回 x=0..16,
 * 指针已经不在槽里,再动一下就被判成「挪进对话区」,列表再也拉不回来 —— 想「删完这个
 * 接着删下一个」都做不到。
 *
 * 所以动手之前先武装一段宽限期:这几秒里【谁来都不收】(mouseleave 与 mousemove 两条
 * 路径都挡),到点再按「指针最后一次真实移动停在哪」复查一遍 —— 还在槽里就继续留着,
 * 已经挪进对话区就收掉。真实意图只被推迟几秒,不会被吃掉。 */
const PEEK_HOLD_MS = 5000; // 用户实测后定的:5 秒左右自己收
let peekHoldUntil = 0; // > Date.now():宽限期里,谁也别想把它收掉
let peekHoldTimer = 0;
let peekLastX = -1; // 指针最后一次真实 mousemove 停在哪
let listPeekHold = null; // 由列表临时展开那段接线装上,onAction() 动手前叫一声

/* -------------------- 鼠标靠左边缘:列表临时拉出来 --------------------
 * 列表收起之后,左侧那条 16px 分栏槽是鼠标最容易撞到的边界(它就在最左边)。
 * 靠上去就把列表临时拉出来,移开就收回去 —— 省掉「点手柄 → 看一眼 → 再点回去」。
 *
 * 三件事刻意不碰:
 *   1. 「是不是收起着」这份状态不动。这是「路过看一眼」,不是改设置;
 *      点手柄才算显式展开(setupListToggle 把 list-hidden 摘掉),那时顺手把临时态摘掉,列表就保持住了。
 *   2. 收回的判定不用 mouseleave + relatedTarget:临时展开会把分栏槽从光标底下挪走
 *      (收起时它在 x=0,展开后跑到列表右边),光标底下换元素时 relatedTarget 在浏览器之间不可靠,
 *      换来换去就是闪。改成「按分栏槽右沿判定」:收起时右沿=16(贴到左边缘就展开),
 *      临时展开后右沿=列表宽+16(整个「列表 + 槽」都留着),天然免疫元素挪位。
 *   3. 窄屏不管:那边 .resizer 是 display:none,根本收不到鼠标事件(这里再加一道判定兜底)。
 */
function setupListPeek() {
  const main = document.querySelector('main');
  const rz = document.getElementById('resizer-mid');
  const pane = document.getElementById('listpane');
  if (!main || !rz || !pane) return;

  // force = 显式收掉(点手柄、初始化、到点复查),不吃宽限期
  const hide = (force) => {
    if (!force && Date.now() < peekHoldUntil) return; // 宽限期里谁来都不收
    main.classList.remove('list-peek');
    peekHoldUntil = 0;
    if (peekHoldTimer) { clearTimeout(peekHoldTimer); peekHoldTimer = 0; }
  };
  const onMove = (e) => {
    peekLastX = e.clientX; // 只认真实移动 —— 到点复查靠它
    // 常态(列表好好开着)不 measure、也不留残留的临时态 —— 早退
    if (!main.classList.contains('list-hidden')) {
      if (main.classList.contains('list-peek')) hide(true);
      return;
    }
    if (document.documentElement.classList.contains('narrow')) return;
    if (Date.now() < peekHoldUntil) return; // 宽限期里连真实移动也不收(用户要「等个几秒」)
    if (e.clientX < rz.getBoundingClientRect().right) main.classList.add('list-peek');
    else hide();
  };
  /* 到点复查:指针最后停在哪 —— 还在分栏槽里就留着(那多半只是想接着删下一个),
   * 已经挪进对话区就收掉。 */
  const holdExpire = () => {
    const left = peekHoldUntil - Date.now();
    if (left > 0) { peekHoldTimer = setTimeout(holdExpire, left + 30); return; } // 期间又动过手
    peekHoldTimer = 0;
    peekHoldUntil = 0;
    if (!main.classList.contains('list-peek')) return;
    if (peekLastX >= 0 && peekLastX >= rz.getBoundingClientRect().right) hide(true);
  };
  const peekHold = () => {
    if (document.documentElement.classList.contains('narrow')) return;
    if (!main.classList.contains('list-hidden')) return; // 列表本来就开着,没什么可保的
    if (!main.classList.contains('list-peek')) return; // 没在临时展开
    peekHoldUntil = Date.now() + PEEK_HOLD_MS;
    if (!peekHoldTimer) peekHoldTimer = setTimeout(holdExpire, PEEK_HOLD_MS + 30);
  };
  listPeekHold = peekHold; // 给 onAction() 用:动手之前叫一声

  if (main.dataset.peekWired !== '1') {
    main.dataset.peekWired = '1';
    main.addEventListener('mousemove', onMove);
    main.addEventListener('mouseleave', () => hide(false)); // 移出整个主区(含移出窗口)就收回
    const btn = document.getElementById('btnList');
    // 临时展开期间点手柄 = 显式展开并保持(setupListToggle 已经写好记忆与类),这里只摘掉临时态
    if (btn) btn.addEventListener('click', () => hide(true));
  }
  hide(true);
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

/* §8.43:手机上「上下文用量」那一格(#ctxInfo)搬到标题行末尾 —— 输入框下面那一行窄屏整条
 * 不显示(§8.42),那五格里只有用量值得留在眼前(§8.15 的初衷:能「看一眼」)。搬的是
 * 【同一个节点】,没有镜像副本(和 #jumpLatest / #msgState 一样靠 id 找);宽屏搬回
 * 提示栏里原来的位置(#chatDir 之后、#agentHint 之前)。窄屏判定源仍然只有 <html>.narrow
 * 一处 —— 与 CSS 用同一个类,不另设变量。
 * 两处调用:① syncNarrowClass()(跨断点/转屏,也覆盖首次);② paintChatHeader()
 * (会话画出来时兜一道,免得深链直接进会话那一下漏掉)。函数本身幂等,已在位就直接返回。 */
function syncCtxInfoHome() {
  const ctx = $('#ctxInfo');
  const foot = $('#promptFooter');
  const line = $('#chatHeader .chline');
  if (!ctx || !foot || !line) return;
  const narrow = document.documentElement.classList.contains('narrow');
  const home = narrow ? line : foot;
  if (ctx.parentElement === home) return;
  if (narrow) line.appendChild(ctx);
  else foot.insertBefore(ctx, $('#agentHint') || null);
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
  syncCtxInfoHome(); // §8.43:用量那格的家跟着窄屏走(同一个类,不另设判定)
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
  // §8.59 先把上次的标签栏画出来(标题是刷新前的快照),再拉列表对账
  store.tabs = readTabs();
  setupSessionTabs();
  renderTabs();
  health();
  setInterval(health, 15000);
  loadDiffPref(); // §8.60 首屏读 TUI 的 cli.json diffs.view(旧本地偏好会迁过去一次)
  setupFilters(); // 先回填顶栏筛选/排序/搜索,再拉列表(否则会按默认值白拉一次)
  // 恢复顺序:先让列表落地(会话标题/目录要能取到),再回到 hash 里那个会话
  loadSessions({ reset: true }).then(restoreFromHash);
  loadActive();
  setInterval(loadActive, 8000);
  setupEvents();
  setupResizers();
  setupListToggle();
  setupListPeek(); // 鼠标靠左边缘临时拉出列表(桌面专属)
  setupNarrow();
  setupComposerToggle(); // 底板收起/展开(手机默认收起,见上面那一节)
  setupHistoryNav();
  setupScrollMemory();
  setupAutoOlder(); // 窄屏 / 实测慢链路滚到顶自动拉更旧(§8.41 / §8.55)
  setupJumpLatest(); // 一键回底(TUI 的 Jump to latest / End)
  setupMsgState(); // 拉消息的状态行(正在加载 / 加载失败 + 重试)
  setupListState(); // 拉会话列表的状态行(同上,挂在左栏里,§8.45)
  setupRepinWatch(); // 盯内容高度的补贴底(§8.46)
  setupDiffView(); // diff 卡片的并排 / 统一视图切换(§8.52,仅桌面)
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
  $('#newWt').addEventListener('change', paintNewWorktree);
  $('#newWtGen').addEventListener('click', () => {
    $('#newWtName').value = wtSlug();
  });
  $('#newModel').addEventListener('change', () =>
    paintVariant($('#newVariantWrap'), $('#newVariant'), $('#newModel').value)
  );
  $('#importOk').addEventListener('click', submitImport);
  $('#exportOk').addEventListener('click', submitExport);
  $('#tuiCopy').addEventListener('click', copyTui);
  $('#diffReload').addEventListener('click', loadDiff);
  // 关框就让在途请求作废,别在后台把结果写回已关掉的框
  $('#dlgDiff').addEventListener('close', () => {
    diffSeq++;
  });
  document.querySelectorAll('dialog.dlg [data-close]').forEach((b) =>
    b.addEventListener('click', () => closeDlg(b.closest('dialog')))
  );

  setupListActions();
}

document.addEventListener('DOMContentLoaded', init);
