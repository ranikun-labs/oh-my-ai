// Pure checks only: READY is not a guarantee. The caller owns realpath, junction,
// symlink and 8.3 resolution, and TOCTOU between check and spawn. This module
// neither enforces sandboxing nor decides writer authority. attemptBoundary
// NOT_ACQUIRED/NOT_RUN means this module acquired and executed nothing.
import path from "node:path";

export const RUNNER_PRECONDITIONS = Object.freeze([
  "realpath_executable_outside_worktree",
  "reject_reparse_points_junction_symlink",
  "resolve_8dot3_short_names",
  "revalidate_executable_identity_at_spawn_toctou",
  "writer_lease_acquired_and_dispatched_recorded",
  "clean_worktree_and_head_revalidated",
  "capture_rollout_turn_baseline_before_resume",
  "output_last_message_path_absent_before_spawn",
  "spawn_without_shell_with_argv_array",
  "prompt_via_stdin_then_eof",
  "process_tree_exit_confirmed_before_release",
]);

const ATTEMPT_BOUNDARY = { claim_status: "NOT_ACQUIRED", dispatch_status: "NOT_RUN" };
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const ALLOWED_ENV = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH",
  "USERNAME", "PROGRAMDATA", "CODEX_HOME", "HOME", "LANG", "HTTPS_PROXY",
  "HTTP_PROXY", "NO_PROXY",
]);

function blocked(code) {
  return { status: "BLOCKED", code, attemptBoundary: { ...ATTEMPT_BOUNDARY } };
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function buildCodexExecArgs(request, platform = process.platform) {
  const { mode, resumeThreadId, model, effort, sandbox, cwd, outputLastMessagePath } = request;
  if (!nonempty(model) || !/^[A-Za-z0-9][\w.:-]*$/.test(model) || !EFFORTS.has(effort)) {
    return blocked("MODEL_OR_EFFORT_MISSING");
  }
  const paths = platform === "win32" ? path.win32 : path.posix;
  if ([cwd, outputLastMessagePath].some(value =>
    !nonempty(value) || value.startsWith("-") || !paths.isAbsolute(value))) {
    return blocked("REQUEST_INVALID");
  }
  if (!["read-only", "workspace-write"].includes(sandbox)) return blocked("SANDBOX_NOT_ALLOWED");
  if (!["NEW", "RESUME"].includes(mode)) return blocked("MODE_INVALID");
  const common = ["--json", "--skip-git-repo-check", "-m", model, "-c", `model_reasoning_effort=${effort}`];
  let argv;
  if (mode === "NEW") {
    argv = ["exec", ...common, "-s", sandbox, "-C", cwd, "-o", outputLastMessagePath, "-"];
  } else {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof resumeThreadId !== "string" || !uuid.test(resumeThreadId)) {
      return blocked("RESUME_ID_INVALID");
    }
    argv = ["exec", "resume", resumeThreadId, ...common, "-c", `sandbox_mode=${sandbox}`, "-o",
      outputLastMessagePath, "-"];
  }
  return { status: "READY", argv, spawnCwd: cwd };
}

