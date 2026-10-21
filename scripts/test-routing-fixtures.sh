#!/usr/bin/env bash
set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oh-my-ai-routing.XXXXXX")"
trap 'rm -rf -- "$TMP_ROOT"' EXIT

fail() {
  echo "fixture failure: $*" >&2
  exit 1
}

json_field() {
  local field="$1"
  node -e '
    const fs = require("fs");
    const field = process.argv[1];
    const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
    const value = field.split(".").reduce((current, key) => current?.[key], parsed);
    if (value === null) process.stdout.write("null");
    else if (Array.isArray(value)) process.stdout.write(String(value.length));
    else if (value !== undefined) process.stdout.write(String(value));
  ' "$field"
}

run_work_start_consumer() {
  local index_path="$1"
  local task="$2"
  printf '%s' "$task" \
    | OH_MY_AI_SKILL_INDEX="$index_path" node scripts/work-start-skill-match.mjs --format=json
}

run_prompt_consumer() {
  local index_path="$1"
  local task="$2"
  printf '%s' "$task" \
    | OH_MY_AI_SKILL_INDEX="$index_path" node scripts/prompt-routing-hook.mjs --format=routing-json
}

assert_field() {
  local fixture_id="$1"
  local json="$2"
  local field="$3"
  local expected="$4"
  local actual
  actual="$(printf '%s' "$json" | json_field "$field")"
  [ "$actual" = "$expected" ] || fail "$fixture_id: expected $field=$expected, got $actual"
}

assert_consumer_parity() {
  local fixture_id="$1"
  local index_path="$2"
  local task="$3"
  local work_json prompt_json
  local field

  work_json="$(run_work_start_consumer "$index_path" "$task")"
  prompt_json="$(run_prompt_consumer "$index_path" "$task")"
  for field in routing_status routing_error_code; do
    [ "$(printf '%s' "$work_json" | json_field "$field")" = "$(printf '%s' "$prompt_json" | json_field "$field")" ] \
      || fail "$fixture_id: consumers disagree on $field"
  done
}

valid_index="$TMP_ROOT/valid.json"
ambiguous_index="$TMP_ROOT/ambiguous.json"
multiple_index="$TMP_ROOT/multiple.json"
malformed_index="$TMP_ROOT/malformed.json"
invalid_shape_index="$TMP_ROOT/invalid-shape.json"
missing_metadata_index="$TMP_ROOT/missing-metadata.json"
partial_metadata_index="$TMP_ROOT/partial-metadata.json"
unsupported_index="$TMP_ROOT/unsupported.json"
missing_index="$TMP_ROOT/does-not-exist.json"

printf '%s\n' '{"schema_version":1,"skills":[{"name":"alpha","path":"skills/alpha/SKILL.md","routing":{"visibility":"contextual","risk_level":"low","task_types":["test"],"triggers":[{"kind":"keyword","values":["alpha"]}]}}]}' > "$valid_index"
printf '%s\n' '{"schema_version":1,"skills":[{"name":"alpha","routing":{"visibility":"contextual","risk_level":"low","task_types":["test"],"triggers":[{"kind":"keyword","values":["shared"]}]}},{"name":"beta","routing":{"visibility":"contextual","risk_level":"low","task_types":["test"],"triggers":[{"kind":"keyword","values":["shared"]}]}}]}' > "$ambiguous_index"
printf '%s\n' '{"schema_version":1,"skills":[{"name":"alpha","routing":{"visibility":"contextual","risk_level":"low","task_types":["test"],"triggers":[{"kind":"keyword","values":["alpha","shared"]}]}},{"name":"beta","routing":{"visibility":"contextual","risk_level":"low","task_types":["test"],"triggers":[{"kind":"keyword","values":["shared"]}]}}]}' > "$multiple_index"
printf '%s\n' '{"schema_version":1,"skills":[' > "$malformed_index"
printf '%s\n' '{"schema_version":1,"skills":{}}' > "$invalid_shape_index"
printf '%s\n' '{"schema_version":1,"skills":[{"name":"missing-routing"},{"routing":{"visibility":"contextual"}}]}' > "$missing_metadata_index"
printf '%s\n' '{"schema_version":1,"skills":[{"name":"alpha","routing":{"visibility":"contextual","risk_level":"low","task_types":["test"],"triggers":[{"kind":"keyword","values":["alpha"]}]}},{"name":"broken"}]}' > "$partial_metadata_index"
printf '%s\n' '{"schema_version":1,"skills":[{"name":"intent-only","routing":{"visibility":"contextual","risk_level":"low","task_types":["test"],"triggers":[{"kind":"intent","values":["unsupported"]}]}}]}' > "$unsupported_index"

