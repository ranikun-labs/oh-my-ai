import path from "node:path";
import { types as utilTypes } from "node:util";
import { preflightCapabilityMvp } from "./rpl-118-capability-preflight-mvp.mjs";
import { createF4ScopePreservingCheckpoint } from "./f4-scope-preservation-checkpoint.mjs";
import {
  createF4ScopePreservationCheckpointUserLocalStore,
} from "./f4-scope-preservation-checkpoint-user-local-store.mjs";
import {
  createPendingHandoffManualResumeAttemptOutcomeStoreAdapter,
} from "./pending-handoff-manual-resume-attempt-outcome-store-adapter.mjs";
import {
  createPendingHandoffManualResumeAttemptOutcomeUserLocalRecordProvider,
} from "./pending-handoff-manual-resume-attempt-outcome-user-local-provider.mjs";
import {
  createPendingHandoffManualResumeRuntimeComposition,
} from "./pending-handoff-manual-resume-runtime-composition.mjs";

const REQUIRED_KEYS = Object.freeze([
  "store",
  "claimLease",
  "runtimeEntries",
  "capabilityContext",
  "userLocalState",
  "repositoryCwd",
  "resolveCapabilityMvpContext",
  "resolveApprovedWorkstreamForManualResume",
]);
const OPTIONAL_KEYS = Object.freeze([
  "manualResumeServiceFactory",
  "stateRootOptions",
  "verifyWorktreeStateBinding",
]);
const CAPABILITY_CONTEXT_KEYS = Object.freeze(["resolveManualResumeContext"]);
const MVP_CONTEXT_KEYS = Object.freeze(["task", "environment", "trustedVerifiers"]);
const MANUAL_RESUME_TASK_KIND = "CODE_EXECUTION";

/**
 * Compose the RPL-95 physical Store adapter, RPL-118 fresh capability
 * preflight, and the existing RPL-120 Manual Resume composition. This is a
 * minimum product entry boundary; it does not create an Actor, dispatch an
 * executor itself, or claim that `READY` means Runtime acceptance.
 * Before Claim, a trusted Host verifier must bind `repositoryCwd` and the
 * opaque F4 repository/worktree identities to RPL-95's physical repository,
 * worktree, and state-root identities. It must reject root changes and
 * cross-worktree Resume unless its trusted source confirms the same binding.
 * The expected state-root identity must come from an independently retained
 * Host record; deriving both expected and observed values from this call is
 * insufficient. A trusted Owner/Inventory resolver must also return the
 * approved Objective/Scope Revision, selected workstream, and fresh complete
 * READY observation; this composition checks that evidence against the durable
 * checkpoint before the existing Attempt/Claim path. Missing or inconclusive
 * Host evidence fails closed.
 */
