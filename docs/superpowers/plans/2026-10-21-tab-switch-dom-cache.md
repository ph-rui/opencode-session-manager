# 切回会话复用整棵消息 DOM 实施计划（§8.96）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务逐条落实。步骤一律用 `- [ ]` 勾选跟踪。

**Goal:** 让标签之间来回切时不再为同一个会话反复重建整张消息表 —— 把已经画好的消息
DOM 按会话留在内存里，切回来原样接上，并跳过逐条签名比对。

**Architecture:** 不动 `selectSession()` 的主流程，只加两件事：
(1) 切走时 `stashMessagesDom(prev)` 把 `msgEls` 里的节点整体挪进 `DocumentFragment`；
(2) 切回来时 `restoreMessagesDom(id, cached)` 在 `paintMsgState()` / `revealActiveTab()`
之后把 fragment 接回 `#messages`，并给这次 `renderMessages()` 一个 `store.domFast`
快路径标记，跳过逐条 `JSON.stringify` 签名与比对，只走滚动还原 / 贴底 / 懒渲染收尾。

**Spec:** `docs/superpowers/specs/2026-10-15-mobile-design.md` §8.96

**Tech Stack:** 原生 JavaScript、Node 探针脚本（真 `index.html` + 真 `app.js` + 合成 API）、
HTML 测试页、无头 Firefox、`test/smoke.sh` 静态锁。

## Global Constraints

- 零依赖、零构建；不引入框架、打包器或新运行时依赖。
- 不改缓存过期 / 对账规则（§8.91 的 `fresh` / `unchanged` 判定原样保留）。
- 不改标签栏、布局、窄屏规则和 `#jumpLatest` / `#msgState` 的既有语义。
- 测试与探针全部使用合成会话，不读、不打断真实会话，不调用真实模型。
- 提交信息用中文；完整回归通过后同步 `origin`（GitLab）与 `github`（GitHub）。

## Review Focus

- **运行中的会话**：切走时不许把节点存进 DOM 缓存 —— 流式增量下一帧还会改这些节点。
- **缓存条目被对账换过**：消息集合可能变了，必须退回整表重绘，不能接旧 DOM。
- **滚动还原**：接回节点后仍要按 `savedAnchor()` / `store.restoreScroll` 还原，
  贴底 / 「跳到最新」/ `cvmany` 的 `repinUntilStable` 行为不变。
- **两次排版**：接回节点必须排在 `revealActiveTab()` 之后，否则会先白排一遍
  500 条消息（实测 +140ms）。
- **内存**：最多 3 个会话，LRU 淘汰；被淘汰后切回就是改前的行为。

---

### Task 1: 会话级 DOM 缓存

**Files:**
- Modify: `public/app.js`（`cacheCurrentMessages()` 之后新增 `msgDomCache` /
  `stashMessagesDom()` / `restoreMessagesDom()`）

- [x] `MSG_DOM_MAX = 3`、`msgDomCache = new Map()`、`msgIdsSig()`。
- [x] `stashMessagesDom(sid)`：`isRunning(sid)` 或该会话有 live 缓冲 → 直接返回；
      只搬 `rec.el.parentNode === #messages` 的节点；连同 `store.msgCache` 条目、
      消息 id 序列一起入缓存；超限丢最旧。
- [x] `restoreMessagesDom(sid, cached)`：`msgCache` 条目必须还是存 DOM 时那一份、
      消息 id 序列一致、`domGen` 没换过；`insertBefore(frag, box.firstChild)`；
      恢复 `msgEls` 并设置 `store.domFast`。
- [x] `bumpDomGen()`：`setExploreGroup()` / `redrawDiffCards()` 里换代，让全局渲染
      偏好一变（探索分组、diff 视图、分栏宽窄）缓存里的 DOM 全部失效。

### Task 2: 接进 `selectSession()`

- [x] `cacheCurrentMessages()` 之后调用 `stashMessagesDom(prev)`（此时 `store.selected`
      还是 `prev`）。
- [x] `restoreMessagesDom(id, cached)` 放在 `paintMsgState()` / `renderAsks()` /
      `syncNarrowView()` / `revealActiveTab()` 之后、`renderMessages()` 之前。

### Task 3: `renderMessages()` 快路径

- [x] 顶部判定 `domFast = store.domFast && sid === store.selected && ids 相同`，
      读完立刻清掉标记。
- [x] 快路径下不再调 `updateJumpLatest()` 先量一次（DOM 已在位，量一次就是整页重排）；
      切会话一定有锚点或 `forceBottom`，收尾那一步本来就会排。
- [x] 删除 / 吸收 / 懒渲染 / 逐条签名整块包进 `if (!domFast) { … }`，收尾原样共用。

### Task 4: 探针（合成数据）

- [x] `/tmp/opencode/perf/tabbench.js`：真 `index.html` + 真 `app.js`，mock API 返回
      500 条合成消息（含 100 张大 shell 输出）+ 1 个小会话，A→B→A 切 6 轮，
      统计 `selectSession()` 与各阶段耗时。
- [x] 改前：冷开 188ms、热切 p50 **137ms**（`renderMessages()` ~129ms，
      `renderMessage()` 3000+ 次）。
- [x] 改后：热切 p50 **59ms**、热切期间 `renderMessage()` **0** 次。
- [x] 中间踩到的坑：节点接回放在 `revealActiveTab()` 之前 → 热切反而退化到 200ms
      （两次强制排版），移到之后恢复 59ms。

### Task 5: 测试

- [x] `test/ui-jump.html` 新增 12 项 §8.96 断言（缓存命中 / 节点身份 / 顺序 /
      缓存变过不复用 / 运行中不缓存 / 全局偏好换代）。
- [x] `test/smoke.sh` 新增 1 项静态锁。
- [x] 全量回归：`smoke` 395、`ui-jump` 164，其余套件数量不变，0 失败。

### Task 6: 文档

- [x] `docs/superpowers/specs/2026-10-15-mobile-design.md`：新增 §8.96 + §9 取舍表一行。
- [x] `README.md`：功能列表一条、`smoke.sh` / `ui-jump-run.js` 数量与说明。
- [x] 本计划文件。
