import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PENDING_HANDOFF_SCHEMA_VERSION } from "./lib/pending-handoff-core.mjs";

let storeModule = null;
let integrityModule = null;
try {
  storeModule = await import("./lib/pending-handoff-store.mjs");
  integrityModule = await import("./lib/pending-handoff-integrity.mjs");
} catch {
  // API assertions below report a missing boundary without exposing a path.
}

const {
  createPendingHandoffStore,
  derivePendingHandoffRecordKey,
  PENDING_HANDOFF_STORE_FAILURES,
} = storeModule ?? {};
const {
  createPendingHandoffIntegrityDependencies,
  createPendingHandoffIntegrityEnvelope,
  createPendingHandoffRevisionIntegrityEnvelope,
  PENDING_HANDOFF_INTEGRITY_PROVIDER_VERSION,
  PENDING_HANDOFF_INTEGRITY_PURPOSE,
  PENDING_HANDOFF_REVISION_INTEGRITY_FAILURES,
  PENDING_HANDOFF_REVISION_ENVELOPE_VERSION,
  verifyPendingHandoffRevisionIntegrityEnvelope,
} = integrityModule ?? {};

const SOURCE = readFileSync(
  fileURLToPath(new URL("./lib/pending-handoff-store.mjs", import.meta.url)),
  "utf8",
);
const INTEGRITY_SOURCE = readFileSync(
  fileURLToPath(new URL("./lib/pending-handoff-integrity.mjs", import.meta.url)),
  "utf8",
);
const MAKEFILE_SOURCE = readFileSync(
  fileURLToPath(new URL("../Makefile", import.meta.url)),
  "utf8",
);

const SESSION_IDENTITY = `phr1.session.key_A-1.${"A".repeat(43)}`;
const REPOSITORY_IDENTITY = `phr1.repository.key_A-1.${"B".repeat(43)}`;
const WORKTREE_IDENTITY = `phr1.worktree.key_A-1.${"C".repeat(43)}`;
const CURRENT_KEY_ID = "integrity_current";
const PREVIOUS_KEY_ID = "integrity_previous";
const PRIVATE_MARKER = "revision-private-marker";
const EXCEPTION_MARKER = "revision-exception-marker";
const KEY_MATERIAL = Object.freeze({
  [CURRENT_KEY_ID]: "revision-current-integrity-secret",
  [PREVIOUS_KEY_ID]: "revision-previous-integrity-secret",
});
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER;
const REAL_FILE_SYSTEM = Object.freeze({
  lstat: fileSystem.lstat,
  mkdir: fileSystem.mkdir,
  readdir: fileSystem.readdir,
  rmdir: fileSystem.rmdir,
  writeFile: fileSystem.writeFile,
  rename: fileSystem.rename,
  unlink: fileSystem.unlink,
  readFile: fileSystem.readFile,
});

let groups = 0;
let tests = 0;

function candidate(overrides = {}) {
  return {
    candidate_id: "revision-candidate-001",
    schema_version: PENDING_HANDOFF_SCHEMA_VERSION,
    status: "candidate",
    created_at: "2026-07-30T01:00:00.000Z",
    expires_at: "2026-07-30T02:00:00.000Z",
    source_runtime: "codex",
    source_session_identity: SESSION_IDENTITY,
    repository_identity: REPOSITORY_IDENTITY,
    worktree_identity: WORKTREE_IDENTITY,
    goal: "Persist a revision-bound pending handoff candidate.",
    completed: ["The candidate was canonicalized."],
    open_issues: [],
    verification: ["The revision fixture uses an isolated temporary directory."],
    do_not_touch: ["Claim and lease state."],
    next_action: "Compare and set the next state with an expected revision.",
    context_checkpoint_status: "review_needed",
    privacy_redaction_status: "passed",
    ...overrides,
  };
}

function frozenFunction(operation) {
  return Object.freeze(operation);
}

function buildProvider(overrides = {}) {
  const currentKeyId = overrides.current_key_id ?? CURRENT_KEY_ID;
  const verificationKeyIds = overrides.verification_key_ids
    ?? Object.freeze([CURRENT_KEY_ID, PREVIOUS_KEY_ID]);
  const keyedDigest = overrides.keyed_digest ?? frozenFunction(({ key_id, purpose, bytes }) => {
    const secret = KEY_MATERIAL[key_id];
    if (secret === undefined || purpose !== PENDING_HANDOFF_INTEGRITY_PURPOSE) {
      throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
    }
    return createHmac("sha256", secret).update(Buffer.from(bytes)).digest("base64url");
  });
  const safeEqual = overrides.safe_equal ?? frozenFunction((left, right) => left === right);
  return Object.freeze({
    version: overrides.version ?? PENDING_HANDOFF_INTEGRITY_PROVIDER_VERSION,
    current_key_id: currentKeyId,
    verification_key_ids: verificationKeyIds,
    keyed_digest: keyedDigest,
    safe_equal: safeEqual,
  });
}

function storeOptions(rootDirectory, overrides = {}) {
  return {
    rootDirectory,
    integrityProvider: buildProvider(),
    ...overrides,
  };
}

function dependencies(provider = buildProvider()) {
  assert.equal(typeof createPendingHandoffIntegrityDependencies, "function");
  return assertSuccess(createPendingHandoffIntegrityDependencies(provider));
}

function assertSuccess(result) {
  assert.equal(result?.ok, true, `expected success, got ${result?.reason}`);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "value"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  return result.value;
}

function assertFailure(result, reason) {
  assert.equal(result?.ok, false);
  assert.equal(result.reason, reason);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.equal(Object.hasOwn(result, "metadata"), false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(PRIVATE_MARKER), false);
  assert.equal(serialized.includes(EXCEPTION_MARKER), false);
  assert.equal(serialized.includes("record.json"), false);
}

function assertNoLeak(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(PRIVATE_MARKER), false);
  assert.equal(serialized.includes(EXCEPTION_MARKER), false);
  assert.equal(serialized.includes("record.json"), false);
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

