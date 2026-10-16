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
| 位置 | ~~聊天头部标题行右侧~~ → **输入框下面的提示栏 `#promptFooter`**（§8.19 改，§8.20 补齐顺序/费用/`:分支`/`~/`，§8.21 再补智能体·模型/`tab agents`/子会话·shell）| 当初放头部是嫌 `#progress` 那行只在运行中才露；后来照 TUI 把提示栏做成**常驻行**（挂在 `#composer` 外面），路径 + 用量 + 命令提示一起，窄屏收起底板时也在，比头部更贴「看一眼」|
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
| 为什么在外面 | 手机默认把底板收起成一条细边（`ocs.composerHiddenNarrow`），放里面会被一起收掉；放外面这一行**常驻**，收起底板时「看一眼用量」照旧 |
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
| 路径在 home 下缩成 `~/…`，正好是 home 缩成 `~` | `cm(e,r)`：`relative(r,e)` 为空 → `~`，在下面 → `~/…`，否则原样（本例 `/media/...` 不在 home 下，所以照旧绝对路径）|
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
- `/home/user`（home 下）的会话：`chatDir = ~`（`abbrevHome` 生效；该会话不在列表首页，顺带验证了深链补拉）。

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
| 智能体·模型 | 新 `#chatAgent`，排在 `#chatDir` 前面（`#promptFooter` 最左），照 TUI 的顺序。取值直接用工具栏两个 `<select>` 的当前项文案（`#agentSel` / `#modelSel`，变体接 `#variantSel`，`default` 不印）。工具栏在 `#composer` 里面 —— 手机收起底板时它跟着没了，这一格是收起状态下唯一还看得见「现在是哪个智能体/模型」的地方，所以只要选中会话就常驻（窄屏 `max-width: 32%`，别把工程路径挤没） |
| `tab agents` | 提示文案照 TUI 改成 `tab agents`；**无 Shift 的 `Tab`** 也接上 `cycleAgent()`（在输入框的键位链里排在命令面板/@ 补全/输入历史**之后**，所以那几处开着时先归它们）。Shift+Tab 照旧保留，不破坏既有键位与测试 |
| 子会话 / shell | 新 `store.subs`（子→父；来自列表接口里带 `parentID` 的那批 + SSE 的 `session.created/updated/deleted`）与 `store.shells`（`shell.created` 记、`shell.exited`/`shell.deleted` 划）。`subagentCount()` 只数 `isRunning()` 的（照 TUI 只数 running），`shellCount()` 数这个会话名下的；两者 ` · ` 连起来接在用量**前面**。单独放一份、不塞进 `store.sessions`，免得顶栏的工程筛选漏进别的工程的子会话 |
| `(new worktree)` | **不做**：那行不是会话提示栏的常驻元素，是「新建 worktree」对话框里的临时状态（`Re.pendingNew()` / `Re.progress()` 那两段），面板没有这个流程 |
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
`ses_demo`（393×894，46 行）读到：`→ Skill "brainstorming"`、
`→ Read /media/.../default.xml`、`$ ls -la ...`、`# Questions`、`← Edit /media/.../local.xml`、
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
  `ses_demo`（101 条、25007px）打开即 `d = 0`、按钮收起（改前会停在最上面）。

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
`ses_demo` 2480 条助手消息 + 探针会话 `ses_demo` 51 条，
合计 2531 条）：

| 事实 | 数据 |
|---|---|
| 每条助手消息的工具数 | `{0: 103, 1: 2239, 2: 179, 3: 7, 4: 3}` —— 一条里基本就一个工具（88%）|
| 探索组落在哪 | 单条消息内 **286 组**（`size=1` 就有 247 个、2 条 36 个、3 条 2 个、4 条 1 个）；跨消息相邻的只有 **8 处** —— 把整条会话的 part 摊平按 TUI 口径数，TUI 是 278 组、面板是 286 组，差 2.9% |
| 「思考组」 | **0 组**（2531 条里有 2341 条带 reasoning，形态都是 `[reasoning, 一个工具]` 交替，相邻 reasoning 根本不成立）|

**做法**：

| 点 | 决定 |
|---|---|
| 分组范围 | 只在**单条助手消息内**并相邻的探索工具（286 组落在这里；跨消息那 8 处只占 2.9% —— 面板每条消息是一个独立 DOM 块、增量重绘也按消息 id 走，跨消息并组要动这个批次边界，先记在后续对齐项里）|
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
`ses_demo` 的 393×894 与 1366×900 两个视口上读到：两条探索组都是
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

**实测**（`narrow-audit.js`，393×894，`ses_demo`）：

- 改前：`#chatAgent` 宽 **119px**（把 `max-width: 32%` 用满）、`#chatDir` 只剩 **145px**，
  路径可见部分到 `/work/example-repo/…` 就截了（`scrollWidth 311`）。
- 改后：`#chatAgent` **31px**（只有 `Build`）、`#chatDir` **234px**（+61%），可见部分到
  `/work/example-repo/exam-…`。
- `#older` 改前与 `#chatOps` 不同 top（自己占一整行），改后两者 `top` 都是 191、高都是 40px。

**做法**：

