import { types as utilTypes } from "node:util";
import { createPendingHandoffManualResumeService } from "./pending-handoff-manual-resume.mjs";
import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";

const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_KEYS = Object.freeze([
  "candidate_id",
  "expected_revision",
  "current_runtime_id",
  "claim_attempt_id",
]);
const STORE_KEYS = Object.freeze(["readState"]);
const CLAIM_LEASE_KEYS = Object.freeze(["acquireClaim"]);
const RUNTIME_ENTRY_KEYS = Object.freeze(["runtime_id", "sessionResolution", "manualResumeAction"]);
const SESSION_RESOLUTION_KEYS = Object.freeze(["resolveCurrentSession", "resolveTargetSession"]);
const ACTION_KEYS = Object.freeze(["supported", "executor"]);
const EXECUTOR_KEYS = Object.freeze(["resolveAndResume"]);
const STATE_KEYS = Object.freeze(["candidate", "state_revision", "claim"]);
const RECEIPT_KEYS = Object.freeze([
  "action_kind",
  "candidate_id",
  "state_revision",
  "current_session_identity",
  "claim_attempt_id",
  "target",
  "adapter_version",
  "outcome",
]);
const TARGET_KEYS = Object.freeze(["runtime_id", "session_identity"]);
const SUPPORTED_EXECUTOR_FAILURES = new Map([
  ["codex_action_runtime_unsupported", "manual_resume_runtime_unsupported"],
  ["codex_action_not_found", "manual_resume_target_not_found"],
  ["codex_action_ambiguous", "manual_resume_target_ambiguous"],
  ["codex_action_stale", "manual_resume_target_stale"],
  ["codex_action_denied", "manual_resume_denied"],
]);

export function createPendingHandoffManualResumeRuntimeComposition(options) {
  const inspected = inspectDependencies(options);
  if (!inspected.ok) return failure(inspected.reason);

  const dependencies = inspected.value;
  const facade = Object.freeze({
    executeManualResume: request => executeManualResume(dependencies, request),
  });
  return success(facade);
}

async function executeManualResume(dependencies, request) {
  const inspectedRequest = inspectRequest(request);
  if (!inspectedRequest.ok) return failure("manual_resume_input_invalid");
  const input = inspectedRequest.value;

  const stateResult = await readState(dependencies.store, input.candidateId);
  if (!stateResult.ok) return failure(stateResult.reason);
  const runtimeResult = inspectPersistedRuntime(stateResult.value, input.candidateId);
  if (!runtimeResult.ok) return failure(runtimeResult.reason);

  const entry = dependencies.runtimeEntries.get(runtimeResult.value);
  if (entry === undefined || !entry.actionSupported || entry.executor === null) {
    return failure("manual_resume_runtime_unsupported");
  }

  const sessionResolution = createBoundSessionResolution(entry.runtimeId, entry.sessionResolution);
  let serviceResult;
  try {
    serviceResult = dependencies.manualResumeServiceFactory({
      store: dependencies.store,
      sessionResolution,
      claimLease: dependencies.claimLease,
    });
  } catch {
    return failure("manual_resume_action_request_unavailable");
  }
  const service = inspectServiceResult(serviceResult);
  if (!service.ok) return failure("manual_resume_action_request_unavailable");

  let prepared;
  try {
    prepared = await settleMaybe(service.value.prepareManualResume(request));
  } catch {
    return failure("manual_resume_action_request_unavailable");
  }
  const inspectedPrepared = inspectCoreResult(prepared);
  if (!inspectedPrepared.ok) return failure("manual_resume_action_request_unavailable");
  if (inspectedPrepared.kind === "failure") return failure(inspectedPrepared.reason);

  const actionRequest = inspectActionRequest(inspectedPrepared.value, runtimeResult.value);
  if (!actionRequest.ok) return failure("manual_resume_runtime_unsupported");

  let rawReceipt;
  try {
    rawReceipt = await settleMaybe(entry.executor.resolveAndResume(actionRequest.value));
  } catch {
    return failure("manual_resume_action_request_unavailable");
  }
  return normalizeExecutorResult(rawReceipt, actionRequest.value);
}

