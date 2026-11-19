#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"

FIXTURE_ROOT="fixtures/notice/manifests"
NOTICE="$REPO/scripts/notice.mjs"

cleanup_dirs=()
pending_refreshes=()

cleanup() {
  if [ "${KEEP_NOTICE_FIXTURE_ARTIFACTS:-}" = "1" ]; then
    return 0
  fi
  for path in "${cleanup_dirs[@]:-}"; do
    local pending
    for pending in "${pending_refreshes[@]:-}"; do
      if [ "$pending" = "$path" ]; then
        echo "notice fixture: retaining sandbox with unobserved detached refresh: $path" >&2
        continue 2
      fi
    done
    case "$path" in
      */oh-my-ai-notice-fixture.*) [ -d "$path" ] && rm -rf -- "$path" ;;
    esac
  done
  return 0
}
trap cleanup EXIT

fail() {
  echo "fixture failure: $*" >&2
  exit 1
}

run_with_timeout() {
  local seconds="$1"
  shift
  node -e '
    const { spawnSync } = require("node:child_process");
    const [seconds, command, ...args] = process.argv.slice(1);
    const result = spawnSync(command, args, {
      stdio: "inherit",
      timeout: Number(seconds) * 1000,
    });
    if (result.error?.code === "ETIMEDOUT") process.exit(124);
    process.exit(result.status ?? 1);
  ' "$seconds" "$@"
}

require_file() {
  local path="$1"
  [ -f "$path" ] || fail "missing file: $path"
}

# --- sandbox helpers ---------------------------------------------------------

# Every fixture gets its own XDG_CACHE_HOME/XDG_CONFIG_HOME under a fresh
# temp dir, so fixtures never touch the real $HOME and never share state
# with each other or with a real installation.
new_sandbox() {
  NEW_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oh-my-ai-notice-fixture.XXXXXX")"
  NEW_SANDBOX="$(cd "$NEW_SANDBOX" && pwd -P)"
  cleanup_dirs+=("$NEW_SANDBOX")
  mkdir -p "$NEW_SANDBOX/cache" "$NEW_SANDBOX/config"
}

notice_in() {
  local sandbox="$1"
  shift
  XDG_CACHE_HOME="$sandbox/cache" XDG_CONFIG_HOME="$sandbox/config" node "$NOTICE" "$@"
}

manifest_url() {
  printf 'file://%s/%s' "$REPO" "$1"
}

cache_file_in() {
  printf '%s/cache/oh-my-ai/notice-manifest.json' "$1"
}

state_file_in() {
  printf '%s/config/oh-my-ai/notice-state.json' "$1"
}

lock_file_in() {
  printf '%s/cache/oh-my-ai/notice-refresh.lock' "$1"
}

# An absent lock alone is not a completion signal: a detached child may not
# have started yet. Register before launch and require its unique trace event,
# then the actual lock release. On timeout the EXIT trap preserves the sandbox
# because the unobserved child can still create files in it later.
register_detached_refresh() {
  local sandbox="$1" escaped_helper
  PENDING_TRACE="$sandbox/notice-refresh-test.trace"
  PENDING_LAUNCH="$sandbox/notice-refresh-launch.trace"
  PENDING_HELPER="$sandbox/observe-refresh.cjs"
  rm -f -- "$PENDING_TRACE" "$PENDING_LAUNCH"
  # Observe the actual refresh parent without changing detached child behavior.
  # A completion record distinguishes an observed no-spawn from a delayed or
  # crashed parent; absent/invalid evidence keeps the sandbox on cleanup.
  cat > "$PENDING_HELPER" <<'NODE'
const path = require("node:path");
if (path.basename(process.argv[1] || "") === "notice.mjs" && process.argv[2] === "refresh-if-stale") {
  const cp = require("node:child_process");
  const fs = require("node:fs");
  const originalSpawn = cp.spawn;
  let count = 0;
  cp.spawn = function (...args) {
    const child = originalSpawn.apply(this, args);
    if (Array.isArray(args[1]) && args[1].includes("__do-refresh")) count += 1;
    return child;
  };
  require("node:module").syncBuiltinESMExports();
  process.on("exit", () => {
    try { fs.appendFileSync(process.env.NOTICE_FIXTURE_LAUNCH_TRACE, `complete spawned=${count}\n`); } catch {}
  });
}
NODE
  escaped_helper="${PENDING_HELPER//\\/\\\\}"
  escaped_helper="${escaped_helper//\"/\\\"}"
  PENDING_NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=\"$escaped_helper\""
  pending_refreshes+=("$sandbox")
}

