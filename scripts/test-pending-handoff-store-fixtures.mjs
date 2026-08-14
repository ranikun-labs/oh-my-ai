import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PENDING_HANDOFF_SCHEMA_VERSION } from "./lib/pending-handoff-core.mjs";
import {
  PENDING_HANDOFF_INTEGRITY_PROVIDER_VERSION,
  PENDING_HANDOFF_INTEGRITY_PURPOSE,
} from "./lib/pending-handoff-integrity.mjs";

let storeModule = null;
try {
  storeModule = await import("./lib/pending-handoff-store.mjs");
} catch {
  // The API contract assertion below reports the missing boundary without exposing an import path.
}

let claimLeaseModule = null;
let deliveryConsumptionModule = null;
try {
  claimLeaseModule = await import("./lib/pending-handoff-claim-lease.mjs");
  deliveryConsumptionModule = await import("./lib/pending-handoff-delivery-consumption.mjs");
} catch {
  // The exact module export assertion reports a missing related boundary without exposing a path.
}

const createPendingHandoffStore = storeModule?.createPendingHandoffStore;
const createPendingHandoffRuntime = storeModule?.createPendingHandoffRuntime;
const derivePendingHandoffRecordKey = storeModule?.derivePendingHandoffRecordKey;
const PENDING_HANDOFF_STORE_FAILURES = storeModule?.PENDING_HANDOFF_STORE_FAILURES;
let STORE_SOURCE = "";
try {
  STORE_SOURCE = readFileSync(
    fileURLToPath(new URL("./lib/pending-handoff-store.mjs", import.meta.url)),
    "utf8",
  );
} catch {
  // The API contract assertion reports the missing production boundary.
}

const STORE_MODULE_EXPORT_KEYS = Object.freeze([
  "PENDING_HANDOFF_RUNTIME_FAILURES",
  "PENDING_HANDOFF_STORE_FAILURES",
  "createPendingHandoffRuntime",
  "createPendingHandoffStore",
  "derivePendingHandoffRecordKey",
  Symbol.toStringTag,
]);
const CLAIM_LEASE_MODULE_EXPORT_KEYS = Object.freeze([
  "PENDING_HANDOFF_CLAIM_LEASE_FAILURES",
  "createPendingHandoffClaimLeaseService",
  Symbol.toStringTag,
]);
const DELIVERY_CONSUMPTION_MODULE_EXPORT_KEYS = Object.freeze([
  "PENDING_HANDOFF_DELIVERY_CONSUMPTION_FAILURES",
  "PENDING_HANDOFF_DELIVERY_DIGEST_PURPOSE",
  "createPendingHandoffDeliveryConsumptionService",
  Symbol.toStringTag,
]);
const RUNTIME_PUBLIC_KEYS = Object.freeze([
  "store",
  "claimLease",
  "deliveryConsumption",
]);
const STORE_PUBLIC_KEYS = Object.freeze([
  "compareAndSet",
  "write",
  "read",
  "readSnapshot",
  "readState",
]);
const CLAIM_LEASE_PUBLIC_KEYS = Object.freeze([
  "acquireClaim",
  "registerPending",
  "recoverClaimLease",
  "releaseClaimBeforeDelivery",
]);
const DELIVERY_CONSUMPTION_PUBLIC_KEYS = Object.freeze([
  "beginDeliveryAttempt",
  "confirmDelivery",
  "releaseUnconfirmedDelivery",
  "consumeDelivered",
]);

const SESSION_IDENTITY = `phr1.session.key_A-1.${"A".repeat(43)}`;
const REPOSITORY_IDENTITY = `phr1.repository.key_A-1.${"B".repeat(43)}`;
const WORKTREE_IDENTITY = `phr1.worktree.key_A-1.${"C".repeat(43)}`;
const PRIVATE_MARKER = "private-store-marker";
const EXCEPTION_MARKER = "filesystem-exception-marker";
const CURRENT_INTEGRITY_KEY_ID = "integrity_current";
const PREVIOUS_INTEGRITY_KEY_ID = "integrity_previous";
const INTEGRITY_KEY_MATERIAL = Object.freeze({
  [CURRENT_INTEGRITY_KEY_ID]: "store-current-integrity-secret",
  [PREVIOUS_INTEGRITY_KEY_ID]: "store-previous-integrity-secret",
});
const ARRAY_FIELDS = Object.freeze(["completed", "open_issues", "verification", "do_not_touch"]);

