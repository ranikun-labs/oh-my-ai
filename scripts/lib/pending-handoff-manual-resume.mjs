import { types as utilTypes } from "node:util";
import {
  PENDING_HANDOFF_STATUSES,
  validateCandidate,
} from "./pending-handoff-core.mjs";
import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";

const DEPENDENCY_KEYS = Object.freeze(["store", "sessionResolution", "claimLease"]);
const STORE_KEYS = Object.freeze(["readState"]);
const SESSION_RESOLUTION_KEYS = Object.freeze([
  "resolveCurrentSession",
  "resolveTargetSession",
]);
const CLAIM_LEASE_KEYS = Object.freeze(["acquireClaim"]);
const INPUT_KEYS = Object.freeze([
  "candidate_id",
  "expected_revision",
  "current_runtime_id",
  "claim_attempt_id",
]);
const CANDIDATE_KEYS = Object.freeze([
  "candidate_id",
  "schema_version",
  "status",
  "created_at",
  "expires_at",
  "source_runtime",
  "source_session_identity",
  "repository_identity",
  "worktree_identity",
  "goal",
  "completed",
  "open_issues",
  "verification",
  "do_not_touch",
  "next_action",
  "context_checkpoint_status",
  "privacy_redaction_status",
]);
const CANDIDATE_STATUS_SET = new Set(PENDING_HANDOFF_STATUSES);
const STATE_KEYS = Object.freeze(["candidate", "state_revision", "claim", "delivery"]);
const CLAIM_KEYS = Object.freeze([
  "claim_owner_identity",
  "claim_started_at",
  "claim_lease_expires_at",
  "claim_attempt_id",
]);
const DELIVERY_ATTEMPT_KEYS = Object.freeze([
  "delivery_attempt_id",
  "delivery_attempted_at",
  "delivery_candidate_digest",
]);
const DELIVERY_CONFIRMED_KEYS = Object.freeze([
  ...DELIVERY_ATTEMPT_KEYS,
  "evidence",
  "delivered_at",
]);
const DELIVERY_CONSUMED_KEYS = Object.freeze([
  ...DELIVERY_CONFIRMED_KEYS,
  "consumed_at",
]);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RUNTIME_NEUTRAL_STATUSES = new Set(["pending", "claimed"]);

export const PENDING_HANDOFF_MANUAL_RESUME_FAILURES = Object.freeze([
  "manual_resume_dependency_invalid",
  "manual_resume_input_invalid",
  "manual_resume_record_not_found",
  "manual_resume_persisted_state_invalid",
  "manual_resume_state_not_resumable",
  "manual_resume_revision_conflict",
  "manual_resume_current_session_unavailable",
  "manual_resume_target_not_found",
  "manual_resume_target_ambiguous",
  "manual_resume_target_stale",
  "manual_resume_runtime_unsupported",
  "manual_resume_session_mismatch",
  "manual_resume_ownership_conflict",
  "manual_resume_denied",
  "manual_resume_action_request_unavailable",
]);

export function createPendingHandoffManualResumeService(options) {
  const inspected = inspectDependencies(options);
  if (!inspected.ok) return failure(inspected.reason);

  const { store, sessionResolution, claimLease } = inspected.value;
  const service = Object.freeze({
    prepareManualResume: request => prepareManualResume(
      store,
      sessionResolution,
      claimLease,
      request,
    ),
  });
  return success(service);
}

