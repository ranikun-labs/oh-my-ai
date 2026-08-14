import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fileSystem from "node:fs/promises";
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
  PENDING_HANDOFF_INTEGRITY_PROVIDER_VERSION,
  PENDING_HANDOFF_INTEGRITY_ALGORITHM,
  PENDING_HANDOFF_INTEGRITY_PURPOSE,
  PENDING_HANDOFF_DELIVERY_ENVELOPE_VERSION,
  verifyPendingHandoffDeliveryIntegrityEnvelope,
  verifyPendingHandoffClaimIntegrityEnvelope,
} from "./lib/pending-handoff-integrity.mjs";
let deliveryModule = null;
try {
  deliveryModule = await import("./lib/pending-handoff-delivery-consumption.mjs");
} catch {
  // The first API assertion reports the missing Delivery/Consumption boundary.
}

const {
  createPendingHandoffDeliveryConsumptionService,
  PENDING_HANDOFF_DELIVERY_CONSUMPTION_FAILURES,
  PENDING_HANDOFF_DELIVERY_DIGEST_PURPOSE,
} = deliveryModule ?? {};

const SOURCE = readSource("./lib/pending-handoff-delivery-consumption.mjs");
const MAKEFILE_SOURCE = readSource("../Makefile");
const SOURCE_SESSION_IDENTITY = `phr1.session.key_A-1.${"S".repeat(43)}`;
const OWNER_A = `phr1.session.key_A-1.${"A".repeat(43)}`;
const OWNER_B = `phr1.session.key_A-1.${"B".repeat(43)}`;
const REPOSITORY_IDENTITY = `phr1.repository.key_A-1.${"R".repeat(43)}`;
const WORKTREE_IDENTITY = `phr1.worktree.key_A-1.${"W".repeat(43)}`;
const CURRENT_KEY_ID = "integrity_current";
const PREVIOUS_KEY_ID = "integrity_previous";
const PRIVATE_MARKER = "delivery-private-marker";
const EXCEPTION_MARKER = "delivery-exception-marker";
const KEY_MATERIAL = Object.freeze({
  [CURRENT_KEY_ID]: "delivery-current-integrity-secret",
  [PREVIOUS_KEY_ID]: "delivery-previous-integrity-secret",
});
const BASE_NOW = Date.parse("2026-08-01T01:00:00.000Z");
const DEFAULT_EXPIRY = Date.parse("2026-08-01T02:00:00.000Z");
const CLAIM_ATTEMPT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ATTEMPT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DELIVERY_ATTEMPT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DELIVERY_ATTEMPT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EVIDENCE_ID_A = "ev-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const EVIDENCE_ID_B = "ev-ffffffff-ffff-4fff-8fff-ffffffffffff";
const SAFE_RUNTIME_ID = "test-runtime";
const SAFE_ADAPTER_VERSION = "1.0.0";
const DELIVERY_DIGEST_A = createHmac("sha256", "delivery-candidate-secret")
  .update("candidate-A")
  .digest("base64url");

let groups = 0;
let tests = 0;

function readSource(relativePath) {
  try {
    return requireSource(fileURLToPath(new URL(relativePath, import.meta.url)));
  } catch {
    return "";
  }
}

function requireSource(location) {
  return readFileSync(location, "utf8");
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
    candidate_id: "delivery-candidate-001",
    schema_version: PENDING_HANDOFF_SCHEMA_VERSION,
    status: "candidate",
    created_at: "2026-08-01T00:00:00.000Z",
    expires_at: new Date(DEFAULT_EXPIRY).toISOString(),
    source_runtime: "codex",
    source_session_identity: SOURCE_SESSION_IDENTITY,
    repository_identity: REPOSITORY_IDENTITY,
    worktree_identity: WORKTREE_IDENTITY,
    goal: "Deliver one verified candidate and consume it once.",
    completed: ["The candidate was canonicalized."],
    open_issues: [],
    verification: ["Delivery evidence is verified through an injected port."],
    do_not_touch: ["Runtime adapters and session resolution."],
    next_action: "Confirm delivery and consume the evidence once.",
    context_checkpoint_status: "review_needed",
    privacy_redaction_status: "passed",
    ...overrides,
  };
}

function buildIntegrityProvider(overrides = {}) {
  const keyedDigest = overrides.keyed_digest ?? (({ key_id, purpose, bytes }) => {
    const secret = KEY_MATERIAL[key_id];
    if (secret === undefined || purpose !== PENDING_HANDOFF_INTEGRITY_PURPOSE) {
      throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
    }
    return createHmac("sha256", secret).update(Buffer.from(bytes)).digest("base64url");
  });
  return Object.freeze({
    version: PENDING_HANDOFF_INTEGRITY_PROVIDER_VERSION,
    current_key_id: CURRENT_KEY_ID,
    verification_key_ids: Object.freeze([CURRENT_KEY_ID, PREVIOUS_KEY_ID]),
    keyed_digest: Object.freeze(keyedDigest),
    safe_equal: Object.freeze((left, right) => left === right),
  });
}

function buildDeliveryDigest({ purpose, bytes }) {
  assert.equal(purpose, PENDING_HANDOFF_DELIVERY_DIGEST_PURPOSE);
  return createHmac("sha256", "delivery-candidate-secret")
    .update(Buffer.from(bytes))
    .digest("base64url");
}

function buildEvidenceVerifier({ expected, evidence }) {
  if (evidence === PRIVATE_MARKER) throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
  return {
    verification: "passed",
    evidence_id: evidence?.evidence_id ?? EVIDENCE_ID_A,
    candidate_id: expected.candidate_id,
    candidate_digest: expected.delivery_candidate_digest,
    current_session_identity: expected.current_session_identity,
    claim_attempt_id: expected.claim_attempt_id,
    delivery_attempt_id: expected.delivery_attempt_id,
    runtime: evidence?.runtime ?? SAFE_RUNTIME_ID,
    adapter_version: evidence?.adapter_version ?? SAFE_ADAPTER_VERSION,
    injection_surface_accepted: true,
    candidate_available: true,
    confirmed_at: evidence?.confirmed_at ?? new Date(BASE_NOW + 100).toISOString(),
  };
}

function dependencies(overrides = {}) {
  return {
    deliveryCandidateDigest: Object.freeze(overrides.deliveryCandidateDigest ?? buildDeliveryDigest),
    deliveryEvidenceVerifier: Object.freeze(overrides.deliveryEvidenceVerifier ?? buildEvidenceVerifier),
  };
}

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

function storeOptions(rootDirectory, overrides = {}) {
  return {
    rootDirectory,
    integrityProvider: buildIntegrityProvider(),
    ...overrides,
  };
}

const RUNTIME_BUILDERS = new WeakMap();

function registerRuntime(rootDirectory, clock, storeOverrides = {}) {
  const baseOptions = storeOptions(rootDirectory, storeOverrides);
  const builder = (overrides = {}) => {
    const { clock: clockOverride, ...dependencyOverrides } = overrides;
    return assertSuccess(createPendingHandoffRuntime({
      ...baseOptions,
      leaseDurationMs: 1_000,
      clock: clockOverride ?? (() => clock.value),
      ...dependencies(dependencyOverrides),
    }));
  };
  const runtime = builder();
  RUNTIME_BUILDERS.set(runtime.store, builder);
  return runtime;
}

function createService(store, clock, overrides = {}) {
  const builder = RUNTIME_BUILDERS.get(store);
  assert.ok(builder, "fixture store must come from the lexical runtime composition");
  return builder(overrides).deliveryConsumption;
}

async function withEnvironment(operation, options = {}) {
  const rootDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-delivery-fixture-"));
  const clock = { value: options.now ?? BASE_NOW };
  try {
    const runtime = registerRuntime(rootDirectory, clock, options.store ?? {});
    return await operation({ rootDirectory, store: runtime.store, runtime, clock });
  } finally {
    await fileSystem.rm(rootDirectory, { recursive: true, force: true });
  }
}

async function seedClaim(store, rootDirectory, candidateOverrides = {}, claimClock = () => BASE_NOW) {
  const input = candidate(candidateOverrides);
  assertSuccess(await store.write(input));
  const builder = RUNTIME_BUILDERS.get(store);
  assert.ok(builder, "fixture store must come from the lexical runtime composition");
  const claimService = builder().claimLease;
  assertSuccess(await claimService.registerPending({
    candidate_id: input.candidate_id,
    expected_revision: 0,
  }));
  const claimed = assertSuccess(await claimService.acquireClaim({
    candidate_id: input.candidate_id,
    expected_revision: 1,
    current_session_identity: OWNER_A,
    claim_attempt_id: CLAIM_ATTEMPT_A,
  }));
  return { input, claimed, claimService, rootDirectory };
}

async function seedAttempt(store, rootDirectory, clock, candidateOverrides = {}) {
  const seeded = await seedClaim(store, rootDirectory, candidateOverrides, () => clock.value);
  const service = createService(store, clock);
  const attempt = assertSuccess(await service.beginDeliveryAttempt({
    candidate_id: seeded.input.candidate_id,
    expected_revision: seeded.claimed.state_revision,
    current_session_identity: OWNER_A,
    claim_attempt_id: CLAIM_ATTEMPT_A,
    delivery_attempt_id: DELIVERY_ATTEMPT_A,
  }));
  return { ...seeded, service, attempt };
}

