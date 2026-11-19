#!/usr/bin/env node
// RPL-116 standalone manifest-shape preflight CLI (not a runtime dispatch guard).
// A successful check means fields are present; it does not prove approval,
// effective agent settings, or safe runtime capability.
import fs from "node:fs";
import { validateAgentManifest } from "./lib/agent-manifest-guard.mjs";

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  console.error("usage: node scripts/validate-agent-manifest.mjs <manifest.json>");
  process.exit(2);
}
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(JSON.stringify({status:"BLOCKED", code:"F4_PROMPT_INVALID", reasons:["unreadable manifest: " + error.message]}));
  process.exit(2);
}
const verdict = validateAgentManifest(manifest);
console.log(JSON.stringify(verdict));
process.exit(verdict.status === "VALID" ? 0 : 1);
