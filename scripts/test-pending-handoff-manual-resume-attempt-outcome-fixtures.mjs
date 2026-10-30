import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPendingHandoffManualResumeAttemptOutcomeService,
} from "./lib/pending-handoff-manual-resume-attempt-outcome.mjs";

const ATTEMPT_A = "123e4567-e89b-42d3-a456-426614174000";
const ATTEMPT_B = "223e4567-e89b-42d3-a456-426614174001";
const IDENTITY = Object.freeze({
  candidate_id: "attempt-outcome-candidate",
  action_kind: "manual_resume",
  attempt_id: ATTEMPT_A,
  runtime_id: "codex",
  actor_identity: `phr1.session.key_A-1.${"O".repeat(43)}`,
  scope_ref: "attempt-outcome-candidate",
  repository_identity: `phr1.repository.key_A-1.${"R".repeat(43)}`,
  worktree_identity: `phr1.worktree.key_A-1.${"W".repeat(43)}`,
  candidate_revision: 4,
});

let tests = 0;
let blocked = 0;
function success(value) { return { ok: true, value }; }
function failure(reason) { return { ok: false, reason }; }
function assertFailure(result, reason) { assert.deepEqual(result, { ok: false, reason }); }

function createCasFixtureStore(overrides = {}) {
  const records = new Map();
  const keyOf = value => JSON.stringify([value.candidate_id, value.action_kind]);
  const store = {
    readAttempt: async identity => {
      if (overrides.readAttempt) return overrides.readAttempt(identity, records, keyOf);
      return success(records.get(keyOf(identity)) ?? null);
    },
    compareAndSetAttempt: async request => {
      if (overrides.compareAndSetAttempt) {
        return overrides.compareAndSetAttempt(request, records, keyOf);
      }
      const key = keyOf(request);
      const current = records.get(key) ?? null;
      if ((request.expected_revision === null && current !== null)
        || (request.expected_revision !== null && current?.revision !== request.expected_revision)) {
        return failure("revision_conflict");
      }
      records.set(key, request.next_record);
      return success(request.next_record);
    },
  };
  return { records, store, createService: () => createPendingHandoffManualResumeAttemptOutcomeService({ store }).value };
}

function createFileCasFixtureStore(root) {
  const recordPath = path.join(root, "manual-resume-attempt.json");
  const lockPath = path.join(root, "manual-resume-attempt.lock");
  async function readRecord() {
    try { return JSON.parse(await fs.readFile(recordPath, "utf8")); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function withLock(operation) {
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await fs.mkdir(lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    if (!acquired) throw new Error("test CAS lock timeout");
    try { return await operation(); } finally { await fs.rm(lockPath, { recursive: true, force: true }); }
  }
  return {
    readAttempt: async () => success(await readRecord()),
    compareAndSetAttempt: async request => withLock(async () => {
      const current = await readRecord();
      if ((request.expected_revision === null && current !== null)
        || (request.expected_revision !== null && current?.revision !== request.expected_revision)) {
        return failure("revision_conflict");
      }
      const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(request.next_record), { flag: "wx" });
      await fs.rename(temporaryPath, recordPath);
      return success(request.next_record);
    }),
  };
}

async function runProcessRaceChild() {
  const root = process.argv[3];
  const attemptId = process.argv[4];
  const service = createPendingHandoffManualResumeAttemptOutcomeService({
    store: createFileCasFixtureStore(root),
  }).value;
  const identity = { ...IDENTITY, attempt_id: attemptId };
  const reserved = await service.reserveAttempt({ identity });
  if (!reserved.ok) {
    process.stdout.write(JSON.stringify({ authorized: false, reason: reserved.reason }));
    return;
  }
  const bound = await service.bindClaim({
    identity,
    expected_attempt_revision: reserved.value.revision,
    claim_revision: 5,
  });
  if (!bound.ok) {
    process.stdout.write(JSON.stringify({ authorized: false, reason: bound.reason }));
    return;
  }
  const started = await service.markDispatchStarted({
    identity,
    expected_attempt_revision: bound.value.revision,
    claim_revision: 5,
  });
  process.stdout.write(JSON.stringify({
    authorized: started.ok,
    status: started.ok ? started.value.status : null,
    reason: started.ok ? null : started.reason,
  }));
}

const IS_PROCESS_RACE_CHILD = process.argv[2] === "--attempt-outcome-process-race-child";
if (IS_PROCESS_RACE_CHILD) {
  await runProcessRaceChild();
}

function runChild(attemptId, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "--attempt-outcome-process-race-child",
      root,
      attemptId,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        const error = new Error(`child exited ${code}: ${stderr.slice(0, 200)}`);
        error.code = code;
        reject(error);
      } else if (stdout.trim().length === 0) {
        const error = new Error("child process returned empty stdout");
        error.code = "EPERM";
        reject(error);
      } else {
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`invalid child JSON: ${stdout.slice(0, 200)}`)); }
      }
    });
  });
}

