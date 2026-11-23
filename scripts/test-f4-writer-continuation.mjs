import assert from "node:assert/strict";
import { continueF4Writer } from "./lib/f4-writer-continuation.mjs";

const task = Object.freeze({
  id: "RPL-120", checkpoint: "checkpoint/1", commit: "abc",
  changes: "patch/1", testEvidence: "tests/1", next: "run remaining tests",
});
const calls = [];
const run = status => continueF4Writer({
  task,
  observeWriter: async () => ({ status, session: "A" }),
  resumeWriter: async input => { calls.push(["resume", input]); return "resumed"; },
  handoffWriter: async input => { calls.push(["handoff", input]); return "handoff_pending"; },
});
assert.equal(await run("available"), "resumed");
assert.equal(calls[0][1].task, task);
assert.deepEqual(await run("unknown"), { ok: false, reason: "recovery_required" });
assert.equal(calls.length, 1);
assert.equal(await run("unavailable"), "handoff_pending");
assert.equal(calls.at(-1)[1].task, task);
await assert.rejects(run("unsupported-result"), /writer_observation_invalid/);
assert.deepEqual(await continueF4Writer({
  task, observeWriter: () => { throw new Error("offline"); },
  resumeWriter: () => assert.fail(), handoffWriter: () => assert.fail(),
}), { ok: false, reason: "recovery_required" });
console.log("F4 writer continuation decisions PASS");

const { handoffF4Writer } = await import("./lib/f4-writer-continuation.mjs");
const scope = { taskRef: task.id, repositoryId: "repo", worktreeId: "worktree" };
const guarded = {
  scope, task,
  associationStore: { replaceWriter: () => assert.fail("assignment must not change") },
  restoreWorkspace: async () => ({ taskId: task.id, commit: task.commit, checkpoint: task.checkpoint }),
  acceptHandoff: () => assert.fail("an expired fence must not reach acceptance"),
  launchWriter: () => assert.fail("launch must not run"),
};
assert.deepEqual(await handoffF4Writer({
  ...guarded, withFrozenSource: async () => ({ ok: true }),
}), { ok: false, reason: "recovery_required" });

assert.deepEqual(await handoffF4Writer({
  ...guarded,
  withFrozenSource: async (_request, prepare) => { prepare(); return { ok: true }; },
  restoreWorkspace: async () => {
    await new Promise(resolve => setImmediate(resolve));
    return { taskId: task.id, commit: task.commit, checkpoint: task.checkpoint };
  },
  discardWorkspace: async () => { throw new Error("cleanup failed"); },
}), { ok: false, reason: "recovery_required", workspaceCleanup: "failed", workspace: undefined });
