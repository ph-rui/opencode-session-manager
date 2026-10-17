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
| `OCS_ALLOW` | `127.0.0.0/8,::1` | 来源地址白名单,逗号分隔。支持 `IPv4` / `IPv4/掩码` / `IPv6` / `IPv6/掩码`;`::ffff:1.2.3.4` 会先还原成 `1.2.3.4` 再比对。**空值 = 不限制**;**配了却一条都解析不出来 = 一律拒绝**(见下) |
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

## 来源地址白名单(`OCS_ALLOW`)

`OCS_HOST=0.0.0.0` 是「全网卡监听」,收不回来 —— 绑到某个具体网卡会让本机
`127.0.0.1` 一起断掉(日常桌面使用就没了),而且网卡没起来时会 `EADDRNOTAVAIL`
起不来。所以**收窄可达面这一步放在应用层**:请求入口先看来源地址,不在白名单里直接 `403`。

```bash
# env 文件里(推荐)
OCS_ALLOW=127.0.0.0/8,::1,198.51.100.0/24
```

- **默认值**是 `127.0.0.0/8,::1`(回环 + VPN 网段);办公室/家里走内网的,
  照上面那样把你实际用的网段**显式写进 env**
- **不设** = 用默认值;**设成空串** = 不限制;**设了但一条都解析不出来** = **一律拒绝**
  (fail closed),启动时会打一行警告。宁可打不开(报错里会写清楚原因),也不要静悄悄全放开
- 校验发生在**鉴权之前** —— 来源不对连 `401` 都不给
- 被挡下来时会直接告诉你原因,不用去翻服务端日志:

  ```
  来源地址不允许 / source address not allowed
  来源: 198.51.100.48
  白名单: 127.0.0.0/8,::1
  ```

  服务端同时打一行 `拒绝来源地址: 198.51.100.48(白名单: …)`。

> 踩过的坑:`OCS_HOST=0.0.0.0` 开着、`OCS_ALLOW` 没写,于是走办公内网
> (`198.51.100.0/24`)的浏览器全被默认值挡在 `403` 外。修法不是改代码默认值,
> 而是在 env 里显式声明你实际用的网段 —— 默认值保守,实际网段由部署处说了算。

## 手机端(窄屏)

**在手机上打开 `http://<本机IP>:49450` 就能用**,同一份页面自动切成手机布局,
不需要装 App、不需要 PWA。判定条件是
`(max-width:860px)` 或 `(max-height:560px) and (pointer:coarse)` ——
两条是**或**关系,后者专治「手机横屏时布局宽 894px、宽度断点根本不命中」的情况。
另外视口很矮(≤560px)时会给 `<html>` 再加一个 `short`,把顶栏压成一行。

布局变化:

| 桌面 | 手机 |
|---|---|
| 左列表 + 右对话(可拖动分栏) | **一屏一个**:列表 ↔ 对话,对话左上角「‹ 会话」返回 |
| 表格 6 列 | **卡片行**:标题 + 状态徽章一行,`目录 · 时间 · tokens` 一行 |
| 每行 6 个动作按钮 | 收进右上角「**⋯**」,点开复用现成的选择框 |
| 顶栏所有筛选控件 | 只留短标题 / 搜索 / `+ 新建` / 状态,其余点「**筛选**」就地展开 |
| 顶栏整条(111px) | **进了会话就整条收掉**(回列表自己回来,§8.43);标题下面那行「更新 … · 项目号」也收掉,只把**上下文用量**留在标题行末尾 |
| 分栏条 + 折叠手柄 | 隐掉(单栏了,不需要) |
| 底部输入区(智能体/模型/变体 + 输入框) | **默认收起成一条细边**,点它右上角「▴ 输入」拉回来 |

- **手机上没 Esc 键**:中断走输入框边上的「**■ 中断**」按钮;命令面板 / `@` 补全 / 中断的
  Esc 优先级是桌面才有的东西
- **返回列表会取消选中该会话**(和桌面「选中一直留着」不同)。换来的是**安卓返回手势
  免费可用**:返回 = 回到列表,再返回 = 退出页面,不用自己接历史栈
- 深链可用:直接打开 `http://<IP>:49450/#ses_xxx` 就落在该会话的对话区
- **会话标签栏**(§8.59):聊天区顶部一条可横向滑的 tab,打开过的会话自动进来;左上「‹ 会话」照旧回列表,标签栏只活在对话区里。竖屏 34px、横屏 30px,当前 tab 才露 `×`,少一排小叉
- 手指按得准:可点控件高度 ≥ 44px,输入类控件字号 ≥ 16px(防浏览器聚焦时自动放大整页)
- 键盘:视口加了 `interactive-widget=resizes-content`,安卓弹键盘时压缩视口,
  输入框和发送键不会被顶出屏幕
- 附件照旧:📎 会弹安卓的文件/相册选择器
- **底部输入区默认收起**:一进会话只剩一条细边,高度全给会话内容(393×894 上从约 130px 收到 48px)。
  点细边右上角的「**▴ 输入**」展开 —— 展开即聚焦输入框,弹出来的键盘正好用来回一句;
  运行中细边上留着「**■ 中断**」(它是运行中唯一不能藏的东西);
  细边左侧还会提醒你输入框里压着「● 草稿」、挂着「📎 n」个附件,免得以为字被收没了
- 收起状态**桌面 / 手机各记一份**(`ocs.composerHidden` / `ocs.composerHiddenNarrow`):手机上收起不影响桌面,
  桌面首次打开仍是展开(键盘打字是主要入口);转屏跨过断点各读各的那一份
- 收起时**把文件拖进来会自动展开**,不用先去点手柄;粘贴则要先展开才收得到 ——
  收起时输入框是 `display:none`,粘贴事件根本落不到它上面,所以那条没挂钩子

> 窄屏样式全部挂在 `html.narrow` 前缀下,**没有第二份 `@media` 断点** ——
> 判定源只有 `<head>` 里那一句内联脚本,桌面渲染结果因此一个像素不变。

## 功能

- **顶栏集中所有控件**:搜索 / 工程目录过滤 / 排序 / `+ 新建` / 导入 / 刷新 / 显示已归档 / 会话计数都在顶部栏,窄屏自动折行;左栏整栏已移除,会话表独占腾出的宽度
- **最近会话标签栏**(§8.59):聊天区顶部一条横向 tab(左列表照旧保留),打开过的会话自动进来;点 tab 直切,`×` 只移出 tab(**不归档、不删除**),关掉当前 tab 自动切右邻居、没有就左邻居;最右 `+ 新建` 复用现有新建框;最多 8 个、按打开顺序、存 `localStorage['ocs.tabs']`;手机竖屏/横屏都显示(竖屏 34px、横屏 30px),可横向滑;没有 tab 时整条收起来,一个像素都不占
- **会话列表整列可收起**:分栏条顶部的小手柄一键收起,收起后对话区占满整宽;状态记在本地,刷新后保持。**收起之后鼠标靠到左边缘会临时把列表拉出来看一眼**(带一道轻阴影),移开自动收回 —— 记忆不动,只有点手柄才算真的展开
- **底部输入区可收起**:底板上沿右侧的小手柄一键收起/展开,收起后只剩一条细边(运行中留「■ 中断」,有草稿/附件时在细边上提示);收起时手柄绝不消失,随时点得回来。状态桌面与手机各记一份
- **刷新后回到刚才的会话**:选中的会话写进 URL hash(`#ses_xxx`),刷新 / 复制链接 / 书签 / 换标签打开都会落到同一会话
- **浏览器前进 / 后退能在会话之间走**:点会话进历史栈(后退回上一个,前进回下一个);退到打开面板那一格则回到「未选择会话」的空态
- **刷新后回到会话里读到的位置**:滚动位置按「顶部可见的消息 + 偏移」记在 `sessionStorage`,刷新回到原处,而不是一律跳到最新
- **往上翻过头了一键回最新**:不在底部时消息区右下角露出「**跳到最新 ↓**」(对应 TUI 的 `Jump to latest`),点它或按 `End` 回底;在底部时它自己收起来,不占地方。它和「新内容自动跟随」共用同一个「在不在底部」判定(80px),所以不会出现「明明跟着跳了按钮还杵着」;增量重绘(流式文本、压缩正文)只读这个判定的缓存,不每个 delta 去读一次 `scrollHeight` + 强制整篇重排(见移动端设计 §8.16)
- **长会话里看不见的消息不参与排版**:条数 ≥ 30 的会话会给消息区挂上 `.cvmany`,离屏的 `.msg` 走 `content-visibility: auto` 整块跳过渲染 —— 那次「改完消息区再读 `scrollHeight`」的强制同步排版是长会话里最贵的一步(100 条消息实测 24~36ms → 0ms),进度条 / spinner / 流式 delta 每次都要吃它。短会话不挂:省不下几个钱,却要拿估值高度去占位(见移动端设计 §8.16)
- **切 diff 视图只重画正文**:并排 / 统一切换只替换每张卡片里的 `.diffwrap`,不重造 summary、诊断块和 `details`;展开状态、正文自己的滚动位置与切换按钮的焦点都留住。40 张 diff 卡片同页对照,30 次中位数从 270.9ms 降到 166.6ms(约 -38%,见移动端设计 §8.62)
- **顶栏的搜索 / 工程目录 / 排序 / 显示已归档刷新后还在**;与 hash 分工明确:hash 管「选中哪个会话」,localStorage 管「列表怎么筛」
- **会话区字号可调**:会话界面(消息 / 工具卡片 / diff / 问询卡 / 输入区)整体由一个变量 `--chat-fs` 统管,区内字号全是相对 `em`,改一个数就整块等比缩放
- 跨工程列出会话,按更新时间排序,游标翻页
- 按标题搜索(服务端 `search`)
- 按工程目录过滤(服务端 `directory`)
- 管理动作:重命名、删除、移动到其它工程目录、分叉
- 点击会话打开对话:加载历史消息、发送消息、`/api/event` SSE 实时刷新
- **用户消息上的提及标记**:`agents[]` 显示成 `@名字`,`skills[]` 显示成「徽标 + 名字」两格(` skill `;缺 `name` 用 `id` 兜底)
- **文件附件**:在输入框里 `@` 补全工程内文件直接引用;或用 📎 / 拖放 / 粘贴把文件带上去(见下文「文件附件」)
- **`/` 命令面板与 TUI 键位**:敲 `/` 列真实命令(服务端 `GET /api/command`,随工程走)再接面板动作类命令,`Ctrl+P` 随时打开;`Esc` 关面板/补全,或(连按两下)**中断当前回合**,`Shift+Tab` 切智能体,`↑`/`↓` 取输入历史,`End` 跳回最新(见下文「命令面板与 TUI 键位」)
- **`/sessions` `/models` `/agents` 弹选择框让你选**:不是把焦点丢给顶栏下拉(浏览器不会因此展开原生 `<select>`),而是弹出列表 —— `↑`/`↓` 环绕、`Enter` 选中、`Esc` 关闭、可过滤、可点选;选有推理档位的模型会接着追问一次档位(见下文「选择框」)
- **子会话 / 父会话导航(§8.69)**:左栏和 `/sessions` 都只列顶层会话(照 TUI 的 `!parentID`,子会话不再混进来);桌面头部多「子会话 N」「‹ 父会话」两个入口,手机走 `/subagents` / `/parent`;子会话收工行整行可点(`metadata.childID`),点了直接进那个子会话
- **逐 token 流式**:回复边生成边显示(正文按 Markdown 实时重排、光标闪烁、思考块自动展开、工具调用实时出现),见下文「流式渲染」
- **工具卡片对齐 TUI**:`edit`/`patch` 直接显示彩色 diff(行号 + `+N -M`,默认展开),`write` 显示写入的正文,诊断行跟在 diff 下方,`question` 已答时列「问题 → 答案」,见下文「工具卡片」;相邻的**探索类工具行**(`read` / `glob` / `grep` / `webfetch` / `websearch`)折成一行 `→ Explored: 1 read`(照 TUI 的 exploration 分组:计数与复数、跑着时换 `Exploring` + spinner、默认折着,点开就是原来那些工具行;**跨消息的纯探索续步**也会并进上一段最后一个探索组,见移动端设计 §8.68),**思考块**的行头照 TUI 的 reasoning 分组行(`Thought: <标题> · N steps · 4.7s` / 跑着时 `Thinking: <标题>`;标题取正文最前面那段加粗、折着才印,展开就收起来,时长是组内各段之和,格式照 TUI 的 `Locale.duration`),相邻的思考段并成一块,见移动端设计 §8.24 / §8.28
- **变更总览(`/diff`)**:敲 `/diff`(或 `Ctrl+P` 选 `diff`)看当前会话的文件变更 —— 弹框按文件列状态徽标、路径、`+N -M` 与完整 diff,复用消息卡片的行内高亮 / 语法色 / 桌面并排偏好;桌面框最宽 980px,手机整宽且正文自己滚。四档来源照 TUI 的 diff viewer:**最近一轮**(`/api/session/:id/diff?context=3`)、**全部**(`vcs.diff mode=branch`)、**未提交**(`mode=working`)、**已提交**(`mode=committed`);全部 / 已提交必须先选对比分支,服务端 `/api/vcs/base` 没有值时面板不猜默认分支,基线选择复用 `#dlgPick`,只按工程目录记在内存里(见移动端设计 §8.63)。多文件时左侧还有文件树:点文件跳到对应补丁,逐文件 `○ / ✓` 勾已看,reviewed 只在本页内存里;窄屏不显示文件树(见移动端设计 §8.64)
- **用户消息照 TUI**:整块抬起来(raised 底色 + 左边一条色边,照 `UserMessage` 的 `background.raised.base` 与
  `border={["left"]}`);`skills[]` 与 `files[]` 各画成「徽标 + 名字」两格(` skill ` / ` file ` / ` dir `),
  名字那格取 `name ?? 路径末段 ?? 附件`(见移动端设计 §8.29)
