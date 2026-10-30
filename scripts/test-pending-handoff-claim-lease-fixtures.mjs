import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PENDING_HANDOFF_SCHEMA_VERSION } from "./lib/pending-handoff-core.mjs";
import {
  createPendingHandoffRuntime,
  derivePendingHandoffRecordKey,
} from "./lib/pending-handoff-store.mjs";
import {
  createPendingHandoffIntegrityDependencies,
  createPendingHandoffClaimIntegrityEnvelope,
  createPendingHandoffIntegrityEnvelope,
  createPendingHandoffRevisionIntegrityEnvelope,
  PENDING_HANDOFF_CLAIM_ENVELOPE_VERSION,
  PENDING_HANDOFF_INTEGRITY_PROVIDER_VERSION,
  PENDING_HANDOFF_INTEGRITY_PURPOSE,
  PENDING_HANDOFF_REVISION_ENVELOPE_VERSION,
  verifyPendingHandoffClaimIntegrityEnvelope,
} from "./lib/pending-handoff-integrity.mjs";
let claimLeaseModule = null;
try {
  claimLeaseModule = await import("./lib/pending-handoff-claim-lease.mjs");
} catch {
  // API assertions below report a missing Claim/Lease boundary without exposing a path.
}

const {
  createPendingHandoffClaimLeaseService,
  PENDING_HANDOFF_CLAIM_LEASE_FAILURES,
} = claimLeaseModule ?? {};

const SOURCE = readFileSync(
  fileURLToPath(new URL("./lib/pending-handoff-claim-lease.mjs", import.meta.url)),
  "utf8",
);
const STORE_SOURCE = readFileSync(
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

const SOURCE_SESSION_IDENTITY = `phr1.session.key_A-1.${"S".repeat(43)}`;
const OWNER_A = `phr1.session.key_A-1.${"A".repeat(43)}`;
const OWNER_B = `phr1.session.key_A-1.${"B".repeat(43)}`;
const REPOSITORY_IDENTITY = `phr1.repository.key_A-1.${"R".repeat(43)}`;
const WORKTREE_IDENTITY = `phr1.worktree.key_A-1.${"W".repeat(43)}`;
const CURRENT_KEY_ID = "integrity_current";
const PREVIOUS_KEY_ID = "integrity_previous";
const PRIVATE_MARKER = "claim-private-marker";
const EXCEPTION_MARKER = "claim-exception-marker";
const KEY_MATERIAL = Object.freeze({
  [CURRENT_KEY_ID]: "claim-current-integrity-secret",
  [PREVIOUS_KEY_ID]: "claim-previous-integrity-secret",
});
const BASE_NOW = Date.parse("2026-08-01T01:00:00.000Z");
const DEFAULT_EXPIRY = Date.parse("2026-08-01T02:00:00.000Z");
const CLAIM_ATTEMPT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ATTEMPT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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

function candidate(overrides = {}) {
  return {
    candidate_id: "claim-candidate-001",
    schema_version: PENDING_HANDOFF_SCHEMA_VERSION,
    status: "candidate",
    created_at: "2026-08-01T00:00:00.000Z",
    expires_at: new Date(DEFAULT_EXPIRY).toISOString(),
    source_runtime: "codex",
    source_session_identity: SOURCE_SESSION_IDENTITY,
    repository_identity: REPOSITORY_IDENTITY,
    worktree_identity: WORKTREE_IDENTITY,
    goal: "Persist a claimable pending handoff candidate.",
    completed: ["The candidate was canonicalized."],
    open_issues: [],
    verification: ["Claim/Lease fixture uses an injected clock."],
    do_not_touch: ["Delivery and consumption state."],
    next_action: "Acquire a finite delivery lease.",
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
  return assertSuccess(createPendingHandoffIntegrityDependencies(provider));
}

function runtimeFor(rootDirectory, clock, options = {}) {
  return assertSuccess(createPendingHandoffRuntime({
    ...storeOptions(rootDirectory, options.store ?? {}),
    leaseDurationMs: options.leaseDurationMs ?? 1_000,
    clock: () => clock.value,
    deliveryCandidateDigest: frozenFunction(() => "A".repeat(43)),
    deliveryEvidenceVerifier: frozenFunction(() => ({})),
  }));
}

async function withEnvironment(operation, options = {}) {
  const rootDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-claim-lease-fixture-"));
  const clock = { value: options.now ?? BASE_NOW };
  try {
    const runtime = assertSuccess(createPendingHandoffRuntime({
      ...storeOptions(rootDirectory, options.store ?? {}),
      leaseDurationMs: options.leaseDurationMs ?? 1_000,
      clock: () => clock.value,
      deliveryCandidateDigest: frozenFunction(() => "A".repeat(43)),
      deliveryEvidenceVerifier: frozenFunction(() => ({})),
    }));
    return await operation({ rootDirectory, store: runtime.store, service: runtime.claimLease, clock, runtime });
  } finally {
    await fileSystem.rm(rootDirectory, { recursive: true, force: true });
  }
}

function keyFor(candidateId) {
  return assertSuccess(derivePendingHandoffRecordKey(candidateId));
}

function recordPathFor(rootDirectory, candidateId) {
  return join(rootDirectory, keyFor(candidateId), "record.json");
}

async function rawEnvelope(rootDirectory, candidateId) {
  return JSON.parse(await fileSystem.readFile(recordPathFor(rootDirectory, candidateId), "utf8"));
}

async function rawEnvelopeText(rootDirectory, candidateId) {
  return fileSystem.readFile(recordPathFor(rootDirectory, candidateId), "utf8");
}

async function writeRawEnvelope(rootDirectory, candidateId, value) {
  await fileSystem.writeFile(
    recordPathFor(rootDirectory, candidateId),
    `${JSON.stringify(value)}\n`,
    "utf8",
  );
}

async function seedCandidate(store, overrides = {}) {
  const input = candidate(overrides);
  assertSuccess(await store.write(input));
  return input;
}

async function seedPending(store, service, overrides = {}) {
  const input = await seedCandidate(store, overrides);
  assert.deepEqual(assertSuccess(await service.registerPending({
    candidate_id: input.candidate_id,
    expected_revision: 0,
  })), { state_revision: 1, status: "pending" });
  return input;
}

async function seedClaim(store, service, clock, overrides = {}) {
  const input = await seedPending(store, service, overrides);
  const result = assertSuccess(await service.acquireClaim({
    candidate_id: input.candidate_id,
    expected_revision: 1,
    current_session_identity: OWNER_A,
    claim_attempt_id: CLAIM_ATTEMPT_A,
  }));
  return { input, result, state: assertSuccess(await store.readState(input.candidate_id)), clock };
}

function assertNoLeak(value, rawValues = []) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(PRIVATE_MARKER), false);
  assert.equal(serialized.includes(EXCEPTION_MARKER), false);
  assert.equal(serialized.includes("record.json"), false);
  for (const rawValue of rawValues) {
    if (typeof rawValue === "string" && rawValue.length > 0) {
      assert.equal(serialized.includes(rawValue), false);
    }
  }
}

