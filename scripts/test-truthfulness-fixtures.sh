#!/usr/bin/env bash
set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO"

VALIDATOR="$REPO/scripts/validate-truthfulness.mjs"

cleanup_dirs=()
cleanup() {
  for d in "${cleanup_dirs[@]:-}"; do
    case "$d" in
      */oh-my-ai-truthfulness-fixture.*) [ -d "$d" ] && rm -rf -- "$d" ;;
    esac
  done
}
trap cleanup EXIT

fail() {
  echo "fixture failure: $*" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "missing file: $1"
}

sandbox() {
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/oh-my-ai-truthfulness-fixture.XXXXXX")"
  cleanup_dirs+=("$dir")
  printf -v "$1" '%s' "$dir"
}

expect_valid() {
  local id="$1" claim="$2" label="$3"
  if ! node "$VALIDATOR" "$id" "$claim" >/dev/null 2>&1; then
    node "$VALIDATOR" "$id" "$claim" || true
    fail "$label: expected valid claim to pass"
  fi
}

expect_invalid() {
  local id="$1" claim="$2" label="$3" expect_substring="$4"
  local out
  if out="$(node "$VALIDATOR" "$id" "$claim" 2>&1)"; then
    fail "$label: expected invalid claim to be rejected"
  fi
  case "$out" in
    *"$expect_substring"*) ;;
    *) fail "$label: expected error containing '$expect_substring', got: $out" ;;
  esac
}

# --- FX-TR-001 Observed vs Inferred ------------------------------------------

fx_tr_001() {
  expect_valid "FX-TR-001" '{"kind":"observed","evidence":"grep output line 42"}' "FX-TR-001-observed-with-evidence"
  expect_valid "FX-TR-001" '{"kind":"inferred","evidence":"pattern X seen in 3 files","inference_basis":"consistent naming suggests convention Y"}' "FX-TR-001-inferred-with-basis"
  expect_invalid "FX-TR-001" '{"kind":"observed","evidence":null}' "FX-TR-001-observed-no-evidence" "requires evidence"
  expect_invalid "FX-TR-001" '{"kind":"inferred","evidence":"pattern X seen"}' "FX-TR-001-inferred-no-basis" "requires inference_basis"
  echo "passed: FX-TR-001-observed-vs-inferred"
}

# --- FX-TR-002 Validation Scope Overclaim ------------------------------------

fx_tr_002() {
  local zeros
  printf -v zeros '%0*d' 60000 0
  expect_valid "FX-TR-002" '{"tests_run":5,"tests_total":5,"claimed_status":"full_suite_passed"}' "FX-TR-002-full-run-honest-claim"
  expect_valid "FX-TR-002" '{"tests_run":10.0,"tests_total":1e1,"claimed_status":"full_suite_passed"}' "FX-TR-002-exact-integer-forms"
  expect_valid "FX-TR-002" '{"tests_run":1.000e3,"tests_total":100000e-2,"claimed_status":"full_suite_passed"}' "FX-TR-002-exact-scaled-integers"
  expect_valid "FX-TR-002" '{"tests_run":9007199254740991.0000,"tests_total":9007199254740991,"claimed_status":"full_suite_passed"}' "FX-TR-002-largest-safe-count"
  expect_valid "FX-TR-002" '{"tests_run":2,"tests_total":5,"claimed_status":"partial_scope"}' "FX-TR-002-partial-run-honest-claim"
  expect_valid "FX-TR-002" '{"tests_run":0,"tests_total":0,"claimed_status":"partial_scope"}' "FX-TR-002-no-tests-not-a-pass"
  expect_invalid "FX-TR-002" '{"tests_run":2,"tests_total":5,"claimed_status":"full_suite_passed"}' "FX-TR-002-partial-run-overclaim" "Validation Scope Overclaim"
  expect_invalid "FX-TR-002" '{"tests_run":"9","tests_total":"10","claimed_status":"full_suite_passed"}' "FX-TR-002-string-counts-overclaim" "Validation Scope Overclaim"
  expect_invalid "FX-TR-002" '{"tests_run":0,"tests_total":0,"claimed_status":"full_suite_passed"}' "FX-TR-002-empty-suite-overclaim" "Validation Scope Overclaim"
  expect_invalid "FX-TR-002" '{"tests_run":6,"tests_total":5,"claimed_status":"full_suite_passed"}' "FX-TR-002-inconsistent-counts-overclaim" "Validation Scope Overclaim"
  expect_invalid "FX-TR-002" '{"tests_run":1.5,"tests_total":1.5,"claimed_status":"full_suite_passed"}' "FX-TR-002-fractional-counts" "Validation Scope Overclaim"
  expect_invalid "FX-TR-002" '{"tests_run":9.9999999999999999,"tests_total":10,"claimed_status":"full_suite_passed"}' "FX-TR-002-fraction-rounded-up" "Validation Scope Overclaim"
  expect_invalid "FX-TR-002" '{"tests_run":10,"tests_total":1.00000000000000001e1,"claimed_status":"full_suite_passed"}' "FX-TR-002-exponent-fraction-rounded-down" "Validation Scope Overclaim"
  expect_invalid "FX-TR-002" '{"tests_run":9007199254740991,"tests_total":9007199254740991.1,"claimed_status":"full_suite_passed"}' "FX-TR-002-fraction-rounds-to-largest-safe-count" "Validation Scope Overclaim"
  expect_invalid "FX-TR-002" '{"tests_\u0072un":9.9999999999999999,"nested":{"tests_run":10},"tests_total":10,"claimed_status":"full_suite_passed"}' "FX-TR-002-nested-count-cannot-override-root-token" "Validation Scope Overclaim"
  expect_valid "FX-TR-002" "{\"tests_run\":10.${zeros},\"tests_total\":10,\"claimed_status\":\"full_suite_passed\"}" "FX-TR-002-long-integer-tail"
  expect_invalid "FX-TR-002" "{\"tests_run\":10.${zeros}1,\"tests_total\":10,\"claimed_status\":\"full_suite_passed\"}" "FX-TR-002-long-fraction-tail" "Validation Scope Overclaim"
  expect_invalid "FX-TR-002" '{"tests_run":true,"tests_total":1,"claimed_status":"full_suite_passed"}' "FX-TR-002-boolean-count" "Validation Scope Overclaim"
  expect_invalid "FX-TR-002" '{"tests_run":9007199254740992,"tests_total":9007199254740992,"claimed_status":"full_suite_passed"}' "FX-TR-002-imprecise-counts" "Validation Scope Overclaim"
  echo "passed: FX-TR-002-validation-scope-overclaim"
}

