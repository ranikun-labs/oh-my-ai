// Structural source contract only; not a Native Runtime or Jira mutation test.
import assert from "node:assert/strict";
import fs from "node:fs";
const guards = [
  [
    "stopped/handoff",
    "| STOPPED / HANDOFF |",
    "exact resume condition"
  ],
  [
    "review pending",
    "| REVIEW_PENDING |",
    "independent review is next"
  ],
  [
    "delta pending",
    "| DELTA_REVIEW_PENDING |",
    "reviewed old HEAD and new HEAD"
  ],
  [
    "completed",
    "| COMPLETED |",
    "Original Acceptance Criteria and required acceptance proven"
  ],
  [
    "deduplicate",
    "do not repeat the same state and evidence"
  ],
  [
    "urgent update",
    "required checkpoints are not deferred"
  ],
  [
    "draft-only",
    "A comment draft is not publication, a Jira transition, or write approval."
  ],
  [
    "exact authority",
    "exact target, action (append comment), content approval"
  ],
  [
    "fresh check",
    "immediately before any approved write"
  ],
  [
    "no retry",
    "retry an ambiguous write"
  ],
  [
    "read-only",
    "must not publish it"
  ],
  [
    "separate Done",
    "Done is a separate approved transition",
    "exact transition authority"
  ],
  [
    "no new engine",
    "No new Skill, record engine, ledger, or automatic Jira write"
  ]
];
const syncGuards = [
  [
    "sync approval",
    "It never writes automatically"
  ],
  [
    "sync concurrency",
    "Immediately before a write"
  ],
  [
    "sync readback",
    "After a clear write response"
  ],
  [
    "sync no retry",
    "Do not retry a write"
  ]
];
function missingClosureContract(flow, sync) {
  const start = flow.indexOf("#### Jira closure comment draft (existing Primary only)");
  const end = flow.indexOf("### 4. Enter the existing F4 playbook", start);
  const body = start >= 0 && end > start ? flow.slice(start, end) : "";
  const failures = guards.filter(([, ...terms]) => terms.some(term => !body.includes(term))).map(([name]) => name);
  for (const [name, marker] of syncGuards) if (!sync.includes(marker)) failures.push(name);
  return failures;
}
function runContractChecks(flow, sync, assert) {
  assert(missingClosureContract(flow, sync).length === 0, "baseline source contract");
  for (const [name, marker] of guards) {
    assert(missingClosureContract(flow.replace(marker, ""), sync).includes(name), name);
  }
  for (const [name, marker] of syncGuards) {
    assert(missingClosureContract(flow, sync.replace(marker, "")).includes(name), name);
  }
  return guards.length + syncGuards.length;
}

const flow = fs.readFileSync(new URL("../skills/dev-main-flow/SKILL.md", import.meta.url), "utf8");
const sync = fs.readFileSync(new URL("../skills/work-record-sync/SKILL.md", import.meta.url), "utf8");
const count = runContractChecks(flow, sync, assert.ok);
console.log("passed: Jira closure draft source contract and " + count + " deletion regressions (structural only)");
