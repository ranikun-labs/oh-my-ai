import assert from "node:assert/strict";
import fs from "node:fs";
import * as moduleNamespace from "./lib/pending-handoff-manual-resume-runtime-composition.mjs";
import { PENDING_HANDOFF_SCHEMA_VERSION } from "./lib/pending-handoff-core.mjs";

const SESSION_SOURCE = `phr1.session.key_A-1.${"S".repeat(43)}`;
const SESSION_OWNER = `phr1.session.key_A-1.${"O".repeat(43)}`;
const REPOSITORY = `phr1.repository.key_A-1.${"R".repeat(43)}`;
const WORKTREE = `phr1.worktree.key_A-1.${"W".repeat(43)}`;
const ATTEMPT = "123e4567-e89b-42d3-a456-426614174000";
const PRIVATE_MARKER = "composition-private-marker";
const MAKEFILE_SOURCE = fs.readFileSync(new URL("../Makefile", import.meta.url), "utf8");

let groups = 0;
let tests = 0;

function candidate(sourceRuntime = "codex") {
  return {
    candidate_id: "composition-candidate-001",
    schema_version: PENDING_HANDOFF_SCHEMA_VERSION,
    status: "pending",
    created_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T02:00:00.000Z",
    source_runtime: sourceRuntime,
    source_session_identity: SESSION_SOURCE,
    repository_identity: REPOSITORY,
    worktree_identity: WORKTREE,
    goal: "Compose a runtime-neutral manual resume.",
    completed: ["Candidate persisted."],
    open_issues: [],
    verification: ["Composition is under test."],
    do_not_touch: ["Native runtime state."],
    next_action: "Resume the target runtime.",
    context_checkpoint_status: "review_needed",
    privacy_redaction_status: "passed",
  };
}

function state(sourceRuntime = "codex") {
  return Object.freeze({ candidate: Object.freeze(candidate(sourceRuntime)), state_revision: 1, claim: null });
}

function success(value) { return { ok: true, value }; }
function failure(reason) { return { ok: false, reason }; }

function resolution(runtimeId = "codex", identity = SESSION_SOURCE) {
  return { runtime_id: runtimeId, session_identity: identity };
}

function actionRequest(runtimeId = "codex") {
  return {
    action_kind: "manual_resume",
    candidate_id: "composition-candidate-001",
    state_revision: 2,
    current_session_identity: SESSION_OWNER,
    claim_attempt_id: ATTEMPT,
    target: { runtime_id: runtimeId, session_identity: SESSION_SOURCE },
  };
}

function receipt(runtimeId = "codex") {
  return {
    action_kind: "manual_resume",
    candidate_id: "composition-candidate-001",
    state_revision: 2,
    current_session_identity: SESSION_OWNER,
    claim_attempt_id: ATTEMPT,
    target: { runtime_id: runtimeId, session_identity: SESSION_SOURCE },
    adapter_version: "fixture",
    outcome: "resume_accepted",
  };
}

