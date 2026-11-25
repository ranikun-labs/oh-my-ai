/**
 * Model policy: private, owner-edited permission file + deterministic resolver.
 * Schema: docs/contracts/model-policy.md.
 *
 * Scope boundary: this module validates a policy and decides ALLOW/DENY for one
 * requested {provider, model, effort, mode} selection. It does NOT load evaluation
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
export const DECISION_CODES = Object.freeze([
  "POLICY_MISSING", "POLICY_INVALID", "UNKNOWN_MODEL", "MODEL_DISABLED", "EFFORT_DISABLED",
  "MODE_DISABLED", "ROLE_NOT_ALLOWED", "RUNTIME_UNSUPPORTED", "SUBSTITUTION_NOT_APPROVED",
]);

const TOP_KEYS = ["schema_version", "policy_version", "previous_version", "models", "roles", "default", "cost_limits", "substitutions", "evaluation_ref"];
const REQUIRED_TOP_KEYS = ["schema_version", "policy_version", "previous_version", "models", "roles"];
const MODEL_KEYS = ["provider", "id", "enabled", "efforts", "modes"];
const TUPLE_KEYS = ["provider", "model", "effort", "mode"];
const VERSION = /^[A-Za-z0-9._-]+$/;
const hasOwn = (obj, key) => obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const present = value => typeof value === "string" && value.trim().length > 0;
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

/** Structural validation of a parsed policy object. Returns { valid, errors }. */
export function validateModelPolicy(policy) {
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

  const modelKeys = new Set();
  if (!Array.isArray(policy.models)) errors.push("models must be an array");
  else {
    policy.models.forEach((model, i) => {
      const where = `models[${i}]`;
      if (!isRecord(model)) { errors.push(where + " must be an object"); return; }
      for (const key of Object.keys(model)) if (!MODEL_KEYS.includes(key)) errors.push(`${where}.${key} is not allowed`);
      if (!present(model.provider)) errors.push(where + ".provider missing");
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
  else for (const [role, entries] of Object.entries(policy.roles)) {
    if (!Array.isArray(entries)) { errors.push(`roles.${role} must be an array`); continue; }
    entries.forEach((entry, i) => errors.push(...tupleErrors(entry, `roles.${role}[${i}]`, modelKeys)));
  }

  if (hasOwn(policy, "default") && policy.default !== undefined) {
    errors.push(...tupleErrors(policy.default, "default", modelKeys));
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
  return { valid: errors.length === 0, errors };
}

function sameTuple(a, b) {
  return isRecord(a) && isRecord(b) && TUPLE_KEYS.every(k => a[k] === b[k]);
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
  const allowed = hasOwn(policy.roles, role) ? policy.roles[role] : undefined;
  if (!Array.isArray(allowed) || !allowed.some(entry => sameTuple(entry, requested))) {
    return decision("DENY", "ROLE_NOT_ALLOWED", [`role ${role} is not allowed this selection`]);
  }
  const runtime = isRecord(runtimeCapabilities) && hasOwn(runtimeCapabilities, requested.provider) ? runtimeCapabilities[requested.provider] : undefined;
  if (!isRecord(runtime)) {
    return decision("DENY", "RUNTIME_UNSUPPORTED", [`no runtime capability supplied for provider ${requested.provider} (fail-closed)`]);
  }
  const list = value => Array.isArray(value) ? value : [];
  const supported = list(runtime.models).includes(requested.model)
    && list(runtime.efforts).includes(requested.effort)
    && list(runtime.modes).includes(requested.mode);
  if (!supported) return decision("DENY", "RUNTIME_UNSUPPORTED", ["runtime does not support the requested model/effort/mode"]);
  return decision("ALLOW", "ALLOW", [], {
    role,
    policy_version: policy.policy_version,
    resolved: { provider: requested.provider, model: requested.model, effort: requested.effort, mode: requested.mode },
  });
}

/**
 * Decide ALLOW/DENY for one selection. No implicit fallback: a substitute is used only
 * when the caller passes `substitute` AND the exact (requested -> substitute) pair is
 * listed in policy.substitutions.
 */
export function resolveModelSelection({ policy, role, requested, runtimeCapabilities, substitute } = {}) {
  if (policy === undefined || policy === null) return decision("DENY", "POLICY_MISSING", ["no model policy supplied"]);
  const checked = validateModelPolicy(policy);
  if (!checked.valid) return decision("DENY", "POLICY_INVALID", checked.errors);
  const direct = evaluate(policy, role, requested, runtimeCapabilities);
  if (direct.status === "ALLOW" || substitute === undefined) return direct;
  const approved = policy.substitutions.some(pair => sameTuple(pair.from, requested) && sameTuple(pair.to, substitute));
  if (!approved) {
    return decision("DENY", "SUBSTITUTION_NOT_APPROVED", ["requested->substitute pair is not listed in substitutions"]);
  }
  const alt = evaluate(policy, role, substitute, runtimeCapabilities);
  return { ...alt, substituted_for: requested };
}

// ---------- file helpers (explicit paths/env; never reads $HOME unless asked) ----------

/** Active policy path: OH_MY_AI_MODEL_POLICY, else ${XDG_CONFIG_HOME:-~/.config}/oh-my-ai/model-policy.json. */
export function resolvePolicyPath(env = process.env) {
  if (present(env.OH_MY_AI_MODEL_POLICY)) return path.resolve(env.OH_MY_AI_MODEL_POLICY);
  const configHome = present(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(env.HOME || os.homedir(), ".config");
  return path.join(configHome, "oh-my-ai", "model-policy.json");
}

/** Archived copy of a previous version, stored next to the active file. */
export function previousCopyPath(activePath, previousVersion) {
  const dir = path.dirname(activePath);
  return path.join(dir, `model-policy.${previousVersion}.json`);
}

/** Read and validate a policy file. Never throws; returns a status for the caller. */
export function readPolicyFile(filePath) {
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
  const checked = validateModelPolicy(policy);
  if (!checked.valid) return { status: "POLICY_INVALID", path: filePath, policy: null, errors: checked.errors };
  return { status: "VALID", path: filePath, policy, errors: [] };
}

/** Owner-facing summary of the active policy. Pass env explicitly in tests. */
export function describeActivePolicy(env = process.env) {
  const filePath = resolvePolicyPath(env);
  const read = readPolicyFile(filePath);
  const base = { path: filePath, status: read.status, errors: read.errors };
  if (read.status !== "VALID") return base;
  const policy = read.policy;
  const archive = policy.previous_version === null ? null : previousCopyPath(filePath, policy.previous_version);
  return {
    ...base,
    policy_version: policy.policy_version,
    previous_version: policy.previous_version,
    previous_copy_available: archive !== null && fs.existsSync(archive),
    evaluation_ref: policy.evaluation_ref ?? null,
    enabled_models: policy.models.filter(m => m.enabled === true).map(m => ({
      provider: m.provider,
      id: m.id,
      efforts: Object.keys(m.efforts ?? {}).filter(k => m.efforts[k] === true),
      modes: Object.keys(m.modes ?? {}).filter(k => m.modes[k] === true),
    })),
    roles: Object.keys(policy.roles),
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
 * Manual rollback: swap the active file with the archived copy named by the active
 * file's previous_version. Refuses (no change) when the copy is missing or invalid.
 * Never called automatically. The replaced active version is archived first.
 */
export function rollbackPolicy(env = process.env) {
  const requestedPath = resolvePolicyPath(env);
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
  if (previous.policy.policy_version !== active.policy.previous_version) {
    return decision("DENY", "POLICY_INVALID", ["previous copy policy_version does not match previous_version"]);
  }

  const archivePath = previousCopyPath(activePath, active.policy.policy_version);
  if (fs.existsSync(archivePath) && fs.readFileSync(archivePath, "utf8") !== activeText) {
    return decision("DENY", "POLICY_INVALID", ["archive for the active version exists with different content; resolve manually"]);
  }
  writeFileAtomic(archivePath, activeText);
  writeFileAtomic(activePath, fs.readFileSync(copyPath, "utf8"));
  return decision("ALLOW", "ROLLED_BACK", [], {
    from_version: active.policy.policy_version,
    to_version: previous.policy.policy_version,
    archived: archivePath,
  });
}
