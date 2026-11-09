export const EXECUTION_CAPABILITIES = Object.freeze([
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

export const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000;
export const MAX_FUTURE_CLOCK_SKEW_MS = 30 * 1000;

const CAPABILITY_SET = new Set(EXECUTION_CAPABILITIES);
const SHA_1 = /^[a-f0-9]{40}$/i;
const SHA_256 = /^[a-f0-9]{64}$/i;
const APPROVAL_STATES = new Set(["approved", "pending", "denied"]);
const FAILURE_CLASSES = new Set(["environment", "code"]);
const OPERATION_TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED_OPERATION_SEGMENTS = new Set([
  "all",
  "any",
  "unknown",
  "unspecified",
  "none",
  "default",
  "wildcard",
]);
const RESOURCE_TYPE = /^[a-z][a-z0-9-]*$/;
const RESOURCE_SEGMENT = /^[a-z0-9._-]+$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function concreteOperation(value) {
  return nonEmpty(value)
    && OPERATION_TOKEN.test(value)
    && value.split("-").every(segment => !RESERVED_OPERATION_SEGMENTS.has(segment));
}

function concreteResource(value) {
  if (!nonEmpty(value) || value !== value.trim()) return false;
  const colon = value.indexOf(":");
  if (colon <= 0 || value.indexOf(":", colon + 1) !== -1) return false;
  const type = value.slice(0, colon);
  const path = value.slice(colon + 1);
  if (!RESOURCE_TYPE.test(type) || path.length === 0) return false;

  const segments = path.split(/[\/+]/);
  return segments.every(segment => (
    segment.length > 0
      && segment !== "."
      && segment !== ".."
      && RESOURCE_SEGMENT.test(segment)
      && /[a-z0-9]/.test(segment)
  ));
}

function outcome(status, code, reasons, extra = {}) {
  return { status, code, reasons, ...extra };
}

function validateRequirements(task) {
  if (!isRecord(task)) return ["task must be an object"];
  if (!nonEmpty(task.task_id)) return ["task_id is required"];
  if (!nonEmpty(task.scope_ref)) return ["scope_ref is required"];
  if (!isRecord(task.requirements)) return ["requirements must be an object"];
  const required = task.requirements.capabilities;
  if (!Array.isArray(required) || required.length === 0) {
    return ["requirements.capabilities must be a non-empty array"];
  }
  const errors = [];
  const seen = new Set();
  for (const capability of required) {
    if (!CAPABILITY_SET.has(capability)) {
      errors.push("unknown capability: " + String(capability));
    } else if (seen.has(capability)) {
      errors.push("duplicate capability: " + capability);
    }
    seen.add(capability);
  }
  const scopes = task.requirements.capability_scopes;
  if (!isRecord(scopes)) {
    errors.push("requirements.capability_scopes must map every capability to an exact scope");
  } else {
    for (const capability of required) {
      if (!CAPABILITY_SET.has(capability)) continue;
      const scope = scopes[capability];
      if (!isRecord(scope)
          || !concreteOperation(scope.operation)
          || !concreteResource(scope.resource)) {
        errors.push(
          "capability scope for " + capability
            + " requires concrete operation and resource",
        );
      }
    }
    for (const capability of Object.keys(scopes)) {
      if (!seen.has(capability)) {
        errors.push("scope declared for unrequested capability: " + capability);
      }
    }
  }
  if (typeof task.requirements.approval_required !== "boolean") {
    errors.push("requirements.approval_required must be a boolean");
  }
  return errors;
}

function validateApproval(task, verifyApproval) {
  if (!task.requirements.approval_required) return null;
  const approval = task.authorization;
  if (!isRecord(approval) || !APPROVAL_STATES.has(approval.status)) {
    return "approval status is missing or invalid";
  }
  if (approval.status !== "approved") return "approval is " + approval.status;
  if (approval.verified !== true || !nonEmpty(approval.evidence_ref)) {
    return "approved scope lacks verified approval evidence";
  }
  if (!nonEmpty(task.scope_ref)) return "task scope reference is missing";
  if (approval.scope_ref !== task.scope_ref) {
    return "approval evidence does not match task scope";
  }
  if (typeof verifyApproval !== "function") {
    return "trusted approval verifier is unavailable";
  }
  try {
    if (verifyApproval(approval, task) !== true) return "trusted approval verifier rejected the evidence";
  } catch {
    return "trusted approval verifier failed";
  }
  return null;
}

function validObservation(observation, providerId, runtimeId) {
  return isRecord(observation)
    && ["available", "unavailable", "unknown"].includes(observation.status)
    && observation.verified === true
    && nonEmpty(observation.evidence_ref)
    && nonEmpty(observation.observed_at)
    && Number.isFinite(Date.parse(observation.observed_at))
    && nonEmpty(observation.provider_id)
    && observation.provider_id === providerId
    && nonEmpty(observation.runtime_id)
    && observation.runtime_id === runtimeId;
}

function environmentBlocker(
  capability,
  observation,
  task,
  environment,
  verifyCapabilityEvidence,
  checkedAtMs,
) {
  if (!isRecord(observation)) {
    return {
      capability,
      code: "CAPABILITY_UNKNOWN",
      reason: "no current observation",
    };
  }
  if (!validObservation(observation, environment.provider_id, environment.runtime_id)) {
    return {
      capability,
      code: observation.runtime_id !== environment.runtime_id
        ? "CAPABILITY_RUNTIME_MISMATCH"
        : "CAPABILITY_EVIDENCE_INVALID",
      reason: observation.runtime_id !== environment.runtime_id
        ? "observation belongs to a different runtime"
        : "observation is not verified or lacks provenance",
    };
  }
  if (observation.environment_fingerprint !== environment.fingerprint) {
    return {
      capability,
      code: "CAPABILITY_ENVIRONMENT_MISMATCH",
      reason: "observation belongs to a different environment fingerprint",
    };
  }
  const observedAtMs = Date.parse(observation.observed_at);
  if (observedAtMs < checkedAtMs - MAX_OBSERVATION_AGE_MS) {
    return {
      capability,
      code: "CAPABILITY_OBSERVATION_STALE",
      reason: "observation is older than the 5-minute freshness window",
    };
  }
  if (observedAtMs > checkedAtMs + MAX_FUTURE_CLOCK_SKEW_MS) {
    return {
      capability,
      code: "CAPABILITY_OBSERVATION_FUTURE",
      reason: "observation exceeds the 30-second future clock-skew bound",
    };
  }

  const requestedScope = task.requirements.capability_scopes[capability];
  if (observation.capability !== capability
      || observation.task_id !== task.task_id
      || observation.scope_ref !== task.scope_ref
      || observation.operation !== requestedScope.operation
      || observation.resource !== requestedScope.resource) {
    return {
      capability,
      code: "CAPABILITY_SCOPE_MISMATCH",
      reason: "observation does not match task, capability, operation, or resource",
    };
  }
  if (typeof verifyCapabilityEvidence !== "function") {
    return {
      capability,
      code: "CAPABILITY_EVIDENCE_UNVERIFIED",
      reason: "trusted capability evidence verifier is unavailable",
    };
  }
  try {
    if (verifyCapabilityEvidence(observation, {
      capability,
      task_id: task.task_id,
      scope_ref: task.scope_ref,
      requested_scope: {
        operation: requestedScope.operation,
        resource: requestedScope.resource,
      },
      provider_id: environment.provider_id,
      runtime_id: environment.runtime_id,
      environment_fingerprint: environment.fingerprint,
      observed_at: observation.observed_at,
      checked_at: new Date(checkedAtMs).toISOString(),
      max_observation_age_ms: MAX_OBSERVATION_AGE_MS,
      max_future_clock_skew_ms: MAX_FUTURE_CLOCK_SKEW_MS,
    }) !== true) {
      return {
        capability,
        code: "CAPABILITY_EVIDENCE_UNVERIFIED",
        reason: "trusted capability evidence verifier rejected the observation",
      };
    }
  } catch {
    return {
      capability,
      code: "CAPABILITY_EVIDENCE_UNVERIFIED",
      reason: "trusted capability evidence verifier failed",
    };
  }
  if (observation.status === "unavailable") {
    return {
      capability,
      code: "CAPABILITY_UNAVAILABLE",
      reason: nonEmpty(observation.reason) ? observation.reason : "capability unavailable",
    };
  }
  if (observation.status === "unknown") {
    return {
      capability,
      code: "CAPABILITY_UNKNOWN",
      reason: nonEmpty(observation.reason) ? observation.reason : "capability status unknown",
    };
  }
  return null;
}

/**
 * Evaluate task requirements against an observation supplied by a trusted
 * runtime/environment adapter. This function does not probe the host.
 */
export function preflightExecution(task, environment, evidenceVerifiers = {}, expectedRuntimeId = null) {
  const invalid = validateRequirements(task);
  if (invalid.length > 0) {
    return outcome("BLOCKED", "PREFLIGHT_INVALID", invalid, {
      blockers: [],
      dispatch_status: "NOT_RUN",
    });
  }

  const approvalBlocker = validateApproval(
    task,
    isRecord(evidenceVerifiers) ? evidenceVerifiers.verifyApproval : null,
  );
  if (approvalBlocker) {
    return outcome("BLOCKED", "APPROVAL_BLOCKED", [approvalBlocker], {
      blockers: [],
      dispatch_status: "NOT_RUN",
    });
  }

  if (!isRecord(environment) || !nonEmpty(environment.fingerprint)) {
    return outcome("BLOCKED", "ENVIRONMENT_UNIDENTIFIED", [
      "environment adapter did not provide a stable fingerprint",
    ], {
      blockers: [],
      environment_fingerprint: null,
      dispatch_status: "NOT_RUN",
    });
  }
  if (!nonEmpty(environment.provider_id)
      || !nonEmpty(environment.runtime_id)
      || !isRecord(environment.capabilities)) {
    return outcome("BLOCKED", "ENVIRONMENT_EVIDENCE_INVALID", [
      "environment provider, runtime identity, or capability observations are missing",
    ], {
      blockers: [],
      runtime_id: environment.runtime_id ?? null,
      environment_fingerprint: environment.fingerprint,
      dispatch_status: "NOT_RUN",
    });
  }
  if (expectedRuntimeId !== null && environment.runtime_id !== expectedRuntimeId) {
    return outcome("BLOCKED", "ENVIRONMENT_RUNTIME_MISMATCH", [
      "environment runtime identity does not match the selected runner",
    ], {
      blockers: [],
      runtime_id: environment.runtime_id,
      environment_fingerprint: environment.fingerprint,
      dispatch_status: "NOT_RUN",
    });
  }

  const checkedAtMs = Date.now();
  const blockers = [];
  for (const capability of task.requirements.capabilities) {
    const blocker = environmentBlocker(
      capability,
      environment.capabilities[capability],
      task,
      environment,
      isRecord(evidenceVerifiers)
        ? evidenceVerifiers.verifyCapabilityEvidence
        : null,
      checkedAtMs,
    );
    if (blocker) blockers.push(blocker);
  }
  if (blockers.length > 0) {
    return outcome("BLOCKED", "ENVIRONMENT_BLOCKED", [
      blockers.map(item => item.capability + ": " + item.reason).join("; "),
    ], {
      blockers,
      runtime_id: environment.runtime_id,
      environment_fingerprint: environment.fingerprint,
      dispatch_status: "NOT_RUN",
    });
  }

  return outcome("READY", "CAPABILITIES_VERIFIED", [], {
    blockers: [],
    runtime_id: environment.runtime_id,
    environment_fingerprint: environment.fingerprint,
    verified_capabilities: [...task.requirements.capabilities],
    approval_status: task.requirements.approval_required ? "APPROVED" : "NOT_REQUIRED",
    dispatch_status: "NOT_RUN",
  });
}

/**
 * Select a compatible runner as a plan only. No adapter is called and no
 * dispatch result can be produced by this module.
 */
export function planRunnerRouting(task, runners, evidenceVerifiers = {}) {
  if (!Array.isArray(runners)) {
    return outcome("BLOCKED", "RUNNER_LIST_INVALID", ["runners must be an array"], {
      runner_id: null,
      runner_evaluations: [],
      dispatch_status: "NOT_RUN",
    });
  }

  const evaluations = runners.map((runner, index) => {
    if (!isRecord(runner) || !nonEmpty(runner.id)) {
      return {
        index,
        runner_id: null,
        preflight: outcome("BLOCKED", "RUNNER_INVALID", ["runner id is missing"]),
      };
    }
    return {
      index,
      runner_id: runner.id,
      preflight: preflightExecution(task, runner.environment, evidenceVerifiers, runner.id),
      priority: Number.isFinite(runner.priority) ? runner.priority : 0,
    };
  });

  const eligible = evaluations
    .filter(item => item.preflight.status === "READY")
    .sort((left, right) => right.priority - left.priority || left.index - right.index);
  if (eligible.length === 0) {
    return outcome("BLOCKED", "NO_COMPATIBLE_RUNNER", [
      "no runner has verified evidence for all task requirements",
    ], {
      runner_id: null,
      runner_evaluations: evaluations,
      dispatch_status: "NOT_RUN",
    });
  }

  const selected = eligible[0];
  return outcome("ROUTE_PLANNED", "ROUTING_PLAN_ONLY", [], {
    runner_id: selected.runner_id,
    runtime_id: selected.preflight.runtime_id,
    environment_fingerprint: selected.preflight.environment_fingerprint,
    verified_capabilities: selected.preflight.verified_capabilities,
    approval_status: selected.preflight.approval_status,
    runner_evaluations: evaluations,
    runtime_adapter: "NOT_INVOKED",
    dispatch_status: "NOT_RUN",
  });
}

/**
 * Decide whether a failed attempt may be re-evaluated on changed evidence.
 * A caller must provide the current failure and the proposed next state.
 */
export function decideRetry({
  failure,
  candidate,
  attempt_boundary,
  previous_failures = [],
} = {}) {
  if (!isPreDispatchBoundary(attempt_boundary)) {
    return outcome("STOP", "RETRY_BOUNDARY_UNSAFE", [
      "retry is allowed only when no Claim was acquired and no Runtime action was dispatched",
    ], {
      retry_allowed: false,
    });
  }
  if (!Array.isArray(previous_failures) || !isRecord(failure) || !isRecord(candidate)) {
    return outcome("STOP", "RETRY_INPUT_INVALID", ["retry history is invalid"], {
      retry_allowed: false,
    });
  }
  if (!FAILURE_CLASSES.has(failure.class)
      || !nonEmpty(failure.failure_fingerprint)) {
    return outcome("STOP", "RETRY_INPUT_INVALID", [
      "failure class or failure fingerprint is missing",
    ], {
      retry_allowed: false,
    });
  }

  const prior = previous_failures.filter(item => (
    isRecord(item)
      && item.class === failure.class
      && item.failure_fingerprint === failure.failure_fingerprint
  ));
  if (failure.class === "environment") {
    if (!nonEmpty(failure.environment_fingerprint)
        || !nonEmpty(candidate.environment_fingerprint)) {
      return outcome("STOP", "ENVIRONMENT_UNKNOWN", [
        "environment retry requires stable fingerprints for both attempts",
      ], {
        retry_allowed: false,
        failure_class: "environment",
      });
    }
    if (failure.environment_fingerprint === candidate.environment_fingerprint) {
      return outcome("STOP", "SAME_ENVIRONMENT_BLOCKER", [
        "the same blocker was already observed under the same environment fingerprint",
      ], {
        retry_allowed: false,
        failure_class: "environment",
      });
    }
    if (prior.length >= 1) {
      return outcome("STOP", "ENVIRONMENT_RETRY_LIMIT", [
        "environment retry limit reached",
      ], {
        retry_allowed: false,
        failure_class: "environment",
      });
    }
    return outcome("RETRY", "ENVIRONMENT_CHANGED", [
      "environment fingerprint changed; one bounded re-evaluation is allowed",
    ], {
      retry_allowed: true,
      failure_class: "environment",
    });
  }

  if (!SHA_1.test(failure.tree_sha || "") || !SHA_1.test(candidate.tree_sha || "")) {
    return outcome("STOP", "CODE_TREE_UNKNOWN", [
      "code failure retry requires full 40-hex tree SHAs for both attempts",
    ], {
      retry_allowed: false,
      failure_class: "code",
    });
  }
  if (failure.tree_sha === candidate.tree_sha) {
    return outcome("STOP", "SAME_CODE_TREE", [
      "code did not change; retrying the same tree is not useful",
    ], {
      retry_allowed: false,
      failure_class: "code",
    });
  }
  if (prior.length >= 1) {
    return outcome("STOP", "CODE_RETRY_LIMIT", [
      "code retry limit reached",
    ], {
      retry_allowed: false,
      failure_class: "code",
    });
  }
  return outcome("RETRY", "CODE_CHANGED", [
    "tree SHA changed; one bounded targeted re-evaluation is allowed",
  ], {
    retry_allowed: true,
    failure_class: "code",
  });
}

function isPreDispatchBoundary(value) {
  try {
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some(key => (
      key !== "claim_status" && key !== "dispatch_status"
    ))) return false;
    const claim = Object.getOwnPropertyDescriptor(value, "claim_status");
    const dispatch = Object.getOwnPropertyDescriptor(value, "dispatch_status");
    return claim?.enumerable === true
      && Object.hasOwn(claim, "value")
      && claim.value === "NOT_ACQUIRED"
      && dispatch?.enumerable === true
      && Object.hasOwn(dispatch, "value")
      && dispatch.value === "NOT_RUN";
  } catch {
    return false;
  }
}

function trustedTestEvidence(evidence, verifier, expected) {
  if (!isRecord(evidence)
      || evidence.status !== "passed"
      || !nonEmpty(evidence.evidence_ref)
      || typeof verifier !== "function") return false;
  try {
    return verifier(evidence, expected) === true;
  } catch {
    return false;
  }
}

/**
 * Check whether an interrupted checkpoint may reuse prior test evidence.
 * It does not resume a task; a separate authorized Runtime Adapter would.
 */
export function assessCheckpointResume(checkpoint, current, verifyTestEvidence) {
  const blockers = [];
  if (!isRecord(checkpoint) || !isRecord(current)) {
    return outcome("BLOCKED", "CHECKPOINT_INVALID", ["checkpoint/current state must be objects"], {
      resume_status: "NOT_ELIGIBLE",
      execution_status: "NOT_RUN",
    });
  }

  if (!["interrupted", "blocked"].includes(checkpoint.status)) {
    blockers.push({ code: "CHECKPOINT_STATE_INVALID", reason: "checkpoint is not interrupted or blocked" });
  }
  if (!nonEmpty(checkpoint.repo) || checkpoint.repo !== current.repo) {
    blockers.push({ code: "REPOSITORY_CHANGED", reason: "repository does not match" });
  }
  if (!SHA_1.test(checkpoint.sha || "") || checkpoint.sha !== current.sha) {
    blockers.push({ code: "SHA_CHANGED", reason: "commit SHA does not match exactly" });
  }
  if (!SHA_1.test(checkpoint.tree_sha || "") || checkpoint.tree_sha !== current.tree_sha) {
    blockers.push({ code: "TREE_CHANGED", reason: "tree SHA does not match exactly" });
  }
  if (!nonEmpty(checkpoint.environment_fingerprint)
      || checkpoint.environment_fingerprint !== current.environment_fingerprint) {
    blockers.push({ code: "ENVIRONMENT_CHANGED", reason: "environment fingerprint does not match" });
  }
  if (!nonEmpty(checkpoint.next_step)) {
    blockers.push({ code: "RESUME_STATE_MISSING", reason: "next_step is missing" });
  }

  const expectedPlan = current.test_plan;
  const recorded = checkpoint.test_evidence;
  if (!isRecord(expectedPlan) || !nonEmpty(expectedPlan.id) || !SHA_256.test(expectedPlan.digest || "")) {
    blockers.push({ code: "TEST_PLAN_INVALID", reason: "current test plan id/digest is missing" });
  } else if (!isRecord(recorded)) {
    blockers.push({ code: "TEST_EVIDENCE_MISSING", reason: "checkpoint has no test evidence" });
  } else {
    if (recorded.repo !== checkpoint.repo || recorded.repo !== current.repo) {
      blockers.push({
        code: "TEST_REPOSITORY_MISMATCH",
        reason: "test evidence repository does not match checkpoint and current repository",
      });
    }
    if (recorded.plan_id !== expectedPlan.id || recorded.plan_digest !== expectedPlan.digest) {
      blockers.push({ code: "TEST_PLAN_CHANGED", reason: "test plan id/digest changed" });
    }
    if (recorded.sha !== checkpoint.sha || recorded.tree_sha !== checkpoint.tree_sha) {
      blockers.push({ code: "TEST_TARGET_CHANGED", reason: "test evidence was produced for a different SHA or tree" });
    }
    if (recorded.environment_fingerprint !== checkpoint.environment_fingerprint) {
      blockers.push({ code: "TEST_ENVIRONMENT_CHANGED", reason: "test evidence environment differs from checkpoint" });
    }
    if (recorded.status !== "passed") {
      blockers.push({ code: "TESTS_NOT_PASS", reason: "recorded tests did not pass" });
    } else if (!trustedTestEvidence(recorded, verifyTestEvidence, {
      repo: current.repo,
      sha: current.sha,
      tree_sha: current.tree_sha,
      environment_fingerprint: current.environment_fingerprint,
      test_plan: {
        id: expectedPlan.id,
        digest: expectedPlan.digest,
      },
    })) {
      blockers.push({ code: "TEST_EVIDENCE_UNVERIFIED", reason: "trusted test evidence verifier did not confirm the record" });
    }
  }

  if (blockers.length > 0) {
    return outcome("BLOCKED", "CHECKPOINT_NOT_REUSABLE", [
      blockers.map(item => item.code + ": " + item.reason).join("; "),
    ], {
      blockers,
      resume_status: "NOT_ELIGIBLE",
      execution_status: "NOT_RUN",
    });
  }

  return outcome("RESUME_ELIGIBLE", "CHECKPOINT_EVIDENCE_MATCHED", [], {
    blockers: [],
    reused_test_evidence_ref: recorded.evidence_ref,
    resume_status: "ELIGIBLE_ONLY",
    execution_status: "NOT_RUN",
  });
}
