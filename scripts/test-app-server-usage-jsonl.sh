#!/usr/bin/env bash
set -euo pipefail
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
cat > "$d/input" <<'JSONL'
{"expected":{"threadId":"private-thread-sentinel","turnId":"private-turn-sentinel"}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"private-thread-sentinel","turnId":"private-turn-sentinel","tokenUsage":{"last":{"inputTokens":10,"cachedInputTokens":2,"outputTokens":4,"reasoningOutputTokens":1,"totalTokens":14},"total":{"inputTokens":999,"cachedInputTokens":2,"outputTokens":4,"reasoningOutputTokens":1,"totalTokens":1003}}}}
JSONL
node scripts/app-server-usage-jsonl.mjs --unverified-input < "$d/input" > "$d/out"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));if(r.status!=="SNAPSHOT_UNVERIFIED_SOURCE"||r.last.inputTokens!==10||r.uniqueness!=="UNKNOWN")process.exit(1)' "$d/out"
! rg -q 'private-thread-sentinel|private-turn-sentinel' "$d/out"
set +e
node scripts/app-server-usage-jsonl.mjs < "$d/input" > "$d/out" 2> "$d/err"
code=$?
set -e
[[ $code == 2 && ! -s "$d/out" ]]
! rg -q 'private-thread-sentinel|private-turn-sentinel' "$d/err"
set +e
node scripts/app-server-usage-jsonl.mjs --unverified-input --require-turn-completed < "$d/input" > "$d/out"
code=$?
set -e
[[ $code == 1 ]]
rg -q TURN_NOT_COMPLETED "$d/out"
cp "$d/input" "$d/completed"
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"private-thread-sentinel","turn":{"id":"private-turn-sentinel","status":"completed","items":[]}}}' >> "$d/completed"
node scripts/app-server-usage-jsonl.mjs --unverified-input --require-turn-completed < "$d/completed" > "$d/out"
rg -q CALLER_STREAM_REPORTED "$d/out"
! rg -q 'private-thread-sentinel|private-turn-sentinel' "$d/out"
node scripts/app-server-usage-jsonl.mjs --unverified-input --format=f1 < "$d/completed" > "$d/out"
rg -q '공식 토큰 UNKNOWN.+입력 10 / 캐시 읽기 2 / 캐시 쓰기 UNKNOWN / 출력 4 / 추론 출력 1' "$d/out"
! rg -q '999|1003|private-thread-sentinel|private-turn-sentinel' "$d/out"
set +e
node scripts/app-server-usage-jsonl.mjs --unverified-input --format=f1 < "$d/input" > "$d/out"
code=$?
set -e
[[ $code == 1 ]]
rg -q '관측값 UNKNOWN' "$d/out"
! rg -q '입력 10' "$d/out"
for malformed in 'null' '42' '[]' '{}' '{"method":5}' '{"method":""}'; do
  cp "$d/input" "$d/bad"
  printf '%s\n' "$malformed" >> "$d/bad"
  set +e
  node scripts/app-server-usage-jsonl.mjs --unverified-input < "$d/bad" > "$d/out"
  code=$?
  set -e
  [[ $code == 1 ]]
  rg -q INVALID_OR_LIMITED_INPUT "$d/out"
  ! rg -q 'inputTokens|private-thread-sentinel|private-turn-sentinel' "$d/out"
done
printf '%s\n' '{"expected":{"threadId":"t","turnId":"u"}}' '{broken' > "$d/input"
set +e
node scripts/app-server-usage-jsonl.mjs --unverified-input < "$d/input" > "$d/out"
code=$?
set -e
[[ $code == 1 ]]
rg -q INVALID_OR_LIMITED_INPUT "$d/out"
printf '%s\n' 'PASS: JSONL usage opt-in, ID privacy, invalid event handling'
