import { EXECUTION_CAPABILITIES, preflightExecution } from "./f4-execution-capability.mjs";

export const CAPABILITY_MVP_TASK_KINDS = Object.freeze([
  "READ",
  "WRITE",
  "CODE_EXECUTION",
  "REVIEW",
]);

const TASK_KIND_SET = new Set(CAPABILITY_MVP_TASK_KINDS);
const CAPABILITY_SET = new Set(EXECUTION_CAPABILITIES);
const RISKY_TASK_KINDS = new Set(["WRITE", "CODE_EXECUTION"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function decision(status, code, reasons, extra = {}) {
  return {
    status,
    code,
    reasons,
    observation: "UNKNOWN",
    scope_completeness: "PARTIAL",
    source_observations: [],
    handoff_destination: null,
    dispatch_status: "NOT_RUN",
    ...extra,
  };
}

function validateTask(task) {
  if (!isRecord(task)) return "task must be an object";
  if (!present(task.task_id) || !present(task.scope_ref)) {
    return "task_id and scope_ref are required";
  }
  if (!TASK_KIND_SET.has(task.task_kind)) return "unsupported task_kind";
  if (!Array.isArray(task.sources) || task.sources.length === 0) {
    return "at least one required source is needed";
  }

  const ids = new Set();
  for (const source of task.sources) {
    if (!isRecord(source)
        || !present(source.source_id)
        || !present(source.capability)
        || !CAPABILITY_SET.has(source.capability)
        || !present(source.tool_id)
        || !isRecord(source.permission)
        || source.permission.kind !== task.task_kind
        || !present(source.permission.scope)
        || !present(source.operation)
        || !present(source.resource)
        || !present(source.source_revision)) {
      return "each source requires an exact capability, tool, permission, operation, resource, and revision";
    }
    if (ids.has(source.source_id)) {
      return "source ids must be unique within one preflight";
    }
    ids.add(source.source_id);
  }
  return null;
}

function verifyWith(verifier, evidence, context) {
  if (typeof verifier !== "function") return false;
  try {
    return verifier(evidence, context) === true;
  } catch {
    return false;
  }
}

function trustedPolicyFailure(task, verifiers) {
  if (!RISKY_TASK_KINDS.has(task.task_kind)) return null;
  const policy = task.policy_evidence;
  if (!isRecord(policy)
      || policy.decision !== "allow"
      || policy.task_kind !== task.task_kind
      || policy.scope_ref !== task.scope_ref
      || typeof policy.approval_required !== "boolean"
      || !present(policy.evidence_ref)) {
    return "trusted policy does not allow this exact task scope";
  }
  const context = {
    task_id: task.task_id,
    task_kind: task.task_kind,
    scope_ref: task.scope_ref,
    requested_sources: task.sources,
  };
  if (!verifyWith(verifiers.verifyPolicyEvidence, policy, context)) {
    return "trusted policy evidence verifier is unavailable or rejected the policy";
  }
  return null;
}

function reviewGuardFailure(task, verifiers) {
  if (task.task_kind !== "REVIEW") return null;
  if (!isRecord(task.review_guard_evidence)
      || !verifyWith(verifiers.verifyReviewGuard, task.review_guard_evidence, {
        task_id: task.task_id,
        scope_ref: task.scope_ref,
        task_kind: task.task_kind,
        required_sources: task.sources,
      })) {
    return "RPL-116 effective review guard evidence is missing, unknown, or unverified";
  }
  return null;
}

function checkedSource(task, source, environment, verifiers, approvalRequired) {
  let sourceEvidenceVerified = false;
  const lowLevelTask = {
    task_id: task.task_id,
    scope_ref: task.scope_ref,
    authorization: task.authorization,
    requirements: {
      capabilities: [source.capability],
      capability_scopes: {
        [source.capability]: {
          operation: source.operation,
          resource: source.resource,
        },
      },
      // Derived only from verified policy for WRITE/CODE_EXECUTION.
      // The caller's task.approval_required field is intentionally ignored.
      approval_required: approvalRequired,
    },
  };
  const sourceContext = {
    task_kind: task.task_kind,
    source_id: source.source_id,
    tool_id: source.tool_id,
    permission: source.permission,
    source_revision: source.source_revision,
  };
  const lowLevelVerifiers = {
    verifyApproval: verifiers.verifyApproval,
    verifyCapabilityEvidence(observation, context) {
      if (!isRecord(observation)
          || observation.tool_id !== source.tool_id
          || !isRecord(observation.permission)
          || observation.permission.kind !== source.permission.kind
          || observation.permission.scope !== source.permission.scope
          || observation.source_revision !== source.source_revision) return false;
      if (!verifyWith(verifiers.verifyCapabilityEvidence, observation, {
        ...context,
        ...sourceContext,
      })) return false;
      if (!verifyWith(verifiers.verifySourceEvidence, observation, {
        ...context,
        ...sourceContext,
      })) return false;
      sourceEvidenceVerified = true;
      return true;
    },
  };

  const rawObservation = source.observation
    ?? environment?.capabilities?.[source.capability];
  const sourceEnvironment = isRecord(environment)
    ? {
      ...environment,
      capabilities: {
        ...(isRecord(environment.capabilities) ? environment.capabilities : {}),
        [source.capability]: rawObservation,
      },
    }
    : environment;
  const checked = preflightExecution(lowLevelTask, sourceEnvironment, lowLevelVerifiers);
  const blocker = checked.blockers?.find(item => item.capability === source.capability);
  let status = "UNKNOWN";
  if (checked.status === "READY") status = "AVAILABLE";
  else if (blocker?.code === "CAPABILITY_UNAVAILABLE" && sourceEvidenceVerified) {
    status = "UNAVAILABLE";
  }

  const provenance = sourceEvidenceVerified && rawObservation
    ? {
      tool_id: source.tool_id,
      permission: { ...source.permission },
      operation: source.operation,
      resource: source.resource,
      source_revision: source.source_revision,
      runtime_id: environment.runtime_id,
      observed_at: rawObservation.observed_at,
      evidence_ref: rawObservation.evidence_ref,
    }
    : null;

  return {
    source_id: source.source_id,
    capability: source.capability,
    status,
    reason: blocker?.reason || checked.reasons?.[0] || "verified capability is available",
    provenance,
  };
}

function verifiedHandoff(task, verifiers) {
  const destination = task.handoff_destination;
  if (!isRecord(destination)
      || !present(destination.destination_id)
      || destination.scope_ref !== task.scope_ref
      || !present(destination.permission_scope)
      || !present(destination.evidence_ref)) return null;
  const verified = verifyWith(verifiers.verifyHandoffDestination, destination, {
    task_id: task.task_id,
    task_kind: task.task_kind,
    scope_ref: task.scope_ref,
    required_sources: task.sources,
  });
  return verified
    ? {
      destination_id: destination.destination_id,
      permission_scope: destination.permission_scope,
      evidence_ref: destination.evidence_ref,
    }
    : null;
}

/**
 * Map verified, per-source F4 capability evidence into the RPL-118 MVP.
 * This is a preflight only: it never dispatches, claims, retries, or resumes.
 * The injected RPL-116/policy/provenance verifiers must be trusted adapters;
 * missing verifiers always fail closed.
 */
export function preflightCapabilityMvp(task, environment, verifiers = {}) {
  if (!isRecord(verifiers)) verifiers = {};
  const invalid = validateTask(task);
  if (invalid) return decision("BLOCKED", "MVP_PREFLIGHT_INVALID", [invalid]);

  const policyError = trustedPolicyFailure(task, verifiers);
  if (policyError) {
    return decision("BLOCKED", "MVP_POLICY_BLOCKED", [policyError], {
      task_kind: task.task_kind,
    });
  }

  const guardError = reviewGuardFailure(task, verifiers);
  if (guardError) {
    const handoff = verifiedHandoff(task, verifiers);
    return decision(
      handoff ? "HANDOFF" : "BLOCKED",
      handoff ? "MVP_HANDOFF_VERIFIED" : "MVP_REVIEW_GUARD_BLOCKED",
      [guardError],
      { task_kind: task.task_kind, handoff_destination: handoff },
    );
  }

  const approvalRequired = RISKY_TASK_KINDS.has(task.task_kind)
    ? task.policy_evidence.approval_required
    : false;
  const sourceObservations = task.sources.map(source => (
    checkedSource(task, source, environment, verifiers, approvalRequired)
  ));
  const allAvailable = sourceObservations.every(item => item.status === "AVAILABLE");
  const anyAvailable = sourceObservations.some(item => item.status === "AVAILABLE");
  const allUnavailable = sourceObservations.every(item => item.status === "UNAVAILABLE");
  const observation = allAvailable
    ? "AVAILABLE"
    : allUnavailable ? "UNAVAILABLE" : "UNKNOWN";
  const completeness = allAvailable ? "COMPLETE" : "PARTIAL";
  const extra = {
    task_kind: task.task_kind,
    observation,
    scope_completeness: completeness,
    source_observations: sourceObservations,
    runtime_id: present(environment?.runtime_id) ? environment.runtime_id : null,
    environment_fingerprint: present(environment?.fingerprint) ? environment.fingerprint : null,
    dispatch_status: "NOT_RUN",
  };

  if (allAvailable || (task.task_kind === "READ" && anyAvailable)) {
    return decision(
      "READY",
      allAvailable ? "MVP_CAPABILITIES_VERIFIED" : "MVP_READ_PARTIAL",
      allAvailable ? [] : ["one or more read sources are unavailable or unknown; use verified sources only"],
      extra,
    );
  }

  const handoff = verifiedHandoff(task, verifiers);
  return decision(
    handoff ? "HANDOFF" : "BLOCKED",
    handoff ? "MVP_HANDOFF_VERIFIED" : "MVP_CAPABILITY_BLOCKED",
    sourceObservations.map(item => item.reason),
    { ...extra, handoff_destination: handoff },
  );
}
