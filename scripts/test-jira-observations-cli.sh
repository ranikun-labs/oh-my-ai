#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
output="$(node "$root/scripts/oh-my-ai.mjs" work-view --stdin-json --jira-observations <<'JSON'
{
  "observed_at": "2026-11-18T00:00:00Z",
  "issues": [
    {"key": "RPL-1", "fields": {"updated": "2026-11-09T16:47:40.614+0900"}},
    {"key": "RPL-2", "fields": {"parent": {"key": "RPL-1"}}},
    {"key": "RPL-3", "fields": {"updated": "invalid"}},
    {"key": "RPL-4", "fields": {"updated": "2026-02-29T12:00:00Z"}},
    {"key": "RPL-5", "fields": {"updated": "2028-02-30T12:00:00Z"}},
    {"key": "RPL-6", "fields": {"updated": "2026-04-31T12:00:00Z"}},
    {"key": "RPL-7", "fields": {"updated": "2024-02-29T23:59:59-09:00"}}
  ]
}
JSON
)"
[[ "$output" == *"PARTIAL"* && "$output" == *"RPL-1 | parent | RPL-2"* ]]
[[ "$output" == *'| 출처 | Source updated_at | 확인 시각 |'* ]]
[[ "$output" == *'| jira:RPL-1 | 2026-11-09T16:47:40.614\+0900 | 2026-11-18T00:00:00Z |'* ]]
for key in RPL-2 RPL-3 RPL-4 RPL-5 RPL-6; do
  [[ "$output" == *"| jira:$key | UNKNOWN | 2026-11-18T00:00:00Z |"* ]]
done
[[ "$output" == *'| jira:RPL-7 | 2024-02-29T23:59:59-09:00 | 2026-11-18T00:00:00Z |'* ]]
[[ "$output" == *"지원 관계(Parent·Blocks·Relates) 관찰: 0건"* ]]
external="$(printf '%s' '{"observed_at":"2026-11-18T00:00:00Z","issues":[{"key":"RPL-1","fields":{"parent":{"key":"RPL-2"}}}]}' | node "$root/scripts/oh-my-ai.mjs" work-view --stdin-json --jira-observations)"
[[ "$external" == *"지원 관계(Parent·Blocks·Relates) 관찰: 1건"* && "$external" == *"고유 관계 건수나 미조회 데이터 전체가 아닙니다"* ]]
unsupported="$(printf '%s' '{"observed_at":"2026-11-18T00:00:00Z","issues":[{"key":"RPL-1","fields":{"issuelinks":[{"type":{"name":"Duplicate"},"outwardIssue":{"key":"RPL-2"}}]}}]}' | node "$root/scripts/oh-my-ai.mjs" work-view --stdin-json --jira-observations)"
[[ "$unsupported" == *"표시하지 않은 기타 링크 관찰: 1건"* ]]
printf '%s\n' 'Jira observations CLI synthetic PASS'
