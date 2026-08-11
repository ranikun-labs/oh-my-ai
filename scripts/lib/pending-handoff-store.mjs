import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalizePendingHandoffCandidate } from "./pending-handoff-candidate.mjs";
import {
  createPendingHandoffIntegrityDependencies,
  createPendingHandoffRevisionIntegrityEnvelope,
  PENDING_HANDOFF_REVISION_ENVELOPE_VERSION,
  verifyPendingHandoffIntegrityEnvelope,
  verifyPendingHandoffRevisionIntegrityEnvelope,
} from "./pending-handoff-integrity.mjs";

const RECORD_FILE_NAME = "record.json";
const CAS_LOCK_DIRECTORY_NAME = ".cas-lock";
const CAS_OWNER_FILE_PATTERN = /^owner-([A-Za-z0-9-]{36})\.json$/;
const CAS_OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAS_OWNER_METADATA_KEYS = Object.freeze(["owner_pid", "owner_token"]);
const INITIAL_REVISION = 0;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const CAS_EMPTY_LOCK_STALE_MS = 30_000;
const RECORD_KEY_PATTERN = /^k-[A-Za-z0-9_-]+$/;
const MAX_RECORD_KEY_LENGTH = 240;
const FILE_SYSTEM_METHODS = Object.freeze([
  "lstat",
  "mkdir",
  "writeFile",
  "rename",
  "unlink",
  "readFile",
]);
const DEFAULT_FILE_SYSTEM = Object.freeze({
  lstat,
  mkdir,
  readdir,
  writeFile,
  rename,
  rmdir,
  unlink,
  readFile,
});

export const PENDING_HANDOFF_STORE_FAILURES = Object.freeze([
  "store_root_invalid",
  "store_dependency_invalid",
  "integrity_dependency_invalid",
  "unsafe_store_path",
  "unsafe_record_path",
  "record_key_invalid",
  "record_invalid",
  "record_exists",
  "record_integrity_invalid",
  "record_integrity_key_invalid",
  "record_integrity_mismatch",
  "revision_invalid",
  "revision_conflict",
  "revision_exhausted",
  "cas_read_failed",
  "cas_publish_failed",
  "cas_arbitration_failed",
  "record_not_found",
  "record_malformed",
  "record_read_failed",
  "record_write_failed",
  "record_replace_failed",
]);

export function derivePendingHandoffRecordKey(candidateId) {
  try {
    if (
      typeof candidateId !== "string"
      || candidateId.trim().length === 0
      || !isWellFormedUnicode(candidateId)
    ) {
      return failure("record_key_invalid");
    }
    const key = `k-${Buffer.from(candidateId, "utf8").toString("base64url")}`;
    return RECORD_KEY_PATTERN.test(key) && key.length <= MAX_RECORD_KEY_LENGTH
      ? success(key)
      : failure("record_key_invalid");
  } catch {
    return failure("record_key_invalid");
  }
}

export function createPendingHandoffStore(options) {
  const inspected = inspectOptions(options);
  if (!inspected.ok) return failure(inspected.reason);

  const { rootDirectory, fileSystem, integrity } = inspected.value;
  const store = Object.freeze({
    compareAndSet: request => compareAndSet(rootDirectory, fileSystem, integrity, request),
    write: record => writeRecord(rootDirectory, fileSystem, integrity, record),
    read: candidateId => readRecord(rootDirectory, fileSystem, integrity, candidateId),
    readSnapshot: candidateId => readSnapshot(rootDirectory, fileSystem, integrity, candidateId),
  });
  return success(store);
}

