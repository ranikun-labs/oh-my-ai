import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as moduleNamespace from "./lib/pending-handoff-manual-resume-runtime-composition.mjs";
import * as f4NativeCompositionNamespace from "./lib/f4-native-runtime-composition.mjs";
import { createF4ScopePreservingCheckpoint } from "./lib/f4-scope-preservation-checkpoint.mjs";
import { PENDING_HANDOFF_SCHEMA_VERSION } from "./lib/pending-handoff-core.mjs";
import { createPendingHandoffManualResumeService } from "./lib/pending-handoff-manual-resume.mjs";
import {
  createPendingHandoffManualResumeAttemptOutcomeStoreAdapter,
} from "./lib/pending-handoff-manual-resume-attempt-outcome-store-adapter.mjs";

const SESSION_SOURCE = `phr1.session.key_A-1.${"S".repeat(43)}`;
const SESSION_OWNER = `phr1.session.key_A-1.${"O".repeat(43)}`;
const REPOSITORY = `phr1.repository.key_A-1.${"R".repeat(43)}`;
const WORKTREE = `phr1.worktree.key_A-1.${"W".repeat(43)}`;
const ATTEMPT = "123e4567-e89b-42d3-a456-426614174000";
const PRIVATE_MARKER = "composition-private-marker";
const MAKEFILE_SOURCE = fs.readFileSync(new URL("../Makefile", import.meta.url), "utf8");
const FIXTURE_SCOPE = Object.freeze({
  objectiveId: "F4-TEST-OBJECTIVE",
  scopeRevision: "owner-approved-test-scope-1",
  source: {
    uri: "https://ranikunlabs.atlassian.net/browse/RPL-120",
    revision: "owner-approved-test-scope-1",
    coverage: "COMPLETE",
  },
  requiredSources: [{ uri: "https://ranikunlabs.atlassian.net/rest/api/3/search" }],
  items: [
    { id: "RPL-120", primaryJira: "RPL-120", owner: "F4" },
    { id: "BLOCKED-OTHER", primaryJira: "RPL-999", owner: "F9" },
  ],
});

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
  const environmentProviderId = overrides.environmentProviderId ?? "synthetic-manual-resume";
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
    provider_id: environmentProviderId,
    fingerprint: environmentFingerprint,
    runtime_id: environmentRuntimeId,
    capabilities: {
      git: {
        status: overrides.capabilityStatus ?? "available",
        verified: true,
        evidence_ref: "synthetic-manual-resume-git-evidence",
        observed_at: new Date().toISOString(),
        provider_id: environmentProviderId,
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

function capabilityMvpContextResult(candidateId, runtimeId, overrides = {}) {
  const taskId = "RPL-120-f4-native-runtime";
  const providerId = overrides.providerId ?? "synthetic-rpl118-runtime";
  const environmentFingerprint = "synthetic-rpl118-environment-v1";
  const now = new Date().toISOString();
  const source = {
    source_id: "code-execution",
    capability: "e2e",
    tool_id: "synthetic-runtime:execute",
    permission: {
      kind: "CODE_EXECUTION",
      scope: "candidate:" + candidateId,
    },
    operation: "run",
    resource: "environment:codex",
    source_revision: "runtime-attestation:1",
  };
  const scopeRef = overrides.scopeRef ?? candidateId;
  const runtimeEvidenceRuntimeId = overrides.runtimeEvidenceRuntimeId ?? runtimeId;
  const environmentRuntimeId = overrides.environmentRuntimeId ?? runtimeId;
  const fingerprint = overrides.environmentFingerprint ?? environmentFingerprint;
  const task = {
    task_id: taskId,
    scope_ref: scopeRef,
    task_kind: "CODE_EXECUTION",
    sources: [source],
    policy_evidence: {
      decision: "allow",
      task_kind: "CODE_EXECUTION",
      scope_ref: scopeRef,
      approval_required: false,
      evidence_ref: "synthetic-policy:" + taskId,
    },
    runtime_evidence: {
      verified: true,
      provider_id: providerId,
      runtime_id: runtimeEvidenceRuntimeId,
      environment_fingerprint: fingerprint,
      observed_at: now,
      evidence_ref: "synthetic-runtime:" + taskId,
    },
    source_scope_evidence: {
      scope_ref: scopeRef,
      evidence_ref: "synthetic-source-scope:" + taskId,
      source_ids: [source.source_id],
    },
  };
  const observation = {
    status: overrides.capabilityStatus ?? "available",
    verified: true,
    evidence_ref: "synthetic-capability:code-execution",
    observed_at: overrides.staleObservation === true
      ? new Date(Date.now() - 10 * 60 * 1000).toISOString()
      : now,
    provider_id: providerId,
    runtime_id: environmentRuntimeId,
    environment_fingerprint: fingerprint,
    capability: source.capability,
    task_id: taskId,
    scope_ref: scopeRef,
    operation: source.operation,
    resource: source.resource,
    tool_id: source.tool_id,
    permission: { ...source.permission },
    source_revision: source.source_revision,
    reason: overrides.capabilityStatus === "unavailable" ? "synthetic unavailable" : "",
  };
  const environment = {
    provider_id: providerId,
    runtime_id: environmentRuntimeId,
    fingerprint,
    capabilities: { e2e: observation },
  };

  if (overrides.handoff === true) {
    task.handoff_destination = {
      connected: true,
      verified: true,
      destination_id: "synthetic-same-runtime",
      provider_id: providerId,
      runtime_id: runtimeEvidenceRuntimeId,
      environment_fingerprint: fingerprint,
      tool_id: source.tool_id,
      operation: source.operation,
      resource_scope: source.resource,
      permission_scope: source.permission.scope,
      scope_ref: scopeRef,
      evidence_ref: "synthetic-handoff:" + taskId,
      observed_at: now,
    };
  }

  const trustedVerifiers = {
    verifyPolicyEvidence(evidence, context) {
      return evidence.evidence_ref === "synthetic-policy:" + context.task_id
        && evidence.task_kind === context.task_kind
        && evidence.scope_ref === context.scope_ref;
    },
    verifySourceScopeEvidence(evidence, context) {
      return evidence.evidence_ref === "synthetic-source-scope:" + context.task_id
        && evidence.scope_ref === context.scope_ref
        && JSON.stringify(evidence.source_ids)
          === JSON.stringify(context.required_sources.map(item => item.source_id));
    },
    verifyCurrentRuntimeEvidence(evidence, context) {
      return evidence.evidence_ref === "synthetic-runtime:" + context.task_id
        && evidence.runtime_id === context.current_runtime_id
        && evidence.provider_id === providerId
        && evidence.environment_fingerprint === fingerprint;
    },
    verifyCapabilityEvidence(evidence, context) {
      return evidence.evidence_ref === "synthetic-capability:code-execution"
        && evidence.runtime_id === context.runtime_id
        && evidence.provider_id === context.provider_id
        && evidence.environment_fingerprint === context.environment_fingerprint
        && evidence.capability === context.capability
        && evidence.task_id === context.task_id
        && evidence.scope_ref === context.scope_ref
        && evidence.operation === context.operation
        && evidence.resource === context.resource
        && evidence.source_revision === context.source_revision;
    },
    verifySourceEvidence(evidence, context) {
      return evidence.tool_id === context.tool_id
        && evidence.permission.kind === context.permission.kind
        && evidence.permission.scope === context.permission.scope
        && evidence.operation === context.operation
        && evidence.resource === context.resource
        && evidence.source_revision === context.source_revision;
    },
    verifyHandoffDestination(evidence, context) {
      return evidence.evidence_ref === "synthetic-handoff:" + context.task_id
        && evidence.scope_ref === context.scope_ref
        && evidence.connected === true
        && evidence.runtime_id === context.current_runtime.runtime_id
        && evidence.provider_id === context.current_runtime.provider_id
        && evidence.environment_fingerprint === context.current_runtime.environment_fingerprint
        && evidence.tool_id === source.tool_id
        && evidence.operation === source.operation
        && evidence.resource_scope === source.resource
        && evidence.permission_scope === source.permission.scope;
    },
  };
  return { task, environment, trustedVerifiers };
}

function userLocalStateFixture(records = new Map()) {
  const stats = { locations: [], readPaths: [], reads: 0, publishes: 0, locks: 0, asyncLockCallbacks: 0 };
  let publishDurabilityUnknown = false;
  const defaultRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "f4-user-state-"));
  const overrideRootPaths = new Map();
  function rootPathFor(override) {
    if (override === undefined || override === null || override === "") return defaultRootPath;
    if (!overrideRootPaths.has(override)) {
      overrideRootPaths.set(override, fs.mkdtempSync(path.join(os.tmpdir(), "f4-user-state-override-")));
    }
    return overrideRootPaths.get(override);
  }
  const api = Object.freeze({
    resolveUserLocalStateLocation(cwd, relativePath, options) {
      const key = JSON.stringify([cwd, options?.stateRootOverride ?? null, relativePath]);
      stats.locations.push(relativePath);
      return Object.freeze({
        cwd,
        relativePath,
        key,
        rootPath: rootPathFor(options?.stateRootOverride),
        repositoryRoot: cwd,
        repositoryId: "a".repeat(64),
        worktreeId: "b".repeat(64),
      });
    },
    readUserLocalState(location) {
      stats.reads += 1;
      stats.readPaths.push(location.relativePath);
      return records.get(location.key) ?? null;
    },
    publishUserLocalStateAtomically(location, contents) {
      stats.publishes += 1;
      records.set(location.key, contents);
      if (publishDurabilityUnknown) {
        publishDurabilityUnknown = false;
        const error = new Error(PRIVATE_MARKER);
        error.code = "state_publish_durability_unknown";
        throw error;
      }
      return Object.freeze({ published: true, byteLength: contents.length });
    },
    withPhysicalStateLock(_location, operation) {
      stats.locks += 1;
      const result = operation();
      if (result && typeof result.then === "function") {
        stats.asyncLockCallbacks += 1;
        throw new Error("physical state lock callback returned a Promise");
      }
      return result;
    },
  });
  return {
    api,
    records,
    stats,
    setNextPublishDurabilityUnknown() { publishDurabilityUnknown = true; },
    replaceDefaultRoot() {
      fs.rmSync(defaultRootPath, { recursive: true, force: true });
      fs.mkdirSync(defaultRootPath, { recursive: true, mode: 0o700 });
      records.clear();
    },
  };
}

