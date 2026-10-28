import { createHash } from "node:crypto";

export const G2_SNAPSHOT_SOURCE = Object.freeze({
  repository: "ranikun-labs/platform-services",
  branch: "audit/jira-g2-full-118-20261023",
  commit_sha: "530dd0f88e5819158362b620ca1591779a50cba5",
  path: "governance/jira-g2-full-118/final118-verification-20261023.json",
  blob_sha: "aea968a4dca76194b0de96db6fe20c1c20648470",
});

const EXPECTED_COUNTS = Object.freeze({
  total: 118,
  supported: 106,
  protected: 3,
  candidates: 103,
  unsupported: 12,
  by_type_id: Object.freeze({
    "10007": 9, "10008": 8, "10009": 33, "10010": 50,
    "10011": 4, "10012": 5, "10013": 9,
  }),
});
const TYPE_LABELS = Object.freeze({
  "10007": "Epic", "10008": "Subtask", "10009": "Feature", "10010": "Task",
  "10011": "Story", "10012": "Bug", "10013": "Research",
});
const SUPPORTED_TYPE_IDS = new Set(["10007", "10009", "10010", "10012", "10013"]);
const PROTECTED_KEYS = new Set(["RPL-112", "RPL-113", "RPL-114", "RPL-122", "RPL-124"]);
const REQUIRED_G3_EVIDENCE = Object.freeze([
  ["origin_ref", "OriginRef"],
  ["changelog_ref", "ChangelogRef"],
  ["owner_approval_ref", "OwnerApprovalRef"],
  ["cutover_approval_ref", "CutoverApprovalRef"],
]);
const ISSUE_KEY = /^RPL-[1-9][0-9]*$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }

