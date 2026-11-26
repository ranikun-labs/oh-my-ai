/**
 * Model policy: owner-approved permission file + deterministic resolver.
 * Schema and rules: docs/contracts/model-policy.md.
 *
 * Scope boundary: this module validates a policy, decides ALLOW/DENY for one requested
 * {provider, model, effort, mode} selection, picks a role default without any AI call,
 * and manages the active file (diff / apply / rollback). It does NOT load evaluation
 * data, query runtimes, dispatch agents, or substitute models implicitly.
 * Runtime capability (what a provider/runtime supports) is a separate input and is
 * checked after policy permission. Both must pass.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const MODES = Object.freeze(["standard", "fast"]);
export const RISK_LEVELS = Object.freeze(["low", "medium", "high"]);
export const WILDCARD = "*";
export const DECISION_CODES = Object.freeze([
  "POLICY_MISSING", "POLICY_INVALID", "POLICY_NOT_APPROVED", "UNKNOWN_MODEL", "MODEL_DISABLED",
  "EFFORT_DISABLED", "MODE_DISABLED", "ROLE_NOT_ALLOWED", "RUNTIME_UNSUPPORTED",
  "SUBSTITUTION_NOT_APPROVED", "NO_DEFAULT", "DEFAULT_SELECTED", "APPLIED", "ROLLED_BACK",
  "APPLY_REQUIRES_TTY", "APPLY_NOT_CONFIRMED", "ROLLBACK_REQUIRES_TTY", "ROLLBACK_NOT_CONFIRMED",
]);

const TOP_KEYS = [
  "schema_version", "policy_version", "previous_version", "status", "approved_by", "approved_at",
  "allow_path_override", "models", "roles", "cost_limits", "substitutions", "evaluation_ref",
];
const REQUIRED_TOP_KEYS = ["schema_version", "policy_version", "previous_version", "status", "models", "roles"];
const MODEL_KEYS = ["provider", "family", "version", "id", "enabled", "efforts", "modes"];
const ROLE_KEYS = ["allowed", "default"];
const DEFAULT_KEYS = ["runtime", "risk", "provider", "model", "effort", "mode"];
const TUPLE_KEYS = ["provider", "model", "effort", "mode"];
const VERSION = /^[A-Za-z0-9._-]+$/;
const hasOwn = (obj, key) => obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const present = value => typeof value === "string" && value.trim().length > 0;
const list = value => (Array.isArray(value) ? value : []);
const decision = (status, code, reasons, extra = {}) => ({ status, code, reasons, ...extra });

function tupleErrors(tuple, where, modelKeys) {
  const errors = [];
  if (!isRecord(tuple)) return [where + " must be an object"];
  for (const key of Object.keys(tuple)) if (!TUPLE_KEYS.includes(key)) errors.push(`${where}.${key} is not allowed`);
  if (!present(tuple.provider)) errors.push(where + ".provider missing");
  if (!present(tuple.model)) errors.push(where + ".model missing");
  else if (present(tuple.provider) && !modelKeys.has(JSON.stringify([tuple.provider, tuple.model]))) {
    errors.push(`${where} references unknown model ${tuple.provider}/${tuple.model}`);
  }
  if (!EFFORT_LEVELS.includes(tuple.effort)) errors.push(`${where}.effort must be one of ${EFFORT_LEVELS.join("/")}`);
  if (!MODES.includes(tuple.mode)) errors.push(`${where}.mode must be one of ${MODES.join("/")}`);
  return errors;
}

function statusErrors(policy) {
  const errors = [];
  const status = policy.status;
  if (typeof status !== "string" || (status !== "ACTIVE" && !status.startsWith("DRAFT"))) {
    return ["status must be ACTIVE or DRAFT*"];
  }
  if (status === "ACTIVE") {
    if (!present(policy.approved_by)) errors.push("ACTIVE policy requires approved_by");
    if (!present(policy.approved_at) || Number.isNaN(Date.parse(policy.approved_at))) {
      errors.push("ACTIVE policy requires approved_at (ISO-8601 timestamp)");
    }
  } else {
    for (const key of ["approved_by", "approved_at"]) {
      if (policy[key] !== undefined && policy[key] !== null) errors.push(`${status} policy must not carry ${key}`);
    }
  }
  return errors;
}

/**
 * Structural validation of a parsed policy object. Returns { valid, errors }.
 * options.runtimeCapabilities (optional, from a trusted adapter): also rejects any model,
 * effort or mode that the policy enables but the runtime does not declare (POLICY_INVALID).
 * Resolve-time support is separate: see evaluate() (RUNTIME_UNSUPPORTED).
 */
