#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
printf '%s' '{"fields":[{"name":"기능","value":"정상"}]}' | node scripts/oh-my-ai.mjs work-view --stdin-json > "$tmpdir/out"
grep -q '정상' "$tmpdir/out"
set +e
head -c 8388608 /dev/zero | node scripts/oh-my-ai.mjs work-view --stdin-json 2> "$tmpdir/exact"
exact_status=$?
head -c 8388609 /dev/zero | node scripts/oh-my-ai.mjs work-view --stdin-json 2> "$tmpdir/over"
over_status=$?
set -e
[[ $exact_status -eq 2 && $over_status -eq 2 ]]
grep -q 'must be valid JSON' "$tmpdir/exact"
grep -q 'exceeds 8388608 bytes' "$tmpdir/over"
echo 'work-view stdin limit tests passed'
