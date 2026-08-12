import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";
import { transitionCandidate } from "./pending-handoff-core.mjs";
import { createPendingHandoffCanonicalCandidateBytes } from "./pending-handoff-integrity.mjs";

const SERVICE_KEYS = Object.freeze([
  "store",
  "mutationPort",
  "clock",
  "deliveryCandidateDigest",
  "deliveryEvidenceVerifier",
]);
const STORE_METHODS = Object.freeze(["readState"]);
const DELIVERY_DIGEST_PURPOSE = "pending-handoff-delivery-candidate";
const DELIVERY_ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVIDENCE_ID_PATTERN = /^ev-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ADAPTER_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const PENDING_HANDOFF_DELIVERY_DIGEST_PURPOSE = DELIVERY_DIGEST_PURPOSE;
export const PENDING_HANDOFF_DELIVERY_CONSUMPTION_FAILURES = Object.freeze([
  "delivery_dependency_invalid",
  "delivery_input_invalid",
  "delivery_state_invalid",
  "delivery_conflict",
  "delivery_attempt_invalid",
  "delivery_evidence_unavailable",
  "delivery_evidence_invalid",
  "delivery_evidence_mismatch",
  "delivery_time_invalid",
  "delivery_digest_invalid",
  "delivery_digest_failed",
  "delivery_publish_failed",
  "consumption_input_invalid",
  "consumption_attempt_invalid",
  "consumption_conflict",
  "consumption_evidence_unknown",
  "consumption_publish_failed",
]);

export function createPendingHandoffDeliveryConsumptionService(options) {
  const inspected = inspectServiceOptions(options);
  if (!inspected.ok) return failure(inspected.reason);

  const {
    store,
    mutationPort,
    clock,
    deliveryCandidateDigest,
    deliveryEvidenceVerifier,
  } = inspected.value;
  return success(Object.freeze({
    beginDeliveryAttempt: request => beginDeliveryAttempt(
      store,
      mutationPort,
      clock,
      deliveryCandidateDigest,
      deliveryEvidenceVerifier,
      request,
    ),
    confirmDelivery: request => confirmDelivery(
      store,
      mutationPort,
      clock,
      deliveryEvidenceVerifier,
      request,
    ),
    releaseUnconfirmedDelivery: request => releaseUnconfirmedDelivery(store, mutationPort, clock, request),
    consumeDelivered: request => consumeDelivered(
      store,
      mutationPort,
      clock,
      deliveryEvidenceVerifier,
      request,
    ),
  }));
}

async function beginDeliveryAttempt(
  store,
  mutationPort,
  clock,
  deliveryCandidateDigest,
  deliveryEvidenceVerifier,
  request,
) {
  const inspected = inspectRequest(request, [
    "candidate_id",
    "expected_revision",
    "current_session_identity",
    "claim_attempt_id",
    "delivery_attempt_id",
  ]);
  if (!inspected.ok) return failure(inspected.reason);
  if (!validateSessionIdentity(inspected.value.currentSessionIdentity)) {
    return failure("delivery_input_invalid");
  }
  const now = readClock(clock);
  if (now === null) return failure("delivery_time_invalid");

  const stateResult = await readState(store, inspected.value.candidateId);
  if (!stateResult.ok) return stateResult;
  const state = stateResult.value;
  const candidateExpiry = readCandidateExpiry(state.candidate);
  const leaseExpiry = readClaimLeaseExpiry(state.claim);
  if (candidateExpiry === null || leaseExpiry === null) {
    return failure("delivery_state_invalid");
  }

  if (state.delivery !== undefined && state.delivery !== null) {
    if (state.candidate.status !== "claimed"
      || !sameClaimOwnerAndAttempt(state, inspected.value)
      || state.delivery.delivery_attempt_id !== inspected.value.deliveryAttemptId) {
      return failure("delivery_conflict");
    }
    if (!isOriginalExpectedRevision(state.state_revision, inspected.value.expectedRevision)) {
      return failure("delivery_conflict");
    }
    if (now >= leaseExpiry || now >= candidateExpiry) return failure("delivery_conflict");
    return success(Object.freeze({
      state_revision: state.state_revision,
      delivery_attempt_id: state.delivery.delivery_attempt_id,
      delivery_attempted_at: state.delivery.delivery_attempted_at,
      delivery_candidate_digest: state.delivery.delivery_candidate_digest,
    }));
  }

  if (state.candidate.status !== "claimed" || state.claim === null) {
    return failure("delivery_state_invalid");
  }
  if (state.state_revision !== inspected.value.expectedRevision) {
    return failure("delivery_conflict");
  }
  if (!sameClaimOwnerAndAttempt(state, inspected.value)) {
    return failure("delivery_conflict");
  }
  if (now >= leaseExpiry || now >= candidateExpiry) return failure("delivery_conflict");

  const digest = deriveDeliveryCandidateDigest(state.candidate, deliveryCandidateDigest);
  if (!digest.ok) return failure(digest.reason);
  const delivery = {
    delivery_attempt_id: inspected.value.deliveryAttemptId,
    delivery_attempted_at: timestamp(now),
    delivery_candidate_digest: digest.value,
  };
  const published = await persistState(mutationPort, inspected.value.candidateId, state.state_revision, {
    candidate: state.candidate,
    claim: state.claim,
    delivery,
  });
  if (!published.ok) return published;
  return success(Object.freeze({
    state_revision: published.value.new_revision,
    delivery_attempt_id: delivery.delivery_attempt_id,
    delivery_attempted_at: delivery.delivery_attempted_at,
    delivery_candidate_digest: delivery.delivery_candidate_digest,
  }));
}