export function validateModelPolicy(policy, options = {}) {
  const errors = [];
  if (!isRecord(policy)) return { valid: false, errors: ["policy must be an object"] };
  for (const key of Object.keys(policy)) if (!TOP_KEYS.includes(key)) errors.push(`${key} is not an allowed top-level key`);
  for (const key of REQUIRED_TOP_KEYS) if (!hasOwn(policy, key)) errors.push(`${key} missing`);
  if (policy.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!present(policy.policy_version) || !VERSION.test(policy.policy_version)) errors.push("policy_version missing or not [A-Za-z0-9._-]+");
  if (policy.previous_version !== null) {
    if (!present(policy.previous_version) || !VERSION.test(policy.previous_version)) errors.push("previous_version must be null or [A-Za-z0-9._-]+");
    else if (policy.previous_version === policy.policy_version) errors.push("previous_version equals policy_version");
  }
  if (hasOwn(policy, "status")) errors.push(...statusErrors(policy));
  if (hasOwn(policy, "allow_path_override") && typeof policy.allow_path_override !== "boolean") {
    errors.push("allow_path_override must be boolean");
  }

  const modelKeys = new Set();
  if (!Array.isArray(policy.models)) errors.push("models must be an array");
  else {
    policy.models.forEach((model, i) => {
      const where = `models[${i}]`;
      if (!isRecord(model)) { errors.push(where + " must be an object"); return; }
      for (const key of Object.keys(model)) if (!MODEL_KEYS.includes(key)) errors.push(`${where}.${key} is not allowed`);
      if (!present(model.provider)) errors.push(where + ".provider missing");
      if (!present(model.family)) errors.push(where + ".family missing");
      if (!present(model.version)) errors.push(where + ".version missing");
      if (!present(model.id)) errors.push(where + ".id missing");
      if (typeof model.enabled !== "boolean") errors.push(where + ".enabled must be boolean");
      if (present(model.provider) && present(model.id)) {
        const key = JSON.stringify([model.provider, model.id]);
        if (modelKeys.has(key)) errors.push(`${where} duplicates ${model.provider}/${model.id}`);
        modelKeys.add(key);
      }
      if (hasOwn(model, "efforts")) {
        if (!isRecord(model.efforts)) errors.push(where + ".efforts must be an object");
        else for (const [level, on] of Object.entries(model.efforts)) {
          if (!EFFORT_LEVELS.includes(level)) errors.push(`${where}.efforts.${level} is not a known effort level`);
          else if (typeof on !== "boolean") errors.push(`${where}.efforts.${level} must be boolean`);
        }
      }
      if (hasOwn(model, "modes")) {
        if (!isRecord(model.modes)) errors.push(where + ".modes must be an object");
        else for (const [mode, on] of Object.entries(model.modes)) {
          if (!MODES.includes(mode)) errors.push(`${where}.modes.${mode} is not a known mode`);
          else if (typeof on !== "boolean") errors.push(`${where}.modes.${mode} must be boolean`);
        }
      }
    });
  }

  if (!isRecord(policy.roles)) errors.push("roles must be an object");
  else for (const [role, entry] of Object.entries(policy.roles)) {
    const where = `roles.${role}`;
    if (!isRecord(entry)) { errors.push(`${where} must be an object {allowed, default?}`); continue; }
    for (const key of Object.keys(entry)) if (!ROLE_KEYS.includes(key)) errors.push(`${where}.${key} is not allowed`);
    if (!Array.isArray(entry.allowed)) { errors.push(`${where}.allowed must be an array`); continue; }
    entry.allowed.forEach((tuple, i) => errors.push(...tupleErrors(tuple, `${where}.allowed[${i}]`, modelKeys)));
    if (entry.default === undefined) continue;
    if (!Array.isArray(entry.default)) { errors.push(`${where}.default must be an array`); continue; }
    const seen = new Set();
    entry.default.forEach((rule, i) => {
      const at = `${where}.default[${i}]`;
      if (!isRecord(rule)) { errors.push(at + " must be an object"); return; }
      for (const key of Object.keys(rule)) if (!DEFAULT_KEYS.includes(key)) errors.push(`${at}.${key} is not allowed`);
      if (!present(rule.runtime)) errors.push(at + ".runtime missing");
      if (![...RISK_LEVELS, WILDCARD].includes(rule.risk)) errors.push(`${at}.risk must be low/medium/high/*`);
      const slot = `${rule.runtime}|${rule.risk}`;
      if (seen.has(slot)) errors.push(`${at} duplicates runtime/risk ${slot}`);
      seen.add(slot);
      const tuple = { provider: rule.provider, model: rule.model, effort: rule.effort, mode: rule.mode };
      const tErrors = tupleErrors(tuple, at, modelKeys);
      errors.push(...tErrors);
      if (tErrors.length === 0) {
        if (!entry.allowed.some(item => sameTuple(item, tuple))) errors.push(`${at} is not listed in ${where}.allowed`);
        const model = Array.isArray(policy.models) ? policy.models.find(m => isRecord(m) && m.provider === tuple.provider && m.id === tuple.model) : undefined;
        if (model && !selectionOn(model, tuple)) errors.push(`${at} selects an option that is OFF`);
      }
    });
  }

  if (hasOwn(policy, "cost_limits") && policy.cost_limits !== undefined) {
    if (!isRecord(policy.cost_limits)) errors.push("cost_limits must be an object");
    else for (const [task, limit] of Object.entries(policy.cost_limits)) {
      if (!isRecord(limit)) errors.push(`cost_limits.${task} must be an object`);
      else if (hasOwn(limit, "requires_approval") && typeof limit.requires_approval !== "boolean") {
        errors.push(`cost_limits.${task}.requires_approval must be boolean`);
      }
    }
  }
  if (hasOwn(policy, "substitutions") && policy.substitutions !== undefined) {
    if (!Array.isArray(policy.substitutions)) errors.push("substitutions must be an array");
    else policy.substitutions.forEach((pair, i) => {
      const where = `substitutions[${i}]`;
      if (!isRecord(pair)) { errors.push(where + " must be an object"); return; }
      errors.push(...tupleErrors(pair.from, `${where}.from`, modelKeys));
      errors.push(...tupleErrors(pair.to, `${where}.to`, modelKeys));
      if (sameTuple(pair.from, pair.to)) errors.push(where + " from and to are identical");
    });
  }
  if (hasOwn(policy, "evaluation_ref") && policy.evaluation_ref !== null && typeof policy.evaluation_ref !== "string") {
    errors.push("evaluation_ref must be a string or null");
  }
  if (options.runtimeCapabilities !== undefined && Array.isArray(policy.models)) {
    errors.push(...runtimeSupportErrors(policy.models, options.runtimeCapabilities));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Per-model runtime support. Provider-level lists apply to every model of that provider;
 * an optional runtime.by_model[id] = {efforts, modes} narrows support for one model.
 */
function supportFor(runtime, modelId) {
  const scoped = isRecord(runtime.by_model) && isRecord(runtime.by_model[modelId]) ? runtime.by_model[modelId] : null;
  const source = scoped ?? runtime;
  return { efforts: list(source.efforts), modes: list(source.modes) };
}

function runtimeSupportErrors(models, runtimeCapabilities) {
  const errors = [];
  if (!isRecord(runtimeCapabilities)) return ["runtimeCapabilities must be an object"];
  models.forEach((model, i) => {
    if (!isRecord(model)) return;
    const on = obj => (isRecord(obj) ? Object.keys(obj).filter(k => obj[k] === true) : []);
    const efforts = on(model.efforts);
    const modes = on(model.modes);
    if (model.enabled !== true && efforts.length === 0 && modes.length === 0) return;
    const runtime = hasOwn(runtimeCapabilities, model.provider) && isRecord(runtimeCapabilities[model.provider])
      ? runtimeCapabilities[model.provider] : null;
    const where = `models[${i}] ${model.provider}/${model.id}`;
    if (!runtime) { errors.push(`${where} enabled but runtime declares no capability for provider ${model.provider}`); return; }
    if (!list(runtime.models).includes(model.id)) errors.push(`${where} not declared by runtime capability`);
    const support = supportFor(runtime, model.id);
    for (const level of efforts) if (!support.efforts.includes(level)) errors.push(`${where}.efforts.${level} enabled but not declared by runtime`);
    for (const mode of modes) if (!support.modes.includes(mode)) errors.push(`${where}.modes.${mode} enabled but not declared by runtime`);
  });
  return errors;
}

function sameTuple(a, b) {
  return isRecord(a) && isRecord(b) && TUPLE_KEYS.every(k => a[k] === b[k]);
}

function selectionOn(model, tuple) {
  return model.enabled === true && hasOwn(model.efforts, tuple.effort) && model.efforts[tuple.effort] === true
    && hasOwn(model.modes, tuple.mode) && model.modes[tuple.mode] === true;
}

function findModel(policy, provider, id) {
  return policy.models.find(m => m.provider === provider && m.id === id);
}

function evaluate(policy, role, requested, runtimeCapabilities) {
  if (!isRecord(requested)) return decision("DENY", "UNKNOWN_MODEL", ["requested selection missing"]);
  const model = findModel(policy, requested.provider, requested.model);
  if (!model) return decision("DENY", "UNKNOWN_MODEL", [`${requested.provider}/${requested.model} is not listed in the policy (unlisted models are disabled)`]);
  if (model.enabled !== true) return decision("DENY", "MODEL_DISABLED", [`${requested.provider}/${requested.model} is disabled`]);
  if (!hasOwn(model.efforts, requested.effort) || model.efforts[requested.effort] !== true) {
    return decision("DENY", "EFFORT_DISABLED", [`effort ${requested.effort} is off for this model`]);
  }
  if (!hasOwn(model.modes, requested.mode) || model.modes[requested.mode] !== true) {
    return decision("DENY", "MODE_DISABLED", [`mode ${requested.mode} is off for this model`]);
  }
  const entry = hasOwn(policy.roles, role) ? policy.roles[role] : undefined;
  if (!isRecord(entry) || !list(entry.allowed).some(item => sameTuple(item, requested))) {
    return decision("DENY", "ROLE_NOT_ALLOWED", [`role ${role} is not allowed this selection`]);
  }
  const runtime = isRecord(runtimeCapabilities) && hasOwn(runtimeCapabilities, requested.provider) ? runtimeCapabilities[requested.provider] : undefined;
  if (!isRecord(runtime)) {
    return decision("DENY", "RUNTIME_UNSUPPORTED", [`no runtime capability supplied for provider ${requested.provider} (fail-closed)`]);
  }
  const support = supportFor(runtime, requested.model);
  const supported = list(runtime.models).includes(requested.model)
    && support.efforts.includes(requested.effort)
    && support.modes.includes(requested.mode);
  if (!supported) return decision("DENY", "RUNTIME_UNSUPPORTED", ["runtime does not support the requested model/effort/mode (no conversion)"]);
  return decision("ALLOW", "ALLOW", [], {
    role,
    policy_version: policy.policy_version,
    resolved: { provider: requested.provider, model: requested.model, effort: requested.effort, mode: requested.mode },
  });
}

/**
 * Decide ALLOW/DENY for one selection. No implicit fallback: a substitute is used only
 * when the caller passes `substitute` AND the exact (requested -> substitute) pair is
 * listed in policy.substitutions. Draft policies are denied (POLICY_NOT_APPROVED).
 */
export function resolveModelSelection({ policy, role, requested, runtimeCapabilities, substitute } = {}) {
  if (policy === undefined || policy === null) return decision("DENY", "POLICY_MISSING", ["no model policy supplied"]);
  const checked = validateModelPolicy(policy);
  if (!checked.valid) return decision("DENY", "POLICY_INVALID", checked.errors);
  if (policy.status !== "ACTIVE") return decision("DENY", "POLICY_NOT_APPROVED", [`policy status ${policy.status} is not ACTIVE; drafts cannot execute`]);
  const direct = evaluate(policy, role, requested, runtimeCapabilities);
  if (direct.status === "ALLOW" || substitute === undefined) return direct;
  // `substitutions` is optional: a policy without the key approves no pair (DENY, never a TypeError).
  const approved = list(policy.substitutions).some(pair => sameTuple(pair.from, requested) && sameTuple(pair.to, substitute));
  if (!approved) {
    return decision("DENY", "SUBSTITUTION_NOT_APPROVED", ["requested->substitute pair is not listed in substitutions"]);
  }
  const alt = evaluate(policy, role, substitute, runtimeCapabilities);
  return { ...alt, substituted_for: requested };
}

/**
 * Deterministic role default. No AI call. Rules: roles[role].default entries keyed by
 * runtime and risk ("*" = wildcard). Most specific wins: an exact runtime outranks an
 * exact risk; no match returns NO_DEFAULT (block, never a fallback). The returned
 * selection still has to pass resolveModelSelection (runtime support is checked there).
 */
export function selectDefault({ policy, role, runtime, risk } = {}) {
  if (policy === undefined || policy === null) return decision("DENY", "POLICY_MISSING", ["no model policy supplied"]);
  const checked = validateModelPolicy(policy);
  if (!checked.valid) return decision("DENY", "POLICY_INVALID", checked.errors);
  if (policy.status !== "ACTIVE") return decision("DENY", "POLICY_NOT_APPROVED", [`policy status ${policy.status} is not ACTIVE`]);
  if (!present(runtime) || runtime === WILDCARD || !RISK_LEVELS.includes(risk)) {
    return decision("DENY", "NO_DEFAULT", ["selection key needs a concrete runtime and risk low|medium|high"]);
  }
  const rules = hasOwn(policy.roles, role) && isRecord(policy.roles[role]) ? list(policy.roles[role].default) : [];
  const matches = rules.filter(rule => (rule.runtime === WILDCARD || rule.runtime === runtime)
    && (rule.risk === WILDCARD || rule.risk === risk));
  if (matches.length === 0) return decision("DENY", "NO_DEFAULT", [`no default for role ${role} runtime ${runtime} risk ${risk} (blocked, not substituted)`]);
  const rank = rule => (rule.runtime === runtime ? 2 : 0) * 10 + (rule.risk === risk ? 1 : 0);
  const best = [...matches].sort((a, b) => rank(b) - rank(a))[0];
  return decision("SELECTED", "DEFAULT_SELECTED", [], {
    role,
    runtime,
    risk,
    policy_version: policy.policy_version,
    rule: { runtime: best.runtime, risk: best.risk },
    selection: { provider: best.provider, model: best.model, effort: best.effort, mode: best.mode },
  });
}

// ---------- paths ----------

/**
 * Default active location: ${XDG_CONFIG_HOME}/oh-my-ai/model-policy.json when XDG_CONFIG_HOME is an
 * ABSOLUTE path, else ~/.config/oh-my-ai/model-policy.json. A relative XDG_CONFIG_HOME is ignored
 * (it would resolve against the caller's cwd). `via` is "xdg" when the XDG base moved the location
 * away from $HOME/.config, otherwise "default". Trust assumption: whoever controls the environment
 * controls this location, so env write access is policy authority (see docs/contracts/model-policy.md).
 */
export function resolveDefaultLocation(env = process.env) {
  const home = env.HOME || os.homedir();
  const defaultBase = path.join(home, ".config");
  const xdg = present(env.XDG_CONFIG_HOME) && path.isAbsolute(env.XDG_CONFIG_HOME) ? path.normalize(env.XDG_CONFIG_HOME) : null;
  const configHome = xdg ?? defaultBase;
  const via = xdg !== null && configHome !== path.normalize(defaultBase) ? "xdg" : "default";
  return { path: path.join(configHome, "oh-my-ai", "model-policy.json"), via };
}

/** Default active location path only (see resolveDefaultLocation). */
export function resolveDefaultPolicyPath(env = process.env) {
  return resolveDefaultLocation(env).path;
}

function resolveOverridePolicyPath(env) {
  return present(env.OH_MY_AI_MODEL_POLICY) ? path.resolve(env.OH_MY_AI_MODEL_POLICY) : null;
}

/**
 * validate / diff / check (dry): OH_MY_AI_MODEL_POLICY if set (via "override"), else the default
 * location (via "default" | "xdg"). Never execution: the result says where it came from, and
 * an override result is never execution approval.
 */
export function resolveDryPolicy(env = process.env) {
  const override = resolveOverridePolicyPath(env);
  if (override !== null) return { path: override, via: "override" };
  return resolveDefaultLocation(env);
}

/** Path-only form of resolveDryPolicy. */
export function resolveDryPolicyPath(env = process.env) {
  return resolveDryPolicy(env).path;
}

/**
 * Execution, apply and rollback. The default location is always used, unless the default
 * file is itself a valid ACTIVE policy that sets allow_path_override: true. A draft at the
 * override path can therefore never unlock execution.
 */
export function resolveExecutionPolicyPath(env = process.env) {
  const base0 = resolveDefaultLocation(env);
  const override = resolveOverridePolicyPath(env);
  if (override === null) return { path: base0.path, via: base0.via };
  const base = readPolicyFile(base0.path);
  if (base.status === "VALID" && base.policy.status === "ACTIVE" && base.policy.allow_path_override === true) {
    return { path: override, via: "override" };
  }
  return { path: base0.path, via: base0.via, override_ignored: override };
}

/** Archived copy of a previous version, stored next to the active file. */
export function previousCopyPath(activePath, previousVersion) {
  const dir = path.dirname(activePath);
  return path.join(dir, `model-policy.${previousVersion}.json`);
}

/** Read and validate a policy file. Never throws. Drafts are VALID here (validate/diff). */
export function readPolicyFile(filePath, options = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "POLICY_MISSING", path: filePath, policy: null, errors: [] };
    return { status: "POLICY_INVALID", path: filePath, policy: null, errors: ["unreadable: " + error.code] };
  }
  let policy;
  try {
    policy = JSON.parse(text);
  } catch {
    return { status: "POLICY_INVALID", path: filePath, policy: null, errors: ["not valid JSON"] };
  }
  const checked = validateModelPolicy(policy, options);
  if (!checked.valid) return { status: "POLICY_INVALID", path: filePath, policy: null, errors: checked.errors };
  return { status: "VALID", path: filePath, policy, errors: [] };
}

