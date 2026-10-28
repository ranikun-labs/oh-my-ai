import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createG3AuthorityReader } from "./lib/jira-ticket-g3-authority-reader.mjs";
import {
  buildG3CutoverCandidateManifest,
  runG3CutoverCandidateManifestCli,
} from "./jira-ticket-g3-cutover-candidate-manifest.mjs";
import {
  buildG3CutoverPreflightReport,
  gitBlobSha1,
} from "./lib/jira-ticket-g3-cutover-preflight.mjs";

const names = { "10007": "에픽", "10008": "하위 작업", "10009": "기능",
  "10010": "작업", "10011": "스토리", "10012": "버그", "10013": "Research" };
const counts = { "10007": 9, "10008": 8, "10009": 33, "10010": 50,
  "10011": 4, "10012": 5, "10013": 9 };
const protectedKeys = { "10007": "RPL-112", "10010": "RPL-113", "10013": "RPL-114" };
function row(key, typeId) {
  return { key, fields: {
    summary: "synthetic test-only issue",
    issuetype: { id: typeId, name: names[typeId] },
    customfield_10108: { id: "10027", value: "dev-harness" },
    customfield_10109: { id: "10028", value: "backend" },
    customfield_10110: null,
    customfield_10042: ["legacy-product"],
    customfield_10043: ["legacy-component"],
    customfield_10044: ["legacy-label"],
  } };
}
function fixture() {
  const rows = [];
  let next = 500;
  for (const [typeId, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) {
      rows.push(row(i === 0 && protectedKeys[typeId] ? protectedKeys[typeId] : `RPL-${next++}`, typeId));
    }
  }
  return {
    record_type: "G2_FINAL_118_VERIFICATION",
    verified_at: "2026-10-23T03:47:22.084Z",
    verdict: "G2_DATA_MIGRATION_PASS_ADMIN_METADATA_REVIEW_PENDING",
    summary: { total: 118, targetBoth: 118, missingBoth: 0, partial: 0, unchanged106: true },
    original_snapshot_ref: { path: "prewrite-snapshot.json", blob_sha: "b".repeat(40) },
    current_118: rows,
  };
}
function sourceFor(text) {
  return { repository: "test/platform-services", branch: "test/g2", commit_sha: "a".repeat(40),
    path: "g2.json", blob_sha: gitBlobSha1(text) };
}
function reportFor(snapshot) {
  const text = JSON.stringify(snapshot);
  return { text, report: buildG3CutoverPreflightReport(text, { source: sourceFor(text) }) };
}

const { text, report } = reportFor(fixture());
assert.equal(report.status, "PREFLIGHT_ONLY");
assert.equal(report.execution_authorized, false);
assert.equal(report.read_authority_changed, false);
assert.equal(report.jira_read_count, 0);
assert.equal(report.jira_write_count, 0);
assert.equal(report.summary.snapshot_rows, 118);
assert.equal(report.summary.supported_rows, 106);
assert.equal(report.summary.protected_rows, 3);
assert.equal(report.summary.candidate_rows, 103);
assert.equal(report.summary.unsupported_rows, 12);
assert.equal(report.summary.candidate_not_ready, 103);
assert.equal(report.summary.candidate_cutover_ready, 0);
assert.equal(report.source.verified_at, "2026-10-23T03:47:22.084Z");
assert.ok(report.candidates.every(candidate => candidate.candidate_status === "PROPOSED_CANDIDATE"
  && candidate.cutover_status === "NOT_APPROVED_FOR_CUTOVER"
  && candidate.unverified_per_issue_evidence.includes("LegacySnapshot")
  && candidate.unverified_per_issue_evidence.includes("TrustedAuthorityReader")));
assert.ok(report.candidates.every(candidate => candidate.target_product.id === "10027"
  && candidate.target_product.value === "dev-harness"
  && candidate.target_component.id === "10028"
  && candidate.target_component.value === "backend"
  && Array.isArray(candidate.target_concerns) && candidate.target_concerns.length === 0));
assert.deepEqual(report.protected_issue_keys, ["RPL-112", "RPL-113", "RPL-114"]);
assert.deepEqual(report.protected_keys_not_in_snapshot, ["RPL-122", "RPL-124"]);
assert.ok(report.candidates.every(candidate => candidate.status === "NOT_READY"
  && candidate.missing_evidence.includes("OriginRef")
  && candidate.missing_evidence.includes("ChangelogRef")
  && candidate.missing_evidence.includes("OwnerApprovalRef")
  && candidate.missing_evidence.includes("CutoverApprovalRef")));
