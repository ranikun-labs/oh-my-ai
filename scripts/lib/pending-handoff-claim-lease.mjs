import { transitionCandidate } from "./pending-handoff-core.mjs";
import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";

const CLAIM_ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SERVICE_KEYS = Object.freeze(["store", "mutationPort", "leaseDurationMs", "clock"]);
const STORE_METHODS = Object.freeze(["readState"]);

export const PENDING_HANDOFF_CLAIM_LEASE_FAILURES = Object.freeze([
  "claim_dependency_invalid",
  "claim_input_invalid",
  "claim_state_invalid",
  "claim_conflict",
  "claim_owner_invalid",
  "claim_attempt_invalid",
  "claim_time_invalid",
  "claim_lease_active",
  "claim_lease_expired",
  "claim_read_failed",
  "claim_publish_failed",
]);

export function createPendingHandoffClaimLeaseService(options) {
  const inspected = inspectServiceOptions(options);
  if (!inspected.ok) return failure(inspected.reason);

  const { store, mutationPort, leaseDurationMs, clock } = inspected.value;
  const service = Object.freeze({
    acquireClaim: request => acquireClaim(
      store,
      mutationPort,
      leaseDurationMs,
      clock,
      request,
      { allowSameAttemptReplay: true },
    ),
    acquireClaimForDispatch: request => acquireClaim(
      store,
      mutationPort,
      leaseDurationMs,
      clock,
      request,
      { allowSameAttemptReplay: false },
    ),
    registerPending: request => registerPending(store, mutationPort, clock, request),
    recoverClaimLease: request => recoverClaimLease(store, mutationPort, clock, request),
    releaseClaimBeforeDelivery: request => releaseClaimBeforeDelivery(store, mutationPort, clock, request),
  });
  return success(service);
}

async function registerPending(store, mutationPort, clock, request) {
  const inspected = inspectRequest(request, ["candidate_id", "expected_revision"]);
  if (!inspected.ok) return failure(inspected.reason);
  const now = readClock(clock);
  if (now === null) return failure("claim_time_invalid");

  const stateResult = await readState(store, inspected.value.candidateId);
  if (!stateResult.ok) return stateResult;
  const state = stateResult.value;
  if (state.state_revision !== inspected.value.expectedRevision) {
    return failure("claim_conflict");
  }
  if (state.candidate.status !== "candidate" || state.claim !== null) {
    return failure("claim_state_invalid");
  }
  if (isCandidateExpired(state.candidate, now)) {
    const expired = transitionCandidate(state.candidate, {
      type: "expire",
      expiration_verified: true,
    });
    if (!expired.ok) return failure("claim_state_invalid");
    const published = await persistState(mutationPort, inspected.value.candidateId, state.state_revision, {
      candidate: expired.value,
      claim: null,
    });
    if (!published.ok) return published;
    return failure("claim_time_invalid");
  }

  const pending = transitionCandidate(state.candidate, {
    type: "register",
    candidate_validation_verified: true,
    privacy_validation_verified: true,
  });
  if (!pending.ok) return failure("claim_state_invalid");
  const published = await persistState(mutationPort, inspected.value.candidateId, state.state_revision, {
    candidate: pending.value,
    claim: null,
  });
  if (!published.ok) return published;
  return success(Object.freeze({
    state_revision: published.value.new_revision,
    status: "pending",
  }));
}

