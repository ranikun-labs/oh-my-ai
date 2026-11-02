#!/usr/bin/env bash
set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO"

FIXTURE_ROOT="fixtures/work-start"
STATE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oh-my-ai-work-start-state.XXXXXX")"
export OH_MY_AI_STATE_ROOT="$STATE_ROOT"
cleanup_paths=()
cleanup_files=()
cleanup_dirs=()

cleanup() {
  if [ "${KEEP_WORK_START_FIXTURE_ARTIFACTS:-}" = "1" ]; then
    return 0
  fi
  for path in "${cleanup_paths[@]}"; do
    case "$path" in
      .oh-my-ai/work-start/*) [ -d "$path" ] && rm -rf -- "$path" ;;
    esac
  done
  for path in "${cleanup_files[@]}"; do
    case "$path" in
      "$STATE_ROOT"/*) [ -f "$path" ] && rm -f -- "$path" ;;
    esac
  done
  # Isolated-PATH sandboxes live under the system temp dir, not the repo.
  for path in "${cleanup_dirs[@]:-}"; do
    case "$path" in
      */oh-my-ai-work-start-backend.*) [ -d "$path" ] && rm -rf -- "$path" ;;
    esac
  done
  [ ! -d "$STATE_ROOT" ] || rm -rf -- "$STATE_ROOT"
  return 0
}
trap cleanup EXIT

fail() {
  echo "fixture failure: $*" >&2
  exit 1
}

user_local_state_file() {
  node --input-type=module -e 'import { resolveUserLocalStateLocation } from "./scripts/lib/user-local-state.mjs"; process.stdout.write(resolveUserLocalStateLocation(process.cwd(), process.argv[1]).filePath);' "$1"
}

require_file() {
  local path="$1"
  [ -f "$path" ] || fail "missing file: $path"
}

require_pattern() {
  local pattern="$1"
  local file="$2"
  grep -q -E -- "$pattern" "$file" || fail "missing pattern '$pattern' in $file"
}

require_fixed() {
  local text="$1"
  local file="$2"
  grep -q -F -- "$text" "$file" || fail "missing text '$text' in $file"
}

section_body() {
  local heading="$1"
  local file="$2"
  awk -v heading="$heading" '
    $0 == heading { in_section=1; next }
    /^## / && in_section { exit }
    in_section { print }
  ' "$file"
}

run_work_start() {
  local task_file="$1"
  local output
  output="$(TASK="$(cat "$task_file")" make work-start 2>&1)"
  printf '%s\n' "$output" | sed -n 's/^work-start artifact created: //p' | tail -1
}

work_start_artifact_count() {
  node -e '
    const fs = require("fs");
    const root = process.argv[1];
    if (!fs.existsSync(root)) process.exit(0);
    console.log(fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length);
  ' ".oh-my-ai/work-start"
}

work_start_named_artifact_count() {
  node -e '
    const fs = require("fs");
    const [root, name] = process.argv.slice(1);
    if (!fs.existsSync(root)) process.exit(0);
    console.log(fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name === name).length);
  ' ".oh-my-ai/work-start" "$1"
}

sha256_file() {
  node -e '
    const crypto = require("crypto"); const fs = require("fs");
    process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
  ' "$1"
}

run_claude_prompt_hook() {
  local task_file="$1"
  local task_json
  task_json="$(node -e 'const fs=require("fs"); const text=fs.readFileSync(process.argv[1],"utf8"); process.stdout.write(JSON.stringify({prompt:text}));' "$task_file")"
  printf '%s' "$task_json" | node scripts/prompt-routing-hook.mjs --format=claude-json
}

run_codex_prompt_hook() {
  local task_file="$1"
  local task_json
  task_json="$(node -e 'const fs=require("fs"); const text=fs.readFileSync(process.argv[1],"utf8"); process.stdout.write(JSON.stringify({prompt:text}));' "$task_file")"
  printf '%s' "$task_json" | node scripts/prompt-routing-hook.mjs --format=codex-json
}

json_string_field() {
  local field="$1"
  node -e '
    const fs = require("fs");
    const field = process.argv[1];
    const input = fs.readFileSync(0, "utf8").trim();
    if (!input) process.exit(0);
    const parsed = JSON.parse(input);
    const value = field.split(".").reduce((current, key) => current && current[key], parsed);
    if (typeof value === "string") process.stdout.write(value);
  ' "$field"
}

run_work_start_output() {
  local task_file="$1"
  TASK="$(cat "$task_file")" make work-start 2>&1
}

run_codex_work_start_output() {
  local task_file="$1"
  OH_MY_AI_ENTRY="$REPO/scripts/oh-my-ai.mjs" TASK="$(cat "$task_file")" scripts/codex-work-start-entry.sh 2>&1
}

