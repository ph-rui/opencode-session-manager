#!/usr/bin/env bash
# H 组 6 端到端:文件附件(上传落盘 / @ 引用 / 落库形状 / 拒绝非法 uri)。
#
# 前置:OpenCode 服务与本代理都已运行(与 e2e-capabilities.sh 相同);本机有 curl / python3。
# 会创建并随后删除临时会话,写入并删除临时文件;不触碰既有会话。
#
# 这里刻意不去验证「模型确实读到了文件」—— 那是模型侧的事;要验的是面板依赖的服务端契约:
#   1. POST /api/experimental/fs/write?path=<绝对路径>  原始字节写盘(浏览器上传走这条)
#   2. GET  /api/fs/find?query=&location[directory]=    给 @ 补全用的相对路径
#   3. POST /api/session/:sid/prompt  files[].uri 只认 file: URI,服务端自己读文件并补 data/mime
#   4. 裸路径 / 相对路径 / https 一律 400(所以前端只在「补全确认过」时才生成附件)
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
urlenc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }

DIR="/tmp/oc-attach-e2e-$$"
mkdir -p "$DIR"
SID=""
cleanup() {
  [ -n "$SID" ] && curl -s -o /dev/null "${AUTH[@]}" -X DELETE "$PROXY/api/session/$SID"
  rm -rf "$DIR"
}
trap cleanup EXIT

echo "== 0) 面板与附件暂存目录 =="
H=$(curl -s "${AUTH[@]}" "$PROXY/__health")
ck "$(echo "$H" | jqget "d.get('ok')")" "True" "/__health 报告服务可用"
UP=$(echo "$H" | jqget "d.get('uploadDir') or ''")
if [ -n "$UP" ]; then echo "PASS: /__health 给出附件暂存目录($UP)"; pass=$((pass + 1)); else echo "FAIL: /__health 没有 uploadDir"; fail=$((fail + 1)); fi
if [ -d "$UP" ]; then echo "PASS: 暂存目录已被代理建好"; pass=$((pass + 1)); else echo "FAIL: 暂存目录不存在:$UP"; fail=$((fail + 1)); fi

echo
echo "== 1) 浏览器上传走的是 OpenCode 自己的 fs/write(代理零改动) =="
printf 'hello from panel\nline2\n' > "$DIR/src.txt"
DEST="$UP/e2e-$$-hello.txt"
ck "$(code -X POST --data-binary @"$DIR/src.txt" -H 'content-type: application/octet-stream' \
      "$PROXY/api/experimental/fs/write?path=$(urlenc "$DEST")")" "200" "fs/write 接受原始字节(POST)"
W=$(curl -s "${AUTH[@]}" -X POST --data-binary @"$DIR/src.txt" -H 'content-type: application/octet-stream' \
      "$PROXY/api/experimental/fs/write?path=$(urlenc "$DEST")")
ck "$(echo "$W" | jqget "d['data']['path']")" "$DEST" "fs/write 回显绝对落盘路径(正是前端要拿来当 uri 的)"
if [ -f "$DEST" ] && cmp -s "$DIR/src.txt" "$DEST"; then
  echo "PASS: 落盘内容与上传字节逐字节一致"; pass=$((pass + 1))
else
  echo "FAIL: 落盘内容不一致"; fail=$((fail + 1))
fi
rm -f "$DEST"

echo
echo "== 2) fs/find 给 @ 补全(相对工程目录的路径) =="
mkdir -p "$DIR/proj/drivers"
printf 'x\n' > "$DIR/proj/Makefile"
printf 'y\n' > "$DIR/proj/drivers/media.c"
ck "$(code "$PROXY/api/fs/find?query=Make&type=file&location%5Bdirectory%5D=$(urlenc "$DIR/proj")")" "200" \
  "fs/find 可用(代理透传)"
F=$(curl -s "${AUTH[@]}" "$PROXY/api/fs/find?query=Make&type=file&location%5Bdirectory%5D=$(urlenc "$DIR/proj")")
ck "$(echo "$F" | jqget "d['location']['directory']")" "$DIR/proj" "fs/find 回报基准目录(前端拿它拼绝对路径)"
ck "$(echo "$F" | jqget "'/' in d['data'][0]['path'] or d['data'][0]['path']")" "Makefile" \
  "fs/find 返回相对路径(不带前导 /)"

echo
echo "== 3) 提示词里的附件:只认 file: URI,服务端自己读文件 =="
NEW=$(curl -s "${AUTH[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"location\":{\"directory\":\"$DIR\"},\"title\":\"附件 e2e\",\"agent\":\"build\",\"model\":{\"id\":\"deepseek-v4-flash\",\"providerID\":\"company\",\"variant\":\"default\"}}" \
  "$PROXY/api/session")
