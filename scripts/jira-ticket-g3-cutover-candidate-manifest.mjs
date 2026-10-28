#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildG3CutoverPreflightReport } from "./lib/jira-ticket-g3-cutover-preflight.mjs";

const REQUIRED_G3_VERIFICATION = Object.freeze([
  "per_issue_legacy_snapshot", "origin", "changelog", "owner_approval",
  "cutover_approval", "trusted_authority_reader",
]);
const UNVERIFIED = Object.freeze({
  origin: "NOT_VERIFIED",
  legacy_snapshot: "NOT_VERIFIED_PER_ISSUE",
  changelog: "NOT_VERIFIED",
  owner_approval: "NOT_PROVIDED",
  cutover_approval: "NOT_PROVIDED",
  authority_reader: "NOT_VERIFIED",
});
const CANDIDATE_TYPES = Object.freeze(["Epic", "Feature", "Task", "Bug", "Research"]);

/** Snapshot-only projection. No Jira dependency, authority transition or approval evaluation. */
export function buildG3CutoverCandidateManifest(snapshotText, options) {
  const report = buildG3CutoverPreflightReport(snapshotText, options);
  if (report.status !== "PREFLIGHT_ONLY") {
    return {
      schema_version: 1, record_type: "G3_CUTOVER_CANDIDATE_MANIFEST",
      status: "BLOCKED", execution_authorized: false, cutover_approved: false,
      read_authority_changed: false, jira_read_count: 0, jira_write_count: 0,
      reason: report.reason, candidates: [],
    };
  }
  const candidates = report.candidates.map(row => ({
    issue_key: row.issue_key,
    issue_type: { id: row.issue_type_id, name: row.issue_type },
    target_product: row.target_product,
    target_component: row.target_component,
    target_concerns: row.target_concerns,
    candidate_status: "PROPOSED_CANDIDATE",
    cutover_status: "NOT_APPROVED_FOR_CUTOVER",
    g2_target_storage_status: "VERIFIED_IN_PINNED_G2_RECORD",
    g3_evidence_status: { ...UNVERIFIED },
  }));
  const byType = Object.fromEntries(CANDIDATE_TYPES.map(name => [
    name, candidates.filter(row => row.issue_type.name === name).length,
  ]));
  return {
    schema_version: 1,
    record_type: "G3_CUTOVER_CANDIDATE_MANIFEST",
    status: "READ_ONLY_PROPOSED_CANDIDATES",
    execution_authorized: false,
    cutover_approved: false,
    read_authority_changed: false,
    jira_read_count: 0,
    jira_write_count: 0,
    source: {
      repository: report.source.repository,
      branch: report.source.branch,
      commit_sha: report.source.commit_sha,
      path: report.source.path,
      git_blob_sha: report.source.git_blob_sha,
      verified_at: report.source.verified_at,
      g2_original_snapshot_ref: report.source.g2_original_snapshot_ref,
    },
    summary: {
      g2_rows: report.summary.snapshot_rows,
      supported_type_rows: report.summary.supported_rows,
      protected_origin_unknown_rows: report.summary.protected_rows,
      candidates: report.summary.candidate_rows,
      unsupported_story_rows: report.summary.issue_type_counts["10011"].count,
      unsupported_subtask_rows: report.summary.issue_type_counts["10008"].count,
      candidate_type_counts: byType,
      candidate_cutover_ready: 0,
    },
    protected_issue_keys: report.protected_issue_keys,
    protected_not_in_snapshot: report.protected_keys_not_in_snapshot,
    required_g3_verification: [...REQUIRED_G3_VERIFICATION],
    candidates,
  };
}

export async function runG3CutoverCandidateManifestCli(argv = process.argv.slice(2), {
  readInput = readFile,
  writeOutput = value => process.stdout.write(value),
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 1) {
    writeOutput(JSON.stringify({
      status: "BLOCKED", reason: "provide exactly one private G2 118-row snapshot file",
      execution_authorized: false, cutover_approved: false, candidates: [],
    }) + "\n");
    return 2;
  }
  let raw;
  try { raw = await readInput(resolve(argv[0]), "utf8"); }
  catch {
    writeOutput(JSON.stringify({
      status: "BLOCKED", reason: "pinned G2 snapshot file could not be read",
      execution_authorized: false, cutover_approved: false, candidates: [],
    }) + "\n");
    return 1;
  }
  const result = buildG3CutoverCandidateManifest(raw);
  writeOutput(JSON.stringify(result, null, 2) + "\n");
  return result.status === "READ_ONLY_PROPOSED_CANDIDATES" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runG3CutoverCandidateManifestCli();
