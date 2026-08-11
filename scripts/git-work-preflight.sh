#!/usr/bin/env bash
set -euo pipefail

repository=""
canonical_repository=""
push_remote=""
expected_base_branch=""
expected_base_sha=""
expected_branch_name=""
issue_key=""
execution_policy=""
consumer=""
provided_evidence=""

repository_verification='NOT_VERIFIABLE'
canonical_repository_verification='NOT_CHECKED'
push_remote_verification='NOT_CHECKED'
remote_verification='NOT_CHECKED'
feature_remote_verification='NOT_CHECKED'
current_branch='NOT_CHECKED'
current_head='NOT_CHECKED'
cached_remote_tracking_base_sha='NOT_CHECKED'
actual_remote_base_sha='NOT_CHECKED'
cached_remote_tracking_feature_sha='NOT_CHECKED'
actual_remote_feature_sha='NOT_CHECKED'
feature_integration_point='NOT_CHECKED'
local_base_sha='NOT_CHECKED'
remote_base_sha='NOT_CHECKED'
working_tree_status='NOT_CHECKED'
tracked_status='NOT_CHECKED'
staged_status='NOT_CHECKED'
unmerged_status='NOT_CHECKED'
untracked_local_state='NOT_CHECKED'
ignored_local_state='NOT_CHECKED'
local_branch_status='NOT_CHECKED'
remote_branch_status='NOT_CHECKED'
pr_status='NOT_CHECKED'
issue_association_status='NOT_REQUIRED'
ancestry_status='NOT_CHECKED'
local_branch_tip='NOT_CHECKED'
remote_branch_tip='NOT_CHECKED'
candidate_tip_evidence='NOT_CHECKED'
unique_feature_commits='NOT_CHECKED'
existing_work_state='NONE'
executed_evidence='NOT_CHECKED'
unexecuted_checks='Required checks not reached; per-field status is authoritative'

usage() {
  cat <<'USAGE'
usage: scripts/git-work-preflight.sh \
  --repository <path> \
  --canonical-repository <owner/repo> \
  --push-remote <name> \
  --expected-base-branch <name> \
  --execution-policy <suggest-only|patch-with-approval|auto-apply> \
  --consumer <work-start|jira-work|manual-review> \
  [--expected-base-sha <sha>] \
  [--expected-branch-name <candidate>] \
  [--issue-key <key>] \
  [--provided-evidence <reference>]
USAGE
}

# Keep every caller-supplied value on one physical report line.  Escaping
# control characters, headings, and field separators prevents evidence from
# manufacturing report fields while preserving enough text for review.
safe_report_value() {
  local value="${1:-}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\n'/\\n}"
  value="${value//:/\\:}"
  value="${value//#/\\#}"
  printf '%s' "$value" | LC_ALL=C tr '\000-\037\177' '?'
}

report_field() {
  printf '%s: %s\n' "$1" "$(safe_report_value "$2")"
}

append_executed() {
  if [ "$executed_evidence" = 'NOT_CHECKED' ]; then
    executed_evidence="$1"
  else
    executed_evidence="${executed_evidence}; $1"
  fi
}

# This is the sole status -> Blocking -> process-exit mapping.  Only a READY
# result may exit successfully; every recovery, conflict, or unverifiable
# result is intentionally non-zero.
result_policy() {
  case "$1" in
    READY_NEW_WORK|READY_RESUME) printf '%s\n' 'false 0' ;;
    RECOVERY_REQUIRED|BLOCKED_DIRTY_TREE|BLOCKED_BASE_MISMATCH|BLOCKED_DIVERGENCE|ALREADY_MERGED|CONFLICTED|NOT_VERIFIABLE) printf '%s\n' 'true 2' ;;
    *) printf '%s\n' 'true 2' ;;
  esac
}

