#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  CONTRACT_FIELDS,
  applyJiraCreateResult,
  applyJiraIntentResult,
  applyJiraReadResult,
  applyJiraOriginResult,
  applyJiraPreviewApproval,
  applyJiraSearchResult,
  beginJiraTicketCreateWorkflow,
  runJiraTicketCreateWorkflow,
} from "./lib/jira-ticket-create-workflow.mjs";
import { normalizeJiraRuntimeResult } from "./lib/jira-ticket-runtime-normalization.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/jira-ticket/runtime-protocol-fixtures.json", import.meta.url), "utf8"));
const contract = Object.fromEntries(CONTRACT_FIELDS.map((field) => [field, field === "Summary" ? "Runtime protocol ticket" : `Verified ${field}`]));
const metadata = { project: "RPL", issue_type: "Task", assignee: "Park", priority: "High", product: "Dev Harness", repository: "aixion1506/oh-my-ai", area: "Jira Workflow", branch: "feat/RPL-21", pr: "#75", current_head: "4a6f967" };
const capabilities = { "jira.search": { available: true, connection_verified: true }, "jira.create": { available: true, connection_verified: true } };
const runtimeEvidence = { jira_site_origin: "https://jira.example", adapter: "codex" };
const searchNone = { status: "none", tool_call_count: 1 };

function previewState(overrides = {}) {
  let step = beginJiraTicketCreateWorkflow({ runtime: "codex", contract: { ...contract, ...(overrides.contract ?? {}) }, metadata: { ...metadata, ...(overrides.metadata ?? {}) }, capabilities: overrides.capabilities ?? capabilities, runtime_evidence: runtimeEvidence });
  assert.equal(step.required_action?.type, "jira.search_required");
  step = applyJiraSearchResult(step.state, overrides.search ?? searchNone);
  assert.equal(step.required_action?.type, "preview_required");
  return step;
}

function createRequestFromSnapshot(snapshot) {
  const description = [
    `Product: ${snapshot.product}`,
    `Primary Repository: ${snapshot.primary_repository}`,
    `Area: ${snapshot.area}`,
    `Assignee: ${snapshot.assignee}`,
    `Priority: ${snapshot.priority}`,
    `Branch: ${snapshot.branch}`,
    `PR: ${snapshot.pr}`,
    `Current HEAD: ${snapshot.current_head}`,
    "",
    ...CONTRACT_FIELDS.map((field) => `## ${field}\n${snapshot.contract[field]}`),
  ].join("\n");
  return {
    project: snapshot.project,
    issue_type: snapshot.issue_type,
    summary: snapshot.contract.Summary,
    description,
    assignee: snapshot.assignee,
    priority: snapshot.priority,
    labels: snapshot.labels,
  };
}

function invokeRuntime(input) {
  const cli = spawnSync(process.execPath, ["scripts/oh-my-ai.mjs", "jira-ticket", "--json", JSON.stringify(input)], { encoding: "utf8" });
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stderr);
  return JSON.parse(cli.stdout);
}
let entry = invokeRuntime({ event: "start", runtime: "codex", contract, metadata, capabilities, runtime_evidence: runtimeEvidence });
assert.equal(entry.required_action.type, "jira.search_required");
entry = invokeRuntime({ event: "search_result", state: entry.state, result: searchNone });
assert.equal(entry.required_action.type, "preview_required");
entry = invokeRuntime({ event: "approval", state: entry.state, approval: { status: "approved", preview_id: entry.state.preview_id } });
assert.equal(entry.required_action.type, "jira.create_required");
entry = invokeRuntime({ event: "create_result", state: entry.state, result: { kind: "created", tool_call_count: 1, key: "RPL-1", url: "https://jira.example/browse/RPL-1", project: "RPL", summary: contract.Summary } });
assert.equal(entry.report.verification_status, "verified");
console.log("passed: canonical-runtime-entry-runs-all-core-stages");

let step = previewState();
let approved = applyJiraPreviewApproval(step.state, { status: "approved", preview_id: step.state.preview_id });
assert.equal(approved.required_action?.type, "jira.create_required");
assert.deepEqual(approved.required_action.request, {
  project: "RPL", issue_type: "Task", summary: "Runtime protocol ticket",
  description: approved.required_action.request.description, assignee: "Park", priority: "High", labels: [],
});
for (const field of CONTRACT_FIELDS) assert.ok(approved.required_action.request.description.includes(`## ${field}\n`), `description missing ${field}`);
console.log("passed: approved-current-preview-emits-one-create-action");

const snapshotRequestFixture = fixture.approval_snapshot_request;
step = previewState({ metadata: snapshotRequestFixture.metadata });
const currentSnapshot = structuredClone(step.state.preview);
const jsonRoundTrippedState = JSON.parse(JSON.stringify(step.state));
approved = applyJiraPreviewApproval(jsonRoundTrippedState, { status: "approved", preview_id: jsonRoundTrippedState.preview_id });
assert.deepEqual(approved.required_action?.request, snapshotRequestFixture.expected, snapshotRequestFixture.id);
assert.deepEqual(approved.required_action?.request, createRequestFromSnapshot(currentSnapshot), `${snapshotRequestFixture.id}: request uses the exact current Snapshot`);
const currentSnapshotCreate = applyJiraCreateResult(approved.state, { kind: "created", tool_call_count: 1, key: "RPL-31", url: "https://jira.example/browse/RPL-31", project: "RPL", summary: currentSnapshot.contract.Summary });
assert.equal(currentSnapshotCreate.report.create_call_count, 1, `${snapshotRequestFixture.id}: exactly one Create result`);
assert.equal(currentSnapshotCreate.report.verification_status, "verified", `${snapshotRequestFixture.id}: current snapshot remains verifiable`);
console.log(`passed: ${snapshotRequestFixture.id}`);

