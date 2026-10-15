# OpenCode 跨工程会话管理器

一个本地 Web 面板,用于**跨所有工程**浏览、搜索、管理 OpenCode 会话,并可在页面内对任意会话
进行基础实时对话。

设计文档见 [`docs/superpowers/specs/2026-10-15-session-manager-design.md`](docs/superpowers/specs/2026-10-15-session-manager-design.md)。

## 原理

OpenCode V2 是客户端-服务器架构,后台服务持有**所有工程**的会话。浏览器无法跨域携带
`Authorization` 头,因此本项目用一个本地 Node 代理:

```
浏览器(同源 127.0.0.1:49450) ──► server.js(注入 Basic 鉴权、透传 SSE)──► OpenCode 服务(127.0.0.1:49374)
```

密码只在代理进程内读取,**不进入浏览器**。仅使用 Node 标准库,零依赖。

## 运行

```bash
node server.js
```

然后浏览器打开终端里打印的地址(默认 `http://127.0.0.1:49450`)。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OCS_PORT` | `49450` | 本地代理端口(被占用时自动改用随机端口) |
| `OCS_HOST` | `127.0.0.1` | 监听地址。设为 `0.0.0.0` 可开放局域网访问 |
| `OCS_AUTH` | (空) | 面板访问密码,格式 `用户名:密码`。设置后需 HTTP Basic 登录 |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | 用于读取 `service.json` 中的密码 |
| `OCS_UPLOAD_DIR` | `$TMPDIR/opencode-session-manager-uploads` | 附件的临时落盘目录(代理启动时建好,并定期清理 6 小时前的旧文件) |

## 局域网访问与面板密码

默认只监听 `127.0.0.1`(仅本机)。要让局域网其它机器访问:

```bash
OCS_HOST=0.0.0.0 OCS_AUTH='用户名:密码' node server.js
```

或用环境文件(推荐,配合 systemd):

```bash
mkdir -p ~/.config/opencode-session-manager
cat > ~/.config/opencode-session-manager/env <<'EOF'
OCS_HOST=0.0.0.0
OCS_AUTH=用户名:密码
EOF
chmod 600 ~/.config/opencode-session-manager/env
```

之后在局域网用 `http://<本机IP>:49450` 访问,浏览器会弹出登录框。

> ⚠️ **安全提示**:本面板在服务端替你注入了 OpenCode 的鉴权,任何能打开它的客户端
> 都能读取/删除你的会话、发送消息。因此开放局域网时**务必设置 `OCS_AUTH`**。
> OpenCode 服务本身仍只监听本机,不会因本面板而暴露。

## 功能

- **顶栏集中所有控件**:搜索 / 工程目录过滤 / 排序 / `+ 新建` / 导入 / 刷新 / 显示已归档 / 会话计数都在顶部栏,窄屏自动折行;左栏整栏已移除,会话表独占腾出的宽度
- **会话列表整列可收起**:分栏条顶部的小手柄一键收起,收起后对话区占满整宽;状态记在本地,刷新后保持
- **刷新后回到刚才的会话**:选中的会话写进 URL hash(`#ses_xxx`),刷新 / 复制链接 / 书签 / 换标签打开都会落到同一会话
- **浏览器前进 / 后退能在会话之间走**:点会话进历史栈(后退回上一个,前进回下一个);退到打开面板那一格则回到「未选择会话」的空态
- **刷新后回到会话里读到的位置**:滚动位置按「顶部可见的消息 + 偏移」记在 `sessionStorage`,刷新回到原处,而不是一律跳到最新
- **顶栏的搜索 / 工程目录 / 排序 / 显示已归档刷新后还在**;与 hash 分工明确:hash 管「选中哪个会话」,localStorage 管「列表怎么筛」
- **会话区字号可调**:会话界面(消息 / 工具卡片 / diff / 问询卡 / 输入区)整体由一个变量 `--chat-fs` 统管,区内字号全是相对 `em`,改一个数就整块等比缩放
- 跨工程列出会话,按更新时间排序,游标翻页
- 按标题搜索(服务端 `search`)
- 按工程目录过滤(服务端 `directory`)
- 管理动作:重命名、删除、移动到其它工程目录、分叉
- 点击会话打开对话:加载历史消息、发送消息、`/api/event` SSE 实时刷新
- **用户消息上的提及标记**:`agents[]` 显示成 `@名字`,`skills[]` 显示成 `#名字`(缺 `name` 用 `id` 兜底)
- **文件附件**:在输入框里 `@` 补全工程内文件直接引用;或用 📎 / 拖放 / 粘贴把文件带上去(见下文「文件附件」)
- **逐 token 流式**:回复边生成边显示(正文按 Markdown 实时重排、光标闪烁、思考块自动展开、工具调用实时出现),见下文「流式渲染」
- **工具卡片对齐 TUI**:`edit`/`patch` 直接显示彩色 diff(行号 + `+N -M`,默认展开),`write` 显示写入的正文,诊断行跟在 diff 下方,`question` 已答时列「问题 → 答案」,见下文「工具卡片」
- **会话控制**(输入框上方的工具栏):
  - **运行状态**:列表与标题栏显示 `● 运行中` / `◌ 重试中`,数据来自 `GET /api/session/active` 与 `session.status` / `session.idle` 事件
  - **中断**:运行中才出现 `■ 中断`,调用 `POST /api/session/:id/interrupt`
  - **投递方式**:运行中发送消息可选「排队」(当前回合结束后执行)或「插话」(立即并入当前回合),对应 `prompt` 的 `delivery: queue|steer`
  - **待发送队列**:展示已入队但尚未执行的消息,可「改为排队/改为插话」(`PATCH .../inbox/:id`)或「取消」(`DELETE .../inbox/:id`)
  - **切换 model / agent**:下拉选择智能体与模型(含变体档位),调用 `POST /api/session/:id/agent` 与 `.../model`
