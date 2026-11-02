#!/usr/bin/env node

import assert from "node:assert/strict";
import { preflightCapabilityMvp } from "./lib/rpl-118-capability-preflight-mvp.mjs";

const passed = [];
const now = new Date().toISOString();

function record(id, capability, task, status = "available", overrides = {}) {
  const source = task.sources.find(item => item.source_id === id);
  return {
    status,
    verified: true,
    evidence_ref: "synthetic-capability:" + id,
    observed_at: now,
    provider_id: "synthetic-provider",
    runtime_id: "synthetic-codex",
    environment_fingerprint: "synthetic-env-v1",
    capability,
    task_id: task.task_id,
    scope_ref: task.scope_ref,
    operation: source.operation,
    resource: source.resource,
    tool_id: source.tool_id,
    permission: { ...source.permission },
    source_revision: source.source_revision,
    reason: status === "unavailable" ? "synthetic capability unavailable" : "",
    ...overrides,
  };
}

function source(id, capability, taskKind, operation, resource) {
  return {
    source_id: id,
    capability,
    tool_id: "tool:" + capability,
    permission: {
      kind: taskKind,
      scope: taskKind.toLowerCase() + ":" + resource,
    },
    operation,
    resource,
    source_revision: "revision:" + id + ":1",
  };
}

function task(taskKind, sources) {
  const currentTask = {
    task_id: "task:" + taskKind.toLowerCase(),
    scope_ref: "scope:" + taskKind.toLowerCase(),
    task_kind: taskKind,
    sources,
    // Deliberately untrusted and ignored by the implementation.
    approval_required: false,
  };
  currentTask.runtime_evidence = {
    verified: true,
    provider_id: "synthetic-provider",
    runtime_id: "synthetic-codex",
    environment_fingerprint: "synthetic-env-v1",
    observed_at: now,
    evidence_ref: "synthetic-runtime:" + currentTask.task_id,
  };
  currentTask.source_scope_evidence = {
    scope_ref: currentTask.scope_ref,
    evidence_ref: "synthetic-source-scope:" + currentTask.task_id,
    source_ids: sources.map(item => item.source_id),
  };
  return currentTask;
}

function environment(currentTask, statuses = {}) {
  return {
    provider_id: "synthetic-provider",
    runtime_id: "synthetic-codex",
    fingerprint: "synthetic-env-v1",
    capabilities: Object.fromEntries(currentTask.sources.map(item => [
      item.capability,
      record(item.source_id, item.capability, currentTask, statuses[item.source_id] || "available"),
    ])),
  };
}