async function seedDelivered(store, rootDirectory, clock, candidateOverrides = {}) {
  const seeded = await seedAttempt(store, rootDirectory, clock, candidateOverrides);
  clock.value = BASE_NOW + 200;
  const delivered = assertSuccess(await seeded.service.confirmDelivery({
    candidate_id: seeded.input.candidate_id,
    expected_revision: seeded.attempt.state_revision,
    current_session_identity: OWNER_A,
    claim_attempt_id: CLAIM_ATTEMPT_A,
    delivery_attempt_id: DELIVERY_ATTEMPT_A,
    evidence: evidence(),
  }));
  return { ...seeded, delivered };
}

function evidence(overrides = {}) {
  return {
    evidence_id: EVIDENCE_ID_A,
    runtime: SAFE_RUNTIME_ID,
    adapter_version: SAFE_ADAPTER_VERSION,
    confirmed_at: new Date(BASE_NOW + 100).toISOString(),
    ...overrides,
  };
}

function verifierWith(overrides = {}) {
  return Object.freeze(({ expected, evidence: rawEvidence }) => ({
    ...buildEvidenceVerifier({ expected, evidence: rawEvidence }),
    ...overrides,
  }));
}

async function rawRecordText(rootDirectory, candidateId) {
  return fileSystem.readFile(recordPath(rootDirectory, candidateId), "utf8");
}

async function rawRecord(rootDirectory, candidateId) {
  return JSON.parse(await rawRecordText(rootDirectory, candidateId));
}

async function writeRawRecord(rootDirectory, candidateId, value) {
  await fileSystem.writeFile(recordPath(rootDirectory, candidateId), `${JSON.stringify(value)}\n`, "utf8");
}

function buildLegacySignedDeliveryEnvelope(state, evidenceOverrides) {
  const delivery = {
    ...state.delivery,
    evidence: {
      ...state.delivery.evidence,
      ...evidenceOverrides,
    },
  };
  const candidateSnapshot = { ...state.candidate };
  const serialized = JSON.stringify({
    state_revision: state.state_revision,
    claim: state.claim,
    delivery,
    candidate: candidateSnapshot,
  });
  return {
    envelope_version: PENDING_HANDOFF_DELIVERY_ENVELOPE_VERSION,
    state_revision: state.state_revision,
    claim: state.claim,
    delivery,
    integrity: {
      algorithm: PENDING_HANDOFF_INTEGRITY_ALGORITHM,
      key_id: CURRENT_KEY_ID,
      digest: createHmac("sha256", KEY_MATERIAL[CURRENT_KEY_ID])
        .update(Buffer.from(serialized))
        .digest("base64url"),
    },
    candidate: candidateSnapshot,
  };
}

function assertNoLeak(value, rawValues = []) {
  const serialized = JSON.stringify(value);
  for (const marker of [PRIVATE_MARKER, EXCEPTION_MARKER, "record.json"]) {
    assert.equal(serialized.includes(marker), false);
  }
  for (const rawValue of rawValues) {
    if (typeof rawValue === "string" && rawValue.length > 0) {
      assert.equal(serialized.includes(rawValue), false, `raw value leaked: ${JSON.stringify(rawValue)}`);
    }
  }
}

function assertFailureWithoutLeak(result, reason, rawValues = []) {
  assertFailure(result, reason);
  assertNoLeak(result, rawValues);
}

function assertSafeStateMutationResult(result) {
  assert.equal(result?.ok, false);
  assert.ok(
    ["state_mutation_unavailable", "record_invalid"].includes(result?.reason),
    `unexpected protected-state mutation result: ${result?.reason}`,
  );
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.isFrozen(result), true);
}

function buildUnauthorizedState(candidateInput, state, targetStatus) {
  const candidateState = { ...candidateInput, status: targetStatus };
  if (targetStatus === "pending") {
    return { candidate: candidateState, claim: null, delivery: null };
  }

  assert.ok(state.claim);
  assert.ok(state.delivery);
  const deliveryAttempt = {
    delivery_attempt_id: state.delivery.delivery_attempt_id,
    delivery_attempted_at: state.delivery.delivery_attempted_at,
    delivery_candidate_digest: state.delivery.delivery_candidate_digest,
  };
  if (targetStatus === "claimed") {
    return { candidate: candidateState, claim: state.claim, delivery: deliveryAttempt };
  }

  const expected = {
    candidate_id: candidateInput.candidate_id,
    delivery_candidate_digest: state.delivery.delivery_candidate_digest,
    current_session_identity: state.claim.claim_owner_identity,
    claim_attempt_id: state.claim.claim_attempt_id,
    delivery_attempt_id: state.delivery.delivery_attempt_id,
  };
  const normalizedEvidence = buildEvidenceVerifier({ expected, evidence: evidence() });
  return {
    candidate: candidateState,
    claim: state.claim,
    delivery: {
      ...deliveryAttempt,
      evidence: normalizedEvidence,
      delivered_at: normalizedEvidence.confirmed_at,
      ...(targetStatus === "consumed"
        ? { consumed_at: new Date(BASE_NOW + 200).toISOString() }
        : {}),
    },
  };
}

function recordPath(rootDirectory, candidateId) {
  return join(rootDirectory, assertSuccess(derivePendingHandoffRecordKey(candidateId)), "record.json");
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
  throw new Error("delivery fixture barrier timeout");
}

