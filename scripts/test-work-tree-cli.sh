#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
printf '%s' '{"items":[{"key":"RPL-1"},{"key":"RPL-2"}],"relations":[{"from":"RPL-1","to":"RPL-2","type":"blocks"}]}' | node scripts/oh-my-ai.mjs work-view --stdin-json --relations > "$tmpdir/out"
grep -q 'RPL-1 | blocks | RPL-2' "$tmpdir/out"
grep -q '자동 조회·완료 판정을 하지 않습니다' "$tmpdir/out"
if printf '%s' '{"items":[],"relations":[{}]}' | node scripts/oh-my-ai.mjs work-view --stdin-json --relations > "$tmpdir/out" 2> "$tmpdir/err"; then exit 1; fi
grep -q 'work-view input invalid' "$tmpdir/err"
if head -c 8388609 /dev/zero | node scripts/oh-my-ai.mjs work-view --stdin-json --relations > "$tmpdir/out" 2> "$tmpdir/err"; then exit 1; fi
grep -q 'exceeds 8388608 bytes' "$tmpdir/err"
echo 'work-tree CLI tests passed'