const REAL_FILE_SYSTEM = Object.freeze({
  lstat: fileSystem.lstat,
  mkdir: fileSystem.mkdir,
  writeFile: fileSystem.writeFile,
  rename: fileSystem.rename,
  unlink: fileSystem.unlink,
  readFile: fileSystem.readFile,
});

let groups = 0;
let tests = 0;

function candidate(overrides = {}) {
  return {
    candidate_id: "candidate-opaque-001",
    schema_version: PENDING_HANDOFF_SCHEMA_VERSION,
    status: "candidate",
    created_at: "2026-07-30T01:00:00.000Z",
    expires_at: "2026-07-30T02:00:00.000Z",
    source_runtime: "codex",
    source_session_identity: SESSION_IDENTITY,
    repository_identity: REPOSITORY_IDENTITY,
    worktree_identity: WORKTREE_IDENTITY,
    goal: "Persist a runtime-neutral pending handoff candidate.",
    completed: ["The candidate was canonicalized."],
    open_issues: [],
    verification: ["The store fixture is isolated in a temporary directory."],
    do_not_touch: ["Runtime adapters and delivery state."],
    next_action: "Read the candidate from the pending store.",
    context_checkpoint_status: "review_needed",
    privacy_redaction_status: "passed",
    ...overrides,
  };
}

async function group(name, operation) {
  await operation();
  groups += 1;
  process.stdout.write(`PASS GROUP ${groups} ${name}\n`);
}

async function test(name, operation) {
  await operation();
  tests += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function assertFrozenFailure(result, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.equal(Object.hasOwn(result, "metadata"), false);
  assert.equal(JSON.stringify(result).includes(PRIVATE_MARKER), false);
  assert.equal(JSON.stringify(result).includes(EXCEPTION_MARKER), false);
}

function assertFrozenSuccess(result) {
  assert.equal(result.ok, true);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "value"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  return result.value;
}

function assertExactOwnKeys(value, expectedKeys, label) {
  const actualKeys = Reflect.ownKeys(value);
  assert.equal(actualKeys.length, expectedKeys.length, `${label} own-key count changed`);
  for (const expectedKey of expectedKeys) {
    assert.equal(
      actualKeys.includes(expectedKey),
      true,
      `${label} is missing ${String(expectedKey)}`,
    );
  }
  for (const actualKey of actualKeys) {
    assert.equal(
      expectedKeys.includes(actualKey),
      true,
      `${label} exposes unexpected ${String(actualKey)}`,
    );
  }
}

function assertServiceSurface(service, expectedKeys, label) {
  assert.equal(Object.isFrozen(service), true);
  assertExactOwnKeys(service, expectedKeys, label);
  for (const key of expectedKeys) {
    assert.equal(typeof service[key], "function", `${label}.${String(key)} must be callable`);
  }
  return service;
}

function assertFactorySuccess(result) {
  const store = assertFrozenSuccess(result);
  assertServiceSurface(store, STORE_PUBLIC_KEYS, "Store");
  return store;
}

function assertRuntimeSuccess(result) {
  const runtime = assertFrozenSuccess(result);
  assertExactOwnKeys(runtime, RUNTIME_PUBLIC_KEYS, "Pending Handoff runtime");
  assertServiceSurface(runtime.store, STORE_PUBLIC_KEYS, "Runtime Store");
  assertServiceSurface(runtime.claimLease, CLAIM_LEASE_PUBLIC_KEYS, "Claim/Lease service");
  assertServiceSurface(
    runtime.deliveryConsumption,
    DELIVERY_CONSUMPTION_PUBLIC_KEYS,
    "Delivery/Consumption service",
  );
  return runtime;
}

function assertNoLeak(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(PRIVATE_MARKER), false);
  assert.equal(serialized.includes(EXCEPTION_MARKER), false);
  assert.equal(serialized.includes("record.json"), false);
}

