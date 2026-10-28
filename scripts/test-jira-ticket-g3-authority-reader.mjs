#!/usr/bin/env node
import assert from "node:assert/strict";
import { createG3AuthorityReader } from "./lib/jira-ticket-g3-authority-reader.mjs";

const TYPE_ID = "10010";
const legacyFields = {
  customfield_10042: [{ id: "legacy-product-1" }, { id: "legacy-product-4" }],
  customfield_10043: [{ id: "legacy-component-2" }, { id: "legacy-component-5" }],
  customfield_10044: [{ id: "legacy-label-3" }],
};
const targetFields = {
  customfield_10108: { id: "target-product-1" },
  customfield_10109: { id: "target-component-2" },
  customfield_10110: [{ id: "target-concern-3" }],
};

function header(issueKey, source, evidenceRef, status = "verified") {
  return { status, source, verified: true, issue_key: issueKey, evidence_ref: evidenceRef };
}

function legacyEvidence(issueKey, { fields = legacyFields, state = "staged" } = {}) {
  const manifestRef = `manifest:${issueKey}`;
  const historyRef = `history:${issueKey}`;
  const migrationRef = `migration:${issueKey}`;
  return {
    ...header(issueKey, "legacy_manifest_migration_history", `legacy-bundle:${issueKey}`),
    mode: "legacy_retained",
    manifest: { ...header(issueKey, "legacy_manifest", manifestRef), project: "RPL",
      issue_type: "Task", issue_type_id: TYPE_ID, fields: structuredClone(fields) },
    migration: { ...header(issueKey, "legacy_migration", migrationRef), state,
      classification_authority: "legacy", manifest_ref: manifestRef, history_ref: historyRef },
    history: { ...header(issueKey, "jira_issue_history", historyRef), issue_type: "Task",
      issue_type_id: TYPE_ID, manifest_ref: manifestRef, migration_ref: migrationRef,
      fields: structuredClone(fields) },
  };
}

function notLegacy(issueKey) {
  return header(issueKey, "legacy_manifest_migration_history", `no-legacy:${issueKey}`, "not_legacy");
}

function migratedTargetEvidence(issueKey, { fields = targetFields } = {}) {
  const cutoverRef = `cutover:${issueKey}`;
  const snapshotRef = `snapshot:${issueKey}`;
  return {
    ...header(issueKey, "legacy_manifest_migration_history", `migration-bundle:${issueKey}`),
    mode: "migrated_target",
    cutover: header(issueKey, "owner_cutover", cutoverRef, "approved"),
    snapshot: { ...header(issueKey, "target_migration_snapshot", snapshotRef),
      issue_type: "Task", issue_type_id: TYPE_ID, fields: structuredClone(fields) },
    parity: { ...header(issueKey, "migration_parity", `parity:${issueKey}`),
      origin: "legacy_migration", snapshot_ref: snapshotRef, cutover_ref: cutoverRef,
      issue_type: "Task", issue_type_id: TYPE_ID },
  };
}

function targetResult(overrides = {}) {
  return {
    origin: "target_create", phase: "create_ready", read_authority: "target",
    write_authority: "target", issue_type: "Task", source: "jira_get_and_durable_origin",
    product: structuredClone(targetFields.customfield_10108),
    component: structuredClone(targetFields.customfield_10109),
    concern: structuredClone(targetFields.customfield_10110),
    ...overrides,
  };
}

function legacyGet(issueKey, { fields = legacyFields, key = issueKey, typeId = TYPE_ID,
  type = "Task", calls = 1 } = {}) {
  const currentFields = structuredClone(fields);
  for (const field of ["customfield_10042", "customfield_10043"])
    if (Array.isArray(currentFields[field])) currentFields[field].reverse();
  return { key, issue_type_id: typeId, issue_type: type, tool_call_count: calls,
    fields: currentFields };
}

function dependencies({ evidenceFor, targetFor, jiraFor, calls = {} } = {}) {
  return {
    resolveLegacyEvidence: async request => {
      calls.legacyResolve = (calls.legacyResolve ?? 0) + 1;
      assert.deepEqual(Object.keys(request).sort(), ["issue_key"]);
      return evidenceFor(request.issue_key);
    },
    targetReader: { async readVerifiedClassification(issueKey) {
      calls.targetRead = (calls.targetRead ?? 0) + 1;
      return targetFor(issueKey);
    } },
    jira: { async read(request) {
      calls.jiraRead = (calls.jiraRead ?? 0) + 1;
      calls.lastJiraFields = request.fields;
      return jiraFor(request.key);
    } },
    calls,
  };
}

