import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  appendAutomationCandidate,
  claimWorkStartSuggestion,
  getWorkStartExecutionStatus,
  rememberWorkStartExecution,
} from "./lib/work-start-execution-state.mjs";
import { appendHookFailure } from "./lib/hook-failure-state.mjs";
import {
  publishUserLocalStateAtomically,
  readUserLocalState,
  resolveUserLocalStateLocation,
  resolveUserLocalStateRoot,
  UserLocalStateError,
  withPhysicalStateLock,
} from "./lib/user-local-state.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-ai-user-local-state."));
const repository = path.join(temporaryRoot, "repository");
const separateClone = path.join(temporaryRoot, "clone");
const separateWorktree = path.join(temporaryRoot, "worktree");
const stateRoot = path.join(temporaryRoot, "state-root");
process.env.OH_MY_AI_STATE_ROOT = stateRoot;

try {
  setupGitFixture();
  verifyIdentityIsolation();
  verifyWorkStartStateCompatibility();
  verifyHookFailureState();
  verifyAtomicPublicationAndPermissions();
  await verifyCrossProcessLocking();
  verifyLegacySymlinkHandling();
  await verifyCrashRecovery();
  verifyUnverifiableLockFailsClosed();
  console.log("passed: user-local state identity, publication, locking, crash recovery, and failure semantics");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function setupGitFixture() {
  fs.mkdirSync(repository);
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "fixture"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "--quiet", "-m", "fixture"]);
  git(temporaryRoot, ["clone", "--quiet", "--local", repository, separateClone]);
  git(repository, ["worktree", "add", "--quiet", "-b", "isolated-worktree", separateWorktree]);
}

function verifyIdentityIsolation() {
  const main = resolveUserLocalStateLocation(repository, "probe.json");
  const worktree = resolveUserLocalStateLocation(separateWorktree, "probe.json");
  const clone = resolveUserLocalStateLocation(separateClone, "probe.json");
  assert.equal(main.repositoryId, worktree.repositoryId, "Git worktrees share a repository-instance namespace");
  assert.notEqual(main.worktreeId, worktree.worktreeId, "Git worktrees get separate state namespaces");
  assert.notEqual(main.repositoryId, clone.repositoryId, "separate clones get separate repository-instance namespaces");
  assert.notEqual(main.worktreeId, clone.worktreeId, "separate clones get separate worktree namespaces");
  assert.ok(path.relative(repository, main.filePath).startsWith(".."), "state must be outside Product tree");

  const originalWorktreeId = main.worktreeId;
  git(repository, ["checkout", "--quiet", "-b", "branch-switch"]);
  assert.equal(resolveUserLocalStateLocation(repository, "probe.json").worktreeId, originalWorktreeId,
    "state identity remains stable across branch switches");

  expectStateError(
    () => resolveUserLocalStateLocation(repository, "probe.json", { stateRootOverride: path.join(repository, ".state") }),
    "state_path_unsafe",
  );
  assert.equal(resolveUserLocalStateRoot({ env: { XDG_STATE_HOME: path.join(temporaryRoot, "xdg-state") } }),
    path.join(temporaryRoot, "xdg-state", "oh-my-ai"), "XDG state home selects the app state directory");
  assert.equal(resolveUserLocalStateRoot({ env: {}, homeDirectory: path.join(temporaryRoot, "home") }),
    path.join(temporaryRoot, "home", ".local", "state", "oh-my-ai"), "home fallback uses the user-local state root");
  expectStateError(() => resolveUserLocalStateRoot({ stateRootOverride: "relative-state-root" }), "state_root_invalid");
  const realStateRoot = path.join(temporaryRoot, "real-state-root");
  fs.mkdirSync(realStateRoot);
  const linkedStateRoot = path.join(temporaryRoot, "linked-state-root");
  fs.symlinkSync(realStateRoot, linkedStateRoot);
  expectStateError(() => resolveUserLocalStateRoot({ stateRootOverride: linkedStateRoot }), "state_path_unsafe");
}

