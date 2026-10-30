import assert from "node:assert/strict";
import fs from "node:fs";
import * as moduleNamespace from "./lib/pending-handoff-manual-resume-runtime-composition.mjs";
import { PENDING_HANDOFF_SCHEMA_VERSION } from "./lib/pending-handoff-core.mjs";
import { createPendingHandoffManualResumeService } from "./lib/pending-handoff-manual-resume.mjs";

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

function state(sourceRuntime = "codex", stateRevision = 1) {
  return Object.freeze({ candidate: Object.freeze(candidate(sourceRuntime)), state_revision: stateRevision, claim: null });
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

function capabilityContextResult(candidateId, runtimeId, overrides = {}) {
  const taskId = "RPL-120-manual-resume";
  const persistedCandidate = overrides.persistedCandidate ?? {
    candidate_id: candidateId,
    state_revision: 1,
    source_runtime: runtimeId,
    source_session_identity: SESSION_SOURCE,
    repository_identity: REPOSITORY,
    worktree_identity: WORKTREE,
  };
  const scopeRef = overrides.scopeRef ?? candidateId;
  const environmentFingerprint = overrides.environmentFingerprint ?? "manual-resume-env-v1";
  const environmentRuntimeId = overrides.environmentRuntimeId ?? runtimeId;
  const testPlan = { id: "manual-resume-fixtures", digest: "a".repeat(64) };
  const sha = "b".repeat(40);
  const treeSha = "c".repeat(40);
  const task = {
    task_id: taskId,
    scope_ref: scopeRef,
    requirements: {
      capabilities: ["git"],
      approval_required: false,
      capability_scopes: {
        git: { operation: "read", resource: "repo:ranikun-labs/oh-my-ai" },
      },
    },
  };
  const environment = {
    provider_id: "synthetic-manual-resume",
    fingerprint: environmentFingerprint,
    runtime_id: environmentRuntimeId,
    capabilities: {
      git: {
        status: overrides.capabilityStatus ?? "available",
        verified: true,
        evidence_ref: "synthetic-manual-resume-git-evidence",
        observed_at: new Date().toISOString(),
        provider_id: "synthetic-manual-resume",
        runtime_id: environmentRuntimeId,
        environment_fingerprint: environmentFingerprint,
        capability: "git",
        task_id: taskId,
        scope_ref: scopeRef,
        operation: "read",
        resource: "repo:ranikun-labs/oh-my-ai",
        reason: overrides.capabilityStatus === "unavailable" ? "synthetic blocked" : "",
      },
    },
  };
  const checkpoint = {
    candidate_id: persistedCandidate.candidate_id,
    state_revision: persistedCandidate.state_revision,
    status: "interrupted",
    repo: "ranikun-labs/oh-my-ai",
    repository_identity: persistedCandidate.repository_identity,
    worktree_identity: persistedCandidate.worktree_identity,
    sha,
    tree_sha: treeSha,
    environment_fingerprint: environmentFingerprint,
    next_step: "resume the approved candidate",
    test_evidence: {
      candidate_id: persistedCandidate.candidate_id,
      state_revision: persistedCandidate.state_revision,
      status: overrides.testStatus ?? "passed",
      evidence_ref: "synthetic-manual-resume-test-evidence",
      repo: "ranikun-labs/oh-my-ai",
      repository_identity: persistedCandidate.repository_identity,
      worktree_identity: persistedCandidate.worktree_identity,
      plan_id: testPlan.id,
      plan_digest: testPlan.digest,
      sha,
      tree_sha: treeSha,
      environment_fingerprint: environmentFingerprint,
    },
  };
  const current = {
    candidate_id: persistedCandidate.candidate_id,
    state_revision: persistedCandidate.state_revision,
    repo: "ranikun-labs/oh-my-ai",
    repository_identity: persistedCandidate.repository_identity,
    worktree_identity: persistedCandidate.worktree_identity,
    sha,
    tree_sha: treeSha,
    environment_fingerprint: environmentFingerprint,
    test_plan: testPlan,
  };
  return {
    task,
    environment,
    evidenceVerifiers: {
      verifyApproval: () => true,
      verifyCapabilityEvidence: overrides.verifyCapabilityEvidence ?? ((evidence, context) => (
        evidence.evidence_ref === "synthetic-manual-resume-git-evidence"
          && evidence.provider_id === context.provider_id
          && evidence.runtime_id === context.runtime_id
          && evidence.environment_fingerprint === context.environment_fingerprint
          && evidence.capability === context.capability
          && evidence.task_id === context.task_id
          && evidence.scope_ref === context.scope_ref
          && evidence.operation === context.requested_scope.operation
          && evidence.resource === context.requested_scope.resource
      )),
    },
    verifyManualResumeBinding: overrides.verifyManualResumeBinding ?? (binding => (
      binding.persisted_candidate.candidate_id === persistedCandidate.candidate_id
        && binding.persisted_candidate.state_revision === persistedCandidate.state_revision
        && binding.persisted_candidate.source_runtime === persistedCandidate.source_runtime
        && binding.persisted_candidate.source_session_identity === persistedCandidate.source_session_identity
        && binding.persisted_candidate.repository_identity === persistedCandidate.repository_identity
        && binding.persisted_candidate.worktree_identity === persistedCandidate.worktree_identity
        && binding.task.scope_ref === persistedCandidate.candidate_id
        && binding.task.capability_scopes.git.resource === "repo:ranikun-labs/oh-my-ai"
        && binding.checkpoint.candidate_id === persistedCandidate.candidate_id
        && binding.checkpoint.state_revision === persistedCandidate.state_revision
        && binding.checkpoint.repository_identity === persistedCandidate.repository_identity
        && binding.checkpoint.worktree_identity === persistedCandidate.worktree_identity
        && binding.current.candidate_id === persistedCandidate.candidate_id
        && binding.current.state_revision === persistedCandidate.state_revision
        && binding.current.repository_identity === persistedCandidate.repository_identity
        && binding.current.worktree_identity === persistedCandidate.worktree_identity
        && binding.test_evidence.candidate_id === persistedCandidate.candidate_id
        && binding.test_evidence.state_revision === persistedCandidate.state_revision
        && binding.test_evidence.repository_identity === persistedCandidate.repository_identity
        && binding.test_evidence.worktree_identity === persistedCandidate.worktree_identity
    )),
    checkpoint,
    current,
    verifyTestEvidence: (evidence, expected) => (
      evidence.evidence_ref === "synthetic-manual-resume-test-evidence"
        && evidence.repo === expected.repo
        && evidence.candidate_id === expected.candidate_id
        && evidence.state_revision === expected.state_revision
        && evidence.repository_identity === expected.repository_identity
        && evidence.worktree_identity === expected.worktree_identity
        && evidence.sha === expected.sha
        && evidence.tree_sha === expected.tree_sha
        && evidence.environment_fingerprint === expected.environment_fingerprint
        && evidence.plan_id === expected.test_plan.id
        && evidence.plan_digest === expected.test_plan.digest
    ),
  };
}

function build(options = {}) {
  const calls = [];
  let serviceFactoryCalls = 0;
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
    acquireClaimForDispatch: async request => {
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
  const manualResumeServiceFactory = options.manualResumeServiceFactory ?? (serviceDependencies => {
    serviceFactoryCalls += 1;
    return createPendingHandoffManualResumeService(serviceDependencies);
  });
  const capabilityContext = {
    resolveManualResumeContext: async input => {
      calls.push(["resolveManualResumeContext", input]);
      if (options.capabilityContextFailure === true) throw new Error(PRIVATE_MARKER);
      if (options.capabilityContextResult !== undefined) {
        return typeof options.capabilityContextResult === "function"
          ? options.capabilityContextResult(input)
          : options.capabilityContextResult;
      }
      return capabilityContextResult(input.candidate_id, input.runtime_id, {
        persistedCandidate: input.persisted_candidate,
      });
    },
  };
  const dependencies = {
    store,
    claimLease,
    runtimeEntries: [
      { runtime_id: "codex", sessionResolution: codexResolution, manualResumeAction: { supported: true, executor } },
      { runtime_id: "claude", sessionResolution: claudeResolution, manualResumeAction: { supported: false } },
    ],
    manualResumeServiceFactory,
  };
  if (options.omitCapabilityContext !== true) dependencies.capabilityContext = capabilityContext;
  const built = moduleNamespace.createPendingHandoffManualResumeRuntimeComposition(dependencies);
  if (options.omitCapabilityContext === true) {
    assert.equal(built.ok, false);
    return {
      built,
      composition: null,
      calls,
      store,
      claimLease,
      get serviceFactoryCalls() { return serviceFactoryCalls; },
    };
  }
  assert.equal(built.ok, true);
  return {
    built,
    composition: built.value,
    calls,
    store,
    claimLease,
    get serviceFactoryCalls() { return serviceFactoryCalls; },
  };
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
      claimLease: { acquireClaimForDispatch: async () => success({}) },
      runtimeEntries: [{
        runtime_id: "codex",
        sessionResolution: build().composition,
        manualResumeAction: { supported: true },
      }],
      capabilityContext: {
        resolveManualResumeContext: async input => capabilityContextResult(
          input.candidate_id,
          input.runtime_id,
        ),
      },
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

await group("F4 capability and checkpoint preflight", async () => {
  await test("stale initial revision blocks capability preflight before the later service read", async () => {
    const built = build({
      stateReads: index => state("codex", index === 0 ? 1 : 2),
    });
    const result = await built.composition.executeManualResume(request({ expected_revision: 2 }));
    assert.deepEqual(result, { ok: false, reason: "manual_resume_revision_conflict" });
    assert.deepEqual(built.calls.map(([name]) => name), ["readState"]);
    assert.equal(built.serviceFactoryCalls, 0);
    assert.equal(built.calls.some(([name]) => name === "resolveManualResumeContext"), false);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("claimed attempt replay is blocked before capability context or executor", async () => {
    const claimedCandidate = candidate("codex");
    claimedCandidate.status = "claimed";
    const built = build({
      stateReads: [{
        candidate: Object.freeze(claimedCandidate),
        state_revision: 2,
        claim: Object.freeze({
          claim_attempt_id: ATTEMPT,
          current_session_identity: SESSION_OWNER,
          claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
        }),
      }],
    });
    const result = await built.composition.executeManualResume(request({ expected_revision: 1 }));
    assert.deepEqual(result, { ok: false, reason: "manual_resume_revision_conflict" });
    assert.deepEqual(built.calls.map(([name]) => name), ["readState"]);
    assert.equal(built.serviceFactoryCalls, 0);
  });

  await test("a restart with the persisted claimed revision cannot redispatch the attempt", async () => {
    const claimedCandidate = candidate("codex");
    claimedCandidate.status = "claimed";
    const persistedClaim = Object.freeze({
      claim_owner_identity: SESSION_OWNER,
      claim_started_at: "2026-08-01T00:00:00.000Z",
      claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
      claim_attempt_id: ATTEMPT,
    });
    const claimedState = Object.freeze({
      candidate: Object.freeze(claimedCandidate),
      state_revision: 2,
      claim: persistedClaim,
    });
    const calls = [];
    const built = build({
      store: { readState: async () => success(claimedState) },
      executor: { resolveAndResume: async () => {
        calls.push("dispatch");
        return success(receipt());
      } },
    });
    const result = await built.composition.executeManualResume(request({ expected_revision: 2 }));
    assert.deepEqual(result, { ok: false, reason: "manual_resume_revision_conflict" });
    assert.equal(calls.includes("dispatch"), false);
    assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
  });

  await test("missing capability-context adapter makes composition unavailable", () => {
    const built = build({ omitCapabilityContext: true });
    assert.deepEqual(built.built, {
      ok: false,
      reason: "manual_resume_runtime_dependency_invalid",
    });
    assert.deepEqual(built.calls, []);
    assert.equal(built.serviceFactoryCalls, 0);
  });

  await test("missing runtime context evidence fails before service, Claim, or executor", async () => {
    const built = build({ capabilityContextFailure: true });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, {
      ok: false,
      reason: "manual_resume_capability_preflight_blocked",
    });
    assert.deepEqual(built.calls.map(([name]) => name), [
      "readState",
      "resolveManualResumeContext",
    ]);
    assert.equal(built.serviceFactoryCalls, 0);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("missing trusted handoff-binding verifier fails before service and Claim", async () => {
    const context = capabilityContextResult("composition-candidate-001", "codex");
    delete context.verifyManualResumeBinding;
    const built = build({ capabilityContextResult: context });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, {
      ok: false,
      reason: "manual_resume_capability_preflight_blocked",
    });
    assert.equal(built.serviceFactoryCalls, 0);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("blocked capability cannot create service, Claim, or executor action", async () => {
    const context = capabilityContextResult(
      "composition-candidate-001",
      "codex",
      { capabilityStatus: "unavailable" },
    );
    const built = build({ capabilityContextResult: context });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, {
      ok: false,
      reason: "manual_resume_capability_preflight_blocked",
    });
    assert.deepEqual(built.calls.map(([name]) => name), [
      "readState",
      "resolveManualResumeContext",
    ]);
    assert.equal(built.serviceFactoryCalls, 0);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("candidate scope mismatch cannot reach service, Claim, or executor", async () => {
    const context = capabilityContextResult(
      "composition-candidate-001",
      "codex",
      { scopeRef: "different-persisted-candidate" },
    );
    const built = build({ capabilityContextResult: context });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, {
      ok: false,
      reason: "manual_resume_capability_preflight_blocked",
    });
    assert.equal(built.serviceFactoryCalls, 0);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("checkpoint evidence failure cannot reach service, Claim, or executor", async () => {
    const context = capabilityContextResult(
      "composition-candidate-001",
      "codex",
      { testStatus: "failed" },
    );
    const built = build({ capabilityContextResult: context });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, {
      ok: false,
      reason: "manual_resume_capability_preflight_blocked",
    });
    assert.equal(built.serviceFactoryCalls, 0);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("repository, worktree, or revision mismatch cannot bind another handoff", async () => {
    const mutations = [
      context => { context.checkpoint.repository_identity = `phr1.repository.key_A-1.${"X".repeat(43)}`; },
      context => { context.current.worktree_identity = `phr1.worktree.key_A-1.${"Y".repeat(43)}`; },
      context => { context.checkpoint.test_evidence.state_revision += 1; },
    ];
    for (const mutate of mutations) {
      const context = capabilityContextResult("composition-candidate-001", "codex");
      mutate(context);
      const built = build({ capabilityContextResult: context });
      const result = await built.composition.executeManualResume(request());
      assert.deepEqual(result, {
        ok: false,
        reason: "manual_resume_capability_preflight_blocked",
      });
      assert.equal(built.serviceFactoryCalls, 0);
      assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
      assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
    }
  });

  await test("Codex cannot consume Claude runtime capability evidence", async () => {
    let verifierCalls = 0;
    const context = capabilityContextResult(
      "composition-candidate-001",
      "codex",
      {
        environmentRuntimeId: "claude",
        verifyCapabilityEvidence: () => {
          verifierCalls += 1;
          return true;
        },
      },
    );
    const built = build({ capabilityContextResult: context });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, {
      ok: false,
      reason: "manual_resume_capability_preflight_blocked",
    });
    assert.equal(verifierCalls, 0);
    assert.equal(built.serviceFactoryCalls, 0);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("an own __proto__ extra scope is preserved and rejected", async () => {
    const context = capabilityContextResult("composition-candidate-001", "codex");
    Object.defineProperty(context.task.requirements.capability_scopes, "__proto__", {
      value: { operation: "read", resource: "repo:unrequested/extra" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const built = build({ capabilityContextResult: context });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, {
      ok: false,
      reason: "manual_resume_capability_preflight_blocked",
    });
    assert.equal(built.serviceFactoryCalls, 0);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });
});

await group("supported Codex delegation and drift safety", async () => {
  await test("reserves the same attempt against concurrent calls across composition instances", async () => {
    let releaseAction;
    const actionBarrier = new Promise(resolve => { releaseAction = resolve; });
    let notifyActionStarted;
    const actionStarted = new Promise(resolve => { notifyActionStarted = resolve; });
    let dispatches = 0;
    const executor = {
      resolveAndResume: async () => {
        dispatches += 1;
        notifyActionStarted();
        await actionBarrier;
        return success(receipt());
      },
    };
    const first = build({ executor });
    const second = build({ executor });
    const firstExecution = first.composition.executeManualResume(request());
    await actionStarted;

    const secondResult = await second.composition.executeManualResume(request());
    assert.deepEqual(secondResult, { ok: false, reason: "manual_resume_attempt_in_progress" });
    assert.equal(second.calls.length, 0);
    assert.equal(dispatches, 1);

    releaseAction();
    const firstResult = await firstExecution;
    assert.equal(firstResult.ok, true);
    assert.equal(dispatches, 1);
  });

  await test("Codex delegates through Core, Claim, then the exact executor", async () => {
    const built = build();
    const result = await built.composition.executeManualResume(request());
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.target, { runtime_id: "codex", session_identity: SESSION_SOURCE });
    assert.deepEqual(built.calls.map(([name]) => name), [
      "readState",
      "resolveManualResumeContext",
      "readState",
      "codex.resolveCurrentSession",
      "codex.resolveTargetSession",
      "acquireClaim",
      "codex.resolveAndResume",
    ]);
    assert.deepEqual(built.calls[1], [
      "resolveManualResumeContext",
      {
        candidate_id: "composition-candidate-001",
        runtime_id: "codex",
        persisted_candidate: {
          candidate_id: "composition-candidate-001",
          state_revision: 1,
          source_runtime: "codex",
          source_session_identity: SESSION_SOURCE,
          repository_identity: REPOSITORY,
          worktree_identity: WORKTREE,
        },
      },
    ]);
    assert.equal(built.serviceFactoryCalls, 1);
    assert.equal(built.calls.filter(([name]) => name === "codex.resolveAndResume").length, 1);
  });
  await test("second Core read changing runtime cannot reach Claim or Codex executor", async () => {
    const built = build({ stateReads: [state("codex"), state("claude")] });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_runtime_unsupported" });
    assert.equal(built.calls.filter(([name]) => name === "acquireClaim").length, 0);
    assert.equal(built.calls.filter(([name]) => name === "codex.resolveAndResume").length, 0);
  });
  await test("supported capability with executor failure remains sanitized", async () => {
    const executorCalls = [];
    const built = build({ executor: { resolveAndResume: async request => {
      executorCalls.push(request);
      return { ok: false, reason: "codex_action_unavailable" };
    } } });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_action_outcome_unknown" });
    assert.equal(executorCalls.length, 1);
    assert.equal(JSON.stringify(result).includes(PRIVATE_MARKER), false);
  });

  await test("a persisted Claim with an unconfirmed action request is quarantined", async () => {
    let executorCalls = 0;
    let claimCalls = 0;
    const built = build({
      claimLease: {
        acquireClaimForDispatch: async () => {
          claimCalls += 1;
          return success({
            state_revision: 3,
            claim_attempt_id: ATTEMPT,
            claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
          });
        },
      },
      executor: { resolveAndResume: async () => {
        executorCalls += 1;
        return success(receipt());
      } },
    });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_claim_outcome_unknown" });
    assert.equal(executorCalls, 0);
    assert.equal(claimCalls, 1);
  });

  await test("a same-attempt Claim replay is never treated as fresh dispatch authority", async () => {
    let executorCalls = 0;
    let claimCalls = 0;
    const built = build({
      claimLease: {
        acquireClaimForDispatch: async () => {
          claimCalls += 1;
          return failure("claim_conflict");
        },
      },
      executor: { resolveAndResume: async () => {
        executorCalls += 1;
        return success(receipt());
      } },
    });

    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_claim_outcome_unknown" });
    assert.equal(claimCalls, 1);
    assert.equal(executorCalls, 0);
  });

  await test("an accepted action with a lost receipt remains unknown across restart", async () => {
    let stored = state();
    let runtimeAccepted = false;
    const dispatches = [];
    const store = {
      readState: async () => success(stored),
    };
    const claimLease = {
      acquireClaimForDispatch: async requestValue => {
        const claimedCandidate = candidate("codex");
        claimedCandidate.status = "claimed";
        stored = Object.freeze({
          candidate: Object.freeze(claimedCandidate),
          state_revision: 2,
          claim: Object.freeze({
            claim_owner_identity: requestValue.current_session_identity,
            claim_started_at: "2026-08-01T00:00:00.000Z",
            claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
            claim_attempt_id: requestValue.claim_attempt_id,
          }),
        });
        return success({
          state_revision: 2,
          claim_attempt_id: requestValue.claim_attempt_id,
          claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
        });
      },
    };
    const first = build({
      store,
      claimLease,
      executor: { resolveAndResume: async () => {
        dispatches.push("accepted-then-receipt-lost");
        runtimeAccepted = true;
        throw new Error(PRIVATE_MARKER);
      } },
    });
    const firstResult = await first.composition.executeManualResume(request());
    assert.deepEqual(firstResult, { ok: false, reason: "manual_resume_action_outcome_unknown" });
    assert.equal(runtimeAccepted, true);
    assert.equal(dispatches.length, 1);

    const restarted = build({
      store,
      claimLease,
      executor: { resolveAndResume: async () => {
        dispatches.push("duplicate");
        return success(receipt());
      } },
    });
    const afterRestart = await restarted.composition.executeManualResume(request({ expected_revision: 2 }));
    assert.deepEqual(afterRestart, { ok: false, reason: "manual_resume_revision_conflict" });
    assert.equal(dispatches.length, 1);
  });

  await test("Claim response loss after persistence blocks the first Runtime dispatch", async () => {
    let stored = state();
    let claimAttempted = 0;
    let dispatches = 0;
    const store = { readState: async () => success(stored) };
    const claimLease = {
      acquireClaimForDispatch: async requestValue => {
        claimAttempted += 1;
        const claimedCandidate = candidate("codex");
        claimedCandidate.status = "claimed";
        stored = Object.freeze({
          candidate: Object.freeze(claimedCandidate),
          state_revision: 2,
          claim: Object.freeze({
            claim_owner_identity: requestValue.current_session_identity,
            claim_started_at: "2026-08-01T00:00:00.000Z",
            claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
            claim_attempt_id: requestValue.claim_attempt_id,
          }),
        });
        throw new Error(PRIVATE_MARKER);
      },
    };
    const built = build({
      store,
      claimLease,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        return success(receipt());
      } },
    });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_claim_outcome_unknown" });
    assert.equal(claimAttempted, 1);
    assert.equal(dispatches, 0);
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
      assert.deepEqual(result, { ok: false, reason: "manual_resume_action_outcome_unknown" }, field);
    }

    const missing = { ...receipt() };
    delete missing.claim_attempt_id;
    const missingResult = await build({ executor: { resolveAndResume: async () => success(missing) } }).composition.executeManualResume(request());
    assert.deepEqual(missingResult, { ok: false, reason: "manual_resume_action_outcome_unknown" }, "missing claim_attempt_id");

    const extra = { ...receipt(), native_session_id: "native-private-marker" };
    const extraResult = await build({ executor: { resolveAndResume: async () => success(extra) } }).composition.executeManualResume(request());
    assert.deepEqual(extraResult, { ok: false, reason: "manual_resume_action_outcome_unknown" }, "extra native field");

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
    const claudeCandidate = candidate("claude");
    claudeCandidate.candidate_id = "composition-candidate-002";
    const second = build({ stateReads: [{
      candidate: Object.freeze(claudeCandidate),
      state_revision: 1,
      claim: null,
    }] });
    const [a, b] = await Promise.all([
      first.composition.executeManualResume(request({ candidate_id: "composition-candidate-001" })),
      second.composition.executeManualResume(request({ candidate_id: "composition-candidate-002" })),
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