function reader(options) {
  return createG3AuthorityReader(options);
}

assert.throws(() => createG3AuthorityReader({}), /requires a supervised Target reader/);

{
  const d = dependencies({ evidenceFor: key => legacyEvidence(key),
    targetFor: () => { throw new Error("Legacy path should not call Target"); },
    jiraFor: key => legacyGet(key) });
  const result = await reader(d).readClassification("RPL-201");
  assert.equal(result.read_authority, "legacy");
  assert.equal(result.write_authority, "frozen");
  assert.equal(result.phase, "migration_staged");
  assert.equal(result.classification.authority, "legacy");
  assert.deepEqual(result.classification.fields.customfield_10042,
    [{ id: "legacy-product-1" }, { id: "legacy-product-4" }]);
  assert.deepEqual(result.classification.fields.customfield_10043,
    [{ id: "legacy-component-2" }, { id: "legacy-component-5" }]);
  assert.deepEqual(result.legacy_evidence.jira_get_parity, "verified");
  assert.deepEqual(d.calls.lastJiraFields, ["issuetype", "customfield_10042",
    "customfield_10043", "customfield_10044"]);
  assert.equal(d.calls.targetRead ?? 0, 0);
}
console.log("PASS: explicit Legacy manifest, staged migration, history, and Jira GET parity classify as frozen Legacy");

{
  const d = dependencies({ evidenceFor: notLegacy,
    targetFor: () => ({ origin: "UNKNOWN_ORIGIN", phase: "create_quarantined",
      read_authority: "none", write_authority: "frozen" }),
    jiraFor: () => { throw new Error("No Legacy proof means no Legacy parity GET"); } });
  const result = await reader(d).readClassification("RPL-202");
  assert.equal(result.read_authority, "none");
  assert.equal(result.origin, "UNKNOWN_ORIGIN");
  assert.equal(d.calls.jiraRead ?? 0, 0);
  assert.equal(d.calls.targetRead, 1);
}
console.log("PASS: no Legacy evidence plus UNKNOWN Target remains UNKNOWN; no fallback GET");

{
  const d = dependencies({ evidenceFor: notLegacy, targetFor: () => targetResult(),
    jiraFor: () => { throw new Error("Target GET parity is owned by the supervised Adapter"); } });
  const result = await reader(d).readClassification("RPL-203");
  assert.equal(result.read_authority, "target");
  assert.equal(result.write_authority, "target");
  assert.equal(result.classification.fields.customfield_10108.id, "target-product-1");
  assert.equal(d.calls.jiraRead ?? 0, 0);
}
console.log("PASS: Target classification is exposed only from the supervised Origin + GET method");

{
  const d = dependencies({ evidenceFor: notLegacy,
    targetFor: () => ({ origin: "UNKNOWN_ORIGIN", phase: "create_quarantined",
      read_authority: "none", write_authority: "frozen" }),
    jiraFor: () => legacyGet("RPL-204") });
  const result = await reader(d).readClassification("RPL-204");
  assert.equal(result.read_authority, "none");
  assert.equal(d.calls.jiraRead ?? 0, 0,
    "UNKNOWN Target must not trigger a Legacy fallback by probing current Jira fields");
}
console.log("PASS: UNKNOWN Target Origin never falls back to Legacy without explicit Legacy proof");

{
  const issueKey = "RPL-205";
  const d = dependencies({ evidenceFor: key => legacyEvidence(key), targetFor: () => null,
    jiraFor: key => legacyGet(key, { key: "RPL-999" }) });
  const result = await reader(d).readClassification(issueKey);
  assert.equal(result.read_authority, "none");
  assert.equal(result.reason, "legacy_jira_parity_unverified");
}
console.log("PASS: Jira GET key mismatch quarantines Legacy classification");