function keyFor(candidateId) {
  const result = derivePendingHandoffRecordKey(candidateId);
  return assertSuccess(result);
}

function lockDirectoryFor(rootDirectory, candidateId) {
  return join(rootDirectory, keyFor(candidateId), ".cas-lock");
}

function ownerPathFor(lockDirectory, token) {
  return join(lockDirectory, `owner-${token}.json`);
}

async function writeOwnerLock(lockDirectory, token, ownerPid, old = false) {
  await fileSystem.mkdir(lockDirectory, { mode: 0o700 });
  await fileSystem.writeFile(
    ownerPathFor(lockDirectory, token),
    `${JSON.stringify({ owner_pid: ownerPid, owner_token: token })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  if (old) {
    const oldTime = new Date(Date.now() - 120_000);
    await fileSystem.utimes(lockDirectory, oldTime, oldTime);
  }
}

async function waitForSignal(signal, label, timeoutMs = 1500) {
  let timer;
  try {
    return await Promise.race([
      signal,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`fixture barrier timeout: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertArbitrationFailure(result, rawValues = []) {
  assertFailure(result, "cas_arbitration_failed");
  assertNoLeak(result);
  const serialized = JSON.stringify(result);
  for (const rawValue of rawValues) {
    if (typeof rawValue === "string" && rawValue.length > 0) {
      assert.equal(serialized.includes(rawValue), false);
    }
  }
}

function assertSingleWinner(results) {
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => ["revision_conflict", "cas_arbitration_failed"].includes(result.reason)).length, 1);
}

async function withStore(operation, options = {}) {
  const rootDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-revision-fixture-"));
  try {
    assert.equal(typeof createPendingHandoffStore, "function");
    const store = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, options)));
    return await operation({ rootDirectory, store });
  } finally {
    await fileSystem.rm(rootDirectory, { recursive: true, force: true });
  }
}

async function rawRecord(rootDirectory, candidateId) {
  return JSON.parse(await fileSystem.readFile(
    join(rootDirectory, keyFor(candidateId), "record.json"),
    "utf8",
  ));
}

async function writeRawRecord(rootDirectory, candidateId, value) {
  const recordDirectory = join(rootDirectory, keyFor(candidateId));
  await fileSystem.mkdir(recordDirectory, { recursive: true });
  await fileSystem.writeFile(
    join(recordDirectory, "record.json"),
    `${JSON.stringify(value)}\n`,
    "utf8",
  );
}

function revisionEnvelope(value, revision, provider = buildProvider()) {
  assert.equal(typeof createPendingHandoffRevisionIntegrityEnvelope, "function");
  return assertSuccess(createPendingHandoffRevisionIntegrityEnvelope(
    value,
    revision,
    dependencies(provider),
  ));
}

function legacyEnvelope(value, provider = buildProvider()) {
  assert.equal(typeof createPendingHandoffIntegrityEnvelope, "function");
  return assertSuccess(createPendingHandoffIntegrityEnvelope(value, dependencies(provider)));
}

async function waitForFile(location, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fileSystem.lstat(location);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error("fixture barrier timeout");
}

async function runRaceChild(mode, rootDirectory, candidateId, expectedRevision, barrierDirectory, goal) {
  const storeResult = createPendingHandoffStore(storeOptions(rootDirectory));
  if (!storeResult.ok) return storeResult;
  const store = storeResult.value;
  if (mode === "race") {
    await fileSystem.writeFile(
      join(barrierDirectory, `ready-${process.pid}`),
      "ready\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await waitForFile(join(barrierDirectory, "release"));
  }

  if (mode === "crash-before-publish" || mode === "crash-after-publish") {
    const crashingFileSystem = {
      ...REAL_FILE_SYSTEM,
      rename: async (...args) => {
        if (mode === "crash-after-publish") await REAL_FILE_SYSTEM.rename(...args);
        process.exit(71);
      },
    };
    const crashingStore = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
      fileSystem: crashingFileSystem,
    })));
    await crashingStore.compareAndSet({
      candidate_id: candidateId,
      expected_revision: expectedRevision,
      next_state: candidate({ candidate_id: candidateId, goal }),
    });
    return;
  }

  return store.compareAndSet({
    candidate_id: candidateId,
    expected_revision: expectedRevision,
    next_state: candidate({ candidate_id: candidateId, goal }),
  });
}

async function spawnRaceChild(mode, rootDirectory, candidateId, expectedRevision, barrierDirectory, goal) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), `--revision-child=${mode}`, rootDirectory, candidateId, String(expectedRevision), barrierDirectory, goal],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise(resolve => child.once("exit", resolve));
  if (exitCode !== 0 && mode === "race") {
    throw new Error(`race child failed: ${stderr}`);
  }
  if (mode.startsWith("crash-")) return { exitCode, stdout, stderr };
  return { exitCode, result: JSON.parse(stdout.trim()), stderr };
}

