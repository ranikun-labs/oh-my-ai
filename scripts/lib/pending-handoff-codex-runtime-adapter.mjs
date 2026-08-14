import { spawn as nodeSpawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";

const CODEX_RUNTIME_ID = "codex";
const APP_SERVER_EXECUTABLE = "codex";
const APP_SERVER_ARGV = Object.freeze(["app-server", "--stdio"]);
const APP_SERVER_CLIENT_NAME = "oh-my-ai-pending-handoff";
const APP_SERVER_CLIENT_VERSION = "1.0.0";
const APP_SERVER_REQUEST_TIMEOUT_MS = 5_000;
const MAX_DISCOVERY_PAGES = 512;
const MAX_DISCOVERY_NATIVE_IDS = 50_000;
const DISCOVERY_DEADLINE_MS = 30_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_TERMINATION_FORCE_MS = 1_000;
const SOURCE_KINDS = Object.freeze([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);
const RESOLUTION_DEPENDENCY_KEYS = Object.freeze([
  "currentSessionObserver",
  "sessionIdentityDeriver",
]);
const ACTION_DEPENDENCY_KEYS = Object.freeze([
  "sessionIdentityDeriver",
  "adapter_version",
]);
const OPTIONAL_SPAWN_KEY = Object.freeze(["spawnAppServer"]);
const CURRENT_REQUEST_KEYS = Object.freeze(["runtime_id"]);
const TARGET_REQUEST_KEYS = Object.freeze(["runtime_id", "session_identity"]);
const ACTION_REQUEST_KEYS = Object.freeze([
  "action_kind",
  "candidate_id",
  "state_revision",
  "current_session_identity",
  "claim_attempt_id",
  "target",
]);
const TARGET_KEYS = Object.freeze(["runtime_id", "session_identity"]);
const INITIALIZE_KEYS = Object.freeze([
  "codexHome",
  "platformFamily",
  "platformOs",
  "userAgent",
]);
const READ_RESPONSE_KEYS = Object.freeze(["thread"]);
const LIST_RESPONSE_KEYS = Object.freeze(["data", "nextCursor"]);
const LIST_OPTIONAL_KEYS = Object.freeze(["backwardsCursor"]);
const RESUME_RESPONSE_KEYS = Object.freeze([
  "approvalPolicy",
  "approvalsReviewer",
  "cwd",
  "model",
  "modelProvider",
  "sandbox",
  "thread",
]);
const RESUME_OPTIONAL_KEYS = Object.freeze([
  "instructionSources",
  "reasoningEffort",
  "serviceTier",
]);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NATIVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9._:-]{1,4096}$/;
const INTERNAL_ERRORS = new WeakMap();

export const PENDING_HANDOFF_CODEX_ACTION_FAILURES = Object.freeze([
  "codex_action_dependency_invalid",
  "codex_action_input_invalid",
  "codex_action_runtime_unsupported",
  "codex_action_not_found",
  "codex_action_ambiguous",
  "codex_action_stale",
  "codex_action_denied",
  "codex_action_unavailable",
  "codex_action_result_invalid",
]);

export function createPendingHandoffCodexSessionResolutionAdapter(options) {
  const inspected = inspectResolutionDependencies(options);
  if (!inspected.ok) return failure(inspected.reason);

  const { currentSessionObserver, sessionIdentityDeriver, spawnAppServer } = inspected.value;
  const facade = Object.freeze({
    resolveCurrentSession: request => resolveCurrentSession(
      currentSessionObserver,
      sessionIdentityDeriver,
      spawnAppServer,
      request,
    ),
    resolveTargetSession: request => resolveTargetSession(
      sessionIdentityDeriver,
      spawnAppServer,
      request,
    ),
  });
  return success(facade);
}

export function createPendingHandoffCodexManualResumeExecutor(options) {
  const inspected = inspectActionDependencies(options);
  if (!inspected.ok) return failure(inspected.reason);

  const { sessionIdentityDeriver, spawnAppServer, adapterVersion } = inspected.value;
  const facade = Object.freeze({
    resolveAndResume: request => resolveAndResume(
      sessionIdentityDeriver,
      spawnAppServer,
      adapterVersion,
      request,
    ),
  });
  return success(facade);
}

async function resolveCurrentSession(observer, deriver, spawnAppServer, request) {
  const inspected = inspectCurrentRequest(request);
  if (!inspected.ok) return failure("unavailable");
  if (inspected.value.runtimeId !== CODEX_RUNTIME_ID) {
    return failure("runtime_unsupported");
  }

  let observedId;
  try {
    const raw = observer();
    observedId = await settleMaybe(raw);
  } catch {
    return failure("unavailable");
  }
  if (!isNativeId(observedId)) return failure("unavailable");

  return runWithAppServer(spawnAppServer, "resolution", async client => {
    const response = await requestRpc(client, "thread/read", { threadId: observedId });
    if (!response.ok) return mapResolutionTransportFailure(response.reason);

    const thread = inspectReadResponse(response.value);
    if (!thread.ok) return failure("unavailable");
    const nativeId = thread.value;
    if (nativeId !== observedId) return failure("stale");

    const identity = await deriveOpaqueIdentity(deriver, nativeId);
    if (!identity.ok) return failure("unavailable");
    return semanticSuccess(identity.value);
  });
}

async function resolveTargetSession(deriver, spawnAppServer, request) {
  const inspected = inspectTargetRequest(request);
  if (!inspected.ok) return failure("unavailable");
  if (inspected.value.runtimeId !== CODEX_RUNTIME_ID) {
    return failure("runtime_unsupported");
  }

  return runWithAppServer(spawnAppServer, "resolution", async client => {
    const discovered = await discoverTarget(
      client,
      deriver,
      inspected.value.sessionIdentity,
      "resolution",
    );
    if (!discovered.ok) return discovered;
    return semanticSuccess(inspected.value.sessionIdentity);
  });
}

async function resolveAndResume(deriver, spawnAppServer, adapterVersion, request) {
  const inspected = inspectActionRequest(request);
  if (!inspected.ok) return failure("codex_action_input_invalid");
  const input = inspected.value;

  return runWithAppServer(spawnAppServer, "action", async client => {
    const target = await discoverTarget(
      client,
      deriver,
      input.targetSessionIdentity,
      "action",
    );
    if (!target.ok) return target;

    const response = await requestRpc(client, "thread/resume", {
      threadId: target.value.nativeId,
    });
    if (!response.ok) return mapActionTransportFailure(response.reason);

    const resumed = inspectResumeResponse(response.value);
    if (!resumed.ok) return failure("codex_action_result_invalid");
    if (resumed.value.nativeId !== target.value.nativeId) {
      return failure("codex_action_stale");
    }

    const identity = await deriveOpaqueIdentity(deriver, resumed.value.nativeId);
    if (!identity.ok) return failure("codex_action_unavailable");
    if (identity.value !== input.targetSessionIdentity) {
      return failure("codex_action_stale");
    }

    return success(Object.freeze({
      action_kind: "manual_resume",
      candidate_id: input.candidateId,
      state_revision: input.stateRevision,
      current_session_identity: input.currentSessionIdentity,
      claim_attempt_id: input.claimAttemptId,
      target: Object.freeze({
        runtime_id: CODEX_RUNTIME_ID,
        session_identity: input.targetSessionIdentity,
      }),
      adapter_version: adapterVersion,
      outcome: "resume_accepted",
    }));
  });
}

async function discoverTarget(client, deriver, requestedIdentity, mode) {
  const matches = [];
  const seenNativeIds = new Set();
  let pageCount = 0;
  const discoveryDeadline = performance.now() + DISCOVERY_DEADLINE_MS;

  for (const archived of [false, true]) {
    let cursor = null;
    const seenCursors = new Set();

    while (true) {
      if (pageCount >= MAX_DISCOVERY_PAGES) return discoveryFailure(mode);
      const remaining = discoveryDeadline - performance.now();
      if (remaining <= 0) return discoveryFailure(mode);

      const params = {
        archived,
        sourceKinds: [...SOURCE_KINDS],
        useStateDbOnly: false,
      };
      if (cursor !== null) params.cursor = cursor;

      const response = await requestRpc(
        client,
        "thread/list",
        params,
        Math.min(APP_SERVER_REQUEST_TIMEOUT_MS, remaining),
      );
      if (!response.ok) {
        return mode === "action"
          ? mapActionTransportFailure(response.reason)
          : mapResolutionTransportFailure(response.reason);
      }

      const page = inspectListResponse(response.value);
      if (!page.ok) {
        return failure(mode === "action" ? "codex_action_result_invalid" : "unavailable");
      }
      pageCount += 1;

      for (const thread of page.value.data) {
        const nativeId = extractNativeThreadId(thread);
        if (!nativeId) {
          return failure(mode === "action" ? "codex_action_result_invalid" : "unavailable");
        }
        if (seenNativeIds.has(nativeId)) continue;
        if (seenNativeIds.size >= MAX_DISCOVERY_NATIVE_IDS) return discoveryFailure(mode);
        seenNativeIds.add(nativeId);

        if (performance.now() >= discoveryDeadline) return discoveryFailure(mode);
        const identity = await deriveOpaqueIdentity(deriver, nativeId, discoveryDeadline);
        if (!identity.ok) {
          return failure(mode === "action" ? "codex_action_unavailable" : "unavailable");
        }
        if (identity.value === requestedIdentity) matches.push(nativeId);
      }

      if (performance.now() >= discoveryDeadline) return discoveryFailure(mode);

      if (page.value.nextCursor === null) break;
      if (seenCursors.has(page.value.nextCursor)) {
        return failure(mode === "action" ? "codex_action_result_invalid" : "unavailable");
      }
      seenCursors.add(page.value.nextCursor);
      cursor = page.value.nextCursor;
    }
  }

  if (matches.length === 0) {
    return failure(mode === "action" ? "codex_action_not_found" : "not_found");
  }
  if (matches.length > 1) {
    return failure(mode === "action" ? "codex_action_ambiguous" : "ambiguous");
  }
  return success({ nativeId: matches[0] });
}

function discoveryFailure(mode) {
  return failure(mode === "action" ? "codex_action_unavailable" : "unavailable");
}

async function deriveOpaqueIdentity(deriver, nativeId, absoluteDeadline = null) {
  let raw;
  try {
    raw = deriver({ runtime_id: CODEX_RUNTIME_ID, raw_session_id: nativeId });
    raw = await settleMaybe(raw, absoluteDeadline);
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

async function runWithAppServer(spawnAppServer, mode, operation) {
  let result = failure(mode === "action" ? "codex_action_unavailable" : "unavailable");
  let client = null;
  let spawned = null;

  try {
    spawned = await settleMaybe(spawnAppServer({
      executable: APP_SERVER_EXECUTABLE,
      argv: [...APP_SERVER_ARGV],
    }));
    client = createJsonRpcClient(spawned);

    const initialized = await requestRpc(client, "initialize", {
      clientInfo: {
        name: APP_SERVER_CLIENT_NAME,
        version: APP_SERVER_CLIENT_VERSION,
      },
    });
    if (!initialized.ok) {
      result = mode === "action"
        ? mapActionTransportFailure(initialized.reason)
        : mapResolutionTransportFailure(initialized.reason);
    } else if (!validateInitializeResponse(initialized.value)) {
      result = failure(mode === "action" ? "codex_action_result_invalid" : "unavailable");
    } else {
      try {
        client.notify("initialized");
        result = await operation(client);
      } catch (error) {
        const reason = internalFailureReason(error);
        result = mode === "action"
          ? mapActionTransportFailure(reason)
          : mapResolutionTransportFailure(reason);
      }
    }
  } catch (error) {
    const reason = internalFailureReason(error);
    result = mode === "action"
      ? mapActionTransportFailure(reason)
      : mapResolutionTransportFailure(reason);
  }

  let cleanupSucceeded = true;
  if (client === null && spawned !== null) {
    cleanupSucceeded = await terminateDetachedProcess(spawned);
  }

  if (client !== null) {
    try {
      await settleMaybe(client.close());
    } catch {
      cleanupSucceeded = false;
    }
  }
  if (!cleanupSucceeded) {
    result = failure(mode === "action" ? "codex_action_unavailable" : "unavailable");
  }
  return result;
}

async function requestRpc(client, method, params, timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS) {
  let raw;
  try {
    raw = client.request(method, params, timeoutMs);
    raw = await settleMaybe(raw);
  } catch (error) {
    return failure(internalFailureReason(error));
  }
  return internalSuccess(raw);
}

function createJsonRpcClient(processLike) {
  const inspected = inspectProcessLike(processLike);
  if (!inspected.ok) throw internalError("protocol_invalid");

  const pending = new Map();
  const listenerBindings = [];
  const terminationWaiters = new Set();
  let nextRequestId = 1;
  let buffer = "";
  let closed = false;
  let terminated = false;
  let closePromise = null;

  const rejectAll = reason => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(internalError(reason));
    }
    pending.clear();
  };

  const notifyTermination = () => {
    for (const waiter of [...terminationWaiters]) waiter(true);
  };

  const markTerminated = () => {
    if (terminated) return;
    terminated = true;
    rejectAll("unavailable");
    notifyTermination();
  };

  const addListener = (target, add, remove, event, listener) => {
    add.call(target, event, listener);
    listenerBindings.push({ target, remove, event, listener });
  };

  const detachListeners = () => {
    let detached = true;
    for (const binding of listenerBindings.splice(0).reverse()) {
      try {
        binding.remove.call(binding.target, binding.event, binding.listener);
      } catch {
        detached = false;
      }
    }
    return detached;
  };

  const parseMessage = line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      rejectAll("protocol_invalid");
      return;
    }
    if (!isPlainObject(message) || message.jsonrpc !== "2.0") {
      rejectAll("protocol_invalid");
      return;
    }

    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    if (!hasId && hasMethod && typeof message.method === "string") return;
    if (!hasId || typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      rejectAll("protocol_invalid");
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) {
      rejectAll("protocol_invalid");
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);

    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) {
      entry.reject(internalError("protocol_invalid"));
      rejectAll("protocol_invalid");
      return;
    }
    if (hasResult) {
      entry.resolve(message.result);
      return;
    }
    entry.reject(errorFromRpcError(message.error));
  };

  const onData = chunk => {
    if (closed) return;
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      rejectAll("protocol_invalid");
      return;
    }
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (buffer.length > 4 * 1024 * 1024) {
      rejectAll("protocol_invalid");
      return;
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) parseMessage(line);
    }
  };

  const onFailure = () => {
    if (!closed) rejectAll("unavailable");
  };

  const onTermination = () => {
    markTerminated();
  };

  try {
    addListener(inspected.value.stdout, inspected.value.stdoutOn, inspected.value.stdoutRemove, "data", onData);
    addListener(inspected.value.stdout, inspected.value.stdoutOn, inspected.value.stdoutRemove, "end", onFailure);
    addListener(inspected.value.stdout, inspected.value.stdoutOn, inspected.value.stdoutRemove, "error", onFailure);
    addListener(inspected.value.stderr, inspected.value.stderrOn, inspected.value.stderrRemove, "data", () => {});
    addListener(inspected.value.stderr, inspected.value.stderrOn, inspected.value.stderrRemove, "error", onFailure);
    addListener(inspected.value.process, inspected.value.processOn, inspected.value.processRemove, "error", onFailure);
    addListener(inspected.value.process, inspected.value.processOn, inspected.value.processRemove, "exit", onTermination);
    addListener(inspected.value.process, inspected.value.processOn, inspected.value.processRemove, "close", onTermination);
    if (inspected.value.exitCode !== null || inspected.value.signalCode !== null) markTerminated();
  } catch {
    detachListeners();
    throw internalError("unavailable");
  }

  const waitForTermination = timeoutMs => {
    if (terminated) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer;
      const waiter = value => {
        clearTimeout(timer);
        terminationWaiters.delete(waiter);
        resolve(value);
      };
      terminationWaiters.add(waiter);
      timer = setTimeout(() => {
        terminationWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      if (terminated) waiter(true);
    });
  };

  return {
    request(method, params, timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS) {
      if (closed) return Promise.reject(internalError("unavailable"));
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(internalError("timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
          inspected.value.write.call(inspected.value.stdin, line);
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(internalError("unavailable"));
        }
      });
    },
    notify(method, params) {
      if (closed) throw internalError("unavailable");
      try {
        const message = { jsonrpc: "2.0", method };
        if (params !== undefined) message.params = params;
        inspected.value.write.call(inspected.value.stdin, `${JSON.stringify(message)}\n`);
      } catch {
        throw internalError("unavailable");
      }
    },
    close() {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        closed = true;
        rejectAll("unavailable");

        let terminationConfirmed = terminated;
        if (!terminationConfirmed) {
          try {
            inspected.value.kill.call(inspected.value.process, "SIGTERM");
          } catch {
            // Force termination below remains the final cleanup attempt.
          }
          terminationConfirmed = await waitForTermination(PROCESS_TERMINATION_GRACE_MS);
        }
        if (!terminationConfirmed) {
          try {
            inspected.value.kill.call(inspected.value.process, "SIGKILL");
          } catch {
            // The bounded force window below determines the public outcome.
          }
          terminationConfirmed = await waitForTermination(PROCESS_TERMINATION_FORCE_MS);
        }

        const detached = detachListeners();
        if (!terminationConfirmed || !detached) throw internalError("unavailable");
      })();
      return closePromise;
    },
  };
}