async function prepareManualResume(store, sessionResolution, claimLease, request) {
  const inspectedRequest = inspectInput(request);
  if (!inspectedRequest.ok) return failure(inspectedRequest.reason);
  const input = inspectedRequest.value;

  const stateResult = await readState(store, input.candidateId);
  if (!stateResult.ok) return failure(stateResult.reason);
  const state = stateResult.value;

  const persisted = inspectPersistedState(state, input.candidateId);
  if (!persisted.ok) return failure(persisted.reason);
  const { candidate, stateRevision, claim, delivery } = persisted.value;

  const eligibility = validateEligibility(
    candidate,
    stateRevision,
    claim,
    delivery,
    input.expectedRevision,
  );
  if (!eligibility.ok) return failure(eligibility.reason);

  const currentResult = await resolveCurrentSession(
    sessionResolution,
    input.currentRuntimeId,
  );
  if (!currentResult.ok) return failure(currentResult.reason);
  const currentSessionIdentity = currentResult.value.session_identity;

  if (eligibility.value.mode === "replay"
    && (claim.claim_owner_identity !== currentSessionIdentity
      || claim.claim_attempt_id !== input.claimAttemptId)) {
    return failure("manual_resume_ownership_conflict");
  }

  const targetResult = await resolveTargetSession(
    sessionResolution,
    candidate.source_runtime,
    candidate.source_session_identity,
  );
  if (!targetResult.ok) return failure(targetResult.reason);

  const claimResult = await acquireClaim(
    claimLease,
    {
      candidate_id: input.candidateId,
      expected_revision: input.expectedRevision,
      current_session_identity: currentSessionIdentity,
      claim_attempt_id: input.claimAttemptId,
    },
  );
  if (!claimResult.ok) return failure(claimResult.reason);

  const expectedPostClaimRevision = eligibility.value.mode === "pending"
    ? stateRevision + 1
    : stateRevision;
  if (claimResult.value.state_revision !== expectedPostClaimRevision) {
    return failure("manual_resume_revision_conflict");
  }
  if (claimResult.value.claim_attempt_id !== input.claimAttemptId) {
    return failure("manual_resume_action_request_unavailable");
  }

  try {
    return success(Object.freeze({
      action_kind: "manual_resume",
      candidate_id: input.candidateId,
      state_revision: claimResult.value.state_revision,
      current_session_identity: currentSessionIdentity,
      claim_attempt_id: claimResult.value.claim_attempt_id,
      target: Object.freeze({
        runtime_id: candidate.source_runtime,
        session_identity: candidate.source_session_identity,
      }),
    }));
  } catch {
    return failure("manual_resume_action_request_unavailable");
  }
}

async function readState(store, candidateId) {
  let result;
  try {
    result = await store.readState(candidateId);
  } catch {
    return failure("manual_resume_action_request_unavailable");
  }

  const inspected = inspectResult(result);
  if (!inspected.ok) return failure("manual_resume_persisted_state_invalid");
  if (inspected.kind === "failure") return failure(mapStoreFailure(inspected.reason));
  return success(inspected.value);
}

async function resolveCurrentSession(sessionResolution, runtimeId) {
  let raw;
  try {
    raw = sessionResolution.resolveCurrentSession({ runtime_id: runtimeId });
  } catch {
    return failure("manual_resume_current_session_unavailable");
  }
  if (utilTypes.isProxy(raw) || !utilTypes.isPromise(raw)) {
    return failure("manual_resume_current_session_unavailable");
  }

  let result;
  try {
    result = await raw;
  } catch {
    return failure("manual_resume_current_session_unavailable");
  }
  if (utilTypes.isProxy(result)) {
    return failure("manual_resume_current_session_unavailable");
  }
  return normalizeResolutionResult(result, runtimeId, null, "current");
}

async function resolveTargetSession(sessionResolution, runtimeId, sessionIdentity) {
  let raw;
  try {
    raw = sessionResolution.resolveTargetSession({
      runtime_id: runtimeId,
      session_identity: sessionIdentity,
    });
  } catch {
    return failure("manual_resume_action_request_unavailable");
  }
  if (utilTypes.isProxy(raw) || !utilTypes.isPromise(raw)) {
    return failure("manual_resume_action_request_unavailable");
  }

  let result;
  try {
    result = await raw;
  } catch {
    return failure("manual_resume_action_request_unavailable");
  }
  if (utilTypes.isProxy(result)) {
    return failure("manual_resume_action_request_unavailable");
  }
  return normalizeResolutionResult(result, runtimeId, sessionIdentity, "target");
}