check_common_artifact() {
  local artifact="$1"
  local fixture_dir="$2"
  local handoff="$artifact/handoff-candidate.md"
  local next_step_section

  [ -d "$artifact" ] || fail "artifact directory not created: $artifact"
  require_file "$artifact/starter-prompt.md"
  require_file "$artifact/handoff-candidate.md"
  require_file "$artifact/context-manifest.yaml"
  require_file "$artifact/sources.md"
  require_file "$artifact/context-gap-report.md"

  while IFS= read -r marker; do
    [ -n "$marker" ] || continue
    if [[ "$marker" == "## "* ]]; then
      require_pattern "^${marker}$" "$handoff"
    else
      require_fixed "$marker" "$handoff"
    fi
  done < "$fixture_dir/expected/required-handoff-fields.txt"

  while IFS= read -r marker; do
    [ -n "$marker" ] || continue
    require_fixed "$marker" "$handoff"
  done < "$fixture_dir/expected/result-basic-markers.txt"

  require_pattern "^## Skill candidates$" "$handoff"
  require_fixed "Human Review is required" "$handoff"
  require_fixed "manual copy/paste" "$handoff"
  require_fixed "handoff_candidate: 'handoff-candidate.md'" "$artifact/context-manifest.yaml"

  require_pattern "^## Human Review: Choose the Next Step$" "$handoff"
  require_fixed "- [ ] Direct Handoff" "$handoff"
  require_fixed "- [ ] Plan First" "$handoff"
  require_fixed "- [ ] Gather Context" "$handoff"
  require_fixed "Selected by:" "$handoff"
  require_fixed "Reason:" "$handoff"
  require_fixed "Unresolved context:" "$handoff"
  require_fixed "Needs human review" "$handoff"
  require_fixed "No next step is selected by default" "$handoff"
  require_fixed "does not choose, recommend, or run any next step automatically" "$handoff"

  next_step_section="$(section_body "## Human Review: Choose the Next Step" "$handoff")"
  if printf '%s\n' "$next_step_section" | grep -q -E -- '- \[[xX]\]'; then
    fail "next step is preselected in $handoff"
  fi
  if grep -q -i -E 'Recommended action|Complexity detected|System selected|External context required|Superpowers required|Automatically run Superpowers' "$handoff"; then
    fail "automatic recommendation or external dependency wording found in $handoff"
  fi

  require_pattern "^## External Context Checkpoint$" "$handoff"
  require_fixed "Possible external context to review manually:" "$handoff"
  require_fixed "Internal Wiki or Confluence" "$handoff"
  require_fixed "Issue Tracker" "$handoff"
  require_fixed "Drive or Notion" "$handoff"
  require_fixed "Design files" "$handoff"
  require_fixed "Other repositories" "$handoff"
  require_fixed "Recent decisions from Slack or email" "$handoff"
  require_fixed "Production-only configuration" "$handoff"
  require_fixed "not a confirmed fact list" "$handoff"
  require_fixed "not connector output" "$handoff"
  require_fixed "does not assert that any listed external source exists" "$handoff"
  require_fixed "Possible external context to review manually:" "$artifact/context-gap-report.md"

  if grep -q -E 'Permission denied|command not found|No such file or directory' "$handoff"; then
    fail "shell error marker found in $handoff"
  fi

  git check-ignore -q "$handoff" || fail "artifact is not ignored: $handoff"
}

check_positive() {
  local fixture_dir="$1"
  local artifact="$2"
  local handoff="$artifact/handoff-candidate.md"

  require_fixed "Add a small documentation-only example" "$handoff"
  if ! section_body "## Project Context References" "$handoff" | grep -q -E '^- `docs/context/|Needs human review'; then
    fail "Project Context References lacks a candidate or conservative review marker in $handoff"
  fi
}

check_negative() {
  local fixture_dir="$1"
  local artifact="$2"
  local handoff="$artifact/handoff-candidate.md"
  local allowed

  require_fixed "Needs human review" "$handoff"
  require_fixed "no Worker action is approved by this Candidate alone" "$handoff"
  require_fixed "Do not treat this Candidate as Runtime Invocation" "$handoff"

  allowed="$(section_body "## Allowed Actions" "$handoff")"
  if printf '%s\n' "$allowed" | grep -q -i -E 'commit|push|merge|deploy|배포|runtime'; then
    fail "Allowed Actions grants an unsafe action in $handoff"
  fi
}

check_multiline_slug() {
  local fixture_dir="$1"
  local artifact="$2"
  local dir_name

  case "$artifact" in
    *$'\n'*|*$'\r'*|*$'\t'*)
      fail "artifact directory name contains a control/whitespace character: $artifact"
      ;;
  esac

  dir_name="$(basename "$artifact")"
  printf '%s' "$dir_name" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[a-z0-9]+(-[a-z0-9]+)*$' \
    || fail "artifact directory name does not match expected slug shape: $dir_name"

  [ "$(work_start_named_artifact_count "$dir_name")" = "1" ] \
    || fail "expected exactly one artifact directory named $dir_name"
}