wait_for_registered_refresh() {
  local sandbox="$1" trace="$2" launch="$3" expected="$4"
  local lock_file waited_ms=0 timeout_ms=5000 actual
  lock_file="$(lock_file_in "$sandbox")"
  while ! { [ -s "$launch" ] && grep -Eq '^complete spawned=[01]$' "$launch"; }; do
    [ "$waited_ms" -lt "$timeout_ms" ] \
      || fail "detached refresh parent unobserved; sandbox retained: $sandbox"
    sleep 0.02
    waited_ms=$((waited_ms + 20))
  done
  actual="$(sed -n 's/^complete spawned=//p' "$launch")"
  [ "$actual" = "$expected" ] \
    || fail "unexpected refresh launch count; sandbox retained: $sandbox"
  if [ "$actual" = "1" ]; then
    while ! { [ -s "$trace" ] && [ ! -e "$lock_file" ]; }; do
      [ "$waited_ms" -lt "$timeout_ms" ] \
        || fail "detached notice refresh unobserved; sandbox retained: $sandbox"
      sleep 0.02
      waited_ms=$((waited_ms + 20))
    done
    grep -Eq '^(acquired|acquired-after-stale|skipped-held|skipped-race|skipped-error) pid=[0-9]+$' "$trace" \
      || fail "unexpected notice refresh trace; sandbox retained: $sandbox"
  fi
  clear_pending_refresh "$sandbox"
}

clear_pending_refresh() {
  local sandbox="$1" i
  for i in "${!pending_refreshes[@]}"; do
    [ "${pending_refreshes[$i]}" != "$sandbox" ] || unset 'pending_refreshes[i]'
  done
}

do_refresh() {
  local sandbox="$1"
  local manifest_rel="$2"
  local version="${3:-1.0.0}"
  NOTICE_TEST_LOCK_TRACE= NOTICE_MANIFEST_URL="$(manifest_url "$manifest_rel")" \
    notice_in "$sandbox" __do-refresh --version "$version"
}

render() {
  local sandbox="$1"
  local version="${2:-1.0.0}"
  notice_in "$sandbox" render --version "$version"
}

# A stale cache ensures an opt-out test would launch a refresh if the opt-out
# check regressed; a fresh cache would hide that failure by returning early.
age_cache() {
  local cache_file="$1"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.fetched_at = Date.now() - (25 * 60 * 60 * 1000);
    fs.writeFileSync(file, JSON.stringify(data));
  ' "$cache_file"
}

# --- FX-NT-001 No Cache -------------------------------------------------------

fx_nt_001() {
  local sandbox out
  new_sandbox; sandbox="$NEW_SANDBOX"
  out="$(render "$sandbox" 1.0.0)"
  [ -z "$out" ] || fail "FX-NT-001: expected empty render with no cache, got: $out"
  [ -f "$(cache_file_in "$sandbox")" ] && fail "FX-NT-001: cache file must not be created by render alone"
  echo "passed: FX-NT-001-no-cache"
}

# --- FX-NT-002 Valid Cache -----------------------------------------------------

fx_nt_002() {
  local sandbox out
  new_sandbox; sandbox="$NEW_SANDBOX"
  do_refresh "$sandbox" "$FIXTURE_ROOT/valid-single-notice.json" 1.0.0
  [ -s "$(cache_file_in "$sandbox")" ] || fail "FX-NT-002: cache was not populated"
  out="$(render "$sandbox" 1.0.0)"
  case "$out" in
    *"a valid single notice"*) ;;
    *) fail "FX-NT-002: expected notice text in render output, got: $out" ;;
  esac
  echo "passed: FX-NT-002-valid-cache"
}

# --- FX-NT-003 Stale Cache -----------------------------------------------------

