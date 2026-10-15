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