function spawnDeliveryChild(
  mode,
  rootDirectory,
  candidateId,
  expectedRevision,
  barrierDirectory,
  owner,
  claimAttemptId,
  deliveryAttemptId,
  now,
  rawEvidence,
) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      `--delivery-child=${mode}`,
      rootDirectory,
      candidateId,
      String(expectedRevision),
      barrierDirectory,
      owner,
      claimAttemptId,
      deliveryAttemptId,
      String(now),
      JSON.stringify(rawEvidence),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once("exit", code => {
      if (code !== 0) {
        reject(new Error(`delivery child failed: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(error);
      }
    });
  });
  return { completion };
}

if (process.argv[2]?.startsWith("--delivery-child=")) {
  const mode = process.argv[2].slice("--delivery-child=".length);
  const rootDirectory = process.argv[3];
  const candidateId = process.argv[4];
  const expectedRevision = Number(process.argv[5]);
  const barrierDirectory = process.argv[6];
  const owner = process.argv[7];
  const claimAttemptId = process.argv[8];
  const deliveryAttemptId = process.argv[9];
  const now = Number(process.argv[10]);
  const rawEvidence = JSON.parse(process.argv[11]);
  const clock = { value: now };
  const runtime = registerRuntime(rootDirectory, clock);
  const store = runtime.store;
  const service = runtime.deliveryConsumption;
  await fileSystem.writeFile(
    join(barrierDirectory, `ready-${process.pid}`),
    "ready\n",
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  await waitForFile(join(barrierDirectory, "release"));
  const request = {
    candidate_id: candidateId,
    expected_revision: expectedRevision,
    current_session_identity: owner,
    claim_attempt_id: claimAttemptId,
    delivery_attempt_id: deliveryAttemptId,
    evidence: rawEvidence,
  };
  const result = mode === "confirm"
    ? await service.confirmDelivery(request)
    : await service.consumeDelivered(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

await group("Delivery/Consumption API and trusted dependencies", async () => {
  await test("exposes the bounded service, purpose-separated digest, and failure taxonomy", () => {
    assert.equal(typeof createPendingHandoffDeliveryConsumptionService, "function");
    assert.equal(PENDING_HANDOFF_DELIVERY_DIGEST_PURPOSE, "pending-handoff-delivery-candidate");
    for (const reason of [
      "delivery_dependency_invalid",
      "delivery_input_invalid",
      "delivery_state_invalid",
      "delivery_conflict",
      "delivery_attempt_invalid",
      "delivery_evidence_unavailable",
      "delivery_evidence_invalid",
      "delivery_evidence_mismatch",
      "delivery_time_invalid",
      "delivery_digest_invalid",
      "delivery_digest_failed",
      "delivery_publish_failed",
      "consumption_input_invalid",
      "consumption_attempt_invalid",
      "consumption_conflict",
      "consumption_evidence_unknown",
      "consumption_publish_failed",
    ]) assert.ok(PENDING_HANDOFF_DELIVERY_CONSUMPTION_FAILURES.includes(reason));
  });

  await test("rejects missing or unfrozen trusted dependencies without runtime activity", () => {
    assertFailure(createPendingHandoffDeliveryConsumptionService({}), "delivery_dependency_invalid");
    assert.equal(SOURCE.includes("codex"), false);
    assert.equal(SOURCE.includes("claude"), false);
    assert.equal(SOURCE.includes("thread/resume"), false);
  });
});

await group("Delivery Attempt", async () => {
  await test("records one claimed Delivery Attempt with a purpose-separated Candidate digest", async () => {
    await withEnvironment(async ({ rootDirectory, store, clock }) => {
      const seeded = await seedClaim(store, rootDirectory);
      const service = createService(store, clock);
      const result = assertSuccess(await service.beginDeliveryAttempt({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.claimed.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
      }));
      assert.equal(result.state_revision, seeded.claimed.state_revision + 1);
      assert.equal(result.delivery_attempt_id, DELIVERY_ATTEMPT_A);
      assert.equal(result.delivery_attempted_at, new Date(BASE_NOW).toISOString());
      assert.match(result.delivery_candidate_digest, /^[A-Za-z0-9_-]{43}$/);
      const state = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(state.candidate.status, "claimed");
      assert.equal(state.state_revision, 3);
      assert.equal(state.claim.claim_owner_identity, OWNER_A);
      assert.equal(state.delivery.delivery_attempt_id, DELIVERY_ATTEMPT_A);
      assert.equal(Object.hasOwn(state.candidate, "delivery_attempt_id"), false);
    });
  });
});

await group("Delivery Attempt idempotency and conflict", async () => {
  await test("reuses the same active Delivery Attempt only with the original expected revision", async () => {
    await withEnvironment(async ({ rootDirectory, store, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const retry = assertSuccess(await seeded.service.beginDeliveryAttempt({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.claimed.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
      }));
      assert.deepEqual(retry, seeded.attempt);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });

  await test("rejects arbitrary expected revisions and overlapping Delivery Attempts without mutation", async () => {
    await withEnvironment(async ({ rootDirectory, store, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      for (const expectedRevision of [3, 1, 999]) {
        assertFailureWithoutLeak(await seeded.service.beginDeliveryAttempt({
          candidate_id: seeded.input.candidate_id,
          expected_revision: expectedRevision,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
          delivery_attempt_id: DELIVERY_ATTEMPT_A,
        }), "delivery_conflict", [OWNER_A, CLAIM_ATTEMPT_A, DELIVERY_ATTEMPT_A]);
        assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      }
      assertFailureWithoutLeak(await seeded.service.beginDeliveryAttempt({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.claimed.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_B,
      }), "delivery_conflict", [OWNER_A, CLAIM_ATTEMPT_A, DELIVERY_ATTEMPT_B]);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });
});

await group("Candidate Delivery digest", async () => {
  await test("is deterministic for the exact canonical Candidate and changes with Candidate content", async () => {
    let firstDigest;
    await withEnvironment(async ({ rootDirectory, store, clock }) => {
      firstDigest = (await seedAttempt(store, rootDirectory, clock)).attempt.delivery_candidate_digest;
    });
    await withEnvironment(async ({ rootDirectory, store, clock }) => {
      const changed = await seedAttempt(store, rootDirectory, clock, {
        goal: "A different Candidate artifact.",
      });
      assert.notEqual(changed.attempt.delivery_candidate_digest, firstDigest);
    });
    await withEnvironment(async ({ rootDirectory, store, clock }) => {
      const same = await seedAttempt(store, rootDirectory, clock);
      assert.equal(same.attempt.delivery_candidate_digest, firstDigest);
    });
  });
});

await group("Delivery Evidence verifier", async () => {
  await test("confirms only verifier-produced normalized evidence with exact bindings", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      clock.value = BASE_NOW + 200;
      const result = assertSuccess(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.deepEqual(result, {
        state_revision: 4,
        status: "delivered",
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence_id: EVIDENCE_ID_A,
        delivered_at: new Date(BASE_NOW + 100).toISOString(),
      });
      const state = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(state.candidate.status, "delivered");
      assert.equal(state.delivery.evidence.verification, "passed");
      assert.equal(state.delivery.evidence.candidate_id, seeded.input.candidate_id);
    });
  });

  await test("rejects verifier unavailable and malformed normalized evidence without mutation", async () => {
    await withEnvironment(async ({ rootDirectory, store, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const unavailable = createService(store, clock, {
        deliveryEvidenceVerifier: Object.freeze(() => {
          throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
        }),
      });
      assertFailureWithoutLeak(await unavailable.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: PRIVATE_MARKER,
      }), "delivery_evidence_unavailable", [EXCEPTION_MARKER, PRIVATE_MARKER]);
      const malformed = createService(store, clock, {
        deliveryEvidenceVerifier: Object.freeze(() => ({ verified: true })),
      });
      assertFailureWithoutLeak(await malformed.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "delivery_evidence_invalid");
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });
});

await group("Normalized Evidence privacy value-smuggling", async () => {
  await test("rejects unsafe values inside every allowed normalized field without publication or leakage", async () => {
    const mutations = [
      ["evidence_id", [
        "native-session-opaque-001",
        "/Users/rani/.codex/sessions/opaque",
        "https://example.invalid/evidence",
        "sk-test-token-opaque",
        "free form evidence id",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        EVIDENCE_ID_A.toUpperCase(),
      ]],
      ["runtime", [
        "/Users/rani/.local/bin/codex",
        "https://example.invalid/runtime",
        "codex/cli",
        "codex\\cli",
        "codex runtime",
        "runtime\nleak",
        "token_blob_value",
        "Codex",
      ]],
      ["adapter_version", [
        "/opt/codex/1.0.0",
        "1.0.0\nleak",
        "sk-test-token",
        "1.0.0.0",
        "v1.0.0",
        "1.0.0/secret",
        "1.0.0+secret token",
      ]],
    ];

    for (const [field, values] of mutations) {
      for (const unsafeValue of values) {
        await withEnvironment(async ({ store, rootDirectory, clock }) => {
          const seeded = await seedAttempt(store, rootDirectory, clock);
          const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
          clock.value = BASE_NOW + 200;
          const result = await seeded.service.confirmDelivery({
            candidate_id: seeded.input.candidate_id,
            expected_revision: seeded.attempt.state_revision,
            current_session_identity: OWNER_A,
            claim_attempt_id: CLAIM_ATTEMPT_A,
            delivery_attempt_id: DELIVERY_ATTEMPT_A,
            evidence: evidence({ [field]: unsafeValue }),
          });
          assertFailureWithoutLeak(result, "delivery_evidence_invalid", [unsafeValue]);
          assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
          const state = assertSuccess(await store.readState(seeded.input.candidate_id));
          assert.equal(state.state_revision, seeded.attempt.state_revision);
          assert.equal(state.candidate.status, "claimed");
          assertNoLeak(await rawRecordText(rootDirectory, seeded.input.candidate_id), [unsafeValue]);
        });
      }
    }
  });

  await test("accepts canonical Evidence references, runtime slugs, and strict SemVer values", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      clock.value = BASE_NOW + 200;
      const normalized = evidence({
        evidence_id: EVIDENCE_ID_B,
        runtime: "claude-code",
        adapter_version: "1.2.0-beta.1",
      });
      const confirmed = assertSuccess(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: normalized,
      }));
      assert.equal(confirmed.status, "delivered");
      const state = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(state.delivery.evidence.evidence_id, EVIDENCE_ID_B);
      assert.equal(state.delivery.evidence.runtime, "claude-code");
      assert.equal(state.delivery.evidence.adapter_version, "1.2.0-beta.1");
    });
  });
});

await group("Delivery Confirmation idempotency and timing", async () => {
  await test("supports response-loss confirmation retry without a second publication", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      clock.value = BASE_NOW + 200;
      const first = assertSuccess(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const retry = assertSuccess(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.deepEqual(retry, first);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      assertFailureWithoutLeak(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: first.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "delivery_conflict");
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });

  await test("rejects evidence mismatches and exact lease/future timestamp boundaries", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const mismatched = createService(store, clock, {
        deliveryEvidenceVerifier: verifierWith({ current_session_identity: OWNER_B }),
      });
      clock.value = BASE_NOW + 200;
      assertFailureWithoutLeak(await mismatched.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "delivery_evidence_invalid", [OWNER_A, OWNER_B]);
      clock.value = BASE_NOW + 1_000;
      assertFailureWithoutLeak(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence({ confirmed_at: new Date(BASE_NOW + 1_000).toISOString() }),
      }), "delivery_time_invalid");
      clock.value = BASE_NOW;
      assertFailureWithoutLeak(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence({ confirmed_at: new Date(BASE_NOW + 100).toISOString() }),
      }), "delivery_time_invalid");
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });

  await test("accepts late persistence for evidence confirmed within the original authorization interval", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      clock.value = BASE_NOW + 200;
      const confirmed = assertSuccess(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      clock.value = BASE_NOW + 2_000;
      const retry = assertSuccess(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.deepEqual(retry, confirmed);
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).candidate.status, "delivered");
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });
});

await group("Unconfirmed Delivery release", async () => {
  await test("releases an unconfirmed Delivery Attempt back to pending with one revision", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      assert.deepEqual(assertSuccess(await seeded.service.releaseUnconfirmedDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
      })), { state_revision: 4, status: "pending" });
      const state = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(state.candidate.status, "pending");
      assert.equal(state.claim, null);
      assert.equal(Object.hasOwn(state, "delivery"), false);
    });
  });

  await test("rejects wrong owner, attempt, delivery attempt, and stale revision without mutation", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      for (const [owner, claimAttempt, deliveryAttempt, expectedRevision] of [
        [OWNER_B, CLAIM_ATTEMPT_A, DELIVERY_ATTEMPT_A, seeded.attempt.state_revision],
        [OWNER_A, CLAIM_ATTEMPT_B, DELIVERY_ATTEMPT_A, seeded.attempt.state_revision],
        [OWNER_A, CLAIM_ATTEMPT_A, DELIVERY_ATTEMPT_B, seeded.attempt.state_revision],
        [OWNER_A, CLAIM_ATTEMPT_A, DELIVERY_ATTEMPT_A, seeded.attempt.state_revision - 1],
      ]) {
        assertFailureWithoutLeak(await seeded.service.releaseUnconfirmedDelivery({
          candidate_id: seeded.input.candidate_id,
          expected_revision: expectedRevision,
          current_session_identity: owner,
          claim_attempt_id: claimAttempt,
          delivery_attempt_id: deliveryAttempt,
        }), "delivery_conflict", [owner, claimAttempt, deliveryAttempt]);
        assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      }
    });
  });
});

await group("Consumption", async () => {
  await test("consumes only a delivered Candidate with revalidated evidence", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const consumed = assertSuccess(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.deepEqual(consumed, {
        state_revision: 5,
        status: "consumed",
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        consumed_at: new Date(BASE_NOW + 200).toISOString(),
      });
      const state = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(state.candidate.status, "consumed");
      assert.equal(state.state_revision, 5);
      assert.equal(state.delivery.consumed_at, consumed.consumed_at);
      assert.notEqual(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      assert.equal(Object.hasOwn(state.candidate, "consumed_at"), false);
    });
  });

  await test("allows consumption after Candidate TTL only when delivery was confirmed before TTL", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock, {
        expires_at: new Date(BASE_NOW + 500).toISOString(),
      });
      clock.value = BASE_NOW + 2_000;
      const consumed = assertSuccess(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.equal(consumed.status, "consumed");
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).candidate.status, "consumed");
    });
  });

  await test("fails closed when Delivery Evidence cannot be revalidated", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const unavailable = createService(store, clock, {
        deliveryEvidenceVerifier: Object.freeze(() => {
          throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
        }),
      });
      assertFailureWithoutLeak(await unavailable.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_evidence_unknown", [EXCEPTION_MARKER, PRIVATE_MARKER]);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).candidate.status, "delivered");
    });
  });
});

await group("Consumption idempotency and conflict", async () => {
  await test("supports response-loss retry with the original delivered revision only", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const first = assertSuccess(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const retry = assertSuccess(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.deepEqual(retry, first);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      assertFailureWithoutLeak(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: first.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_conflict");
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });

  await test("replays an exact consumed request without consulting healthy, throwing, or malformed clocks", async () => {
    const replayClockModes = [
      ["healthy", () => BASE_NOW + 900],
      ["throwing", () => { throw new Error(`${EXCEPTION_MARKER} replay-clock`); }],
      ["malformed", () => "not-a-valid-clock"],
    ];
    for (const [mode, clockValue] of replayClockModes) {
      await withEnvironment(async ({ store, rootDirectory, clock }) => {
        const seeded = await seedDelivered(store, rootDirectory, clock);
        const request = {
          candidate_id: seeded.input.candidate_id,
          expected_revision: seeded.delivered.state_revision,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
          delivery_attempt_id: DELIVERY_ATTEMPT_A,
          evidence: evidence(),
        };
        const consumed = assertSuccess(await seeded.service.consumeDelivered(request));
        const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
        let clockCalls = 0;
        const replayClock = Object.freeze(() => {
          clockCalls += 1;
          return clockValue();
        });
        const replayService = createService(store, clock, { clock: replayClock });
        const replay = assertSuccess(await replayService.consumeDelivered(request));
        assert.deepEqual(replay, consumed, `${mode} replay changed the persisted result`);
        assert.equal(clockCalls, 0, `${mode} replay consulted the injected clock`);
        assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
        const state = assertSuccess(await store.readState(seeded.input.candidate_id));
        assert.equal(state.candidate.status, "consumed");
        assert.equal(state.state_revision, consumed.state_revision);
        assert.equal(state.delivery.consumed_at, consumed.consumed_at);
      });
    }
  });

  await test("rejects non-exact consumed replays without consulting a throwing clock", async () => {
    const cases = [
      {
        name: "different evidence",
        serviceOverrides: { deliveryEvidenceVerifier: verifierWith({ evidence_id: EVIDENCE_ID_B }) },
        requestOverrides: {},
        reason: "consumption_evidence_unknown",
      },
      {
        name: "different Claim attempt",
        serviceOverrides: {},
        requestOverrides: { claim_attempt_id: CLAIM_ATTEMPT_B },
        reason: "consumption_conflict",
      },
    ];
    for (const scenario of cases) {
      await withEnvironment(async ({ store, rootDirectory, clock }) => {
        const seeded = await seedDelivered(store, rootDirectory, clock);
        const request = {
          candidate_id: seeded.input.candidate_id,
          expected_revision: seeded.delivered.state_revision,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
          delivery_attempt_id: DELIVERY_ATTEMPT_A,
          evidence: evidence(),
          ...scenario.requestOverrides,
        };
        assertSuccess(await seeded.service.consumeDelivered({
          ...request,
          claim_attempt_id: CLAIM_ATTEMPT_A,
        }));
        const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
        let clockCalls = 0;
        const replayService = createService(store, clock, {
          ...scenario.serviceOverrides,
          clock: Object.freeze(() => {
            clockCalls += 1;
            throw new Error(`${EXCEPTION_MARKER} non-exact-${scenario.name}`);
          }),
        });
        assertFailureWithoutLeak(
          await replayService.consumeDelivered(request),
          scenario.reason,
          [EXCEPTION_MARKER],
        );
        assert.equal(clockCalls, 0, `${scenario.name} replay consulted the injected clock`);
        assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
        const state = assertSuccess(await store.readState(seeded.input.candidate_id));
        assert.equal(state.candidate.status, "consumed");
        assert.equal(state.state_revision, seeded.delivered.state_revision + 1);
      });
    }
  });

  await test("requires a valid clock for a fresh delivered-to-consumed publication", async () => {
    const clockModes = [
      ["throwing", () => { throw new Error(`${EXCEPTION_MARKER} fresh-clock`); }],
      ["malformed", () => "not-a-valid-clock"],
    ];
    for (const [mode, clockValue] of clockModes) {
      await withEnvironment(async ({ store, rootDirectory, clock }) => {
        const seeded = await seedDelivered(store, rootDirectory, clock);
        const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
        let clockCalls = 0;
        const service = createService(store, clock, {
          clock: Object.freeze(() => {
            clockCalls += 1;
            return clockValue();
          }),
        });
        assertFailureWithoutLeak(await service.consumeDelivered({
          candidate_id: seeded.input.candidate_id,
          expected_revision: seeded.delivered.state_revision,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
          delivery_attempt_id: DELIVERY_ATTEMPT_A,
          evidence: evidence(),
        }), "consumption_evidence_unknown", [EXCEPTION_MARKER]);
        assert.equal(clockCalls, 1, `${mode} fresh publication did not consult the clock`);
        assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
        const state = assertSuccess(await store.readState(seeded.input.candidate_id));
        assert.equal(state.candidate.status, "delivered");
        assert.equal(state.state_revision, seeded.delivered.state_revision);
        assert.equal(Object.hasOwn(state.delivery, "consumed_at"), false);
      });
    }
  });

  await test("rejects different evidence, owner, and attempt without mutation", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const mismatched = createService(store, clock, {
        deliveryEvidenceVerifier: verifierWith({ evidence_id: EVIDENCE_ID_B }),
      });
      assertFailureWithoutLeak(await mismatched.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_evidence_unknown");
      assertFailureWithoutLeak(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_B,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_conflict", [OWNER_B]);
      assertFailureWithoutLeak(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_B,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_conflict", [CLAIM_ATTEMPT_B]);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });

  await test("never reverts delivered state through the unconfirmed or Claim recovery boundaries", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      assertFailure(await seeded.service.releaseUnconfirmedDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
      }), "delivery_conflict");
      clock.value = BASE_NOW + 2_000;
      assertFailure(await seeded.claimService.recoverClaimLease({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
      }), "claim_state_invalid");
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).candidate.status, "delivered");
    });
  });
});

await group("Concurrent Confirmation and Consumption", async () => {
  await test("confirms the same Delivery Attempt with one published revision across independent processes", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const barrierDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-confirm-barrier-"));
      try {
        const rawEvidence = evidence();
        const first = spawnDeliveryChild(
          "confirm",
          rootDirectory,
          seeded.input.candidate_id,
          seeded.attempt.state_revision,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          DELIVERY_ATTEMPT_A,
          BASE_NOW + 200,
          rawEvidence,
        );
        const second = spawnDeliveryChild(
          "confirm",
          rootDirectory,
          seeded.input.candidate_id,
          seeded.attempt.state_revision,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          DELIVERY_ATTEMPT_A,
          BASE_NOW + 200,
          rawEvidence,
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
        const results = await Promise.all([first.completion, second.completion]);
        assert.ok(results.filter(result => result.ok === true).length >= 1);
        const finalState = assertSuccess(await store.readState(seeded.input.candidate_id));
        assert.equal(finalState.candidate.status, "delivered");
        assert.equal(finalState.state_revision, seeded.attempt.state_revision + 1);
        assert.equal(finalState.delivery.delivery_attempt_id, DELIVERY_ATTEMPT_A);
        assert.equal(finalState.delivery.evidence.evidence_id, EVIDENCE_ID_A);
      } finally {
        await fileSystem.rm(barrierDirectory, { recursive: true, force: true });
      }
    });
  });

  await test("publishes exactly one of two different valid Evidence values for one Delivery Attempt", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const barrierDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-confirm-different-evidence-barrier-"));
      try {
        const first = spawnDeliveryChild(
          "confirm",
          rootDirectory,
          seeded.input.candidate_id,
          seeded.attempt.state_revision,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          DELIVERY_ATTEMPT_A,
          BASE_NOW + 200,
          evidence({ evidence_id: EVIDENCE_ID_A }),
        );
        const second = spawnDeliveryChild(
          "confirm",
          rootDirectory,
          seeded.input.candidate_id,
          seeded.attempt.state_revision,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          DELIVERY_ATTEMPT_A,
          BASE_NOW + 200,
          evidence({ evidence_id: EVIDENCE_ID_B }),
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
        const results = await Promise.all([first.completion, second.completion]);
        assert.equal(results.filter(result => result.ok === true).length, 1);
        assert.equal(results.filter(result => result.ok === false).length, 1);
        assert.ok([
          "delivery_conflict",
          "delivery_evidence_mismatch",
        ].includes(results.find(result => result.ok === false)?.reason));

        const finalState = assertSuccess(await store.readState(seeded.input.candidate_id));
        assert.equal(finalState.candidate.status, "delivered");
        assert.equal(finalState.state_revision, seeded.attempt.state_revision + 1);
        assert.ok([EVIDENCE_ID_A, EVIDENCE_ID_B].includes(finalState.delivery.evidence.evidence_id));
        assert.equal(finalState.delivery.evidence.runtime, SAFE_RUNTIME_ID);
        assert.equal(finalState.delivery.evidence.adapter_version, SAFE_ADAPTER_VERSION);
      } finally {
        await fileSystem.rm(barrierDirectory, { recursive: true, force: true });
      }
    });
  });

  await test("consumes the same verified evidence with one publication across independent processes", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const barrierDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-consume-barrier-"));
      try {
        const rawEvidence = evidence();
        const first = spawnDeliveryChild(
          "consume",
          rootDirectory,
          seeded.input.candidate_id,
          seeded.delivered.state_revision,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          DELIVERY_ATTEMPT_A,
          BASE_NOW + 200,
          rawEvidence,
        );
        const second = spawnDeliveryChild(
          "consume",
          rootDirectory,
          seeded.input.candidate_id,
          seeded.delivered.state_revision,
          barrierDirectory,
          OWNER_A,
          CLAIM_ATTEMPT_A,
          DELIVERY_ATTEMPT_A,
          BASE_NOW + 200,
          rawEvidence,
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
        const results = await Promise.all([first.completion, second.completion]);
        assert.ok(results.filter(result => result.ok === true).length >= 1);
        const finalState = assertSuccess(await store.readState(seeded.input.candidate_id));
        assert.equal(finalState.candidate.status, "consumed");
        assert.equal(finalState.state_revision, seeded.delivered.state_revision + 1);
        assert.equal(finalState.delivery.consumed_at, new Date(BASE_NOW + 200).toISOString());
      } finally {
        await fileSystem.rm(barrierDirectory, { recursive: true, force: true });
      }
    });
  });
});

await group("Publication fault boundaries", async () => {
  await test("preserves the claimed-with-attempt state when pre-publication write fails", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const failingFileSystem = Object.freeze({
        ...REAL_FILE_SYSTEM,
        writeFile: async (location, ...args) => {
          if (String(location).includes(".record-")) {
            throw new Error(`${EXCEPTION_MARKER} pre-publication`);
          }
          return REAL_FILE_SYSTEM.writeFile(location, ...args);
        },
      });
      const failingRuntime = registerRuntime(rootDirectory, clock, { fileSystem: failingFileSystem });
      const failingStore = failingRuntime.store;
      const failingService = failingRuntime.deliveryConsumption;
      clock.value = BASE_NOW + 200;
      assertFailureWithoutLeak(await failingService.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "delivery_publish_failed", [EXCEPTION_MARKER]);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).candidate.status, "claimed");
    });
  });

  await test("preserves the claimed-with-attempt state when atomic rename fails", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const failingFileSystem = Object.freeze({
        ...REAL_FILE_SYSTEM,
        rename: async (from, to) => {
          if (String(from).includes(".record-")) {
            throw new Error(`${EXCEPTION_MARKER} rename`);
          }
          return REAL_FILE_SYSTEM.rename(from, to);
        },
      });
      const failingRuntime = registerRuntime(rootDirectory, clock, { fileSystem: failingFileSystem });
      const failingStore = failingRuntime.store;
      const failingService = failingRuntime.deliveryConsumption;
      clock.value = BASE_NOW + 200;
      assertFailureWithoutLeak(await failingService.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "delivery_publish_failed", [EXCEPTION_MARKER]);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).state_revision, 3);
    });
  });

  await test("does not report failure or roll back after publication when owner cleanup fails", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      let failOwnerUnlink = true;
      const failingFileSystem = Object.freeze({
        ...REAL_FILE_SYSTEM,
        unlink: async location => {
          if (failOwnerUnlink && String(location).includes(".cas-lock/owner-")) {
            throw new Error(`${EXCEPTION_MARKER} cleanup`);
          }
          return REAL_FILE_SYSTEM.unlink(location);
        },
      });
      const failingRuntime = registerRuntime(rootDirectory, clock, { fileSystem: failingFileSystem });
      const failingStore = failingRuntime.store;
      const failingService = failingRuntime.deliveryConsumption;
      clock.value = BASE_NOW + 200;
      const first = assertSuccess(await failingService.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.equal(first.status, "delivered");
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).state_revision, 4);
      const retry = assertSuccess(await failingService.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.deepEqual(retry, first);
      failOwnerUnlink = false;
      const lockDirectory = join(
        rootDirectory,
        assertSuccess(derivePendingHandoffRecordKey(seeded.input.candidate_id)),
        ".cas-lock",
      );
      for (const entry of await fileSystem.readdir(lockDirectory)) {
        await fileSystem.unlink(join(lockDirectory, entry));
      }
      await fileSystem.rmdir(lockDirectory);
    });
  });

  await test("preserves delivered state when consumption publication fails before write", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const failingFileSystem = Object.freeze({
        ...REAL_FILE_SYSTEM,
        writeFile: async (location, ...args) => {
          if (String(location).includes(".record-")) throw new Error(`${EXCEPTION_MARKER} consume`);
          return REAL_FILE_SYSTEM.writeFile(location, ...args);
        },
      });
      const failingRuntime = registerRuntime(rootDirectory, clock, { fileSystem: failingFileSystem });
      const failingStore = failingRuntime.store;
      const failingService = failingRuntime.deliveryConsumption;
      assertFailureWithoutLeak(await failingService.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_publish_failed", [EXCEPTION_MARKER]);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).candidate.status, "delivered");
    });
  });

  await test("keeps consumed state authoritative after post-publication cleanup failure", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      let failOwnerUnlink = true;
      const failingFileSystem = Object.freeze({
        ...REAL_FILE_SYSTEM,
        unlink: async location => {
          if (failOwnerUnlink && String(location).includes(".cas-lock/owner-")) {
            throw new Error(`${EXCEPTION_MARKER} consume-cleanup`);
          }
          return REAL_FILE_SYSTEM.unlink(location);
        },
      });
      const failingRuntime = registerRuntime(rootDirectory, clock, { fileSystem: failingFileSystem });
      const failingStore = failingRuntime.store;
      const failingService = failingRuntime.deliveryConsumption;
      const first = assertSuccess(await failingService.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.equal(first.status, "consumed");
      const retry = assertSuccess(await failingService.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.deepEqual(retry, first);
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).state_revision, 5);
      failOwnerUnlink = false;
      const lockDirectory = join(
        rootDirectory,
        assertSuccess(derivePendingHandoffRecordKey(seeded.input.candidate_id)),
        ".cas-lock",
      );
      for (const entry of await fileSystem.readdir(lockDirectory)) {
        await fileSystem.unlink(join(lockDirectory, entry));
      }
      await fileSystem.rmdir(lockDirectory);
    });
  });
});

await group("V4 state schema and integrity binding", async () => {
  await test("keeps Delivery metadata outside the Candidate and uses exact state shapes", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const attemptState = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.deepEqual(Object.keys(attemptState.delivery).sort(), [
        "delivery_attempt_id",
        "delivery_attempted_at",
        "delivery_candidate_digest",
      ]);
      assert.deepEqual(Object.keys(attemptState.candidate).sort(), Object.keys(candidate()).sort());
      for (const field of [
        "delivery_attempt_id",
        "delivery_attempted_at",
        "delivery_candidate_digest",
        "evidence",
        "delivered_at",
        "consumed_at",
      ]) assert.equal(Object.hasOwn(attemptState.candidate, field), false);

      clock.value = BASE_NOW + 200;
      assertSuccess(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      const delivered = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.deepEqual(Object.keys(delivered.delivery).sort(), [
        "delivered_at",
        "delivery_attempt_id",
        "delivery_attempted_at",
        "delivery_candidate_digest",
        "evidence",
      ]);
      assert.deepEqual(Object.keys(delivered.delivery.evidence).sort(), [
        "adapter_version",
        "candidate_available",
        "candidate_digest",
        "candidate_id",
        "claim_attempt_id",
        "confirmed_at",
        "current_session_identity",
        "delivery_attempt_id",
        "evidence_id",
        "injection_surface_accepted",
        "runtime",
        "verification",
      ]);
      assertSuccess(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      const consumed = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.deepEqual(Object.keys(consumed.delivery).sort(), [
        "consumed_at",
        "delivered_at",
        "delivery_attempt_id",
        "delivery_attempted_at",
        "delivery_candidate_digest",
        "evidence",
      ]);
      assert.deepEqual(Object.keys(consumed.candidate).sort(), Object.keys(candidate()).sort());
    });
  });

  await test("rejects missing, extra, and wrong-type V4 envelope fields", async () => {
    const mutations = [
      ["missing top-level delivery", envelope => { delete envelope.delivery; }],
      ["extra top-level field", envelope => { envelope.untrusted = true; }],
      ["extra delivery field", envelope => { envelope.delivery.extra = true; }],
      ["missing algorithm", envelope => { delete envelope.integrity.algorithm; }],
      ["wrong state revision type", envelope => { envelope.state_revision = "4"; }],
    ];
    for (const [, mutate] of mutations) {
      await withEnvironment(async ({ store, rootDirectory, clock }) => {
        const seeded = await seedAttempt(store, rootDirectory, clock);
        const envelope = await rawRecord(rootDirectory, seeded.input.candidate_id);
        mutate(envelope);
        await writeRawRecord(rootDirectory, seeded.input.candidate_id, envelope);
        const result = await store.readState(seeded.input.candidate_id);
        assert.equal(result.ok, false);
        assertNoLeak(result);
      });
    }
  });

  await test("rejects tampered V4 revision, claim, attempt, evidence, and status bindings", async () => {
    const mutations = [
      envelope => { envelope.state_revision = 2; },
      envelope => { envelope.claim.claim_owner_identity = OWNER_B; },
      envelope => { envelope.delivery.delivery_attempt_id = DELIVERY_ATTEMPT_B; },
      envelope => { envelope.delivery.delivery_candidate_digest = DELIVERY_DIGEST_A; },
      envelope => { envelope.delivery.evidence.evidence_id = "evidence-tampered"; },
      envelope => { envelope.candidate.status = "claimed"; },
    ];
    for (const mutate of mutations) {
      await withEnvironment(async ({ store, rootDirectory, clock }) => {
        const seeded = await seedDelivered(store, rootDirectory, clock);
        const envelope = await rawRecord(rootDirectory, seeded.input.candidate_id);
        mutate(envelope);
        await writeRawRecord(rootDirectory, seeded.input.candidate_id, envelope);
        const result = await store.readState(seeded.input.candidate_id);
        assert.equal(result.ok, false);
        assertNoLeak(result, [OWNER_B, DELIVERY_ATTEMPT_B]);
      });
    }
  });

  await test("rejects cross-record Delivery Evidence swaps", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const first = await seedDelivered(store, rootDirectory, clock, {
        candidate_id: "delivery-candidate-A",
      });
      clock.value = BASE_NOW;
      const second = await seedDelivered(store, rootDirectory, clock, {
        candidate_id: "delivery-candidate-B",
      });
      const firstEnvelope = await rawRecord(rootDirectory, first.input.candidate_id);
      const secondEnvelope = await rawRecord(rootDirectory, second.input.candidate_id);
      firstEnvelope.delivery.evidence = secondEnvelope.delivery.evidence;
      await writeRawRecord(rootDirectory, first.input.candidate_id, firstEnvelope);
      const result = await store.readState(first.input.candidate_id);
      assert.equal(result.ok, false);
      assertNoLeak(result);
    });
  });

  await test("rejects HMAC-valid V4 envelopes carrying unsafe normalized Evidence values", async () => {
    const mutations = [
      ["evidence_id", "native-session-opaque-001"],
      ["runtime", "/Users/rani/.local/bin/codex"],
      ["adapter_version", "sk-test-token"],
    ];
    for (const [field, unsafeValue] of mutations) {
      await withEnvironment(async ({ store, rootDirectory, clock }) => {
        const seeded = await seedDelivered(store, rootDirectory, clock);
        const state = assertSuccess(await store.readState(seeded.input.candidate_id));
        const legacyEnvelope = buildLegacySignedDeliveryEnvelope(state, { [field]: unsafeValue });
        const integrityDependencies = assertSuccess(
          createPendingHandoffIntegrityDependencies(buildIntegrityProvider()),
        );
        assertFailure(
          verifyPendingHandoffDeliveryIntegrityEnvelope(legacyEnvelope, integrityDependencies),
          "integrity_delivery_invalid",
        );
        await writeRawRecord(rootDirectory, seeded.input.candidate_id, legacyEnvelope);
        const result = await store.readState(seeded.input.candidate_id);
        assert.equal(result.ok, false);
        assertNoLeak(result, [unsafeValue]);
      });
    }
  });
});

await group("V3 to V4 explicit mutation and recovery", async () => {
  await test("does not silently migrate V3 and creates V4 only on explicit Delivery Attempt", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedClaim(store, rootDirectory);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const state = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(Object.hasOwn(state, "delivery"), false);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      const service = createService(store, clock);
      const attempt = assertSuccess(await service.beginDeliveryAttempt({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.claimed.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
      }));
      assert.equal(attempt.state_revision, 3);
      assert.equal((await rawRecord(rootDirectory, seeded.input.candidate_id)).envelope_version, "phr-integrity-envelope-v4");
    });
  });

  await test("recovers a claimed Delivery Attempt to pending and clears all attempt metadata", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      clock.value = BASE_NOW + 1_000;
      const recovered = assertSuccess(await seeded.claimService.recoverClaimLease({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
      }));
      assert.deepEqual(recovered, { state_revision: 4, status: "pending" });
      const state = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(state.candidate.status, "pending");
      assert.equal(state.claim, null);
      assert.equal(Object.hasOwn(state, "delivery"), false);
    });
  });

  await test("gives Candidate TTL precedence over Delivery Attempt Lease recovery", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock, {
        expires_at: new Date(BASE_NOW + 500).toISOString(),
      });
      clock.value = BASE_NOW + 500;
      const recovered = assertSuccess(await seeded.claimService.recoverClaimLease({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
      }));
      assert.deepEqual(recovered, { state_revision: 4, status: "expired" });
      const state = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(state.candidate.status, "expired");
      assert.equal(state.claim, null);
      assert.equal(Object.hasOwn(state, "delivery"), false);
    });
  });

  await test("rejects stale confirmation after Lease recovery without restoring the old attempt", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      clock.value = BASE_NOW + 1_000;
      assertSuccess(await seeded.claimService.recoverClaimLease({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
      }));
      const recoveredState = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(recoveredState.candidate.status, "pending");
      assert.equal(recoveredState.state_revision, seeded.attempt.state_revision + 1);
      assert.equal(Object.hasOwn(recoveredState, "delivery"), false);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      assertFailureWithoutLeak(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "delivery_conflict");
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      const finalState = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.deepEqual(finalState, recoveredState);
    });
  });
});

await group("Candidate digest semantic stability", async () => {
  await test("preserves array ordering and does not normalize NFC/NFD Candidate content", async () => {
    let orderedDigest;
    let nfcDigest;
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      orderedDigest = (await seedAttempt(store, rootDirectory, clock, {
        completed: ["first", "second"],
      })).attempt.delivery_candidate_digest;
      nfcDigest = (await seedAttempt(store, rootDirectory, clock, {
        candidate_id: "digest-nfc",
        goal: "é",
      })).attempt.delivery_candidate_digest;
    });
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const reordered = await seedAttempt(store, rootDirectory, clock, {
        completed: ["second", "first"],
      });
      assert.notEqual(reordered.attempt.delivery_candidate_digest, orderedDigest);
    });
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const nfd = await seedAttempt(store, rootDirectory, clock, {
        candidate_id: "digest-nfd",
        goal: "e\u0301",
      });
      assert.notEqual(nfd.attempt.delivery_candidate_digest, nfcDigest);
    });
  });
});

await group("Delivery digest provider failures", async () => {
  await test("rejects malformed and throwing purpose-separated digest providers without mutation", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedClaim(store, rootDirectory);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const malformed = createService(store, clock, {
        deliveryCandidateDigest: Object.freeze(() => "bad"),
      });
      assertFailureWithoutLeak(await malformed.beginDeliveryAttempt({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.claimed.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
      }), "delivery_digest_invalid");
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      const throwing = createService(store, clock, {
        deliveryCandidateDigest: Object.freeze(() => {
          throw new Error(`${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
        }),
      });
      assertFailureWithoutLeak(await throwing.beginDeliveryAttempt({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.claimed.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
      }), "delivery_digest_failed", [EXCEPTION_MARKER, PRIVATE_MARKER]);
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });
});