function inspectDependencies(options) {
  try {
    if (utilTypes.isProxy(options) || !isPlainObject(options)) return failure("manual_resume_runtime_dependency_invalid");
    const ownKeys = Reflect.ownKeys(options);
    const allowed = new Set(["store", "claimLease", "runtimeEntries", "manualResumeServiceFactory"]);
    if (ownKeys.some(key => typeof key !== "string" || !allowed.has(key))) {
      return failure("manual_resume_runtime_dependency_invalid");
    }
    const store = snapshotFacade(options.store, STORE_KEYS);
    const claimLease = snapshotFacade(options.claimLease, CLAIM_LEASE_KEYS);
    if (store === null || claimLease === null) return failure("manual_resume_runtime_dependency_invalid");

    const entries = inspectRuntimeEntries(options.runtimeEntries);
    if (!entries.ok) return failure("manual_resume_runtime_dependency_invalid");

    let manualResumeServiceFactory = createPendingHandoffManualResumeService;
    if (Object.hasOwn(options, "manualResumeServiceFactory")) {
      const descriptor = Object.getOwnPropertyDescriptor(options, "manualResumeServiceFactory");
      if (!isEnumerableDataDescriptor(descriptor) || !isCallable(descriptor.value)) {
        return failure("manual_resume_runtime_dependency_invalid");
      }
      manualResumeServiceFactory = descriptor.value;
    }
    return success(Object.freeze({
      store,
      claimLease,
      runtimeEntries: entries.value,
      manualResumeServiceFactory,
    }));
  } catch {
    return failure("manual_resume_runtime_dependency_invalid");
  }
}

function inspectRuntimeEntries(value) {
  try {
    if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return failure("invalid");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || lengthDescriptor.value === 0) {
      return failure("invalid");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== lengthDescriptor.value + 1 || ownKeys.at(-1) !== "length") return failure("invalid");

    const map = new Map();
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      if (ownKeys[index] !== String(index)) return failure("invalid");
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!isEnumerableDataDescriptor(descriptor)) return failure("invalid");
      const entry = inspectRuntimeEntry(descriptor.value);
      if (!entry.ok || map.has(entry.value.runtimeId)) return failure("invalid");
      map.set(entry.value.runtimeId, entry.value);
    }
    return success(map);
  } catch {
    return failure("invalid");
  }
}

function inspectRuntimeEntry(value) {
  const inspected = inspectExactDataObject(value, RUNTIME_ENTRY_KEYS);
  if (!inspected.ok || !isSafeRuntimeId(inspected.values.runtime_id)) return failure("invalid");
  const sessionResolution = snapshotFacade(inspected.values.sessionResolution, SESSION_RESOLUTION_KEYS);
  if (sessionResolution === null) return failure("invalid");

  const action = inspectAction(inspected.values.manualResumeAction);
  if (!action.ok) return action;
  return success(Object.freeze({
    runtimeId: inspected.values.runtime_id,
    sessionResolution,
    actionSupported: action.value.supported,
    executor: action.value.executor,
  }));
}

function inspectAction(value) {
  if (utilTypes.isProxy(value) || !isPlainObject(value)) return failure("invalid");
  const ownKeys = Reflect.ownKeys(value);
  const supportedDescriptor = Object.getOwnPropertyDescriptor(value, "supported");
  if (!isEnumerableDataDescriptor(supportedDescriptor) || typeof supportedDescriptor.value !== "boolean") {
    return failure("invalid");
  }
  if (!supportedDescriptor.value) {
    if (ownKeys.length !== 1 || !ownKeys.includes("supported")) return failure("invalid");
    return success({ supported: false, executor: null });
  }
  if (ownKeys.length !== ACTION_KEYS.length || ownKeys.some(key => !ACTION_KEYS.includes(key))) {
    return failure("invalid");
  }
  const executor = snapshotFacade(value.executor, EXECUTOR_KEYS);
  if (executor === null) return failure("invalid");
  return success({ supported: true, executor });
}

function createBoundSessionResolution(runtimeId, resolution) {
  return Object.freeze({
    resolveCurrentSession: request => boundResolutionCall(
      resolution.resolveCurrentSession,
      runtimeId,
      request,
    ),
    resolveTargetSession: request => boundResolutionCall(
      resolution.resolveTargetSession,
      runtimeId,
      request,
    ),
  });
}

