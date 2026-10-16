# OpenCode 跨工程会话管理器 — 设计文档

- 日期:2026-10-15
- 状态:待评审
- 形态:本地 Web 面板(单页应用)
- 目标运行时:Node.js(v24 已在本机,仅用标准库)

## 1. 背景与目标

### 问题
在使用 OpenCode 的过程中,不同工程目录下会积累大量会话。会话归属于某个工程目录
(`location.directory`),但用户经常**忘记某个会话是在哪个工程下创建的**,也没有一个
统一的入口去查看和管理这些跨工程的会话。

### 目标(本次交付)
做一个**本地 Web 面板**,能够:
1. **跨所有工程**列出、搜索、按工程目录过滤、排序会话;
2. 做基本管理:重命名、删除、移动到其它工程目录、分叉;
3. 点击会话后**在页面内进行基础实时对话**:加载历史消息、发送消息、流式看到助手回复与工具执行进度。

### 非目标(v1 明确不做,留作 v2)
- ~~网页内应答权限请求(permission)与交互式表单(form)~~ → 已作为 v2 的 A 组实现(见 §7);
- ~~中断 / steer / 切换 model·agent~~ → 已作为 v2 的 B 组实现(见 §7);
- 文件附件、网页内新建会话、归档、导入导出;
- 深链跳回 TUI。

## 2. 关键事实(已实测,是设计的地基)

| 事实 | 证据 |
|---|---|
| OpenCode V2 是客户端-服务器架构,共享后台服务持有**所有工程**的会话 | `GET /api/session` 一次返回了 `example-repo`、`example-manifest`、`example-listener` 等不同 `location.directory` 的会话 |
| 会话存于 SQLite(`~/.local/share/opencode/opencode.db`,已 1GB) | 官方文档**明令禁止**外部读写该库 → 必须走 HTTP API |
| API base URL 由 `opencode service status` 给出 | 实测输出 `http://127.0.0.1:49374` |
| 鉴权 = **HTTP Basic**(密码作 secret,用户名任意) | `curl -u opencode:<pw>` → 200;无鉴权 → 401;`Authorization: Bearer` → 401 |
| 服务端 CORS 会 echo `Origin`,但**不允许浏览器跨域携带 `Authorization` 头** | 预检 `access-control-allow-headers` 为空 → 纯前端直连 API 不可行 |
| 密码在 `~/.config/opencode/service.json` 的 `password` 字段;socket 端口**不在**其中 | 读文件 + `service status` 解析端口 |

### 用到的 API 端点
- `GET /api/session` — 列表。参数:`limit`、`order`(`asc|desc`)、`search`、`parentID`、`directory`、`project`、`subpath`、`cursor`。返回 `{data:[Session.Info], cursor:{previous,next}}`。
- `GET /api/session/{id}` — 单条。
- `PATCH /api/session/{id}` — 改名/元数据。body `{title?, metadata?, permissions?}`。
- `DELETE /api/session/{id}` — 删除。
- `POST /api/session/{id}/move` — 移动。body `{directory: AbsolutePath, delivery?}`。
- `POST /api/session/{id}/fork` — 分叉。body `{before?: MessageID}`。
- `GET /api/session/{id}/message` — 消息历史。参数 `limit`、`order`、`cursor`、`type`。
- `POST /api/session/{id}/prompt` — 发消息。body `{text, files?, agents?, skills?, ...}`。
- `GET /api/event` — **SSE 实时事件流**(`text/event-stream`)。

### 数据结构(实测)
- `Session.Info`:`id`、`title`、`projectID`、`location.directory`、`subpath`、`time{created,updated,idle,viewed,archived}`、`cost`、`tokens`、`outcome`、`agent`、`model`。
- 消息条目 `{id, time, type, ...}`;`type ∈ idle|assistant|user|synthetic|system|skill|shell|compaction|agent-switched|model-switched|location-switched`。
  - `user` 消息文本在 `text` 字段。
  - `assistant` 消息的 `content[]` 由 part 组成,part `type ∈ text|reasoning|tool`;tool part 有 `name`、`state`(Streaming/Running/Completed/Error)。
- 事件流每行形如 `data: {"id":"evt_...","type":"...","data":{...}}`,并夹带 `: heartbeat` 心跳行。

## 3. 架构

### 组件
1. **`server.js`(本地代理,Node 标准库,零依赖)**
   - **发现**:启动时执行 `opencode service status` 解析 base URL;从
     `$OPENCODE_CONFIG_DIR/service.json`(默认 `~/.config/opencode/service.json`)读 `password`。
   - **静态托管**:托管 `public/` 下的前端资源。
   - **反向代理 `/api/*`**:转发到 OpenCode 服务,注入
     `Authorization: Basic base64("opencode:" + password)`;透传 method / query / body / 状态码 / 响应头。
   - **SSE 透传**:对 `text/event-stream` 响应,用 `fetch` 的流式 body 直接 pipe 回浏览器,
     禁用缓冲,保证心跳与事件即时到达。
   - **`GET /__health`**:返回发现到的 base URL 与连通性,供前端展示当前连接的服务。
2. **前端(`public/index.html` + `app.js` + `styles.css`)** — 单页应用,**顶部栏 + 两栏**(会话表 / 对话),无框架、无构建。

### 为什么需要本地代理(而不是纯前端)
浏览器无法跨域携带 `Authorization` 头(预检不允许),且把密码放进浏览器既不安全也不可靠。
本地代理让浏览器只与**同源**的 `127.0.0.1:PORT` 通信,由代理侧加 Basic 鉴权,
**密码永不进入浏览器**。

### 数据流
```
浏览器(同源 127.0.0.1:49450)
      │  fetch /api/*  +  SSE
      ▼
server.js  ──注入 Basic──►  OpenCode 服务(127.0.0.1:49374)
      ▲                         │
      └──────── 流式透传 ◄──────┘
```

- 会话列表:`GET /api/session?order=desc&limit=50`,游标翻页。
- 打开历史:`GET /api/session/{id}/message?order=asc&limit=...`,游标向前翻。
- 发消息:`POST /api/session/{id}/prompt {text}`,随后由事件流驱动刷新。
- **实时策略(v1)**:订阅 `GET /api/event`;收到事件后,**防抖(~150ms)重新拉取当前会话的消息与该会话元数据**并重渲染。
  该策略与具体事件 schema **解耦**,稳健可靠;不以逐 token 精细合并为目标(升级路径见 §7)。

### UI 结构
- **顶部栏(`#topbar`,可换行 flex)**:品牌 + 全部控件(搜索 → `search`、工程目录过滤 → `directory`(下拉项来自会话 `location.directory` 去重)、排序(updated/created)、
  `+ 新建` / `导入` / `刷新`、`显示已归档`、会话计数),右侧贴边显示连接状态。
  窄屏(约 <1160px)时自动折到第二行,**不遮挡**下方内容;`body` 为纵向 flex,`main` 用 `flex:1; min-height:0`
  吃掉剩余高度(不再写死 `calc(100vh - 43px)`,否则顶栏一换行底部输入框就会被顶出视口)。
- **会话表(`#listpane`,可拖拽 `--list-w`,默认 560px)**:列 = 标题 / 工程目录(截断显示 + `title` 悬浮全路径) / 更新时间(相对) / tokens / cost / 行内操作(改名、删除、移动、分叉、打开)。点击行=打开。
- **对话(`#chatpane`,占满剩余)**:消息列表(终端风:等宽、无气泡、角色色条+标记;user/assistant/tool 渲染)、底部输入框+发送、顶部显示标题/状态(运行中·空闲)并自动滚动到底部。> 2026-10-16 追加:输入框**下面**多一条提示栏 `#promptFooter`(照 TUI 的 `prompt.footer`):工程路径 + 上下文用量(`155.6K (78%)`)+ `ctrl+p commands` 提示。上下文用量原先在标题行右侧,见 `2026-10-15-mobile-design.md` §8.15 起、§8.19 挪到提示栏。
- **左栏已整栏移除**:原 `#filters` 左栏与 `#resizer-left` 分栏条删除,控件迁入顶部栏,会话表接管腾出的宽度;
  唯一保留的分栏条是 `#resizer-mid`(分隔会话表与对话,双击复位)。

### 安全
- 默认仅监听 `127.0.0.1`。
- 密码只存在于 Node 进程内;不写入 cookie / localStorage / 响应体。
- 代理**只**转发 `/api/*` 与静态资源,不接受任意 URL 目标(防 SSRF)。

### 错误处理
| 场景 | 处理 |
|---|---|
| OpenCode 服务未运行 / `service status` 失败 | 顶部红条提示 + 「重试」按钮 |
| 401(服务重启换了密码) | 代理重读 `service.json` 后重试一次;仍失败则提示 |
| SSE 断开 | 前端指数退避自动重连,顶部显示「重连中」 |
| 删除 / 移动 | 前端二次确认;失败时展示后端错误消息 |

## 4. 项目位置与运行

- **位置**:`~/tools/opencode-session-manager/`(独立工程,**不放入 `example-repo` 内核仓库**)。
- **运行**:`node server.js` → 打印 `http://127.0.0.1:49450`,浏览器打开即可。
- **配置(env)**:`OPENCODE_CONFIG_DIR`(默认 `~/.config/opencode`)、`OCS_PORT`(默认 `49450`,占用则用随机端口并打印)。

## 5. 目录结构
```
opencode-session-manager/
├── server.js                 # 代理 + 静态托管 + 服务发现
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── test/
│   └── smoke.sh              # 需要运行中的 OpenCode 服务
├── docs/superpowers/specs/2026-10-15-session-manager-design.md
└── README.md
```

## 6. 里程碑
- **M1** 代理骨架 + `__health` + 会话列表(浏览 / 搜索 / 过滤 / 排序)。
- **M2** 管理动作:改名 / 删除 / 移动 / 分叉。
- **M3** 对话:历史加载 + 发消息 + 事件流实时刷新。
- **M4** 错误处理 + 冒烟测试 + README。

## 7. 升级路径(v2+)

- **A 交互应答(已实现)** — 权限请求 + 交互式表单应答。
  - 事件:`form.created`(`data.form`,含 `sessionID/id/title/metadata/fields`)、`form.replied`/`form.cancelled`(`data.id`);`permission.asked`(`data` 即 `Permission.Request`:`id/sessionID/action/resources/save?/metadata?/source?/message?`)、`permission.replied`(`data.requestID`)。
  - 表单:`GET /api/session/:sid/form`(列表,返回 `Form.Info`,**不含 state**)、`GET .../form/:fid`(返回 `Form.Detail`,含 `state`)、`POST .../form/:fid/reply` `{answer}`、`DELETE .../form/:fid?message=`。
  - 权限:`GET /api/session/:sid/permission`、`GET .../permission/:rid`、`POST .../permission/:rid/reply` `{decision:"once"|"always"|"reject"}`。
  - 字段类型:`string`(format: email/uri/date/date-time,可带 options/custom)、`number`、`integer`、`boolean`、`multiselect`(options/minItems/maxItems/custom)、`external`(url)。通用:required/default/when。
  - 语义要点(与服务端 `fI/uc/ac` 对齐):`when` 未满足的字段提交会被拒;`external` 必须为 `true`;答案值类型为 `string|number|boolean|string[]`。
- **B 会话控制(已实现)** — 运行状态、中断、steer/queue、切换 model·agent。
  - 运行状态:`GET /api/session/active` → `{data:{<sid>:{type:"running"}}}`;事件 `session.status`(`status.type ∈ idle|retry|busy`)、`session.idle`(`{sessionID}`)、`session.execution.started|succeeded|failed|interrupted`(`{sessionID,...}`,interrupted 另带 `reason ∈ user|shutdown|superseded|inactivity`)。前端以事件为主、8 秒轮询兜底。
  - 中断:`POST /api/session/:sid/interrupt?resume=` → `{interrupted:boolean}`;空闲会话返回 `false`,会话不存在 `404`。
  - 投递方式:`prompt` body 的 `delivery ∈ steer|queue`;响应 `{data: Session.Inbox.User}` 里回带 `delivery`。空闲时不带该字段即立即执行。
    > 2026-10-16 追加(对齐 TUI,见 `2026-10-15-mobile-design.md` §8.18):TUI 里**光按 `Enter`** 是 `prompt.submit`(→ `delivery:"steer"`),
    > 排队要额外按 `<leader>return`(`prompt.queue`),所以面板运行中的默认投递从「排队」改成「插话」(`DEFAULT_DELIVERY = 'steer'`,工具栏照旧可切);
    > 中断后把队列里的 `user` 项改成 `steer` 放行那段照旧保留。
  - 待发送队列:`GET /api/session/:sid/inbox` → `{data: Session.Inbox.Info[]}`,`Info = User|Synthetic|Compaction|Move`(均有 `id/sessionID/time/type/delivery/payload`)。
    `PATCH .../inbox/:iid` `{delivery}` → `204`(不可改时 `409`);`DELETE .../inbox/:iid` → `204`(幂等)。切换 agent 会注入 `synthetic` 系统提醒,前端按 `type` 过滤不展示。
  - 切换:`GET /api/agent?location[directory]=`(Agent.Info:`id/name/mode ∈ subagent|primary|all/hidden/model`)、`GET /api/model?location[directory]=`(Model.Info:`providerID/modelID/name/enabled/variants[]`)、`GET /api/model/default`。
    `POST /api/session/:sid/agent` `{agent}` → `204`;`POST /api/session/:sid/model` `{model:{id,providerID,variant?}}` → `204`。
    服务端不校验 agent/model 是否存在(未知值也 `204`),但 `model` 缺 `providerID` → `400`。会话当前值在 `Session.Info.agent` / `.model`(可为 `null` = 跟随默认)。
