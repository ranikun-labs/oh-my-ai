import { handoffF4Writer, recoverF4Writer } from "./lib/f4-writer-continuation.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskSessionAssociationStore } from "./lib/task-session-association.mjs";

import { bindTaskWriterSessionResolution } from "./lib/task-session-resume-resolution.mjs";

const directory = mkdtempSync(path.join(tmpdir(), "task-association-"));
const identity = (kind, character) => `phr1.${kind}.test.${character.repeat(43)}`;
const scope = {
  taskRef: "TASK-1",
  repositoryId: identity("repository", "r"),
  worktreeId: identity("worktree", "w"),
};
const first = { runtimeId: "codex", sessionId: identity("session", "a"), role: "writer" };
const second = { ...first, sessionId: identity("session", "b") };
const open = () => createTaskSessionAssociationStore({
  cwd: process.cwd(), stateRootOptions: { stateRootOverride: directory },
});

try {
  const store = open();
  assert.equal(store.link(scope, { ...first, expectedRevision: 0 }).revision, 1);
  assert.deepEqual(open().read(scope).associations, [{ ...first, status: "active" }]);
  assert.equal(store.link(scope, { ...first, expectedRevision: 0 }).revision, 1);
  assert.throws(() => store.link(scope, { ...second, expectedRevision: 0 }), /association_revision_conflict/);
  assert.throws(() => store.link(scope, { ...second, expectedRevision: 1 }), /association_active_writer_exists/);
  store.setStatus(scope, { ...first, status: "paused", expectedRevision: 1 });
  store.link(scope, { ...second, expectedRevision: 2 });
  assert.throws(() => store.setStatus(scope, { ...first, status: "active", expectedRevision: 3 }),
    /association_active_writer_exists/);
  store.setStatus(scope, { ...first, status: "completed", expectedRevision: 3 });
  assert.throws(() => store.setStatus(scope, { ...first, status: "active", expectedRevision: 4 }),
    /association_transition_invalid/);
  assert.throws(() => store.link(scope, { ...first, sessionId: "raw-thread", expectedRevision: 4 }),
    /association_record_invalid/);
  assert.equal(open().read({ ...scope, taskRef: "TASK-2" }).associations.length, 0);
  assert.deepEqual(open().read(scope).associations.map(record => record.status), ["completed", "active"]);
  const request = { runtime_id: "codex", session_identity: second.sessionId };
  let observations = 0;
  let runtimeResult = { ok: true, value: request };
  const resolution = bindTaskWriterSessionResolution({
    associationStore: store,
    scope,
    sessionResolution: {
      resolveCurrentSession: () => runtimeResult,
      resolveTargetSession: async () => {
        observations += 1;
        return runtimeResult;
      },
    },
  });
  assert.deepEqual(await resolution.resolveTargetSession({ ...request, session_identity: first.sessionId }),
    { ok: false, reason: "session_resolution_denied" });
  assert.equal(observations, 0);
  assert.deepEqual(await resolution.resolveTargetSession(request), runtimeResult);
  runtimeResult = { ok: false, reason: "session_resolution_not_found" };
  assert.deepEqual(await resolution.resolveTargetSession(request), runtimeResult);

  const pending = resolution.resolveTargetSession(request);
  store.setStatus(scope, { ...second, status: "paused", expectedRevision: 4 });
  assert.deepEqual(await pending, { ok: false, reason: "session_resolution_stale" });
  const abandoned = { ...scope, taskRef: "TASK-3" };
  store.link(abandoned, { ...first, expectedRevision: 0 });
  assert.throws(() => store.replaceWriter(abandoned, {
    previous: first, successor: second, expectedRevision: 0,
  }), /association_revision_conflict/);
  const handoff = store.replaceWriter(abandoned, {
    previous: first, successor: second, expectedRevision: 1,
  });
  assert.equal(handoff.revision, 2);
  assert.equal(store.withCurrentWriter(abandoned, { ...first, revision: 1 },
    () => assert.fail("detached Writer must not publish")), "pending");
  assert.equal(store.withCurrentWriter(abandoned, { ...second, revision: 2 },
    () => "applied"), "applied");
  assert.deepEqual(open().read(abandoned).associations, [
    { ...first, status: "detached" }, { ...second, status: "active" },
  ]);
  assert.equal(open().read(scope).associations[0].status, "completed");
  // Exercise the real Association lock and a synchronous filesystem CAS
  // using independent store handles. The file is isolated test data.
  const inventoryPath = path.join(directory, "test-inventory.json");
  writeFileSync(inventoryPath, JSON.stringify({ revision: 1, status: "READY" }));
  const readInventory = () => JSON.parse(readFileSync(inventoryPath, "utf8"));
  const publishInventory = () => {
    if (readInventory().revision !== 1) return "pending";
    writeFileSync(inventoryPath, JSON.stringify({ revision: 2, status: "DONE" }));
    return "applied";
  };
  const inFlight = { ...scope, taskRef: "TASK-4" };
  store.link(inFlight, { ...first, expectedRevision: 0 });
  assert.equal(store.withCurrentWriter(inFlight, { ...first, revision: 1 },
    async () => publishInventory()), "pending");
  assert.equal(readInventory().status, "READY");

  const delayedPublication = Promise.resolve().then(() =>
    store.withCurrentWriter(inFlight, { ...first, revision: 1 }, publishInventory));
  open().replaceWriter(inFlight, { previous: first, successor: second, expectedRevision: 1 });
  assert.equal(await delayedPublication, "pending");
  assert.deepEqual(readInventory(), { revision: 1, status: "READY" });
  assert.equal(store.withCurrentWriter(inFlight, { ...second, revision: 2 }, publishInventory), "applied");
  assert.deepEqual(readInventory(), { revision: 2, status: "DONE" });
  const retryScope = { ...scope, taskRef: "TASK-5" };
  const destinationScope = { ...retryScope, repositoryId: identity("repository", "s"), worktreeId: identity("worktree", "x") };
  store.link(retryScope, { ...first, expectedRevision: 0 });
  const task = { id: retryScope.taskRef, commit: "pinned", checkpoint: "checkpoint" };
  const rejected = await handoffF4Writer({
    scope: retryScope, destinationScope, task, previous: first, successor: second, expectedRevision: 1,
    associationStore: open(),
    restoreWorkspace: async () => ({ taskId: task.id, commit: task.commit, checkpoint: task.checkpoint }),
    withFrozenSource: async (_input, run) => run(),
    acceptHandoff: async () => retryScope,
    discardWorkspace: async () => {},
    launchWriter: () => assert.fail("unaccepted destination must not launch"),
  });
  assert.equal(rejected.reason, "handoff_scope_not_supported");
  assert.equal(store.read(retryScope).revision, 1);
  let launches = 0;
  let discarded = 0;
  const attempt = () => handoffF4Writer({
    scope: retryScope, destinationScope, task, previous: first, successor: second, expectedRevision: 1,
    associationStore: open(),
    restoreWorkspace: async () => ({ taskId: task.id, commit: task.commit, checkpoint: task.checkpoint, workspace: mkdtempSync(path.join(directory, "clone-")) }),
    withFrozenSource: async (_input, run) => run(),
    deriveDestinationScope: ({ workspace }) => ({ ...destinationScope, workspaceRef: workspace.workspace }),
    acceptHandoff: async () => destinationScope,
    discardWorkspace: async () => { discarded += 1; },
    launchWriter: async input => {
      assert.deepEqual(input.associationScope, retryScope);
      assert.deepEqual(input.destinationScope, destinationScope);
      assert.equal(store.withCurrentWriter(retryScope, { ...first, revision: 1 },
        () => assert.fail("old Writer result published")), "pending");
      launches += 1;
      return { ok: true };
    },
  });
  const outcomes = await Promise.all([attempt(), attempt()]);
  assert.equal(launches, 1);
  assert.equal(discarded, 1);
  assert.ok(outcomes.some(result => result.reason === "handoff_already_changed"));
  assert.deepEqual(open().read(retryScope).associations[1], {
    ...second, status: "active", repositoryId: destinationScope.repositoryId, worktreeId: destinationScope.worktreeId,
    workspaceRef: store.read(retryScope).associations[1].workspaceRef,
  });
  assert.ok(store.read(retryScope).associations[1].workspaceRef.startsWith(directory));
  assert.deepEqual(open().read(destinationScope).associations, []);
  store.setStatus(retryScope, { ...second, status: "paused", expectedRevision: 2 });
  assert.equal(open().read(retryScope).associations[1].worktreeId, destinationScope.worktreeId);
  assert.throws(() => store.replaceWriter(retryScope, {
    previous: first, successor: second, expectedRevision: 3,
    destinationScope: { ...destinationScope, taskRef: "OTHER" },
  }), /association_scope_invalid/);
  const recoveryScope = { ...retryScope, taskRef: "TASK-6" };
  const recoveryDestination = { ...destinationScope, taskRef: recoveryScope.taskRef };
  store.link(recoveryScope, { ...first, expectedRevision: 0 });
  const lost = await handoffF4Writer({
    scope: recoveryScope, destinationScope: recoveryDestination,
    task: { ...task, id: recoveryScope.taskRef }, previous: first, successor: second, expectedRevision: 1,
    associationStore: open(),
    withFrozenSource: (_input, run) => run(),
    restoreWorkspace: () => ({ taskId: recoveryScope.taskRef, commit: task.commit,
      checkpoint: task.checkpoint, workspace: directory }),
    deriveDestinationScope: ({ workspace }) => ({ ...recoveryDestination, workspaceRef: workspace.workspace }),
    acceptHandoff: () => recoveryDestination,
    discardWorkspace: () => assert.fail("uncertain launch must retain the workspace"),
    launchWriter: () => { throw new Error("response lost"); },
  });
  assert.equal(lost.reason, "recovery_required");
  assert.equal(lost.associationRevision, 2);
  assert.equal(open().read(recoveryScope).associations.find(record => record.status === "active").workspaceRef, directory);
  let recoveryObservations = 0;
  const recoveredLostLaunch = await recoverF4Writer({ scope: recoveryScope,
    task: { ...task, id: recoveryScope.taskRef }, associationStore: open(),
    observeWriter: request => { recoveryObservations += 1; assert.equal(request.successor.sessionId, second.sessionId);
      return { status: "available", session: "running", sessionIdentity: second.sessionId }; },
    resumeWriter: ({ session }) => ({ ok: true, session }),
  });
  assert.deepEqual(recoveredLostLaunch, { ok: true, session: "running" });
  assert.equal(recoveryObservations, 1);
  // A successful durable save can throw before the caller receives its result.
  const ambiguousScope = { ...scope, taskRef: "TASK-7" };
  const ambiguousDestination = { ...destinationScope, taskRef: ambiguousScope.taskRef };
  const ambiguousTask = { ...task, id: ambiguousScope.taskRef };
  store.link(ambiguousScope, { ...first, expectedRevision: 0 });
  let removed = 0;
  let repeatLaunches = 0;
  const uncertain = await handoffF4Writer({
    scope: ambiguousScope, task: ambiguousTask, previous: first, successor: second, expectedRevision: 1,
    associationStore: { read: store.read, replaceWriter: (...args) => {
      store.replaceWriter(...args); throw new Error("response lost after save");
    } },
    withFrozenSource: (_input, run) => run(),
    restoreWorkspace: () => ({ taskId: ambiguousTask.id, commit: task.commit,
      checkpoint: task.checkpoint, workspace: directory }),
    deriveDestinationScope: ({ workspace }) => ({ ...ambiguousDestination, workspaceRef: workspace.workspace }),
    acceptHandoff: ({ destinationScope: accepted }) => accepted,
    discardWorkspace: () => { removed += 1; },
    launchWriter: () => { repeatLaunches += 1; },
  });
  assert.equal(uncertain.reason, "recovery_required");
  assert.equal(uncertain.workspaceRef, directory);
  assert.equal(uncertain.associationRevision, 2);
  assert.equal(removed, 0);
  assert.equal(repeatLaunches, 0);
  let observedRequest;
  const recover = observeWriter => recoverF4Writer({ scope: ambiguousScope, task: ambiguousTask,
    associationStore: open(), observeWriter,
    resumeWriter: request => ({ ok: true, session: request.session }),
  });
  assert.deepEqual(await recover(request => { observedRequest = request; return { status: "unknown" }; }),
    { ok: false, reason: "recovery_required" });
  assert.equal(observedRequest.successor.sessionId, second.sessionId);
  assert.equal(observedRequest.workspaceRef, directory);
  assert.deepEqual(observedRequest.destinationScope, ambiguousDestination);
  assert.deepEqual(await recover(() => ({ status: "available", session: "wrong", sessionIdentity: first.sessionId })),
    { ok: false, reason: "recovery_required" });
  assert.deepEqual(await recover(() => ({ status: "available", session: "found", sessionIdentity: second.sessionId })),
    { ok: true, session: "found" });
  assert.equal(repeatLaunches, 0);
  const invalidDestination = await handoffF4Writer({
    scope: { ...scope, taskRef: "TASK-8" }, destinationScope: { ...destinationScope, taskRef: "TASK-8" },
    task: { ...task, id: "TASK-8" }, previous: first, successor: second, expectedRevision: 0,
    associationStore: { replaceWriter: () => assert.fail("unverified scope must not be stored") },
    withFrozenSource: (_input, run) => run(),
    restoreWorkspace: () => ({ taskId: "TASK-8", commit: task.commit, checkpoint: task.checkpoint, workspace: directory }),
    deriveDestinationScope: ({ workspace }) => ({ ...scope, taskRef: "TASK-8", workspaceRef: workspace.workspace }),
    acceptHandoff: () => assert.fail("mismatched scope must not be accepted"),
    discardWorkspace: () => {}, launchWriter: () => assert.fail(),
  });
  assert.equal(invalidDestination.reason, "handoff_scope_not_supported");
  const missingDestination = await handoffF4Writer({
    scope: { ...scope, taskRef: "TASK-9" }, destinationScope: { ...destinationScope, taskRef: "TASK-9" },
    task: { ...task, id: "TASK-9" }, previous: first, successor: second, expectedRevision: 0,
    associationStore: { replaceWriter: () => assert.fail("missing workspace must not be stored") },
    withFrozenSource: (_input, run) => run(),
    restoreWorkspace: () => ({ taskId: "TASK-9", commit: task.commit, checkpoint: task.checkpoint }),
    acceptHandoff: () => assert.fail(), discardWorkspace: () => {}, launchWriter: () => assert.fail(),
  });
  assert.equal(missingDestination.reason, "handoff_scope_not_supported");
  console.log("Task-session association and fresh Writer resolution PASS");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