async function confirmDelivery(store, mutationPort, clock, deliveryEvidenceVerifier, request) {
  const inspected = inspectEvidenceRequest(request);
  if (!inspected.ok) return failure(inspected.reason);
  if (!validateSessionIdentity(inspected.value.currentSessionIdentity)) {
    return failure("delivery_input_invalid");
  }
  const now = readClock(clock);
  if (now === null) return failure("delivery_time_invalid");
  const stateResult = await readState(store, inspected.value.candidateId);
  if (!stateResult.ok) return stateResult;
  const state = stateResult.value;

  if (state.candidate.status === "delivered" && state.delivery !== undefined) {
    if (!sameClaimOwnerAndAttempt(state, inspected.value)
      || state.delivery.delivery_attempt_id !== inspected.value.deliveryAttemptId
      || !isOriginalExpectedRevision(state.state_revision, inspected.value.expectedRevision)) {
      return failure("delivery_conflict");
    }
    const verified = verifyEvidence(deliveryEvidenceVerifier, state, inspected.value);
    if (!verified.ok) return verified;
    if (!sameNormalizedEvidence(verified.value, state.delivery.evidence)) {
      return failure("delivery_evidence_mismatch");
    }
    return success(Object.freeze({
      state_revision: state.state_revision,
      status: "delivered",
      delivery_attempt_id: state.delivery.delivery_attempt_id,
      evidence_id: state.delivery.evidence.evidence_id,
      delivered_at: state.delivery.delivered_at,
    }));
  }
  if (state.candidate.status !== "claimed" || state.claim === null || state.delivery === undefined) {
    return failure(["pending", "expired", "consumed"].includes(state.candidate.status)
      ? "delivery_conflict"
      : "delivery_state_invalid");
  }
  if (state.state_revision !== inspected.value.expectedRevision) {
    return failure("delivery_conflict");
  }
  if (!sameClaimOwnerAndAttempt(state, inspected.value)
    || state.delivery.delivery_attempt_id !== inspected.value.deliveryAttemptId) {
    return failure("delivery_conflict");
  }

  const verified = verifyEvidence(deliveryEvidenceVerifier, state, inspected.value);
  if (!verified.ok) return verified;
  const attemptedAt = Date.parse(state.delivery.delivery_attempted_at);
  const confirmedAt = Date.parse(verified.value.confirmed_at);
  const leaseExpiry = readClaimLeaseExpiry(state.claim);
  const candidateExpiry = readCandidateExpiry(state.candidate);
  if (!Number.isFinite(attemptedAt)
    || !Number.isFinite(confirmedAt)
    || leaseExpiry === null
    || candidateExpiry === null
    || attemptedAt > confirmedAt
    || confirmedAt >= leaseExpiry
    || confirmedAt >= candidateExpiry
    || confirmedAt > now) {
    return failure("delivery_time_invalid");
  }

  const delivered = transitionCandidate(state.candidate, {
    type: "confirm_delivery",
    delivery_evidence_verified: true,
  });
  if (!delivered.ok) return failure("delivery_state_invalid");
  const delivery = {
    ...state.delivery,
    evidence: verified.value,
    delivered_at: verified.value.confirmed_at,
  };
  const published = await persistState(mutationPort, inspected.value.candidateId, state.state_revision, {
    candidate: delivered.value,
    claim: state.claim,
    delivery,
  });
  if (!published.ok) return published;
  return success(Object.freeze({
    state_revision: published.value.new_revision,
    status: "delivered",
    delivery_attempt_id: delivery.delivery_attempt_id,
    evidence_id: delivery.evidence.evidence_id,
    delivered_at: delivery.delivered_at,
  }));
}