check_runtime_entry_metadata() {
  require_fixed "display-name: Work-start" "skills/work-start/SKILL.md"
  require_fixed "disable-model-invocation: true" "skills/work-start/SKILL.md"
  require_fixed 'Use only when a user explicitly invokes Claude /work-start or Codex $work-start' "skills/work-start/SKILL.md"
  require_fixed "Claude Code Runtime Entry" "skills/work-start/SKILL.md"
  require_fixed "entry_mode = explicit" "skills/work-start/SKILL.md"
  require_fixed "approval = not_required" "skills/work-start/SKILL.md"
  require_fixed "자연어 Intent는 이 스킬의 실행 트리거가 아니다" "skills/work-start/SKILL.md"
  require_fixed "Runtime Terminal Boundary (우선 적용)" "skills/work-start/SKILL.md"
  require_fixed "Artifact를 자동 Read하지 않고" "skills/work-start/SKILL.md"
  require_fixed "stop the current response" "skills/work-start/SKILL.md"
  if [ -f "$HOME/.claude/skills/work-start/SKILL.md" ]; then
    require_fixed "disable-model-invocation: true" "$HOME/.claude/skills/work-start/SKILL.md"
    require_fixed 'Use only when a user explicitly invokes Claude /work-start or Codex $work-start' "$HOME/.claude/skills/work-start/SKILL.md"
  fi
  if grep -q -F -- "or says they want to start, plan, or kick off a task" "skills/work-start/SKILL.md"; then
    fail "work-start skill description still permits natural-language model invocation"
  fi
}

check_codex_runtime_entry_metadata() {
  require_file "skills/work-start/agents/openai.yaml"
  require_file "scripts/codex-work-start-entry.sh"
  require_fixed "Codex Runtime Entry" "skills/work-start/SKILL.md"
  require_fixed 'official_explicit_invocation = $work-start <task>' "skills/work-start/SKILL.md"
  require_fixed "runtime = codex-cli" "skills/work-start/SKILL.md"
  require_fixed '선두 명시 호출 토큰인 `$work-start` 뒤의 argument만 `TASK`로 전달한다' "skills/work-start/SKILL.md"
  require_fixed 'Task 본문 안의 일반 문자열 `work-start`는 보존한다' "skills/work-start/SKILL.md"
  require_fixed '```oh-my-ai-work-start-contract' "skills/work-start/SKILL.md"
  require_fixed 'runtime = codex' "skills/work-start/SKILL.md"
  require_fixed 'public_entry = "$HOME/.local/bin/oh-my-ai" work-start -- "<single task argument>"' "skills/work-start/SKILL.md"
  require_fixed "Codex의 sandbox·approval·filesystem·network permission은 그대로 유지한다" "skills/work-start/SKILL.md"
  require_fixed "allow_implicit_invocation: false" "skills/work-start/agents/openai.yaml"
  require_fixed 'pass only <task> as one argument to $HOME/.local/bin/oh-my-ai work-start -- "<single task argument>"' "skills/work-start/agents/openai.yaml"

  [ -L ".agents/skills/work-start" ] || fail "missing repo-local Codex skill symlink: .agents/skills/work-start"
  [ "$(readlink ".agents/skills/work-start")" = "../../skills/work-start" ] \
    || fail "Codex work-start skill symlink points at unexpected target"
  [ -f ".agents/skills/work-start/SKILL.md" ] || fail "Codex work-start skill symlink is not readable"
  require_fixed "allow_implicit_invocation: false" ".agents/skills/work-start/agents/openai.yaml"
}

check_continuation_skill_contract() {
  local skill="skills/work-start/SKILL.md"

  require_fixed "## Human Review 이후 Continuation Boundary" "$skill"
  require_fixed "사용자가 Human Review에서 Plan First를 명시적으로 선택한다" "$skill"
  require_fixed "검토된 계획을 Handoff Candidate에 반영할지 사용자에게 확인한다" "$skill"
  require_fixed "사용자가 Human Review에서 Gather Context를 명시적으로 선택한다" "$skill"
  require_fixed "Candidate 반영 또는 재검토 여부를 사용자에게 확인한다" "$skill"
  require_fixed 'Candidate 상태는 `Needs human review`로 유지한다' "$skill"
  require_fixed "Candidate 반영은 Direct Handoff 승인이 아니다" "$skill"
  require_fixed "Main Session은 구현·Commit·Push·PR·Merge를 시작하지 않는다" "$skill"
  require_fixed "Worker Session은 아직 생성되거나 실행되지 않았습니다" "$skill"
  require_fixed "Direct Handoff를 별도로 명시적으로 선택" "$skill"
  require_fixed "새 Worker Session에 승인된 Candidate 또는 Handoff 내용을 수동으로 전달하세요" "$skill"
  require_fixed "이 안내 후 Main Session은 구현을 시작하지 않고 정지한다" "$skill"
  require_fixed "다음 사용자 메시지" "$skill"
  require_fixed "기존 Artifact만 Read하며 Public Entry·Engine을 다시 실행하거나 새 Artifact를 생성하지 않는다" "$skill"

  require_fixed "Ready for Handoff 상태" "$skill"

  echo "passed: continuation-skill-contract"
}

run_prompt_hook_for_runtime() {
  local runtime="$1"
  local task_file="$2"

  case "$runtime" in
    claude) run_claude_prompt_hook "$task_file" ;;
    codex) run_codex_prompt_hook "$task_file" ;;
    *) fail "unknown runtime: $runtime" ;;
  esac
}

