#!/usr/bin/env bash
set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO"

VALIDATOR="$REPO/scripts/validate-result-basic.mjs"
FIXTURE_ROOT="fixtures/result"

cleanup_dirs=()
cleanup() {
  for d in "${cleanup_dirs[@]:-}"; do
    case "$d" in
      */oh-my-ai-result-fixture.*) [ -d "$d" ] && rm -rf -- "$d" ;;
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
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/oh-my-ai-result-fixture.XXXXXX")"
  cleanup_dirs+=("$d")
  printf '%s\n' "$d"
}

expect_valid() {
  local file="$1" label="$2"
  if ! node "$VALIDATOR" "$file" >/dev/null 2>&1; then
    node "$VALIDATOR" "$file" || true
    fail "$label: expected valid, validator rejected it"
  fi
}

expect_invalid() {
  local file="$1" label="$2" expect_substring="$3"
  local out
  if out="$(node "$VALIDATOR" "$file" 2>&1)"; then
    fail "$label: expected invalid, validator accepted it"
  fi
  case "$out" in
    *"$expect_substring"*) ;;
    *) fail "$label: expected error containing '$expect_substring', got: $out" ;;
  esac
}

mutate_result() {
  local src="$1" out="$2" find_str="$3" replace_str="$4"
  node -e '
    const fs = require("fs");
    const [src, out, findStr, replaceStr] = process.argv.slice(1);
    const text = fs.readFileSync(src, "utf8");
    if (!text.includes(findStr)) { console.error("mutate_result: find string not present: " + findStr); process.exit(1); }
    fs.writeFileSync(out, text.split(findStr).join(replaceStr));
  ' "$src" "$out" "$find_str" "$replace_str"
}

has_exact_files_read_changed_headings() {
  local file="$1"
  local files_read_count files_changed_count heading_count
  files_read_count="$(grep -c '^## Files Read$' "$file" || true)"
  files_changed_count="$(grep -c '^## Files Changed$' "$file" || true)"
  heading_count=$((files_read_count + files_changed_count))

  [ "$files_read_count" = "1" ] &&
    [ "$files_changed_count" = "1" ] &&
    [ "$heading_count" = "2" ]
}

# --- 1. Validation Performed ------------------------------------------------

fx_validation_performed() {
  expect_valid "$FIXTURE_ROOT/FX-RS-good-complete-validation-performed.md" "Validation-Performed-positive"

  local d out
  d="$(sandbox)"; out="$d/bad.md"
  mutate_result "$FIXTURE_ROOT/FX-RS-good-complete-validation-performed.md" "$out" \
    "- \`bash -n README.md\` is not applicable to Markdown; visually diffed the single-line change against the surrounding install steps." \
    "- \`None\`"
  expect_invalid "$out" "Validation-Performed-negative" "requires at least one entry under Validation Performed"
  echo "passed: FX-RS-validation-performed"
}

# --- 2. Validation Not Performed --------------------------------------------

fx_validation_not_performed() {
  expect_valid "$FIXTURE_ROOT/FX-RS-good-partial-validation-not-performed.md" "Validation-Not-Performed-positive"

  local d out
  d="$(sandbox)"; out="$d/bad.md"
  mutate_result "$FIXTURE_ROOT/FX-RS-good-partial-validation-not-performed.md" "$out" \
    "- Integration test against the live endpoint was not run because test credentials were not available in this environment." \
    "- \`None\`"
  mutate_result "$out" "$out" \
    "- Confirm rate-limit response code with the endpoint owner before merge." \
    "- \`None\`"
  expect_invalid "$out" "Validation-Not-Performed-negative" "requires evidence of incompleteness"
  echo "passed: FX-RS-validation-not-performed"
}

# --- 3. Files Read / Changed 분리 -------------------------------------------

fx_files_read_changed_separation() {
  expect_valid "$FIXTURE_ROOT/FX-RS-good-complete-validation-performed.md" "Files-Read-Changed-positive"
  has_exact_files_read_changed_headings "$FIXTURE_ROOT/FX-RS-good-complete-validation-performed.md" ||
    fail "Files-Read-Changed: expected exactly one Files Read and one Files Changed heading"

  local d out duplicate_out
  d="$(sandbox)"; out="$d/bad.md"
  mutate_result "$FIXTURE_ROOT/FX-RS-good-complete-validation-performed.md" "$out" \
    "## Files Changed" \
    "## Files Read2renamed"
  if has_exact_files_read_changed_headings "$out"; then
    fail "Files-Read-Changed-negative: accepted a missing Files Changed heading"
  fi
  expect_invalid "$out" "Files-Read-Changed-negative" "missing required heading: ## Files Changed"

  duplicate_out="$d/duplicate.md"
  mutate_result "$FIXTURE_ROOT/FX-RS-good-complete-validation-performed.md" "$duplicate_out" \
    "## Files Read" \
    $'## Files Read\n## Files Read'
  if has_exact_files_read_changed_headings "$duplicate_out"; then
    fail "Files-Read-Changed-negative: accepted a duplicate Files Read heading"
  fi
  expect_invalid "$duplicate_out" "Files-Read-Changed-duplicate-validator" "duplicate required heading: ## Files Read"
  echo "passed: FX-RS-files-read-changed-separation"
}