export function createPendingHandoffF4NativeRuntimeComposition(options) {
  const input = inspectExactDataObject(options, REQUIRED_KEYS, OPTIONAL_KEYS);
  if (!input.ok
    || typeof input.values.repositoryCwd !== "string"
    || !isAbsolutePath(input.values.repositoryCwd)
    || typeof input.values.resolveCapabilityMvpContext !== "function"
    || utilTypes.isProxy(input.values.resolveCapabilityMvpContext)
    || typeof input.values.resolveApprovedWorkstreamForManualResume !== "function"
    || utilTypes.isProxy(input.values.resolveApprovedWorkstreamForManualResume)
    || (Object.hasOwn(input.values, "verifyWorktreeStateBinding")
      && (typeof input.values.verifyWorktreeStateBinding !== "function"
        || utilTypes.isProxy(input.values.verifyWorktreeStateBinding)))) {
    return failure("manual_resume_runtime_dependency_invalid");
  }

  const baseCapabilityContext = inspectCapabilityContext(input.values.capabilityContext);
  if (baseCapabilityContext === null) return failure("manual_resume_runtime_dependency_invalid");

  const providerOptions = {
    cwd: input.values.repositoryCwd,
    userLocalState: input.values.userLocalState,
  };
  if (Object.hasOwn(input.values, "stateRootOptions")) {
    providerOptions.stateRootOptions = input.values.stateRootOptions;
  }
  const recordProviderResult = createPendingHandoffManualResumeAttemptOutcomeUserLocalRecordProvider(providerOptions);
  if (!recordProviderResult.ok) return failure("manual_resume_runtime_dependency_invalid");
  const recordProvider = recordProviderResult.value;

  const attemptStoreResult = createPendingHandoffManualResumeAttemptOutcomeStoreAdapter({
    recordStore: {
      readRecord: recordProvider.readRecord,
      compareAndSetRecord: recordProvider.compareAndSetRecord,
    },
  });
  if (!attemptStoreResult.ok) return failure("manual_resume_runtime_dependency_invalid");

  const initialPhysicalBinding = recordProvider.readPhysicalStateBinding();
  if (!initialPhysicalBinding.ok) return failure("manual_resume_worktree_binding_unverified");
  const checkpointStore = createF4ScopePreservationCheckpointUserLocalStore({
    cwd: input.values.repositoryCwd,
    userLocalState: input.values.userLocalState,
    stateRootOptions: recordProvider.stateRootOptions,
    expectedPhysicalStateBinding: initialPhysicalBinding.value,
    verifyStateRootBinding: binding => {
      if (typeof input.values.verifyWorktreeStateBinding !== "function") return false;
      return input.values.verifyWorktreeStateBinding(Object.freeze({
        binding_kind: binding.binding_kind,
        repository_cwd: binding.repository_cwd,
        objective_id: binding.objective_id,
        physical_state: binding.physical_state,
      }));
    },
  });
  if (!checkpointStore.ok) return failure("scope_checkpoint_store_unavailable");

  const capabilityContext = createCapabilityContextBridge(
    baseCapabilityContext,
    input.values.resolveCapabilityMvpContext,
    input.values.verifyWorktreeStateBinding ?? null,
    input.values.resolveApprovedWorkstreamForManualResume,
    input.values.repositoryCwd,
    recordProvider.readPhysicalStateBinding,
    checkpointStore.value,
  );
  const compositionOptions = {
    store: input.values.store,
    claimLease: input.values.claimLease,
    attemptOutcomeStore: attemptStoreResult.value,
    runtimeEntries: input.values.runtimeEntries,
    capabilityContext,
  };
  if (Object.hasOwn(input.values, "manualResumeServiceFactory")) {
    compositionOptions.manualResumeServiceFactory = input.values.manualResumeServiceFactory;
  }
  const manualResume = createPendingHandoffManualResumeRuntimeComposition(compositionOptions);
  if (!manualResume.ok) return manualResume;

  return success(Object.freeze({
    executeManualResume: manualResume.value.executeManualResume,
    readScopeCheckpoint: request => readScopeCheckpoint(checkpointStore.value, request),
    reconcileScopeCheckpoint: request => reconcileScopeCheckpoint(checkpointStore.value, request),
  }));
}

async function readScopeCheckpoint(checkpointStore, request) {
  const input = inspectExactDataObject(request, ["objectiveId"]);
  if (!input.ok || !isSafeObjectiveId(input.values.objectiveId)) {
    return failure("scope_checkpoint_input_invalid");
  }
  return checkpointStore.readCheckpoint({ objectiveId: input.values.objectiveId });
}

async function reconcileScopeCheckpoint(checkpointStore, request) {
  const input = inspectExactDataObject(request, [
    "approvedScope",
    "expectedCheckpointRevision",
    "refresh",
    "recentExecution",
    "nextReadyId",
    "stopReason",
  ]);
  if (!input.ok) return failure("scope_checkpoint_input_invalid");
  const objectiveId = ownData(input.values.approvedScope, "objectiveId");
  if (!isSafeObjectiveId(objectiveId)) return failure("scope_checkpoint_input_invalid");

  const current = await checkpointStore.readCheckpoint({ objectiveId });
  if (!current.ok) return failure(current.reason);
  const projection = createF4ScopePreservingCheckpoint({
    ...input.values,
    currentCheckpoint: current.value,
  });
  if (!projection.ok) return projection;

  const persisted = await checkpointStore.compareAndSetCheckpoint({
    objectiveId,
    expectedRevision: current.value?.checkpointRevision ?? null,
    checkpoint: projection.checkpoint,
  });
  if (!persisted.ok) {
    return {
      ok: false,
      accepted: false,
      reason: persisted.reason,
      // A failed CAS may mean another writer published first; durability
      // uncertainty may mean this write is already visible. Return no
      // authoritative snapshot and require a fresh read before continuing.
      checkpoint: null,
    };
  }
  return projection;
}

