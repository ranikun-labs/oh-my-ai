#!/usr/bin/env node

import { boundedJsonlLines, summarizeCodexExecJsonl } from "./lib/role-usage-summary.mjs";
import { usageF1Cell } from "./lib/usage-f1.mjs";

const USAGE = "usage: node scripts/role-usage.mjs --role <role> --agent-id <id> --run-id <id> [--f1-cell] < codex-exec.jsonl";

function parseArgs(args) {
  const values = new Map();
  let f1Cell = false;
  const allowed = new Set(["--role", "--agent-id", "--run-id"]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--help") return { help: true };
    if (option === "--f1-cell") {
      if (f1Cell) throw new Error("duplicate option: --f1-cell");
      f1Cell = true;
      continue;
    }
    if (!allowed.has(option)) throw new Error(`unknown option: ${option}`);
    if (values.has(option)) throw new Error(`duplicate option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${option}`);
    values.set(option, value);
    index += 1;
  }

  const role = values.get("--role");
  const agentId = values.get("--agent-id");
  const runId = values.get("--run-id");
  if (!role || !agentId || !runId) throw new Error("--role, --agent-id, and --run-id are required");
  return { callerScope: { role, agentId, runId }, f1Cell };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${USAGE}\ninvalid_arguments: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (process.stdin.isTTY) {
    process.stderr.write(`${USAGE}\nstdin must contain one caller-asserted codex exec --json JSONL stream\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const lines = boundedJsonlLines(process.stdin);
    const summary = await summarizeCodexExecJsonl(lines, parsed.callerScope);
    process.stdout.write(`${parsed.f1Cell ? usageF1Cell(summary, parsed.callerScope.agentId, parsed.callerScope.runId) : JSON.stringify(summary)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid usage input";
    process.stderr.write(`role-usage failed: ${message}\n`);
    process.exitCode = 2;
  }
}

main();
