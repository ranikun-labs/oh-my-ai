import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import * as moduleNamespace from "./lib/pending-handoff-claude-runtime-adapter.mjs";
import { createPendingHandoffSessionResolutionPort } from "./lib/pending-handoff-session-resolution.mjs";

const MODULE_PATH = new URL("./lib/pending-handoff-claude-runtime-adapter.mjs", import.meta.url);
const SOURCE = fs.readFileSync(MODULE_PATH, "utf8");
const MAKEFILE_SOURCE = fs.readFileSync(new URL("../Makefile", import.meta.url), "utf8");
const CAPABILITY_SOURCE = JSON.parse(fs.readFileSync(new URL("../capabilities/runtime-capabilities.json", import.meta.url), "utf8"));
const NATIVE_CURRENT = "claude-current-native-id";
const NATIVE_A = "claude-target-native-a";
const NATIVE_B = "claude-target-native-b";
const NATIVE_MARKER = "claude-native-private-marker";
const PATH_MARKER = "/private/claude/session-path-marker";
const CWD_MARKER = "/private/claude/cwd-marker";
const SUMMARY_MARKER = "claude-summary-private-marker";
const PROMPT_MARKER = "claude-first-prompt-private-marker";
const EXCEPTION_MARKER = "claude-exception-private-marker";

let groups = 0;
let tests = 0;

function identityFor(nativeId) {
  const result = createHash("sha256").update(nativeId).digest("base64url");
  return `phr1.session.key_A-1.${result}`;
}

const SESSION_A = identityFor(NATIVE_A);
const SESSION_B = identityFor(NATIVE_B);

function sessionInfo(sessionId, extra = {}) {
  return {
    sessionId,
    summary: SUMMARY_MARKER,
    firstPrompt: PROMPT_MARKER,
    cwd: CWD_MARKER,
    ...extra,
  };
}

function build(overrides = {}) {
  const calls = [];
  const options = {
    currentSessionObserver: () => {
      calls.push(["currentSessionObserver"]);
      return NATIVE_CURRENT;
    },
    sessionIdentityDeriver: input => {
      calls.push(["sessionIdentityDeriver", input]);
      return { ok: true, identity: identityFor(input.raw_session_id) };
    },
    listSessions: listOptions => {
      calls.push(["listSessions", listOptions]);
      return [sessionInfo(NATIVE_A)];
    },
    getSessionInfo: sessionId => {
      calls.push(["getSessionInfo", sessionId]);
      return sessionInfo(sessionId);
    },
    monotonicNow: () => 0,
    ...overrides,
  };
  const result = moduleNamespace.createPendingHandoffClaudeSessionResolutionAdapter(options);
  assert.equal(result.ok, true);
  return { facade: result.value, calls, options };
}

function immediateDeadlineTimer() {
  const active = new Set();
  const delays = [];
  return {
    options: {
      setTimeout(callback, delay) {
        delays.push(delay);
        const token = {};
        active.add(token);
        queueMicrotask(() => {
          if (!active.delete(token)) return;
          callback();
        });
        return token;
      },
      clearTimeout(token) {
        active.delete(token);
      },
    },
    activeCount: () => active.size,
    delays,
  };
}

function buildWithImmediateDeadline(overrides = {}) {
  const timer = immediateDeadlineTimer();
  const built = build({ ...overrides, ...timer.options });
  return { ...built, timer };
}

function exactFailure(value, reason) {
  assert.deepEqual(value, { ok: false, reason });
}

function exactSuccess(value, runtimeId = "claude", identity = SESSION_A) {
  assert.deepEqual(value, { runtime_id: runtimeId, session_identity: identity });
}

async function group(name, callback) {
  groups += 1;
  await callback();
}