if (process.argv[2]?.startsWith("--revision-child=")) {
  const mode = process.argv[2].slice("--revision-child=".length);
  const result = await runRaceChild(
    mode,
    process.argv[3],
    process.argv[4],
    Number(process.argv[5]),
    process.argv[6],
    process.argv[7],
  );
  if (!mode.startsWith("crash-")) process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

await group("API and revision contract", async () => {
  await test("exposes snapshot and atomic CAS APIs with explicit revision taxonomy", () => {
    assert.equal(typeof createPendingHandoffStore, "function");
    assert.equal(typeof createPendingHandoffRevisionIntegrityEnvelope, "function");
    assert.equal(typeof verifyPendingHandoffRevisionIntegrityEnvelope, "function");
    assert.equal(PENDING_HANDOFF_REVISION_ENVELOPE_VERSION, "phr-integrity-envelope-v2");
    assert.ok(PENDING_HANDOFF_REVISION_INTEGRITY_FAILURES.includes("integrity_revision_invalid"));
    for (const reason of [
      "revision_invalid",
      "revision_conflict",
      "revision_exhausted",
      "cas_read_failed",
      "cas_publish_failed",
      "cas_arbitration_failed",
    ]) assert.ok(PENDING_HANDOFF_STORE_FAILURES.includes(reason));
  });

  await test("keeps read/write and adds only snapshot/CAS methods at the Store boundary", async () => {
    await withStore(async ({ store }) => {
      assert.deepEqual(Object.keys(store).sort(), [
        "compareAndSet",
        "read",
        "readSnapshot",
        "readState",
        "write",
      ]);
      for (const method of Object.keys(store)) assert.equal(typeof store[method], "function");
    });
  });
});

await group("initial revision and monotonic success", async () => {
  await test("initializes revision zero outside the 17-field Candidate and preserves read compatibility", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      assert.deepEqual(assertSuccess(await store.write(input)), { record_key: keyFor(input.candidate_id) });
      assert.deepEqual(assertSuccess(await store.read(input.candidate_id)), input);
      const snapshot = assertSuccess(await store.readSnapshot(input.candidate_id));
      assert.deepEqual(snapshot, { candidate: input, state_revision: 0 });
      assert.deepEqual(Object.keys(await rawRecord(rootDirectory, input.candidate_id)), [
        "envelope_version",
        "state_revision",
        "integrity",
        "candidate",
      ]);
      assert.equal(Object.hasOwn(snapshot.candidate, "state_revision"), false);
    });
  });

  await test("increments exactly one revision and returns the new revision", async () => {
    await withStore(async ({ store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      const next = candidate({ goal: "The winner state is revision one." });
      const result = assertSuccess(await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: next,
      }));
      assert.deepEqual(result, { new_revision: 1 });
      assert.deepEqual(assertSuccess(await store.readSnapshot(input.candidate_id)), {
        candidate: next,
        state_revision: 1,
      });
    });
  });

  await test("rejects unconditional replacement after initial creation", async () => {
    await withStore(async ({ store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      assertFailure(await store.write(candidate({ goal: PRIVATE_MARKER })), "record_exists");
      assert.deepEqual(assertSuccess(await store.readSnapshot(input.candidate_id)), {
        candidate: input,
        state_revision: 0,
      });
    });
  });
});

await group("revision validation and conflict", async () => {
  await test("rejects stale and future expected revisions without disk mutation", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      const before = await fileSystem.readFile(join(rootDirectory, keyFor(input.candidate_id), "record.json"), "utf8");
      const stale = await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        next_state: candidate({ goal: PRIVATE_MARKER }),
      });
      const future = await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 2,
        next_state: candidate({ goal: PRIVATE_MARKER }),
      });
      assertFailure(stale, "revision_conflict");
      assertFailure(future, "revision_conflict");
      assert.equal(await fileSystem.readFile(join(rootDirectory, keyFor(input.candidate_id), "record.json"), "utf8"), before);
      assertNoLeak(stale);
      assertNoLeak(future);
    });
  });

  await test("rejects malformed, negative, fractional, unsafe, and arbitrary revisions", async () => {
    await withStore(async ({ store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      for (const expectedRevision of [null, -1, 0.5, "0", Infinity, NaN, MAX_SAFE_REVISION + 1]) {
        assertFailure(await store.compareAndSet({
          candidate_id: input.candidate_id,
          expected_revision: expectedRevision,
          next_state: candidate(),
        }), "revision_invalid");
      }
      assertFailure(await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: { ...candidate(), state_revision: 99 },
      }), "record_invalid");
      assertFailure(await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: "different-candidate" }),
      }), "record_invalid");
    });
  });

  await test("rejects an exhausted maximum safe revision without mutation", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "revision-exhausted" });
      await writeRawRecord(rootDirectory, input.candidate_id, revisionEnvelope(input, MAX_SAFE_REVISION));
      const before = await fileSystem.readFile(join(rootDirectory, keyFor(input.candidate_id), "record.json"), "utf8");
      assertFailure(await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: MAX_SAFE_REVISION,
        next_state: candidate({ candidate_id: input.candidate_id }),
      }), "revision_exhausted");
      assert.equal(await fileSystem.readFile(join(rootDirectory, keyFor(input.candidate_id), "record.json"), "utf8"), before);
    });
  });
});

await group("legacy policy and integrity binding", async () => {
  await test("keeps legacy v1 reads explicit but rejects unversioned snapshot/CAS", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "legacy-v1" });
      await writeRawRecord(rootDirectory, input.candidate_id, legacyEnvelope(input));
      assert.deepEqual(assertSuccess(await store.read(input.candidate_id)), input);
      assertFailure(await store.readSnapshot(input.candidate_id), "revision_invalid");
      assertFailure(await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: input,
      }), "revision_invalid");
    });
  });

  await test("rejects revision-only tampering through the v2 Integrity binding", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "revision-tamper" });
      assertSuccess(await store.write(input));
      const stored = await rawRecord(rootDirectory, input.candidate_id);
      stored.state_revision = 1;
      await writeRawRecord(rootDirectory, input.candidate_id, stored);
      assertFailure(await store.readSnapshot(input.candidate_id), "record_integrity_mismatch");
      assertFailure(await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: input,
      }), "record_integrity_mismatch");
    });
  });

  await test("rejects a malformed persisted revision before any CAS publication", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "malformed-persisted-revision" });
      assertSuccess(await store.write(input));
      const stored = await rawRecord(rootDirectory, input.candidate_id);
      stored.state_revision = "0";
      await writeRawRecord(rootDirectory, input.candidate_id, stored);
      assertFailure(await store.readSnapshot(input.candidate_id), "revision_invalid");
      assertFailure(await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: input,
      }), "revision_invalid");
    });
  });

  await test("keeps the revision envelope exact and the Candidate contract unchanged", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "revision-schema" });
      assertSuccess(await store.write(input));
      const stored = await rawRecord(rootDirectory, input.candidate_id);
      assert.deepEqual(Object.keys(stored.integrity), ["algorithm", "key_id", "digest"]);
      assert.deepEqual(Object.keys(stored.candidate), Object.keys(input));
      assert.equal(Object.hasOwn(stored.candidate, "state_revision"), false);
      const verified = assertSuccess(verifyPendingHandoffRevisionIntegrityEnvelope(
        stored,
        dependencies(),
      ));
      assert.deepEqual(verified, { candidate: input, state_revision: 0 });
    });
  });
});

