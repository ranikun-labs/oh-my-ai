#!/usr/bin/env node
// FX-MP: model-policy fixtures. Synthetic "example" IDs in temp dirs only.
// Never reads the real $HOME or XDG config: every env is passed explicitly.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  describeActivePolicy, readPolicyFile, resolveModelSelection, rollbackPolicy, validateModelPolicy,
} from "./lib/model-policy.mjs";
import { preflightDispatch } from "./lib/agent-manifest-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CLI = path.join(here, "model-policy.mjs");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODES = ["standard", "fast"];
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "model-policy-test-"));
const fakeHome = path.join(sandbox, "home");
fs.mkdirSync(fakeHome);

const tuple = (model, effort = "high", mode = "standard", provider = "example") => ({ provider, model, effort, mode });
const req = (model, effort = "high", mode = "standard", provider = "example") => ({ provider, model, effort, mode });
const RUNTIME = { example: { models: ["example-small", "example-large"], efforts: [...EFFORTS], modes: [...MODES] } };

function basePolicy(overrides = {}) {
  return {
    schema_version: 1,
    policy_version: "v2",
    previous_version: null,
    models: [
      { provider: "example", id: "example-small", enabled: true,
        efforts: { low: true, medium: true, high: true, xhigh: false, max: false },
        modes: { standard: true, fast: false } },
      { provider: "example", id: "example-large", enabled: true,
        efforts: { low: true, medium: true, high: true, xhigh: true, max: true },
        modes: { standard: true, fast: true } },
    ],
    roles: { writer: [tuple("example-small", "high", "standard"), tuple("example-large", "high", "fast")] },
    cost_limits: { "example-task": { requires_approval: true } },
    substitutions: [],
    evaluation_ref: "eval-ref-a",
    ...overrides,
  };
}
const withModel = (policy, id, patch) => {
  const copy = structuredClone(policy);
  Object.assign(copy.models.find(m => m.id === id), patch);
  return copy;
};
const resolve = (policy, role, requested, runtime = RUNTIME, extra = {}) =>
  resolveModelSelection({ policy, role, requested, runtimeCapabilities: runtime, ...extra });
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

const writerManifest = () => ({
  agent_id: "writer-fx", role: "writer", task: "Implement the approved bounded change", permissions: "scoped-write",
  requested: { provider: "example", model: "example-small", reasoning: "high", fast: false },
  runtime: { id: "example-runtime" },
  authorization: { status: "approved", scope: "approved bounded change", evidence_ref: "owner-scope-1" },
  target: { repo: "example/example-repository", branch: "feature/approved-scope", primary_jira: "EXAMPLE-123" },
});
const writerCapability = () => ({
  runtime_id: "example-runtime", verification_ref: "runtime-observation-1",
  model_selection: { supported: true, evidence_ref: "model-available" },
  reasoning_selection: { supported: true, evidence_ref: "effort-available" },
  fast_override: { supported: true, evidence_ref: "fast-available" },
});

const cases = [];
const check = (name, fn) => cases.push({ name, fn });

check("FX-MP-001 model OFF denies every effort and mode", () => {
  const policy = withModel(basePolicy(), "example-small", { enabled: false });
  for (const effort of EFFORTS) for (const mode of MODES) {
    const r = resolve(policy, "writer", req("example-small", effort, mode));
    assert.equal(r.status, "DENY");
    assert.equal(r.code, "MODEL_DISABLED");
  }
});

check("FX-MP-002 model ON but effort OFF denies; listed effort allows", () => {
  const policy = basePolicy();
  assert.equal(resolve(policy, "writer", req("example-small", "xhigh", "standard")).code, "EFFORT_DISABLED");
  assert.equal(resolve(policy, "writer", req("example-small", "max", "standard")).code, "EFFORT_DISABLED");
  assert.equal(resolve(policy, "writer", req("example-small", "high", "standard")).status, "ALLOW");
});

check("FX-MP-003 fast OFF denies fast while standard is allowed", () => {
  const policy = basePolicy();
  assert.equal(resolve(policy, "writer", req("example-small", "high", "fast")).code, "MODE_DISABLED");
  assert.equal(resolve(policy, "writer", req("example-small", "high", "standard")).status, "ALLOW");
});