check_runtime_entry_suggestion() {
  local runtime="$1"
  local fixture_dir="$2"
  local explicit_entry="$3"
  local explicit_command_name="${explicit_entry%% *}"
  local task_file="$fixture_dir/input/task.txt"
  local state_file
  local before_count
  local after_count
  local output

  state_file="$(user_local_state_file work-start/suggestions.json)"
  local visible_output
  local internal_context
  local repeated_output
  local repeated_visible_output

  require_file "$fixture_dir/fixture.yaml"
  require_file "$task_file"
  cleanup_files+=("$state_file")
  rm -f -- "$state_file"

  before_count="$(work_start_artifact_count)"
  output="$(run_prompt_hook_for_runtime "$runtime" "$task_file")"
  visible_output="$(printf '%s\n' "$output" | json_string_field systemMessage)"
  internal_context="$(printf '%s\n' "$output" | json_string_field hookSpecificOutput.additionalContext)"
  after_count="$(work_start_artifact_count)"

  [ "$before_count" = "$after_count" ] || fail "Work-start artifact was created before consent for $(basename "$fixture_dir")"
  [ -n "$visible_output" ] || fail "missing user-visible Work-start suggestion payload"
  [ -n "$internal_context" ] || fail "missing internal Work-start consent context"

  printf '%s\n' "$visible_output" | grep -q -F -- "Suggested by oh-my-ai: Work-start" || fail "visible payload missing Work-start suggestion"
  printf '%s\n' "$visible_output" | grep -q -F -- "oh-my-ai" || fail "visible payload missing oh-my-ai brand"
  printf '%s\n' "$visible_output" | grep -q -F -- "Work-start" || fail "visible payload missing Work-start name"
  printf '%s\n' "$visible_output" | grep -q -F -- "Work-start는 로컬 Artifact를 생성합니다" || fail "visible payload does not explain artifact behavior"
  printf '%s\n' "$visible_output" | grep -q -F -- "아직 Work-start는 실행되지 않았습니다" || fail "visible payload does not state Work-start has not run"
  printf '%s\n' "$visible_output" | grep -q -F -- "$explicit_entry" || fail "visible payload does not provide explicit follow-up entry"
  printf '%s\n' "$visible_output" | grep -q -F -- "사용하지 않으려면 현재 요청을 그대로 계속하세요" || fail "visible payload does not provide skip path"

  printf '%s\n' "$internal_context" | grep -q -F -- "Suggested by oh-my-ai: Work-start" || fail "internal context missing Work-start suggestion"
  printf '%s\n' "$internal_context" | grep -q -F -- "state: SUGGESTED" || fail "internal context missing SUGGESTED state"
  printf '%s\n' "$internal_context" | grep -q -F -- "no Work-start Engine has run" || fail "internal context does not state no engine ran"
  printf '%s\n' "$internal_context" | grep -q -F -- "no local Artifact has been created" || fail "internal context does not state no artifact was created"
  printf '%s\n' "$internal_context" | grep -q -F -- "Suggestion text is not a tool instruction" || fail "internal context does not separate text from tool instructions"
  printf '%s\n' "$internal_context" | grep -q -F -- "Suggestion text is not a Skill invocation request" || fail "internal context does not separate text from skill invocation"
  printf '%s\n' "$internal_context" | grep -q -F -- "Suggestion text is not Engine consent" || fail "internal context does not separate text from engine consent"
  printf '%s\n' "$internal_context" | grep -q -F -- "  $explicit_entry" || fail "internal context does not provide runtime explicit entry"
  printf '%s\n' "$internal_context" | grep -q -F -- "Do not run \`$explicit_command_name\`, \`make work-start\`, \`scripts/work-start.sh\`, or the Work-start Skill from this suggestion." \
    || fail "internal context does not explicitly block execution from suggestion"
  if printf '%s\n' "$visible_output"$'\n'"$internal_context" | grep -q -E 'work-start artifact created:|oh-my-ai Work-start artifacts created:'; then
    fail "suggestion output looks like engine execution"
  fi
  if printf '%s\n' "$visible_output"$'\n'"$internal_context" | grep -q -i -E 'ask the user to invoke|execute /work-start|run /work-start'; then
    fail "suggestion contains imperative execution wording"
  fi

  repeated_output="$(run_prompt_hook_for_runtime "$runtime" "$task_file")"
  repeated_visible_output="$(printf '%s\n' "$repeated_output" | json_string_field systemMessage)"
  if printf '%s\n' "$repeated_output" | grep -q -F -- "Suggested by oh-my-ai: Work-start"; then
    fail "same request was re-suggested after suppression"
  fi
  if [ -n "$repeated_visible_output" ]; then
    fail "same request produced user-visible suggestion after suppression"
  fi

  echo "passed: $(basename "$fixture_dir") $runtime-hook-rendering-payload"
}