async function writeRecord(rootDirectory, fileSystem, integrity, record) {
  let canonical;
  try {
    const validation = canonicalizePendingHandoffCandidate(record);
    if (!validation.ok) return failure("record_invalid");
    canonical = validation.value;
  } catch {
    return failure("record_invalid");
  }

  const keyResult = derivePendingHandoffRecordKey(canonical.candidate_id);
  if (!keyResult.ok) return failure("record_key_invalid");

  const envelopeResult = createPendingHandoffRevisionIntegrityEnvelope(
    canonical,
    INITIAL_REVISION,
    integrity,
  );
  if (!envelopeResult.ok) return failure(mapWriteIntegrityFailure(envelopeResult.reason));

  const recordDirectory = join(rootDirectory, keyResult.value);
  const recordPath = join(recordDirectory, RECORD_FILE_NAME);

  try {
    const rootStatus = await ensureDirectory(rootDirectory, fileSystem, "unsafe_store_path");
    if (rootStatus !== null) return failure(mapWriteStatus(rootStatus));

    const recordDirectoryStatus = await ensureDirectory(
      recordDirectory,
      fileSystem,
      "unsafe_record_path",
    );
    if (recordDirectoryStatus !== null) return failure(mapWriteStatus(recordDirectoryStatus));

    const lock = await acquireCasLock(recordDirectory, fileSystem);
    if (!lock.ok) return failure(mapInitialWriteLockFailure(lock.reason));
    try {
      const targetStatus = await inspectRecordTarget(recordPath, fileSystem);
      if (targetStatus === "unsafe_record_path") return failure("unsafe_record_path");
      if (targetStatus === "filesystem") return failure("record_write_failed");
      if (targetStatus !== "missing") return failure("record_exists");

      let serialized;
      try {
        serialized = `${JSON.stringify(envelopeResult.value)}\n`;
      } catch {
        return failure("record_write_failed");
      }

      const publication = await publishRecord(
        recordDirectory,
        recordPath,
        fileSystem,
        serialized,
        "record_write_failed",
        "record_replace_failed",
      );
      if (!publication.ok) return failure(publication.reason);
      return success(Object.freeze({ record_key: keyResult.value }));
    } finally {
      await releaseCasLock(lock.value, fileSystem);
    }
  } catch {
    return failure("record_write_failed");
  }
}

async function readRecord(rootDirectory, fileSystem, integrity, candidateId) {
  const loaded = await loadRecord(rootDirectory, fileSystem, candidateId);
  if (!loaded.ok) return loaded;

  const verified = verifyStoredEnvelope(loaded.value.parsed, integrity, false);
  if (!verified.ok) return verified;
  if (!isRecordIdentityBound(verified.value.candidate, candidateId, loaded.value.key)) {
    return failure("record_invalid");
  }
  return success(verified.value.candidate);
}

async function readSnapshot(rootDirectory, fileSystem, integrity, candidateId) {
  const loaded = await loadRecord(rootDirectory, fileSystem, candidateId);
  if (!loaded.ok) return loaded;

  const verified = verifyStoredEnvelope(loaded.value.parsed, integrity, true);
  if (!verified.ok) return verified;
  if (verified.value.legacy
    || !isRecordIdentityBound(verified.value.candidate, candidateId, loaded.value.key)) {
    return failure(verified.value.legacy ? "revision_invalid" : "record_invalid");
  }
  return success(Object.freeze({
    candidate: verified.value.candidate,
    state_revision: verified.value.state_revision,
  }));
}

