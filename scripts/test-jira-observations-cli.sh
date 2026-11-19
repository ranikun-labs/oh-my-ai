#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
output="$(printf '%s' '{"observed_at":"2026-11-18T00:00:00Z","issues":[{"key":"RPL-1","fields":{}},{"key":"RPL-2","fields":{"parent":{"key":"RPL-1"}}}]}' | node "$root/scripts/oh-my-ai.mjs" work-view --stdin-json --jira-observations)"
[[ "$output" == *"PARTIAL"* && "$output" == *"RPL-1 | parent | RPL-2"* ]]
[[ "$output" == *"지원 관계(Parent·Blocks·Relates) 관찰: 0건"* ]]
external="$(printf '%s' '{"observed_at":"2026-11-18T00:00:00Z","issues":[{"key":"RPL-1","fields":{"parent":{"key":"RPL-2"}}}]}' | node "$root/scripts/oh-my-ai.mjs" work-view --stdin-json --jira-observations)"
[[ "$external" == *"지원 관계(Parent·Blocks·Relates) 관찰: 1건"* && "$external" == *"고유 관계 건수나 미조회 데이터 전체가 아닙니다"* ]]
unsupported="$(printf '%s' '{"observed_at":"2026-11-18T00:00:00Z","issues":[{"key":"RPL-1","fields":{"issuelinks":[{"type":{"name":"Duplicate"},"outwardIssue":{"key":"RPL-2"}}]}}]}' | node "$root/scripts/oh-my-ai.mjs" work-view --stdin-json --jira-observations)"
[[ "$unsupported" == *"표시하지 않은 기타 링크 관찰: 1건"* ]]
printf '%s\n' 'Jira observations CLI synthetic PASS'
