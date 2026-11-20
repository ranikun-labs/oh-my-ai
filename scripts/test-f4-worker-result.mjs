import assert from "node:assert/strict";
import { createF4WorkerResultHandler } from "./lib/f4-worker-result.mjs";

const verified = {
  objectiveId: "objective@scope", workstreamId: "A@wave", scopeRevision: "scope-1",
  candidateId: "candidate-A ".repeat(40), actionKind: "manual_resume", attemptId: "attempt-A",
  candidateRevision: 1, claimRevision: 2, associationId: "association", actorId: "actor",
  runtimeId: "codex", executionId: "execution", repositoryId: "repo", worktreeId: "worktree",
  repositoryInstanceId: "physical-repo", physicalWorktreeId: "physical-worktree",
  stateRootId: "state-root", commit: "a".repeat(40), tree: "b".repeat(40),
  environmentId: "test-env", testPlanId: "targeted", testPlanDigest: "c".repeat(64),
  outcome: "passed", evidenceRef: "evidence/test", rawTranscript: "not retained",
};
let stored = null;
let writes = 0;
let inventoryCalls = 0;
let reconciled = false;
const store = {
  async createIfAbsent(key, record) {
    assert.equal(key.attemptId, "attempt-A");
    assert.equal(key.candidateId, verified.candidateId);
    if (stored === null) {
      writes++;
      stored = record;
      throw new Error("response lost after publication");
    }
  },
  async read() { return stored; },
};
const build = () => createF4WorkerResultHandler({
  verifyResult: async event => event.authenticated ? { ...verified, outcome: event.outcome } : null,
  resultStore: store,
  reconcileInventory: async () => {
    inventoryCalls++;
    if (inventoryCalls === 1) throw new Error("inventory unavailable");
    if (reconciled) return "already_applied";
    reconciled = true;
    return "applied";
  },
});

assert.deepEqual(await build()({ outcome: "passed" }), { ok: false, reason: "worker_result_unverified" });
assert.deepEqual(await build()({ authenticated: true, outcome: "interrupted" }), { ok: false, reason: "worker_result_unverified" });
assert.equal(writes, 0);
const completed = { authenticated: true, outcome: "passed" };
assert.deepEqual(await build()(completed), {
  ok: false, reason: "worker_result_reconciliation_pending", resultRecorded: true,
});
assert.equal(Object.hasOwn(stored, "rawTranscript"), false);
assert.deepEqual(await build()(completed), { ok: true, resultRecorded: true, reconciliation: "applied" });
assert.deepEqual(await build()(completed), { ok: true, resultRecorded: true, reconciliation: "already_applied" });
assert.deepEqual(await build()({ ...completed, outcome: "failed" }), { ok: false, reason: "worker_result_conflict" });
assert.equal(writes, 1);
assert.equal(inventoryCalls, 3);

const unavailable = createF4WorkerResultHandler({
  verifyResult: () => verified,
  resultStore: { createIfAbsent() {}, read() { return null; } },
  reconcileInventory: () => assert.fail("unconfirmed Result reached Inventory"),
});
assert.deepEqual(await unavailable(completed), { ok: false, reason: "worker_result_storage_unknown" });
console.log("F4 Worker Result fixture PASS");

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const userLocalState = await import("./lib/user-local-state.mjs");
const { createF4WorkerResultStore, createF4ManagedWorkerResultHandler } = await import("./lib/f4-worker-result-store.mjs");
const { f4PhysicalStateBindingFromLocation } = await import("./lib/f4-physical-state-binding.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4-result-store-"));
try {
  const { fileURLToPath } = await import("node:url");
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const stateRootOptions = { stateRootOverride: root };
  const where = userLocalState.resolveUserLocalStateLocation(cwd, "f4/probe.json", stateRootOptions);
  const physical = f4PhysicalStateBindingFromLocation(where);
  assert.equal(physical.ok, true);
  const options = { cwd, userLocalState, stateRootOptions, expectedBinding: physical.value };
  const record = {
    ...verified,
    repositoryInstanceId: physical.value.repository_instance_id,
    physicalWorktreeId: physical.value.physical_worktree_id,
    stateRootId: physical.value.state_root_identity,
  };
  const key = { candidateId: record.candidateId, actionKind: record.actionKind, attemptId: record.attemptId };
  const first = createF4WorkerResultStore(options);
  assert.equal(first.read(key), null);
  first.createIfAbsent(key, record);
  const second = createF4WorkerResultStore(options);
  second.createIfAbsent(key, { ...record, outcome: "failed" });
  assert.equal(second.read(key).outcome, "passed");
  assert.equal(Object.hasOwn(second.read(key), "rawTranscript"), false);
  assert.throws(() => second.createIfAbsent(key, { ...record, physicalWorktreeId: "other" }), /record_invalid/);
  let attemptStatus = "reserved";
  let inventoryPublications = 0;
  const handler = createF4ManagedWorkerResultHandler({
    ...options,
    verifyResult: () => record,
    attemptOutcome: { readAttempt: () => ({ ok: true, value: {
      status: attemptStatus,
      candidate_id: record.candidateId, action_kind: record.actionKind, attempt_id: record.attemptId,
      runtime_id: record.runtimeId, actor_identity: record.actorId, repository_identity: record.repositoryId,
      worktree_identity: record.worktreeId, candidate_revision: record.candidateRevision,
      claim_revision: record.claimRevision,
    } }) },
    reconcileInventory() { inventoryPublications++; return "applied"; },
  });
  assert.deepEqual(await handler({}), { ok: false, reason: "worker_result_unverified" });
  assert.equal(inventoryPublications, 0);
  attemptStatus = "dispatch_unknown";
  assert.deepEqual(await handler({}), { ok: true, resultRecorded: true, reconciliation: "applied" });
  assert.equal(inventoryPublications, 1);
  let directorySynced = false;
  const wrappedState = {
    ...userLocalState,
    confirmUserLocalStateDurability(location) {
      if (!directorySynced) throw new Error("directory sync uncertain");
      return userLocalState.confirmUserLocalStateDurability(location);
    },
  };
  const durableStore = createF4WorkerResultStore({ ...options, userLocalState: wrappedState });
  wrappedState.confirmUserLocalStateDurability = () => {};
  assert.throws(() => durableStore.read(key), /sync uncertain/);
  const recovery = createF4WorkerResultHandler({
    verifyResult: () => record,
    resultStore: durableStore,
    reconcileInventory: () => "already_applied",
  });
  assert.deepEqual(await recovery({}), { ok: false, reason: "worker_result_storage_unknown" });
  directorySynced = true;
  assert.deepEqual(await recovery({}), { ok: true, resultRecorded: true, reconciliation: "already_applied" });
  fs.renameSync(root, root + "-retired");
  fs.mkdirSync(root, { mode: 0o700 });
  assert.throws(() => second.read(key), /binding_unverified/);
  console.log("F4 Worker Result filesystem store PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root + "-retired", { recursive: true, force: true });
}