- 在页面内应答 OpenCode 的问询(底部固定卡片,不遮挡消息):
  - **表单**(`question` 工具等):单选 / 多选 / 自填、文本 / 数字 / 整数 / 布尔、外链授权,支持默认值预填与条件字段
  - **权限请求**(工具需批准):允许一次 / 总是允许 / 拒绝
  - 表单可「取消」并附原因;列表对有未决问询的会话显示 `⚑` 徽标
- **能力扩展**:
  - **网页内新建会话**:顶栏「+ 新建」,填工程目录(绝对路径)可选标题 / 智能体 / 模型(含变体),创建后自动打开
  - **归档**:列表与聊天头部可归档 / 取消归档,默认从列表隐藏,顶栏「显示已归档」可查看(记录在 `session.metadata`,见下文说明)
  - **导出 / 导入**:导出会话为 JSON(可选脱敏),或从 JSON 导入为新会话并指定目标工程目录
  - **深链跳回 TUI**:给出 `opencode --session <id> <目录>`,可直接粘到终端继续同一会话

## 列表折叠与刷新后的恢复

- **收起列表**:列表与对话区之间那条分栏条的顶部有个小手柄(`‹`),点它把整个会话表收起,再点(`›`)展开。
  - 手柄**就长在分栏条上**,所以「这条能收起」一眼可见;拖动分栏条改宽度、双击复位宽度都照旧(点手柄不会误触发拖动)。
  - 收起用的是 `main.list-hidden` 类;状态记在 `localStorage['ocs.listHidden']`,刷新后保持。
  - **刻意不动列宽变量 `--list-w`**,所以你拖出来的宽度在收起→展开后原样还在。
  - **收起时只隐藏列表,分栏条会保留成一条 16px 窄槽** —— 手柄是唯一的展开入口,要是跟着 `display:none` 消失,列表就再也拉不回来了。
  - 两条实现注意:①三个面板都写了显式 `grid-column`,布局不再依赖自动排布(否则隐藏一个子元素会把后面的往前顶);
    ②收起后的窄槽刻意保持 16px,所以手柄的位置在展开/收起两态**完全一致**。
- **刷新后回到刚才的会话**:选中的 id 写进 URL hash(`#ses_xxx`),刷新 / 复制链接 / 书签 / 另一个标签打开都会落到同一会话。
  - 点会话用 `history.pushState`,所以浏览器**前进 / 后退能在会话之间来回走**;刷新恢复与「清空选择」用 `replaceState`,不新增历史项。
  - 两种情形共用一句守卫——「`location.hash` 已经等于目标就直接返回」:浏览器后退/前进是**先**改好 hash **再**派发事件,进到 `selectSession` 时 hash 已等于目标,于是不会把同一格反复压进历史(重复点同一个会话也不会)。
  - 只监听 `popstate`(不监听 `hashchange`):面板自己的写入全走 `pushState`/`replaceState`,两者都不派发事件,不会自己触发自己。退到「打开面板那一格」(无 hash)时走 `clearSelection()`,回到空态。
  - 恢复时机是**首次会话列表加载完成之后**(这样会话标题/工程目录能取到,不会先闪一个 id);
    恢复**不要求该会话出现在列表里**(可能落在第二页),`selectSession` 只要 id 就能拉消息。
  - 会话已被删除 / hash 指向不存在的 id → 走已有的兜底,不炸也不白屏;删除会话时顺手清掉 hash。
  - 刻意不做:为每次点会话之外的操作 push 历史、`hashchange` 与 URL 手动编辑的同步。
- **刷新后回到会话里读到的位置**:滚动位置记在 `sessionStorage['ocs.scroll']`。
  - 存的是**锚点**(「顶部可见的是哪条消息 + 它距对话区顶部多少像素」),不是纯 `scrollTop` —— 加载更早的消息、或字号/宽度变了,绝对像素都会错位;锚点消息不在了(被删 / 掉出这一页)才退回像素值,并由浏览器自然夹取范围。
  - 用 `sessionStorage` 而不是 `localStorage`:这是「本标签页刚才读到哪」,不该跨标签串味,关掉标签就丢;最多留 20 个会话,超额淘汰最久没用过的。
  - **只有刷新恢复才还原**;从列表点进某个会话仍然跳到底部看最新消息。滚动时按时间戳节流记录,离开会话前与 `pagehide` 时各兜底存一次。
- **顶栏筛选 / 排序 / 搜索的持久化**:4 个键 `ocs.q.{search,dir,order,archived}`。
  - 启动时**先回填 store 与控件,再拉列表** —— 否则会先按默认值拉一次、再按恢复出来的条件重拉一次,白费一次请求还会闪一下(`init()` 里有顺序锁,冒烟测试会盯着)。
  - `store` 与存储跟着输入框立即更新,只对「取列表」防抖,存的值不会落后于界面。
  - 记住的目录这次没出现在结果里(该目录下暂时没有会话)也照样出现在下拉中,免得选不回去。

## 问询应答(表单 / 权限)

- 呈现:输入框上方固定卡片;同一会话多处问询按到达顺序堆叠。
- 触发两条路:① `/api/event` 的 `form.created` / `permission.asked` 实时到达;② 打开会话时兜底拉取 `GET /api/session/:sid/form` 与 `.../permission`。
- 提交:表单 `POST /api/session/:sid/form/:fid/reply` body `{answer}`(值类型 `string | number | boolean | string[]`);取消 `DELETE .../form/:fid?message=`;权限 `POST .../permission/:rid/reply` body `{decision:"once"|"always"|"reject"}`。成功均为 `204`。
- 与 TUI 对齐的细节:
  - 字段 `default` 预填;`boolean` 用勾选框;`string` 带 `options` 时 `custom:true` 用可自填输入 + `datalist`,`custom:false` 用下拉选择。
  - 条件字段 `when`(`{key,op:eq|neq,value}`,多条件为与)按实时答案显隐;未激活的字段**不参与提交**(服务端会以 `Form field is not active` 拒绝)。
  - `external` 字段必须确认(提交 `true`),否则服务端拒绝。
  - 提交前按 TUI 同样的规则本地校验(必填、`min/max`、`minLength/maxLength/pattern`、`email/uri/date` 格式、`minItems/maxItems`),失败在卡片内提示且不丢用户输入。
