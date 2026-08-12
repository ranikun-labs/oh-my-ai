import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as moduleNamespace from "./lib/pending-handoff-session-resolution.mjs";
import {
  PENDING_HANDOFF_SESSION_RESOLUTION_FAILURES,
  createPendingHandoffSessionResolutionPort,
} from "./lib/pending-handoff-session-resolution.mjs";
import {
  PENDING_HANDOFF_SCHEMA_VERSION,
  validateCandidate,
} from "./lib/pending-handoff-core.mjs";

const MODULE_PATH = fileURLToPath(new URL("./lib/pending-handoff-session-resolution.mjs", import.meta.url));
const MAKEFILE_SOURCE = fs.readFileSync(new URL("../Makefile", import.meta.url), "utf8");
const SOURCE = fs.readFileSync(MODULE_PATH, "utf8");

const RUNTIME_A = "codex";
const RUNTIME_B = "claude";
const INVALID_RUNTIME = "Codex";
const SESSION_A = `phr1.session.key_A-1.${"A".repeat(43)}`;
const SESSION_B = `phr1.session.key_A-1.${"B".repeat(43)}`;
const REPOSITORY_IDENTITY = `phr1.repository.key_A-1.${"R".repeat(43)}`;
const WORKTREE_IDENTITY = `phr1.worktree.key_A-1.${"W".repeat(43)}`;
const NATIVE_SESSION_ID = "native-session-id-must-not-escape";
const NATIVE_PATH = "/private/native/runtime/session/location";
const NATIVE_TOKEN = "token_like_native_secret_value";
const EXCEPTION_MARKER = "session-resolution-native-exception";
const PROMPT_MARKER = "private prompt and transcript marker";

let groups = 0;
let tests = 0;

function assertFactorySuccess(result) {
  assertExactSuccess(result);
  assert.equal(Object.isFrozen(result.value), true);
  return result.value;
}

function assertExactSuccess(result) {
  assert.equal(result?.ok, true, `expected success, got ${result?.reason}`);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "value"]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.hasOwn(result, "reason"), false);
  return result.value;
}

function assertPublicSuccess(result, expectedRuntime, expectedIdentity) {
  const value = assertExactSuccess(result);
  assert.deepEqual(Reflect.ownKeys(value), ["runtime_id", "session_identity"]);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(value.runtime_id, expectedRuntime);
  assert.equal(value.session_identity, expectedIdentity);
  return value;
}

function assertFailure(result, reason) {
  assert.equal(result?.ok, false, "expected semantic failure");
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.reason, reason);
  assert.equal(PENDING_HANDOFF_SESSION_RESOLUTION_FAILURES.includes(reason), true);
  assert.equal(Object.hasOwn(result, "value"), false);
  return result;
}

function assertFactoryFailure(result, reason = "session_resolution_dependency_invalid") {
  return assertFailure(result, reason);
}

function rawSuccess(runtimeId = RUNTIME_A, sessionIdentity = SESSION_A) {
  return { runtime_id: runtimeId, session_identity: sessionIdentity };
}

function rawFailure(reason, overrides = {}) {
  return { ok: false, reason, ...overrides };
}

function createPort(overrides = {}) {
  return assertFactorySuccess(createPendingHandoffSessionResolutionPort({
    resolveCurrentSession: () => rawSuccess(),
    resolveTargetSession: () => rawSuccess(),
    ...overrides,
  }));
}

function assertNoLeak(value, markers = [
  NATIVE_SESSION_ID,
  NATIVE_PATH,
  NATIVE_TOKEN,
  EXCEPTION_MARKER,
  PROMPT_MARKER,
]) {
  const serialized = `${safeString(value)} ${safeJson(value)}`;
  for (const marker of markers) assert.equal(serialized.includes(marker), false, marker);
}