await group("Delivery Attempt input boundary", async () => {
  await test("rejects malformed Delivery Attempt identities before any publication", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedClaim(store, rootDirectory);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      for (const deliveryAttemptId of ["", "not-a-uuid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", null, 42]) {
        const service = createService(store, clock);
        assertFailureWithoutLeak(await service.beginDeliveryAttempt({
          candidate_id: seeded.input.candidate_id,
          expected_revision: seeded.claimed.state_revision,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
          delivery_attempt_id: deliveryAttemptId,
        }), "delivery_attempt_invalid");
        assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      }
    });
  });
});

await group("Evidence exact binding matrix", async () => {
  await test("rejects candidate, digest, claim-attempt, delivery-attempt, and injection mismatches", async () => {
    const mutations = [
      { candidate_id: "other-candidate" },
      { candidate_digest: DELIVERY_DIGEST_A },
      { claim_attempt_id: CLAIM_ATTEMPT_B },
      { delivery_attempt_id: DELIVERY_ATTEMPT_B },
      { injection_surface_accepted: false },
      { candidate_available: false },
    ];
    for (const override of mutations) {
      await withEnvironment(async ({ store, rootDirectory, clock }) => {
        const seeded = await seedAttempt(store, rootDirectory, clock);
        const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
        const mismatched = createService(store, clock, {
          deliveryEvidenceVerifier: verifierWith(override),
        });
        clock.value = BASE_NOW + 200;
        assertFailureWithoutLeak(await mismatched.confirmDelivery({
          candidate_id: seeded.input.candidate_id,
          expected_revision: seeded.attempt.state_revision,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
          delivery_attempt_id: DELIVERY_ATTEMPT_A,
          evidence: evidence(),
        }), "delivery_evidence_invalid");
        assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      });
    }
  });
});