async function test(name, callback) {
  tests += 1;
  try { await callback(); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

if (!IS_PROCESS_RACE_CHILD) {
await test("requires an explicit attempt CAS port", () => {
  assert.deepEqual(createPendingHandoffManualResumeAttemptOutcomeService({}), {
    ok: false,
    reason: "manual_resume_attempt_store_invalid",
  });
  assert.deepEqual(createPendingHandoffManualResumeAttemptOutcomeService({
    store: { readAttempt: async () => success(null) },
  }), {
    ok: false,
    reason: "manual_resume_attempt_store_invalid",
  });
});

await test("creates a purpose-bound reservation before Claim or Dispatch", async () => {
  const fixture = createCasFixtureStore();
  const service = fixture.createService();
  const result = await service.reserveAttempt({ identity: IDENTITY });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    ...IDENTITY,
    revision: 1,
    claim_revision: null,
    status: "reserved",
    adapter_version: null,
  });
});

await test("a different or repeated Attempt cannot bypass an active reservation", async () => {
  const fixture = createCasFixtureStore();
  const first = fixture.createService();
  assert.equal((await first.reserveAttempt({ identity: IDENTITY })).ok, true);
  const restartedService = fixture.createService();
  assertFailure(await restartedService.reserveAttempt({ identity: IDENTITY }), "manual_resume_attempt_replay_blocked");
  assertFailure(await restartedService.reserveAttempt({
    identity: { ...IDENTITY, attempt_id: ATTEMPT_B },
  }), "manual_resume_attempt_recovery_required");
  assert.equal(fixture.records.size, 1);
});

await test("Claim binding and dispatch-start CAS are ordered and revision-bound", async () => {
  const fixture = createCasFixtureStore();
  const service = fixture.createService();
  const reserved = await service.reserveAttempt({ identity: IDENTITY });
  const bound = await service.bindClaim({
    identity: IDENTITY,
    expected_attempt_revision: reserved.value.revision,
    claim_revision: 5,
  });
  assert.equal(bound.value.status, "claim_bound");
  assert.equal(bound.value.claim_revision, 5);
  const started = await service.markDispatchStarted({
    identity: IDENTITY,
    expected_attempt_revision: bound.value.revision,
    claim_revision: 5,
  });
  assert.equal(started.value.status, "dispatch_unknown");
  assert.equal(started.value.revision, 3);
});

await test("UNKNOWN survives service restart and blocks same or new attempt dispatch", async () => {
  const fixture = createCasFixtureStore();
  let service = fixture.createService();
  const reserved = await service.reserveAttempt({ identity: IDENTITY });
  const bound = await service.bindClaim({
    identity: IDENTITY,
    expected_attempt_revision: reserved.value.revision,
    claim_revision: 5,
  });
  const started = await service.markDispatchStarted({
    identity: IDENTITY,
    expected_attempt_revision: bound.value.revision,
    claim_revision: 5,
  });
  service = fixture.createService();
  assertFailure(await service.reserveAttempt({ identity: IDENTITY }), "manual_resume_attempt_replay_blocked");
  assertFailure(await service.reserveAttempt({
    identity: { ...IDENTITY, attempt_id: ATTEMPT_B },
  }), "manual_resume_attempt_recovery_required");
  assertFailure(await service.markDispatchStarted({
    identity: IDENTITY,
    expected_attempt_revision: bound.value.revision,
    claim_revision: 5,
  }), "manual_resume_attempt_revision_conflict");
  const latest = await service.readAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: "manual_resume",
  });
  assert.equal(latest.value.status, "dispatch_unknown");
  assert.equal(latest.value.revision, started.value.revision);
});

