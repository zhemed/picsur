#!/bin/bash
# Picsur 视频 API 回归套件（A 档：只上传与直链）。
#
# 用法：
#   bash support/regression-video-api.sh <base-url> <admin-password> [fixture-dir]
#
#   <base-url>        实例地址，例如 http://localhost:8080
#   <admin-password>  PICSUR_ADMIN_PASSWORD
#   [fixture-dir]     夹具目录，默认 $PICSUR_FIXTURES，再默认 /tmp/bugs-fx
#
# 覆盖：mp4/webm 上传、HEAD、带扩展名与无扩展名直链、字节一致、Content-Length、
#       无 Accept-Ranges、meta 与列表识别、跨格式 400、mov 400（不是 500）、
#       删除后 404 + no-store。夹具自给（缺文件时自动调用 make-video-fixtures.cjs）。
#
# 超限 413 需要目标实例的 PICSUR_MAX_FILE_SIZE 比较小（默认 128 MB，不适合每次
# 回归都写一个 128 MB 文件）。在把上传上限调小的实例上跑时，用环境变量告知脚本
# 该实例的上限：
#
#   PICSUR_MAX_FILE_SIZE_UNDER_TEST=2097152 \
#     bash support/regression-video-api.sh http://localhost:8081 "$PW"
#
# 前提：该实例的 PICSUR_MAX_FILE_SIZE 必须等于（或小于）这里传入的值，否则本
# 脚本的 413 断言会失败（这是断言，不是环境问题）。同时实例上限不能小于
# base.mp4 夹具的 1048596 字节，否则正例上传会变成 413，同样会失败。
#
# 环境说明：视频不转码，所以本套件不需要自编译 libvips；任意 Node 20 宿主实例即可。
set -uo pipefail

BASE="${1:?base url}"
PW="${2:?admin password}"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FIXTURES="${3:-${PICSUR_FIXTURES:-/tmp/bugs-fx}}"
WORK=$(mktemp -d)
PASS=0
FAIL=0
ok() {
  printf '  [PASS] %s\n' "$1"
  PASS=$((PASS + 1))
}
bad() {
  printf '  [FAIL] %s\n' "$1"
  FAIL=$((FAIL + 1))
}
check() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (got '$2', want '$3')"; fi; }
header() { grep -i "^$1:" "$2" | head -1 | tr -d '\r' | sed 's/^[^:]*:[[:space:]]*//'; }
json() {
  local file=$1 script=$2
  shift 2
  python3 -c "$script" "$file" "$@"
}

# --- 依赖与夹具（失败就明确退出，不跑出一堆 FAIL） ------------------------------
for bin in curl node python3 cmp stat; do
  command -v "$bin" > /dev/null 2>&1 || {
    echo "FATAL: '$bin' is required but not in PATH" >&2
    exit 2
  }
done

# /i/* 是 600 请求/分钟、上传是 20 请求/分钟的桶。本套件请求数远低于上限，但紧接
# 着重复跑两次仍可能撞窗口；429 时等 60s 窗口重置，得到确定性结论而不是假失败。
sleep_warned=0
curl() {
  local attempt out
  for attempt in $(seq 1 13); do
    out=$(command curl "$@")
    case "$out" in
      429 | *'"statusCode":429'* | *'HTTP/1.1 429'*)
        if [ "$attempt" -lt 13 ]; then
          if [ "$sleep_warned" -eq 0 ]; then
            echo "  (instance rate limited this IP; honouring the 60s window — the run takes a bit longer)" >&2
            sleep_warned=1
          fi
          sleep 6
          continue
        fi
        ;;
    esac
    printf '%s' "$out"
    return 0
  done
  printf '%s' "$out"
  return 0
}

echo "== 0. fixtures =="
VIDEO_FIXTURES=(base.mp4 base.webm base.mov)
MISSING=()
for f in "${VIDEO_FIXTURES[@]}"; do
  [ -s "${FIXTURES}/$f" ] || MISSING+=("$f")