async function releaseUnconfirmedDelivery(store, mutationPort, clock, request) {
  const inspected = inspectRequest(request, [
    "candidate_id",
    "expected_revision",
    "current_session_identity",
    "claim_attempt_id",
    "delivery_attempt_id",
  ]);
  if (!inspected.ok) return failure(inspected.reason);
  if (!validateSessionIdentity(inspected.value.currentSessionIdentity)) {
    return failure("delivery_input_invalid");
  }
  const now = readClock(clock);
  if (now === null) return failure("delivery_time_invalid");
  const stateResult = await readState(store, inspected.value.candidateId);
  if (!stateResult.ok) return stateResult;
  const state = stateResult.value;
  if (state.candidate.status !== "claimed"
    || state.claim === null
    || state.delivery === undefined
    || state.state_revision !== inspected.value.expectedRevision
    || !sameClaimOwnerAndAttempt(state, inspected.value)
    || state.delivery.delivery_attempt_id !== inspected.value.deliveryAttemptId) {
    return failure("delivery_conflict");
  }
  const leaseExpiry = readClaimLeaseExpiry(state.claim);
  const candidateExpiry = readCandidateExpiry(state.candidate);
  if (leaseExpiry === null || candidateExpiry === null) return failure("delivery_state_invalid");
  if (now >= leaseExpiry || now >= candidateExpiry) return failure("delivery_conflict");
  const pending = transitionCandidate(state.candidate, {
    type: "release_before_delivery",
    owner_verified: true,
    attempt_verified: true,
    revision_verified: true,
    delivery_not_confirmed: true,
  });
  if (!pending.ok) return failure("delivery_state_invalid");
  const published = await persistState(mutationPort, inspected.value.candidateId, state.state_revision, {
    candidate: pending.value,
    claim: null,
    delivery: null,
  });
  if (!published.ok) return published;
  return success(Object.freeze({
    state_revision: published.value.new_revision,
    status: "pending",
  }));
}

async function consumeDelivered(store, mutationPort, clock, deliveryEvidenceVerifier, request) {
  const inspected = inspectEvidenceRequest(request);
  if (!inspected.ok) return failure(inspected.reason.replace(/^delivery_/, "consumption_"));
  if (!validateSessionIdentity(inspected.value.currentSessionIdentity)) {
    return failure("consumption_input_invalid");
  }

  const stateResult = await readState(store, inspected.value.candidateId);
  if (!stateResult.ok) return mapConsumptionStateFailure(stateResult);
  const state = stateResult.value;

  if (state.candidate.status === "consumed" && state.delivery !== undefined) {
    if (!sameClaimOwnerAndAttempt(state, inspected.value)
      || state.delivery.delivery_attempt_id !== inspected.value.deliveryAttemptId
      || !isOriginalExpectedRevision(state.state_revision, inspected.value.expectedRevision)) {
      return failure("consumption_conflict");
    }
    const verified = verifyEvidence(deliveryEvidenceVerifier, state, inspected.value);
    const mapped = mapConsumptionEvidenceFailure(verified);
    if (!mapped.ok) return mapped;
    if (!sameNormalizedEvidence(mapped.value, state.delivery.evidence)) {
      return failure("consumption_evidence_unknown");
    }
    return success(Object.freeze({
      state_revision: state.state_revision,
      status: "consumed",
      delivery_attempt_id: state.delivery.delivery_attempt_id,
      consumed_at: state.delivery.consumed_at,
    }));
  }

  const now = readClock(clock);
  if (now === null) return failure("consumption_evidence_unknown");

  if (state.candidate.status !== "delivered" || state.claim === null || state.delivery === undefined) {
    return failure("consumption_conflict");
  }
  if (state.state_revision !== inspected.value.expectedRevision
    || !sameClaimOwnerAndAttempt(state, inspected.value)
    || state.delivery.delivery_attempt_id !== inspected.value.deliveryAttemptId) {
    return failure("consumption_conflict");
  }

  const verified = verifyEvidence(deliveryEvidenceVerifier, state, inspected.value);
  const mapped = mapConsumptionEvidenceFailure(verified);
  if (!mapped.ok) return mapped;
  if (!sameNormalizedEvidence(mapped.value, state.delivery.evidence)) {
    return failure("consumption_evidence_unknown");
  }

  const deliveredAt = Date.parse(state.delivery.delivered_at);
  const candidateExpiry = readCandidateExpiry(state.candidate);
  if (!Number.isFinite(deliveredAt)
    || candidateExpiry === null
    || deliveredAt >= candidateExpiry
    || deliveredAt > now) {
    return failure("consumption_evidence_unknown");
  }
  const consumed = transitionCandidate(state.candidate, {
    type: "consume",
    delivery_evidence_verified: true,
    consumption_preconditions_verified: true,
  });
  if (!consumed.ok) return failure("consumption_conflict");
  const consumedAt = timestamp(now);
  if (consumedAt === null) return failure("consumption_evidence_unknown");
  const delivery = {
    ...state.delivery,
    consumed_at: consumedAt,
  };
  const published = await persistState(mutationPort, inspected.value.candidateId, state.state_revision, {
    candidate: consumed.value,
    claim: state.claim,
    delivery,
  });
  if (!published.ok) return mapConsumptionPublishFailure(published);
  return success(Object.freeze({
    state_revision: published.value.new_revision,
    status: "consumed",
    delivery_attempt_id: delivery.delivery_attempt_id,
    consumed_at: delivery.consumed_at,
  }));
}

