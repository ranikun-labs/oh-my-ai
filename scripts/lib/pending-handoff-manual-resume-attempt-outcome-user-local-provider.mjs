import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  f4PhysicalStateBindingFromLocation,
  sameF4PhysicalStateBinding,
  snapshotF4StateRootOptions,
} from "./f4-physical-state-binding.mjs";
import {
  RPL120_MANUAL_RESUME_ATTEMPT_STORE_NAMESPACE,
} from "./pending-handoff-manual-resume-attempt-outcome-store-adapter.mjs";

const USER_LOCAL_STATE_KEYS = Object.freeze([
  "resolveUserLocalStateLocation",
  "readUserLocalState",
  "publishUserLocalStateAtomically",
  "withPhysicalStateLock",
]);
const READ_REQUEST_KEYS = Object.freeze(["namespace", "record_key"]);
const CAS_REQUEST_KEYS = Object.freeze([
  "namespace",
  "record_key",
  "expected_revision",
  "next_record",
]);
const ENVELOPE_KEYS = Object.freeze(["schema_version", "namespace", "record_key", "value"]);
const RECORD_KEY_PATTERN = /^attempt-[a-f0-9]{64}$/;
const ATTEMPT_RELATIVE_ROOT = "f4/manual-resume-attempts";

/**
 * Adapt RPL-120 Attempt/Outcome records to RPL-95's physical user-local state
 * primitives. The RPL-95 functions are injected so this module can be stacked
 * above the still-independent RPL-95 PR without copying or modifying its source.
 *
 * Each attempt record is scoped by RPL-95's repository/worktree location. A
 * synchronous physical lock covers read, revision check, and atomic publish;
 * no asynchronous work is run while the lock is held. Root options are
 * snapshotted at construction, and each record read/CAS must still resolve to
 * the same physical root/repository/worktree identity.
 */
export function createPendingHandoffManualResumeAttemptOutcomeUserLocalRecordProvider(options) {
  const input = inspectExactDataObject(options, ["cwd", "userLocalState"], ["stateRootOptions"]);
  if (!input.ok
    || typeof input.values.cwd !== "string"
    || !path.isAbsolute(input.values.cwd)
    || (Object.hasOwn(input.values, "stateRootOptions")
      && input.values.stateRootOptions !== undefined
      && !isPlainObject(input.values.stateRootOptions))) {
    return failure("manual_resume_attempt_store_invalid");
  }

  const userLocalState = inspectUserLocalState(input.values.userLocalState);
  if (userLocalState === null) return failure("manual_resume_attempt_store_invalid");

  const cwd = input.values.cwd;
  const stateRootOptions = snapshotF4StateRootOptions(input.values.stateRootOptions);
  if (stateRootOptions === null) return failure("manual_resume_attempt_store_invalid");
  const initialBinding = readPhysicalStateBinding(userLocalState, cwd, stateRootOptions);
  if (!initialBinding.ok) return failure("manual_resume_worktree_binding_unverified");
  const expectedBinding = initialBinding.value;
  return success(Object.freeze({
    stateRootOptions,
    readRecord: request => readRecord(userLocalState, cwd, stateRootOptions, expectedBinding, request),
    compareAndSetRecord: request => compareAndSetRecord(
      userLocalState,
      cwd,
      stateRootOptions,
      expectedBinding,
      request,
    ),
    readPhysicalStateBinding: () => readBoundPhysicalStateBinding(
      userLocalState,
      cwd,
      stateRootOptions,
      expectedBinding,
    ),
  }));
}

function readPhysicalStateBinding(userLocalState, cwd, stateRootOptions) {
  let location;
  try {
    const relativePath = `${ATTEMPT_RELATIVE_ROOT}/attempt-${"0".repeat(64)}.json`;
    location = userLocalState.resolveUserLocalStateLocation(cwd, relativePath, stateRootOptions);
  } catch (error) {
    return failure(stateFailureReason(error));
  }

  try {
    withSynchronousPhysicalLock(userLocalState, location, () => true);
  } catch (error) {
    return failure(stateFailureReason(error));
  }
  const binding = f4PhysicalStateBindingFromLocation(location);
  return binding.ok ? binding : failure("manual_resume_worktree_binding_unverified");
}