work_json="$(run_work_start_consumer "$valid_index" "nothing relevant")"
prompt_json="$(run_prompt_consumer "$valid_index" "nothing relevant")"
for json in "$work_json" "$prompt_json"; do
  assert_field "FX-RT-001" "$json" routing_status no_match
  assert_field "FX-RT-001" "$json" routing_error_code null
  assert_field "FX-RT-001" "$json" skill_candidates 0
  assert_field "FX-RT-001" "$json" warnings 0
done
echo "passed: FX-RT-001 normal-index-no-match"

work_json="$(run_work_start_consumer "$valid_index" "alpha")"
assert_field "FX-RT-002" "$work_json" routing_status matched
assert_field "FX-RT-002" "$work_json" skill_candidates 1
echo "passed: FX-RT-002 normal-index-match"

work_json="$(run_work_start_consumer "$ambiguous_index" "shared")"
assert_field "FX-RT-003" "$work_json" routing_status ambiguous
assert_field "FX-RT-003" "$work_json" skill_candidates 2
echo "passed: FX-RT-003 ambiguous"

work_json="$(run_work_start_consumer "$multiple_index" "alpha shared")"
assert_field "FX-RT-004" "$work_json" routing_status multiple_candidates
assert_field "FX-RT-004" "$work_json" skill_candidates 2
echo "passed: FX-RT-004 multiple-candidates"

for consumer in work prompt; do
  if [ "$consumer" = "work" ]; then
    json="$(run_work_start_consumer "$missing_index" "alpha")"
  else
    json="$(run_prompt_consumer "$missing_index" "alpha")"
  fi
  assert_field "FX-RT-010" "$json" routing_status unavailable
  assert_field "FX-RT-010" "$json" routing_error_code broken_index
  assert_field "FX-RT-010" "$json" skill_candidates 0
done
echo "passed: FX-RT-010 missing-index"

work_json="$(run_work_start_consumer "$malformed_index" "alpha")"
assert_field "FX-RT-011" "$work_json" routing_status unavailable
assert_field "FX-RT-011" "$work_json" routing_error_code broken_index
assert_field "FX-RT-011" "$work_json" skill_candidates 0
echo "passed: FX-RT-011 malformed-json"

work_json="$(run_work_start_consumer "$missing_metadata_index" "alpha")"
assert_field "FX-RT-012" "$work_json" routing_status unavailable
assert_field "FX-RT-012" "$work_json" routing_error_code missing_metadata
assert_field "FX-RT-012" "$work_json" skill_candidates 0
echo "passed: FX-RT-012 all-metadata-missing"

work_json="$(run_work_start_consumer "$partial_metadata_index" "alpha")"
assert_field "FX-RT-013" "$work_json" routing_status matched
assert_field "FX-RT-013" "$work_json" routing_error_code null
assert_field "FX-RT-013" "$work_json" skill_candidates 1
assert_field "FX-RT-013" "$work_json" warnings 1
echo "passed: FX-RT-013 partial-metadata"

work_json="$(run_work_start_consumer "$invalid_shape_index" "alpha")"
assert_field "FX-RT-014" "$work_json" routing_status unavailable
assert_field "FX-RT-014" "$work_json" routing_error_code broken_index
assert_field "FX-RT-014" "$work_json" skill_candidates 0
echo "passed: FX-RT-014 invalid-skills-shape"

work_json="$(run_work_start_consumer "$unsupported_index" "unsupported")"
assert_field "FX-RT-015" "$work_json" routing_status unavailable
assert_field "FX-RT-015" "$work_json" routing_error_code unsupported_trigger
assert_field "FX-RT-015" "$work_json" skill_candidates 0
echo "passed: FX-RT-015 unsupported-trigger"