fx_nt_003() {
  local sandbox cache_file
  new_sandbox; sandbox="$NEW_SANDBOX"
  do_refresh "$sandbox" "$FIXTURE_ROOT/valid-single-notice.json" 1.0.0
  cache_file="$(cache_file_in "$sandbox")"
  [ -s "$cache_file" ] || fail "FX-NT-003: cache was not populated"
  # Force staleness: rewrite fetched_at far in the past.
  age_cache "$cache_file"
  local status trace launch helper_options
  status="$(notice_in "$sandbox" status)"
  echo "$status" | grep -q '"cache_stale": true' || fail "FX-NT-003: cache was not reported stale"
  # refresh-if-stale must return quickly and not block on network; the
  # decisive proof (a spawn actually happened) is covered by FX-NT-014/015,
  # which drive the same code path through work-start.sh end to end.
  register_detached_refresh "$sandbox"; trace="$PENDING_TRACE"; launch="$PENDING_LAUNCH"; helper_options="$PENDING_NODE_OPTIONS"
  XDG_CACHE_HOME="$sandbox/cache" XDG_CONFIG_HOME="$sandbox/config" \
    NOTICE_TEST_LOCK_TRACE="$trace" NOTICE_FIXTURE_LAUNCH_TRACE="$launch" NODE_OPTIONS="$helper_options" \
    NOTICE_MANIFEST_URL="$(manifest_url "$FIXTURE_ROOT/valid-single-notice.json")" run_with_timeout 5 node "$NOTICE" refresh-if-stale --version 1.0.0 \
    || fail "FX-NT-003: refresh-if-stale did not return promptly"
  wait_for_registered_refresh "$sandbox" "$trace" "$launch" 1
  echo "passed: FX-NT-003-stale-cache"
}

# --- FX-NT-004 Network Failure --------------------------------------------------

fx_nt_004() {
  local sandbox cache_file
  new_sandbox; sandbox="$NEW_SANDBOX"
  cache_file="$(cache_file_in "$sandbox")"
  # A nonexistent file:// target is a deterministic, network-free proxy for
  # "the fetch failed" -- __do-refresh's catch-all treats every fetch failure
  # (ENOENT, ECONNREFUSED, DNS failure, ...) identically: leave cache as-is.
  do_refresh "$sandbox" "$FIXTURE_ROOT/does-not-exist.json" 1.0.0
  [ -f "$cache_file" ] && fail "FX-NT-004: cache must stay absent after a fetch failure with no prior cache"

  # Seed a valid cache, then fail a refresh -- prior cache must survive untouched.
  do_refresh "$sandbox" "$FIXTURE_ROOT/valid-single-notice.json" 1.0.0
  local before after
  before="$(cat "$cache_file")"
  do_refresh "$sandbox" "$FIXTURE_ROOT/does-not-exist.json" 1.0.0
  after="$(cat "$cache_file")"
  [ "$before" = "$after" ] || fail "FX-NT-004: existing cache was modified after a failed refresh"
  echo "passed: FX-NT-004-network-failure"
}

# --- FX-NT-005 Invalid JSON ----------------------------------------------------

fx_nt_005() {
  local sandbox cache_file
  new_sandbox; sandbox="$NEW_SANDBOX"
  cache_file="$(cache_file_in "$sandbox")"
  do_refresh "$sandbox" "$FIXTURE_ROOT/invalid.json" 1.0.0
  [ -f "$cache_file" ] && fail "FX-NT-005: invalid JSON must not produce a cache file"
  echo "passed: FX-NT-005-invalid-json"
}

# --- FX-NT-006 Unsupported Schema ----------------------------------------------

fx_nt_006() {
  local sandbox cache_file
  new_sandbox; sandbox="$NEW_SANDBOX"
  cache_file="$(cache_file_in "$sandbox")"
  do_refresh "$sandbox" "$FIXTURE_ROOT/unsupported-schema.json" 1.0.0
  [ -f "$cache_file" ] && fail "FX-NT-006: unsupported schema_version must not produce a cache file"
  echo "passed: FX-NT-006-unsupported-schema"
}

