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
// Row-level binding protects each situation's own trigger and required content.
const rowGuards = [
  [
    "STOPPED / HANDOFF",
    "Actual interruption or handoff, including a material blocker",
    "Completed scope and user effect; current PR/HEAD; verified tests and NOT_RUN; blocker, remaining work, responsible role, and exact resume condition."
  ],
  [
    "REVIEW_PENDING",
    "Implementation and required pre-review verification finished; independent review is next",
    "User effect and actual changed scope; PR/fixed HEAD; test/CI evidence; review scope, remaining gates and next action."
  ],
  [
    "DELTA_REVIEW_PENDING",
    "Required findings corrected and affected verification finished; independent delta review is next",
    "Findings and actual corrections; reviewed old HEAD and new HEAD; affected tests/CI; delta review scope and remaining gates."
  ],
  [
    "COMPLETED",
    "Original Acceptance Criteria and required acceptance proven, including verified target branch and merge SHA when merged Source is required",
    "User effect; PR and actual Merge SHA when applicable; verification and independent review; acceptance and Runtime/apply/deployment states; remaining separately owned work or none."
  ]
];
// Match complete safety clauses rather than an isolated keyword.
const safetyGuards = [
  [
    "publication deduplication",
    "flow",
    "Do not post a duplicate, replace existing comments, or retry an ambiguous write;"
  ],
  [
    "ambiguous write state",
    "flow",
    "retain the exact proposed text and report the resulting state as unknown if readback cannot establish it."
  ],
  [
    "comment readback",
    "flow",
    "Record only the approved delta, and verify the stored comment or transition separately."
  ],
  [
    "hook no authority",
    "flow",
    "A Hook or SessionEnd event grants no write authority."
  ],
  [
    "sync ambiguous write prohibition",
    "sync",
    "Do not retry a write when its response or acknowledgement is missing, timed out, or ambiguous."
  ],
  [
    "sync ambiguous result readback",
    "sync",
    "Perform a read-only check of the exact target and affected fields if possible; report `UNKNOWN` if the resulting state cannot be established."
  ],
  [
    "sync stored value verification",
    "sync",
    "Confirm that the stored values match the approved proposal and inspect the returned version or concurrency marker."
  ],
  [
    "sync unavailable readback",
    "sync",
    "If scoped readback is unavailable, do not claim the update succeeded."
  ]
];
function missingClosureContract(flow, sync) {
  const start = flow.indexOf("#### Jira closure comment draft (existing Primary only)");
  const end = flow.indexOf("### 4. Enter the existing F4 playbook", start);
  const body = start >= 0 && end > start ? flow.slice(start, end) : "";
  const failures = guards.filter(([, ...terms]) => terms.some(term => !body.includes(term))).map(([name]) => name);
  for (const [name, marker] of syncGuards) if (!sync.includes(marker)) failures.push(name);
  for (const [label, when, content] of rowGuards) {
    const rows = body.split(/\r?\n/).filter(line => line.startsWith("|")).map(line => line.split("|").slice(1, -1).map(cell => cell.trim())).filter(cells => cells[0] === label);
    if (rows.length !== 1 || rows[0].length !== 3 || rows[0][1] !== when || rows[0][2] !== content) failures.push("row " + label);
  }
  for (const [name, scope, clause] of safetyGuards) {
    if (!(scope === "flow" ? body : sync).includes(clause)) failures.push(name);
  }
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
  const mutations = [
    ["publication deduplication", "flow", "Do not post a duplicate, ", ""],
    ["publication deduplication", "flow", "Do not post a duplicate, replace existing comments, or retry an ambiguous write;", "Do not post a duplicate or replace existing comments; retry an ambiguous write;"],
    ["comment readback", "flow", "Record only the approved delta, and verify the stored comment or transition separately.", "Record only the approved delta."],
    ["hook no authority", "flow", "A Hook or SessionEnd event grants no write authority.", "A Hook or SessionEnd event grants write authority."],
    ["sync ambiguous write prohibition", "sync", "Do not retry a write when its response or acknowledgement is missing, timed out, or ambiguous.", "Do retry a write when its response or acknowledgement is missing, timed out, or ambiguous."],
    ["sync stored value verification", "sync", "Confirm that the stored values match the approved proposal and inspect the returned version or concurrency marker.", ""],
    ["sync unavailable readback", "sync", "If scoped readback is unavailable, do not claim the update succeeded.", "If scoped readback is unavailable, claim the update succeeded."],
  ];
  for (const [name, scope, marker, replacement] of mutations) {
    const original = scope === "flow" ? flow : sync;
    assert(original.includes(marker), "mutation target: " + name);
    const altered = original.replace(marker, replacement);
    assert(missingClosureContract(scope === "flow" ? altered : flow, scope === "sync" ? altered : sync).includes(name), name);
  }
  const reviewContent = rowGuards[1][2];
  const deltaContent = rowGuards[2][2];
  const swapped = flow.replace(reviewContent, "__REVIEW_CONTENT__").replace(deltaContent, reviewContent).replace("__REVIEW_CONTENT__", deltaContent);
  const swappedFailures = missingClosureContract(swapped, sync);
  assert(swappedFailures.includes("row REVIEW_PENDING") && swappedFailures.includes("row DELTA_REVIEW_PENDING"), "swapped REVIEW/DELTA content");
  return guards.length + syncGuards.length + mutations.length + 1;
}

const flow = fs.readFileSync(new URL("../skills/dev-main-flow/SKILL.md", import.meta.url), "utf8");
const sync = fs.readFileSync(new URL("../skills/work-record-sync/SKILL.md", import.meta.url), "utf8");
const count = runContractChecks(flow, sync, assert.ok);
console.log("passed: Jira closure draft source contract and " + count + " deletion/mutation regressions (structural only)");
