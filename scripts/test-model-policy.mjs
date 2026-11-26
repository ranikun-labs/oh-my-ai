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
  applyPolicy, describeActivePolicy, diffPolicies, loadExecutionPolicy, readPolicyFile, resolveModelSelection,
  resolveDryPolicyPath, resolveExecutionPolicyPath, rollbackPolicy, selectDefault, validateModelPolicy,
} from "./lib/model-policy.mjs";
import { compareEffective, preflightDispatch } from "./lib/agent-manifest-guard.mjs";

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
const APPROVAL = { status: "ACTIVE", approved_by: "owner-fixture", approved_at: "2026-11-25T00:00:00Z" };

const SMALL_HIGH = tuple("example-small", "high", "standard");
const LARGE_FAST = tuple("example-large", "high", "fast");

// Base ACTIVE policy. roles[role] = {allowed, default}; default rules keyed by runtime + risk.
function basePolicy(overrides = {}) {
  return {
    schema_version: 1,
    policy_version: "v2",
    previous_version: null,
    ...APPROVAL,
    models: [
      { provider: "example", family: "example-family", version: "1", id: "example-small", enabled: true,
        efforts: { low: true, medium: true, high: true, xhigh: false, max: false },
        modes: { standard: true, fast: false } },
      { provider: "example", family: "example-family", version: "2", id: "example-large", enabled: true,
        efforts: { low: true, medium: true, high: true, xhigh: true, max: true },
        modes: { standard: true, fast: true } },
    ],
    roles: {
      writer: {
        allowed: [SMALL_HIGH, LARGE_FAST],
        default: [
          { runtime: "example-runtime", risk: "*", ...SMALL_HIGH },
          { runtime: "*", risk: "low", ...SMALL_HIGH },
          { runtime: "*", risk: "*", ...LARGE_FAST },
        ],
      },
    },
    cost_limits: { "example-task": { requires_approval: true } },
    substitutions: [],
    evaluation_ref: "eval-ref-a",
    ...overrides,
  };
}
// Disabling a model also drops role defaults that select it: a default that points at an OFF
// option is POLICY_INVALID by design, so the owner must move the default in the same change.
const withModel = (policy, id, patch) => {
  const copy = structuredClone(policy);
  Object.assign(copy.models.find(m => m.id === id), patch);
  if (patch.enabled === false) {
    for (const entry of Object.values(copy.roles)) entry.default = entry.default.filter(rule => rule.model !== id);
  }
  return copy;
};
const resolve = (policy, role, requested, runtime = RUNTIME, extra = {}) =>
  resolveModelSelection({ policy, role, requested, runtimeCapabilities: runtime, ...extra });
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };

// Isolated env: XDG config under the sandbox; HOME is the fake home. Never the real one.
function isolatedEnv(name, extra = {}) {
  const cfg = path.join(sandbox, name, "cfg");
  fs.mkdirSync(cfg, { recursive: true });
  return {
    env: { HOME: fakeHome, XDG_CONFIG_HOME: cfg, ...extra },
    defaultFile: path.join(cfg, "oh-my-ai", "model-policy.json"),
    dir: path.join(cfg, "oh-my-ai"),
  };
}

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

check("FX-MP-002 effort ON/OFF per level; xhigh representable and default OFF", () => {
  const policy = basePolicy();
  assert.equal(resolve(policy, "writer", req("example-small", "xhigh", "standard")).code, "EFFORT_DISABLED");
  assert.equal(resolve(policy, "writer", req("example-small", "max", "standard")).code, "EFFORT_DISABLED");
  assert.equal(resolve(policy, "writer", req("example-small", "high", "standard")).status, "ALLOW");
  // A model that lists xhigh as ON can represent it; unlisted levels are OFF by default.
  const omitted = structuredClone(policy);
  delete omitted.models[0].efforts.xhigh;
  assert.equal(validateModelPolicy(omitted).valid, true);
  assert.equal(resolve(omitted, "writer", req("example-small", "xhigh", "standard")).code, "EFFORT_DISABLED");
  const xhighOn = structuredClone(policy);
  xhighOn.models[1].efforts.xhigh = true;
  xhighOn.roles.writer.allowed.push(tuple("example-large", "xhigh", "standard"));
  assert.equal(validateModelPolicy(xhighOn).valid, true);
  assert.equal(resolve(xhighOn, "writer", req("example-large", "xhigh", "standard")).status, "ALLOW");
});