function verifiers() {
  return {
    verifyCapabilityEvidence(evidence, context) {
      return evidence.evidence_ref === "synthetic-capability:" + context.source_id
        && evidence.runtime_id === context.runtime_id
        && evidence.task_id === context.task_id
        && evidence.scope_ref === context.scope_ref
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
    verifyCurrentRuntimeEvidence(evidence, context) {
      return evidence.evidence_ref === "synthetic-runtime:" + context.task_id
        && evidence.runtime_id === context.current_runtime_id
        && evidence.provider_id === "synthetic-provider"
        && evidence.environment_fingerprint === "synthetic-env-v1";
    },
    verifySourceScopeEvidence(evidence, context) {
      return evidence.evidence_ref === "synthetic-source-scope:" + context.task_id
        && evidence.scope_ref === context.scope_ref
        && JSON.stringify(evidence.source_ids)
          === JSON.stringify(context.required_sources.map(item => item.source_id));
    },
    verifyReviewAuthorization(evidence, context) {
      return evidence.evidence_ref === "synthetic-review-approval:" + context.task_id
        && evidence.status === "approved"
        && evidence.scope === context.scope_ref
        && context.target.base_sha === "a".repeat(40)
        && context.target.head_sha === "b".repeat(40);
    },
    verifyReviewProfilePolicy(evidence, context) {
      return evidence.evidence_ref === "synthetic-review-profile:" + context.task_id
        && evidence.task_id === context.task_id
        && evidence.scope_ref === context.scope_ref
        && evidence.target.base_sha === context.target.base_sha
        && evidence.target.head_sha === context.target.head_sha
        && evidence.expected.model === "sol"
        && evidence.expected.reasoning === "high"
        && evidence.expected.fast === false
        && evidence.expected.model === context.requested.model
        && evidence.expected.reasoning === context.requested.reasoning
        && evidence.expected.fast === context.requested.fast;
    },
    verifyReviewCapabilityEvidence(evidence, context) {
      return evidence.verification_ref === "synthetic-rpl116-capability"
        && evidence.runtime_id === context.runtime_id
        && evidence.provider_id === context.provider_id
        && evidence.environment_fingerprint === context.environment_fingerprint
        && context.required_capabilities.every(name => evidence[name]?.supported === true);
    },
    verifyApproval(evidence, currentTask) {
      return evidence.evidence_ref === "synthetic-approval:" + currentTask.task_id
        && evidence.scope_ref === currentTask.scope_ref;
    },
    verifyPolicyEvidence(evidence, context) {
      return evidence.evidence_ref === "synthetic-policy:" + context.task_id
        && evidence.task_kind === context.task_kind
        && evidence.scope_ref === context.scope_ref;
    },
    preflightDispatch(manifest, capability) {
      const required = ["model_selection", "reasoning_selection", "fast_override", "independent_context"];
      const valid = manifest.role === "reviewer"
        && manifest.permissions === "read-only"
        && manifest.authorization?.status === "approved"
        && typeof manifest.authorization?.scope === "string"
        && typeof manifest.authorization?.evidence_ref === "string"
        && capability.runtime_id === manifest.runtime.id
        && required.every(name => capability[name]?.supported === true
          && typeof capability[name].evidence_ref === "string");
      return valid
        ? { status: "READY", code: "READY_TO_DISPATCH", required_capabilities: required }
        : { status: "BLOCKED", code: "CAPABILITY_BLOCKED", required_capabilities: [] };
    },
    verifyEffectiveReviewSettings(evidence, context) {
      return evidence.evidence_ref === "synthetic-effective:" + context.task_id
        && evidence.runtime_id === context.runtime_id
        && evidence.model === context.requested.model
        && evidence.reasoning === context.requested.reasoning
        && evidence.fast === context.requested.fast
        && evidence.target.base_sha === context.target.base_sha
        && evidence.target.head_sha === context.target.head_sha;
    },
    verifyPartialReadEvidence(evidence, context) {
      return evidence.evidence_ref === "synthetic-authority:" + context.task_id
        && evidence.scope_ref === context.scope_ref
        && context.available_sources.some(item => item.source_id === "wiki")
        && context.missing_sources.every(item => item.source_id !== "canonical");
    },
    verifyHandoffDestination(evidence, context) {
      return evidence.evidence_ref === "synthetic-destination:" + context.task_id
        && evidence.scope_ref === context.scope_ref
        && evidence.connected === true
        && evidence.environment_fingerprint === "synthetic-env-v1"
        && context.required_sources.every(source => (
          evidence.tool_id === source.tool_id
            && evidence.operation === source.operation
            && evidence.resource_scope === source.resource
            && evidence.permission_scope === source.permission.scope
        ));
    },
  };
}

function allowPolicy(currentTask, approvalRequired = false) {
  return {
    decision: "allow",
    task_kind: currentTask.task_kind,
    scope_ref: currentTask.scope_ref,
    approval_required: approvalRequired,
    evidence_ref: "synthetic-policy:" + currentTask.task_id,
  };
}

function approval(currentTask, scopeRef = currentTask.scope_ref) {
  return {
    status: "approved",
    verified: true,
    evidence_ref: "synthetic-approval:" + currentTask.task_id,
    scope_ref: scopeRef,
  };
}

function knownHandoff(currentTask) {
  return {
    connected: true,
    verified: true,
    destination_id: "synthetic-reviewer",
    provider_id: "synthetic-provider",
    runtime_id: "synthetic-review-runtime",
    environment_fingerprint: "synthetic-env-v1",
    tool_id: currentTask.sources[0].tool_id,
    operation: currentTask.sources[0].operation,
    resource_scope: currentTask.sources[0].resource,
    permission_scope: currentTask.sources[0].permission.scope,
    scope_ref: currentTask.scope_ref,
    observed_at: now,
    evidence_ref: "synthetic-destination:" + currentTask.task_id,
  };
}

function knownReviewGuard(currentTask) {
  const target = {
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
  };
  currentTask.review_target = target;
  const required = ["model_selection", "reasoning_selection", "fast_override", "independent_context"];
  currentTask.review_guard_evidence = {
    manifest: {
      agent_id: "writer-agent",
      reviewing_agent_id: "independent-reviewer",
      role: "reviewer",
      permissions: "read-only",
      task: "Review fixed candidate",
      requested: { model: "sol", reasoning: "high", fast: false },
      runtime: {
        id: "synthetic-codex",
        provider_id: "synthetic-provider",
        environment_fingerprint: "synthetic-env-v1",
      },
      authorization: {
        status: "approved",
        scope: currentTask.scope_ref,
        evidence_ref: "synthetic-review-approval:" + currentTask.task_id,
      },
      target,
    },
    capability: {
      runtime_id: "synthetic-codex",
      provider_id: "synthetic-provider",
      environment_fingerprint: "synthetic-env-v1",
      verification_ref: "synthetic-rpl116-capability",
      ...Object.fromEntries(required.map(name => [name, {
        supported: true,
        evidence_ref: "synthetic-rpl116:" + name,
      }])),
    },
    effective_settings_attestation: {
      verified: true,
      runtime_id: "synthetic-codex",
      provider_id: "synthetic-provider",
      environment_fingerprint: "synthetic-env-v1",
      model: "sol",
      reasoning: "high",
      fast: false,
      independent_context: true,
      independent_context_ref: "synthetic-independent-context",
      evidence_ref: "synthetic-effective:" + currentTask.task_id,
      observed_at: now,
      target,
    },
    profile_policy_evidence: {
      task_id: currentTask.task_id,
      scope_ref: currentTask.scope_ref,
      target,
      expected: { model: "sol", reasoning: "high", fast: false },
      evidence_ref: "synthetic-review-profile:" + currentTask.task_id,
    },
  };
  return currentTask;
}

function pass(id) {
  passed.push(id);
}

const readSources = [
  source("wiki", "github_api", "READ", "read", "repo:ranikun-labs/oh-my-ai"),
  source("docs", "git", "READ", "read", "repo:ranikun-labs/oh-my-ai/docs"),
];
const fullReadTask = task("READ", readSources);
const fullRead = preflightCapabilityMvp(
  fullReadTask,
  environment(fullReadTask),
  verifiers(),
);
assert.equal(fullRead.status, "READY");
assert.equal(fullRead.observation, "AVAILABLE");
assert.equal(fullRead.scope_completeness, "COMPLETE");
assert.equal(fullRead.dispatch_status, "NOT_RUN");
assert.equal(fullRead.source_observations[0].provenance.verification, "VERIFIED");
assert.equal(fullRead.source_observations[0].provenance.observed.source_revision, "revision:wiki:1");
assert.equal(fullRead.executor_selection.status, "NOT_RUN");
assert.ok(Date.parse(fullRead.checked_at));
pass("READ_COMPLETE");

const duplicateCapabilitySources = [
  source("repository-a", "github_api", "READ", "read", "repo:org-a/project"),
  source("repository-b", "github_api", "READ", "read", "repo:org-b/project"),
];
const duplicateCapabilityTask = task("READ", duplicateCapabilitySources);
for (const item of duplicateCapabilityTask.sources) {
  item.observation = record(item.source_id, item.capability, duplicateCapabilityTask);
}
const duplicateCapabilityEnv = environment(duplicateCapabilityTask);
const separateSources = preflightCapabilityMvp(
  duplicateCapabilityTask,
  duplicateCapabilityEnv,
  verifiers(),
);
assert.equal(separateSources.status, "READY");
assert.deepEqual(separateSources.source_observations.map(item => item.status), ["AVAILABLE", "AVAILABLE"]);
assert.deepEqual(
  separateSources.source_observations.map(item => item.provenance.observed.resource),
  ["repo:org-a/project", "repo:org-b/project"],
);
pass("SAME_CAPABILITY_SEPARATE_RESOURCES");

const partialReadTask = task("READ", readSources);
partialReadTask.partial_read_evidence = {
  scope_ref: partialReadTask.scope_ref,
  evidence_ref: "synthetic-authority:" + partialReadTask.task_id,
};
const partialRead = preflightCapabilityMvp(
  partialReadTask,
  environment(partialReadTask, { docs: "unknown" }),
  verifiers(),
);
assert.equal(partialRead.status, "READY");
assert.equal(partialRead.observation, "UNKNOWN");
assert.equal(partialRead.scope_completeness, "PARTIAL");
assert.deepEqual(partialRead.source_observations.map(item => item.status), ["AVAILABLE", "UNKNOWN"]);
assert.equal(partialRead.dispatch_status, "NOT_RUN");
pass("READ_PARTIAL_UNKNOWN_SOURCE");

const canonicalReadSources = [
  source("wiki", "github_api", "READ", "read", "repo:ranikun-labs/oh-my-ai"),
  source("canonical", "git", "READ", "read", "repo:ranikun-labs/oh-my-ai/docs"),
];
const canonicalReadTask = task("READ", canonicalReadSources);
canonicalReadTask.partial_read_evidence = {
  scope_ref: canonicalReadTask.scope_ref,
  evidence_ref: "synthetic-authority:" + canonicalReadTask.task_id,
};
const missingCanonical = preflightCapabilityMvp(
  canonicalReadTask,
  environment(canonicalReadTask, { canonical: "unknown" }),
  verifiers(),
);
assert.equal(missingCanonical.status, "BLOCKED");
assert.equal(missingCanonical.code, "MVP_READ_AUTHORITY_UNVERIFIED");
assert.equal(missingCanonical.scope_completeness, "PARTIAL");
pass("PARTIAL_READ_MISSING_CANONICAL_AUTHORITY_BLOCKED");

const unknownReadTask = task("READ", [readSources[0]]);
const unknownRead = preflightCapabilityMvp(
  unknownReadTask,
  environment(unknownReadTask, { wiki: "unknown" }),
  verifiers(),
);
assert.equal(unknownRead.status, "BLOCKED");
assert.equal(unknownRead.observation, "UNKNOWN");
assert.equal(unknownRead.dispatch_status, "NOT_RUN");
pass("REQUIRED_SOURCE_UNKNOWN");

const untrustedSourceSetTask = task("READ", [readSources[0]]);
untrustedSourceSetTask.source_scope_evidence.source_ids = ["another-source"];
const untrustedSourceSet = preflightCapabilityMvp(
  untrustedSourceSetTask,
  environment(untrustedSourceSetTask),
  verifiers(),
);
assert.equal(untrustedSourceSet.status, "BLOCKED");
assert.equal(untrustedSourceSet.code, "MVP_SOURCE_SCOPE_UNVERIFIED");
pass("SOURCE_SET_MUST_MATCH_TRUSTED_WORK_CONTEXT");

const unavailableReadTask = task("READ", [readSources[0]]);
const unavailableRead = preflightCapabilityMvp(
  unavailableReadTask,
  environment(unavailableReadTask, { wiki: "unavailable" }),
  verifiers(),
);
assert.equal(unavailableRead.status, "BLOCKED");
assert.equal(unavailableRead.observation, "UNAVAILABLE");
assert.equal(unavailableRead.source_observations[0].status, "UNAVAILABLE");
pass("REQUIRED_SOURCE_UNAVAILABLE");

const writeSource = source(
  "repository-write",
  "github_api",
  "WRITE",
  "write",
  "repo:ranikun-labs/oh-my-ai",
);
const writeTask = task("WRITE", [writeSource]);
writeTask.policy_evidence = allowPolicy(writeTask, true);
const forgedApprovalBypass = preflightCapabilityMvp(
  writeTask,
  environment(writeTask),
  verifiers(),
);
assert.equal(forgedApprovalBypass.status, "BLOCKED");
assert.equal(forgedApprovalBypass.dispatch_status, "NOT_RUN");
pass("WRITE_CALLER_APPROVAL_FALSE_IGNORED");

const approvedWriteTask = task("WRITE", [writeSource]);
approvedWriteTask.policy_evidence = allowPolicy(approvedWriteTask, true);
approvedWriteTask.authorization = approval(approvedWriteTask);
const approvedWrite = preflightCapabilityMvp(
  approvedWriteTask,
  environment(approvedWriteTask),
  verifiers(),
);
assert.equal(approvedWrite.status, "READY");
assert.equal(approvedWrite.dispatch_status, "NOT_RUN");
pass("WRITE_VERIFIED_POLICY_AND_APPROVAL");

const wrongScopeWriteTask = task("WRITE", [writeSource]);
wrongScopeWriteTask.policy_evidence = allowPolicy(wrongScopeWriteTask, true);
wrongScopeWriteTask.authorization = approval(wrongScopeWriteTask, "scope:other");
const wrongScopeWrite = preflightCapabilityMvp(
  wrongScopeWriteTask,
  environment(wrongScopeWriteTask),
  verifiers(),
);
assert.equal(wrongScopeWrite.status, "BLOCKED");
pass("WRITE_APPROVAL_SCOPE_MISMATCH");

const forgedWriteTask = task("WRITE", [writeSource]);
forgedWriteTask.policy_evidence = allowPolicy(forgedWriteTask, true);
forgedWriteTask.authorization = {
  status: "approved",
  verified: true,
  evidence_ref: "caller-forged-approval",
  scope_ref: forgedWriteTask.scope_ref,
};
const forgedWrite = preflightCapabilityMvp(
  forgedWriteTask,
  environment(forgedWriteTask),
  verifiers(),
);
assert.equal(forgedWrite.status, "BLOCKED");
assert.equal(forgedWrite.dispatch_status, "NOT_RUN");
pass("WRITE_FORGED_APPROVAL_REJECTED");

const wrongPolicyScopeTask = task("WRITE", [writeSource]);
wrongPolicyScopeTask.policy_evidence = {
  ...allowPolicy(wrongPolicyScopeTask, false),
  scope_ref: "scope:another-task",
};
const wrongPolicyScope = preflightCapabilityMvp(
  wrongPolicyScopeTask,
  environment(wrongPolicyScopeTask),
  verifiers(),
);
assert.equal(wrongPolicyScope.status, "BLOCKED");
assert.equal(wrongPolicyScope.code, "MVP_POLICY_BLOCKED");
pass("WRITE_POLICY_SCOPE_MISMATCH");

const policyWaivesWriteApprovalTask = task("WRITE", [writeSource]);
policyWaivesWriteApprovalTask.policy_evidence = allowPolicy(policyWaivesWriteApprovalTask, false);
const policyWaivesWriteApproval = preflightCapabilityMvp(
  policyWaivesWriteApprovalTask,
  environment(policyWaivesWriteApprovalTask),
  verifiers(),
);
assert.equal(policyWaivesWriteApproval.status, "BLOCKED");
assert.equal(policyWaivesWriteApproval.code, "MVP_POLICY_BLOCKED");
pass("WRITE_POLICY_CANNOT_WAIVE_OWNER_APPROVAL");

const unapprovedWriteHandoffTask = task("WRITE", [writeSource]);
unapprovedWriteHandoffTask.policy_evidence = allowPolicy(unapprovedWriteHandoffTask, true);
unapprovedWriteHandoffTask.handoff_destination = knownHandoff(unapprovedWriteHandoffTask);
unapprovedWriteHandoffTask.runtime_evidence.verified = false;
const unapprovedWriteHandoff = preflightCapabilityMvp(
  unapprovedWriteHandoffTask,
  environment(unapprovedWriteHandoffTask),
  verifiers(),
);
assert.equal(unapprovedWriteHandoff.status, "BLOCKED");
assert.equal(unapprovedWriteHandoff.handoff_destination, null);
pass("WRITE_APPROVAL_CHECKED_BEFORE_HANDOFF");

const unknownHandoffTask = task("READ", [readSources[0]]);
unknownHandoffTask.handoff_destination = {
  ...knownHandoff(unknownHandoffTask),
  evidence_ref: "caller-claimed-destination",
};
const unknownHandoff = preflightCapabilityMvp(
  unknownHandoffTask,
  environment(unknownHandoffTask, { wiki: "unavailable" }),
  verifiers(),
);
assert.equal(unknownHandoff.status, "BLOCKED");
assert.equal(unknownHandoff.handoff_destination, null);
pass("HANDOFF_DESTINATION_UNVERIFIED");

const verifiedHandoffTask = task("READ", [readSources[0]]);
verifiedHandoffTask.handoff_destination = knownHandoff(verifiedHandoffTask);
const verifiedHandoff = preflightCapabilityMvp(
  verifiedHandoffTask,
  environment(verifiedHandoffTask, { wiki: "unknown" }),
  verifiers(),
);
assert.equal(verifiedHandoff.status, "HANDOFF");
assert.equal(verifiedHandoff.handoff_destination.destination_id, "synthetic-reviewer");
assert.equal(verifiedHandoff.handoff_destination.verification, "VERIFIED");
assert.equal(verifiedHandoff.dispatch_status, "NOT_RUN");
pass("HANDOFF_VERIFIED_DESTINATION_ONLY");

const mismatchedHandoffTask = task("READ", [readSources[0]]);
mismatchedHandoffTask.handoff_destination = {
  ...knownHandoff(mismatchedHandoffTask),
  operation: "delete",
};
const mismatchedHandoff = preflightCapabilityMvp(
  mismatchedHandoffTask,
  environment(mismatchedHandoffTask, { wiki: "unknown" }),
  verifiers(),
);
assert.equal(mismatchedHandoff.status, "BLOCKED");
assert.equal(mismatchedHandoff.handoff_destination, null);
pass("HANDOFF_OPERATION_MISMATCH_BLOCKED");

const staleHandoffTask = task("READ", [readSources[0]]);
staleHandoffTask.handoff_destination = {
  ...knownHandoff(staleHandoffTask),
  observed_at: new Date(Date.now() - (6 * 60 * 1000)).toISOString(),
};
const staleHandoff = preflightCapabilityMvp(
  staleHandoffTask,
  environment(staleHandoffTask, { wiki: "unknown" }),
  verifiers(),
);
assert.equal(staleHandoff.status, "BLOCKED");
assert.equal(staleHandoff.handoff_destination, null);
pass("HANDOFF_STALE_CONNECTION_BLOCKED");

const reviewSource = source("review-target", "git", "REVIEW", "read", "repo:ranikun-labs/oh-my-ai");
const unknownReviewTask = task("REVIEW", [reviewSource]);
const unknownReview = preflightCapabilityMvp(
  unknownReviewTask,
  environment(unknownReviewTask),
  verifiers(),
);
assert.equal(unknownReview.status, "BLOCKED");
assert.equal(unknownReview.code, "MVP_REVIEW_GUARD_BLOCKED");
assert.equal(unknownReview.dispatch_status, "NOT_RUN");
pass("REVIEW_GUARD_UNKNOWN_BLOCKED");

const handedOffReviewTask = task("REVIEW", [reviewSource]);
handedOffReviewTask.handoff_destination = knownHandoff(handedOffReviewTask);
const handedOffReview = preflightCapabilityMvp(
  handedOffReviewTask,
  environment(handedOffReviewTask),
  verifiers(),
);
assert.equal(handedOffReview.status, "HANDOFF");
assert.equal(handedOffReview.dispatch_status, "NOT_RUN");
pass("REVIEW_GUARD_UNKNOWN_VERIFIED_HANDOFF");

const readyReviewTask = task("REVIEW", [reviewSource]);
knownReviewGuard(readyReviewTask);
const readyReview = preflightCapabilityMvp(
  readyReviewTask,
  environment(readyReviewTask),
  verifiers(),
);
assert.equal(readyReview.status, "READY");
assert.equal(readyReview.dispatch_status, "NOT_RUN");
pass("REVIEW_GUARD_VERIFIED");

for (const [label, requested] of [
  ["MODEL", { model: "other", reasoning: "high", fast: false }],
  ["REASONING", { model: "sol", reasoning: "medium", fast: false }],
  ["FAST", { model: "sol", reasoning: "high", fast: true }],
]) {
  const mismatchedProfileTask = task("REVIEW", [reviewSource]);
  knownReviewGuard(mismatchedProfileTask);
  mismatchedProfileTask.review_guard_evidence.manifest.requested = requested;
  Object.assign(
    mismatchedProfileTask.review_guard_evidence.effective_settings_attestation,
    requested,
  );
  mismatchedProfileTask.review_guard_evidence.profile_policy_evidence.expected = requested;
  const mismatchedProfile = preflightCapabilityMvp(
    mismatchedProfileTask,
    environment(mismatchedProfileTask),
    verifiers(),
  );
  assert.equal(mismatchedProfile.status, "BLOCKED");
  assert.equal(mismatchedProfile.dispatch_status, "NOT_RUN");
  pass("REVIEW_PROFILE_" + label + "_MISMATCH_BLOCKED");
}

const foreignReviewCapabilityTask = task("REVIEW", [reviewSource]);
knownReviewGuard(foreignReviewCapabilityTask);
foreignReviewCapabilityTask.review_guard_evidence.capability.environment_fingerprint = "old-env";
const foreignReviewCapability = preflightCapabilityMvp(
  foreignReviewCapabilityTask,
  environment(foreignReviewCapabilityTask),
  verifiers(),
);
assert.equal(foreignReviewCapability.status, "BLOCKED");
pass("REVIEW_CAPABILITY_ENVIRONMENT_MISMATCH_BLOCKED");

const foreignReviewEffectiveTask = task("REVIEW", [reviewSource]);
knownReviewGuard(foreignReviewEffectiveTask);
foreignReviewEffectiveTask.review_guard_evidence.effective_settings_attestation.environment_fingerprint = "old-env";
const foreignReviewEffective = preflightCapabilityMvp(
  foreignReviewEffectiveTask,
  environment(foreignReviewEffectiveTask),
  verifiers(),
);
assert.equal(foreignReviewEffective.status, "BLOCKED");
pass("REVIEW_EFFECTIVE_SETTINGS_ENVIRONMENT_MISMATCH_BLOCKED");

const claimedReviewApprovalTask = task("REVIEW", [reviewSource]);
knownReviewGuard(claimedReviewApprovalTask);
const claimedReviewApproval = preflightCapabilityMvp(
  claimedReviewApprovalTask,
  environment(claimedReviewApprovalTask),
  {
    ...verifiers(),
    verifyReviewAuthorization() { return false; },
  },
);
assert.equal(claimedReviewApproval.status, "BLOCKED");
assert.equal(claimedReviewApproval.code, "MVP_REVIEW_GUARD_BLOCKED");
pass("REVIEW_CALLER_CLAIMED_APPROVAL_NOT_TRUSTED");

const missingReviewApprovalTask = task("REVIEW", [reviewSource]);
knownReviewGuard(missingReviewApprovalTask);
delete missingReviewApprovalTask.review_guard_evidence.manifest.authorization.status;
const missingReviewApproval = preflightCapabilityMvp(
  missingReviewApprovalTask,
  environment(missingReviewApprovalTask),
  verifiers(),
);
assert.equal(missingReviewApproval.status, "BLOCKED");
assert.equal(missingReviewApproval.code, "MVP_REVIEW_GUARD_BLOCKED");
pass("REVIEW_APPROVAL_STATUS_REQUIRED");

const wrongReviewApprovalScopeTask = task("REVIEW", [reviewSource]);
knownReviewGuard(wrongReviewApprovalScopeTask);
wrongReviewApprovalScopeTask.review_guard_evidence.manifest.authorization.scope = "scope:other";
const wrongReviewApprovalScope = preflightCapabilityMvp(
  wrongReviewApprovalScopeTask,
  environment(wrongReviewApprovalScopeTask),
  verifiers(),
);
assert.equal(wrongReviewApprovalScope.status, "BLOCKED");
assert.equal(wrongReviewApprovalScope.code, "MVP_REVIEW_GUARD_BLOCKED");
pass("REVIEW_APPROVAL_SCOPE_MISMATCH_BLOCKED");

const writeableReviewerTask = task("REVIEW", [reviewSource]);
knownReviewGuard(writeableReviewerTask);
writeableReviewerTask.review_guard_evidence.manifest.permissions = "scoped-write";
const writeableReviewer = preflightCapabilityMvp(
  writeableReviewerTask,
  environment(writeableReviewerTask),
  verifiers(),
);
assert.equal(writeableReviewer.status, "BLOCKED");
pass("REVIEW_MUST_BE_READ_ONLY");

const staleReviewTargetTask = task("REVIEW", [reviewSource]);
knownReviewGuard(staleReviewTargetTask);
staleReviewTargetTask.review_guard_evidence.effective_settings_attestation.target = {
  base_sha: "a".repeat(40),
  head_sha: "c".repeat(40),
};
const staleReviewTarget = preflightCapabilityMvp(
  staleReviewTargetTask,
  environment(staleReviewTargetTask),
  verifiers(),
);
assert.equal(staleReviewTarget.status, "BLOCKED");
pass("REVIEW_FIXED_HEAD_MISMATCH_BLOCKED");

const wrongEffectiveFastTask = task("REVIEW", [reviewSource]);
knownReviewGuard(wrongEffectiveFastTask);
wrongEffectiveFastTask.review_guard_evidence.effective_settings_attestation.fast = true;
const wrongEffectiveFast = preflightCapabilityMvp(
  wrongEffectiveFastTask,
  environment(wrongEffectiveFastTask),
  verifiers(),
);
assert.equal(wrongEffectiveFast.status, "BLOCKED");
pass("REVIEW_EFFECTIVE_FAST_MISMATCH_BLOCKED");

const rejectedGuardTask = task("REVIEW", [reviewSource]);
knownReviewGuard(rejectedGuardTask);
const rejectedGuardVerifiers = {
  ...verifiers(),
  preflightDispatch() {
    return { status: "BLOCKED", code: "CAPABILITY_BLOCKED", required_capabilities: [] };
  },
};
const rejectedGuard = preflightCapabilityMvp(
  rejectedGuardTask,
  environment(rejectedGuardTask),
  rejectedGuardVerifiers,
);
assert.equal(rejectedGuard.status, "BLOCKED");
pass("RPL116_PREFLIGHT_FAILURE_BLOCKED");

const staleReadTask = task("READ", [readSources[0]]);
const staleEnvironment = environment(staleReadTask);
staleEnvironment.capabilities.github_api.observed_at = new Date(Date.now() - (6 * 60 * 1000)).toISOString();
const staleRead = preflightCapabilityMvp(staleReadTask, staleEnvironment, verifiers());
assert.equal(staleRead.status, "BLOCKED");
assert.equal(staleRead.source_observations[0].status, "UNKNOWN");
assert.equal(staleRead.source_observations[0].provenance.verification, "CLAIMED");
assert.ok(staleRead.source_observations[0].provenance.observed.observed_at);
pass("STALE_OBSERVATION_UNKNOWN");

const mismatchedRuntimeTask = task("READ", [readSources[0]]);
const mismatchedRuntimeEnv = environment(mismatchedRuntimeTask);
mismatchedRuntimeEnv.capabilities.github_api.runtime_id = "other-runtime";
const mismatchedRuntime = preflightCapabilityMvp(mismatchedRuntimeTask, mismatchedRuntimeEnv, verifiers());
assert.equal(mismatchedRuntime.status, "BLOCKED");
assert.equal(mismatchedRuntime.source_observations[0].status, "UNKNOWN");
pass("RUNTIME_IDENTITY_MISMATCH");

const foreignEnvironmentTask = task("READ", [readSources[0]]);
const foreignEnvironment = environment(foreignEnvironmentTask);
foreignEnvironment.runtime_id = "foreign-runtime";
const foreignRuntime = preflightCapabilityMvp(foreignEnvironmentTask, foreignEnvironment, verifiers());
assert.equal(foreignRuntime.status, "BLOCKED");
assert.equal(foreignRuntime.code, "MVP_RUNTIME_UNIDENTIFIED");
pass("CURRENT_RUNTIME_ATTESTATION_MISMATCH");

const staleRuntimeTask = task("READ", [readSources[0]]);
staleRuntimeTask.runtime_evidence.observed_at = new Date(Date.now() - (6 * 60 * 1000)).toISOString();
const staleRuntime = preflightCapabilityMvp(
  staleRuntimeTask,
  environment(staleRuntimeTask),
  verifiers(),
);
assert.equal(staleRuntime.status, "BLOCKED");
assert.equal(staleRuntime.code, "MVP_RUNTIME_UNIDENTIFIED");
pass("STALE_CURRENT_RUNTIME_ATTESTATION_BLOCKED");

const wrongRevisionTask = task("READ", [readSources[0]]);
const wrongRevisionEnv = environment(wrongRevisionTask);
wrongRevisionEnv.capabilities.github_api.source_revision = "revision:other:9";
const wrongRevision = preflightCapabilityMvp(wrongRevisionTask, wrongRevisionEnv, verifiers());
assert.equal(wrongRevision.status, "BLOCKED");
assert.equal(wrongRevision.source_observations[0].status, "UNKNOWN");
assert.equal(wrongRevision.source_observations[0].provenance.verification, "CLAIMED");
assert.equal(wrongRevision.source_observations[0].provenance.observed.source_revision, "revision:other:9");
pass("SOURCE_REVISION_MISMATCH");

const wrongToolTask = task("READ", [readSources[0]]);
const wrongToolEnv = environment(wrongToolTask);
wrongToolEnv.capabilities.github_api.tool_id = "unverified-tool";
const wrongTool = preflightCapabilityMvp(wrongToolTask, wrongToolEnv, verifiers());
assert.equal(wrongTool.status, "BLOCKED");
assert.equal(wrongTool.source_observations[0].status, "UNKNOWN");
pass("TOOL_IDENTITY_MISMATCH");

for (const [field, value] of [["operation", "delete"], ["resource", "repo:other"]]) {
  const mismatchTask = task("READ", [readSources[0]]);
  const mismatchEnv = environment(mismatchTask);
  mismatchEnv.capabilities.github_api[field] = value;
  const mismatch = preflightCapabilityMvp(mismatchTask, mismatchEnv, verifiers());
  assert.equal(mismatch.status, "BLOCKED");
  assert.equal(mismatch.source_observations[0].status, "UNKNOWN");
  pass("SOURCE_" + field.toUpperCase() + "_MISMATCH");
}

const missingVerifierTask = task("READ", [readSources[0]]);
const missingVerifier = preflightCapabilityMvp(
  missingVerifierTask,
  environment(missingVerifierTask),
  null,
);
assert.equal(missingVerifier.status, "BLOCKED");
assert.equal(missingVerifier.observation, "UNKNOWN");
assert.equal(missingVerifier.dispatch_status, "NOT_RUN");
pass("MISSING_TRUSTED_VERIFIER_FAILS_CLOSED");

const executionSource = source("test-run", "e2e", "CODE_EXECUTION", "run", "environment:synthetic-ci");
const executionTask = task("CODE_EXECUTION", [executionSource]);
executionTask.policy_evidence = allowPolicy(executionTask, false);
const executionReady = preflightCapabilityMvp(
  executionTask,
  environment(executionTask),
  verifiers(),
);
assert.equal(executionReady.status, "READY");
assert.equal(executionReady.dispatch_status, "NOT_RUN");
pass("CODE_EXECUTION_POLICY_AND_CAPABILITY");

const executionUnavailableTask = task("CODE_EXECUTION", [executionSource]);
executionUnavailableTask.policy_evidence = allowPolicy(executionUnavailableTask, false);
executionUnavailableTask.handoff_destination = knownHandoff(executionUnavailableTask);
const crossRuntimeExecutionHandoff = preflightCapabilityMvp(
  executionUnavailableTask,
  environment(executionUnavailableTask, { "test-run": "unavailable" }),
  verifiers(),
);
assert.equal(crossRuntimeExecutionHandoff.status, "BLOCKED");
assert.equal(crossRuntimeExecutionHandoff.handoff_destination, null);
pass("CODE_EXECUTION_CROSS_RUNTIME_HANDOFF_BLOCKED");

for (const [label, identity] of [
  ["PROVIDER", { provider_id: "other-provider" }],
  ["ENVIRONMENT", { environment_fingerprint: "old-env" }],
]) {
  const mismatchedRuntimeTask = task("CODE_EXECUTION", [executionSource]);
  mismatchedRuntimeTask.policy_evidence = allowPolicy(mismatchedRuntimeTask, false);
  mismatchedRuntimeTask.handoff_destination = {
    ...knownHandoff(mismatchedRuntimeTask),
    runtime_id: "synthetic-codex",
    ...identity,
  };
  const mismatchedRuntimeHandoff = preflightCapabilityMvp(
    mismatchedRuntimeTask,
    environment(mismatchedRuntimeTask, { "test-run": "unavailable" }),
    verifiers(),
  );
  assert.equal(mismatchedRuntimeHandoff.status, "BLOCKED");
  assert.equal(mismatchedRuntimeHandoff.handoff_destination, null);
  pass("CODE_EXECUTION_" + label + "_HANDOFF_MISMATCH_BLOCKED");
}

const sameRuntimeExecutionHandoffTask = task("CODE_EXECUTION", [executionSource]);
sameRuntimeExecutionHandoffTask.policy_evidence = allowPolicy(sameRuntimeExecutionHandoffTask, false);
sameRuntimeExecutionHandoffTask.handoff_destination = {
  ...knownHandoff(sameRuntimeExecutionHandoffTask),
  runtime_id: "synthetic-codex",
  provider_id: "synthetic-provider",
  environment_fingerprint: "synthetic-env-v1",
};
const sameRuntimeExecutionHandoff = preflightCapabilityMvp(
  sameRuntimeExecutionHandoffTask,
  environment(sameRuntimeExecutionHandoffTask, { "test-run": "unavailable" }),
  verifiers(),
);
assert.equal(sameRuntimeExecutionHandoff.status, "HANDOFF");
assert.equal(sameRuntimeExecutionHandoff.dispatch_status, "NOT_RUN");
pass("CODE_EXECUTION_SAME_RUNTIME_VERIFIED_HANDOFF");

process.stdout.write("RPL-118 Capability MVP fixtures: " + passed.length + " passed\n");