function mapConsumptionEvidenceFailure(result) {
  if (result?.ok === true) return result;
  return failure("consumption_evidence_unknown");
}

function mapConsumptionStateFailure(result) {
  if (result?.reason === "delivery_conflict") return failure("consumption_conflict");
  return failure("consumption_evidence_unknown");
}

function mapConsumptionPublishFailure(result) {
  if (result?.reason === "delivery_conflict") return failure("consumption_conflict");
  return failure("consumption_publish_failed");
}

function inspectServiceOptions(options) {
  try {
    if (!isPlainObject(options)) return failure("delivery_dependency_invalid");
    const keys = Reflect.ownKeys(options);
    if (keys.length !== SERVICE_KEYS.length || keys.some(key => !SERVICE_KEYS.includes(key))) {
      return failure("delivery_dependency_invalid");
    }
    for (const key of SERVICE_KEYS) {
      if (!isEnumerableDataDescriptor(Object.getOwnPropertyDescriptor(options, key))) {
        return failure("delivery_dependency_invalid");
      }
    }
    if (!isPlainObject(options.store)
      || STORE_METHODS.some(method => typeof options.store[method] !== "function")
      || !isPlainObject(options.mutationPort)
      || !Object.isFrozen(options.mutationPort)
      || typeof options.mutationPort.compareAndSetState !== "function"
      || typeof options.clock !== "function"
      || typeof options.deliveryCandidateDigest !== "function"
      || typeof options.deliveryEvidenceVerifier !== "function"
      || !Object.isFrozen(options.deliveryCandidateDigest)
      || !Object.isFrozen(options.deliveryEvidenceVerifier)) {
      return failure("delivery_dependency_invalid");
    }
    return success(Object.freeze({
      store: options.store,
      mutationPort: options.mutationPort,
      clock: options.clock,
      deliveryCandidateDigest: options.deliveryCandidateDigest,
      deliveryEvidenceVerifier: options.deliveryEvidenceVerifier,
    }));
  } catch {
    return failure("delivery_dependency_invalid");
  }
}

function validateSessionIdentity(value) {
  try {
    const result = validateOpaqueIdentity(value);
    return result.ok && result.kind === "session";
  } catch {
    return false;
  }
}

function validAttemptId(value) {
  return typeof value === "string" && DELIVERY_ATTEMPT_ID_PATTERN.test(value);
}