check("FX-MP-003 standard and fast are independent switches", () => {
  const policy = basePolicy();
  assert.equal(resolve(policy, "writer", req("example-small", "high", "fast")).code, "MODE_DISABLED");
  assert.equal(resolve(policy, "writer", req("example-small", "high", "standard")).status, "ALLOW");
  // Fast ON with standard OFF: fast allowed, standard denied.
  const fastOnly = structuredClone(policy);
  fastOnly.models[0].modes = { standard: false, fast: true };
  fastOnly.roles.writer.allowed = [tuple("example-small", "high", "fast")];
  fastOnly.roles.writer.default = [];
  assert.equal(resolve(fastOnly, "writer", req("example-small", "high", "fast")).status, "ALLOW");
  assert.equal(resolve(fastOnly, "writer", req("example-small", "high", "standard")).code, "MODE_DISABLED");
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
  assert.equal(resolve(disabled, "writer", requested).code, "MODEL_DISABLED");
  assert.equal(resolve(disabled, "writer", requested, RUNTIME, { substitute }).code, "SUBSTITUTION_NOT_APPROVED");
  const other = basePolicy({ substitutions: [{ from: requested, to: req("example-large", "medium", "standard") }] });
  assert.equal(resolve(withModel(other, "example-large", { enabled: false }), "writer", requested, RUNTIME, { substitute }).code, "SUBSTITUTION_NOT_APPROVED");
  const approved = withModel(basePolicy({ substitutions: [{ from: requested, to: substitute }] }), "example-large", { enabled: false });
  const allowed = resolve(approved, "writer", requested, RUNTIME, { substitute });
  assert.equal(allowed.status, "ALLOW");
  assert.deepEqual(allowed.resolved, substitute);
  assert.deepEqual(allowed.substituted_for, requested);
  const deadSub = withModel(approved, "example-small", { enabled: false });
  assert.equal(resolve(deadSub, "writer", requested, RUNTIME, { substitute }).code, "MODEL_DISABLED");
  assert.equal(resolve(approved, "writer", requested, {}, { substitute }).code, "RUNTIME_UNSUPPORTED");
});