function verifyAtomicPublicationAndPermissions() {
  const location = resolveUserLocalStateLocation(repository, "atomic/value.json");
  publishUserLocalStateAtomically(location, '{"value":"complete"}\n');
  assert.equal(readUserLocalState(location), '{"value":"complete"}\n');
  const mode = fs.statSync(location.filePath).mode & 0o777;
  assert.equal(mode, 0o600, "state files are owner-only");
  assert.equal(fs.statSync(location.directoryPath).mode & 0o777, 0o700, "state directories are owner-only");

  fs.chmodSync(location.filePath, 0o644);
  expectStateError(() => readUserLocalState(location), "state_permissions_unsafe");
  fs.chmodSync(location.filePath, 0o600);

  const unsafeRoot = path.join(temporaryRoot, "unsafe-root");
  fs.mkdirSync(unsafeRoot, { mode: 0o755 });
  fs.chmodSync(unsafeRoot, 0o755);
  const unsafeLocation = resolveUserLocalStateLocation(repository, "value.json", { stateRootOverride: unsafeRoot });
  expectStateError(() => publishUserLocalStateAtomically(unsafeLocation, "must not mutate shared root"),
    "state_permissions_unsafe");
  assert.equal(fs.statSync(unsafeRoot).mode & 0o777, 0o755,
    "an explicit override with broad permissions is rejected without changing the directory");
}