function integrityProvider(overrides = {}) {
  const keyedDigest = overrides.keyed_digest ?? Object.freeze(({ key_id, purpose, bytes }) => {
    const secret = INTEGRITY_KEY_MATERIAL[key_id];
    if (secret === undefined || purpose !== PENDING_HANDOFF_INTEGRITY_PURPOSE) {
      throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
    }
    return createHmac("sha256", secret).update(Buffer.from(bytes)).digest("base64url");
  });
  const safeEqual = overrides.safe_equal ?? Object.freeze((left, right) => left === right);
  return Object.freeze({
    version: overrides.version ?? PENDING_HANDOFF_INTEGRITY_PROVIDER_VERSION,
    current_key_id: overrides.current_key_id ?? CURRENT_INTEGRITY_KEY_ID,
    verification_key_ids: overrides.verification_key_ids
      ?? Object.freeze([CURRENT_INTEGRITY_KEY_ID, PREVIOUS_INTEGRITY_KEY_ID]),
    keyed_digest: keyedDigest,
    safe_equal: safeEqual,
  });
}

function storeOptions(rootDirectory, options = {}) {
  return {
    rootDirectory,
    integrityProvider: integrityProvider(),
    ...options,
  };
}

function assertNoRawIdentity(value, identity) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(identity), false);
  for (const codeUnit of identity) {
    if (codeUnit >= "\uD800" && codeUnit <= "\uDFFF") {
      const escaped = `\\u${codeUnit.charCodeAt(0).toString(16).padStart(4, "0")}`;
      assert.equal(serialized.includes(escaped), false);
    }
  }
}

function keyFor(candidateId) {
  assert.equal(typeof derivePendingHandoffRecordKey, "function");
  const result = derivePendingHandoffRecordKey(candidateId);
  const key = assertFrozenSuccess(result);
  assert.match(key, /^k-[A-Za-z0-9_-]+$/);
  return key;
}

function customFileSystem(overrides = {}) {
  return { ...REAL_FILE_SYSTEM, ...overrides };
}

async function withStore(operation, options = {}) {
  const rootDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-store-fixture-"));
  try {
    assert.equal(typeof createPendingHandoffStore, "function");
    const result = createPendingHandoffStore(storeOptions(rootDirectory, options));
    const store = assertFactorySuccess(result);
    return await operation({ rootDirectory, store });
  } finally {
    await fileSystem.rm(rootDirectory, { recursive: true, force: true });
  }
}

function runtimeOptions(rootDirectory) {
  return {
    ...storeOptions(rootDirectory),
    leaseDurationMs: 1_000,
    clock: () => 0,
    deliveryCandidateDigest: Object.freeze(() => "A".repeat(43)),
    deliveryEvidenceVerifier: Object.freeze(() => ({})),
  };
}

async function withRuntime(operation) {
  const rootDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-runtime-surface-fixture-"));
  try {
    const runtime = assertRuntimeSuccess(createPendingHandoffRuntime(runtimeOptions(rootDirectory)));
    return await operation({ rootDirectory, runtime });
  } finally {
    await fileSystem.rm(rootDirectory, { recursive: true, force: true });
  }
}

async function captureOutput(operation) {
  const writes = [];
  const original = {
    stdout: process.stdout.write,
    stderr: process.stderr.write,
    log: console.log,
    error: console.error,
  };
  process.stdout.write = () => { writes.push("stdout"); return true; };
  process.stderr.write = () => { writes.push("stderr"); return true; };
  console.log = () => writes.push("console.log");
  console.error = () => writes.push("console.error");
  try {
    return { result: await operation(), writes };
  } finally {
    process.stdout.write = original.stdout;
    process.stderr.write = original.stderr;
    console.log = original.log;
    console.error = original.error;
  }
}

