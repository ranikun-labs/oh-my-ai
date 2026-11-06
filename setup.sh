#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
CODEX_DIR="${CODEX_DIR:-$HOME/.codex}"
AGENT_DIR="${AGENT_DIR:-$HOME/.agents}"
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"
MODE="install-shared"
PROFILE_NAME="${PROFILE:-}"
DRY_RUN=0
STRICT=0
DOCTOR_FAIL_COUNT=0
INSTALL_FAILURE=0

usage() {
  cat <<'EOF'
usage:
  setup.sh --doctor [--strict]
  setup.sh --install-shared [--dry-run]
  setup.sh --init-profile --profile <name> [--dry-run]
  setup.sh --install-profile --profile <name> [--dry-run]

Profile onboarding flow:
  1. make init-profile PROFILE=<name>   — scaffold profiles/local/<name>/ from example
  2. edit profiles/local/<name>/        — fill in <placeholder> values
  3. make install-profile PROFILE=<name> — link executable scripts to ~/.local/bin/
  4. make doctor                         — verify install state

Policy:
  - Existing ~/.claude/skills and ~/.agents/skills are never overwritten.
  - Existing JSON settings are preserved; only recognised oh-my-ai Hook operations are merged.
  - A disabled Runtime is reported as incomplete and is never enabled automatically.
  - Codex hook trust is not readable from the CLI; verify it manually with /hooks.
  - Profiles are opt-in. Use profiles/example for templates and profiles/local/<name> for private local profiles.
  - profiles/local/ is gitignored. Never commit real account values or tokens.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --doctor) MODE="doctor" ;;
    --install-shared) MODE="install-shared" ;;
    --init-profile) MODE="init-profile" ;;
    --install-profile) MODE="install-profile" ;;
    --profile) shift; PROFILE_NAME="${1:-}" ;;
    --dry-run) DRY_RUN=1 ;;
    --strict) STRICT=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN: $*"
  else
    "$@"
  fi
}

same_link() {
  [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]
}

same_managed_path() {
  src="$1"
  dest="$2"
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const fs = require("fs"); process.exit(fs.realpathSync(process.argv[1]) === fs.realpathSync(process.argv[2]) ? 0 : 1)' "$src" "$dest" >/dev/null 2>&1
}

entrypoint_status() {
  src="$1"
  dest="$2"
  if [ ! -f "$src" ] || [ ! -x "$src" ]; then
    printf '%s\n' "incomplete"
  elif same_managed_path "$src" "$dest" && [ -x "$dest" ]; then
    printf '%s\n' "ready"
  elif [ -L "$dest" ] && [ ! -e "$dest" ]; then
    printf '%s\n' "incomplete"
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    printf '%s\n' "conflict"
  else
    printf '%s\n' "incomplete"
  fi
}

managed_skill_status() {
  skill_name="$1"
  dest="$2"
  src="$REPO/skills/$skill_name"
  if [ ! -f "$src/SKILL.md" ]; then
    printf '%s\n' "incomplete"
  elif same_managed_path "$src" "$dest"; then
    printf '%s\n' "ready"
  elif [ -L "$dest" ] && [ ! -e "$dest" ]; then
    printf '%s\n' "incomplete"
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    printf '%s\n' "conflict"
  else
    printf '%s\n' "incomplete"
  fi
}

work_start_engine_status() {
  entry_status="$(entrypoint_status "$REPO/scripts/oh-my-ai.mjs" "$LOCAL_BIN/oh-my-ai")"
  engine="$REPO/scripts/work-start.sh"
  if [ "$entry_status" != "ready" ] || [ ! -f "$engine" ] || [ ! -x "$engine" ]; then
    printf '%s\n' "incomplete"
    return 0
  fi

  # Read-only behavior probe: a managed entry must reject an empty task with
  # the documented parser status before it can resolve or execute the Engine.
  set +e
  "$LOCAL_BIN/oh-my-ai" work-start >/dev/null 2>&1
  entry_probe_status=$?
  set -e
  if [ "$entry_probe_status" -ne 2 ]; then
    printf '%s\n' "incomplete"
  else
    printf '%s\n' "ready"
  fi
}