function inspectRequest(request, fields) {
  try {
    if (!isPlainObject(request)) return failure("delivery_input_invalid");
    const keys = Reflect.ownKeys(request);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
      return failure("delivery_input_invalid");
    }
    for (const field of fields) {
      if (!isEnumerableDataDescriptor(Object.getOwnPropertyDescriptor(request, field))) {
        return failure("delivery_input_invalid");
      }
    }
    if (typeof request.candidate_id !== "string" || request.candidate_id.trim().length === 0) {
      return failure("delivery_input_invalid");
    }
    if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision < 0) {
      return failure("delivery_input_invalid");
    }
    if (typeof request.current_session_identity !== "string"
      || typeof request.claim_attempt_id !== "string"
      || !validAttemptId(request.claim_attempt_id)) {
      return failure("delivery_attempt_invalid");
    }
    if (fields.includes("delivery_attempt_id")
      && (typeof request.delivery_attempt_id !== "string" || !validAttemptId(request.delivery_attempt_id))) {
      return failure("delivery_attempt_invalid");
    }
    return success(Object.freeze({
      candidateId: request.candidate_id,
      expectedRevision: request.expected_revision,
      currentSessionIdentity: request.current_session_identity,
      claimAttemptId: request.claim_attempt_id,
      deliveryAttemptId: request.delivery_attempt_id,
    }));
  } catch {
    return failure("delivery_input_invalid");
  }
}

function inspectEvidenceRequest(request) {
  try {
    if (!isPlainObject(request) || !Object.hasOwn(request, "evidence")) {
      return failure("delivery_input_invalid");
    }
    const fields = [
      "candidate_id",
      "expected_revision",
      "current_session_identity",
      "claim_attempt_id",
      "delivery_attempt_id",
    ];
    const keys = Reflect.ownKeys(request);
    if (keys.length !== fields.length + 1 || keys.some(key => !fields.includes(key) && key !== "evidence")) {
      return failure("delivery_input_invalid");
    }
    if (!isEnumerableDataDescriptor(Object.getOwnPropertyDescriptor(request, "evidence"))) {
      return failure("delivery_input_invalid");
    }
    const baseRequest = {};
    for (const field of fields) baseRequest[field] = request[field];
    const inspected = inspectRequest(baseRequest, fields);
    if (!inspected.ok) return inspected;
    return success(Object.freeze({ ...inspected.value, evidence: request.evidence }));
  } catch {
    return failure("delivery_input_invalid");
  }
}

function verifyEvidence(verifier, state, request) {
  const expected = Object.freeze({
    candidate_id: state.candidate.candidate_id,
    delivery_candidate_digest: state.delivery.delivery_candidate_digest,
    current_session_identity: state.claim.claim_owner_identity,
    claim_attempt_id: state.claim.claim_attempt_id,
    delivery_attempt_id: state.delivery.delivery_attempt_id,
  });
  let normalized;
  try {
    normalized = verifier({ expected, evidence: request.evidence });
  } catch {
    return failure("delivery_evidence_unavailable");
  }
  const result = normalizeEvidenceResult(normalized, expected);
  return result.ok ? result : failure("delivery_evidence_invalid");
}

function normalizeEvidenceResult(value, expected) {
  const fields = [
    "verification",
    "evidence_id",
    "candidate_id",
    "candidate_digest",
    "current_session_identity",
    "claim_attempt_id",
    "delivery_attempt_id",
    "runtime",
    "adapter_version",
    "injection_surface_accepted",
    "candidate_available",
    "confirmed_at",
  ];
  if (!isPlainObject(value)) return failure("delivery_evidence_invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    return failure("delivery_evidence_invalid");
  }
  for (const field of fields) {
    if (!isEnumerableDataDescriptor(Object.getOwnPropertyDescriptor(value, field))) {
      return failure("delivery_evidence_invalid");
    }
  }
  if (typeof value.verification !== "string"
    || typeof value.evidence_id !== "string"
    || typeof value.candidate_id !== "string"
    || typeof value.candidate_digest !== "string"
    || typeof value.current_session_identity !== "string"
    || typeof value.claim_attempt_id !== "string"
    || typeof value.delivery_attempt_id !== "string"
    || typeof value.runtime !== "string"
    || typeof value.adapter_version !== "string"
    || typeof value.injection_surface_accepted !== "boolean"
    || typeof value.candidate_available !== "boolean"
    || typeof value.confirmed_at !== "string") {
    return failure("delivery_evidence_invalid");
  }
  if (!isSafeEvidenceId(value.evidence_id)
    || !isSafeRuntimeId(value.runtime)
    || !isSafeAdapterVersion(value.adapter_version)) {
    return failure("delivery_evidence_invalid");
  }
  let identity;
  try {
    identity = validateOpaqueIdentity(value.current_session_identity);
  } catch {
    return failure("delivery_evidence_invalid");
  }
  if (value.verification !== "passed"
    || value.candidate_id !== expected.candidate_id
    || !/^[A-Za-z0-9_-]{43}$/.test(value.candidate_digest)
    || value.candidate_digest !== expected.delivery_candidate_digest
    || !identity.ok
    || identity.kind !== "session"
    || value.current_session_identity !== expected.current_session_identity
    || value.claim_attempt_id !== expected.claim_attempt_id
    || value.delivery_attempt_id !== expected.delivery_attempt_id
    || value.injection_surface_accepted !== true
    || value.candidate_available !== true) {
    return failure("delivery_evidence_invalid");
  }
  if (!isUtcIsoTimestamp(value.confirmed_at)) {
    return failure("delivery_evidence_invalid");
  }
  return success(Object.freeze({
    verification: "passed",
    evidence_id: value.evidence_id,
    candidate_id: value.candidate_id,
    candidate_digest: value.candidate_digest,
    current_session_identity: value.current_session_identity,
    claim_attempt_id: value.claim_attempt_id,
    delivery_attempt_id: value.delivery_attempt_id,
    runtime: value.runtime,
    adapter_version: value.adapter_version,
    injection_surface_accepted: true,
    candidate_available: true,
    confirmed_at: value.confirmed_at,
  }));
}