function assertFailureWithoutLeak(result, reason, rawValues = []) {
  assertFailure(result, reason);
  assertNoLeak(result, rawValues);
}

async function waitForFile(location, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fileSystem.lstat(location);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error("claim fixture barrier timeout");
}

async function spawnClaimChild(mode, rootDirectory, candidateId, expectedRevision, barrierDirectory, owner, attempt, now) {
  const child = spawn(
    process.execPath,
    [
      process.argv[1],
      `--claim-child=${mode}`,
      rootDirectory,
      candidateId,
      String(expectedRevision),
      barrierDirectory,
      owner,
      attempt,
      String(now),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", error => reject(new Error(`claim fixture child spawn failed: ${error.code ?? "unknown"}`)));
    child.once("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`claim child failed: ${stderr}`);
  if (stdout.trim().length === 0) {
    throw new Error(`claim fixture child produced empty stdout (exit ${exitCode}; stderr: ${stderr})`);
  }
  return JSON.parse(stdout.trim());
}

if (process.argv[2]?.startsWith("--claim-child=")) {
  const mode = process.argv[2].slice("--claim-child=".length);
  const rootDirectory = process.argv[3];
  const candidateId = process.argv[4];
  const expectedRevision = Number(process.argv[5]);
  const barrierDirectory = process.argv[6];
  const owner = process.argv[7];
  const attempt = process.argv[8];
  const now = Number(process.argv[9]);
  let runtime;
  if (mode === "hold-lock") {
    const fileSystem = Object.freeze({
      ...REAL_FILE_SYSTEM,
      writeFile: async (path, ...args) => {
        const result = await REAL_FILE_SYSTEM.writeFile(path, ...args);
        if (String(path).includes("/.cas-lock/owner-")) {
          await REAL_FILE_SYSTEM.writeFile(
            join(barrierDirectory, `lock-held-${process.pid}`),
            "lock-held\n",
            { encoding: "utf8", flag: "wx", mode: 0o600 },
          );
          const holdProcessOpen = setInterval(() => {}, 1_000);
          await new Promise(() => {});
          clearInterval(holdProcessOpen);
        }
        return result;
      },
    });
    runtime = runtimeFor(rootDirectory, { value: now }, { store: { fileSystem } });
  } else {
    runtime = runtimeFor(rootDirectory, { value: now });
  }
  const store = runtime.store;
  const service = runtime.claimLease;
  if (mode === "hold-lock") {
    await service.acquireClaimForDispatch({
      candidate_id: candidateId,
      expected_revision: expectedRevision,
      current_session_identity: owner,
      claim_attempt_id: attempt,
    });
  } else {
    await fileSystem.writeFile(
      join(barrierDirectory, `ready-${process.pid}`),
      "ready\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await waitForFile(join(barrierDirectory, "release"));
    const result = mode === "recover"
      ? await service.recoverClaimLease({ candidate_id: candidateId, expected_revision: expectedRevision })
      : await (mode === "claim-for-dispatch"
        ? service.acquireClaimForDispatch
        : service.acquireClaim)({
        candidate_id: candidateId,
        expected_revision: expectedRevision,
        current_session_identity: owner,
        claim_attempt_id: attempt,
      });
    await new Promise(resolve => process.stdout.write(`${JSON.stringify(result)}\n`, resolve));
  }
  process.exit(0);
}

await group("Claim/Lease API and dependency contract", async () => {
  await test("exposes a bounded Claim/Lease factory and deterministic failure taxonomy", () => {
    assert.equal(typeof createPendingHandoffClaimLeaseService, "function");
    for (const reason of [
      "claim_dependency_invalid",
      "claim_input_invalid",
      "claim_state_invalid",
      "claim_conflict",
      "claim_owner_invalid",
      "claim_attempt_invalid",
      "claim_time_invalid",
      "claim_lease_active",
      "claim_lease_expired",
      "claim_read_failed",
      "claim_publish_failed",
    ]) {
      assert.ok(PENDING_HANDOFF_CLAIM_LEASE_FAILURES.includes(reason));
    }
  });

  await test("requires Store state CAS, finite lease configuration, and an injected clock", () => {
    assertFailure(createPendingHandoffClaimLeaseService({}), "claim_dependency_invalid");
    assertFailure(createPendingHandoffClaimLeaseService({
      store: {},
      leaseDurationMs: 1_000,
      clock: () => 0,
    }), "claim_dependency_invalid");
    const unboundStore = Object.freeze({
      readState: async () => ({ ok: true, value: Object.freeze({}) }),
      compareAndSetState: async () => ({ ok: true, value: Object.freeze({ new_revision: 1 }) }),
    });
    assertFailure(createPendingHandoffClaimLeaseService({
      store: unboundStore,
      leaseDurationMs: 1_000,
      clock: () => 0,
    }), "claim_dependency_invalid");
  });

  await test("exposes only bounded domain operations over the Store state boundary", () => {
    const store = Object.freeze({
      readState: async () => ({ ok: true, value: Object.freeze({}) }),
      compareAndSetState: async () => ({ ok: true, value: Object.freeze({ new_revision: 1 }) }),
    });
    const mutationPort = Object.freeze({ compareAndSetState: store.compareAndSetState });
    const service = assertSuccess(createPendingHandoffClaimLeaseService({
      store,
      mutationPort,
      leaseDurationMs: 1_000,
      clock: () => BASE_NOW,
    }));
    assert.deepEqual(Reflect.ownKeys(service), [
      "acquireClaim",
      "acquireClaimForDispatch",
      "registerPending",
      "recoverClaimLease",
      "releaseClaimBeforeDelivery",
    ]);
  });
});

await group("explicit pending initialization and V2 policy", async () => {
  await test("keeps V2 candidate reads unchanged and explicitly registers V2 pending", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedCandidate(store, { candidate_id: "explicit-pending" });
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      const initial = assertSuccess(await store.readState(input.candidate_id));
      assert.deepEqual(initial, { candidate: input, state_revision: 0, claim: null });
      assert.equal(JSON.parse(before).envelope_version, PENDING_HANDOFF_REVISION_ENVELOPE_VERSION);

      assert.deepEqual(assertSuccess(await service.registerPending({
        candidate_id: input.candidate_id,
        expected_revision: 0,
      })), { state_revision: 1, status: "pending" });
      const pending = assertSuccess(await store.readState(input.candidate_id));
      assert.equal(pending.candidate.status, "pending");
      assert.equal(pending.state_revision, 1);
      assert.equal(pending.claim, null);
      const stored = await rawEnvelope(rootDirectory, input.candidate_id);
      assert.equal(stored.envelope_version, PENDING_HANDOFF_REVISION_ENVELOPE_VERSION);
      assert.equal(stored.state_revision, 1);
      assert.equal(Object.hasOwn(stored, "claim"), false);
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id) === before, false);
    });
  });

  await test("does not silently rewrite a V2 record on read", async () => {
    await withEnvironment(async ({ rootDirectory, store }) => {
      const input = await seedCandidate(store, { candidate_id: "no-read-migration" });
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      assert.deepEqual(assertSuccess(await store.readState(input.candidate_id)), {
        candidate: input,
        state_revision: 0,
        claim: null,
      });
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);
      assert.equal((await rawEnvelope(rootDirectory, input.candidate_id)).envelope_version,
        PENDING_HANDOFF_REVISION_ENVELOPE_VERSION);
    });
  });
});

