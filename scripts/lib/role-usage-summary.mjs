const CODEX_SCHEMA_REVISION = "2edad72de3e4fb12a7519027d5eb3cbda45eea6c";
const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];

// These are local resource limits, not Codex producer limits. Exceeding one
// rejects the whole stream so a partial result cannot look complete.
const DEFAULT_LIMITS = {
  maxLineBytes: 4 * 1024 * 1024,
  maxInputBytes: 64 * 1024 * 1024,
  maxInputLines: 100_000,
  maxUsageRecords: 10_000,
};

function invalidInput(message) {
  return new Error(message);
}

function normalizeCallerValue(name, value) {
  if (typeof value !== "string") throw invalidInput(`${name} must be supplied by the caller`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidInput(`${name} must be a non-empty value of at most 256 characters`);
  }
  return normalized;
}

function validateLimits(limits) {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalidInput(`${name} must be a positive safe integer`);
    }
  }
  return merged;
}

function parseJsonlEvent(line, lineNumber) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw invalidInput(`invalid JSONL event at line ${lineNumber}`);
  }
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
    throw invalidInput(`invalid JSONL event shape at line ${lineNumber}`);
  }
  return event;
}

function extractUsage(event, lineNumber) {
  if (event.type !== "turn.completed") return null;
  const hasUsageObject = Object.hasOwn(event, "usage");
  const usage = event.usage;
  if (hasUsageObject && (!usage || typeof usage !== "object" || Array.isArray(usage))) {
    throw invalidInput(`turn.completed usage is malformed at line ${lineNumber}`);
  }

  const record = {};
  const missingFields = [];
  for (const field of USAGE_FIELDS) {
    if (!hasUsageObject || !Object.hasOwn(usage, field)) {
      record[field] = "UNKNOWN";
      missingFields.push(field);
      continue;
    }
    const value = usage[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidInput(`turn.completed usage.${field} is malformed at line ${lineNumber}`);
    }
    record[field] = value;
  }
  return { usage: record, missingFields };
}

/**
 * Yield one UTF-8 JSONL line at a time while enforcing byte caps before a
 * partial line is accumulated. This bounds consumer buffering independently
 * of upstream chunk boundaries; limits are local safety policy, not producer
 * guarantees.
 */
export async function* boundedJsonlLines(readable, limits = {}) {
  const caps = validateLimits(limits);
  let totalBytes = 0;
  let lineNumber = 0;
  let lineBytes = 0;
  let lineParts = [];

  for await (const chunk of readable) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > caps.maxInputBytes) throw invalidInput("JSONL stream exceeds the local byte limit");

    let start = 0;
    while (true) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline === -1) break;
      const part = bytes.subarray(start, newline);
      lineBytes += part.byteLength;
      if (lineBytes > caps.maxLineBytes) throw invalidInput(`JSONL line ${lineNumber + 1} exceeds the local line limit`);
      if (part.byteLength > 0) lineParts.push(part);

      let lineBuffer = lineParts.length === 1 ? lineParts[0] : Buffer.concat(lineParts, lineBytes);
      if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d) {
        lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
      }
      lineNumber += 1;
      if (lineNumber > caps.maxInputLines) throw invalidInput("JSONL stream exceeds the local line limit");
      yield lineBuffer.toString("utf8");

      lineParts = [];
      lineBytes = 0;
      start = newline + 1;
    }

    const remainder = bytes.subarray(start);
    lineBytes += remainder.byteLength;
    if (lineBytes > caps.maxLineBytes) throw invalidInput(`JSONL line ${lineNumber + 1} exceeds the local line limit`);
    if (remainder.byteLength > 0) lineParts.push(remainder);
  }

  if (lineBytes > 0) {
    let lineBuffer = lineParts.length === 1 ? lineParts[0] : Buffer.concat(lineParts, lineBytes);
    if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d) {
      lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
    }
    lineNumber += 1;
    if (lineNumber > caps.maxInputLines) throw invalidInput("JSONL stream exceeds the local line limit");
    yield lineBuffer.toString("utf8");
  }
}

/**
 * Read one caller-supplied stdin JSONL stream and preserve each turn.completed
 * usage occurrence. Count thread.started markers without retaining their
 * identifiers. Non-usage event bodies are never retained or emitted. This does not deduplicate.
 */
