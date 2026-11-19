#!/usr/bin/env node
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONTRACT_FIELDS, beginJiraTicketCreateWorkflow, applyJiraSearchResult,
  applyJiraPreviewApproval, createDescription, runJiraTicketCreateWorkflow } from "./lib/jira-ticket-create-workflow.mjs";
import { createG3FileLedger, g3FileOriginRef } from "./lib/jira-ticket-g3-file-ledger.mjs";
import { createG3SupervisedAdapter } from "./lib/jira-ticket-g3-supervised-adapter.mjs";
import { createG3JiraConnector, G3_JIRA_TOOL_NAMES } from "./lib/jira-ticket-g3-jira-connector.mjs";
import { createG3TrustedGate, g3EvidenceSha256 } from "./lib/jira-ticket-g3-trusted-gate.mjs";
import { createG3AuthorityReader } from "./lib/jira-ticket-g3-authority-reader.mjs";

// Everything below is synthetic: ephemeral signer, in-process MCP, temporary
// filesystem. No environment credentials, network transport or live tools.
const siteOrigin = "https://jira.example.test", cloudId = "123e4567-e89b-12d3-a456-426614174000";
const ledgerRef = "offline-composed-ledger", requestId = "offline-composed-request-0001";
const activationRef = "offline-task-activation", approvalRef = "offline-owner-approval";
const at = Date.now(), iso = time => new Date(time).toISOString();
const times = { issued_at: iso(at - 1000), expires_at: iso(at + 120000) };
const select = (id, value) => ({ required: true, hasDefaultValue: false,
  schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
  allowedValues: [{ id, value }] });
