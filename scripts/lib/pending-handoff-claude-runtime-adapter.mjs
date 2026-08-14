import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";

const CLAUDE_RUNTIME_ID = "claude";
const MAX_CLAUDE_SESSIONS = 512;
const CLAUDE_RESOLUTION_DEADLINE_MS = 30_000;
const NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const RESOLUTION_DEPENDENCY_KEYS = Object.freeze([
  "currentSessionObserver",
  "sessionIdentityDeriver",
  "listSessions",
  "getSessionInfo",
]);
const OPTIONAL_POLICY_KEYS = Object.freeze([
  "monotonicNow",
  "setTimeout",
  "clearTimeout",
]);
const CURRENT_REQUEST_KEYS = Object.freeze(["runtime_id"]);
const TARGET_REQUEST_KEYS = Object.freeze(["runtime_id", "session_identity"]);

export function createPendingHandoffClaudeSessionResolutionAdapter(options) {
  const inspected = inspectDependencies(options);
  if (!inspected.ok) return failure(inspected.reason);

  const dependencies = inspected.value;
  const facade = Object.freeze({
    resolveCurrentSession: request => resolveCurrentSession(dependencies, request),
    resolveTargetSession: request => resolveTargetSession(dependencies, request),
  });
  return success(facade);
}

async function resolveCurrentSession(dependencies, request) {
  const inspectedRequest = inspectExactDataObject(request, CURRENT_REQUEST_KEYS);
  if (!inspectedRequest.ok || inspectedRequest.values.runtime_id !== CLAUDE_RUNTIME_ID) {
    return failure("runtime_unsupported");
  }

  const deadline = createDeadline(dependencies);
  if (deadline === null) return failure("unavailable");

  let observed;
  try {
    observed = await settleWithinDeadline(
      dependencies.currentSessionObserver(),
      deadline,
      dependencies,
    );
  } catch {
    return failure("unavailable");
  }
  if (!isNativeSessionId(observed)) return failure("unavailable");

  let metadata;
  try {
    metadata = await settleWithinDeadline(
      dependencies.getSessionInfo(observed),
      deadline,
      dependencies,
    );
  } catch {
    return failure("unavailable");
  }
  if (metadata === null || metadata === undefined) return failure("not_found");

  const inspectedMetadata = inspectSessionInfo(metadata);
  if (!inspectedMetadata.ok) return failure("unavailable");
  if (inspectedMetadata.sessionId !== observed) return failure("stale");

  const identity = await deriveOpaqueIdentity(dependencies, observed, deadline);
  if (deadlineExpired(dependencies, deadline)) return failure("unavailable");
  return identity.ok ? semanticSuccess(identity.value) : failure("unavailable");
}

async function resolveTargetSession(dependencies, request) {
  const inspectedRequest = inspectExactDataObject(request, TARGET_REQUEST_KEYS);
  if (!inspectedRequest.ok
    || inspectedRequest.values.runtime_id !== CLAUDE_RUNTIME_ID
    || !isSessionIdentity(inspectedRequest.values.session_identity)) {
    return failure("runtime_unsupported");
  }

  const deadline = createDeadline(dependencies);
  if (deadline === null) return failure("unavailable");

  let rawSessions;
  try {
    rawSessions = await settleWithinDeadline(
      dependencies.listSessions({ limit: MAX_CLAUDE_SESSIONS + 1 }),
      deadline,
      dependencies,
    );
  } catch {
    return failure("unavailable");
  }

  const inspectedSessions = inspectSessionList(rawSessions);
  if (!inspectedSessions.ok || inspectedSessions.value.length > MAX_CLAUDE_SESSIONS) {
    return failure("unavailable");
  }
  if (deadlineExpired(dependencies, deadline)) return failure("unavailable");

  const seenNativeIds = new Set();
  const matches = [];
  for (const session of inspectedSessions.value) {
    const inspectedSession = inspectSessionInfo(session);
    if (!inspectedSession.ok) return failure("unavailable");
    const nativeId = inspectedSession.sessionId;
    if (seenNativeIds.has(nativeId)) continue;
    if (seenNativeIds.size >= MAX_CLAUDE_SESSIONS) return failure("unavailable");
    seenNativeIds.add(nativeId);

    const identity = await deriveOpaqueIdentity(dependencies, nativeId, deadline);
    if (!identity.ok) return failure("unavailable");
    if (identity.value === inspectedRequest.values.session_identity) matches.push(nativeId);
    if (deadlineExpired(dependencies, deadline)) return failure("unavailable");
  }

  if (matches.length === 0) return failure("not_found");
  if (matches.length > 1) return failure("ambiguous");
  return semanticSuccess(inspectedRequest.values.session_identity);
}

async function deriveOpaqueIdentity(dependencies, nativeId, deadline) {
  let raw;
  try {
    raw = await settleWithinDeadline(
      dependencies.sessionIdentityDeriver({
        runtime_id: CLAUDE_RUNTIME_ID,
        raw_session_id: nativeId,
      }),
      deadline,
      dependencies,
    );
  } catch {
    return failure("unavailable");
  }

  const inspected = inspectExactDataObject(raw, ["ok", "identity"]);
  if (!inspected.ok
    || inspected.values.ok !== true
    || !isSessionIdentity(inspected.values.identity)) {
    return failure("unavailable");
  }
  return success(inspected.values.identity);
}

