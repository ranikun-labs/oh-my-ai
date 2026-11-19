import {
  EXECUTION_CAPABILITIES,
  MAX_FUTURE_CLOCK_SKEW_MS,
  MAX_OBSERVATION_AGE_MS,
  preflightExecution,
} from "./f4-execution-capability.mjs";

export const CAPABILITY_MVP_TASK_KINDS = Object.freeze([
  "READ",
  "WRITE",
  "CODE_EXECUTION",
  "REVIEW",
]);

const TASK_KIND_SET = new Set(CAPABILITY_MVP_TASK_KINDS);
const CAPABILITY_SET = new Set(EXECUTION_CAPABILITIES);
const RISKY_TASK_KINDS = new Set(["WRITE", "CODE_EXECUTION"]);
const REASONING_LEVELS = new Set(["low", "medium", "high", "max"]);
const SHA_1 = /^[a-f0-9]{40}$/i;
const UNKNOWN_MODEL = "unknown";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function freshTimestamp(value, now = Date.now()) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp >= now - MAX_OBSERVATION_AGE_MS
    && timestamp <= now + MAX_FUTURE_CLOCK_SKEW_MS;
}

function decision(status, code, reasons, extra = {}) {
  return {
    status,
    code,
    reasons,
    task_kind: null,
    checked_at: new Date().toISOString(),
    observation: "UNKNOWN",
    scope_completeness: "PARTIAL",
    source_observations: [],
    runtime_provenance: null,
    executor_selection: {
      status: "NOT_RUN",
      selected: null,
      skipped: [],
      reason: "Capability MVP does not rank or dispatch executors.",
    },
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
    if (ids.has(source.source_id)) return "source ids must be unique within one preflight";
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

function requestedSource(source) {
  return {
    source_id: source.source_id,
    capability: source.capability,
    tool_id: source.tool_id,
    permission: { ...source.permission },
    operation: source.operation,
    resource: source.resource,
    source_revision: source.source_revision,
  };
}

function sourceProvenance(source, observation, environment, verified) {
  const observed = isRecord(observation)
    ? {
      status: observation.status ?? null,
      provider_id: observation.provider_id ?? null,
      runtime_id: observation.runtime_id ?? null,
      environment_fingerprint: observation.environment_fingerprint ?? null,
      observed_at: observation.observed_at ?? null,
      evidence_ref: observation.evidence_ref ?? null,
      capability: observation.capability ?? null,
      task_id: observation.task_id ?? null,
      scope_ref: observation.scope_ref ?? null,
      tool_id: observation.tool_id ?? null,
      permission: isRecord(observation.permission) ? { ...observation.permission } : null,
      operation: observation.operation ?? null,
      resource: observation.resource ?? null,
      source_revision: observation.source_revision ?? null,
    }
    : null;
  return {
    verification: verified ? "VERIFIED" : observed ? "CLAIMED" : "ABSENT",
    requested: requestedSource(source),
    observed,
    environment_runtime_id: environment?.runtime_id ?? null,
    environment_fingerprint: environment?.fingerprint ?? null,
  };
}

function unverifiedSources(task, environment, reason) {
  return task.sources.map(source => ({
    source_id: source.source_id,
    capability: source.capability,
    status: "UNKNOWN",
    reason,
    provenance: sourceProvenance(
      source,
      source.observation ?? environment?.capabilities?.[source.capability],
      environment,
      false,
    ),
  }));
}

function trustedPolicy(task, verifiers) {
  if (!RISKY_TASK_KINDS.has(task.task_kind)) {
    return { error: null, approvalRequired: false };
  }
  const policy = task.policy_evidence;
  if (!isRecord(policy)
      || policy.decision !== "allow"
      || policy.task_kind !== task.task_kind
      || policy.scope_ref !== task.scope_ref
      || typeof policy.approval_required !== "boolean"
      || !present(policy.evidence_ref)) {
    return { error: "trusted policy does not allow this exact task scope" };
  }
  if (task.task_kind === "WRITE" && policy.approval_required !== true) {
    return { error: "WRITE requires explicit scoped approval; policy cannot waive this Owner gate" };
  }
  const verified = verifyWith(verifiers.verifyPolicyEvidence, policy, {
    task_id: task.task_id,
    task_kind: task.task_kind,
    scope_ref: task.scope_ref,
    requested_sources: task.sources.map(requestedSource),
  });
  if (!verified) return { error: "trusted policy evidence verifier is unavailable or rejected the policy" };
  const approvalRequired = task.task_kind === "WRITE" || policy.approval_required;
  if (approvalRequired) {
    const authorization = task.authorization;
    const approvalContext = {
      task_id: task.task_id,
      scope_ref: task.scope_ref,
      authorization,
      requirements: { approval_required: true },
    };
    if (!isRecord(authorization)
        || authorization.status !== "approved"
        || authorization.verified !== true
        || authorization.scope_ref !== task.scope_ref
        || !present(authorization.evidence_ref)
        || !verifyWith(verifiers.verifyApproval, authorization, approvalContext)) {
      return { error: "trusted scoped approval is missing or unverifiable" };
    }
  }
  return { error: null, approvalRequired };
}

function sourceScopeFailure(task, verifiers) {
  const evidence = task.source_scope_evidence;
  if (!isRecord(evidence)
      || evidence.scope_ref !== task.scope_ref
      || !present(evidence.evidence_ref)) {
    return "trusted Work Context source/authority scope evidence is missing";
  }
  const verified = verifyWith(verifiers.verifySourceScopeEvidence, evidence, {
    task_id: task.task_id,
    task_kind: task.task_kind,
    scope_ref: task.scope_ref,
    required_sources: task.sources.map(requestedSource),
  });
  return verified ? null : "trusted Work Context did not verify the required source set";
}

function currentRuntime(task, environment, verifiers, checkedAt) {
  const evidence = task.runtime_evidence;
  const provenance = {
    verification: "ABSENT",
    provider_id: null,
    runtime_id: null,
    environment_fingerprint: null,
    observed_at: null,
    evidence_ref: null,
  };
  if (isRecord(evidence)) {
    Object.assign(provenance, {
      verification: "CLAIMED",
      provider_id: evidence.provider_id ?? null,
      runtime_id: evidence.runtime_id ?? null,
      environment_fingerprint: evidence.environment_fingerprint ?? null,
      observed_at: evidence.observed_at ?? null,
      evidence_ref: evidence.evidence_ref ?? null,
    });
  }
  const valid = isRecord(evidence)
    && evidence.verified === true
    && present(evidence.provider_id)
    && present(evidence.runtime_id)
    && present(evidence.environment_fingerprint)
    && present(evidence.evidence_ref)
    && freshTimestamp(evidence.observed_at);
  if (!valid) return { runtimeId: null, provenance, error: "current Runtime identity evidence is absent, stale, or incomplete" };
  if (!isRecord(environment)
      || environment.provider_id !== evidence.provider_id
      || environment.runtime_id !== evidence.runtime_id
      || environment.fingerprint !== evidence.environment_fingerprint) {
    return { runtimeId: null, provenance, error: "current Runtime evidence does not match the capability environment" };
  }
  const verified = verifyWith(verifiers.verifyCurrentRuntimeEvidence, evidence, {
    task_id: task.task_id,
    scope_ref: task.scope_ref,
    current_runtime_id: evidence.runtime_id,
    provider_id: evidence.provider_id,
    environment_fingerprint: evidence.environment_fingerprint,
    checked_at: checkedAt,
  });
  if (!verified) return { runtimeId: null, provenance, error: "trusted current Runtime verifier is unavailable or rejected the evidence" };
  provenance.verification = "VERIFIED";
  return { runtimeId: evidence.runtime_id, provenance, error: null };
}

function reviewGuardFailure(task, verifiers, runtime) {
  if (task.task_kind !== "REVIEW") return null;
  const runtimeId = runtime?.runtime_id;
  const review = task.review_guard_evidence;
  const manifest = review?.manifest;
  const capability = review?.capability;
  const effective = review?.effective_settings_attestation;
  const profilePolicy = review?.profile_policy_evidence;
  const authorization = manifest?.authorization;
  const target = task.review_target;
  if (!isRecord(manifest)
      || !isRecord(capability)
      || !isRecord(effective)
      || !isRecord(profilePolicy)
      || !isRecord(authorization)
      || !isRecord(target)
      || !SHA_1.test(target.base_sha || "")
      || !SHA_1.test(target.head_sha || "")
      || manifest.role !== "reviewer"
      || manifest.permissions !== "read-only"
      || !present(manifest.agent_id)
      || !present(manifest.reviewing_agent_id)
      || manifest.reviewing_agent_id === manifest.agent_id
      || !isRecord(manifest.target)
      || manifest.target.base_sha !== target.base_sha
      || manifest.target.head_sha !== target.head_sha
      || !isRecord(manifest.requested)
      || !present(manifest.requested.model)
      || manifest.requested.model.toLowerCase() === UNKNOWN_MODEL
      || !REASONING_LEVELS.has(manifest.requested.reasoning)
      || typeof manifest.requested.fast !== "boolean"
      || !isRecord(manifest.runtime)
      || manifest.runtime.id !== runtimeId
      || manifest.runtime.provider_id !== runtime.provider_id
      || manifest.runtime.environment_fingerprint !== runtime.environment_fingerprint
      || profilePolicy.task_id !== task.task_id
      || profilePolicy.scope_ref !== task.scope_ref
      || !present(profilePolicy.evidence_ref)
      || !isRecord(profilePolicy.target)
      || profilePolicy.target.base_sha !== target.base_sha
      || profilePolicy.target.head_sha !== target.head_sha
      || !isRecord(profilePolicy.expected)
      || profilePolicy.expected.model !== manifest.requested.model
      || profilePolicy.expected.reasoning !== manifest.requested.reasoning
      || profilePolicy.expected.fast !== manifest.requested.fast
      || authorization.status !== "approved"
      || !present(authorization.scope)
      || !present(authorization.evidence_ref)) {
    return "RPL-116 reviewer manifest is missing, unverified, stale, or not read-only for the fixed Base/HEAD";
  }

  if (!verifyWith(verifiers.verifyReviewAuthorization, authorization, {
    task_id: task.task_id,
    scope_ref: task.scope_ref,
    task_kind: task.task_kind,
    target,
    agent_id: manifest.agent_id,
    reviewing_agent_id: manifest.reviewing_agent_id,
  })) {
    return "RPL-116 approved authorization scope is not verified for this task and fixed target";
  }

  if (!verifyWith(verifiers.verifyReviewProfilePolicy, profilePolicy, {
    task_id: task.task_id,
    scope_ref: task.scope_ref,
    task_kind: task.task_kind,
    target,
    runtime_id: runtimeId,
    provider_id: runtime.provider_id,
    environment_fingerprint: runtime.environment_fingerprint,
    requested: manifest.requested,
  })) {
    return "trusted review policy evidence does not authorize the requested model/reasoning/Fast profile";
  }

  const requiredCapabilities = [
    "model_selection",
    "reasoning_selection",
    "fast_override",
    "independent_context",
  ];
  if (capability.runtime_id !== runtimeId
      || capability.provider_id !== runtime.provider_id
      || capability.environment_fingerprint !== runtime.environment_fingerprint
      || !present(capability.verification_ref)
      || requiredCapabilities.some(name => (
        !isRecord(capability[name])
          || capability[name].supported !== true
          || !present(capability[name].evidence_ref)
      ))) {
    return "RPL-116 runtime capability evidence is incomplete for the reviewer settings and independent context";
  }
  if (!verifyWith(verifiers.verifyReviewCapabilityEvidence, capability, {
    task_id: task.task_id,
    scope_ref: task.scope_ref,
    target,
    runtime_id: runtimeId,
    provider_id: runtime.provider_id,
    environment_fingerprint: runtime.environment_fingerprint,
    required_capabilities: requiredCapabilities,
  })) {
    return "trusted RPL-116 capability evidence is unavailable or belongs to a different Runtime environment";
  }

  let checked;
  try {
    checked = typeof verifiers.preflightDispatch === "function"
      ? verifiers.preflightDispatch(manifest, capability)
      : null;
  } catch {
    checked = null;
  }
  if (!isRecord(checked)
      || checked.status !== "READY"
      || checked.code !== "READY_TO_DISPATCH"
      || !Array.isArray(checked.required_capabilities)
      || requiredCapabilities.some(name => !checked.required_capabilities.includes(name))) {
    return "RPL-116 preflightDispatch did not attest the fixed reviewer manifest";
  }

  const effectiveMatches = effective.verified === true
    && effective.runtime_id === runtimeId
    && effective.provider_id === runtime.provider_id
    && effective.environment_fingerprint === runtime.environment_fingerprint
    && effective.model === manifest.requested.model
    && effective.reasoning === manifest.requested.reasoning
    && effective.fast === manifest.requested.fast
    && effective.independent_context === true
    && present(effective.independent_context_ref)
    && present(effective.evidence_ref)
    && freshTimestamp(effective.observed_at)
    && isRecord(effective.target)
    && effective.target.base_sha === target.base_sha
    && effective.target.head_sha === target.head_sha;
  if (!effectiveMatches
      || !verifyWith(verifiers.verifyEffectiveReviewSettings, effective, {
        task_id: task.task_id,
        scope_ref: task.scope_ref,
        runtime_id: runtimeId,
        provider_id: runtime.provider_id,
        environment_fingerprint: runtime.environment_fingerprint,
        requested: manifest.requested,
        target,
      })) {
    return "RPL-116 effective model/reasoning/Fast or independent fixed-target evidence is unknown or unverified";
  }
  return null;
}

function checkedSource(task, source, environment, verifiers, approvalRequired, runtimeId) {
  let sourceEvidenceVerified = false;
  const lowLevelTask = {
    task_id: task.task_id,
    scope_ref: task.scope_ref,
    authorization: task.authorization,
    requirements: {
      capabilities: [source.capability],
      capability_scopes: {
        [source.capability]: { operation: source.operation, resource: source.resource },
      },
      // WRITE approval is unconditional; other approval requirements come only
      // from a verified trusted policy, never task.approval_required.
      approval_required: approvalRequired,
    },
  };
  const sourceContext = {
    task_kind: task.task_kind,
    source_id: source.source_id,
    tool_id: source.tool_id,
    permission: source.permission,
    operation: source.operation,
    resource: source.resource,
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
  const checked = preflightExecution(lowLevelTask, sourceEnvironment, lowLevelVerifiers, runtimeId);
  const blocker = checked.blockers?.find(item => item.capability === source.capability);
  let status = "UNKNOWN";
  if (checked.status === "READY") status = "AVAILABLE";
  else if (blocker?.code === "CAPABILITY_UNAVAILABLE" && sourceEvidenceVerified) status = "UNAVAILABLE";

  return {
    source_id: source.source_id,
    capability: source.capability,
    status,
    reason: blocker?.reason || checked.reasons?.[0] || "verified capability is available",
    provenance: sourceProvenance(source, rawObservation, environment, sourceEvidenceVerified),
  };
}

function verifiedHandoff(task, verifiers, checkedAt, currentRuntime) {
  const destination = task.handoff_destination;
  if (!isRecord(destination)
      || destination.connected !== true
      || destination.verified !== true
      || !present(destination.destination_id)
      || !present(destination.provider_id)
      || !present(destination.runtime_id)
      || !present(destination.environment_fingerprint)
      || !present(destination.tool_id)
      || !present(destination.operation)
      || !present(destination.resource_scope)
      || !present(destination.permission_scope)
      || destination.scope_ref !== task.scope_ref
      || !present(destination.evidence_ref)
      || !freshTimestamp(destination.observed_at)
      || (task.task_kind === "CODE_EXECUTION"
        && (currentRuntime?.verification !== "VERIFIED"
          || destination.runtime_id !== currentRuntime.runtime_id
          || destination.provider_id !== currentRuntime.provider_id
          || destination.environment_fingerprint !== currentRuntime.environment_fingerprint))) return null;
  const verified = verifyWith(verifiers.verifyHandoffDestination, destination, {
    task_id: task.task_id,
    task_kind: task.task_kind,
    scope_ref: task.scope_ref,
    required_sources: task.sources.map(requestedSource),
    checked_at: checkedAt,
    current_runtime: currentRuntime,
  });
  return verified
    ? {
      verification: "VERIFIED",
      destination_id: destination.destination_id,
      provider_id: destination.provider_id,
      runtime_id: destination.runtime_id,
      environment_fingerprint: destination.environment_fingerprint,
      tool_id: destination.tool_id,
      operation: destination.operation,
      resource_scope: destination.resource_scope,
      permission_scope: destination.permission_scope,
      observed_at: destination.observed_at,
      evidence_ref: destination.evidence_ref,
    }
    : null;
}

function reportBlockedOrHandoff(task, verifiers, checkedAt, code, reason, extra = {}, currentRuntime = null) {
  const handoff = verifiedHandoff(task, verifiers, checkedAt, currentRuntime);
  return decision(
    handoff ? "HANDOFF" : "BLOCKED",
    handoff ? "MVP_HANDOFF_VERIFIED" : code,
    [reason],
    {
      task_kind: task.task_kind,
      checked_at: checkedAt,
      handoff_destination: handoff,
      ...extra,
    },
  );
}

function readPartialFailure(task, sourceObservations, verifiers) {
  const evidence = task.partial_read_evidence;
  if (!isRecord(evidence)
      || evidence.scope_ref !== task.scope_ref
      || !present(evidence.evidence_ref)) {
    return "trusted source authority evidence is required for a partial READ";
  }
  const availableSources = sourceObservations.filter(item => item.status === "AVAILABLE");
  const missingSources = sourceObservations.filter(item => item.status !== "AVAILABLE");
  const verified = verifyWith(verifiers.verifyPartialReadEvidence, evidence, {
    task_id: task.task_id,
    scope_ref: task.scope_ref,
    available_sources: availableSources,
    missing_sources: missingSources,
  });
  return verified
    ? null
    : "trusted authority verifier did not confirm that the available READ sources are sufficient";
}

/**
 * Map verified, per-source F4 capability evidence into the RPL-118 MVP.
 * The function never dispatches, claims, retries, or resumes. Injected
 * verifiers must be trusted adapters; missing verifiers fail closed.
 */
export function preflightCapabilityMvp(task, environment, verifiers = {}) {
  if (!isRecord(verifiers)) verifiers = {};
  const checkedAt = new Date().toISOString();
  const report = (status, code, reasons, extra = {}) => decision(status, code, reasons, {
    checked_at: checkedAt,
    ...extra,
  });
  const invalid = validateTask(task);
  if (invalid) return report("BLOCKED", "MVP_PREFLIGHT_INVALID", [invalid]);

  const sourceScopeError = sourceScopeFailure(task, verifiers);
  if (sourceScopeError) {
    return report("BLOCKED", "MVP_SOURCE_SCOPE_UNVERIFIED", [sourceScopeError], {
      task_kind: task.task_kind,
      source_observations: unverifiedSources(task, environment, sourceScopeError),
    });
  }

  const policy = trustedPolicy(task, verifiers);
  if (policy.error) {
    return report("BLOCKED", "MVP_POLICY_BLOCKED", [policy.error], {
      task_kind: task.task_kind,
      source_observations: unverifiedSources(task, environment, policy.error),
    });
  }

  const current = currentRuntime(task, environment, verifiers, checkedAt);
  if (current.error) {
    return reportBlockedOrHandoff(
      task,
      verifiers,
      checkedAt,
      "MVP_RUNTIME_UNIDENTIFIED",
      current.error,
      {
        runtime_provenance: current.provenance,
        source_observations: unverifiedSources(task, environment, current.error),
      },
    );
  }

  const guardError = reviewGuardFailure(task, verifiers, current.provenance);
  if (guardError) {
    return reportBlockedOrHandoff(
      task,
      verifiers,
      checkedAt,
      "MVP_REVIEW_GUARD_BLOCKED",
      guardError,
      {
        task_kind: task.task_kind,
        runtime_provenance: current.provenance,
        source_observations: unverifiedSources(task, environment, guardError),
      },
      current.provenance,
    );
  }

  const sourceObservations = task.sources.map(source => (
    checkedSource(task, source, environment, verifiers, policy.approvalRequired, current.runtimeId)
  ));
  const allAvailable = sourceObservations.every(item => item.status === "AVAILABLE");
  const anyAvailable = sourceObservations.some(item => item.status === "AVAILABLE");
  const allUnavailable = sourceObservations.every(item => item.status === "UNAVAILABLE");
  const observation = allAvailable
    ? "AVAILABLE"
    : allUnavailable ? "UNAVAILABLE" : "UNKNOWN";
  const completeness = allAvailable ? "COMPLETE" : "PARTIAL";
  const base = {
    task_kind: task.task_kind,
    observation,
    scope_completeness: completeness,
    source_observations: sourceObservations,
    runtime_provenance: current.provenance,
  };

  if (allAvailable) {
    return report("READY", "MVP_CAPABILITIES_VERIFIED", [], base);
  }

  if (task.task_kind === "READ" && anyAvailable) {
    const partialError = readPartialFailure(task, sourceObservations, verifiers);
    if (!partialError) {
      return report("READY", "MVP_READ_PARTIAL", [
        "authority evidence permits a partial answer; use verified available sources only",
      ], {
        ...base,
        read_authority_evidence_ref: task.partial_read_evidence.evidence_ref,
      });
    }
    return reportBlockedOrHandoff(
      task,
      verifiers,
      checkedAt,
      "MVP_READ_AUTHORITY_UNVERIFIED",
      partialError,
      base,
      current.provenance,
    );
  }

  return reportBlockedOrHandoff(
    task,
    verifiers,
    checkedAt,
    "MVP_CAPABILITY_BLOCKED",
    sourceObservations.map(item => item.reason).join("; "),
    base,
    current.provenance,
  );
}