await group("atomic publication and failure boundaries", async () => {
  await test("preserves the previous valid state and cleans temp/lock artifacts on publish failure", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "publish-failure" });
      assertSuccess(await store.write(input));
      const failingFileSystem = { ...REAL_FILE_SYSTEM, rename: async () => {
        throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
      } };
      const failingStore = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: failingFileSystem,
      })));
      const result = await failingStore.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: PRIVATE_MARKER }),
      });
      assertFailure(result, "cas_publish_failed");
      assert.deepEqual(assertSuccess(await store.readSnapshot(input.candidate_id)), {
        candidate: input,
        state_revision: 0,
      });
      assert.deepEqual(await fileSystem.readdir(join(rootDirectory, keyFor(input.candidate_id))), ["record.json"]);
      assertNoLeak(result);
    });
  });

  await test("exposes only complete old or new snapshots during publication", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "visibility-race" });
      assertSuccess(await store.write(input));
      let renameStarted;
      const started = new Promise(resolve => { renameStarted = resolve; });
      let releaseRename;
      const release = new Promise(resolve => { releaseRename = resolve; });
      const gatedFileSystem = {
        ...REAL_FILE_SYSTEM,
        rename: async (...args) => {
          renameStarted();
          await release;
          return REAL_FILE_SYSTEM.rename(...args);
        },
      };
      const writer = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: gatedFileSystem,
      })));
      const operation = writer.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: "published-after-barrier" }),
      });
      await started;
      assert.deepEqual(assertSuccess(await store.readSnapshot(input.candidate_id)), {
        candidate: input,
        state_revision: 0,
      });
      releaseRename();
      assert.deepEqual(assertSuccess(await operation), { new_revision: 1 });
      assert.equal(assertSuccess(await store.readSnapshot(input.candidate_id)).state_revision, 1);
    });
  });
});

