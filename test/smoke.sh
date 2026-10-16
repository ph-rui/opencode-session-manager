#!/usr/bin/env bash
# 冒烟测试:验证本地代理的鉴权注入、静态托管、SSE 透传与密码不外泄。
# 前置:OpenCode 服务已运行;本代理已在 $OCS_PORT(默认 49450)启动。
set -uo pipefail

PORT="${OCS_PORT:-49450}"
PROXY="http://127.0.0.1:${PORT}"
CFG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

# 面板若启用了访问控制,从环境文件读取凭据
ENVFILE="${OCS_ENV_FILE:-$HOME/.config/opencode-session-manager/env}"
if [ -z "${OCS_AUTH:-}" ] && [ -f "$ENVFILE" ]; then
  OCS_AUTH=$(grep -E '^OCS_AUTH=' "$ENVFILE" | head -1 | cut -d= -f2-)
fi
AUTH=()
[ -n "${OCS_AUTH:-}" ] && AUTH=(-u "$OCS_AUTH")

pass=0
fail=0
ck() { # got want label
  if [ "$1" = "$2" ]; then echo "PASS: $3"; pass=$((pass + 1)); else echo "FAIL: $3 (got '$1' want '$2')"; fail=$((fail + 1)); fi
}

# 在大段文本里找字面量子串。
# 刻意不写 `printf '%s' "$X" | grep -q PAT`:在 set -o pipefail 下,`grep -q` 一旦命中就退出,
# 还在写的 printf 会收到 SIGPIPE,整条管道随机被判失败(实测双 grep 链 300 次里失败 1 次),
# 冒烟于是间歇性假红。case 的匹配不走管道;而且引号里的 pattern 全是字面量,
# 不必再为 `.` `(` `)` 反斜杠转义 —— 所以下面写的是 `.dl.add` 而不是 '\.dl\.add'。
has() { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }

PW=$(python3 -c "import json;print(json.load(open('$CFG/service.json'))['password'])" 2>/dev/null)
BASE=$(opencode service status 2>/dev/null | grep -o 'http://127.0.0.1:[0-9]*' | head -1)

echo "代理: $PROXY  (面板鉴权: ${OCS_AUTH:+开}${OCS_AUTH:-关})"
echo "服务: ${BASE:-<未发现>}"
echo

code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/__health")
ck "$code" 200 "GET /__health 返回 200"

code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/")
ck "$code" 200 "静态托管 GET / 返回 200"

code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/api/session?limit=1")
ck "$code" 200 "经代理 GET /api/session 返回 200(鉴权注入成功)"

if [ -n "${OCS_AUTH:-}" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "$PROXY/api/session?limit=1")
  ck "$code" 401 "面板已设密码:无凭据经代理返回 401"
fi