# --- Supplementary: Action URL Allowlist (Contract Part VI §23) ----------------
# Not one of the Foundation Fixture Plan's 15 automatic IDs on its own; it
# exercises per-notice Manifest Safety validation exercised during FX-NT-002's
# schema path, kept as its own function for a clearer failure message.

fx_supplementary_action_url_allowlist() {
  local sandbox cache_file
  new_sandbox; sandbox="$NEW_SANDBOX"
  cache_file="$(cache_file_in "$sandbox")"
  do_refresh "$sandbox" "$FIXTURE_ROOT/bad-action-url.json" 1.0.0
  [ -s "$cache_file" ] || fail "action-url-allowlist: expected the manifest to still cache the surviving notice"
  if grep -q "fx-nt-bad-url" "$cache_file"; then
    fail "action-url-allowlist: notice with a non-allowlisted action_url was cached"
  fi
  grep -q "fx-nt-good-url" "$cache_file" \
    || fail "action-url-allowlist: sibling notice with an allowlisted action_url was dropped too"
  echo "passed: FX-supplementary-action-url-allowlist"
}

# --- FX-NT-007 Version Mismatch -------------------------------------------------

fx_nt_007() {
  local sandbox out
  new_sandbox; sandbox="$NEW_SANDBOX"
  do_refresh "$sandbox" "$FIXTURE_ROOT/version-ranged.json" 1.0.0
  out="$(render "$sandbox" 5.0.0)"
  [ -z "$out" ] || fail "FX-NT-007: out-of-range version must not see the notice, got: $out"

  local sandbox2
  new_sandbox; sandbox2="$NEW_SANDBOX"
  do_refresh "$sandbox2" "$FIXTURE_ROOT/version-ranged.json" unknown-not-semver
  out="$(render "$sandbox2" unknown-not-semver)"
  [ -z "$out" ] || fail "FX-NT-007: unparseable version must never match, got: $out"
  echo "passed: FX-NT-007-version-mismatch"
}

# --- FX-NT-008 Max Impressions Reached ------------------------------------------

fx_nt_008() {
  local sandbox out
  new_sandbox; sandbox="$NEW_SANDBOX"
  do_refresh "$sandbox" "$FIXTURE_ROOT/max-impressions-one.json" 1.0.0
  out="$(render "$sandbox" 1.0.0)"
  case "$out" in
    *"max_impressions is 1"*) ;;
    *) fail "FX-NT-008: expected the notice on the first render, got: $out" ;;
  esac
  out="$(render "$sandbox" 1.0.0)"
  [ -z "$out" ] || fail "FX-NT-008: notice must not render again after reaching max_impressions, got: $out"
  echo "passed: FX-NT-008-max-impressions"
}

# --- FX-NT-009 Dismiss ----------------------------------------------------------

fx_nt_009() {
  local sandbox out
  new_sandbox; sandbox="$NEW_SANDBOX"
  do_refresh "$sandbox" "$FIXTURE_ROOT/valid-single-notice.json" 1.0.0
  notice_in "$sandbox" dismiss fx-nt-valid >/dev/null
  out="$(render "$sandbox" 1.0.0)"
  [ -z "$out" ] || fail "FX-NT-009: dismissed notice must not render, got: $out"
  echo "passed: FX-NT-009-dismiss"
}

# --- FX-NT-010 Opt-out -----------------------------------------------------------

