import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { types as utilTypes } from "node:util";

const STATE_ROOT_OPTION_KEYS = Object.freeze([
  "stateRootOverride",
  "env",
  "homeDirectory",
  "protectedRepositoryCwds",
]);
const STATE_ROOT_ENV_KEYS = Object.freeze(["OH_MY_AI_STATE_ROOT", "XDG_STATE_HOME"]);

/**
 * Snapshot the RPL-95 root selector so a caller cannot redirect F4 records
 * after a Host verification. These are path selectors, never credentials.
 */
export function snapshotF4StateRootOptions(value) {
  const source = value === undefined ? Object.create(null) : value;
  const inspected = inspectExactDataObject(source, [], STATE_ROOT_OPTION_KEYS);
  if (!inspected.ok) return null;

  const options = inspected.values;
  const stateRootOverride = Object.hasOwn(options, "stateRootOverride")
    ? options.stateRootOverride
    : undefined;
  if (stateRootOverride !== undefined && stateRootOverride !== null
    && (typeof stateRootOverride !== "string" || stateRootOverride.includes("\0")
      || (stateRootOverride !== "" && !path.isAbsolute(stateRootOverride)))) return null;

  const environment = snapshotStateRootEnvironment(options.env ?? process.env);
  if (environment === null) return null;
  const homeDirectory = options.homeDirectory === undefined ? os.homedir() : options.homeDirectory;
  if (typeof homeDirectory !== "string" || !path.isAbsolute(homeDirectory) || homeDirectory.includes("\0")) {
    return null;
  }
  const protectedRepositoryCwds = snapshotProtectedRepositoryCwds(options.protectedRepositoryCwds ?? []);
  if (protectedRepositoryCwds === null) return null;

  return Object.freeze({ stateRootOverride, env: environment, homeDirectory, protectedRepositoryCwds });
}

/**
 * Bind F4 records to the physical RPL-95 root, repository, and worktree.
 * The root identity includes the canonical path and filesystem directory
 * generation (device, inode, and birth time), so replacing a directory at the
 * same path changes the binding. A missing/unstatable root fails closed.
 */
export function f4PhysicalStateBindingFromLocation(location) {
  const rootPath = ownData(location, "rootPath");
  const repositoryRoot = ownData(location, "repositoryRoot");
  const repositoryId = ownData(location, "repositoryId");
  const worktreeId = ownData(location, "worktreeId");
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath) || rootPath.includes("\0")
    || typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot) || repositoryRoot.includes("\0")
    || !isPhysicalIdentity(repositoryId)
    || !isPhysicalIdentity(worktreeId)) {
    return failure("manual_resume_worktree_binding_unverified");
  }

  let canonicalRoot;
  let rootStat;
  try {
    canonicalRoot = fs.realpathSync.native(rootPath);
    rootStat = fs.statSync(canonicalRoot, { bigint: true });
  } catch {
    return failure("manual_resume_worktree_binding_unverified");
  }
  if (!rootStat.isDirectory() || rootStat.ino <= 0n || rootStat.birthtimeNs <= 0n) {
    return failure("manual_resume_worktree_binding_unverified");
  }

  const rootGeneration = [
    rootStat.dev.toString(),
    rootStat.ino.toString(),
    rootStat.birthtimeNs.toString(),
  ].join("\0");
  const stateRootIdentity = createHash("sha256")
    .update(`rpl95-state-root-v2\0${path.resolve(rootPath)}\0${canonicalRoot}\0${rootGeneration}`, "utf8")
    .digest("hex");
  return success(Object.freeze({
    contract: "rpl95-worktree-state-v2",
    state_root_identity: stateRootIdentity,
    repository_instance_id: repositoryId,
    physical_worktree_id: worktreeId,
  }));
}

export function sameF4PhysicalStateBinding(left, right) {
  return isPlainObject(left) && isPlainObject(right)
    && left.contract === right.contract
    && left.state_root_identity === right.state_root_identity
    && left.repository_instance_id === right.repository_instance_id
    && left.physical_worktree_id === right.physical_worktree_id;
}

function snapshotStateRootEnvironment(value) {
  if (utilTypes.isProxy(value) || (value !== process.env && !isPlainObject(value))) return null;
  const snapshot = Object.create(null);
  for (const key of STATE_ROOT_ENV_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!isEnumerableDataDescriptor(descriptor)) return null;
    const item = descriptor.value;
    if (item !== undefined && item !== null
      && !["string", "number", "boolean"].includes(typeof item)) return null;
    snapshot[key] = item;
  }
  return Object.freeze(snapshot);
}

function snapshotProtectedRepositoryCwds(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return null;
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > 1024) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1
    || keys.some(key => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) return null;
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!isEnumerableDataDescriptor(descriptor)
      || typeof descriptor.value !== "string"
      || descriptor.value.includes("\0")) return null;
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function inspectExactDataObject(value, requiredKeys, optionalKeys = []) {
  try {
    if (!isPlainObject(value)) return failure("invalid");
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string" || !allowed.has(key))) return failure("invalid");
    for (const key of requiredKeys) if (!keys.includes(key)) return failure("invalid");
    const values = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return failure("invalid");
      values[key] = descriptor.value;
    }
    return { ok: true, values };
  } catch {
    return failure("invalid");
  }
}

function isPhysicalIdentity(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function ownData(value, key) {
  if (!isPlainObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return isEnumerableDataDescriptor(descriptor) ? descriptor.value : undefined;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && Object.hasOwn(descriptor, "value")
    && descriptor.enumerable === true;
}

function success(value) { return { ok: true, value }; }
function failure(reason) { return { ok: false, reason }; }