async function acquireClaim(
  store,
  mutationPort,
  leaseDurationMs,
  clock,
  request,
  { allowSameAttemptReplay },
) {
  const inspected = inspectRequest(request, [
    "candidate_id",
    "expected_revision",
    "current_session_identity",
    "claim_attempt_id",
  ]);
  if (!inspected.ok) return failure(inspected.reason);

  const ownerResult = validateSessionIdentity(inspected.value.currentSessionIdentity);
  if (!ownerResult.ok) return failure("claim_owner_invalid");
  if (!validAttemptId(inspected.value.claimAttemptId)) {
    return failure("claim_attempt_invalid");
  }
  const now = readClock(clock);
  if (now === null) return failure("claim_time_invalid");

  const stateResult = await readState(store, inspected.value.candidateId);
  if (!stateResult.ok) return stateResult;
  const state = stateResult.value;
  const candidateExpiry = readCandidateExpiry(state.candidate);
  if (candidateExpiry === null) return failure("claim_state_invalid");
  if (state.candidate.source_session_identity === inspected.value.currentSessionIdentity) {
    return failure("claim_owner_invalid");
  }

  if (state.candidate.status === "claimed" && state.claim !== null) {
    const leaseExpiry = Date.parse(state.claim.claim_lease_expires_at);
    if (!Number.isFinite(leaseExpiry)) return failure("claim_state_invalid");
    if (now >= leaseExpiry || now >= candidateExpiry) {
      return failure("claim_lease_expired");
    }
    if (state.claim.claim_owner_identity === inspected.value.currentSessionIdentity
      && state.claim.claim_attempt_id === inspected.value.claimAttemptId) {
      if (!allowSameAttemptReplay) return failure("claim_conflict");
      if (state.state_revision < 1
        || inspected.value.expectedRevision !== state.state_revision - 1) {
        return failure("claim_conflict");
      }
      return success(Object.freeze({
        state_revision: state.state_revision,
        claim_attempt_id: state.claim.claim_attempt_id,
        claim_lease_expires_at: state.claim.claim_lease_expires_at,
      }));
    }
    return failure("claim_conflict");
  }

  if (state.state_revision !== inspected.value.expectedRevision) {
    return failure("claim_conflict");
  }
  if (state.candidate.status !== "pending" || state.claim !== null) {
    return failure("claim_state_invalid");
  }
  if (now >= candidateExpiry) {
    const expired = transitionCandidate(state.candidate, {
      type: "expire",
      expiration_verified: true,
    });
    if (!expired.ok) return failure("claim_state_invalid");
    const published = await persistState(mutationPort, inspected.value.candidateId, state.state_revision, {
      candidate: expired.value,
      claim: null,
    });
    if (!published.ok) return published;
    return failure("claim_time_invalid");
  }

  const leaseExpiresAt = Math.min(now + leaseDurationMs, candidateExpiry);
  if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= now) {
    return failure("claim_time_invalid");
  }
  const claimed = transitionCandidate(state.candidate, {
    type: "claim",
    preconditions_verified: true,
  });
  if (!claimed.ok) return failure("claim_state_invalid");
  const claim = {
    claim_owner_identity: inspected.value.currentSessionIdentity,
    claim_started_at: timestamp(now),
    claim_lease_expires_at: timestamp(leaseExpiresAt),
    claim_attempt_id: inspected.value.claimAttemptId,
  };
  const published = await persistState(mutationPort, state.candidate.candidate_id, state.state_revision, {
    candidate: claimed.value,
    claim,
  });
  if (!published.ok) return published;
  return success(Object.freeze({
    state_revision: published.value.new_revision,
    claim_attempt_id: claim.claim_attempt_id,
    claim_lease_expires_at: claim.claim_lease_expires_at,
  }));
}

async function recoverClaimLease(store, mutationPort, clock, request) {
  const inspected = inspectRequest(request, ["candidate_id", "expected_revision"]);
  if (!inspected.ok) return failure(inspected.reason);
  const now = readClock(clock);
  if (now === null) return failure("claim_time_invalid");

  const stateResult = await readState(store, inspected.value.candidateId);
  if (!stateResult.ok) return stateResult;
  const state = stateResult.value;
  if (state.state_revision !== inspected.value.expectedRevision) {
    return failure("claim_conflict");
  }
  if (state.candidate.status !== "claimed" || state.claim === null) {
    return failure("claim_state_invalid");
  }
  const leaseExpiry = Date.parse(state.claim.claim_lease_expires_at);
  const candidateExpiry = readCandidateExpiry(state.candidate);
  if (!Number.isFinite(leaseExpiry) || candidateExpiry === null) {
    return failure("claim_state_invalid");
  }
  if (now < leaseExpiry) return failure("claim_lease_active");

  const ttlExpired = now >= candidateExpiry;
  const transition = transitionCandidate(state.candidate, ttlExpired
    ? { type: "expire", expiration_verified: true }
    : {
      type: "lease_expired",
      lease_expiration_verified: true,
      ttl_valid: true,
      revision_verified: true,
    });
  if (!transition.ok) return failure("claim_state_invalid");
  const published = await persistState(mutationPort, inspected.value.candidateId, state.state_revision, {
    candidate: transition.value,
    claim: null,
    delivery: null,
  });
  if (!published.ok) return published;
  return success(Object.freeze({
    state_revision: published.value.new_revision,
    status: ttlExpired ? "expired" : "pending",
  }));
}

async function releaseClaimBeforeDelivery(store, mutationPort, clock, request) {
  const inspected = inspectRequest(request, [
    "candidate_id",
    "expected_revision",
    "current_session_identity",
    "claim_attempt_id",
  ]);
  if (!inspected.ok) return failure(inspected.reason);
  if (!validateSessionIdentity(inspected.value.currentSessionIdentity).ok) {
    return failure("claim_owner_invalid");
  }
  if (!validAttemptId(inspected.value.claimAttemptId)) {
    return failure("claim_attempt_invalid");
  }
  const now = readClock(clock);
  if (now === null) return failure("claim_time_invalid");

  const stateResult = await readState(store, inspected.value.candidateId);
  if (!stateResult.ok) return stateResult;
  const state = stateResult.value;
  if (state.state_revision !== inspected.value.expectedRevision) {
    return failure("claim_conflict");
  }
  if (state.candidate.status !== "claimed" || state.claim === null) {
    return failure("claim_state_invalid");
  }
  if (state.delivery !== undefined && state.delivery !== null) {
    return failure("claim_conflict");
  }
  const leaseExpiry = Date.parse(state.claim.claim_lease_expires_at);
  const candidateExpiry = readCandidateExpiry(state.candidate);
  if (!Number.isFinite(leaseExpiry) || candidateExpiry === null) {
    return failure("claim_state_invalid");
  }
  if (now >= leaseExpiry) return failure("claim_lease_expired");
  if (now >= candidateExpiry) return failure("claim_time_invalid");
  if (state.claim.claim_owner_identity !== inspected.value.currentSessionIdentity
    || state.claim.claim_attempt_id !== inspected.value.claimAttemptId) {
    return failure("claim_conflict");
  }

  const pending = transitionCandidate(state.candidate, {
    type: "release_before_delivery",
    owner_verified: true,
    attempt_verified: true,
    revision_verified: true,
    delivery_not_confirmed: true,
  });
  if (!pending.ok) return failure("claim_state_invalid");
  const published = await persistState(mutationPort, inspected.value.candidateId, state.state_revision, {
    candidate: pending.value,
    claim: null,
  });
  if (!published.ok) return published;
  return success(Object.freeze({
    state_revision: published.value.new_revision,
    status: "pending",
  }));
}