if [ -n "$BASE" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/session?limit=1")
  ck "$code" 401 "直连服务无鉴权返回 401(鉴权只在代理侧)"
fi

body=$(curl -s "${AUTH[@]}" "$PROXY/api/session?limit=1")
leak=0
if [ -n "$PW" ] && has "$body" "$PW"; then leak=1; fi
if [ -n "${OCS_AUTH:-}" ] && has "$body" "${OCS_AUTH#*:}"; then leak=1; fi
if [ "$leak" = 1 ]; then echo "FAIL: 响应体泄露了密码"; fail=$((fail + 1)); else echo "PASS: 响应体不含密码"; pass=$((pass + 1)); fi

# 问询(form / permission)端点与前端容器
SID=$(curl -s "${AUTH[@]}" "$PROXY/api/session?limit=1" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('data') or [{}])[0].get('id',''))" 2>/dev/null)
if [ -n "$SID" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/api/session/$SID/form")
  ck "$code" 200 "经代理 GET /api/session/:id/form 返回 200"
  code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/api/session/$SID/permission")
  ck "$code" 200 "经代理 GET /api/session/:id/permission 返回 200"
fi

HOME_HTML=$(curl -s "${AUTH[@]}" "$PROXY/")
if has "$HOME_HTML" 'id="asks"'; then
  echo "PASS: 首页包含问询容器 #asks"; pass=$((pass + 1))
else
  echo "FAIL: 首页缺少 #asks"; fail=$((fail + 1))
fi

# 会话控制端点(只读)与前端控件
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/api/session/active")
ck "$code" 200 "经代理 GET /api/session/active 返回 200"

code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/api/agent")
ck "$code" 200 "经代理 GET /api/agent 返回 200"

code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/api/model")
ck "$code" 200 "经代理 GET /api/model 返回 200"

if [ -n "$SID" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/api/session/$SID/inbox")
  ck "$code" 200 "经代理 GET /api/session/:id/inbox 返回 200"
fi

for sel in 'id="ctoolbar"' 'id="agentSel"' 'id="modelSel"' 'id="interrupt"' 'id="delivery"' 'id="inbox"'; do
  if has "$HOME_HTML" "$sel"; then
    echo "PASS: 首页包含 $sel"; pass=$((pass + 1))
  else
    echo "FAIL: 首页缺少 $sel"; fail=$((fail + 1))
  fi
done

# 能力扩展(D 组)端点(只读)与前端控件
if [ -n "$SID" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/api/experimental/session/$SID/export?sanitize=true")
  ck "$code" 200 "经代理 GET /api/experimental/session/:id/export 返回 200"
fi
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/api/experimental/session/ses_nope/export")
ck "$code" 404 "导出不存在的会话返回 404"

code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$PROXY/api/experimental/session/nope/export")
ck "$code" 400 "导出非法会话 ID(不以 ses 开头)返回 400"

for sel in 'id="btnNew"' 'id="btnImport"' 'id="showArchived"' 'id="chatOps"' 'id="opExport"' 'id="opTui"' 'id="opArchive"' 'id="dlgNew"' 'id="dlgImport"' 'id="dlgExport"' 'id="dlgTui"' 'id="dirList"'; do
  if has "$HOME_HTML" "$sel"; then
    echo "PASS: 首页包含 $sel"; pass=$((pass + 1))
  else
    echo "FAIL: 首页缺少 $sel"; fail=$((fail + 1))
  fi
done

# 顶部栏布局:筛选/工具控件搬到顶栏,左栏整栏与左分栏条已移除
# (折叠手柄不在顶栏 —— 它挂在分栏条上,见下面的 #resizer-mid 切片断言)
TOP_HTML=$(printf '%s' "$HOME_HTML" | awk '/<header id="topbar">/{f=1} f{print} /<\/header>/{if(f) exit}')
for sel in 'id="search"' 'id="dirFilter"' 'id="order"' 'id="btnNew"' 'id="refresh"' 'id="showArchived"' 'id="count"' 'id="status"'; do
  if has "$TOP_HTML" "$sel"; then
    echo "PASS: 顶栏包含 $sel"; pass=$((pass + 1))
  else
    echo "FAIL: 顶栏缺少 $sel"; fail=$((fail + 1))
  fi
done
if has "$HOME_HTML" 'id="filters"'; then
  echo "FAIL: 首页仍有左栏 #filters"; fail=$((fail + 1))
else
  echo "PASS: 左栏 #filters 已移除"; pass=$((pass + 1))
fi
if has "$HOME_HTML" '<aside'; then
  echo "FAIL: 首页仍有 <aside> 左栏"; fail=$((fail + 1))
else
  echo "PASS: 首页已无 <aside> 左栏"; pass=$((pass + 1))
fi
if has "$HOME_HTML" 'id="resizer-left"'; then
  echo "FAIL: 首页仍有左分栏条 #resizer-left"; fail=$((fail + 1))
else
  echo "PASS: 左分栏条已移除"; pass=$((pass + 1))
fi
nres=$(printf '%s' "$HOME_HTML" | grep -o 'class="resizer"' | wc -l | tr -d ' ')
ck "$nres" 1 "首页只剩 1 个分栏条(#resizer-mid)"

# 折叠手柄必须长在分栏条里:收起后分栏条会保留成窄槽,手柄才不会跟着消失。
# 若手柄在别处(例如又被搬回顶栏),这条会提醒「收起后的展开入口」跑偏了。
RZ_HTML=$(printf '%s' "$HOME_HTML" | awk '/id="resizer-mid"/{f=1} f{print} /<\/div>/{if(f) exit}')
if has "$RZ_HTML" 'id="btnList"'; then
  echo "PASS: 折叠手柄 #btnList 挂在分栏条 #resizer-mid 里"; pass=$((pass + 1))
else
  echo "FAIL: 折叠手柄没挂在分栏条里(收起后会找不到展开入口)"; fail=$((fail + 1))
fi
if has "$TOP_HTML" 'id="btnList"'; then
  echo "FAIL: 顶栏仍有折叠手柄(会变成两个入口)"; fail=$((fail + 1))
else
  echo "PASS: 顶栏已无折叠手柄(入口只有分栏条上那一个)"; pass=$((pass + 1))
fi

CSS=$(curl -s "${AUTH[@]}" "$PROXY/styles.css")
if has "$CSS" 'var(--list-w, 560px) var(--rz-w, 16px) minmax(0, 1fr)'; then
  echo "PASS: styles.css 主区为「列表 + 16px 分栏条 + 对话区」三列网格"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 主区网格不对(分栏条要留出 16px 放手柄)"; fail=$((fail + 1))
fi
if has "$CSS" 'var(--left-w' || has "$CSS" 'var(--mid-w'; then
  echo "FAIL: styles.css 仍引用 --left-w/--mid-w"; fail=$((fail + 1))
else
  echo "PASS: styles.css 已无 --left-w/--mid-w"; pass=$((pass + 1))
fi
if has "$CSS" 'calc(100vh - 43px)'; then
  echo "FAIL: styles.css 主区仍是写死高度(顶栏变高会把底部输入框顶出视口)"; fail=$((fail + 1))
else
  echo "PASS: styles.css 主区不再写死高度"; pass=$((pass + 1))
fi
# 工具卡片里的改动内容(diff / 代码):配色变量 + 行样式必须在
if has "$CSS" '--diff-add-bg' && has "$CSS" '--diff-del-bg'; then
  echo "PASS: styles.css 有 diff 增删配色变量"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺 --diff-add-bg/--diff-del-bg(diff 会退化成无色)"; fail=$((fail + 1))
fi
if has "$CSS" '.dl.add' && has "$CSS" '.dl.del'; then
  echo "PASS: styles.css 有 diff 行样式(.dl.add/.dl.del)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺 .dl.add/.dl.del 行样式"; fail=$((fail + 1))
fi
if has "$CSS" '.dfile' && has "$CSS" '.diff '; then
  echo "PASS: styles.css 有文件头与 diff 容器样式(.dfile/.diff)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺 .dfile/.diff 样式"; fail=$((fail + 1))
fi
# H 组 1:会话区字号由一个变量统管,区内字号一律相对 em(整块等比缩放,不是只有正文变大)
if has "$CSS" '--chat-fs: 14px' && has "$CSS" 'font-size: var(--chat-fs)' &&
   has "$CSS" 'font-size: 0.92em' && has "$CSS" 'font-size: 0.88em'; then
  echo "PASS: styles.css 会话区字号有旋钮(--chat-fs)且区内用相对 em"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 会话区字号没有可调旋钮 / 区内仍是写死 px"; fail=$((fail + 1))
fi
# H 组 5:用户消息上的 agent/skill 提及标记
if has "$CSS" '.ref-agent' && has "$CSS" '.ref-skill' && has "$CSS" '.refs '; then
  echo "PASS: styles.css 有 agent/skill 提及标记样式(.ref-agent/.ref-skill)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺 agent/skill 提及标记样式"; fail=$((fail + 1))
fi
# 会话列表收起:只隐藏列表,分栏条保留成 16px 窄槽 —— 它是唯一的展开入口,跟着消失就把列表锁死了
if has "$CSS" 'main.list-hidden { grid-template-columns: 0 var(--rz-w, 16px) minmax(0, 1fr); }'; then
  echo "PASS: styles.css 收起时为分栏条留出窄槽"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 收起规则不对(应留 16px 窄槽给手柄)"; fail=$((fail + 1))
fi
# 反向封锁:任何「收起时隐藏分栏条」的规则都会让手柄消失,列表再也拉不回来
if printf '%s' "$CSS" | python3 -c "
import re, sys
css = sys.stdin.read()
bad = False
for sel, body in re.findall(r'([^{}]+)\{([^{}]*)\}', css):
    if 'list-hidden' in sel and 'resizer' in sel and re.search(r'display\s*:\s*none', body):
        bad = True
sys.exit(0 if bad else 1)
"; then
  echo "FAIL: 收起时会隐藏分栏条(手柄跟着消失,列表拉不回来)"; fail=$((fail + 1))
else
  echo "PASS: 收起时不隐藏分栏条(展开入口不会丢)"; pass=$((pass + 1))
fi

# 前端逻辑:打开网页时列表【一定】是展开的(用户要求「第一次打开网页时应该展开对话列表」)
# → 折叠不跨刷新:setupListToggle 一律 paint(false),不再读写 localStorage 里的 ocs.listHidden
APPJS=$(curl -s "${AUTH[@]}" "$PROXY/app.js")
if has "$APPJS" 'paint(false); // 打开网页时一定是展开的' &&
   ! has "$APPJS" "localStorage.getItem('ocs.listHidden')" &&
   ! has "$APPJS" "localStorage.setItem('ocs.listHidden')"; then
  echo "PASS: app.js 打开网页时列表一律展开(折叠不跨刷新,不再读写 ocs.listHidden)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 仍会恢复 localStorage 里的收起态(打开网页时列表不是展开的)"; fail=$((fail + 1))
fi
if has "$APPJS" 'history.replaceState' && has "$APPJS" 'restoreFromHash'; then
  echo "PASS: app.js 把选中会话写进 URL hash 并在加载时恢复"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺 hash 持久化 / 恢复逻辑"; fail=$((fail + 1))
fi
# H 组 2:点会话进历史栈,浏览器前后退能跟着切会话
if has "$APPJS" 'history.pushState' && has "$APPJS" 'popstate' && has "$APPJS" 'setupHistoryNav'; then
  echo "PASS: app.js 点会话 pushState + 监听前后退切会话"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺前后退同步(pushState / popstate)"; fail=$((fail + 1))
fi
# H 组 3:滚动位置存 sessionStorage(本标签页),锚到消息上而不是纯像素
if has "$APPJS" 'ocs.scroll' && has "$APPJS" 'sessionStorage' && has "$APPJS" 'savedAnchor' && has "$APPJS" 'applyScrollAnchor'; then
  echo "PASS: app.js 用 sessionStorage 记会话内滚动位置(锚点还原)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺会话内滚动位置记忆"; fail=$((fail + 1))
fi
# H 组 4:顶栏筛选/排序/搜索持久化
if has "$APPJS" 'ocs.q.search' && has "$APPJS" 'ocs.q.dir' && has "$APPJS" 'ocs.q.order' &&
   has "$APPJS" 'ocs.q.archived' && has "$APPJS" 'restoreFilters' && has "$APPJS" 'setupFilters'; then
  echo "PASS: app.js 持久化顶栏筛选/排序/搜索"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺顶栏条件持久化"; fail=$((fail + 1))
fi
# H 组 5:用户消息上的 agent/skill 提及(渲染侧)
if has "$APPJS" 'userRefsHtml' && has "$APPJS" 'ref-agent' && has "$APPJS" 'ref-skill'; then
  echo "PASS: app.js 渲染用户消息上的 agent/skill 提及"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺 agent/skill 提及渲染"; fail=$((fail + 1))
fi
# H 组 6:文件附件(浏览器上传 → 暂存目录;@ 引用来自 fs/find 的补全)
if has "$APPJS" 'resolveMentions' && has "$APPJS" 'userFilesHtml' && has "$APPJS" 'setupAttachments' &&
   has "$APPJS" 'uploadPathFor' && has "$APPJS" 'mentionQuery'; then
  echo "PASS: app.js 有附件与 @ 补全(解析/渲染/接线)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺附件或 @ 补全逻辑"; fail=$((fail + 1))
fi
# 上传绝不能自己另起端点:走 OpenCode 自带的 fs/write,代理只负责建目录 + 清理
if has "$APPJS" '/api/experimental/fs/write' && has "$APPJS" 'uploadDir'; then
  echo "PASS: 上传复用 OpenCode 的 fs/write(代理不新增上传端点)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 上传没有走 fs/write"; fail=$((fail + 1))
fi
if has "$CSS" '#mentions' && has "$CSS" '.achip' && has "$CSS" '.att-img' && has "$CSS" '.att-src'; then
  echo "PASS: styles.css 有 @ 补全与附件样式"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺 @ 补全 / 附件样式"; fail=$((fail + 1))
fi
if has "$HOME_HTML" 'id="btnAttach"' && has "$HOME_HTML" 'id="filePick"' &&
   has "$HOME_HTML" 'id="attach"' && has "$HOME_HTML" 'id="mentions"'; then
  echo "PASS: 输入区有附件按钮/文件框/待发送行/补全下拉"; pass=$((pass + 1))
else
  echo "FAIL: 输入区缺附件相关元素"; fail=$((fail + 1))
fi
# 服务端:暂存目录要能通过 /__health 告知前端,并且代理自己会建目录 + 定期清理
HEALTH=$(curl -s "${AUTH[@]}" "$PROXY/__health")
if has "$HEALTH" 'uploadDir'; then
  echo "PASS: /__health 告知附件暂存目录(前端据此拼落盘路径)"; pass=$((pass + 1))
else
  echo "FAIL: /__health 没给出 uploadDir"; fail=$((fail + 1))
fi
SERVERJS=$(cat "$(dirname "$0")/../server.js")
if has "$SERVERJS" 'ensureUploadDir' && has "$SERVERJS" 'pruneUploads' && has "$SERVERJS" 'UPLOAD_TTL_MS'; then
  echo "PASS: 代理会建暂存目录并定期清理旧附件"; pass=$((pass + 1))
else
  echo "FAIL: 代理缺暂存目录的建立/清理"; fail=$((fail + 1))
fi
# 顺序锁:init() 里 setupAttachments() 必须在 paintDelivery() 之前接好线
ATT_ORDER=$(printf '%s' "$APPJS" | awk '
  /^function init\(\)/ { ininit = 1 }
  ininit && /setupAttachments\(\);/ { seen = 1 }
  ininit && /paintDelivery\(\);/ && !done { print (seen ? "attach-first" : "attach-late"); done = 1 }
')
case "$ATT_ORDER" in
  attach-first) echo "PASS: init() 先接好附件/补全的线再画输入区"; pass=$((pass + 1)) ;;
  *)            echo "FAIL: init() 没在画输入区前接好附件线 (got '$ATT_ORDER')"; fail=$((fail + 1)) ;;
esac
# 反向封锁:附件 uri 必须是 file: URI(service 端只认这个),不能被改成裸路径
if has "$APPJS" "return 'file://' + String(abs"; then
  echo "PASS: 附件 uri 统一加 file:// 前缀(服务端只认 file: URI)"; pass=$((pass + 1))
else
  echo "FAIL: 附件 uri 没有加 file:// 前缀(会被服务端 400)"; fail=$((fail + 1))
fi

# ---- I 组:命令面板(与 TUI 的 / 命令一致)+ TUI 键位 ----
if has "$APPJS" 'function cmdQuery' && has "$APPJS" 'function openCommands' && has "$APPJS" 'function acceptCommand' &&
   has "$APPJS" 'function mergedCommands' && has "$APPJS" 'function commandKey'; then
  echo "PASS: app.js 有命令面板(行首 / 解析 / 打开 / 补全 / 键位)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺命令面板"; fail=$((fail + 1))
fi
# 命令列表来自服务端(随工程走),面板动作类命令只是补充
if has "$APPJS" "'/api/command?'" && has "$APPJS" "location[directory]" && has "$APPJS" 'loadCommands'; then
  echo "PASS: 命令列表取自 GET /api/command?location[directory](随工程走)"; pass=$((pass + 1))
else
  echo "FAIL: 命令列表没有按工程向服务端取"; fail=$((fail + 1))
fi
if has "$APPJS" 'parseCommand' && has "$APPJS" 'runCommand' && has "$APPJS" "/command'"; then
  echo "PASS: 命中命令时走 POST /api/session/:id/command(不当作普通消息)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺命令执行通道"; fail=$((fail + 1))
fi
# 同名冲突:服务端命令优先,面板动作让位(否则用户自定义的 /new 会被面板动作盖掉)
if has "$APPJS" 'const taken = new Set(srv.map'; then
  echo "PASS: 同名命令以服务端为准(面板动作让位)"; pass=$((pass + 1))
else
  echo "FAIL: 同名命令没有让服务端优先"; fail=$((fail + 1))
fi
MISSING=$(printf '%s' "$APPJS" | python3 -c "
import re, sys
src = sys.stdin.read()
want = ['new', 'compact', 'interrupt', 'undo', 'redo', 'rename', 'delete', 'export',
        'archive', 'tui', 'copy', 'sessions', 'models', 'agents', 'clear', 'help']
got = set(re.findall(r\"\{ name: '([a-z/]+)',\", src))
print(','.join([w for w in want if w not in got]))
")
ck "$MISSING" "" "面板动作类命令齐全(TUI 内置动作 → 面板已有能力)"

# TUI 键位:Esc 是全局的(session.interrupt = escape),而且要按「命令面板 → @ 补全 → 中断」的顺序
if has "$APPJS" 'function setupTuiKeys'; then
  echo "PASS: app.js 有全局 TUI 键位接线"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺全局键位接线"; fail=$((fail + 1))
fi
if has "$APPJS" "document.addEventListener('keydown'"; then
  echo "PASS: 键位挂在 document 上(焦点不在输入框时 Esc 也管用)"; pass=$((pass + 1))
else
  echo "FAIL: 键位没挂在 document 上"; fail=$((fail + 1))
fi
ESC_ORDER=$(printf '%s' "$APPJS" | awk '
  /^function setupTuiKeys\(\)/ { f = 1 }
  f && /closeCommands\(\);$/ && !a { a = 1 }
  f && /closeMentions\(\);$/ && !b { b = 1 }
  f && /requestInterrupt\(\);$/ && !c { c = 1 }
  f && /^}/ { exit }
  END { print (a && b && c) ? "cmds-mentions-interrupt" : "wrong" }
')
case "$ESC_ORDER" in
  cmds-mentions-interrupt) echo "PASS: Esc 优先级 = 关命令面板 → 关 @ 补全 → 中断(两下)"; pass=$((pass + 1)) ;;
  *) echo "FAIL: Esc 优先级顺序不对 (got '$ESC_ORDER')"; fail=$((fail + 1)) ;;
esac
# 两下才打断:第一下只上膛 + 挂 5 秒归零定时器(照 TUI 的 handleInterrupt / armInterruptTimer),
# 第二下才真调 interrupt();窗口长度、提示文案都得对得上。
ESC_ARM=$(printf '%s' "$APPJS" | awk '
  /^function requestInterrupt\(\)/ { f = 1 }
  f && /INTERRUPT_ARM_MS/ { a = 1 }
  f && /^ *interrupt\(\);$/ && !b { b = 1 }
  f && /^}/ { exit }
  END { print (a && b) ? "armed" : "wrong" }
')
if [ "$ESC_ARM" = armed ] && has "$APPJS" 'const INTERRUPT_ARM_MS = 5000'; then
  echo "PASS: Esc 第一下只上膛、第二下才真打断(5 秒窗口)"; pass=$((pass + 1))
else
  echo "FAIL: 缺「按两下 Esc 才打断」的实现 (got '$ESC_ARM')"; fail=$((fail + 1))
fi
# 输入框一有动静就归零(照 TUI 的 handleInputClear):半次 Esc 不能悬在那儿等手滑
if has "$APPJS" "inp.addEventListener('input', () => disarmInterrupt())"; then
  echo "PASS: 输入框有动静就撤掉「Esc 上膛」"; pass=$((pass + 1))
else
  echo "FAIL: 输入框改动后没撤掉上膛状态"; fail=$((fail + 1))
fi
# 中断后排队消息接着发:TUI 的输入框默认 steer + interrupt 带 resume,面板要显式推一把
if has "$APPJS" 'interrupt?resume=true' && has "$APPJS" 'function resumeQueued' \
   && has "$APPJS" 'it.delivery === '"'"'queue'"'"''; then
  echo "PASS: 中断带 resume=true,并把排队中的消息改成 steer 接着发"; pass=$((pass + 1))
else
  echo "FAIL: 中断没有「resume + 放行排队消息」"; fail=$((fail + 1))
fi
# 运行中发消息的默认投递方式:TUI 里光按 Enter 是 prompt.submit(插话),
# 排队要额外按 leader+Enter(prompt.queue)。面板原来默认排队,用户实测对不上。
if has "$APPJS" "const DEFAULT_DELIVERY = 'steer'" \
   && has "$APPJS" 'delivery: DEFAULT_DELIVERY' \
   && has "$APPJS" "mode === 'queue' ? 'queue' : DEFAULT_DELIVERY"; then
  echo "PASS: 默认投递=插话(对齐 TUI 的 Enter=prompt.submit)"; pass=$((pass + 1))
else
  echo "FAIL: 默认投递没有对齐 TUI(仍默认排队,或非法值没回默认)"; fail=$((fail + 1))
fi
# 反向封锁:别把默认值写死在 store 或 setDelivery 里,必须由 DEFAULT_DELIVERY 一处说了算
if has "$APPJS" "delivery: 'steer', // 运行中消息" || has "$APPJS" "delivery: 'queue', // 运行中消息"; then
  echo "FAIL: store.delivery 又写死字面量,没走 DEFAULT_DELIVERY"; fail=$((fail + 1))
else
  echo "PASS: store.delivery 走 DEFAULT_DELIVERY 单一出处"; pass=$((pass + 1))
fi
# 反向封锁:Esc 不能又退回「只在输入框里能按」—— 那是这次要修的病
if has "$APPJS" 'isRunning(sid)) {' && has "$APPJS" 'anyDialogOpen'; then
  echo "PASS: 仅当会话在跑才中断,且对话框打开时不抢键"; pass=$((pass + 1))
else
  echo "FAIL: 中断缺少「会话在跑」或对话框的护栏"; fail=$((fail + 1))
fi
if has "$APPJS" 'function historyKey' && has "$APPJS" 'pushHistory' && has "$APPJS" 'function cycleAgent'; then
  echo "PASS: app.js 有输入历史(↑/↓)与 Shift+Tab 切智能体"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺输入历史或 Shift+Tab"; fail=$((fail + 1))
fi
if has "$APPJS" "e.ctrlKey || e.metaKey"; then
  echo "PASS: Ctrl+P 打开命令面板(对应 TUI command.palette.show)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺 Ctrl+P"; fail=$((fail + 1))
fi
# 顺序锁:输入框里敲 / 要先看命令面板,再看 @ 文件补全
DEB_ORDER=$(printf '%s' "$APPJS" | awk '
  /^function setupAttachments\(\)/ { f = 1 }
  f && /if \(cmdQuery\(\)\)/ && !a { a = 1 }
  f && /openMentions\(\)/ && !b { b = 1 }
  f && /^}/ { exit }
  END { print (a && b) ? "cmd-first" : "wrong" }
')
case "$DEB_ORDER" in
  cmd-first) echo "PASS: 输入时先判命令面板,其次才是 @ 文件补全"; pass=$((pass + 1)) ;;
  *) echo "FAIL: 输入时的补全优先级不对 (got '$DEB_ORDER')"; fail=$((fail + 1)) ;;
esac
# 顺序锁:输入框的按键优先级(命令面板 → @ 补全 → 历史 → 发送)
KEY_ORDER=$(printf '%s' "$APPJS" | awk '
  /^function setupComposerKeys\(\)/ { f = 1 }
  f && /commandKey\(e\)/ && !a { a = NR }
  f && /mentionKey\(e\)/ && !b { b = NR }
  f && /historyKey\(e\)/ && !c { c = NR }
  f && /send\(\);$/ && !d { d = NR }
  f && /^}/ { exit }
  END { print (a && b && c && d && a < b && b < c && c < d) ? "ok" : "wrong" }
')
case "$KEY_ORDER" in
  ok) echo "PASS: 输入框按键优先级 = 命令面板 → @ 补全 → 历史 → 发送"; pass=$((pass + 1)) ;;
  *) echo "FAIL: 输入框按键优先级不对 (got '$KEY_ORDER')"; fail=$((fail + 1)) ;;