assert.ok(report.candidates.every(candidate => candidate.g2_target_fields_present
  && candidate.g2_legacy_baseline_present));
assert.equal(report.candidates.some(candidate => ["RPL-112", "RPL-113", "RPL-114", "RPL-122", "RPL-124"].includes(candidate.issue_key)), false);
assert.ok(report.source.snapshot_ref.includes("#blob=" + sourceFor(text).blob_sha));
assert.equal(JSON.stringify(report).includes("synthetic test-only issue"), false,
  "candidate output must not copy issue summaries or full snapshot rows");
console.log("PASS: pinned G2 contract yields 106 supported, 3 protected, 103 candidates, and 12 unsupported without copying issue contents");

const wrongBlobSource = { ...sourceFor(text), blob_sha: "0".repeat(40) };
assert.equal(buildG3CutoverPreflightReport(text, { source: wrongBlobSource }).status, "BLOCKED");
console.log("PASS: a mismatched Git Blob SHA blocks the preflight");

const partialEvidence = fixture();
const evidenceCandidate = partialEvidence.current_118.find(item => !["RPL-112", "RPL-113", "RPL-114"].includes(item.key)
  && ["10007", "10009", "10010", "10012", "10013"].includes(item.fields.issuetype.id));
evidenceCandidate.g3_cutover_evidence = { origin_ref: "origin:verified", changelog_ref: "changelog:verified",
  owner_approval_ref: "owner:approval", cutover_approval_ref: "cutover:approval" };
const partialText = JSON.stringify(partialEvidence);
const partialReport = buildG3CutoverPreflightReport(partialText, { source: sourceFor(partialText) });
const statusWithRefs = partialReport.candidates.find(candidate => candidate.issue_key === evidenceCandidate.key);
assert.equal(statusWithRefs.status, "TRUSTED_READER_VERIFICATION_REQUIRED");
assert.deepEqual(statusWithRefs.missing_evidence, []);
assert.equal(partialReport.summary.candidate_cutover_ready, 0,
  "references alone must never promote a candidate to READY");
assert.equal(partialReport.summary.candidate_reader_verification_pending, 1);
console.log("PASS: evidence reference presence remains pending until trusted Reader verification");

const duplicate = fixture();
duplicate.current_118[1].key = duplicate.current_118[0].key;
const duplicateText = JSON.stringify(duplicate);
assert.equal(buildG3CutoverPreflightReport(duplicateText, { source: sourceFor(duplicateText) }).status, "BLOCKED");
console.log("PASS: duplicate IssueKeys block the preflight");

const missingTarget = fixture();
missingTarget.current_118.find(item => item.key !== "RPL-112" && item.key !== "RPL-113" && item.key !== "RPL-114").fields.customfield_10108 = null;
const missingTargetText = JSON.stringify(missingTarget);
const missingTargetReport = buildG3CutoverPreflightReport(missingTargetText, { source: sourceFor(missingTargetText) });
assert.equal(missingTargetReport.status, "BLOCKED");
console.log("PASS: incomplete Target storage blocks the preflight");

const sampleKey = report.candidates[0].issue_key;
const calls = { legacy: 0, target: 0, jira: 0 };
const authorityReader = createG3AuthorityReader({
  resolveLegacyEvidence: async () => { calls.legacy++; return null; },
  targetReader: { async readVerifiedClassification() { calls.target++; return null; } },
  jira: { async read() { calls.jira++; return null; } },
});
const authority = await authorityReader.readClassification(sampleKey);
assert.equal(authority.origin, "UNKNOWN_ORIGIN");
assert.equal(authority.read_authority, "none");
assert.equal(authority.write_authority, "frozen");
assert.equal(calls.legacy, 1);
assert.equal(calls.target, 0);
assert.equal(calls.jira, 0);
console.log("PASS: candidate preflight status does not grant authority; Reader remains UNKNOWN without verified evidence");

const sourceHash = createHash("sha256").update(text, "utf8").digest("hex");
assert.equal(report.source.content_sha256, sourceHash);

