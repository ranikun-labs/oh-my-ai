import { createHash } from "node:crypto";
import { open, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const KEY = /^RPL-[1-9][0-9]*$/;
const ISSUE_TYPE_IDS = Object.freeze({ Task: "10010", Epic: "10007", Feature: "10009", Bug: "10012", Research: "10013" });
const digest = text => createHash("sha256").update(text, "utf8").digest("hex");
const TARGET_IDS = ["customfield_10108", "customfield_10109", "customfield_10110"];
const nonEmptyRef = value => typeof value === "string" && value.trim().length > 0;
export function g3FileOriginRef({ ledger_ref, create_request_id, issue_key, issue_type_id } = {}) {
  if (!nonEmptyRef(ledger_ref) || !ID.test(create_request_id ?? "") || !KEY.test(issue_key ?? "")
    || !Object.values(ISSUE_TYPE_IDS).includes(issue_type_id))
    throw new Error("cannot derive a G3 Origin reference from incomplete identity");
  return `g3-file-origin-v1:${digest(JSON.stringify({ ledger_ref, create_request_id, issue_key, issue_type_id }))}`;
}
function sameVerifiedTargets(intentFields, verifiedFields) {
  if (!intentFields || !verifiedFields || typeof verifiedFields !== "object"
    || Object.keys(verifiedFields).sort().join("|") !== [...TARGET_IDS].sort().join("|")
    || TARGET_IDS.slice(0, 2).some(id =>
      typeof intentFields[id]?.id !== "string" || typeof verifiedFields[id]?.id !== "string")
    || !Array.isArray(verifiedFields[TARGET_IDS[2]])
    || (intentFields[TARGET_IDS[2]] != null && !Array.isArray(intentFields[TARGET_IDS[2]])))
    return false;
  const norm = (value) => Array.isArray(value)
    ? [...value].map(v => v?.id).sort().join(",") : value?.id;
  return TARGET_IDS.every(id =>
    norm(intentFields[id] ?? (id === TARGET_IDS[2] ? [] : undefined)) === norm(verifiedFields[id]));
}

function assertId(id) {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("invalid CreateRequestId");
}
function assertKey(key) {
  if (typeof key !== "string" || !KEY.test(key)) throw new Error("invalid RPL IssueKey");
}
async function load(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error; // damaged/corrupt records are never treated as absent
  }
}
// A file is immutable once written. 'wx' is the cross-process create-if-absent
// CAS primitive on a single filesystem; fsync file + directory before receipts.
async function writeOnce(directory, path, record) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  // Refuse a durability receipt if the filesystem cannot sync the directory.
  const folder = await open(directory, "r");
  try { await folder.sync(); } finally { await folder.close(); }
  return true;
}

function canonicalJson(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, (item, index) => canonicalJson(item, `${path}[${index}]`)).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => {
      if (value[key] === undefined) throw new Error(`non-JSON pending Intent at ${path}.${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`)}`;
    }).join(",")}}`;
  }
  throw new Error(`non-JSON pending Intent at ${path}`);
}

function samePendingIntent(existing, request) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)
    || existing.phase !== "pending" || typeof existing.stored_at !== "string"
    || !Number.isFinite(Date.parse(existing.stored_at))
    || new Date(existing.stored_at).toISOString() !== existing.stored_at)
    return false;
  const expectedKeys = [...Object.keys(request), "phase", "stored_at"].sort();
  if (Object.keys(existing).sort().join("\n") !== expectedKeys.join("\n")) return false;
  const { phase, stored_at, ...storedRequest } = existing;
  return canonicalJson(storedRequest) === canonicalJson(request);
}

async function readExistingAndConfirmDurable(path, directory) {
  const handle = await open(path, "r+");
  let existing;
  try {
    const raw = await handle.readFile("utf8");
    try { existing = JSON.parse(raw); }
    catch (error) { throw new Error("existing pending Intent JSON is corrupt", { cause: error }); }
    // The ledger writes compact JSON plus one newline. This also rejects duplicate
    // JSON keys, which JSON.parse would otherwise silently collapse.
    if (raw !== `${JSON.stringify(existing)}\n`)
      throw new Error("existing pending Intent encoding is not intact");
    await handle.sync();
  } finally { await handle.close(); }
  const folder = await open(directory, "r");
  try { await folder.sync(); } finally { await folder.close(); }
  return existing;
}