await group("Claim success and exact metadata", async () => {
  await test("transitions pending to claimed with one revision and a bounded lease", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "claim-success" });
      const result = assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      assert.deepEqual(result, {
        state_revision: 2,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        claim_lease_expires_at: new Date(BASE_NOW + 1_000).toISOString(),
      });

      const state = assertSuccess(await store.readState(input.candidate_id));
      assert.equal(state.candidate.status, "claimed");
      assert.equal(state.state_revision, 2);
      assert.deepEqual(Object.keys(state.claim), [
        "claim_owner_identity",
        "claim_started_at",
        "claim_lease_expires_at",
        "claim_attempt_id",
      ]);
      assert.equal(state.claim.claim_owner_identity, OWNER_A);
      assert.equal(state.claim.claim_attempt_id, CLAIM_ATTEMPT_A);
      assert.equal(state.claim.claim_started_at, new Date(BASE_NOW).toISOString());
      assert.equal(Object.hasOwn(state.candidate, "claim_owner_identity"), false);
      assert.equal(Object.keys(state.candidate).length, 17);
      assert.deepEqual(assertSuccess(await store.read(input.candidate_id)), state.candidate);
      assert.deepEqual(assertSuccess(await store.readSnapshot(input.candidate_id)), {
        candidate: state.candidate,
        state_revision: 2,
      });

      const stored = await rawEnvelope(rootDirectory, input.candidate_id);
      assert.deepEqual(Object.keys(stored), [
        "envelope_version",
        "state_revision",
        "claim",
        "integrity",
        "candidate",
      ]);
      assert.equal(stored.envelope_version, PENDING_HANDOFF_CLAIM_ENVELOPE_VERSION);
      assert.deepEqual(Object.keys(stored.candidate), Object.keys(input));
      assert.equal(Object.hasOwn(stored.candidate, "state_revision"), false);
      assert.equal(Object.hasOwn(stored.candidate, "claim_attempt_id"), false);
      assert.equal(Date.parse(stored.claim.claim_started_at) < Date.parse(stored.claim.claim_lease_expires_at), true);
      assert.equal(Date.parse(stored.claim.claim_lease_expires_at) <= Date.parse(input.expires_at), true);
      assert.deepEqual(assertSuccess(verifyPendingHandoffClaimIntegrityEnvelope(
        stored,
        dependencies(),
      )), {
        candidate: state.candidate,
        state_revision: 2,
        claim: state.claim,
      });
    });
  });
});