- **D 能力扩展(已实现)** — 网页内新建会话、归档、导入导出、深链跳回 TUI。
  - 新建会话:`POST /api/session` body `{id?,parentID?,title?,agent?,model?,location?,metadata?,permissions?}` → **200** `{data: Session.Info}`
    (注意与 `PATCH`/`DELETE`/`reply` 的 `204` 空体不同)。`location` 为 `{directory}`;带 `title`/`agent`/`model` 均能直接落库(`model` 需 `{id,providerID,variant?}`)。
    非法 `location` → `400`;**空体 `{}` 也会成功**(落在服务端当前目录),故前端强制要求绝对路径目录。
  - 归档:**OpenCode v2.0.28 没有会话归档接口**。`Session.Info.time.archived` 与库表列 `time_archived` 都存在,但只有 **project** 有写入路径(`project.list` 会过滤 `time.archived`);
    `PATCH /api/session/:id` 只接受 `{title?,metadata?,permissions?}`,`GET /api/session` 也没有 `archived` 过滤参数。
    因此「归档」落在 `session.metadata.ocs.archived`(metadata 为自由形状对象,列表接口会一并返回;未设置时该键整体省略,不是 `null`),由面板负责过滤,
    OpenCode 自身不感知。**`PATCH metadata` 是整体替换而非深合并**,前端必须读-改-写整个对象(否则会抹掉其它命名空间)。
  - 导出:`GET /api/experimental/session/:id/export?sanitize=true|false` → `200 {data:{info: Session.Info, messages: Session.Message.Info[]}}`;
    `sanitize=true` 把标题 / 目录 / metadata 替换为 `[redacted:...]`。会话不存在 → `404`;ID 不符合 `^ses` → `400`。前端下载 `{data:{...}}` 形状的 JSON 文件。
  - 导入:`POST /api/experimental/session/import` body `{info, messages, location?}` → `200 {data: Session.Info}`。四个实测要点:
    (a) 载荷是**顶层** `{info, messages}` —— 把导出响应 `{data:{...}}` 原样提交会 `400 Missing key at ["info"]`,前端必须解包;
    (b) `info.projectID` 必填(缺 → `400`),服务端会按目标 `location` 重算它;
    (c) `info.id` 已存在 → **`409`**,故前端必须换新 ID(仅约束 `^ses`)并在冲突时重试;
    (d) 顶层 `location` 可把导入的会话改挂到另一个工程目录。
  - 深链跳回 TUI:OpenCode 没有自定义 URL scheme,落地形式是 CLI 命令 `opencode --session <id> <directory>`
    (help:「Session ID to continue, or to create if it does not exist」)。面板给出可直接粘贴的命令并尝试复制;
    局域网 http 访问不是 secure context,`navigator.clipboard` 通常不可用,故回落到选中文本 + `document.execCommand('copy')`。
- **C 渲染升级(已实现)** — 消费 part 增量做逐 token 流式与增量合并。

  **为什么必须在前端自己拼**:实测 `GET /api/session/:id/message` 在流式过程中**不返回半成品文本** ——
  助手消息的 parts 会随 step 逐个出现,但 `text` 一直为空串,直到整段结束才一次性写入
  (一次 90 秒的等待里 `text` 长度始终为 0,`time.completed` 出现时从 0 跳到 904)。
  所以「事件触发重取消息」最多只能做到整段落地时刷新一次,逐字效果只能靠消费增量事件。

  - 事件契约(实测 v2.0.28):
    | 事件 | 载荷 |
    | --- | --- |
    | `session.step.started` | `{sessionID, agent, model, assistantMessageID, started}` |
    | `session.reasoning.started/.delta/.ended` | `{sessionID, assistantMessageID, ordinal, delta?/text?}` |
    | `session.text.started/.delta/.ended` | 同上 |
    | `session.tool.input.started/.delta/.ended` | `{sessionID, assistantMessageID, id, name, delta?/text?}`(**无 ordinal**) |
    | `session.tool.called` | `{sessionID, assistantMessageID, id, input, executed}` |
    | `session.tool.progress` | `{sessionID, assistantMessageID, id, metadata}` |
    | `session.tool.success` | `{sessionID, assistantMessageID, id, content, metadata}` |
    | `session.tool.failed` | `{sessionID, assistantMessageID, id, error?}` |
    | `session.step.ended` | `{sessionID, assistantMessageID, finish, cost, tokens}` |
    | `session.usage.updated` | `{sessionID, cost, tokens}`(**无 location**) |
  - 三条关键语义:
    (a) **一个 step 就是一条助手消息** —— 多 step 回合(先调工具再总结)里 `assistantMessageID` 每 step 都不同,因此不会跨 step 撞序号;
    (b) **`ordinal` 是「同一类型内的序号」而非 `content` 下标** —— content 为 `[reasoning, text]` 时两者的 `ordinal` 都是 0,
        所以前端按 `类型:序号` 建键(直接索引 `content` 会错位);
    (c) **`*.ended` 的 `text` 与增量累加逐字节一致**(457/457、706/706、36/36),因此「以 `ended.text` 覆盖」是幂等的兜底,
        正常路径靠增量渲染,`ended` 兜住丢包。
  - 本地缓冲与对账:每个 `assistantMessageID` 一份缓冲(`kind:'block'` 的文本/思考块 + `kind:'tool'` 的工具块,按事件到达顺序)。
    只要服务端消息**还没有** `time.completed` 就用缓冲渲染该条(服务端此时只有空骨架,覆盖不会倒退);
    一旦带上 `time.completed` 就丢弃缓冲、回到服务端权威版本。回合收束(`session.execution.*`)只把缓冲标记为关闭,
    **仍然显示**直到服务端给出权威版本,避免文字闪没。「已关闭且非当前会话且服务端也没有」的缓冲会被回收,避免无限增长。
  - 增量合并(不整条重建):消息签名分两种 —— 非流式用 `JSON.stringify(消息)`,流式用**结构指纹**
    (part 类型/序号/工具状态/有无 tokens/finish/开关状态),**刻意不含文本长度**;
    于是纯文本 delta 不改变签名,由 `paintLiveText()` 只重刷受影响的那个 block 节点(其它消息、同条消息的其它块、标题行都不动,
    DOM 节点 identity 与已展开的 `<details>` 状态都保持)。
  - 事件分流:`session.text.delta` / `session.reasoning.delta` **不再触发消息重取**(本地已渲染,省掉每秒数次无谓请求);
    `*.ended` 也不重取(但要立刻局部重绘);其余事件保持 150ms 防抖对账。结构变化(新 part / 工具状态)立即整条重绘。
    > 2026-10-16 修正:防抖对账那次 `loadMessages()` 可能压在一次切换上,`await` 回来时当前会话已经变了 ——
    > 它原来直接写进只有一份的 `store.messages`,于是新会话会显示上一个会话的消息。现在 `await` 之后按 `id` 复查
    > `store.selected`,变了就整份丢弃(见 `2026-10-15-mobile-design.md` §8.15)。
  - 视觉:光标 `▌` 落在**最后一个文本/思考块内部的行内末尾**(直接拼在 Markdown 结果后会掉到块级元素之外、单独占一行);
    流式期间思考块自动展开(`▾ 思考`),回合结束后回落折叠态(`▸ 思考`),与服务端版本一致;
    标题行加「输出中」徽标,用量行加「流式中」。
- **E 顶部栏布局(已实现)** — 左栏整栏移除,控件上顶栏。
  - `index.html`:原 `#filters` 内的控件(搜索/工程目录/排序/新建·导入·刷新/显示已归档/计数)原样成为 `#topbar` 的直接子元素,
    `<aside id="filters">` 与 `#resizer-left` 删除;**所有控件 id 保持不变**(其它模块与测试均按 id 取用,业务逻辑零改动)。
  - `styles.css`:顶栏改 `flex-wrap: wrap`(窄屏折行)、`main` 网格由五列降为三列 `var(--list-w,560px) 6px minmax(0,1fr)`;
    `body` 改纵向 flex + `main { flex:1; min-height:0 }`,替换原先写死的 `height: calc(100vh - 43px)`(否则顶栏折行会把底部输入框顶出视口);
    删除 `#filters` 全套规则与 `#left-w`/`#mid-w` 变量。
  - `app.js`:**只改** `setupResizers()` —— 去掉左分栏条一半,`--mid-w` 更名 `--list-w`(localStorage 键 `ocs.midW` → `ocs.listW`,
    读取时兼容旧键并顺手清掉),双击复位的边界钳制随之简化。其余逻辑**一字未改**。
- **F 工具卡片对齐 TUI(已实现)** — 把服务端已经算好的改动内容画出来。

  **地基(实测)**:`edit` / `patch` 的 `state.metadata.files` 已经给出完整 unified diff 与统计,
  **不需要新接口、不需要后端改动**,面板此前丢数据的唯一原因是 `toolHtml()` 没读 `metadata`:

  ```jsonc
  // session.tool.progress / session.tool.success 的 metadata(edit、patch)
  { "files": [ { "file": "default.xml", "status": "added|modified|deleted",
                 "additions": 10, "deletions": 10,
                 "patch": "Index: default.xml\n===…\n--- default.xml\n+++ default.xml\n@@ -1,18 +1,18 @@\n…" } ],
    "truncated": false }
  // write:正文在 state.input.content,服务端不给 diff;metadata 只有 {filepath, exists, diagnostics}
  // 诊断:metadata.diagnostics 按「文件绝对路径」索引 → [{range:{start:{line,character}}, message}]
  ```

  - 新增纯函数层(便于离线断言):`parsePatch(patch)` 把 unified diff 拆成带**双向行号**的行
    (`hunk` / `add` / `del` / `ctx` / `meta`;丢弃 `Index:`、`===` 分隔行,hunk 之外的 `---`/`+++` 当文件头丢弃,
    末尾因 `split` 多出的空串不算一行,而真正的空上下文行是「一个空格」不能被丢);
    `diffHtml(files)` 每文件一块「状态徽标 + 路径 + `+N -M`」+ 统一视图正文;`codeHtml(text)` 给 `write` 按行号渲染;
    `diagHtml(metadata, path)` 按路径(精确优先、相对/绝对宽松兜底)挑出本文件的诊断,输出 `错误 [行:列] 消息`;
    `inputSummary(input)` 对齐服务端 TUI 的取值优先级 `command|id|pattern|url|query|path|description|code`,其余标量作补充并压平空白。
  - `toolHtml(p)` 分派改写:
    `edit` → `← 编辑 <路径>` + diff + 诊断,**默认展开**;**服务端还没给出 `files` 时只写 `← 编辑 <路径>`**(不再退化成通用摘要把 `oldString/newString` 铺出来);
    `write` → `# 写入 <路径>` + 正文按行号渲染 + 诊断,**默认展开**;
    `patch` → 单文件写 `← 补丁 <路径>`、多文件写 `← N 个文件`,逐文件一块,**默认展开**;
    `question` → 已答时列「问题 → 答案」,未答写 `→ 提问中…`;`skill` → `→ Skill "名字"`;
    其它工具保持「摘要行 + 点开展开入参/输出」的折叠卡片(不改变既有观感)。
  - **修掉一个真实缺陷**:`liveSig()` 的工具项原先只记 `id:状态`,不含 metadata,
    于是 `session.tool.progress` 送来 diff 时签名不变、**不重绘**(diff 要拖到下一次状态变化才出现)。
    现在把 metadata 指纹(文件数 + 各文件 `status/additions/deletions/patch` 长度)并入签名;
    同时 `handleEvent` 除了「结构变化」之外,还会比对**已渲染的指纹**(`msgEls` 上的 `fp`),
    指纹变了就补一次整条重绘 —— 既修好了 progress 带 diff 的场景,又不改变 `handleEvent` 里
    「progress 不是结构变化」的既有契约(不带可渲染 metadata 的 progress 依旧不重绘、不重取)。
  - `styles.css`:新增 `--diff-{add,del}-bg/-ln/-fg`、`--diff-{ctx,ln,hunk}-*`、`--diff-rule` 变量与
    `.toolbody`(整体限高内滚)/`.dfile`(文件头)/`.dbadge`/`.diff`(不折行、横向滚动)/`.dl`+`.ln`+`.sign`+`.src`/`.ddiag`/`.qalist`/`.tdesc`(摘要)/`.tadd`/`.tdel` 规则。
  - **本轮明确不做**:并排 / split 视图、语法高亮(`config.diffs.view`/`filetype`/`syntaxStyle`)、
    字符级行内高亮(`diffHighlightAdded/Removed`)、会话级「变更」面板与 revert、后端改动。
