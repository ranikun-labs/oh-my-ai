#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  EXECUTION_CAPABILITIES,
  MAX_FUTURE_CLOCK_SKEW_MS,
  MAX_OBSERVATION_AGE_MS,
  assessCheckpointResume,
  decideRetry,
  planRunnerRouting,
  preflightExecution,
} from "./lib/f4-execution-capability.mjs";

const PASS = [];
const NO_CLAIM_NO_DISPATCH = Object.freeze({
  claim_status: "NOT_ACQUIRED",
  dispatch_status: "NOT_RUN",
});

const SCOPE_BY_CAPABILITY = {
  git: { operation: "read", resource: "repo:ranikun-labs/oh-my-ai" },
  git_proxy: { operation: "connect", resource: "github:ranikun-labs/oh-my-ai" },
  jvm: { operation: "run-build", resource: "repo:finance-harness-be" },
  socket: { operation: "connect", resource: "service:carelog/socket" },
  github_api: { operation: "read", resource: "repo:ranikun-labs/oh-my-ai" },
  actions: { operation: "read-workflow", resource: "repo:ranikun-labs/oh-my-ai/actions" },
  cross_repo: { operation: "read", resource: "workspace:oh-my-ai+finance-harness" },
  private_repo_checkout: { operation: "checkout", resource: "repo:synthetic/private-repo" },
  artifact_handoff: { operation: "publish-and-fetch", resource: "artifact:f4-candidate" },
  e2e: { operation: "run", resource: "environment:synthetic-e2e" },
};

function pass(id, label) {
  PASS.push(id);
  process.stdout.write("passed: " + id + " " + label + "\n");
}

function task(id, capabilities, approval = true) {
  return {
    task_id: id,
    scope_ref: "scope:" + id,
    requirements: {
      capabilities,
      approval_required: true,
      capability_scopes: Object.fromEntries(capabilities.map(capability => [
        capability,
        { ...SCOPE_BY_CAPABILITY[capability] },
      ])),
    },
    authorization: approval
      ? {
        status: "approved",
        verified: true,
        evidence_ref: "synthetic-approval:" + id,
        scope_ref: "scope:" + id,
      }
      : {
        status: "pending",
        verified: false,
        evidence_ref: "",
        scope_ref: "scope:" + id,
      },
  };
}

function observation(
  providerId,
  fingerprint,
  currentTask,
  capability,
  status = "available",
  observedAt = new Date().toISOString(),
  runtimeId = providerId,
) {
  const scope = currentTask.requirements.capability_scopes[capability];
  return {
    status,
    verified: true,
    evidence_ref: "synthetic-probe:" + providerId + ":" + capability,
    observed_at: observedAt,
    provider_id: providerId,
    runtime_id: runtimeId,
    environment_fingerprint: fingerprint,
    capability,
    task_id: currentTask.task_id,
    scope_ref: currentTask.scope_ref,
    operation: scope.operation,
    resource: scope.resource,
    reason: status === "unavailable" ? "synthetic unavailable fixture" : "",
  };
}

function environment(providerId, fingerprint, capabilities, currentTask, runtimeId = providerId) {
  const records = {};
  for (const capability of capabilities) {
    records[capability] = observation(
      providerId,
      fingerprint,
      currentTask,
      capability,
      "available",
      new Date().toISOString(),
      runtimeId,
    );
  }
  return {
    provider_id: providerId,
    fingerprint,
    runtime_id: runtimeId,
    capabilities: records,
  };
}

function setUnavailable(env, capability) {
  env.capabilities[capability] = {
    ...env.capabilities[capability],
    status: "unavailable",
    reason: "synthetic unavailable fixture",
  };
  return env;
}

