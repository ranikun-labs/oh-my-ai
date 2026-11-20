import assert from "node:assert/strict";
import { createF4WorkerResultCheckpointReconciler } from "./lib/f4-worker-result-checkpoint.mjs";

const result = { record: { objectiveId: "objective", workstreamId: "A", scopeRevision: "r1", outcome: "passed" }, digest: "digest" };
const approvedScope = { objectiveId: "objective", scopeRevision: "r1", source: { uri: "objective-source" }, requiredSources: [{ uri: "inventory" }] };
const refresh = { sourceUri: "inventory", sourceRevision: "new", coverage: "COMPLETE", observations: [{ id: "A", status: "DONE" }] };
const observation = { approvedScope, refresh, resultDigest: "digest", workstreamId: "A", status: "DONE" };
const initial = { ...approvedScope, checkpointRevision: 8, sourceCoverage: [], inventory: [], nextReadyId: "B", stopReason: null };
const saved = {
  ...initial,
  checkpointRevision: 9,
  sourceCoverage: [{ uri: "inventory", revision: "new", coverage: "COMPLETE" }],
  inventory: [{ id: "A", status: "DONE", scopeMember: true, sourceUri: "objective-source", sourceRevision: "older-completion" }],
};

let current = initial;
let canonical = { ...observation, resultDigest: "different" };
let writes = 0;
let respond = "lost";
const reconcile = createF4WorkerResultCheckpointReconciler({
  withCurrentInventoryResult: (_request, project) => canonical ? project(canonical) : "pending",
  projectScopeCheckpoint: () => ({ ok: true, checkpoint: saved }),
  readScopeCheckpoint: () => ({ ok: true, value: current }),
  reconcileScopeCheckpoint(request) {
    writes++;
    assert.equal(request.expectedCheckpointRevision, 8);
    assert.equal(request.nextReadyId, "B");
    assert.equal(request.refresh, refresh);
    assert.equal(request.stopReason, null);
    if (respond === "stale") return { ok: false, reason: "STALE_CHECKPOINT_REVISION" };
    current = saved;
    throw new Error("publication response lost");
  },
});
assert.equal(await reconcile(result), "pending");
assert.equal(writes, 0);
canonical = null;
assert.equal(await reconcile(result), "pending");
assert.equal(writes, 0);
canonical = observation;
assert.equal(await reconcile(result), "already_applied");
assert.equal(await reconcile(result), "already_applied");
assert.equal(writes, 1);
current = { ...initial, stopReason: "NO_VERIFIED_READY" };
respond = "stale";
assert.equal(await reconcile(result), "pending");
assert.equal(writes, 2);
current = { ...initial, scopeRevision: "revoked" };
assert.equal(await reconcile(result), "pending");
assert.equal(writes, 2);
let escapedCallback;
let releaseRead;
let escapedProjection;
const prematureHost = createF4WorkerResultCheckpointReconciler({
  withCurrentInventoryResult(_request, project) {
    escapedCallback = project;
    escapedProjection = project(observation);
    return "applied";
  },
  readScopeCheckpoint: () => new Promise(resolve => { releaseRead = resolve; }),
  projectScopeCheckpoint: () => ({ ok: true, checkpoint: saved }),
  reconcileScopeCheckpoint: () => assert.fail("checkpoint published after its Host guard returned"),
});
assert.equal(await prematureHost(result), "pending");
releaseRead({ ok: true, value: initial });
assert.equal(await escapedProjection, "pending");
assert.equal(await escapedCallback(observation), "pending");
console.log("F4 Result/Checkpoint reconciliation PASS");