- **G 布局与状态保持(已实现)** — 列表整列可收起 + 刷新后回到刚才的会话。

  - **会话列表整列收起**
    - 入口是分栏条顶部的小手柄 `#btnList`(长在 `#resizer-mid` 里),箭头 `‹` ⇄ `›`,`aria-expanded` / `aria-label` 同步。
    - **为什么要挪到分栏条上**:原先把入口放在顶栏,虽然避开了「收起后入口消失」的问题,但**看不出这条能收起**。
      放到分栏条上「这条可以收」一眼可见 —— 但随之而来一条硬约束:**收起后必须让分栏条活下来**,
      否则唯一的展开入口跟着消失,列表就再也拉不回来(V1 方案就是这么取舍的)。
    - 分栏条 6px → 16px(给出 15×44 手柄的落点),`.resizer` 仍是拖拽区,手柄自己 `cursor:pointer`;
      `startDrag()` / 双击复位的回调都先判 `e.target.closest('.handle')` 直接 return,免得点手柄顺手把宽度也改了。
    - 收起只隐藏 `#listpane`,分栏条保留成 16px 窄槽(底色 `--panel`、手柄转 accent 色)。
      **刻意让窄槽宽度在两种状态下都是 16px**,这样手柄位置完全不动,不会「跳」。
    - **关键坑(两次)**:①隐藏子元素会让网格自动排布把后面的元素往前顶(早期版本把 `#chatpane` 顶到宽度 0 的第一列上,
      整个右侧一片空白);②真正的原因是**没有显式列位**。所以现在给 `#listpane/.resizer/#chatpane` 钉死 `grid-column: 1/2/3`,
      布局不再依赖 auto-placement,隐藏谁都无所谓 —— 这比「跟着降模板列数」更稳。冒烟 + `ui-layout` 各有回归锁。
    - **刻意不动 `--list-w`**:用户拖出来的列宽在收起 → 展开后原样还在(双击 `#resizer-mid` 复位宽度仍然有效)。
    - 状态记在 `localStorage['ocs.listHidden']`(与列宽 `ocs.listW` 并列);`setupListToggle()` 重复调用只按存储重画、
      不重复挂监听(否则点一下触发两次,看起来没反应)。
      **后来改了**(见 `2026-10-15-mobile-design.md` §8.13):折叠**不再跨刷新记忆** —— 打开网页时列表一律
      `paint(false)`,`ocs.listHidden` 既不读也不写(用户要求「第一次打开网页时应该展开对话列表」);列宽 `ocs.listW` 照旧记。
  - **刷新后回到刚才的会话**
    - 选中的 id 写进 URL hash(`#ses_xxx`,用 `history.replaceState` 而非 `pushState` —— 点会话不该把后退键灌满)。
      选 hash 而不是 localStorage:它是唯一「刷新 / 复制链接 / 书签 / 换标签打开」都成立的载体。
    - 写:`selectSession(id)` 里 `persistSelected(id)`;两处把 `store.selected` 置 `null` 的分支(删除会话、`session.deleted` 事件)
      顺手 `persistSelected(null)`,否则刷新会去恢复一个已删除的会话。
    - 读:`init()` 里 `loadSessions({ reset: true }).then(restoreFromHash)`。放在列表加载**之后**是因为会话标题/工程目录要能取到
      (否则会先闪一个 id);`loadSessions` 内部自己吞异常、不会 reject,所以 `.then` 一定跑得到。
    - `restoreFromHash()` 只在 `store.selected` 仍为空时出手(不抢用户已做出的选择),且**不要求该会话出现在列表里**
      (可能落在第二页)—— `selectSession` 只要 id 就能拉消息,标题取不到时有回落。
      hash 指向已删除/不存在的会话 → 走已有兜底,不炸不白屏;hash 为空或不是 `ses` 开头 → 什么都不做。
  - **G 组当时明确不做**(其中三条在 H 组被推翻或补上,见下):顶栏筛选/排序/搜索的持久化、
    `hashchange` 的前后退同步、折叠动画、会话内滚动位置的恢复(刷新后停在最新消息,与「打开会话」一致)。
- **H 观感 / 持久化 / 提及 / 附件(已实现)** — 一次成组的补完,六小项各自独立提交(第 ⑥ 项为追加)。

  - **H1 会话区字号旋钮**
    - 现状:消息区 `12.5px/1.6` 是整块 UI 里最小的字。
    - 做法:`:root` 加 `--chat-fs` / `--chat-lh`,`#chatpane` 用它当基准;会话区内 **47 处写死的 `font-size: Npx` 全改成相对 `em`**(换算 = 原值 ÷ 12.5)。
    - 目的:改一个数就**整块等比缩放**(12.5 → 14px 即 ×1.12),而不是「正文大了、代码块和 diff 还是小的」。
      行内 `code` / `pre code` / `.diff` / `.dfile` / `.dbadge` / 角色名 / 用量行 / 工具状态 / 问询卡 / 输入区全部跟着走。
    - `.dl .ln` 的 `width` 本来就是 `em`,会随 `.diff` 的字号一起变宽,行号列不会挤。
    - 换算比例统一取「÷12.5」(即旧的消息区基准),所以问询卡/输入区那些原本基于 13px 的文字会一起变成 ×1.12 ——
      视觉差异可忽略,换来的是「一条规则管到底」。
  - **H2 浏览器前进 / 后退能在会话之间走**
    - G 组当时刻意用 `replaceState` 避开「后退键被灌满」,后果是历史里只有一条,`hashchange` **永远不会触发** —— 这一项无从生效。
      确认接受「后退键记住点过的会话」之后,点会话改 `pushState`(刷新恢复与清空选择仍 `replaceState`)。
    - 一个守卫收口两态:**「`location.hash` 已经等于目标就直接返回」**。浏览器后退/前进是**先**改好 hash **再**派发事件,
      所以进到 `selectSession` 时 hash 已等于目标 → 不重复入栈;重复点同一个会话也不多压一格。
      (第一版把「目标 hash」与「完整 URL」相比,永远不相等,新加的断言立刻抓出来了。)
    - 只监听 `popstate`,**不听 `hashchange`**:面板自己的写入全走 `pushState`/`replaceState`(都不派发事件),
      而测试与外部脚本会直接改 `location.hash` —— 听 `hashchange` 会让程序化改 hash 触发自己,既有用例会当场变红。
    - 新增 `clearSelection()`:删除会话、`session.deleted` 事件、后退到无 hash 三处共用(原先两条路径各写一份,且事件路径不清消息区)。
    - 代价说明:后退键会一条条记下点过的会话,退到底才离开面板 —— 这是让前后退「真的能用」的必要代价,已在选型时与使用者确认。
  - **H3 刷新后回到会话里读到的位置**
    - 只存**锚点**(顶部可见消息 id + 它距对话区顶部的像素),不存纯 `scrollTop`:加载更早的消息、或 H1 改了字号,绝对像素都会错位。
    - 存 `sessionStorage['ocs.scroll']`(本标签页刚才读到哪,关标签即丢、不跨标签串味),最多 20 条,超额淘汰最久没用过的。
    - **只在刷新恢复时还原**;从列表点进会话仍跳底部看最新消息。通道是 `store.restoreScroll`(`restoreFromHash` 塞,`renderMessages` 消费一次);
      有它就不许跳底部,且 `msgs` 为空时不消费(免得被提前触发的渲染吃掉)。
    - > 2026-10-16 追加(性能,见 `2026-10-15-mobile-design.md` §8.16):「在不在底部」加了 `store.nearBottom`
      > 缓存,唯一写点是 `updateJumpLatest()`;`renderMessages()` 把已算出的布尔喂给它(省掉刚改完 DOM 后那次读),
      > 增量重绘(`paintLiveDelta` / 压缩正文的 `paintCompactBody`)只读缓存。原因:改完 `#messages` 再读一次
      > `scrollHeight` 会把整篇强制重排(实测 100 条消息 / 7838 节点:干净 0.95ms,脏 23~34ms),而旧代码
      > **每个 token delta** 都这么读一次。
    - `scrollAnchor()` 用 `getBoundingClientRect` 而不是 `offsetTop`,不依赖 `offsetParent`;锚点消息不在了(被删/掉出这一页)才退回像素值。
      > 2026-10-16 追加(性能,见 `2026-10-15-mobile-design.md` §8.17):长会话(条数 ≥ `CV_MIN_MSGS = 30`)给 `#messages` 挂 `.cvmany`,
      > 离屏 `.msg` 走 `content-visibility: auto` 整块跳过渲染,那次强制排版从 24~36ms 掉到 0ms。
      > 因为「量出锚点相对滚动口上沿的差再滚掉它」滚完锚点正好落在 `off` 处、随后重排的是锚点**下方**刚露头那一屏,
      > 估值高度不影响锚点在屏上的位置(实测冷现场偏 1px),所以 `applyScrollAnchor()` **不用**改;
      > 短会话不挂 `.cvmany`,行为与从前完全一致。
    - 记录时机:滚动时按**时间戳**节流 200ms、离开会话前、`pagehide` 各兜一次。
      **刻意不用定时器** —— UI 测试页把 `setTimeout` 打桩了(返回 0、永不触发),用定时器会让这部分在测试里根本跑不起来。
  - **H4 顶栏筛选 / 排序 / 搜索持久化**
    - 4 个键 `ocs.q.{search,dir,order,archived}`;与 G 组分工:**hash 管「选中哪个会话」,localStorage 管「列表怎么筛」**。
    - 接线抽成 `setupFilters()`,在 `init()` 里**排在 `loadSessions` 之前**:先回填 store 与控件再拉列表,
      否则会先按默认值拉一次、再按恢复条件重拉一次(白费一次请求还闪一下)。冒烟里加了一条 `awk` 顺序锁盯着这个顺序。
    - `store` 与存储跟着输入框**立即**更新,只对「取列表」防抖 —— 存的值不会落后于界面。
    - `renderDirOptions()` 补一条:记住的目录这次没出现在结果里(该目录下暂时没会话)也照样插进下拉,免得选不回去。
  - **H5 用户消息上的 `agents[]` / `skills[]` 提及**
    - `Session.Message.User` 上本来就有这两个数组(`Prompt.AgentAttachment` / `Prompt.SkillAttachment`),面板此前完全没渲染。
      `agents[]` → `@name`(accent)、`skills[]` → `#name`(琥珀)。
    - `userRefsHtml(m)` 是纯函数:缺 `name` 用 `id` 兜底,两者都缺则跳过,名字走 `esc`(与正文同一套)。
    - 位置:角色行 / 正文 / 提及行;沿用终端风(不加气泡,只用色条 + 标记)。样式 `.refs`/`.ref`/`.ref-agent`/`.ref-skill`
      写在会话区内,字号用相对 `em` 跟着 `--chat-fs` 缩放。
  - **H6 文件附件(选择 / 拖放 / 粘贴 + `@` 引用)**
    - **先实测服务端契约,再决定实现** —— 这一步直接决定了整块做法:
      - `PromptInput.FileAttachment` 只有 `uri`,**内容由服务端自己读**;`uri` 必须是 `file:` URI:
        裸绝对路径/相对路径 → `400 Invalid attachment URI`,`https://` → `400 Unsupported attachment URI`;
        `file:///abs`、`file://abs`、`file:/abs` 都能过(内部归一化成 `file:///abs`)。
      - 落库为 `Prompt.FileAttachment = {data(base64), mime, source:{type:'uri',uri}, name?, description?, mention?}`,
        `data`/`mime` 是服务端读文件时补的,`name` 与 `mention` 原样保留。
      - 于是「上传」不必自己写:**OpenCode 自带 `POST /api/experimental/fs/write?path=<绝对路径>`**
        (原始字节写盘,返回落盘的绝对路径),它走已有的 `/api/*` 透传 ⇒ **代理零改动**,不新增任何上传端点。
    - **A)`@` 引用**:补全数据源是 `GET /api/fs/find`(与 TUI 同源),参数必须写成 deepObject 的
      `location[directory]=<会话工程目录>`(传 JSON 字符串会报 `Expected object | undefined at ["location"]`);
      返回的是**相对该目录**的路径,所以绝对路径用**响应里的 `location.directory`** 拼 —— 不去猜、也不从会话对象另取一份。
      - 选中后正文插入 `@相对路径` 并把「相对路径 → 绝对路径」记进 `mentionHits`;发送时把仍在正文里的引用变成 `files[] + mention{start,end,text}`。
      - **只认补全确认过的路径**:生成附件前无法确认任意路径是否真的存在,而一个不存在的文件会让整条 prompt `400` 失败,
        所以宁可「手打不生效」也不冒整条消息失败的风险(与 TUI 里 `@` 同为补全入口的语义一致)。
      - 匹配方式是**拿确认过的路径去正文里找**(长路径优先),不是按空格切 token:中文正文里
        `@Makefile,再改` 这种紧跟标点、又没有空格的情形也得认出来(路径后允许跟标点/空白,不允许跟字)。
      - 输入框上方即时出现 `@ 引用` chip;删掉正文里的那个 `@` 即取消 —— 发之前所见即所得。
    - **B)选择 / 拖放 / 粘贴**:文件先经 `fs/write` 落到暂存目录,再把返回的绝对路径当 `uri`。
      - 暂存目录由 `/__health` 的 `uploadDir` 告知(默认 `$TMPDIR/opencode-session-manager-uploads`,可用 `OCS_UPLOAD_DIR` 覆盖);
        代理启动时建好(0700),并**最多每小时清理一次 6 小时前的旧文件**(顺手做,失败只记日志、绝不影响附件功能)。
      - 拖放只挂在输入区上并 `preventDefault` 掉 `dragover`(否则浏览器会直接把文件当页面打开);粘贴取 `clipboardData.files`(普通文本照旧能粘)。
      - 单文件上限 32MB(超限直接拒,不浪费一次上传);上传失败把该条从待发送列表里回滚并提示。
      - **只有发送成功才清空待发送列表**:失败时留着便于原样重发(清空输入框是原有行为,没动)。
      - 暂存目录未知时(刚打开页面就拖文件)先问一次 `/__health` 再传,不靠 `init()` 的时序。
    - **消息流里怎么显示**:用户消息的正文/提及之后追加附件行(`📎 名字 mime · 大小 来源路径`),
      `image/*` 且带 `data` 的直接内联成缩略图(`data:` URL,不需要额外请求)。
      - 大小按 base64 长度反算(服务端不回 `size`);只有 `source.type === 'uri'` 才显示来源路径,`inline` 的没路径可显示。
      - 条件追加 ⇒ **没有附件就不产生空的附件行**,所以 H5 那条「用户消息仍是角色行/正文/提及 3 个子节点」的断言照旧成立。
      - 附件文件名刻意**不复用**导出用的 `safeName`(它会把 `.txt` 的扩展名点也换成 `-`),另起 `uploadName`:
        只去掉路径分隔与控制字符、去掉开头的点,保留扩展名与中文。
    - **H6 明确不做**:分片/断点续传、上传进度条、附件的持久化与临时文件清理之外的花样
      (暂存文件只是「让服务端能读到」的中转,消息里已存 base64,清掉不影响历史回看);
      `@` 的补全范围仍限于会话的工程目录(要引用外部文件请用 📎,它会复制一份进暂存目录)。
  - **H1–H5 明确不做**:`hashchange` 与「手动改 URL」的同步、会话内滚动位置对「点会话」也还原、
    为每次点会话之外的操作 push 历史、可拖动的字号滑块(只给变量)。
