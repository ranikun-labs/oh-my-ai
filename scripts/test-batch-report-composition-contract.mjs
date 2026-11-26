// Structural contract only; this does not invoke a model, Agent, Hook or Runtime.
import assert from "node:assert/strict";
import fs from "node:fs";
const read = path => fs.readFileSync(new URL("../" + path, import.meta.url), "utf8");
const f4 = read("skills/adaptive-goal-closure/SKILL.md");
const flow = read("skills/dev-main-flow/SKILL.md");
const batch = read("skills/batch-report/SKILL.md");
const plan = read("docs/harness/batch-report-composition.md");
const start = "## Parallel result reporting";
const end = "## Remote mutation and completion gates";
const section = text => {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  return a >= 0 && b > a ? text.slice(a, b) : "";
};
const guards = [
  ["explicit F4", "Only within an explicitly authorized F4 execution"],
  ["parallel only", "at least two independent agent tasks"],
  ["real source", "Read the actual source"],
  ["no separate agent", "Do not spawn a separate batch-report Agent."],
  ["start before dispatch", "Before dispatch of the batch, apply its `start` mode once"],
  ["short progress", "instead of separate long reports"],
  ["resume", "reuse the existing batch reference and checkpoint"],
  ["checkpoint", "At a required checkpoint apply `checkpoint`"],
  ["single final", "at terminal fan-in apply `final` once"],
  ["ledger", "Preserve the batch-report ledger"],
  ["unknown", "Do not promote missing evidence to PASS."],
  ["urgent gate", "important blockers, handoffs, recovery, AttemptOutcome and required checkpoints are not deferred"],
  ["no duplicate report", "do not append a second full report"],
  ["role isolation", "does not authorize Main to re-run Writer tests"],
  ["native evidence", "Native Apply only with observed Runtime evidence"],
  ["manual apply", "record `MANUAL_READ_APPLY`"],
  ["unavailable source", "record the batch-report stage as `BLOCKED/NOT_RUN`"],
  ["no false apply", "Do not claim the Skill was applied."],
  ["runtime notifications", "are not Main progress reports and are not suppressed by this Skill."]
];
const failures = text => guards.filter(([, clause]) => !section(text).includes(clause)).map(([name]) => name);
assert.deepEqual(failures(f4), []);
for (const [name, clause] of guards) {
  const original = section(f4);
  assert.ok(original.includes(clause), name);
  assert.ok(failures(f4.replace(original, original.replace(clause, ""))).includes(name), name);
}
assert.ok(flow.includes("the F4 playbook owns the `batch-report` composition (start, checkpoint and final)"));
assert.ok(flow.includes("use that one aggregate as the input to this fan-in"));
assert.ok(flow.includes("important blockers, security issues, Owner Gate items, handoffs, recovery, AttemptOutcome and required checkpoints are not deferred"));
assert.ok(batch.includes("disable-model-invocation: true"));
assert.ok(batch.includes("다른 workflow가 참조해 쓴다"));
assert.ok(plan.includes("정본 표 (보고 타이밍 소유 경계, 단일 원본)"));
assert.ok(f4.includes("**No Main takeover.**") && f4.includes("**Evidence reuse, not duplicate execution.**"));
console.log("PASS: batch-report composition source contract, " + guards.length + " deletion regressions and consumer/ownership checks (structural only)");