report() {
  local result="$1" blocking="$2" next_step="$3" blocking_items="$4" exit_code="$5"
  printf '%s\n' '# Git Work Preflight Report'
  report_field 'Consumer' "${consumer:-NOT_PROVIDED}"
  report_field 'Issue Key' "${issue_key:-NOT_PROVIDED}"
  report_field 'Execution Policy' "${execution_policy:-NOT_PROVIDED}"
  report_field 'Repository' "${repository:-NOT_PROVIDED}"
  report_field 'Repository Verification' "$repository_verification"
  report_field 'Canonical Repository' "${canonical_repository:-NOT_PROVIDED}"
  report_field 'Canonical Repository Verification' "$canonical_repository_verification"
  report_field 'Push Remote' "${push_remote:-NOT_PROVIDED}"
  report_field 'Push Remote Verification' "$push_remote_verification"
  report_field 'Canonical Base Verification' "$remote_verification"
  report_field 'Push Remote Feature Verification' "$feature_remote_verification"
  report_field 'Current Branch' "$current_branch"
  report_field 'Current HEAD' "$current_head"
  report_field 'Expected Base Branch' "${expected_base_branch:-NOT_PROVIDED}"
  report_field 'Expected Base SHA' "${expected_base_sha:-NOT_PROVIDED}"
  report_field 'Cached Push-remote Base SHA' "$cached_remote_tracking_base_sha"
  report_field 'Authoritative Base SHA' "$actual_remote_base_sha"
  report_field 'Cached Push-remote Feature SHA' "$cached_remote_tracking_feature_sha"
  report_field 'Actual Push-remote Feature SHA' "$actual_remote_feature_sha"
  report_field 'Feature Integration Point' "$feature_integration_point"
  report_field 'Local Base SHA' "$local_base_sha"
  report_field 'Working Tree Status' "$working_tree_status"
  report_field 'Tracked Status' "$tracked_status"
  report_field 'Staged Status' "$staged_status"
  report_field 'Unmerged Status' "$unmerged_status"
  report_field 'Untracked Local State' "$untracked_local_state"
  report_field 'Ignored Local State' "$ignored_local_state"
  report_field 'Expected Branch Candidate' "${expected_branch_name:-NOT_PROVIDED}"
  report_field 'Local Branch Status' "$local_branch_status"
  report_field 'Remote Branch Status' "$remote_branch_status"
  report_field 'PR Status' "$pr_status"
  report_field 'Issue Association Status' "$issue_association_status"
  report_field 'Candidate Tip Evidence' "$candidate_tip_evidence"
  report_field 'Unique Feature Commits' "$unique_feature_commits"
  report_field 'Ancestry Status' "$ancestry_status"
  report_field 'Executed Evidence' "$executed_evidence"
  report_field 'Provided Evidence' "${provided_evidence:-NONE}"
  report_field 'Supplied Evidence' "${provided_evidence:-NONE}"
  report_field 'Unexecuted Checks' "$unexecuted_checks"
  report_field 'Mutation Safety' 'Read-only / Mutation 0'
  report_field 'Existing Work A-H' "$existing_work_state"
  report_field 'Preflight Result' "$result"
  report_field 'Blocking' "$blocking"
  report_field 'Blocking Items' "$blocking_items"
  report_field 'Allowed Next Step' "$next_step"
  report_field 'Mutation' '0'
  report_field 'Process Exit Code' "$exit_code"
  report_field 'Prohibited Actions' 'Branch Creation; Checkout; Reset; Restore; Stash; Clean; Merge; Rebase; Pull; Commit and Push; Draft PR; PR Edit; PR Merge; Release; Tag; Deploy; Migration; Secret change'
  report_field 'Unavailable Capabilities' 'Branch Creation; Checkout; Implementation; Verification Execution; Commit and Push; Draft PR; Jira Comment and Transition; Merge; Release; Tag; Deploy; Migration; Secret change'
}

finish() {
  local result="$1" next_step="$2" blocking_items="$3" blocking exit_code
  read -r blocking exit_code <<< "$(result_policy "$result")"
  report "$result" "$blocking" "$next_step" "$blocking_items" "$exit_code"
  exit "$exit_code"
}

hard_stop() {
  finish "$1" STOP "$2"
}

require_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || { usage >&2; exit 2; }
}

safe_ref_component() {
  case "$1" in
    ''|-*|/*|*'..'*|*'@{'*|*' '*|*'~'*|*'^'*|*':'*|*'?'*|*'['*|*'\\'*|*'*'*|*'//'*|*/.|*.lock) return 1 ;;
    *) return 0 ;;
  esac
}