function boundResolutionCall(method, runtimeId, request) {
  if (utilTypes.isProxy(request) || !isPlainObject(request)) return Promise.resolve({ ok: false, reason: "session_resolution_runtime_unsupported" });
  const runtimeDescriptor = Object.getOwnPropertyDescriptor(request, "runtime_id");
  if (!isEnumerableDataDescriptor(runtimeDescriptor) || runtimeDescriptor.value !== runtimeId) {
    return Promise.resolve({ ok: false, reason: "session_resolution_runtime_unsupported" });
  }
  let raw;
  try {
    raw = method(request);
  } catch {
    return Promise.resolve({ ok: false, reason: "session_resolution_unavailable" });
  }
  if (utilTypes.isProxy(raw)) {
    return Promise.resolve({ ok: false, reason: "session_resolution_unavailable" });
  }
  if (utilTypes.isPromise(raw)) {
    return Promise.prototype.then.call(raw, normalizeBoundResolutionResult, () => ({
      ok: false,
      reason: "session_resolution_unavailable",
    }));
  }
  if (hasThenProperty(raw)) return Promise.resolve({ ok: false, reason: "session_resolution_unavailable" });
  return Promise.resolve(normalizeBoundResolutionResult(raw));
}

function normalizeBoundResolutionResult(value) {
  const inspected = inspectCoreResult(value);
  if (!inspected.ok) {
    const semantic = inspectExactDataObject(value, ["runtime_id", "session_identity"]);
    if (semantic.ok
      && isSafeRuntimeId(semantic.values.runtime_id)
      && isSessionIdentity(semantic.values.session_identity)) {
      return { ok: true, value };
    }
    return value;
  }
  if (inspected.kind !== "failure") return value;
  if (inspected.reason.startsWith("session_resolution_")) return value;
  if (["runtime_unsupported", "not_found", "ambiguous", "stale", "denied", "unavailable"].includes(inspected.reason)) {
    return { ok: false, reason: `session_resolution_${inspected.reason}` };
  }
  return { ok: false, reason: "session_resolution_unavailable" };
}

async function readState(store, candidateId) {
  let raw;
  try {
    raw = await settleMaybe(store.readState(candidateId));
  } catch {
    return failure("manual_resume_action_request_unavailable");
  }
  const inspected = inspectCoreResult(raw);
  if (!inspected.ok) return failure("manual_resume_persisted_state_invalid");
  if (inspected.kind === "failure") return failure(mapStoreFailure(inspected.reason));
  return success(inspected.value);
}

function inspectPersistedRuntime(value, candidateId) {
  const inspected = inspectExactDataObject(value, STATE_KEYS, { optional: ["delivery"] });
  if (!inspected.ok || !Number.isSafeInteger(inspected.values.state_revision)) {
    return failure("manual_resume_persisted_state_invalid");
  }
  const candidate = inspected.values.candidate;
  if (utilTypes.isProxy(candidate) || !isPlainObject(candidate)) {
    return failure("manual_resume_persisted_state_invalid");
  }
  const candidateIdDescriptor = Object.getOwnPropertyDescriptor(candidate, "candidate_id");
  const runtimeDescriptor = Object.getOwnPropertyDescriptor(candidate, "source_runtime");
  if (!isEnumerableDataDescriptor(candidateIdDescriptor)
    || candidateIdDescriptor.value !== candidateId
    || !isEnumerableDataDescriptor(runtimeDescriptor)
    || !isSafeRuntimeId(runtimeDescriptor.value)) {
    return failure("manual_resume_persisted_state_invalid");
  }
  return success(runtimeDescriptor.value);
}