- 已知限制:徽标只反映「事件到达后」的其它会话;面板启动前就已存在的其它会话未决问询,需打开该会话才会显示。

## 会话控制

- **运行状态**:打开页面后每 8 秒兜底拉取 `GET /api/session/active`(返回 `{data:{<sid>:{type:"running"}}}`),同时实时消费事件:
  `session.status`(`status.type ∈ idle|retry|busy`)、`session.idle`、`session.execution.started|succeeded|failed|interrupted`。
- **中断**:`POST /api/session/:id/interrupt` → `{interrupted:boolean}`;空闲时返回 `interrupted:false`,会话不存在返回 `404`。
- **发送时的投递方式**:空闲时发消息不带 `delivery`(立即执行);运行中由工具栏在「排队」与「插话」间选择,写入 `prompt` 的 `delivery`。
  投递结果体现在返回值的 `data.delivery`;`queue` 的消息不会立刻出现在消息流里,而是进入待发送队列。
- **待发送队列**:`GET /api/session/:id/inbox` 返回 `Session.Inbox.Info[]`(类型 `user|synthetic|compaction|move`)。
  前端按 `type` 过滤掉 `synthetic`(服务端注入的内部提醒,例如切换到 Plan 智能体时的系统提示),只展示可操作项。
  - 改投递方式:`PATCH .../inbox/:id` body `{delivery:"steer"|"queue"}` → `204`;该项已投递/不存在 → `409`。
  - 取消:`DELETE .../inbox/:id` → `204`(幂等,取消不存在项也返回 `204`)。
- **切换 model / agent**:
  - `GET /api/agent?location[directory]=<dir>` → 前端只保留 `mode != "subagent"` 且未 `hidden` 的 agent。
  - `GET /api/model?location[directory]=<dir>` → 只保留 `enabled` 的模型,按 `providerID` 分组;`variants[]` 渲染为变体下拉。
  - `POST /api/session/:id/agent` body `{agent}` → `204`;`POST /api/session/:id/model` body `{model:{id,providerID,variant?}}` → `204`。
  - 服务端**不校验** agent/model 是否存在(未知值也返回 `204`),但缺少必填字段(如 `model.providerID`)返回 `400`。
  - 会话的当前值来自 `Session.Info` 的 `agent` / `model`(可能为 `null`,表示跟随默认;默认模型可查 `GET /api/model/default`)。

## 新建 / 归档 / 导入导出 / 深链

- **新建会话**:`POST /api/session` body `{location:{directory}, title?, agent?, model?}` → `200 {data: Session.Info}`
  (与 `PATCH`/`DELETE` 的 `204` 不同)。目录必须是绝对路径:服务端接受空体 `{}`,但那样会话会落在**服务端当前目录**,所以面板在本地拦截。
- **归档**:**OpenCode v2.0.28 没有会话归档接口**。`Session.Info.time.archived` 与库表列 `time_archived` 都存在,但只有 project 有写入路径;
  `PATCH /api/session/:id` 只接受 `{title?, metadata?, permissions?}`,`GET /api/session` 也没有 `archived` 过滤参数。
  因此本面板把归档记录在 `session.metadata.ocs.archived`(时间戳)里,由前端负责过滤 —— **OpenCode 自身不感知**,TUI 里仍会看到该会话。
  注意 `PATCH metadata` 是**整体替换**而非深合并,所以前端每次都是读-改-写整个 `metadata` 对象。
- **导出**:`GET /api/experimental/session/:id/export?sanitize=true|false` → `{data:{info, messages}}`;`sanitize=true` 会把标题 / 目录 / metadata 换成 `[redacted:...]`。
  面板下载为 `{data:{info,messages}}` 形状的 JSON(与本面板的导入、以及 `opencode session import` 都能对接)。
- **导入**:`POST /api/experimental/session/import` body `{info, messages, location?}` → `200 {data: Session.Info}`。三个坑:
  1. 载荷是**顶层** `{info, messages}` —— 导出响应外面那层 `data` 必须剥掉,否则 `400 Missing key at ["info"]`;
  2. `info.projectID` 必填(缺 → `400`),服务端会按目标 `location` 重算它;`info.id` 已存在 → **`409`**,所以面板总是换一个新 ID(冲突自动重试);
  3. 顶层 `location` 可把导入的会话改挂到另一个工程目录(用于换机器 / 换路径后的恢复)。
- **深链跳回 TUI**:OpenCode 没有自定义 URL scheme,官方入口是 CLI 的 `opencode --session <id> <directory>`
  (help 原文:「Session ID to continue, or to create if it does not exist」)。面板给出这条命令并提供「复制」;
  局域网是 http(非 secure context),`navigator.clipboard` 多半不可用,此时回落到选中文本 + `document.execCommand('copy')`。

## 流式渲染(逐 token)

**为什么必须在前端自己拼**:OpenCode 在流式过程中**不会**把半成品文本写进消息接口 ——
`GET /api/session/:id/message` 里助手消息的 parts 会随 step 逐个出现,但 `text` 一直是空串,
直到整段结束才一次性写入(实测:90 秒的等待里 `text` 长度始终为 0,结束时从 0 跳到 904)。所以只靠「事件触发重取消息」是看不到逐字效果的。

面板订阅 `/api/event` 并**直接消费 part 增量事件**,维护一份本地缓冲,再与服务端权威版本对账。

### 消费的事件

