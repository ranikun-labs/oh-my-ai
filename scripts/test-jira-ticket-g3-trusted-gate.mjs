#!/usr/bin/env node
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { g3EvidenceSha256, createG3TrustedGate } from "./lib/jira-ticket-g3-trusted-gate.mjs";
import { createG3SupervisedAdapter } from "./lib/jira-ticket-g3-supervised-adapter.mjs";

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
  duedate: "2026-10-24",
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
  project: { required: true, hasDefaultValue: false, schema: { type: "project" },
    allowedValues: [{ id: "10000", key: "RPL" }] },
  issuetype: { required: true, hasDefaultValue: false, schema: { type: "issuetype" },
    allowedValues: [{ id: "10010", name: "Task" }] },
  summary: { required: true, hasDefaultValue: false, schema: { type: "string" } },
  description: { required: true, hasDefaultValue: false, schema: { type: "textarea" } },
  assignee: { required: true, hasDefaultValue: false, schema: { type: "user" },
    allowedValues: [{ accountId: "fixture-user" }] },
  priority: { required: true, hasDefaultValue: false, schema: { type: "option" },
    allowedValues: [{ id: "3", name: "High" }] },
  labels: { required: false, hasDefaultValue: false, schema: { type: "array", items: "string" } },
  attachment: { required: false, hasDefaultValue: false, schema: { type: "array", items: "attachment" } },
  customfield_10000: { required: false, hasDefaultValue: false, schema: { type: "any" } },
  customfield_10019: { required: false, hasDefaultValue: false, schema: { type: "any" } },
  customfield_10021: { required: false, hasDefaultValue: false,
    schema: { type: "array", items: "option" } },
  customfield_10037: { required: false, hasDefaultValue: false, schema: { type: "any" } },
  fixVersions: { required: false, hasDefaultValue: false, schema: { type: "array", items: "version" } },
  issuelinks: { required: false, hasDefaultValue: false, schema: { type: "array", items: "issuelinks" } },
  parent: { required: false, hasDefaultValue: false, schema: { type: "issuelink" } },
  reporter: { required: true, hasDefaultValue: true, defaultValue: { accountId: "fixture-owner" },
    schema: { type: "user" }, allowedValues: [{ accountId: "fixture-owner" }] },
  customfield_10042: { required: false, hasDefaultValue: false, defaultValue: [] },
  customfield_10043: { required: false, hasDefaultValue: false },
  customfield_10044: { required: false, hasDefaultValue: false },
  customfield_10015: { required: true, hasDefaultValue: false, schema: { type: "date" } },
  duedate: { required: true, hasDefaultValue: false, schema: { type: "date" } },
  customfield_10045: { required: true, hasDefaultValue: true,
    defaultValue: [{ accountId: "fixture-owner" }],
    schema: { type: "array", items: "user" }, allowedValues: [{ accountId: "fixture-owner" }] },
  customfield_10108: { required: true, hasDefaultValue: false,
    schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" }, allowedValues: options.product },
  customfield_10109: { required: true, hasDefaultValue: false,
    schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" }, allowedValues: options.component },
  customfield_10110: { required: false, hasDefaultValue: false,
    schema: { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" },
    allowedValues: options.concern },
};
const metadataContent = { project: "RPL", issue_type: "Task", issue_type_id: "10010",
  startAt: 0, maxResults: 100, total: Object.keys(metadataFields).length, fields: metadataFields };
const metadataFieldRow = (fieldId, required, hasDefaultValue, schema, extra = {}) =>
  ({ fieldId, name: fieldId, required, hasDefaultValue, schema, ...extra });
// Redacted shape-only fixture from a read-only Task metadata response. Its
// temporary test signature is synthetic and does not represent trusted live
// evidence. No production account IDs or option payloads are stored here;
// empty allowedValues are redaction markers and cannot approve a Create option.
const liveShapedMetadataContent = {
  project: "RPL", issue_type: "Task", issue_type_id: "10010", startAt: 0, maxResults: 100, total: 22,
  fields: [
    metadataFieldRow("attachment", false, false, { type: "array", items: "attachment" }),
    metadataFieldRow("customfield_10000", false, false, { type: "any", custom: "devsummary" }),
    metadataFieldRow("customfield_10015", true, false, { type: "date", custom: "datepicker" }),
    metadataFieldRow("customfield_10019", false, false, { type: "any", custom: "rank" }),
    metadataFieldRow("customfield_10021", false, false,
      { type: "array", items: "option", custom: "multicheckboxes" }, { allowedValues: [] }),
    metadataFieldRow("customfield_10037", false, false, { type: "any", custom: "vulnerability" }),
    metadataFieldRow("customfield_10042", false, false,
      { type: "array", items: "string", custom: "labels" }),
    metadataFieldRow("customfield_10043", false, false,
      { type: "array", items: "string", custom: "labels" }),
    metadataFieldRow("customfield_10044", false, false,
      { type: "array", items: "string", custom: "labels" }),
    metadataFieldRow("customfield_10045", true, true,
      { type: "array", items: "user", custom: "people" },
      { defaultValue: [{ accountId: "REDACTED_FIXTURE_ACCOUNT" }] }),
    metadataFieldRow("customfield_10108", true, false,
      { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
      { allowedValues: [] }),
    metadataFieldRow("customfield_10109", true, false,
      { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
      { allowedValues: [] }),
    metadataFieldRow("customfield_10110", false, false,
      { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" },
      { allowedValues: [] }),
    metadataFieldRow("description", false, false, { type: "string" }),
    metadataFieldRow("duedate", true, false, { type: "date" }),
    metadataFieldRow("fixVersions", false, false, { type: "array", items: "version" }, { allowedValues: [] }),
    metadataFieldRow("issuelinks", false, false, { type: "array", items: "issuelinks" }),
    metadataFieldRow("issuetype", false, false, { type: "issuetype" },
      { allowedValues: [{ id: "10010", name: "작업" }] }),
    metadataFieldRow("parent", false, false, { type: "issuelink" }),
    metadataFieldRow("project", true, false, { type: "project" },
      { allowedValues: [{ id: "fixture-project", key: "RPL" }] }),
    metadataFieldRow("reporter", true, true, { type: "user" }),
    metadataFieldRow("summary", true, false, { type: "string" }),
  ],
};
const metadataHash = g3EvidenceSha256(metadataContent);
const policyHash = "b".repeat(64);
const activationRef = "fixture-activation-task-v1";
const approvalRef = "fixture-owner-cutover-approved-task";

function makePayloads({ activationPatch = {}, policyPatch = {}, metadataPatch = {}, approvalPatch = {},
  metadataAgeMs = 10_000, activationExpiryMs = 300_000, approvalExpiryMs = 240_000,
  metadataOverride = metadataContent, fieldsOverride = fields, createRequestOverride = createRequest,
  readAuthorityPatch = {}, readAuthorityIssueKey = "RPL-901" } = {}) {
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
    allowed_create_fields: ["customfield_10108", "customfield_10109", "customfield_10110", "customfield_10015", "duedate"],
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
    fields_sha256: g3EvidenceSha256(fieldsOverride), create_request_sha256: g3EvidenceSha256(createRequestOverride),
    issued_at: issuedAt, expires_at: iso(clock + approvalExpiryMs), ...approvalPatch,
  });
  const readAuthority = {
    kind: "g3_read_authority", status: "approved", project: "RPL", issue_key: readAuthorityIssueKey,
    issue_type: "Task", issue_type_id: "10010", origin: "target_create",
    origin_ref: `fixture-origin-${readAuthorityIssueKey}`, read_authority: "target",
    policy_sha256: policyHash, issued_at: issuedAt, expires_at: iso(clock + 120_000),
    ...readAuthorityPatch,
  };
  return { activation, policy, metadata, approval, readAuthority };
}

function fixtureGate(options = {}) {
  const payloads = makePayloads(options);
  const replay = new Set();
  const fetchCounts = { activation: 0, current: 0, policy: 0, metadata: 0, approval: 0, readAuthority: 0, claim: 0 };
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
    async fetchReadAuthority() {
      fetchCounts.readAuthority++;
      return signed(payloads.readAuthority, options.tamperReadAuthority === true);
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
    status: "pending", approved_preview_id: previewId, issue_type: "Task", fields,
    create_request: createRequest, ...overrides };
}
function searchContext(overrides = {}) {
  return { project: "RPL", create_preflight: createRequest, ...overrides };
}

const signedFlow = fixtureGate();
assert.equal((await signedFlow.verifyGate({ stage: "search", context: {
  project: "RPL", summary_keywords: createRequest.summary, product: "dev-harness",
  create_preflight: createRequest,
  repository: "oh-my-ai", area: "Jira", related_pr: null, branch: null, decision: null,
  existing_issue_key: null, created_after: null, contract_fingerprint_candidate: "fixture",
} })).allowed, true);
const intentProof = await signedFlow.verifyGate({ stage: "intent", context: intent() });
assert.equal(intentProof.allowed, true);
assert.equal(intentProof.cutover_approval_ref, approvalRef);
assert.deepEqual(intentProof.issue_type_binding, { canonical_issue_type: "Task", issue_type_id: "10010",
  localized_issue_type_name: "Task", metadata_sha256: metadataHash });
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
await assert.rejects(() => signedFlow.verifyGate({ stage: "origin", context: {
  issue_key: "RPL-901", create_request_id: requestId, ledger_ref: ledgerRef,
  create_activation_ref: activationRef, cutover_approval_ref: approvalRef,
  issue_type: "Task", issue_type_id: "10007", origin: "target_create", phase: "create_ready",
  read_authority: "target", write_authority: "target",
  verified_fields: { customfield_10108: { id: "10027" }, customfield_10109: { id: "10028" }, customfield_10110: [] },
} }), /Origin does not match/i);
await signedFlow.verifyGate({ stage: "origin", context: {
  issue_key: "RPL-901", create_request_id: requestId, ledger_ref: ledgerRef,
  create_activation_ref: activationRef, cutover_approval_ref: approvalRef,
  issue_type: "Task", issue_type_id: "10010",
  origin: "target_create", phase: "create_ready", read_authority: "target", write_authority: "target",
  verified_fields: { customfield_10108: { id: "10027" }, customfield_10109: { id: "10028" }, customfield_10110: [] },
} });
const readAuthorityProof = await signedFlow.verifyGate({ stage: "authority_read", context: { issue_key: "RPL-901" } });
assert.equal(readAuthorityProof.allowed, true);
assert.equal(readAuthorityProof.origin_ref, `fixture-origin-RPL-901`);
assert.equal(readAuthorityProof.issue_type_id, "10010");
console.log("PASS: signed current Activation, policy, live metadata, exact Owner approval and all adapter stages");

// Existing Target-created issues retain their per-Issue read authority after
// the future Create Activation expires or is rolled back.
const expiredCreateForReader = fixtureGate({ activationPatch: { status: "revoked", effective_to: iso(clock) },
  activationExpiryMs: -1 });
assert.equal((await expiredCreateForReader.verifyGate({ stage: "authority_read", context: {
  issue_key: "RPL-901",
} })).allowed, true);
assert.equal(expiredCreateForReader.fetchCounts.current, 0,
  "existing-Issue authority must not depend on a current Create Activation");
const forgedReadProof = fixtureGate({ tamperReadAuthority: true });
await assert.rejects(() => forgedReadProof.verifyGate({ stage: "authority_read", context: {
  issue_key: "RPL-901",
} }), /signature/i);
const expiredReadProof = fixtureGate({ readAuthorityPatch: { expires_at: iso(clock) } });
await assert.rejects(() => expiredReadProof.verifyGate({ stage: "authority_read", context: {
  issue_key: "RPL-901",
} }), /expired/i);
const wrongReadIssue = fixtureGate({ readAuthorityPatch: { issue_key: "RPL-902" } });
await assert.rejects(() => wrongReadIssue.verifyGate({ stage: "authority_read", context: {
  issue_key: "RPL-901",
} }), /does not bind/i);
console.log("PASS: per-Issue Target read authority survives Create rollback but rejects forged, expired, or wrong-Issue proof");

const replayAcrossInstance = fixtureGate({ forceReplay: true });
await assert.rejects(() => replayAcrossInstance.verifyGate({ stage: "intent", context: intent() }), /replay/i);
assert.equal(replayAcrossInstance.fetchCounts.claim, 1);
console.log("PASS: durable replay claim rejects a second gate instance for the same CreateRequestId");

const tampered = fixtureGate({ tamperActivation: true });
await assert.rejects(() => tampered.verifyGate({ stage: "search", context: searchContext() }), /signature/i);
const wrongPolicy = fixtureGate({ policyPatch: { policy_sha256: "c".repeat(64) } });
await assert.rejects(() => wrongPolicy.verifyGate({ stage: "search", context: searchContext() }), /policy/i);
const staleMetadata = fixtureGate({ metadataAgeMs: 120_000 });
await assert.rejects(() => staleMetadata.verifyGate({ stage: "search", context: searchContext() }), /stale/i);
const requiredLegacyMetadata = structuredClone(metadataContent);
requiredLegacyMetadata.fields.customfield_10042.required = true;
const requiredLegacy = fixtureGate({ metadataOverride: requiredLegacyMetadata });
await assert.rejects(() => requiredLegacy.verifyGate({ stage: "search", context: searchContext() }), /Legacy/i);
await assert.rejects(() => requiredLegacy.verifyGate({ stage: "create", context: {
  request: createRequest, create_request_id: requestId, activation_ref: activationRef,
  create_metadata: { fields: { customfield_10042: { required: false, hasDefaultValue: false } } },
} }), /Legacy/i);
const defaultedLegacyMetadata = structuredClone(metadataContent);
defaultedLegacyMetadata.fields.customfield_10043.hasDefaultValue = true;
defaultedLegacyMetadata.fields.customfield_10043.defaultValue = "legacy-default";
const defaultedLegacy = fixtureGate({ metadataOverride: defaultedLegacyMetadata });
await assert.rejects(() => defaultedLegacy.verifyGate({ stage: "search", context: searchContext() }), /Legacy/i);
const contradictoryLegacyDefaultMetadata = structuredClone(metadataContent);
contradictoryLegacyDefaultMetadata.fields.customfield_10043.defaultValue = "legacy-default";
const contradictoryLegacyDefault = fixtureGate({ metadataOverride: contradictoryLegacyDefaultMetadata });
await assert.rejects(() => contradictoryLegacyDefault.verifyGate({ stage: "search", context: searchContext() }), /Legacy/i);
const targetOnlyMetadata = structuredClone(metadataContent);
for (const id of ["customfield_10042", "customfield_10043", "customfield_10044"])
  delete targetOnlyMetadata.fields[id];
targetOnlyMetadata.total = Object.keys(targetOnlyMetadata.fields).length;
const targetOnlyGate = fixtureGate({ metadataOverride: targetOnlyMetadata });
assert.equal((await targetOnlyGate.verifyGate({ stage: "search", context: searchContext() })).allowed, true,
  "a complete signed page may omit Legacy fields removed from the Create screen");
await targetOnlyGate.verifyGate({ stage: "intent", context: intent() });
await targetOnlyGate.verifyGate({ stage: "create", context: {
  request: createRequest, create_request_id: requestId, activation_ref: activationRef,
} });
console.log("PASS: signed Target-only metadata keeps Search/Intent/Create Gate checks while omitting removed Legacy fields");
const missingUnrelatedTaskMetadata = structuredClone(metadataContent);
delete missingUnrelatedTaskMetadata.fields.customfield_10019;
missingUnrelatedTaskMetadata.total = Object.keys(missingUnrelatedTaskMetadata.fields).length;
const missingUnrelatedTaskField = fixtureGate({ metadataOverride: missingUnrelatedTaskMetadata });
await assert.rejects(() => missingUnrelatedTaskField.verifyGate({ stage: "search", context: searchContext() }),
  /metadata field set/i);
assert.equal(missingUnrelatedTaskField.fetchCounts.claim, 0,
  "a signed page cannot remove an unrelated Task field and adjust total to appear complete");
const unknownTaskMetadata = structuredClone(metadataContent);
unknownTaskMetadata.fields.customfield_19999 = { required: false, hasDefaultValue: false, schema: { type: "any" } };
unknownTaskMetadata.total = Object.keys(unknownTaskMetadata.fields).length;
const unknownTaskField = fixtureGate({ metadataOverride: unknownTaskMetadata });
await assert.rejects(() => unknownTaskField.verifyGate({ stage: "search", context: searchContext() }),
  /metadata field set/i);
console.log("PASS: signed Task Gate rejects an adjusted count with a missing core field or an unknown field");
const currentAccountsMetadata = structuredClone(metadataContent);
currentAccountsMetadata.fields.assignee.allowedValues = [{ accountId: "retired-account" }];
const staleAssignee = fixtureGate({ metadataOverride: currentAccountsMetadata });
await assert.rejects(() => staleAssignee.verifyGate({ stage: "search", context: searchContext() }),
  /Create account is absent from current Jira metadata for assignee/i);
assert.equal(staleAssignee.fetchCounts.claim, 0,
  "stale Assignee metadata must fail before Search can proceed or a replay claim is made");
await assert.rejects(() => staleAssignee.verifyGate({ stage: "intent", context: intent() }),
  /Create account is absent from current Jira metadata for assignee/i);
assert.equal(staleAssignee.fetchCounts.claim, 0,
  "stale Assignee metadata must fail before the durable replay claim");
const missingAssigneeRequest = { ...createRequest };
delete missingAssigneeRequest.assignee;
const missingAssignee = fixtureGate({ createRequestOverride: missingAssigneeRequest });
await assert.rejects(() => missingAssignee.verifyGate({ stage: "search",
  context: searchContext({ create_preflight: missingAssigneeRequest }) }),
/required live Jira Create field is missing: assignee/i);
await assert.rejects(() => missingAssignee.verifyGate({ stage: "intent",
  context: intent({ create_request: missingAssigneeRequest }) }),
/required live Jira Create field is missing: assignee/i);
assert.equal(missingAssignee.fetchCounts.claim, 0,
  "missing required wrapper input must fail before a replay claim");
const missingRequiredUserMetadata = structuredClone(metadataContent);
missingRequiredUserMetadata.fields.customfield_10045.hasDefaultValue = false;
delete missingRequiredUserMetadata.fields.customfield_10045.defaultValue;
const missingRequiredUser = fixtureGate({ metadataOverride: missingRequiredUserMetadata });
await assert.rejects(() => missingRequiredUser.verifyGate({ stage: "intent", context: intent() }),
  /required live Jira Intent field/i);
const implicitReporterDefaultMetadata = structuredClone(metadataContent);
delete implicitReporterDefaultMetadata.fields.reporter.defaultValue;
delete implicitReporterDefaultMetadata.fields.reporter.allowedValues;
const implicitReporterDefault = fixtureGate({ metadataOverride: implicitReporterDefaultMetadata });
assert.equal((await implicitReporterDefault.verifyGate({ stage: "search", context: searchContext() })).allowed, true,
  "a signed required reporter default may be left to Jira when metadata omits its account value");
assert.equal((await implicitReporterDefault.verifyGate({ stage: "intent", context: intent() })).allowed, true,
  "the reporter account is not invented or added to the signed intent");
const explicitReporterFields = { ...fields, reporter: { accountId: "unverified-reporter" } };
const explicitReporterRequest = { ...createRequest, fields: explicitReporterFields };
const explicitReporter = fixtureGate({ metadataOverride: implicitReporterDefaultMetadata,
  policyPatch: { allowed_create_fields: ["customfield_10108", "customfield_10109", "customfield_10110",
    "customfield_10015", "duedate", "reporter"] },
  fieldsOverride: explicitReporterFields, createRequestOverride: explicitReporterRequest });
await assert.rejects(() => explicitReporter.verifyGate({ stage: "search",
  context: searchContext({ create_preflight: explicitReporterRequest }) }),
/Create account is absent from current Jira metadata for reporter/i);
assert.equal(explicitReporter.fetchCounts.claim, 0,
  "an explicit reporter must fail before the durable replay claim without current allowed accounts");
const nullReporterMetadata = structuredClone(implicitReporterDefaultMetadata);
nullReporterMetadata.fields.reporter.defaultValue = null;
const nullReporterDefault = fixtureGate({ metadataOverride: nullReporterMetadata });
await assert.rejects(() => nullReporterDefault.verifyGate({ stage: "search", context: searchContext() }),
  /default value is missing despite hasDefaultValue for reporter/i);
assert.equal(nullReporterDefault.fetchCounts.claim, 0,
  "an explicit null Metadata default must not use the implicit reporter-default exception");
const missingReporterDefaultMetadata = structuredClone(metadataContent);
missingReporterDefaultMetadata.fields.reporter.hasDefaultValue = false;
delete missingReporterDefaultMetadata.fields.reporter.defaultValue;
const missingReporterDefault = fixtureGate({ metadataOverride: missingReporterDefaultMetadata });
await assert.rejects(() => missingReporterDefault.verifyGate({ stage: "search", context: searchContext() }),
  /required live Jira Create field is missing: reporter/i);
assert.equal(missingReporterDefault.fetchCounts.claim, 0);
const explicitTopLevelReporterRequest = { ...createRequest, reporter: null };
const searchReporterGate = fixtureGate({ createRequestOverride: explicitTopLevelReporterRequest });
await assert.rejects(() => searchReporterGate.verifyGate({ stage: "search",
  context: searchContext({ create_preflight: explicitTopLevelReporterRequest }) }),
/G3 Create request cannot specify reporter/i);
assert.equal(searchReporterGate.fetchCounts.claim, 0,
  "Search preflight with an own reporter property, including null, fails before replay claim");
const intentReporterGate = fixtureGate({ createRequestOverride: explicitTopLevelReporterRequest });
await assert.rejects(() => intentReporterGate.verifyGate({ stage: "intent",
  context: intent({ create_request: explicitTopLevelReporterRequest }) }),
/G3 Create request cannot specify reporter/i);
assert.equal(intentReporterGate.fetchCounts.claim, 0,
  "Intent with an own reporter property fails before durable replay claim");
const createReporterGate = fixtureGate();
await createReporterGate.verifyGate({ stage: "search", context: searchContext() });
await createReporterGate.verifyGate({ stage: "intent", context: intent() });
const claimsBeforeInvalidCreate = createReporterGate.fetchCounts.claim;
await assert.rejects(() => createReporterGate.verifyGate({ stage: "create", context: {
  request: explicitTopLevelReporterRequest, create_request_id: requestId,
  activation_ref: activationRef, ledger_ref: ledgerRef, approved_preview_id: previewId,
} }), /G3 Create request cannot specify reporter/i);
assert.equal(createReporterGate.fetchCounts.claim, claimsBeforeInvalidCreate,
  "Create with an own reporter property is rejected without another replay claim");
const defaultWithoutAllowedPeople = structuredClone(metadataContent);
delete defaultWithoutAllowedPeople.fields.customfield_10045.allowedValues;
const acceptedSignedPeopleDefault = fixtureGate({ metadataOverride: defaultWithoutAllowedPeople });
assert.equal((await acceptedSignedPeopleDefault.verifyGate({ stage: "search", context: searchContext() })).allowed, true,
  "the exact signed Jira default is usable without an allowedValues list");
const explicitPeople = { ...fields, customfield_10045: [{ accountId: "unverified-fixture-account" }] };
const explicitPeopleRequest = { ...createRequest, fields: explicitPeople };
const unverifiedExplicitPeople = fixtureGate({ metadataOverride: defaultWithoutAllowedPeople,
  policyPatch: { allowed_create_fields: ["customfield_10108", "customfield_10109", "customfield_10110",
    "customfield_10015", "customfield_10045", "duedate"] },
  fieldsOverride: explicitPeople, createRequestOverride: explicitPeopleRequest });
await assert.rejects(() => unverifiedExplicitPeople.verifyGate({ stage: "intent", context: intent({
  fields: explicitPeople, create_request: explicitPeopleRequest,
}) }), /Create accounts are absent from current Jira metadata for customfield_10045/i);
const missingDueDateFields = { ...fields };
delete missingDueDateFields.duedate;
const missingDueDateRequest = { ...createRequest, fields: missingDueDateFields };
const missingDueDate = fixtureGate({ fieldsOverride: missingDueDateFields,
  createRequestOverride: missingDueDateRequest });
await assert.rejects(() => missingDueDate.verifyGate({ stage: "intent", context: intent({
  fields: missingDueDateFields, create_request: missingDueDateRequest,
}) }), /required live Jira Intent field is missing: duedate/i);
const unavailableOptionalMetadata = structuredClone(metadataContent);
for (const id of ["assignee", "priority", "labels"]) delete unavailableOptionalMetadata.fields[id];
unavailableOptionalMetadata.total = Object.keys(unavailableOptionalMetadata.fields).length;
const omittedOptionalWrappers = { ...createRequest };
delete omittedOptionalWrappers.assignee;
delete omittedOptionalWrappers.priority;
delete omittedOptionalWrappers.labels;
const optionalFieldsAbsent = fixtureGate({ metadataOverride: unavailableOptionalMetadata,
  createRequestOverride: omittedOptionalWrappers });
assert.equal((await optionalFieldsAbsent.verifyGate({ stage: "search", context: searchContext({
  create_preflight: omittedOptionalWrappers,
}) })).allowed, true,
"optional wrapper fields absent from Metadata are allowed only when omitted from the approved request");
const invalidDateFields = { ...fields, customfield_10015: "2026-02-30" };
const invalidDateRequest = { ...createRequest, fields: invalidDateFields };
const invalidDate = fixtureGate({ fieldsOverride: invalidDateFields, createRequestOverride: invalidDateRequest });
await assert.rejects(() => invalidDate.verifyGate({ stage: "intent", context: intent({
  fields: invalidDateFields, create_request: invalidDateRequest,
}) }),
  /Create date/i);
console.log("PASS: signed live metadata blocks Legacy required/default, stale accounts, missing required fields, and invalid dates");
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
await assert.rejects(() => boundary.verifyGate({ stage: "search", context: searchContext() }), /effective window/i);
const signedExpiryBoundary = fixtureGate();
signedExpiryBoundary.payloads.activation.expires_at = iso(clock);
await assert.rejects(() => signedExpiryBoundary.verifyGate({ stage: "search", context: searchContext() }), /expired/i);
const futureEvidence = fixtureGate();
futureEvidence.payloads.activation.issued_at = iso(clock + 1_000);
await assert.rejects(() => futureEvidence.verifyGate({ stage: "search", context: searchContext() }), /future-dated/i);
console.log("PASS: Activation effective-window and signed-evidence expiry boundaries are exclusive; future evidence is rejected");

const arrayMetadata = structuredClone(metadataContent);
arrayMetadata.fields = Object.entries(metadataFields).map(([fieldId, definition]) => ({
  fieldId, name: fieldId, ...structuredClone(definition),
}));
arrayMetadata.fields.find(field => field.fieldId === "issuetype").allowedValues = [
  { id: "10010", name: "작업" },
];
const mappedArray = fixtureGate({ metadataOverride: arrayMetadata });
assert.equal((await mappedArray.verifyGate({ stage: "search", context: searchContext() })).allowed, true);
await mappedArray.verifyGate({ stage: "intent", context: intent() });
const localizedTypeProof = await mappedArray.verifyGate({ stage: "create", context: {
  request: createRequest, create_request_id: requestId, activation_ref: activationRef,
} });
assert.deepEqual(localizedTypeProof.issue_type_binding, {
  canonical_issue_type: "Task", issue_type_id: "10010", localized_issue_type_name: "작업",
  metadata_sha256: g3EvidenceSha256(arrayMetadata),
});
console.log("PASS: signed fields[] metadata maps by unique fieldId and binds canonical Task to ID 10010 and its current localized name");

const incompletePageMetadata = structuredClone(arrayMetadata);
incompletePageMetadata.total++;
const incompletePage = fixtureGate({ metadataOverride: incompletePageMetadata });
await assert.rejects(() => incompletePage.verifyGate({ stage: "search", context: searchContext() }), /pagination/i);
const offsetPageMetadata = structuredClone(arrayMetadata);
offsetPageMetadata.startAt = 1;
const offsetPage = fixtureGate({ metadataOverride: offsetPageMetadata });
await assert.rejects(() => offsetPage.verifyGate({ stage: "search", context: searchContext() }), /pagination/i);
const undersizedPageMetadata = structuredClone(arrayMetadata);
undersizedPageMetadata.maxResults = undersizedPageMetadata.fields.length - 1;
const undersizedPage = fixtureGate({ metadataOverride: undersizedPageMetadata });
await assert.rejects(() => undersizedPage.verifyGate({ stage: "search", context: searchContext() }), /pagination/i);
const pageSizeDigest = fixtureGate({ metadataOverride: arrayMetadata });
pageSizeDigest.payloads.metadata.maxResults--;
await assert.rejects(() => pageSizeDigest.verifyGate({ stage: "search", context: searchContext() }), /Activation snapshot/i);
assert.equal(incompletePage.fetchCounts.claim, 0);
assert.equal(offsetPage.fetchCounts.claim, 0);
assert.equal(undersizedPage.fetchCounts.claim, 0);
console.log("PASS: signed metadata requires a complete single page and binds pagination fields in its digest");

const duplicateFieldMetadata = structuredClone(arrayMetadata);
duplicateFieldMetadata.fields.push(structuredClone(duplicateFieldMetadata.fields[0]));
duplicateFieldMetadata.total = duplicateFieldMetadata.fields.length;
const duplicateField = fixtureGate({ metadataOverride: duplicateFieldMetadata });
await assert.rejects(() => duplicateField.verifyGate({ stage: "search", context: searchContext() }), /duplicate fieldId/i);
const mismatchedTypeMetadata = structuredClone(arrayMetadata);
mismatchedTypeMetadata.fields.find(field => field.fieldId === "issuetype").allowedValues = [
  { id: "10007", name: "작업" },
];
const mismatchedType = fixtureGate({ metadataOverride: mismatchedTypeMetadata });
await assert.rejects(() => mismatchedType.verifyGate({ stage: "search", context: searchContext() }), /issue type option/i);
console.log("PASS: duplicate field IDs and a localized name attached to the wrong type ID are rejected before use");

const liveShapeBlocked = fixtureGate({ metadataOverride: liveShapedMetadataContent });
const sideEffects = { search: 0, intent: 0, create: 0 };
const capabilityNames = ["jira.search", "jira.create", "jira.read", "jira.intent.persist", "jira.origin.persist"];
const capabilityEvidence = Object.fromEntries(capabilityNames.map(name => [name, {
  available: true, connection_verified: true, evidence_ref: `synthetic:${name}`,
  ...(name.startsWith("jira.") && ["jira.search", "jira.create", "jira.read"].includes(name)
    ? { jira_site_origin: "https://jira.example.test" } : {}),
}]));
const blockedAdapter = createG3SupervisedAdapter({
  jira: {
    async search() { sideEffects.search++; return { status: "none", tool_call_count: 1 }; },
    async create() { sideEffects.create++; throw new Error("unexpected Jira Create"); },
    async read() { throw new Error("unexpected Jira GET"); },
  },
  ledger: {
    async persistIntent() { sideEffects.intent++; throw new Error("unexpected Intent write"); },
    async linkIssue() { throw new Error("unexpected Issue link"); },
    async persistOrigin() { throw new Error("unexpected Origin write"); },
    async readClassificationAuthority() { throw new Error("unexpected Reader access"); },
  },
  verifyGate: input => liveShapeBlocked.verifyGate(input),
  capabilityEvidence, siteOrigin: "https://jira.example.test",
});
await assert.rejects(() => blockedAdapter.search({ project: "RPL", create_preflight: createRequest }),
  /Create option is absent from current Jira metadata/i);
await assert.rejects(() => blockedAdapter.persistIntent(intent()), /Create option is absent from current Jira metadata/i);
await assert.rejects(() => blockedAdapter.create(createRequest), /Intent|replayed Jira Create/i);
assert.deepEqual(sideEffects, { search: 0, intent: 0, create: 0 });
assert.equal(liveShapeBlocked.fetchCounts.approval, 0);
assert.equal(liveShapeBlocked.fetchCounts.claim, 0);
console.log("PASS: redacted live-shaped Task metadata stops before Jira Search, Intent persistence, Owner approval, replay claim, and Create");

const staleAssigneeForAdapter = fixtureGate({ metadataOverride: currentAccountsMetadata });
const staleSideEffects = { search: 0, intent: 0, create: 0 };
const staleAdapter = createG3SupervisedAdapter({
  jira: {
    async search() { staleSideEffects.search++; return { status: "none", tool_call_count: 1 }; },
    async create() { staleSideEffects.create++; throw new Error("unexpected Jira Create"); },
    async read() { throw new Error("unexpected Jira GET"); },
  },
  ledger: {
    async persistIntent() { staleSideEffects.intent++; throw new Error("unexpected Intent write"); },
    async linkIssue() { throw new Error("unexpected Issue link"); },
    async persistOrigin() { throw new Error("unexpected Origin write"); },
    async readClassificationAuthority() { throw new Error("unexpected Reader access"); },
  },
  verifyGate: input => staleAssigneeForAdapter.verifyGate(input),
  capabilityEvidence, siteOrigin: "https://jira.example.test",
});
await assert.rejects(() => staleAdapter.search({ project: "RPL", create_preflight: createRequest }),
  /Create account is absent from current Jira metadata for assignee/i);
await assert.rejects(() => staleAdapter.persistIntent(intent()),
  /Create account is absent from current Jira metadata for assignee/i);
await assert.rejects(() => staleAdapter.create(createRequest), /Intent|replayed Jira Create/i);
assert.deepEqual(staleSideEffects, { search: 0, intent: 0, create: 0 });
assert.equal(staleAssigneeForAdapter.fetchCounts.claim, 0);
console.log("PASS: stale Assignee and missing wrapper inputs fail before Search, Intent persistence, replay CAS, and Create");

clock += 6 * 60_000;
const expiredActivation = fixtureGate({ activationExpiryMs: -1 });
await assert.rejects(() => expiredActivation.verifyGate({ stage: "search", context: searchContext() }), /expired/i);
console.log("PASS: expired signed Activation cannot authorize a new search");
console.log("G3 trusted gate offline fixtures passed");