check_runtime_entry_no_suggestion() {
  local runtime="$1"
  local fixture_dir="$2"
  local task_file="$fixture_dir/input/task.txt"
  local before_count
  local after_count
  local output

  require_file "$fixture_dir/fixture.yaml"
  require_file "$task_file"

  before_count="$(work_start_artifact_count)"
  output="$(run_prompt_hook_for_runtime "$runtime" "$task_file")"
  after_count="$(work_start_artifact_count)"

  [ "$before_count" = "$after_count" ] || fail "Work-start artifact was created for generic task before consent"
  if [ -n "$(printf '%s\n' "$output" | json_string_field systemMessage)" ]; then
    fail "generic code task produced user-visible Work-start suggestion"
  fi
  if printf '%s\n' "$(printf '%s\n' "$output" | json_string_field hookSpecificOutput.additionalContext)" | grep -q -F -- "Suggested by oh-my-ai: Work-start"; then
    fail "generic code task produced internal Work-start suggestion"
  fi
  if printf '%s\n' "$output" | grep -q -F -- "Suggested by oh-my-ai: Work-start"; then
    fail "generic code task produced Work-start suggestion"
  fi

  echo "passed: $(basename "$fixture_dir") $runtime-no-suggestion"
}

check_runtime_entry_synthetic_task_notification() {
  local runtime="$1"
  local fixture_dir="$2"
  local task_file="$fixture_dir/input/task.txt"
  local natural_task_file="$FIXTURE_ROOT/FX-WSH-040-runtime-entry-strong-intent/input/task.txt"
  local state_file
  local before_count
  local after_count
  local natural_output
  local synthetic_output
  local before_state_hash
  local after_state_hash

  state_file="$(user_local_state_file work-start/suggestions.json)"

  require_file "$fixture_dir/fixture.yaml"
  require_file "$task_file"
  require_file "$natural_task_file"
  cleanup_files+=("$state_file")
  rm -f -- "$state_file"

  natural_output="$(run_prompt_hook_for_runtime "$runtime" "$natural_task_file")"
  printf '%s\n' "$natural_output" | grep -q -F -- "Suggested by oh-my-ai: Work-start" \
    || fail "real user prompt did not establish suggestion state before synthetic notification"
  [ -f "$state_file" ] || fail "real user prompt did not create suggestion state"
  before_state_hash="$(sha256_file "$state_file")"

  before_count="$(work_start_artifact_count)"
  synthetic_output="$(run_prompt_hook_for_runtime "$runtime" "$task_file")"
  after_count="$(work_start_artifact_count)"
  after_state_hash="$(sha256_file "$state_file")"

  [ "$before_count" = "$after_count" ] || fail "synthetic task notification created a Work-start artifact"
  [ -z "$synthetic_output" ] || fail "synthetic task notification produced routing output"
  [ "$before_state_hash" = "$after_state_hash" ] || fail "synthetic task notification changed suggestion state"

  echo "passed: $(basename "$fixture_dir") $runtime-synthetic-task-notification"
}

check_runtime_entry_explicit_prompt_no_suggestion() {
  local runtime="$1"
  local explicit_prompt="$2"
  local state_file
  local task_file
  local before_count
  local after_count
  local output

  state_file="$(user_local_state_file work-start/suggestions.json)"

  task_file="$(mktemp)"
  cleanup_files+=("$state_file")
  rm -f -- "$state_file"
  printf '%s\n' "$explicit_prompt" > "$task_file"

  before_count="$(work_start_artifact_count)"
  output="$(run_prompt_hook_for_runtime "$runtime" "$task_file")"
  after_count="$(work_start_artifact_count)"
  rm -f -- "$task_file"

  [ "$before_count" = "$after_count" ] || fail "explicit prompt hook created an artifact for $runtime"
  if [ -n "$(printf '%s\n' "$output" | json_string_field systemMessage)" ]; then
    fail "explicit $runtime Work-start prompt produced a suggestion systemMessage"
  fi
  if printf '%s\n' "$output" | grep -q -F -- "Suggested by oh-my-ai: Work-start"; then
    fail "explicit $runtime Work-start prompt produced a suggestion payload"
  fi

  echo "passed: $runtime explicit-prompt-no-suggestion"
}

