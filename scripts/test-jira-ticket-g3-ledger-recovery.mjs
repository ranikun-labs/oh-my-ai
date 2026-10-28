#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, open, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createG3FileLedger } from "./lib/jira-ticket-g3-file-ledger.mjs";
import { createG3LedgerRecovery } from "./lib/jira-ticket-g3-ledger-recovery.mjs";
import { g3EvidenceSha256 } from "./lib/jira-ticket-g3-trusted-gate.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trustedKeys = { "fixture-maintainer-key": publicKey.export({ type: "spki", format: "pem" }) };
const iso = value => new Date(value).toISOString();
const canonical = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
const envelope = payload => ({ key_id: "fixture-maintainer-key", payload: structuredClone(payload),
  signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64") });
const ledgerRef = "fixture-g3-recovery-ledger";
const siteOrigin = "https://jira.example";
let recoveryClock = Date.now();
const now = () => recoveryClock;
const targetFields = {
  customfield_10108: { id: "10027" },
  customfield_10109: { id: "10028" },
  customfield_10110: [],
};

function pending(requestId, fields = targetFields) {
  return { create_request_id: requestId, ledger_ref: ledgerRef, status: "pending",
    approved_preview_id: "d".repeat(64), activation_ref: "fixture-recovery-activation",
    cutover_approval_ref: "fixture-recovery-owner-approval", issue_type: "Task", issue_type_id: "10010", fields };
}
function immutableIntent(record) {
  return { create_request_id: record.create_request_id, ledger_ref: record.ledger_ref,
    status: record.status, approved_preview_id: record.approved_preview_id,
    activation_ref: record.activation_ref, cutover_approval_ref: record.cutover_approval_ref,
    issue_type: record.issue_type, issue_type_id: record.issue_type_id, fields: record.fields };
}
function authorization(record, issueKey, patch = {}) {
  return envelope({ kind: "g3_manual_recovery_authorization", status: "approved",
    action: "reconcile_existing_issue", authorization_ref: `maintainer-recovery-${record.create_request_id}`,
    create_request_id: record.create_request_id, ledger_ref: ledgerRef, issue_key: issueKey,
    activation_ref: record.activation_ref, cutover_approval_ref: record.cutover_approval_ref,
    issue_type: "Task", issue_type_id: "10010",
    pending_sha256: g3EvidenceSha256(immutableIntent(record)), fields_sha256: g3EvidenceSha256(record.fields),
    issued_at: iso(recoveryClock - 1_000), expires_at: iso(recoveryClock + 120_000), ...patch });
}
function jiraResult(key, patch = {}) {
  return { tool_call_count: 1, key, issue_type_id: "10010", fields: {
    customfield_10108: { id: "10027" }, customfield_10109: { id: "10028" }, customfield_10110: null,
  }, ...patch };
}
function makeRecovery({ root, ledger, jiraRead, clock = now, syncReceipt } = {}) {
  return createG3LedgerRecovery({ ledger, root, ledgerRef, jiraRead, trustedKeys,
    siteOrigin, now: clock, ...(syncReceipt ? { syncReceipt } : {}) });
}
const root = await mkdtemp(join(tmpdir(), "jira-g3-ledger-recovery-"));
try {
  const ledger = createG3FileLedger({ root, ledgerRef });
  const id = "g3-offline-recovery-request-0001";
  const request = pending(id);
  await ledger.persistIntent(request);
  let gets = 0;
  const jiraRead = async query => {
    gets++;
    assert.deepEqual(query, { key: "RPL-902", fields: ["issuetype", "customfield_10108", "customfield_10109", "customfield_10110"] });
    return jiraResult(query.key);
  };
  const recovery = makeRecovery({ root, ledger, jiraRead });
  const plan = await recovery.plan(id);
  assert.equal(plan.code, "CREATE_OUTCOME_UNKNOWN_NO_LINK");
  assert.equal(gets, 0, "plan must be read-only");
  assert.equal("create" in recovery, false, "recovery exposes no Jira Create function");
  const noAuthorization = await recovery.reconcile({ request_id: id });
  assert.equal(noAuthorization.code, "ISSUE_KEY_REQUIRED");
  assert.equal(gets, 0);
  console.log("PASS: recovery plan is read-only and cannot Create or guess an IssueKey");

  const auth = authorization(request, "RPL-902");
  const recoveryForSuccess = makeRecovery({ root, ledger, jiraRead });
  const reconciled = await recoveryForSuccess.reconcile({ request_id: id, authorization: auth });
  assert.equal(reconciled.code, "LINK_AND_ORIGIN_DURABLE");
  assert.equal(reconciled.jira_get_calls, 1);
  assert.equal(reconciled.jira_create_calls, 0);
  assert.equal(gets, 1);
  assert.equal((await ledger.inspectRequest(id)).link.issue_key, "RPL-902");
  const authority = await ledger.readClassificationAuthority("RPL-902");
  assert.equal(authority.read_authority, "target");
  assert.equal(authority.write_authority, "target");
  const secondCall = await recoveryForSuccess.reconcile({ request_id: id, authorization: auth });
  assert.equal(secondCall.code, "RECOVERY_ALREADY_ATTEMPTED");
  assert.equal(gets, 1, "same recovery instance must not retry after the one GET");
  console.log("PASS: one signed GET links and durably promotes an exact issue without any Jira write");

  const linkFile = join(root, "issue-links", createHash("sha256").update(id, "utf8").digest("hex") + ".json");
  await unlink(linkFile);
  const restoreLinkRecovery = makeRecovery({ root, ledger: createG3FileLedger({ root, ledgerRef }),
    jiraRead: async ({ key }) => jiraResult(key) });
  const restoredLink = await restoreLinkRecovery.reconcile({ request_id: id, authorization: auth });
  assert.equal(restoredLink.code, "LINK_RESTORED_FOR_EXISTING_ORIGIN");
  assert.equal((await createG3FileLedger({ root, ledgerRef }).inspectRequest(id)).link.issue_key, "RPL-902");
  console.log("PASS: matching durable Origin with a missing link is restored only after one verified Jira GET");

  // A new process can safely reconcile the exact existing durable Origin after restart.
  const restartedLedger = createG3FileLedger({ root, ledgerRef });
  let restartGets = 0;
  const restarted = makeRecovery({ root, ledger: restartedLedger, jiraRead: async ({ key }) => {
    restartGets++;
    return jiraResult(key);
  } });
  const replayed = await restarted.reconcile({ request_id: id, authorization: auth });
  assert.equal(replayed.code, "ALREADY_LINKED_AND_ORIGIN_VERIFIED");
  assert.equal(restartGets, 1);
  assert.equal((await restarted.plan(id)).code, "LINK_AND_ORIGIN_PRESENT");
  console.log("PASS: process restart recognizes and verifies an exact already-linked Origin idempotently");

  const originFilePath = join(root, "origins", createHash("sha256").update("RPL-902", "utf8").digest("hex") + ".json");
  let durabilityGetCalls = 0;
  const failOriginSync = async (filePath, directoryPath) => {
    if (filePath === originFilePath) throw new Error("synthetic Origin fsync failure");
    const file = await open(filePath, "r");
    try { await file.sync(); } finally { await file.close(); }
    const directory = await open(directoryPath, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const durabilityRecovery = makeRecovery({ root, ledger: restartedLedger,
    jiraRead: async ({ key }) => { durabilityGetCalls++; return jiraResult(key); },
    syncReceipt: failOriginSync });
  const durabilityFailure = await durabilityRecovery.reconcile({ request_id: id, authorization: auth });
  assert.equal(durabilityFailure.code, "DURABILITY_CONFIRMATION_FAILED");
  assert.equal(durabilityFailure.jira_get_calls, 1);
  assert.equal(durabilityGetCalls, 1);
  console.log("PASS: readable but unconfirmed Origin is not reported durable after an fsync failure");

  const unknownId = "g3-offline-recovery-request-0002";
  const unknownIntent = pending(unknownId);
  await restartedLedger.persistIntent(unknownIntent);
  let lostGetCalls = 0;
  const unknownRecovery = makeRecovery({ root, ledger: restartedLedger, jiraRead: async () => {
    lostGetCalls++;
    throw new Error("synthetic GET response lost");
  } });
  const unknown = await unknownRecovery.reconcile({ request_id: unknownId,
    authorization: authorization(unknownIntent, "RPL-903") });
  assert.equal(unknown.code, "JIRA_GET_UNKNOWN");
  assert.equal(unknown.jira_create_calls, 0);
  assert.equal(lostGetCalls, 1);
  assert.equal((await unknownRecovery.reconcile({ request_id: unknownId,
    authorization: authorization(unknownIntent, "RPL-903") })).code, "RECOVERY_ALREADY_ATTEMPTED");
  assert.equal(lostGetCalls, 1, "unknown outcome is not retried in the same process");
  assert.equal((await restartedLedger.inspectRequest(unknownId)).link, null);
  console.log("PASS: unknown Jira GET outcome is frozen with no retry and no Create");

  const mismatchId = "g3-offline-recovery-request-0003";
  const mismatchIntent = pending(mismatchId);
  await restartedLedger.persistIntent(mismatchIntent);
  let mismatchCalls = 0;
  const mismatchRecovery = makeRecovery({ root, ledger: restartedLedger, jiraRead: async ({ key }) => {
    mismatchCalls++;
    return jiraResult(key, { issue_type_id: "10007" });
  } });
  const mismatch = await mismatchRecovery.reconcile({ request_id: mismatchId,
    authorization: authorization(mismatchIntent, "RPL-904") });
  assert.equal(mismatch.code, "JIRA_GET_MISMATCH");
  assert.equal(mismatchCalls, 1);
  assert.equal((await restartedLedger.inspectRequest(mismatchId)).link, null);
  const mismatchTargetRecovery = makeRecovery({ root, ledger: restartedLedger, jiraRead: async ({ key }) =>
    jiraResult(key, { fields: { customfield_10108: { id: "10027" },
      customfield_10109: { id: "99999" }, customfield_10110: [] } }) });
  const mismatchTarget = await mismatchTargetRecovery.reconcile({ request_id: mismatchId,
    authorization: authorization(mismatchIntent, "RPL-904") });
  assert.equal(mismatchTarget.code, "JIRA_GET_MISMATCH");
  assert.equal((await restartedLedger.inspectRequest(mismatchId)).link, null);
  console.log("PASS: wrong type or target values cannot create link or Origin receipts");

  const badAuthRecovery = makeRecovery({ root, ledger: restartedLedger, jiraRead: async () => {
    throw new Error("authorization should fail before Jira GET");
  } });
  const wrongAuth = authorization(unknownIntent, "RPL-903", { cutover_approval_ref: "forged-owner-approval" });
  await assert.rejects(() => badAuthRecovery.reconcile({ request_id: unknownId, authorization: wrongAuth }), /authorization/i);
  console.log("PASS: recovery authorization must bind the exact durable Owner approval reference");

  const linkedId = "g3-offline-recovery-request-0004";
  const linkedIntent = pending(linkedId);
  await restartedLedger.persistIntent(linkedIntent);
  await restartedLedger.linkIssue(linkedId, { key: "RPL-905", url: `${siteOrigin}/browse/RPL-905` });
  const originDir = join(root, "origins");
  const originPath = join(originDir, createHash("sha256").update("RPL-905", "utf8").digest("hex") + ".json");
  await writeFile(originPath, "{ partial json", "utf8");
  const corruptRecovery = makeRecovery({ root, ledger: restartedLedger, jiraRead: async () => {
    throw new Error("corrupt ledger must stop before Jira GET");
  } });
  await assert.rejects(() => corruptRecovery.plan(linkedId), /corrupt G3 recovery ledger/i);
  await assert.rejects(() => corruptRecovery.reconcile({ request_id: linkedId,
    authorization: authorization(linkedIntent, "RPL-905") }), /corrupt G3 recovery ledger/i);
  console.log("PASS: partial JSON ledger records freeze recovery before any remote GET");

  const expiredId = "g3-offline-recovery-request-0005";
  const expiredIntent = pending(expiredId);
  await restartedLedger.persistIntent(expiredIntent);
  const expiredAuth = authorization(expiredIntent, "RPL-906", { expires_at: iso(recoveryClock) });
  let expiredGets = 0;
  const expiredRecovery = makeRecovery({ root, ledger: restartedLedger, jiraRead: async () => {
    expiredGets++;
    return jiraResult("RPL-906");
  } });
  await assert.rejects(() => expiredRecovery.reconcile({ request_id: expiredId, authorization: expiredAuth }), /expired/i);
  assert.equal(expiredGets, 0);
  console.log("PASS: expired manual recovery authorization is rejected before Jira GET");

  const slowId = "g3-offline-recovery-request-0007";
  const slowIntent = pending(slowId);
  await restartedLedger.persistIntent(slowIntent);
  const slowAuth = authorization(slowIntent, "RPL-907", { expires_at: iso(recoveryClock + 1_000) });
  const slowRecovery = makeRecovery({ root, ledger: restartedLedger, jiraRead: async ({ key }) => {
    recoveryClock += 1_000;
    return jiraResult(key);
  } });
  const slowResult = await slowRecovery.reconcile({ request_id: slowId, authorization: slowAuth });
  assert.equal(slowResult.code, "RECOVERY_AUTHORIZATION_EXPIRED_AFTER_GET");
  assert.equal((await restartedLedger.inspectRequest(slowId)).link, null);
  recoveryClock -= 1_000;
  console.log("PASS: recovery authorization is rechecked after Jira GET before ledger writes");

  const raceId = "g3-offline-recovery-request-0008";
  const raceIntent = pending(raceId);
  await restartedLedger.persistIntent(raceIntent);
  let releaseInspect;
  const heldInspect = new Promise(resolve => { releaseInspect = resolve; });
  const slowLedger = { ...restartedLedger, inspectRequest: async requestIdValue => {
    await heldInspect;
    return restartedLedger.inspectRequest(requestIdValue);
  } };
  let raceGets = 0;
  const raceRecovery = makeRecovery({ root, ledger: slowLedger, jiraRead: async ({ key }) => {
    raceGets++;
    return jiraResult(key);
  } });
  const raceAuth = authorization(raceIntent, "RPL-908");
  const firstRace = raceRecovery.reconcile({ request_id: raceId, authorization: raceAuth });
  const secondRace = await raceRecovery.reconcile({ request_id: raceId, authorization: raceAuth });
  assert.equal(secondRace.code, "RECOVERY_ALREADY_ATTEMPTED");
  releaseInspect();
  assert.equal((await firstRace).code, "LINK_AND_ORIGIN_DURABLE");
  assert.equal(raceGets, 1);
  console.log("PASS: concurrent recovery entry reserves the request before its first async ledger read");

  const brokenIntentId = "g3-offline-recovery-request-0006";
  const brokenIntentPath = join(root, "intents", createHash("sha256").update(brokenIntentId, "utf8").digest("hex") + ".json");
  await mkdir(join(root, "intents"), { recursive: true });
  await writeFile(brokenIntentPath, "{ partial pending", "utf8");
  await assert.rejects(() => restartedLedger.inspectRequest(brokenIntentId), SyntaxError);
  console.log("PASS: partial pending Intent JSON is never treated as an absent record");
  console.log("G3 ledger recovery offline fixtures passed");
} finally { await rm(root, { recursive: true, force: true }); }
