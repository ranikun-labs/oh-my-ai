/**
 * RPL-116 isolated, fail-closed agent-dispatch contract.
 * This module validates evidence; it does NOT create agents or query runtimes.
 * It cannot attest effective model settings without a trusted runtime verifier.
 */

const ROLES = new Set(["coordinator", "writer", "reviewer", "research"]);
const REASONING = new Set(["low", "medium", "high", "max"]);
const PERMISSIONS = new Set(["read-only", "scoped-write"]);
const SHA = /^[0-9a-f]{40}$/i;
const present = value => typeof value === "string" && value.trim().length > 0;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const result = (status, code, reasons, extra = {}) => ({ status, code, reasons, ...extra });

export function validateAgentManifest(manifest) {
  const errors = [];
  if (!record(manifest)) return result("BLOCKED", "F4_PROMPT_INVALID", ["manifest must be an object"]);
  for (const path of ["agent_id", "task"]) {
    if (!present(manifest[path])) errors.push(path + " missing");
  }
  if (!ROLES.has(manifest.role)) errors.push("role invalid/missing");
  if (!PERMISSIONS.has(manifest.permissions)) errors.push("permissions invalid/missing");
  if (!record(manifest.requested)) errors.push("requested missing");
  else {
    if (!present(manifest.requested.model) || manifest.requested.model === "UNKNOWN") errors.push("requested.model missing");
    if (!REASONING.has(manifest.requested.reasoning)) errors.push("requested.reasoning missing/invalid");
    if (typeof manifest.requested.fast !== "boolean") errors.push("requested.fast missing/not boolean");
  }
  if (!record(manifest.runtime) || !present(manifest.runtime.id)) errors.push("runtime.id missing");
  if (!record(manifest.authorization) || !present(manifest.authorization.scope) || !present(manifest.authorization.evidence_ref)) {
    errors.push("authorization scope/evidence_ref missing");
  }
  if (manifest.role === "reviewer") {
    if (manifest.permissions !== "read-only") errors.push("reviewer must be read-only");
    if (!record(manifest.target) || !SHA.test(manifest.target.base_sha) || !SHA.test(manifest.target.head_sha)) {
      errors.push("reviewer requires fixed 40-hex base_sha/head_sha");
    }
    if (!present(manifest.reviewing_agent_id) || manifest.reviewing_agent_id === manifest.agent_id) {
      errors.push("reviewer requires distinct reviewing_agent_id");
    }
  }
  if (manifest.role === "writer") {
    if (manifest.permissions !== "scoped-write") errors.push("writer requires scoped-write permission");
    if (!record(manifest.target) || !present(manifest.target.repo) || !present(manifest.target.branch) || !present(manifest.target.primary_jira)) {
      errors.push("writer requires repo, branch and primary_jira");
    }
  }
  return errors.length ? result("BLOCKED", "F4_PROMPT_INVALID", errors) : result("VALID", "MANIFEST_VALID", []);
}

/**
 * capability must be obtained at dispatch time from a trusted adapter.
 * A static capability-registry declaration is not a runtime setting proof.
 */
export function preflightDispatch(manifest, capability) {
  const checked = validateAgentManifest(manifest);
  if (checked.status !== "VALID") return checked;
  if (manifest.authorization.status !== "approved") {
    return result("BLOCKED", "APPROVAL_BLOCKED", ["explicit scope approval absent"]);
  }
  if (!record(capability) || capability.runtime_id !== manifest.runtime.id || !present(capability.verification_ref)) {
    return result("BLOCKED", "CAPABILITY_BLOCKED", ["runtime-specific capability evidence missing or mismatched"]);
  }
  const required = ["model_selection", "reasoning_selection", "fast_override"];
  if (manifest.role === "reviewer") required.push("independent_context");
  const unsupported = required.filter(k => !record(capability[k]) || capability[k].supported !== true || !present(capability[k].evidence_ref));
  if (unsupported.length) return result("BLOCKED", "CAPABILITY_BLOCKED", unsupported.map(k => k + " not verified supported"));
  return result("READY", "READY_TO_DISPATCH", [], {required_capabilities:required});
}

/**
 * Verify reported effective settings against requested settings and evidence.
 * A successful proof callback is provided ONLY by a trusted runtime adapter.
 * Without the callback (or with synthetic/self-attested evidence), return
 * ROUTING_UNVERIFIED. Never translate this result into formal reviewer PASS.
 */
export function verifyDispatchEvidence(manifest, observation, verifyRuntimeAttestation) {
  const checked = validateAgentManifest(manifest);
  if (checked.status !== "VALID") return checked;
  if (!record(observation) || observation.dispatched !== true) {
    return result("BLOCKED", "NOT_RUN", ["no agent dispatch evidence"]);
  }
  if (!record(observation.attestation) || !present(observation.attestation.ref)
      || observation.attestation.runtime_id !== manifest.runtime.id
      || observation.attestation.agent_id !== manifest.agent_id) {
    return result("BLOCKED", "ROUTING_UNVERIFIED", ["runtime attestation missing/mismatched"]);
  }
  if (typeof verifyRuntimeAttestation !== "function") {
    return result("BLOCKED", "ROUTING_UNVERIFIED", ["trusted runtime attestation verifier not supplied"]);
  }
  let trusted = false;
  try { trusted = verifyRuntimeAttestation(observation.attestation) === true; }
  catch { trusted = false; }
  if (!trusted) return result("BLOCKED", "ROUTING_UNVERIFIED", ["runtime attestation did not verify"]);
  const effective = observation.attestation.effective;
  if (!record(effective) || !present(effective.model) || !REASONING.has(effective.reasoning) || typeof effective.fast !== "boolean") {
    return result("BLOCKED", "ROUTING_UNVERIFIED", ["effective settings incomplete or unknown"]);
  }
  if (effective.model !== manifest.requested.model || effective.reasoning !== manifest.requested.reasoning || effective.fast !== manifest.requested.fast) {
    return result("BLOCKED", "SETTING_MISMATCH", ["effective model/reasoning/fast differs from request; do not silently fallback"]);
  }
  if (manifest.role === "reviewer") {
    if (observation.attestation.independent_context !== true || !present(observation.attestation.independent_context_ref)) {
      return result("BLOCKED", "REVIEW_UNVERIFIED", ["independent review context not verified"]);
    }
    const reviewed = observation.reviewed;
    if (!record(reviewed) || reviewed.base_sha !== manifest.target.base_sha || reviewed.head_sha !== manifest.target.head_sha) {
      return result("BLOCKED", "REVIEW_UNVERIFIED", ["review target stale or different from fixed Base/HEAD"]);
    }
  }
  return result("EVIDENCE_MATCHED", "SETTINGS_VERIFIED", [], {review_acceptance:"NOT_EVALUATED"});
}