async function test(name, callback) {
  tests += 1;
  try {
    await callback();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

await group("exact module and frozen resolution authority", async () => {
  await test("exports only the Claude resolution factory", () => {
    assert.deepEqual(Reflect.ownKeys(moduleNamespace), ["createPendingHandoffClaudeSessionResolutionAdapter", Symbol.toStringTag]);
  });
  await test("returns only frozen current/target resolution methods", () => {
    const { facade } = build();
    assert.deepEqual(Reflect.ownKeys(facade), ["resolveCurrentSession", "resolveTargetSession"]);
    assert.equal(Object.isFrozen(facade), true);
    assert.equal(typeof facade.resolveAndResume, "undefined");
  });
});

await group("minimal descriptor-safe dependency authority", async () => {
  await test("rejects extra SDK/action capabilities", () => {
    const result = moduleNamespace.createPendingHandoffClaudeSessionResolutionAdapter({
      ...build().options,
      startup: () => {},
    });
    exactFailure(result, "claude_resolution_dependency_invalid");
  });
  await test("rejects accessor and inherited capability objects without invoking getters", () => {
    let getterCalls = 0;
    const options = build().options;
    Object.defineProperty(options, "listSessions", {
      enumerable: true,
      configurable: true,
      get() { getterCalls += 1; throw new Error(EXCEPTION_MARKER); },
    });
    exactFailure(moduleNamespace.createPendingHandoffClaudeSessionResolutionAdapter(options), "claude_resolution_dependency_invalid");
    assert.equal(getterCalls, 0);

    const inherited = Object.create({ getSessionInfo: () => {} });
    Object.assign(inherited, build().options);
    delete inherited.getSessionInfo;
    exactFailure(moduleNamespace.createPendingHandoffClaudeSessionResolutionAdapter(inherited), "claude_resolution_dependency_invalid");
  });
  await test("rejects proxied and non-callable dependencies", () => {
    const options = build().options;
    options.listSessions = new Proxy(() => [], {});
    exactFailure(moduleNamespace.createPendingHandoffClaudeSessionResolutionAdapter(options), "claude_resolution_dependency_invalid");
    exactFailure(moduleNamespace.createPendingHandoffClaudeSessionResolutionAdapter({ ...build().options, getSessionInfo: 1 }), "claude_resolution_dependency_invalid");
  });
});

await group("current session namespace validation", async () => {
  await test("observes once, validates getSessionInfo.sessionId, and derives claude identity", async () => {
    const built = build();
    exactSuccess(await built.facade.resolveCurrentSession({ runtime_id: "claude" }), "claude", identityFor(NATIVE_CURRENT));
    assert.equal(built.calls.filter(([name]) => name === "currentSessionObserver").length, 1);
    assert.deepEqual(built.calls.filter(([name]) => name === "getSessionInfo").map(([, id]) => id), [NATIVE_CURRENT]);
    assert.deepEqual(built.calls.filter(([name]) => name === "sessionIdentityDeriver").map(([, input]) => input), [{ runtime_id: "claude", raw_session_id: NATIVE_CURRENT }]);
  });
  await test("rejects returned native-ID mismatch without leaking either ID", async () => {
    const built = build({ getSessionInfo: () => sessionInfo(NATIVE_A) });
    const result = await built.facade.resolveCurrentSession({ runtime_id: "claude" });
    exactFailure(result, "stale");
    assert.equal(JSON.stringify(result).includes(NATIVE_CURRENT), false);
    assert.equal(JSON.stringify(result).includes(NATIVE_A), false);
  });
  await test("normalizes missing current metadata to not_found", async () => {
    const built = build({ getSessionInfo: () => null });
    exactFailure(await built.facade.resolveCurrentSession({ runtime_id: "claude" }), "not_found");
  });
  await test("rejects wrong runtime and observer failure", async () => {
    const built = build({ currentSessionObserver: () => { throw new Error(EXCEPTION_MARKER); } });
    exactFailure(await built.facade.resolveCurrentSession({ runtime_id: "codex" }), "runtime_unsupported");
    exactFailure(await built.facade.resolveCurrentSession({ runtime_id: "claude" }), "unavailable");
  });
});

await group("target discovery completeness and identity semantics", async () => {
  await test("requests only the bounded complete list and resolves one exact target", async () => {
    let observedListOptions;
    const built = build({ listSessions: options => {
      observedListOptions = options;
      return [sessionInfo(NATIVE_A), sessionInfo(NATIVE_A)];
    } });
    exactSuccess(await built.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }));
    assert.deepEqual(observedListOptions, { limit: 513 });
    assert.equal(built.calls.filter(([name]) => name === "sessionIdentityDeriver").length, 1);
  });
  await test("normalizes zero, distinct multi-match, and wrong runtime", async () => {
    const zero = build({ listSessions: () => [] });
    exactFailure(await zero.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }), "not_found");
    const many = build({
      listSessions: () => [sessionInfo(NATIVE_A), sessionInfo(NATIVE_B)],
      sessionIdentityDeriver: input => ({ ok: true, identity: input.raw_session_id === NATIVE_B ? SESSION_A : SESSION_A }),
    });
    exactFailure(await many.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }), "ambiguous");
    exactFailure(await many.facade.resolveTargetSession({ runtime_id: "codex", session_identity: SESSION_A }), "runtime_unsupported");
  });
  await test("fails closed when the materialized population overflows", async () => {
    const overflow = Array.from({ length: 513 }, (_, index) => sessionInfo(`claude-overflow-${index}`));
    const built = build({ listSessions: () => overflow });
    exactFailure(await built.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }), "unavailable");
    assert.equal(built.calls.filter(([name]) => name === "sessionIdentityDeriver").length, 0);
  });
  await test("consumes sessionId only and does not expose metadata", async () => {
    const built = build({ listSessions: () => [{
      sessionId: NATIVE_A,
      get summary() { throw new Error(EXCEPTION_MARKER); },
      get firstPrompt() { throw new Error(PROMPT_MARKER); },
      get cwd() { throw new Error(PATH_MARKER); },
    }] });
    const result = await built.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A });
    exactSuccess(result);
    assert.equal(JSON.stringify(result).includes(NATIVE_MARKER), false);
    assert.equal(JSON.stringify(result).includes(PATH_MARKER), false);
    assert.equal(JSON.stringify(result).includes(SUMMARY_MARKER), false);
  });
});

