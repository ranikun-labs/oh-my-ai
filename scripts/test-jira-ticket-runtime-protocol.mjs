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
      customfield_10108: { required: true, allowedValues: [{ id: "10027", value: "dev-harness" }] },
      customfield_10109: { required: true, allowedValues: [{ id: "10028", value: "backend" }] },
      customfield_10110: { required: false, allowedValues: [{ id: "10038", value: "integration" }] },
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
function approvedTarget() {
  let s = startTarget();
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


console.log("jira-ticket runtime protocol fixtures passed");