# --- FX-TR-003 Unknown Repository State --------------------------------------

fx_tr_003() {
  expect_valid "FX-TR-003" '{"confirmed":true,"reported_value":"abc1234"}' "FX-TR-003-confirmed-value"
  expect_valid "FX-TR-003" '{"confirmed":false,"reported_value":"unknown"}' "FX-TR-003-unconfirmed-honest"
  expect_invalid "FX-TR-003" '{"confirmed":false,"reported_value":"main"}' "FX-TR-003-unconfirmed-fabricated" "reported_value is 'main' instead of 'unknown'"
  echo "passed: FX-TR-003-unknown-repository-state"
}

# --- FX-TR-004 Worker Claim Only ---------------------------------------------

fx_tr_004() {
  expect_valid "FX-TR-004" '{"evidence_ref":"CAP-E-01","status":"verified"}' "FX-TR-004-verified-with-evidence"
  expect_valid "FX-TR-004" '{"evidence_ref":null,"status":"worker_claim_only"}' "FX-TR-004-honest-claim-only"
  expect_invalid "FX-TR-004" '{"evidence_ref":null,"status":"verified"}' "FX-TR-004-unverified-promoted" "must be 'worker_claim_only'"
  echo "passed: FX-TR-004-worker-claim-only"
}

# --- FX-TR-005 (Supplementary) Decision not auto-promoted --------------------

fx_tr_005() {
  expect_valid "FX-TR-005" '{"human_reviewed":true,"decision_status":"confirmed_decision"}' "FX-TR-005-human-approved-decision"
  expect_valid "FX-TR-005" '{"human_reviewed":false,"decision_status":"decision_candidate"}' "FX-TR-005-honest-candidate"
  expect_invalid "FX-TR-005" '{"human_reviewed":false,"decision_status":"confirmed_decision"}' "FX-TR-005-self-promoted-decision" "must not self-promote"
  echo "passed: FX-TR-005-decision-not-auto-promoted"
}

# --- FX-TR-006 (Supplementary) Open Issue / Remaining Risk preserved --------

