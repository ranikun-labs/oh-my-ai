import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  publishUserLocalStateAtomically,
  readUserLocalState,
  resolveUserLocalStateLocation,
  UserLocalStateError,
  withPhysicalStateLock,
} from "./user-local-state.mjs";

const EXECUTION_FILE = "work-start/execution.json";
const SUGGESTION_FILE = "work-start/suggestions.json";
const CANDIDATE_FILE = "automation/candidates.json";
const EXECUTION_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 20;
const MAX_SUGGESTIONS = 100;
const MAX_CANDIDATES = 200;
const SUPPORTED_RUNTIMES = new Set(["claude", "codex"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/** Persist an Engine completion marker; failure never changes Engine success. */
export function rememberWorkStartExecution(cwd, runtime, sessionId, task) {
  const normalizedRuntime = normalizeRuntime(runtime);
  const normalizedTask = normalizeText(task);
  const normalizedSession = normalizeText(sessionId);
  // Sessions without a reliable adapter correlation key are intentionally
  // not persisted; this is an expected no-op, not a storage failure.
  if (!normalizedRuntime || !normalizedSession) return result(false, null);
  if (!normalizedTask) return result(false, "work_start_execution_context_invalid");

  try {
    const location = stateLocation(cwd, EXECUTION_FILE);
    const legacyPath = legacyPathFor(cwd, "work-start-execution-state.json");
    return withPhysicalStateLock(location, () => {
      const composite = readCompositeState(location, legacyPath, "execution");
      const now = Date.now();
      composite.state.executions.unshift({
        runtime: normalizedRuntime,
        task_hash: hash(normalizedTask),
        session_hash: hash(normalizedSession),
        executed_at: new Date(now).toISOString(),
      });
      composite.state.executions = composite.state.executions.slice(0, MAX_ENTRIES);
      publishUserLocalStateAtomically(location, serializeState(composite.state));
      return result(true, null);
    });
  } catch (error) {
    return result(false, errorCode(error, "state_write_failed"));
  }
}

/**
 * Return a fail-open suppression status. A missing/corrupt state never blocks
 * prompt routing, and every storage error is reported using a sanitized code.
 */
export function getWorkStartExecutionStatus(cwd, runtime, sessionId, prompt) {
  const normalizedRuntime = normalizeRuntime(runtime);
  const normalizedPrompt = normalizeText(prompt);
  const normalizedSession = normalizeText(sessionId);
  if (!normalizedRuntime || !normalizedPrompt || !normalizedSession) {
    return Object.freeze({ recent: false, errorCode: null });
  }

  try {
    const location = stateLocation(cwd, EXECUTION_FILE);
    const composite = readCompositeState(
      location,
      legacyPathFor(cwd, "work-start-execution-state.json"),
      "execution",
    );
    const now = Date.now();
    const promptHash = hash(normalizedPrompt);
    const sessionHash = hash(normalizedSession);
    const recent = composite.state.executions.some(entry => (
      entry.runtime === normalizedRuntime
      && entry.task_hash === promptHash
      && entry.session_hash === sessionHash
      && now - Date.parse(entry.executed_at) >= 0
      && now - Date.parse(entry.executed_at) <= EXECUTION_TTL_MS
    ));
    return Object.freeze({ recent, errorCode: null });
  } catch (error) {
    return Object.freeze({ recent: false, errorCode: errorCode(error, "state_read_failed") });
  }
}

/** Boolean compatibility wrapper retained for existing internal consumers. */
export function hasRecentWorkStartExecution(cwd, runtime, sessionId, prompt) {
  return getWorkStartExecutionStatus(cwd, runtime, sessionId, prompt).recent;
}

/**
 * Atomically claim a once-per-prompt suggestion under a physical lock.
 * Only a SHA-256 prompt digest is persisted; prompt text never enters state.
 */
export function claimWorkStartSuggestion(cwd, runtime, promptHash) {
  const normalizedRuntime = normalizeRuntime(runtime);
  if (!normalizedRuntime || typeof promptHash !== "string" || !HASH_PATTERN.test(promptHash)) {
    return result(false, "work_start_suggestion_context_invalid", { claimed: false });
  }

  try {
    const location = stateLocation(cwd, SUGGESTION_FILE);
    const legacyPath = legacyPathFor(cwd, "work-start-suggestions.json");
    return withPhysicalStateLock(location, () => {
      const composite = readCompositeState(location, legacyPath, "suggestion");
      const keys = suggestionKeys(normalizedRuntime, promptHash);
      if (keys.some(key => composite.state.suggested_prompt_hashes.includes(key))) {
        return Object.freeze({ claimed: false, persisted: true, errorCode: null });
      }
      composite.state.suggested_prompt_hashes = [
        keys[0],
        ...composite.state.suggested_prompt_hashes.filter(key => key !== keys[0]),
      ].slice(0, MAX_SUGGESTIONS);
      composite.state.updated_at = new Date().toISOString();
      publishUserLocalStateAtomically(location, serializeState(composite.state));
      return Object.freeze({ claimed: true, persisted: true, errorCode: null });
    });
  } catch (error) {
    return result(false, errorCode(error, "state_write_failed"), { claimed: false });
  }
}

/** Store a hash-only toil candidate in the external state root. */
export function appendAutomationCandidate(cwd, prompt) {
  const normalizedPrompt = normalizeText(prompt);
  if (!normalizedPrompt) return result(false, "automation_candidate_context_invalid");

  try {
    const location = stateLocation(cwd, CANDIDATE_FILE);
    const legacyPath = legacyPathFor(cwd, "automation-candidates.log");
    return withPhysicalStateLock(location, () => {
      const composite = readCandidateState(location, legacyPath);
      composite.state.candidates.unshift({
        ts: new Date().toISOString(),
        source: "prompt-routing-hook",
        signal: "toil",
        prompt_hash: hash(normalizedPrompt),
      });
      composite.state.candidates = composite.state.candidates.slice(0, MAX_CANDIDATES);
      publishUserLocalStateAtomically(location, serializeState(composite.state));
      return result(true, null);
    });
  } catch (error) {
    return result(false, errorCode(error, "state_write_failed"));
  }
}

function stateLocation(cwd, relativePath) {
  return resolveUserLocalStateLocation(cwd, relativePath);
}

function legacyPathFor(cwd, fileName) {
  const root = targetRepositoryRoot(cwd);
  if (!root) throw new UserLocalStateError("repository_identity_unavailable", "A Git repository is required.");
  return path.join(root, ".oh-my-ai", "state", fileName);
}

function targetRepositoryRoot(cwd) {
  let result;
  try {
    result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    throw new UserLocalStateError("repository_identity_unavailable", "Git repository identity is unavailable.", error);
  }
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new UserLocalStateError("repository_identity_unavailable", "Git repository identity is unavailable.", result.error);
  }
  return fs.realpathSync(result.stdout.trim());
}

function readCompositeState(location, legacyPath, kind) {
  const primaryText = readUserLocalState(location);
  const legacyText = readLegacyText(legacyPath);
  const primary = primaryText === null ? null : parseState(primaryText, kind, false);
  const legacy = legacyText === null ? null : parseState(legacyText, kind, true);

  if (primary && legacy) {
    const legacyHash = hash(canonicalState(legacy.state, kind));
    const primaryHash = hash(canonicalState(primary.state, kind));
    if (primary.state.legacy_snapshot_sha256) {
      if (primary.state.legacy_snapshot_sha256 !== legacyHash) {
        throw new UserLocalStateError("state_legacy_conflict", "Legacy and user-local state have diverged.");
      }
    } else if (primaryHash !== legacyHash) {
      throw new UserLocalStateError("state_legacy_conflict", "Legacy and user-local state disagree without a migration marker.");
    }
    return { state: primary.state };
  }
  if (primary) return { state: primary.state };
  if (legacy) {
    legacy.state.legacy_snapshot_sha256 = hash(canonicalState(legacy.state, kind));
    return { state: legacy.state };
  }
  return { state: emptyState(kind) };
}

function parseState(text, kind, legacy) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new UserLocalStateError(legacy ? "state_legacy_corrupt" : "state_primary_corrupt", "State JSON is malformed.", error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UserLocalStateError(legacy ? "state_legacy_corrupt" : "state_primary_corrupt", "State payload must be a JSON object.");
  }

  if (kind === "execution") {
    if (![1, 3].includes(parsed.version) || !Array.isArray(parsed.executions)) {
      throw new UserLocalStateError(legacy ? "state_legacy_corrupt" : "state_primary_corrupt", "Execution state schema is invalid.");
    }
    const executions = parsed.executions.map(entry => {
      if (!entry || !SUPPORTED_RUNTIMES.has(entry.runtime)
        || typeof entry.task_hash !== "string" || !HASH_PATTERN.test(entry.task_hash)
        || typeof entry.session_hash !== "string" || !HASH_PATTERN.test(entry.session_hash)
        || typeof entry.executed_at !== "string" || !Number.isFinite(Date.parse(entry.executed_at))) {
        throw new UserLocalStateError(legacy ? "state_legacy_corrupt" : "state_primary_corrupt", "Execution state contains an invalid entry.");
      }
      return {
        runtime: entry.runtime,
        task_hash: entry.task_hash,
        session_hash: entry.session_hash,
        executed_at: new Date(Date.parse(entry.executed_at)).toISOString(),
      };
    });
    return { state: { version: 1, executions, ...legacyMarker(parsed) } };
  }

  if (kind === "suggestion") {
    if (![1, 2].includes(parsed.version ?? 1) || !Array.isArray(parsed.suggested_prompt_hashes)
      || parsed.suggested_prompt_hashes.some(value => typeof value !== "string" || !/^(?:(?:claude|codex):)?[a-f0-9]{64}$/.test(value))) {
      throw new UserLocalStateError(legacy ? "state_legacy_corrupt" : "state_primary_corrupt", "Suggestion state schema is invalid.");
    }
    const state = {
      version: 1,
      suggested_prompt_hashes: [...new Set(parsed.suggested_prompt_hashes)],
      updated_at: typeof parsed.updated_at === "string" && Number.isFinite(Date.parse(parsed.updated_at))
        ? new Date(Date.parse(parsed.updated_at)).toISOString()
        : new Date(0).toISOString(),
      ...legacyMarker(parsed),
    };
    return { state };
  }

  throw new UserLocalStateError("state_schema_unknown", "Unknown state kind.");
}

