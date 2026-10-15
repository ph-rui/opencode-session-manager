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

- 跨工程列出会话,按更新时间排序,游标翻页
- 按标题搜索(服务端 `search`)
- 按工程目录过滤(服务端 `directory`)
- 管理动作:重命名、删除、移动到其它工程目录、分叉
- 点击会话打开对话:加载历史消息、发送消息、`/api/event` SSE 实时刷新
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
  - **网页内新建会话**:左栏「+ 新建」,填工程目录(绝对路径)可选标题 / 智能体 / 模型(含变体),创建后自动打开
  - **归档**:列表与聊天头部可归档 / 取消归档,默认从列表隐藏,左栏「显示已归档」可查看(记录在 `session.metadata`,见下文说明)
  - **导出 / 导入**:导出会话为 JSON(可选脱敏),或从 JSON 导入为新会话并指定目标工程目录
  - **深链跳回 TUI**:给出 `opencode --session <id> <目录>`,可直接粘到终端继续同一会话

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

## 尚未实现(v2+ 剩余项)

文件附件;以及事件增量驱动的逐 token 流式渲染(目前仍是「事件触发重取消息」)。

## 测试

前置:OpenCode 服务已运行,且本代理已启动。凭据从 `~/.config/opencode-session-manager/env` 读取(可用 `OCS_AUTH` 覆盖)。

```bash
bash test/smoke.sh            # 代理层:健康检查/静态托管/鉴权注入/SSE/密码不外泄/问询·控制·能力扩展端点与控件
bash test/e2e-asks.sh         # 问询端到端(纯 curl):创建表单→应答/取消→状态核对→负例
bash test/e2e-controls.sh     # 会话控制端到端(纯 curl):agent/model 切换、中断、inbox 改投递/取消
OCS_E2E_LLM=1 bash test/e2e-controls.sh   # 追加真实运行中的 queue/steer/interrupt 用例(会消耗一次很小的模型调用)
bash test/e2e-capabilities.sh # 能力扩展端到端(纯 curl):新建→归档→导出→导入(含 409/400 负例)→清理
node test/ui-asks-run.js      # 问询前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-controls-run.js  # 会话控制前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-capabilities-run.js  # 能力扩展前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
```

- `smoke.sh`:35 项。
- `e2e-asks.sh`:13 项。会创建一个临时会话并在结束时删除;验证 `list` 不含 `state`、未激活字段/未确认 `external` 被拒 `400`、正常应答 `204` 且答案一致、重复应答 `409`、取消 `204`。
- `e2e-controls.sh`:22 项(开 `OCS_E2E_LLM=1` 为 31 项)。同样只用临时会话;验证 agent/model 切换持久化、`model` 缺字段 `400`、空闲中断 `interrupted=false`、inbox 负例,以及(可选)真实运行中的 `queue` 投递、改投递、取消、中断。
- `e2e-capabilities.sh`:26 项。只用临时会话与 `/tmp` 临时目录,结束时全部删除;验证新建的字段落库、`PATCH metadata` 的整体替换语义、导出脱敏与否、导入的换 ID 与 `location` 重挂、以及 `409`/`400` 负例。
- `ui-asks-run.js`:39 项浏览器内断言(真实 `public/app.js`),覆盖字段渲染、默认值预填、`when` 显隐、单选+自填互斥、答案组装、本地校验分支、非 http(s) 链接不可点击。
- `ui-controls-run.js`:83 项浏览器内断言,覆盖 agent/model 选择器的过滤与分组、切换请求体、变体显隐、中断/投递控件的显隐、运行状态文案与列表标记、待发送队列渲染与操作请求、发送时的 `delivery` 选择、事件到运行状态的映射。
- `ui-capabilities-run.js`:71 项浏览器内断言,覆盖归档判定与列表过滤、归档请求体的读-改-写、新建/导入的本地校验与请求体形状、`409` 重试、导出 URL 与下载内容、`tuiCommand` 的引号转义。

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