async function compareAndSet(rootDirectory, fileSystem, integrity, request) {
  const inspected = inspectCompareAndSetRequest(request);
  if (!inspected.ok) return failure(inspected.reason);

  const { candidateId, expectedRevision, nextState } = inspected.value;
  const keyResult = derivePendingHandoffRecordKey(candidateId);
  if (!keyResult.ok) return failure("record_key_invalid");

  let canonical;
  try {
    const validation = canonicalizePendingHandoffCandidate(nextState);
    if (!validation.ok) return failure("record_invalid");
    canonical = validation.value;
  } catch {
    return failure("record_invalid");
  }
  if (canonical.candidate_id !== candidateId) return failure("record_invalid");

  const recordDirectory = join(rootDirectory, keyResult.value);
  const recordPath = join(recordDirectory, RECORD_FILE_NAME);
  const rootStatus = await inspectDirectory(rootDirectory, fileSystem, "unsafe_store_path");
  if (rootStatus !== null) return failure(mapCasReadStatus(rootStatus));
  const directoryStatus = await inspectDirectory(
    recordDirectory,
    fileSystem,
    "unsafe_record_path",
  );
  if (directoryStatus !== null) return failure(mapCasReadStatus(directoryStatus));

  const lock = await acquireCasLock(recordDirectory, fileSystem);
  if (!lock.ok) return failure(lock.reason);
  try {
    const loaded = await loadRecord(rootDirectory, fileSystem, candidateId);
    if (!loaded.ok) return failure(mapCasReadFailure(loaded.reason));

    const verified = verifyStoredEnvelope(loaded.value.parsed, integrity, true);
    if (!verified.ok) return failure(mapCasReadFailure(verified.reason));
    if (verified.value.legacy) return failure("revision_invalid");
    if (!isRecordIdentityBound(verified.value.candidate, candidateId, loaded.value.key)) {
      return failure("record_invalid");
    }
    if (verified.value.state_revision !== expectedRevision) {
      return failure("revision_conflict");
    }
    if (verified.value.state_revision === MAX_REVISION) {
      return failure("revision_exhausted");
    }

    const nextRevision = verified.value.state_revision + 1;
    const envelope = createPendingHandoffRevisionIntegrityEnvelope(
      canonical,
      nextRevision,
      integrity,
    );
    if (!envelope.ok) return failure(mapCasIntegrityFailure(envelope.reason));

    let serialized;
    try {
      serialized = `${JSON.stringify(envelope.value)}\n`;
    } catch {
      return failure("cas_publish_failed");
    }
    const publication = await publishRecord(
      recordDirectory,
      recordPath,
      fileSystem,
      serialized,
      "cas_publish_failed",
      "cas_publish_failed",
    );
    if (!publication.ok) return failure(publication.reason);
    return success(Object.freeze({ new_revision: nextRevision }));
  } catch {
    return failure("cas_read_failed");
  } finally {
    await releaseCasLock(lock.value, fileSystem);
  }
}

async function loadRecord(rootDirectory, fileSystem, candidateId) {
  const keyResult = derivePendingHandoffRecordKey(candidateId);
  if (!keyResult.ok) return failure("record_key_invalid");

  const recordDirectory = join(rootDirectory, keyResult.value);
  const recordPath = join(recordDirectory, RECORD_FILE_NAME);
  try {
    const rootStatus = await inspectDirectory(rootDirectory, fileSystem, "unsafe_store_path");
    if (rootStatus !== null) return failure(mapReadStatus(rootStatus));
    const recordDirectoryStatus = await inspectDirectory(
      recordDirectory,
      fileSystem,
      "unsafe_record_path",
    );
    if (recordDirectoryStatus !== null) return failure(mapReadStatus(recordDirectoryStatus));
    const targetStatus = await inspectRecordTarget(recordPath, fileSystem);
    if (targetStatus !== null) return failure(mapReadStatus(targetStatus));

    let serialized;
    try {
      serialized = await fileSystem.readFile(recordPath, "utf8");
    } catch (error) {
      return failure(isNotFound(error) ? "record_not_found" : "record_read_failed");
    }
    if (typeof serialized !== "string") return failure("record_read_failed");
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return failure("record_malformed");
    }
    return success(Object.freeze({ key: keyResult.value, parsed }));
  } catch {
    return failure("record_read_failed");
  }
}

function verifyStoredEnvelope(envelope, integrity, snapshot) {
  if (envelope?.envelope_version === PENDING_HANDOFF_REVISION_ENVELOPE_VERSION) {
    const verified = verifyPendingHandoffRevisionIntegrityEnvelope(envelope, integrity);
    if (!verified.ok) return failure(mapIntegrityReadFailure(verified.reason, snapshot));
    return success(Object.freeze({
      candidate: verified.value.candidate,
      state_revision: verified.value.state_revision,
      legacy: false,
    }));
  }

  const verified = verifyPendingHandoffIntegrityEnvelope(envelope, integrity);
  if (!verified.ok) return failure(mapIntegrityReadFailure(verified.reason, snapshot));
  return success(Object.freeze({ candidate: verified.value, legacy: true }));
}