function verifyWorkStartStateCompatibility() {
  const legacyDirectory = path.join(repository, ".oh-my-ai", "state");
  fs.mkdirSync(legacyDirectory, { recursive: true });
  const legacyExecutionPath = path.join(legacyDirectory, "work-start-execution-state.json");
  const legacyTask = "legacy execution task";
  const legacySession = "legacy session identifier";
  const legacyEntry = {
    runtime: "claude",
    task_hash: sha256(legacyTask),
    session_hash: sha256(legacySession),
    executed_at: new Date().toISOString(),
  };
  assert.deepEqual(rememberWorkStartExecution(repository, "claude", "", legacyTask), {
    persisted: false,
    errorCode: null,
  }, "missing session correlation is an expected persistence no-op");
  const legacyExecutionText = `${JSON.stringify({ version: 3, executions: [legacyEntry] }, null, 2)}\n`;
  fs.writeFileSync(legacyExecutionPath, legacyExecutionText);
  assert.deepEqual(getWorkStartExecutionStatus(repository, "claude", legacySession, legacyTask), {
    recent: true,
    errorCode: null,
  }, "legacy execution markers remain readable");
  const executionWrite = rememberWorkStartExecution(repository, "claude", legacySession, legacyTask);
  assert.equal(executionWrite.persisted, true, "valid legacy execution state migrates on write");
  assert.equal(fs.readFileSync(legacyExecutionPath, "utf8"), legacyExecutionText, "migration leaves legacy state untouched");
  const executionPrimary = resolveUserLocalStateLocation(repository, "work-start/execution.json");
  const executionPrimaryText = readUserLocalState(executionPrimary);
  assert.ok(JSON.parse(executionPrimaryText).legacy_snapshot_sha256, "migrated primary tracks the legacy snapshot");
  assert.ok(!executionPrimaryText.includes(legacyTask) && !executionPrimaryText.includes(legacySession),
    "execution state contains hashes rather than task or session text");
  fs.chmodSync(executionPrimary.filePath, 0o644);
  assert.equal(getWorkStartExecutionStatus(repository, "claude", legacySession, legacyTask).errorCode,
    "state_permissions_unsafe", "work-start consumers receive permission failures explicitly");
  assert.equal(rememberWorkStartExecution(repository, "claude", legacySession, legacyTask).errorCode,
    "state_permissions_unsafe", "work-start writes do not replace a permissive primary");
  fs.chmodSync(executionPrimary.filePath, 0o600);

  const changedLegacy = JSON.parse(legacyExecutionText);
  changedLegacy.executions.push({
    runtime: "codex",
    task_hash: sha256("external legacy edit"),
    session_hash: sha256("another session"),
    executed_at: new Date().toISOString(),
  });
  fs.writeFileSync(legacyExecutionPath, `${JSON.stringify(changedLegacy, null, 2)}\n`);
  const conflict = getWorkStartExecutionStatus(repository, "claude", legacySession, legacyTask);
  assert.equal(conflict.errorCode, "state_legacy_conflict", "diverged legacy state is surfaced explicitly");
  assert.equal(conflict.recent, false, "execution suppression fails open on a state conflict");

  const legacySuggestionPath = path.join(legacyDirectory, "work-start-suggestions.json");
  const legacySuggestionText = `${JSON.stringify({
    updated_at: new Date().toISOString(),
    suggested_prompt_hashes: [],
  }, null, 2)}\n`;
  fs.writeFileSync(legacySuggestionPath, legacySuggestionText);
  const suggestionHash = sha256("suggestion prompt");
  const firstClaim = claimWorkStartSuggestion(repository, "claude", suggestionHash);
  assert.equal(firstClaim.claimed, true, "legacy suggestion state migrates and claims atomically");
  assert.equal(fs.readFileSync(legacySuggestionPath, "utf8"), legacySuggestionText, "suggestion migration keeps legacy bytes unchanged");
  const suggestionPrimary = resolveUserLocalStateLocation(repository, "work-start/suggestions.json");
  const suggestionPrimaryBeforeConflict = readUserLocalState(suggestionPrimary);
  assert.ok(JSON.parse(suggestionPrimaryBeforeConflict).legacy_snapshot_sha256, "suggestion primary tracks its legacy snapshot");

  const changedSuggestions = JSON.parse(legacySuggestionText);
  changedSuggestions.suggested_prompt_hashes.push(sha256("legacy concurrent edit"));
  fs.writeFileSync(legacySuggestionPath, `${JSON.stringify(changedSuggestions, null, 2)}\n`);
  const suggestionConflict = claimWorkStartSuggestion(repository, "claude", sha256("another prompt"));
  assert.equal(suggestionConflict.errorCode, "state_legacy_conflict", "diverged suggestion state reports conflict");
  assert.equal(readUserLocalState(suggestionPrimary), suggestionPrimaryBeforeConflict,
    "conflict does not silently overwrite the user-local primary");

  const corruptPrimaryText = "{ malformed user-local state\n";
  publishUserLocalStateAtomically(suggestionPrimary, corruptPrimaryText);
  const corruptClaim = claimWorkStartSuggestion(repository, "claude", sha256("corruption check"));
  assert.equal(corruptClaim.errorCode, "state_primary_corrupt", "corrupt user-local state is explicit");
  assert.equal(readUserLocalState(suggestionPrimary), corruptPrimaryText, "corrupt primary is preserved, never reset");

  const legacyCandidatePath = path.join(legacyDirectory, "automation-candidates.log");
  const rawLegacyPrompt = "private legacy prompt that should not be copied";
  const legacyCandidateLine = `${JSON.stringify({ ts: new Date().toISOString(), source: "old-hook", signal: "toil", prompt: rawLegacyPrompt })}\n`;
  fs.writeFileSync(legacyCandidatePath, legacyCandidateLine);
  const rawNewPrompt = "new private prompt should only be hashed";
  assert.equal(appendAutomationCandidate(repository, rawNewPrompt).persisted, true,
    "legacy candidate log is read and converted during append");
  const candidatePrimary = resolveUserLocalStateLocation(repository, "automation/candidates.json");
  const candidateText = readUserLocalState(candidatePrimary);
  assert.ok(!candidateText.includes(rawLegacyPrompt) && !candidateText.includes(rawNewPrompt),
    "candidate persistence stores only prompt hashes");
  assert.equal(fs.readFileSync(legacyCandidatePath, "utf8"), legacyCandidateLine,
    "candidate migration does not rewrite or delete legacy log");
  fs.appendFileSync(legacyCandidatePath, `${JSON.stringify({ ts: new Date().toISOString(), prompt: "later legacy edit" })}\n`);
  const candidateConflict = appendAutomationCandidate(repository, "another new prompt");
  assert.equal(candidateConflict.errorCode, "state_legacy_conflict", "legacy candidate divergence fails closed for writes");
  assert.equal(readUserLocalState(candidatePrimary), candidateText, "candidate conflict preserves prior primary state");

}

function verifyLegacySymlinkHandling() {
  const externalLegacyDirectory = path.join(temporaryRoot, "symlinked-legacy-state");
  fs.mkdirSync(externalLegacyDirectory);
  const cloneHarnessDirectory = path.join(separateClone, ".oh-my-ai");
  fs.mkdirSync(cloneHarnessDirectory);
  fs.symlinkSync(externalLegacyDirectory, path.join(cloneHarnessDirectory, "state"));
  assert.equal(getWorkStartExecutionStatus(separateClone, "claude", "session", "task").errorCode,
    "state_legacy_unsafe", "legacy state symlinks fail open with an explicit code");
  const symlinkWrite = rememberWorkStartExecution(separateClone, "claude", "session", "task");
  assert.equal(symlinkWrite.errorCode, "state_legacy_unsafe", "writes do not follow legacy state symlinks");
  assert.deepEqual(fs.readdirSync(externalLegacyDirectory), [], "legacy symlink target is never written");
}

