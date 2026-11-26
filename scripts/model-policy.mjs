#!/usr/bin/env node
// Standalone model-policy CLI. Intended to be wired into `ohmyai` later (PR #219).
// Usage:
//   model-policy.mjs status
//   model-policy.mjs validate [FILE] [--runtime-capabilities FILE]
//   model-policy.mjs check --role R --model M --effort E --mode X [--provider P] [--runtime-capabilities FILE]
//   model-policy.mjs diff CANDIDATE
//   model-policy.mjs apply CANDIDATE
//   model-policy.mjs rollback
// Path rules (docs/contracts/model-policy.md):
//   validate / diff / check  -> OH_MY_AI_MODEL_POLICY if set, else the default location (dry, never execution)
//   status / apply / rollback -> execution location (default; override only if the active file sets allow_path_override)
// Exit: 0 ok/ALLOW/valid, 1 DENY/invalid/refused, 2 usage error.
import fs from "node:fs";
import path from "node:path";
import {
  applyPolicy, describeActivePolicy, diffPolicies, readPolicyFile, resolveDryPolicy, resolveDryPolicyPath,
  resolveModelSelection, rollbackPolicy,
} from "./lib/model-policy.mjs";

const USAGE = "usage: model-policy.mjs status [--show-approver] | validate [FILE] [--runtime-capabilities F] | check --role R --model M --effort E --mode X [--provider P] [--runtime-capabilities F] | diff CANDIDATE | apply CANDIDATE | rollback";

const BOOLEAN_FLAGS = new Set(["show-approver"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      if (BOOLEAN_FLAGS.has(arg.slice(2))) { flags[arg.slice(2)] = true; continue; }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return null;
      flags[arg.slice(2)] = value;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function loadRuntimeCapabilities(file) {
  if (file === undefined) return { value: undefined };
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { error: "runtime-capabilities file unreadable or not JSON" };
  }
}

function runValidate(positional, flags, env) {
  const runtime = loadRuntimeCapabilities(flags["runtime-capabilities"]);
  if (runtime.error) { process.stderr.write(runtime.error + "\n"); return 2; }
  const target = positional[0] ? path.resolve(positional[0]) : resolveDryPolicyPath(env);
  const read = readPolicyFile(target, { runtimeCapabilities: runtime.value });
  const out = { path: target, status: read.status, policy_status: read.policy ? read.policy.status : null, errors: read.errors };
  print(out);
  return read.status === "VALID" ? 0 : 1;
}

// Interactive confirmation for apply. The operator must type the candidate's policy_version.
// Reads one line from stdin (a TTY here: applyPolicy denies earlier when it is not).
function ttyConfirm(summary) {
  process.stderr.write(`apply ${summary.from_version ?? "(none)"} -> ${summary.to_version} at ${summary.path}\n`
    + `declared approved_by: ${summary.approved_by}\nType ${summary.to_version} to confirm: `);
  const buf = Buffer.alloc(256);
  let n;
  try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { return false; }
  return buf.toString("utf8", 0, n).trim() === summary.to_version;
}

function runCheck(flags, env) {
  for (const name of ["role", "model", "effort", "mode"]) {
    if (!flags[name]) { process.stderr.write(USAGE + "\n"); return 2; }
  }
  const dry = resolveDryPolicy(env);
  const read = readPolicyFile(dry.path);
  let provider = flags.provider;
  if (!provider && read.policy) {
    const matches = read.policy.models.filter(m => m.id === flags.model);
    provider = matches.length === 1 ? matches[0].provider : undefined;
  }
  const runtime = loadRuntimeCapabilities(flags["runtime-capabilities"]);
  if (runtime.error) { process.stderr.write(runtime.error + "\n"); return 2; }
  const verdict = resolveModelSelection({
    policy: read.policy ?? undefined,
    role: flags.role,
    requested: { provider, model: flags.model, effort: flags.effort, mode: flags.mode },
    runtimeCapabilities: runtime.value,
  });
  if (verdict.status !== "ALLOW" && read.status !== "VALID") verdict.reasons = [...read.errors, ...verdict.reasons];
  // Provenance: a dry check is never execution approval. dry_run marks an override result explicitly.
  const out = { ...verdict, policy_path: dry.path, via: dry.via };
  if (dry.via === "override") out.dry_run = true;
  print(out);
  return verdict.status === "ALLOW" ? 0 : 1;
}

function runDiff(positional, env) {
  if (!positional[0]) { process.stderr.write(USAGE + "\n"); return 2; }
  const candidatePath = path.resolve(positional[0]);
  const candidate = readPolicyFile(candidatePath);
  if (candidate.status !== "VALID") {
    print({ path: candidatePath, status: candidate.status, errors: candidate.errors });
    return 1;
  }
  const activePath = resolveDryPolicyPath(env);
  const active = readPolicyFile(activePath);
  const activePolicy = active.status === "VALID" ? active.policy : null;
  print({ active_path: activePath, active_status: active.status, ...diffPolicies(activePolicy, candidate.policy) });
  return 0;
}

function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  const parsed = parseArgs(rest);
  if (!command || parsed === null) { process.stderr.write(USAGE + "\n"); return 2; }
  const { positional, flags } = parsed;
  if (command === "status") {
    const summary = describeActivePolicy(env, { showApprover: flags["show-approver"] === true });
    print(summary);
    return summary.status === "VALID" ? 0 : 1;
  }
  if (command === "validate") return runValidate(positional, flags, env);
  if (command === "check") return runCheck(flags, env);
  if (command === "diff") return runDiff(positional, env);
  if (command === "apply") {
    if (!positional[0]) { process.stderr.write(USAGE + "\n"); return 2; }
    const outcome = applyPolicy(env, positional[0], { isTTY: process.stdin.isTTY === true, confirm: ttyConfirm });
    print(outcome);
    return outcome.code === "APPLIED" ? 0 : 1;
  }
  if (command === "rollback") {
    const outcome = rollbackPolicy(env);
    print(outcome);
    return outcome.code === "ROLLED_BACK" ? 0 : 1;
  }
  process.stderr.write(USAGE + "\n");
  return 2;
}

process.exitCode = main(process.argv.slice(2));
