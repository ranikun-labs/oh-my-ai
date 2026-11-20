#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ENGINE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$WORKSPACE_ROOT"

TASK_INPUT="${TASK:-}"
TASK_FILE_INPUT="${TASK_FILE:-}"

# Fixture-only observability. The public entry passes this environment through,
# allowing installed E2E tests to prove that the common Engine ran exactly once.
if [ -n "${OH_MY_AI_WORK_START_INVOCATION_LOG:-}" ]; then
  printf '%s\n' "$$" >> "$OH_MY_AI_WORK_START_INVOCATION_LOG"
fi

if [ -z "$TASK_INPUT" ] && [ -z "$TASK_FILE_INPUT" ]; then
  echo "usage: make work-start TASK=\"...\" or make work-start TASK_FILE=task.md" >&2
  exit 2
fi

# Product Notice: read the Local Cache Snapshot now, at the start of this
# explicit Work-start run, so the text this run will show (if any) is fixed
# before Core runs. This is a fail-open, Local-only side channel — see
# docs/contracts/product-notice-contract.md. Any failure here (node absent,
# notice.mjs missing, internal error) must never affect Work-start's exit
# code or Candidate generation, so all output is discarded on error.
NOTICE_VERSION=""
NOTICE_TEXT=""
if command -v node >/dev/null 2>&1 && [ -f "$ENGINE_ROOT/scripts/notice.mjs" ]; then
  NOTICE_VERSION="$(cat "$ENGINE_ROOT/VERSION" 2>/dev/null || true)"
  NOTICE_TEXT="$(node "$ENGINE_ROOT/scripts/notice.mjs" render --version "$NOTICE_VERSION" 2>/dev/null || true)"
fi