async function acquireClaim(claimLease, request) {
  let result;
  try {
    result = await claimLease.acquireClaim(request);
  } catch {
    return failure("manual_resume_action_request_unavailable");
  }

  const inspected = inspectResult(result);
  if (!inspected.ok) return failure("manual_resume_action_request_unavailable");
  if (inspected.kind === "failure") return failure(mapClaimFailure(inspected.reason));

  const value = inspectExactDataObject(
    inspected.value,
    ["state_revision", "claim_attempt_id", "claim_lease_expires_at"],
  );
  if (!value.ok
    || !isRevision(value.values.state_revision)
    || !isClaimAttemptId(value.values.claim_attempt_id)
    || !isUtcIsoTimestamp(value.values.claim_lease_expires_at)) {
    return failure("manual_resume_action_request_unavailable");
  }
  return success(Object.freeze({
    state_revision: value.values.state_revision,
    claim_attempt_id: value.values.claim_attempt_id,
    claim_lease_expires_at: value.values.claim_lease_expires_at,
  }));
}

function normalizeResolutionResult(result, expectedRuntime, expectedIdentity, phase) {
  const inspected = inspectResult(result);
  if (!inspected.ok) return failure("manual_resume_action_request_unavailable");
  if (inspected.kind === "failure") return failure(mapResolutionFailure(inspected.reason, phase));

  const value = inspectExactDataObject(inspected.value, ["runtime_id", "session_identity"]);
  if (!value.ok
    || !isSafeRuntimeId(value.values.runtime_id)
    || !isSessionIdentity(value.values.session_identity)
    || value.values.runtime_id !== expectedRuntime
    || (expectedIdentity !== null && value.values.session_identity !== expectedIdentity)) {
    return failure("manual_resume_session_mismatch");
  }
  return success(Object.freeze({
    runtime_id: expectedRuntime,
    session_identity: value.values.session_identity,
  }));
}

function validateEligibility(candidate, stateRevision, claim, delivery, expectedRevision) {
  if (!RUNTIME_NEUTRAL_STATUSES.has(candidate.status)) {
    return failure("manual_resume_state_not_resumable");
  }

  if (candidate.status === "pending") {
    if (claim !== null || (delivery !== undefined && delivery !== null)) {
      return failure("manual_resume_persisted_state_invalid");
    }
    return stateRevision === expectedRevision
      ? success({ mode: "pending" })
      : failure("manual_resume_revision_conflict");
  }

  if (claim === null || (delivery !== undefined && delivery !== null)) {
    return failure("manual_resume_state_not_resumable");
  }
  if (expectedRevision !== stateRevision - 1) {
    return failure("manual_resume_revision_conflict");
  }
  return success({ mode: "replay" });
}

function inspectPersistedState(value, candidateId) {
  const inspected = inspectExactDataObject(
    value,
    STATE_KEYS.filter(key => key !== "delivery"),
    { optional: ["delivery"] },
  );
  if (!inspected.ok
    || !isRevision(inspected.values.state_revision)
    || !isPlainObjectOrNull(inspected.values.claim)
    || (Object.hasOwn(inspected.values, "delivery")
      && !isPlainObjectOrNull(inspected.values.delivery))) {
    return failure("manual_resume_persisted_state_invalid");
  }

  const candidateResult = inspectCandidate(inspected.values.candidate, candidateId);
  if (!candidateResult.ok) return candidateResult;

  const claimResult = inspectClaim(inspected.values.claim);
  if (!claimResult.ok) return claimResult;
  const deliveryResult = inspectDelivery(
    inspected.values.delivery,
    candidateResult.value.status,
  );
  if (!deliveryResult.ok) return deliveryResult;
  if (!isLifecycleShapeValid(
    candidateResult.value.status,
    claimResult.value,
    deliveryResult.value,
  )) {
    return failure("manual_resume_persisted_state_invalid");
  }

  return success(Object.freeze({
    candidate: candidateResult.value,
    stateRevision: inspected.values.state_revision,
    claim: claimResult.value,
    ...(Object.hasOwn(inspected.values, "delivery")
      ? { delivery: deliveryResult.value }
      : {}),
  }));
}