async function readState(store, candidateId) {
  let result;
  try {
    result = await store.readState(candidateId);
  } catch {
    return failure("claim_read_failed");
  }
  if (result?.ok === true) return success(result.value);
  return failure(mapStoreFailure(result?.reason));
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
    return failure("claim_publish_failed");
  }
  if (result?.ok === true) return success(result.value);
  return failure(mapStoreFailure(result?.reason));
}

function inspectServiceOptions(options) {
  try {
    if (!isPlainObject(options)) return failure("claim_dependency_invalid");
    const keys = Reflect.ownKeys(options);
    if (keys.length !== SERVICE_KEYS.length || keys.some(key => !SERVICE_KEYS.includes(key))) {
      return failure("claim_dependency_invalid");
    }
    for (const key of SERVICE_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!isEnumerableDataDescriptor(descriptor)) return failure("claim_dependency_invalid");
    }
    if (!isPlainObject(options.store)
      || STORE_METHODS.some(method => typeof options.store[method] !== "function")
      || !isPlainObject(options.mutationPort)
      || !Object.isFrozen(options.mutationPort)
      || typeof options.mutationPort.compareAndSetState !== "function"
      || !Number.isSafeInteger(options.leaseDurationMs)
      || options.leaseDurationMs <= 0
      || typeof options.clock !== "function") {
      return failure("claim_dependency_invalid");
    }
    return success(Object.freeze({
      store: options.store,
      mutationPort: options.mutationPort,
      leaseDurationMs: options.leaseDurationMs,
      clock: options.clock,
    }));
  } catch {
    return failure("claim_dependency_invalid");
  }
}

function inspectRequest(request, fields) {
  try {
    if (!isPlainObject(request)) return failure("claim_input_invalid");
    const keys = Reflect.ownKeys(request);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
      return failure("claim_input_invalid");
    }
    for (const field of fields) {
      if (!isEnumerableDataDescriptor(Object.getOwnPropertyDescriptor(request, field))) {
        return failure("claim_input_invalid");
      }
    }
    if (typeof request.candidate_id !== "string" || request.candidate_id.trim().length === 0) {
      return failure("claim_input_invalid");
    }
    if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision < 0) {
      return failure("claim_input_invalid");
    }
    if (fields.includes("current_session_identity")
      && typeof request.current_session_identity !== "string") {
      return failure("claim_input_invalid");
    }
    if (fields.includes("claim_attempt_id") && typeof request.claim_attempt_id !== "string") {
      return failure("claim_input_invalid");
    }
    return success(Object.freeze({
      candidateId: request.candidate_id,
      expectedRevision: request.expected_revision,
      currentSessionIdentity: request.current_session_identity,
      claimAttemptId: request.claim_attempt_id,
    }));
  } catch {
    return failure("claim_input_invalid");
  }
}

function validateSessionIdentity(value) {
  try {
    const result = validateOpaqueIdentity(value);
    return result.ok && result.kind === "session"
      ? success(value)
      : failure("claim_owner_invalid");
  } catch {
    return failure("claim_owner_invalid");
  }
}

function validAttemptId(value) {
  return typeof value === "string" && CLAIM_ATTEMPT_ID_PATTERN.test(value);
}

function readClock(clock) {
  try {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return Number.isFinite(new Date(value).getTime()) ? value : null;
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

function isCandidateExpired(candidate, now) {
  const expiresAt = readCandidateExpiry(candidate);
  return expiresAt === null || now >= expiresAt;
}

function mapStoreFailure(reason) {
  if (["revision_conflict", "cas_arbitration_failed"].includes(reason)) {
    return "claim_conflict";
  }
  if (["record_invalid", "record_exists"].includes(reason)) {
    return "claim_state_invalid";
  }
  if ([
    "record_integrity_invalid",
    "record_integrity_key_invalid",
    "record_integrity_mismatch",
    "revision_invalid",
    "record_malformed",
    "unsafe_store_path",
    "unsafe_record_path",
  ].includes(reason)) return "claim_state_invalid";
  if (["cas_publish_failed", "record_replace_failed", "record_write_failed"].includes(reason)) {
    return "claim_publish_failed";
  }
  return "claim_read_failed";
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