evidence_has_marker() {
  local marker="$1"
  printf '%s' "$provided_evidence" | tr ',' '\n' | grep -F -x -q -- "$marker"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repository)
      require_value "$@"
      [ -z "$repository" ] || hard_stop NOT_VERIFIABLE 'Multiple Repository values are not supported'
      repository="$2"
      shift 2
      ;;
    --canonical-repository)
      require_value "$@"
      [ -z "$canonical_repository" ] || hard_stop NOT_VERIFIABLE 'Canonical Repository was supplied more than once'
      canonical_repository="$2"
      shift 2
      ;;
    --push-remote)
      require_value "$@"
      [ -z "$push_remote" ] || hard_stop NOT_VERIFIABLE 'Push Remote was supplied more than once'
      push_remote="$2"
      shift 2
      ;;
    --expected-base-branch)
      require_value "$@"
      [ -z "$expected_base_branch" ] || hard_stop NOT_VERIFIABLE 'Expected Base Branch was supplied more than once'
      expected_base_branch="$2"
      shift 2
      ;;
    --expected-base-sha)
      require_value "$@"
      expected_base_sha="$2"
      shift 2
      ;;
    --expected-branch-name)
      require_value "$@"
      expected_branch_name="$2"
      shift 2
      ;;
    --issue-key)
      require_value "$@"
      issue_key="$2"
      shift 2
      ;;
    --execution-policy)
      require_value "$@"
      execution_policy="$2"
      shift 2
      ;;
    --consumer)
      require_value "$@"
      consumer="$2"
      shift 2
      ;;
    --provided-evidence)
      require_value "$@"
      provided_evidence="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [ -x "$HOME/.local/bin/harness-event" ]; then
  "$HOME/.local/bin/harness-event" emit skill-start \
    --skill git-work-preflight \
    --runtime "${HARNESS_RUNTIME:-codex}" \
    || true
fi

[ -n "$repository" ] || hard_stop NOT_VERIFIABLE 'Repository Required'
[ -n "$canonical_repository" ] || hard_stop NOT_VERIFIABLE 'Canonical Repository Required'
[ -n "$push_remote" ] || hard_stop NOT_VERIFIABLE 'Push Remote Required'
[ -n "$expected_base_branch" ] || hard_stop NOT_VERIFIABLE 'Base Branch Required'
[ -n "$execution_policy" ] || hard_stop NOT_VERIFIABLE 'Execution Policy Required'
[ -n "$consumer" ] || hard_stop NOT_VERIFIABLE 'Consumer Required'

case "$execution_policy" in
  suggest-only|patch-with-approval|auto-apply) ;;
  *) hard_stop NOT_VERIFIABLE 'Execution Policy is not supported' ;;
esac
case "$consumer" in
  work-start|jira-work|manual-review) ;;
  *) hard_stop NOT_VERIFIABLE 'Consumer is not supported' ;;
esac
if [ "$consumer" = 'jira-work' ] && [ -z "$issue_key" ]; then
  issue_association_status='MISSING_ISSUE_KEY'
  unexecuted_checks='Jira Issue-to-Branch association=NOT_EXECUTED (Issue Key not supplied); Git and GitHub checks=NOT_EXECUTED'
  hard_stop NOT_VERIFIABLE 'Issue Key is required for jira-work'
fi
safe_ref_component "$expected_base_branch" || hard_stop NOT_VERIFIABLE 'Expected Base Branch is unsafe'
[[ "$canonical_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || hard_stop NOT_VERIFIABLE 'Canonical Repository is unsafe'
[[ "$push_remote" =~ ^[A-Za-z0-9._-]+$ ]] || hard_stop NOT_VERIFIABLE 'Push Remote is unsafe'
if [ -n "$expected_branch_name" ]; then
  safe_ref_component "$expected_branch_name" || hard_stop NOT_VERIFIABLE 'Expected Branch Candidate is unsafe'
fi
case "$repository" in -*) hard_stop NOT_VERIFIABLE 'Repository path is unsafe' ;; esac

repo_root="$(git -C "$repository" rev-parse --show-toplevel 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Repository cannot be verified'
repository="$repo_root"
repository_verification='VERIFIED'
append_executed 'Repository identity=VERIFIED'
current_branch="$(git -C "$repository" rev-parse --abbrev-ref HEAD 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Current Branch cannot be verified'
current_head="$(git -C "$repository" rev-parse HEAD 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Current HEAD cannot be verified'
append_executed 'Current branch and HEAD=VERIFIED'

canonical_repository_json="$(cd "$repository" && gh repo view "$canonical_repository" --json nameWithOwner,defaultBranchRef,url 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Canonical Repository cannot be queried'
canonical_repository_meta="$(printf '%s' "$canonical_repository_json" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const repo = JSON.parse(input);
    if (!repo || typeof repo.nameWithOwner !== "string" || typeof repo.url !== "string" || typeof repo.defaultBranchRef?.name !== "string") throw new Error("incomplete repository response");
    process.stdout.write(`${repo.nameWithOwner}\t${repo.defaultBranchRef.name}\t${repo.url}`);
  } catch (_) {
    process.exitCode = 1;
  }
});
')" || hard_stop NOT_VERIFIABLE 'Canonical Repository response is malformed'
IFS=$'\t' read -r resolved_canonical_repository canonical_default_branch canonical_repository_url <<< "$canonical_repository_meta"
if [ "$resolved_canonical_repository" != "$canonical_repository" ]; then
  canonical_repository_verification='MISMATCH'
  hard_stop CONFLICTED 'Canonical Repository identity does not match the supplied Repository'
