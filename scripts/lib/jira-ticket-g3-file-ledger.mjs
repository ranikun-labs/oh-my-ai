import { createHash } from "node:crypto";
import { open, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const KEY = /^RPL-[1-9][0-9]*$/;
const digest = text => createHash("sha256").update(text, "utf8").digest("hex");

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
      const id = request?.create_request_id;
      assertId(id);
      if (request?.ledger_ref !== ledgerRef || request?.status !== "pending"
        || typeof request?.approved_preview_id !== "string"
        || typeof request?.activation_ref !== "string"
        || typeof request?.issue_type !== "string"
        || !request?.fields || typeof request.fields !== "object")
        throw new Error("incomplete immutable pending Intent");
      const record = { ...request, phase: "pending", stored_at: new Date().toISOString() };
      const created = await writeOnce(intentDir, intentPath(id), record);
      if (!created) return { status: "duplicate", durable: true, created_new: false,
        create_request_id: id, ledger_ref: ledgerRef, prior_issue_key: (await load(linkPath(id)))?.issue_key ?? null };
      return { status: "persisted", durable: true, created_new: true, prior_issue_key: null,
        create_request_id: id, ledger_ref: ledgerRef,
        approved_preview_id: request.approved_preview_id, activation_ref: request.activation_ref };
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
      const id = request?.create_request_id;
      assertId(id);
      assertKey(request?.issue_key);
      const [pending, link] = await Promise.all([load(intentPath(id)), load(linkPath(id))]);
      if (!pending || !link || pending.phase !== "pending" || link.issue_key !== request.issue_key
        || pending.ledger_ref !== ledgerRef || request.ledger_ref !== ledgerRef
        || request.create_activation_ref !== pending.activation_ref
        || request.origin !== "target_create" || request.phase !== "create_ready"
        || request.read_authority !== "target" || request.write_authority !== "target"
        || request.legacy_snapshot_ref !== "not_applicable"
        || typeof request.cutover_approval_ref !== "string"
        || !request.verified_fields || typeof request.verified_fields !== "object")
        throw new Error("Origin does not match linked, verified pending Intent");
      // One IssueKey can only be assigned one Origin. Existing data is not overwritten.
      const created = await writeOnce(originDir, originPath(request.issue_key), {
        ...request, verified_at: new Date().toISOString(),
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
        || origin.phase !== "create_ready" || origin.read_authority !== "target"
        || origin.write_authority !== "target" || origin.create_activation_ref !== pending.activation_ref)
        return { origin: "UNKNOWN_ORIGIN", read_authority: "none",
          write_authority: "frozen", phase: "create_quarantined" };
      return { origin: "target_create", phase: "create_ready",
        read_authority: "target", write_authority: "target",
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