fx_tr_006() {
  expect_valid "FX-TR-006" '{"known_open_issues_count":2,"reported_open_issues_count":2,"known_remaining_risks_count":1,"reported_remaining_risks_count":1}' "FX-TR-006-preserved"
  expect_valid "FX-TR-006" '{"known_open_issues_count":0,"reported_open_issues_count":0,"known_remaining_risks_count":0,"reported_remaining_risks_count":0}' "FX-TR-006-nothing-to-report"
  expect_invalid "FX-TR-006" '{"known_open_issues_count":2,"reported_open_issues_count":0,"known_remaining_risks_count":0,"reported_remaining_risks_count":0}' "FX-TR-006-open-issues-dropped" "must not be silently dropped"
  expect_invalid "FX-TR-006" '{"known_open_issues_count":0,"reported_open_issues_count":0,"known_remaining_risks_count":1,"reported_remaining_risks_count":0}' "FX-TR-006-risks-dropped" "must not be silently dropped"
  echo "passed: FX-TR-006-open-issue-remaining-risk-preserved"
}

# --- Supplementary: real repository state, not assumed ----------------------
# Exercises the concrete scenarios from the Product Worker task spec (dirty
# working tree, Local/Remote HEAD sync, PR/Merge existence, Capability
# support) against an actual throwaway git repository, so "truthful" is
# checked against observed `git` output, not asserted from memory.

fx_repo_state_dirty_tree() {
  local d
  sandbox d
  git -C "$d" init -q
  git -C "$d" config user.email test@example.com
  git -C "$d" config user.name test
  echo "one" > "$d/file.txt"
  git -C "$d" add file.txt
  git -C "$d" commit -q -m init
  echo "dirty change" >> "$d/file.txt"

  local status
  status="$(git -C "$d" status --porcelain)"
  [ -n "$status" ] || fail "repo-state-dirty-tree: fixture setup did not actually produce a dirty tree"
  # The rule under test: a report claiming "clean" while `git status --porcelain`
  # is non-empty is a Truthfulness violation, identical in shape to FX-TR-003.
  expect_invalid "FX-TR-003" "{\"confirmed\":false,\"reported_value\":\"clean\"}" "repo-state-dirty-tree-claimed-clean-without-checking" "instead of 'unknown'"
  # Correct behavior: actually check, then report the observed truth.
  local reported
  if [ -n "$status" ]; then reported="dirty"; else reported="clean"; fi
  [ "$reported" = "dirty" ] || fail "repo-state-dirty-tree: observed state check itself is wrong"
  echo "passed: FX-supplementary-repo-state-dirty-tree"
}

fx_repo_state_head_sync() {
  local d
  sandbox d
  git -C "$d" init -q
  git -C "$d" config user.email test@example.com
  git -C "$d" config user.name test
  echo "one" > "$d/file.txt"
  git -C "$d" add file.txt
  git -C "$d" commit -q -m init
  # No remote configured at all: Remote HEAD is genuinely unconfirmable here.
  local remote_head
  remote_head="$(git -C "$d" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>&1)" || remote_head=""
  [ -z "$remote_head" ] || fail "repo-state-head-sync: fixture setup unexpectedly has an upstream"
  # Claiming "synced" without ever having checked for an upstream is exactly
  # the FX-TR-003 shape: an unconfirmed value must be reported as unknown.
  expect_invalid "FX-TR-003" '{"confirmed":false,"reported_value":"synced"}' "repo-state-head-sync-claimed-synced" "instead of 'unknown'"
  echo "passed: FX-supplementary-repo-state-head-sync"
}

fx_repo_state_pr_merge() {
  # No PR/Merge exists yet in this fixture's frame; claiming complete anyway
  # is the same "confirmed=false but reported as if confirmed" shape.
  expect_invalid "FX-TR-003" '{"confirmed":false,"reported_value":"merged"}' "repo-state-pr-merge-claimed-without-checking" "instead of 'unknown'"
  expect_valid "FX-TR-003" '{"confirmed":false,"reported_value":"unknown"}' "repo-state-pr-merge-honest"
  echo "passed: FX-supplementary-repo-state-pr-merge"
}

fx_repo_state_capability_supported() {
  # A Runtime Capability that was never independently verified must not be
  # reported "verified"/"supported" -- same shape as FX-TR-004.
  expect_invalid "FX-TR-004" '{"evidence_ref":null,"status":"verified"}' "repo-state-capability-unverified-claimed-supported" "must be 'worker_claim_only'"
  echo "passed: FX-supplementary-repo-state-capability-supported"
}

# --- run everything ----------------------------------------------------------

require_file "$VALIDATOR"

fx_tr_001
fx_tr_002
fx_tr_003
fx_tr_004
fx_tr_005
fx_tr_006
fx_repo_state_dirty_tree
fx_repo_state_head_sync
fx_repo_state_pr_merge
fx_repo_state_capability_supported

echo "all Truthfulness fixtures passed"
