import { types as utilTypes } from "node:util";
import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";

const STORE_KEYS = Object.freeze(["readAttempt", "compareAndSetAttempt"]);
const IDENTITY_KEYS = Object.freeze([
  "candidate_id",
  "action_kind",
  "attempt_id",
  "runtime_id",
  "actor_identity",
  "scope_ref",
  "repository_identity",
  "worktree_identity",
  "candidate_revision",
]);
const RECORD_KEYS = Object.freeze([
  ...IDENTITY_KEYS,
  "revision",
  "claim_revision",
  "status",
  "adapter_version",
]);
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * RPL-120 domain service for a purpose-aware Manual Resume attempt aggregate.
 *
 * The supplied Store must durably and atomically CAS one active record per
 * (candidate_id, action_kind) across processes. This module does not provide
 * physical persistence. In particular, an in-memory Map is suitable only for
 * fixtures and must not be used as a product Store.
 */
export function createPendingHandoffManualResumeAttemptOutcomeService(options) {
  const store = inspectStore(options);
  if (store === null) return failure("manual_resume_attempt_store_invalid");

  return success(Object.freeze({
    reserveAttempt: request => reserveAttempt(store, request),
    bindClaim: request => bindClaim(store, request),
    markDispatchStarted: request => markDispatchStarted(store, request),
    recordValidatedAdapterAcceptance: request => recordValidatedAdapterAcceptance(store, request),
    readAttempt: request => readAttempt(store, request),
  }));
}

async function reserveAttempt(store, request) {
  const inspected = inspectIdentityRequest(request);
  if (!inspected.ok) return failure("manual_resume_attempt_input_invalid");
  const identity = inspected.value;
  const existing = await readAggregate(store, identity);
  if (!existing.ok) return existing;

  if (existing.value !== null) {
    return failure(existing.value.attempt_id === identity.attempt_id
      ? "manual_resume_attempt_replay_blocked"
      : "manual_resume_attempt_recovery_required");
  }

  const record = freezeRecord({
    ...identity,
    revision: 1,
    claim_revision: null,
    status: "reserved",
    adapter_version: null,
  });
  return compareAndSet(store, identity, null, record);
}

async function bindClaim(store, request) {
  const inspected = inspectTransitionRequest(request, ["claim_revision"]);
  if (!inspected.ok || !isRevision(inspected.value.claim_revision)) {
    return failure("manual_resume_attempt_input_invalid");
  }
  return transition(store, inspected.value, "reserved", "claim_bound", {
    claim_revision: inspected.value.claim_revision,
  });
}

async function markDispatchStarted(store, request) {
  const inspected = inspectTransitionRequest(request, ["claim_revision"]);
  if (!inspected.ok || !isRevision(inspected.value.claim_revision)) {
    return failure("manual_resume_attempt_input_invalid");
  }
  return transition(store, inspected.value, "claim_bound", "dispatch_unknown", {
    claim_revision: inspected.value.claim_revision,
  });
}

async function recordValidatedAdapterAcceptance(store, request) {
  const inspected = inspectTransitionRequest(request, ["adapter_version"]);
  if (!inspected.ok
    || typeof inspected.value.adapter_version !== "string"
    || inspected.value.adapter_version.trim().length === 0
    || inspected.value.adapter_version.length > 128) {
    return failure("manual_resume_attempt_input_invalid");
  }
  return transition(store, inspected.value, "dispatch_unknown", "accepted", {
    adapter_version: inspected.value.adapter_version,
  });
}

