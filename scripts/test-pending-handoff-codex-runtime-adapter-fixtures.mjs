import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import { fileURLToPath } from "node:url";
import * as moduleNamespace from "./lib/pending-handoff-codex-runtime-adapter.mjs";
import {
  PENDING_HANDOFF_CODEX_ACTION_FAILURES,
  createPendingHandoffCodexManualResumeExecutor,
  createPendingHandoffCodexSessionResolutionAdapter,
} from "./lib/pending-handoff-codex-runtime-adapter.mjs";
import { deriveSourceSessionIdentity } from "./lib/pending-handoff-identity.mjs";
import { createPendingHandoffSessionResolutionPort } from "./lib/pending-handoff-session-resolution.mjs";

const MODULE_PATH = fileURLToPath(new URL("./lib/pending-handoff-codex-runtime-adapter.mjs", import.meta.url));
const MAKEFILE_PATH = fileURLToPath(new URL("../Makefile", import.meta.url));
const SOURCE = fs.readFileSync(MODULE_PATH, "utf8");
const MAKEFILE_SOURCE = fs.readFileSync(MAKEFILE_PATH, "utf8");

const NATIVE_CURRENT = "0190codexcurrent000000000000000001";
const NATIVE_A = "0190codextarget000000000000000001";
const NATIVE_B = "0190codextarget000000000000000002";
const NATIVE_OTHER = "0190codexother000000000000000001";
const NATIVE_MARKER = "native-thread-secret-marker";
const PATH_MARKER = "/private/codex/raw/rollout-marker";
const CWD_MARKER = "/private/codex/worktree-marker";
const PREVIEW_MARKER = "private prompt transcript marker";
const STDOUT_MARKER = "codex stdout secret marker";
const STDERR_MARKER = "codex stderr secret marker";
const EXCEPTION_MARKER = "codex exception marker";
const SESSION_ATTEMPT = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_KINDS = [
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
];

let groups = 0;
let tests = 0;

function identityFor(nativeId) {
  const result = deriveSourceSessionIdentity({
    runtime_id: "codex",
    raw_session_id: nativeId,
    key_id: "key_A-1",
    keyed_digest: ({ bytes }) => createHash("sha256").update(bytes).digest("base64url"),
  });
  assert.equal(result.ok, true);
  return result.identity;
}

const SESSION_CURRENT = identityFor(NATIVE_CURRENT);
const SESSION_A = identityFor(NATIVE_A);
const SESSION_B = identityFor(NATIVE_B);

class FakeStdin {
  constructor(owner) {
    this.owner = owner;
  }

  write(value) {
    this.owner.accept(value);
    return true;
  }
}

class FakeProcess extends EventEmitter {
  constructor(plan, options = {}) {
    super();
    this.plan = plan;
    this.terminationMode = options.terminationMode ?? "immediate";
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new FakeStdin(this);
    this.messages = [];
    this.killSignals = [];
    this.exited = false;
  }

  terminate() {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }

  accept(value) {
    let message;
    try {
      message = JSON.parse(String(value));
    } catch {
      this.stdout.emit("data", "not-json\n");
      return;
    }
    this.messages.push(message);
    try {
      this.plan(message, this);
    } catch {
      this.emit("error", new Error(EXCEPTION_MARKER));
    }
  }

  respond(id, result) {
    this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  error(id, code) {
    this.stdout.emit("data", `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message: EXCEPTION_MARKER, data: NATIVE_MARKER },
    })}\n`);
  }

  notification(method) {
    this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  malformed(value = "{malformed") {
    this.stdout.emit("data", `${value}\n`);
  }

  mismatchedResponse(id, result) {
    this.respond(id + 999, result);
  }

  unexpectedExit() {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", 1, null);
    this.emit("close", 1, null);
  }

  kill(signal) {
    this.killSignals.push(signal);
    if (this.terminationMode === "ignore-all") return true;
    if (signal === "SIGTERM" && this.terminationMode === "ignore-term") return true;
    if (signal === "SIGTERM" && this.terminationMode === "delayed-term") {
      queueMicrotask(() => this.terminate());
      return true;
    }
    this.terminate();
    return true;
  }
}

function makeRunner(plan, ledger = { spawnArgs: [], processes: [] }, processOptions = {}) {
  return {
    ledger,
    spawnAppServer(args) {
      ledger.spawnArgs.push({ executable: args.executable, argv: [...args.argv] });
      const process = new FakeProcess(plan, processOptions);
      ledger.processes.push(process);
      return process;
    },
  };
}

function initializeResponse() {
  return {
    codexHome: "/private/codex/home",
    platformFamily: "unix",
    platformOs: "macos",
    userAgent: "codex-cli/0.147.0",
  };
}

function thread(id, overrides = {}) {
  return {
    id,
    sessionId: "shared-session-tree-id",
    path: PATH_MARKER,
    cwd: CWD_MARKER,
    preview: PREVIEW_MARKER,
    ...overrides,
  };
}

function resumeResponse(id) {
  return {
    approvalPolicy: "never",
    approvalsReviewer: null,
    cwd: CWD_MARKER,
    model: "gpt-test",
    modelProvider: "openai",
    sandbox: null,
    thread: thread(id),
  };
}

function standardPlan({ pages = {}, read = {}, resume = null, stderr = false } = {}) {
  return (message, process) => {
    if (message.method === "initialize") {
      process.respond(message.id, initializeResponse());
      return;
    }
    if (message.method === "initialized") return;
    if (message.method === "thread/read") {
      process.respond(message.id, { thread: read[message.params.threadId] ?? thread(message.params.threadId) });
      return;
    }
    if (message.method === "thread/list") {
      if (stderr) process.stderr.emit("data", `${STDERR_MARKER}\n`);
      const cursor = message.params.cursor ?? "<first>";
      const key = `${message.params.archived}:${cursor}`;
      const page = pages[key] ?? { data: [], nextCursor: null };
      process.respond(message.id, page);
      return;
    }
    if (message.method === "thread/resume") {
      process.respond(message.id, typeof resume === "function"
        ? resume(message.params.threadId)
        : resumeResponse(resume ?? message.params.threadId));
    }
  };
}

function partitionedCursorPlan({ falsePages, truePages, firstMatch = null }) {
  return (message, process) => {
    if (message.method === "initialize") {
      process.respond(message.id, initializeResponse());
      return;
    }
    if (message.method === "initialized") return;
    if (message.method !== "thread/list") return;

    const pageCount = message.params.archived ? truePages : falsePages;
    const pageIndex = message.params.cursor === undefined
      ? 0
      : Number(message.params.cursor.slice(1));
    const lastPage = pageIndex === pageCount - 1;
    const data = !message.params.archived && pageIndex === 0 && firstMatch !== null
      ? [{ id: firstMatch }]
      : [];
    process.respond(message.id, {
      data,
      nextCursor: lastPage ? null : `c${pageIndex + 1}`,
    });
  };
}

function withTrackedTimers(operation, { immediateDelays = [], manualDelays = [] } = {}) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const immediate = new Set(immediateDelays);
  const manual = new Set(manualDelays);
  const tracker = { active: new Set(), owner: {} };

  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = {
      owner: tracker.owner,
      cancelled: false,
      nativeHandle: null,
    };
    tracker.active.add(handle);
    const fire = () => {
      if (handle.cancelled) return;
      tracker.active.delete(handle);
      callback(...args);
    };
    if (manual.has(delay)) return handle;
    if (immediate.has(delay)) {
      queueMicrotask(fire);
      return handle;
    }
    handle.nativeHandle = originalSetTimeout(fire, delay, ...args);
    return handle;
  };
  globalThis.clearTimeout = handle => {
    if (handle !== null
      && typeof handle === "object"
      && handle.owner === tracker.owner) {
      handle.cancelled = true;
      tracker.active.delete(handle);
      if (handle.nativeHandle !== null) originalClearTimeout(handle.nativeHandle);
      return;
    }
    originalClearTimeout(handle);
  };
  return Promise.resolve()
    .then(() => operation(tracker))
    .finally(() => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    });
}