- **会话操作那一行**:聊天头部依次是 `导出` / `在 TUI 打开` / `归档`;还有更早的消息时「**加载更旧消息**」跟着排在**同一行**(一行放不下才自己换行)。手机上提示栏只留智能体那一格(模型·变体收起来、整条 `title` 里照旧),把宽度让给工程路径 —— 393px 竖屏上路径那格 145 → 234px(见移动端设计 §8.25)。它原来**一次都没成功过**:翻页请求把 `order` 与游标一起发,服务端 `400 InvalidCursorError: Cursor cannot be combined with order`,`api()` 抛出又被静默 `catch` —— 现在首屏带 `order=desc`、翻页**只**带游标(见移动端设计 §8.26)。**手机上(`html.narrow`)这一整行收起**(§8.41:竖屏那 40px 还给消息区,`#chatHeader` 129 → 81、消息区 +49px):三个动作在 `/` 命令面板里都有(`export` / `tui` / `archive`),翻旧改走「**滚到顶自动拉更旧**」—— 滚到离顶 ≤120px 就替用户点一次那个按钮(同一段 `loadMessages({ older: true })`),一次进顶只拉一页、失败过不自动重撞
- **助手消息脚注**(照 TUI 的 `AssistantFooter`):每条助手消息**收工后**在底部印一行 `Build · DeepSeek V4 Flash · 4.7s · 42.1 tok/s`(智能体首字母大写、模型名先去模型表查 `name`,时长 = 本步完成时间 − **本轮**输入消息的时间,速度 = 本轮各步 `output+reasoning` 之和 ÷ 各步活跃时长之和);中断时尾巴接 `· interrupted`,出错时上面另起一行 `Error: <原因>`,重试时 `⚠ Retrying in Ns · attempt K · <原因>`(每秒重算)。**模型名不再印在头部**,照 TUI 挪到这里(见移动端设计 §8.27)
- **Tokens 块**(照 TUI 的 `TurnTokenUsage`):每一轮**收尾处**在脚注下面印一行 `Tokens: 5 steps · latest: 284 new · 49,536 cached · 49,820 total`,**默认收起**,点开是逐步的表 `Step / New / Cached / Total`(`tool-calls` 照 TUI 写成 `tool-call`);缓存复用掉量时尾巴接 `· ! N likely cache bust(s)`、表里另起一行写清掉了多少(换模型不算、openai 掉 1~2 个 1024 桶不算)。轮次边界照 TUI:有 `idle` 标记就**撞上 `idle` 才收轮**(所以一条轮里可能夹着几段提示词),老会话(整条没有 `idle`)遇到**终步**就收;`.meta` 里那份 token 数并了进来,收工后只留费用(见移动端设计 §8.30)
- **其它消息种类照 TUI**(照 `SessionMessageView`):`model-switched` 走 `switchLabel`(查得到名字写 `Switched model to <名字>`,档不是 `default` 时补 ` (档)`;只是换档则写 `Switched variant to <档>`;查不到退回 `providerID/id/档`)、`agent-switched` 写 `Switched agent [from X] to Y`(两头 titlecase)、`location-switched` 写 `↳ Moved to <目录>`、`system` 与 `synthetic` 写 `◈ <描述>`(`system` 没描述时兜底 `Instructions updated`)、子会话与 shell 收工写 `↳ Explorer finished · <描述>`(`error` 红、`cancelled` 琥珀、其余蓝;shell 的描述先把空白压平;子会话那行整行可点,见 §8.69)、`skill` 消息写 `→ Skill <名字>`;`idle` 与**没有 `description` 的 `synthetic`** 整条不出行(照 `reduceSessionRows`)—— 原来一律画成 `· <type>: <text>`,而且 `idle` 会在消息流里留下一条 3px 灰边 + 22px 空隙(见移动端设计 §8.32)
- **会话控制**(输入框上方的工具栏):
  - **运行状态**:**只说一遍** —— 列表行与标题栏显示 `● 运行中` / `◌ 重试中`,数据来自 `GET /api/session/active` 与 `session.status` / `session.idle` 事件;消息流里**正在跑的工具行行尾不画状态标记**(字和点都不画:手机竖屏上那个「运行中」会被挤成「● 运」「行中」两行,比不写还难看;`✓`/`✗ 出错` 仍照旧画),但**行首那个标记会转** —— 运行中的工具行,行首的 `⏺` 照 TUI 换成盲文 spinner(`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`,80ms 一帧、10 帧一循环,位置也照 TUI 放在命令前面),跑完或出错回到 `⏺`;**输入框下面**还有一条**跟 TUI 同款的 8 格字符进度条**(`■⬝⬝⬝⬝⬝⬝⬝ esc interrupt`,位置照 TUI 的 `prompt.footer`:在对话框**下面**那一行,不在标题行里)—— 8 格、**54 帧一循环、40ms 一帧**(2.16 秒一圈:从左边往右长到 6 格 → 右端往左缩到 1 格 → 空三拍 → 倒着重走一遍 → 空约 1 秒;序表在 `progressCells()` 里,逐帧对表测试锁着),重试中换琥珀色;手机上只留那 8 格、藏掉 `esc interrupt`(手机上没这个键),底板**收起成细边时它也在**(排在最左,`■ 中断` 紧跟它右边);**压缩上下文**(`/compact` 或自动压缩)期间这条也照常转 —— 面板自己消费 `session.compaction.*` 事件(实测压缩跑到一半 `GET /api/session/active` 会空一拍,只认它条会中途灭掉)
  - **输入框下面的提示栏**(照 TUI 的 `prompt.footer`,新 `#promptFooter`):同一行五格,顺序照 TUI —— **智能体·模型**(`Build · DeepSeek V4 Flash`,取值就是工具栏那两个下拉的当前项)→ **工程路径** → **上下文用量**(前面接「N subagents · M shells」)→ **`tab agents`** → **`ctrl+p commands`**(手机换成 `/ 命令`,点了就是开命令面板,与 `Ctrl+P` 同一条路)。`#chatAgent` 那格在工具栏(`#ctoolbar`)**外面**,展开底板时它是唯一印着「现在是哪个智能体/模型」的地方(工具栏那两个下拉收着时它也在)。**（§8.42 起手机上整条都不显示了:收起时 §8.40 已经收掉,展开时改由工具栏那两个下拉交代）****§8.40 起,收起成细边时整条提示栏跟着收** —— 细边上只剩运行中的进度条与 `■ 中断`;**§8.42 起,手机上(`html.narrow`)连展开时也不露了**(用户「手机端,对话框下面还有:Build...等内容显示」) —— 那一行整条只在桌面存在(智能体·模型在展开态的工具栏里就有、`/ 命令` 输入框 placeholder 里也写着),手机上再也没有上下文用量那一格。路径显示 `目录:分支`(`:git 分支` 由 `/api/vcs` 问一次、按目录缓存),home 下面的缩成 `~/…`(照 TUI 的 `cm(path, home)`,home 由 `/__health` 提供);太长由 CSS 截断,`title` 给全路径。`tab agents` 照 TUI 的 `agent.cycle`:输入框里按**无 Shift 的 `Tab`** 切下一个智能体(`Shift+Tab` 也照旧;命令面板/@ 补全开着时 `Tab` 先归它们),点了也切;手机没键盘、工具栏上就有下拉,所以窄屏收掉。整条挂在 `#composer` **外面**(照 TUI 是输入框下面独立的一行),但**收起成细边时它跟着收**(§8.40:`#composer.collapsed ~ #promptFooter { display: none; }`)—— 细边上只留进度条与 `■ 中断`;展开就回来。上膛等第二下 Esc 时照 TUI 的 `showDetails`(`interrupt===0 || width>=80`):窄屏把用量与两处快捷键提示收掉,路径与智能体·模型照旧露着(桌面不动)
  - **子会话 / shell 计数**(照 TUI 提示栏那格):`N subagents` = 这个会话名下**正在跑**的子会话个数(`session.family` + `status==="running"`;子→父关系来自会话列表里带 `parentID` 的那批 + SSE 的 `session.created/updated/deleted`),`M shells` = 这个会话名下的持久 shell 个数(照 `shell.list(location)` 按 `metadata.sessionID` 过滤;`shell.created` 记、`shell.exited`/`shell.deleted` 划)。两者 ` · ` 连、再接 ` · 用量`。单独存一份(`store.subs` / `store.shells`)、不塞进 `store.sessions`,免得顶栏的工程筛选漏进别的工程的子会话
  - **上下文用量**(照 TUI 提示栏那个 `155.6K (78%)`):画在**输入框下面的提示栏**里(`#ctxInfo`,底板展开时露着;收起成细边时整条提示栏跟着收,§8.40;**§8.42 起手机上整条提示栏都不显示,§8.43 就把这一格搬到标题行末尾** —— 由 app.js 的 `syncCtxInfoHome()` 搬**同一个节点**(没有镜像副本,宽屏搬回 `#chatDir` 之后、`#agentHint` 之前;窄屏判定源仍是 `html.narrow` 一处,与 CSS 同一个类)),桌面看全量 `155.6K (78%)`、窄屏换成 TUI 的 compact 档 `78% ctx`(两档文案都印在 DOM 里,由 `html.narrow` 切 —— 横竖屏来回转也不用重画)。数字**每次现算、不另存**(照 TUI 的 `Us`/`XN`/`d4`:取最后一条带 `tokens` 的助手消息,但只认**最后一次已完成压缩之后**的 —— 压缩把上下文清空了,之前的数不算;把 `input+output+reasoning+cache.read+cache.write` 加起来,再拿这条消息自己记的模型去**该 location 的模型表**查 `limit.context` 求百分比,查不到(比如目录已被删)就只印 token 数;该会话花费 `>0` 时在用量后面接 ` · $x.xx`,照 TUI 的 `usage · cost`)。压缩完还没回话、或还没跑过任何一轮,整块收起(只有花费没有 tokens 时也露这一格)
  - **压缩上下文那一块**(照 TUI 的 Compaction 块画):消息流里不再是一句 `· compaction`,而是一块 `⏺ 上下文压缩`;进行中时行首那枚标记照工具行一样转(同一条盲文帧表)并标「进行中」,**概要正文边压边印出来** —— 压缩是另一次 LLM 调用,正文按 `session.compaction.delta` 一小段一小段吐(实测一份 8 KB 摘要来了 140+ 条、5ms 一条),面板照 TUI 的样儿边收边印(攒进 `store.compactText`、节流到 ~8 次/秒上屏;**上屏走局部重绘** —— 只换压缩块里那一个正文节点,不整表 `renderMessages()`:压缩那几秒里整表重画会反复「改完 `#messages` 再读一回 `scrollHeight`」,把整篇强制重排,见移动端设计 §8.16),跑完给出 `N tokens` 并把完整摘要摊开印着(外层留 `<details>` 当折叠抓手,用户点起来收着之后不会被后面来的正文又顶开);被中断的压缩标「已取消」(`error.type === 'aborted'`)
    - **`session.compaction.delta` 绝不能被当成收工信号**:原来 `session.compaction.` 一把抓,每条 delta 都当收工 + `dirty` 一次 → 每条都重画整个左栏,实测一份 8 KB 摘要触发 142 次 `renderSessions()`,压缩那几秒面板整个假死(「网页版崩溃无响应」)。现在三种事件分开:`.started` 开工(按事件里的 `inputID` 立刻放一块「进行中」进消息流,不等对账拉取)、`.delta` 只攒正文+节流重画对话区(不碰左栏)、`.ended`/`.failed` 才收工(顺手把载荷里的完整摘要写上,不等消息列表)
  - **中断**:运行中才出现 `■ 中断`,调用 `POST /api/session/:id/interrupt?resume=true`(和 TUI 的 `session.interrupt` 同一个调法);**中断之后「排队中」的消息会接着发出去** —— `resume=true` 只唤醒「插话」和控制项,而 `queue` 的语义是「停在原地等下一次回合边界」,回合被中断后不会再有下一个边界,实测那条会一直躺在队列里不动;所以中断成功后把待发送队列里的 `user` 项改成 `steer`(等于「唤醒会话执行」),接着发。压缩/移动这类控制项由 `resume=true` 自己接管
    - **Esc 要按两下**(桌面):照 TUI 的 `handleInterrupt` —— 第一下只「上膛」(状态条那句提示换成 `esc again to interrupt`,再补一句 toast),5 秒内按第二下才真打断;输入框一有动静、回合结束、真的打断了,都会把上膛收掉。`■ 中断` 按钮和命令面板里的「中断」是明确动作,照旧一下生效
  - **投递方式**:**运行中**发送消息可选「排队」(等当前回合走完再执行)或「插话」(下一个 step 边界就并进当前回合),对应 `prompt` 的 `delivery: queue|steer`。**默认「插话」** —— 照 TUI:TUI 里**光按 `Enter`** 就是 `prompt.submit`(插话),**排队要额外按 `<leader>return`**(`prompt.queue`)。原来面板默认排队,用户实测「TUI 里接着打一句就发得出去、网页版却躺在队列里」,所以对齐成插话(工具栏仍可随时切回排队)
  - **待发送队列**(照 TUI 的 `QueuedPromptDock`):**收成一条**`▸ 2 queued · 下一条的正文`,点开才是逐条那一列(排队/插话标签、正文、「改为排队/改为插话」`PATCH .../inbox/:id`、「取消」`DELETE .../inbox/:id`);展开态跨重画留住(见移动端设计 §8.31)
  - **切换 model / agent**:下拉选择智能体与模型(含变体档位),调用 `POST /api/session/:id/agent` 与 `.../model`
- 在页面内应答 OpenCode 的问询(底部固定卡片,不遮挡消息):
  - **表单**(`question` 工具等):单选 / 多选 / 自填、文本 / 数字 / 整数 / 布尔、外链授权,支持默认值预填与条件字段
  - **权限请求**(工具需批准):允许一次 / 总是允许 / 拒绝
  - 表单可「取消」并附原因;列表对有未决问询的会话显示 `⚑` 徽标
- **能力扩展**:
  - **网页内新建会话**:顶栏「+ 新建」,填工程目录(绝对路径)可选标题 / 智能体 / 模型(含变体),创建后自动打开。勾选「在 worktree 中新建」时,先按工程目录解析工程,照 TUI 的 `Name worktree` 起一个名字(可点「生成」随机 `adjective-noun`),服务端建好工作树后把新会话开在那里(§8.56)
  - **工作树管理**:`/worktrees` 命令列出当前会话所在工程的工作树(当前根排最前,主检出 / worktree 分开标),还会按会话的 `subpath` 列出子目录;点进去可以把当前会话移进去、删除(只对带 `strategy` 的根 worktree 开放;子目录不能单独删;有未提交改动时先列出 status 文件与增删行数,再点「仍然删除」)或刷新列表(§8.61 / §8.65)。入口只走命令面板,和 `/diff` 一样不往聊天头部加按钮。
  - **归档**:列表与聊天头部可归档 / 取消归档,默认从列表隐藏,顶栏「显示已归档」可查看(记录在 `session.metadata`,见下文说明)
  - **导出 / 导入**:导出会话为 JSON(可选脱敏),或从 JSON 导入为新会话并指定目标工程目录
  - **深链跳回 TUI**:给出 `opencode --session <id> <目录>`,可直接粘到终端继续同一会话

## 列表折叠与刷新后的恢复

- **收起列表**:列表与对话区之间那条分栏条的顶部有个小手柄(`‹`),点它把整个会话表收起,再点(`›`)展开。
  - 手柄**就长在分栏条上**,所以「这条能收起」一眼可见;拖动分栏条改宽度、双击复位宽度都照旧(点手柄不会误触发拖动)。
  - 收起用的是 `main.list-hidden` 类。**这份状态记在 `sessionStorage`(`ocs.listHiddenTab`)** ——
    它只活在这一个标签页里:刷新(F5)之后还是收起的,而新开一个标签页是展开的
    (按「第一次打开网页时应该展开对话列表」那条要求)。只有**点手柄**才算显式、才写这份记忆;
    鼠标靠左边缘的**临时拉出**一个字都不写 —— 那是「路过看一眼」,不是改设置。
    老键 `localStorage['ocs.listHidden']` **既不读也不写**(老浏览器里若还躺着它,没人看它);列宽 `ocs.listW` 照旧记忆。
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
  - **每次进入会话都还原**(刷新、列表、标签、深链前后退同一条路);没有存档(第一次打开)才跳到底部看最新消息。滚动时按时间戳节流记录,离开会话前与 `pagehide` 时各兜底存一次。
- **顶栏筛选 / 排序 / 搜索的持久化**:4 个键 `ocs.q.{search,dir,order,archived}`。
  - 启动时**先回填 store 与控件,再拉列表** —— 否则会先按默认值拉一次、再按恢复出来的条件重拉一次,白费一次请求还会闪一下(`init()` 里有顺序锁,冒烟测试会盯着)。
  - `store` 与存储跟着输入框立即更新,只对「取列表」防抖,存的值不会落后于界面。
  - 记住的目录这次没出现在结果里(该目录下暂时没有会话)也照样出现在下拉中,免得选不回去。

## 问询应答(表单 / 权限)

- 呈现:输入框上方固定卡片;同一会话多处问询按到达顺序堆叠。
- 触发两条路:① `/api/event` 的 `form.created` / `permission.asked` 实时到达;② 打开会话时兜底拉取 `GET /api/session/:sid/form` 与 `.../permission`。
- 提交:表单 `POST /api/session/:sid/form/:fid/reply` body `{answer}`(值类型 `string | number | boolean | string[]`);取消 `DELETE .../form/:fid?message=`;权限 `POST .../permission/:rid/reply` body `{decision:"once"|"always"|"reject"}`。成功均为 `204`。
- 与 TUI 对齐的细节:
  - 字段 `default` 预填;`boolean` 用勾选框;**带 `options` 的 `string` 字段画成可点的单选行**(`custom:true` 时下面再给一个「其它(自填)」输入框,两者互斥);`custom:false` 用下拉选择。
    - 这条是为了对齐 TUI:`question` 工具的单选问题正是 `type:"string" + options + custom:true`,TUI 会列出选项;面板曾经只画一个空输入框(选项藏在 `datalist` 里),手机上等于没有选项可点。
  - 条件字段 `when`(`{key,op:eq|neq,value}`,多条件为与)按实时答案显隐;未激活的字段**不参与提交**(服务端会以 `Form field is not active` 拒绝)。
  - `external` 字段必须确认(提交 `true`),否则服务端拒绝。
  - 提交前按 TUI 同样的规则本地校验(必填、`min/max`、`minLength/maxLength/pattern`、`email/uri/date` 格式、`minItems/maxItems`),失败在卡片内提示且不丢用户输入。
- 已知限制:徽标只反映「事件到达后」的其它会话;面板启动前就已存在的其它会话未决问询,需打开该会话才会显示。

## 会话控制

- **运行状态**:打开页面后每 8 秒兜底拉取 `GET /api/session/active`(返回 `{data:{<sid>:{type:"running"}}}`),同时实时消费事件:
  `session.status`(`status.type ∈ idle|retry|busy`)、`session.idle`、`session.execution.started|succeeded|failed|interrupted`。
- **中断**:`POST /api/session/:id/interrupt?resume=true` → `{interrupted:boolean}`;空闲时返回 `interrupted:false`,会话不存在返回 `404`。`resume` 是照 TUI 的 `session.interrupt` 带的:中断后接着跑待投递的「插话」和控制项;面板在成功中断之后还会把待发送队列里的 `user` 项改成 `steer` 放行(见上文「中断」)。
- **发送时的投递方式**:空闲时发消息不带 `delivery`(立即执行);**运行中**由工具栏在「排队」与「插话」间选择(**默认插话**,见上文「投递方式」),写入 `prompt` 的 `delivery`。
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
- **切会话时在途的消息响应一律丢掉**:`store.messages` 只有当前会话一份,而「150ms 防抖对账」的请求可能在一次切换之后才回来 —— 写进去就会让新会话显示上一个会话的消息(头部那枚上下文用量也跟着错)。所以 `loadMessages()` 在 `await` 之后按 `id` 复查一次 `store.selected`,变了就整份丢弃。这条是给上下文用量做真面板探针时撞出来的(切到一个刚建的空会话,`store.messages` 里却躺着上一个会话的 49 条)。

### 增量重绘(不整条重建)

- 消息签名分两种:非流式用 `JSON.stringify(消息)`,流式用**结构指纹**(part 类型 / 序号 / 工具状态 / **工具 metadata 指纹** / 有无 tokens),
  **刻意不含文本长度** —— 所以每次 delta 都不会触发整条消息重建。
- 纯文本变化走 `paintLiveText()`:只把受影响的那个 block 节点重新渲染 Markdown,其它消息、同一条消息的其它块、
  标题行都不动(DOM 节点 identity 保持不变,已展开的 `<details>` 状态也不会丢)。
- 纯文本增量事件(`session.text.delta` / `session.reasoning.delta`)**不再触发消息重取**,省掉每秒数次的无谓请求;
  其余事件也只在「属于当前会话、且真会改消息」时保留 150ms 防抖对账(§8.54);后台对账不显示加载状态。
- `session.tool.progress` 会陆续送来工具的 `metadata`(例如 `edit` 的 diff),这时状态与 parts 都没变。
  因此 `handleEvent` 除了看「结构变化」,还会比对**已渲染的指纹**(`msgEls` 上的 `fp`):指纹变了就补一次整条重绘。
  metadata 没变的 progress 依旧不重绘、不重取(保持 C 组既有的「progress 不是结构变化」契约)。
