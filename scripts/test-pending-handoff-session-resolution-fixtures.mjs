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

async function captureAsyncOutput(operation) {
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
    return { value: await operation(), stdout, stderr };
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

async function asyncGroup(name, operation) {
  await operation();
  groups += 1;
  process.stdout.write(`PASS GROUP ${groups} ${name}\n`);
}

async function asyncTest(name, operation) {
  await operation();
  tests += 1;
  process.stdout.write(`PASS ${name}\n`);
}

await group("API oracle", async () => {
  await test("exports exactly the public module surface including ESM metadata", async () => {
    assert.deepEqual(Reflect.ownKeys(moduleNamespace), [
      "PENDING_HANDOFF_SESSION_RESOLUTION_FAILURES",
      "createPendingHandoffSessionResolutionPort",
      Symbol.toStringTag,
    ]);
  });

  await test("freezes the exact failure taxonomy", async () => {
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

  await test("freezes the facade without hidden capabilities", async () => {
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

await group("Dependency boundary", async () => {
  await test("rejects malformed dependency records and never invokes accessors", async () => {
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

  await test("does not require callback Function objects themselves to be frozen", async () => {
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

await group("Current resolution", async () => {
  await test("returns one frozen runtime-neutral observation and invokes once", async () => {
    let calls = 0;
    let received;
    const port = createPort({
      resolveCurrentSession: input => {
        calls += 1;
        received = input;
        return rawSuccess(RUNTIME_A, SESSION_A);
      },
    });
    const result = await port.resolveCurrentSession({ runtime_id: RUNTIME_A });
    assertPublicSuccess(result, RUNTIME_A, SESSION_A);
    assert.equal(calls, 1);
    assert.deepEqual(Reflect.ownKeys(received), ["runtime_id"]);
    assert.equal(Object.isFrozen(received), true);
    assert.deepEqual(received, { runtime_id: RUNTIME_A });
    assertNoLeak(result);
  });

  await test("rejects an adapter observation for another runtime", async () => {
    const port = createPort({
      resolveCurrentSession: () => rawSuccess(RUNTIME_B, SESSION_A),
    });
    assertFailure(await port.resolveCurrentSession({ runtime_id: RUNTIME_A }), "session_resolution_runtime_mismatch");
  });
});

await group("Target resolution binding", async () => {
  await test("returns exactly the requested target identity after re-resolution", async () => {
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
    const result = await port.resolveTargetSession(request);
    assertPublicSuccess(result, RUNTIME_A, SESSION_A);
    assert.equal(calls, 1);
    assert.equal(Object.isFrozen(received), true);
    assert.deepEqual(received, request);
    assert.deepEqual(Reflect.ownKeys(received), ["runtime_id", "session_identity"]);
  });

  await test("separates target runtime and identity mismatches without substitution", async () => {
    const runtimeMismatch = createPort({
      resolveTargetSession: () => rawSuccess(RUNTIME_B, SESSION_A),
    });
    assertFailure(
      await runtimeMismatch.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_A }),
      "session_resolution_runtime_mismatch",
    );

    const identityMismatch = createPort({
      resolveTargetSession: () => rawSuccess(RUNTIME_A, SESSION_B),
    });
    assertFailure(
      await identityMismatch.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_A }),
      "session_resolution_identity_mismatch",
    );
  });
});

await group("Failure separation", async () => {
  await test("preserves unsupported, not-found, ambiguous, stale, denied, and unavailable", async () => {
    for (const [adapterReason, publicReason] of [
      ["runtime_unsupported", "session_resolution_runtime_unsupported"],
      ["not_found", "session_resolution_not_found"],
      ["ambiguous", "session_resolution_ambiguous"],
      ["stale", "session_resolution_stale"],
      ["denied", "session_resolution_denied"],
      ["unavailable", "session_resolution_unavailable"],
    ]) {
      const port = createPort({ resolveCurrentSession: () => rawFailure(adapterReason) });
      assertFailure(await port.resolveCurrentSession({ runtime_id: RUNTIME_A }), publicReason);
    }
  });

  await test("keeps Core-owned reasons unavailable to adapters", async () => {
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
        await port.resolveCurrentSession({ runtime_id: RUNTIME_A }),
        "session_resolution_result_invalid",
      );
    }
  });

  await test("maps thrown adapter exceptions to unavailable and unknown reasons to result-invalid", async () => {
    const throwing = createPort({
      resolveCurrentSession: () => {
        throw new Error(`${EXCEPTION_MARKER} ${NATIVE_PATH} ${NATIVE_TOKEN}`);
      },
    });
    assertFailure(await throwing.resolveCurrentSession({ runtime_id: RUNTIME_A }), "session_resolution_unavailable");

    const unknown = createPort({
      resolveCurrentSession: () => rawFailure(`${EXCEPTION_MARKER}-unknown`),
    });
    assertFailure(await unknown.resolveCurrentSession({ runtime_id: RUNTIME_A }), "session_resolution_result_invalid");
  });
});

await group("Malformed adapter output", async () => {
  await test("rejects structural, identity, binding, and thenable violations", async () => {
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
      [Promise.resolve(null), "session_resolution_result_invalid"],
    ];
    for (const [adapterResult, reason] of cases) {
      const port = createPort({ resolveCurrentSession: () => adapterResult });
      const result = await port.resolveCurrentSession({ runtime_id: RUNTIME_A });
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
      await createPort({ resolveCurrentSession: () => accessor }).resolveCurrentSession({ runtime_id: RUNTIME_A }),
      "session_resolution_result_invalid",
    );
  });

  await test("normalizes a rejected Promise without leaking its rejection", async () => {
    const rejected = Promise.reject(new Error(`${EXCEPTION_MARKER} ${NATIVE_PATH}`));
    rejected.catch(() => {});
    const port = createPort({ resolveCurrentSession: () => rejected });
    const captured = await captureAsyncOutput(() => port.resolveCurrentSession({ runtime_id: RUNTIME_A }));
    assertFailure(captured.value, "session_resolution_unavailable");
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
    assertNoLeak(captured.value);
  });

  await test("never reads a synthetic then accessor or permits output side effects", async () => {
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
    const captured = await captureAsyncOutput(() => port.resolveCurrentSession({ runtime_id: RUNTIME_A }));
    assertFailure(captured.value, "session_resolution_result_invalid");
    assert.equal(getterCalls, 0);
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
    assertNoLeak(captured.value);
  });
});

await group("Input and identity confusion", async () => {
  await test("requires exact plain current and target inputs", async () => {
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
    for (const input of currentInputs) {
      assertFailure(await port.resolveCurrentSession(input), "session_resolution_input_invalid");
    }

    const targetInputs = [
      { runtime_id: RUNTIME_A },
      { runtime_id: RUNTIME_A, session_identity: REPOSITORY_IDENTITY },
      { runtime_id: RUNTIME_A, session_identity: "malformed" },
      { runtime_id: RUNTIME_A, session_identity: new String(SESSION_A) },
      { runtime_id: INVALID_RUNTIME, session_identity: SESSION_A },
      { runtime_id: RUNTIME_A, session_identity: SESSION_A, extra: true },
      Object.assign({ runtime_id: RUNTIME_A, session_identity: SESSION_A }, { [Symbol("extra")]: true }),
    ];
    for (const input of targetInputs) {
      assertFailure(await port.resolveTargetSession(input), "session_resolution_input_invalid");
    }
  });

  await test("does not invoke adapters for invalid input or accessor fields", async () => {
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
    assertFailure(await port.resolveCurrentSession(current), "session_resolution_input_invalid");
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
    assertFailure(await port.resolveTargetSession(target), "session_resolution_input_invalid");
    assert.equal(targetCalls, 0);
  });
});

await group("Privacy boundary", async () => {
  await test("does not expose native values from output, errors, stdout, or stderr", async () => {
    const adapterResult = {
      runtime_id: RUNTIME_A,
      session_identity: SESSION_A,
      native_session_id: NATIVE_SESSION_ID,
      native_path: NATIVE_PATH,
      token: NATIVE_TOKEN,
      prompt: PROMPT_MARKER,
    };
    const port = createPort({ resolveCurrentSession: () => adapterResult });
    const captured = await captureAsyncOutput(() => port.resolveCurrentSession({ runtime_id: RUNTIME_A }));
    assertFailure(captured.value, "session_resolution_result_invalid");
    assertNoLeak(captured.value);
    assert.equal(captured.stdout.includes(NATIVE_SESSION_ID), false);
    assert.equal(captured.stdout.includes(NATIVE_PATH), false);
    assert.equal(captured.stderr.includes(NATIVE_TOKEN), false);
    assert.equal(safeJson(captured.value).includes(PROMPT_MARKER), false);
  });
});

await group("Freshness and independence", async () => {
  await test("performs one-shot uncached observations", async () => {
    let calls = 0;
    const port = createPort({
      resolveCurrentSession: () => {
        calls += 1;
        return rawSuccess(RUNTIME_A, calls === 1 ? SESSION_A : SESSION_B);
      },
    });
    assertPublicSuccess(await port.resolveCurrentSession({ runtime_id: RUNTIME_A }), RUNTIME_A, SESSION_A);
    assertPublicSuccess(await port.resolveCurrentSession({ runtime_id: RUNTIME_A }), RUNTIME_A, SESSION_B);
    assert.equal(calls, 2);
  });

  await test("keeps reentrant requests independent", async () => {
    let calls = 0;
    let port;
    port = createPort({
      resolveCurrentSession: async input => {
        calls += 1;
        if (input.runtime_id === RUNTIME_A) {
          const nested = await port.resolveCurrentSession({ runtime_id: RUNTIME_B });
          assertPublicSuccess(nested, RUNTIME_B, SESSION_B);
          return rawSuccess(RUNTIME_A, SESSION_A);
        }
        return rawSuccess(RUNTIME_B, SESSION_B);
      },
    });
    assertPublicSuccess(await port.resolveCurrentSession({ runtime_id: RUNTIME_A }), RUNTIME_A, SESSION_A);
    assert.equal(calls, 2);
  });

  await test("performs target observations sequentially without a target cache", async () => {
    let calls = 0;
    const port = createPort({
      resolveTargetSession: input => {
        calls += 1;
        return rawSuccess(input.runtime_id, calls === 1 ? SESSION_A : SESSION_B);
      },
    });
    assertPublicSuccess(
      await port.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_A }),
      RUNTIME_A,
      SESSION_A,
    );
    assertPublicSuccess(
      await port.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_B }),
      RUNTIME_A,
      SESSION_B,
    );
    assert.equal(calls, 2);
  });

  await test("keeps reentrant target requests independent and invokes once per request", async () => {
    let calls = 0;
    let port;
    port = createPort({
      resolveTargetSession: async input => {
        calls += 1;
        if (input.session_identity === SESSION_A) {
          const nested = await port.resolveTargetSession({
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
      await port.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_A }),
      RUNTIME_A,
      SESSION_A,
    );
    assert.equal(calls, 2);
  });
});

await group("Static dependency boundary", async () => {
  await test("imports only the runtime-neutral identity seam", async () => {
    const imports = SOURCE.match(/^import .*$/gm) ?? [];
    assert.deepEqual(imports, [
      'import { types as utilTypes } from "node:util";',
      'import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";',
    ]);
    for (const forbidden of [
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

  await test("uses intrinsic Promise detection without thenable duck typing", async () => {
    assert.match(SOURCE, /utilTypes\.isPromise\(adapterResult\)/);
    assert.match(
      SOURCE,
      /if \(utilTypes\.isProxy\(adapterResult\)\) \{\s*return failure\("session_resolution_result_invalid"\);\s*\}\s*if \(utilTypes\.isPromise\(adapterResult\)\) adapterResult = await adapterResult;\s*if \(utilTypes\.isProxy\(adapterResult\)/s,
    );
    assert.match(SOURCE, /if \(utilTypes\.isProxy\(value\)\) return \{ ok: false \};/);
    assert.match(SOURCE, /function hasThenProperty[\s\S]*?utilTypes\.isProxy\(value\)/);
    assert.doesNotMatch(SOURCE, /(?:adapterResult|value)\.then/);
    assert.doesNotMatch(SOURCE, /typeof\s+(?:adapterResult|value)\.then/);
    assert.doesNotMatch(SOURCE, /Promise\.resolve\s*\(/);
  });

});

await group("Mutation boundary", async () => {
  await test("does not alter the Candidate 17-field contract or add lifecycle calls", async () => {
    const candidate = makeCandidate();
    assert.equal(validateCandidate(candidate).ok, true);
    assert.equal(Object.keys(candidate).length, 17);
    assert.equal(SOURCE.includes("createPendingHandoffRuntime"), false);
    assert.equal(SOURCE.includes("mutationPort"), false);
    assert.equal(SOURCE.includes("claimLease"), false);
    assert.equal(SOURCE.includes("deliveryConsumption"), false);
    assert.equal(SOURCE.includes("state_revision"), false);
  });

  await test("wires only the dedicated fixture into Pending Handoff verification", async () => {
    assert.match(
      MAKEFILE_SOURCE,
      /^test-pending-handoff-session-resolution-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-session-resolution-fixtures\.mjs$/m,
    );
    const declaration = MAKEFILE_SOURCE.match(/^test-v1x-fixtures:[\s\S]*?(?=\n\ninstall:)/m)?.[0] ?? "";
    assert.match(declaration, /test-pending-handoff-session-resolution-fixtures/);
    assert.equal(MAKEFILE_SOURCE.includes("completion-notify.*session-resolution"), false);
  });
});

await asyncGroup("Async resolution compatibility", async () => {
  await asyncTest("wraps sync callbacks and input failures in Promises", async () => {
    const port = createPort();
    const successResult = port.resolveCurrentSession({ runtime_id: RUNTIME_A });
    assert.equal(successResult instanceof Promise, true);
    assertPublicSuccess(await successResult, RUNTIME_A, SESSION_A);

    const inputResult = port.resolveCurrentSession({ runtime_id: INVALID_RUNTIME });
    assert.equal(inputResult instanceof Promise, true);
    assertFailure(await inputResult, "session_resolution_input_invalid");
  });

  await asyncTest("accepts an intrinsic async current-session callback", async () => {
    let calls = 0;
    const port = createPort({
      resolveCurrentSession: async () => {
        calls += 1;
        await Promise.resolve();
        return rawSuccess(RUNTIME_A, SESSION_A);
      },
    });
    const result = port.resolveCurrentSession({ runtime_id: RUNTIME_A });
    assert.equal(result instanceof Promise, true);
    assertPublicSuccess(await result, RUNTIME_A, SESSION_A);
    assert.equal(calls, 1);
  });

  await asyncTest("accepts an intrinsic async target-session callback", async () => {
    const port = createPort({
      resolveTargetSession: async request => {
        await Promise.resolve();
        return rawSuccess(request.runtime_id, request.session_identity);
      },
    });
    const result = port.resolveTargetSession({
      runtime_id: RUNTIME_A,
      session_identity: SESSION_A,
    });
    assert.equal(result instanceof Promise, true);
    assertPublicSuccess(await result, RUNTIME_A, SESSION_A);
  });

  await asyncTest("preserves async failure provenance and sanitizes rejection", async () => {
    const notFound = createPort({
      resolveCurrentSession: async () => {
        await Promise.resolve();
        return rawFailure("not_found");
      },
    });
    assertFailure(
      await notFound.resolveCurrentSession({ runtime_id: RUNTIME_A }),
      "session_resolution_not_found",
    );

    const rejected = createPort({
      resolveCurrentSession: async () => {
        throw new Error(`${EXCEPTION_MARKER} ${NATIVE_PATH} ${NATIVE_TOKEN}`);
      },
    });
    const captured = await captureAsyncOutput(
      () => rejected.resolveCurrentSession({ runtime_id: RUNTIME_A }),
    );
    assertFailure(captured.value, "session_resolution_unavailable");
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
    assertNoLeak(captured.value);
  });

  await asyncTest("preserves async adapter failure and Core binding provenance", async () => {
    for (const [adapterReason, publicReason] of [
      ["runtime_unsupported", "session_resolution_runtime_unsupported"],
      ["not_found", "session_resolution_not_found"],
      ["ambiguous", "session_resolution_ambiguous"],
      ["stale", "session_resolution_stale"],
      ["denied", "session_resolution_denied"],
      ["unavailable", "session_resolution_unavailable"],
    ]) {
      const port = createPort({
        resolveCurrentSession: async () => rawFailure(adapterReason),
      });
      assertFailure(
        await port.resolveCurrentSession({ runtime_id: RUNTIME_A }),
        publicReason,
      );
    }

    const runtimeMismatch = createPort({
      resolveTargetSession: async () => rawSuccess(RUNTIME_B, SESSION_A),
    });
    assertFailure(
      await runtimeMismatch.resolveTargetSession({
        runtime_id: RUNTIME_A,
        session_identity: SESSION_A,
      }),
      "session_resolution_runtime_mismatch",
    );

    const identityMismatch = createPort({
      resolveTargetSession: async () => rawSuccess(RUNTIME_A, SESSION_B),
    });
    assertFailure(
      await identityMismatch.resolveTargetSession({
        runtime_id: RUNTIME_A,
        session_identity: SESSION_A,
      }),
      "session_resolution_identity_mismatch",
    );

    const coreOwnedReason = createPort({
      resolveCurrentSession: async () => rawFailure("input_invalid"),
    });
    assertFailure(
      await coreOwnedReason.resolveCurrentSession({ runtime_id: RUNTIME_A }),
      "session_resolution_result_invalid",
    );

    const malformed = createPort({
      resolveTargetSession: async () => ({ ok: true, value: null }),
    });
    assertFailure(
      await malformed.resolveTargetSession({
        runtime_id: RUNTIME_A,
        session_identity: SESSION_A,
      }),
      "session_resolution_result_invalid",
    );
  });

  await asyncTest("rejects direct thenables without reading then accessors", async () => {
    const cases = [];
    for (const enumerable of [true, false]) {
      let getterCalls = 0;
      const result = rawSuccess();
      Object.defineProperty(result, "then", {
        get() {
          getterCalls += 1;
          process.stdout.write(`${EXCEPTION_MARKER}-stdout`);
          process.stderr.write(`${EXCEPTION_MARKER}-stderr`);
          return () => {};
        },
        enumerable,
        configurable: true,
      });
      cases.push({ result, getCalls: () => getterCalls });
    }

    const inheritedGetterCalls = { value: 0 };
    const hostilePrototype = {};
    Object.defineProperty(hostilePrototype, "then", {
      get() {
        inheritedGetterCalls.value += 1;
        throw new Error(EXCEPTION_MARKER);
      },
      enumerable: false,
    });
    cases.push({
      result: cloneWithPrototype(rawSuccess(), hostilePrototype),
      getCalls: () => inheritedGetterCalls.value,
    });

    const ordinaryThenable = rawSuccess();
    Object.defineProperty(ordinaryThenable, "then", {
      value: () => {},
      enumerable: false,
      configurable: true,
    });
    cases.push({ result: ordinaryThenable, getCalls: () => 0 });

    for (const item of cases) {
      const captured = await captureAsyncOutput(
        () => createPort({ resolveCurrentSession: () => item.result })
          .resolveCurrentSession({ runtime_id: RUNTIME_A }),
      );
      assertFailure(captured.value, "session_resolution_result_invalid");
      assert.equal(item.getCalls(), 0);
      assert.equal(captured.stdout, "");
      assert.equal(captured.stderr, "");
      assertNoLeak(captured.value);
    }
  });

  await asyncTest("rejects Proxy results before any trap or semantic reflection", async () => {
    function makeProxy(target, trapName) {
      let trapCalls = 0;
      let thenCalls = 0;
      const mark = () => {
        trapCalls += 1;
        process.stdout.write(`${EXCEPTION_MARKER}-proxy-stdout`);
        process.stderr.write(`${EXCEPTION_MARKER}-proxy-stderr`);
      };
      const handler = {};
      if (trapName === "get") {
        handler.get = (value, property, receiver) => {
          mark();
          if (property === "then") {
            thenCalls += 1;
            return () => {};
          }
          return Reflect.get(value, property, receiver);
        };
      }
      if (trapName === "ownKeys") {
        handler.ownKeys = value => {
          mark();
          return Reflect.ownKeys(value);
        };
      }
      if (trapName === "getOwnPropertyDescriptor") {
        handler.getOwnPropertyDescriptor = (value, property) => {
          mark();
          return Reflect.getOwnPropertyDescriptor(value, property);
        };
      }
      if (trapName === "getPrototypeOf") {
        handler.getPrototypeOf = value => {
          mark();
          return Reflect.getPrototypeOf(value);
        };
      }
      return {
        value: new Proxy(target, handler),
        trapCalls: () => trapCalls,
        thenCalls: () => thenCalls,
      };
    }

    const cases = [
      ["get synthesizes then", () => makeProxy(rawSuccess(), "get")],
      ["ownKeys trap", () => makeProxy(rawSuccess(), "ownKeys")],
      ["descriptor trap", () => makeProxy(rawSuccess(), "getOwnPropertyDescriptor")],
      ["prototype trap", () => makeProxy(rawSuccess(), "getPrototypeOf")],
      ["Promise settles to Proxy", () => {
        const probe = makeProxy(rawSuccess(), "ownKeys");
        return { ...probe, value: Promise.resolve(probe.value) };
      }],
      ["Proxy wraps Promise", () => makeProxy(Promise.resolve(rawSuccess()), "ownKeys")],
    ];

    for (const phase of ["current", "target"]) {
      for (const [label, build] of cases) {
        const probe = build();
        const port = createPort(phase === "current"
          ? { resolveCurrentSession: () => probe.value }
          : { resolveTargetSession: () => probe.value });
        const captured = await captureAsyncOutput(() => phase === "current"
          ? port.resolveCurrentSession({ runtime_id: RUNTIME_A })
          : port.resolveTargetSession({
            runtime_id: RUNTIME_A,
            session_identity: SESSION_A,
          }));
        assertFailure(captured.value, "session_resolution_result_invalid");
        assert.equal(probe.trapCalls(), 0, `${phase} ${label}`);
        assert.equal(probe.thenCalls(), 0, `${phase} ${label} then`);
        assert.equal(captured.stdout, "", `${phase} ${label} stdout`);
        assert.equal(captured.stderr, "", `${phase} ${label} stderr`);
        assertNoLeak(captured.value);
      }
    }
  });

  await asyncTest("keeps concurrent current and target observations isolated", async () => {
    const wait = delay => new Promise(resolve => setTimeout(resolve, delay));
    const port = createPort({
      resolveCurrentSession: async request => {
        await wait(request.runtime_id === RUNTIME_A ? 5 : 0);
        return rawSuccess(
          request.runtime_id,
          request.runtime_id === RUNTIME_A ? SESSION_A : SESSION_B,
        );
      },
      resolveTargetSession: async request => {
        await wait(request.session_identity === SESSION_A ? 5 : 0);
        return rawSuccess(request.runtime_id, request.session_identity);
      },
    });

    const [currentA, currentB, targetA, targetB] = await Promise.all([
      port.resolveCurrentSession({ runtime_id: RUNTIME_A }),
      port.resolveCurrentSession({ runtime_id: RUNTIME_B }),
      port.resolveTargetSession({ runtime_id: RUNTIME_A, session_identity: SESSION_A }),
      port.resolveTargetSession({ runtime_id: RUNTIME_B, session_identity: SESSION_B }),
    ]);
    assertPublicSuccess(currentA, RUNTIME_A, SESSION_A);
    assertPublicSuccess(currentB, RUNTIME_B, SESSION_B);
    assertPublicSuccess(targetA, RUNTIME_A, SESSION_A);
    assertPublicSuccess(targetB, RUNTIME_B, SESSION_B);
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS\n`);
