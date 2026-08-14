import assert from "node:assert/strict";
import fs from "node:fs";
import * as moduleNamespace from "./lib/pending-handoff-manual-resume.mjs";
import {
  PENDING_HANDOFF_MANUAL_RESUME_FAILURES,
  createPendingHandoffManualResumeService,
} from "./lib/pending-handoff-manual-resume.mjs";
import { PENDING_HANDOFF_SCHEMA_VERSION } from "./lib/pending-handoff-core.mjs";

const MODULE_PATH = new URL("./lib/pending-handoff-manual-resume.mjs", import.meta.url);
const SOURCE = fs.readFileSync(MODULE_PATH, "utf8");
const MAKEFILE_SOURCE = fs.readFileSync(new URL("../Makefile", import.meta.url), "utf8");

const RUNTIME_A = "codex";
const RUNTIME_B = "claude";
const INVALID_RUNTIME = "Codex";
const SESSION_SOURCE = `phr1.session.key_A-1.${"S".repeat(43)}`;
const SESSION_OWNER_A = `phr1.session.key_A-1.${"A".repeat(43)}`;
const SESSION_OWNER_B = `phr1.session.key_A-1.${"B".repeat(43)}`;
const SESSION_OTHER = `phr1.session.key_A-1.${"O".repeat(43)}`;
const REPOSITORY_IDENTITY = `phr1.repository.key_A-1.${"R".repeat(43)}`;
const WORKTREE_IDENTITY = `phr1.worktree.key_A-1.${"W".repeat(43)}`;
const CLAIM_ATTEMPT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ATTEMPT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRIVATE_MARKER = "manual-resume-private-marker";
const EXCEPTION_MARKER = "manual-resume-exception-marker";
const NATIVE_ID = "native-session-id-must-not-escape";
const NATIVE_PATH = "/private/native/manual-resume/session";
const NATIVE_TOKEN = "token_like_manual_resume_secret";
const NESTED_PROXY_MARKER = "manual-resume-nested-proxy-marker";

let groups = 0;
let tests = 0;

const FAILURE_REASONS = Object.freeze([
  "manual_resume_dependency_invalid",
  "manual_resume_input_invalid",
  "manual_resume_record_not_found",
  "manual_resume_persisted_state_invalid",
  "manual_resume_state_not_resumable",
  "manual_resume_revision_conflict",
  "manual_resume_current_session_unavailable",
  "manual_resume_target_not_found",
  "manual_resume_target_ambiguous",
  "manual_resume_target_stale",
  "manual_resume_runtime_unsupported",
  "manual_resume_session_mismatch",
  "manual_resume_ownership_conflict",
  "manual_resume_denied",
  "manual_resume_action_request_unavailable",
]);

function freezeDeep(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

function candidate(overrides = {}) {
  return {
    candidate_id: "manual-resume-candidate-001",
    schema_version: PENDING_HANDOFF_SCHEMA_VERSION,
    status: "pending",
    created_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T02:00:00.000Z",
    source_runtime: RUNTIME_A,
    source_session_identity: SESSION_SOURCE,
    repository_identity: REPOSITORY_IDENTITY,
    worktree_identity: WORKTREE_IDENTITY,
    goal: "Prepare a runtime-neutral manual resume action.",
    completed: ["Candidate was persisted."],
    open_issues: [],
    verification: ["The orchestration boundary is under review."],
    do_not_touch: ["Native runtime state."],
    next_action: "Prepare the manual resume request.",
    context_checkpoint_status: "review_needed",
    privacy_redaction_status: "passed",
    ...overrides,
  };
}

function claim(owner = SESSION_OWNER_A, attempt = CLAIM_ATTEMPT_A) {
  return {
    claim_owner_identity: owner,
    claim_started_at: "2026-08-01T00:10:00.000Z",
    claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
    claim_attempt_id: attempt,
  };
}

function delivery() {
  return {
    delivery_attempt_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    delivery_attempted_at: "2026-08-01T00:20:00.000Z",
    delivery_candidate_digest: "D".repeat(43),
  };
}

function confirmedDelivery() {
  return {
    ...delivery(),
    evidence: {},
    delivered_at: "2026-08-01T00:30:00.000Z",
  };
}

function consumedDelivery() {
  return {
    ...confirmedDelivery(),
    consumed_at: "2026-08-01T00:40:00.000Z",
  };
}

function state(overrides = {}) {
  const value = {
    candidate: candidate(),
    state_revision: 1,
    claim: null,
    ...overrides,
  };
  return freezeDeep(value);
}

function success(value) {
  return { ok: true, value };
}

function failure(reason) {
  return { ok: false, reason };
}

function resolutionSuccess(runtimeId = RUNTIME_A, identity = SESSION_SOURCE) {
  return Object.freeze({
    ok: true,
    value: Object.freeze({ runtime_id: runtimeId, session_identity: identity }),
  });
}

function nestedResolutionSuccess(value) {
  return { ok: true, value };
}

function makeNestedSemanticProxy(identity) {
  const target = {
    runtime_id: RUNTIME_A,
    session_identity: identity,
  };
  return kind => {
    let trapCalls = 0;
    let thenCalls = 0;
    const mark = () => {
      trapCalls += 1;
      process.stdout.write(`${NESTED_PROXY_MARKER}-stdout`);
      process.stderr.write(`${NESTED_PROXY_MARKER}-stderr`);
    };
    const handler = {};
    if (kind === "get") {
      handler.get = (value, property, receiver) => {
        mark();
        if (property === "then") {
          thenCalls += 1;
          return () => {};
        }
        return Reflect.get(value, property, receiver);
      };
    }
    if (kind === "ownKeys") {
      handler.ownKeys = value => {
        mark();
        return Reflect.ownKeys(value);
      };
    }
    if (kind === "descriptor") {
      handler.getOwnPropertyDescriptor = (value, property) => {
        mark();
        return Reflect.getOwnPropertyDescriptor(value, property);
      };
    }
    if (kind === "prototype") {
      handler.getPrototypeOf = value => {
        mark();
        return Reflect.getPrototypeOf(value);
      };
    }
    const value = new Proxy(target, handler);
    return {
      value,
      counts: () => ({ trapCalls, thenCalls }),
    };
  };
}

function resolutionFailure(reason) {
  return Object.freeze({ ok: false, reason: `session_resolution_${reason}` });
}

function claimSuccess(stateRevision = 2, attempt = CLAIM_ATTEMPT_A) {
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      state_revision: stateRevision,
      claim_attempt_id: attempt,
      claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
    }),
  });
}

function exactSuccess(result) {
  assert.equal(result?.ok, true, `expected success, got ${result?.reason}`);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "value"]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  return result.value;
}

