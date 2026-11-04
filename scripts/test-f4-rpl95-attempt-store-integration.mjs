import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  f4PhysicalStateBindingFromLocation,
  sameF4PhysicalStateBinding,
} from "./lib/f4-physical-state-binding.mjs";
import {
  createPendingHandoffManualResumeAttemptOutcomeStoreAdapter,
} from "./lib/pending-handoff-manual-resume-attempt-outcome-store-adapter.mjs";
import {
  createPendingHandoffManualResumeAttemptOutcomeUserLocalRecordProvider,
} from "./lib/pending-handoff-manual-resume-attempt-outcome-user-local-provider.mjs";
import {
  createPendingHandoffManualResumeAttemptOutcomeService,
} from "./lib/pending-handoff-manual-resume-attempt-outcome.mjs";

const rpl95ModulePath = process.env.F4_RPL95_USER_LOCAL_STATE_MODULE;
const repositoryCwd = process.env.F4_TEST_REPOSITORY_CWD ?? process.cwd();
assert.equal(typeof rpl95ModulePath, "string", "pin the RPL-95 source module path");
assert.equal(path.isAbsolute(rpl95ModulePath), true, "the RPL-95 source module path must be absolute");
const childMode = process.env.F4_RPL95_ATTEMPT_WORKER_MODE ?? null;
const stateRoot = childMode === null
  ? fs.mkdtempSync(path.join(os.tmpdir(), "f4-rpl95-attempt-integration-"))
  : process.env.F4_RPL95_TEST_STATE_ROOT;
assert.equal(typeof stateRoot, "string", "the RPL-95 test state root must be set");
assert.equal(path.isAbsolute(stateRoot), true, "the RPL-95 test state root must be absolute");
const barrierDirectory = `${stateRoot}.process-race`;
const replacedRoot = `${stateRoot}.previous`;
const hostRecordPath = `${stateRoot}.host-binding.json`;

const rpl95 = await import(pathToFileURL(rpl95ModulePath).href);
let userLocalReads = 0;
const userLocalState = Object.freeze({
  resolveUserLocalStateLocation: rpl95.resolveUserLocalStateLocation,
  readUserLocalState(location) {
    userLocalReads += 1;
    return rpl95.readUserLocalState(location);
  },
  publishUserLocalStateAtomically: rpl95.publishUserLocalStateAtomically,
  withPhysicalStateLock: rpl95.withPhysicalStateLock,
});

