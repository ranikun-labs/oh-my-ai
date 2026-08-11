import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalizePendingHandoffCandidate } from "./pending-handoff-candidate.mjs";
import {
  createPendingHandoffIntegrityDependencies,
  createPendingHandoffIntegrityEnvelope,
  verifyPendingHandoffIntegrityEnvelope,
} from "./pending-handoff-integrity.mjs";

const RECORD_FILE_NAME = "record.json";
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
  writeFile,
  rename,
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
  "record_integrity_invalid",
  "record_integrity_key_invalid",
  "record_integrity_mismatch",
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
    write: record => writeRecord(rootDirectory, fileSystem, integrity, record),
    read: candidateId => readRecord(rootDirectory, fileSystem, integrity, candidateId),
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

  const envelopeResult = createPendingHandoffIntegrityEnvelope(canonical, integrity);
  if (!envelopeResult.ok) return failure("record_integrity_invalid");

  const recordDirectory = join(rootDirectory, keyResult.value);
  const recordPath = join(recordDirectory, RECORD_FILE_NAME);
  let temporaryPath = null;

  try {
    const rootStatus = await ensureDirectory(rootDirectory, fileSystem, "unsafe_store_path");
    if (rootStatus !== null) return failure(mapWriteStatus(rootStatus));

    const recordDirectoryStatus = await ensureDirectory(
      recordDirectory,
      fileSystem,
      "unsafe_record_path",
    );
    if (recordDirectoryStatus !== null) return failure(mapWriteStatus(recordDirectoryStatus));

    const targetStatus = await inspectRecordTarget(recordPath, fileSystem);
    if (targetStatus === "unsafe_record_path") return failure("unsafe_record_path");
    if (targetStatus === "filesystem") return failure("record_write_failed");

    let serialized;
    try {
      serialized = `${JSON.stringify(envelopeResult.value)}\n`;
    } catch {
      return failure("record_write_failed");
    }

    temporaryPath = join(recordDirectory, `.record-${randomUUID()}.tmp`);
    await fileSystem.writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    try {
      await fileSystem.rename(temporaryPath, recordPath);
      temporaryPath = null;
      return success(Object.freeze({ record_key: keyResult.value }));
    } catch {
      return failure("record_replace_failed");
    }
  } catch {
    return failure("record_write_failed");
  } finally {
    if (temporaryPath !== null) {
      try {
        await fileSystem.unlink(temporaryPath);
      } catch {
        // Cleanup is best effort; no filesystem detail crosses the boundary.
      }
    }
  }
}

async function readRecord(rootDirectory, fileSystem, integrity, candidateId) {
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

    const verified = verifyPendingHandoffIntegrityEnvelope(parsed, integrity);
    if (!verified.ok) return failure(mapIntegrityReadFailure(verified.reason));
    const canonical = verified.value;

    if (canonical.candidate_id !== candidateId) {
      return failure("record_invalid");
    }

    const storedKey = derivePendingHandoffRecordKey(canonical.candidate_id);
    if (!storedKey.ok || storedKey.value !== keyResult.value) {
      return failure("record_invalid");
    }
    return success(canonical);
  } catch {
    return failure("record_read_failed");
  }
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

function mapIntegrityReadFailure(reason) {
  if (reason === "integrity_key_not_found") return "record_integrity_key_invalid";
  if (reason === "integrity_mismatch") return "record_integrity_mismatch";
  return "record_integrity_invalid";
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