fx_nt_010() {
  local sandbox out cache_before cache_after trace launch helper_options
  new_sandbox; sandbox="$NEW_SANDBOX"
  do_refresh "$sandbox" "$FIXTURE_ROOT/valid-single-notice.json" 1.0.0
  notice_in "$sandbox" opt-out >/dev/null

  out="$(render "$sandbox" 1.0.0)"
  [ -z "$out" ] || fail "FX-NT-010: render must be empty after opt-out, got: $out"

  # Ensure the cache alone would not suppress refresh; opt-out must do so.
  age_cache "$(cache_file_in "$sandbox")"
  cache_before="$(cat "$(cache_file_in "$sandbox")")"
  # refresh-if-stale must not spawn a fetch at all once opted out.
  register_detached_refresh "$sandbox"; trace="$PENDING_TRACE"; launch="$PENDING_LAUNCH"; helper_options="$PENDING_NODE_OPTIONS"
  XDG_CACHE_HOME="$sandbox/cache" XDG_CONFIG_HOME="$sandbox/config" \
    NOTICE_TEST_LOCK_TRACE="$trace" NOTICE_FIXTURE_LAUNCH_TRACE="$launch" NODE_OPTIONS="$helper_options" \
    NOTICE_MANIFEST_URL="$(manifest_url "$FIXTURE_ROOT/version-ranged.json")" \
    node "$NOTICE" refresh-if-stale --version 1.0.0
  wait_for_registered_refresh "$sandbox" "$trace" "$launch" 0
  cache_after="$(cat "$(cache_file_in "$sandbox")")"
  [ "$cache_before" = "$cache_after" ] || fail "FX-NT-010: cache changed after opt-out; a network check ran"

  # __do-refresh itself must never run for an opted-out user via refresh-if-stale;
  # opt-in restores normal refresh behavior.
  notice_in "$sandbox" opt-in >/dev/null
  do_refresh "$sandbox" "$FIXTURE_ROOT/version-ranged.json" 1.0.0
  cache_after="$(cat "$(cache_file_in "$sandbox")")"
  [ "$cache_before" != "$cache_after" ] || fail "FX-NT-010: refresh did not resume after opt-in"
  echo "passed: FX-NT-010-opt-out"
}

# --- FX-NT-011 Concurrent Refresh ------------------------------------------------

fx_nt_011() {
  local sandbox trace cache_file
  new_sandbox; sandbox="$NEW_SANDBOX"
  cache_file="$(cache_file_in "$sandbox")"
  trace="$sandbox/lock-trace.log"
  : > "$trace"

  # The children below are waited explicitly. Preserve this sandbox on early
  # interruption so cleanup cannot race a child that is still running.
  pending_refreshes+=("$sandbox")
  # Widen the critical section so two invocations launched back-to-back are
  # forced to genuinely overlap, instead of hoping process scheduling alone
  # creates a race.
  (
    XDG_CACHE_HOME="$sandbox/cache" XDG_CONFIG_HOME="$sandbox/config" \
      NOTICE_MANIFEST_URL="test-delay-file://$REPO/$FIXTURE_ROOT/valid-single-notice.json" \
      NOTICE_TEST_LOCK_TRACE="$trace" NOTICE_TEST_FETCH_DELAY_MS=400 \
      node "$NOTICE" __do-refresh --version 1.0.0
  ) &
  local p1=$!
  sleep 0.05
  (
    XDG_CACHE_HOME="$sandbox/cache" XDG_CONFIG_HOME="$sandbox/config" \
      NOTICE_MANIFEST_URL="test-delay-file://$REPO/$FIXTURE_ROOT/valid-single-notice.json" \
      NOTICE_TEST_LOCK_TRACE="$trace" NOTICE_TEST_FETCH_DELAY_MS=400 \
      node "$NOTICE" __do-refresh --version 1.0.0
  ) &
  local p2=$!
  wait "$p1" "$p2"
  clear_pending_refresh "$sandbox"

  local acquired skipped
  acquired="$(grep -c '^acquired' "$trace" || true)"
  skipped="$(grep -c '^skipped-held' "$trace" || true)"
  [ "$acquired" = "1" ] || fail "FX-NT-011: expected exactly one acquired refresh, trace: $(cat "$trace")"
  [ "$skipped" = "1" ] || fail "FX-NT-011: expected exactly one skipped-held refresh, trace: $(cat "$trace")"

  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$cache_file" \
    || fail "FX-NT-011: cache is not valid JSON after concurrent refresh"
  echo "passed: FX-NT-011-concurrent-refresh"
}

# --- FX-NT-012 Synthetic Event --------------------------------------------------