export function gitBlobSha1(content) {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function validOption(value) {
  return isRecord(value) && nonEmpty(value.id);
}

function validOptionArray(value) {
  return Array.isArray(value) && value.every(validOption);
}

function validTargetFields(fields) {
  return validOption(fields.customfield_10108)
    && validOption(fields.customfield_10109)
    && (fields.customfield_10110 === null || validOptionArray(fields.customfield_10110));
}

function validLegacyFields(fields) {
  return ["customfield_10042", "customfield_10043", "customfield_10044"]
    .every(id => Array.isArray(fields[id]) && fields[id].every(nonEmpty));
}

function sourceSnapshotRef(source) {
  return `github:${source.repository}@${source.commit_sha}:${source.path}#blob=${source.blob_sha}`;
}

function validateSnapshot(snapshot, source, actualBlobSha) {
  if (actualBlobSha !== source.blob_sha)
    throw new Error("G2 source Git blob SHA does not match the pinned snapshot");
  if (!isRecord(snapshot) || snapshot.record_type !== "G2_FINAL_118_VERIFICATION"
    || snapshot.verdict !== "G2_DATA_MIGRATION_PASS_ADMIN_METADATA_REVIEW_PENDING")
    throw new Error("input is not the pinned G2 final verification record");
  const summary = snapshot.summary;
  if (!isRecord(summary) || summary.total !== EXPECTED_COUNTS.total
    || summary.targetBoth !== EXPECTED_COUNTS.total || summary.missingBoth !== 0
    || summary.partial !== 0 || summary.unchanged106 !== true)
    throw new Error("G2 root verification summary does not match the pinned 118-row snapshot contract");
  if (!Array.isArray(snapshot.current_118) || snapshot.current_118.length !== EXPECTED_COUNTS.total)
    throw new Error("G2 current_118 must contain exactly 118 rows");

  const seen = new Set();
  const byType = Object.create(null);
  for (const row of snapshot.current_118) {
    if (!isRecord(row) || !ISSUE_KEY.test(row.key) || seen.has(row.key) || !isRecord(row.fields))
      throw new Error("G2 current_118 contains an invalid or duplicate IssueKey row");
    seen.add(row.key);
    const typeId = row.fields.issuetype?.id;
    if (typeof typeId !== "string" || !Object.hasOwn(TYPE_LABELS, typeId))
      throw new Error(`G2 current_118 has an unsupported or unknown Issue Type ID for ${row.key}`);
    byType[typeId] = (byType[typeId] ?? 0) + 1;
    if (!validTargetFields(row.fields))
      throw new Error(`G2 Target fields are incomplete for ${row.key}`);
    if (SUPPORTED_TYPE_IDS.has(typeId) && !validLegacyFields(row.fields))
      throw new Error(`G2 Legacy baseline fields are incomplete for supported issue ${row.key}`);
  }
  for (const [typeId, count] of Object.entries(EXPECTED_COUNTS.by_type_id)) {
    if (byType[typeId] !== count)
      throw new Error(`G2 Issue Type ID ${typeId} count differs from the pinned snapshot`);
  }
  const supportedRows = snapshot.current_118.filter(row => SUPPORTED_TYPE_IDS.has(row.fields.issuetype.id));
  const unsupportedRows = snapshot.current_118.filter(row => !SUPPORTED_TYPE_IDS.has(row.fields.issuetype.id));
  const protectedRows = supportedRows.filter(row => PROTECTED_KEYS.has(row.key));
  const requiredProtected = ["RPL-112", "RPL-113", "RPL-114"];
  if (requiredProtected.some(key => !seen.has(key))
    || protectedRows.length !== EXPECTED_COUNTS.protected
    || protectedRows.some(row => row.key === "RPL-122" || row.key === "RPL-124"))
    throw new Error("G2 protected-key set differs from the pinned snapshot contract");
  const candidates = supportedRows.filter(row => !PROTECTED_KEYS.has(row.key));
  if (supportedRows.length !== EXPECTED_COUNTS.supported
    || unsupportedRows.length !== EXPECTED_COUNTS.unsupported
    || candidates.length !== EXPECTED_COUNTS.candidates)
    throw new Error("G2 supported/protected/candidate counts do not reconcile to 106/3/103");
  return { byType, supportedRows, unsupportedRows, protectedRows, candidates };
}

function missingEvidence(row) {
  const evidence = isRecord(row.g3_cutover_evidence) ? row.g3_cutover_evidence
    : isRecord(row.cutover_evidence) ? row.cutover_evidence : {};
  return REQUIRED_G3_EVIDENCE.filter(([key]) => !nonEmpty(evidence[key])).map(([, label]) => label);
}

function blockedReport(reason, source) {
  return {
    schema_version: 1,
    status: "BLOCKED",
    execution_authorized: false,
    read_authority_changed: false,
    jira_read_count: 0,
    jira_write_count: 0,
    reason,
    ...(source ? { source_snapshot_ref: sourceSnapshotRef(source) } : {}),
    candidates: [],
  };
}

/** Build a read-only, pinned G2-to-G3 candidate preflight; it never mutates authority. */
export function buildG3CutoverPreflightReport(manifestText, { source = G2_SNAPSHOT_SOURCE } = {}) {
  try {
    if (typeof manifestText !== "string" || !isRecord(source)
      || !nonEmpty(source.repository) || !nonEmpty(source.commit_sha)
      || !nonEmpty(source.path) || !nonEmpty(source.blob_sha))
      throw new Error("G2 preflight requires manifest text and a complete pinned source reference");
    const actualBlobSha = gitBlobSha1(manifestText);
    const snapshot = JSON.parse(manifestText);
    const scope = validateSnapshot(snapshot, source, actualBlobSha);
    const candidates = scope.candidates
      .map(row => {
        const missing = missingEvidence(row);
        return {
          issue_key: row.key,
          issue_type_id: row.fields.issuetype.id,
          issue_type: TYPE_LABELS[row.fields.issuetype.id],
          g2_target_fields_present: true,
          g2_legacy_baseline_present: true,
          status: missing.length ? "NOT_READY" : "TRUSTED_READER_VERIFICATION_REQUIRED",
          missing_evidence: missing,
        };
      })
      .sort((left, right) => Number(left.issue_key.slice(4)) - Number(right.issue_key.slice(4)));
    const unsupportedTypeCounts = Object.entries(scope.byType)
      .filter(([id]) => !SUPPORTED_TYPE_IDS.has(id))
      .map(([id, count]) => ({ issue_type_id: id, issue_type: TYPE_LABELS[id], count }))
      .sort((a, b) => a.issue_type_id.localeCompare(b.issue_type_id));
    const protectedPresent = scope.protectedRows.map(row => row.key).sort();
    const notReadyCount = candidates.filter(row => row.status === "NOT_READY").length;
    const readerVerificationPending = candidates.length - notReadyCount;
    const originalSnapshotRef = isRecord(snapshot.original_snapshot_ref)
      ? { path: snapshot.original_snapshot_ref.path, blob_sha: snapshot.original_snapshot_ref.blob_sha }
      : null;
    return {
      schema_version: 1,
      status: "PREFLIGHT_ONLY",
      execution_authorized: false,
      read_authority_changed: false,
      jira_read_count: 0,
      jira_write_count: 0,
      source: {
        repository: source.repository,
        branch: source.branch ?? null,
        commit_sha: source.commit_sha,
        path: source.path,
        git_blob_sha: actualBlobSha,
        content_sha256: createHash("sha256").update(manifestText, "utf8").digest("hex"),
        snapshot_ref: sourceSnapshotRef(source),
        g2_original_snapshot_ref: originalSnapshotRef,
      },
      summary: {
        snapshot_rows: snapshot.current_118.length,
        supported_rows: scope.supportedRows.length,
        protected_rows: protectedPresent.length,
        candidate_rows: candidates.length,
        candidate_not_ready: notReadyCount,
        candidate_reader_verification_pending: readerVerificationPending,
        candidate_cutover_ready: 0,
        unsupported_rows: scope.unsupportedRows.length,
        target_rows_verified_by_g2_record: snapshot.summary.targetBoth,
        missing_target_rows_by_g2_record: snapshot.summary.missingBoth,
        issue_type_counts: Object.fromEntries(Object.entries(scope.byType)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, count]) => [id, { name: TYPE_LABELS[id], count }])),
        unsupported_type_counts: unsupportedTypeCounts,
      },
      protected_issue_keys: protectedPresent,
      protected_keys_not_in_snapshot: ["RPL-122", "RPL-124"],
      required_per_issue_evidence: REQUIRED_G3_EVIDENCE.map(([, label]) => label),
      authority_reader_gate: {
        method: "createG3AuthorityReader.readClassification(issueKey)",
        target_migration_requires: ["approved owner_cutover", "target_migration_snapshot",
          "migration_parity", "durable Origin + Jira GET parity"],
        note: "G2 field storage is not ReadAuthority or Cutover approval; this preflight never changes authority.",
      },
      candidates,
    };
  } catch (error) {
    return blockedReport(error instanceof Error ? error.message : "G3 Cutover preflight failed", source);
  }
}
