#!/usr/bin/env bash
# B 组端到端:会话控制(运行状态 / 中断 / 投递方式 steer·queue / 切换 model·agent)。
# 前置:OpenCode 服务与本代理已运行;本机有 curl / python3。
# 会创建并随后删除一个临时会话;不触碰既有会话。
#
# 默认只跑不消耗模型的路径。设置 OCS_E2E_LLM=1 会追加「真实运行中队列/中断」用例,
# 代价是一次很小的模型调用(约 10 秒),用于验证 queue / steer / interrupt 的真实语义。
set -uo pipefail

PORT="${OCS_PORT:-49450}"
PROXY="http://127.0.0.1:${PORT}"
ENVFILE="${OCS_ENV_FILE:-$HOME/.config/opencode-session-manager/env}"
if [ -z "${OCS_AUTH:-}" ] && [ -f "$ENVFILE" ]; then
  OCS_AUTH=$(grep -E '^OCS_AUTH=' "$ENVFILE" | head -1 | cut -d= -f2-)
fi
AUTH=()
[ -n "${OCS_AUTH:-}" ] && AUTH=(-u "$OCS_AUTH")

DIR="/tmp/oc-controls-e2e-$$"
mkdir -p "$DIR"

pass=0
fail=0
skip=0
ck() { if [ "$1" = "$2" ]; then echo "PASS: $3"; pass=$((pass + 1)); else echo "FAIL: $3 (got '$1' want '$2')"; fail=$((fail + 1)); fi; }
sk() { echo "SKIP: $1"; skip=$((skip + 1)); }
jqget() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
code() { curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$@"; }

SID=""
cleanup() {
  [ -n "$SID" ] && curl -s -o /dev/null "${AUTH[@]}" -X POST "$PROXY/api/session/$SID/interrupt"
  [ -n "$SID" ] && curl -s -o /dev/null "${AUTH[@]}" -X DELETE "$PROXY/api/session/$SID"
  rm -rf "$DIR"
}
trap cleanup EXIT

echo "=== 只读契约(不消耗模型) ==="

active=$(curl -s "${AUTH[@]}" "$PROXY/api/session/active")
ck "$(echo "$active" | jqget "isinstance(d.get('data'),dict)")" True "session/active 返回 data 对象"

agents=$(curl -s "${AUTH[@]}" "$PROXY/api/agent")
ck "$(echo "$agents" | jqget "'build' in [a['id'] for a in d['data']]")" True "agent 列表包含 build"
# 前端过滤规则:mode != subagent 且未隐藏
ck "$(echo "$agents" | jqget "len([a for a in d['data'] if a.get('mode')!='subagent' and not a.get('hidden')])>0")" True \
  "存在可作为主智能体选择的 agent"

models=$(curl -s "${AUTH[@]}" "$PROXY/api/model")
ck "$(echo "$models" | jqget "len([m for m in d['data'] if m.get('enabled')])>0")" True "存在 enabled 的模型"
ck "$(echo "$models" | jqget "all('providerID' in m and 'modelID' in m and 'variants' in m for m in d['data'])")" True \
  "模型条目含 providerID / modelID / variants"

dflt=$(curl -s "${AUTH[@]}" "$PROXY/api/model/default")
ck "$(echo "$dflt" | jqget "bool(d.get('data') and d['data'].get('providerID') and d['data'].get('modelID'))")" True \
  "model/default 返回可用的默认模型"

SID=$(curl -s "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"location\":{\"directory\":\"$DIR\"}}" "$PROXY/api/session" | jqget "d['data']['id']")
if [ -z "$SID" ]; then
  echo "无法创建临时会话——请确认代理与 OpenCode 服务在运行。"
  exit 1
fi
echo "临时会话: $SID"

INBOX=$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/inbox")
ck "$(echo "$INBOX" | jqget "isinstance(d.get('data'),list)")" True "inbox 返回 data 数组"
ck "$(echo "$INBOX" | jqget "len(d['data'])")" 0 "新会话 inbox 为空"
echo

echo "=== 切换 session 的 agent / model ==="

ck "$(code -X POST -H 'content-type: application/json' -d '{"agent":"plan"}' "$PROXY/api/session/$SID/agent")" 204 \
  "切换 agent → 204"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID" | jqget "d['data']['agent']")" plan "agent 已持久化为 plan"
# 切到 plan 时服务端可能立刻投递一条 synthetic 系统提醒(是否驻留在队列取决于时机);
# 关键契约:前端按 type 过滤,不把 synthetic 当作可操作的待发送消息。
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/inbox" \
  | jqget "len([i for i in d['data'] if i['type']!='synthetic'])")" 0 "过滤 synthetic 后无可展示项(前端 renderInbox)"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/inbox" \
  | jqget "all(i['type'] in ('user','synthetic','compaction','move') for i in d['data'])")" True \
  "inbox 条目类型都在前端已知集合内"

ck "$(code -X POST -H 'content-type: application/json' -d '{"agent":"build"}' "$PROXY/api/session/$SID/agent")" 204 \
  "切回 build → 204"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID" | jqget "d['data']['agent']")" build "agent 已持久化为 build"

ck "$(code -X POST -H 'content-type: application/json' \
  -d '{"model":{"id":"nope"}}' "$PROXY/api/session/$SID/model")" 400 \
  "model 缺少 providerID → 400(前端据此回滚选择)"

# 用默认模型做一次真实切换(与前端 switchModel 组装的 Model.Ref 一致)
MREF=$(echo "$dflt" | jqget "json.dumps({'id':d['data']['modelID'],'providerID':d['data']['providerID'],'variant':'default'})")
ck "$(code -X POST -H 'content-type: application/json' -d "{\"model\":$MREF}" "$PROXY/api/session/$SID/model")" 204 \
  "切换 model → 204"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID" | jqget "d['data']['model'] and (d['data']['model']['providerID']+'/'+d['data']['model']['id'])")" \
  "$(echo "$dflt" | jqget "d['data']['providerID']+'/'+d['data']['modelID']")" "model 已持久化"