is_denied_path() {
  case "$1" in
    .git|.git/*|./.git|./.git/*) return 0 ;;
    .oh-my-ai|.oh-my-ai/*|./.oh-my-ai|./.oh-my-ai/*) return 0 ;;
    .jikji|.jikji/*|./.jikji|./.jikji/*) return 0 ;;
    profiles/local|profiles/local/*|./profiles/local|./profiles/local/*) return 0 ;;
    docs/strategy|docs/strategy/*|./docs/strategy|./docs/strategy/*) return 0 ;;
    docs/internal|docs/internal/*|./docs/internal|./docs/internal/*) return 0 ;;
    docs/roadmap-private|docs/roadmap-private/*|./docs/roadmap-private|./docs/roadmap-private/*) return 0 ;;
    node_modules|node_modules/*|*/node_modules/*) return 0 ;;
    vendor|vendor/*|*/vendor/*) return 0 ;;
    build|build/*|*/build/*) return 0 ;;
    dist|dist/*|*/dist/*) return 0 ;;
    target|target/*|*/target/*) return 0 ;;
    coverage|coverage/*|*/coverage/*) return 0 ;;
    .cache|.cache/*|*/.cache/*|cache|cache/*|*/cache/*) return 0 ;;
    *.env|*.env.*|.env|.env.*|*secret*|*Secret*|*SECRET*) return 0 ;;
  esac
  return 1
}

validate_task_file() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "TASK_FILE must be a local markdown/text file: $file" >&2
    exit 2
  fi
  if is_denied_path "$file"; then
    echo "TASK_FILE is under a denied path: $file" >&2
    exit 2
  fi
  case "$file" in
    *.md|*.markdown|*.txt) ;;
    *)
      echo "TASK_FILE must end with .md, .markdown, or .txt: $file" >&2
      exit 2
      ;;
  esac
}

if [ -n "$TASK_FILE_INPUT" ]; then
  validate_task_file "$TASK_FILE_INPUT"
fi

TASK_FILE_TEXT=""
if [ -n "$TASK_FILE_INPUT" ]; then
  TASK_FILE_TEXT="$(sed -n '1,240p' "$TASK_FILE_INPUT")"
fi

TASK_TEXT="$TASK_INPUT"
if [ -n "$TASK_FILE_TEXT" ]; then
  TASK_TEXT="${TASK_TEXT}"$'\n'"${TASK_FILE_TEXT}"
fi

if [ -z "$(printf '%s' "$TASK_TEXT" | tr -d '[:space:]')" ]; then
  echo "TASK/TASK_FILE produced empty task text" >&2
  exit 2
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
slug_source="$TASK_INPUT"
if [ -z "$slug_source" ]; then
  slug_source="$(basename "$TASK_FILE_INPUT")"
fi
slug="$(printf '%s' "$slug_source" \
  | tr '\n\r\t' '   ' \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
  | cut -c1-48)"
if [ -z "$slug" ]; then
  slug="task"
fi

artifact_root=".oh-my-ai/work-start"
mkdir -p "$artifact_root"
artifact_base="$artifact_root/${timestamp}-${slug}"
OUT_DIR="$artifact_base"
collision_index=2
# Reserve the directory atomically because concurrent runs can have the same
# timestamp and slug. Only an occupied path calls for a different suffix.
until mkdir "$OUT_DIR" 2>/dev/null; do
  if [ ! -e "$OUT_DIR" ] && [ ! -L "$OUT_DIR" ]; then
    printf 'Work-start could not create artifact directory: %s\n' "$OUT_DIR" >&2
    exit 1
  fi
  OUT_DIR="${artifact_base}-${collision_index}"
  collision_index=$((collision_index + 1))
done

SOURCES_TMP="$OUT_DIR/.sources.tmp"
DOCS_TMP="$OUT_DIR/.docs.tmp"
CODE_TMP="$OUT_DIR/.code.tmp"
DECISIONS_TMP="$OUT_DIR/.decisions.tmp"
RISKS_TMP="$OUT_DIR/.risks.tmp"
KEYWORDS_TMP="$OUT_DIR/.keywords.tmp"
: > "$SOURCES_TMP"
: > "$DOCS_TMP"
: > "$CODE_TMP"
: > "$DECISIONS_TMP"
: > "$RISKS_TMP"
: > "$KEYWORDS_TMP"

yaml_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

branch="$(git branch --show-current 2>/dev/null || true)"
if [ -z "$branch" ]; then
  branch="unknown"
fi

git_status_short="$(git status --short 2>/dev/null || true)"
changed_files="$(printf '%s\n' "$git_status_short" | sed -E 's/^.{3}//' | sed '/^$/d' | head -20 || true)"

extract_keywords() {
  printf '%s\n' "$TASK_TEXT" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs '[:alnum:]_./-' '\n' \
    | sed -E 's#^[./-]+##; s#[./-]+$##' \
    | sed '/^$/d' \
    | awk 'length($0) >= 3' \
    | awk '
      BEGIN {
        split("the and for with from into this that your you are was were has have had task file work start basic local cloud api jira slack notion github before after should must can will not does repo code docs doc ai", stop)
        for (i in stop) skip[stop[i]]=1
      }
      !skip[$0] { print }
    ' \
    | awk '!seen[$0]++' \
    | head -12
}

extract_keywords > "$KEYWORDS_TMP"
if [ ! -s "$KEYWORDS_TMP" ]; then
  printf '%s\n' "task" > "$KEYWORDS_TMP"
fi

infer_preset_hint() {
  local text
  text="$(printf '%s' "$TASK_TEXT" | tr '[:upper:]' '[:lower:]')"
  if printf '%s' "$text" | grep -qE 'migration|cutover|dual.?write|이관|마이그레이션'; then
    printf '%s' "migration"
  elif printf '%s' "$text" | grep -qE 'debug|error|bug|fix|crash|exception|디버그|버그|오류'; then
    printf '%s' "bugfix"
  elif printf '%s' "$text" | grep -qE 'refactor|cleanup|restructure|리팩터'; then
    printf '%s' "refactor"
  elif printf '%s' "$text" | grep -qE 'review|pull.?request|리뷰'; then
    printf '%s' "review"
  elif printf '%s' "$text" | grep -qE 'doc|notion|confluence|readme|wiki|문서|노션'; then
    printf '%s' "documentation"
  elif printf '%s' "$text" | grep -qE 'handoff|인수인계|transfer'; then
    printf '%s' "handoff"
  elif printf '%s' "$text" | grep -qE 'design|architect|설계|아키텍처'; then
    printf '%s' "architecture_design"
  else
    printf '%s' "general"
  fi
}

preset_hint="$(infer_preset_hint)"

rg_common_args=(
  --hidden
  --glob '!.git/**'
  --glob '!.oh-my-ai/**'
  --glob '!.jikji/**'
  --glob '!profiles/local/**'
  --glob '!docs/strategy/**'
  --glob '!docs/internal/**'
  --glob '!docs/roadmap-private/**'
  --glob '!node_modules/**'
  --glob '!vendor/**'
  --glob '!build/**'
  --glob '!dist/**'
  --glob '!target/**'
  --glob '!coverage/**'
  --glob '!.cache/**'
  --glob '!cache/**'
  --glob '!*.env'
  --glob '!*.env.*'
  --glob '!**/*secret*'
  --glob '!**/*Secret*'
  --glob '!**/*SECRET*'
)