function withImmediateSafetyTimers(operation) {
  return withTrackedTimers(() => operation(), {
    immediateDelays: [1_000, 5_000],
  });
}

function assertProcessClean(process) {
  assert.equal(process.exited, true);
  assert.equal(process.listenerCount("exit"), 0);
  assert.equal(process.listenerCount("close"), 0);
  assert.equal(process.listenerCount("error"), 0);
  assert.equal(process.stdout.listenerCount("data"), 0);
  assert.equal(process.stdout.listenerCount("end"), 0);
  assert.equal(process.stdout.listenerCount("error"), 0);
  assert.equal(process.stderr.listenerCount("data"), 0);
  assert.equal(process.stderr.listenerCount("error"), 0);
}

function invertedActionPlan(nativeId, delayed) {
  const respond = (message, process) => {
    if (message.method === "initialize") {
      process.respond(message.id, initializeResponse());
    } else if (message.method === "thread/list") {
      process.respond(message.id, {
        data: message.params.archived ? [] : [thread(nativeId)],
        nextCursor: null,
      });
    } else if (message.method === "thread/resume") {
      process.respond(message.id, resumeResponse(nativeId));
    }
  };
  return (message, process) => {
    if (message.method === "initialized") return;
    if (delayed) {
      queueMicrotask(() => queueMicrotask(() => respond(message, process)));
    } else {
      queueMicrotask(() => respond(message, process));
    }
  };
}

function deriverWith(log = []) {
  return input => {
    log.push(input.raw_session_id);
    return deriveSourceSessionIdentity({
      runtime_id: input.runtime_id,
      raw_session_id: input.raw_session_id,
      key_id: "key_A-1",
      keyed_digest: ({ bytes }) => createHash("sha256").update(bytes).digest("base64url"),
    });
  };
}

function resolutionAdapter({ plan, observer = () => NATIVE_CURRENT, deriver = deriverWith(), ledger, processOptions } = {}) {
  const runner = makeRunner(plan ?? standardPlan(), ledger, processOptions);
  const factory = createPendingHandoffCodexSessionResolutionAdapter({
    currentSessionObserver: observer,
    sessionIdentityDeriver: deriver,
    spawnAppServer: runner.spawnAppServer,
  });
  assert.equal(factory.ok, true, factory.reason);
  return { adapter: factory.value, runner, deriver };
}

function executor({ plan, deriver = deriverWith(), ledger, adapterVersion = "1.2.3", processOptions } = {}) {
  const runner = makeRunner(plan ?? standardPlan(), ledger, processOptions);
  const factory = createPendingHandoffCodexManualResumeExecutor({
    sessionIdentityDeriver: deriver,
    adapter_version: adapterVersion,
    spawnAppServer: runner.spawnAppServer,
  });
  assert.equal(factory.ok, true, factory.reason);
  return { executor: factory.value, runner, deriver };
}

function actionRequest(overrides = {}) {
  return {
    action_kind: "manual_resume",
    candidate_id: "candidate-opaque-001",
    state_revision: 7,
    current_session_identity: SESSION_CURRENT,
    claim_attempt_id: SESSION_ATTEMPT,
    target: {
      runtime_id: "codex",
      session_identity: SESSION_A,
    },
    ...overrides,
  };
}

function assertFactorySuccess(result) {
  assert.equal(result?.ok, true, `expected factory success, got ${result?.reason}`);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "value"]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  return result.value;
}

function assertFactoryFailure(result) {
  assert.equal(result?.ok, false);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(result.reason, "codex_action_dependency_invalid");
  assert.equal(Object.isFrozen(result), true);
}

function assertResolutionSuccess(result, runtimeId, sessionIdentity) {
  assert.deepEqual(Reflect.ownKeys(result), ["runtime_id", "session_identity"]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.runtime_id, runtimeId);
  assert.equal(result.session_identity, sessionIdentity);
}

function assertResolutionFailure(result, reason) {
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.reason, reason);
}

function assertActionSuccess(result) {
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "value"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.deepEqual(Reflect.ownKeys(result.value), [
    "action_kind",
    "candidate_id",
    "state_revision",
    "current_session_identity",
    "claim_attempt_id",
    "target",
    "adapter_version",
    "outcome",
  ]);
  assert.equal(Object.isFrozen(result.value.target), true);
  return result.value;
}

function assertActionFailure(result, reason) {
  assert.equal(result.ok, false, "expected action failure");
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.reason, reason);
  assert.equal(PENDING_HANDOFF_CODEX_ACTION_FAILURES.includes(reason), true);
}

function assertNoLeak(value) {
  const serialized = (() => {
    try {
      return `${String(value)} ${JSON.stringify(value)}`;
    } catch {
      return "";
    }
  })();
  for (const marker of [
    NATIVE_MARKER,
    NATIVE_CURRENT,
    NATIVE_A,
    PATH_MARKER,
    CWD_MARKER,
    PREVIEW_MARKER,
    STDOUT_MARKER,
    STDERR_MARKER,
    EXCEPTION_MARKER,
  ]) assert.equal(serialized.includes(marker), false, marker);
}

