#!/usr/bin/env node

import { boundedJsonlLines, CODEX_SCHEMA_REVISION, USAGE_FIELDS } from "./lib/role-usage-summary.mjs";

const UNKNOWN = "UNKNOWN";
const CONDITIONS = [
  "scenario", "scopeRevision", "risk", "runtime", "runtimeVersion",
  "model", "reasoning", "fast", "window", "controls",
];
const METRICS = [
  "elapsedMs", "sourceReads", "validationRuns", "reworkCount",
  "agentInvocations", "coordinationCalls", "reports",
];
const MODES = [
  ["baseline", "lean"],
  ["resume", "compact-resume", "handoff"],
];

const isKnownText = (value) =>
  typeof value === "string" && value.length > 0 && value === value.trim() &&
  !/^(unknown\b|unknown_|(?:not_run|unsupported|n\/a)$)/i.test(value);
const isScopeValue = (value) =>
  isKnownText(value) && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function observedUsage(observation, role) {
  const usage = observation.usage;
  const scope = usage?.caller_scope;
  // The caller must establish that the received snapshot covers this window.
  // A resumed process can otherwise include usage from earlier turns.
  if (observation.conditions.runtime !== "codex" || !isScopeValue(observation.agentId) ||
      observation.usageWindow !== observation.conditions.window ||
      usage?.source !== "codex exec --json JSONL supplied on stdin" ||
      scope?.basis !== "caller_asserted_single_stdin_stream" ||
      !isScopeValue(role) || scope.role !== role ||
      scope.run_id !== observation.runId || scope.agent_id !== observation.agentId ||
      usage.schema_reference?.revision !== CODEX_SCHEMA_REVISION ||
      usage.observed_thread_start_record_count !== 1 ||
      usage.first_thread_start_event_index !== 1 ||
      usage.observed_turn_started_record_count !== 1 ||
      usage.observed_turn_completed_record_count !== 1 ||
      usage.observed_turn_failed_record_count !== 0 ||
      usage.observed_turn_started_after_completion !== false ||
      !Array.isArray(usage.observed_usage_records) ||
      usage.observed_usage_records.length !== 1 ||
      usage.schema_conformance !== "CONFORMANT_TO_PINNED_REQUIRED_SHAPE" ||
      !Array.isArray(usage.missing_required_usage_fields) ||
      usage.missing_required_usage_fields.length !== 0) {
    return {};
  }

  const entry = usage.observed_usage_records[0];
  const record = entry?.usage;
  if (entry?.stream_record_index !== 1 ||
      !Array.isArray(entry.missing_required_fields) || entry.missing_required_fields.length !== 0 ||
      !USAGE_FIELDS.every((field) => isCount(record?.[field]))) return {};

  // Zeroes in this wire format can be producer defaults. Report only actual
  // nonzero received counters, without deriving unique totals or cost.
  return Object.fromEntries(USAGE_FIELDS.filter((field) => record[field] > 0)
    .map((field) => [field, record[field]]));
}

function compare(before, after) {
  const reasons = CONDITIONS.filter((key) => {
    const left = before?.conditions?.[key];
    const right = after?.conditions?.[key];
    const known = key === "fast" ? typeof left === "boolean" : isKnownText(left);
    return !known || left !== right;
  }).map((key) => `conditions.${key}`);

  if (!isScopeValue(before?.runId) || !isScopeValue(after?.runId) || before.runId === after.runId) {
    reasons.push("distinct runId");
  }
  if (before?.mode === after?.mode ||
      !MODES.some((group) => group.includes(before?.mode) && group.includes(after?.mode))) {
    reasons.push("intervention pair");
  }
  if (reasons.length > 0) return { status: "NOT_COMPARABLE", reasons };

  const role = before.usage?.caller_scope?.role;
  const beforeUsage = observedUsage(before, role);
  const afterUsage = observedUsage(after, role);
  return {
    status: "MATCHED_CONDITIONS",
    basis: "caller_asserted_conditions",
    runIds: [before.runId, after.runId],
    modes: [before.mode, after.mode],
    metrics: differences(METRICS, before.metrics, after.metrics),
    receivedUsageCounters: differences(USAGE_FIELDS, beforeUsage, afterUsage),
    officialUsage: UNKNOWN,
    cost: UNKNOWN,
  };
}

function differences(fields, before, after) {
  return Object.fromEntries(fields.map((field) => {
    const first = before?.[field];
    const second = after?.[field];
    return [field, isCount(first) && isCount(second)
      ? { before: first, after: second, delta: second - first }
      : UNKNOWN];
  }));
}

try {
  const rows = [];
  for await (const line of boundedJsonlLines(process.stdin, {
    maxInputLines: 2, maxLineBytes: 1024 * 1024, maxInputBytes: 2 * 1024 * 1024 + 2,
  })) {
    const row = JSON.parse(line);
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("expected an observation object");
    rows.push(row);
  }
  if (rows.length !== 2) throw new Error("expected exactly two observation rows");
  const result = compare(...rows);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "NOT_COMPARABLE") process.exitCode = 1;
} catch {
  process.stderr.write("Expected two bounded JSONL observation rows. See scripts/compare-pilot-observations.md.\n");
  process.exitCode = 2;
}