| 事件 | 载荷 | 用途 |
| --- | --- | --- |
| `session.step.started` | `{assistantMessageID, agent, model, started}` | 建立本地缓冲,立刻显示助手气泡 |
| `session.reasoning.started` / `.delta` / `.ended` | `{assistantMessageID, ordinal, delta?, text?}` | 思考块流式 |
| `session.text.started` / `.delta` / `.ended` | 同上 | 正文流式 |
| `session.tool.input.started` / `.delta` / `.ended` | `{assistantMessageID, id, name, delta?, text?}` | 工具参数流式 |
| `session.tool.called` / `.progress` / `.success` / `.failed` | `{assistantMessageID, id, input?, content?, metadata?}` | 工具状态与输出 |
| `session.step.ended` | `{assistantMessageID, finish, cost, tokens}` | 用量落定 |
| `session.usage.updated` | `{sessionID, cost, tokens}` | 用量刷新 |

### 三条容易踩的语义

1. **一个 step 就是一条助手消息**。`assistantMessageID` 每 step 都不同,所以不会跨 step 撞序号。
2. **`ordinal` 是「同一类型里的第几个」,不是 `content` 下标**。一条消息里 `reasoning` 与 `text` 的 `ordinal` 都从 0 开始
   (实测 content 为 `[reasoning, text]` 时两者都是 0),因此前端按 `类型:序号` 建键,而不是直接索引 `content`。
3. **`*.ended` 带权威全文**,实测与增量累加**完全一致**(457/457、706/706、36/36)。所以覆盖是幂等的:
   正常路径靠增量渲染,`ended` 兜住任何丢包。

### 对账规则(本地缓冲 vs 服务端)

- 只要服务端消息**还没有** `time.completed`,就用本地缓冲渲染该条消息(服务端此时只有空骨架,覆盖不会倒退)。
- 一旦服务端消息带上 `time.completed`,立刻丢掉本地缓冲、回到服务端版本(它是权威),并按需要重新拉取一次。
- 回合收束(`session.execution.*`)把缓冲标记为关闭 —— 但**仍然显示**,直到服务端给出权威版本,避免文字闪没。

### 增量重绘(不整条重建)

- 消息签名分两种:非流式用 `JSON.stringify(消息)`,流式用**结构指纹**(part 类型 / 序号 / 工具状态 / **工具 metadata 指纹** / 有无 tokens),
  **刻意不含文本长度** —— 所以每次 delta 都不会触发整条消息重建。
- 纯文本变化走 `paintLiveText()`:只把受影响的那个 block 节点重新渲染 Markdown,其它消息、同一条消息的其它块、
  标题行都不动(DOM 节点 identity 保持不变,已展开的 `<details>` 状态也不会丢)。
- 纯文本增量事件(`session.text.delta` / `session.reasoning.delta`)**不再触发消息重取**,省掉每秒数次的无谓请求;
  其余事件仍保留 150ms 防抖对账。
- `session.tool.progress` 会陆续送来工具的 `metadata`(例如 `edit` 的 diff),这时状态与 parts 都没变。
  因此 `handleEvent` 除了看「结构变化」,还会比对**已渲染的指纹**(`msgEls` 上的 `fp`):指纹变了就补一次整条重绘。
  metadata 没变的 progress 依旧不重绘、不重取(保持 C 组既有的「progress 不是结构变化」契约)。
- 光标 `▌` 总是落在**最后一个文本/思考块**内部的行内末尾(直接拼在 Markdown 结果后面会掉到块级元素之外、单独占一行)。
- 流式期间思考块自动展开(`▾ 思考`),回合结束后回落到折叠态(`▸ 思考`)—— 与服务端版本一致。

## 工具卡片(diff / 代码 / 诊断)

服务端在工具状态的 `metadata` 里**已经算好了改动内容**,面板只负责排版 —— 不需要额外接口,也不需要后端参与:

| 工具 | `state.metadata` 里的关键字段 | 面板怎么画 |
| --- | --- | --- |
| `edit` / `patch` | `files: [{file, status, additions, deletions, patch}]`(`patch` 是标准 unified diff) | 摘要 `← 编辑 <路径>`(多文件写 `← N 个文件`)+ `+N -M`;正文每文件一块「状态徽标 + 路径 + 统计」+ 带**双向行号**的 diff,**默认展开** |
| `write` | `filepath` / `exists`(正文在 `input.content`,服务端不给 diff) | 摘要 `# 写入 <路径>`;正文按行号渲染,**默认展开** |
| 任意 | `diagnostics: {<文件绝对路径>: [{range:{start:{line,character}}, message}]}` | diff 下方逐条 `错误 [行:列] 消息` |
| `question` | `answers`(已答时) | 列「问题 → 答案」;未答只写 `→ 提问中…` |
| `skill` | `name` | `→ Skill "名字"` |

- 摘要行的取值与 TUI 一致:按 `command|id|pattern|url|query|path|description|code` 的优先级取主键,其余标量作为补充并压平空白(`→ git log --oneline -5`)。
- 工具名后面的标记沿用 TUI 约定:`→` 只读/查询、`←` 修改已有文件、`#` 新建(`# 写入`、`← 编辑`、`← 补丁`)。
- 其它工具(如 `bash` / `read` / `glob`)保持原来的折叠卡片(摘要行 + 点开展开入参/输出),观感不变。
- 工具卡片的正文整体限高内滚(`.toolbody`),diff 不折行、横向滚动,长改动不会把消息流撑爆。
- 暂不支持(明确不做):并排 / split 视图、语法高亮、字符级行内高亮、会话级「变更」面板与 revert。
- 一个前提假设:`metadata.diagnostics` 的形状是从服务端 TUI 的用法反推的,本机实测一直是空对象 `{}`;
  面板按「精确路径优先、相对/绝对宽松兜底」取值,取不到就不显示(假设不成立也不会报错)。

## 文件附件

两条路都归结成「一个 `file:` URI」——这是服务端的硬要求,实测**裸绝对路径与相对路径都会被拒**
(`400 Invalid attachment URI`),`https://` 则是 `Unsupported attachment URI`;
而且文件内容不是浏览器上传的,**是服务端自己按 URI 去读的**(读回消息时才补上 `data`(base64)与 `mime`)。