function seedDefaultScopeCheckpoint(userLocalState, cwd, stateRootOptions) {
  const projection = createF4ScopePreservingCheckpoint({
    approvedScope: FIXTURE_SCOPE,
    currentCheckpoint: null,
    expectedCheckpointRevision: null,
    refresh: {
      sourceUri: "https://ranikunlabs.atlassian.net/rest/api/3/search",
      sourceRevision: "jira-snapshot/f4-fixture-1",
      expectedPriorRevision: null,
      refreshScope: "FULL_SOURCE",
      coverage: "COMPLETE",
      partialReasons: [],
      observations: [
        { id: "RPL-120", status: "READY" },
        { id: "BLOCKED-OTHER", status: "BLOCKED" },
      ],
    },
    recentExecution: null,
    nextReadyId: "RPL-120",
    stopReason: null,
  });
  assert.equal(projection.ok, true, JSON.stringify(projection));
  const key = createHash("sha256").update(FIXTURE_SCOPE.objectiveId, "utf8").digest("hex");
  const location = userLocalState.api.resolveUserLocalStateLocation(
    cwd,
    `f4/scope-preservation-checkpoints/checkpoint-${key}.json`,
    stateRootOptions,
  );
  userLocalState.records.set(location.key, JSON.stringify({
    schema_version: 1,
    objective_id: FIXTURE_SCOPE.objectiveId,
    checkpoint: projection.checkpoint,
  }));
}

