import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { g3EvidenceSha256, verifyG3SignedEvidence } from "./jira-ticket-g3-trusted-gate.mjs";
import { g3FileOriginRef } from "./jira-ticket-g3-file-ledger.mjs";

const KEY = /^RPL-[1-9][0-9]*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const TYPE_IDS = { Task: "10010", Epic: "10007", Feature: "10009", Bug: "10012", Research: "10013" };
const TARGET_FIELDS = ["customfield_10108", "customfield_10109", "customfield_10110"];
const digest = value => createHash("sha256").update(value, "utf8").digest("hex");

function sameTargets(intentFields, observedFields) {
  if (!intentFields || !observedFields || typeof observedFields !== "object"
    || !Object.hasOwn(observedFields, TARGET_FIELDS[2])
    || (observedFields[TARGET_FIELDS[2]] !== null && !Array.isArray(observedFields[TARGET_FIELDS[2]]))
    || TARGET_FIELDS.slice(0, 2).some(id => typeof intentFields[id]?.id !== "string"
      || typeof observedFields[id]?.id !== "string")) return false;
  const norm = value => Array.isArray(value) ? value.map(item => item?.id).sort()
    : value?.id;
  const concerns = intentFields[TARGET_FIELDS[2]] ?? [];
  const observedConcerns = observedFields[TARGET_FIELDS[2]] ?? [];
  if (!Array.isArray(concerns) || observedConcerns.some(item => typeof item?.id !== "string")) return false;
  return TARGET_FIELDS.every(id => JSON.stringify(norm(intentFields[id] ?? (id === TARGET_FIELDS[2] ? [] : undefined)))
    === JSON.stringify(norm(observedFields[id] ?? (id === TARGET_FIELDS[2] ? [] : undefined))));
}

function immutableIntent(pending) {
  return {
    create_request_id: pending.create_request_id,
    ledger_ref: pending.ledger_ref,
    status: pending.status,
    approved_preview_id: pending.approved_preview_id,
    activation_ref: pending.activation_ref,
    cutover_approval_ref: pending.cutover_approval_ref,
    issue_type: pending.issue_type,
    issue_type_id: pending.issue_type_id,
    fields: pending.fields,
  };
}

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("corrupt G3 recovery ledger record; reconciliation frozen");
  }
}

