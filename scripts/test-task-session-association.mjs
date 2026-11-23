import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  console.log("Task-session association and fresh Writer resolution PASS");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