/**
 * The policy execution would use. Returns POLICY_NOT_APPROVED for any non-ACTIVE file.
 * This is the only loader the guard uses when given an env (not an object).
 */
export function loadExecutionPolicy(env = process.env) {
  const target = resolveExecutionPolicyPath(env);
  const read = readPolicyFile(target.path);
  const base = { path: target.path, via: target.via, policy: null };
  if (read.status !== "VALID") return { ...base, status: read.status, errors: read.errors };
  if (read.policy.status !== "ACTIVE") {
    return { ...base, status: "POLICY_NOT_APPROVED", errors: [`status ${read.policy.status} is not ACTIVE`] };
  }
  return { ...base, status: "VALID", policy: read.policy, errors: [] };
}

/**
 * Owner-facing summary of the execution policy (what the guard would load).
 * `status` is the validation/execution result (unchanged). The approval state of the file is
 * exposed separately: policy_status (ACTIVE / DRAFT*), approved_by, approved_at (null when absent).
 * Present whenever the file is readable and valid, including drafts; absent for missing/invalid files.
 * `approved_by` is masked (first character + "***") unless `showApprover` is true.
 */
export function maskApprover(value) {
  if (value === null || value === undefined) return null;
  return `${String(value).slice(0, 1)}***`;
}

export function describeActivePolicy(env = process.env, { showApprover = false } = {}) {
  const loaded = loadExecutionPolicy(env);
  const summary = { path: loaded.path, via: loaded.via, status: loaded.status, errors: loaded.errors, advisory: ["cost_limits"] };
  const file = loaded.policy ?? (loaded.status === "POLICY_NOT_APPROVED" ? readPolicyFile(loaded.path).policy : null);
  if (!file) return summary;
  const approval = {
    policy_status: file.status,
    approved_by: showApprover ? (file.approved_by ?? null) : maskApprover(file.approved_by),
    approved_at: file.approved_at ?? null,
  };
  if (!loaded.policy) return { ...summary, ...approval };
  const policy = loaded.policy;
  const archive = policy.previous_version === null ? null : previousCopyPath(loaded.path, policy.previous_version);
  return {
    ...summary,
    ...approval,
    policy_version: policy.policy_version,
    previous_version: policy.previous_version,
    previous_copy_available: archive !== null && fs.existsSync(archive),
    evaluation_ref: policy.evaluation_ref ?? null,
    enabled_models: policy.models.filter(m => m.enabled === true).map(m => ({
      provider: m.provider,
      family: m.family,
      version: m.version,
      id: m.id,
      efforts: Object.keys(m.efforts ?? {}).filter(k => m.efforts[k] === true),
      modes: Object.keys(m.modes ?? {}).filter(k => m.modes[k] === true),
    })),
    roles: Object.keys(policy.roles),
  };
}