const syntheticVerifiers = {
  verifyApproval(approval, currentTask) {
    return approval.verified === true
      && approval.scope_ref === currentTask.scope_ref
      && approval.evidence_ref === "synthetic-approval:" + currentTask.task_id;
  },
  verifyCapabilityEvidence(evidence, context) {
    const observedAt = Date.parse(evidence.observed_at);
    const checkedAt = Date.parse(context.checked_at);
    return evidence.provider_id === context.provider_id
      && evidence.runtime_id === context.runtime_id
      && evidence.evidence_ref === "synthetic-probe:"
        + context.provider_id
        + ":"
        + context.capability
      && evidence.capability === context.capability
      && evidence.task_id === context.task_id
      && evidence.scope_ref === context.scope_ref
      && evidence.operation === context.requested_scope.operation
      && evidence.resource === context.requested_scope.resource
      && evidence.environment_fingerprint === context.environment_fingerprint
      && context.max_observation_age_ms === MAX_OBSERVATION_AGE_MS
      && context.max_future_clock_skew_ms === MAX_FUTURE_CLOCK_SKEW_MS
      && Number.isFinite(checkedAt)
      && checkedAt - observedAt <= context.max_observation_age_ms
      && observedAt - checkedAt <= context.max_future_clock_skew_ms;
  },
};

const expectedRequirements = [
  "git",
  "jvm",
  "socket",
  "github_api",
  "actions",
  "cross_repo",
  "artifact_handoff",
  "e2e",
];
for (const requirement of expectedRequirements) {
  assert.ok(EXECUTION_CAPABILITIES.includes(requirement), "missing capability " + requirement);
}
assert.equal(EXECUTION_CAPABILITIES.includes("approval"), false);
pass("FX-F4-CAPABILITY-TAXONOMY", "기술 Capability와 Approval gate를 분리");

const blockers = [
  {
    id: "FX-F4-FINANCE-JVM",
    blocked: "jvm",
    capabilities: ["git", "jvm"],
    fingerprint: "finance-jvm-unavailable-v1",
  },
  {
    id: "FX-F4-CARELOG-SOCKET",
    blocked: "socket",
    capabilities: ["git", "socket"],
    fingerprint: "carelog-socket-unavailable-v1",
  },
  {
    id: "FX-F4-GIT-PROXY",
    blocked: "git_proxy",
    capabilities: ["git", "git_proxy", "github_api"],
    fingerprint: "git-proxy-unavailable-v1",
  },
  {
    id: "FX-F4-ARTIFACT-HANDOFF",
    blocked: "artifact_handoff",
    capabilities: ["git", "artifact_handoff"],
    fingerprint: "artifact-handoff-unavailable-v1",
  },
  {
    id: "FX-F4-PRIVATE-REPO-CHECKOUT",
    blocked: "private_repo_checkout",
    capabilities: ["git", "github_api", "cross_repo", "private_repo_checkout"],
    fingerprint: "private-repo-checkout-unavailable-v1",
  },
  {
    id: "FX-F4-ACTUAL-E2E-NOT-READY",
    blocked: "e2e",
    capabilities: ["git", "github_api", "actions", "e2e"],
    fingerprint: "e2e-runtime-not-ready-v1",
  },
];

for (const scenario of blockers) {
  const providerId = "synthetic:" + scenario.id;
  const scenarioTask = task(scenario.id, scenario.capabilities);
  const env = setUnavailable(
    environment(providerId, scenario.fingerprint, scenario.capabilities, scenarioTask),
    scenario.blocked,
  );
  const checked = preflightExecution(
    scenarioTask,
    env,
    syntheticVerifiers,
  );
  assert.equal(checked.status, "BLOCKED", scenario.id);
  assert.equal(checked.code, "ENVIRONMENT_BLOCKED", scenario.id);
  assert.ok(checked.blockers.some(item => item.capability === scenario.blocked), scenario.id);
  assert.equal(checked.dispatch_status, "NOT_RUN", scenario.id);

  const routed = planRunnerRouting(scenarioTask, [
    { id: env.runtime_id, environment: env },
  ], syntheticVerifiers);
  assert.equal(routed.status, "BLOCKED", scenario.id);
  assert.equal(routed.code, "NO_COMPATIBLE_RUNNER", scenario.id);
  assert.equal(routed.runner_id, null, scenario.id);
  assert.equal(routed.dispatch_status, "NOT_RUN", scenario.id);

  const sameEnvironment = decideRetry({
    attempt_boundary: NO_CLAIM_NO_DISPATCH,
    failure: {
      class: "environment",
      failure_fingerprint: scenario.id + ":" + scenario.blocked,
      environment_fingerprint: scenario.fingerprint,
    },
    candidate: { environment_fingerprint: scenario.fingerprint },
  });
  assert.equal(sameEnvironment.retry_allowed, false, scenario.id);
  assert.equal(sameEnvironment.code, "SAME_ENVIRONMENT_BLOCKER", scenario.id);
  pass(scenario.id, scenario.blocked + " 차단, 경로 선택·동일 환경 재시도 없음");
}