function isLifecycleShapeValid(status, claim, delivery) {
  if (status === "pending") return claim === null && delivery === null;
  if (status === "claimed") return claim !== null;
  if (status === "delivered" || status === "consumed") {
    return claim !== null && delivery !== null;
  }
  return true;
}

function inspectCandidate(value, candidateId) {
  const inspected = inspectExactDataObject(value, CANDIDATE_KEYS);
  if (!inspected.ok || inspected.values.candidate_id !== candidateId) {
    return failure("manual_resume_persisted_state_invalid");
  }
  const copied = copyCandidate(inspected.values);
  if (!copied.ok) return copied;

  let validation;
  try {
    validation = validateCandidate(copied.value);
  } catch {
    return failure("manual_resume_persisted_state_invalid");
  }
  if (!validation.ok
    || !CANDIDATE_STATUS_SET.has(copied.value.status)
    || !isSafeRuntimeId(copied.value.source_runtime)
    || !isSessionIdentity(copied.value.source_session_identity)) {
    return failure("manual_resume_persisted_state_invalid");
  }
  return success(Object.freeze(copied.value));
}

function copyCandidate(values) {
  const copied = {};
  for (const key of CANDIDATE_KEYS) {
    const value = values[key];
    if (Array.isArray(value)) {
      const array = copyDenseArray(value);
      if (!array.ok) return failure("manual_resume_persisted_state_invalid");
      copied[key] = array.value;
    } else if (value !== null && typeof value === "object") {
      return failure("manual_resume_persisted_state_invalid");
    } else if (typeof value === "function") {
      return failure("manual_resume_persisted_state_invalid");
    } else {
      copied[key] = value;
    }
  }
  return success(copied);
}

function copyDenseArray(value) {
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return failure("manual_resume_persisted_state_invalid");
    }
    const ownKeys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.enumerable
      || lengthDescriptor.configurable
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || ownKeys.length !== lengthDescriptor.value + 1
      || ownKeys[ownKeys.length - 1] !== "length") {
      return failure("manual_resume_persisted_state_invalid");
    }
    const copied = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const key = String(index);
      if (ownKeys[index] !== key) return failure("manual_resume_persisted_state_invalid");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) {
        return failure("manual_resume_persisted_state_invalid");
      }
      copied.push(descriptor.value);
    }
    return success(copied);
  } catch {
    return failure("manual_resume_persisted_state_invalid");
  }
}

function inspectClaim(value) {
  if (value === null) return success(null);
  const inspected = inspectExactDataObject(value, CLAIM_KEYS);
  if (!inspected.ok
    || !isSessionIdentity(inspected.values.claim_owner_identity)
    || !isClaimAttemptId(inspected.values.claim_attempt_id)
    || !isUtcIsoTimestamp(inspected.values.claim_started_at)
    || !isUtcIsoTimestamp(inspected.values.claim_lease_expires_at)
    || Date.parse(inspected.values.claim_lease_expires_at)
      <= Date.parse(inspected.values.claim_started_at)) {
    return failure("manual_resume_persisted_state_invalid");
  }
  return success(Object.freeze({
    claim_owner_identity: inspected.values.claim_owner_identity,
    claim_started_at: inspected.values.claim_started_at,
    claim_lease_expires_at: inspected.values.claim_lease_expires_at,
    claim_attempt_id: inspected.values.claim_attempt_id,
  }));
}