function normalizeExecutablePath(value, paths, platform) {
  let clean = value.replace(/^\\\\\?\\/, "");
  if (platform === "win32") clean = clean.split(/[\\/]/).map(part => part.replace(/[. ]+$/, "")).join("/");
  let normalized = paths.normalize(clean);
  normalized = normalized.replaceAll("\\", "/");
  if (platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

export function resolveCodexExecutable({ platform, configuredPath, shimDir, worktreeRoots = [], exists }) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const candidate = configuredPath || (platform === "win32" && shimDir
    ? paths.join(shimDir,
      "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe")
    : null);
  if (!Array.isArray(worktreeRoots) || worktreeRoots.some(root =>
    typeof root !== "string" || !paths.isAbsolute(root))) {
    return blocked("WORKTREE_ROOT_INVALID");
  }
  if (!candidate || !paths.isAbsolute(candidate)) return blocked("ENVIRONMENT_UNIDENTIFIED");
  if (platform === "win32") {
    const clean = candidate.replace(/^\\\\\?\\/, "");
    if (!/^[a-z]:[\\/]/i.test(clean) || clean.slice(2).includes(":")) {
      return blocked("EXECUTABLE_PATH_INVALID");
    }
    const segments = clean.slice(3).split(/[\\/]/).filter(Boolean);
    if (segments.some(segment => /[. ]$/.test(segment)) || !/\.exe$/i.test(clean)) {
      return blocked("EXECUTABLE_SHIM_REJECTED");
    }
  }
  if (/\.(cmd|ps1|bat)$/i.test(candidate)) return blocked("EXECUTABLE_SHIM_REJECTED");
  // Callers must resolve symlinks, junctions and Windows 8.3 aliases with realpath.
  const target = normalizeExecutablePath(candidate, paths, platform);
  const inside = worktreeRoots.some(root => {
    const normalized = normalizeExecutablePath(root, paths, platform);
    const prefix = normalized.endsWith("/") ? normalized : normalized + "/";
    return target === normalized || target.startsWith(prefix);
  });
  if (inside) return blocked("EXECUTABLE_INSIDE_WORKTREE");
  try {
    if (typeof exists !== "function" || !exists(candidate)) return blocked("ENVIRONMENT_UNIDENTIFIED");
  } catch {
    return blocked("ENVIRONMENT_UNIDENTIFIED");
  }
  return { status: "READY", path: candidate };
}

export function buildSpawnEnv(sourceEnv, platform) {
  // Success returns { status: "READY", env }; conflicting Windows aliases block.
  const env = {};
  const seen = new Map();
  for (const [key, value] of Object.entries(sourceEnv)) {
    const canonical = platform === "win32" ? key.toUpperCase() : key;
    if (!ALLOWED_ENV.has(canonical)) continue;
    if (seen.has(canonical)) {
      if (seen.get(canonical) !== value) return blocked("ENV_AMBIGUOUS");
      continue;
    }
    seen.set(canonical, value);
    env[key] = value;
  }
  return { status: "READY", env };
}

export function classifyLoginStatus({ exitCode, stdout, stderr }) {
  const text = String(stdout ?? "") + "\n" + String(stderr ?? "");
  // API-key detection wins conservatively when output mentions both modes.
  if (/API key/i.test(text)) return blocked("AUTH_MODE_API_KEY");
  if (exitCode === 0 && text.split(/\r?\n/).includes("Logged in using ChatGPT")) {
    return { status: "READY", authMode: "chatgpt" };
  }
  return blocked("AUTH_UNOBSERVABLE");
}

export function classifyUsage(result, { ceilingPercent, ownerException } = {}) {
  const limits = result?.rateLimits;
  const nestedAllowed = limits?.ordinaryUsageAllowed;
  const topAllowed = result?.ordinaryUsageAllowed;
  if (nestedAllowed === false || topAllowed === false || limits?.rateLimitReachedType != null ||
      result?.rateLimitReachedType != null) {
    return blocked("USAGE_EXHAUSTED");
  }
  if (ceilingPercent !== undefined && (typeof ceilingPercent !== "number" ||
      !Number.isFinite(ceilingPercent) || ceilingPercent < 0 || ceilingPercent > 100)) return blocked("USAGE_INVALID");
  if (limits?.primary == null) return blocked("USAGE_UNKNOWN");
  const windows = [];
  for (const name of ["primary", "secondary"]) {
    const window = limits[name];
    if (window == null && name === "secondary") continue;
    const usedPercent = window?.usedPercent;
    const windowDurationMins = window?.windowDurationMins;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 ||
        usedPercent > 100 || (windowDurationMins != null && (typeof windowDurationMins !== "number" ||
        !Number.isFinite(windowDurationMins) || windowDurationMins <= 0))) return blocked("USAGE_INVALID");
    windows.push({ name, usedPercent, windowDurationMins });
  }
  if ((nestedAllowed != null && topAllowed != null && nestedAllowed !== topAllowed) ||
      (nestedAllowed !== true && topAllowed !== true)) return blocked("USAGE_UNKNOWN");
  const exceeded = windows.find(window => ceilingPercent !== undefined && window.usedPercent >= ceilingPercent);
  if (exceeded && ownerException !== true) return { ...blocked("USAGE_CEILING"), window: exceeded.name };
  return { status: "READY", windows, ...(exceeded ? { ownerExceptionApplied: true } : {}) };
}
