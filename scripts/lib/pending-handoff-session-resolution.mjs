import { types as utilTypes } from "node:util";
import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";

const DEPENDENCY_KEYS = Object.freeze([
  "resolveCurrentSession",
  "resolveTargetSession",
]);
const CURRENT_INPUT_KEYS = Object.freeze(["runtime_id"]);
const TARGET_INPUT_KEYS = Object.freeze(["runtime_id", "session_identity"]);
const ADAPTER_SUCCESS_KEYS = Object.freeze(["runtime_id", "session_identity"]);
const ADAPTER_FAILURE_KEYS = Object.freeze(["ok", "reason"]);
const ADAPTER_FAILURE_REASONS = new Set([
  "runtime_unsupported",
  "not_found",
  "ambiguous",
  "stale",
  "denied",
  "unavailable",
]);
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const PENDING_HANDOFF_SESSION_RESOLUTION_FAILURES = Object.freeze([
  "session_resolution_dependency_invalid",
  "session_resolution_input_invalid",
  "session_resolution_result_invalid",
  "session_resolution_runtime_unsupported",
  "session_resolution_runtime_mismatch",
  "session_resolution_identity_mismatch",
  "session_resolution_not_found",
  "session_resolution_ambiguous",
  "session_resolution_stale",
  "session_resolution_denied",
  "session_resolution_unavailable",
]);

export function createPendingHandoffSessionResolutionPort(options) {
  const inspected = inspectDependencies(options);
  if (!inspected.ok) return failure(inspected.reason);

  const facade = Object.freeze({
    resolveCurrentSession: request => resolveCurrentSession(
      inspected.value.resolveCurrentSession,
      request,
    ),
    resolveTargetSession: request => resolveTargetSession(
      inspected.value.resolveTargetSession,
      request,
    ),
  });
  return success(facade);
}

async function resolveCurrentSession(adapter, request) {
  const inspected = inspectCurrentInput(request);
  if (!inspected.ok) return failure(inspected.reason);

  let adapterResult;
  try {
    adapterResult = adapter(inspected.value);
    if (utilTypes.isProxy(adapterResult)) {
      return failure("session_resolution_result_invalid");
    }
    if (utilTypes.isPromise(adapterResult)) adapterResult = await adapterResult;
    if (utilTypes.isProxy(adapterResult)) {
      return failure("session_resolution_result_invalid");
    }
  } catch {
    return failure("session_resolution_unavailable");
  }
  return normalizeAdapterResult(adapterResult, inspected.value, null);
}

async function resolveTargetSession(adapter, request) {
  const inspected = inspectTargetInput(request);
  if (!inspected.ok) return failure(inspected.reason);

  let adapterResult;
  try {
    adapterResult = adapter(inspected.value);
    if (utilTypes.isProxy(adapterResult)) {
      return failure("session_resolution_result_invalid");
    }
    if (utilTypes.isPromise(adapterResult)) adapterResult = await adapterResult;
    if (utilTypes.isProxy(adapterResult)) {
      return failure("session_resolution_result_invalid");
    }
  } catch {
    return failure("session_resolution_unavailable");
  }
  return normalizeAdapterResult(adapterResult, inspected.value, inspected.value.session_identity);
}

function normalizeAdapterResult(adapterResult, request, expectedIdentity) {
  if (utilTypes.isProxy(adapterResult)) return failure("session_resolution_result_invalid");
  if (hasThenProperty(adapterResult)) return failure("session_resolution_result_invalid");

  const rejected = inspectExactDataObject(adapterResult, ADAPTER_FAILURE_KEYS);
  if (rejected.ok) {
    if (rejected.values.ok !== false
      || !ADAPTER_FAILURE_REASONS.has(rejected.values.reason)) {
      return failure("session_resolution_result_invalid");
    }
    return failure(`session_resolution_${rejected.values.reason}`);
  }

  const observed = inspectExactDataObject(adapterResult, ADAPTER_SUCCESS_KEYS);
  if (!observed.ok
    || !isSafeRuntimeId(observed.values.runtime_id)
    || !isSessionIdentity(observed.values.session_identity)) {
    return failure("session_resolution_result_invalid");
  }
  if (observed.values.runtime_id !== request.runtime_id) {
    return failure("session_resolution_runtime_mismatch");
  }
  if (expectedIdentity !== null && observed.values.session_identity !== expectedIdentity) {
    return failure("session_resolution_identity_mismatch");
  }

  return success(Object.freeze({
    runtime_id: request.runtime_id,
    session_identity: expectedIdentity ?? observed.values.session_identity,
  }));
}

function hasThenProperty(value) {
  if (value === null || typeof value !== "object") return false;
  if (utilTypes.isProxy(value)) return true;

  const visited = new Set();
  let current = value;
  try {
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

function inspectDependencies(options) {
  try {
    const inspected = inspectExactDataObject(options, DEPENDENCY_KEYS);
    if (!inspected.ok
      || typeof inspected.values.resolveCurrentSession !== "function"
      || typeof inspected.values.resolveTargetSession !== "function") {
      return failure("session_resolution_dependency_invalid");
    }
    return success(Object.freeze({
      resolveCurrentSession: inspected.values.resolveCurrentSession,
      resolveTargetSession: inspected.values.resolveTargetSession,
    }));
  } catch {
    return failure("session_resolution_dependency_invalid");
  }
}

function inspectCurrentInput(request) {
  const inspected = inspectExactDataObject(request, CURRENT_INPUT_KEYS);
  if (!inspected.ok || !isSafeRuntimeId(inspected.values.runtime_id)) {
    return failure("session_resolution_input_invalid");
  }
  return success(Object.freeze({ runtime_id: inspected.values.runtime_id }));
}

function inspectTargetInput(request) {
  const inspected = inspectExactDataObject(request, TARGET_INPUT_KEYS);
  if (!inspected.ok
    || !isSafeRuntimeId(inspected.values.runtime_id)
    || !isSessionIdentity(inspected.values.session_identity)) {
    return failure("session_resolution_input_invalid");
  }
  return success(Object.freeze({
    runtime_id: inspected.values.runtime_id,
    session_identity: inspected.values.session_identity,
  }));
}

function isSessionIdentity(value) {
  if (typeof value !== "string") return false;
  try {
    const validation = validateOpaqueIdentity(value);
    return validation.ok === true && validation.kind === "session";
  } catch {
    return false;
  }
}

function isSafeRuntimeId(value) {
  return typeof value === "string" && RUNTIME_ID_PATTERN.test(value);
}

function inspectExactDataObject(value, expectedKeys) {
  try {
    if (utilTypes.isProxy(value)) return { ok: false };
    if (value === null
      || typeof value !== "object"
      || Object.getPrototypeOf(value) !== Object.prototype) {
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
      if (!isEnumerableDataDescriptor(descriptor)) return { ok: false };
      values[key] = descriptor.value;
    }
    return { ok: true, values };
  } catch {
    return { ok: false };
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
  return Object.freeze({
    ok: true,
    value: Object.isFrozen(value) ? value : Object.freeze(value),
  });
}

function failure(reason) {
  return Object.freeze({ ok: false, reason });
}
