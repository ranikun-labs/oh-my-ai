#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cases=$(mktemp)
results=$(mktemp)
trap 'rm -f "$cases" "$results"' EXIT
node scripts/test-f1-shared-routing.mjs > "$cases"
for script in scripts/work-start-skill-match.mjs scripts/prompt-routing-hook.mjs; do
  format=--format=json
  [[ "$script" == *hook* ]] && format=--format=routing-json
  while IFS=$'\t' read -r input expected other; do
    result=$(node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64"))' "$input" | node "$script" "$format" | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => process.stdout.write(Buffer.from(s).toString("base64")))')
    printf '%s\t%s\t%s\t%s\t%s\n' "$script" "$input" "$expected" "${other:-none}" "$result" >> "$results"
  done < "$cases"
done
node --input-type=module - "$results" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
for (const line of lines) {
  const [script, encoded, expected, other, result] = line.split('\t');
  const input = Buffer.from(encoded, 'base64').toString();
  const names = JSON.parse(Buffer.from(result, 'base64').toString()).skill_candidates.map(c => c.name);
  assert.equal(names.includes('engineering-communication-ko'), expected === 'true', `${script}: ${input}: ${names}`);
  if (other !== 'none') assert.ok(names.includes(other), `${script}: ${input}: ${names}`);
}
console.log(`F1 shared routing: ${lines.length}/${lines.length} PASS`);
JS