// ---------- change management ----------

const tupleKey = t => `${t.provider}/${t.model}@${t.effort}/${t.mode}`;

function flattenPolicy(policy) {
  const out = new Map();
  out.set("status", policy.status);
  out.set("policy_version", policy.policy_version);
  for (const m of policy.models) {
    const base = `models[${m.provider}/${m.id}]`;
    out.set(`${base}.family`, m.family);
    out.set(`${base}.version`, m.version);
    out.set(`${base}.enabled`, m.enabled === true);
    for (const level of EFFORT_LEVELS) out.set(`${base}.efforts.${level}`, m.efforts?.[level] === true);
    for (const mode of MODES) out.set(`${base}.modes.${mode}`, m.modes?.[mode] === true);
  }
  for (const [role, entry] of Object.entries(policy.roles)) {
    for (const tuple of entry.allowed) out.set(`roles.${role}.allowed[${tupleKey(tuple)}]`, "ALLOWED");
    for (const rule of list(entry.default)) out.set(`roles.${role}.default[${rule.runtime}|${rule.risk}]`, tupleKey(rule));
  }
  for (const pair of list(policy.substitutions)) out.set(`substitutions[${tupleKey(pair.from)} -> ${tupleKey(pair.to)}]`, "PAIR");
  for (const [task, limit] of Object.entries(policy.cost_limits ?? {})) out.set(`cost_limits[${task}]`, JSON.stringify(limit));
  return out;
}