await group("Evidence timestamp authorization", async () => {
  await test("requires evidence confirmation inside both authorization intervals and no later than the clock", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      clock.value = BASE_NOW + 200;
      for (const confirmedAt of [
        new Date(BASE_NOW - 1).toISOString(),
        new Date(BASE_NOW + 1_000).toISOString(),
      ]) {
        assertFailureWithoutLeak(await seeded.service.confirmDelivery({
          candidate_id: seeded.input.candidate_id,
          expected_revision: seeded.attempt.state_revision,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
          delivery_attempt_id: DELIVERY_ATTEMPT_A,
          evidence: evidence({ confirmed_at: confirmedAt }),
        }), "delivery_time_invalid");
      }
      assertSuccess(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence({ confirmed_at: new Date(BASE_NOW + 200).toISOString() }),
      }));
      assert.notEqual(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });

  await test("publishes an initial late confirmation when confirmed_at is still inside the original lease", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const claimedState = assertSuccess(await store.readState(seeded.input.candidate_id));
      const attemptedAt = Date.parse(claimedState.delivery.delivery_attempted_at);
      const leaseExpiresAt = Date.parse(claimedState.claim.claim_lease_expires_at);
      const candidateExpiresAt = Date.parse(claimedState.candidate.expires_at);
      const confirmedAt = BASE_NOW + 500;
      assert.equal(attemptedAt, BASE_NOW);
      assert.equal(leaseExpiresAt, BASE_NOW + 1_000);
      assert.ok(candidateExpiresAt > leaseExpiresAt);
      assert.ok(attemptedAt <= confirmedAt && confirmedAt < leaseExpiresAt);

      clock.value = BASE_NOW + 2_000;
      assert.ok(clock.value > leaseExpiresAt);
      const confirmed = assertSuccess(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence({ confirmed_at: new Date(confirmedAt).toISOString() }),
      }));
      assert.deepEqual(confirmed, {
        state_revision: seeded.attempt.state_revision + 1,
        status: "delivered",
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence_id: EVIDENCE_ID_A,
        delivered_at: new Date(confirmedAt).toISOString(),
      });
      const finalState = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(finalState.candidate.status, "delivered");
      assert.equal(finalState.state_revision, seeded.attempt.state_revision + 1);
      assert.equal(finalState.delivery.evidence.confirmed_at, new Date(confirmedAt).toISOString());
    });
  });
});

