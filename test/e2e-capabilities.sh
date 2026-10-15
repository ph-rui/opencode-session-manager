#!/usr/bin/env bash
# D 组端到端:能力扩展(网页内新建会话 / 归档 / 导入导出)。
# 前置:OpenCode 服务与本代理已运行;本机有 curl / python3。
# 会创建并随后删除临时会话;不触碰既有会话。
# 说明:OpenCode v2.0.28 没有会话归档接口(Session.Info 虽带 time.archived,但只有 project 能写),
#       因此「归档」由本面板写在 session.metadata 下,这里验证该写法的可行性与 PATCH 的整体替换语义。
set -uo pipefail

PORT="${OCS_PORT:-49450}"
PROXY="http://127.0.0.1:${PORT}"
ENVFILE="${OCS_ENV_FILE:-$HOME/.config/opencode-session-manager/env}"
if [ -z "${OCS_AUTH:-}" ] && [ -f "$ENVFILE" ]; then
  OCS_AUTH=$(grep -E '^OCS_AUTH=' "$ENVFILE" | head -1 | cut -d= -f2-)
fi
AUTH=()
[ -n "${OCS_AUTH:-}" ] && AUTH=(-u "$OCS_AUTH")

DIR="/tmp/oc-cap-a-$$"
DIR2="/tmp/oc-cap-b-$$"
mkdir -p "$DIR" "$DIR2"