const unapproved = task("FX-F4-APPROVAL-PENDING", ["git"], false);
const approvalEnv = environment(
  "approval-provider",
  "approval-env-v1",
  ["git"],
  unapproved,
);
const approvalResult = preflightExecution(unapproved, approvalEnv);
assert.equal(approvalResult.status, "BLOCKED");
assert.equal(approvalResult.code, "APPROVAL_BLOCKED");
assert.deepEqual(approvalResult.blockers, []);
assert.equal(approvalResult.dispatch_status, "NOT_RUN");
pass("FX-F4-APPROVAL-GATE", "미승인 scope는 기술 Capability 장애와 별도로 차단");

const approvedTask = task("FX-F4-APPROVAL-UNVERIFIED", ["git"]);
const noApprovalVerifier = preflightExecution(approvedTask, approvalEnv, {
  verifyCapabilityEvidence: syntheticVerifiers.verifyCapabilityEvidence,
});
assert.equal(noApprovalVerifier.status, "BLOCKED");
assert.equal(noApprovalVerifier.code, "APPROVAL_BLOCKED");
assert.match(noApprovalVerifier.reasons[0], /trusted approval verifier/);

const mismatchedApprovalTask = task("FX-F4-APPROVAL-SCOPE-MISMATCH", ["git"]);
mismatchedApprovalTask.authorization.scope_ref = "different-scope";
const mismatchedApproval = preflightExecution(
  mismatchedApprovalTask,
  approvalEnv,
  syntheticVerifiers,
);
assert.equal(mismatchedApproval.code, "APPROVAL_BLOCKED");
pass("FX-F4-APPROVAL-EVIDENCE", "검증자 부재와 다른 Scope 승인을 차단");

const missingObservationTask = task("FX-F4-MISSING-OBSERVATION", ["git", "jvm"]);
const missingObservation = preflightExecution(
  missingObservationTask,
  environment(
    "missing-provider",
    "missing-jvm-env-v1",
    ["git"],
    missingObservationTask,
  ),
  syntheticVerifiers,
);
assert.equal(missingObservation.code, "ENVIRONMENT_BLOCKED");
assert.equal(missingObservation.blockers[0].code, "CAPABILITY_UNKNOWN");
pass("FX-F4-MISSING-OBSERVATION", "관측이 없으면 unknown으로 fail closed");

const invalidEvidenceTask = task("FX-F4-INVALID-EVIDENCE", ["git"]);
const wrongProvider = environment(
  "provider-a",
  "wrong-provider-v1",
  ["git"],
  invalidEvidenceTask,
);
wrongProvider.capabilities.git.provider_id = "provider-b";
const invalidEvidence = preflightExecution(
  invalidEvidenceTask,
  wrongProvider,
  syntheticVerifiers,
);
assert.equal(invalidEvidence.status, "BLOCKED");
assert.equal(invalidEvidence.blockers[0].code, "CAPABILITY_EVIDENCE_INVALID");
pass("FX-F4-EVIDENCE-PROVENANCE", "다른 Provider의 관측 증거를 거부");

const replayTask = task("FX-F4-ENVIRONMENT-REPLAY", ["git"]);
const replayEnvironment = environment(
  "replay-provider",
  "observed-in-old-environment",
  ["git"],
  replayTask,
);
replayEnvironment.fingerprint = "current-environment";
const replayedEvidence = preflightExecution(
  replayTask,
  replayEnvironment,
  syntheticVerifiers,
);
assert.equal(replayedEvidence.status, "BLOCKED");
assert.equal(replayedEvidence.blockers[0].code, "CAPABILITY_ENVIRONMENT_MISMATCH");

