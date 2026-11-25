// Pure checks only: READY is not a guarantee. The caller owns realpath, junction,
// symlink and 8.3 resolution, and TOCTOU between check and spawn. This module
// neither enforces sandboxing nor decides writer authority. attemptBoundary
// NOT_ACQUIRED/NOT_RUN means this module acquired and executed nothing.
import path from "node:path";

export function summarizeExecEvents(jsonlText) {
  const events = {};
  const terminals = [];
  let threadId = null;
  let usage;
  let malformed = false;
  for (const line of jsonlText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (!event || typeof event.type !== "string") {
      malformed = true;
      continue;
    }
    events[event.type] = (events[event.type] || 0) + 1;
    if (event.type === "thread.started") {
      if (typeof event.thread_id !== "string") malformed = true;
      else threadId = event.thread_id;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      terminals.push(event.type);
      if (event.type === "turn.completed") usage = event.usage;
    }
  }
  const terminal = events["thread.started"] === 1 && terminals.length === 1
    ? terminals[0].slice(5) : "none";
  // On resume, turn.completed.usage is thread-cumulative; never sum attempts.
  return { threadId, terminal, events, usage, usageBasis: "THREAD_CUMULATIVE", malformed };
}

const required = ["input_tokens", "cached_input_tokens", "output_tokens"];
const optional = ["cache_write_input_tokens", "reasoning_output_tokens"];

export function isValidUsage(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    required.every(field => Number.isSafeInteger(value[field]) && value[field] >= 0) &&
    optional.every(field => !(field in value) || (Number.isSafeInteger(value[field]) && value[field] >= 0)) &&
    value.cached_input_tokens <= value.input_tokens;
}

// Thread-cumulative values must never be summed; tokens cannot determine subscription usage deduction.
export function usageDelta(previous, current) {
  if (!isValidUsage(previous) || !isValidUsage(current)) return "UNKNOWN";
  const delta = {};
  for (const field of [...required, ...optional]) {
    if (previous[field] === undefined || current[field] === undefined) continue;
    if (current[field] < previous[field]) return "UNKNOWN";
    delta[field] = current[field] - previous[field];
  }
  delta.nonCachedInput = delta.input_tokens - delta.cached_input_tokens;
  if (delta.nonCachedInput < 0) return "UNKNOWN";
  return delta;
}

export function extractEffectiveSettings(rolloutJsonlText) {
  let context = {};
  let meta = {};
  let completedTurnId;
  let turnContextCount = 0;
  for (const line of rolloutJsonlText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "turn_context") {
        context = event.payload ?? {};
        turnContextCount++;
      }
      if (event.type === "event_msg" && event.payload?.type === "task_complete") {
        completedTurnId = event.payload.turn_id ?? event.payload.turn_attribution?.turn_id;
      }
      if (event.type === "session_meta") meta = event.payload ?? {};
    } catch {
      // An unreadable line cannot provide settings.
    }
  }
  return {
    sessionId: meta.session_id ?? meta.id,
    turnId: context.turn_id,
    completedTurnId,
    turnContextCount,
    model: context.model ?? "UNKNOWN",
    effort: context.effort ?? context.reasoning_effort ?? "UNKNOWN",
    sandbox: context.sandbox_policy ?? context.sandbox ?? "UNKNOWN",
    cwd: context.cwd ?? "UNKNOWN",
    modelProvider: meta.model_provider ?? "UNKNOWN",
  };
}

export function normalizeSandbox(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.type === "string") return value.type;
  return "UNKNOWN";
}

function normalizePath(value, platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  let normalized = paths.normalize(value.replaceAll("\\", "/")).replaceAll("\\", "/");
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function evaluateExecOutcome({ requested, exitCode, timedOut, events, effective, platform = process.platform }) {
  const indeterminate = code => ({ status: "INDETERMINATE", code, retryAllowed: false });
  if (timedOut) return indeterminate("TIMEOUT");
  if (events?.malformed) return indeterminate("MALFORMED_OUTPUT");
  if (!events || !["completed", "failed"].includes(events.terminal)) return indeterminate("NO_TERMINAL_EVENT");
  if (typeof events.threadId !== "string" || !events.threadId ||
      typeof effective?.sessionId !== "string" || !effective.sessionId) return indeterminate("THREAD_BINDING_UNKNOWN");
  if (events.threadId !== effective.sessionId) return indeterminate("THREAD_BINDING_MISMATCH");
  if (typeof effective.turnId !== "string" || !effective.turnId ||
      typeof effective.completedTurnId !== "string" || !effective.completedTurnId) {
    return indeterminate("TURN_BINDING_UNKNOWN");
  }
  if (effective.turnId !== effective.completedTurnId) return indeterminate("TURN_BINDING_MISMATCH");
  const sandbox = normalizeSandbox(effective?.sandbox);
  const settings = [effective?.model, effective?.effort, sandbox, effective?.cwd, effective?.modelProvider];
  if (settings.some(value => typeof value !== "string" || !value || value === "UNKNOWN")) {
    return indeterminate("EFFECTIVE_SETTINGS_UNKNOWN");
  }
  if (effective.model !== requested.model) return indeterminate("MODEL_MISMATCH");
  if (effective.effort !== requested.effort) return indeterminate("EFFORT_MISMATCH");
  if (sandbox !== requested.sandbox) return indeterminate("SANDBOX_MISMATCH");
  if (typeof requested.cwd !== "string" || normalizePath(effective.cwd,
    platform) !== normalizePath(requested.cwd, platform)) {
    return indeterminate("CWD_MISMATCH");
  }
  if (effective.modelProvider !== (requested.modelProvider ?? "openai")) {
    return indeterminate("MODEL_PROVIDER_MISMATCH");
  }
  if (events.terminal === "completed" && exitCode == null) return indeterminate("EXIT_UNKNOWN");
  if (events.terminal === "failed" || exitCode !== 0) return { status: "FAILED", retryAllowed: false };
  if (events.usage == null) return indeterminate("USAGE_EVIDENCE_MISSING");
  if (!isValidUsage(events.usage)) return indeterminate("USAGE_EVIDENCE_INVALID");
  return { status: "SUCCEEDED" };
}