function changeKind(from, to) {
  if (typeof to === "boolean" || typeof from === "boolean") {
    if (to === true && from !== true) return "ON";
    if (from === true && to !== true) return "OFF";
  }
  if (from === undefined) return "ADDED";
  if (to === undefined) return "REMOVED";
  return "CHANGED";
}

/** Compare a validated candidate with the active policy (null = no active). Advisory report only. */
export function diffPolicies(active, candidate) {
  const before = active ? flattenPolicy(active) : new Map();
  const after = flattenPolicy(candidate);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = [];
  for (const key of keys) {
    const from = before.get(key);
    const to = after.get(key);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ path: key, change: changeKind(from, to), from: from ?? null, to: to ?? null });
  }
  const count = kind => changes.filter(c => c.change === kind).length;
  return {
    status: "DIFFED",
    active_version: active ? active.policy_version : null,
    candidate_version: candidate.policy_version,
    changes,
    summary: {
      on: count("ON"), off: count("OFF"), added: count("ADDED"), removed: count("REMOVED"), changed: count("CHANGED"),
      role_default_changes: changes.filter(c => c.path.includes(".default[")).length,
    },
  };
}

function writeFileAtomic(target, text) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw error;
  }
}

/**
 * apply: only an ACTIVE candidate with approval fields. Its previous_version must equal the
 * current active policy_version (or be null when none exists). The current active is copied
 * to model-policy.<version>.json first, then the candidate replaces the active file atomically (0600).
 * Target = execution location. Manual only (Owner gate); never called by the resolver.
 *
 * Human confirmation (mistake-guard, NOT a security boundary): options.isTTY must be true and
 * options.confirm(summary) must return true, else DENY. The CLI passes isTTY = stdin is a TTY and
 * a prompt that asks the operator to type the new policy_version. Whoever can write the candidate
 * and the active file can also call this with a scripted confirm; approved_by is only a declaration.
 * The gate runs before any file is read or written.
 */