for (const [name, mutate] of [
  ["type", evidence => { evidence.history.issue_type = "Bug"; evidence.history.issue_type_id = "10012"; }],
  ["manifest option", evidence => { evidence.history.fields.customfield_10042[1].id = "other-product"; }],
  ["missing source proof", evidence => { delete evidence.migration.evidence_ref; }],
  ["migration state", evidence => { evidence.migration.state = "unknown"; }],
]) {
  const d = dependencies({ evidenceFor: key => {
    const evidence = legacyEvidence(key);
    mutate(evidence);
    return evidence;
  }, targetFor: () => { throw new Error("Malformed Legacy proof must not fall through"); },
  jiraFor: key => legacyGet(key) });
  const result = await reader(d).readClassification("RPL-206");
  assert.equal(result.read_authority, "none", name);
  assert.equal(d.calls.jiraRead ?? 0, 0, name);
}
console.log("PASS: mismatched type/options, missing source metadata, and invalid migration state fail closed");

for (const [name, jiraOptions] of [
  ["type id", { typeId: "10012" }],
  ["option id", { fields: { ...legacyFields,
    customfield_10042: [{ id: "legacy-product-1" }, { id: "different-product" }] } }],
  ["duplicate multiselect option", { fields: { ...legacyFields,
    customfield_10043: [{ id: "duplicate" }, { id: "duplicate" }] } }],
]) {
  const d = dependencies({ evidenceFor: key => legacyEvidence(key), targetFor: () => null,
    jiraFor: key => legacyGet(key, jiraOptions) });
  const result = await reader(d).readClassification("RPL-207");
  assert.equal(result.read_authority, "none", name);
}
console.log("PASS: Jira GET type and option mismatches quarantine Legacy classification");

for (const [name, resultValue] of [
  ["key", targetResult({ issue_key: "RPL-999" })],
  ["type id", targetResult({ issue_type_id: "10012" })],
  ["duplicate option", targetResult({ concern: [{ id: "dup" }, { id: "dup" }] })],
  ["raw Ledger data", targetResult({ source: undefined })],
  ["malformed status", targetResult({ phase: "create_quarantined" })],
]) {
  const d = dependencies({ evidenceFor: notLegacy, targetFor: () => resultValue,
    jiraFor: () => null });
  const result = await reader(d).readClassification("RPL-208");
  assert.equal(result.read_authority, "none", name);
}
console.log("PASS: mismatched Target identity, type, options, and status fail closed");

{
  const d = dependencies({ evidenceFor: key => migratedTargetEvidence(key),
    targetFor: () => targetResult({ origin: "legacy_migration", phase: "cutover" }),
    jiraFor: () => { throw new Error("Migrated Target parity comes from verified migration source"); } });
  const result = await reader(d).readClassification("RPL-209");
  assert.equal(result.read_authority, "target");
  assert.equal(result.origin, "legacy_migration");
  assert.equal(result.phase, "cutover");
  assert.equal(result.migration_evidence.parity, "parity:RPL-209");
}
console.log("PASS: migrated Target requires and accepts separate approved cutover, snapshot, and parity sources");

{
  const d = dependencies({ evidenceFor: key => {
    const evidence = migratedTargetEvidence(key);
    delete evidence.cutover.evidence_ref;
    return evidence;
  }, targetFor: () => targetResult({ origin: "legacy_migration", phase: "cutover" }), jiraFor: () => null });
  const result = await reader(d).readClassification("RPL-210");
  assert.equal(result.read_authority, "none");
  assert.equal(d.calls.targetRead ?? 0, 0, "invalid migration source must quarantine without Target promotion");
}
console.log("PASS: migrated Target without separately verifiable sources remains quarantined");

{
  const d = dependencies({ evidenceFor: key => migratedTargetEvidence(key),
    targetFor: () => targetResult({ origin: "legacy_migration", phase: "create_ready" }),
    jiraFor: () => null });
  const result = await reader(d).readClassification("RPL-212");
  assert.equal(result.read_authority, "none");
  assert.equal(result.reason, "migrated_target_evidence_unverified");
}
console.log("PASS: migrated Target with create_ready phase is quarantined");