async function transition(store, request, expectedState, nextState, updates) {
  const identity = request.identity;
  const currentResult = await readAggregate(store, identity);
  if (!currentResult.ok) return currentResult;
  const current = currentResult.value;
  if (current === null || !sameIdentity(current, identity)) {
    return failure("manual_resume_attempt_not_found");
  }
  if (current.revision !== request.expected_attempt_revision
    || current.status !== expectedState) {
    return failure("manual_resume_attempt_revision_conflict");
  }
  if (Object.hasOwn(updates, "claim_revision")
    && current.claim_revision !== null
    && current.claim_revision !== updates.claim_revision) {
    return failure("manual_resume_attempt_claim_conflict");
  }

  const record = freezeRecord({
    ...current,
    ...updates,
    revision: current.revision + 1,
    status: nextState,
  });
  return compareAndSet(store, identity, current.revision, record);
}

async function readAttempt(store, request) {
  const inspected = inspectReadRequest(request);
  if (!inspected.ok) return failure("manual_resume_attempt_input_invalid");
  const result = await readAggregate(store, inspected.value);
  if (!result.ok) return result;
  return success(result.value);
}

async function readAggregate(store, identity) {
  let raw;
  try {
    raw = await store.readAttempt(Object.freeze({
      candidate_id: identity.candidate_id,
      action_kind: identity.action_kind,
    }));
  } catch {
    return failure("manual_resume_attempt_store_unavailable");
  }
  const result = inspectResult(raw);
  if (!result.ok || result.kind !== "success") {
    return failure("manual_resume_attempt_store_unavailable");
  }
  if (result.value === null) return success(null);
  const record = inspectRecord(result.value);
  return record.ok ? success(record.value) : failure("manual_resume_attempt_record_invalid");
}

async function compareAndSet(store, identity, expectedRevision, record) {
  let raw;
  try {
    raw = await store.compareAndSetAttempt(Object.freeze({
      candidate_id: identity.candidate_id,
      action_kind: identity.action_kind,
      expected_revision: expectedRevision,
      next_record: record,
    }));
  } catch {
    return failure("manual_resume_attempt_store_unavailable");
  }
  const result = inspectResult(raw);
  if (!result.ok) return failure("manual_resume_attempt_store_unavailable");
  if (result.kind === "failure") {
    return failure(result.reason === "revision_conflict"
      ? "manual_resume_attempt_revision_conflict"
      : "manual_resume_attempt_store_unavailable");
  }
  const stored = inspectRecord(result.value);
  if (!stored.ok || !sameRecord(stored.value, record)) {
    return failure("manual_resume_attempt_store_unavailable");
  }
  return success(stored.value);
}

function inspectStore(options) {
  const outer = inspectExactObject(options, ["store"]);
  if (!outer.ok) return null;
  const store = outer.values.store;
  if (utilTypes.isProxy(store) || !isPlainObject(store)) return null;
  const ownKeys = Reflect.ownKeys(store);
  if (ownKeys.length !== STORE_KEYS.length || ownKeys.some(key => !STORE_KEYS.includes(key))) return null;
  for (const key of STORE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(store, key);
    if (!isEnumerableDataDescriptor(descriptor) || typeof descriptor.value !== "function") return null;
  }
  return Object.freeze({
    readAttempt: store.readAttempt,
    compareAndSetAttempt: store.compareAndSetAttempt,
  });
}

function inspectIdentityRequest(value) {
  const outer = inspectExactObject(value, ["identity"]);
  if (!outer.ok) return failure("invalid");
  const identity = inspectIdentity(outer.values.identity);
  return identity.ok ? success(identity.value) : failure("invalid");
}

function inspectReadRequest(value) {
  const outer = inspectExactObject(value, ["candidate_id", "action_kind"]);
  if (!outer.ok
    || !isNonEmptyToken(outer.values.candidate_id)
    || outer.values.action_kind !== "manual_resume") return failure("invalid");
  return success(Object.freeze({
    candidate_id: outer.values.candidate_id,
    action_kind: outer.values.action_kind,
  }));
}

