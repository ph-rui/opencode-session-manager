#!/usr/bin/env bash
# A 组端到端:经本代理创建真实表单,再用前端完全相同的请求体应答/取消,核对状态与负例。
# 前置:OpenCode 服务与本代理已运行;本机有 curl / python3。
# 会创建并随后删除一个临时会话;不触碰既有会话。
set -uo pipefail

PORT="${OCS_PORT:-49450}"
PROXY="http://127.0.0.1:${PORT}"
ENVFILE="${OCS_ENV_FILE:-$HOME/.config/opencode-session-manager/env}"
if [ -z "${OCS_AUTH:-}" ] && [ -f "$ENVFILE" ]; then
  OCS_AUTH=$(grep -E '^OCS_AUTH=' "$ENVFILE" | head -1 | cut -d= -f2-)
fi
AUTH=()
[ -n "${OCS_AUTH:-}" ] && AUTH=(-u "$OCS_AUTH")

DIR="/tmp/oc-asks-e2e-$$"
mkdir -p "$DIR"

pass=0
fail=0
ck() { if [ "$1" = "$2" ]; then echo "PASS: $3"; pass=$((pass + 1)); else echo "FAIL: $3 (got '$1' want '$2')"; fail=$((fail + 1)); fi; }
jqget() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }

SID=""
cleanup() {
  [ -n "$SID" ] && curl -s -o /dev/null "${AUTH[@]}" -X DELETE "$PROXY/api/session/$SID"
  rm -rf "$DIR"
}
trap cleanup EXIT

SID=$(curl -s "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"location\":{\"directory\":\"$DIR\"}}" "$PROXY/api/session" | jqget "d['data']['id']")
if [ -z "$SID" ]; then
  echo "无法创建临时会话——请确认代理与 OpenCode 服务在运行。"
  exit 1
fi
echo "临时会话: $SID"

FIELDS='[
 {"key":"board","type":"multiselect","title":"目标板型","required":true,"maxItems":1,"custom":true,
  "options":[{"value":"board-a","label":"Board A"},{"value":"board-b","label":"Board B"}]},
 {"key":"steps","type":"multiselect","title":"附加步骤","maxItems":3,"custom":true,
  "options":[{"value":"uboot","label":"重建 U-Boot"},{"value":"kernel","label":"重建内核"}]},
 {"key":"hwinfo","type":"string","title":"硬件版本"},
 {"key":"timeout","type":"integer","title":"超时","default":300,"minimum":10,"maximum":600},
 {"key":"remember","type":"boolean","title":"记住","default":true},
 {"key":"extra","type":"string","title":"额外","required":true,"when":[{"key":"board","op":"eq","value":"board-b"}]},
 {"key":"auth","type":"external","title":"登录","url":"https://example.com/a"}
]'

FID="frm_e2e_$$"
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"id\":\"$FID\",\"title\":\"E2E 测试表单\",\"metadata\":{\"kind\":\"question\"},\"fields\":$FIELDS}" \
  "$PROXY/api/session/$SID/form")
ck "$code" 200 "创建表单返回 200"

# 面板兜底拉取路径:list 返回 Form.Info(不含 state)
list=$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/form")
ck "$(echo "$list" | jqget "len(d['data'])")" 1 "list 返回 1 个待处理表单"
ck "$(echo "$list" | jqget "'state' in [x for x in d['data'] if x['id']=='$FID'][0]")" False "list 项不含 state"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/form/$FID" | jqget "d['data']['state']['status']")" pending "detail 中 state.status=pending"

# 负例:提交 when 未激活字段(前端会省略)→ 服务端必须拒绝
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d '{"answer":{"board":["board-a"],"auth":true,"extra":"不该出现"}}' \
  "$PROXY/api/session/$SID/form/$FID/reply")
ck "$code" 400 "提交未激活字段 → 400"

# 负例:external 未确认为 true
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d '{"answer":{"board":["board-a"]}}' "$PROXY/api/session/$SID/form/$FID/reply")
ck "$code" 400 "external 未确认 → 400"

# 正例:前端 collectFormAnswer 的真实产物
ANSWER='{"board":["board-a"],"timeout":300,"remember":true,"auth":true}'
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"answer\":$ANSWER}" "$PROXY/api/session/$SID/form/$FID/reply")
ck "$code" 204 "应答提交返回 204"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/form/$FID" | jqget "d['data']['state']['status']")" answered "应答后 state.status=answered"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/form/$FID" | jqget "json.dumps(d['data']['state'].get('answer'),ensure_ascii=False,sort_keys=True)")" \
  "$(python3 -c "import json;print(json.dumps(json.loads('$ANSWER'),ensure_ascii=False,sort_keys=True))")" \
  "服务端保存的答案与提交一致"
ck "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"answer\":$ANSWER}" "$PROXY/api/session/$SID/form/$FID/reply")" 409 "重复应答已处理表单 → 409(前端据此静默收敛卡片)"

# 取消路径
FID2="frm_e2e_c_$$"
curl -s -o /dev/null "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"id\":\"$FID2\",\"title\":\"待取消\",\"metadata\":{\"kind\":\"question\"},\"fields\":[{\"key\":\"a\",\"type\":\"string\",\"title\":\"A\",\"required\":true}]}" \
  "$PROXY/api/session/$SID/form"
code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X DELETE \
  "$PROXY/api/session/$SID/form/$FID2?message=$(enc '用户在面板取消')")
ck "$code" 204 "取消表单返回 204"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/form/$FID2" | jqget "d['data']['state']['status']")" cancelled "取消后 state.status=cancelled"

# 权限应答路由经代理可达(不存在的请求 → 404,证明路由与 body 透传正确)
ck "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d '{"decision":"once"}' "$PROXY/api/session/$SID/permission/per_nonexistent/reply")" 404 "权限应答(不存在)→ 404"

echo
echo "结果: $pass 通过, $fail 失败"
[ "$fail" -eq 0 ]