| 点 | 决定 |
|---|---|
| 提示栏第一格 | `paintFooterAgent()` 拆成 `.agName`（智能体）/ `.agModel`（` · 模型 · 变体`）两格；**整条 `textContent` 仍是「智能体 · 模型 · 变体」**，变更判据照旧 —— 顺带把「要不要重画」的判据也一起留着 |
| 窄屏 | `html.narrow #chatAgent .agModel { display: none }`，宽度上限 32% → 40%（模型收走后瓶颈不在它身上）。两格都还在 DOM 里，横屏转回来就露出来；模型名照旧留在整条的 `title` 里 |
| 「加载更旧消息」 | `#older` 是块级盒，跟着 `#chatOps`（`display: flex`）就只能落到下一行。`#chatOps` 改 `inline-flex`、`#older` 是 `inline-block` —— 两个行内盒自然共一行；一行放不下时 `#older` 自己换行（还是原来那样）|
| 尺寸 | `#older` 的 padding / 字号对齐 `.chip`；窄屏 `html.narrow #older { min-height: 40px }` 跟旁边几个 chip 一样高 |
| 顺手修的 | `clearSelection()` 原来只清 `store.messages`，没管 `#older` 与 `store.msgOlderCursor`：清掉选中后那一格会一直露在头部（**探针实测**：`#chatOps.hidden true` 而 `#older.hidden false`），点了也没用（`loadMessages` 没选中直接返回）；游标还会把上一个会话的页码带进下一个会话的第一页回来之前的空档。现在两样一起清 |

**验证**：393×894 四个 chip（导出 / 在 TUI 打开 / 归档 / 加载更旧消息）一行放得下（`#chatOps` 右沿 205、
`#older` 左沿 208 —— 中间那道 3px 是行内盒之间的空白）；1366×900 桌面同样是这一行。截图
`/tmp/ocsm-probe/perf/narrow-explore-393.png` 与 `-1366.png`。清掉选中那一条用 `CLEAR=1`（探针点 `#backList`
之后再量一轮）：改前 `#older.hidden false`、改后 `true`。

**回归**：`smoke.sh` 239 → **243**（新 R3 组 4 项：拆两格 / 窄屏回收 + 宽度上限 / `#chatOps` 与 `#older`
同排 / 窄屏 40px）；`ui-stream` 236 → **240**（窄屏收起来 / 宽屏露出来 / `.agName` 照旧 / `title` 里模型名没丢）；
`ui-jump` 56 → **58**（清掉选中后 `#older` 收起 + 游标清掉）；
`ui-mobile` 160、`ui-layout` 164 等全部不动；其余套件与 `e2e-*` 全 0 失败。

---

### 8.26 追加：修「加载更旧消息」—— 带游标时不能再带 `order`

**起因**：量助手脚注（§8.27）时顺手用真会话点了一下「加载更旧消息」，发现它**从来没成功过**。

**实测**（只读长会话 `ses_demo`，2480 条）：

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
- `ses_demo…`：`◈ Continuing after restart`（`synthetic` 有描述）、`◈ Instructions updated: core/codemode`（`system`）、
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

## 9. 取舍与理由

| 决定 | 理由 | 放弃了什么 |
|---|---|---|
| 一份代码、两套布局（方案 A）| 6 项功能**全都已存在**，只是为桌面排版；改布局的边际成本远低于重写 | 无可比代价；独立移动页在同需求下更贵 |
| 视图状态复用 hash | 深链与安卓返回键**免费**得到；无第二份状态可漂移 | 返回列表会取消选中（§4.2）|
| 断点判定放在一句内联脚本里 | 无「闪桌面三栏」，且判定源唯一 | `<head>` 多一行脚本 |
| 复用 `#dlgPick` 当动作面板 | 零新增对话框；已处理「先关框再回调」| 语义上「选择框」兼作「动作表」|
| **探索组只并同一条助手消息内的相邻工具**，跨消息的暂不并 | 实测（60 个会话窗口）只有 8 处会跨消息，占探索分组的 2.9%；而 TUI 那边是靠 `projectEntries` 把**每条 part 当行**投影出来才天然并得起来（`grouping/session.ts` 的 `append`：新 part 的 `path` 与上一行同类就并进去，助手消息**不插 message 行**，所以中间那几步只要 `finish === "tool-calls"`、没落 footer，两边的 `read`/`grep` 就会并成一个组）。面板现在是**按消息渲染**（`msgEls` 以消息 id 为键、`content-visibility` 与滚动锚点也都挂在这层），要照做就得先把「按消息」改成「按行投影」，牵动增量渲染、流式缓冲、离屏跳渲染与锚点四条路 —— 收益与风险不成比例 | 跨消息的连续探索工具会分成两段，各印各的「Explored:」（当前行为，见 §8.24 的「分组范围」那条）|
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
6. **首屏 `limit=100` 的体量**（§8.34 实测某个会话 12.9MB、最新 30 条只要 2.1MB）：
   窄屏改 30 条已在 §8.35 落地；`/api/` 加 gzip（13MB → 8.8MB，base64 压不动）还没做 ——
   收益有限（截图压不动），先搁着
7. **`cvmany` 的离屏估值会让「贴底」落偏**（§8.35 实测竖屏 466px、桌面那档历史上 1473px，
   见 §8.17）：贴完底之后浏览器才把离屏元素的估值落定，`scrollTop` 被夹回去，于是
   打开会话停在最新消息上面一截。修法是「贴完底再补几帧 rAF，跟到 `scrollHeight` 稳住为止」
   （用户一往上滚就停手）—— 还没做，因为它牵动 `pinBottom` / `store.lastTop` /
   `updateJumpLatest` 那套已经很细的滚动语义，要单独一项 + 单独一轮回归
