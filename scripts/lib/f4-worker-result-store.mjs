import { createHash } from "node:crypto";
import {
  f4PhysicalStateBindingFromLocation,
  sameF4PhysicalStateBinding,
  snapshotF4StateRootOptions,
} from "./f4-physical-state-binding.mjs";
import { createF4WorkerResultHandler, isWorkerResultCandidateId, normalizeVerifiedResult } from "./f4-worker-result.mjs";

function matchesKey(record, key) {
  return record.candidateId === key.candidateId && record.actionKind === key.actionKind
    && record.attemptId === key.attemptId;
}

/** RPL-95 adapter for immutable Worker Results, bound to an independently pinned Host root. */
export function createF4WorkerResultStore({ cwd, userLocalState, stateRootOptions, expectedBinding }) {
  const options = snapshotF4StateRootOptions(stateRootOptions);
  if (options === null || !sameF4PhysicalStateBinding(expectedBinding, expectedBinding)
    || typeof userLocalState?.confirmUserLocalStateDurability !== "function") {
    throw new Error("worker_result_binding_unverified");
  }
  const binding = Object.freeze({ ...expectedBinding });
  const ports = Object.freeze(Object.fromEntries([
    "resolveUserLocalStateLocation", "readUserLocalState", "publishUserLocalStateAtomically",
    "withPhysicalStateLock", "confirmUserLocalStateDurability",
  ].map(name => {
    const method = Object.getOwnPropertyDescriptor(userLocalState, name)?.value;
    if (typeof method !== "function") throw new Error("worker_result_store_invalid");
    return [name, method];
  })));

  function verifyLocation(location) {
    const observed = f4PhysicalStateBindingFromLocation(location);
    if (!observed.ok || !sameF4PhysicalStateBinding(observed.value, binding)) {
      throw new Error("worker_result_binding_unverified");
    }
  }

  function access(key, operation) {
    const identity = [key.candidateId, key.actionKind, key.attemptId];
    if (!isWorkerResultCandidateId(key.candidateId) || key.actionKind !== "manual_resume"
      || typeof key.attemptId !== "string" || !/^[a-zA-Z0-9_.:/-]{1,256}$/u.test(key.attemptId)) {
      throw new Error("worker_result_key_invalid");
    }
    const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const location = ports.resolveUserLocalStateLocation(
      cwd, `f4/worker-results/result-${digest}.json`, options,
    );
    verifyLocation(location);
    return ports.withPhysicalStateLock(location, () => {
      verifyLocation(location);
      const source = ports.readUserLocalState(location);
      let stored = null;
      if (source !== null) {
        const envelope = JSON.parse(source);
        stored = normalizeVerifiedResult(envelope?.value);
        if (envelope?.version !== 1 || stored === null || !matchesKey(stored, key)
          || stored.stateRootId !== binding.state_root_identity
          || stored.repositoryInstanceId !== binding.repository_instance_id
          || stored.physicalWorktreeId !== binding.physical_worktree_id) {
          throw new Error("worker_result_record_invalid");
        }
      }
      return operation(location, stored);
    });
  }

  return Object.freeze({
    read: key => access(key, (location, stored) => {
      if (stored !== null) {
        const confirmation = ports.confirmUserLocalStateDurability(location);
        if (confirmation !== true) {
          Promise.resolve(confirmation).catch(() => {});
          throw new Error("worker_result_durability_unconfirmed");
        }
        verifyLocation(location);
      }
      return stored;
    }),
    createIfAbsent(key, input) {
      const record = normalizeVerifiedResult(input);
      if (record === null || !matchesKey(record, key)
        || record.stateRootId !== binding.state_root_identity
        || record.repositoryInstanceId !== binding.repository_instance_id
        || record.physicalWorktreeId !== binding.physical_worktree_id) {
        throw new Error("worker_result_record_invalid");
      }
      return access(key, (location, stored) => {
        if (stored !== null) return;
        verifyLocation(location);
        ports.publishUserLocalStateAtomically(location, JSON.stringify({ version: 1, value: record }));
      });
    },
  });
}

/**
 * Bind the Host verifier and canonical Inventory reconciler to the existing
 * Attempt service and physical Result store. The Host owns both trust ports.
 */
export function createF4ManagedWorkerResultHandler({ verifyResult, attemptOutcome, reconcileInventory, ...storage }) {
  const resultStore = createF4WorkerResultStore(storage);
  return createF4WorkerResultHandler({
    async verifyResult(observation) {
      const result = normalizeVerifiedResult(await verifyResult(observation));
      if (result === null) return null;
      const attempt = await attemptOutcome.readAttempt({
        candidate_id: result.candidateId,
        action_kind: result.actionKind,
      });
      const current = attempt?.value;
      if (attempt?.ok !== true || !current
        || !["dispatch_unknown", "accepted"].includes(current.status)
        || current.candidate_id !== result.candidateId
        || current.action_kind !== result.actionKind
        || current.attempt_id !== result.attemptId
        || current.runtime_id !== result.runtimeId
        || current.actor_identity !== result.actorId
        || current.repository_identity !== result.repositoryId
        || current.worktree_identity !== result.worktreeId
        || current.candidate_revision !== result.candidateRevision
        || current.claim_revision !== result.claimRevision) return null;
      return result;
    },
    resultStore,
    reconcileInventory,
  });
}