function sameNormalizedEvidence(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function sameClaimOwnerAndAttempt(state, request) {
  return state.claim?.claim_owner_identity === request.currentSessionIdentity
    && state.claim?.claim_attempt_id === request.claimAttemptId;
}

function isOriginalExpectedRevision(stateRevision, expectedRevision) {
  return stateRevision >= 1 && expectedRevision === stateRevision - 1;
}

function deriveDeliveryCandidateDigest(candidate, provider) {
  const prepared = createPendingHandoffCanonicalCandidateBytes(candidate);
  if (!prepared.ok) return failure("delivery_digest_invalid");
  try {
    const digest = provider({
      purpose: DELIVERY_DIGEST_PURPOSE,
      bytes: new Uint8Array(prepared.value.bytes),
    });
    if (typeof digest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(digest)) {
      return failure("delivery_digest_invalid");
    }
    return success(digest);
  } catch {
    return failure("delivery_digest_failed");
  }
}

async function readState(store, candidateId) {
  let result;
  try {
    result = await store.readState(candidateId);
  } catch {
    return failure("delivery_state_invalid");
  }
  if (result?.ok === true) return success(result.value);
  if (["revision_conflict", "cas_arbitration_failed"].includes(result?.reason)) {
    return failure("delivery_conflict");
  }
  if (["record_integrity_invalid", "record_integrity_key_invalid", "record_integrity_mismatch", "revision_invalid", "record_malformed", "record_invalid"].includes(result?.reason)) {
    return failure("delivery_state_invalid");
  }
  return failure("delivery_state_invalid");
}

async function persistState(mutationPort, candidateId, expectedRevision, nextState) {
  let result;
  try {
    result = await mutationPort.compareAndSetState({
      candidate_id: candidateId,
      expected_revision: expectedRevision,
      next_state: nextState,
    });
  } catch {
    return failure("delivery_publish_failed");
  }
  if (result?.ok === true) return success(result.value);
  if (result?.reason === "revision_conflict" || result?.reason === "cas_arbitration_failed") {
    return failure("delivery_conflict");
  }
  return failure("delivery_publish_failed");
}

function readClock(clock) {
  try {
    const value = clock();
    return Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime())
      ? value
      : null;
  } catch {
    return null;
  }
}

function timestamp(value) {
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function readCandidateExpiry(candidate) {
  try {
    const value = Date.parse(candidate?.expires_at);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function readClaimLeaseExpiry(claim) {
  try {
    const value = Date.parse(claim?.claim_lease_expires_at);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function isSafeEvidenceId(value) {
  return typeof value === "string" && EVIDENCE_ID_PATTERN.test(value);
}

function isSafeRuntimeId(value) {
  return typeof value === "string" && RUNTIME_ID_PATTERN.test(value);
}

function isSafeAdapterVersion(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && ADAPTER_VERSION_PATTERN.test(value);
}

function isUtcIsoTimestamp(value) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const normalized = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return new Date(parsed).toISOString() === normalized;
}

function isPlainObject(value) {
  try {
    return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
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
  return Object.freeze({ ok: true, value: Object.isFrozen(value) ? value : Object.freeze(value) });
}

function failure(reason) {
  return Object.freeze({ ok: false, reason });
}