# --- 4. Scope Deviation ------------------------------------------------------

fx_scope_deviation() {
  expect_valid "$FIXTURE_ROOT/FX-RS-good-scope-deviation.md" "Scope-Deviation-positive"

  local d out
  d="$(sandbox)"; out="$d/bad.md"
  mutate_result "$FIXTURE_ROOT/FX-RS-good-scope-deviation.md" "$out" \
    "\`execution_status\`: \`partial\`" \
    "\`execution_status\`: \`complete\`"
  expect_invalid "$out" "Scope-Deviation-negative" "complete but Scope Deviations is non-empty"
  echo "passed: FX-RS-scope-deviation"
}

# --- 5. Missing Result -------------------------------------------------------

fx_missing_result() {
  local d
  d="$(sandbox)"
  local out
  out="$(node "$VALIDATOR" "$d/does-not-exist.md" 2>&1)" && fail "Missing-Result: expected non-zero exit"
  case "$out" in
    *"missing_result"*) ;;
    *) fail "Missing-Result: expected missing_result message, got: $out" ;;
  esac
  echo "passed: FX-RS-missing-result"
}

# --- 6. Partial Result -------------------------------------------------------

fx_partial_result() {
  expect_valid "$FIXTURE_ROOT/FX-RS-good-partial-validation-not-performed.md" "Partial-Result-positive"

  local d out
  d="$(sandbox)"; out="$d/bad.md"
  mutate_result "$FIXTURE_ROOT/FX-RS-good-partial-validation-not-performed.md" "$out" \
    "- Integration test against the live endpoint was not run because test credentials were not available in this environment." \
    "- \`None\`"
  mutate_result "$out" "$out" \
    "- Confirm rate-limit response code with the endpoint owner before merge." \
    "- \`None\`"
  expect_invalid "$out" "Partial-Result-negative" "requires evidence of incompleteness"
  echo "passed: FX-RS-partial-result"
}

# --- 7. Blocked Result -------------------------------------------------------

fx_blocked_result() {
  expect_valid "$FIXTURE_ROOT/FX-RS-good-blocked.md" "Blocked-Result-positive"

  local d out
  d="$(sandbox)"; out="$d/bad.md"
  mutate_result "$FIXTURE_ROOT/FX-RS-good-blocked.md" "$out" \
    '- `blocker_type`: `missing_access` - description: no IAM grant for this account on the target secrets manager project; required_access: "secretmanager.versions.access on project X"; recommended_next_action: "Request access grant from the project owner, then resume this task"' \
    '- `None`'
  expect_invalid "$out" "Blocked-Result-negative" "requires at least one entry under Blocked Reasons"
  echo "passed: FX-RS-blocked-result"
}

# --- 8. Ambiguous sections and metadata --------------------------------------

