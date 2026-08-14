#!/usr/bin/env node
//
// Validates a Static Runtime Capability declaration against the required
// fields and rules in docs/contracts/runtime-capability-contract.md
// (harness-foundation-docs), Part IV (§20-21) and the Negative Fixture list
// (§45). This is a P0-scope validator: it checks the Capability Record
// itself, not the full Handoff Requirement Mapping / Compatibility engine,
// which is V1 Alpha scope per the Contract.

import fs from "node:fs";

const ALLOWED_STATUS = new Set(["supported", "unsupported", "conditional", "unknown"]);
const CANONICAL_SESSION_CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    implementation_runtime_id: "claude-code",
    resolve: "supported",
    resume: "unsupported",
  }),
  codex: Object.freeze({
    implementation_runtime_id: "codex-cli",
    resolve: "supported",
    resume: "supported",
  }),
});

// FX-CAP-010 / FX-CAP-016: Human Approval and Authentication state are
// Execution Policy / Availability concerns, not Capability facts. If either
// leaks into a Capability Record's technical fields, that record is invalid.
const APPROVAL_LEAK_PATTERN = /\bapproval\b|\bapproved\b/i;
const AUTH_AVAILABILITY_LEAK_PATTERN = /\bnot authenticated\b|\bnot logged in\b|\blogin required\b|\bbinary not installed\b|\bnot installed\b/i;

