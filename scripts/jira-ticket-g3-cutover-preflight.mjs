#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildG3CutoverPreflightReport } from "./lib/jira-ticket-g3-cutover-preflight.mjs";

export async function runG3CutoverPreflightCli(argv = process.argv.slice(2), {
  readInput = readFile,
  writeOutput = value => process.stdout.write(value),
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 1) {
    writeOutput(`${JSON.stringify({ schema_version: 1, status: "BLOCKED", reason: "provide exactly one pinned G2 snapshot JSON file", execution_authorized: false, jira_write_count: 0, candidates: [] }, null, 2)}\n`);
    return 2;
  }
  let text;
  try { text = await readInput(resolve(argv[0]), "utf8"); }
  catch {
    writeOutput(`${JSON.stringify({ schema_version: 1, status: "BLOCKED", reason: "G2 snapshot file could not be read", execution_authorized: false, jira_write_count: 0, candidates: [] }, null, 2)}\n`);
    return 1;
  }
  const report = buildG3CutoverPreflightReport(text);
  writeOutput(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === "PREFLIGHT_ONLY" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runG3CutoverPreflightCli();