esac
if has "$HOME_HTML" 'id="cmds"' && has "$HOME_HTML" 'id="dlgHelp"' && has "$HOME_HTML" 'id="helpKeys"'; then
  echo "PASS: 页面有命令面板容器与 /help 快捷键对话框"; pass=$((pass + 1))
else
  echo "FAIL: 页面缺命令面板容器或帮助对话框"; fail=$((fail + 1))
fi
if has "$CSS" '#cmds' && has "$CSS" '.cmd-tag' && has "$CSS" '.keys kbd'; then
  echo "PASS: styles.css 有命令面板与快捷键表样式"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺命令面板 / 快捷键表样式"; fail=$((fail + 1))
fi
for f in test/ui-commands.html test/ui-commands-run.js test/e2e-commands.sh; do
  if [ -f "$(dirname "$0")/$(basename "$f")" ]; then
    echo "PASS: 有 I 组的测试文件 $f"; pass=$((pass + 1))
  else
    echo "FAIL: 缺测试文件 $f"; fail=$((fail + 1))
  fi
done

# ---- 选择框对话框:/models · /agents · /sessions 从「只聚焦」改成「弹框让你选」----
if has "$HOME_HTML" 'id="dlgPick"' && has "$HOME_HTML" 'id="pickList"' &&
   has "$HOME_HTML" 'id="pickTitle"' && has "$HOME_HTML" 'id="pickFilter"'; then
  echo "PASS: 页面有选择框对话框(#dlgPick / #pickList / #pickTitle / #pickFilter)"; pass=$((pass + 1))
else
  echo "FAIL: 页面缺选择框对话框的节点"; fail=$((fail + 1))
fi
if has "$CSS" '.picklist' && has "$CSS" '.pick-item' && has "$CSS" '.pick-group'; then
  echo "PASS: styles.css 有选择框列表样式"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺选择框列表样式"; fail=$((fail + 1))
fi
PICKFN_MISSING=$(for fn in openPick closePick pickChoose pickKey pickVisible renderPick setupPick \
                          picksOpen openSessionPick openModelPick pickVariant openAgentPick applyModel visibleSessions; do
  has "$APPJS" "function $fn(" || printf '%s ' "$fn"
done)
ck "$PICKFN_MISSING" "" "app.js 有选择框与三条命令的全部函数"
# 旧做法(只 focus 原生 <select>,而浏览器不会因此展开它)必须已经不存在
if has "$APPJS" 'focusEl'; then
  echo "FAIL: 还留着 focusEl 这个「只聚焦、不弹框」的旧做法"; fail=$((fail + 1))
else
  echo "PASS: 已经没有 focusEl 这个只会聚焦的旧做法"; pass=$((pass + 1))