- 光标 `▌` 总是落在**最后一个文本/思考块**内部的行内末尾(直接拼在 Markdown 结果后面会掉到块级元素之外、单独占一行)。
- 流式期间思考块自动展开(`▾ Thinking`),回合结束后回落到折叠态(`▸ Thought: <标题>`)—— 与服务端版本一致;摊开时行头就不印标题了(照 TUI:展开那款只留词 + N steps + 时长)。

## 慢网 / VPN

面板默认就按「链路可能很慢」设计,不需要额外开关:

- **传输压缩**:静态资源(`app.js` / `styles.css` / 首页)与大块 JSON(会话列表、消息列表)按浏览器的
  `Accept-Encoding` 压一遍 —— 优先 brotli,其次 gzip;带 `Vary: accept-encoding`,304 仍走 ETag。
  消息列表先摘掉不显示的 `data:` 图再压;SSE 绝不压(压了逐帧事件会被攒住)。
- **对账只认当前会话**:`provider.updated` / `model.updated`、别的会话的流事件都不再触发消息重取;
  只有当前会话、且真会改消息的事件才排 150ms 防抖对账。
- **同一时刻只飞一条**:后台对账在飞时再来的事件合并成一次,落地后内网隔 800ms、慢链路隔 4s 再补;切会话 / 点重试这类前台请求
  会直接中止在飞的自动请求(`AbortController`),不会几条 MB 级响应一起排队。
- **后台静默**:自动对账不点亮「正在加载消息…」,失败也不把已有画面盖成错误页;首屏 / 切会话才显示状态行。
- 会话列表的自动刷新只认会改左栏行的事件,间隔 2.5s;`loadActive` 的 8s 轮询只在最近 12s 没对过账时才拉消息。
- **慢链路桌面也只拉 30 条**(§8.55):首屏会话列表那一趟 ≥180ms 就记成慢链路(内网 <20ms、VPN 200ms 起),
  首屏与翻页都按手机同档的 30 条;往上滚到顶自动带更旧一页。LAN 桌面照旧 100 条、照旧用按钮翻旧。
- **切回看过的会话先用内存缓存顶上**(§8.55):切走时把消息与游标快照进 `store.msgCache`(最多 6 个会话,
  不落盘),切回来同步先画旧内容,再安静对账一条;1.5s 内的来回切连对账都省掉。删会话会顺手清掉缓存。

实测(Chromium 限速,深链一个 1.03MB 的会话):2 Mbps / 150ms 下「消息可见」从 30.5s 降到 2.5s,
消息请求从 7 条降到 1 条,总传输从 6.64MB 降到 345KB;1 Mbps / 300ms 下 4.1s。慢链路首屏 30 条后,
真页面 2 Mbps / 150ms 下切回看过的会话同步 89ms 就出 59 条,后台只补 1 条。详见 §8.54 / §8.55。

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
- 工具卡片的正文整体限高内滚(`.toolbody`),diff 长行按字符折行(§8.58),长改动不会把消息流撑爆。
- **成对的 `-`/`+` 行做行内高亮**(§8.49):相邻的删段与增段按位置配对,剥掉公共前后缀后按字符做 LCS,只有真正变了的字包一层 `<span class="hl">` —— 一行改一个词,眼睛就直接落在那个词上。纯增 / 纯删、中段超过 400 字、含 emoji 的行退回整段点亮;一张卡片最多算 2000 对,大补丁不会因此卡住。行号、复制出的文本、转义都不受影响。
- **语法着色**(§8.50):按文件扩展名认 js/ts/json/go/rs/c/h/sh/py/css/md/html(以及常见别名),逐行标出注释 / 字符串 / 数字 / 关键字四类,`write` 的正文同样上色。零依赖的极简分词器,认不出来就纯文本;逐行而不是跨行,是因为 diff 的 hunk 会跳行。
- **并排视图只做桌面,偏好与 TUI 共享**(§8.52 / §8.53 / §8.60):每块 `modified` 文件的头上有「⇆ 并排」,点了同一 hunk 里的删段与增段左右对齐,再点回统一视图。偏好直接读写 TUI 的 `~/.config/opencode/cli.json` 的 `diffs.view`(面板只把上次值放 `localStorage['ocs.diffView']` 当首屏缓存):没动过 = auto,桌面聊天区 ≥760px 就并排;在 TUI 的设置里改了,面板下一次 15s 健康检查就会跟上;在面板里点,也会立刻写回 `cli.json`。升级后第一次打开时,如果 `cli.json` 还没记过 `view` 而面板有旧值,会把这一个偏好迁过去一次。`added` / `deleted` 文件照 TUI 始终统一视图;分栏里长行按字符折行(照 TUI 的 `wrapMode="char"`);窄屏不出按钮、永远统一视图。**统一视图的长行也折行**(§8.58),不再横向滚。
- 暂不支持(明确不做):逐文件 revert(§8.51:`revert/stage` 只收 `{messageID, files?}`,服务端没有按文件的口子)。
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
- **消息流里怎么显示**:用户消息正文下方逐条列出「徽标 + 名字」两格(照 TUI 的 `UserMessage`:` file ` / ` dir `
  加粗反白、名字那格稍暗),后面接 `mime · 大小 来源路径`;
  `image/*` 且带 `data` 的直接内联成缩略图(`data:` URL),不需要额外请求。
  - 大小是按 base64 长度反算的(服务端不回 `size`);`source.type === 'uri'` 时才显示来源路径,
    `inline` 的没路径可显示就省略。
  - 这些都在 `renderMessage` 的用户分支里,和 `agents[]`/`skills[]` 一样是**条件追加**:
    没有附件就不产生空的附件行(所以「没有提及/附件时用户消息仍是 3 个子节点」这条老断言照旧成立)。

## 命令面板与 TUI 键位

目标是「网页端的操作手感与 TUI 一致」:该弹的补全要弹,该按的键要管用。

### `/` 命令面板

- **触发**:输入框为空、或以 `/` 开头时敲 `/`(行中间的 `/` 不弹,不打扰 `a/b` 这种正常书写);按 `Ctrl+P` 随时打开(对应 TUI 的 `command.palette.show`)。
- **内容**:`GET /api/command?location[directory]=<会话的工程目录>` 返回的**真实命令**(本机是内置的 `init` / `review`;在工程的 `.opencode/commands/` 里放 `.md` 就会自动出现,嵌套目录会变成 `team/review` 这种名字),后面接**面板动作类命令**(见下表)。同名时以服务端命令为准,面板动作让位(否则用户自定义的 `/new` 会被面板动作盖掉)。
- **键位**:`↑`/`↓` 移动、`Enter`/`Tab` 选中、`Esc` 关闭;鼠标可点。选中只是把 `/名字 ` 补进输入框 —— **和 TUI 一样,补全之后还要再按一次 Enter 才发出**。
- **整条命令名敲完 + `Enter` 直接执行**:输入框里已经是 `/models` 这种**完整命令名**(后面没有参数)时,按一次 `Enter` 就直接跑,不再多要一下。省掉的就是「补全 → 再发」的第二下(`Edge` 用户明确提的摩擦点);只敲了前缀(`/mod`)时 `Enter` 仍然只是补全,免得把「想接着打参数」误判成执行;高亮停在别的命令上时,补全成的是**那个**命令而不是执行当前输入框里的名字。`Tab` 依旧只做补全,不触发执行。
- **发送**:正文匹配 `^/(名字)( 参数)?` 且命中命令表时才走命令通道,未命中一律当普通消息发(不会静默失败)。
  - 服务端命令:`POST /api/session/:id/command`(body `{name, text}`;`text` 是必填,没有参数也要给空串)。响应是 **204 无内容**;模板展开、`$ARGUMENTS` 替换、shell 块全由服务端做,面板只把命令名与参数原样递过去。附件(`@` 引用、上传的文件)照旧作为 `files[]` 一起带上。
  - 面板动作:服务端没有对应的 command 接口,TUI 里它们是内置动作,由面板自己映射到已有的按钮 / HTTP 接口。

| 面板动作 | 干什么 | 落到哪 |
| --- | --- | --- |
| `/new` | 新建会话 | 顶栏「+ 新建」对话框 |
| `/compact` | 压缩当前会话上下文 | `POST /api/session/:id/compact` |
| `/interrupt` | 中断当前回合(排队中的消息接着发) | `POST /api/session/:id/interrupt?resume=true`,再把队列里的 `user` 项 `PATCH` 成 `steer` |
| `/undo` | 撤销到最后一条用户消息(含该轮文件改动) | `POST .../revert/stage {messageID, files:true}` |
| `/redo` | 清除已暂存的撤销 | `DELETE .../revert` |
| `/diff` | 看当前会话最近一轮 / 全部 / 未提交 / 已提交的文件变更 | `GET /api/session/:id/diff?context=3` 或 `GET /api/vcs/diff?mode=…` → 面板内对话框(§8.63) |
| `/rename` `/delete` | 重命名 / 删除当前会话 | `PATCH` / `DELETE /api/session/:id` |
| `/export` | 导出为 JSON | 顶栏的导出对话框 |
| `/archive` | 归档 / 取消归档 | `PATCH` 会话 metadata(面板级) |
| `/tui` `/copy` | 在 TUI 打开 / 复制那条命令 | 聊天头部的同名按钮 |
| `/sessions` `/models` `/agents` | 弹出**选择框**让你选 | 面板内对话框(见下) |
| `/clear` | 清空输入框 | TUI 的 `prompt.clear` |
| `/help` | 快捷键表 | 面板内对话框 |

`/undo` `/redo` 是唯二会动到工作区的动作:`revert/stage` 带 `files: true`,和 TUI 的 undo 一样**会还原那一轮的文件改动**,所以要二次确认;会话正在运行时服务端会回 `409 SessionBusyError`,面板先拦住并提示「会话正在运行,先中断或等它结束再撤销」,不去撞这个墙(没有已暂存撤销时 `DELETE /revert` 也回 `409`,面板按「没有可重做的撤销」处理,不算报错)。

### 选择框(`/sessions` `/models` `/agents`)

这三条在 TUI 里都是「弹出列表让你选」。**它们不能只是把焦点丢给顶栏那个下拉** —— 浏览器不会因为 `focus()` 就展开原生 `<select>`,那样按下去看起来是「什么都没发生」。所以它们一律弹一个选择框:

- **一个通用选择框管三条命令**:标题 + 可选的过滤框 + 列表 + 底部一行动作/键位 + 关闭。`↑`/`↓` 环绕移动、`Enter` 选中、`Esc` 关掉(交给 `<dialog>` 自己的原生行为)、鼠标可点;有过滤框时直接打字就过滤(`label` 与副标题都参与,大小写不敏感),换查询词会把高亮归位到第一条。
- **照 TUI 的 `DialogSelect` 三处细节**(见移动端设计 §8.33):①**当前值那一条**在最前面钉一枚 `●`(那格空着也占位,条目名才对得齐)—— 高亮(`.active`)跟着 `↑`/`↓` 走,`●` 动都不动,挪开之后照样认得出哪条是当前的;②**底部一行动作 + 键位**(照 `DialogFooter`),桌面写 `↑↓ 选择 · Enter 选中 · Esc 关闭`、手机换成 `点条目选中 · 关闭按钮收起`(与 `#cmdHint` 同一套 `html.narrow` 两档),有过滤框时前面多一句「打字过滤」;③空态分两种:**压根没有条目**写「没有可选项」、**过滤之后没匹配**写「没有匹配项」(照 TUI 的 `No items available` / `No results found`)。
- **`/sessions`**:列的就是**左栏那批**(同一套搜索/目录/显示已归档筛选、同一套排序,共用 `visibleSessions()`;§8.69 起和左栏一样只列顶层会话,子会话走 `/subagents`),标题作主文案、工程目录名 + 相对更新时间作副文案,选中即切过去。
- **`/models`**:按 `providerID` 分组,主文案是模型名、副文案是 `modelID`;当前模型默认高亮。**选了有 `variants[]` 的模型会紧接着追问一次档位**(列表是「默认」+ 各档位),与 TUI 一致 —— 所以不用再去碰工具栏那个变体下拉。
- **`/agents`**:只列能切的(`loadAgents` 已经滤掉 `hidden` 与 `subagent`),不提供「默认」这个空选项(服务端不允许把智能体置空,列出来只会点了报错)。
- 关掉选择框后**焦点回到输入框**,可以接着打字。选择框与工具栏下拉共用同一条落地路径(`applyModel()` / `switchAgent()`),所以两边显示的状态不会各说各话。

### TUI 键位

| 键 | 行为 | 对应 TUI |
| --- | --- | --- |
| `Esc` | 关命令面板 → 关 `@` 补全 → 都没开且当前会话在跑时**连按两下中断当前回合**(第一下只是「上膛」,5 秒内按第二下才真打断) | `session.interrupt`(默认就是 `escape`;TUI 也是两下,见它的 `handleInterrupt`) |
| `Ctrl+P` | 打开命令面板 | `command.palette.show` |
| `Shift+Tab` | 切到下一个智能体 | `agent.cycle` |
| `↑` / `↓` | 光标在首行按 `↑`、末行按 `↓` 时取输入历史(每会话独立) | `prompt.history.*` |
| `End` | 跳回最新消息(焦点在输入框里时让给输入框,那儿 `End` 是「光标到行尾」) | `session.last`(TUI 还接受 `ctrl+alt+g`) |
| `Enter` / `Shift+Enter` | 发送 / 换行 | `prompt.submit` / `prompt.newline` |

- `Esc` 挂在 `document` 上而不是输入框上 —— 焦点在别处也管用;但只在该会话确实在跑时才中断,并且 `<dialog>` 打开时让对话框自己处理(否则「关对话框」会顺手把回合中断掉)。**要按两下**才真打断:第一下在状态条那句提示里写上 `esc again to interrupt`(再补一句 toast,底板收起时也能看见),5 秒内按第二下才发中断请求;输入框一有动静就撤掉上膛(照 TUI 的 `handleInputClear`),回合结束也撤掉(照 TUI 的 `phase === "idle"` 归零)。
- `End` 同样挂在 `document` 上,但**焦点在输入框/文本域里时不抢**(那儿 `End` 是光标到行尾);有对话框开着也不抢。
- 浏览器保留的键位不做:`Ctrl+T`(新标签)、`Ctrl+N`、`Ctrl+W`、`Ctrl+L`(地址栏)在网页里 `preventDefault` 无效,硬做只会变成「按了没反应」。`Ctrl+P` 可以拦,所以采用。

## 尚未实现(v2+ 剩余项)

- **跨消息并组的完整行投影**:§8.68 已用方案 A 补上实测那 8 处 —— 下一条非终步、整条都是探索工具的续步会藏成占位,工具并进上一段最后一个探索组;带正文 / 终步 / 流式续步仍分成两段。要像 TUI 那样任意 part 都跨消息并,仍得把「按消息」改成「按行投影」,牵动增量渲染、流式缓冲、离屏渲染与锚点四条路,当前不做(方案与取舍见移动端设计 §8.68 / §9)。
- **子会话导航只到直接子会话**:§8.69 的主列表过滤照 TUI 的 `!parentID`,入口是当前会话的「子会话 N」与「回父会话」;TUI `sessionFamily()` 那棵带 `├─` / `└─` 前缀的整棵家族树、活动 / 全部筛选没做。列表接口仍把子会话混在最近一页里(只在显示层过滤),所以主列表实际可能不到 50 个;要彻底解决得让列表分页只取顶层会话,或按 `parentID` 递归补齐,当前不做。
- 另有一处「看着像没做、其实不用做」:TUI 的 `SessionMessageView` 里有「`idle` 带 `error` → `Error: …`」(`ExecutionError`)这个分支,但它的行式视图(`reduceSessionRows`)对 `idle` **一行都不 push**,那个分支在行式视图里到不了;所以面板把 `idle` 整条不出行**是一致的**。会话真报错时两边都走助手脚注那条路(`Error: …` / `⚠ Retrying in …`),面板 §8.27 已对齐。

工具卡片上明确不做的:**逐文件 revert**(§8.51:服务端 `revert/stage` 只收 `{messageID, files?}`,
没有按文件的口子;整轮撤销与重做就是面板已有的 `/undo` / `/redo`,不另造假按钮)。
独立的「变更」总览已经接了四档来源、文件树与逐文件 reviewed(§8.63 / §8.64);
对比分支必须先选,面板不猜 `branch.default`。
行内高亮、语法着色、桌面并排视图见 §8.49 / §8.50 / §8.52 / §8.53;并排偏好已由 §8.60
与 TUI 共用 `cli.json` 的 `diffs.view`(只共享 `view`;`wrap` / `tree` / `single` / `source`
仍只在 TUI 的独立 diff viewer 里)。

worktree 已经覆盖「在 `+ 新建` 里新建」(§8.56)与 `/worktrees` 的列出 / 删除 / 把当前会话移进去
(§8.61),并按会话 `subpath` 把根下的子目录也列出来(§8.65)。子目录只能移入、不能单独删;
删除有未提交改动的工作树时,先读 `/api/vcs/status` 列出文件与 `+N -M`,再让用户确认,不展示
完整逐行 diff(完整 diff 在 `/diff`)。

会话标签栏只做「打开 / 切换 / 关闭 + 新建」(§8.59):TUI 的拖拽排序、未读脉冲、`Ctrl+数字`、
global/cwd 分域都不做;标签只存本浏览器的 `localStorage`,不跨设备同步;标签指向的会话若在别处
被删,点开会报错,`×` 仍可把它移出。