const withConcerns = fixture();
const withConcernCandidate = withConcerns.current_118.find(row => row.key !== "RPL-112"
  && row.key !== "RPL-113" && row.key !== "RPL-114"
  && ["10007", "10009", "10010", "10012", "10013"].includes(row.fields.issuetype.id));
withConcernCandidate.fields.customfield_10110 = [{ id: "10033", value: "auth" }];
const withConcernReport = reportFor(withConcerns).report;
const concernOutput = withConcernReport.candidates.find(row => row.issue_key === withConcernCandidate.key);
assert.deepEqual(concernOutput.target_concerns, [{ id: "10033", value: "auth" }]);
console.log("PASS: optional Concern ID/value survives read-only candidate projection");

const corruptOption = fixture();
corruptOption.current_118.find(row => row.key !== "RPL-112").fields.customfield_10108.value = "";
assert.equal(reportFor(corruptOption).report.status, "BLOCKED");
const corruptConcern = fixture();
corruptConcern.current_118.find(row => row.key !== "RPL-112").fields.customfield_10110
  = [{ id: "10033", value: "auth" }, { id: "10033", value: "auth" }];
assert.equal(reportFor(corruptConcern).report.status, "BLOCKED");
console.log("PASS: missing option names and duplicated Concern options fail closed");

// Optional private-source verification; never check the 683 KB G2 audit into this public repository.
if (process.env.JIRA_G2_SNAPSHOT_PATH) {
  const real = buildG3CutoverPreflightReport(readFileSync(process.env.JIRA_G2_SNAPSHOT_PATH, "utf8"));
  assert.equal(real.status, "PREFLIGHT_ONLY", JSON.stringify(real));
  assert.equal(real.summary.candidate_rows, 103);
  assert.equal(real.summary.candidate_cutover_ready, 0);
  assert.deepEqual(real.protected_issue_keys, ["RPL-112", "RPL-113", "RPL-114"]);
  assert.ok(real.candidates.every(row => row.candidate_status === "PROPOSED_CANDIDATE"
    && row.cutover_status === "NOT_APPROVED_FOR_CUTOVER" && row.target_product.value
    && row.target_component.value && row.unverified_per_issue_evidence.length === 6));
  console.log("PASS: pinned private G2 audit yields exactly 103 unapproved classified candidates");
}

const candidateManifest = buildG3CutoverCandidateManifest(text, { source: sourceFor(text) });
assert.equal(candidateManifest.status, "READ_ONLY_PROPOSED_CANDIDATES");
assert.equal(candidateManifest.execution_authorized, false);
assert.equal(candidateManifest.cutover_approved, false);
assert.equal(candidateManifest.summary.candidates, 103);
assert.equal(candidateManifest.summary.candidate_cutover_ready, 0);
assert.deepEqual(candidateManifest.summary.candidate_type_counts, {
  Epic: 8, Feature: 33, Task: 49, Bug: 5, Research: 8,
}); // synthetic fixture protected keys have different types from pinned real G2 data
assert.equal(candidateManifest.candidates[0].candidate_status, "PROPOSED_CANDIDATE");
assert.equal(candidateManifest.candidates[0].cutover_status, "NOT_APPROVED_FOR_CUTOVER");
assert.deepEqual(candidateManifest.candidates[0].target_concerns, []);
assert.equal(candidateManifest.candidates.some(row => ["RPL-112", "RPL-113", "RPL-114"]
  .includes(row.issue_key)), false);
assert.ok(candidateManifest.candidates.every(row => row.g3_evidence_status.authority_reader
  === "NOT_VERIFIED"));
assert.equal(buildG3CutoverCandidateManifest("{}", { source: sourceFor("{}") }).status, "BLOCKED");
console.log("PASS: deterministic 103-row candidate Manifest preserves fields while denying cutover");

const output = [];
const cliCode = await runG3CutoverCandidateManifestCli(["/fake/private-source.json"], {
  readInput: async () => text,
  writeOutput: chunk => output.push(chunk),
});
assert.equal(cliCode, 1, "synthetic JSON must not pass the hard-pinned production Blob SHA");
assert.equal(JSON.parse(output.join("")).status, "BLOCKED");
console.log("PASS: candidate CLI blocks a synthetic source when production pinned Blob does not match");
