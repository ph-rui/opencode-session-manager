# OpenCode 会话管理器 — 手机端适配设计文档

> 本文只描述**手机端适配**这一增量。桌面版的整体设计见
> `2026-10-15-session-manager-design.md`，本文不重复其内容。
>
> **已实现并回写。** 定稿后又按实机情况改了几处，都标在对应小节：
> §4.1 的视图类（只留 `view-chat`）、§4.4 改成**就地展开**（原稿的镜像抽屉否掉了）、
> §5/§6 补上「实测后没做」的几行、§7 的 `OCS_ALLOW` 实际配置、§8 的实测数字与
> 「怎么造出真窄屏视口」的做法。文里凡写着「初稿/原稿」的地方，都是**最终没照做**的。

## 1. 背景与目标

### 问题

面板目前是**桌面三栏**布局（会话列表 / 分栏拖拽条 / 对话区），最小宽度
`560px + 16px = 576px`，且全站**没有任何响应式断点**（唯一的 `@media` 是
`prefers-reduced-motion`）。在手机上打开：

- 顶栏 7 组控件横向溢出，搜索框被切
- 会话表 6 列溢出，最后一列被切
- **对话区整个落在屏幕右侧之外**，必须横向滚动才够得着

### 目标(本次交付)

让面板在手机上**可用**，主力场景是「**看一眼 + 偶尔回一句**」：

1. 会话列表能看清「哪些在跑、哪些在等我」
2. 能进到某个会话看消息流
3. 能回一句话
4. 能就地处理「等我」的权限请求 / 提问
5. 会话管理与附件 / `@` 补全 / 斜杠命令**不缺失**（能用即可，不要求为小屏精雕）

**成功标准**：在 Redmi Note 12T Pro 上，竖屏与横屏都不出现横向滚动；
上述 5 项都能单手完成；桌面版**行为与观感零变化**。

### 非目标(本次明确不做)

- **PWA / service worker / 图标 / 独立窗口** —— 见 §2.2，在 `http://` 私有 IP 下
  拿不到安全上下文，做了也装不上
- **HTTPS / 自签证书** —— 同上，属于另一件事
- **手势库**（左右滑动切页）—— 用按钮即可，不引依赖
- **虚拟滚动 / 增量渲染** —— `renderMessages()` 整表重画是独立议题，不在本次
- 桌面布局的任何改动

---

## 2. 关键事实(已实测,是设计的地基)

### 2.1 目标设备视口

Redmi Note 12T Pro：6.6″ LCD（144Hz），物理 `1080 × 2460`，**DPR 2.75**（407 ppi），
HyperOS（Android 13/14 基线）。换算成 CSS 像素：

| 朝向 | CSS 视口 | 备注 |
|---|---|---|
| 竖屏 | **393 × 894** | 落在安卓主流三档（360 / 393 / 412）的中间档 |
| 横屏 | **894 × 393** | **宽 894 > 常见断点，是主要的坑** |

**据此两条硬结论**：

- 断点必须**同时看宽和高**，只看宽度会让横屏掉回桌面三栏（§3）
- 设计基准取 **360px**（安卓最窄的主流档，如 Xiaomi 12）。在这台上左右各多出
  ~33px，在 360 的机器上也刚好不溢出

### 2.2 可达性与安全上下文

| 项 | 实测值 |
|---|---|
| 面板监听 | `0.0.0.0:49450`（来自 `~/.config/opencode-session-manager/env` 的 `OCS_HOST`）|
| 本机 VPN 地址 | `client` 网卡 = `192.0.2.5/24` |
| 手机侧可达性 | ✔ 手机经 VPN（192.0.2.x）可连到本机 `192.0.2.5` |
| 从 `192.0.2.5` 访问 | 无密码 **401**、带密码 **200** |
| 后端 OpenCode | `127.0.0.1:49374`（仅本机；手机不需要知道它）|
| 鉴权方式 | HTTP Basic（`OCS_AUTH`）|
| TLS | **无**。`server.js` 只 require 了 `http`，没有 `https`/`tls` |

**副产品（本次要修）**：`0.0.0.0` 让面板同时暴露在办公内网 `198.51.100.48` 与
docker 网桥 `172.17.0.1` 上，仅 Basic 保护。详见 §7。

**为什么 PWA 不做**：service worker 要求**安全上下文**（HTTPS 或 localhost），
而 `http://192.0.2.5:49450` 是「私有 IP + 明文 HTTP」，不是安全上下文 ——
Chrome 会拒绝注册、也不给安装入口。硬要装得先上 HTTPS，那是另一件事。

### 2.3 现有代码结构（决定改造面）

| 位置 | 结构 | 对本次的意义 |
|---|---|---|
| `public/index.html` | `#topbar`（7 组控件）/ `main` = `#listpane` + `.resizer` + `#chatpane` | 三栏是 `main` 的 grid |
| `public/index.html` | `#list` 是 `<table>`，**6 列**：标题/工程目录/更新/Tokens/Cost/操作 | 393px 下必须换形态 |
| `public/index.html` | 6 个 `<dialog>`（新建/导入/导出/TUI/帮助/选择框）| 对话框已统一，窄屏好适配 |
| `public/styles.css` | `main { grid-template-columns: var(--list-w,560px) var(--rz-w,16px) minmax(0,1fr) }` | 窄屏改成单列 |
| `public/styles.css` | `main.list-hidden` → 折叠列表（分栏条保留为展开入口）| 窄屏不用它，隐掉分栏条 |
| `public/app.js` | hash 管会话选择：`persistSelected()` 用 `history.pushState`，`syncFromHash()` 听 `popstate`/`hashchange` | **窄屏视图可复用它，不必新增路由** |
| `public/app.js` | `clearSelection()` 取消选中并 `replaceState` 去掉 hash | 正好当「返回列表」 |
| `public/app.js` | 分隔条拖拽已用 pointer events + `touch-action:none` | **触屏本来就能拖**，但窄屏会隐掉它 |
| 资源体积 | `app.js` 44 KB gzip、`styles.css` 7.9 KB gzip、`index.html` 2.8 KB gzip | 手机上首屏无压力 |

---

## 3. 断点与窄屏触发

**触发条件（两个维度，缺一不可）**，判定式为：

```
(max-width: 860px), (max-height: 560px) and (pointer: coarse)
```

**为什么不能只看宽度**：手机横屏时布局宽度是 **894px**，`max-width: 820px` 之类的常见
断点**不会命中**，于是掉回桌面三栏 —— 而那时屏幕只有 393px 高，比竖屏更没法用。
所以必须带上高度维度，并用 `pointer: coarse` 把「矮的桌面窗口」排除在外。

| 场景 | 是否进窄屏 | 原因 |
|---|---|---|
| 手机竖屏 393×894 | ✔ | 宽 393 < 860 |
| 手机横屏 894×393 | ✔ | 粗指针 + 高 393 < 560 |
| 桌面窗口拉窄到 800 | ✔ | 宽 < 860（此时三栏本身也挤不下）|
| 桌面正常窗口 | ✘ | 两条都不满足，不误伤 |

**实现方式：判定源唯一，CSS 不重复写 `@media`。**

在 `<head>` 里放一句内联脚本，**在首次绘制前**把类打上（因此不会「闪一下桌面三栏」），
并把判定式挂到全局供 `app.js` 复用：

```html
<script>
  window.OCS_NARROW_MQ = '(max-width:860px),(max-height:560px) and (pointer:coarse)';
  window.OCS_SHORT_MQ  = '(max-height:560px)';
  if (matchMedia(window.OCS_NARROW_MQ).matches) document.documentElement.classList.add('narrow');
  if (matchMedia(window.OCS_SHORT_MQ).matches)  document.documentElement.classList.add('short');
</script>
```

**第二个类 `short`（实现时补的）**：光有「窄」还不够。手机横屏 894×393 虽然进了窄屏，
但 393px 的高度下三行顶栏能吃掉四成屏幕，消息就没地方了 —— 所以另外判一次
「视口很矮」，命中就给 `<html>` 再加一个 `short`，把顶栏压成一行
（`html.narrow.short #topbar`）。宽度和高度是两件独立的事，所以是两个类而不是一个。

- 所有窄屏样式一律用 `html.narrow` 作前缀，**不写第二份 `@media`**
- `app.js` 复用同一个 `window.OCS_NARROW_MQ` / `window.OCS_SHORT_MQ` 监听 `change`，
  在旋转屏幕 / 拉窗口时同步这两个类
- 测试既可以直接 `.classList.add('narrow')` 断言样式，也可以用真的窄窗口触发

两个判定式在仓库里**各自只出现一次**（就是上面那两个字符串字面量），
`smoke.sh` 断言断点数值没被抄成第二份（`styles.css` / `app.js` 里 0 次），
也断言 `styles.css` 里没有任何 `@media (max-width…)`。

---

## 4. 窄屏布局骨架

> **新增元素一律桌面隐藏。** 本节新增的 `#backList`、`#btnFilters`、`⋯` 按钮全部默认
> `display:none`，只在 `html.narrow` 下显示 —— 桌面渲染结果因此不变。
> 已核实：现有 16 套测试**没有**「元素总数 / 结构快照」类断言（`querySelectorAll(...).length`
> 的断言都限定在具体卡片的具体类上），新增隐藏元素不会打破它们。

### 4.1 三栏 → 单栏

`main` 在窄屏变成单列，`#listpane` 与 `#chatpane` **二选一显示**：

```css
html.narrow main,
html.narrow main.list-hidden { grid-template-columns: minmax(0, 1fr); }
html.narrow main.list-hidden #listpane { display: block; } /* 复位桌面留下的折叠态 */
html.narrow .resizer { display: none; }                   /* 分栏条与其手柄一起隐掉 */

/* 二选一：只认 <html>.view-chat(由 store.selected 派生，见 §4.2)。
   默认(没这个类)就是列表 —— 这样首屏不会先闪出两个 pane 再收敛。 */
html.narrow #chatpane { display: none; }
html.narrow.view-chat #chatpane { display: flex; }
html.narrow.view-chat #listpane { display: none; }
```

`--list-w` 与 `main.list-hidden` 在窄屏一律不参与（避免桌面留下的折叠态把列表也藏了）。

### 4.2 视图判定：复用 hash，不新增路由状态

窄屏下的当前视图**直接由 `store.selected` 派生**：

| `store.selected` | 窄屏显示 |
|---|---|
| 有值 | 对话区 |
| 无值 | 会话列表 |

实现上只在 `document.documentElement` 上同步一个 `view-chat` 类（取值 `!!store.selected`），
收口到一个 `syncNarrowView()`，在选中状态本来就会经过的出口调用：
`selectSession()`、`clearSelection()`、启动时的 `restoreFromHash()`。
**不引入第二个状态变量。**

这样做的理由：

- 点会话本来就会 `pushState(#ses_x)` → 天然进对话区
- **深链直接可用**：手机打开 `http://192.0.2.5:49450/#ses_xxx` 就落在该会话的对话区
- **安卓返回手势/返回键直接可用**：`popstate` → `syncFromHash()` → hash 为空 →
  `clearSelection()` → 回到列表。不用自己实现一套历史栈
- 没有第二份状态需要与 hash 保持一致（这是最容易出 bug 的地方）

**代价（明确接受）**：从对话区返回列表会**取消选中**该会话，再点进去会重新拉一次消息。
这与桌面版「选中会一直留着」不同，但符合手机上「返回 = 离开详情」的普遍直觉，
且重新拉取的代价很小。

### 4.3 返回入口

对话区左上角新增一个按钮 `#backList`（「‹ 会话」）：

- **仅窄屏可见**（`html.narrow #backList { display: inline-flex; }`，桌面 `display: none`）
- 点击 = `clearSelection()`，与安卓返回键同一条路
- 放在 `#chatHeader` 的第一行左侧，与 `#chatTitle` 同行

### 4.4 顶栏收起（就地展开）

`#topbar` 在窄屏只留：**短标题 + 搜索 + 「+ 新建」+ 连接状态**。
其余（工程目录筛选、排序、导入、刷新、显示已归档、会话计数）默认收起。

- 新增 `#btnFilters`（窄屏可见）切换展开/收起
- **已实现的做法与本文档初稿不同（有意偏离，见下）**：不是 `<dialog>` 抽屉，
  而是**同一批 DOM 就地收起/展开** —— `#topbar` 加一个 `filters-open` 类，
  这些控件平时 `display:none`，展开时按网格 `grid-column: 1 / -1` 摊满一行
- 那批控件在**桌面一个像素都不改**：`html.narrow #topbar .nf { display: none; }`
  只挂在窄屏下，桌面照旧横排
- 展开态是**纯视觉**的，不新增状态变量：`filters-open` 只存在 DOM 类上，
  刷新后回到「收起」——这也符合「手机上看一眼」的用法

> **为什么改掉了初稿的「镜像副本 + `<dialog>`」**：初稿怕的是「同一批 DOM 在窄屏
> 没法重排」，但顶栏本来就该改成 CSS 网格（见 §3 之后的实现），一旦是网格，
> 同一批 DOM 就能直接换行摆开 —— 镜像副本反而是净亏：
> 要维护两套控件的显示同步（`renderDirOptions()` / `setupFilters()` 各加一处同步调用），
> 而 `<dialog>` 在手机上还会把顶栏盖住、每次改完筛选要手动关。
> 就地展开没有第二条同步路径，也不会遮住列表。
>
> 代价：`#btnFilters` 的 `aria-expanded` 要自己维护（已做），以及
> 展开后顶栏变高会挤掉列表的一点高度（收起即恢复）。

命中区与字号：`#btnFilters` 是 `.chip`，窄屏下 ≥44px（§5）。

### 4.5 会话列表：`<table>` → 卡片行

393px 装不下 6 列。窄屏改形态 —— **覆写只发生在 `html.narrow` 下，桌面那套表格样式一行不改**：

```css
html.narrow #list thead { display: none; }
html.narrow #list tbody tr { display: block; }  /* 一行变一张卡 */
html.narrow #list td { display: block; border: none; }
```

每张卡两行：

| 行 | 内容 |
|---|---|
| 第 1 行 | 标题 + 状态徽章（`● 运行中` / `◌ 重试中` / `📦 已归档` / `⚑ N`）|
| 第 2 行 | `目录 · 相对时间 · tokens`（缩放成次要色、小字）|

**操作按钮（打开/改名/移动/分叉/归档/删除）窄屏不内联**。做法是**增量**：
在 `renderSessions()` 产出的 `td.actions` 里**再加一个** `⋯` 按钮（`data-act="more"`），
它只在窄屏可见；原有 6 个按钮原样保留，由窄屏 CSS 隐藏。

> **复用现成的 `#dlgPick`** 当动作面板。它已经是「标题 + 列表 + 关闭」的通用选择框
> （`openPick({ title, items, onPick })`，见主设计文档 §7「选择框」）。零新增对话框，
> 且它已经处理好了「先关框再回调」的顺序问题。

**原来那 6 个按钮一个都不删**是刻意的：桌面版与 16 套测试都依赖它们。
新增的 `⋯` 在桌面 `display:none`，因此桌面渲染结果不变。代价是窄屏下 DOM 里
多一个隐藏按钮、卡片行里留着用不到的表格语义 —— 可接受。

---

## 5. 触摸可达性

| 项 | 规则 | 实现情况 |
|---|---|---|
| 命中区 | 主要可点元素（顶栏按钮、返回、发送、附件、对话框控件）≥ **44 CSS px** 高（= 121 物理 px @DPR 2.75）；文本内的行内链接不受此约束 | `html.narrow .chip / .more / .attachbtn / #send / .dlgacts .chip { min-height: 44px }` |
| 悬停 | `@media (hover: none)` 下「悬停才显示」的元素改为常驻可见 | **空操作**：已逐个核实，仓库里没有只靠悬停才出现的元素（消息操作按钮、折叠手柄都是常驻的，`hover` 只改颜色不改可见性），所以没有为这一条写 CSS |
| 输入 | 输入类控件字号 ≥ 16px（防部分浏览器聚焦时自动放大）| `html.narrow #search / .f select / #input / #ctoolbar .ctl select { font-size: 16px }` |
| 拖拽 | 分栏条窄屏隐掉；附件仍支持 `<input type=file>`（安卓会给相册/文件选择器）| `html.narrow .resizer { display: none }`；附件未动（`<input type=file>` 在触屏上照样弹系统选择器）|
| 滚动 | `#messages` 与 `#list` 保持各自的滚动手势，互不抢 | 未改：两者本来就是各自 `overflow: auto` 的独立滚动容器 |

> **命中区为什么用 `min-height` 而不是统一塞 `padding`**：`.chip` 的高矮在桌面是有意
> 区分的（顶栏小、对话框里大）。只加 `min-height` 不会动到里头的文字基线，
> 也不会把本来就够高的控件再撑一圈。

---

## 6. 逐功能适配清单

| 区域 | 窄屏处置 | 实现情况 |
|---|---|---|
| `#topbar` | 只留短标题 / 搜索 / 新建 / 状态；其余就地收起（§4.4）| 改成 CSS 网格；`#btnFilters` 切换 |
| `#list` | 卡片行 + 行内「⋯」动作（§4.5）| 已做；`td.cost` 直接隐掉让位 |
| `#chatHeader` | 「‹ 会话」返回按钮；第二行的操作按钮够得着 | 返回键已做；`#chatOps` **没有**再收一层折叠 —— 它本来就 `flex-wrap: wrap`，换行后 4 个按钮仍够按，只是抬到 40px |
| `#messages` | 代码块与 diff **横向滚动**（不折行，否则 diff 无法阅读）；工具卡片默认折叠更激进 | `pre`（L289）与 `.diff`（L390）本来就带 `overflow-x: auto`，窄屏**无需额外规则**，也没有改折叠策略。**diff 的统一视图已在 §8.58 改为折行**；代码块仍横向滚 |
| `#asks` / `#inbox` | 权限请求与问询卡片要**在窄屏可完整作答**（这是「看一眼」的主要动机）；按钮竖排、命中区放大 | 未加窄屏专用规则：卡片本来就是竖排 + 整宽按钮，实测在 390px 下可完整作答（见 §8.3 的目检）|
| `#composer` | `#ctoolbar`（智能体/模型/变体/投递/中断）在窄屏换行摆开；`📎` / 发送按钮放大；**整块可收起**（手机默认收起成一条细边，见 §8.4）| 工具行本来就 `flex-wrap`，窄屏只是放开 `select` 的 `max-width` 让它占满；`#send` / `.attachbtn` 走 §5 的 44px；收起/展开见 §8.4 |
| `#mentions` / `#cmds` | 补全浮层在窄屏占满宽度 | `left: 10px; right: 10px` |
| `<dialog>`（6 个）| `html.narrow .dlg { width: calc(100vw - 24px); max-width: none; }`；`dlgNew` 里的 `.fldrow`（三个字段横排）改 `flex-direction: column` | 两件都做了，另外把 `min-width: 420px` 归零（393px 的屏上它必然溢出）|
| 软键盘 | `<meta name="viewport">` 加 `interactive-widget=resizes-content`，让安卓在键盘弹出时压缩视口，输入框与发送键不被顶出屏幕 | 已加 |

> 这张表里有三行写着「无需额外规则 / 未加窄屏规则」，不是漏做：**先把「已有的桌面样式
> 在 390px 下够不够用」实测一遍**，够用就不写。窄屏 CSS 加得越少，两套布局漂移的机会越少。

---

## 7. 访问控制（替代「改 OCS_HOST」）

原本的设想是把 `OCS_HOST` 从 `0.0.0.0` 收成 `192.0.2.5`。实测后发现**不可行**：

- 绑定到 `192.0.2.5` 后，**本机 `http://127.0.0.1:49450` 就不再监听**了 ——
  桌面上的日常使用会一起断掉
- 而 `192.0.2.5` 是 VPN 网卡地址。服务单元里没有 `After=network-online.target`，
  若开机时该网卡还没起来，`listen` 会 `EADDRNOTAVAIL` 失败，只能靠
  `Restart=on-failure`（`RestartSec=2`）反复重试

**改为在应用层做来源地址白名单**（`server.js`）：

- 保持 `0.0.0.0` 监听（本机、VPN 都照常）
- 在请求入口检查 `req.socket.remoteAddress`，逐条比对白名单，不匹配一律 **403**
- 白名单由 `OCS_ALLOW` 配置，逗号分隔，支持四种写法：
  单个 IPv4、IPv4 CIDR、单个 IPv6、IPv6 CIDR；
  `::ffff:198.51.100.9` 这种 v4-mapped 会先还原成 `198.51.100.9` 再比对
- **代码里的默认值是 `127.0.0.0/8,::1,192.0.2.0/24`**（回环 + VPN）
- Basic 鉴权**保留** —— 白名单是收窄可达面，不替代鉴权；校验发生在鉴权**之前**
  （来源不对的话连 401 都不必给）

三条容易踩的语义（都写进了 `test/netallow-run.js`）：

| 配置 | 行为 |
|---|---|
| 不设 `OCS_ALLOW` | 用上面那个默认值 |
| 设成空串 | **不限制**（等于关闭白名单）|
| 设了但一条都解析不出来 | **一律拒绝**（fail closed），启动时打警告 |

> **为什么配错要 fail closed**：`OCS_ALLOW` 写错时最坏的结果是「本来只想给
> 内网开个口子，结果把整个 0.0.0.0 敞开」。宁可打不开（看日志/返回体就知道原因），
> 也不要静悄悄放开。

**403 会把原因告诉你**，不用去翻服务端日志：

```
来源地址不允许 / source address not allowed
来源: 198.51.100.48
白名单: 127.0.0.0/8,::1,192.0.2.0/24
```

服务端同时打一行 `拒绝来源地址: 198.51.100.48(白名单: …)`。

> **实测踩到的坑（本机真实经历过）**：一开始只在代码里放了默认值（回环 + VPN），
> 而办公室这台桌面/手机走的是办公内网 `198.51.100.0/24` —— 于是**连自己的浏览器
> 都被 403 挡在外面**，报的就是上面那段。修法不是在代码里加网段，而是在
> `~/.config/opencode-session-manager/env` 里显式写：
>
> ```
> OCS_ALLOW=127.0.0.0/8,::1,192.0.2.0/24,198.51.100.0/24
> ```
>
> 这也正是「默认值 + 显式配置」分开的意义：默认值保守，实际网段由部署处声明。
> docker 网桥 `172.17.0.1`、以及 `198.51.100.0/24` 以外的内网地址仍被拒。

---

## 8. 测试

沿用现有做法：**无头 Firefox + 本地 HTTP 服务**跑浏览器内断言（见主设计文档 §8）。

### 8.1 新增 `test/ui-mobile.html` + `test/ui-mobile-run.js`（两个视口合计 154 条）

**怎么造出真实的窄屏视口（实现时解决的，可复用）**：

1. 把测试页塞进一个**固定尺寸的 `<iframe>`**（`width:390px;height:844px`）——
   媒体查询按 iframe 自己的视口算，拿到的是货真价实的窄屏布局，不是靠打桩凑出来的数字
2. 无头 Firefox 默认是**细指针**，`(pointer:coarse)` 永远不命中。在临时 profile 里写
   一份 `user.js`：
   ```js
   user_pref("ui.primaryPointerCapabilities", 1);
   user_pref("ui.allPointerCapabilities", 1);
   ```
   实测有效 —— 于是 `894×393` 那一半（宽度不命中，只能靠
   `max-height:560px and (pointer:coarse)` 进来）是**真**跑出来的

两个视口各跑一遍（可用 `UI_CASES` 覆盖）：

| 视口 | 靠哪一半进窄屏 |
|---|---|
| `390×844`（竖屏）| `max-width:860px` |
| `894×393`（横屏）| `max-height:560px and (pointer:coarse)` |

核心断言：

| # | 断言 |
|---|---|
| 1 | 窄屏 + 无选中 → 列表可见、对话区不可见；选中后反转 |
| 2 | `#backList` 窄屏可见、桌面 `display:none`；点它 → `clearSelection()`（`store.selected` 变 `null`、hash 去掉）|
| 3 | 窄屏下 `.resizer` / `.handle` 不可见 |
| 4 | `#list thead` 不可见、`tr`/`td` 变 block（卡片化生效）|
| 5 | 窄屏下每行有「⋯」，点它打开 `#dlgPick`，选中项走 `onAction(key, id)` |
| 6 | 六个原有动作按钮**一个不少**（只是窄屏被 CSS 藏起来）|
| 7 | 命中区**高度** ≥ 44px：`⋯`、`#btnFilters`、`#backList`、`#send`、`📎` |
| 8 | `#btnFilters` 点开 → `#topbar.filters-open`，`aria-expanded` 跟着变；展开的那批控件与桌面是**同一批 DOM** |
| 9 | 输入控件字号 ≥ 16px |
| 10 | 横屏（`894×393`）时 `<html>` 同时带 `short`；竖屏（844 高）不带 |

> **只断言高度 ≥ 44，不要求宽度也 ≥ 44**：返回键、`⋯` 这类按钮本来就窄而高，
> 硬绑宽度只会逼着把按钮拉成方块，反而难看。手指按得准与否主要取决于高度。

### 8.2 扩充 `test/smoke.sh`（静态断言，+18 条 → 130）

- `index.html` 里存在那句内联脚本，同时定义 `window.OCS_NARROW_MQ` 与 `window.OCS_SHORT_MQ`，
  且当场 `classList.add('narrow')`（首帧就对，不会闪桌面版）
- 断点数值只在 `index.html` 出现 1 次（`styles.css` / `app.js` 里各 0 次）
- `styles.css` 里 `@media (max-width…)` / `@media (max-height…)` **0 处**
- `#backList` / `#btnFilters` / `data-act="more"` 存在，桌面默认 `display:none`、
  只在 `html.narrow` 下 `inline-flex`
- `html.narrow #chatpane { display: none }` + `html.narrow.view-chat #listpane { display: none }`，
  且 `view-chat` 是从 `store.selected` 派生的那一行
- 窄屏复位桌面折叠态：`html.narrow main.list-hidden #listpane { display: block }`
- 窄屏 `dialog.dlg` 的 `min-width` 归零、命中区 44px、输入控件 16px
- `--chat-fs` 全文只定义 1 次（字号旋钮没被拆成两份）
- `setupNarrow()` 接进 `init()`，且在 `app.js` 里只出现 2 次（定义 + 接线），
  并监听了媒体查询的 `change`（转屏要重新判定）
- `server.js` 的来源白名单：默认值、空配置=不限制、配错=fail closed —— 这三条由
  `test/netallow-run.js` 的 74 条断言正面覆盖（含 `:::` 拒绝、`sourceAllowed(undefined)` 不崩），
  `smoke.sh` 不重复

> `smoke.sh` 里断言必须用现成的 `has()`（`case` 实现）；
> **禁用** `printf | grep -q` —— 在 `set -o pipefail` 下会因 SIGPIPE 假红。

### 8.3 回归与目检

**全部既有测试继续通过**，实测（全部 0 失败）：

| 套件 | 通过条数 |
|---|---|
| `smoke.sh` | 230（§8.23 之后）|
| `netallow-run.js`（新）| 74 |
| `ui-layout` / `ui-tools` / `ui-asks` | 164 / 134 / 57 |
| `ui-controls` / `ui-capabilities` / `ui-stream` | 90 / 71 / 236 |
| `ui-attach` / `ui-commands` / `ui-picks` | 132 / 171 / 87 |
| `ui-mobile`（新）| 160 |
| `ui-composer`（新，见 §8.4）| 91 |
| `ui-jump`（新，见 §8.6）| 56 |
| `e2e-asks` / `e2e-controls` / `e2e-capabilities` | 15 / 22（+1 跳）/ 26 |
| `e2e-stream` / `e2e-attach` / `e2e-commands` | 4（+1 跳）/ 32 / 40 |

这套「窄屏覆写只发生在 `html.narrow` 下、新增元素一律桌面隐藏、原有 DOM 一个不删」
的策略，收益就在这里：桌面路径零变化，由既有测试兜住。

**目检**（无头 Firefox 截图，两个视口都比对过）：手机竖屏 390 与横屏 894 的列表、
对话、动作面板、顶栏展开/收起；桌面 1366 的截图与改前肉眼比对，没有变化。

### 8.4 追加：底板（输入区）可收起

动机**只有一条**：手机屏幕小。收起后把高度让给会话内容，桌面不受影响。

| 点 | 决定 | 落地 |
|---|---|---|
| 收到什么程度 | **全收起**：连输入框一起藏，只剩一条细边 | `#composer.collapsed` 藏 `#ctoolbar .ctl` / `#delivery` / `#attach` / `.cinput` / 两个补全面板 |
| 运行中 | 细边上留「**■ 中断**」—— 唯一不能藏的东西 | 隐藏名单里刻意**不含**它；空闲时它自己 `hidden` |
| 手柄 | 底板上沿靠右的小横片，两种状态都在原位，**绝不 `display:none`** | `#btnComposer` 是 `#composer` 的绝对定位子元素；工具栏右侧让出 80px |
| 别让人以为字丢了 | 收起时细边左侧提示「● 草稿」「📎 n」 | `#cstripMeta` 放进 `#ctoolbar`，由 `renderAttachments()` / `paintComposer()` 同步 |
| 默认值 | **手机收起、桌面展开**（键盘打字是桌面主要入口） | 没记过时 `composerHidden()` 回落到 `<html>.narrow` |
| 记忆 | 桌面 / 手机**各一份**：`ocs.composerHidden` / `ocs.composerHiddenNarrow` | 转屏跨断点时 `syncNarrowClass()` 重读各自那份 |
| 怎么展开 | 点手柄、点细边空白处 → 展开并**聚焦输入框**；拖文件进来自动展开 | 收起时输入框是 `display:none`，所以「粘贴自动展开」不成立 —— 粘贴事件落不到它上面 |

**一处自保值得记一笔**：`paintComposer()` 里「没有手柄就不收起」不是防御式编程 ——
收起之后唯一的出口就是那个手柄，新 `app.js` 配上还没更新的旧 `index.html` 等于把底板锁死。
这条守卫是被 `ui-mobile` 那套老测试页当场逼出来的（它没有手柄元素，第一版实现下有 4 条断言红）。

**实测**（无头 Firefox，真视口）：393×894 上展开约 130px → 收起 48px（`html.narrow .chip` 已经给了
44px 命中区）；桌面收起 30px。目检四种状态都看过：竖屏空闲 / 展开 / 运行中 / 有草稿，外加横屏与桌面收起。
新增 `test/ui-composer.html` + `test/ui-composer-run.js`（84 条）与 `smoke.sh` 的 M 组（16 条）。

### 8.5 追加：运行中的工具行不画状态标记

页面里显示「运行中」的地方原本有三处：会话列表行的徽标、对话头部标题旁（`● 运行中`，与进度条同处），
以及**消息流里正在跑的工具行右边**。第三处是重复 —— 头部那套已经把状态说清楚了；更要紧的是
在手机竖屏上它会被挤到折行，变成「● 运」「行中」两行，比不写还难看。

**决定**：`statusInfo()` 里 `running` / `streaming` 的 `icon` 与 `label` **都清空**，`toolHead()` 见两者皆空
就整个 `<span class="tstate …">` 都不输出 —— 既不写字，也不留那个 `●` 圆点（留个孤零零的点反而像渲染坏了，
而且它和「这条在跑」之间还要靠配色去猜）。`completed` 的 `✓` 与 `error` 的 `✗ 出错` 不动：它们不是重复，
工具行结束后需要知道成没成。头部那句 `● 运行中` 与列表徽标保留 —— 状态只说一遍，但必须说。

`cls: 'run'` 留在映射里没删：`ui-stream` 等按状态分类的地方仍看它，删了就得连那些一起改。

**实测**：手机 393×894 上工具行从「`⏺ bash ← … ● 运行中`（折两行）」变成干净的「`⏺ bash ← …`」
（一行,尾部什么标记都没有;中间那版只删字留点,看过一眼仍然碍眼,于是点也去掉了）。
回归：`ui-tools` 94 → 102（新增 8 条锁这条），`smoke.sh` 的 N 组 +4 条（150 → 154）。

> 后记（§8.9）：本条删的是**行尾那个重复的状态文字**。行首那个标记后来照 TUI 补了动效
> （运行中 `⏺` 变成盲文 spinner），两条不冲突 —— 位置不同，性质也不同：那不是重复的状态文字，
> 而是「这一行在跑」的动效，头部那套回答不了这个问题。

### 8.6 追加：一键回底（TUI 的 `Jump to latest`）

往上翻历史翻过头之后要一路搓回底部，这在手机上格外难受（一次滑动只有小半屏）。

**TUI 的事实**（反编译 `~/.opencode/bin/opencode` 取得）：消息区**下面常驻一行**
（`height: 1`、右对齐），元素 id `session-jump-to-latest`，文案 `Jump to latest ↓`，
悬停换色，点击回底；键盘动作是 `session.last`（`ctrl+alt+g`，以及 `end`）。

| 点 | 决定 | 理由 |
|---|---|---|
| 形态 | **浮在消息区右下角的小片**（sticky），不照搬 TUI 的常驻留白行 | 屏幕高度宝贵；只在「不在底部」时露出来，平时完全不占地方 |
| 位置 | 必须是 `#messages` 的**子元素** + `position: sticky; bottom: 8px` | 只有滚动容器**内部**的 sticky 才钉得住滚动口；放外面就只能 absolute，而 composer / asks 的高度是变的，锚不住 |
| 显隐 | 与「新内容自动跟随」共用同一个「在不在底部」判定（`BOTTOM_SLACK = 80` + `atBottom()`） | 两处各写一个数迟早漂移，表现就是「明明跟着跳了，按钮还杵在那儿」 |
| 键盘 | `End` = TUI 的 `session.last`；焦点在输入框里时不抢 | 那儿 `End` 是「光标到行尾」，抢了就是灾难 |
| 文案 | `跳到最新 ↓` | 与 TUI 语义一致，`↓` 保留方向暗示 |

**两处必须显式写的坑**：

1. `#jumpLatest` 是 id 选择器，它的 `display: block` 优先级**高于** `.chip[hidden]` 的 `display: none` ——
   不补一条 `#jumpLatest[hidden] { display: none }`，那个 `hidden` 属性就形同虚设。
2. 切会话（`selectSession`）与取消选中（`clearSelection`）都会 `$('#messages').innerHTML = ''`，
   住在里面的按钮会被一起抹掉。**没有**在每个清空点各补一行，而是把引用留在外面（`jumpBtn`），
   由 `updateJumpLatest()` 发现 `parentElement` 不对就搬回末尾 —— 那种「每个清空点补一行」的写法迟早漏一个。

**实测**：桌面 1366×900 与手机 393×894 各截一张，往上翻到 35% 处，右下角出现「跳到最新 ↓」
（手机上是 44px 的胶囊）；探针读数 `hidden=false st=1033 max=2951`。
回归：新增 `ui-jump` 44 条（连 sticky 的实际位置都量），`smoke.sh` 的 O 组 +13 条（154 → 167）。

### 8.7 追加：鼠标靠左边缘临时拉出会话列表

列表收起之后，左侧那条 16px 分栏槽是鼠标最容易撞到的边界（它就在最左边）。
「点手柄 → 看一眼 → 再点回去」三下动作，换成「靠上去看一眼、移开就收回」。

| 点 | 决定 | 理由 |
|---|---|---|
| 热区 | 就那条 16px 分栏槽（收起时它天然贴在 x=0..16） | 不加宽、不加隐形热区，不跟拖拽改宽度打架 |
| 收回判定 | **按「分栏槽右沿」判定**，不用 `mouseleave` + `relatedTarget` | 临时展开会把分栏槽从光标底下挪走（收起时在 x=0，展开后跑到列表右边）；光标底下换元素时 `relatedTarget` 在浏览器之间不可靠，换来换去就是闪。按右沿判定：收起时右沿=16，临时展开后右沿=列表宽+16（整个「列表 + 槽」都留着），天然免疫元素挪位 |
| 记忆 | **一个字都不动**（当时是 `ocs.listHidden`；§8.13 之后这份状态不再落存储） | 这是「路过看一眼」，不是改设置；只有点手柄才算显式展开，那时顺手摘掉临时态，列表就保持住了 |
| 动画 | 直接切 | grid 宽度过渡与 `html.narrow` / `display:none` 冲突，要动结构才能带动画，不值 |
| 生效范围 | 只在桌面 | 窄屏 `.resizer` 是 `display:none`，本来就收不到鼠标事件（JS 里另加一道判定兜底） |

CSS 上是个顺序活：`list-hidden`（用户记下来的选择）与 `list-peek`（鼠标路过的临时覆盖）
是两个类，会同时挂在 `<main>` 上，同优先级靠**书写顺序**让 peek 赢 —— 所以 `main.list-peek`
那几条必须写在 `main.list-hidden` 那几条之后（`smoke.sh` 的 P 组用行号锁住了这个顺序）。

§6 里那条「`@media (hover: none)` 空操作」的结论仍然成立：这一条只认 `mousemove`，
而窄屏的 `.resizer` 是 `display: none`（触摸设备连事件都收不到），所以不违反「没有只靠悬停才出现的元素」——
列表在桌面上本来就有手柄可以点出来。

**实测**：桌面 1366×900 三态截图（展开 / 收起 / 鼠标靠左边缘），临时展开态探针
`hidden=true peek=true slotRight=576 paneW=560` —— 记忆没动、列表拉出来了、槽跟着挪到了列表右边。
回归：`ui-layout` 114 → 141（新增 3c 组 27 条），`smoke.sh` 的 P 组 +8 条（167 → 175）。

---

### 8.8 追加：问询卡的单选字段必须「看得见选项」

**起因**：用户反馈「你问问题的时候，网页版有时不弹出选项让我选」。这是一个**渲染**问题，不是事件问题。

复现方式（真服务 + 真面板 + 真浏览器，脚本 `/tmp/ocsm-probe/live/serve.js`）：
建一个临时会话 → 按 `question` 工具的**逐字节相同形状**建一个真表单 → 浏览器带 `#会话id`
打开真面板（面板自己 `restoreFromHash → selectSession → loadAsks`）→ 截图。

| 事实 | 来源 |
|---|---|
| `question` 工具的单选问题是 `{type:"string", options:[...], custom:true}`，**多选**才是 `multiselect`；两者都不带 `required` | 反编译 `GD()` |
| 面板旧渲染对 `custom:true` 给的是 `<input list=…>` + `<datalist>`：选项藏在输入法下拉里，手机上不打字根本看不到 | 旧 `fldCtlHtml()` + 截图 |
| TUI 对同一字段是**选项列表**（`type==='string' && options` → 列表，`custom` 时追加「自己输入」） | 反编译 TUI 分派 |
| 事件链路本身没坏：页面打开 2.5 秒后才建表单，卡片**原地**弹出（不刷新），列表行的 `⚑ 1` 徽标也正常 | 实测（`--live` 模式） |

所以「有时」= 看问题类型：多选问题一直有选项可点，单选问题只有一个空输入框。

| 点 | 决定 | 理由 |
|---|---|---|
| 单选渲染 | 带 `options` 的 `string` 一律画成**可点的选项行**（radio）；`custom:true` 时在其下再给「其它(自填)」，两者互斥 | 与 TUI 一致；手机上 44px 命中区；复用现成的 `.opts/.opt`（与多选题同一套视觉） |
| 答案类型 | 单选提交**字符串**，多选才提交数组 | 服务端语义：`custom:true` 收任意字符串、`custom:false` 只收选项值（乱写 `400 Invalid option for form field`），两条都实测过 |
| `custom:false` | 保持原生 `<select>` 不动 | 手机上系统选择器好用，且已有测试锁着；`question` 工具走不到这条分支，没有改的动机 |
| 卡片本体 | 位置、堆叠、提交/取消一个字不动 | 问题不在「卡片出不出」，而在「选项看不看得见」 |

顺带修掉一个**真 bug**（它把 e2e 测试直接卡死了）：代理把客户端的 `Expect: 100-continue`
原样转发给上游，两边都等对方的 `100 Continue` → 请求永远不返回。curl 对 >1024 字节的 POST
会自动加这个头（表单体刚好越过这条线），实测卡在 `HTTP 100` 之后 10 秒零字节。修法是代理**吞掉**
这个头（它本来就先把体读完、带 `content-length` 转发，不需要握手）。

**实测**：`/tmp/ocsm-probe/live/{pre,live}-{desktop,phone}.png` 四张对照截图 —— 修前单选是空长条、
多选是勾选框；修后单选是三个可点的选项行 + 「其它(自填)」，多选不变。

**回归**：`ui-asks` 39 → 57（新增 10 条钉住 `question` 工具的真实形状 + 8 条 string 单选的取值/互斥）、
`e2e-asks` 13 → 15（`string+options` 收字符串答案 + `Expect` 不卡死）；`smoke` 175、`netallow` 74 与其余套件全部 0 失败。

### 8.9 追加：运行中的工具行，行首标记照 TUI 转起来

**起因**：用户反馈「TUI 在命令前面有一个进度指示（转正方形的），网页版没有实现」。网页版此前只有标题行
那条 8 格进度条在动，工具行行首的 `⏺` 一直是死的。注意这与 §8.5 删掉的东西**不在同一个位置**：§8.5 删的是
行尾那个重复的状态文字，这里补的是**行首标记的动效**。

先把 TUI 的事实抓准（pty 里跑真 TUI 并让它自己执行一条 `sleep 12` 的 bash，见
`/tmp/ocsm-probe/tui/cap2.py`，再解原始终端流）：

| 事实 | 来源 |
|---|---|
| 行首标记 `$` 在 running 时变成盲文 spinner，命令紧随其后（同一行：`⠋ sleep 12`） | 原始流 `\e[10;6H⠋\e[0m\e[10;8Hsleep 12` |
| 帧集合是 `Tz.dots` 的 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`，**80ms 一帧、10 帧一循环** | 抓到 152 帧、每帧约 15 次，正好对上 `sleep 12` 秒 |
| 颜色就是正文色，不是装饰色；跑完回到静态标记 | 同一份抓屏 |
| 「转正方形的」指的就是这组盲文（等宽字里恰好占一个方形字符位），不是 `quadrants`/`arcs`/`line` | 全流统计：`quadrants`/`arcs` 0 次，盲文 10/10 帧各约 155 次（默认 `spinner` 就是 `dots`）|

| 点 | 决定 | 理由 |
|---|---|---|
| 落在哪 | 行首那个标记（`.tmark`）：运行中由 `⏺` 换成 spinner，完成/出错回到 `⏺`；行尾的 `✓`/`✗ 出错` 不动 | TUI 换的就是行首槽位；行尾保持 §8.5 的结论，两处不重叠 |
| 帧与节奏 | 逐字照抄 TUI 的 `dots`：`SPIN_FRAMES` 10 帧 + `SPIN_MS = 80`；**一条** `setInterval` 喂所有行 | 与 TUI 一致；全局同一相位，多行不会各转各的 |
| 实现方式 | JS 逐帧改 `textContent`（不用 CSS 动画），`syncSpin()` 在渲染后的同步点按需起停、已在走就不重启 | 和标题行进度条同一套；重启会把相位拽回第一帧，看着像卡住 |
| `prefers-reduced-motion` | 不让路，永远逐帧动 | 照抄的是终端动效，终端里没有这个概念；与进度条同一条规矩 |
| 布局稳定 | `.tmark.spin` 定宽 `min-width: 1em` + 居中 | 逐帧换字形时这一行不抖 |

**实测**：`/tmp/ocsm-probe/spin/shot.js` —— 真 `index.html` + 真 `app.js`/`styles.css`，挡住 `init()`
只渲染四行（运行中 bash / 运行中 edit / 完成 / 出错），页内每 80ms 采一帧字形并画进页面。采到的序列
`⠙⠹⠸⠼⠴⠦⠧⠇⠏⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠋⠙⠹` —— 10 个字形齐全、逐帧连续递增、约两圈；
截图 `/tmp/ocsm-probe/spin/{desktop,phone}.png` 里运行中的两行在转，完成/出错仍是 `⏺`（手机竖屏也没折行）。

又在**真服务 + 真面板**上复核过一遍（`/tmp/ocsm-probe/live2/shot-live2.js`：只加鉴权头的本地反代 +
无头 Firefox 深链 `#会话id`；面板的数据是 `load` 之后才取的，所以反代往 HTML 里注入一张永不完成的
1px 图挂住 `load`，等 `/api/session/<id>/message` 回来再放行 —— 否则只能拍到「连接中…」）。
截图 `/tmp/ocsm-probe/live2/{phone2,desktop2}.png`：正在跑的工具行（就是那条命令本身）行首是**盲文点阵**，
已完成的行仍是 `⏺`；手机 393×894 上头部 `● 运行中` + 8 格进度条与行首 spinner 同时在场。

**回归**：`ui-tools` 102 → 110（新增 8 条：帧表与间隔照抄 `dots`、运行中行首换 spinner 且不再画 `⏺`、
完成/出错回到 `⏺`、`toolRunning()` 判定）、`ui-stream` 123 → 131（新增 8 条：DOM 里确实有 `.tmark.spin`、
定时器 80ms、`__tick()` 走一帧换到下一个字形、重绘不回跳相位、没有运行中的工具后定时器停掉）、
`smoke.sh` 的 N 组 +3 条（175 → 178）；其余套件与 `e2e-*` 全部 0 失败。

---

### 8.10 追加：状态条搬到输入框下面、压缩也全程在转、压缩块照 TUI 画

**起因**：用户三条反馈 —— ①进度条位置与 TUI 不一致（TUI 在输入框**下面**）；②「思考中」看不到条；
③压缩（compaction）时看不到条。

先把 TUI 的事实抓准（`/tmp/ocsm-probe/tui/cap4.py`：pty 跑真 TUI、对底栏区域逐块记时；
再对上反编译里的 `bs({style:"blocks",holdStart:30,holdEnd:9})` 与 `spinner.interval:40`）：

| 事实 | 来源 |
|---|---|
| 条在 `prompt.footer`（输入框**下面**那一行）：`   ■■⬝⬝⬝⬝⬝⬝ esc interrupt` | 抓屏 row 38（`\e[39;4H`，1-based） |
| 亮不亮的条件只有「这一回合在跑」—— 思考 / 工具 / 压缩一视同仁 | `status === "running"` |
| 8 格、**54 帧一圈、40ms 一帧**（2.16 秒）：往右长到 6 格 → 右端往回缩 → 空三拍 → 倒着重走一遍 → 空约 1 秒 | 抓屏时间戳 + `holdStart:30 / holdEnd:9` |

| 点 | 决定 | 理由 |
|---|---|---|
| 位置 | `#progress` 从聊天标题行搬进 `#composer`，排在 `.cinput` **后面**（= TUI 的 `prompt.footer`）；头部只留文字（`● 运行中` / `◌ 重试中` / `空闲`） | 照 TUI；手机上头部那一行本来就挤 |
| 收起态 | 细边上**也看得见**：`flex-direction: row` + `#progress { order:-1; margin-left:14px }`（排最左，`■ 中断` 紧跟它右边）+ `.phint { display:none }`（`■ 中断` 就在旁边，不用再教 Esc），且不额外长高 | 手机默认就是收起的 —— 一收就没等于没有 |
| 帧表 | `PBAR_FRAMES = 54` / `PBAR_MS = 40`：`progressShape(n)`（14 个形状）+ 相位版 `progressCells(i)` —— `0..13` 正走 / `14..16` 空三拍 / `17..29` 倒放 / `30..53` 长空 | 原来 14 帧 @90ms 只取了前半圈 |
| 「思考中也有条」 | 其实一直有（条挂在 `updateChatStatus()` 上），只是在头部那一行、又只有 8 格，没被认出来；搬到输入框下面并按 54 帧走之后就清楚了 | —— |
| **压缩也有条** | 面板自己消费 `session.compaction.*` 记进 `store.compacting`（会话级 Set），并把「消息列表里最新一条 `status==='running'` 的 compaction」当刷新后的兜底；`isRunning()` / `updateChatStatus()` / 列表徽标都取同一个 `compactionRunning()` | 实测压缩跑到一半 `/api/session/active` 会空一拍（约 7.4s 就没了，而压缩到 10.85s 才结束）→ 只认 active 的话条会中途灭掉 |
| 压缩块 | 消息流里 `type:'compaction'` 不再画 `· compaction` 一句，改成 TUI 风的一块：运行中 → 行首盲文 spinner（与工具行同一条帧表）+ `上下文压缩` + `进行中`；完成 → `⏺` + `N tokens` + `<details class="compact"><summary>摘要</summary>`（**默认折起**）；`error.type==='aborted'` → `已取消`；其它失败 → `✗` + `error.message` | 实测一份摘要 5~9 KB（真会话里抓到 4883 字节），手机上摊开能把整段会话顶没 |
| 顺带修 | 窄屏加 `html.narrow.view-chat #chatpane { grid-column: 1 }` | 桌面那份 `grid-column: 3` 在单列网格里会撑出两个隐式列，对话区只按**内容宽度**落位 —— 底板收成细边（内容很短）时右边就白出一条，细边也不铺满 |

**实测**（两条证据链）：

1. 真服务 + 真面板（`/tmp/ocsm-probe/pbar2/live-shot.js`：鉴权本地反代 + 一张 1px 图挂住 `load` + 深链
   `#会话id` + 无头 Firefox；状态由 `/tmp/ocsm-probe/probe/reporter.js` 每 200ms 上报一次）：
   - 手机 393×894（默认**收起**）：`● 运行中`、`条hidden=false`、条 `rect(top,left,w,h)=[864,14,71,13]`、
     底板 `[845,0,393,49]` —— 条在细边最左、左侧留白正好一格 14px；采到的格子序列
     `2,4,6,5,2,0,1,4,6,4,1,0,3,6,5,2,0,1,4,6,4,1,0,1,5,6,2,0,…`（升到 6 → 掉到 0 → 再升，正是
     「正走 / 空 / 倒走」那套，14 帧的旧表不会这样来回）；
   - 桌面 1366×900：条 `top=874`，输入框 `top=794 h=80` → 条紧贴输入框**下面**（874 = 794 + 80）；
   - **真压缩一回合**（对 `ses_demo_compact_a` 发 `/compact`，SSE `started 6.08s → ended 13.54s`）：
     面板从 `3889ms` 起画 `msg compaction live:⠋上下文压缩进行中`，行首 spinner 一路
     `⠋⠸⠴⠇⠹⠧⠏⠙⠼⠦` 在转，`bar` 全程不是 `hidden`（含空拍）；`11163ms` 那一拍 `activeSel=None`
     （就是上面那个「空一拍」）而条仍然亮着；`11364ms` 收工 → `空闲` + 条收起 + 块变成
     `⏺上下文压缩 4,454 tokens 摘要…`；
   - 真载荷渲染：`ses_demo_compact_b` 里那条真 compaction（摘要 4883 字、
     `tokens = 1255 + 2472`）直接喂给真 `renderMessage` → `⏺上下文压缩 3,727 tokens 摘要…`、`details=folded`；
     真面板上同一块也核对过。
2. 静态目检（`/tmp/ocsm-probe/pbar2/shot.js`：真 `index.html` + 真 `app.js`/`styles.css`，挡住 `init()` 只渲染）：
   桌面展开 / 手机展开 / 手机收起（细边）/ 压缩块（进行中 + 已完成 + 真载荷）四张截图。

**回归**：`ui-stream` 131 → 162（+20 条状态条位置与整圈 54 帧、+26 条压缩）、`ui-composer` 84 → 91
（+7 条细边上的状态条）、`ui-mobile` 154 → 160（+3 条窄屏列位，两个视口各跑一遍）、
`smoke.sh` 178 → 187（J 组 11 → 20）；`ui-*` 其余与 `e2e-*` 全部 0 失败。
`test/ui-composer.html` 的夹具也补上了 `#progress`（与 `public/index.html` 的底板段保持一致）。

---

### 8.11 追加：压缩时面板假死、概要也不印（`session.compaction.delta`）

**起因**：用户两条反馈 —— ①「上下文压缩的时候，网页版崩溃无响应了」；②「上下文压缩，打印的概要之类的，网页版也不打印」。

#### 先把 TUI 的事实抓准

`/tmp/ocsm-probe/tui/cap-compact.py`（pty 跑真 TUI、发 `/compact`、每秒存一张屏 + raw 字节）看到的：

| 事实 | 来源 |
|---|---|
| 压缩块是一条**整宽横线 + 盲文 spinner + 「Compaction」**：`───────── ⠋ Compaction ─────────` | raw 里的重绘帧 |
| **概要正文边压边印**（流式）在块里，**摊开、不折**（`Objective` / `Requirements` / `Work state` … 原样铺在会话流里） | t=20.1s 抓屏 |
| 发 `/compact` 时先给一句回执 `◇ Compaction queued` | raw |
| 去 ANSI 后 raw 里只有 5 处 `Compaction`（都是重绘），没有「摘要」这一层折叠 | raw 统计 |

服务端这边（真 SSE 抓包，`curl -N /api/event` 对着一次真压缩）：

| 事实 | 数据 |
|---|---|
| 概要正文是流式的：`session.compaction.delta`，`data = { sessionID, text }` | 一份 519 字摘要来了 **140 条**，666ms 内（≈**5ms 一条**） |
| `.started` 载荷带 `sessionID/reason/inputID`（`inputID` 就是那条压缩消息的 id） | 抓包 |
| `.ended` 载荷带 `reason/model/text/tokens`（`text` 就是完整摘要） | 抓包 |

#### 病根：`.delta` 被当成「收工」

老代码是 `session.compaction.` 前缀**一把抓**：

```js
if (sid) {
  if (t === 'session.compaction.started') store.compacting.add(sid);
  else store.compacting.delete(sid);   // ← .delta 也落进这里
  dirty = true;                        // ← 于是每条 delta 都 dirty 一次
}
```

`dirty = true` 的后果是 `renderSessions()`（整个左栏重建）+ `updateChatStatus()`。
实测（`/tmp/ocsm-probe/perf/live-compact.js`：真面板 + 真压缩 + 包住 `renderSessions` 计数）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 一次压缩里的 `renderSessions()` | **142 次**（≈140 条 delta 逐条触发，整段 0.7s） | **10 次**（整段 14s 里的全部事件，含两次压缩起止） |
| 主线程最大停顿 | 连续被占满（页面假死） | **54ms** |
| 压缩中概要是否上屏 | 否（delta 全丢） | 是（正文 0 → 2 → 63 → 168 → 212 → 280 字一路长上来） |

也就是说：**用户报的「崩溃无响应」和「概要也不打印」是同一个 bug 的两面** —— 那条流式正文被丢了，
而它带来的事件风暴把面板顶死了。

#### 改法（`public/app.js`）

| 点 | 决定 |
|---|---|
| 三种事件分开 | `.started` 开工（清上一次正文）；`.delta` 只攒正文 + 节流重画**对话区**，不碰左栏；`.ended`/`.failed` 才收工（并把载荷里的完整摘要写上，不等消息列表对账） |
| 立刻出块 | `.started` 的 `inputID` 就是那条压缩消息的 id → 直接往 `store.messages` 里放一块 `status:'running'` 的占位，真消息一到同 id 覆盖。这样不用干等那次对账拉取（正文流得快时 `msgTimer` 会被逐条推后，等不到） |
| 正文缓冲 | `store.compactText: Map<sid, string>`，`.delta` 一段段追加（最多留 8 个会话） |
| 取值 | `compactionBody(m)`：服务端给了 `m.summary` 就用它（权威），还在跑就用流式缓冲 |
| 上屏节流 | `paintCompactStream()`：前沿节流 120ms（~8 次/秒），且只画用户正看着的会话；正文并进 `view.summary` 再算渲染签名，签名才会跟着长 |
| 印出来 | `<details class="compact" open>` + `md(body)` —— 照 TUI 摊开印着，外层 `details` 只当折叠抓手 |
| 不跟用户抢 | `syncDetailsOpen()`：签名变就整块换元素，只把「用户折起来过」这一种状态搬过去（反方向不搬 —— 流式思考块的「开」是渲染按 `m.live` 决定的，回合结束该自己回落，`ui-stream` 有断言锁着） |

#### 验证（真服务）

对真会话发 `/compact`，无头 Firefox 打开真面板（深链到该会话）逐 150ms 拍时间线：

```
t=4620  ● 运行中  live=True  open=None  正文=  0  ⠙上下文压缩进行中
t=5674  ● 运行中  live=True  open=True  正文=  2  ⠸上下文压缩进行中
t=5830  ● 运行中  live=True  open=True  正文= 63  ⠴上下文压缩进行中
t=5980  ● 运行中  live=True  open=True  正文=168  ⠧上下文压缩进行中
t=6280  ● 运行中  live=True  open=True  正文=280  ⠙上下文压缩进行中
t=6587  空闲      live=False open=True  正文=336  ⏺上下文压缩692 tokens
```

中间那一拍还截了图：块头 `⠋ 上下文压缩 [进行中]` 下面 `▾ 摘要` **摊开**、正文正在一行行长出来；
收工后同一块变成 `⏺ 上下文压缩 692 tokens` + 完整摘要（仍是摊开）。
页面异常 `[]`、主线程最大停顿 54ms、左栏整段只重画 10 次。

**回归**：`ui-stream` 162 → 183（+21 条：`.started` 占位、三条 delta 只画一次且不重画左栏、不抹压缩标记、
正文攒缓冲、压缩中摊开印出、用户折起不被顶开、`.ended` 就地收工写摘要）、`smoke.sh` 187 → 189
（+2 条源码锁：`.delta` 单独处理 + `paintCompactStream()/compactionBody()`；压缩摘要那条断言从「折起」改成「摊开」）；
`ui-*` 其余与 `e2e-*` 全部 0 失败。

---

### 8.12 追加：临时拉出列表之后「删一个会话」不该把列表收回去

**起因**：用户——「鼠标向左边缘移动自动展开侧边栏，删除其中一个会话之后，侧边栏就收回去了，这种情况下应该等个几秒」。

**病根**（`setupListPeek()` 的老实现）：

`onAction()` 的改名 / 移动 / 删除走的是原生 `prompt()` / `confirm()`。原生弹窗期间，页面会
收到一串看着像「指针跑掉了」的事件：`mouseleave`（指针离开文档），弹窗关掉时浏览器还可能
再来一发 `mousemove` 用它记下的位置同步指针状态。老实现是 `main.addEventListener('mouseleave', hide)`
+ `onMove()` 里 `clientX >= 分栏槽右沿 → hide`，**任一条命中就把 `list-peek` 摘掉**。

（第一版只吞掉「一次 `mouseleave`」—— 装到用户机器上症状照旧，说明那串事件不止一发。
所以改成宽限期里两条路径都不收。）

真正的麻烦在后面：`list-peek` 一摘，分栏槽就从「列表宽 + 16」缩回 `x = 0..16`，而指针还停在
原来那一行的位置（早就 > 16 了）—— 之后随便动一下就被判成「挪进对话区」，列表再也拉不回来。
想接着删下一个只能重新把鼠标贴回左边缘。

**改法**（`public/app.js`）：动手之前先武装一段宽限期，**两条路径都不许收**。

| 点 | 决定 |
|---|---|
| 武装 | `onAction()` 第一句 `if (listPeekHold) listPeekHold();` —— 比 `confirm()` 早，弹窗那串事件已经算在里面了 |
| 条件 | 只在「桌面 + 列表处于收起态 + 此刻正临时展开着」时武装；窄屏、列表本来就开着都不武装 |
| 效果 | `PEEK_HOLD_MS = 5000`（用户实测后定：5 秒左右自己收）之内**谁来都不收**：`mouseleave` 挡、`mousemove` 的「挪进对话区」也挡（弹窗丢过来的那一发未必是用户挪的） |
| 到点复查 | 宽限期结束时按「指针最后一次**真实** `mousemove` 停在哪」判断：还在分栏槽里就继续留着（那多半是想接着删下一个），已经挪进对话区就收掉 |
| 不做假 | `onMove()` 照旧记录 `peekLastX`（只是暂时不去收），所以复查用的是真实位置；`hide()` 只在显式场合（点手柄、初始化、复查判定）强制收 |
| 只用一次就够 | 宽限期只武装一次（一次动作对应一次弹窗）；到点复查完就恢复常态，之后 `mouseleave` / `mousemove` 说了算 |

**验证**（真面板 + 真服务，`/tmp/ocsm-probe/perf/live-peek.js`：反代带鉴权、把 `window.confirm` 桩成 `true`
免掉无头里的真弹窗，然后贴左边缘 → 点那一行的「删除」→ 手工派发弹窗会丢过来的那两类事件）：

```
PASS 列表里找到目标会话那一行
PASS (前置)列表收起
PASS 鼠标贴左边缘 → 临时拉出来
PASS 拉出来之后分栏槽挪到右边(>=400px)
PASS 会话确实删掉了(那一行没了)
PASS 删完之后列表还留着
PASS 宽限期里 mouseleave 不收
PASS 宽限期里那一发合成的 mousemove(坐标在对话区)也不收
PASS 指针最后停在对话区 → 到点自己收掉
PASS 收掉之后列表也藏起来了
PASS (前置)找到第二个目标会话
PASS (前置)又拉出来了
PASS (前置)第二个也删掉了且列表还留着
PASS 到点复查:指针还在槽里 → 留着(方便接着删)
PASS 宽限期过了之后挪进对话区 → 照旧立刻收
```

**回归**：`ui-layout` 141 → 154（+3d 组 13 项：真走一遍 `onAction('del')`、宽限期武装上了、
`mouseleave` 不收、合成 `mousemove` 也不收、到点复查两种走向、过后照旧立刻收、列表开着时不武装）、
`smoke.sh` 189 → 191（+2 条源码锁）；`ui-*` 其余与 `e2e-*` 全部 0 失败。

---

### 8.13 追加：打开网页时列表一定是展开的（折叠不再跨刷新）

**起因**：用户——「第一次打开网页时，应该展开对话列表」。

**为什么他打开看到的是收起的**：`setupListToggle()` 当时把折叠态记在 `localStorage['ocs.listHidden']`
（这是 v1 的决定，见 `2026-10-15-session-manager-design.md`「列表折叠」）。他为了试 §8.7 的
「靠左边缘临时拉出」点过手柄把列表收起来 —— 那笔状态就一直躺在浏览器里，之后每次打开网页
都按它重画成收起。代码没错，是「折叠被记住」这件事本身不合他的用法。

**决定**：折叠**不跨刷新**，打开网页时列表一定是展开的。
（**§8.38 改回**：用户后来要「收起之后刷新还得收着」，于是改记 `sessionStorage` ——
刷新同一标签页保持、新标签页仍展开，两句话都成立。下面这张表里只有「存储」那一行作废。）

| 点 | 决定 | 理由 |
|---|---|---|
| 首屏 | `setupListToggle()` 一律 `paint(false)`，不再读存储 | 列表是主入口，首屏就该看见它；「第一次打开网页」不该继承一次顺手收起 |
| 存储 | `ocs.listHidden` **既不读也不写**，整段删掉 | 留一份没人读的状态只会误导后来人：源码里只留一句注释说明它退休了，`smoke.sh` 反向锁住「不再读写」 |
| 折叠还留着 | 手柄照旧能收 / 能展，只是不跨刷新 | 收起是「这一屏给对话区让地方」，和 §8.7 的「临时拉出」一个性质，不是一条要一直生效的设置 |
| 状态源 | 点击时以 `<main>` 上的类为准（`paint(!main.classList.contains('list-hidden'))`） | 少一份可能对不上的影子状态（原来是「存储为准」） |
| 列宽 | `ocs.listW` 照旧记忆 | 与折叠无关；用户拖出来的宽度（收起 → 展开、刷新）都不该丢 |

**验证**（真面板 + 真服务，`/tmp/ocsm-probe/perf/live-listopen.js`：反代这一层把
`localStorage.setItem('ocs.listHidden','1')` 插在 `app.js` **之前**，让「页面加载时存储里已经躺着
收起态」真的发生，再等 `--list-w` 生效确认 init 跑完）：

```
PASS (前置)存储里确实躺着上次的收起态
PASS (前置)页面已初始化完(记下来的列宽 420px 生效了)
PASS 首屏列表是展开的(main 上没有 list-hidden)
PASS 首屏列表看得见
PASS 首屏第一列是列表宽(不是 0px)
PASS 首屏分栏槽不在最左边缘(列表占着地方)
PASS 首屏对话区没被整片挤掉
PASS 手柄 aria-expanded=true
PASS 手柄文案是「收起会话列表」
PASS 手柄箭头是「‹」(露出 .ao)
PASS 点手柄照样能收起
PASS 收起后列表藏起来
PASS 收起后分栏槽仍是 16px 窄槽(手柄还在)
PASS 再点一下又能展开
PASS 展开后列宽还是 420px
PASS 存储里那笔老值一动没动(既不读也不写)
```

**回归**：`ui-layout` 154 → 160（把「按存储进入收起态」那一组改成「折叠不跨刷新」——
重新接线后必须是展开态；另外把测试里所有「用 `localStorage` 造收起态」的夹具换成直接给
`<main>` 加类，因为那条路已经没了）；`smoke.sh` 191 不变（「记住折叠状态」那条源码锁换成
「一律展开 + 不再读写 `ocs.listHidden`」）；`ui-*` 其余与 `e2e-*` 全部 0 失败。

---

### 8.14 追加：Esc 要按两下才打断，且中断后「排队中」的消息接着发

**起因**：用户——「tui 是按两下 ESC 打断，然后排队中的 prompt 自动发出；网页版是按一下 ESC 就打断，
排队中的 prompt 不会自动发送」。

**TUI 的权威事实**（在本机 `opencode` v2.0.16 那个 211 MB 的单文件二进制里读出来的，
TUI 是 `opentui` 的 JS，代码原样躺在里面）：

```js
armInterruptTimer() { this.clearInterruptTimer();
  this.interruptTimeout = setTimeout(() => { … this.patch({ interrupt: 0 }) }, 5000) }
handleInterrupt = () => { if (this.isClosed || this.state().phase !== "running") return false;
  let t = this.state().interrupt + 1;
  if (this.patch({ interrupt: t }), t < 2) return this.armInterruptTimer(), true;
  return this.clearInterruptTimer(), this.patch({ interrupt: 0 }),
         this.setNotice("interrupting"), this.options.onInterrupt?.(), true };
```

- 第一下只是**计数 +1**并挂一个 **5 秒**归零定时器，第二下（窗口内）才真打断；
  提示文案按宽度挑：`Press esc again to interrupt` → `esc again to interrupt` → `esc again: stop` → `esc stop`。
- 输入框一有动静（`handleInputClear`）就把计数清掉；`phase` 变 `idle` 也归零。
- `onInterrupt` 就是 `session.interrupt({ sessionID, resume: true })`。
- **为什么 TUI 一打断排队的 prompt 就跟着跑**：TUI 输入框默认用 `steer` 投递
  （`Rt=(w="steer")`、`De(prompt, "steer")`），而服务端 `session.interrupt` 带 `resume=true` 时会取
  inbox 第一件，**只有 `steer` / `compaction` / `move` 才 `wake`** —— 于是它顺手就把那条跑起来了。
  面板默认走「排队」（`queue`），拿不到这个顺手。

**真服务实测**（临时会话 + `sleep 300` 的长回合 + `curl`，四条都跑过一遍）：

| 场景 | 结果 |
|---|---|
| A：中断**不带** `resume` + `queue` 项 | 那条**永远**躺在待发送队列里（盯着看了 30 秒没动）|
| B：`interrupt?resume=true` + `queue` 项 | **还是躺着**（接口文档也写着：`queued prompts remain parked`）|
| C：`steer` 项 + `interrupt?resume=true` | 挨着就跑起来了（TUI 走的正是这条）|
| D：`queue` 项，中断返回后立刻（0.01s）`PATCH` 成 `steer` | 也跑起来了 —— 没有「回合还没收干净」的竞态 |

**决定**：

| 点 | 决定 | 理由 |
|---|---|---|
| Esc | **按两下**才打断：第一下只上膛（状态条那句提示换成 `esc again to interrupt`，再补一句 toast），**5 秒**内按第二下才真发请求 | 照 TUI 抄；Esc 在面板里还兼职「关命令面板 / 关 @ 补全」，手滑一下就把正在跑的回合砍了，代价太大 |
| 上膛归零 | 输入框有动静、回合结束、真的打断，三处都收 | 照 TUI 的 `handleInputClear` 与 `phase === "idle"`；半次 Esc 不能悬在那儿等手滑 |
| `■ 中断` 按钮 / 命令面板的「中断」 | 照旧**一下**生效，不走两下 | 它们是写明动作的按钮，不是「顺手按到」的键 |
| 提示位置 | 状态条旁边那句（TUI 的 `prompt.footer`）+ 一句 toast | `.phint` 在底板收起 / 窄屏时是 `display:none`，收起态下只看它等于没提示 |
| 中断请求 | 带 `resume=true` | 和 TUI 的 `session.interrupt` 完全同调法：接上「插话」类待投递输入与下一件控制项 |
| 排队消息放行 | 中断成功后把 inbox 里 `type==='user' && delivery==='queue'` 的项 `PATCH` 成 `steer`（就是它的「改为插话」，会 `wake`） | 面板保持自己「排队」的默认语义，只在被打断这个边界上放行；服务端对 `queue` 的定义是「等下一次回合边界」，被中断之后不会再有下一个边界 |
| 只推 `user` | 压缩 / 移动这类控制项不碰 | 它们已经由 `resume=true` 自己接管了 |
| 状态条 `title` | `按 Esc 中断` → `连按两下 Esc 中断` | 鼠标停上去看到的说明得跟实际行为一致 |

**验证**（真面板 + 真服务，`/tmp/ocsm-probe/perf/live-interrupt.js`：造一个干净会话 → 起长回合 →
运行中排一条队 → 派发真 `keydown` → 看面板自己的 `store.inbox` / `#messages` / `#progress .phint`）：

```
PASS 造出探针会话 / 面板选中了探针会话
PASS 面板认到回合在跑(SSE) / 状态条亮起来了
PASS 面板认到待发送队列里有一条
PASS Esc 第一下不发中断请求
PASS Esc 第一下把状态条提示换成「再按一次」
PASS Esc 第一下给一句 toast
PASS 队列里那条还老老实实待着
PASS Esc 第二下发中断请求
PASS 中断请求带 resume=true(照 TUI)
PASS 第二下之后提示文案收回原文
PASS 发出去了把排队项改成 steer 的 PATCH
PASS 排队里那一条已经不在队列里了(被放走)
PASS 那条文本进了消息流(真的发出去了)
PASS 它自己跑起来了(回合又转起来)
```

**回归**：`smoke.sh` 191 → 194（Esc 优先级那条顺序锁换成 `requestInterrupt()`，另加「两下才打断
+ 输入框归零 + 中断带 resume 并放行排队项」三条源码锁）；`ui-commands` 155 → 166（⑩ 组把
「一按即断」改成「第一下上膛 → 第二下才打断」，并补上定时器到点、输入框归零、回合结束归零）；
`ui-controls` 83 → 87（中断请求的 URL 带 `resume=true`，以及「只推排队项、不碰插话项与控制项」）；
`ui-layout` / `ui-stream` / `ui-composer` / `ui-mobile` / `ui-jump` / `ui-tools` / `ui-asks` /
`ui-capabilities` / `ui-attach` / `ui-picks` / `netallow` 与 `e2e-*` 全部 0 失败。

### 8.15 追加：会话头部显示上下文用量（TUI 提示栏那个 `155.6K (78%)`）

**起因**：用户——「网页版不显示 155.6K (78%)」。TUI 提示栏右边一直有这个数，面板没有。

**TUI 的权威实现**（同一份二进制里抠出来的原文）：

```js
// 最后一条带 tokens 的 assistant 消息，且必须在「最后一次【已完成】压缩」之后
function Us(t, n) { let i = n ? t.findIndex((a) => a.id === n) : -1;
  if (n && i === -1) return; let s = i === -1 ? t.length : i,
    o = t.findLastIndex((a, c) => a.type === "compaction" && a.status === "completed" && c < s);
  return t.findLast((a, c) => a.type === "assistant" && a.tokens !== void 0 && c > o && c < s) }
function XN(t, n, i) { let s = Us(t, i); if (!s) return;
  let o = s.tokens.input + s.tokens.output + s.tokens.reasoning + s.tokens.cache.read + s.tokens.cache.write;
  if (o <= 0) return; let a = n?.find((c) => c.providerID === s.model.providerID && c.id === s.model.id);
  return { tokens: o, percent: a?.limit.context ? Math.round(o / a.limit.context * 100) : void 0 } }
function d4(t, n) { let i = zN(t); return n === void 0 ? i : `${i} (${n}%)` }
zN = (e) => e >= 1e6 ? (e / 1e6).toFixed(1) + "M" : e >= 1000 ? (e / 1000).toFixed(1) + "K" : String(e)
```

`ge = () => usage?.tokens > 0 ? d4(usage.tokens, usage.percent) : ""`，由提示栏的 `context` 字段挑档：
百分比已知 → 窄屏 `78% ctx`、宽屏 `155.6K (78%)`；拿不到百分比 → 两边都只印 token 数。

**决定**：

| 点 | 决定 | 理由 |
|---|---|---|
| 位置 | ~~聊天头部标题行右侧~~ → **输入框下面的提示栏 `#promptFooter`**（§8.19 改，§8.20 补齐顺序/费用/`:分支`/`~/`，§8.21 再补智能体·模型/`tab agents`/子会话·shell）| 当初放头部是嫌 `#progress` 那行只在运行中才露；后来照 TUI 把提示栏做成**常驻行**（挂在 `#composer` 外面），路径 + 用量 + 命令提示一起，展开底板时比头部更贴「看一眼」。**（§8.40 改：收起成细边时这一行跟着收，只留进度条）** **（§8.42 改：手机上整条都不显示了 —— 展开底板时也收，那一行在手机上从此只在桌面存在）** |
| 算法 | **每次现算**，不另存 | 照 TUI 的 `Us`/`XN`/`d4` 原样搬（同一份口径也喂给渲染：`currentMessages()`）|
| 两档文案 | 全量 / 窄屏两份都写进 DOM，CSS 按 `html.narrow` 切 | 横竖屏来回转不用重画，也不用 JS 判宽度（照 TUI 的 `compact` / `full`）|
| 模型表 | 用**该 location 的模型表**（`store.models.get(dir)`），不用全局索引 | 某个模型可能在某个目录被 `enabled:false` 关掉；TUI 用的就是 `location.model.list`。查不到就退化成只印 token 数 |
| 空态 | 压缩后还没回话 / 还没跑过任何一轮 → 整块收起 | `Us` 返回 `undefined` 时 TUI 也不印 |
| 刷新时机 | 挂在 `updateChatStatus()`（step.ended / 消息落盘 / 切会话都会经过它）+ `renderControls()`（模型表回来之后补一次）| 一个同步点就够，不必给每个事件单开分支 |

**顺带修掉一个真 bug**（探针撞出来的）：切到一个刚建的空会话时，`store.messages` 里躺着**上一个会话的 49 条**
—— 「150ms 防抖对账」的 `loadMessages()` 在切换之后才回来，而它**没有按会话复查**。现在 `await` 之后
按 `id` 比对 `store.selected`，变了就整份丢弃。上下文用量跟着这个消息表走，所以这条必须先修。

**验证**（真面板 + 真服务，`/tmp/ocsm-probe/perf/live-ctxusage.js`，视口 393×894 → `html.narrow`）：
探针自己拉 `/api/session/:id/message` 与 `/api/model` 用**独立的 TUI 算法实现**复算期望值，再和面板 DOM 比
（`ses_demo_a… 47%`、`ses_demo_b… 45%`、`ses_demo_c… 60%+`、目录已删的那个只印 token 数；
至少一个被测会话带「已完成压缩」，压缩分支真跑到了）。另外 4 条：两档文案的 CSS 切换（含临时摘掉
`html.narrow` 验桌面档）、空会话整块收起。截图 `live-ctxusage.png` 里头部能看到 `65% ctx`。

**回归**：`smoke.sh` 194 → 202（Q 组 8 条：`#ctxInfo` 在标题行里、两档文案、CSS 切档、压缩那一步、
五路求和 + `limit.context`、`fmtSize`、窄屏文案、三个调用点 + 共用口径）；`ui-stream` 183 → 195
（上下文用量 12 条，含压缩后重新起算、percent 可空、`step.ended` 立刻算出）；其余套件与 `e2e-*` 全 0 失败。

**（后续）** §8.19 把这一格从头部挪到输入框下面的提示栏（照 TUI 的 `prompt.footer`）；§8.42 把提示栏在
手机上整条收掉；**§8.43 又把它单独搬回标题行末尾**（同一个节点，见 §8.43）—— 转了一圈：手机上它最终
还是在「一眼能看到」的头部，只是那行里只剩它一个。

### 8.16 追加：压缩/输出不再每个 delta 强制排版（性能）

**起因**：用户——「上下文压缩时，不会崩溃无响应了，但还是有点卡顿，输出卡，我怀疑进度条一动的时候就卡」。
先量再改（探针 `/tmp/ocsm-probe/perf/live-perf2.js`：真面板 + 一个 100 条消息 / 7838 节点的大会话，
把 `renderMessages()` 内部各步拆开计时，并记时间线）。

**量到的事实**（无头 Firefox，软件渲染，绝对数偏大，但相对关系清楚）：

| 动作 | 耗时 |
|---|---|
| `drawProgressFrame()` 一帧（8 格换 `content`） | **0.007ms** |
| 进度条换一帧**再读** `scrollHeight` | **1.1ms**（它不脏 `#messages`）|
| `md()` 解析 8~11 KB 摘要 | 0.1~1.5ms |
| `host.innerHTML = md(正文)`（写 DOM） | 0.3ms |
| **改完 `#messages` 再读 `scrollHeight`/`atBottom`** | **28~34ms**（**强制同步排版**）|
| 干净时读 `scrollHeight` | 0ms |
| 往 `#messages` 塞一个**空 div** 再读 | 24ms（**与改动大小无关**）|
| **流式**：每个 token delta 走一遍 `atBottom()` | **28ms/delta** |
| spinner 每 80ms 改一次 `#messages` 里的 `textContent`，再读 | 39ms |

也就是说：**卡的不是进度条**，是「改一下 `#messages` 的东西 → 紧接着读 `scrollHeight`」那次**强制整篇排版**；
`renderMessages()` 压缩期一次 70~76ms 基本全是它（其中干净读只要 0.95ms）。而旧代码里
`renderMessages()` 一次要读 2~3 回（开头 `atBottom()`、跟底 `scrollTop = scrollHeight`、收尾
`updateJumpLatest()` 又读一次），`paintLiveDelta()` 更是**每个 token delta 都读一次**。

**决定**：

| 点 | 决定 | 理由 |
|---|---|---|
| 压缩正文 | 走**局部**重绘 `paintCompactBody()`：只换 `details.compact > .content` 那一个节点 | 正文只有这一处在长；整表 `renderMessages()` 会重建压缩块（脏树）+ 重算全表签名。结构还没建出来（空正文时块里没有 `<details>`）才返回 false 退回整表 |
| 「贴不贴底」 | 新增 `store.nearBottom` 缓存，**唯一写点** `updateJumpLatest()`（滚动事件、每次渲染收尾都汇到这里）| 增量重绘（`paintLiveDelta` / `paintCompactBody`）不再自己读布局 —— 用户往上滚，滚动事件照样立刻把缓存刷掉，跟随不会失灵 |
| 整表收尾 | `renderMessages()` 把**已经算出来的**「贴不贴底」布尔喂给 `updateJumpLatest(atB)` | 省掉它自己再读一次 —— 那次读正好落在刚改完 DOM 之后，是整个函数里最贵的一步。只有「还原滚动锚点」位置不确定时才量一次 |
| 参数 | `updateJumpLatest(atB)` 只认 `boolean` | 它同时是 `scroll` 监听器（会被塞 Event 对象），非 boolean 就自己量一次 |
| 没上（当轮） | `content-visibility:auto;contain-intrinsic-size:auto …` 能把那次 flush 从 ~30ms 砍到 6~12ms（**4×**）| 但它会让 `scrollHeight` 先按估值算 —— 影响「一键回底 / 锚点还原 / 总在底部」这几处的准头，当轮先不动。**下一轮上了（只给长会话），见 §8.17** |

**验证**（`live-perf2.js` 对拍，同一页面同一夹具）：流式每个 delta 的强制排版
**28ms → 0ms**（`streamOldPerDeltaMs` / `streamNewPerDeltaMs`）；进度条那条 **1.1ms** 顺手证了它的清白
（用户怀疑的对象）。探针同时确认 `atBottom` 干净读 0.95ms、脏读 23~29ms，`md`/`innerHTML` 都不是瓶颈。

**回归**：`smoke.sh` 202 → **204**（自动跟随那条改成「整表量、增量读缓存」，另加 nearBottom 单一写点、
压缩正文局部重绘两条）；`ui-stream` 195 → **205**（压缩正文局部重绘 8 条 + 结构没建出来时退回整表 2 条）；
`ui-jump` 44 → **47**（缓存的唯一写点、Event 不会被误当 boolean）；其余套件与 `e2e-*` 全 0 失败。

### 8.17 追加：长会话里离屏消息整块跳过渲染（性能，上更猛的）

**起因**：用户——「上更猛的优化」。上一轮把「每个 delta 都读一次布局」掐掉了，但**每次真要读**的那一下
（`renderMessages()` 收尾、`paintCompactBody()` 之后、`paintLiveDelta()` 跟底）仍然是强制整篇排版，
绝对值 24~36ms 取决于会话里**有多少内容**。这一轮直接把「看不见的东西」从排版里摘出去。

**做法**：

| 点 | 做法 |
|---|---|
| 离屏消息 | `#messages.cvmany > .msg { content-visibility: auto; contain-intrinsic-size: auto 220px; }` —— 离屏的 `.msg` 整块跳过渲染，只留估值高度占位（`auto` 表示渲染过一次就记住真实高度，滚回去不跳） |
| 开关 | `renderMessages()` 按条数挂：`box.classList.toggle('cvmany', msgs.length >= CV_MIN_MSGS)`，`CV_MIN_MSGS = 30` |
| 短会话 | **不挂** —— 短会话离屏内容本来就没多少，省不下几个钱，却要拿估值高度去占位；实测它会把「短会话压根不用滚」的场景撑出 118px 的假滚动条（`ui-layout` 里那条「没有存档时刷新仍按老样子」当场抓到） |

**实测**（探针 `/tmp/ocsm-probe/perf/cv-perf.js`，同一个 100 条消息 / 6900 节点的大会话，
同一页里用 `!important` 反过来关掉 cv 对拍）：

| 动作 | cv 关 | cv 开 |
|---|---|---|
| **改 DOM(往最后一条塞个字) 再读 `scrollHeight`** | **28/31/36ms**（min/med/max） | **0/0/0ms** |
| 「跳到最新」落点 | — | `gap = 0`、`atBottom = true`（连着量两回都是 0，不会冒出「跳到最新」按钮）|

**准头为什么没被估值带坏**（这轮专门验的，探针里先「把所有 `.msg` 换成新元素 + 滚口拉回顶部」造一个冷加载现场）：

- **锚点还原**：`applyScrollAnchor()` 是「量出锚点相对滚动口上沿的差，再滚掉它」——
  滚完之后锚点**正好**落在 `off` 处，而接下来重排的是锚点**下方**刚露头那一屏，锚点自己不动。
  上面那些离屏消息就算还按 220px 估值占位，也只让**滚动条比例**不准，不影响锚点在屏上的位置。
  实测：冷现场还原后偏 **1px**，再强制一次布局还是 1px。
- **一键回底**：`scrollTop = scrollHeight` 后 `gap = 0`；再量两次、再跳一次都是 0。
  估值偏大在这里是**安全方向**（内容随后缩回真实高度时，`scrollTop` 被夹回新的底部）。
- 所以**没有**动 `applyScrollAnchor`（试过「量→滚→再量」迭代，实测收益 0，白多几次强制布局，撤了）。

**回归**：`smoke.sh` 204 → **209**（`.cvmany` 三件套在、**反向封锁**不许挂成无条件的 `#messages > .msg`、
开关由 `renderMessages()` 按 `CV_MIN_MSGS` 挂且 `ui-layout` 有正反两面断言）；`ui-layout` 160 → **162**
（长会话挂 `.cvmany`、短会话不挂）；`ui-commands` 166、`ui-stream` 205、`ui-jump` 47 等其余套件与 `e2e-*` 全 0 失败。

**本地没能验到的（如实记下）**：

- 本机只有**无头 Firefox** 能跑，而它**根本不给 `content-visibility: auto` 跳过的内容上色**：
  截图里消息区只剩左边框、正文一片空白（连跑 1.6 秒 CSS 动画想让刷新驱动转起来也一样，）
  —— 所以「肉眼看起来对不对」在本地**验不了**。能确定的只有**尺寸/落点**（那批实测都是尺寸量出来的）。
- 因此另跑了一组**安全候选对拍**（`/tmp/ocsm-probe/perf/contain-perf.js`，同一页里换注入的样式）:
  `contain: layout` 28ms、`contain: layout style` 30ms、`contain: layout style paint` 32ms、包在 `.content` 上 27ms
  —— **都没用**（比 baseline 还慢）；只有 `content-visibility: auto` 与 `contain: strict` 是 0ms，
  而 `contain: strict` 带 `contain: size`（消息高度直接塌掉）不能用。**结论：想要这个收益就绕不开 cv 的跳过绘制。**
- 另外两处**已知代价**（不是 bug，是这套做法的固有代价）：① 滚动条比例按估值算，
  **第一次**往上翻时逐条换回真实高度，内容会有小幅抖动（`contain-intrinsic-size` 的 `auto` 记住之后就稳了）；
  ② 估值的准头决定抖动大小 —— 这个会话 100 条 / 24400px，平均 244px，与 220 的估值差 ~10%，实测锚点落点仍只差 1px。
- **兜底（一行就能退）**：手机上真看着闪/空，把 `styles.css` 里 `#messages.cvmany > .msg` 那三条删掉即可
  （静态资源，后台不用重启）；要看备选做法见上面的对拍数字。参考:open-webui 的消息列表也是拿
  `content-visibility: auto` 替掉了它自己那套 JS 裁剪。

### 8.18 追加：运行中发消息默认「插话」，不是「排队」（对齐 TUI）

**起因**：用户——「还在会话中，再次发送信息，tui 里发送的新信息不是放入 queued 的，好像是等候区，
不用等完整会话结束就发出去了？但是网页版的就是放入 queued」。

**查到的 TUI 行为**（从 `opencode` 二进制里抠出来的键位表）：TUI 里**光按 `Enter`** 是
`"prompt.submit": c("none","Submit prompt")`，落到 `session.prompt({delivery:"steer"})`；
**排队要额外按 `<leader>return`**，即 `"prompt.queue": c("<leader>return","Queue prompt")`。
`session.compact` 的描述也写着「Steers by default: it runs at the next step boundary instead of waiting
behind queued prompts」——**steer = 下一个 step 边界就并进当前回合；queue = 排在队尾等回合边界**。
所以 TUI 里「接着打一句」本来就发得出去，正是用户看到的那样。

**做法**：新增 `const DEFAULT_DELIVERY = 'steer'`（一处说了算），`store.delivery` 与 `setDelivery()`
都走它：非法值回**默认**而不是写死回排队。工具栏「排队 / 插话」两个按钮照旧，只是默认高亮插话。

**回归**：`ui-controls` 87 → **90**（默认是插话 + 默认高亮插话 + 切排队两边都对 + 非法值回默认）、
`ui-commands` 里那条「忙时带上 `delivery`」的期望从 `queue` 改成 `steer`、`smoke.sh` +2（常量在、
`store.delivery` 不许写死字面量）。中断后把队列里的 `user` 项改成 `steer` 放行那段**照旧保留**
（那管的是「用户真的显式排了队，然后被中断」的情形）。

### 8.19 追加：上下文用量挪到输入框下面的提示栏，并补上工程路径 + `ctrl+p commands`

**起因**：用户——「155.6K (78%) 放的位置跟 TUI 一样在对话框下面，对话框下面还会显示工程路径、
ctrl+p commands」。

**查到的 TUI 布局**（从 `opencode` 二进制里抠出来的 `Zc` / `prompt.footer` 渲染）：输入框下面那一行
分三块 —— 左边 `prompt.footer.status` 里的 `prompt.footer.location`（工程路径，`truncate`），
中间是 `usage`（`d4(tokens, percent)`，即 `155.6K (78%)`，另加大于 0 时的花费），右边是
`${shortcut} commands`（`command.palette.show` 的键位 = `ctrl+p`，即 `ctrl+p commands`）。三者挤不下时
`tl({width, usage, shortcuts})` 会按宽度**逐档砍**（先保 usage，再保 shortcuts）。

**做法**：

| 点 | 决定 |
|---|---|
| 位置 | 新 `#promptFooter`，挂在 `#chatpane` 末尾、**`#composer` 外面**（不是里面）|
| 为什么在外面 | 手机默认把底板收起成一条细边（`ocs.composerHiddenNarrow`），放里面会被一起收掉。**（§8.40 改：用户后来要「收起后只留进度条」，于是收起时用 `#composer.collapsed ~ #promptFooter` 把它一起收；「在外面」这个结构没动，只是不再当「常驻行」用。§8.42 再改：手机上干脆整条不显示了，「在外面」就只剩桌面用得上）** |
| 内容 | 左 `#chatDir`（工程路径，太长由 CSS `text-overflow: ellipsis` 截断，`title` 给全路径）；中 `#ctxInfo`（原样搬过来）；右 `#cmdHint` |
| 两档提示 | 桌面 `ctrl+p commands`（TUI 原文），手机 `/ 命令`（手机没 Ctrl 键，面板本来就是敲 `/` 开面板）—— 两档都印 DOM，CSS 按 `html.narrow` 切，跟用量一个套路 |
| 点击 | `#cmdHint` 是 `button`，点了走 `openCommands({ force: true })`（与 `Ctrl+P` 同一条路）|
| 头部 meta | 工程路径从 `#chatMeta` 拿掉（挪到提示栏），meta 只留更新时间与项目号，不再重复 |
| 同步点 | 复用 `paintContextUsage()`：它先调 `paintPromptFooter(!!sid, dir)` 画路径与整条显隐，再画用量 —— 仍是那三个调用点，不新开同步点 |

**验证**（真面板 + 真服务，探针 `/tmp/ocsm-probe/perf/footer-shot.js`，注入探针读几何与文案再截图）：

- 393×894（`html.narrow`，底板**收起**）：`#composer` 底 = 864，`#promptFooter` 顶 = 864 / 底 = 894
  —— 正好贴在输入区下面、屏幕最下沿；`chatDir = /work/example-repo`、
  `ctxCompact = 76% ctx`（`ctxHidden=false`，收起状态也露着）、`.hNarrow` `display:inline`、
  `.hFull` `display:none`（手机档生效）。截图 `footer-shot-393x894.png`。
  **（§8.40 改：收起时这一行整条藏起来了 —— `#composer` 底 = 894、消息区 +30px；
  这些数只在「展开」态成立。§8.42 再改：手机上「展开」态也不露了,窄屏整条 `display:none` ——
  下面 1133 行那条「仍是输入框下面那一行」现在只在桌面成立）**
- 393×894（底板**展开**）：`#composer` 679–864、`#promptFooter` 864–894，仍是输入框下面那一行。
- 1366×900（桌面，底板默认展开）：`#promptFooter` 869–900 在 `#composer` 869 之下；
  `ctxFull = 151.8K (76%)`、`.hFull` `display:inline`（`ctrl+p commands`）。截图 `footer-shot-1366x900.png`。

**回归**：`smoke.sh` 209 → **212**（Q 组：位置断言从「在 `.chline` 里」换成「`#promptFooter` 在
`#composer` 之后、`#ctxInfo` 在 `#promptFooter` 里」，另加 `#chatDir`/`#cmdHint` 两档文案、
`#cmdHint` 的 CSS 切档、`paintPromptFooter` 接线 + `#cmdHint` 点击开面板）；`ui-stream`
205 → **210**（提示栏跟着会话显隐、路径文案与 `title`、目录不再重复进 `#chatMeta`、提示两档、
取消选中整条收起）；其余套件与 `e2e-*` 全 0 失败。

### 8.20 追加：提示栏再对一轮 TUI（顺序 / 费用 / `:分支` / `~/` / `⇧tab agents`）

**起因**：用户——「再仔细检查与 TUI 有哪些差别，继续修改」。于是把 `opencode.prompt.footer` 那个插件（二进制里的
`Zc`）整段抠出来逐行对，补齐 §8.19 漏掉的几处。

**查到的 TUI 事实**（`Zc` + 它用到的 `Co()` / `cm()` / `tl()`）：

| TUI 行为 | 证据 |
|---|---|
| 一行顺序是 `[agent·model] [location] [usage · cost] [tab agents] [ctrl+p commands]` | `Zc` 里先渲染 `c().join(' · ')`（usage），**再**两个 `We`：`agent.cycle`+`agents`、`command.palette.show`+`commands` |
| 用量后面接花费（>0 才印） | `c = [usage?d4(tokens,percent):void 0, cost>0?currency.format(cost):void 0].filter(Boolean)` |
| 路径是 `location:branch` | `Co()`：`cm(Qe.directory, S.home)` 之后 `vcs.info(Qe)?.branch.current ? \`${lt}:${rt}\` : lt` |
| 路径在 home 下缩成 `~/…`，正好是 home 缩成 `~` | `cm(e,r)`：`relative(r,e)` 为空 → `~`，在下面 → `~/…`，否则原样（本例 `/work/...` 不在 home 下，所以照旧绝对路径）|
| 多一个 `tab agents` 提示 | `Zc` 里 `m("agent.cycle")` + `agents`，与 `ctrl+p commands` 同级 |

**做法**：

| 点 | 决定 |
|---|---|
| 顺序 | DOM 改成 `#chatDir` → `#ctxInfo` → `#agentHint` → `#cmdHint`，与 TUI 一致（原来把 `ctrl+p commands` 放在用量前面，是错的）|
| 费用 | `paintContextUsage()` 里 `fmtCost(s && s.cost)`，`>0` 时接在用量后面（` · $x.xx`）；没有 tokens 只有费用时也照样露一格 |
| 分支 | 新 `cachedBranch(dir)`：问 `/api/vcs?location[directory]=`（已走面板代理），按目录缓存（空串 = 问过、不是 git 仓库），拿到后 `paintContextUsage()` 补画一次 |
| `~/` | `/__health` 加一个 `home: os.homedir()`（浏览器看不到本机 home），新 `abbrevHome(dir)` 照 `cm()` 缩；`store.home` 到位后补画一次 |
| `⇧tab agents` | 新 `#agentHint`（`button`，点了 `cycleAgent()`）。TUI 绑的是 `tab`，面板 `Tab` 被补全占了、当时绑的是 **Shift+Tab**，所以先写 `⇧tab agents`（§8.21 已按 TUI 改回 `tab agents` 并把无 Shift 的 `Tab` 也接上，见下节）；手机没键盘、工具栏上就有下拉，CSS 在 `html.narrow` 下整格收起 |
| 深链补拉 | `selectSession()` 末尾对「不在当前列表页里」的会话补问一次 `/api/session/<id>`（新增 `refreshSessionInfo()`，**不 await**，免得改掉选会话时序），补上工具栏与提示栏要用的 `location`；只认带 `id` 的对象（服务端对不存在的会话返回 `[]`，照单全收会把真会话冲成空壳——`ui-mobile` 那套桩当场把这个坑照出来过）|

**验证**（同 §8.19 的探针，真面板 + 真服务）：

- 1366×900：`chatDir = /work/example-repo:main`、`ctxFull = 151.8K (76%)`、
  `agentHint = ⇧tab agents`（`display:block`，§8.21 起改成 `tab agents`）、`ctrl+p commands` —— 顺序与 TUI 一致。
- 393×894（`html.narrow`）：`agentHint` `display:none`；`chatDir` 同上级带分支；用量走 compact 档、命令提示走 `/ 命令`。
- `~`（home 下）的会话：`chatDir = ~`（`abbrevHome` 生效；该会话不在列表首页，顺带验证了深链补拉）。

**回归**：`smoke.sh` 212 → **218**（顺序四格、费用、`:分支`、`~/`（含 `/__health` 的 `home`）、
`⇧tab agents`、深链补拉与空数组守卫、`paintContextUsage` 调用点 3 → 6）；`ui-stream` 210 → **219**
（费用两例、分支、`~/` 四例、`⇧tab agents`）；其余套件与 `e2e-*` 全 0 失败。

---

### 8.21 追加：提示栏最后三格（智能体·模型 / `tab agents` / 子会话·shell）与 `showDetails`

**起因**：§8.20 末尾列了四个「刻意没动」的可调点，用户回一句——「按照TUI来」。于是把 TUI 的
`Ss`（提示栏最左那格）与 `Zc` 里数子会话/shell 的那两个 `D(()=>…)`、还有 `showDetails` 一起补齐。

**查到的 TUI 事实**（`Ss` / `tc` / `Zc` / keymap）：

| TUI 行为 | 证据 |
|---|---|
| 最左那格是 `Ss`，印 `agent · model`（还可能带 `auto` / `provider` / `· variant`）| `Ss` 调 `tc({width,agent,auto,model,provider,variant})`；`tc` 依次找「字段最少但塞得下」的候选，都塞不下就截模型名（`NP(model, …)`） |
| 用量那格**前面**还接「正在跑的子会话 / 挂着的 shell」| `Zc`：`a()` = `session.family(sessionID)` 里 `!== sessionID && status === "running"` 的个数 → `N subagent(s)`；`s()` = `shell.list(location)` 里 `metadata.sessionID === sessionID` 的个数 → `M shell(s)`；两者 ` · ` 连，再用 ` · ` 接 `c().join(' · ')`（usage · cost）|
| 上膛等第二下 Esc 时窄终端把用量/快捷键收掉 | `showDetails = Pe.interrupt === 0 \|\| width >= 80`；`Ss`（agent·model）与 `location` **不**受它管 |
| `agent.cycle` 的键就是 `tab` | keymap 默认 `"agent.cycle": c("tab", …)` |

**做法**：

| 点 | 决定 |
|---|---|
| 智能体·模型 | 新 `#chatAgent`，排在 `#chatDir` 前面（`#promptFooter` 最左），照 TUI 的顺序。取值直接用工具栏两个 `<select>` 的当前项文案（`#agentSel` / `#modelSel`，变体接 `#variantSel`，`default` 不印）。工具栏在 `#composer` 里面 —— 手机收起底板时它跟着没了，展开态下这一格是还看得见「现在是哪个智能体/模型」的地方，所以只要选中会话就常驻（窄屏 `max-width: 32%`，别把工程路径挤没）。**（§8.40 改：收起底板时连这一格一起收，细边上只留进度条；「收起时也能看一眼智能体/模型」这条不再成立。§8.42 再改：手机上这一格连同整条都不显示了 —— 智能体·模型在**展开态的工具栏**里就有（`#agentSel` / `#modelSel`），所以「看一眼现在是哪个」这条在手机上改由工具栏交代）** |
| `tab agents` | 提示文案照 TUI 改成 `tab agents`；**无 Shift 的 `Tab`** 也接上 `cycleAgent()`（在输入框的键位链里排在命令面板/@ 补全/输入历史**之后**，所以那几处开着时先归它们）。Shift+Tab 照旧保留，不破坏既有键位与测试 |
| 子会话 / shell | 新 `store.subs`（子→父；来自列表接口里带 `parentID` 的那批 + SSE 的 `session.created/updated/deleted`）与 `store.shells`（`shell.created` 记、`shell.exited`/`shell.deleted` 划）。`subagentCount()` 只数 `isRunning()` 的（照 TUI 只数 running），`shellCount()` 数这个会话名下的；两者 ` · ` 连起来接在用量**前面**。单独放一份、不塞进 `store.sessions`，免得顶栏的工程筛选漏进别的工程的子会话 |
| `(new worktree)` | **不做**：那行不是会话提示栏的常驻元素，是「新建 worktree」时的临时状态（`Re.pendingNew()` / `Re.progress()` 那两段）。面板的流程已在 §8.56 接通，但进度放在「+ 新建」按钮上（`创建 worktree…` → `创建中…`），提示栏不是它的家 |
| `showDetails` | `paintInterruptHint()` 顺手给 `#promptFooter` 挂/摘 `.armed`；CSS **只在 `html.narrow` 下**把 `#ctxInfo` / `#agentHint` / `#cmdHint` 收起（桌面照旧）。手机上没 Esc 键、`#agentHint` 本来就在 `html.narrow` 下收着，所以这条主要在「窄桌面窗口」生效 |

**验证**（探针 `footer-shot.js` 扩了 `chatAgent` 与 `arm` 两项，用法 `node footer-shot.js <sid> <宽> <高> <collapsed> <arm>`；`arm=1` 会在页面里把选中会话标成 busy 再合成一次 Esc —— 第一下只上膛、不发请求，安全）：

- 1366×900：`chatAgent = Build · DeepSeek V4 Flash`（`display:block`）；上膛后用量/agent/cmd 三格仍 `block`（对应 TUI 的 `width>=80`）。
- 393×894（`html.narrow`，底板收起）：`chatAgent` 仍 `block` —— **收起状态下也看得见智能体·模型**；上膛后 `ctxShownArmed = none`、`cmdShownArmed = none`，而 `chatDirArmed = block`（TUI 只收 usage + 快捷键，不收 location / agent·model）。
- 收官时那行读作 `Build · DeepSee…  /work/example-repo/n…  76% ctx  / 命令`（两处都按 TUI 截断）。

**回归**：`smoke.sh` 218 → **220**（`#chatAgent` 与 `.armed` 各一条，费用那条并进子会话/费用一起查）；`ui-stream` 219 → **236**（agent·模型 4 例、子会话/shell/事件 13 例）；`ui-commands` 166 → **171**（输入框里无 Shift 的 `Tab` 3 例 + `.armed` 挂/摘 2 例）；其余套件与 `e2e-*` 全 0 失败。

---

### 8.22 追加：消息体工具卡照 TUI 对齐（图标 / 工具词 / 块标题 / diff 徽标 / 路径缩略）

**起因**：§8.21 之后用户说「继续对齐」—— 对的是**消息体里的工具卡**：工具行、块标题、diff 徽标、
诊断行、路径。

**查到的 TUI 事实**（v2.0.28 的 `packages/tui/src/routes/session/index.tsx`、
`message-parts.tsx`、`util/tool-display.ts`，都在 `/tmp/ocsm-probe/tui-*.tsx` / `tool-display.ts`）：

| TUI 行为 | 证据 |
|---|---|
| 工具行 = `paddingLeft 3` + `[图标宽 2] [文案 muted]` | `INLINE_TOOL_ICON_WIDTH = 2`；`InlineToolRow` 的 spinner/complete 两个分支 |
| 图标 read/list `→`、write `←`、glob/grep `✱`、webfetch `%`、websearch `◈`、subagent `✓`/`│`/`↳`、其余 `✓`/`✗` | 同上 + `BlockTool` / `Subagent` |
| 标题 `Read <path>[:起-止]`、`Glob "<pat>"[ in <path>] (N matches)`、`Grep …`、`WebFetch <url>`、`Web Search via <provider> "<query>"`、`Write <path>`、`← Edit <path>`、`<Agent> Subagent — <desc> · <model>`、`Asked N question(s)`、`Skill "<name>"`、通用 `<tool> [k=v, …]` | 各工具组件 |
| 块标题：write `# Wrote <path>`、question 已答 `# Questions`、ApplyPatch 每文件 `# Created` / `# Deleted` / `← Patched` | `BlockTool` / `ApplyPatch` / `Question` |
| shell 块 `$ [cd <wd> && ]<cmd>` + 输出（muted、折叠 10 行）；pending 文案（`Reading file…` / `Writing command…`）只在关键入参还没到时出现 | `Shell` 组件 |
| 工具名先归一 `canonicalToolName`：`bash`→`shell`、`task`→`subagent`、`apply_patch`→`patch` | `util/tool-display.ts` |
| 路径缩略 `x4(path, {base: 会话目录, home})`：会话目录下取相对（base 自身 → `.`）、否则 `cm(abs, home)` → `~/…` | 调用点 + 二进制里的 `x4`/`cm` |

**做法**：

| 点 | 决定 |
|---|---|
| 图标 | 新 `TOOL_ICONS` + `toolIcon(p)`：按归一后的工具名给行首 `.tmark`；**运行中仍是 spinner**（这是面板自己的做法，TUI 只给 read/shell/edit/patch/subagent 转）|
| 工具名 | 新 `TOOL_ALIAS`（照 `canonicalToolName`）→ `toolKind()` 统一口径 |
| 拆名 / 描述 | `toolLine(p)` 产出 `{ head, tail }`：工具词进 `.tname`、余下上下文进 `.tdesc`；**shell 例外**（整条命令进 `.tname`，照 TUI 的 `$ <cmd>`）|
| 状态字 | `.tstate` 只在**出错**时印「出错」；完成 / 运行中都不再另画标记（行首图标已经说了）|
| 块标题 | write `# Wrote <路径>`、question `# Questions`、未答 `Asked N question(s)`、skill 无名时只印 `Skill`（不留空 `""`）；块工具**默认折叠**（面板自己的做法）|
| diff | 徽标 added `# Created` / deleted `# Deleted` / 其余 `← Patched`；`.dnote` 改 `-N lines`；诊断行 `Error [行:列] msg` |
| shell 正文 | 只留输出，不再铺入参 JSON |
| 路径缩略 | 新 `normPath()` / `abbrevPath()`（会话目录下相对、home 下 `~/…`、取不到会话目录原样）；用在 `toolLine` 的展示路径、`Wrote` 的 tail、`diffHtml` 的 `.dpath`；`diagHtml(md, path)` 仍用**未缩**的绝对路径查诊断 |
| CSS | `.tname` 加 `flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`（shell 的长命令要能省略，否则撑破行）|
| 语言 | 工具层文案照 TUI 用英文（TUI 的组件名本来就是英文，`.tname` 本来就印 `read`/`edit`/`bash`）；面板其余 chrome 仍中文 |

**验证**：探针 `tools-shot.js`（`node tools-shot.js <sid> <宽> <高>`；代理真面板 + 注入探针 dump
`#messages` 里每行 `.tmark/.tname/.tdesc/.tstate` 与 `.dfile/.dline`，并截图）。在
`ses_demo_long_a`（393×894，46 行）读到：`→ Skill "brainstorming"`、
`→ Read /work/.../default.xml`、`$ ls -la ...`、`# Questions`、`← Edit /work/.../local.xml`、
`.dfile` = `← Patched` + 路径 + `+10-10`；第一行 skill 的空 `""` 已修掉。

**回归**：`smoke.sh` 220 → **226**（N3 组六项：图标表 / `TOOL_ALIAS` / `toolLine` 的工具词 / 块标题 /
diff 徽标 / 诊断行）；`ui-tools` 110 → **134**（`toolIcon` 6 例、`toolLine` 7 例、`normPath`+`abbrevPath` 9 例、
块标题与 `-N lines` / 诊断行）；`ui-stream` 三处期望跟着改（shell 命令进 `.tname`、`tstate` 不再出现、
行首回到 `$`）；其余套件与 `e2e-*` 全 0 失败。

---

### 8.23 追加：「贴不贴底」是用户意图，不是一次几何读数（修「忽然不跟随」）

**起因**：用户报「对话框的内容有时不是实时跳转最新的输出，要动不动就要点击跳到最新」。

**实测复现**（探针 `follow-repro.js`：`node follow-repro.js <sid> <宽> <高>`，用 `ACT_AT`/`ACT` 注入动作；
真面板 + 真会话 + 真流式回合，全程**一次都不手动滚动**，只记 `store.nearBottom` 每次翻转的调用栈与几何
`{scrollTop, scrollHeight, clientHeight}`）：

- 贴在底（离底 `d = 0`）时把 `#messages` 矮掉 160px（等价于状态条出现 / 底板展开 / `#asks` 弹出 /
  软键盘顶起）→ `d` 立刻变 161 → `nearBottom true → false`（栈：`updateJumpLatest ← renderMessages ←
  loadMessages`）→ 之后一路不跟随，只能自己点「跳到最新」。
- 根因：`renderMessages()` 拿**变更前**那一次 `atBottom(box)` 当结论，而「重贴底」写在这句的
  `if (nearBottom)` 里 —— 变矮那一刻量到「离底远」，跟随就被关掉，而且不会自己恢复。

**改法**（照 TUI 的 `stickyScroll` 思路：只有「用户自己离开底部」才停止跟随）：

| 点 | 决定 |
|---|---|
| 判据 | `store.lastTop` 记上次看到的 `scrollTop`。离底 `< BOTTOM_SLACK` → 跟随；`scrollTop` 比它**变小了** → 用户往上滚了，让路；其余（内容变长 / 容器变矮）→ 维持原样，跟随中就把底部重新贴住 |
| 贴底动作 | 收敛成唯一的 `pinBottom(box)`（滚到底 + 记下 `lastTop`）；`renderMessages` / `paintLiveDelta` / `paintCompactBody` / `jumpToLatest` 全走它，不再各写一行 `scrollTop = scrollHeight` |
| 容器变矮 | 新 `ResizeObserver` 盯着 `#messages`：一变矮就在**跟随时**当场重贴底（不等下一次渲染 —— 一条消息都不再来的话就永远差一截）；用户往上翻着时一动不动 |
| 深链 | `restoreFromHash()` 只在**真有存档**时才塞 `store.restoreScroll`：塞一个 `anchor` 为 `null` 的 pending 会拦住 `selectSession()` 里的 `forceBottom`，于是「没有存档」变成停在最上面 —— 与那句注释「没有就按老样子跳到底部」正好相反 |
| `atBottom()` | 保持**纯几何**（离线可断言，`ui-jump` 直接喂 `{scrollHeight, scrollTop, clientHeight}`）；「这次离底变远算不算用户往上滚」的解释职责挪进 `updateJumpLatest()` |
| 不变 | `store.nearBottom` 仍是增量重绘唯一读的缓存，唯一写点仍是 `updateJumpLatest()`；`BOTTOM_SLACK = 80` 不变（按钮显隐与跟随仍共用一个口径）|

**验证**（同一次流式回合里做三件事，全在 393×894 的真面板上）：

- 矮 160px：`nearBottom` 保持 `true`，`ResizeObserver` 当场把 `d` 贴回 0（改前：翻 `false` 并一路不跟）。
- 往上滚 400px：`nearBottom true → false`（栈落在滚动事件那条线上），内容继续变长但**不把人拽回底部**。
- 滚回底部：`nearBottom false → true`，按钮收起、跟随恢复。
- 长会话深链（`NO_JUMP=1 NO_PROMPT=1`，全新 profile，sessionStorage 里没有存档）：
  `ses_demo_long_b`（101 条、25007px）打开即 `d = 0`、按钮收起（改前会停在最上面）。

**回归**：`ui-jump` 47 → **56**（容器变矮不关跟随 / `scrollTop` 往回走才关 / 当场贴底 / 让路期间不拽人，
另加 `pinBottom` 记 `lastTop`）；`ui-layout` 162 → **164**（没有存档的长会话深链到底且处于跟随中）；
`smoke.sh` 226 → **230**；其余套件与 `e2e-*` 全 0 失败。

---

### 8.24 追加：探索类工具行折成一组 + 思考块摘要带标题与时长（继续对 TUI 的消息体）

**起因**：§8.22 对齐了**单个**工具行，用户接着说「继续对齐」。这一轮对的是工具行的**分组**与思考块的**摘要行**。

**先把 TUI 的事实抓准**（v2 `packages/tui/src/routes/session/grouping/session.ts`、`grouping/tree.ts`、
`group-view.tsx`、`context/thinking.ts`、`util/locale.ts`，原文在 `/tmp/ocsm-probe/tui-grouping-*.ts` 等）：

| TUI 行为 | 证据 |
|---|---|
| 探索类工具 = `read` / `glob` / `grep` / `webfetch` / `websearch`（`list` 不算） | `explorationTools`；`partPath()` 给它们挂 `["exploration"]` |
| 相邻的**同 kind** 才并进一个组 | `tree.ts` 只并相邻同 kind 的 part |
| 组行：`GroupContent` 折成一行，词 `Explored`/`Exploring`、后面跟计数 | `group-view.tsx` 的 `groupExploration()` 分支 |
| 计数：`grep`/`glob`/`websearch` 都算 `search`、`webfetch` 算 `fetch`，其余用工具名；复数 `+es`/`+s` | `GroupContent.label()` |
| `size === 1` 的组也折（`grouped()` 分支没有条数下限） | 同上 |
| 思考块摘要：正文最前面那段**加粗 + 空行**拎出来当标题，收工后接时长 | `reasoningSummary` + `ReasoningHeader`（主程序里）|
| 时长格式 `1s` / `1.2s` / `1m 5s` / `1h 5m` / `1d 5h` | `Locale.duration`（`util/locale.ts`）|

**实测真实数据的形态**（`GET /api/experimental/session/:id/export` 的两条真会话全量：只读长会话
`ses_demo_long_b` 2480 条助手消息 + 探针会话 `ses_demo_long_a` 51 条，
合计 2531 条）：

| 事实 | 数据 |
|---|---|
| 每条助手消息的工具数 | `{0: 103, 1: 2239, 2: 179, 3: 7, 4: 3}` —— 一条里基本就一个工具（88%）|
| 探索组落在哪 | 单条消息内 **286 组**（`size=1` 就有 247 个、2 条 36 个、3 条 2 个、4 条 1 个）；跨消息相邻的只有 **8 处** —— 把整条会话的 part 摊平按 TUI 口径数，TUI 是 278 组、面板是 286 组，差 2.9% |
| 「思考组」 | **0 组**（2531 条里有 2341 条带 reasoning，形态都是 `[reasoning, 一个工具]` 交替，相邻 reasoning 根本不成立）|

**做法**：

| 点 | 决定 |
|---|---|
| 分组范围 | 单条助手消息内并相邻的探索工具；跨消息那 8 处由 §8.68 的「纯探索续步吸收」补上（仍不改按消息渲染的骨架，带正文 / 终步 / 流式续步仍分局）|
| 工具集合 | `EXPLORE_TOOLS` 照 TUI 五类；`EXPLORE_MIN_RUN = 1`（照 TUI 的 `size=1` 也折）当**唯一开关** —— 想只折两条以上的那种，把这一个常量改成 2 |
| 计数与复数 | `exploreLabel()` 照 `label()`；几条之间 `, ` 连 |
| 折叠 | 默认**折着**（照 TUI），原来那些工具行一个不少地挪进 `.gbody`（一处 DOM 都不删，只挪位置）|
| 行首 / 词 | 跑着时行首是 spinner、词 `Exploring`；全部收工换成 `→` 与 `Explored`。**冒号连在词上**（`.tname` 里），不然 `.toolrow > summary` 那条 `gap: 6px` 会在冒号前面留一道缝（实拍先踩到：`Explored : 1 read`）|
| 思考头 | `REASONING_TITLE_RE` / `reasoningTitle()` / `fmtDur()` / `reasoningHead()`；收工后 `思考: <标题> · 12.3s`，标题拿不到就只有 `思考`，时间时刻拿不到就不印时长 |
| 不做 reasoning 分组 | 实测 0 组（见上表），照 TUI 的话它在真数据里永远不会成立，不做 |
| `details` 的开合 | 渲染出的每个 `details` 都带 `data-def`（它**天生**是开还是合）：重绘时新旧一对，旧的开合跟它的默认对不上就说明**用户动过手**，照搬到新元素上（两头都搬）。没带 `data-def` 的思考块维持老规矩：只搬「用户折起来过」那一种 |

**验证**：新探针 `narrow-audit.js`（`node narrow-audit.js <sid> [宽] [高]`，代理真面板 + 注入探针，
dump 头部那一行 / 提示栏两格宽度 / `.explore` 的文案与开合 / 越界的元素，并截图；`BEFORE=1` 还能把窄屏
提示栏的旧规则临时装回去量一组对照、`SCROLL_TO=explore` 滚到第一组上）。在
`ses_demo_long_a` 的 393×894 与 1366×900 两个视口上读到：两条探索组都是
`→ Explored: 1 read`、`open: false`、`.gbody` 里 1 行；思考头 `思考 · 4.7s` / `思考 · 946ms` / `思考 · 400ms`；
没有元素比视口宽（`pre` 里那些 492px 的 `code` 有 `overflow-x: auto` 兜着，`#messages` 本身不横滚）。

**回归**：`smoke.sh` 230 → **239**（新 R 组 6 项：五类工具表 / 计数与复数 / `Explored`·`Exploring` /
探索组默认折叠 + `data-def` / `renderMessage` 里并组 / `.explore` 样式；R2 组 3 项：标题正则 /
摘要文案 / 时长格式）；`ui-tools` 134 → **168**（新 34 项：分组触发的三种形态与不触发的四条边界、
计数与复数、`data-def`、思考头三种情形、`syncDetailsOpen` 两头搬与「没带 `data-def` 就只搬折起来的」）；
`ui-stream` 236（不变）；其余套件与 `e2e-*` 全 0 失败。

---

### 8.25 追加：窄屏把提示栏的模型那格收起来，「加载更旧消息」并进会话操作那一行

**起因**：两个都是手机竖屏上看出来的：① 用户报「加载更旧消息，这个项应该跟导出这些处于同一水平线」；
② 提示栏第一格 `智能体 · 模型 · 变体` 挤掉工程路径。

**实测**（`narrow-audit.js`，393×894，`ses_demo_long_a`）：

- 改前：`#chatAgent` 宽 **119px**（把 `max-width: 32%` 用满）、`#chatDir` 只剩 **145px**，
  路径可见部分到 `/work/example-repo/…` 就截了（`scrollWidth 311`）。
- 改后：`#chatAgent` **31px**（只有 `Build`）、`#chatDir` **234px**（+61%），可见部分到
  `/work/example-repo/exam-…`。
- `#older` 改前与 `#chatOps` 不同 top（自己占一整行），改后两者 `top` 都是 191、高都是 40px。

**做法**：

| 点 | 决定 |
|---|---|
| 提示栏第一格 | `paintFooterAgent()` 拆成 `.agName`（智能体）/ `.agModel`（` · 模型 · 变体`）两格；**整条 `textContent` 仍是「智能体 · 模型 · 变体」**，变更判据照旧 —— 顺带把「要不要重画」的判据也一起留着 |
| 窄屏 | `html.narrow #chatAgent .agModel { display: none }`，宽度上限 32% → 40%（模型收走后瓶颈不在它身上）。两格都还在 DOM 里，横屏转回来就露出来；模型名照旧留在整条的 `title` 里 **（§8.42 改：手机上整条都不显示了，所以这几条窄屏规则从此够不着，留着当记录）** |
| 「加载更旧消息」 | `#older` 是块级盒，跟着 `#chatOps`（`display: flex`）就只能落到下一行。`#chatOps` 改 `inline-flex`、`#older` 是 `inline-block` —— 两个行内盒自然共一行；一行放不下时 `#older` 自己换行（还是原来那样）|
| 尺寸 | `#older` 的 padding / 字号对齐 `.chip`；窄屏 `html.narrow #older { min-height: 40px }` 跟旁边几个 chip 一样高 **（§8.41 改：手机上整条不显示了，那条 `min-height` 随之删掉；桌面这一行的版式没动）** |
| 顺手修的 | `clearSelection()` 原来只清 `store.messages`，没管 `#older` 与 `store.msgOlderCursor`：清掉选中后那一格会一直露在头部（**探针实测**：`#chatOps.hidden true` 而 `#older.hidden false`），点了也没用（`loadMessages` 没选中直接返回）；游标还会把上一个会话的页码带进下一个会话的第一页回来之前的空档。现在两样一起清 |

**验证**：393×894 四个 chip（导出 / 在 TUI 打开 / 归档 / 加载更旧消息）一行放得下（`#chatOps` 右沿 205、
`#older` 左沿 208 —— 中间那道 3px 是行内盒之间的空白）；1366×900 桌面同样是这一行。截图
`/tmp/ocsm-probe/perf/narrow-explore-393.png` 与 `-1366.png`。清掉选中那一条用 `CLEAR=1`（探针点 `#backList`
之后再量一轮）：改前 `#older.hidden false`、改后 `true`。**（§8.41 改：393×894 上这四个 chip 整行都收掉了
—— 下面这段「一行放得下」的版式现在只在桌面成立）**

**回归**：`smoke.sh` 239 → **243**（新 R3 组 4 项：拆两格 / 窄屏回收 + 宽度上限 / `#chatOps` 与 `#older`
同排 / 窄屏 40px）；`ui-stream` 236 → **240**（窄屏收起来 / 宽屏露出来 / `.agName` 照旧 / `title` 里模型名没丢）；
`ui-jump` 56 → **58**（清掉选中后 `#older` 收起 + 游标清掉）；
`ui-mobile` 160、`ui-layout` 164 等全部不动；其余套件与 `e2e-*` 全 0 失败。

---

### 8.26 追加：修「加载更旧消息」—— 带游标时不能再带 `order`

**起因**：量助手脚注（§8.27）时顺手用真会话点了一下「加载更旧消息」，发现它**从来没成功过**。

**实测**（只读长会话 `ses_demo_long_b`，2480 条）：

| 请求 | 服务端 |
|---|---|
| `GET /message?order=desc&limit=100` | 200，最新 100 条，`cursor.next` / `cursor.previous` 各给一个 |
| `GET /message?order=desc&limit=100&cursor=<next>` | **400** `{"_tag":"InvalidCursorError","message":"Cursor cannot be combined with order"}` |
| `GET /message?limit=100&cursor=<next>` | 200，往旧的那 100 条（方向本来就编在游标里：`base64({id, order:"desc", direction:"next"})`）|

面板原来两样一起发，于是每次点都被打回：`api()` 见非 2xx 直接 `throw`，`loadMessages` 的 `catch` 又是静默的
—— 界面上就是「点了没反应」，游标没被消费，按钮也一直不肯消失。

**做法**：`loadMessages()` 里把 query 拆开 —— 首屏 `order=desc&limit=100`，翻页**只**带 `cursor`。

**验证**：新探针 `/tmp/ocsm-probe/perf/older-audit.js`（代理真面板 + 注入探针，点一下 `#older` 再看条数）：
改前 `before 100 → after 100`（没动静）、改后 `before 100 → after 200`，抓到的请求
`/api/session/<sid>/message?limit=100&cursor=eyJpZCI6…`（没有 `order`）。

**回归**：`smoke.sh` 里新 R5 组 2 项（翻页只带游标 / 不再出现两样一起发的那种写法）；
`ui-jump` 58 → **63**（首屏带 `order=desc`、翻页带 `cursor` 且不带 `order`、没游标时不发请求）。

---

### 8.27 追加：助手消息脚注（TUI 的 `AssistantFooter`），模型名从头部挪到脚注

**起因**：用户「一切往 TUI 的方向靠拢」，并按默认档回了四条 —— 本轮做第一条：**保留头部**，把模型名从头部
挪到脚注。

**先把 TUI 的事实抓准**（`packages/tui/src/routes/session/index.tsx:1881` 的 `AssistantFooter`、
`rows.ts:430/442` 的 `turnDuration` / `turnTokensPerSecond`，另从本机二进制核了默认值）：

| TUI 行为 | 证据 |
|---|---|
| 每条助手消息**收工后**在底部印一行：`Build · DeepSeek V4 Flash · 4.7s · 42.1 tok/s` | `AssistantFooter` 渲染体 |
| 尾巴可接 `· interrupted`（`error.message === "Step interrupted"`） | 同上；二进制里 `{type:"aborted",message:"Step interrupted"}` |
| 出错（且不是中断/重试）时上面另起一行 `Error: <原因>` | `… \|\| !interrupted() && !retry` 那个 `<Show>` |
| 重试时上面另起一行 `⚠ Retrying in Ns · attempt K · <原因>`，每秒重算 | `AssistantRetry`，`setInterval(…, 1000)` |
| 智能体名跑 `Locale.titlecase`，用 agent 色（出错时灰）；其余一律 muted | `Locale.titlecase` = `replace(/\b\w/g, c => c.toUpperCase())` |
| 时长 = 本步 `time.completed` − **本轮输入消息** `time.created` | `turnDuration` |
| 速度 = Σ(`output`+`reasoning`) / Σ(`streamed`−`created`)，只算本轮的步 | `turnTokensPerSecond`（先加总再除，按各步活跃时长加权）|
| 窄屏 < 28 列不印模型、28~36 列不印时长 | 同上的两个 `Show` |
| 默认档：`session.tps` **开**（印 tok/s）、`debug.turn_tokens` **关** | 二进制里的 `default:!0` / `??!1` |

**实测真实数据的形态**（只读长会话 + 探针会话，2531 条助手消息）：`time.streamed` **2495** 条（速度算得出来）、
带 `error` **26** 条（其中 `Step interrupted` 在本轮扫到的窗口里 0 条，配额类错误在）、带 `retry` **1** 条；
`agent` 是 `build` 2505 / `Sisyphus - ultraworker` 26 —— 长会话尾部实拍：`Build · DeepSeek V4 Flash · 16m 35s · 154.6 tok/s`。

**做法**：

| 点 | 决定 |
|---|---|
| 位置 | 收工时印在消息**底部**（`.meta` 那行 tokens 之下），照 TUI 的顺序：正文 → 尾部数字 → 脚注 |
| 头部 | 保留 `⏺ 助手` 那行（用户定的「原有 DOM 一个不删」），但**模型名挪走** —— 头部只留标记 / 身份 / 「输出中」 |
| 模型名 | 先查模型表（`store.modelIndex`，键 `providerID/modelID`）拿 `name`，查不到退回 `providerID/id`；解析结果**进签名**，并在模型表拉回来后补一次 `renderMessages()`（TUI 那边是响应式，天然会重画；面板不补就会一直停在退回形态，实拍踩到过）|
| 时长 / 速度 | 照 TUI 两条函数实现（`turnDuration` / `turnTps`），并把**整张消息表 + 自己在表里的位置**交给 `renderMessage`；没有输入消息时退回本步 `created`，撞上 `idle` 就断轮 |
| 缺 `streamed` | 整个速度格不印（照 TUI：一块缺就整体作废，不给偏高/偏低的假数）|
| 流式中 | 不印脚注那行（TUI 那行是 `step.ended` 之后才追加的），出错/重试那两行照旧印 |
| 倒计时 | `.afRetry` 带 `data-at`，`syncRetryTick()` 跟着 `updateChatStatus()` 走（和 spinner / 状态条同一个规矩：已经在走就不重开，没目标就停），每秒改一次 `.afWhen` |
| 窄屏列宽规则 | **不实现** —— 面板支持的宽度下恒不触发（393px ≈ 49ch，判据是 36ch ≈ 290px），写 `@media` 还会破坏「窄屏判定源唯一」那条底线（smoke 有断言盯着），注释里写明了 |

**验证**：新探针 `/tmp/ocsm-probe/perf/footer-audit.js`（代理真面板 + 注入探针，dump 最后几条助手消息的头部与脚注
各格，并滚到底截图）。393×894 实拍：`Build · DeepSeek V4 Flash · 9.3s · 97.8 tok/s`，头部 `⏺助手` 且
`headModel: false`；长会话 1366×900：一条 `Error: Rate limit exceeded. Please try again later.` + 那行的智能体名
是灰的（`mutedN: 1`）；`.msg.assistant.live .afoot` 计数 **0**（流式中不印）。截图
`/tmp/ocsm-probe/perf/footer-audit-393x894.png`。

**回归**：`smoke.sh` 里新 R4 组 6 项；`ui-tools` 168 → **190**（22 项：智能体大写、整轮时长、退回本步 created、
缺 `streamed` 不印速度、各步加总、没有 `completed` 时只留前两格、`live` 不印、中断三种断言、出错两行、
重试三行、模型表兜底、模型名只在脚注、`idle` 断轮、连字符大写）；`ui-stream` 240 → **247**（头部不再印模型 +
收工后脚注四格 + 模型名只在脚注）。

---

### 8.28 追加：思考块的行头照 TUI 的 reasoning 分组行（`Thinking` / `Thought` + `N steps`）

**起因**：用户「一切往 TUI 的方向靠拢」，四条默认里的第③条 —— 思考行文案改英文并补 `N steps`。

**先把 TUI 的事实抓准**（`packages/tui/src/routes/session/group-view.tsx:75-195`）：

| TUI 行为 | 证据 |
|---|---|
| 相邻的思考段由 `tree.ts` 并进**同一个组**，组行只印一行 | `thoughts()` 取组内所有 reasoning part |
| 跑着时：`Thinking` / `Thinking: <标题>`（带 spinner） | `pending` / children 文案 |
| 收工时：`Thought` +（**没展开**且标题非空）`: <标题>` | `185` 行的三元 + `186` 行的 `<Show when={completed && !expanded() && latest()}>` |
| 组内**多于一段**才接 ` · N steps` | `187` 行 `thoughts().length > 1` |
| 时长 = 组内**各段各自** `created→completed` 之和 | `103-109` 行那个 `reduce`（不是首尾相减）|
| 时长那一格挂在 `props.completed` 上（跑着不给） | `188` 行 `<Show when={completed && duration()}>` |
| 标题 =「最后一段的加粗首行」，带黏性：最后一段没标题且已收工就清掉，还在跑就沿用前一段的 | `95-102` 行 `latest()` |

**实测真实数据的形态**：只读长会话 + 探针会话里，**相邻的思考段恒为 0 组**（每个 reasoning part 前后都夹着 text / tool），
所以 `N steps` 在真实数据里印不出来 —— 而**真会印**的是词汇：原来那块写的是 `▸ 思考 · 4.7s`（中文），
照 TUI 应是 `▸ Thought · 4.7s`。面板这边连标题都没有（这两台模型吐的思考正文不带加粗首行），实拍 45 个思考块全是
`Thought · 4.6s` 这类。

**做法**：

| 点 | 决定 |
|---|---|
| 词 | `思考` → `Thinking`（跑着）/ `Thought`（收工）；工具层文案本来就是英文（§8.24），这一层跟着统一 |
| `N steps` | 照 TUI 实现，并且为此把**相邻的思考段并成一个 `<details>`**（tree.ts 的规矩）—— 真实数据里是 0 组，但结构得对 |
| 标题 | 折着才印：面板用 CSS 反应（`.reasoning[open] > summary .rWord.rDone ~ .rTitle { display: none }`），跑着那款（`Thinking`）照 TUI 一直带着标题 |
| 时长 | 组内各段之和（TUI 的 reduce）；跑着不给（挂在 `completed` 上，面板用 `m.live` 代理） |
| 正文 | 仍然每段一个 `.content`，`data-lk` 的序号照旧「同类型里的第几个」递增 —— `paintLiveText` 就按这个定位，并组不动增量重绘 |
| 与 TUI 的差异 | TUI 跑着时只印那一行（正文要自己展开），面板保持「流式期间自动展开」（§8.5 的阅读取向），只改文案与格子 |

**验证**：`footer-audit.js` 探针加了思考块一栏。探针会话（393×894）45 个思考块、长会话（1366×900）实拍
行头都是 `Thought · 4.6s` / `Thought · 1.2s` 这类（`word: "Thought"`、折着、无标题、单块），与 TUI 同款。
合成一条两段相邻的思考（单测）→ 一个 `<details>`、行头 `Thought: b · 2 steps · 300ms`、正文两段。

**回归**：`smoke.sh` R2 组 3 → **5** 项（行头三格 + 并组那行 + 摊开藏标题的 CSS）；`ui-tools` 190 → **199**
（9 项：新行头四款 + 并组四条 + 黏性两条 + 跑着不给 steps）；其余套件与 `e2e-*` 全 0 失败。

---

### 8.29 追加：用户消息照 TUI（抬起底色块 + skill / file 徽标）

**起因**：用户「一切往 TUI 的方向靠拢」，四条默认里的第③条后半 —— 用户消息的底色块与 skill/file 徽标。

**先把 TUI 的事实抓准**（`packages/tui/src/routes/session/index.tsx:2214` 的 `UserMessage`）：

| TUI 行为 | 证据 |
|---|---|
| 整条包在一个盒子里：`border={["left"]}` + `backgroundColor: theme.background.raised.base` | `2241-2246` 行 |
| 左边那条边的颜色 = **会话当前智能体**的色（`local.agent.color(session.agent)`）；**待投递**的消息另用中性边色 | `2229` / `2243` 行 |
| 正文那格再抬一层：`paddingLeft={2}`、上下各 1 行、hover 时 `decrease(raised)` | `2248-2287` 行 |
| `skills[]`：另起一行，每颗是「` skill ` 加粗反白徽标 + ` 名字 ` 稍暗那格」 | `2289-2310` 行 |
| `files[]`：另起一行，徽标按 mime 分 ` file ` / ` dir `（`application/x-directory` 才是 dir），名字取 `name ?? source.uri ?? "attachment"` | `2311-2336` 行 |
| 正文、files、skills 全空的消息整条不渲染 | `2240` 行 |

**做法**：

| 点 | 决定 |
|---|---|
| 底色块 | `.msg.user` 加 `background: var(--panel)`（照 `background.raised.base`）+ 圆角与内边距；原来那条 3px 左边框留着 |
| 左边框颜色 | **不跟 agent 走** —— 服务端 `/api/agent` 不下发颜色（TUI 是在本地 context 里按 agent id 算的），面板保留自己那条蓝；这一条在设计文档里记着，将来若要跟 agent 走，得先给面板一张配色表 |
| skill 徽标 | `.ref-skill` 里改成 `<span class="rBadge">skill</span><span class="rName">名字</span>`；外层不再自带黄底框（颜色由里面两格给，照 TUI） |
| file 徽标 | `.att-name` 里改成 `<span class="rBadge">file|dir</span><span class="rName">名字</span>`；`📎` 那个 emoji 换成 TUI 的徽标（名字来源不变：`name ?? 路径末段 ?? 附件`） |
| 保留的面板自有物 | 正文/提及/附件仍是**三个条件追加的子块**（`turn-head` / `content` / `refs` / `atts`，顺序与层级一个没动，老断言照旧）、`att-meta`（mime · 大小）、`att-src`（来源路径）、`att-img`（图片缩略图）、以及 `@agent` 那颗蓝 chip（TUI 的用户消息里没有这个东西）|

**验证**：`footer-audit.js` 探针加了用户消息一栏。393×894 实拍：`.msg.user` 的 `backgroundColor: rgb(243,243,243)`、
`borderLeftColor: rgb(0,122,204)`、`borderRadius: 3px`，截图里那条 `❯ 你 / git push` 已经是抬起来的块
（`/tmp/ocsm-probe/perf/footer-audit-393x894.png`）。徽标那两格在这两条会话的最后几条用户消息里没有命中
（那几条既没 skill 也没附件），靠单测覆盖。

**回归**：`smoke.sh` 新 R6 组 3 项（skill 与 file/dir 徽标、底色块与徽标样式、skill 外层不带框）；
`ui-attach` 132 → **133**（3 条改成徽标断言 + 新增 dir 徽标那条）；`ui-tools` 199 不动（`#name` 那条改成徽标断言）。
`README.md` 里「📎 名字」那几处一并改写。

---

### 8.30 追加：Tokens 块照 TUI 的 TurnTokenUsage

**起因**：用户「一切往 TUI 的方向靠拢」，四条默认里的第②条 —— 做 Tokens 块、默认收起，`.meta` 里那份 tokens 并进去。

**先把 TUI 的事实抓准**（`packages/tui/src/routes/session/index.tsx:1605` 的 `TurnTokenUsage` +
`packages/tui/src/routes/session/rows.ts:343` 的 `reduceSessionRows`）：

| TUI 行为 | 证据 |
|---|---|
| 块挂在 **轮**（turn）上，不是单条消息：`turn-usage` 行的 `messageIDs` 是这一轮所有带用量的助手步 | `rows.ts:358-372` 的 `flushTurn` |
| 收轮时机：**撞上 `idle` 消息**（有 idle 标记的会话，所以 steer 的那几段提示词不关轮，用量一直攒到 idle）；老会话（整条没有 `idle`）遇到**终步**就收 | `rows.ts:379-381` / `403-407`，注释原文「steers keep the turn open」 |
| 终步 = `finish` 不在 `tool-calls`/`unknown` 里，或者带 `error` | `rows.ts:403` |
| 总览（默认收起）：`Tokens: N steps · latest: X new · Y cached · Z total`；尾巴 ` · ! K likely cache bust(s)` | `1668-1684` 行 |
| `new` = total − `cache.read`；`total` = input+output+reasoning+`cache.read`+`cache.write` | `1618-1635` 行 |
| 展开才是逐步表：表头 `Step / New / Cached / Total`（斜体、右对齐），`finish` 为 `tool-calls` 时写 `tool-call` | `1685-1720` 行 |
| 表里掉量另起一行：`! Likely cache bust: N fewer cached tokens than the previous step` | `1723-1727` 行 |
| `previousCache` 是**上一轮收尾那步**的 cache；遇到**已完成**的 compaction 就作废 | `371` / `384` 行 |
| 换模型（providerID/id/variant 任一不同）不算掉量；openai 掉 1024~2048 是分桶振动、不算 | `cacheReuseDrop`，`rows.ts:413-425` |
| 整块挂在 config 的 `debug.turn_tokens` 上（**默认关**）；`verbosity === "verbose"` 时才在表里再列工具调用 | `53` / `1613` 行 |

**做法**：

| 点 | 决定 |
|---|---|
| 开关 | TUI 默认关这一块；**面板按拍板的默认做出来、默认收起** —— 手机上看一眼数字的诉求是真的，收起的一行不占地方 |
| 位置 | 该轮**收尾那一步**的脚注之后（`turn-usage` 行在 TUI 里就是排在 `assistant-footer` 之后）|
| 轮次 | `turnInfo(msgs)` 照 `flushTurn` 把整表摊平成「收尾那步 id → 这一轮」；按 `msgs` 数组引用缓存一次（`renderMessages` 每趟只造一份）|
| 展开态 | `<details class="tokblk" data-def="0">` —— 默认收着，用户点开过的照 `syncDetailsOpen` 留住 |
| `verbose` 那层 | **不做**（默认档是 medium）：表里不列工具调用。这也是「不加档位开关」那条默认的自然结果 |
| `.meta` | 收工后 token 数归块，`.meta` 只留费用；**还在跑的那一步**照旧把 token 数留在 `.meta`（那时候块还没到，看着它涨），`ui-stream` 那条老断言因此照旧成立 |
| 颜色 | 掉量那两处用琥珀（照 `text.feedback.warning`），块其余部分一律 muted；`Tokens` 那个词加粗 |

**验证**：`footer-audit.js` 探针加了 Tokens 一栏。探针会话（393×894）实拍两块：
`Tokens: 46 steps · latest: 717 new · 47,744 cached · 48,461 total · ! 1 likely cache bust`（47 行表 —— 46 步 + 那条掉量提醒，
正好印证「steer 不关轮」：一轮里攒了 46 步）与 `Tokens: 5 steps · latest: 284 new · 49,536 cached · 49,820 total`；
点开截图里表头 `Step / New / Cached / Total` 与每步一行都对得上
（`/tmp/ocsm-probe/perf/footer-audit-393x894.png`）。`.msg.assistant .meta` 在窗口里计数 **0**（收工后不再重复一份）。

**回归**：`smoke.sh` 新 R7 组 4 项；`ui-tools` 199 → **224**（25 项：`tokenTotal`、`cacheReuseDrop` 四条分支、
块只印收尾那步、总览文案、默认收起、表头与每行、掉量的两处、老会话终步收轮、跑着不印块、`.meta` 前后行为、
和为 0 的步、整轮没 tokens、单步写 `1 step`、压缩作废上一轮 cache）；其余套件与 `e2e-*` 全 0 失败。

---

### 8.31 追加：待发送队列收成一条（照 TUI 的 QueuedPromptDock）

**起因**：用户「一切往 TUI 的方向靠拢」的清单第 5 项 —— 待发送队列收一行。

**先把 TUI 的事实抓准**（`packages/tui/src/routes/session/index.tsx:2343` 的 `QueuedPromptDock` +
`1462` 行那处渲染条件）：

| TUI 行为 | 证据 |
|---|---|
| 一条档：`N queued · <下一条的正文>`（正文里的换行 `replaceAll("\n", " ")` 压成空格、`truncate` 截断） | `2346-2370` 行 |
| 计数只数 `type === "user" && delivery === "queue"` 的项；点一下打开「Queued prompts」对话框看逐条 | `220-225` / `2343` 行 |
| 无队列时不渲染这一条 | `1462` 行 `queuedPrompts().length > 0` |
| 左边一条中性色边 + 抬起底色，hover 时底色再压深一档 | `2350-2364` 行 |

**做法**：

| 点 | 决定 |
|---|---|
| 形态 | `#inbox` 里收成一条 `<details class="ibdock" data-def="0">`，行头就是 TUI 那行，点开才是原来那一列 `.inbox-item`（面板没有 TUI 那个对话框，用 `details` 顶） |
| 计数 | 面板这边数**整张待发送表**（待发送队列是面板自己的一个列表：排队 / 插话 / 压缩 / 移动都在里面）—— 只数 `delivery=queue` 的话行数与展开后对不上；措辞照 TUI 的 `queued` |
| 截断 | 照 TUI 把换行压成空格；截断交给 CSS（`.ibNext` 的 `text-overflow: ellipsis`），不在 JS 里切字数 —— 宽度是活的 |
| 展开态 | 这份列表每次事件都**整块重画**（`box.innerHTML = ''`），所以展开态得自己记住（重画前读一次旧 `details.open`，重画后照搬），否则排队→插话、取消一条就折回去了 |
| 一行没少 | 逐条那列的 DOM 一个字段都没动（`.inbox-item` / `.ib-kind` / `.ib-delivery` / `.ib-text` / 两个按钮），只是挪进了 `details` —— 老断言（`qa('#inbox .inbox-item')` 计数、`textContent` 里找文案）照旧成立 |

**验证**：`footer-audit.js` 探针往 `store.inbox` 塞两条（排队 + 插话）后调 `renderInbox()`。393×894 实拍：
行头 `2 queued · 第一条待发送的消息,正文挺长的要看看会不会把…`（省略号收住，没撑破行），`rows: 2`、
`nextEllipsis: "ellipsis"`；点开后两条的标签与按钮都在（`/tmp/ocsm-probe/perf/footer-audit-393x894.png`）。

**回归**：`smoke.sh` 新 R8 组 3 项；`ui-controls` 90 → **96**（6 项：收在 details 里且默认收起、行头文案、
逐条那列一行没少、展开态跨重画留住、换行压成空格、只有控制项时只留计数）；其余套件与 `e2e-*` 全 0 失败。

---

### 8.32 追加：其它消息种类照 TUI 的 SessionMessageView

**起因**：用户「一切往 TUI 的方向靠拢」的清单第 6 项 —— `model-switched` / `agent-switched` /
`location-switched` / `synthetic` / `skill` / `shell` 这些种类，面板原来一律画成一句
`· <type>: <text>`（`renderMessage` 的兜底分支）。

**先把 TUI 的事实抓准**（`packages/tui/src/routes/session/index.tsx:1799` 的 `SessionMessageView`
及其分派到的三个组件）：

| 种类 | TUI 画法 | 证据 |
|---|---|---|
| `location-switched` | `↳ Moved to <location.directory>`（前缀 muted、目录 info 蓝），缩进 3 | `1936-1944` |
| `agent-switched` | `Switched agent from <X> to <Y>`（两头 `Locale.titlecase`；`previous === agent` 时只写 `to <Y>`），整行 muted | `1946-1951` |
| `model-switched` | `switchLabel(model, models, previous)` | `1952-1954` |
| `switchLabel` | 同 `providerID`+`id`（只换档）→ `Switched variant to <档 ?? "default">`；模型表查得到 → `Switched model to <name>`（档不是 `default` 时补 ` (档)`）；查不到 → `Switched model to <providerID/id/档>` | `util/model.ts`，二进制原文核对过 |
| `system` | InlineToolRow：`◈ <description ?? "Instructions updated">`，色 muted | `1963-2020` |
| `synthetic`（无 `source`） | 同上，`◈ <description ?? "">` | 同上 |
| `synthetic`（`metadata.source` 是 `subagent`/`shell`） | `↳ <Actor> <status> · <描述>`：`Actor` = `Shell` 或 `titlecase(metadata.agent ?? "Subagent")`；`completed` → `finished`、`error` → `failed`、其余原样；`completed` 用 `↳`、别的用 `!`；error 红、cancelled 琥珀、其余 info 蓝；shell 的描述先 `replace(/\s+/g," ")`；描述按剩余宽度 `truncateWidth` | `1970-1990` |
| `skill` | InlineToolRow：`→ Skill <name>` | `2022-2029` |
| `idle` | **不出行**（只拿来收轮） | `rows.ts:379-381` |
| `synthetic` 没有 `description` | **整条跳过**（例如「上一条被打断，接着干」那条原始指令，正文是给模型看的） | `rows.ts:383` |

**做法**：

| 点 | 决定 |
|---|---|
| 切换类 | 新 `.swrow`（整行 muted、等宽），location 那行的目录单独一格 `.swPath` 走 info 蓝 —— 与 TUI 一样只给目录上色 |
| `switchLabel` | 逐字照 TUI：先比 `previous.providerID`/`id`（只换档），再查 `store.modelIndex`（面板里就是「模型表」），查不到才退回 `providerID/id/档` |
| 通知类 | `◈` 那行直接复用工具行的 `.toolrow` 结构（面板里工具行本来就是 InlineToolRow 的等价物），但 **`.notice .tmark` 改 muted** —— TUI 的 `◈` 是 muted，不是工具行那枚琥珀 |
| 收工行 | 新 `.completion`：`display: flex` 一行不折，行头 `.cHead` 按状态着色，描述 `.cSuffix` 是 `flex: 1` + 省略号（对应 TUI 的 `truncateWidth`）。**第一版写成普通行内 span 时实测在 393 宽下「↳ Shell finished」和「· 命令」被折成两行**，`.cSuffix` 的 `white-space: nowrap` 让它整块换行又不裁切 —— 改 flex 后才是一行 |
| 不出行的两种 | 新 `msgHidden()`；`renderMessages` 里 `if (!L && msgHidden(view)) continue` —— 连 DOM 带 `msgEls` 记录一起不建。这修掉一个现存外观问题：`idle` 原来会渲染成空壳，实测 `#messages .msg.idle` 是 **349×2、左边一条 `rgb(220,220,220)` 灰边**（`.msg` 的 `border-left` + `padding`），加 22px 下边距，一条会话里几十条就是几十处空隙 |
| 签名 | `model-switched` 那行的模型名要查表，所以它也进 `fpExtra`（与 §8.27 的助手脚注同一个坑）。**实拍第一版就抓到了**：模型表晚到一步时那行永远停在 `Switched model to company/deepseek-v4-flash`，而 `store.modelIndex` 里明明有 `company/deepseek-v4-flash → DeepSeek V4 Flash` |
| `shell`（消息种类） | 面板这一支在 §8.22 早就照 `ShellDisplay` 画好了，这轮不动 |
| `idle` 带 `error` | **不做**：`SessionMessageView` 里确实有「`idle` 带 `error` → `Error: …`」这个分支（`ExecutionError`，paddingLeft 3，error 色），但它的行式视图 `reduceSessionRows`（`rows.ts:379`）对 `idle` 是 `flushTurn(rows)` 之后**直接 return、一行都不 push**，所以那个分支在行式视图里到不了（只有 `SessionMessageView` 被"行"驱动，见 `index.tsx:1576`）。面板把 `idle` 整条不出行**反而与 TUI 一致**；会话真报错时两边都走助手脚注那条路（§8.27 的 `Error: …` / `⚠ Retrying in …`）|

**验证**：`footer-audit.js` 探针加了 `minor` 一栏（逐行 dump）+ `idleN`。三个会话实拍：

- 探针会话：`idleN: 0`（原来 2）、`msg minor swrow` 两行 —— `Switched agent from Sisyphus - Ultraworker to Build` 与
  `Switched model to DeepSeek V4 Flash`（签名修好后不再是退回形态）。
- `ses_demo_d…`：`◈ Continuing after restart`（`synthetic` 有描述）、`◈ Instructions updated: core/codemode`（`system`）、
  两行 `↳ Shell finished · <命令>`（`synthetic` source=shell）。
- 393×894 截图里收工行是一行、行头 info 蓝、命令省略号收住（`/tmp/ocsm-probe/perf/footer-audit-393x894.png`）。

**回归**：`smoke.sh` 新 R9 组 4 项；`ui-tools` 224 → **246**（22 项：`switchLabel` 四条分支、
`model-switched` / `agent-switched`（两种）/ `location-switched`、通知类（`system` 含兜底、`synthetic` 的 `◈`、
子会话与 shell 收工行的 actor 大小写 / 空白压平 / 三档颜色）、`skill` 消息、`msgHidden` 三种情形，
以及走一趟真渲染确认那两种**压根不建元素**）；其余套件与 `e2e-*` 全 0 失败。

---

### 8.33 追加：选择框的三个细节照 TUI 的 DialogSelect

**起因**：清单第 7 项「对话框 / 状态条细节」。**状态条那一半早先几轮已经落地**（`#promptFooter`
五格、`#progress` 那句 `esc interrupt`、`#cmdHint` 的桌面/手机两档），这一轮只补**选择框**
（`/sessions` `/models` `/agents` 共用的那个 `#dlgPick`）与 TUI 的 `DialogSelect` 之间剩下的三处差。

**先把 TUI 的事实抓准**（`packages/tui/src/ui/dialog-select.tsx`，dev 分支）：

| 点 | TUI 做法 | 出处 |
|---|---|---|
| 「当前值」那一条 | 行首单独一格印一枚 `●`（新设计档实验开着时是 `▪`；`props.current && !props.gutter` 才印）。**高亮（`active`）与它是两回事** —— 高亮是光标位置、会跟着 `↑`/`↓` 走，`●` 钉在当前值那条上不动 | `DialogSelectRow` |
| 缩进对齐 | 有 `●` 的行把左边距少算两格（`DIALOG_LIST_INSET - 3` vs `- 1`），于是**印不印 `●`，条目名都对齐** | 同上 |
| 底部一行动作 + 键位 | `DialogFooter`：`actions.secondary`（`side !== "right"`）在左、`primary`（`side === "right"`）在右，每项是「动作名 + 键位」（键位从 keymap 里查） | `DialogSelect` 的 `legacyFooter`、`ui/dialog.tsx` |
| 空态 | 分两种：**压根没有条目** → `emptyView ?? "No items available"`；**有过滤词但没匹配** → `noMatchView ?? "No results found"`。选哪条按 `renderFilter !== false && filter.length > 0` 判 —— **不是按「有没有条目」判** | `DialogSelect` 的 `grouped().length > 0` 分支 |
| 分组标题 | `DialogSelectCategory`：默认档是 `hue.accent[200]` + **粗体**，每组上边留一行 | `DialogSelectCategory` |

**做法**：

| 点 | 决定 |
|---|---|
| `●` 那格 | `renderPick` 里每条都印一个 `<span class="pi-cur">`，不是当前的印空串 —— 与 TUI「少算左边距」等价：**条目名恒对齐**。CSS `flex: none; width: 1em`，颜色 `--accent`。另外给那一条挂上 `.current` 类当抓手（TUI 里 `current` 是独立 prop，面板里得留个类，测试与后续样式才有得抓） |
| `●` 的取值 | `openPick` 把 `opts.current` 存进 `store.pickCurrent`；`undefined` 就不印（窄屏那个「⋯」动作菜单没有「当前值」这回事）。判等用 `it.key === store.pickCurrent`，所以**变体选择框里「默认」那条（`key === ''`）也会正确钉上 `●`** |
| 底部那行 | 新 `paintPickFoot(opts)`（在 `openPick` 末尾调），往 `#pickFoot` 里写两档文案：桌面 `↑↓ 选择 · Enter 选中 · Esc 关闭`、手机 `点条目选中 · 关闭按钮收起`；有过滤框时前面各多一句「打字过滤」。两档切换沿用面板既有的 `html.narrow` 套路，但**样式单写一份 `.dlgfoot`** —— `#cmdHint` 那三行规则带 id 前缀，`.hFull`/`.hNarrow` 在别处本来就不生效 |
| 空态 | 判据照 TUI 用「**过滤词非空**」而不是「条目为空」：过滤框里有字却没结果 → 「没有匹配项」，否则 → 「没有可选项」 |
| 分组标题 | 面板本来就是 `.pick-group`（`--muted` + 600 字重 + `--panel` 底），与 TUI 那套「accent 色 + 粗体 + 上边留白」是同一意图的不同配色，**不动**（这轮不改配色，见 §9 的取舍表） |

**验证**：探针里直接调 `openPick`（`openPick` 是全局函数声明，探针能调）开一张
`/models` 形状的列表，393×894 实拍（`/tmp/ocsm-probe/perf/footer-audit-393x894.png`）：
`curN: 1`、`dots: "|●|"`（三条里只有中间那条印了 `●`）、底部读出手机那档
`打字过滤 · 点条目选中 · 关闭按钮收起`。图里还能一并看到分组标题、当前模型那条的名字用 accent 色。

**回归**：`smoke.sh` 新 R10 组 4 项；`ui-picks` 87 → **96**（9 项：`current` 那条带 `.current` 且印 `●`、
每条都占着那格但只有 `current` 印出来、高亮挪开后 `●` 还在、没给 `current` 就不印、
空态两种文案、底部两档文案与「有没有过滤框」的组合）；其余套件与 `e2e-*` 全 0 失败。
（`ui-jump` 在某次批量连跑里报了 1 项失败，单独复跑 5 次全绿 —— 是那一套自己的时序抖动，
与这轮改动无关：这轮没碰滚动锚点那条路。）

---

### 8.34 追加：拉消息失败不许一声不响（修「手机打开某个会话一片空白」）

**起因**：用户报「手机 Edge 打开 *示例工程方案单页 PPT 制作* 这个会话，里面一片空白，
看不到任何对话内容；此时手机上还开着这个会话，电脑端在这个会话里回一句，手机端就能看到新内容了」。
「先空白、后来事件一来就有了」这条线索直接指向：**首次拉取失败被静默吞掉**，而事件驱动的对账
（`handleEvent` → 防抖 → `loadMessages`）又拉了一次、那次成功了。

**先把事实量出来**（真 Chromium + CDP `Network.emulateNetworkConditions` 把下行限到 200KB/s，
模拟手机 WiFi；脚本 `/tmp/ocsm-probe/pw/slow.js`）：

| 量 | 值 |
|---|---|
| 那个会话首页响应体（`?limit=100&order=desc`） | **12.9 MB** |
| 其中 | `content` 12.6 MB，而且集中在 **`tool` part**（单条 1.9MB，写工具把整份文件内容带回来了）；base64 截图 11.87 MB / 18 张 |
| 最新 N 条的体量 | 10 条 0.5MB、20 条 2.0MB、30 条 2.12MB、50 条 4.72MB、100 条 12.91MB |
| 限速后打开该会话 | t=3s / 20s / 60s **消息区 `dom:0`、`msgs:0`**，整块只有「跳到最新 ↓」，**没有任何提示** |

**根因**：两处叠加 ——

1. `api()` 里 `JSON.parse` 失败就 `return null`（手机上一次 12MB 的传输下到一半被掐断就是这种），
   调用方 `(j.data || [])` 于是把「**没拿到**」当成「**这个会话没有消息**」；
2. `loadMessages` 的 `catch` 只 `console.error` —— 手机上没人看控制台。
   于是 0 条消息被当成正常结果画出来：标题、状态、操作行都在，只有消息区空着，
   看起来就像「这个会话本来就没内容」。

**做法**：

| 点 | 决定 |
|---|---|
| 半截正文 | `api()` 遇到「有正文但 `JSON.parse` 失败」**抛错**（`响应不是合法 JSON(可能只下到一半)`，带 `err.truncated`）。空正文的 2xx（204 / 某些 POST）仍是合法的 `null`，不走这条路 |
| 响应不成形 | `loadMessages` 里 `if (!j \|\| !Array.isArray(j.data)) throw new Error('响应里没有消息数组')` —— **空数组和「没拿到」必须分得开** |
| 自动重试 | `MSG_TRIES = 3`（首发 + 2 次），退避 `MSG_RETRY_MS = [800, 2500]`。重试期间切了会话/有更新的请求在跑就停 |
| 失败要留证据 | 重试都用完才亮那条状态行：`加载失败:<原因>` + 一个 `.chip` 的「重试」（点了就是 `loadMessages({ older: false })`）。没有它，一行都不说就是这次 bug 的样子 |
| 慢的时候说一声 | `正在加载消息…`，但**慢过 `MSG_LOADING_DELAY_MS = 250` 才露** —— 本机会话 30ms 就回来了，不该每次切都闪一下 |
| 在途请求作废 | `store.msgSeq` 当「代」号：`selectSession` / `clearSelection` 各 `++` 一次，在途响应与重试回来一看代号变了就丢。原来只按 `store.selected !== id` 复查，**同一个 id 的旧响应**（切走又切回来）拦不住 |
| 节点怎么放 | `#msgState` 照 `#jumpLatest` 那套：节点写在 `index.html` 的 `#messages` 里，引用存在外面，`paintMsgState()` 自己搬回末尾（`selectSession`/`clearSelection` 的 `innerHTML=''` 会把它一起抹掉）。默认 `hidden`，平时一个像素都不占 |
| 样式 | `.msgstate` 是 `display:flex`，所以**必须显式**写 `.msgstate[hidden]{display:none}`（与 `#jumpLatest[hidden]` 同一条理由）；失败态挂 `.bad` 用 `--danger` |

**验证**（真 Chromium，393×894，脚本 `/tmp/ocsm-probe/pw/verify.js`）：

- 慢网络 3s：`state:"正在加载消息…"`、`retryShown:false`、`msgs:0` —— 从「一片空白」变成「它在拉」；
- 连打回 3 次：`state:"加载失败:Failed to fetch"`、`retryShown:true`，`/message` 请求数正好 3（1 + 2 重试）；
- 点「重试」：状态行变回「正在加载消息…」并真的重新发请求。

**回归**：`smoke.sh` 271 → **279**（新 R11 组 8 项：状态行的结构、`setupMsgState()` 接线、
重试次数与退避、「空数组 vs 没拿到」、延迟才露 + 切走作废、`.msgstate[hidden]`、ui-jump 反向断言）；
`ui-jump` 63 → **90**（27 项：形状/接线、慢时露快时不闪、连打回 3 次亮原因、
点重试恢复、半截正文与缺 `data` 都算失败、切走作废、取消选中不粘）；其余套件与 6 个 `e2e-*` 全 0 失败。

**这一条只修了「失败不许静默」，首页那 12.9 MB 本身还没动** —— 手机上仍要下几十秒。
缩小它的两条路（窄屏首屏只拉 30 条：12.9MB → 2.1MB；`/api/` 走 gzip：13MB → 8.8MB，base64 压不动）
记在 §10 待确认里，按「一项一提交」另起。

**后续**：同一套「失败必须留下证据」后来也搬到了左栏的会话列表上（§8.45）。

---

### 8.35 追加：手机一页只拉 30 条（桌面仍 100）

**起因**：§8.34 量出来的那 12.9 MB 首页。用户选了「缩页大小」这条路（而不是 gzip ——
截图 base64 压不动，13MB 只能到 8.8MB）。

**做法**：

| 点 | 决定 |
|---|---|
| 两个数 | `MSG_PAGE_WIDE = 100`（桌面，与原来一致）、`MSG_PAGE_NARROW = 30`（手机）。30 这个数是照实测挑的拐点：那个会话最新 10 条 0.5MB、20 条 2.0MB、**30 条 2.12MB**、50 条 4.72MB、100 条 12.91MB —— 30 条之后每多拉一条都在翻倍 |
| 口径只有一处 | `msgPageSize()` 读 `html.narrow`（面板本来就靠这个类判窄屏，见 §8.16 的「判定源唯一」）。首屏与「加载更旧消息」**共用**它 —— 翻页还按 100 拉的话，点一下又回去拉十几 MB |
| 转屏 | 每次 request 现读类名，所以转屏即时生效，不用刷新 |
| 桌面 | 一个字节都没变（`limit=100`）|

**验证**（真 Chromium，CDP 限速 200KB/s = 手机 WiFi 量级，脚本 `/tmp/ocsm-probe/pw/page30.js`）：

| 视口 | `html.narrow` | 请求 | 响应体 | 条数 | 到内容 |
|---|---|---|---|---|---|
| 393×894 竖屏 | 是 | `?limit=30&order=desc` | **2.12 MB** | 30 | **13.4s**（原来 12.9MB 要 65s+）|
| 1440×900 桌面 | 否 | `?limit=100&order=desc` | 12.90 MB | 100 | 不变 |
| 894×393 横屏 | 是（矮屏 + 粗指针）| `?limit=30&order=desc` | 2.12 MB | 30 | 同上 |

**顺带量出来一件没修的事**（记进 §10）：`cvmany`（`content-visibility: auto`）的离屏估值
在**贴底之后**才落定 —— 浏览器把 `scrollTop` 夹回去，于是「明明贴了底」变成停在真底部
上面一截。竖屏实测 **466px**（最新一条只露出半截），而且带随机性：同一次切换里
若「事件触发的那次对账」正好落在估值落定之后，就又是 0。桌面 100 条那档老早就有
（§8.17 记的 1473px），不是这轮引入的；30 条一页反而把误差缩到三分之一。

**回归**：`smoke.sh` 279 → **281**（新 R12 组 2 项：两个数各一处 + `msgPageSize()` 是唯一口径、
ui-jump 反向断言）；`ui-jump` 90 → **95**（5 项：桌面 100 / 窄屏 30 / 窄屏翻旧 30 / 转回宽屏又 100 /
两个常量）。其余套件与 6 个 `e2e-*` 全 0 失败。

---

### 8.36 追加：贴完底再跟几帧（cvmany 的离屏估值是贴完之后才落定的）

**起因**：§8.35 顺手量出来的那件事 —— 手机上打开会话停在真底部**上面 466px**，
最新一条只露半截，而面板自己认为「在底部」（`store.nearBottom === true`、
「跳到最新」也不露），所以用户没有任何提示，只能自己往下拨。

**机制**（实测的 scroll 事件时间线，`/tmp/ocsm-probe/pw/drift.js`）：

| 时刻 | `scrollTop` | `scrollHeight` | 说明 |
|---|---|---|---|
| 贴底 | 6294 | 6870 | `pinBottom()` 刚跑完，位置是对的 |
| +231ms | 6294 | 6870 | 触发一次 `scroll` |
| +374ms | **6124** | 6700 | 浏览器把 `scrollTop` **夹回去**（估值变了）|
| 之后 | 6124 | **7166** | 估值最终落定 —— **这一步不触发 `scroll` 事件**，于是再没有任何东西来纠正它 |

两个结论：① 估值是**贴完之后**才落定的，`pinBottom()` 那一下量的底不算数；
② 最后那一步没有 `scroll` 事件，所以既有的两条路都抓不到 —— `updateJumpLatest()`
只在滚动/渲染时出手，`ResizeObserver` 盯的是容器自己的盒子（容器没变矮）。

**做法**：新 `repinUntilStable(box)` —— 贴完底再逐帧读 `scrollHeight`，
**变了才重新贴**（干净时读一次是廉价读，不白贴）。停手有三条：

| 条件 | 为什么 |
|---|---|
| `seq !== repinSeq` | 又渲染 / 又切会话了，这一轮作废。三个作废点：`selectSession`、`clearSelection`、`renderMessages`（第三次是关键 —— 不然旧采样会去动新会话的位置）|
| `!store.nearBottom` | 用户往上滚了，让路（滚动监听把它翻成 `false`）|
| `REPIN_BUDGET_MS = 800` 用满 | 有上限。实测那次落定在贴底后 100~400ms，800ms 有余量 |

只在 `pinned && box.classList.contains('cvmany')` 时才启动（没有 cvmany 就没有估值，压根不该走）。

**两条被否掉的路子**：① 「固定补 2~3 帧」—— 落定实测发生在第 2~25 帧之间，会漏；
② `ResizeObserver` —— 被跳过的元素**压根没有盒子**，尺寸变化不上报；容器自己的盒子又没变。

**验证**（真 Chromium 393×894，`/tmp/ocsm-probe/pw/drift.js`、`settle.js`、`page30.js`）：

- 同一个会话竖屏：`gap` **466 → 0**、`lastBottomBelow = -36`（最新一条完整落在视野里）、
  「跳到最新」不露；限速 200KB/s 那档 `gapBottom 0 / lastVisible true`；
- **让路**：往上滚 300px 后（`nearBottom === false`）再让内容长 700px → `scrollTop` 一动不动、
  按钮露着（`/tmp/ocsm-probe/pw/yield.js`）；
- **测试会咬人**：把 `renderMessages()` 里那一行临时关掉，`ui-jump` 的
  「贴完底之后内容又变高 → 自动贴回底部」就报 `got=14274/14874` —— 正好差 600px，
  就是那一段模拟出来的落定。

**回归**：`smoke.sh` 281 → **283**（新 R13 组 2 项：只在 cvmany 下 + 预算上限 +
三处作废、停手的两条硬条件 + ui-jump 反向断言）；`ui-jump` 95 → **105**（10 项：
预算常数、贴完底后内容变高又被贴回、按钮不冒出来、让路后再变高一动不动、
按钮该露着、复位、再渲染把上一轮作废）。其余套件与 6 个 `e2e-*` 全 0 失败。

**后续**：那个 800ms 的时间预算后来换成了「盯高度」（另有 `ResizeObserver` 接住
迟到撑开的那种），见 §8.46。

---

### 8.37 追加：消息列表里摘掉 `data:` 图（面板一个字节都不显示，却占 89% 的流量）

**起因**：用户上手回话——「正在加载消息…然后确实可以显示最新一条，只不过加载的时间有点久」。
功能对了，剩下的就是**体量**。

**量出来的事实**（`curl` 那条会话 `ses_demo_long_c`）：

| | 总字节 | 其中 `data:` 图 |
|---|---|---|
| 手机一页 30 条 | 2.12 MB | **1.89 MB（89%，3 张图，平均一张 630 KB）** |
| 桌面一页 100 条 | 12.90 MB | **11.87 MB（92%）** |

这些字节只挂在 `content[].state.content[].uri`（MCP 工具返回的图，`data:image/png;base64,…`）。
而面板的 `toolOutputHtml()` 是 `st.content.map((c) => c.text)` —— **只取文本项，连文件名都不显示**。
也就是说：**面板从来不渲染它们，手机却要等它们下完**。

**做法**（代理层，`server.js`）：新 `isMessageListUrl()` + `stripToolUris()`。

| 规则 | 为什么 |
|---|---|
| 只认 `GET` + `200` + json + `/api/session/<id>/message` | 只有这一条背着大块字节；列表 / 单条消息 / 别的端点不碰 |
| 只动 `data:` 开头的 `uri` | `file://`、`https://` 之类原样留着（它们不是字节） |
| 留 `name`/`mime`，另记 `omitted: <原字节数>` | 将来要做「点开看图」还知道有多大；也方便排查 |
| `text` 一个字节不碰 | 面板看得见的就这些 |
| 解析/重排失败 → `out = raw` 原样发 | **代理不许因为顺手省流量把面板弄坏** |
| SSE（`/api/event`）不碰 | 那是流式的，摘不了；实测首字节 3ms，没被顺手缓冲 |

代价：这一条响应要整体过一遍 `JSON.parse`/`stringify`（手机那页 0.23MB，桌面那页 1MB —— 几十毫秒），
换来 **9~13 倍**的流量。

**验证**（真 Chromium + 真代理，本机 393×894 / 1440×900）：

- **体量**：手机页 `2,119,998 → 230,723` 字节（9.2×）；桌面页 `12,902,621 → 1,027,394`（12.6×）；
  翻旧 4 页共摘 **44 处、0 漏网**。
- **时间**（CDP 限速，从点会话到内容出现）：**200 KB/s 下 13,474ms → 1,758ms（7.7×）**；
  1 MB/s 575ms；4 MB/s（家用 WiFi）382ms；贴底 `gap` 仍 0、条数不变。
- **可见 DOM 一个字节没变**：三个会话（手机图多 / 手机纯文本 / 桌面图多）改前改后
  `#messages.innerHTML` 的长度与 FNV 哈希**逐位相同**（`b8360c54` / `c659a8e0` / `a4ca996e`）；
  改前连跑两次也一致 —— 证明这个哈希能当依据，不是碰巧。
- **摘完剩下的都是实打实的内容**：文本 60% / 时间戳等 27% / 工具参数 12% / 差异 1% —— 没有可再挤的了。

**回归**：`smoke.sh` 283 → **287**（新 R14 组 4 项：纯函数在且 URL 只认消息列表、
只有那一条走缓冲改写且解析失败原样发、只摘 `data:` 且 SSE 仍流式、`strip-run.js` 在）；
新增 `test/strip-run.js` **41 项**纯函数断言（该摘的 4 项 / 不该碰的 8 项 / 12 项结构容错 /
摘前摘后「面板看得见的 text」完全一致）。其余套件与 6 个 `e2e-*` 全 0 失败。
**服务端改了要重启**：`systemctl --user restart opencode-session-manager.service`。

**后续**：另一条路上也背着同一批字节（SSE 的 `session.tool.success`），已按行改写摘掉，
见 §8.47。

---

### 8.38 追加：列表折叠跨刷新保持（但只在同一个标签页里）

**起因**：用户——「电脑端，点击刷新，自动展开会话列表，本来是没展开的刷新之后就展开了」。

**和 §8.13 的关系**：§8.13 的起因是反过来的那句话——「第一次打开网页时，应该展开对话列表」。
两句都要成立，所以能记的只剩一档：**只活在这一个标签页里**的状态。

| | 刷新（F5，同一标签页） | 新开标签页 / 新窗口 | 换设备、重装 |
|---|---|---|---|
| `sessionStorage` | **保持** | 展开（从零开始） | 展开 |
| `localStorage`（v1 的做法） | 保持 | 保持 | 保持 ← §8.13 那次困扰的来源 |

**做法**：新键 `sessionStorage['ocs.listHiddenTab']`。

| 点 | 决定 | 理由 |
|---|---|---|
| 读 | `listCollapsed()`：`=== '1'` 就收起，没记过 = 展开 | 「没记过」必须与「显式展开过」等价，因为默认就是展开 |
| 写 | **只在点手柄那一下**写（收起写 `'1'`、展开 `removeItem`） | 只有点手柄是显式动作 |
| 临时拉出 | `list-peek` 一个字都不写 | 「鼠标靠左边缘瞥一眼」不是改设置（§8.7） |
| 存储被禁 | `try/catch` 里当「没记过」 | 隐私模式下折叠本身还得能用 |
| 老键 | `localStorage['ocs.listHidden']` 既不读也不写 | §8.13 就是为了它才把整段删掉的，别再让它复活 |
| 窄屏 | 照旧不受影响 | `html.narrow main.list-hidden` 那条复位规则还在（§8.12 时代留下的）|

**验证**（真 Chromium + 真面板，`/tmp/ocsm-probe/pw/listpersist.js`，10 项全过）：

```
PASS 列表是展开的                                       ← 新标签页
PASS 收起了、列表藏了            对话区宽 1424(列表那列真让出来了)
PASS 记在了 sessionStorage / localStorage 里没写
PASS 刷新之后还是收起的           ← 用户报的那一步,改前这里是「自己展开了」
PASS 手柄文案对得上(点一下就能展开)
PASS 展开之后再刷新:还是展开的
PASS 新标签页里是展开的(§8.13 那条要求还立着)
PASS §8.13 的老毛病不复现:localStorage 里躺着收起态也不作数
PASS 窄屏列表照旧可见(不会被那份记忆压住)
```

**回归**：`ui-layout` 164 → **172**（§8.13 那两组「重新打开网页一定是展开的」改成
「刷新还是收起的 / 新标签页才是展开的」，另加「点手柄才写记忆」「展开把记忆清掉」
「临时拉出两份存储都不写」）；`smoke.sh` 287 → **288**（把「一律展开 + 不读写 `ocs.listHidden`」
那条锁换成「记在 `sessionStorage` 且老键谁也不碰」+「没记过 = 展开、存储被禁也不炸」两条）。
其余套件与 6 个 `e2e-*` 全 0 失败。

### 8.39 选中的会话不在列表页里时，头部操作条与底板工具栏整条消失

**起因**：用户——「手机端不显示对话框下面的内容（除了进度条）」+「手机端也不显示：
导出、在TUI打开、归档、加载更旧信息那一栏」。

两处**同时**没，只可能是一个原因：那两排的显示判据都是「选中的会话在不在
`store.sessions` 里」，而 `store.sessions` 只装**当前筛选/分页的那一页**。

**复现**（真 Chromium，393×894，`isMobile`，`/tmp/ocsm-probe/pw/deeplink.js`）：
把 `GET /api/session?...`（列表）与 `GET /api/session/<id>`（深链补拉）两条都掐掉，
再冷启动到 `/#<sessionID>` —— 即「列表还没把这个会话送过来 / 补拉也没回来」：

```
改前：#chatOps=hidden  #ctoolbar=hidden  #chatAgent=hidden
      #progress 13px 在、#interrupt hidden   消息 29 条照旧
改后：#chatOps 40px    #ctoolbar 48px    #interrupt 44px 在   消息 30 条
```

改前那一屏就是用户报的：头部只剩标题 + 「加载更旧消息」的位置空着，
底板细边上**只剩那条进度条**（`■ 中断` 是 `#ctoolbar` 的孩子，跟着一起没了）。

**根因（三处，都在 `public/app.js`）**：

| 位置 | 改前 | 后果 |
|---|---|---|
| `renderChatOps()` | `const s = …; if (!s) { bar.hidden = true; return; }` | 列表没送到 → 操作条永远藏着 |
| `renderControls(s)` | `if (!s \|\| !store.selected) { bar.hidden = true; … }` | 工具栏是细边上 `■ 中断` 的家，一起藏（还与 `ui-composer` I5 的注释「`#ctoolbar` 的 hidden 只由有没有选中会话决定」相违）|
| `selectSession()` | `refreshSessionInfo(id)` 排在 `await Promise.all([…])` **之后** | 那组里任何一条卡住/挂住，补拉就不再执行；`refreshSessionInfo()` 自己也漏了重画 `#chatOps` |

**做法**：

| 点 | 决定 |
|---|---|
| `renderChatOps()` | 判据回到 `bar.hidden = !store.selected`；归档文案拿不到会话信息时先按未归档画，`refreshSessionInfo()` 到了再校正（同时清掉上一个会话的 `arch-on`）|
| `renderControls(s)` | **先 `bar.hidden = false` 再拉数据** —— 下面两个网络往返慢/失败都不许把条藏回去；选中的会话不在 `store.sessions` 里时只亮骨架，选择器走新的 `blankControls()` 清空（连 `index.html` 里那个占位的「默认」也不留），不拿上一个会话的 agent/model 冒充 |
| 屏上还是上一个会话的值 | `ctrlKeyOf(s) !== store.ctrlKey` 时先清空：没变就不闪，变了不冒充 |
| `selectSession()` | `if (!s) refreshSessionInfo(id);` 提到 `await Promise.all([…])` **之前** —— 那组里任何一条卡住都拖不住它（`await Promise.all` 成了函数最后一句，它就算 reject 也丢不掉东西）|
| `refreshSessionInfo()` | 补 `renderChatOps()`（归档/取消归档的文案靠它校正）|
| `toggleArchive(id)` | 会话信息还没到时不再无声返回：补拉一次 + `flash('会话信息还没到,稍等一下再按','warn')` |

**刻意没做**（留着看用户要不要）：补拉一直拿不到时，提示栏那格会先印
`(未指定工程目录)`（照 `paintPromptFooter` 的既有语义），而真值其实「还不知道」；
要改成「空着不印」得给 `paintPromptFooter` 加第三个参数 —— **已做，见 §8.44**。

**验证**（真 Chromium，`/tmp/ocsm-probe/pw/deeplink.js`）：E 组（只掐列表）与
F 组（列表 + 会话信息都掐）改后 `#chatOps` / `#ctoolbar` / `#interrupt` / 提示栏全在，
消息照旧；`/tmp/ocsm-probe/pw/desktop.js` 确认正常路径（列表里有这个会话）没被改坏：
两个会话切换后选择器分别填成 `build / company/deepseek-v4-flash` 与
`build(当前) / company/deepseek-v4-flash`，提示栏工程路径照旧。

**回归**：`smoke.sh` 288 → **290**（新增 R15：判据只有「有没有选中会话」+
`blankControls` 在、以及「补拉排在 `Promise.all` 之前」的源码顺序锁）；
`ui-layout` 172 → **184**（新增第 12 组：幽灵会话 = 列表页里没有但消息拿得到 ——
消息照旧、补拉照发、操作条与工具栏照在、选择器空着不冒充、拿到后标题/归档文案/
选择器校正、以及「辅助请求卡住时补拉照样发得出去」）；
`ui-capabilities` 71 → **74**（`renderChatOps()` 在会话不在 `store.sessions` 时也显示、
先按「归档」画、清掉上一个会话的高亮）；
`ui-controls` 96 → **102**（`renderControls(undefined)` 时工具栏在、选择器空、
变体收着；未选中才收起）。其余套件与 6 个 `e2e-*` 全 0 失败。

### 8.40 收起底板之后,提示栏那一行还挂在下面

**起因**:用户——「手机端对话框下面的信息还是显示,需要关闭,除了进度条」。

**改前**(真 Chromium 393×894,手机上底板是默认收起的):

```
#messages 575 @240-815
#composer 49 @815-864      ← 细边:进度条 + ■ 中断
#promptFooter 30 @864-894  ← 却还挂着:智能体·模型 / 工程目录 / 用量 / tab agents / / 命令
```

**根因**:`#promptFooter` 照 TUI 是「输入框下面独立的一行」,所以它挂在 `#composer`
**外面**(§8.19 挪过来、§8.21 补格子时都写着「手机收起底板时这一行照样露着,看一眼用量
正是主力用途」)。而 `styles.css` 里那份 `#composer.collapsed … { display: none }`
名单 —— 三个选择器、投递方式、附件行、输入行、两个补全面板 —— **收不到它**:细边收起来了,
它还在下面占 30px。

**做法**:一条 CSS,兄弟选择器(它在 `#composer` 外面,后代选择器够不着):

```css
#composer.collapsed ~ #promptFooter { display: none; }
```

| 点 | 决定 |
|---|---|
| 藏谁 | 整条 `#promptFooter`:智能体·模型、工程目录、上下文用量、`tab agents`、`/ 命令` 都在它里面 |
| 留谁 | `#progress`(进度条)与 `#interrupt`(`■ 中断`)—— 这两样本来就在 `#composer` 里,细边上只留它们 |
| DOM | 一个节点没删,只是 CSS 藏;展开就回来(与 `.cinput`、三个选择器同一套做法) |
| 桌面 | 一样收:细边就是细边,不按 `html.narrow` 分叉(窄屏判定源仍然只有一处) |

**（§8.42 接着改:手机上连【展开】态也不露了 —— 一条 `html.narrow #promptFooter { display: none }`,
于是这条兄弟选择器在窄屏其实用不上了,它管的是桌面收起时那一路)**

**验证**(真 Chromium 393×894,`/tmp/ocsm-probe/pw/thinedge.js`):

```
收起:#messages 575 → 605(那 30px 还给消息区)、#composer 49 @845-894、#promptFooter=none
      #progress 13px 在、#interrupt 44px 在
展开:#promptFooter 30 @864-894 照旧回来,其余一字未变
```

**回归**:`smoke.sh` 290 → **291**(Q 组加一条:必须能 `has` 到
`#composer.collapsed ~ #promptFooter { display: none; }`;那一段的旧注释「这一行照样露着」
一并改掉);`ui-composer` 91 → **99**(新 K 组 8 项:手机展开时提示栏在且路径那格有字、
收起时藏了、DOM 一个没少、细边上进度条与 `■ 中断` 照旧露着、再展开回来、桌面收起一样藏、
桌面展开照旧)。其余套件全 0 失败。README 计数同步;§8.19 / §8.21 里那两句
「收起时这一行也在」各加一句指到这里。

---

### 8.41 手机上「导出 / 在TUI打开 / 归档 / 加载更旧消息」那一行收起来

**起因**:用户——「手机端还是显示:导出、在TUI打开、归档、加载更旧消息那一栏」,紧跟着又一句
「**主要是手机端屏幕下,显示太多东西没必要**」。§8.39 修的是「列表没回来时它整条消失」,这一条
是同一个问法的另一半:它现在**确实露着**,而手机上不该占这 40px(§10 第 10 条记的就是这个待定)。

**改前**(真 Chromium 393×894,底板收起,§8.40 之后):

```
#chatHeader 129 @111-240   ← 标题 21 + 元信息 17 + 那一行 40(+ 它自己 8px margin)
#messages   605 @240-845
#composer    49 @845-894
```

**做法**:两半,缺一不可。

| 半 | 内容 |
|---|---|
| 显示 | `html.narrow #chatOps, html.narrow #older { display: none; }`。三个动作在 `/` 命令面板里**都有**(`export` / `tui` / `archive`),手机上展开底板敲一个 `/` 就到 |
| 翻旧 | 光收不行 —— 「加载更旧消息」是当时**唯一**的翻页入口(§8.26 修的、`PANEL_COMMANDS` 里没有这个动作)。所以补上**「滚到顶自动拉更旧」**:`#messages` 的 `scroll` 里,窄屏 + 离顶 ≤ `AUTO_OLDER_TOP`(120px)+ 还有游标 + 上一页不在路上 + 上一页没失败过,就替用户点一次那个按钮 —— 走的是**同一段** `loadMessages({ older: true })`(同一套游标、重试与失败话),只是没有按钮可点 |
| 位置 | 拉回来那 30 条**都在眼前这条上面**,光靠浏览器会守着 `scrollTop`(探针实测一直是 0)把人顶到刚拉回那一页的开头。所以拉完拿现成的锚点那套(`scrollAnchor()` → `applyScrollAnchor()`)把人放回原地:还是这条消息、还在屏上原来的位置。只在用户没趁机滚走时动手(离原来那个位置还在一个顶区之内)|

节流三条(都是从「一次进顶只拉一页」来的):

| 节流 | 为什么 |
|---|---|
| `autoOlderArmed`:离开顶区(> 120px)才重新上膛 | 不这样,贴顶那几帧会把历史一页接一页拉光(一页 30 条 × 十几个来回) |
| 上一页**在路上**时进来的那几发 `scroll` 不消耗上膛,收尾时补一发 | 用户挪下去又挪回顶、期间上一页还没回来:他停手就不会再派发 `scroll` 了,而窄屏上那个按钮已经收起来 —— 不补这一发他就只能再挪一次(这条是 `ui-jump` 的 7b9 逼出来的:第一版没补,7b9 红) |
| 失败过(`store.msgError` 非空)不自动重撞 | 消息区顶上那句「加载失败 + 重试」还在(§8.34),由用户决定;自动重撞会变成静默循环 |

切会话 / 重拉首屏(`loadMessages` 的非游标那一支)把上膛复位 —— 免得上一个会话的「已经拉过一页」
带到下一个会话(`store.msgOlderCursor` 也是那时候换的)。

**验证**(真 Chromium 393×894 收起态,`/tmp/ocsm-probe/pw/autoolder.js`,只读长会话
`ses_demo_long_b`):

```
#chatHeader 129 → 81      ← 那一行 40 + 它自己的 8px margin 一起还给消息区
#messages   605 → 654     ← 多 49px
#chatOps=none  #older=none(DOM 一个没删,只是窄屏不显示)

滚到顶:29 条 → 59 条,流水里多一发 翻旧 limit=30&cursor=eyJpZCI6Im1zZ18xM2Y4ZmU0NzUwMDF…
又等一会儿:还是 59 条(没连着拉)
离开顶区再回顶:59 → 89 条(又拉一页)
```

「不把人顶走」单看一下(`/tmp/ocsm-probe/pw/keepanchor.js`,在设 `scrollTop = 0` 的同一个任务里
先量一帧「拉之前」):

```
拉之前(滚到顶):scrollTop=0    总高=8714  29 条  眼前那条 msg_13f8fe4750… @14「⏺助手Thought · 8.5sThe m」
拉之后:        scrollTop=6982 总高=14767 59 条  眼前那条 msg_13f8fe4750… @14「⏺助手Thought · 8.5sThe m」
```

同一条消息、同一个 `@14` —— 不是「停在 0 被顶到会话开头」。(`scrollTop` 落的那个数带着
`cvmany` 的离屏估值,29 → 59 条正好跨过那个门槛,所以别拿它当尺子;锚点在屏上,`@14` 是准的。)

**桌面**:一字未动 —— 那一行照旧整条都在(`#chatOps` 还是 `inline-flex`,§8.25 那套版式原样),
`ui-mobile` 的 D 组(`D3a` / `D3b`)就是反过来断这个的。

**回归**:`smoke.sh` 291 → **292**(原来那条「窄屏 `#older` `min-height: 40px`」换成两条:窄屏
**整行**必须 `display:none`(只收几个 chip = 一行还是 40px,所以两条选择器一起断)、
`setupAutoOlder()` 必须接进 `init()` 且**只有那一处接线** + 窄屏判定源仍是 `html.narrow` +
`store.msgError` 非空时不自动重撞 + 拉完那段锚点(`scrollAnchor()` / `applyScrollAnchor(at)`)
在);`ui-mobile` 160 → **168**(C8d/C8e 窄屏两样都不显示、D3a/D3b 同一页转桌面又都在 ——
两个视口各跑一遍);`ui-jump` 105 → **116**(新 7b 组 9 项,见上表那三条节流;7c 两项断
「不把人顶走」—— 夹具里补一条**更旧的**长消息,所以那一页拉回来总高真的会长,7c1 断眼前那条
还是那条、还在同一个 `off`,7c2 断 `scrollTop` 跟着长出来的那一截走)。其余套件全 0 失败。
README 计数与「会话操作那一行」那一段同步。

---

### 8.42 手机上输入框下面那一行整条不显示

**起因**:用户——「可以了,但是手机端,对话框下面还有:Build...等内容显示」。§8.40 收的是
【收起】成细边时的那一行;这一条说的是【展开】底板时同一行照旧挂着。真机量下来:

```
真 Chromium 393×894,底板展开:
  #composer     227 @638-864   ← 工具栏 121 + 输入行
  #promptFooter  30 @864-894   ← 「Build · DeepSeek V4 Flash /work/…:main 143.6K (72%)
                                    tab agents  ctrl+p commands」
```

**做法**:一条 CSS(窄屏判定源仍然只有 `html.narrow` 一处):

```css
html.narrow #promptFooter { display: none; }
```

| 点 | 决定 |
|---|---|
| 收谁 | 整条:智能体·模型、工程目录、上下文用量、`tab agents`、`/ 命令` |
| 为什么能整条收 | 智能体·模型在底板工具栏里就有(`#agentSel` / `#modelSel`,展开时就在眼前);工程目录在标题下面那行(`更新 1 天前 · 8e9e6e25`)里也交代了;`/ 命令` 只是个提示(输入框 placeholder 里也写着「/ 命令」,敲 `/` 就开面板) |
| 桌面 | 一字未动:展开照旧整条在;收起时仍由 §8.40 那条 `#composer.collapsed ~ #promptFooter` 收 |
| DOM | 一个节点没删,只是窄屏 `display:none`(与前几条同一套做法)。窄屏那一版的 `padding` 与 `html.narrow #promptFooter.armed …` 那几条从此够不着,留着当记录 |
| 代价 | ~~手机上再也看不到**上下文用量**了(它只在那一行里)~~ —— **§8.43 已解决:那格搬到标题行末尾**(见 §8.43) |

**验证**(真 Chromium 393×894,`/tmp/ocsm-probe/pw/pfooter.js`,截图
`/tmp/ocsm-probe/perf/phone-expanded-footer.png`):

```
展开态改前:#messages 445 @192-638、#composer 227 @638-864、#promptFooter 30 @864-894
展开态改后:#messages 475 @192-667(+30px)、#composer 227 @667-894、#promptFooter=none
收起态:§8.40 那 49px 细边一字未变
```

**回归**:`smoke.sh` 292 → **293**(Q 组加一条:`html.narrow #promptFooter { display: none; }`
必须在;那一段的旧注释一并改写);`ui-composer` K 组那 8 项整个翻过来(原来断「手机展开时提示栏
在且路径那格有字」,现在断「窄屏两态都不显示、四格一个都没露、DOM 一个没少;桌面收起藏、展开在」,
项数不变,仍 99);`ui-mobile` 168 → **174**(新 C8f/C8g 窄屏整条不显示、D3c 桌面照旧 —— 两个
视口各跑一遍;夹具里补上 `#promptFooter` 那一段)。其余套件全 0 失败。README 计数与提示栏那几段
同步;§8.19 / §8.21 / §8.25 / §8.40 各加一句指过来。

---

### 8.43 手机上再瘦三处:顶栏整条 / 标题下面那行 / 用量那格搬家

**起因**:用户——「可以-f push了;123做动手」。1、2、3 就是 §8.42 末尾我摆出来的三条待办:

```
1. 顶栏那两行,111px(占竖屏 12%):「筛选 / 品牌 / 已连接」+「搜索 / +新建」
2. 标题下面那行,17px:「更新 1 天前 · 8e9e6e25」
3. 上下文用量 —— §8.42 之后它跟着提示栏一起没了,想留就得挪个地方
```

**做法**(三条各自独立,窄屏判定源仍然只有 `html.narrow` 一处):

| # | 收什么 | 怎么收 | 为什么能收 / 代价 |
|---|---|---|---|
| 1 | 顶栏整条 111px | `html.narrow.view-chat #topbar { display: none; }` | 那一行只在列表页有用(筛选 / 工程目录 / 排序 / 已归档 / 计数 / 导入 / 刷新 / 搜索 / `+新建` / 连接状态);`view-chat` 由 `syncNarrowView()` 从 `store.selected` 派生,回列表自己回来。**代价**:会话里没有「刷新」按钮(浏览器自己的刷新 / 下拉还在),要列表那一套就返回列表 |
| 2 | 标题下面那行 17px | `html.narrow #chatMeta { display: none; }` | 「更新 1 天前 · 8e9e6e25」是给排障看的(更新时间 / 项目号)。上面那条 `html.narrow.short #chatMeta { font-size: 11px }` 与从前的 `font-size` 规则从此够不着,留着当记录 |
| 3 | 用量那格 | `syncCtxInfoHome()` 把**同一个** `#ctxInfo` 节点搬进 `.chline` 末尾 | §8.42 把提示栏整条收了,那五格里只有用量值得手机「看一眼」(§8.15 的初衷)。**没有镜像副本** —— 与 `#jumpLatest` / `#msgState` 一个路子:按 id 找,谁都不依赖它在哪个父亲下面;宽屏搬回 `#chatDir` 之后、`#agentHint` 之前 |

第 3 条的两个接线点(都读同一个类,不另设判定):`syncNarrowClass()`(跨断点 / 转屏,也覆盖首次)与
`paintChatHeader()`(深链直接进会话那一下兜一道)。函数本身幂等(`ctx.parentElement === home` 直接
返回),所以两处调不出乱子。CSS 那边只给它压了字号(`html.narrow .chline #ctxInfo { font-size: 11.5px }`),
其余样式(两档文案按 `html.narrow` 切、`hidden` 语义)本来就是 id 级的,搬了家照旧生效。

**验证**(真 Chromium,`/tmp/ocsm-probe/pw/trio.js`、`trio2.js`;截图 `trio-phone-collapsed.png` /
`trio-phone-expanded.png`):

```
手机 393×894,会话(底板收起):
  §8.42 之后:#topbar grid 111 @0-111  #chatHeader 81 @111-192  #messages 654 @192-846
  改后:      #topbar none            #chatHeader 61 @0-61    #messages 785 @61-846  (消息区 +131px)
  标题行:#chatTitle 226px + #chatState(空闲)+ #ctxInfo「76% ctx」42px 排在末尾;
  整页 scrollWidth = 393 = 视口宽(没有横向溢出)
手机 393×894,会话(底板展开):#messages 475 → 644(+169px),下面的工具箱与输入行照旧
手机 393×894,列表:#topbar grid 111 照旧(那一行只在列表页留着)
手机横屏 894×393 / 窄窗 700×700:同上(顶栏 none、#chatMeta none、用量在标题行)
桌面 1366×900:一字未动 —— #topbar flex 47、#chatMeta 18、#ctxInfo 77 仍在 #promptFooter 里(「151.8K (76%)」)
```

**回归**:`smoke.sh` 293 → **296**(三条锁:窄屏 + `view-chat` 收顶栏 / 窄屏收 `#chatMeta` /
`syncCtxInfoHome()` 在且恰好接线两次 —— 那条同时锁「用量不许顺手丢掉」);`ui-composer` 99 → **101**
(`I3` 改写:窄屏会话里「筛选」跟着顶栏走 + 新 `I3b`;`K3` 四样改三样 + 新 `K3b` 用量搬到标题行);
`ui-mobile` 174 → **192**(新 `A6b`/`A7b`:用量那格的家跟着 `html.narrow` 来回搬、`B38` 窄屏列表
顶栏照旧、`C8g` 改写 + `C8h`/`C8i`/`C8j` 会话里三样、`D3d`/`D3e`/`D3f` 桌面三样都在且用量回到提示栏,
两个视口各跑一遍);其余 19 套与 6 个 `e2e-*` 全 0 失败。README 计数与那几段说明同步;§8.15 / §8.42
各加一句指过来。

**后续**：标题行那枚「空闲 / 运行中」徽章也收掉了(窄屏,见 §8.48)。

---

### 8.44 「还不知道工程目录」不许印成「(未指定工程目录)」

**起因**:用户——「都行」(问的是 §10 里记录在案的四条,这条是 §8.39 末尾那个
「刻意没做」)。深链直接进会话、或列表那一页还没装这个会话时,`store.sessions` 里
查不到它 → `paintContextUsage()` 拿到的 `dir` 是空串 → 提示栏那格印
`(未指定工程目录)`。可那会儿真值是「还不知道」,不是「这会话没有目录」。

**做法**:`paintPromptFooter(show, dir, known)` 加第三个参数,两个语义分开:

| 情形 | `known` | 那格 |
|---|---|---|
| 会话信息还没到手(`store.sessions` 里没有它) | `false` | 留空(连 `title` 也空着,不留一个会误导的悬浮提示) |
| 真拿到了会话,但它确实没有 `location.directory` | `true` | `(未指定工程目录)`(老语义,照旧) |

调用点只有 `paintContextUsage()` 一处:`paintPromptFooter(!!sid, dir, !!s)` —— 判据仍然
是「会话信息在不在手上」,不另设判定源;`s` 一到(`session.updated` / 补拉成功)下一次
`paintContextUsage()` 就把路径印上去。`known` 省略时按 `true` 走,老调用点不用改。

**回归**:`smoke.sh` 296 → **297**(新增一条:`known === false ? '' : '(未指定工程目录)'`
这句必须在,锁「两种语义没被并回一种」;原有的接线锁一并收紧成
`paintPromptFooter(!!sid, dir, !!s)`);`ui-stream` 247 → **249**(「会话信息还没到手时
那格留空」+「(复原)到手后路径照印」,后者保证没把正常路径一起弄丢);其余套件全 0 失败。
README 的 `ui-stream-run.js` 那句与「路径与 title」一段各补一句。

---

### 8.45 拉会话列表失败不再只进控制台

**起因**:用户——「都行」(§10 第 9 条)。`loadSessions` 的 `catch` 里只有
`console.error('loadSessions', e)`:左栏会安静地停在旧数据 /「共 0 个会话」上,
用户看到的是「今天真的没有会话」。§8.39 已经把「列表没回来 → 聊天区两排跟着消失」这条
连锁反应掐掉了,但左栏自己还是与 §8.34「失败不许一声不响」不一致。

**做法**:照 §8.34 的 `#msgState` 复制一份到左栏,样式直接复用 `.msgstate`;

| 件 | 位置 / 内容 |
|---|---|
| `#listState` | `index.html` 里 `#listpane` 内、`#list` 之后 `#loadMore` 之前(手机列表就是整页,它跟着整页走) |
| 文案 | 失败:`加载失败:<原因>`(`store.listError`,原因就是 `api()` 抛出来的那句 `message`,没有就 `HTTP <status>`);慢:`正在加载会话…` |
| 重试 | `#lsRetry`(`.chip`,手机上是 44px 命中区;`.msgstate` 是 flex,`[hidden]` 那条规则照旧管用) |
| 状态 | `store.listError` / `store.listLoading`;`setListLoading(true)` 进门、`finally` 收尾,成功时清 `listError` |
| 重试动作 | `loadSessions({ reset: true })` —— 失败那次往往连游标都没拿到,接着往后翻没有意义 |
| 慢才露 | `LIST_LOADING_DELAY_MS = 250`(同 §8.34 的延迟思路):本机几十毫秒就回来的不闪一下;请求挂住不 reject 时也是靠它才看得见 |

`console.error` 那条照旧留着(排障用);`paintListState()` 里像 `paintMsgState()` 一样
把节点搬回 `#listpane`(万一被谁清空过),顺序仍然在 `#loadMore` 之前。

**验证**(真 Chromium,`/tmp/ocsm-probe/pw/liststate.js`;截图 `liststate-{phone,desktop}-2.png`):

```
手机 393×894(列表页):默认 #listState hidden、0px;摆一个失败后 44px 的一行,
  红字「加载失败:HTTP 500:upstream 掉了」+ 右侧「重试」44×44,排在「加载更多…」上面;
  点「重试」→ 真发一次 /api/session(线上好好的)→ 那条自己收起来、50 个会话照旧、listError 清空
桌面 1366×900:同一行 23px 高,左边与表格左沿对齐(12px inset)
横向溢出:phone 393/393、desktop 1366/1366(都没多出来)
```

**回归**:`smoke.sh` 297 → **301**(四条:左栏那条 DOM 唯一 / `setupListState()` 接进 `init()`
且只接一次 / 失败记原因 + 控制台那条照旧 + 重试走 `reset` / 延迟 250ms 且 `setListLoading`
在 `loadSessions` 里配平 3 处);`ui-capabilities` 74 → **85**(夹具补上 `#listState`,fetch 桩加
一个「只失败一次」的开关:形状与接线、重复接线不挂监听、失败露原因 + `.bad` + 重试 + `listError`
留得住、点重试从头拉且带 `reset`(不带 `cursor`)、成功后收起来、列表填回去);其余 18 套与 6 个
`e2e-*` 全 0 失败。README 的计数与 `ui-capabilities-run.js` 那段同步;§10 第 9 条改成「已定」。

---

### 8.46 贴底从「盯时间」改成「盯高度」

**起因**:用户——「都行」(§10 第 7 条)。§8.36 的 `repinUntilStable` 里压着
`REPIN_BUDGET_MS = 800`:贴完底之后跟帧,跟到 800ms 就收手。那是拿时间赌「cvmany 的
离屏估值会在 800ms 内落定」。赌不赢的时候就是「贴了底,几百像素之后图才把布局撑开,
而采样早收手了,于是永远停在最新消息上面」。

**做法**(三条互补,判定源仍然是「还贴着底」`store.nearBottom` 一处):

| # | 干什么 | 为什么 |
|---|---|---|
| ① | `repinUntilStable` 的停止条件换成**高度连续 `REPIN_STABLE_FRAMES = 2` 帧没变** | 收手跟布局走,不跟钟走;估值落定实测 400ms 内,但没必要干等到那个数 |
| ② | 另起一个 `ResizeObserver`(`syncRepinWatch()` / `setupRepinWatch()`)盯 `#messages` 的**每个直接子元素** | 「迟到的东西」(图片解码 / 迟到的估值落定)可能在几秒后才把高度撑开,那是时间窗口接不住的。RO 空闲时零开销,也不用常驻 rAF 采样 |
| ③ | 观察名单在 `renderMessages()` 收尾时 sync 一次(新建 / 换掉的节点跟着换);回调里只要 `store.nearBottom` 就 `pinBottom()` + `updateJumpLatest(true)` | 名单不能漏节点,也不能攒着已经不在 DOM 里的节点 |

`REPIN_MAX_MS = 3000` 只当**自保**(内容一直在长 —— 流式输出 —— 时别把 rAF 挂到天荒地老),
不再当判定依据。另外补了一条 `REPIN_GESTURE_MS = 400`:用户自己点开 `<details>` 也会让内容
长高,那不是「迟到的东西」;刚点过 400ms 内不抢着贴(以前的时间预算天然躲开了这一类,
改成盯高度之后必须显式挡住)。

**验证**(真 Chromium,`/tmp/ocsm-probe/pw/repin.js`;只读长会话 `ses_demo_f…`):

```
手机 393×894:观察名单 31/31(== #messages 子元素)、cvmany=true、在底(0px)
  迟到撑开 500px(采样早收手之后)→ 离底 0px、按钮藏
  往上滚 400px 后 nearBottom=false → 再撑高 600px,scrollTop 8032 → 8032(一动不动)
  刚点过(gestureAt=now)撑高 → scrollTop 不追、离底 300px;过了那 400ms 再长 → 又贴回 0px
桌面 1366×900:同样的四条,名单 100/100
```

**回归**:`smoke.sh` 301 → **303**(R13 那两条跟着改:`REPIN_STABLE_FRAMES` / `REPIN_MAX_MS` 取代
`REPIN_BUDGET_MS`、停手条件加「高度稳住了」;新增两条:RO 那只眼(`syncRepinWatch` 接在
`renderMessages` 收尾、`setupRepinWatch` 接进 `init()`、刚点过那条)与 `ui-jump.html` 里那两组断言);
`ui-jump` 116 → **123**(收手条件、观察名单与子元素数一致、两条采样就收手(给 `pinBottom` 套一个
计数器)、迟到撑开也贴回、刚点过不抢、过了那 400ms 照旧贴);其余 18 套与 6 个 `e2e-*` 全 0 失败。
README 的两处计数与「贴完底再跟几帧」那段同步;§10 第 7 条改成「已定」。

---

### 8.47 SSE 里也摘掉同一批 `data:` 图

**起因**:用户——「都行」(§10 第 8 条)。§8.37 只在「消息列表」那一条响应上摘了
`data:` 图,但同一批字节还会**从 SSE 再走一遍**:`public/app.js` 在
`session.tool.success` 上写着 `p.state.content = d.content`。某次工具真返回图,
那【一个】事件就是 600KB 级 —— 面板一个字都不显示它(`toolOutputHtml()` 只取
`content[].text`),手机上是「这一下卡一下」。

**做法**:在 SSE 的透传中间插一个按【行】改写的 `Transform`:

| 件 | 内容 |
|---|---|
| `isEventStream(method, contentType)` | 按**内容类型**认(`GET` + `text/event-stream`),不按 URL 白名单 —— OpenCode 换路径也不用改代理 |
| `stripSseData(json)` | 只认 `type === 'session.tool.success'`(唯一带 `content` 的 tool 事件,`progress` 只有 metadata);`content[].uri` 是 `data:` 才摘,留 `name`/`mime` + `omitted` 字节数(与 §8.37 同一套语义) |
| `stripSseLine(line)` | 只认 `data:` 开头的行;解析失败 / 不是对象 / 没摘到 → **原样返回那一行字节** |
| `createSseStripper()` | 按 `\n` 切行、跨 chunk 用 `StringDecoder` 缓冲(**别把多字节汉字切坏**);`event:` / `:` 注释 / 心跳 / 空行 / 别的 `session.*` 一律原样;单行超 `SSE_MAX_LINE = 8MB` 还没换行就原样放出去(自保) |

接线在 `res.writeHead()` 之后、`nodeStream.pipe()` 那一处:`isEventStream()` 为真时走
`nodeStream.pipe(stripper).pipe(res)`,否则一个字都不动。**任何一步出错都退回原字节** ——
SSE 改坏了整条面板就瞎了,省流量不值这个价。

**验证**:两条互补的断言(都不需要「等一次真的读图回合」):

- `test/sse-strip-run.js`(45 项纯函数):只动那一个事件;注释 / 心跳 / `event:` / 坏 JSON /
  不是对象的 JSON / 没 `data:` 前缀的行原样;跨 chunk 的三种切法(整段一次喂、**按 1 字节切**、
  1/2/3/5/8/13/21/34 字节错开切)输出完全一致,**汉字没被切坏**,帧边界与 `\n\n` 一个不少,
  流被掐断(没有结尾换行)也照样处理,单行超 8MB 原样放出去、后面的帧照常。
- `test/sse-e2e-run.js`(16 项,**真起一份代理 + 一个假上游**;上游地址靠 PATH 里的假
  `opencode service status`,密码靠 `OPENCODE_CONFIG_DIR` 指向临时目录 —— 不碰线上那唯一的
  OpenCode):让 `session.tool.success` 背着 **600KB 的 `data:` 图**走一遍 SSE ——
  那一帧的图没了、整段掉到 5KB 以下;`server.connected` / 心跳 / 一个**身上也挂着 `data:` 的
  别的 `session.*`** / 半截 JSON 帧一个字节不动;而且**第一帧先到、结尾后到**(证明是按行改写,
  不是攒完再吐)。真机另跑了一遍:代理的 `/api/event` 与直连上游逐字节对比只差
  `server.connected` 的随机事件 id;正在跑的会话开 25s,连接、消息、工具卡一切照旧、控制台零错误。

**回归**:`smoke.sh` 303 → **307**(四条:`stripSseData`/`stripSseLine`/`createSseStripper`/
`isEventStream` 在且范围只认一个事件、只有 SSE 那条走按行改写且解析失败原样发、
`test/sse-strip-run.js` 在、`test/sse-e2e-run.js` 在);其余套件与 6 个 `e2e-*` 全 0 失败;
改了 `server.js` 要 `systemctl --user restart opencode-session-manager.service`(已重启)。
README 的测试清单与 §8.37 那段同步;§10 第 8 条改成「已定」。

---

### 8.48 手机上把标题行那枚「空闲 / 运行中」徽章也收掉

**起因**:用户——「改」+「删」(前者是这条:§8.43 之后我列出的最后一枚可瘦项 ——
标题行 `.chline` 里的 `#chatState`;后者是本地备份分支 `old-main`,已 `git branch -D`)。

**做法**:`html.narrow #chatState { display: none; }`,只收窄屏;桌面一字未动。

它说的三件事在手机上各有更直接的出口,所以收掉不丢信息:

| 状态 | 手机上从哪儿看 |
|---|---|
| `● 运行中` | 底部那条进度条(§8.30);底板收起时细边上还有「■ 中断」(§8.40) |
| `◌ 重试中` | 进度条的重试态(`paintProgressBar('retry')`,与这枚徽章同一个 `updateChatStatus()` 里画的) |
| `空闲` | 本来就是噪音 |

**验证**(真 Chromium 393×894,只读长会话):

```
改后(徽章收):#chatHeader 61  .chline 44  标题宽 237  #messages 785 @61
改前(徽章在):#chatHeader 61  .chline 44  标题宽 226  徽章 27×20  #messages 785 @61
宽屏:徽章 27×20 照旧(桌面没动)
```

诚实记一笔:纵向 **0px**(`.chline` 的高度是被「76% ctx」那格撑着的,徽章比它矮),
省下来的是**横向** —— 标题拿到 7px + 原 gap(实测 +11px),以及标题行不再三样挤在一起。

**回归**:`smoke.sh` 307 → **308**(一条:窄屏那条规则在 + `#chatState` 节点在);
`ui-mobile` 192 → **198**(两个视口各跑一遍:`C8k` 窄屏收掉、`C8k2` 标题照旧露着、
`D3g` 桌面它又回来);其余 18 套与 6 个 `e2e-*` 全 0 失败。README 计数与那两段同步。

---

### 8.49 diff 行内高亮(字符级)

**起因**:用户「实现看看」,批准了 diff 这一组的 1–4 项。这一项此前记在「明确不做」里
(对应 TUI 的 `diffHighlightAdded` / `diffHighlightRemoved`),做起来的实际代价比当时估的低得多 ——
不需要动渲染边界,只是在 `parsePatch()` 与 `diffRowHtml()` 之间加一层纯函数。

**做法**(三道纯函数,`public/app.js`):

| 函数 | 干什么 |
|---|---|
| `pairDiffRows(rows)` | 每个 hunk 里连续的删段 + 紧随的增段按位置配对(第 i 个 `-` 对第 i 个 `+`);落单的不点亮 |
| `hlRanges(a, b)` | 先剥公共前后缀,中段按**字符**做 LCS,对不上的字符下标并成区间;返回两侧各自的区间 |
| `paintHtml(text, ranges, spans)` | 按区间切开、逐段 `esc()`,变了的段包 `<span class="hl">`;第二参给 §8.50 的语法着色留了位置 |

**为什么是字符级**:手机上 diff 正文只有 ~330px 宽,行内改一个词(甚至一个标点)时,
词级高亮和整行底色几乎分不出来;字符级能直接把「哪个字变了」指出来。
代价是 LCS 的 O(n·m) —— 用三道上限兜住:

- 纯增 / 纯删(一侧中段为空):整段点亮,不算 LCS;
- 中段单侧 > 400 字,或两侧乘积 > 160000:整段点亮;
- 含代理对(emoji 等)的行:整行点亮(按 code unit 切会把一对切成两半,渲染成替换字符);
- 一张卡片最多算 2000 对(`HL_MAX_PAIRS`),大补丁剩下一律整行着色。

**观感**:`--hl-add-bg: #abf2bc` / `--hl-del-bg: #ffc0c0` 比整行底色再深一档(照 GitHub 的 word diff)。
行号列、符号列、`textContent`(**复制出来的文本**)、HTML 转义都不受影响 —— 亮起来的只是 `.src`
里多了一层 `<span>`,断言里专门锁了「点亮之后整行文字还是原文」。

**实测**(真实 `edit` 补丁:`fetch="."` 后面插了 `review="gerrit"`):删侧没有区间(没删字),
增侧只有 `[[33,49]]`(`review="gerrit" `);点亮前后 `.dl.add .src` 的 `textContent` 一字不差。

**回归**:`smoke.sh` 308 → **310**(样式两层:配色变量与 `.dl.add .hl`;代码一条:配对与 LCS 真接上了);
`ui-tools` 246 → **261**(15 项:`hlRanges` 的逐字 / 多段 / 纯增 / 纯删 / 相同 / 公共前后缀 / 空值 /
超长 / emoji,真补丁的删侧与增侧,`textContent` 与转义,行号不变);其余 18 套与 6 个 `e2e-*` 全 0 失败。

**后续**:同一层接着做语法着色(§8.50),以及桌面上的并排视图(§8.52)。

---

### 8.50 语法着色(零依赖、逐行)

**起因**:同一批的第 2 项。此前记在「明确不做」里(对应 TUI 的 `config.diffs.filetype` /
`syntaxStyle`),真做起来只是一层分词器 + 四个颜色变量,不需要动渲染结构。

**做法**(`public/app.js`):

| 函数 | 干什么 |
|---|---|
| `langOf(path)` | 扩展名 → 语言(js/ts/json/go/rs/c/h/sh/py/css/md/html 与常见别名);认不出返回空串 |
| `syntaxSpans(text, lang)` | 一行 → `[{s, e, cls}]`,cls 是 `com` / `str` / `num` / `kw` 四类之一 |
| `synScanCode` / `synScanMd` / `synScanHtml` | 三套扫描器:代码类共用一套,markdown / html 各一个小函数 |

`paintHtml(text, ranges, spans)` 把「变了的区间」(§8.49)与「语法区间」的边界并在一起切段,
每段同时决定要不要包 `.hl`(外层)与 `.tk <cls>`(内层)—— 两套高亮互不打结。

**认哪些**:js/mjs/cjs/jsx、ts/tsx/mts/cts、json/jsonc/json5、go、rs、c/cpp/cc/cxx/h/hpp、sh/bash/zsh/ksh、
py/pyi、css/scss/less、md/markdown/mdx、html/htm/xml/svg/vue;其余一律纯文本,**不猜**。
`write` 的正文同样按路径上色(`codeHtml(text, path)`)。

**逐行是刻意的**:diff 的 hunk 会跳行,跨行的块注释本来就对不上,假装能追反而会整块染错;
代价是「块注释从上一行延续下来」这几行不会被认成注释 —— 记在这里,不修。

**已知不完美**(都是观感,不影响正确性):

- shell 的 `$#` / `${#x}` 不会被当成注释(判据是 `#` 前面得是空白或 `;|&(`);
- JS 模板字符串里的 `${…}` 不单独分词(整段当字符串);
- Rust 的生命周期 `'a` 不当字符串(Rust 只认双引号);
- markdown 只认标题行与行内代码,表格 / 强调 / 链接不染;
- html 只认注释、标签名、属性值。

**实测**(真面板里同样的 `src/api/session.ts` diff):关键字红、字符串深蓝、数字蓝、注释灰斜体;
行内高亮(§8.49)仍然压在语法色上面,`const` 那一整词既被点亮又是关键字色,嵌套顺序对。

**回归**:`smoke.sh` 310 → **312**(样式:`--syn-*` 与 `.src .tk.*`;代码:`langOf`/`syntaxSpans`
同时接在 diff 与 write 正文两条路上);`ui-tools` 261 → **282**(21 项:扩展名表与「不认识的就不猜」、
四类区间、字符串里的关键字不误判、转义引号、行注释与块注释、shell 的 `$#`、CSS 属性与十六进制颜色、
markdown、html、两套高亮叠加的嵌套顺序、hunk 不上色、`write` 给了路径才上色且文字不变、字符串里的 HTML 转义)。

**后续**:桌面上的并排视图(§8.52)。

---

### 8.51 逐文件 revert:API 没有这个口子,不做假按钮

**起因**:同一批的第 3 项。原计划是「先探 API,不支持就只保留现有的整轮撤销并说明」。

**探到的**(`@opencode-ai/sdk@1.17.18` 的生成类型,`dist/v2/gen/types.gen.d.ts`):

| 端点 | 请求体 | 说明 |
|---|---|---|
| `POST /api/session/:id/revert/stage` | `{ messageID: string, files?: boolean }` | 暂存一个可回退的会话边界,`files` 表示顺带还原该轮文件改动 |
| `POST /api/session/:id/revert/clear` | 无 | 清掉暂存的撤销 |
| `POST /api/session/:id/revert/commit` | 无 | 提交暂存的撤销 |

`RevertState` 里虽然有 `partID` 字段,但**请求体只收 `messageID` + `files`** ——
没有任何「只还原某个文件」的参数。也就是说,逐文件 revert 不是面板没画,是服务端没有这个动作。

**所以**:不加假按钮、不发夹带 `partID` 的请求去赌 zod 会放过未知字段。面板保持现状:

- 整轮撤销:`/undo`(=`revert/stage {messageID, files:true}`,回退对话边界 + 还原该轮文件改动);
- 重做:`/redo`(`DELETE /api/session/:id/revert`,409 当作「没有可重做的撤销」)。

**顺带记一笔**:`GET /api/session/:id/diff?from=&to=&context=` 能按轮次给出结构化的逐文件 diff
(TUI 的「变更」面板就建在它上面)。面板当时没做独立面板,是因为**每张 `edit`/`patch` 卡片已经是按文件的**,
再开一页只是把同样的内容重新列一遍 —— **已在 §8.57 改掉**:它不是把卡片再列一遍,而是服务端按 turn
的 idle 快照算出的净变更(同一轮里改了多次只算最终结果,shell 命令改的也算),所以值得单独看。

**回归**:纯文档,无代码改动;全量回归照跑(基线 312 / 282 / 249 / …)。

---

### 8.52 并排视图(只做桌面,按卡片切换)

**起因**:同一批的第 4 项;用户批的范围是「1-4;并排只做桌面,看看效果如何」。

**做法**:

| 位置 | 内容 |
|---|---|
| `splitRowsHtml(rows, lang)` | 同一 hunk 里连续的删段与紧随的增段按位置左右对齐;上下文 / hunk / meta 行整行跨两栏;一侧落单就给对面留一个空单元格 |
| `splitCellHtml(r, lang, side)` | 单个半栏:自己的行号 + 符号 + 源码(行内高亮与语法色照旧) |
| `diffViews` | `Map`,key = `partID#文件序号`,value = `'split'`;**只记在当前页面**,刷新回统一视图(没有持久化,和 TUI 的 `config.diffs.view` 不同)——**已被 §8.53 改掉** |
| `.dfile` 里的 `.dswap` | 「⇆ 并排」按钮,`data-pid` / `data-fi` 指向那张卡;激活时加 `.on` |
| `#messages` 上的点击委托 | `setupDiffView()` → `toggleDiffView(btn)`:翻转状态,然后用 `toolHtml(p)` **只重画这一张卡片**(不整表重绘,别处摊开的 `<details>` 不会被搬一遍) |

CSS 用 `grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)`,中间一条竖线;每侧
`overflow-x: auto` 各自横向滚动(与当时统一视图「不折行、横向滚动」同一条原则;
统一视图已在 §8.58 改成折行,分栏在 §8.53 也已改成逐侧折行)。

**为什么只桌面**:393px 竖屏切成两栏是两条 ~190px,长路径与缩进都看不全,比统一视图更差。
判定源仍然只有 `<html>.narrow` 一处:

- 渲染时 `!narrow` 才出两栏(窄屏直接按统一视图生成,不是靠 CSS 藏);
- `html.narrow .dswap { display: none; }` —— 按钮在窄屏根本不露;
- 窗口从桌面缩到窄屏档时,`html.narrow .diff.split .dl.pair { display: block; }`
  让遗留的两栏退回上下两段(空单元格直接隐藏),不至于把页面挤坏。

**实测**(真 Chromium,1366×900 与 393×894):

```
desktop-split   narrow=false split=true  btn=true  btnShown=block pairs=2
desktop-unified narrow=false split=false btn=true  btnShown=block pairs=0
phone-393       narrow=true  split=false btn=true  btnShown=none  pairs=0
```

真会话里点按钮(part `call_00_ET_nmz…`):点击前 `split=false`、18 行统一视图;点击后
`split=true`、4 对左右对齐、按钮文字「⇆ 并排」;再点回来恢复统一视图。行号两栏各是各的
(197-/197+、198-/198+),上下文行与 `@@` 行整行跨两栏。

**回归**:`smoke.sh` 312 → **314**(样式:`.dl.pair` 两栏骨架 + 窄屏收掉 `.dswap`;
代码:`splitRowsHtml` / `setupDiffView` / `diffHtml(files, { pid })` / init 接线);
`ui-tools` 282 → **297**(15 项:两栏结构、左右行号、落单空单元格、纯新增左空右新、
上下文整行跨栏、高亮与语法色进两栏、按钮与 `.on`、无 pid 仍是统一视图、窄屏强制统一、
真点击换形态再点回来);其余 18 套与 6 个 `e2e-*` 全 0 失败。

**已知**:每侧独立横向滚动,长行会在分栏处截断(横向能滚,但不是折行);
切换状态不持久化 —— 要跟 TUI 那样记住,需要定一个键名与作用域,留给下一轮。

**后续(§8.53)**:用户一句「反正向TUI对齐」,把上面两条「已知」都收了 ——
偏好改成全局持久(TUI 的 `diffs.view`),分栏长行改成折行(TUI 的 `wrapMode="char"`),
并且只有 `modified` 的文件才分栏。做法与实测见下一节。

---

### 8.53 并排偏好照 TUI 收口:全局持久 + auto + 只有 modified 分栏 + 分栏折行

**起因**:§8.52 落地后我列了两个可选项(要不要持久化、分栏长行要不要折行),用户回「反正向TUI对齐」。

**先看 TUI 到底怎么做的**(`packages/tui/src/feature-plugins/system/diff-viewer.tsx` 与 CLI 配置文档):

| TUI 的行为 | 依据 |
|---|---|
| `diffs.view` 三档 `auto` / `split` / `unified`,是**全局偏好** | `~/.config/opencode/cli.json` 的 `diffs.view` |
| `auto` = 面板够宽才并排,阈值 `MIN_SPLIT_WIDTH = 100`(终端格) | 源码常量;`splitAvailable()` 与 `view()` |
| 切换键 `diff.toggle_view` 写回偏好(`onPreferencesChange({ view: next })`) | 同一文件的 commands 表 |
| 只有 `status === "modified"` 的文件分栏,`added` / `deleted` 一律统一视图 | `view={entry.file.status === "modified" ? view() : "unified"}` |
| 长行 `wrapMode="char"`:按字符折行,不是每侧横向滚 | `PatchDiff … wrapMode="char"` |

**面板怎么落地**:

| 位置 | 现在的行为 |
|---|---|
| `DIFF_VIEW_KEY = 'ocs.diffView'` | 全局偏好;真正的账在 TUI 的 `cli.json` 的 `diffs.view`(§8.60),`localStorage` 只当首屏缓存 |
| `DIFF_SPLIT_MIN_PX = 760` | 100 格 × 约 7.6px(面板等宽字体 0.92 × 14px);量 `#messages.clientWidth` |
| `diffViewWanted(status, pref, wide)` | 纯判定:`modified` + 够宽 + 偏好不是 `unified` 才分栏 |
| `diffViewSet()` + 全局重画 | 点任一卡片上的「⇆ 并排」= 写偏好(PATCH 回 `cli.json`),然后把消息里**所有** diff 卡片一起重画;被点的那张按滚动差补偿,留在原处 |
| `syncDiffWidth()` + `ResizeObserver` | auto 档随面板宽度重算(窗口缩放、拖分栏条),只在「够不够宽」翻面时重画;120ms 防抖 |
| 窄屏 | `<html>.narrow` 仍然一票否决(渲染成统一视图 + CSS 收掉按钮)—— 手机的横屏 894px 虽然「够宽」,但 `short` 档下切两栏同样没意义 |

**已经收掉(§8.60)**:面板不再只记自己的 `localStorage` —— 首屏读 TUI 的
`~/.config/opencode/cli.json` 的 `diffs.view`,点「⇆ 并排」时 PATCH 回同一个字段;
TUI 在那边改了,面板借 15s 一次的 `/__health` 跟上。`localStorage` 只当首屏缓存与
服务端不可达时的退路;§8.60 有完整取舍。

**实测**(真会话 `ses_demo_e…`,探针跑两趟抓到 24~34 张 diff 卡片 —— 流式会话里
渲染窗口内的卡片数会变;探针 `/tmp/ocsm-probe/pw/pref-split.js`):

```
1366×900(auto,偏好空)  聊天区 790px              → 全部卡片分栏
点一下第一张                                   → 全部转统一,localStorage=unified(约 340~490ms)
刷新                                          → 仍是 unified(偏好真的落盘了)
再点一下                                       → 全部转分栏,localStorage=split
再刷新                                        → 仍是 split
1100×900(auto,偏好空)  聊天区 524px < 760        → 统一视图
1100 → 拖到 1366(不刷新) 聊天区 790px              → auto 当场把卡片全变分栏
393×894(narrow)                               → 统一视图,按钮 display:none
分栏 .side / 跨栏 .dl                         → white-space:pre-wrap、overflow-wrap:anywhere,
                                                scrollWidth == clientWidth,.diff 横向溢出 0
```

第一次只给 `.side` 加了折行,`.diff` 的 `scrollWidth - clientWidth` 还有 3741px ——
跨两栏的 hunk / 上下文行(`.dl.ctx`、`.dl.hunk`)还是 `white-space: pre`,一条长上下文就能把整块顶出去。
补 `.diff.split .dl { white-space: pre-wrap; overflow-wrap: anywhere; }` 之后归零。

一次切换几十张卡片当时约 340~490ms(每张都要重新生成整卡 HTML)。并排/统一是低频操作,当时
先没加「只换 diff 正文」的分支;§8.62 已经补上。

分栏正文折行后,左右两栏的行高由较长的那一侧决定;`pre-wrap` 保留缩进,`overflow-wrap: anywhere`
把超长 token 断开(终端里就是 `wrapMode="char"` 的效果)。

**回归**:`smoke.sh` 314 → **316**(样式:分栏折行且跨栏行也折行、没有逐侧横向滚;代码:偏好是
全局持久的、auto 阈值在、宽度变化会重算、没有按卡片的 `diffViews`);`ui-tools` 297 → **305**
(重写并排那组:`diffViewWanted` 的三态、只有 modified、不够宽不分栏、`added` 文件不跟着分栏、
偏好写进 localStorage、两张卡片一起切换、面板变窄/变宽时 auto 翻面);`ui-stream` 249 不变
(那套老断言的 diff 是统一视图,开头把偏好钉成 `unified`);其余 17 套与 6 个 `e2e-*` 全 0 失败。

### 8.54 慢网(VPN)下「正在加载消息…」一直挂着:压缩 + 对账只认当前会话 + 后台静默

**起因**:用户从 `192.0.2.x` 网段经 VPN 访问面板,「一直显示正在加载信息」,要求像手机端那样优化。

**先复现,再动手**(`/tmp/ocsm-probe/pw/slow-load.js`,Chromium CDP 限速,桌面 1366×900,深链到
`ses_demo_c…`,该会话 100 条消息原文 1.03MB):

```
2 Mbps / 150ms RTT
  msgs≥3 可见        30 500 ms
  /message 请求      7 条(每条都是完整 1.03MB)
  总传输             6 639 511 B
  「正在加载消息…」   从头挂到尾
```

**根因有两层,缺一不可**:

1. **每条 SSE 事件都重拉一次**.`handleEvent` 原来无条件排
   `setTimeout(loadMessages, 150)` + `setTimeout(loadSessions, 1500)`,连 `provider.updated` /
   `model.updated` 这种与消息无关的全局事件也算。实测一次首屏里来了 11 条 SSE,于是 7 条消息请求
   同时排队 —— 面板没有 AbortController,旧的那条只靠 `store.msgSeq` 在回来时丢弃,**带宽已经花掉了**。
   每次重拉又都 `setMsgLoading(true)`,所以状态行永远撤不掉。
2. **响应完全不压**.代理一直用 `accept-encoding: identity` 去上游,给浏览器也是明文:
   `app.js` 286KB、`styles.css` 61KB、首页 15KB、会话列表 27KB、消息列表 0.5~1MB。
   VPN 上这些体积直接把 RTT 之外的时间拉满。

**改法**:

| 位置 | 行为 |
|---|---|
| `server.js` `acceptedEncoding()` / `encodeBody()` | 认 `br`(优先,q5)与 `gzip`(兜底);只看客户端 `Accept-Encoding`,不猜 |
| 静态资源 | `encodeStatic()` 按「文件 + ETag + 编码」缓存压缩结果,发 `Content-Encoding` / `Content-Length` / `Vary: accept-encoding`;304 也带 `Vary` |
| API 的 GET JSON | 统一先缓冲再压(≥1KB 才压);消息列表仍然先摘 `data:` 图;SSE(`text/event-stream`)一步都不碰 |
| `app.js` 事件分流 | 消息对账 = `mine`(事件里的 `sessionID` / `info.id` 等于当前选中;没带 id 才按「可能是」放行)且类型属于 `session.*` / `message.*`,并排除 `session.updated/created/deleted/…` 与高频的 `tool.progress`、`tool.input.delta`、`compaction.delta` |
| 列表刷新 | 只认 `session.created/updated/deleted/renamed/moved/agent.selected/model.selected` 与 shell 三类;`server.connected` 只在**重连**时补一次 |
| 单飞 + 合并 | `MSG_AUTO_GAP_MS = 4000` / `SESSION_AUTO_GAP_MS = 2500`(§8.67 起消息对账改为内网 800 / 慢链路 4000):同一时刻只飞一条;飞着时再来的只记一个 `queued`,落地后再隔一个间隔补一次 |
| 后台静默 | `loadMessages({auto:true})` 不点 `#msgState`、失败不画错误页(只进控制台);`loadSessions({auto:true})` 同理 |
| 前台优先 | 切会话 / 点重试走非 auto:`AbortController` 直接掐掉在飞的自动对账,`msgLoadGen` 保证被取代那一代的 `finally` 不回写状态 |
| 轮询兜底 | `loadActive` 的 8s 轮询只在「最近 12s 没有对过账」时才拉消息,避免盯着一个运行中的会话时每 8s 白拉一次 |
| 页大小 | 桌面 100 / 手机 30 **都不动**;这轮只省「无谓的重复」和「传输体积」,不牺牲一次能回看的历史 |

**实测(同一套探针,同一会话)**:

```
2 Mbps / 150ms RTT
  msgs≥3 可见        30 500 → 2 535 ms
  /message 请求      7 → 1
  总传输             6 639 511 → 345 101 B
  「正在加载消息…」   全程 → 只有首屏那一下(2485ms 时撤)

1 Mbps / 300ms RTT,ses_demo_e…(734KB)
  msgs≥3 可见        4 147 ms,总传输 295 922 B,消息请求 1 条

后台行为(slow-events.js,真页面):
  连发 20 条 provider.updated/model.updated → 新增消息请求 0
  手动切到另一个会话(正在运行)                → 新增消息请求 1
  强制一次 auto 对账                          → #msgState 全程未露面
```

**取舍**:

- 后台对账最多晚 4s 才把「权威版本」拉回来;这期间 SSE 的本地渲染照常逐帧更新,所以看内容不卡,
  只是最终对账慢一点。LAN 上本来也看不见这个差别(§8.67 已把内网这段缩到 800ms,慢链路仍 4s)。
- 压缩在代理的事件循环里同步做:1MB JSON 的 br q5 约 14ms、gzip 约 9ms;静态文件压过一次就缓存。
  选 q5 不选 q9,是因为 q9 只再小 3%,耗时却从 14ms 涨到 44ms。
- 没有做消息缓存 / 分页改版:切到一个 1MB 的会话仍要下一次(现在约 224KB);真要再快得动存储与协议。
- 没有把「后台对账」彻底删掉:SSE 丢帧、断线重连、工具最终 metadata 这些还得靠它兜底。

**回归**:`smoke.sh` 316 → **320**(静态 br、会话列表 gzip、消息列表 br 的体积对比,SSE 不被压);
`ui-stream` 249 → **258**(事件分流 5 项 + 后台对账 4 项:不闪 250ms 状态行、飞行中合并成一条、
落地后隔 `MSG_AUTO_GAP_MS` 再排、前台照旧会闪);`ui-tools` 305 不变;其余 17 套与 6 个 `e2e-*` 全 0 失败。

---

### 8.55 慢链路桌面首屏 30 条 + 切回看过的会话先用内存缓存顶上

**起因**:§8.54 把慢网首屏从 30.5s 压到 2.5s,但桌面 100 条仍要一趟(压缩后约 224KB);
而且切回刚看过的会话要重新拉、整片空着等。用户要求:慢链路下桌面首屏也降到手机同档
(30–50 条,往上滚再拉更旧);切回看过的会话先用内存里的旧内容顶上,再后台对账。

**做法**:

| 位置 | 行为 |
|---|---|
| 慢链路判定 | `noteNetSample()` 量第一次 `/api/session` 那一趟的往返(含 RTT + 传输 + 解析),≥ `SLOW_SAMPLE_MS = 180` 记 `store.netSlow`;内网通常 < 20ms,VPN 200ms 起步,中间空得很。`navigator.connection` 的 2g/3g、`rtt ≥ 400` 当旁证。只在本页生效,刷新/回到内网重新量 |
| 页大小 | `msgPageSize()`:窄屏 **或** 实测慢链路 → 30,否则 100;首屏与翻页仍共用这一个口径 |
| 往上滚 | `autoLoadOlder()` 的入口从 `if (!narrow) return` 改成 `!narrow && !slowLink()`;慢链路桌面滚到顶自动带更旧一页(仍走同一个 cursor)。LAN 桌面照旧不接管 |
| 内存缓存 | `store.msgCache`(Map,最多 `MSG_CACHE_MAX = 6` 个会话);切走 / 取消选中时 `cacheCurrentMessages()` 快照 `{messages, cursor, at}`,失败态不存;切回时先 `renderMessages()` 再后台对账,不空着等 |
| 对账 | 缓存超过 `MSG_CACHE_FRESH_MS = 1500` 才发一次 `loadMessages({auto:true, now:true})`:quiet 不亮状态行、绕过 4s 间隔、掐掉在飞的旧请求;≤1.5s 的来回切直接省掉一条 |
| 删除 | 删会话时 `store.msgCache.delete(id)`(放在 `clearSelection()` 之后,否则它又会先快照一次) |

**实测**(`/tmp/ocsm-probe/pw/slow-cache.js`,真页面 1366×900、Chromium CDP 限速、真会话):

```
2 Mbps / 150ms RTT
  首屏        store.netSlow=true,/message?limit=30,30 条
  滚到顶      自动 +1 条 /message?limit=30&cursor=…(59 条上屏)
  切回 A      同步 89ms 就出 59 条(cursor 也恢复),状态行未露面,后台对账 1 条

LAN
  首屏        store.netSlow=false,limit=100,97 条
  滚到顶      不发(桌面 LAN 的翻旧仍走按钮,行为不变)
  切回 A      同步 124ms 出 97 条,后台对账 1 条
```

**取舍**:

- 慢链路只看首屏会话列表那一趟,不看消息体积:2 Mbps/150ms 下列表约 200ms → 慢;
  10 Mbps/150ms 下约 160ms → 不慢,那一页 224KB 约 0.2s,可以接受。误判成慢只会少显示 70 条
  (往上滚就有),不会丢消息。
- 缓存只活在这个标签页的 JS 堆里,不落 `localStorage` / `sessionStorage`:刷新、换标签页都要重拉
  (内容可能很长,也不该持久到磁盘)。
- 最多 6 个会话,按切走顺序丢最旧;没有按字节数淘汰(6 × 100 条在本机是几 MB 级)。
- 缓存命中仍会对账,权威数据最后一定覆盖;只有 1.5s 内的来回切省掉这一条(这期间 SSE 真到了
  还会再补)。后台对账最多晚 4s 的那条 §8.54 取舍不变。
- 桌面 LAN 的 100 条、滚到顶不自动翻旧都保持原样;慢链路桌面例外,因为它本来就是「少拉一点、
  多滚一次」。

**回归**:`smoke.sh` 320 → **322**(页大小口径改成 `narrow || slowLink()`,加慢链路 /
内存缓存两组代码锁);`ui-jump` 123 → **135**(12 项:慢链路桌面 30 条、请求真的 `limit=30`、
滚顶自动翻旧;缓存先出内容、不闪加载行、对账只 1 条、热缓存不发、上限 6 等);
`ui-layout` 184 → **185**(删除即清缓存);`ui-stream` 258、`ui-tools` 305 不变;
其余套件与 6 个 `e2e-*` 全 0 失败。

### 8.56 新建 worktree:照 TUI 的 Name worktree,在「+ 新建」里顺手建一个

**起因**:TUI 的 `Worktrees` 对话框能看到工程已有的 worktree、选中、删除,以及「新建」;
新建时先弹 `Name worktree`(输入名字,或按一下生成 `adjective-noun`),再
`client.api.worktree.create({ projectID, name })`,最后拿返回的 `directory` 当新会话的位置。
面板此前完全没有 worktree 概念。用户要求把这一步补上。

**做法**:

| 位置 | 行为 |
|---|---|
| 入口 | 「+ 新建」里一个**默认不勾**的复选框「在 worktree 中新建」;勾上才露出名字行与说明。不勾时对话框与原来一模一样(桌面主界面三栏更是没动) |
| 名字 | `wtSlugify()` 照 TUI 的 `slugify`:`trim` → 小写 → 非字母数字变 `-` → 掐掉首尾 `-`。勾上时自动填 `wtSlug()`,照 TUI `Slug.create()` 的 29 个形容词 × 31 个名词;「生成」再换一个;留空则在提交前随机 |
| 解析工程 | `GET /api/location?location[directory]=<源目录>` → `project.id`;`POST /api/worktree` 只收 `projectID`,不认目录 |
| 创建 | `POST /api/worktree {projectID, name}` → `{directory}`。服务端按工程的 worktree 配置(默认 `~/.local/share/opencode/worktree/<短 projectID>/<name>`)建目录/分支,并跑工程的 setup;这些都在服务端,面板不重复实现 |
| 会话 | 用返回的目录 `POST /api/session {location:{directory}}`;源目录与 worktree 目录都进 `store.seenDirs`,下次目录下拉里直接有 |
| 失败 | 不建会话,对话框不关;错误取 `data.message`(worktree / location 的错误体是 tagged error,顶层没有 `message`,只看顶层会退化成「HTTP 400」),显示 `worktree 创建失败:<服务端原话>` |
| 重试 | worktree 建好、会话 POST 失败(手机上断一下很常见)时,把 `{源目录, 名字, 返回目录}` 挂在 `#dlgNew.dataset`;源目录与名字都没变就复用,不建第二棵。关对话框 / 换名字 / 换源目录即作废。错误文案此时不再冒充 worktree 失败 |
| 范围 | 这一版只做「新建」;列出 / 删除 worktree、把已有会话移进 worktree 后来在 §8.61 补齐 |

**实测**(真页面 1366×900,源 `/tmp/ocsm-probe/wt-demo` 临时 git 仓库):

```
勾选         名字行 + 说明露出,自动名 neon-mountain
输入大写/符号  PROBE-WT-…!! → probe-wt-…(客户端先归一化)
解析工程      /api/location?location[directory]=/tmp/ocsm-probe/wt-demo → projectID
创建          /api/worktree {projectID, name} → /home/…/worktree/80d169/probe-wt-…
会话          location.directory = 该 worktree;顶栏仍是 1366×47,主界面尺寸没变
非 git 目录    worktree 创建失败:Worktree source not found: /tmp
              对话框不关、按钮恢复可点、会话数 50 → 50(没有偷偷建会话)
```

对话框自身:桌面收起态 420px 宽、勾开后 535px(说明那行撑的),都在 `min(92vw, 660px)` 内;
手机 393px 下收起 / 勾开都是 369px,`scrollWidth === clientWidth`,复选框整行 44px 高。

**取舍**:

- **不传 `from`**:TUI 也只传 `{projectID, name}`,源 checkout 由服务端的工程记录决定;面板里
  填的源目录只用来解析 `projectID`,不偷偷改变 worktree 的来源。
- **这一版只做新建**:TUI 的 `Worktrees` 对话框还带「有改动时二次确认 + force 删除」,以及把
  会话移进去的路由切换;面板的主入口是「+ 新建」,先接通最常用的一步,不摆只能看不能用的
  按钮。后半段已在 §8.61 用 `/worktrees` 补齐。
- **名字先在客户端归一化**:少一次「非法字符 → 400」的往返;但重名、非 git、setup 失败
  仍以服务端为准,面板只负责把原话带到对话框里。
- **勾选后才改变对话框高度**:默认态一个像素没变;桌面主布局、三栏网格、会话表都没有动。
- `api()` 顺手认 `data.message`:只补错误文案的取值,成功路径不动。

**回归**:`smoke.sh` 322 → **327**(5 项:开关与默认收起 / 手机 44px / 名字规则 / 接口接线与
失败文案 / 失败后的原地重试凭据);`ui-capabilities` 85 → **101**(16 项:默认态、名字规则、
随机名、勾选露出、自动名、解析工程、POST worktree、会话目录、目录记忆、自动选中、留空随机、
失败不建会话、`data.message`、会话失败不重复建 worktree、重试复用同一目录、重试的会话体);
`ui-jump` 135、`ui-layout` 185、`ui-stream` 258、`ui-tools` 305、`ui-mobile` 198 不变;
全量套件与 6 个 `e2e-*` 全 0 失败。

---

### 8.57 变更总览:照 TUI 的 `/diff` 接「最近一轮」

**起因**:TUI 对齐清单里「独立变更总览」这一项。§8.51 当时判断「每张 `edit`/`patch` 卡片已经按文件
列出来了,再开一页是重复」;用户随后说继续,于是按 TUI 的 `/diff` 接上 —— 它不是把卡片再列一遍,
而是服务端按 **turn 的 idle 快照**算出的净变更:同一轮里同一文件改了多次只算最终结果,shell 命令
改的文件也能算进来(卡片只认 `edit`/`patch` 的 metadata)。

**API**(`GET /api/session/:id/diff`,OpenAPI `session.diff`):

| 参数 | 行为 |
|---|---|
| 不带 | 默认「最新一条用户消息那一轮」= TUI diff viewer 的 **Last turn** |
| `from` / `to` | 指定轮次 / 范围;这一轮没用。整轮还在跑时没有收尾快照,返回空 |
| `context` | 每个 hunk 的上下文行数;面板固定 `3`,别把整文件补丁拉下来 |
| 返回 | `{data: FileDiff.Info[]}`,每项 `file / patch / additions / deletions / status` |

**做法**:

| 位置 | 内容 |
|---|---|
| 入口 | `/diff`(TUI 的 slash 同名)+ 命令面板(`PANEL_COMMANDS`);不加聊天头部按钮 —— 桌面主布局一字不动 |
| `#dlgDiff` | 标题「变更 · 最近一轮」+ `#diffStat`(`N 个文件 · +X -Y`)+ `#diffBody` + `#diffErr` + 关闭 / 刷新 |
| `#diffBody` | 直接 `diffHtml(files)`:文件徽标 / 路径 / 增删 / 行号 / 行内高亮 / 语法色 / 并排偏好全部复用;不传 `pid`,框里不出「⇆ 并排」按钮 |
| 宽度 | 桌面 `min(92vw, 980px)`,正文 `max-height: min(62vh, 680px)` 自己滚;`html.narrow` 下整宽(`100vw - 24px`),正文 `max(120px, 100vh - 230px)` |
| 并发 | `diffSeq`:刷新 / 切会话后旧响应作废;关框也 `diffSeq++` |
| 空态 | 没有变更 → 「最近一轮没有文件变更。」;会话在跑且空 → 「最近一轮还在跑;这轮改了文件的话,结束后点「刷新」。」 |
| 失败 | `#diffErr` 显示「加载变更失败: <服务端原话>」,正文清空;「刷新」重试 |

**实测**(真会话 `ses_demo_f…`,最近一轮新增 1 个 131 行的 YAML;只读选中,没发消息 / 改文件):

```
桌面 1366×900   框 980×650,正文 942×558,scrollHeight 2677;状态 1 个文件 · +131 -0
手机 393×894    框 369×772,正文 339×664,docScrollWidth 393(不横向溢出)
横屏 894×393    框 822×335,正文 784×244(894 宽不算 narrow,按桌面档)
```

截图:`/tmp/ocsm-probe/pw/diff-desktop.png`、`diff-portrait.png`、`diff-landscape.png`。

**取舍**:

- **只接 Last turn**:TUI 的 diff viewer 还有 `branch` / `working` / `committed` 三档、文件树、
  逐文件 reviewed 标记;这些要各自的 VCS 接口与一套全屏导航,这一轮先不摆半套。面板的用法是
  「刚跑完这一轮改了什么,看一眼」,Last turn 正好。
- **不传 `from`/`to`**:整会话净变更会把中间改过又撤回的文件也抹掉,反而不如「最近一轮」直观;
  真要跨轮汇总再加。
- **不新增头部按钮**:手机上 `#chatOps` 本来就整行收起,`/diff` 在竖屏也能敲;桌面主布局不动。
- **正文折行**:§8.57 当时还沿用统一视图的横向滚(手机竖屏上路径会被截断);这一项已在
  §8.58 收掉,统一视图改为按字符折行,免得把「统一视图折行」和「变更总览」混成一笔。

**回归**:`smoke.sh` 327 → **331**(4 项:框与窄屏样式 / 接口与 `diffHtml` 复用 / `/diff` 命令与
旧响应防护 / 测试文件断言);`ui-capabilities` 101 → **112**(11 项:请求、渲染、统计、无并排按钮、
命令、`/diff` 解析、空结果、运行中空结果、失败、刷新、没选中)。其余套件计数不变;全量回归 0 失败。

---

### 8.58 统一视图长行折行(照 TUI 的 `wrapMode="char"`)

**起因**:TUI 对齐剩下的已知差异之一:并排视图在 §8.53 已经逐侧折行,统一视图还挂着
`white-space: pre` + `.diff { overflow-x: auto }`,手机竖屏看 diff 要左右拖着读。用户这轮
直接点了「1-4」,这是第 1 项。

**做法**:

| 位置 | 改动 |
|---|---|
| `.dl` | `white-space: pre-wrap` + `overflow-wrap: anywhere`(原 `white-space: pre`) —— 统一视图与分栏共用的行骨架一起折 |
| `.dl .src` | 补 `min-width: 0`,flex 子项才肯缩到容器宽度以内,不会把 `.diff` 撑宽 |
| `.diff` | 保留 `overflow-x: auto` 只当超长 token 的兜底;正常折行后没有横向滚动 |
| `.diff.split` | 原有的逐侧 `pre-wrap` / 跨栏行规则不动(§8.53) |
| `.diff.code`(`write` 正文) | 跟着一起折 —— 它也是统一视图,长行同样不该横向拖 |

行号列(`.ln.o` / `.ln.n`)与符号列都是 `flex: none` 的固定宽,折行后留在第一行;
续行从源码列起始位置排,跟代码缩进对齐。

**实测**(真会话 `ses_demo_f…`,同一个 131 行 YAML,393×894 的变更总览框):

```
折行前  正文 client/scroll 337/337,scrollHeight 2677
折行后  正文 client/scroll 337/337,scrollHeight 3934(行变多、高度长了,宽度一像素没多)
```

桌面 1366×900 与横屏 894×393 的 `scrollWidth === clientWidth` 也不变;截图更新在
`/tmp/ocsm-probe/pw/diff-portrait.png`。

**取舍**:

- **不按语言/文件类型开关**:TUI 的 `wrapMode="char"` 就是无条件折行;面板不另造一个
  「只有 markdown 才折」的分支。
- **不顺手改代码块**:`pre` 代码块仍横向滚 —— 那是 Markdown 正文,不在 diff 的渲染路径上,
  这一笔只收 diff。
- **折行不等于丢行号**:续行没有行号是正常的(一行源码只对应一个行号),别为了对齐给续行
  补空号或缩进字符。

**回归**:`smoke.sh` 331 → **333**(2 项:全局 `.dl` 的 `pre-wrap` / `anywhere` 与 `.src`
`min-width: 0`;`ui-tools.html` 里折行 / 不撑宽 / 行号断言在);`ui-tools` 305 → **308**
(3 项:长行真的折、`.src` 不撑宽、`added` 行的新行号仍在第一行)。其余套件计数不变;
全量回归 0 失败。

---

### 8.59 最近会话标签栏(聊天区顶部,左列表保留)

**起因**:用户给了一张 TUI 的横向会话 tab 截图,问「能不能实现这种效果」;确认采用默认方案:
tab 栏放在**聊天区顶部**,**左列表保留**,手机竖屏也显示。其余默认:打开过的会话自动进 tab、
点 tab 直切、`×` 只移出 tab(不归档不删除)、当前 tab 关掉切右/左邻居、最右 `+ 新建` 复用现有
新建框、最多 8 个、默认按打开顺序(§8.94 可拖拽调整)、存 `localStorage`。

**行为**:

| 场景 | 行为 |
|---|---|
| 打开会话(列表 / 深链 / 新建后自动选中) | `touchTab(id)`:没有就追加,有就只更新标题;当前 `store.selected` 高亮并带 `aria-current="page"` |
| 点 tab | `selectSession(id)`;点选不重排;顺序默认按打开顺序,可拖拽调整(§8.94) |
| 点当前 tab | 不发请求(和列表点同一行一致) |
| `×`(悬停 / 当前 tab) | 只从 `store.tabs` 移除并写回 `localStorage`;**不发 DELETE、不归档** |
| 关当前 tab | 右邻居优先,没有就左邻居;都没有才 `clearSelection()`(回「未选择会话」) |
| 关非当前 tab | 选中会话不动,只重画 tab 栏 |
| 最后一个 tab 关掉 | 整条 `hidden`,一个像素都不占;桌面留下空态,手机上回到列表 |
| `+ 新建` | 直接调现有的 `openNew()`;建完会话自动选中后照常自动进 tab |
| 最多 8 个 | 第 9 个进来时 `shift()` 掉最左边那个;顺序默认按打开顺序,可拖拽调整(§8.94) |
| 刷新 | `init()` 先 `readTabs()` 画标题快照,再拉列表;列表回来后 `renderTabs()` 用最新标题覆盖并回写 |
| 会话被列表删除 | `onAction('del')` 里 `removeTab(id)`;归档只影响列表过滤,tab 留着 |
| 手机 | 竖屏 34px、横屏(粗指针 + 矮屏)30px;tab 区 `overflow-x: auto` 横向滑,`+` 只留一个加号;当前 tab 才露 `×` |

**DOM / CSS**:

- `public/index.html` 的 `#chatpane` 顶部、`#chatHeader` **之前**加
  `<nav id="sessionTabs" hidden><div id="tabStrip"></div><button id="tabNew">…</button></nav>`。
  左列表、顶栏、输入区、分栏条都没动。
- 桌面 36px;`#tabStrip` 自己横向滚并隐藏滚动条;`.tab` 最大 220px,标题
  `text-overflow: ellipsis`;`.tab.active` 用白底 + 2px 蓝色下划线;`#tabNew` 钉在右边。
- 窄屏全部挂在既有的 `html.narrow` 下,没有第二份 `@media` 断点:
  `html.narrow #sessionTabs { height: 34px; }`、`html.narrow.short #sessionTabs { height: 30px; }`、
  tab 竖屏最大 150px / 横屏 220px、`+` 只显示短标签。
- `#sessionTabs[hidden] { display: none; }` 显式写,免得被 `display: flex` 压过。

**JS**:

- `store.tabs = [{id, title}]`;`TABS_KEY = 'ocs.tabs'`、`TABS_MAX = 8`。
- `readTabs()` 容错(坏 JSON / 非数组 / 空 id / 重复 id),只留最近 8 个;`saveTabs()` 静默失败
  (`localStorage` 不可用也不挡会话)。
- `renderTabs()` 用 `id + title + active` 的签名避免无意义重建;重建时保留
  `#tabStrip.scrollLeft`;当前 tab 变了才 `revealActiveTab()`。`revealActiveTab()` 只动
  `#tabStrip.scrollLeft`,不碰页面/聊天区纵向滚动;窄屏从列表进会话时 `#chatpane` 还是
  `display:none`,所以 `selectSession()` 在 `syncNarrowView()` 之后再叫一次(量不到宽度就返回,幂等)。
- `closeTab()` 只有 `splice` / `saveTabs` / 选邻居,**没有** `api()` / `method: 'DELETE'` /
  归档字段;这是 `smoke.sh` 的源码锁之一。
- `setupSessionTabs()` 一次接线:点 tab、点 `×`、点 `+ 新建`、桌面上中键关闭;`init()` 里
  `store.tabs = readTabs(); setupSessionTabs(); renderTabs();` 排在拉列表之前。

**实测**(真页面,Playwright Chromium):

```
桌面 1366×900     nav 790×36 @ (576,47);顶栏仍 47;header 97;messages 581;docScrollW 1366
竖屏 393×894      nav 393×34 @ (0,0);header 61;messages 750;docScrollW 393
手机横屏 894×393  nav 894×30 @ (0,0);header 57;messages 257;docScrollW 894
                  (isMobile + hasTouch,pointer:coarse → html.narrow + html.short)
```

- 桌面打开 3 个会话:tab 顺序 = 打开顺序,最后打开的会话高亮;点第一个 tab 切回;关掉一个
  非当前 tab 后,会话仍在列表里、选中不变;`+ 新建` 打开现有 `#dlgNew`;刷新后 tab 从
  `localStorage` 回来;探针 `ERRORS []`,三种视口都 `docScrollW === innerWidth`。
- 截图:`/tmp/ocsm-probe/pw/tabs-desktop.png`、`/tmp/ocsm-probe/pw/tabs-portrait.png`、
  `/tmp/ocsm-probe/pw/tabs-mobile-landscape.png`(横屏真机口径);`tabs-landscape.png` 是
  同一尺寸但**细指针**的桌面档,仍按桌面布局走(既有断点如此,不是本次引入的)。

**取舍**:

- 高度成本:桌面多 36px、竖屏多 34px、横屏多 30px;换来「最近会话一眼可见、一指直切」。
  没有 tab 时整条 `hidden`,不占高度。
- 当前会话标题会在 tab 栏和聊天头部各出现一次;这是用户要的 TUI 形态,不为了省一行把
  `#chatTitle` 在手机上藏掉(手机上标题行还兼着 `‹ 会话`、状态和上下文用量)。
- 手机只给当前 tab 露 `×`:少一排小叉,也更难误触;要关别的 tab 先点一下再关。
- 拖拽排序已在 §8.94 补上(鼠标拖 / 手机长按);未读脉冲 / `Ctrl+数字` / global-cwd
  分域仍不做,也不做跨标签页 / 跨设备同步。标签只存本浏览器的一个小数组
  (id + 标题快照),不落消息。
- tab 指向的会话若在别处被删,点开会走现有的失败提示,`×` 仍能移除;不在列表页的会话
  不会被 tab 自动补拉,只有选中时才走 `refreshSessionInfo()`。
- 超过 8 个丢**最左边**那个;顺序可以由用户拖拽调整后,左端是唯一一眼能看到的
  「先走」规则,不需要再记访问时间。和 TUI 的模型不完全一样,但规则可预期、实现小。

**回归**:`smoke.sh` 333 → **338**(5 项:节点在 `#chatHeader` 之前、自动入栏 + `ocs.tabs`
+ 最多 8 个 + init 接线、`closeTab` 只移出且邻居回退、三档高度样式、`ui-capabilities.html`
关键断言在);`ui-capabilities` 112 → **136**(24 项:自动入栏 / 切换 / 关闭 / 上限 / 持久化 /
`+ 新建` / 窄屏样式与只有当前 tab 露 × 等)。其余套件计数不变;全量回归 **0 失败**,
日志 `/tmp/ocsm-probe/perf/regress-859.log`。

---

### 8.60 共享 TUI 的 diff 偏好(cli.json 的 diffs.view)

**起因**:上一批 1–4 的第 2 项;§8.53 留的「面板没读 TUI 的 `cli.json`」。

**结论**:只共享 `diffs.view` 一个字段,不碰 `diffs.wrap` / `tree` / `single` / `source`。
面板没有这些控件的 UI 或渲染路径:统一视图固定按字符折行(§8.58);文件树 / 单文件 /
来源只在 TUI 的独立 diff viewer 里有意义。`diffs.view` 正好是面板唯一有的三档偏好。

**服务端**:

| 端点 / 位置 | 行为 |
|---|---|
| `GET /__config/diffs` | `{view, mtime}`;`view` 只在 `cli.json` 里真有合法三档时返回,没记过就是 `null` |
| `PATCH /__config/diffs` | body 只收 `{"view":"auto|split|unified"}`;多余字段 / 坏 JSON 400,超过 64KB 413 |
| 写文件 | 读 → 只改 `obj.diffs.view` → `JSON.stringify(obj,null,2)+'\n'` → 同目录临时文件 + `chmod` 原 mode(新文件 0600)+ `rename`;TUI 的 watcher 永远读不到半截 JSON |
| 拒绝覆盖 | `cli.json` 不是严格 JSON,或 `diffs` 不是对象时 GET 500、PATCH 500,原字节一个不动 |
| 鉴权 / 缓存 | 路由排在来源白名单与 Basic 鉴权之后;`cache-control: no-store` |
| `/__health` | 顺手带 `diffView` / `diffMtime` —— 面板本来每 15s 轮询,不另开 SSE / 轮询 |

只支持严格 JSON。`cli.json` 若有注释或尾逗号,`JSON.parse` 会拒绝(接口带原因),
宁可不写也不猜;TUI 自己生成 / 迁移出来的文件是严格 JSON。

**面板**:

- `diffViewPref()` 仍同步:先读 `localStorage['ocs.diffView']` 当首屏缓存;`loadDiffPref()`
  首屏 GET 服务端,`applyServerDiffPref()` 用 mtime 挡住旧响应 —— 只有新值 / 新 mtime
  才更新偏好,并在页面里已有 diff 卡片时一起重画。
- 点「⇆ 并排」:`diffViewSet()` 先本地乐观更新并立刻重画,再 PATCH `{view}`;成功用返回的
  `view` / `mtime` 回填;失败只 toast「并排偏好没写进 cli.json:…」,页面继续按刚点的值工作,
  下一次 health 会按 TUI 那本账同步回来。
- TUI → 面板:`health()` 每 15s 已经会跑,最多晚 15s;正在写回时不接受 health(免得旧值
  把乐观值打回去);比已应用值更旧的 mtime 忽略。
- 迁移:首次 GET 若 `cli.json` 没有 `view`、而 `localStorage` 里还有旧 `split` / `unified`,
  只迁一次(PATCH 回去),之后两边以 `cli.json` 为准;没有旧值就保持 auto。
- `localStorage` 仍写,但降级为缓存 / 退路;隐私模式写不进去时用内存 cache,功能照常。

**实测**(临时代理 `49451` + 临时 `OPENCODE_CONFIG_DIR` + 临时 `cli.json`,不碰用户自己的配置;
真会话 `ses_demo_e…`,22 张 diff 卡片):

```
init cli=unified                  pref=unified split=0
点一下                            pref=split   split=22  cli=split
模拟 TUI 改 unified + health()    pref=unified split=0   cli=unified
刷新                              pref=unified split=0
ERRORS []
```

**取舍**:

- 面板只共享 `view`;`wrap` / `tree` / `single` / `source` 仍只在 TUI。面板没有对应按钮,
  硬把 `wrap:none` 搬过来还会把 §8.58 的折行弄丢。
- 写的是本机文件:面板与 TUI 得在同一台机器 / 同一个 `OPENCODE_CONFIG_DIR` 下。不跨设备
  同步,也不跨浏览器标签页(每个标签页自己轮询 health)。
- 面板与 TUI 同时写时靠原子 rename 保证不出现半截文件,最后一次 rename 赢;没有跨进程锁。
  极端情况下 TUI 的格式保留写入与面板的整文件重写会互相覆盖,但字段级只是最后一次赢。
- 如果 TUI 是用 `OPENCODE_CLI_CONFIG_CONTENT` 启动的(环境里直接给配置内容),它不看
  `cli.json`;这时面板的写回对它无效。正常安装不会这样。
- `cli.json` 有注释 / 尾逗号时面板拒绝写(不猜),TUI 侧仍可照常用自己的解析器读。

**回归**:`smoke.sh` 338 → **343**(5 项),`ui-tools` 308 → **316**(8 项),
新增 `config-e2e-run.js` **40** 项;其余套件计数不变;全量回归 **0 失败**,
日志 `/tmp/ocsm-probe/perf/regress-860.log`。

---

### 8.61 工作树列表 / 删除 / 把已有会话移进去

**起因**:上一批 1–4 的第 3 项;§8.56 只做了「在 `+ 新建` 里新建 worktree」,TUI 的
`Worktrees` 对话框还有列出、删除、把已有会话移进去。

**结论**:补一条 `/worktrees` 命令,复用现有的 `#dlgPick`(不新造对话框),入口和 `/diff`
一样只走命令面板,不往聊天头部加按钮。列表列服务端 `/api/worktree` 返回的工程根目录
(主检出 + OpenCode 建的 worktree),不把会话落在根下的子目录再拆一层。

**流程**:

| 动作 | 实现 |
|---|---|
| 打开 | 每次先 `GET /api/session/:id` 拿最新的 `projectID` / `location.directory`(后台列表刷新可能用旧 location 覆盖 store),再列工作树 |
| 刷新 + 列 | `POST /api/worktree/refresh {projectID}`(失败静默) → `GET /api/worktree?projectID=...`;按 TUI 排序:当前根最前,其余主检出在前、worktree 在后,主检出按路径长短 |
| 移入 | `POST /api/session/:id/move {directory}`;成功后本地改 `s.location.directory`,重画列表 / 头部 / 提示栏 / 工具栏 / 上下文用量,不重拉消息 |
| 删除 | 只对带 `strategy` 的 worktree 开放;`DELETE /api/worktree {projectID,directory,force:false}`。返回 `data.forceRequired` 时原生 `confirm`,确认后带 `force:true` 重试;主检出的删除项直接禁用 |
| 删到当前目录 | 删除成功后若当前会话目录在被删根下,`clearSelection()` 回列表并提示;用户期间切了会话则按「现在选中的」目录判断,不乱清 |
| 删除其它目录 | 删完从目录下拉里移除,并重新打开 `/worktrees` 列表 |

**取舍**:

- **只列根目录**。TUI 从会话的 `location` 里拿子目录当额外移动目标;面板只列 API 给的根,
  手机上少一层,也避免把「工程目录」和「worktree」混在一起。
- **删除前不展示文件变更 diff**。TUI 会先列 `forceRequired` 的那批文件;面板用一句原生
  `confirm` 代替,和现有的删会话 / 撤销确认保持同一形态。服务端仍是最终裁判。
- **新建 worktree 不放进这个对话框**。`+ 新建` 里的开关已经覆盖,`/worktrees` 只做
  「已有工作树」的浏览 / 删除 / 移入。
- **移入不重拉消息**。`session/move` 只换 location;会话 id、消息、标签、滚动位置都不变,
  清缓存或重拉只会闪一下。
- 依赖 `api()` 把错误响应里的 `data` 一起带出来(`err.data`),否则删除的 `forceRequired`
  只能退化成「HTTP 400」。这是通用能力,其它调用方不受影响。

**实测**(真页面 1366×900,临时工程 `/tmp/ocsm-probe/wt-demo`、临时会话、临时 worktree,
结束后会话与 worktree 都删掉,不碰真实业务会话):

```
list        /tmp/ocsm-probe/wt-demo + ~/.local/share/opencode/worktree/80d169/probe-ui-…
move in     /api/session/:id/move → location = worktree;当前根 ● 跟着换
move back   location = /tmp/ocsm-probe/wt-demo
delete      toast「已删除工作树:…」,列表只剩主检出,服务端 /api/worktree 也只剩主检出
ERRORS []
```

**回归**:`smoke.sh` 343 → **348**(5 项),`ui-capabilities` 136 → **150**(14 项);
其余套件计数不变;全量回归 **0 失败**,日志 `/tmp/ocsm-probe/perf/regress-861.log`。

---

### 8.62 切 diff 视图只重画正文,不再整卡重造

**起因**:上一批 1–4 的第 4 项。§8.53 切并排 / 统一时 `redrawDiffCards()` 对每张 diff 卡片
调 `toolHtml(p)` 生成整卡,再 `card.replaceWith(fresh)`。切换一次会把 summary、diff 正文、
诊断块、`details` 的展开状态和正文滚动位置全部重造;卡片一多,既慢,也会把用户正在看的位置
和焦点弄丢。§8.53 当时实测几十张要 340~490ms,留了一句「真嫌慢再优化」。

**结论**:diff 卡片把 diff 正文单独包一层 `.diffwrap`,摘要和诊断块留在外面。切换时只做
`wrap.innerHTML = diffHtml(files, {pid})`;`details` / `summary` / `.toolbody` / `.ddiag`
节点都不换,并顺手保住正文滚动与焦点。

**改动**:

| 位置 | 行为 |
|---|---|
| `diffToolHtml(p, files)` | `edit` / `patch` 的卡片正文 = `<div class="diffwrap">diffHtml(...)</div>` + `diagHtml(...)`;诊断块在 wrapper 外面,重画不碰 |
| `redrawDiffCards(pid)` | 只找带 `.dswap` 的卡片,按 `findToolPart()` 拿最新 files,替换 `.diffwrap` 的 innerHTML;不再 `toolHtml()` + `replaceWith()` |
| 滚动 / 焦点 | 每张卡片先记 `.toolbody.scrollTop`,替换后写回;被点按钮的 `data-pid` 记下来,重画完把焦点还给同一 pid 的新按钮;锚点卡片的 `getBoundingClientRect().top` 差值仍补到 `#messages.scrollTop` |
| CSS | `.toolbody > .diffwrap:first-child > .dfile:first-child { margin-top: 0; }`,首块文件头仍贴住正文顶部,桌面 / 手机布局不变 |

**实测**(真页面 1366×900,40 张 `modified` diff 卡片、每张 20 行 patch,同一轮 30 次,
中位数;旧实现用当时的 `toolHtml` + `replaceWith` 逻辑在同一页对照):

```
整卡重造  270.9 ms
只换正文  166.6 ms   (约 -38%)
```

**取舍**:

- 仍会重新跑一遍 `diffHtml` / `parsePatch`(每张卡片的 diff 都重新生成行 DOM);这次只省掉
  summary、诊断块、`details` 和滚动状态的重造,不是把 diff 行也缓存起来。要再快得给
  `parsePatch` 结果做缓存,牵动内存与失效规则,收益不如这次直接。
- 替换 `.diffwrap` 会丢掉用户正在 diff 正文里的文本选区;切换视图本来就会换行布局,选区
  留不住是预期内的。
- 焦点只在「活动元素正好是 `.dswap`」时还原;点在别处触发的重画(窗口缩放)不抢焦点。
- 诊断块不参与重画,所以切视图不会把刚到的诊断行刷掉;诊断更新仍走消息级重绘。

**回归**:`smoke.sh` 348 → **351**(3 项:正文层与 CSS、`redrawDiffCards` 不再整卡重造且
保住滚动 / 焦点、`ui-tools.html` 的重画断言在);`ui-tools` 316 → **321**(5 项:节点身份 /
诊断块 / 折叠 / 正文滚动 / 焦点);其余套件计数不变;全量回归 **0 失败**,
日志 `/tmp/ocsm-probe/perf/regress-862.log`。

---

### 8.63 /diff 接四档来源与对比分支

**起因**:上一批 1–4 之后的下一条;§8.57 的变更总览只接 `session.diff` 的 Last turn。
TUI 的 diff viewer 还有 `branch` / `working` / `committed` 三档,服务端 OpenAPI 里对应
`GET /api/vcs/diff`(mode 三选一)和 `GET /api/vcs/base`(review base)。

**结论**:对话框加四个来源按钮 —— **最近一轮 / 全部 / 未提交 / 已提交**。`turn` 仍打
`/api/session/:id/diff?context=3`;`working` 打 `mode=working`;`branch` / `committed`
必须先有一个对比基线 `base`。基线按工程目录只记在内存里(与 TUI 的「记住到退出」同类),
刷新页面 / 换目录后重选,不写 `cli.json`。

**基线**:

| 情况 | 行为 |
|---|---|
| `/api/vcs/base` 有值 | 直接用它(`name` 做按钮文案,`ref` 进 query) |
| 返回 `503 Choose a review base` | 不猜 `branch.default`;正文提示先选基线,按钮变「选择对比分支…」 |
| 用户点基线按钮 | 复用 `#dlgPick`,列 `/api/vcs/branch?limit=200`,可过滤;选中后记住并自动重载 |
| 失败 / 没有分支 | 只 toast 服务端原因 / 「这个工程没有可选分支」,不改当前正文 |

**改动**:

| 位置 | 行为 |
|---|---|
| 头部 | `#diffSub` 显示来源名;下面 `.diffbar` 放 `#diffSources` 四档与 `#diffBase`(仅 `branch` / `committed` 露) |
| `setDiffMode(mode)` | 合法值才切;先 `paintDiffHead()` 再 `loadDiff()`;点按钮与测试都走同一条路 |
| `ensureDiffBase()` | 先查目录缓存,再 `GET /api/vcs/base`;只把 `503` 当「还没选」,其它错误照常报 |
| `loadDiff()` | `branch` / `committed` 先拿基线;没有就 `renderDiffNeedBase()`(不发 `vcs.diff`);有则把 `mode` / `base` / `location[directory]` / `context=3` 拼进 URL |
| 空结果 | 来源各说各的:未提交「工作区没有未提交变更」、全部「与对比分支没有差异」、已提交「相对对比分支没有已提交差异」;最近一轮保留「还在跑 / 没有变更」 |
| 并发 | 仍用 `diffSeq`;切来源、刷新、关框都会让旧响应作废 |
| 样式 | `.diffsources` 横向滚动;窄屏按钮 40px 高、`.diffbody` 上限从 `100vh - 230px` 调到 `-272px`,给来源行让位;只写 `html.narrow`,没有第二份 `@media` |

**服务端**:没有改。现有 `/api/*` 反向代理已经透传 `/api/vcs/*`,鉴权仍由代理注入。

**实测**(真页面 1366×900,临时 git 工程 `/tmp/ocsm-probe/diff-863-demo`、临时会话,
不碰真实业务会话;结束删会话):

```
A sources   最近一轮* / 全部 / 未提交 / 已提交
B working   未提交 · 1 个文件 · +1 -0,基线按钮不露
C no base   全部 · 按钮「选择对比分支…」· 正文不发 vcs.diff
D pick      对比分支:feature / master / probe-base
E branch    选 probe-base 后 3 个文件 · +3 -0;再次请求带 mode=branch&base=probe-base
F committed 已提交 · 2 个文件 · +2 -0(未提交的 b.txt 不在这档)
ERRORS []
```

窄屏量尺(真页面 393×894 / 894×393):竖屏来源行 339×42,四个按钮各 40px 高;
正文 622px 高;`document.scrollWidth == innerWidth`。桌面来源行 228×24。横屏沿用宽屏尺寸,
来源行 24px,正文 244px。

**取舍**:

- **不猜 `branch.default`**。当前 Linux 工程 `/api/vcs/base` 就是 503;拿默认分支硬算
  可能是一个跨几百个提交的巨大 diff,用户也未必想比那个分支。
- **基线缓存在内存、按目录**。不写 `cli.json`:TUI 的 `diffs.source` / base 不是面板该
  共享的偏好(§8.60 只共享 `diffs.view`),刷新后重选比写错文件安全。
- **不新增服务端路由**。`/api/vcs/*` 已经在代理白名单里;能少一层就少一层。
- **503 会在浏览器 DevTools 里留一条网络 error**。这是服务端「还没选基线」的正常响应,
  面板已按提示处理;不是脚本异常。
- 文件树 / 逐文件 reviewed 标记仍不在这一条(下一条 §8.64)。

**回归**:`smoke.sh` 351 → **352**(1 项:四档 / 基线 / 窄屏静态锁),
`ui-capabilities` 150 → **160**(10 项:四档按钮、`working` 不带 base、无 base 不请求
`vcs.diff`、基线选择复用 `#dlgPick`、选完自动重载、`committed` 优先用服务端 base、
空结果文案、失败、切回最近一轮);其余套件计数不变;全量回归 **0 失败**,
日志 `/tmp/ocsm-probe/perf/regress-863.log`。

---

### 8.64 /diff 文件树与逐文件 reviewed

**起因**:§8.63 接上四档后,多文件 diff 只能一整条往下滚;TUI 的 diff viewer 左边还有
文件树,能点文件跳过去,并给每个文件勾「已看」。

**结论**:`#diffBody` 外面包一层 `.diffmain`,左边新增 `#diffTree`。只有**两个及以上文件**
才露树;第一项默认高亮,点文件滚正文;每项右边一个 `○ / ✓` 的 reviewed 按钮。reviewed
只在本页内存里,切来源 / 刷新 / 重新载入后归零,不写 `localStorage`。

**改动**:

| 位置 | 行为 |
|---|---|
| 布局 | `.diffmain` 桌面 `display:flex`;`#diffTree` 固定 220px,`#diffBody` 占余下宽度并 `min-width:0`;单文件 / 空结果 / 要选基线 / 失败时树 `hidden` |
| 列表项 | 状态徽标 `~ / + / -`、缩写路径(目录灰、文件名亮)、右边 `○ / ✓` reviewed 按钮;`title` 给完整路径 + 状态 |
| 跳转 | 点文件名不重画正文,按 `.dfile` 的 `getBoundingClientRect()` 差值改 `#diffBody.scrollTop`,并把树里 active 换到该项 |
| reviewed | `toggleDiffReviewed(i)` 只改 `.dtree-item.reviewed`、`aria-pressed`、按钮文案和 `N/M 已看`;不碰 `#diffBody`,正在读的补丁 DOM 原样留着 |
| 重置 | `renderDiffTree(files)` 每次载入都清空 reviewed;切来源、点刷新、重新开框都会重来 |
| CSS | 新样式全部在普通规则 + `html.narrow` 下;窄屏 `.diffmain` 改块级、`.difftree { display:none }`,不写第二份 `@media` |

**实测**(真页面 1366×900 + 393×894,临时 git 工程 / 临时会话;3 个文件时):

```
单文件      文件树 hidden,不占左栏
多文件      3 项:a.txt / b.txt / c.txt;第一项 active;0/3 已看
点第三个    树 active = c.txt;正文 scrollTop 140(人为把正文压到 120px 高)
勾第一个    1/3 已看;item.reviewed = true;aria-pressed = true;正文首节点身份不变
窄屏        文件树 computed display:none;来源行 221px;正文 339px;docScrollWidth == innerWidth
ERRORS []
```

**取舍**:

- **窄屏不显示文件树**。393px 上树和 diff 并排会把正文压到不可读;手机仍是一整条往下滚,
  文件树只在桌面 / 宽屏出现。
- **平铺列表,不画 TUI 那种目录树**。文件不多时平铺更好扫;目录只在路径前缀里灰显。
  真要做深层目录折叠,得再引入树模型,收益不值。
- **reviewed 不持久化**。它是「这一轮我看到哪了」的临时标记,和 TUI viewer 的内存状态一致;
  写 `localStorage` 反而会跨会话 / 跨 diff 误标。
- **加载不自动滚到第一个文件**。树默认高亮第一个,但正文保持用户原来的滚动位置;刷新时
  不突然把人从中间拽回顶部。
- **勾已看不重画正文**。只改树节点,避免把正在读的 diff 行 DOM、滚动和选区全部重建。

**回归**:`smoke.sh` 352 → **353**(1 项:文件树 / 跳转 / reviewed / 窄屏静态锁),
`ui-capabilities` 160 → **167**(7 项:多文件树与徽标、点文件滚动并高亮、勾已看不重造正文、
再点取消、切来源归零、单文件不占左栏、空结果收起);其余套件计数不变;全量回归 **0 失败**,
日志 `/tmp/ocsm-probe/perf/regress-864.log`。

---

### 8.65 工作树子目录与删除前文件清单

**起因**:§8.61 只列工作树根;TUI 的 `Worktrees` 还会把「会话落在工作树子目录」的目录
列出来,删除有未提交改动的工作树时也会先列出文件变更(`DialogWorkspaceFileChanges`)。
面板原来只有根 + 原生 `confirm`,手机上看不见「到底会丢哪些文件」。

**结论**:`openWorktrees()` 在根列表之外,按当前 `projectID` 再拉一次会话,从
`session.subpath` 派生子目录行(与 TUI `dialog-workspaces.tsx` 的 `subdirectories` 同法);
子目录只能移入,不能单独删除。删除根遇到 `forceRequired` 时先读 `/api/vcs/status`,
用新对话框 `#dlgWtDel` 列状态 / 路径 / `+N -M`,再让用户点「仍然删除」或「取消」;
status 读不到就退回原来的 `confirm`,不把删除卡死。

**改动**:

| 位置 | 行为 |
|---|---|
| 子目录来源 | `worktreeSessions(projectID)` 合并本地 `store.sessions` 与 `GET /api/session?project=…&limit=200`;`wtSubdirs()` 只留下 `subpath` 非空、`location.directory` 在某个根下面、且不与根重名的目录 |
| 排序 | 根照旧(当前根最前、主检出先于 worktree);根和子目录合在一起按「根序号 → 根先于子目录 → 路径」排,和 TUI 的 `toSorted` 一致 |
| 当前标记 | 会话本身在子目录时,`●` 标在子目录行,不标它的根;动作菜单里移入禁用 |
| 子目录动作 | 「删除工作树」禁用并写「子目录不能单独删」;移入仍走 `session/move`,目录就是子目录 |
| 删除预览 | `DELETE force:false` 回 `forceRequired` 后:先 `GET /api/vcs/status?location[directory]=…`,再开 `#dlgWtDel`;文件清单只读 status,不下载补丁 |
| 预览框 | 文件行 `A/D/M`、相对工作树根的路径、`+N -M`;清单自己滚(240px);默认焦点在「取消」,不把破坏性动作做成回车默认项 |
| 回退 | status 请求失败 / 对话框节点缺失时,仍用原来的 `confirm`;取消预览不发 `force:true` |
| 样式 | `.wtfiles / .wtfile / .wtf-*` 全部普通规则;窄屏沿用 `.dlgacts .chip` 的 44px 命中区,不新增 `@media` |

**验证**:

- 真接口:`GET /api/session?project=<id>&limit=200` 正常返回;`GET /api/vcs/status?location[directory]=<dir>`
  返回 `[{file,status,additions,deletions}]`。
- `ui-capabilities.html` 浏览器断言:根 / 子目录排序、子目录行标记、会话在子目录时高亮
  子目录、当前子目录移入禁用、非当前子目录可移入、`forceRequired` 后列出两个文件、取消
  不重试、点「仍然删除」带 `force:true` 并移除、status 失败回退 `confirm`。
- 全量回归:见下方「回归」;`node --check public/app.js` 通过。

**取舍**:

- **子目录是「会话去过的地方」,不是文件系统扫描**。与 TUI 一样从会话派生;没会话的
  子目录不凭空出现,也不多一次 `find`。
- **最多看 200 条会话**。只用于补子目录,不拿来做列表;拿不到时根列表照旧可用。
- **删除前只列 status,不列完整 diff**。手机上真正要确认的是「会丢哪些文件、多少行」,
  不是逐行补丁;完整 diff 仍在 `/diff`。
- **子目录不能单独删**。删除只能删根;子目录行只是移入目标,避免把「删一个会话目录」和
  「删整棵工作树」混成一件事。

**回归**:`smoke.sh` 353(仍是 1 项工作树静态锁,条件里补了子目录 / 预览框),
`ui-capabilities` 167 → **174**(7 项:子目录排序与标记、子目录当前高亮、两个动作菜单、
删除预览清单、取消、仍然删除、status 回退);其余套件计数不变;全量回归 **0 失败**,
日志 `/tmp/ocsm-probe/perf/regress-865.log`。

---

### 8.66 进入会话就恢复上次阅读位置

**起因**:H 组 3 原来只让「刷新」恢复滚动位置,从列表 / 标签 / 前后退进入会话一律跳到底部。
用户要求把可选后续项做完;TUI 的会话切换本来就保留每个会话自己的阅读位置,面板这条差异
在长会话里最明显:切走问一句话再切回来,又得重新往下翻。

**结论**:`selectSession()` 统一先查 `sessionStorage['ocs.scroll']` 里这个会话的锚点;
刷新路径由 `restoreFromHash()` 塞的显式锚点优先,其它入口直接用存档。没有存档(第一次打开)
才落到底部。刷新 / 列表 / 标签 / 深链前后退从此走同一条路。

**改动**:

| 位置 | 行为 |
|---|---|
| 进入会话 | `const rs = explicit || savedAnchor(id)`;`store.restoreScroll = rs`;`store.forceBottom = !rs` |
| 显式锚点 | `restoreFromHash()` 仍只在**真有存档**时塞 pending;不会因为 `anchor: null` 拦住 `forceBottom` |
| 离开 / 重开 | 只要 `prev` 存在就先 `saveScrollAnchor()`;重复打开当前会话也先记下当前位置,避免清空消息区时把刚滚到的位置丢掉 |
| 无存档 | 第一次打开的新会话 / 深链仍跳到底部,和原来的行为一致 |
| 锚点失效 | 锚点消息被删或掉出这一页时,`applyScrollAnchor()` 退回像素值,由浏览器夹取范围(原有逻辑) |

**取舍**:

- **不按入口分叉**。刷新要恢复、点列表却跳底部,这一条本身就是旧决定;现在统一后规则更少,
  也让标签栏 / 前后退不会出现「同一个会话,从不同地方点进去位置不同」。
- **仍只记本标签页**。`sessionStorage` 不跨标签、不写磁盘;关掉标签就丢,和「刚才读到哪」的
  语义一致。
- **第一次进入仍看最新**。没有存档时不塞 `{anchor:null}` 的 pending,长会话一打开就停在
  最上面这个老坑不再出现。

**验证**:

- `ui-layout` 的 H 组 3:刷新恢复、只还原一次、**从列表切走再切回来回到原处且不在底部**、
  锚点消息不存在退回像素、无存档短 / 长会话到底,全部保留。
- `smoke.sh` 的静态锁改成检查 `explicit || savedAnchor(id)` 与 `forceBottom = !rs` 同一处。
- `node --check public/app.js` 通过。

**回归**:`smoke.sh` 353 不变(只改条件,不增项),`ui-layout` 185 → **186**(从列表切回来
恢复位置多 1 项),`ui-capabilities` 174 不变;其余套件计数不变;全量回归 **0 失败**,
日志 `/tmp/ocsm-probe/perf/regress-866.log`。

---

### 8.67 后台消息对账:内网 800ms,慢链路仍 4000ms

**起因**:§8.54 为了 VPN 把消息对账的落地间隔固定成 4 秒。内网上一轮对账刚回来,
下一条事件再触发时仍要等满 4 秒,表现就是「模型已经回了/工具已经结束了,面板还要过几秒
才把权威消息列表拉回来」。SSE 的本地渲染虽然照常,但工具最终 metadata、压缩摘要这类
只有消息列表才准的内容会明显滞后。

**结论**:把消息对账间隔拆成两档 —— `slowLink()` 为真(VPN / 3G / 首屏实测 ≥180ms)
仍用 4000ms,否则用 800ms。单飞 + 合并的语义不变:同一时刻仍只飞一条,落地后只补一次,
慢链路不会被新的快档打满。列表刷新仍用 `SESSION_AUTO_GAP_MS = 2500`,这一轮不动。

**改动**:

| 位置 | 行为 |
|---|---|
| 常量 | `MSG_AUTO_GAP_FAST_MS = 800` / `MSG_AUTO_GAP_SLOW_MS = 4000`;`msgAutoGap()` 按 `slowLink()` 选择 |
| 进入自动对账 | `loadMessages({auto:true})` 落地后离上次太近时,按 `msgAutoGap()` 算剩余等待;不再写死 4000 |
| 合并后补跑 | `finally` 里 `scheduleAutoMsg(msgAutoGap())`,与上面同一个口径 |
| 不变 | 只认当前会话 / 会话行事件;后台不闪 250ms 状态行、失败不盖界面;前台请求仍优先并掐掉在飞自动对账 |
| 慢链路 | 仍走 §8.54 的判据与 4 秒档;首屏还没量到 RTT 时短暂用快档,量到后 `store.netSlow` 生效 |

**取舍**:

- **不把间隔降到 0 / 150ms**。800ms 已经比一次 LAN 往返(实测 37ms)宽得多,又给事件密集时
  留出合并窗口;再快只会把同一轮的多条事件拆成多次 MB 级请求。
- **不做「内网无限并发」**。单飞仍是最重要的保险;快档只改「落地后等多久」,不改并发数。
- **列表刷新不跟着变**。列表是小载荷且只认会话行事件,2500ms 不是这次抱怨的来源;改它要
  重新量频繁改名 / 切模型的场景。
- **首屏采样前的短窗口用快档**。这段时间通常只有一次请求;慢链路最多多花一次 800ms 间隔,
  不影响正确性。

**回归**:`smoke.sh` 353 → **354**(1 项:快 / 慢两档与 `msgAutoGap()` 接线),
`ui-stream` 258 → **259**(1 项:内网 800ms 与慢链路 4000ms);其余套件计数不变;
全量回归 **0 失败**,日志 `/tmp/ocsm-probe/perf/regress-867.log`。

---

### 8.68 跨消息探索并组：吸收纯探索续步（方案 A）

**起因**：§8.24 把探索类工具折成一组之后，还剩一处和 TUI 对不齐：TUI 按 part 投影，
助手消息不插 `message` 行，所以相邻两条助手消息里的 `read` / `grep` 只要前一条不是终步、
没落 footer，就会并进同一个探索组；面板按消息渲染，跨消息的连续探索会分成两段，各印各的
`Explored:`。实测 60 个会话窗口里有 **8 处**这种跨消息组（占探索分组 2.9%），用户要求把这
一处继续对齐。

**结论**：不改「按消息渲染」的骨架，只做方案 A —— 在 `renderMessages()` 前算一遍吸收计划：
下一条助手消息如果是**非终步**（`finish` 仍是 `tool-calls` / `unknown`）、非流式、非出错 /
重试，且整条内容除空文本 / 空思考外全是探索工具，就把这条消息整条藏掉，把它的探索工具
并进上一段**最后一个**探索组。实测那 8 处都是这种纯探索续步。

**改动**：

| 位置 | 行为 |
|---|---|
| 吸收条件 | `isPureExploreStep()`：助手消息、`finish` 是 `tool-calls` / `unknown`、不是 live、没有 error / retry、至少一个可见 part 且全部是 `isExploreTool()` |
| 吸收方 | `canStartExploreAbsorb()`：同样是非终步助手消息，但只要求**最后一个可见 part** 是探索工具；前一段可以带正文，只要以探索组收尾 |
| 分组边界 | `exploreAbsorbPlan()` 一次遍历：用户 / 系统 / 压缩 / 其它助手消息 / 流式消息都断组；`idle` 与没 description 的 `synthetic` 不出行，所以跨过它们不断组 |
| 上一段渲染 | `renderMessage()` 只把吸收工具追加进「最后一个可见 part 所在的探索 run」，前面被正文 / shell 隔开的探索组不参与 |
| 占位 | 被吸收的消息仍留在 `msgs` / `msgEls` 里，元素换成 `div.msg.absorbed[hidden][data-absorbed-by]`；删除清理、DOM 顺序和消息 id 都还认得出它 |
| 增量重绘 | 吸收方的签名追加 `\|absorb:` + 被吸收工具 part 的 JSON；续步的工具状态 / 输出一变，上一段整块重绘，`syncDetailsOpen()` 仍搬用户摊开状态 |
| 删除 | 上一段被删后，下一轮计划不再吸收续步，占位按普通消息重建成原来的助手行 |
| 滚动锚点 | `scrollAnchor()` 跳过 hidden 占位；`applyScrollAnchor()` 遇到存档落在续步上时改锚到它的吸收方 |
| CSS | `.msg.absorbed { display: none; }`（`hidden` 在消息区里必须显式写，和 `.msgstate[hidden]` 同一条理由） |

**取舍**：

- **仍然不做行投影**。方案 A 只挪「纯探索续步」这一种消息，`content-visibility`、离屏跳渲染、
  滚动锚点和增量重绘的边界都没变；代价是带正文 / 终步 / 流式中的续步仍会分成两段。
- **续步整条藏掉**，包括它自己的 `.meta` / `.afoot`。TUI 在 `tool-calls` 步骤本来就不落 footer；
  上一段的脚注仍在组后，那是面板自己的阅读行，不在这一条里改。
- **要求 `finish` 明确为非终步**。老会话没有 `finish` 的助手消息不参与吸收，宁可少并一组，
  也不在渲染期猜「这一步是不是还在跑」。
- **占位不换成合成消息**。如果直接把被吸收的消息从 `currentMessages()` 删掉，删除清理、
  锚点、消息 id 和后续消息对账都要另开一套映射；留一个 hidden 壳最省，也最容易验证。

**验证**：

- `ui-tools.html` 新增 14 项：吸收计划（含 `unknown`）、hidden 占位与 `data-absorbed-by`、
  上一段合并成 `2 reads`、占位顺序、`msgEls.absorbed` 归属、续步内容变化触发重绘且摊开状态
  留住、上一段删除后续步恢复、续步删除后上一段收起、正文 / 终步 / 纯 shell 不吸收、
  前一段带正文仍可吸收、`idle` 不打断。
- `smoke.sh` 新增 1 项静态锁：吸收函数、`renderMessages()` 接线、占位属性、锚点回退、
  `.msg.absorbed` 样式与 `ui-tools.html` 的断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 354 → **355**，`ui-tools` 321 → **335**；其余套件计数不变；全量回归
**0 失败**，日志 `/tmp/ocsm-probe/perf/regress-868.log`。

### 8.69 子会话过滤与父子导航

**起因**：TUI 的会话列表明确 `.filter((session) => !session.parentID)`
（`component/dialog-session-list.tsx`），子会话走单独的 picker；面板的 `visibleSessions()`
没有过滤，现场 108 个会话里有 29 个带 `parentID`，子会话会混进左栏和 `/sessions`。
同时面板只有 `subagentCount()` 这个计数，没有打开子会话 / 回父会话的入口，子会话收工行
（synthetic 消息的 `metadata.childID`）也点不动。审计 A1 + B2 一起做。

**结论**：主列表只显示顶层会话；子会话仍留在 `store.sessions` / `store.subs` 里供给导航。
桌面头部加「子会话 N」「‹ 父会话」两个入口，命令面板加 `/subagents` / `/parent`（窄屏整条
`#chatOps` 本来就被 CSS 收掉，手机上走命令）；子会话收工行按 TUI 的 `SessionNoticeMessageV2`
整行可点，点了切到 `metadata.childID`。

**改动**：

| 位置 | 行为 |
|---|---|
| 主列表 | `visibleSessions()` 先滤掉 `parentID` 再排序；`renderSessions()` 的「另 N 个已归档」也只数顶层会话 |
| 子会话表 | 列表接口与 SSE 原本就维护 `store.subs`（子→父）；`refreshSessionInfo()` 补拉单个会话时也补记 / 清掉这条映射，深链进子会话后能马上认出父会话 |
| 头部入口 | `renderChatOps()` 按 `childIDs()` 个数显示「子会话 N」、按 `parentOf()` 显示「‹ 父会话」；`#opSubagents` / `#opParent` 只是新增的按钮，没有删改原有导出 / TUI / 归档 |
| `/subagents` | `openSubagentPick()` 先按 `GET /api/session?parentID=…&limit=200` 补全（列表页只拉最近一页，父会话的孩子可能不在 store 里），合并进 `store.sessions` / `store.subs` 后用现成的 `openPick()` 列标题 / 运行状态 / 更新时间；一个都没有就只提示、不开空框 |
| `/parent` | `goParent()` 取 `parentOf()` 切过去；顶层会话只提示「当前是顶层会话」 |
| 收工行 | `noticeRowHtml()` 对 `source === 'subagent'` 且 `metadata.childID` 是字符串的行加 `data-child`、`role="link"`、`tabindex="0"`；`setupMessageActions()` 在 `#messages` 上委托 click / Enter / 空格，正在选字时不跳（照 TUI 的 `getSelection` 判断） |
| 删除 | `onAction('del')` 与 SSE `session.deleted` 都清 `store.subs`，父会话头部的个数不会留着已删的子会话 |
| CSS | `.completion[data-child]` 是手型、hover 下划线、`:focus-visible` 有描边；shell 收工行没有这个属性，保持纯文本 |

**取舍**：

- **只列直接子会话**，不做 TUI `sessionFamily()` 那棵带 `├─` / `└─` 前缀的整棵家族树。
  面板的入口是「当前会话的子会话」和「回父会话」，直接子会话已经覆盖主路径；家族树要另做
  缩进投影与活动 / 全部筛选，收益不值当。
- **列表接口仍返回子会话，只在显示层过滤**。这样不需要改代理或服务端契约，子会话随时能被
  标签栏 / 收工行 / 深链打开；代价是最近一页的 50 条里如果有子会话，主列表实际显示不到 50 个。
- **头部入口在窄屏不可见**（§8.41 已把 `#chatOps` 整条收掉）。手机走 `/subagents`、`/parent`
  两条命令，和「手机上少显示」的既定方向一致，没有为这两项再往标题行塞按钮。
- **只有子会话收工行可点**。shell 收工行没有 `childID`，保持纯文本；与 TUI 的
  `source === "subagent"` 判断一致。
- **父会话被删后留下的孤儿子会话仍按带 `parentID` 处理**，和 TUI 一样不把它们重新混进主列表；
  父会话删除是否级联由服务端决定，面板不猜。

**验证**：

- `ui-picks.html` 新增 14 项：`/sessions` 不含子会话、`store.subs` / `parentOf`、头部两个入口的
  显隐与文案、`/subagents` 的标题 / 过滤框 / 只列当前父会话的孩子 / 选中即切换、切到子会话后
  头部换成「回父会话」、`/parent` 切回、没有子会话时只提示不开框。
- `ui-tools.html` 新增 4 项：子会话收工行带 `data-child` / `role=link` / `tabindex=0`、shell
  收工行不带、点一下切到子会话、键盘 Enter 也能切。
- `smoke.sh` 新增 2 项静态锁：A1 的两处 `!parentID` 过滤、B2 的函数 / 命令 / 按钮 / 收工行
  属性 / 两份浏览器断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 355 → **357**，`ui-picks` 96 → **110**，`ui-tools` 335 → **339**；
其余套件计数不变；全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-869.log`。

### 8.70 时间线跳转与按用户消息分叉

**起因**：审计 A2 / A3。TUI 有 `session.timeline`（`DialogTimeline` 列用户消息，选中走
`jumpToMessage`）和 `session.fork`（`DialogFork` 第一项「Full session」，其余用户消息发
`{sessionID, before: messageID}`）；面板只有滚动存档与「跳到最新」，分叉固定从末尾
（请求体恒为 `{}`），长会话里想回到某一问、或从某一问重开一条分支都做不到。

**结论**：两条命令都复用现成的 `openPick()`。`/timeline` 只列用户消息、最新的在前，
选中后把那条消息的顶端对到消息区上沿；`/fork` 第一项是「完整会话」（发 `{}`），
后面是用户消息（发 `{before:id}`），成功后刷新列表并直接打开新会话。左栏行上的
「分叉」仍保持原来的「从末尾分叉、只刷新列表」，不因为加了命令就改掉列表行的习惯。

**改动**：

| 位置 | 行为 |
|---|---|
| `/timeline` | `openTimeline()` 从 `currentMessages()` 里滤出 `type === 'user'`，倒序（照 TUI 的 `toReversed()`）；主文案是压平换行后的正文（空正文兜底「(空消息)」），副文案是本地时刻；没有用户消息就提示一句，不开空框 |
| 跳转 | `jumpToMessage(id)` 从 `msgEls` 找消息节点，复用 `applyScrollAnchor({id, off:0})` 把顶端贴到滚动口上沿；滚完用 `updateJumpLatest()` 现量一次是否仍贴底（短会话跳到顶也可能本来就在底部），再 `saveScrollAnchor()`。消息不在当前页时只提示，不假装跳了 |
| `/fork` | `openForkPick(sid)` 第一项 `{key:'', label:'完整会话', sub:'从末尾分叉'}`，后面与 `/timeline` 同一批用户消息；选中项决定请求体是 `{}` 还是 `{before:id}` |
| 分叉落地 | `forkSession(sid, before, open)` 统一发 `POST /api/session/:id/fork`，响应兼容 `会话对象` / `{data: 会话}` / 内层 `info` 三种形状；`open=true` 时刷新列表、把新会话塞回 `store.sessions`（带 `parentID` 时也补 `store.subs`）再 `selectSession()` |
| 列表行 | `onAction('fork')` 改为 `forkSession(id, null, false)`：请求体仍是 `{}`，成功后仍只 `loadSessions({reset:true})`，不切走当前会话 |
| 命令 / 帮助 | `PANEL_COMMANDS` 加 `timeline` / `fork`；`HELP_KEYS` 同步两条。窄屏头部入口本来就收在 `#chatOps` 里，手机走命令面板（与 `/subagents` / `/parent` 同一套路） |

**取舍**：

- **只列当前已加载的消息**，不为了时间线自动翻完所有历史页。面板的消息区按游标分页
  （窄屏 30 条、桌面 100 条），自动把整条会话拉完会让打开选择框变成一次重请求；现在
  列的就是用户眼前这一批，翻旧消息仍走既有的「加载更旧消息 / 滚到顶自动拉」。
- **跳转只滚动，不弹 TUI 的 `DialogMessage` 预览**。面板的消息本来就是整页阅读形态，
  再叠一层消息详情对话框只会多一次关闭动作；对齐的是「选中后跳到那条」这个主行为。
- **时刻用本地 `toLocaleTimeString`**（照 TUI 的 `Locale.time`），不用「几分钟前」：
  时间线按时间排序，绝对时刻更容易定位；同一天内不额外印日期。
- **列表行的「分叉」不改成弹选择框**。它是列表上的快捷动作，一键从末尾分叉更符合
  原来的手感；要从某条消息分叉时走 `/fork`（或在打开的那个会话里敲 `/fork`）。
- **分叉后直接打开新会话**是 `/fork` 的行为；列表行那条刻意保持「只刷新」，避免在列表里
  连点几次分叉时把当前正在读的会话换掉。

**验证**：

- `ui-picks.html` 新增 19 项：时间线的标题 / 过滤框 / 只列用户消息且最新在前 / 正文压平换行 /
  时刻副文案、选中后滚到那条消息且不再跟随底部、消息不在当前页时提示；`/fork` 的标题 /
  过滤框 / 第一项完整会话 / 后面用户消息最新在前、选消息发 `{before}`（不带 `sessionID`）、
  选完整会话发空请求体、成功后打开新会话并进 `store.sessions`、列表行分叉仍只刷新不切走、
  命令面板里两条命令都在。
- `smoke.sh` 新增 1 项静态锁：`jumpToMessage` / `openTimeline` / `openForkPick` /
  `forkSession`、两条命令、`before` 请求体、列表行仍走 `open=false`，以及 `ui-picks.html`
  的两条关键断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 357 → **358**，`ui-picks` 110 → **129**；其余套件计数不变；
全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-870.log`。

### 8.71 每会话输入草稿

**起因**：审计 A4。TUI 在切走时 `saveDraft()`、切回时 `takeDraft()`
（`component/prompt/index.tsx`），输入框正文按会话隔离；面板的 `selectSession()` 既不保存也不
恢复 `#input.value`，在 A 会话打一半切到 B，草稿会跟着过去，切回 A 又找不回来。

**结论**：按会话把输入框正文存进 `sessionStorage`（键 `ocs.drafts`，最多 20 个）。切走 /
回列表 / 刷新前保存，切回填充；发送成功与 `/clear` 清掉，发送失败保留。附件不随草稿存 ——
待发送附件在切会话时本来就清空，这一轮先把最容易丢的正文兜住。

**改动**：

| 位置 | 行为 |
|---|---|
| 存储 | `readDraftMap()` / `draftText(sid)` / `saveDraft(sid, text)`：值是正文原文；纯空白等于删除；每次「先删再插」，超额从最久没动过的开始淘汰 |
| 切走 | `selectSession()` 在 `saveScrollAnchor()` 旁边调 `saveCurrentDraft(prev)`；历史浏览中（`histAt >= 0`）存的是 `histDraft`，不会把翻到的旧消息当成草稿 |
| 切回 | `restoreDraft(id)` 把正文填回 `#input`，并把历史游标归位；后面原有的 `clearAttachments()` 会按新正文重画 `@` 引用与收起细边上的「● 草稿」 |
| 输入 | 输入框的 `input` 监听里 `saveDraft(store.selected, inp.value)`，边打边存；`pagehide` 再兜一次（程序化补全不走 `input` 事件） |
| 发送 | 普通消息发送成功后 `saveDraft(sid, '')`；失败分支不碰草稿，切回来还能接着改。命令通道在 `runCommand()` 返回 true 后清掉；`/clear` 也清 |
| 回列表 | `clearSelection()` 先存当前草稿再清空 `#input`，删除会话 / 浏览器后退都不会把正文带进下一个会话 |

**取舍**：

- **只把正文写进 `sessionStorage`，附件不持久化**。§8.74 已把待发送附件按会话放进内存
  （切标签 / 回列表不丢），但上传文件是服务端临时目录里的中转文件，跨刷新保存没有意义；
  要随草稿写 `sessionStorage`，还得连临时文件生命周期一起设计，当前不做。
- **用 `sessionStorage` 而不是 `localStorage`**。和滚动存档同一档：这是本标签页里「刚才打到哪」，
  不该跨标签页或跨设备串味；刷新能恢复，关掉标签页就丢，符合 TUI 的会话级草稿直觉。
- **失败时保留草稿、但输入框仍是空的**。保持原有发送失败行为（输入框已清、弹失败提示），
  草稿留在会话名下；切回来就能看到原文，不额外改发送失败路径的交互。
- **最多 20 个会话的草稿**。和滚动存档的 `SCROLL_MAX` 同一思路，避免长期使用后把
  `sessionStorage` 塞满；被淘汰的是最久没保存过的那条。

**验证**：

- `ui-picks.html` 新增 9 项：切走时存进上一个会话、切回填回自己的、两个会话互不串、
  发送成功后清掉、发送失败保留、`/clear` 清掉、回列表时存下并清空输入框、重新打开恢复、
  纯空白不算草稿。
- `smoke.sh` 新增 1 项静态锁：`DRAFT_KEY` / `saveDraft` / `restoreDraft` / `saveCurrentDraft`、
  `selectSession()` 的存与取、输入监听、发送成功清理，以及 `ui-picks.html` 的关键断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 358 → **359**，`ui-picks` 129 → **138**；其余套件计数不变；
全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-871.log`。

### 8.72 复制会话 ID 与转录

**起因**：审计 A5。TUI 有 `session.copy.id` 与 `session.copy`（`routes/session/index.tsx:1189` /
`:1201`，后者 export 后格式化成 transcript 写剪贴板）；面板的 `/copy` 复制的却是「在 TUI
打开」的启动命令，导出也只有 JSON。

**结论**：把 `/copy` 改成复制转录（与 TUI 同名命令对齐），另加 `/copyid`；会话的「更多操作」
里也放这两项。转录取服务端 export 的完整会话（不只当前加载页），格式是「用户消息 +
助手文本 + 工具摘要」的纯文本；剪贴板统一走 `copyText()`，局域网 http 回落到临时 textarea
加 `execCommand('copy')`。启动命令的复制仍在 `/tui` 对话框里（原「复制」按钮）。

**改动**：

| 位置 | 行为 |
|---|---|
| 剪贴板 | `copyText(text)`：安全上下文优先 `navigator.clipboard.writeText()`；失败或不可用时建一个临时 textarea 选中后 `execCommand('copy')`，最后移除节点。`copyTui()` 也改走它 |
| 复制 ID | `copySessionId(sid)`：整串 `ses_...` 写剪贴板，toast「会话 ID 已复制」/「复制会话 ID 失败」 |
| 转录格式 | `transcriptText(info, messages)`：标题、Session ID、Created / Updated、`## User`、`## Assistant`、`## Shell`；助手只取 text 与 tool part，工具写成 `- **name** — 摘要`，出错补 ` (error)`；`reasoning` 与 `idle` 不出现在转录里 |
| 复制转录 | `copyTranscript(sid)`：先 `GET /api/experimental/session/:id/export?sanitize=false` 取全量；失败时若该会话正开着就退回当前已加载消息并提示「改为复制已加载部分」，没开着则明说需要先打开 |
| 命令 | `/copy` → 复制转录（纯文本）；新增 `/copyid`；`HELP_KEYS` 同步两条 |
| 列表 | 「更多操作」加「复制会话 ID」「复制转录」两项（分组「复制」），桌面的 ⋯ 与窄屏共用；`onAction` 接到上面两个函数 |

**取舍**：

- **转录是摘要，不是 TUI 那种带工具完整输入 / 输出的长文**。按审计的建议先做「用户消息 +
  助手文本 + 工具摘要」；完整工具入参 / 输出、思考块开关、按消息选择复制都留到以后。
- **`/copy` 的行为改了**：原来复制启动命令，现在与 TUI 一样复制转录。启动命令仍能从
  `/tui` 对话框的「复制」按钮拿到，没有丢能力，只是不再占用 `/copy` 这个名字。
- **导出失败才退回当前页**。正常情况下用 export 保证「复制的是整条会话」，不受消息分页
  影响；失败时也不假装成功，toast 里明说复制的是已加载部分。
- **复制 ID 不依赖当前会话是否打开**：列表行「更多操作」里可以直接复制别的会话 ID；
  转录则优先走 export，所以也一样不需要先打开。

**验证**：

- `ui-tools.html` 新增 9 项：转录头（标题 / ID / 时间）、User / Assistant 段落、工具摘要
  （read 路径 / bash 命令）、错误工具标 error、默认不含思考、跳过 idle、Shell 段落、空消息
  返回空串，以及复制 ID 时传入整串 id 并提示。
- `ui-picks.html` 新增 2 项：命令面板里 `/copy` 的描述是转录、`/copyid` 存在；「更多操作」
  里两个复制项都在。
- `smoke.sh` 新增 1 项静态锁：`copyText` / `copySessionId` / `transcriptText` /
  `copyTranscript`、`/copy` 与 `/copyid`、更多操作里的两项，以及两个测试文件的关键断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 359 → **360**，`ui-picks` 138 → **140**，`ui-tools` 339 → **348**；
其余套件计数不变；全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-872.log`。

### 8.73 会话置顶

**起因**：审计 A6。TUI 的会话列表把 pinned 的放在最前（`component/dialog-session-list.tsx:148-191`），
pin 状态存本地（`context/local.tsx:576-589`）；面板只有归档，列表严格按 `time.updated` 排序，
常用的会话会被新会话不断挤下去。

**结论**：`localStorage['ocs.pinned']` 存一个 id 数组；`visibleSessions()` 先按「是否置顶」分组，
两组内部再走原有的 asc / desc；左栏标题加 `📌 置顶` 徽标，会话「更多操作」里加「置顶 / 取消置顶」。
只改显示顺序，不碰服务端数据、不重排 `time.updated`。

**改动**：

| 位置 | 行为 |
|---|---|
| 存储 | `PIN_KEY = 'ocs.pinned'`；`pinnedSet()` 读成 `Set`（坏 JSON / 非数组 / 非字符串项都过滤掉）；`savePinned()` 写回；`isPinned()` 给菜单判当前状态 |
| 排序 | `visibleSessions()` 先取 `pinnedSet()`，比较时 `pa !== pb` 直接让置顶组在前，**与 `store.order` 无关**；同组内仍按 `time.updated` 的 asc / desc |
| 切换 | `togglePin(id)` 增删 id、写回 localStorage、`renderSessions()` 重排、toast「已置顶 / 已取消置顶」 |
| 列表 | 标题后面加 `.pin-badge`（`📌 置顶`，颜色走 `--accent`）；`renderSessions()` 每轮只读一次 `pinnedSet()`，不是每行读一次 localStorage |
| 入口 | 会话「更多操作」加 `{ key:'pin', label: 当前 ? '取消置顶' : '置顶' }`，桌面 ⋯ 与窄屏动作面板共用；`onAction('pin')` 接 `togglePin()` |

**取舍**：

- **pin 只存本机、不写服务端 metadata**。TUI 也是本地状态；写 metadata 会和归档共用
  `PATCH metadata` 的整体替换语义（§8.61 已经踩过一次），没必要为此把服务端状态搅进来。
- **不改 `time.updated`、不改接口排序**。置顶只是显示层分组，服务端分页仍按更新时间；
  被置顶的会话如果不在当前拉到的 50 条里，仍然看不到 —— 和子会话过滤的边界相同。
- **不单独占一个桌面按钮**。桌面那一排已经有 7 个动作，再加一个会挤；统一收在 ⋯ 里，
  窄屏动作面板因此从 8 项变成 9 项。置顶后标题上的徽标就是「它在置顶组」的反馈。
- **归档优先于置顶**：勾掉「显示已归档」时，置顶的归档会话仍不显示；勾上后它才按置顶组排。
  这与「归档是隐藏」的既有语义一致，不新增「置顶可否穿透归档」的规则。

**验证**：

- `ui-picks.html` 新增 6 项：默认没有置顶；置顶后排最前（即使 `updated` 更旧）；写进
  localStorage；`asc` / `desc` 都在最前；再点取消并恢复原顺序；「更多操作」里有「置顶」。
- `ui-mobile.html` 的动作面板断言从 8 项改成 9 项，并核对九项文案（同一套 `onAction`）。
- `smoke.sh` 新增 1 项静态锁：`PIN_KEY` / `pinnedSet` / `isPinned` / `togglePin`、排序里的
  `pa !== pb`、`.pin-badge` 样式、更多操作入口，以及两个测试文件的关键断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 360 → **361**，`ui-picks` 140 → **146**；`ui-mobile` 仍是 **198**
（只改了两条期望）；其余套件计数不变；全量回归 **0 失败**，日志
`/tmp/ocsm-probe/perf/regress-873.log`。

### 8.74 图片单独发送与附件按会话保留

**起因**：实测反馈两件事：一是只选图片、不填文字时点发送没反应；二是切到另一个会话标签
再切回来，刚上传的附件不见了。前者是 `send()` 开头 `if (!text ...) return` 把空正文直接
拦掉；后者是 `selectSession()` 里 `clearAttachments()` 把上一会话的待发送附件永久清空。

**结论**：`send()` 改成「正文和附件至少有一个」即可，纯图片发 `{text: '', files:[...]}`；
附件按会话放进内存缓存，切走保存、切回恢复，发送成功只清当前会话那一份。上传中的附件
先拦住发送（此时还没有 `file:` URI，发出去会丢图），上传归属仍写回原会话的数组。

**改动**：

| 位置 | 行为 |
|---|---|
| 发送条件 | `send()` 先看 `store.attachments.some(a => a.busy)`，有就 toast「附件还在上传,稍等一下再发」并返回；再算出 `files`，只有 `!text && !files.length` 才返回。纯图片请求体是 `{text:'', files:[…]}`（照 TUI 的 `inputText` + `entry.files`） |
| 附件缓存 | `attachCache`（`Map<sid, 数组>`）+ `saveCurrentAttachments()` / `restoreAttachments()` / `dropSessionAttachments()`；缓存保存的是**数组引用**，不是副本 —— 上传是异步的，切走后完成 / 失败仍会改到同一个 `item`，切回来不会看到永远「上传中」的幽灵 |
| 切会话 | `selectSession()` 在保存滚动锚点 / 草稿的同一处保存附件；选中新会话后调用 `restoreAttachments(id)`，不再无条件 `clearAttachments()` |
| 回列表 / 删除 | `clearSelection()` 先把附件存进该会话名下，再清当前显示；重新打开还会回来 |
| 上传 | `queueFiles()` 开头记下 `sid` 与 `owner = store.attachments`，完成 / 失败只改 `owner`，只在 `store.selected === sid` 时重画；切走期间上传失败不会误删新会话的附件 |
| 发送成功 | 普通消息与服务端命令消费附件后走 `dropSessionAttachments(sid)`：删缓存 + 清当前显示；失败分支不碰附件，正文和图片都还能重发 |
| 持久化 | 附件仍不写 `sessionStorage`：上传文件是服务端临时目录里的中转文件（6 小时后会被清），跨刷新持久化没有意义；§8.71 的草稿正文照旧持久化 |

**取舍**：

- **附件只按会话保存在本页内存**。切标签 / 回列表 / 再打开都不会丢，但刷新或关页会丢；
  和 TUI 的会话级 prompt 状态一致。要跨刷新保存，得连临时文件生命周期一起设计，当前不做。
- **上传中不允许发送**，而不是悄悄跳过未完成的附件。这样「点了发送但图没带上」不会发生；
  代价是弱网下要等一会儿，toast 会说明原因。
- **纯图片允许空正文**，但空正文 + 空附件仍然什么都不做（发送按钮保持原来的无反馈）。
- **发送失败保留附件**：正文在发送时已清空（原有行为），但附件留在当前会话名下，补一句
  文字就能重发；切走再回来也还在。

**验证**：

- `ui-attach.html` 新增 4 项：只有图片没有文字也能发（`text === ''`、`files` 带图片）、纯图片
  发送成功后清空附件、附件上传中先拦住不发 prompt、切到别的会话不带走附件且切回原会话
  恢复自己的附件。
- `smoke.sh` 新增 1 项静态锁：`attachCache` / 三个缓存函数、`selectSession()` 的存与取、
  `queueFiles()` 的 `owner`、上传中拦截、空正文与空附件才返回，以及 `ui-attach.html`
  的关键断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 361 → **362**，`ui-attach` 133 → **137**；其余套件计数不变；
全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-874.log`。

### 8.75 重开最近关闭的标签

**起因**：审计 A7。TUI 有 `session.tab.reopen`（`config/keybind.ts`），关掉的标签能按栈重开；
面板的 `×` 只把标签移出，关掉后除了从列表再点一次没有别的回头路，手机上尤其明显
（关掉最后一个标签后整条栏还会收起）。

**结论**：照 TUI 做一份**内存里的 last-closed 栈**，最近关的在前，最多 8 个；标签栏右侧加
一枚 `↺`（只在有可重开的标签时露出），命令面板加 `/tab-reopen`。重开时把这个会话加回
标签栏并切过去；如果它已经通过列表 / 深链回来了，就把栈里的旧记录划掉，不重复加。

**改动**：

| 位置 | 行为 |
|---|---|
| 关闭栈 | `CLOSED_MAX = 8`、`closedTabs = []`；`rememberClosedTab(id, title)` 把同一个 id 先去重再 `unshift`，超长 `pop`。只在内存，不写 `localStorage` —— 关标签本身不是持久状态 |
| 关闭 | `closeTab()` 在 `splice` 前记下 `id` 与标题快照（`store.sessions` 里的最新标题优先）；仍然只移出标签，不发 `DELETE`、不归档 |
| 重开 | `reopenTab()` 取栈顶，若已在 `store.tabs` 里就跳过，否则 `renderTabs()` 后 `await selectSession(id)`；栈空时 toast「没有可重开的标签」并返回 `false` |
| 标签栏 | `#tabReopen` 放在 `#tabStrip` 与 `+ 新建` 之间；`renderTabReopen()` 控制 `hidden` / `title`（带剩余条数）。`nav.hidden` 改成「没标签**且**没可重开的」才收起 —— 关掉最后一个标签后栏和 `↺` 都留着 |
| 去重 | `touchTab()` 一开始就把这个 id 从 `closedTabs` 里划掉：用户从列表 / 深链重新打开后，`/tab-reopen` 不会再白弹一次 |
| 命令 | `PANEL_COMMANDS` 加 `tab-reopen`（「重开最近关闭的标签」），`HELP_KEYS` 同步；手机可以直接点 `↺`，不用键盘 |
| 样式 | `#tabReopen` 与 `#tabNew` 同高、透明底、悬停变色；显式 `#tabReopen[hidden] { display: none; }`（id 选择器的 `display:flex` 会盖掉 UA 的 `[hidden]`）；窄屏 34px 宽、横屏跟着 30px 条走 |
| 失败 | 会话若在别处被删，重开仍走 `selectSession()` 的原错误路径（和其他入口一致）；`↺` 不会把它悄悄从栈里吞掉，重试或换下一个都行 |

**取舍**：

- **栈只在内存**。刷新 / 关页后「最近关闭」清空，但标签栏本身会从 `localStorage` 恢复；
  两者语义不同，和 TUI 的会话级栈一致。
- **关掉最后一个标签后栏不收起**。这和 §8.59 的「没有标签就整条 hidden」有一个可见变化：
  只要还有可重开的，栏就留一条（空 strip + `↺` + `+ 新建`），否则手机上关掉最后一个就再也
  点不回来了。两样都空时才完全收起。
- **重开会切过去**，不是只加回栏。命令名与 TUI `session.tab.reopen` 一致，行为也按「恢复并
  聚焦」理解；如果只想加回不切换，得再设计一个入口，当前不做。
- **最多 8 个**，与打开标签的上限一致；更早关闭的不再记，避免无限内存。
- **不持久化标题 / 顺序**：标题在重开时从 `store.sessions` 现取，列表里已更新的标题会跟上；
  会话不在当前 50 条里时先显示 id，`refreshSessionInfo()` 回来后由 `renderTabs()` 对账。

**验证**：

- `ui-capabilities.html` 新增 9 项：关闭非当前标签后进栈；`↺` / `/tab-reopen` 重开并切过去、
  重开后按钮藏起来；关掉最后一个标签后回到未选择但栏和 `↺` 留着；重开最后关掉的会话；
  再重开一个按倒序恢复；栈空时只提示不建标签；`PANEL_COMMANDS` 里有 `tab-reopen`；最近关闭
  最多 8 个且最近的在前；重复关闭去重并挪到最前。
- `ui-picks.html` 的命令面板断言加上 `/tab-reopen`（仍是 146 项，只改一条期望）。
- `smoke.sh` 新增 1 项静态锁：`CLOSED_MAX` / `closedTabs` / 三个函数、`closeTab()` 入栈、
  `touchTab()` 出栈、`nav.hidden` 的新条件、`#tabReopen` 的节点 / 样式 / 窄屏规则、
  `/tab-reopen` 命令与点击接线，以及 `ui-capabilities.html` 的关键断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 362 → **363**，`ui-capabilities` 174 → **183**，`ui-picks` 仍是 **146**
（只改一条期望）；其余套件计数不变；全量回归 **0 失败**，日志
`/tmp/ocsm-probe/perf/regress-875.log`。

### 8.76 切走前在最新,切回来还在最新

**起因**：实测反馈在两个标签之间来回切时，有时切回来停在中间，必须点一次「跳到最新」；
用户离开前明明一直贴着底。这不是「要不要记住位置」的问题，而是锚点只记了「顶部是哪条
消息 + 偏移」，没有记「当时是不是在底部」。

**结论**：滚动存档在消息锚点之外再带一个 `bottom` 标记；切回来时如果 `bottom` 为真，不再
按中间那条消息还原，而是直接重新贴底。离开期间新到的消息会把底继续往下推，贴住的就是
最新的底 —— 这正是「离开前看最新，回来还看最新」的语义。`bottom` 为假（真的往上翻了）
仍按消息锚点还原，不抢用户的位置。

**改动**：

| 位置 | 行为 |
|---|---|
| 存档 | `scrollAnchor()` 返回 `{id, off, top, bottom}`；`bottom: atBottom(box)`。空消息 / 没有可见消息的兜底也带同一个字段 |
| 还原 | `renderMessages()` 的 `pending` 分支拆成两条：`pending.bottom` → `pinBottom(box)`、`atB = true`、`pinned = true`（长会话继续走 `repinUntilStable()`）；否则照旧 `applyScrollAnchor(pending)` 后量一次 |
| 跟随态 | `pending.bottom` 分支最后喂给 `updateJumpLatest(true)`，`store.nearBottom` 回到「跟随中」；后续增量 / 流式消息继续贴底，不会因为离开过一次就停在中间 |
| 兼容 | 旧 `sessionStorage` 里的锚点没有 `bottom`，按 `undefined` 当「不是底部」，仍走原来的消息锚点还原；不需要清缓存 / 版本号 |
| 中间位置 | 用户往上翻、时间线跳转、点「跳到最新」都照旧：前两者存 `bottom:false`，后者贴底后存 `bottom:true` |

**取舍**：

- **离底 80px 内都算「在最新」**（沿用 `BOTTOM_SLACK`）。用户停在离底 79px 也会被当成
  跟随，切回来会贴到底；这是原有「跳到最新」按钮的同一口径，不另立标准。
- **离开期间有新消息就跟着到新底**，不会把用户按在旧消息的位置。只有离开前真的往上翻了，
  才按锚点留在原处 —— 两种意图分开，不靠猜。
- **不持久化「底部」以外的像素目标**：仍以消息锚点为主，`top` 只作消息被删 / 掉页时的兜底。
- **不改变首次打开行为**：没有存档仍然直接到底（§8.66 的 `forceBottom` 路径不动）。

**验证**：

- `ui-layout.html` 新增 3 项：贴底存档带 `bottom:true`、中间位置存档带 `bottom:false`、
  切到别的会话期间塞一条新消息再切回来仍在底部且 `store.nearBottom === true`。
- `smoke.sh` 新增 1 项静态锁：`scrollAnchor()` 的 `bottom: atBottom(box)`、`renderMessages()`
  的 `if (pending.bottom)` / `pinBottom()` / `atB = true` / `pinned = true`，以及
  `ui-layout.html` 的关键断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 363 → **364**，`ui-layout` 186 → **189**；其余套件计数不变；
全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-876.log`。

### 8.77 `/skills` 技能选择:插入 `@skill`,按 `prompt.skills` 发送

**起因**：TUI 的 `prompt.skills`（`component/prompt/index.tsx:583`）会弹 `DialogSkill`，
选中后把技能插进提示词；面板的 `@` 补全只请求 `/api/fs/find?type=file`，没有任何技能入口。
服务端 `GET /api/skill` 已验证返回 `{location,data:[{id,name,description}]}`，可以纯前端接上。

**结论**：新增面板命令 `/skills`，照 TUI 用 `#dlgPick` 列技能；选中后在输入框光标处插入
`@<id> `，并把它记进 `store.skillHits`。发送时技能走 `body.skills`，形状照
`PromptInfo.skills:[{id, mention:{start,end,text}}]`，**不混进 `files[]`** —— 服务端把它当文件
会 400，或者更糟，悄悄变成一个不存在的路径。`@` 文件补全保持原样，不在这里硬塞一个
「文件 / 技能」二选一的下拉。

**改动**：

| 位置 | 行为 |
|---|---|
| 命令 | `PANEL_COMMANDS` 加 `skills`（“插入技能(@skill,按 TUI 的 prompt.skills)”）；通过命令面板或直接敲 `/skills` 进入 |
| 列表 | `openSkillPick()` 用 `GET /api/skill?location[directory]=…` 拉当前工程技能；`name` 作 label，`description` 作 sub，开过滤框；失败 / 空列表只提示，不弹空框 |
| 插入 | `insertSkill(id,name)` 在光标处插 `@id `（前一个字符不是空白时先补一个空格），记进 `skillHits`，存草稿、画 chip、把焦点还给输入框；同一个技能已在正文里就不重复插 |
| 识别 | `resolveSkills(text)` 只认「选过且正文里还在」的 `@id`，产出 `{id,mention}`；正文里删掉 `@id` 就不再发送 |
| 与文件分流 | `resolveMentions()` 跳过 `skillHits` 里同名 token —— 同名技能优先，不会同一个 `@review` 又进 `skills[]` 又进 `files[]` |
| 会话隔离 | `skillHits` 和附件一样按会话放内存（`skillCache`）：切走再切回，草稿里的 `@skill` 仍按技能发；刷新后草稿文字还在，但选择记录不持久（和 `@` 文件引用一致） |
| 清理 | 发送成功、服务端命令 / 面板命令执行成功、`/clear` 都清掉当前技能；发送失败则保留，切回来还能重发 |

**取舍**：

- **不做 `@` 补全里的技能类型**：文件补全已经是「输入即出结果」的路径，混进技能要处理
  非文件语义、键盘选中和路径边界；`/skills` 与 TUI 的入口一致，先把它做对。
- **技能只认显式选择**：手打一个和技能同名的 `@foo` 不会变成 `skills[]`。这和 `@` 文件
  引用只认补全确认过的路径是同一套纪律：宁可当普通文字，也不发一个服务端没预期的 id。
- **只留当前工程**：请求带 `location[directory]`；跨工程切会话时技能列表重新取，不复用缓存。
- **不持久化**：`skillCache` 是内存，刷新 / 关页丢；正文里的 `@id` 仍在，但会退化成普通文字。
  要和草稿一样跨刷新，得连草稿的持久化语义一起设计，不在这一项里扩。

**验证**：

- `ui-picks.html` 新增 13 项：命令入口、标题 / 过滤框 / 请求参数、label 与 sub、插入位置、
  技能 chip、按会话切走再切回、`skills[]` 的 id / `mention` 偏移 / 文本、同名文件不分流、
  发送成功清理、正文删掉 `@skill` 后不带 `skills[]`、空列表不开框、未选中会话不开框。
- `smoke.sh` 新增 1 项静态锁：`openSkillPick` / `/api/skill` / `insertSkill` / `skills[]` /
  `resolveMentions()` 跳过技能 / 命令说明 / CSS chip 与浏览器断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 364 → **365**，`ui-picks` 146 → **159**；其余套件计数不变；
全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-877.log`。

### 8.78 探索工具组开关:折叠 / 逐条显示

**起因**：TUI 的 `session.toggle.exploration_grouping`（`routes/session/index.tsx:1071`）能在
`grouping="auto"` 与 `"none"` 之间切；面板的探索组永远按 `EXPLORE_MIN_RUN` 折，用户没有
「把工具调用逐条摊开」的入口。B3 拆成两半，这一项先做探索分组，思考块的全局折叠（TUI 的
`session.toggle.thinking`）留到后面。

**结论**：新增本机开关 `store.exploreGroup` 与命令 `/exploration`，默认开着（与 TUI 的
`grouping="auto"` 一致），选择写 `localStorage['ocs.exploreGroup']`（`'0'` = 关，其它 / 没存 = 开）。
关掉时两条渲染路径一起让路：同一助手消息内不再把相邻探索工具折成 `.explore`；跨消息的
纯探索续步也不再吸收，原来被藏成 hidden 占位的消息原地恢复成独立消息。

**改动**：

| 位置 | 行为 |
|---|---|
| 偏好 | `EXPLORE_GROUP_KEY = 'ocs.exploreGroup'`；`store.exploreGroup` 在模块加载时读一次，没存 / 读失败按 `true`，刷新后保持 |
| 命令 | `PANEL_COMMANDS` 加 `exploration`（“探索工具组:折叠 / 逐条显示”），帮助面板补 `/exploration`；TUI 这条动作的 keybind 本来就是 `none`，面板也不硬造快捷键 |
| 切换 | `setExploreGroup(on)` 写偏好；有选中会话就 `renderMessages()` 原地重画，不重新拉消息、不动 `store.messages` 与滚动锚点。`toggleExploreGroup()` 取反 |
| 单条消息 | `renderMessage()` 的探索分支加 `store.exploreGroup && isExploreTool(p)`；关掉后每条工具各自走 `toolHtml()` |
| 跨消息 | `exploreAbsorbPlan()` 在关掉时直接返回空表；`absorbed` 消息不再被换成 hidden 占位，正常渲染自己的助手头与脚注 |
| 恢复 | 已有占位不靠清空消息表：`renderMessages()` 发现 `rec.absorbed` 没了会重画该条并清掉占位状态；再打开则重新吸收 |

**取舍**：

- **只做探索分组，不动思考块**：TUI 的 thinking 是 `hide` / `show` 两档全局模式，牵动
  reasoning 的默认展开、组行与流式块；先交付一个不会误伤探索组、也不会改变思考内容的开关。
- **偏好放 localStorage，不写 `cli.json`**：TUI 的 `session.grouping` 走 config；面板没有
  这条会话配置通道，硬写 `cli.json` 会和 TUI 的 schema / 并发写纠缠。只影响本浏览器。
- **切换会重画消息 DOM**：已摊开的探索组 / 思考块会回到默认折叠状态；内容与 `store.messages`
  不变。要保留展开状态得给每个组做跨模式的稳定 key，当前不做。
- **不改数据、不改分页**：关掉只是换渲染方式；被吸收的续步在数据里一直是一条独立消息，
  所以恢复不需要请求服务端。

**验证**：

- `ui-tools.html` 新增 9 项：写 `localStorage=0`、单条消息逐条显示、跨消息不吸收、续步恢复
  独立消息、命令面板入口、写回 `=1`、恢复并组、已有占位原地关掉 / 原地再打开。
- `smoke.sh` 新增 1 项静态锁：`EXPLORE_GROUP_KEY` / `store.exploreGroup` 读取 / `setExploreGroup` /
  `toggleExploreGroup` / 吸收短路 / 渲染条件 / 命令与帮助文案、以及 `ui-tools.html` 的两条
  原地切换断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 365 → **366**，`ui-tools` 348 → **357**；其余套件计数不变；
全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-878.log`。

### 8.79 `/mcps`:MCP 服务器只读列表

**起因**：TUI 的 `mcp.list`（`app.tsx:924`）弹 `DialogMcp`，面板完全没有 MCP 入口；B4 先做
只读列表，不做连接 / 断开 / 增删。`GET /api/mcp` 已验证可用，返回
`{location,data:[{name,status:{status,error?},integrationID?}]}`；当前现场是空数组。

**结论**：新增命令 `/mcps`，用 `#dlgPick` 列名称、状态和失败原因；有选中会话时带
`location[directory]`，没选中会话时按 TUI 的 `mcp.list` 看服务端全局列表（不带 location）。
空列表只 toast「没有配置 MCP 服务器」，不弹空框。

**改动**：

| 位置 | 行为 |
|---|---|
| 命令 | `PANEL_COMMANDS` 加 `mcps`（“MCP 服务器与连接状态(只读)”），帮助面板补 `/mcps` |
| 请求 | `openMcpPick()` 走 `GET /api/mcp`，选中会话时查询 `location[directory]`；异常 toast，不抛到控制台 |
| 列表 | 标题带数量；`name` 作 label；`status.status` 翻成中文（已连接 / 连接中 / 已禁用 / 连接失败 / 需要授权），`failed` / `needs_auth` 的 `error` 跟在状态后面；开过滤框，名称和状态都参与过滤 |
| 只读 | `openPick({readonly:true})`：底部写“↑↓ 浏览 · Esc 关闭”，点击 / Enter 不回调、不关框；`pickReadonly` 只在打开时置位，普通选择框照旧 |
| 不做的 | 不接 `/api/experimental/mcp/:server` 的 connect / disconnect / add / remove，也不展示工具数（`/api/mcp` 没有 tool 字段，不编假计数） |

**取舍**：

- **只读**：连接 / 断开会改服务端运行时状态，且在 TUI 里还有配置落盘；面板先把“有哪些
  服务器、现在什么状态”交代清楚，写操作另起一项。
- **没有工具数**：服务端 `Mcp.Server` 只有 name / status / integrationID；唯一相关接口
  `/api/mcp/resource` 是资源目录，不是工具表。与其猜一个数字，不如只报能确认的状态。
- **快照，不自动刷新**：每次 `/mcps` 重新拉；列表开着时状态变化不会自己重画。MCP 的
  `mcp.status.changed` 事件没有在这条路上接，避免为一个只读列表再加一条 SSE 订阅。
- **只读列表不提供“选中”动作**：点击 / Enter 没有副作用，底部也就不写“Enter 选中”；
  要关框走 Esc 或关闭按钮。

**验证**：

- `ui-picks.html` 新增 10 项：标题数量、过滤框、请求参数、名称顺序、五种状态与错误原因、
  只读底部文案、点击不回调不关框、命令入口、未选中会话时走全局列表、空列表只提示。
- `smoke.sh` 新增 1 项静态锁：`openMcpPick` / `/api/mcp` / `mcpStatusLabel` / 只读脚注 /
  `pickChoose` 的只读短路 / `/mcps` 命令与帮助文案，以及 `ui-picks.html` 的关键断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 366 → **367**，`ui-picks` 159 → **169**；其余套件计数不变；
全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-879.log`。

### 8.80 导出:默认 Markdown 转录,JSON 保留脱敏

**起因**：TUI 的 `session.export`（`routes/session/index.tsx:1201`）先弹 `DialogExportOptions`，
可选 JSON / Markdown，Markdown 还能选 thinking / tools；面板的 `#dlgExport` 只有 JSON +
脱敏。B5 先补 Markdown 与格式选择，thinking / tools 开关随后。

**结论**：导出对话框默认 Markdown（与 TUI 一致），JSON 作为第二种格式保留原来的
`sanitize` 选项。Markdown 复用 §8.72 的 `transcriptText()`（用户 + 助手正文 + 工具摘要，
不含思考），走同一个 export 接口，下载成 `.md`；JSON 仍是 `{data:{info,messages}}` 原始载荷。

**改动**：

| 位置 | 行为 |
|---|---|
| 对话框 | `#exportFormats` 两个 radio：Markdown（默认）/ JSON；`#exportSanitizeRow` 只在 JSON 时显示（`syncExportForm()`） |
| 打开 | `openExport()` 每次复位成 Markdown、脱敏勾选、清错误，避免上次选的 JSON 留在那里 |
| 请求 | 两种格式都走 `GET /api/experimental/session/:id/export`；Markdown 固定 `sanitize=false`（它本来就不带 metadata），JSON 按勾选发 `true` / `false` |
| Markdown | `transcriptText(d.info || s, d.messages || [])` → `downloadText(name, md, 'text/markdown;charset=utf-8')`；文件名 `标题-ses_x.md`，无标题用 `session-ses_x.md` |
| JSON | 保持原行为：`JSON.stringify({data}, null, 2)`、`.json`、脱敏时文件名不带标题 |
| 空转录 | Markdown 没有可导出的正文时在对话框里报「这个会话还没有可导出的正文」，不下载空文件 |

**取舍**：

- **先只做格式**：TUI 的 thinking / tools 两个开关会改变 `formatSessionTranscript` 的参数；
  面板的 `transcriptText()` 目前固定「不含思考、带工具摘要」，先把这个默认行为交付，
  两个开关单独一项做，免得一次改导出、复制、转录三处。
- **工具只留摘要**：Markdown 里的工具行是 §8.72 的摘要（名字 + 关键参数 + 错误标记），
  不是 TUI 的完整 input / output 代码块；完整内容仍在 JSON 里。纯文本导出先保证可读。
- **直接下载，不写临时文件**：TUI 写 tmpdir 再弹路径对话框；浏览器有下载目录，直接
  `Blob` + `<a download>` 更符合页面习惯，也不需要在服务端写文件。
- **Markdown 不脱敏**：它的契约是完整转录；`sanitize` 只属于 JSON 原始载荷。要脱敏的
  会话标题 / 目录不会进 Markdown 的正文，但标题本身仍会出现在文件头，这是转录语义。
- **每次打开复位 Markdown**：照 TUI 的 `DialogExportOptions` 初始值；不把格式写进 local
  storage，避免下次误导出。

**验证**：

- `ui-capabilities.html` 新增 7 项：默认 Markdown、Markdown 隐藏脱敏并提示不含思考、
  Markdown 请求 `sanitize=false`、文件名 `.md`、正文是转录不是 JSON、MIME 是
  `text/markdown`、切 JSON 后脱敏勾选与完整内容提示回来。
- `smoke.sh` 新增 1 项静态锁：`exportFormat` / `syncExportForm` / `setupExport` /
  `downloadText` / Markdown 分支调用 `transcriptText`、radio 与隐藏样式、命令说明，以及
  `ui-capabilities.html` 的关键断言都在。
- `node --check public/app.js` 通过。

**回归**：`smoke.sh` 367 → **368**，`ui-capabilities` 183 → **190**；其余套件计数不变；
全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-880.log`。

### 8.81 `/status`：连接 / 配置 / Provider / MCP 只读摘要

**起因**：TUI 有 `opencode.status`（`app.tsx:1013`）和 `opencode.debug`（`:1079`）；面板只有
顶栏的 `/__health` 连接灯，没有版本、服务地址、配置摘要，也没有 provider / MCP 总览。
B6 先做只读的 `/status`，不碰调试日志和写操作。

**结论**：新增 `/status`，弹一个只读的两列表格：健康（连接 / 地址 / 版本 / 鉴权 /
配置目录 / 附件暂存 / Diff 视图）、当前工程、配置文档摘要（路径、Provider / 模型数、
默认模型、MCP 配置数）、MCP 运行摘要（总数 / 已连接 / 异常）。三个请求各自容错：哪个读不到
就只占自己那行，不把整张表打空。

**改动**：

| 位置 | 行为 |
|---|---|
| 服务端 | `/__health` 增加 `version`（`require('./package.json').version`），旧代理没有这个字段时前端不画版本行 |
| 命令 | `PANEL_COMMANDS` 加 `status`，帮助面板补 `/status`；选中会话时 config / mcp 都带 `location[directory]`，没选中时不带 |
| 对话框 | 新增 `#dlgStatus` / `#statusBody`；`statusRowHtml()` 输出标签 + 值，长路径和模型名用 `pre-wrap` / `anywhere` 折行；手机只收窄标签列 |
| health | `本地代理` 写「已连接 / 未连接 · HTTP 200」、`服务地址`、`面板版本`、`鉴权`、`配置目录`、`附件暂存`、`Diff 视图`；`鉴权` 只报「Basic 已启用（密码不显示）」，密码原值永不进 DOM |
| 配置 | `configSummary()` 遍历 `/api/config` 的 document：路径去重；provider 按 ID 去重（同一层带名字时优先留名字）；模型按 `provider/model` 去重；MCP 配置按名称去重；默认模型取 `info.model` |
| MCP | 复用 §8.79 的 `/api/mcp`，只报数量 / 已连接 / 异常（`failed` + `needs_auth`）；具体错误仍去 `/mcps` 看 |
| 失败 | `health` / `config` / `mcp` 各自 catch，失败行写服务端原话；例如配置失败时健康与 MCP 摘要照常显示 |

**取舍**：

- **只读、不自动刷新**：每次 `/status` 重新拉一次；对话框开着时健康或 MCP 状态变化不会
  自己重画。要盯变化还是看顶栏连接灯和 `/mcps`。
- **不暴露秘密**：只显示 `hasPassword` 的真假，不显示密码、Authorization、provider 的
  `settings.baseURL` / API key，也不把 `/api/config` 的原始 JSON 倒进页面。配置摘要只到
  「几个 provider / 几个模型 / 几个 MCP」这一层。
- **版本是面板代理的版本，不是 OpenCode 服务版本**：`/__health` 本来就是本地代理自己的
  健康接口；OpenCode 的 `/api` 没有稳定的 version 端点，不猜。旧代理没重启时这一行不显示。
- **不做 `opencode.debug`**：日志 / 事件流 / 内部状态是另一类数据，先不混进状态表。

**验证**：

- `ui-capabilities.html` 新增 10 项：健康 / 版本 / 地址 / 鉴权文案、配置路径与去重后的
  provider / 模型 / MCP 计数、MCP 运行计数、当前工程带 `location`、未选中时不带、
  配置失败不影响其它行、health 失败仍能看配置、MCP 失败只占自己行、空 MCP 写 0 个、
  命令入口。
- `smoke.sh` 新增 1 项静态锁：`openStatus` / `configSummary` / 两个 location 参数 /
  密码保护文案 / `/status` 命令与帮助 / `/__health.version` / 对话框与窄屏样式，以及
  `ui-capabilities.html` 的关键断言都在。
- `node --check public/app.js`、`node --check server.js` 通过；`/__health` 多一个字段不影响
  `config-e2e` 的既有断言。

**回归**：`smoke.sh` 368 → **369**，`ui-capabilities` 190 → **200**；其余套件计数不变；
全量回归 **0 失败**，日志 `/tmp/ocsm-probe/perf/regress-881.log`。

### 8.82 流式增量按帧合并 + 光标原地追加

**起因**：高频 token 流里每个 `session.text.delta` 都会同步跑一遍 `md()`、`innerHTML`
和贴底；另外 `paintLiveText()` 为了把光标放进最后一个块，会先 `cursorInto()` 建临时节点
解析整段 HTML，再序列化，最后 `innerHTML` 又解析一次。两件事都不是 GPU 问题，先把主线程
上重复的同步工作压掉。

**结论**：事件入口只把文本增量排进 `requestAnimationFrame`，同一帧多个 delta 合成一次
`paintLiveDelta()`；光标改成在已经渲染好的节点里原地追加，不再二次解析整段 HTML。

**改动**：

| 位置 | 行为 |
|---|---|
| 调度 | 新增 `scheduleLivePaint()` / `cancelScheduledLivePaint()`；`livePaintRaf` 保证一帧最多排一次，事件入口 `else if (local) scheduleLivePaint()` |
| 收口 | `renderMessages()` 开头取消待执行的帧；手动调用 `paintLiveDelta()`（测试 / 收尾）也会先取消排队帧，避免重复绘制 |
| 光标 | 抽出 `appendCursor(host)`，在现有 DOM 里找最后一个 `p` / `li` / `pre` / 标题 / 单元格并追加；`paintLiveText()` 先 `innerHTML = body`，再原地追加 |
| 初始渲染 | `cursorInto(html)` 继续复用 `appendCursor()`，行为和原来一致 |

**取舍**：

- **最多晚一帧**：delta 不再逐 token 立刻上屏，正常 60fps 下用户感知不到；隐藏标签页里
  `requestAnimationFrame` 会暂停，内容留在本地缓冲，回到前台或切会话时由整表重绘补齐。
- **只合并文本增量**：结构变化（新 part、工具状态、`*.ended` 等）仍走原来的整条重绘路径，
  不把结构事件塞进这一帧队列。
- **不改 Markdown 解析器**：`md()` 仍按整块重解析；这次只去掉每帧重复调度和光标那次多余
  的 HTML 往返。真正要把解析移出主线程，得另做 Worker，属于下一阶段。

**验证**：

- `ui-stream.html` 新增 1 项：同一帧连续两个 delta 时，绘制函数在帧回调前调用 0 次、
  回调后只调用 1 次，且文本已合并进 DOM；`feed()` 仍同步 flush，原有 259 项语义不变。
- `smoke.sh` 新增 2 项静态锁：事件入口接 `scheduleLivePaint()` / `paintLiveDelta()` 会收掉
  排队帧；`paintLiveText()` 走 `appendCursor(node)` 而不走 `cursorInto(body)`。
- `node --check public/app.js` 通过；全量回归 **0 失败，1 跳过**，日志
  `/tmp/ocsm-probe/perf/regress-882.log`。

**回归**：`smoke.sh` 369 → **371**，`ui-stream` 259 → **260**；其余套件计数不变。

---

### 8.83 工具卡正文懒渲染（长会话性能）

§8.82 之后再用合成数据量了一轮：真正拖慢长会话首屏的不是 `md()`，而是工具卡的
diff / write 正文。100 条消息、75 张 edit 卡（每张 3 个文件、每文件 20 行上下文）时，
整表 `renderMessages()` 约 **475ms / 45,950 个节点**；只先画 summary 壳时降到
**43–55ms / 1,775 个节点**。300 条同形状消息从 **1,344ms / 137,850 个节点** 降到
**87–120ms / 5,325 个节点**。

**结论**：不做 Worker 解析，也不做整表虚拟化；只做工具卡正文这一层的懒渲染。
`md()` 本身很便宜，Worker 往返不划算；整表虚拟化会动 `msgEls`、滚动锚点和现有面板
功能，收益却主要在少建 DOM。工具卡正文懒渲染可以只改渲染路径，消息壳与锚点保持原样。

**触发门槛**：

| 条件 | 值 | 目的 |
|---|---:|---|
| 单卡正文 | ≥ 2KB | 小 diff / 小 write 继续完整渲染，不为一张小卡付 observer 成本 |
| 整段会话正文合计 | ≥ 32KB | 短会话和普通文本会话完全不走这条路 |

`renderMessages()` 在渲染前扫一遍工具 part 的 `patch` / `write` 正文字节数，决定这次
是否开启；直接调用 `renderMessage()` 默认不开启，原有单元测试和短会话语义不变。

**渲染与补正文**：

- `edit` / `patch` / 大 `write` 卡先输出原来的 `<details class="tool" data-def="1" open>`
  和 summary，`.toolbody` 留空，挂 `data-lazy-tool="<id>"`；summary 的图标、路径、增删
  统计与完整渲染一致。
- 抽出 `toolBodyHtml(p)`，完整渲染和补正文共用同一段 diff / code / 诊断 HTML，避免两套
  逻辑漂移。
- 单个 `IntersectionObserver` 以 `#messages` 为 root、`rootMargin: 300px 0px`；进入范围
  后排队，**一帧只补一张**，只设置 `.toolbody.innerHTML` 并去掉 `.lazy`，不替换
  `<details>` 节点，展开状态和 `msgEls` 身份都不动。
- 在视口上方的卡补正文前记 `scrollAnchor()`，补完 `applyScrollAnchor()`；视口内 / 下方
  不付这次读布局的钱。底部仍交给 `repinUntilStable()` 和 `ResizeObserver`。
- 没有 `IntersectionObserver` 或 `requestAnimationFrame` 时直接退回完整渲染；不会留下
  永远空着的卡。

**取舍**：

- 最多晚几帧看到离屏 / 刚进预加载范围的卡正文；可见的第一屏会逐帧补上。
- 单张大 diff 卡补正文仍可能占掉接近一帧；所以不把多张压进同一帧。
- 只懒工具正文，不懒消息文本、思考块、探索组；这些不是这次实测的大头。

**验证**：

- `ui-tools.html` 新增 11 项：懒壳、空正文、首屏无 diff、默认展开 / `data-def`、首屏
  节点数、一帧一张、可见卡补正文、不替换 `details`、中段锚点漂移 ≤1px、直接
  `renderMessage()` 完整、短会话不启用。
- `smoke.sh` 新增 4 项静态锁：门槛与 `toolBodyHtml`、observer + 一帧一张 + 收尾接线、
  无 API 降级 + 直接渲染默认完整、`ui-tools` 行为断言。
- 合成探针只读、使用临时数据，未改仓库、未碰真实会话；最终仍需真实会话回归确认锚点。

**回归**：`smoke.sh` 371 → **375**，`ui-tools` 357 → **368**；`ui-stream` 260、
`ui-layout` 189 不变。全量回归 **0 失败，1 跳过**。

### 8.84 断流后的收尾对账（页面空闲但内容旧）

**现象**：用户报“有时候会卡住，进度条不动，可能已经跑完了，但对话框内容没更新到最新，
点浏览器刷新才恢复”。截图里会话头已经是“空闲”。

**根因不是渲染，而是收尾没有落地**：

- `EventSource` 在 TCP 半开（浏览器以为还连着、实际一个字节都收不到）时不会触发
  `onerror`，浏览器也就不会自动重连；此时 8s 的 `loadActive()` 是唯一的眼睛。
- 原来 `loadActive()` 只把 `store.active` 换成新快照：看到运行→空闲时熄掉状态条，
  却不重新拉消息，最后一轮就停在断流前的快照里。
- 收尾那次 `loadMessages({auto:true})` 失败后直接 `return`；空闲后通常不再有事件
  把它叫醒，于是一直旧到手动刷新。
- 消息请求没有超时。一条悬挂的请求会永久占住 `msgLoadBusy`，后续事件对账全被合并 /
  排队，永远落不了地。
- 服务端可能先发 `session.idle`、稍后才把最终消息落盘；150ms 那次对账可能拉早了，
  之后又没有事件再补。

**修法**：

| 位置 | 行为 |
|---|---|
| `loadMessages()` | 每次尝试单独 `AbortController`；内网 30s / 慢链路 120s 超时，超时按可重试失败处理 |
| `loadMessages()` 后台失败 | 2s / 5s / 10s / 20s 四档退避；4xx 不重试；成功清掉 `msgStale` |
| `loadActive()` | 当前会话运行→空闲时立刻 `loadMessages({auto:true, now:true})`，绕过间隔并顶掉在途请求；压缩中途 active 空一拍不算收工 |
| `loadActive()` 空闲兜底 | `msgStale` 还在且最近 12s 没对过账时继续拉，直到成功 |
| 收工事件 | `session.idle` / `execution.succeeded` / `execution.failed` 后 1.5s 再看一眼；`turnLooksUnsettled()` 只认“最后是用户消息 / 助手未 completed / 本地流式缓冲还在 / 压缩进行中” |
| SSE 看门狗 | 页面可见且有活跃会话时，45s 没有事件就关闭并重开 `EventSource`；空闲时安静是正常的，不误判。重连后的 `server.connected` 走已有补拉 |

**取舍**：

- 正常收工时，1.5s 的收尾检查只读内存、不联网；只有画面确实“像没跑完”才多拉一页。
- SSE 静默但工具只是长时间无输出时，45s 会多一次重连；重连幂等，消息以服务端为准。
- 超时阈值偏保守（慢链路 120s），避免十几 MB 的首屏在 VPN 上被误杀。

**验证**：

- `ui-controls.html` 新增 6 项：运行→空闲立刻补拉、一直空闲不重复拉、事件流建立、
  45s 重连、重连推进最后事件时间、空闲不重连。
- `ui-stream.html` 新增 4 项：收尾三种判定（用户 / 助手 completed / 本地缓冲）与
  `session.idle` 的 1.5s 定时器。
- `ui-jump.html` 新增 9 项：后台连败后自动再试、成功后清 `msgStale`、4xx 不重试、
  悬挂超时后继续重试、超时后 `msgLoadBusy` 复位、最后用户消息补拉、已完成不多拉。
- `smoke.sh` 新增 5 项静态锁：超时 / 退避 / 4xx 分流、运行→空闲补拉、延迟收尾、
  SSE 看门狗、`ui-jump` 行为断言。

**回归**：`smoke.sh` 375 → **380**，`ui-controls` 102 → **108**，`ui-jump`
135 → **144**，`ui-stream` 260 → **264**；`ui-tools` 368、`ui-layout` 189 不变。
全量回归 **0 失败，1 跳过**。

### 8.85 思考阶段上下文百分比超过 100%

**现象**：多步回合里，第二段思考开始后，输入框下面的 `N% ctx` 会超过 100%，
回合结束又回落。

**根因**：`session.usage.updated` 的 `tokens` 是服务端 session 行里的**累计用量**
（每步 `input/output/reasoning/cache.read/cache.write` 都用 `+` 累加），不是当前
这一步的用量。面板原先把这条事件写进所有 open 的 live 消息；`contextUsage()` 又取
最后一条带 `tokens` 的助手消息，于是拿整个会话的累计值去除以 `limit.context`，
多步后必然越界。`session.step.ended` 才是每一步的用量。

**修法**：

- `handleStreamEvent()` 不再处理 `usage.updated` 的 `tokens/cost`（返回 false，
  不触发 live 重绘）。
- `handleControlEvent()` 把累计 `tokens/cost` 并进 `store.sessions`，只用于会话列表
  与提示栏费用；不新建未知会话，避免子会话被塞进主列表。
- live 消息的 `tokens/cost` 只认 `session.step.ended`；思考阶段 ctx 继续显示上一条
  已完成 step 的值，没有就收起。

**验证**：

- `ui-stream.html` 新增 6 项：上一轮 50% 基线、思考中仍看上一条、累计
  `usage.updated` 不写 live、ctx 不被顶过 100%、会话级累计值仍更新、
  `step.ended` 后按每步 75% 更新。
- `ui-controls.html` 新增 2 项：累计值并进会话对象、live 消息不被碰。
- `smoke.sh` 新增 1 项静态锁：`usage.updated` 分支只 `return false`，控制分支写
  `patch.tokens/cost`。

**回归**：`smoke.sh` 380 → **381**，`ui-controls` 108 → **110**，`ui-stream`
264 → **270**；`ui-jump` 144、`ui-tools` 368、`ui-layout` 189 不变。全量回归
**0 失败，2 个可选真实模型用例跳过**。

### 8.86 手机上滑查看旧内容时被持续输出拽回最新

**现象**：手机浏览器里手指向下滑，想查看上面的会话内容；在串口工具这类持续输出
的会话里，有时滑不动，滑上去又自动跳回最新。

**根因**：`updateJumpLatest()` 原先把 `atBottom()` 放在前面。`BOTTOM_SLACK = 80`，
所以离底 30px 的小幅上滑仍被判定为「在底部」；串口输出每次到达又走
`renderMessages()` / 增量贴底，把人拉回底部。即使一次滑过 80px，下一次渲染只要
还在容差内也会重新判成跟随。触摸的 `scroll` 事件还可能晚于输出的重绘，单靠
`scroll` 来不及让路。

**修法**：

- `updateJumpLatest()` 改成上滑优先：`scrollTop` 比 `store.lastTop` 小就立即停止
  跟随，哪怕还在 `BOTTOM_SLACK` 内；只有真正回到底部（`BOTTOM_EXACT = 2`）或用户
  向下滚回底部附近才恢复。内容变长 / 容器变矮仍维持原状态。
- 给 `#messages` 补 `touchstart` / `touchmove`：手指向下（`clientY` 增大）累计
  超过 2px 时立刻 `updateJumpLatest(false)`，不等 `scroll` 事件；滚轮 `deltaY < 0`
  同理。反向滑动不拦，交给 `scroll` 事件。
- 增量重绘 / `ResizeObserver` 继续只认 `store.nearBottom` 缓存，不再每帧读
  `scrollHeight`；手势已经把缓存关掉，串口输出到达时自然不会再贴底。

**验证**：

- `ui-jump.html` 新增 7 项：上滑 30px（仍在 80px 内）立即让路、随后新内容不拽回、
  按钮仍露着、手指下滑在 `touchmove` 里先让路、串口式增量不抢先贴底、增量后仍
  不跟随，以及原有贴底 / 容器变矮行为不变。
- `smoke.sh` 新增 1 项静态锁：上滑优先 + 下滚回底恢复；触摸下拖的早让路接线在。

**回归**：`smoke.sh` 381 → **382**，`ui-jump` 144 → **151**；`ui-controls` 110、
`ui-stream` 270、`ui-tools` 368、`ui-layout` 189 不变。全量回归 **0 失败，2 个可选
真实模型用例跳过**。

### 8.87 Ctrl+C 清空输入（对齐 TUI `prompt.clear`）

**背景**：TUI 的 `prompt.clear` 键位是 `ctrl+c`；输入框有内容时按 Ctrl+C 会清空。
面板 I 组最早**明确不做**这条，理由是浏览器里 Ctrl+C 还要负责复制，直接清空会把复制
弄坏。现在把两件事拆开：只在输入框聚焦、正文非空、且**没有选中文本**时接管；有选区时
让浏览器照常复制，`Meta+C`（Mac 复制）也不拦。

**行为**：

- `#input` 聚焦、有内容、无选区：`preventDefault()` → `clearInput()`。同时清掉当前
  会话草稿与 `@skill` 选择，退出输入历史，收起命令面板 / `@` 补全，并撤掉 Esc 上膛。
- 有选中文本：不拦，Ctrl+C 仍是复制。
- `Meta+C`：不拦（Mac 复制）。
- 输入框为空：不拦，保持浏览器默认。
- 不接全局 Ctrl+C：焦点在消息区 / 其他输入框时，不会误清草稿；复制页面文字照旧。

**验证**：

- `ui-commands.html` 新增 10 项：有内容清空、收命令面板、草稿清掉、`↑` 进历史前置、
  退出输入历史、有选区不抢复制、`Cmd+C` 不清空、空输入不拦、Esc 上膛前置、清空撤掉上膛。
- `smoke.sh` 新增 1 项静态锁：`Ctrl+C` 的 copy-safe 条件与 `clearInput()` 接线在。

**回归**：`smoke.sh` 382 → **383**，`ui-commands` 171 → **181**；其余套件不变。
全量回归 **0 失败，2 个可选真实模型用例跳过**。

### 8.88 收工后 pending 清掉，进度条不再空转

**背景**：面板自己发消息时会先置 `store.pending = true`，用来在服务端还没回状态前
把「已发出」画出来。原先把「这一轮结束了」只押在消息列表最后一条是 `idle` 上；
现在服务端不一定再补这条 `idle` 消息，于是收工事件已经把 `store.active` 清掉，
`store.pending` 却一直留着，`store.running` 跟着永远为 true —— 用户看到对话和 token
脚注都收完了，标题还是「● 运行中」、底部进度条还在动。

**行为**：

- `renderMessages()` 不再自己拼 `pending || streaming || compacting || live`，统一走
  `recomputeRunning(msgs)`；口径只有一处。
- 收工事件（`session.idle`、`session.status` 的非 busy / retry、以及
  `session.execution.succeeded` / `failed` / `interrupted`）调用 `markTurnDone(sid)`：
  只对当前选中会话清掉 `pending`，马上重算 `store.running`，再走原来的 `updateChatStatus()`。
- `session.execution.started` 不清 `pending`；别的会话的收工事件也不动当前会话。
- `loadActive()` 的「运行中 → 空闲」兜底同样调用 `markTurnDone()`：SSE 收工事件整条
  丢了时，8 秒轮询也能把进度条熄掉。
- 如果收工事件到达时本地流式缓冲还没被服务端权威消息替换，`recomputeRunning()` 仍会
  返回运行中；等消息对账落地后再熄，不抢在正文前面装空闲。

**验证**：

- `ui-controls.html` 新增 19 项：五种收工事件都清 pending、重算 running、显示空闲；
  `execution.started` 不清；别的会话的 `session.idle` 不动当前会话；`loadActive` 的
  「运行→空闲」兜底也清 pending、重算 running。
- `ui-stream.html` 新增 5 项：pending 期间仍显示运行中；`execution.succeeded` 后
  pending 清掉、running 为 false、头部「空闲」、进度条收起。
- `smoke.sh` 新增 1 项静态锁：`recomputeRunning()` / `markTurnDone()` 与
  `loadActive` 兜底接线都在。

**回归**：`smoke.sh` 383 → **384**，`ui-controls` 110 → **129**，
`ui-stream` 270 → **275**；`ui-commands` 181、`ui-jump` 151、`ui-layout` 189、
`ui-tools` 368 不变。全量回归 **0 失败，2 个可选真实模型用例跳过**。

### 8.89 粘贴绝对路径不再误弹命令面板

**背景**：在输入框粘贴 `/media/example/.../imx-gesture-classify` 这样的绝对路径时，
面板把行首的 `/` 当成命令查询词，接着渲染出「没有匹配的命令」；TUI 不会。TUI 的
自动补全判定（`W4`）在第一个 `/` 之后再次遇到 `/` 就返回「不是命令」，所以路径根本
不会打开补全。发送本身两边都没问题：未命中命令表的 `/...` 仍按普通消息发送。

**行为**：

- 自动弹出（输入触发）时，查询词里包含 `/` 的，只有它确实是某个已注册命令名的
  **前缀**才打开面板；否则按路径处理，直接收起命令面板。
- 已注册的嵌套命令（如 `team/review`）仍可正常补全；路径里只是含有 `review`
  这样的词不会误命中。
- `Ctrl+P` 是显式打开命令面板，不受这条限制。
- `cmdQuery()` / `parseCommand()` 的解析规则不变；粘贴的路径仍作为普通消息发送。

**验证**：

- `ui-commands.html` 新增 4 项：用户给的绝对路径不弹、路径里带命令名也不误弹、
  `Ctrl+P` 对绝对路径仍显式打开、已注册的嵌套命令照常补全。
- `smoke.sh` 新增 1 项静态锁：路径分支与「已注册命令前缀」判断都在。

**回归**：`smoke.sh` 384 → **385**，`ui-commands` 181 → **185**；其余套件不变。
全量回归 **0 失败，2 个可选真实模型用例跳过**。

### 8.90 `@` 文件补全对齐 TUI 的触发边界

**背景**：输入密码/邮箱 `user@123` 时，面板把 `@123` 当成文件引用，弹出补全列表；
回车被列表截走，消息发不出去。TUI 不会：它的 `mentionTriggerIndex` 只在 `@` 位于行首
或空白后、且 `@` 到光标之间没有空白时，才认为这是文件引用入口。

**行为**：

- 照 TUI 的通用 token 边界判定，不维护“哪些字符后面不触发”的黑名单：
  `user@123`、`a@b.com`、`看@Makefile`、`foo/@bar` 都因为 `@` 不是新 token 的开头
  而不触发；`@Makefile`、`hello @Mak`、`@a @b`（取最后一个 `@`）照常补全。
- 保留面板原有的 200 字符查询上限，只作为超长请求保护。
- 补全打开时的 Enter/Tab/Esc 优先级不变；普通文本里的 `@` 不再弹列表后，Enter 正常发送。

**验证**：

- `ui-attach.html` 新增 6 项：邮箱/密码、邮箱地址、紧贴中文、紧贴路径分隔符、紧贴标点
  都不触发；邮箱/密码形态不请求 `fs/find`、不显示补全。
- `smoke.sh` 新增 1 项静态锁：`mentionAtTokenStart` / `before.lastIndexOf` 都在。

**回归**：`smoke.sh` 385 → **386**，`ui-attach` 137 → **143**；其余套件不变。
全量回归 **0 失败，2 个可选真实模型用例跳过**。

---

### 8.91 大会话标签切换不再反复整表重绘 / 全量拉取

**背景**：用户反馈标签页切换有点卡，尤其点“串口工具”这个会话。合成探针复现：
10.1MB 的串口式大会话，缓存过期时一次切回约 **418ms**，其中首次整表重绘 127ms、
`renderControls()` 补的第二次重绘 71ms、全量消息回来后的第三次重绘再加约 200ms；
缓存命中也要约 **172ms**。小会话同一探针只有约 22–49ms。

**根因**：

- `selectSession()` 每次都清空 `#messages` / `msgEls`，缓存命中也要把整张消息表重建一遍；
  串口的长工具输出因此每次都要重新转义、排版。
- `renderControls()` 在模型表已经缓存、当前模型也查得到时，仍会补一次
  `renderMessages()`，只为让脚注重新查模型名；这次重绘在大会话上要整表签一遍名。
- 缓存只保鲜 1.5 秒。像“17 小时前更新”的空闲串口会话，每次点标签都会重新拉整页
  MB 级消息，回来再重绘一次。

**行为**：

- `renderControls()` 只在“模型表首次为这个目录加载”或“当前模型不在索引里”时
  补 `renderMessages()`；同一目录同一模型的后续切换不再重复重绘。
- shell 大输出复用 §8.83 的工具卡懒渲染：单卡输出 ≥2KB、且整个会话工具正文
  ≥32KB 时，先画摘要壳，进入消息区预加载范围后一帧补一张正文。edit / patch / write
  的行为不变；直接 `renderMessage()`、短会话和小卡仍完整渲染。
- 缓存快照多记一个 `session.time.updated`。切回时若缓存存在、会话摘要没有变新
  （`session.time.updated <= cached.updated`）且会话不在运行 / 压缩中，就直接用缓存，
  不再发整页对账；会话摘要变新、正在运行、或缓存不存在时照旧拉取。
- 不新增接口、不改服务端；不用 Worker / 整表虚拟化；标签栏和布局规则不变。

**验证**：

- `ui-controls.html` 新增 2 项：模型表首次加载后补一次脚注重绘；同目录同模型第二次
  `renderControls()` 不再调用 `renderMessages()`。
- `ui-tools.html` 新增 6 项：大 shell 卡先出空正文懒壳、输出字符数计入单卡 / 总会话
  门槛、不懒时仍完整出 `<pre>`；整表渲染时串口式大会话首屏只出懒壳，进入视口后补正文。
- `ui-jump.html` 新增 1 项：缓存旧了但会话摘要没更新时，切回不再发消息请求。
- `smoke.sh` 新增 3 项静态锁：条件重绘、shell 懒渲染、缓存摘要比较都在。

**回归**：`smoke.sh` 386 → **389**，`ui-controls` 129 → **131**，
`ui-tools` 368 → **374**，`ui-jump` 151 → **152**；其余套件不变。
全量回归 **0 失败，2 个可选真实模型用例跳过**。

---

### 8.92 短标签留出 × 的安全余量

**背景**：用户反馈有些会话标题很短（截图里的“专利”），标签框跟着变窄，`×` 紧贴标题，
点标签切会话时容易点到关闭。

**行为**：

- 桌面 `.tab` 最小宽度 96px，窄屏 84px；短标题也留出一段可点击的空白区。
- `.tabx` 左侧留 6px 间距。这段缝属于 `.tab` 本身，点它走“切会话”，不会触发关闭。
- `×` 的尺寸（桌面 24px / 窄屏 26px）、悬停露出、当前标签常驻、关闭语义和标签上限都不变。
- 标签会比原来略宽，横向滚动仍然接管放不下的情况。

**验证**：

- `ui-capabilities.html` 新增 3 项：桌面最小宽度与 × 安全缝、点标签空白区只切会话不关闭、
  窄屏最小宽度与安全缝。
- `smoke.sh` 新增 1 项静态锁：`.tab` 最小宽度、窄屏覆盖和 `.tabx` 的 `margin-left` 都在。

**回归**：`smoke.sh` 389 → **390**，`ui-capabilities` 200 → **203**；其余套件不变。
全量回归 **0 失败，2 个可选真实模型用例跳过**。

---

### 8.93 收工后先收束流式缓冲

**背景**：用户反馈会话正文已经结束，顶部仍显示「运行中」、底部进度条还在动，消息脚注停在
「397 tokens · 流式中」。检查发现：`execution.succeeded` / `session.idle` 只清了运行集合，
`store.live` 里的流式缓冲仍是打开状态；`recomputeRunning()` 继续把它算作运行，`liveMessage()`
也继续按 `live` 画光标 / 「流式中」。如果服务端权威消息晚到、或 150ms 那次对账正好拉早，
界面就会一直卡在收工前。

**行为**：

- `markTurnDone()` 先调用 `closeLiveFor(sid)`，把该会话所有打开的流式缓冲标为 `open=false`。
  `execution.*` 收工、`session.idle`、`status=idle`、`loadActive` 的运行→空闲都走这里。
- 收束后的缓冲仍渲染正文，但 `liveMessage()` 返回 `live:false` / `provisional:true`：
  不再画光标、「输出中」「流式中」和脚注；`recomputeRunning()` 不再把
  `provisional` 的缺少 `time.completed` 当成流式，`openLiveForSid()` 也只认仍打开的缓冲。
- `turnLooksUnsettled()` 仍用 `liveForSid()` 看到收束缓冲，所以 1.5s 收尾对账继续补拉；
  服务端权威消息带 `completed` 到达后，`pruneLive()` 回收缓冲并正常渲染。
- `handleControlEvent()` 返回「是否关闭了当前会话的缓冲」，`handleEvent()` 在没有结构变化时
  补一次整表重绘；`execution.*` 的结构变化分支仍只重绘一次（`markTurnDone(..., {defer:true})`）。

**验证**：

- `ui-stream.html` 新增 9 项：`execution.succeeded` 后不等权威消息就回空闲、进度条收起、
  不再显示「流式中」、本地正文仍保留；`session.idle` 同样关闭缓冲、清 pending、熄状态条并
  排 1.5s 收尾对账。
- `smoke.sh` 新增 1 项静态锁：`closeLiveFor` / `openLiveForSid` / `provisional` /
  `closedLive` 重绘分支都在。

**回归**：`smoke.sh` 390 → **391**，`ui-stream` 275 → **284**；其余套件不变。
全量回归 **0 失败，2 个可选真实模型用例跳过**。

---

### 8.94 标签拖拽排序(鼠标 + 手机长按)

**起因**：用户指着标签栏问「这些 TAB 不能拖拽排序之类的」；确认桌面鼠标和手机触摸都要，
手机采用**长按进入拖拽**，不跟标签栏的横向滚动打架。

**行为**：

| 场景 | 行为 |
|---|---|
| 鼠标拖拽 | 按住标签移动超过 4px 才开始拖；没移动仍是普通点击 |
| 手机长按 | 按住 300ms 进入拖拽；按之前横向移动超过 8px 就取消，继续当标签栏滚动 |
| 拖拽中 | 被拖标签降到 45% 透明度，落点显示 2px 蓝色插入线；靠近左右边缘 28px 时标签栏自动横向滚 |
| 松手 | 落在标签栏内按插入位重排；落在栏外或长按后没移动都取消，不切换会话 |
| 点击保护 | 真的拖动过之后，松手产生的 click 被压住（`TAB_CLICK_GUARD_MS = 800`，下一次 pointerdown 提前清掉）；只压标签上的 click，`+ 新建` / `↺` 不受影响 |
| 当前会话 | `store.selected` 不动，重排后当前标签仍然高亮 |
| 持久化 | 只改 `store.tabs` 的顺序并 `saveTabs()`；不发请求，不动会话内容 |
| 最多 8 个 | 新增第 9 个时 `shift()` 掉**最左边**那个；拖拽后顺序由用户定，仍保持「看得见的最左先走」 |
| 打开新标签 | 仍然追加到最右；`touchTab()` 不因为点选而重排 |

**DOM / CSS**：

- 不改标签栏 DOM；仍由 `renderTabs()` 生成 `.tab > .tabmain + .tabx`。
- `#tabStrip { touch-action: pan-x; }`：普通横滑归标签栏；拖拽期间由非 passive 的
  `touchmove` 拦下滚动。
- `.tab` 加 `position: relative` / `user-select: none` / `-webkit-touch-callout: none`；
  `.tab.dragging` 半透明；`.tab.drop-before::before` / `.tab.drop-after::after` 画插入线；
  `#tabStrip.tab-dragging` 用 `grabbing` 光标。

**JS**：

- 状态只有一个 `tabDrag`：`{id, from, el, pointerId, touch, startX/startY, x/y, active, moved, drop, timer}`；
  另有 `tabAutoRaf` 与 `tabSuppressClickUntil`。
- `moveTab(id, insertAt)` 先取再插，从前往后拖时自动把插入位减一；`tabDropIndex(clientX)`
  按每个标签的中心线算插入位；`paintTabDrop()` 只换插入线类名。
- `startTabDrag()` / `tabLongPress()` / `updateTabDrag()` / `finishTabDrag()` 分开：
  鼠标在 `updateTabDrag()` 里跨过 4px 起拖；手机由 300ms 定时器调 `tabLongPress()`，
  之后 `touchmove` 负责 `preventDefault()` 并更新位置。
- `setupSessionTabs()` 在 `#tabStrip` 上挂 `pointerdown / pointermove / pointerup /
  pointercancel` 和非 passive `touchmove`；点击处理开头先看 `tabSuppressClickUntil`。
- `renderTabs()` 开头如果还有 `tabDrag`，先 `finishTabDrag(false)`，避免重画后指针
  指向旧节点；测试页把 `setTimeout` 替成空实现时，可以直接调 `tabLongPress()` 驱动长按分支。

**验证**：

- `ui-capabilities.html` 新增 10 项：鼠标拖拽进入拖拽态 / 露出插入线、顺序与当前会话、
  `localStorage` 回写、松手 click 被压住、手机长按前还不是拖拽、长按后进入拖拽、
  手机长按拖拽顺序、未长按横滑让路、横滑取消后顺序不动、拖到栏外取消。
- `smoke.sh` 新增 2 项静态锁：`moveTab` / `TAB_LONGPRESS_MS` / `startTabDrag` /
  `tabLongPress` / pointer 接线 / `tabSuppressClickUntil` 与插入线样式；以及
  `ui-capabilities.html` 里上述关键断言在。

**回归**：`smoke.sh` 391 → **393**，`ui-capabilities` 203 → **213**；其余套件不变。
全量回归见提交前日志，0 失败；全部用合成标签数据，没有读取或打断真实会话。

**取舍**：

- 手机必须长按 300ms 才能拖；普通横滑仍然优先，代价是拖拽前会有一点等待。
- 不做拖拽手柄、键盘排序、跨标签页 / 跨设备同步；顺序只在本机 `localStorage`。
- 拖到边缘的自动滚动只在拖拽期间开；松手后标签栏回到普通横向滚动。
- 超过 8 个从最左边丢，而不是按「打开时间」丢；顺序可以手动调整后，左端是唯一
  一眼能看到的「先走」规则。

---

## 9. 取舍与理由

| 决定 | 理由 | 放弃了什么 |
|---|---|---|
| 一份代码、两套布局（方案 A）| 6 项功能**全都已存在**，只是为桌面排版；改布局的边际成本远低于重写 | 无可比代价；独立移动页在同需求下更贵 |
| 视图状态复用 hash | 深链与安卓返回键**免费**得到；无第二份状态可漂移 | 返回列表会取消选中（§4.2）|
| 断点判定放在一句内联脚本里 | 无「闪桌面三栏」，且判定源唯一 | `<head>` 多一行脚本 |
| 复用 `#dlgPick` 当动作面板 | 零新增对话框；已处理「先关框再回调」| 语义上「选择框」兼作「动作表」|
| **探索组只并同一条助手消息内的相邻工具** → **纯探索续步也吸收**（§8.68）| 实测（60 个会话窗口）跨消息只有 8 处，占探索分组的 2.9%；TUI 靠按 part 投影才天然并得起来。§8.68 没有改成行投影，只在渲染前把「下一条非终步、整条都是探索工具」的续步藏成占位，把工具并进上一段最后一个探索组 —— 覆盖实测那 8 处，又不动 `msgEls` / `content-visibility` / 锚点四条路 | 带正文、终步、流式中的续步仍分成两段；续步自己的 `.meta` / `.afoot` 跟着整条藏掉；不是 TUI 那种任意 part 的完全行投影 |
| **主列表只显示顶层会话，子会话用单独的入口**（§8.69）| 和 TUI 的 `!parentID` 一致，现场 29/108 个子会话不再混进左栏；只在显示层过滤，保留 `store.subs` 给标签栏、收工行与深链用 | 列表页仍会返回子会话，主列表实际可能不到 50 个；只列直接子会话、不做 TUI 的整棵家族树；窄屏头部入口被 `#chatOps` 一并收掉，只能走 `/subagents` / `/parent` |
| **时间线 / 分叉复用选择框，只列已加载消息**（§8.70）| 与 TUI 的 `DialogTimeline` / `DialogFork` 同一套交互（用户消息最新在前、完整会话第一项、`{before:id}`）；不新增对话框，也不为打开选择框翻完所有历史页 | 消息不在当前页时跳不过去；只滚动不弹 TUI 的 `DialogMessage` 预览；列表行的「分叉」仍是末尾分叉且只刷新 |
| **草稿按会话存正文，放 `sessionStorage`**（§8.71）| 与 TUI 的 `saveDraft` / `takeDraft` 同一语义；刷新也能恢复，且不跨标签页串味 | 附件不随草稿持久化（§8.74 只在内存按会话保留，刷新 / 关页丢）；发送失败后输入框仍是空的（草稿在会话名下，切回来才看到）；最多 20 个会话 |
| **`/copy` 复制转录，另开 `/copyid`**（§8.72）| 与 TUI 的 slash 命令对齐；转录走 export 取全量，不受面板消息分页影响；复制 ID / 转录都不要求先打开该会话 | 转录只是摘要（工具入参 / 输出、思考块开关、按消息选段都没做）；`/copy` 不再复制启动命令，那条改从 `/tui` 对话框的复制按钮拿 |
| **置顶只存本地，只改显示顺序**（§8.73）| 与 TUI 的本地 pin 一致；不碰 `time.updated` / 服务端 metadata，也不需要新的接口；`asc` / `desc` 都保持置顶组在前 | 置顶不跨浏览器；被置顶的会话不在当前 50 条分页里仍看不到；桌面不单设按钮，统一收在 ⋯；归档优先于置顶 |
| **附件按会话放内存，图片可空正文发送**（§8.74）| 切标签 / 回列表 / 再打开都不丢附件，符合 TUI 的会话级 prompt 状态；上传中拦截发送，避免悄悄丢图；上传归属写回原会话数组 | 刷新 / 关页丢附件（临时文件本来也会被清）；附件不随 §8.71 的草稿持久化；上传中要等一会儿才能发 |
| **最近关闭标签放内存，`↺` / `/tab-reopen` 重开**（§8.75）| 与 TUI 的 `session.tab.reopen` 对齐；关掉最后一个标签后栏不收起，手机上始终点得回来；`touchTab()` 去重，不会重复加回 | 栈上限 8、刷新即清；重开会切过去；指向的会话若被删仍按原错误路径报错 |
| **滚动存档带 `bottom`，切回直接贴底**（§8.76）| 「离开前看最新」和「离开前翻旧」是两种意图，分开记；新消息在离开期间到达也跟到新底，符合看最新的预期；旧存档兼容 | 离底 80px 内都算最新；只有底部状态不保存具体像素目标；中间位置仍按消息锚点还原 |
| **`/skills` 选技能，按 `prompt.skills` 发送**（§8.77）| 与 TUI 的 `prompt.skills` / `DialogSkill` 同入口；技能和文件在请求体里彻底分流，同名也不会串；`skillHits` 按会话留在内存，切回草稿仍可发 | `@` 补全仍只找文件；技能只认显式选择；不跨刷新持久化；只列当前工程 |
| **探索工具组可切「逐条显示」**（§8.78）| 与 TUI 的 `session.toggle.exploration_grouping` 对齐；关掉时跨消息吸收一起短路，续步恢复独立消息；偏好本机保存，不动数据 | 只做探索分组，思考块的全局折叠仍没做；偏好不写 `cli.json`；切换会重画 DOM，已摊开的组回到默认折叠 |
| **`/mcps` 只读列服务器状态**（§8.79）| 与 TUI 的 `mcp.list` 同入口；先交代有哪些服务器、连没连上、为什么失败，不碰运行时写操作 | 不接 connect / disconnect / add / remove；`/api/mcp` 没有工具数，不编假计数；列表是快照，不跟 SSE 自动刷新 |
| **导出默认 Markdown，JSON 保留脱敏**（§8.80）| 与 TUI 的 `DialogExportOptions` 同一默认；Markdown 复用 `transcriptText`，不另造一套；JSON 行为不动 | thinking / tools 两个开关还没做；Markdown 工具只留摘要；不写临时文件（浏览器直接下载）；空转录只报错不下载 |
| **`/status` 只读摘要，不露秘密**（§8.81）| 把 health、配置层级和 MCP 运行数摆在一张表里；三个请求各自容错；密码只报「已启用」 | 版本是面板代理的版本；列表是快照不自动刷新；不显示 provider 设置 / key；不做 `opencode.debug` 的日志与内部状态 |
| **流式增量按帧合并，光标原地追加**（§8.82）| 同一帧多个 delta 只跑一次 `md()` / DOM 写入 / 贴底；光标不再二次解析整段 HTML | 文本最多晚一帧；隐藏标签页暂停绘制，回前台或切会话时补齐；Markdown 解析仍在主线程 |
| **工具卡正文懒渲染**（§8.83）| 只把大 diff / write 正文延后到进入预加载范围，一帧补一张；消息壳、`msgEls`、锚点不动，合成 100 卡首屏约 475ms → 43–55ms | 离屏正文最多晚几帧；单张大卡补正文仍可能接近一帧；不做 Worker / 整表虚拟化 |
| **大会话切回不重复整表重绘 / 全量拉取**（§8.91）| 缓存命中先出旧内容；模型表已缓存时不再补第二次重绘；shell 大输出并入 §8.83 懒壳；会话摘要没更新且不在运行时跳过整页对账。合成 10.1MB 串口会话缓存过期一次切回约 418ms → 81ms | 跳过对账的前提是会话摘要可信（SSE / 列表刷新）；摘要丢了会晚一拍；离屏 shell 输出要滚到才补正文 |
| **短标签留出 × 的安全余量**（§8.92）| 保留悬停 × 的快速关闭；桌面 / 窄屏最小宽度给短标题留出可点击空白，`.tabx` 前 6px 的缝点下去只切会话 | 标签比原来略宽，可见数量少一点；右侧仍保留明确的关闭入口，不是完全防误触 |
| **收工信号一到先把流式缓冲标收束**（§8.93）| 状态条和「流式中」不再等服务端权威消息；正文继续显示，收尾对账仍会补拉并替换成权威版本 | 收束到权威版本到达之间是 provisional 内容：可能缺最后一段正文或脚注，但不会一直转圈 |
| 列表主要换 CSS 形态（仅增一个桌面隐藏的 `⋯`）| 桌面零风险，16 套测试继续有效 | 卡片行里留着用不到的表格语义 |
| 应用层来源白名单（而非改绑定）| 保住本机访问，且不依赖网卡启动顺序 | `server.js` 多几行；需要维护一个环境变量 |
| PWA 不做 | `http://` 私有 IP 拿不到安全上下文，做了装不上 | 没图标/没全屏/没离线（必要时以后套 APK 再补）|
| worktree 管理补到列出 / 删除 / 移入 | 复用 `#dlgPick` 和现有 `+ 新建`；根之外再按会话 `subpath` 列子目录，删除前用 `#dlgWtDel` 展示 status 文件清单（§8.65 把原来的两处缺口补上）| 子目录只能移入、不能单独删；预览只列文件与增删行数，不列完整 diff；入口只在 `/worktrees` 命令（§8.61 / §8.65）|
| 变更总览接四档 + 文件树 | `turn` / `branch` / `working` / `committed` 与 TUI 同名同义；多文件时左侧平铺文件树，点文件跳正文，逐文件 reviewed 只在本页内存 | 对比基线不猜 `branch.default`，没 base 时先让用户选；窄屏不显示文件树，reviewed 不持久化（§8.63 / §8.64）|
| 会话标签栏放聊天区顶部、左列表保留 | 用户挑的默认方案；桌面主布局只多这一条，手机上 tab 栏就在聊天区里，和「‹ 会话」回列表不打架 | 桌面多 36px、竖屏 34px、横屏 30px；当前标题在 tab 与聊天头部各出现一次（§8.59）|
| 标签最多 8 个、只存 id + 标题、默认按打开顺序，可拖拽排序（§8.94）| 规则可预期、实现小；拖拽只改本机顺序，不发请求；标题快照让刷新先有内容，列表回来后自动对账 | 超限丢最左边那个；手机要长按 300ms 才拖；不跨标签页 / 不跨设备同步，不在列表页的会话不自动补拉（§8.59 / §8.94）|
| diff 统一视图无条件折行 | 照 TUI 的 `wrapMode="char"`；393px 上不用左右拖着读 | 超长单 token 会断在任意字符；Markdown 代码块仍横向滚（§8.58）|
| diff 偏好与 TUI 共用 `cli.json` 的 `diffs.view` | 两边一本账，不会「TUI 并排、面板统一」；面板本来只有 view 这一项偏好 | 只共享 view；写本机文件，需同一 `OPENCODE_CONFIG_DIR`；`wrap/tree/single/source` 仍只在 TUI；同时写靠 rename 最后一次赢（§8.60）|
| 切 diff 视图只换 `.diffwrap` 正文 | 不重造 summary / 诊断 / `details`，展开状态、正文滚动与焦点都留住；40 张卡片实测约 -38% | 仍重跑 `diffHtml` / `parsePatch`；正文里的文本选区会随替换丢失（§8.62）|

---

## 10. 假设与待确认

1. **主用竖屏**，横屏「能用即可」——若横屏也要精调，断点与骨架需再议
2. 手机浏览器是 **Chrome**（或基于 Chromium 的）。若主用小米自带浏览器，
   `interactive-widget` 等特性支持情况需再验
3. 接受「返回列表会取消选中」这一行为差异
4. 附件在手机上走安卓系统的文件/相册选择器，不做拍照直接上传
5. 认为「能用」的标准是**不溢出、可点按、可完成**，不要求动画与过渡
6. **首屏 `limit=100` 的体量**（§8.34 实测某个会话 12.9MB、最新 30 条只要 2.1MB）：
   窄屏改 30 条已在 §8.35 落地；**剩下的字节已在 §8.37 从代理层摘掉**（消息列表里那些
   面板不显示的 `data:` 图占了 89%~92%），于是 `/api/` 加 gzip 这件事**不必做了** ——
   现在手机那页 0.23MB、桌面那页 1MB，且剩下的是文本，压一轮最多再省三成，
   却要给 SSE 单独开口子、还要处理编码协商，不值
7. **`cvmany` 的离屏估值会让「贴底」落偏** —— 已在 §8.36 修掉（贴完底再跟几帧）。
   残留的不确定只有一处：预算写成 `REPIN_BUDGET_MS = 800`，若估值落定比这更晚
   （例如某条消息里的图迟一步撑开），那一轮就跟不上了 —— **已定，见 §8.46**
   （不再盯时间：高度连续两帧没变就收手，迟到撑开的由 `ResizeObserver` 接住）。
8. **流式事件里可能也背着同一批 `data:` 图** —— **已定,见 §8.47**(SSE 按行改写:
   只认 `session.tool.success`,其余帧一个字节不动;纯函数 + 端点两端到端各一套断言)。
   §8.37 只摘了「消息列表」那一条,而面板在 `session.tool.success` 上写着
   `p.state.content = d.content`,某次工具真返回图,那一个事件就是 600KB 级
   (不是「打开会话慢」,而是「这一下卡一下」)。
9. **拉会话列表失败仍然只在控制台** —— **已定,见 §8.45**(左栏一条 `#listState`:
   `加载失败:<原因>` +「重试」;慢过 250ms 先露「正在加载会话…」)。§8.39 已经把
   「列表没回来 → 聊天区两排跟着消失」这条连锁反应掐掉了。
10. **手机上头部那排「导出 / 在TUI打开 / 归档 / 加载更旧消息」要不要收起来**：**已定，见 §8.41**。
   §8.40 之后用户先说了一句「手机端还是显示：…那一栏」，两种读法都通 —— ①是确认「现在
   显示出来了」（§8.39 修的就是它以前按 `store.sessions` 判显隐、列表没回来就永远藏着），
   ②是要它别占那 40px。已当面问，用户答的是「主要是手机端屏幕下，显示太多东西没必要」= ②。
   于是窄屏整行收起，翻旧改走「滚到顶自动拉更旧」—— 当时「加载更旧消息」是**唯一**的翻页
   入口（`PANEL_COMMANDS` 里没有这个动作），所以不能只收不补。
