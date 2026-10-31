import fs from "node:fs";
import {
  publishUserLocalStateAtomically,
  readUserLocalState,
  resolveUserLocalStateLocation,
  UserLocalStateError,
  withPhysicalStateLock,
} from "./user-local-state.mjs";

const FAILURE_FILE = "diagnostics/hook-failures.json";
const MAX_FAILURES = 100;
const TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const RUNTIMES = new Set(["claude", "codex", "unknown"]);

/**
 * Record only stable, non-sensitive Hook failure metadata in the Harness
 * clone/worktree's user-local state. Prompt text, stderr, and paths are omitted.
 */
export function appendHookFailure(cwd, runtime, eventName, errorCode) {
  const normalizedRuntime = RUNTIMES.has(runtime) ? runtime : "unknown";
  const normalizedEventName = typeof eventName === "string" ? eventName.toLowerCase() : "";
  if (!TOKEN_PATTERN.test(normalizedEventName)
    || typeof errorCode !== "string" || !TOKEN_PATTERN.test(errorCode)) {
    return Object.freeze({ persisted: false, errorCode: "hook_failure_metadata_invalid" });
  }

  try {
    const location = resolveUserLocalStateLocation(cwd, FAILURE_FILE);
    return withPhysicalStateLock(location, () => {
      const text = readUserLocalState(location);
      const state = text === null ? { version: 1, failures: [] } : parseFailureState(text);
      state.failures.unshift({
        ts: new Date().toISOString(),
        runtime: normalizedRuntime,
        event_name: normalizedEventName,
        error_code: errorCode,
      });
      state.failures = state.failures.slice(0, MAX_FAILURES);
      publishUserLocalStateAtomically(location, `${JSON.stringify(state, null, 2)}\n`);
      return Object.freeze({ persisted: true, errorCode: null });
    });
  } catch (error) {
    return Object.freeze({
      persisted: false,
      errorCode: error instanceof UserLocalStateError ? error.code : "state_write_failed",
    });
  }
}

function parseFailureState(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new UserLocalStateError("state_primary_corrupt", "Hook failure state JSON is malformed.", error);
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.failures)) {
    throw new UserLocalStateError("state_primary_corrupt", "Hook failure state schema is invalid.");
  }
  for (const entry of parsed.failures) {
    if (!entry || typeof entry.ts !== "string" || !Number.isFinite(Date.parse(entry.ts))
      || !RUNTIMES.has(entry.runtime)
      || typeof entry.event_name !== "string" || !TOKEN_PATTERN.test(entry.event_name)
      || typeof entry.error_code !== "string" || !TOKEN_PATTERN.test(entry.error_code)) {
      throw new UserLocalStateError("state_primary_corrupt", "Hook failure state contains an invalid entry.");
    }
  }
  return { version: 1, failures: parsed.failures };
}