function fixtureApprovedWorkstream(workstreamId = "RPL-120", scopeRevision = FIXTURE_SCOPE.scopeRevision) {
  return {
    objectiveId: FIXTURE_SCOPE.objectiveId,
    scopeRevision,
    workstreamId,
    observedStatus: workstreamId === "RPL-120" ? "READY" : "BLOCKED",
    inventoryCoverage: "COMPLETE",
    inventorySourceUri: FIXTURE_SCOPE.requiredSources[0].uri,
    inventorySourceRevision: "jira-snapshot/f4-fixture-1",
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
  const defaultAttemptOutcome = options.attemptOutcomeStore === undefined
    ? createAttemptOutcomeFixtureStore()
    : { store: options.attemptOutcomeStore, records: null };
  const attemptOutcomeStore = defaultAttemptOutcome.store;
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
        ...(options.nativeComposition === true
          ? {
            environmentFingerprint: options.nativeEnvironmentFingerprint ?? "synthetic-rpl118-environment-v1",
            environmentProviderId: options.nativeEnvironmentProviderId ?? "synthetic-rpl118-runtime",
          }
          : {}),
      });
    },
  };
  const dependencies = {
    store,
    claimLease,
    attemptOutcomeStore,
    runtimeEntries: [
      { runtime_id: "codex", sessionResolution: codexResolution, manualResumeAction: { supported: true, executor } },
      { runtime_id: "claude", sessionResolution: claudeResolution, manualResumeAction: { supported: false } },
    ],
    manualResumeServiceFactory,
  };
  if (options.omitCapabilityContext !== true) dependencies.capabilityContext = capabilityContext;
  let built;
  let userLocalState;
  if (options.nativeComposition === true) {
    userLocalState = options.userLocalState ?? userLocalStateFixture();
    if (options.seedScopeCheckpoint !== false) {
      seedDefaultScopeCheckpoint(userLocalState, options.repositoryCwd ?? "/repo", options.stateRootOptions);
    }
    built = f4NativeCompositionNamespace.createPendingHandoffF4NativeRuntimeComposition({
      store,
      claimLease,
      runtimeEntries: dependencies.runtimeEntries,
      capabilityContext,
      userLocalState: userLocalState.api,
      repositoryCwd: options.repositoryCwd ?? "/repo",
      ...(options.omitWorktreeStateBindingVerifier === true ? {} : {
        verifyWorktreeStateBinding: options.verifyWorktreeStateBinding ?? (() => true),
      }),
      resolveCapabilityMvpContext: options.resolveCapabilityMvpContext ?? (input => {
        calls.push(["resolveCapabilityMvpContext", input]);
        if (options.capabilityMvpFailure === true) throw new Error(PRIVATE_MARKER);
        return capabilityMvpContextResult(input.candidate_id, input.runtime_id, options.capabilityMvpOverrides);
      }),
      ...(options.omitScopeResolver === true ? {} : {
        resolveApprovedWorkstreamForManualResume: options.resolveApprovedWorkstreamForManualResume
          ?? (() => fixtureApprovedWorkstream()),
      }),
      ...(options.stateRootOptions === undefined ? {} : { stateRootOptions: options.stateRootOptions }),
    });
  } else {
    built = moduleNamespace.createPendingHandoffManualResumeRuntimeComposition(dependencies);
  }
  if (options.omitCapabilityContext === true || options.omitScopeResolver === true) {
    assert.equal(built.ok, false);
    return {
      built,
      composition: null,
      calls,
      store,
      claimLease,
      attemptOutcomeStore,
      attemptOutcomeRecords: defaultAttemptOutcome.records,
      userLocalState,
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
    attemptOutcomeStore,
    attemptOutcomeRecords: defaultAttemptOutcome.records,
    userLocalState,
    get serviceFactoryCalls() { return serviceFactoryCalls; },
  };
}