- **A)`@` 引用工程内的文件**(和 TUI 同一个入口):在输入框里敲 `@`,下拉列表来自 `GET /api/fs/find`
  (`?query=&type=file&limit=12&location[directory]=<会话的工程目录>`),返回的是**相对工程目录**的路径。
  选中后正文里插入 `@相对路径`,并把「相对路径 → 绝对路径」记进 `mentionHits`(绝对路径用响应里的
  `location.directory` 拼,而不是猜)。
  - 发送时只把**补全里确认过**的 `@路径` 变成 `files[]` + `mention{start,end,text}`。这条限制是有意的:
    发给服务端一个不存在的文件会让整条 prompt 直接 `400` 失败,而只靠正文文本无法确认文件真的存在。
    代价是手打一个没走过补全的 `@路径` 不会变成附件(与 TUI 里「`@` 是补全入口」一致)。
  - 解析用「拿确认过的路径去正文里找」而不是「按空格切 token」:中文正文里 `@Makefile,再改` 这种
    后面紧跟标点、又没有空格的情形也要认出来(路径后允许跟标点/空白,不允许跟字)。
  - 输入框上方会即时出现一枚 `@ 引用` 的 chip,删掉正文里的那个 `@` 就取消 —— 发之前所见即所得。
- **B)选择 / 拖放 / 粘贴的文件**:浏览器手里没有服务端路径,于是**借用 OpenCode 自带的**
  `POST /api/experimental/fs/write?path=<绝对路径>`(原始字节写盘),把返回的绝对路径当 `uri`。
  - 好处是**代理层零改动**:这个端点走已有的 `/api/*` 透传,写盘由 OpenCode 自己完成,代理不新增任何上传路由。
  - 落盘目录由 `/__health` 的 `uploadDir` 告知(默认 `$TMPDIR/opencode-session-manager-uploads`,
    可用 `OCS_UPLOAD_DIR` 覆盖);代理负责建目录(0700)并**最多每小时清一次 6 小时前的旧文件**。
    落盘只是「让服务端能读到」的临时中转,消息里已存了 base64,所以文件被清掉也不影响历史回看。
  - 单个文件上限 32MB;超限直接拒,不浪费一次上传。
  - 拖放只接在输入区上(拦了 `dragover`),否则浏览器会直接把文件当页面打开。
- **消息流里怎么显示**:用户消息正文下方逐条列出 `📎 名字 mime · 大小 来源路径`;
  `image/*` 且带 `data` 的直接内联成缩略图(`data:` URL),不需要额外请求。
  - 大小是按 base64 长度反算的(服务端不回 `size`);`source.type === 'uri'` 时才显示来源路径,
    `inline` 的没路径可显示就省略。
  - 这些都在 `renderMessage` 的用户分支里,和 `agents[]`/`skills[]` 一样是**条件追加**:
    没有附件就不产生空的附件行(所以「没有提及/附件时用户消息仍是 3 个子节点」这条老断言照旧成立)。

## 尚未实现(v2+ 剩余项)

无。

工具卡片上明确不做的:并排 / split 视图、语法高亮(`config.diffs.view` / `filetype` / `syntaxStyle`)、
字符级行内高亮(`diffHighlightAdded` / `Removed`)、会话级「变更」面板与 revert。

布局/状态上明确不做的:会话内滚动位置对不同入口一视同仁(只有刷新恢复才还原,点会话仍跳到底部)、
为每次操作 push 历史、`hashchange` 与 URL 手动编辑的同步。

## 测试

前置:OpenCode 服务已运行,且本代理已启动。凭据从 `~/.config/opencode-session-manager/env` 读取(可用 `OCS_AUTH` 覆盖)。

```bash
bash test/smoke.sh            # 代理层:健康检查/静态托管/鉴权注入/SSE/密码不外泄/顶栏结构/工具卡片样式/问询·控制·能力扩展端点与控件
bash test/e2e-asks.sh         # 问询端到端(纯 curl):创建表单→应答/取消→状态核对→负例
bash test/e2e-controls.sh     # 会话控制端到端(纯 curl):agent/model 切换、中断、inbox 改投递/取消
OCS_E2E_LLM=1 bash test/e2e-controls.sh   # 追加真实运行中的 queue/steer/interrupt 用例(会消耗一次很小的模型调用)
bash test/e2e-capabilities.sh # 能力扩展端到端(纯 curl):新建→归档→导出→导入(含 409/400 负例)→清理
bash test/e2e-stream.sh       # 流式端到端(纯 curl):事件流形状;默认只跑不消耗模型的部分
OCS_E2E_LLM=1 OCS_E2E_MODEL=company/deepseek-v4-flash bash test/e2e-stream.sh   # 追加真实逐 token 流式断言
bash test/e2e-attach.sh       # 文件附件端到端(纯 curl):上传写盘 → @ 补全数据源 → 附件落库形状 → 非法 uri 负例
node test/ui-asks-run.js      # 问询前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-controls-run.js  # 会话控制前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-capabilities-run.js  # 能力扩展前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-stream-run.js    # 流式前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-tools-run.js     # 工具卡片 diff/代码/诊断的前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-layout-run.js    # 列表折叠 + 刷新后的恢复(会话 / 滚动位置 / 顶栏条件)(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-attach-run.js    # 文件附件与 @ 补全的前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
```