await group("async deadline and RPL-85 compatibility", async () => {
  await test("bounds a never-settling listSessions operation", async () => {
    const built = buildWithImmediateDeadline({
      listSessions: () => new Promise(() => {}),
    });
    const result = await Promise.race([
      built.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 100)),
    ]);
    assert.notDeepEqual(result, { timeout: true });
    exactFailure(result, "unavailable");
    assert.equal(built.timer.activeCount(), 0);
  });
  await test("bounds a never-settling identity derivation", async () => {
    const built = buildWithImmediateDeadline({
      sessionIdentityDeriver: () => new Promise(() => {}),
    });
    const result = await Promise.race([
      built.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 100)),
    ]);
    assert.notDeepEqual(result, { timeout: true });
    exactFailure(result, "unavailable");
    assert.equal(built.timer.activeCount(), 0);
  });
  await test("accepts genuine Promise semantic derivation through the Session Resolution port", async () => {
    const built = build({ sessionIdentityDeriver: input => Promise.resolve({ ok: true, identity: identityFor(input.raw_session_id) }) });
    const portResult = createPendingHandoffSessionResolutionPort(built.facade);
    assert.equal(portResult.ok, true);
    const result = portResult.value.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A });
    assert.equal(result instanceof Promise, true);
    exactSuccess((await result).value);
  });
  await test("rejects an own thenable without invoking its callback", async () => {
    let thenCalls = 0;
    const thenable = { then(resolve) { thenCalls += 1; resolve(NATIVE_CURRENT); } };
    exactFailure(await build({ currentSessionObserver: () => thenable }).facade.resolveCurrentSession({ runtime_id: "claude" }), "unavailable");
    assert.equal(thenCalls, 0);
  });
  await test("rejects getter-backed, inherited, and throwing thenables without reading then", async () => {
    let getterCalls = 0;
    let callbackCalls = 0;
    const getterThenable = {};
    Object.defineProperty(getterThenable, "then", {
      enumerable: true,
      get() { getterCalls += 1; return () => { callbackCalls += 1; }; },
    });
    const inheritedThenable = Object.create({ then() { callbackCalls += 1; } });
    const throwingThenable = {};
    Object.defineProperty(throwingThenable, "then", {
      enumerable: true,
      get() { getterCalls += 1; throw new Error(EXCEPTION_MARKER); },
    });
    for (const value of [getterThenable, inheritedThenable, throwingThenable]) {
      exactFailure(await build({ currentSessionObserver: () => value }).facade.resolveCurrentSession({ runtime_id: "claude" }), "unavailable");
    }
    assert.equal(getterCalls, 0);
    assert.equal(callbackCalls, 0);
  });
  await test("rejects Proxy and Proxy-wrapped Promise before reflection", async () => {
    const proxiedValue = new Proxy({}, {});
    const proxiedPromise = new Proxy(Promise.resolve(NATIVE_CURRENT), {});
    exactFailure(await build({ currentSessionObserver: () => proxiedValue }).facade.resolveCurrentSession({ runtime_id: "claude" }), "unavailable");
    exactFailure(await build({ currentSessionObserver: () => proxiedPromise }).facade.resolveCurrentSession({ runtime_id: "claude" }), "unavailable");
  });
  await test("rejects thenables from list and identity callbacks without invoking them", async () => {
    let listGetterCalls = 0;
    const listThenable = {};
    Object.defineProperty(listThenable, "then", {
      enumerable: true,
      get() { listGetterCalls += 1; return () => {}; },
    });
    exactFailure(await build({ listSessions: () => listThenable }).facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }), "unavailable");

    let identityGetterCalls = 0;
    const identityThenable = {};
    Object.defineProperty(identityThenable, "then", {
      enumerable: true,
      get() { identityGetterCalls += 1; return () => {}; },
    });
    exactFailure(await build({ sessionIdentityDeriver: () => identityThenable }).facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }), "unavailable");
    assert.equal(listGetterCalls, 0);
    assert.equal(identityGetterCalls, 0);
  });
  await test("rejects caller deadline overrides while keeping the canonical policy internal", () => {
    for (const value of [300_000, 30_001, Infinity, -1, Number.NaN]) {
      const result = moduleNamespace.createPendingHandoffClaudeSessionResolutionAdapter({
        ...build().options,
        resolutionDeadlineMs: value,
      });
      assert.deepEqual(result, { ok: false, reason: "claude_resolution_dependency_invalid" });
    }
    assert.doesNotMatch(SOURCE, /resolutionDeadlineMs/);
  });
  await test("shares one cumulative deadline across identity derivations", async () => {
    let now = 0;
    let lateResolve;
    const built = buildWithImmediateDeadline({
      monotonicNow: () => now,
      listSessions: () => [sessionInfo(NATIVE_A), sessionInfo(NATIVE_B)],
      sessionIdentityDeriver: input => {
        if (input.raw_session_id === NATIVE_A) {
          now = 20;
          return { ok: true, identity: SESSION_A };
        }
        return new Promise(resolve => { lateResolve = resolve; });
      },
    });
    const result = await built.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A });
    exactFailure(result, "unavailable");
    assert.equal(built.timer.delays.at(-1), 29_980);
    assert.equal(built.timer.activeCount(), 0);
    lateResolve({ ok: true, identity: SESSION_B });
    await new Promise(resolve => setImmediate(resolve));
    exactFailure(result, "unavailable");

    let lateReject;
    const rejecting = buildWithImmediateDeadline({
      listSessions: () => new Promise((resolve, reject) => { lateReject = reject; }),
    });
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      exactFailure(await rejecting.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }), "unavailable");
      lateReject(new Error(EXCEPTION_MARKER));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.equal(rejecting.timer.activeCount(), 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
  await test("does not escape with an early match after later deadline exhaustion", async () => {
    let now = 0;
    const built = build({
      monotonicNow: () => now,
      listSessions: () => [sessionInfo(NATIVE_A), sessionInfo(NATIVE_B)],
      sessionIdentityDeriver: input => {
        if (input.raw_session_id === NATIVE_A) return { ok: true, identity: SESSION_A };
        now = 30_000;
        return { ok: true, identity: SESSION_B };
      },
    });
    exactFailure(await built.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }), "unavailable");
  });
});