function createCapabilityContextBridge(
  baseCapabilityContext,
  resolveCapabilityMvpContext,
  verifyWorktreeStateBinding,
  resolveApprovedWorkstreamForManualResume,
  repositoryCwd,
  readPhysicalStateBinding,
  checkpointStore,
) {
  return Object.freeze({
    resolveManualResumeContext: async request => {
      if (verifyWorktreeStateBinding === null) {
        return failure("manual_resume_worktree_binding_unverified");
      }
      const persistedCandidate = ownData(request, "persisted_candidate");
      const candidateId = ownData(persistedCandidate, "candidate_id");
      const repositoryIdentity = ownData(persistedCandidate, "repository_identity");
      const worktreeIdentity = ownData(persistedCandidate, "worktree_identity");
      const physicalBinding = readPhysicalStateBinding();
      if (typeof candidateId !== "string" || candidateId.length === 0
        || ownData(request, "candidate_id") !== candidateId
        || typeof repositoryIdentity !== "string" || repositoryIdentity.length === 0
        || typeof worktreeIdentity !== "string" || worktreeIdentity.length === 0
        || !physicalBinding.ok) {
        return failure("manual_resume_worktree_binding_unverified");
      }
      let bindingVerified;
      try {
        bindingVerified = await verifyWorktreeStateBinding(Object.freeze({
          repository_cwd: repositoryCwd,
          candidate_id: candidateId,
          repository_identity: repositoryIdentity,
          worktree_identity: worktreeIdentity,
          physical_state: physicalBinding.value,
        }));
      } catch {
        return failure("manual_resume_worktree_binding_unverified");
      }
      if (bindingVerified !== true) return failure("manual_resume_worktree_binding_unverified");

      let baseContext;
      try {
        baseContext = await baseCapabilityContext.resolveManualResumeContext(request);
      } catch {
        return failure("manual_resume_capability_preflight_blocked");
      }
      if (isCoreFailure(baseContext)) return baseContext;

      let rawMvpContext;
      try {
        rawMvpContext = await resolveCapabilityMvpContext(request);
      } catch {
        return failure("manual_resume_capability_preflight_blocked");
      }
      const context = inspectExactDataObject(rawMvpContext, MVP_CONTEXT_KEYS);
      if (!context.ok || !isPlainObject(context.values.trustedVerifiers)) {
        return failure("manual_resume_capability_preflight_blocked");
      }

      let decision;
      try {
        decision = preflightCapabilityMvp(
          context.values.task,
          context.values.environment,
          context.values.trustedVerifiers,
        );
      } catch {
        return failure("manual_resume_capability_preflight_blocked");
      }
      if (!isReadyForManualResume(decision, context.values, baseContext, request)) {
        return failure("manual_resume_capability_preflight_blocked");
      }

      const scopeVerified = await verifyApprovedReadyWorkstream(
        resolveApprovedWorkstreamForManualResume,
        checkpointStore,
        request,
        baseContext,
        context.values,
        decision,
      );
      if (!scopeVerified) return failure("manual_resume_scope_coverage_unverified");

      // READY only passes this preflight gate. The existing RPL-120
      // composition still validates the Actor binding, Attempt, Claim,
      // Runtime action, and its separate accepted/unknown result.
      return baseContext;
    },
  });
}

async function verifyApprovedReadyWorkstream(
  resolver,
  checkpointStore,
  request,
  baseContext,
  capabilityContext,
  decision,
) {
  let resolved;
  try {
    resolved = await resolver(Object.freeze({
      request,
      f4Context: baseContext,
      task: capabilityContext.task,
      environment: capabilityContext.environment,
      capabilityDecision: decision,
    }));
  } catch {
    return false;
  }
  const approved = inspectExactDataObject(resolved, [
    "objectiveId",
    "scopeRevision",
    "workstreamId",
    "observedStatus",
    "inventoryCoverage",
    "inventorySourceUri",
    "inventorySourceRevision",
  ]);
  if (!approved.ok || !isSafeObjectiveId(approved.values.objectiveId)
    || !isNonEmptyString(approved.values.scopeRevision)
    || !isNonEmptyString(approved.values.workstreamId)
    || ownData(resolved, "observedStatus") !== "READY"
    || ownData(resolved, "inventoryCoverage") !== "COMPLETE"
    || !isNonEmptyString(ownData(resolved, "inventorySourceUri"))
    || !isNonEmptyString(ownData(resolved, "inventorySourceRevision"))) return false;

  let stored;
  try {
    stored = await checkpointStore.readCheckpoint({ objectiveId: approved.values.objectiveId });
  } catch {
    return false;
  }
  const result = inspectExactDataObject(stored, ["ok"], ["value", "reason"]);
  if (!result.ok || result.values.ok !== true || !isPlainObject(result.values.value)) return false;
  const checkpoint = result.values.value;
  const inventory = ownData(checkpoint, "inventory");
  const requiredSources = ownData(checkpoint, "requiredSources");
  const scopeSource = ownData(checkpoint, "scopeSource");
  const sourceCoverage = ownData(checkpoint, "sourceCoverage");
  if (ownData(checkpoint, "objectiveId") !== approved.values.objectiveId
    || ownData(checkpoint, "scopeRevision") !== approved.values.scopeRevision
    || ownData(checkpoint, "scopeCoverage") !== "COMPLETE"
    || ownData(checkpoint, "nextReadyId") !== approved.values.workstreamId
    || !Array.isArray(inventory)
    || !Array.isArray(requiredSources)
    || !Array.isArray(sourceCoverage)
    || (ownData(scopeSource, "uri") !== ownData(resolved, "inventorySourceUri")
      && !requiredSources.some(source => ownData(source, "uri") === ownData(resolved, "inventorySourceUri")))) {
    return false;
  }

  const item = inventory.find(entry => ownData(entry, "id") === approved.values.workstreamId);
  const source = sourceCoverage.find(entry => ownData(entry, "uri") === ownData(resolved, "inventorySourceUri"));
  const statusSummary = ownData(checkpoint, "statusSummary");
  const readyCount = ownData(statusSummary, "READY");
  return ownData(item, "scopeMember") === true
    && ownData(item, "status") === "READY"
    && ownData(item, "sourceUri") === ownData(resolved, "inventorySourceUri")
    && ownData(item, "sourceRevision") === ownData(resolved, "inventorySourceRevision")
    && ownData(source, "coverage") === "COMPLETE"
    && ownData(source, "revision") === ownData(resolved, "inventorySourceRevision")
    && Number.isSafeInteger(readyCount)
    && readyCount > 0;
}