const fields = {
  project: { required: true, hasDefaultValue: false, schema: { type: "project" },
    allowedValues: [{ id: "fixture-project", key: "RPL" }] },
  issuetype: { required: true, hasDefaultValue: false, schema: { type: "issuetype" },
    allowedValues: [{ id: "10010", name: "작업" }] },
  summary: { required: true, hasDefaultValue: false, schema: { type: "string" } },
  description: { required: false, hasDefaultValue: false, schema: { type: "string" } },
  // Synthetic values with the 19 field IDs and wrapper/Legacy omissions
  // observed in RPL Task and Feature Create Metadata on 2026-11-18 KST.
  reporter: { required: true, hasDefaultValue: true, schema: { type: "user" } },
  ...Object.fromEntries([
    ["attachment", "array", "attachment"],
    ["customfield_10000", "any"],
    ["customfield_10019", "any"],
    ["customfield_10021", "array", "option"],
    ["customfield_10037", "any"],
    ["fixVersions", "array", "version"],
    ["issuelinks", "array", "issuelinks"],
    ["parent", "issuelink"],
  ].map(([id, type, items]) => [id, { required: false, hasDefaultValue: false,
    schema: { type, ...(items ? { items } : {}) } }])),
  customfield_10015: { required: true, hasDefaultValue: false, schema: { type: "date" } },
  duedate: { required: false, hasDefaultValue: false, schema: { type: "date" } },
  customfield_10045: { required: true, hasDefaultValue: true,
    defaultValue: [{ accountId: "offline-owner" }], schema: { type: "array", items: "user" } },
  customfield_10108: select("10027", "dev-harness"),
  customfield_10109: select("10028", "backend"),
  customfield_10110: { required: false, hasDefaultValue: false,
    schema: { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" },
    allowedValues: [{ id: "10038", value: "integration" }] },
};
const contract = Object.fromEntries(CONTRACT_FIELDS.map(name => [name,
  name === "Summary" ? "[OFFLINE ONLY] composed G3" : "Synthetic " + name]));
const target = {
  mode: "single_supervised", request_id: requestId, ledger_ref: ledgerRef,
  readiness: { reader: true, board: true, automation: true, rollback: true, ledger: true },
  cutover: { status: "approved", approval_ref: approvalRef, activation_ref: activationRef,
    rollback_ref: "offline-rollback", effective_from: iso(at - 60000),
    effective_to: iso(at + 120000), request_time: iso(at) },
  create_metadata: { source: "live_jira_create_metadata", project: "RPL", issue_type: "Task",
    issue_type_id: "10010", observed_at: iso(at - 2000), fields },
  selection: { product: { id: "10027", value: "dev-harness" },
    component: { id: "10028", value: "backend" }, concerns: [] },
  supplemental_fields: { customfield_10015: iso(at).slice(0, 10) },
};
const metadata = { project: "RPL", issue_type: "Task", assignee: "offline-owner", priority: "High",
  product: "Dev Harness", repository: "oh-my-ai", area: "Jira", target_create: target };
const canonical = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const trustedKeys = { offline: publicKey.export({ type: "spki", format: "pem" }) };
const signed = payload => ({ key_id: "offline", payload: structuredClone(payload),
  signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64") });
const root = await mkdtemp(join(tmpdir(), "g3-composed-offline-"));
try {
  let drift = false, sessionAllowed = true;
  const calls = { search: 0, create: 0, read: 0 };
  const jira = await createG3JiraConnector({ siteOrigin, cloudId, session: { id: "offline-session" },
    verifySession: async ({ capability, session }) => ({ allowed: sessionAllowed, capability,
      session_id: session.id, site_origin: siteOrigin, cloud_id: cloudId,
      evidence_ref: "offline-session:" + capability, checked_at: iso(Date.now()), expires_at: times.expires_at }),
    invokeTool: async (name, args) => {
      if (name === G3_JIRA_TOOL_NAMES.search) { calls.search++; return { structuredContent: { issues: [], isLast: true } }; }
      const issue = { id: "10901", key: "RPL-901", self: siteOrigin + "/rest/api/3/issue/10901",
        fields: { project: { key: "RPL" }, summary: contract.Summary, issuetype: { id: "10010" },
          customfield_10108: { id: drift ? "99999" : "10027" },
          customfield_10109: { id: "10028" }, customfield_10110: [] } };
      if (name === G3_JIRA_TOOL_NAMES.create) {
        calls.create++; assert.equal(args.projectKey, "RPL");
        assert.equal(Object.hasOwn(args, "assignee_account_id"), false);
        assert.equal(Object.hasOwn(args.additional_fields, "priority"), false);
        assert.equal(Object.hasOwn(args.additional_fields, "labels"), false);
        assert.equal(args.additional_fields.customfield_10042, undefined);
        assert.equal(Object.hasOwn(args.additional_fields, "duedate"), false,
          "the Jira connector must omit the optional due date from the actual request");
        assert.equal(args.additional_fields.customfield_10015, target.supplemental_fields.customfield_10015,
          "the Jira connector must forward the approved start date unchanged");
        return { structuredContent: issue };
      }
      assert.equal(name, G3_JIRA_TOOL_NAMES.read); calls.read++;
      return { content: [{ type: "text", text: JSON.stringify(issue) }] };
    } });
  const ledger = createG3FileLedger({ root: join(root, "ledger"), ledgerRef });
  const capabilityEvidence = { ...jira.capabilities,
    ...Object.fromEntries(["jira.intent.persist", "jira.origin.persist"].map(name =>
      [name, { available: true, connection_verified: true, evidence_ref: "offline-local-ledger:" + name }])) };
  const protocolCapabilities = Object.fromEntries(Object.entries(capabilityEvidence).map(([name, proof]) =>
    [name, { available: true, connection_verified: true, evidence_ref: proof.evidence_ref }]));
  const input = { runtime: "codex", contract, metadata, capabilities: protocolCapabilities,
    runtime_evidence: { jira_site_origin: siteOrigin } };
  const preview = applyJiraSearchResult(beginJiraTicketCreateWorkflow(input).state, { status: "none", tool_call_count: 1 });
  if (!preview?.state) throw new Error("synthetic preview did not materialize");
  const approved = applyJiraPreviewApproval(preview.state, { status: "approved", preview_id: preview.state.preview_id });
  assert.equal(approved.required_action.type, "jira.intent_persist_required");
  const intent = approved.required_action.request, snapshot = approved.state.approved_snapshot;
  const expectedCreate = { project: snapshot.project, issue_type: snapshot.issue_type,
    summary: snapshot.contract.Summary, description: createDescription(snapshot), fields: intent.fields };
  assert.equal(Object.keys(fields).length, 19, "offline fixture must mirror the observed 19-field Task and Feature shape");
  assert.equal(Object.hasOwn(expectedCreate.fields, "duedate"), false,
    "the signed Task workflow permits omission of the optional due date");
  for (const wrapper of ["assignee", "priority", "labels"]) {
    assert.equal(Object.hasOwn(fields, wrapper), false,
      "offline metadata must not fabricate unsupported Jira wrappers");
    assert.equal(Object.hasOwn(expectedCreate, wrapper), false,
      "G3 Create request must omit unsupported wrappers");
  }
  const policyHash = g3EvidenceSha256({ fixture: "policy", foundation_ref: "8d3ad283402e3a6d42b90ae457557b5751a041e4" });
  const metadataContent = { site_origin: siteOrigin, cloud_id: cloudId, project: "RPL", issue_type: "Task", issue_type_id: "10010",
    startAt: 0, maxResults: 100, total: Object.keys(fields).length, fields };
  const activation = { kind: "g3_activation", status: "active", activation_ref: activationRef,
    owner_approval_ref: approvalRef, policy_sha256: policyHash, metadata_sha256: g3EvidenceSha256(metadataContent),
    ...times, effective_from: target.cutover.effective_from, effective_to: target.cutover.effective_to,
    scope: { project: "RPL", issue_type: "Task", issue_type_id: "10010", ledger_ref: ledgerRef,
      request_id: requestId, approved_preview_id: intent.approved_preview_id,
      operations: ["search", "intent", "create", "read", "origin", "authority_read"] } };
  const policy = { kind: "g3_policy", status: "active", policy_sha256: policyHash, project: "RPL",
    allowed_issue_types: { Task: "10010" }, mode: "single_supervised", max_concerns: 3,
    allowed_create_fields: ["customfield_10108", "customfield_10109", "customfield_10110", "customfield_10015", "duedate"],
    max_metadata_age_ms: 60000, ...times };
  const liveMetadata = { kind: "g3_live_metadata", ...metadataContent, ...times,
    observed_at: target.create_metadata.observed_at, metadata_sha256: g3EvidenceSha256(metadataContent) };
  const approval = { kind: "g3_owner_approval", status: "approved", approval_ref: approvalRef,
    activation_ref: activationRef, policy_sha256: policyHash, project: "RPL", issue_type: "Task", issue_type_id: "10010",
    ledger_ref: ledgerRef, create_request_id: requestId, approved_preview_id: intent.approved_preview_id,
    fields_sha256: g3EvidenceSha256(intent.fields), create_request_sha256: g3EvidenceSha256(expectedCreate), ...times };
  const source = {
    fetchActivation: async () => signed(activation), fetchCurrentActivation: async () => signed(activation),
    fetchPolicy: async () => signed(policy), fetchLiveMetadata: async () => signed(liveMetadata),
    fetchOwnerApproval: async () => signed(approval),
    fetchReadAuthority: async ({ issue_key }) => signed({ kind: "g3_read_authority", status: "approved",
      issue_key, project: "RPL", issue_type: "Task", issue_type_id: "10010", origin: "target_create",
      origin_ref: g3FileOriginRef({ ledger_ref: ledgerRef, create_request_id: requestId,
        issue_key, issue_type_id: "10010" }), read_authority: "target", policy_sha256: policyHash, ...times }),
    claimReplay: async claim => {
      const directory = join(root, "claims"); await mkdir(directory, { recursive: true });
      let status = "claimed";
      try { const handle = await open(join(directory, claim.claim_key), "wx");
        try { await handle.writeFile(JSON.stringify(claim)); await handle.sync(); } finally { await handle.close(); }
        const folder = await open(directory, "r"); try { await folder.sync(); } finally { await folder.close(); }
      } catch (error) { if (error.code !== "EEXIST") throw error; status = "duplicate"; }
      return signed({ kind: "g3_replay_claim", status, ...claim, ...times });
    },
  };
  const verifyGate = createG3TrustedGate({ source, trustedKeys });
  const adapter = createG3SupervisedAdapter({ jira, ledger, verifyGate, capabilityEvidence, siteOrigin });
  const otherSite = "https://other.example.test";
  const otherCloud = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherJira = await createG3JiraConnector({ siteOrigin: otherSite, cloudId: otherCloud,
    session: { id: "offline-other-session" },
    verifySession: async ({ capability, session }) => ({ allowed: true, capability,
      session_id: session.id, site_origin: otherSite, cloud_id: otherCloud,
      evidence_ref: "offline-other:" + capability, checked_at: iso(Date.now()), expires_at: times.expires_at }),
    invokeTool: async () => { throw new Error("unexpected tool call on different connection"); },
  });
  assert.throws(() => { otherJira.capabilities = jira.capabilities; }, TypeError);
  assert.throws(() => { otherJira.capabilities["jira.search"] = jira.capabilities["jira.search"]; }, TypeError);
  assert.throws(() => { otherJira.capabilities["jira.search"].jira_cloud_id = cloudId; }, TypeError);
  assert.throws(() => createG3SupervisedAdapter({
    jira: otherJira, ledger, verifyGate, capabilityEvidence, siteOrigin,
  }), /does not match the Jira connector/);
  assert.deepEqual(await readdir(root), [], "wrong connector must not create a replay claim or Intent");

  const featureMetadata = structuredClone(metadata);
  featureMetadata.issue_type = "Feature";
  featureMetadata.feature_progress = { planning: { status: "완료", evidence: "가상 설계 문서" }, next_action: "구현 확인" };
  const featureCreateMetadata = featureMetadata.target_create.create_metadata;
  featureCreateMetadata.issue_type = "Feature";
  featureCreateMetadata.issue_type_id = "10009";
  featureCreateMetadata.fields.issuetype.allowedValues = [{ id: "10009", name: "기능" }];
  const rejectedFeature = beginJiraTicketCreateWorkflow({ ...input, metadata: featureMetadata });
  assert.equal(rejectedFeature.required_action, null);
  assert.match(rejectedFeature.report.allowed_next_step, /Legacy 필수\/기본값 해제 미검증/);
  const rejectedFeatureReport = await runJiraTicketCreateWorkflow({ adapter, contract,
    metadata: featureMetadata, approval: { current: true } });
  assert.equal(rejectedFeatureReport.create_attempted, false);
  assert.deepEqual(calls, { search: 0, create: 0, read: 0 });
  assert.equal(rejectedFeatureReport.mutation_status, "0");
  assert.deepEqual(await readdir(root), [], "Feature must not create any Intent or replay ledger state");
  console.log("PASS: Feature with the observed Target-only field shape stops before Jira or ledger actions");

  for (const [field, mismatch] of [
    ["site_origin", "https://other.example.test"],
    ["cloud_id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  ]) {
    const previous = liveMetadata[field];
    const previousHash = liveMetadata.metadata_sha256;
    liveMetadata[field] = mismatch;
    liveMetadata.metadata_sha256 = activation.metadata_sha256 = g3EvidenceSha256({ ...metadataContent, [field]: mismatch });
    await assert.rejects(() => adapter.search({ project: "RPL", create_preflight: expectedCreate }), /site and cloud ID/);
    await assert.rejects(() => verifyGate({ stage: "intent", context: { ...intent, create_request: expectedCreate,
      jira_connection: { site_origin: siteOrigin, cloud_id: cloudId } } }), /site and cloud ID/);
    assert.deepEqual(calls, { search: 0, create: 0, read: 0 });
    assert.deepEqual(await readdir(root), [], "mismatched identity must not claim replay or write Intent");
    liveMetadata[field] = previous;
    liveMetadata.metadata_sha256 = activation.metadata_sha256 = previousHash;
  }
  await assert.rejects(() => verifyGate({ stage: "search", context: {
    project: "RPL", create_preflight: expectedCreate,
  } }), /site and cloud ID/);
  assert.deepEqual(await readdir(root), []);
  console.log("PASS: signed metadata site and Cloud ID mismatch stop before Jira and replay claim");
  const report = await runJiraTicketCreateWorkflow({ adapter, contract, metadata, approval: { current: true } });
  assert.equal(report.verification_status, "verified", JSON.stringify(report));
  assert.equal(report.read_authority, "target"); assert.equal(calls.create, 1);
  const reader = createG3AuthorityReader({ targetReader: adapter, jira,
    resolveLegacyEvidence: async ({ issue_key }) => ({ status: "not_legacy", verified: true, issue_key,
      source: "legacy_manifest_migration_history", evidence_ref: "offline-history-proof" }) });
  assert.equal((await reader.readClassification("RPL-901")).read_authority, "target");
  const projected = await reader.projectReadOnlyView(["RPL-901", "RPL-112", "RPL-113", "RPL-114"]);
  assert.equal(projected.aggregate.classified_count, 1); assert.equal(projected.aggregate.unknown_count, 3);
  console.log("PASS: signed Gate -> real file Intent -> MCP normalization -> GET -> Origin -> Reader projection");
  activation.status = "rolled_back";
  assert.equal((await reader.readClassification("RPL-901")).read_authority, "target",
    "rolling back future Create must preserve verified per-Issue Target reads");
  activation.status = "active";
  drift = true;
  const unknown = await reader.readClassification("RPL-901");
  assert.equal(unknown.origin, "UNKNOWN_ORIGIN"); assert.equal(unknown.write_authority, "frozen");
  drift = false; sessionAllowed = false;
  assert.equal((await reader.readClassification("RPL-901")).read_authority, "none");
  sessionAllowed = true;
  const restarted = createG3SupervisedAdapter({ jira, ledger, capabilityEvidence, siteOrigin,
    verifyGate: createG3TrustedGate({ source, trustedKeys }) });
  const replay = await runJiraTicketCreateWorkflow({ adapter: restarted, contract, metadata, approval: { current: true } });
  assert.equal(replay.create_attempted, false); assert.equal(calls.create, 1);
  console.log("PASS: live drift/auth failure freezes Reader; restarted signed request cannot replay Create");
} finally { await rm(root, { recursive: true, force: true }); }