fi
canonical_repository_verification='VERIFIED'
append_executed 'Canonical Repository identity=VERIFIED'

push_remote_url="$(git -C "$repository" remote get-url "$push_remote" 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Push Remote cannot be resolved'
[ -n "$push_remote_url" ] || hard_stop NOT_VERIFIABLE 'Push Remote URL is empty'
push_remote_verification='VERIFIED'
append_executed 'Push Remote=VERIFIED'

if cached_remote_tracking_base_sha="$(git -C "$repository" rev-parse --verify "${push_remote}/${expected_base_branch}^{commit}" 2>/dev/null)"; then
  append_executed 'Cached Push Remote Base=QUERIED'
else
  cached_remote_tracking_base_sha='NOT_FOUND'
  append_executed 'Cached Push Remote Base=NOT_FOUND'
fi
actual_base_output="$(git -C "$repository" ls-remote --heads "$canonical_repository_url" "refs/heads/${expected_base_branch}" 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Authoritative Canonical Base cannot be queried'
append_executed 'Authoritative Canonical Base=QUERIED'
if [ -z "$actual_base_output" ] || [ "$(printf '%s\n' "$actual_base_output" | wc -l | tr -d ' ')" -ne 1 ]; then
  remote_verification='NOT_VERIFIABLE'
  hard_stop NOT_VERIFIABLE 'Authoritative Canonical Base must resolve to exactly one ref'
fi
actual_remote_base_sha="${actual_base_output%%$'\t'*}"
actual_base_ref="${actual_base_output#*$'\t'}"
if ! [[ "$actual_remote_base_sha" =~ ^[0-9a-fA-F]{40,64}$ ]] || [ "$actual_base_ref" != "refs/heads/${expected_base_branch}" ]; then
  remote_verification='NOT_VERIFIABLE'
  hard_stop NOT_VERIFIABLE 'Authoritative Canonical Base response is malformed'
fi
remote_verification='VERIFIED'
remote_base_sha="$actual_remote_base_sha"

feature_integration_point="$(git -C "$repository" merge-base HEAD "$actual_remote_base_sha" 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Current HEAD and Actual Remote Base have no verified merge base'
local_base_sha="$feature_integration_point"
append_executed 'Feature integration point=VERIFIED'
if [ -n "$expected_base_sha" ] && { [ "$expected_base_sha" != "$feature_integration_point" ] || [ "$expected_base_sha" != "$actual_remote_base_sha" ]; }; then
  ancestry_status='BASE_SHA_MISMATCH'
  hard_stop BLOCKED_BASE_MISMATCH 'Expected Base SHA does not match Feature Integration Point and Actual Remote Base'
fi

base_counts="$(git -C "$repository" rev-list --left-right --count "${feature_integration_point}...${actual_remote_base_sha}" 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Base ancestry cannot be verified'
read -r local_ahead remote_ahead <<< "$base_counts"
if [ "$local_ahead" != 0 ] || [ "$remote_ahead" != 0 ]; then
  ancestry_status='BASE_MISMATCH'
  hard_stop BLOCKED_BASE_MISMATCH 'Feature Integration Point and Actual Remote Base are not aligned'
fi
ancestry_status='BASE_ALIGNED'
append_executed 'Base ancestry=ALIGNED'