布局/状态上明确不做的:为每次操作 push 历史、`hashchange` 与 URL 手动编辑的同步。

键位上明确不做的:浏览器自己保留的 `Ctrl+T` / `Ctrl+N` / `Ctrl+W` / `Ctrl+L`(`preventDefault` 无效)、
以及 `Ctrl+C` 清空输入(会把网页里的复制弄坏)。

手机端上明确不做的:PWA / service worker / 图标 / 全屏(`http://` + 私有 IP 拿不到安全上下文,
做了也装不上,必要时以后套 APK 再补)、横屏的精调(「能用即可」)、拍照直接上传(附件走安卓
系统的文件/相册选择器)、以及给「只靠悬停才显示」的元素补常驻样式(核实过:仓库里没有这类元素,
`hover` 只改颜色不改可见性)。

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
bash test/e2e-commands.sh     # 命令面板端到端(纯 curl):GET /api/command 契约 → 未知命令 404 → 缺 text 400 → 真命令展开成提示词 → compact/revert 端点
node test/ui-asks-run.js      # 问询前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-controls-run.js  # 会话控制前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-capabilities-run.js  # 能力扩展前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-stream-run.js    # 流式前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-tools-run.js     # 工具卡片 diff/代码/诊断的前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-layout-run.js    # 列表折叠(含鼠标靠左边缘临时拉出) + 刷新后的恢复(会话 / 滚动位置 / 顶栏条件)(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-jump-run.js      # 一键回底「跳到最新 ↓」的显隐与 sticky 位置 + 拉消息失败/重试(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-attach-run.js    # 文件附件与 @ 补全的前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-commands-run.js  # / 命令面板、Esc 中断、输入历史、Shift+Tab 的前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-picks-run.js     # 选择框对话框 /models · /agents · /sessions(含子会话导航)的前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/netallow-run.js     # 来源地址白名单的纯函数(不起浏览器;含「空配置=不限制」「配错=fail closed」)
node test/strip-run.js        # 代理层「消息列表摘掉 data: 图」的纯函数(不起浏览器;§8.37)
node test/sse-strip-run.js    # 代理层「SSE 里也摘掉 data: 图」的纯函数(不起浏览器;§8.47)
node test/sse-e2e-run.js      # 代理层「SSE 里也摘掉 data: 图」的端到端(真起代理 + 假上游;§8.47)
node test/config-e2e-run.js   # TUI diff 偏好共享的端到端(真起代理 + 临时 cli.json;§8.60)
node test/ui-composer-run.js  # 底部输入区(底板)收起/展开的前端逻辑(无头 Firefox;缺 firefox 时自动跳过)
node test/ui-mobile-run.js    # 手机端窄屏适配:两个视口各跑一遍(390×844 竖屏、894×393 横屏;无头 Firefox)
UI_CASES='360,780' node test/ui-mobile-run.js   # 想量别的尺寸时覆盖(格式 宽,高;多个用 ; 分隔)
```

- `smoke.sh`:357 项。含顶栏/分栏条改造的结构断言(8 个控件都在 `#topbar` 切片内、`#btnList` 在 `#resizer-mid` 切片内而不在顶栏、首页不再有 `#filters`/`<aside>`/`#resizer-left` 且只剩 1 个分栏条、`styles.css` 主区为 `var(--list-w, 560px) var(--rz-w, 16px) minmax(0, 1fr)` 且不再写死高度)、
  工具卡片的 5 项样式断言(有 diff 配色变量、`.dl.add/.dl.del`、`.dfile/.diff`、行内高亮 `--hl-add-bg` 与 `.dl.add .hl`、语法着色 `--syn-*` 与 `.src .tk.*`、并排 `.dl.pair` 与窄屏收掉 `.dswap`)与六条代码锁(§8.49 的 `hlRanges`/`pairDiffRows` 真的接在 diff 渲染上且 `HL_MAX_PAIRS` 兜底还在;§8.50 的 `langOf`/`syntaxSpans` 同时接在 diff 与 write 正文两条路上;§8.52 的 `splitRowsHtml`/`setupDiffView` 真的接上了;§8.53 / §8.60 的并排偏好是全局持久的、auto 阈值还在、没有按卡片的 `diffViews`(现在偏好来自 `cli.json` 的 `diffs.view`,`localStorage` 只做首屏缓存);§8.54 的静态 br、会话列表 gzip、消息列表 br 的体积对比,以及 SSE 不被压),以及列表折叠/恢复的 4 项(收起时为分栏条留 16px 窄槽、**收起时不隐藏分栏条**、**折叠记忆只认 `sessionStorage`**(刷新同一标签页保持、新标签页展开,localStorage 里的老键谁也不碰)与 hash 持久化),再加 H 组的 7 项(会话区字号旋钮 `--chat-fs` 与区内相对 `em`、agent/skill 提及的样式与渲染、`pushState`+`popstate` 前后退同步、滚动位置锚点 `ocs.scroll`/`sessionStorage`、顶栏条件持久化与 `setupFilters`、用户消息提及渲染),
   H 组 6 的 8 项(附件与 `@` 补全的前端逻辑、上传必须走 `/api/experimental/fs/write` 而不是自建端点、`#mentions`/`.achip`/`.att-img`/`.att-src` 样式、输入区的附件按钮/文件框/待发送行/补全下拉、`/__health` 给出 `uploadDir`、代理会建目录并定期清理、附件 uri 必须加 `file://` 前缀),
   外加**两条顺序锁**:用 `awk` 取 `init()` 函数体,断言 `setupFilters()` 排在 `loadSessions` 之前(否则启动会按默认值白拉一次)、`setupAttachments()` 排在 `paintDelivery()` 之前(先接线再画输入区),
   再加 I 组的 21 项(命令面板的五个函数与按工程取命令、命令走 `/command` 通道、同名以服务端优先、17 个面板动作齐全、全局键位接线在 `document` 上、会话在跑才中断且对话框打开时不抢键、**Esc 要按两下**(第一下只上膛 + 5 秒归零定时器 + 输入框有动静就撤 + 中断带 `resume=true` 并把排队的 `user` 项改成 `steer`)、输入历史与 `Shift+Tab`、`Ctrl+P`、`#cmds`/`#dlgHelp`/`#helpKeys` 三个节点、样式,以及 I 组的三个测试文件都在),
   以及**第三条与第四条顺序锁**:`setupTuiKeys()` 体内 `closeCommands()` → `closeMentions()` → `requestInterrupt()` 的顺序(这就是 Esc 的优先级,写反了就会「一按 Esc 直接中断」)、`setupComposerKeys()` 体内 `commandKey` → `mentionKey` → `historyKey` → `send` 的顺序(输入框里的按键让给谁)。
   再加性能与投递的各 3 项:`.cvmany` 离屏跳渲染(`#messages.cvmany > .msg` + `content-visibility` + 估值高度都在、**反向封锁**不许挂成无条件的 `#messages > .msg`、开关由 `renderMessages()` 按 `CV_MIN_MSGS` 挂且 `ui-layout` 有正反两面断言)、运行中默认投递 = 插话(`const DEFAULT_DELIVERY = 'steer'`、`store.delivery` 走这个常量而不是写死字面量、`setDelivery()` 里非法值回默认)。
   再加**拉消息失败不许一声不响**的 8 项(移动端设计 §8.34:`#messages` 里那条状态行的结构、`setupMsgState()` 定义 1 次 + `init()` 1 次的接线锁、重试次数 `MSG_TRIES = 3` 与退避 `[800, 2500]`、失败亮原因 + 一个「重试」、**「空数组」与「没拿到」分家**(`Array.isArray(j.data)` / 缺 `data` / 半截正文都算失败)、「正在加载」慢到 250ms 才露且切会话/取消选中把在途请求作废、`.msgstate[hidden]` 必须显式写、`ui-jump.html` 里有这组断言)。
   再加**一页拉多少条**的 2 项(移动端设计 §8.35:窄屏 `MSG_PAGE_NARROW = 30` / 桌面 `MSG_PAGE_WIDE = 100`、口径只有 `msgPageSize()` 一处且首屏与翻页共用、`ui-jump.html` 反向断言);再加 **§8.55 的 2 项**:慢链路判据(`SLOW_SAMPLE_MS = 180` / `noteNetSample` / `slowLink()` 接在 `msgPageSize` 与 `autoLoadOlder` 上)和内存缓存(先画快照再 quiet 对账、上限 6、删除即清)。再加 **§8.56 的 5 项**:worktree 开关与名字行默认收起(不勾时桌面布局不动)、名字规则照 TUI 的 `slugify` + `Slug.create`、`/api/location` 解析 `projectID` 后 `POST /api/worktree` 再用返回目录建会话、worktree 已建好但会话失败时原地重试复用那棵目录(不重复建)、失败文案取 `data.message` 且复选框每次打开都复位。再加 **§8.57 的 4 项**:变更总览的框 / 窄屏整宽与正文自滚、`/api/session/:id/diff?context=3` 与 `diffHtml` 复用、`/diff` 进面板命令且旧响应用 `diffSeq` 挡住(含「轮次还在跑」的空结果文案)、`ui-capabilities.html` 里的浏览器断言在。再加 **§8.58 的 2 项**:全局 `.dl` 是 `pre-wrap` / `anywhere`(不再是 `white-space: pre`)、`.src` 有 `min-width: 0`,`ui-tools.html` 里有折行 / 不撑宽 / 行号留在第一行的断言。再加 **§8.59 的 5 项**:标签栏节点在 `#chatHeader` 之前且左列表保留、自动入栏 + `ocs.tabs` + 最多 8 个 + init 接线、`closeTab` 只移出(不发 DELETE / 不归档)且关当前标签切邻居、桌面 36px / 竖屏 34px / 横屏 30px 的样式、`ui-capabilities.html` 里的关键断言在。再加 **§8.60 的 5 项**:`/__config/diffs` 路由 / 读写函数 / health 的 `diffView`、写 `cli.json` 走临时文件 + rename 且保留权限 / 限制请求体、面板首屏读 / 切换 PATCH / init 接线、health 同步 TUI 偏好 + 旧 localStorage 只迁移一次 + 写失败提示、`test/config-e2e-run.js` 与 `ui-tools.html` 的 §8.60 断言在。再加 **§8.61 / §8.65 的 5 项**:`/worktrees` 进命令面板与快捷键说明、打开先取会话最新目录再 refresh 并按 `projectID` 列且当前根排最前、按 `subpath` 列子目录且删除前先读 status 文件清单、移入走 `session/move` 并同步本地目录、`ui-capabilities.html` 里的根 / 子目录 / 移入 / 删除预览 / force / 当前目录断言在。再加 **§8.63 的 1 项**:四档来源 / 对比分支选择 / 窄屏横滑的静态锁与浏览器断言都在。再加 **§8.64 的 1 项**:文件树多文件露出 / 点文件跳正文 / reviewed 不重造正文 / 窄屏 `html.narrow` 收起的静态锁与浏览器断言都在。再加 **§8.66 的 1 项**:进入任何会话都先找滚动存档,没有存档才落到底部。再加 **§8.67 的 1 项**:后台消息对账内网 800ms、慢链路 4000ms,落地后走同一个 `msgAutoGap()`。再加 **§8.68 的 1 项**:跨消息只吸收纯探索续步,占位 / 锚点 / 静态样式与 `ui-tools.html` 的断言都在。
   再加**贴完底再跟几帧**的 2 项(移动端设计 §8.36 / §8.46:`repinUntilStable()` 只在 `cvmany` 下启动、有 `REPIN_MAX_MS` 自保上限、`repinSeq++` 三个作废点(切会话/取消选中/再渲染)、停手的三条硬条件(又渲染了 / 用户往上滚了 / 高度连续两帧没变)、`ui-jump.html` 反向断言)+ **盯内容高度**的 2 项(§8.46:`ResizeObserver` 只认 `#messages` 的子元素、刚点过 400ms 内不抢着贴、`ui-jump.html` 里有「迟到撑开也贴回」与「刚点过不抢」两组)。
   再加**消息列表摘掉 data: 图**的 4 项(移动端设计 §8.37:代理里 `stripToolUris()`/`isMessageListUrl()` 这对纯函数在、URL 正则只认 `/api/session/<id>/message`、只有那一条走缓冲改写且解析失败一律原样发、只摘 `data:` 开头的 uri(留 name/mime + `omitted` 字节数)、**SSE 的流式透传不许被顺手缓冲**、纯函数已导出、`test/strip-run.js` 在);再加**SSE 里也摘掉同一批 `data:` 图**的 4 项(移动端设计 §8.47:那几个纯函数在、事件范围只认 `session.tool.success`、只有 SSE 那条走按行改写且解析失败一律原样发、`test/sse-strip-run.js` 在、`test/sse-e2e-run.js` 在)。
   再加**选中的会话不在列表页里时那两排不许消失**的 2 项(移动端设计 §8.39:判据只有「有没有选中会话」—— `renderChatOps()` 的 `bar.hidden = !store.selected` + `blankControls()` 在 + `refreshSessionInfo()` 里补画 `renderChatOps()`,以及**一条源码顺序锁**:`selectSession()` 里 `if (!s) refreshSessionInfo(id);` 必须排在 `await Promise.all([…])` 之前(那组里任何一条卡住都拖不住它))。行为断言在 `ui-layout` 的幽灵会话那一组里。
   再加**窄屏收掉那一行 + 滚到顶自动拉更旧**的 2 项(移动端设计 §8.41,起因是用户「主要是手机端屏幕下,显示太多东西没必要」):`html.narrow #chatOps, html.narrow #older { display: none; }` 两条都在(只收几个 chip 不收整行 = 一行还是 40px,所以两条一起断),以及 `setupAutoOlder()` 必须接进 `init()` 且**只有那一处接线**(定义 1 + init 1)、`autoLoadOlder(box)` + `AUTO_OLDER_TOP = 120` 在、窄屏判定源仍是 `html.narrow`、`store.msgError` 非空时不自动重撞 + 拉完那段锚点(`scrollAnchor()` / `applyScrollAnchor(at)`)在 —— 这一条锁的是「收掉那一行之后翻旧还有路」,只收不补等于手机上再也看不到更旧的消息。行为断言在 `ui-jump` 的 7b/7c 组与 `ui-mobile` 的 C/D 组。
   再加**手机上再瘦三处**的 3 项(移动端设计 §8.43,起因是用户「123 做」):`html.narrow.view-chat #topbar { display: none; }`(顶栏 111px 只在列表页留着)、`html.narrow #chatMeta { display: none; }`(标题下面那行「更新 … · 项目号」)、以及 `#ctxInfo` 那格**跟着窄屏搬家** —— `syncCtxInfoHome()` 在、窄屏判定源仍是 `html.narrow`、幂等(`ctx.parentElement === home`)、`line.appendChild(ctx)` 在、`syncCtxInfoHome()` 恰好出现 3 次(定义 1 + `syncNarrowClass()` 1 + `paintChatHeader()` 1)—— 这条锁的是「用量不许顺手丢掉」:§8.42 把提示栏整条收了,再没有搬家就等于手机上再也看不到用量。行为断言在 `ui-mobile` 的 A6b/A7b/C8h–C8j/D3d–D3f 与 `ui-composer` 的 I3b/K3b。
   注意 I 组在 `smoke.sh` 里只用 `has()` 与自带的 `ck()` 做**静态**断言,真正的行为验证在 `ui-commands-run.js` 与 `e2e-commands.sh`。
   选择框那块(+9:对话框四个节点、`.picklist`/`.pick-item`/`.pick-group` 样式、14 个函数齐全、
   **`focusEl` 这个旧做法已经不在了**、三条命令都接到选择框(用 python 在 `PANEL_COMMANDS` 切片里逐条对)、
   `init()` 里接上了 `setupPick()`、两个新测试文件都在),以及「完整命令名 + `Enter` 直接执行」的 `exactCommand`。
   - J 组的 20 项(运行状态条 + 压缩上下文那一块):`#progress` 存在且默认 `hidden`、`title` 提示、正好 8 格、
     带着 TUI 那句 `esc interrupt`、`■`/`⬝` 两种字符的规则、重试换色、手机上藏掉那句提示、
     **旧的平滑扫动(`ocs-sweep`)已经清干净**、`PBAR_CELLS=8` + `PBAR_FRAMES=54` + `PBAR_MS=40`、
     切在 `updateChatStatus()` 里、`paintProgressBar` 全文件只出现 2 次(定义 + 调用);
     **位置照 TUI 的 `prompt.footer`**:聊天标题行里已经没有它了、它排在 `.cinput` 之后且在 `#composer` 里、
     `styles.css` 给了那行的版式、**收起成细边时它也看得见**(`order:-1` 排最左 + 藏掉 `esc interrupt`);
     **压缩**:面板消费 `session.compaction.*`(实测压缩跑到一半 `/api/session/active` 会空一拍,只认它条会中途灭掉)、
     有 `compactionRunning()` 这个单一判定(事件 + 最新一条消息的 `status` 兜底)、
     压缩消息画成 TUI 那种一块(不再是 `· compaction` 一句)、有 `.msg.compaction` 的样式(行首 spinner 定宽)、
     概要正文按 `session.compaction.delta` 流式攒起来(`store.compactText`)并以摊开形态印在 `<details class="compact" open>` 里,
     而 `.delta` 这一支【不许】重画左栏 / 不许动压缩标记(那是老路上 142 次 `renderSessions()` 的假死根子)。
     逐帧对表在 `ui-stream-run.js` 里做(整圈 54 帧,不是只对前半圈)
   - K 组的 18 项(手机端):内联判定脚本同时定义 `OCS_NARROW_MQ`/`OCS_SHORT_MQ` 并当场加类、
     **断点数值只在 `index.html` 出现 1 次**(`styles.css`/`app.js` 里 0 次)、
     `styles.css` 里 `@media (max-width…)`/`@media (max-height…)` **0 处**、
     `#backList`/`#btnFilters`/`data-act="more"` 存在且桌面默认 `display:none`、
     窄屏两屏二选一的规则 + `view-chat` 由 `store.selected` 派生、
     窄屏复位桌面折叠态、`dialog.dlg` 的 `min-width` 归零、命中区 44px、输入控件 16px、
     `--chat-fs` 全文只定义 1 次、`setupNarrow()` 接进 `init()` 且只出现 2 次、监听了 `change`。
   - M 组的 16 项(底板收起/展开):`index.html` 有 `#btnComposer`/`#cstripMeta` 且手柄只有一个、
     手柄在 `#composer` 里且是 `.chip`、**收起的隐藏名单里没有「中断」**(运行中它是唯一不能藏的)、
     手柄样式绝不 `display:none`、手机上细边有 44px 级高度且给手柄让了位、
     `paintComposer` 里有「没有手柄就不收起」的守卫(新 app.js 配旧 index.html 不会把底板锁死)、
     两份记忆的键名、没记过时默认值跟着 `html.narrow` 走、`syncNarrowClass()` 里会重读、
     `renderAttachments()` 会同步细边提示、drop 处理器里会 `expandComposer()`、
     `setupComposerToggle()` 接进 `init()` 且只有一次,以及两个测试文件都在。
     真正的行为验证在 `ui-composer-run.js`。
   - N 组的 6 项(运行中的工具行**行尾**不画状态标记、**行首**那个标记要动起来):`statusInfo` 的 `running`/`streaming` 两条
     **图标与标签都是空的**、`toolHead` 见两者皆空就整个 `<span>` 都不输出(不留空壳)、
     对话头部那句 `● 运行中` 还在、`✓`/`✗ 出错` 这两个可读标记没被顺手删掉;
     另外行首 spinner 用的帧表与间隔跟 TUI 的 `dots` 组一致(`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` / 80ms)、
     `toolHead` 按运行状态换行首标记、`.tmark.spin` 定宽占位。
     真正的行为验证在 `ui-tools-run.js` 与 `ui-stream-run.js`。
   - N3 组的 6 项(消息体工具卡照 TUI 对齐,见移动端设计 §8.22):行首图标表(照 TUI 的
     read/list `→`、write `←`、glob/grep `✱`、webfetch `%`、websearch `◈`、shell `$`、其余 `✓`)、
     `TOOL_ALIAS` 归一(bash→shell / task→subagent / apply_patch→patch)、`toolLine` 印的是 TUI 的
     **组件名**(`Read`/`Glob`/`Grep`/`WebFetch`/`Web Search`/`Edit`/`Skill`/`Asked `)、
     块标题 `# Wrote` / `# Questions`、diff 徽标 `# Created` / `# Deleted` / `← Patched`、
     诊断行 `Error [行:列] `。
     真正的行为验证在 `ui-tools-run.js` 与真面板探针(`/tmp/ocsm-probe/perf/tools-shot.js`)。
   - O 组的 13 项(一键回底):`#jumpLatest` 在 `#messages` **里面**(只有滚动容器内部的
     `sticky` 才钉得住)、默认 `hidden`、文案 `跳到最新 ↓`、`position: sticky` + `bottom: 8px`、
     **显式写了 `#jumpLatest[hidden] { display: none }`**(id 选择器的 `display: block` 会压过
     `.chip[hidden]`,不写就藏不住)、`BOTTOM_SLACK` + `atBottom()` 这一处口径、
     **判据只在 `updateJumpLatest()` 一处、摆平「什么才算用户往上滚」**(容器变矮 / 内容变长也会让离底变远,
     所以不能拿那一次几何读数当结论:离底 `< BOTTOM_SLACK` → 跟随,`scrollTop` 比 `store.lastTop` **变小**了
     → 让路,其余维持原样;见移动端设计 §8.23)、
     **贴底动作只有 `pinBottom()` 一处**(滚到底 + 记下 `lastTop`)、**容器变矮当场重贴底**(新 `ResizeObserver`)、
     **深链没有存档时不再塞 `pending`**(否则会拦住 `forceBottom` 而停在最上面)、
     增量重绘(`paintLiveDelta`/`paintCompactBody`)只读 `store.nearBottom`,不自己去读 `scrollHeight` —— 改完 `#messages` 再读一次会把整篇 7800 节点强制重排,见移动端设计 §8.16、
     `updateJumpLatest()` 是 `nearBottom` 缓存的唯一写点、且会把被 `innerHTML` 清掉的按钮搬回末尾、
     `End` 键(且挡了输入框)、快捷键清单里有 `End`、`setupJumpLatest()` 接进 `init()` 且只一次。
     真正的行为验证在 `ui-jump-run.js`(它连 sticky 的实际位置都量)。
   - P 组的 10 项(鼠标靠左边缘临时拉出列表):`main.list-peek` 那几条**写在 `main.list-hidden` 之后**
     (同优先级靠顺序赢)、临时展开仍是三列且用 `--list-w`、`mousemove` + `mouseleave` 接线、
     收回按「分栏槽右沿」判定而**不用 `relatedTarget`**(临时展开会把槽从光标底下挪走)、
     窄屏挡一道 + 重复接线保护、点手柄把临时态摘掉、`setupListPeek()` 接进 `init()` 且只一次、
     **动手之前先武装宽限期**(`PEEK_HOLD_MS` 里 `mouseleave` 与 `mousemove` **两条路径都不收** ——
     弹窗期间浏览器丢过来的那串「指针跑掉了」的事件不止一发,只吞一次挡不住)、
     **`onAction()` 动手前叫 `listPeekHold()`**(不然删完一个会话列表当场被收掉)、
     到点按「指针最后一次真实移动停在哪」复查。
     真正的行为验证在 `ui-layout-run.js` 的 3c / 3d 组。
     来源白名单那三条语义(默认值 / 空=不限制 / 配错=全拒)由 `netallow-run.js` 正面覆盖,这里不重复。
   - Q 组的 24 项(上下文用量 + 输入框下面的提示栏):`#promptFooter` 在 `#composer` **之后**、`#ctxInfo` 在 `#promptFooter` 里(照 TUI 把用量放到对话框下面,按 `HTML_FLAT` 的字符偏移量断言)、**收起成细边时它跟着藏**(§8.40:`#composer.collapsed ~ #promptFooter { display: none; }`,细边上只留进度条与 `■ 中断`)、**手机上整条不显示**(§8.42:`html.narrow #promptFooter { display: none; }`,收起那条在窄屏其实用不上、管的是桌面)、同一条里还有 `#chatAgent`(智能体·模型,排最左)与 `#chatDir`(工程路径)与 `#cmdHint`(`ctrl+p commands` / `/ 命令` 两档)与 `#agentHint`(`tab agents`)、五格顺序 `智能体·模型 → 路径 → 用量 → tab agents → ctrl+p commands`、全量/窄屏两档文案都在 DOM 里、styles.css 按 `html.narrow` 切档(用量与提示各一对规则,且有 `html.narrow #promptFooter.armed …` 那对「上膛时收起」的规则)、
     `lastUsageMessage()` 里「最后一次已完成压缩」那一步、`contextUsage()` 里的五路 tokens 求和与 `limit.context`、
     `fmtSize()` 是 TUI 的 `zN`(155600 → 155.6K)、窄屏文案是 TUI 的 compact(`78% ctx`)、
     `paintContextUsage` 的六个调用点(updateChatStatus 两分支 + renderControls + 分支回来补画 + home 到位后补画 + 深链补拉会话后补画)且与渲染共用 `currentMessages()` 口径、提示栏随 `paintContextUsage()` 一起画(`paintPromptFooter`)、`#chatAgent` 由 `paintFooterAgent()` 从工具栏下拉取文案(接了 `paintContextUsage()`)、点 `#cmdHint` 开命令面板、点 `#agentHint` 切智能体、用量前面接「N subagents · M shells」(子→父来自 `parentID`/`session.created`,shell 来自 `shell.created/exited`)、用量后面接 `session.cost`(>0 才印)、路径拼 `:git 分支`(走 `/api/vcs`)、按 home 缩成 `~/…`(`/__health` 提供 home)、输入框里无 Shift 的 `Tab` 也 `cycleAgent`(照 TUI 的 `agent.cycle`;命令面板/@ 补全开着时先归它们)、上膛时给 `#promptFooter` 挂 `.armed`(照 TUI 的 `showDetails`)、列表页里没有的会话按需补拉一次(`refreshSessionInfo`,并挡住空数组响应),
     以及 ui-stream.html 里有行为断言。真正的行为验证在 `ui-stream-run.js` 与真面板探针。
   - R 组的 6 项(消息体里探索类工具行折成一组,见移动端设计 §8.24):探索工具表照 TUI 的
     `explorationTools`(read / glob / grep / webfetch / websearch 五类,`list` 不算)、计数与复数照
     `GroupContent.label()`(grep / glob / websearch 算 search、webfetch 算 fetch,复数加 es)、
     跑着时 `Exploring` / 全部收工换 `Explored`、探索组默认折着(`<details class="explore" data-def="0">`)、
     相邻的探索工具在 `renderMessage()` 里并成一组、`.explore > summary` 与 `.explore .gbody` 的样式;
     R2 组的 5 项(思考块行头,见移动端设计 §8.28):标题正则照 TUI 的 `reasoningSummary`(只认最前面那段
     加粗 + 空行)、行头文案照 `Thinking` / `Thought` + 标题 + `N steps` + 时长、相邻的思考段并成一块、
     摊开时把标题收起来(CSS 反应,照 TUI 展开那款不印标题)、时长格式照 `Locale.duration`;
     R3 组的 4 项(窄屏优化,见移动端设计 §8.25):提示栏第一格拆成 `.agName` / `.agModel` 两格、
     窄屏收掉 `.agModel` 并把那格宽度上限放宽到 40%、`#chatOps` 改 `inline-flex` 让「加载更旧消息」落在
     同一行、窄屏下 `#older` 跟旁边几个 chip 一样 40px 高;
     R4 组的 6 项(助手消息脚注,见移动端设计 §8.27):脚注四格 `智能体 · 模型 · 时长 · tok/s` 都在、
     时长与速度用的是 TUI `turnDuration` / `turnTokensPerSecond` 那两条算法(先加总再除)、
     出错 / 重试 / 中断三种情形齐(中断单独认,不算出错)、模型名从头部挪到脚注(头部不再印)、
     重试倒计时每秒重算、脚注样式(智能体绿 + 出错灰 + `Error` / 重试两行);
     R5 组的 2 项(翻页游标,见移动端设计 §8.26):首屏带 `order=desc`、翻页只带游标,
     以及「不再出现 order 与游标一起发」的那种写法;
     R6 组的 3 项(用户消息照 TUI,见移动端设计 §8.29):skill 与 file / dir 徽标、抬起底色块与徽标两格的样式、
     skill 那颗外层不带边框(颜色由里面两格给);
     R7 组的 4 项(Tokens 块,见移动端设计 §8.30):总览文案与缓存失效提醒、轮次边界(idle 收 / 老会话终步收)
     与 `cacheReuseDrop`、块的样式、`.meta` 不再无条件重复一份 tokens;
     R8 组的 3 项(待发送队列收一条,见移动端设计 §8.31):行头文案与换行压成空格、展开态跨重画留住、dock 的样式;
     R9 组的 4 项(其它消息种类照 TUI,见移动端设计 §8.32):切换类三行、通知类(收工行 + ◈)、
     `idle` 与没描述的 `synthetic` 不出行、这些行的样式;
     R10 组的 4 项(选择框的细节,见移动端设计 §8.33):当前值那枚 `●`、底部动作/键位那行、
     空态分两种、`●` 与底部那行的样式。
     真面板探针是 `/tmp/ocsm-probe/perf/narrow-audit.js`(dump 头部那一行 / 提示栏两格宽度 / `.explore` 的文案与开合 / 越界的元素,并截图)、
     `/tmp/ocsm-probe/perf/footer-audit.js`(dump 最后几条助手消息的头部与脚注各格)、
     `/tmp/ocsm-probe/perf/older-audit.js`(点一下 `#older` 看条数涨不涨、抓请求 URL)。
  - 脚本里比较文本用的是自带的 `has()`(`case` 字面量匹配),**刻意不用 `printf | grep -q`**:在 `set -o pipefail` 下 `grep -q` 命中即退出会让 `printf` 收到 SIGPIPE,整条管道随机判失败(实测 300 次里失败 1 次),冒烟会间歇性假红。