function inspectDelivery(value, status) {
  if (value === undefined || value === null) return success(value ?? null);
  const expectedKeys = status === "consumed"
    ? DELIVERY_CONSUMED_KEYS
    : status === "delivered"
      ? DELIVERY_CONFIRMED_KEYS
      : DELIVERY_ATTEMPT_KEYS;
  const inspected = inspectExactDataObject(value, expectedKeys);
  if (!inspected.ok
    || !isClaimAttemptId(inspected.values.delivery_attempt_id)
    || !isUtcIsoTimestamp(inspected.values.delivery_attempted_at)
    || !isDigest(inspected.values.delivery_candidate_digest)) {
    return failure("manual_resume_persisted_state_invalid");
  }
  if (expectedKeys.includes("delivered_at")
    && !isUtcIsoTimestamp(inspected.values.delivered_at)) {
    return failure("manual_resume_persisted_state_invalid");
  }
  if (expectedKeys.includes("consumed_at")
    && !isUtcIsoTimestamp(inspected.values.consumed_at)) {
    return failure("manual_resume_persisted_state_invalid");
  }
  if (expectedKeys.includes("evidence") && !isPlainObject(inspected.values.evidence)) {
    return failure("manual_resume_persisted_state_invalid");
  }
  return success(Object.freeze({ ...inspected.values }));
}

function inspectDependencies(options) {
  try {
    const inspected = inspectExactDataObject(options, DEPENDENCY_KEYS);
    if (!inspected.ok) return failure("manual_resume_dependency_invalid");
    const store = snapshotRequiredFacade(inspected.values.store, STORE_KEYS);
    const sessionResolution = snapshotRequiredFacade(
      inspected.values.sessionResolution,
      SESSION_RESOLUTION_KEYS,
    );
    const claimLease = snapshotRequiredFacade(inspected.values.claimLease, CLAIM_LEASE_KEYS);
    if (store === null || sessionResolution === null || claimLease === null) {
      return failure("manual_resume_dependency_invalid");
    }
    return success(Object.freeze({
      store,
      sessionResolution,
      claimLease,
    }));
  } catch {
    return failure("manual_resume_dependency_invalid");
  }
}

function snapshotRequiredFacade(value, requiredKeys) {
  try {
    if (!isPlainObject(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== "string")) return null;
    const descriptors = new Map();
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor) || typeof descriptor.value !== "function") {
        return null;
      }
      descriptors.set(key, descriptor);
    }

    const snapshot = {};
    for (const key of requiredKeys) {
      const descriptor = descriptors.get(key);
      if (descriptor === undefined) return null;
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function inspectInput(value) {
  const inspected = inspectExactDataObject(value, INPUT_KEYS);
  if (!inspected.ok
    || !isNonEmptyString(inspected.values.candidate_id)
    || !isRevision(inspected.values.expected_revision)
    || !isSafeRuntimeId(inspected.values.current_runtime_id)
    || !isClaimAttemptId(inspected.values.claim_attempt_id)) {
    return failure("manual_resume_input_invalid");
  }
  return success(Object.freeze({
    candidateId: inspected.values.candidate_id,
    expectedRevision: inspected.values.expected_revision,
    currentRuntimeId: inspected.values.current_runtime_id,
    claimAttemptId: inspected.values.claim_attempt_id,
  }));
}

function inspectResult(value) {
  const successResult = inspectExactDataObject(value, ["ok", "value"]);
  if (successResult.ok && successResult.values.ok === true) {
    if (utilTypes.isProxy(successResult.values.value)) return { ok: false };
    return { ok: true, kind: "success", value: successResult.values.value };
  }
  const failureResult = inspectExactDataObject(value, ["ok", "reason"]);
  if (failureResult.ok
    && failureResult.values.ok === false
    && typeof failureResult.values.reason === "string") {
    return { ok: true, kind: "failure", reason: failureResult.values.reason };
  }
  return { ok: false };
}

function inspectExactDataObject(value, expectedKeys, options = {}) {
  try {
    if (utilTypes.isProxy(value)) return { ok: false };
    if (!isPlainObject(value)) return { ok: false };
    const optional = new Set(options.optional ?? []);
    const allowed = new Set([...expectedKeys, ...optional]);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== "string" || !allowed.has(key))) {
      return { ok: false };
    }
    if (ownKeys.length < expectedKeys.length
      || ownKeys.length > expectedKeys.length + optional.size) {
      return { ok: false };
    }
    for (const key of expectedKeys) {
      if (!Object.hasOwn(value, key)) return { ok: false };
    }
    for (const key of optional) {
      if (!Object.hasOwn(value, key)) continue;
    }
    const values = {};
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return { ok: false };
      values[key] = descriptor.value;
    }
    return { ok: true, values };
  } catch {
    return { ok: false };
  }
}