await group("same-attempt idempotency and claim conflicts", async () => {
  await test("reuses the existing active Claim without a second publication", async () => {
    await withEnvironment(async ({ rootDirectory, store, service, clock }) => {
      const input = await seedPending(store, service, { candidate_id: "same-attempt-retry" });
      const first = assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      clock.value += 100;
      const retry = assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      assert.deepEqual(retry, first);
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);
      assert.equal(assertSuccess(await store.readState(input.candidate_id)).state_revision, 2);
    });
  });

  await test("binds same-attempt idempotency to the original expected revision", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "same-attempt-revision-binding" });
      const first = assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      const persisted = assertSuccess(await store.readState(input.candidate_id));
      assert.equal(persisted.state_revision, 2);
      assert.equal(first.state_revision, 2);

      const cases = [
        { label: "R-1", expected_revision: 1, ok: true },
        { label: "current R", expected_revision: 2, ok: false },
        { label: "older unrelated", expected_revision: 0, ok: false },
        { label: "future unrelated", expected_revision: 999, ok: false },
      ];
      for (const item of cases) {
        const result = await service.acquireClaim({
          candidate_id: input.candidate_id,
          expected_revision: item.expected_revision,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
        });
        if (item.ok) {
          assert.deepEqual(assertSuccess(result), first, item.label);
        } else {
          assertFailureWithoutLeak(result, "claim_conflict", [OWNER_A, CLAIM_ATTEMPT_A]);
        }
        assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before, item.label);
      }
      assert.deepEqual(assertSuccess(await store.readState(input.candidate_id)), persisted);
    });
  });

  await test("rejects a different attempt or owner without changing the active Claim", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "claim-conflicts" });
      assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      assertFailureWithoutLeak(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 2,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_B,
      }), "claim_conflict", [OWNER_A, CLAIM_ATTEMPT_A]);
      assertFailureWithoutLeak(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 2,
        current_session_identity: OWNER_B,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_conflict", [OWNER_A, CLAIM_ATTEMPT_A]);
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);
    });
  });

  await test("dispatch Claim rejects an existing same-attempt replay after restart or lost response", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "dispatch-claim-replay" });
      const request = {
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      };
      assertSuccess(await service.acquireClaimForDispatch(request));

      // A fresh service instance models process restart after the Claim persisted.
      const restartedService = runtimeFor(rootDirectory, { value: BASE_NOW }).claimLease;
      assertFailure(await restartedService.acquireClaimForDispatch(request), "claim_conflict");

      // The generic Claim operation keeps its pre-existing idempotent contract.
      assertSuccess(await restartedService.acquireClaim(request));
      assert.equal(assertSuccess(await store.readState(input.candidate_id)).state_revision, 2);
    });
  });
});

await group("Claim input, identity, and revision gates", async () => {
  await test("rejects source-session self-claim and malformed owner or attempt identities", async () => {
    await withEnvironment(async ({ store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "claim-input-gates" });
      assertFailure(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: SOURCE_SESSION_IDENTITY,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_owner_invalid");
      for (const attempt of [
        "not-an-attempt",
        CLAIM_ATTEMPT_A.toUpperCase(),
        "11111111-1111-5111-8111-111111111111",
        null,
        42,
      ]) {
        assertFailure(await service.acquireClaim({
          candidate_id: input.candidate_id,
          expected_revision: 1,
          current_session_identity: OWNER_A,
          claim_attempt_id: attempt,
        }), typeof attempt === "string" && attempt.includes("-")
          ? "claim_attempt_invalid"
          : "claim_input_invalid");
      }
      assertFailure(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: "raw-native-session-id",
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_owner_invalid");
    });
  });

  await test("rejects stale and future expected revisions without mutation", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "claim-revision-gates" });
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      assertFailure(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 0,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_conflict");
      assertFailure(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 2,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_conflict");
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);
    });
  });

  await test("fails closed for malformed service requests and dependency clock output", async () => {
    await withEnvironment(async ({ store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "claim-request-shapes" });
      assertFailure(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        extra: true,
      }), "claim_input_invalid");
      const invalidClock = assertSuccess(createPendingHandoffClaimLeaseService({
        store,
        mutationPort: Object.freeze({ compareAndSetState: async () => ({ ok: true, value: Object.freeze({ new_revision: 1 }) }) }),
        leaseDurationMs: 1_000,
        clock: () => NaN,
      }));
      assertFailure(await invalidClock.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_time_invalid");
    });
  });
});