await group("owner-bound arbitration lifecycle", async () => {
  await test("fails closed for a live owner even when its lock directory is old", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "live-old-owner" });
      assertSuccess(await store.write(input));
      await writeOwnerLock(
        lockDirectoryFor(rootDirectory, input.candidate_id),
        "11111111-1111-4111-8111-111111111111",
        process.pid,
        true,
      );
      const result = await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: PRIVATE_MARKER }),
      });
      assertArbitrationFailure(result);
      assert.equal(assertSuccess(await store.readSnapshot(input.candidate_id)).state_revision, 0);
    });
  });

  await test("fails closed on EPERM owner liveness without mutating the lock or record", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "eperm-owner-liveness" });
      const unrelated = candidate({ candidate_id: "eperm-unrelated-record" });
      assertSuccess(await store.write(input));
      assertSuccess(await store.write(unrelated));
      const recordDirectory = join(rootDirectory, keyFor(input.candidate_id));
      const unrelatedDirectory = join(rootDirectory, keyFor(unrelated.candidate_id));
      const recordBefore = await fileSystem.readFile(join(recordDirectory, "record.json"), "utf8");
      const unrelatedBefore = await fileSystem.readFile(join(unrelatedDirectory, "record.json"), "utf8");
      const lockDirectory = lockDirectoryFor(rootDirectory, input.candidate_id);
      const token = "44444444-4444-4444-8444-444444444444";
      const ownerPid = process.pid + 1;
      const ownerPath = ownerPathFor(lockDirectory, token);
      await writeOwnerLock(lockDirectory, token, ownerPid, true);

      const originalKill = process.kill;
      let livenessCalls = 0;
      process.kill = (pid, signal) => {
        if (pid === ownerPid && signal === 0) {
          livenessCalls += 1;
          const error = new Error("private liveness detail");
          error.code = "EPERM";
          throw error;
        }
        return originalKill.call(process, pid, signal);
      };
      let result;
      try {
        result = await store.compareAndSet({
          candidate_id: input.candidate_id,
          expected_revision: 0,
          next_state: candidate({ candidate_id: input.candidate_id, goal: PRIVATE_MARKER }),
        });
      } finally {
        process.kill = originalKill;
      }

      assertArbitrationFailure(result, [
        String(ownerPid),
        "EPERM",
        "private liveness detail",
        ownerPath,
        lockDirectory,
        token,
      ]);
      assert.equal(livenessCalls, 1);
      assert.equal(await fileSystem.readFile(ownerPath, "utf8"), `${JSON.stringify({ owner_pid: ownerPid, owner_token: token })}\n`);
      assert.equal(await fileSystem.readFile(join(recordDirectory, "record.json"), "utf8"), recordBefore);
      assert.equal(await fileSystem.readFile(join(unrelatedDirectory, "record.json"), "utf8"), unrelatedBefore);
      assert.deepEqual((await fileSystem.readdir(recordDirectory)).sort(), [".cas-lock", "record.json"]);
      assert.deepEqual(assertSuccess(await store.readSnapshot(input.candidate_id)), {
        candidate: input,
        state_revision: 0,
      });
    });
  });

  await test("fails closed for ambiguous owner metadata without deleting the lock", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "ambiguous-owner" });
      assertSuccess(await store.write(input));
      const lockDirectory = lockDirectoryFor(rootDirectory, input.candidate_id);
      const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const ownerPath = ownerPathFor(lockDirectory, token);
      await fileSystem.mkdir(lockDirectory, { mode: 0o700 });
      await fileSystem.writeFile(
        ownerPath,
        `${JSON.stringify({ owner_pid: process.pid, owner_token: "different-token" })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      const result = await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: PRIVATE_MARKER }),
      });
      assertArbitrationFailure(result);
      assert.equal(await fileSystem.readFile(ownerPath, "utf8"), `${JSON.stringify({ owner_pid: process.pid, owner_token: "different-token" })}\n`);
      assert.equal(assertSuccess(await store.readSnapshot(input.candidate_id)).state_revision, 0);
    });
  });

  await test("rejects a filename and metadata mismatch when both owner tokens are valid UUID v4", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "valid-valid-owner-binding" });
      const unrelated = candidate({ candidate_id: "valid-valid-unrelated-record" });
      assertSuccess(await store.write(input));
      assertSuccess(await store.write(unrelated));

      const recordDirectory = join(rootDirectory, keyFor(input.candidate_id));
      const recordPath = join(recordDirectory, "record.json");
      const unrelatedPath = join(rootDirectory, keyFor(unrelated.candidate_id), "record.json");
      const recordBefore = await fileSystem.readFile(recordPath, "utf8");
      const unrelatedBefore = await fileSystem.readFile(unrelatedPath, "utf8");
      const lockDirectory = lockDirectoryFor(rootDirectory, input.candidate_id);
      const filenameToken = "55555555-5555-4555-8555-555555555555";
      const metadataToken = "66666666-6666-4666-8666-666666666666";
      const ownerPid = 999999999;
      const ownerPath = ownerPathFor(lockDirectory, filenameToken);
      const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      assert.match(filenameToken, uuidV4Pattern);
      assert.match(metadataToken, uuidV4Pattern);
      assert.notEqual(filenameToken, metadataToken);
      await fileSystem.mkdir(lockDirectory, { mode: 0o700 });
      const ownerContents = `${JSON.stringify({ owner_pid: ownerPid, owner_token: metadataToken })}\n`;
      await fileSystem.writeFile(ownerPath, ownerContents, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });

      let livenessCalls = 0;
      let ownerUnlinkCalls = 0;
      let lockRmdirCalls = 0;
      let publicationRenameCalls = 0;
      let recordReadCalls = 0;
      const observingFileSystem = {
        ...REAL_FILE_SYSTEM,
        readFile: async (location, ...args) => {
          if (location === recordPath) recordReadCalls += 1;
          return REAL_FILE_SYSTEM.readFile(location, ...args);
        },
        unlink: async location => {
          if (location === ownerPath) ownerUnlinkCalls += 1;
          return REAL_FILE_SYSTEM.unlink(location);
        },
        rmdir: async location => {
          if (location === lockDirectory) lockRmdirCalls += 1;
          return REAL_FILE_SYSTEM.rmdir(location);
        },
        rename: async (...args) => {
          if (args[1] === recordPath) publicationRenameCalls += 1;
          return REAL_FILE_SYSTEM.rename(...args);
        },
      };
      const observedStore = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: observingFileSystem,
      })));
      const originalKill = process.kill;
      process.kill = (pid, signal) => {
        if (pid === ownerPid && signal === 0) livenessCalls += 1;
        return originalKill.call(process, pid, signal);
      };
      let result;
      try {
        result = await observedStore.compareAndSet({
          candidate_id: input.candidate_id,
          expected_revision: 0,
          next_state: candidate({ candidate_id: input.candidate_id, goal: PRIVATE_MARKER }),
        });
      } finally {
        process.kill = originalKill;
      }

      assertArbitrationFailure(result, [
        filenameToken,
        metadataToken,
        String(ownerPid),
        ownerPath,
        lockDirectory,
      ]);
      assert.equal(livenessCalls, 0);
      assert.equal(ownerUnlinkCalls, 0);
      assert.equal(lockRmdirCalls, 0);
      assert.equal(publicationRenameCalls, 0);
      assert.equal(recordReadCalls, 0);
      assert.equal(await fileSystem.readFile(ownerPath, "utf8"), ownerContents);
      assert.equal(await fileSystem.readFile(recordPath, "utf8"), recordBefore);
      assert.equal(await fileSystem.readFile(unrelatedPath, "utf8"), unrelatedBefore);
      assert.deepEqual((await fileSystem.readdir(recordDirectory)).sort(), [".cas-lock", "record.json"]);
      assert.deepEqual(assertSuccess(await store.readSnapshot(input.candidate_id)), {
        candidate: input,
        state_revision: 0,
      });
    });
  });

  await test("fails closed for an unsafe owner token target", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "unsafe-owner-target" });
      assertSuccess(await store.write(input));
      const lockDirectory = lockDirectoryFor(rootDirectory, input.candidate_id);
      await fileSystem.mkdir(lockDirectory, { mode: 0o700 });
      await fileSystem.symlink(process.execPath, ownerPathFor(
        lockDirectory,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ));
      const result = await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: PRIVATE_MARKER }),
      });
      assertArbitrationFailure(result);
      assert.equal(assertSuccess(await store.readSnapshot(input.candidate_id)).state_revision, 0);
    });
  });

  await test("recovers only a definitely dead owner token", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "dead-owner-recovery" });
      assertSuccess(await store.write(input));
      const lockDirectory = lockDirectoryFor(rootDirectory, input.candidate_id);
      await writeOwnerLock(
        lockDirectory,
        "22222222-2222-4222-8222-222222222222",
        999999999,
        true,
      );
      assert.deepEqual(assertSuccess(await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: "recovered-dead-owner" }),
      })), { new_revision: 1 });
      await assert.rejects(() => fileSystem.lstat(lockDirectory));
    });
  });
});

await group("owner token validation", async () => {
  const invalidTokens = [
    ["arbitrary 36 characters", "Z".repeat(36)],
    ["lowercase hexadecimal non-v4", "123e4567-e89b-02d3-a456-426614174000"],
    ["wrong version nibble", "123e4567-e89b-52d3-a456-426614174000"],
    ["wrong variant nibble", "123e4567-e89b-42d3-c456-426614174000"],
    ["malformed hyphen placement", "123e4567ae89b-42d3-a456-426614174000"],
    ["uppercase UUID v4", "123E4567-E89B-42D3-A456-426614174000"],
    ["non-hex character", "123e4567-e89b-42d3-a456-42661417400z"],
    ["empty token", ""],
  ];

  for (const [label, token] of invalidTokens) {
    await test(`rejects ${label} before dead-owner recovery`, async () => {
      await withStore(async ({ rootDirectory, store }) => {
        const input = candidate({ candidate_id: `invalid-owner-token-${label.replaceAll(" ", "-")}` });
        const unrelated = candidate({ candidate_id: `${input.candidate_id}-unrelated` });
        assertSuccess(await store.write(input));
        assertSuccess(await store.write(unrelated));
        const recordDirectory = join(rootDirectory, keyFor(input.candidate_id));
        const unrelatedDirectory = join(rootDirectory, keyFor(unrelated.candidate_id));
        const recordBefore = await fileSystem.readFile(join(recordDirectory, "record.json"), "utf8");
        const unrelatedBefore = await fileSystem.readFile(join(unrelatedDirectory, "record.json"), "utf8");
        const lockDirectory = lockDirectoryFor(rootDirectory, input.candidate_id);
        const ownerPath = ownerPathFor(lockDirectory, token);
        const ownerContents = `${JSON.stringify({ owner_pid: 999999999, owner_token: token })}\n`;
        await writeOwnerLock(lockDirectory, token, 999999999, true);

        const result = await store.compareAndSet({
          candidate_id: input.candidate_id,
          expected_revision: 0,
          next_state: candidate({ candidate_id: input.candidate_id, goal: PRIVATE_MARKER }),
        });

        assertArbitrationFailure(result, [
          "999999999",
          ownerPath,
          lockDirectory,
          token,
        ]);
        assert.equal(await fileSystem.readFile(ownerPath, "utf8"), ownerContents);
        assert.equal((await fileSystem.lstat(lockDirectory)).isDirectory(), true);
        assert.equal(await fileSystem.readFile(join(recordDirectory, "record.json"), "utf8"), recordBefore);
        assert.equal(await fileSystem.readFile(join(unrelatedDirectory, "record.json"), "utf8"), unrelatedBefore);
        assert.deepEqual((await fileSystem.readdir(recordDirectory)).sort(), [".cas-lock", "record.json"]);
        assert.deepEqual(assertSuccess(await store.readSnapshot(input.candidate_id)), {
          candidate: input,
          state_revision: 0,
        });
      });
    });
  }
});

await group("ABA and empty-directory recovery", async () => {
  await test("stale recovery cannot remove a newly acquired owner generation", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "recovery-aba" });
      assertSuccess(await store.write(input));
      const lockDirectory = lockDirectoryFor(rootDirectory, input.candidate_id);
      const staleToken = "33333333-3333-4333-8333-333333333333";
      const stalePath = ownerPathFor(lockDirectory, staleToken);
      await writeOwnerLock(lockDirectory, staleToken, 999999999, true);

      let releaseRecovery;
      const recoveryRelease = new Promise(resolve => { releaseRecovery = resolve; });
      let recoveryRemoved;
      const recoveryObserved = new Promise(resolve => { recoveryRemoved = resolve; });
      let recoveryPaused = false;
      const recoveryFileSystem = {
        ...REAL_FILE_SYSTEM,
        unlink: async location => {
          if (location === stalePath && !recoveryPaused) {
            recoveryPaused = true;
            await REAL_FILE_SYSTEM.unlink(location);
            recoveryRemoved();
            await recoveryRelease;
            return;
          }
          return REAL_FILE_SYSTEM.unlink(location);
        },
      };

      let releaseWinnerToken;
      const winnerTokenRelease = new Promise(resolve => { releaseWinnerToken = resolve; });
      let winnerTokenCreated;
      const winnerTokenObserved = new Promise(resolve => { winnerTokenCreated = resolve; });
      let winnerPaused = false;
      const winnerFileSystem = {
        ...REAL_FILE_SYSTEM,
        writeFile: async (...args) => {
          if (args[0].startsWith(`${lockDirectory}/owner-`) && args[2]?.flag === "wx" && !winnerPaused) {
            winnerPaused = true;
            const result = await REAL_FILE_SYSTEM.writeFile(...args);
            winnerTokenCreated();
            await winnerTokenRelease;
            return result;
          }
          return REAL_FILE_SYSTEM.writeFile(...args);
        },
      };
      const recoveryStore = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: recoveryFileSystem,
      })));
      const winnerStore = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: winnerFileSystem,
      })));
      const recoveryOperation = recoveryStore.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: "recovery-writer" }),
      });
      await waitForSignal(recoveryObserved, "stale owner removal");
      const oldTime = new Date(Date.now() - 120_000);
      await fileSystem.utimes(lockDirectory, oldTime, oldTime);
      const winnerOperation = winnerStore.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: "winner-writer" }),
      });
      await waitForSignal(winnerTokenObserved, "new owner token creation");
      releaseRecovery();
      assertArbitrationFailure(await recoveryOperation);
      releaseWinnerToken();
      assert.deepEqual(assertSuccess(await winnerOperation), { new_revision: 1 });
      assert.equal(assertSuccess(await store.readSnapshot(input.candidate_id)).candidate.goal, "winner-writer");
    });
  });

  await test("late owner release cannot remove a new owner generation", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "release-aba" });
      assertSuccess(await store.write(input));
      const lockDirectory = lockDirectoryFor(rootDirectory, input.candidate_id);
      let releaseOwnerRmdir;
      const ownerRmdirRelease = new Promise(resolve => { releaseOwnerRmdir = resolve; });
      let ownerRmdirObserved;
      const ownerRmdirStarted = new Promise(resolve => { ownerRmdirObserved = resolve; });
      let ownerPaused = false;
      const ownerFileSystem = {
        ...REAL_FILE_SYSTEM,
        rmdir: async location => {
          if (location === lockDirectory && !ownerPaused) {
            ownerPaused = true;
            ownerRmdirObserved();
            await ownerRmdirRelease;
          }
          return REAL_FILE_SYSTEM.rmdir(location);
        },
      };
      let releaseNewToken;
      const newTokenRelease = new Promise(resolve => { releaseNewToken = resolve; });
      let newTokenObserved;
      const newTokenCreated = new Promise(resolve => { newTokenObserved = resolve; });
      let newTokenPaused = false;
      const newOwnerFileSystem = {
        ...REAL_FILE_SYSTEM,
        writeFile: async (...args) => {
          if (args[0].startsWith(`${lockDirectory}/owner-`) && args[2]?.flag === "wx" && !newTokenPaused) {
            newTokenPaused = true;
            const result = await REAL_FILE_SYSTEM.writeFile(...args);
            newTokenObserved();
            await newTokenRelease;
            return result;
          }
          return REAL_FILE_SYSTEM.writeFile(...args);
        },
      };
      const ownerStore = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: ownerFileSystem,
      })));
      const newOwnerStore = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: newOwnerFileSystem,
      })));
      const ownerOperation = ownerStore.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: "old-owner" }),
      });
      await waitForSignal(ownerRmdirStarted, "old owner release");
      const oldTime = new Date(Date.now() - 120_000);
      await fileSystem.utimes(lockDirectory, oldTime, oldTime);
      const newOwnerOperation = newOwnerStore.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        next_state: candidate({ candidate_id: input.candidate_id, goal: "new-owner" }),
      });
      await waitForSignal(newTokenCreated, "new owner token");
      releaseOwnerRmdir();
      assert.deepEqual(assertSuccess(await ownerOperation), { new_revision: 1 });
      releaseNewToken();
      assert.deepEqual(assertSuccess(await newOwnerOperation), { new_revision: 2 });
      assert.equal(assertSuccess(await store.readSnapshot(input.candidate_id)).candidate.goal, "new-owner");
    });
  });

  await test("empty-directory recovery cannot enter a new generation after path reuse", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "empty-directory-race" });
      assertSuccess(await store.write(input));
      const lockDirectory = lockDirectoryFor(rootDirectory, input.candidate_id);
      await fileSystem.mkdir(lockDirectory, { mode: 0o700 });
      const oldTime = new Date(Date.now() - 120_000);
      await fileSystem.utimes(lockDirectory, oldTime, oldTime);
      let releaseRecoveryRmdir;
      const recoveryRmdirRelease = new Promise(resolve => { releaseRecoveryRmdir = resolve; });
      let recoveryRmdirObserved;
      const recoveryRmdirStarted = new Promise(resolve => { recoveryRmdirObserved = resolve; });
      let recoveryPaused = false;
      const recoveryFileSystem = {
        ...REAL_FILE_SYSTEM,
        rmdir: async location => {
          if (location === lockDirectory && !recoveryPaused) {
            recoveryPaused = true;
            recoveryRmdirObserved();
            await recoveryRmdirRelease;
          }
          return REAL_FILE_SYSTEM.rmdir(location);
        },
      };
      let releaseTokenAttempt;
      const tokenAttemptRelease = new Promise(resolve => { releaseTokenAttempt = resolve; });
      let tokenAttemptObserved;
      const tokenAttempt = new Promise(resolve => { tokenAttemptObserved = resolve; });
      let tokenPaused = false;
      const newWriterFileSystem = {
        ...REAL_FILE_SYSTEM,
        writeFile: async (...args) => {
          if (args[0].startsWith(`${lockDirectory}/owner-`) && args[2]?.flag === "wx" && !tokenPaused) {
            tokenPaused = true;
            tokenAttemptObserved();
            await tokenAttemptRelease;
          }
          return REAL_FILE_SYSTEM.writeFile(...args);
        },
      };
      const recoveryStore = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: recoveryFileSystem,
      })));
      const newWriterStore = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: newWriterFileSystem,
      })));
      const recoveryOperation = recoveryStore.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: "recovery-writer" }),
      });
      await waitForSignal(recoveryRmdirStarted, "empty recovery rmdir");
      await REAL_FILE_SYSTEM.rmdir(lockDirectory);
      const newWriterOperation = newWriterStore.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: "new-empty-generation" }),
      });
      await waitForSignal(tokenAttempt, "empty generation token attempt");
      releaseRecoveryRmdir();
      assert.deepEqual(assertSuccess(await recoveryOperation), { new_revision: 1 });
      releaseTokenAttempt();
      const newWriterResult = await newWriterOperation;
      assert.equal(newWriterResult.ok, false);
      assert.ok(["cas_arbitration_failed", "revision_conflict"].includes(newWriterResult.reason));
      assert.equal(assertSuccess(await store.readSnapshot(input.candidate_id)).state_revision, 1);
    });
  });
});

await group("independent instance and process concurrency", async () => {
  await test("serializes two Store instances while preserving stale conflict", async () => {
    const rootDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-revision-instance-race-"));
    try {
      const first = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory)));
      const second = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory)));
      const input = candidate({ candidate_id: "instance-race" });
      assertSuccess(await first.write(input));
      const [firstResult, secondResult] = await Promise.all([
        first.compareAndSet({ candidate_id: input.candidate_id, expected_revision: 0, next_state: candidate({ candidate_id: input.candidate_id, goal: "first" }) }),
        second.compareAndSet({ candidate_id: input.candidate_id, expected_revision: 0, next_state: candidate({ candidate_id: input.candidate_id, goal: "second" }) }),
      ]);
      assertSingleWinner([firstResult, secondResult]);
      assert.equal(assertSuccess(await first.readSnapshot(input.candidate_id)).state_revision, 1);
    } finally {
      await fileSystem.rm(rootDirectory, { recursive: true, force: true });
    }
  });

  await test("wins exactly once across two independent Node processes", async () => {
    const rootDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-revision-process-race-"));
    const barrierDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-revision-barrier-"));
    try {
      const store = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory)));
      const input = candidate({ candidate_id: "process-race" });
      assertSuccess(await store.write(input));
      const first = spawnRaceChild("race", rootDirectory, input.candidate_id, 0, barrierDirectory, "process-winner-a");
      const second = spawnRaceChild("race", rootDirectory, input.candidate_id, 0, barrierDirectory, "process-winner-b");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const entries = await fileSystem.readdir(barrierDirectory);
        if (entries.filter(entry => entry.startsWith("ready-")).length === 2) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const entries = await fileSystem.readdir(barrierDirectory);
      assert.equal(entries.filter(entry => entry.startsWith("ready-")).length, 2);
      await fileSystem.writeFile(join(barrierDirectory, "release"), "release\n", "utf8");
      const outcomes = await Promise.all([first, second]);
      assertSingleWinner(outcomes.map(outcome => outcome.result));
      const final = assertSuccess(await store.readSnapshot(input.candidate_id));
      assert.equal(final.state_revision, 1);
      assert.ok(["process-winner-a", "process-winner-b"].includes(final.candidate.goal));
    } finally {
      await fileSystem.rm(barrierDirectory, { recursive: true, force: true });
      await fileSystem.rm(rootDirectory, { recursive: true, force: true });
    }
  });
});

await group("crash recovery and privacy", async () => {
  await test("recovers an orphan arbitration lock after failure before publication", async () => {
    const rootDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-revision-crash-before-"));
    try {
      const store = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory)));
      const input = candidate({ candidate_id: "crash-before" });
      assertSuccess(await store.write(input));
      const child = await spawnRaceChild("crash-before-publish", rootDirectory, input.candidate_id, 0, rootDirectory, "never-published");
      assert.equal(child.exitCode, 71);
      assert.deepEqual(assertSuccess(await store.readSnapshot(input.candidate_id)), { candidate: input, state_revision: 0 });
      assert.deepEqual(assertSuccess(await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: "recovered-after-before-crash" }),
      })), { new_revision: 1 });
    } finally {
      await fileSystem.rm(rootDirectory, { recursive: true, force: true });
    }
  });

  await test("keeps the published state after failure immediately after publication", async () => {
    const rootDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-revision-crash-after-"));
    try {
      const store = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory)));
      const input = candidate({ candidate_id: "crash-after" });
      assertSuccess(await store.write(input));
      const child = await spawnRaceChild("crash-after-publish", rootDirectory, input.candidate_id, 0, rootDirectory, "published-before-crash");
      assert.equal(child.exitCode, 71);
      assert.equal(assertSuccess(await store.readSnapshot(input.candidate_id)).state_revision, 1);
      assert.deepEqual(assertSuccess(await store.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        next_state: candidate({ candidate_id: input.candidate_id, goal: "recovered-after-after-crash" }),
      })), { new_revision: 2 });
    } finally {
      await fileSystem.rm(rootDirectory, { recursive: true, force: true });
    }
  });

  await test("redacts CAS filesystem exceptions and never publishes Claim/Lease metadata", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "cas-privacy" });
      assertSuccess(await store.write(input));
      const failingStore = assertSuccess(createPendingHandoffStore(storeOptions(rootDirectory, {
        fileSystem: { ...REAL_FILE_SYSTEM, lstat: async () => { throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`); } },
      })));
      const result = await failingStore.compareAndSet({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        next_state: candidate({ candidate_id: input.candidate_id, goal: PRIVATE_MARKER }),
      });
      assertFailure(result, "cas_read_failed");
      assertNoLeak(result);
      const stored = await rawRecord(rootDirectory, input.candidate_id);
      assert.equal(Object.hasOwn(stored, "claim_owner_identity"), false);
      assert.equal(Object.hasOwn(stored, "claim_started_at"), false);
      assert.equal(Object.hasOwn(stored, "claim_lease_expires_at"), false);
      assert.equal(Object.hasOwn(stored.candidate, "state_revision"), false);
      assert.doesNotMatch(JSON.stringify(Object.keys(stored)), /claim|lease/i);
    });
  });
});