function exactFailure(result, reason) {
  assert.equal(result?.ok, false, "expected semantic failure");
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.equal(result.reason, reason);
  assert.equal(PENDING_HANDOFF_MANUAL_RESUME_FAILURES.includes(reason), true);
}

function assertAction(value, expected = {}) {
  assert.deepEqual(Reflect.ownKeys(value), [
    "action_kind",
    "candidate_id",
    "state_revision",
    "current_session_identity",
    "claim_attempt_id",
    "target",
  ]);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Reflect.ownKeys(value.target), ["runtime_id", "session_identity"]);
  assert.equal(Object.getPrototypeOf(value.target), Object.prototype);
  assert.equal(Object.isFrozen(value.target), true);
  assert.deepEqual(value, {
    action_kind: "manual_resume",
    candidate_id: expected.candidateId ?? "manual-resume-candidate-001",
    state_revision: expected.stateRevision ?? 2,
    current_session_identity: expected.owner ?? SESSION_OWNER_A,
    claim_attempt_id: expected.attempt ?? CLAIM_ATTEMPT_A,
    target: {
      runtime_id: expected.targetRuntime ?? RUNTIME_A,
      session_identity: expected.targetIdentity ?? SESSION_SOURCE,
    },
  });
  assert.equal(Object.isFrozen(value.target), true);
}

function createDependencies(options = {}) {
  const calls = [];
  const current = options.current ?? resolutionSuccess(RUNTIME_A, SESSION_OWNER_A);
  const target = options.target ?? resolutionSuccess(RUNTIME_A, SESSION_SOURCE);
  const claimResult = options.claimResult ?? claimSuccess();
  const readState = options.readState ?? success(state());
  const store = options.store ?? {
    readState: async candidateId => {
      calls.push(["readState", candidateId]);
      if (typeof readState === "function") return readState(candidateId);
      return readState;
    },
  };
  const sessionResolution = options.sessionResolution ?? {
    resolveCurrentSession: request => {
      calls.push(["resolveCurrentSession", request]);
      const result = typeof current === "function" ? current(request) : current;
      return Promise.resolve(result);
    },
    resolveTargetSession: request => {
      calls.push(["resolveTargetSession", request]);
      const result = typeof target === "function" ? target(request) : target;
      return Promise.resolve(result);
    },
  };
  const claimLease = options.claimLease ?? {
    acquireClaim: async request => {
      calls.push(["acquireClaim", request]);
      if (typeof claimResult === "function") return claimResult(request);
      return claimResult;
    },
  };
  const dependencies = { store, sessionResolution, claimLease };
  return { calls, dependencies, store, sessionResolution, claimLease };
}

function createService(options = {}) {
  const built = createDependencies(options);
  const result = createPendingHandoffManualResumeService(built.dependencies);
  return { ...built, service: exactSuccess(result) };
}

function request(overrides = {}) {
  return {
    candidate_id: "manual-resume-candidate-001",
    expected_revision: 1,
    current_runtime_id: RUNTIME_A,
    claim_attempt_id: CLAIM_ATTEMPT_A,
    ...overrides,
  };
}

function assertNoLeak(value, markers = [
  PRIVATE_MARKER,
  EXCEPTION_MARKER,
  NATIVE_ID,
  NATIVE_PATH,
  NATIVE_TOKEN,
]) {
  const serialized = JSON.stringify(value);
  for (const marker of markers) assert.equal(serialized.includes(marker), false, marker);
}

async function captureOutput(operation) {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = chunk => { stdout += String(chunk); return true; };
  process.stderr.write = chunk => { stderr += String(chunk); return true; };
  try {
    return { value: await operation(), stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

async function group(name, operation) {
  await operation();
  groups += 1;
  process.stdout.write(`PASS GROUP ${groups} ${name}\n`);
}

async function test(name, operation) {
  await operation();
  tests += 1;
  process.stdout.write(`PASS ${name}\n`);
}

await group("API oracle", async () => {
  await test("exports exact public module surface including ESM metadata", () => {
    assert.deepEqual(Reflect.ownKeys(moduleNamespace), [
      "PENDING_HANDOFF_MANUAL_RESUME_FAILURES",
      "createPendingHandoffManualResumeService",
      Symbol.toStringTag,
    ]);
  });
  await test("freezes the exact failure taxonomy", () => {
    assert.deepEqual(PENDING_HANDOFF_MANUAL_RESUME_FAILURES, FAILURE_REASONS);
    assert.equal(Object.isFrozen(PENDING_HANDOFF_MANUAL_RESUME_FAILURES), true);
    assert.throws(() => PENDING_HANDOFF_MANUAL_RESUME_FAILURES.push("unexpected"));
  });
  await test("returns a frozen facade with exactly prepareManualResume", () => {
    const { service } = createService();
    assert.deepEqual(Reflect.ownKeys(service), ["prepareManualResume"]);
    assert.equal(Object.isFrozen(service), true);
    assert.equal(typeof service.prepareManualResume, "function");
    assert.equal(Object.hasOwn(service, Symbol("hidden")), false);
  });
});

await group("dependency boundary", async () => {
  const valid = createDependencies().dependencies;
  await test("rejects missing, extra, Symbol, accessor, and malformed facades", () => {
    const cases = [
      {},
      { ...valid, extra: true },
      (() => { const value = { ...valid }; value[Symbol("extra")] = true; return value; })(),
      (() => { const value = { ...valid }; Object.defineProperty(value, "store", { get: () => valid.store, enumerable: true }); return value; })(),
      { ...valid, store: { readState: () => undefined, extra: 1 } },
      { ...valid, sessionResolution: { resolveCurrentSession: () => undefined } },
      { ...valid, claimLease: { acquireClaim: () => undefined, hidden: 1 } },
      { ...valid, store: Object.create(null) },
    ];
    for (const value of cases) exactFailure(
      createPendingHandoffManualResumeService(value),
      "manual_resume_dependency_invalid",
    );
  });
  await test("snapshots only approved capabilities and drops caller facade references", async () => {
    const extraCalls = [];
    const store = {
      readState: async () => success(state()),
      compareAndSet: () => extraCalls.push("store.compareAndSet"),
      nativeLookup: () => extraCalls.push("store.nativeLookup"),
    };
    const sessionResolution = {
      resolveCurrentSession: () => Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_OWNER_A)),
      resolveTargetSession: () => Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_SOURCE)),
      registryLookup: () => extraCalls.push("sessionResolution.registryLookup"),
    };
    const claimLease = {
      acquireClaim: async value => claimSuccess(2, value.claim_attempt_id),
      recoverClaimLease: () => extraCalls.push("claimLease.recoverClaimLease"),
      runtimeInvoke: () => extraCalls.push("claimLease.runtimeInvoke"),
    };
    const service = exactSuccess(createPendingHandoffManualResumeService({
      store,
      sessionResolution,
      claimLease,
    }));

    store.readState = async () => { throw new Error("original store facade retained"); };
    sessionResolution.resolveCurrentSession = () => {
      throw new Error("original session facade retained");
    };
    sessionResolution.resolveTargetSession = () => {
      throw new Error("original session facade retained");
    };
    claimLease.acquireClaim = async () => { throw new Error("original claim facade retained"); };

    exactSuccess(await service.prepareManualResume(request()));
    assert.deepEqual(extraCalls, []);
    assert.equal(Object.hasOwn(service, "store"), false);
    assert.equal(Object.hasOwn(service, "sessionResolution"), false);
    assert.equal(Object.hasOwn(service, "claimLease"), false);
    assert.equal(Object.getOwnPropertyNames(service).length, 1);
  });
  await test("rejects required capability accessors without executing them", () => {
    let getterCalls = 0;
    const accessorCases = [
      (() => {
        const value = { resolveCurrentSession: () => undefined, resolveTargetSession: () => undefined };
        Object.defineProperty(value, "resolveCurrentSession", {
          get: () => { getterCalls += 1; return () => undefined; },
          enumerable: true,
        });
        return { ...valid, sessionResolution: value };
      })(),
      (() => {
        const value = { readState: () => undefined };
        Object.defineProperty(value, "readState", {
          get: () => { getterCalls += 1; return () => undefined; },
          enumerable: true,
        });
        return { ...valid, store: value };
      })(),
      (() => {
        const value = { acquireClaim: () => undefined };
        Object.defineProperty(value, "acquireClaim", {
          get: () => { getterCalls += 1; return () => undefined; },
          enumerable: true,
        });
        return { ...valid, claimLease: value };
      })(),
    ];
    for (const value of accessorCases) exactFailure(
      createPendingHandoffManualResumeService(value),
      "manual_resume_dependency_invalid",
    );
    assert.equal(getterCalls, 0);
  });
});