const staleTask = task("FX-F4-STALE-OBSERVATION", ["git"]);
const staleEnvironment = environment(
  "stale-provider",
  "stale-environment-v1",
  ["git"],
  staleTask,
);
staleEnvironment.capabilities.git.observed_at = new Date(
  Date.now() - MAX_OBSERVATION_AGE_MS - 1000,
).toISOString();
const staleEvidence = preflightExecution(staleTask, staleEnvironment, syntheticVerifiers);
assert.equal(staleEvidence.status, "BLOCKED");
assert.equal(staleEvidence.blockers[0].code, "CAPABILITY_OBSERVATION_STALE");

const futureTask = task("FX-F4-FUTURE-OBSERVATION", ["git"]);
const futureEnvironment = environment(
  "future-provider",
  "future-environment-v1",
  ["git"],
  futureTask,
);
futureEnvironment.capabilities.git.observed_at = new Date(
  Date.now() + MAX_FUTURE_CLOCK_SKEW_MS + 1000,
).toISOString();
const futureEvidence = preflightExecution(futureTask, futureEnvironment, syntheticVerifiers);
assert.equal(futureEvidence.status, "BLOCKED");
assert.equal(futureEvidence.blockers[0].code, "CAPABILITY_OBSERVATION_FUTURE");
pass("FX-F4-ENVIRONMENT-FRESHNESS", "오래된 관측과 다른 환경의 재사용 및 미래 시각 관측을 차단");

const readTask = task("FX-F4-RESOURCE-SCOPE", ["github_api"]);
const readEnvironment = environment(
  "scope-provider",
  "scope-environment-v1",
  ["github_api"],
  readTask,
);
const writeOtherRepoTask = task("FX-F4-RESOURCE-SCOPE", ["github_api"]);
writeOtherRepoTask.requirements.capability_scopes.github_api = {
  operation: "write",
  resource: "repo:example/other",
};
const wrongScopeEvidence = preflightExecution(
  writeOtherRepoTask,
  readEnvironment,
  syntheticVerifiers,
);
assert.equal(wrongScopeEvidence.status, "BLOCKED");
assert.equal(wrongScopeEvidence.blockers[0].code, "CAPABILITY_SCOPE_MISMATCH");

const wrongTask = task("FX-F4-RESOURCE-SCOPE-OTHER-TASK", ["github_api"]);
wrongTask.scope_ref = readTask.scope_ref;
wrongTask.authorization.scope_ref = readTask.scope_ref;
wrongTask.authorization.evidence_ref = "synthetic-approval:" + wrongTask.task_id;
const wrongTaskEvidence = preflightExecution(wrongTask, readEnvironment, syntheticVerifiers);
assert.equal(wrongTaskEvidence.status, "BLOCKED");
assert.equal(wrongTaskEvidence.blockers[0].code, "CAPABILITY_SCOPE_MISMATCH");
pass("FX-F4-TASK-OPERATION-RESOURCE-BINDING", "GitHub read/repo A 증거를 write/repo B나 다른 Task에 재사용하지 않음");

const incompleteScopeTask = task("FX-F4-INCOMPLETE-SCOPE", ["git"]);
incompleteScopeTask.requirements.capability_scopes.git.resource = "*";
const incompleteScope = preflightExecution(
  incompleteScopeTask,
  environment("scope-validation-provider", "scope-validation-v1", ["git"], incompleteScopeTask),
  syntheticVerifiers,
);
assert.equal(incompleteScope.status, "BLOCKED");
assert.equal(incompleteScope.code, "PREFLIGHT_INVALID");
pass("FX-F4-REQUIREMENT-SCOPE-VALIDATION", "와일드카드 operation/resource scope를 거부");