# Search backend detection.
# Truthfulness contract: a scan that could not run is NOT the same as a scan
# that ran and found nothing. SEARCH_BACKEND records which of the two applies.
#   rg    - full precision scan (globs + hidden files honoured)
#   grep  - degraded fallback; still a real content scan, coarser exclusions
#   none  - no content scan was possible; callers must not assert absence
if command -v rg >/dev/null 2>&1; then
  SEARCH_BACKEND="rg"
elif command -v grep >/dev/null 2>&1; then
  SEARCH_BACKEND="grep"
else
  SEARCH_BACKEND="none"
fi

if [ "$SEARCH_BACKEND" = "rg" ]; then
  SEARCH_DEGRADED="false"
else
  SEARCH_DEGRADED="true"
fi

if [ "$SEARCH_BACKEND" = "none" ]; then
  CONTENT_SCAN_STATUS="scan_unavailable"
else
  CONTENT_SCAN_STATUS="scanned"
fi

# Enumerate scannable files with the same prune set the find backend uses.
# Used to give the grep fallback bounded, deny-aware input.
list_scannable_files() {
  find . \
    \( -path './.git' -o -path './.oh-my-ai' -o -path './.jikji' -o -path './profiles/local' -o -path './docs/strategy' -o -path './docs/internal' -o -path './docs/roadmap-private' -o -path './node_modules' -o -path './vendor' -o -path './build' -o -path './dist' -o -path './target' -o -path './coverage' -o -path './.cache' -o -path './cache' \) -prune \
    -o -type f -print 2>/dev/null
}

# List files containing a fixed keyword. Prints nothing when no backend exists;
# callers gate on CONTENT_SCAN_STATUS rather than treating empty as absence.
search_files_by_keyword() {
  local keyword="$1"
  case "$SEARCH_BACKEND" in
    rg)
      rg -l -i -F "${rg_common_args[@]}" -- "$keyword" . 2>/dev/null | head -20 || true
      ;;
    grep)
      list_scannable_files \
        | head -2000 \
        | tr '\n' '\0' \
        | xargs -0 -r grep -l -i -F -- "$keyword" 2>/dev/null \
        | head -20 || true
      ;;
    *)
      : ;;
  esac
}

# Scan one already-selected file for a regex, emitting `line:text` matches.
scan_file_for_pattern() {
  local path="$1"
  local pattern="$2"
  case "$SEARCH_BACKEND" in
    rg)
      rg -n -i "${rg_common_args[@]}" "$pattern" -- "$path" 2>/dev/null | head -3 || true
      ;;
    grep)
      grep -n -i -E -- "$pattern" "$path" 2>/dev/null | head -3 || true
      ;;
    *)
      : ;;
  esac
}