done
[ -n "${PICSUR_MAX_FILE_SIZE_UNDER_TEST:-}" ] && [ ! -s "${FIXTURES}/too-big.mp4" ] && MISSING+=("too-big.mp4")

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "  missing in ${FIXTURES}: ${MISSING[*]}"
  echo "  generating them with support/make-video-fixtures.cjs …"
  if [ -n "${PICSUR_MAX_FILE_SIZE_UNDER_TEST:-}" ]; then
    PICSUR_VIDEO_TOO_BIG_BYTES=$((PICSUR_MAX_FILE_SIZE_UNDER_TEST + 1024)) \
      node "${SCRIPT_DIR}/make-video-fixtures.cjs" "$FIXTURES" || {
      echo "FATAL: could not prepare the video fixtures" >&2
      exit 2
    }
  else
    node "${SCRIPT_DIR}/make-video-fixtures.cjs" "$FIXTURES" || {
      echo "FATAL: could not prepare the video fixtures" >&2
      exit 2
    }
  fi
else
  echo "  ok: ${VIDEO_FIXTURES[*]} present in ${FIXTURES}"
fi

SIZE_MP4=$(stat -c %s "${FIXTURES}/base.mp4")
SIZE_WEBM=$(stat -c %s "${FIXTURES}/base.webm")