check_runtime_entry_explicit() {
  local fixture_dir="$1"
  local task_file="$fixture_dir/input/task.txt"
  local before_count
  local after_count
  local output
  local artifact

  require_file "$fixture_dir/fixture.yaml"
  require_file "$task_file"

  before_count="$(work_start_artifact_count)"
  output="$(run_work_start_output "$task_file")"
  after_count="$(work_start_artifact_count)"
  [ "$after_count" = "$((before_count + 1))" ] || fail "explicit entry did not create exactly one artifact"

  artifact="$(printf '%s\n' "$output" | sed -n 's/^work-start artifact created: //p' | tail -1)"
  [ -n "$artifact" ] || fail "could not parse explicit entry artifact path"
  cleanup_paths+=("$artifact")

  check_common_artifact "$artifact" "$FIXTURE_ROOT/FX-WSH-001-positive-doc-task"
  printf '%s\n' "$output" | grep -q -F -- "oh-my-ai Work-start completed." || fail "explicit output missing completion marker"
  printf '%s\n' "$output" | grep -q -F -- "Artifact directory:" || fail "explicit output missing artifact directory label"
  printf '%s\n' "$output" | grep -q -F -- "$artifact" || fail "explicit output missing actual artifact path"
  printf '%s\n' "$output" | grep -q -F -- "Status:" || fail "explicit output missing status label"
  printf '%s\n' "$output" | grep -q -F -- "Needs human review" || fail "explicit output missing review status"
  printf '%s\n' "$output" | grep -q -F -- "Choose the next step:" || fail "explicit output missing next step label"
  printf '%s\n' "$output" | grep -q -F -- "- Direct Handoff" || fail "explicit output missing Direct Handoff"
  printf '%s\n' "$output" | grep -q -F -- "- Plan First" || fail "explicit output missing Plan First"
  printf '%s\n' "$output" | grep -q -F -- "- Gather Context" || fail "explicit output missing Gather Context"
  printf '%s\n' "$output" | grep -q -F -- "Work-start has not modified the requested product code." || fail "explicit output missing no-product-code-change marker"
  printf '%s\n' "$output" | grep -q -F -- "Review the Candidate before continuing." || fail "explicit output missing stop/review marker"

  if printf '%s\n' "$output" | grep -q -i -E '수정할까요|구현하겠습니다|관련 코드를 분석하겠습니다|Worker로 진행|Plan First 자동 실행'; then
    fail "explicit output contains continuation wording"
  fi

  echo "passed: $(basename "$fixture_dir") explicit-entry"
}

parse_artifact_from_output() {
  sed -n 's/^work-start artifact created: //p' | tail -1
}

check_codex_runtime_entry_argument_normalization() {
  local fixture_dir="$1"
  local task_file="$fixture_dir/input/codex-prompt.txt"
  local before_count
  local after_count
  local output
  local artifact
  local dir_name
  local normalized_task="멀티라인 TASK 입력 시 Artifact 폴더명이 깨지는 문제를 수정하기 전에 관련 코드와 영향 범위를 정리해줘"

  require_file "$fixture_dir/fixture.yaml"
  require_file "$task_file"

  before_count="$(work_start_artifact_count)"
  output="$(run_codex_work_start_output "$task_file")"
  after_count="$(work_start_artifact_count)"
  [ "$after_count" = "$((before_count + 1))" ] || fail "Codex explicit entry did not create exactly one artifact after prefix normalization"

  artifact="$(printf '%s\n' "$output" | parse_artifact_from_output)"
  [ -n "$artifact" ] || fail "could not parse Codex normalized explicit entry artifact path"
  cleanup_paths+=("$artifact")
  dir_name="$(basename "$artifact")"

  check_common_artifact "$artifact" "$FIXTURE_ROOT/FX-WSH-001-positive-doc-task"
  printf '%s\n' "$output" | grep -q -F -- "Needs human review" || fail "Codex normalized explicit output missing review status"
  printf '%s\n' "$output" | grep -q -F -- "- Direct Handoff" || fail "Codex normalized explicit output missing Direct Handoff"
  printf '%s\n' "$output" | grep -q -F -- "- Plan First" || fail "Codex normalized explicit output missing Plan First"
  printf '%s\n' "$output" | grep -q -F -- "- Gather Context" || fail "Codex normalized explicit output missing Gather Context"
  printf '%s\n' "$output" | grep -q -F -- "Review the Candidate before continuing." || fail "Codex normalized explicit output missing stop/review marker"

  if printf '%s\n' "$dir_name" | grep -q -E '(^|-)work-start($|-)'; then
    fail "Codex command token leaked into artifact slug: $dir_name"
  fi
  if grep -r -q -F -- '$work-start 멀티라인' "$artifact"; then
    fail "Codex command token leaked into artifact body: $artifact"
  fi
  grep -r -q -F -- "$normalized_task" "$artifact" || fail "normalized Codex task not found in artifact body"

  echo "passed: $(basename "$fixture_dir") codex-prefix-removal"
}

check_codex_runtime_entry_task_preservation() {
  local fixture_dir="$1"
  local task_file="$fixture_dir/input/codex-preserve-task.txt"
  local before_count
  local after_count
  local output
  local artifact
  local dir_name
  local preserved_task="work-start 스킬의 설명을 정리해줘"

  require_file "$fixture_dir/fixture.yaml"
  require_file "$task_file"

  before_count="$(work_start_artifact_count)"
  output="$(run_codex_work_start_output "$task_file")"
  after_count="$(work_start_artifact_count)"
  [ "$after_count" = "$((before_count + 1))" ] || fail "Codex explicit preservation entry did not create exactly one artifact"

  artifact="$(printf '%s\n' "$output" | parse_artifact_from_output)"
  [ -n "$artifact" ] || fail "could not parse Codex preservation artifact path"
  cleanup_paths+=("$artifact")
  dir_name="$(basename "$artifact")"

  check_common_artifact "$artifact" "$FIXTURE_ROOT/FX-WSH-001-positive-doc-task"
  if grep -r -q -F -- '$work-start work-start' "$artifact"; then
    fail "Codex command token leaked into preserved-task artifact body: $artifact"
  fi
  grep -r -q -F -- "$preserved_task" "$artifact" || fail "Codex task body work-start mention was not preserved"
  printf '%s\n' "$dir_name" | grep -q -F -- "work-start" || fail "Codex task body work-start mention was not preserved in slug: $dir_name"

  echo "passed: $(basename "$fixture_dir") codex-task-preservation"
}