function verifyHookFailureState() {
  const previousRoot = process.env.OH_MY_AI_STATE_ROOT;
  const previousXdgStateHome = process.env.XDG_STATE_HOME;
  const legacyXdgStateHome = path.join(temporaryRoot, "legacy-hook-xdg");
  const legacyRoot = path.join(legacyXdgStateHome, "oh-my-ai");
  fs.mkdirSync(legacyXdgStateHome, { mode: 0o700 });
  fs.mkdirSync(legacyRoot, { mode: 0o755 });
  fs.chmodSync(legacyRoot, 0o755);
  const legacyLogPath = path.join(legacyRoot, "hook-failures.log");
  const legacyLogText = '{"legacy":"diagnostic"}\n';
  fs.writeFileSync(legacyLogPath, legacyLogText, { mode: 0o644 });
  delete process.env.OH_MY_AI_STATE_ROOT;
  process.env.XDG_STATE_HOME = legacyXdgStateHome;

  try {
    assert.equal(appendHookFailure(repository, "claude", "UserPromptSubmit", "hook_child_eperm").persisted, true,
      "hook diagnostics use the physical user-local state API");
    assert.equal(fs.statSync(legacyRoot).mode & 0o777, 0o700,
      "a preexisting current-user-owned state root is tightened before use");
    assert.equal(fs.readFileSync(legacyLogPath, "utf8"), legacyLogText,
      "legacy hook log remains read-only during migration");
    const location = resolveUserLocalStateLocation(repository, "diagnostics/hook-failures.json", {
      env: { XDG_STATE_HOME: legacyXdgStateHome },
    });
    const primaryText = readUserLocalState(location);
    const primary = JSON.parse(primaryText);
    assert.equal(primary.failures[0].event_name, "userpromptsubmit");
    assert.equal(primary.failures[0].error_code, "hook_child_eperm");
    assert.ok(!primaryText.includes("legacy diagnostic") && !primaryText.includes("stderr")
      && !fs.existsSync(path.join(repository, ".oh-my-ai", "state", "hook-failures.log")),
    "hook failure state omits raw diagnostics and Product-tree fallback writes");

    const corrupt = "{ malformed diagnostics\n";
    publishUserLocalStateAtomically(location, corrupt);
    assert.equal(appendHookFailure(repository, "claude", "UserPromptSubmit", "hook_child_eperm").errorCode,
      "state_primary_corrupt", "corrupt diagnostic state is not overwritten");
    assert.equal(readUserLocalState(location), corrupt, "corrupt hook state remains intact");
  } finally {
    if (previousRoot === undefined) delete process.env.OH_MY_AI_STATE_ROOT;
    else process.env.OH_MY_AI_STATE_ROOT = previousRoot;
    if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousXdgStateHome;
  }
}