for (const [id, field, value] of [
  ["FX-F4-SCOPE-RESOURCE-TYPE-WILDCARD", "resource", "repo:*"],
  ["FX-F4-SCOPE-RESOURCE-PATH-WILDCARD", "resource", "repo:org/*"],
  ["FX-F4-SCOPE-OPERATION-GLOB", "operation", "read:*"],
]) {
  const scopedTask = task(id, ["git"]);
  scopedTask.requirements.capability_scopes.git[field] = value;
  const scopedEnvironment = environment(
    "synthetic:" + id,
    id + "-environment",
    ["git"],
    scopedTask,
  );
  let verifierCalls = 0;
  const rejected = preflightExecution(scopedTask, scopedEnvironment, {
    verifyApproval() {
      verifierCalls += 1;
      return true;
    },
    verifyCapabilityEvidence() {
      verifierCalls += 1;
      return true;
    },
  });
  assert.equal(rejected.status, "BLOCKED", id);
  assert.equal(rejected.code, "PREFLIGHT_INVALID", id);
  assert.equal(verifierCalls, 0, id);
}
pass("FX-F4-SCOPE-CANONICAL-GRAMMAR", "repo:*·repo:org/*·read:*를 verifier 호출 전에 거부");

for (const operation of [
  "all",
  "any",
  "unknown",
  "unspecified",
  "read-all",
  "none",
  "default",
  "wildcard",
  "unknown-run",
]) {
  const id = "FX-F4-RESERVED-OPERATION-" + operation;
  const reservedTask = task(id, ["git"]);
  reservedTask.requirements.capability_scopes.git.operation = operation;
  const reservedEnvironment = environment(
    "synthetic:" + id,
    id + "-environment",
    ["git"],
    reservedTask,
  );
  let verifierCalls = 0;
  const rejected = preflightExecution(reservedTask, reservedEnvironment, {
    verifyApproval() {
      verifierCalls += 1;
      return true;
    },
    verifyCapabilityEvidence() {
      verifierCalls += 1;
      return true;
    },
  });
  assert.equal(rejected.status, "BLOCKED", operation);
  assert.equal(rejected.code, "PREFLIGHT_INVALID", operation);
  assert.equal(verifierCalls, 0, operation);
}
pass("FX-F4-RESERVED-OPERATION-TOKENS", "all/any/unknown/unspecified 및 숨은 reserved segment를 verifier 호출 전에 거부");

const noCapabilityTask = task("FX-F4-CAPABILITY-UNVERIFIED", ["git"]);
const noCapabilityVerifier = preflightExecution(
  noCapabilityTask,
  environment(
    "unverified-provider",
    "unverified-env-v1",
    ["git"],
    noCapabilityTask,
  ),
  { verifyApproval: syntheticVerifiers.verifyApproval },
);
assert.equal(noCapabilityVerifier.status, "BLOCKED");
assert.equal(noCapabilityVerifier.blockers[0].code, "CAPABILITY_EVIDENCE_UNVERIFIED");
pass("FX-F4-CAPABILITY-VERIFIER", "Capability verifier 없이는 READY를 만들지 않음");

const fullCapabilityTask = task("FX-F4-ALL-CAPABILITIES", [
  "git",
  "git_proxy",
  "jvm",
  "socket",
  "github_api",
  "actions",
  "cross_repo",
  "private_repo_checkout",
  "artifact_handoff",
  "e2e",
]);
const fullCapabilityEnvironment = environment(
  "synthetic-all-capabilities",
  "all-capabilities-ready-v1",
  fullCapabilityTask.requirements.capabilities,
  fullCapabilityTask,
);
const allCapabilities = preflightExecution(
  fullCapabilityTask,
  fullCapabilityEnvironment,
  syntheticVerifiers,
);
assert.equal(allCapabilities.status, "READY");
assert.deepEqual(
  allCapabilities.verified_capabilities,
  fullCapabilityTask.requirements.capabilities,
);
pass("FX-F4-ALL-CAPABILITIES", "모든 기술 요구를 검증 대상으로 지원");

