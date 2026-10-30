import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

export const RPL120_MANUAL_RESUME_ATTEMPT_STORE_NAMESPACE = "rpl120-manual-resume-attempt-v1";

const PROVIDER_KEYS = Object.freeze(["readRecord", "compareAndSetRecord"]);
const RECORD_KEYS = Object.freeze([
  "candidate_id",
  "action_kind",
  "attempt_id",
  "runtime_id",
  "actor_identity",
  "scope_ref",
  "repository_identity",
  "worktree_identity",
  "candidate_revision",
  "revision",
  "claim_revision",
  "status",
  "adapter_version",
]);

/**
 * Adapt RPL-120 Attempt/Outcome storage to a generic atomic-record provider.
 *
 * This module owns the RPL-120 namespace, stable key derivation, and the
 * attempt-store CAS translation. The provider must own user-local root
 * resolution, durable reads, atomic create-if-absent, physical locking, and
 * crash-safe publication. No production RPL-95 provider is currently wired.
 *
 * Provider contract:
 *   readRecord({ namespace, record_key }) -> { ok: true, value: record|null }
 *   compareAndSetRecord({ namespace, record_key, expected_revision, next_record })
 *     -> { ok: true, value: stored_record } | { ok: false, reason }
 * A null expected_revision means atomic create-if-absent. Numeric revisions
 * mean compare-and-replace against exactly that revision across processes.
 */
export function createPendingHandoffManualResumeAttemptOutcomeStoreAdapter(options) {
  const provider = inspectProvider(options);
  if (provider === null) return failure("manual_resume_attempt_store_invalid");

  return success(Object.freeze({
    readAttempt: request => readAttempt(provider, request),
    compareAndSetAttempt: request => compareAndSetAttempt(provider, request),
  }));
}

async function readAttempt(provider, request) {
  const key = inspectAttemptKey(request);
  if (key === null) return failure("manual_resume_attempt_input_invalid");

  let raw;
  try {
    raw = await provider.readRecord(Object.freeze({
      namespace: RPL120_MANUAL_RESUME_ATTEMPT_STORE_NAMESPACE,
      record_key: key.recordKey,
    }));
  } catch {
    return failure("manual_resume_attempt_store_unavailable");
  }
  const result = inspectResult(raw);
  if (!result.ok || result.kind !== "success") {
    return failure("manual_resume_attempt_store_unavailable");
  }
  if (result.value === null) return success(null);

  const record = inspectRecordEnvelope(result.value);
  if (!record.ok
    || record.value.candidate_id !== key.candidateId
    || record.value.action_kind !== key.actionKind) {
    return failure("manual_resume_attempt_record_invalid");
  }
  return success(result.value);
}

async function compareAndSetAttempt(provider, request) {
  const inspected = inspectCasRequest(request);
  if (!inspected.ok) return failure("manual_resume_attempt_input_invalid");
  const { candidateId, actionKind, expectedRevision, nextRecord, recordKey } = inspected.value;

  let raw;
  try {
    raw = await provider.compareAndSetRecord(Object.freeze({
      namespace: RPL120_MANUAL_RESUME_ATTEMPT_STORE_NAMESPACE,
      record_key: recordKey,
      expected_revision: expectedRevision,
      next_record: nextRecord,
    }));
  } catch {
    return failure("manual_resume_attempt_store_unavailable");
  }
  const result = inspectResult(raw);
  if (!result.ok) return failure("manual_resume_attempt_store_unavailable");
  if (result.kind === "failure") {
    return failure(result.reason === "revision_conflict" || result.reason === "record_exists"
      ? "manual_resume_attempt_revision_conflict"
      : "manual_resume_attempt_store_unavailable");
  }

  const stored = inspectRecordEnvelope(result.value);
  if (!stored.ok
    || stored.value.candidate_id !== candidateId
    || stored.value.action_kind !== actionKind
    || !sameRecord(stored.value, nextRecord)) {
    return failure("manual_resume_attempt_store_unavailable");
  }
  return success(result.value);
}