async function verifyCrossProcessLocking() {
  const location = resolveUserLocalStateLocation(repository, "concurrent/counter.json");
  publishUserLocalStateAtomically(location, '{"counter":0}\n');
  const childSource = `
    import { readUserLocalState, resolveUserLocalStateLocation, withPhysicalStateLock, publishUserLocalStateAtomically } from ${JSON.stringify(new URL("./lib/user-local-state.mjs", import.meta.url).href)};
    const location = resolveUserLocalStateLocation(process.cwd(), "concurrent/counter.json");
    for (let i = 0; i < 15; i += 1) {
      withPhysicalStateLock(location, () => {
        const state = JSON.parse(readUserLocalState(location));
        state.counter += 1;
        publishUserLocalStateAtomically(location, JSON.stringify(state) + "\\n");
      });
    }
  `;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    cwd: repository,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const outcomes = await Promise.all(children.map(async child => {
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    const [code, signal] = await once(child, "close");
    return { code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  }));
  for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.stderr || outcome.stdout || `child exited ${outcome.signal}`);
  assert.equal(JSON.parse(readUserLocalState(location)).counter, 60,
    "independent processes serialize read-modify-publish without lost updates");

  const promptHash = sha256("simultaneous suggestion");
  const claimSource = `
    import fs from "node:fs";
    import { claimWorkStartSuggestion } from ${JSON.stringify(new URL("./lib/work-start-execution-state.mjs", import.meta.url).href)};
    const claim = claimWorkStartSuggestion(process.cwd(), "claude", ${JSON.stringify(promptHash)});
  `;
  const claimOutputPaths = Array.from({ length: 6 }, (_, index) => path.join(temporaryRoot, `claim-${index}.json`));
  const claimChildren = claimOutputPaths.map(outputPath => spawn(process.execPath, ["--input-type=module", "-e",
    `${claimSource}\nfs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(claim));`], {
      cwd: separateClone,
      env: process.env,
      stdio: "ignore",
    }));
  const claimResults = await Promise.all(claimChildren.map(async child => {
    const [code] = await once(child, "close");
    return { code };
  }));
  for (const outcome of claimResults) assert.equal(outcome.code, 0, "suggestion claimant exits successfully");
  const claimOutcomes = claimOutputPaths.map(filePath => JSON.parse(fs.readFileSync(filePath, "utf8")));
  assert.equal(claimOutcomes.filter(item => item.claimed).length, 1,
    "only one independent process claims a repeated Work-start suggestion");

  const held = resolveUserLocalStateLocation(repository, "concurrent/held.json");
  publishUserLocalStateAtomically(held, "{}\n");
  const readyFile = path.join(temporaryRoot, "lock-held.ready");
  const holderSource = `
    import fs from "node:fs";
    import { resolveUserLocalStateLocation, withPhysicalStateLock } from ${JSON.stringify(new URL("./lib/user-local-state.mjs", import.meta.url).href)};
    const location = resolveUserLocalStateLocation(process.cwd(), "concurrent/held.json");
    withPhysicalStateLock(location, () => { fs.writeFileSync(${JSON.stringify(readyFile)}, "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); });
  `;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", holderSource], {
    cwd: repository,
    env: process.env,
    stdio: "ignore",
  });
  await waitForFile(readyFile, holder);
  expectStateError(() => withPhysicalStateLock(held, () => {}, { timeoutMs: 100, retryIntervalMs: 5 }), "state_lock_timeout");
  const [holderCode] = await once(holder, "exit");
  assert.equal(holderCode, 0, "lock holder exits cleanly after release");
}

async function verifyCrashRecovery() {
  const location = resolveUserLocalStateLocation(repository, "crash/recovery.json");
  publishUserLocalStateAtomically(location, '{"ready":true}\n');
  const crashSource = `
    import { resolveUserLocalStateLocation, withPhysicalStateLock } from ${JSON.stringify(new URL("./lib/user-local-state.mjs", import.meta.url).href)};
    const location = resolveUserLocalStateLocation(process.cwd(), "crash/recovery.json");
    withPhysicalStateLock(location, () => process.exit(0));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", crashSource], {
    cwd: repository,
    env: process.env,
    stdio: "ignore",
  });
  const [childCode] = await once(child, "exit");
  assert.equal(childCode, 0, "crash fixture exits while holding the lock");
  const recovered = withPhysicalStateLock(location, () => readUserLocalState(location));
  assert.equal(recovered, '{"ready":true}\n', "next process reclaims a provably dead same-host lock");
}

function verifyUnverifiableLockFailsClosed() {
  const location = resolveUserLocalStateLocation(repository, "lock/unknown.json");
  publishUserLocalStateAtomically(location, "{}\n");
  const lockPath = `${location.filePath}.lock`;
  fs.writeFileSync(lockPath, "not-json\n", { mode: 0o600 });
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(lockPath, old, old);
  expectStateError(() => withPhysicalStateLock(location, () => {}), "state_lock_owner_unknown");
  fs.unlinkSync(lockPath);
}

async function waitForFile(filePath, child) {
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(filePath)) {
    if (child.exitCode !== null) throw new Error(`lock holder exited before acquisition (${child.exitCode})`);
    if (Date.now() > deadline) throw new Error("timed out waiting for physical lock acquisition");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function expectStateError(callback, code) {
  assert.throws(callback, error => error instanceof UserLocalStateError && error.code === code,
    `expected user-local state error ${code}`);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