check("FX-MP-004 role not allowed denies (unknown role, unlisted tuple)", () => {
  const policy = basePolicy();
  assert.equal(resolve(policy, "reviewer", req("example-small", "high", "standard")).code, "ROLE_NOT_ALLOWED");
  assert.equal(resolve(policy, "ghost", req("example-small", "high", "standard")).code, "ROLE_NOT_ALLOWED");
  assert.equal(resolve(policy, "writer", req("example-small", "low", "standard")).code, "ROLE_NOT_ALLOWED");
});

check("FX-MP-005 unknown model and unknown provider deny (unlisted = disabled)", () => {
  const policy = basePolicy();
  assert.equal(resolve(policy, "writer", req("example-unlisted", "high", "standard")).code, "UNKNOWN_MODEL");
  assert.equal(resolve(policy, "writer", req("example-small", "high", "standard", "other")).code, "UNKNOWN_MODEL");
});

check("FX-MP-006 substitution only when the exact pair is listed; no implicit fallback", () => {
  const requested = req("example-large", "high", "standard");
  const substitute = req("example-small", "high", "standard");
  const disabled = withModel(basePolicy(), "example-large", { enabled: false });
  // No implicit fallback: without an explicit substitute the denial stands.
  assert.equal(resolve(disabled, "writer", requested).code, "MODEL_DISABLED");
  // Substitute passed but pair not listed.
  assert.equal(resolve(disabled, "writer", requested, RUNTIME, { substitute }).code, "SUBSTITUTION_NOT_APPROVED");
  // Pair listed for a different target: still not approved.
  const other = { ...basePolicy({ substitutions: [{ from: requested, to: req("example-large", "medium", "standard") }] }) };
  assert.equal(resolve(withModel(other, "example-large", { enabled: false }), "writer", requested, RUNTIME, { substitute }).code, "SUBSTITUTION_NOT_APPROVED");
  // Exact pair listed: substitute evaluated in full and allowed.
  const approved = withModel(basePolicy({ substitutions: [{ from: requested, to: substitute }] }), "example-large", { enabled: false });
  const allowed = resolve(approved, "writer", requested, RUNTIME, { substitute });
  assert.equal(allowed.status, "ALLOW");
  assert.deepEqual(allowed.resolved, substitute);
  assert.deepEqual(allowed.substituted_for, requested);
  // Pair listed but the substitute is itself disabled: denied with the substitute's code.
  const deadSub = withModel(approved, "example-small", { enabled: false });
  assert.equal(resolve(deadSub, "writer", requested, RUNTIME, { substitute }).code, "MODEL_DISABLED");
  // A listed approval never bypasses a runtime gap for the substitute.
  assert.equal(resolve(approved, "writer", requested, {}, { substitute }).code, "RUNTIME_UNSUPPORTED");
});

check("FX-MP-007 invalid policy yields POLICY_INVALID", () => {
  const mutators = {
    "schema_version 2": p => { p.schema_version = 2; },
    "unknown effort key": p => { p.models[0].efforts.ultra = true; },
    "unknown mode key": p => { p.models[0].modes.turbo = true; },
    "duplicate model": p => { p.models.push(structuredClone(p.models[0])); },
    "role references unknown model": p => { p.roles.writer.push(tuple("example-ghost")); },
    "previous_version equals policy_version": p => { p.previous_version = "v2"; },
    "unsafe policy_version": p => { p.policy_version = "bad/version"; },
    "unknown top-level key": p => { p.secret_thing = true; },
    "missing roles": p => { delete p.roles; },
    "non-boolean enabled": p => { p.models[0].enabled = "yes"; },
  };
  for (const [name, mutate] of Object.entries(mutators)) {
    const policy = basePolicy();
    mutate(policy);
    assert.equal(validateModelPolicy(policy).valid, false, name);
    assert.equal(resolve(policy, "writer", req("example-small", "high", "standard")).code, "POLICY_INVALID", name);
  }
  const file = path.join(sandbox, "invalid-json.json");
  fs.writeFileSync(file, "{not json");
  assert.equal(readPolicyFile(file).status, "POLICY_INVALID");
});