await group("input boundary", async () => {
  const invalidInputs = [
    null,
    [],
    { ...request(), candidate_id: "" },
    { ...request(), expected_revision: -1 },
    { ...request(), expected_revision: 1.5 },
    { ...request(), current_runtime_id: INVALID_RUNTIME },
    { ...request(), claim_attempt_id: "not-an-attempt" },
    { ...request(), target_session_identity: SESSION_SOURCE },
    (() => { const value = request(); value[Symbol("extra")] = true; return value; })(),
    (() => { const value = request(); Object.defineProperty(value, "candidate_id", { get: () => "x", enumerable: true }); return value; })(),
    Object.assign(Object.create(null), request()),
    Object.assign(Object.create({ inherited: true }), request()),
  ];
  for (const value of invalidInputs) {
    await test(`rejects malformed input ${String(invalidInputs.indexOf(value) + 1)}`, async () => {
      const built = createService();
      exactFailure(await built.service.prepareManualResume(value), "manual_resume_input_invalid");
      assert.deepEqual(built.calls, []);
    });
  }
});

await group("pending happy path and source target binding", async () => {
  await test("orders read, current resolution, source target resolution, Claim, and action request", async () => {
    const built = createService();
    const result = await built.service.prepareManualResume(request());
    const value = exactSuccess(result);
    assertAction(value);
    assert.deepEqual(built.calls.map(([name]) => name), [
      "readState",
      "resolveCurrentSession",
      "resolveTargetSession",
      "acquireClaim",
    ]);
    assert.deepEqual(built.calls[1][1], { runtime_id: RUNTIME_A });
    assert.deepEqual(built.calls[2][1], {
      runtime_id: RUNTIME_A,
      session_identity: SESSION_SOURCE,
    });
    assert.deepEqual(built.calls[3][1], {
      candidate_id: request().candidate_id,
      expected_revision: 1,
      current_session_identity: SESSION_OWNER_A,
      claim_attempt_id: CLAIM_ATTEMPT_A,
    });
    assert.equal(Object.isFrozen(value.target), true);
  });
  await test("never accepts a caller target and derives target only from Candidate source", async () => {
    const targetCalls = [];
    const built = createService({
      target: requestValue => {
        targetCalls.push(requestValue);
        return resolutionSuccess(RUNTIME_A, SESSION_SOURCE);
      },
    });
    const result = await built.service.prepareManualResume({
      ...request(),
      target_session_identity: SESSION_OTHER,
    });
    exactFailure(result, "manual_resume_input_invalid");
    assert.deepEqual(targetCalls, []);
  });
  await test("rejects current and target success bindings that do not match the request", async () => {
    const currentMismatch = createService({
      current: resolutionSuccess(RUNTIME_B, SESSION_OWNER_A),
    });
    exactFailure(
      await currentMismatch.service.prepareManualResume(request()),
      "manual_resume_session_mismatch",
    );
    const targetMismatch = createService({
      target: resolutionSuccess(RUNTIME_A, SESSION_OTHER),
    });
    exactFailure(
      await targetMismatch.service.prepareManualResume(request()),
      "manual_resume_session_mismatch",
    );
    assert.equal(targetMismatch.calls.filter(([name]) => name === "acquireClaim").length, 0);
  });
  await test("does not call Identity Scope or runtime-specific paths", () => {
    assert.doesNotMatch(SOURCE, /identity-composition|compareIdentityScope|context-checkpoint/i);
    assert.doesNotMatch(SOURCE, /codex|claude|child_process|native_session|raw_session_id/i);
  });
});