export function applyPolicy(env = process.env, candidatePath, options = {}) {
  if (options.isTTY !== true || typeof options.confirm !== "function") {
    return decision("DENY", "APPLY_REQUIRES_TTY", ["apply needs an interactive terminal confirmation (stdin is not a TTY)"]);
  }
  const candidate = readPolicyFile(path.resolve(candidatePath));
  if (candidate.status !== "VALID") return decision("DENY", "POLICY_INVALID", ["candidate invalid or missing", ...candidate.errors]);
  if (candidate.policy.status !== "ACTIVE") return decision("DENY", "POLICY_NOT_APPROVED", [`candidate status ${candidate.policy.status} is not ACTIVE`]);
  const candidateText = fs.readFileSync(path.resolve(candidatePath), "utf8");
  const target = resolveExecutionPolicyPath(env).path;
  const activePath = fs.existsSync(target) ? fs.realpathSync(target) : target;
  let active = null;
  let activeText = null;
  if (fs.existsSync(activePath)) {
    activeText = fs.readFileSync(activePath, "utf8");
    active = readPolicyFile(activePath);
    if (active.status !== "VALID") return decision("DENY", "POLICY_INVALID", ["active policy invalid; repair manually before apply", ...active.errors]);
    if (candidate.policy.policy_version === active.policy.policy_version) return decision("DENY", "POLICY_INVALID", ["candidate policy_version equals active"]);
    if (candidate.policy.previous_version !== active.policy.policy_version) {
      return decision("DENY", "POLICY_INVALID", ["candidate previous_version must equal the active policy_version"]);
    }
  } else if (candidate.policy.previous_version !== null) {
    return decision("DENY", "POLICY_INVALID", ["no active policy: candidate previous_version must be null"]);
  }
  let archivePath = null;
  if (active) {
    archivePath = previousCopyPath(activePath, active.policy.policy_version);
    if (fs.existsSync(archivePath) && fs.readFileSync(archivePath, "utf8") !== activeText) {
      return decision("DENY", "POLICY_INVALID", ["archive for the active version exists with different content; resolve manually"]);
    }
  }
  const summary = {
    from_version: active ? active.policy.policy_version : null,
    to_version: candidate.policy.policy_version,
    path: activePath,
    approved_by: candidate.policy.approved_by,
  };
  if (options.confirm(summary) !== true) {
    return decision("DENY", "APPLY_NOT_CONFIRMED", ["operator did not confirm; nothing was written"], summary);
  }
  if (active && !fs.existsSync(archivePath)) writeFileAtomic(archivePath, activeText);
  fs.mkdirSync(path.dirname(activePath), { recursive: true, mode: 0o700 });
  writeFileAtomic(activePath, candidateText);
  return decision("ALLOW", "APPLIED", [], {
    from_version: active ? active.policy.policy_version : null,
    to_version: candidate.policy.policy_version,
    archived: archivePath,
    path: activePath,
  });
}

