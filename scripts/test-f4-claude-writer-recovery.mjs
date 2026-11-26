import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recoverF4ClaudeWriter } from "./lib/f4-claude-writer-recovery.mjs";

const workspace = await mkdtemp(path.join(tmpdir(), "f4-claude-recovery-"));
try {
  const identity = (kind, char) => `phr1.${kind}.test.${char.repeat(43)}`;
  const scope = { taskRef: "TASK-1", repositoryId: identity("repository", "r"), worktreeId: identity("worktree", "w") };
  const sessionId = identity("session", "a");
  const writer = { ...scope, role: "writer", status: "active", runtimeId: "claude", sessionId, workspaceRef: workspace };
  let revision = 2;
  let lists = 0;
  let failure;
  const dir = await realpath(workspace);
  const options = {
    scope, task: { id: scope.taskRef },
    associationStore: { read: () => ({ revision, associations: [writer] }) },
    sessionIdentityDeriver: ({ raw_session_id }) => ({
      ok: true, identity: raw_session_id === "native_session" ? sessionId : identity("session", "b"),
    }),
    loadSdk: async () => ({
      listSessions: args => {
        lists += 1;
        assert.deepEqual(args, { dir, limit: 513, includeWorktrees: false });
        if (failure === "lost") throw new Error("lookup unavailable");
        if (failure === "drift") revision += 1;
        return [{ sessionId: failure === "different" ? "other_session" : "native_session" }];
      },
      query: () => assert.fail("recovery must not start a model turn"),
    }),
  };
  const recover = () => recoverF4ClaudeWriter(options);
  const results = await Promise.all([recover(), recover()]);
  assert.equal(lists, 2);
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.deepEqual(result.session, { runtime_id: "claude", session_identity: sessionId });
    assert.equal(result.associationRevision, 2);
  }
  for (const reason of ["lost", "different", "drift"]) {
    failure = reason;
    assert.deepEqual(await recover(), { ok: false, reason: "recovery_required" });
  }
  failure = undefined;
  assert.equal((await recover()).ok, true);
  writer.runtimeId = "codex";
  const previousLists = lists;
  assert.deepEqual(await recover(), { ok: false, reason: "recovery_required" });
  assert.equal(lists, previousLists);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
console.log("F4 Claude Writer recovery PASS");