function safeString(value) {
  try {
    return String(value);
  } catch {
    return "";
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function captureOutput(operation) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = chunk => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = chunk => {
    stderr += String(chunk);
    return true;
  };
  try {
    return { value: operation(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

function cloneWithPrototype(value, prototype) {
  return Object.assign(Object.create(prototype), value);
}

function makeCandidate() {
  return {
    candidate_id: "session-resolution-candidate",
    schema_version: PENDING_HANDOFF_SCHEMA_VERSION,
    status: "candidate",
    created_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T01:00:00.000Z",
    source_runtime: RUNTIME_A,
    source_session_identity: SESSION_A,
    repository_identity: REPOSITORY_IDENTITY,
    worktree_identity: WORKTREE_IDENTITY,
    goal: "Resolve a runtime-neutral session without exposing native state.",
    completed: [],
    open_issues: [],
    verification: [],
    do_not_touch: ["Native runtime identifiers"],
    next_action: "Review the session resolution port.",
    context_checkpoint_status: "review_needed",
    privacy_redaction_status: "passed",
  };
}

function group(name, operation) {
  operation();
  groups += 1;
  process.stdout.write(`PASS GROUP ${groups} ${name}\n`);
}

function test(name, operation) {
  operation();
  tests += 1;
  process.stdout.write(`PASS ${name}\n`);
}

group("API oracle", () => {
  test("exports exactly the public module surface including ESM metadata", () => {
    assert.deepEqual(Reflect.ownKeys(moduleNamespace), [
      "PENDING_HANDOFF_SESSION_RESOLUTION_FAILURES",
      "createPendingHandoffSessionResolutionPort",
      Symbol.toStringTag,
    ]);
  });

  test("freezes the exact failure taxonomy", () => {
    assert.deepEqual(PENDING_HANDOFF_SESSION_RESOLUTION_FAILURES, [
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
    assert.equal(Object.isFrozen(PENDING_HANDOFF_SESSION_RESOLUTION_FAILURES), true);
    assert.throws(() => PENDING_HANDOFF_SESSION_RESOLUTION_FAILURES.push("native"));
  });

  test("freezes the facade without hidden capabilities", () => {
    const port = createPort();
    assert.deepEqual(Reflect.ownKeys(port), ["resolveCurrentSession", "resolveTargetSession"]);
    assert.deepEqual(Object.keys(port), ["resolveCurrentSession", "resolveTargetSession"]);
    assert.equal(Object.getPrototypeOf(port), Object.prototype);
    assert.equal(Object.isFrozen(port), true);
    for (const key of Reflect.ownKeys(port)) {
      const descriptor = Object.getOwnPropertyDescriptor(port, key);
      assert.equal(descriptor.enumerable, true);
      assert.equal(Object.hasOwn(descriptor, "value"), true);
      assert.equal(typeof descriptor.value, "function");
    }
  });
});

group("Dependency boundary", () => {
  test("rejects malformed dependency records and never invokes accessors", () => {
    const valid = {
      resolveCurrentSession: () => rawSuccess(),
      resolveTargetSession: () => rawSuccess(),
    };
    for (const value of [null, [], Object.create(null), Object.create({})]) {
      assertFactoryFailure(createPendingHandoffSessionResolutionPort(value));
    }
    for (const options of [
      {},
      { resolveCurrentSession: "not-callable", resolveTargetSession: valid.resolveTargetSession },
      { resolveCurrentSession: valid.resolveCurrentSession, resolveTargetSession: 42 },
      { ...valid, unexpected: true },
    ]) {
      assertFactoryFailure(createPendingHandoffSessionResolutionPort(options));
    }

    const symbolOptions = { ...valid, [Symbol("native")]: NATIVE_SESSION_ID };
    assertFactoryFailure(createPendingHandoffSessionResolutionPort(symbolOptions));

    let getterCalled = false;
    const accessorOptions = { ...valid };
    Object.defineProperty(accessorOptions, "resolveCurrentSession", {
      get() {
        getterCalled = true;
        throw new Error(EXCEPTION_MARKER);
      },
      enumerable: true,
      configurable: true,
    });
    assertFactoryFailure(createPendingHandoffSessionResolutionPort(accessorOptions));
    assert.equal(getterCalled, false);
  });

  test("does not require callback Function objects themselves to be frozen", () => {
    const current = () => rawSuccess();
    const target = () => rawSuccess();
    assert.equal(Object.isFrozen(current), false);
    assert.equal(Object.isFrozen(target), false);
    const port = assertFactorySuccess(createPendingHandoffSessionResolutionPort({
      resolveCurrentSession: current,
      resolveTargetSession: target,
    }));
    assert.equal(typeof port.resolveCurrentSession, "function");
  });
});

group("Current resolution", () => {
  test("returns one frozen runtime-neutral observation and invokes once", () => {
    let calls = 0;
    let received;
    const port = createPort({
      resolveCurrentSession: input => {
        calls += 1;
        received = input;
        return rawSuccess(RUNTIME_A, SESSION_A);
      },
    });
    const result = port.resolveCurrentSession({ runtime_id: RUNTIME_A });
    assertPublicSuccess(result, RUNTIME_A, SESSION_A);
    assert.equal(calls, 1);
    assert.deepEqual(Reflect.ownKeys(received), ["runtime_id"]);
    assert.equal(Object.isFrozen(received), true);
    assert.deepEqual(received, { runtime_id: RUNTIME_A });
    assertNoLeak(result);
  });

  test("rejects an adapter observation for another runtime", () => {
    const port = createPort({
      resolveCurrentSession: () => rawSuccess(RUNTIME_B, SESSION_A),
    });
    assertFailure(port.resolveCurrentSession({ runtime_id: RUNTIME_A }), "session_resolution_runtime_mismatch");
  });
});

group("Target resolution binding", () => {
  test("returns exactly the requested target identity after re-resolution", () => {
    let calls = 0;
    let received;
    const port = createPort({
      resolveTargetSession: input => {
        calls += 1;
        received = input;
        return rawSuccess(RUNTIME_A, SESSION_A);
      },
    });
    const request = { runtime_id: RUNTIME_A, session_identity: SESSION_A };
    const result = port.resolveTargetSession(request);
    assertPublicSuccess(result, RUNTIME_A, SESSION_A);
    assert.equal(calls, 1);
    assert.equal(Object.isFrozen(received), true);
    assert.deepEqual(received, request);
    assert.deepEqual(Reflect.ownKeys(received), ["runtime_id", "session_identity"]);
  });

  test("separates target runtime and identity mismatches without substitution", () => {
    const runtimeMismatch = createPort({
      resolveTargetSession: () => rawSuccess(RUNTIME_B, SESSION_A),
    });
    assertFailure(
      runtimeMismatch.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_A }),
      "session_resolution_runtime_mismatch",
    );

    const identityMismatch = createPort({
      resolveTargetSession: () => rawSuccess(RUNTIME_A, SESSION_B),
    });
    assertFailure(
      identityMismatch.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_A }),
      "session_resolution_identity_mismatch",
    );
  });
});

group("Failure separation", () => {
  test("preserves unsupported, not-found, ambiguous, stale, denied, and unavailable", () => {
    for (const [adapterReason, publicReason] of [
      ["runtime_unsupported", "session_resolution_runtime_unsupported"],
      ["not_found", "session_resolution_not_found"],
      ["ambiguous", "session_resolution_ambiguous"],
      ["stale", "session_resolution_stale"],
      ["denied", "session_resolution_denied"],
      ["unavailable", "session_resolution_unavailable"],
    ]) {
      const port = createPort({ resolveCurrentSession: () => rawFailure(adapterReason) });
      assertFailure(port.resolveCurrentSession({ runtime_id: RUNTIME_A }), publicReason);
    }
  });

  test("keeps Core-owned reasons unavailable to adapters", () => {
    for (const reason of [
      "dependency_invalid",
      "input_invalid",
      "result_invalid",
      "runtime_mismatch",
      "identity_mismatch",
      "session_resolution_dependency_invalid",
      "session_resolution_input_invalid",
      "session_resolution_result_invalid",
      "session_resolution_runtime_mismatch",
      "session_resolution_identity_mismatch",
      "session_resolution_runtime_unsupported",
      "session_resolution_not_found",
      "session_resolution_ambiguous",
      "session_resolution_stale",
      "session_resolution_denied",
      "session_resolution_unavailable",
    ]) {
      const port = createPort({ resolveCurrentSession: () => rawFailure(reason) });
      assertFailure(
        port.resolveCurrentSession({ runtime_id: RUNTIME_A }),
        "session_resolution_result_invalid",
      );
    }
  });

  test("maps thrown adapter exceptions to unavailable and unknown reasons to result-invalid", () => {
    const throwing = createPort({
      resolveCurrentSession: () => {
        throw new Error(`${EXCEPTION_MARKER} ${NATIVE_PATH} ${NATIVE_TOKEN}`);
      },
    });
    assertFailure(throwing.resolveCurrentSession({ runtime_id: RUNTIME_A }), "session_resolution_unavailable");

    const unknown = createPort({
      resolveCurrentSession: () => rawFailure(`${EXCEPTION_MARKER}-unknown`),
    });
    assertFailure(unknown.resolveCurrentSession({ runtime_id: RUNTIME_A }), "session_resolution_result_invalid");
  });
});

group("Malformed adapter output", () => {
  test("rejects structural, identity, binding, and thenable violations", () => {
    const cases = [
      [null, "session_resolution_result_invalid"],
      [[], "session_resolution_result_invalid"],
      ["native-session-id", "session_resolution_result_invalid"],
      [cloneWithPrototype(rawSuccess(), null), "session_resolution_result_invalid"],
      [cloneWithPrototype(rawSuccess(), { inherited: true }), "session_resolution_result_invalid"],
      [{ ...rawSuccess(), extra: NATIVE_PATH }, "session_resolution_result_invalid"],
      [Object.assign(rawSuccess(), { [Symbol("native")]: NATIVE_SESSION_ID }), "session_resolution_result_invalid"],
      [rawFailure("unknown-adapter-reason"), "session_resolution_result_invalid"],
      [rawSuccess(RUNTIME_A, "phr1.repository.key_A-1." + "R".repeat(43)), "session_resolution_result_invalid"],
      [rawSuccess(RUNTIME_A, "malformed-session-identity"), "session_resolution_result_invalid"],
      [Promise.resolve(rawSuccess()), "session_resolution_result_invalid"],
    ];
    for (const [adapterResult, reason] of cases) {
      const port = createPort({ resolveCurrentSession: () => adapterResult });
      const result = port.resolveCurrentSession({ runtime_id: RUNTIME_A });
      assertFailure(result, reason);
      assertNoLeak(result);
    }

    const accessor = rawSuccess();
    Object.defineProperty(accessor, "session_identity", {
      get() {
        throw new Error(`${EXCEPTION_MARKER} ${NATIVE_SESSION_ID}`);
      },
      enumerable: true,
      configurable: true,
    });
    assertFailure(
      createPort({ resolveCurrentSession: () => accessor }).resolveCurrentSession({ runtime_id: RUNTIME_A }),
      "session_resolution_result_invalid",
    );
  });

  test("normalizes a rejected Promise without leaking its rejection", () => {
    const rejected = Promise.reject(new Error(`${EXCEPTION_MARKER} ${NATIVE_PATH}`));
    rejected.catch(() => {});
    const port = createPort({ resolveCurrentSession: () => rejected });
    const captured = captureOutput(() => port.resolveCurrentSession({ runtime_id: RUNTIME_A }));
    assertFailure(captured.value, "session_resolution_result_invalid");
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
    assertNoLeak(captured.value);
  });

  test("never reads a synthetic then accessor or permits output side effects", () => {
    let getterCalls = 0;
    const adapterResult = rawSuccess();
    Object.defineProperty(adapterResult, "then", {
      get() {
        getterCalls += 1;
        process.stdout.write(`${EXCEPTION_MARKER}-stdout`);
        process.stderr.write(`${EXCEPTION_MARKER}-stderr`);
        return () => {};
      },
      enumerable: true,
      configurable: true,
    });
    const port = createPort({ resolveCurrentSession: () => adapterResult });
    const captured = captureOutput(() => port.resolveCurrentSession({ runtime_id: RUNTIME_A }));
    assertFailure(captured.value, "session_resolution_result_invalid");
    assert.equal(getterCalls, 0);
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
    assertNoLeak(captured.value);
  });
});

group("Input and identity confusion", () => {
  test("requires exact plain current and target inputs", () => {
    const port = createPort();
    const currentInputs = [
      null,
      [],
      Object.create(null),
      Object.create({}),
      {},
      { runtime_id: RUNTIME_A, extra: true },
      Object.assign({ runtime_id: RUNTIME_A }, { [Symbol("extra")]: true }),
      { runtime_id: INVALID_RUNTIME },
      { runtime_id: "" },
      { runtime_id: " a" },
      { runtime_id: "a".repeat(33) },
      { runtime_id: 42 },
    ];
    for (const input of currentInputs) assertFailure(port.resolveCurrentSession(input), "session_resolution_input_invalid");

    const targetInputs = [
      { runtime_id: RUNTIME_A },
      { runtime_id: RUNTIME_A, session_identity: REPOSITORY_IDENTITY },
      { runtime_id: RUNTIME_A, session_identity: "malformed" },
      { runtime_id: RUNTIME_A, session_identity: new String(SESSION_A) },
      { runtime_id: INVALID_RUNTIME, session_identity: SESSION_A },
      { runtime_id: RUNTIME_A, session_identity: SESSION_A, extra: true },
      Object.assign({ runtime_id: RUNTIME_A, session_identity: SESSION_A }, { [Symbol("extra")]: true }),
    ];
    for (const input of targetInputs) assertFailure(port.resolveTargetSession(input), "session_resolution_input_invalid");
  });

  test("does not invoke adapters for invalid input or accessor fields", () => {
    let currentCalls = 0;
    let targetCalls = 0;
    const port = createPort({
      resolveCurrentSession: () => {
        currentCalls += 1;
        return rawSuccess();
      },
      resolveTargetSession: () => {
        targetCalls += 1;
        return rawSuccess();
      },
    });
    let getterCalled = false;
    const current = {};
    Object.defineProperty(current, "runtime_id", {
      get() {
        getterCalled = true;
        throw new Error(EXCEPTION_MARKER);
      },
      enumerable: true,
      configurable: true,
    });
    assertFailure(port.resolveCurrentSession(current), "session_resolution_input_invalid");
    assert.equal(getterCalled, false);
    assert.equal(currentCalls, 0);

    const target = { runtime_id: RUNTIME_A, session_identity: SESSION_A };
    Object.defineProperty(target, "session_identity", {
      get() {
        getterCalled = true;
        throw new Error(EXCEPTION_MARKER);
      },
      enumerable: true,
      configurable: true,
    });
    assertFailure(port.resolveTargetSession(target), "session_resolution_input_invalid");
    assert.equal(targetCalls, 0);
  });
});

group("Privacy boundary", () => {
  test("does not expose native values from output, errors, stdout, or stderr", () => {
    const adapterResult = {
      runtime_id: RUNTIME_A,
      session_identity: SESSION_A,
      native_session_id: NATIVE_SESSION_ID,
      native_path: NATIVE_PATH,
      token: NATIVE_TOKEN,
      prompt: PROMPT_MARKER,
    };
    const port = createPort({ resolveCurrentSession: () => adapterResult });
    const captured = captureOutput(() => port.resolveCurrentSession({ runtime_id: RUNTIME_A }));
    assertFailure(captured.value, "session_resolution_result_invalid");
    assertNoLeak(captured.value);
    assert.equal(captured.stdout.includes(NATIVE_SESSION_ID), false);
    assert.equal(captured.stdout.includes(NATIVE_PATH), false);
    assert.equal(captured.stderr.includes(NATIVE_TOKEN), false);
    assert.equal(safeJson(captured.value).includes(PROMPT_MARKER), false);
  });
});

group("Freshness and independence", () => {
  test("performs one-shot uncached observations", () => {
    let calls = 0;
    const port = createPort({
      resolveCurrentSession: () => {
        calls += 1;
        return rawSuccess(RUNTIME_A, calls === 1 ? SESSION_A : SESSION_B);
      },
    });
    assertPublicSuccess(port.resolveCurrentSession({ runtime_id: RUNTIME_A }), RUNTIME_A, SESSION_A);
    assertPublicSuccess(port.resolveCurrentSession({ runtime_id: RUNTIME_A }), RUNTIME_A, SESSION_B);
    assert.equal(calls, 2);
  });

  test("keeps reentrant requests independent", () => {
    let calls = 0;
    let port;
    port = createPort({
      resolveCurrentSession: input => {
        calls += 1;
        if (input.runtime_id === RUNTIME_A) {
          const nested = port.resolveCurrentSession({ runtime_id: RUNTIME_B });
          assertPublicSuccess(nested, RUNTIME_B, SESSION_B);
          return rawSuccess(RUNTIME_A, SESSION_A);
        }
        return rawSuccess(RUNTIME_B, SESSION_B);
      },
    });
    assertPublicSuccess(port.resolveCurrentSession({ runtime_id: RUNTIME_A }), RUNTIME_A, SESSION_A);
    assert.equal(calls, 2);
  });

  test("performs target observations sequentially without a target cache", () => {
    let calls = 0;
    const port = createPort({
      resolveTargetSession: input => {
        calls += 1;
        return rawSuccess(input.runtime_id, calls === 1 ? SESSION_A : SESSION_B);
      },
    });
    assertPublicSuccess(
      port.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_A }),
      RUNTIME_A,
      SESSION_A,
    );
    assertPublicSuccess(
      port.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_B }),
      RUNTIME_A,
      SESSION_B,
    );
    assert.equal(calls, 2);
  });

  test("keeps reentrant target requests independent and invokes once per request", () => {
    let calls = 0;
    let port;
    port = createPort({
      resolveTargetSession: input => {
        calls += 1;
        if (input.session_identity === SESSION_A) {
          const nested = port.resolveTargetSession({
            runtime_id: RUNTIME_B,
            session_identity: SESSION_B,
          });
          assertPublicSuccess(nested, RUNTIME_B, SESSION_B);
          return rawSuccess(RUNTIME_A, SESSION_A);
        }
        return rawSuccess(RUNTIME_B, SESSION_B);
      },
    });
    assertPublicSuccess(
      port.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_A }),
      RUNTIME_A,
      SESSION_A,
    );
    assert.equal(calls, 2);
  });
});