function isRecordIdentityBound(candidate, candidateId, storedKey) {
  if (candidate?.candidate_id !== candidateId) return false;
  const derived = derivePendingHandoffRecordKey(candidate.candidate_id);
  return derived.ok && derived.value === storedKey;
}

function inspectCompareAndSetRequest(request) {
  try {
    if (!isPlainObject(request)) return failure("record_invalid");
    const keys = Reflect.ownKeys(request);
    if (keys.length !== 3 || keys.some(key => (
      typeof key !== "string"
      || !["candidate_id", "expected_revision", "next_state"].includes(key)
    ))) return failure("record_invalid");
    for (const key of ["candidate_id", "expected_revision", "next_state"]) {
      const descriptor = Object.getOwnPropertyDescriptor(request, key);
      if (!isEnumerableDataDescriptor(descriptor)) return failure("record_invalid");
    }
    if (!validRevision(request.expected_revision)) return failure("revision_invalid");
    return success(Object.freeze({
      candidateId: request.candidate_id,
      expectedRevision: request.expected_revision,
      nextState: request.next_state,
    }));
  } catch {
    return failure("record_invalid");
  }
}

async function publishRecord(
  recordDirectory,
  recordPath,
  fileSystem,
  serialized,
  writeFailureReason,
  replaceFailureReason,
) {
  const temporaryPath = join(recordDirectory, `.record-${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    await fileSystem.writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    temporaryCreated = true;
    await fileSystem.rename(temporaryPath, recordPath);
    return success(null);
  } catch {
    return failure(temporaryCreated ? replaceFailureReason : writeFailureReason);
  } finally {
    await unlinkQuietly(fileSystem, temporaryPath);
  }
}

async function acquireCasLock(recordDirectory, fileSystem) {
  const lockDirectory = join(recordDirectory, CAS_LOCK_DIRECTORY_NAME);
  const ownerToken = randomUUID();
  const ownerPath = join(lockDirectory, `owner-${ownerToken}.json`);
  const ownerContents = `${JSON.stringify({
    owner_pid: process.pid,
    owner_token: ownerToken,
  })}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fileSystem.mkdir(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) return failure("cas_arbitration_failed");
      const lockState = await inspectCasLock(lockDirectory, fileSystem);
      if (lockState.kind === "missing") continue;
      if (lockState.kind === "stale-owner" || lockState.kind === "stale-empty") {
        const recovered = await recoverCasLock(lockState, fileSystem);
        if (!recovered.ok) return recovered;
        continue;
      }
      return failure("cas_arbitration_failed");
    }

    try {
      await fileSystem.writeFile(ownerPath, ownerContents, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return success(Object.freeze({
        directory: lockDirectory,
        path: ownerPath,
      }));
    } catch (error) {
      await removeUnconfirmedOwner(fileSystem, lockDirectory, ownerPath, ownerContents);
      if (isNotFound(error)) continue;
      return failure("cas_arbitration_failed");
    }
  }
  return failure("cas_arbitration_failed");
}