echo
echo "=== 中断 / 队列路由 ==="

ck "$(curl -s "${AUTH[@]}" -X POST "$PROXY/api/session/$SID/interrupt" | jqget "d.get('interrupted')")" False \
  "空闲会话中断返回 interrupted=false"
ck "$(code -X POST "$PROXY/api/session/ses_nope/interrupt")" 404 "中断不存在的会话 → 404"
ck "$(code "$PROXY/api/session/ses_nope/inbox")" 404 "不存在的会话拉取 inbox → 404"

# 前端在运行中发消息时使用的请求体形状(delivery 枚举)
ck "$(code -X PATCH -H 'content-type: application/json' -d '{"delivery":"steer"}' "$PROXY/api/session/$SID/inbox/msg_nope")" 409 \
  "修改不存在的待发送项 → 409(前端据此提示并重取)"
ck "$(code -X DELETE "$PROXY/api/session/$SID/inbox/msg_nope")" 204 "取消不存在的待发送项 → 204(幂等)"

echo
echo "=== 运行中:queue / steer / interrupt ==="

if [ "${OCS_E2E_LLM:-0}" != "1" ]; then
  sk "真实运行中队列/中断用例(设置 OCS_E2E_LLM=1 开启,会消耗一次很小的模型调用)"
else
  curl -s -o /dev/null "${AUTH[@]}" -X POST -H 'content-type: application/json' \
    -d '{"text":"Run the bash tool with exactly this command and nothing else: sleep 12; echo READY","agent":"build"}' \
    "$PROXY/api/session/$SID/prompt" -w ''

  running=""
  for _ in $(seq 1 40); do
    running=$(curl -s "${AUTH[@]}" "$PROXY/api/session/active" | jqget "d['data'].get('$SID',{}).get('type','')")
    [ -n "$running" ] && break
    sleep 0.5
  done
  ck "${running:-}" running "会话进入运行中(active)"

  if [ -n "$running" ]; then
    Q=$(curl -s "${AUTH[@]}" -X POST -H 'content-type: application/json' \
      -d '{"text":"queue probe","delivery":"queue"}' "$PROXY/api/session/$SID/prompt")
    QID=$(echo "$Q" | jqget "d['data']['id']")
    ck "$(echo "$Q" | jqget "d['data']['delivery']")" queue "queue 投递的消息标记为 queue"

    ib=$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/inbox")
    ck "$(echo "$ib" | jqget "len([i for i in d['data'] if i['id']=='$QID'])")" 1 "待发送队列中可见该条"

    ck "$(code -X PATCH -H 'content-type: application/json' -d '{"delivery":"steer"}' "$PROXY/api/session/$SID/inbox/$QID")" 204 \
      "把待发送项改为插话 → 204"
    ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/inbox" | jqget "[i for i in d['data'] if i['id']=='$QID'][0]['delivery']")" \
      steer "投递方式已变为 steer"

    ck "$(code -X DELETE "$PROXY/api/session/$SID/inbox/$QID")" 204 "取消待发送项 → 204"
    ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/inbox" | jqget "len([i for i in d['data'] if i['id']=='$QID'])")" 0 \
      "取消后该条从队列消失"

    ck "$(curl -s "${AUTH[@]}" -X POST "$PROXY/api/session/$SID/interrupt" | jqget "d.get('interrupted')")" True \
      "运行中中断返回 interrupted=true"

    idle=""
    for _ in $(seq 1 40); do
      idle=$(curl -s "${AUTH[@]}" "$PROXY/api/session/active" | jqget "'$SID' not in d['data']")
      [ "$idle" = "True" ] && break
      sleep 0.5
    done
    ck "$idle" True "中断后会话回到空闲"
  fi
fi

echo
echo "结果: $pass 通过, $fail 失败, $skip 跳过"
[ "$fail" -eq 0 ]
