#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCodexReadOnly } from "./lib/cross-runtime-codex-runner.mjs";

export async function main(args, run = runCodexReadOnly, read = readFileSync) {
  if (args.length !== 4 || args[0] !== "--request" || args[2] !== "--prompt") {
    return { exitCode: 2, error: "Usage: node scripts/cross-runtime-codex-run.mjs --request <json> --prompt <txt>" };
  }
  try {
    const request = JSON.parse(read(args[1], "utf8"));
    request.promptText = read(args[3], "utf8");
    const result = await run(request);
    return { exitCode: { SUCCEEDED: 0, BLOCKED: 3, INDETERMINATE: 4, FAILED: 5 }[result.status] ?? 4, result };
  } catch {
    return { exitCode: 3, result: { status: "BLOCKED", code: "REQUEST_INVALID",
      attemptBoundary: { claim_status: "NOT_ACQUIRED", dispatch_status: "NOT_RUN" } } };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const response = await main(process.argv.slice(2));
  if (response.error) console.error(response.error);
  else console.log(JSON.stringify(response.result));
  process.exitCode = response.exitCode;
}