- `smoke.sh`:74 项。含顶栏/分栏条改造的结构断言(8 个控件都在 `#topbar` 切片内、`#btnList` 在 `#resizer-mid` 切片内而不在顶栏、首页不再有 `#filters`/`<aside>`/`#resizer-left` 且只剩 1 个分栏条、`styles.css` 主区为 `var(--list-w, 560px) var(--rz-w, 16px) minmax(0, 1fr)` 且不再写死高度)、
  工具卡片的 3 项样式断言(有 diff 配色变量、`.dl.add/.dl.del`、`.dfile/.diff`),以及列表折叠/恢复的 4 项(收起时为分栏条留 16px 窄槽、**收起时不隐藏分栏条**、app.js 里的 `ocs.listHidden` 与 hash 持久化),再加 H 组的 7 项(会话区字号旋钮 `--chat-fs` 与区内相对 `em`、agent/skill 提及的样式与渲染、`pushState`+`popstate` 前后退同步、滚动位置锚点 `ocs.scroll`/`sessionStorage`、顶栏条件持久化与 `setupFilters`、用户消息提及渲染),
   H 组 6 的 8 项(附件与 `@` 补全的前端逻辑、上传必须走 `/api/experimental/fs/write` 而不是自建端点、`#mentions`/`.achip`/`.att-img`/`.att-src` 样式、输入区的附件按钮/文件框/待发送行/补全下拉、`/__health` 给出 `uploadDir`、代理会建目录并定期清理、附件 uri 必须加 `file://` 前缀),
   外加**两条顺序锁**:用 `awk` 取 `init()` 函数体,断言 `setupFilters()` 排在 `loadSessions` 之前(否则启动会按默认值白拉一次)、`setupAttachments()` 排在 `paintDelivery()` 之前(先接线再画输入区)。
  - 脚本里比较文本用的是自带的 `has()`(`case` 字面量匹配),**刻意不用 `printf | grep -q`**:在 `set -o pipefail` 下 `grep -q` 命中即退出会让 `printf` 收到 SIGPIPE,整条管道随机判失败(实测 300 次里失败 1 次),冒烟会间歇性假红。
- `e2e-asks.sh`:13 项。会创建一个临时会话并在结束时删除;验证 `list` 不含 `state`、未激活字段/未确认 `external` 被拒 `400`、正常应答 `204` 且答案一致、重复应答 `409`、取消 `204`。
- `e2e-controls.sh`:22 项(开 `OCS_E2E_LLM=1` 为 31 项)。同样只用临时会话;验证 agent/model 切换持久化、`model` 缺字段 `400`、空闲中断 `interrupted=false`、inbox 负例,以及(可选)真实运行中的 `queue` 投递、改投递、取消、中断。
- `e2e-capabilities.sh`:26 项。只用临时会话与 `/tmp` 临时目录,结束时全部删除;验证新建的字段落库、`PATCH metadata` 的整体替换语义、导出脱敏与否、导入的换 ID 与 `location` 重挂、以及 `409`/`400` 负例。
- `e2e-stream.sh`:4 项(开 `OCS_E2E_LLM=1` 为 27 项)。默认部分只验证事件流形状(单行 `data:`、无 `event:` 行、首帧 `server.connected`、每帧合法 JSON);开了 LLM 后追加真实流式断言:出现 `step.started`、增量 `>= 5` 个且**累加严格等于** `ended.text`、事件顺序 `started→delta→ended`、`step.ended` 带 finish 与 output tokens、`execution.succeeded`,以及**流式期间服务端不提供半成品文本**(这正是前端必须自己消费增量的原因)。默认模型未必配好,可用 `OCS_E2E_MODEL=provider/modelID` 指定。
- `ui-asks-run.js`:39 项浏览器内断言(真实 `public/app.js`),覆盖字段渲染、默认值预填、`when` 显隐、单选+自填互斥、答案组装、本地校验分支、非 http(s) 链接不可点击。
- `ui-controls-run.js`:83 项浏览器内断言,覆盖 agent/model 选择器的过滤与分组、切换请求体、变体显隐、中断/投递控件的显隐、运行状态文案与列表标记、待发送队列渲染与操作请求、发送时的 `delivery` 选择、事件到运行状态的映射。
- `ui-capabilities-run.js`:71 项浏览器内断言,覆盖归档判定与列表过滤、归档请求体的读-改-写、新建/导入的本地校验与请求体形状、`409` 重试、导出 URL 与下载内容、`tuiCommand` 的引号转义。
- `ui-stream-run.js`:102 项浏览器内断言,覆盖增量累加、`ordinal` 按类型计、`*.ended` 权威覆盖、结构指纹不含文本长度(所以 delta 不触发整条重建)、节点 identity 保持(局部重绘)、多文本块序号映射、光标位置与思考块展开箭头、服务端半成品不覆盖本地文本、权威版本到达后回收缓冲且不重复渲染、非当前会话的缓冲不进入视图、陈旧缓冲回收,以及防抖对账的分流规则(有缓冲的 delta 不排重取、无缓冲的 delta 退回重取)。其中 6 项是工具卡片的回归锁:`tool.progress` 带来 `metadata.files` 时状态没变也要把 diff 重绘上屏,metadata 没变则不重建 DOM。
- `ui-tools-run.js`:94 项浏览器内断言,覆盖 `parsePatch`(双向行号 / 空上下文行 / 文件头与分隔行 / 末尾换行)、`diffHtml`(状态徽标与统计、多文件分块、无 patch 的删除文件)、`codeHtml`(行号)、`diagHtml`(精确与宽松路径命中、0 基转 1 基)、`inputSummary`(取值优先级与压平)、`toolHtml` 对 `edit`/`write`/`patch`/`question`/`skill`/通用工具的分派与「默认展开」,以及 `userRefsHtml`(agent `@` / skill `#` 标记、缺 `name` 用 `id` 兜底、都缺则跳过、名字转义、在 `renderMessage` 里的顺序与「没有提及时不产生空行」)。
- `ui-layout-run.js`:114 项浏览器内断言,覆盖列表折叠(箭头 `‹`/`›` 与 `aria-label` 翻转、`ocs.listHidden` 写入/清空、重复接线不重复挂监听、**收起后分栏条仍可见且手柄点得到**、**收起态点手柄能重新展开**、**点手柄不会误触发拖宽度而点条上空白仍能拖**、收起后让出的正好是 16px 窄槽、收起再展开后自定义列宽 `--list-w` 不被吃掉)、
  hash 持久化(`hashToID` 的边界、选中会话写 hash、删除后清 hash、`restoreFromHash` 恢复消息与标题、不抢已有选择、指向不存在的会话不炸、hash 为空/非法时不选)、
  **前进 / 后退**(点会话入栈、重复点同一个不多压一格、收到 `popstate` 切到 URL 里的会话且不重复入栈、后退到无 hash 时取消选中并清空对话区、空操作不入栈)、
  **会话内滚动位置**(跳到底部 / 存锚点 / 刷新后回到原处且确实不在底部 / 只还原一次 / 点会话进来仍跳底部 / 锚点消息不存在时退回像素值 / 无存档照旧 / 上限 20 与淘汰顺序 / 存的是 `sessionStorage`)、
  **顶栏条件持久化**(空存档的默认值、四项恢复、记住的目录不在结果里也能选回、四类控件改动即时落盘、清空搜库存空串、存的是 `localStorage`)。