await group("concurrent Claim exact-one", async () => {
  await test("allows exactly one independent process to claim the same pending revision", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "claim-process-race" });
      const barrierDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-claim-barrier-"));
      try {
        const first = spawnClaimChild(
          "claim",
          rootDirectory,
          input.candidate_id,
          1,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          BASE_NOW,
        );
        const second = spawnClaimChild(
          "claim",
          rootDirectory,
          input.candidate_id,
          1,
          barrierDirectory,
          OWNER_B,
          CLAIM_ATTEMPT_B,
          BASE_NOW,
        );
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const entries = await fileSystem.readdir(barrierDirectory);
          if (entries.filter(entry => entry.startsWith("ready-")).length === 2) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const ready = await fileSystem.readdir(barrierDirectory);
        assert.equal(ready.filter(entry => entry.startsWith("ready-")).length, 2);
        await fileSystem.writeFile(join(barrierDirectory, "release"), "release\n", "utf8");
        const outcomes = await Promise.all([first, second]);
        assert.equal(outcomes.filter(result => result.ok).length, 1, JSON.stringify(outcomes));
        assert.equal(
          outcomes.filter(result => result.reason === "claim_conflict").length,
          1,
          JSON.stringify(outcomes),
        );
        const final = assertSuccess(await store.readState(input.candidate_id));
        assert.equal(final.state_revision, 2);
        assert.equal(final.candidate.status, "claimed");
        const winnerPair = [final.claim.claim_owner_identity, final.claim.claim_attempt_id];
        assert.ok(
          (winnerPair[0] === OWNER_A && winnerPair[1] === CLAIM_ATTEMPT_A)
          || (winnerPair[0] === OWNER_B && winnerPair[1] === CLAIM_ATTEMPT_B),
          JSON.stringify(winnerPair),
        );
        assert.equal(final.claim.claim_lease_expires_at, new Date(BASE_NOW + 1_000).toISOString());
        assert.deepEqual(assertSuccess(verifyPendingHandoffClaimIntegrityEnvelope(
          await rawEnvelope(rootDirectory, input.candidate_id),
          dependencies(),
        )), {
          candidate: final.candidate,
          state_revision: final.state_revision,
          claim: final.claim,
        });
      } finally {
        await fileSystem.rm(barrierDirectory, { recursive: true, force: true });
      }
    });
  });

  await test("only one independent process gets dispatch authority for the same attempt", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "same-attempt-dispatch-process-race" });
      const barrierDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-dispatch-race-barrier-"));
      try {
        const first = spawnClaimChild(
          "claim-for-dispatch",
          rootDirectory,
          input.candidate_id,
          1,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          BASE_NOW,
        );
        const second = spawnClaimChild(
          "claim-for-dispatch",
          rootDirectory,
          input.candidate_id,
          1,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          BASE_NOW,
        );
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const entries = await fileSystem.readdir(barrierDirectory);
          if (entries.filter(entry => entry.startsWith("ready-")).length === 2) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const ready = await fileSystem.readdir(barrierDirectory);
        assert.equal(ready.filter(entry => entry.startsWith("ready-")).length, 2);
        await fileSystem.writeFile(join(barrierDirectory, "release"), "release\n", "utf8");

        const outcomes = await Promise.all([first, second]);
        assert.equal(outcomes.filter(result => result.ok).length, 1, JSON.stringify(outcomes));
        assert.equal(outcomes.filter(result => result.reason === "claim_conflict").length, 1, JSON.stringify(outcomes));
        const final = assertSuccess(await store.readState(input.candidate_id));
        assert.equal(final.state_revision, 2);
        assert.equal(final.candidate.status, "claimed");
        assert.equal(final.claim.claim_owner_identity, OWNER_A);
        assert.equal(final.claim.claim_attempt_id, CLAIM_ATTEMPT_A);
        const restarted = await spawnClaimChild(
          "claim-for-dispatch",
          rootDirectory,
          input.candidate_id,
          1,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          BASE_NOW,
        );
        assert.deepEqual(
          restarted,
          Object.freeze({ ok: false, reason: "claim_conflict" }),
          `restarted same-attempt dispatch must fail closed: ${JSON.stringify(restarted)}`,
        );
      } finally {
        await fileSystem.rm(barrierDirectory, { recursive: true, force: true });
      }
    });
  });

  await test("recovers a Store lock after its owning process is terminated before Claim publication", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "claim-lock-owner-termination" });
      const barrierDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-claim-lock-owner-barrier-"));
      let child;
      try {
        child = spawn(process.execPath, [
          process.argv[1],
          "--claim-child=hold-lock",
          rootDirectory,
          input.candidate_id,
          "1",
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          String(BASE_NOW),
        ], { stdio: ["ignore", "pipe", "pipe"] });
        const heldLockPath = join(barrierDirectory, `lock-held-${child.pid}`);
        const ready = await Promise.race([
          waitForFile(heldLockPath).then(() => null),
          new Promise(resolve => child.once("error", error => resolve(error))),
        ]);
        if (ready !== null) throw new Error(`claim lock child spawn failed: ${ready.code ?? "unknown"}`);
        assert.equal(child.kill("SIGKILL"), true);
        const exit = await new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
        assert.equal(exit.signal, "SIGKILL");

        const recovered = assertSuccess(await service.acquireClaimForDispatch({
          candidate_id: input.candidate_id,
          expected_revision: 1,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
        }));
        assert.equal(recovered.state_revision, 2);
        assert.equal(assertSuccess(await store.readState(input.candidate_id)).candidate.status, "claimed");
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await fileSystem.rm(barrierDirectory, { recursive: true, force: true });
      }
    });
  });

  await test("an expired Claim blocks dispatch until explicit recovery is separately authorized", async () => {
    await withEnvironment(async ({ store, service, clock }) => {
      const input = await seedPending(store, service, { candidate_id: "expired-dispatch-claim" });
      const claimed = assertSuccess(await service.acquireClaimForDispatch({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      clock.value = Date.parse(claimed.claim_lease_expires_at);
      assertFailure(await service.acquireClaimForDispatch({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_lease_expired");
      assert.equal(assertSuccess(await store.readState(input.candidate_id)).state_revision, 2);
    });
  });
});

await group("finite Lease boundaries and recovery", async () => {
  await test("keeps an active lease exclusive and recovers exactly at its expiry boundary", async () => {
    await withEnvironment(async ({ rootDirectory, store, service, clock }) => {
      const input = await seedPending(store, service, { candidate_id: "lease-boundary" });
      const claimed = assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      clock.value = BASE_NOW + 999;
      assertFailure(await service.recoverClaimLease({
        candidate_id: input.candidate_id,
        expected_revision: claimed.state_revision,
      }), "claim_lease_active");
      assertFailure(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: claimed.state_revision,
        current_session_identity: OWNER_B,
        claim_attempt_id: CLAIM_ATTEMPT_B,
      }), "claim_conflict");
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);

      clock.value = Date.parse(claimed.claim_lease_expires_at);
      assert.deepEqual(assertSuccess(await service.recoverClaimLease({
        candidate_id: input.candidate_id,
        expected_revision: claimed.state_revision,
      })), { state_revision: 3, status: "pending" });
      const recovered = assertSuccess(await store.readState(input.candidate_id));
      assert.equal(recovered.candidate.status, "pending");
      assert.equal(recovered.claim, null);
      assert.equal(recovered.state_revision, 3);

      assert.deepEqual(assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 3,
        current_session_identity: OWNER_B,
        claim_attempt_id: CLAIM_ATTEMPT_B,
      })).state_revision, 4);
      assert.equal(assertSuccess(await store.readState(input.candidate_id)).candidate.status, "claimed");
    });
  });

  await test("gives Candidate TTL precedence over a longer finite Lease", async () => {
    await withEnvironment(async ({ store, service, clock }) => {
      const input = await seedPending(store, service, {
        candidate_id: "ttl-precedence",
        expires_at: new Date(BASE_NOW + 500).toISOString(),
      });
      const claimed = assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      assert.equal(claimed.claim_lease_expires_at, input.expires_at);
      clock.value = Date.parse(input.expires_at);
      assert.deepEqual(assertSuccess(await service.recoverClaimLease({
        candidate_id: input.candidate_id,
        expected_revision: claimed.state_revision,
      })), { state_revision: 3, status: "expired" });
      const expired = assertSuccess(await store.readState(input.candidate_id));
      assert.equal(expired.candidate.status, "expired");
      assert.equal(expired.claim, null);
    }, { leaseDurationMs: 5_000 });
  });

  await test("rejects lease recovery before expiry and malformed persisted lease times", async () => {
    await withEnvironment(async ({ rootDirectory, store, service, clock }) => {
      const input = await seedClaim(store, service, clock, { candidate_id: "lease-tamper-time" });
      const stored = await rawEnvelope(rootDirectory, input.input.candidate_id);
      stored.claim.claim_lease_expires_at = "not-a-timestamp";
      await writeRawEnvelope(rootDirectory, input.input.candidate_id, stored);
      assertFailure(await service.recoverClaimLease({
        candidate_id: input.input.candidate_id,
        expected_revision: input.result.state_revision,
      }), "claim_state_invalid");
    });
  });
});

