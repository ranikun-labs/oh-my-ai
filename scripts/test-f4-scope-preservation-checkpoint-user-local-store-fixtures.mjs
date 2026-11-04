import assert from "node:assert/strict";
import { createF4ScopePreservingCheckpoint } from "./lib/f4-scope-preservation-checkpoint.mjs";
import {
  createF4ScopePreservationCheckpointUserLocalStore,
} from "./lib/f4-scope-preservation-checkpoint-user-local-store.mjs";

const records = new Map();
const stats = { locations: [], locks: 0, reads: 0, publishes: 0, asyncLocks: 0 };
let publishDurabilityUnknown = false;
const userLocalState = Object.freeze({
  resolveUserLocalStateLocation(cwd, relativePath, options) {
    const key = JSON.stringify([cwd, relativePath, options?.stateRootOverride ?? null]);
    stats.locations.push(relativePath);
    return Object.freeze({ cwd, relativePath, key });
  },
  readUserLocalState(location) {
    stats.reads += 1;
    return records.get(location.key) ?? null;
  },
  publishUserLocalStateAtomically(location, contents) {
    stats.publishes += 1;
    records.set(location.key, contents);
    if (publishDurabilityUnknown) {
      publishDurabilityUnknown = false;
      const error = new Error("private storage detail");
      error.code = "state_publish_durability_unknown";
      throw error;
    }
    return Object.freeze({ published: true, byteLength: contents.length });
  },
  withPhysicalStateLock(_location, operation) {
    stats.locks += 1;
    const result = operation();
    if (result !== null && typeof result === "object" && typeof result.then === "function") {
      stats.asyncLocks += 1;
      throw new Error("Physical lock callback must be synchronous.");
    }
    return result;
  },
});

const scope = {
  objectiveId: "RPL-112",
  scopeRevision: "RPL-112/comment/10729",
  source: {
    uri: "https://ranikunlabs.atlassian.net/browse/RPL-112",
    revision: "RPL-112/comment/10729",
    coverage: "COMPLETE",
  },
  requiredSources: [{ uri: "https://ranikunlabs.atlassian.net/rest/api/3/search" }],
  items: [{ id: "F4", primaryJira: "RPL-120", owner: "F4" }],
};
const refresh = {
  sourceUri: "https://ranikunlabs.atlassian.net/rest/api/3/search",
  sourceRevision: "jira-snapshot/2026-11-03T00:00Z",
  expectedPriorRevision: null,
  refreshScope: "FULL_SOURCE",
  coverage: "COMPLETE",
  partialReasons: [],
  observations: [{ id: "F4", status: "READY" }],
};

const created = createF4ScopePreservingCheckpoint({
  approvedScope: scope,
  currentCheckpoint: null,
  expectedCheckpointRevision: null,
  refresh,
  recentExecution: { primaryJira: "RPL-120", writer: "f4-writer", prHead: null },
  nextReadyId: "F4",
  stopReason: null,
});
assert.equal(created.ok, true);

const storeResult = createF4ScopePreservationCheckpointUserLocalStore({
  cwd: "/repo/worktree",
  userLocalState,
});
assert.equal(storeResult.ok, true);
const store = storeResult.value;

const missing = store.readCheckpoint({ objectiveId: "RPL-112" });
assert.deepEqual(missing, { ok: true, value: null });

const published = store.compareAndSetCheckpoint({
  objectiveId: "RPL-112",
  expectedRevision: null,
  checkpoint: created.checkpoint,
});
assert.equal(published.ok, true);
assert.equal(published.value.checkpointRevision, 1);

const restoredStore = createF4ScopePreservationCheckpointUserLocalStore({
  cwd: "/repo/worktree",
  userLocalState,
});
const restored = restoredStore.value.readCheckpoint({ objectiveId: "RPL-112" });
assert.equal(restored.ok, true);
assert.deepEqual(
  JSON.parse(JSON.stringify(restored.value)),
  JSON.parse(JSON.stringify(created.checkpoint)),
);
const otherWorktreeStore = createF4ScopePreservationCheckpointUserLocalStore({
  cwd: "/repo/other-worktree",
  userLocalState,
});
assert.deepEqual(otherWorktreeStore.value.readCheckpoint({ objectiveId: "RPL-112" }), {
  ok: true,
  value: null,
});

const staleWrite = store.compareAndSetCheckpoint({
  objectiveId: "RPL-112",
  expectedRevision: 0,
  checkpoint: created.checkpoint,
});
assert.deepEqual(staleWrite, { ok: false, reason: "scope_checkpoint_revision_conflict" });

const nextProjection = createF4ScopePreservingCheckpoint({
  approvedScope: scope,
  currentCheckpoint: restored.value,
  expectedCheckpointRevision: 1,
  refresh: {
    sourceUri: "https://ranikunlabs.atlassian.net/rest/api/3/search",
    sourceRevision: "jira-snapshot/smoke-next",
    expectedPriorRevision: "jira-snapshot/2026-11-03T00:00Z",
    refreshScope: "INCREMENTAL_DELTA",
    coverage: "COMPLETE",
    partialReasons: [],
    observations: [{ id: "F4", status: "DONE" }],
  },
  recentExecution: null,
  nextReadyId: null,
  stopReason: null,
});
assert.equal(nextProjection.ok, true, JSON.stringify(nextProjection));
publishDurabilityUnknown = true;
const uncertainPublication = store.compareAndSetCheckpoint({
  objectiveId: "RPL-112",
  expectedRevision: 1,
  checkpoint: nextProjection.checkpoint,
});
assert.deepEqual(uncertainPublication, { ok: false, reason: "scope_checkpoint_publication_unknown" });
const reconciledAfterUnknown = store.readCheckpoint({ objectiveId: "RPL-112" });
assert.equal(reconciledAfterUnknown.ok, true);
assert.equal(reconciledAfterUnknown.value.checkpointRevision, 2);
assert.equal(reconciledAfterUnknown.value.goalDoneEligible, true);

assert.equal(stats.asyncLocks, 0);
assert.ok(stats.locks >= 4);
assert.ok(stats.publishes >= 1);
assert.ok(stats.locations.every(relativePath => (
  /^f4\/scope-preservation-checkpoints\/checkpoint-[a-f0-9]{64}\.json$/.test(relativePath)
)));
const payload = [...records.values()].map(value => JSON.parse(value))[0];
assert.equal(payload.objective_id, "RPL-112");
assert.equal(payload.checkpoint.checkpointRevision, 2);
assert.equal(JSON.stringify(payload).includes("prompt"), false);
const storedKey = [...records.keys()][0];
records.set(storedKey, "{");
assert.deepEqual(store.readCheckpoint({ objectiveId: "RPL-112" }), {
  ok: false,
  reason: "scope_checkpoint_record_invalid",
});

process.stdout.write("F4 scope checkpoint user-local store fixture passed.\n");
