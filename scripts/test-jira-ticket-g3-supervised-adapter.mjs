#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_FIELDS, runJiraTicketCreateWorkflow } from "./lib/jira-ticket-create-workflow.mjs";
import { createG3FileLedger } from "./lib/jira-ticket-g3-file-ledger.mjs";
import { createG3SupervisedAdapter } from "./lib/jira-ticket-g3-supervised-adapter.mjs";

// All actors, approvals, metadata and Jira IssueKeys below are SYNTHETIC.
// Nothing in this file connects to Atlassian or writes to production systems.
const ledgerRef = "fixture-g3-single-writer-ledger";
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
function fakeJira({ throwCreate = false, throwOrigin = false, wrongRead = false } = {}) {
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
      return { tool_call_count: 1, key: request.key, issue_type_id: "10010",
        fields: { customfield_10108: { id: wrongRead ? "10020" : "10027" },
          customfield_10109: { id: "10028" }, customfield_10110: [] } };
    },
  };
  return { jira, calls: () => createCalls };
}
const gate = async () => ({ allowed: true, evidence_ref: "SYNTHETIC-TEST-ONLY" });
const execution = async ({ root, target, simulation, customGate = gate, ledgerOverride } = {}) => {
  const ledger = ledgerOverride ?? createG3FileLedger({ root, ledgerRef });
  const actor = createG3SupervisedAdapter({ ledger, jira: simulation.jira,
    verifyGate: customGate, siteOrigin: "https://jira.example" });
  const report = await runJiraTicketCreateWorkflow({ adapter: actor,
    contract, metadata: { ...metadata, target_create: target ?? config() },
    approval: { current: true } });
  return { ledger, report, actor };
};
const root = await mkdtemp(join(tmpdir(), "jira-g3-offline-"));
try {
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
  console.log("PASS: durable Intent > exactly-once Create > IssueKey link > GET > Origin/Reader");

  const readerTamper = createG3SupervisedAdapter({ ledger: pass.ledger,
    jira: fakeJira({ wrongRead: true }).jira, verifyGate: gate, siteOrigin: "https://jira.example" });
  assert.equal((await readerTamper.readVerifiedClassification("RPL-201")).read_authority, "none");
  assert.equal((await readerTamper.readClassificationAuthority("RPL-201")).read_authority, "none",
    "public Reader alias must not expose raw Ledger authority");
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

  const raceDir = join(root, "race");
  const a = createG3FileLedger({ root: raceDir, ledgerRef });
  const b = createG3FileLedger({ root: raceDir, ledgerRef });
  const intent = { create_request_id: "g3-fixture-race-0001", ledger_ref: ledgerRef,
    status: "pending", approved_preview_id: "sha-fixture", activation_ref: "fixture-task-activation",
    issue_type: "Task", fields: { customfield_10108: { id: "10027" } } };
  const outcomes = await Promise.all([a.persistIntent(intent), b.persistIntent(intent)]);
  assert.equal(outcomes.filter(x => x.created_new).length, 1);
  console.log("PASS: concurrent file CAS allows one pending Intent");
  const forgedDir = join(root, "forged");
  const forged = createG3FileLedger({ root: forgedDir, ledgerRef });
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
    cutover_approval_ref: "fixture-owner-approval", origin: "target_create",
    phase: "create_ready", read_authority: "target", write_authority: "target",
    legacy_snapshot_ref: "not_applicable",
    verified_fields: { customfield_10108: { id: "10020" },
      customfield_10109: { id: "10028" }, customfield_10110: [] },
  }), /Origin does not match/);
  assert.equal((await forged.readClassificationAuthority("RPL-202")).read_authority, "none");
  console.log("PASS: forged Origin Product option fails closed");


  console.log("G3 offline supervised Adapter/Origin Ledger fixtures passed");
} finally { await rm(root, { recursive: true, force: true }); }
