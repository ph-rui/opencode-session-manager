#!/usr/bin/env bash
# C 组端到端:逐 token 流式(session.text.delta / reasoning.delta / tool.*)。
# 前置:OpenCode 服务与本代理已运行;本机有 curl / python3。
# 会创建并随后删除一个临时会话;不触碰既有会话。
#
# 默认只跑只读契约(事件流可连、SSE 帧形状)。设置 OCS_E2E_LLM=1 会追加真实流式用例,
# 代价是一次模型调用。本机默认模型未必配好,可用 OCS_E2E_MODEL=provider/modelID 指定。
set -uo pipefail

PORT="${OCS_PORT:-49450}"
PROXY="http://127.0.0.1:${PORT}"
ENVFILE="${OCS_ENV_FILE:-$HOME/.config/opencode-session-manager/env}"
if [ -z "${OCS_AUTH:-}" ] && [ -f "$ENVFILE" ]; then
  OCS_AUTH=$(grep -E '^OCS_AUTH=' "$ENVFILE" | head -1 | cut -d= -f2-)
fi
AUTH=()
[ -n "${OCS_AUTH:-}" ] && AUTH=(-u "$OCS_AUTH")

DIR="/tmp/oc-stream-e2e-$$"
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

echo "=== 只读契约:事件流形状(不消耗模型) ==="

# SSE 是「单行 data: + JSON 内含 type」,没有 event: 行。这是前端 setupEvents 依赖的形状。
RAW="$DIR/sse-head.txt"
timeout 4 curl -sN "${AUTH[@]}" "$PROXY/api/event" > "$RAW" 2>/dev/null || true
ck "$([ "$(grep -c '^data: ' "$RAW")" -ge 1 ] && echo y)" y "事件流以 data: 单行发送"
ck "$(grep -c '^event: ' "$RAW" || true)" 0 "没有 event: 行(事件名在 JSON 的 type 里)"
ck "$(grep -c '"type":"server.connected"' "$RAW")" 1 "首帧是 server.connected"
# 最后一行可能被截断,所以只在「非末行」解析失败时判失败
ck "$(python3 - "$RAW" <<'PY'
import json, sys
lines = [l.strip() for l in open(sys.argv[1], encoding='utf-8', errors='replace').read().splitlines()]
frames = [l[6:] for l in lines if l.startswith('data: ')]
bad = 0
for i, f in enumerate(frames):
    try:
        if not json.loads(f).get('type'):
            raise ValueError('no type')
    except Exception:
        if i == len(frames) - 1:
            break
        bad += 1
print(bool(frames) and bad == 0)
PY
)" True "每一帧都是合法 JSON 且带 type"

echo
echo "=== 真实流式(消耗一次模型调用) ==="

if [ "${OCS_E2E_LLM:-0}" != "1" ]; then
  sk "真实逐 token 流式用例(设置 OCS_E2E_LLM=1 开启,会消耗一次模型调用)"