status_output="$(git -C "$repository" status --short --ignored 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Working Tree cannot be verified'
tracked_count=0
staged_count=0
unmerged_count=0
unknown_untracked_count=0
local_state_count=0
ignored_count=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  code="${line:0:2}"
  path="${line:3}"
  case "$code" in
    '??')
      case "$path" in
        .DS_Store|.oh-my-ai|.oh-my-ai/*) local_state_count=$((local_state_count + 1)) ;;
        *) unknown_untracked_count=$((unknown_untracked_count + 1)) ;;
      esac
      ;;
    '!!') ignored_count=$((ignored_count + 1)) ;;
    *U*|UU) unmerged_count=$((unmerged_count + 1)) ;;
    *)
      [ "${code:0:1}" = ' ' ] || staged_count=$((staged_count + 1))
      [ "${code:1:1}" = ' ' ] || tracked_count=$((tracked_count + 1))
      ;;
  esac
done <<< "$status_output"

tracked_status="COUNT=${tracked_count}"
staged_status="COUNT=${staged_count}"
unmerged_status="COUNT=${unmerged_count}"
untracked_local_state="LOCAL_GENERATED=${local_state_count}; UNKNOWN=${unknown_untracked_count}"
ignored_local_state="COUNT=${ignored_count}"
append_executed 'Working Tree=VERIFIED'
if [ "$unmerged_count" -gt 0 ]; then
  working_tree_status='UNMERGED_CONFLICT'
  hard_stop BLOCKED_DIRTY_TREE 'Unmerged conflict is present'
fi
if [ "$staged_count" -gt 0 ]; then
  working_tree_status='STAGED_DIRTY'
  hard_stop BLOCKED_DIRTY_TREE 'Staged modification is present'
fi
if [ "$tracked_count" -gt 0 ]; then
  working_tree_status='TRACKED_DIRTY'
  hard_stop BLOCKED_DIRTY_TREE 'Tracked modification is present'
fi
if [ "$unknown_untracked_count" -gt 0 ]; then
  working_tree_status='UNTRACKED_UNKNOWN'
  hard_stop NOT_VERIFIABLE 'Unknown untracked state requires Repository policy evidence'
fi
if [ "$local_state_count" -gt 0 ]; then
  working_tree_status='UNTRACKED_LOCAL_STATE'
else
  working_tree_status='CLEAN'
fi

if [ -z "$expected_branch_name" ]; then
  hard_stop NOT_VERIFIABLE 'Expected Branch Candidate is not supplied; Branch and PR state were not queried'
fi
if ! evidence_has_marker 'repository-naming-rule-verified'; then
  hard_stop NOT_VERIFIABLE 'Repository naming rule evidence is not verified'
fi

local_branch_output="$(git -C "$repository" branch --list -- "$expected_branch_name" 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Local Branch cannot be queried'
remote_branch_output="$(git -C "$repository" ls-remote --heads "$push_remote" "refs/heads/${expected_branch_name}" 2>/dev/null)" || {
  feature_remote_verification='NOT_VERIFIABLE'
  hard_stop NOT_VERIFIABLE 'Remote Branch cannot be queried'
}
append_executed 'Local and remote Branch presence=VERIFIED'
if [ -n "$local_branch_output" ]; then
  local_branch_status='PRESENT'
else
  local_branch_status='ABSENT'
fi
if [ -n "$remote_branch_output" ]; then
  remote_branch_status='PRESENT'
else
  remote_branch_status='ABSENT'
  actual_remote_feature_sha='NOT_FOUND'
fi

if [ "$local_branch_status" = 'PRESENT' ]; then
  local_branch_tip="$(git -C "$repository" rev-parse --verify "${expected_branch_name}^{commit}" 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Local candidate Branch tip cannot be verified'
fi
if [ "$remote_branch_status" = 'PRESENT' ]; then
  if [ "$(printf '%s\n' "$remote_branch_output" | wc -l | tr -d ' ')" -ne 1 ]; then
    feature_remote_verification='NOT_VERIFIABLE'
    hard_stop NOT_VERIFIABLE 'Actual Remote Issue Branch must resolve to exactly one ref'
  fi
  remote_branch_tip="${remote_branch_output%%$'\t'*}"
  remote_branch_ref="${remote_branch_output#*$'\t'}"
  if ! [[ "$remote_branch_tip" =~ ^[0-9a-fA-F]{40,64}$ ]] || [ "$remote_branch_ref" != "refs/heads/${expected_branch_name}" ]; then
    feature_remote_verification='NOT_VERIFIABLE'
    hard_stop NOT_VERIFIABLE 'Actual Remote Issue Branch response is malformed'
  fi
  actual_remote_feature_sha="$remote_branch_tip"
fi

pr_json="$(cd "$repository" && gh pr list --repo "$canonical_repository" --head "$expected_branch_name" --state all --json state,isDraft,headRefName 2>/dev/null)" || { pr_status='NOT_VERIFIABLE'; hard_stop NOT_VERIFIABLE 'Canonical GitHub PR state cannot be queried'; }
append_executed 'GitHub PR JSON=QUERIED'
pr_status="$(printf '%s' "$pr_json" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const records = JSON.parse(input);
    if (!Array.isArray(records)) throw new Error("PR response is not an array");
    if (records.length === 0) return process.stdout.write("NONE");
    if (records.length !== 1) return process.stdout.write("MULTIPLE");
    const pr = records[0];
    if (!pr || typeof pr.state !== "string" || typeof pr.isDraft !== "boolean" || typeof pr.headRefName !== "string") throw new Error("PR record is incomplete");
    if (pr.headRefName !== process.argv[1]) return process.stdout.write("HEAD_MISMATCH");
    if (pr.state === "MERGED") return process.stdout.write("MERGED");
    if (pr.state === "CLOSED") return process.stdout.write("CLOSED_UNMERGED");
    if (pr.state === "OPEN") return process.stdout.write(pr.isDraft ? "OPEN_DRAFT" : "OPEN_NON_DRAFT");
    throw new Error("PR state is unsupported");
  } catch (_) {
    process.exitCode = 1;
  }
});
' "$expected_branch_name")" || { pr_status='NOT_VERIFIABLE'; hard_stop NOT_VERIFIABLE 'GitHub PR response is malformed or unsupported'; }

# Jira evidence is a mandatory gate for jira-work with an Issue Key.  Do not
# let a Branch, PR, or ancestry conclusion bypass a missing association.
if [ "$consumer" = 'jira-work' ] && [ -n "$issue_key" ]; then
  association_marker="issue-association-verified:${issue_key}:${expected_branch_name}"
  if evidence_has_marker "$association_marker"; then
    issue_association_status='MATCHED'
    append_executed 'Supplied Jira Issue-to-Branch association=MATCHED_BY_CONSUMER'
  elif printf '%s' "$provided_evidence" | tr ',' '\n' | grep -F -q -- 'issue-association-verified:'; then
    issue_association_status='CONFLICTED'
    existing_work_state='H'
    hard_stop CONFLICTED 'Supplied Jira Issue association conflicts with the expected Branch'
  else
    issue_association_status='NOT_PROVIDED'
    hard_stop NOT_VERIFIABLE 'Jira Issue association evidence is not supplied'
  fi
fi

if [ "$pr_status" = 'OPEN_DRAFT' ] && { [ "$local_branch_status" != 'PRESENT' ] || [ "$remote_branch_status" != 'PRESENT' ]; }; then
  existing_work_state='H'
  unique_feature_commits='0'
  hard_stop CONFLICTED 'Canonical Draft PR exists without an aligned Local and Push Remote Issue Branch'
fi

unexecuted_checks='NONE'
if cached_remote_branch_tip="$(git -C "$repository" rev-parse --verify "${push_remote}/${expected_branch_name}^{commit}" 2>/dev/null)"; then
  cached_remote_tracking_feature_sha="$cached_remote_branch_tip"
else
  cached_remote_branch_tip=''
  cached_remote_tracking_feature_sha='NOT_FOUND'
fi
append_executed 'Cached remote-tracking Feature=QUERIED'

if [ "$remote_branch_status" = 'ABSENT' ] && [ -z "$cached_remote_branch_tip" ]; then
  feature_remote_verification='VERIFIED_ABSENT'
elif [ "$remote_branch_status" = 'ABSENT' ]; then
  feature_remote_verification='CACHED_REF_REMOTE_ABSENT'
  candidate_tip_evidence="LOCAL SHA=${local_branch_tip}; CACHED_REMOTE SHA=${cached_remote_tracking_feature_sha}; ACTUAL_REMOTE SHA=NOT_FOUND"
  unexecuted_checks='Feature relation and ancestry=NOT_EXECUTED (actual Remote Feature ref absent)'
  [ "$local_branch_status" = 'PRESENT' ] && existing_work_state='C'
  finish RECOVERY_REQUIRED RECOVERY_PLAN_ONLY 'Cached Remote-tracking Feature exists while Actual Remote Feature is absent'
elif [ -z "$cached_remote_branch_tip" ]; then
  feature_remote_verification='CACHED_REF_NOT_FOUND'
  candidate_tip_evidence="LOCAL SHA=${local_branch_tip}; CACHED_REMOTE SHA=NOT_FOUND; ACTUAL_REMOTE SHA=${actual_remote_feature_sha}"
  unexecuted_checks='Feature relation and ancestry=NOT_EXECUTED (cached Remote-tracking Feature ref absent)'
  [ "$local_branch_status" = 'ABSENT' ] && existing_work_state='D'
  finish RECOVERY_REQUIRED RECOVERY_PLAN_ONLY 'Actual Remote Feature exists without a cached Remote-tracking Feature'
elif [ "$cached_remote_branch_tip" != "$remote_branch_tip" ]; then
  feature_remote_verification='CACHED_ACTUAL_MISMATCH'
  candidate_tip_evidence="LOCAL SHA=${local_branch_tip}; CACHED_REMOTE SHA=${cached_remote_tracking_feature_sha}; ACTUAL_REMOTE SHA=${actual_remote_feature_sha}"
  append_executed 'Cached and actual Remote Feature comparison=MISMATCH'
  unexecuted_checks='Feature relation and ancestry=NOT_EXECUTED (cached and actual Remote Feature refs differ)'
  existing_work_state='B'
  finish RECOVERY_REQUIRED RECOVERY_PLAN_ONLY 'Cached Remote-tracking Feature differs from Actual Remote Feature'
else
  feature_remote_verification='VERIFIED'
  append_executed 'Cached and actual Remote Feature comparison=ALIGNED'
fi

if [ "$local_branch_status" = 'PRESENT' ] && [ "$remote_branch_status" = 'PRESENT' ]; then
  branch_counts="$(git -C "$repository" rev-list --left-right --count "${local_branch_tip}...${cached_remote_branch_tip}" 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Issue Branch ancestry cannot be verified'
  read -r branch_local_ahead branch_remote_ahead <<< "$branch_counts"
  if [ "$branch_local_ahead" != 0 ] && [ "$branch_remote_ahead" != 0 ]; then
    local_branch_status='PRESENT_DIVERGED'
    remote_branch_status='PRESENT_DIVERGED'
    existing_work_state='F'
    ancestry_status='DIVERGED'
    hard_stop BLOCKED_DIVERGENCE 'Local and Remote Issue Branches diverge'
  elif [ "$branch_local_ahead" != 0 ]; then
    local_branch_status='PRESENT_LOCAL_AHEAD'
    remote_branch_status='PRESENT_LOCAL_AHEAD'
  elif [ "$branch_remote_ahead" != 0 ]; then
    local_branch_status='PRESENT_REMOTE_AHEAD'
    remote_branch_status='PRESENT_REMOTE_AHEAD'
  else
    local_branch_status='PRESENT_ALIGNED'
    remote_branch_status='PRESENT_ALIGNED'
  fi
  append_executed 'Issue Branch relation=VERIFIED'
fi

if [ "$local_branch_status" = 'PRESENT_LOCAL_AHEAD' ] || [ "$remote_branch_status" = 'PRESENT_LOCAL_AHEAD' ] || [ "$local_branch_status" = 'PRESENT_REMOTE_AHEAD' ] || [ "$remote_branch_status" = 'PRESENT_REMOTE_AHEAD' ]; then
  if [ "$pr_status" = 'OPEN_DRAFT' ]; then
    existing_work_state='E'
  else
    existing_work_state='B'
  fi
  finish RECOVERY_REQUIRED RECOVERY_PLAN_ONLY 'Local and Remote Issue Branches are not aligned'
fi
if [ "$local_branch_status" = 'PRESENT' ] && [ "$remote_branch_status" = 'ABSENT' ]; then
  unique_feature_commits="$(git -C "$repository" rev-list --count "${actual_remote_base_sha}..${local_branch_tip}" 2>/dev/null)" || hard_stop NOT_VERIFIABLE 'Local-only Feature commit count cannot be verified'
  [[ "$unique_feature_commits" =~ ^[0-9]+$ ]] || hard_stop NOT_VERIFIABLE 'Local-only Feature commit count is malformed'
  candidate_tip_evidence="LOCAL_ONLY SHA=${local_branch_tip}; AUTHORITATIVE_BASE SHA=${actual_remote_base_sha}; UNIQUE_COMMITS=${unique_feature_commits}"
  append_executed 'Candidate tip source=LOCAL_ONLY'
  append_executed 'Local-only unique Feature commits=VERIFIED'
  if [ "$consumer" = 'jira-work' ] \
    && [ "$issue_association_status" = 'MATCHED' ] \
    && [ "$current_branch" = "$expected_branch_name" ] \
    && [ "$current_head" = "$local_branch_tip" ] \
    && [ "$local_branch_tip" = "$actual_remote_base_sha" ] \
    && [ "$unique_feature_commits" = '0' ] \
    && [ "$pr_status" = 'NONE' ]; then
    local_branch_status='PRESENT_BASE_TIP'
    existing_work_state='A'
    case "$execution_policy" in
      suggest-only) next_step='PLAN_NEW_WORK_ONLY' ;;
      patch-with-approval) next_step='PLAN_WITH_SEPARATE_APPROVAL' ;;
      auto-apply) next_step='PLAN_ONLY_RUNTIME_UNAVAILABLE' ;;
    esac
    finish READY_NEW_WORK "$next_step" 'NONE'
  fi
  local_branch_status='PRESENT_UNPUBLISHED'
  existing_work_state='C'
  finish RECOVERY_REQUIRED RECOVERY_PLAN_ONLY 'Local-only Issue Branch requires recovery planning'
fi
if [ "$local_branch_status" = 'ABSENT' ] && [ "$remote_branch_status" = 'PRESENT' ]; then
  candidate_tip_evidence="REMOTE_ONLY SHA=${remote_branch_tip}"
  append_executed 'Candidate tip source=REMOTE_ONLY'
  existing_work_state='D'
  finish RECOVERY_REQUIRED RECOVERY_PLAN_ONLY 'Remote-only Issue Branch requires recovery planning'
fi

if [ "$pr_status" = 'MULTIPLE' ]; then
  existing_work_state='H'
  hard_stop CONFLICTED 'Multiple PRs reference the expected Branch'
fi
if [ "$pr_status" = 'HEAD_MISMATCH' ]; then
  existing_work_state='H'
  hard_stop CONFLICTED 'GitHub PR head does not match the expected Branch'
fi
if [ "$pr_status" = 'MERGED' ]; then
  existing_work_state='G'
  ancestry_status='HEAD_MERGED'
  finish ALREADY_MERGED JIRA_RECONCILIATION_ONLY 'Merged PR forbids a new implementation plan'
fi
if [ "$pr_status" = 'OPEN_NON_DRAFT' ] || [ "$pr_status" = 'CLOSED_UNMERGED' ]; then
  hard_stop CONFLICTED 'Existing non-Draft or closed PR requires human judgment'
fi

if [ "$local_branch_status" = 'PRESENT_ALIGNED' ] && [ "$remote_branch_status" = 'PRESENT_ALIGNED' ]; then
  candidate_tip="$local_branch_tip"
  candidate_tip_evidence="LOCAL_AND_REMOTE_ALIGNED SHA=${candidate_tip}"
  append_executed 'Candidate tip source=LOCAL_AND_REMOTE_ALIGNED'
  if git -C "$repository" merge-base --is-ancestor "$candidate_tip" "$actual_remote_base_sha" 2>/dev/null; then
    existing_work_state='G'
    ancestry_status='CANDIDATE_ANCESTOR_OF_ACTUAL_REMOTE_BASE'
    append_executed 'Candidate ancestry=ALREADY_MERGED'
    finish ALREADY_MERGED JIRA_RECONCILIATION_ONLY 'Aligned Candidate Branch tip is already included in Actual Remote Base'
  else
    merge_base_status=$?
    [ "$merge_base_status" -eq 1 ] || hard_stop NOT_VERIFIABLE 'Candidate Branch ancestry cannot be verified'
  fi
  append_executed 'Candidate ancestry=NOT_ANCESTOR'
  if [ "$pr_status" = 'OPEN_DRAFT' ]; then
    existing_work_state='E'
  else
    existing_work_state='B'
  fi
  finish READY_RESUME PLAN_RESUME_ONLY 'NONE'
fi

existing_work_state='A'
unique_feature_commits='0'
case "$execution_policy" in
  suggest-only) next_step='PLAN_NEW_WORK_ONLY' ;;
  patch-with-approval) next_step='PLAN_WITH_SEPARATE_APPROVAL' ;;
  auto-apply) next_step='PLAN_ONLY_RUNTIME_UNAVAILABLE' ;;
esac
finish READY_NEW_WORK "$next_step" 'NONE'