fx_nt_012() {
  local sandbox cache_file state_file
  new_sandbox; sandbox="$NEW_SANDBOX"
  cache_file="$(cache_file_in "$sandbox")"
  state_file="$(state_file_in "$sandbox")"

  require_file "scripts/prompt-routing-hook.mjs"
  local task_json
  task_json='{"prompt":"add a notice check to the login flow"}'
  printf '%s' "$task_json" | \
    XDG_CACHE_HOME="$sandbox/cache" XDG_CONFIG_HOME="$sandbox/config" \
    node scripts/prompt-routing-hook.mjs --format=claude-json >/dev/null

  [ -f "$cache_file" ] && fail "FX-NT-012: Synthetic/Suggestion path created a Notice cache file"
  [ -f "$state_file" ] && fail "FX-NT-012: Synthetic/Suggestion path created a Notice state file"

  if ! grep -q 'work-start.sh.*from this suggestion' scripts/prompt-routing-hook.mjs; then
    fail "FX-NT-012: expected prompt-routing-hook.mjs to still refuse to invoke Work-start itself"
  fi
  if grep -q 'notice.mjs' scripts/prompt-routing-hook.mjs; then
    fail "FX-NT-012: prompt-routing-hook.mjs must never reference notice.mjs"
  fi
  echo "passed: FX-NT-012-synthetic-event"
}

# --- work-start.sh driven fixtures (013 / 014 / 015) -----------------------------