const routeTask = task("FX-F4-ROUTE-PLAN", ["git", "jvm"]);
const incompatible = setUnavailable(
  environment("runner-one", "runner-one-no-jvm-v1", ["git", "jvm"], routeTask),
  "jvm",
);
const compatible = environment("runner-two", "runner-two-ready-v1", ["git", "jvm"], routeTask);
const route = planRunnerRouting(routeTask, [
  { id: "runner-one", priority: 20, environment: incompatible },
  { id: "runner-two", priority: 1, environment: compatible },
], syntheticVerifiers);
assert.equal(route.status, "ROUTE_PLANNED");
assert.equal(route.runner_id, "runner-two");
assert.equal(route.dispatch_status, "NOT_RUN");
assert.equal(route.runtime_adapter, "NOT_INVOKED");
assert.ok(route.runner_evaluations.some(item => item.runner_id === "runner-one"
  && item.preflight.code === "ENVIRONMENT_BLOCKED"));
pass("FX-F4-ROUTING-PLAN", "검증된 Capability가 맞는 Runner 후보만 계획하고 dispatch는 미실행");

let crossRuntimeVerifierCalls = 0;
const claudeEnvironment = environment(
  "shared-synthetic-provider",
  "claude-runtime-environment-v1",
  ["git", "jvm"],
  routeTask,
  "claude",
);
const crossRuntimeRoute = planRunnerRouting(routeTask, [
  { id: "codex", environment: claudeEnvironment },
], {
  ...syntheticVerifiers,
  verifyCapabilityEvidence(evidence, context) {
    crossRuntimeVerifierCalls += 1;
    return syntheticVerifiers.verifyCapabilityEvidence(evidence, context);
  },
});
assert.equal(crossRuntimeRoute.status, "BLOCKED");
assert.equal(crossRuntimeRoute.code, "NO_COMPATIBLE_RUNNER");
assert.equal(crossRuntimeRoute.runner_id, null);
assert.equal(crossRuntimeRoute.dispatch_status, "NOT_RUN");
assert.equal(crossRuntimeRoute.runner_evaluations[0].preflight.code, "ENVIRONMENT_RUNTIME_MISMATCH");
assert.equal(crossRuntimeVerifierCalls, 0);
pass("FX-F4-RUNTIME-BINDING", "Codex Runner를 Claude 환경으로 교차 결합할 수 없음");

const sameEnvironmentRetry = decideRetry({
  attempt_boundary: NO_CLAIM_NO_DISPATCH,
  failure: {
    class: "environment",
    failure_fingerprint: "socket-timeout",
    environment_fingerprint: "carelog-env-a",
  },
  candidate: { environment_fingerprint: "carelog-env-a" },
});
assert.equal(sameEnvironmentRetry.retry_allowed, false);

const changedEnvironmentRetry = decideRetry({
  attempt_boundary: NO_CLAIM_NO_DISPATCH,
  failure: {
    class: "environment",
    failure_fingerprint: "socket-timeout",
    environment_fingerprint: "carelog-env-a",
  },
  candidate: { environment_fingerprint: "carelog-env-b" },
});
assert.equal(changedEnvironmentRetry.retry_allowed, true);
assert.equal(changedEnvironmentRetry.code, "ENVIRONMENT_CHANGED");

const environmentRetryLimit = decideRetry({
  attempt_boundary: NO_CLAIM_NO_DISPATCH,
  failure: {
    class: "environment",
    failure_fingerprint: "socket-timeout",
    environment_fingerprint: "carelog-env-b",
  },
  candidate: { environment_fingerprint: "carelog-env-c" },
  previous_failures: [{
    class: "environment",
    failure_fingerprint: "socket-timeout",
    environment_fingerprint: "carelog-env-a",
  }],
});
assert.equal(environmentRetryLimit.retry_allowed, false);
assert.equal(environmentRetryLimit.code, "ENVIRONMENT_RETRY_LIMIT");
pass("FX-F4-FAIL-FAST-ENVIRONMENT", "환경 장애는 환경 fingerprint가 달라진 경우에만 1회 재평가");

