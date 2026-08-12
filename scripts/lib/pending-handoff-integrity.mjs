import { canonicalizePendingHandoffCandidate } from "./pending-handoff-candidate.mjs";
import { validateCandidate } from "./pending-handoff-core.mjs";
import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";

const PROVIDER_KEYS = Object.freeze([
  "version",
  "current_key_id",
  "verification_key_ids",
  "keyed_digest",
  "safe_equal",
]);
const DEPENDENCY_KEYS = Object.freeze(["current", "verification", "safe_equal"]);
const ENTRY_KEYS = Object.freeze(["key_id", "keyed_digest"]);
const ENVELOPE_KEYS = Object.freeze(["envelope_version", "integrity", "candidate"]);
const REVISION_ENVELOPE_KEYS = Object.freeze([
  "envelope_version",
  "state_revision",
  "integrity",
  "candidate",
]);
const INTEGRITY_KEYS = Object.freeze(["algorithm", "key_id", "digest"]);
const CANDIDATE_FIELDS = Object.freeze([
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
const PROVIDER_VERSION = "phr-integrity-provider-v1";
const ENVELOPE_VERSION = "phr-integrity-envelope-v1";
const REVISION_ENVELOPE_VERSION = "phr-integrity-envelope-v2";
const CLAIM_ENVELOPE_VERSION = "phr-integrity-envelope-v3";
const DELIVERY_ENVELOPE_VERSION = "phr-integrity-envelope-v4";
const PURPOSE = "pending-handoff-integrity";
const ALGORITHM = "hmac-sha256-base64url-v1";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_ENVELOPE_KEYS = Object.freeze([
  "envelope_version",
  "state_revision",
  "claim",
  "integrity",
  "candidate",
]);
const CLAIM_KEYS = Object.freeze([
  "claim_owner_identity",
  "claim_started_at",
  "claim_lease_expires_at",
  "claim_attempt_id",
]);
const DELIVERY_ENVELOPE_KEYS = Object.freeze([
  "envelope_version",
  "state_revision",
  "claim",
  "delivery",
  "integrity",
  "candidate",
]);
const DELIVERY_EVIDENCE_KEYS = Object.freeze([
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
const CLAIM_ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DELIVERY_ATTEMPT_ID_PATTERN = CLAIM_ATTEMPT_ID_PATTERN;
const EVIDENCE_ID_PATTERN = /^ev-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ADAPTER_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CLAIM_STATE_STATUSES = Object.freeze(["pending", "claimed", "expired"]);
const DEPENDENCY_FAILURES = Object.freeze([
  "integrity_dependency_invalid",
  "integrity_provider_version_unsupported",
  "integrity_key_id_invalid",
  "integrity_verification_keys_invalid",
]);

export const PENDING_HANDOFF_INTEGRITY_ALGORITHM = ALGORITHM;
export const PENDING_HANDOFF_INTEGRITY_ENVELOPE_VERSION = ENVELOPE_VERSION;
export const PENDING_HANDOFF_INTEGRITY_FAILURES = Object.freeze([
  ...DEPENDENCY_FAILURES,
  "integrity_digest_invalid",
  "integrity_digest_failed",
  "integrity_compare_invalid",
  "integrity_compare_failed",
  "integrity_envelope_invalid",
  "integrity_envelope_version_unsupported",
  "integrity_candidate_invalid",
  "integrity_key_not_found",
  "integrity_mismatch",
]);
export const PENDING_HANDOFF_INTEGRITY_PROVIDER_VERSION = PROVIDER_VERSION;
export const PENDING_HANDOFF_INTEGRITY_PURPOSE = PURPOSE;
export const PENDING_HANDOFF_REVISION_ENVELOPE_VERSION = REVISION_ENVELOPE_VERSION;
export const PENDING_HANDOFF_CLAIM_ENVELOPE_VERSION = CLAIM_ENVELOPE_VERSION;
export const PENDING_HANDOFF_DELIVERY_ENVELOPE_VERSION = DELIVERY_ENVELOPE_VERSION;
export const PENDING_HANDOFF_REVISION_INTEGRITY_FAILURES = Object.freeze([
  ...PENDING_HANDOFF_INTEGRITY_FAILURES,
  "integrity_revision_invalid",
]);
export const PENDING_HANDOFF_CLAIM_INTEGRITY_FAILURES = Object.freeze([
  ...PENDING_HANDOFF_REVISION_INTEGRITY_FAILURES,
  "integrity_claim_invalid",
]);
export const PENDING_HANDOFF_DELIVERY_INTEGRITY_FAILURES = Object.freeze([
  ...PENDING_HANDOFF_CLAIM_INTEGRITY_FAILURES,
  "integrity_delivery_invalid",
]);

export function createPendingHandoffIntegrityDependencies(provider) {
  try {
    const inspected = inspectExactDataObject(provider, PROVIDER_KEYS);
    if (!inspected.ok || !isFrozen(provider)) return failure("integrity_dependency_invalid");

    const values = inspected.values;
    if (values.version !== PROVIDER_VERSION) {
      return failure("integrity_provider_version_unsupported");
    }
    if (!validKeyId(values.current_key_id)) return failure("integrity_key_id_invalid");
    if (!validVerificationKeys(values.verification_key_ids, values.current_key_id)) {
      return failure("integrity_verification_keys_invalid");
    }
    if (!validProviderFunction(values.keyed_digest) || !validProviderFunction(values.safe_equal)) {
      return failure("integrity_dependency_invalid");
    }

    const keyIds = [...values.verification_key_ids];
    const verification = Object.freeze(keyIds.map(keyId => Object.freeze({
      key_id: keyId,
      keyed_digest: createKeyedDigestWrapper(values.keyed_digest, keyId),
    })));
    return success(Object.freeze({
      current: verification[0],
      verification,
      safe_equal: createSafeEqualWrapper(values.safe_equal),
    }));
  } catch {
    return failure("integrity_dependency_invalid");
  }
}

export function createPendingHandoffIntegrityEnvelope(candidate, dependencies) {
  const dependencyStatus = inspectDependencies(dependencies);
  if (!dependencyStatus.ok) return failure(dependencyStatus.reason);

  const prepared = prepareCandidate(candidate);
  if (!prepared.ok) return failure(prepared.reason);

  const digest = callDigest(dependencies.current, prepared.value.bytes);
  if (!digest.ok) return failure(digest.reason);
  return success(Object.freeze({
    envelope_version: ENVELOPE_VERSION,
    integrity: Object.freeze({
      algorithm: ALGORITHM,
      key_id: dependencies.current.key_id,
      digest: digest.value,
    }),
    candidate: prepared.value.candidate,
  }));
}

export function verifyPendingHandoffIntegrityEnvelope(envelope, dependencies) {
  const dependencyStatus = inspectDependencies(dependencies);
  if (!dependencyStatus.ok) return failure(dependencyStatus.reason);

  const inspected = inspectExactDataObject(envelope, ENVELOPE_KEYS);
  if (!inspected.ok) return failure("integrity_envelope_invalid");
  if (inspected.values.envelope_version !== ENVELOPE_VERSION) {
    return failure("integrity_envelope_version_unsupported");
  }

  const integrity = inspectExactDataObject(inspected.values.integrity, INTEGRITY_KEYS);
  if (!integrity.ok
    || integrity.values.algorithm !== ALGORITHM
    || !validKeyId(integrity.values.key_id)
    || !DIGEST_PATTERN.test(integrity.values.digest)) {
    return failure("integrity_envelope_invalid");
  }

  const entry = dependencies.verification.find(item => item.key_id === integrity.values.key_id);
  if (entry === undefined) return failure("integrity_key_not_found");

  const prepared = prepareCandidate(inspected.values.candidate);
  if (!prepared.ok) return failure(prepared.reason);
  const digest = callDigest(entry, prepared.value.bytes);
  if (!digest.ok) return failure(digest.reason);
  const comparison = callSafeEqual(dependencies.safe_equal, integrity.values.digest, digest.value);
  if (!comparison.ok) return failure(comparison.reason);
  if (!comparison.value) return failure("integrity_mismatch");
  return success(prepared.value.candidate);
}

export function createPendingHandoffCanonicalCandidateBytes(candidate) {
  const prepared = prepareStateCandidateSnapshot(
    candidate,
    ["candidate", "pending", "claimed", "delivered", "consumed", "expired", "invalid"],
    "integrity_candidate_invalid",
  );
  if (!prepared.ok) return failure(prepared.reason);
  try {
    const ordered = {};
    for (const field of CANDIDATE_FIELDS) ordered[field] = prepared.value[field];
    const serialized = JSON.stringify(ordered);
    if (typeof serialized !== "string") return failure("integrity_candidate_invalid");
    return success({
      candidate: prepared.value,
      bytes: new TextEncoder().encode(serialized),
    });
  } catch {
    return failure("integrity_candidate_invalid");
  }
}

export function createPendingHandoffRevisionIntegrityEnvelope(
  candidate,
  stateRevision,
  dependencies,
) {
  const dependencyStatus = inspectDependencies(dependencies);
  if (!dependencyStatus.ok) return failure(dependencyStatus.reason);
  if (!validRevision(stateRevision)) return failure("integrity_revision_invalid");

  const prepared = prepareRevisionState(candidate, stateRevision);
  if (!prepared.ok) return failure(prepared.reason);

  const digest = callDigest(dependencies.current, prepared.value.bytes);
  if (!digest.ok) return failure(digest.reason);
  return success(Object.freeze({
    envelope_version: REVISION_ENVELOPE_VERSION,
    state_revision: stateRevision,
    integrity: Object.freeze({
      algorithm: ALGORITHM,
      key_id: dependencies.current.key_id,
      digest: digest.value,
    }),
    candidate: prepared.value.candidate,
  }));
}

export function verifyPendingHandoffRevisionIntegrityEnvelope(envelope, dependencies) {
  const dependencyStatus = inspectDependencies(dependencies);
  if (!dependencyStatus.ok) return failure(dependencyStatus.reason);

  const inspected = inspectExactDataObject(envelope, REVISION_ENVELOPE_KEYS);
  if (!inspected.ok) return failure("integrity_envelope_invalid");
  if (inspected.values.envelope_version !== REVISION_ENVELOPE_VERSION) {
    return failure("integrity_envelope_version_unsupported");
  }
  if (!validRevision(inspected.values.state_revision)) {
    return failure("integrity_revision_invalid");
  }

  const integrity = inspectExactDataObject(inspected.values.integrity, INTEGRITY_KEYS);
  if (!integrity.ok
    || integrity.values.algorithm !== ALGORITHM
    || !validKeyId(integrity.values.key_id)
    || !DIGEST_PATTERN.test(integrity.values.digest)) {
    return failure("integrity_envelope_invalid");
  }

  const entry = dependencies.verification.find(item => item.key_id === integrity.values.key_id);
  if (entry === undefined) return failure("integrity_key_not_found");

  const prepared = prepareRevisionState(inspected.values.candidate, inspected.values.state_revision);
  if (!prepared.ok) return failure(prepared.reason);
  const digest = callDigest(entry, prepared.value.bytes);
  if (!digest.ok) return failure(digest.reason);
  const comparison = callSafeEqual(dependencies.safe_equal, integrity.values.digest, digest.value);
  if (!comparison.ok) return failure(comparison.reason);
  if (!comparison.value) return failure("integrity_mismatch");
  return success(Object.freeze({
    candidate: prepared.value.candidate,
    state_revision: inspected.values.state_revision,
  }));
}

export function createPendingHandoffClaimIntegrityEnvelope(
  candidate,
  stateRevision,
  claim,
  dependencies,
) {
  const dependencyStatus = inspectDependencies(dependencies);
  if (!dependencyStatus.ok) return failure(dependencyStatus.reason);
  if (!validRevision(stateRevision)) return failure("integrity_revision_invalid");

  const prepared = prepareClaimState(candidate, stateRevision, claim);
  if (!prepared.ok) return failure(prepared.reason);

  const digest = callDigest(dependencies.current, prepared.value.bytes);
  if (!digest.ok) return failure(digest.reason);
  return success(Object.freeze({
    envelope_version: CLAIM_ENVELOPE_VERSION,
    state_revision: stateRevision,
    claim: prepared.value.claim,
    integrity: Object.freeze({
      algorithm: ALGORITHM,
      key_id: dependencies.current.key_id,
      digest: digest.value,
    }),
    candidate: prepared.value.candidate,
  }));
}

export function verifyPendingHandoffClaimIntegrityEnvelope(envelope, dependencies) {
  const dependencyStatus = inspectDependencies(dependencies);
  if (!dependencyStatus.ok) return failure(dependencyStatus.reason);

  const inspected = inspectExactDataObject(envelope, CLAIM_ENVELOPE_KEYS);
  if (!inspected.ok) return failure("integrity_envelope_invalid");
  if (inspected.values.envelope_version !== CLAIM_ENVELOPE_VERSION) {
    return failure("integrity_envelope_version_unsupported");
  }
  if (!validRevision(inspected.values.state_revision)) {
    return failure("integrity_revision_invalid");
  }

  const integrity = inspectExactDataObject(inspected.values.integrity, INTEGRITY_KEYS);
  if (!integrity.ok
    || integrity.values.algorithm !== ALGORITHM
    || !validKeyId(integrity.values.key_id)
    || !DIGEST_PATTERN.test(integrity.values.digest)) {
    return failure("integrity_envelope_invalid");
  }

  const entry = dependencies.verification.find(item => item.key_id === integrity.values.key_id);
  if (entry === undefined) return failure("integrity_key_not_found");

  const prepared = prepareClaimState(
    inspected.values.candidate,
    inspected.values.state_revision,
    inspected.values.claim,
  );
  if (!prepared.ok) return failure(prepared.reason);
  const digest = callDigest(entry, prepared.value.bytes);
  if (!digest.ok) return failure(digest.reason);
  const comparison = callSafeEqual(dependencies.safe_equal, integrity.values.digest, digest.value);
  if (!comparison.ok) return failure(comparison.reason);
  if (!comparison.value) return failure("integrity_mismatch");
  return success(Object.freeze({
    candidate: prepared.value.candidate,
    state_revision: inspected.values.state_revision,
    claim: prepared.value.claim,
  }));
}

export function createPendingHandoffDeliveryIntegrityEnvelope(
  candidate,
  stateRevision,
  claim,
  delivery,
  dependencies,
) {
  const dependencyStatus = inspectDependencies(dependencies);
  if (!dependencyStatus.ok) return failure(dependencyStatus.reason);
  if (!validRevision(stateRevision)) return failure("integrity_revision_invalid");

  const prepared = prepareDeliveryState(candidate, stateRevision, claim, delivery);
  if (!prepared.ok) return failure(prepared.reason);

  const digest = callDigest(dependencies.current, prepared.value.bytes);
  if (!digest.ok) return failure(digest.reason);
  return success(Object.freeze({
    envelope_version: DELIVERY_ENVELOPE_VERSION,
    state_revision: stateRevision,
    claim: prepared.value.claim,
    delivery: prepared.value.delivery,
    integrity: Object.freeze({
      algorithm: ALGORITHM,
      key_id: dependencies.current.key_id,
      digest: digest.value,
    }),
    candidate: prepared.value.candidate,
  }));
}

export function verifyPendingHandoffDeliveryIntegrityEnvelope(envelope, dependencies) {
  const dependencyStatus = inspectDependencies(dependencies);
  if (!dependencyStatus.ok) return failure(dependencyStatus.reason);

  const inspected = inspectExactDataObject(envelope, DELIVERY_ENVELOPE_KEYS);
  if (!inspected.ok) return failure("integrity_envelope_invalid");
  if (inspected.values.envelope_version !== DELIVERY_ENVELOPE_VERSION) {
    return failure("integrity_envelope_version_unsupported");
  }
  if (!validRevision(inspected.values.state_revision)) {
    return failure("integrity_revision_invalid");
  }

  const integrity = inspectExactDataObject(inspected.values.integrity, INTEGRITY_KEYS);
  if (!integrity.ok
    || integrity.values.algorithm !== ALGORITHM
    || !validKeyId(integrity.values.key_id)
    || !DIGEST_PATTERN.test(integrity.values.digest)) {
    return failure("integrity_envelope_invalid");
  }

  const entry = dependencies.verification.find(item => item.key_id === integrity.values.key_id);
  if (entry === undefined) return failure("integrity_key_not_found");

  const prepared = prepareDeliveryState(
    inspected.values.candidate,
    inspected.values.state_revision,
    inspected.values.claim,
    inspected.values.delivery,
  );
  if (!prepared.ok) return failure(prepared.reason);
  const digest = callDigest(entry, prepared.value.bytes);
  if (!digest.ok) return failure(digest.reason);
  const comparison = callSafeEqual(dependencies.safe_equal, integrity.values.digest, digest.value);
  if (!comparison.ok) return failure(comparison.reason);
  if (!comparison.value) return failure("integrity_mismatch");
  return success(Object.freeze({
    candidate: prepared.value.candidate,
    state_revision: inspected.values.state_revision,
    claim: prepared.value.claim,
    delivery: prepared.value.delivery,
  }));
}

function prepareCandidate(candidate) {
  let validation;
  try {
    validation = canonicalizePendingHandoffCandidate(candidate);
  } catch {
    return failure("integrity_candidate_invalid");
  }
  if (!validation.ok) return failure("integrity_candidate_invalid");

  try {
    const ordered = {};
    for (const field of CANDIDATE_FIELDS) ordered[field] = validation.value[field];
    const serialized = JSON.stringify(ordered);
    if (typeof serialized !== "string") return failure("integrity_candidate_invalid");
    return success({
      candidate: validation.value,
      bytes: new TextEncoder().encode(serialized),
    });
  } catch {
    return failure("integrity_candidate_invalid");
  }
}

function prepareRevisionState(candidate, stateRevision) {
  const prepared = prepareRevisionCandidate(candidate);
  if (!prepared.ok) return prepared;

  try {
    const orderedCandidate = {};
    for (const field of CANDIDATE_FIELDS) orderedCandidate[field] = prepared.value.candidate[field];
    const serialized = JSON.stringify({
      state_revision: stateRevision,
      candidate: orderedCandidate,
    });
    if (typeof serialized !== "string") return failure("integrity_candidate_invalid");
    return success({
      candidate: prepared.value.candidate,
      bytes: new TextEncoder().encode(serialized),
    });
  } catch {
    return failure("integrity_candidate_invalid");
  }
}

function prepareRevisionCandidate(candidate) {
  const prepared = prepareStateCandidateSnapshot(
    candidate,
    ["candidate", "pending"],
    "integrity_candidate_invalid",
  );
  return prepared.ok ? success({ candidate: prepared.value }) : prepared;
}

function prepareClaimState(candidate, stateRevision, claim) {
  const preparedCandidate = prepareStateCandidateSnapshot(
    candidate,
    CLAIM_STATE_STATUSES,
    "integrity_claim_invalid",
  );
  if (!preparedCandidate.ok) return preparedCandidate;

  const normalizedClaim = normalizeClaimMetadata(
    preparedCandidate.value,
    claim,
  );
  if (!normalizedClaim.ok) return normalizedClaim;

  try {
    const orderedCandidate = {};
    for (const field of CANDIDATE_FIELDS) {
      orderedCandidate[field] = preparedCandidate.value[field];
    }
    const serialized = JSON.stringify({
      state_revision: stateRevision,
      claim: normalizedClaim.value,
      candidate: orderedCandidate,
    });
    if (typeof serialized !== "string") return failure("integrity_claim_invalid");
    return success({
      candidate: preparedCandidate.value,
      claim: normalizedClaim.value,
      bytes: new TextEncoder().encode(serialized),
    });
  } catch {
    return failure("integrity_claim_invalid");
  }
}

function prepareDeliveryState(candidate, stateRevision, claim, delivery) {
  const preparedCandidate = prepareStateCandidateSnapshot(
    candidate,
    ["claimed", "delivered", "consumed"],
    "integrity_delivery_invalid",
  );
  if (!preparedCandidate.ok) return preparedCandidate;

  const normalizedClaim = normalizeDeliveryClaimMetadata(
    preparedCandidate.value,
    claim,
  );
  if (!normalizedClaim.ok) return normalizedClaim;

  const normalizedDelivery = normalizeDeliveryMetadata(
    preparedCandidate.value,
    normalizedClaim.value,
    delivery,
  );
  if (!normalizedDelivery.ok) return normalizedDelivery;

  try {
    const orderedCandidate = {};
    for (const field of CANDIDATE_FIELDS) {
      orderedCandidate[field] = preparedCandidate.value[field];
    }
    const serialized = JSON.stringify({
      state_revision: stateRevision,
      claim: normalizedClaim.value,
      delivery: normalizedDelivery.value,
      candidate: orderedCandidate,
    });
    if (typeof serialized !== "string") return failure("integrity_delivery_invalid");
    return success({
      candidate: preparedCandidate.value,
      claim: normalizedClaim.value,
      delivery: normalizedDelivery.value,
      bytes: new TextEncoder().encode(serialized),
    });
  } catch {
    return failure("integrity_delivery_invalid");
  }
}

function normalizeDeliveryClaimMetadata(candidate, claim) {
  const inspected = inspectExactDataObject(claim, CLAIM_KEYS);
  if (!inspected.ok) return failure("integrity_delivery_invalid");

  let owner;
  try {
    owner = validateOpaqueIdentity(inspected.values.claim_owner_identity);
  } catch {
    return failure("integrity_delivery_invalid");
  }
  if (!owner.ok || owner.kind !== "session") return failure("integrity_delivery_invalid");
  if (typeof inspected.values.claim_attempt_id !== "string"
    || !CLAIM_ATTEMPT_ID_PATTERN.test(inspected.values.claim_attempt_id)) {
    return failure("integrity_delivery_invalid");
  }
  if (!isUtcIsoTimestamp(inspected.values.claim_started_at)
    || !isUtcIsoTimestamp(inspected.values.claim_lease_expires_at)) {
    return failure("integrity_delivery_invalid");
  }
  const startedAt = Date.parse(inspected.values.claim_started_at);
  const leaseExpiresAt = Date.parse(inspected.values.claim_lease_expires_at);
  const candidateExpiresAt = Date.parse(candidate.expires_at);
  if (!(startedAt < leaseExpiresAt) || leaseExpiresAt > candidateExpiresAt) {
    return failure("integrity_delivery_invalid");
  }

  return success(Object.freeze({
    claim_owner_identity: inspected.values.claim_owner_identity,
    claim_started_at: inspected.values.claim_started_at,
    claim_lease_expires_at: inspected.values.claim_lease_expires_at,
    claim_attempt_id: inspected.values.claim_attempt_id,
  }));
}

function normalizeDeliveryMetadata(candidate, claim, delivery) {
  if (!isPlainObject(delivery)) return failure("integrity_delivery_invalid");
  const expectedKeys = candidate.status === "claimed"
    ? DELIVERY_ATTEMPT_KEYS
    : candidate.status === "delivered"
      ? DELIVERY_CONFIRMED_KEYS
      : DELIVERY_CONSUMED_KEYS;
  const inspected = inspectExactDataObject(delivery, expectedKeys);
  if (!inspected.ok) return failure("integrity_delivery_invalid");

  if (typeof inspected.values.delivery_attempt_id !== "string"
    || !DELIVERY_ATTEMPT_ID_PATTERN.test(inspected.values.delivery_attempt_id)
    || !isUtcIsoTimestamp(inspected.values.delivery_attempted_at)
    || !DIGEST_PATTERN.test(inspected.values.delivery_candidate_digest)) {
    return failure("integrity_delivery_invalid");
  }
  const attemptedAt = Date.parse(inspected.values.delivery_attempted_at);
  const leaseExpiresAt = Date.parse(claim.claim_lease_expires_at);
  const candidateExpiresAt = Date.parse(candidate.expires_at);
  const claimStartedAt = Date.parse(claim.claim_started_at);
  if (attemptedAt < claimStartedAt || attemptedAt >= leaseExpiresAt || attemptedAt >= candidateExpiresAt) {
    return failure("integrity_delivery_invalid");
  }

  const normalized = {
    delivery_attempt_id: inspected.values.delivery_attempt_id,
    delivery_attempted_at: inspected.values.delivery_attempted_at,
    delivery_candidate_digest: inspected.values.delivery_candidate_digest,
  };

  if (candidate.status !== "claimed") {
    const evidence = normalizeDeliveryEvidence(
      candidate,
      claim,
      inspected.values.delivery_attempt_id,
      inspected.values.delivery_candidate_digest,
      inspected.values.evidence,
    );
    if (!evidence.ok) return evidence;
    if (!isUtcIsoTimestamp(inspected.values.delivered_at)) {
      return failure("integrity_delivery_invalid");
    }
    const deliveredAt = Date.parse(inspected.values.delivered_at);
    if (inspected.values.delivered_at !== evidence.value.confirmed_at
      || deliveredAt < attemptedAt
      || deliveredAt >= leaseExpiresAt
      || deliveredAt >= candidateExpiresAt) {
      return failure("integrity_delivery_invalid");
    }
    normalized.evidence = evidence.value;
    normalized.delivered_at = inspected.values.delivered_at;
    if (candidate.status === "consumed") {
      if (!isUtcIsoTimestamp(inspected.values.consumed_at)) {
        return failure("integrity_delivery_invalid");
      }
      const consumedAt = Date.parse(inspected.values.consumed_at);
      if (consumedAt < deliveredAt) return failure("integrity_delivery_invalid");
      normalized.consumed_at = inspected.values.consumed_at;
    }
  }

  return success(Object.freeze(normalized));
}

function normalizeDeliveryEvidence(
  candidate,
  claim,
  deliveryAttemptId,
  deliveryCandidateDigest,
  evidence,
) {
  const inspected = inspectExactDataObject(evidence, DELIVERY_EVIDENCE_KEYS);
  if (!inspected.ok) return failure("integrity_delivery_invalid");
  const values = inspected.values;
  if (typeof values.verification !== "string"
    || typeof values.evidence_id !== "string"
    || typeof values.candidate_id !== "string"
    || typeof values.candidate_digest !== "string"
    || typeof values.current_session_identity !== "string"
    || typeof values.claim_attempt_id !== "string"
    || typeof values.delivery_attempt_id !== "string"
    || typeof values.runtime !== "string"
    || typeof values.adapter_version !== "string"
    || typeof values.injection_surface_accepted !== "boolean"
    || typeof values.candidate_available !== "boolean"
    || typeof values.confirmed_at !== "string") {
    return failure("integrity_delivery_invalid");
  }
  if (!isSafeEvidenceId(values.evidence_id)
    || !isSafeRuntimeId(values.runtime)
    || !isSafeAdapterVersion(values.adapter_version)) {
    return failure("integrity_delivery_invalid");
  }
  let owner;
  try {
    owner = validateOpaqueIdentity(values.current_session_identity);
  } catch {
    return failure("integrity_delivery_invalid");
  }
  if (values.verification !== "passed"
    || values.candidate_id !== candidate.candidate_id
    || values.candidate_digest !== deliveryCandidateDigest
    || !owner.ok
    || owner.kind !== "session"
    || values.current_session_identity !== claim.claim_owner_identity
    || values.claim_attempt_id !== claim.claim_attempt_id
    || values.delivery_attempt_id !== deliveryAttemptId
    || values.injection_surface_accepted !== true
    || values.candidate_available !== true) {
    return failure("integrity_delivery_invalid");
  }
  if (!isUtcIsoTimestamp(values.confirmed_at)) {
    return failure("integrity_delivery_invalid");
  }
  return success(Object.freeze({
    verification: "passed",
    evidence_id: values.evidence_id,
    candidate_id: values.candidate_id,
    candidate_digest: values.candidate_digest,
    current_session_identity: values.current_session_identity,
    claim_attempt_id: values.claim_attempt_id,
    delivery_attempt_id: values.delivery_attempt_id,
    runtime: values.runtime,
    adapter_version: values.adapter_version,
    injection_surface_accepted: true,
    candidate_available: true,
    confirmed_at: values.confirmed_at,
  }));
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

function prepareStateCandidateSnapshot(candidate, allowedStatuses, failureReason) {
  const snapshot = inspectStateCandidate(candidate);
  if (snapshot === null) return failure(failureReason);

  let validation;
  try {
    validation = validateCandidate(snapshot);
  } catch {
    return failure(failureReason);
  }
  if (!validation.ok || !allowedStatuses.includes(snapshot.status)) {
    return failure(failureReason);
  }

  for (const [field, expectedKind] of [
    ["source_session_identity", "session"],
    ["repository_identity", "repository"],
    ["worktree_identity", "worktree"],
  ]) {
    let identity;
    try {
      identity = validateOpaqueIdentity(snapshot[field]);
    } catch {
      return failure(failureReason);
    }
    if (!identity.ok || identity.kind !== expectedKind) return failure(failureReason);
  }

  try {
    for (const field of CANDIDATE_FIELDS) {
      if (Array.isArray(snapshot[field])) Object.freeze(snapshot[field]);
    }
    Object.freeze(snapshot);
    return success(snapshot);
  } catch {
    return failure(failureReason);
  }
}

function inspectStateCandidate(input) {
  try {
    const inspected = inspectExactDataObject(input, CANDIDATE_FIELDS);
    if (!inspected.ok) return null;
    const snapshot = {};
    for (const field of CANDIDATE_FIELDS) {
      const value = inspected.values[field];
      if (typeof value === "function") return null;
      if (Array.isArray(value)) {
        const copied = copyStateArray(value);
        if (copied === null) return null;
        snapshot[field] = copied;
      } else {
        if (value !== null && typeof value === "object") return null;
        snapshot[field] = value;
      }
    }
    return snapshot;
  } catch {
    return null;
  }
}

function copyStateArray(input) {
  try {
    if (Object.getPrototypeOf(input) !== Array.prototype) return null;
    const keys = Reflect.ownKeys(input);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.enumerable
      || lengthDescriptor.configurable
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || keys.length !== lengthDescriptor.value + 1
      || keys[keys.length - 1] !== "length") return null;

    const copy = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const key = String(index);
      if (keys[index] !== key) return null;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!isEnumerableDataDescriptor(descriptor)) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch {
    return null;
  }
}

function normalizeClaimMetadata(candidate, claim) {
  if (candidate.status !== "claimed") {
    return claim === null ? success(null) : failure("integrity_claim_invalid");
  }
  const inspected = inspectExactDataObject(claim, CLAIM_KEYS);
  if (!inspected.ok) return failure("integrity_claim_invalid");

  const owner = validateOpaqueIdentity(inspected.values.claim_owner_identity);
  if (!owner.ok || owner.kind !== "session") return failure("integrity_claim_invalid");
  if (typeof inspected.values.claim_attempt_id !== "string"
    || !CLAIM_ATTEMPT_ID_PATTERN.test(inspected.values.claim_attempt_id)) {
    return failure("integrity_claim_invalid");
  }
  if (!isUtcIsoTimestamp(inspected.values.claim_started_at)
    || !isUtcIsoTimestamp(inspected.values.claim_lease_expires_at)) {
    return failure("integrity_claim_invalid");
  }
  const startedAt = Date.parse(inspected.values.claim_started_at);
  const leaseExpiresAt = Date.parse(inspected.values.claim_lease_expires_at);
  const candidateExpiresAt = Date.parse(candidate.expires_at);
  if (!(startedAt < leaseExpiresAt) || leaseExpiresAt > candidateExpiresAt) {
    return failure("integrity_claim_invalid");
  }

  return success(Object.freeze({
    claim_owner_identity: inspected.values.claim_owner_identity,
    claim_started_at: inspected.values.claim_started_at,
    claim_lease_expires_at: inspected.values.claim_lease_expires_at,
    claim_attempt_id: inspected.values.claim_attempt_id,
  }));
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isUtcIsoTimestamp(value) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const normalized = value.includes(".")
    ? value
    : value.replace(/Z$/, ".000Z");
  return new Date(timestamp).toISOString() === normalized;
}

function isPlainObject(value) {
  try {
    return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function inspectDependencies(value) {
  try {
    const inspected = inspectExactDataObject(value, DEPENDENCY_KEYS);
    if (!inspected.ok || !isFrozen(value)) return failure("integrity_dependency_invalid");
    const { current, verification, safe_equal: safeEqual } = inspected.values;
    if (!Array.isArray(verification) || !isFrozen(verification) || verification.length < 1 || verification.length > 2) {
      return failure("integrity_dependency_invalid");
    }
    if (current !== verification[0] || !validProviderFunction(safeEqual)) {
      return failure("integrity_dependency_invalid");
    }
    for (const entry of verification) {
      const inspectedEntry = inspectExactDataObject(entry, ENTRY_KEYS);
      if (!inspectedEntry.ok || !isFrozen(entry) || !validKeyId(inspectedEntry.values.key_id)) {
        return failure("integrity_dependency_invalid");
      }
      if (!validProviderFunction(inspectedEntry.values.keyed_digest)) {
        return failure("integrity_dependency_invalid");
      }
    }
    return success(value);
  } catch {
    return failure("integrity_dependency_invalid");
  }
}

function validVerificationKeys(value, currentKeyId) {
  try {
    return Array.isArray(value)
      && isFrozen(value)
      && value.length >= 1
      && value.length <= 2
      && value[0] === currentKeyId
      && value.every(validKeyId)
      && new Set(value).size === value.length;
  } catch {
    return false;
  }
}

function validKeyId(value) {
  return typeof value === "string" && KEY_ID_PATTERN.test(value);
}

function validProviderFunction(value) {
  try {
    return typeof value === "function"
      && isFrozen(value)
      && !Object.prototype.hasOwnProperty.call(value, "toJSON");
  } catch {
    return false;
  }
}

function createKeyedDigestWrapper(rawKeyedDigest, boundKeyId) {
  return Object.freeze(input => {
    const inspected = inspectExactDataObject(input, ["key_id", "purpose", "bytes"]);
    if (!inspected.ok || !(inspected.values.bytes instanceof Uint8Array)) {
      throw integrityError("integrity_digest_invalid");
    }
    if (inspected.values.key_id !== boundKeyId) {
      throw integrityError("integrity_key_not_found");
    }
    if (inspected.values.purpose !== PURPOSE) {
      throw integrityError("integrity_dependency_invalid");
    }
    let result;
    try {
      result = rawKeyedDigest({
        key_id: boundKeyId,
        purpose: PURPOSE,
        bytes: new Uint8Array(inspected.values.bytes),
      });
    } catch {
      throw integrityError("integrity_digest_failed");
    }
    if (typeof result !== "string" || !DIGEST_PATTERN.test(result)) {
      throw integrityError("integrity_digest_invalid");
    }
    return result;
  });
}

function createSafeEqualWrapper(rawSafeEqual) {
  return Object.freeze((left, right) => {
    if (typeof left !== "string" || typeof right !== "string") {
      throw integrityError("integrity_compare_invalid");
    }
    if (left.length !== right.length) return false;
    let result;
    try {
      result = rawSafeEqual(left, right);
    } catch {
      throw integrityError("integrity_compare_failed");
    }
    if (typeof result !== "boolean" || result !== (left === right)) {
      throw integrityError("integrity_compare_invalid");
    }
    return result;
  });
}

function callDigest(entry, bytes) {
  try {
    const result = entry.keyed_digest({
      key_id: entry.key_id,
      purpose: PURPOSE,
      bytes: new Uint8Array(bytes),
    });
    return typeof result === "string" && DIGEST_PATTERN.test(result)
      ? success(result)
      : failure("integrity_digest_invalid");
  } catch (error) {
    return failure(publicReason(error, "integrity_digest_failed"));
  }
}

function callSafeEqual(safeEqual, left, right) {
  try {
    const result = safeEqual(left, right);
    return typeof result === "boolean"
      ? success(result)
      : failure("integrity_compare_invalid");
  } catch (error) {
    return failure(publicReason(error, "integrity_compare_failed"));
  }
}

function publicReason(error, fallback) {
  try {
    return PENDING_HANDOFF_INTEGRITY_FAILURES.includes(error?.code) ? error.code : fallback;
  } catch {
    return fallback;
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

function inspectExactDataObject(value, expectedKeys) {
  try {
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
      return { ok: false };
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length
      || ownKeys.some(key => typeof key !== "string" || !expectedKeys.includes(key))) {
      return { ok: false };
    }
    const values = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, "value")
        || Object.hasOwn(descriptor, "get")
        || Object.hasOwn(descriptor, "set")) {
        return { ok: false };
      }
      values[key] = descriptor.value;
    }
    return { ok: true, values };
  } catch {
    return { ok: false };
  }
}

function isFrozen(value) {
  try {
    return Object.isFrozen(value);
  } catch {
    return false;
  }
}

function integrityError(code) {
  return Object.freeze({ name: "IntegrityProviderError", code });
}

function success(value) {
  return Object.freeze({ ok: true, value });
}

function failure(reason) {
  return Object.freeze({ ok: false, reason });
}