- `e2e-asks.sh`:15 项。会创建一个临时会话并在结束时删除;验证 `list` 不含 `state`、未激活字段/未确认 `external` 被拒 `400`、正常应答 `204` 且答案一致、`string+options` 字段收**字符串**答案(`question` 工具的单选形状)、重复应答 `409`、带 `Expect: 100-continue` 的大请求不被代理卡死、取消 `204`。
- `e2e-controls.sh`:22 项(开 `OCS_E2E_LLM=1` 为 31 项)。同样只用临时会话;验证 agent/model 切换持久化、`model` 缺字段 `400`、空闲中断 `interrupted=false`、inbox 负例,以及(可选)真实运行中的 `queue` 投递、改投递、取消、中断。
- `e2e-capabilities.sh`:26 项。只用临时会话与 `/tmp` 临时目录,结束时全部删除;验证新建的字段落库、`PATCH metadata` 的整体替换语义、导出脱敏与否、导入的换 ID 与 `location` 重挂、以及 `409`/`400` 负例。
- `e2e-stream.sh`:4 项(开 `OCS_E2E_LLM=1` 为 27 项)。默认部分只验证事件流形状(单行 `data:`、无 `event:` 行、首帧 `server.connected`、每帧合法 JSON);开了 LLM 后追加真实流式断言:出现 `step.started`、增量 `>= 5` 个且**累加严格等于** `ended.text`、事件顺序 `started→delta→ended`、`step.ended` 带 finish 与 output tokens、`execution.succeeded`,以及**流式期间服务端不提供半成品文本**(这正是前端必须自己消费增量的原因)。默认模型未必配好,可用 `OCS_E2E_MODEL=provider/modelID` 指定。
- `ui-asks-run.js`:57 项浏览器内断言(真实 `public/app.js`),覆盖字段渲染、默认值预填、`when` 显隐、单选+自填互斥、答案组装、本地校验分支、非 http(s) 链接不可点击;其中 10 项专门钉住 `question` 工具的真实字段形状(`type:"string" + options + custom:true` 必须画成**可点的选项行**、答案必须是字符串而不是数组、自填与选项互斥)。
- `ui-controls-run.js`:102 项浏览器内断言,覆盖 agent/model 选择器的过滤与分组、切换请求体、变体显隐、中断/投递控件的显隐、运行状态文案与列表标记、待发送队列渲染与操作请求、发送时的 `delivery` 选择、**运行中的默认投递是「插话」**(照 TUI 的 `Enter` = `prompt.submit`;排队是 `<leader>return` = `prompt.queue`;工具栏切一下两边都亮对、非法值回默认)、**中断带 `resume=true` 并把队列里的 `user` 项改成 `steer` 放行(插话项与控制项不碰)**,事件到运行状态的映射。另有 6 项跟着 §8.31 锁**待发送队列收一条**:收在一条 `details` 里且默认收起(`data-def="0"`)、行头 `N queued · 下一条`、逐条那列一行没少、展开态跨重画留住、换行压成空格、只有控制项时行头只留计数。另有 6 项跟着 §8.39 锁**选中的会话不在列表页里时工具栏不消失**:`renderControls(undefined)` 时 `#ctoolbar` 照样亮着(改前是 `if (!s || !store.selected) bar.hidden = true`,细边上「■ 中断」的家会整条没)、选择器清空且不拿上一个会话的值冒充、变体选择收起来 —— 只有**未选中**才收起。
- `ui-capabilities-run.js`:174 项浏览器内断言,覆盖归档判定与列表过滤、归档请求体的读-改-写、新建/导入的本地校验与请求体形状、`409` 重试、导出 URL 与下载内容、`tuiCommand` 的引号转义。另有 3 项跟着 §8.39 锁 `renderChatOps()` 在「选中了但会话不在 `store.sessions` 里」时也显示、拿不到会话信息时先按「归档」画、并清掉上一个会话的「已归档」高亮。另有 11 项跟着 §8.45 锁**拉会话列表失败不再一声不响**:`#listState` 在左栏里、排在「加载更多」之前、默认收着、带 `.msgstate` 与 `.chip`、重复接线不挂监听;失败时露原因(`加载失败:…`)并标 `.bad`、重试跟着露、`store.listError` 留得住;点重试从头拉一遍(`reset`、不带 `cursor`),成功后那条自己收起来、列表照旧填回去。另有 16 项跟着 §8.56 锁**新建 worktree**:开关默认不勾且名字行收着、`wtSlugify` 照 TUI(含中文/符号/纯横线)、随机名是 `adjective-noun`、勾上露出并自动给名、按目录解析 `projectID`、`POST /api/worktree` 的请求体、会话开在返回目录、源目录与 worktree 目录都记住、创建后自动选中、名字留空提交时随机、服务端拒绝时不发 `/api/session`、错误里是服务端 `data.message`、会话 POST 失败后原地重试不再建第二棵 worktree。另有 11 项跟着 §8.57 锁**变更总览**:`/diff` 请求打到 `.../diff?context=3`、按文件渲染徽标/路径/增删、统计行 `N 个文件 · +X -Y`、框里不出并排按钮、`/diff` 在面板命令里且能解析、空结果、轮次还在跑时的空结果文案、失败显示服务端原话并清空正文、刷新后错误收起且内容回来、没选会话时不开框也不发请求。另有 24 项跟着 §8.59 锁**最近会话标签栏**:节点在 `#chatHeader` 之前、没标签时整条收起、读回时去重并只留最近 8 个、打开会话自动入栏且标题取会话列表、重复打开不重复、选中后高亮与 `aria-current`、点 tab 直切、关非当前标签只移出且不删会话 / 不发 `DELETE`、关当前标签切左/右邻居、关最后一个回到未选择并收起、最多 8 个丢最旧、`localStorage` 只存 id + 标题、列表标题更新会同步并回写、`+ 新建` 复用现有框、窄屏 34px / 只留一个加号 / 只有当前 tab 露 `×`。另有 21 项跟着 §8.61 / §8.65 锁**工作树管理**:`/worktrees` 在面板命令里、打开时先取会话最新目录再 `refresh` 并按 `projectID` 列、当前根排最前且标 `●`、按 `subpath` 列子目录并跟在自己的根后面、子目录行标「子目录」、会话在子目录时高亮子目录行、点工作树进动作菜单、移入走 `session/move` 并把本地会话目录与提示栏一起更新、主检出的删除项与当前目录的移入项都禁用、子目录只能移入不能单独删、删除只对 `strategy` 开放且请求体带 `projectID` / 目录 / `force:false`、删除后重新列、`forceRequired` 时先读 `/api/vcs/status` 列出文件、预览点取消不发 `force:true`、点「仍然删除」再带 `force:true` 重试、status 读不到退回 `confirm`、删掉当前会话所在工作树后清空选中回列表、没选中时只提示不发请求、列表失败与移入失败都报服务端原话且本地目录不动。另有 10 项跟着 §8.63 锁**/diff 四档来源**:四档按钮齐全且默认最近一轮、`working` 走 `vcs.diff` 不带 base、不显示基线按钮、没有 review base 时不猜分支也不发 `vcs.diff`、基线选择复用 `#dlgPick` 并列出分支、选完自动重载、`committed` 优先用服务端 base、未提交档空结果文案、`vcs.diff` 失败显示服务端原因、切回最近一轮回到 `session.diff`。另有 7 项跟着 §8.64 锁**/diff 文件树与 reviewed**:多文件时列出并以第一项高亮、徽标区分修改 / 新增、点文件会滚动正文并换高亮、勾已看只改树与计数不重造正文、再点取消、切来源后 reviewed 归零、单文件与空结果时树收起。
- `ui-stream-run.js`:259 项浏览器内断言,覆盖增量累加、`ordinal` 按类型计、`*.ended` 权威覆盖、结构指纹不含文本长度(所以 delta 不触发整条重建)、节点 identity 保持(局部重绘)、多文本块序号映射、光标位置与思考块展开箭头、服务端半成品不覆盖本地文本、权威版本到达后回收缓冲且不重复渲染、非当前会话的缓冲不进入视图、陈旧缓冲回收,以及防抖对账的分流规则(有缓冲的 delta 不排重取、无缓冲的 delta 退回重取)、§8.54 / §8.67 的慢网对账(全局与别的会话的事件不排重取、只有当前会话才排、后台对账不闪 250ms 状态行、飞行中合并成一条、内网落地后隔 800ms / 慢链路 4000ms 再排、前台照旧会闪)。其中 6 项是工具卡片的回归锁:`tool.progress` 带来 `metadata.files` 时状态没变也要把 diff 重绘上屏,metadata 没变则不重建 DOM;另有 8 项锁**运行中的工具行首 spinner**:DOM 里确实有 `.tmark.spin`、定时器是 80ms、`__tick()` 走一帧换到下一个字形、重绘不回跳相位、没有运行中的工具后定时器停掉。还有 32 项锁**上下文用量**(照 TUI 的 `Us`/`XN`/`d4`;位置照移动端设计 §8.19 挪到输入框下面):没跑过整块收起、取最后一条带 tokens 的助手消息(前一条不算)、`150.0K (75%)` 与窄屏 `75% ctx`、title 给精确 tokens、**压缩之后重新起算**、只有压缩没有回话时收起、模型不在该 location 模型表里时只给 token 数(percent 可空)、`step.ended` 一到就从本地缓冲立刻算出来(`200.0K (100%)`)、取消选中后收起、用量后面接 `session.cost`(`>0` 才印,为 0 不印);以及**子会话 / shell 那一段**(照 TUI 的 `session.family` + `shell.list`):正在跑的子会话数印在用量前、跑完的不数、单个用单数、别的会话的不算进来、子会话与 shell 一起 ` · ` 连、`shell.created/exited/deleted` 记/划、`session.created` 带 `parentID` 记在册、只有子会话没用量时那格照露;另 18 项锁**提示栏**:跟着会话显隐、路径文案与 `title`(§8.44:「还不知道」时那格留空、到手后再印)、目录不再重复进 `#chatMeta`、提示两档、条里还有 `tab agents`(照 TUI 的 `agent.cycle`)、最左 `#chatAgent` 的位置与「智能体 · 模型」文案(默认变体不印、非默认接 ` · 变体`、工具栏收起时跟着收)、路径拼 `:git 分支`、按 home 缩成 `~/…`(home 正好缩成 `~`、不在 home 下原样、home 未知不缩)、取消选中整条收起。另有 10 项锁**压缩正文走局部重绘**(见移动端设计 §8.16):正文又长一段时只换 `details.compact > .content` 那一个节点、不触发整表 `renderMessages()`、压缩块元素原地不动;正文从无到有(块里还没 `<details>`)时返回 false 让整表建一次,建好后局部接手。另有 3 项跟着 §8.22 改了期望(shell 的整条命令进 `.tname`、`.tdesc` 留空、完成与运行中都不再出现 `tstate`、shell 卡片正文行首回到 `$`)。另有 4 项跟着 §8.25 锁**窄屏只留智能体那格**:窄屏下 `.agModel`(`display:none`)、`.agName` 照旧露着,宽屏转回来那格又看得见,而整条的 `title` 里模型名始终没丢。另有 7 项跟着 §8.27 锁**模型名从头部挪到脚注**:收工前不印模型名(脚注是 `step.ended` 之后才有的)、头部不再有 `.turn-head .model`、收工后 `.afoot` 出来且智能体名首字母大写、模型名来自模型表(`Flash`)、时长按整轮算、`tok/s` 那格在、模型名只在脚注。
  另有 20 项给**运行状态条**(TUI 的 `prompt.footer`,在输入框**下面**那一行):元素与 8 格骨架、挂在 `#composer` 里且在 `.cinput` 之后(位置不再是标题行)、`progressCells()` **前半圈 14 帧逐帧**与 TUI 实测序列一致(写错一格就红)、**整圈 54 帧**(14..16 空三拍 → 17..29 倒着重走 → 30..53 长空 ~1 秒 → 第 54 帧绕回第 0 帧)、负数帧也当循环内、按 40ms 挂表、推一帧后格子跟着变、系统开了「减少动画」也照样逐帧推(**不看** `prefers-reduced-motion` —— 终端里没这个概念,当初为它让路的结果是「电脑上状态条不动、手机上正常」)、复位后又能推,以及空闲/重试/未选中三种收展;另有 57 项给**压缩上下文那一块**:`session.compaction.started/.ended` 落进 `store.compacting` 且收工即清、压缩中也算「这个会话在跑」(列表徽标与排队判定共用同一个 `isRunning()`)、消息列表里最新一条压缩消息 `status==='running'` 作为刷新后的兜底(过期标记会自愈)、压缩块渲染成独立的 `.msg.compaction`(块头「上下文压缩」、进行中标「进行中」且行首是会转的盲文 spinner、挂 80ms 表)、完成后回到静态 `⏺` 并给出 `N tokens`、摘要按 Markdown 渲染并**摊开印着**(外层 `details` 留作折叠抓手;用户折起来之后后面来的正文不会又把它顶开 —— `syncDetailsOpen()` 只搬「用户折过」这一种),`error.type==='aborted'` 标「已取消」、行首 `✗`,以及完成/取消之后状态条收回去;其中 31 项专锁**概要正文的流式打印与那次假死**:`.started` 按 `inputID` 立刻放一块「进行中」进消息流、**`.delta` 不重画左栏**(三条 delta 就是三次 `renderSessions()` 的老路,逐条数着)、`.delta` 不抹掉压缩标记、正文一段段攒进 `store.compactText`、三条 delta 只画一次对话区(节流)、压缩中就把正文按 Markdown 摊开印出来、用户折起来后不被顶开、`.ended` 就地收工并把载荷里的完整摘要写进消息。
  这套测试页把 `setInterval` 换成**记录下来但不真跑**(`__tick()` 手动驱动),所以帧序是确定的,不靠等。