async function inspectCasLock(lockDirectory, fileSystem) {
  let stat;
  try {
    stat = await fileSystem.lstat(lockDirectory);
  } catch (error) {
    return { kind: isNotFound(error) ? "missing" : "unsafe" };
  }
  if (isSymbolicLinkStat(stat) || !isDirectoryStat(stat)) return { kind: "unsafe" };

  let entries;
  try {
    entries = await fileSystem.readdir(lockDirectory);
  } catch {
    return { kind: "ambiguous" };
  }
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string")) {
    return { kind: "ambiguous" };
  }
  if (entries.length === 0) {
    const modifiedAt = Number(stat?.mtimeMs);
    if (!Number.isFinite(modifiedAt) || Date.now() - modifiedAt <= CAS_EMPTY_LOCK_STALE_MS) {
      return { kind: "active" };
    }
    return { kind: "stale-empty", directory: lockDirectory };
  }
  if (entries.length !== 1) return { kind: "ambiguous" };

  const match = entries[0].match(CAS_OWNER_FILE_PATTERN);
  if (match === null) return { kind: "ambiguous" };
  const ownerPath = join(lockDirectory, entries[0]);
  let ownerStat;
  try {
    ownerStat = await fileSystem.lstat(ownerPath);
  } catch {
    return { kind: "ambiguous" };
  }
  if (isSymbolicLinkStat(ownerStat) || !isFileStat(ownerStat)) {
    return { kind: "unsafe" };
  }

  let serialized;
  try {
    serialized = await fileSystem.readFile(ownerPath, "utf8");
  } catch {
    return { kind: "ambiguous" };
  }
  const metadata = parseOwnerMetadata(serialized, match[1]);
  if (metadata === null) return { kind: "ambiguous" };

  const liveness = inspectOwnerLiveness(metadata.owner_pid);
  if (liveness === "stale") {
    return { kind: "stale-owner", directory: lockDirectory, ownerPath };
  }
  return { kind: liveness };
}

async function releaseCasLock(lock, fileSystem) {
  let removed = false;
  try {
    await fileSystem.unlink(lock.path);
    removed = true;
  } catch {
    return;
  }
  if (!removed) return;
  try {
    await fileSystem.rmdir(lock.directory);
  } catch {
    // A different generation may now occupy the lock directory.
  }
}

async function recoverCasLock(lockState, fileSystem) {
  if (lockState.kind === "stale-empty") {
    try {
      await fileSystem.rmdir(lockState.directory);
    } catch (error) {
      if (!isNotFound(error) && !isDirectoryNotEmpty(error)) {
        return failure("cas_arbitration_failed");
      }
    }
    return success(null);
  }

  try {
    await fileSystem.unlink(lockState.ownerPath);
  } catch (error) {
    if (!isNotFound(error)) return failure("cas_arbitration_failed");
    return success(null);
  }
  try {
    await fileSystem.rmdir(lockState.directory);
  } catch (error) {
    if (!isNotFound(error) && !isDirectoryNotEmpty(error)) {
      return failure("cas_arbitration_failed");
    }
  }
  return success(null);
}

async function removeUnconfirmedOwner(fileSystem, lockDirectory, ownerPath, ownerContents) {
  let ownerRemoved = false;
  try {
    const serialized = await fileSystem.readFile(ownerPath, "utf8");
    if (serialized !== ownerContents) return;
    await fileSystem.unlink(ownerPath);
    ownerRemoved = true;
  } catch (error) {
    if (!isNotFound(error)) return;
  }
  if (!ownerRemoved && !await isMissing(fileSystem, ownerPath)) return;
  try {
    await fileSystem.rmdir(lockDirectory);
  } catch {
    // An empty directory cleanup failure remains fail-closed and recoverable.
  }
}

function parseOwnerMetadata(serialized, expectedToken) {
  try {
    if (typeof serialized !== "string") return null;
    const parsed = JSON.parse(serialized);
    if (!isPlainObject(parsed)) return null;
    const keys = Reflect.ownKeys(parsed);
    if (keys.length !== CAS_OWNER_METADATA_KEYS.length
      || keys.some(key => !CAS_OWNER_METADATA_KEYS.includes(key))) return null;
    for (const key of CAS_OWNER_METADATA_KEYS) {
      if (!isEnumerableDataDescriptor(Object.getOwnPropertyDescriptor(parsed, key))) return null;
    }
    if (typeof parsed.owner_token !== "string"
      || !CAS_OWNER_TOKEN_PATTERN.test(parsed.owner_token)
      || parsed.owner_token !== expectedToken
      || !Number.isSafeInteger(parsed.owner_pid)
      || parsed.owner_pid <= 0) return null;
    return Object.freeze({ owner_pid: parsed.owner_pid });
  } catch {
    return null;
  }
}