function createAttemptOutcomeFixtureStore() {
  const records = new Map();
  const keyOf = ({ candidate_id, action_kind }) => JSON.stringify([candidate_id, action_kind]);
  return {
    records,
    store: {
      readAttempt: async identity => success(records.get(keyOf(identity)) ?? null),
      compareAndSetAttempt: async request => {
        const key = keyOf(request);
        const current = records.get(key) ?? null;
        if ((request.expected_revision === null && current !== null)
          || (request.expected_revision !== null && current?.revision !== request.expected_revision)) {
          return failure("revision_conflict");
        }
        records.set(key, request.next_record);
        return success(request.next_record);
      },
    },
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
  await test("requires the Manual Resume Attempt/Outcome CAS port", () => {
    const result = moduleNamespace.createPendingHandoffManualResumeRuntimeComposition({
      store: { readState: async () => success(state()) },
      claimLease: { acquireClaimForDispatch: async () => success({}) },
      runtimeEntries: [{
        runtime_id: "codex",
        sessionResolution: build().composition,
        manualResumeAction: { supported: true, executor: { resolveAndResume: async () => success(receipt()) } },
      }],
      capabilityContext: { resolveManualResumeContext: async input => capabilityContextResult(input.candidate_id, input.runtime_id) },
    });
    assert.deepEqual(result, { ok: false, reason: "manual_resume_runtime_dependency_invalid" });
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
    const started = await Promise.race([
      actionStarted.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 1000)),
    ]);
    if (!started) {
      throw new Error(`first dispatch was not reached: ${JSON.stringify(await firstExecution)} record=${JSON.stringify([...first.attemptOutcomeRecords.values()])}`);
    }

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
    const record = [...built.attemptOutcomeRecords.values()][0];
    assert.equal(record.status, "accepted");
    assert.equal(record.claim_revision, 2);
    assert.equal(record.actor_identity, SESSION_OWNER);
    assert.equal(record.action_kind, "manual_resume");
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
    assert.equal([...built.attemptOutcomeRecords.values()][0].status, "dispatch_unknown");
  });

  await test("durable Attempt ledger write failure blocks Claim and Runtime", async () => {
    let claimCalls = 0;
    let runtimeCalls = 0;
    const attemptOutcomeStore = createPendingHandoffManualResumeAttemptOutcomeStoreAdapter({
      recordStore: {
        readRecord: async () => success(null),
        compareAndSetRecord: async () => failure("root_unavailable"),
      },
    }).value;
    const built = build({
      attemptOutcomeStore,
      claimLease: {
        acquireClaimForDispatch: async () => {
          claimCalls += 1;
          return success({
            state_revision: 2,
            claim_attempt_id: ATTEMPT,
            claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
          });
        },
      },
      executor: { resolveAndResume: async () => {
        runtimeCalls += 1;
        return success(receipt());
      } },
    });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_attempt_store_unavailable" });
    assert.equal(claimCalls, 0);
    assert.equal(runtimeCalls, 0);
  });

  await test("a durable UNKNOWN Attempt blocks another composition and new Attempt ID", async () => {
    const shared = createAttemptOutcomeFixtureStore();
    let dispatches = 0;
    const first = build({
      attemptOutcomeStore: shared.store,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        throw new Error(PRIVATE_MARKER);
      } },
    });
    const firstResult = await first.composition.executeManualResume(request());
    assert.deepEqual(firstResult, { ok: false, reason: "manual_resume_action_outcome_unknown" });
    assert.equal([...shared.records.values()][0].status, "dispatch_unknown");

    const restarted = build({
      attemptOutcomeStore: shared.store,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        return success(receipt());
      } },
    });
    const retry = await restarted.composition.executeManualResume(request({
      claim_attempt_id: "223e4567-e89b-42d3-a456-426614174001",
    }));
    assert.deepEqual(retry, { ok: false, reason: "manual_resume_attempt_recovery_required" });
    assert.equal(restarted.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(dispatches, 1);
  });

  await test("Claim success without durable bind cannot call the Runtime", async () => {
    const shared = createAttemptOutcomeFixtureStore();
    let dispatches = 0;
    let claimWrites = 0;
    const attemptOutcomeStore = {
      readAttempt: shared.store.readAttempt,
      compareAndSetAttempt: async requestValue => {
        if (requestValue.expected_revision === 1) return failure("store_unavailable");
        return shared.store.compareAndSetAttempt(requestValue);
      },
    };
    const built = build({
      attemptOutcomeStore,
      claimLease: {
        acquireClaimForDispatch: async requestValue => {
          claimWrites += 1;
          return success({
            state_revision: 2,
            claim_attempt_id: requestValue.claim_attempt_id,
            claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
          });
        },
      },
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        return success(receipt());
      } },
    });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_claim_outcome_unknown" });
    assert.equal(claimWrites, 1);
    assert.equal(dispatches, 0);
    assert.equal([...shared.records.values()][0].status, "reserved");

    const restarted = build({
      attemptOutcomeStore: shared.store,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        return success(receipt());
      } },
    });
    const retry = await restarted.composition.executeManualResume(request({
      claim_attempt_id: "223e4567-e89b-42d3-a456-426614174001",
    }));
    assert.deepEqual(retry, { ok: false, reason: "manual_resume_attempt_recovery_required" });
    assert.equal(restarted.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(dispatches, 0);
  });

  await test("ACCEPTED is not completion and blocks a new Attempt", async () => {
    const shared = createAttemptOutcomeFixtureStore();
    const first = build({ attemptOutcomeStore: shared.store });
    assert.equal((await first.composition.executeManualResume(request())).ok, true);
    assert.equal([...shared.records.values()][0].status, "accepted");
    const restarted = build({ attemptOutcomeStore: shared.store });
    const next = await restarted.composition.executeManualResume(request({
      claim_attempt_id: "223e4567-e89b-42d3-a456-426614174001",
    }));
    assert.deepEqual(next, { ok: false, reason: "manual_resume_attempt_recovery_required" });
    assert.equal(restarted.calls.some(([name]) => name === "acquireClaim"), false);
  });

  await test("UNKNOWN Attempt stays quarantined after simulated Claim release and new Candidate revision", async () => {
    const shared = createAttemptOutcomeFixtureStore();
    let candidateRevision = 1;
    let claimActive = false;
    let claimCalls = 0;
    let dispatches = 0;
    const store = {
      readState: async () => success(state("codex", candidateRevision)),
    };
    const claimLease = {
      acquireClaimForDispatch: async requestValue => {
        claimCalls += 1;
        claimActive = true;
        candidateRevision += 1;
        return success({
          state_revision: candidateRevision,
          claim_attempt_id: requestValue.claim_attempt_id,
          claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
        });
      },
    };
    const first = build({
      store,
      claimLease,
      attemptOutcomeStore: shared.store,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        throw new Error(PRIVATE_MARKER);
      } },
    });
    assert.deepEqual(await first.composition.executeManualResume(request()), {
      ok: false,
      reason: "manual_resume_action_outcome_unknown",
    });
    assert.equal([...shared.records.values()][0].status, "dispatch_unknown");
    assert.equal(claimActive, true);
    assert.equal(dispatches, 1);

    // Simulate the legacy Claim recovery boundary releasing the Claim and
    // publishing a new Candidate revision. Composition has no release API.
    claimActive = false;
    candidateRevision += 1;
    const restarted = build({
      store,
      claimLease,
      attemptOutcomeStore: shared.store,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        return success(receipt());
      } },
    });
    assert.deepEqual(await restarted.composition.executeManualResume(request({
      expected_revision: candidateRevision,
      claim_attempt_id: "223e4567-e89b-42d3-a456-426614174001",
    })), {
      ok: false,
      reason: "manual_resume_attempt_recovery_required",
    });
    assert.equal(claimActive, false);
    assert.equal(claimCalls, 1);
    assert.equal(dispatches, 1);
  });

  await test("Result saved / Checkpoint CAS failed remains quarantined after restart", async () => {
    const shared = createAttemptOutcomeFixtureStore();
    let dispatches = 0;
    let claimCalls = 0;
    let resultWrites = 0;
    let checkpointWrites = 0;
    let resultSaved = false;
    const claimLease = {
      acquireClaimForDispatch: async requestValue => {
        claimCalls += 1;
        return success({
          state_revision: 2,
          claim_attempt_id: requestValue.claim_attempt_id,
          claim_lease_expires_at: "2026-08-01T01:00:00.000Z",
        });
      },
    };
    const first = build({
      claimLease,
      attemptOutcomeStore: shared.store,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        return success(receipt());
      } },
    });
    assert.equal((await first.composition.executeManualResume(request())).ok, true);
    assert.equal([...shared.records.values()][0].status, "accepted");

    // Contract sentinel only: current Composition has no Result or
    // Checkpoint writer. Model a committed Result and failed Checkpoint CAS.
    resultWrites += 1;
    resultSaved = true;
    checkpointWrites += 1;
    const checkpointResult = failure("revision_conflict");
    assert.equal(resultSaved, true);
    assert.equal(checkpointResult.ok, false);

    const restarted = build({
      attemptOutcomeStore: shared.store,
      claimLease,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        return success(receipt());
      } },
    });
    assert.deepEqual(await restarted.composition.executeManualResume(request({
      claim_attempt_id: "223e4567-e89b-42d3-a456-426614174001",
    })), {
      ok: false,
      reason: "manual_resume_attempt_recovery_required",
    });
    assert.equal(resultWrites, 1);
    assert.equal(checkpointWrites, 1);
    assert.equal(claimCalls, 1);
    assert.equal(dispatches, 1);
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

