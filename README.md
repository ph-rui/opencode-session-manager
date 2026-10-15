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
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | 用于读取 `service.json` 中的密码 |

## 功能

- 跨工程列出会话,按更新时间排序,游标翻页
- 按标题搜索(服务端 `search`)
- 按工程目录过滤(服务端 `directory`)
- 管理动作:重命名、删除、移动到其它工程目录、分叉
- 点击会话打开对话:加载历史消息、发送消息、`/api/event` SSE 实时刷新

## v1 非目标

权限/表单应答、中断 / steer、切换 model·agent、文件附件、网页新建会话、归档、导入导出。

## 测试

前置:OpenCode 服务已运行,且本代理已启动。

```bash
bash test/smoke.sh
```

验证:健康检查、静态托管、鉴权注入、直连 401 对比、SSE 透传、密码不外泄。

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