await group("concurrent Lease recovery", async () => {
  await test("publishes one recovery revision when independent processes recover an expired Lease", async () => {
    await withEnvironment(async ({ rootDirectory, store, service, clock }) => {
      const input = await seedPending(store, service, { candidate_id: "lease-recovery-race" });
      const claimed = assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      const barrierDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-recovery-barrier-"));
      const expiry = Date.parse(claimed.claim_lease_expires_at);
      clock.value = expiry;
      try {
        const first = spawnClaimChild(
          "recover",
          rootDirectory,
          input.candidate_id,
          claimed.state_revision,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          expiry,
        );
        const second = spawnClaimChild(
          "recover",
          rootDirectory,
          input.candidate_id,
          claimed.state_revision,
          barrierDirectory,
          OWNER_B,
          CLAIM_ATTEMPT_B,
          expiry,
        );
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const entries = await fileSystem.readdir(barrierDirectory);
          if (entries.filter(entry => entry.startsWith("ready-")).length === 2) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const ready = await fileSystem.readdir(barrierDirectory);
        assert.equal(ready.filter(entry => entry.startsWith("ready-")).length, 2);
        await fileSystem.writeFile(join(barrierDirectory, "release"), "release\n", "utf8");
        const outcomes = await Promise.all([first, second]);
        assert.equal(outcomes.filter(result => result.ok).length, 1);
        assert.equal(outcomes.filter(result => result.reason === "claim_conflict").length, 1);
        const final = assertSuccess(await store.readState(input.candidate_id));
        assert.equal(final.state_revision, 3);
        assert.equal(final.candidate.status, "pending");
        assert.equal(final.claim, null);
      } finally {
        await fileSystem.rm(barrierDirectory, { recursive: true, force: true });
      }
    });
  });

  await test("publishes exactly one expired state when concurrent recovery observes expired Candidate TTL", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, {
        candidate_id: "ttl-expired-recovery-race",
        expires_at: new Date(BASE_NOW + 500).toISOString(),
      });
      const claimed = assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      const expiry = Date.parse(input.expires_at);
      assert.equal(claimed.claim_lease_expires_at, input.expires_at);
      const barrierDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-ttl-recovery-barrier-"));
      try {
        const first = spawnClaimChild(
          "recover",
          rootDirectory,
          input.candidate_id,
          claimed.state_revision,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          expiry,
        );
        const second = spawnClaimChild(
          "recover",
          rootDirectory,
          input.candidate_id,
          claimed.state_revision,
          barrierDirectory,
          OWNER_B,
          CLAIM_ATTEMPT_B,
          expiry,
        );
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const entries = await fileSystem.readdir(barrierDirectory);
          if (entries.filter(entry => entry.startsWith("ready-")).length === 2) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const ready = await fileSystem.readdir(barrierDirectory);
        assert.equal(ready.filter(entry => entry.startsWith("ready-")).length, 2);
        await fileSystem.writeFile(join(barrierDirectory, "release"), "release\n", "utf8");
        const outcomes = await Promise.all([first, second]);
        assert.equal(outcomes.filter(result => result.ok).length, 1, JSON.stringify(outcomes));
        assert.equal(outcomes.filter(result => result.reason === "claim_conflict").length, 1, JSON.stringify(outcomes));
        const final = assertSuccess(await store.readState(input.candidate_id));
        assert.equal(final.state_revision, claimed.state_revision + 1);
        assert.equal(final.candidate.status, "expired");
        assert.equal(final.claim, null);
      } finally {
        await fileSystem.rm(barrierDirectory, { recursive: true, force: true });
      }
    });
  });
});