await group("native RPL-95 and RPL-118 composition", async () => {
  await test("READY flows through fresh RPL-118 preflight and the RPL-95 Attempt storage contract", async () => {
    const built = build({ nativeComposition: true });
    const result = await built.composition.executeManualResume(request());

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.outcome, "resume_accepted");
    assert.equal(built.calls.some(([name]) => name === "resolveCapabilityMvpContext"), true);
    assert.ok(built.calls.findIndex(([name]) => name === "resolveCapabilityMvpContext")
      < built.calls.findIndex(([name]) => name === "acquireClaim"));
    assert.ok(built.calls.findIndex(([name]) => name === "acquireClaim")
      < built.calls.findIndex(([name]) => name === "codex.resolveAndResume"));
    assert.ok(built.userLocalState.stats.publishes >= 4);
    assert.equal(built.userLocalState.stats.asyncLockCallbacks, 0);
    assert.ok(built.userLocalState.stats.locations.some(relativePath => (
      /^f4\/manual-resume-attempts\/attempt-[a-f0-9]{64}\.json$/.test(relativePath)
    )));
    assert.ok(built.userLocalState.stats.locations.some(relativePath => (
      /^f4\/scope-preservation-checkpoints\/checkpoint-[a-f0-9]{64}\.json$/.test(relativePath)
    )));
    assert.equal(built.userLocalState.stats.locations.some(relativePath => (
      relativePath.includes("composition-candidate-001")
    )), false);
    const persisted = [...built.userLocalState.records.values()].map(contents => JSON.parse(contents));
    const acceptedAttempt = persisted.find(record => record.value?.status === "accepted");
    assert.equal(acceptedAttempt.value.status, "accepted");
    assert.equal(acceptedAttempt.value.attempt_id, ATTEMPT);
    assert.ok(persisted.some(record => record.checkpoint?.scopeRevision === FIXTURE_SCOPE.scopeRevision));
  });

  await test("BLOCKED and UNKNOWN capability evidence fail before Claim or executor", async () => {
    for (const overrides of [
      { capabilityStatus: "unavailable" },
      { staleObservation: true },
    ]) {
      const built = build({ nativeComposition: true, capabilityMvpOverrides: overrides });
      const result = await built.composition.executeManualResume(request());
      assert.deepEqual(result, { ok: false, reason: "manual_resume_capability_preflight_blocked" });
      assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
      assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
      assert.equal(built.userLocalState.stats.publishes, 0);
    }
  });

  await test("HANDOFF is not treated as READY or dispatch approval", async () => {
    const built = build({ nativeComposition: true, capabilityMvpOverrides: { capabilityStatus: "unavailable", handoff: true } });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_capability_preflight_blocked" });
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("Host repository/worktree mismatch blocks before Attempt read and Claim", async () => {
    let observedBinding;
    const built = build({
      nativeComposition: true,
      verifyWorktreeStateBinding: binding => {
        observedBinding = binding;
        return false;
      },
    });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_capability_preflight_blocked" });
    assert.equal(observedBinding.repository_cwd, "/repo");
    assert.equal(observedBinding.candidate_id, "composition-candidate-001");
    assert.equal(observedBinding.repository_identity, REPOSITORY);
    assert.equal(observedBinding.worktree_identity, WORKTREE);
    assert.match(observedBinding.physical_state.state_root_identity, /^[a-f0-9]{64}$/);
    assert.equal(observedBinding.physical_state.repository_instance_id, "a".repeat(64));
    assert.equal(observedBinding.physical_state.physical_worktree_id, "b".repeat(64));
    assert.equal(built.userLocalState.stats.reads, 0);
    assert.equal(built.calls.some(([name]) => name === "resolveManualResumeContext"), false);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("missing trusted Host worktree verifier blocks before Claim", async () => {
    const built = build({ nativeComposition: true, omitWorktreeStateBindingVerifier: true });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_capability_preflight_blocked" });
    assert.equal(built.calls.some(([name]) => name === "resolveManualResumeContext"), false);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("replaced State Root directory cannot hide prior UNKNOWN and redispatch", async () => {
    const userLocalState = userLocalStateFixture();
    let dispatches = 0;
    let approvedStateRootIdentity;
    const verifyWorktreeStateBinding = binding => {
      const observed = binding.physical_state.state_root_identity;
      if (approvedStateRootIdentity === undefined) approvedStateRootIdentity = observed;
      return observed === approvedStateRootIdentity;
    };
    const first = build({
      nativeComposition: true,
      userLocalState,
      verifyWorktreeStateBinding,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        throw new Error(PRIVATE_MARKER);
      } },
    });
    const firstResult = await first.composition.executeManualResume(request());
    assert.deepEqual(firstResult, { ok: false, reason: "manual_resume_action_outcome_unknown" });
    assert.equal(dispatches, 1);

    const readsBeforeChangedRoot = userLocalState.stats.reads;
    userLocalState.replaceDefaultRoot();
    const afterRootChange = build({
      nativeComposition: true,
      userLocalState,
      verifyWorktreeStateBinding,
    });
    const replay = await afterRootChange.composition.executeManualResume(request({
      claim_attempt_id: "123e4567-e89b-42d3-a456-426614174001",
    }));
    assert.deepEqual(replay, { ok: false, reason: "manual_resume_capability_preflight_blocked" });
    assert.equal(afterRootChange.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(afterRootChange.calls.some(([name]) => name === "codex.resolveAndResume"), false);
    assert.equal(userLocalState.stats.reads, readsBeforeChangedRoot);
    assert.equal(dispatches, 1);
  });

  await test("mutating stateRootOptions after Host verification cannot redirect Attempt lookup", async () => {
    const userLocalState = userLocalStateFixture();
    const rootA = "/synthetic-user/pinned-attempt-root";
    const rootB = "/synthetic-user/mutated-attempt-root";
    const initialOptions = { stateRootOverride: rootA };
    let dispatches = 0;
    const first = build({
      nativeComposition: true,
      userLocalState,
      stateRootOptions: initialOptions,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        throw new Error(PRIVATE_MARKER);
      } },
    });
    const firstResult = await first.composition.executeManualResume(request());
    assert.deepEqual(firstResult, { ok: false, reason: "manual_resume_action_outcome_unknown" });
    assert.equal(dispatches, 1);

    const mutableOptions = { stateRootOverride: rootA };
    const afterRestart = build({
      nativeComposition: true,
      userLocalState,
      stateRootOptions: mutableOptions,
      resolveCapabilityMvpContext: input => {
        mutableOptions.stateRootOverride = rootB;
        return capabilityMvpContextResult(input.candidate_id, input.runtime_id);
      },
    });
    const replay = await afterRestart.composition.executeManualResume(request({
      claim_attempt_id: "123e4567-e89b-42d3-a456-426614174001",
    }));
    assert.deepEqual(replay, { ok: false, reason: "manual_resume_attempt_recovery_required" });
    assert.equal(mutableOptions.stateRootOverride, rootB);
    assert.equal(afterRestart.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(afterRestart.calls.some(([name]) => name === "codex.resolveAndResume"), false);
    assert.equal([...userLocalState.records.keys()].every(key => JSON.parse(key)[1] === rootA), true);
    assert.equal(dispatches, 1);
  });

  await test("physical root drift between Host check and Attempt read fails closed", async () => {
    const backing = userLocalStateFixture();
    const api = backing.api;
    let locationCalls = 0;
    const driftingApi = Object.freeze({
      resolveUserLocalStateLocation(cwd, relativePath, options) {
        locationCalls += 1;
        const location = api.resolveUserLocalStateLocation(cwd, relativePath, options);
        return locationCalls === 5
          ? Object.freeze({ ...location, rootPath: "/synthetic-user/drifted-root" })
          : location;
      },
      readUserLocalState: api.readUserLocalState,
      publishUserLocalStateAtomically: api.publishUserLocalStateAtomically,
      withPhysicalStateLock: api.withPhysicalStateLock,
    });
    const userLocalState = { ...backing, api: driftingApi };
    const built = build({ nativeComposition: true, userLocalState });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_capability_preflight_blocked" });
    assert.equal(locationCalls, 5);
    assert.equal(backing.stats.reads, 0);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("scope and runtime mismatch fail before Claim", async () => {
    for (const overrides of [
      { scopeRef: "different-candidate-scope" },
      { runtimeEvidenceRuntimeId: "claude" },
      { environmentRuntimeId: "claude" },
      { providerId: "different-runtime-provider" },
    ]) {
      const built = build({ nativeComposition: true, capabilityMvpOverrides: overrides });
      const result = await built.composition.executeManualResume(request());
      assert.deepEqual(result, { ok: false, reason: "manual_resume_capability_preflight_blocked" });
      assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
      assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
    }
  });

  await test("post-Claim response loss persists UNKNOWN and blocks same or new Attempt after restart", async () => {
    const userLocalState = userLocalStateFixture();
    let dispatches = 0;
    const first = build({
      nativeComposition: true,
      userLocalState,
      executor: { resolveAndResume: async () => {
        dispatches += 1;
        throw new Error(PRIVATE_MARKER);
      } },
    });
    const firstResult = await first.composition.executeManualResume(request());
    assert.deepEqual(firstResult, { ok: false, reason: "manual_resume_action_outcome_unknown" });
    assert.equal(dispatches, 1);
    const unknownRecord = [...userLocalState.records.values()]
      .map(contents => JSON.parse(contents))
      .find(envelope => envelope.value?.status === "dispatch_unknown").value;
    assert.equal(unknownRecord.status, "dispatch_unknown");

    const afterRestart = build({ nativeComposition: true, userLocalState });
    const replay = await afterRestart.composition.executeManualResume(request());
    assert.deepEqual(replay, { ok: false, reason: "manual_resume_attempt_replay_blocked" });
    const freshAttempt = await afterRestart.composition.executeManualResume(request({
      claim_attempt_id: "123e4567-e89b-42d3-a456-426614174001",
    }));
    assert.deepEqual(freshAttempt, { ok: false, reason: "manual_resume_attempt_recovery_required" });
    assert.equal(afterRestart.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(afterRestart.calls.some(([name]) => name === "codex.resolveAndResume"), false);
    assert.equal(dispatches, 1);
  });
});

await group("Makefile composition wiring", async () => {
  await test("declares the composition target after Claude resolution", () => {
    assert.match(MAKEFILE_SOURCE, /^test-pending-handoff-manual-resume-runtime-composition-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-manual-resume-runtime-composition-fixtures\.mjs$/m);
    assert.equal((MAKEFILE_SOURCE.match(/test-pending-handoff-manual-resume-runtime-composition-fixtures/g) ?? []).length, 4);
    assert.ok(MAKEFILE_SOURCE.indexOf("test-pending-handoff-claude-runtime-adapter-fixtures") < MAKEFILE_SOURCE.indexOf("test-pending-handoff-manual-resume-runtime-composition-fixtures"));
  });
});

await group("F4 scope checkpoint composition", async () => {
  await test("approved Scope Revision must match the durable checkpoint before Claim", async () => {
    const built = build({
      nativeComposition: true,
      resolveApprovedWorkstreamForManualResume: () => (
        fixtureApprovedWorkstream("RPL-120", "new-owner-revision-not-in-checkpoint")
      ),
    });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_capability_preflight_blocked" });
    assert.equal(built.userLocalState.stats.readPaths.length, 1);
    assert.match(built.userLocalState.stats.readPaths[0], /^f4\/scope-preservation-checkpoints\//);
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("BLOCKED workstream cannot pass the READY checkpoint gate", async () => {
    const built = build({
      nativeComposition: true,
      resolveApprovedWorkstreamForManualResume: () => fixtureApprovedWorkstream("BLOCKED-OTHER"),
    });
    const result = await built.composition.executeManualResume(request());
    assert.deepEqual(result, { ok: false, reason: "manual_resume_capability_preflight_blocked" });
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
    assert.equal(built.calls.some(([name]) => name === "codex.resolveAndResume"), false);
  });

  await test("composition requires an Owner-backed workstream resolver", () => {
    const built = build({ nativeComposition: true, omitScopeResolver: true });
    assert.deepEqual(built.built, {
      ok: false,
      reason: "manual_resume_runtime_dependency_invalid",
    });
    assert.equal(built.calls.some(([name]) => name === "acquireClaim"), false);
  });

  await test("persists and restores a revision-CAS scope checkpoint through RPL-95 primitives", async () => {
    const built = build({ nativeComposition: true, seedScopeCheckpoint: false });
    assert.deepEqual(Reflect.ownKeys(built.composition), [
      "executeManualResume",
      "readScopeCheckpoint",
      "reconcileScopeCheckpoint",
    ]);

    const approvedScope = {
      objectiveId: "RPL-112",
      scopeRevision: "RPL-112/comment/10729",
      source: {
        uri: "https://ranikunlabs.atlassian.net/browse/RPL-112",
        revision: "RPL-112/comment/10729",
        coverage: "COMPLETE",
      },
      requiredSources: [{ uri: "https://ranikunlabs.atlassian.net/rest/api/3/search" }],
      items: [{ id: "F4", primaryJira: "RPL-120", owner: "F4" }],
    };
    const first = await built.composition.reconcileScopeCheckpoint({
      approvedScope,
      expectedCheckpointRevision: null,
      refresh: {
        sourceUri: "https://ranikunlabs.atlassian.net/rest/api/3/search",
        sourceRevision: "jira-snapshot/first",
        expectedPriorRevision: null,
        refreshScope: "FULL_SOURCE",
        coverage: "COMPLETE",
        partialReasons: [],
        observations: [{ id: "F4", status: "READY" }],
      },
      recentExecution: { primaryJira: "RPL-120", writer: "f4-writer", prHead: null },
      nextReadyId: "F4",
      stopReason: null,
    });
    assert.equal(first.ok, true);
    assert.equal(first.checkpoint.checkpointRevision, 1);
    assert.equal(built.userLocalState.stats.asyncLockCallbacks, 0);

    const resumed = await built.composition.readScopeCheckpoint({ objectiveId: "RPL-112" });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.value.scopeRevision, "RPL-112/comment/10729");
    assert.equal(resumed.value.nextReadyId, "F4");

    const blocked = await built.composition.reconcileScopeCheckpoint({
      approvedScope,
      expectedCheckpointRevision: 1,
      refresh: {
        sourceUri: "https://ranikunlabs.atlassian.net/rest/api/3/search",
        sourceRevision: "jira-snapshot/next",
        expectedPriorRevision: "jira-snapshot/first",
        refreshScope: "INCREMENTAL_DELTA",
        coverage: "COMPLETE",
        partialReasons: [],
        observations: [{ id: "F4", status: "BLOCKED" }],
      },
      recentExecution: null,
      nextReadyId: null,
      stopReason: "NO_VERIFIED_READY",
    });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.checkpoint.checkpointRevision, 2);
    assert.equal(blocked.checkpoint.statusSummary.BLOCKED, 1);
    assert.equal(blocked.checkpoint.goalDoneEligible, false);
    assert.ok(built.userLocalState.stats.locations.some(relativePath => (
      /^f4\/scope-preservation-checkpoints\/checkpoint-[a-f0-9]{64}\.json$/.test(relativePath)
    )));

    const staleResume = await built.composition.reconcileScopeCheckpoint({
      approvedScope,
      expectedCheckpointRevision: 1,
      refresh: null,
      recentExecution: null,
      nextReadyId: null,
      stopReason: "PARTIAL_DISCOVERY",
    });
    assert.equal(staleResume.ok, false);
    assert.equal(staleResume.reason, "STALE_CHECKPOINT_REVISION");
    assert.equal(built.userLocalState.stats.asyncLockCallbacks, 0);

    built.userLocalState.setNextPublishDurabilityUnknown();
    const unknownPublication = await built.composition.reconcileScopeCheckpoint({
      approvedScope,
      expectedCheckpointRevision: 2,
      refresh: {
        sourceUri: "https://ranikunlabs.atlassian.net/rest/api/3/search",
        sourceRevision: "jira-snapshot/unknown-publication",
        expectedPriorRevision: "jira-snapshot/next",
        refreshScope: "INCREMENTAL_DELTA",
        coverage: "COMPLETE",
        partialReasons: [],
        observations: [{ id: "F4", status: "DONE" }],
      },
      recentExecution: null,
      nextReadyId: null,
      stopReason: null,
    });
    assert.equal(unknownPublication.ok, false);
    assert.equal(unknownPublication.reason, "scope_checkpoint_publication_unknown");
    assert.equal(unknownPublication.checkpoint, null);
    const reconciledAfterUnknown = await built.composition.readScopeCheckpoint({ objectiveId: "RPL-112" });
    assert.equal(reconciledAfterUnknown.ok, true);
    assert.equal(reconciledAfterUnknown.value.checkpointRevision, 3);
    assert.equal(reconciledAfterUnknown.value.statusSummary.DONE, 1);
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS RC 0\n`);