- `ui-tools-run.js`:339 项浏览器内断言,覆盖 `parsePatch`(双向行号 / 空上下文行 / 文件头与分隔行 / 末尾换行)、`diffHtml`(状态徽标与统计、多文件分块、无 patch 的删除文件)、**行内高亮**(§8.49:`hlRanges` 的逐字 / 多段 / 纯增 / 纯删 / 公共前后缀 / 空值 / 超长 / emoji 八种形态,真补丁里删侧不亮而增侧只亮插入段,`textContent` 与原文一字不差、HTML 照样转义)、**语法着色**(§8.50:`langOf` 的扩展名表与「不认识的就不猜」、关键字 / 字符串 / 数字 / 注释四类区间、字符串里的关键字不误判、转义引号不提前收尾、行注释吃掉整行、块注释只吃到 `*/`、shell 的 `$#` 不是注释、CSS 属性与十六进制颜色、markdown 标题与行内代码、html 标签与属性值、叠加行内高亮时的嵌套顺序、hunk 行不上色、`write` 正文给了路径才上色且文字不变、字符串里的 HTML 照样转义)、**并排视图**(§8.52 / §8.53:`diffViewWanted` 的三种形态、只有 modified 分栏、不够宽不分栏、`added` 文件即便偏好 split 也保持统一、左右各带自己的行号、一侧落单留空单元格、上下文与 hunk 整行跨两栏、行内高亮与语法色跟着进两栏、窄屏强制统一、偏好写进 `cli.json` 的 `diffs.view`(localStorage 只做缓存)、真点一下所有卡片一起换形态再点回来、面板变窄/变宽时 auto 档自动翻面)、**统一视图折行**(§8.58:长行 `white-space: pre-wrap` / `overflow-wrap: anywhere` 真的折了、`.src` 不把容器撑宽、`added` 行的新行号仍在第一行)、**TUI 偏好共享**(§8.60:点并排会 PATCH `{view:"split"}`、health 带回的 `unified` 会改偏好并重画、旧 mtime 不覆盖新值、非法值不动偏好、首屏 GET 读回、旧 localStorage 只迁移一次、写失败提示但本页仍按刚点的值工作)、**重画 diff 只换正文**(§8.62:40 张卡片时 details / summary / 正文容器 / 诊断块的节点身份不变、`.diffwrap` 里的 `.dfile` 换新、折叠状态与正文滚动保留、焦点回到同一 pid 的切换按钮)、`codeHtml`(行号)、`diagHtml`(精确与宽松路径命中、0 基转 1 基)、`inputSummary`(取值优先级与压平)、`toolHtml` 对 `edit`/`write`/`patch`/`question`/`skill`/通用工具的分派与「默认展开」,以及 `userRefsHtml`(agent `@` / skill `#` 标记、缺 `name` 用 `id` 兜底、都缺则跳过、名字转义、在 `renderMessage` 里的顺序与「没有提及时不产生空行」)。其中 8 项锁**运行中的工具行不画状态标记**(对话头部那套已经说过了,手机竖屏上那个「运行中」还会折成「● 运」「行中」两行):`toolHtml` 出来的 HTML 里既没有「运行中」也没有 `tstate`/`●`(整个 `<span>` 都不输出,不留空壳)、`running`/`streaming` 的 `icon` 与 `label` 都是空串、`cls` 仍是 `run`(别处按状态分类要用)、而完成与出错的 `✓`/`✗ 出错` 照旧在工具行上画。另有 8 项锁**运行中行首那个标记会转**(照 TUI 的 `dots` 组、80ms 一帧):帧表与间隔、运行中行首是 `.tmark.spin` 且不再画 `⏺`、完成/出错回到 `⏺`、`toolRunning()` 的判定。另有 24 项锁**消息体工具卡照 TUI 对齐**(见移动端设计 §8.22):`toolIcon` 的图标表(read/list `→`、write `←`、glob/grep `✱`、webfetch `%`、websearch `◈`、shell `$`、其余 `✓`、出错 `✗`)与 `TOOL_ALIAS` 归一(`bash`→`shell`、`task`→`subagent`、`apply_patch`→`patch`)、`toolLine` 的拆法(工具词进 `.tname`、余下上下文进 `.tdesc`,**shell 是例外** —— 整条命令进 `.tname`、`cd <工程目录> && ` 前缀照 TUI 接上,没给命令时才印 `Writing command…`)、块标题 `# Wrote`/`# Questions`/未答的 `Asked N question(s)`、diff 徽标 `# Created`/`# Deleted`/`← Patched` 与 `.dnote` 的 `-N lines`、诊断行 `Error [行:列] msg`,以及 `normPath`/`abbrevPath` 的缩略规则(会话目录下取相对、base 自身给 `.`、home 下 `~/…`、取不到会话目录就原样)。另有 34 项锁**探索类工具行的分组与思考块摘要**(见移动端设计 §8.24):分组的触发形态(两条 read 并一组、`read`+`grep` 混着也并、`list`/`write` 不并)、不触发的边界(不相邻、单独一条仍然折、`EXPLORE_MIN_RUN`/`EXPLORE_TOOLS` 这两个开关)、`exploreLabel()` 的计数与复数(`2 reads` / `1 search` / `2 searches` / `1 fetch` / `2 fetches`、多条以 `, ` 连)、跑着时 `Exploring` + 行首 spinner、收工时 `Explored:` + `→`(冒号连在工具词那格,免得行内 `gap` 在冒号前留缝)、`.gbody` 里原来那些工具行一个不少、`data-def` 与 `syncDetailsOpen` 两头搬(用户摊开的探索组不被下次重绘合回去、没带 `data-def` 的思考块仍只搬「折起来过」那一种),以及 `reasoningTitle`/`fmtDur`/`reasoningHead` 的三种情形(有标题 + 时长 / 只有标题 / 连时间都没有)。另有 14 项跟着 §8.68 锁**跨消息探索并组**:吸收计划只认非终步(`tool-calls` / `unknown`)且整条都是探索工具的续步、续步换成 hidden 占位且 `data-absorbed-by` 指向吸收方、上一段最后一个探索组合并计数、占位顺序与 `msgEls.absorbed` 归属、续步内容变化触发重绘且用户摊开状态留住、上一段删除后续步恢复成独立消息、续步删除后上一段收起,以及正文 / 终步 / 纯 shell 不吸收、前一段带正文仍可吸收、`idle` 不打断。另有 4 项跟着 §8.69 锁**子会话收工行跳转**:`metadata.childID` 写进 `data-child` 且带 `role="link"` / `tabindex="0"`、shell 收工行不带、点一下切到子会话、键盘 `Enter` 也能切。另有 22 项跟着 §8.32 锁**其它消息种类**:`switchLabel` 的四条分支(查表 / 补档 / 同模型只报换档 / 退回 `providerID/id/档`)、`model-switched`、`agent-switched`(from…to 与只写 to 两种)、`location-switched`(`.swPath`)、`system`(含没描述的兜底)、`synthetic` 的 `◈` 与子会话 / shell 收工行(actor 大小写、空白压平、`error` 红 / `cancelled` 琥珀 / `completed` 才是 ↳)、`skill` 消息、`msgHidden` 的三种情形,以及走一趟真渲染确认 `idle` 与没描述的 `synthetic` **压根不建元素**。另有 25 项跟着 §8.30 锁 **Tokens 块**:五路求和的 `tokenTotal`、`cacheReuseDrop` 的四条分支(没有上一趟 / 换模型 / 掉量 / openai 的 1024~2048 桶)、块只印在收尾那一步、总览文案(`N steps · latest: new · cached · total`)、默认收起、表头与每行(`tool-calls` → `tool-call`)、缓存失效的总览尾巴与表里那行(复数 `busts`)、老会话遇终步收轮、还在跑的那轮不印块而把 token 数留在 `.meta`、收工后 `.meta` 只留费用、和为 0 的步不进表、整轮没有 tokens 就不印块、压缩完成后上一轮的 cache 作废。另有 9 项跟着 §8.28 锁**思考块的组行**:收工后 `Thought` + 折着带标题 + 时长、没标题就不带 `.rTitle`、连时间都没有时只有 `Thought`、跑着时 `Thinking` + 标题 + 自动摊开且不给时长、标题里的 HTML 被转义、相邻两段并成一个 details(带 ` · 2 steps`)、并起来那段时长是各段之和、正文还是两段、标题取最后一段的、被文本隔开的各成一块、最后一段没标题且已收工就清掉标题、还在跑则沿用前一段的标题、跑着那块不给 steps / 时长。另有 22 项锁**助手消息脚注**(见移动端设计 §8.27):智能体名首字母大写(连字符后也大写)、时长按**整轮**算(本步完成 − 本轮输入创建)、表里没有输入消息时退回本步创建、各格之间用 `.afSep` 连、缺 `time.streamed` 时整个速度格不印、速度按本轮各步加总再除(两步 300 token / 3s = `100.0 tok/s`,而第一步只算自己那一步)、没有 `completed` 时只留前两格、`live` 的消息不印脚注、中断认 `Step interrupted`(尾巴 `· interrupted`、不印 `Error` 行、智能体名灰)、出错时 `Error: <原因>` 且智能体名灰、重试时 `⚠ Retrying in Ns · attempt K · <原因>` 且带 `data-at`(每秒重算)、模型表里查不到时退回 `providerID/id`、模型名只在脚注、撞上 `idle` 就断轮。
- `ui-layout-run.js`:186 项浏览器内断言,覆盖列表折叠(箭头 `‹`/`›` 与 `aria-label` 翻转、**刷新同一标签页仍是收起的**(§8.38;**新标签页才是展开的**;临时拉出两份存储都不写)、重复接线不重复挂监听、**收起后分栏条仍可见且手柄点得到**、**收起态点手柄能重新展开**、**点手柄不会误触发拖宽度而点条上空白仍能拖**、收起后让出的正好是 16px 窄槽、收起再展开后自定义列宽 `--list-w` 不被吃掉)、
  **鼠标靠左边缘临时拉出列表**(3c 组 27 项:贴到左边缘就 `list-peek` 且列表可见、记忆 `list-hidden`/`localStorage` 一个字都没动、分栏槽跟着列表挪到右边、对话区仍有宽度、用的是用户拖出来的 420px 列宽、列表上有一道阴影、在列表里挪动不算离开、挪进对话区收回、移开主区收回、临时展开期间点手柄转成显式展开并保持、显式展开时乱动也不冒临时态、窄屏不玩这一套;**3d 组 13 项**专锁「动手之后别被弹窗收掉」:临时展开着真走一遍 `onAction('del')`、删完列表还留着、宽限期武装上了、宽限期里 `mouseleave` 不收、宽限期里那一发合成 `mousemove`(坐标落在对话区)也不收、到点复查(指针在对话区 → 收;还停在槽里 → 留着)、宽限期过后挪进对话区照旧立刻收、列表本来就开着时不武装),
  hash 持久化(`hashToID` 的边界、选中会话写 hash、删除后清 hash、`restoreFromHash` 恢复消息与标题、不抢已有选择、指向不存在的会话不炸、hash 为空/非法时不选;§8.55 删除时内存缓存也一起清)、
  **前进 / 后退**(点会话入栈、重复点同一个不多压一格、收到 `popstate` 切到 URL 里的会话且不重复入栈、后退到无 hash 时取消选中并清空对话区、空操作不入栈)、
  **会话内滚动位置**(跳到底部 / 存锚点 / 刷新后回到原处且确实不在底部 / 只还原一次 / **从列表切走再切回来也回到原处且不在底部** / 锚点消息不存在时退回像素值 / 无存档照旧 / **没有存档的长会话深链到底**(不塞 `anchor` 为 `null` 的 pending —— 那会拦住 `forceBottom`,长会话一打开就停在最上面,见移动端设计 §8.23 / §8.66)/ 上限 20 与淘汰顺序 / 存的是 `sessionStorage`;外加**长会话挂 `.cvmany` 让离屏消息跳过渲染、短会话不挂**(不留下「估值高度撑出假滚动条」的机会))、
  **顶栏条件持久化**(空存档的默认值、四项恢复、记住的目录不在结果里也能选回、四类控件改动即时落盘、清空搜库存空串、存的是 `localStorage`)。
