#!/usr/bin/env node
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { g3EvidenceSha256, createG3TrustedGate } from "./lib/jira-ticket-g3-trusted-gate.mjs";

const keyId = "offline-fixture-owner-key";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trustedKeys = { [keyId]: publicKey.export({ type: "spki", format: "pem" }) };
const iso = value => new Date(value).toISOString();
const canonical = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
function signed(payload, tamper = false) {
  const signature = sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64");
  return { key_id: keyId, payload: structuredClone(payload), signature: tamper ? `${signature.slice(0, -4)}AAAA` : signature };
}

let clock = Date.now();
const requestId = "g3-offline-gate-request-0001";
const ledgerRef = "fixture-g3-ledger-v1";
const previewId = "a".repeat(64);
const fields = {
  customfield_10108: { id: "10027" },
  customfield_10109: { id: "10028" },
  customfield_10015: "2026-10-23",
};
const createRequest = {
  project: "RPL", issue_type: "Task", summary: "[FIXTURE ONLY] signed G3 request",
  description: "Signed offline fixture body", assignee: "fixture-user", priority: "High",
  labels: ["offline-fixture"], fields,
};
const options = {
  product: [{ id: "10027", value: "dev-harness" }],
  component: [{ id: "10028", value: "backend" }],
  concern: [{ id: "10038", value: "integration" }],
};
const metadataFields = {
  customfield_10108: { required: true, hasDefaultValue: false,
    schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" }, allowedValues: options.product },
  customfield_10109: { required: true, hasDefaultValue: false,
    schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" }, allowedValues: options.component },
  customfield_10110: { required: false, hasDefaultValue: false,
    schema: { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" },
    allowedValues: options.concern },
};
const metadataContent = { project: "RPL", issue_type: "Task", issue_type_id: "10010", fields: metadataFields };
const metadataHash = g3EvidenceSha256(metadataContent);
const policyHash = "b".repeat(64);
const activationRef = "fixture-activation-task-v1";
const approvalRef = "fixture-owner-cutover-approved-task";

function makePayloads({ activationPatch = {}, policyPatch = {}, metadataPatch = {}, approvalPatch = {},
  metadataAgeMs = 10_000, activationExpiryMs = 300_000, approvalExpiryMs = 240_000,
  metadataOverride = metadataContent } = {}) {
  const issuedAt = iso(clock - 1_000);
  const activation = {
    kind: "g3_activation", status: "active", activation_ref: activationRef,
    owner_approval_ref: approvalRef, policy_sha256: policyHash,
    metadata_sha256: g3EvidenceSha256(metadataOverride), issued_at: issuedAt,
    expires_at: iso(clock + activationExpiryMs), effective_from: iso(clock - 60_000),
    effective_to: iso(clock + 300_000), scope: {
      project: "RPL", issue_type: "Task", issue_type_id: "10010", ledger_ref: ledgerRef,
      request_id: requestId, approved_preview_id: previewId,
      operations: ["search", "intent", "create", "read", "origin", "authority_read"],
    }, ...activationPatch,
  };
  const policy = {
    kind: "g3_policy", status: "active", policy_sha256: policyHash, project: "RPL",
    allowed_issue_types: { Task: "10010" }, mode: "single_supervised",
    allowed_create_fields: ["customfield_10108", "customfield_10109", "customfield_10110", "customfield_10015"],
    max_concerns: 3, max_metadata_age_ms: 60_000, issued_at: issuedAt,
    expires_at: iso(clock + 300_000), ...policyPatch,
  };
  const metadata = {
    kind: "g3_live_metadata", ...metadataOverride,
    metadata_sha256: g3EvidenceSha256(metadataOverride), observed_at: iso(clock - metadataAgeMs),
    issued_at: issuedAt, expires_at: iso(clock + 120_000), ...metadataPatch,
  };
  const approval = {
    kind: "g3_owner_approval", status: "approved",
  };
  Object.assign(approval, {
    status: "approved", approval_ref: approvalRef, activation_ref: activationRef,
    policy_sha256: policyHash, project: "RPL", issue_type: "Task", issue_type_id: "10010",
    ledger_ref: ledgerRef, create_request_id: requestId, approved_preview_id: previewId,
    fields_sha256: g3EvidenceSha256(fields), create_request_sha256: g3EvidenceSha256(createRequest),
    issued_at: issuedAt, expires_at: iso(clock + approvalExpiryMs), ...approvalPatch,
  });
  return { activation, policy, metadata, approval };
}

function fixtureGate(options = {}) {
  const payloads = makePayloads(options);
  const replay = new Set();
  const fetchCounts = { activation: 0, current: 0, policy: 0, metadata: 0, approval: 0, claim: 0 };
  const source = {
    async fetchActivation(input) {
      fetchCounts.activation++;
      assert.equal(input.activation_ref, activationRef);
      return signed(payloads.activation, options.tamperActivation === true);
    },
    async fetchCurrentActivation(input) {
      fetchCounts.current++;
      assert.equal(input.project, "RPL");
      return signed(payloads.activation, options.tamperActivation === true);
    },
    async fetchPolicy(input) {
      fetchCounts.policy++;
      assert.equal(input.policy_sha256, policyHash);
      return signed(payloads.policy);
    },
    async fetchLiveMetadata(input) {
      fetchCounts.metadata++;
      assert.deepEqual(input, { project: "RPL", issue_type: "Task" });
      return signed(payloads.metadata);
    },
    async fetchOwnerApproval(input) {
      fetchCounts.approval++;
      assert.equal(input.approval_ref, approvalRef);
      assert.equal(input.create_request_id, requestId);
      return signed(payloads.approval);
    },
    async claimReplay(input) {
      fetchCounts.claim++;
      if (options.advanceAtClaimMs) clock += options.advanceAtClaimMs;
      const duplicate = replay.has(input.claim_key) || options.forceReplay === true;
      replay.add(input.claim_key);
      const stamp = iso(clock - 500);
      return signed({ kind: "g3_replay_claim", status: duplicate ? "duplicate" : "claimed",
        claim_key: input.claim_key, activation_ref: input.activation_ref,
        create_request_id: input.create_request_id, approved_preview_id: input.approved_preview_id,
        issued_at: stamp, expires_at: iso(clock + 60_000) });
    },
  };
  const verifyGate = createG3TrustedGate({ source, trustedKeys, now: () => clock, maxEvidenceAgeMs: 5 * 60_000 });
  return { verifyGate, source, payloads, fetchCounts, replay };
}

function intent(overrides = {}) {
  return { create_request_id: requestId, ledger_ref: ledgerRef, activation_ref: activationRef,
    status: "pending", approved_preview_id: previewId, issue_type: "Task", fields, ...overrides };
}

const signedFlow = fixtureGate();
assert.equal((await signedFlow.verifyGate({ stage: "search", context: {
  project: "RPL", summary_keywords: createRequest.summary, product: "dev-harness",
  repository: "oh-my-ai", area: "Jira", related_pr: null, branch: null, decision: null,
  existing_issue_key: null, created_after: null, contract_fingerprint_candidate: "fixture",
} })).allowed, true);
const intentProof = await signedFlow.verifyGate({ stage: "intent", context: intent() });
assert.equal(intentProof.allowed, true);
assert.equal(intentProof.cutover_approval_ref, approvalRef);
assert.match(intentProof.evidence_ref, /^signed-g3:[a-f0-9]{64}$/);
await assert.rejects(() => signedFlow.verifyGate({ stage: "intent", context: intent() }), /one-time|replay/i);
await assert.rejects(() => signedFlow.verifyGate({ stage: "create", context: {
  request: { ...createRequest, summary: "[FIXTURE ONLY] changed after approval" },
  create_request_id: requestId, activation_ref: activationRef,
} }), /Create request differs/i);
await signedFlow.verifyGate({ stage: "create", context: {
  request: createRequest, create_request_id: requestId, activation_ref: activationRef,
} });
await signedFlow.verifyGate({ stage: "read", context: {
  key: "RPL-901", fields: ["issuetype", "customfield_10108", "customfield_10109", "customfield_10110"],
  create_request_id: requestId,
} });
await signedFlow.verifyGate({ stage: "origin", context: {
  issue_key: "RPL-901", create_request_id: requestId, ledger_ref: ledgerRef,
  create_activation_ref: activationRef, cutover_approval_ref: approvalRef,
  origin: "target_create", phase: "create_ready", read_authority: "target", write_authority: "target",
  verified_fields: { customfield_10108: { id: "10027" }, customfield_10109: { id: "10028" }, customfield_10110: [] },
} });
assert.equal((await signedFlow.verifyGate({ stage: "authority_read", context: { issue_key: "RPL-901" } })).allowed, true);
console.log("PASS: signed current Activation, policy, live metadata, exact Owner approval and all adapter stages");

const replayAcrossInstance = fixtureGate({ forceReplay: true });
await assert.rejects(() => replayAcrossInstance.verifyGate({ stage: "intent", context: intent() }), /replay/i);
assert.equal(replayAcrossInstance.fetchCounts.claim, 1);
console.log("PASS: durable replay claim rejects a second gate instance for the same CreateRequestId");

const tampered = fixtureGate({ tamperActivation: true });
await assert.rejects(() => tampered.verifyGate({ stage: "search", context: { project: "RPL" } }), /signature/i);
const wrongPolicy = fixtureGate({ policyPatch: { policy_sha256: "c".repeat(64) } });
await assert.rejects(() => wrongPolicy.verifyGate({ stage: "search", context: { project: "RPL" } }), /policy/i);
const staleMetadata = fixtureGate({ metadataAgeMs: 120_000 });
await assert.rejects(() => staleMetadata.verifyGate({ stage: "search", context: { project: "RPL" } }), /stale/i);
const badOption = fixtureGate();
await assert.rejects(() => badOption.verifyGate({ stage: "intent", context: intent({ fields: {
  ...fields, customfield_10108: { id: "99999" },
} }) }), /metadata/i);
const outOfScope = fixtureGate();
await assert.rejects(() => outOfScope.verifyGate({ stage: "intent", context: intent({
  create_request_id: "g3-offline-gate-request-0002",
}) }), /scope/i);
const expiredApproval = fixtureGate({ approvalExpiryMs: -1 });
await assert.rejects(() => expiredApproval.verifyGate({ stage: "intent", context: intent() }), /expired/i);
const beforeSlowClaim = clock;
const expiresDuringClaim = fixtureGate({ approvalExpiryMs: 30_000, advanceAtClaimMs: 30_000 });
await assert.rejects(() => expiresDuringClaim.verifyGate({ stage: "intent", context: intent() }), /expired/i);
clock = beforeSlowClaim;
console.log("PASS: forged, stale, expired, policy-mismatched and out-of-scope evidence fails closed");

const boundary = fixtureGate();
boundary.payloads.activation.effective_to = iso(clock);
await assert.rejects(() => boundary.verifyGate({ stage: "search", context: { project: "RPL" } }), /effective window/i);
const signedExpiryBoundary = fixtureGate();
signedExpiryBoundary.payloads.activation.expires_at = iso(clock);
await assert.rejects(() => signedExpiryBoundary.verifyGate({ stage: "search", context: { project: "RPL" } }), /expired/i);
const futureEvidence = fixtureGate();
futureEvidence.payloads.activation.issued_at = iso(clock + 1_000);
await assert.rejects(() => futureEvidence.verifyGate({ stage: "search", context: { project: "RPL" } }), /future-dated/i);
console.log("PASS: Activation effective-window and signed-evidence expiry boundaries are exclusive; future evidence is rejected");

clock += 6 * 60_000;
const expiredActivation = fixtureGate({ activationExpiryMs: -1 });
await assert.rejects(() => expiredActivation.verifyGate({ stage: "search", context: { project: "RPL" } }), /expired/i);
console.log("PASS: expired signed Activation cannot authorize a read stage");
console.log("G3 trusted gate offline fixtures passed");