/**
 * Manual rollback: swap the active file with the archived copy named by the active
 * file's previous_version. Refuses (no change) when the copy is missing or invalid.
 * Never called automatically. The replaced active version is archived first.
 *
 * Same human gate as apply (mistake-guard, not a security boundary; see docs/contracts/model-policy.md):
 * options.isTTY must be true and options.confirm(summary) must return true, else DENY. Checked before
 * any file is read; the confirmation runs after validation and before any write.
 */
export function rollbackPolicy(env = process.env, options = {}) {
  if (options.isTTY !== true || typeof options.confirm !== "function") {
    return decision("DENY", "ROLLBACK_REQUIRES_TTY", ["rollback needs an interactive terminal confirmation (stdin is not a TTY)"]);
  }
  const requestedPath = resolveExecutionPolicyPath(env).path;
  if (!fs.existsSync(requestedPath)) return decision("DENY", "POLICY_MISSING", ["active policy missing; nothing to roll back"]);
  const activePath = fs.realpathSync(requestedPath);
  const activeText = fs.readFileSync(activePath, "utf8");
  const active = readPolicyFile(activePath);
  if (active.status !== "VALID") return decision("DENY", "POLICY_INVALID", ["active policy invalid; refusing rollback", ...active.errors]);
  if (active.policy.previous_version === null) return decision("DENY", "POLICY_INVALID", ["previous_version is null; no rollback target"]);

  const copyPath = previousCopyPath(activePath, active.policy.previous_version);
  if (!fs.existsSync(copyPath)) return decision("DENY", "POLICY_MISSING", ["previous_version copy not found; rollback not performed"]);
  const previous = readPolicyFile(copyPath);
  if (previous.status !== "VALID") return decision("DENY", "POLICY_INVALID", ["previous copy invalid", ...previous.errors]);
  if (previous.policy.status !== "ACTIVE") return decision("DENY", "POLICY_NOT_APPROVED", ["previous copy was not ACTIVE; rollback target must be an approved version"]);
  if (previous.policy.policy_version !== active.policy.previous_version) {
    return decision("DENY", "POLICY_INVALID", ["previous copy policy_version does not match previous_version"]);
  }

  const archivePath = previousCopyPath(activePath, active.policy.policy_version);
  if (fs.existsSync(archivePath) && fs.readFileSync(archivePath, "utf8") !== activeText) {
    return decision("DENY", "POLICY_INVALID", ["archive for the active version exists with different content; resolve manually"]);
  }
  const summary = {
    from_version: active.policy.policy_version,
    to_version: previous.policy.policy_version,
    path: activePath,
    approved_by: previous.policy.approved_by,
  };
  if (options.confirm(summary) !== true) {
    return decision("DENY", "ROLLBACK_NOT_CONFIRMED", ["operator did not confirm; nothing was written"], summary);
  }
  writeFileAtomic(archivePath, activeText);
  writeFileAtomic(activePath, fs.readFileSync(copyPath, "utf8"));
  return decision("ALLOW", "ROLLED_BACK", [], {
    from_version: active.policy.policy_version,
    to_version: previous.policy.policy_version,
    archived: archivePath,
  });
}