{
  const d = dependencies({ evidenceFor: key => legacyEvidence(key),
    targetFor: () => targetResult(), jiraFor: key => legacyGet(key) });
  const actor = reader(d);
  const result = await actor.readClassification("RPL-211", legacyEvidence("RPL-211"));
  assert.equal(result.read_authority, "legacy");
  assert.equal(d.calls.legacyResolve, 1, "only the injected resolver can supply evidence");
}
console.log("PASS: read methods ignore caller-supplied evidence and use only the injected source resolver");

{
  const calls = {};
  const d = dependencies({ evidenceFor: key => legacyEvidence(key), targetFor: () => targetResult(),
    jiraFor: key => legacyGet(key), calls });
  const actor = reader(d);
  for (const key of ["RPL-112", "RPL-113", "RPL-114", "RPL-122", "RPL-124"]) {
    const result = await actor.readClassification(key);
    assert.equal(result.read_authority, "none");
    assert.equal(result.write_authority, "frozen");
    assert.equal(result.reason, "protected_issue_key");
  }
  assert.equal(calls.legacyResolve ?? 0, 0);
  assert.equal(calls.targetRead ?? 0, 0);
  assert.equal(calls.jiraRead ?? 0, 0);
}
console.log("PASS: protected migration issues are frozen before any source lookup, regardless of proof");

{
  const d = dependencies({ evidenceFor: key => {
    if (key === "RPL-220") return legacyEvidence(key);
    return notLegacy(key);
  }, targetFor: key => key === "RPL-222"
    ? { origin: "UNKNOWN_ORIGIN", read_authority: "none", write_authority: "frozen",
      phase: "create_quarantined" } : targetResult(),
  jiraFor: key => legacyGet(key) });
  const view = await reader(d).projectReadOnlyView(["RPL-220", "RPL-221", "RPL-222"]);
  assert.equal(view.read_only, true);
  assert.equal(view.aggregate.total, 3);
  assert.equal(view.aggregate.classified_count, 2);
  assert.equal(view.aggregate.unknown_count, 1);
  assert.deepEqual(view.aggregate.by_authority, { legacy: 1, target: 1 });
  assert.equal(view.items[2].read_authority, "none");
  assert.equal(Object.hasOwn(view, "board_updated"), false);
  assert.equal(Object.hasOwn(view, "filter_updated"), false);
  assert.equal(Object.hasOwn(view, "automation_updated"), false);
}
console.log("PASS: read-only projection excludes UNKNOWN from classified aggregate counts and makes no configuration claims");

{
  const d = dependencies({ evidenceFor: async () => { throw new Error("offline source"); },
    targetFor: () => targetResult(), jiraFor: () => null });
  const result = await reader(d).readClassification("RPL-230");
  assert.equal(result.read_authority, "none");
  assert.equal(result.reason, "legacy_evidence_unavailable");
  assert.equal(d.calls.targetRead ?? 0, 0);
}
console.log("PASS: source exceptions return safe UNKNOWN without using unverified metadata");

{
  const d = dependencies({ evidenceFor: notLegacy, targetFor: async () => { throw new Error("offline target"); },
    jiraFor: () => null });
  const result = await reader(d).readClassification("RPL-231");
  assert.equal(result.read_authority, "none");
  assert.equal(result.reason, "target_evidence_unavailable");
}
console.log("PASS: adapter exceptions return safe UNKNOWN");

{
  const d = dependencies({ evidenceFor: key => legacyEvidence(key), targetFor: () => null,
    jiraFor: async () => { throw new Error("offline Jira"); } });
  const result = await reader(d).readClassification("RPL-232");
  assert.equal(result.read_authority, "none");
  assert.equal(result.reason, "legacy_jira_parity_unverified");
}
console.log("PASS: Jira parity exceptions return safe UNKNOWN");

{
  const d = dependencies({ evidenceFor: () => new Proxy({}, {
    getPrototypeOf() { throw new Error("malformed external metadata"); },
  }), targetFor: () => targetResult(), jiraFor: () => null });
  const result = await reader(d).readClassification("RPL-233");
  assert.equal(result.read_authority, "none");
  assert.equal(result.reason, "legacy_evidence_unverified");
  assert.equal(d.calls.targetRead ?? 0, 0);
}
console.log("PASS: malformed evidence object exceptions fail closed without Target fallback");

console.log("All G3 authority reader fixtures passed (offline synthetic evidence only).");
