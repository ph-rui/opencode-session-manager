#!/usr/bin/env bash
# I 组端到端:斜杠命令面板依赖的服务端契约。
#
# 前置:OpenCode 服务与本代理都已运行(与 e2e-attach.sh 相同);本机有 curl / python3。
# 会创建并随后删除临时会话与临时工程目录;不触碰既有会话。
#
# 为什么这么验:面板的 / 面板只做两件事 —— 列命令(GET /api/command)和跑命令
# (POST /api/session/:sid/command)。所以这里只钉这两条接口的真实行为:
#   1. GET  /api/command?location[directory]=  → 命令随工程走,内置 init/review 永远在
#   2. POST /command  name 不存在 → 404 CommandNotFoundError
#   3. POST /command  缺 text     → 400 InvalidRequestError(所以前端必须带 text:'')
#   4. POST /command  真命令      → 204,并落成一条普通用户提示词(模板展开由服务端做)
#   5. 面板动作类命令对应的端点:compact / revert(stage|DELETE) 存在,且忙时回 409
set -uo pipefail

PORT="${OCS_PORT:-49450}"
PROXY="http://127.0.0.1:${PORT}"
ENVFILE="${OCS_ENV_FILE:-$HOME/.config/opencode-session-manager/env}"
if [ -z "${OCS_AUTH:-}" ] && [ -f "$ENVFILE" ]; then
  OCS_AUTH=$(grep -E '^OCS_AUTH=' "$ENVFILE" | head -1 | cut -d= -f2-)
fi
AUTH=()
[ -n "${OCS_AUTH:-}" ] && AUTH=(-u "$OCS_AUTH")

pass=0
fail=0
ck() { if [ "$1" = "$2" ]; then echo "PASS: $3"; pass=$((pass + 1)); else echo "FAIL: $3 (got '$1' want '$2')"; fail=$((fail + 1)); fi; }
has() { if grep -qF -- "$2" "$1"; then echo "PASS: $3"; pass=$((pass + 1)); else echo "FAIL: $3 (在 $1 里没找到 '$2')"; fail=$((fail + 1)); fi; }
jqget() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
code() { curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$@"; }
codebody() { curl -s -o "$1" -w '%{http_code}' "${AUTH[@]}" "${@:2}"; }
urlenc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }

DIR="/tmp/oc-commands-e2e-$$"
mkdir -p "$DIR/.opencode/commands"
printf '说 $ARGUMENTS 好\n' > "$DIR/.opencode/commands/hello.md"
SID=""
cleanup() {
  [ -n "$SID" ] && curl -s -o /dev/null "${AUTH[@]}" -X DELETE "$PROXY/api/session/$SID"
  rm -rf "$DIR"
}
trap cleanup EXIT

msgs() { curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/message?order=desc&limit=50"; }
last_user_text() {
  msgs | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d.get('data',[]):
    if m.get('type')=='user':
        print(m.get('text') or ''); break
"
}

echo "== 0) 命令列表契约(面板 / 面板的数据源) =="
LQ="$PROXY/api/command?location%5Bdirectory%5D=$(urlenc "$DIR")"
# 全新的工程目录第一次查询可能还是空表(命令注册表按 location 惰性建立),先等它热起来
L=$(curl -s "${AUTH[@]}" "$LQ")
i=0
while [ "$i" -lt 15 ] && [ "$(echo "$L" | jqget "len(d.get('data',[]))")" = "0" ]; do
  i=$((i + 1)); sleep 1; L=$(curl -s "${AUTH[@]}" "$LQ")
done
ck "$([ "$i" -lt 15 ] && echo yes || echo no)" "yes" "新工程目录的命令表会被建立起来(等了 ${i}s)"
ck "$(echo "$L" | jqget "d.get('location',{}).get('directory')")" "$DIR" "GET /api/command 回显查询用的工程目录"
ck "$(echo "$L" | jqget "isinstance(d.get('data'),list)")" "True" "命令列表是数组"
NAMES=$(echo "$L" | jqget "[c['name'] for c in d.get('data',[])]")
case "$NAMES" in *"'init'"*) ck 1 1 "内置命令 init 在列表里";; *) ck 0 1 "内置命令 init 在列表里($NAMES)";; esac
case "$NAMES" in *"'review'"*) ck 1 1 "内置命令 review 在列表里";; *) ck 0 1 "内置命令 review 在列表里($NAMES)";; esac
ck "$(echo "$L" | jqget "all('name' in c for c in d.get('data',[]))")" "True" "每条命令都有 name(前端据此拼 /name)"
NOLOC=$(curl -s "${AUTH[@]}" "$PROXY/api/command")
ck "$(echo "$NOLOC" | jqget "isinstance(d.get('data'),list)")" "True" "不带 location 也能列出命令(不报错)"
ck "$(echo "$NOLOC" | jqget "'init' in [c['name'] for c in d.get('data',[])]")" "True" "内置命令与工程无关(默认目录下也在)"