fi
PICK_CMDS=$(printf '%s' "$APPJS" | python3 -c "
import re, sys
src = sys.stdin.read()
block = src.split('const PANEL_COMMANDS', 1)[1].split('];', 1)[0]
want = {'sessions': 'openSessionPick', 'models': 'openModelPick', 'agents': 'openAgentPick'}
bad = [k for k, fn in want.items() if not re.search(r\"name: '\" + k + r\"'[^}]*\" + fn + r'\(\)', block)]
print(','.join(bad))
")
ck "$PICK_CMDS" "" "/sessions /models /agents 三条命令都接到了选择框"
# 完整命令名 + Enter 直接执行(省掉「补全一次再发一次」的第二下)
if has "$APPJS" 'function exactCommand' && has "$APPJS" 'exactCommand()'; then
  echo "PASS: 完整命令名 + Enter 直接执行(不用按第二次)"; pass=$((pass + 1))
else
  echo "FAIL: 没有「完整命令名 + Enter 直接执行」"; fail=$((fail + 1))
fi
if has "$APPJS" 'setupPick();'; then
  echo "PASS: init() 里接上了 setupPick()"; pass=$((pass + 1))
else
  echo "FAIL: init() 里没有接 setupPick()"; fail=$((fail + 1))
fi
for f in test/ui-picks.html test/ui-picks-run.js; do
  if [ -f "$(dirname "$0")/$(basename "$f")" ]; then
    echo "PASS: 有选择框的测试文件 $f"; pass=$((pass + 1))
  else
    echo "FAIL: 缺测试文件 $f"; fail=$((fail + 1))
  fi
done

# 顺序锁:init() 里 setupFilters() 必须排在 loadSessions 之前,否则会按默认值白拉一次
INIT_ORDER=$(printf '%s' "$APPJS" | awk '
  /^function init\(\)/ { ininit = 1 }
  ininit && /setupFilters\(\);/ { seen = 1 }
  ininit && /loadSessions\(\{ reset: true \}\)\.then/ && !done { print (seen ? "filters-first" : "list-first"); done = 1 }
')
case "$INIT_ORDER" in
  filters-first) echo "PASS: init() 先回填顶栏条件再拉列表(不会白拉一次)"; pass=$((pass + 1)) ;;
  *)             echo "FAIL: init() 没有先回填顶栏条件 (got '$INIT_ORDER')"; fail=$((fail + 1)) ;;
esac

# J 组:运行中的状态条(TUI 同款 8 格字符条「■⬝⬝⬝⬝⬝⬝⬝ esc interrupt」)
if has "$HOME_HTML" 'id="progress" hidden'; then
  echo "PASS: 首页有 #progress 且默认 hidden(脚本起来前不会先闪一条出来)"; pass=$((pass + 1))
else
  echo "FAIL: 首页缺 #progress / 没默认 hidden"; fail=$((fail + 1))
fi
if has "$HOME_HTML" 'title="正在执行 · 连按两下 Esc 中断"'; then
  echo "PASS: 状态条挂着「连按两下 Esc 中断」的提示"; pass=$((pass + 1))
else
  echo "FAIL: 状态条缺「连按两下 Esc 中断」提示"; fail=$((fail + 1))
fi
# 8 格,一格一个 <i>,数量对不上就跟 TUI 的 8 格条不是一回事了
PROG_CELLS=$(printf '%s' "$HOME_HTML" | sed -n 's/.*<span class="pbar"[^>]*>\(.*\)<\/span>.*/\1/p' | grep -o '<i></i>' | wc -l)
if [ "$PROG_CELLS" = 8 ]; then
  echo "PASS: 状态条正好 8 格"; pass=$((pass + 1))
else
  echo "FAIL: 状态条格子数不对(got $PROG_CELLS,want 8)"; fail=$((fail + 1))
fi
if has "$HOME_HTML" '<b>esc</b> interrupt'; then
  echo "PASS: 状态条带着 TUI 那句 esc interrupt(esc 亮、interrupt 暗)"; pass=$((pass + 1))
else
  echo "FAIL: 状态条缺 esc interrupt 字样"; fail=$((fail + 1))
fi
if has "$CSS" ".pbar i.on::before" && has "$CSS" "content: '■'" && has "$CSS" "content: '⬝'"; then
  echo "PASS: styles.css 用 ■/⬝ 两种字符区分走过的格与没到的格"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺 ■/⬝ 的字符规则(.pbar i.on::before)"; fail=$((fail + 1))
fi
if has "$CSS" '#progress.retry .pbar i.on::before'; then
  echo "PASS: 重试中状态条换色(#progress.retry)"; pass=$((pass + 1))
else
  echo "FAIL: 缺重试中的换色规则(#progress.retry)"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow .phint { display: none; }'; then
  echo "PASS: 手机上不显示 esc interrupt(那会儿没 Esc 键)"; pass=$((pass + 1))
else
  echo "FAIL: 手机上还显示 esc interrupt,等于教用户按一个不存在的键"; fail=$((fail + 1))
fi
# 旧的「平滑扫一条」做法必须清干净,免得两套并存
if has "$CSS" 'ocs-sweep'; then
  echo "FAIL: styles.css 还留着旧的平滑扫动(ocs-sweep)"; fail=$((fail + 1))
else
  echo "PASS: 旧的平滑扫动已清除(只剩 TUI 那套 8 格)"; pass=$((pass + 1))
fi
# 帧表本身:8 格、54 帧、40ms(TUI 的 bs({style:"blocks",holdStart:30,holdEnd:9}) + pty 抓屏实测)。
# 逐帧对表在 test/ui-stream.html 里测。
if has "$APPJS" 'const PBAR_CELLS = 8' && has "$APPJS" 'const PBAR_FRAMES = 54' && has "$APPJS" 'const PBAR_MS = 40'; then
  echo "PASS: app.js 里是 8 格 54 帧 40ms(和 TUI 实测的一致)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺 PBAR_CELLS=8 / PBAR_FRAMES=54 / PBAR_MS=40"; fail=$((fail + 1))
fi
# 位置:必须照 TUI 的 prompt.footer 放在【输入框下面】,不再是聊天头部那一行
CHATLINE=$(printf '%s' "$HOME_HTML" | grep -o 'class="chline".*' | head -1)
if printf '%s' "$CHATLINE" | grep -q 'id="progress"'; then
  echo "FAIL: 状态条还挂在聊天标题行里(TUI 是在输入框下面)"; fail=$((fail + 1))
else
  echo "PASS: 聊天标题行里没有状态条了(只剩「‹ 会话 + 标题 + ● 运行中 + 上下文用量」)"; pass=$((pass + 1))
fi
# #progress 夹在输入框(.cinput)后面、而且在 #composer 里面 = 对话框下面那一行
HTML_FLAT=$(printf '%s' "$HOME_HTML" | tr -d '\n')
CINPUT_AT=$(printf '%s' "$HTML_FLAT" | grep -bo '<div class="cinput">' | head -1 | cut -d: -f1)
PROG_AT=$(printf '%s' "$HTML_FLAT" | grep -bo '<span id="progress" hidden' | head -1 | cut -d: -f1)
COMPOSER_AT=$(printf '%s' "$HTML_FLAT" | grep -bo 'id="composer"' | head -1 | cut -d: -f1)
if [ -n "$COMPOSER_AT" ] && [ -n "$CINPUT_AT" ] && [ -n "$PROG_AT" ] &&
   [ "$COMPOSER_AT" -lt "$CINPUT_AT" ] && [ "$CINPUT_AT" -lt "$PROG_AT" ]; then
  echo "PASS: 状态条排在输入框(.cinput)后面 —— 对话框下面那一行"; pass=$((pass + 1))
else
  echo "FAIL: 状态条不在输入框后面(位置没照 TUI 搬:composer=$COMPOSER_AT cinput=$CINPUT_AT progress=$PROG_AT)"; fail=$((fail + 1))
fi
if has "$CSS" '#composer > #progress'; then
  echo "PASS: styles.css 给了「输入框下面那一行」的版式"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺 #composer > #progress 的版式"; fail=$((fail + 1))
fi
# 收起成细边时也要看得见(手机默认就是收起的):order:-1 排最左,和 ■ 中断 同一条细边
if has "$CSS" '#composer.collapsed #progress { order: -1;' && has "$CSS" '#composer.collapsed .phint { display: none; }'; then
  echo "PASS: 收起态细边上也带着状态条(不额外长高)"; pass=$((pass + 1))
else
  echo "FAIL: 收起态没安排状态条的位置(手机上收起就看不见了)"; fail=$((fail + 1))
fi
# 压缩上下文:面板要自己认这个状态(实测压缩期 /api/session/active 会空一拍)
if has "$APPJS" "t === 'session.compaction.started'" && has "$APPJS" 'store.compacting.add(sid)'; then
  echo "PASS: app.js 消费 session.compaction.*(压缩中状态条不会中途灭)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 没消费 session.compaction.*"; fail=$((fail + 1))
fi
if has "$APPJS" 'function compactionRunning(' && has "$APPJS" 'store.compacting.has(sid)'; then
  echo "PASS: 「在压缩」有单一判定(SSE 事件 + 消息状态兜底)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺 compactionRunning()"; fail=$((fail + 1))
fi
if has "$APPJS" "m.type === 'compaction'" && has "$APPJS" '上下文压缩'; then
  echo "PASS: 压缩消息画成 TUI 那种一块(不再是「· compaction」)"; pass=$((pass + 1))
else
  echo "FAIL: 压缩消息还是老样子(· compaction 垃圾行)"; fail=$((fail + 1))
fi
if has "$CSS" '.msg.compaction' && has "$CSS" '.msg.compaction .tmark.spin'; then
  echo "PASS: styles.css 有压缩块的样式(行首 spinner 定宽)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺 .msg.compaction 的样式"; fail=$((fail + 1))
fi
if has "$APPJS" '<details class="compact" open><summary>摘要</summary>'; then
  echo "PASS: 压缩摘要跟着正文印出来(摊开,外层留 details 当折叠抓手 —— TUI 就是把概要原样印在块里)"; pass=$((pass + 1))
else
  echo "FAIL: 压缩摘要没有印出来(还是只留一个 ▸ 摘要)"; fail=$((fail + 1))
fi
# 概要正文是流式的(session.compaction.delta):它【不能】被当成收工信号。原来
# `session.compaction.` 一把抓,每条 delta 都当收工 + dirty 一次重画整个左栏 ——
# 实测一份 8 KB 摘要 140+ 条 delta(5ms 一条)触发 142 次 renderSessions,压缩那几秒
# 面板整个假死(用户报的「网页版崩溃无响应」)。这三条锁住「三种事件分开处理」。
if has "$APPJS" "t === 'session.compaction.delta'" && has "$APPJS" 'store.compactText'; then
  echo "PASS: 概要正文按流式增量单独处理(攒进缓冲,不当收工)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 没有单独处理 session.compaction.delta(会退回「每条都收工+重画」)"; fail=$((fail + 1))
fi
if has "$APPJS" 'function paintCompactStream(' && has "$APPJS" 'function compactionBody('; then
  echo "PASS: 正文有节流重画与「摘要优先、流式兜底」的取值"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺 paintCompactStream()/compactionBody()"; fail=$((fail + 1))
fi
# 压缩正文必须走【局部】重绘。每条 delta 走整表 renderMessages() 会把压缩块重建 → 文档变脏,
# 紧跟着的 atBottom()/scrollHeight 读就把整篇 7800 个节点重排(实测 70~76ms/次);节流到
# 8 次/秒也是三四百毫秒的长任务,进度条 40ms 一帧全被顶掉 —— 用户看到的「进度条一动就卡」。
if has "$APPJS" 'function paintCompactBody(' && has "$APPJS" 'if (!paintCompactBody(sid)) renderMessages();'; then
  echo "PASS: 压缩正文只重画那一个正文节点,结构没建出来才退回整表"; pass=$((pass + 1))
else
  echo "FAIL: 压缩正文还在每条 delta 走整表 renderMessages()(会强制整篇重排版)"; fail=$((fail + 1))
fi
# 显示与否仍然只由 updateChatStatus() 一处决定:它调 paintProgressBar(),
# 而 paintProgressBar 在 app.js 里只应该出现两次(定义 1 次 + 被调 1 次)。
CHATSTATUS_FN=$(printf '%s' "$APPJS" | awk '/^function updateChatStatus\(\)/{f=1} f{print} f&&/^}/{exit}')
if has "$CHATSTATUS_FN" 'paintProgressBar'; then
  echo "PASS: 状态条在 updateChatStatus() 里切(与状态文字同一处)"; pass=$((pass + 1))
else
  echo "FAIL: updateChatStatus() 里没有切状态条"; fail=$((fail + 1))
fi
PROG_HITS=$(printf '%s' "$APPJS" | grep -oF 'paintProgressBar' | wc -l)
if [ "$PROG_HITS" = 2 ]; then
  echo "PASS: paintProgressBar 只被调一处(没有第二处同步点)"; pass=$((pass + 1))
else
  echo "FAIL: paintProgressBar 在 app.js 里出现 $PROG_HITS 次(want 2:定义 + updateChatStatus 里那一次)"; fail=$((fail + 1))
fi

# K 组:手机端(窄屏)适配。设计文档 docs/superpowers/specs/2026-10-15-mobile-design.md
# 判定源唯一:index.html 的 <head> 内联脚本里写死两个媒体查询,命中就给 <html> 加类。
# 内联的意义是首帧就判对 —— 等 app.js 起来再加类,手机上会先闪一下桌面布局。
if has "$HOME_HTML" "window.OCS_NARROW_MQ = '(max-width:860px),(max-height:560px) and (pointer:coarse)'"; then
  echo "PASS: 窄屏判定写在 index.html 内联脚本里(窗口窄 / 矮屏且粗指针)"; pass=$((pass + 1))
else
  echo "FAIL: index.html 里没有 OCS_NARROW_MQ 的定义"; fail=$((fail + 1))
fi
if has "$HOME_HTML" "window.OCS_SHORT_MQ = '(max-height:560px)'"; then
  echo "PASS: 另外判了「视口很矮」(手机横屏只有 393px 高,顶栏要压成一行)"; pass=$((pass + 1))
else
  echo "FAIL: index.html 里没有 OCS_SHORT_MQ 的定义"; fail=$((fail + 1))
fi
if has "$HOME_HTML" "document.documentElement.classList.add('narrow')"; then
  echo "PASS: 判定在 <head> 里当场做掉(首帧就是窄屏布局,不会闪一下桌面版)"; pass=$((pass + 1))
else
  echo "FAIL: 内联脚本没有立刻给 <html> 加 narrow"; fail=$((fail + 1))
fi
# 断点数值只允许出现在 index.html 一处:同一套判定写两份迟早漂移
MQ_HTML=$(printf '%s' "$HOME_HTML" | grep -oF 'max-width:860px' | wc -l)
MQ_CSS=$(printf '%s' "$CSS" | grep -oF 'max-width:860px' | wc -l)
MQ_JS=$(printf '%s' "$APPJS" | grep -oF 'max-width:860px' | wc -l)
if [ "$MQ_HTML" = 1 ] && [ "$MQ_CSS" = 0 ] && [ "$MQ_JS" = 0 ]; then
  echo "PASS: 断点值只写在 index.html 一处(styles.css / app.js 里都没有)"; pass=$((pass + 1))
else
  echo "FAIL: 断点值分散了(index.html=$MQ_HTML styles.css=$MQ_CSS app.js=$MQ_JS)"; fail=$((fail + 1))
fi
CSS_MQ=$(printf '%s' "$CSS" | grep -c '@media (max-width\|@media (max-height')
if [ "$CSS_MQ" = 0 ]; then
  echo "PASS: styles.css 里没有第二份断点 @media(全靠 html.narrow 前缀)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 里有 $CSS_MQ 处 @media 断点,与内联判定重复"; fail=$((fail + 1))
fi
# 新增控件:桌面默认 display:none,只在 .narrow 下露出来 —— 桌面渲染结果一像素不变
if has "$HOME_HTML" 'id="backList"' && has "$HOME_HTML" 'id="btnFilters"'; then
  echo "PASS: 首页有「‹ 会话」返回键与顶栏「筛选」按钮"; pass=$((pass + 1))
else
  echo "FAIL: 缺 #backList / #btnFilters"; fail=$((fail + 1))
fi
if has "$APPJS" 'data-act="more"'; then
  echo "PASS: 每行有把动作收起来的「⋯」按钮"; pass=$((pass + 1))
else
  echo "FAIL: 列表里没有「⋯」按钮(data-act=\"more\")"; fail=$((fail + 1))
fi
if has "$CSS" '#list .actions .more { display: none; }' && has "$CSS" 'html.narrow #list .actions .more { display: inline-flex; }'; then
  echo "PASS: 这三个新控件桌面藏、窄屏露(桌面 DOM 里多出来但不显示)"; pass=$((pass + 1))
else
  echo "FAIL: 新控件的默认隐藏 / 窄屏显示规则缺了"; fail=$((fail + 1))
fi
# 窄屏只有一栏:靠 <html>.view-chat 二选一,默认(没选中)= 列表
if has "$CSS" 'html.narrow #chatpane { display: none; }' && has "$CSS" 'html.narrow.view-chat #listpane { display: none; }'; then
  echo "PASS: 窄屏是列表 / 对话二选一(默认列表)"; pass=$((pass + 1))
else
  echo "FAIL: 缺窄屏两屏切换的规则"; fail=$((fail + 1))
fi
if has "$APPJS" "toggle('view-chat', !!store.selected)"; then
  echo "PASS: view-chat 由 store.selected 派生(没有引入第二个状态变量)"; pass=$((pass + 1))
else
  echo "FAIL: view-chat 不是从 store.selected 派生的"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow main.list-hidden #listpane { display: block; }'; then
  echo "PASS: 桌面留下的折叠态在窄屏被复位(否则列表整块看不见)"; pass=$((pass + 1))
else
  echo "FAIL: 窄屏没有复位 main.list-hidden"; fail=$((fail + 1))
fi
NARROW_DLG=$(printf '%s' "$CSS" | awk '/^html\.narrow dialog\.dlg \{/{f=1} f{print} f&&/^\}/{exit}')
if has "$NARROW_DLG" 'min-width: 0;'; then
  echo "PASS: 窄屏对话框把 min-width:420px 归零(393px 的屏上放得下)"; pass=$((pass + 1))
else
  echo "FAIL: 窄屏对话框没有把 min-width 归零"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow .dlgacts .chip { min-height: 44px; }'; then
  echo "PASS: 窄屏命中区撑到 44px(手指按得准)"; pass=$((pass + 1))
else
  echo "FAIL: 窄屏没有把命中区撑到 44px"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow #ctoolbar .ctl select { font-size: 16px; }'; then
  echo "PASS: 窄屏输入控件 ≥16px(否则聚焦时浏览器会自动放大整页)"; pass=$((pass + 1))
else
  echo "FAIL: 窄屏输入控件字号不足 16px"; fail=$((fail + 1))
fi
if [ "$(printf '%s' "$CSS" | grep -oF -- '--chat-fs:' | wc -l)" = 1 ]; then
  echo "PASS: 会话区字号仍只有一个旋钮 --chat-fs(窄屏没有偷偷再定一份)"; pass=$((pass + 1))
else
  echo "FAIL: --chat-fs 被定义了多次,字号旋钮不再单一"; fail=$((fail + 1))
fi
# 横竖屏切换要重新判定;接线只允许一处(init)
NARROW_FN=$(printf '%s' "$APPJS" | awk '/^function setupNarrow\(\)/{f=1} f{print} f&&/^\}/{exit}')
if has "$NARROW_FN" "matchMedia(mq).addEventListener('change', syncNarrowClass)"; then
  echo "PASS: 跨过断点(转屏)时会重新判定"; pass=$((pass + 1))
else
  echo "FAIL: setupNarrow 没监听媒体查询的 change"; fail=$((fail + 1))
fi
INIT_FN=$(printf '%s' "$APPJS" | awk '/^function init\(\)/{f=1} f{print} f&&/^\}/{exit}')
if has "$INIT_FN" 'setupNarrow()'; then
  echo "PASS: setupNarrow() 接进了 init()"; pass=$((pass + 1))
else
  echo "FAIL: init() 里没有 setupNarrow()"; fail=$((fail + 1))
fi
if [ "$(printf '%s' "$APPJS" | grep -oF 'setupNarrow' | wc -l)" = 2 ]; then
  echo "PASS: setupNarrow 只有定义 + init 里一次(没有第二处接线)"; pass=$((pass + 1))
else
  echo "FAIL: setupNarrow 出现次数不对(应当 2:定义 + init 里那次)"; fail=$((fail + 1))
fi

# L 组:静态资源缓存头 —— index.html / app.js / styles.css 是三份要配套的文件。
# 没有 Cache-Control / ETag 时,浏览器只能靠启发式乱猜,猜错就出现「新 HTML + 旧 CSS」
# 这种半新半旧的页面:实测过一次,旧 styles.css 的 #progress 还是贴下沿的 2px 条
# (position:absolute + overflow:hidden),配上新 markup 正好把整条状态条裁没了。
H_STYLES=$(curl -s -D - -o /dev/null "${AUTH[@]}" "$PROXY/styles.css")
H_APPJS=$(curl -s -D - -o /dev/null "${AUTH[@]}" "$PROXY/app.js")
H_HOME=$(curl -s -D - -o /dev/null "${AUTH[@]}" "$PROXY/")
if has "$H_STYLES" 'etag: "' && has "$H_APPJS" 'etag: "' && has "$H_HOME" 'etag: "'; then
  echo "PASS: 三份文件都带 ETag(改完能立刻认出新旧)"; pass=$((pass + 1))
else
  echo "FAIL: index.html / app.js / styles.css 里有不带 ETag 的"; fail=$((fail + 1))
fi
if has "$H_STYLES" 'cache-control: no-cache' && has "$H_HOME" 'cache-control: no-cache'; then
  echo "PASS: 静态资源是 no-cache(每次用之前必须来问一声,不是不听劝的强缓存)"; pass=$((pass + 1))
else
  echo "FAIL: 静态资源缺 cache-control: no-cache"; fail=$((fail + 1))
fi
ETAG=$(printf '%s' "$H_STYLES" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)
SIZE304=$(curl -s -o /dev/null -w '%{size_download}' "${AUTH[@]}" -H "If-None-Match: $ETAG" -D /tmp/oc-304.h "$PROXY/styles.css")
if has "$(cat /tmp/oc-304.h)" '304 Not Modified' && [ "$SIZE304" = 0 ]; then
  echo "PASS: 内容没变时回 304 且不重发正文(省流量,但绝不给你旧内容)"; pass=$((pass + 1))
else
  echo "FAIL: 带 if-none-match 重发没拿到 304(拿到 $(head -1 /tmp/oc-304.h) / ${SIZE304} 字节)"; fail=$((fail + 1))
fi
H_API=$(curl -s -D - -o /dev/null "${AUTH[@]}" "$PROXY/api/session?limit=1")
if has "$H_API" 'cache-control: no-store'; then
  echo "PASS: /api/ 一律 no-store(会话与消息是活的,不许缓存)"; pass=$((pass + 1))
else
  echo "FAIL: /api/ 响应没有 cache-control: no-store"; fail=$((fail + 1))
fi
rm -f /tmp/oc-304.h

sse=$(timeout 3 curl -s -N "${AUTH[@]}" "$PROXY/api/event" | head -c 4000)
if has "$sse" 'server.connected'; then
  echo "PASS: 经代理 SSE 收到 server.connected"; pass=$((pass + 1))
else
  echo "FAIL: 经代理未收到 server.connected"; fail=$((fail + 1))
fi

# ---- M 组:底板(输入区)收起 / 展开 ----
# 手机屏幕小,收起后只剩一条细边,高度让给会话内容。这一组锁的是几条【不变量】:
# 手柄永远点得回来、运行中的中断永不被藏、两份记忆互不干扰。
if has "$HOME_HTML" 'id="btnComposer"' && has "$HOME_HTML" 'id="cstripMeta"'; then
  echo "PASS: index.html 有折叠手柄与细边上的提示区"; pass=$((pass + 1))
else
  echo "FAIL: index.html 缺 id=btnComposer / id=cstripMeta"; fail=$((fail + 1))
fi
if [ "$(printf '%s' "$HOME_HTML" | grep -oF 'id="btnComposer"' | wc -l)" = 1 ]; then
  echo "PASS: 手柄只有一个(不是每屏各做一份)"; pass=$((pass + 1))
else
  echo "FAIL: 手柄出现次数不是 1"; fail=$((fail + 1))
fi
# 手柄是 #composer 的子元素:它绝对定位在底板上沿,必须留在底板里,否则收起后就没了
if has "$(printf '%s' "$HOME_HTML" | awk '/id="composer"/{f=1} f{print} f&&/<\/section>/{exit}')" 'id="btnComposer" class="chip"'; then
  echo "PASS: 手柄在 #composer 里,且是 .chip(窄屏因此自动拿到 ≥44 命中区)"; pass=$((pass + 1))
else
  echo "FAIL: 手柄不在 #composer 里 / 没带 .chip"; fail=$((fail + 1))
fi
# 收起 = 藏东西。要防的是「顺手把中断也藏了」——运行中它是细边上唯一的出口
COLLAPSED_HIDE=$(printf '%s' "$CSS" | awk '/^#composer\.collapsed #ctoolbar \.ctl,$/{f=1} f{print} f&&/display: none; \}$/{exit}')
if has "$COLLAPSED_HIDE" 'display: none;' && ! has "$COLLAPSED_HIDE" 'interrupt'; then
  echo "PASS: 收起的隐藏名单里没有中断(运行中它是唯一不能藏的东西)"; pass=$((pass + 1))
else
  echo "FAIL: 隐藏名单缺了,或把 interrupt 一起藏了"; fail=$((fail + 1))
fi
HANDLE_CSS=$(printf '%s' "$CSS" | awk '/^#btnComposer \{/{f=1} f{print} f&&/^\}$/{exit}')
if has "$HANDLE_CSS" 'position: absolute' && ! has "$HANDLE_CSS" 'display: none'; then
  echo "PASS: 手柄绝不 display:none(收起后它就是那条细边的一部分)"; pass=$((pass + 1))
else
  echo "FAIL: 手柄样式缺 position:absolute,或被 display:none 藏了"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow #composer.collapsed { min-height: 48px; }'; then
  echo "PASS: 手机上细边有 44px 级的高度(手指按得准,不是一条缝)"; pass=$((pass + 1))
else
  echo "FAIL: 缺窄屏细边高度"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow #composer.collapsed #ctoolbar'; then
  echo "PASS: 窄屏收起时工具栏给手柄让出了位(否则手柄压在控件上)"; pass=$((pass + 1))
else
  echo "FAIL: 窄屏收起缺让位规则"; fail=$((fail + 1))
fi
PAINT_FN=$(printf '%s' "$APPJS" | awk '/^function paintComposer\(\)/{f=1} f{print} f&&/^\}$/{exit}')
if has "$PAINT_FN" 'if (!comp || !btn) return;'; then
  echo "PASS: 手柄不在就整体不收起(新 app.js 配旧 index.html 不会把底板锁死)"; pass=$((pass + 1))
else
  echo "FAIL: paintComposer 少了「没有手柄就不收起」的守卫"; fail=$((fail + 1))
fi
if has "$APPJS" "'ocs.composerHidden'" && has "$APPJS" "'ocs.composerHiddenNarrow'"; then
  echo "PASS: 记忆分两份(桌面 / 手机各一份)"; pass=$((pass + 1))
else
  echo "FAIL: 缺其中一份记忆的键名"; fail=$((fail + 1))
fi
HIDDEN_FN=$(printf '%s' "$APPJS" | awk '/^function composerHidden\(\)/{f=1} f{print} f&&/^\}$/{exit}')
if has "$HIDDEN_FN" "contains('narrow');"; then
  echo "PASS: 没记过时手机=收起、桌面=展开(默认值跟着判定源走)"; pass=$((pass + 1))
else
  echo "FAIL: composerHidden 的默认值不是按 html.narrow 来的"; fail=$((fail + 1))
fi
NARROWCLASS_FN=$(printf '%s' "$APPJS" | awk '/^function syncNarrowClass\(\)/{f=1} f{print} f&&/^\}$/{exit}')
if has "$NARROWCLASS_FN" 'paintComposer();'; then
  echo "PASS: 转屏跨断点时会重读这一档自己的那份记忆"; pass=$((pass + 1))
else
  echo "FAIL: syncNarrowClass 里没有重读"; fail=$((fail + 1))
fi
if has "$(printf '%s' "$APPJS" | awk '/^function renderAttachments\(\)/{f=1} f{print} f&&/^\}$/{exit}')" 'syncComposerMeta();'; then
  echo "PASS: 收起时细边的「草稿 / 📎 n」跟着附件与正文一起变"; pass=$((pass + 1))
else
  echo "FAIL: renderAttachments 没有同步细边提示"; fail=$((fail + 1))
fi
DROP_HANDLER=$(printf '%s' "$APPJS" | awk '/addEventListener\(.drop./{f=1} f{print} f&&/^[[:space:]]*\}\);$/{exit}')
if has "$DROP_HANDLER" 'expandComposer();'; then
  echo "PASS: 收起时拖文件进来会自动展开(点手柄那一步省了)"; pass=$((pass + 1))
else
  echo "FAIL: drop 处理器里没有自动展开"; fail=$((fail + 1))
fi
INIT_FN_M=$(printf '%s' "$APPJS" | awk '/^function init\(\)/{f=1} f{print} f&&/^\}$/{exit}')
if has "$INIT_FN_M" 'setupComposerToggle()' &&
   [ "$(printf '%s' "$APPJS" | grep -oF 'setupComposerToggle' | wc -l)" = 2 ]; then
  echo "PASS: setupComposerToggle() 接进了 init() 且只有这一处接线"; pass=$((pass + 1))
else
  echo "FAIL: setupComposerToggle 的接线不对"; fail=$((fail + 1))
fi
for f in test/ui-composer.html test/ui-composer-run.js; do
  if [ -f "$(dirname "$0")/$(basename "$f")" ]; then
    echo "PASS: 有 M 组的测试文件 $f"; pass=$((pass + 1))
  else
    echo "FAIL: 缺测试文件 $f"; fail=$((fail + 1))
  fi
done

# ---- N 组:「运行中」一个标记都不画 ----
# 对话头部那套(标题旁的「● 运行中」+ 进度条)是唯一该说这个状态的地方;
# 工具行再来一个标记(字或点)就是重复,手机竖屏上那个「运行中」还会折成两行。
STATUS_FN=$(printf '%s' "$APPJS" | awk '/^function statusInfo\(p\)/{f=1} f{print} f&&/^\}$/{exit}')
if has "$STATUS_FN" "running: { icon: '', cls: 'run', label: '' }" &&
   has "$STATUS_FN" "streaming: { icon: '', cls: 'run', label: '' }"; then
  echo "PASS: 运行中的工具行不写字也不画点(icon 与 label 都是空的)"; pass=$((pass + 1))
else
  echo "FAIL: statusInfo 的 running/streaming 又带上图标或标签了"; fail=$((fail + 1))
fi
TOOLHEAD_FN=$(printf '%s' "$APPJS" | awk '/^function toolHead\(/{f=1} f{print} f&&/^\}$/{exit}')
if has "$TOOLHEAD_FN" 's.icon || s.label'; then
  echo "PASS: 状态标记空着就整个 <span> 都不输出(不留空壳)"; pass=$((pass + 1))
else
  echo "FAIL: toolHead 无条件画状态 <span>"; fail=$((fail + 1))
fi
# 但头部那个不能跟着一起没了 —— 状态只说一遍,但必须说
if has "$APPJS" "'● 运行中', 'state running', 'run'"; then
  echo "PASS: 对话头部的「● 运行中」还在"; pass=$((pass + 1))
else
  echo "FAIL: 头部状态文案没了"; fail=$((fail + 1))
fi
if has "$APPJS" "'✓', cls: 'ok', label: ''" && has "$APPJS" "'✗', cls: 'err', label: '出错'"; then
  echo "PASS: 完成/出错这两个可读标记没被顺手删掉"; pass=$((pass + 1))
else
  echo "FAIL: 完成或出错的状态标记丢了"; fail=$((fail + 1))
fi

# ---- N2 组:行尾不画,但行首那个标记要动起来 ----
# TUI 抓屏实测:工具行行首的标记在 running 时由 `$` 变成盲文 spinner
# (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏,80ms 一帧、10 帧一循环)。这跟上面删掉的「行尾 ● 运行中」
# 不是一回事:那是重复的状态文字,这是行首标记的动效(照 TUI 放在命令前面)。
if has "$APPJS" "const SPIN_FRAMES = ['⠋', '⠙'" && has "$APPJS" 'const SPIN_MS = 80'; then
  echo "PASS: 行首 spinner 用 TUI 的 dots 组、80ms 一帧"; pass=$((pass + 1))
else
  echo "FAIL: spinner 的帧表或间隔跟 TUI 对不上"; fail=$((fail + 1))
fi
if has "$TOOLHEAD_FN" 'toolRunning(p)' && has "$TOOLHEAD_FN" "spin ? ' spin' : ''"; then
  echo "PASS: 运行中的工具行首标记换成 spinner"; pass=$((pass + 1))
else
  echo "FAIL: toolHead 没有按运行状态换行首标记"; fail=$((fail + 1))
fi
SPIN_CSS=$(printf '%s' "$CSS" | awk '/^\.tool \.tmark\.spin, \.toolrow \.tmark\.spin \{/{f=1} f{print} f&&/^\}$/{exit}')
if has "$SPIN_CSS" 'min-width: 1em'; then
  echo "PASS: spinner 定宽占位(逐帧换字不抖行)"; pass=$((pass + 1))
else
  echo "FAIL: .tmark.spin 没定宽"; fail=$((fail + 1))
fi

# ---- O 组:一键回底(TUI 的 "Jump to latest ↓") ----
# 往上翻走之后给一个一键回到最新的入口。它与「自动跟随」共用同一个「在不在底部」判定,
# 所以两处必须同源(否则会出现「明明跟着跳到底了,按钮还杵在那儿」)。
MSG_HTML=$(printf '%s' "$HOME_HTML" | awk '/<div id="messages">/{f=1} f{print} f&&/<\/div>/{exit}')
if has "$MSG_HTML" 'id="jumpLatest"' && has "$MSG_HTML" 'class="chip"'; then
  echo "PASS: 「跳到最新」是 #messages 里的 .chip 按钮"; pass=$((pass + 1))
else
  echo "FAIL: #jumpLatest 不在 #messages 里(或在里面但不是 .chip)"; fail=$((fail + 1))
fi
if has "$MSG_HTML" 'hidden' && has "$MSG_HTML" '跳到最新 ↓'; then
  echo "PASS: 它默认收起,文案是「跳到最新 ↓」"; pass=$((pass + 1))
else
  echo "FAIL: 默认没收起,或者文案不对"; fail=$((fail + 1))
fi
JUMP_CSS=$(printf '%s' "$CSS" | awk '/^#jumpLatest \{/{f=1} f{print} f&&/^\}$/{exit}')
if has "$JUMP_CSS" 'position: sticky' && has "$JUMP_CSS" 'bottom: 8px'; then
  echo "PASS: 它 sticky 在滚动口下沿(absolute 会跟着内容一起滚走)"; pass=$((pass + 1))
else
  echo "FAIL: #jumpLatest 不是 sticky 在底部"; fail=$((fail + 1))
fi
if has "$CSS" '#jumpLatest[hidden] { display: none; }'; then
  echo "PASS: 显式写了 #jumpLatest[hidden](id 选择器压得住 .chip[hidden],不写就藏不住)"; pass=$((pass + 1))
else
  echo "FAIL: 少了 #jumpLatest[hidden] 的兜底"; fail=$((fail + 1))
fi
if has "$APPJS" 'const BOTTOM_SLACK = 80;' && has "$APPJS" 'function atBottom(box)'; then
  echo "PASS: 「在不在底部」的口径只有一处(BOTTOM_SLACK + atBottom)"; pass=$((pass + 1))
else
  echo "FAIL: 没有统一的底部判定"; fail=$((fail + 1))
fi
RENDER_FN_O=$(printf '%s' "$APPJS" | awk '/^function renderMessages\(\)/{f=1} f{print} f&&/^\}$/{exit}')
DELTA_FN_O=$(printf '%s' "$APPJS" | awk '/^function paintLiveDelta\(/{f=1} f{print} f&&/^\}$/{exit}')
# 整表 renderMessages() 里读一次 atBottom()(该量还得量);增量重绘(paintLiveDelta/
# paintCompactBody)只读 store.nearBottom —— 文档刚改完就去读 scrollHeight 会把 7800
# 个节点整篇重排(实测脏树 23~29ms,干净 0.95ms),每个 token delta 都摊一次太贵。
if has "$RENDER_FN_O" 'atBottom(box)' && has "$DELTA_FN_O" 'store.nearBottom'; then
  echo "PASS: 自动跟随与按钮共用 atBottom()(增量重绘只读缓存,不再各写一个 80)"; pass=$((pass + 1))
else
  echo "FAIL: 自动跟随或按钮没走 atBottom()"; fail=$((fail + 1))
fi
if has "$RENDER_FN_O" 'updateJumpLatest(' && has "$DELTA_FN_O" 'updateJumpLatest('; then
  echo "PASS: 内容变长之后按钮的显隐会跟着重算"; pass=$((pass + 1))
else
  echo "FAIL: 渲染之后没重算按钮"; fail=$((fail + 1))
fi
UPD_FN_O=$(printf '%s' "$APPJS" | awk '/^function updateJumpLatest\(/{f=1} f{print} f&&/^\}$/{exit}')
if has "$UPD_FN_O" 'jumpBtn.parentElement !== box'; then
  echo "PASS: #messages 被清空(切会话/取消选中)后按钮自己搬回来"; pass=$((pass + 1))
else
  echo "FAIL: 按钮被 innerHTML 抹掉后没人搬回来"; fail=$((fail + 1))
fi
if has "$UPD_FN_O" 'store.nearBottom ='; then
  echo "PASS: nearBottom 缓存只有 updateJumpLatest() 一处写(滚动/每次渲染都汇到这里)"; pass=$((pass + 1))
else
  echo "FAIL: nearBottom 缓存不是集中在 updateJumpLatest() 里刷"; fail=$((fail + 1))
fi
KEY_FN_O=$(printf '%s' "$APPJS" | awk '/^function setupTuiKeys\(\)/{f=1} f{print} f&&/^\}$/{exit}')
if has "$KEY_FN_O" "e.key === 'End'" && has "$KEY_FN_O" 'inField'; then
  echo "PASS: End = 跳回最新(对应 TUI session.last),焦点在输入框里不抢"; pass=$((pass + 1))
else
  echo "FAIL: 没接 End 键,或者没挡输入框"; fail=$((fail + 1))
fi
if has "$APPJS" "'End', d: '跳回最新消息(对应 TUI session.last)"; then
  echo "PASS: 快捷键清单里写了 End"; pass=$((pass + 1))
else
  echo "FAIL: 快捷键清单里没有 End"; fail=$((fail + 1))
fi
INIT_FN_O=$(printf '%s' "$APPJS" | awk '/^function init\(\)/{f=1} f{print} f&&/^\}$/{exit}')
if has "$INIT_FN_O" 'setupJumpLatest()' &&
   [ "$(printf '%s' "$APPJS" | grep -oF 'setupJumpLatest' | wc -l)" = 2 ]; then
  echo "PASS: setupJumpLatest() 接进了 init() 且只有这一处接线"; pass=$((pass + 1))
else
  echo "FAIL: setupJumpLatest 的接线不对(应为 定义 1 次 + init 里 1 次)"; fail=$((fail + 1))
fi
for f in test/ui-jump.html test/ui-jump-run.js; do
  if [ -f "$(dirname "$0")/$(basename "$f")" ]; then
    echo "PASS: 有 O 组的测试文件 $f"; pass=$((pass + 1))
  else
    echo "FAIL: 缺测试文件 $f"; fail=$((fail + 1))
  fi
done

# ---- P 组:鼠标靠左边缘 → 列表临时拉出来 ----
# 列表收起后,左边那条 16px 分栏槽是鼠标最容易撞到的边界:靠上去临时拉出来,移开就收回。
# 临时态(list-peek)与记忆(list-hidden)是两个类,靠 CSS 顺序让临时态赢 —— 这两条必须写对顺序。
PEEK_LINE=$(printf '%s' "$CSS" | grep -n '^main\.list-peek {' | head -1 | cut -d: -f1)
HIDE_LINE=$(printf '%s' "$CSS" | grep -n '^main\.list-hidden {' | head -1 | cut -d: -f1)
if [ -n "$PEEK_LINE" ] && [ -n "$HIDE_LINE" ] && [ "$PEEK_LINE" -gt "$HIDE_LINE" ]; then
  echo "PASS: main.list-peek 写在 main.list-hidden 之后(同优先级靠顺序赢)"; pass=$((pass + 1))
else
  echo "FAIL: list-peek 的 CSS 顺序不对(peek 会被 list-hidden 压住)"; fail=$((fail + 1))
fi
if has "$CSS" 'main.list-peek #listpane { display: block;' &&
   has "$CSS" 'var(--list-w, 560px) var(--rz-w, 16px) minmax(0, 1fr)'; then
  echo "PASS: 临时展开还是「列表 + 16px 分栏条 + 对话区」三列,用的是用户拖出来的列宽"; pass=$((pass + 1))
else
  echo "FAIL: list-peek 的网格/列表可见性不对"; fail=$((fail + 1))
fi
PEEK_FN=$(printf '%s' "$APPJS" | awk '/^function setupListPeek\(\)/{f=1} f{print} f&&/^\}$/{exit}')
if has "$PEEK_FN" "addEventListener('mousemove'" && has "$PEEK_FN" "addEventListener('mouseleave'"; then
  echo "PASS: 靠左边缘展开 / 移出主区收回(mousemove + mouseleave)"; pass=$((pass + 1))
else
  echo "FAIL: setupListPeek 没挂 mousemove/mouseleave"; fail=$((fail + 1))
fi
if has "$PEEK_FN" 'rz.getBoundingClientRect().right' && ! has "$PEEK_FN" 'relatedTarget'; then
  echo "PASS: 按「分栏槽右沿」判定,不用 relatedTarget(展开会把槽从光标底下挪走)"; pass=$((pass + 1))
else
  echo "FAIL: 收回判定用了会抖的 relatedTarget"; fail=$((fail + 1))
fi
if has "$PEEK_FN" "classList.contains('narrow')" && has "$PEEK_FN" 'dataset.peekWired'; then
  echo "PASS: 窄屏挡一道 + 重复接线只重画"; pass=$((pass + 1))
else
  echo "FAIL: 少了窄屏判定或重复接线保护"; fail=$((fail + 1))
fi
if has "$PEEK_FN" "btn.addEventListener('click', () => hide(true))"; then
  echo "PASS: 临时展开期间点手柄 → 显式展开并保持(记忆由 setupListToggle 写)"; pass=$((pass + 1))
else
  echo "FAIL: 点手柄没有把临时态摘掉"; fail=$((fail + 1))
fi
# 动手(改名/移动/删除/归档)会弹原生 confirm/prompt:弹窗期间页面会收到一串像「指针跑掉了」
# 的事件(mouseleave,关掉时还可能再来一发 mousemove),任一条落到「不在分栏槽里」的判定上
# 就把临时展开收掉,而收掉后分栏槽缩回 x=0..16,列表再也拉不回来。
# 所以 onAction() 动手前叫一声 listPeekHold():宽限期里【两条路径都不收】,到点按指针最后
# 停在哪复查。
if has "$PEEK_FN" 'PEEK_HOLD_MS' && has "$PEEK_FN" 'if (Date.now() < peekHoldUntil) return;' &&
   has "$PEEK_FN" 'peekLastX' && has "$PEEK_FN" 'holdExpire'; then
  echo "PASS: 弹窗那一串事件有宽限期兜着(mouseleave 与 mousemove 都不收,到点复查)"; pass=$((pass + 1))
else
  echo "FAIL: 缺「动手后别被弹窗收掉列表」的宽限期"; fail=$((fail + 1))
fi
ONACTION_FN=$(printf '%s' "$APPJS" | awk '/^async function onAction\(/{f=1} f{print} f&&/^\}$/{exit}')
if has "$ONACTION_FN" 'if (listPeekHold) listPeekHold();'; then
  echo "PASS: onAction() 动手之前先武装宽限期"; pass=$((pass + 1))
else
  echo "FAIL: onAction() 没有叫 listPeekHold()(删完一个列表就当场收了)"; fail=$((fail + 1))
fi
INIT_FN_P=$(printf '%s' "$APPJS" | awk '/^function init\(\)/{f=1} f{print} f&&/^\}$/{exit}')
if has "$INIT_FN_P" 'setupListPeek()' &&
   [ "$(printf '%s' "$APPJS" | grep -oF 'setupListPeek' | wc -l)" = 2 ]; then
  echo "PASS: setupListPeek() 接进了 init() 且只有这一处接线"; pass=$((pass + 1))
else
  echo "FAIL: setupListPeek 的接线不对(应为 定义 1 次 + init 里 1 次)"; fail=$((fail + 1))
fi
if has "$(cat "$(dirname "$0")/ui-layout.html")" "list-peek"; then
  echo "PASS: ui-layout.html 里有临时展开的断言"; pass=$((pass + 1))
else
  echo "FAIL: ui-layout.html 里没有 list-peek 的断言"; fail=$((fail + 1))
fi

# ---- Q 组:上下文用量(TUI 提示栏的 155.6K (78%)) ----
# 用户报「网页版不显示 155.6K (78%)」。TUI 提示栏右边那个数不是存好的,是每次从消息现算
# (见 app.js 的 contextUsage 顶上那段源码原文),面板把它画在会话头部标题行 —— 那个位置
# 窄屏也一直看得见(底板收起时也在)。两条硬约束:
#   ① 只认最后一次【已完成】压缩之后的助手消息(压缩把上下文清空了,之前的数不算);
#   ② 全量 / 窄屏两档文案都印在 DOM 里,由 CSS 按 html.narrow 挑,不用 JS 判宽度。
CLINE_AT=$(printf '%s' "$HTML_FLAT" | grep -bo 'class="chline"' | head -1 | cut -d: -f1)
CTX_AT=$(printf '%s' "$HTML_FLAT" | grep -bo 'id="ctxInfo"' | head -1 | cut -d: -f1)
META_AT=$(printf '%s' "$HTML_FLAT" | grep -bo 'id="chatMeta"' | head -1 | cut -d: -f1)
if [ -n "$CTX_AT" ] && [ "$CLINE_AT" -lt "$CTX_AT" ] && [ "$CTX_AT" -lt "$META_AT" ]; then
  echo "PASS: 上下文用量挂在会话头部标题行(#ctxInfo,窄屏也看得见)"; pass=$((pass + 1))
else
  echo "FAIL: #ctxInfo 不在标题行里(chline=$CLINE_AT ctx=$CTX_AT meta=$META_AT)"; fail=$((fail + 1))
fi
if has "$HOME_HTML" 'class="ctxFull"' && has "$HOME_HTML" 'class="ctxCompact"'; then
  echo "PASS: 全量 / 窄屏两档文案都在 DOM 里(窄屏那档就是 TUI 的 compact)"; pass=$((pass + 1))
else
  echo "FAIL: #ctxInfo 缺 ctxFull/ctxCompact 两档"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow #ctxInfo .ctxFull { display: none; }' &&
   has "$CSS" 'html.narrow #ctxInfo .ctxCompact { display: inline; }'; then
  echo "PASS: 窄屏由 CSS 换成 compact 档(横竖屏来回转也不用重画)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺窄屏切档规则"; fail=$((fail + 1))
fi
CTX_FN=$(printf '%s' "$APPJS" | awk '/^function contextUsage\(/{f=1} f{print} f&&/^\}$/{exit}')
CTX_LAST_FN=$(printf '%s' "$APPJS" | awk '/^function lastUsageMessage\(/{f=1} f{print} f&&/^\}$/{exit}')
if has "$CTX_LAST_FN" "m.type === 'compaction' && m.status === 'completed'" &&
   has "$CTX_FN" 'cache.read' && has "$CTX_FN" 'limit.context' &&
   has "$APPJS" 'store.models.get(dir)'; then
  echo "PASS: 用量照 TUI 现算(压缩后重算 + 五路 tokens 求和 + 该 location 的模型表得百分比)"; pass=$((pass + 1))
else
  echo "FAIL: contextUsage()/lastUsageMessage() 的算法不对"; fail=$((fail + 1))
fi
if has "$APPJS" 'function fmtSize(' && has "$APPJS" "(n / 1e6).toFixed(1) + 'M'" &&
   has "$APPJS" "(n / 1000).toFixed(1) + 'K'"; then
  echo "PASS: fmtSize 是 TUI 的 zN(155600 → 155.6K)"; pass=$((pass + 1))
else
  echo "FAIL: 缺 fmtSize()/缩写规则"; fail=$((fail + 1))
fi
if has "$APPJS" "u.percent + '% ctx'"; then
  echo "PASS: 窄屏文案就是 TUI 的 compact(78% ctx)"; pass=$((pass + 1))
else
  echo "FAIL: 窄屏文案没照 TUI"; fail=$((fail + 1))
fi
CTX_CALLS=$(printf '%s' "$APPJS" | grep -oF 'paintContextUsage();' | wc -l)
if has "$APPJS" 'function paintContextUsage(' && has "$APPJS" 'function currentMessages(' &&
   [ "$CTX_CALLS" = 3 ]; then
  echo "PASS: paintContextUsage 三个调用点(updateChatStatus 两分支 + renderControls),口径与渲染共用 currentMessages()"; pass=$((pass + 1))
else
  echo "FAIL: paintContextUsage 的接线不对(got $CTX_CALLS 个调用点)"; fail=$((fail + 1))
fi
if has "$(cat "$(dirname "$0")/ui-stream.html")" "#ctxInfo"; then
  echo "PASS: ui-stream.html 里有上下文用量的断言"; pass=$((pass + 1))
else
  echo "FAIL: ui-stream.html 里没有上下文用量的断言"; fail=$((fail + 1))
fi
# 离屏消息跳过渲染(content-visibility:auto):只对长会话开,而且必须挂 .cvmany 这个开关
if has "$CSS" '#messages.cvmany > .msg' && has "$CSS" 'content-visibility: auto' &&
   has "$CSS" 'contain-intrinsic-size: auto'; then
  echo "PASS: 长会话离屏消息跳过渲染(.cvmany + content-visibility + 估值高度)"; pass=$((pass + 1))
else
  echo "FAIL: 缺 content-visibility 优化或没挂 .cvmany 开关"; fail=$((fail + 1))
fi
# 反向封锁:不许无条件挂 —— 短会话拿估值占位会把「不用滚」的场景撑出假滚动条
if printf '%s' "$CSS" | grep -qE '^[[:space:]]*#messages > \.msg[[:space:]]*\{'; then
  echo "FAIL: content-visibility 挂成了无条件(#messages > .msg),短会话会被估值撑出假滚动条"; fail=$((fail + 1))
else
  echo "PASS: content-visibility 没有无条件挂(短会话行为不变)"; pass=$((pass + 1))
fi
if has "$APPJS" 'const CV_MIN_MSGS' && has "$APPJS" "classList.toggle('cvmany'" &&
   has "$(cat "$(dirname "$0")/ui-layout.html")" 'cvmany'; then
  echo "PASS: 开关由 renderMessages() 按条数挂,ui-layout 有正反两面的断言"; pass=$((pass + 1))
else
  echo "FAIL: .cvmany 开关的接线不对(或缺 ui-layout 断言)"; fail=$((fail + 1))
fi

echo
echo "结果: $pass 通过, $fail 失败"
[ "$fail" = 0 ]
