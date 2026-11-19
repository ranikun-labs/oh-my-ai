import assert from "node:assert/strict";
import { createF4ScopePreservingCheckpoint } from "./lib/f4-scope-preservation-checkpoint.mjs";

const OWNER_SCOPE_URI = "https://ranikunlabs.atlassian.net/browse/RPL-112";
const ISSUE_INVENTORY_URI = "https://ranikunlabs.atlassian.net/rest/api/3/search";
const OWNER_SCOPE_REVISION = "RPL-112/comment/10729";
const JIRA_SNAPSHOT_REVISION = "jira-snapshot/2026-11-03T00:00Z";
const PR_HEAD = "0a690ce791b9b6353667224e99422a79323ee7d6";

const approvedScope = {
  objectiveId: "RPL-112",
  scopeRevision: OWNER_SCOPE_REVISION,
  source: { uri: OWNER_SCOPE_URI, revision: OWNER_SCOPE_REVISION, coverage: "COMPLETE" },
  requiredSources: [{ uri: ISSUE_INVENTORY_URI }],
  // Owner mapping from RPL-112 comment 10729: F1-F6, Dev Harness, Capability.
  items: [
    { id: "F1", primaryJira: "RPL-119", owner: "F1" },
    { id: "F2", primaryJira: "RPL-113", owner: "F2" },
    { id: "F3", primaryJira: "RPL-115", owner: "F3" },
    { id: "F4", primaryJira: "RPL-120", owner: "F4" },
    { id: "F5", primaryJira: "RPL-116", owner: "F5" },
    { id: "F6", primaryJira: "RPL-121", owner: "F6" },
    { id: "DEV_HARNESS", primaryJira: "RPL-93", owner: "DEV_HARNESS" },
    { id: "CAPABILITY", primaryJira: "RPL-118", owner: "CAPABILITY" },
  ],
};

