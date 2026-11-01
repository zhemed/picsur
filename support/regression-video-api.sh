#!/bin/bash
# Picsur 视频 API 回归套件（多容器直链、单段 Range 与页面内直接播放）。
#
# 用法：
#   bash support/regression-video-api.sh <base-url> <admin-password> [fixture-dir]
#
#   <base-url>        实例地址，例如 http://localhost:8080
#   <admin-password>  PICSUR_ADMIN_PASSWORD
#   [fixture-dir]     夹具目录，默认 $PICSUR_FIXTURES，再默认 /tmp/bugs-fx
#
# 覆盖：mp4/webm 上传、HEAD、带扩展名与无扩展名直链、字节一致、Content-Length、
#       Accept-Ranges、HTTP Range 206/416（单段、开放区间、后缀区间、越界、
#       非法、多段降级为整段）、meta 与列表识别、跨格式 400、删除后 404 +
#       no-store；以及 mov/mkv/avi/wmv/flv/ts/3gp/ogv/m4v 这 9 个新增容器的
#       上传 201、source_filetype、直链 MIME 与字节、HEAD、Range 206、meta、
#       列表与删除；mpg 作为「file-type 能识别但白名单不收」的 400 负例。
#       夹具自给（缺文件时自动调用 make-video-fixtures.cjs）。
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
VIDEO_FIXTURES=(base.mp4 base.webm base.mov base.mkv base.avi base.wmv base.flv base.ts base.3gp base.ogv base.m4v base.mpg)
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
  check "HEAD /i/<id>.mp4 advertises Accept-Ranges: bytes" "$(header accept-ranges "$WORK/h-head-ext")" "bytes"
  check "HEAD /i/<id>.mp4 is nosniff" "$(header x-content-type-options "$WORK/h-head-ext")" "nosniff"
  check "HEAD /i/<id>.mp4 has no body" "$HBODY" "0"

  echo "== 4. GET /i/<id>.mp4 (full bytes, no Range) =="
  GCODE=$(curl -s -D "$WORK/h-get-ext" -o "$WORK/got.mp4" -w '%{http_code}' "$BASE/i/$ID_MP4.mp4")
  check "GET /i/<id>.mp4 -> 200" "$GCODE" "200"
  check "GET /i/<id>.mp4 content-type" "$(header content-type "$WORK/h-get-ext")" "video/mp4"
  check "GET /i/<id>.mp4 content-length" "$(header content-length "$WORK/h-get-ext")" "$SIZE_MP4"
  check "GET full video advertises Accept-Ranges: bytes" "$(header accept-ranges "$WORK/h-get-ext")" "bytes"
  if cmp -s "${FIXTURES}/base.mp4" "$WORK/got.mp4"; then
    ok "GET /i/<id>.mp4 bytes identical to the upload"
  else
    bad "GET /i/<id>.mp4 bytes differ from the upload"
  fi

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
  check "HEAD /i/<id> video advertises Accept-Ranges: bytes" "$(header accept-ranges "$WORK/h-noext-head")" "bytes"

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