function readBoundPhysicalStateBinding(userLocalState, cwd, stateRootOptions, expectedBinding) {
  const current = readPhysicalStateBinding(userLocalState, cwd, stateRootOptions);
  if (!current.ok || !sameF4PhysicalStateBinding(current.value, expectedBinding)) {
    return failure("manual_resume_worktree_binding_unverified");
  }
  return current;
}

function readRecord(userLocalState, cwd, stateRootOptions, expectedBinding, request) {
  const inspected = inspectExactDataObject(request, READ_REQUEST_KEYS);
  if (!isRecordKeyRequest(inspected)) return failure("record_invalid");

  try {
    const location = resolveLocation(userLocalState, cwd, stateRootOptions, inspected.values.record_key);
    if (!matchesPhysicalStateBinding(location, expectedBinding)) {
      return failure("manual_resume_worktree_binding_unverified");
    }
    return withSynchronousPhysicalLock(userLocalState, location, () => {
      if (!matchesPhysicalStateBinding(location, expectedBinding)) {
        return failure("manual_resume_worktree_binding_unverified");
      }
      const contents = userLocalState.readUserLocalState(location);
      if (contents === null) return success(null);
      if (typeof contents !== "string") return success(Object.freeze({}));

      let envelope;
      try { envelope = JSON.parse(contents); } catch { return success(Object.freeze({})); }
      if (!isValidEnvelope(envelope, inspected.values.namespace, inspected.values.record_key)) {
        // Let the RPL-120 Store adapter classify this as a corrupt record. It
        // must never look like a missing record and permit a new dispatch.
        return success(Object.freeze({}));
      }
      return success(envelope.value);
    });
  } catch (error) {
    return failure(stateFailureReason(error));
  }
}

function compareAndSetRecord(userLocalState, cwd, stateRootOptions, expectedBinding, request) {
  const inspected = inspectExactDataObject(request, CAS_REQUEST_KEYS);
  if (!isRecordKeyRequest(inspected)
    || !(inspected.values.expected_revision === null || isRevision(inspected.values.expected_revision))) {
    return failure("record_invalid");
  }
  const nextRecord = snapshotRecord(inspected.values.next_record);
  const nextRevision = inspected.values.expected_revision === null
    ? 1
    : inspected.values.expected_revision + 1;
  if (nextRecord === null
    || !Number.isSafeInteger(nextRevision)
    || nextRecord.revision !== nextRevision) {
    return failure("record_invalid");
  }

  try {
    const location = resolveLocation(userLocalState, cwd, stateRootOptions, inspected.values.record_key);
    if (!matchesPhysicalStateBinding(location, expectedBinding)) {
      return failure("manual_resume_worktree_binding_unverified");
    }
    return withSynchronousPhysicalLock(userLocalState, location, () => {
      if (!matchesPhysicalStateBinding(location, expectedBinding)) {
        return failure("manual_resume_worktree_binding_unverified");
      }
      const contents = userLocalState.readUserLocalState(location);
      if (contents !== null && typeof contents !== "string") return failure("record_invalid");

      let current = null;
      if (contents !== null) {
        let envelope;
        try { envelope = JSON.parse(contents); } catch { return failure("record_invalid"); }
        if (!isValidEnvelope(envelope, inspected.values.namespace, inspected.values.record_key)) {
          return failure("record_invalid");
        }
        current = envelope.value;
      }

      if (inspected.values.expected_revision === null) {
        if (current !== null) return failure("record_exists");
      } else if (current === null || current.revision !== inspected.values.expected_revision) {
        return failure("revision_conflict");
      }

      const serialized = JSON.stringify({
        schema_version: 1,
        namespace: inspected.values.namespace,
        record_key: inspected.values.record_key,
        value: nextRecord,
      });
      const published = userLocalState.publishUserLocalStateAtomically(location, serialized);
      if (!isPlainObject(published) || published.published !== true) {
        return failure("state_publish_failed");
      }
      return success(nextRecord);
    });
  } catch (error) {
    // In particular, state_publish_durability_unknown remains a failure. The
    // Attempt service fails closed and does not infer durable success from a
    // file that may be visible after rename but not after a crash.
    return failure(stateFailureReason(error));
  }
}