function readCandidateState(location, legacyPath) {
  const primaryText = readUserLocalState(location);
  const legacyText = readLegacyText(legacyPath);
  const primary = primaryText === null ? null : parseCandidateState(primaryText, false);
  const legacy = legacyText === null ? null : parseLegacyCandidates(legacyText);
  if (primary && legacy) {
    const legacyHash = legacy.snapshotHash;
    const primaryHash = hash(JSON.stringify(primary.candidates));
    if (primary.legacy_snapshot_sha256
      ? primary.legacy_snapshot_sha256 !== legacyHash
      : primaryHash !== hash(JSON.stringify(legacy.candidates.slice(0, MAX_CANDIDATES)))) {
      throw new UserLocalStateError("state_legacy_conflict", "Legacy and user-local automation candidates have diverged.");
    }
    return { state: primary };
  }
  if (primary) return { state: primary };
  if (legacy) {
    return {
      state: {
        version: 1,
        candidates: legacy.candidates.slice(0, MAX_CANDIDATES),
        legacy_snapshot_sha256: legacy.snapshotHash,
      },
    };
  }
  return { state: { version: 1, candidates: [] } };
}

function parseCandidateState(text, legacy) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new UserLocalStateError(legacy ? "state_legacy_corrupt" : "state_primary_corrupt", "Automation candidate state JSON is malformed.", error);
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.candidates)) {
    throw new UserLocalStateError(legacy ? "state_legacy_corrupt" : "state_primary_corrupt", "Automation candidate state schema is invalid.");
  }
  for (const candidate of parsed.candidates) {
    if (!candidate || typeof candidate.prompt_hash !== "string" || !HASH_PATTERN.test(candidate.prompt_hash)
      || typeof candidate.ts !== "string" || !Number.isFinite(Date.parse(candidate.ts))) {
      throw new UserLocalStateError(legacy ? "state_legacy_corrupt" : "state_primary_corrupt", "Automation candidate state contains an invalid entry.");
    }
  }
  return {
    version: 1,
    candidates: parsed.candidates.map(candidate => ({
      ts: new Date(Date.parse(candidate.ts)).toISOString(),
      source: "prompt-routing-hook",
      signal: "toil",
      prompt_hash: candidate.prompt_hash,
    })),
    ...legacyMarker(parsed),
  };
}