await group("wiring and protected boundaries", async () => {
  await test("wires one bounded Revision/CAS fixture target after Integrity", () => {
    assert.equal((MAKEFILE_SOURCE.match(/^test-pending-handoff-revision-cas-fixtures:/gm) ?? []).length, 1);
    assert.match(MAKEFILE_SOURCE, /^test-pending-handoff-revision-cas-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-revision-cas-fixtures\.mjs$/m);
    const lines = MAKEFILE_SOURCE.split("\n");
    const start = lines.findIndex(line => line.startsWith("test-v1x-fixtures:"));
    const declaration = [lines[start]];
    while (declaration.at(-1).endsWith("\\")) declaration.push(lines[start + declaration.length]);
    const targets = declaration.join(" ").replace(/^test-v1x-fixtures:\s*/, "").replaceAll("\\", " ").trim().split(/\s+/);
    assert.ok(targets.indexOf("test-pending-handoff-integrity-fixtures") < targets.indexOf("test-pending-handoff-revision-cas-fixtures"));
  });

  await test("keeps Revision/CAS out of Claim/Lease and protected Candidate domains", () => {
    assert.match(SOURCE, /createPendingHandoffRevisionIntegrityEnvelope/);
    assert.match(SOURCE, /revision_conflict/);
    assert.match(SOURCE, /flag: "wx"/);
    assert.doesNotMatch(SOURCE, /claim_owner_identity|claim_started_at|claim_lease_expires_at|claim_attempt_id/);
    assert.doesNotMatch(INTEGRITY_SOURCE, /pending-handoff-secret-provider\.mjs/);
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS\n`);