function mapStoreFailure(reason) {
  if (reason === "record_not_found") return "manual_resume_record_not_found";
  if ([
    "record_invalid",
    "record_malformed",
    "record_integrity_invalid",
    "record_integrity_key_invalid",
    "record_integrity_mismatch",
    "revision_invalid",
    "unsafe_store_path",
    "unsafe_record_path",
  ].includes(reason)) return "manual_resume_persisted_state_invalid";
  return "manual_resume_action_request_unavailable";
}

function mapResolutionFailure(reason, phase) {
  const prefix = "session_resolution_";
  if (typeof reason !== "string" || !reason.startsWith(prefix)) {
    return "manual_resume_action_request_unavailable";
  }
  const shortReason = reason.slice(prefix.length);
  if (shortReason === "runtime_unsupported") return "manual_resume_runtime_unsupported";
  if (shortReason === "denied") return "manual_resume_denied";
  if (phase === "target" && shortReason === "not_found") return "manual_resume_target_not_found";
  if (phase === "target" && shortReason === "ambiguous") return "manual_resume_target_ambiguous";
  if (phase === "target" && shortReason === "stale") return "manual_resume_target_stale";
  if (["runtime_mismatch", "identity_mismatch"].includes(shortReason)) {
    return "manual_resume_session_mismatch";
  }
  if (phase === "current"
    && ["not_found", "ambiguous", "stale", "unavailable"].includes(shortReason)) {
    return "manual_resume_current_session_unavailable";
  }
  return "manual_resume_action_request_unavailable";
}

function mapClaimFailure(reason) {
  if (reason === "claim_conflict") return "manual_resume_revision_conflict";
  if (reason === "claim_owner_invalid") return "manual_resume_session_mismatch";
  if (reason === "claim_lease_expired" || reason === "claim_time_invalid") {
    return "manual_resume_state_not_resumable";
  }
  if (reason === "claim_state_invalid") return "manual_resume_persisted_state_invalid";
  return "manual_resume_action_request_unavailable";
}

function isSessionIdentity(value) {
  try {
    const result = validateOpaqueIdentity(value);
    return result.ok === true && result.kind === "session";
  } catch {
    return false;
  }
}

function isSafeRuntimeId(value) {
  return typeof value === "string" && RUNTIME_ID_PATTERN.test(value);
}

function isClaimAttemptId(value) {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function isDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isUtcIsoTimestamp(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const normalized = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return new Date(timestamp).toISOString() === normalized;
}

function isPlainObject(value) {
  try {
    return value !== null
      && typeof value === "object"
      && !utilTypes.isProxy(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isPlainObjectOrNull(value) {
  return value === null || isPlainObject(value);
}

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && descriptor !== null
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, "value")
    && !Object.hasOwn(descriptor, "get")
    && !Object.hasOwn(descriptor, "set");
}

function success(value) {
  return Object.freeze({
    ok: true,
    value: Object.isFrozen(value) ? value : Object.freeze(value),
  });
}

function failure(reason) {
  return Object.freeze({ ok: false, reason });
}
