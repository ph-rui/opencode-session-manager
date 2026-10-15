# OpenCode 会话管理器 — 手机端适配设计文档

> 本文只描述**手机端适配**这一增量。桌面版的整体设计见
> `2026-10-15-session-manager-design.md`，本文不重复其内容。

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
<script>window.OCS_NARROW_MQ = '(max-width:860px),(max-height:560px) and (pointer:coarse)';
if (matchMedia(window.OCS_NARROW_MQ).matches) document.documentElement.classList.add('narrow')
</script>
```

- 所有窄屏样式一律用 `html.narrow` 作前缀，**不写第二份 `@media`**
- `app.js` 用同一个 `window.OCS_NARROW_MQ` 监听 `change`，在旋转屏幕 / 拉窗口时同步这个类
- 测试既可以直接 `.classList.add('narrow')` 断言样式，也可以用真的窄窗口触发

判定式在仓库里**只出现一次**（就是上面那个字符串字面量），`smoke.sh` 断言它没被抄成第二份。

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

/* 二选一：视图类由 store.selected 派生(见 §4.2) */
html.narrow.view-list #chatpane { display: none; }
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

### 4.4 顶栏收起（抽屉）

`#topbar` 在窄屏只留：**短标题 + 搜索 + 「+ 新建」+ 连接状态**。
其余（工程目录筛选、排序、导入、刷新、显示已归档、会话计数）收进一个**筛选抽屉**。

- 新增 `#btnFilters`（窄屏可见）打开抽屉
- 抽屉用**原生 `<dialog>`**，与现有 6 个对话框一致 —— 原生 Esc 可直接关，
  且全局 `setupTuiKeys()` 的 Esc 分支已经会跳过「有对话框打开」的情况（不冲突）
- 桌面版顶栏**一个像素都不改**：这些控件仍在原位，只是抽屉里的那份在桌面隐藏

> 抽屉里的是**同一批控件**还是副本？选**副本**（抽屉里放一套镜像控件，绑定同一个
> 状态与同一个处理函数）。理由：桌面顶栏的 `flex-wrap` 布局在窄屏不可用，
> 而用 CSS 把同一批 DOM 挪进抽屉会与「桌面不变化」这条冲突。镜像的代价是
> 每次改筛选要同步刷新两处显示 —— 由 `renderDirOptions()` / `setupFilters()`
> 里新增的一次同步调用收口。

### 4.5 会话列表：`<table>` → 卡片行

393px 装不下 6 列。窄屏改形态 —— **覆写只发生在 `html.narrow` 下，桌面那套表格样式一行不改**：

```css
html.narrow #list thead { display: none; }
html.narrow #list tr { display: block; }        /* 一行变一张卡 */
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

| 项 | 规则 |
|---|---|
| 命中区 | 主要可点元素（顶栏按钮、列表行、返回、发送、附件、对话框控件）≥ **44 × 44 CSS px**（= 121 物理 px @DPR 2.75）；文本内的行内链接不受此约束 |
| 悬停 | `@media (hover: none)` 下，所有「悬停才显示」的元素（消息操作、折叠箭头等）改为**常驻可见** |
| 输入 | 输入类控件字号 ≥ 16px（防部分浏览器聚焦时自动放大）|
| 拖拽 | 分栏条窄屏隐掉；附件仍支持 `<input type=file>`（安卓会给相册/文件选择器）|
| 滚动 | `#messages` 与 `#list` 保持各自的滚动手势，互不抢 |

---

## 6. 逐功能适配清单

| 区域 | 窄屏处置 |
|---|---|
| `#topbar` | 只留短标题 / 搜索 / 新建 / 状态；其余进抽屉（§4.4）|
| `#list` | 卡片行 + 行内「⋯」动作（§4.5）|
| `#chatHeader` | 「‹ 会话」返回按钮；`#chatOps`（导出/在 TUI 打开/归档）收进「⋯」 |
| `#messages` | 代码块与 diff **横向滚动**（不折行，否则 diff 无法阅读）；工具卡片默认折叠更激进 |
| `#asks` / `#inbox` | 权限请求与问询卡片要**在窄屏可完整作答**（这是「看一眼」的主要动机）；按钮竖排、命中区放大 |
| `#composer` | `#ctoolbar`（智能体/模型/变体/投递/中断）在窄屏折成一行「摘要 + 展开」；`📎` / 发送按钮放大 |
| `#mentions` / `#cmds` | 补全浮层在窄屏占满宽度 |
| `<dialog>`（6 个）| `html.narrow .dlg { width: calc(100vw - 24px); max-width: none; }`；`dlgNew` 里的 `.fldrow`（三个字段横排）改 `flex-direction: column` |
| 软键盘 | `<meta name="viewport">` 加 `interactive-widget=resizes-content`，让安卓在键盘弹出时压缩视口，输入框与发送键不被顶出屏幕 |