if (childMode !== null) {
  await runAttemptWorker();
} else {
try {
  const identity = attemptIdentity("123e4567-e89b-42d3-a456-426614174000");
  const first = createAttemptService();
  const firstBinding = first.provider.readPhysicalStateBinding();
  assert.equal(firstBinding.ok, true, JSON.stringify(firstBinding));
  const reserved = await first.service.reserveAttempt({ identity });
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  const claimed = await first.service.bindClaim({
    identity,
    expected_attempt_revision: reserved.value.revision,
    claim_revision: 2,
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const unknown = await first.service.markDispatchStarted({
    identity,
    expected_attempt_revision: claimed.value.revision,
    claim_revision: 2,
  });
  assert.equal(unknown.ok, true, JSON.stringify(unknown));
  assert.equal(unknown.value.status, "dispatch_unknown");

  const physicalState = rpl95.resolveUserLocalStateLocation(
    repositoryCwd,
    "f4/manual-resume-attempts/attempt-" + "0".repeat(64) + ".json",
    { stateRootOverride: stateRoot },
  );
  const directBinding = f4PhysicalStateBindingFromLocation(physicalState);
  assert.equal(directBinding.ok, true, JSON.stringify(directBinding));
  assert.equal(sameF4PhysicalStateBinding(firstBinding.value, directBinding.value), true);

  const attemptDirectory = path.join(
    stateRoot,
    "repositories",
    firstBinding.value.repository_instance_id,
    "worktrees",
    firstBinding.value.physical_worktree_id,
    "f4",
    "manual-resume-attempts",
  );
  const recordFiles = fs.readdirSync(attemptDirectory);
  assert.equal(recordFiles.length, 1);
  assert.match(recordFiles[0], /^attempt-[a-f0-9]{64}\.json$/);
  const persisted = JSON.parse(fs.readFileSync(path.join(attemptDirectory, recordFiles[0]), "utf8"));
  assert.equal(persisted.value.status, "dispatch_unknown");

  fs.writeFileSync(hostRecordPath, JSON.stringify(firstBinding.value), { flag: "wx", mode: 0o600 });
  assert.equal(path.relative(stateRoot, hostRecordPath).startsWith(".."), true);

  const restarted = createAttemptService();
  const resumedRead = await restarted.service.readAttempt({
    candidate_id: identity.candidate_id,
    action_kind: identity.action_kind,
  });
  assert.equal(resumedRead.ok, true, JSON.stringify(resumedRead));
  assert.equal(resumedRead.value.status, "dispatch_unknown");
  assert.equal(resumedRead.value.attempt_id, identity.attempt_id);
  const freshAttempt = await restarted.service.reserveAttempt({
    identity: attemptIdentity("123e4567-e89b-42d3-a456-426614174001"),
  });
  assert.deepEqual(freshAttempt, { ok: false, reason: "manual_resume_attempt_recovery_required" });

  await verifyPhysicalLockProcessRace();

  const readsBeforeRootCheck = userLocalReads;
  fs.renameSync(stateRoot, replacedRoot);
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const afterRootReplacement = createAttemptService();
  const newBinding = afterRootReplacement.provider.readPhysicalStateBinding();
  assert.equal(newBinding.ok, true, JSON.stringify(newBinding));
  const independentlyRetainedHostBinding = JSON.parse(fs.readFileSync(hostRecordPath, "utf8"));
  assert.equal(newBinding.value.repository_instance_id, independentlyRetainedHostBinding.repository_instance_id);
  assert.equal(newBinding.value.physical_worktree_id, independentlyRetainedHostBinding.physical_worktree_id);
  assert.notEqual(newBinding.value.state_root_identity, independentlyRetainedHostBinding.state_root_identity);
  assert.equal(sameF4PhysicalStateBinding(independentlyRetainedHostBinding, newBinding.value), false);
  assert.equal(userLocalReads, readsBeforeRootCheck, "Host binding must reject the new root before Attempt read");

  process.stdout.write("F4/RPL-95 exact-source integration: PASS (UNKNOWN survives same-root restart; fresh Attempt blocked; replaced root mismatches the out-of-root Host binding fixture)\n");
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
  fs.rmSync(replacedRoot, { recursive: true, force: true });
  fs.rmSync(hostRecordPath, { force: true });
  fs.rmSync(barrierDirectory, { recursive: true, force: true });
}
}

async function runAttemptWorker() {
  assert.equal(childMode, "dispatch", "unknown RPL-95 worker mode");
  const raceId = process.env.F4_RPL95_RACE_ID;
  const attemptId = process.env.F4_RPL95_ATTEMPT_ID;
  const candidateId = process.env.F4_RPL95_CANDIDATE_ID;
  assert.match(raceId ?? "", /^[a-z0-9-]{1,64}$/);
  assert.match(attemptId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(typeof candidateId, "string");

  const { service } = createAttemptService({ raceId });
  const identity = attemptIdentity(attemptId, candidateId);
  const outputPath = process.env.F4_RPL95_WORKER_RESULT_FILE;
  assert.equal(path.isAbsolute(outputPath ?? ""), true);
  const writeOutcome = outcome => {
    const serialized = JSON.stringify(outcome);
    fs.writeFileSync(outputPath, serialized, { flag: "wx", mode: 0o600 });
  };
  const reserved = await service.reserveAttempt({ identity });
  if (!reserved.ok) {
    writeOutcome({ authorized: false, reason: reserved.reason });
    return;
  }
  const bound = await service.bindClaim({
    identity,
    expected_attempt_revision: reserved.value.revision,
    claim_revision: 2,
  });
  if (!bound.ok) {
    writeOutcome({ authorized: false, reason: bound.reason });
    return;
  }
  const dispatch = await service.markDispatchStarted({
    identity,
    expected_attempt_revision: bound.value.revision,
    claim_revision: 2,
  });
  writeOutcome(dispatch.ok
    ? { authorized: true, attempt_id: attemptId, status: dispatch.value.status }
    : { authorized: false, reason: dispatch.reason });
}

async function verifyPhysicalLockProcessRace() {
  const raceId = "rpl120-attempt-cas-race";
  const candidateId = "candidate-private-process-race";
  const attemptIds = [
    "123e4567-e89b-42d3-a456-426614174010",
    "123e4567-e89b-42d3-a456-426614174011",
  ];
  fs.mkdirSync(barrierDirectory, { recursive: true, mode: 0o700 });
  const workers = attemptIds.map(attemptId => startAttemptWorker({
    F4_RPL95_ATTEMPT_WORKER_MODE: "dispatch",
    F4_RPL95_TEST_STATE_ROOT: stateRoot,
    F4_RPL95_RACE_ID: raceId,
    F4_RPL95_CANDIDATE_ID: candidateId,
    F4_RPL95_ATTEMPT_ID: attemptId,
    F4_RPL95_WORKER_RESULT_FILE: path.join(barrierDirectory, `${attemptId}.outcome.json`),
    F4_RPL95_USER_LOCAL_STATE_MODULE: rpl95ModulePath,
    F4_TEST_REPOSITORY_CWD: repositoryCwd,
  }));
  const releasePath = path.join(barrierDirectory, `${raceId}.release`);
  let released = false;
  try {
    await waitForWorkersAtReadBarrier(workers, attemptIds, raceId);
    fs.writeFileSync(releasePath, "release", { flag: "wx", mode: 0o600 });
    released = true;
    const results = await Promise.all(workers.map(worker => worker.completion));
    for (const result of results) {
      assert.equal(result.error, null, result.stderr);
      assert.equal(result.exitCode, 0, result.stderr);
    }
    const outcomes = attemptIds.map(attemptId => JSON.parse(fs.readFileSync(
      path.join(barrierDirectory, `${attemptId}.outcome.json`),
      "utf8",
    )));
    assert.equal(outcomes.filter(outcome => outcome.authorized && outcome.status === "dispatch_unknown").length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter(outcome => !outcome.authorized && outcome.reason === "manual_resume_attempt_revision_conflict").length, 1, JSON.stringify(outcomes));

    const restarted = createAttemptService();
    const persisted = await restarted.service.readAttempt({
      candidate_id: candidateId,
      action_kind: "manual_resume",
    });
    assert.equal(persisted.ok, true, JSON.stringify(persisted));
    assert.equal(persisted.value.status, "dispatch_unknown");
    const nextAttempt = await restarted.service.reserveAttempt({
      identity: attemptIdentity("123e4567-e89b-42d3-a456-426614174012", candidateId),
    });
    assert.deepEqual(nextAttempt, { ok: false, reason: "manual_resume_attempt_recovery_required" });
    process.stdout.write("PASS RPL-95 physical lock and Attempt CAS allow one dispatch authority across independent OS processes; UNKNOWN remains blocked after process exit\n");
  } catch (error) {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    if (!released) {
      try { fs.writeFileSync(releasePath, "release", { flag: "wx", mode: 0o600 }); } catch {}
    }
    await Promise.all(workers.map(worker => worker.completion));
    if (error.code === "EPERM" && process.env.CI !== "true") {
      process.stdout.write("BLOCKED RPL-95 multi-process integration: local runner denied child process creation (EPERM)\n");
      return;
    }
    throw error;
  }
}

function startAttemptWorker(environment) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let spawnError = null;
  let spawned = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("spawn", () => { spawned = true; });
  child.once("error", error => { spawnError = error; });
  const completion = new Promise(resolve => {
    child.once("close", (exitCode, signal) => resolve({
      error: spawnError,
      exitCode,
      signal,
      stderr,
    }));
  });
  return { child, completion, get spawned() { return spawned; }, get error() { return spawnError; } };
}

async function waitForWorkersAtReadBarrier(workers, attemptIds, raceId) {
  const deadline = Date.now() + 10000;
  const readyFiles = attemptIds.map(attemptId => path.join(barrierDirectory, `${raceId}-${attemptId}.ready`));
  while (Date.now() < deadline) {
    const failed = workers.find(worker => worker.error !== null);
    if (failed) throw failed.error;
    const exitedEarly = workers.find(worker => worker.child.exitCode !== null);
    if (exitedEarly) {
      const result = await exitedEarly.completion;
      throw new Error(`RPL-95 race worker exited before the read barrier (${result.exitCode}): ${result.stderr}`);
    }
    if (workers.every(worker => worker.spawned) && readyFiles.every(file => fs.existsSync(file))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("RPL-95 race workers did not reach the shared read barrier");
}

function waitForRelease(releasePath) {
  const deadline = Date.now() + 10000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error("RPL-95 race barrier timed out");
    Atomics.wait(waitCell, 0, 0, 10);
  }
}

function createAttemptService({ raceId = null } = {}) {
  const provider = createPendingHandoffManualResumeAttemptOutcomeUserLocalRecordProvider({
    cwd: repositoryCwd,
    userLocalState,
    stateRootOptions: { stateRootOverride: stateRoot },
  });
  assert.equal(provider.ok, true, JSON.stringify(provider));
  const attemptStore = createPendingHandoffManualResumeAttemptOutcomeStoreAdapter({
    recordStore: {
      readRecord: provider.value.readRecord,
      compareAndSetRecord: provider.value.compareAndSetRecord,
    },
  });
  assert.equal(attemptStore.ok, true, JSON.stringify(attemptStore));
  let store = attemptStore.value;
  if (raceId !== null) {
    store = Object.freeze({
      async readAttempt(request) {
        const result = await attemptStore.value.readAttempt(request);
        if (result.ok && result.value === null) {
          const attemptId = process.env.F4_RPL95_ATTEMPT_ID;
          const readyPath = path.join(barrierDirectory, `${raceId}-${attemptId}.ready`);
          fs.writeFileSync(readyPath, "ready", { flag: "wx", mode: 0o600 });
          waitForRelease(path.join(barrierDirectory, `${raceId}.release`));
        }
        return result;
      },
      compareAndSetAttempt: request => attemptStore.value.compareAndSetAttempt(request),
    });
  }
  const service = createPendingHandoffManualResumeAttemptOutcomeService({ store });
  assert.equal(service.ok, true, JSON.stringify(service));
  return { provider: provider.value, service: service.value };
}

function attemptIdentity(attemptId, candidateId = "candidate-private-id") {
  return Object.freeze({
    candidate_id: candidateId,
    action_kind: "manual_resume",
    attempt_id: attemptId,
    runtime_id: "codex",
    actor_identity: "phr1.session.key_A-1." + "O".repeat(43),
    scope_ref: candidateId,
    repository_identity: "phr1.repository.key_A-1." + "R".repeat(43),
    worktree_identity: "phr1.worktree.key_A-1." + "W".repeat(43),
    candidate_revision: 1,
  });
}