function inspectDependencies(options) {
  try {
    if (utilTypes.isProxy(options) || !isPlainObject(options)) return failure("claude_resolution_dependency_invalid");
    const allowedKeys = new Set([...RESOLUTION_DEPENDENCY_KEYS, ...OPTIONAL_POLICY_KEYS]);
    const ownKeys = Reflect.ownKeys(options);
    if (ownKeys.some(key => typeof key !== "string" || !allowedKeys.has(key))) {
      return failure("claude_resolution_dependency_invalid");
    }

    const values = {};
    for (const key of RESOLUTION_DEPENDENCY_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!isEnumerableDataDescriptor(descriptor) || !isCallable(descriptor.value)) {
        return failure("claude_resolution_dependency_invalid");
      }
      values[key] = descriptor.value;
    }

    const monotonicNow = readOptionalCallable(options, "monotonicNow", () => performance.now());
    const setTimeoutValue = readOptionalCallable(options, "setTimeout", setTimeout);
    const clearTimeoutValue = readOptionalCallable(options, "clearTimeout", clearTimeout);
    if (monotonicNow === null || setTimeoutValue === null || clearTimeoutValue === null) {
      return failure("claude_resolution_dependency_invalid");
    }

    return success(Object.freeze({
      ...values,
      monotonicNow,
      setTimeout: setTimeoutValue,
      clearTimeout: clearTimeoutValue,
    }));
  } catch {
    return failure("claude_resolution_dependency_invalid");
  }
}

function readOptionalCallable(value, key, fallback) {
  if (!Object.hasOwn(value, key)) return fallback;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return isEnumerableDataDescriptor(descriptor) && isCallable(descriptor.value)
    ? descriptor.value
    : null;
}

function createDeadline(dependencies) {
  try {
    const now = dependencies.monotonicNow();
    if (!Number.isFinite(now)) return null;
    return now + CLAUDE_RESOLUTION_DEADLINE_MS;
  } catch {
    return null;
  }
}

function deadlineExpired(dependencies, deadline) {
  try {
    const now = dependencies.monotonicNow();
    return !Number.isFinite(now) || now >= deadline;
  } catch {
    return true;
  }
}

async function settleWithinDeadline(value, deadline, dependencies) {
  if (utilTypes.isProxy(value)) return Promise.reject(new Error("unavailable"));
  const remaining = remainingTime(dependencies, deadline);
  if (remaining <= 0) return Promise.reject(new Error("deadline"));
  if (!utilTypes.isPromise(value)) {
    if (hasThenProperty(value)) throw new Error("unavailable");
    return value;
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const finish = callback => payload => {
      if (finished) return;
      finished = true;
      dependencies.clearTimeout(timer);
      callback(payload);
    };
    try {
      timer = dependencies.setTimeout(() => {
        if (finished) return;
        finished = true;
        reject(new Error("deadline"));
      }, remaining);
    } catch {
      try {
        Promise.prototype.then.call(value, () => {}, () => {});
      } catch {
        // The value was already identified as an intrinsic Promise; this is
        // only a defensive sink for an injected timer seam failure.
      }
      reject(new Error("unavailable"));
      return;
    }
    Promise.prototype.then.call(value, finish(resolve), finish(reject));
  });
}

function hasThenProperty(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
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

function remainingTime(dependencies, deadline) {
  try {
    const now = dependencies.monotonicNow();
    return Number.isFinite(now) ? deadline - now : 0;
  } catch {
    return 0;
  }
}

function inspectSessionList(value) {
  try {
    if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return failure("invalid");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.enumerable
      || lengthDescriptor.configurable
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0) {
      return failure("invalid");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== lengthDescriptor.value + 1
      || ownKeys[ownKeys.length - 1] !== "length") {
      return failure("invalid");
    }
    const copied = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const key = String(index);
      if (ownKeys[index] !== key) return failure("invalid");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return failure("invalid");
      copied.push(descriptor.value);
    }
    return success(copied);
  } catch {
    return failure("invalid");
  }
}

function inspectSessionInfo(value) {
  try {
    if (utilTypes.isProxy(value) || !isPlainObject(value)) return failure("invalid");
    if (Reflect.ownKeys(value).some(key => typeof key !== "string")) return failure("invalid");
    const descriptor = Object.getOwnPropertyDescriptor(value, "sessionId");
    if (!isEnumerableDataDescriptor(descriptor) || !isNativeSessionId(descriptor.value)) {
      return failure("invalid");
    }
    return { ok: true, sessionId: descriptor.value };
  } catch {
    return failure("invalid");
  }
}

function inspectExactDataObject(value, expectedKeys) {
  try {
    if (utilTypes.isProxy(value) || !isPlainObject(value)) return failure("invalid");
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length
      || ownKeys.some(key => typeof key !== "string" || !expectedKeys.includes(key))) {
      return failure("invalid");
    }
    const values = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return failure("invalid");
      values[key] = descriptor.value;
    }
    return { ok: true, values };
  } catch {
    return failure("invalid");
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

function isNativeSessionId(value) {
  return typeof value === "string" && NATIVE_SESSION_ID_PATTERN.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && descriptor !== null
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, "value")
    && !Object.hasOwn(descriptor, "get")
    && !Object.hasOwn(descriptor, "set");
}

function isCallable(value) {
  return typeof value === "function" && !utilTypes.isProxy(value);
}

function semanticSuccess(sessionIdentity) {
  return Object.freeze({
    runtime_id: CLAUDE_RUNTIME_ID,
    session_identity: sessionIdentity,
  });
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
