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
  startWriter: async input => { calls.push(["start", input]); return "started"; },
});
assert.equal(await run("available"), "resumed");
assert.equal(calls[0][1].task, task);
for (const status of ["unavailable", "unknown"]) {
  assert.equal(await run(status), "started");
  const [, input] = calls.at(-1);
  assert.equal(input.task, task);
  assert.equal(input.requireIsolatedWorkspace, true);
  assert.equal(input.previousStatus, status);
}
await assert.rejects(run("unsupported-result"), /writer_observation_invalid/);
console.log("F4 writer continuation decisions PASS");