function build(options = {}) {
  const calls = [];
  const stateReads = options.stateReads ?? [state("codex")];
  let stateIndex = 0;
  const store = options.store ?? {
    readState: async candidateId => {
      calls.push(["readState", candidateId]);
      const next = typeof stateReads === "function" ? stateReads(stateIndex++) : stateReads[Math.min(stateIndex++, stateReads.length - 1)];
      return success(next);
    },
  };
  const claimLease = options.claimLease ?? {
    acquireClaim: async request => {
      calls.push(["acquireClaim", request]);
      return success({ state_revision: 2, claim_attempt_id: request.claim_attempt_id, claim_lease_expires_at: "2026-08-01T01:00:00.000Z" });
    },
  };
  const codexResolution = options.codexResolution ?? {
    resolveCurrentSession: request => {
      calls.push(["codex.resolveCurrentSession", request]);
      return Promise.resolve(success(resolution("codex", SESSION_OWNER)));
    },
    resolveTargetSession: request => {
      calls.push(["codex.resolveTargetSession", request]);
      return Promise.resolve(success(resolution("codex", SESSION_SOURCE)));
    },
  };
  const claudeResolution = options.claudeResolution ?? {
    resolveCurrentSession: request => {
      calls.push(["claude.resolveCurrentSession", request]);
      return Promise.resolve(success(resolution("claude", SESSION_OWNER)));
    },
    resolveTargetSession: request => {
      calls.push(["claude.resolveTargetSession", request]);
      return Promise.resolve(success(resolution("claude", SESSION_SOURCE)));
    },
  };
  const executor = options.executor ?? {
    resolveAndResume: async request => {
      calls.push(["codex.resolveAndResume", request]);
      return success(receipt(request.target.runtime_id));
    },
  };
  const manualResumeServiceFactory = options.manualResumeServiceFactory ?? undefined;
  const built = moduleNamespace.createPendingHandoffManualResumeRuntimeComposition({
    store,
    claimLease,
    runtimeEntries: [
      { runtime_id: "codex", sessionResolution: codexResolution, manualResumeAction: { supported: true, executor } },
      { runtime_id: "claude", sessionResolution: claudeResolution, manualResumeAction: { supported: false } },
    ],
    ...(manualResumeServiceFactory === undefined ? {} : { manualResumeServiceFactory }),
  });
  assert.equal(built.ok, true);
  return { composition: built.value, calls, store, claimLease };
}

function request(overrides = {}) {
  return {
    candidate_id: "composition-candidate-001",
    expected_revision: 1,
    current_runtime_id: "codex",
    claim_attempt_id: ATTEMPT,
    ...overrides,
  };
}

async function group(name, callback) { groups += 1; await callback(); }
async function test(name, callback) {
  tests += 1;
  try { await callback(); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

await group("exact composition authority", async () => {
  await test("exports one frozen execute facade", () => {
    assert.deepEqual(Reflect.ownKeys(moduleNamespace), ["createPendingHandoffManualResumeRuntimeComposition", Symbol.toStringTag]);
    const { composition } = build();
    assert.deepEqual(Reflect.ownKeys(composition), ["executeManualResume"]);
    assert.equal(Object.isFrozen(composition), true);
  });
  await test("rejects supported runtime entries without an executor", () => {
    const result = moduleNamespace.createPendingHandoffManualResumeRuntimeComposition({
      store: { readState: async () => success(state()) },
      claimLease: { acquireClaim: async () => success({}) },
      runtimeEntries: [{
        runtime_id: "codex",
        sessionResolution: build().composition,
        manualResumeAction: { supported: true },
      }],
    });
    assert.equal(result.ok, false);
  });
});

await group("authoritative pre-Claim capability selection", async () => {
  await test("Claude unsupported fails after Store pre-read and before every lifecycle/native authority", async () => {
    const built = build({ stateReads: [state("claude")] });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_runtime_unsupported" });
    assert.deepEqual(built.calls.map(([name]) => name), ["readState"]);
  });
  await test("caller-supplied runtime spoof cannot select Codex", async () => {
    const built = build({ stateReads: [state("claude")] });
    const result = await built.composition.executeManualResume(request({ runtime_id: "codex" }));
    assert.deepEqual(result, { ok: false, reason: "manual_resume_input_invalid" });
    assert.deepEqual(built.calls, []);
  });
  await test("unknown persisted runtime fails closed before Claim", async () => {
    const built = build({ stateReads: [state("unknown-runtime")] });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_runtime_unsupported" });
    assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
  });
});

await group("supported Codex delegation and drift safety", async () => {
  await test("Codex delegates through Core, Claim, then the exact executor", async () => {
    const built = build();
    const result = await built.composition.executeManualResume(request());
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.target, { runtime_id: "codex", session_identity: SESSION_SOURCE });
    assert.deepEqual(built.calls.map(([name]) => name), [
      "readState",
      "readState",
      "codex.resolveCurrentSession",
      "codex.resolveTargetSession",
      "acquireClaim",
      "codex.resolveAndResume",
    ]);
  });
  await test("second Core read changing runtime cannot reach Claim or Codex executor", async () => {
    const built = build({ stateReads: [state("codex"), state("claude")] });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_runtime_unsupported" });
    assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
    assert.equal(built.calls.filter(([name]) => name === "codex.resolveAndResume").length, 0);
  });
  await test("supported capability with executor failure remains sanitized", async () => {
    const built = build({ executor: { resolveAndResume: async () => ({ ok: false, reason: "codex_action_unavailable" }) } });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_action_request_unavailable" });
    assert.equal(JSON.stringify(result).includes(PRIVATE_MARKER), false);
  });
  await test("executor success must bind every prepared action identity field exactly", async () => {
    const mutations = [
      ["candidate_id", "forged-candidate-999"],
      ["state_revision", 999],
      ["current_session_identity", SESSION_SOURCE],
      ["claim_attempt_id", "123e4567-e89b-42d3-a456-426614174001"],
      ["target", { runtime_id: "claude", session_identity: SESSION_SOURCE }],
      ["target", { runtime_id: "codex", session_identity: SESSION_OWNER }],
      ["action_kind", "not_manual_resume"],
    ];
    for (const [field, value] of mutations) {
      const built = build({
        executor: {
          resolveAndResume: async () => success({ ...receipt(), [field]: value }),
        },
      });
      const result = await built.composition.executeManualResume(request());
      assert.deepEqual(result, { ok: false, reason: "manual_resume_action_request_unavailable" }, field);
    }

    const missing = { ...receipt() };
    delete missing.claim_attempt_id;
    const missingResult = await build({ executor: { resolveAndResume: async () => success(missing) } }).composition.executeManualResume(request());
    assert.deepEqual(missingResult, { ok: false, reason: "manual_resume_action_request_unavailable" }, "missing claim_attempt_id");

    const extra = { ...receipt(), native_session_id: "native-private-marker" };
    const extraResult = await build({ executor: { resolveAndResume: async () => success(extra) } }).composition.executeManualResume(request());
    assert.deepEqual(extraResult, { ok: false, reason: "manual_resume_action_request_unavailable" }, "extra native field");

    const valid = await build().composition.executeManualResume(request());
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.value.target, { runtime_id: "codex", session_identity: SESSION_SOURCE });
  });
});