async function captureOutput(operation) {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = chunk => { stdout += String(chunk); return true; };
  process.stderr.write = chunk => { stderr += String(chunk); return true; };
  try {
    return { value: await operation(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

async function group(name, operation) {
  groups += 1;
  await operation();
  process.stdout.write(`PASS GROUP ${name}\n`);
}

async function test(name, operation) {
  await operation();
  tests += 1;
  process.stdout.write(`PASS ${name}\n`);
}

await group("API and split authority surfaces", async () => {
  await test("module exports are exact including ESM tag", async () => {
    assert.deepEqual(Reflect.ownKeys(moduleNamespace), [
      "PENDING_HANDOFF_CODEX_ACTION_FAILURES",
      "createPendingHandoffCodexManualResumeExecutor",
      "createPendingHandoffCodexSessionResolutionAdapter",
      Symbol.toStringTag,
    ]);
  });
  await test("failure taxonomy is exact frozen data", async () => {
    assert.deepEqual(PENDING_HANDOFF_CODEX_ACTION_FAILURES, [
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
    assert.equal(Object.isFrozen(PENDING_HANDOFF_CODEX_ACTION_FAILURES), true);
    assert.throws(() => PENDING_HANDOFF_CODEX_ACTION_FAILURES.push("leak"));
  });
  await test("resolution facade exposes only observation methods", async () => {
    const { adapter } = resolutionAdapter({ plan: standardPlan() });
    assert.deepEqual(Reflect.ownKeys(adapter), ["resolveCurrentSession", "resolveTargetSession"]);
    assert.equal(Object.isFrozen(adapter), true);
    assert.equal(Object.hasOwn(adapter, "resolveAndResume"), false);
  });
  await test("action facade exposes only resolveAndResume", async () => {
    const { executor: action } = executor();
    assert.deepEqual(Reflect.ownKeys(action), ["resolveAndResume"]);
    assert.equal(Object.isFrozen(action), true);
    assert.equal(Object.hasOwn(action, "getNativeThreadId"), false);
  });
});

await group("descriptor-safe dependency authority", async () => {
  await test("missing required semantic dependencies fail closed", async () => {
    assertFactoryFailure(createPendingHandoffCodexSessionResolutionAdapter({}));
    assertFactoryFailure(createPendingHandoffCodexManualResumeExecutor({}));
  });
  await test("unexpected dependency keys fail closed", async () => {
    const base = {
      currentSessionObserver: () => NATIVE_CURRENT,
      sessionIdentityDeriver: deriverWith(),
      spawnAppServer: makeRunner(standardPlan()).spawnAppServer,
    };
    assertFactoryFailure(createPendingHandoffCodexSessionResolutionAdapter({ ...base, registryLookup: () => NATIVE_A }));
    assertFactoryFailure(createPendingHandoffCodexManualResumeExecutor({
      sessionIdentityDeriver: base.sessionIdentityDeriver,
      adapter_version: "1.2.3",
      runtimeInvoke: () => {},
    }));
  });
  await test("accessor and Symbol dependencies never execute", async () => {
    let accesses = 0;
    const options = {};
    Object.defineProperty(options, "currentSessionObserver", {
      enumerable: true,
      get() { accesses += 1; throw new Error(EXCEPTION_MARKER); },
    });
    Object.defineProperty(options, "sessionIdentityDeriver", { value: deriverWith(), enumerable: true });
    Object.defineProperty(options, "spawnAppServer", { value: makeRunner(standardPlan()).spawnAppServer, enumerable: true });
    assertFactoryFailure(createPendingHandoffCodexSessionResolutionAdapter(options));
    assert.equal(accesses, 0);
    assertFactoryFailure(createPendingHandoffCodexSessionResolutionAdapter({
      currentSessionObserver: () => NATIVE_CURRENT,
      sessionIdentityDeriver: deriverWith(),
      spawnAppServer: makeRunner(standardPlan()).spawnAppServer,
      [Symbol("extra")]: true,
    }));
  });
  await test("extra function-valued capabilities are neither accepted nor callable", async () => {
    let extraCalls = 0;
    const spawn = makeRunner(standardPlan()).spawnAppServer;
    spawn.nativeLookup = () => { extraCalls += 1; };
    const observer = () => NATIVE_CURRENT;
    observer.runtimeInvoke = () => { extraCalls += 1; };
    const { adapter } = resolutionAdapter({ observer, plan: standardPlan() });
    await adapter.resolveCurrentSession({ runtime_id: "codex" });
    assert.equal(extraCalls, 0);
    assert.equal(Object.hasOwn(adapter, "nativeLookup"), false);
    void spawn;
  });
});

await group("current Session observation and namespace binding", async () => {
  await test("observer is one-shot and Thread.id derives exact opaque identity", async () => {
    let observerCalls = 0;
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter, deriver } = resolutionAdapter({
      observer: () => { observerCalls += 1; return NATIVE_CURRENT; },
      deriver: deriverWith(),
      ledger,
      plan: standardPlan({ read: { [NATIVE_CURRENT]: thread(NATIVE_CURRENT) } }),
    });
    const raw = adapter.resolveCurrentSession({ runtime_id: "codex" });
    assert.equal(utilTypes.isPromise(raw), true);
    const result = await raw;
    assertResolutionSuccess(result, "codex", SESSION_CURRENT);
    assert.equal(observerCalls, 1);
    assert.deepEqual(deriver, deriver);
    assert.equal(ledger.processes.length, 1);
    assert.deepEqual(ledger.processes[0].messages.map(message => message.method), [
      "initialize",
      "initialized",
      "thread/read",
    ]);
    assert.deepEqual(ledger.processes[0].messages[2].params, { threadId: NATIVE_CURRENT });
  });
  await test("observer Promise compatibility remains async and isolated", async () => {
    const calls = [];
    const { adapter } = resolutionAdapter({
      observer: async () => { await Promise.resolve(); calls.push("observer"); return NATIVE_CURRENT; },
      deriver: deriverWith(calls),
      plan: standardPlan({ read: { [NATIVE_CURRENT]: thread(NATIVE_CURRENT) } }),
    });
    const resultPromise = adapter.resolveCurrentSession({ runtime_id: "codex" });
    assert.equal(utilTypes.isPromise(resultPromise), true);
    assertResolutionSuccess(await resultPromise, "codex", SESSION_CURRENT);
    assert.deepEqual(calls[0], "observer");
  });
  await test("returned Thread.id mismatch fails stale without identity derivation", async () => {
    let deriveCalls = 0;
    const { adapter } = resolutionAdapter({
      deriver: input => { deriveCalls += 1; return deriverWith()(input); },
      plan: standardPlan({ read: { [NATIVE_CURRENT]: thread(NATIVE_A) } }),
    });
    const result = await adapter.resolveCurrentSession({ runtime_id: "codex" });
    assertResolutionFailure(result, "stale");
    assert.equal(deriveCalls, 0);
    assertNoLeak(result);
  });
  await test("sessionId-only thread cannot substitute for Thread.id", async () => {
    let deriveCalls = 0;
    const { adapter } = resolutionAdapter({
      deriver: input => { deriveCalls += 1; return deriverWith()(input); },
      plan: standardPlan({ read: { [NATIVE_CURRENT]: { sessionId: NATIVE_CURRENT } } }),
    });
    const result = await adapter.resolveCurrentSession({ runtime_id: "codex" });
    assertResolutionFailure(result, "unavailable");
    assert.equal(deriveCalls, 0);
  });
  await test("wrong runtime is unsupported and does not spawn", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({ ledger });
    const result = await adapter.resolveCurrentSession({ runtime_id: "claude" });
    assertResolutionFailure(result, "runtime_unsupported");
    assert.equal(ledger.processes.length, 0);
  });
});

await group("official target discovery policy", async () => {
  await test("enumerates both archive partitions, all source kinds, and all cursors", async () => {
    const pages = {
      "false:<first>": { data: [thread(NATIVE_OTHER)], nextCursor: "page-1" },
      "false:page-1": { data: [thread(NATIVE_A)], nextCursor: null },
      "true:<first>": { data: [], nextCursor: null },
    };
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({ ledger, plan: standardPlan({ pages }) });
    const result = await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
    assertResolutionSuccess(result, "codex", SESSION_A);
    const listMessages = ledger.processes[0].messages.filter(message => message.method === "thread/list");
    assert.equal(listMessages.length, 3);
    assert.deepEqual(listMessages.map(message => message.params.archived), [false, false, true]);
    assert.deepEqual(listMessages[0].params.sourceKinds, SOURCE_KINDS);
    assert.equal(listMessages[0].params.useStateDbOnly, false);
    assert.equal(Object.hasOwn(listMessages[0].params, "cwd"), false);
    assert.equal(Object.hasOwn(listMessages[0].params, "cursor"), false);
    assert.equal(listMessages[1].params.cursor, "page-1");
    assert.equal(Object.hasOwn(listMessages[2].params, "cursor"), false);
  });
  await test("first-page-only mutation is caught by a target on the second page", async () => {
    const pages = {
      "false:<first>": { data: [], nextCursor: "next" },
      "false:next": { data: [thread(NATIVE_A)], nextCursor: null },
      "true:<first>": { data: [], nextCursor: null },
    };
    const { adapter } = resolutionAdapter({ plan: standardPlan({ pages }) });
    assertResolutionSuccess(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "codex",
      SESSION_A,
    );
  });
  await test("repeated cursor fails closed instead of looping", async () => {
    const pages = {
      "false:<first>": { data: [thread(NATIVE_OTHER)], nextCursor: "repeat" },
      "false:repeat": { data: [], nextCursor: "repeat" },
    };
    const { adapter } = resolutionAdapter({ plan: standardPlan({ pages }) });
    assertResolutionFailure(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "unavailable",
    );
  });
  await test("malformed pagination fails closed", async () => {
    const plan = standardPlan({ pages: {
      "false:<first>": { data: [thread(NATIVE_A)] },
    } });
    const { adapter } = resolutionAdapter({ plan });
    assertResolutionFailure(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "unavailable",
    );
  });
});

await group("target cardinality and native privacy", async () => {
  await test("zero matches is not_found", async () => {
    const { adapter } = resolutionAdapter({ plan: standardPlan({ pages: {
      "false:<first>": { data: [thread(NATIVE_OTHER)], nextCursor: null },
      "true:<first>": { data: [], nextCursor: null },
    } }) });
    const result = await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
    assertResolutionFailure(result, "not_found");
    assertNoLeak(result);
  });
  await test("two distinct native IDs mapping to one opaque target are ambiguous", async () => {
    const deriver = input => {
      if (input.raw_session_id === NATIVE_A || input.raw_session_id === NATIVE_B) {
        return { ok: true, identity: SESSION_A };
      }
      return deriverWith()(input);
    };
    const { adapter } = resolutionAdapter({ deriver, plan: standardPlan({ pages: {
      "false:<first>": { data: [thread(NATIVE_A), thread(NATIVE_B)], nextCursor: null },
      "true:<first>": { data: [], nextCursor: null },
    } }) });
    assertResolutionFailure(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "ambiguous",
    );
  });
  await test("duplicate native IDs are deduplicated across pages and archives", async () => {
    const calls = [];
    const pages = {
      "false:<first>": { data: [thread(NATIVE_A)], nextCursor: "next" },
      "false:next": { data: [thread(NATIVE_A)], nextCursor: null },
      "true:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
    };
    const { adapter } = resolutionAdapter({ deriver: deriverWith(calls), plan: standardPlan({ pages }) });
    assertResolutionSuccess(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "codex",
      SESSION_A,
    );
    assert.deepEqual(calls, [NATIVE_A]);
  });
  await test("native fields never cross the observation boundary", async () => {
    const { adapter } = resolutionAdapter({ plan: standardPlan({ pages: {
      "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
      "true:<first>": { data: [], nextCursor: null },
    } }) });
    const result = await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
    assertResolutionSuccess(result, "codex", SESSION_A);
    assertNoLeak(result);
    assert.equal(Object.hasOwn(result, "native_thread_id"), false);
    assert.equal(Object.hasOwn(result, "path"), false);
  });
});

await group("bounded discovery resource safety", async () => {
  await test("unique cursors stop at the operation page budget", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      plan: partitionedCursorPlan({ falsePages: 513, truePages: 1, firstMatch: NATIVE_A }),
    });
    const result = await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
    assertResolutionFailure(result, "unavailable");
    assert.equal(ledger.processes[0].messages.filter(message => message.method === "thread/list").length, 512);
    assertProcessClean(ledger.processes[0]);
  });
  await test("distinct native IDs stop at the identity budget", async () => {
    const nativeThreads = Array.from({ length: 50_001 }, (_, index) => ({
      id: index === 0 ? NATIVE_A : `budget-native-${index}`,
    }));
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      deriver: input => ({ ok: true, identity: input.raw_session_id === NATIVE_A ? SESSION_A : SESSION_B }),
      plan: standardPlan({ pages: {
        "false:<first>": { data: nativeThreads, nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    const result = await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
    assertResolutionFailure(result, "unavailable");
    assertProcessClean(ledger.processes[0]);
  });
  await test("exact native-ID budget remains a complete semantic observation", async () => {
    const nativeThreads = Array.from({ length: 50_000 }, (_, index) => ({
      id: index === 0 ? NATIVE_A : `exact-budget-native-${index}`,
    }));
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      deriver: input => ({ ok: true, identity: input.raw_session_id === NATIVE_A ? SESSION_A : SESSION_B }),
      plan: standardPlan({ pages: {
        "false:<first>": { data: nativeThreads, nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    assertResolutionSuccess(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "codex",
      SESSION_A,
    );
    assertProcessClean(ledger.processes[0]);
  });
  await test("one absolute discovery deadline stops a valid but late population", async () => {
    const originalNow = performance.now;
    let now = 0;
    performance.now = () => now;
    try {
      const plan = (message, process) => {
        if (message.method === "initialize") {
          process.respond(message.id, initializeResponse());
          return;
        }
        if (message.method === "thread/list") {
          if (message.params.cursor === undefined) {
            now = 30_001;
            process.respond(message.id, { data: [thread(NATIVE_A)], nextCursor: "late" });
          } else {
            process.respond(message.id, { data: [], nextCursor: null });
          }
        }
      };
      const ledger = { spawnArgs: [], processes: [] };
      const { adapter } = resolutionAdapter({ ledger, plan });
      const result = await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
      assertResolutionFailure(result, "unavailable");
      assertProcessClean(ledger.processes[0]);
    } finally {
      performance.now = originalNow;
    }
  });
  await test("exact page budget remains a complete semantic observation", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      plan: partitionedCursorPlan({ falsePages: 511, truePages: 1, firstMatch: NATIVE_A }),
    });
    assertResolutionSuccess(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "codex",
      SESSION_A,
    );
    assert.equal(ledger.processes[0].messages.filter(message => message.method === "thread/list").length, 512);
    assertProcessClean(ledger.processes[0]);
  });
  await test("historical cursor cycles remain fail-closed", async () => {
    const { adapter } = resolutionAdapter({ plan: standardPlan({ pages: {
      "false:<first>": { data: [], nextCursor: "a" },
      "false:a": { data: [], nextCursor: "b" },
      "false:b": { data: [], nextCursor: "a" },
      "true:<first>": { data: [], nextCursor: null },
    } }) });
    assertResolutionFailure(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "unavailable",
    );
  });
  await test("duplicate native IDs do not consume duplicate identity slots", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      plan: standardPlan({ pages: {
        "false:<first>": { data: Array.from({ length: 50_001 }, () => ({ id: NATIVE_A })), nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    assertResolutionSuccess(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "codex",
      SESSION_A,
    );
    assertProcessClean(ledger.processes[0]);
  });
});

await group("resource safety deadline closure", async () => {
  await test("never-settling identity derivation is operation-bounded", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      deriver: () => new Promise(() => {}),
      plan: standardPlan({ pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    const originalNow = performance.now;
    performance.now = () => 0;
    try {
      const observed = await withTrackedTimers(async tracker => {
        const operation = adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
        let externalTimer;
        const externalTimeout = new Promise(resolve => {
          externalTimer = setTimeout(() => resolve("external-timeout"), 0);
        });
        const result = await Promise.race([
          operation,
          externalTimeout,
        ]);
        clearTimeout(externalTimer);
        assert.notEqual(result, "external-timeout", "identity derivation exceeded the discovery deadline");
        assertResolutionFailure(result, "unavailable");
        assert.equal(tracker.active.size, 0);
        assertProcessClean(ledger.processes[0]);
        return result;
      }, { immediateDelays: [1_000, 30_000] });
      if (observed === "external-timeout") ledger.processes[0]?.terminate();
      assertResolutionFailure(observed, "unavailable");
    } finally {
      performance.now = originalNow;
    }
  });
});

await group("discovery deadline across awaitable identity work", async () => {
  await test("genuine async derivation settling before the deadline succeeds", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      deriver: async input => {
        await Promise.resolve();
        return { ok: true, identity: input.raw_session_id === NATIVE_A ? SESSION_A : SESSION_CURRENT };
      },
      plan: standardPlan({ pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    const result = await withTrackedTimers(async tracker => {
      const value = await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
      assert.equal(tracker.active.size, 0);
      return value;
    }, { manualDelays: [30_000] });
    assertResolutionSuccess(result, "codex", SESSION_A);
    assertProcessClean(ledger.processes[0]);
  });
  await test("derivation at or beyond the absolute deadline fails closed", async () => {
    const originalNow = performance.now;
    let now = 0;
    performance.now = () => now;
    try {
      for (const boundary of [30_000, 30_001]) {
        now = 0;
        const ledger = { spawnArgs: [], processes: [] };
        const { adapter } = resolutionAdapter({
          ledger,
          deriver: () => {
            now = boundary;
            return Promise.resolve({ ok: true, identity: SESSION_A });
          },
          plan: standardPlan({ pages: {
            "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
            "true:<first>": { data: [], nextCursor: null },
          } }),
        });
        assertResolutionFailure(
          await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
          "unavailable",
        );
        assertProcessClean(ledger.processes[0]);
      }
    } finally {
      performance.now = originalNow;
    }
  });
  await test("early match cannot escape cumulative deriver deadline exhaustion", async () => {
    const originalNow = performance.now;
    let nearDeadline = false;
    performance.now = () => nearDeadline ? 29_999 : 0;
    try {
      const ledger = { spawnArgs: [], processes: [] };
      const { adapter } = resolutionAdapter({
        ledger,
        deriver: input => {
          if (input.raw_session_id === NATIVE_A) {
            return { ok: true, identity: SESSION_A };
          }
          nearDeadline = true;
          return new Promise(resolve => setTimeout(
            () => resolve({ ok: true, identity: SESSION_CURRENT }),
            0,
          ));
        },
        plan: standardPlan({ pages: {
          "false:<first>": { data: [thread(NATIVE_A), thread(NATIVE_OTHER)], nextCursor: null },
          "true:<first>": { data: [], nextCursor: null },
        } }),
      });
      const result = await withTrackedTimers(
        () => adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
        { immediateDelays: [1_000, 1] },
      );
      assertResolutionFailure(result, "unavailable");
      assertProcessClean(ledger.processes[0]);
    } finally {
      performance.now = originalNow;
    }
  });
  await test("archive transition does not reset the absolute deriver deadline", async () => {
    const originalNow = performance.now;
    let nearDeadline = false;
    performance.now = () => nearDeadline ? 29_999 : 0;
    try {
      const ledger = { spawnArgs: [], processes: [] };
      const { adapter } = resolutionAdapter({
        ledger,
        deriver: input => {
          if (input.raw_session_id === NATIVE_OTHER) {
            nearDeadline = true;
            return { ok: true, identity: SESSION_CURRENT };
          }
          return new Promise(resolve => setTimeout(
            () => resolve({ ok: true, identity: SESSION_A }),
            0,
          ));
        },
        plan: standardPlan({ pages: {
          "false:<first>": { data: [thread(NATIVE_OTHER)], nextCursor: null },
          "true:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        } }),
      });
      const result = await withTrackedTimers(
        () => adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
        { immediateDelays: [1_000, 1] },
      );
      assertResolutionFailure(result, "unavailable");
      assertProcessClean(ledger.processes[0]);
    } finally {
      performance.now = originalNow;
    }
  });
  await test("deriver rejection clears its absolute-deadline timer", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      deriver: () => Promise.reject(new Error(EXCEPTION_MARKER)),
      plan: standardPlan({ pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    const result = await withTrackedTimers(async tracker => {
      const value = await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
      assert.equal(tracker.active.size, 0);
      return value;
    }, { manualDelays: [30_000] });
    assertResolutionFailure(result, "unavailable");
    assertProcessClean(ledger.processes[0]);
  });
  await test("page budget is global across archive partitions", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      plan: partitionedCursorPlan({ falsePages: 300, truePages: 213, firstMatch: NATIVE_A }),
    });
    assertResolutionFailure(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "unavailable",
    );
    assert.equal(ledger.processes[0].messages.filter(message => message.method === "thread/list").length, 512);
    assertProcessClean(ledger.processes[0]);
  });
});

await group("action request and resume authority", async () => {
  await test("resolveAndResume re-resolves completely then resumes immediately", async () => {
    const pages = {
      "false:<first>": { data: [thread(NATIVE_OTHER)], nextCursor: null },
      "true:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
    };
    const ledger = { spawnArgs: [], processes: [] };
    const { executor: action } = executor({ ledger, plan: standardPlan({ pages, resume: NATIVE_A }) });
    const receipt = assertActionSuccess(await action.resolveAndResume(actionRequest()));
    assert.deepEqual(receipt.target, { runtime_id: "codex", session_identity: SESSION_A });
    assert.equal(receipt.adapter_version, "1.2.3");
    assert.equal(receipt.outcome, "resume_accepted");
    const messages = ledger.processes[0].messages;
    assert.deepEqual(messages.map(message => message.method), [
      "initialize",
      "initialized",
      "thread/list",
      "thread/list",
      "thread/resume",
    ]);
    assert.deepEqual(messages.at(-1).params, { threadId: NATIVE_A });
    assert.equal(Object.hasOwn(messages.at(-1).params, "prompt"), false);
  });
  await test("action request validation rejects native and prompt fields before spawn", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { executor: action } = executor({ ledger });
    assertActionFailure(await action.resolveAndResume({ ...actionRequest(), native_thread_id: NATIVE_A }), "codex_action_input_invalid");
    assertActionFailure(await action.resolveAndResume({ ...actionRequest(), prompt: PREVIEW_MARKER }), "codex_action_input_invalid");
    assert.equal(ledger.processes.length, 0);
  });
  await test("zero, ambiguous, and stale resume outcomes remain distinct", async () => {
    const zero = executor({ plan: standardPlan({ pages: {
      "false:<first>": { data: [], nextCursor: null },
      "true:<first>": { data: [], nextCursor: null },
    } }) });
    assertActionFailure(await zero.executor.resolveAndResume(actionRequest()), "codex_action_not_found");

    const ambiguous = executor({
      deriver: input => [NATIVE_A, NATIVE_B].includes(input.raw_session_id)
        ? { ok: true, identity: SESSION_A }
        : deriverWith()(input),
      plan: standardPlan({ pages: {
        "false:<first>": { data: [thread(NATIVE_A), thread(NATIVE_B)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    assertActionFailure(await ambiguous.executor.resolveAndResume(actionRequest()), "codex_action_ambiguous");

    const stale = executor({ plan: standardPlan({
      pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      },
      resume: NATIVE_B,
    }) });
    assertActionFailure(await stale.executor.resolveAndResume(actionRequest()), "codex_action_stale");
  });
  await test("resume response malformed or identity-changed fails closed", async () => {
    const malformed = executor({ plan: standardPlan({
      pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      },
      resume: NATIVE_A,
    }) });
    const processPlan = (message, process) => {
      if (message.method === "initialize") process.respond(message.id, initializeResponse());
      else if (message.method === "thread/list") process.respond(message.id, {
        data: message.params.archived ? [] : [thread(NATIVE_A)], nextCursor: null,
      });
      else if (message.method === "thread/resume") process.respond(message.id, { thread: { sessionId: NATIVE_A } });
    };
    const invalid = executor({ plan: processPlan });
    assertActionFailure(await invalid.executor.resolveAndResume(actionRequest()), "codex_action_result_invalid");
    void malformed;
  });
  await test("resume only: fork and turn-start are impossible", async () => {
    assert.equal(SOURCE.includes("thread/fork"), false);
    assert.equal(SOURCE.includes("turn/start"), false);
    const { executor: action, runner } = executor({ plan: standardPlan({ pages: {
      "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
      "true:<first>": { data: [], nextCursor: null },
    } }) });
    await action.resolveAndResume(actionRequest());
    const methods = runner.ledger.processes[0].messages.map(message => message.method);
    assert.equal(methods.includes("thread/fork"), false);
    assert.equal(methods.includes("turn/start"), false);
  });
});

await group("protocol, failure, and cleanup safety", async () => {
  await test("exact executable and argv use no shell", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({ ledger, plan: standardPlan({ read: { [NATIVE_CURRENT]: thread(NATIVE_CURRENT) } }) });
    await adapter.resolveCurrentSession({ runtime_id: "codex" });
    assert.deepEqual(ledger.spawnArgs[0], { executable: "codex", argv: ["app-server", "--stdio"] });
    assert.match(SOURCE, /shell:\s*false/);
    assert.doesNotMatch(SOURCE, /sh\s+-c|bash\s+-c|execFileSync|spawnSync/);
  });
  await test("notifications are tolerated and response IDs are correlated", async () => {
    const plan = (message, process) => {
      if (message.method === "initialize") {
        process.notification("server/status");
        process.respond(message.id, initializeResponse());
      } else if (message.method === "thread/list") {
        process.notification("thread/updated");
        process.respond(message.id, { data: [thread(NATIVE_A)], nextCursor: null });
      }
    };
    const { adapter } = resolutionAdapter({ plan });
    assertResolutionSuccess(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "codex",
      SESSION_A,
    );
  });
  await test("malformed JSON, envelope, mismatched ID, and non-zero exit fail closed", async () => {
    const malformedJson = (message, process) => {
      if (message.method === "initialize") process.malformed();
    };
    assertResolutionFailure(
      await resolutionAdapter({ plan: malformedJson }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "unavailable",
    );

    const malformedEnvelope = (message, process) => {
      if (message.method === "initialize") process.stdout.emit("data", `${JSON.stringify({ id: message.id, result: initializeResponse() })}\n`);
    };
    assertResolutionFailure(
      await resolutionAdapter({ plan: malformedEnvelope }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "unavailable",
    );

    const mismatched = (message, process) => {
      if (message.method === "initialize") process.mismatchedResponse(message.id, initializeResponse());
    };
    assertResolutionFailure(
      await resolutionAdapter({ plan: mismatched }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "unavailable",
    );

    const exited = (message, process) => {
      if (message.method === "initialize") process.unexpectedExit();
    };
    assertResolutionFailure(
      await resolutionAdapter({ plan: exited }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "unavailable",
    );
  });
  await test("RPC unsupported and denial map without exposing diagnostics", async () => {
    const unsupported = (message, process) => {
      if (message.method === "initialize") process.respond(message.id, initializeResponse());
      else if (message.method === "thread/list") process.error(message.id, -32601);
    };
    const denied = (message, process) => {
      if (message.method === "initialize") process.respond(message.id, initializeResponse());
      else if (message.method === "thread/list") process.error(message.id, -32001);
    };
    assertResolutionFailure(
      await resolutionAdapter({ plan: unsupported }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "runtime_unsupported",
    );
    assertResolutionFailure(
      await resolutionAdapter({ plan: denied }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "denied",
    );
  });
  await test("timeout is bounded and kills the adapter-owned process", async () => {
    const plan = (message, process) => {
      if (message.method === "initialize") process.respond(message.id, initializeResponse());
    };
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({ plan, ledger });
    const result = await withImmediateSafetyTimers(() => adapter.resolveTargetSession({
      runtime_id: "codex",
      session_identity: SESSION_A,
    }));
    assertResolutionFailure(result, "unavailable");
    assert.equal(ledger.processes[0].killSignals.length, 1);
  });
  await test("pending RPC timer cleanup is runtime-observable", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const plan = (message, process) => {
      if (message.method === "initialize") process.unexpectedExit();
    };
    const { adapter } = resolutionAdapter({ ledger, plan });
    await withTrackedTimers(async tracker => {
      const result = await adapter.resolveTargetSession({
        runtime_id: "codex",
        session_identity: SESSION_A,
      });
      assertResolutionFailure(result, "unavailable");
      assert.equal(tracker.active.size, 0);
    }, { manualDelays: [5_000] });
  });
  await test("M11 rejectAll mutation leaves an observable pending timer", async () => {
    await withTrackedTimers(async tracker => {
      const pending = new Map();
      let rejected = false;
      const timer = setTimeout(() => {}, 5_000);
      pending.set(1, { timer, reject: () => { rejected = true; } });

      for (const entry of pending.values()) {
        entry.reject(new Error("internal"));
      }
      pending.clear();

      assert.equal(rejected, true);
      assert.equal(tracker.active.size, 1);
      clearTimeout(timer);
      assert.equal(tracker.active.size, 0);
    }, { manualDelays: [5_000] });
  });
  await test("cleanup occurs on success and failure", async () => {
    const successLedger = { spawnArgs: [], processes: [] };
    const successAdapter = resolutionAdapter({
      ledger: successLedger,
      plan: standardPlan({ pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    }).adapter;
    await successAdapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
    assert.equal(successLedger.processes[0].killSignals.length, 1);
    assertProcessClean(successLedger.processes[0]);

    const failureLedger = { spawnArgs: [], processes: [] };
    const failureAdapter = resolutionAdapter({ ledger: failureLedger, plan: (message, process) => {
      if (message.method === "initialize") process.respond(message.id, initializeResponse());
      else if (message.method === "thread/list") process.malformed();
    } }).adapter;
    await failureAdapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A });
    assert.equal(failureLedger.processes[0].killSignals.length, 1);
    assertProcessClean(failureLedger.processes[0]);
  });
  await test("already-terminated child is acknowledged without another kill", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const plan = (message, process) => {
      if (message.method === "initialize") {
        process.respond(message.id, initializeResponse());
      } else if (message.method === "thread/list") {
        process.respond(message.id, {
          data: message.params.archived ? [] : [thread(NATIVE_A)],
          nextCursor: null,
        });
        if (message.params.archived) process.terminate();
      }
    };
    const { adapter } = resolutionAdapter({ ledger, plan });
    assertResolutionSuccess(
      await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      "codex",
      SESSION_A,
    );
    assert.deepEqual(ledger.processes[0].killSignals, []);
    assertProcessClean(ledger.processes[0]);
  });
  await test("delayed graceful termination is awaited before success", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      processOptions: { terminationMode: "delayed-term" },
      plan: standardPlan({ pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    const result = await withImmediateSafetyTimers(() => adapter.resolveTargetSession({
      runtime_id: "codex",
      session_identity: SESSION_A,
    }));
    assertResolutionSuccess(result, "codex", SESSION_A);
    assert.deepEqual(ledger.processes[0].killSignals, ["SIGTERM"]);
    assertProcessClean(ledger.processes[0]);
  });
  await test("ignored graceful termination escalates and awaits force termination", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      processOptions: { terminationMode: "ignore-term" },
      plan: standardPlan({ pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    const result = await withImmediateSafetyTimers(() => adapter.resolveTargetSession({
      runtime_id: "codex",
      session_identity: SESSION_A,
    }));
    assertResolutionSuccess(result, "codex", SESSION_A);
    assert.deepEqual(ledger.processes[0].killSignals, ["SIGTERM", "SIGKILL"]);
    assertProcessClean(ledger.processes[0]);
  });
  await test("force termination failure invalidates an otherwise successful body", async () => {
    const ledger = { spawnArgs: [], processes: [] };
    const { adapter } = resolutionAdapter({
      ledger,
      processOptions: { terminationMode: "ignore-all" },
      plan: standardPlan({ pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    const result = await withImmediateSafetyTimers(() => adapter.resolveTargetSession({
      runtime_id: "codex",
      session_identity: SESSION_A,
    }));
    assertResolutionFailure(result, "unavailable");
    assert.deepEqual(ledger.processes[0].killSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(ledger.processes[0].listenerCount("exit"), 0);
    assert.equal(ledger.processes[0].listenerCount("close"), 0);
    assert.equal(ledger.processes[0].stdout.listenerCount("data"), 0);
    assert.equal(ledger.processes[0].stderr.listenerCount("data"), 0);
  });
  await test("repeated operations detach listeners and settle process state", async () => {
    await withTrackedTimers(async tracker => {
      for (let index = 0; index < 3; index += 1) {
        const ledger = { spawnArgs: [], processes: [] };
        const { adapter } = resolutionAdapter({
          ledger,
          plan: standardPlan({ pages: {
            "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
            "true:<first>": { data: [], nextCursor: null },
          } }),
        });
        assertResolutionSuccess(
          await adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
          "codex",
          SESSION_A,
        );
        assert.equal(tracker.active.size, 0);
        assertProcessClean(ledger.processes[0]);
      }
    }, { manualDelays: [5_000] });
  });
  await test("all public outcomes restore the adapter-owned timer baseline", async () => {
    const run = async (tracker, operation, expectedReason = null) => {
      const result = await operation();
      if (expectedReason === null) {
        assert.equal(result.ok === true || result.runtime_id === "codex", true);
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.reason, expectedReason);
      }
      assert.equal(tracker.active.size, 0);
      return result;
    };

    await withTrackedTimers(async tracker => {
      const successLedger = { spawnArgs: [], processes: [] };
      await run(
        tracker,
        () => resolutionAdapter({
          ledger: successLedger,
          plan: standardPlan({ pages: {
            "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
            "true:<first>": { data: [], nextCursor: null },
          } }),
        }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      );
      assertProcessClean(successLedger.processes[0]);

      const timeoutLedger = { spawnArgs: [], processes: [] };
      await withTrackedTimers(async timeoutTracker => {
        await run(
          timeoutTracker,
          () => resolutionAdapter({
            ledger: timeoutLedger,
            plan: (message, process) => {
              if (message.method === "initialize") process.respond(message.id, initializeResponse());
            },
          }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
          "unavailable",
        );
      }, { immediateDelays: [1_000, 5_000] });
      assertProcessClean(timeoutLedger.processes[0]);

      const exitedLedger = { spawnArgs: [], processes: [] };
      await run(
        tracker,
        () => resolutionAdapter({
          ledger: exitedLedger,
          plan: (message, process) => {
            if (message.method === "initialize") process.unexpectedExit();
          },
        }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
        "unavailable",
      );
      assertProcessClean(exitedLedger.processes[0]);

      const initFailureLedger = { spawnArgs: [], processes: [] };
      await run(
        tracker,
        () => resolutionAdapter({
          ledger: initFailureLedger,
          plan: (message, process) => {
            if (message.method === "initialize") process.malformed();
          },
        }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
        "unavailable",
      );
      assertProcessClean(initFailureLedger.processes[0]);

      const budgetLedger = { spawnArgs: [], processes: [] };
      await run(
        tracker,
        () => resolutionAdapter({
          ledger: budgetLedger,
          plan: partitionedCursorPlan({ falsePages: 513, truePages: 1, firstMatch: NATIVE_A }),
        }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
        "unavailable",
      );
      assertProcessClean(budgetLedger.processes[0]);

      const originalNow = performance.now;
      performance.now = () => 0;
      try {
        const deadlineLedger = { spawnArgs: [], processes: [] };
        await run(
          tracker,
          () => resolutionAdapter({
            ledger: deadlineLedger,
            deriver: () => new Promise(() => {}),
            plan: standardPlan({ pages: {
              "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
              "true:<first>": { data: [], nextCursor: null },
            } }),
          }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
          "unavailable",
        );
        assertProcessClean(deadlineLedger.processes[0]);
      } finally {
        performance.now = originalNow;
      }

      const resumeFailureLedger = { spawnArgs: [], processes: [] };
      await run(
        tracker,
        () => executor({
          ledger: resumeFailureLedger,
          plan: standardPlan({
            pages: {
              "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
              "true:<first>": { data: [], nextCursor: null },
            },
            resume: NATIVE_B,
          }),
        }).executor.resolveAndResume(actionRequest()),
        "codex_action_stale",
      );
      assertProcessClean(resumeFailureLedger.processes[0]);

      const forceFailureLedger = { spawnArgs: [], processes: [] };
      await run(
        tracker,
        () => resolutionAdapter({
          ledger: forceFailureLedger,
          processOptions: { terminationMode: "ignore-all" },
          plan: standardPlan({ pages: {
            "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
            "true:<first>": { data: [], nextCursor: null },
          } }),
        }).adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
        "unavailable",
      );
      assert.equal(forceFailureLedger.processes[0].exited, false);
      assert.equal(forceFailureLedger.processes[0].listenerCount("exit"), 0);
      assert.equal(forceFailureLedger.processes[0].listenerCount("close"), 0);
    }, {
      immediateDelays: [1_000, 5_000, 30_000],
      manualDelays: [5_000],
    });
  });
});

await group("privacy, static boundary, and async composition", async () => {
  await test("raw runtime material never appears in result or output", async () => {
    const plan = standardPlan({
      stderr: true,
      pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      },
    });
    const { adapter } = resolutionAdapter({ plan });
    const captured = await captureOutput(() => adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }));
    assertResolutionSuccess(captured.value, "codex", SESSION_A);
    assertNoLeak(captured.value);
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
  });
  await test("deriver rejection is sanitized and no exception text escapes", async () => {
    const { adapter } = resolutionAdapter({
      deriver: () => { throw new Error(EXCEPTION_MARKER); },
      plan: standardPlan({ pages: {
        "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } }),
    });
    const captured = await captureOutput(() => adapter.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }));
    assertResolutionFailure(captured.value, "unavailable");
    assertNoLeak(captured.value);
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
  });
  await test("RPL-85 async Session Resolution port consumes adapter promises", async () => {
    const { adapter } = resolutionAdapter({ plan: standardPlan({ read: { [NATIVE_CURRENT]: thread(NATIVE_CURRENT) } }) });
    const portFactory = createPendingHandoffSessionResolutionPort({
      resolveCurrentSession: adapter.resolveCurrentSession,
      resolveTargetSession: adapter.resolveTargetSession,
    });
    const port = assertFactorySuccess(portFactory);
    const promise = port.resolveCurrentSession({ runtime_id: "codex" });
    assert.equal(utilTypes.isPromise(promise), true);
    const portResult = await promise;
    assert.equal(portResult.ok, true);
    assertResolutionSuccess(portResult.value, "codex", SESSION_CURRENT);
  });
  await test("source has no Core, Registry, private-storage, or mutation dependency", async () => {
    assert.doesNotMatch(SOURCE, /pending-handoff-(?:store|claim-lease|delivery-consumption|manual-resume)/);
    assert.doesNotMatch(SOURCE, /from ["'](?:.*registry|.*context-checkpoint)/i);
    assert.doesNotMatch(SOURCE, /(?:~|\/)\.codex(?:\/|\\\\)|sqlite|rollout/i);
    assert.doesNotMatch(SOURCE, /thread\/fork|turn\/start/);
    assert.doesNotMatch(SOURCE, /console\.(?:log|error|warn|info)/);
    assert.match(SOURCE, /node:child_process/);
    assert.match(SOURCE, /node:util/);
  });
  await test("action receipt is not Delivery Evidence and has no native authority", async () => {
    const { executor: action } = executor({ plan: standardPlan({ pages: {
      "false:<first>": { data: [thread(NATIVE_A)], nextCursor: null },
      "true:<first>": { data: [], nextCursor: null },
    } }) });
    const receipt = assertActionSuccess(await action.resolveAndResume(actionRequest()));
    assert.equal(receipt.outcome, "resume_accepted");
    assert.equal(Object.hasOwn(receipt, "evidence_id"), false);
    assert.equal(Object.hasOwn(receipt, "native_thread_id"), false);
    assertNoLeak(receipt);
  });
});

await group("concurrency and Makefile integration", async () => {
  await test("concurrent independent resolution requests do not cross-wire", async () => {
    const ledgers = [];
    const makeAdapter = (nativeId, identity) => {
      const ledger = { spawnArgs: [], processes: [] };
      const plan = standardPlan({ pages: {
        "false:<first>": { data: [thread(nativeId)], nextCursor: null },
        "true:<first>": { data: [], nextCursor: null },
      } });
      const instance = resolutionAdapter({ ledger, plan, deriver: input => ({ ok: true, identity: input.raw_session_id === nativeId ? identity : SESSION_B }) });
      ledgers.push(ledger);
      return instance.adapter;
    };
    const adapterA = makeAdapter(NATIVE_A, SESSION_A);
    const adapterB = makeAdapter(NATIVE_B, SESSION_B);
    const [resultA, resultB] = await Promise.all([
      adapterA.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }),
      adapterB.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_B }),
    ]);
    assertResolutionSuccess(resultA, "codex", SESSION_A);
    assertResolutionSuccess(resultB, "codex", SESSION_B);
    assert.equal(ledgers[0].processes[0].killSignals.length, 1);
    assert.equal(ledgers[1].processes[0].killSignals.length, 1);
  });
  await test("concurrent resolveAndResume requests isolate process and receipt cleanup", async () => {
    await withTrackedTimers(async tracker => {
      const ledgerA = { spawnArgs: [], processes: [] };
      const ledgerB = { spawnArgs: [], processes: [] };
      const actionA = executor({
        ledger: ledgerA,
        plan: invertedActionPlan(NATIVE_A, true),
      }).executor;
      const actionB = executor({
        ledger: ledgerB,
        plan: invertedActionPlan(NATIVE_B, false),
      }).executor;
      const [resultA, resultB] = await Promise.all([
        actionA.resolveAndResume(actionRequest({
          candidate_id: "candidate-A",
          target: { runtime_id: "codex", session_identity: SESSION_A },
        })),
        actionB.resolveAndResume(actionRequest({
          candidate_id: "candidate-B",
          current_session_identity: SESSION_B,
          claim_attempt_id: "223e4567-e89b-42d3-a456-426614174000",
          target: { runtime_id: "codex", session_identity: SESSION_B },
        })),
      ]);
      const receiptA = assertActionSuccess(resultA);
      const receiptB = assertActionSuccess(resultB);
      assert.equal(receiptA.candidate_id, "candidate-A");
      assert.equal(receiptA.target.session_identity, SESSION_A);
      assert.equal(receiptB.candidate_id, "candidate-B");
      assert.equal(receiptB.target.session_identity, SESSION_B);
      assert.deepEqual(ledgerA.processes[0].killSignals, ["SIGTERM"]);
      assert.deepEqual(ledgerB.processes[0].killSignals, ["SIGTERM"]);
      assertProcessClean(ledgerA.processes[0]);
      assertProcessClean(ledgerB.processes[0]);
      assert.equal(tracker.active.size, 0);
    }, { manualDelays: [5_000] });
  });
  await test("one action cleanup cannot clear the other action's pending RPC timer", async () => {
    await withTrackedTimers(async tracker => {
      const ledgerA = { spawnArgs: [], processes: [] };
      const ledgerB = { spawnArgs: [], processes: [] };
      let releaseB = false;
      let pendingInitializeId = null;
      const planB = (message, process) => {
        if (message.method === "initialize") {
          if (releaseB) process.respond(message.id, initializeResponse());
          else pendingInitializeId = message.id;
          return;
        }
        if (!releaseB) return;
        if (message.method === "thread/list") {
          process.respond(message.id, {
            data: message.params.archived ? [] : [thread(NATIVE_B)],
            nextCursor: null,
          });
        } else if (message.method === "thread/resume") {
          process.respond(message.id, resumeResponse(NATIVE_B));
        }
      };
      const actionA = executor({
        ledger: ledgerA,
        plan: invertedActionPlan(NATIVE_A, true),
      }).executor;
      const actionB = executor({ ledger: ledgerB, plan: planB }).executor;
      const operationA = actionA.resolveAndResume(actionRequest({
        candidate_id: "candidate-A",
        target: { runtime_id: "codex", session_identity: SESSION_A },
      }));
      const operationB = actionB.resolveAndResume(actionRequest({
        candidate_id: "candidate-B",
        current_session_identity: SESSION_B,
        claim_attempt_id: "223e4567-e89b-42d3-a456-426614174000",
        target: { runtime_id: "codex", session_identity: SESSION_B },
      }));

      assertActionSuccess(await operationA);
      assert.equal(tracker.active.size, 1);
      assert.equal(pendingInitializeId !== null, true);
      releaseB = true;
      ledgerB.processes[0].respond(pendingInitializeId, initializeResponse());
      assertActionSuccess(await operationB);
      assert.equal(tracker.active.size, 0);
      assertProcessClean(ledgerA.processes[0]);
      assertProcessClean(ledgerB.processes[0]);
    }, { manualDelays: [5_000] });
  });
  await test("Makefile declares Codex target after Manual Resume and aggregate includes it once", async () => {
    assert.match(MAKEFILE_SOURCE, /^test-pending-handoff-codex-runtime-adapter-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-codex-runtime-adapter-fixtures\.mjs$/m);
    const declaration = MAKEFILE_SOURCE.match(/^test-v1x-fixtures:[\s\S]*?(?=\n\ninstall:)/m)?.[0] ?? "";
    assert.ok(declaration.indexOf("test-pending-handoff-manual-resume-fixtures") < declaration.indexOf("test-pending-handoff-codex-runtime-adapter-fixtures"));
    assert.equal((declaration.match(/test-pending-handoff-codex-runtime-adapter-fixtures/g) ?? []).length, 1);
  });
  await test("high-risk mutation guards remain explicit in production", async () => {
    assert.match(SOURCE, /MAX_DISCOVERY_PAGES = 512/);
    assert.match(SOURCE, /MAX_DISCOVERY_NATIVE_IDS = 50_000/);
    assert.match(SOURCE, /DISCOVERY_DEADLINE_MS = 30_000/);
    assert.match(SOURCE, /deriveOpaqueIdentity\(deriver, nativeId, discoveryDeadline\)/);
    assert.match(SOURCE, /settlePromiseWithinDeadline/);
    assert.match(SOURCE, /clearTimeout\(timer\)/);
    assert.match(SOURCE, /PROCESS_TERMINATION_GRACE_MS = 1_000/);
    assert.match(SOURCE, /PROCESS_TERMINATION_FORCE_MS = 1_000/);
    assert.match(SOURCE, /sourceKinds: \[\.\.\.SOURCE_KINDS\]/);
    assert.match(SOURCE, /useStateDbOnly: false/);
    assert.match(SOURCE, /archived of \[false, true\]/);
    assert.match(SOURCE, /threadId: target\.value\.nativeId/);
    assert.doesNotMatch(SOURCE, /sessionId\s*\)/);
    assert.match(SOURCE, /matches\.length === 0/);
    assert.match(SOURCE, /matches\.length > 1/);
    assert.match(SOURCE, /SIGTERM/);
    assert.match(SOURCE, /SIGKILL/);
    assert.match(SOURCE, /await waitForTermination/);
    assert.match(SOURCE, /pending\.clear\(\)/);
    assert.match(SOURCE, /detachListeners/);
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS RC 0\n`);