await group("API contract", async () => {
  await test("exports the runtime-neutral factory, key derivation, and frozen taxonomy", () => {
    assert.equal(typeof createPendingHandoffStore, "function");
    assert.equal(typeof createPendingHandoffRuntime, "function");
    assert.equal(typeof derivePendingHandoffRecordKey, "function");
    assert.deepEqual(PENDING_HANDOFF_STORE_FAILURES, [
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
    assert.equal(Object.isFrozen(PENDING_HANDOFF_STORE_FAILURES), true);
    assert.throws(() => PENDING_HANDOFF_STORE_FAILURES.push("unexpected"));
  });

  await test("requires an explicit store root and exposes read/write plus revision methods", async () => {
    assertFrozenFailure(createPendingHandoffStore({}), "store_root_invalid");
    await withStore(async ({ store }) => {
      assert.equal(Object.isFrozen(store), true);
      assertExactOwnKeys(store, STORE_PUBLIC_KEYS, "Store");
      assertFrozenFailure(
        createPendingHandoffStore(storeOptions("/tmp/ignored", { fileSystem: {} })),
        "store_dependency_invalid",
      );
    });
  });

  await test("derives a deterministic fixed path-safe key without using candidate_id as a path", () => {
    assertFrozenFailure(derivePendingHandoffRecordKey(null), "record_key_invalid");
    assertFrozenFailure(derivePendingHandoffRecordKey("   "), "record_key_invalid");
    assertFrozenFailure(derivePendingHandoffRecordKey("x".repeat(200)), "record_key_invalid");
    const first = keyFor("../traversal-like/private");
    const second = keyFor("../traversal-like/private");
    assert.equal(first, second);
    assert.notEqual(first, "../traversal-like/private");
    assert.equal(first.includes("/"), false);
    assert.equal(first.includes("\\"), false);
  });
});

await group("authority surface oracle", async () => {
  await test("pins exact module exports so generic accessors cannot become capabilities", () => {
    assertExactOwnKeys(storeModule, STORE_MODULE_EXPORT_KEYS, "pending-handoff-store module");
    assertExactOwnKeys(claimLeaseModule, CLAIM_LEASE_MODULE_EXPORT_KEYS, "pending-handoff-claim-lease module");
    assertExactOwnKeys(
      deliveryConsumptionModule,
      DELIVERY_CONSUMPTION_MODULE_EXPORT_KEYS,
      "pending-handoff-delivery-consumption module",
    );
  });

  await test("pins the frozen runtime, Store, and service own-key surfaces", async () => {
    await withRuntime(async ({ runtime }) => {
      assert.equal(Object.isFrozen(runtime), true);
      assert.equal(typeof runtime.store.compareAndSetState, "undefined");
      assert.equal(Object.hasOwn(runtime, "mutationPort"), false);
      assert.equal(Object.hasOwn(runtime.store, "mutationPort"), false);
    });
  });

  await test("rejects Symbol and non-enumerable capability regressions in the oracle", () => {
    const regression = {};
    Object.defineProperty(regression, "getPort", {
      value: () => undefined,
      enumerable: false,
    });
    Object.defineProperty(regression, Symbol("raw-mutation-port"), {
      value: () => undefined,
      enumerable: true,
    });
    assert.throws(() => assertExactOwnKeys(regression, RUNTIME_PUBLIC_KEYS, "runtime regression"));
  });
});

await group("identity-safe key and read binding regression", async () => {
  await test("rejects distinct lone surrogates without key collapse or raw identity leakage", () => {
    const firstId = "id-\uD800";
    const secondId = "id-\uD801";
    assert.notEqual(firstId, secondId);

    const first = derivePendingHandoffRecordKey(firstId);
    const second = derivePendingHandoffRecordKey(secondId);
    assertFrozenFailure(first, "record_key_invalid");
    assertFrozenFailure(second, "record_key_invalid");
    assert.deepEqual(first, second);
    assertNoLeak(first);
    assertNoLeak(second);
    assertNoRawIdentity(first, firstId);
    assertNoRawIdentity(second, secondId);
  });

  await test("rejects ill-formed IDs before sequential writes can overwrite a record", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const firstId = "id-\uD800";
      const secondId = "id-\uD801";
      const firstWrite = await store.write(candidate({ candidate_id: firstId }));
      const secondWrite = await store.write(candidate({ candidate_id: secondId }));
      const firstRead = await store.read(firstId);
      const secondRead = await store.read(secondId);

      for (const [result, identity] of [
        [firstWrite, firstId],
        [secondWrite, secondId],
        [firstRead, firstId],
        [secondRead, secondId],
      ]) {
        assertFrozenFailure(result, "record_key_invalid");
        assertNoLeak(result);
        assertNoRawIdentity(result, identity);
      }
      assert.deepEqual(await fileSystem.readdir(rootDirectory), []);
    });
  });

  await test("rejects a canonical record whose identity does not match the request", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const requestedId = "wrong-record-a";
      const storedId = "wrong-record-b";
      const recordDirectory = join(rootDirectory, keyFor(requestedId));
      await fileSystem.mkdir(recordDirectory);
      await fileSystem.writeFile(
        join(recordDirectory, "record.json"),
        JSON.stringify(candidate({ candidate_id: storedId })),
        "utf8",
      );

      const result = await store.read(requestedId);
      assertFrozenFailure(result, "record_integrity_invalid");
      assertNoLeak(result);
      assertNoRawIdentity(result, requestedId);
      assertNoRawIdentity(result, storedId);
    });
  });
});