for index_path in "$malformed_index" "$missing_metadata_index"; do
  for consumer in work prompt; do
    if [ "$consumer" = "work" ]; then
      json="$(run_work_start_consumer "$index_path" "alpha")"
    else
      json="$(run_prompt_consumer "$index_path" "alpha")"
    fi
    assert_field "FX-RT-020" "$json" skill_candidates 0
  done
done
echo "passed: FX-RT-020 false-candidate-prevention"

assert_consumer_parity "FX-RT-030/no-match" "$valid_index" "nothing relevant"
assert_consumer_parity "FX-RT-030/broken-index" "$malformed_index" "alpha"
assert_consumer_parity "FX-RT-030/missing-metadata" "$missing_metadata_index" "alpha"
assert_consumer_parity "FX-RT-030/partial-metadata" "$partial_metadata_index" "alpha"
echo "passed: FX-RT-030 consumer-status-parity"

# The generated Skill index must route an explicit Jira Create request to the
# optional workflow without invoking it or claiming any Jira mutation.
real_index="$REPO/skills/skill-index.json"
work_json="$(run_work_start_consumer "$real_index" "이 작업 Jira 티켓으로 만들어줘")"
prompt_json="$(run_prompt_consumer "$real_index" "이 작업 Jira 티켓으로 만들어줘")"
assert_field "FX-RT-040" "$work_json" routing_status matched
assert_field "FX-RT-040" "$work_json" skill_candidates 1
assert_consumer_parity "FX-RT-040" "$real_index" "이 작업 Jira 티켓으로 만들어줘"
printf '%s' "$work_json" | node -e '
  const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (input.skill_candidates?.[0]?.name !== "jira-ticket") process.exit(1);
' || fail "FX-RT-040: expected jira-ticket candidate"
echo "passed: FX-RT-040-explicit-jira-create-routing"

# Route substantial multi-service requests while leaving simple questions and
# local fixes without a candidate. Keep this Skill-specific so broad keywords
# such as "acceptance criteria" do not cause false positives.
english_feature_request="I want to add a new subscription billing module across several services. The requirements and acceptance criteria are unclear; first review source of truth, surface Owner decisions, and define criteria before coding. Do not edit files."
korean_feature_request="큰 구독 결제 기능을 여러 서비스에 추가하면서 요구사항과 인수 기준을 먼저 정의하고 Owner 결정을 정리한 뒤 구현해줘."
simple_concept_question="What are acceptance criteria? How are they different from requirements?"
small_fix_request="Fix this typo in one label."

work_json="$(run_work_start_consumer "$real_index" "$english_feature_request")"
prompt_json="$(run_prompt_consumer "$real_index" "$english_feature_request")"
for json in "$work_json" "$prompt_json"; do
  assert_field "FX-RT-050/english-substantial-change" "$json" routing_status matched
  assert_field "FX-RT-050/english-substantial-change" "$json" skill_candidates 1
  printf '%s' "$json" | node -e '
    const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (input.skill_candidates?.[0]?.name !== "spec-to-implementation") process.exit(1);
  ' || fail "FX-RT-050/english-substantial-change: expected spec-to-implementation candidate"
done
assert_consumer_parity "FX-RT-050/english-substantial-change" "$real_index" "$english_feature_request"
echo "passed: FX-RT-050/english-substantial-change"

work_json="$(run_work_start_consumer "$real_index" "$korean_feature_request")"
prompt_json="$(run_prompt_consumer "$real_index" "$korean_feature_request")"
for json in "$work_json" "$prompt_json"; do
  assert_field "FX-RT-050/korean-regression" "$json" routing_status matched
  assert_field "FX-RT-050/korean-regression" "$json" skill_candidates 1
  printf '%s' "$json" | node -e '
    const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (input.skill_candidates?.[0]?.name !== "spec-to-implementation") process.exit(1);
  ' || fail "FX-RT-050/korean-regression: expected spec-to-implementation candidate"
done
assert_consumer_parity "FX-RT-050/korean-regression" "$real_index" "$korean_feature_request"
echo "passed: FX-RT-050/korean-regression"

