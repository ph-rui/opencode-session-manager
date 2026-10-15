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

sse=$(timeout 3 curl -s -N "${AUTH[@]}" "$PROXY/api/event" | head -c 4000)
if printf '%s' "$sse" | grep -q 'server.connected'; then
  echo "PASS: 经代理 SSE 收到 server.connected"; pass=$((pass + 1))
else
  echo "FAIL: 经代理未收到 server.connected"; fail=$((fail + 1))
fi

echo
echo "结果: $pass 通过, $fail 失败"
[ "$fail" = 0 ]