await group("roundtrip and isolation", async () => {
  await test("writes and reads the canonical record under directory-per-handoff layout", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      const written = assertFrozenSuccess(await store.write(input));
      assert.deepEqual(Object.keys(written), ["record_key"]);
      const key = keyFor(input.candidate_id);
      assert.equal(written.record_key, key);
      assert.deepEqual(await fileSystem.readdir(rootDirectory), [key]);
      assert.deepEqual(await fileSystem.readdir(join(rootDirectory, key)), ["record.json"]);
      const stored = JSON.parse(await fileSystem.readFile(join(rootDirectory, key, "record.json"), "utf8"));
      assert.deepEqual(Object.keys(stored), ["envelope_version", "state_revision", "integrity", "candidate"]);
      assert.equal(stored.state_revision, 0);
      assert.deepEqual(stored.candidate, input);
      const read = assertFrozenSuccess(await store.read(input.candidate_id));
      assert.deepEqual(read, input);
      assert.equal(Object.isFrozen(read), true);
      for (const field of ARRAY_FIELDS) assert.equal(Object.isFrozen(read[field]), true);
    });
  });

  await test("isolates input and read snapshots from later mutation", async () => {
    await withStore(async ({ store }) => {
      const input = candidate({ completed: ["before"], open_issues: ["none"] });
      assertFrozenSuccess(await store.write(input));
      input.goal = PRIVATE_MARKER;
      input.completed.push(PRIVATE_MARKER);
      const read = assertFrozenSuccess(await store.read("candidate-opaque-001"));
      assert.equal(read.goal.includes(PRIVATE_MARKER), false);
      assert.deepEqual(read.completed, ["before"]);
      assert.deepEqual(read.open_issues, ["none"]);
      assert.throws(() => { read.goal = PRIVATE_MARKER; });
      assert.throws(() => { read.completed.push(PRIVATE_MARKER); });
    });
  });

  await test("keeps multiple records isolated by deterministic keys", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const first = candidate({ candidate_id: "record-one" });
      const second = candidate({ candidate_id: "record-two", goal: "A different handoff." });
      assertFrozenSuccess(await store.write(first));
      assertFrozenSuccess(await store.write(second));
      assert.deepEqual(assertFrozenSuccess(await store.read(first.candidate_id)), first);
      assert.deepEqual(assertFrozenSuccess(await store.read(second.candidate_id)), second);
      assert.deepEqual((await fileSystem.readdir(rootDirectory)).sort(), [keyFor("record-one"), keyFor("record-two")].sort());
    });
  });

  await test("returns record_not_found without probing an unsafe raw path", async () => {
    await withStore(async ({ store }) => {
      assertFrozenFailure(await store.read("missing-record"), "record_not_found");
    });
  });
});