pass=0
fail=0
ck() { if [ "$1" = "$2" ]; then echo "PASS: $3"; pass=$((pass + 1)); else echo "FAIL: $3 (got '$1' want '$2')"; fail=$((fail + 1)); fi; }
jqget() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
code() { curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$@"; }
post() { curl -s "${AUTH[@]}" -X POST -H 'content-type: application/json' -d "$2" "$PROXY$1"; }

SID=""
ISID=""
cleanup() {
  [ -n "$SID" ] && curl -s -o /dev/null "${AUTH[@]}" -X DELETE "$PROXY/api/session/$SID"
  [ -n "$ISID" ] && curl -s -o /dev/null "${AUTH[@]}" -X DELETE "$PROXY/api/session/$ISID"
  rm -rf "$DIR" "$DIR2"
}
trap cleanup EXIT

echo "=== 新建会话(POST /api/session) ==="

NEW=$(post /api/session "{\"location\":{\"directory\":\"$DIR\"},\"title\":\"D 组新建探测\",\"agent\":\"build\",\"model\":{\"id\":\"deepseek-v4-flash\",\"providerID\":\"company\",\"variant\":\"default\"}}")
SID=$(echo "$NEW" | jqget "d['data']['id']")
ck "$(echo "$NEW" | jqget "bool(d.get('data') and d['data'].get('id'))")" True "新建返回 data.id"
ck "$(echo "$NEW" | jqget "d['data']['title']")" "D 组新建探测" "标题按传入值保存"
ck "$(echo "$NEW" | jqget "d['data']['agent']")" build "智能体按传入值保存"
ck "$(echo "$NEW" | jqget "d['data']['model'] and d['data']['model']['providerID']+'/'+d['data']['model']['id']")" \
  "company/deepseek-v4-flash" "模型按传入值保存"
ck "$(echo "$NEW" | jqget "d['data']['location']['directory']")" "$DIR" "工程目录按传入值保存"
ck "$(echo "$NEW" | jqget "d['data']['time']['created']>0")" True "返回 time.created"

# 前端列表依赖列表接口里带 metadata 才能做面板归档(未设置时该键会整体省略)
ck "$(code -X POST -H 'content-type: application/json' -d '{"location":{}}' "$PROXY/api/session")" 400 \
  "POST /api/session 非法 location → 400"

echo
echo "=== 归档(面板级:session.metadata) ==="

ck "$(code -X PATCH -H 'content-type: application/json' \
  -d '{"metadata":{"ocs":{"archived":1792000000000}}}' "$PROXY/api/session/$SID")" 204 "写入归档标记 → 204"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID" | jqget "d['data']['metadata']['ocs']['archived']")" \
  1792000000000 "归档标记可读回"
# 列表接口也会带上 metadata,面板据此过滤
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session?limit=50" \
  | jqget "[s for s in d['data'] if s['id']=='$SID'][0].get('metadata',{}).get('ocs',{}).get('archived')")" \
  1792000000000 "列表接口的会话对象含 metadata(面板据此过滤归档)"

# 关键语义:PATCH metadata 是整体替换,不是深合并 → 前端必须读-改-写
ck "$(code -X PATCH -H 'content-type: application/json' -d '{"metadata":{"other":1}}' "$PROXY/api/session/$SID")" 204 \
  "改 metadata → 204"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID" | jqget "json.dumps(d['data'].get('metadata'),sort_keys=True)")" \
  '{"other": 1}' "PATCH metadata 为整体替换(归档标记被覆盖,需前端读-改-写)"

ck "$(code -X PATCH -H 'content-type: application/json' -d '{"metadata":{}}' "$PROXY/api/session/$SID")" 204 \
  "清空 metadata → 204"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID" | jqget "d['data'].get('metadata') is None or d['data'].get('metadata')=={}")" \
  True "取消归档后 metadata 为空"

echo
echo "=== 导出(GET /api/experimental/session/:id/export) ==="

curl -s "${AUTH[@]}" "$PROXY/api/experimental/session/$SID/export?sanitize=false" > /tmp/oc-cap-raw-$$.json
curl -s "${AUTH[@]}" "$PROXY/api/experimental/session/$SID/export?sanitize=true" > /tmp/oc-cap-san-$$.json

ck "$(jqget "isinstance(d['data'].get('messages'),list)" < /tmp/oc-cap-raw-$$.json)" True "导出含 messages 数组"
ck "$(jqget "d['data']['info']['title']" < /tmp/oc-cap-raw-$$.json)" "D 组新建探测" "sanitize=false 保留标题"
ck "$(jqget "'redacted' in d['data']['info']['title']" < /tmp/oc-cap-san-$$.json)" True "sanitize=true 标题已脱敏"
ck "$(code "$PROXY/api/experimental/session/ses_nope/export?sanitize=true")" 404 "导出不存在的会话 → 404"

echo
echo "=== 导入(POST /api/experimental/session/import) ==="

# 客户端应把导出文件解包成 {info, messages},并换一个新 ID(服务端对同 ID 返回 409)
python3 - "$SID" "$DIR2" "$$" <<'EOF'
import json, random, sys, string
sid, dir2, pid = sys.argv[1], sys.argv[2], sys.argv[3]
raw = json.load(open('/tmp/oc-cap-raw-%s.json' % pid))
data = raw['data']
alpha = string.ascii_lowercase + string.digits
newid = 'ses_' + ''.join(random.choice(alpha) for _ in range(24))
# 1) 原样(未解包)提交 → 服务端要求顶层 info
json.dump(raw, open('/tmp/oc-cap-imp-wrapped-%s.json' % pid, 'w'))
# 2) 解包 + 换 ID + 指定目标目录
info = dict(data['info']); info['id'] = newid
json.dump({'info': info, 'messages': data['messages'], 'location': {'directory': dir2}},
          open('/tmp/oc-cap-imp-%s.json' % pid, 'w'))
# 3) 同 ID 再导一次(应 409)
json.dump({'info': dict(data['info']), 'messages': data['messages'], 'location': {'directory': dir2}},
          open('/tmp/oc-cap-imp-sameid-%s.json' % pid, 'w'))
# 4) 缺 projectID(应 400)
info2 = dict(data['info']); info2['id'] = newid + 'x'; info2.pop('projectID', None)
json.dump({'info': info2, 'messages': data['messages']}, open('/tmp/oc-cap-imp-noprj-%s.json' % pid, 'w'))
print(newid)
EOF

ck "$(code -X POST -H 'content-type: application/json' -d @/tmp/oc-cap-imp-wrapped-$$.json \
  "$PROXY/api/experimental/session/import")" 400 \
  "提交未解包的导出文件(顶层缺 info)→ 400(前端必须解包 .data)"

IMP=$(curl -s "${AUTH[@]}" -X POST -H 'content-type: application/json' -d @/tmp/oc-cap-imp-$$.json \
  "$PROXY/api/experimental/session/import")
ISID=$(echo "$IMP" | jqget "d['data']['id']")
ck "$(echo "$IMP" | jqget "bool(d.get('data') and d['data'].get('id'))")" True "导入返回新会话"
ck "$(echo "$IMP" | jqget "d['data']['location']['directory']")" "$DIR2" "导入可用 location 指定新工程目录"
ck "$(echo "$IMP" | jqget "d['data']['title']")" "D 组新建探测" "导入保留标题"
ck "$(echo "$IMP" | jqget "d['data']['id'] != '$SID'")" True "导入使用新 ID"

ck "$(code -X POST -H 'content-type: application/json' -d @/tmp/oc-cap-imp-sameid-$$.json \
  "$PROXY/api/experimental/session/import")" 409 "同 ID 重复导入 → 409(前端据此换 ID 重试)"

ck "$(code -X POST -H 'content-type: application/json' -d @/tmp/oc-cap-imp-noprj-$$.json \
  "$PROXY/api/experimental/session/import")" 400 "缺 info.projectID → 400"

# 导入后的会话应出现在列表里,并带 messages
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$ISID/message?limit=10" | jqget "isinstance(d.get('data'),list)")" True \
  "导入的会话可读取消息"

rm -f /tmp/oc-cap-raw-$$.json /tmp/oc-cap-san-$$.json /tmp/oc-cap-imp-$$.json \
  /tmp/oc-cap-imp-wrapped-$$.json /tmp/oc-cap-imp-sameid-$$.json /tmp/oc-cap-imp-noprj-$$.json

echo
echo "结果: $pass 通过, $fail 失败"
[ "$fail" -eq 0 ]
