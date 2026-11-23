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