- `ui-jump-run.js`:135 项浏览器内断言,覆盖一键回底「跳到最新 ↓」:形状(`#jumpLatest` 是 `#messages` 的**子元素**、`.chip`、默认 `hidden`、文案)、接线(`wired` 标记、重复接线不再挂监听、只按当前状态重画)、
  **显隐判定**(刚选中落底部时收起、往上翻就露出来、滚回底部又收起、短会话收起、没选中收起;**走浏览器真派发的那条 `scroll` 事件**,不是手动调函数;另外手工把 `hidden` 改错再补派发一次 `scroll` 就该被纠正回来,证明监听确实挂在 `#messages` 上)、
  **真布局**(露出来时它真的钉在滚动口下沿且贴右:底边在 `#messages` 底边之上 24px 内、右沿离内边距不到 40px、带阴影)、
  **口径**(79px 算在底部、80px 不算、`BOTTOM_SLACK === 80`)、**什么才算「用户往上滚」**(照移动端设计 §8.23:容器变矮 —— 状态条出现 / 底板展开 / `#asks` 弹出 / 软键盘顶起 —— 把离底距离撑大时**不关**跟随;`scrollTop` 比上次记下的**变小**了才关;让路期间容器变矮一动不动;`pinBottom()` 会把贴底时的 `scrollTop` 记下来,`atBottom()` 保持纯几何)、**新内容到达**(往上翻着时新内容进来按钮仍露着**且不把人拽到底部**;就在底部时仍然自动跟随且按钮不冒出来)、
  **点击与键盘**(点它回底并自己收起、不换会话不发请求;`End` 回底、焦点在输入框里不抢也不 `preventDefault`、对话框开着不抢)、以及**老页面兼容**(按钮不在 DOM 里时三个函数都不报错、补回来照常工作)。
  它连「切会话会把 `#messages` 整个 `innerHTML` 清空、按钮被一起抹掉」这条都验了:清空后按钮仍 `isConnected` 且 `parentElement` 还是 `#messages`。
   另有 11 项锁**窄屏滚到顶自动拉更旧**(见移动端设计 §8.41:那一行在手机上收起来了,翻旧全靠它)。7b1–7b7 直接调 `autoLoadOlder(box)` 把四条节流一条条断死:窄屏到顶自己拉一页且**带着游标**、还停在顶区不连着拉第二页、滚下去(离开顶区)什么都不发、重新上膛又拉一页、**桌面(不带 `narrow`)不接管**(翻旧仍是点那个按钮)、没有更旧的了不发、**上一页失败过不自己重撞**(那句「加载失败 + 重试」还在等用户);7b8/7b9 走真正那条路 —— `setupAutoOlder()` 挂上之后,顶区里**一发合成 `scroll`** 就带上一页、离开顶区再回顶又带一页(上膛是真的回了);7c1/7c2 断**拉完不许把人顶走**(夹具里给这个会话补一条**更旧的**长消息,这一页拉回来总高真的会长):眼前那条还是那条、还在屏上同一个 `off`,而 `scrollTop` 跟着长出来的那一截往下走 —— 不是停在 0 被顶到刚拉回那一页的开头。
  另有 2 项锁**「加载更旧消息」跟着选中会话走**(见移动端设计 §8.25):清掉选中之后 `#older` 收起、分页游标 `store.msgOlderCursor` 一起清掉 —— 原来只清 `store.messages`,这一格会一直露在头部(没选中会话时点了也没用),游标还会把上一个会话的页码带进下一个会话。
  另有 12 项锁 **§8.55 慢链路与切回缓存**:慢链路桌面 `msgPageSize()` 是 30、请求真的带 `limit=30`、
  滚到顶自动带上一页(桌面 LAN 仍然不接管);切回看过的会话时先同步画出缓存里的旧内容(不等网络)、
  不闪「正在加载消息…」、后台对账只发一条、1.5s 内再切回一条都不发、缓存上限 6。
  另有 5 项锁**翻页请求的 query**(见移动端设计 §8.26):首屏带 `order=desc`、首屏不带游标、翻页带 `cursor`、**翻页不带 `order`**(带了两样服务端就 `400 InvalidCursorError`,这正是「点了没反应」的原因)、没有游标时压根不发请求。
  另有 27 项锁**拉消息失败不许一声不响**(见移动端设计 §8.34,起因是「手机打开某个会话一片空白,
  电脑端回一句之后内容才出现」):状态行的形状与接线(`#msgState` 是 `#messages` 的子元素、默认 `hidden`、
  `.msgstate`、重试是 `.chip`、重复接线不再挂监听)、**慢的时候露「正在加载消息…」而 250ms 内回来不闪**
  (这一段用「排队等我手动放」的假定时器:重试退避与那句延迟提示都走 `setTimeout`)、
  **连打回 3 次**(首发 + 2 次重试)之后亮出 `加载失败:模拟打回` + 一个「重试」、状态行贴在消息流末尾、
  没消息就是没消息,以及**点「重试」真的再发一次、成功就把状态行收掉**、
  **半截正文(200 + 非法 JSON)与缺 `data` 数组都算失败**(不许静默成「这个会话没有内容」)、
  **切走之后旧会话的失败与重试都不许跟过来**、取消选中则把残留的失败话撤掉、`#msgState` 仍在 DOM 里。
  另有 5 项锁**一页拉多少条**(见移动端设计 §8.35):桌面(`html` 不带 `narrow`)一页 `limit=100`、
  手机(`html.narrow`)一页 `limit=30`、**窄屏翻旧也是 30**(不然翻一页又拉回十几 MB)、
  转回宽屏又按 100(口径跟着类名走,转屏即时生效)、两个常量与 `msgPageSize()` 只有一处。
  另有 17 项锁**贴完底再跟几帧 / 盯内容高度**(见移动端设计 §8.36 与 §8.46,起因是「打开会话停在
  最新消息上面一截」、以及「图迟一步撑开就跟不上了」):收手条件是高度稳定 + 一道自保上限(不再盯时间)、
  长会话挂着 `cvmany`、`#messages` 的子元素全在 `ResizeObserver` 的观察名单里、
  **高度稳的时候两条采样就收手**(不白等满上限)、**贴完底之后内容又变高(≈估值落定)会被自动贴回底部**、
  按钮不因此冒出来、**往上滚让路之后再变高一动不动**、按钮该露着、清掉高的那块再复位、
  **采样早收手之后图迟到撑开也照样贴回**(靠 ResizeObserver,不在任何时间窗口里)、
  **刚点过(<details> 撑高)不抢着贴**、**过了那 400ms 照旧贴**、**每一次渲染都把上一轮采样作废**(`repinSeq` 涨了)。
  另有 12 项锁**选中的会话不在列表页里时那两排不许消失**(见移动端设计 §8.39,起因是
  「手机端不显示导出/在TUI打开/归档那一栏」+「输入框下面只剩进度条」):用一个「列表页里没有它、
  消息却拿得到」的幽灵会话走一遍 `selectSession` —— 消息照旧拉得到(对得上用户看到的样子)、
  补拉会话信息照发、`#chatOps` 与 `#ctoolbar` 照样在、选择器空着不拿上一个会话的值冒充、
  归档文案先按未归档画;补齐会话信息后标题 / 「取消归档」/ 选择器三处都校正过来;
  以及**辅助请求(`/inbox`)卡住不返回时,补拉照样发得出去** —— 这条锁的是 `selectSession()` 里
  那句源码顺序(见 `smoke.sh` 的 R15)。

- `e2e-attach.sh`:32 项。只用临时会话与临时文件,结束时全部删除;验证①代理建好暂存目录并把 `uploadDir` 通过 `/__health` 告知前端、②`POST /api/experimental/fs/write?path=<绝对路径>` 原始字节写盘且内容逐字节一致、③`GET /api/fs/find` 给出相对工程目录的路径与基准目录、④提示词里的附件只认 `file:` URI(服务端自己补 `data`/`mime`,`name`/`mention` 原样落库)、⑤裸绝对路径/相对路径/`https` 三种非法 uri 都被 `400` 拒且原因可辨、⑥面板服务出去的 `app.js`/`styles.css`/`index.html` 确实带上了附件功能。
- `ui-attach-run.js`:133 项浏览器内断言,覆盖路径与大小的纯函数(`fileURI`/`baseName`/`joinDir`/`humanSize`/`uploadName`/`uploadPathFor`/`b64Size`)、`userFilesHtml`(uri 来源显示路径、inline 不显示、图片内联缩略图、按 base64 反算大小、缺 `name`/`mime` 兜底、转义、在 `renderMessage` 里的位置与「没有附件就不产生空行」)、`resolveMentions`(只认补全确认过的路径、锚点 `start/end/text` 切出来正好是那一段、多引用、中文里紧跟标点、邮箱里的 `@` 不算)、`@` 补全(光标前 token 的提取边界、请求参数含 `location[directory]` 的 deepObject 写法、目录名与文件名分列、上下键环绕、Enter 消费按键并插入+记忆绝对路径、Esc 关闭、点选、无匹配的空态)、附件排队(上传走 `fs/write`、POST、目标绝对路径、body 就是文件本身、chip 的名字/大小/来源路径/移除按钮、超限拒绝、上传失败回滚、拖放/粘贴/文件框三条入口)、以及 `send()` 的请求体(上传文件与 `@` 引用合并进 `files[]`、`mention` 锚点、成功才清空待发送列表、失败保留可重发、切会话清空并关掉补全、没选中会话时按钮禁用、暂存目录未知时先问 `/__health`)。
  其中 H 组那几项跟着 §8.29 改成「徽标 + 名字」两格:skill / file / dir 三款徽标、图片仍内联缩略图、名字缺省时用路径末段兜底。
- `e2e-commands.sh`:40 项。只用临时会话与 `/tmp` 临时工程目录,结束时全部删除;验证①`GET /api/command` 带回查询用的 `location.directory`、列表是数组且每项有 `name`、内置 `init`/`review` 与工程无关,②全新工程目录的命令表会被惰性建立起来(首次查询可能为空,所以要轮询),③工程内 `.opencode/commands/hello.md` 出现在该工程的列表里、换个目录就看不到(命令确实随 `location` 走),④未知命令回 `404 CommandNotFoundError` 且**不落任何消息**,⑤缺 `text` 回 `400 InvalidRequestError`(所以前端一律带 `text:''`)且同样不落消息,⑥真命令 `POST /command` 回 `204` 并把模板展开成**一条普通用户提示词**(`说 $ARGUMENTS 好` + `世界` → `说 世界 好`,只多出这一条消息 —— 这条正是面板走的路),⑦`POST /compact` 回 `200` 且带 `type: compaction`,⑧`POST /revert/stage` 与 `DELETE /revert` 存在,会话忙时回 `409 SessionBusyError`(面板据此提示「正在运行」而不是报错),⑨面板服务出去的 `app.js`/`styles.css`/`index.html` 确实带上了命令面板、全局键位与快捷键对话框。
- `ui-commands-run.js`:171 项浏览器内断言,覆盖①`cmdQuery`(行首判定、词中间的 `/` 不弹、换行后的行首照弹、嵌套命令名 `team/review`、只看光标之前、没有 `/` 或只剩空白时为 `null`),②`mergedCommands`(服务端命令排前、面板项带标记、同名时服务端优先、没有服务端命令时面板动作照旧),③`parseCommand`(带参数 / 无参数 / 多个空格后的参数整体保留 / 大小写不敏感但取表里的写法 / 非行首不当命令 / 未命中不静默失败 / 嵌套命令),④`loadCommands`(按目录缓存、换目录重新请求、目录为空直接返回),⑤`openCommands`(非 `/` 开头不开、按查询词过滤、前缀命中排前面、面板项渲染「面板」标签、无匹配的空态而不是不显示、`force` 供 `Ctrl+P`、条目数受 `CMD_LIMIT` 截断、没选中会话不开),⑥`commandKey`/`acceptCommand`(上下键环绕、`Tab`/`Enter` 选中且 `preventDefault`、补全成 `/名字 ` 并留出参数位、保留光标之后已有的正文、`Esc` 关掉并标记已消费、面板关着或没有条目时不吃按键),⑦`send()` 的命令分流(命中服务端命令走 `POST /command` 而不是 `/prompt`、`name`/`text` 分开、不忙时不带 `delivery`、忙时带上默认的「插话」、能带 `@` 引用附件且成功后才清空、失败弹 toast 不当普通消息补发、未命中的 `/foo` 照旧当普通消息),⑧面板动作(`/compact` 的 `{}`、`/undo` 取最后一条用户消息并带 `files:true`、会话在跑时先拦住不请求、`/redo` 的 `DELETE` 与 `409` 的「没有可重做的撤销」、`/rename` 的 `PATCH`、`/archive` 的 metadata 读-改-写、`/clear` 不发请求、`/help` 的小节标题跨满两列不错位、`/sessions`/`/models`/`/agents` 从「只聚焦」改成弹出选择框),⑨输入历史(`pushHistory` 连续重复只记一次、`↑` 进最新再往上、到头吞键不动、`↓` 退回草稿、不在历史里 `↓` 不接管、没有历史 `↑` 不接管、多行时按首行/末行判定接管与否、切会话归位、普通消息也记历史),⑩全局键位(`Esc` 优先关命令面板、其次关 `@` 补全;**都不开且在跑时第一下只上膛** —— 不发请求、状态条那句提示换成 `esc again to interrupt`、补一句 toast,`5 秒归零定时器`抓下来手动触发即收回,**第二下才真发中断请求**且提示收回原文(`.armed` 也挂上/摘掉,照 TUI 的 `showDetails`);输入框一有动静就把上膛撤掉、撤掉之后那一下只是重新上膛不攒数、回合结束时把上膛收掉;没在跑不动、`<dialog>` 打开时不抢键、已被别人 `preventDefault` 的 Esc 跳过;`Ctrl+P` 打开且不动输入内容、带 `Shift`/`Alt` 或对话框打开时不算;`Shift+Tab` 切智能体、跳过空值的「默认」、到头绕回、命令面板开着或对话框打开时不抢键),以及⑪输入框内的按键优先级(面板开着时方向键给面板而不落到历史、面板没开时给历史、`Enter` 仍然发送;**无 Shift 的 `Tab` 在输入框里也切智能体**(照 TUI 的 `agent.cycle`,且命令面板开着时先给面板)),⑫`exactCommand`「完整命令名 + `Enter` 直接执行」(`/models` 一下就到选择框、面板已关、输入框被清空而不是停在 `/models `;只敲 `/mod` 时 `Enter` 仍然只是补全成 `/models ` 且不执行;高亮用 `↓` 移到 `/re` 列表里的别的命令时,`Enter` 补全成**那个**命令而不是执行输入框里的名字)。
- `ui-picks-run.js`:110 项浏览器内断言,覆盖①通用选择框 `openPick`/`renderPick`(标题、`current` 默认高亮、`current` 不在列表里时停在第一条、`filter=false` 藏过滤框 / `filter=true` 露出来并清空、分组标题每组只出现一次、`sub` 写进 `.pi-sub`、无匹配给空态且不崩高亮、**当前值那枚 `●`**(只给 `current` 那一条、每条都占着那格、高亮挪开后 `●` 还在、没给 `current` 就不印)、**空态分「没有可选项」与「没有匹配项」**、**底部那行**(有过滤框时两档都先提「打字过滤」、桌面写键位 / 手机写点条目的说法、没过滤框就不提打字)),②过滤 `pickVisible`(没查询词=全部、按 label、按 sub、大小写不敏感、纯空白等于没过滤、无匹配返回空),③键位 `pickKey`(↑/↓ 环绕、方向键与 Enter 都 `preventDefault`、不认识的键不管、框关着时不管、空列表不吞键、点「关闭」按钮的 Enter 不抢),④选中 `pickChoose`(回调拿到 key、关框后才回调、`disabled` 项点不动),⑤接线 `setupPick`(过滤框输入即过滤、换查询词把高亮归位、过滤框里 ↓ 交给选择框、点条目选中、关掉后焦点回输入框),⑥`/sessions`(标题、列的就是左栏那批且同序、标题作 label、副文案含目录名、当前会话高亮、打开「显示已归档」后也在、按顶部排序走、选中即切过去),⑦`/models`(按 provider 分组、key/label/sub 的来源、`enabled=false` 的与工具栏一致地不出现、当前模型高亮、当前模型不在列表里时补一条「当前」、有变体就追问且当前档位高亮、选档位带 `variant`、选「默认」不带 `variant`、没有变体就直接切、换模型后追问的是新模型的变体、空 key 只提示不发请求、列表里没有的 key 也能按 `providerID/modelID` 拆开),⑧`/agents`(`hidden` 与 `subagent` 被滤掉、label/sub 来源、当前智能体高亮、不提供「默认」空选项、选中即切、当前智能体不在列表里时补一条),⑨没选中会话时三条都不开,⑩三条面板命令仍在、说明已不再写「跳到…」、`focusEl` 这个旧做法已经不存在,以及⑪§8.69 的子会话过滤与父子导航(`/sessions` 不含 `parentID` 的子会话、`store.subs` / `parentOf` 认得父会话、头部「子会话 N」/「‹ 父会话」的显隐与文案、`/subagents` 的标题 / 过滤框 / 只列当前父会话的孩子 / 选中即切换到子会话、切过去后头部换成回父会话、`/parent` 切回顶层、没有子会话时只提示不开空框)。
  真实目检(`/tmp/ocsm-probe/picks-build.js` 用真实 `index.html`/`styles.css`/`app.js` + 真实形状的模型数据)看三张图:`/models` 的按 provider 分组与当前项高亮、选完模型后追问变体、`/sessions` 与左栏同源的列表。