work_start_runtime_contract_status() {
  runtime="$1"
  skill_dir="$2"
  skill="$skill_dir/SKILL.md"
  if [ ! -f "$skill" ] || ! command -v node >/dev/null 2>&1 \
    || [ ! -f "$REPO/scripts/check-work-start-runtime-contract.mjs" ]; then
    printf '%s\n' "incomplete"
  elif node "$REPO/scripts/check-work-start-runtime-contract.mjs" --runtime "$runtime" --skill "$skill" >/dev/null 2>&1; then
    printf '%s\n' "ready"
  else
    printf '%s\n' "incomplete"
  fi
}

runtime_hook_status() {
  runtime="$1"
  source="$2"
  target="$3"
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$REPO/scripts/merge-runtime-hooks.mjs" ]; then
    printf '%s\n' "incomplete"
    return 0
  fi
  if ! status="$(node "$REPO/scripts/merge-runtime-hooks.mjs" --mode check --runtime "$runtime" --source "$source" --target "$target" 2>/dev/null)"; then
    status="conflict"
  fi
  case "$status" in
    ready|incomplete|conflict) printf '%s\n' "$status" ;;
    *) printf '%s\n' "conflict" ;;
  esac
}

runtime_hooks_enabled_status() {
  runtime="$1"
  target="$2"
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$REPO/scripts/merge-runtime-hooks.mjs" ]; then
    printf '%s\n' "unknown"
    return 0
  fi
  if [ "$runtime" = "codex" ]; then
    config="$CODEX_DIR/config.toml"
  else
    config=""
  fi
  if ! status="$(node "$REPO/scripts/merge-runtime-hooks.mjs" --mode enabled --runtime "$runtime" --target "$target" --config "$config" 2>/dev/null)"; then
    status="unknown"
  fi
  case "$status" in
    enabled|disabled|unknown) printf '%s\n' "$status" ;;
    *) printf '%s\n' "unknown" ;;
  esac
}

combined_status() {
  has_incomplete=0
  for status in "$@"; do
    [ "$status" != "conflict" ] || { printf '%s\n' "conflict"; return 0; }
    [ "$status" != "ready" ] && has_incomplete=1
  done
  [ "$has_incomplete" -eq 0 ] && printf '%s\n' "configured" || printf '%s\n' "incomplete"
}

runtime_status() {
  runtime="$1"
  cli_status="$(entrypoint_status "$REPO/scripts/oh-my-ai.mjs" "$LOCAL_BIN/oh-my-ai")"
  engine_status="$(work_start_engine_status)"
  if [ "$runtime" = "claude" ]; then
    event_status="$(entrypoint_status "$REPO/scripts/harness-event.mjs" "$LOCAL_BIN/harness-event")"
    hook_status="$(runtime_hook_status claude "$REPO/claude/settings.json" "$CLAUDE_DIR/settings.json")"
    activation_status="$(runtime_hooks_enabled_status claude "$CLAUDE_DIR/settings.json")"
    skill_status="$(managed_skill_status work-start "$CLAUDE_DIR/skills/work-start")"
    skill_contract_status="$(work_start_runtime_contract_status claude "$CLAUDE_DIR/skills/work-start")"
    [ "$activation_status" = "enabled" ] && activation_status="ready" || activation_status="incomplete"
    combined_status "$cli_status" "$engine_status" "$event_status" "$hook_status" "$skill_status" "$skill_contract_status" "$activation_status"
  else
    hook_status="$(runtime_hook_status codex "$REPO/codex/hooks.json" "$CODEX_DIR/hooks.json")"
    activation_status="$(runtime_hooks_enabled_status codex "$CODEX_DIR/hooks.json")"
    skill_status="$(managed_skill_status work-start "$AGENT_DIR/skills/work-start")"
    spec_skill_status="$(managed_skill_status spec-to-implementation "$AGENT_DIR/skills/spec-to-implementation")"
    skill_contract_status="$(work_start_runtime_contract_status codex "$AGENT_DIR/skills/work-start")"
    [ "$activation_status" = "enabled" ] && activation_status="ready" || activation_status="incomplete"
    combined_status "$cli_status" "$engine_status" "$hook_status" "$skill_status" "$spec_skill_status" "$skill_contract_status" "$activation_status"
  fi
}

install_runtime_hooks() {
  runtime="$1"
  source="$2"
  target="$3"
  label="$4"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN: node $REPO/scripts/merge-runtime-hooks.mjs --mode merge --runtime $runtime --source $source --target $target"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    say "conflict: $label requires node to safely merge managed hooks"
    INSTALL_FAILURE=1
    return 0
  fi
  if result="$(node "$REPO/scripts/merge-runtime-hooks.mjs" --mode merge --runtime "$runtime" --source "$source" --target "$target" 2>&1)"; then
    say "$label: $result"
  else
    say "conflict: $label was not changed"
    say "      $result"
    INSTALL_FAILURE=1
  fi
}