# manifest_rel is required (not optional): every fixture-driven work-start.sh
# run must point NOTICE_MANIFEST_URL at a local fixture file. Without this,
# work-start.sh's own end-of-run refresh-if-stale would spawn a real
# background fetch against the default https:// URL; that detached child can
# hold the refresh lock for up to the hard timeout and silently starve a
# later synchronous do_refresh() call in the same sandbox.
run_work_start_capturing_artifact() {
  local sandbox="$1"
  local task="$2"
  local version="$3"
  local manifest_rel="$4"
  [ -n "$manifest_rel" ] || fail "run_work_start_capturing_artifact requires manifest_rel (no real network in fixtures)"
  local out artifact trace launch helper_options expected=0
  # The first run of each pair has an empty cache; the second has fresh local
  # cache. Record every launch and retain the sandbox if either fact is unclear.
  case "$task" in
    "fx-nt-013 without notice"|"fx-nt-014 first run") expected=1 ;;
  esac
  # Run the real engine against a sandbox-owned repository. Its generated
  # artifacts must never share the caller's .oh-my-ai tree with another run.
  local fixture_repo="$sandbox/project" git_var
  local -a git_env_args=()
  while IFS= read -r git_var; do
    [ -n "$git_var" ] && git_env_args+=(-u "$git_var")
  done < <(git rev-parse --local-env-vars)
  if [ ! -d "$fixture_repo/.git" ]; then
    mkdir -p "$fixture_repo"
    env "${git_env_args[@]}" git -C "$fixture_repo" init -q
  fi
  register_detached_refresh "$sandbox"; trace="$PENDING_TRACE"; launch="$PENDING_LAUNCH"; helper_options="$PENDING_NODE_OPTIONS"
  out="$(cd "$fixture_repo" && env "${git_env_args[@]}" -u TASK_FILE -u OH_MY_AI_WORK_START_INVOCATION_LOG \
    XDG_CACHE_HOME="$sandbox/cache" XDG_CONFIG_HOME="$sandbox/config" \
    NOTICE_TEST_LOCK_TRACE="$trace" NOTICE_FIXTURE_LAUNCH_TRACE="$launch" NODE_OPTIONS="$helper_options" \
    NOTICE_MANIFEST_URL="$(manifest_url "$manifest_rel")" TASK="$task" bash "$REPO/scripts/work-start.sh" 2>&1)" || fail "work-start.sh exited non-zero for: $task"
  wait_for_registered_refresh "$sandbox" "$trace" "$launch" "$expected"
  artifact="$(printf '%s\n' "$out" | sed -n 's/^work-start artifact created: //p')"
  [ -n "$artifact" ] || fail "could not parse artifact path for: $task"
  case "$artifact" in
    .oh-my-ai/work-start/*) ;;
    *) fail "unsafe artifact path: $artifact" ;;
  esac
  WORK_START_RESULT="$(printf '%s\n%s' "$fixture_repo/$artifact" "$out")"
}

# --- FX-NT-013 Artifact Content Invariance --------------------------------------

fx_nt_013() {
  local sandbox result artifact_notice artifact_plain out_notice out_plain
  new_sandbox; sandbox="$NEW_SANDBOX"

  run_work_start_capturing_artifact "$sandbox" "fx-nt-013 without notice" 1.0.0 "$FIXTURE_ROOT/does-not-exist.json"
  result="$WORK_START_RESULT"
  artifact_plain="$(printf '%s' "$result" | head -1)"

  # The observed detached refresh has completed before the next local refresh.
  do_refresh "$sandbox" "$FIXTURE_ROOT/valid-single-notice.json" 1.0.0
  run_work_start_capturing_artifact "$sandbox" "fx-nt-013 with notice" 1.0.0 "$FIXTURE_ROOT/does-not-exist.json"
  result="$WORK_START_RESULT"
  artifact_notice="$(printf '%s' "$result" | head -1)"
  out_notice="$(printf '%s' "$result" | tail -n +2)"

  case "$out_notice" in
    *"a valid single notice"*) ;;
    *) fail "FX-NT-013: expected the notice text in stdout for the second run" ;;
  esac

  local artifact_file grep_status
  for artifact_file in "$artifact_plain/handoff-candidate.md" "$artifact_notice/handoff-candidate.md"; do
    [ -s "$artifact_file" ] || fail "FX-NT-013: expected Candidate Artifact missing"
  done
  if grep -rli "valid single notice" "$artifact_plain" "$artifact_notice" >/dev/null 2>&1; then
    fail "FX-NT-013: notice text leaked into a Candidate Artifact file"
  else
    grep_status=$?
    [ "$grep_status" -eq 1 ] || fail "FX-NT-013: unable to inspect Candidate Artifacts"
  fi
  echo "passed: FX-NT-013-artifact-invariance"
}

# --- FX-NT-014 Remote Not Injected / FX-NT-015 Next-run Visibility --------------

fx_nt_014_015() {
  local sandbox result artifact1 out1 artifact2 out2
  new_sandbox; sandbox="$NEW_SANDBOX"

  # Run 1 snapshots the empty cache before launching a genuine detached
  # refresh of a local fixture. The refresh must not affect this run's output.
  run_work_start_capturing_artifact "$sandbox" "fx-nt-014 first run" 1.0.0 "$FIXTURE_ROOT/valid-single-notice.json"
  result="$WORK_START_RESULT"
  artifact1="$(printf '%s' "$result" | head -1)"
  out1="$(printf '%s' "$result" | tail -n +2)"
  case "$out1" in
    *"a valid single notice"*) fail "FX-NT-014: Remote result leaked into the run that triggered the refresh" ;;
  esac

  # The trace+lock completion above confirms the actual background refresh,
  # rather than replacing it with a second synchronous refresh.
  [ -s "$(cache_file_in "$sandbox")" ] || fail "FX-NT-014: expected cache to be populated after refresh"

  # Run 2: the now-warm cache is this run's Snapshot; the notice must appear.
  run_work_start_capturing_artifact "$sandbox" "fx-nt-015 second run" 1.0.0 "$FIXTURE_ROOT/does-not-exist.json"
  result="$WORK_START_RESULT"
  artifact2="$(printf '%s' "$result" | head -1)"
  out2="$(printf '%s' "$result" | tail -n +2)"
  case "$out2" in
    *"a valid single notice"*) ;;
    *) fail "FX-NT-015: expected the notice to appear on the next explicit Work-start run" ;;
  esac

  echo "passed: FX-NT-014-remote-not-injected"
  echo "passed: FX-NT-015-next-run-visibility"
}

# --- run everything ---------------------------------------------------------------

require_file "$NOTICE"
require_file "scripts/work-start.sh"
for m in valid-single-notice version-ranged unsupported-schema invalid bad-action-url max-impressions-one; do
  require_file "$FIXTURE_ROOT/$m.json"
done

fx_nt_001
fx_nt_002
fx_supplementary_action_url_allowlist
fx_nt_003
fx_nt_004
fx_nt_005
fx_nt_006
fx_nt_007
fx_nt_008
fx_nt_009
fx_nt_010
fx_nt_011
fx_nt_012
fx_nt_013
fx_nt_014_015

echo "all Notice fixtures passed"