const approvalA = { status: "approved", preview_id: step.state.preview_id };
for (const [name, mutate] of [
  ["contract-stale", (state) => { state.contract.Summary = "Contract B"; }],
  ["metadata-stale", (state) => { state.metadata.priority = "Low"; }],
  ["labels-replaced-stale", (state) => { state.metadata.labels = ["b"]; }],
  ["labels-added-stale", (state) => { state.metadata.labels = ["a", "b"]; }],
  ["labels-removed-stale", (state) => { state.metadata.labels = []; }],
  ["search-stale", (state) => { state.search = { status: "none", tool_call_count: 1, observed_at: "changed" }; }],
]) {
  step = previewState(name.startsWith("labels-") ? { metadata: { labels: ["a"] } } : {});
  const currentApproval = { status: "approved", preview_id: step.state.preview_id };
  mutate(step.state);
  const result = applyJiraPreviewApproval(step.state, currentApproval);
  assert.equal(result.required_action, null, name);
  assert.equal(result.report.create_attempted, false, name);
  assert.equal(result.report.create_call_count, 0, name);
  assert.equal(result.report.mutation_status, "0", name);
  assert.equal(result.report.verification_status, "not_verifiable", name);
  assert.equal(result.report.allowed_next_step, "현재 Preview를 다시 승인", name);
  console.log(`passed: ${name}`);
}
for (const [name, mutate] of [
  ["preview-contract-only-tamper", (preview) => { preview.contract.Summary = "Tampered summary"; }],
  ["preview-labels-only-tamper", (preview) => { preview.labels = ["b"]; }],
  ["preview-contract-and-labels-tamper", (preview) => { preview.contract.Summary = "Tampered summary"; preview.labels = ["b"]; }],
]) {
  step = previewState({ metadata: { labels: ["a"] } });
  const currentApproval = { status: "approved", preview_id: step.state.preview_id };
  mutate(step.state.preview);
  const result = applyJiraPreviewApproval(step.state, currentApproval);
  assert.equal(result.required_action, null, name);
  assert.equal(result.report.create_attempted, false, name);
  assert.equal(result.report.create_call_count, 0, name);
  assert.equal(result.report.mutation_status, "0", name);
  assert.equal(result.report.verification_status, "not_verifiable", name);
  assert.equal(result.report.allowed_next_step, "현재 Preview를 다시 승인", name);
  console.log(`passed: ${name}`);
}
const labelOrderA = previewState({ metadata: { labels: ["b", "a", "a", " "] } });
const labelOrderB = previewState({ metadata: { labels: ["a", "b"] } });
assert.equal(labelOrderA.state.preview_id, labelOrderB.state.preview_id, "label order and duplicates are canonicalized");
approved = applyJiraPreviewApproval(labelOrderA.state, { status: "approved", preview_id: labelOrderA.state.preview_id });
assert.deepEqual(approved.required_action.request.labels, ["a", "b"]);
const currentLabelCreate = applyJiraCreateResult(approved.state, { kind: "created", tool_call_count: 1, key: "RPL-30", url: "https://jira.example/browse/RPL-30", project: "RPL", summary: contract.Summary });
assert.equal(currentLabelCreate.report.create_call_count, 1, "current label snapshot permits exactly one Create result");
console.log("passed: labels-canonical-order-and-current-snapshot");

const differentContract = previewState({ contract: { Summary: "Different contract" } });
step = previewState();
let staleReuse = applyJiraPreviewApproval(step.state, { status: "approved", preview_id: differentContract.state.preview_id });
assert.equal(staleReuse.required_action, null);
const differentMetadata = previewState({ metadata: { priority: "Low" } });
staleReuse = applyJiraPreviewApproval(step.state, { status: "approved", preview_id: differentMetadata.state.preview_id });
assert.equal(staleReuse.required_action, null);
console.log("passed: other-contract-and-metadata-approval-reuse-blocked");

step = previewState({ metadata: { labels: ["a"] } });
approved = applyJiraPreviewApproval(step.state, { status: "approved", preview_id: step.state.preview_id });
const approvedRequest = structuredClone(approved.required_action.request);
step.state.metadata.labels = ["b"];
step.state.metadata.priority = "Low";
step.state.contract.Summary = "Mutable replacement";
assert.deepEqual(approved.required_action.request, approvedRequest, "approved request is detached from mutable state");
console.log("passed: approved-request-is-snapshot-derived");
for (const approval of [{ status: "approved" }, { status: "approved", preview_id: "wrong" }]) {
  step = previewState();
  const result = applyJiraPreviewApproval(step.state, approval);
  assert.equal(result.required_action, null);
  assert.equal(result.report.create_call_count, 0);
  assert.equal(result.report.allowed_next_step, "현재 Preview를 다시 승인");
}
console.log("passed: missing-and-wrong-preview-id");