TOKEN=$(curl -s -X POST "$BASE/api/user/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("jwt_token",""))')
if [ -z "$TOKEN" ]; then
  echo "FATAL: login failed (wrong password, or instance not reachable at $BASE)"
  exit 2
fi
AUTH="Authorization: Bearer $TOKEN"

upload() {
  curl -s -o "$WORK/up.json" -w '%{http_code}' -X POST "$BASE/api/image/upload" \
    -H "$AUTH" -F "image=@$1"
}

echo "== 1. upload mp4 =="
CODE=$(upload "${FIXTURES}/base.mp4")
ID_MP4=$(json "$WORK/up.json" 'import json,sys;print(json.load(open(sys.argv[1])).get("data",{}).get("id",""))')
check "POST /api/image/upload mp4 -> 201" "$CODE" "201"
if [ -n "$ID_MP4" ]; then
  check "upload mp4 source_filetype is video:mp4" \
    "$(json "$WORK/up.json" 'import json,sys;print(json.load(open(sys.argv[1])).get("data",{}).get("source_filetype",""))')" \
    "video:mp4"
  check "upload mp4 has no width/height" \
    "$(json "$WORK/up.json" 'import json,sys;d=json.load(open(sys.argv[1]))["data"];print(d.get("width"),d.get("height"))')" \
    "None None"
else
  bad "upload mp4 did not return an id: $(head -c 200 "$WORK/up.json")"
fi

echo "== 2. upload webm =="
CODE=$(upload "${FIXTURES}/base.webm")
ID_WEBM=$(json "$WORK/up.json" 'import json,sys;print(json.load(open(sys.argv[1])).get("data",{}).get("id",""))')
check "POST /api/image/upload webm -> 201" "$CODE" "201"
if [ -n "$ID_WEBM" ]; then
  check "upload webm source_filetype is video:webm" \
    "$(json "$WORK/up.json" 'import json,sys;print(json.load(open(sys.argv[1])).get("data",{}).get("source_filetype",""))')" \
    "video:webm"
else
  bad "upload webm did not return an id: $(head -c 200 "$WORK/up.json")"
fi

if [ -n "$ID_MP4" ]; then
  echo "== 3. HEAD /i/<id>.mp4 =="
  HOUT=$(curl -s -D "$WORK/h-head-ext" -o /dev/null -w '%{http_code} %{size_download}' -I "$BASE/i/$ID_MP4.mp4")
  HCODE="${HOUT%% *}"
  HBODY="${HOUT##* }"
  check "HEAD /i/<id>.mp4 -> 200" "$HCODE" "200"
  check "HEAD /i/<id>.mp4 content-type" "$(header content-type "$WORK/h-head-ext")" "video/mp4"
  check "HEAD /i/<id>.mp4 content-length" "$(header content-length "$WORK/h-head-ext")" "$SIZE_MP4"
  check "HEAD /i/<id>.mp4 keeps month cache" "$(header cache-control "$WORK/h-head-ext")" "max-age=2592000"
  check "HEAD /i/<id>.mp4 has no Accept-Ranges (tier A) " "$(header accept-ranges "$WORK/h-head-ext")" ""
  check "HEAD /i/<id>.mp4 is nosniff" "$(header x-content-type-options "$WORK/h-head-ext")" "nosniff"
  check "HEAD /i/<id>.mp4 has no body" "$HBODY" "0"

  echo "== 4. GET /i/<id>.mp4 (full bytes, no Range) =="
  GCODE=$(curl -s -D "$WORK/h-get-ext" -o "$WORK/got.mp4" -w '%{http_code}' "$BASE/i/$ID_MP4.mp4")
  check "GET /i/<id>.mp4 -> 200" "$GCODE" "200"
  check "GET /i/<id>.mp4 content-type" "$(header content-type "$WORK/h-get-ext")" "video/mp4"
  check "GET /i/<id>.mp4 content-length" "$(header content-length "$WORK/h-get-ext")" "$SIZE_MP4"
  if cmp -s "${FIXTURES}/base.mp4" "$WORK/got.mp4"; then
    ok "GET /i/<id>.mp4 bytes identical to the upload"
  else
    bad "GET /i/<id>.mp4 bytes differ from the upload"
  fi

  # A Range header must not produce a 206/Content-Range in tier A: the server
  # ignores it and answers 200 with the whole file. Asserting this keeps the
  # "no Range support" boundary explicit.
  RCODE=$(curl -s -D "$WORK/h-range" -o /dev/null -w '%{http_code}' \
    -H 'Range: bytes=0-99' "$BASE/i/$ID_MP4.mp4")
  check "GET /i/<id>.mp4 with Range -> 200 full file (no 206)" "$RCODE" "200"
  check "GET /i/<id>.mp4 with Range has no Content-Range" "$(header content-range "$WORK/h-range")" ""

  echo "== 5. GET/HEAD /i/<id> (no extension fallback) =="
  NCODE=$(curl -s -D "$WORK/h-noext" -o "$WORK/got-noext.mp4" -w '%{http_code}' "$BASE/i/$ID_MP4")
  check "GET /i/<id> video -> 200" "$NCODE" "200"
  check "GET /i/<id> video content-type" "$(header content-type "$WORK/h-noext")" "video/mp4"
  if cmp -s "${FIXTURES}/base.mp4" "$WORK/got-noext.mp4"; then
    ok "GET /i/<id> video bytes identical to the upload"
  else
    bad "GET /i/<id> video bytes differ from the upload"
  fi
  NHCODE=$(curl -s -D "$WORK/h-noext-head" -o /dev/null -w '%{http_code}' -I "$BASE/i/$ID_MP4")
  check "HEAD /i/<id> video -> 200" "$NHCODE" "200"
  check "HEAD /i/<id> video content-type" "$(header content-type "$WORK/h-noext-head")" "video/mp4"
  check "HEAD /i/<id> video content-length" "$(header content-length "$WORK/h-noext-head")" "$SIZE_MP4"

  echo "== 6. meta and list identify the video =="
  MCODE=$(curl -s -D "$WORK/h-meta" -o "$WORK/meta.json" -w '%{http_code}' "$BASE/i/meta/$ID_MP4")
  check "GET /i/meta/<id> video -> 200" "$MCODE" "200"
  check "meta source_filetype" \
    "$(json "$WORK/meta.json" 'import json,sys;print(json.load(open(sys.argv[1]))["data"]["image"]["source_filetype"])')" \
    "video:mp4"
  check "meta fileTypes.master" \
    "$(json "$WORK/meta.json" 'import json,sys;print(json.load(open(sys.argv[1]))["data"]["fileTypes"]["master"])')" \
    "video:mp4"
  check "meta is no-store" "$(header cache-control "$WORK/h-meta")" "no-store"

  LCODE=$(curl -s -o "$WORK/list.json" -w '%{http_code}' -X POST "$BASE/api/image/list" \
    -H "$AUTH" -H 'Content-Type: application/json' -d '{"count":24,"page":0}')
  check "POST /api/image/list -> 201" "$LCODE" "201"
  LISTED=$(json "$WORK/list.json" '
import json, sys
rows = json.load(open(sys.argv[1]))["data"]["results"]
row = [r for r in rows if r["id"] == sys.argv[2]]
print(row[0]["source_filetype"] if row else "missing")
' "$ID_MP4")
  check "list row source_filetype is video:mp4" "$LISTED" "video:mp4"
fi

if [ -n "$ID_WEBM" ]; then
  echo "== 7. webm direct link =="
  WGCODE=$(curl -s -D "$WORK/h-webm" -o "$WORK/got.webm" -w '%{http_code}' "$BASE/i/$ID_WEBM.webm")
  check "GET /i/<id>.webm -> 200" "$WGCODE" "200"
  check "GET /i/<id>.webm content-type" "$(header content-type "$WORK/h-webm")" "video/webm"
  check "GET /i/<id>.webm content-length" "$(header content-length "$WORK/h-webm")" "$SIZE_WEBM"
  if cmp -s "${FIXTURES}/base.webm" "$WORK/got.webm"; then
    ok "GET /i/<id>.webm bytes identical to the upload"
  else
    bad "GET /i/<id>.webm bytes differ from the upload"
  fi
fi

if [ -n "$ID_MP4" ]; then
  echo "== 8. cross-media conversions are 400 =="
  check "GET /i/<video id>.webp -> 400" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$ID_MP4.webp")" "400"
  check "GET /i/<video id>.jpg -> 400" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$ID_MP4.jpg")" "400"
  check "HEAD /i/<video id>.webm (mismatch) -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -I "$BASE/i/$ID_MP4.webm")" "400"
  check "HEAD /i/<video id>.webp (image ext) -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -I "$BASE/i/$ID_MP4.webp")" "400"
  # Edit parameters are ignored for videos instead of being refused: the whole
  # file is still served (tier A has no editor for video).
  EC=$(curl -s -o "$WORK/got-edit.mp4" -w '%{http_code}' "$BASE/i/$ID_MP4.mp4?width=100")
  check "GET /i/<video id>.mp4?width=100 -> 200 full file" "$EC" "200"
  if cmp -s "${FIXTURES}/base.mp4" "$WORK/got-edit.mp4"; then
    ok "video ignores edit parameters (bytes unchanged)"
  else
    bad "video edit request changed the bytes"
  fi
fi

echo "== 9. recognised but unsupported container -> 400, not 500 =="
MOVCODE=$(upload "${FIXTURES}/base.mov")
check "POST /api/image/upload mov -> 400" "$MOVCODE" "400"
MOV_TYPE=$(json "$WORK/up.json" 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("success"), d.get("data",{}).get("type"))')
check "mov rejection is usrvalidation" "$MOV_TYPE" "False usrvalidation"
check "service still alive after rejection" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/info")" "200"

if [ -n "${PICSUR_MAX_FILE_SIZE_UNDER_TEST:-}" ] && [ -s "${FIXTURES}/too-big.mp4" ]; then
  echo "== 10. over PICSUR_MAX_FILE_SIZE -> 413 =="
  BIGCODE=$(upload "${FIXTURES}/too-big.mp4")
  check "oversized video upload -> 413" "$BIGCODE" "413"
else
  echo "== 10. over PICSUR_MAX_FILE_SIZE -> 413 =="
  echo "  [SKIP] set PICSUR_MAX_FILE_SIZE_UNDER_TEST=<limit> with an instance started"
  echo "         with a small PICSUR_MAX_FILE_SIZE to cover this assertion"
fi

echo "== 11. deletion semantics =="
IDS="[]"
[ -n "$ID_MP4" ] && IDS=$(printf '["%s"]' "$ID_MP4")
if [ -n "$ID_WEBM" ]; then
  if [ "$IDS" = "[]" ]; then IDS=$(printf '["%s"]' "$ID_WEBM"); else IDS=$(printf '["%s","%s"]' "$ID_MP4" "$ID_WEBM"); fi
fi
if [ "$IDS" != "[]" ]; then
  DELCODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/image/delete" \
    -H "$AUTH" -H 'Content-Type: application/json' -d "{\"ids\":$IDS}")
  check "POST /api/image/delete -> 201" "$DELCODE" "201"

  for ID in $ID_MP4 $ID_WEBM; do
    [ -z "$ID" ] && continue
    EXT=mp4
    [ "$ID" = "$ID_WEBM" ] && EXT=webm
    check "deleted GET /i/<id>.$EXT -> 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$ID.$EXT")" "404"
    DCODE=$(curl -s -D "$WORK/h-dead" -o /dev/null -w '%{http_code}' "$BASE/i/$ID.$EXT")
    check "deleted video GET carries no-store" "$(header cache-control "$WORK/h-dead")" "no-store"
    check "deleted HEAD /i/<id>.$EXT -> 404" "$(curl -s -o /dev/null -w '%{http_code}' -I "$BASE/i/$ID.$EXT")" "404"
    check "deleted /i/<id> (no ext) -> 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$ID")" "404"
    check "deleted /i/meta/<id> -> 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/meta/$ID")" "404"
  done
fi

rm -rf "$WORK"
echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