function isReadyForManualResume(decision, mvpContext, baseContext, request) {
  const status = ownData(decision, "status");
  const task = mvpContext.task;
  const environment = mvpContext.environment;
  const runtimeEvidence = ownData(task, "runtime_evidence");
  const provenance = ownData(decision, "runtime_provenance");
  const executorSelection = ownData(decision, "executor_selection");
  const sourceObservations = ownData(decision, "source_observations");
  if (status === "HANDOFF") return false;
  if (status !== "READY"
    || ownData(decision, "task_kind") !== MANUAL_RESUME_TASK_KIND
    || ownData(decision, "observation") !== "AVAILABLE"
    || ownData(decision, "scope_completeness") !== "COMPLETE"
    || ownData(decision, "dispatch_status") !== "NOT_RUN"
    || ownData(decision, "handoff_destination") !== null
    || ownData(executorSelection, "status") !== "NOT_RUN"
    || ownData(executorSelection, "selected") !== null
    || !Array.isArray(sourceObservations)
    || sourceObservations.length === 0
    || sourceObservations.some(item => ownData(item, "status") !== "AVAILABLE")
    || ownData(provenance, "verification") !== "VERIFIED"
    || ownData(provenance, "runtime_id") !== request.runtime_id
    || ownData(provenance, "provider_id") !== ownData(environment, "provider_id")
    || ownData(provenance, "environment_fingerprint") !== ownData(environment, "fingerprint")
    || ownData(task, "scope_ref") !== request.candidate_id
    || ownData(runtimeEvidence, "runtime_id") !== request.runtime_id
    || ownData(runtimeEvidence, "provider_id") !== ownData(environment, "provider_id")
    || ownData(environment, "runtime_id") !== request.runtime_id) return false;

  const f4Task = ownData(baseContext, "task");
  const f4Environment = ownData(baseContext, "environment");
  const f4Current = ownData(baseContext, "current");
  const fingerprint = ownData(environment, "fingerprint");
  return ownData(f4Task, "scope_ref") === request.candidate_id
    && ownData(f4Environment, "provider_id") === ownData(environment, "provider_id")
    && ownData(f4Environment, "runtime_id") === request.runtime_id
    && ownData(f4Environment, "fingerprint") === fingerprint
    && ownData(f4Current, "environment_fingerprint") === fingerprint;
}

function inspectCapabilityContext(value) {
  const inspected = inspectExactDataObject(value, CAPABILITY_CONTEXT_KEYS);
  if (!inspected.ok || typeof inspected.values.resolveManualResumeContext !== "function"
    || utilTypes.isProxy(inspected.values.resolveManualResumeContext)) return null;
  return Object.freeze({ resolveManualResumeContext: inspected.values.resolveManualResumeContext });
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

function isCoreFailure(value) {
  const result = inspectExactDataObject(value, ["ok", "reason"]);
  return result.ok && result.values.ok === false && typeof result.values.reason === "string";
}

function ownData(value, key) {
  if (!isPlainObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return isEnumerableDataDescriptor(descriptor) ? descriptor.value : undefined;
}

function isAbsolutePath(value) {
  try { return path.isAbsolute(value); } catch { return false; }
}

function isSafeObjectiveId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
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
