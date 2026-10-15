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
- 渲染升级:直接消费事件里的 part 增量,做逐 token 流式与增量合并。
- 能力扩展:网页内新建会话、归档、导入导出、深链跳回 TUI。

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
- [ ] 输入并发送消息后,能流式看到助手回复刷新。
- [ ] 停掉 OpenCode 服务时,页面给出清晰错误提示而非白屏。
- [ ] 触发一次 `question` 工具问询:底部出现卡片,提交后助手继续;列表徽标消失。
- [ ] 触发一次需批准的权限请求(需在配置里把某动作设为 `ask`):三个按钮可用,应答后工具继续。
- [ ] 助手运行中:标题栏显示 `● 运行中`,输入区出现「排队/插话」与「■ 中断」;点中断后回到空闲。
- [ ] 运行中发送消息选「排队」:消息进入待发送队列(不立刻出现在消息流),回合结束后自动执行;选「插话」则立即并入当前回合。
- [ ] 待发送项可「改为排队/改为插话」与「取消」,操作后队列即时刷新。
- [ ] 切换智能体/模型后,重新打开该会话仍显示新值(已持久化)。

### 问询应答的自动化验证(本次已执行)
- 浏览器内断言 36 项(`/tmp/ocsm-probe/asks-unit*.html`,真实 `app.js`):字段渲染、默认值预填、`when` 显隐、单选+自填互斥、答案组装与本地校验(含 `external`、数值范围、`minItems/maxItems`、`minLength`、`email/uri`)。
- 端到端 11 项(经面板代理,`/tmp/ocsm-probe/e2e-forms.sh`):真实创建表单 → 列表可见(`Form.Info` 无 `state`)→ 提交未激活字段被拒 `400` → `external` 未确认被拒 `400` → 正常应答 `204` 且服务端保存答案与提交一致 → `detail` 为 `answered` → 取消 `204` 且为 `cancelled`。
- 权限应答路由经代理可达(已处理/不存在 → `404`);`permission.asked` 的真实出现取决于本机权限策略,当前全部 `allow`,故留作手动验收。

### 会话控制的自动化验证(本次已执行)
- 端到端 `test/e2e-controls.sh`(22 项;`OCS_E2E_LLM=1` 时 31 项,全部通过):agent 切到 `plan`/`build` 并核对持久化;`model` 缺 `providerID` 被拒 `400`、正常切换 `204` 且持久化;空闲中断 `interrupted=false`;未知会话的 `interrupt`/`inbox` 均 `404`;`synthetic` 项被前端规则过滤;`inbox` 改投递方式与取消的负例(`409`/`204`);真实运行中 `queue` 投递→队列可见→改 `steer`→取消→`interrupt` 返回 `true` 且回到空闲。
- 浏览器内断言 `test/ui-controls-run.js`(77 项,真实 `public/app.js`,无头 Firefox):agent/model 选择器的过滤与分组、变体显隐、切换请求体形状、中断/投递控件显隐、运行状态文案与列表标记、待发送队列渲染与 PATCH/DELETE 请求、发送时的 `delivery` 选择、事件→运行状态映射。
- 离线渲染核对:`/tmp/ocsm-probe/controls-preview.html`(真实 `app.js` + `styles.css` + 假数据)在运行中与空闲两种状态下的截图,确认工具栏、待发送队列与提示条不遮挡输入框。

## 9. 假设与待确认
- 默认端口 `49450`、工程位置 `~/tools/opencode-session-manager/` 是否合适?
- 事件流 v1 采用「事件触发重取」而非精细 delta,是否接受?