function fail(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function validateCapabilityRecord(cap, path, errors) {
  if (typeof cap.capability_id !== "string" || cap.capability_id.length === 0) {
    fail(errors, path, "missing capability_id");
    return;
  }
  if (!ALLOWED_STATUS.has(cap.declared_status)) {
    fail(errors, path, `declared_status must be one of ${[...ALLOWED_STATUS].join("/")}, got: ${cap.declared_status}`);
    return;
  }

  // Required fields shared by every status (Contract §20).
  for (const field of ["drift_status", "effective_status", "conditions", "limitations", "required_manual_step", "source", "evidence_refs", "last_verified_at", "notes"]) {
    if (!(field in cap)) fail(errors, path, `missing required field: ${field}`);
  }
  if (typeof cap.required_for_advertised_support !== "boolean") {
    fail(errors, path, "missing required_for_advertised_support (boolean)");
  }

  switch (cap.declared_status) {
    case "supported": {
      if (cap.drift_status !== "current") fail(errors, path, "Supported requires drift_status = current");
      if (!Array.isArray(cap.evidence_refs) || cap.evidence_refs.length === 0) {
        fail(errors, path, "Supported requires non-empty evidence_refs");
      }
      if (!cap.source || cap.source.type === "not_verified") {
        fail(errors, path, "Supported requires a source that is not 'not_verified'");
      }
      if (!cap.last_verified_at) fail(errors, path, "Supported requires last_verified_at");
      break;
    }
    case "unsupported": {
      const hasEvidence = (Array.isArray(cap.evidence_refs) && cap.evidence_refs.length > 0) || cap.explicit_verification_record || (cap.source && cap.source.type === "explicit_verification_record");
      if (!hasEvidence) {
        // FX-CAP-012: no Source/Evidence backing an unsupported claim. This
        // validator rejects rather than silently downgrading to unknown --
        // no field in this declaration is mutated behind the author's back.
        fail(errors, path, "Unsupported requires evidence_refs or an explicit_verification_record (otherwise this must be declared unknown, not unsupported)");
      }
      if (!cap.last_verified_at) fail(errors, path, "Unsupported requires last_verified_at");
      const hasReason = (Array.isArray(cap.limitations) && cap.limitations.length > 0) || (Array.isArray(cap.notes) && cap.notes.length > 0);
      if (!hasReason) fail(errors, path, "Unsupported requires limitations or notes");
      if (!cap.safe_fallback) fail(errors, path, "Unsupported requires safe_fallback");
      // FX-CAP-011 / FX-CAP-016: Availability (binary not installed) and
      // Authentication state are not Capability facts. An "unsupported"
      // justified only by these must instead be recorded as an Availability
      // status (unavailable/degraded), not a technical Capability limit.
      for (const text of [...(cap.limitations || []), ...(cap.notes || [])]) {
        if (AUTH_AVAILABILITY_LEAK_PATTERN.test(text)) {
          fail(errors, path, `Unsupported must not be justified by Availability/Authentication state ("${text}"); use an Availability status instead`);
        }
      }
      break;
    }
    case "conditional": {
      if (!Array.isArray(cap.conditions) || cap.conditions.length === 0) {
        fail(errors, path, "Conditional requires non-empty conditions");
      }
      if (!cap.failure_mode) fail(errors, path, "Conditional requires failure_mode");
      if (!Array.isArray(cap.required_manual_step) || cap.required_manual_step.length === 0) {
        fail(errors, path, "Conditional requires non-empty required_manual_step");
      }
      if (!Array.isArray(cap.evidence_refs) || cap.evidence_refs.length === 0) {
        fail(errors, path, "Conditional requires non-empty evidence_refs");
      }
      // FX-CAP-010: Human Approval is an Execution Policy concept, not a
      // technical Capability condition.
      for (const text of cap.conditions || []) {
        if (APPROVAL_LEAK_PATTERN.test(text)) {
          fail(errors, path, `conditions must not encode Human Approval ("${text}"); Approval belongs to Execution Policy, not Capability`);
        }
      }
      break;
    }
    case "unknown": {
      if (!cap.unknown_reason) fail(errors, path, "Unknown requires unknown_reason");
      if (!cap.verification_needed) fail(errors, path, "Unknown requires verification_needed");
      if (!cap.safe_fallback) fail(errors, path, "Unknown requires safe_fallback");
      // Negative Fixture: Unsupported/Supported wrongly promoted must never
      // carry evidence_refs while status is unknown -- unknown must not
      // masquerade as verified.
      if (Array.isArray(cap.evidence_refs) && cap.evidence_refs.length > 0) {
        fail(errors, path, "Unknown must not carry evidence_refs (would imply verification that did not happen)");
      }
      // FX-CAP-013: a non-empty required_manual_step on an unknown record
      // would imply a verified "compatible_with_manual_steps" promotion path
      // that has not actually been earned.
      if (Array.isArray(cap.required_manual_step) && cap.required_manual_step.length > 0) {
        fail(errors, path, "Unknown must not carry required_manual_step (would imply a verified manual-step promotion that has not happened)");
      }
      break;
    }
    default:
      break;
  }

}

function validateRuntime(name, runtime, errors) {
  const path = `runtimes.${name}`;
  for (const field of ["runtime_id", "adapter_id", "adapter_version", "metadata_version", "lifecycle_status", "capability_metadata_status", "last_verified_at"]) {
    if (!(field in runtime)) fail(errors, path, `missing required Runtime Identity field: ${field}`);
  }
  if (typeof runtime.advertised_support !== "boolean") {
    fail(errors, path, "advertised_support must be a boolean");
  }
  if (runtime.advertised_support && !(Array.isArray(runtime.advertised_support_evidence) && runtime.advertised_support_evidence.length > 0)) {
    fail(errors, path, "advertised_support=true requires non-empty advertised_support_evidence");
  }
  if (!Array.isArray(runtime.capabilities) || runtime.capabilities.length === 0) {
    fail(errors, path, "must declare at least one capability");
    return;
  }

  const seenIds = new Set();
  for (const [i, cap] of runtime.capabilities.entries()) {
    const capPath = `${path}.capabilities[${i}]`;
    validateCapabilityRecord(cap, capPath, errors);
    if (cap.capability_id) {
      if (seenIds.has(cap.capability_id)) {
        fail(errors, capPath, `duplicate capability_id: ${cap.capability_id} (Registry Conflict)`);
      }
      seenIds.add(cap.capability_id);
    }
  }

  // Negative Fixture: a Runtime cannot be advertised_support=true while any
  // capability *required for that gate* is unknown, since "advertised_support"
  // implies the required-capability set has no unknown entries per Contract
  // §9. required_for_advertised_support=false capabilities (e.g. a capability
  // this Runtime's V1 workflow deliberately does not use) do not block the
  // gate -- otherwise every Runtime would be blocked by capabilities V1 never
  // needed in the first place.
  if (runtime.advertised_support) {
    for (const cap of runtime.capabilities) {
      if (cap.required_for_advertised_support !== false && cap.declared_status === "unknown") {
        fail(errors, path, `advertised_support=true but required capability ${cap.capability_id} is unknown`);
      }
    }
    // FX-CAP-014: Stale Advertised Support -- a Runtime cannot advertise
    // support while its own metadata is known to be out of date.
    if (runtime.drift_status === "stale") {
      fail(errors, path, "advertised_support=true but runtime drift_status=stale (Gate failure)");
    }
  }

  // FX-CAP-015: Structured Result Overclaim -- structured is built on top of
  // freeform; a Runtime cannot claim structured support/conditional while
  // freeform itself is not at least supported.
  const freeform = runtime.capabilities.find((c) => c.capability_id === "capability.result.freeform");
  const structured = runtime.capabilities.find((c) => c.capability_id === "capability.result.structured");
  if (structured && (structured.declared_status === "supported" || structured.declared_status === "conditional")) {
    if (!freeform || freeform.declared_status !== "supported") {
      fail(errors, path, "capability.result.structured is supported/conditional but capability.result.freeform is not supported (Structured Result Overclaim)");
    }
  }
}

function validateCanonicalSessionCapabilities(doc, errors) {
  for (const [semanticRuntimeId, expected] of Object.entries(CANONICAL_SESSION_CAPABILITIES)) {
    const runtime = doc.runtimes[semanticRuntimeId];
    const runtimePath = `runtimes.${semanticRuntimeId}`;
    if (!runtime || typeof runtime !== "object") {
      fail(errors, runtimePath, "canonical session capability runtime is required");
      continue;
    }

    if (runtime.runtime_id !== expected.implementation_runtime_id) {
      fail(
        errors,
        runtimePath,
        `canonical session capability requires semantic runtime ${semanticRuntimeId} to use implementation runtime_id ${expected.implementation_runtime_id}`,
      );
    }

    const capabilities = Array.isArray(runtime.capabilities) ? runtime.capabilities : [];
    for (const [capabilityName, expectedStatus] of Object.entries({
      resolve: expected.resolve,
      resume: expected.resume,
    })) {
      const capabilityId = `capability.session.${capabilityName}`;
      const capabilityPath = `${runtimePath}.capabilities.${capabilityId}`;
      const capability = capabilities.find(item => item && item.capability_id === capabilityId);
      if (!capability) {
        fail(errors, capabilityPath, "canonical session capability is required");
        continue;
      }
      if (capability.declared_status !== expectedStatus
        || capability.effective_status !== expectedStatus) {
        fail(
          errors,
          capabilityPath,
          `canonical session capability must be declared/effective ${expectedStatus}`,
        );
      }
      if (!Array.isArray(capability.evidence_refs) || capability.evidence_refs.length === 0) {
        fail(errors, capabilityPath, "canonical session capability requires evidence_refs");
      }
      if (expectedStatus === "unsupported") {
        if (!Array.isArray(capability.limitations) || capability.limitations.length === 0) {
          fail(errors, capabilityPath, "canonical session capability requires unsupported limitations");
        }
        if (typeof capability.safe_fallback !== "string" || capability.safe_fallback.length === 0) {
          fail(errors, capabilityPath, "canonical session capability requires unsupported safe_fallback");
        }
      }
    }
  }
}

function validate(doc) {
  const errors = [];
  if (doc.schema_version !== 1) errors.push("root: unsupported or missing schema_version");
  if (!doc.runtimes || typeof doc.runtimes !== "object") {
    errors.push("root: missing runtimes object");
    return errors;
  }
  for (const [name, runtime] of Object.entries(doc.runtimes)) {
    validateRuntime(name, runtime, errors);
  }
  validateCanonicalSessionCapabilities(doc, errors);
  return errors;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: validate-capabilities.mjs <path-to-runtime-capabilities.json>");
    process.exit(2);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`invalid JSON: ${err.message}`);
    process.exit(1);
  }
  const errors = validate(doc);
  if (errors.length > 0) {
    for (const e of errors) console.error(`invalid: ${e}`);
    process.exit(1);
  }
  console.log(`valid: ${file}`);
  process.exit(0);
}

main();

export { validate };