export async function summarizeCodexExecJsonl(lines, callerScope, limits = {}) {
  const scope = {
    role: normalizeCallerValue("role", callerScope?.role),
    agent_id: normalizeCallerValue("agent_id", callerScope?.agentId),
    run_id: normalizeCallerValue("run_id", callerScope?.runId),
    basis: "caller_asserted_single_stdin_stream",
  };
  const caps = validateLimits(limits);
  const records = [];
  const receivedSums = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0n]));
  const fieldsWithMissingValues = new Set();
  let inputBytes = 0;
  let inputLineCount = 0;
  let threadStartRecordCount = 0;

  for await (const line of lines) {
    inputLineCount += 1;
    if (inputLineCount > caps.maxInputLines) throw invalidInput("JSONL stream exceeds the local line limit");
    if (typeof line !== "string") throw invalidInput(`JSONL line ${inputLineCount} is not text`);

    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > caps.maxLineBytes) throw invalidInput(`JSONL line ${inputLineCount} exceeds the local line limit`);
    inputBytes += lineBytes + 1;
    if (inputBytes > caps.maxInputBytes) throw invalidInput("JSONL stream exceeds the local byte limit");
    if (line.length === 0) throw invalidInput(`empty JSONL event at line ${inputLineCount}`);

    const event = parseJsonlEvent(line, inputLineCount);
    if (event.type === "thread.started") threadStartRecordCount += 1;
    const extracted = extractUsage(event, inputLineCount);
    if (extracted === null) continue;
    if (records.length >= caps.maxUsageRecords) throw invalidInput("JSONL stream exceeds the local usage-record limit");

    records.push({
      stream_record_index: records.length + 1,
      usage: extracted.usage,
      missing_required_fields: extracted.missingFields,
    });
    for (const field of USAGE_FIELDS) {
      if (extracted.usage[field] === "UNKNOWN") fieldsWithMissingValues.add(field);
      else receivedSums[field] += BigInt(extracted.usage[field]);
    }
  }

  const hasUsageRecords = records.length > 0;
  const isSchemaConformant = hasUsageRecords && fieldsWithMissingValues.size === 0;
  const missingRequiredUsageFields = hasUsageRecords
    ? [...fieldsWithMissingValues]
    : [...USAGE_FIELDS];

  return {
    source: "codex exec --json JSONL supplied on stdin",
    schema_reference: {
      repository: "openai/codex",
      revision: CODEX_SCHEMA_REVISION,
      scope: "pinned wire shape only; release compatibility is UNKNOWN",
    },
    producer_cli_version: "UNKNOWN",
    schema_conformance: !hasUsageRecords
      ? "NO_USAGE_RECORD_OBSERVED"
      : isSchemaConformant
        ? "CONFORMANT_TO_PINNED_REQUIRED_SHAPE"
        : "NONCONFORMANT_PARTIAL_MISSING_REQUIRED_FIELDS",
    missing_required_usage_fields: missingRequiredUsageFields,
    caller_scope: scope,
    observed_thread_start_record_count: threadStartRecordCount,
    observed_turn_completed_record_count: records.length,
    observed_usage_records: records,
    event_identity: {
      event_id: "UNKNOWN_not_in_turn.completed_schema",
      turn_id: "UNKNOWN_not_in_turn.completed_schema",
      thread_id: "not_carried_by_turn.completed",
      deduplication: "NOT_PERFORMED",
      unique_turn_count: "UNKNOWN",
      unique_usage_totals: "UNKNOWN",
      cross_call_usage_totals: "UNKNOWN",
      parent_child_inclusion: "UNKNOWN",
    },
    sum_of_received_records_may_include_duplicates: Object.fromEntries(USAGE_FIELDS.map((field) => [
      field,
      !hasUsageRecords || fieldsWithMissingValues.has(field) ? "UNKNOWN" : receivedSums[field].toString(),
    ])),
    zero_value_semantics: "UNKNOWN; the pinned CLI producer may emit default zero usage when no token usage update was observed",
    model_reasoning_fast: "UNKNOWN_not_present_in_turn.completed_usage",
    non_usage_event_bodies: "NOT_RETAINED_OR_OUTPUT",
  };
}

export { CODEX_SCHEMA_REVISION, USAGE_FIELDS };