await group("Normalized evidence persistence boundary", async () => {
  await test("persists only normalized evidence and never raw runtime evidence", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      clock.value = BASE_NOW + 200;
      const raw = {
        evidence_id: EVIDENCE_ID_A,
        runtime: SAFE_RUNTIME_ID,
        adapter_version: SAFE_ADAPTER_VERSION,
        confirmed_at: new Date(BASE_NOW + 100).toISOString(),
        transcript: PRIVATE_MARKER,
        prompt: EXCEPTION_MARKER,
        raw_session_id: "native-session-must-not-persist",
      };
      assertSuccess(await seeded.service.confirmDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: raw,
      }));
      const serialized = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      assert.equal(serialized.includes(PRIVATE_MARKER), false);
      assert.equal(serialized.includes(EXCEPTION_MARKER), false);
      assert.equal(serialized.includes("native-session-must-not-persist"), false);
      assert.equal(serialized.includes("transcript"), false);
      assert.equal(serialized.includes("prompt"), false);
    });
  });
});

await group("V4 Store composition boundary", async () => {
  await test("does not permit an existing V4 record to drop Delivery metadata", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock, runtime }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      assert.equal(Object.hasOwn(runtime, "mutationPort"), false);
      assert.equal(typeof store.compareAndSetState, "undefined");
      assert.equal(Object.isFrozen(runtime), true);
      assert.deepEqual(Reflect.ownKeys(runtime), [
        "store",
        "claimLease",
        "deliveryConsumption",
      ]);
      assert.deepEqual(Reflect.ownKeys(store), [
        "compareAndSet",
        "write",
        "read",
        "readSnapshot",
        "readState",
      ]);
      assert.deepEqual(Reflect.ownKeys(runtime.claimLease), [
        "acquireClaim",
        "registerPending",
        "recoverClaimLease",
        "releaseClaimBeforeDelivery",
      ]);
      assert.deepEqual(Reflect.ownKeys(runtime.deliveryConsumption), [
        "beginDeliveryAttempt",
        "confirmDelivery",
        "releaseUnconfirmedDelivery",
        "consumeDelivered",
      ]);
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).state_revision, 3);
    });
  });
});