fx_ambiguous_result() {
  local src="$FIXTURE_ROOT/FX-RS-good-complete-validation-performed.md"
  local d out
  d="$(sandbox)"; out="$d/ambiguous.md"

  # A later empty section must not erase an earlier reported deviation.
  mutate_result "$src" "$out" "## Scope Deviations" \
    $'## Scope Deviations\n\n- Modified an out-of-scope file.\n\n## Scope Deviations'
  expect_invalid "$out" "Scope-Deviations-duplicate" "duplicate required heading: ## Scope Deviations"

  mutate_result "$src" "$out" "## Contract Metadata" \
    $'## Contract Metadata\n\n- `execution_status`: `blocked`\n\n## Contract Metadata'
  expect_invalid "$out" "Contract-Metadata-duplicate" "duplicate required heading: ## Contract Metadata"

  mutate_result "$src" "$out" '- `execution_status`: `complete`' \
    $'- `execution_status`: `complete`\n- `execution_status`: `blocked`'
  expect_invalid "$out" "Execution-Status-conflict" "duplicate Contract Metadata field: execution_status"

  mutate_result "$src" "$out" '- `receipt_status`: `received`' \
    $'- `receipt_status`: `received`\n- `receipt_status`: `missing`'
  expect_invalid "$out" "Receipt-Status-conflict" "duplicate Contract Metadata field: receipt_status"

  mutate_result "$src" "$out" '- `created_by`: `fixture-worker`' \
    $'- `created_by`: `fixture-worker`\n- `created_by`: `different-worker`'
  expect_invalid "$out" "Created-By-conflict" "duplicate Contract Metadata field: created_by"

  mutate_result "$src" "$out" '- `execution_status`: `complete`' \
    $'- `execution_status`: `complete`\n- `execution_status`: `complete`'
  expect_invalid "$out" "Execution-Status-identical-duplicate" "duplicate Contract Metadata field: execution_status"

  # Text that mentions a field or heading in ordinary prose is not a duplicate.
  mutate_result "$src" "$out" "## Summary" \
    $'## Summary\n\nThe earlier label was `execution_status`: `blocked`; ## Summary is the section name.'
  expect_valid "$out" "Status-And-Heading-prose-mention"

  # Examples and comments are not additional visible sections or claims.
  mutate_result "$src" "$out" "## Summary" \
    $'## Summary\n\n```markdown\n## Summary\n```'
  expect_valid "$out" "Fenced-Required-Heading-example"

  mutate_result "$src" "$out" '- `execution_status`: `complete`' \
    $'- `execution_status`: `complete`\n<!--\n- `execution_status`: `blocked`\n-->'
  expect_valid "$out" "Commented-Execution-Status-example"

  mutate_result "$src" "$out" '- `execution_status`: `complete`' \
    $'- `execution_status`: `complete`\n```markdown\n- `execution_status`: `blocked`\n```'
  expect_valid "$out" "Fenced-Execution-Status-example"

  mutate_result "$src" "$out" "## Summary" \
    $'## Summary\n\n<!--\n## Summary\n-->'
  expect_valid "$out" "Commented-Required-Heading-example"

  # Result bodies retain code-formatted evidence and deviations as data.
  mutate_result "$src" "$out" \
    '- `bash -n README.md` is not applicable to Markdown; visually diffed the single-line change against the surrounding install steps.' \
    $'```text\nObserved command result: validation passed.\n```'
  expect_valid "$out" "Fenced-Validation-Performed-evidence"

  mutate_result "$src" "$out" \
    '- `bash -n README.md` is not applicable to Markdown; visually diffed the single-line change against the surrounding install steps.' \
    '    Observed command result: validation passed.'
  expect_valid "$out" "Indented-Validation-Performed-evidence"

  mutate_result "$src" "$out" \
    '- `bash -n README.md` is not applicable to Markdown; visually diffed the single-line change against the surrounding install steps.' \
    '<pre>Observed command result: validation passed.</pre>'
  expect_valid "$out" "Pre-Validation-Performed-evidence"

  mutate_result "$src" "$out" $'## Scope Deviations\n\n- `None`' \
    $'## Scope Deviations\n\n```text\nModified an out-of-scope file.\n```'
  expect_invalid "$out" "Fenced-Scope-Deviation-preserved" "complete but Scope Deviations is non-empty"

  mutate_result "$src" "$out" $'## Scope Deviations\n\n- `None`' \
    $'## Scope Deviations\n\n    Modified an out-of-scope file.'
  expect_invalid "$out" "Indented-Scope-Deviation-preserved" "complete but Scope Deviations is non-empty"

  mutate_result "$src" "$out" $'## Scope Deviations\n\n- `None`' \
    $'## Scope Deviations\n\n<pre>Modified an out-of-scope file.</pre>'
  expect_invalid "$out" "Pre-Scope-Deviation-preserved" "complete but Scope Deviations is non-empty"

  mutate_result "$src" "$out" '- `execution_status`: `complete`' \
    $'- `execution_status`: `complete`\n-\n`execution_status`: `blocked`'
  expect_invalid "$out" "Multiline-Execution-Status-conflict" "duplicate Contract Metadata field: execution_status"

  # A heading containing only a comment must not create a new empty section.
  mutate_result "$src" "$out" "## Summary" \
    $'## Summary\n\n## <!-- example-only heading -->'
  expect_valid "$out" "Comment-Only-Heading-example"

  mutate_result "$src" "$out" "## Summary" \
    $'## Summary\n\nRESULT_SECTION_LINE_ and RESULT_SECTION_LINE__ are ordinary user data.'
  expect_valid "$out" "Heading-Marker-input-collision"

  mutate_result "$src" "$out" "## Files Read" \
    $'```markdown\n## Files Read\n```\n\n## Files Read'
  expect_valid "$out" "Hidden-Heading-before-Visible-Heading"

  mutate_result "$src" "$out" "## Summary" \
    $'## Summary\n\n```markdown\n## Summary\n```\n\n## Summary'
  expect_invalid "$out" "Visible-Duplicate-after-Hidden-Heading" "duplicate required heading: ## Summary"
  echo "passed: FX-RS-ambiguous-result"
}

# --- run everything ----------------------------------------------------------

require_file "$VALIDATOR"
for f in FX-RS-good-complete-validation-performed FX-RS-good-partial-validation-not-performed FX-RS-good-blocked FX-RS-good-scope-deviation; do
  require_file "$FIXTURE_ROOT/$f.md"
done

fx_validation_performed
fx_validation_not_performed
fx_files_read_changed_separation
fx_scope_deviation
fx_missing_result
fx_partial_result
fx_blocked_result
fx_ambiguous_result

echo "all Result Basic fixtures passed"