await test("adapter acceptance is recorded as accepted, never completed", async () => {
  const fixture = createCasFixtureStore();
  const service = fixture.createService();
  const reserved = await service.reserveAttempt({ identity: IDENTITY });
  const bound = await service.bindClaim({ identity: IDENTITY, expected_attempt_revision: reserved.value.revision, claim_revision: 5 });
  const started = await service.markDispatchStarted({ identity: IDENTITY, expected_attempt_revision: bound.value.revision, claim_revision: 5 });
  const accepted = await service.recordValidatedAdapterAcceptance({
    identity: IDENTITY,
    expected_attempt_revision: started.value.revision,
    adapter_version: "fixture-adapter-v1",
  });
  assert.equal(accepted.value.status, "accepted");
  assert.equal(Object.hasOwn(accepted.value, "result"), false);
  assert.equal(Object.hasOwn(accepted.value, "checkpoint"), false);
  assertFailure(await service.reserveAttempt({ identity: { ...IDENTITY, attempt_id: ATTEMPT_B } }), "manual_resume_attempt_recovery_required");
});

await test("stale revision and mismatched Claim are rejected without mutation", async () => {
  const fixture = createCasFixtureStore();
  const service = fixture.createService();
  await service.reserveAttempt({ identity: IDENTITY });
  assertFailure(await service.bindClaim({ identity: IDENTITY, expected_attempt_revision: 0, claim_revision: 5 }), "manual_resume_attempt_revision_conflict");
  const bound = await service.bindClaim({ identity: IDENTITY, expected_attempt_revision: 1, claim_revision: 5 });
  assertFailure(await service.markDispatchStarted({ identity: IDENTITY, expected_attempt_revision: 2, claim_revision: 6 }), "manual_resume_attempt_claim_conflict");
  const latest = await service.readAttempt({ candidate_id: IDENTITY.candidate_id, action_kind: "manual_resume" });
  assert.equal(latest.value.status, "claim_bound");
  assert.equal(latest.value.revision, bound.value.revision);
});

await test("a write with a lost receipt remains quarantined", async () => {
  let firstWrite = true;
  const fixture = createCasFixtureStore({
    compareAndSetAttempt: async (request, records, keyOf) => {
      const key = keyOf(request);
      records.set(key, request.next_record);
      if (firstWrite) {
        firstWrite = false;
        return failure("store_unavailable");
      }
      return success(request.next_record);
    },
  });
  const first = fixture.createService();
  assertFailure(await first.reserveAttempt({ identity: IDENTITY }), "manual_resume_attempt_store_unavailable");
  const restarted = fixture.createService();
  assertFailure(await restarted.reserveAttempt({ identity: IDENTITY }), "manual_resume_attempt_replay_blocked");
});

await test("store failure is fail-closed", async () => {
  const fixture = createCasFixtureStore({ readAttempt: async () => { throw new Error("private failure"); } });
  assertFailure(await fixture.createService().reserveAttempt({ identity: IDENTITY }), "manual_resume_attempt_store_unavailable");
});

await test("read and reservation reject a valid record returned for another scope", async () => {
  const foreignRecord = {
    ...IDENTITY,
    candidate_id: "another-candidate",
    scope_ref: "another-candidate",
    revision: 1,
    claim_revision: null,
    status: "reserved",
    adapter_version: null,
  };
  const fixture = createCasFixtureStore({ readAttempt: async () => success(foreignRecord) });
  const service = fixture.createService();
  assertFailure(await service.readAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
  }), "manual_resume_attempt_record_invalid");
  assertFailure(await service.reserveAttempt({ identity: IDENTITY }), "manual_resume_attempt_record_invalid");
});

try {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rpl120-attempt-cas-"));
  try {
    const outcomes = await Promise.all([
      runChild(ATTEMPT_A, root),
      runChild(ATTEMPT_B, root),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.authorized && outcome.status === "dispatch_unknown").length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter(outcome => !outcome.authorized).length, 1, JSON.stringify(outcomes));
    tests += 1;
    process.stdout.write("PASS independent OS-process attempt CAS fixture (test-only filesystem adapter)\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
} catch (error) {
  if (error.code !== "EPERM" || process.env.CI === "true") throw error;
  blocked += 1;
  process.stdout.write("BLOCKED independent OS-process attempt CAS fixture: this local runner denied child process creation (EPERM)\n");
}

process.stdout.write(`PASS TOTAL ${tests} TESTS BLOCKED ${blocked} RC 0\n`);
}