function inspectTransitionRequest(value, extraKeys) {
  const outer = inspectExactObject(value, ["identity", "expected_attempt_revision", ...extraKeys]);
  if (!outer.ok || !isRevision(outer.values.expected_attempt_revision)) return failure("invalid");
  const identity = inspectIdentity(outer.values.identity);
  if (!identity.ok) return failure("invalid");
  return success(Object.freeze({
    identity: identity.value,
    expected_attempt_revision: outer.values.expected_attempt_revision,
    ...Object.fromEntries(extraKeys.map(key => [key, outer.values[key]])),
  }));
}

function inspectIdentity(value) {
  const result = inspectExactObject(value, IDENTITY_KEYS);
  if (!result.ok) return failure("invalid");
  const identity = result.values;
  const actor = validateOpaqueIdentity(identity.actor_identity);
  const repository = validateOpaqueIdentity(identity.repository_identity);
  const worktree = validateOpaqueIdentity(identity.worktree_identity);
  if (!isNonEmptyToken(identity.candidate_id)
    || identity.action_kind !== "manual_resume"
    || typeof identity.attempt_id !== "string"
    || !ATTEMPT_ID_PATTERN.test(identity.attempt_id)
    || typeof identity.runtime_id !== "string"
    || !RUNTIME_ID_PATTERN.test(identity.runtime_id)
    || !actor.ok || actor.kind !== "session"
    || !repository.ok || repository.kind !== "repository"
    || !worktree.ok || worktree.kind !== "worktree"
    || actor.version !== repository.version
    || actor.version !== worktree.version
    || actor.key_id !== repository.key_id
    || actor.key_id !== worktree.key_id
    || !isNonEmptyToken(identity.scope_ref)
    || !isRevision(identity.candidate_revision)) return failure("invalid");
  return success(Object.freeze({ ...identity }));
}

function inspectRecord(value) {
  const result = inspectExactObject(value, RECORD_KEYS);
  if (!result.ok) return failure("invalid");
  const identity = inspectIdentity(Object.fromEntries(
    IDENTITY_KEYS.map(key => [key, result.values[key]]),
  ));
  const record = result.values;
  if (!identity.ok
    || !isRevision(record.revision)
    || !(record.claim_revision === null || isRevision(record.claim_revision))
    || !["reserved", "claim_bound", "dispatch_unknown", "accepted"].includes(record.status)
    || !(record.adapter_version === null
      || (typeof record.adapter_version === "string" && record.adapter_version.trim().length > 0 && record.adapter_version.length <= 128))
    || ((record.status === "reserved" || record.status === "dispatch_unknown") && record.adapter_version !== null)
    || ((record.status === "claim_bound" || record.status === "dispatch_unknown" || record.status === "accepted")
      && !isRevision(record.claim_revision))
    || (record.status === "accepted" && record.adapter_version === null)
    || (record.status !== "accepted" && record.adapter_version !== null)) return failure("invalid");
  return success(freezeRecord({ ...identity.value, ...record }));
}

function inspectResult(value) {
  const successResult = inspectExactObject(value, ["ok", "value"]);
  if (successResult.ok && successResult.values.ok === true) {
    return { ok: true, kind: "success", value: successResult.values.value };
  }
  const failureResult = inspectExactObject(value, ["ok", "reason"]);
  if (failureResult.ok && failureResult.values.ok === false && typeof failureResult.values.reason === "string") {
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

function sameIdentity(record, identity) {
  return IDENTITY_KEYS.every(key => record[key] === identity[key]);
}

function sameRecord(left, right) {
  return RECORD_KEYS.every(key => left[key] === right[key]);
}

function freezeRecord(value) {
  return Object.freeze({
    candidate_id: value.candidate_id,
    action_kind: value.action_kind,
    attempt_id: value.attempt_id,
    runtime_id: value.runtime_id,
    actor_identity: value.actor_identity,
    scope_ref: value.scope_ref,
    repository_identity: value.repository_identity,
    worktree_identity: value.worktree_identity,
    candidate_revision: value.candidate_revision,
    revision: value.revision,
    claim_revision: value.claim_revision,
    status: value.status,
    adapter_version: value.adapter_version,
  });
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
