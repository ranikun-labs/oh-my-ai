#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_FIELDS, runJiraTicketCreateWorkflow } from "./lib/jira-ticket-create-workflow.mjs";
import { createG3FileLedger, g3FileOriginRef } from "./lib/jira-ticket-g3-file-ledger.mjs";
import { createG3SupervisedAdapter } from "./lib/jira-ticket-g3-supervised-adapter.mjs";

// All actors, approvals, metadata and Jira IssueKeys below are SYNTHETIC.
// Nothing in this file connects to Atlassian or writes to production systems.
const ledgerRef = "fixture-g3-single-writer-ledger";
const fixtureCapabilities = Object.fromEntries([
  "jira.search", "jira.create", "jira.read", "jira.intent.persist", "jira.origin.persist",
].map(name => [name, { available: true, connection_verified: true,
  evidence_ref: "SYNTHETIC-CAPABILITY-ONLY", jira_site_origin: "https://jira.example" }]));
const contract = Object.fromEntries(CONTRACT_FIELDS.map(k => [k, k === "Summary"
  ? "[FIXTURE ONLY] G3 Task Create" : "Synthetic " + k]));
const metadata = { project: "RPL", issue_type: "Task", assignee: "fixture-user",
  priority: "High", product: "Dev Harness", repository: "oh-my-ai", area: "Jira", branch: "test" };
