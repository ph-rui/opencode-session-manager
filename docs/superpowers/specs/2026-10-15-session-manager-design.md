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
2. **前端(`public/index.html` + `app.js` + `styles.css`)** — 单页应用,三栏布局,无框架、无构建。

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
- **左栏(过滤)**:搜索框(→ `search`)、工程目录过滤(→ `directory`,下拉项来自会话 `location.directory` 去重)、排序(updated/created)、刷新按钮。
- **中栏(会话表)**:列 = 标题 / 工程目录(截断显示 + `title` 悬浮全路径) / 更新时间(相对) / tokens / cost / 行内操作(改名、删除、移动、分叉、打开)。点击行=打开。
- **右栏(对话)**:消息列表(user 右侧气泡;assistant 渲染 `text`;`reasoning` 可折叠;`tool` 显示名称+状态)、底部输入框+发送、顶部显示标题/工程/状态(运行中·空闲)并自动滚动到底部。

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

## 8. 测试

### 后端冒烟(`test/smoke.sh`,需运行中的 OpenCode 服务)
- `GET /__health` → 200 且含 base URL。
- `GET /api/session?limit=1` → 经代理返回 200 JSON(证明 Basic 注入成功)。
- 直连 OpenCode 无鉴权 → 401;经代理 → 200(证明鉴权只在代理侧)。
- 经代理订阅 `/api/event`,约 2s 内收到 `server.connected`。
- 断言任何发给浏览器的响应体 / 头中**不含** password。

### 前端手动验收清单
- [ ] 列表能同时看到多个工程目录下的会话,并按更新时间倒序。
- [ ] 搜索关键字能过滤;选择工程目录能只显示该工程会话。
- [ ] 改名后标题即时更新。
- [ ] 移动到新目录后,该会话的工程目录更新。
- [ ] 删除后会话从列表消失。
- [ ] 打开会话能看到历史消息(user/assistant/tool 渲染正确)。
- [ ] 输入并发送消息后,能逐字看到助手回复流出(Markdown 实时重排、末尾有闪烁光标、标题行有「输出中」徽标)。
- [ ] 流式期间思考块自动展开并逐字增长;回合结束后回落成折叠态(`▸ 思考`)。
- [ ] 助手调用工具时,工具卡片在参数流式阶段就出现,状态由「运行中」变为「已完成」并展示输出。
- [ ] 回复落地后与流式过程看到的内容一致,消息不重复、不闪回(本地缓冲被服务端权威版本替换)。
- [ ] 停掉 OpenCode 服务时,页面给出清晰错误提示而非白屏。
- [ ] 触发一次 `question` 工具问询:底部出现卡片,提交后助手继续;列表徽标消失。
- [ ] 触发一次需批准的权限请求(需在配置里把某动作设为 `ask`):三个按钮可用,应答后工具继续。
- [ ] 助手运行中:标题栏显示 `● 运行中`,输入区出现「排队/插话」与「■ 中断」;点中断后回到空闲。
- [ ] 运行中发送消息选「排队」:消息进入待发送队列(不立刻出现在消息流),回合结束后自动执行;选「插话」则立即并入当前回合。
- [ ] 待发送项可「改为排队/改为插话」与「取消」,操作后队列即时刷新。
- [ ] 切换智能体/模型后,重新打开该会话仍显示新值(已持久化)。
- [ ] 左栏「+ 新建」填绝对路径目录后能建出会话并自动打开;留空目录或填相对路径会就地报错。
- [ ] 列表「归档」后该会话从列表消失,左栏提示「另 N 个已归档」;勾选「显示已归档」可见 `📦 已归档` 行并能「取消归档」。
- [ ] 聊天头部「导出」下载 JSON;「在 TUI 打开」给出的命令粘到终端能进入同一会话。
- [ ] 左栏「导入」选择导出得到的 JSON,指定目标目录后导入成功并自动打开(消息完整)。

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
  确认左栏工具行、归档标记、聊天头部操作区与四个对话框的布局;长目录路径在「在 TUI 打开」里折行完整可见。

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

## 9. 假设与待确认
- 默认端口 `49450`、工程位置 `~/tools/opencode-session-manager/` 是否合适?
- ~~事件流 v1 采用「事件触发重取」而非精细 delta,是否接受?~~ 已由 C 组升级为**增量驱动**(本地缓冲 + 权威版本对账);
  仍保留 150ms 防抖重取作为对账兜底,纯文本 delta 不再触发重取。
- 局域网其它机器能否访问取决于主机防火墙(ufw 放行 `49450/tcp` 需要 sudo,尚未核实)。