run_fixture() {
  local fixture_dir="$1"
  local fixture_id
  local artifact

  fixture_id="$(basename "$fixture_dir")"
  require_file "$fixture_dir/fixture.yaml"
  require_file "$fixture_dir/input/task.txt"
  require_file "$fixture_dir/expected/required-handoff-fields.txt"
  require_file "$fixture_dir/expected/result-basic-markers.txt"

  artifact="$(run_work_start "$fixture_dir/input/task.txt")"
  [ -n "$artifact" ] || fail "could not parse artifact path for $fixture_id"
  case "$artifact" in
    .oh-my-ai/work-start/*) ;;
    *) fail "unsafe artifact path for $fixture_id: $artifact" ;;
  esac
  cleanup_paths+=("$artifact")

  check_common_artifact "$artifact" "$fixture_dir"

  case "$fixture_id" in
    FX-WSH-001-*) check_positive "$fixture_dir" "$artifact" ;;
    FX-WSH-010-*) check_negative "$fixture_dir" "$artifact" ;;
    FX-WSH-020-*|FX-WSH-030-*) ;;
    FX-WSH-060-*) check_multiline_slug "$fixture_dir" "$artifact" ;;
    *) fail "unknown fixture id: $fixture_id" ;;
  esac

  echo "passed: $fixture_id -> $artifact"
}

require_file "scripts/work-start.sh"
require_file "scripts/codex-work-start-entry.sh"
require_file "scripts/work-start-skill-match.mjs"
require_file "scripts/prompt-routing-hook.mjs"
require_file "templates/result-basic.md"
require_file "skills/handoff-prompt/SKILL.md"
# Build an isolated PATH containing only the named commands, so the suite can drive
# Work-start's search-backend detection instead of inheriting whatever the host has.
make_isolated_bin() {
  local bin_dir="$1"
  shift
  local cmd resolved
  mkdir -p "$bin_dir"
  for cmd in "$@"; do
    resolved="$(command -v "$cmd" 2>/dev/null)" || continue
    ln -sf "$resolved" "$bin_dir/$cmd"
  done
}

WORK_START_BASE_TOOLS=(bash date sed awk find cut sort head wc tr mkdir mv rm cat basename dirname readlink git xargs uname)

manifest_field() {
  local field="$1"
  local file="$2"
  sed -n "s/^[[:space:]]*${field}: //p" "$file" | head -1 | tr -d "'"
}

candidate_block_count() {
  local start="$1"
  local file="$2"
  sed -n "/^${start}:/,/^${start}_status:/p" "$file" | grep -c '  - text:' || true
}

# Truthfulness contract: a scan that could not run must never be reported as a scan
# that found nothing. Exercises rg / grep / no-backend against a probe document that
# really does contain decision and risk lines.
check_search_backend_degradation() {
  local fixture_dir="$FIXTURE_ROOT/FX-WSH-100-search-backend-degradation"
  local task_file="$fixture_dir/input/task.txt"
  local probe="$fixture_dir/input/decision-source.md"
  local sandbox artifact manifest output rg_bin

  require_file "$fixture_dir/fixture.yaml"
  require_file "$fixture_dir/README.md"
  require_file "$task_file"
  require_file "$probe"

  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/oh-my-ai-work-start-backend.XXXXXX")"
  cleanup_dirs+=("$sandbox")

  # --- grep fallback: rg deliberately excluded, grep available.
  make_isolated_bin "$sandbox/grep-only" "${WORK_START_BASE_TOOLS[@]}" grep
  output="$(env -i PATH="$sandbox/grep-only" HOME="$HOME" TASK="$(cat "$task_file")" \
    bash scripts/work-start.sh 2>&1)" || fail "grep-backend Work-start exited non-zero"
  artifact="$(printf '%s\n' "$output" | parse_artifact_from_output)"
  [ -n "$artifact" ] || fail "could not parse grep-backend artifact path"
  cleanup_paths+=("$artifact")
  manifest="$artifact/context-manifest.yaml"
  require_file "$manifest"

  [ "$(manifest_field backend "$manifest")" = "grep" ] || fail "expected grep backend without rg on PATH"
  [ "$(manifest_field degraded "$manifest")" = "true" ] || fail "grep backend was not marked degraded"
  [ "$(manifest_field content_scan "$manifest")" = "scanned" ] || fail "grep backend did not record a performed scan"
  [ "$(candidate_block_count decision_candidates "$manifest")" -gt 0 ] \
    || fail "grep fallback found no decision candidates although the probe document has them"
  [ "$(candidate_block_count risk_candidates "$manifest")" -gt 0 ] \
    || fail "grep fallback found no risk candidates although the probe document has them"
  require_fixed "grep" "$artifact/context-gap-report.md"

  # --- no backend at all: absence must not be asserted.
  make_isolated_bin "$sandbox/no-backend" "${WORK_START_BASE_TOOLS[@]}"
  output="$(env -i PATH="$sandbox/no-backend" HOME="$HOME" TASK="$(cat "$task_file")" \
    bash scripts/work-start.sh 2>&1)" || fail "no-backend Work-start exited non-zero"
  artifact="$(printf '%s\n' "$output" | parse_artifact_from_output)"
  [ -n "$artifact" ] || fail "could not parse no-backend artifact path"
  cleanup_paths+=("$artifact")
  manifest="$artifact/context-manifest.yaml"
  require_file "$manifest"

  [ "$(manifest_field backend "$manifest")" = "none" ] || fail "expected 'none' backend with no search tool on PATH"
  [ "$(manifest_field content_scan "$manifest")" = "scan_unavailable" ] || fail "no-backend run did not record scan_unavailable"
  [ "$(manifest_field decision_candidates_status "$manifest")" = "scan_unavailable" ] \
    || fail "decision candidates status did not record scan_unavailable"
  [ "$(manifest_field risk_candidates_status "$manifest")" = "scan_unavailable" ] \
    || fail "risk candidates status did not record scan_unavailable"
  if grep -r -q -E 'No (decision|risk) candidates were found' "$artifact"; then
    fail "unavailable scan asserted absence of decision/risk candidates"
  fi
  require_fixed "scan unavailable" "$artifact/context-gap-report.md"

  # --- rg present: only assert when the host actually has ripgrep.
  rg_bin="$(command -v rg 2>/dev/null || true)"
  if [ -n "$rg_bin" ]; then
    make_isolated_bin "$sandbox/with-rg" "${WORK_START_BASE_TOOLS[@]}" grep rg
    output="$(env -i PATH="$sandbox/with-rg" HOME="$HOME" TASK="$(cat "$task_file")" \
      bash scripts/work-start.sh 2>&1)" || fail "rg-backend Work-start exited non-zero"
    artifact="$(printf '%s\n' "$output" | parse_artifact_from_output)"
    [ -n "$artifact" ] || fail "could not parse rg-backend artifact path"
    cleanup_paths+=("$artifact")
    manifest="$artifact/context-manifest.yaml"
    require_file "$manifest"

    [ "$(manifest_field backend "$manifest")" = "rg" ] || fail "expected rg backend with rg on PATH"
    [ "$(manifest_field degraded "$manifest")" = "false" ] || fail "rg backend should not be degraded"
    [ "$(candidate_block_count decision_candidates "$manifest")" -gt 0 ] \
      || fail "rg backend found no decision candidates although the probe document has them"
    echo "passed: FX-WSH-100-search-backend-degradation rg-present"
  else
    echo "skipped: FX-WSH-100-search-backend-degradation rg-present (no ripgrep on PATH)"
  fi

  echo "passed: FX-WSH-100-search-backend-degradation backend-degradation"
}

require_file "skills/work-start/SKILL.md"

run_fixture "$FIXTURE_ROOT/FX-WSH-001-positive-doc-task"
run_fixture "$FIXTURE_ROOT/FX-WSH-010-ambiguous-deploy-task"
run_fixture "$FIXTURE_ROOT/FX-WSH-020-multi-scope-task"
run_fixture "$FIXTURE_ROOT/FX-WSH-030-external-context-task"
run_fixture "$FIXTURE_ROOT/FX-WSH-060-multiline-task-slug"
check_runtime_entry_metadata
check_codex_runtime_entry_metadata
check_continuation_skill_contract
check_runtime_entry_suggestion claude "$FIXTURE_ROOT/FX-WSH-040-runtime-entry-strong-intent" "/work-start"
check_runtime_entry_suggestion codex "$FIXTURE_ROOT/FX-WSH-040-runtime-entry-strong-intent" '$work-start'
check_runtime_entry_no_suggestion claude "$FIXTURE_ROOT/FX-WSH-050-runtime-entry-generic-code-task"
check_runtime_entry_no_suggestion codex "$FIXTURE_ROOT/FX-WSH-050-runtime-entry-generic-code-task"
check_runtime_entry_synthetic_task_notification claude "$FIXTURE_ROOT/FX-WSH-090-synthetic-task-notification"
check_runtime_entry_synthetic_task_notification codex "$FIXTURE_ROOT/FX-WSH-090-synthetic-task-notification"
check_runtime_entry_explicit_prompt_no_suggestion claude "/work-start 이 문제를 고치기 전에 관련 코드와 영향 범위를 먼저 정리해줘."
check_runtime_entry_explicit_prompt_no_suggestion codex '$work-start 이 문제를 고치기 전에 관련 코드와 영향 범위를 먼저 정리해줘.'
check_runtime_entry_explicit "$FIXTURE_ROOT/FX-WSH-070-explicit-work-start-entry"
check_runtime_entry_explicit "$FIXTURE_ROOT/FX-WSH-080-codex-explicit-work-start-entry"
check_codex_runtime_entry_argument_normalization "$FIXTURE_ROOT/FX-WSH-080-codex-explicit-work-start-entry"
check_codex_runtime_entry_task_preservation "$FIXTURE_ROOT/FX-WSH-080-codex-explicit-work-start-entry"
check_search_backend_degradation

echo "work-start fixtures passed"
