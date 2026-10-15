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
if [ -n "$PW" ] && printf '%s' "$body" | grep -qF "$PW"; then leak=1; fi
if [ -n "${OCS_AUTH:-}" ] && printf '%s' "$body" | grep -qF "${OCS_AUTH#*:}"; then leak=1; fi
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

if curl -s "${AUTH[@]}" "$PROXY/" | grep -q 'id="asks"'; then
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

HOME_HTML=$(curl -s "${AUTH[@]}" "$PROXY/")
for sel in 'id="ctoolbar"' 'id="agentSel"' 'id="modelSel"' 'id="interrupt"' 'id="delivery"' 'id="inbox"'; do
  if printf '%s' "$HOME_HTML" | grep -q "$sel"; then
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
  if printf '%s' "$HOME_HTML" | grep -q "$sel"; then
    echo "PASS: 首页包含 $sel"; pass=$((pass + 1))
  else
    echo "FAIL: 首页缺少 $sel"; fail=$((fail + 1))
  fi
done

# 顶部栏布局:筛选/工具控件搬到顶栏,左栏整栏与左分栏条已移除
TOP_HTML=$(printf '%s' "$HOME_HTML" | awk '/<header id="topbar">/{f=1} f{print} /<\/header>/{if(f) exit}')
for sel in 'id="search"' 'id="dirFilter"' 'id="order"' 'id="btnNew"' 'id="refresh"' 'id="showArchived"' 'id="count"' 'id="status"'; do
  if printf '%s' "$TOP_HTML" | grep -q "$sel"; then
    echo "PASS: 顶栏包含 $sel"; pass=$((pass + 1))
  else
    echo "FAIL: 顶栏缺少 $sel"; fail=$((fail + 1))
  fi
done
if printf '%s' "$HOME_HTML" | grep -q 'id="filters"'; then
  echo "FAIL: 首页仍有左栏 #filters"; fail=$((fail + 1))
else
  echo "PASS: 左栏 #filters 已移除"; pass=$((pass + 1))
fi
if printf '%s' "$HOME_HTML" | grep -q '<aside'; then
  echo "FAIL: 首页仍有 <aside> 左栏"; fail=$((fail + 1))
else
  echo "PASS: 首页已无 <aside> 左栏"; pass=$((pass + 1))
fi
if printf '%s' "$HOME_HTML" | grep -q 'id="resizer-left"'; then
  echo "FAIL: 首页仍有左分栏条 #resizer-left"; fail=$((fail + 1))
else
  echo "PASS: 左分栏条已移除"; pass=$((pass + 1))
fi
nres=$(printf '%s' "$HOME_HTML" | grep -o 'class="resizer"' | wc -l | tr -d ' ')
ck "$nres" 1 "首页只剩 1 个分栏条(#resizer-mid)"

CSS=$(curl -s "${AUTH[@]}" "$PROXY/styles.css")
if printf '%s' "$CSS" | grep -q 'var(--list-w, 560px) 6px minmax(0, 1fr)'; then
  echo "PASS: styles.css 主区为两栏网格(--list-w)"; pass=$((pass + 1))
else
  echo "FAIL: styles.css 主区网格未改为 --list-w 两栏"; fail=$((fail + 1))
fi
if printf '%s' "$CSS" | grep -q 'var(--left-w\|var(--mid-w'; then
  echo "FAIL: styles.css 仍引用 --left-w/--mid-w"; fail=$((fail + 1))
else
  echo "PASS: styles.css 已无 --left-w/--mid-w"; pass=$((pass + 1))
fi
if printf '%s' "$CSS" | grep -q 'calc(100vh - 43px)'; then
  echo "FAIL: styles.css 主区仍是写死高度(顶栏变高会把底部输入框顶出视口)"; fail=$((fail + 1))
else
  echo "PASS: styles.css 主区不再写死高度"; pass=$((pass + 1))
fi

sse=$(timeout 3 curl -s -N "${AUTH[@]}" "$PROXY/api/event" | head -c 4000)
if printf '%s' "$sse" | grep -q 'server.connected'; then
  echo "PASS: 经代理 SSE 收到 server.connected"; pass=$((pass + 1))
else
  echo "FAIL: 经代理未收到 server.connected"; fail=$((fail + 1))
fi

echo
echo "结果: $pass 通过, $fail 失败"
[ "$fail" = 0 ]