group("Static dependency boundary", () => {
  test("imports only the runtime-neutral identity seam", () => {
    const imports = SOURCE.match(/^import .*$/gm) ?? [];
    assert.deepEqual(imports, [
      'import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";',
    ]);
    for (const forbidden of [
      "node:",
      "codex",
      "claude",
      "context-checkpoint",
      "pending-handoff-store",
      "pending-handoff-claim",
      "pending-handoff-delivery",
      "compareAndSet",
      "child_process",
      "network",
      "process",
      "stdout",
      "stderr",
    ]) {
      assert.equal(SOURCE.includes(forbidden), false, forbidden);
    }
  });

});

group("Mutation boundary", () => {
  test("does not alter the Candidate 17-field contract or add lifecycle calls", () => {
    const candidate = makeCandidate();
    assert.equal(validateCandidate(candidate).ok, true);
    assert.equal(Object.keys(candidate).length, 17);
    assert.equal(SOURCE.includes("createPendingHandoffRuntime"), false);
    assert.equal(SOURCE.includes("mutationPort"), false);
    assert.equal(SOURCE.includes("claimLease"), false);
    assert.equal(SOURCE.includes("deliveryConsumption"), false);
    assert.equal(SOURCE.includes("state_revision"), false);
  });

  test("wires only the dedicated fixture into Pending Handoff verification", () => {
    assert.match(
      MAKEFILE_SOURCE,
      /^test-pending-handoff-session-resolution-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-session-resolution-fixtures\.mjs$/m,
    );
    const declaration = MAKEFILE_SOURCE.match(/^test-v1x-fixtures:[\s\S]*?(?=\n\ninstall:)/m)?.[0] ?? "";
    assert.match(declaration, /test-pending-handoff-session-resolution-fixtures/);
    assert.equal(MAKEFILE_SOURCE.includes("completion-notify.*session-resolution"), false);
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS\n`);