function resolveLocation(userLocalState, cwd, stateRootOptions, recordKey) {
  const relativePath = `${ATTEMPT_RELATIVE_ROOT}/${recordKey}.json`;
  return userLocalState.resolveUserLocalStateLocation(cwd, relativePath, stateRootOptions);
}

function withSynchronousPhysicalLock(userLocalState, location, operation) {
  const result = userLocalState.withPhysicalStateLock(location, operation);
  if (isThenable(result)) throw new Error("physical lock operation must be synchronous");
  return result;
}

function isValidEnvelope(value, namespace, recordKey) {
  const inspected = inspectExactDataObject(value, ENVELOPE_KEYS);
  return inspected.ok
    && inspected.values.schema_version === 1
    && inspected.values.namespace === namespace
    && inspected.values.record_key === recordKey
    && isPlainObject(inspected.values.value);
}

function snapshotRecord(value) {
  if (!isPlainObject(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length === 0 || keys.some(key => typeof key !== "string")) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return null;
      const item = descriptor.value;
      if (item !== null && !["string", "number", "boolean"].includes(typeof item)) return null;
      copy[key] = item;
    }
    if (!isRevision(copy.revision) || copy.revision < 1) return null;
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function inspectUserLocalState(value) {
  if (!isPlainObject(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== USER_LOCAL_STATE_KEYS.length
      || keys.some(key => !USER_LOCAL_STATE_KEYS.includes(key))) return null;
    const copy = {};
    for (const key of USER_LOCAL_STATE_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)
        || typeof descriptor.value !== "function"
        || utilTypes.isProxy(descriptor.value)) return null;
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function isRecordKeyRequest(inspected) {
  return inspected.ok
    && inspected.values.namespace === RPL120_MANUAL_RESUME_ATTEMPT_STORE_NAMESPACE
    && typeof inspected.values.record_key === "string"
    && RECORD_KEY_PATTERN.test(inspected.values.record_key);
}

function inspectExactDataObject(value, requiredKeys, optionalKeys = []) {
  try {
    if (!isPlainObject(value)) return failure("invalid");
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string" || !allowed.has(key))) return failure("invalid");
    for (const key of requiredKeys) if (!keys.includes(key)) return failure("invalid");
    const values = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return failure("invalid");
      values[key] = descriptor.value;
    }
    return { ok: true, values };
  } catch {
    return failure("invalid");
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value, key) {
  if (!isPlainObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return isEnumerableDataDescriptor(descriptor) ? descriptor.value : undefined;
}

function matchesPhysicalStateBinding(location, expectedBinding) {
  const actual = f4PhysicalStateBindingFromLocation(location);
  return actual.ok && sameF4PhysicalStateBinding(actual.value, expectedBinding);
}

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && Object.hasOwn(descriptor, "value")
    && descriptor.enumerable === true;
}

function isThenable(value) {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}

function isRevision(value) { return Number.isSafeInteger(value) && value >= 0; }

function stateFailureReason(error) {
  if (error?.code === "state_publish_durability_unknown") return "publication_durability_unknown";
  if (error?.code === "state_path_unsafe") return "state_path_unsafe";
  if (error?.code === "state_lock_callback_invalid") return "physical_lock_callback_invalid";
  return "user_local_state_unavailable";
}

function success(value) { return { ok: true, value }; }
function failure(reason) { return { ok: false, reason }; }