for prompt in "$simple_concept_question" "$small_fix_request"; do
  if [ "$prompt" = "$simple_concept_question" ]; then
    fixture_id="FX-RT-050/english-simple-question"
  else
    fixture_id="FX-RT-050/small-fix"
  fi
  work_json="$(run_work_start_consumer "$real_index" "$prompt")"
  prompt_json="$(run_prompt_consumer "$real_index" "$prompt")"
  for json in "$work_json" "$prompt_json"; do
    assert_field "$fixture_id" "$json" routing_status no_match
    assert_field "$fixture_id" "$json" skill_candidates 0
  done
  assert_consumer_parity "$fixture_id" "$real_index" "$prompt"
  echo "passed: $fixture_id"
done

# Regressions for multi-signal English requests: the old one-phrase
# "across several services" keyword missed common large-feature requests and
# incorrectly routed conceptual questions mentioning cross-service systems.
english_build_request="Build a multi-tenant billing platform. First establish its requirements and acceptance criteria, then implement it."
english_design_request="Before coding, the requirements and acceptance criteria need review; please design a new identity feature."
for task in "$english_build_request" "$english_design_request"; do
  work_json="$(run_work_start_consumer "$real_index" "$task")"
  prompt_json="$(run_prompt_consumer "$real_index" "$task")"
  for json in "$work_json" "$prompt_json"; do
    assert_field "FX-RT-051/english-substantial-without-across" "$json" routing_status matched
    assert_field "FX-RT-051/english-substantial-without-across" "$json" skill_candidates 1
    printf '%s' "$json" | node -e '
      const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
      if (input.skill_candidates?.[0]?.name !== "spec-to-implementation") process.exit(1);
    ' || fail "FX-RT-051: expected spec-to-implementation"
  done
  assert_consumer_parity "FX-RT-051" "$real_index" "$task"
done
echo "passed: FX-RT-051 english multi-signal substantial change"

for task in "What are the approaches for monitoring retries across several services?" \
            "How should I handle retries across several services?" \
            "What are requirements and acceptance criteria for designing a system?" \
            "Can you explain requirements and acceptance criteria for building an app?"; do
  work_json="$(run_work_start_consumer "$real_index" "$task")"
  prompt_json="$(run_prompt_consumer "$real_index" "$task")"
  for json in "$work_json" "$prompt_json"; do
    assert_field "FX-RT-052/false-positive-prevention" "$json" routing_status no_match
    assert_field "FX-RT-052/false-positive-prevention" "$json" skill_candidates 0
  done
  assert_consumer_parity "FX-RT-052" "$real_index" "$task"
done
echo "passed: FX-RT-052 no false-positive on cross-service / concept question"


# Multi-line requirements, reversed phrasing, explicit no-implementation and
# explanatory requests test recommendation only, never Skill execution/consent.
for task in \
  "Design a payment platform.
Write the requirements and acceptance criteria before coding." \
  "Implement the billing module after reviewing the acceptance criteria and requirements."; do
  work_json="$(run_work_start_consumer "$real_index" "$task")"
  prompt_json="$(run_prompt_consumer "$real_index" "$task")"
  for json in "$work_json" "$prompt_json"; do
    assert_field "FX-RT-053/positive" "$json" routing_status matched
    assert_field "FX-RT-053/positive" "$json" skill_candidates 1
    printf '%s' "$json" | node -e '
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      if (d.skill_candidates?.[0]?.name !== "spec-to-implementation") process.exit(1);
    ' || fail "FX-RT-053: expected spec-to-implementation candidate"
  done
  assert_consumer_parity "FX-RT-053" "$real_index" "$task"
done
echo "passed: FX-RT-053 multiline-and-order-reversal"

for task in \
  "Please do not implement a billing system; instead explain requirements and acceptance criteria." \
  "Do not build a billing system. Write the requirements and acceptance criteria?" \
  "Could you walk me through how to build a module with requirements and acceptance criteria?"; do
  work_json="$(run_work_start_consumer "$real_index" "$task")"
  prompt_json="$(run_prompt_consumer "$real_index" "$task")"
  for json in "$work_json" "$prompt_json"; do
    assert_field "FX-RT-054/negative" "$json" routing_status no_match
    assert_field "FX-RT-054/negative" "$json" skill_candidates 0
  done
  assert_consumer_parity "FX-RT-054" "$real_index" "$task"
done
echo "passed: FX-RT-054 explicit-negation-and-explanatory-question"

echo "all routing fixtures passed"
