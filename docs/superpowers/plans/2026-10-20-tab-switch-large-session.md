# 大会话标签切换卡顿修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让“串口工具”这类包含大工具输出的会话在标签页切回时不再重复整表重绘、重复请求和重复排版。

**Architecture:** 保持现有 `selectSession()` 流程不变，只修三个同步热点：`renderControls()` 在模型表已缓存时不再补一次 `renderMessages()`；shell 大输出复用现有 §8.83 的懒渲染壳；缓存命中且会话摘要未更新、且不在运行中时跳过整页消息对账。测试全部使用合成会话，不读真实会话。

**Tech Stack:** 原生 JavaScript、HTML 测试页、Node 测试运行器、Firefox headless、`test/smoke.sh` 静态锁。

**Spec:** `docs/superpowers/specs/2026-10-15-mobile-design.md`（新增 §8.91 记录本次修复）

## Global Constraints

- 零依赖、零构建；不引入框架、打包器或新运行时依赖。
- 响应式行为只走 `html.narrow` / `html.short`，不新增 `@media` 分叉。
- 测试数据必须合成；不得包含真实会话 ID、真实路径、内部用户名、密码或作者邮箱。
- 不打断真实会话；不调用真实模型；不改服务端 API。
- 提交信息用中文；完整回归通过后同步 GitLab `origin` 与 GitHub `github`。
- 现有行为除了本计划明确列出的三点外不得改变。

## Review Focus

- **大 shell 输出离屏时**：首屏应只出现摘要壳，滚动进入视口后才补正文；不能把整段输出重新塞回 DOM。
- **会话正在运行/压缩时**：即使缓存摘要没变，也必须继续对账，不能因为跳过请求而停在旧内容。
- **会话摘要 `time.updated` 变新时**：必须重新拉消息并重绘，不能把旧缓存当权威。
- **模型表首次为某目录加载时**：脚注里的模型名仍要在模型表到达后补一次重绘。
- **缓存旧但会话没更新时**：不能每次点标签都重新拉 MB 级消息；但刷新页面/清缓存后仍要正常冷开。

---

### Task 1: `renderControls()` 不再重复重绘

**Files:**
- Modify: `public/app.js`（`renderControls()`）
- Test: `test/ui-controls.html`

**Interfaces:**
- Consumes: `store.models: Map<string, Model[]>`, `store.modelIndex: Map<string, Model>`, `modelKey(ref)`, `loadAgents(dir)`, `loadModels(dir)`.
- Produces: `renderControls(s)` 签名不变；只在 `needModelPaint` 为真时调用 `renderMessages()`。

- [x] **Step 1: 写失败测试**

在 `test/ui-controls.html` 的智能体/模型选择器断言后加入：

```js
/* 模型表已经缓存时,renderControls 只更新选择器,不再补一次整表重绘 */
var paintCalls = 0;
var realRenderMessages = renderMessages;
renderMessages = function () { paintCalls++; return realRenderMessages.apply(this, arguments); };
store.models.clear();
store.modelIndex.clear();
store.ctrlKey = '';
await renderControls(SESSION);
T('模型表首次加载后补一次脚注重绘', paintCalls === 1, paintCalls);
await renderControls(SESSION);
T('模型表已缓存时不再重复重绘', paintCalls === 1, paintCalls);
renderMessages = realRenderMessages;
```

- [x] **Step 2: 跑测试确认失败**

Run: `node test/ui-controls-run.js`
Expected: `模型表已缓存时不再重复重绘` FAIL（第二次仍为 2）。

- [x] **Step 3: 实现条件重绘**

在 `renderControls()` 里、`await Promise.all(...)` 之前计算：

```js
const curModel = modelKey(s.model);
const needModelPaint = !store.models.has(dir) || (!!curModel && !store.modelIndex.has(curModel));
```

删除后面重复声明的 `const curModel`，并把结尾的 `renderMessages();` 改成：

```js
if (needModelPaint) renderMessages();
```

- [x] **Step 4: 跑测试确认通过**

Run: `node test/ui-controls-run.js`
Expected: 原有断言 + 新增两项全过，0 失败。

- [x] **Step 5: 提交**

```bash
git add public/app.js test/ui-controls.html
git commit -m "优化：模型表已缓存时不再重复重绘消息"
```

---

### Task 2: shell 大输出接入懒渲染

**Files:**
- Modify: `public/app.js`（`toolOutputText()`、`toolBodyBytes()`、`toolBodyHtml()`、`toolHtml()`）
- Test: `test/ui-tools.html`

