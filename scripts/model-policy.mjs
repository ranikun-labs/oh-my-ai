#!/usr/bin/env node
// Standalone model-policy CLI. Intended to be wired into `ohmyai` later (PR #219).
// Usage:
//   model-policy.mjs status
//   model-policy.mjs validate
//   model-policy.mjs check --role R --model M --effort E --mode X [--provider P] [--runtime-capabilities FILE]
//   model-policy.mjs rollback
// Policy path: OH_MY_AI_MODEL_POLICY, else ${XDG_CONFIG_HOME:-~/.config}/oh-my-ai/model-policy.json.
// Exit: 0 ok/ALLOW/valid, 1 DENY/invalid/refused, 2 usage error.
import fs from "node:fs";
import { describeActivePolicy, readPolicyFile, resolveModelSelection, resolvePolicyPath, rollbackPolicy } from "./lib/model-policy.mjs";

const USAGE = "usage: model-policy.mjs status | validate | check --role R --model M --effort E --mode X [--provider P] [--runtime-capabilities FILE] | rollback";

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--") || argv[i + 1] === undefined) return null;
    flags[key.slice(2)] = argv[i + 1];
  }
  return flags;
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function runCheck(flags, env) {
  for (const name of ["role", "model", "effort", "mode"]) {
    if (!flags[name]) { process.stderr.write(USAGE + "\n"); return 2; }
  }
  const read = readPolicyFile(resolvePolicyPath(env));
  let provider = flags.provider;
  if (!provider && read.policy) {
    const matches = read.policy.models.filter(m => m.id === flags.model);
    provider = matches.length === 1 ? matches[0].provider : undefined;
  }
  let runtimeCapabilities;
  if (flags["runtime-capabilities"]) {
    try {
      runtimeCapabilities = JSON.parse(fs.readFileSync(flags["runtime-capabilities"], "utf8"));
    } catch {
      process.stderr.write("runtime-capabilities file unreadable or not JSON\n");
      return 2;
    }
  }
  const verdict = resolveModelSelection({
    policy: read.policy,
    role: flags.role,
    requested: { provider, model: flags.model, effort: flags.effort, mode: flags.mode },
    runtimeCapabilities,
  });
  print(verdict);
  return verdict.status === "ALLOW" ? 0 : 1;
}

function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (!command || flags === null) { process.stderr.write(USAGE + "\n"); return 2; }
  if (command === "status" || command === "validate") {
    const summary = describeActivePolicy(env);
    print(command === "validate" ? { path: summary.path, status: summary.status, errors: summary.errors } : summary);
    return summary.status === "VALID" ? 0 : 1;
  }
  if (command === "check") return runCheck(flags, env);
  if (command === "rollback") {
    const outcome = rollbackPolicy(env);
    print(outcome);
    return outcome.code === "ROLLED_BACK" ? 0 : 1;
  }
  process.stderr.write(USAGE + "\n");
  return 2;
}

process.exitCode = main(process.argv.slice(2));