await group("public protected-state mutation authority", async () => {
  await test("rejects protected-state publications without revision or byte mutation", async () => {
    const scenarios = [
      {
        name: "claimed to delivered",
        targetStatus: "delivered",
        seed: (store, rootDirectory, clock) => seedAttempt(store, rootDirectory, clock),
      },
      {
        name: "claimed to consumed",
        targetStatus: "consumed",
        seed: (store, rootDirectory, clock) => seedAttempt(store, rootDirectory, clock),
      },
      {
        name: "consumed to claimed",
        targetStatus: "claimed",
        seed: async (store, rootDirectory, clock) => {
          const seeded = await seedDelivered(store, rootDirectory, clock);
          const consumed = assertSuccess(await seeded.service.consumeDelivered({
            candidate_id: seeded.input.candidate_id,
            expected_revision: seeded.delivered.state_revision,
            current_session_identity: OWNER_A,
            claim_attempt_id: CLAIM_ATTEMPT_A,
            delivery_attempt_id: DELIVERY_ATTEMPT_A,
            evidence: evidence(),
          }));
          return { ...seeded, consumed };
        },
      },
      {
        name: "consumed to pending",
        targetStatus: "pending",
        seed: async (store, rootDirectory, clock) => {
          const seeded = await seedDelivered(store, rootDirectory, clock);
          const consumed = assertSuccess(await seeded.service.consumeDelivered({
            candidate_id: seeded.input.candidate_id,
            expected_revision: seeded.delivered.state_revision,
            current_session_identity: OWNER_A,
            claim_attempt_id: CLAIM_ATTEMPT_A,
            delivery_attempt_id: DELIVERY_ATTEMPT_A,
            evidence: evidence(),
          }));
          return { ...seeded, consumed };
        },
      },
      {
        name: "delivered to pending",
        targetStatus: "pending",
        seed: (store, rootDirectory, clock) => seedDelivered(store, rootDirectory, clock),
      },
    ];

    for (const scenario of scenarios) {
      await withEnvironment(async ({ store, rootDirectory, clock }) => {
        const seeded = await scenario.seed(store, rootDirectory, clock);
        const beforeState = assertSuccess(await store.readState(seeded.input.candidate_id));
        const beforeBytes = await rawRecordText(rootDirectory, seeded.input.candidate_id);
        const nextState = buildUnauthorizedState(seeded.input, beforeState, scenario.targetStatus);
        const result = typeof store.compareAndSetState === "function"
          ? await store.compareAndSetState({
            candidate_id: seeded.input.candidate_id,
            expected_revision: beforeState.state_revision,
            next_state: nextState,
          })
          : await store.compareAndSet({
            candidate_id: seeded.input.candidate_id,
            expected_revision: beforeState.state_revision,
            next_state: nextState.candidate,
          });

        assertSafeStateMutationResult(result);
        const afterBytes = await rawRecordText(rootDirectory, seeded.input.candidate_id);
        assert.equal(afterBytes, beforeBytes, `${scenario.name} published an unauthorized Integrity-valid envelope`);
        const afterState = assertSuccess(await store.readState(seeded.input.candidate_id));
        assert.equal(afterState.state_revision, beforeState.state_revision);
        assert.equal(afterState.candidate.status, beforeState.candidate.status);
        assert.equal(JSON.parse(afterBytes).state_revision, JSON.parse(beforeBytes).state_revision);
      });
    }
  });
});