await group("fail-closed record reads", async () => {
  await test("rejects malformed JSON without exposing parser details", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const recordDirectory = join(rootDirectory, keyFor("malformed-record"));
      await fileSystem.mkdir(recordDirectory);
      await fileSystem.writeFile(join(recordDirectory, "record.json"), "{ malformed", "utf8");
      const result = await store.read("malformed-record");
      assertFrozenFailure(result, "record_malformed");
      assertNoLeak(result);
    });
  });

  await test("rejects a syntactically valid but invalid Candidate", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const recordDirectory = join(rootDirectory, keyFor("invalid-record"));
      await fileSystem.mkdir(recordDirectory);
      await fileSystem.writeFile(
        join(recordDirectory, "record.json"),
        JSON.stringify(candidate({ candidate_id: "invalid-record", status: "pending" })),
        "utf8",
      );
      assertFrozenFailure(await store.read("invalid-record"), "record_integrity_invalid");
    });
  });

  await test("handles traversal-like candidate IDs as ordinary opaque keys", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const traversalLikeId = "../../outside/record.json";
      const input = candidate({ candidate_id: traversalLikeId });
      assertFrozenSuccess(await store.write(input));
      assert.deepEqual(assertFrozenSuccess(await store.read(traversalLikeId)), input);
      assert.deepEqual(await fileSystem.readdir(rootDirectory), [keyFor(traversalLikeId)]);
      assert.equal(await fileSystem.lstat(join(dirname(rootDirectory), "outside")).then(() => true, () => false), false);
    });
  });

  await test("rejects a symlinked record directory and record file", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const outsideDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-store-outside-"));
      try {
        const directoryKey = keyFor("symlinked-directory");
        await fileSystem.symlink(outsideDirectory, join(rootDirectory, directoryKey), "dir");
        assertFrozenFailure(await store.read("symlinked-directory"), "unsafe_record_path");
        assertFrozenFailure(await store.write(candidate({ candidate_id: "symlinked-directory" })), "unsafe_record_path");

        const fileKey = keyFor("symlinked-file");
        const recordDirectory = join(rootDirectory, fileKey);
        await fileSystem.mkdir(recordDirectory);
        const outsideRecord = join(outsideDirectory, "outside-record.json");
        await fileSystem.writeFile(outsideRecord, JSON.stringify(candidate({ candidate_id: "symlinked-file" })), "utf8");
        await fileSystem.symlink(outsideRecord, join(recordDirectory, "record.json"));
        assertFrozenFailure(await store.read("symlinked-file"), "unsafe_record_path");
        assertFrozenFailure(await store.write(candidate({ candidate_id: "symlinked-file" })), "unsafe_record_path");
      } finally {
        await fileSystem.rm(outsideDirectory, { recursive: true, force: true });
      }
    });
  });

  await test("rejects a symlinked store root", async () => {
    const realRoot = await fileSystem.mkdtemp(join(tmpdir(), "phr-store-real-root-"));
    const parent = await fileSystem.mkdtemp(join(tmpdir(), "phr-store-link-parent-"));
    const linkedRoot = join(parent, "linked-root");
    try {
      await fileSystem.symlink(realRoot, linkedRoot, "dir");
      const result = createPendingHandoffStore(storeOptions(linkedRoot));
      const store = assertFactorySuccess(result);
      assertFrozenFailure(await store.read("linked-root-record"), "unsafe_store_path");
      assertFrozenFailure(await store.write(candidate({ candidate_id: "linked-root-record" })), "unsafe_store_path");
    } finally {
      await fileSystem.rm(parent, { recursive: true, force: true });
      await fileSystem.rm(realRoot, { recursive: true, force: true });
    }
  });
});

