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

# 只报开/关,绝不回显凭据本身 —— `${OCS_AUTH:+开}${OCS_AUTH:-关}` 在设置了变量时
# 两段都会展开(后一段就是密码),别再用那个写法。
if [ -n "${OCS_AUTH:-}" ]; then PANEL_AUTH_LABEL=开; else PANEL_AUTH_LABEL=关; fi
echo "代理: $PROXY  (面板鉴权: $PANEL_AUTH_LABEL)"
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

# §8.54 慢网(VPN):静态资源与大块 JSON 要能压,SSE 绝不能压(vary 也要报对)
enc=$(curl -s -D - -o /dev/null -H 'Accept-Encoding: br' "${AUTH[@]}" "$PROXY/app.js" \
  | tr -d '\r' | awk 'tolower($1)=="content-encoding:"{print $2}')
br_size=$(curl -s -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: br' "${AUTH[@]}" "$PROXY/app.js")
raw_size=$(curl -s -o /dev/null -w '%{size_download}' "${AUTH[@]}" "$PROXY/app.js")
if [ "$enc" = "br" ] && [ "${br_size:-0}" -gt 0 ] && [ "${br_size:-0}" -lt "${raw_size:-0}" ]; then
  echo "PASS: 静态资源支持 brotli(${raw_size}B → ${br_size}B)"; pass=$((pass + 1))
else
  echo "FAIL: 静态资源没有按 Accept-Encoding: br 压缩(got enc='$enc' ${raw_size}B → ${br_size}B)"; fail=$((fail + 1))
fi

enc=$(curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' "${AUTH[@]}" "$PROXY/api/session?limit=5" \
  | tr -d '\r' | awk 'tolower($1)=="content-encoding:"{print $2}')
gz_size=$(curl -s -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: gzip' "${AUTH[@]}" "$PROXY/api/session?limit=5")
raw_size=$(curl -s -o /dev/null -w '%{size_download}' "${AUTH[@]}" "$PROXY/api/session?limit=5")
if [ "$enc" = "gzip" ] && [ "${gz_size:-0}" -gt 0 ] && [ "${gz_size:-0}" -lt "${raw_size:-0}" ]; then
  echo "PASS: 会话列表 JSON 支持 gzip(${raw_size}B → ${gz_size}B)"; pass=$((pass + 1))
else
  echo "FAIL: 会话列表 JSON 没有压缩(got enc='$enc' ${raw_size}B → ${gz_size}B)"; fail=$((fail + 1))
fi

if [ -n "$SID" ]; then
  enc=$(curl -s -D - -o /dev/null -H 'Accept-Encoding: br' "${AUTH[@]}" "$PROXY/api/session/$SID/message?limit=50&order=desc" \
    | tr -d '\r' | awk 'tolower($1)=="content-encoding:"{print $2}')
  br_size=$(curl -s -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: br' "${AUTH[@]}" "$PROXY/api/session/$SID/message?limit=50&order=desc")
  raw_size=$(curl -s -o /dev/null -w '%{size_download}' "${AUTH[@]}" "$PROXY/api/session/$SID/message?limit=50&order=desc")
  if [ "$enc" = "br" ] && [ "${br_size:-0}" -gt 0 ] && [ "${br_size:-0}" -lt "${raw_size:-0}" ]; then
    echo "PASS: 消息列表支持 brotli(${raw_size}B → ${br_size}B)"; pass=$((pass + 1))
  else
    echo "FAIL: 消息列表没有压缩(got enc='$enc' ${raw_size}B → ${br_size}B)"; fail=$((fail + 1))
  fi
else
  echo "SKIP: 没有会话,跳过消息列表压缩断言"; pass=$((pass + 1))
fi

enc=$(timeout 2 curl -s -D - -o /dev/null -H 'Accept-Encoding: br' "${AUTH[@]}" "$PROXY/api/event" \
  | tr -d '\r' | awk 'tolower($1)=="content-encoding:"{print $2}')
if [ -z "$enc" ]; then
  echo "PASS: SSE 事件流不压缩(压了就拿不到逐帧)"; pass=$((pass + 1))
else
  echo "FAIL: SSE 被压成了 '$enc'"; fail=$((fail + 1))
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
# §8.49 行内高亮:比整行底色深一档的那层必须存在(否则点亮了也看不出来)
if has "$CSS" '--hl-add-bg' && has "$CSS" '--hl-del-bg' &&
   has "$CSS" '.dl.add .hl' && has "$CSS" '.dl.del .hl'; then
  echo "PASS: styles.css 有行内高亮(§8.49 的 --hl-add-bg/--hl-del-bg 与 .dl.add .hl)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺行内高亮配色(§8.49 点亮了也看不出来)"; fail=$((fail + 1))
fi
# §8.50 语法着色:四档颜色与 .tk 类必须都在
if has "$CSS" '--syn-kw' && has "$CSS" '--syn-str' && has "$CSS" '--syn-num' && has "$CSS" '--syn-com' &&
   has "$CSS" '.src .tk.kw'; then
  echo "PASS: styles.css 有语法着色(§8.50 的 --syn-* 与 .src .tk.*)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺语法着色(§8.50 的 .tk 上不了色)"; fail=$((fail + 1))
fi
# §8.52 并排视图:两栏骨架 + 桌面才有的切换按钮(窄屏必须收掉)
if has "$CSS" '.dl.pair' && has "$CSS" 'grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)' &&
   has "$CSS" 'html.narrow .dswap { display: none; }'; then
  echo "PASS: styles.css 有并排视图(§8.52 的 .dl.pair 两栏 + 窄屏收掉 .dswap)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺并排视图骨架,或窄屏没把切换按钮收掉"; fail=$((fail + 1))
fi
# §8.53 分栏里的长行折行(照 TUI 的 wrapMode="char"),不能再给每侧横向滚
if has "$CSS" 'white-space: pre-wrap' && has "$CSS" 'overflow-wrap: anywhere' &&
   has "$CSS" '.diff.split .dl { white-space: pre-wrap; overflow-wrap: anywhere; }' &&
   ! has "$CSS" '.dl.pair > .side { display: flex; min-width: 0; overflow-x: auto'; then
  echo "PASS: styles.css 分栏长行按字符折行(§8.53 的 pre-wrap / anywhere,无逐侧横向滚)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 分栏仍靠横向滚(§8.53 要照 TUI 折行)"; fail=$((fail + 1))
fi
# §8.58 统一视图也折行:全局 .dl 就是 pre-wrap/anywhere,不能再写 white-space: pre
if has "$CSS" '.dl { display: flex; align-items: stretch; white-space: pre-wrap; overflow-wrap: anywhere; }' &&
   has "$CSS" '.dl .src { min-width: 0; }' &&
   ! has "$CSS" '.dl { display: flex; align-items: stretch; white-space: pre; }'; then
  echo "PASS: styles.css 统一视图的长行也按字符折行(§8.58,不再是 white-space: pre)"; pass=$((pass + 1))
else
  echo "FAIL: 统一视图仍不折行(§8.58 要给 .dl 加 pre-wrap / anywhere,并给 .src 留 min-width: 0)"; fail=$((fail + 1))
fi
SMOKE_TOOLS="$(dirname "$0")/ui-tools.html"
if [ -f "$SMOKE_TOOLS" ] && has "$(cat "$SMOKE_TOOLS")" '折行:统一视图的长行按字符折行' &&
   has "$(cat "$SMOKE_TOOLS")" '折行:源码列不把容器撑宽' &&
   has "$(cat "$SMOKE_TOOLS")" '折行:行号仍在第一行'; then
  echo "PASS: ui-tools.html 有统一视图折行的浏览器断言(折行 / 不撑宽 / 行号留在第一行)"; pass=$((pass + 1))
else
  echo "FAIL: ui-tools.html 缺统一视图折行的断言"; fail=$((fail + 1))
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

# 前端逻辑:折叠记忆只认 sessionStorage —— 刷新(F5)保持收起,新开标签页则是展开的(§8.38)。
# 老键 localStorage['ocs.listHidden'] 谁也不许再读写(§8.13 那次「打开网页就是收起的」就是它)
APPJS=$(curl -s "${AUTH[@]}" "$PROXY/app.js")
# §8.49 行内高亮:配对 + 按字符 LCS 的两个纯函数必须在,而且 diff 渲染要走配对
if has "$APPJS" 'function hlRanges(' && has "$APPJS" 'function pairDiffRows(' &&
   has "$APPJS" 'pairDiffRows(parsePatch(' && has "$APPJS" 'HL_MAX_PAIRS'; then
  echo "PASS: app.js 有行内高亮(§8.49:hlRanges / pairDiffRows 接到 diff 渲染上)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺行内高亮(§8.49 的配对与 LCS 没接上)"; fail=$((fail + 1))
fi
# §8.50 语法着色:逐行分词要接在 diff 与 write 正文两条路上
if has "$APPJS" 'function syntaxSpans(' && has "$APPJS" 'function langOf(' &&
   has "$APPJS" 'const lang = langOf(f && f.file);' &&
   has "$APPJS" 'diffRowHtml(r, lang)' &&
   has "$APPJS" 'codeHtml(input.content, path)'; then
  echo "PASS: app.js 有语法着色(§8.50:syntaxSpans 同时接在 diff 与 write 正文上)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺语法着色(§8.50 的 langOf/syntaxSpans 没接上)"; fail=$((fail + 1))
fi
# §8.52 并排视图:配对渲染、点击 delegate、init 里真的接上了
if has "$APPJS" 'function splitRowsHtml(' && has "$APPJS" 'function setupDiffView(' &&
   has "$APPJS" 'diffHtml(files, { pid: p.id })' && has "$APPJS" 'setupDiffView(); // diff 卡片'; then
  echo "PASS: app.js 有并排视图(§8.52:配对渲染 + 卡片上的切换 + init 接线)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 缺并排视图(§8.52 的 splitRowsHtml / setupDiffView 没接上)"; fail=$((fail + 1))
fi
# §8.53 并排偏好照 TUI:全局 + 持久 + auto(够宽才并排)+ 只有 modified 分栏
if has "$APPJS" "const DIFF_VIEW_KEY = 'ocs.diffView';" &&
   has "$APPJS" 'DIFF_SPLIT_MIN_PX = 760' &&
   has "$APPJS" 'function diffViewWanted(' &&
   has "$APPJS" 'diffViewWanted(status, pref, wide)' &&
   has "$APPJS" 'localStorage.setItem(DIFF_VIEW_KEY, next)' &&
   has "$APPJS" 'diffViewSet(splitNow ? ' &&
   has "$APPJS" 'function syncDiffWidth(' && has "$APPJS" 'new ResizeObserver(' &&
   ! has "$APPJS" 'const diffViews = new Map()'; then
  echo "PASS: app.js 的并排偏好是全局持久偏好(§8.53/§8.60:diffViewWanted / localStorage 缓存 / 没有按卡片的 diffViews)"; pass=$((pass + 1))
else
  echo "FAIL: app.js 并排偏好还是按卡片的临时状态(§8.53 要照 TUI 的 diffs.view)"; fail=$((fail + 1))
fi
if has "$APPJS" "const LIST_KEY = 'ocs.listHiddenTab';" && has "$APPJS" 'function listCollapsed()' &&
   has "$APPJS" 'paint(listCollapsed());' && has "$APPJS" 'sessionStorage.getItem(LIST_KEY)' &&
   has "$APPJS" "sessionStorage.setItem(LIST_KEY, '1')" && has "$APPJS" 'sessionStorage.removeItem(LIST_KEY)' &&
   ! has "$APPJS" "localStorage.getItem('ocs.listHidden')" &&
   ! has "$APPJS" "localStorage.setItem('ocs.listHidden')"; then
  echo "PASS: 折叠记忆记在 sessionStorage(刷新同一标签页保持 / 新标签页展开),localStorage 里那个老键谁也不碰"; pass=$((pass + 1))
else
  echo "FAIL: 折叠记忆没接在 sessionStorage 上,或又去碰 localStorage 里的老 ocs.listHidden"; fail=$((fail + 1))
fi
if has "$APPJS" "return sessionStorage.getItem(LIST_KEY) === '1';" &&
   has "$APPJS" 'return false; // 存储被禁(隐私模式)时当作没记过' &&
   has "$(cat "$(dirname "$0")/ui-layout.html")" '刷新同一个标签页' &&
   has "$(cat "$(dirname "$0")/ui-layout.html")" '新开一个标签页'; then
  echo "PASS: 「没记过 = 展开」(存储被禁也只当没记过),ui-layout 里正反两面都锁着"; pass=$((pass + 1))
else
  echo "FAIL: 默认档不是展开,或隐私模式会炸,或 ui-layout.html 里没有这两面断言"; fail=$((fail + 1))
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
# 对齐 TUI 的 mentionTriggerIndex:@ 只认行首/空白后,不做字符黑名单
if has "$APPJS" 'mentionAtTokenStart' && has "$APPJS" 'before.lastIndexOf'; then
  echo "PASS: @ 补全按 TUI 的 token 边界触发(行首/空白后)"; pass=$((pass + 1))
else
  echo "FAIL: @ 补全没有按 TUI 的 token 边界触发"; fail=$((fail + 1))
fi
# 大会话标签切换:模型表已缓存时不再补一次整表重绘
if has "$APPJS" 'needModelPaint' && has "$APPJS" 'if (needModelPaint) renderMessages'; then
  echo "PASS: 模型表已缓存时不再重复重绘消息"; pass=$((pass + 1))
else
  echo "FAIL: renderControls 缺少条件重绘"; fail=$((fail + 1))
fi
# 串口/长命令的大输出复用 §8.83 的懒壳
if has "$APPJS" 'toolOutputText' && has "$APPJS" "if (kind === 'shell') return toolOutputText"; then
  echo "PASS: shell 大输出接入工具卡懒渲染"; pass=$((pass + 1))
else
  echo "FAIL: shell 大输出没有接入工具卡懒渲染"; fail=$((fail + 1))
fi
# 空闲会话缓存:摘要没更新、也不在运行时,切回不再整页重拉
if has "$APPJS" 'cached.updated' && has "$APPJS" 'sessionUpdated <= cached.updated'; then
  echo "PASS: 空闲会话切回时按摘要跳过整页对账"; pass=$((pass + 1))
else
  echo "FAIL: 缺少空闲会话的缓存摘要比较"; fail=$((fail + 1))
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
# 自动补全不把绝对路径当命令(照 TUI 的 W4):查询词里再有 / 时只放行已注册命令的前缀,
# 否则收起面板;Ctrl+P 的显式打开不受影响。
if has "$APPJS" "tok.query.includes('/')" && has "$APPJS" 'c.name.toLowerCase().startsWith(q)' &&
   has "$APPJS" 'return closeCommands();'; then
  echo "PASS: 绝对路径不自动弹命令面板(已注册的嵌套命令仍可补全)"; pass=$((pass + 1))
else
  echo "FAIL: 绝对路径会被误当命令查询"; fail=$((fail + 1))
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
        'archive', 'tui', 'copy', 'copyid', 'sessions', 'models', 'agents', 'clear', 'help']
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
# Ctrl+C = TUI 的 prompt.clear,但只在输入框聚焦、有内容、且没有选中文本时接管;
# 有选区或 Meta+C(Mac 复制)时让浏览器照常复制,不能把网页复制弄坏。
if has "$APPJS" "e.ctrlKey && !e.metaKey" && has "$APPJS" "inp.selectionStart === inp.selectionEnd" &&
   has "$APPJS" "clearInput();"; then
  echo "PASS: Ctrl+C 清空输入(有选区 / Meta+C 仍走浏览器复制)"; pass=$((pass + 1))
else
  echo "FAIL: Ctrl+C 清空输入缺失,或没避开复制"; fail=$((fail + 1))
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
if has "$APPJS" '<details class="compact" data-def="1" open><summary>摘要</summary>'; then
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
if has "$TOOLHEAD_FN" 's.label ?'; then
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
SPIN_CSS=$(printf '%s' "$CSS" | awk '/^\.tool \.tmark\.spin, \.toolrow \.tmark\.spin, \.explore > summary \.tmark\.spin \{/{f=1} f{print} f&&/^\}$/{exit}')
if has "$SPIN_CSS" 'min-width: 1em'; then
  echo "PASS: spinner 定宽占位(逐帧换字不抖行)"; pass=$((pass + 1))
else
  echo "FAIL: .tmark.spin 没定宽"; fail=$((fail + 1))
fi

# ---- N3 组:工具行的标题照 TUI 的每个工具组件 ----
# TUI(packages/tui/src/routes/session/index.tsx)里每类工具有自己的组件:Read / Glob /
# Grep / WebFetch / WebSearch / Write / Edit / ApplyPatch / Shell / Subagent / Question /
# Skill,其余落进 GenericTool。那一行统一是「行首图标 + 一段文案」,图标表在 TOOL_ICONS,
# 别名与 packages/tui/src/util/tool-display.ts 的 canonicalToolName 一致。
if has "$APPJS" "const TOOL_ALIAS = { bash: 'shell', task: 'subagent', apply_patch: 'patch' }"; then
  echo "PASS: 工具别名与 TUI 的 canonicalToolName 一致"; pass=$((pass + 1))
else
  echo "FAIL: TOOL_ALIAS 跟 TUI 对不上"; fail=$((fail + 1))
fi
TOOLICONS_DECL=$(printf '%s' "$APPJS" | awk '/^const TOOL_ICONS = \{/{f=1} f{print} f&&/^\};$/{exit}')
if has "$TOOLICONS_DECL" "read: '→', list: '→'" && has "$TOOLICONS_DECL" "write: '←', edit: '←', patch: '←'" &&
   has "$TOOLICONS_DECL" "glob: '✱', grep: '✱'" && has "$TOOLICONS_DECL" "webfetch: '%'" &&
   has "$TOOLICONS_DECL" "websearch: '◈'" && has "$TOOLICONS_DECL" "shell: '\$'"; then
  echo "PASS: 每个工具的图标照 TUI(→ ← ✱ % ◈ \$)"; pass=$((pass + 1))
else
  echo "FAIL: TOOL_ICONS 跟 TUI 的图标表对不上"; fail=$((fail + 1))
fi
TOOLLINE_FN=$(printf '%s' "$APPJS" | awk '/^function toolLine\(/{f=1} f{print} f&&/^\}$/{exit}')
if has "$TOOLLINE_FN" "'Read'" && has "$TOOLLINE_FN" "'Glob'" && has "$TOOLLINE_FN" "'Grep'" &&
   has "$TOOLLINE_FN" "'WebFetch'" && has "$TOOLLINE_FN" "'Web Search'" && has "$TOOLLINE_FN" "'Edit'" &&
   has "$TOOLLINE_FN" "'Skill'" && has "$TOOLLINE_FN" "'Asked '"; then
  echo "PASS: 标题行的工具词照 TUI 的组件名(Read / Glob / Grep / …)"; pass=$((pass + 1))
else
  echo "FAIL: toolLine 少认了某个工具"; fail=$((fail + 1))
fi
if has "$APPJS" "head: 'Wrote', tail: abbrevPath(path), icon: '#'" && has "$APPJS" "head: 'Questions', tail: '', icon: '#'"; then
  echo "PASS: write / question 的块标题照 TUI 的「# Wrote」「# Questions」"; pass=$((pass + 1))
else
  echo "FAIL: 块标题跟 TUI 对不上"; fail=$((fail + 1))
fi
if has "$APPJS" "added: { label: '# Created', cls: 'add' }" &&
   has "$APPJS" "deleted: { label: '# Deleted', cls: 'del' }" &&
   has "$APPJS" "modified: { label: '← Patched', cls: 'mod' }"; then
  echo "PASS: diff 文件头徽标照 TUI 的「# Created / # Deleted / ← Patched」"; pass=$((pass + 1))
else
  echo "FAIL: diff 徽标文案跟 TUI 对不上"; fail=$((fail + 1))
fi
if has "$APPJS" "Error [' + line + ':' + col + '] '"; then
  echo "PASS: 诊断行照 TUI 印「Error [行:列]」"; pass=$((pass + 1))
else
  echo "FAIL: 诊断行文案跟 TUI 对不上"; fail=$((fail + 1))
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
LIVETEXT_FN_O=$(printf '%s' "$APPJS" | awk '/^function paintLiveText\(/{f=1} f{print} f&&/^\}$/{exit}')
UPD_FN_O=$(printf '%s' "$APPJS" | awk '/^function updateJumpLatest\(/{f=1} f{print} f&&/^\}$/{exit}')
# 整表 renderMessages() 与增量重绘都汇到 updateJumpLatest() 里量一次;增量重绘
# (paintLiveDelta/paintCompactBody)只读 store.nearBottom —— 文档刚改完就去读
# scrollHeight 会把 7800 个节点整篇重排(实测脏树 23~29ms,干净 0.95ms),每个 token delta
# 都摊一次太贵。判据(atBottom + 只有用户往上滚才关掉)也只有这一处。
if has "$UPD_FN_O" 'atBottom(box)' && has "$DELTA_FN_O" 'store.nearBottom'; then
  echo "PASS: 自动跟随与按钮共用 atBottom()(增量重绘只读缓存,不再各写一个 80)"; pass=$((pass + 1))
else
  echo "FAIL: 自动跟随或按钮没走 atBottom()"; fail=$((fail + 1))
fi
# delta 按帧合并:事件入口只排队,真正绘制在 requestAnimationFrame 里;手动调用仍能同步收掉
if has "$APPJS" 'function scheduleLivePaint()' &&
   has "$APPJS" 'requestAnimationFrame(run)' &&
   has "$APPJS" 'else if (local) scheduleLivePaint();' &&
   has "$APPJS" 'function cancelScheduledLivePaint()' &&
   has "$DELTA_FN_O" 'cancelScheduledLivePaint()'; then
  echo "PASS: 流式 delta 按帧合并,整表重绘/手动绘制会收掉排队帧"; pass=$((pass + 1))
else
  echo "FAIL: 流式 delta 还没按帧合并,或排队帧没有收口"; fail=$((fail + 1))
fi
# 光标原地追加,别为了放光标把整段 Markdown HTML 再解析/序列化一遍
if has "$LIVETEXT_FN_O" 'appendCursor(node)' && ! has "$LIVETEXT_FN_O" 'cursorInto(body)'; then
  echo "PASS: 增量光标原地追加(不再二次解析整段 HTML)"; pass=$((pass + 1))
else
  echo "FAIL: 增量光标还在走 cursorInto() 的二次解析"; fail=$((fail + 1))
fi
# 「贴不贴底」= 用户意图,不是一次几何读数:容器变矮(状态条 / 底板展开 / #asks / 软键盘)
# 与内容变长都会把「离底还有多远」撑大,直接采信那一次读数就会把跟随关掉 —— 表现就是
# 「明明一直贴在底,忽然不跟了,动不动就要点一下跳到最新」。但上滑必须优先:80px 容差
# 内的小幅上滑也算让路,否则串口这类持续输出会一直把手机用户拽回最新。
if has "$UPD_FN_O" 'store.lastTop' && has "$UPD_FN_O" 'top < store.lastTop - 1' &&
   has "$UPD_FN_O" 'top > store.lastTop + 1' && has "$UPD_FN_O" 'atBottom(box)'; then
  echo "PASS: 上滑优先(scrollTop 一变回就关),只有下滚回底才恢复跟随"; pass=$((pass + 1))
else
  echo "FAIL: 跟随仍可能被 80px 容差或一次几何读数重新打开"; fail=$((fail + 1))
fi
# 手机手指向下 = 内容往上翻。touchmove 必须在 scroll 事件之前把跟随关掉,否则串口这类
# 持续输出会在一次拖动中间就增量重绘 / ResizeObserver,用户刚滑上去就被拉回最新。
if has "$APPJS" 'touchmove' && has "$APPJS" 'touchBaseY + 2' &&
   has "$APPJS" 'updateJumpLatest(false);'; then
  echo "PASS: 手机手指下滑(内容上翻)在 touchmove 里先停止跟随,不等 scroll 事件"; pass=$((pass + 1))
else
  echo "FAIL: 手机下拖仍可能在 scroll 事件前被串口输出抢先贴底"; fail=$((fail + 1))
fi
if has "$APPJS" 'function pinBottom(box)' && has "$APPJS" 'store.lastTop = box.scrollTop;'; then
  echo "PASS: 「贴底」只有 pinBottom() 一个实现(顺带记下这次看到的 scrollTop)"; pass=$((pass + 1))
else
  echo "FAIL: 贴底动作散在多处,lastTop 会跟着漂"; fail=$((fail + 1))
fi
if has "$APPJS" 'new ResizeObserver(' && has "$APPJS" 'if (store.nearBottom) pinBottom(box);'; then
  echo "PASS: 容器变矮(状态条/底板展开/#asks/软键盘)当场重新贴底,不等下一次渲染"; pass=$((pass + 1))
else
  echo "FAIL: 容器变矮后要等下一次渲染才贴回去(没消息再来就永远差一截)"; fail=$((fail + 1))
fi
if has "$APPJS" 'const explicit = store.restoreScroll && store.restoreScroll.sid === id ? store.restoreScroll.anchor : null;' &&
   has "$APPJS" 'const rs = explicit || savedAnchor(id);' &&
   has "$APPJS" 'store.forceBottom = !rs;'; then
  echo "PASS: 进入任何会话都先找存档(刷新 / 列表 / 标签 / 前后退同一条路);没有存档才落到底部"; pass=$((pass + 1))
else
  echo "FAIL: 进入会话没有统一找滚动存档,或没有存档仍会被 pending 拦成「停在最上面」"; fail=$((fail + 1))
fi
if has "$RENDER_FN_O" 'updateJumpLatest(' && has "$DELTA_FN_O" 'updateJumpLatest('; then
  echo "PASS: 内容变长之后按钮的显隐会跟着重算"; pass=$((pass + 1))
else
  echo "FAIL: 渲染之后没重算按钮"; fail=$((fail + 1))
fi
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

# ---- Q 组:上下文用量 + 输入框下面的提示栏(TUI 的 prompt.footer) ----
# 用户报「网页版不显示 155.6K (78%)」,又要把它的位置挪到「跟 TUI 一样在对话框下面」——
# TUI 的 prompt.footer 就在输入框下面那一行,同一行还印着工程路径与 «ctrl+p commands»
# (源码:prompt.footer.status 里是 prompt.footer.location,右边是 usage 与 command palette 提示)。
# 面板照做:#promptFooter 挂在 #chatpane 末尾(#composer 【外面】)。§8.40 改掉了这里一条旧
# 判断:以前是「手机收起底板成细边,这一行照样露着(看一眼用量)」,用户上手后明确要
# 「收起后只留进度条」,于是收起时它跟着藏(#composer.collapsed ~ #promptFooter)。
# §8.42 再进一步:手机上【整条都不显示】—— 展开底板时它照样挂着那 30px。两条硬约束不变:
#   ① 只认最后一次【已完成】压缩之后的助手消息(压缩把上下文清空了,之前的数不算);
#   ② 全量 / 窄屏两档文案都印在 DOM 里,由 CSS 按 html.narrow 挑,不用 JS 判宽度。
COMPOSER_AT=$(printf '%s' "$HTML_FLAT" | grep -bo 'id="composer"' | head -1 | cut -d: -f1)
FOOT_AT=$(printf '%s' "$HTML_FLAT" | grep -bo 'id="promptFooter"' | head -1 | cut -d: -f1)
CTX_AT=$(printf '%s' "$HTML_FLAT" | grep -bo 'id="ctxInfo"' | head -1 | cut -d: -f1)
if [ -n "$COMPOSER_AT" ] && [ -n "$FOOT_AT" ] && [ -n "$CTX_AT" ] &&
   [ "$COMPOSER_AT" -lt "$FOOT_AT" ] && [ "$FOOT_AT" -lt "$CTX_AT" ]; then
  echo "PASS: 上下文用量落在输入框下面的提示栏里(#promptFooter 在 #composer 之后,照 TUI prompt.footer)"; pass=$((pass + 1))
else
  echo "FAIL: 提示栏位置不对(composer=$COMPOSER_AT foot=$FOOT_AT ctx=$CTX_AT)"; fail=$((fail + 1))
fi
# §8.40:收起成细边时提示栏跟着藏 —— 细边上只留运行中的进度条与 ■ 中断
if has "$CSS" '#composer.collapsed ~ #promptFooter { display: none; }'; then
  echo "PASS: 收起成细边时提示栏跟着藏(细边上只剩进度条 / ■ 中断,§8.40)"; pass=$((pass + 1))
else
  echo "FAIL: 提示栏没跟着底板一起收(手机收起后还挂着那 30px 信息行,§8.40)"; fail=$((fail + 1))
fi
# §8.42:手机上整条不显示 —— 用户「手机端,对话框下面还有:Build...等内容显示」,指的是
# 【展开】底板时同一行照样挂着那 30px(实测 393×894 展开态:30px @864-894)。
if has "$CSS" 'html.narrow #promptFooter { display: none; }'; then
  echo "PASS: 手机上输入框下面那一行整条不显示(桌面照旧、收起那条 §8.40 也在,§8.42)"; pass=$((pass + 1))
else
  echo "FAIL: 窄屏没收掉 #promptFooter(展开底板时还挂着那 30px,§8.42)"; fail=$((fail + 1))
fi
if has "$HOME_HTML" 'id="chatDir"' && has "$HOME_HTML" 'id="cmdHint"' &&
   has "$HOME_HTML" 'class="hFull">ctrl+p commands' && has "$HOME_HTML" 'class="hNarrow">/ 命令'; then
  echo "PASS: 同一行还有工程路径(#chatDir)与 «ctrl+p commands» 提示(#cmdHint,桌面/手机两档)"; pass=$((pass + 1))
else
  echo "FAIL: 提示栏缺 #chatDir / #cmdHint 或两档提示文案"; fail=$((fail + 1))
fi
# TUI 的提示栏在 ctrl+p commands 前面还有一个 agent.cycle 提示(键位就是 tab)
if has "$HOME_HTML" 'id="agentHint"' && has "$HOME_HTML" '>tab agents<' &&
   has "$CSS" 'html.narrow #agentHint { display: none; }' &&
   has "$APPJS" 'ahint.addEventListener' && has "$APPJS" "e.key === 'Tab' && !e.shiftKey"; then
  echo "PASS: 还有 «tab agents» 提示(照 TUI agent.cycle;面板里 tab 与 Shift+Tab 都切智能体,手机收起)"; pass=$((pass + 1))
else
  echo "FAIL: 提示栏缺 #agentHint(或没按 TUI 用 tab / 没接线 / 没在手机上收起)"; fail=$((fail + 1))
fi
# TUI 提示栏最左那格是 Ss 的「智能体 · 模型」——面板里它跟 #chatDir / #ctxInfo 同一条,
# 展开底板时印在最左(§8.21);收起成细边时整条一起收(§8.40)
if has "$HOME_HTML" 'id="chatAgent"' && has "$APPJS" 'function paintFooterAgent(' &&
   has "$APPJS" 'paintFooterAgent();' && has "$CSS" '#chatAgent {'; then
  echo "PASS: 提示栏最左有 «智能体 · 模型»(#chatAgent,照 TUI 的 Ss;展开态印在最左)"; pass=$((pass + 1))
else
  echo "FAIL: 提示栏缺 #chatAgent(或没接线)"; fail=$((fail + 1))
fi
# 照 TUI 的 showDetails(interrupt===0 || width>=80):上膛等第二下时窄屏把用量与提示收掉
if has "$CSS" 'html.narrow #promptFooter.armed #ctxInfo' &&
   has "$CSS" 'html.narrow #promptFooter.armed #cmdHint' &&
   has "$APPJS" "foot.classList.toggle('armed', interruptArmed)"; then
  echo "PASS: Esc 上膛后窄屏收起用量与快捷键提示(照 TUI showDetails;桌面照旧露着)"; pass=$((pass + 1))
else
  echo "FAIL: 缺 Esc 上膛时窄屏收起提示的规则(showDetails)"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow #cmdHint .hFull { display: none; }' &&
   has "$CSS" 'html.narrow #cmdHint .hNarrow { display: inline; }'; then
  echo "PASS: 手机那档提示由 CSS 换成 «/ 命令»(手机没有 Ctrl 键)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺提示栏窄屏切档规则"; fail=$((fail + 1))
fi
# 同一条里四格的顺序照 TUI 的 prompt.footer:路径 → 用量 → ⇧tab agents → ctrl+p commands
DIR_AT=$(printf '%s' "$HTML_FLAT" | grep -bo 'id="chatDir"' | head -1 | cut -d: -f1)
AGENT_AT=$(printf '%s' "$HTML_FLAT" | grep -bo 'id="agentHint"' | head -1 | cut -d: -f1)
HINT_AT=$(printf '%s' "$HTML_FLAT" | grep -bo 'id="cmdHint"' | head -1 | cut -d: -f1)
if [ -n "$DIR_AT" ] && [ -n "$AGENT_AT" ] && [ -n "$HINT_AT" ] &&
   [ "$DIR_AT" -lt "$CTX_AT" ] && [ "$CTX_AT" -lt "$AGENT_AT" ] && [ "$AGENT_AT" -lt "$HINT_AT" ]; then
  echo "PASS: 提示栏顺序是 路径 → 用量 → ⇧tab agents → ctrl+p commands(照 TUI)"; pass=$((pass + 1))
else
  echo "FAIL: 提示栏顺序不对(dir=$DIR_AT ctx=$CTX_AT agent=$AGENT_AT hint=$HINT_AT)"; fail=$((fail + 1))
fi
# TUI 提示栏在用量前面还会接「正在跑的子会话 / 正挂着的 shell」并在用量后面接费用(都用 · 连,>0 才印)
if has "$APPJS" 'fmtCost(s && s.cost)' && has "$APPJS" "[subStr, tokFull, costStr].filter(Boolean).join(' · ')" \
   && has "$APPJS" 'function subagentCount(' && has "$APPJS" 'function shellCount(' \
   && has "$APPJS" "store.subs.set(info.id, info.parentID)" && has "$APPJS" "store.shells.set(info.id, owner)"; then
  echo "PASS: 用量前面接 «N subagents · M shells»、后面接费用(TUI 的 subagents · shells · usage · cost)"; pass=$((pass + 1))
else
  echo "FAIL: 提示栏没接子会话/shell/费用,或没按 TUI 用 · 连"; fail=$((fail + 1))
fi
# TUI 的路径是「目录:分支」(`Co()`:先按 home 缩成 ~/...,再拼 location.vcs.info()?.branch.current)
if has "$APPJS" 'function cachedBranch(' && has "$APPJS" "'/api/vcs?'" &&
   has "$APPJS" 'branch.current' && has "$APPJS" "abbrevHome(dir) + (branch ? ':' + branch : '')"; then
  echo "PASS: 工程路径照 TUI 拼上 «:git 分支»(按目录缓存,回来自动补画)"; pass=$((pass + 1))
else
  echo "FAIL: 提示栏的路径没拼分支/没走 /api/vcs"; fail=$((fail + 1))
fi
# TUI 的 `cm(path, home)`:home 下面的路径缩成 ~/...;home 通过 /__health 告知浏览器
if has "$SERVERJS" 'home: os.homedir()' && has "$APPJS" 'function abbrevHome(' &&
   has "$APPJS" "dir.indexOf(home + '/') === 0" && has "$APPJS" "store.home = j.home;"; then
  echo "PASS: 工程路径照 TUI 按 home 缩成 ~/…(/__health 提供 home)"; pass=$((pass + 1))
else
  echo "FAIL: 缺少 home 缩写(server 的 /__health 或 abbrevHome)"; fail=$((fail + 1))
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
# §8.85:usage.updated 的 tokens 是【整个会话】的累计值,不能写进 live 消息 ——
# 否则思考阶段 contextUsage() 会拿累计值当当前上下文,越跑越大甚至超过 100%。
USAGE_STREAM=$(printf '%s' "$APPJS" | awk "/if \\(t === 'session.usage.updated'\\)/{f=1} f{print} f&&/^  }$/{exit}")
if has "$USAGE_STREAM" 'return false;' && ! has "$USAGE_STREAM" 'L.tokens' &&
   has "$APPJS" 'patch.tokens = d.tokens' && has "$APPJS" 'patch.cost = d.cost'; then
  echo "PASS: usage.updated 只并进会话累计值,不写 live 消息(§8.85)"; pass=$((pass + 1))
else
  echo "FAIL: usage.updated 仍可能把会话累计 tokens 写进 live 消息(§8.85)"; fail=$((fail + 1))
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
   [ "$CTX_CALLS" = 7 ]; then
  echo "PASS: paintContextUsage 七个调用点(updateChatStatus 两分支 + renderControls + 分支回来补画 + /__health 给 home 后补画 + 深链补拉会话后补画 + 移入工作树后补画),口径与渲染共用 currentMessages()"; pass=$((pass + 1))
else
  echo "FAIL: paintContextUsage 的接线不对(got $CTX_CALLS 个调用点)"; fail=$((fail + 1))
fi
if has "$(cat "$(dirname "$0")/ui-stream.html")" "#ctxInfo"; then
  echo "PASS: ui-stream.html 里有上下文用量的断言"; pass=$((pass + 1))
else
  echo "FAIL: ui-stream.html 里没有上下文用量的断言"; fail=$((fail + 1))
fi
# 深链/旧会话不在当前列表页时,单独补拉一次会话本身(工具栏与提示栏的工程路径要用它的 location)。
# 只认带 id 的对象,别把服务端给不存在会话返回的空数组当成会话。
if has "$APPJS" 'function refreshSessionInfo(' && has "$APPJS" 'if (!s) refreshSessionInfo(id);' &&
   has "$APPJS" 'Array.isArray(info)'; then
  echo "PASS: 列表页里没有的会话按需补拉一次(照 TUI:location 总是有的),并挡住空数组"; pass=$((pass + 1))
else
  echo "FAIL: 缺少深链会话的补拉 / 没挡住空数组响应"; fail=$((fail + 1))
fi
# 提示栏由 paintContextUsage 那一个同步点一起画(路径 + 整条显隐),点 «ctrl+p commands» 也开命令面板。
if has "$APPJS" 'function paintPromptFooter(show, dir, known)' && has "$APPJS" 'paintPromptFooter(!!sid, dir, !!s)' &&
   has "$APPJS" 'hint.addEventListener' && has "$APPJS" 'openCommands({ force: true })'; then
  echo "PASS: 提示栏随 paintContextUsage 一起画,点提示就是开命令面板"; pass=$((pass + 1))
else
  echo "FAIL: 提示栏的接线不对(缺 paintPromptFooter / #cmdHint 点击)"; fail=$((fail + 1))
fi
# §8.44:「会话信息还没到手」不许印成「(未指定工程目录)」—— 那格留空。
if has "$APPJS" "known === false ? '' : '(未指定工程目录)'"; then
  echo "PASS: 工程路径未知时留空,只有真拿到会话但没目录才印占位(§8.44)"; pass=$((pass + 1))
else
  echo "FAIL: paintPromptFooter 还把「还不知道」印成「(未指定工程目录)」"; fail=$((fail + 1))
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
# §8.83 工具卡正文懒渲染:只对大正文工具卡出 summary 壳,进入预加载范围后一帧补一张。
if has "$APPJS" 'const LAZY_TOOL_CARD_MIN' && has "$APPJS" 'const LAZY_TOOL_TOTAL_MIN' &&
   has "$APPJS" 'function lazyToolsWanted' && has "$APPJS" 'function toolBodyHtml' &&
   has "$APPJS" 'const lazyTools = lazyToolsWanted(msgs);' &&
   has "$APPJS" 'function lazyToolSupported()'; then
  echo "PASS: 工具正文懒渲染按总正文字节门槛启用,正文构建抽成同一段"; pass=$((pass + 1))
else
  echo "FAIL: 工具正文懒渲染的门槛或正文构建接线缺失"; fail=$((fail + 1))
fi
if has "$APPJS" 'data-lazy-tool="' && has "$APPJS" 'new IntersectionObserver(' &&
   has "$APPJS" "rootMargin: '300px 0px'" &&
   has "$APPJS" 'hydrateLazyTool(el)) break;' &&
   has "$APPJS" 'observeLazyToolCards();'; then
  echo "PASS: 懒壳进入预加载范围后逐帧补正文(一帧一张,不替换 details)"; pass=$((pass + 1))
else
  echo "FAIL: 懒壳的 observer / 逐帧补正文接线不对"; fail=$((fail + 1))
fi
if has "$APPJS" "typeof IntersectionObserver === 'function'" &&
   has "$APPJS" "typeof requestAnimationFrame === 'function'" &&
   has "$APPJS" 'function toolHtml(p, lazy)' &&
   has "$APPJS" 'if (lazy && lazyToolBodyCandidate(p))'; then
  echo "PASS: 无 IntersectionObserver/rAF 时退回完整渲染,直接 renderMessage 默认不懒"; pass=$((pass + 1))
else
  echo "FAIL: 懒渲染的降级或直接 renderMessage 默认语义不对"; fail=$((fail + 1))
fi
if has "$(cat "$(dirname "$0")/ui-tools.html")" '懒渲染:一帧最多补一张' &&
   has "$(cat "$(dirname "$0")/ui-tools.html")" '懒渲染:中段补正文不顶走滚动锚点' &&
   has "$(cat "$(dirname "$0")/ui-tools.html")" '懒渲染:直接 renderMessage 默认完整渲染'; then
  echo "PASS: ui-tools 锁逐帧补正文 / 滚动锚点 / 直接渲染默认完整"; pass=$((pass + 1))
else
  echo "FAIL: ui-tools 缺工具正文懒渲染的行为断言"; fail=$((fail + 1))
fi
# §8.84 断流后的收尾对账:请求超时 + 后台失败退避 + 运行→空闲补拉 + 延迟收尾 + SSE 看门狗。
if has "$APPJS" 'const MSG_FETCH_TIMEOUT_MS = 30000;' &&
   has "$APPJS" 'const MSG_FETCH_TIMEOUT_SLOW_MS = 120000;' &&
   has "$APPJS" 'function msgFetchTimeout()' &&
   has "$APPJS" 'const MSG_QUIET_RETRY_MS = [2000, 5000, 10000, 20000];' &&
   has "$APPJS" 'function scheduleQuietRetry()' &&
   has "$APPJS" 'if (retryable) scheduleQuietRetry();' &&
   has "$APPJS" 'e.status >= 400 && e.status < 500'; then
  echo "PASS: 消息请求超时 / 后台失败退避重试 / 4xx 不重试都在"; pass=$((pass + 1))
else
  echo "FAIL: 消息请求超时或后台失败重试不完整"; fail=$((fail + 1))
fi
if has "$APPJS" 'const justIdle = sel && wasRunning && !next.has(sel) && !compactionRunning(sel);' &&
   has "$APPJS" 'loadMessages({ older: false, auto: true, now: true });' &&
   has "$APPJS" '(msgStale && !isRunning(sel)' &&
   has "$(cat "$(dirname "$0")/ui-controls.html")" '运行→空闲:loadActive 立刻补拉一次消息(不等刷新)'; then
  echo "PASS: loadActive 把「运行→空闲」当成收工信号,立刻补拉并继续兜失败"; pass=$((pass + 1))
else
  echo "FAIL: loadActive 的运行→空闲收尾补拉缺失"; fail=$((fail + 1))
fi
# 面板自己发的消息会把 pending 置上;服务端不一定再给 idle 消息,收工事件与
# loadActive 兜底都必须清掉它并重算 running,否则进度条会一直转。
if has "$APPJS" 'function recomputeRunning(msgs)' &&
   has "$APPJS" 'function markTurnDone(sid, opts)' &&
   has "$APPJS" 'if (justIdle) markTurnDone(sel);' &&
   has "$APPJS" 'recomputeRunning(msgs);' &&
   has "$(cat "$(dirname "$0")/ui-controls.html")" '清掉 pending' &&
   has "$(cat "$(dirname "$0")/ui-controls.html")" '重算 running' &&
   has "$(cat "$(dirname "$0")/ui-stream.html")" '收工事件后进度条收起'; then
  echo "PASS: 收工事件与 loadActive 兜底都会清 pending、重算 running(进度条不再空转)"; pass=$((pass + 1))
else
  echo "FAIL: 收工后 pending / running 没有清干净,进度条会一直转"; fail=$((fail + 1))
fi
# §8.93 收工后流式缓冲先标收束:正文留着等权威版本,但不再算运行、不再显示流式中。
if has "$APPJS" 'function closeLiveFor(sid)' &&
   has "$APPJS" 'function openLiveForSid(sid)' &&
   has "$APPJS" 'provisional: !L.open' &&
   has "$APPJS" '!last.time.completed && !last.provisional && !closedLive' &&
   has "$APPJS" 'else if (closedLive) renderMessages();' &&
   has "$(cat "$(dirname "$0")/ui-stream.html")" '收束后不等权威消息就回到空闲' &&
   has "$(cat "$(dirname "$0")/ui-stream.html")" 'session.idle 关闭本地流式缓冲'; then
  echo "PASS: 收工后流式缓冲先标收束,不等权威消息就熄掉运行中与「流式中」"; pass=$((pass + 1))
else
  echo "FAIL: 收工后流式缓冲未收束,状态条可能一直转"; fail=$((fail + 1))
fi
if has "$APPJS" 'const MSG_SETTLE_MS = 1500;' &&
   has "$APPJS" 'function turnLooksUnsettled()' &&
   has "$APPJS" 'function settleReconcile(sid)' &&
   has "$APPJS" 'function scheduleSettle(sid)' &&
   has "$APPJS" "t === 'session.execution.succeeded' || t === 'session.execution.failed'" &&
   has "$(cat "$(dirname "$0")/ui-jump.html")" '最后是用户消息 → 收尾再补拉一次' &&
   has "$(cat "$(dirname "$0")/ui-stream.html")" 'session.idle 排一次 1.5s 的延迟收尾对账'; then
  echo "PASS: 收工事件后延迟收尾,只在画面还像没跑完时补拉"; pass=$((pass + 1))
else
  echo "FAIL: 延迟收尾对账的判定或接线缺失"; fail=$((fail + 1))
fi
if has "$APPJS" 'const SSE_STALE_MS = 45000;' &&
   has "$APPJS" 'const SSE_WATCH_MS = 15000;' &&
   has "$APPJS" 'function sseBusy()' &&
   has "$APPJS" 'function sseWatchdog()' &&
   has "$APPJS" 'function openEvents()' &&
   has "$APPJS" 'sseWatchTimer = setInterval(sseWatchdog, SSE_WATCH_MS);' &&
   has "$(cat "$(dirname "$0")/ui-controls.html")" '有活跃会话且 45s 没事件:关掉旧连接并重开'; then
  echo "PASS: SSE 半开时按最后事件时间主动重连(空闲不误判)"; pass=$((pass + 1))
else
  echo "FAIL: SSE 看门狗或浏览器断言缺失"; fail=$((fail + 1))
fi
if has "$(cat "$(dirname "$0")/ui-jump.html")" '后台对账连败三次后自动再排一次' &&
   has "$(cat "$(dirname "$0")/ui-jump.html")" '4xx 不排自动重试' &&
   has "$(cat "$(dirname "$0")/ui-jump.html")" '请求悬挂会超时并按失败重试'; then
  echo "PASS: ui-jump 锁失败重试 / 4xx 分流 / 悬挂超时"; pass=$((pass + 1))
else
  echo "FAIL: ui-jump 缺断流重试的行为断言"; fail=$((fail + 1))
fi

# ---- R 组:探索类工具行的分组(照 TUI 的 exploration 分组) ----
# TUI 的 explorationTools 就是 read/glob/grep/webfetch/websearch 这五类
# (packages/tui/src/routes/session/grouping/session.ts);相邻的挂同一条路径的被并进一组,
# GroupContent(group-view.tsx)在 groupExploration()(默认开)时把整组折成一行:
# 「→ Explored: 2 reads, 1 search」,点一下才摊开。面板按同一套规矩做。
if has "$APPJS" "const EXPLORE_TOOLS = ['read', 'glob', 'grep', 'webfetch', 'websearch']"; then
  echo "PASS: 探索工具表照 TUI 的 explorationTools(五类)"; pass=$((pass + 1))
else
  echo "FAIL: EXPLORE_TOOLS 跟 TUI 的 explorationTools 对不上"; fail=$((fail + 1))
fi
if has "$APPJS" "k === 'grep' || k === 'glob' || k === 'websearch' ? 'search' : k === 'webfetch' ? 'fetch' : k" &&
   has "$APPJS" "name === 'search' || name === 'fetch' ? name + 'es' : name + 's'"; then
  echo "PASS: 分组计数照 TUI 的 label()(grep/glob/websearch 算 search,webfetch 算 fetch;复数加 es)"; pass=$((pass + 1))
else
  echo "FAIL: 分组的计数/复数跟 TUI 的 label() 对不上"; fail=$((fail + 1))
fi
if has "$APPJS" "const done = !parts.some(toolRunning)" && has "$APPJS" "done ? 'Explored' : 'Exploring'"; then
  echo "PASS: 跑着时是 Exploring、收工后是 Explored(照 TUI 的 InlineToolRow)"; pass=$((pass + 1))
else
  echo "FAIL: 探索组的 Explored/Exploring 文案不对"; fail=$((fail + 1))
fi
if has "$APPJS" '<details class="explore" data-def="0"><summary>'; then
  echo "PASS: 探索组默认折着(照 TUI),用户摊开的状态靠 data-def 留住"; pass=$((pass + 1))
else
  echo "FAIL: 探索组不是默认折叠"; fail=$((fail + 1))
fi
if has "$APPJS" 'const run = [p];' &&
   has "$APPJS" "content[i + 1].type === 'tool' && isExploreTool(content[i + 1])" &&
   has "$APPJS" 'html += exploreGroupHtml(run);'; then
  echo "PASS: 相邻的探索工具在 renderMessage() 里并成一组"; pass=$((pass + 1))
else
  echo "FAIL: renderMessage 里没把相邻的探索工具并成组"; fail=$((fail + 1))
fi
if has "$CSS" '.explore > summary' && has "$CSS" '.explore .gbody'; then
  echo "PASS: 探索组那一行与展开后的正文都有样式"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 缺 .explore 的样式"; fail=$((fail + 1))
fi

# ---- R2 组:思考块摘要(照 TUI 的 reasoningSummary + ReasoningHeader) ----
if has "$APPJS" 'const REASONING_TITLE_RE = /^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/'; then
  echo "PASS: 思考块的标题正则照 TUI 的 reasoningSummary(只认最前面那段加粗 + 空行)"; pass=$((pass + 1))
else
  echo "FAIL: 思考块没照 TUI 抓加粗标题"; fail=$((fail + 1))
fi
if has "$APPJS" 'function reasoningGroupHtml(run, m, body)' && has "$APPJS" "(running ? 'Thinking' : 'Thought')" &&
   has "$APPJS" "run.length + ' steps" && has "$APPJS" 'function reasoningRunTitle(run)'; then
  echo "PASS: 思考行照 TUI 的 reasoning 分组行(Thinking / Thought + 标题 + N steps + 时长)"; pass=$((pass + 1))
else
  echo "FAIL: 思考行的文案/格子跟 TUI 对不上"; fail=$((fail + 1))
fi
if has "$APPJS" "while (i + 1 < content.length && content[i + 1].type === 'reasoning') run.push(content[++i]);"; then
  echo "PASS: 相邻的思考段并成一块(照 TUI 的 tree:相邻同 kind 进同一个组)"; pass=$((pass + 1))
else
  echo "FAIL: 相邻的思考段没有并起来"; fail=$((fail + 1))
fi
if has "$CSS" '.reasoning[open] > summary .rWord.rDone ~ .rTitle { display: none; }'; then
  echo "PASS: 摊开时把标题收起来(照 TUI:展开那款不印标题)"; pass=$((pass + 1))
else
  echo "FAIL: 思考块展开时标题没藏起来"; fail=$((fail + 1))
fi
if has "$APPJS" "if (ms < 60000) return (ms / 1000).toFixed(1) + 's'"; then
  echo "PASS: 时长格式照 TUI 的 Locale.duration"; pass=$((pass + 1))
else
  echo "FAIL: 时长格式跟 TUI 的 Locale.duration 对不上"; fail=$((fail + 1))
fi

# ---- R3 组:窄屏优化(提示栏第一格 / 会话操作那一行) ----
if has "$APPJS" 'el.innerHTML = agent' && has "$APPJS" 'class="agName"' && has "$APPJS" 'class="agModel"'; then
  echo "PASS: 提示栏第一格拆成 .agName / .agModel 两格"; pass=$((pass + 1))
else
  echo "FAIL: #chatAgent 没拆成两格"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow #chatAgent .agModel { display: none; }' &&
   has "$CSS" 'html.narrow #chatAgent { max-width: 40%; }'; then
  echo "PASS: 窄屏收掉模型·变体那格,把宽度让给工程路径"; pass=$((pass + 1))
else
  echo "FAIL: 窄屏没收 .agModel / 宽度上限没跟着改"; fail=$((fail + 1))
fi
if has "$CSS" '#chatOps { display: inline-flex' && has "$CSS" '#older { width: auto; margin: 8px 0 0;'; then
  echo "PASS: 桌面:#chatOps 是 inline-flex,「加载更旧消息」落在会话操作同一行"; pass=$((pass + 1))
else
  echo "FAIL: 「加载更旧消息」还是自己占一整行"; fail=$((fail + 1))
fi
# ---- §8.41(用户「手机端…显示太多东西没必要」):窄屏把那一整行收掉,翻旧改走「滚到顶自动拉」----
if has "$CSS" 'html.narrow #chatOps,' && has "$CSS" 'html.narrow #older { display: none; }'; then
  echo "PASS: 手机上「导出 / 在TUI打开 / 归档 / 加载更旧消息」那一整行收起(40px 还给消息区)"; pass=$((pass + 1))
else
  echo "FAIL: 窄屏下那一行没收(或只收了几个 chip、行还占着 40px)"; fail=$((fail + 1))
fi
if has "$APPJS" 'async function autoLoadOlder(box)' && has "$APPJS" 'const AUTO_OLDER_TOP = 120' &&
   has "$APPJS" 'function setupAutoOlder()' && has "$INIT_FN_O" 'setupAutoOlder()' &&
   has "$APPJS" "document.documentElement.classList.contains('narrow')" &&
   has "$APPJS" 'if (store.msgError) return' &&
   has "$APPJS" 'const at = scrollAnchor()' && has "$APPJS" 'applyScrollAnchor(at)' &&
   [ "$(printf '%s' "$APPJS" | grep -oF 'setupAutoOlder' | wc -l)" = 2 ]; then
  echo "PASS: 窄屏滚到顶自动拉更旧(那一行收掉后翻旧仍有一条路;窄屏判定源还是 html.narrow,失败过不自己重撞,拉完拿锚点把人放回原地)"; pass=$((pass + 1))
else
  echo "FAIL: 窄屏没有「滚到顶自动拉更旧」,那一行却收起来了 —— 手机上就翻不了旧消息了"; fail=$((fail + 1))
fi

# ---- §8.43(用户「123 做」):手机上再瘦三处 —— 顶栏整条、标题下面那行、用量那格搬家 ----
# ① 顶栏只在列表页有用(竖屏实测 111px = 屏高 12%),会话里整条收掉,回列表自己回来;
# ② 标题下面那行「更新 1 天前 · 8e9e6e25」是排障用的,手机上也收掉;
# ③ 用量那格(#ctxInfo)没丢 —— 由 syncCtxInfoHome() 搬进标题行末尾(同一个节点,不是副本)。
if has "$CSS" 'html.narrow.view-chat #topbar { display: none; }'; then
  echo "PASS: 手机上进了会话,顶栏整条收掉(回列表随 view-chat 摘掉自己回来,§8.43)"; pass=$((pass + 1))
else
  echo "FAIL: 会话里顶栏还占着那 111px(§8.43)"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow #chatMeta { display: none; }'; then
  echo "PASS: 手机上标题下面那行(更新 / 项目号)收掉(§8.43)"; pass=$((pass + 1))
else
  echo "FAIL: 手机上 #chatMeta 还占着那 17px(§8.43)"; fail=$((fail + 1))
fi
# §8.48(用户「改」):标题行那枚「空闲 / 运行中 / 重试中」徽章手机上收掉 ——
# 运行中看底部进度条(收起时细边上还有「■ 中断」)、重试看进度条的重试态,「空闲」是噪音。
if has "$CSS" 'html.narrow #chatState { display: none; }' && has "$HOME_HTML" 'id="chatState"'; then
  echo "PASS: 手机上标题行那枚状态徽章收掉(桌面照旧,§8.48)"; pass=$((pass + 1))
else
  echo "FAIL: 手机上 #chatState 还占着标题行的宽度(§8.48)"; fail=$((fail + 1))
fi
if has "$CSS" 'html.narrow .chline #ctxInfo' &&
   has "$APPJS" 'function syncCtxInfoHome()' &&
   has "$APPJS" "document.documentElement.classList.contains('narrow')" &&
   has "$APPJS" 'const home = narrow ? line : foot' && has "$APPJS" 'if (ctx.parentElement === home) return' &&
   has "$APPJS" 'if (narrow) line.appendChild(ctx);' &&
   has "$APPJS" 'syncCtxInfoHome(); // §8.43:用量那格的家跟着窄屏走' &&
   has "$APPJS" 'syncCtxInfoHome(); // §8.43:深链直接进会话时也把用量那格摆对家' &&
   [ "$(printf '%s' "$APPJS" | grep -oF 'syncCtxInfoHome' | wc -l)" = 3 ]; then
  echo "PASS: 用量那格跟着窄屏搬家(同一个节点、没有副本;窄屏判定源仍是 html.narrow,§8.43)"; pass=$((pass + 1))
else
  echo "FAIL: 用量那格没跟着窄屏搬家(或另造了个副本,§8.43)"; fail=$((fail + 1))
fi

# ---- R4 组:助手消息脚注(照 TUI 的 AssistantFooter,§8.27)----
if has "$APPJS" 'function assistantFooterHtml(m, opts)' && has "$APPJS" 'class="afoot"' &&
   has "$APPJS" 'class="afAgent' && has "$APPJS" 'class="afModel"' &&
   has "$APPJS" 'class="afDur"' && has "$APPJS" 'class="afTps"'; then
  echo "PASS: 助手脚注照 TUI 印「智能体 · 模型 · 时长 · tok/s」"; pass=$((pass + 1))
else
  echo "FAIL: 助手脚注缺格"; fail=$((fail + 1))
fi
if has "$APPJS" 'function turnDuration(m, msgs, index)' && has "$APPJS" 'function turnTps(m, msgs, index)' &&
   has "$APPJS" 'out / (dur / 1000)'; then
  echo "PASS: 时长与 tok/s 照 TUI 的 turnDuration / turnTokensPerSecond(整轮加总)"; pass=$((pass + 1))
else
  echo "FAIL: 脚注的时长/速度算法跟 TUI 对不上"; fail=$((fail + 1))
fi
if has "$APPJS" 'Error: ' && has "$APPJS" 'Retrying in ' && has "$APPJS" 'attempt ' &&
   has "$APPJS" 'function isInterrupted(m)'; then
  echo "PASS: 出错 / 重试 / 中断三种情形都有(中断不算出错)"; pass=$((pass + 1))
else
  echo "FAIL: 脚注缺出错/重试/中断"; fail=$((fail + 1))
fi
if has "$APPJS" 'html += assistantFooterHtml(m, opts);' && ! has "$APPJS" 'opts.showModel'; then
  echo "PASS: 模型名从头部挪到脚注(头部不再印)"; pass=$((pass + 1))
else
  echo "FAIL: 模型名还在头部 / 脚注没接上"; fail=$((fail + 1))
fi
if has "$APPJS" 'function syncRetryTick()' && has "$APPJS" 'function drawRetryCountdown()'; then
  echo "PASS: 重试倒计时每秒重算(照 TUI 的 AssistantRetry)"; pass=$((pass + 1))
else
  echo "FAIL: 重试倒计时不会自己走"; fail=$((fail + 1))
fi
if has "$CSS" '.afoot { margin-top: 4px;' && has "$CSS" '.afErr {' && has "$CSS" '.afRetry {' &&
   has "$CSS" '.afAgent.muted {'; then
  echo "PASS: 脚注样式(智能体绿 + 出错灰 + Error/重试两行)"; pass=$((pass + 1))
else
  echo "FAIL: 脚注样式没写上"; fail=$((fail + 1))
fi

# ---- R5 组:「加载更旧消息」的游标(带游标时不能再带 order,§8.26 顺手修的)----
if has "$APPJS" "q.set('cursor', store.msgOlderCursor)" && has "$APPJS" "q.set('order', 'desc')"; then
  echo "PASS: 首屏带 order=desc、翻页只带游标"; pass=$((pass + 1))
else
  echo "FAIL: 分页的 query 没拆开"; fail=$((fail + 1))
fi
if ! has "$APPJS" "new URLSearchParams({ order: 'desc', limit: '100' })"; then
  echo "PASS: 不再出现「order 与游标一起发」的那种写法(服务端会 400)"; pass=$((pass + 1))
else
  echo "FAIL: 还是把 order 与游标一起发"; fail=$((fail + 1))
fi

# ---- R6 组:用户消息照 TUI(抬起底色块 + skill / file 徽标,§8.29)----
if has "$APPJS" '<span class="rBadge">skill</span>' && has "$APPJS" "mime === 'application/x-directory' ? 'dir' : 'file'"; then
  echo "PASS: skill 与 file / dir 徽标照 TUI 的 UserMessage"; pass=$((pass + 1))
else
  echo "FAIL: 用户消息的 skill/file 徽标不对"; fail=$((fail + 1))
fi
if has "$CSS" '.msg.user {' && has "$CSS" 'background: var(--panel);' && has "$CSS" '.rBadge {' && has "$CSS" '.rName {'; then
  echo "PASS: 用户消息那块底色抬起来、徽标两格有样式(照 TUI 的 raised)"; pass=$((pass + 1))
else
  echo "FAIL: 用户消息的底色块或徽标样式没写上"; fail=$((fail + 1))
fi
if has "$CSS" '.ref-skill { border-color: transparent; background: transparent; padding: 0; }'; then
  echo "PASS: skill 那颗外层不带边框(颜色由里面两格给,照 TUI)"; pass=$((pass + 1))
else
  echo "FAIL: skill 那颗还是自带黄底框"; fail=$((fail + 1))
fi

# ---- R7 组:Tokens 块(照 TUI 的 TurnTokenUsage,§8.30)----
if has "$APPJS" 'function tokenBlockHtml(seg)' && has "$APPJS" "' · latest: '" &&
   has "$APPJS" "' likely cache '" && has "$APPJS" 'function tokenTotal(t)'; then
  echo "PASS: Tokens 块照 TUI 印「N steps · latest: new · cached · total」+ 缓存失效提醒"; pass=$((pass + 1))
else
  echo "FAIL: Tokens 块的文案/格子跟 TUI 对不上"; fail=$((fail + 1))
fi
if has "$APPJS" 'function turnInfo(msgs)' && has "$APPJS" "if (m.type === 'idle') {" &&
   has "$APPJS" "if (legacy && terminal) flush();" && has "$APPJS" 'function cacheReuseDrop(prev, cur)'; then
  echo "PASS: 轮次边界照 TUI 的 flushTurn(idle 收 / 老会话终步收)+ cacheReuseDrop"; pass=$((pass + 1))
else
  echo "FAIL: 轮次边界或缓存失效的判据没照 TUI"; fail=$((fail + 1))
fi
if has "$CSS" '.tokblk {' && has "$CSS" '.tokWord {' && has "$CSS" '.toktab ' && has "$CSS" '.tokBust {'; then
  echo "PASS: Tokens 块的样式在(总览加粗、表、掉量那行琥珀)"; pass=$((pass + 1))
else
  echo "FAIL: Tokens 块的样式缺"; fail=$((fail + 1))
fi
if ! has "$APPJS" "'<div class=\"meta\">' + esc(fmtTokens(m.tokens)) + ' tokens'"; then
  echo "PASS: .meta 不再无条件重复一份 token 数(收工后归 Tokens 块)"; pass=$((pass + 1))
else
  echo "FAIL: .meta 还是自己印一份 tokens"; fail=$((fail + 1))
fi

# ---- R8 组:待发送队列收一条(照 TUI 的 QueuedPromptDock,§8.31)----
if has "$APPJS" "dock.className = 'ibdock'" && has "$APPJS" "' queued</span>'" &&
   has "$APPJS" "replace(/\s+/g, ' ').trim()"; then
  echo "PASS: 待发送队列收一条「N queued · 下一条」(换行压成空格,照 TUI)"; pass=$((pass + 1))
else
  echo "FAIL: 待发送队列的行头没照 TUI 收成一条"; fail=$((fail + 1))
fi
if has "$APPJS" 'const wasOpen = !!(box.querySelector(' && has "$APPJS" 'if (wasOpen) dock.open = true;'; then
  echo "PASS: 展开态跨重画留住(队列一动不折回去)"; pass=$((pass + 1))
else
  echo "FAIL: 整块重画会把展开态丢掉"; fail=$((fail + 1))
fi
if has "$CSS" '.ibdock > summary {' && has "$CSS" '.ibCount {' && has "$CSS" '.ibNext { flex: 1;'; then
  echo "PASS: dock 的样式在(计数加粗、正文省略号截断)"; pass=$((pass + 1))
else
  echo "FAIL: dock 的样式缺"; fail=$((fail + 1))
fi

# ---- R9 组:其它消息种类照 TUI(§8.32)----
if has "$APPJS" 'function switchLabel(model, previous)' && has "$APPJS" "'Switched variant to '" &&
   has "$APPJS" "Switched agent ' + (from ? " && has "$APPJS" "↳ Moved to "; then
  echo "PASS: 切换类三行照 TUI(model 走 switchLabel、agent 两头 titlecase、location 写 Moved to)"; pass=$((pass + 1))
else
  echo "FAIL: 切换类那三行没照 TUI"; fail=$((fail + 1))
fi
if has "$APPJS" 'function noticeRowHtml(m)' && has "$APPJS" ">◈</span>" &&
   has "$APPJS" "'completed' ? 'finished' : state === 'error' ? 'failed'" && has "$APPJS" "cSuffix\"> · ' + esc(text)"; then
  echo "PASS: 通知类照 TUI(subagent/shell 收工写 ↳ <Actor> finished · 描述,其余 ◈ <描述>)"; pass=$((pass + 1))
else
  echo "FAIL: 通知类没照 TUI"; fail=$((fail + 1))
fi
if has "$APPJS" 'function msgHidden(m)' && has "$APPJS" "if (m.type === 'idle') return true;" &&
   has "$APPJS" "if (m.type === 'synthetic' && !noticeText(m).trim()) return true;" &&
   has "$APPJS" 'if (!L && msgHidden(view)) continue;'; then
  echo "PASS: idle 与没描述的 synthetic 整条不出行(照 rows.ts:383)"; pass=$((pass + 1))
else
  echo "FAIL: 不出行的那两种还在建 DOM"; fail=$((fail + 1))
fi
if has "$CSS" '.completion { font-family: var(--mono); display: flex;' && has "$CSS" '.swPath {' &&
   has "$CSS" '.completion.err .cHead {' && has "$CSS" '.notice .tmark, .skillmsg .tmark { color: var(--muted); }'; then
  echo "PASS: 这些行的样式在(收工行一行不折、◈ 是 muted 不是工具行那枚琥珀)"; pass=$((pass + 1))
else
  echo "FAIL: 这些行的样式缺"; fail=$((fail + 1))
fi

# ---- R10 组:选择框的细节(照 TUI 的 DialogSelect,§8.33)----
if has "$APPJS" 'store.pickCurrent = opts.current;' && has "$APPJS" "'<span class=\"pi-cur\">'" &&
   has "$APPJS" "(cur ? ' current' : '')"; then
  echo "PASS: 「当前值」那一条钉一枚 ●(照 DialogSelectRow;高亮挪开也认得出)"; pass=$((pass + 1))
else
  echo "FAIL: 选择框没有「当前值」那枚 ●"; fail=$((fail + 1))
fi
if has "$APPJS" 'function paintPickFoot(opts)' && has "$APPJS" "'↑↓ 选择 · Enter 选中 · Esc 关闭'" &&
   has "$APPJS" "'点条目选中 · 关闭按钮收起'"; then
  echo "PASS: 选择框底部有动作 + 键位那行(桌面/手机两档,照 DialogFooter)"; pass=$((pass + 1))
else
  echo "FAIL: 选择框底部那行缺"; fail=$((fail + 1))
fi
if has "$APPJS" "'没有可选项'" && has "$APPJS" "'没有匹配项'"; then
  echo "PASS: 空态分「没有可选项」与「没有匹配项」两种(照 DialogSelect)"; pass=$((pass + 1))
else
  echo "FAIL: 空态没分两种"; fail=$((fail + 1))
fi
if has "$CSS" '.pick-item .pi-cur { flex: none;' && has "$CSS" '.dlgfoot {' &&
   has "$CSS" 'html.narrow .dlgfoot .hFull { display: none; }'; then
  echo "PASS: ● 与底部那行的样式在(窄屏换手机那档文案)"; pass=$((pass + 1))
else
  echo "FAIL: ● 或底部那行的样式缺"; fail=$((fail + 1))
fi

# ---- R11 组:拉消息失败不许一声不响(手机上一个 12MB 的会话首页会下几十秒甚至被掐断,§8.34)----
if has "$MSG_HTML" 'id="msgState"' && has "$MSG_HTML" 'class="msgstate"' &&
   has "$MSG_HTML" 'id="msgStateText"' && has "$MSG_HTML" 'id="msRetry"' &&
   has "$MSG_HTML" 'class="chip"'; then
  echo "PASS: 消息区末尾有一条状态行(#msgState + 文案 + 重试,跟着 #messages 一起被清空/搬回)"; pass=$((pass + 1))
else
  echo "FAIL: #messages 里没有那条状态行(#msgState/#msgStateText/#msRetry)"; fail=$((fail + 1))
fi
if has "$APPJS" 'function paintMsgState()' && has "$APPJS" 'function setupMsgState()' &&
   has "$INIT_FN_O" 'setupMsgState()' &&
   [ "$(printf '%s' "$APPJS" | grep -oF 'setupMsgState' | wc -l)" = 2 ]; then
  echo "PASS: setupMsgState() 接进了 init() 且只有这一处接线(定义 1 + init 1)"; pass=$((pass + 1))
else
  echo "FAIL: setupMsgState 的接线不对(应为 定义 1 次 + init 里 1 次)"; fail=$((fail + 1))
fi
if has "$APPJS" 'const MSG_TRIES = 3' && has "$APPJS" 'const MSG_RETRY_MS = [800, 2500]' &&
   has "$APPJS" 'await sleep(MSG_RETRY_MS[attempt - 1]'; then
  echo "PASS: 失败自动重试两轮(首发 + 2 次,退避 0.8s / 2.5s)"; pass=$((pass + 1))
else
  echo "FAIL: 失败没有自动重试(或退避不对)"; fail=$((fail + 1))
fi
if has "$APPJS" "'加载失败:'" && has "$APPJS" "'正在加载消息…'" &&
   has "$APPJS" "msgRetryBtn.addEventListener('click', () => loadMessages({ older: false }))"; then
  echo "PASS: 失败亮原因 + 一个「重试」;慢的时候先亮「正在加载消息…」"; pass=$((pass + 1))
else
  echo "FAIL: 失败/加载那两句话或重试按钮没接上"; fail=$((fail + 1))
fi

# ---- R11b 组:拉会话列表失败也不许只进控制台(§8.45)----
if has "$HOME_HTML" 'id="listState"' && has "$HOME_HTML" 'id="listStateText"' &&
   has "$HOME_HTML" 'id="lsRetry"' &&
   [ "$(printf '%s' "$HOME_HTML" | grep -oF 'id="listState"' | wc -l)" = 1 ]; then
  echo "PASS: 左栏有一条状态行(#listState + 文案 + 重试),全页只有这一份"; pass=$((pass + 1))
else
  echo "FAIL: 左栏没有 #listState/#listStateText/#lsRetry,或不止一份"; fail=$((fail + 1))
fi
if has "$APPJS" 'function paintListState()' && has "$APPJS" 'function setupListState()' &&
   has "$INIT_FN_O" 'setupListState()' &&
   [ "$(printf '%s' "$APPJS" | grep -oF 'setupListState' | wc -l)" = 2 ]; then
  echo "PASS: setupListState() 接进了 init() 且只有这一处接线(定义 1 + init 1)"; pass=$((pass + 1))
else
  echo "FAIL: setupListState 的接线不对(应为 定义 1 次 + init 里 1 次)"; fail=$((fail + 1))
fi
if has "$APPJS" 'store.listError = String((e && (e.message || e.status)) || e' &&
   has "$APPJS" "console.error('loadSessions', e)" &&
   has "$APPJS" "listRetryBtn.addEventListener('click', () => loadSessions({ reset: true }))" &&
   has "$APPJS" "'加载失败:' + store.listError" && has "$APPJS" "'正在加载会话…'"; then
  echo "PASS: 列表失败记原因(控制台那条照旧留着) + 「重试」从头拉一遍"; pass=$((pass + 1))
else
  echo "FAIL: 列表失败的记录/重试/两句文案缺了一块"; fail=$((fail + 1))
fi
if has "$APPJS" 'const LIST_LOADING_DELAY_MS = 250' &&
   [ "$(printf '%s' "$APPJS" | grep -oF 'setListLoading(' | wc -l)" = 3 ]; then
  echo "PASS: 「正在加载会话…」慢过 250ms 才露(本机不闪),进门/收尾各一次"; pass=$((pass + 1))
else
  echo "FAIL: 列表的加载提示延迟不对,或 setListLoading 没在 loadSessions 里配平"; fail=$((fail + 1))
fi
if has "$APPJS" 'Array.isArray(j.data)' && has "$APPJS" "throw new Error('响应里没有消息数组')" &&
   has "$APPJS" "'响应不是合法 JSON(可能只下到一半)'"; then
  echo "PASS: 「空数组」和「没拿到」分开:半个正文 / 没有 data 都算失败,不静默成空消息区"; pass=$((pass + 1))
else
  echo "FAIL: 半截响应还会被当成「这个会话没有消息」"; fail=$((fail + 1))
fi
if has "$APPJS" 'const MSG_LOADING_DELAY_MS = 250' &&
   has "$APPJS" 'store.msgSeq++; // 这一下就把在途的响应与重试作废' &&
   has "$APPJS" 'store.msgSeq++; // 在途的响应与重试就地作废'; then
  echo "PASS: 「正在加载」慢到 250ms 才露(快路径不闪);切会话/取消选中把在途响应与重试作废"; pass=$((pass + 1))
else
  echo "FAIL: 没做「延迟才露」或切走没作废在途请求"; fail=$((fail + 1))
fi
if has "$CSS" '.msgstate {' && has "$CSS" '.msgstate[hidden] { display: none; }' &&
   has "$CSS" '.msgstate.bad {'; then
  echo "PASS: 状态行样式在(而且是 flex,必须显式写 [hidden] 的 display:none)"; pass=$((pass + 1))
else
  echo "FAIL: .msgstate 的样式缺(或漏了 [hidden])"; fail=$((fail + 1))
fi
if has "$(cat "$(dirname "$0")/ui-jump.html")" "加载失败:" &&
   has "$(cat "$(dirname "$0")/ui-jump.html")" "正在加载消息…"; then
  echo "PASS: ui-jump.html 里有这组断言(重试次数 / 半截正文 / 切走作废都盯着)"; pass=$((pass + 1))
else
  echo "FAIL: ui-jump.html 里没有这组断言"; fail=$((fail + 1))
fi

# ---- R12 组:一页拉多少条(手机 30 / 桌面 100;实测慢链路也 30;§8.35 / §8.55)----
if has "$APPJS" 'const MSG_PAGE_NARROW = 30' && has "$APPJS" 'const MSG_PAGE_WIDE = 100' &&
   has "$APPJS" "document.documentElement.classList.contains('narrow') || slowLink()" &&
   has "$APPJS" 'new URLSearchParams({ limit: String(msgPageSize()) })'; then
  echo "PASS: 窄屏一页 30 条、桌面 100 条、实测慢链路也 30 条,首屏与翻页共用同一个口径(msgPageSize)"; pass=$((pass + 1))
else
  echo "FAIL: 一页多少条没按窄屏/慢链路分,或者分了两处口径"; fail=$((fail + 1))
fi
if has "$APPJS" 'const SLOW_SAMPLE_MS = 180' && has "$APPJS" 'function slowLink()' &&
   has "$APPJS" 'noteNetSample(dt)' && has "$APPJS" ' && !slowLink()) return;' &&
   has "$(cat "$(dirname "$0")/ui-jump.html")" '慢链路桌面:滚到顶' &&
   has "$(cat "$(dirname "$0")/ui-jump.html")" 'limit=30'; then
  echo "PASS: §8.55 慢链路判据接在首屏与滚顶翻旧上(ui-jump 有对应断言)"; pass=$((pass + 1))
else
  echo "FAIL: 慢链路没有接在首屏页大小 / 滚顶翻旧上"; fail=$((fail + 1))
fi
if has "$APPJS" 'function cacheCurrentMessages()' && has "$APPJS" 'const MSG_CACHE_MAX = 6' &&
   has "$APPJS" 'const MSG_CACHE_FRESH_MS = 1500' && has "$APPJS" 'store.msgCache.get(id)' &&
   has "$APPJS" 'if (cached) renderMessages()' &&
   has "$APPJS" 'loadMessages({ older: false, auto: !!cached, now: !!cached })' &&
   has "$APPJS" 'store.msgCache.delete(id)' &&
   has "$(cat "$(dirname "$0")/ui-layout.html")" '删掉的会话不再留在内存缓存里'; then
  echo "PASS: §8.55 切回看过的会话先用内存缓存顶上,再后台对账(上限 6、删除即清)"; pass=$((pass + 1))
else
  echo "FAIL: §8.55 的内存缓存 / 后台对账 / 删除清理缺了一块"; fail=$((fail + 1))
fi
if has "$APPJS" 'const MSG_AUTO_GAP_FAST_MS = 800' &&
   has "$APPJS" 'const MSG_AUTO_GAP_SLOW_MS = 4000' &&
   has "$APPJS" 'function msgAutoGap()' &&
   has "$APPJS" 'return slowLink() ? MSG_AUTO_GAP_SLOW_MS : MSG_AUTO_GAP_FAST_MS;' &&
   has "$APPJS" 'scheduleAutoMsg(msgAutoGap())' &&
   has "$(cat "$(dirname "$0")/ui-stream.html")" '慢链路(VPN / 3G)仍隔 4000ms'; then
  echo "PASS: 后台消息对账内网 800ms、慢链路仍 4000ms,落地后走同一个 msgAutoGap()"; pass=$((pass + 1))
else
  echo "FAIL: 后台对账间隔没有按快 / 慢链路分,或落地后没走 msgAutoGap()"; fail=$((fail + 1))
fi
if has "$(cat "$(dirname "$0")/ui-jump.html")" 'limit=30' &&
   has "$(cat "$(dirname "$0")/ui-jump.html")" 'MSG_PAGE_NARROW'; then
  echo "PASS: ui-jump.html 里有页大小的断言(桌面 100 / 窄屏 30 / 窄屏翻旧 30 / 转回宽屏 100)"; pass=$((pass + 1))
else
  echo "FAIL: ui-jump.html 里没有页大小的断言"; fail=$((fail + 1))
fi

# ---- R13 组:贴完底再跟几帧(cvmany 的离屏估值是贴完之后才落定的;§8.36 / §8.46)----
if has "$APPJS" 'function repinUntilStable(box)' && has "$APPJS" 'const REPIN_MAX_MS = 3000' &&
   has "$APPJS" 'const REPIN_STABLE_FRAMES = 2' && has "$APPJS" 'requestAnimationFrame(step)' &&
   has "$APPJS" "if (pinned && box.classList.contains('cvmany')) repinUntilStable(box)" &&
   [ "$(printf '%s' "$APPJS" | grep -oF 'repinSeq++' | wc -l)" = 3 ]; then
  echo "PASS: 贴完底再跟几帧:只在 cvmany 下、有自保上限,切会话/取消选中/再渲染三处都作废"; pass=$((pass + 1))
else
  echo "FAIL: 「贴完底再跟几帧」没接对(或缺作废点/自保上限)"; fail=$((fail + 1))
fi
if has "$APPJS" 'if (seq !== repinSeq || !store.nearBottom) return;' &&
   has "$APPJS" '} else if (++stable >= REPIN_STABLE_FRAMES) {' &&
   has "$(cat "$(dirname "$0")/ui-jump.html")" 'repinUntilStable' &&
   has "$(cat "$(dirname "$0")/ui-jump.html")" 'REPIN_STABLE_FRAMES'; then
  echo "PASS: 采样停下来有三条硬条件(又渲染了 / 用户往上滚了 / 高度稳住了),ui-jump 里有这组断言"; pass=$((pass + 1))
else
  echo "FAIL: 采样没有停手条件,或 ui-jump.html 里没有这组断言"; fail=$((fail + 1))
fi
# §8.46:「图迟一步撑开」不再跟时间赌 —— ResizeObserver 盯内容高度,只要还贴着底就补
if has "$APPJS" 'function syncRepinWatch()' && has "$APPJS" 'new ResizeObserver(' &&
   has "$APPJS" 'syncRepinWatch(); // §8.46' && has "$APPJS" 'function setupRepinWatch()' &&
   has "$INIT_FN_O" 'setupRepinWatch()' &&
   has "$APPJS" 'if (Date.now() - (store.gestureAt || 0) < REPIN_GESTURE_MS) return;'; then
  echo "PASS: 盯内容高度的是 ResizeObserver(每次渲染换观察名单),刚点过的不抢着贴"; pass=$((pass + 1))
else
  echo "FAIL: 盯内容高度那只眼没接上(或缺「刚点过不抢」那条)"; fail=$((fail + 1))
fi
if has "$(cat "$(dirname "$0")/ui-jump.html")" '图迟到撑开(采样早收手了)' &&
   has "$(cat "$(dirname "$0")/ui-jump.html")" '刚点过就不抢'; then
  echo "PASS: ui-jump 里有「迟到撑开也贴回」与「刚点过不抢」两组断言"; pass=$((pass + 1))
else
  echo "FAIL: ui-jump.html 里缺「迟到撑开」/「刚点过不抢」的断言"; fail=$((fail + 1))
fi

# ---- R14 组:消息列表里摘掉 data: 图(面板一个字节都不显示,却占 89% 的流量;§8.37)----
if has "$SERVERJS" 'function stripToolUris(json)' && has "$SERVERJS" 'function isMessageListUrl(url, method, status, contentType)' &&
   has "$SERVERJS" '/^\/api\/session\/[^/?]+\/message(\?|$)/'; then
  echo "PASS: 代理有「消息列表摘图」这对纯函数,URL 形状只认 /api/session/<id>/message"; pass=$((pass + 1))
else
  echo "FAIL: 代理缺 stripToolUris / isMessageListUrl,或 URL 正则不对"; fail=$((fail + 1))
fi
if has "$SERVERJS" "if (isMessageListUrl(req.url, req.method, upstream.status, outHeaders['content-type']))" &&
   has "$SERVERJS" 'if (stripToolUris(json)) out = Buffer.from(JSON.stringify(json));' &&
   has "$SERVERJS" 'out = raw; // 不是 JSON / 结构不认识:原样发' && has "$SERVERJS" 'outHeaders['"'"'content-length'"'"'] = String(out.length);'; then
  echo "PASS: 只有消息列表那一条走缓冲改写,解析失败一律原样发(代理不因为省流量弄坏面板)"; pass=$((pass + 1))
else
  echo "FAIL: 缓冲区改写的接线不对(缺 URL 判定 / 摘到才重排 / 出错退回 / content-length)"; fail=$((fail + 1))
fi
if has "$SERVERJS" "it.uri.startsWith('data:')" && has "$SERVERJS" 'it.omitted = it.uri.length;' && has "$SERVERJS" "it.uri = '';" &&
   has "$SERVERJS" 'nodeStream.pipe(res);' && has "$SERVERJS" 'stripToolUris,' && has "$SERVERJS" 'isMessageListUrl,'; then
  echo "PASS: 只摘 data: 开头的 uri(留 name/mime + 字节数),其余(含 SSE)仍是原样流式透传,纯函数已导出"; pass=$((pass + 1))
else
  echo "FAIL: 摘图范围没收在 data: 上,或 SSE 的流式透传被动了,或没导出给测试"; fail=$((fail + 1))
fi
if [ -f "$(dirname "$0")/strip-run.js" ] && has "$(cat "$(dirname "$0")/strip-run.js")" 'omitted' &&
   has "$(cat "$(dirname "$0")/strip-run.js")" 'data:image/png;base64,'; then
  echo "PASS: 摘图这套有专门的纯函数断言(test/strip-run.js)"; pass=$((pass + 1))
else
  echo "FAIL: 缺 test/strip-run.js(或它没断言 omitted / 真图)"; fail=$((fail + 1))
fi

# ---- R14b 组:SSE 里也摘掉同一批 data: 图(§8.47;面板在 session.tool.success 上只取 text)----
if has "$SERVERJS" 'function stripSseData(json)' && has "$SERVERJS" 'function stripSseLine(line)' &&
   has "$SERVERJS" 'function createSseStripper()' && has "$SERVERJS" 'function isEventStream(method, contentType)' &&
   has "$SERVERJS" "if (!json || json.type !== 'session.tool.success') return 0;"; then
  echo "PASS: 代理有「SSE 摘图」那几个纯函数,事件范围只认 session.tool.success"; pass=$((pass + 1))
else
  echo "FAIL: 缺 stripSseData / stripSseLine / createSseStripper / isEventStream,或范围没收在一个事件上"; fail=$((fail + 1))
fi
if has "$SERVERJS" "if (isEventStream(req.method, outHeaders['content-type']))" &&
   has "$SERVERJS" 'nodeStream.pipe(stripper).pipe(res);' &&
   has "$SERVERJS" 'return line; // 不是 JSON(或者只是半截):原样发' &&
   has "$SERVERJS" 'stripSseData,' && has "$SERVERJS" 'createSseStripper,'; then
  echo "PASS: 只有 SSE 那条走按行改写,解析失败一律原样发(代理不因为省流量把流弄坏)"; pass=$((pass + 1))
else
  echo "FAIL: SSE 改写的接线不对(缺内容类型判定 / 中间这条 Transform / 出错退回 / 导出)"; fail=$((fail + 1))
fi
if [ -f "$(dirname "$0")/sse-strip-run.js" ] && has "$(cat "$(dirname "$0")/sse-strip-run.js")" 'session.tool.success' &&
   has "$(cat "$(dirname "$0")/sse-strip-run.js")" '跨 chunk' &&
   has "$(cat "$(dirname "$0")/sse-strip-run.js")" '心跳'; then
  echo "PASS: SSE 摘图这套有专门的纯函数断言(test/sse-strip-run.js:跨 chunk / 心跳 / 坏 JSON)"; pass=$((pass + 1))
else
  echo "FAIL: 缺 test/sse-strip-run.js(或它没断言跨 chunk / 心跳帧)"; fail=$((fail + 1))
fi
if [ -f "$(dirname "$0")/sse-e2e-run.js" ] && has "$(cat "$(dirname "$0")/sse-e2e-run.js")" 'session.tool.success' &&
   has "$(cat "$(dirname "$0")/sse-e2e-run.js")" '真代理 + 假上游' &&
   has "$(cat "$(dirname "$0")/sse-e2e-run.js")" 'OPENCODE_CONFIG_DIR'; then
  echo "PASS: 另有一条端到端断言(真起代理 + 假上游:600KB 的图走一遍 SSE,别的帧一个字节不动)"; pass=$((pass + 1))
else
  echo "FAIL: 缺 test/sse-e2e-run.js(或它没真起代理 / 没隔离 service.json)"; fail=$((fail + 1))
fi

# ---- R15 组:选中的会话不在列表页里时,头部操作条与底板工具栏不许整条消失(§8.39)----
# 手机上这两处会「一起没」:两排的显示判据都写着「选中的会话在不在 store.sessions 里」,
# 而 store.sessions 只装当前筛选/分页那一页 —— 列表请求或深链补拉任何一条没回来,它们就永远
# 藏着,刷新之前回不来(细边上的「■ 中断」在 #ctoolbar 里,跟着一起没)。行为断言在
# ui-layout(含一条「辅助请求卡住时补拉照发」)、ui-controls、ui-capabilities 里,这里钉住判据本身。
if has "$APPJS" 'bar.hidden = !store.selected' && has "$APPJS" 'function blankControls()' &&
   has "$APPJS" 'renderChatOps(); // 「归档 / 取消归档」的文案要拿会话信息才准(§8.39)'; then
  echo "PASS: 这两排的判据只有「有没有选中会话」,会话信息没到手时选择器先空着,归档文案到了再校正"; pass=$((pass + 1))
else
  echo "FAIL: #chatOps/#ctoolbar 又按 store.sessions 判显隐,或缺 blankControls / renderChatOps 补画"; fail=$((fail + 1))
fi
CK_SEL=$(sed -n '/^async function selectSession/,/^}$/p' <<< "$APPJS")
CK_L1=$(awk '/if \(!s\) refreshSessionInfo\(id\);/{print NR}' <<< "$CK_SEL")
CK_L2=$(awk '/await Promise\.all\(\[/{print NR}' <<< "$CK_SEL")
if [ -n "${CK_L1:-}" ] && [ -n "${CK_L2:-}" ] && [ "$CK_L1" -lt "$CK_L2" ]; then
  echo "PASS: 会话信息的补拉排在 Promise.all 之前(那组里任何一条卡住都拖不住它)"; pass=$((pass + 1))
else
  echo "FAIL: refreshSessionInfo 又排回 Promise.all 后面了(got ${CK_L1:-?}/${CK_L2:-?})"; fail=$((fail + 1))
fi

# ---- R16 组:新建 worktree(§8.56;起名/生成/确认照 TUI 的 Name worktree)----
if has "$HOME_HTML" 'id="newWt"' && has "$HOME_HTML" 'id="newWtName"' &&
   has "$HOME_HTML" 'id="newWtGen"' && has "$HOME_HTML" 'id="newWtRow" hidden' &&
   has "$HOME_HTML" 'id="newWtHint" hidden' && has "$CSS" '.fldrow[hidden] { display: none; }' &&
   has "$CSS" 'html.narrow .chkfld { min-height: 44px; }'; then
  echo "PASS: + 新建里有可选的 worktree 开关,名字行与说明默认收着(不勾时桌面布局一字不动;手机命中区 44px)"; pass=$((pass + 1))
else
  echo "FAIL: + 新建里缺 worktree 开关 / 名字行 / 生成按钮,或它们默认就摊开了"; fail=$((fail + 1))
fi
if has "$APPJS" 'function wtSlugify(v)' && has "$APPJS" 'function wtSlug()' &&
   has "$APPJS" "const WT_ADJ = [" && has "$APPJS" "const WT_NOUN = [" &&
   has "$APPJS" ".replace(/[^a-z0-9]+/g, '-')" && has "$APPJS" ".replace(/^-+/, '')" &&
   has "$APPJS" ".replace(/-+$/, '')" &&
   has "$APPJS" 'if (on && name && !wtSlugify(name.value)) name.value = wtSlug();'; then
  echo "PASS: worktree 名字规则照 TUI(小写 / 非字母数字变 - / 掐头尾 / 留空随机 adjective-noun)"; pass=$((pass + 1))
else
  echo "FAIL: worktree 名字规则没照 TUI 的 slugify + Slug.create"; fail=$((fail + 1))
fi
if has "$APPJS" "'/api/location?' + new URLSearchParams({ 'location[directory]': src })" &&
   has "$APPJS" ".toString()" &&
   has "$APPJS" "const projectID = loc && loc.project && loc.project.id;" &&
   has "$APPJS" "const wt = await api('/api/worktree'" &&
   has "$APPJS" 'body: JSON.stringify({ projectID, name })' &&
   has "$APPJS" 'dir = wt.directory;' && has "$APPJS" "phase = 'worktree';"; then
  echo "PASS: 先按工程目录解析 projectID,再 POST /api/worktree,会话开在返回的目录"; pass=$((pass + 1))
else
  echo "FAIL: worktree 接口接线不对(缺 location 解析 / projectID / 返回目录 / 阶段)"; fail=$((fail + 1))
fi
if has "$APPJS" 'dataset.wtDir' && has "$APPJS" 'dataset.wtSrc' && has "$APPJS" 'dataset.wtName' &&
   has "$APPJS" 'const reuse = dlg && dlg.dataset.wtDir' && has "$APPJS" 'if (reuse)' &&
   has "$APPJS" 'delete dlg.dataset.wtDir;'; then
  echo "PASS: worktree 已建好但会话失败时,原地重试复用那棵目录(不重复建;关框/换名/换源目录即作废)"; pass=$((pass + 1))
else
  echo "FAIL: 缺「先建 worktree、后建会话」的重试凭据(失败会多建一棵)"; fail=$((fail + 1))
fi
if has "$APPJS" "phase === 'worktree' ? 'worktree ' : ''" &&
   has "$APPJS" "(j.data && j.data.message)" &&
   has "$APPJS" "if (\$('#newWt')) \$('#newWt').checked = false;" &&
   has "$APPJS" "\$('#newWt').addEventListener('change', paintNewWorktree)" &&
   has "$APPJS" "\$('#newWtGen').addEventListener('click'"; then
  echo "PASS: 失败会报「worktree 创建失败 + 服务端原话」,再开对话框不残留上次的勾选"; pass=$((pass + 1))
else
  echo "FAIL: worktree 失败文案 / data.message 解包 / 复选框复位 / 接线缺了一块"; fail=$((fail + 1))
fi

# ---- R17 组:变更总览 /diff(§8.57;照 TUI 的 diff viewer 的 Last turn 档)----
if has "$HOME_HTML" 'id="dlgDiff" class="dlg dlgdiff"' && has "$HOME_HTML" 'id="diffStat"' &&
   has "$HOME_HTML" 'id="diffBody"' && has "$HOME_HTML" 'id="diffErr" hidden' &&
   has "$HOME_HTML" 'id="diffReload"' &&
   has "$CSS" 'dialog.dlg.dlgdiff {' && has "$CSS" 'html.narrow .diffbody {' &&
   has "$CSS" 'font-size: var(--chat-fs);'; then
  echo "PASS: 变更总览有独立的框(标题/统计/正文/错误/刷新),正文用会话字号,窄屏整宽且自己滚"; pass=$((pass + 1))
else
  echo "FAIL: 变更总览的框缺节点 / 样式,或没有跟会话字号、窄屏规则"; fail=$((fail + 1))
fi
if has "$APPJS" 'function openDiff()' && has "$APPJS" 'function loadDiff()' &&
   has "$APPJS" 'function renderDiffFiles(files, sid)' &&
   has "$APPJS" '/diff?context=3' && has "$APPJS" 'diffHtml(files)' &&
   has "$APPJS" 'Array.isArray(j.data)'; then
  echo "PASS: /diff 拉服务端的最近一轮 diff,正文复用消息卡片那套 diffHtml(不另造渲染)"; pass=$((pass + 1))
else
  echo "FAIL: 变更总览没接 /api/session/:id/diff?context=3,或没有复用 diffHtml"; fail=$((fail + 1))
fi
if has "$APPJS" 'let diffSeq = 0;' && has "$APPJS" 'seq !== diffSeq' &&
   has "$APPJS" 'diffSeq++' &&
   has "$APPJS" "name: 'diff', description: '查看最近一轮变更" &&
   has "$APPJS" "reload.addEventListener('click', loadDiff)" &&
   has "$APPJS" 'isRunning(sid)' && has "$APPJS" '最近一轮还在跑'; then
  echo "PASS: /diff 进了面板命令;刷新/切会话用序号挡旧响应;轮次在跑时空结果说清「结束后点刷新」"; pass=$((pass + 1))
else
  echo "FAIL: 缺 /diff 命令、旧响应防护、或「还在跑」的空结果文案"; fail=$((fail + 1))
fi
SMOKE_CAP="$(dirname "$0")/ui-capabilities.html"
if [ -f "$SMOKE_CAP" ] && has "$(cat "$SMOKE_CAP")" '变更:openDiff 打开对话框并拉最近一轮' &&
   has "$(cat "$SMOKE_CAP")" '变更:轮次还在跑时' && has "$(cat "$SMOKE_CAP")" '变更:没选会话时不开框'; then
  echo "PASS: test/ui-capabilities.html 里有 /diff 的浏览器断言(渲染 / 空结果 / 失败刷新 / 没选中)"; pass=$((pass + 1))
else
  echo "FAIL: test/ui-capabilities.html 缺 /diff 的关键断言"; fail=$((fail + 1))
fi

# ---- R18 组:最近会话标签栏(§8.59) ----
NAV_POS=$(printf '%s' "$HOME_HTML" | grep -bo 'id="sessionTabs"' 2>/dev/null | head -1 | cut -d: -f1)
HEAD_POS=$(printf '%s' "$HOME_HTML" | grep -bo 'id="chatHeader"' 2>/dev/null | head -1 | cut -d: -f1)
if [ -n "$NAV_POS" ] && [ -n "$HEAD_POS" ] && [ "$NAV_POS" -lt "$HEAD_POS" ] &&
   has "$HOME_HTML" 'id="tabStrip"' && has "$HOME_HTML" 'id="tabNew"' &&
   has "$HOME_HTML" 'id="tabReopen"' &&
   has "$HOME_HTML" '<span class="tnFull">+ 新建</span>'; then
  echo "PASS: 标签栏挂在 #chatpane 顶部、#chatHeader 之前(左列表保留),含 tabStrip、+ 新建与 ↺ 重开"; pass=$((pass + 1))
else
  echo "FAIL: 标签栏节点缺失 / 顺序不对 / 没有 + 新建"; fail=$((fail + 1))
fi
if has "$APPJS" "const TABS_KEY = 'ocs.tabs';" && has "$APPJS" 'const TABS_MAX = 8;' &&
   has "$APPJS" 'function readTabs()' && has "$APPJS" 'function saveTabs()' &&
   has "$APPJS" 'function touchTab(id, title)' && has "$APPJS" 'function renderTabs()' &&
   has "$APPJS" 'function setupSessionTabs()' && has "$APPJS" 'touchTab(id); // §8.59' &&
   has "$APPJS" 'store.tabs = readTabs();' && has "$APPJS" 'setupSessionTabs();'; then
  echo "PASS: 打开会话自动进标签;列表存 ocs.tabs、最多 8 个;init 先画再拉列表"; pass=$((pass + 1))
else
  echo "FAIL: 标签状态 / 持久化 / 自动入栏 / init 接线缺了一块"; fail=$((fail + 1))
fi
CLOSETAB=$(printf '%s' "$APPJS" | sed -n '/^function closeTab(id) {/,/^}/p' 2>/dev/null)
if [ -n "$CLOSETAB" ] && ! has "$CLOSETAB" "method: 'DELETE'" && ! has "$CLOSETAB" 'api(' &&
   ! has "$CLOSETAB" 'archive' &&
   has "$CLOSETAB" 'store.tabs.splice(i, 1);' &&
   printf '%s' "$CLOSETAB" | grep -Fq 'store.tabs[i] || store.tabs[i - 1]'; then
  echo "PASS: 关标签只从列表移出(不发 DELETE、不归档),关当前标签切右邻居再左邻居"; pass=$((pass + 1))
else
  echo "FAIL: 关标签会误删/误归档会话,或没有邻居回退"; fail=$((fail + 1))
fi
if has "$CSS" '#sessionTabs {' && has "$CSS" '#tabStrip {' && has "$CSS" '.tab.active {' &&
   has "$CSS" 'html.narrow #sessionTabs { height: 34px; }' &&
   has "$CSS" 'html.narrow.short #sessionTabs { height: 30px; }' &&
   has "$CSS" 'html.narrow .tab.active .tabx { display: flex; }'; then
  echo "PASS: 标签栏样式齐全(桌面 36px / 竖屏 34px / 横屏 30px,当前 tab 才露 ×)"; pass=$((pass + 1))
else
  echo "FAIL: 标签栏样式缺基础规则或窄屏高度"; fail=$((fail + 1))
fi
# §8.92 短标签也要有可点击的安全区:最小宽度 + × 前的 6px 缝
if has "$CSS" '.tab {' && has "$CSS" 'min-width: 96px;' &&
   has "$CSS" 'html.narrow .tab { max-width: 150px; min-width: 84px; }' &&
   has "$CSS" '.tabx {' && has "$CSS" 'margin-left: 6px;'; then
  echo "PASS: 短标签有最小宽度,× 前留 6px 安全缝"; pass=$((pass + 1))
else
  echo "FAIL: 短标签缺少最小宽度或 × 安全缝"; fail=$((fail + 1))
fi
# §8.94 标签拖拽排序:鼠标拖 / 手机长按;只改本机顺序,不动会话
if has "$APPJS" 'function moveTab(' && has "$APPJS" 'TAB_LONGPRESS_MS' &&
   has "$APPJS" 'function startTabDrag(' && has "$APPJS" 'function tabLongPress()' &&
   has "$APPJS" 'tabSuppressClickUntil' && has "$APPJS" "'pointerdown'" &&
   has "$CSS" 'touch-action: pan-x;' && has "$CSS" '.tab.dragging {' &&
   has "$CSS" '.tab.drop-before::before'; then
  echo "PASS: 标签拖拽排序的鼠标 / 手机长按状态机与插入线样式都在"; pass=$((pass + 1))
else
  echo "FAIL: 标签拖拽排序缺少状态机或样式"; fail=$((fail + 1))
fi
SMOKE_CAP="$(dirname "$0")/ui-capabilities.html"
if [ -f "$SMOKE_CAP" ] && has "$(cat "$SMOKE_CAP")" '§8.59 最近会话标签栏' &&
   has "$(cat "$SMOKE_CAP")" '关闭非当前标签:只移出标签栏,不删会话也不切会话' &&
   has "$(cat "$SMOKE_CAP")" '最多留 8 个,超出丢最旧的那个' &&
   has "$(cat "$SMOKE_CAP")" '窄屏:只有当前标签露 ×' &&
   has "$(cat "$SMOKE_CAP")" '短标签有最小宽度,标题与 × 之间留安全缝'; then
  echo "PASS: test/ui-capabilities.html 里有标签栏的浏览器断言(自动入栏 / 切换 / 关闭 / 上限 / 窄屏)"; pass=$((pass + 1))
else
  echo "FAIL: test/ui-capabilities.html 缺标签栏的关键断言"; fail=$((fail + 1))
fi
if [ -f "$SMOKE_CAP" ] && has "$(cat "$SMOKE_CAP")" '§8.94 标签拖拽排序(鼠标 / 手机长按)' &&
   has "$(cat "$SMOKE_CAP")" '鼠标拖拽:从最前拖到末尾后顺序变了、当前会话不变' &&
   has "$(cat "$SMOKE_CAP")" '鼠标拖拽:新顺序写回 localStorage' &&
   has "$(cat "$SMOKE_CAP")" '手机长按拖拽:顺序变了、当前会话不变' &&
   has "$(cat "$SMOKE_CAP")" '手机未长按就横滑:让给标签栏滚动,不进入拖拽' &&
   has "$(cat "$SMOKE_CAP")" '拖到标签栏外松手:取消排序,顺序不动'; then
  echo "PASS: test/ui-capabilities.html 里有标签拖拽的鼠标 / 手机长按 / 横滑让路 / 取消断言"; pass=$((pass + 1))
else
  echo "FAIL: test/ui-capabilities.html 缺标签拖拽的关键断言"; fail=$((fail + 1))
fi

# §8.60 TUI diff 偏好共享:面板不再只记 localStorage,而是读写 cli.json 的 diffs.view
if has "$SERVERJS" "url === '/__config/diffs'" && has "$SERVERJS" 'function readDiffView()' &&
   has "$SERVERJS" 'function writeDiffView(view)' && has "$SERVERJS" 'diffView: dv.view'; then
  echo "PASS: /__config/diffs 路由、读写函数与 health 的 diffView 都在"; pass=$((pass + 1))
else
  echo "FAIL: 服务端没接 /__config/diffs 或 health 没带 diffView"; fail=$((fail + 1))
fi
if has "$SERVERJS" 'fs.renameSync(tmp, CLI_CONFIG_FILE)' && has "$SERVERJS" 'fs.chmodSync(tmp, mode)' &&
   has "$SERVERJS" 'JSON.stringify(obj, null, 2)' && has "$SERVERJS" 'CONFIG_BODY_MAX'; then
  echo "PASS: 写 cli.json 走同目录临时文件 + rename,保留权限,只收小请求体"; pass=$((pass + 1))
else
  echo "FAIL: cli.json 的写法不是原子替换,或没保留权限 / 没限制请求体"; fail=$((fail + 1))
fi
if has "$APPJS" 'function applyServerDiffPref(view, mtime)' &&
   has "$APPJS" 'function loadDiffPref()' && has "$APPJS" "api('/__config/diffs'" &&
   has "$APPJS" "method: 'PATCH'" && has "$APPJS" 'loadDiffPref(); // §8.60'; then
  echo "PASS: 面板首屏读 /__config/diffs、切换时 PATCH 回去,init 已接线"; pass=$((pass + 1))
else
  echo "FAIL: 面板没读/写 cli.json,或 init 没接 loadDiffPref"; fail=$((fail + 1))
fi
if has "$APPJS" "hasOwnProperty.call(j, 'diffView')" && has "$APPJS" 'diffPrefMigrated' &&
   has "$APPJS" '并排偏好没写进 cli.json:' && has "$APPJS" 'diffPrefMtime'; then
  echo "PASS: health 带回 TUI 偏好、旧 localStorage 只迁移一次、写失败有提示"; pass=$((pass + 1))
else
  echo "FAIL: health 同步 / 迁移 / 写失败提示缺了一块"; fail=$((fail + 1))
fi
SMOKE_CFG="$(dirname "$0")/config-e2e-run.js"
SMOKE_TOOLS="$(dirname "$0")/ui-tools.html"
if [ -f "$SMOKE_CFG" ] && has "$(cat "$SMOKE_CFG")" 'OPENCODE_CONFIG_DIR' &&
   has "$(cat "$SMOKE_CFG")" 'diffs.view' && has "$(cat "$SMOKE_TOOLS")" '§8.60 TUI diff 偏好共享'; then
  echo "PASS: test/config-e2e-run.js 在,ui-tools.html 有 §8.60 的浏览器断言"; pass=$((pass + 1))
else
  echo "FAIL: 缺 config 端到端测试或 ui-tools 的共享偏好断言"; fail=$((fail + 1))
fi

# ---- R19 组:工作树列表 / 删除 / 移入(§8.61;照 TUI 的 Worktrees 对话框)----
if has "$APPJS" "name: 'worktrees'" && has "$APPJS" "function openWorktrees()" &&
   has "$APPJS" "'/worktrees', d:"; then
  echo "PASS: /worktrees 进了命令面板与快捷键说明(和 /diff 一样不往聊天头部加按钮)"; pass=$((pass + 1))
else
  echo "FAIL: 缺 /worktrees 命令或快捷键说明"; fail=$((fail + 1))
fi
if has "$APPJS" "api('/api/worktree/refresh'" &&
   has "$APPJS" "/api/worktree?' + new URLSearchParams" &&
   has "$APPJS" "const j = await api('/api/session/' + enc(sid));" &&
   has "$APPJS" 'function worktreeSessions(projectID)' &&
   has "$APPJS" 'function wtSubdirs(roots, sessions)' &&
   has "$APPJS" 'function openWorktreeActions(it, ctx)' &&
   has "$APPJS" 'function wtCurrentRoot(list, dir)' &&
   has "$HOME_HTML" 'id="dlgWtDel"' && has "$CSS" '.wtfiles {'; then
  echo "PASS: 打开先取会话最新目录,再 refresh 后按 projectID 列;根 / 子目录 / 动作菜单与删除预览框都在"; pass=$((pass + 1))
else
  echo "FAIL: 工作树列表 / refresh / 子目录 / 当前根 / 动作菜单 / 删除预览框缺了一块"; fail=$((fail + 1))
fi
if has "$APPJS" 'function moveSessionToWorktree(sid, directory)' &&
   has "$APPJS" "/api/session/' + enc(sid) + '/move" &&
   has "$APPJS" 'body: JSON.stringify({ directory })' &&
   has "$APPJS" 's.location = Object.assign({}, s.location, { directory });'; then
  echo "PASS: 移入走 session/move,并把本地会话目录同步过去(列表/提示栏/工具栏一起刷新)"; pass=$((pass + 1))
else
  echo "FAIL: 移入没有调 session/move 或没更新本地目录"; fail=$((fail + 1))
fi
SMOKE_DELWT=$(printf '%s' "$APPJS" | sed -n '/^async function removeWorktree(w, ctx, force) {/,/^}/p' 2>/dev/null)
if [ -n "$SMOKE_DELWT" ] && has "$SMOKE_DELWT" "method: 'DELETE'" &&
   has "$SMOKE_DELWT" 'forceRequired === true' && has "$SMOKE_DELWT" 'force: !!force' &&
   has "$SMOKE_DELWT" 'loadWorktreeStatus(dir)' &&
   has "$SMOKE_DELWT" 'confirmWorktreeDelete(w, files)' &&
   has "$SMOKE_DELWT" 'clearSelection();' && has "$APPJS" 'err.data = j && j.data'; then
  echo "PASS: 删除只对 worktree 开放,有改动先列 status 文件清单再 force;删掉当前目录就回列表"; pass=$((pass + 1))
else
  echo "FAIL: 工作树删除的 force 预览 / 当前目录回退 / err.data 解包缺了一块"; fail=$((fail + 1))
fi
SMOKE_CAP="$(dirname "$0")/ui-capabilities.html"
if [ -f "$SMOKE_CAP" ] && has "$(cat "$SMOKE_CAP")" '§8.61 worktree 管理' &&
   has "$(cat "$SMOKE_CAP")" '移入:POST session/move' &&
   has "$(cat "$SMOKE_CAP")" '有未提交改动:先读 status' &&
   has "$(cat "$SMOKE_CAP")" '删除预览点取消' &&
   has "$(cat "$SMOKE_CAP")" '不在该子目录时' &&
   has "$(cat "$SMOKE_CAP")" '删掉当前会话所在工作树'; then
  echo "PASS: test/ui-capabilities.html 里有工作树列表 / 子目录 / 移入 / 删除预览 / force / 当前目录的浏览器断言"; pass=$((pass + 1))
else
  echo "FAIL: test/ui-capabilities.html 缺工作树管理的关键断言"; fail=$((fail + 1))
fi

# ---- R20 组:重画 diff 只换正文(§8.62)----
if has "$APPJS" 'function diffToolHtml(p, files)' &&
   has "$APPJS" "'<div class=\"diffwrap\">' + diffHtml(files, { pid: p.id }) + '</div>'" &&
   has "$APPJS" 'diffToolHtml(p, files) + diagHtml(md, path)' &&
   has "$CSS" '.toolbody > .diffwrap:first-child > .dfile:first-child { margin-top: 0; }'; then
  echo "PASS: diff 卡片把正文单独包进 .diffwrap,诊断块仍在它外面;首块文件头贴顶由 CSS 补"; pass=$((pass + 1))
else
  echo "FAIL: diff 卡片没有单独的正文层,或诊断块被包进去了"; fail=$((fail + 1))
fi
SMOKE_REDRAW=$(printf '%s' "$APPJS" | sed -n '/^function redrawDiffCards(pid) {/,/^}/p' 2>/dev/null)
if [ -n "$SMOKE_REDRAW" ] && has "$SMOKE_REDRAW" 'wrap.innerHTML = diffHtml(files' &&
   has "$SMOKE_REDRAW" 'body.scrollTop = scroll' &&
   has "$SMOKE_REDRAW" 'preventScroll: true' &&
   ! has "$SMOKE_REDRAW" 'card.replaceWith' &&
   ! has "$SMOKE_REDRAW" 'toolHtml(p)'; then
  echo "PASS: redrawDiffCards 只换 .diffwrap 正文(不再整卡 toolHtml + replaceWith),正文滚动与焦点都留住"; pass=$((pass + 1))
else
  echo "FAIL: redrawDiffCards 还在整卡重造,或丢了正文滚动 / 焦点"; fail=$((fail + 1))
fi
SMOKE_TOOLS="$(dirname "$0")/ui-tools.html"
if [ -f "$SMOKE_TOOLS" ] && has "$(cat "$SMOKE_TOOLS")" '§8.62 重画只换 diff 正文' &&
   has "$(cat "$SMOKE_TOOLS")" '重画:不重造 details / summary / 正文容器' &&
   has "$(cat "$SMOKE_TOOLS")" '重画:只换 .diffwrap 里的 diff 正文,诊断块原样留着' &&
   has "$(cat "$SMOKE_TOOLS")" '重画:正文自己的滚动位置保留'; then
  echo "PASS: test/ui-tools.html 里有节点身份 / 诊断块 / 折叠 / 正文滚动 / 焦点的重画断言"; pass=$((pass + 1))
else
  echo "FAIL: test/ui-tools.html 缺 §8.62 的重画断言"; fail=$((fail + 1))
fi

# ---- R21 组:/diff 四档来源 + 对比分支(§8.63;照 TUI 的 diff viewer)----
SMOKE_CAP="$(dirname "$0")/ui-capabilities.html"
if has "$APPJS" 'const DIFF_SOURCES = {' &&
   has "$APPJS" "mode === 'branch' || mode === 'committed'" &&
   has "$APPJS" "q.set('base', base.ref)" &&
   has "$APPJS" 'async function openDiffBasePick()' &&
   has "$APPJS" "btn.textContent = base ? '对比 ' + diffBaseText(base) : '选择对比分支…'" &&
   has "$HOME_HTML" 'data-diffmode="committed"' && has "$HOME_HTML" 'id="diffBase"' &&
   has "$CSS" '.diffsources {' && has "$CSS" 'html.narrow .diffsources button { min-height: 40px;' &&
   has "$(cat "$SMOKE_CAP")" '变更:四档来源按钮齐全' &&
   has "$(cat "$SMOKE_CAP")" '变更:选完基线自动重载全部档'; then
  echo "PASS: /diff 有最近一轮/全部/未提交/已提交四档、对比分支选择与窄屏横滑"; pass=$((pass + 1))
else
  echo "FAIL: /diff 缺四档来源、对比分支选择或窄屏样式"; fail=$((fail + 1))
fi

# ---- R22 组:/diff 文件树 + 逐文件 reviewed(§8.64)----
if has "$HOME_HTML" 'class="diffmain"' && has "$HOME_HTML" 'id="diffTree"' &&
   has "$APPJS" 'function renderDiffTree(files)' &&
   has "$APPJS" 'if (diffTreeFiles.length < 2)' &&
   has "$APPJS" 'tree.hidden = false' &&
   has "$APPJS" 'function scrollDiffToFile(i)' &&
   has "$APPJS" 'function toggleDiffReviewed(i)' &&
   has "$APPJS" 'paintDiffTreeReviewed();' &&
   has "$CSS" '.difftree {' && has "$CSS" 'html.narrow .difftree { display: none; }' &&
   has "$CSS" '.dtree-item.reviewed .dtree-path' &&
   has "$(cat "$SMOKE_CAP")" '文件树:多文件时列出' &&
   has "$(cat "$SMOKE_CAP")" '文件树:勾已看只改树和计数,不重造 diff 正文'; then
  echo "PASS: /diff 文件树按多文件露出、点文件跳正文、逐文件勾已看不重造正文,窄屏收起"; pass=$((pass + 1))
else
  echo "FAIL: /diff 文件树 / 跳转 / reviewed / 窄屏样式缺了一块"; fail=$((fail + 1))
fi

# ---- R23 组:跨消息探索并组(只吸收纯探索续步;§8.68)----
if has "$APPJS" 'function exploreAbsorbPlan(msgs)' &&
   has "$APPJS" 'function isPureExploreStep(m)' &&
   has "$APPJS" 'const absorbPlan = exploreAbsorbPlan(msgs)' &&
   has "$APPJS" "data-absorbed-by" &&
   has "$APPJS" 'if (rec && rec.absorbed) rec = msgEls.get(rec.absorbed) || rec;' &&
   has "$CSS" '.msg.absorbed { display: none; }' &&
   has "$(cat "$(dirname "$0")/ui-tools.html")" '跨消息:只吸收非终步、整条都是探索工具的续步'; then
  echo "PASS: §8.68 跨消息只吸收纯探索续步,占位 / 锚点 / 静态样式与浏览器断言都在"; pass=$((pass + 1))
else
  echo "FAIL: §8.68 的跨消息吸收 / 占位 / 锚点 / 样式缺了一块"; fail=$((fail + 1))
fi

# ---- R24 组:子会话不进主列表(§8.69 / A1)----
if has "$APPJS" 'const roots = all.filter((s) => !s.parentID);' &&
   has "$APPJS" 'const archived = all.filter((s) => !s.parentID && isArchived(s));' &&
   has "$(cat "$(dirname "$0")/ui-picks.html")" '/sessions:子会话不进主列表'; then
  echo "PASS: §8.69 主列表 / /sessions / 已归档计数都只算顶层会话"; pass=$((pass + 1))
else
  echo "FAIL: §8.69 的 parentID 过滤或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R25 组:子会话 / 父会话导航(§8.69 / B2)----
if has "$APPJS" 'function childIDs(sid)' && has "$APPJS" 'function parentOf(sid)' &&
   has "$APPJS" 'async function openSubagentPick(sid)' && has "$APPJS" 'function goParent(sid)' &&
   has "$APPJS" "name: 'subagents'" && has "$APPJS" "name: 'parent'" &&
   has "$APPJS" 'function setupMessageActions()' && has "$APPJS" 'data-child="' &&
   has "$HOME_HTML" 'id="opSubagents"' && has "$HOME_HTML" 'id="opParent"' &&
   has "$CSS" '.completion[data-child] {' &&
   has "$(cat "$(dirname "$0")/ui-picks.html")" '/subagents:选中即切到子会话' &&
   has "$(cat "$(dirname "$0")/ui-tools.html")" '子会话收工行带 data-child'; then
  echo "PASS: §8.69 头部入口 / /subagents / /parent / 收工行 childID 跳转都在"; pass=$((pass + 1))
else
  echo "FAIL: §8.69 的子会话选择、父会话入口或收工行跳转缺了一块"; fail=$((fail + 1))
fi

# ---- R26 组:/timeline 跳到用户消息 + /fork 从消息分叉(§8.70 / A2 + A3)----
SMOKE_PICKS="$(dirname "$0")/ui-picks.html"
if has "$APPJS" 'function jumpToMessage(id)' &&
   has "$APPJS" 'function openTimeline()' &&
   has "$APPJS" 'function openForkPick(sid)' &&
   has "$APPJS" 'async function forkSession(sid, before, open)' &&
   has "$APPJS" "name: 'timeline'" && has "$APPJS" "name: 'fork'" &&
   has "$APPJS" 'body: JSON.stringify(before ? { before: before } : {})' &&
   has "$APPJS" 'await forkSession(id, null, false);' &&
   has "$(cat "$SMOKE_PICKS")" '/timeline:选中后滚到那条消息' &&
   has "$(cat "$SMOKE_PICKS")" '/fork:选中某条用户消息发 {before}'; then
  echo "PASS: §8.70 /timeline 按消息 id 滚过去,/fork 带 before 分叉并打开新会话;列表行分叉保持只刷新"; pass=$((pass + 1))
else
  echo "FAIL: §8.70 的时间线 / 分叉函数、命令或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R27 组:每会话输入草稿(§8.71 / A4)----
if has "$APPJS" "const DRAFT_KEY = 'ocs.drafts'" &&
   has "$APPJS" 'function saveDraft(sid, text)' &&
   has "$APPJS" 'function restoreDraft(sid)' &&
   has "$APPJS" 'function saveCurrentDraft(sid)' &&
   has "$APPJS" 'saveCurrentDraft(prev);' &&
   has "$APPJS" 'restoreDraft(id);' &&
   has "$APPJS" 'saveDraft(store.selected, inp.value);' &&
   has "$APPJS" "saveDraft(sid, '');" &&
   has "$(cat "$SMOKE_PICKS")" '草稿:切回来填回自己的' &&
   has "$(cat "$SMOKE_PICKS")" '草稿:发送失败时保留,切回来还能接着改'; then
  echo "PASS: §8.71 草稿按会话存/取,切走保存、切回填回,发送成功清、失败留,/clear 与回列表也处理"; pass=$((pass + 1))
else
  echo "FAIL: §8.71 的草稿存取 / 切换接线 / 发送清理或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R28 组:复制会话 ID / 转录(§8.72 / A5)----
if has "$APPJS" 'async function copyText(text)' &&
   has "$APPJS" 'async function copySessionId(sid)' &&
   has "$APPJS" 'function transcriptText(info, messages)' &&
   has "$APPJS" 'async function copyTranscript(sid)' &&
   has "$APPJS" "description: '复制当前会话转录(纯文本)'" &&
   has "$APPJS" "name: 'copyid'" &&
   has "$APPJS" "/export?sanitize=false" &&
   has "$APPJS" "{ key: 'copyid', label: '复制会话 ID'" &&
   has "$APPJS" "{ key: 'transcript', label: '复制转录'" &&
   has "$(cat "$SMOKE_PICKS")" '/copy 复制转录、/copyid 复制 ID' &&
   has "$(cat "$(dirname "$0")/ui-tools.html")" '转录:默认不复制思考'; then
  echo "PASS: §8.72 复制 ID / 转录、剪贴板回退、export 取全量、命令与更多操作入口都在"; pass=$((pass + 1))
else
  echo "FAIL: §8.72 的复制函数 / 命令 / 更多操作或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R29 组:会话置顶(§8.73 / A6)----
if has "$APPJS" "const PIN_KEY = 'ocs.pinned'" &&
   has "$APPJS" 'function pinnedSet()' && has "$APPJS" 'function isPinned(id)' &&
   has "$APPJS" 'function togglePin(id)' &&
   has "$APPJS" 'const pinned = pinnedSet();' &&
   has "$APPJS" 'if (pa !== pb) return pb - pa;' &&
   has "$APPJS" 'pin-badge' &&
   has "$APPJS" "{ key: 'pin', label: pin ? '取消置顶' : '置顶'" &&
   has "$CSS" '.pin-badge {' &&
   has "$(cat "$SMOKE_PICKS")" '置顶:置顶后排最前(哪怕 updated 更旧)' &&
   has "$(cat "$(dirname "$0")/ui-mobile.html")" '九项就是桌面那九个动作'; then
  echo "PASS: §8.73 置顶持久化、列表排序优先、更多操作入口与置顶徽标都在"; pass=$((pass + 1))
else
  echo "FAIL: §8.73 的置顶存储 / 排序 / 入口 / 样式或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R30 组:图片单独发送 + 附件按会话保留(§8.74)----
if has "$APPJS" 'const attachCache = new Map();' &&
   has "$APPJS" 'function saveCurrentAttachments(sid)' &&
   has "$APPJS" 'function restoreAttachments(sid)' &&
   has "$APPJS" 'function dropSessionAttachments(sid)' &&
   has "$APPJS" 'saveCurrentAttachments(prev);' &&
   has "$APPJS" 'restoreAttachments(id);' &&
   has "$APPJS" 'const owner = store.attachments;' &&
   has "$APPJS" '附件还在上传,稍等一下再发' &&
   has "$APPJS" 'if (!text && !files.length) return;' &&
   has "$(cat "$(dirname "$0")/ui-attach.html")" 'send:只有图片没有文字也能发' &&
   has "$(cat "$(dirname "$0")/ui-attach.html")" '切回原会话恢复自己的附件'; then
  echo "PASS: §8.74 图片可单独发送、上传中拦截、附件按会话隔离并在切回时恢复"; pass=$((pass + 1))
else
  echo "FAIL: §8.74 的图片单发 / 附件缓存 / 上传归属或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R31 组:重开最近关闭的标签(§8.75)----
if has "$APPJS" 'const CLOSED_MAX = 8;' &&
   has "$APPJS" 'const closedTabs = [];' &&
   has "$APPJS" 'function rememberClosedTab(id, title)' &&
   has "$APPJS" 'function renderTabReopen()' &&
   has "$APPJS" 'async function reopenTab()' &&
   has "$APPJS" 'rememberClosedTab(id, store.tabs[i] && store.tabs[i].title);' &&
   has "$APPJS" 'const ci = closedTabs.findIndex((t) => t.id === id);' &&
   has "$APPJS" 'nav.hidden = store.tabs.length === 0 && closedTabs.length === 0;' &&
   has "$APPJS" "name: 'tab-reopen', description: '重开最近关闭的标签'" &&
   has "$APPJS" "e.target.closest('#tabReopen')" &&
   has "$HOME_HTML" 'id="tabReopen"' && has "$HOME_HTML" 'aria-label="重开刚关闭的标签"' &&
   has "$CSS" '#tabReopen[hidden] { display: none; }' &&
   has "$CSS" 'html.narrow #tabReopen {' &&
   has "$(cat "$(dirname "$0")/ui-capabilities.html")" '重开最近关闭的标签并切过去' &&
   has "$(cat "$(dirname "$0")/ui-capabilities.html")" '关掉最后一个标签:回到未选择,但重开入口还在'; then
  echo "PASS: §8.75 最近关闭栈 / ↺ 按钮 / 空栏仍可重开 / 命令面板入口与窄屏样式都在"; pass=$((pass + 1))
else
  echo "FAIL: §8.75 的关闭栈 / 重开入口 / 空栏可见性或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R32 组:切走前贴着底,切回来仍贴底(§8.76)----
if has "$APPJS" 'bottom: atBottom(box)' &&
   has "$APPJS" 'if (pending.bottom)' &&
   has "$APPJS" 'pinBottom(box);' &&
   has "$APPJS" 'atB = true;' &&
   has "$APPJS" 'pinned = true;' &&
   has "$(cat "$(dirname "$0")/ui-layout.html")" '贴底时锚点记下 bottom=true' &&
   has "$(cat "$(dirname "$0")/ui-layout.html")" '切走前在底部 → 切回来仍贴底(新消息也顶不掉)'; then
  echo "PASS: §8.76 滚动锚点带 bottom 标记,切回底部的会话直接重新贴底(新消息也顶不掉)"; pass=$((pass + 1))
else
  echo "FAIL: §8.76 的 bottom 标记 / 贴底分支或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R33 组:技能选择 /skills,按 prompt.skills 发送(§8.77)----
if has "$APPJS" 'function openSkillPick()' &&
   has "$APPJS" '/api/skill?' &&
   has "$APPJS" 'function insertSkill(id, name)' &&
   has "$APPJS" 'store.skillHits.set(id, name || id);' &&
   has "$APPJS" 'const skills = resolveSkills(text);' &&
   has "$APPJS" 'if (skills.length) body.skills = skills;' &&
   has "$APPJS" 'if (store.skillHits.has(k)) continue;' &&
   has "$APPJS" "name: 'skills', description: '插入技能(@skill,按 TUI 的 prompt.skills)'" &&
   has "$CSS" '.achip.skill { border-color: var(--accent); }' &&
   has "$(cat "$(dirname "$0")/ui-picks.html")" '请求体走 skills[] 而不是 files[]' &&
   has "$(cat "$(dirname "$0")/ui-picks.html")" '切走再切回,技能选择和草稿一起回来'; then
  echo "PASS: §8.77 /skills 列表、@skill 插入、skills[] 请求体与按会话保留都在"; pass=$((pass + 1))
else
  echo "FAIL: §8.77 的技能列表 / 插入 / 请求体 / 与 files[] 分流或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R34 组:探索工具组开关(§8.78)----
if has "$APPJS" "const EXPLORE_GROUP_KEY = 'ocs.exploreGroup';" &&
   has "$APPJS" 'exploreGroup: (function () {' &&
   has "$APPJS" 'function setExploreGroup(on)' &&
   has "$APPJS" 'function toggleExploreGroup()' &&
   has "$APPJS" 'if (!store.exploreGroup) return { absorbed: absorbed, partsByOwner: partsByOwner };' &&
   has "$APPJS" 'if (store.exploreGroup && isExploreTool(p)) {' &&
   has "$APPJS" "name: 'exploration', description: '探索工具组:折叠 / 逐条显示'" &&
   has "$APPJS" "k: '/exploration', d: '折叠 / 逐条显示探索工具组" &&
   has "$(cat "$(dirname "$0")/ui-tools.html")" '探索开关:已有占位原地关掉后恢复成独立消息' &&
   has "$(cat "$(dirname "$0")/ui-tools.html")" '探索开关:原地再打开又变回占位并并组'; then
  echo "PASS: §8.78 探索工具组可折叠 / 逐条切换,偏好写 localStorage,跨消息吸收同步关掉"; pass=$((pass + 1))
else
  echo "FAIL: §8.78 的开关 / localStorage / 打包条件 / 吸收短路或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R35 组:/mcps 只读列表(§8.79)----
if has "$APPJS" 'function openMcpPick()' &&
   has "$APPJS" "'/api/mcp' + q" &&
   has "$APPJS" 'function mcpStatusLabel(st)' &&
   has "$APPJS" 'readonly: true,' &&
   has "$APPJS" 'store.pickReadonly = !!opts.readonly;' &&
   has "$APPJS" 'if (!it || it.disabled || store.pickReadonly) return;' &&
   has "$APPJS" '↑↓ 浏览 · Esc 关闭' &&
   has "$APPJS" "name: 'mcps', description: 'MCP 服务器与连接状态(只读)'" &&
   has "$APPJS" "k: '/mcps', d: 'MCP 服务器与连接状态(只读,对应 TUI mcp.list)'" &&
   has "$(cat "$(dirname "$0")/ui-picks.html")" '/mcps:只读列表底部只写浏览 / 关闭' &&
   has "$(cat "$(dirname "$0")/ui-picks.html")" '/mcps:没选中会话也能看,不硬塞空目录'; then
  echo "PASS: §8.79 /mcps 只读列表、状态翻译、只读脚注与全局 / 工程两种取数都在"; pass=$((pass + 1))
else
  echo "FAIL: §8.79 的列表 / 状态 / 只读交互 / 命令入口或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R36 组:导出 Markdown / JSON(§8.80)----
if has "$APPJS" 'function exportFormat()' &&
   has "$APPJS" 'function syncExportForm()' &&
   has "$APPJS" 'function setupExport()' &&
   has "$APPJS" 'function downloadText(name, text, mime)' &&
   has "$APPJS" "if (format === 'markdown') {" &&
   has "$APPJS" 'const md = transcriptText(d.info || s, d.messages || []);' &&
   has "$APPJS" "downloadText(name, md, 'text/markdown;charset=utf-8');" &&
   has "$APPJS" 'setupExport(); // §8.80' &&
   has "$APPJS" "description: '导出当前会话为 Markdown / JSON'" &&
   has "$(cat "$(dirname "$0")/../public/index.html")" 'id="exportFormatMarkdown"' &&
   has "$CSS" '#exportSanitizeRow[hidden] { display: none; }' &&
   has "$(cat "$(dirname "$0")/ui-capabilities.html")" 'Markdown 导出是转录正文,不是 JSON' &&
   has "$(cat "$(dirname "$0")/ui-capabilities.html")" 'Markdown 导出文件名带标题与 .md'; then
  echo "PASS: §8.80 导出默认 Markdown、JSON 仍可脱敏、转录文件与格式切换都在"; pass=$((pass + 1))
else
  echo "FAIL: §8.80 的格式切换 / Markdown 转录 / 文件下载 / 脱敏显隐或浏览器断言缺了一块"; fail=$((fail + 1))
fi

# ---- R37 组:/status 只读摘要(§8.81)----
if has "$APPJS" 'function statusRowHtml(label, value)' &&
   has "$APPJS" 'function configSummary(list)' &&
   has "$APPJS" 'async function openStatus()' &&
   has "$APPJS" "'/api/config' + q" &&
   has "$APPJS" "'/api/mcp' + q" &&
   has "$APPJS" "h.hasPassword ? 'Basic 已启用(密码不显示)' : '未启用'" &&
   has "$APPJS" "name: 'status', description: '连接 / 配置 / Provider / MCP 摘要(只读)'" &&
   has "$APPJS" "k: '/status', d: '连接 / 配置 / Provider / MCP 摘要(只读)'" &&
   has "$SERVERJS" 'const PKG_VERSION = require('"'"'./package.json'"'"').version;' &&
   has "$SERVERJS" 'version: PKG_VERSION,' &&
   has "$HOME_HTML" 'id="dlgStatus"' &&
   has "$HOME_HTML" 'id="statusBody"' &&
   has "$CSS" '.strow {' &&
   has "$CSS" 'html.narrow .strow { grid-template-columns: 84px minmax(0, 1fr); gap: 8px; }' &&
   has "$(cat "$(dirname "$0")/ui-capabilities.html")" '/status:健康、版本、地址、鉴权都摆出来,不露密码' &&
   has "$(cat "$(dirname "$0")/ui-capabilities.html")" '/status:没选中会话时不硬塞空目录'; then
  echo "PASS: §8.81 /status 健康 / 版本 / 配置摘要 / MCP 计数与不露密码都在"; pass=$((pass + 1))
else
  echo "FAIL: §8.81 的状态表 / 摘要 / 版本 / 密码保护 / 命令入口或浏览器断言缺了一块"; fail=$((fail + 1))
fi

echo
echo "结果: $pass 通过, $fail 失败"
[ "$fail" = 0 ]