await group("Release before Delivery", async () => {
  await test("releases an active Claim only for the exact owner and attempt", async () => {
    await withEnvironment(async ({ store, service, clock }) => {
      const input = await seedPending(store, service, { candidate_id: "release-before-delivery" });
      const claimed = assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      assert.deepEqual(assertSuccess(await service.releaseClaimBeforeDelivery({
        candidate_id: input.candidate_id,
        expected_revision: claimed.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      })), { state_revision: 3, status: "pending" });
      const state = assertSuccess(await store.readState(input.candidate_id));
      assert.equal(state.candidate.status, "pending");
      assert.equal(state.claim, null);
      assert.equal(clock.value, BASE_NOW);
    });
  });

  await test("rejects wrong-owner, wrong-attempt, and stale-owner release without mutation", async () => {
    await withEnvironment(async ({ rootDirectory, store, service, clock }) => {
      const input = await seedPending(store, service, { candidate_id: "release-conflicts" });
      const claimed = assertSuccess(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      assertFailure(await service.releaseClaimBeforeDelivery({
        candidate_id: input.candidate_id,
        expected_revision: claimed.state_revision,
        current_session_identity: OWNER_B,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_conflict");
      assertFailure(await service.releaseClaimBeforeDelivery({
        candidate_id: input.candidate_id,
        expected_revision: claimed.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_B,
      }), "claim_conflict");
      clock.value = Date.parse(claimed.claim_lease_expires_at);
      assertFailure(await service.releaseClaimBeforeDelivery({
        candidate_id: input.candidate_id,
        expected_revision: claimed.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_lease_expired");
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);
    });
  });
});

await group("Claim Integrity and metadata binding", async () => {
  await test("rejects tampered revision and each Claim metadata field before domain use", async () => {
    const mutations = [
      ["revision", envelope => { envelope.state_revision += 1; }],
      ["owner", envelope => { envelope.claim.claim_owner_identity = OWNER_B; }],
      ["started", envelope => { envelope.claim.claim_started_at = new Date(BASE_NOW + 1).toISOString(); }],
      ["lease", envelope => { envelope.claim.claim_lease_expires_at = new Date(BASE_NOW + 2_000).toISOString(); }],
      ["attempt", envelope => { envelope.claim.claim_attempt_id = CLAIM_ATTEMPT_B; }],
      ["candidate-status", envelope => { envelope.candidate.status = "pending"; }],
    ];
    for (const [label, mutate] of mutations) {
      await withEnvironment(async ({ rootDirectory, store, service }) => {
        const seeded = await seedClaim(store, service, { value: BASE_NOW }, {
          candidate_id: `claim-tamper-${label}`,
        });
        const envelope = await rawEnvelope(rootDirectory, seeded.input.candidate_id);
        mutate(envelope);
        await writeRawEnvelope(rootDirectory, seeded.input.candidate_id, envelope);
        const read = await store.readState(seeded.input.candidate_id);
        assertFailure(read, label === "candidate-status"
          ? "record_integrity_invalid"
          : "record_integrity_mismatch");
        assertFailureWithoutLeak(await service.recoverClaimLease({
          candidate_id: seeded.input.candidate_id,
          expected_revision: seeded.result.state_revision,
        }), "claim_state_invalid", [OWNER_A, OWNER_B, CLAIM_ATTEMPT_A, CLAIM_ATTEMPT_B]);
      });
    }
  });

  await test("rejects extra Claim fields and impossible pending-with-Claim state", async () => {
    const mutations = [
      envelope => { envelope.claim.extra = true; },
      envelope => { envelope.candidate.status = "pending"; },
      envelope => { envelope.delivery_confirmed = false; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      await withEnvironment(async ({ rootDirectory, store, service }) => {
        const seeded = await seedClaim(store, service, { value: BASE_NOW }, {
          candidate_id: `claim-impossible-${index}`,
        });
        const envelope = await rawEnvelope(rootDirectory, seeded.input.candidate_id);
        mutate(envelope);
        await writeRawEnvelope(rootDirectory, seeded.input.candidate_id, envelope);
        assertFailure(await store.readState(seeded.input.candidate_id), "record_integrity_invalid");
        assertFailureWithoutLeak(await service.acquireClaim({
          candidate_id: seeded.input.candidate_id,
          expected_revision: seeded.result.state_revision,
          current_session_identity: OWNER_B,
          claim_attempt_id: CLAIM_ATTEMPT_B,
        }), "claim_state_invalid", [OWNER_A, OWNER_B, CLAIM_ATTEMPT_A, CLAIM_ATTEMPT_B]);
      });
    }
  });

  await test("rejects a cross-record Claim metadata swap", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const first = await seedClaim(store, service, { value: BASE_NOW }, { candidate_id: "claim-swap-a" });
      const secondInput = await seedPending(store, service, { candidate_id: "claim-swap-b" });
      const secondResult = assertSuccess(await service.acquireClaim({
        candidate_id: secondInput.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_B,
        claim_attempt_id: CLAIM_ATTEMPT_B,
      }));
      const firstEnvelope = await rawEnvelope(rootDirectory, first.input.candidate_id);
      const secondEnvelope = await rawEnvelope(rootDirectory, secondInput.candidate_id);
      firstEnvelope.claim = secondEnvelope.claim;
      await writeRawEnvelope(rootDirectory, first.input.candidate_id, firstEnvelope);
      assertFailureWithoutLeak(
        await store.readState(first.input.candidate_id),
        "record_integrity_mismatch",
        [OWNER_A, OWNER_B, CLAIM_ATTEMPT_A, CLAIM_ATTEMPT_B],
      );
      assert.equal(assertSuccess(await store.readState(secondInput.candidate_id)).state_revision,
        secondResult.state_revision);
    });
  });
});

await group("State CAS binding and unconditional-write policy", async () => {
  await test("binds next-state Candidate identity to the requested record", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "state-candidate-binding" });
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      const state = assertSuccess(await store.readState(input.candidate_id));
      assert.equal(typeof store.compareAndSetState, "undefined");
      assertFailure(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: state.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        next_state: { candidate: { ...state.candidate, candidate_id: "different-record" } },
      }), "claim_input_invalid");
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);
      assert.equal(assertSuccess(await store.readState(input.candidate_id)).state_revision, 1);
    });
  });

  await test("rejects caller-injected persistence fields and preserves the state", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "state-field-injection" });
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      const state = assertSuccess(await store.readState(input.candidate_id));
      assertFailure(await service.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: state.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        state_revision: 99,
      }), "claim_input_invalid");
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);
    });
  });

  await test("keeps unconditional write initial-only after pending registration", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "initial-only-write" });
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      assertFailure(await store.write(input), "record_exists");
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);
    });
  });
});