const codeFailure = {
  class: "code",
  failure_fingerprint: "test-failure:assertion-17",
  tree_sha: "a".repeat(40),
};
const sameCodeTree = decideRetry({
  attempt_boundary: NO_CLAIM_NO_DISPATCH,
  failure: codeFailure,
  candidate: { tree_sha: codeFailure.tree_sha, environment_fingerprint: "env-changed" },
});
assert.equal(sameCodeTree.retry_allowed, false);
assert.equal(sameCodeTree.code, "SAME_CODE_TREE");

const changedCodeTree = decideRetry({
  attempt_boundary: NO_CLAIM_NO_DISPATCH,
  failure: codeFailure,
  candidate: { tree_sha: "b".repeat(40), environment_fingerprint: "env-same" },
});
assert.equal(changedCodeTree.retry_allowed, true);
assert.equal(changedCodeTree.code, "CODE_CHANGED");

const codeRetryLimit = decideRetry({
  attempt_boundary: NO_CLAIM_NO_DISPATCH,
  failure: { ...codeFailure, tree_sha: "b".repeat(40) },
  candidate: { tree_sha: "c".repeat(40) },
  previous_failures: [codeFailure],
});
assert.equal(codeRetryLimit.retry_allowed, false);
assert.equal(codeRetryLimit.code, "CODE_RETRY_LIMIT");
pass("FX-F4-FAIL-FAST-CODE", "코드 실패와 환경 차단을 분리하고 변경 tree에서만 1회 재평가");

const retryAfterClaim = decideRetry({
  attempt_boundary: { claim_status: "ACQUIRED", dispatch_status: "NOT_RUN" },
  failure: codeFailure,
  candidate: { tree_sha: "d".repeat(40) },
});
assert.equal(retryAfterClaim.status, "STOP");
assert.equal(retryAfterClaim.code, "RETRY_BOUNDARY_UNSAFE");
assert.equal(retryAfterClaim.retry_allowed, false);

const retryAfterUnknownDispatch = decideRetry({
  attempt_boundary: { claim_status: "ACQUIRED", dispatch_status: "UNKNOWN" },
  failure: { ...codeFailure, tree_sha: "b".repeat(40) },
  candidate: { tree_sha: "d".repeat(40) },
});
assert.equal(retryAfterUnknownDispatch.status, "STOP");
assert.equal(retryAfterUnknownDispatch.code, "RETRY_BOUNDARY_UNSAFE");
assert.equal(retryAfterUnknownDispatch.retry_allowed, false);

const retryWithoutBoundary = decideRetry({
  failure: codeFailure,
  candidate: { tree_sha: "d".repeat(40) },
});
assert.equal(retryWithoutBoundary.status, "STOP");
assert.equal(retryWithoutBoundary.code, "RETRY_BOUNDARY_UNSAFE");
assert.equal(retryWithoutBoundary.retry_allowed, false);
pass("FX-F4-RETRY-CLAIM-BOUNDARY", "Claim 또는 불명확한 Dispatch 이후 자동 재시도를 fail-closed");

const checkpoint = {
  status: "interrupted",
  repo: "ranikun-labs/oh-my-ai",
  sha: "1".repeat(40),
  tree_sha: "2".repeat(40),
  environment_fingerprint: "checkpoint-env-v1",
  next_step: "continue bounded test review",
  test_evidence: {
    status: "passed",
    evidence_ref: "synthetic-test-run:123",
    repo: "ranikun-labs/oh-my-ai",
    plan_id: "f4-capability-fixtures",
    plan_digest: "3".repeat(64),
    sha: "1".repeat(40),
    tree_sha: "2".repeat(40),
    environment_fingerprint: "checkpoint-env-v1",
  },
};
const current = {
  repo: checkpoint.repo,
  sha: checkpoint.sha,
  tree_sha: checkpoint.tree_sha,
  environment_fingerprint: checkpoint.environment_fingerprint,
  test_plan: {
    id: "f4-capability-fixtures",
    digest: "3".repeat(64),
  },
};
const trustedFixtureVerifier = (evidence, expected) => (
  evidence.evidence_ref === "synthetic-test-run:123"
    && evidence.repo === expected.repo
    && evidence.repo === "ranikun-labs/oh-my-ai"
    && evidence.sha === expected.sha
    && evidence.tree_sha === expected.tree_sha
    && evidence.environment_fingerprint === expected.environment_fingerprint
    && evidence.plan_id === expected.test_plan.id
    && evidence.plan_digest === expected.test_plan.digest
);
const reusable = assessCheckpointResume(checkpoint, current, trustedFixtureVerifier);
assert.equal(reusable.status, "RESUME_ELIGIBLE");
assert.equal(reusable.resume_status, "ELIGIBLE_ONLY");
assert.equal(reusable.execution_status, "NOT_RUN");
assert.equal(reusable.reused_test_evidence_ref, "synthetic-test-run:123");
pass("FX-F4-CHECKPOINT-EXACT-MATCH", "SHA·Tree·환경·테스트 계획 증거 일치 시 증거만 재사용 후보");