- `strip-run.js`:41 项纯函数断言(不起浏览器,毫秒级)。覆盖代理层「消息列表里摘掉 `data:` 图」的两件事:①`isMessageListUrl()` 该摘的 4 项(GET/200/json、带 charset、不带查询串、会话 id 里带点/横线)与**不该碰**的 8 项(POST、非 200、SSE、会话列表、单条消息 `/message/<id>`、`messageish`、路径前缀、非 json / 没 content-type / 没 url);②`stripToolUris()` 摘的时候**只动 `data:` 开头的 uri**(`file://`/`https://` 原样留着、没摘到也不加 `omitted`)、`text`/`name`/`mime` 一个不碰、返回处数、重排后字节掉到 1/100 以下、`data` 仍是数组(面板的 `Array.isArray` 校验还在),以及 12 项**结构容错**(uri 是数字/null、item 是 null、没有 `state`、`state.content` 不是数组、`data` 不是数组、null/undefined/空对象 → 都不炸);最后一项是**一句话形状**:把摘前摘后「面板看得见的 text」折出来对比,必须完全一致。
- `config-e2e-run.js`:40 项端到端断言(毫秒级,真起代理 + 临时 `OPENCODE_CONFIG_DIR`)。验证 `/__config/diffs` 在鉴权之后、`GET` 读 `cli.json` 的 `diffs.view`、`GET /__health` 带回同一值、`PATCH` 只改 `diffs.view` 且保留其它键 / 权限 / 末尾换行、三档值都收、非法值 / 多余字段 / 坏 JSON 都 400、文件缺失时 GET 返回 null 且 PATCH 能新建、坏文件拒绝写入且原字节不动。
- `sse-e2e-run.js`:16 项端到端断言(毫秒级,**不碰**线上那唯一的 OpenCode:上游是本地假货,`opencode service status` 用 PATH 里的假脚本顶掉、`service.json` 用 `OPENCODE_CONFIG_DIR` 指到临时目录)。真起一份 `server.js`,让 `session.tool.success` 背着 **600KB 的 `data:` 图**从 SSE 里走一遍:那一帧的图没了(`uri` 空、`omitted` 记原长)、`text`/`name`/`mime`/事件字段原样、整段掉到 5KB 以下;`server.connected` / 心跳注释 / 一个**身上也挂着 `data:` 的别的 `session.*`** / 半截 JSON 帧都一个字节不动;帧边界(空行)一个不少;而且**第一帧先到、结尾后到**(证明是按行改写不是攒完再吐)。
- `sse-strip-run.js`:45 项纯函数断言(不起浏览器)。覆盖代理层「SSE 里也摘掉 `data:` 图」(§8.47):`isEventStream()` 只认 GET + `text/event-stream`;`stripSseData()` **只动 `type === 'session.tool.success'`**(别的 `session.*` 事件、`tool.progress`、`file://`/`https://`、非数组 `content` 一律 0)、`text`/`name`/`mime`/事件字段一个不碰、`omitted` 记原字节数;`stripSseLine()` 把注释 / 心跳 / `event:` / 空行 / 坏 JSON / 不是对象的 JSON / 没 `data:` 前缀的行**原样返回**;`createSseStripper()` 跨 chunk:「整段一次喂」「**按 1 字节切**」「1/2/3/5/8/13/21/34 字节错开切」三种切法输出必须一致,**汉字不被切坏**,帧边界与 `\n\n` 一个不少,流被掐断(没有结尾换行)也照样处理,单行超 8MB 没换行时原样放出去、后面的帧照常。
- `netallow-run.js`:74 项纯函数断言(不起浏览器,毫秒级)。覆盖 `parseIPv4Bytes`/`unmapIPv4`/`parseAllowRule`/`matchAllowRule`/`sourceAllowed` 的边界:CIDR 的边界地址(网段首尾、多一位)、`::1` 与 `:::`、来源为 `undefined` 时不崩、空配置 = 不限制、配了却一条都解析不出 = 一律拒绝。真实 `403` 也在这一套里:起一个只放行回环的临时实例(`OCS_ALLOW='127.0.0.0/8,::1'`),用非回环来源请求应得 `403`,且**返回体里写明来源地址与白名单**(那条「网页版访问不了」就是靠这个一眼定位的)。
- `ui-composer-run.js`:101 项浏览器内断言,覆盖底部输入区(底板)的收起 / 展开。运行器也把 `index.html` 里那段判定脚本抠出来当 `/narrow.js` 送过去,然后用 `matchMedia` 桩在同一个进程里把「手机 / 桌面」翻一遍 —— 判定源就是 `<html>.narrow` 这一个类(「真 390px 视口 → `narrow`」那条链路由 `ui-mobile-run.js` 的 A3/A4 守着,这里不重复)。覆盖:手柄唯一且在 `#composer` 里、桌面没记过 = 展开、手机没记过 = 收起(输入框 / 📎 / 发送 / 三个选择器一起让位,细边 ≤60px 且比展开矮 ≥40px)、手柄两种状态都可见且手机上 ≥44px、点手柄展开会把光标放进输入框、两份记忆互不干扰(桌面记的管不着手机,反之亦然)、把记忆清掉能回到默认、运行中细边上留「■ 中断」(中断在左、手柄在右,不重叠)、空闲时中断收回去、细边的「● 草稿」「📎 2」跟着正文与附件一起变、拖文件进来自动展开且文件进待发送列表、点细边空白处展开但点「中断」不误展开、手柄点一次只翻一次(防冒泡双触发),以及**手柄不在 DOM 里时一律不收起** —— 这条不变量是被老测试页逼出来的:收起之后唯一的出口就是那个手柄。另有 7 项锁**细边上的状态条**(H6–H12):收起着也在(`#progress` 没被藏掉)、排在最左且 `■ 中断` 在它右边、左侧留白正好一格(14px)、细边不额外长高(≤56px)、细边上不重复写 `esc interrupt`、细边仍然铺满整宽(不再被内容宽度带着走)、收工后条自己收回去。另有 8 项锁**提示栏**(K 组,见移动端设计 §8.40 / §8.42,起因是用户那两句「手机端对话框下面的信息还是显示,需要关闭,除了进度条」与「手机端,对话框下面还有:Build...等内容显示」):**手机上两态都不显示**(展开时整条没有它、收起时本来就被收着,§8.42)、那几格只是 CSS 藏(DOM 一个没少,路径那格照旧有字)、智能体·模型 / 路径 / `/ 命令` 三样一个都没露(用量那一格没丢 —— §8.43 把它搬到了标题行末尾,同一个节点、也不是副本)、收工时细边上该留的两样(进度条 / `■ 中断`)照旧露着、再展开一遍还是不显示、桌面收起一样藏、桌面展开照旧 —— `#promptFooter` 挂在 `#composer` **外面**,桌面收起那条靠 `#composer.collapsed ~ #promptFooter` 这个兄弟选择器,窄屏则整条 `html.narrow #promptFooter { display: none; }`。另有 2 项锁 §8.43:会话里顶栏整条收掉(`I3b`,「筛选」就在顶栏里所以跟着走)、用量那格搬到标题行末尾且只有一个节点(`K3b`)。
- `ui-mobile-run.js`:198 项浏览器内断言(**两个视口各跑一遍**)。做法是把测试页塞进一个**固定尺寸的 `<iframe>`**(媒体查询按 iframe 自己的视口算,拿到的是真布局),并在临时 profile 的 `user.js` 里把 `ui.primaryPointerCapabilities` / `ui.allPointerCapabilities` 设成粗指针 —— 于是横屏 `894×393` 那一半(宽度 894 不命中,只能靠 `max-height:560px and (pointer:coarse)` 进来)是**真的**跑出来的,不是打桩。覆盖:窄屏 + 无选中 → 列表可见;选中 → 对话可见;`#backList` 的可见性与点击(等于 `clearSelection()`,hash 一起清掉);`.resizer`/`.handle` 不可见;`thead` 不可见且 `tr`/`td` 变 block;每行的 `⋯` 点开 `#dlgPick` 且选中项走 `onAction(key, id)`、**原有 6 个动作按钮一个不少**;命中区高度 ≥44px(`⋯` / `#btnFilters` / `#backList` / `#send` / `📎`);`#btnFilters` 展开与 `aria-expanded` 同步,且展开的是**同一批 DOM**(没有镜像副本);输入控件字号 ≥16px;横屏带 `short` 类而竖屏(844 高)不带。另有 3 项(两个视口各一遍,共 6)锁**窄屏只剩一列之后的列位**:对话区钉在第 1 列、铺满整宽、左沿贴边 —— 桌面那份 `grid-column: 3` 在窄屏会撑出两个隐式列,会话里最长一行不够宽时对话区就只按内容宽度落位,底板收成细边时右边会白出一条。再各 2 项(共 4)锁**手机上那一行收起**(见移动端设计 §8.41,起因是用户「主要是手机端屏幕下,显示太多东西没必要」):把 `#chatOps`/`#older` 按「有会话、还有更旧的」摆出来,窄屏下两样都**不显示**(`C8d`/`C8e`),同一页把 `narrow` 摘掉转桌面又**都在**(`D3a`/`D3b`)—— 窄屏判定源仍然只有 `html.narrow` 一处。又有 3 项(共 6)锁**输入框下面那一行只在桌面存在**(见移动端设计 §8.42,起因是用户「手机端,对话框下面还有:Build...等内容显示」):`#promptFooter` 按「有会话、有内容」摆出来,窄屏下整条不显示(`C8f`)、里面那几格一个都没露(`C8g`,用量那格 §8.43 起搬到标题行了),转桌面照旧全都在(`D3c`)。再 6 项(两个视口各一遍,共 12)锁**§8.43 手机上再瘦三处**:用量那格的家跟着 `html.narrow` 来回搬(`A6b` 宽屏回提示栏原位、`A7b` 窄屏进标题行)、窄屏列表顶栏照旧(`B38`)、会话里顶栏整条收掉(`C8h`)、标题下面那行收掉(`C8i`)、用量那格搬到标题行末尾且露着(`C8j`),转桌面三样又都在且用量回到提示栏里(`D3d`/`D3e`/`D3f`)。再 3 项(两个视口各一遍,共 6)锁**§8.48 那枚状态徽章**:「空闲 / ● 运行中 / ◌ 重试中」在窄屏会话里**收掉**(`C8k`)、标题照旧露着(`C8k2`)、转桌面它又回来(`D3g`) —— 运行中看底部进度条(收起时细边上还有「■ 中断」),重试看进度条的重试态。

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
- **`question` 工具造字段的形状**(反编译 `GD()`):单选问题 → `{key:"q0", title, description, type:"string", options:[{value,label,description}], custom:true}`;
  多选问题 → `type:"multiselect"` 同款;两者**都不带 `required`**。TUI 的分派是 `type==='string' && options` → 选项列表,
  所以面板也按「**有 `options` 就是可点的单选行**」渲染(`custom:true` 时另给「其它(自填)」,与选项互斥)。
  曾经这里画的是 `<input list=...> + <datalist>`:桌面上要点一下才出下拉,手机上等于**没有选项可点** —— 这就是「问问题时不弹选项」的根因。
- 带 `options` 的 `string` 字段,答案类型是**字符串**(不是数组,数组是 `multiselect` 的)。服务端对 `custom:true` 接受任意字符串,
  `custom:false` 只接受选项值,否则 `400 FormInvalidAnswerError: Invalid option for form field: <key>`(两条都实测过)。
- **代理必须吞掉 `Expect: 100-continue`**:curl 对 >1024 字节的 POST 会自动加这个头;原样转发给上游后两边都等对方的 `100 Continue`,
  请求永远不返回(实测 `HTTP 100` 之后 10s 零字节)。代理本来就把请求体读完再带 `content-length` 转发,不需要这个握手。
- **TUI 的工具行 spinner**(反编译 `Tz` + pty 抓屏实测):运行中的工具行,行首那个标记由 `$` 变成盲文 spinner
  `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`(**80ms 一帧、10 帧一循环**,颜色就是正文色),命令紧跟在它后面(`⠋ sleep 12`)。
  默认的 `spinner` 就是这组 `dots`,另三组 `arcs` / `quadrants` / `line` 在真实 TUI 里一次都没出现。
  面板照抄这一组与这个节奏(`SPIN_FRAMES` / `SPIN_MS`),位置也照 TUI 放在行首即命令前。
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
- **无头 Firefox 造不出粗指针**,所以 `(pointer:coarse)` 那半边断点默认永远不命中:`--window-size` 对非截图会话无效(视口恒为 1366×768),
  指针能力也永远是细。两个办法合用才测得动 —— ①把测试页塞进**固定尺寸的 `<iframe>`**(媒体查询按 iframe 自己的视口算);
  ②在临时 profile 里写 `user.js` 设 `ui.primaryPointerCapabilities=1` / `ui.allPointerCapabilities=1`。
  顺带一个反例:`--screenshot` 时 `--window-size` **是**有效的(和上面的会话不是一回事),所以截图脚本里能靠它定视口。
- **`curl --interface` 不能用来验证来源白名单**:`curl --interface 172.17.0.1 http://127.0.0.1:49450` 时服务端看到的来源**仍是 `127.0.0.1`**,
  看着像「放行」,其实规则根本没参与判定。可靠做法是起一个只放行回环的临时实例
  (`OCS_PORT=49451 OCS_HOST=127.0.0.1 OCS_ALLOW='127.0.0.0/8,::1' node server.js`),再从别的地址去请求;或直接用 `netallow-run.js` 里的纯函数判。
- **窄屏判定不止「窄」一件事**:手机横屏的布局宽 894px,宽度断点不命中,只能靠 `max-height:560px and (pointer:coarse)` 进来;
  而「矮」本身还会影响排版(顶栏得压成一行),所以除了 `narrow` 还有第二个类 `short`。宽度和高度是两件独立的事,别合在一个断点里。
- **`<head>` 里那句内联脚本不能挪进 `app.js`**:等脚本跑起来再加 `narrow` 类的话,手机上会先闪一下桌面三栏再收敛。
  判定必须在首次绘制之前完成,所以它只能待在 `index.html` 里,`app.js` 只复用它的字符串(见 `syncNarrowClass()`)。