await group("Claim CAS publication fault boundaries", async () => {
  await test("preserves the previous Claim state when temp publication fails before write", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "claim-pre-publication-failure" });
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      const previous = assertSuccess(await store.readState(input.candidate_id));
      const failingFileSystem = {
        ...REAL_FILE_SYSTEM,
        writeFile: async (location, ...args) => {
          if (String(location).includes(".record-")) {
            throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
          }
          return REAL_FILE_SYSTEM.writeFile(location, ...args);
        },
      };
      const failingRuntime = runtimeFor(rootDirectory, { value: BASE_NOW }, {
        store: { fileSystem: failingFileSystem },
      });
      const failingStore = failingRuntime.store;
      const failingService = failingRuntime.claimLease;
      assertFailureWithoutLeak(await failingService.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_publish_failed", [OWNER_A, CLAIM_ATTEMPT_A]);
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);
      assert.deepEqual(assertSuccess(await store.readState(input.candidate_id)), previous);
      assert.deepEqual(await fileSystem.readdir(join(rootDirectory, keyFor(input.candidate_id))), ["record.json"]);
    });
  });

  await test("preserves the previous Claim state when atomic rename fails", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "claim-rename-failure" });
      const before = await rawEnvelopeText(rootDirectory, input.candidate_id);
      const failingFileSystem = {
        ...REAL_FILE_SYSTEM,
        rename: async (source, target) => {
          if (String(source).includes(".record-")) {
            throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
          }
          return REAL_FILE_SYSTEM.rename(source, target);
        },
      };
      const failingRuntime = runtimeFor(rootDirectory, { value: BASE_NOW }, {
        store: { fileSystem: failingFileSystem },
      });
      const failingStore = failingRuntime.store;
      const failingService = failingRuntime.claimLease;
      assertFailureWithoutLeak(await failingService.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_publish_failed", [OWNER_A, CLAIM_ATTEMPT_A]);
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), before);
      assert.deepEqual(await fileSystem.readdir(join(rootDirectory, keyFor(input.candidate_id))), ["record.json"]);
      assert.equal(assertSuccess(await store.readState(input.candidate_id)).state_revision, 1);
    });
  });

  await test("keeps a published Claim successful when post-publication lock cleanup fails", async () => {
    await withEnvironment(async ({ rootDirectory, store, service }) => {
      const input = await seedPending(store, service, { candidate_id: "claim-post-publication-cleanup" });
      const failingFileSystem = {
        ...REAL_FILE_SYSTEM,
        unlink: async location => {
          if (String(location).includes(".cas-lock") && String(location).includes("owner-")) {
            throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
          }
          return REAL_FILE_SYSTEM.unlink(location);
        },
      };
      const failingRuntime = runtimeFor(rootDirectory, { value: BASE_NOW }, {
        store: { fileSystem: failingFileSystem },
      });
      const failingStore = failingRuntime.store;
      const failingService = failingRuntime.claimLease;
      const first = assertSuccess(await failingService.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      assert.equal(first.state_revision, 2);
      const published = await rawEnvelopeText(rootDirectory, input.candidate_id);
      const state = assertSuccess(await failingStore.readState(input.candidate_id));
      assert.equal(state.state_revision, 2);
      assert.equal(state.candidate.status, "claimed");
      assert.equal(state.claim.claim_owner_identity, OWNER_A);
      assert.equal(state.claim.claim_attempt_id, CLAIM_ATTEMPT_A);

      const retry = assertSuccess(await failingService.acquireClaim({
        candidate_id: input.candidate_id,
        expected_revision: 1,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }));
      assert.deepEqual(retry, first);
      assert.equal(await rawEnvelopeText(rootDirectory, input.candidate_id), published);
    });
  });
});

await group("Lease configuration, expiry, and privacy boundaries", async () => {
  await test("requires a positive finite safe lease duration and an injected clock", () => {
    for (const leaseDurationMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assertFailure(createPendingHandoffClaimLeaseService({
        store: {},
        leaseDurationMs,
        clock: () => BASE_NOW,
      }), "claim_dependency_invalid");
    }
    assertFailure(createPendingHandoffClaimLeaseService({
      store: {},
      leaseDurationMs: 1_000,
    }), "claim_dependency_invalid");
  });

  await test("does not auto-reclaim an exactly expired lease during Claim retry", async () => {
    await withEnvironment(async ({ rootDirectory, store, service, clock }) => {
      const seeded = await seedClaim(store, service, clock, { candidate_id: "expired-retry" });
      const before = await rawEnvelopeText(rootDirectory, seeded.input.candidate_id);
      clock.value = Date.parse(seeded.result.claim_lease_expires_at);
      assertFailure(await service.acquireClaim({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.result.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_lease_expired");
      assert.equal(await rawEnvelopeText(rootDirectory, seeded.input.candidate_id), before);
    });
  });

  await test("rejects stale Lease recovery without changing the claimed revision", async () => {
    await withEnvironment(async ({ rootDirectory, store, service, clock }) => {
      const seeded = await seedClaim(store, service, clock, { candidate_id: "stale-recovery" });
      const before = await rawEnvelopeText(rootDirectory, seeded.input.candidate_id);
      assertFailure(await service.recoverClaimLease({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.result.state_revision - 1,
      }), "claim_conflict");
      assert.equal(await rawEnvelopeText(rootDirectory, seeded.input.candidate_id), before);
    });
  });

  await test("expires a pending Candidate before Claim when its TTL is at the boundary", async () => {
    await withEnvironment(async ({ store, service }) => {
      const input = await seedCandidate(store, {
        candidate_id: "pending-ttl-boundary",
        expires_at: new Date(BASE_NOW).toISOString(),
      });
      assertFailure(await service.registerPending({
        candidate_id: input.candidate_id,
        expected_revision: 0,
      }), "claim_time_invalid");
      const state = assertSuccess(await store.readState(input.candidate_id));
      assert.equal(state.candidate.status, "expired");
      assert.equal(state.state_revision, 1);
      assert.equal(state.claim, null);
    });
  });

  await test("redacts Store exceptions at the Claim boundary", async () => {
    const markerStore = Object.freeze({
      readState: async () => { throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`); },
      compareAndSetState: async () => { throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`); },
    });
    const mutationPort = Object.freeze({ compareAndSetState: markerStore.compareAndSetState });
    const service = assertSuccess(createPendingHandoffClaimLeaseService({
      store: markerStore,
      mutationPort,
      leaseDurationMs: 1_000,
      clock: () => BASE_NOW,
    }));
    assertFailureWithoutLeak(await service.acquireClaim({
      candidate_id: "privacy-boundary",
      expected_revision: 0,
      current_session_identity: OWNER_A,
      claim_attempt_id: CLAIM_ATTEMPT_A,
    }), "claim_read_failed", [EXCEPTION_MARKER, PRIVATE_MARKER]);
  });

  await test("keeps filesystem arbitration and Delivery/Consumption outside the domain service", () => {
    assert.doesNotMatch(SOURCE, /randomUUID|\.cas-lock|owner_pid/);
    assert.doesNotMatch(SOURCE, /delivery_attempted|delivery_confirmed|consumed/);
    assert.match(SOURCE, /compareAndSetState/);
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS\n`);