- **I 组:网页端与 TUI 一致(`/` 命令面板 / `Esc` 中断 / 常用键位)**
  - **先把两边的真实契约钉死再动手**,这一步同样决定了整块做法:
    - TUI 的键位权威定义:`session.interrupt` 默认就是 **`escape`(按一下,不是两下)**、
      `command.palette.show` 是 `ctrl+p`、`prompt.autocomplete.hide` 是 `escape`、`agent.cycle` 是 `shift+tab`、
      `prompt.history.*` 是 `up`/`down`、`prompt.clear` 是 `ctrl+c`。
      > **后来改了,见 `2026-10-15-mobile-design.md` §8.14**:这条「按一下」只看了键位表那一侧;
      TUI 的 `handleInterrupt` 实际是**按两下**（第一下上膛 + 5 秒窗口），用户按的就是这个。
    - 命令只有两条接口:`GET /api/command?location[directory]=<目录>` → `{location, data:[{name, description?}]}`;
      `POST /api/session/:sid/command` body `{name, text, files?, …}` → **204 无内容**。
      实测:未知 `name` → `404 CommandNotFoundError`;**缺 `text` → `400 InvalidRequestError`**
      (`text` 是必填 ⇒ 前端永远带 `text:''`);真命令会把模板展开成**一条普通用户提示词**
      (`说 $ARGUMENTS 好` + `世界` → `说 世界 好`)—— 也就是说,面板只管把 `name`/`text` 原样递过去。
    - 命令**随工程走**:必须把 `location[directory]` 传对才看得到该工程的 `.opencode/commands/*.md`;
      本机的 `init`/`review` 是内置的,与工程无关。**新目录的首次查询可能是空表**(注册表惰性建立),所以 e2e 里要轮询。
    - TUI 的 `/new` `/sessions` `/models` `/help` `/exit` 等是 **TUI 级内置动作,服务端根本没有 command 端点**,
      所以它们不可能从 `GET /api/command` 里来,只能由面板映射到已有能力。
  - **`/` 命令面板**:数据源就是上面那条 `GET /api/command`,按**工程目录缓存**(命令跟着工程变,换会话要重取);
    面板动作(`PANEL_COMMANDS`,16 个)接在后面,**同名时以服务端为准** —— 否则用户在工程里定义的 `/new`
    会被面板动作盖掉,而那条是能真正执行的命令。
  - **触发限定在「输入框为空,或以 `/` 开头」**:`a/b` 这种词中间的 `/` 不弹,免得打扰正常书写。
    `Ctrl+P` 则无视这个限制(`force`)—— 它就是 TUI 里「随时叫出命令面板」的那个入口。
  - **补进输入框 ≠ 立刻执行**:选中只把 `/名字 ` 插进去(光标落在其后),再按一次 `Enter` 才发 ——
    与 TUI 里「autocomplete 选中 / 提交」是两次 `return` 完全一致,也给 `review src/a.ts` 这种带参数的命令留出位置。
  - **发送时的分流只有一条判据**:正文匹配 `^/(名字)( 参数)?` **且命中命令表**才算命令。
    没命中的 `/foo` 一律当普通消息发 —— 否则用户写「/etc/passwd 是不是有问题」会静默消失。
    服务端命令走 `POST …/command`(附件照旧作为 `files[]` 带上,`@` 引用与上传文件都支持);
    面板动作走本地函数。**只有服务端命令成功后才清空附件**(它确实消费了),面板动作不清。
  - **`Esc`**:挂在 `document` 上(焦点在别处也管用),优先级是**关命令面板 → 关 `@` 补全 → 中断当前回合**。
    这条顺序是有意的:TUI 里 `Esc` 先关的是最上层的浮层,只有什么都没开时才轮到 `session.interrupt`;
    面板里「运行中」本来只有一个 `■ 中断` 按钮,`Esc` 就是它的键盘等价物。
    - 两条护栏:只在该会话确实在跑时才中断(空闲时按 `Esc` 什么都不做);
      `<dialog>` 打开时**让对话框自己处理**(`<dialog>` 的原生行为就是 `Esc` 关闭,不能顺手把回合也中断掉)。
    - 为此给 `mentionKey` 原有的 `Esc` 分支补了一句 `preventDefault`:「已消费」这个信号让全局处理器知道该收手。
      (它原本只 `return true`,而 `return true` 只对输入框那个监听器有效,`document` 上的监听器看不见。)
  - **输入历史(`↑`/`↓`)**:只在光标位于**首行**(`↑`)/**末行**(`↓`)时接管 —— 多行输入里方向键的第一职责仍是移动光标。
    历史**按会话隔离**(`store.history` 是 `Map<sid, string[]>`),连续重复只记一次、上限 50 条;
    进入历史前先把当前草稿存起来,`↓` 退到底能还原草稿。
  - **`Shift+Tab` 切智能体**:复用现有的 `switchAgent()`,只在下拉里**跳过空值的「默认」**那一项 ——
    服务端不允许把 `agent` 置空,切到它就是弹一句「智能体不能置空」,循环里不该出现这种空转。
  - **只做浏览器拦得住的键位**:`Ctrl+T`(新标签)、`Ctrl+N`、`Ctrl+W`、`Ctrl+L`(地址栏)是浏览器保留的,
    `preventDefault` 无效,做出来只会是「按了没反应」;`Ctrl+P` 能拦(不然会弹打印),所以采用。
  - **可测性上做的一处小重构**:把输入框的 `keydown` 接线从 `init()` 里抽成 `setupComposerKeys()`,
    测试页才能只接这一根线去验「按键优先级」,而不必把整个 `init()` 跑起来。
  - **`/help` 的一处布局坑**:键位表用两列 grid(`auto 1fr`),小节标题靠 `grid-column: 1 / -1` 跨满整行。
    最初在小节标题后面多写了一个空的 `<div>`,结果它照样占掉「下一行第 1 列」,导致**其后每一行都整体错一格**
    (截图里成了「说明在左、按键在右」)。删掉那个空格子即可,并补了一条断言盯着「标题之后紧跟的就是 `kbd`」。
  - **I 组明确不做**:`Ctrl+C` 清空输入(会把网页里的复制弄坏);把 `Esc` 做成「按两下」——
    TUI 的默认定义就是单次 `escape`,用户感受到的「两下才断」其实是「第一次在关浮层」。
    > **后来改了,见 `2026-10-15-mobile-design.md` §8.14**:`Esc` 改成按两下了(第一下只上膛,
    TUI 的 `handleInterrupt` 本来就是这么写的),而且中断后「排队中」的消息会接着发出去。
- **选择框对话框(`/sessions` · `/models` · `/agents`)** — 把 I 组里三条「只聚焦」的命令补成交互。
  - **先复现再改**:用一个只驱动真实 `app.js` 的页面(合成 `Enter` 按键)跑了一遍 ——
    敲 `/models`,命令面板里确实有这一项,选中后只是把 `/models ` 补进输入框,再按 `Enter` 之后
    **没有任何对话框、没有任何网络请求**,唯一的副作用是 `document.activeElement` 变成了
    `#modelSel`。也就是说:**命令、解析、路由都是对的,错在这一步的落地动作**。
    浏览器不会因为 `focus()` 就展开一个 `<select>`(原生下拉只认点击或键盘交互),
    所以给原生 `<select>` 聚焦 = 用户眼里「按了没反应」。
  - **一个通用选择框管三条命令**,而不是三个各写一遍的对话框:`openPick({ title, items, filter, current, onPick })`。
    `items = [{ key, label, sub?, group?, disabled? }]`;`renderPick()` 按 `group` 插小标题、
    给当前项加 `active`;`pickVisible()` 做过滤(`label` + `sub`,大小写不敏感);
    `pickKey()` 管 ↑/↓ 环绕与 Enter;`pickChoose()` **先关框再回调**。
    键位里 `Esc` 不自己处理,交给 `<dialog>` 的原生行为 —— 全局那个 `Esc` 处理器本来就
    会因为 `anyDialogOpen()` 主动让开,两处不会抢。
  - **「先关框再回调」是有原因的**:`/models` 选完模型要接着问一次档位(`pickVariant`),
    如果不先关,第二个选择框会和第一个叠在一起。
  - **三条命令各自只是「把数据装配成 items」**:
    - `/sessions`:列的是**左栏那批**,所以从 `renderSessions()` 里抽出了 `visibleSessions()`
      (同一套搜索/目录/显示已归档筛选 + 同一套排序)给两边共用 —— 否则对话框和左栏迟早会各说各话。
    - `/models`:按 `providerID` 分组;当前模型不在列表里(比如被禁用)时补一条「当前」,
      免得高亮一个不存在的项。**有 `variants[]` 就追问一次档位**,与 TUI 一致 —— 这样这个对话框
      才真的能替代工具栏那个变体下拉。
    - `/agents`:不提供「默认」这个空选项 —— 服务端不允许把智能体置空(`switchAgent('')` 只会弹一条警告),
      列出来就是让人点了报错。
  - **落地路径只有一条**:新抽出的 `applyModel(key, variant)` 同时服务工具栏的 `change`
    与选择框;`switchModel()` 变成它的一层薄封装。选完之后会 `renderControls()` 回填工具栏,
    两边显示的状态不会不一致。`/agents` 直接复用已有的 `switchAgent()`。
  - **顺手删掉 `focusEl()`**:它此前只被这三条命令用,现在没有任何调用者 ——
    留着它就等于留着一个「会静默什么都不做」的坑,冒烟里也加了一条断言盯着它不许回来。
  - **发现的一个既有行为**:`loadModels()` 早就把 `enabled === false` 的模型滤掉了(工具栏也看不到它们),
    所以选择框里不会有禁用项。`disabled` 这条通用能力保留在 `openPick` 上(并已断言),
    但模型这条线用不到它 —— 这点写进注释与测试,免得以后有人以为「选择框漏了禁用模型」。
  - **选择框明确不做**:不为了 `/sessions` 去翻完所有分页(列的就是左栏当前那批,左栏的「加载更多」照旧);
    不改成输入框上沿的浮动补全(那是 `/` 命令面板的形态,而且它要求输入框为空才好弹);
    不调浏览器原生的 `select.showPicker()`(本机 Firefox 上确实存在,但它依赖浏览器版本与用户手势,
    失败时又回到「什么都没发生」,正是这次要修的病)。
- **完整命令名 + `Enter` 直接执行** — 把「补全一次、再发一次」的第二下省掉。
  - **动机**(使用者原话):「`/models` 弹出选项框之后,按回车就会变成 `/models `,需要再按一下回车
    才会弹出模型选择的对话框」。也就是 **TUI 那套两步在这里被认为是摩擦**,而不是特性。
    面板里那条「补全之后还要再按一次 Enter 才发出」的说明就是照 TUI 写的,现在按使用者的体感改掉。
  - **规则**:`exactCommand()` 判定 `输入框.trim() === '/' + 高亮项.name` —— 命令名已经整个敲完、
    后面没有参数。这时 `Enter` 不再走 `acceptCommand()`,而是 `closeCommands(); send()`。
    只敲了前缀(`/mod`)时**仍然只是补全**,免得把「想接着打参数」误判成执行;
    高亮被 `↑`/`↓` 移到别的命令上时,补全成的是**那个**命令而不是执行输入框里的名字。
    `Tab` 不做这件事(它只是补全键)。
  - **适用面**:面板里**所有**命令(服务端命令与面板动作都一样),规则统一,不按命令类型分叉。
  - **有意保留的两点**:没有选中的会话时 `send()` 本来就早退,所以 `/help` 之类依旧要求先选中会话
    (与改动前一致);以及带参数的命令名打一半(如 `/models src`)不会走到这里 —— 命令面板在查询词
    里出现空格时根本不会打开,那条路径照旧当普通消息发。

## 8. 测试

### 后端冒烟(`test/smoke.sh`,需运行中的 OpenCode 服务)
- `GET /__health` → 200 且含 base URL。
- `GET /api/session?limit=1` → 经代理返回 200 JSON(证明 Basic 注入成功)。
- 直连 OpenCode 无鉴权 → 401;经代理 → 200(证明鉴权只在代理侧)。
- 经代理订阅 `/api/event`,约 2s 内收到 `server.connected`。
- 断言任何发给浏览器的响应体 / 头中**不含** password。
- **顶部栏结构(15 项)**:`#topbar` 切片内包含 `#search`/`#dirFilter`/`#order`/`#btnNew`/`#refresh`/`#showArchived`/`#count`/`#status`;
  首页不再有 `id="filters"`、不再有 `<aside>`、不再有 `#resizer-left`,且 `class="resizer"` 只剩 1 处;
  `styles.css` 主区为 `var(--list-w, 560px) 6px minmax(0, 1fr)`,不再引用 `--left-w`/`--mid-w`,不再有 `calc(100vh - 43px)`。

### 前端手动验收清单
- [ ] 列表能同时看到多个工程目录下的会话,并按更新时间倒序。
- [ ] 顶栏搜索关键字能过滤;选择工程目录能只显示该工程会话。
- [ ] 改名后标题即时更新。
- [ ] 移动到新目录后,该会话的工程目录更新。
- [ ] 删除后会话从列表消失。
- [ ] 打开会话能看到历史消息(user/assistant/tool 渲染正确)。
- [ ] 输入并发送消息后,能逐字看到助手回复流出(Markdown 实时重排、末尾有闪烁光标、标题行有「输出中」徽标)。
- [ ] 流式期间思考块自动展开并逐字增长;回合结束后回落成折叠态(`▸ 思考`)。
- [ ] 助手调用工具时,工具卡片在参数流式阶段就出现,状态由「运行中」变为「已完成」并展示输出。
- [ ] 助手编辑文件后,`edit` 卡片默认展开并直接显示彩色 diff(行号 + `+N -M`),不需要再点开。
- [ ] `write` 卡片默认展开并显示写入的正文(带行号);`patch` 改多个文件时逐文件各显示一块。
- [ ] 改动有语法/类型诊断时,诊断行(`错误 [行:列] 消息`)显示在 diff 下方。
- [ ] `question` 已应答后,卡片里能看到「问题 → 答案」;`skill` 卡片显示 `→ Skill "名字"`。
- [ ] 分栏条顶部的小手柄(`‹`)收起左侧会话表,对话区占满整宽(左边留一条 16px 窄槽);再点(`›`)恢复,且**拖出来的列宽没变**;刷新后收起状态保持。
- [ ] **收起后手柄还在原位**、能点回来(这是唯一入口),点它不会顺手把列宽也改了;拖动分栏条空白处照旧能改宽度、双击照旧复位。
- [ ] 点开一个会话后按 F5:页面重新加载后**仍停在这个会话**(不是在空白的「未选择会话」);
      复制地址栏(带 `#ses_xxx`)在另一个标签打开,也直接落到同一会话。
- [ ] 删除当前正在看的会话后,地址栏的 `#ses_xxx` 被清掉(刷新不会去找一个已删除的会话)。
- [ ] 回复落地后与流式过程看到的内容一致,消息不重复、不闪回(本地缓冲被服务端权威版本替换)。
- [ ] 停掉 OpenCode 服务时,页面给出清晰错误提示而非白屏。
- [ ] 触发一次 `question` 工具问询:底部出现卡片,提交后助手继续;列表徽标消失。
- [ ] 触发一次需批准的权限请求(需在配置里把某动作设为 `ask`):三个按钮可用,应答后工具继续。
- [ ] 助手运行中:标题栏显示 `● 运行中`,输入区出现「排队/插话」与「■ 中断」;点中断后回到空闲。
- [ ] 运行中发送消息默认「插话」:立即并入当前回合(下一个 step 边界执行);切到「排队」则进入待发送队列(不立刻出现在消息流),回合结束后自动执行。
- [ ] 待发送项可「改为排队/改为插话」与「取消」,操作后队列即时刷新。
- [ ] 切换智能体/模型后,重新打开该会话仍显示新值(已持久化)。
- [ ] 顶栏「+ 新建」填绝对路径目录后能建出会话并自动打开;留空目录或填相对路径会就地报错。
- [ ] 列表「归档」后该会话从列表消失,顶栏提示「另 N 个已归档」;勾选「显示已归档」可见 `📦 已归档` 行并能「取消归档」。
- [ ] 聊天头部「导出」下载 JSON;「在 TUI 打开」给出的命令粘到终端能进入同一会话。
- [ ] 顶栏「导入」选择导出得到的 JSON,指定目标目录后导入成功并自动打开(消息完整)。
- [ ] 输入框里敲 `@`:上方浮出工程内的文件列表(目录名淡色、文件名加粗),↑↓ 选、Enter 补进正文;Esc 关掉。
- [ ] 补全选中后输入框上方出现 `@ 引用` chip;把正文里那个 `@` 删掉,chip 随即消失(发之前就知道会带什么)。
- [ ] 点 📎 选文件 / 把文件拖进输入区 / 截图后直接粘贴:输入框上方出现带文件名与大小的 chip,点 `×` 能移除。
- [ ] 发出去之后,用户消息下方逐条列出 `📎 名字 mime · 大小 来源路径`;**图片直接显示缩略图**。
- [ ] 硬刷新(`Ctrl+Shift+R`)后历史消息里的附件与缩略图照旧(内容在消息里,不依赖暂存文件)。
- [ ] 故意选一个超过 32MB 的文件:被拒并提示,不会发出请求、也不会把消息卡住。

### 问询应答的自动化验证(本次已执行)
- 浏览器内断言 36 项(`/tmp/ocsm-probe/asks-unit*.html`,真实 `app.js`):字段渲染、默认值预填、`when` 显隐、单选+自填互斥、答案组装与本地校验(含 `external`、数值范围、`minItems/maxItems`、`minLength`、`email/uri`)。
- 端到端 11 项(经面板代理,`/tmp/ocsm-probe/e2e-forms.sh`):真实创建表单 → 列表可见(`Form.Info` 无 `state`)→ 提交未激活字段被拒 `400` → `external` 未确认被拒 `400` → 正常应答 `204` 且服务端保存答案与提交一致 → `detail` 为 `answered` → 取消 `204` 且为 `cancelled`。
- 权限应答路由经代理可达(已处理/不存在 → `404`);`permission.asked` 的真实出现取决于本机权限策略,当前全部 `allow`,故留作手动验收。

### 会话控制的自动化验证(本次已执行)
- 端到端 `test/e2e-controls.sh`(22 项;`OCS_E2E_LLM=1` 时 31 项,全部通过):agent 切到 `plan`/`build` 并核对持久化;`model` 缺 `providerID` 被拒 `400`、正常切换 `204` 且持久化;空闲中断 `interrupted=false`;未知会话的 `interrupt`/`inbox` 均 `404`;`synthetic` 项被前端规则过滤;`inbox` 改投递方式与取消的负例(`409`/`204`);真实运行中 `queue` 投递→队列可见→改 `steer`→取消→`interrupt` 返回 `true` 且回到空闲。
- 浏览器内断言 `test/ui-controls-run.js`(90 项,真实 `public/app.js`,无头 Firefox):agent/model 选择器的过滤与分组、变体显隐、切换请求体形状、中断/投递控件显隐、运行状态文案与列表标记、待发送队列渲染与 PATCH/DELETE 请求、发送时的 `delivery` 选择(含默认「插话」)、事件→运行状态映射。
- 离线渲染核对:`/tmp/ocsm-probe/controls-preview.html`(真实 `app.js` + `styles.css` + 假数据)在运行中与空闲两种状态下的截图,确认工具栏、待发送队列与提示条不遮挡输入框。

### 能力扩展的自动化验证(本次已执行)
- 端到端 `test/e2e-capabilities.sh`(26 项,全部通过):新建会话的 `title`/`agent`/`model`/`location` 均按传入值保存且返回 `time.created`;列表接口带 `metadata`;归档标记写入/读回/清空;
  实证 `PATCH metadata` 为整体替换;导出 `sanitize=false` 保留标题、`sanitize=true` 已脱敏、未知会话 `404`;
  导入的「未解包 → 400」「换新 ID 成功且 `location` 生效」「同 ID → 409」「缺 `projectID` → 400」。
- 浏览器内断言 `test/ui-capabilities-run.js`(71 项,真实 `public/app.js`,无头 Firefox):归档判定(4 种 metadata 形状)、列表过滤与徽标/按钮态、
  归档时 `PATCH` 读-改-写保留其它命名空间、取消归档清空 `ocs`、确认框取消则不发请求、聊天头部按钮态;
  新建的选择器填充与请求体形状(含 `variant`)、空目录/相对路径的本地校验;
  导入的解包、换 ID、`location`、409 重试、非法 JSON / 缺字段 / 未选文件;导出的 URL 与 `sanitize` 开关、下载文件名与内容形状;
  `tuiCommand` 的引号转义;`modelRefOf` / `safeName` / `newSessionID` 边界。
- 离线渲染核对:`/tmp/ocsm-probe/caps-preview.html`(真实 `index.html` + `styles.css` + `app.js` + 假数据,`?only=list|new|import|export|tui|arch`)逐个截图,
  确认左栏工具行(当时布局;E 组后已迁到顶栏,见 §7)、归档标记、聊天头部操作区与四个对话框的布局;长目录路径在「在 TUI 打开」里折行完整可见。

### 流式渲染的自动化验证(本次已执行)
- 端到端 `test/e2e-stream.sh`(4 项;`OCS_E2E_LLM=1` 时 27 项,全部通过):
  默认部分只验证事件流形状(单行 `data:`、无 `event:` 行、首帧 `server.connected`、每帧合法 JSON);
  开 LLM 后追加真实流式断言 —— `step.started` 恰好一个、`text.delta` 增量 `>= 5` 个且**累加严格等于** `ended.text`(457/457)、
  事件顺序 `started < delta < ended`、所有 part 事件的 `assistantMessageID` 都能对上 step、`step.ended` 带 `finish` 与 `output tokens`,
  `execution.succeeded` 收束、`reasoning` 与 `text` 的 `ordinal` 各自从 0 起,
  以及**流式期间(已见到 >= 3 个 delta 时)消息接口的助手消息 parts `>= 1` 但 `text` 长度仍为 0** —— 这正是「必须在前端自拼」的直接证据。
- 浏览器内断言 `test/ui-stream-run.js`(96 项,真实 `public/app.js`,无头 Firefox):
  事件分类(`isStreamDelta` / `isStreamLocal`)、`step.started` 立即建气泡并置运行态、
  **结构指纹不含文本长度**所以 delta 不触发整条重建、节点 identity 保持不变(消息元素 / 文本节点 / 标题行 / 其它消息都不重建)、
  Markdown 增量重排(加粗、列表)、`ordinal` 按类型计(多文本块各占 `text:0` / `text:1` 且与 `reasoning:0` 不冲突)、
  `*.ended` 权威覆盖、工具卡片出现与状态流转 + 参数展开、`tool.progress` 不算结构变化也不凭空造卡片、
  `step.ended` 用量上屏、**服务端半成品(空 text)不覆盖本地文本**、回合收束后仍显示、
  权威版本到达后回收缓冲且**不重复渲染**、光标位置(落在最后一块内部、不另起一行、随最后一块移交)与思考块展开箭头、
  非当前会话的缓冲不进入视图、陈旧缓冲回收、无 `assistantMessageID` / 未知事件等边界,
  以及防抖对账的分流规则(有缓冲的 delta 不排 150ms 重取、无缓冲的 delta 退回重取、`*.ended` 与工具事件仍重取)。
- 离线渲染核对:`/tmp/ocsm-probe/stream-preview.html`(真实 `index.html` + `styles.css` + `app.js` + 假数据,`?only=mid|reason|tool|done`)
  截图 `stream-{mid,reason,tool,done}.png`,确认光标贴在上一个字的行内末尾、思考块展开时的箭头、「输出中」徽标不换行、
  工具行与用量行的位置。这一轮核对实际抓出了两个肉眼可见的问题(光标掉到块级元素之外单独占一行、徽标被挤到下一行),已修。

### 顶部栏布局的自动化验证(本次已执行)
- 冒烟 `test/smoke.sh`:**50 项全部通过**(由 35 项增至 50 项,新增的 15 项即上面的顶部栏结构断言)。
- 既有九套测试全部复跑且**断言一字未改仍然全绿** —— 证明「元素 id 不变 + 业务逻辑零改动」的前提成立:
  `e2e-asks` 13、`e2e-controls` 22(LLM 31)、`e2e-capabilities` 26、`e2e-stream` 4(LLM 27)、
  浏览器内断言 `ui-asks` 39、`ui-controls` 83、`ui-capabilities` 71、`ui-stream` 96(F 组后又往 `ui-stream` 追加 6 项 → 102,见下)。
  (四个 `test/ui-*.html` 骨架同步成「控件在 `#topbar` 内、无 `#filters`/`#resizer-left`」,测试断言本身未动。)
- 离线渲染核对:`/tmp/ocsm-probe/top-preview.html`(真实 `index.html` + `styles.css` + `app.js` + 假数据,`?only=list|selected`)
  截图 `top-1500.png` / `top-1100.png` / `top-sel.png` —— 1500px 顶栏单行、1100px 自动折成两行且不遮挡列表与对话,
  两种情况底部输入框都稳在视口内(验证 `body` 纵向 flex + `main { flex:1; min-height:0 }` 的修法必要且有效)。

### 工具卡片(diff / 代码 / 诊断)的自动化验证(本次已执行)
- 冒烟 `test/smoke.sh`:**53 项全部通过**(由 50 项增至 53 项,新增 3 项断言 `styles.css` 含 diff 配色变量、`.dl.add/.dl.del`、`.dfile/.diff`)。
- 新增浏览器内断言 `test/ui-tools-run.js`:**79 项全部通过**(真实 `public/app.js`,无头 Firefox):
  - `parsePatch`:文件头与 `=====` 分隔行不进正文、hunk 保留原文、正文行数、删除行只有旧行号、新增行只有新行号、
    上下文行双向行号同步、增删之后行号继续对齐、**空上下文行(单空格)不被丢**、末尾换行不产生幽灵行、没有 hunk 时返回空数组、空值不炸。
  - `diffHtml`:状态徽标(新建/修改/删除)、路径、统计取自服务端 `additions/deletions`、增删行类名、多文件各一块、
    没有 patch 的删除文件退化为 `- N 行`、空数组返回空串。
  - `codeHtml`:去掉末尾换行带来的空行、行号从 1 起、整块 `diff code`(只有一列行号)、空内容不炸。
  - `diagHtml`:精确路径命中、行列号 0 基转 1 基、相对路径宽松命中、无诊断返回空串、路径对不上不误报。
  - `inputSummary`:command 优先、无主键时按出现顺序拼标量、字符串入参原样、压平换行、无标量为空、`null` 为空。
  - `toolHtml`:`edit`/`write`/`patch` 的摘要文案、增删统计、**默认展开 `open`**、正文含 diff;
    **`edit` 运行中(无 `files`)只写目标路径且不泄漏 `oldString`**;`write` 的 `# 写入` + 行号渲染;`patch` 的 `← N 个文件`;
    `question` 已答列「问题 → 答案」、未答只写「提问中…」;`skill` 写 `→ Skill "名字"`;
    通用工具仍折叠、入参仍在 `pre` 里、无入参时是单行。
  - `toolMetaSig`:无 metadata / 无 files 为空、有 files 非空、内容变了指纹就变。
  - 事件通道:`tool.progress` 直接调 `handleStreamEvent` 只改数据**不重绘**;走完整 `handleEvent` 时
    **指纹变了就补一次重绘、diff 立刻上屏**;metadata 没变时**不重建 DOM**;`tool.success` 后状态变已完成且 diff 仍在。
- 回归锁:`test/ui-stream.html` **由 96 项增至 102 项**(新增 6 项),用真实时序验证
  「`edit` 卡片先出现(还没有 diff)→ `tool.progress` 带来 `metadata.files` → diff 立刻上屏」,
  并锁住「metadata 没变的 progress 不重建 DOM」。既有 96 项断言**一字未改**。
- 既有其余测试全部复跑且全绿:`e2e-asks` 13、`e2e-controls` 22(LLM 31)、`e2e-capabilities` 26、`e2e-stream` 4(LLM 27)、
  浏览器内断言 `ui-asks` 39、`ui-controls` 83、`ui-capabilities` 71。
- 离线渲染核对:`/tmp/ocsm-probe/tools-build.js` → `tools-preview.html`(真实 `index.html` + `styles.css` + `app.js`),
  其中 `edit` 的两条用的是**从真实会话导出的 tool part**(`/tmp/ocsm-probe/real-diff-parts.json`,不是编的),
  另加自造的 `write` / `patch`(两文件) / 带诊断的 `edit` / 已答 `question` / 通用 `bash` / `skill` / 运行中的 `edit`;
  `?only=real` 更进一步,直接把**一整条真实的助手消息**(`/tmp/ocsm-probe/real-full-msg.json`:`reasoning` + `text` + 带 diff 的 `edit`)
  交给 `renderMessages()` 渲染,确认 diff 卡片在真实消息流里的位置、`思考` 折叠态与用量行都正常(截图 `real-msg.png`)。
  其余截图 `tools-{edit,write,patch,diag,stream,all}.png`(1400px)与 `narrow-{edit,patch,all}.png`(1100px):
  diff 行号列对齐、配色正确、`+N -M` 靠右、诊断在 diff 下方、窄屏下 diff 横向滚动而不撑破对话栏、底部输入框稳在视口内。
  这一轮核对实际抓出一个保真度问题(运行中的 `edit` 落进通用分支,把 `oldString: x newString: y` 铺了出来),已修。

### 布局与状态保持(列表折叠 / 刷新恢复)的自动化验证
- 冒烟 `test/smoke.sh`:**59 项全部通过**(由 53 项起:顶栏结构断言撤掉 `#btnList`、改判「手柄在 `#resizer-mid` 切片里且顶栏没有它」,
  并新增「收起时为分栏条留 16px 窄槽」与「**收起时不隐藏分栏条**」两条)。
- 浏览器内断言 `test/ui-layout-run.js`:**60 项全部通过**(真实 `public/app.js`,无头 Firefox):
  - 折叠:初始展开、箭头 `‹`/`›` 与 `aria-label` 翻转、`ocs.listHidden` 写入/清空、
    **手柄就长在分栏条里**、收起后 `#listpane` 隐藏而 **`#resizer-mid` 仍可见**、
    **收起后手柄仍有实际大小且没被挤出视口**、**收起态点手柄能重新展开**(「入口不能跟着消失」的回归锁)、
    收起后让出的正好是 16px 窄槽、展开后网格回到「420px + 16px + 1fr」且 **`--list-w` 没被吃掉**、
    **点手柄不会进入拖拽态/不改列宽,点条上空白仍能进入拖拽并正常收尾**、
    `setupListToggle()` 重复接线按存储重画且单击只切换一次。
  - hash 持久化:`hashToID` 的 7 个边界(带/不带 `#`、空、`null`/`undefined`、非 `ses` 前缀、URL 解码、非法转义不炸)、
    选中写 hash、切换会话 hash 跟着变、删除后 hash 被清空、
    `restoreFromHash` 恢复消息与标题、恢复后列表行标记选中、**不抢已有选择**、
    hash 指向不存在的会话时不炸且不残留上一条消息、hash 为空/非法时不选。
- 既有其余十套测试全部复跑且全绿:`e2e-asks` 13、`e2e-controls` 22(LLM 31)、`e2e-capabilities` 26、`e2e-stream` 4(LLM 27)、
  浏览器内断言 `ui-asks` 39、`ui-controls` 83、`ui-capabilities` 71、`ui-stream` 102、`ui-tools` 79。
- 离线渲染核对:`/tmp/ocsm-probe/list-build.js` → `list-preview.html`(真实 `index.html` + `styles.css` + `app.js`,
  用真实的整条助手消息当对话内容),`?only=open|closed` 各截 1400px 与 1100px:
  手柄在两态都停在同一条线上、展开态浅灰、收起态 accent 描边且箭头翻转,收起后列表让位、diff 完整可见、窄槽读得出来。
- 选型阶段的离线对比页(`/tmp/ocsm-probe/handle-build.js` → `handle-v{1,2,3}.html`)在实现前就抓出了两个坑:
  ①真实 CSS 的 `main.list-hidden #resizer-mid { display:none }` 会把分栏条连手柄一起吞掉,必须显式覆盖;
  ②「把模板降成单列」的写法**不能**再配显式 `grid-column`(会凭空长出隐式列把对话区挤走)。
  这也是最后选择「保留分栏条 + 显式列位」的直接原因。

### H 组的自动化验证(本次已执行)
- 冒烟 `test/smoke.sh`:**66 项全部通过**(由 59 项起,新增 7 项):
  ① 会话区字号旋钮(`--chat-fs: 14px`、`font-size: var(--chat-fs)`、区内 `0.92em`/`0.88em` 相对字号在);
  ② agent/skill 提及的样式(`.ref-agent`/`.ref-skill`/`.refs`)在;
  ③ 提及渲染(`userRefsHtml` + `ref-agent`/`ref-skill`)在;
  ④ 前后退同步(`history.pushState` + `popstate` + `setupHistoryNav`),与既有的 `history.replaceState` + `restoreFromHash` 并存;
  ⑤ 滚动位置锚点(`ocs.scroll` + `sessionStorage` + `savedAnchor` + `applyScrollAnchor`);
  ⑥ 顶栏条件持久化(4 个 `ocs.q.*` 键 + `restoreFilters` + `setupFilters`);
  ⑦ **顺序锁**:用 `awk` 从 `app.js` 里切出 `init()` 函数体,断言 `setupFilters()` 出现在 `loadSessions({ reset: true }).then(...)` **之前**
     (先回填再拉列表,否则启动会按默认值白拉一次)。
- 浏览器内断言 `test/ui-layout-run.js`:**114 项全部通过**(由 60 项起,新增 54 项,真实 `public/app.js`,无头 Firefox):
  - **前进/后退 19 项**:点会话把这一格压进历史栈、重复点同一个会话不再入栈、切到另一个会话再入一格、
    只换 URL 还没触发事件时不动会话、收到 `popstate` 后切到 URL 里的会话、**跟随后退不会把这一格再压一遍**、
    跟随后退/前进后消息也跟着换、后退到无 hash 时取消选中并清空对话区(标题回空态、发送键禁用、操作条隐藏)、
    取消选中用 `replaceState` 不长栈、空操作也不入栈。
  - **会话内滚动位置 17 项**:长会话确实能滚动(测试专用 60 条消息)、不还原时跳到底部、
    锚点进 `sessionStorage` 且带消息 id 与偏移、**没写进 `localStorage`**、记的是当时位置、
    刷新后回到原处且**确实不在底部**、锚点被消费掉(只还原一次)、还原走同一套渲染、从列表点进来仍跳底部、
    锚点消息不存在时退回像素值、无存档照旧、**上限 20 个会话**与淘汰顺序。
  - **顶栏条件持久化 18 项**:空存档时的四项默认值、四项恢复(store 与控件都跟上)、
    记住的目录即使不在结果里也出现在下拉中且为选中态、改排序/目录/显示已归档/搜索都即时落盘、
    取消勾选存空串、清空搜库存空串、确认存的是 `localStorage` 而非 `sessionStorage`。
  - 等待异步用的是测试页里的 `settle()`(纯微任务轮转,`tries` 次 `await Promise.resolve()`),
    **不用定时器** —— 与 H3 的「不打桩定时器」是同一个原因。
- 浏览器内断言 `test/ui-tools-run.js`:**94 项全部通过**(由 79 项起,新增 15 项,`userRefsHtml`):
  没有 `agents`/`skills` 时不出这一行、空数组也不出、`@name` 与 `title="智能体"`、`#name` 与 `title="技能"`、
  两者同时存在各一个、多个 agent 都渲染、缺 `name` 的条目被跳过、agent 只有 `id` 时用 `id` 兜底、
  提及名里的 HTML 被转义、落进 `renderMessage` 后顺序是「角色行 / 正文 / 提及」、没有提及时不产生空的 `refs` 行、
  用户消息正文仍被转义。
- 既有其余五套测试复跑全绿:`ui-asks` 39、`ui-controls` 83、`ui-capabilities` 71、`ui-stream` 102(计数未变)。

### H 组第 ⑥ 项(文件附件)的自动化验证(本次已执行)
- 冒烟 `test/smoke.sh`:**74 项全部通过**(由 66 项起,新增 8 项):附件与 `@` 补全的前端逻辑(`resolveMentions`/`userFilesHtml`/`setupAttachments`/`uploadPathFor`/`mentionQuery`)、
  上传必须走 `/api/experimental/fs/write` 而不是自建端点(`/__health` 的 `uploadDir` 也在)、
  `#mentions`/`.achip`/`.att-img`/`.att-src` 样式、输入区的附件按钮/文件框/待发送行/补全下拉、
  `/__health` 给出 `uploadDir`、代理会建目录并定期清理(`ensureUploadDir`/`pruneUploads`/`UPLOAD_TTL_MS`)、
  附件 uri 必须加 `file://` 前缀;外加**第二条顺序锁**(`setupAttachments()` 必须排在 `paintDelivery()` 之前)。
- 端到端 `test/e2e-attach.sh`:**32 项全部通过**(纯 curl,只建临时会话与临时文件,结束时全删)。验的是面板依赖的服务端契约:
  ① 代理建好暂存目录并把 `uploadDir` 通过 `/__health` 告知前端;
  ② `POST /api/experimental/fs/write?path=<绝对路径>` 原始字节写盘、内容**逐字节一致**、返回的绝对路径正是前端要当 `uri` 的那个;
  ③ `GET /api/fs/find` 返回相对工程目录的路径、并回报基准目录;
  ④ 带 `file:` URI 的提示词被接受,读回的用户消息 `files[0]` 里 `name`/`mime`/`source.uri` 都在、`data` 解出来正是原文、`mention` 原样落库;
  ⑤ 裸绝对路径 / 相对路径 / `https` 三种非法 uri 都被 `400` 拒且原因可辨(`Invalid` vs `Unsupported`);
  ⑥ 面板服务出去的 `app.js`/`styles.css`/`index.html` 确实带上了附件功能。
- 浏览器内断言 `test/ui-attach-run.js`:**132 项全部通过**(真实 `public/app.js`,无头 Firefox):
  - **纯函数**:`fileURI`(含空值不炸)、`baseName`/`joinDir` 的边界、`humanSize` 的 B/KB/MB 与非法值、
    `uploadName`(斜杠/反斜杠换下划线、路径穿越、开头点号、空值兜底、超长截断、中文保留)、
    `uploadPathFor`(时间戳+随机串+安全名、名字里的斜杠跑不出目录、目录结尾多余斜杠被吃掉)、`b64Size`(补 1/2 个 `=` 与 3 的倍数)。
  - **`userFilesHtml`**:两条都渲染、文件名/mime/按 base64 反算的大小、uri 来源显示路径而 inline 不显示、
    `image/*` 内联 `data:` 缩略图、非图片不给缩略图、缺 `name` 用路径末段兜底、`name`/`mime` 都缺也不炸、名字里的 HTML 被转义、
    落进 `renderMessage` 后顺序是「角色行 / 正文 / 提及 / 附件」、没有附件时不产生空的 `atts` 行。
  - **`resolveMentions`**:没确认过的 `@` 不生成附件、确认过才生成、uri 是 `file:` URI、`mention` 的 `start/end/text` 切出来正好是那一段、
    多个引用各自的锚点都对、中文里紧跟标点不算进引用、邮箱里的 `@` 不当路径。
  - **`@` 补全**:光标前 token 的提取边界(没有 `@`/刚打一个 `@`/取最后一个 `@`/后面有空格就不补全/紧贴中文/光标在中间)、
    请求 `/api/fs/find` 且带 `query`+`type=file`+`location[directory]` 的 deepObject 编码、补全项用响应的 `location.directory` 拼绝对路径、
    目录名与文件名分列、上下键环绕与高亮重绘、Enter 被补全消费(不会顺手把消息发出去)、插入后光标位置与记忆绝对路径、Esc 关闭、
    下拉关着时不吃按键、点选走同一条路、没有匹配时的空状态。
  - **附件排队**:上传走 `fs/write`、POST、目标绝对路径、body 就是文件本身、chip 的名字/大小/来源路径/移除按钮、点 × 移除、
    拖放(`drop` + `dragover` 被拦)、粘贴 `clipboardData.files`、文件框 `change`、超限直接拒且**没有发出任何请求**、上传失败回滚并提示。
  - **`send()`**:`files[]` = 上传的文件 + `@` 引用(共 2 条)、`@` 引用的 uri 指向工程目录里那个文件、`mention` 锚点正确、
    正文首尾空白被 trim、发送成功才清空待发送列表、失败时保留可重发且弹提示、切会话清空并关掉补全、
    没选中会话时附件按钮禁用、暂存目录未知时先问 `/__health` 再传。
- 其余六套 UI 测试与四套 e2e 测试复跑全绿(计数见 README)。其中踩到一个**命名冲突**:新版 `uploadName` 最初叫 `safeName`,
  而 `app.js` 里早就有一个给导出文件名用的 `safeName` —— 后声明的函数把前者整个盖掉,`ui-capabilities` 立刻红了 2 项
  (「去掉路径分隔与空白」「保留中文与数字」)。改名后恢复;**这正是既有测试的价值所在**。
- 真实目检:`/tmp/ocsm-probe/attach-build.js` 用真实 `index.html`/`styles.css`/`app.js` + 真实形状的附件消息
  (一段文本 + 一张 240×120 PNG,`data` 是服务端形状的 base64)渲染截图 —— 用户消息下方两条附件行(`📎 note.txt text/plain · 17 B file:///...`、
  `📎 shot.png image/png · 59.4 KB file:///...`)与缩略图、输入区两种 chip(`@ 引用` 与已上传文件)、
  `@` 补全下拉(目录名淡色 / 文件名加粗、当前项高亮)都如预期。

### I 组(命令面板 / `Esc` 中断 / TUI 键位)的自动化验证(本次已执行)
- 冒烟 `test/smoke.sh`:**92 项全部通过**(由 74 项起,新增 18 项,全部是**静态**断言 —— 行为验证交给下面两套):
  命令面板的五个函数(`cmdQuery`/`openCommands`/`acceptCommand`/`mergedCommands`/`commandKey`)、
  列表按工程取自 `GET /api/command?location[directory]`、命中命令走 `/command` 通道、
  同名以服务端优先、16 个面板动作齐全(用 python 比对 `{ name: '…' }` 的字面量集合,缺哪个就报哪个)、
  全局键位接线在 `document` 上、只在会话在跑时中断且对话框打开时不抢键、输入历史与 `Shift+Tab`、`Ctrl+P`、
  `#cmds`/`#dlgHelp`/`#helpKeys` 三个节点、`#cmds`/`.cmd-tag`/`.keys kbd` 样式,以及三个 I 组测试文件都在。
  其中**两条新的顺序锁**用 `awk` 取函数体:
  `setupTuiKeys()` 里必须是 `closeCommands()` → `closeMentions()` → `interrupt()`(这就是 `Esc` 的优先级,写反了会变成「一按 Esc 直接中断」),
  (后来那个 `interrupt()` 换成了 `requestInterrupt()` —— 按两下那档,见移动端设计 §8.14)
  `setupComposerKeys()` 里必须是 `commandKey` → `mentionKey` → `historyKey` → `send`(输入框里的按键让给谁)。
- 端到端 `test/e2e-commands.sh`:**40 项全部通过**(纯 curl,只建临时会话与 `/tmp` 临时工程目录,结束时全删)。
  验的是 `GET /api/command` 与 `POST …/command` 的真实行为:
  ① 回显查询用的 `location.directory`、列表是数组且每项有 `name`、内置 `init`/`review` 与工程无关;
  ② 全新工程目录的命令表会被惰性建立起来(首次可能是空表,因此要轮询);
  ③ 工程内 `.opencode/commands/hello.md` 出现在该工程的列表里、换个目录就看不到(命令确实随 `location` 走);
  ④ 未知命令 → `404 CommandNotFoundError` 且**不落任何消息**;
  ⑤ 缺 `text` → `400 InvalidRequestError`(报错指明缺的是 `text`)且同样不落消息;
  ⑥ 真命令 → `204`,并把模板展开成**一条普通用户提示词**(`说 $ARGUMENTS 好` + `世界` → `说 世界 好`,消息数只 +1);
  ⑦ `POST /compact` → `200` 且返回 `type: compaction`;
  ⑧ `POST /revert/stage` / `DELETE /revert` 存在,会话忙时回 `409 SessionBusyError`(面板据此提示「正在运行」);
  ⑨ 面板服务出去的 `app.js`/`styles.css`/`index.html` 确实带上了命令面板、全局键位与快捷键对话框。
- 浏览器内断言 `test/ui-commands-run.js`:**143 项全部通过**(真实 `public/app.js`,无头 Firefox):
  - `cmdQuery`:行首判定、`a/b` 不弹、换行后的行首照弹、嵌套命令名 `team/review`、只看光标之前、
    没有 `/` 或只剩空白时为 `null`、输入框不在时也不炸。
  - `mergedCommands`:服务端命令排前、面板项带 `panel` 标记与说明、同名时服务端优先、没有服务端命令时面板动作照旧。
  - `parseCommand`:带参数 / 无参数 / 多个空格后的参数整体保留 / 大小写不敏感但取表里的写法 / 非行首不当命令 /
    未命中不静默失败 / 嵌套命令 / 空串与非字符串。
  - `loadCommands`:按目录缓存(第二次不再请求)、换目录重新请求、目录为空直接返回。
  - `openCommands`:非 `/` 开头不开、按查询词过滤、前缀命中排前面、面板项渲染「面板」标签、无匹配的空态而不是不显示、
    `force` 供 `Ctrl+P`、条目数受 `CMD_LIMIT` 截断、没选中会话不开。
  - `commandKey`/`acceptCommand`:上下键环绕、`Tab`/`Enter` 选中且 `preventDefault`(不会顺手把消息发出去)、
    补全成 `/名字 ` 并留出参数位、保留光标之后已有的正文、`Esc` 关掉并标记已消费、面板关着或没有条目时不吃按键。
  - `send()` 的分流:命中服务端命令走 `POST /command` 而**不是** `/prompt`、`name`/`text` 分开、
    不忙时不带 `delivery`、忙时带上、能带 `@` 引用附件且**成功后才清空**、失败弹 toast 且不补发成普通消息、
    未命中的 `/foo` 照旧当普通消息发。
  - 面板动作:`/compact` 的 `{}` 请求体、`/undo` 取**最后一条用户消息**(按 `time.created` 取,不依赖 Map 顺序)并带 `files:true`、
    会话在跑时先拦住不请求、`/redo` 的 `DELETE` 与 `409` 转成「没有可重做的撤销」、`/rename` 的 `PATCH`、
    `/archive` 的 metadata 读-改-写、`/clear` 不发任何请求、`/help` 的小节标题跨满两列不错位、
    `/sessions`/`/models`/`/agents` 的焦点跳转。
  - 输入历史:`pushHistory` 连续重复只记一次、`↑` 进最新再往上、到头吞键不动正文、`↓` 退回草稿、
    不在历史里 `↓` 不接管、没有历史 `↑` 不接管、多行时按首行/末行判定接管与否、切会话归位、普通消息也记历史。
  - 全局键位:`Esc` 优先关命令面板、其次关 `@` 补全、都不开且在跑才中断、没在跑不动、`<dialog>` 打开时不抢键、
    已被别人 `preventDefault` 的 `Esc` 跳过;`Ctrl+P` 打开且不动输入内容、带 `Shift`/`Alt` 或对话框打开时不算;
    `Shift+Tab` 切智能体、跳过空值的「默认」、到头绕回、命令面板开着或对话框打开时不抢键。
  - 输入框内的接线(测试页手动接上 `setupComposerKeys()`):面板开着时方向键给面板而不落到历史、面板没开时给历史、`Enter` 仍然发送。
- 真实目检:`/tmp/ocsm-probe/cmds-build.js` 用真实 `index.html`/`styles.css`/`app.js` + 真实命令列表
  (`init`/`review` + 16 个面板动作)渲染三张截图 —— 全量列表(服务端命令在前不带标签、面板动作带「面板」标签)、
  `/re` 过滤后的列表(前缀命中的 `review` 排最前并高亮)、`/help` 的键位对话框。
  最后一张**第一次截出来就是错的**(说明在左、按键在右),正是靠它发现了那个 `<div>` 占位导致的整体错位。
- 其余八套 UI 测试与五套 e2e 测试复跑全绿(计数见 README),包括 `ui-attach-run.js` 的 132 项 ——
  这很重要,因为 I 组动了 `mentionKey` 的 `Esc` 分支、把输入框的 `keydown` 接线搬了家、并往 `store` 里加了字段。

### 选择框(`/sessions` · `/models` · `/agents`)的自动化验证(本次已执行)
- **先复现,再动手**(用一个只驱动真实 `app.js`、合成真实 `Enter` 按键的临时页面):断言
  `/models` 在命令面板里确实存在、选中只把 `/models ` 补进输入框、再按 `Enter` 之后
  **对话框数 = 0、网络请求数 = 0、`#cmds` 已关**,唯一的可观测副作用是焦点落到 `#modelSel`。
  还量了一下:那个 `<select>` 有 2 个 `<option>`,但 `focus()` 不会展开它 —— 这就是用户看到的「没反应」。
  同一份里也确认了本机 Firefox **有** `HTMLSelectElement.prototype.showPicker`,但因为它依赖版本与用户手势、
  失败时又退回「什么都没发生」,没有采用。
- 冒烟 `test/smoke.sh`:**100 项全部通过**(92 → +8,仍是**静态**断言):
  对话框四个节点(`#dlgPick`/`#pickList`/`#pickTitle`/`#pickFilter`)、
  `.picklist`/`.pick-item`/`.pick-group` 三处样式、14 个函数齐全(用 `has` 逐个查,不用 `grep -q` 管道 ——
  这个仓库里那个管道有 SIGPIPE 假红的前科)、**`focusEl` 这个旧做法已经不在了**、
  三条命令都接到选择框(用 python 在 `PANEL_COMMANDS` 切片里逐条对 `openSessionPick()`/`openModelPick()`/`openAgentPick()`)、
  `init()` 里接上了 `setupPick()`,以及两个新测试文件都在。
- 浏览器内断言 `test/ui-picks-run.js`:**87 项全部通过**(真实 `public/app.js`,无头 Firefox):
  - 通用选择框:标题、`current` 默认高亮、`current` 不在列表里时停在第一条、`filter=false` 藏过滤框 /
    `filter=true` 露出来并清空、分组标题每组只出现一次、`sub` 落进 `.pi-sub`、无匹配给空态且不崩高亮。
  - 过滤:`label` 与 `sub` 都参与、大小写不敏感、纯空白等于没过滤、无匹配返回空数组。
  - 键位:↑/↓ 环绕、方向键与 `Enter` 都 `preventDefault`、不认识的键不管、框关着时不管、
    空列表不吞键、**点「关闭」按钮的 `Enter` 不抢**。
  - 选中:回调拿到 key、**关框之后才回调**、`disabled` 项点不动。
  - 接线:过滤框输入即过滤、换查询词把高亮归位到第一条、**过滤框里 ↓ 交给选择框**、
    点条目选中、关掉后焦点回输入框。
  - `/sessions`:列的就是左栏那批且同序(与 `visibleSessions()` 逐项对齐)、标题作主文案、副文案含目录名、
    当前会话高亮、打开「显示已归档」后也在、按顶部排序走(`asc` 时反过来)、选中即真的切过去。
  - `/models`:按 provider 分组、`key`/`label`/`sub` 的来源、当前模型高亮、当前模型不在列表里时补一条「当前」、
    有变体就追问且当前档位高亮、选档位带 `variant`、选「默认」不带 `variant`、
    没有变体就直接切、换模型后追问的是**新模型**的变体、空 key 只提示不发请求、
    列表里没有的 key 也能按 `providerID/modelID` 拆开。
  - `/agents`:`hidden` 与 `subagent` 都被滤掉、`label`/`sub` 来源、当前智能体高亮、
    **不提供「默认」空选项**、选中即切、当前智能体不在列表里时补一条。
  - 没选中会话时三条都不开;三条面板命令仍在、说明已不再写「跳到…」;`focusEl` 已不存在。
  - 测试里踩到两处**自己的用例问题**,都改成了走真实路径(而不是调用内部函数):
    直接 `pickVariant()` 而不先 `pickChoose()` 会让上一个对话框还开着;
    以及「没选中会话就不开」前必须先把框关掉,否则断言的是上一轮的残留。
- 真实目检:`/tmp/ocsm-probe/picks-build.js` 用真实 `index.html`/`styles.css`/`app.js` + 真实形状的模型数据
  (6 个模型、3 个 provider、带 variants)渲染三张图 ——
  `/models`(分组小标题 + 模型名/`modelID` 两列 + 当前项高亮 + 过滤框)、
  选完模型后追问的档位列表(标题带上模型名、无过滤框)、
  `/sessions`(与左栏同源的标题 + 目录名 + 相对时间)。三张都对。
- 全套复跑:**10 套 UI + 6 套 e2e 全绿**(计数见 README)。这里最关键的是 `ui-controls` 的 83 项 ——
  `switchModel()` 被改成了 `applyModel()` 的薄封装,那套断言正好盯的就是「工具栏换模型/变体发什么请求」。

### 「完整命令名 + Enter 直接执行」的验证(本次已执行)
- **浏览器内断言** `test/ui-commands-run.js` 加到 **155 项**(148 → +7)全部通过:
  `/models` 一下就到选择框、面板已关、输入框被清空(没有停在 `/models ` 等第二下);
  只敲 `/mod` 时 `Enter` 仍然只是补全成 `/models ` 且**没有真的执行**;
  在 `/re` 里用 `↓` 把高亮移到另一个命令上时,`Enter` 补全成**那个**命令而不是执行输入框里的名字。
- **冒烟** 100 → **101** 项:`exactCommand` 存在且 `commandKey` 的 `Enter` 分支真的调它。
- **真实端到端(最有说服力的一次)**:把真实 `server.js` + `public/` 拷到 `/tmp` 起一个不带密码的实例,
  用无头 Firefox 打开**真实面板页面**(带 `#会话id` hash 直接落地到那个会话),
  **逐字符**敲 `/models`(每个字符发一个 `input`,和真人打字同一条代码路径),然后**只按一次 `Enter`**:
  ```
  PASS 真实会话已选中(hash 落地)
  PASS 真实模型表已加载
  PASS 敲 /models 之后命令面板开着
  PASS 面板里高亮的是 /models
  PASS 只按一次 Enter 就弹出模型选择框(不用按第二次)
  PASS 输入框已清空(没有停在 /models 等下一发)
  PASS 标题是「选择模型」
  PASS 列出真实模型且按 provider 分组
  PASS 当前模型被高亮
  PASS 在选择框里按 Enter → 真的 POST …/model
  PASS 选择框关掉了
  PASS 焦点回到输入框
  PASS 服务端回来之后会话的 model 真的变了
  ```
  ```
  选中前 model: {'id': 'deepseek-v4-flash', 'providerID': 'company', 'variant': 'default'}
  选中后 model: {'id': 'longcat-2.5-preview-free', 'providerID': 'opencode', 'variant': 'default'}
  ```
  14 项全 PASS,而且**服务端的会话模型真的被改掉了** —— 这是拿真实后端当裁判,不是只断言 DOM。
- 这次端到端踩到两个**环境**问题(都不影响结论,但值得记下来):
  ① 驱动脚本里正则字面量被模板字符串多转义了一层(`/\\/model$/` → 非法 flags),整个脚本不执行、
  页面一片安静地什么都不报 —— 换成 `endsWith('/model')` 就没有正则了;
  ② 上一次的临时实例没杀干净,`OCS_PORT` 被占用后服务自己改用了随机端口,于是浏览器打到了旧实例。
  收尾的清理必须按端口 `ss -lptn` 找 pid 杀,并且**别用 `pkill -f`/`pgrep -f` 去匹配带自己命令行
  的模式**(会把执行命令的 shell 一起杀掉,实测两次都是这么把自己坑死的)。
- 另外注意到一个**既有行为**(不是这次引入的):程序化给 `#input` 赋值不会触发 `input` 事件,
  所以命令面板不会因此打开;此时按 `Enter` 会直接走 `send()` 并正常执行命令。两条路都能跑通。

- 离线渲染核对(H1 专用):`/tmp/ocsm-probe/font-build.js` 用真实 `styles.css` + `app.js` 渲染
  真实用户消息 + 真实整条助手消息 + `write`/`bash` 工具卡片,并在页尾把每个关键选择器的
  `getComputedStyle().fontSize` **印成可见文字**(截图即可核对)。对照 `git show HEAD:public/styles.css` 的新旧两版:

  | 选择器 | 旧 | 新 | 倍数 |
  | --- | --- | --- | --- |
  | `#messages` 基准 / 用户正文 | 12.5px | 14px | ×1.12 |
  | 行内 code / fenced code | 11.5px | 11.85px | ×1.12 |
  | 角色名 / 工具状态 / 思考摘要 | 11px | 12.32px | ×1.12 |
  | 用量行 `.msg .meta` | 10px | 11.2px | ×1.12 |
  | `.diff` / `.dfile` / 思考正文 | 11.5px | 12.88px | ×1.12 |
  | `#chatTitle` / `#input` | 13px | 14px | ×1.08 |

  读数与「整块等比」的预期完全一致(输入框/标题原本基于 13px,故是 ×1.08 而不是 ×1.12 —— 见 H1 的换算说明)。
  中途踩到一个自查陷阱:第一次做「旧」版对照时用的 `styles.before.css` 是**改完变量之后**才复制的,
  于是「旧版」也显示 14px;改成 `git show HEAD:public/styles.css` 才拿到真正的基线。


- `test/smoke.sh` 原本靠 `printf '%s' "$X" | grep -q PAT` 做文本断言。在 `set -o pipefail` 下,`grep -q` 命中即退出,
  还在写的 `printf` 会收到 SIGPIPE,整条管道随机被判失败 —— 实测双 `grep` 链 **300 次里失败 1 次**,
  加上一次冒烟有二十来条这类断言,单次运行约百分之几的概率**假红**。本次把 styles.css 写长后撞上了一次,遂修:
  新增 `has()`(`case` 字面量匹配,不走管道、不把 `.` `(` `)` 当元字符),21 处断言全部改用它,
  并把 `grep -qF` / `\|` 交替 / `--` 结尾的写法一并归一。连跑 5 次冒烟 59/59 稳定。

## 9. 假设与待确认
- 默认端口 `49450`、工程位置 `~/tools/opencode-session-manager/` 是否合适?
- ~~事件流 v1 采用「事件触发重取」而非精细 delta,是否接受?~~ 已由 C 组升级为**增量驱动**(本地缓冲 + 权威版本对账);
  仍保留 150ms 防抖重取作为对账兜底,纯文本 delta 不再触发重取。
- ~~局域网其它机器能否访问取决于主机防火墙(ufw 放行 `49450/tcp` 需要 sudo,尚未核实)。~~
  **已确认可行**:使用者已从局域网内其它机器访问成功。
- **`metadata.diagnostics` 的精确形状是「从服务端 TUI 的用法反推」的假设**(`{<文件绝对路径>: [{range:{start:{line,character}}, message}]}`):
  本机实测里 `write`/`edit` 的 `diagnostics` 一直是空对象 `{}`(没触发过真实诊断),所以前端按「精确路径优先、相对/绝对宽松兜底」取值,
  取不到就不显示 —— 假设错了也不会报错,最多是不显示。若将来看到真实诊断,应补一条离线断言把它钉死。
- 刷新恢复的**时机**是个刻意的取舍:放在首次 `loadSessions()` 完成**之后**,为的是标题/工程目录不先闪一个 id。
  代价是列表与消息两次请求串行,刷新后的空白期比理论上略长(本机是几十毫秒量级)。
  若日后嫌慢,可改成「立刻 `selectSession` + 列表到达后再补标题」,代价是标题会短暂显示成 id。
- ~~G 组确认只持久化**选中的会话**,顶栏的搜索/工程目录/排序/显示已归档刷新后仍按原样重置。~~
  **已由 H4 推翻**:顶栏条件现在也持久化(hash 管「哪个会话」、localStorage 管「怎么筛」)。
  仍保留的区分是**存储载体**:列表折叠/列宽/顶栏条件用 `localStorage`(跨次启动都记得),
  会话内滚动位置用 `sessionStorage`(只属于本标签页,关掉即丢)。
- H3 的**还原时机**是刻意的取舍:只有刷新恢复才还原滚动位置,从列表点进会话仍跳到底部。
  理由是「点会话」的意图通常是看最新进展,而「刷新」的意图是接着读 —— 两者混在一起会让点击行为变得难以预期。
- H1 的字号**只给了变量,没给可拖动的滑块**:使用者可随时报一个新数值,改 `:root` 里一个数即可;
  等真出现「想按会话/按屏分别调」的需求再加控件。
- H6 的一个**刻意的取舍**:`@` 只在「补全里确认过」时才变成附件。理由是服务端在读到不存在的文件时会让整条 prompt `400`,
  而在浏览器侧无法可靠地判定任意路径是否存在(要么多一次探测请求、要么赌它存在)。代价是手打一个没走过补全的 `@路径` 不会带上附件;
  要带任意文件请用 📎 / 拖放 / 粘贴(它会把文件复制进暂存目录,不受工程目录范围限制)。
- H6 的暂存目录是一处**有意的「不持久」**:`$TMPDIR/opencode-session-manager-uploads` 里的文件只是为了让服务端能读到,
  消息里已经存了 base64,所以文件被 6 小时清理或 `/tmp` 被重启清空都不影响历史回看,也不会出现「附件链接失效」的观感问题。
  真需要长期保存原件,应在会话里让智能体把文件 `write` 进工程目录。
- I 组的 `Esc` **做成一下而不是两下**:这是按 TUI 的权威默认(`session.interrupt = escape`)来的。
  使用者最初感受到的「按两下才断」,实际是「第一下关掉了浮层」;把优先级写清楚(浮层 → 中断)之后,「按一下该关什么」就是确定的。
- I 组开头**先实测再实现**这一步,直接消掉了一类会白写的功能:TUI 的 `/new` `/sessions` `/models` `/help` `/exit`
  在服务端**没有**任何 command 端点(`GET /api/command` 只给 `init`/`review` 与工程里的自定义命令)。
  如果不先查,很容易做出一个「列表里有、点了报 404」的 `/new`。现在的分工是:**服务端真有的走服务端,其余一律由面板自己实现**,
  并且同名时以服务端为准。
- 面板动作里**只有 `/undo` `/redo` 会动到工作区**:`revert/stage` 带 `files: true`,和 TUI 的 undo 一样会还原该轮的文件改动,
  所以加了二次确认;会话忙时服务端回 `409`,面板**先拦住**并提示「正在运行」而不是去撞墙。
  `DELETE /revert`(redo)在没有已暂存撤销时同样回 `409`,面板把它译成「没有可重做的撤销」——
  这是**空操作而不是错误**(TUI 里同样是空操作),所以不该弹红。
- I 组的键位**只做浏览器拦得住的**:`Ctrl+T`/`Ctrl+N`/`Ctrl+W`/`Ctrl+L` 由浏览器保留,`preventDefault` 无效;
  硬做出来只会变成「按了没反应」的假键位,所以明确不做(`Ctrl+P` 可以拦,才采用)。
- I 组的输入历史**只在光标位于首行/末行时接管**:`↑`/`↓` 在多行输入里的第一职责是移动光标,
  这一点与 TUI 的 `input.move.*` 和 `prompt.history.*` 抢占同一个键、由上下文决定谁生效是同一套逻辑。
  历史按会话隔离(而不是全局一份),换会话不会把上一条会话的输入捞出来。
- 选择框这次**先复现再改**,把一个原本会归到「玄学」的问题定成了明确结论:
  `/models` 之所以「没反应」,不是命令没注册、也不是缓存没刷新,而是**落地动作选错了** ——
  给原生 `<select>` 聚焦不会展开它。复现的价值在于它同时排除了旁边三种猜测(命令缺失、面板没关、请求没发),
  省掉了「先怀疑一圈、再逐个试」的时间。**「报一个 UI 行为不对」的第一件事是把那一步的实际副作用量出来**,
  而不是先读代码猜。
- 选择框**用一个通用件而不是三个对话框**:三条命令的差异只在「数据怎么装配 + 选中之后干什么」,
  交互(列表/过滤/键位/高亮/点选)完全一样。写成三个的话,过滤或键位以后改一次要改三处,
  三处迟早不一致;现在的代价只是 `items` 的形状约定需要一点点文档(就是这段)。
- 选择框里**「先关框再回调」是个刻意的顺序**:`/models` 选完模型要接着问档位。
  如果先回调、后关框,就会出现两个 `<dialog>` 叠在一起(第二个 `showModal` 会盖住第一个,
  关掉第二个时第一个又露出来)。把这层顺序收进 `pickChoose()` 而不是让每个调用点自己记得。
- **删掉 `focusEl()` 而不是留着**:它此后没有任何调用者。「留着以后可能有用」在这里是负收益 ——
  它恰好就是这次 bug 的形态(看着像干了活、其实什么都没发生),留着只会让人再踩一次。
  冒烟里加了一条「`focusEl` 不许回来」的断言把这个决定钉住。
- `/sessions` 的列表**故意只列左栏当前那批**,不去翻完所有分页。好处是它永远和左栏一致
  (同一套筛选、同一套排序,共用 `visibleSessions()`),代价是会话特别多、还没点过「加载更多」时,
  选择框里也看不到更早的那些。这与面板整体「一次 50 条、按需翻页」的设定一致,不单独为这个对话框破例。
- **没有采用 `select.showPicker()`**(本机 Firefox 确实有它):它要求用户手势、可用的浏览器版本也不齐,
  而且它失败时抛错/静默的两种表现都回到「什么都没发生」——正好是这次要修的病。
  自己画一个列表虽然多一点代码,但行为在任何浏览器上一致,而且**可以被无头测试断言**。
- **「完整命令名 + Enter 直接执行」是对早期决定的一次有意识推翻**:I 组定的是「和 TUI 一样,
  补全之后还要再按一次 Enter 才发出」,而使用者的体感是这一下纯摩擦(`Edge` 上敲 `/models` 要两下才出模型列表)。
  现在规则是「**敲完了就跑,没敲完就补**」。留住的边界:前缀(没敲完)一律只补全;
  `Tab` 永远只补全;高亮停在别的命令上时补全的是那个命令 —— 这三条是防止「想接着打参数 / 想补全到另一个命令」
  被误判成执行。取舍上它**不再与 TUI 逐键一致**,换来的是「命令名就是回车键」的肌肉记忆。
- 这一改**顺带消掉了一类歧义**:以前「`Enter` 在命令面板里」同时可能是「补全」也可能是「补完之后再发」,
  取决于输入框里有没有多余空格。现在判据只有一个 —— `输入框 === '/' + 高亮项.name`,没有第二种读法。