async function terminateDetachedProcess(processLike) {
  const inspected = inspectProcessLike(processLike);
  if (!inspected.ok) return false;

  let terminated = inspected.value.exitCode !== null || inspected.value.signalCode !== null;
  const listenerBindings = [];
  const terminationWaiters = new Set();
  const markTerminated = () => {
    if (terminated) return;
    terminated = true;
    for (const waiter of [...terminationWaiters]) waiter(true);
  };
  const addListener = (event, listener) => {
    inspected.value.processOn.call(inspected.value.process, event, listener);
    listenerBindings.push({ event, listener });
  };
  const detachListeners = () => {
    let detached = true;
    for (const binding of listenerBindings.splice(0).reverse()) {
      try {
        inspected.value.processRemove.call(inspected.value.process, binding.event, binding.listener);
      } catch {
        detached = false;
      }
    }
    return detached;
  };
  const waitForTermination = timeoutMs => {
    if (terminated) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer;
      const waiter = value => {
        clearTimeout(timer);
        terminationWaiters.delete(waiter);
        resolve(value);
      };
      terminationWaiters.add(waiter);
      timer = setTimeout(() => {
        terminationWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      if (terminated) waiter(true);
    });
  };

  try {
    addListener("exit", markTerminated);
    addListener("close", markTerminated);
    if (!terminated) {
      try {
        inspected.value.kill.call(inspected.value.process, "SIGTERM");
      } catch {
        // Force termination below remains the final cleanup attempt.
      }
      terminated = await waitForTermination(PROCESS_TERMINATION_GRACE_MS);
    }
    if (!terminated) {
      try {
        inspected.value.kill.call(inspected.value.process, "SIGKILL");
      } catch {
        // The bounded force window below determines the public outcome.
      }
      terminated = await waitForTermination(PROCESS_TERMINATION_FORCE_MS);
    }
  } catch {
    terminated = false;
  }
  const detached = detachListeners();
  return terminated && detached;
}