echo
echo "== 1) 自定义命令随工程走(面板列命令时必须带 location) =="
HELLO=0
i=0
while [ "$i" -lt 20 ]; do
  case "$(curl -s "${AUTH[@]}" "$LQ" | jqget "[c['name'] for c in d.get('data',[])]")" in
    *"'hello'"*) HELLO=1; break;;
  esac
  i=$((i + 1)); sleep 1
done
ck "$HELLO" "1" "工程内 .opencode/commands/hello.md 出现在该工程的命令列表里(等了 ${i}s)"
ck "$(curl -s "${AUTH[@]}" "$PROXY/api/command?location%5Bdirectory%5D=$(urlenc /tmp)" | jqget "'hello' in [c['name'] for c in d.get('data',[])]")" "False" \
  "换个工程就看不到它 —— 命令确实随 location 走"

echo
echo "== 2) 建临时会话(指定模型,避免默认模型挂住) =="
NEW=$(curl -s "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"location\":{\"directory\":\"$DIR\"},\"title\":\"命令 e2e\",\"agent\":\"build\",\"model\":{\"id\":\"deepseek-v4-flash\",\"providerID\":\"company\",\"variant\":\"default\"}}" \
  "$PROXY/api/session")
SID=$(echo "$NEW" | jqget "d['data']['id']")
if [ -n "$SID" ]; then echo "PASS: 建了临时会话($SID)"; pass=$((pass + 1)); else echo "FAIL: 建会话失败"; fail=$((fail + 1)); exit 1; fi
N0=$(msgs | jqget "len(d.get('data',[]))")

echo
echo "== 3) 未知命令:404,且不留任何消息 =="
C=$(codebody /tmp/oc-e2e-cmd-err.json -X POST -H 'content-type: application/json' \
  -d '{"name":"definitely_not_a_command","text":"x"}' "$PROXY/api/session/$SID/command")
ck "$C" "404" "未知命令回 404"
ck "$(jqget "d.get('_tag')" < /tmp/oc-e2e-cmd-err.json)" "CommandNotFoundError" "错误类型是 CommandNotFoundError"
ck "$(msgs | jqget "len(d.get('data',[]))")" "$N0" "未知命令不会落任何消息(前端不会看到莫名其妙的回合)"

echo
echo "== 4) 缺 text:400(所以前端发命令一律带上 text) =="
C=$(codebody /tmp/oc-e2e-cmd-miss.json -X POST -H 'content-type: application/json' \
  -d '{"name":"hello"}' "$PROXY/api/session/$SID/command")
ck "$C" "400" "缺 text 回 400"
ck "$(jqget "d.get('_tag')" < /tmp/oc-e2e-cmd-miss.json)" "InvalidRequestError" "错误类型是 InvalidRequestError"
has /tmp/oc-e2e-cmd-miss.json 'text' "报错指明缺的是 text"
ck "$(msgs | jqget "len(d.get('data',[]))")" "$N0" "400 同样不会落消息"

echo
echo "== 5) 真命令:204 + 展开成一条普通用户提示词(面板走的就是这条路) =="
ck "$(code -X POST -H 'content-type: application/json' \
      -d '{"name":"hello","text":"世界"}' "$PROXY/api/session/$SID/command")" "204" \
  "POST /command 接受命令并回 204(无响应体)"
