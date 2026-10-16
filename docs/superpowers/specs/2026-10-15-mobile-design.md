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
| `#messages` | 代码块与 diff **横向滚动**（不折行，否则 diff 无法阅读）；工具卡片默认折叠更激进 | `pre`（L289）与 `.diff`（L390）本来就带 `overflow-x: auto`，窄屏**无需额外规则**，也没有改折叠策略 |
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
- **代码里的默认值是 `127.0.0.0/8,::1`**（回环 + VPN）
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
白名单: 127.0.0.0/8,::1
```

服务端同时打一行 `拒绝来源地址: 198.51.100.48(白名单: …)`。

> **实测踩到的坑（本机真实经历过）**：一开始只在代码里放了默认值（回环 + VPN），
> 而办公室这台桌面/手机走的是办公内网 `198.51.100.0/24` —— 于是**连自己的浏览器
> 都被 403 挡在外面**，报的就是上面那段。修法不是在代码里加网段，而是在
> `~/.config/opencode-session-manager/env` 里显式写：
>
> ```
> OCS_ALLOW=127.0.0.0/8,::1,198.51.100.0/24
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
| `smoke.sh` | 202 |
| `netallow-run.js`（新）| 74 |
| `ui-layout` / `ui-tools` / `ui-asks` | 160 / 110 / 57 |
| `ui-controls` / `ui-capabilities` / `ui-stream` | 87 / 71 / 195 |
| `ui-attach` / `ui-commands` / `ui-picks` | 132 / 166 / 87 |
| `ui-mobile`（新）| 160 |
| `ui-composer`（新，见 §8.4）| 91 |
| `ui-jump`（新，见 §8.6）| 44 |
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

**TUI 的事实**（反编译 `/home/user/.opencode/bin/opencode` 取得）：消息区**下面常驻一行**
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
   - **真压缩一回合**（对 `ses_demo` 发 `/compact`，SSE `started 6.08s → ended 13.54s`）：
     面板从 `3889ms` 起画 `msg compaction live:⠋上下文压缩进行中`，行首 spinner 一路
     `⠋⠸⠴⠇⠹⠧⠏⠙⠼⠦` 在转，`bar` 全程不是 `hidden`（含空拍）；`11163ms` 那一拍 `activeSel=None`
     （就是上面那个「空一拍」）而条仍然亮着；`11364ms` 收工 → `空闲` + 条收起 + 块变成
     `⏺上下文压缩 4,454 tokens 摘要…`；
   - 真载荷渲染：`ses_demo` 里那条真 compaction（摘要 4883 字、
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
| 位置 | **聊天头部标题行**右侧（新 `#ctxInfo`，在 `#chatState` 之后）| TUI 在提示栏（输入框下面那行），但面板那个位置是 `#progress`，只在运行中才露出来；头部标题行**窄屏一直看得见**（底板收起时也在），符合「看一眼」的主力用途 |
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
（`ses_demo… 47%`、`ses_demo… 45%`、`ses_demo… 60%+`、目录已删的那个只印 token 数；
至少一个被测会话带「已完成压缩」，压缩分支真跑到了）。另外 4 条：两档文案的 CSS 切换（含临时摘掉
`html.narrow` 验桌面档）、空会话整块收起。截图 `live-ctxusage.png` 里头部能看到 `65% ctx`。

**回归**：`smoke.sh` 194 → 202（Q 组 8 条：`#ctxInfo` 在标题行里、两档文案、CSS 切档、压缩那一步、
五路求和 + `limit.context`、`fmtSize`、窄屏文案、三个调用点 + 共用口径）；`ui-stream` 183 → 195
（上下文用量 12 条，含压缩后重新起算、percent 可空、`step.ended` 立刻算出）；其余套件与 `e2e-*` 全 0 失败。

---

## 9. 取舍与理由

| 决定 | 理由 | 放弃了什么 |
|---|---|---|
| 一份代码、两套布局（方案 A）| 6 项功能**全都已存在**，只是为桌面排版；改布局的边际成本远低于重写 | 无可比代价；独立移动页在同需求下更贵 |
| 视图状态复用 hash | 深链与安卓返回键**免费**得到；无第二份状态可漂移 | 返回列表会取消选中（§4.2）|
| 断点判定放在一句内联脚本里 | 无「闪桌面三栏」，且判定源唯一 | `<head>` 多一行脚本 |
| 复用 `#dlgPick` 当动作面板 | 零新增对话框；已处理「先关框再回调」| 语义上「选择框」兼作「动作表」|
| 列表主要换 CSS 形态（仅增一个桌面隐藏的 `⋯`）| 桌面零风险，16 套测试继续有效 | 卡片行里留着用不到的表格语义 |
| 应用层来源白名单（而非改绑定）| 保住本机访问，且不依赖网卡启动顺序 | `server.js` 多几行；需要维护一个环境变量 |
| PWA 不做 | `http://` 私有 IP 拿不到安全上下文，做了装不上 | 没图标/没全屏/没离线（必要时以后套 APK 再补）|

---

## 10. 假设与待确认

1. **主用竖屏**，横屏「能用即可」——若横屏也要精调，断点与骨架需再议
2. 手机浏览器是 **Chrome**（或基于 Chromium 的）。若主用小米自带浏览器，
   `interactive-widget` 等特性支持情况需再验
3. 接受「返回列表会取消选中」这一行为差异
4. 附件在手机上走安卓系统的文件/相册选择器，不做拍照直接上传
5. 认为「能用」的标准是**不溢出、可点按、可完成**，不要求动画与过渡