await group("lifecycle eligibility", async () => {
  const cases = [
    ["candidate", state({ candidate: candidate({ status: "candidate" }) }), "manual_resume_state_not_resumable"],
    ["delivered", state({ candidate: candidate({ status: "delivered" }), claim: claim(), delivery: confirmedDelivery() }), "manual_resume_state_not_resumable"],
    ["consumed", state({ candidate: candidate({ status: "consumed" }), claim: claim(), delivery: consumedDelivery() }), "manual_resume_state_not_resumable"],
    ["expired", state({ candidate: candidate({ status: "expired" }) }), "manual_resume_state_not_resumable"],
    ["invalid", state({ candidate: candidate({ status: "invalid" }) }), "manual_resume_state_not_resumable"],
    ["active delivery attempt", state({ candidate: candidate({ status: "claimed" }), state_revision: 2, claim: claim(), delivery: delivery() }), "manual_resume_state_not_resumable"],
  ];
  for (const [label, persisted, reason] of cases) {
    await test(`rejects ${label} without resolution or Claim`, async () => {
      const built = createService({ readState: success(persisted) });
      exactFailure(await built.service.prepareManualResume(request({ expected_revision: persisted.state_revision })), reason);
      assert.deepEqual(built.calls.map(([name]) => name), ["readState"]);
    });
  }
  await test("rejects pending revision drift before any observation", async () => {
    const built = createService({ readState: success(state({ state_revision: 2 })) });
    exactFailure(await built.service.prepareManualResume(request({ expected_revision: 1 })), "manual_resume_revision_conflict");
    assert.deepEqual(built.calls.map(([name]) => name), ["readState"]);
  });
  await test("rejects malformed persisted source runtime without normalization", async () => {
    const built = createService({ readState: success(state({ candidate: candidate({ source_runtime: INVALID_RUNTIME }) })) });
    exactFailure(await built.service.prepareManualResume(request()), "manual_resume_persisted_state_invalid");
    assert.deepEqual(built.calls.map(([name]) => name), ["readState"]);
  });
  await test("separates Store not-found, malformed, and unknown failures", async () => {
    const cases = [
      ["record_not_found", "manual_resume_record_not_found"],
      ["record_malformed", "manual_resume_persisted_state_invalid"],
      ["record_read_failed", "manual_resume_action_request_unavailable"],
      [PRIVATE_MARKER, "manual_resume_action_request_unavailable"],
    ];
    for (const [downstream, expected] of cases) {
      const built = createService({ readState: failure(downstream) });
      const result = await built.service.prepareManualResume(request());
      exactFailure(result, expected);
      assertNoLeak(result);
      assert.deepEqual(built.calls.map(([name]) => name), ["readState"]);
    }
  });
});

await group("same-session, ownership, and replay", async () => {
  await test("preserves Claim invariant when current Session equals source Session", async () => {
    const built = createService({
      current: resolutionSuccess(RUNTIME_A, SESSION_SOURCE),
      claimResult: failure("claim_owner_invalid"),
    });
    exactFailure(await built.service.prepareManualResume(request()), "manual_resume_session_mismatch");
    assert.deepEqual(built.calls.map(([name]) => name), [
      "readState",
      "resolveCurrentSession",
      "resolveTargetSession",
      "acquireClaim",
    ]);
  });
  await test("rejects the wrong owner with the correct claim attempt", async () => {
    const persisted = state({
      state_revision: 2,
      candidate: candidate({ status: "claimed" }),
      claim: claim(SESSION_OTHER, CLAIM_ATTEMPT_A),
    });
    const built = createService({
      readState: success(persisted),
      claimResult: claimSuccess(2, CLAIM_ATTEMPT_A),
    });
    exactFailure(
      await built.service.prepareManualResume(request({ expected_revision: 1 })),
      "manual_resume_ownership_conflict",
    );
    assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
  });
  await test("rejects the correct owner with the wrong claim attempt", async () => {
    const persisted = state({
      state_revision: 2,
      candidate: candidate({ status: "claimed" }),
      claim: claim(SESSION_OWNER_A, CLAIM_ATTEMPT_A),
    });
    const built = createService({
      readState: success(persisted),
      claimResult: claimSuccess(2, CLAIM_ATTEMPT_B),
    });
    exactFailure(
      await built.service.prepareManualResume(request({
        expected_revision: 1,
        claim_attempt_id: CLAIM_ATTEMPT_B,
      })),
      "manual_resume_ownership_conflict",
    );
    assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
  });
  const persistedReplay = state({
    state_revision: 2,
    candidate: candidate({ status: "claimed" }),
    claim: claim(SESSION_OWNER_A, CLAIM_ATTEMPT_A),
  });
  for (const [label, expectedRevision] of [
    ["unrelated older", 0],
    ["current claimed", persistedReplay.state_revision],
    ["future", persistedReplay.state_revision + 1],
  ]) {
    await test(`rejects ${label} expected revision for claimed replay`, async () => {
      const built = createService({
        readState: success(persistedReplay),
        claimResult: claimSuccess(persistedReplay.state_revision, CLAIM_ATTEMPT_A),
      });
      exactFailure(
        await built.service.prepareManualResume(request({ expected_revision: expectedRevision })),
        "manual_resume_revision_conflict",
      );
      assert.deepEqual(built.calls.map(([name]) => name), ["readState"]);
    });
  }
  await test("accepts only the original expected revision for claimed replay", async () => {
    const built = createService({
      readState: success(persistedReplay),
      claimResult: claimSuccess(persistedReplay.state_revision, CLAIM_ATTEMPT_A),
    });
    const first = exactSuccess(await built.service.prepareManualResume(request({ expected_revision: 1 })));
    assertAction(first, { stateRevision: 2 });
    assert.deepEqual(built.calls.map(([name]) => name), [
      "readState",
      "resolveCurrentSession",
      "resolveTargetSession",
      "acquireClaim",
    ]);
  });
  await test("replays the same pending logical request without changing action fields", async () => {
    let publications = 0;
    let readCount = 0;
    const built = createService({
      readState: () => {
        readCount += 1;
        return success(readCount === 1
          ? state()
          : state({
            state_revision: 2,
            candidate: candidate({ status: "claimed" }),
            claim: claim(SESSION_OWNER_A, CLAIM_ATTEMPT_A),
          }));
      },
      claimResult: value => {
        if (value.expected_revision === 1 && readCount === 1) publications += 1;
        return claimSuccess();
      },
    });
    const first = exactSuccess(await built.service.prepareManualResume(request()));
    const second = exactSuccess(await built.service.prepareManualResume(request()));
    assert.deepEqual(second, first);
    assert.equal(publications, 1);
    assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 2);
  });
  await test("does not auto-recover an expired Claim", async () => {
    const persisted = state({
      state_revision: 2,
      candidate: candidate({ status: "claimed" }),
      claim: claim(SESSION_OWNER_A, CLAIM_ATTEMPT_A),
    });
    const built = createService({
      readState: success(persisted),
      claimResult: failure("claim_lease_expired"),
    });
    exactFailure(await built.service.prepareManualResume(request({ expected_revision: 1 })), "manual_resume_state_not_resumable");
    assert.doesNotMatch(SOURCE, /recoverClaimLease/);
  });
});