- `e2e-attach.sh`:32 项。只用临时会话与临时文件,结束时全部删除;验证①代理建好暂存目录并把 `uploadDir` 通过 `/__health` 告知前端、②`POST /api/experimental/fs/write?path=<绝对路径>` 原始字节写盘且内容逐字节一致、③`GET /api/fs/find` 给出相对工程目录的路径与基准目录、④提示词里的附件只认 `file:` URI(服务端自己补 `data`/`mime`,`name`/`mention` 原样落库)、⑤裸绝对路径/相对路径/`https` 三种非法 uri 都被 `400` 拒且原因可辨、⑥面板服务出去的 `app.js`/`styles.css`/`index.html` 确实带上了附件功能。
- `ui-attach-run.js`:132 项浏览器内断言,覆盖路径与大小的纯函数(`fileURI`/`baseName`/`joinDir`/`humanSize`/`uploadName`/`uploadPathFor`/`b64Size`)、`userFilesHtml`(uri 来源显示路径、inline 不显示、图片内联缩略图、按 base64 反算大小、缺 `name`/`mime` 兜底、转义、在 `renderMessage` 里的位置与「没有附件就不产生空行」)、`resolveMentions`(只认补全确认过的路径、锚点 `start/end/text` 切出来正好是那一段、多引用、中文里紧跟标点、邮箱里的 `@` 不算)、`@` 补全(光标前 token 的提取边界、请求参数含 `location[directory]` 的 deepObject 写法、目录名与文件名分列、上下键环绕、Enter 消费按键并插入+记忆绝对路径、Esc 关闭、点选、无匹配的空态)、附件排队(上传走 `fs/write`、POST、目标绝对路径、body 就是文件本身、chip 的名字/大小/来源路径/移除按钮、超限拒绝、上传失败回滚、拖放/粘贴/文件框三条入口)、以及 `send()` 的请求体(上传文件与 `@` 引用合并进 `files[]`、`mention` 锚点、成功才清空待发送列表、失败保留可重发、切会话清空并关掉补全、没选中会话时按钮禁用、暂存目录未知时先问 `/__health`)。

## 开机自启(systemd 用户服务)

仓库内 `systemd/opencode-session-manager.service` 是可移植模板(`%h` 会展开为家目录)。

```bash
mkdir -p ~/.config/systemd/user
cp systemd/opencode-session-manager.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencode-session-manager.service
systemctl --user status opencode-session-manager.service
```

未登录也开机自启(需要 `sudo`):

```bash
sudo loginctl enable-linger "$USER"
```

管理:

```bash
systemctl --user restart opencode-session-manager.service
systemctl --user stop opencode-session-manager.service
journalctl --user -u opencode-session-manager.service -f
```

> 模板中的 node 路径指向 nvm 当前版本(`~/.nvm/versions/node/v24.18.0/bin/node`)。
> 升级 Node 后需同步修改该路径。服务未启动时不影响使用——`server.js` 会惰性发现
> OpenCode 服务(`/__health` 会显示未连接并自动重试)。

## 实现备注(实测确认)

- 鉴权:`Authorization: Basic base64("opencode:" + password)`,用户名任意。
- `PATCH /api/session/{id}`(改名)、`POST /api/session/{id}/move`(移动)、`DELETE /api/session/{id}`(删除)成功时返回 **204 且响应体为空**。
- `POST /api/session`(新建)必须带 JSON body(可用 `{}`),否则报 `Expected object`。
- 消息 `GET /api/session/{id}/message` 支持 `order`(`asc|desc`)+ `cursor` 翻页(`cursor.next` 指向更早一页)。
- assistant 消息的 `content[]` part 类型为 `text` / `reasoning` / `tool`;tool part 的状态在 `state.status`(`streaming|running|completed|error`),输入在 `state.input`,输出在 `state.content`。
- SSE 事件行形如 `data: {"id":"evt_...","type":"...","data":{...}}`,并夹带 `: heartbeat` 心跳行。
- 表单列表 `GET /api/session/{id}/form` 返回 `Form.Info`(**不含 `state`**);要判断 pending 需 `GET .../form/{fid}`(返回 `Form.Detail`,含 `state.status`)。故前端不能用 `state` 过滤列表项。
- 表单应答/取消、权限应答成功均返回 **204 空体**;对已处理或不存在的对象返回 **404**;答案非法返回 **400**(如提交 `when` 未激活字段、`external` 不为 `true`、缺必填)。
- `GET /api/session/active` 返回 `{"data":{"ses_...":{"type":"running"}}}`(只表示该进程正在执行的会话,不含 `retry`)。
- `POST /api/session/{id}/agent`、`POST /api/session/{id}/model` 都是 **204 空体**,且**不校验** agent/model 是否真实存在;唯一的结构校验是 `model` 必带 `providerID`(**400**)。
- 发送消息时若不显式给 `delivery`,服务端会补成 `steer`;只有会话正在运行时 `queue` 才会真正滞留在 inbox 里(`turn` 结束后自动投递)。空闲会话即使传 `queue` 也会立即执行。
- 切换到 Plan 智能体会往 inbox 注入一条 `type:"synthetic"` 的系统提醒;是否仍留在队列取决于时机,因此前端一律按 `type` 过滤。
- `PATCH /api/session/{id}/inbox/{iid}` 对不存在的条目返回 **409**(而非 `404`);`DELETE` 则幂等返回 **204**。前端据此提示并重新拉取队列。
- **流式期间消息接口不给半成品文本**:`GET /api/session/{id}/message` 里助手消息的 parts 会随着 step 出现,但 `text` 一直是空串,整段结束才一次性写入(实测等待期间长度为 0 → 结束时 904)。因此逐字显示只能靠消费 `session.text.delta` / `session.reasoning.delta`。
- `session.text.ended` / `session.reasoning.ended` 的 `text` 与增量累加**逐字节一致**(457/457、706/706、36/36),所以「以 `ended.text` 覆盖」是幂等的兜底,不会与增量冲突。
- `ordinal` 是**同一类型内的序号**,不是 `content` 下标:content 为 `[reasoning, text]` 时两者的 `ordinal` 都是 0。前端按 `类型:序号` 建键。
- **一个 step 对应一条助手消息**:多 step 回合(如先调工具再总结)里 `assistantMessageID` 每 step 都不同,所以不会跨 step 撞序号。
- 工具事件的载荷:`tool.input.started` 带 `{id, name}`(**没有** `ordinal`),`tool.input.ended` 带完整 JSON 参数字符串,`tool.called` 带已解析的 `input`,`tool.success` 带 `content` / `metadata`。
- **顶部栏改造的坑**:`main` 原先写死 `height: calc(100vh - 43px)`(43px = 单行顶栏高度)。顶栏改可换行后它必然变高,若不同时改成
  `body` 纵向 flex + `main { flex:1; min-height:0 }`,顶栏一折行底部输入框就会被顶出视口。冒烟里专门断言 `calc(100vh - 43px)` 已消失。