**Interfaces:**
- Consumes: `toolKind(p)`, `toolOutputHtml(st)`, `toolBodyBytes(p)`, `lazyToolCard(p, line, counts)`, `lazyToolBodyCandidate(p)`, `LAZY_TOOL_CARD_MIN`.
- Produces: `toolOutputText(st): string`；`toolBodyBytes(p)` 对 `kind === 'shell'` 返回输出字符数；`toolBodyHtml(p)` 对 shell 返回 `<pre>` 正文；`toolHtml(p, lazy)` 在 shell 输出超过门槛且 `lazy` 为真时返回懒壳。

- [x] **Step 1: 写失败测试**

在 `test/ui-tools.html` 的 §8.83 懒渲染测试组里加入：

```js
var bigShell = {
  type: 'tool', id: 'lazy_shell_big', name: 'bash',
  state: {
    status: 'completed',
    input: { command: 'cat /dev/ttyUSB0' },
    content: [{ type: 'text', text: ('serial line\n').repeat(3000) }],
  },
};
var bigShellLazy = toolHtml(bigShell, true);
T('懒渲染:大 shell 输出先出懒壳',
  bigShellLazy.indexOf('class="tool lazy"') >= 0 && bigShellLazy.indexOf('<pre>') < 0,
  bigShellLazy.slice(0, 120));
T('懒渲染:shell 输出计入懒渲染门槛',
  toolBodyBytes(bigShell) >= LAZY_TOOL_CARD_MIN, toolBodyBytes(bigShell));
T('懒渲染:不懒时 shell 输出仍完整',
  toolHtml(bigShell).indexOf('<pre>') >= 0 && toolHtml(bigShell).indexOf('serial line') >= 0);
```

- [x] **Step 2: 跑测试确认失败**

Run: `node test/ui-tools-run.js`
Expected: `懒渲染:大 shell 输出先出懒壳` FAIL（当前 shell 直接出 `<pre>`）。

- [x] **Step 3: 实现 shell 懒渲染**

1. 把 `toolOutputHtml()` 里的取文本逻辑抽成 `toolOutputText(st)`：

```js
function toolOutputText(st) {
  if (!Array.isArray(st.content)) return '';
  return st.content.map((c) => (c && c.text) || '').join('\n').trim();
}
```

2. `toolBodyBytes(p)` 在 write 分支后加：

```js
if (kind === 'shell') return toolOutputText(st).length;
```

3. `toolBodyHtml(p)` 在 write 分支后加：

```js
if (kind === 'shell') return toolOutputHtml(st);
```

4. `toolHtml(p, lazy)` 的 shell 分支改成：

```js
if (kind === 'shell') {
  const out = toolOutputHtml(st);
  if (!out) return '<div class="toolrow">' + toolHead(p, line) + '</div>';
  if (lazy && lazyToolBodyCandidate(p)) return lazyToolCard(p, line, null);
  return toolCard(p, line, null, out, false);
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `node test/ui-tools-run.js`
Expected: 原有 368 项 + 新增 3 项全过，0 失败。

- [x] **Step 5: 提交**

```bash
git add public/app.js test/ui-tools.html
git commit -m "优化：shell 大输出复用工具卡懒渲染"
```

---

### Task 3: 会话未更新时跳过多余的消息对账

**Files:**
- Modify: `public/app.js`（`cacheCurrentMessages()`、`selectSession()`）
- Test: `test/ui-jump.html`

**Interfaces:**
- Consumes: `store.sessions: Map<string, Session>`, `store.msgCache: Map<string, {messages, cursor, at, updated}>`, `isRunning(sid)`, `MSG_CACHE_FRESH_MS`.
- Produces: 缓存快照多一个 `updated: number`；`selectSession(id)` 的 `fresh` 在“缓存存在 + `session.time.updated <= cached.updated` + 不在运行中”时为真。

- [x] **Step 1: 写失败测试**

在 `test/ui-jump.html` 的 §8.55 缓存测试组里，先把旧的“缓存过期要后台对账”用例改成摘要变新：

```js
var cachedA = store.msgCache.get('ses_a');
cachedA.at = Date.now() - 5000;
cachedA.updated = 4; // 服务端摘要比快照新 → 仍要对账
```

再在“缓存还热”断言后加入：

```js
/* 缓存旧了,但会话摘要没更新:不再整页重拉 */
await selectSession('ses_b');
var mN2 = msgN();
var cachedA2 = store.msgCache.get('ses_a');
cachedA2.at = Date.now() - 5000;
cachedA2.updated = 5; // 与 ses_a.time.updated 相同
await selectSession('ses_a');
T('会话摘要没更新时,缓存旧了也不重拉', msgN() === mN2, msgN() - mN2);
```

- [x] **Step 2: 跑测试确认失败**

Run: `node test/ui-jump-run.js`
Expected: `会话摘要没更新时,缓存旧了也不重拉` FAIL（当前过期缓存必发请求）。

- [x] **Step 3: 实现缓存摘要比较**

1. `cacheCurrentMessages()` 里取会话摘要并写入 `updated`：

```js
const s = store.sessions.get(id);
store.msgCache.set(id, {
  messages: new Map(store.messages),
  cursor: store.msgOlderCursor,
  at: Date.now(),
  updated: (s && s.time && s.time.updated) || 0,
});
```

2. `selectSession()` 的 `fresh` 改成：

```js
const cachedSession = store.sessions.get(id);
const sessionUpdated = cachedSession && cachedSession.time && cachedSession.time.updated;
const unchanged = !!(cached && cached.updated && sessionUpdated &&
  sessionUpdated <= cached.updated && !isRunning(id));