candidate_kind() {
  case "$1" in
    *.md|*.markdown|*.txt|docs/*|*/docs/*) printf '%s' "docs" ;;
    *) printf '%s' "code" ;;
  esac
}

add_candidate() {
  local path="$1"
  local backend="$2"
  local reason="$3"
  local kind
  path="${path#./}"
  [ -f "$path" ] || return 0
  is_denied_path "$path" && return 0
  kind="$(candidate_kind "$path")"
  line="$path"$'\t'"$backend"$'\t'"$reason"
  if [ "$kind" = "docs" ]; then
    grep -Fqx "$line" "$DOCS_TMP" 2>/dev/null || printf '%s\n' "$line" >> "$DOCS_TMP"
  else
    grep -Fqx "$line" "$CODE_TMP" 2>/dev/null || printf '%s\n' "$line" >> "$CODE_TMP"
  fi
}

while IFS= read -r keyword; do
  [ -n "$keyword" ] || continue
  while IFS= read -r path; do
    add_candidate "$path" "$SEARCH_BACKEND" "matched keyword: $keyword"
  done < <(search_files_by_keyword "$keyword")

  while IFS= read -r path; do
    add_candidate "$path" "find" "path/name matched keyword: $keyword"
  done < <(find . \
    \( -path './.git' -o -path './.oh-my-ai' -o -path './.jikji' -o -path './profiles/local' -o -path './docs/strategy' -o -path './docs/internal' -o -path './docs/roadmap-private' -o -path './node_modules' -o -path './vendor' -o -path './build' -o -path './dist' -o -path './target' -o -path './coverage' -o -path './.cache' -o -path './cache' \) -prune \
    -o -type f -iname "*${keyword}*" -print 2>/dev/null | head -20 || true)
done < "$KEYWORDS_TMP"

sort -u "$DOCS_TMP" -o "$DOCS_TMP"
sort -u "$CODE_TMP" -o "$CODE_TMP"
head -15 "$DOCS_TMP" > "$DOCS_TMP.head"
head -15 "$CODE_TMP" > "$CODE_TMP.head"
mv "$DOCS_TMP.head" "$DOCS_TMP"
mv "$CODE_TMP.head" "$CODE_TMP"

candidate_paths() {
  cut -f1 "$DOCS_TMP" "$CODE_TMP" 2>/dev/null | awk 'NF && !seen[$0]++' | head -30
}

while IFS= read -r path; do
  [ -f "$path" ] || continue
  scan_file_for_pattern "$path" 'decision|decided|rationale|trade[- ]?off|constraint|assumption|non-goal|scope' \
    | sed -E "s#^#${path}:#" >> "$DECISIONS_TMP" || true
  scan_file_for_pattern "$path" 'risk|caution|warning|danger|rollback|security|secret|privacy|migration|compat|breaking|failure' \
    | sed -E "s#^#${path}:#" >> "$RISKS_TMP" || true
done < <(candidate_paths)

head -12 "$DECISIONS_TMP" > "$DECISIONS_TMP.head"
head -12 "$RISKS_TMP" > "$RISKS_TMP.head"
mv "$DECISIONS_TMP.head" "$DECISIONS_TMP"
mv "$RISKS_TMP.head" "$RISKS_TMP"

docs_count="$(wc -l < "$DOCS_TMP" | tr -d ' ')"
code_count="$(wc -l < "$CODE_TMP" | tr -d ' ')"
decision_count="$(wc -l < "$DECISIONS_TMP" | tr -d ' ')"
risk_count="$(wc -l < "$RISKS_TMP" | tr -d ' ')"

write_candidate_md() {
  local title="$1"
  local file="$2"
  echo "## $title"
  echo ""
  if [ -s "$file" ]; then
    awk -F '\t' '{ printf "- `%s` - candidate via `%s`; %s\n", $1, $2, $3 }' "$file"
  elif [ "$CONTENT_SCAN_STATUS" = "scan_unavailable" ]; then
    echo "- scan unavailable: no content search backend (\`rg\` or \`grep\`) is available, so absence is not asserted"
  else
    echo "- none found"
  fi
  echo ""
}

write_text_candidates_md() {
  local title="$1"
  local file="$2"
  echo "## $title"
  echo ""
  if [ -s "$file" ]; then
    awk '{ printf "- candidate: %s\n", $0 }' "$file"
  elif [ "$CONTENT_SCAN_STATUS" = "scan_unavailable" ]; then
    echo "- scan unavailable: no content search backend (\`rg\` or \`grep\`) is available, so absence is not asserted"
  else
    echo "- none found"
  fi
  echo ""
}

write_project_context_refs_md() {
  echo "## Project Context References"
  echo ""
  if [ -s "$DOCS_TMP" ] && grep -q '^docs/context/' "$DOCS_TMP"; then
    awk -F '\t' '$1 ~ /^docs\/context\// { printf "- `%s` - candidate via `%s`; %s\n", $1, $2, $3 }' "$DOCS_TMP"
  else
    echo "- Needs human review: no \`docs/context/*\` candidate was found by Work-start."
  fi
  echo ""
}

write_related_files_md() {
  echo "## Related File References"
  echo ""
  if [ -s "$DOCS_TMP" ] || [ -s "$CODE_TMP" ]; then
    awk -F '\t' '{ printf "- `%s` - candidate via `%s`; %s\n", $1, $2, $3 }' "$DOCS_TMP" "$CODE_TMP" | head -20
  else
    echo "- Needs human review: no related file candidate was found by Work-start."
  fi
  echo ""
}

skill_match_script="$ENGINE_ROOT/scripts/work-start-skill-match.mjs"
skill_unavailable_md=$'## Skill candidates\n\n- routing_status: unavailable\n- routing_error_code: consumer_error\n- primary: none\n- secondary: none\n- warning: Skill routing unavailable; generic Work-start output generated.\n'
skill_unavailable_yaml=$'routing_status: unavailable\nrouting_error_code: consumer_error\nrouting_warnings:\n  - '\''Skill routing unavailable; generic Work-start output generated.'\''\nskill_candidates:\n  status: unavailable\n  primary: []\n  secondary: []\n'
skill_md="$skill_unavailable_md"
skill_yaml="$skill_unavailable_yaml"
if command -v node >/dev/null 2>&1 && [ -f "$skill_match_script" ]; then
  skill_md_out="$(printf '%s' "$TASK_TEXT" | node "$skill_match_script" --format=markdown 2>/dev/null || true)"
  skill_yaml_out="$(printf '%s' "$TASK_TEXT" | node "$skill_match_script" --format=yaml 2>/dev/null || true)"
  [ -n "$skill_md_out" ] && skill_md="$skill_md_out"
  [ -n "$skill_yaml_out" ] && skill_yaml="$skill_yaml_out"
fi

{
  echo "# Sources"
  echo ""
  echo "Task source type: $([ -n "$TASK_FILE_INPUT" ] && echo "external_doc" || echo "manual_task")"
  if [ -n "$TASK_INPUT" ]; then
    echo ""
    echo "## TASK"
    echo ""
    printf '%s\n' "$TASK_INPUT"
  fi
  if [ -n "$TASK_FILE_INPUT" ]; then
    echo ""
    echo "## TASK_FILE"
    echo ""
    echo "- path: $TASK_FILE_INPUT"
    echo "- type: external_doc"
  fi
  echo ""
  echo "## Search keywords"
  sed 's/^/- /' "$KEYWORDS_TMP"
  echo ""
  echo "## Dirty worktree changed files"
  echo ""
  echo "Reference-only. Do not assume these files define the task intent."
  if [ -n "$changed_files" ]; then
    printf '%s\n' "$changed_files" | sed 's/^/- /'
  else
    echo "- none"
  fi
  echo ""
  write_candidate_md "Relevant document candidates" "$DOCS_TMP"
  write_candidate_md "Relevant code candidates" "$CODE_TMP"
} > "$OUT_DIR/sources.md"

{
  echo "# Context Gap Report"
  echo ""
  echo "## Search Backend Status"
  echo ""
  case "$SEARCH_BACKEND" in
    rg)
      echo "- Content search backend: \`rg\` (full precision)."
      ;;
    grep)
      echo "- Content search backend: \`grep\` (degraded fallback; \`rg\` is not installed)."
      echo "- Degraded scan: exclusions are coarser and the scanned file set is capped, so some candidates may be missed."
      ;;
    *)
      echo "- Content search backend: none. Neither \`rg\` nor \`grep\` is available."
      echo "- Scan unavailable: Work-start could not read file contents, so it does not assert that decisions or risks are absent."
      ;;
  esac
  echo ""
  echo "## Gaps"
  echo ""
  if [ "$CONTENT_SCAN_STATUS" = "scan_unavailable" ]; then
    # No content scan ran. Counts are 0 because nothing was inspected, not
    # because the repository lacks decisions or risks — never assert absence.
    echo "- Document, code, decision, and risk scans did not run (scan unavailable)."
    echo "- This is not a finding of absence. Install \`ripgrep\` or \`grep\` and re-run Work-start, or review context manually."
  else
    if [ "$docs_count" -eq 0 ]; then
      echo "- No document candidates were found for this task."
    fi
    if [ "$code_count" -eq 0 ]; then
      echo "- No code candidates were found for this task."
    fi
    if [ "$decision_count" -eq 0 ]; then
      echo "- No decision candidates were found. Add a TASK_FILE with ticket, meeting note, chat excerpt, or local notes if available."
    fi
    if [ "$risk_count" -eq 0 ]; then
      echo "- No risk candidates were found. Review security, data, migration, and rollback risks manually before editing."
    fi
    if [ "$docs_count" -ne 0 ] && [ "$code_count" -ne 0 ] && [ "$decision_count" -ne 0 ] && [ "$risk_count" -ne 0 ]; then
      echo "- No major context gaps detected by the MVP heuristics."
    fi
    if [ "$SEARCH_DEGRADED" = "true" ]; then
      echo "- Degraded scan: results came from the \`grep\` fallback, so \"none found\" means \"none found by a coarser scan\"."
    fi
  fi
  echo ""
  echo "## Bootstrap Questions"
  echo ""
  echo "- Which service, module, or path is in scope?"
  echo "- Are there local notes, meeting notes, ticket text, or chat excerpts to provide as TASK_FILE?"
  echo "- Are there known constraints, non-goals, or forbidden files?"
  echo "- What must be verified before any edit is made?"
  echo ""
  echo "## External Context Checkpoint"
  echo ""
  echo "Possible external context to review manually:"
  echo ""
  echo "- Internal Wiki or Confluence"
  echo "- Issue Tracker"
  echo "- Drive or Notion"
  echo "- Design files"
  echo "- Other repositories"
  echo "- Recent decisions from Slack or email"
  echo "- Production-only configuration"
  echo ""
  echo "These are not confirmed facts, search results, or connector output."
  echo "Work-start does not assert that any listed external source exists."
  echo "Review remains Needs human review until the user checks any required context manually."
} > "$OUT_DIR/context-gap-report.md"

{
  echo "manifest_version: 1"
  echo "workspace:"
  echo "  id: null"
  echo "  name: local"
  echo "project:"
  echo "  id: null"
  echo "  name: current-repo"
  echo "session:"
  echo "  task: '$(yaml_escape "$TASK_INPUT")'"
  echo "  task_file: $([ -n "$TASK_FILE_INPUT" ] && printf "'%s'" "$(yaml_escape "$TASK_FILE_INPUT")" || printf "null")"
  echo "  mode: basic"
  echo "  created_at: '$timestamp'"
  echo "repo:"
  echo "  root: '$(yaml_escape "$WORKSPACE_ROOT")'"
  echo "  branch: '$(yaml_escape "$branch")'"
  if [ -n "$changed_files" ]; then
    echo "  dirty_worktree_reference_only:"
    printf '%s\n' "$changed_files" | sed "s/'/''/g; s/^/    - path: '/; s/$/'/"
  else
    echo "  dirty_worktree_reference_only: []"
  fi
  echo "search:"
  echo "  backend: '$SEARCH_BACKEND'"
  echo "  degraded: $SEARCH_DEGRADED"
  echo "  content_scan: '$CONTENT_SCAN_STATUS'"
  echo "sources:"
  echo "  task_source_type: $([ -n "$TASK_FILE_INPUT" ] && echo "external_doc" || echo "manual_task")"
  if [ -s "$DOCS_TMP" ]; then
    echo "  docs:"
    awk -F '\t' '{ gsub(/\047/, "\047\047", $1); gsub(/\047/, "\047\047", $2); gsub(/\047/, "\047\047", $3); printf "    - path: '\''%s'\''\n      backend: '\''%s'\''\n      reason: '\''%s'\''\n      confidence: candidate\n", $1, $2, $3 }' "$DOCS_TMP"
  else
    echo "  docs: []"
  fi
  if [ -s "$CODE_TMP" ]; then
    echo "  code:"
    awk -F '\t' '{ gsub(/\047/, "\047\047", $1); gsub(/\047/, "\047\047", $2); gsub(/\047/, "\047\047", $3); printf "    - path: '\''%s'\''\n      backend: '\''%s'\''\n      reason: '\''%s'\''\n      confidence: candidate\n", $1, $2, $3 }' "$CODE_TMP"
  else
    echo "  code: []"
  fi
  if [ -s "$DECISIONS_TMP" ]; then
    echo "decision_candidates:"
    awk '{ gsub(/\047/, "\047\047", $0); printf "  - text: '\''%s'\''\n    confidence: candidate\n", $0 }' "$DECISIONS_TMP"
  else
    echo "decision_candidates: []"
  fi
  # Empty list alone is ambiguous; status says whether a scan actually ran.
  echo "decision_candidates_status: '$CONTENT_SCAN_STATUS'"
  if [ -s "$RISKS_TMP" ]; then
    echo "risk_candidates:"
    awk '{ gsub(/\047/, "\047\047", $0); printf "  - text: '\''%s'\''\n    confidence: candidate\n", $0 }' "$RISKS_TMP"
  else
    echo "risk_candidates: []"
  fi
  echo "risk_candidates_status: '$CONTENT_SCAN_STATUS'"
  echo "prompts:"
  echo "  starter: 'starter-prompt.md'"
  echo "  handoff_candidate: 'handoff-candidate.md'"
  echo "context_gaps:"
  echo "  report: 'context-gap-report.md'"
  echo "  bootstrap_questions:"
  echo "    - 'Which service, module, or path is in scope?'"
  echo "    - 'Are there local notes, meeting notes, ticket text, or chat excerpts to provide as TASK_FILE?'"
  echo "    - 'Are there known constraints, non-goals, or forbidden files?'"
  echo "    - 'What must be verified before any edit is made?'"
  echo "workflow_hint:"
  echo "  preset: '$preset_hint'"
  echo "  lenses: []"
  echo "  tools: []"
  echo "  note: 'Hint only. Not executed in v1.'"
  echo "external_context:"
  echo "  status: missing"
  echo "  sources: []"
  echo "  note: 'External context is user-provided only in v1.'"
  echo "artifacts:"
  echo "  path: '$OUT_DIR'"
  echo "  local_only: true"
} > "$OUT_DIR/context-manifest.yaml"

printf '\n%s\n' "$skill_yaml" >> "$OUT_DIR/context-manifest.yaml"

{
  echo "# Starter Prompt"
  echo ""
  echo "You are starting work on this task:"
  echo ""
  if [ -n "$TASK_INPUT" ]; then
    echo "> $TASK_INPUT"
  else
    echo "> See TASK_FILE: $TASK_FILE_INPUT"
  fi
  echo ""
  echo "Before editing code:"
  echo "1. Read the relevant candidates below."
  echo "2. Treat every search result as a candidate, not an answer."
  echo "3. Identify conflicting decisions, missing context, and risks."
  echo "4. Propose a minimal plan before editing."
  echo "5. Do not modify files until the plan is reviewed."
  echo "6. Review the Human Review Next Step choices in \`handoff-candidate.md\`; do not auto-select or auto-run any path."
  echo ""
  write_candidate_md "Relevant document candidates" "$DOCS_TMP"
  write_candidate_md "Relevant code candidates" "$CODE_TMP"
  write_text_candidates_md "Decision candidates" "$DECISIONS_TMP"
  write_text_candidates_md "Risk candidates" "$RISKS_TMP"
  echo "## Context gaps and open questions"
  echo ""
  cat "$OUT_DIR/context-gap-report.md"
} > "$OUT_DIR/starter-prompt.md"

printf '\n%s\n' "$skill_md" >> "$OUT_DIR/starter-prompt.md"

{
  echo "# Structured Handoff Candidate"
  echo ""
  echo "## Candidate Boundary"
  echo "- This is a provider-neutral Markdown Candidate generated from Work-start output."
  echo "- Human Review is required before copy/paste to a Worker Session."
  echo "- This is not an approved task, Action Approval, Runtime command, Runtime Invocation, Worker auto-creation, Session Linking, Managed Task, automatic Result return, automatic Apply, or automatic Merge."
  echo ""
  echo "## Human Review: Choose the Next Step"
  echo ""
  echo "- [ ] Direct Handoff"
  echo "  범위와 수행 방법이 충분히 명확하다고 판단한 경우,"
  echo "  Handoff Candidate를 검토한 뒤 Worker에게 수동 전달합니다."
  echo ""
  echo "- [ ] Plan First"
  echo "  영향 범위나 수행 순서를 먼저 정리해야 한다고 판단한 경우,"
  echo "  Planning Skill 또는 수동 Planning Process로 계획을 작성하고"
  echo "  검토된 계획을 Handoff Candidate에 반영합니다."
  echo ""
  echo "- [ ] Gather Context"
  echo "  현재 정보가 충분하지 않다고 판단한 경우,"
  echo "  외부 자료 또는 추가 입력을 수동 확인한 뒤"
  echo "  Work-start 또는 Handoff Candidate를 다시 검토합니다."
  echo ""
  echo "Selected by:"
  echo "Reason:"
  echo "Unresolved context:"
  echo ""
  echo "Candidate state before selection: Needs human review."
  echo "No next step is selected by default, and Work-start does not choose, recommend, or run any next step automatically."
  echo ""
  echo "Optional manual notes:"
  echo "- Selected next step:"
  echo "- Reviewed plan reference:"
  echo "- External context reviewed:"
  echo "- Remaining context gaps:"
  echo ""
  echo "## Contract Metadata"
  echo "- schema_version: \"1.0\""
  echo "- artifact_version: 1"
  echo "- handoff_ref: handoff-${OUT_DIR##*/}"
  echo "- lifecycle_status: draft"
  echo "- review_state: not_reviewed"
  echo "- created_at: $timestamp"
  echo ""
  echo "## Goal"
  if [ -n "$TASK_INPUT" ]; then
    printf '%s\n' "$TASK_INPUT" | sed 's/^/- /'
  else
    echo "- See TASK_FILE: \`$TASK_FILE_INPUT\`"
  fi
  echo ""
  echo "## Scope"
  echo "- repository: \`$WORKSPACE_ROOT\`"
  echo "- branch: \`$branch\`"
  echo "- in_scope:"
  echo "  - Needs human review: use \`sources.md\` and \`context-manifest.yaml\` to confirm exact files, directories, and features."
  echo "- out_of_scope:"
  echo "  - Needs human review: no explicit out-of-scope boundary was confirmed by Work-start."
  echo ""
  echo "## Allowed Actions"
  echo "- Needs human review: no Worker action is approved by this Candidate alone."
  echo "- Candidate-only reference: inspect files listed in \`sources.md\` and propose a minimal plan after review."
  echo ""
  echo "## Prohibited Actions"
  echo "- Do not treat this Candidate as Runtime Invocation, Worker auto-creation, Session Linking, Managed Task, automatic Result return, automatic Apply, or automatic Merge."
  echo "- Do not mark validation as passed unless it was actually performed."
  echo ""
  echo "## Do Not Touch"
  echo "- Needs human review: no task-specific do-not-touch path was confirmed by Work-start."
  echo "- Preserve denied/private paths excluded by Work-start search policy."
  echo ""
  echo "## Confirmed Facts"
  echo "- Observed repository root: \`$WORKSPACE_ROOT\`"
  echo "- Observed branch: \`$branch\`"
  echo "- Work-start artifact: \`$OUT_DIR\`"
  echo ""
  echo "## Confirmed Decisions"
  echo "- Needs human review: Work-start does not promote decision candidates to confirmed decisions."
  echo ""
  echo "## Assumptions"
  echo "- Needs human review: missing scope, validation, and do-not-touch details must remain assumptions until reviewed."
  echo ""
  echo "## Open Issues"
  echo "- Review \`context-gap-report.md\` before handing this Candidate to a Worker."
  echo "- Confirm exact scope, allowed actions, prohibited actions, validation, and completion criteria."
  echo "- If external context is needed, confirm it manually and review this Candidate again."
  echo ""
  echo "## Constraints"
  echo "- Work-start search results are candidates, not canonical facts."
  echo "- Human Review is required before manual copy/paste."
  echo "- Keep Project Context references as references; do not auto-import or promote context."
  echo ""
  echo "## Expected Output"
  echo "- Needs human review: define the final artifact or code/document change expected from the Worker."
  echo ""
  echo "## Completion Criteria"
  echo "- Needs human review: define task-specific criteria before Worker execution."
  echo "- Do not use this Candidate as automatic completion detection."
  echo ""
  echo "## Validation Required"
  echo "- Needs human review: identify required validation commands or manual checks before Worker execution."
  echo "- If validation cannot be performed, the Worker must report it under \`Validation Not Performed\` in Result Basic."
  echo "- Do not mark unperformed validation as passed."
  echo ""
  echo "## Repository Context"
  echo "- work_start_artifact: \`$OUT_DIR\`"
  echo "- sources: \`sources.md\`"
  echo "- context_gap_report: \`context-gap-report.md\`"
  echo "- context_manifest: \`context-manifest.yaml\`"
  echo "- starter_prompt: \`starter-prompt.md\`"
  echo ""
  echo "## External Context Checkpoint"
  echo ""
  echo "Possible external context to review manually:"
  echo ""
  echo "- Internal Wiki or Confluence"
  echo "- Issue Tracker"
  echo "- Drive or Notion"
  echo "- Design files"
  echo "- Other repositories"
  echo "- Recent decisions from Slack or email"
  echo "- Production-only configuration"
  echo ""
  echo "This list is not a confirmed fact list, not a search result, and not connector output."
  echo "Work-start does not assert that any listed external source exists."
  echo "The user must review any needed external context manually before treating it as confirmed."
  echo ""
  printf '%s\n' "$skill_md"
  write_project_context_refs_md
  write_related_files_md
  echo "## Return Contract"
  echo "- Return results using \`templates/result-basic.md\`."
  echo "- Preserve all required Result Basic headings."
  echo "- Separate \`Validation Performed\` and \`Validation Not Performed\`."
  echo "- Report \`Scope Deviations\` explicitly."
  echo "- Do not hide \`Remaining Risks\`."
  echo "- Result Basic is an Evidence Candidate until Human Review; it is not automatic completion proof, Apply permission, Merge permission, or Context Promotion permission."
} > "$OUT_DIR/handoff-candidate.md"