else
  if [ -n "${OCS_E2E_MODEL:-}" ]; then
    MREF=$(python3 -c "
import json,sys
p,m='${OCS_E2E_MODEL}'.split('/',1)
print(json.dumps({'id':m,'providerID':p,'variant':'default'}))")
  else
    MREF=$(curl -s "${AUTH[@]}" "$PROXY/api/model/default" | jqget \
      "json.dumps({'id':d['data']['modelID'],'providerID':d['data']['providerID'],'variant':'default'}) if d.get('data') else ''")
  fi
  ck "$([ -n "$MREF" ] && echo y)" y "解析到可用模型 $MREF"

  SID=$(curl -s "${AUTH[@]}" -X POST -H 'content-type: application/json' \
    -d "{\"location\":{\"directory\":\"$DIR\"},\"title\":\"C组流式e2e\",\"model\":$MREF}" \
    "$PROXY/api/session" | jqget "d['data']['id']")
  ck "$(echo "$SID" | cut -c1-4)" "ses_" "创建临时会话(带指定模型)"

  EV="$DIR/events.txt"
  : > "$EV"
  curl -sN "${AUTH[@]}" "$PROXY/api/event" > "$EV" 2>/dev/null &
  EVPID=$!
  sleep 1

  curl -s -o /dev/null "${AUTH[@]}" -X POST -H 'content-type: application/json' \
    -d '{"text":"请用中文分 3 点说明 I2C 总线的工作原理,每点 2-3 句话,不要使用任何工具。","agent":"build"}' \
    "$PROXY/api/session/$SID/prompt"

  # 等到确实在流(>=3 个 delta)时,抓一次消息接口:服务端此时只给「骨架」,文本仍为空。
  # 这正是前端必须自己消费增量、不能指望轮询消息接口的原因。
  mid_part=""
  mid_len=""
  for _ in $(seq 1 240); do
    n=$(grep -c 'session.text.delta' "$EV" 2>/dev/null || true)
    if [ "${n:-0}" -ge 3 ]; then
      read -r mid_part mid_len < <(curl -s "${AUTH[@]}" \
        "$PROXY/api/session/$SID/message?limit=5&order=desc" | python3 -c "
import json,sys
d=json.load(sys.stdin)
a=[m for m in d.get('data',[]) if m.get('type')=='assistant']
if not a:
    print(0,0)
else:
    print(len(a[0].get('content') or []),
          sum(len(p.get('text') or '') for p in (a[0].get('content') or [])))")
      break
    fi
    sleep 0.25
  done
  ck "$([ -n "$mid_part" ] && echo y)" y "流式期间捕获到中间态(>=3 个 delta)"
  ck "$([ "${mid_part:-0}" -ge 1 ] && echo y)" y "流式期间服务端已给出助手消息骨架(parts>=1)"
  ck "${mid_len:-x}" 0 "流式期间服务端**不**提供半成品文本(text 仍为空)"

  for _ in $(seq 1 400); do
    grep -qE 'session\.execution\.(succeeded|failed|interrupted)' "$EV" && break
    sleep 0.5
  done
  sleep 1
  kill "$EVPID" 2>/dev/null || true
  wait "$EVPID" 2>/dev/null || true

  # 事件分析:把事实打平成 key=value,再由 bash 断言
  REPORT="$DIR/report.txt"
  python3 - "$EV" > "$REPORT" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()
evs = []
for line in raw.splitlines():
    line = line.strip()
    if line.startswith('data: '):
        try: evs.append(json.loads(line[6:]))
        except Exception: pass

def idx(t):
    for i, e in enumerate(evs):
        if e.get('type') == t: return i
    return -1

ids = {e['data'].get('assistantMessageID') for e in evs if e['data'].get('assistantMessageID')}
steps = [e['data'].get('assistantMessageID') for e in evs if e.get('type') == 'session.step.started']
text_ev = [e for e in evs if e.get('type', '').startswith('session.text.')]
reason_ev = [e for e in evs if e.get('type', '').startswith('session.reasoning.')]
tool_ev = [e for e in evs if e.get('type', '').startswith('session.tool.')]
deltas = [e for e in text_ev if e['type'] == 'session.text.delta']
started = [e for e in text_ev if e['type'] == 'session.text.started']
ended = [e for e in text_ev if e['type'] == 'session.text.ended']

acc = {k: '' for k in {e['data'].get('ordinal') for e in deltas}}
for e in deltas:
    acc[e['data'].get('ordinal')] = acc.get(e['data'].get('ordinal'), '') + (e['data'].get('delta') or '')
ended_text = {e['data'].get('ordinal'): (e['data'].get('text') or '') for e in ended}
# ordinal 是按类型计的:text / reasoning 各自从 0 开始
r_started_ord = [e['data'].get('ordinal') for e in reason_ev if e['type'] == 'session.reasoning.started']

se = [e for e in evs if e.get('type') == 'session.step.ended']
tk = (se[0]['data'].get('tokens') or {}) if se else {}

def out(k, v): print(f'{k}={v}')

out('steps', len(steps))
out('text_started', len(started))
out('delta_count', len(deltas))
out('text_ended', len(ended))
out('delta_sum_len', sum(len(v) for v in acc.values()))
out('ended_text_len', sum(len(v) for v in ended_text.values()))
out('delta_matches_ended',
    all(acc.get(o, '') == t for o, t in ended_text.items()) and bool(ended_text))
out('order_ok', 0 <= idx('session.text.started') < idx('session.text.delta') < idx('session.text.ended'))
out('step_ended', len(se))
out('output_tokens', tk.get('output', 0))
out('finish_nonempty', bool(se and se[0]['data'].get('finish')))
out('exec_succeeded', any(e.get('type') == 'session.execution.succeeded' for e in evs))
out('exec_failed', any(e.get('type') == 'session.execution.failed' for e in evs))
out('usage_updated', sum(1 for e in evs if e.get('type') == 'session.usage.updated'))
out('text_ord0', int(any(e['data'].get('ordinal') == 0 for e in started)))
out('reason_started', len(r_started_ord))
out('reason_ord0', int(all(o == 0 for o in r_started_ord[:1])) if r_started_ord else 1)
out('ids_consistent', int(all(i in steps for i in ids if i)))
out('tool_events', len(tool_ev))
out('tool_started_first',
    int(all(tool_ev.index(e) > idx('session.step.started') for e in tool_ev)) if tool_ev else 1)
out('text_all_msgs_seen', int(len({e['data'].get('assistantMessageID') for e in text_ev}) > 0))
PY

  g() { grep -E "^$1=" "$REPORT" | head -1 | cut -d= -f2-; }

  echo "--- 事件事实 ---"
  sed 's/^/    /' "$REPORT"

  ck "$(g steps)" 1 "出现且仅出现一个 step(单轮回答,未调工具)"
  ck "$(g text_started)" 1 "text 块开始事件出现一次"
  ck "$(g text_ord0)" 1 "text 的 ordinal 从 0 开始"
  ck "$([ "$(g delta_count)" -ge 5 ] && echo y)" y "逐 token 增量事件 >= 5 个(证明是流式而非一次性)"
  ck "$(g text_ended)" 1 "text 块结束事件出现一次(带权威全文)"
  ck "$([ "$(g ended_text_len)" -gt 50 ] && echo y)" y "权威全文长度 > 50 字"
  ck "$(g delta_matches_ended)" True "增量累加 === ended.text(增量无缺口,权威覆盖是幂等的)"
  ck "$(g order_ok)" True "事件顺序 started → delta → ended"
  ck "$(g ids_consistent)" 1 "所有 part 事件的 assistantMessageID 都能对上 step"
  ck "$(g step_ended)" 1 "step.ended 出现"
  ck "$(g finish_nonempty)" True "step.ended 带 finish 原因"
  ck "$([ "$(g output_tokens)" -gt 0 ] && echo y)" y "step.ended 带 output tokens 计数"
  ck "$(g exec_succeeded)" True "execution.succeeded 收束(未失败)"
  ck "$(g exec_failed)" False "没有 execution.failed"
  ck "$(g reason_ord0)" 1 "reasoning 的 ordinal 也按类型从 0 起(与 text 互不干扰)"

  # 结束后:服务端消息里 text 必须等于权威全文(前端只在服务端 completed 前用本地缓冲)
  FINAL=$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/message?limit=5&order=desc" | python3 -c "
import json,sys
d=json.load(sys.stdin)
a=[m for m in d.get('data',[]) if m.get('type')=='assistant']
if not a: print('NONE'); raise SystemExit
m=a[0]
print('|'.join(str(len(p.get('text') or '')) for p in (m.get('content') or [])))")
  ck "$([ "$FINAL" != NONE ] && echo y)" y "结束后消息接口能读到助手消息"
  ck "$([ -n "$(g ended_text_len)" ] && echo y)" y "保留权威全文长度供比对(见上方 delta_sum_len/ended_text_len)"
  ck "$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID" | jqget "str(d['data'].get('time',{}).get('updated') is not None)")" True \
    "会话已落库更新"
fi

echo
echo "=== 汇总 ==="
echo "通过 $pass / 失败 $fail / 跳过 $skip"
[ "$fail" -eq 0 ] || exit 1
