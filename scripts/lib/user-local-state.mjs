import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const LOCATION_BRAND = Symbol("user-local-state-location");
const STATE_ROOT_ENV = "OH_MY_AI_STATE_ROOT";
const APP_DIRECTORY = "oh-my-ai";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 10;
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));

/**
 * A stable, machine-readable failure from the physical state layer.
 * Consumers choose whether the failure is fail-open or fail-closed.
 */
export class UserLocalStateError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "UserLocalStateError";
    this.code = code;
  }
}

/**
 * Resolve the application state root. OH_MY_AI_STATE_ROOT is an explicit
 * override for the complete app root; otherwise XDG_STATE_HOME/oh-my-ai or
 * ~/.local/state/oh-my-ai is used.
 */
export function resolveUserLocalStateRoot({
  stateRootOverride,
  env = process.env,
  homeDirectory = os.homedir(),
} = {}) {
  const override = stateRootOverride ?? env[STATE_ROOT_ENV];
  if (override !== undefined && override !== null && override !== "") {
    if (typeof override !== "string" || !path.isAbsolute(override) || override.includes("\0")) {
      throw new UserLocalStateError(
        "state_root_invalid",
        "The explicit user-local state root must be an absolute path.",
      );
    }
    return canonicalizeNonexistentPath(path.resolve(override));
  }

  const xdgRoot = env.XDG_STATE_HOME;
  let stateHome;
  if (typeof xdgRoot === "string" && xdgRoot !== "" && path.isAbsolute(xdgRoot) && !xdgRoot.includes("\0")) {
    stateHome = path.resolve(xdgRoot);
  } else {
    if (typeof homeDirectory !== "string" || homeDirectory === "" || !path.isAbsolute(homeDirectory)) {
      throw new UserLocalStateError(
        "state_root_unavailable",
        "A usable home directory is unavailable for user-local state.",
      );
    }
    stateHome = path.join(path.resolve(homeDirectory), ".local", "state");
  }

  return canonicalizeNonexistentPath(path.join(stateHome, APP_DIRECTORY));
}

/**
 * Resolve one path-safe state file within a repository-instance/worktree
 * namespace. Git common-dir identity separates clones; Git worktree identity
 * separates worktrees and remains stable across branch switches.
 */
export function resolveUserLocalStateLocation(cwd, relativePath, options = {}) {
  const identity = resolveGitIdentity(cwd);
  const rootPath = resolveUserLocalStateRoot(options);
  assertStateRootOutsideRepository(rootPath, identity.repositoryRoot);

  const segments = validateRelativeSegments(relativePath);
  const namespacePath = path.join(
    rootPath,
    "repositories",
    identity.repositoryId,
    "worktrees",
    identity.worktreeId,
  );
  const filePath = path.join(namespacePath, ...segments);
  const directoryPath = path.dirname(filePath);
  const location = {
    rootPath,
    repositoryRoot: identity.repositoryRoot,
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    relativePath: segments.join(path.sep),
    namespacePath,
    directoryPath,
    filePath,
  };
  Object.defineProperty(location, LOCATION_BRAND, { value: true });
  return Object.freeze(location);
}

/**
 * Read a resolved user-local file. A missing file returns null. Corruption,
 * unsafe paths, and permission errors are surfaced as typed failures.
 */