---

## 7. 访问控制（替代「改 OCS_HOST」）

原本的设想是把 `OCS_HOST` 从 `0.0.0.0` 收成 `192.0.2.5`。实测后发现**不可行**：

- 绑定到 `192.0.2.5` 后，**本机 `http://127.0.0.1:49450` 就不再监听**了 ——
  桌面上的日常使用会一起断掉
- 而 `192.0.2.5` 是 VPN 网卡地址。服务单元里没有 `After=network-online.target`，
  若开机时该网卡还没起来，`listen` 会 `EADDRNOTAVAIL` 失败，只能靠
  `Restart=on-failure`（`RestartSec=2`）反复重试

**改为在应用层做来源地址白名单**（`server.js`，几行）：

- 保持 `0.0.0.0` 监听（本机、VPN 都照常）
- 在请求入口检查 `req.socket.remoteAddress`，只放行
  **回环（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）** 与 **VPN 网段**，
  其余一律 **403**
- 白名单用环境变量配置，例如 `OCS_ALLOW=127.0.0.1/8,::1,192.0.2.0/24`，
  默认值即上述两项
- 这样办公内网 `198.51.100.48` 与 docker 网桥 `172.17.0.1` 的访问被挡掉，
  而 VPN 地址将来若变化，只需改白名单，不用改绑定

> 说明：Basic 鉴权**保留**（它在 VPN 隧道内是够用的；本次只是收窄可达面，不换鉴权方案）。

---

## 8. 测试

沿用现有做法：**无头 Firefox + 本地 HTTP 服务**跑浏览器内断言（见主设计文档 §8）。

### 8.1 新增 `test/ui-mobile.html` + `test/ui-mobile-run.js`

以 `test/ui-picks.html` 为模板（它是最完整的一套）。核心断言：

| # | 断言 |
|---|---|
| 1 | `matchMedia` 命中时 `documentElement.classList` 含 `narrow`；不命中时不含 |
| 2 | `window.OCS_NARROW_MQ` 与 §3 的字面量**逐字符一致**，且 `app.js` 复用它而不是自己再写一份 |
| 3 | 窄屏 + 无选中 → 列表可见、对话区不可见 |
| 4 | 窄屏 + 选中会话 → 对话区可见、列表不可见 |
| 5 | `#backList` 在窄屏可见、桌面 `display:none` |
| 6 | 点 `#backList` → 调用 `clearSelection()`（`store.selected` 变 `null`、hash 去掉）|
| 7 | 窄屏下 `.resizer` 不可见 |
| 8 | `#list thead` 在窄屏不可见（卡片化生效）|
| 9 | 窄屏下每行有一个「⋯」动作按钮，点击打开 `#dlgPick` |
| 10 | `hover: none` 下「悬停才显示」的元素不再依赖悬停 |
| 11 | 主要命中区 `getBoundingClientRect()` 的宽高均 ≥ 44px：顶栏按钮、列表行、`#backList`、`⋯`、发送、`📎`、抽屉里的控件（在 360px 宽下量）|
| 12 | 顶部筛选抽屉能打开，且其中的控件与桌面顶栏**共享同一状态** |

> 关于 `pointer: coarse`：无头 Firefox 是细指针，`(max-height: 560px) and (pointer: coarse)`
> 这条**无法真实触发**。处理方式：断言用的第 1、2 条走「打桩 `matchMedia` + 校验字符串」，
> 真实的横屏视口（`--window-size=894,393`）只断言「宽 894 时**不**因宽度进窄屏」。
> 若实现时发现 Firefox 的 `ui.primaryPointerCapabilities` 首选项能模拟粗指针，
> 再补一条真实横屏断言；不能就保持现状并在此注明。

### 8.2 扩充 `test/smoke.sh`（静态断言）

- `index.html` 里存在那句内联脚本，且它同时定义 `window.OCS_NARROW_MQ` 与打 `narrow` 类
- 判定式的字面量在 `public/` 下**只出现一次**（防抄成两份而漂移）
- 存在 `html.narrow .resizer { display: none }` 之类的关键规则
- 存在 `#backList`、`#btnFilters` 元素
- `<meta name="viewport">` 含 `interactive-widget=resizes-content`
- `server.js` 的来源白名单逻辑存在，且默认值含回环与 `192.0.2.0/24`

> `smoke.sh` 里断言必须用现成的 `has()`（`case` 实现）；
> **禁用** `printf | grep -q` —— 在 `set -o pipefail` 下会因 SIGPIPE 假红。

### 8.3 回归

**全部 16 套既有测试必须继续通过。** 这是「窄屏覆写只发生在 `html.narrow` 下、
新增元素一律桌面隐藏、原有 DOM 一个不删」这条策略的收益：桌面路径零变化，由既有测试兜住。

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