rm -f "$SOURCES_TMP" "$DOCS_TMP" "$CODE_TMP" "$DECISIONS_TMP" "$RISKS_TMP" "$KEYWORDS_TMP"

echo "work-start artifact created: $OUT_DIR"
echo ""
echo "oh-my-ai Work-start completed."
echo ""
echo "Artifact directory:"
echo "$OUT_DIR"
echo ""
echo "Generated:"
echo "- context-manifest.yaml"
echo "- handoff-candidate.md"
echo "- starter-prompt.md"
echo "- sources.md"
echo "- context-gap-report.md"
echo ""
echo "Status:"
echo "Needs human review"
echo ""
echo "Choose the next step:"
echo "- Direct Handoff"
echo "- Plan First"
echo "- Gather Context"
echo ""
echo "Work-start has not modified the requested product code."
echo "Review the Candidate before continuing."

# Product Notice: display uses only the Snapshot captured at the start of
# this run (never the result of the refresh triggered just below), so the
# same run's output stays deterministic regardless of network timing. This
# is the true tail of Work-start's output, after every other line above.
if [ -n "$NOTICE_TEXT" ]; then
  printf '%s\n' "$NOTICE_TEXT"
fi

# Non-blocking one-shot refresh: only fires if the cache is stale and the
# user has not opted out. Spawns a short detached process and returns
# immediately; its result becomes visible starting with the next explicit
# Work-start run, never this one.
if command -v node >/dev/null 2>&1 && [ -f "$ENGINE_ROOT/scripts/notice.mjs" ]; then
  node "$ENGINE_ROOT/scripts/notice.mjs" refresh-if-stale --version "$NOTICE_VERSION" >/dev/null 2>&1 || true
fi