function inspectOwnerLiveness(ownerPid) {
  if (ownerPid === process.pid) return "active";
  try {
    process.kill(ownerPid, 0);
    return "active";
  } catch (error) {
    return error?.code === "ESRCH" ? "stale" : "ambiguous";
  }
}

async function isMissing(fileSystem, location) {
  try {
    await fileSystem.lstat(location);
    return false;
  } catch (error) {
    return isNotFound(error);
  }
}

async function unlinkQuietly(fileSystem, location) {
  try {
    await fileSystem.unlink(location);
  } catch {
    // Temporary and arbitration artifacts never cross the public boundary.
  }
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_REVISION;
}

function isWellFormedUnicode(value) {
  const nativeCheck = String.prototype.isWellFormed;
  if (typeof nativeCheck === "function") return nativeCheck.call(value);

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF)) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function inspectOptions(options) {
  try {
    if (!isPlainObject(options)) return failure("store_root_invalid");
    const keys = Reflect.ownKeys(options);
    if (keys.some(key => typeof key !== "string" || !["rootDirectory", "integrityProvider", "fileSystem"].includes(key))) {
      return failure("store_root_invalid");
    }

    const rootDescriptor = Object.getOwnPropertyDescriptor(options, "rootDirectory");
    if (!isEnumerableDataDescriptor(rootDescriptor)) return failure("store_root_invalid");
    if (
      typeof rootDescriptor.value !== "string"
      || rootDescriptor.value.trim().length === 0
      || rootDescriptor.value.includes("\0")
    ) {
      return failure("store_root_invalid");
    }

    const rootDirectory = resolve(rootDescriptor.value);
    const integrityDescriptor = Object.getOwnPropertyDescriptor(options, "integrityProvider");
    if (!isEnumerableDataDescriptor(integrityDescriptor)) return failure("integrity_dependency_invalid");
    const integrityResult = createPendingHandoffIntegrityDependencies(integrityDescriptor.value);
    if (!integrityResult.ok) return failure("integrity_dependency_invalid");

    let fileSystem = DEFAULT_FILE_SYSTEM;
    if (Object.hasOwn(options, "fileSystem")) {
      const fileSystemDescriptor = Object.getOwnPropertyDescriptor(options, "fileSystem");
      if (!isEnumerableDataDescriptor(fileSystemDescriptor)) return failure("store_dependency_invalid");
      if (fileSystemDescriptor.value !== undefined) fileSystem = fileSystemDescriptor.value;
    }
    const inspectedFileSystem = inspectFileSystem(fileSystem);
    if (!inspectedFileSystem.ok) return inspectedFileSystem;
    return success(Object.freeze({
      rootDirectory,
      fileSystem: inspectedFileSystem.value,
      integrity: integrityResult.value,
    }));
  } catch {
    return failure("store_root_invalid");
  }
}

function inspectFileSystem(fileSystem) {
  try {
    if (fileSystem === null || typeof fileSystem !== "object") {
      return failure("store_dependency_invalid");
    }
    const inspected = {};
    for (const method of FILE_SYSTEM_METHODS) {
      if (typeof fileSystem[method] !== "function") return failure("store_dependency_invalid");
      inspected[method] = fileSystem[method];
    }
    for (const method of ["readdir", "rmdir"]) {
      inspected[method] = typeof fileSystem[method] === "function"
        ? fileSystem[method]
        : DEFAULT_FILE_SYSTEM[method];
    }
    return success(Object.freeze(inspected));
  } catch {
    return failure("store_dependency_invalid");
  }
}

async function ensureDirectory(location, fileSystem, unsafeReason) {
  let stat;
  try {
    stat = await fileSystem.lstat(location);
  } catch (error) {
    if (!isNotFound(error)) return "filesystem";
    try {
      await fileSystem.mkdir(location, { mode: 0o700, recursive: true });
    } catch (mkdirError) {
      if (!isAlreadyExists(mkdirError)) return "filesystem";
    }
    try {
      stat = await fileSystem.lstat(location);
    } catch {
      return "filesystem";
    }
  }
  if (!isDirectoryStat(stat) || isSymbolicLinkStat(stat)) return unsafeReason;
  return null;
}