function inspectRequest(value) {
  const inspected = inspectExactDataObject(value, REQUEST_KEYS);
  if (!inspected.ok
    || typeof inspected.values.candidate_id !== "string"
    || inspected.values.candidate_id.trim().length === 0
    || !Number.isSafeInteger(inspected.values.expected_revision)
    || inspected.values.expected_revision < 0
    || !isSafeRuntimeId(inspected.values.current_runtime_id)
    || !UUID_V4_PATTERN.test(inspected.values.claim_attempt_id)) {
    return failure("invalid");
  }
  return success({
    candidateId: inspected.values.candidate_id,
    expectedRevision: inspected.values.expected_revision,
    currentRuntimeId: inspected.values.current_runtime_id,
    claimAttemptId: inspected.values.claim_attempt_id,
  });
}

function inspectServiceResult(value) {
  const inspected = inspectCoreResult(value);
  if (!inspected.ok || inspected.kind !== "success") return failure("invalid");
  const service = inspected.value;
  const facade = snapshotFacade(service, ["prepareManualResume"]);
  return facade === null ? failure("invalid") : success(facade);
}

function inspectActionRequest(value, expectedRuntime) {
  const inspected = inspectExactDataObject(value, [
    "action_kind",
    "candidate_id",
    "state_revision",
    "current_session_identity",
    "claim_attempt_id",
    "target",
  ]);
  if (!inspected.ok
    || inspected.values.action_kind !== "manual_resume"
    || typeof inspected.values.candidate_id !== "string"
    || inspected.values.candidate_id.trim().length === 0
    || !Number.isSafeInteger(inspected.values.state_revision)
    || inspected.values.state_revision < 0
    || !isSessionIdentity(inspected.values.current_session_identity)
    || !UUID_V4_PATTERN.test(inspected.values.claim_attempt_id)) {
    return failure("invalid");
  }
  const target = inspectExactDataObject(inspected.values.target, TARGET_KEYS);
  if (!target.ok
    || target.values.runtime_id !== expectedRuntime
    || !isSessionIdentity(target.values.session_identity)) {
    return failure("invalid");
  }
  return success(Object.freeze({
    action_kind: "manual_resume",
    candidate_id: inspected.values.candidate_id,
    state_revision: inspected.values.state_revision,
    current_session_identity: inspected.values.current_session_identity,
    claim_attempt_id: inspected.values.claim_attempt_id,
    target: Object.freeze({
      runtime_id: target.values.runtime_id,
      session_identity: target.values.session_identity,
    }),
  }));
}

function normalizeExecutorResult(value, preparedAction) {
  const inspected = inspectCoreResult(value);
  if (!inspected.ok) return failure("manual_resume_action_request_unavailable");
  if (inspected.kind === "failure") {
    return failure(SUPPORTED_EXECUTOR_FAILURES.get(inspected.reason) ?? "manual_resume_action_request_unavailable");
  }
  const receipt = inspectExactDataObject(inspected.value, RECEIPT_KEYS);
  const target = receipt.ok ? inspectExactDataObject(receipt.values.target, TARGET_KEYS) : failure("invalid");
  const expectedTarget = preparedAction.target;
  if (!receipt.ok
    || !target.ok
    || receipt.values.action_kind !== "manual_resume"
    || !isSafeRuntimeId(target.values.runtime_id)
    || target.values.runtime_id !== expectedTarget.runtime_id
    || !isSessionIdentity(target.values.session_identity)
    || receipt.values.outcome !== "resume_accepted"
    || typeof receipt.values.adapter_version !== "string"
    || receipt.values.adapter_version.length === 0
    || typeof receipt.values.candidate_id !== "string"
    || receipt.values.candidate_id.trim().length === 0
    || !Number.isSafeInteger(receipt.values.state_revision)
    || !isSessionIdentity(receipt.values.current_session_identity)
    || !UUID_V4_PATTERN.test(receipt.values.claim_attempt_id)
    || receipt.values.action_kind !== preparedAction.action_kind
    || receipt.values.candidate_id !== preparedAction.candidate_id
    || receipt.values.state_revision !== preparedAction.state_revision
    || receipt.values.current_session_identity !== preparedAction.current_session_identity
    || receipt.values.claim_attempt_id !== preparedAction.claim_attempt_id
    || target.values.runtime_id !== expectedTarget.runtime_id
    || target.values.session_identity !== expectedTarget.session_identity) {
    return failure("manual_resume_action_request_unavailable");
  }
  return success(Object.freeze({
    action_kind: "manual_resume",
    candidate_id: preparedAction.candidate_id,
    state_revision: preparedAction.state_revision,
    current_session_identity: preparedAction.current_session_identity,
    claim_attempt_id: preparedAction.claim_attempt_id,
    target: Object.freeze({
      runtime_id: expectedTarget.runtime_id,
      session_identity: expectedTarget.session_identity,
    }),
    adapter_version: receipt.values.adapter_version,
    outcome: "resume_accepted",
  }));
}