echo "== 8. additional video containers =="
# Every accepted non-mp4/webm container goes through the same pipeline: video
# passthrough on upload, container mime and original bytes on the direct link,
# Range as 206, same identifiers in meta and list. The fixtures only carry a
# valid container header, so this suite checks the HTTP contract, not playback.
NEW_CONTAINERS=(
  "mov|mov|base.mov|video/quicktime|video:mov"
  "mkv|mkv|base.mkv|video/matroska|video:mkv"
  "avi|avi|base.avi|video/vnd.avi|video:avi"
  "wmv|wmv|base.wmv|video/x-ms-asf|video:wmv"
  "flv|flv|base.flv|video/x-flv|video:flv"
  "ts|ts|base.ts|video/mp2t|video:ts"
  "3gp|3gp|base.3gp|video/3gpp|video:3gp"
  "ogv|ogv|base.ogv|video/ogg|video:ogv"
  "m4v|m4v|base.m4v|video/x-m4v|video:m4v"
)
for CONTAINER in "${NEW_CONTAINERS[@]}"; do
  IFS='|' read -r LABEL EXT FNAME MIME IDENT <<< "$CONTAINER"
  echo "  -- $LABEL --"
  CCODE=$(upload "${FIXTURES}/$FNAME")
  CID=$(json "$WORK/up.json" 'import json,sys;print(json.load(open(sys.argv[1])).get("data",{}).get("id",""))')
  check "POST /api/image/upload $LABEL -> 201" "$CCODE" "201"
  if [ -z "$CID" ]; then
    bad "upload $LABEL did not return an id: $(head -c 200 "$WORK/up.json")"
    continue
  fi
  check "upload $LABEL source_filetype is $IDENT" \
    "$(json "$WORK/up.json" 'import json,sys;print(json.load(open(sys.argv[1])).get("data",{}).get("source_filetype",""))')" \
    "$IDENT"

  CSIZE=$(stat -c %s "${FIXTURES}/$FNAME")
  CGCODE=$(curl -s -D "$WORK/h-new-get" -o "$WORK/got-new.$EXT" -w '%{http_code}' "$BASE/i/$CID.$EXT")
  check "GET /i/<id>.$EXT ($LABEL) -> 200" "$CGCODE" "200"
  check "GET $LABEL content-type" "$(header content-type "$WORK/h-new-get")" "$MIME"
  check "GET $LABEL content-length" "$(header content-length "$WORK/h-new-get")" "$CSIZE"
  if cmp -s "${FIXTURES}/$FNAME" "$WORK/got-new.$EXT"; then
    ok "GET $LABEL bytes identical to the upload"
  else
    bad "GET $LABEL bytes differ from the upload"
  fi

  CHCODE=$(curl -s -D "$WORK/h-new-head" -o /dev/null -w '%{http_code}' -I "$BASE/i/$CID.$EXT")
  check "HEAD /i/<id>.$EXT ($LABEL) -> 200" "$CHCODE" "200"
  check "HEAD $LABEL content-length" "$(header content-length "$WORK/h-new-head")" "$CSIZE"
  check "HEAD $LABEL advertises Accept-Ranges: bytes" "$(header accept-ranges "$WORK/h-new-head")" "bytes"

  CRCODE=$(curl -s -D "$WORK/h-new-range" -o "$WORK/range-new.bin" -w '%{http_code}' \
    -H 'Range: bytes=0-99' "$BASE/i/$CID.$EXT")
  check "Range $LABEL bytes=0-99 -> 206" "$CRCODE" "206"
  check "Range $LABEL Content-Range" "$(header content-range "$WORK/h-new-range")" "bytes 0-99/$CSIZE"
  head -c 100 "${FIXTURES}/$FNAME" > "$WORK/range-new.expect"
  if cmp -s "$WORK/range-new.expect" "$WORK/range-new.bin"; then
    ok "Range $LABEL slice identical to the first 100 bytes"
  else
    bad "Range $LABEL slice differs from the first 100 bytes"
  fi

  CMMCODE=$(curl -s -o "$WORK/meta-new.json" -w '%{http_code}' "$BASE/i/meta/$CID")
  check "GET /i/meta/<id> ($LABEL) -> 200" "$CMMCODE" "200"
  check "meta $LABEL source_filetype" \
    "$(json "$WORK/meta-new.json" 'import json,sys;print(json.load(open(sys.argv[1]))["data"]["image"]["source_filetype"])')" \
    "$IDENT"
  check "GET /i/<id>.mp4 ($LABEL cross-container) -> 400" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$CID.mp4")" "400"

  CLCODE=$(curl -s -o "$WORK/list-new.json" -w '%{http_code}' -X POST "$BASE/api/image/list" \
    -H "$AUTH" -H 'Content-Type: application/json' -d '{"count":24,"page":0}')
  check "POST /api/image/list ($LABEL) -> 201" "$CLCODE" "201"
  CLISTED=$(json "$WORK/list-new.json" '
import json, sys
rows = json.load(open(sys.argv[1]))["data"]["results"]
row = [r for r in rows if r["id"] == sys.argv[2]]
print(row[0]["source_filetype"] if row else "missing")
' "$CID")
  check "list row $LABEL source_filetype is $IDENT" "$CLISTED" "$IDENT"

  CDELCODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/image/delete" \
    -H "$AUTH" -H 'Content-Type: application/json' -d "{\"ids\":[\"$CID\"]}")
  check "POST /api/image/delete ($LABEL) -> 201" "$CDELCODE" "201"
  check "deleted GET /i/<id>.$EXT ($LABEL) -> 404" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$CID.$EXT")" "404"
done

if [ -n "$ID_MP4" ]; then
  echo "== 9. cross-media conversions are 400 =="
  check "GET /i/<video id>.webp -> 400" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$ID_MP4.webp")" "400"
  check "GET /i/<video id>.jpg -> 400" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$ID_MP4.jpg")" "400"
  check "HEAD /i/<video id>.webm (mismatch) -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -I "$BASE/i/$ID_MP4.webm")" "400"
  check "HEAD /i/<video id>.webp (image ext) -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -I "$BASE/i/$ID_MP4.webp")" "400"
  # Edit parameters are ignored for videos instead of being refused: the whole
  # file is still served (there is no video editor in this tier).
  EC=$(curl -s -o "$WORK/got-edit.mp4" -w '%{http_code}' "$BASE/i/$ID_MP4.mp4?width=100")
  check "GET /i/<video id>.mp4?width=100 -> 200 full file" "$EC" "200"
  if cmp -s "${FIXTURES}/base.mp4" "$WORK/got-edit.mp4"; then
    ok "video ignores edit parameters (bytes unchanged)"
  else
    bad "video edit request changed the bytes"
  fi
fi

if [ -n "$ID_MP4" ]; then
  echo "== 10. HTTP Range (206/416) =="
  LAST=$((SIZE_MP4 - 1))

  echo "  -- single range bytes=0-99 --"
  RCODE=$(curl -s -D "$WORK/h-range" -o "$WORK/range-first.bin" -w '%{http_code}' \
    -H 'Range: bytes=0-99' "$BASE/i/$ID_MP4.mp4")
  check "Range bytes=0-99 -> 206" "$RCODE" "206"
  check "Range bytes=0-99 Content-Range" "$(header content-range "$WORK/h-range")" "bytes 0-99/$SIZE_MP4"
  check "Range bytes=0-99 Content-Length" "$(header content-length "$WORK/h-range")" "100"
  check "Range bytes=0-99 Content-Type" "$(header content-type "$WORK/h-range")" "video/mp4"
  check "Range bytes=0-99 Accept-Ranges" "$(header accept-ranges "$WORK/h-range")" "bytes"
  check "Range bytes=0-99 keeps month cache" "$(header cache-control "$WORK/h-range")" "max-age=2592000"
  head -c 100 "${FIXTURES}/base.mp4" > "$WORK/range-first.expect"
  if cmp -s "$WORK/range-first.expect" "$WORK/range-first.bin"; then
    ok "Range bytes=0-99 slice identical to the first 100 bytes"
  else
    bad "Range bytes=0-99 slice differs from the first 100 bytes"
  fi

  echo "  -- open ended range bytes=100- --"
  RCODE=$(curl -s -D "$WORK/h-range-open" -o "$WORK/range-open.bin" -w '%{http_code}' \
    -H 'Range: bytes=100-' "$BASE/i/$ID_MP4.mp4")
  check "Range bytes=100- -> 206" "$RCODE" "206"
  check "Range bytes=100- Content-Range" "$(header content-range "$WORK/h-range-open")" "bytes 100-$LAST/$SIZE_MP4"
  check "Range bytes=100- Content-Length" "$(header content-length "$WORK/h-range-open")" "$((SIZE_MP4 - 100))"
  tail -c +101 "${FIXTURES}/base.mp4" > "$WORK/range-open.expect"
  if cmp -s "$WORK/range-open.expect" "$WORK/range-open.bin"; then
    ok "Range bytes=100- slice identical to bytes 100..end"
  else
    bad "Range bytes=100- slice differs from bytes 100..end"
  fi

  echo "  -- suffix range bytes=-100 --"
  RCODE=$(curl -s -D "$WORK/h-range-suffix" -o "$WORK/range-suffix.bin" -w '%{http_code}' \
    -H 'Range: bytes=-100' "$BASE/i/$ID_MP4.mp4")
  check "Range bytes=-100 -> 206" "$RCODE" "206"
  check "Range bytes=-100 Content-Range" "$(header content-range "$WORK/h-range-suffix")" "bytes $((SIZE_MP4 - 100))-$LAST/$SIZE_MP4"
  check "Range bytes=-100 Content-Length" "$(header content-length "$WORK/h-range-suffix")" "100"
  tail -c 100 "${FIXTURES}/base.mp4" > "$WORK/range-suffix.expect"
  if cmp -s "$WORK/range-suffix.expect" "$WORK/range-suffix.bin"; then
    ok "Range bytes=-100 slice identical to the last 100 bytes"
  else
    bad "Range bytes=-100 slice differs from the last 100 bytes"
  fi

  echo "  -- end past EOF is clamped --"
  RCODE=$(curl -s -D "$WORK/h-range-clamp" -o "$WORK/range-clamp.bin" -w '%{http_code}' \
    -H "Range: bytes=0-$((SIZE_MP4 + 999))" "$BASE/i/$ID_MP4.mp4")
  check "Range end past EOF -> 206 clamped" "$RCODE" "206"
  check "Range end past EOF Content-Range" "$(header content-range "$WORK/h-range-clamp")" "bytes 0-$LAST/$SIZE_MP4"
  check "Range end past EOF Content-Length" "$(header content-length "$WORK/h-range-clamp")" "$SIZE_MP4"
  if cmp -s "${FIXTURES}/base.mp4" "$WORK/range-clamp.bin"; then
    ok "Range end past EOF returns the whole file"
  else
    bad "Range end past EOF returned different bytes"
  fi

  echo "  -- no-extension direct link honours Range --"
  RCODE=$(curl -s -D "$WORK/h-range-noext" -o "$WORK/range-noext.bin" -w '%{http_code}' \
    -H 'Range: bytes=0-99' "$BASE/i/$ID_MP4")
  check "Range on /i/<id> (no ext) -> 206" "$RCODE" "206"
  check "Range on /i/<id> (no ext) Content-Range" "$(header content-range "$WORK/h-range-noext")" "bytes 0-99/$SIZE_MP4"
  head -c 100 "${FIXTURES}/base.mp4" > "$WORK/range-noext.expect"
  if cmp -s "$WORK/range-noext.expect" "$WORK/range-noext.bin"; then
    ok "Range on /i/<id> (no ext) slice identical"
  else
    bad "Range on /i/<id> (no ext) slice differs"
  fi

  echo "  -- unsatisfiable and malformed ranges --"
  RCODE=$(curl -s -D "$WORK/h-range-oob" -o "$WORK/range-oob.bin" -w '%{http_code}' \
    -H "Range: bytes=$SIZE_MP4-$((SIZE_MP4 + 10))" "$BASE/i/$ID_MP4.mp4")
  check "Range start at EOF -> 416" "$RCODE" "416"
  check "416 Content-Range" "$(header content-range "$WORK/h-range-oob")" "bytes */$SIZE_MP4"
  check "416 has an empty body" "$(stat -c %s "$WORK/range-oob.bin")" "0"
  RCODE=$(curl -s -D "$WORK/h-range-bad" -o /dev/null -w '%{http_code}' \
    -H 'Range: bytes=abc' "$BASE/i/$ID_MP4.mp4")
  check "Malformed Range -> 416" "$RCODE" "416"
  check "Malformed Range Content-Range" "$(header content-range "$WORK/h-range-bad")" "bytes */$SIZE_MP4"
  RCODE=$(curl -s -D "$WORK/h-range-rev" -o /dev/null -w '%{http_code}' \
    -H 'Range: bytes=500-100' "$BASE/i/$ID_MP4.mp4")
  check "Reversed Range -> 416" "$RCODE" "416"

  echo "  -- multiple ranges fall back to the whole file --"
  RCODE=$(curl -s -D "$WORK/h-range-multi" -o "$WORK/range-multi.bin" -w '%{http_code}' \
    -H 'Range: bytes=0-1,5-6' "$BASE/i/$ID_MP4.mp4")
  check "Multi-range -> 200 full file" "$RCODE" "200"
  check "Multi-range has no Content-Range" "$(header content-range "$WORK/h-range-multi")" ""
  if cmp -s "${FIXTURES}/base.mp4" "$WORK/range-multi.bin"; then
    ok "Multi-range returns the whole file"
  else
    bad "Multi-range returned different bytes"
  fi

  if [ -n "$ID_WEBM" ]; then
    echo "  -- webm honours Range too --"
    RCODE=$(curl -s -D "$WORK/h-range-webm" -o "$WORK/range-webm.bin" -w '%{http_code}' \
      -H 'Range: bytes=0-99' "$BASE/i/$ID_WEBM.webm")
    check "webm Range bytes=0-99 -> 206" "$RCODE" "206"
    check "webm Range Content-Range" "$(header content-range "$WORK/h-range-webm")" "bytes 0-99/$SIZE_WEBM"
    check "webm Range Content-Type" "$(header content-type "$WORK/h-range-webm")" "video/webm"
    head -c 100 "${FIXTURES}/base.webm" > "$WORK/range-webm.expect"
    if cmp -s "$WORK/range-webm.expect" "$WORK/range-webm.bin"; then
      ok "webm Range slice identical to the first 100 bytes"
    else
      bad "webm Range slice differs from the first 100 bytes"
    fi
  fi
fi

echo "== 11. recognised but not whitelisted container (mpg) -> 400, not 500 =="
# MPEG-PS is deliberately not accepted: the same valid file can be reported as
# video/mpeg, video/MP1S or video/MP2P depending on the pack header, so a single
# mime mapping would be unstable. The negative case proves the rejection is a
# clean 400 instead of a 500 or a stored-but-unservable file.
MPGCODE=$(upload "${FIXTURES}/base.mpg")
check "POST /api/image/upload mpg -> 400" "$MPGCODE" "400"
MPG_TYPE=$(json "$WORK/up.json" 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("success"), d.get("data",{}).get("type"))')
check "mpg rejection is usrvalidation" "$MPG_TYPE" "False usrvalidation"
check "service still alive after rejection" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/info")" "200"

if [ -n "${PICSUR_MAX_FILE_SIZE_UNDER_TEST:-}" ] && [ -s "${FIXTURES}/too-big.mp4" ]; then
  echo "== 12. over PICSUR_MAX_FILE_SIZE -> 413 =="
  BIGCODE=$(upload "${FIXTURES}/too-big.mp4")
  check "oversized video upload -> 413" "$BIGCODE" "413"
else
  echo "== 12. over PICSUR_MAX_FILE_SIZE -> 413 =="
  echo "  [SKIP] set PICSUR_MAX_FILE_SIZE_UNDER_TEST=<limit> with an instance started"
  echo "         with a small PICSUR_MAX_FILE_SIZE to cover this assertion"
fi

echo "== 13. deletion semantics =="
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