export function readUserLocalState(location) {
  const checked = assertLocation(location);
  if (!assertExistingStateDirectoryTree(checked)) return null;

  let stat;
  try {
    stat = fs.lstatSync(checked.filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw stateError("state_read_failed", error);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new UserLocalStateError(
      "state_path_unsafe",
      "The user-local state file is not a regular file.",
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new UserLocalStateError("state_permissions_unsafe", "The user-local state file has a different owner.");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new UserLocalStateError(
      "state_permissions_unsafe",
      "The user-local state file is accessible outside the current user.",
    );
  }
  try {
    return fs.readFileSync(checked.filePath, "utf8");
  } catch (error) {
    throw stateError("state_read_failed", error);
  }
}

/**
 * Atomically publish complete file contents. Callers performing a
 * read-modify-write must hold withPhysicalStateLock for the same location.
 */
export function publishUserLocalStateAtomically(location, contents) {
  const checked = assertLocation(location);
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), "utf8");
  ensureStateDirectoryTree(checked);
  assertTargetIsRegularOrMissing(checked.filePath);

  const temporaryPath = path.join(
    checked.directoryPath,
    `.${path.basename(checked.filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  let descriptor;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    assertTargetIsRegularOrMissing(checked.filePath);
    fs.renameSync(temporaryPath, checked.filePath);
    renamed = true;
    fsyncDirectory(checked.directoryPath);
    return Object.freeze({ published: true, byteLength: bytes.length });
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (!renamed) {
      try { fs.unlinkSync(temporaryPath); } catch {}
      if (error instanceof UserLocalStateError) throw error;
      throw stateError("state_publish_failed", error);
    }
    if (error instanceof UserLocalStateError) throw error;
    throw stateError("state_publish_durability_unknown", error);
  }
}

/**
 * Run a synchronous read-modify-publish operation under an exclusive
 * filesystem lock. A dead same-host owner is recovered by a guarded rename;
 * malformed, foreign-host, or ambiguous lock metadata fails closed.
 */
export function withPhysicalStateLock(location, operation, options = {}) {
  const checked = assertLocation(location);
  if (typeof operation !== "function") {
    throw new UserLocalStateError(
      "state_lock_callback_invalid",
      "A synchronous operation callback is required for a physical state lock.",
    );
  }

  const timeoutMs = positiveNumber(options.timeoutMs, LOCK_TIMEOUT_MS);
  const retryIntervalMs = positiveNumber(options.retryIntervalMs, LOCK_RETRY_MS);
  ensureStateDirectoryTree(checked);
  const lockPath = `${checked.filePath}.lock`;
  const token = crypto.randomUUID();
  const owner = lockOwner(token);
  const startedAt = Date.now();

  acquireLock(lockPath, owner, startedAt, timeoutMs, retryIntervalMs);
  let operationError;
  try {
    const result = operation();
    if (result && typeof result.then === "function") {
      throw new UserLocalStateError(
        "state_lock_callback_invalid",
        "Physical state lock callbacks must complete synchronously.",
      );
    }
    return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      releaseOwnedLock(lockPath, token);
    } catch (releaseError) {
      if (operationError && typeof operationError === "object") {
        operationError.releaseError = releaseError;
      } else {
        throw releaseError;
      }
    }
  }
}

function resolveGitIdentity(cwd) {
  if (typeof cwd !== "string" || cwd === "" || cwd.includes("\0")) {
    throw new UserLocalStateError(
      "repository_identity_unavailable",
      "A repository working directory is required to resolve user-local state.",
    );
  }

  let canonicalCwd;
  try {
    canonicalCwd = fs.realpathSync(path.resolve(cwd));
  } catch (error) {
    throw stateError("repository_identity_unavailable", error);
  }

  const repositoryRoot = runGitPath(canonicalCwd, ["rev-parse", "--show-toplevel"]);
  const canonicalRepositoryRoot = realDirectory(repositoryRoot, "repository_identity_unavailable");
  const gitDirectory = runGitPath(canonicalRepositoryRoot, ["rev-parse", "--absolute-git-dir"]);
  const commonDirectoryValue = runGitPath(canonicalRepositoryRoot, ["rev-parse", "--git-common-dir"]);
  const canonicalGitDirectory = realDirectory(
    path.isAbsolute(gitDirectory) ? gitDirectory : path.resolve(canonicalRepositoryRoot, gitDirectory),
    "repository_identity_unavailable",
  );
  const canonicalCommonDirectory = realDirectory(
    path.isAbsolute(commonDirectoryValue)
      ? commonDirectoryValue
      : path.resolve(canonicalRepositoryRoot, commonDirectoryValue),
    "repository_identity_unavailable",
  );

  return {
    repositoryRoot: canonicalRepositoryRoot,
    repositoryId: digest(`oh-my-ai-repository-instance-v1\0${canonicalCommonDirectory}`),
    worktreeId: digest(`oh-my-ai-worktree-v1\0${canonicalGitDirectory}`),
  };
}

function runGitPath(cwd, args) {
  let result;
  try {
    result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    throw stateError("repository_identity_unavailable", error);
  }
  if (result.error || result.status !== 0) {
    throw stateError("repository_identity_unavailable", result.error);
  }
  const value = String(result.stdout || "").trim();
  if (!value) {
    throw new UserLocalStateError(
      "repository_identity_unavailable",
      "Git did not return the required repository identity.",
    );
  }
  return value;
}

function realDirectory(candidate, code) {
  try {
    const canonical = fs.realpathSync(path.resolve(candidate));
    if (!fs.statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    throw stateError(code, error);
  }
}

function canonicalizeNonexistentPath(candidate) {
  let existing = path.resolve(candidate);
  const tail = [];
  while (true) {
    try {
      const stat = fs.lstatSync(existing);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new UserLocalStateError(
          "state_root_invalid",
          "The configured user-local state root crosses a non-directory path.",
        );
      }
      if (stat.isSymbolicLink() && path.resolve(existing) === path.resolve(candidate)) {
        throw new UserLocalStateError(
          "state_path_unsafe",
          "The configured user-local state root cannot be a symbolic link.",
        );
      }
      const canonicalAncestor = fs.realpathSync(existing);
      return path.join(canonicalAncestor, ...tail);
    } catch (error) {
      if (error instanceof UserLocalStateError) throw error;
      if (error?.code !== "ENOENT") throw stateError("state_root_unavailable", error);
      const parent = path.dirname(existing);
      if (parent === existing) throw stateError("state_root_unavailable", error);
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function validateRelativeSegments(relativePath) {
  if (typeof relativePath !== "string" || relativePath === "" || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new UserLocalStateError("state_path_unsafe", "A relative state file path is required.");
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    throw new UserLocalStateError("state_path_unsafe", "State file paths cannot traverse directories.");
  }
  return segments;
}

function assertLocation(location) {
  if (!location || location[LOCATION_BRAND] !== true) {
    throw new UserLocalStateError(
      "state_path_unsafe",
      "A location returned by resolveUserLocalStateLocation is required.",
    );
  }
  const { rootPath, repositoryRoot, repositoryId, worktreeId, relativePath, namespacePath, directoryPath, filePath } = location;
  if (!path.isAbsolute(rootPath) || !path.isAbsolute(repositoryRoot)
    || !/^[a-f0-9]{64}$/.test(repositoryId) || !/^[a-f0-9]{64}$/.test(worktreeId)) {
    throw new UserLocalStateError("state_path_unsafe", "The user-local state location is invalid.");
  }
  assertStateRootOutsideRepository(rootPath, repositoryRoot);
  const expectedNamespace = path.join(rootPath, "repositories", repositoryId, "worktrees", worktreeId);
  let segments;
  try { segments = validateRelativeSegments(relativePath); } catch {
    throw new UserLocalStateError("state_path_unsafe", "The user-local state location is invalid.");
  }
  const expectedFile = path.join(expectedNamespace, ...segments);
  if (namespacePath !== expectedNamespace || filePath !== expectedFile || directoryPath !== path.dirname(expectedFile)) {
    throw new UserLocalStateError("state_path_unsafe", "The user-local state location escapes its namespace.");
  }
  return location;
}

function assertStateRootOutsideRepository(stateRoot, repositoryRoot) {
  const canonicalRoot = path.resolve(stateRoot);
  const canonicalRepository = path.resolve(repositoryRoot);
  const relative = path.relative(canonicalRepository, canonicalRoot);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new UserLocalStateError(
      "state_path_unsafe",
      "The user-local state root cannot be inside the Product repository/worktree.",
    );
  }
}

function ensureStateDirectoryTree(location) {
  const checked = assertLocation(location);
  try {
    fs.mkdirSync(checked.rootPath, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(checked.rootPath, checked.rootPath);
    const directories = [
      path.join(checked.rootPath, "repositories"),
      path.join(checked.rootPath, "repositories", checked.repositoryId),
      path.join(checked.rootPath, "repositories", checked.repositoryId, "worktrees"),
      checked.namespacePath,
    ];
    let nestedDirectory = checked.namespacePath;
    for (const segment of path.relative(checked.namespacePath, checked.directoryPath).split(path.sep).filter(Boolean)) {
      nestedDirectory = path.join(nestedDirectory, segment);
      directories.push(nestedDirectory);
    }
    for (const directory of directories) {
      try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      assertPrivateDirectory(directory, checked.rootPath);
    }
  } catch (error) {
    if (error instanceof UserLocalStateError) throw error;
    throw stateError("state_root_unavailable", error);
  }
}

function assertExistingStateDirectoryTree(location) {
  const checked = assertLocation(location);
  const directories = [
    checked.rootPath,
    path.join(checked.rootPath, "repositories"),
    path.join(checked.rootPath, "repositories", checked.repositoryId),
    path.join(checked.rootPath, "repositories", checked.repositoryId, "worktrees"),
    checked.namespacePath,
  ];
  let nestedDirectory = checked.namespacePath;
  for (const segment of path.relative(checked.namespacePath, checked.directoryPath).split(path.sep).filter(Boolean)) {
    nestedDirectory = path.join(nestedDirectory, segment);
    directories.push(nestedDirectory);
  }
  for (const directory of directories) {
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw stateError("state_read_failed", error);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new UserLocalStateError("state_path_unsafe", "The user-local state namespace contains a non-directory or symbolic link.");
    }
    assertPrivateDirectory(directory, checked.rootPath);
  }
  return true;
}

function assertPrivateDirectory(directory, rootPath) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
      throw new UserLocalStateError("state_path_unsafe", "The user-local state namespace contains a symbolic link.");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new UserLocalStateError("state_permissions_unsafe", "The user-local state directory has a different owner.");
    }
    if ((stat.mode & 0o077) !== 0) tightenOwnedDirectoryPermissions(directory, stat);
    const relative = path.relative(rootPath, path.resolve(directory));
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new UserLocalStateError("state_path_unsafe", "The state namespace escaped its configured root.");
    }
  } catch (error) {
    if (error instanceof UserLocalStateError) throw error;
    throw stateError("state_root_unavailable", error);
  }
}

function tightenOwnedDirectoryPermissions(directory, stat) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid === null || stat.uid !== currentUid) {
    throw new UserLocalStateError("state_permissions_unsafe", "The user-local state directory is accessible outside the current user or has a different owner.");
  }
  try {
    // Older hook diagnostics created this app-specific root with mkdir's
    // default 0755 mode. Tighten only directories owned by this user; never
    // adopt or chmod a foreign-owned state tree.
    fs.chmodSync(directory, 0o700);
    const tightened = fs.lstatSync(directory);
    if (!tightened.isDirectory() || tightened.isSymbolicLink() || (tightened.mode & 0o077) !== 0) {
      throw new UserLocalStateError("state_permissions_unsafe", "The user-local state directory could not be made private.");
    }
  } catch (error) {
    if (error instanceof UserLocalStateError) throw error;
    throw stateError("state_permissions_unsafe", error);
  }
}

function assertTargetIsRegularOrMissing(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new UserLocalStateError("state_path_unsafe", "The user-local state target is not a regular file.");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new UserLocalStateError("state_permissions_unsafe", "The user-local state target has a different owner.");
    }
  } catch (error) {
    if (error instanceof UserLocalStateError) throw error;
    if (error?.code !== "ENOENT") throw stateError("state_write_failed", error);
  }
}

function acquireLock(lockPath, owner, startedAt, timeoutMs, retryIntervalMs) {
  while (true) {
    try {
      createOwnedLock(lockPath, owner);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw stateError("state_lock_acquire_failed", error);
    }

    let existing;
    try {
      existing = readLockOwner(lockPath);
    } catch (error) {
      if (error?.code !== "state_lock_owner_initializing") throw error;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new UserLocalStateError("state_lock_owner_unknown", "The physical state lock owner metadata remained incomplete until timeout.");
      }
      Atomics.wait(WAIT_CELL, 0, 0, retryIntervalMs);
      continue;
    }
    if (existing === null) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new UserLocalStateError("state_lock_timeout", "The physical state lock remained in transition until timeout.");
      }
      Atomics.wait(WAIT_CELL, 0, 0, retryIntervalMs);
      continue;
    }
    const status = lockOwnerStatus(existing);
    if (status === "unknown") {
      throw new UserLocalStateError(
        "state_lock_owner_unknown",
        "The physical state lock owner cannot be verified safely.",
      );
    }
    if (status === "dead") {
      const recovered = recoverOrphanedLock(lockPath, existing);
      if (!recovered && Date.now() - startedAt >= timeoutMs) {
        throw new UserLocalStateError("state_lock_timeout", "The physical state lock recovery remained blocked until timeout.");
      }
      if (!recovered) Atomics.wait(WAIT_CELL, 0, 0, retryIntervalMs);
      continue;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new UserLocalStateError("state_lock_timeout", "The physical state lock remained held until timeout.");
    }
    Atomics.wait(WAIT_CELL, 0, 0, retryIntervalMs);
  }
}

function createOwnedLock(lockPath, owner) {
  const temporaryPath = `${lockPath}.owner-${owner.token}.tmp`;
  let descriptor;
  let linked = false;
  try {
    descriptor = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    writeAll(descriptor, Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // The lock becomes visible in one atomic operation, already containing
    // complete, durable owner metadata. O_EXCL on a file opened directly at
    // lockPath would expose a brief empty/partial-file window to contenders.
    fs.linkSync(temporaryPath, lockPath);
    linked = true;
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(path.dirname(lockPath));
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporaryPath); } catch {}
    if (linked) {
      try { removeLockIfOwned(lockPath, owner.token); } catch {}
    }
    if (error?.code === "EEXIST") throw error;
    if (error instanceof UserLocalStateError) throw error;
    throw stateError("state_lock_acquire_failed", error);
  }
}

function readLockOwner(lockPath) {
  let stat;
  try { stat = fs.lstatSync(lockPath); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw stateError("state_lock_owner_unknown", error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new UserLocalStateError("state_path_unsafe", "The physical state lock path is not a regular file.");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new UserLocalStateError("state_permissions_unsafe", "The physical state lock has a different owner.");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new UserLocalStateError("state_permissions_unsafe", "The physical state lock is accessible outside the current user.");
  }

  let owner;
  try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch (error) {
    if (Date.now() - stat.mtimeMs < 1000) {
      throw new UserLocalStateError("state_lock_owner_initializing", "The physical state lock owner metadata is being published.");
    }
    throw stateError("state_lock_owner_unknown", error);
  }
  if (!owner || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.host !== "string" || owner.host === "" || typeof owner.token !== "string" || owner.token === "") {
    if (Date.now() - stat.mtimeMs < 1000) {
      throw new UserLocalStateError("state_lock_owner_initializing", "The physical state lock owner metadata is being published.");
    }
    throw new UserLocalStateError("state_lock_owner_unknown", "The physical state lock owner metadata is invalid.");
  }
  return owner;
}

function lockOwnerStatus(owner) {
  if (owner.host !== os.hostname()) return "unknown";
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code === "EPERM") return "alive";
    return "unknown";
  }
}

function recoverOrphanedLock(lockPath, observedOwner) {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryOwner = lockOwner(crypto.randomUUID());
  try {
    createOwnedLock(recoveryPath, recoveryOwner);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existingRecovery = readLockOwner(recoveryPath);
      if (existingRecovery && lockOwnerStatus(existingRecovery) !== "alive") {
        throw new UserLocalStateError(
          "state_lock_recovery_unknown",
          "A prior lock recovery was interrupted; the recovery lock cannot be removed safely.",
        );
      }
      return false;
    }
    throw error;
  }

  try {
    const currentOwner = readLockOwner(lockPath);
    if (currentOwner === null) return true;
    if (currentOwner.token !== observedOwner.token || lockOwnerStatus(currentOwner) !== "dead") return false;

    const stalePath = `${lockPath}.stale-${crypto.randomUUID()}`;
    try {
      fs.renameSync(lockPath, stalePath);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw stateError("state_lock_recovery_failed", error);
    }
    try {
      fsyncDirectory(path.dirname(lockPath));
      fs.unlinkSync(stalePath);
      fsyncDirectory(path.dirname(lockPath));
    } catch (error) {
      throw stateError("state_lock_recovery_failed", error);
    }
    return true;
  } finally {
    releaseOwnedLock(recoveryPath, recoveryOwner.token);
  }
}

function releaseOwnedLock(lockPath, token) {
  removeLockIfOwned(lockPath, token);
  try { fsyncDirectory(path.dirname(lockPath)); } catch (error) {
    throw stateError("state_lock_release_failed", error);
  }
}

function removeLockIfOwned(lockPath, token) {
  const current = readLockOwner(lockPath);
  if (current === null) return;
  if (current.token !== token) {
    throw new UserLocalStateError("state_lock_release_failed", "The physical state lock owner changed before release.");
  }
  try { fs.unlinkSync(lockPath); } catch (error) {
    if (error?.code !== "ENOENT") throw stateError("state_lock_release_failed", error);
  }
}

function lockOwner(token) {
  return {
    version: 1,
    pid: process.pid,
    host: os.hostname(),
    token,
    created_at: new Date().toISOString(),
  };
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("state file write made no progress");
    offset += written;
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function positiveNumber(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function stateError(code, cause) {
  const detail = cause instanceof Error ? cause.message : "";
  return new UserLocalStateError(code, detail ? `User-local state operation failed (${code}): ${detail}` : `User-local state operation failed (${code}).`, cause);
}