await group("resolution and Claim failure provenance", async () => {
  const currentFailures = [
    ["runtime_unsupported", "manual_resume_runtime_unsupported"],
    ["denied", "manual_resume_denied"],
    ["not_found", "manual_resume_current_session_unavailable"],
    ["ambiguous", "manual_resume_current_session_unavailable"],
    ["stale", "manual_resume_current_session_unavailable"],
    ["unavailable", "manual_resume_current_session_unavailable"],
    ["runtime_mismatch", "manual_resume_session_mismatch"],
    ["identity_mismatch", "manual_resume_session_mismatch"],
    ["result_invalid", "manual_resume_action_request_unavailable"],
  ];
  for (const [downstream, expected] of currentFailures) {
    await test(`normalizes current ${downstream}`, async () => {
      const built = createService({ current: resolutionFailure(downstream) });
      exactFailure(await built.service.prepareManualResume(request()), expected);
      assert.equal(built.calls.filter(([name]) => name === "resolveTargetSession").length, 0);
      assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
    });
  }
  await test("awaits a current resolver Promise before target and Claim", async () => {
    const built = createService({ current: Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_OWNER_A)) });
    assertAction(exactSuccess(await built.service.prepareManualResume(request())));
    assert.deepEqual(built.calls.map(([name]) => name), [
      "readState",
      "resolveCurrentSession",
      "resolveTargetSession",
      "acquireClaim",
    ]);
  });
  const targetFailures = [
    ["not_found", "manual_resume_target_not_found"],
    ["ambiguous", "manual_resume_target_ambiguous"],
    ["stale", "manual_resume_target_stale"],
    ["runtime_unsupported", "manual_resume_runtime_unsupported"],
    ["denied", "manual_resume_denied"],
    ["unavailable", "manual_resume_action_request_unavailable"],
    ["runtime_mismatch", "manual_resume_session_mismatch"],
    ["identity_mismatch", "manual_resume_session_mismatch"],
    ["result_invalid", "manual_resume_action_request_unavailable"],
  ];
  for (const [downstream, expected] of targetFailures) {
    await test(`normalizes target ${downstream}`, async () => {
      const built = createService({ target: resolutionFailure(downstream) });
      exactFailure(await built.service.prepareManualResume(request()), expected);
      assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
    });
  }
  await test("awaits a target resolver Promise before acquiring Claim", async () => {
    const built = createService({ target: Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_SOURCE)) });
    assertAction(exactSuccess(await built.service.prepareManualResume(request())));
    assert.deepEqual(built.calls.map(([name]) => name), [
      "readState",
      "resolveCurrentSession",
      "resolveTargetSession",
      "acquireClaim",
    ]);
  });
  await test("normalizes Claim provenance without passing raw reasons", async () => {
    const mappings = [
      ["claim_conflict", "manual_resume_revision_conflict"],
      ["claim_lease_expired", "manual_resume_state_not_resumable"],
      ["claim_owner_invalid", "manual_resume_session_mismatch"],
      ["claim_attempt_invalid", "manual_resume_action_request_unavailable"],
      ["claim_state_invalid", "manual_resume_persisted_state_invalid"],
      ["claim_read_failed", "manual_resume_action_request_unavailable"],
      ["claim_publish_failed", "manual_resume_action_request_unavailable"],
      ["unexpected-private-reason", "manual_resume_action_request_unavailable"],
    ];
    for (const [downstream, expected] of mappings) {
      const built = createService({ claimResult: failure(downstream) });
      exactFailure(await built.service.prepareManualResume(request()), expected);
      assert.equal(PENDING_HANDOFF_MANUAL_RESUME_FAILURES.includes(downstream), false);
    }
  });
});

await group("privacy and no mutation boundaries", async () => {
  await test("sanitizes Store exceptions and emits no output", async () => {
    const built = createService({
      readState: async () => { throw new Error(`${EXCEPTION_MARKER} ${NATIVE_PATH} ${NATIVE_TOKEN}`); },
    });
    const captured = await captureOutput(() => built.service.prepareManualResume(request()));
    exactFailure(captured.value, "manual_resume_action_request_unavailable");
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
    assertNoLeak(captured.value);
  });
  await test("sanitizes Session and Claim exceptions", async () => {
    const currentThrowing = createService({
      current: () => { throw new Error(`${EXCEPTION_MARKER} ${NATIVE_ID} ${NATIVE_TOKEN}`); },
    });
    const targetThrowing = createService({
      target: () => { throw new Error(`${EXCEPTION_MARKER} ${NATIVE_PATH}`); },
    });
    const claimThrowing = createService({
      claimResult: async () => { throw new Error(`${EXCEPTION_MARKER} ${NATIVE_TOKEN}`); },
    });
    for (const [built, reason] of [
      [currentThrowing, "manual_resume_current_session_unavailable"],
      [targetThrowing, "manual_resume_action_request_unavailable"],
      [claimThrowing, "manual_resume_action_request_unavailable"],
    ]) {
      const captured = await captureOutput(() => built.service.prepareManualResume(request()));
      exactFailure(captured.value, reason);
      assert.equal(captured.stdout, "");
      assert.equal(captured.stderr, "");
      assertNoLeak(captured.value);
    }
  });
  await test("does not expose raw persisted fields or invoke unauthorized facades", async () => {
    const built = createService({
      readState: success(state({ candidate: candidate({ goal: PRIVATE_MARKER, next_action: NATIVE_PATH }) })),
      claimResult: failure("claim_publish_failed"),
    });
    const result = await built.service.prepareManualResume(request());
    exactFailure(result, "manual_resume_action_request_unavailable");
    assertNoLeak(result);
    assert.equal(built.calls.filter(([name]) => name === "readState").length, 1);
    assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 1);
    assert.doesNotMatch(SOURCE, /compareAndSet|beginDeliveryAttempt|confirmDelivery|consumeDelivered|releaseUnconfirmedDelivery/);
  });
});