let searchOnly = beginJiraTicketCreateWorkflow({ runtime: "claude", contract, metadata, capabilities: { "jira.search": { available: true, connection_verified: true }, "jira.create": { available: false, connection_verified: false } }, runtime_evidence: runtimeEvidence });
searchOnly = applyJiraSearchResult(searchOnly.state, { status: "none", tool_call_count: 1 });
assert.equal(searchOnly.report.search_attempted, true);
assert.equal(searchOnly.report.create_call_count, 0);
assert.match(searchOnly.report.allowed_next_step, /Create capability/);
console.log("passed: search-only-reuses-search-before-create-block");
for (const [name, status, duplicate] of [["search-only-exact", "exact_duplicate", "exact"], ["search-only-similar", "similar", "similar"]]) {
  let result = beginJiraTicketCreateWorkflow({ runtime: "claude", contract, metadata, capabilities: { "jira.search": { available: true, connection_verified: true }, "jira.create": { available: false, connection_verified: false } }, runtime_evidence: runtimeEvidence });
  result = applyJiraSearchResult(result.state, { status, tool_call_count: 1, issue: { key: "RPL-20", url: "https://jira.example/browse/RPL-20" } });
  assert.equal(result.report.duplicate_status, duplicate, name);
  assert.equal(result.report.create_call_count, 0, name);
  console.log(`passed: ${name}`);
}
const wrongProject = beginJiraTicketCreateWorkflow({ runtime: "codex", contract, metadata: { ...metadata, project: "ABC" }, capabilities, runtime_evidence: runtimeEvidence });
assert.equal(wrongProject.report.verification_status, "not_verifiable");
assert.equal(wrongProject.report.allowed_next_step, "Project를 RPL로 수정");
console.log("passed: wrong-project-is-not-capability-error");
for (const sentinel of ["Not Verifiable", "not verifiable", "NOT VERIFIABLE", "  Not Verifiable  "]) {
  const result = beginJiraTicketCreateWorkflow({ runtime: "codex", contract, metadata: { ...metadata, assignee: sentinel }, capabilities, runtime_evidence: runtimeEvidence });
  assert.equal(result.report.create_call_count, 0, sentinel);
  assert.deepEqual(result.report.missing_metadata, ["Assignee"], sentinel);
}
console.log("passed: metadata-sentinel-case-insensitive");

const invalidResults = {
  "abc-key": { kind: "created", tool_call_count: 1, key: "ABC-1", url: "https://jira.example/browse/ABC-1", project: "RPL", summary: contract.Summary },
  "url-key-mismatch": { kind: "created", tool_call_count: 1, key: "RPL-1", url: "https://jira.example/browse/RPL-2", project: "RPL", summary: contract.Summary },
  "invalid-key": { kind: "created", tool_call_count: 1, key: "RPL-0", url: "https://jira.example/browse/RPL-0", project: "RPL", summary: contract.Summary },
  "invalid-host": { kind: "created", tool_call_count: 1, key: "RPL-1", url: "https://wrong.example/browse/RPL-1", project: "RPL", summary: contract.Summary },
  "key-only": { kind: "created", tool_call_count: 1, key: "RPL-1", project: "RPL", summary: contract.Summary },
  "url-only": { kind: "created", tool_call_count: 1, url: "https://jira.example/browse/RPL-1", project: "RPL", summary: contract.Summary },
  "summary-mismatch": { kind: "created", tool_call_count: 1, key: "RPL-1", url: "https://jira.example/browse/RPL-1", project: "RPL", summary: "Other" },
  "project-mismatch": { kind: "created", tool_call_count: 1, key: "RPL-1", url: "https://jira.example/browse/RPL-1", project: "ABC", summary: contract.Summary },
};
for (const [name, created] of Object.entries(invalidResults)) {
  step = previewState();
  approved = applyJiraPreviewApproval(step.state, { status: "approved", preview_id: step.state.preview_id });
  const result = applyJiraCreateResult(approved.state, created);
  assert.equal(result.report.mutation_status, "possibly_applied", name);
  assert.equal(result.report.verification_status, "not_verifiable", name);
  assert.equal(result.report.automatic_retry, false, name);
  assert.equal(result.report.actual_issue_key, created.key ?? null, name);
  assert.equal(result.report.actual_issue_url, created.url ?? null, name);
  console.log(`passed: ${name}`);
}
step = previewState();
approved = applyJiraPreviewApproval(step.state, { status: "approved", preview_id: step.state.preview_id });
const verified = applyJiraCreateResult(approved.state, { kind: "created", tool_call_count: 1, key: "RPL-1", url: "https://jira.example/browse/RPL-1", project: "RPL", summary: contract.Summary });
assert.equal(verified.report.mutation_status, "applied");
assert.equal(verified.report.verification_status, "verified");
console.log("passed: verified-issue-identity");

assert.deepEqual(fixture.required_action_types, ["jira.search_required", "preview_required", "jira.create_required"]);
assert.equal(snapshotRequestFixture.id, "approved-current-snapshot-create-request");
assert.deepEqual(fixture.minor_cases, ["search-only-exact", "search-only-similar", "wrong-project", "metadata-sentinel-case-insensitive"]);
for (const scenario of fixture.normalization_cases) {
  const actual = normalizeJiraRuntimeResult(scenario.runtime, scenario.operation, scenario.raw);
  assert.deepEqual(actual, scenario.expected, scenario.id);
  console.log(`passed: ${scenario.id}`);
}
const codexSearch = normalizeJiraRuntimeResult("codex", "search", { toolCallCount: 1, outcome: "none" });
const claudeSearch = normalizeJiraRuntimeResult("claude", "search", { calls: [{}], result: { status: "none" } });
assert.deepEqual(codexSearch, claudeSearch, "search results share Core semantic schema");
const issue = { key: "RPL-1", url: "https://jira.example/browse/RPL-1", project: "RPL", summary: contract.Summary };
const codexCreate = normalizeJiraRuntimeResult("codex", "create", { toolCallCount: 1, issue });
const claudeCreate = normalizeJiraRuntimeResult("claude", "create", { calls: [{}], createdIssue: issue });
assert.deepEqual(codexCreate, claudeCreate, "create results share Core semantic schema");