function defaultSpawnAppServer({ executable, argv }) {
  return nodeSpawn(executable, argv, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function inspectResolutionDependencies(value) {
  const inspected = inspectExactDataObject(value, RESOLUTION_DEPENDENCY_KEYS, OPTIONAL_SPAWN_KEY);
  if (!inspected.ok) return failure("codex_action_dependency_invalid");
  if (
    !isCallable(inspected.values.currentSessionObserver)
    || !isCallable(inspected.values.sessionIdentityDeriver)) {
    return failure("codex_action_dependency_invalid");
  }
  const spawnAppServer = Object.hasOwn(inspected.values, "spawnAppServer")
    ? inspected.values.spawnAppServer
    : defaultSpawnAppServer;
  if (!isCallable(spawnAppServer)) return failure("codex_action_dependency_invalid");
  return success(Object.freeze({
    currentSessionObserver: inspected.values.currentSessionObserver,
    sessionIdentityDeriver: inspected.values.sessionIdentityDeriver,
    spawnAppServer,
  }));
}

function inspectActionDependencies(value) {
  const inspected = inspectExactDataObject(value, ACTION_DEPENDENCY_KEYS, OPTIONAL_SPAWN_KEY);
  if (!inspected.ok) return failure("codex_action_dependency_invalid");
  if (
    !isCallable(inspected.values.sessionIdentityDeriver)
    || typeof inspected.values.adapter_version !== "string"
    || !SEMVER_PATTERN.test(inspected.values.adapter_version)) {
    return failure("codex_action_dependency_invalid");
  }
  const spawnAppServer = Object.hasOwn(inspected.values, "spawnAppServer")
    ? inspected.values.spawnAppServer
    : defaultSpawnAppServer;
  if (!isCallable(spawnAppServer)) return failure("codex_action_dependency_invalid");
  return success(Object.freeze({
    sessionIdentityDeriver: inspected.values.sessionIdentityDeriver,
    spawnAppServer,
    adapterVersion: inspected.values.adapter_version,
  }));
}

function inspectCurrentRequest(value) {
  const inspected = inspectExactDataObject(value, CURRENT_REQUEST_KEYS);
  if (!inspected.ok || !isSafeRuntimeId(inspected.values.runtime_id)) return failure("invalid");
  return success({ runtimeId: inspected.values.runtime_id });
}

function inspectTargetRequest(value) {
  const inspected = inspectExactDataObject(value, TARGET_REQUEST_KEYS);
  if (!inspected.ok
    || !isSafeRuntimeId(inspected.values.runtime_id)
    || !isSessionIdentity(inspected.values.session_identity)) {
    return failure("invalid");
  }
  return success({
    runtimeId: inspected.values.runtime_id,
    sessionIdentity: inspected.values.session_identity,
  });
}

function inspectActionRequest(value) {
  const inspected = inspectExactDataObject(value, ACTION_REQUEST_KEYS);
  if (!inspected.ok
    || inspected.values.action_kind !== "manual_resume"
    || !isNonEmptyString(inspected.values.candidate_id)
    || !isRevision(inspected.values.state_revision)
    || !isSessionIdentity(inspected.values.current_session_identity)
    || !isClaimAttemptId(inspected.values.claim_attempt_id)) {
    return failure("invalid");
  }
  const target = inspectExactDataObject(inspected.values.target, TARGET_KEYS);
  if (!target.ok
    || target.values.runtime_id !== CODEX_RUNTIME_ID
    || !isSessionIdentity(target.values.session_identity)) {
    return failure("invalid");
  }
  return success({
    candidateId: inspected.values.candidate_id,
    stateRevision: inspected.values.state_revision,
    currentSessionIdentity: inspected.values.current_session_identity,
    claimAttemptId: inspected.values.claim_attempt_id,
    targetSessionIdentity: target.values.session_identity,
  });
}

function validateInitializeResponse(value) {
  const inspected = inspectExactDataObject(value, INITIALIZE_KEYS);
  if (!inspected.ok) return false;
  return typeof inspected.values.codexHome === "string"
    && typeof inspected.values.platformFamily === "string"
    && typeof inspected.values.platformOs === "string"
    && typeof inspected.values.userAgent === "string";
}

function inspectReadResponse(value) {
  const inspected = inspectExactDataObject(value, READ_RESPONSE_KEYS);
  if (!inspected.ok) return failure("invalid");
  const nativeId = extractNativeThreadId(inspected.values.thread);
  return nativeId === null ? failure("invalid") : success(nativeId);
}

function inspectListResponse(value) {
  const inspected = inspectExactDataObject(value, LIST_RESPONSE_KEYS, LIST_OPTIONAL_KEYS);
  if (!inspected.ok
    || !isDenseArray(inspected.values.data)
    || !(inspected.values.nextCursor === null || isCursor(inspected.values.nextCursor))) {
    return failure("invalid");
  }
  if (Object.hasOwn(inspected.values, "backwardsCursor")
    && !(inspected.values.backwardsCursor === null || isCursor(inspected.values.backwardsCursor))) {
    return failure("invalid");
  }
  return success({
    data: inspected.values.data,
    nextCursor: inspected.values.nextCursor,
  });
}

function inspectResumeResponse(value) {
  const inspected = inspectExactDataObject(value, RESUME_RESPONSE_KEYS, RESUME_OPTIONAL_KEYS);
  if (!inspected.ok) return failure("invalid");
  const nativeId = extractNativeThreadId(inspected.values.thread);
  return nativeId === null ? failure("invalid") : success({ nativeId });
}

function extractNativeThreadId(value) {
  if (!isPlainObject(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "id");
  if (!isEnumerableDataDescriptor(descriptor) || !isNativeId(descriptor.value)) return null;
  return descriptor.value;
}

function inspectProcessLike(value) {
  if (utilTypes.isProxy(value) || value === null || typeof value !== "object") {
    return failure("invalid");
  }
  const stdin = readDataProperty(value, "stdin");
  const stdout = readDataProperty(value, "stdout");
  const stderr = readDataProperty(value, "stderr");
  const processOn = readCallableProperty(value, "on");
  const processRemove = readCallableProperty(value, "removeListener");
  const kill = readCallableProperty(value, "kill");
  const stdinWrite = stdin === null ? null : readCallableProperty(stdin, "write");
  const stdoutOn = stdout === null ? null : readCallableProperty(stdout, "on");
  const stdoutRemove = stdout === null ? null : readCallableProperty(stdout, "removeListener");
  const stderrOn = stderr === null ? null : readCallableProperty(stderr, "on");
  const stderrRemove = stderr === null ? null : readCallableProperty(stderr, "removeListener");
  const exitCode = readDataProperty(value, "exitCode");
  const signalCode = readDataProperty(value, "signalCode");
  if (stdin === null || stdout === null || stderr === null
    || processOn === null || processRemove === null || kill === null
    || stdinWrite === null || stdoutOn === null || stdoutRemove === null
    || stderrOn === null || stderrRemove === null) {
    return failure("invalid");
  }
  return success({
    process: value,
    stdin,
    stdout,
    stderr,
    processOn,
    processRemove,
    kill,
    stdinWrite,
    stdoutOn,
    stdoutRemove,
    stderrOn,
    stderrRemove,
    exitCode,
    signalCode,
    write: stdinWrite,
  });
}

function readDataProperty(value, key) {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || utilTypes.isProxy(value)) {
    return null;
  }
  let current = value;
  const visited = new Set();
  try {
    while (current !== null) {
      if (visited.has(current)) return null;
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        return isDataDescriptor(descriptor) ? descriptor.value : null;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return null;
  }
  return null;
}

function readCallableProperty(value, key) {
  const property = readDataProperty(value, key);
  return typeof property === "function" && !utilTypes.isProxy(property) ? property : null;
}

function isDataDescriptor(descriptor) {
  return descriptor !== undefined
    && descriptor !== null
    && Object.hasOwn(descriptor, "value")
    && !Object.hasOwn(descriptor, "get")
    && !Object.hasOwn(descriptor, "set");
}

function isEnumerableDataDescriptor(descriptor) {
  return isDataDescriptor(descriptor) && descriptor.enumerable === true;
}

function inspectExactDataObject(value, requiredKeys, optionalKeys = []) {
  try {
    if (utilTypes.isProxy(value) || !isPlainObject(value)) return failure("invalid");
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== "string" || !allowed.has(key))) return failure("invalid");
    if (requiredKeys.some(key => !Object.hasOwn(value, key))) return failure("invalid");

    const values = {};
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return failure("invalid");
      values[key] = descriptor.value;
    }
    return { ok: true, values: Object.freeze(values) };
  } catch {
    return failure("invalid");
  }
}