check("FX-MP-008 missing policy yields POLICY_MISSING; require-policy blocks; default is unchanged", () => {
  assert.equal(resolve(undefined, "writer", req("example-small")).code, "POLICY_MISSING");
  assert.equal(readPolicyFile(path.join(sandbox, "does-not-exist.json")).status, "POLICY_MISSING");
  const manifest = writerManifest();
  assert.equal(preflightDispatch(manifest, writerCapability()).status, "READY");
  const required = preflightDispatch(manifest, writerCapability(), { requireModelPolicy: true });
  assert.equal(required.status, "BLOCKED");
  assert.equal(required.code, "POLICY_MISSING");
});

check("FX-MP-009 rollback swaps to archived copy, 0600, refuses without copy and never auto-runs", () => {
  const dir = path.join(sandbox, "rollback-ok");
  fs.mkdirSync(dir);
  const active = path.join(dir, "model-policy.json");
  writeJson(path.join(dir, "model-policy.v1.json"), basePolicy({ policy_version: "v1", previous_version: null }));
  writeJson(active, basePolicy({ policy_version: "v2", previous_version: "v1" }));
  const env = { HOME: fakeHome, OH_MY_AI_MODEL_POLICY: active };
  const outcome = rollbackPolicy(env);
  assert.equal(outcome.code, "ROLLED_BACK");
  assert.equal(JSON.parse(fs.readFileSync(active, "utf8")).policy_version, "v1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "model-policy.v2.json"), "utf8")).policy_version, "v2");
  assert.equal(fs.statSync(active).mode & 0o777, 0o600);
  // Active now declares previous_version null: a second rollback is refused and changes nothing.
  const before = fs.readFileSync(active, "utf8");
  assert.equal(rollbackPolicy(env).code, "POLICY_INVALID");
  assert.equal(fs.readFileSync(active, "utf8"), before);

  const missing = path.join(sandbox, "rollback-nocopy");
  fs.mkdirSync(missing);
  const activeNoCopy = path.join(missing, "model-policy.json");
  writeJson(activeNoCopy, basePolicy({ policy_version: "v2", previous_version: "v1" }));
  const snapshot = fs.readFileSync(activeNoCopy, "utf8");
  assert.equal(rollbackPolicy({ HOME: fakeHome, OH_MY_AI_MODEL_POLICY: activeNoCopy }).code, "POLICY_MISSING");
  assert.equal(fs.readFileSync(activeNoCopy, "utf8"), snapshot);
});

check("FX-MP-010 evaluation_ref never changes a decision", () => {
  const variants = [basePolicy({ evaluation_ref: "ref-a" }), basePolicy({ evaluation_ref: "ref-b" }), basePolicy({ evaluation_ref: null })];
  const requests = [req("example-small", "high", "standard"), req("example-small", "xhigh", "standard"), req("example-small", "high", "fast"), req("example-large", "high", "fast")];
  for (const r of requests) {
    const outputs = variants.map(v => JSON.stringify(resolve(v, "writer", r)));
    assert.equal(new Set(outputs).size, 1, JSON.stringify(r));
  }
});

check("FX-MP-011 runtime capability is checked separately and fails closed", () => {
  const policy = basePolicy();
  // Omitted runtimeCapabilities (no default substitution here) must fail closed.
  const noRuntime = resolveModelSelection({ policy, role: "writer", requested: req("example-small", "high", "standard") });
  assert.equal(noRuntime.code, "RUNTIME_UNSUPPORTED");
  const noFast = { example: { models: ["example-large"], efforts: [...EFFORTS], modes: ["standard"] } };
  assert.equal(resolve(policy, "writer", req("example-large", "high", "fast"), noFast).code, "RUNTIME_UNSUPPORTED");
  // Policy denial takes precedence over runtime evidence.
  const disabled = withModel(policy, "example-small", { enabled: false });
  const denied = resolveModelSelection({ policy: disabled, role: "writer", requested: req("example-small", "high", "standard") });
  assert.equal(denied.code, "MODEL_DISABLED");
});

check("FX-MP-012 provider-compat with a real public model ID (temp policy only)", () => {
  const policy = basePolicy({
    models: [{ provider: "anthropic", id: "claude-haiku-5-5", enabled: true,
      efforts: { high: true, xhigh: true }, modes: { standard: true } }],
    roles: { writer: [tuple("claude-haiku-5-5", "high", "standard", "anthropic")] },
  });
  const runtime = { anthropic: { models: ["claude-haiku-5-5"], efforts: ["high"], modes: ["standard"] } };
  assert.equal(resolve(policy, "writer", req("claude-haiku-5-5", "high", "standard", "anthropic"), runtime).status, "ALLOW");
  assert.equal(resolve(policy, "writer", req("claude-haiku-5-5", "xhigh", "standard", "anthropic"), runtime).code, "ROLE_NOT_ALLOWED");
  const widened = structuredClone(policy);
  widened.roles.writer.push(tuple("claude-haiku-5-5", "xhigh", "standard", "anthropic"));
  assert.equal(resolve(widened, "writer", req("claude-haiku-5-5", "xhigh", "standard", "anthropic"), runtime).code, "RUNTIME_UNSUPPORTED");
});

check("FX-MP-013 describeActivePolicy summarizes only the given path", () => {
  const dir = path.join(sandbox, "describe");
  fs.mkdirSync(dir);
  const active = path.join(dir, "model-policy.json");
  writeJson(active, basePolicy({ previous_version: "v1" }));
  const summary = describeActivePolicy({ HOME: fakeHome, OH_MY_AI_MODEL_POLICY: active });
  assert.equal(summary.status, "VALID");
  assert.equal(summary.policy_version, "v2");
  assert.equal(summary.previous_copy_available, false);
  assert.deepEqual(summary.roles, ["writer"]);
  assert.deepEqual(summary.enabled_models.map(m => m.id), ["example-small", "example-large"]);
  const absent = describeActivePolicy({ HOME: fakeHome, OH_MY_AI_MODEL_POLICY: path.join(dir, "nope.json") });
  assert.equal(absent.status, "POLICY_MISSING");
});

check("FX-MP-014 example template validates as a placeholder policy", () => {
  const file = path.join(root, "profiles/example/model-policy.json.example");
  const read = readPolicyFile(file);
  assert.equal(read.status, "VALID", read.errors.join("; "));
  assert.equal(read.policy.models.some(m => m.enabled === true), false);
});

check("FX-MP-015 guard gate: policy ALLOW/DENY, fail-closed runtime, no-option behavior unchanged", () => {
  const manifest = writerManifest();
  const cap = writerCapability();
  const policy = basePolicy();
  assert.equal(preflightDispatch(manifest, cap, { modelPolicy: policy, runtimeModelCapabilities: RUNTIME }).status, "READY");
  const denied = preflightDispatch(manifest, cap, { modelPolicy: withModel(policy, "example-small", { enabled: false }), runtimeModelCapabilities: RUNTIME });
  assert.equal(denied.status, "BLOCKED");
  assert.equal(denied.code, "MODEL_DISABLED");
  const fastManifest = writerManifest();
  fastManifest.requested.fast = true;
  assert.equal(preflightDispatch(fastManifest, cap, { modelPolicy: policy, runtimeModelCapabilities: RUNTIME }).code, "MODE_DISABLED");
  assert.equal(preflightDispatch(manifest, cap, { modelPolicy: policy }).code, "RUNTIME_UNSUPPORTED");
});

check("FX-MP-016 CLI status, check, usage exit codes (temp env only)", () => {
  const dir = path.join(sandbox, "cli");
  fs.mkdirSync(dir);
  const active = path.join(dir, "model-policy.json");
  const runtimeFile = path.join(dir, "runtime.json");
  writeJson(active, basePolicy());
  writeJson(runtimeFile, RUNTIME);
  const run = args => spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: fakeHome, OH_MY_AI_MODEL_POLICY: active },
  });
  const status = run(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, "VALID");
  const allow = run(["check", "--role", "writer", "--model", "example-small", "--effort", "high", "--mode", "standard", "--runtime-capabilities", runtimeFile]);
  assert.equal(allow.status, 0, allow.stdout);
  assert.equal(JSON.parse(allow.stdout).code, "ALLOW");
  const deny = run(["check", "--role", "writer", "--model", "example-small", "--effort", "high", "--mode", "fast", "--runtime-capabilities", runtimeFile]);
  assert.equal(deny.status, 1);
  assert.equal(JSON.parse(deny.stdout).code, "MODE_DISABLED");
  assert.equal(run(["check", "--role", "writer"]).status, 2);
});

let passed = 0;
const failures = [];
for (const { name, fn } of cases) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${error.message.split("\n")[0]}`);
  }
}
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`FX-MP: ${passed}/${cases.length} fixtures passed`);
if (failures.length) process.exitCode = 1;
