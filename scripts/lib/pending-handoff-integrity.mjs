import { canonicalizePendingHandoffCandidate } from "./pending-handoff-candidate.mjs";

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
const PURPOSE = "pending-handoff-integrity";
const ALGORITHM = "hmac-sha256-base64url-v1";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
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
export const PENDING_HANDOFF_REVISION_INTEGRITY_FAILURES = Object.freeze([
  ...PENDING_HANDOFF_INTEGRITY_FAILURES,
  "integrity_revision_invalid",
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
  const prepared = prepareCandidate(candidate);
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

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
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
