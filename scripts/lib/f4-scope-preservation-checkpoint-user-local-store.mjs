import { createHash } from "node:crypto";
import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  f4PhysicalStateBindingFromLocation,
  sameF4PhysicalStateBinding,
  snapshotF4StateRootOptions,
} from "./f4-physical-state-binding.mjs";
import { isF4ScopePreservationCheckpoint } from "./f4-scope-preservation-checkpoint.mjs";

const USER_LOCAL_STATE_KEYS = Object.freeze([
  "resolveUserLocalStateLocation",
  "readUserLocalState",
  "publishUserLocalStateAtomically",
  "withPhysicalStateLock",
]);
const CHECKPOINT_KEYS = Object.freeze(["objectiveId", "expectedRevision", "checkpoint"]);
const ENVELOPE_KEYS = Object.freeze(["schema_version", "objective_id", "checkpoint"]);
const CHECKPOINT_RELATIVE_ROOT = "f4/scope-preservation-checkpoints";

/**
 * Persist only F4 scope-preservation checkpoints using RPL-95's user-local
 * State Root, worktree-scoped locations, synchronous physical lock, and
 * atomic publication. This is a domain-specific checkpoint adapter, not a
 * general provider. No async work runs inside the physical lock.
 */
export function createF4ScopePreservationCheckpointUserLocalStore(options) {
  const input = inspectExactDataObject(options, [
    "cwd",
    "userLocalState",
    "verifyStateRootBinding",
    "expectedPhysicalStateBinding",
  ], ["stateRootOptions"]);
  if (!input.ok
    || typeof input.values.cwd !== "string"
    || !path.isAbsolute(input.values.cwd)
    || typeof input.values.verifyStateRootBinding !== "function"
    || utilTypes.isProxy(input.values.verifyStateRootBinding)
    || !isPhysicalStateBinding(input.values.expectedPhysicalStateBinding)
    || (Object.hasOwn(input.values, "stateRootOptions")
      && input.values.stateRootOptions !== undefined
      && !isPlainObject(input.values.stateRootOptions))) {
    return failure("scope_checkpoint_store_invalid");
  }
  const userLocalState = inspectUserLocalState(input.values.userLocalState);
  if (userLocalState === null) return failure("scope_checkpoint_store_invalid");

  const cwd = input.values.cwd;
  const stateRootOptions = snapshotF4StateRootOptions(input.values.stateRootOptions);
  if (stateRootOptions === null) return failure("scope_checkpoint_store_invalid");
  const expectedPhysicalStateBinding = input.values.expectedPhysicalStateBinding;
  const verifyStateRootBinding = input.values.verifyStateRootBinding;
  return success(Object.freeze({
    readCheckpoint: request => readCheckpoint(
      userLocalState,
      cwd,
      stateRootOptions,
      expectedPhysicalStateBinding,
      verifyStateRootBinding,
      request,
    ),
    compareAndSetCheckpoint: request => compareAndSetCheckpoint(
      userLocalState,
      cwd,
      stateRootOptions,
      expectedPhysicalStateBinding,
      verifyStateRootBinding,
      request,
    ),
  }));
}

async function readCheckpoint(
  userLocalState,
  cwd,
  stateRootOptions,
  expectedPhysicalStateBinding,
  verifyStateRootBinding,
  request,
) {
  const inspected = inspectExactDataObject(request, ["objectiveId"]);
  if (!inspected.ok || !isObjectiveId(inspected.values.objectiveId)) {
    return failure("scope_checkpoint_input_invalid");
  }
  return withLockedLocation(
    userLocalState,
    cwd,
    stateRootOptions,
    expectedPhysicalStateBinding,
    verifyStateRootBinding,
    inspected.values.objectiveId,
    location => {
    const stored = readStoredCheckpoint(userLocalState, location, inspected.values.objectiveId);
    return stored.ok ? success(stored.value) : stored;
    },
  );
}

async function compareAndSetCheckpoint(
  userLocalState,
  cwd,
  stateRootOptions,
  expectedPhysicalStateBinding,
  verifyStateRootBinding,
  request,
) {
  const inspected = inspectExactDataObject(request, CHECKPOINT_KEYS);
  if (!inspected.ok
    || !isObjectiveId(inspected.values.objectiveId)
    || !(inspected.values.expectedRevision === null || isNonnegativeInteger(inspected.values.expectedRevision))
    || !isF4ScopePreservationCheckpoint(inspected.values.checkpoint)
    || inspected.values.checkpoint.objectiveId !== inspected.values.objectiveId) {
    return failure("scope_checkpoint_input_invalid");
  }
  const { objectiveId, expectedRevision, checkpoint } = inspected.values;
  const nextRevision = expectedRevision === null ? 1 : expectedRevision + 1;
  if (!Number.isSafeInteger(nextRevision) || checkpoint.checkpointRevision !== nextRevision) {
    return failure("scope_checkpoint_revision_invalid");
  }

  return withLockedLocation(
    userLocalState,
    cwd,
    stateRootOptions,
    expectedPhysicalStateBinding,
    verifyStateRootBinding,
    objectiveId,
    location => {
    const stored = readStoredCheckpoint(userLocalState, location, objectiveId);
    if (!stored.ok) return stored;
    const current = stored.value;
    if ((expectedRevision === null && current !== null)
      || (expectedRevision !== null && current?.checkpointRevision !== expectedRevision)) {
      return failure("scope_checkpoint_revision_conflict");
    }

    let serialized;
    try {
      serialized = JSON.stringify({ schema_version: 1, objective_id: objectiveId, checkpoint });
    } catch {
      return failure("scope_checkpoint_record_invalid");
    }
    const publication = userLocalState.publishUserLocalStateAtomically(location, serialized);
    if (!isPlainObject(publication) || publication.published !== true) {
      return failure("scope_checkpoint_publish_failed");
    }
    return success(checkpoint);
    },
  );
}

