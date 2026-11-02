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
  return {
    task_id: "task:" + taskKind.toLowerCase(),
    scope_ref: "scope:" + taskKind.toLowerCase(),
    task_kind: taskKind,
    sources,
    // Deliberately untrusted and ignored by the implementation.
    approval_required: false,
  };
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
        && evidence.source_revision === context.source_revision;
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
    verifyReviewGuard(evidence, context) {
      return evidence.evidence_ref === "synthetic-rpl116:" + context.task_id
        && evidence.effective_settings === "verified"
        && evidence.scope_ref === context.scope_ref;
    },
    verifyHandoffDestination(evidence, context) {
      return evidence.evidence_ref === "synthetic-destination:" + context.task_id
        && evidence.scope_ref === context.scope_ref
        && evidence.permission_scope.length > 0;
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
    destination_id: "synthetic-reviewer",
    permission_scope: "review:read-only",
    scope_ref: currentTask.scope_ref,
    evidence_ref: "synthetic-destination:" + currentTask.task_id,
  };
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
assert.equal(fullRead.source_observations[0].provenance.source_revision, "revision:wiki:1");
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
  separateSources.source_observations.map(item => item.provenance.resource),
  ["repo:org-a/project", "repo:org-b/project"],
);
pass("SAME_CAPABILITY_SEPARATE_RESOURCES");

const partialReadTask = task("READ", readSources);
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
assert.equal(verifiedHandoff.dispatch_status, "NOT_RUN");
pass("HANDOFF_VERIFIED_DESTINATION_ONLY");

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
readyReviewTask.review_guard_evidence = {
  evidence_ref: "synthetic-rpl116:" + readyReviewTask.task_id,
  effective_settings: "verified",
  scope_ref: readyReviewTask.scope_ref,
};
const readyReview = preflightCapabilityMvp(
  readyReviewTask,
  environment(readyReviewTask),
  verifiers(),
);
assert.equal(readyReview.status, "READY");
assert.equal(readyReview.dispatch_status, "NOT_RUN");
pass("REVIEW_GUARD_VERIFIED");

const staleReadTask = task("READ", [readSources[0]]);
const staleEnvironment = environment(staleReadTask);
staleEnvironment.capabilities.github_api.observed_at = new Date(Date.now() - (6 * 60 * 1000)).toISOString();
const staleRead = preflightCapabilityMvp(staleReadTask, staleEnvironment, verifiers());
assert.equal(staleRead.status, "BLOCKED");
assert.equal(staleRead.source_observations[0].status, "UNKNOWN");
pass("STALE_OBSERVATION_UNKNOWN");

const mismatchedRuntimeTask = task("READ", [readSources[0]]);
const mismatchedRuntimeEnv = environment(mismatchedRuntimeTask);
mismatchedRuntimeEnv.capabilities.github_api.runtime_id = "other-runtime";
const mismatchedRuntime = preflightCapabilityMvp(mismatchedRuntimeTask, mismatchedRuntimeEnv, verifiers());
assert.equal(mismatchedRuntime.status, "BLOCKED");
assert.equal(mismatchedRuntime.source_observations[0].status, "UNKNOWN");
pass("RUNTIME_IDENTITY_MISMATCH");

const wrongRevisionTask = task("READ", [readSources[0]]);
const wrongRevisionEnv = environment(wrongRevisionTask);
wrongRevisionEnv.capabilities.github_api.source_revision = "revision:other:9";
const wrongRevision = preflightCapabilityMvp(wrongRevisionTask, wrongRevisionEnv, verifiers());
assert.equal(wrongRevision.status, "BLOCKED");
assert.equal(wrongRevision.source_observations[0].status, "UNKNOWN");
pass("SOURCE_REVISION_MISMATCH");

const wrongToolTask = task("READ", [readSources[0]]);
const wrongToolEnv = environment(wrongToolTask);
wrongToolEnv.capabilities.github_api.tool_id = "unverified-tool";
const wrongTool = preflightCapabilityMvp(wrongToolTask, wrongToolEnv, verifiers());
assert.equal(wrongTool.status, "BLOCKED");
assert.equal(wrongTool.source_observations[0].status, "UNKNOWN");
pass("TOOL_IDENTITY_MISMATCH");

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

process.stdout.write("RPL-118 Capability MVP fixtures: " + passed.length + " passed\n");