function parseLegacyCandidates(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const candidates = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch (error) {
      throw new UserLocalStateError("state_legacy_corrupt", "Legacy automation candidate log contains malformed JSON.", error);
    }
    if (!entry || typeof entry.prompt !== "string" || typeof entry.ts !== "string" || !Number.isFinite(Date.parse(entry.ts))) {
      throw new UserLocalStateError("state_legacy_corrupt", "Legacy automation candidate log contains an invalid entry.");
    }
    const prompt = normalizeText(entry.prompt);
    if (prompt) candidates.push({
      ts: new Date(Date.parse(entry.ts)).toISOString(),
      source: "prompt-routing-hook",
      signal: typeof entry.signal === "string" ? entry.signal : "toil",
      prompt_hash: hash(prompt),
    });
  }
  return { candidates, snapshotHash: hash(JSON.stringify(candidates)) };
}

function readLegacyText(filePath) {
  for (const directory of [path.dirname(path.dirname(filePath)), path.dirname(filePath)]) {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new UserLocalStateError("state_legacy_unsafe", "Legacy state path contains a symbolic link or non-directory.");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof UserLocalStateError) throw error;
      throw new UserLocalStateError("state_legacy_read_failed", "Legacy state directory cannot be inspected.", error);
    }
  }

  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new UserLocalStateError("state_legacy_read_failed", "Legacy state cannot be inspected.", error);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new UserLocalStateError("state_legacy_unsafe", "Legacy state is not a regular file.");
  }
  try { return fs.readFileSync(filePath, "utf8"); } catch (error) {
    throw new UserLocalStateError("state_legacy_read_failed", "Legacy state cannot be read.", error);
  }
}