await group("static boundary, concurrency, and Makefile", async () => {
  await test("has no runtime, persistence, registry, or scope-discovery imports", () => {
    assert.doesNotMatch(SOURCE, /from\s+["'](?:node:)?(?:fs|process|child_process|net|http)/);
    assert.doesNotMatch(SOURCE, /\b(?:fetch|exec|spawn|fork|console)\s*\(/);
    assert.doesNotMatch(SOURCE, /codex|claude|registry|context-checkpoint|compareIdentityScope/i);
    assert.doesNotMatch(SOURCE, /raw_session_id|native_session|process\.env|remote_url|worktree_path/);
  });
  await test("awaits both Session Resolution phases before Claim", () => {
    assert.match(SOURCE, /const currentResult = await resolveCurrentSession\(/);
    assert.match(SOURCE, /const targetResult = await resolveTargetSession\(/);
    assert.match(SOURCE, /import \{ types as utilTypes \} from "node:util";/);
    assert.equal((SOURCE.match(/if \(utilTypes\.isProxy\(raw\) \|\| !utilTypes\.isPromise\(raw\)\)/g) ?? []).length, 2);
    assert.equal((SOURCE.match(/result = await raw/g) ?? []).length, 2);
    assert.doesNotMatch(SOURCE, /await sessionResolution\.resolve(?:Current|Target)Session\(/);
    assert.doesNotMatch(SOURCE, /(?:raw|result)\.then/);
    assert.doesNotMatch(SOURCE, /Promise\.resolve\s*\(/);
  });
  await test("checks nested semantic success values before reflection", () => {
    assert.match(
      SOURCE,
      /if \(successResult\.ok && successResult\.values\.ok === true\) \{\s*if \(utilTypes\.isProxy\(successResult\.values\.value\)\) return \{ ok: false \};\s*return \{ ok: true, kind: "success", value: successResult\.values\.value \};/s,
    );
  });
  await test("keeps the service call-independent under concurrent requests", async () => {
    const candidateA = candidate({ candidate_id: "manual-resume-a", source_session_identity: SESSION_SOURCE });
    const candidateB = candidate({ candidate_id: "manual-resume-b", source_runtime: RUNTIME_B, source_session_identity: SESSION_OTHER });
    const calls = [];
    const dependencies = {
      store: {
        readState: async candidateId => {
          await new Promise(resolve => setTimeout(resolve, candidateId.endsWith("a") ? 5 : 1));
          return success(state({ candidate: candidateId.endsWith("a") ? candidateA : candidateB }));
        },
      },
      sessionResolution: {
        resolveCurrentSession: ({ runtime_id }) => {
          calls.push(["current", runtime_id]);
          return Promise.resolve(resolutionSuccess(
            runtime_id,
            runtime_id === RUNTIME_A ? SESSION_OWNER_A : SESSION_OWNER_B,
          ));
        },
        resolveTargetSession: value => {
          calls.push(["target", value]);
          return Promise.resolve(resolutionSuccess(value.runtime_id, value.session_identity));
        },
      },
      claimLease: {
        acquireClaim: async value => {
          calls.push(["claim", value]);
          return claimSuccess(2, value.claim_attempt_id);
        },
      },
    };
    const service = exactSuccess(createPendingHandoffManualResumeService(dependencies));
    const [first, second] = await Promise.all([
      service.prepareManualResume(request({ candidate_id: "manual-resume-a" })),
      service.prepareManualResume(request({ candidate_id: "manual-resume-b", current_runtime_id: RUNTIME_B })),
    ]);
    const firstValue = exactSuccess(first);
    const secondValue = exactSuccess(second);
    assertAction(firstValue, { candidateId: "manual-resume-a", targetRuntime: RUNTIME_A, targetIdentity: SESSION_SOURCE });
    assertAction(secondValue, { candidateId: "manual-resume-b", targetRuntime: RUNTIME_B, targetIdentity: SESSION_OTHER, owner: SESSION_OWNER_B });
    assert.equal(calls.filter(([name]) => name === "claim").length, 2);
  });
  await test("wires the dedicated fixture after Session Resolution", () => {
    assert.match(MAKEFILE_SOURCE, /^test-pending-handoff-manual-resume-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-manual-resume-fixtures\.mjs$/m);
    const declaration = MAKEFILE_SOURCE.match(/^test-v1x-fixtures:[\s\S]*?(?=\n\ninstall:)/m)?.[0] ?? "";
    assert.match(declaration, /test-pending-handoff-session-resolution-fixtures/);
    assert.match(declaration, /test-pending-handoff-manual-resume-fixtures/);
    assert.match(declaration, /test-pending-handoff-codex-runtime-adapter-fixtures/);
    assert.match(declaration, /test-pending-handoff-claude-runtime-adapter-fixtures/);
    assert.match(declaration, /test-pending-handoff-manual-resume-runtime-composition-fixtures/);
    assert.ok(declaration.indexOf("test-pending-handoff-session-resolution-fixtures") < declaration.indexOf("test-pending-handoff-manual-resume-fixtures"));
    assert.ok(declaration.indexOf("test-pending-handoff-manual-resume-fixtures") < declaration.indexOf("test-pending-handoff-codex-runtime-adapter-fixtures"));
    assert.ok(declaration.indexOf("test-pending-handoff-codex-runtime-adapter-fixtures") < declaration.indexOf("test-pending-handoff-claude-runtime-adapter-fixtures"));
  });
});

await group("async Session Resolution compatibility", async () => {
  await test("awaits async current and target resolution before Claim", async () => {
    const built = createService({
      current: async () => {
        await Promise.resolve();
        return resolutionSuccess(RUNTIME_A, SESSION_OWNER_A);
      },
      target: async () => {
        await Promise.resolve();
        return resolutionSuccess(RUNTIME_A, SESSION_SOURCE);
      },
    });
    const result = await built.service.prepareManualResume(request());
    const value = exactSuccess(result);
    assertAction(value);
    assert.deepEqual(built.calls.map(([name]) => name), [
      "readState",
      "resolveCurrentSession",
      "resolveTargetSession",
      "acquireClaim",
    ]);
  });

  await test("does not call target or Claim after async current failure", async () => {
    const built = createService({
      current: async () => {
        await Promise.resolve();
        return resolutionFailure("unavailable");
      },
      target: async () => resolutionSuccess(RUNTIME_A, SESSION_SOURCE),
    });
    exactFailure(
      await built.service.prepareManualResume(request()),
      "manual_resume_current_session_unavailable",
    );
    assert.equal(built.calls.filter(([name]) => name === "resolveTargetSession").length, 0);
    assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
  });

  await test("fails closed when async target rejects without Claim", async () => {
    const built = createService({
      current: async () => resolutionSuccess(RUNTIME_A, SESSION_OWNER_A),
      target: async () => {
        throw new Error(`${EXCEPTION_MARKER} ${NATIVE_ID} ${NATIVE_TOKEN}`);
      },
    });
    const captured = await captureOutput(() => built.service.prepareManualResume(request()));
    exactFailure(captured.value, "manual_resume_action_request_unavailable");
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
    assertNoLeak(captured.value);
    assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
  });

  await test("rejects unbranded current resolution values before assimilation", async () => {
    function makeHostile(kind) {
      let getterCalls = 0;
      let thenCalls = 0;
      let trapCalls = 0;
      const mark = () => {
        process.stdout.write(`${EXCEPTION_MARKER}-thenable-stdout`);
        process.stderr.write(`${EXCEPTION_MARKER}-thenable-stderr`);
      };
      const invoke = resolve => {
        thenCalls += 1;
        mark();
        resolve(resolutionSuccess(RUNTIME_A, SESSION_OWNER_A));
      };
      if (kind === "thenable") {
        const value = {};
        Object.defineProperty(value, "then", {
          value: invoke,
          enumerable: true,
        });
        return { value, counts: () => ({ getterCalls, thenCalls, trapCalls }) };
      }
      if (kind === "getter") {
        const value = {};
        Object.defineProperty(value, "then", {
          get() {
            getterCalls += 1;
            mark();
            return invoke;
          },
          enumerable: true,
        });
        return { value, counts: () => ({ getterCalls, thenCalls, trapCalls }) };
      }
      if (kind === "proxy-then") {
        const value = new Proxy({}, {
          get(target, property, receiver) {
            trapCalls += 1;
            if (property === "then") return invoke;
            return Reflect.get(target, property, receiver);
          },
        });
        return { value, counts: () => ({ getterCalls, thenCalls, trapCalls }) };
      }
      const promise = Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_OWNER_A));
      const value = new Proxy(promise, {
        get(target, property) {
          trapCalls += 1;
          if (property === "then") {
            thenCalls += 1;
            mark();
            return target.then.bind(target);
          }
          return Reflect.get(target, property, target);
        },
      });
      return { value, counts: () => ({ getterCalls, thenCalls, trapCalls }) };
    }

    const plain = createService({
      sessionResolution: {
        resolveCurrentSession: () => resolutionSuccess(RUNTIME_A, SESSION_OWNER_A),
        resolveTargetSession: () => Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_SOURCE)),
      },
    });
    exactFailure(
      await plain.service.prepareManualResume(request()),
      "manual_resume_current_session_unavailable",
    );
    assert.equal(plain.calls.filter(([name]) => name === "acquireClaim").length, 0);

    for (const kind of ["thenable", "getter", "proxy-then", "proxy-promise"]) {
      const probe = makeHostile(kind);
      let targetCalls = 0;
      const built = createService({
        sessionResolution: {
          resolveCurrentSession: () => probe.value,
          resolveTargetSession: () => {
            targetCalls += 1;
            return Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_SOURCE));
          },
        },
      });
      const captured = await captureOutput(() => built.service.prepareManualResume(request()));
      exactFailure(captured.value, "manual_resume_current_session_unavailable");
      assert.deepEqual(probe.counts(), { getterCalls: 0, thenCalls: 0, trapCalls: 0 });
      assert.equal(targetCalls, 0);
      assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
      assert.equal(captured.stdout, "");
      assert.equal(captured.stderr, "");
      assertNoLeak(captured.value);
    }
  });

  await test("rejects unbranded target resolution values before assimilation", async () => {
    function makeHostile(kind) {
      let getterCalls = 0;
      let thenCalls = 0;
      let trapCalls = 0;
      const mark = () => {
        process.stdout.write(`${EXCEPTION_MARKER}-target-stdout`);
        process.stderr.write(`${EXCEPTION_MARKER}-target-stderr`);
      };
      const invoke = resolve => {
        thenCalls += 1;
        mark();
        resolve(resolutionSuccess(RUNTIME_A, SESSION_SOURCE));
      };
      if (kind === "thenable") {
        const value = {};
        Object.defineProperty(value, "then", { value: invoke, enumerable: true });
        return { value, counts: () => ({ getterCalls, thenCalls, trapCalls }) };
      }
      if (kind === "getter") {
        const value = {};
        Object.defineProperty(value, "then", {
          get() {
            getterCalls += 1;
            mark();
            return invoke;
          },
          enumerable: true,
        });
        return { value, counts: () => ({ getterCalls, thenCalls, trapCalls }) };
      }
      if (kind === "proxy-then") {
        const value = new Proxy({}, {
          get(target, property, receiver) {
            trapCalls += 1;
            if (property === "then") return invoke;
            return Reflect.get(target, property, receiver);
          },
        });
        return { value, counts: () => ({ getterCalls, thenCalls, trapCalls }) };
      }
      const promise = Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_SOURCE));
      const value = new Proxy(promise, {
        get(target, property) {
          trapCalls += 1;
          if (property === "then") {
            thenCalls += 1;
            mark();
            return target.then.bind(target);
          }
          return Reflect.get(target, property, target);
        },
      });
      return { value, counts: () => ({ getterCalls, thenCalls, trapCalls }) };
    }

    const plain = createService({
      sessionResolution: {
        resolveCurrentSession: () => Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_OWNER_A)),
        resolveTargetSession: () => resolutionSuccess(RUNTIME_A, SESSION_SOURCE),
      },
    });
    exactFailure(
      await plain.service.prepareManualResume(request()),
      "manual_resume_action_request_unavailable",
    );
    assert.equal(plain.calls.filter(([name]) => name === "acquireClaim").length, 0);

    for (const kind of ["thenable", "getter", "proxy-then", "proxy-promise"]) {
      const probe = makeHostile(kind);
      let claimCalls = 0;
      const built = createService({
        sessionResolution: {
          resolveCurrentSession: () => Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_OWNER_A)),
          resolveTargetSession: () => probe.value,
        },
        claimLease: {
          acquireClaim: async () => {
            claimCalls += 1;
            return claimSuccess();
          },
        },
      });
      const captured = await captureOutput(() => built.service.prepareManualResume(request()));
      exactFailure(captured.value, "manual_resume_action_request_unavailable");
      assert.deepEqual(probe.counts(), { getterCalls: 0, thenCalls: 0, trapCalls: 0 });
      assert.equal(claimCalls, 0);
      assert.equal(captured.stdout, "");
      assert.equal(captured.stderr, "");
      assertNoLeak(captured.value);
    }
  });

  await test("rejects current nested semantic Proxies before reflection", async () => {
    const makeProxy = makeNestedSemanticProxy(SESSION_OWNER_A);
    for (const kind of ["get", "ownKeys", "descriptor", "prototype"]) {
      const probe = makeProxy(kind);
      let targetCalls = 0;
      let claimCalls = 0;
      const built = createService({
        sessionResolution: {
          resolveCurrentSession: () => Promise.resolve(nestedResolutionSuccess(probe.value)),
          resolveTargetSession: () => {
            targetCalls += 1;
            return Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_SOURCE));
          },
        },
        claimLease: {
          acquireClaim: async () => {
            claimCalls += 1;
            return claimSuccess();
          },
        },
      });
      const captured = await captureOutput(() => built.service.prepareManualResume(request()));
      exactFailure(captured.value, "manual_resume_action_request_unavailable");
      assert.deepEqual(probe.counts(), { trapCalls: 0, thenCalls: 0 });
      assert.equal(targetCalls, 0);
      assert.equal(claimCalls, 0);
      assert.equal(captured.stdout, "");
      assert.equal(captured.stderr, "");
      assertNoLeak(captured.value, [NESTED_PROXY_MARKER]);
    }
  });

  await test("rejects target nested semantic Proxies before reflection", async () => {
    const makeProxy = makeNestedSemanticProxy(SESSION_SOURCE);
    for (const kind of ["get", "ownKeys", "descriptor", "prototype"]) {
      const probe = makeProxy(kind);
      let claimCalls = 0;
      const built = createService({
        sessionResolution: {
          resolveCurrentSession: () => Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_OWNER_A)),
          resolveTargetSession: () => Promise.resolve(nestedResolutionSuccess(probe.value)),
        },
        claimLease: {
          acquireClaim: async () => {
            claimCalls += 1;
            return claimSuccess();
          },
        },
      });
      const captured = await captureOutput(() => built.service.prepareManualResume(request()));
      exactFailure(captured.value, "manual_resume_action_request_unavailable");
      assert.deepEqual(probe.counts(), { trapCalls: 0, thenCalls: 0 });
      assert.equal(claimCalls, 0);
      assert.equal(captured.stdout, "");
      assert.equal(captured.stderr, "");
      assertNoLeak(captured.value, [NESTED_PROXY_MARKER]);
    }
  });

  await test("preserves plain nested semantic success and accessor privacy", async () => {
    const plain = createService({
      sessionResolution: {
        resolveCurrentSession: () => Promise.resolve(nestedResolutionSuccess({
          runtime_id: RUNTIME_A,
          session_identity: SESSION_OWNER_A,
        })),
        resolveTargetSession: () => Promise.resolve(nestedResolutionSuccess({
          runtime_id: RUNTIME_A,
          session_identity: SESSION_SOURCE,
        })),
      },
    });
    assertAction(exactSuccess(await plain.service.prepareManualResume(request())));

    let getterCalls = 0;
    const currentAccessor = {};
    Object.defineProperty(currentAccessor, "runtime_id", {
      get() {
        getterCalls += 1;
        process.stdout.write(`${NESTED_PROXY_MARKER}-stdout`);
        process.stderr.write(`${NESTED_PROXY_MARKER}-stderr`);
        throw new Error(NESTED_PROXY_MARKER);
      },
      enumerable: true,
    });
    Object.defineProperty(currentAccessor, "session_identity", {
      value: SESSION_OWNER_A,
      enumerable: true,
    });
    const currentAccessorService = createService({
      sessionResolution: {
        resolveCurrentSession: () => Promise.resolve(nestedResolutionSuccess(currentAccessor)),
        resolveTargetSession: () => Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_SOURCE)),
      },
    });
    const currentCaptured = await captureOutput(
      () => currentAccessorService.service.prepareManualResume(request()),
    );
    exactFailure(currentCaptured.value, "manual_resume_session_mismatch");
    assert.equal(getterCalls, 0);
    assert.equal(currentAccessorService.calls.filter(([name]) => name === "acquireClaim").length, 0);
    assert.equal(currentCaptured.stdout, "");
    assert.equal(currentCaptured.stderr, "");
    assertNoLeak(currentCaptured.value, [NESTED_PROXY_MARKER]);

    let targetGetterCalls = 0;
    const targetAccessor = {};
    Object.defineProperty(targetAccessor, "runtime_id", {
      value: RUNTIME_A,
      enumerable: true,
    });
    Object.defineProperty(targetAccessor, "session_identity", {
      get() {
        targetGetterCalls += 1;
        process.stdout.write(`${NESTED_PROXY_MARKER}-target-stdout`);
        process.stderr.write(`${NESTED_PROXY_MARKER}-target-stderr`);
        throw new Error(NESTED_PROXY_MARKER);
      },
      enumerable: true,
    });
    const targetAccessorService = createService({
      sessionResolution: {
        resolveCurrentSession: () => Promise.resolve(resolutionSuccess(RUNTIME_A, SESSION_OWNER_A)),
        resolveTargetSession: () => Promise.resolve(nestedResolutionSuccess(targetAccessor)),
      },
    });
    const targetCaptured = await captureOutput(
      () => targetAccessorService.service.prepareManualResume(request()),
    );
    exactFailure(targetCaptured.value, "manual_resume_session_mismatch");
    assert.equal(targetGetterCalls, 0);
    assert.equal(targetAccessorService.calls.filter(([name]) => name === "acquireClaim").length, 0);
    assert.equal(targetCaptured.stdout, "");
    assert.equal(targetCaptured.stderr, "");
    assertNoLeak(targetCaptured.value, [NESTED_PROXY_MARKER]);
  });

  await test("keeps delayed concurrent Manual Resume requests isolated", async () => {
    const candidateA = candidate({ candidate_id: "manual-resume-async-a" });
    const candidateB = candidate({
      candidate_id: "manual-resume-async-b",
      source_runtime: RUNTIME_B,
      source_session_identity: SESSION_OTHER,
    });
    const calls = [];
    const delay = value => new Promise(resolve => setTimeout(resolve, value));
    const service = exactSuccess(createPendingHandoffManualResumeService({
      store: {
        readState: async candidateId => {
          await delay(candidateId.endsWith("a") ? 5 : 0);
          return success(state({ candidate: candidateId.endsWith("a") ? candidateA : candidateB }));
        },
      },
      sessionResolution: {
        resolveCurrentSession: async ({ runtime_id }) => {
          await delay(runtime_id === RUNTIME_A ? 5 : 0);
          calls.push(["current", runtime_id]);
          return resolutionSuccess(
            runtime_id,
            runtime_id === RUNTIME_A ? SESSION_OWNER_A : SESSION_OWNER_B,
          );
        },
        resolveTargetSession: async value => {
          await delay(value.runtime_id === RUNTIME_A ? 5 : 0);
          calls.push(["target", value]);
          return resolutionSuccess(value.runtime_id, value.session_identity);
        },
      },
      claimLease: {
        acquireClaim: async value => {
          await delay(value.candidate_id.endsWith("a") ? 5 : 0);
          calls.push(["claim", value]);
          return claimSuccess(2, value.claim_attempt_id);
        },
      },
    }));

    const [first, second] = await Promise.all([
      service.prepareManualResume(request({ candidate_id: candidateA.candidate_id })),
      service.prepareManualResume(request({
        candidate_id: candidateB.candidate_id,
        current_runtime_id: RUNTIME_B,
      })),
    ]);
    assertAction(exactSuccess(first), {
      candidateId: candidateA.candidate_id,
      targetRuntime: RUNTIME_A,
      targetIdentity: SESSION_SOURCE,
    });
    assertAction(exactSuccess(second), {
      candidateId: candidateB.candidate_id,
      targetRuntime: RUNTIME_B,
      targetIdentity: SESSION_OTHER,
      owner: SESSION_OWNER_B,
    });
    assert.equal(calls.filter(([name]) => name === "claim").length, 2);
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS\n`);