/**
 * Owner-supervised single-host reference store. Local fsync is NOT proof of
 * durable shared storage on Codex Cloud, containers or multiple hosts.
 * It never calls Jira and never automatically retries ambiguous Create.
 */
export function createG3FileLedger({ root, ledgerRef }) {
  if (typeof root !== "string" || !root.trim() || typeof ledgerRef !== "string" || !ledgerRef.trim())
    throw new Error("explicit persistent volume and ledgerRef required");
  const directory = resolve(root);
  const intentDir = join(directory, "intents");
  const linkDir = join(directory, "issue-links");
  const originDir = join(directory, "origins");
  const intentPath = id => join(intentDir, digest(id) + ".json");
  const linkPath = id => join(linkDir, digest(id) + ".json");
  const originPath = key => join(originDir, digest(key) + ".json");

  return {
    async persistIntent(request) {
      const snapshot = structuredClone(request);
      const id = snapshot?.create_request_id;
      assertId(id);
      if (snapshot?.ledger_ref !== ledgerRef || snapshot?.status !== "pending"
        || Object.hasOwn(snapshot, "phase") || Object.hasOwn(snapshot, "stored_at")
        || typeof snapshot?.approved_preview_id !== "string"
        || typeof snapshot?.activation_ref !== "string"
        || typeof snapshot?.issue_type !== "string"
        || !Object.hasOwn(ISSUE_TYPE_IDS, snapshot.issue_type)
        || ISSUE_TYPE_IDS[snapshot.issue_type] !== snapshot.issue_type_id
        || !nonEmptyRef(snapshot?.cutover_approval_ref)
        || !snapshot?.fields || typeof snapshot.fields !== "object")
        throw new Error("incomplete immutable pending Intent");
      canonicalJson(snapshot);
      const record = { ...snapshot, phase: "pending", stored_at: new Date().toISOString() };
      const created = await writeOnce(intentDir, intentPath(id), record);
      if (!created) {
        const existing = await readExistingAndConfirmDurable(intentPath(id), intentDir);
        if (!samePendingIntent(existing, snapshot))
          throw new Error("existing pending Intent does not match the approved request");
        const priorLink = await load(linkPath(id));
        if (priorLink && (priorLink.create_request_id !== id || !KEY.test(priorLink.issue_key ?? "")))
          throw new Error("existing IssueKey link does not match the pending Intent");
        return { status: "duplicate", durable: true, created_new: false,
          create_request_id: id, ledger_ref: ledgerRef, prior_issue_key: priorLink?.issue_key ?? null };
      }
      return { status: "persisted", durable: true, created_new: true, prior_issue_key: null,
        create_request_id: id, ledger_ref: ledgerRef,
        approved_preview_id: snapshot.approved_preview_id, activation_ref: snapshot.activation_ref };
    },

    async linkIssue(requestId, issue) {
      assertId(requestId);
      assertKey(issue?.key);
      const pending = await load(intentPath(requestId));
      if (!pending || pending.phase !== "pending") throw new Error("missing durable pending Intent");
      if (issue?.url == null || typeof issue.url !== "string")
        throw new Error("Create response URL missing");
      const created = await writeOnce(linkDir, linkPath(requestId), {
        create_request_id: requestId, issue_key: issue.key, issue_url: issue.url,
        linked_at: new Date().toISOString(),
      });
      if (!created) throw new Error("CreateRequestId already has an IssueKey; never replay Create");
      return { linked: true };
    },

    async persistOrigin(request) {
      request = structuredClone(request);
      const id = request?.create_request_id;
      assertId(id);
      assertKey(request?.issue_key);
      const [pending, link] = await Promise.all([load(intentPath(id)), load(linkPath(id))]);
      if (!pending || !link || pending.phase !== "pending" || link.issue_key !== request.issue_key
        || pending.ledger_ref !== ledgerRef || request.ledger_ref !== ledgerRef
        || request.create_activation_ref !== pending.activation_ref
        || request.origin !== "target_create" || request.phase !== "create_ready"
        || request.issue_type !== pending.issue_type || request.issue_type_id !== pending.issue_type_id
        || request.read_authority !== "target" || request.write_authority !== "target"
        || request.legacy_snapshot_ref !== "not_applicable"
        || !nonEmptyRef(request.cutover_approval_ref)
        || request.cutover_approval_ref !== pending.cutover_approval_ref
        || !sameVerifiedTargets(pending.fields, request.verified_fields))
        throw new Error("Origin does not match linked, verified pending Intent");
      // One IssueKey can only be assigned one Origin. Existing data is not overwritten.
      const originRef = g3FileOriginRef({ ledger_ref: ledgerRef, create_request_id: id,
        issue_key: request.issue_key, issue_type_id: pending.issue_type_id });
      if (request.origin_ref != null && request.origin_ref !== originRef)
        throw new Error("Origin reference differs from the immutable G3 Origin identity");
      const created = await writeOnce(originDir, originPath(request.issue_key), {
        ...request, origin_ref: originRef, verified_at: new Date().toISOString(),
      });
      if (!created) throw new Error("Origin already exists; manual reconciliation required");
      return { status: "persisted", durable: true, issue_key: request.issue_key,
        create_request_id: id, ledger_ref: ledgerRef, phase: "create_ready",
        cutover_approval_ref: request.cutover_approval_ref,
        create_activation_ref: request.create_activation_ref,
        origin: "target_create", read_authority: "target", write_authority: "target" };
    },

    async readClassificationAuthority(issueKey) {
      assertKey(issueKey);
      const origin = await load(originPath(issueKey));
      if (!origin) return { origin: "UNKNOWN_ORIGIN", read_authority: "none",
        write_authority: "frozen", phase: "create_quarantined" };
      const [pending, linked] = await Promise.all([
        load(intentPath(origin.create_request_id)), load(linkPath(origin.create_request_id)),
      ]);
      if (!pending || !linked || pending.phase !== "pending"
        || pending.ledger_ref !== ledgerRef || origin.ledger_ref !== ledgerRef
        || linked.issue_key !== issueKey || origin.origin !== "target_create"
        || !nonEmptyRef(pending.cutover_approval_ref)
        || origin.cutover_approval_ref !== pending.cutover_approval_ref
        || !sameVerifiedTargets(pending.fields, origin.verified_fields)
        || !Object.hasOwn(ISSUE_TYPE_IDS, pending.issue_type)
        || ISSUE_TYPE_IDS[pending.issue_type] !== pending.issue_type_id
        || origin.issue_type !== pending.issue_type || origin.issue_type_id !== pending.issue_type_id
        || origin.origin_ref !== g3FileOriginRef({ ledger_ref: ledgerRef,
          create_request_id: origin.create_request_id, issue_key: issueKey, issue_type_id: pending.issue_type_id })
        || origin.phase !== "create_ready" || origin.read_authority !== "target"
        || origin.write_authority !== "target" || origin.create_activation_ref !== pending.activation_ref)
        return { origin: "UNKNOWN_ORIGIN", read_authority: "none",
          write_authority: "frozen", phase: "create_quarantined" };
      return { origin: "target_create", phase: "create_ready",
        read_authority: "target", write_authority: "target", issue_type: pending.issue_type,
        issue_type_id: pending.issue_type_id, origin_ref: origin.origin_ref,
        product: origin.verified_fields?.customfield_10108 ?? null,
        component: origin.verified_fields?.customfield_10109 ?? null,
        concern: origin.verified_fields?.customfield_10110 ?? [] };
    },

    async inspectRequest(requestId) {
      assertId(requestId);
      const [pending, link] = await Promise.all([load(intentPath(requestId)), load(linkPath(requestId))]);
      return { pending, link }; // privileged repair/audit only, no automatic retry
    },
  };
}