const allEightObservations = [
  { id: "F1", status: "READY" },
  { id: "F2", status: "BLOCKED" },
  { id: "F3", status: "WAITING" },
  { id: "F4", status: "DONE" },
  { id: "F5", status: "READY" },
  { id: "F6", status: "WAITING" },
  { id: "DEV_HARNESS", status: "READY" },
  { id: "CAPABILITY", status: "READY" },
];

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL ${name}\n${error.stack ?? error}\n`);
  }
}

function refresh(observations, overrides = {}) {
  return {
    sourceUri: ISSUE_INVENTORY_URI,
    sourceRevision: JIRA_SNAPSHOT_REVISION,
    refreshScope: "FULL_SOURCE",
    coverage: "COMPLETE",
    partialReasons: [],
    observations,
    ...overrides,
  };
}

function buildCheckpoint({
  currentCheckpoint = null,
  expectedCheckpointRevision = null,
  scope = approvedScope,
  sourceRefresh = refresh(allEightObservations),
  recentExecution = {
    primaryJira: "RPL-120",
    writer: "f4-native-runtime-writer",
    prHead: PR_HEAD,
  },
  nextReadyId = "CAPABILITY",
  stopReason = null,
} = {}) {
  const effectiveRefresh = sourceRefresh === null || Object.hasOwn(sourceRefresh, "expectedPriorRevision")
    ? sourceRefresh
    : {
      ...sourceRefresh,
      expectedPriorRevision: (currentCheckpoint?.sourceCoverage ?? [])
        .find(source => source.uri === sourceRefresh.sourceUri)?.revision ?? null,
    };
  return createF4ScopePreservingCheckpoint({
    approvedScope: scope,
    currentCheckpoint,
    expectedCheckpointRevision,
    refresh: effectiveRefresh,
    recentExecution,
    nextReadyId,
    stopReason,
  });
}

function item(checkpoint, id) {
  return checkpoint.inventory.find(row => row.id === id);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test("last two workstreams refresh without replacing the full 8-area scope", () => {
  const initial = buildCheckpoint();
  assert.equal(initial.ok, true);
  const next = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 1,
    sourceRefresh: refresh([
      { id: "DEV_HARNESS", status: "BLOCKED" },
      { id: "CAPABILITY", status: "READY" },
    ], { refreshScope: "INCREMENTAL_DELTA", sourceRevision: "jira-snapshot/2026-11-03T00:05Z" }),
    recentExecution: { primaryJira: "RPL-118", writer: "capability-writer", prHead: null },
    nextReadyId: "CAPABILITY",
  });
  assert.equal(next.ok, true);
  assert.equal(next.checkpoint.inventory.filter(row => row.scopeMember).length, 8);
  assert.equal(item(next.checkpoint, "F1").status, "READY");
  assert.equal(item(next.checkpoint, "F2").status, "BLOCKED");
  assert.equal(item(next.checkpoint, "F4").status, "DONE");
  assert.equal(item(next.checkpoint, "DEV_HARNESS").status, "BLOCKED");
  assert.equal(item(next.checkpoint, "CAPABILITY").status, "READY");
  assert.equal(next.checkpoint.statusSummary.READY, 3);
  assert.equal(next.checkpoint.statusSummary.BLOCKED, 2);
  assert.equal(next.checkpoint.nextReadyId, "CAPABILITY");
  assert.equal(next.checkpoint.scopeCoverage, "COMPLETE");
  assert.equal(next.checkpoint.goalDoneEligible, false);
  assert.deepEqual(next.checkpoint.recentExecution, {
    primaryJira: "RPL-118", writer: "capability-writer", prHead: null,
  });
});

test("the common checkpoint accepts a different Owner-approved workstream scope", () => {
  const sourceUri = "https://ranikunlabs.atlassian.net/browse/RPL-999";
  const inventoryUri = ISSUE_INVENTORY_URI;
  const scope = {
    objectiveId: "TEAM_ALPHA/DELIVERY",
    scopeRevision: "owner-revision-7",
    source: { uri: sourceUri, revision: "owner-revision-7", coverage: "COMPLETE" },
    requiredSources: [{ uri: inventoryUri }],
    items: [{ id: "WORK_A" }, { id: "WORK_B" }, { id: "WORK_C" }],
  };
  const result = buildCheckpoint({
    scope,
    sourceRefresh: refresh([
      { id: "WORK_A", status: "READY" },
      { id: "WORK_B", status: "BLOCKED" },
      { id: "WORK_C", status: "WAITING" },
    ], { sourceUri: inventoryUri, sourceRevision: "jira-snapshot/team-alpha-7" }),
    nextReadyId: "WORK_A",
  });

  assert.equal(result.ok, true);
  assert.equal(result.checkpoint.objectiveId, "TEAM_ALPHA/DELIVERY");
  assert.equal(result.checkpoint.scopeRevision, "owner-revision-7");
  assert.deepEqual(result.checkpoint.inventory.map(row => row.id), ["WORK_A", "WORK_B", "WORK_C"]);
  assert.equal(result.checkpoint.statusSummary.READY, 1);
  assert.equal(result.checkpoint.statusSummary.BLOCKED, 1);
  assert.equal(result.checkpoint.statusSummary.WAITING, 1);
});

test("a blocked workstream does not suppress a different approved READY", () => {
  const result = buildCheckpoint({
    sourceRefresh: refresh([
      { id: "DEV_HARNESS", status: "BLOCKED" },
      { id: "CAPABILITY", status: "READY" },
    ]),
    nextReadyId: "DEV_HARNESS",
  });
  assert.equal(result.ok, true);
  assert.equal(item(result.checkpoint, "DEV_HARNESS").status, "BLOCKED");
  assert.equal(result.checkpoint.nextReadyId, "CAPABILITY");
  assert.equal(result.checkpoint.stopReason, null);
});

test("JSON handoff and context compaction preserve scope revision, inventory, and checkpoint revision", () => {
  const initial = buildCheckpoint();
  const compacted = clone(initial.checkpoint);
  const resumed = buildCheckpoint({
    currentCheckpoint: compacted,
    expectedCheckpointRevision: 1,
    sourceRefresh: refresh([{ id: "CAPABILITY", status: "READY" }]),
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.checkpoint.scopeRevision, OWNER_SCOPE_REVISION);
  assert.equal(resumed.checkpoint.checkpointRevision, 2);
  assert.equal(resumed.checkpoint.inventory.filter(row => row.scopeMember).length, 8);
  assert.equal(item(resumed.checkpoint, "F6").status, "WAITING");
});

test("pagination, permission, and network gaps remain partial while an independent READY stays runnable", () => {
  const initial = buildCheckpoint();
  const result = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 1,
    sourceRefresh: refresh([{ id: "CAPABILITY", status: "READY" }], {
      sourceRevision: "jira-snapshot/partial-2026-11-03T00:05Z",
      coverage: "PARTIAL_DISCOVERY",
      partialReasons: ["PAGINATION", "PERMISSION", "NETWORK"],
    }),
    nextReadyId: "CAPABILITY",
  });
  assert.equal(result.ok, true);
  assert.equal(result.checkpoint.scopeCoverage, "PARTIAL_DISCOVERY");
  assert.equal(result.checkpoint.goalDoneEligible, false);
  assert.deepEqual(result.checkpoint.unverifiedDiscoveryRanges.map(row => row.reason), [
    "NETWORK", "PAGINATION", "PERMISSION",
  ]);
  assert.equal(result.checkpoint.nextReadyId, "CAPABILITY");
  assert.equal(result.checkpoint.stopReason, "PARTIAL_DISCOVERY");
});

test("a complete incremental delta cannot repair an incomplete source baseline", () => {
  const initial = buildCheckpoint({
    sourceRefresh: refresh([{ id: "CAPABILITY", status: "READY" }], {
      coverage: "PARTIAL_DISCOVERY",
      partialReasons: ["PAGINATION"],
    }),
  });
  const result = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 1,
    sourceRefresh: refresh([{ id: "DEV_HARNESS", status: "BLOCKED" }], {
      refreshScope: "INCREMENTAL_DELTA",
      expectedPriorRevision: JIRA_SNAPSHOT_REVISION,
      sourceRevision: "jira-snapshot/delta",
      coverage: "COMPLETE",
    }),
    nextReadyId: "CAPABILITY",
  });
  assert.equal(result.ok, true);
  assert.equal(result.checkpoint.scopeCoverage, "PARTIAL_DISCOVERY");
  assert.equal(result.checkpoint.sourceCoverage.find(row => row.uri === ISSUE_INVENTORY_URI).coverage, "PARTIAL_DISCOVERY");
  assert.equal(item(result.checkpoint, "CAPABILITY").status, "READY");
  assert.equal(item(result.checkpoint, "DEV_HARNESS").status, "BLOCKED");
  assert.equal(result.checkpoint.nextReadyId, "CAPABILITY");
});

test("partial coverage cannot be reset by the unchanged approved-scope snapshot", () => {
  const initial = buildCheckpoint();
  const partial = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 1,
    sourceRefresh: refresh([], {
      sourceUri: OWNER_SCOPE_URI,
      sourceRevision: OWNER_SCOPE_REVISION,
      coverage: "PARTIAL_DISCOVERY",
      partialReasons: ["PAGINATION"],
    }),
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.checkpoint.scopeCoverage, "PARTIAL_DISCOVERY");

  const resumed = buildCheckpoint({
    currentCheckpoint: clone(partial.checkpoint),
    expectedCheckpointRevision: 2,
    sourceRefresh: null,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.checkpoint.scopeSource.coverage, "COMPLETE");
  assert.equal(resumed.checkpoint.sourceCoverage.find(row => row.uri === OWNER_SCOPE_URI).coverage, "PARTIAL_DISCOVERY");
  assert.equal(resumed.checkpoint.scopeCoverage, "PARTIAL_DISCOVERY");
  assert.equal(resumed.checkpoint.goalDoneEligible, false);

  const reconciled = buildCheckpoint({
    currentCheckpoint: resumed.checkpoint,
    expectedCheckpointRevision: 3,
    sourceRefresh: refresh([], {
      sourceUri: OWNER_SCOPE_URI,
      sourceRevision: OWNER_SCOPE_REVISION,
      coverage: "COMPLETE",
    }),
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.checkpoint.scopeCoverage, "COMPLETE");
  assert.equal(reconciled.checkpoint.unverifiedDiscoveryRanges.some(row => row.sourceUri === OWNER_SCOPE_URI), false);
});

test("a newly discovered out-of-scope Jira stays unverified and cannot become READY", () => {
  const result = buildCheckpoint({
    sourceRefresh: refresh([
      { id: "RPL-999", status: "READY" },
      { id: "CAPABILITY", status: "READY" },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(item(result.checkpoint, "RPL-999"), undefined);
  assert.deepEqual(result.checkpoint.unverifiedDiscoveries, [{
    id: "RPL-999",
    sourceUri: ISSUE_INVENTORY_URI,
    sourceRevision: JIRA_SNAPSHOT_REVISION,
    disposition: "UNVERIFIED_OUT_OF_SCOPE",
  }]);
  assert.equal(result.checkpoint.nextReadyId, "CAPABILITY");
});

test("an unapproved source cannot mutate an approved item's status", () => {
  const initial = buildCheckpoint();
  const result = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 1,
    sourceRefresh: refresh([{ id: "CAPABILITY", status: "BLOCKED" }], {
      sourceUri: "https://untrusted.example/inventory",
      sourceRevision: "untrusted/1",
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(item(result.checkpoint, "CAPABILITY").status, "READY");
  assert.equal(result.checkpoint.unverifiedDiscoveries[0].disposition, "UNVERIFIED_SOURCE");
  assert.match(result.checkpoint.unverifiedDiscoveries[0].sourceUri, /^urn:sha256:[a-f0-9]{64}$/);
  assert.equal(result.checkpoint.sourceCoverage.some(row => row.uri.includes("untrusted.example")), false);
});

test("stale checkpoint revision is rejected without changing the persisted checkpoint", () => {
  const initial = buildCheckpoint();
  const before = clone(initial.checkpoint);
  const result = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 0,
    sourceRefresh: refresh([{ id: "CAPABILITY", status: "DONE" }]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "STALE_CHECKPOINT_REVISION");
  assert.deepEqual(result.checkpoint, before);
});

test("inventory source revision conflict rejects a stale sparse refresh", () => {
  const initial = buildCheckpoint();
  const before = clone(initial.checkpoint);
  const result = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 1,
    sourceRefresh: refresh([{ id: "CAPABILITY", status: "DONE" }], {
      expectedPriorRevision: "jira-snapshot/older",
      sourceRevision: "jira-snapshot/next",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVENTORY_SOURCE_REVISION_CONFLICT");
  assert.deepEqual(result.checkpoint, before);
});

test("scope revision changes fail closed until a trusted verifier is configured", () => {
  const initial = buildCheckpoint();
  const revisedScope = {
    ...approvedScope,
    scopeRevision: "RPL-112/comment/next",
    source: { ...approvedScope.source, revision: "RPL-112/comment/next" },
    items: approvedScope.items.slice(0, 7),
  };
  const rejected = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 1,
    scope: revisedScope,
    sourceRefresh: null,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "SCOPE_CHANGE_REQUIRES_TRUSTED_VERIFIER");
  assert.equal(rejected.checkpoint.inventory.length, 8);

  const sourceRevisionChanged = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 1,
    sourceRefresh: refresh([], {
      sourceUri: OWNER_SCOPE_URI,
      expectedPriorRevision: OWNER_SCOPE_REVISION,
      sourceRevision: "RPL-112/comment/newer",
      coverage: "COMPLETE",
    }),
  });
  assert.equal(sourceRevisionChanged.ok, false);
  assert.equal(sourceRevisionChanged.reason, "SCOPE_SOURCE_REVISION_MISMATCH_REQUIRES_NEW_SCOPE_REVISION");
});

test("scope membership cannot change under the same scope revision", () => {
  const initial = buildCheckpoint();
  const mutatedScope = { ...approvedScope, items: approvedScope.items.slice(0, 7) };
  const result = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 1,
    scope: mutatedScope,
    sourceRefresh: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SCOPE_CONTENT_MISMATCH_REQUIRES_NEW_REVISION");
  assert.equal(result.checkpoint.inventory.filter(row => row.scopeMember).length, 8);
});

test("approved-scope coverage cannot change under the same scope revision", () => {
  const initial = buildCheckpoint();
  const changedCoverage = {
    ...approvedScope,
    source: { ...approvedScope.source, coverage: "PARTIAL_DISCOVERY" },
  };
  const result = buildCheckpoint({
    currentCheckpoint: initial.checkpoint,
    expectedCheckpointRevision: 1,
    scope: changedCoverage,
    sourceRefresh: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SCOPE_CONTENT_MISMATCH_REQUIRES_NEW_REVISION");
});

test("partial source coverage blocks DONE even when all known work is DONE", () => {
  const doneScope = {
    ...approvedScope,
    source: { ...approvedScope.source, coverage: "PARTIAL_DISCOVERY" },
  };
  const result = buildCheckpoint({
    scope: doneScope,
    sourceRefresh: refresh(approvedScope.items.map(entry => ({ id: entry.id, status: "DONE" }))),
    nextReadyId: null,
    stopReason: "PARTIAL_DISCOVERY",
  });
  assert.equal(result.ok, true);
  assert.equal(result.checkpoint.statusSummary.DONE, 8);
  assert.equal(result.checkpoint.scopeCoverage, "PARTIAL_DISCOVERY");
  assert.equal(result.checkpoint.goalDoneEligible, false);
  assert.equal(result.checkpoint.stopReason, "PARTIAL_DISCOVERY");
});

test("checkpoint rejects unbounded payload fields and unknown stop reasons", () => {
  const withSecret = buildCheckpoint({ recentExecution: null });
  assert.equal(withSecret.ok, true);
  assert.equal("prompt" in withSecret.checkpoint, false);
  const invalid = createF4ScopePreservingCheckpoint({
    approvedScope,
    currentCheckpoint: null,
    expectedCheckpointRevision: null,
    refresh: null,
    recentExecution: null,
    nextReadyId: null,
    stopReason: "raw conversation text",
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "INVALID_CHECKPOINT_INPUT");
});

test("invalid checkpoint payload is not echoed and COMPLETE source requires a revision", () => {
  const initial = buildCheckpoint();
  const invalidCheckpoint = { ...initial.checkpoint, prompt: "secret-marker" };
  const result = createF4ScopePreservingCheckpoint({
    approvedScope,
    currentCheckpoint: invalidCheckpoint,
    expectedCheckpointRevision: 1,
    refresh: null,
    recentExecution: null,
    nextReadyId: null,
    stopReason: "PARTIAL_DISCOVERY",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVALID_CHECKPOINT_INPUT");
  assert.equal(result.checkpoint, null);

  let getterCalls = 0;
  const accessorInput = {
    get approvedScope() {
      getterCalls += 1;
      return approvedScope;
    },
    currentCheckpoint: null,
    expectedCheckpointRevision: null,
    refresh: null,
    recentExecution: null,
    nextReadyId: null,
    stopReason: null,
  };
  const accessorResult = createF4ScopePreservingCheckpoint(accessorInput);
  assert.equal(accessorResult.ok, false);
  assert.equal(getterCalls, 0);

  const duplicate = clone(initial.checkpoint);
  duplicate.inventory.push({ ...item(duplicate, "F1"), scopeMember: false });
  const duplicateResult = createF4ScopePreservingCheckpoint({
    approvedScope,
    currentCheckpoint: duplicate,
    expectedCheckpointRevision: 1,
    refresh: null,
    recentExecution: null,
    nextReadyId: null,
    stopReason: "PARTIAL_DISCOVERY",
  });
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicateResult.reason, "INVALID_CHECKPOINT_INPUT");
  assert.equal(duplicateResult.checkpoint, null);

  const noRevision = buildCheckpoint({
    sourceRefresh: refresh(allEightObservations, { sourceRevision: null }),
  });
  assert.equal(noRevision.ok, false);
  assert.equal(noRevision.reason, "INVALID_CHECKPOINT_INPUT");

  const nonCanonicalPort = {
    ...approvedScope,
    source: { ...approvedScope.source, uri: "https://ranikunlabs.atlassian.net:444/browse/RPL-112" },
  };
  const portResult = buildCheckpoint({ scope: nonCanonicalPort });
  assert.equal(portResult.ok, false);
  assert.equal(portResult.reason, "INVALID_CHECKPOINT_INPUT");
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