function legacyMarker(parsed) {
  if (parsed.legacy_snapshot_sha256 === undefined) return {};
  if (typeof parsed.legacy_snapshot_sha256 !== "string" || !HASH_PATTERN.test(parsed.legacy_snapshot_sha256)) {
    throw new UserLocalStateError("state_primary_corrupt", "Legacy migration marker is invalid.");
  }
  return { legacy_snapshot_sha256: parsed.legacy_snapshot_sha256 };
}

function emptyState(kind) {
  if (kind === "execution") return { version: 1, executions: [] };
  if (kind === "suggestion") return { version: 1, suggested_prompt_hashes: [], updated_at: new Date(0).toISOString() };
  throw new UserLocalStateError("state_schema_unknown", "Unknown state kind.");
}

function canonicalState(state, kind) {
  if (kind === "execution") return JSON.stringify(state.executions);
  if (kind === "suggestion") return JSON.stringify(state.suggested_prompt_hashes);
  return JSON.stringify(state);
}

function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function suggestionKeys(runtime, promptHash) {
  return runtime === "claude" ? [`claude:${promptHash}`, promptHash] : [`codex:${promptHash}`];
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeRuntime(value) {
  const runtime = String(value || "").trim();
  return SUPPORTED_RUNTIMES.has(runtime) ? runtime : "";
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function result(persisted, code, extra = {}) {
  return Object.freeze({ persisted, errorCode: code, ...extra });
}

function errorCode(error, fallback) {
  return error instanceof UserLocalStateError && typeof error.code === "string"
    ? error.code
    : fallback;
}