const iso = ts => new Date(ts).toISOString();
const today = iso(Date.now()).slice(0, 10);
const tomorrow = iso(Date.now() + 86400000).slice(0, 10);
const fieldSelect = allowedValues => ({
  required: true, hasDefaultValue: false,
  schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
  allowedValues,
});
function config(requestId = "g3-fixture-request-0001") {
  const now = Date.now();
  return {
    mode: "single_supervised", request_id: requestId, ledger_ref: ledgerRef,
    readiness: { reader: true, board: true, automation: true, rollback: true, ledger: true },
    cutover: { status: "approved", approval_ref: "fixture-owner-approval",
      activation_ref: "fixture-task-activation", rollback_ref: "fixture-rollback",
      effective_from: iso(now - 3600000), effective_to: iso(now + 3600000),
      request_time: iso(now) },
    create_metadata: { source: "live_jira_create_metadata", project: "RPL",
      issue_type: "Task", issue_type_id: "10010", observed_at: iso(now - 60000),
      fields: {
        customfield_10042: { required: false, hasDefaultValue: false },
        customfield_10043: { required: false, hasDefaultValue: false },
        customfield_10044: { required: false, hasDefaultValue: false },
        customfield_10015: { required: true, hasDefaultValue: false, schema: { type: "date" } },
        duedate: { required: true, hasDefaultValue: false, schema: { type: "date" } },
        customfield_10045: { required: true, hasDefaultValue: true,
          defaultValue: [{ accountId: "fixture-owner" }], schema: { type: "array", items: "user" } },
        customfield_10108: fieldSelect([{ id: "10027", value: "dev-harness" }]),
        customfield_10109: fieldSelect([{ id: "10028", value: "backend" }]),
        customfield_10110: { required: false, hasDefaultValue: false,
          schema: { type: "array", items: "option",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" },
          allowedValues: [{ id: "10038", value: "integration" }] },
      } },
    selection: { product: { id: "10027", value: "dev-harness" },
      component: { id: "10028", value: "backend" }, concerns: [] },
    supplemental_fields: { customfield_10015: today, duedate: tomorrow },
  };
}
function fakeJira({ throwCreate = false, throwOrigin = false, wrongRead = false, wrongTypeRead = false } = {}) {
  let createCalls = 0;
  const jira = {
    async search() { return { status: "none", tool_call_count: 1 }; },
    async create(request) {
      createCalls++;
      if (throwCreate) throw new Error("synthetic response lost");
      return { kind: "created", tool_call_count: 1, key: "RPL-201",
        url: "https://jira.example/browse/RPL-201", project: "RPL",
        summary: request.summary };
    },
    async read(request) {
      return { tool_call_count: 1, key: request.key, issue_type_id: wrongTypeRead ? "10007" : "10010",
        fields: { customfield_10108: { id: wrongRead ? "10020" : "10027" },
          customfield_10109: { id: "10028" }, customfield_10110: [] } };
    },
  };
  return { jira, calls: () => createCalls };
}
const gate = async ({ stage, context }) => ({ allowed: true, evidence_ref: "SYNTHETIC-TEST-ONLY",
  ...(stage === "intent" ? { cutover_approval_ref: "fixture-owner-approval",
    issue_type_binding: { canonical_issue_type: "Task", issue_type_id: "10010",
      localized_issue_type_name: "작업", metadata_sha256: "c".repeat(64) } } : {}),
  ...(stage === "authority_read" ? { project: "RPL", issue_key: context.issue_key,
    issue_type: "Task", issue_type_id: "10010", origin: "target_create",
    origin_ref: g3FileOriginRef({ ledger_ref: ledgerRef, create_request_id: "g3-fixture-request-0001",
      issue_key: context.issue_key, issue_type_id: "10010" }), read_authority: "target" } : {}),
  ...(stage === "create" ? { issue_type_binding: { canonical_issue_type: "Task", issue_type_id: "10010",
    localized_issue_type_name: "작업", metadata_sha256: "c".repeat(64) } } : {}) });
const pendingIntent = (requestId, fields = {
  customfield_10108: { id: "10027" }, customfield_10109: { id: "10028" }, customfield_10110: [],
}) => ({ create_request_id: requestId, ledger_ref: ledgerRef, status: "pending",
  approved_preview_id: "sha-fixture", activation_ref: "fixture-task-activation",
  cutover_approval_ref: "caller-supplied-untrusted-ref", issue_type: "Task", fields });
const execution = async ({ root, target, simulation, customGate = gate, ledgerOverride } = {}) => {
  const ledger = ledgerOverride ?? createG3FileLedger({ root, ledgerRef });
  const actor = createG3SupervisedAdapter({ ledger, jira: simulation.jira,
    verifyGate: customGate, siteOrigin: "https://jira.example", capabilityEvidence: fixtureCapabilities });
  const report = await runJiraTicketCreateWorkflow({ adapter: actor,
    contract, metadata: { ...metadata, target_create: target ?? config() },
    approval: { current: true } });
  return { ledger, report, actor };
};
const root = await mkdtemp(join(tmpdir(), "jira-g3-offline-"));
try {
  const unverifiedJira = fakeJira(), unverifiedLedger = createG3FileLedger({
    root: join(root, "no-capabilities"), ledgerRef,
  });
  assert.throws(() => createG3SupervisedAdapter({ jira: unverifiedJira.jira,
    ledger: unverifiedLedger, verifyGate: gate, siteOrigin: "https://jira.example" }),
  /missing verified capability evidence/);
  assert.equal(unverifiedJira.calls(), 0, "no evidence must not attempt Jira Create");
  const wrongSiteCapabilities = structuredClone(fixtureCapabilities);
  wrongSiteCapabilities["jira.create"].jira_site_origin = "https://another-jira.example";
  assert.throws(() => createG3SupervisedAdapter({ jira: unverifiedJira.jira,
    ledger: unverifiedLedger, verifyGate: gate, siteOrigin: "https://jira.example",
    capabilityEvidence: wrongSiteCapabilities }),
  /missing verified capability evidence: jira.create/);
  const absentAvailability = structuredClone(fixtureCapabilities);
  absentAvailability["jira.search"].available = false;
  assert.throws(() => createG3SupervisedAdapter({ jira: unverifiedJira.jira,
    ledger: unverifiedLedger, verifyGate: gate, siteOrigin: "https://jira.example",
    capabilityEvidence: absentAvailability }),
  /missing verified capability evidence: jira.search/);
  const unverifiedConnection = structuredClone(fixtureCapabilities);
  unverifiedConnection["jira.read"].connection_verified = false;
  assert.throws(() => createG3SupervisedAdapter({ jira: unverifiedJira.jira,
    ledger: unverifiedLedger, verifyGate: gate, siteOrigin: "https://jira.example",
    capabilityEvidence: unverifiedConnection }),
  /missing verified capability evidence: jira.read/);
  const missingEvidenceRef = structuredClone(fixtureCapabilities);
  missingEvidenceRef["jira.intent.persist"].evidence_ref = "";
  assert.throws(() => createG3SupervisedAdapter({ jira: unverifiedJira.jira,
    ledger: unverifiedLedger, verifyGate: gate, siteOrigin: "https://jira.example",
    capabilityEvidence: missingEvidenceRef }),
  /missing verified capability evidence: jira.intent.persist/);
  console.log("PASS: missing/invalid/mismatched capability evidence refuses Adapter construction before Jira calls");

  const successDir = join(root, "success"), good = fakeJira();
  const pass = await execution({ root: successDir, simulation: good });
  assert.equal(pass.report.verification_status, "verified", JSON.stringify(pass.report));
  assert.equal(pass.report.mutation_status, "applied");
  assert.equal(good.calls(), 1);
  assert.deepEqual((await pass.actor.readClassificationAuthority("RPL-201")).product, { id: "10027" });
  const verifiedRead = await pass.actor.readVerifiedClassification("RPL-201");
  assert.equal(verifiedRead.read_authority, "target");
  assert.equal(verifiedRead.source, "jira_get_and_durable_origin");
  assert.equal((await pass.ledger.readClassificationAuthority("RPL-299")).read_authority, "none");
  const link = await pass.ledger.inspectRequest("g3-fixture-request-0001");
  assert.equal(link.link.issue_key, "RPL-201");
  assert.equal(link.pending.cutover_approval_ref, "fixture-owner-approval",
    "trusted Intent gate reference must be frozen in pending Intent");
  assert.equal(link.pending.issue_type_id, "10010", "signed Issue Type ID must be frozen in the pending Intent");
  console.log("PASS: durable Intent > at-most-one Create attempt > IssueKey link > GET > Origin/Reader");

  const readerTamper = createG3SupervisedAdapter({ ledger: pass.ledger,
    jira: fakeJira({ wrongRead: true }).jira, verifyGate: gate, siteOrigin: "https://jira.example", capabilityEvidence: fixtureCapabilities });
  assert.equal((await readerTamper.readVerifiedClassification("RPL-201")).read_authority, "none");
  assert.equal((await readerTamper.readClassificationAuthority("RPL-201")).read_authority, "none",
    "public Reader alias must not expose raw Ledger authority");
  const wrongSignedOrigin = createG3SupervisedAdapter({ ledger: pass.ledger, jira: fakeJira().jira,
    verifyGate: async input => ({ ...await gate(input), ...(input.stage === "authority_read"
      ? { origin_ref: "signed-proof-for-another-ledger-origin" } : {}) }),
    siteOrigin: "https://jira.example", capabilityEvidence: fixtureCapabilities });
  assert.equal((await wrongSignedOrigin.readVerifiedClassification("RPL-201")).read_authority, "none",
    "the signed Origin reference must equal the durable Ledger Origin reference");
  const wrongSignedType = createG3SupervisedAdapter({ ledger: pass.ledger, jira: fakeJira().jira,
    verifyGate: async input => ({ ...await gate(input), ...(input.stage === "authority_read"
      ? { issue_type: "Epic", issue_type_id: "10007" } : {}) }),
    siteOrigin: "https://jira.example", capabilityEvidence: fixtureCapabilities });
  assert.equal((await wrongSignedType.readVerifiedClassification("RPL-201")).read_authority, "none",
    "the signed Issue Type must equal the durable Ledger Issue Type");
  const wrongJiraType = createG3SupervisedAdapter({ ledger: pass.ledger,
    jira: fakeJira({ wrongTypeRead: true }).jira, verifyGate: gate,
    siteOrigin: "https://jira.example", capabilityEvidence: fixtureCapabilities });
  assert.equal((await wrongJiraType.readVerifiedClassification("RPL-201")).read_authority, "none",
    "Jira GET Issue Type ID must equal the signed proof and Ledger");
  await assert.rejects(() => pass.actor.persistOrigin({
    create_request_id: "g3-fixture-request-0001", issue_key: "RPL-999",
    verified_fields: { customfield_10108: { id: "10027" },
      customfield_10109: { id: "10028" }, customfield_10110: [] },
  }), /Origin without same-Issue/);
  await assert.rejects(() => pass.actor.persistOrigin({
    create_request_id: "g3-fixture-request-0001", issue_key: "RPL-201",
    verified_fields: { customfield_10108: { id: "10020" },
      customfield_10109: { id: "10028" }, customfield_10110: [] },
  }), /Origin without same-Issue/);
  console.log("PASS: Reader alias and Origin receipts cannot bypass same Jira GET");

  // Fresh process/adapter using the same request ID MUST NOT call Jira Create.
  const duplicate = fakeJira();
  const twice = await execution({ root: successDir, simulation: duplicate });
  assert.equal(duplicate.calls(), 0);
  assert.equal(twice.report.create_attempted, false);
  console.log("PASS: cross-invocation CreateRequestId CAS replay prevention");

  const unknownDir = join(root, "unknown"), ambiguity = fakeJira({ throwCreate: true });
  const uncertain = await execution({ root: unknownDir, simulation: ambiguity });
  assert.equal(ambiguity.calls(), 1);
  assert.equal(uncertain.report.mutation_status, "possibly_applied");
  assert.equal((await uncertain.ledger.readClassificationAuthority("RPL-201")).read_authority, "none");
  const retry = fakeJira();
  await execution({ root: unknownDir, simulation: retry });
  assert.equal(retry.calls(), 0, "ambiguous Create must never be retried");
  console.log("PASS: lost Create response freezes authority and prohibits replay");

  const wrongDir = join(root, "wrong"), wrong = fakeJira({ wrongRead: true });
  const mismatch = await execution({ root: wrongDir, simulation: wrong });
  assert.equal(mismatch.report.origin_status, "UNKNOWN_ORIGIN");
  assert.equal((await mismatch.ledger.readClassificationAuthority("RPL-201")).write_authority, "frozen");
  console.log("PASS: inconsistent Jira GET quarantined");

  const blockedDir = join(root, "blocked"), blocked = fakeJira();
  const noGate = await execution({ root: blockedDir, simulation: blocked,
    customGate: async () => ({ allowed: false }) });
  assert.equal(noGate.report.create_attempted, false);
  assert.equal(blocked.calls(), 0);
  console.log("PASS: no trusted external gate -> no Jira Create");

  const missingApprovalDir = join(root, "missing-approval");
  const missingApprovalLedger = createG3FileLedger({ root: missingApprovalDir, ledgerRef });
  const missingApprovalActor = createG3SupervisedAdapter({ ledger: missingApprovalLedger,
    jira: fakeJira().jira, verifyGate: async () => ({ allowed: true,
      evidence_ref: "SYNTHETIC-TEST-ONLY" }), siteOrigin: "https://jira.example", capabilityEvidence: fixtureCapabilities });
  await assert.rejects(() => missingApprovalActor.persistIntent(pendingIntent("g3-fixture-no-approval-0001")),
    /non-empty cutover approval reference/);
  assert.equal((await missingApprovalLedger.inspectRequest("g3-fixture-no-approval-0001")).pending, null);
  console.log("PASS: Intent gate without cutover approval reference fails before pending write");

  const intentRaceDir = join(root, "intent-entry-race");
  const intentRaceLedger = createG3FileLedger({ root: intentRaceDir, ledgerRef });
  let releaseIntentGate;
  const intentGateHeld = new Promise(resolve => { releaseIntentGate = resolve; });
  const intentRaceActor = createG3SupervisedAdapter({ ledger: intentRaceLedger,
    jira: fakeJira().jira, verifyGate: async input => {
      if (input.stage === "intent") await intentGateHeld;
      return gate(input);
    }, siteOrigin: "https://jira.example", capabilityEvidence: fixtureCapabilities });
  const firstIntent = intentRaceActor.persistIntent(pendingIntent("g3-fixture-intent-race-0001"));
  await assert.rejects(() => intentRaceActor.persistIntent(pendingIntent("g3-fixture-intent-race-0002")),
    /already has an Intent/);
  releaseIntentGate();
  assert.equal((await firstIntent).created_new, true);
  assert.equal((await intentRaceLedger.inspectRequest("g3-fixture-intent-race-0002")).pending, null);
  console.log("PASS: concurrent Intent entry is rejected while trusted gate is pending");

  const createRaceDir = join(root, "create-entry-race"), createRaceJira = fakeJira();
  const createRaceLedger = createG3FileLedger({ root: createRaceDir, ledgerRef });
  let releaseCreateGate;
  const createGateHeld = new Promise(resolve => { releaseCreateGate = resolve; });
  const createRaceActor = createG3SupervisedAdapter({ ledger: createRaceLedger,
    jira: createRaceJira.jira, verifyGate: async input => {
      if (input.stage === "create") await createGateHeld;
      return gate(input);
    }, siteOrigin: "https://jira.example", capabilityEvidence: fixtureCapabilities });
  await createRaceActor.persistIntent(pendingIntent("g3-fixture-create-race-0001"));
  const createRequest = { issue_type: "Task", summary: contract.Summary };
  const concurrentCreates = [createRaceActor.create(createRequest), createRaceActor.create(createRequest)];
  releaseCreateGate();
  const createResults = await Promise.allSettled(concurrentCreates);
  assert.equal(createRaceJira.calls(), 1, "two calls waiting at the gate must reserve only one Jira Create");
  assert.equal(createResults.filter(result => result.status === "fulfilled").length, 1);
  console.log("PASS: concurrent Create entry reserves one Jira Create before awaiting trusted gate");

  const mutableIntentDir = join(root, "mutable-intent");
  const mutableIntentJira = fakeJira({ wrongRead: true });
  const mutableIntentActor = createG3SupervisedAdapter({
    ledger: createG3FileLedger({ root: mutableIntentDir, ledgerRef }),
    jira: mutableIntentJira.jira, verifyGate: gate, siteOrigin: "https://jira.example", capabilityEvidence: fixtureCapabilities });
  const mutablePending = pendingIntent("g3-fixture-mutable-intent-0001");
  await mutableIntentActor.persistIntent(mutablePending);
  mutablePending.fields.customfield_10108.id = "10020";
  await mutableIntentActor.create({ issue_type: "Task", summary: contract.Summary });
  await assert.rejects(() => mutableIntentActor.read({ key: "RPL-201", fields: [] }),
    /inconsistent with the durable approved Intent/);
  console.log("PASS: caller mutation cannot change the adapter's approved Intent field snapshot");

  const raceDir = join(root, "race");
  const a = createG3FileLedger({ root: raceDir, ledgerRef });
  const b = createG3FileLedger({ root: raceDir, ledgerRef });
  const intent = { create_request_id: "g3-fixture-race-0001", ledger_ref: ledgerRef,
    status: "pending", approved_preview_id: "sha-fixture", activation_ref: "fixture-task-activation",
    cutover_approval_ref: "fixture-owner-approval",
    issue_type: "Task", issue_type_id: "10010", fields: { customfield_10108: { id: "10027" } } };
  const outcomes = await Promise.all([a.persistIntent(intent), b.persistIntent(intent)]);
  assert.equal(outcomes.filter(x => x.created_new).length, 1);
  console.log("PASS: concurrent file CAS allows one pending Intent");
  const forgedDir = join(root, "forged");
  const forged = createG3FileLedger({ root: forgedDir, ledgerRef });
  await assert.rejects(() => forged.persistIntent({
    ...intent, create_request_id: "g3-fixture-missing-approval-0001",
    cutover_approval_ref: "  ",
  }), /incomplete immutable pending Intent/);
  const stored = await forged.persistIntent({
    ...intent, create_request_id: "g3-fixture-forged-0001",
    fields: { customfield_10108: { id: "10027" },
      customfield_10109: { id: "10028" }, customfield_10110: [] },
  });
  assert.equal(stored.created_new, true);
  await forged.linkIssue("g3-fixture-forged-0001", {
    key: "RPL-202", url: "https://jira.example/browse/RPL-202",
  });
  await assert.rejects(() => forged.persistOrigin({
    create_request_id: "g3-fixture-forged-0001", issue_key: "RPL-202",
    ledger_ref: ledgerRef, create_activation_ref: "fixture-task-activation",
    cutover_approval_ref: "different-owner-approval", origin: "target_create",
    phase: "create_ready", read_authority: "target", write_authority: "target",
    legacy_snapshot_ref: "not_applicable",
    verified_fields: { customfield_10108: { id: "10027" },
      customfield_10109: { id: "10028" }, customfield_10110: [] },
  }), /Origin does not match/);
  await assert.rejects(() => forged.persistOrigin({
    create_request_id: "g3-fixture-forged-0001", issue_key: "RPL-202",
    ledger_ref: ledgerRef, create_activation_ref: "fixture-task-activation",
    cutover_approval_ref: "fixture-owner-approval", origin: "target_create",
    phase: "create_ready", read_authority: "target", write_authority: "target",
    legacy_snapshot_ref: "not_applicable",
    verified_fields: { customfield_10108: { id: "10020" },
      customfield_10109: { id: "10028" }, customfield_10110: [] },
  }), /Origin does not match/);
  assert.equal((await forged.readClassificationAuthority("RPL-202")).read_authority, "none");
  console.log("PASS: forged Origin Product option fails closed");

  const originFile = join(successDir, "origins",
    createHash("sha256").update("RPL-201", "utf8").digest("hex") + ".json");
  const persistedOrigin = JSON.parse(await readFile(originFile, "utf8"));
  await writeFile(originFile, JSON.stringify({ ...persistedOrigin,
    cutover_approval_ref: "different-owner-approval" }) + "\n", "utf8");
  assert.equal((await pass.ledger.readClassificationAuthority("RPL-201")).read_authority, "none");
  console.log("PASS: Reader quarantines an Origin approval reference that differs from pending Intent");
  await writeFile(originFile, JSON.stringify({ ...persistedOrigin, issue_type_id: "10007" }) + "\n", "utf8");
  assert.equal((await pass.ledger.readClassificationAuthority("RPL-201")).read_authority, "none");
  await writeFile(originFile, JSON.stringify({ ...persistedOrigin, origin_ref: "tampered-origin-ref" }) + "\n", "utf8");
  assert.equal((await pass.ledger.readClassificationAuthority("RPL-201")).read_authority, "none");
  console.log("PASS: Reader quarantines Ledger Origin Type ID and OriginRef tampering");


  console.log("G3 offline supervised Adapter/Origin Ledger fixtures passed");
} finally { await rm(root, { recursive: true, force: true }); }
