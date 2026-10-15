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
- **对话(`#chatpane`,占满剩余)**:消息列表(终端风:等宽、无气泡、角色色条+标记;user/assistant/tool 渲染)、底部输入框+发送、顶部显示标题/工程/状态(运行中·空闲)并自动滚动到底部。
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
  - **本轮明确不做**:顶栏筛选/排序/搜索的持久化(按确认只记会话)、`hashchange` 的前后退同步、
    折叠动画、会话内滚动位置的恢复(刷新后停在最新消息,与「打开会话」一致)。

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
- [ ] 运行中发送消息选「排队」:消息进入待发送队列(不立刻出现在消息流),回合结束后自动执行;选「插话」则立即并入当前回合。
- [ ] 待发送项可「改为排队/改为插话」与「取消」,操作后队列即时刷新。
- [ ] 切换智能体/模型后,重新打开该会话仍显示新值(已持久化)。
- [ ] 顶栏「+ 新建」填绝对路径目录后能建出会话并自动打开;留空目录或填相对路径会就地报错。
- [ ] 列表「归档」后该会话从列表消失,顶栏提示「另 N 个已归档」;勾选「显示已归档」可见 `📦 已归档` 行并能「取消归档」。
- [ ] 聊天头部「导出」下载 JSON;「在 TUI 打开」给出的命令粘到终端能进入同一会话。
- [ ] 顶栏「导入」选择导出得到的 JSON,指定目标目录后导入成功并自动打开(消息完整)。

### 问询应答的自动化验证(本次已执行)
- 浏览器内断言 36 项(`/tmp/ocsm-probe/asks-unit*.html`,真实 `app.js`):字段渲染、默认值预填、`when` 显隐、单选+自填互斥、答案组装与本地校验(含 `external`、数值范围、`minItems/maxItems`、`minLength`、`email/uri`)。
- 端到端 11 项(经面板代理,`/tmp/ocsm-probe/e2e-forms.sh`):真实创建表单 → 列表可见(`Form.Info` 无 `state`)→ 提交未激活字段被拒 `400` → `external` 未确认被拒 `400` → 正常应答 `204` 且服务端保存答案与提交一致 → `detail` 为 `answered` → 取消 `204` 且为 `cancelled`。
- 权限应答路由经代理可达(已处理/不存在 → `404`);`permission.asked` 的真实出现取决于本机权限策略,当前全部 `allow`,故留作手动验收。

### 会话控制的自动化验证(本次已执行)
- 端到端 `test/e2e-controls.sh`(22 项;`OCS_E2E_LLM=1` 时 31 项,全部通过):agent 切到 `plan`/`build` 并核对持久化;`model` 缺 `providerID` 被拒 `400`、正常切换 `204` 且持久化;空闲中断 `interrupted=false`;未知会话的 `interrupt`/`inbox` 均 `404`;`synthetic` 项被前端规则过滤;`inbox` 改投递方式与取消的负例(`409`/`204`);真实运行中 `queue` 投递→队列可见→改 `steer`→取消→`interrupt` 返回 `true` 且回到空闲。
- 浏览器内断言 `test/ui-controls-run.js`(77 项,真实 `public/app.js`,无头 Firefox):agent/model 选择器的过滤与分组、变体显隐、切换请求体形状、中断/投递控件显隐、运行状态文案与列表标记、待发送队列渲染与 PATCH/DELETE 请求、发送时的 `delivery` 选择、事件→运行状态映射。
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

### 测试脚本自身的缺陷修复(本次顺带)
- `test/smoke.sh` 原本靠 `printf '%s' "$X" | grep -q PAT` 做文本断言。在 `set -o pipefail` 下,`grep -q` 命中即退出,
  还在写的 `printf` 会收到 SIGPIPE,整条管道随机被判失败 —— 实测双 `grep` 链 **300 次里失败 1 次**,
  加上一次冒烟有二十来条这类断言,单次运行约百分之几的概率**假红**。本次把 styles.css 写长后撞上了一次,遂修:
  新增 `has()`(`case` 字面量匹配,不走管道、不把 `.` `(` `)` 当元字符),21 处断言全部改用它,
  并把 `grep -qF` / `\|` 交替 / `--` 结尾的写法一并归一。连跑 5 次冒烟 59/59 稳定。

## 9. 假设与待确认
- 默认端口 `49450`、工程位置 `~/tools/opencode-session-manager/` 是否合适?
- ~~事件流 v1 采用「事件触发重取」而非精细 delta,是否接受?~~ 已由 C 组升级为**增量驱动**(本地缓冲 + 权威版本对账);
  仍保留 150ms 防抖重取作为对账兜底,纯文本 delta 不再触发重取。
- 局域网其它机器能否访问取决于主机防火墙(ufw 放行 `49450/tcp` 需要 sudo,尚未核实)。
- **`metadata.diagnostics` 的精确形状是「从服务端 TUI 的用法反推」的假设**(`{<文件绝对路径>: [{range:{start:{line,character}}, message}]}`):
  本机实测里 `write`/`edit` 的 `diagnostics` 一直是空对象 `{}`(没触发过真实诊断),所以前端按「精确路径优先、相对/绝对宽松兜底」取值,
  取不到就不显示 —— 假设错了也不会报错,最多是不显示。若将来看到真实诊断,应补一条离线断言把它钉死。
- 刷新恢复的**时机**是个刻意的取舍:放在首次 `loadSessions()` 完成**之后**,为的是标题/工程目录不先闪一个 id。
  代价是列表与消息两次请求串行,刷新后的空白期比理论上略长(本机是几十毫秒量级)。
  若日后嫌慢,可改成「立刻 `selectSession` + 列表到达后再补标题」,代价是标题会短暂显示成 id。
- G 组确认只持久化**选中的会话**,顶栏的搜索/工程目录/排序/显示已归档刷新后仍按原样重置(已与使用者确认)。