install_managed_skill() {
  skill_name="$1"
  runtime="$2"
  dest="$3"
  source="$REPO/skills/$skill_name"
  label="$runtime $skill_name skill"
  if [ ! -f "$source/SKILL.md" ]; then
    say "incomplete: $label source missing ($source)"
    INSTALL_FAILURE=1
    return 0
  fi
  if same_managed_path "$source" "$dest"; then
    say "ok: $label already managed"
    return 0
  fi
  if [ -L "$dest" ] && [ ! -e "$dest" ]; then
    say "stale: $label was $(readlink "$dest") (missing) — relinking to $source"
    run rm -f "$dest"
    run ln -s "$source" "$dest"
    say "linked: $label -> $source"
    return 0
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    say "conflict: $label exists and does not point to this repository ($dest)"
    say "      preserving the existing skill; choose a different name or replace it intentionally"
    INSTALL_FAILURE=1
    return 0
  fi
  run mkdir -p "$(dirname "$dest")"
  run ln -s "$source" "$dest"
  say "linked: $label -> $source"
}

path_state() {
  path="$1"
  target="${2:-}"
  if [ -L "$path" ]; then
    link="$(readlink "$path")"
    if [ ! -e "$path" ]; then
      # install-shared can only relink when the managed source still exists.
      # If the source is gone it skips, so recommending it would leave the user
      # stuck in strict failure with no way out. Branch on source existence.
      if [ -n "$target" ] && [ -e "$target" ]; then
        say "dangling: $path -> $link (missing) — source exists; run: make install-shared to relink"
      elif [ -n "$target" ]; then
        say "dangling: $path -> $link (missing) — source $target is also missing; install-shared will skip this path"
        say "      to clear it: rm '$path'   (then restore $target and run make install-shared to re-create the link)"
      else
        say "dangling: $path -> $link (missing) — unmanaged link with no known source"
        say "      to clear it: rm '$path'"
      fi
      DOCTOR_FAIL_COUNT=$((DOCTOR_FAIL_COUNT + 1))
    elif [ -n "$target" ] && [ "$link" = "$target" ]; then
      say "managed: $path -> $link"
    else
      say "exists-symlink: $path -> $link"
    fi
  elif [ -e "$path" ]; then
    say "exists-local: $path"
  else
    say "missing: $path"
  fi
}

report_runtime_readiness() {
  runtime="$1"
  status="$(runtime_status "$runtime")"
  case "$runtime" in
    claude) runtime_label="Claude" ;;
    codex) runtime_label="Codex" ;;
    *) runtime_label="$runtime" ;;
  esac
  case "$status" in
    configured)
      say "$runtime_label: configured"
      if [ "$runtime" = "codex" ]; then
        say "      trust: unverified — review the installed hook in Codex /hooks; oh-my-ai does not auto-approve trust"
      fi
      ;;
    incomplete)
      say "$runtime_label: incomplete"
      activation_status="$(runtime_hooks_enabled_status "$runtime" "$([ "$runtime" = "claude" ] && printf '%s' "$CLAUDE_DIR/settings.json" || printf '%s' "$CODEX_DIR/hooks.json")")"
      case "$activation_status" in
        disabled)
          if [ "$runtime" = "claude" ]; then
            say "      hooks are disabled by $CLAUDE_DIR/settings.json (disableAllHooks=true); set it to false or remove it, then retry"
          else
            say "      hooks are disabled by $CODEX_DIR/config.toml ([features] hooks = false); set it to true or remove it, then retry"
          fi
          ;;
        unknown)
          say "      hook activation could not be verified from the Runtime configuration"
          ;;
        *)
          say "      a required oh-my-ai entrypoint, managed hook, or Codex skill path is missing"
          ;;
      esac
      DOCTOR_FAIL_COUNT=$((DOCTOR_FAIL_COUNT + 1))
      ;;
    conflict)
      say "$runtime_label: conflict"
      say "      an existing config or skill path was preserved because it is not managed by this repository"
      DOCTOR_FAIL_COUNT=$((DOCTOR_FAIL_COUNT + 1))
      ;;
  esac
}