async function syncFileAndParentDirectory(filePath, directoryPath) {
  const file = await open(filePath, "r");
  try { await file.sync(); } finally { await file.close(); }
  const directory = await open(directoryPath, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

function validLink(link, requestId, siteOrigin) {
  if (!link || link.create_request_id !== requestId || !KEY.test(link.issue_key ?? "")
    || typeof link.issue_url !== "string" || !link.issue_url.trim()) return false;
  try {
    const url = new URL(link.issue_url);
    return url.origin === siteOrigin && url.pathname === `/browse/${link.issue_key}`;
  } catch { return false; }
}

function normalizedTargetIds(fields) {
  return {
    product: fields?.customfield_10108?.id ?? null,
    component: fields?.customfield_10109?.id ?? null,
    concerns: (fields?.customfield_10110 ?? []).map(value => value?.id).sort(),
  };
}

function validOriginFields(fields) {
  return Boolean(fields && typeof fields === "object"
    && Object.keys(fields).sort().join("|") === TARGET_FIELDS.slice().sort().join("|")
    && TARGET_FIELDS.slice(0, 2).every(id => typeof fields[id]?.id === "string"
      && Object.keys(fields[id]).join("|") === "id")
    && Array.isArray(fields[TARGET_FIELDS[2]])
    && fields[TARGET_FIELDS[2]].every(value => typeof value?.id === "string"
      && Object.keys(value).join("|") === "id"));
}

function originMatches(origin, pending, requestId, key, verifiedFields) {
  return Boolean(origin && origin.create_request_id === requestId && origin.issue_key === key
    && origin.ledger_ref === pending.ledger_ref && origin.create_activation_ref === pending.activation_ref
    && origin.cutover_approval_ref === pending.cutover_approval_ref && origin.origin === "target_create"
    && origin.issue_type === pending.issue_type && origin.issue_type_id === pending.issue_type_id
    && origin.origin_ref === g3FileOriginRef({ ledger_ref: pending.ledger_ref,
      create_request_id: requestId, issue_key: key, issue_type_id: pending.issue_type_id })
    && origin.phase === "create_ready" && origin.read_authority === "target"
    && origin.write_authority === "target" && origin.legacy_snapshot_ref === "not_applicable"
    && validOriginFields(origin.verified_fields)
    && sameTargets(pending.fields, origin.verified_fields)
    && sameTargets(pending.fields, verifiedFields)
    && g3EvidenceSha256(normalizedTargetIds(origin.verified_fields))
      === g3EvidenceSha256(normalizedTargetIds(verifiedFields)));
}

/**
 * Offline, manually authorized reconciliation for the existing file ledger.
 * The only remote dependency accepted is one Jira GET function; this module has
 * no Create/search/Admin method and never retries a failed GET in one run.
 */
export function createG3LedgerRecovery({ ledger, root, ledgerRef, jiraRead, trustedKeys,
  siteOrigin, now = Date.now, syncReceipt = syncFileAndParentDirectory }) {
  if (!ledger || typeof ledger.inspectRequest !== "function" || typeof ledger.linkIssue !== "function"
    || typeof ledger.persistOrigin !== "function" || typeof root !== "string" || !root.trim()
    || typeof ledgerRef !== "string" || !ledgerRef.trim() || typeof jiraRead !== "function"
    || !trustedKeys || typeof now !== "function" || typeof syncReceipt !== "function")
    throw new Error("G3 recovery requires the existing file Ledger, trusted manual authorization, and Jira GET only");
  try {
    const site = new URL(siteOrigin);
    if (site.protocol !== "https:" || site.origin !== siteOrigin || site.pathname !== "/") throw new Error();
  } catch { throw new Error("verified HTTPS Jira site origin required for recovery link receipts"); }
  const originDir = join(resolve(root), "origins");
  const intentDir = join(resolve(root), "intents");
  const linkDir = join(resolve(root), "issue-links");
  const intentPath = requestId => join(intentDir, digest(requestId) + ".json");
  const linkPath = requestId => join(linkDir, digest(requestId) + ".json");
  const originPath = issueKey => join(originDir, digest(issueKey) + ".json");
  const consumed = new Set();

  async function snapshot(requestId) {
    if (typeof requestId !== "string" || !ID.test(requestId)) throw new Error("invalid CreateRequestId");
    const inspected = await ledger.inspectRequest(requestId);
    const pending = inspected?.pending;
    const link = inspected?.link;
    if (!pending) return { status: "blocked", code: "NO_DURABLE_INTENT", request_id: requestId,
      allowed_action: "STOP; do not create or infer a Jira Issue" };
    if (pending.create_request_id !== requestId || pending.ledger_ref !== ledgerRef || pending.phase !== "pending"
      || !pending.fields || typeof pending.fields !== "object"
      || TYPE_IDS[pending.issue_type] !== pending.issue_type_id
      || typeof pending.cutover_approval_ref !== "string" || !pending.cutover_approval_ref.trim())
      return { status: "blocked", code: "INVALID_OR_UNTRUSTED_INTENT", request_id: requestId,
        allowed_action: "FREEZE; preserve ledger evidence for a maintainer" };
    if (link && !validLink(link, requestId, siteOrigin)) return { status: "blocked", code: "INVALID_LINK_RECORD", request_id: requestId,
      allowed_action: "FREEZE; do not query Jira or modify the ledger" };
    const key = link?.issue_key ?? null;
    let origin = null;
    if (key) origin = await readOptional(originPath(key));
    if (origin && !originMatches(origin, pending, requestId, key, origin.verified_fields))
      return { status: "blocked", code: "ORIGIN_MISMATCH", request_id: requestId, issue_key: key,
        allowed_action: "FREEZE; retain the existing Origin and investigate manually" };
    return { status: "ready_for_manual_review", code: key ? origin ? "LINK_AND_ORIGIN_PRESENT" : "LINK_PRESENT_ORIGIN_MISSING"
      : "CREATE_OUTCOME_UNKNOWN_NO_LINK", request_id: requestId, issue_key: key,
      activation_ref: pending.activation_ref, cutover_approval_ref: pending.cutover_approval_ref,
      issue_type: pending.issue_type, ledger_ref: pending.ledger_ref,
      pending_sha256: g3EvidenceSha256(immutableIntent(pending)),
      fields_sha256: g3EvidenceSha256(pending.fields), target_snapshot: normalizedTargetIds(pending.fields),
      allowed_action: "READ_ONLY_PLAN_ONLY; a separate signed recovery authorization is required before one Jira GET" };
  }

  async function syncReceipts({ requestId, issueKey, includeLink = false, includeOrigin = false }) {
    await syncReceipt(intentPath(requestId), intentDir);
    if (includeLink) await syncReceipt(linkPath(requestId), linkDir);
    if (includeOrigin) await syncReceipt(originPath(issueKey), originDir);
  }

  function verifyAuthorization(envelope, pending, requestId, key) {
    const payload = verifyG3SignedEvidence(envelope, trustedKeys, { now: now(), maxAgeMs: Number.MAX_SAFE_INTEGER });
    if (payload.kind !== "g3_manual_recovery_authorization" || payload.status !== "approved"
      || payload.action !== "reconcile_existing_issue" || typeof payload.authorization_ref !== "string"
      || !payload.authorization_ref.trim()
      || payload.create_request_id !== requestId || payload.ledger_ref !== ledgerRef
      || payload.issue_key !== key || payload.activation_ref !== pending.activation_ref
      || payload.cutover_approval_ref !== pending.cutover_approval_ref
      || payload.issue_type !== pending.issue_type || payload.issue_type_id !== TYPE_IDS[pending.issue_type]
      || payload.pending_sha256 !== g3EvidenceSha256(immutableIntent(pending))
      || payload.fields_sha256 !== g3EvidenceSha256(pending.fields))
      throw new Error("manual recovery authorization does not bind exact Intent, IssueKey, and Owner approval");
    return payload;
  }

  async function plan(requestId) {
    return snapshot(requestId);
  }

  async function reconcile({ request_id: requestId, authorization }) {
    if (typeof requestId !== "string" || !ID.test(requestId)) throw new Error("invalid CreateRequestId");
    if (consumed.has(requestId)) return { status: "blocked", code: "RECOVERY_ALREADY_ATTEMPTED",
      request_id: requestId, jira_get_calls: 0, jira_create_calls: 0,
      allowed_action: "STOP; this recovery instance never retries an attempted reconciliation" };
    consumed.add(requestId); // Synchronous reservation closes the concurrent entry race before any await.
    const inspected = await ledger.inspectRequest(requestId);
    const pending = inspected?.pending;
    if (!pending || pending.ledger_ref !== ledgerRef || pending.phase !== "pending"
      || typeof pending.cutover_approval_ref !== "string" || !pending.cutover_approval_ref.trim())
      return { status: "blocked", code: "INVALID_OR_UNTRUSTED_INTENT",
        request_id: requestId, jira_get_calls: 0, jira_create_calls: 0 };
    const existingLink = inspected?.link;
    if (existingLink && !validLink(existingLink, requestId, siteOrigin)) return { status: "blocked", code: "INVALID_LINK_RECORD",
      request_id: requestId, jira_get_calls: 0, jira_create_calls: 0 };
    let key = existingLink?.issue_key ?? authorization?.payload?.issue_key;
    // A signed envelope is opaque until verified; reading this candidate only chooses a safe lookup path.
    if (typeof key !== "string" || !KEY.test(key)) return { status: "blocked", code: "ISSUE_KEY_REQUIRED",
      request_id: requestId, jira_get_calls: 0, jira_create_calls: 0,
      allowed_action: "Do not search or create. A maintainer must identify the existing IssueKey first." };
    const auth = verifyAuthorization(authorization, pending, requestId, key);
    if (existingLink && existingLink.issue_key !== auth.issue_key) throw new Error("recovery IssueKey conflicts with durable link");
    const originFile = await readOptional(originPath(key));
    if (originFile && !originMatches(originFile, pending, requestId, key, originFile.verified_fields))
      return { status: "frozen", code: "ORIGIN_MISMATCH", request_id: requestId, issue_key: key,
        jira_get_calls: 0, jira_create_calls: 0, authorization_ref: auth.authorization_ref,
        allowed_action: "FREEZE; preserve the existing Origin for investigation" };
    // Recheck the signed maintenance window after every async ledger lookup and immediately before Jira GET.
    verifyAuthorization(authorization, pending, requestId, key);
    const targetIds = TARGET_FIELDS;
    let current;
    try { current = await jiraRead({ key, fields: ["issuetype", ...targetIds] }); }
    catch {
      return { status: "frozen", code: "JIRA_GET_UNKNOWN", request_id: requestId, issue_key: key,
        jira_get_calls: 1, jira_create_calls: 0, authorization_ref: auth.authorization_ref,
        allowed_action: "STOP; preserve the Intent and do not retry Create" };
    }
    try { verifyAuthorization(authorization, pending, requestId, key); }
    catch {
      return { status: "frozen", code: "RECOVERY_AUTHORIZATION_EXPIRED_AFTER_GET", request_id: requestId,
        issue_key: key, jira_get_calls: 1, jira_create_calls: 0,
        allowed_action: "STOP; the GET result is not authorized for ledger mutation" };
    }
    if (current?.tool_call_count !== 1 || current?.key !== key
      || current?.issue_type_id !== auth.issue_type_id || !sameTargets(pending.fields, current?.fields))
      return { status: "frozen", code: "JIRA_GET_MISMATCH", request_id: requestId, issue_key: key,
        jira_get_calls: 1, jira_create_calls: 0,
        authorization_ref: auth.authorization_ref,
        allowed_action: "FREEZE; do not alter Origin or retry Create" };

    const verifiedFields = {
      customfield_10108: { id: current.fields.customfield_10108.id },
      customfield_10109: { id: current.fields.customfield_10109.id },
      customfield_10110: (current.fields.customfield_10110 ?? []).map(value => ({ id: value.id })),
    };
    try {
      await syncReceipts({ requestId, issueKey: key, includeLink: Boolean(existingLink), includeOrigin: Boolean(originFile) });
    } catch {
      return { status: "frozen", code: "DURABILITY_CONFIRMATION_FAILED", request_id: requestId,
        issue_key: key, jira_get_calls: 1, jira_create_calls: 0,
        authorization_ref: auth.authorization_ref,
        allowed_action: "FREEZE; a readable file is not treated as a durable receipt" };
    }
    if (originFile) {
      if (!originMatches(originFile, pending, requestId, key, verifiedFields))
        return { status: "frozen", code: "ORIGIN_MISMATCH", request_id: requestId, issue_key: key,
          jira_get_calls: 1, jira_create_calls: 0, authorization_ref: auth.authorization_ref,
          allowed_action: "FREEZE; preserve the existing Origin for investigation" };
      if (existingLink) return { status: "reconciled", code: "ALREADY_LINKED_AND_ORIGIN_VERIFIED", request_id: requestId,
        issue_key: key, jira_get_calls: 1, jira_create_calls: 0, origin_durable: true,
        authorization_ref: auth.authorization_ref };
      try {
        verifyAuthorization(authorization, pending, requestId, key);
        await ledger.linkIssue(requestId, { key, url: `${siteOrigin}/browse/${key}` });
        const confirmed = await ledger.inspectRequest(requestId);
        if (!validLink(confirmed?.link, requestId, siteOrigin) || confirmed.link.issue_key !== key)
          throw new Error("recovered IssueKey link was not durable and exact");
        await syncReceipts({ requestId, issueKey: key, includeLink: true, includeOrigin: true });
        return { status: "reconciled", code: "LINK_RESTORED_FOR_EXISTING_ORIGIN", request_id: requestId,
          issue_key: key, jira_get_calls: 1, jira_create_calls: 0, origin_durable: true,
          authorization_ref: auth.authorization_ref };
      } catch {
        return { status: "frozen", code: "LEDGER_WRITE_UNKNOWN", request_id: requestId, issue_key: key,
          jira_get_calls: 1, jira_create_calls: 0, origin_durable: true,
          authorization_ref: auth.authorization_ref,
          allowed_action: "STOP; re-inspect files and receipts before further manual reconciliation" };
      }
    }

    try {
      if (!existingLink) {
        verifyAuthorization(authorization, pending, requestId, key);
        await ledger.linkIssue(requestId, { key, url: `${siteOrigin}/browse/${key}` });
      }
      verifyAuthorization(authorization, pending, requestId, key);
      const receipt = await ledger.persistOrigin({ create_request_id: requestId, issue_key: key,
        ledger_ref: ledgerRef, create_activation_ref: pending.activation_ref,
        cutover_approval_ref: pending.cutover_approval_ref, origin: "target_create",
        issue_type: pending.issue_type, issue_type_id: pending.issue_type_id,
        phase: "create_ready", read_authority: "target", write_authority: "target",
        legacy_snapshot_ref: "not_applicable", verified_fields: verifiedFields });
      if (receipt?.status !== "persisted" || receipt.durable !== true)
        throw new Error("Origin persistence did not return a durable receipt");
      return { status: "reconciled", code: "LINK_AND_ORIGIN_DURABLE", request_id: requestId,
        issue_key: key, jira_get_calls: 1, jira_create_calls: 0, origin_durable: true,
        authorization_ref: auth.authorization_ref };
    } catch {
      return { status: "frozen", code: "LEDGER_WRITE_UNKNOWN", request_id: requestId, issue_key: key,
        jira_get_calls: 1, jira_create_calls: 0, origin_durable: false,
        authorization_ref: auth.authorization_ref,
        allowed_action: "STOP; re-inspect files and receipts before any further manual reconciliation" };
    }
  }

  return { plan, reconcile };
}