const differentRepoEvidence = assessCheckpointResume({
  ...checkpoint,
  test_evidence: {
    ...checkpoint.test_evidence,
    repo: "example/other-repo",
  },
}, current, trustedFixtureVerifier);
assert.equal(differentRepoEvidence.status, "BLOCKED");
assert.ok(differentRepoEvidence.blockers.some(
  item => item.code === "TEST_REPOSITORY_MISMATCH",
));

const staleSha = assessCheckpointResume(
  checkpoint,
  { ...current, sha: "4".repeat(40) },
  trustedFixtureVerifier,
);
assert.equal(staleSha.status, "BLOCKED");
assert.ok(staleSha.blockers.some(item => item.code === "SHA_CHANGED"));

const staleTree = assessCheckpointResume(
  checkpoint,
  { ...current, tree_sha: "5".repeat(40) },
  trustedFixtureVerifier,
);
assert.ok(staleTree.blockers.some(item => item.code === "TREE_CHANGED"));

const changedEnvironment = assessCheckpointResume(
  checkpoint,
  { ...current, environment_fingerprint: "checkpoint-env-v2" },
  trustedFixtureVerifier,
);
assert.ok(changedEnvironment.blockers.some(item => item.code === "ENVIRONMENT_CHANGED"));

const changedTestPlan = assessCheckpointResume(
  checkpoint,
  { ...current, test_plan: { id: "f4-capability-fixtures", digest: "6".repeat(64) } },
  trustedFixtureVerifier,
);
assert.ok(changedTestPlan.blockers.some(item => item.code === "TEST_PLAN_CHANGED"));

const untrustedEvidence = assessCheckpointResume(checkpoint, current);
assert.ok(untrustedEvidence.blockers.some(item => item.code === "TEST_EVIDENCE_UNVERIFIED"));

const failedTests = assessCheckpointResume({
  ...checkpoint,
  test_evidence: { ...checkpoint.test_evidence, status: "failed" },
}, current, trustedFixtureVerifier);
assert.ok(failedTests.blockers.some(item => item.code === "TESTS_NOT_PASS"));

const missingTests = assessCheckpointResume({
  ...checkpoint,
  test_evidence: null,
}, current, trustedFixtureVerifier);
assert.ok(missingTests.blockers.some(item => item.code === "TEST_EVIDENCE_MISSING"));

const completedCheckpoint = assessCheckpointResume({
  ...checkpoint,
  status: "completed",
}, current, trustedFixtureVerifier);
assert.ok(completedCheckpoint.blockers.some(item => item.code === "CHECKPOINT_STATE_INVALID"));
pass("FX-F4-CHECKPOINT-STALE-OR-UNTRUSTED", "불일치 SHA·Tree·환경·테스트 및 신뢰 검증 누락 거부");

const badTask = preflightExecution(
  {
    requirements: {
      capabilities: ["git", "made-up"],
      approval_required: false,
    },
  },
  approvalEnv,
);
assert.equal(badTask.status, "BLOCKED");
assert.equal(badTask.code, "PREFLIGHT_INVALID");
assert.equal(badTask.dispatch_status, "NOT_RUN");
pass("FX-F4-INVALID-TASK", "잘못된 capability 선언은 실행 경로 없이 차단");

process.stdout.write("F4 execution-capability fixtures: " + PASS.length + " passed\n");