show_profile_skills() {
  profile_dir="$1"
  skills_dir="$profile_dir/skills"
  rel_skills_dir="${skills_dir#$REPO/}"

  if [ -d "$skills_dir" ]; then
    say "profile private skills: $rel_skills_dir (exists)"
    found_skill=0
    for d in "$skills_dir"/*; do
      [ -d "$d" ] || continue
      if [ -f "$d/SKILL.md" ]; then
        found_skill=1
        say "  private skill: $(basename "$d")"
      fi
    done
    if [ "$found_skill" -eq 0 ]; then
      say "  no private skills with SKILL.md found"
    fi
    say "  note: private skills are gitignored and not automatically installed or linked."
    say "        connect them manually or add an explicit opt-in installer later."
  else
    say "missing: $rel_skills_dir (optional private skills)"
  fi
}

safe_link() {
  src="$1"
  dest="$2"
  label="${3:-$dest}"
  if [ ! -e "$src" ]; then
    say "skip: $label source missing ($src)"
    return 0
  fi
  if same_link "$dest" "$src"; then
    say "ok: $label already managed"
    return 0
  fi
  # stale symlink: points somewhere that no longer exists → replace automatically
  if [ -L "$dest" ] && [ ! -e "$dest" ]; then
    say "stale: $label was $(readlink "$dest") (missing) — relinking to $src"
    run rm -f "$dest"
    run ln -s "$src" "$dest"
    say "linked: $label -> $src"
    return 0
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    say "skip: $label exists; not overwriting ($dest)"
    say "      manual options: keep as-is, back it up yourself, or merge/link intentionally"
    return 0
  fi
  run mkdir -p "$(dirname "$dest")"
  run ln -s "$src" "$dest"
  say "linked: $label -> $src"
}

git_hook_path() {
  hp="$(git -C "$REPO" rev-parse --git-path hooks/pre-commit 2>/dev/null || true)"
  [ -n "$hp" ] || return 1
  case "$hp" in
    /*) printf '%s\n' "$hp" ;;
    *) printf '%s\n' "$REPO/$hp" ;;
  esac
}

git_hook_relative_target() {
  # $1 = directory the symlink will live in
  if command -v realpath >/dev/null 2>&1 && rel="$(realpath --relative-to="$1" "$REPO/hooks/pre-commit" 2>/dev/null)"; then
    printf '%s\n' "$rel"
  else
    printf '%s\n' "$REPO/hooks/pre-commit"
  fi
}

install_git_hook() {
  hook_src="$REPO/hooks/pre-commit"
  if [ ! -f "$hook_src" ]; then
    say "skip: git pre-commit hook source missing ($hook_src)"
    return 0
  fi

  hook_path="$(git_hook_path)" || {
    say "skip: not inside a git repository; cannot install git pre-commit hook"
    return 0
  }
  hook_dir="$(dirname "$hook_path")"
  run mkdir -p "$hook_dir"

  if [ -e "$hook_path" ] && [ ! -L "$hook_path" ]; then
    say "warn: $hook_path exists and is not a symlink; leaving your manual pre-commit hook in place"
    return 0
  fi

  hook_target="$(git_hook_relative_target "$hook_dir")"
  safe_link "$hook_target" "$hook_path" "git pre-commit hook"
}

doctor() {
  say "=== oh-my-ai doctor (read-only) ==="
  path_state "$CLAUDE_DIR/CLAUDE.md" "$REPO/claude/CLAUDE.md"
  path_state "$CLAUDE_DIR/skills" "$REPO/skills"
  path_state "$CLAUDE_DIR/agents" "$REPO/claude/agents"
  path_state "$CODEX_DIR/AGENTS.md" "$REPO/AGENTS.md"
  path_state "$AGENT_DIR/skills" "$REPO/skills"
  path_state "$LOCAL_BIN/oh-my-ai" "$REPO/scripts/oh-my-ai.mjs"
  path_state "$LOCAL_BIN/harness-event" "$REPO/scripts/harness-event.mjs"
  if [ -f "$REPO/scripts/work-start.sh" ] && [ -x "$REPO/scripts/work-start.sh" ]; then
    say "work-start engine: $REPO/scripts/work-start.sh (executable)"
  else
    say "work-start engine: incomplete ($REPO/scripts/work-start.sh must exist and be executable)"
  fi
  say ""
  say "=== Runtime readiness ==="
  report_runtime_readiness claude
  report_runtime_readiness codex
  hook_path="$(git_hook_path 2>/dev/null || true)"
  if [ -n "$hook_path" ]; then
    hook_dir="$(dirname "$hook_path")"
    path_state "$hook_path" "$(git_hook_relative_target "$hook_dir")"
  fi
  say ""
  say "Core hooks are merged additively; Skills are installed as individual paths. Codex trust remains a manual /hooks check."
  say ""
  if [ -n "${HARNESS_PROFILE:-}" ]; then
    profile_local="$REPO/profiles/local/$HARNESS_PROFILE"
    if [ -d "$profile_local" ]; then
      say "profile: profiles/local/$HARNESS_PROFILE (exists)"
      show_profile_skills "$profile_local"
      for f in "$profile_local"/*.sh; do
        [ -f "$f" ] || continue
        script_name="$(basename "$f")"
        path_state "$LOCAL_BIN/$script_name" "$f"
      done
    else
      say "missing: profiles/local/$HARNESS_PROFILE — run: make init-profile PROFILE=$HARNESS_PROFILE"
    fi
  else
    say "hint: set HARNESS_PROFILE=<name> to use a local profile (optional — see profiles/example/)"
  fi

  if [ "$STRICT" -eq 1 ] && [ "$DOCTOR_FAIL_COUNT" -gt 0 ]; then
    return 1
  fi
}

install_shared() {
  say "=== oh-my-ai install-shared (non-destructive) ==="
  run "$REPO/scripts/render-instructions.sh"
  run mkdir -p "$CLAUDE_DIR" "$CODEX_DIR" "$AGENT_DIR" "$LOCAL_BIN"

  safe_link "$REPO/claude/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md" "Claude instruction"
  safe_link "$REPO/AGENTS.md" "$CODEX_DIR/AGENTS.md" "Codex instruction"
  safe_link "$REPO/scripts/oh-my-ai.mjs" "$LOCAL_BIN/oh-my-ai" "oh-my-ai"
  safe_link "$REPO/scripts/harness-event.mjs" "$LOCAL_BIN/harness-event" "harness-event"
  install_runtime_hooks claude "$REPO/claude/settings.json" "$CLAUDE_DIR/settings.json" "Claude managed hooks"
  install_runtime_hooks codex "$REPO/codex/hooks.json" "$CODEX_DIR/hooks.json" "Codex managed hooks"
  install_managed_skill work-start Claude "$CLAUDE_DIR/skills/work-start"
  install_managed_skill work-start Codex "$AGENT_DIR/skills/work-start"
  install_managed_skill spec-to-implementation Codex "$AGENT_DIR/skills/spec-to-implementation"
  safe_link "$REPO/claude/agents" "$CLAUDE_DIR/agents" "Claude shared agents"
  install_git_hook

  if [ "$DRY_RUN" -eq 1 ]; then
    say "Claude: dry-run"
    say "Codex: dry-run"
    return 0
  fi

  say "=== Runtime installation summary ==="
  claude_status="$(runtime_status claude)"
  codex_status="$(runtime_status codex)"
  say "Claude: $claude_status"
  say "Codex: $codex_status"
  if [ "$claude_status" = "incomplete" ] && [ "$(runtime_hooks_enabled_status claude "$CLAUDE_DIR/settings.json")" = "disabled" ]; then
    say "      Claude hooks are disabled by $CLAUDE_DIR/settings.json (disableAllHooks=true); preserving the setting"
  fi
  if [ "$codex_status" = "incomplete" ] && [ "$(runtime_hooks_enabled_status codex "$CODEX_DIR/hooks.json")" = "disabled" ]; then
    say "      Codex hooks are disabled by $CODEX_DIR/config.toml ([features] hooks = false); preserving the setting"
  fi
  if [ "$claude_status" != "configured" ] || [ "$codex_status" != "configured" ]; then
    INSTALL_FAILURE=1
  fi
  if [ "$INSTALL_FAILURE" -ne 0 ]; then
    say "=== incomplete: existing user files were preserved; no manual merge was applied automatically ==="
    return 1
  fi
  say "=== done: Runtime hook definitions and individual Skills were installed without replacing existing directories ==="
  say "Codex trust: unverified — review the installed hook in Codex /hooks before relying on execution."
}

init_profile() {
  if [ -z "$PROFILE_NAME" ]; then
    echo "PROFILE is required for init-profile" >&2
    usage >&2
    exit 2
  fi
  dest_dir="$REPO/profiles/local/$PROFILE_NAME"
  if [ -d "$dest_dir" ]; then
    say "skip: profiles/local/$PROFILE_NAME already exists — not overwriting"
    say "      to reinitialize, remove the directory first:"
    say "        rm -rf profiles/local/$PROFILE_NAME"
    return 0
  fi

  src_dir="$REPO/profiles/example"
  say "=== oh-my-ai init-profile: $PROFILE_NAME ==="
  run mkdir -p "$dest_dir"

  if [ -f "$src_dir/PROFILE.md" ]; then
    run cp "$src_dir/PROFILE.md" "$dest_dir/PROFILE.md"
    say "created: profiles/local/$PROFILE_NAME/PROFILE.md"
  fi

  for f in "$src_dir"/*.example; do
    [ -f "$f" ] || continue
    dest_name="$(basename "${f%.example}")"
    run cp "$f" "$dest_dir/$dest_name"
    say "created: profiles/local/$PROFILE_NAME/$dest_name"
  done

  if [ -d "$src_dir/skills" ]; then
    run mkdir -p "$dest_dir/skills"
    for f in "$src_dir/skills"/*.example; do
      [ -f "$f" ] || continue
      dest_name="$(basename "${f%.example}")"
      run cp "$f" "$dest_dir/skills/$dest_name"
      say "created: profiles/local/$PROFILE_NAME/skills/$dest_name"
    done
  fi

  for script in "$dest_dir"/*.sh; do
    [ -f "$script" ] || continue
    run chmod +x "$script"
    say "chmod +x: $(basename "$script")"
  done

  say ""
  say "Next steps:"
  say "  1. Edit profiles/local/$PROFILE_NAME/ — fill in <placeholder> values"
  say "     (commit-helper.sh, push-guard.sh, claude-settings.json)"
  say "  2. Export in your shell: export HARNESS_PROFILE=$PROFILE_NAME"
  say "     (add to ~/.bashrc or ~/.zshrc to persist)"
  say "  3. Run: make install-profile PROFILE=$PROFILE_NAME"
  say "  4. Run: make doctor"
  say ""
  say "profiles/local/ is gitignored. Do not commit real account values or tokens."
}

install_profile() {
  if [ -z "$PROFILE_NAME" ]; then
    echo "PROFILE is required for install-profile" >&2
    usage >&2
    exit 2
  fi
  profile_dir="$REPO/profiles/local/$PROFILE_NAME"
  if [ ! -d "$profile_dir" ]; then
    profile_dir="$REPO/profiles/$PROFILE_NAME"
  fi
  if [ ! -d "$profile_dir" ]; then
    echo "profile not found: $PROFILE_NAME" >&2
    echo "  create it first: make init-profile PROFILE=$PROFILE_NAME" >&2
    exit 1
  fi

  say "=== oh-my-ai install-profile: $PROFILE_NAME (opt-in, non-destructive) ==="
  if [ -f "$profile_dir/PROFILE.md" ]; then
    say "profile doc: $profile_dir/PROFILE.md"
  fi
  show_profile_skills "$profile_dir"
  run mkdir -p "$LOCAL_BIN"
  found=0
  for f in "$profile_dir"/*; do
    [ -f "$f" ] || continue
    [ "$(basename "$f")" != "PROFILE.md" ] || continue
    [ -x "$f" ] || continue
    found=1
    safe_link "$f" "$LOCAL_BIN/$(basename "$f")" "profile script $(basename "$f")"
  done
  if [ "$found" -eq 0 ]; then
    say "no executable profile scripts to install"
  fi
  if [ -f "$profile_dir/claude-settings.json" ]; then
    say ""
    say "note: claude-settings.json found — not auto-merged into ~/.claude/settings.json"
    say "      review and merge manually if you want profile-specific permissions or plugins:"
    say "        $profile_dir/claude-settings.json"
  fi
  say ""
  say "Profile scripts linked to ~/.local/bin/. Hooks and settings are NOT auto-enabled."
  say "Private skills under profiles/local/<profile>/skills/ are gitignored but NOT auto-merged into runtime skill paths."
  say "Connect private skills manually or wait for an explicit opt-in installer."
  say "To use push-guard.sh as a Claude PreToolUse hook, add it to your local settings.json manually."
}

case "$MODE" in
  doctor) doctor ;;
  install-shared) install_shared ;;
  init-profile) init_profile ;;
  install-profile) install_profile ;;
  *) echo "invalid mode: $MODE" >&2; exit 2 ;;
esac