SID=$(echo "$NEW" | jqget "d['data']['id']")
if [ -n "$SID" ]; then echo "PASS: 建了临时会话($SID)"; pass=$((pass + 1)); else echo "FAIL: 建会话失败"; fail=$((fail + 1)); fi

URI="file://$DIR/note.txt"
printf 'note body\n' > "$DIR/note.txt"
ck "$(code -X POST -H 'content-type: application/json' \
      -d "{\"text\":\"看看这个\",\"files\":[{\"uri\":\"$URI\",\"name\":\"note.txt\",\"mention\":{\"start\":0,\"end\":10,\"text\":\"@note.txt\"}}]}" \
      "$PROXY/api/session/$SID/prompt")" "200" "带 file: URI 的附件能被接受"

MSG=$(curl -s "${AUTH[@]}" "$PROXY/api/session/$SID/message?order=desc&limit=10")
USER=$(echo "$MSG" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d.get('data',[]):
    if m.get('type')=='user' and m.get('files'):
        print(json.dumps(m, ensure_ascii=False)); break
")
ck "$(echo "$USER" | jqget "d['text']")" "看看这个" "正文原样保留"
ck "$(echo "$USER" | jqget "d['files'][0]['name']")" "note.txt" "附件名保留"
ck "$(echo "$USER" | jqget "d['files'][0]['mime']")" "text/plain" "服务端自己探到了 mime"
ck "$(echo "$USER" | jqget "d['files'][0]['source']['type']")" "uri" "来源类型是 uri"
ck "$(echo "$USER" | jqget "d['files'][0]['source']['uri']")" "$URI" "来源路径原样保留(面板据此显示到底带了哪个文件)"
ck "$(echo "$USER" | python3 -c "
import json,sys,base64
d=json.load(sys.stdin)
print(base64.b64decode(d['files'][0]['data']).decode())
")" "note body" "服务端把文件内容 base64 补进了消息(面板据此显示大小/缩略图)"
ck "$(echo "$USER" | jqget "json.dumps(d['files'][0].get('mention'))")" '{"start": 0, "end": 10, "text": "@note.txt"}' \
  "@ 引用的锚点也落库(位置指向正文里的那一段)"

curl -s -o /dev/null "${AUTH[@]}" -X POST "$PROXY/api/session/$SID/interrupt"

echo
echo "== 4) 非法 uri 一律拒绝(所以前端只在补全确认后才生成附件) =="
bad() { # label extra-json
  local out codev
  out=$(curl -s -o "$DIR/o.json" -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
    -d "{\"text\":\"x\",\"files\":[{$2}]}" "$PROXY/api/session/$SID/prompt")
  ck "$out" "400" "$1"
}
bad "裸绝对路径被拒(必须 file: URI)" "\"uri\":\"/tmp/x.txt\""
bad "相对路径被拒" "\"uri\":\"note.txt\""
has "$DIR/o.json" "Invalid attachment URI" "拒绝原因说清了是 uri 的问题"
bad "https 被拒" "\"uri\":\"https://example.com/x.txt\""
has "$DIR/o.json" "Unsupported attachment URI" "https 是「不支持」而不是「非法」"

echo
echo "== 5) 前端资源确实带上了附件功能(静态文件按请求读取) =="
AJ="$DIR/app.js"; ST="$DIR/styles.css"; IX="$DIR/index.html"
curl -s "${AUTH[@]}" "$PROXY/app.js" -o "$AJ"
curl -s "${AUTH[@]}" "$PROXY/styles.css" -o "$ST"
curl -s "${AUTH[@]}" "$PROXY/" -o "$IX"
has "$AJ" "function resolveMentions" "前端有 @ 引用解析"
has "$AJ" "function userFilesHtml" "前端会渲染消息里的附件"
has "$AJ" "function setupAttachments" "前端有附件接线"
has "$AJ" "function uploadPathFor" "前端会拼暂存路径"
has "$AJ" "/api/experimental/fs/write" "上传直接打 OpenCode 的 fs/write"
has "$ST" "#mentions" "@ 补全下拉有样式"
has "$ST" ".att-img" "图片附件有缩略图样式"
has "$IX" "id=\"btnAttach\"" "输入区有附件按钮"
has "$IX" "id=\"filePick\"" "有隐藏的文件选择框"

echo
echo "结果: $pass 通过, $fail 失败"
[ "$fail" -eq 0 ]
