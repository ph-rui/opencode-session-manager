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

# 前端逻辑:折叠状态要能被记住,选中会话要写进 URL hash
APPJS=$(curl -s "${AUTH[@]}" "$PROXY/app.js")
if has "$APPJS" 'ocs.listHidden'; then
  echo "PASS: app.js 记住列表折叠状态(ocs.listHidden)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 未记住列表折叠状态"; fail=$((fail + 1))
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
  f && /interrupt\(\);$/ && !c { c = 1 }
  f && /^}/ { exit }
  END { print (a && b && c) ? "cmds-mentions-interrupt" : "wrong" }
')
case "$ESC_ORDER" in
  cmds-mentions-interrupt) echo "PASS: Esc 优先级 = 关命令面板 → 关 @ 补全 → 中断"; pass=$((pass + 1)) ;;
  *) echo "FAIL: Esc 优先级顺序不对 (got '$ESC_ORDER')"; fail=$((fail + 1)) ;;
esac
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

sse=$(timeout 3 curl -s -N "${AUTH[@]}" "$PROXY/api/event" | head -c 4000)
if has "$sse" 'server.connected'; then
  echo "PASS: 经代理 SSE 收到 server.connected"; pass=$((pass + 1))
else
  echo "FAIL: 经代理未收到 server.connected"; fail=$((fail + 1))
fi

echo
echo "结果: $pass 通过, $fail 失败"
[ "$fail" = 0 ]