function isPlainObject(value) {
  try {
    return value !== null
      && typeof value === "object"
      && !utilTypes.isProxy(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isDenseArray(value) {
  try {
    if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return false;
    }
    const ownKeys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor
      || !isDataDescriptor(lengthDescriptor)
      || lengthDescriptor.enumerable
      || lengthDescriptor.configurable
      || !Number.isSafeInteger(lengthDescriptor.value)
      || ownKeys.length !== lengthDescriptor.value + 1
      || ownKeys[ownKeys.length - 1] !== "length") {
      return false;
    }
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      if (ownKeys[index] !== String(index)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!isEnumerableDataDescriptor(descriptor)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function settleMaybe(value, absoluteDeadline = null) {
  if (utilTypes.isProxy(value)) throw internalError("protocol_invalid");
  if (!utilTypes.isPromise(value)) return value;
  const settled = absoluteDeadline === null
    ? await value
    : await settlePromiseWithinDeadline(value, absoluteDeadline);
  if (utilTypes.isProxy(settled)) throw internalError("protocol_invalid");
  return settled;
}

async function settlePromiseWithinDeadline(value, absoluteDeadline) {
  const remaining = absoluteDeadline - performance.now();
  if (remaining <= 0) throw internalError("timeout");

  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(internalError("timeout")), remaining);
  });
  try {
    return await Promise.race([value, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function internalError(reason) {
  const error = new Error();
  INTERNAL_ERRORS.set(error, reason);
  return error;
}

function internalFailureReason(error) {
  return INTERNAL_ERRORS.get(error) ?? "unavailable";
}

function errorFromRpcError(value) {
  if (!isPlainObject(value)) return internalError("protocol_invalid");
  const descriptor = Object.getOwnPropertyDescriptor(value, "code");
  if (!isEnumerableDataDescriptor(descriptor) || !Number.isSafeInteger(descriptor.value)) {
    return internalError("protocol_invalid");
  }
  if (descriptor.value === -32601) return internalError("runtime_unsupported");
  if (descriptor.value === -32001) return internalError("denied");
  return internalError("unavailable");
}

function mapResolutionTransportFailure(reason) {
  if (reason === "runtime_unsupported") return failure("runtime_unsupported");
  if (reason === "denied") return failure("denied");
  return failure(reason === "protocol_invalid" ? "unavailable" : "unavailable");
}

function mapActionTransportFailure(reason) {
  if (reason === "runtime_unsupported") return failure("codex_action_runtime_unsupported");
  if (reason === "denied") return failure("codex_action_denied");
  if (reason === "protocol_invalid") return failure("codex_action_result_invalid");
  return failure("codex_action_unavailable");
}

function semanticSuccess(sessionIdentity) {
  return Object.freeze({
    runtime_id: CODEX_RUNTIME_ID,
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

function internalSuccess(value) {
  return { ok: true, value };
}

function isCallable(value) {
  return typeof value === "function" && !utilTypes.isProxy(value);
}

function isSafeRuntimeId(value) {
  return typeof value === "string" && RUNTIME_ID_PATTERN.test(value);
}

function isNativeId(value) {
  return typeof value === "string" && NATIVE_ID_PATTERN.test(value);
}

function isCursor(value) {
  return typeof value === "string" && CURSOR_PATTERN.test(value);
}

function isSessionIdentity(value) {
  try {
    const result = validateOpaqueIdentity(value);
    return result.ok === true && result.kind === "session";
  } catch {
    return false;
  }
}

function isClaimAttemptId(value) {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