OK=0
i=0
while [ "$i" -lt 15 ]; do
  case "$(last_user_text)" in '说 世界 好') OK=1; break;; esac
  i=$((i + 1)); sleep 1
done
ck "$OK" "1" "命令模板被展开并落成用户提示词(等了 ${i}s)"
ck "$(msgs | jqget "len(d.get('data',[]))")" "$((N0 + 1))" "只多出这一条消息"

echo
echo "== 6) 面板动作类命令对应的端点 =="
CK=$(curl -s -o /tmp/oc-e2e-compact.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d '{}' "$PROXY/api/session/$SID/compact")
ck "$CK" "200" "POST /compact 可用(面板 /compact)"
ck "$(jqget "d['data']['type']" < /tmp/oc-e2e-compact.json)" "compaction" "compact 返回一条 compaction 记录"
MID=$(msgs | jqget "next((m['id'] for m in d.get('data',[]) if m.get('type')=='user'), '')")
if [ -n "$MID" ]; then echo "PASS: 取到用户消息 ID($MID)"; pass=$((pass + 1)); else echo "FAIL: 取不到用户消息 ID"; fail=$((fail + 1)); fi
RC=$(code -X POST -H 'content-type: application/json' -d "{\"messageID\":\"$MID\",\"files\":true}" \
  "$PROXY/api/session/$SID/revert/stage")
if [ "$RC" = "200" ] || [ "$RC" = "204" ]; then
  echo "PASS: POST /revert/stage 可用(面板 /undo,回合已结束时回 $RC)"; pass=$((pass + 1))
elif [ "$RC" = "409" ]; then
  echo "PASS: POST /revert/stage 在会话忙时回 409 SessionBusyError(面板据此提示「正在运行」)"; pass=$((pass + 1))
else
  echo "FAIL: POST /revert/stage 意外返回 $RC"; fail=$((fail + 1))
fi
curl -s -o /dev/null "${AUTH[@]}" -X DELETE "$PROXY/api/session/$SID/revert"
RC=$(code -X DELETE "$PROXY/api/session/$SID/revert")
if [ "$RC" = "200" ] || [ "$RC" = "204" ]; then
  echo "PASS: DELETE /revert 可用(面板 /redo,无暂存时回 $RC)"; pass=$((pass + 1))
elif [ "$RC" = "409" ]; then
  echo "PASS: DELETE /revert 在会话忙时回 409(面板按「没有可重做的撤销」处理)"; pass=$((pass + 1))
else
  echo "FAIL: DELETE /revert 意外返回 $RC"; fail=$((fail + 1))
fi

echo
echo "== 7) 前端资源确实带上了命令面板与 TUI 键位(静态文件按请求读取) =="
AJ="$DIR/app.js"; ST="$DIR/styles.css"; IX="$DIR/index.html"
curl -s "${AUTH[@]}" "$PROXY/app.js" -o "$AJ"
curl -s "${AUTH[@]}" "$PROXY/styles.css" -o "$ST"
curl -s "${AUTH[@]}" "$PROXY/" -o "$IX"
has "$AJ" "function cmdQuery" "前端有行首 /token 解析"
has "$AJ" "function openCommands" "前端会打开命令面板"
has "$AJ" "function acceptCommand" "前端能把命令补进输入框"
has "$AJ" "function parseCommand" "前端会识别「发出去的是命令」"
has "$AJ" "function runCommand" "前端有命令执行通道"
has "$AJ" "/command" "命令走 /command 接口"
has "$AJ" "function setupTuiKeys" "前端有全局 TUI 键位"
has "$AJ" "function historyKey" "前端有输入历史(↑/↓)"
has "$AJ" "function cycleAgent" "前端有 Shift+Tab 切智能体"
has "$AJ" "PANEL_COMMANDS" "面板动作类命令表在前端"
has "$ST" "#cmds" "命令面板有样式"
has "$ST" ".cmd-tag" "命令项有「面板」小标签样式"
has "$IX" "id=\"cmds\"" "输入区上方有命令面板容器"
has "$IX" "id=\"dlgHelp\"" "有 /help 的快捷键对话框"

echo
echo "结果: $pass 通过, $fail 失败"
[ "$fail" -eq 0 ]