await group("concurrency, privacy, and authority boundaries", async () => {
  await test("isolates concurrent target resolutions", async () => {
    const first = build({ listSessions: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return [sessionInfo(NATIVE_A)]; } });
    const second = build({ listSessions: async () => [sessionInfo(NATIVE_B)] });
    const [a, b] = await Promise.all([
      first.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_A }),
      second.facade.resolveTargetSession({ runtime_id: "claude", session_identity: SESSION_B }),
    ]);
    exactSuccess(a);
    assert.deepEqual(b, { runtime_id: "claude", session_identity: SESSION_B });
    assert.equal(first.calls.some(([name]) => name === "getSessionInfo"), false);
    assert.equal(second.calls.some(([name]) => name === "getSessionInfo"), false);
  });
  await test("production surface has no action, transcript, private-storage, or logging authority", () => {
    assert.doesNotMatch(SOURCE, /resolveAndResume|startup|WarmQuery|query\(|getSessionMessages|\.claude/);
    assert.doesNotMatch(SOURCE, /console\.(log|error|warn)/);
    assert.doesNotMatch(SOURCE, /readFile|readdir|history\.jsonl/);
    assert.doesNotMatch(SOURCE, /value\.then|Promise\.resolve\(value\)/);
    assert.match(SOURCE, /MAX_CLAUDE_SESSIONS = 512/);
    assert.match(SOURCE, /CLAUDE_RESOLUTION_DEADLINE_MS = 30_000/);
    assert.match(SOURCE, /limit: MAX_CLAUDE_SESSIONS \+ 1/);
    assert.match(SOURCE, /settleWithinDeadline/);
  });
});

await group("repository dependency and fixture wiring", async () => {
  await test("pins the SDK and declares the dedicated fixture once", () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(packageJson.dependencies["@anthropic-ai/claude-agent-sdk"], "0.3.232");
    assert.match(MAKEFILE_SOURCE, /^test-pending-handoff-claude-runtime-adapter-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-claude-runtime-adapter-fixtures\.mjs$/m);
    assert.equal((MAKEFILE_SOURCE.match(/test-pending-handoff-claude-runtime-adapter-fixtures/g) ?? []).length, 4);
  });
  await test("capability metadata separates resolution from unsupported action", () => {
    const capabilities = CAPABILITY_SOURCE.runtimes.claude.capabilities;
    assert.equal(capabilities.find(item => item.capability_id === "capability.session.resolve").declared_status, "supported");
    assert.equal(capabilities.find(item => item.capability_id === "capability.session.resume").declared_status, "unsupported");
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS RC 0\n`);