function inspectProvider(options) {
  const outer = inspectExactObject(options, ["recordStore"]);
  if (!outer.ok) return null;
  const provider = outer.values.recordStore;
  if (utilTypes.isProxy(provider) || !isPlainObject(provider)) return null;
  const keys = Reflect.ownKeys(provider);
  if (keys.length !== PROVIDER_KEYS.length || keys.some(key => !PROVIDER_KEYS.includes(key))) {
    return null;
  }
  for (const key of PROVIDER_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(provider, key);
    if (!isEnumerableDataDescriptor(descriptor) || typeof descriptor.value !== "function") return null;
  }
  return Object.freeze({
    readRecord: provider.readRecord,
    compareAndSetRecord: provider.compareAndSetRecord,
  });
}

function inspectAttemptKey(value) {
  const request = inspectExactObject(value, ["candidate_id", "action_kind"]);
  if (!request.ok
    || !isNonEmptyToken(request.values.candidate_id)
    || request.values.action_kind !== "manual_resume") return null;
  return Object.freeze({
    candidateId: request.values.candidate_id,
    actionKind: request.values.action_kind,
    recordKey: deriveRecordKey(request.values.candidate_id, request.values.action_kind),
  });
}

function inspectCasRequest(value) {
  const request = inspectExactObject(value, [
    "candidate_id",
    "action_kind",
    "expected_revision",
    "next_record",
  ]);
  if (!request.ok
    || !isNonEmptyToken(request.values.candidate_id)
    || request.values.action_kind !== "manual_resume"
    || !(request.values.expected_revision === null || isRevision(request.values.expected_revision))) {
    return failure("invalid");
  }

  const nextRecord = inspectRecordEnvelope(request.values.next_record);
  const nextRevision = request.values.expected_revision === null
    ? 1
    : request.values.expected_revision + 1;
  if (!nextRecord.ok
    || nextRecord.value.candidate_id !== request.values.candidate_id
    || nextRecord.value.action_kind !== request.values.action_kind
    || nextRecord.value.revision !== nextRevision
    || !Number.isSafeInteger(nextRevision)) return failure("invalid");

  return success(Object.freeze({
    candidateId: request.values.candidate_id,
    actionKind: request.values.action_kind,
    expectedRevision: request.values.expected_revision,
    nextRecord: request.values.next_record,
    recordKey: deriveRecordKey(request.values.candidate_id, request.values.action_kind),
  }));
}

function inspectRecordEnvelope(value) {
  const inspected = inspectExactObject(value, RECORD_KEYS);
  if (!inspected.ok
    || !isNonEmptyToken(inspected.values.candidate_id)
    || inspected.values.action_kind !== "manual_resume"
    || !isRevision(inspected.values.revision)
    || inspected.values.revision < 1) return failure("invalid");
  return success(inspected.values);
}

function inspectResult(value) {
  const successResult = inspectExactObject(value, ["ok", "value"]);
  if (successResult.ok && successResult.values.ok === true) {
    return { ok: true, kind: "success", value: successResult.values.value };
  }
  const failureResult = inspectExactObject(value, ["ok", "reason"]);
  if (failureResult.ok && failureResult.values.ok === false
    && typeof failureResult.values.reason === "string") {
    return { ok: true, kind: "failure", reason: failureResult.values.reason };
  }
  return { ok: false };
}

function inspectExactObject(value, requiredKeys) {
  try {
    if (utilTypes.isProxy(value) || !isPlainObject(value)) return failure("invalid");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== requiredKeys.length || keys.some(key => !requiredKeys.includes(key))) {
      return failure("invalid");
    }
    const values = {};
    for (const key of requiredKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return failure("invalid");
      values[key] = descriptor.value;
    }
    return { ok: true, values };
  } catch {
    return failure("invalid");
  }
}

function sameRecord(left, right) {
  return RECORD_KEYS.every(key => left[key] === right[key]);
}

function deriveRecordKey(candidateId, actionKind) {
  const input = JSON.stringify([candidateId, actionKind]);
  return `attempt-${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && Object.hasOwn(descriptor, "value")
    && descriptor.enumerable === true;
}

function isNonEmptyToken(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function success(value) { return { ok: true, value }; }
function failure(reason) { return { ok: false, reason }; }