await group("Claim release interaction", async () => {
  await test("does not let the legacy Claim release boundary discard an active Delivery Attempt", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      assertFailure(await seeded.claimService.releaseClaimBeforeDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
      }), "claim_conflict");
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });
});

await group("Active Claim with Delivery Attempt", async () => {
  await test("does not steal an active Claim merely because an unconfirmed Attempt exists", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      assertFailureWithoutLeak(await seeded.claimService.acquireClaim({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_B,
        claim_attempt_id: CLAIM_ATTEMPT_B,
      }), "claim_conflict", [OWNER_B, CLAIM_ATTEMPT_B]);
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).state_revision, 3);
    });
  });
});

await group("Delivered terminality", async () => {
  await test("keeps delivered state terminal with respect to Claim/Lease recovery", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      clock.value = BASE_NOW + 2_000;
      assertFailure(await seeded.claimService.recoverClaimLease({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
      }), "claim_state_invalid");
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).candidate.status, "delivered");
    });
  });
});

await group("Consumption state boundary", async () => {
  await test("does not consume claimed, pending, expired, or malformed state", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      assertFailure(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_conflict");
      assertFailure(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: "not-an-attempt",
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_attempt_invalid");
      assertFailure(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: "3",
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_input_invalid");
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).candidate.status, "claimed");
      const released = assertSuccess(await seeded.service.releaseUnconfirmedDelivery({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.attempt.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
      }));
      assertFailure(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: released.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_conflict");
    });
  });
});

await group("Consumption evidence identity", async () => {
  await test("requires the persisted normalized evidence to match exactly before consumption", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      const evidenceMismatch = createService(store, clock, {
        deliveryEvidenceVerifier: verifierWith({ runtime: "different-runtime" }),
      });
      assertFailureWithoutLeak(await evidenceMismatch.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }), "consumption_evidence_unknown");
      assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
    });
  });
});

await group("Consumed V4 schema", async () => {
  await test("rejects consumed metadata tampering and missing consumption timestamp", async () => {
    const mutations = [
      envelope => { envelope.delivery.consumed_at = "2026-08-01T03:00:00.000Z"; },
      envelope => { delete envelope.delivery.consumed_at; },
      envelope => { envelope.delivery.evidence.adapter_version = "tampered-adapter"; },
    ];
    for (const mutate of mutations) {
      await withEnvironment(async ({ store, rootDirectory, clock }) => {
        const seeded = await seedDelivered(store, rootDirectory, clock);
        assertSuccess(await seeded.service.consumeDelivered({
          candidate_id: seeded.input.candidate_id,
          expected_revision: seeded.delivered.state_revision,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
          delivery_attempt_id: DELIVERY_ATTEMPT_A,
          evidence: evidence(),
        }));
        const envelope = await rawRecord(rootDirectory, seeded.input.candidate_id);
        mutate(envelope);
        await writeRawRecord(rootDirectory, seeded.input.candidate_id, envelope);
        const result = await store.readState(seeded.input.candidate_id);
        assert.equal(result.ok, false);
        assertNoLeak(result);
      });
    }
  });
});

await group("Failure taxonomy separation", async () => {
  await test("keeps evidence uncertainty, state contention, and publication failure distinct", async () => {
    assert.notEqual("consumption_evidence_unknown", "consumption_conflict");
    assert.notEqual("consumption_conflict", "consumption_publish_failed");
    assert.notEqual("delivery_evidence_unavailable", "delivery_evidence_invalid");
    assert.notEqual("delivery_conflict", "delivery_publish_failed");
  });
});

await group("Result privacy and immutability", async () => {
  await test("redacts raw evidence and filesystem details while freezing public results", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const result = assertSuccess(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence({ private_detail: PRIVATE_MARKER }),
      }));
      assert.equal(Object.isFrozen(result), true);
      assertNoLeak(result);
      assert.equal(JSON.stringify(result).includes("private_detail"), false);
    });
  });
});

await group("Runtime-neutral scope", async () => {
  await test("does not contain Runtime Adapter, Session Resolution, or re-injection implementation", () => {
    assert.equal(SOURCE.includes("codex"), false);
    assert.equal(SOURCE.includes("claude"), false);
    assert.equal(SOURCE.includes("resume"), false);
    assert.equal(SOURCE.includes("transcript"), false);
    assert.equal(SOURCE.includes("raw_session_id"), false);
  });
});

await group("Candidate contract preservation", async () => {
  await test("keeps the Candidate contract at exactly 17 fields", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const state = assertSuccess(await store.readState(seeded.input.candidate_id));
      assert.equal(Object.keys(state.candidate).length, 17);
      assert.equal(Object.keys(state.candidate).includes("claim_owner_identity"), false);
      assert.equal(Object.keys(state.candidate).includes("delivery_attempt_id"), false);
      assert.equal(Object.keys(state.candidate).includes("consumed_at"), false);
    });
  });
});

await group("Delivery and Consumption publication accounting", async () => {
  await test("never advances beyond one revision for response-loss retries", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const consumed = assertSuccess(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.equal(consumed.state_revision, seeded.delivered.state_revision + 1);
      assert.deepEqual(assertSuccess(await seeded.service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      })), consumed);
      assert.equal(assertSuccess(await store.readState(seeded.input.candidate_id)).state_revision, 5);
    });
  });
});

await group("V4 lifecycle union", async () => {
  await test("rejects impossible mixed status and Delivery metadata combinations", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedAttempt(store, rootDirectory, clock);
      const envelope = await rawRecord(rootDirectory, seeded.input.candidate_id);
      envelope.delivery.delivered_at = new Date(BASE_NOW + 100).toISOString();
      await writeRawRecord(rootDirectory, seeded.input.candidate_id, envelope);
      const result = await store.readState(seeded.input.candidate_id);
      assert.equal(result.ok, false);
      assertNoLeak(result);
    });
  });
});

await group("Consumption verifier failure boundary", async () => {
  await test("maps unavailable and malformed revalidation to evidence-unknown without mutation", async () => {
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const before = await rawRecordText(rootDirectory, seeded.input.candidate_id);
      for (const deliveryEvidenceVerifier of [
        Object.freeze(() => { throw new Error(`${EXCEPTION_MARKER} revalidate`); }),
        Object.freeze(() => ({ verified: true })),
      ]) {
        const service = createService(store, clock, { deliveryEvidenceVerifier });
        assertFailureWithoutLeak(await service.consumeDelivered({
          candidate_id: seeded.input.candidate_id,
          expected_revision: seeded.delivered.state_revision,
          current_session_identity: OWNER_A,
          claim_attempt_id: CLAIM_ATTEMPT_A,
          delivery_attempt_id: DELIVERY_ATTEMPT_A,
          evidence: evidence(),
        }), "consumption_evidence_unknown", [EXCEPTION_MARKER]);
        assert.equal(await rawRecordText(rootDirectory, seeded.input.candidate_id), before);
      }
    });
  });
});

await group("Single consumption evidence revalidation", async () => {
  await test("revalidates persisted evidence without invoking any Runtime injection operation", async () => {
    let calls = 0;
    await withEnvironment(async ({ store, rootDirectory, clock }) => {
      const seeded = await seedDelivered(store, rootDirectory, clock);
      const verifier = Object.freeze(({ expected, evidence: rawEvidence }) => {
        calls += 1;
        return buildEvidenceVerifier({ expected, evidence: rawEvidence });
      });
      const service = createService(store, clock, { deliveryEvidenceVerifier: verifier });
      const result = assertSuccess(await service.consumeDelivered({
        candidate_id: seeded.input.candidate_id,
        expected_revision: seeded.delivered.state_revision,
        current_session_identity: OWNER_A,
        claim_attempt_id: CLAIM_ATTEMPT_A,
        delivery_attempt_id: DELIVERY_ATTEMPT_A,
        evidence: evidence(),
      }));
      assert.equal(result.status, "consumed");
      assert.equal(calls, 1);
      assert.doesNotMatch(SOURCE, /\b(?:codex|claude|transcript|raw_session_id)\b/);
    });
  });
});

await group("Makefile fixture wiring", async () => {
  await test("exposes the Delivery/Consumption fixture as a separate V1.x target", () => {
    assert.match(MAKEFILE_SOURCE, /^test-pending-handoff-delivery-consumption-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-delivery-consumption-fixtures\.mjs$/m);
    const declaration = MAKEFILE_SOURCE.match(/^test-v1x-fixtures:[\s\S]*?(?=\n\n|\ninstall:)/m)?.[0] ?? "";
    assert.match(declaration, /test-pending-handoff-delivery-consumption-fixtures/);
    assert.equal(MAKEFILE_SOURCE.includes("test-pending-handoff-delivery-consumption-fixtures"), true);
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS\n`);
