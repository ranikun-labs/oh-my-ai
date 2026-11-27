import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = (name) => fileURLToPath(new URL(name, import.meta.url));
const compareScript = script("./compare-pilot-observations.mjs");
const collector = script("./role-usage.mjs");
const conditions = {
  scenario: "fixture", scopeRevision: "ac-v1", risk: "standard",
  runtime: "codex", runtimeVersion: "fixture-version", model: "fixture-model",
  reasoning: "medium", fast: false, window: "from-start-to-acceptance",
  controls: "fixture-v1",
};
const baseline = { mode: "baseline", runId: "run-a", agentId: "writer-a", conditions, metrics: { elapsedMs: 80, sourceReads: 2 } };
const candidate = { mode: "lean", runId: "run-b", agentId: "writer-b", conditions, metrics: { elapsedMs: 70, sourceReads: 0 } };

function run(input) {
  return spawnSync(process.execPath, [compareScript], { input, encoding: "utf8" });
}

function compare(first = baseline, second = candidate) {
  const result = run([first, second].map((row) => JSON.stringify(row)).join("\n"));
  assert.equal(result.stderr, "");
  return { exit: result.status, body: JSON.parse(result.stdout) };
}

const counters = {
  input_tokens: 42, cached_input_tokens: 1, cache_write_input_tokens: 0,
  output_tokens: 5, reasoning_output_tokens: 2,
};

function observed(row, usages) {
  const events = [{ type: "thread.started" }, { type: "turn.started" },
    ...usages.map((usage) => ({ type: "turn.completed", usage }))];
  const collected = spawnSync(process.execPath, [
    collector, "--role", "writer", "--agent-id", row.agentId, "--run-id", row.runId,
  ], { input: events.map((event) => JSON.stringify(event)).join("\n"), encoding: "utf8" });
  assert.equal(collected.status, 0, collected.stderr);
  return { ...row, usageWindow: row.conditions.window, usage: JSON.parse(collected.stdout) };
}

test("matching conditions compare counts, including measured zero", () => {
  const { exit, body } = compare();
  assert.equal(exit, 0);
  assert.equal(body.status, "MATCHED_CONDITIONS");
  assert.deepEqual(body.metrics.elapsedMs, { before: 80, after: 70, delta: -10 });
  assert.deepEqual(body.metrics.sourceReads, { before: 2, after: 0, delta: -2 });
  assert.equal(body.metrics.validationRuns, "UNKNOWN");
  assert.equal(body.officialUsage, "UNKNOWN");
  assert.equal(body.cost, "UNKNOWN");
});

for (const key of Object.keys(conditions)) {
  test(`mismatched or unknown ${key} withholds deltas`, () => {
    const mismatch = { ...conditions, [key]: key === "fast" ? true : "different" };
    const unknown = { ...conditions, [key]: "UNKNOWN" };
    const expected = { exit: 1, body: { status: "NOT_COMPARABLE", reasons: [`conditions.${key}`] } };
    assert.deepEqual(compare(baseline, { ...candidate, conditions: mismatch }), expected);
    assert.deepEqual(compare({ ...baseline, conditions: unknown }, { ...candidate, conditions: unknown }), expected);
  });
}

test("requires a distinct run and an intervention in the same pilot", () => {
  assert.equal(compare(baseline, { ...candidate, runId: baseline.runId }).exit, 1);
  assert.equal(compare(baseline, { ...candidate, mode: "resume" }).exit, 1);
  assert.equal(compare(baseline, { ...candidate, mode: baseline.mode }).exit, 1);
  assert.equal(compare({ ...baseline, mode: "resume" }, { ...candidate, mode: "compact-resume" }).exit, 0);
});

test("compares scoped nonzero counters from the existing collector", () => {
  const before = observed(baseline, [counters]);
  const after = observed(candidate, [{ ...counters, input_tokens: 40 }]);
  const { receivedUsageCounters } = compare(before, after).body;
  assert.deepEqual(receivedUsageCounters.input_tokens, { before: 42, after: 40, delta: -2 });
  assert.equal(receivedUsageCounters.cache_write_input_tokens, "UNKNOWN");

  for (const unavailable of [
    { ...after, usageWindow: undefined },
    { ...after, usageWindow: "another-window" },
    { ...after, agentId: "another-agent" },
    { ...after, agentId: undefined },
    { ...after, runId: "another-run" },
    observed(candidate, [{ input_tokens: 40 }]),
    observed(candidate, [counters, counters]),
    observed(candidate, [Object.fromEntries(Object.keys(counters).map((key) => [key, 0]))]),
  ]) {
    assert.ok(Object.values(compare(before, unavailable).body.receivedUsageCounters)
      .every((value) => value === "UNKNOWN"));
  }

  const otherRuntime = { ...conditions, runtime: "claude" };
  assert.equal(compare({ ...before, conditions: otherRuntime }, { ...after, conditions: otherRuntime })
    .body.receivedUsageCounters.input_tokens, "UNKNOWN");
});

test("detailed UNKNOWN reasoning withholds all deltas", () => {
  const unknown = { ...conditions, reasoning: "UNKNOWN_not_present_in_turn.completed_usage" };
  assert.deepEqual(compare({ ...baseline, conditions: unknown }, { ...candidate, conditions: unknown }), {
    exit: 1, body: { status: "NOT_COMPARABLE", reasons: ["conditions.reasoning"] },
  });
});

const invalidEvidence = [
  ["different caller roles", (usage) => { usage.caller_scope.role = "reviewer"; }],
  ["source and scope mismatch", (usage) => {
    usage.source = "codex exec --json child stdout; allowlisted usage fields only";
  }],
  ["object in place of the observation array", (usage) => {
    usage.observed_usage_records = { ...usage.observed_usage_records, length: 1 };
  }],
  ["partial declaration with complete counters", (usage) => {
    usage.schema_conformance = "NONCONFORMANT_PARTIAL_MISSING_REQUIRED_FIELDS";
    usage.missing_required_usage_fields = ["input_tokens"];
    usage.observed_usage_records[0].missing_required_fields = ["input_tokens"];
  }],
  ["missing fields in a conformant record", (usage) => {
    usage.observed_usage_records[0].missing_required_fields = ["input_tokens"];
  }],
  ["invalid single-record index", (usage) => { usage.observed_usage_records[0].stream_record_index = 2; }],
];

for (const [name, change] of invalidEvidence) {
  test(`withholds usage deltas for ${name}`, () => {
    const before = observed(baseline, [counters]);
    const after = observed(candidate, [{ ...counters, input_tokens: 40 }]);
    change(after.usage);
    const { receivedUsageCounters, officialUsage, cost } = compare(before, after).body;
    assert.ok(Object.values(receivedUsageCounters).every((value) => value === "UNKNOWN"));
    assert.equal(officialUsage, "UNKNOWN");
    assert.equal(cost, "UNKNOWN");
  });
}

test("rejects invalid input without exposing it", () => {
  for (const input of ["", "private malformed input", "[]\n{}", "{}\n{}\n{}", "x".repeat(1024 * 1024 + 1)]) {
    const result = run(input);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Expected two bounded JSONL observation rows\./);
  }
});