/* Target Create is opt-in; these are local synthetic protocol fixtures only.
 * No Jira calls, Admin changes, or G3 activation occur in this test. */
const targetFixtureNow = Date.now(); // frozen fixture clock; no Jira interaction
const targetConfig = () => ({
  mode: "single_supervised",
  request_id: "g3-fixture-request-0001",
  ledger_ref: "fixtures/target-ledger.json",
  readiness: { reader: true, board: true, automation: true, rollback: true, ledger: true },
  cutover: {
    status: "approved", approval_ref: "fixture-only-owner-approval",
    activation_ref: "fixture-only-g3-activation",
    effective_from: new Date(targetFixtureNow - 3600_000).toISOString(), effective_to: new Date(targetFixtureNow + 3600_000).toISOString(),
    request_time: new Date(targetFixtureNow).toISOString(), rollback_ref: "fixture-only-rollback",
  },
  create_metadata: {
    source: "live_jira_create_metadata", project: "RPL", issue_type: "Task", issue_type_id: "10010",
    observed_at: new Date(targetFixtureNow - 300_000).toISOString(),
    fields: {
      customfield_10042: { required: false, hasDefaultValue: false },
      customfield_10043: { required: false, hasDefaultValue: false },
      customfield_10044: { required: false, hasDefaultValue: false },
      customfield_10015: { required: true, hasDefaultValue: false, schema: { type: "date" } },
      duedate: { required: true, hasDefaultValue: false, schema: { type: "date" } },
      customfield_10045: { required: false, hasDefaultValue: false, schema: { type: "array", items: "user" } },
      customfield_10108: { required: true, hasDefaultValue: false,
        schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" }, allowedValues: [{ id: "10027", value: "dev-harness" }] },
      customfield_10109: { required: true, hasDefaultValue: false,
        schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" }, allowedValues: [{ id: "10028", value: "backend" }] },
      customfield_10110: { required: false, hasDefaultValue: false,
        schema: { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" }, allowedValues: [{ id: "10038", value: "integration" }] },
    },
  },
  selection: {
    product: { id: "10027", value: "dev-harness" },
    component: { id: "10028", value: "backend" },
    concerns: [{ id: "10038", value: "integration" }],
  },
  supplemental_fields: { customfield_10015: "2030-01-01", duedate: "2030-01-02" },
});
const targetCapabilities = {
  ...capabilities,
  "jira.read": { available: true, connection_verified: true },
  "jira.intent.persist": { available: true, connection_verified: true },
  "jira.origin.persist": { available: true, connection_verified: true },
};
function startTarget(config = targetConfig(), caps = targetCapabilities) {
  return beginJiraTicketCreateWorkflow({
    runtime: "codex", contract, metadata: { ...metadata, target_create: config },
    capabilities: caps, runtime_evidence: runtimeEvidence,
  });
}
function approvedTarget(config = targetConfig()) {
  let s = startTarget(config);
  assert.equal(s.required_action.type, "jira.search_required");
  s = applyJiraSearchResult(s.state, searchNone);
  assert.equal(s.required_action.type, "preview_required");
  s = applyJiraPreviewApproval(s.state, { status: "approved", preview_id: s.state.preview_id });
  assert.equal(s.required_action.type, "jira.intent_persist_required");
  assert.equal(s.report.create_attempted, false);
  return s;
}
function storedIntent(s) {
  const t = s.state.approved_snapshot.target_create;
  return applyJiraIntentResult(s.state, { status: "persisted", durable: true, tool_call_count: 1,
    create_request_id: t.request_id, ledger_ref: t.ledger_ref, created_new: true,
    approved_preview_id: s.state.preview_id, activation_ref: t.cutover.activation_ref });
}
function fakeIssueResult() {
  return { kind: "created", tool_call_count: 1, key: "RPL-201",
    url: "https://jira.example/browse/RPL-201", project: "RPL", summary: contract.Summary };
}
function verifiedTargetRead() {
  return { tool_call_count: 1, key: "RPL-201", issue_type_id: "10010",
    fields: {
      customfield_10108: { id: "10027" }, customfield_10109: { id: "10028" },
      customfield_10110: [{ id: "10038" }],
    } };
}
let blockedTarget = startTarget({ ...targetConfig(), cutover: { ...targetConfig().cutover, status: "pending" } });
assert.equal(blockedTarget.required_action, null);
assert.equal(blockedTarget.report.create_attempted, false);
blockedTarget = startTarget({ ...targetConfig(), selection: { ...targetConfig().selection,
  product: { id: "99999", value: "dev-harness" } } });
assert.equal(blockedTarget.required_action, null, "unknown Product option must stop before search");
blockedTarget = startTarget({ ...targetConfig(), create_metadata: { ...targetConfig().create_metadata,
  fields: { ...targetConfig().create_metadata.fields, customfield_10042: { required: true, hasDefaultValue: false } } } });
assert.equal(blockedTarget.required_action, null, "Legacy Required must block Target Create");
blockedTarget = startTarget(targetConfig(), capabilities);
assert.equal(blockedTarget.required_action, null, "Target persistence capabilities must be verified");
blockedTarget = startTarget({ ...targetConfig(), selection: { ...targetConfig().selection,
  concerns: [targetConfig().selection.concerns[0], targetConfig().selection.concerns[0]] } });
assert.equal(blockedTarget.required_action, null, "duplicate Concern IDs forbidden");
let metadataChanged = startTarget();
metadataChanged.state.metadata.target_create.selection.product.id = "99999";
metadataChanged = applyJiraSearchResult(metadataChanged.state, searchNone);
assert.equal(metadataChanged.required_action, null, "Target metadata changed between Search stages");
let spoofedTime = startTarget({ ...targetConfig(), cutover: {
  ...targetConfig().cutover, request_time: "2030-01-01T12:00:00Z" } });
assert.equal(spoofedTime.required_action, null, "untrusted caller time cannot be the activation clock");
console.log("passed: target-g3-eligibility-fails-closed");

let tg = approvedTarget();
const currentTargetApproval = tg.state.preview_id;
tg.state.metadata.target_create.selection.product.id = "10020";
let denied = applyJiraPreviewApproval(tg.state, { status: "approved", preview_id: currentTargetApproval });
assert.equal(denied.required_action, null, "Target mutation must invalidate approval");
tg = approvedTarget();
const missingIntent = applyJiraIntentResult(tg.state, { status: "persisted", durable: false, tool_call_count: 1,
  create_request_id: tg.state.approved_snapshot.target_create.request_id, ledger_ref: "fixtures/target-ledger.json" });
assert.equal(missingIntent.required_action, null);
assert.equal(missingIntent.report.create_attempted, false, "no Jira Create without durable Intent");
console.log("passed: target-preview-and-intent-guards");

tg = approvedTarget();
tg = storedIntent(tg);
assert.equal(tg.required_action.type, "jira.create_required");
assert.deepEqual(tg.required_action.request.fields, {
  customfield_10108: { id: "10027" }, customfield_10109: { id: "10028" },
  customfield_10110: [{ id: "10038" }], customfield_10015: "2030-01-01", duedate: "2030-01-02",
});
assert.equal(tg.required_action.request.fields.customfield_10042, undefined);
assert.equal(tg.required_action.request.fields.customfield_10043, undefined);
assert.equal(tg.required_action.request.fields.customfield_10044, undefined);
tg = applyJiraCreateResult(tg.state, fakeIssueResult());
assert.equal(tg.required_action.type, "jira.read_required");
assert.notEqual(tg.report.verification_status, "verified", "Create identity alone is not Target verification");
assert.equal(tg.report.mutation_status, "possibly_applied", "After a real Create the mutation must not read zero");
tg = applyJiraReadResult(tg.state, verifiedTargetRead());
assert.equal(tg.required_action.type, "jira.origin_persist_required");
assert.equal(tg.report.verification_status, "not_verifiable");
tg = applyJiraOriginResult(tg.state, { status: "persisted", durable: true, tool_call_count: 1,
  issue_key: "RPL-201", create_request_id: targetConfig().request_id, ledger_ref: targetConfig().ledger_ref,
  phase: "create_ready", read_authority: "target", write_authority: "target",
  cutover_approval_ref: targetConfig().cutover.approval_ref,
  create_activation_ref: targetConfig().cutover.activation_ref, origin: "target_create" });
assert.equal(tg.required_action, null);
assert.equal(tg.report.verification_status, "verified");
assert.equal(tg.report.target_create_status, "create_ready");
assert.equal(tg.report.read_authority, "target");
console.log("passed: target-durable-intent-create-read-origin-success");

tg = storedIntent(approvedTarget());
tg = applyJiraCreateResult(tg.state, fakeIssueResult());
let badRead = verifiedTargetRead();
badRead.fields.customfield_10108.id = "10020";
tg = applyJiraReadResult(tg.state, badRead);
assert.equal(tg.required_action, null);
assert.equal(tg.report.origin_status, "UNKNOWN_ORIGIN");
assert.equal(tg.report.read_authority, "none");
assert.equal(tg.report.write_authority, "frozen");
assert.equal(tg.report.automatic_retry, false);
tg = storedIntent(approvedTarget());
tg = applyJiraCreateResult(tg.state, fakeIssueResult());
tg = applyJiraReadResult(tg.state, verifiedTargetRead());
tg = applyJiraOriginResult(tg.state, { status: "timeout", durable: false });
assert.equal(tg.report.origin_status, "UNKNOWN_ORIGIN");
assert.equal(tg.report.verification_status, "not_verifiable");
tg = storedIntent(approvedTarget());
tg.state.target_mode = false;
tg = applyJiraCreateResult(tg.state, fakeIssueResult());
assert.equal(tg.required_action, null);
assert.equal(tg.report.origin_status, "UNKNOWN_ORIGIN", "target flag must not permit Legacy verified bypass");
assert.equal(tg.report.mutation_status, "possibly_applied");
console.log("passed: target-uncertain-result-quarantine-no-auto-retry");

// The JSON/CLI semantic bridge must preserve intermediate Target stage identity.
tg = approvedTarget();
let roundTripped = invokeRuntime({ event: "intent_result", state: JSON.parse(JSON.stringify(tg.state)),
  result: { status: "persisted", durable: true, tool_call_count: 1,
    create_request_id: targetConfig().request_id, ledger_ref: targetConfig().ledger_ref,
    created_new: true, approved_preview_id: tg.state.preview_id,
    activation_ref: targetConfig().cutover.activation_ref } });
assert.equal(roundTripped.required_action.type, "jira.create_required");
console.log("passed: target-runtime-bridge-intent-event");
tg = approvedTarget();
const repeatedApproval = applyJiraPreviewApproval(tg.state, { status: "approved", preview_id: tg.state.preview_id });
assert.equal(repeatedApproval.required_action, null, "duplicated approval must not issue another Intent");
tg = approvedTarget();
let failedIntent = applyJiraIntentResult(tg.state, { status: "timeout" });
assert.equal(failedIntent.required_action, null);
let repeatedIntent = applyJiraIntentResult(failedIntent.state, { status: "persisted", durable: true, tool_call_count: 1,
  create_request_id: targetConfig().request_id, ledger_ref: targetConfig().ledger_ref });
assert.equal(repeatedIntent.required_action, null, "blocked Intent cannot resume to Create");
tg = approvedTarget();
let mismatchedReceipt = applyJiraIntentResult(tg.state, { status: "persisted", durable: true, tool_call_count: 1,
  create_request_id: targetConfig().request_id, ledger_ref: targetConfig().ledger_ref,
  approved_preview_id: "unapproved-preview", activation_ref: targetConfig().cutover.activation_ref, created_new: true });
assert.equal(mismatchedReceipt.required_action, null, "Intent must match approved Preview SHA");
tg = approvedTarget();
let reusedIntent = applyJiraIntentResult(tg.state, {
  status: "persisted", durable: true, created_new: false, prior_issue_key: "RPL-201", tool_call_count: 1,
  create_request_id: targetConfig().request_id, ledger_ref: targetConfig().ledger_ref,
  approved_preview_id: tg.state.preview_id, activation_ref: targetConfig().cutover.activation_ref,
});
assert.equal(reusedIntent.required_action, null, "reusing an existing request ID must not create twice");
assert.equal(reusedIntent.report.create_attempted, false);
console.log("passed: target-replayed-approval-and-intent-blocked");

let corrupted = storedIntent(approvedTarget());
delete corrupted.state.approved_snapshot;
let malformedResult = applyJiraCreateResult(corrupted.state, fakeIssueResult());
assert.equal(malformedResult.required_action, null);
assert.equal(malformedResult.report.origin_status, "UNKNOWN_ORIGIN");
assert.equal(malformedResult.report.mutation_status, "possibly_applied");

corrupted = storedIntent(approvedTarget());
corrupted = applyJiraCreateResult(corrupted.state, fakeIssueResult());
delete corrupted.state.created_issue;
malformedResult = applyJiraReadResult(corrupted.state, verifiedTargetRead());
assert.equal(malformedResult.required_action, null);
assert.equal(malformedResult.report.origin_status, "UNKNOWN_ORIGIN");

corrupted = storedIntent(approvedTarget());
corrupted = applyJiraCreateResult(corrupted.state, fakeIssueResult());
corrupted = applyJiraReadResult(corrupted.state, verifiedTargetRead());
delete corrupted.state.created_issue;
malformedResult = applyJiraOriginResult(corrupted.state, { status: "persisted", durable: true });
assert.equal(malformedResult.required_action, null);
assert.equal(malformedResult.report.origin_status, "UNKNOWN_ORIGIN");
console.log("passed: incomplete-Target-protocol-state-fails-closed");




let adapterSteps = [];
const workingTargetAdapter = {
  runtime: "codex", capabilities: targetCapabilities, runtime_evidence: runtimeEvidence,
  async search() { adapterSteps.push("search"); return searchNone; },
  async persistIntent(request) {
    adapterSteps.push("intent");
    return { status: "persisted", durable: true, created_new: true, tool_call_count: 1,
      create_request_id: request.create_request_id, ledger_ref: request.ledger_ref,
      approved_preview_id: request.approved_preview_id, activation_ref: request.activation_ref };
  },
  async create(request) {
    adapterSteps.push("create");
    assert.equal(request.fields.customfield_10108.id, "10027");
    return fakeIssueResult();
  },
  async read() { adapterSteps.push("read"); return verifiedTargetRead(); },
  async persistOrigin(request) {
    adapterSteps.push("origin");
    return { status: "persisted", durable: true, tool_call_count: 1,
      issue_key: request.issue_key, create_request_id: request.create_request_id,
      ledger_ref: request.ledger_ref, phase: request.phase, read_authority: request.read_authority,
      write_authority: request.write_authority, origin: request.origin,
      cutover_approval_ref: request.cutover_approval_ref,
      create_activation_ref: request.create_activation_ref };
  },
};
let fullTarget = await runJiraTicketCreateWorkflow({
  adapter: workingTargetAdapter, contract,
  metadata: { ...metadata, target_create: targetConfig() }, approval: { current: true },
});
assert.deepEqual(adapterSteps, ["search", "intent", "create", "read", "origin"]);
assert.equal(fullTarget.verification_status, "verified");
assert.equal(fullTarget.mutation_status, "applied");

adapterSteps = [];
fullTarget = await runJiraTicketCreateWorkflow({
  adapter: { ...workingTargetAdapter, async persistIntent(request) {
    adapterSteps.push("intent"); throw new Error("store unavailable");
  } },
  contract, metadata: { ...metadata, target_create: targetConfig() },
  approval: { current: true },
});
assert.deepEqual(adapterSteps, ["search", "intent"], "Intent failure must block Create");
assert.equal(fullTarget.create_attempted, false);

adapterSteps = [];
fullTarget = await runJiraTicketCreateWorkflow({
  adapter: { ...workingTargetAdapter, async persistOrigin(request) {
    adapterSteps.push("origin"); throw new Error("ledger timeout");
  } },
  contract, metadata: { ...metadata, target_create: targetConfig() },
  approval: { current: true },
});
assert.deepEqual(adapterSteps, ["search", "intent", "create", "read", "origin"]);
assert.equal(fullTarget.origin_status, "UNKNOWN_ORIGIN");
assert.equal(fullTarget.mutation_status, "possibly_applied");
assert.equal(fullTarget.automatic_retry, false);
console.log("passed: full-Target-adapter-simulation-and-failures");

// Independent review regressions: synthetic states never invoke Jira.
for (const [name, mutate] of [
  ["legacy-default-contradiction", c => { c.create_metadata.fields.customfield_10042.defaultValue = [{ id: "unapproved" }]; }],
  ["supplemental-default-missing", c => { c.create_metadata.fields.duedate.hasDefaultValue = true; delete c.supplemental_fields.duedate; }],
  ["supplemental-default-malformed", c => { c.create_metadata.fields.duedate.hasDefaultValue = true; c.create_metadata.fields.duedate.defaultValue = "2030-02-30"; delete c.supplemental_fields.duedate; }],
  ["supplemental-default-contradiction", c => { c.create_metadata.fields.customfield_10045.defaultValue = [{ accountId: "unapproved" }]; }],
  ["target-default-present", c => { c.create_metadata.fields.customfield_10108.hasDefaultValue = true; }],
  ["target-default-unknown", c => { delete c.create_metadata.fields.customfield_10109.hasDefaultValue; }],
  ["target-schema-missing", c => { delete c.create_metadata.fields.customfield_10108.schema; }],
  ["target-schema-wrong", c => { c.create_metadata.fields.customfield_10109.schema.type = "array"; }],
  ["concern-schema-wrong", c => { c.create_metadata.fields.customfield_10110.schema.items = "string"; }],
  ["type-id-missing", c => { delete c.create_metadata.issue_type_id; }],
  ["supplemental-schema-missing", c => { delete c.create_metadata.fields.duedate.schema; }],
  ["supplemental-metadata-missing", c => { delete c.create_metadata.fields.customfield_10045; }],
  ["required-date-missing", c => { delete c.supplemental_fields.duedate; }],
  ["required-people-missing", c => { c.create_metadata.fields.customfield_10045.required = true; }],
  ["supplemental-date-invalid", c => { c.supplemental_fields.duedate = "2030-02-30"; }],
  ["supplemental-people-invalid", c => { c.supplemental_fields.customfield_10045 = "unverified-user"; }],
]) {
  const config = targetConfig(); mutate(config);
  const blocked = startTarget(config);
  assert.equal(blocked.required_action, null, name);
  assert.equal(blocked.report.create_attempted, false, name);
}
const unsupportedConfig = targetConfig();
unsupportedConfig.create_metadata.issue_type = "Story";
delete unsupportedConfig.create_metadata.issue_type_id;
const unsupported = beginJiraTicketCreateWorkflow({ runtime: "codex", contract,
  metadata: { ...metadata, issue_type: "Story", target_create: unsupportedConfig },
  capabilities: targetCapabilities, runtime_evidence: runtimeEvidence });
assert.equal(unsupported.required_action, null, "unsupported type plus missing ID must not compare undefined === undefined");
const explicitPeople = targetConfig();
explicitPeople.create_metadata.fields.customfield_10045.required = true;
explicitPeople.supplemental_fields.customfield_10045 = [{ accountId: "fixture-only-account" }];
assert.equal(startTarget(explicitPeople).required_action.type, "jira.search_required");
const actualDefaults = targetConfig();
actualDefaults.create_metadata.fields.customfield_10045 = {
  required: true, hasDefaultValue: true, schema: { type: "array", items: "user" },
  defaultValue: [{ accountId: "fixture-default-account" }],
};
actualDefaults.create_metadata.fields.duedate.hasDefaultValue = true;
actualDefaults.create_metadata.fields.duedate.defaultValue = "2030-01-02";
delete actualDefaults.supplemental_fields.duedate;
assert.equal(startTarget(actualDefaults).required_action.type, "jira.search_required", "actual valid defaults are evidence, not merely hasDefaultValue flags");
let changedProject = startTarget();
changedProject.state.metadata.project = "OTHER";
changedProject = applyJiraSearchResult(changedProject.state, searchNone);
assert.equal(changedProject.required_action, null, "caller project must still match live RPL metadata after Search");
assert.equal(changedProject.report.create_attempted, false);
console.log("passed: target-real-schema-default-and-required-input-boundaries");

const actualNow = Date.now;
try {
  Date.now = () => targetFixtureNow;
  for (const [name, configure] of [
    ["expired-backdated-request", c => {
      c.cutover.effective_to = new Date(targetFixtureNow - 120_000).toISOString();
      c.cutover.request_time = new Date(targetFixtureNow - 180_000).toISOString();
    }],
    ["future-postdated-request", c => {
      c.cutover.effective_from = new Date(targetFixtureNow + 120_000).toISOString();
      c.cutover.request_time = new Date(targetFixtureNow + 180_000).toISOString();
    }],
    ["stale-metadata-backdated-request", c => {
      c.cutover.request_time = new Date(targetFixtureNow - 180_000).toISOString();
      c.create_metadata.observed_at = new Date(targetFixtureNow - 3700_000).toISOString();
    }],
  ]) {
    const config = targetConfig(); configure(config);
    assert.equal(startTarget(config).required_action, null, name);
  }
  let expiredIntent = approvedTarget();
  Date.now = () => targetFixtureNow + 3600_001;
  expiredIntent = storedIntent(expiredIntent);
  assert.equal(expiredIntent.required_action, null, "activation must still cover actual clock immediately before Create");
  assert.equal(expiredIntent.report.create_attempted, false);
} finally { Date.now = actualNow; }
console.log("passed: actual-clock-activation-and-metadata-expiry");

for (const [name, mutate] of [
  ["valid-selection-replaced", s => {
    s.metadata.target_create.selection.product = { id: "10020", value: "carelog" };
    s.metadata.target_create.create_metadata.fields.customfield_10108.allowedValues.push({ id: "10020", value: "carelog" });
  }],
  ["fresh-metadata-replaced", s => { s.metadata.target_create.create_metadata.observed_at = new Date(targetFixtureNow - 1_000).toISOString(); }],
  ...["jira.search", "jira.create", "jira.intent.persist", "jira.read", "jira.origin.persist"]
    .map(capability => ["capability-lost-" + capability, s => {
      s.capabilities = structuredClone(s.capabilities); s.capabilities[capability].connection_verified = false;
    }]),
]) {
  let changed = approvedTarget(); mutate(changed.state);
  changed = storedIntent(changed);
  assert.equal(changed.required_action, null, name);
  assert.equal(changed.report.create_attempted, false, name);
}
for (const stage of ["create", "read", "origin"]) {
  let changed = storedIntent(approvedTarget());
  if (stage !== "create") changed = applyJiraCreateResult(changed.state, fakeIssueResult());
  if (stage === "origin") changed = applyJiraReadResult(changed.state, verifiedTargetRead());
  changed.state.approved_snapshot.target_create.selection.product.id = "10020";
  const result = stage === "create" ? applyJiraCreateResult(changed.state, fakeIssueResult())
    : stage === "read" ? applyJiraReadResult(changed.state, verifiedTargetRead())
      : applyJiraOriginResult(changed.state, { status: "persisted", durable: true });
  assert.equal(result.required_action, null, stage + " Snapshot changed");
  assert.equal(result.report.origin_status, "UNKNOWN_ORIGIN", stage);
  assert.equal(result.report.mutation_status, "possibly_applied", stage);
  assert.notEqual(result.report.verification_status, "verified", stage);
}
let wrongSite = storedIntent(approvedTarget());
wrongSite.state.runtime_evidence = { jira_site_origin: "https://forged.example" };
wrongSite = applyJiraCreateResult(wrongSite.state, { ...fakeIssueResult(), url: "https://forged.example/browse/RPL-201" });
assert.equal(wrongSite.report.origin_status, "UNKNOWN_ORIGIN");
for (const stage of ["read", "origin"]) {
  for (const change of ["key", "url"]) {
    let current = storedIntent(approvedTarget());
    current = applyJiraCreateResult(current.state, fakeIssueResult());
    if (stage === "origin") current = applyJiraReadResult(current.state, verifiedTargetRead());
    if (change === "key") current.state.created_issue.key = "RPL-202";
    else current.state.created_issue.url = "https://jira.example/browse/RPL-202";
    const read = verifiedTargetRead(); read.key = current.state.created_issue.key;
    const result = stage === "read" ? applyJiraReadResult(current.state, read)
      : applyJiraOriginResult(current.state, { status: "persisted", durable: true, tool_call_count: 1,
        issue_key: current.state.created_issue.key, create_request_id: targetConfig().request_id,
        ledger_ref: targetConfig().ledger_ref, phase: "create_ready", read_authority: "target", write_authority: "target",
        cutover_approval_ref: targetConfig().cutover.approval_ref,
        create_activation_ref: targetConfig().cutover.activation_ref, origin: "target_create" });
    assert.equal(result.required_action, null, stage + " identity " + change);
    assert.equal(result.report.origin_status, "UNKNOWN_ORIGIN");
    assert.equal(result.report.actual_issue_key, "RPL-201");
  }
}
console.log("passed: approved-snapshot-and-capabilities-stay-fixed-across-stages");

const emptyConcernConfig = () => { const c = targetConfig(); c.selection.concerns = []; return c; };
for (const [name, actual, omit] of [
  ["missing-concern", undefined, true], ["undefined-concern", undefined, false],
  ["object-concern", {}, false], ["string-concern", "", false],
  ["invalid-concern-option", [{ id: 10038 }], false], ["null-concern-option", [null], false],
]) {
  let current = storedIntent(approvedTarget(emptyConcernConfig()));
  current = applyJiraCreateResult(current.state, fakeIssueResult());
  const read = verifiedTargetRead();
  if (omit) delete read.fields.customfield_10110; else read.fields.customfield_10110 = actual;
  const quarantined = applyJiraReadResult(current.state, read);
  assert.equal(quarantined.report.origin_status, "UNKNOWN_ORIGIN", name);
  assert.equal(quarantined.required_action, null, name);
}
for (const empty of [null, []]) {
  let current = storedIntent(approvedTarget(emptyConcernConfig()));
  current = applyJiraCreateResult(current.state, fakeIssueResult());
  const read = verifiedTargetRead(); read.fields.customfield_10110 = empty;
  current = applyJiraReadResult(current.state, read);
  assert.equal(current.required_action.type, "jira.origin_persist_required");
  assert.deepEqual(current.required_action.request.verified_fields.customfield_10110, []);
  assert.equal(Object.hasOwn(current.required_action.request.verified_fields, "customfield_10015"), false);
  assert.equal(Object.hasOwn(current.required_action.request.verified_fields, "duedate"), false);
}
console.log("passed: read-requires-present-concern-and-origin-claims-only-read-fields");

console.log("jira-ticket runtime protocol fixtures passed");