const fresh = cached && (Date.now() - cached.at < MSG_CACHE_FRESH_MS || unchanged);
```

- [x] **Step 4: 跑测试确认通过**

Run: `node test/ui-jump-run.js`
Expected: 原有断言 + 新增断言全过，0 失败。

- [x] **Step 5: 提交**

```bash
git add public/app.js test/ui-jump.html
git commit -m "优化：空闲会话切回时不再重复拉整页消息"
```

---

### Task 4: 静态锁、文档与完整回归

**Files:**
- Modify: `test/smoke.sh`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-15-mobile-design.md`
- Test: 全量回归脚本

**Interfaces:**
- Consumes: Task 1–3 的实现与测试。
- Produces: 三条静态锁、§8.91 文档、README 测试数量更新。

- [x] **Step 1: 加静态锁**

在 `test/smoke.sh` 现有附件/@ 补全锁附近加入三项：

```bash
if has "$APPJS" 'needModelPaint' && has "$APPJS" 'if (needModelPaint) renderMessages'; then
  echo "PASS: 模型表已缓存时不再重复重绘消息"; pass=$((pass + 1))
else
  echo "FAIL: renderControls 缺少条件重绘"; fail=$((fail + 1))
fi
if has "$APPJS" 'toolOutputText' && has "$APPJS" "if (kind === 'shell') return toolOutputText"; then
  echo "PASS: shell 大输出接入懒渲染"; pass=$((pass + 1))
else
  echo "FAIL: shell 大输出没有接入懒渲染"; fail=$((fail + 1))
fi
if has "$APPJS" 'cached.updated' && has "$APPJS" 'sessionUpdated <= cached.updated'; then
  echo "PASS: 空闲会话缓存摘要比较在"; pass=$((pass + 1))
else
  echo "FAIL: 缺少空闲会话缓存摘要比较"; fail=$((fail + 1))
fi
```

- [x] **Step 2: 跑 smoke 确认通过**

Run: `bash test/smoke.sh`
Expected: 原有 386 项 + 新增 3 项全过。

- [x] **Step 3: 更新文档**

在 `docs/superpowers/specs/2026-10-15-mobile-design.md` 加入 §8.91，记录：

- 探针数据：合成 10.1MB 串口会话，缓存过期 418ms，缓存命中 172ms；
- 三处改动及收益；
- shell 大输出懒渲染的交互含义；
- 回归数量。

在 `README.md` 更新 `ui-controls` / `ui-jump` / `ui-tools` / `smoke` 的测试数量与一句行为说明。

- [x] **Step 4: 跑完整回归**

Run: `bash /tmp/opencode/perf/regress-887.sh`
Expected: 所有套件 0 失败；2 个可选真实模型用例跳过。

- [x] **Step 5: 提交并同步**

```bash
git add test/smoke.sh README.md docs/superpowers/specs/2026-10-15-mobile-design.md
git commit -m "文档：记录大会话标签切换优化与回归"
git push origin main
git push github main
```

---

## Self-Review

- **Spec coverage:** 三次热点分别有独立任务与测试；文档和同步在 Task 4。
- **Step scan:** 每个测试步骤给了断言，每个实现步骤给了签名/条件；没有“处理边界”这类空话。
- **Type consistency:** `needModelPaint`、`toolOutputText`、`cached.updated`、`sessionUpdated` 在实现和测试中使用同一名称。
- **Review Focus:** 运行中/摘要变新/首次模型表/离屏 shell/缓存旧但未更新均有测试或明确判定。
- **Proportion:** 计划只列决策与断言，不抄完整函数体。