- 顶栏折行的临界宽度约 **1160px**:1500px 单行;1100px 会折成两行(第二行只有右侧的连接状态),此时 `main` 正确让出高度。
- 分栏宽度存在 `localStorage`:`ocs.listW`(会话表宽度,默认 560px,双击 `#resizer-mid` 复位)。旧键 `ocs.midW` 仍会被读取一次以兼容,并在下次拖动时清掉。
- **工具的改动内容服务端已经算好**,面板 `toolHtml()` 以前没读 `state.metadata` 才把 diff 丢了:
  `edit` / `patch` 的 `metadata.files[] = {file, status: added|modified|deleted, additions, deletions, patch}`,`patch` 是标准 unified diff
  (带 `Index:` 行与 `=====` 分隔行,hunk 之外有 `---`/`+++` 文件头,空上下文行是「一个空格」,末尾有换行)——解析时这四类都要照顾到。
  `write` 只在 `state.input.content` 里有正文,`metadata` 里没有 diff。
- `session.tool.progress` 会分多次把 `metadata` 补全(例如 `edit` 先只有参数、随后才有 `files`)。由于它同时被约定的「progress 不是结构变化」,前端靠
  `handleEvent` 里对「已渲染指纹」的比对来补重绘,否则 diff 要等到下一次状态变化才出现。
- `metadata.diagnostics` 的形状是按服务端 TUI 的用法反推的(`{<文件绝对路径>: [{range:{start:{line,character}}, message}]}`),
  本机实测一直是空对象 `{}`;面板做了精确/相对宽松两种路径匹配,取不到就不显示。
- **折叠入口必须活过折叠本身**:手柄长在分栏条上,而分栏条只有 16px 宽,所以收起时**不能**把它 `display:none` ——
  否则唯一的「展开」入口跟着消失,列表再也拉不回来。收起时只隐藏 `#listpane`,分栏条留成窄槽,手柄两态位置完全一致。
- **显式写 `grid-column`,别指望自动排布**:网格里藏掉一个子元素后,剩下的元素会自动往前顶
  (早期版本就把 `#chatpane` 顶到宽度 0 的第一列上,整个右侧变白)。给 `#listpane/.resizer/#chatpane` 钉死 1/2/3 列后,
  隐藏谁都不影响别人。冒烟与 `ui-layout` 各有一条回归锁盯着这件事。
- 选中会话用 URL hash 承载(`#ses_xxx` + `history.replaceState`),因为它是唯一「刷新、复制链接、书签、换标签打开」都成立的载体;
  `localStorage` 存不了可分享的链接。恢复放在首次 `loadSessions()` 之后而不是之前:会话标题/工程目录要能取到,且 `loadSessions` 内部自己吞异常(不会 reject),`.then` 一定会跑到。
- **提示词的附件只认 `file:` URI**:`files[].uri` 传裸绝对路径或相对路径会当场 `400 Invalid attachment URI`,传 `https://` 是 `400 Unsupported attachment URI`;`file:///abs`、`file://abs`、`file:/abs` 三种写法都能过。**内容不是上传的**:服务端自己按 URI 读文件,落库时才补 `data`(base64)与 `mime`,所以面板在上传后不需要回读内容。`mention` 会原样落库(`{start,end,text}`),`name` 也保留。
- **`GET /api/fs/find` 的 `location` 必须写成 deepObject 的 `location[directory]=<绝对目录>`**;传 JSON 字符串(如 `location={...}`)会报 `Expected object | undefined at ["location"]`。返回的 `data[].path` 是**相对该目录**的路径,响应里带的 `location.directory` 才是唯一可靠的基准 —— 面板拿它拼绝对路径,不去猜。
- **`POST /api/experimental/fs/write?path=<urlencoded 绝对路径>`**:body 就是原始字节,`content-type: application/octet-stream`;返回 `{"location":{...},"data":{"path":"<绝对路径>"}}`。有两个坑:①**绝对路径要 URL 编码**(浏览器用 `URLSearchParams` 正好把 `/` 编成 `%2F`);②用 curl 手测时**不要**把 `--get` 和 `-X POST --data-binary` 混在一起(会退化成 GET)。由于这个端点走的是已有的 `/api/*` 透传,代理层不必新增任何上传路由 —— 代理只建目录、告知路径、定期清理。
- **上传的文件只是「中转」**:消息里已存了 base64,所以暂存目录里的文件被清理或 `/tmp` 被重启清空,都不影响历史消息的回看。