function mapStoreFailure(reason) {
  if (reason === "record_not_found") return "manual_resume_record_not_found";
  if (["record_invalid", "record_malformed", "record_integrity_invalid", "record_integrity_key_invalid", "record_integrity_mismatch", "revision_invalid", "unsafe_store_path", "unsafe_record_path"].includes(reason)) {
    return "manual_resume_persisted_state_invalid";
  }
  return "manual_resume_action_request_unavailable";
}

function inspectCoreResult(value) {
  const successResult = inspectExactDataObject(value, ["ok", "value"]);
  if (successResult.ok && successResult.values.ok === true) return { ok: true, kind: "success", value: successResult.values.value };
  const failureResult = inspectExactDataObject(value, ["ok", "reason"]);
  if (failureResult.ok && failureResult.values.ok === false && typeof failureResult.values.reason === "string") {
    return { ok: true, kind: "failure", reason: failureResult.values.reason };
  }
  return { ok: false };
}

function inspectExactDataObject(value, expectedKeys, options = {}) {
  try {
    if (utilTypes.isProxy(value) || !isPlainObject(value)) return failure("invalid");
    const optional = options.optional ?? [];
    const allowed = new Set([...expectedKeys, ...optional]);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== "string" || !allowed.has(key))
      || ownKeys.length < expectedKeys.length
      || ownKeys.length > expectedKeys.length + optional.length) return failure("invalid");
    const values = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return failure("invalid");
      values[key] = descriptor.value;
    }
    for (const key of optional) {
      if (!Object.hasOwn(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return failure("invalid");
      values[key] = descriptor.value;
    }
    return { ok: true, values };
  } catch {
    return failure("invalid");
  }
}

function snapshotFacade(value, requiredKeys) {
  try {
    if (utilTypes.isProxy(value) || !isPlainObject(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== "string")) return null;
    const values = {};
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor) || !isCallable(descriptor.value)) return null;
      values[key] = descriptor.value;
    }
    for (const key of requiredKeys) if (!Object.hasOwn(values, key)) return null;
    return Object.freeze(Object.fromEntries(requiredKeys.map(key => [key, values[key]])));
  } catch {
    return null;
  }
}

async function settleMaybe(value) {
  if (utilTypes.isProxy(value)) throw new Error("invalid");
  if (utilTypes.isPromise(value)) return await value;
  if (hasThenProperty(value)) throw new Error("invalid");
  return value;
}

function hasThenProperty(value) {
  if (value === null || typeof value !== "object") return false;
  if (utilTypes.isProxy(value)) return true;
  try {
    let current = value;
    const visited = new Set();
    while (current !== null) {
      if (visited.has(current)) return true;
      visited.add(current);
      if (Object.getOwnPropertyDescriptor(current, "then") !== undefined) return true;
      current = Object.getPrototypeOf(current);
    }
    return false;
  } catch {
    return true;
  }
}

function isSessionIdentity(value) {
  try {
    const result = validateOpaqueIdentity(value);
    return result.ok === true && result.kind === "session";
  } catch {
    return false;
  }
}

function isSafeRuntimeId(value) { return typeof value === "string" && RUNTIME_ID_PATTERN.test(value); }
function isPlainObject(value) { return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype; }
function isCallable(value) { return typeof value === "function" && !utilTypes.isProxy(value); }
function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined && descriptor !== null && descriptor.enumerable === true
    && Object.hasOwn(descriptor, "value") && !Object.hasOwn(descriptor, "get") && !Object.hasOwn(descriptor, "set");
}
function success(value) { return Object.freeze({ ok: true, value: Object.isFrozen(value) ? value : Object.freeze(value) }); }
function failure(reason) { return Object.freeze({ ok: false, reason }); }
