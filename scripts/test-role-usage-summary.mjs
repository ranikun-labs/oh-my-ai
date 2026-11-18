#!/usr/bin/env node

import assert from "node:assert/strict";
import { boundedJsonlLines, summarizeCodexExecJsonl, USAGE_FIELDS } from "./lib/role-usage-summary.mjs";

const callerScope = { role: "Writer", agentId: "agent-writer-1", runId: "run-single-stream-1" };
for (const lines of [[], [JSON.stringify({type:'thread.started'})]]) {
  const empty = await summarizeCodexExecJsonl(lines, callerScope);
  assert.equal(empty.schema_conformance, 'NO_USAGE_RECORD_OBSERVED');
  assert.equal(empty.sum_of_received_records_may_include_duplicates.input_tokens, 'UNKNOWN');
}
const usage = {
  input_tokens: 19,
  cached_input_tokens: 4,
  cache_write_input_tokens: 2,
  output_tokens: 8,
  reasoning_output_tokens: 3,
};
const usageLine = JSON.stringify({ type: "turn.completed", usage });
const nonUsageBodySentinel = "synthetic-only-nonusage-body";
const syntheticJsonl = [
  JSON.stringify({ type: "thread.started", thread_id: "synthetic-thread-id" }),
  JSON.stringify({ type: "item.completed", item: { text: nonUsageBodySentinel } }),
  JSON.stringify({ type: "turn.started" }),
  usageLine,
  usageLine,
];

const summary = await summarizeCodexExecJsonl(syntheticJsonl, callerScope);
assert.equal(summary.observed_turn_completed_record_count, 2);
assert.deepEqual(summary.observed_usage_records, [
  { stream_record_index: 1, usage, missing_required_fields: [] },
  { stream_record_index: 2, usage, missing_required_fields: [] },
]);
assert.deepEqual(summary.sum_of_received_records_may_include_duplicates, {
  input_tokens: "38",
  cached_input_tokens: "8",
  cache_write_input_tokens: "4",
  output_tokens: "16",
  reasoning_output_tokens: "6",
});
assert.equal(summary.event_identity.deduplication, "NOT_PERFORMED");
assert.equal(summary.event_identity.unique_turn_count, "UNKNOWN");
assert.equal(summary.event_identity.unique_usage_totals, "UNKNOWN");
assert.equal(summary.event_identity.cross_call_usage_totals, "UNKNOWN");
assert.deepEqual(summary.caller_scope, {
  role: "Writer",
  agent_id: "agent-writer-1",
  run_id: "run-single-stream-1",
  basis: "caller_asserted_single_stdin_stream",
});
const serialized = JSON.stringify(summary);
assert.doesNotMatch(serialized, new RegExp(nonUsageBodySentinel));
assert.doesNotMatch(serialized, /synthetic-thread-id|thread\.started|item\.completed|turn\.started/);
assert.equal(summary.non_usage_event_bodies, "NOT_RETAINED_OR_OUTPUT");

for (const field of ["reasoning_output_tokens", "cache_write_input_tokens"]) {
  const incompleteUsage = { ...usage };
  delete incompleteUsage[field];
  const partial = await summarizeCodexExecJsonl(
    [JSON.stringify({ type: "turn.completed", usage: incompleteUsage })],
    callerScope,
  );
  assert.equal(partial.schema_conformance, "NONCONFORMANT_PARTIAL_MISSING_REQUIRED_FIELDS");
  assert.equal(partial.observed_usage_records[0].usage[field], "UNKNOWN");
  assert.deepEqual(partial.missing_required_usage_fields, [field]);
  assert.equal(partial.sum_of_received_records_may_include_duplicates[field], "UNKNOWN");
  for (const knownField of USAGE_FIELDS.filter((candidate) => candidate !== field)) {
    assert.equal(partial.observed_usage_records[0].usage[knownField], usage[knownField]);
  }
}

const noUsageObject = await summarizeCodexExecJsonl(
  [JSON.stringify({ type: "turn.completed" })],
  callerScope,
);
assert.equal(noUsageObject.schema_conformance, "NONCONFORMANT_PARTIAL_MISSING_REQUIRED_FIELDS");
assert.deepEqual(noUsageObject.missing_required_usage_fields, USAGE_FIELDS);
assert.ok(USAGE_FIELDS.every((field) => noUsageObject.observed_usage_records[0].usage[field] === "UNKNOWN"));

for (const invalidValue of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0"]) {
  const invalidUsage = { ...usage, input_tokens: invalidValue };
  await assert.rejects(
    () => summarizeCodexExecJsonl([JSON.stringify({ type: "turn.completed", usage: invalidUsage })], callerScope),
    /usage\.input_tokens is malformed/,
  );
}
await assert.rejects(
  () => summarizeCodexExecJsonl([JSON.stringify({ type: "turn.completed", usage: null })], callerScope),
  /turn.completed usage is malformed/,
);

await assert.rejects(
  () => summarizeCodexExecJsonl([`{"type":"turn.completed","usage":${nonUsageBodySentinel}}`], callerScope),
  /invalid JSONL event at line 1/,
);
await assert.rejects(
  () => summarizeCodexExecJsonl([usageLine], { role: "Writer", agentId: "agent-writer-1" }),
  /run_id must be supplied by the caller/,
);
await assert.rejects(
  () => summarizeCodexExecJsonl([usageLine, usageLine], callerScope, { maxUsageRecords: 1 }),
  /local usage-record limit/,
);
await assert.rejects(
  () => summarizeCodexExecJsonl([usageLine], callerScope, { maxLineBytes: 8 }),
  /local line limit/,
);

let chunksRequested = 0;
const overlongLine = {
  async *[Symbol.asyncIterator]() {
    chunksRequested += 1;
    yield Buffer.from("12345");
    chunksRequested += 1;
    yield Buffer.from("67890\n");
  },
};
await assert.rejects(
  async () => {
    for await (const line of boundedJsonlLines(overlongLine, { maxLineBytes: 4 })) void line;
  },
  /JSONL line 1 exceeds the local line limit/,
);
assert.equal(chunksRequested, 1, "the reader must reject an overlong partial line before requesting another chunk");

let byteLimitChunksRequested = 0;
const overlongStream = {
  async *[Symbol.asyncIterator]() {
    byteLimitChunksRequested += 1;
    yield Buffer.from("a\n");
    byteLimitChunksRequested += 1;
    yield Buffer.from("b\n");
  },
};
await assert.rejects(
  async () => {
    for await (const line of boundedJsonlLines(overlongStream, { maxInputBytes: 3 })) void line;
  },
  /JSONL stream exceeds the local byte limit/,
);
assert.equal(byteLimitChunksRequested, 2, "the total byte limit must reject the chunk that crosses the cap");

const firstInvocation = await summarizeCodexExecJsonl([usageLine], callerScope);
const secondInvocation = await summarizeCodexExecJsonl([usageLine], callerScope);
assert.equal(firstInvocation.observed_turn_completed_record_count, 1);
assert.equal(secondInvocation.observed_turn_completed_record_count, 1);
assert.equal(firstInvocation.event_identity.cross_call_usage_totals, "UNKNOWN");
assert.equal(secondInvocation.event_identity.cross_call_usage_totals, "UNKNOWN");
assert.equal(USAGE_FIELDS.length, 5);

console.log("role usage JSONL fixture and edge cases passed");