await group("dependency and lifecycle boundaries", async () => {
  await test("manual resume factory is not invoked for unsupported Claude", async () => {
    let factoryCalls = 0;
    const built = build({
      stateReads: [state("claude")],
      manualResumeServiceFactory: () => { factoryCalls += 1; throw new Error(PRIVATE_MARKER); },
    });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_runtime_unsupported" });
    assert.equal(factoryCalls, 0);
  });
  await test("parallel compositions keep Store, Claim, and executors isolated", async () => {
    const first = build();
    const second = build({ stateReads: [state("claude")] });
    const [a, b] = await Promise.all([
      first.composition.executeManualResume(request({ candidate_id: "composition-candidate-001" })),
      second.composition.executeManualResume(request({ candidate_id: "composition-candidate-001" })),
    ]);
    assert.equal(a.ok, true);
    assert.deepEqual(b, { ok: false, reason: "manual_resume_runtime_unsupported" });
    assert.equal(first.calls.filter(([name]) => name === "codex.resolveAndResume").length, 1);
    assert.equal(second.calls.filter(([name]) => name === "codex.resolveAndResume").length, 0);
  });
});

await group("Makefile composition wiring", async () => {
  await test("declares the composition target after Claude resolution", () => {
    assert.match(MAKEFILE_SOURCE, /^test-pending-handoff-manual-resume-runtime-composition-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-manual-resume-runtime-composition-fixtures\.mjs$/m);
    assert.equal((MAKEFILE_SOURCE.match(/test-pending-handoff-manual-resume-runtime-composition-fixtures/g) ?? []).length, 4);
    assert.ok(MAKEFILE_SOURCE.indexOf("test-pending-handoff-claude-runtime-adapter-fixtures") < MAKEFILE_SOURCE.indexOf("test-pending-handoff-manual-resume-runtime-composition-fixtures"));
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS RC 0\n`);