check("FX-MP-007 invalid policy yields POLICY_INVALID (including new schema rules)", () => {
  const mutators = {
    "schema_version 2": p => { p.schema_version = 2; },
    "unknown effort key": p => { p.models[0].efforts.ultra = true; },
    "unknown mode key": p => { p.models[0].modes.turbo = true; },
    "duplicate model": p => { p.models.push(structuredClone(p.models[0])); },
    "allowed references unknown model": p => { p.roles.writer.allowed.push(tuple("example-ghost")); },
    "previous_version equals policy_version": p => { p.previous_version = "v2"; },
    "unsafe policy_version": p => { p.policy_version = "bad/version"; },
    "unknown top-level key": p => { p.secret_thing = true; },
    "missing roles": p => { delete p.roles; },
    "non-boolean enabled": p => { p.models[0].enabled = "yes"; },
    "legacy top-level default removed": p => { p.default = SMALL_HIGH; },
    "unknown status": p => { p.status = "PUBLISHED"; },
    "ACTIVE without approved_by": p => { delete p.approved_by; },
    "ACTIVE with bad approved_at": p => { p.approved_at = "not-a-time"; },
    "DRAFT carrying approval": p => { p.status = "DRAFT-review"; },
    "model missing family": p => { delete p.models[0].family; },
    "default not in allowed": p => { p.roles.writer.default.push({ runtime: "x", risk: "high", ...tuple("example-small", "low", "standard") }); },
    "default selects an OFF option": p => {
      p.roles.writer.allowed.push(tuple("example-small", "xhigh", "standard"));
      p.roles.writer.default.push({ runtime: "x", risk: "high", ...tuple("example-small", "xhigh", "standard") });
    },
    "duplicate default runtime/risk": p => { p.roles.writer.default.push({ runtime: "*", risk: "low", ...LARGE_FAST }); },
    "invalid default risk": p => { p.roles.writer.default[0].risk = "critical"; },
    "unknown role key": p => { p.roles.writer.fallback = []; },
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

check("FX-MP-009 status: draft and active files; approval fields required for ACTIVE", () => {
  const draft = basePolicy({ status: "DRAFT", approved_by: undefined, approved_at: undefined });
  delete draft.approved_by;
  delete draft.approved_at;
  assert.equal(validateModelPolicy(draft).valid, true);
  assert.equal(resolve(draft, "writer", req("example-small", "high", "standard")).code, "POLICY_NOT_APPROVED");
  const active = basePolicy();
  assert.equal(resolve(active, "writer", req("example-small", "high", "standard")).status, "ALLOW");
});

check("FX-MP-010 evaluation_ref never changes a decision", () => {
  const variants = [basePolicy({ evaluation_ref: "ref-a" }), basePolicy({ evaluation_ref: "ref-b" }), basePolicy({ evaluation_ref: null })];
  const requests = [req("example-small", "high", "standard"), req("example-small", "xhigh", "standard"), req("example-small", "high", "fast"), req("example-large", "high", "fast")];
  for (const r of requests) {
    const outputs = variants.map(v => JSON.stringify(resolve(v, "writer", r)));
    assert.equal(new Set(outputs).size, 1, JSON.stringify(r));
  }
});

check("FX-MP-011 runtime capability is checked separately, fails closed, and supports per-model narrowing", () => {
  const policy = basePolicy();
  const noRuntime = resolveModelSelection({ policy, role: "writer", requested: req("example-small", "high", "standard") });
  assert.equal(noRuntime.code, "RUNTIME_UNSUPPORTED");
  const noFast = { example: { models: ["example-large"], efforts: [...EFFORTS], modes: ["standard"] } };
  assert.equal(resolve(policy, "writer", req("example-large", "high", "fast"), noFast).code, "RUNTIME_UNSUPPORTED");
  const disabled = withModel(policy, "example-small", { enabled: false });
  assert.equal(resolveModelSelection({ policy: disabled, role: "writer", requested: req("example-small", "high", "standard") }).code, "MODEL_DISABLED");
  // Per-model narrowing: runtime supports only low/standard for the small model.
  const narrowed = { example: { ...RUNTIME.example, by_model: { "example-small": { efforts: ["low"], modes: ["standard"] } } } };
  assert.equal(resolve(policy, "writer", req("example-small", "high", "standard"), narrowed).code, "RUNTIME_UNSUPPORTED");
  assert.equal(resolve(policy, "writer", req("example-large", "high", "fast"), narrowed).status, "ALLOW");
});

check("FX-MP-012 provider-compat with a real public model ID (temp policy only)", () => {
  const policy = basePolicy({
    models: [{ provider: "anthropic", family: "claude-haiku", version: "5.5", id: "claude-haiku-5-5", enabled: true,
      efforts: { high: true, xhigh: true }, modes: { standard: true } }],
    roles: { writer: { allowed: [tuple("claude-haiku-5-5", "high", "standard", "anthropic")], default: [] } },
  });
  const runtime = { anthropic: { models: ["claude-haiku-5-5"], efforts: ["high"], modes: ["standard"] } };
  assert.equal(resolve(policy, "writer", req("claude-haiku-5-5", "high", "standard", "anthropic"), runtime).status, "ALLOW");
  assert.equal(resolve(policy, "writer", req("claude-haiku-5-5", "xhigh", "standard", "anthropic"), runtime).code, "ROLE_NOT_ALLOWED");
  const widened = structuredClone(policy);
  widened.roles.writer.allowed.push(tuple("claude-haiku-5-5", "xhigh", "standard", "anthropic"));
  assert.equal(resolve(widened, "writer", req("claude-haiku-5-5", "xhigh", "standard", "anthropic"), runtime).code, "RUNTIME_UNSUPPORTED");
});

check("FX-MP-013 describeActivePolicy summarizes the execution location; advisory cost_limits listed", () => {
  const iso = isolatedEnv("describe");
  writeJson(iso.defaultFile, basePolicy({ previous_version: "v1" }));
  const summary = describeActivePolicy(iso.env);
  assert.equal(summary.status, "VALID");
  assert.equal(summary.policy_version, "v2");
  assert.equal(summary.previous_copy_available, false);
  assert.deepEqual(summary.roles, ["writer"]);
  assert.deepEqual(summary.enabled_models.map(m => m.id), ["example-small", "example-large"]);
  assert.deepEqual(summary.advisory, ["cost_limits"]);
  const absent = describeActivePolicy(isolatedEnv("describe-absent").env);
  assert.equal(absent.status, "POLICY_MISSING");
});

check("FX-MP-013b describeActivePolicy exposes approval state: ACTIVE fields, DRAFT policy_status, missing unchanged", () => {
  const active = isolatedEnv("describe-approval-active");
  writeJson(active.defaultFile, basePolicy({ previous_version: "v1" }));
  const activeSummary = describeActivePolicy(active.env);
  assert.equal(activeSummary.status, "VALID");
  assert.equal(activeSummary.policy_status, "ACTIVE");
  assert.equal(activeSummary.approved_by, "owner-fixture");
  assert.equal(activeSummary.approved_at, "2026-11-25T00:00:00Z");
  assert.equal(activeSummary.policy_version, "v2");

  const draft = isolatedEnv("describe-approval-draft");
  const draftPolicy = basePolicy({ status: "DRAFT", policy_version: "v3", previous_version: "v2" });
  delete draftPolicy.approved_by;
  delete draftPolicy.approved_at;
  writeJson(draft.defaultFile, draftPolicy);
  const draftSummary = describeActivePolicy(draft.env);
  assert.equal(draftSummary.status, "POLICY_NOT_APPROVED");
  assert.equal(draftSummary.policy_status, "DRAFT");
  assert.equal(draftSummary.approved_by, null);
  assert.equal(draftSummary.approved_at, null);
  assert.equal(draftSummary.policy_version, undefined);
  assert.deepEqual(draftSummary.advisory, ["cost_limits"]);

  const missing = describeActivePolicy(isolatedEnv("describe-approval-missing").env);
  assert.equal(missing.status, "POLICY_MISSING");
  assert.equal("policy_status" in missing, false);
  assert.equal("approved_by" in missing, false);
  assert.equal("approved_at" in missing, false);

  const cliEnv = isolatedEnv("describe-approval-cli");
  writeJson(cliEnv.defaultFile, draftPolicy);
  const cli = spawnSync(process.execPath, [CLI, "status"], { encoding: "utf8", env: { PATH: process.env.PATH, ...cliEnv.env } });
  const cliOut = JSON.parse(cli.stdout);
  assert.equal(cliOut.status, "POLICY_NOT_APPROVED");
  assert.equal(cliOut.policy_status, "DRAFT");
  assert.equal(cliOut.approved_by, null);
  assert.equal(cliOut.approved_at, null);
  assert.equal(cli.status, 1);
  // Draft summaries stay minimal: no policy body (models, roles, evaluation_ref) leaks into status output.
  for (const key of ["models", "roles", "evaluation_ref", "enabled_models", "policy_version"]) assert.equal(key in cliOut, false, key);
});

check("FX-MP-014 example template validates as a DRAFT placeholder and never executes", () => {
  const file = path.join(root, "profiles/example/model-policy.json.example");
  const read = readPolicyFile(file);
  assert.equal(read.status, "VALID", read.errors.join("; "));
  assert.equal(read.policy.status, "DRAFT");
  assert.equal(read.policy.models.some(m => m.enabled === true), false);
  assert.equal(resolveModelSelection({ policy: read.policy, role: "role-placeholder", requested: req("model-id-placeholder", "high", "standard", "provider-placeholder"), runtimeCapabilities: {} }).code, "POLICY_NOT_APPROVED");
});

check("FX-MP-015 guard gate: policy ALLOW/DENY, fail-closed runtime, draft object denied, env-loaded execution policy", () => {
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
  const draft = basePolicy({ status: "DRAFT" });
  delete draft.approved_by;
  delete draft.approved_at;
  assert.equal(preflightDispatch(manifest, cap, { modelPolicy: draft, runtimeModelCapabilities: RUNTIME }).code, "POLICY_NOT_APPROVED");
  // Env-loaded: the guard reads the execution location only.
  const iso = isolatedEnv("guard-env");
  writeJson(iso.defaultFile, policy);
  assert.equal(preflightDispatch(manifest, cap, { modelPolicyEnv: iso.env, runtimeModelCapabilities: RUNTIME }).status, "READY");
  const empty = isolatedEnv("guard-env-empty");
  assert.equal(preflightDispatch(manifest, cap, { modelPolicyEnv: empty.env, runtimeModelCapabilities: RUNTIME }).code, "POLICY_MISSING");
});

check("FX-MP-016 CLI status, validate, check, usage exit codes (temp env only)", () => {
  const iso = isolatedEnv("cli");
  const runtimeFile = path.join(iso.dir, "runtime.json");
  writeJson(iso.defaultFile, basePolicy());
  writeJson(runtimeFile, RUNTIME);
  const run = (args, env = iso.env) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  const status = run(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, "VALID");
  const validate = run(["validate", "--runtime-capabilities", runtimeFile]);
  assert.equal(validate.status, 0, validate.stdout);
  const allow = run(["check", "--role", "writer", "--model", "example-small", "--effort", "high", "--mode", "standard", "--runtime-capabilities", runtimeFile]);
  assert.equal(allow.status, 0, allow.stdout);
  assert.equal(JSON.parse(allow.stdout).code, "ALLOW");
  const deny = run(["check", "--role", "writer", "--model", "example-small", "--effort", "high", "--mode", "fast", "--runtime-capabilities", runtimeFile]);
  assert.equal(deny.status, 1);
  assert.equal(JSON.parse(deny.stdout).code, "MODE_DISABLED");
  assert.equal(run(["check", "--role", "writer"]).status, 2);
  assert.equal(run(["bogus"]).status, 2);
});

check("FX-MP-017 draft: allowed for validate/diff, rejected for execution, env override cannot unlock", () => {
  const iso = isolatedEnv("draft-unlock");
  const draftFile = path.join(sandbox, "draft-unlock", "candidate-draft.json");
  const draft = basePolicy({ status: "DRAFT", policy_version: "v3" });
  delete draft.approved_by;
  delete draft.approved_at;
  writeJson(draftFile, draft);
  // validate and diff accept the draft.
  assert.equal(readPolicyFile(draftFile).status, "VALID");
  assert.equal(diffPolicies(null, draft).status, "DIFFED");
  // Pointing the env override at the draft does NOT make it executable (default location is used).
  const pointed = { ...iso.env, OH_MY_AI_MODEL_POLICY: draftFile };
  assert.equal(resolveExecutionPolicyPath(pointed).path, iso.defaultFile);
  assert.equal(resolveDryPolicyPath(pointed), path.resolve(draftFile));
  assert.equal(loadExecutionPolicy(pointed).status, "POLICY_MISSING");
  // Even with a valid ACTIVE default present, an override without allow_path_override is ignored.
  writeJson(iso.defaultFile, basePolicy());
  const ignored = loadExecutionPolicy({ ...iso.env, OH_MY_AI_MODEL_POLICY: draftFile });
  assert.equal(ignored.status, "VALID");
  assert.equal(ignored.via, "default");
  // A DRAFT default can never execute, whatever the env says.
  writeJson(iso.defaultFile, draft);
  assert.equal(loadExecutionPolicy(iso.env).status, "POLICY_NOT_APPROVED");
  assert.equal(guardStatus(iso.env), "POLICY_NOT_APPROVED");
});

function guardStatus(env) {
  return preflightDispatch(writerManifest(), writerCapability(), { modelPolicyEnv: env, runtimeModelCapabilities: RUNTIME }).code;
}

check("FX-MP-018 override is honored only when the ACTIVE default file sets allow_path_override", () => {
  const iso = isolatedEnv("override-allowed");
  const elsewhere = path.join(sandbox, "override-allowed", "elsewhere.json");
  writeJson(elsewhere, basePolicy({ policy_version: "v9", allow_path_override: false }));
  writeJson(iso.defaultFile, basePolicy({ policy_version: "v1", allow_path_override: true }));
  const via = loadExecutionPolicy({ ...iso.env, OH_MY_AI_MODEL_POLICY: elsewhere });
  assert.equal(via.status, "VALID");
  assert.equal(via.via, "override");
  assert.equal(via.policy.policy_version, "v9");
  // Dry validate/diff honor the override path directly.
  assert.equal(resolveDryPolicyPath({ ...iso.env, OH_MY_AI_MODEL_POLICY: elsewhere }), path.resolve(elsewhere));
});

check("FX-MP-019 unsupported option enabled -> POLICY_INVALID at validate; runtime gap at resolve -> RUNTIME_UNSUPPORTED (no conversion)", () => {
  const policy = basePolicy();
  policy.models[1].efforts.xhigh = true;
  policy.roles.writer.allowed.push(tuple("example-large", "xhigh", "standard"));
  const narrowRuntime = { example: { models: ["example-small", "example-large"], efforts: ["low", "medium", "high"], modes: [...MODES] } };
  const verdict = validateModelPolicy(policy, { runtimeCapabilities: narrowRuntime });
  assert.equal(verdict.valid, false);
  assert.ok(verdict.errors.some(e => e.includes("efforts.xhigh enabled but not declared")), verdict.errors.join("; "));
  assert.equal(validateModelPolicy(policy, { runtimeCapabilities: RUNTIME }).valid, true);
  // Undeclared mode and undeclared model are also rejected at validate time.
  const fastOff = structuredClone(basePolicy());
  assert.equal(validateModelPolicy(fastOff, { runtimeCapabilities: { example: { models: ["example-small", "example-large"], efforts: [...EFFORTS], modes: ["standard"] } } }).valid, false);
  // Resolve: the same selection is RUNTIME_UNSUPPORTED, and the code never converts it to another effort.
  const r = resolve(policy, "writer", req("example-large", "xhigh", "standard"), narrowRuntime);
  assert.equal(r.code, "RUNTIME_UNSUPPORTED");
  assert.equal(r.resolved, undefined);
});

check("FX-MP-020 default selection: most-specific wins, deterministic, NO_DEFAULT blocks", () => {
  const policy = basePolicy();
  const pick = (runtime, risk) => selectDefault({ policy, role: "writer", runtime, risk });
  // exact runtime + exact risk is not present: exact runtime beats exact risk (runtime weighs more).
  assert.equal(pick("example-runtime", "low").rule.runtime, "example-runtime");
  assert.deepEqual(pick("example-runtime", "low").selection, SMALL_HIGH);
  // exact runtime, wildcard risk beats the (*,*) catch-all for the same runtime.
  assert.deepEqual(pick("example-runtime", "high").selection, SMALL_HIGH);
  assert.deepEqual(pick("example-runtime", "high").rule, { runtime: "example-runtime", risk: "*" });
  // other runtime: exact risk rule beats the catch-all.
  assert.deepEqual(pick("other-runtime", "low").selection, SMALL_HIGH);
  assert.deepEqual(pick("other-runtime", "low").rule, { runtime: "*", risk: "low" });
  // other runtime, other risk: catch-all.
  assert.deepEqual(pick("other-runtime", "high").rule, { runtime: "*", risk: "*" });
  // Deterministic: repeated calls give the same answer and never call any AI.
  assert.deepEqual(pick("other-runtime", "high"), pick("other-runtime", "high"));
  // No rule for role -> NO_DEFAULT; the caller must not fall back.
  assert.equal(selectDefault({ policy, role: "reviewer", runtime: "example-runtime", risk: "low" }).code, "NO_DEFAULT");
  const noDefaults = basePolicy();
  noDefaults.roles.writer.default = [];
  assert.equal(selectDefault({ policy: noDefaults, role: "writer", runtime: "example-runtime", risk: "low" }).code, "NO_DEFAULT");
  // Wildcard or unknown risk as the selection key is not a concrete choice -> NO_DEFAULT.
  assert.equal(selectDefault({ policy, role: "writer", runtime: "*", risk: "low" }).code, "NO_DEFAULT");
  assert.equal(selectDefault({ policy, role: "writer", runtime: "example-runtime", risk: "critical" }).code, "NO_DEFAULT");
  // Draft policy cannot select a default.
  const draft = basePolicy({ status: "DRAFT" });
  delete draft.approved_by;
  delete draft.approved_at;
  assert.equal(selectDefault({ policy: draft, role: "writer", runtime: "example-runtime", risk: "low" }).code, "POLICY_NOT_APPROVED");
  // Selected default still has to pass the resolver (runtime support is checked there).
  const chosen = pick("example-runtime", "low").selection;
  assert.equal(resolve(policy, "writer", { provider: chosen.provider, model: chosen.model, effort: chosen.effort, mode: chosen.mode }).status, "ALLOW");
});

check("FX-MP-021 diff reports ON/OFF and role default changes vs active", () => {
  const active = basePolicy();
  const candidate = structuredClone(active);
  candidate.policy_version = "v3";
  candidate.previous_version = "v2";
  candidate.models[0].modes.fast = true;
  candidate.models[1].efforts.max = false;
  candidate.roles.writer.default[2] = { runtime: "*", risk: "*", ...SMALL_HIGH };
  const report = diffPolicies(active, candidate);
  assert.equal(report.summary.on, 1);
  assert.equal(report.summary.off, 1);
  assert.equal(report.summary.role_default_changes, 1);
  assert.equal(report.changes.find(c => c.path.includes("example-small") && c.path.endsWith("modes.fast")).change, "ON");
  assert.equal(report.changes.find(c => c.path.includes("example-large") && c.path.endsWith("efforts.max")).change, "OFF");
  assert.equal(report.changes.find(c => c.path.includes(".default[")).change, "CHANGED");
  // Diff against no active shows everything as new and never throws.
  assert.equal(diffPolicies(null, active).active_version, null);
  // Identical policies have no changes.
  assert.equal(diffPolicies(active, structuredClone(active)).changes.length, 0);
});

check("FX-MP-022 apply: ACTIVE candidate, chained previous_version, archive first, 0600, drafts refused", () => {
  const iso = isolatedEnv("apply");
  const v1 = basePolicy({ policy_version: "v1", previous_version: null });
  writeJson(iso.defaultFile, v1);
  const v2 = basePolicy({ policy_version: "v2", previous_version: "v1" });
  const candidate = path.join(iso.dir, "candidate-v2.json");
  writeJson(candidate, v2);
  const outcome = applyPolicy(iso.env, candidate);
  assert.equal(outcome.code, "APPLIED", outcome.reasons.join("; "));
  assert.equal(JSON.parse(fs.readFileSync(iso.defaultFile, "utf8")).policy_version, "v2");
  assert.equal(JSON.parse(fs.readFileSync(path.join(iso.dir, "model-policy.v1.json"), "utf8")).policy_version, "v1");
  assert.equal(fs.statSync(iso.defaultFile).mode & 0o777, 0o600);
  // Draft candidate is refused and changes nothing.
  const draftCandidate = path.join(iso.dir, "candidate-draft.json");
  const draft = basePolicy({ policy_version: "v3", previous_version: "v2", status: "DRAFT" });
  delete draft.approved_by;
  delete draft.approved_at;
  writeJson(draftCandidate, draft);
  const before = fs.readFileSync(iso.defaultFile, "utf8");
  assert.equal(applyPolicy(iso.env, draftCandidate).code, "POLICY_NOT_APPROVED");
  assert.equal(fs.readFileSync(iso.defaultFile, "utf8"), before);
  // Broken chain (previous_version does not match active) is refused.
  const broken = path.join(iso.dir, "candidate-broken.json");
  writeJson(broken, basePolicy({ policy_version: "v4", previous_version: "v1" }));
  assert.equal(applyPolicy(iso.env, broken).code, "POLICY_INVALID");
  assert.equal(fs.readFileSync(iso.defaultFile, "utf8"), before);
  // No active file: candidate with non-null previous_version is refused.
  const fresh = isolatedEnv("apply-fresh");
  assert.equal(applyPolicy(fresh.env, candidate).code, "POLICY_INVALID");
  assert.equal(applyPolicy(fresh.env, path.join(iso.dir, "candidate-v2.json")).code, "POLICY_INVALID");
});

check("FX-MP-023 rollback swaps to archived copy, 0600, refuses without copy and never auto-runs", () => {
  const iso = isolatedEnv("rollback-ok");
  writeJson(path.join(iso.dir, "model-policy.v1.json"), basePolicy({ policy_version: "v1", previous_version: null }));
  writeJson(iso.defaultFile, basePolicy({ policy_version: "v2", previous_version: "v1" }));
  const outcome = rollbackPolicy(iso.env);
  assert.equal(outcome.code, "ROLLED_BACK");
  assert.equal(JSON.parse(fs.readFileSync(iso.defaultFile, "utf8")).policy_version, "v1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(iso.dir, "model-policy.v2.json"), "utf8")).policy_version, "v2");
  assert.equal(fs.statSync(iso.defaultFile).mode & 0o777, 0o600);
  const before = fs.readFileSync(iso.defaultFile, "utf8");
  assert.equal(rollbackPolicy(iso.env).code, "POLICY_INVALID");
  assert.equal(fs.readFileSync(iso.defaultFile, "utf8"), before);

  const missing = isolatedEnv("rollback-nocopy");
  writeJson(missing.defaultFile, basePolicy({ policy_version: "v2", previous_version: "v1" }));
  const snapshot = fs.readFileSync(missing.defaultFile, "utf8");
  assert.equal(rollbackPolicy(missing.env).code, "POLICY_MISSING");
  assert.equal(fs.readFileSync(missing.defaultFile, "utf8"), snapshot);
});

check("FX-MP-024 cost_limits are advisory: not enforced, missing limit is not unlimited approval", () => {
  const withLimit = basePolicy();
  const noLimit = basePolicy({ cost_limits: {} });
  const unlimited = basePolicy({ cost_limits: { "example-task": { requires_approval: false } } });
  for (const r of [req("example-large", "high", "fast"), req("example-small", "high", "standard")]) {
    const outputs = [withLimit, noLimit, unlimited].map(p => JSON.stringify(resolve(p, "writer", r)));
    assert.equal(new Set(outputs).size, 1, JSON.stringify(r));
  }
  // Approval for cost stays with the existing Owner Gate: the resolver never returns an approval.
  assert.equal(resolve(noLimit, "writer", req("example-small", "high", "standard")).status, "ALLOW");
});

check("FX-MP-025 compareEffective: MATCH / MISMATCH / UNKNOWN, mismatch beats unknown", () => {
  const requested = { model: "example-small", effort: "high", mode: "standard" };
  assert.equal(compareEffective({ requested, effective: { ...requested } }).status, "MATCH");
  const fast = compareEffective({ requested, effective: { model: "example-small", effort: "high", mode: "fast" } });
  assert.equal(fast.status, "MISMATCH");
  assert.equal(fast.fields.mode, "MISMATCH");
  assert.equal(fast.fields.model, "MATCH");
  const unknown = compareEffective({ requested, effective: { model: "example-small", effort: "UNKNOWN", mode: "standard" } });
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.label, "UNVERIFIED_CONFIG");
  assert.equal(compareEffective({ requested, effective: {} }).status, "UNKNOWN");
  assert.equal(compareEffective({ requested, effective: { model: "example-small", effort: "medium", mode: "fast" } }).status, "MISMATCH");
  assert.equal(compareEffective({ requested, effective: { model: "other", effort: "UNKNOWN", mode: "standard" } }).status, "MISMATCH");
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