async function inspectDirectory(location, fileSystem, unsafeReason) {
  let stat;
  try {
    stat = await fileSystem.lstat(location);
  } catch (error) {
    return isNotFound(error) ? "missing" : "filesystem";
  }
  if (!isDirectoryStat(stat) || isSymbolicLinkStat(stat)) return unsafeReason;
  return null;
}

async function inspectRecordTarget(recordPath, fileSystem) {
  let stat;
  try {
    stat = await fileSystem.lstat(recordPath);
  } catch (error) {
    return isNotFound(error) ? "missing" : "filesystem";
  }
  if (isSymbolicLinkStat(stat) || !isFileStat(stat)) return "unsafe_record_path";
  return null;
}

function mapWriteStatus(status) {
  if (status === "unsafe_store_path" || status === "unsafe_record_path") return status;
  return "record_write_failed";
}

function mapReadStatus(status) {
  if (status === "missing") return "record_not_found";
  if (status === "unsafe_store_path" || status === "unsafe_record_path") return status;
  return "record_read_failed";
}

function mapWriteIntegrityFailure(reason) {
  return reason === "integrity_revision_invalid"
    ? "record_integrity_invalid"
    : "record_integrity_invalid";
}

function mapCasIntegrityFailure(reason) {
  return reason === "integrity_revision_invalid"
    ? "revision_invalid"
    : "cas_publish_failed";
}

function mapInitialWriteLockFailure(reason) {
  return reason === "cas_arbitration_failed" ? "record_write_failed" : reason;
}

function mapIntegrityReadFailure(reason, snapshot = false) {
  if (reason === "integrity_revision_invalid") return snapshot ? "revision_invalid" : "record_integrity_invalid";
  if (reason === "integrity_key_not_found") return "record_integrity_key_invalid";
  if (reason === "integrity_mismatch") return "record_integrity_mismatch";
  return "record_integrity_invalid";
}

function mapCasReadStatus(status) {
  if (status === "missing") return "record_not_found";
  if (status === "unsafe_store_path" || status === "unsafe_record_path") return status;
  return "cas_read_failed";
}

function mapCasReadFailure(reason) {
  if ([
    "record_not_found",
    "record_malformed",
    "record_integrity_invalid",
    "record_integrity_key_invalid",
    "record_integrity_mismatch",
    "revision_invalid",
    "record_invalid",
    "unsafe_store_path",
    "unsafe_record_path",
  ].includes(reason)) return reason;
  return "cas_read_failed";
}

function isDirectoryStat(stat) {
  try {
    return stat !== null && typeof stat?.isDirectory === "function" && stat.isDirectory();
  } catch {
    return false;
  }
}

function isFileStat(stat) {
  try {
    return stat !== null && typeof stat?.isFile === "function" && stat.isFile();
  } catch {
    return false;
  }
}

function isSymbolicLinkStat(stat) {
  try {
    return stat !== null && typeof stat?.isSymbolicLink === "function" && stat.isSymbolicLink();
  } catch {
    return true;
  }
}

function isNotFound(error) {
  try {
    return error !== null && typeof error === "object" && error.code === "ENOENT";
  } catch {
    return false;
  }
}

function isAlreadyExists(error) {
  try {
    return error !== null && typeof error === "object" && error.code === "EEXIST";
  } catch {
    return false;
  }
}

function isDirectoryNotEmpty(error) {
  try {
    return error !== null
      && typeof error === "object"
      && (error.code === "ENOTEMPTY" || error.code === "EEXIST");
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  try {
    return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && descriptor !== null
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, "value")
    && !Object.hasOwn(descriptor, "get")
    && !Object.hasOwn(descriptor, "set");
}

function success(value) {
  return Object.freeze({ ok: true, value });
}

function failure(reason) {
  return Object.freeze({ ok: false, reason });
}