async function withLockedLocation(
  userLocalState,
  cwd,
  stateRootOptions,
  expectedPhysicalStateBinding,
  verifyStateRootBinding,
  objectiveId,
  callback,
) {
  try {
    const relativePath = `${CHECKPOINT_RELATIVE_ROOT}/checkpoint-${hashObjectiveId(objectiveId)}.json`;
    const location = stateRootOptions === undefined
      ? userLocalState.resolveUserLocalStateLocation(cwd, relativePath)
      : userLocalState.resolveUserLocalStateLocation(cwd, relativePath, stateRootOptions);
    const observedBinding = f4PhysicalStateBindingFromLocation(location);
    if (!observedBinding.ok
      || !sameF4PhysicalStateBinding(observedBinding.value, expectedPhysicalStateBinding)) {
      return failure("scope_checkpoint_state_root_binding_unverified");
    }
    // This port verifies only the checkpoint location against Host-owned
    // identity. objective_id selects the checkpoint record; it is not trust
    // evidence for the repository, worktree, or State Root.
    let verified;
    try {
      const bindingRequest = Object.freeze({
        binding_kind: "scope_checkpoint",
        objective_id: objectiveId,
        repository_cwd: cwd,
        physical_state: observedBinding.value,
      });
      verified = await verifyStateRootBinding(bindingRequest);
    } catch {
      return failure("scope_checkpoint_state_root_binding_unverified");
    }
    if (verified !== true) return failure("scope_checkpoint_state_root_binding_unverified");

    let lockedBinding;
    const result = userLocalState.withPhysicalStateLock(location, () => {
      lockedBinding = f4PhysicalStateBindingFromLocation(location);
      if (!lockedBinding.ok
        || !sameF4PhysicalStateBinding(lockedBinding.value, observedBinding.value)
        || !sameF4PhysicalStateBinding(lockedBinding.value, expectedPhysicalStateBinding)) {
        return failure("scope_checkpoint_state_root_binding_unverified");
      }
      return callback(location);
    });
    if (isThenable(result)) return failure("scope_checkpoint_lock_contract_invalid");
    return isStoreResult(result) ? result : failure("scope_checkpoint_store_unavailable");
  } catch (error) {
    return failure(normalizeStorageFailure(error));
  }
}

function isPhysicalStateBinding(value) {
  const inspected = inspectExactDataObject(value, [
    "contract",
    "state_root_identity",
    "repository_instance_id",
    "physical_worktree_id",
  ]);
  return inspected.ok
    && inspected.values.contract === "rpl95-worktree-state-v2"
    && typeof inspected.values.state_root_identity === "string"
    && /^[a-f0-9]{64}$/.test(inspected.values.state_root_identity)
    && typeof inspected.values.repository_instance_id === "string"
    && /^[a-f0-9]{64}$/.test(inspected.values.repository_instance_id)
    && typeof inspected.values.physical_worktree_id === "string"
    && /^[a-f0-9]{64}$/.test(inspected.values.physical_worktree_id);
}

function readStoredCheckpoint(userLocalState, location, objectiveId) {
  let contents;
  try {
    contents = userLocalState.readUserLocalState(location);
  } catch {
    return failure("scope_checkpoint_read_failed");
  }
  if (contents === null) return success(null);
  if (typeof contents !== "string") return failure("scope_checkpoint_record_invalid");

  let envelope;
  try { envelope = JSON.parse(contents); } catch { return failure("scope_checkpoint_record_invalid"); }
  const inspected = inspectExactDataObject(envelope, ENVELOPE_KEYS);
  if (!inspected.ok
    || inspected.values.schema_version !== 1
    || inspected.values.objective_id !== objectiveId
    || !isF4ScopePreservationCheckpoint(inspected.values.checkpoint)
    || inspected.values.checkpoint.objectiveId !== objectiveId) {
    return failure("scope_checkpoint_record_invalid");
  }
  return success(inspected.values.checkpoint);
}

function inspectUserLocalState(value) {
  const inspected = inspectExactDataObject(value, USER_LOCAL_STATE_KEYS);
  if (!inspected.ok || USER_LOCAL_STATE_KEYS.some(key => (
    typeof inspected.values[key] !== "function" || utilTypes.isProxy(inspected.values[key])
  ))) return null;
  return Object.freeze(inspected.values);
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

function hashObjectiveId(objectiveId) {
  return createHash("sha256").update(objectiveId, "utf8").digest("hex");
}

function normalizeStorageFailure(error) {
  let code;
  try {
    code = error !== null && typeof error === "object" ? error.code : undefined;
  } catch {
    code = undefined;
  }
  if (code === "state_publish_durability_unknown") return "scope_checkpoint_publication_unknown";
  if (code === "state_publish_failed") return "scope_checkpoint_publish_failed";
  return "scope_checkpoint_store_unavailable";
}

function isObjectiveId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(value);
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isStoreResult(value) {
  const inspected = inspectExactDataObject(value, ["ok"], ["value", "reason"]);
  return inspected.ok && typeof inspected.values.ok === "boolean";
}

function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && Object.hasOwn(descriptor, "value")
    && descriptor.enumerable === true;
}

function success(value) { return { ok: true, value }; }
function failure(reason) { return { ok: false, reason }; }