await group("atomic replacement and cleanup", async () => {
  await test("preserves the previous valid record when replacement fails", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const original = candidate({ candidate_id: "replace-me", goal: "Original valid record." });
      const replacement = candidate({ candidate_id: "replace-me", goal: "Replacement must not become partial." });
      assertFrozenSuccess(await store.write(original));
      const failingFileSystem = customFileSystem({
        rename: async () => { throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`); },
      });
      const failingStore = assertFactorySuccess(createPendingHandoffStore(storeOptions(rootDirectory, { fileSystem: failingFileSystem })));
      const failed = await failingStore.compareAndSet({
        candidate_id: original.candidate_id,
        expected_revision: 0,
        next_state: replacement,
      });
      assertFrozenFailure(failed, "cas_publish_failed");
      assert.deepEqual(assertFrozenSuccess(await store.read(original.candidate_id)), original);
      assert.deepEqual(await fileSystem.readdir(join(rootDirectory, keyFor(original.candidate_id))), ["record.json"]);
      assertNoLeak(failed);
    });
  });

  await test("cleans a partially written same-directory temporary file", async () => {
    await withStore(async ({ rootDirectory }) => {
      const partiallyFailingFileSystem = customFileSystem({
        writeFile: async (...args) => {
          await REAL_FILE_SYSTEM.writeFile(...args);
          throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
        },
      });
      const store = assertFactorySuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: partiallyFailingFileSystem,
      })));
      const failed = await store.write(candidate({ candidate_id: "temp-cleanup" }));
      assertFrozenFailure(failed, "record_write_failed");
      assert.deepEqual(await fileSystem.readdir(join(rootDirectory, keyFor("temp-cleanup"))), []);
      assertNoLeak(failed);
    });
  });
});

await group("privacy and filesystem exception boundaries", async () => {
  await test("never emits raw record values or filesystem exception text", async () => {
    await withStore(async ({ store }) => {
      const captured = await captureOutput(() => store.write(candidate({ status: "pending", goal: PRIVATE_MARKER })));
      assertFrozenFailure(captured.result, "record_invalid");
      assert.deepEqual(captured.writes, []);
      assertNoLeak(captured.result);
    });
  });

  await test("maps filesystem exceptions to deterministic redacted failures", async () => {
    await withStore(async ({ rootDirectory }) => {
      const throwingFileSystem = customFileSystem({
        lstat: async () => { throw new Error(`/private/raw/path/${EXCEPTION_MARKER}`); },
      });
      const store = assertFactorySuccess(createPendingHandoffStore(storeOptions(rootDirectory, { fileSystem: throwingFileSystem })));
      const writeResult = await store.write(candidate({ candidate_id: PRIVATE_MARKER }));
      const readResult = await store.read(PRIVATE_MARKER);
      assertFrozenFailure(writeResult, "record_write_failed");
      assertFrozenFailure(readResult, "record_read_failed");
      assertNoLeak(writeResult);
      assertNoLeak(readResult);
    });
  });
});

await group("static boundary and Makefile wiring", async () => {
  await test("keeps the runtime composition private to the production module", () => {
    assert.doesNotMatch(STORE_SOURCE, /\b(?:console|fetch)\b/);
    assert.doesNotMatch(STORE_SOURCE, /^export\s+[^\n]*mutationPort/m);
    assert.doesNotMatch(STORE_SOURCE, /^export\s+[^\n]*getPort/m);
  });

  await test("store target is declared once before later Pending Handoff fixtures", () => {
    const makefile = readFileSync(fileURLToPath(new URL("../Makefile", import.meta.url)), "utf8");
    assert.equal((makefile.match(/^test-pending-handoff-store-fixtures:/gm) ?? []).length, 1);
    assert.match(makefile, /^test-pending-handoff-store-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-store-fixtures\.mjs$/m);
    assert.equal((makefile.match(/^\.PHONY:.*test-pending-handoff-store-fixtures/m) ?? []).length, 1);
    const lines = makefile.split("\n");
    const start = lines.findIndex(line => line.startsWith("test-v1x-fixtures:"));
    assert.notEqual(start, -1);
    const declaration = [lines[start]];
    while (declaration.at(-1).endsWith("\\")) declaration.push(lines[start + declaration.length]);
    const targets = declaration.join(" ").replace(/^test-v1x-fixtures:\s*/, "").replaceAll("\\", " ").trim().split(/\s+/);
    assert.ok(targets.indexOf("test-pending-handoff-store-fixtures") < targets.indexOf("test-pending-handoff-session-resolution-fixtures"));
    assert.equal(targets.at(-1), "test-pending-handoff-manual-resume-runtime-composition-fixtures");
    assert.ok(targets.indexOf("test-pending-handoff-manual-resume-fixtures") < targets.indexOf("test-pending-handoff-codex-runtime-adapter-fixtures"));
    assert.ok(targets.indexOf("test-pending-handoff-codex-runtime-adapter-fixtures") < targets.indexOf("test-pending-handoff-claude-runtime-adapter-fixtures"));
    assert.ok(targets.indexOf("test-pending-handoff-claude-runtime-adapter-fixtures") < targets.indexOf("test-pending-handoff-manual-resume-runtime-composition-fixtures"));
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS\n`);
