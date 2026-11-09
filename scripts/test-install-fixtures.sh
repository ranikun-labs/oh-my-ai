#!/usr/bin/env bash
set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO"

FIXTURE_ROOT="fixtures/install"
FIXTURE_TEMP_PARENT="${TMPDIR:-/tmp}"
TEMP_ROOT="$(mktemp -d "${FIXTURE_TEMP_PARENT%/}/oh-my-ai-install-fixtures.XXXXXX")"

cleanup() {
  [ "${KEEP_INSTALL_FIXTURE_ARTIFACTS:-}" = "1" ] || rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT

run_isolated_check() {
  "$@"
  if [ "${KEEP_INSTALL_FIXTURE_ARTIFACTS:-}" != "1" ]; then
    find "$TEMP_ROOT" -mindepth 1 -depth -delete
  fi
}

fail() {
  echo "fixture failure: $*" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "missing file: $1"
}

require_fixed() {
  local text="$1"
  local value="$2"
  printf '%s\n' "$value" | grep -q -F -- "$text" || fail "missing text '$text'"
}

clone_fixture_repo() {
  local name="$1"
  local clone="$TEMP_ROOT/$name/repo"

  mkdir -p "$(dirname "$clone")"
  git clone --quiet --local --no-hardlinks "$REPO" "$clone"

  # Let the runner validate the current working tree before its changes are committed.
  if ! git diff --quiet HEAD --; then
    git diff --binary HEAD -- | git -C "$clone" apply
  fi
  git ls-files --others --exclude-standard -z | while IFS= read -r -d '' file; do
    mkdir -p "$clone/$(dirname "$file")"
    if [ -L "$REPO/$file" ]; then
      ln -s "$(readlink "$REPO/$file")" "$clone/$file"
    else
      cp "$REPO/$file" "$clone/$file"
    fi
  done
  printf '%s\n' "$clone"
}

run_setup() {
  local clone="$1"
  local home_dir="$2"
  shift 2
  env \
    HOME="$home_dir" \
    CLAUDE_DIR="$home_dir/.claude" \
    CODEX_DIR="$home_dir/.codex" \
    AGENT_DIR="$home_dir/.agents" \
    LOCAL_BIN="$home_dir/.local/bin" \
    "$clone/setup.sh" "$@"
}

assert_link() {
  local path="$1"
  local target="$2"
  [ -L "$path" ] || fail "expected symlink: $path"
  [ "$(readlink "$path")" = "$target" ] || fail "unexpected symlink target for $path"
  [ -e "$path" ] || fail "dangling symlink after install: $path"
}

assert_resolved_link() {
  local path="$1"
  local target="$2"
  [ -L "$path" ] || fail "expected symlink: $path"
  node -e 'const fs = require("fs"); process.exit(fs.realpathSync(process.argv[1]) === fs.realpathSync(process.argv[2]) ? 0 : 1)' "$path" "$target" \
    || fail "unexpected resolved symlink target for $path"
  [ -e "$path" ] || fail "dangling symlink after install: $path"
}

assert_managed_hooks_once() {
  local runtime="$1"
  local target="$2"

  # Verify final JSON independently of the installer's operation classifier.
  node -e '
    const fs = require("fs");
    const runtime = process.argv[1];
    const installed = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const normalise = (value) => String(value).trim()
      .replace(/"\$(?:HOME|\{HOME\})\/\.local\/bin\/oh-my-ai"|\$(?:HOME|\{HOME\})\/\.local\/bin\/oh-my-ai/g, "<oh>")
      .replace(/"\$(?:HOME|\{HOME\})\/\.local\/bin\/harness-event"|\$(?:HOME|\{HOME\})\/\.local\/bin\/harness-event/g, "<event>")
      .replace(/\s+/g, " ");
    const matcher = (group) => {
      if (group.matcher === undefined) return "none";
      if (typeof group.matcher !== "string") return "other";
      const value = group.matcher.trim();
      if (["Skill", "^Skill$"].includes(value)) return "skill";
      if (value === "Write|Edit|MultiEdit|NotebookEdit|Bash") return "context-activity";
      if (value === "apply_patch|Bash") return "codex-context-activity";
      if (value === "startup|resume|clear") return "codex-session-start";
      return "other";
    };
    const count = (event, requiredMatcher, predicate) => (installed.hooks[event] || []).flatMap((group) => matcher(group) === requiredMatcher ? (group.hooks || []) : []).filter(predicate).length;
    const wrapper = (event) => (hook) => hook.type === "command" && normalise(hook.command) === `if [ -x <oh> ]; then <oh> hook ${runtime} ${event}; else cat >/dev/null 2>&1 || :; fi`;
    if (runtime === "claude") {
      if (count("SessionStart", "none", wrapper("SessionStart")) !== 1) process.exit(1);
      if (count("UserPromptSubmit", "none", (hook) => wrapper("UserPromptSubmit")(hook) || (hook.type === "command" && /prompt-routing-hook\.mjs/.test(hook.command) && /claude-json/.test(hook.command))) !== 1) process.exit(1);
      if (count("PostToolUse", "context-activity", wrapper("PostToolUse")) !== 1) process.exit(1);
      if (count("PostToolUse", "skill", (hook) => hook.type === "command" && /harness-event/.test(hook.command) && /emit\s+skill-start/.test(hook.command) && /--runtime\s+claude/.test(hook.command)) !== 1) process.exit(1);
      if (count("SessionEnd", "none", wrapper("SessionEnd")) !== 1) process.exit(1);
    } else {
      if (count("UserPromptSubmit", "none", (hook) => wrapper("UserPromptSubmit")(hook) || (hook.type === "command" && /prompt-routing-hook\.mjs/.test(hook.command) && /--format(?:=|\s+)text/.test(hook.command))) !== 1) process.exit(1);
      if (count("SessionStart", "codex-session-start", wrapper("SessionStart")) !== 1) process.exit(1);
      if (count("PostToolUse", "codex-context-activity", wrapper("PostToolUse")) !== 1) process.exit(1);
      if (count("SessionEnd", "none", wrapper("SessionEnd")) !== 1) process.exit(1);
    }
  ' "$runtime" "$target" || fail "managed Hook operations were not installed exactly once in $target"
}

assert_shared_install() {
  local clone="$1"
  local home_dir="$2"

  assert_link "$home_dir/.claude/CLAUDE.md" "$clone/claude/CLAUDE.md"
  [ -f "$home_dir/.claude/settings.json" ] || fail "missing Claude settings config"
  [ ! -L "$home_dir/.claude/settings.json" ] || fail "Claude settings must be merged, not linked"
  [ "$(node "$clone/scripts/merge-runtime-hooks.mjs" --mode check --runtime claude --source "$clone/claude/settings.json" --target "$home_dir/.claude/settings.json")" = "ready" ] \
    || fail "Claude managed hooks are not ready"
  assert_managed_hooks_once claude "$home_dir/.claude/settings.json"
  assert_link "$home_dir/.claude/skills/work-start" "$clone/skills/work-start"
  [ ! -L "$home_dir/.claude/agents" ] || fail "install created a link for a missing Claude agents source"
  assert_link "$home_dir/.codex/AGENTS.md" "$clone/AGENTS.md"
  [ -f "$home_dir/.codex/hooks.json" ] || fail "missing Codex hooks config"
  [ ! -L "$home_dir/.codex/hooks.json" ] || fail "Codex hooks must be merged, not linked"
  [ "$(node "$clone/scripts/merge-runtime-hooks.mjs" --mode check --runtime codex --source "$clone/codex/hooks.json" --target "$home_dir/.codex/hooks.json")" = "ready" ] \
    || fail "Codex managed hooks are not ready"
  assert_managed_hooks_once codex "$home_dir/.codex/hooks.json"
  assert_link "$home_dir/.agents/skills/work-start" "$clone/skills/work-start"
  assert_link "$home_dir/.agents/skills/spec-to-implementation" "$clone/skills/spec-to-implementation"
  assert_link "$clone/.agents/skills/spec-to-implementation" "../../skills/spec-to-implementation"
  assert_link "$home_dir/.local/bin/oh-my-ai" "$clone/scripts/oh-my-ai.mjs"
  assert_resolved_link "$home_dir/.local/bin/harness-event" "$clone/scripts/harness-event.mjs"
}

assert_work_start_artifact() {
  local target="$1"
  local source="$2"
  local output="$3"
  local invocation_log="$4"
  local artifact

  artifact="$(printf '%s\n' "$output" | sed -n 's/^work-start artifact created: //p' | tail -1)"
  [ -n "$artifact" ] || fail "installed public entry did not report an artifact"
  case "$artifact" in
    .oh-my-ai/work-start/*) ;;
    *) fail "installed public entry reported unsafe artifact path: $artifact" ;;
  esac
  [ -d "$target/$artifact" ] || fail "artifact was not created in target repository: $target/$artifact"
  for file in context-manifest.yaml sources.md context-gap-report.md starter-prompt.md handoff-candidate.md; do
    require_file "$target/$artifact/$file"
  done
  [ ! -e "$source/.oh-my-ai/work-start" ] || fail "artifact leaked into oh-my-ai source repository"
  [ "$(artifact_directory_count "$target/.oh-my-ai/work-start")" = "1" ] \
    || fail "installed public entry did not create exactly one artifact"
  [ "$(engine_invocation_count "$invocation_log")" = "1" ] \
    || fail "installed public entry did not invoke the Engine exactly once"
}

artifact_directory_count() {
  node -e '
    const fs = require("fs"); const root = process.argv[1];
    if (!fs.existsSync(root)) { console.log(0); process.exit(0); }
    console.log(fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length);
  ' "$1"
}

engine_invocation_count() {
  node -e '
    const fs = require("fs"); const file = process.argv[1];
    if (!fs.existsSync(file)) { console.log(0); process.exit(0); }
    console.log(fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length);
  ' "$1"
}

make_target_repo() {
  local target="$1"
  mkdir -p "$target"
  git -C "$target" init --quiet
  printf '%s\n' '# target repository' >"$target/README.md"
  git -C "$target" add README.md
  git -C "$target" -c user.name=fixture -c user.email=fixture@example.invalid commit --quiet -m fixture
}

run_installed_work_start() {
  local target="$1"
  local entry="$2"
  local task="$3"
  local invocation_log="$4"
  local runtime="${5:-}"
  local session_id="${6:-}"
  (
    cd "$target"
    case "$runtime" in
      claude)
        OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" CLAUDE_CODE_SESSION_ID="$session_id" "$entry" work-start -- "$task"
        ;;
      codex)
        OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" OH_MY_AI_WORK_START_RUNTIME=codex OH_MY_AI_WORK_START_SESSION_ID="$session_id" "$entry" work-start -- "$task"
        ;;
      "")
        # An ambient agent session (e.g. this fixture running inside Claude
        # Code itself) must not leak into a Fixture that asserts "no Engine
        # Session". Strip it explicitly rather than relying on a clean shell.
        # (Safe to unset here: we are already inside this function's own
        # subshell, so it cannot affect the caller's environment.)
        unset CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION OH_MY_AI_WORK_START_SESSION_ID OH_MY_AI_WORK_START_RUNTIME
        OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" "$entry" work-start -- "$task"
        ;;
      *) fail "unsupported fixture runtime: $runtime" ;;
    esac
  )
}

run_installed_prompt_hook() {
  local target="$1"
  local entry="$2"
  local runtime="$3"
  local prompt="$4"
  local session_id="${5:-fixture-session}"
  local payload

  payload="$(node -e 'const payload = { prompt: process.argv[1] }; if (process.argv[2] !== "__missing__") payload.session_id = process.argv[2]; process.stdout.write(JSON.stringify(payload));' "$prompt" "$session_id")"
  (
    cd "$target"
    printf '%s' "$payload" | "$entry" hook "$runtime" UserPromptSubmit
  )
}

assert_post_execution_hook_suppressed() {
  local output="$1"
  local runtime="$2"

  [ -z "$output" ] || fail "$runtime post-execution hook emitted routing output: $output"
}

assert_post_execution_hook_not_suppressed() {
  local output="$1"
  local runtime="$2"

  printf '%s\n' "$output" | grep -q -F -- 'Suggested by oh-my-ai: Work-start' \
    || fail "$runtime hook was incorrectly suppressed: $output"
}

hash_files() {
  node -e '
    const crypto = require("crypto"); const fs = require("fs");
    const hash = crypto.createHash("sha256");
    for (const file of process.argv.slice(1)) { hash.update(file); hash.update("\0"); hash.update(fs.readFileSync(file)); hash.update("\0"); }
    console.log(hash.digest("hex"));
  ' "$@"
}

file_hash() { hash_files "$1"; }

link_manifest() {
  node -e '
    const fs = require("fs"); const path = require("path"); const root = process.argv[1]; const links = [];
    function visit(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const item = path.join(directory, entry.name); const stat = fs.lstatSync(item); if (stat.isSymbolicLink()) links.push(`${item} -> ${fs.readlinkSync(item)}`); else if (stat.isDirectory()) visit(item); } }
    if (fs.existsSync(root)) visit(root); console.log(links.sort().join("\n"));
  ' "$1"
}

check_fixture_metadata() {
  local fixture="$1"
  require_file "$fixture/fixture.yaml"
  require_file "$fixture/README.md"
}

check_fresh_install() {
  local fixture="$FIXTURE_ROOT/FX-INS-001-fresh-install"
  local clone home_dir dry_run_output doctor_output
  local before after

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo fresh-install)"
  home_dir="$TEMP_ROOT/fresh-install/home"
  before="$(hash_files "$clone/CLAUDE.md" "$clone/claude/CLAUDE.md" "$clone/AGENTS.md" "$clone/MINE.md")"
  dry_run_output="$(run_setup "$clone" "$home_dir" --install-shared --dry-run)"
  after="$(hash_files "$clone/CLAUDE.md" "$clone/claude/CLAUDE.md" "$clone/AGENTS.md" "$clone/MINE.md")"

  [ "$before" = "$after" ] || fail "dry-run changed generated repository instructions"
  [ ! -e "$home_dir/.claude" ] && [ ! -e "$home_dir/.codex" ] && [ ! -e "$home_dir/.agents" ] && [ ! -e "$home_dir/.local" ] \
    || fail "dry-run created a user configuration path"
  require_fixed "DRY-RUN: $clone/scripts/render-instructions.sh" "$dry_run_output"

  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  assert_shared_install "$clone" "$home_dir"
  doctor_output="$(run_setup "$clone" "$home_dir" --doctor --strict)"
  if printf '%s\n' "$doctor_output" | grep -q -E '^dangling:'; then
    fail "healthy fresh install reported a dangling symlink"
  fi

  echo "passed: FX-INS-001 fresh-install"
}

check_reinstall_idempotency() {
  local fixture="$FIXTURE_ROOT/FX-INS-010-reinstall-idempotency"
  local clone home_dir before after config_before config_after output relative_target

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo reinstall-idempotency)"
  home_dir="$TEMP_ROOT/reinstall-idempotency/home"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  relative_target="$(node -e 'const path = require("path"); console.log(path.relative(path.dirname(process.argv[1]), process.argv[2]))' "$home_dir/.local/bin/harness-event" "$clone/scripts/harness-event.mjs")"
  rm -f -- "$home_dir/.local/bin/harness-event"
  ln -s "$relative_target" "$home_dir/.local/bin/harness-event"
  before="$(link_manifest "$home_dir")"
  config_before="$(hash_files "$home_dir/.claude/settings.json" "$home_dir/.codex/hooks.json")"
  output="$(run_setup "$clone" "$home_dir" --install-shared)"
  after="$(link_manifest "$home_dir")"
  config_after="$(hash_files "$home_dir/.claude/settings.json" "$home_dir/.codex/hooks.json")"

  [ "$before" = "$after" ] || fail "reinstall changed managed symlinks"
  [ "$config_before" = "$config_after" ] || fail "reinstall changed merged hook config"
  require_fixed "already managed" "$output"
  require_fixed "Claude managed hooks: ready" "$output"
  require_fixed "Codex managed hooks: ready" "$output"
  assert_shared_install "$clone" "$home_dir"
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "0" ] \
    || fail "relative managed entrypoint did not remain strict-ready"

  echo "passed: FX-INS-010 reinstall-idempotency"
}

check_healthy_doctor() {
  local fixture="$FIXTURE_ROOT/FX-INS-020-healthy-doctor"
  local clone home_dir output

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo healthy-doctor)"
  home_dir="$TEMP_ROOT/healthy-doctor/home"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  output="$(run_setup "$clone" "$home_dir" --doctor --strict)"

  require_fixed "=== oh-my-ai doctor (read-only) ===" "$output"
  if printf '%s\n' "$output" | grep -q -E '^dangling:'; then
    fail "healthy doctor reported a dangling symlink"
  fi

  echo "passed: FX-INS-020 healthy-doctor"
}

check_broken_install() {
  local fixture="$FIXTURE_ROOT/FX-INS-030-broken-install"
  local clone home_dir default_output strict_output strict_status

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo broken-install)"
  home_dir="$TEMP_ROOT/broken-install/home"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null

  rm -rf -- "$clone/skills"
  rm -f -- "$clone/claude/CLAUDE.md"

  default_output="$(run_setup "$clone" "$home_dir" --doctor)"
  require_fixed "dangling: $home_dir/.claude/CLAUDE.md" "$default_output"
  require_fixed "Claude: incomplete" "$default_output"
  require_fixed "Codex: incomplete" "$default_output"

  set +e
  strict_output="$(run_setup "$clone" "$home_dir" --doctor --strict 2>&1)"
  strict_status=$?
  set -e
  [ "$strict_status" -eq 1 ] || fail "strict doctor exit code was $strict_status, expected 1"
  require_fixed "dangling: $home_dir/.claude/CLAUDE.md" "$strict_output"

  echo "passed: FX-INS-030 broken-install"
}

doctor_strict_status() {
  local clone="$1"
  local home_dir="$2"
  local status
  set +e
  run_setup "$clone" "$home_dir" --doctor --strict >/dev/null 2>&1
  status=$?
  set -e
  printf '%s' "$status"
}

# Doctor guidance is only useful if following it literally clears strict failure.
# Case A: managed source still exists -> install-shared can relink.
# Case B: managed source is gone      -> install-shared skips, so it must tell the
#         user to remove the dangling link instead.
check_dangling_link_recovery() {
  local fixture="$FIXTURE_ROOT/FX-INS-040-dangling-link-recovery"
  local clone home_dir output link_path

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo dangling-link-recovery)"
  home_dir="$TEMP_ROOT/dangling-link-recovery/home"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null

  # --- Case A: source present, link broken by repointing it at a missing path.
  link_path="$home_dir/.claude/CLAUDE.md"
  rm -f -- "$link_path"
  ln -s "$clone/claude/CLAUDE.md.missing" "$link_path"

  output="$(run_setup "$clone" "$home_dir" --doctor)"
  require_fixed "dangling: $link_path" "$output"
  require_fixed "source exists; run: make install-shared to relink" "$output"
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "1" ] || fail "case A: strict doctor did not fail on dangling link"

  # Follow the printed guidance.
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "0" ] \
    || fail "case A: strict doctor still fails after following install-shared guidance"

  # --- Case B: an optional managed source is absent, so install-shared cannot help.
  # Core runtime readiness remains healthy after the user follows the printed
  # guidance, which makes this a host pre-existing dangling-link check.
  link_path="$home_dir/.claude/agents"
  ln -s "$clone/claude/agents.missing" "$link_path"

  output="$(run_setup "$clone" "$home_dir" --doctor)"
  require_fixed "dangling: $link_path" "$output"
  require_fixed "source $clone/claude/agents is also missing" "$output"
  require_fixed "to clear it: rm '$link_path'" "$output"
  if printf '%s\n' "$output" | grep -q -E "source exists; run: make install-shared to relink"; then
    fail "case B: doctor recommended install-shared although the source is missing"
  fi
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "1" ] || fail "case B: strict doctor did not fail on dangling link"

  # Following install-shared must NOT be enough here; the link is still dangling.
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "1" ] \
    || fail "case B: expected install-shared to be insufficient while the source is missing"

  # Follow the printed guidance instead.
  rm -- "$link_path"
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "0" ] \
    || fail "case B: strict doctor still fails after removing the dangling link as instructed"

  echo "passed: FX-INS-040 dangling-link-recovery"
}

check_existing_claude_settings_merge() {
  local fixture="$FIXTURE_ROOT/FX-INS-050-existing-claude-settings"
  local clone home_dir output

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo existing-claude-settings)"
  home_dir="$TEMP_ROOT/existing-claude-settings/home"
  mkdir -p "$home_dir/.claude" "$home_dir/.codex"
  node -e '
    const fs = require("fs");
    const settings = {
      theme: "user-theme",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "user-session-hook" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-prompt-hook" }] }],
      },
    };
    fs.writeFileSync(process.argv[1], `${JSON.stringify(settings, null, 2)}\n`);
  ' "$home_dir/.claude/settings.json"
  node -e '
    const fs = require("fs");
    const hooks = {
      userSetting: "preserved",
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "user-codex-session-hook" }] }],
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user-codex-post-tool-hook" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "user-codex-session-end-hook" }] }],
      },
    };
    fs.writeFileSync(process.argv[1], `${JSON.stringify(hooks, null, 2)}\n`);
  ' "$home_dir/.codex/hooks.json"

  output="$(run_setup "$clone" "$home_dir" --install-shared)"
  require_fixed "Claude managed hooks: updated" "$output"
  require_fixed "Claude: configured" "$output"
  require_fixed '"theme": "user-theme"' "$(cat "$home_dir/.claude/settings.json")"
  require_fixed "user-session-hook" "$(cat "$home_dir/.claude/settings.json")"
  require_fixed "user-prompt-hook" "$(cat "$home_dir/.claude/settings.json")"
  require_fixed '"userSetting": "preserved"' "$(cat "$home_dir/.codex/hooks.json")"
  require_fixed "user-codex-session-hook" "$(cat "$home_dir/.codex/hooks.json")"
  require_fixed "user-codex-post-tool-hook" "$(cat "$home_dir/.codex/hooks.json")"
  require_fixed "user-codex-session-end-hook" "$(cat "$home_dir/.codex/hooks.json")"
  assert_managed_hooks_once claude "$home_dir/.claude/settings.json"
  assert_managed_hooks_once codex "$home_dir/.codex/hooks.json"

  echo "passed: FX-INS-050 existing-claude-settings"
}

check_existing_skill_directories() {
  local fixture="$FIXTURE_ROOT/FX-INS-060-existing-skill-directories"
  local clone home_dir

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo existing-skill-directories)"
  home_dir="$TEMP_ROOT/existing-skill-directories/home"
  mkdir -p "$home_dir/.claude/skills/user-skill" "$home_dir/.agents/skills/user-skill"
  printf '%s\n' 'user Claude skill' >"$home_dir/.claude/skills/user-skill/SKILL.md"
  printf '%s\n' 'user Codex skill' >"$home_dir/.agents/skills/user-skill/SKILL.md"

  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  require_fixed "user Claude skill" "$(cat "$home_dir/.claude/skills/user-skill/SKILL.md")"
  require_fixed "user Codex skill" "$(cat "$home_dir/.agents/skills/user-skill/SKILL.md")"
  assert_link "$home_dir/.claude/skills/work-start" "$clone/skills/work-start"
  assert_link "$home_dir/.agents/skills/work-start" "$clone/skills/work-start"

  echo "passed: FX-INS-060 existing-skill-directories"
}

check_work_start_conflict() {
  local fixture="$FIXTURE_ROOT/FX-INS-070-work-start-conflict"
  local clone home_dir output status

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo work-start-conflict)"
  home_dir="$TEMP_ROOT/work-start-conflict/home"
  mkdir -p "$home_dir/.claude/skills/work-start"
  printf '%s\n' 'user-owned work-start skill' >"$home_dir/.claude/skills/work-start/SKILL.md"

  set +e
  output="$(run_setup "$clone" "$home_dir" --install-shared 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "work-start collision install exit code was $status, expected 1"
  require_fixed "Claude work-start skill exists and does not point to this repository" "$output"
  require_fixed "Claude: conflict" "$output"
  require_fixed "user-owned work-start skill" "$(cat "$home_dir/.claude/skills/work-start/SKILL.md")"

  echo "passed: FX-INS-070 work-start-conflict"
}

check_spec_to_implementation_conflict() {
  local fixture="$FIXTURE_ROOT/FX-INS-110-spec-to-implementation-conflict"
  local clone home_dir output status

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo spec-to-implementation-conflict)"
  home_dir="$TEMP_ROOT/spec-to-implementation-conflict/home"
  mkdir -p "$home_dir/.agents/skills/spec-to-implementation"
  printf '%s\n' 'user-owned spec-to-implementation skill' >"$home_dir/.agents/skills/spec-to-implementation/SKILL.md"

  set +e
  output="$(run_setup "$clone" "$home_dir" --install-shared 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "spec-to-implementation collision install exit code was $status, expected 1"
  require_fixed "Codex spec-to-implementation skill exists and does not point to this repository" "$output"
  require_fixed "Codex: conflict" "$output"
  require_fixed "user-owned spec-to-implementation skill" "$(cat "$home_dir/.agents/skills/spec-to-implementation/SKILL.md")"

  echo "passed: FX-INS-110 spec-to-implementation-conflict"
}

check_invalid_existing_json() {
  local fixture="$FIXTURE_ROOT/FX-INS-080-invalid-existing-json"
  local clone home_dir output status before after

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo invalid-existing-json)"
  home_dir="$TEMP_ROOT/invalid-existing-json/home"
  mkdir -p "$home_dir/.claude"
  printf '%s\n' '{ invalid JSON' >"$home_dir/.claude/settings.json"
  before="$(file_hash "$home_dir/.claude/settings.json")"

  set +e
  output="$(run_setup "$clone" "$home_dir" --install-shared 2>&1)"
  status=$?
  set -e
  after="$(file_hash "$home_dir/.claude/settings.json")"
  [ "$status" -eq 1 ] || fail "invalid JSON install exit code was $status, expected 1"
  [ "$before" = "$after" ] || fail "invalid existing Claude JSON was changed"
  require_fixed "hook merge conflict" "$output"
  require_fixed "Claude: conflict" "$output"

  echo "passed: FX-INS-080 invalid-existing-json"
}

check_semantic_hook_dedup() {
  local fixture="$FIXTURE_ROOT/FX-INS-050-existing-claude-settings"
  local clone home_dir output

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo semantic-hook-dedup)"
  home_dir="$TEMP_ROOT/semantic-hook-dedup/home"
  mkdir -p "$home_dir/.claude" "$home_dir/.codex"

  node -e '
    const fs = require("fs");
    const claude = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const codex = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const claudePrompt = claude.hooks.UserPromptSubmit[0].hooks[0];
    claudePrompt.command = `REPO="$(dirname "$(dirname "$(readlink -f ~/.claude/settings.json)")")"; node "$REPO/scripts/prompt-routing-hook.mjs" --format claude-json || true`;
    claude.hooks.UserPromptSubmit[0].hooks.push({ type: "command", command: "echo oh-my-ai is only a user hook" });
    claude.hooks.PostToolUse.find((group) => group.matcher === "Skill").matcher = " ^Skill$ ";
    claude.hooks.SessionStart[0].hooks[0].command = claude.hooks.SessionStart[0].hooks[0].command.replace(/\s+/g, "   ").replace(/"\$HOME\/\.local\/bin\/oh-my-ai"/g, "$HOME/.local/bin/oh-my-ai") + "   ";
    codex.hooks.UserPromptSubmit[0].hooks[0].command = codex.hooks.UserPromptSubmit[0].hooks[0].command.replace(/; then/g, ";    then").replace(/"\$HOME\/\.local\/bin\/oh-my-ai"/g, "$HOME/.local/bin/oh-my-ai") + " ";
    fs.writeFileSync(process.argv[3], `${JSON.stringify(claude, null, 2)}\n`);
    fs.writeFileSync(process.argv[4], `${JSON.stringify(codex, null, 2)}\n`);
  ' "$clone/claude/settings.json" "$clone/codex/hooks.json" "$home_dir/.claude/settings.json" "$home_dir/.codex/hooks.json"

  output="$(run_setup "$clone" "$home_dir" --install-shared)"
  require_fixed "Claude managed hooks: updated" "$output"
  require_fixed "Codex managed hooks: updated" "$output"
  require_fixed "echo oh-my-ai is only a user hook" "$(cat "$home_dir/.claude/settings.json")"
  assert_managed_hooks_once claude "$home_dir/.claude/settings.json"
  assert_managed_hooks_once codex "$home_dir/.codex/hooks.json"
  [ "$(node "$clone/scripts/merge-runtime-hooks.mjs" --mode check --runtime claude --source "$clone/claude/settings.json" --target "$home_dir/.claude/settings.json")" = "ready" ] \
    || fail "Claude semantic variants were not canonicalised"
  [ "$(node "$clone/scripts/merge-runtime-hooks.mjs" --mode check --runtime codex --source "$clone/codex/hooks.json" --target "$home_dir/.codex/hooks.json")" = "ready" ] \
    || fail "Codex semantic variants were not canonicalised"

  echo "passed: semantic hook dedup variants"
}

check_legacy_customization_preservation() {
  local fixture="$FIXTURE_ROOT/FX-INS-050-existing-claude-settings"
  local clone canonical_home home_dir output status before after scenario

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo legacy-customization-preservation)"

  # The historic official command is accepted and canonicalised to one current
  # operation. The assertion below is independent of merge-runtime-hooks.mjs.
  canonical_home="$TEMP_ROOT/legacy-canonical/home"
  mkdir -p "$canonical_home/.claude"
  node -e '
    const fs = require("fs");
    const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    settings.hooks.UserPromptSubmit[0].hooks[0].command = `REPO="$(dirname "$(dirname "$(readlink -f ~/.claude/settings.json)")")"; node "$REPO/scripts/prompt-routing-hook.mjs" --format=claude-json || true`;
    fs.writeFileSync(process.argv[2], `${JSON.stringify(settings, null, 2)}\n`);
  ' "$clone/claude/settings.json" "$canonical_home/.claude/settings.json"
  run_setup "$clone" "$canonical_home" --install-shared >/dev/null
  assert_managed_hooks_once claude "$canonical_home/.claude/settings.json"
  [ "$(node "$clone/scripts/merge-runtime-hooks.mjs" --mode check --runtime claude --source "$clone/claude/settings.json" --target "$canonical_home/.claude/settings.json")" = "ready" ] \
    || fail "official legacy Hook was not canonicalised"

  for scenario in prefix suffix and fallback extra-env; do
    home_dir="$TEMP_ROOT/legacy-custom-$scenario/home"
    mkdir -p "$home_dir/.claude"
    node -e '
      const fs = require("fs");
      const scenario = process.argv[3];
      const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const legacy = `REPO="$(dirname "$(dirname "$(readlink -f ~/.claude/settings.json)")")"; node "$REPO/scripts/prompt-routing-hook.mjs" --format=claude-json`;
      const commands = {
        prefix: `echo USER_BEFORE; ${legacy}`,
        suffix: `${legacy}; echo USER_AFTER`,
        and: `${legacy} && custom-command`,
        fallback: `${legacy} || fallback-command`,
        "extra-env": `CUSTOM=value ${legacy}`,
      };
      settings.hooks.UserPromptSubmit[0].hooks[0].command = commands[scenario];
      fs.writeFileSync(process.argv[2], `${JSON.stringify(settings, null, 2)}\n`);
    ' "$clone/claude/settings.json" "$home_dir/.claude/settings.json" "$scenario"
    before="$(file_hash "$home_dir/.claude/settings.json")"
    set +e
    output="$(run_setup "$clone" "$home_dir" --install-shared 2>&1)"
    status=$?
    set -e
    after="$(file_hash "$home_dir/.claude/settings.json")"
    [ "$status" -eq 1 ] || fail "legacy $scenario install exit code was $status, expected 1"
    [ "$before" = "$after" ] || fail "legacy $scenario customization was changed"
    require_fixed "Claude: conflict" "$output"
    [ "$(doctor_strict_status "$clone" "$home_dir")" = "1" ] || fail "legacy $scenario conflict did not fail strict doctor"
  done

  # A plain text reference is not a legacy operation and stays alongside the
  # newly added managed Hook instead of creating a false conflict.
  home_dir="$TEMP_ROOT/legacy-incidental/home"
  mkdir -p "$home_dir/.claude"
  node -e '
    const fs = require("fs");
    const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    settings.hooks.UserPromptSubmit[0].hooks[0].command = "echo scripts/prompt-routing-hook.mjs is a user note";
    fs.writeFileSync(process.argv[2], `${JSON.stringify(settings, null, 2)}\n`);
  ' "$clone/claude/settings.json" "$home_dir/.claude/settings.json"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  require_fixed "echo scripts/prompt-routing-hook.mjs is a user note" "$(cat "$home_dir/.claude/settings.json")"
  assert_managed_hooks_once claude "$home_dir/.claude/settings.json"

  echo "passed: legacy customization preservation"
}

check_disabled_runtime_states() {
  local fixture="$FIXTURE_ROOT/FX-INS-090-runtime-strict-readiness"
  local clone home_dir output status claude_before codex_before

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo disabled-runtime-states)"
  home_dir="$TEMP_ROOT/disabled-runtime-states/home"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null

  node -e 'const fs = require("fs"); const p = process.argv[1]; const settings = JSON.parse(fs.readFileSync(p, "utf8")); settings.disableAllHooks = true; fs.writeFileSync(p, `${JSON.stringify(settings, null, 2)}\n`);' "$home_dir/.claude/settings.json"
  claude_before="$(file_hash "$home_dir/.claude/settings.json")"
  set +e
  output="$(run_setup "$clone" "$home_dir" --install-shared 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "disabled Claude install exit code was $status, expected 1"
  require_fixed "Claude: incomplete" "$output"
  require_fixed "disableAllHooks=true" "$output"
  [ "$claude_before" = "$(file_hash "$home_dir/.claude/settings.json")" ] || fail "disabled Claude settings were changed"
  claude_before="$(file_hash "$home_dir/.claude/settings.json")"
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "1" ] || fail "strict doctor accepted disabled Claude hooks"
  [ "$claude_before" = "$(file_hash "$home_dir/.claude/settings.json")" ] || fail "doctor changed disabled Claude settings"

  node -e 'const fs = require("fs"); const p = process.argv[1]; const settings = JSON.parse(fs.readFileSync(p, "utf8")); settings.disableAllHooks = false; fs.writeFileSync(p, `${JSON.stringify(settings, null, 2)}\n`);' "$home_dir/.claude/settings.json"
  printf '%s\n' '[features]' 'hooks = false' >"$home_dir/.codex/config.toml"
  codex_before="$(file_hash "$home_dir/.codex/config.toml")"
  set +e
  output="$(run_setup "$clone" "$home_dir" --install-shared 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "disabled Codex install exit code was $status, expected 1"
  require_fixed "Codex: incomplete" "$output"
  require_fixed "[features] hooks = false" "$output"
  [ "$codex_before" = "$(file_hash "$home_dir/.codex/config.toml")" ] || fail "disabled Codex config was changed"
  codex_before="$(file_hash "$home_dir/.codex/config.toml")"
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "1" ] || fail "strict doctor accepted disabled Codex hooks"
  [ "$codex_before" = "$(file_hash "$home_dir/.codex/config.toml")" ] || fail "doctor changed disabled Codex config"

  node -e 'const fs = require("fs"); const p = process.argv[1]; const settings = JSON.parse(fs.readFileSync(p, "utf8")); settings.disableAllHooks = true; fs.writeFileSync(p, `${JSON.stringify(settings, null, 2)}\n`);' "$home_dir/.claude/settings.json"
  set +e
  output="$(run_setup "$clone" "$home_dir" --install-shared 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "both disabled Runtime install exit code was $status, expected 1"
  require_fixed "Claude: incomplete" "$output"
  require_fixed "Codex: incomplete" "$output"

  node -e 'const fs = require("fs"); const p = process.argv[1]; const settings = JSON.parse(fs.readFileSync(p, "utf8")); settings.disableAllHooks = false; fs.writeFileSync(p, `${JSON.stringify(settings, null, 2)}\n`);' "$home_dir/.claude/settings.json"
  printf '%s\n' '[features]' 'hooks = true' >"$home_dir/.codex/config.toml"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "0" ] || fail "strict doctor rejected enabled Runtime hooks"

  echo "passed: disabled Claude and Codex runtime states"
}

check_core_requirement_matrix() {
  local fixture="$FIXTURE_ROOT/FX-INS-090-runtime-strict-readiness"
  local scenario clone home_dir output

  check_fixture_metadata "$fixture"
  for scenario in missing-cli missing-harness missing-claude-hook missing-codex-hook missing-claude-skill missing-codex-skill; do
    clone="$(clone_fixture_repo "$scenario")"
    home_dir="$TEMP_ROOT/$scenario/home"
    run_setup "$clone" "$home_dir" --install-shared >/dev/null
    case "$scenario" in
      missing-cli) rm -f -- "$home_dir/.local/bin/oh-my-ai" ;;
      missing-harness) rm -f -- "$home_dir/.local/bin/harness-event" ;;
      missing-claude-hook) node -e 'require("fs").writeFileSync(process.argv[1], "{\"hooks\":{}}\n")' "$home_dir/.claude/settings.json" ;;
      missing-codex-hook) node -e 'require("fs").writeFileSync(process.argv[1], "{\"hooks\":{}}\n")' "$home_dir/.codex/hooks.json" ;;
      missing-claude-skill) rm -f -- "$home_dir/.claude/skills/work-start" ;;
      missing-codex-skill) rm -f -- "$home_dir/.agents/skills/work-start" ;;
    esac
    [ "$(doctor_strict_status "$clone" "$home_dir")" = "1" ] || fail "$scenario did not fail strict doctor"
    output="$(run_setup "$clone" "$home_dir" --doctor)"
    case "$scenario" in
      missing-cli) require_fixed "Claude: incomplete" "$output"; require_fixed "Codex: incomplete" "$output" ;;
      missing-harness|missing-claude-hook|missing-claude-skill) require_fixed "Claude: incomplete" "$output"; require_fixed "Codex: configured" "$output" ;;
      missing-codex-hook|missing-codex-skill) require_fixed "Claude: configured" "$output"; require_fixed "Codex: incomplete" "$output" ;;
    esac
  done

  echo "passed: CLI, entrypoint, Hook, and work-start strict matrix"
}

break_runtime_contract() {
  local skill="$1"
  local runtime="$2"
  local comment_only="$3"
  node -e '
    const fs = require("fs");
    const [skill, runtime, commentOnly] = process.argv.slice(1);
    const heading = runtime === "claude" ? "## Claude Code Runtime Entry" : "## Codex Runtime Entry";
    const content = fs.readFileSync(skill, "utf8");
    const start = content.indexOf(`${heading}\n`);
    const end = content.indexOf("\n## ", start + heading.length + 1);
    if (start < 0) process.exit(2);
    const sectionEnd = end < 0 ? content.length : end;
    let section = content.slice(start, sectionEnd)
      .replaceAll("public_entry = \"$HOME/.local/bin/oh-my-ai\" work-start -- \"<single task argument>\"", "public_entry = scripts/work-start.sh")
      .replaceAll("\"$HOME/.local/bin/oh-my-ai\" work-start -- \"<single task argument>\"", "scripts/work-start.sh");
    if (commentOnly === "comment-only") {
      section += "\n<!-- example only: \\\"$HOME/.local/bin/oh-my-ai\\\" work-start -- \\\"<single task argument>\\\" -->\n";
    }
    fs.writeFileSync(skill, content.slice(0, start) + section + content.slice(sectionEnd));
  ' "$skill" "$runtime" "$comment_only"
}

check_work_start_runtime_contracts() {
  local fixture="$FIXTURE_ROOT/FX-INS-100-work-start-runtime-contract"
  local scenario clone home_dir output expected_runtime other_runtime

  check_fixture_metadata "$fixture"
  for scenario in claude-relative-path codex-relative-path claude-comment-only codex-comment-only; do
    clone="$(clone_fixture_repo "work-start-contract-$scenario")"
    home_dir="$TEMP_ROOT/work-start-contract-$scenario/home"
    run_setup "$clone" "$home_dir" --install-shared >/dev/null
    [ "$(doctor_strict_status "$clone" "$home_dir")" = "0" ] || fail "$scenario baseline was not strict-ready"
    case "$scenario" in
      claude-*) expected_runtime="claude"; other_runtime="Codex" ;;
      codex-*) expected_runtime="codex"; other_runtime="Claude" ;;
    esac
    case "$scenario" in
      *comment-only) break_runtime_contract "$clone/skills/work-start/SKILL.md" "$expected_runtime" comment-only ;;
      *) break_runtime_contract "$clone/skills/work-start/SKILL.md" "$expected_runtime" relative-path ;;
    esac
    [ "$(doctor_strict_status "$clone" "$home_dir")" = "1" ] || fail "$scenario did not fail doctor-strict"
    output="$(run_setup "$clone" "$home_dir" --doctor)"
    if [ "$expected_runtime" = "claude" ]; then
      require_fixed "Claude: incomplete" "$output"
      require_fixed "Codex: configured" "$output"
    else
      require_fixed "Claude: configured" "$output"
      require_fixed "Codex: incomplete" "$output"
    fi
  done

  echo "passed: FX-INS-100 runtime-specific Work-start Skill contracts"
}

check_runtime_strict_readiness() {
  local fixture="$FIXTURE_ROOT/FX-INS-090-runtime-strict-readiness"
  local clone home_dir output status

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo runtime-strict-readiness)"
  home_dir="$TEMP_ROOT/runtime-strict-readiness/home"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "0" ] || fail "strict doctor did not accept a complete install"

  rm -f -- "$home_dir/.agents/skills/work-start"
  set +e
  output="$(run_setup "$clone" "$home_dir" --doctor --strict 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "strict doctor exit code was $status, expected 1 for missing Codex work-start"
  require_fixed "Codex: incomplete" "$output"

  echo "passed: FX-INS-090 runtime-strict-readiness"
}

check_installed_work_start_e2e() {
  local clone home_dir target output task fixture invocation_log status

  fixture="$FIXTURE_ROOT/FX-WS-E2E-001-claude-installed-explicit-invocation"
  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo work-start-e2e-claude)"
  home_dir="$TEMP_ROOT/work-start-e2e-claude/home"
  target="$TEMP_ROOT/work-start-e2e-claude/target repository"
  make_target_repo "$target"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  assert_link "$home_dir/.claude/skills/work-start" "$clone/skills/work-start"
  node "$clone/scripts/check-work-start-runtime-contract.mjs" --runtime claude --skill "$home_dir/.claude/skills/work-start/SKILL.md" \
    || fail "installed Claude Skill does not reference the public Work-start entry"
  task='quoted task: preserve "spaces" $ dollar ; semicolon * star 한글 work-start'
  invocation_log="$TEMP_ROOT/work-start-e2e-claude/engine-invocations.log"
  output="$(run_installed_work_start "$target" "$home_dir/.local/bin/oh-my-ai" "$task" "$invocation_log" claude claude-installed-e2e)"
  assert_work_start_artifact "$target" "$clone" "$output" "$invocation_log"
  grep -r -q -F -- "$task" "$target/.oh-my-ai/work-start" || fail "Claude public entry changed the single task argument"
  output="$(run_installed_prompt_hook "$target" "$home_dir/.local/bin/oh-my-ai" claude "$task" claude-installed-e2e)"
  assert_post_execution_hook_suppressed "$output" "Claude"
  [ "$(engine_invocation_count "$invocation_log")" = "1" ] || fail "Claude post-execution hook invoked the Engine"
  [ "$(artifact_directory_count "$target/.oh-my-ai/work-start")" = "1" ] || fail "Claude post-execution hook created an artifact"
  echo "passed: FX-WS-E2E-001 Claude installed explicit invocation"

  fixture="$FIXTURE_ROOT/FX-WS-E2E-002-codex-installed-explicit-invocation"
  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo work-start-e2e-codex)"
  home_dir="$TEMP_ROOT/work-start-e2e-codex/home"
  target="$TEMP_ROOT/work-start-e2e-codex/target repository"
  make_target_repo "$target"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  assert_link "$home_dir/.agents/skills/work-start" "$clone/skills/work-start"
  node "$clone/scripts/check-work-start-runtime-contract.mjs" --runtime codex --skill "$home_dir/.agents/skills/work-start/SKILL.md" \
    || fail "installed Codex Skill does not reference the public Work-start entry"
  task='$work-start quoted task: preserve "spaces" $ dollar ; semicolon * star 한글 work-start'
  invocation_log="$TEMP_ROOT/work-start-e2e-codex/engine-invocations.log"
  # Strip an ambient Claude session (this fixture may itself run inside
  # Claude Code) so it cannot outrank the Codex runtime this call simulates.
  output="$(cd "$target" && unset CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION && HOME="$home_dir" OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" OH_MY_AI_WORK_START_SESSION_ID=codex-installed-e2e "$clone/scripts/codex-work-start-entry.sh" "$task")"
  assert_work_start_artifact "$target" "$clone" "$output" "$invocation_log"
  if printf '%s\n' "$output" | grep -q -F -- '$work-start quoted'; then
    fail "Codex entry leaked the explicit invocation token into its artifact"
  fi
  grep -r -q -F -- 'quoted task: preserve "spaces" $ dollar ; semicolon * star 한글 work-start' "$target/.oh-my-ai/work-start" \
    || fail "Codex entry changed the task body after removing its explicit token"
  output="$(run_installed_prompt_hook "$target" "$home_dir/.local/bin/oh-my-ai" codex 'quoted task: preserve "spaces" $ dollar ; semicolon * star 한글 work-start' codex-installed-e2e)"
  assert_post_execution_hook_suppressed "$output" "Codex"
  [ "$(engine_invocation_count "$invocation_log")" = "1" ] || fail "Codex post-execution hook invoked the Engine"
  [ "$(artifact_directory_count "$target/.oh-my-ai/work-start")" = "1" ] || fail "Codex post-execution hook created an artifact"

  set +e
  (cd "$target" && HOME="$home_dir" OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" "$clone/scripts/codex-work-start-entry.sh" '$work-start first' second) >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -eq 2 ] || fail "Codex entry accepted multiple task argv"
  [ "$(engine_invocation_count "$invocation_log")" = "1" ] || fail "Codex multi-argv rejection invoked the Engine"
  echo "passed: FX-WS-E2E-002 Codex installed explicit invocation"
}

check_installed_external_repository_notice_e2e() {
  local clone home_dir target cache_dir config_dir manifest output first_artifact second_artifact
  local cache_file lock_file waited_ms=0

  clone="$(clone_fixture_repo work-start-external-repository-notice)"
  home_dir="$TEMP_ROOT/work-start-external-repository-notice/home"
  target="$TEMP_ROOT/work-start-external-repository-notice/user-project"
  cache_dir="$TEMP_ROOT/work-start-external-repository-notice/xdg-cache"
  config_dir="$TEMP_ROOT/work-start-external-repository-notice/xdg-config"
  manifest="$TEMP_ROOT/work-start-external-repository-notice/manifest.json"
  cache_file="$cache_dir/oh-my-ai/notice-manifest.json"
  lock_file="$cache_dir/oh-my-ai/notice-refresh.lock"

  make_target_repo "$target"
  mkdir -p "$cache_dir" "$config_dir"
  cat >"$manifest" <<'JSON'
{
  "schema_version": 1,
  "notices": [
    {
      "notice_id": "fx-external-repository-v1-1-0",
      "message": "fixture: v1.1.0 update available.",
      "action_url": "https://github.com/aixion1506/oh-my-ai/releases/tag/v1.1.0",
      "min_version": "1.0.0",
      "max_version": "1.1.0"
    }
  ]
}
JSON

  run_setup "$clone" "$home_dir" --install-shared >/dev/null

  output="$(
    cd "$target"
    HOME="$home_dir" XDG_CACHE_HOME="$cache_dir" XDG_CONFIG_HOME="$config_dir" \
      NOTICE_MANIFEST_URL="file://$manifest" \
      "$home_dir/.local/bin/oh-my-ai" work-start -- "first notice run"
  )"
  printf '%s\n' "$output" | grep -q -F -- "oh-my-ai notice:" \
    && fail "external repository first Work-start displayed a newly refreshed Notice"
  first_artifact="$(printf '%s\n' "$output" | sed -n 's/^work-start artifact created: //p' | tail -1)"
  [ -n "$first_artifact" ] || fail "external repository first Work-start did not report an artifact"
  [ -f "$target/$first_artifact/handoff-candidate.md" ] \
    || fail "external repository first Candidate was not created under the user project"
  [ ! -e "$clone/.oh-my-ai/work-start" ] \
    || fail "external repository first Candidate leaked into the Engine source"

  while [ ! -s "$cache_file" ] && [ "$waited_ms" -lt 3000 ]; do
    sleep 0.02
    waited_ms=$((waited_ms + 20))
  done
  [ -s "$cache_file" ] || fail "external repository first Work-start did not refresh the Notice cache"
  while [ -e "$lock_file" ] && [ "$waited_ms" -lt 6000 ]; do
    sleep 0.02
    waited_ms=$((waited_ms + 20))
  done
  [ ! -e "$lock_file" ] || fail "external repository Notice refresh lock did not clear"

  output="$(
    cd "$target"
    HOME="$home_dir" XDG_CACHE_HOME="$cache_dir" XDG_CONFIG_HOME="$config_dir" \
      NOTICE_MANIFEST_URL="file://$manifest" \
      "$home_dir/.local/bin/oh-my-ai" work-start -- "second notice run"
  )"
  printf '%s\n' "$output" | grep -q -F -- "oh-my-ai notice:" \
    || fail "external repository second Work-start did not display the cached Notice"
  printf '%s\n' "$output" | grep -q -F -- "fixture: v1.1.0 update available." \
    || fail "external repository second Work-start omitted the Notice message"
  printf '%s\n' "$output" | grep -q -F -- "https://github.com/aixion1506/oh-my-ai/releases/tag/v1.1.0" \
    || fail "external repository second Work-start omitted the Notice action URL"
  [ "$(printf '%s\n' "$output" | tail -4 | sed -n '1p')" = "oh-my-ai notice:" ] \
    || fail "external repository Notice was not emitted at the Work-start output tail"

  second_artifact="$(printf '%s\n' "$output" | sed -n 's/^work-start artifact created: //p' | tail -1)"
  [ -f "$target/$second_artifact/handoff-candidate.md" ] \
    || fail "external repository second Candidate was not created under the user project"
  if grep -r -q -F -- "fixture: v1.1.0 update available." \
    "$target/$first_artifact" "$target/$second_artifact"; then
    fail "external repository Notice text leaked into a Candidate Artifact"
  fi
  [ ! -e "$target/VERSION" ] || fail "fixture unexpectedly placed VERSION in the user project"
  [ ! -e "$target/scripts/notice.mjs" ] || fail "fixture unexpectedly placed notice.mjs in the user project"

  echo "passed: FX-WS-E2E-008 external repository installed Product Notice"
}

check_work_start_post_execution_boundary() {
  local fixture="$FIXTURE_ROOT/FX-WS-E2E-007-post-execution-human-review"
  local clone home_dir target_a target_b target_symlink invocation_log task other_task output continuation_output other_repo_output expired_task expired_output session_a session_b session_codex engine_only_task no_session_task external_state

  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo work-start-post-execution-boundary)"
  home_dir="$TEMP_ROOT/work-start-post-execution-boundary/home"
  target_a="$TEMP_ROOT/work-start-post-execution-boundary/target repository a"
  target_b="$TEMP_ROOT/work-start-post-execution-boundary/target repository b"
  target_symlink="$TEMP_ROOT/work-start-post-execution-boundary/target repository symlink"
  invocation_log="$TEMP_ROOT/work-start-post-execution-boundary/engine-invocations.log"
  task='구현을 시작하기 전에 관련 코드와 영향 범위를 먼저 모아줘. POST-EXECUTION-BOUNDARY'
  other_task='구현을 시작하기 전에 관련 코드와 영향 범위를 먼저 모아줘. OTHER-POST-EXECUTION-TASK'
  session_a='claude-session-a'
  session_b='claude-session-b'
  session_codex='codex-session-a'
  make_target_repo "$target_a"
  make_target_repo "$target_b"
  make_target_repo "$target_symlink"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null

  # Two Sessions can invoke an identical Task. An Engine without a verifiable
  # Session must not infer either Session from invocation order.
  output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" claude "/work-start $task" "$session_a")"
  assert_post_execution_hook_suppressed "$output" "Claude explicit payload"
  output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" claude "/work-start $task" "$session_b")"
  assert_post_execution_hook_suppressed "$output" "Claude second explicit payload"

  output="$(run_installed_work_start "$target_a" "$home_dir/.local/bin/oh-my-ai" "$task" "$invocation_log")"
  assert_work_start_artifact "$target_a" "$clone" "$output" "$invocation_log"
  [ ! -e "$target_a/.oh-my-ai/state/work-start-execution-state.json" ] \
    || fail "missing Engine Session created an execution marker"
  output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" claude "$task" "$session_a")"
  assert_post_execution_hook_not_suppressed "$output" "Claude Session A without Engine Session"
  rm -f -- "$target_a/.oh-my-ai/state/work-start-suggestions.json"
  output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" claude "$task" "$session_b")"
  assert_post_execution_hook_not_suppressed "$output" "Claude Session B without Engine Session"
  rm -f -- "$target_a/.oh-my-ai/state/work-start-suggestions.json"

  output="$(run_installed_work_start "$target_a" "$home_dir/.local/bin/oh-my-ai" "$task" "$invocation_log" claude "$session_a")"
  [ "$(engine_invocation_count "$invocation_log")" = "2" ] || fail "Claude exact-session Engine did not run"
  [ "$(artifact_directory_count "$target_a/.oh-my-ai/work-start")" = "2" ] || fail "Claude exact-session Engine did not create one artifact"
  output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" claude "$task" "$session_a")"
  assert_post_execution_hook_suppressed "$output" "Claude transformed exact-session payload"
  output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" codex "$task" "$session_a")"
  assert_post_execution_hook_not_suppressed "$output" "Codex different Runtime"
  rm -f -- "$target_a/.oh-my-ai/state/work-start-suggestions.json"
  output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" claude "$task" "$session_b")"
  assert_post_execution_hook_not_suppressed "$output" "Claude different Session"
  rm -f -- "$target_a/.oh-my-ai/state/work-start-suggestions.json"

  output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" claude "$other_task" "$session_a")"
  assert_post_execution_hook_not_suppressed "$output" "Claude different Task"
  rm -f -- "$target_a/.oh-my-ai/state/work-start-suggestions.json"

  continuation_output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" claude 'Gather Context로 진행해줘.' "$session_a")"
  if printf '%s\n' "$continuation_output" | grep -q -F -- 'Suggested by oh-my-ai: Work-start'; then
    fail "explicit continuation prompt was re-routed to Work-start"
  fi
  [ "$(engine_invocation_count "$invocation_log")" = "2" ] || fail "continuation prompt invoked the Engine"
  [ "$(artifact_directory_count "$target_a/.oh-my-ai/work-start")" = "2" ] || fail "continuation prompt created an artifact"

  other_repo_output="$(run_installed_prompt_hook "$target_b" "$home_dir/.local/bin/oh-my-ai" claude "$task" "$session_a")"
  assert_post_execution_hook_not_suppressed "$other_repo_output" "Claude different Repository"

  engine_only_task='구현을 시작하기 전에 관련 코드와 영향 범위를 먼저 모아줘. ENGINE-ONLY-SESSION'
  output="$(run_installed_work_start "$target_b" "$home_dir/.local/bin/oh-my-ai" "$engine_only_task" "$invocation_log" claude "$session_a")"
  output="$(run_installed_prompt_hook "$target_b" "$home_dir/.local/bin/oh-my-ai" claude "$engine_only_task" __missing__)"
  assert_post_execution_hook_not_suppressed "$output" "Claude missing Hook Session"
  rm -f -- "$target_b/.oh-my-ai/state/work-start-suggestions.json"

  no_session_task='구현을 시작하기 전에 관련 코드와 영향 범위를 먼저 모아줘. NO-SESSION'
  output="$(run_installed_work_start "$target_b" "$home_dir/.local/bin/oh-my-ai" "$no_session_task" "$invocation_log")"
  output="$(run_installed_prompt_hook "$target_b" "$home_dir/.local/bin/oh-my-ai" claude "$no_session_task" __missing__)"
  assert_post_execution_hook_not_suppressed "$output" "Claude missing Hook and Engine Session"
  rm -f -- "$target_b/.oh-my-ai/state/work-start-suggestions.json"

  expired_task='구현을 시작하기 전에 관련 코드와 영향 범위를 먼저 모아줘. EXPIRED-POST-EXECUTION-BOUNDARY'
  node - "$target_b" "$expired_task" <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const [target, task] = process.argv.slice(2);
const normalized = task.replace(/\s+/g, " ").trim();
const statePath = path.join(target, ".oh-my-ai", "state", "work-start-execution-state.json");
fs.writeFileSync(statePath, `${JSON.stringify({
  version: 3,
  executions: [{
    runtime: "claude",
    task_hash: crypto.createHash("sha256").update(normalized).digest("hex"),
    session_hash: crypto.createHash("sha256").update("claude-session-a").digest("hex"),
    executed_at: "2000-01-01T00:00:00.000Z",
  }],
})}\n`);
NODE
  expired_output="$(run_installed_prompt_hook "$target_b" "$home_dir/.local/bin/oh-my-ai" claude "$expired_task" "$session_a")"
  assert_post_execution_hook_not_suppressed "$expired_output" "Claude expired marker"
  rm -f -- "$target_b/.oh-my-ai/state/work-start-suggestions.json"

  printf '%s\n' '{ malformed state' >"$target_b/.oh-my-ai/state/work-start-execution-state.json"
  output="$(run_installed_prompt_hook "$target_b" "$home_dir/.local/bin/oh-my-ai" claude "$other_task" "$session_a")"
  assert_post_execution_hook_not_suppressed "$output" "Claude malformed state"
  rm -f -- "$target_b/.oh-my-ai/state/work-start-suggestions.json"
  output="$(run_installed_work_start "$target_b" "$home_dir/.local/bin/oh-my-ai" "$other_task" "$invocation_log" claude "$session_a")"
  [ -s "$target_b/.oh-my-ai/state/work-start-execution-state.json" ] || fail "Engine did not recover malformed execution state"

  output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" codex "\$work-start $task" "$session_codex")"
  assert_post_execution_hook_suppressed "$output" "Codex explicit payload"
  # Strip an ambient Claude session (this fixture may itself run inside
  # Claude Code) so it cannot outrank the Codex runtime this call simulates.
  output="$(cd "$target_a" && unset CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION && HOME="$home_dir" OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" OH_MY_AI_WORK_START_SESSION_ID="$session_codex" "$clone/scripts/codex-work-start-entry.sh" "\$work-start $task")"
  [ "$(engine_invocation_count "$invocation_log")" = "6" ] || fail "new explicit Codex invocation was permanently suppressed"
  [ "$(artifact_directory_count "$target_a/.oh-my-ai/work-start")" = "3" ] || fail "new explicit Codex invocation did not create its own artifact"
  output="$(run_installed_prompt_hook "$target_a" "$home_dir/.local/bin/oh-my-ai" codex "$task" "$session_codex")"
  assert_post_execution_hook_suppressed "$output" "Codex transformed explicit payload"

  external_state="$TEMP_ROOT/work-start-post-execution-boundary/external state"
  mkdir -p "$target_symlink/.oh-my-ai" "$external_state"
  ln -s "$external_state" "$target_symlink/.oh-my-ai/state"
  output="$(run_installed_work_start "$target_symlink" "$home_dir/.local/bin/oh-my-ai" "$task" "$invocation_log" claude "$session_a")"
  [ ! -e "$external_state/work-start-execution-state.json" ] || fail "execution state followed a repository state symlink"
  output="$(run_installed_prompt_hook "$target_symlink" "$home_dir/.local/bin/oh-my-ai" claude "$task" "$session_a")"
  assert_post_execution_hook_not_suppressed "$output" "Claude state symlink"

  echo "passed: FX-WS-E2E-007 post-execution Human Review boundary"
}

check_work_start_public_entry_parser() {
  local clone home_dir target invocation_log task output status

  clone="$(clone_fixture_repo work-start-public-entry-parser)"
  home_dir="$TEMP_ROOT/work-start-public-entry-parser/home"
  target="$TEMP_ROOT/work-start-public-entry-parser/target repository"
  invocation_log="$TEMP_ROOT/work-start-public-entry-parser/engine-invocations.log"
  make_target_repo "$target"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null

  for case_name in missing-separator unknown-option empty-task multiple-task-arguments; do
    set +e
    case "$case_name" in
      missing-separator) (cd "$target" && OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" "$home_dir/.local/bin/oh-my-ai" work-start task) >/dev/null 2>&1 ;;
      unknown-option) (cd "$target" && OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" "$home_dir/.local/bin/oh-my-ai" work-start --bogus) >/dev/null 2>&1 ;;
      empty-task) (cd "$target" && OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" "$home_dir/.local/bin/oh-my-ai" work-start -- "") >/dev/null 2>&1 ;;
      multiple-task-arguments) (cd "$target" && OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" "$home_dir/.local/bin/oh-my-ai" work-start -- first second) >/dev/null 2>&1 ;;
    esac
    status=$?
    set -e
    [ "$status" -eq 2 ] || fail "public entry $case_name exit was $status, expected 2"
    [ "$(artifact_directory_count "$target/.oh-my-ai/work-start")" = "0" ] || fail "public entry $case_name created an artifact"
    [ "$(engine_invocation_count "$invocation_log")" = "0" ] || fail "public entry $case_name invoked the Engine"
  done

  task='single task: preserve "quotes" $ dollar ; semicolon * star 한글 work-start'
  output="$(run_installed_work_start "$target" "$home_dir/.local/bin/oh-my-ai" "$task" "$invocation_log")"
  assert_work_start_artifact "$target" "$clone" "$output" "$invocation_log"
  grep -r -q -F -- "$task" "$target/.oh-my-ai/work-start" || fail "public entry did not preserve the exact single task argument"
  echo "passed: Work-start public entry parser and argv preservation"
}

check_work_start_engine_failure_modes() {
  local clone home_dir fixture output status

  fixture="$FIXTURE_ROOT/FX-WS-E2E-003-missing-public-engine-entry"
  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo work-start-missing-entry)"
  home_dir="$TEMP_ROOT/work-start-missing-entry/home"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  rm -f -- "$home_dir/.local/bin/oh-my-ai"
  set +e
  output="$(run_setup "$clone" "$home_dir" --doctor --strict 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "missing public engine entry did not fail doctor-strict"
  require_fixed "Claude: incomplete" "$output"
  require_fixed "Codex: incomplete" "$output"
  echo "passed: FX-WS-E2E-003 missing public engine entry"

  fixture="$FIXTURE_ROOT/FX-WS-E2E-004-missing-common-engine"
  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo work-start-missing-engine)"
  home_dir="$TEMP_ROOT/work-start-missing-engine/home"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  rm -f -- "$clone/scripts/work-start.sh"
  set +e
  output="$(run_setup "$clone" "$home_dir" --install-shared 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "missing common Engine did not fail install-shared"
  require_fixed "Claude: incomplete" "$output"
  require_fixed "Codex: incomplete" "$output"
  [ "$(doctor_strict_status "$clone" "$home_dir")" = "1" ] || fail "missing common Engine did not fail doctor-strict"
  echo "passed: FX-WS-E2E-004 missing common engine"
}

check_work_start_source_relocation() {
  local fixture clone relocated home_dir target output before status invocation_log

  fixture="$FIXTURE_ROOT/FX-WS-E2E-005-source-relocation-reinstall"
  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo work-start-source-relocation)"
  relocated="$TEMP_ROOT/work-start-source-relocation/relocated source"
  home_dir="$TEMP_ROOT/work-start-source-relocation/home"
  target="$TEMP_ROOT/work-start-source-relocation/target repository"
  make_target_repo "$target"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  mv "$clone" "$relocated"
  set +e
  before="$(run_setup "$relocated" "$home_dir" --doctor --strict 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "relocated source did not leave stale managed entry incomplete"
  require_fixed "Claude: incomplete" "$before"
  run_setup "$relocated" "$home_dir" --install-shared >/dev/null
  assert_link "$home_dir/.local/bin/oh-my-ai" "$relocated/scripts/oh-my-ai.mjs"
  [ "$(doctor_strict_status "$relocated" "$home_dir")" = "0" ] || fail "reinstall did not recover relocated source"
  invocation_log="$TEMP_ROOT/work-start-source-relocation/engine-invocations.log"
  output="$(run_installed_work_start "$target" "$home_dir/.local/bin/oh-my-ai" 'relocation recovery' "$invocation_log")"
  assert_work_start_artifact "$target" "$relocated" "$output" "$invocation_log"
  echo "passed: FX-WS-E2E-005 source relocation/reinstall"
}

check_work_start_consent_boundary() {
  local fixture clone home_dir target before after payload output invocation_log

  fixture="$FIXTURE_ROOT/FX-WS-E2E-006-consent-boundary"
  check_fixture_metadata "$fixture"
  clone="$(clone_fixture_repo work-start-consent-boundary)"
  home_dir="$TEMP_ROOT/work-start-consent-boundary/home"
  target="$TEMP_ROOT/work-start-consent-boundary/target repository"
  make_target_repo "$target"
  run_setup "$clone" "$home_dir" --install-shared >/dev/null
  invocation_log="$TEMP_ROOT/work-start-consent-boundary/engine-invocations.log"
  before="$(artifact_directory_count "$target/.oh-my-ai/work-start")"
  payload='{"prompt":"구현 전에 관련 코드와 영향 범위를 먼저 모아서 정리해줘."}'
  output="$(cd "$target" && printf '%s' "$payload" | OH_MY_AI_WORK_START_INVOCATION_LOG="$invocation_log" "$home_dir/.local/bin/oh-my-ai" hook claude UserPromptSubmit)"
  after="$(artifact_directory_count "$target/.oh-my-ai/work-start")"
  [ "$before" = "$after" ] || fail "natural-language suggestion crossed the Work-start consent boundary"
  [ "$(engine_invocation_count "$invocation_log")" = "0" ] || fail "natural-language suggestion invoked the Engine"
  printf '%s\n' "$output" | grep -q -F -- "Suggested by oh-my-ai: Work-start" \
    || fail "natural-language prompt did not produce a Work-start suggestion"
  echo "passed: FX-WS-E2E-006 consent boundary"
}

require_file "setup.sh"
require_file "Makefile"
for fixture in "$FIXTURE_ROOT"/FX-INS-*; do
  [ -d "$fixture" ] || fail "no install fixtures found"
  check_fixture_metadata "$fixture"
done

run_isolated_check check_fresh_install
run_isolated_check check_reinstall_idempotency
run_isolated_check check_healthy_doctor
run_isolated_check check_broken_install
run_isolated_check check_dangling_link_recovery
run_isolated_check check_existing_claude_settings_merge
run_isolated_check check_existing_skill_directories
run_isolated_check check_work_start_conflict
run_isolated_check check_spec_to_implementation_conflict
run_isolated_check check_invalid_existing_json
run_isolated_check check_semantic_hook_dedup
run_isolated_check check_legacy_customization_preservation
run_isolated_check check_runtime_strict_readiness
run_isolated_check check_disabled_runtime_states
run_isolated_check check_core_requirement_matrix
run_isolated_check check_work_start_runtime_contracts
run_isolated_check check_installed_work_start_e2e
run_isolated_check check_installed_external_repository_notice_e2e
run_isolated_check check_work_start_post_execution_boundary
run_isolated_check check_work_start_public_entry_parser
run_isolated_check check_work_start_engine_failure_modes
run_isolated_check check_work_start_source_relocation
run_isolated_check check_work_start_consent_boundary

echo "all install fixtures passed"
