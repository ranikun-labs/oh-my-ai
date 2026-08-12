import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PENDING_HANDOFF_SCHEMA_VERSION } from "./lib/pending-handoff-core.mjs";
import {
  createPendingHandoffStore,
  derivePendingHandoffRecordKey,
} from "./lib/pending-handoff-store.mjs";

let integrityModule = null;
try {
  integrityModule = await import("./lib/pending-handoff-integrity.mjs");
} catch {
  // The API assertions below report the missing Integrity boundary.
}

const {
  createPendingHandoffIntegrityDependencies,
  createPendingHandoffIntegrityEnvelope,
  PENDING_HANDOFF_INTEGRITY_ALGORITHM,
  PENDING_HANDOFF_INTEGRITY_ENVELOPE_VERSION,
  PENDING_HANDOFF_INTEGRITY_FAILURES,
  PENDING_HANDOFF_INTEGRITY_PROVIDER_VERSION,
  PENDING_HANDOFF_INTEGRITY_PURPOSE,
  PENDING_HANDOFF_REVISION_ENVELOPE_VERSION,
  verifyPendingHandoffIntegrityEnvelope,
} = integrityModule ?? {};

const STORE_SOURCE = readFileSync(
  fileURLToPath(new URL("./lib/pending-handoff-store.mjs", import.meta.url)),
  "utf8",
);
let INTEGRITY_SOURCE = "";
try {
  INTEGRITY_SOURCE = readFileSync(
    fileURLToPath(new URL("./lib/pending-handoff-integrity.mjs", import.meta.url)),
    "utf8",
  );
} catch {
  // The API assertions report the missing production boundary.
}
const CANDIDATE_SOURCE = readFileSync(
  fileURLToPath(new URL("./lib/pending-handoff-candidate.mjs", import.meta.url)),
  "utf8",
);

const SESSION_IDENTITY = `phr1.session.key_A-1.${"A".repeat(43)}`;
const REPOSITORY_IDENTITY = `phr1.repository.key_A-1.${"B".repeat(43)}`;
const WORKTREE_IDENTITY = `phr1.worktree.key_A-1.${"C".repeat(43)}`;
const CURRENT_KEY_ID = "integrity_current";
const PREVIOUS_KEY_ID = "integrity_previous";
const RETIRED_KEY_ID = "integrity_retired";
const PRIVATE_MARKER = "integrity-private-marker";
const EXCEPTION_MARKER = "integrity-exception-marker";
const RAW_PATH_MARKER = "/private/raw/integrity-record.json";
const CANDIDATE_FIELDS = Object.freeze([
  "candidate_id",
  "schema_version",
  "status",
  "created_at",
  "expires_at",
  "source_runtime",
  "source_session_identity",
  "repository_identity",
  "worktree_identity",
  "goal",
  "completed",
  "open_issues",
  "verification",
  "do_not_touch",
  "next_action",
  "context_checkpoint_status",
  "privacy_redaction_status",
]);
const KEY_MATERIAL = Object.freeze({
  [CURRENT_KEY_ID]: "integrity-current-secret",
  [PREVIOUS_KEY_ID]: "integrity-previous-secret",
});

let groups = 0;
let tests = 0;

function candidate(overrides = {}) {
  return {
    candidate_id: "integrity-candidate-001",
    schema_version: PENDING_HANDOFF_SCHEMA_VERSION,
    status: "candidate",
    created_at: "2026-07-30T01:00:00.000Z",
    expires_at: "2026-07-30T02:00:00.000Z",
    source_runtime: "codex",
    source_session_identity: SESSION_IDENTITY,
    repository_identity: REPOSITORY_IDENTITY,
    worktree_identity: WORKTREE_IDENTITY,
    goal: "Persist a content-integrity-protected pending handoff candidate.",
    completed: ["The candidate was canonicalized."],
    open_issues: [],
    verification: ["The integrity fixture uses an isolated temporary directory."],
    do_not_touch: ["Revision and CAS state."],
    next_action: "Verify the envelope before returning the candidate.",
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
    return createHmac("sha256", secret)
      .update(Buffer.from(bytes))
      .digest("base64url");
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

function assertFailure(result, reason) {
  assert.equal(result?.ok, false);
  assert.equal(result.reason, reason);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.equal(Object.hasOwn(result, "metadata"), false);
}

function assertFailureOneOf(result, reasons) {
  assert.equal(result?.ok, false);
  assert.ok(reasons.includes(result.reason), `unexpected failure reason: ${result.reason}`);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.isFrozen(result), true);
}

function assertSuccess(result) {
  assert.equal(result?.ok, true);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "value"]);
  assert.equal(Object.isFrozen(result), true);
  return result.value;
}

function assertFrozenEnvelope(envelope) {
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.integrity), true);
  assert.equal(Object.isFrozen(envelope.candidate), true);
  for (const field of ["completed", "open_issues", "verification", "do_not_touch"]) {
    assert.equal(Object.isFrozen(envelope.candidate[field]), true);
  }
}

function assertNoLeak(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(PRIVATE_MARKER), false);
  assert.equal(serialized.includes(EXCEPTION_MARKER), false);
  assert.equal(serialized.includes(RAW_PATH_MARKER), false);
  assert.equal(serialized.includes("record.json"), false);
}

function canonicalCandidateJson(value) {
  const ordered = {};
  for (const field of CANDIDATE_FIELDS) ordered[field] = value[field];
  return JSON.stringify(ordered);
}

function dependencies(provider = buildProvider()) {
  assert.equal(typeof createPendingHandoffIntegrityDependencies, "function");
  return assertSuccess(createPendingHandoffIntegrityDependencies(provider));
}

function envelope(value, provider = buildProvider()) {
  assert.equal(typeof createPendingHandoffIntegrityEnvelope, "function");
  return assertSuccess(createPendingHandoffIntegrityEnvelope(value, dependencies(provider)));
}

function storeOptions(rootDirectory, overrides = {}) {
  return {
    rootDirectory,
    integrityProvider: buildProvider(),
    ...overrides,
  };
}

async function withStore(operation, options = {}) {
  const rootDirectory = await fileSystem.mkdtemp(join(tmpdir(), "phr-integrity-fixture-"));
  try {
    const result = createPendingHandoffStore(storeOptions(rootDirectory, options));
    const store = assertSuccess(result);
    return await operation({ rootDirectory, store });
  } finally {
    await fileSystem.rm(rootDirectory, { recursive: true, force: true });
  }
}

async function envelopePath(rootDirectory, candidateId) {
  const keyResult = derivePendingHandoffRecordKey(candidateId);
  const key = assertSuccess(keyResult);
  return join(rootDirectory, key, "record.json");
}

async function readEnvelope(rootDirectory, candidateId) {
  return JSON.parse(await fileSystem.readFile(await envelopePath(rootDirectory, candidateId), "utf8"));
}

async function replaceEnvelope(rootDirectory, candidateId, mutate) {
  const path = await envelopePath(rootDirectory, candidateId);
  const stored = JSON.parse(await fileSystem.readFile(path, "utf8"));
  mutate(stored);
  await fileSystem.writeFile(path, `${JSON.stringify(stored)}\n`, "utf8");
}

async function writeEnvelope(rootDirectory, candidateId, storedEnvelope) {
  const path = await envelopePath(rootDirectory, candidateId);
  await fileSystem.mkdir(dirname(path), { recursive: true });
  await fileSystem.writeFile(path, `${JSON.stringify(storedEnvelope)}\n`, "utf8");
}

function cloneEnvelope(value) {
  return JSON.parse(JSON.stringify(value));
}

async function writeMutatedEnvelope(rootDirectory, input, mutate) {
  const stored = cloneEnvelope(envelope(input));
  mutate(stored);
  await writeEnvelope(rootDirectory, input.candidate_id, stored);
}

async function readUsingProvider(rootDirectory, candidateId, provider) {
  const result = createPendingHandoffStore(storeOptions(rootDirectory, {
    integrityProvider: provider,
  }));
  const store = assertSuccess(result);
  return store.read(candidateId);
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

await group("API and dependency boundary", async () => {
  await test("exports a separate purpose-bound Integrity boundary", () => {
    assert.equal(typeof createPendingHandoffIntegrityDependencies, "function");
    assert.equal(typeof createPendingHandoffIntegrityEnvelope, "function");
    assert.equal(typeof verifyPendingHandoffIntegrityEnvelope, "function");
    assert.equal(PENDING_HANDOFF_INTEGRITY_PURPOSE, "pending-handoff-integrity");
    assert.equal(PENDING_HANDOFF_INTEGRITY_PROVIDER_VERSION, "phr-integrity-provider-v1");
    assert.equal(PENDING_HANDOFF_INTEGRITY_ENVELOPE_VERSION, "phr-integrity-envelope-v1");
    assert.equal(PENDING_HANDOFF_INTEGRITY_ALGORITHM, "hmac-sha256-base64url-v1");
    assert.deepEqual(PENDING_HANDOFF_INTEGRITY_FAILURES, [
      "integrity_dependency_invalid",
      "integrity_provider_version_unsupported",
      "integrity_key_id_invalid",
      "integrity_verification_keys_invalid",
      "integrity_digest_invalid",
      "integrity_digest_failed",
      "integrity_compare_invalid",
      "integrity_compare_failed",
      "integrity_envelope_invalid",
      "integrity_envelope_version_unsupported",
      "integrity_candidate_invalid",
      "integrity_key_not_found",
      "integrity_mismatch",
    ]);
    assert.equal(Object.isFrozen(PENDING_HANDOFF_INTEGRITY_FAILURES), true);
    assert.doesNotMatch(INTEGRITY_SOURCE, /pending-handoff-secret-provider\.mjs/);
    assert.match(INTEGRITY_SOURCE, /validateOpaqueIdentity/);
  });

  await test("binds the Integrity provider purpose and rejects invalid dependency shapes", () => {
    const observedPurposes = [];
    const purposeBoundProvider = buildProvider({
      keyed_digest: frozenFunction(({ purpose, key_id, bytes }) => {
        observedPurposes.push(purpose);
        return createHmac("sha256", KEY_MATERIAL[key_id])
          .update(Buffer.from(bytes))
          .digest("base64url");
      }),
    });
    const valid = assertSuccess(createPendingHandoffIntegrityDependencies(purposeBoundProvider));
    assert.equal(typeof valid.current.keyed_digest, "function");
    assert.equal(envelope(candidate(), purposeBoundProvider).integrity.key_id, CURRENT_KEY_ID);
    assert.deepEqual(observedPurposes, [PENDING_HANDOFF_INTEGRITY_PURPOSE]);

    assertFailure(
      createPendingHandoffIntegrityDependencies(buildProvider({ version: "phr-secret-provider-v1" })),
      "integrity_provider_version_unsupported",
    );
    assertFailure(
      createPendingHandoffIntegrityDependencies(buildProvider({
        current_key_id: "bad key",
      })),
      "integrity_key_id_invalid",
    );
    assertFailure(
      createPendingHandoffIntegrityDependencies(buildProvider({
        verification_key_ids: Object.freeze([PREVIOUS_KEY_ID, CURRENT_KEY_ID]),
      })),
      "integrity_verification_keys_invalid",
    );
    assertFailure(
      createPendingHandoffIntegrityDependencies(buildProvider({ keyed_digest: () => "A".repeat(43) })),
      "integrity_dependency_invalid",
    );
  });
});

await group("canonical bytes and envelope contract", async () => {
  await test("uses deterministic compact UTF-8 bytes with fixed Candidate ordering", () => {
    const observed = [];
    const provider = buildProvider({
      keyed_digest: frozenFunction(input => {
        observed.push({
          key_id: input.key_id,
          purpose: input.purpose,
          bytes: [...input.bytes],
        });
        return createHmac("sha256", KEY_MATERIAL[input.key_id])
          .update(Buffer.from(input.bytes))
          .digest("base64url");
      }),
    });
    const first = candidate({ completed: ["one", "two"] });
    const reordered = Object.fromEntries(Object.entries(first).reverse());
    const firstEnvelope = envelope(first, provider);
    const secondEnvelope = envelope(reordered, provider);
    assert.equal(firstEnvelope.integrity.digest, secondEnvelope.integrity.digest);
    assert.equal(observed.length, 2);
    assert.equal(observed[0].key_id, CURRENT_KEY_ID);
    assert.equal(observed[0].purpose, PENDING_HANDOFF_INTEGRITY_PURPOSE);
    assert.deepEqual(observed[0].bytes, observed[1].bytes);
    assert.equal(Buffer.from(observed[0].bytes).toString("utf8"), canonicalCandidateJson(first));
    assert.equal(Buffer.from(observed[0].bytes).toString("utf8").endsWith("\n"), false);
  });

  await test("keeps Integrity metadata outside the exact 17-field Candidate", () => {
    const value = envelope(candidate());
    assert.deepEqual(Object.keys(value), ["envelope_version", "integrity", "candidate"]);
    assert.deepEqual(Object.keys(value.integrity), ["algorithm", "key_id", "digest"]);
    assert.deepEqual(Object.keys(value.candidate), CANDIDATE_FIELDS);
    assert.equal(value.envelope_version, PENDING_HANDOFF_INTEGRITY_ENVELOPE_VERSION);
    assert.equal(value.integrity.algorithm, PENDING_HANDOFF_INTEGRITY_ALGORITHM);
    assert.equal(value.integrity.key_id, CURRENT_KEY_ID);
    assert.match(value.integrity.digest, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Object.isFrozen(value), true);
    assertFrozenEnvelope(value);
  });
});

await group("Store integration and valid envelope", async () => {
  await test("roundtrips a verified envelope while returning only the Candidate", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      const written = assertSuccess(await store.write(input));
      assert.deepEqual(Object.keys(written), ["record_key"]);
      assert.deepEqual(assertSuccess(await store.read(input.candidate_id)), input);

      const stored = await readEnvelope(rootDirectory, input.candidate_id);
      assert.deepEqual(Object.keys(stored), ["envelope_version", "state_revision", "integrity", "candidate"]);
      assert.equal(stored.envelope_version, PENDING_HANDOFF_REVISION_ENVELOPE_VERSION);
      assert.equal(stored.state_revision, 0);
      assert.deepEqual(Object.keys(stored.integrity), ["algorithm", "key_id", "digest"]);
      assert.deepEqual(Object.keys(stored.candidate), CANDIDATE_FIELDS);
      assert.equal(Object.hasOwn(stored, "cas"), false);
    });
  });

  await test("preserves directory-per-record isolation for integrity envelopes", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const first = candidate({ candidate_id: "integrity-one" });
      const second = candidate({ candidate_id: "integrity-two", goal: "A second candidate." });
      assertSuccess(await store.write(first));
      assertSuccess(await store.write(second));
      assert.deepEqual(assertSuccess(await store.read(first.candidate_id)), first);
      assert.deepEqual(assertSuccess(await store.read(second.candidate_id)), second);
      const entries = await fileSystem.readdir(rootDirectory);
      assert.deepEqual(entries.sort(), [
        assertSuccess(derivePendingHandoffRecordKey(first.candidate_id)),
        assertSuccess(derivePendingHandoffRecordKey(second.candidate_id)),
      ].sort());
    });
  });
});

await group("Tamper and corrupt envelope rejection", async () => {
  await test("rejects a scalar Candidate tamper", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      await replaceEnvelope(rootDirectory, input.candidate_id, value => {
        value.candidate.goal = PRIVATE_MARKER;
      });
      const result = await store.read(input.candidate_id);
      assertFailure(result, "record_integrity_mismatch");
      assertNoLeak(result);
    });
  });

  await test("rejects a Candidate array tamper", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      await replaceEnvelope(rootDirectory, input.candidate_id, value => {
        value.candidate.completed.push(PRIVATE_MARKER);
      });
      const result = await store.read(input.candidate_id);
      assertFailure(result, "record_integrity_mismatch");
      assertNoLeak(result);
    });
  });

  await test("rejects candidate_id tamper before returning the Candidate", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      await replaceEnvelope(rootDirectory, input.candidate_id, value => {
        value.candidate.candidate_id = "tampered-candidate";
      });
      const result = await store.read(input.candidate_id);
      assertFailure(result, "record_integrity_mismatch");
      assertNoLeak(result);
    });
  });

  await test("rejects integrity digest tamper", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      await replaceEnvelope(rootDirectory, input.candidate_id, value => {
        value.integrity.digest = "A".repeat(43);
      });
      const result = await store.read(input.candidate_id);
      assertFailure(result, "record_integrity_mismatch");
      assertNoLeak(result);
    });
  });

  await test("rejects an unknown verification key", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      await replaceEnvelope(rootDirectory, input.candidate_id, value => {
        value.integrity.key_id = RETIRED_KEY_ID;
      });
      const result = await store.read(input.candidate_id);
      assertFailure(result, "record_integrity_key_invalid");
      assertNoLeak(result);
    });
  });

  await test("rejects unsupported envelope versions and missing integrity metadata", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      await replaceEnvelope(rootDirectory, input.candidate_id, value => {
        value.envelope_version = "phr-integrity-envelope-v999";
      });
      assertFailure(await store.read(input.candidate_id), "record_integrity_invalid");

      const fresh = candidate({ candidate_id: "missing-integrity" });
      assertSuccess(await store.write(fresh));
      await replaceEnvelope(rootDirectory, fresh.candidate_id, value => {
        delete value.integrity;
      });
      const result = await store.read(fresh.candidate_id);
      assertFailure(result, "record_integrity_invalid");
      assertNoLeak(result);
    });
  });

  await test("rejects malformed envelope JSON without parser leakage", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate();
      assertSuccess(await store.write(input));
      await fileSystem.writeFile(await envelopePath(rootDirectory, input.candidate_id), `${RAW_PATH_MARKER} {`, "utf8");
      const result = await store.read(input.candidate_id);
      assertFailure(result, "record_malformed");
      assertNoLeak(result);
    });
  });
});

await group("Exact algorithm and envelope schema oracles", async () => {
  await test("rejects every non-exact algorithm variant", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "algorithm-allowlist" });
      const invalidAlgorithms = [
        value => { delete value.integrity.algorithm; },
        value => { value.integrity.algorithm = "HMAC-SHA256-BASE64URL-V1"; },
        value => { value.integrity.algorithm = "hmac-sha256"; },
        value => { value.integrity.algorithm = "unknown-integrity-algorithm"; },
        value => { value.integrity.algorithm = null; },
        value => { value.integrity.algorithm = 42; },
        value => { value.integrity.algorithm = {}; },
      ];
      for (const mutate of invalidAlgorithms) {
        await writeMutatedEnvelope(rootDirectory, input, mutate);
        const result = await store.read(input.candidate_id);
        assertFailure(result, "record_integrity_invalid");
        assertNoLeak(result);
      }
    });
  });

  await test("rejects extra, missing, null, and wrong-type top-level Envelope shapes", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "envelope-schema" });
      const mutations = [
        value => { value.extra = true; },
        value => { delete value.envelope_version; },
        value => { delete value.integrity; },
        value => { delete value.candidate; },
      ];
      for (const mutate of mutations) {
        await writeMutatedEnvelope(rootDirectory, input, mutate);
        assertFailure(await store.read(input.candidate_id), "record_integrity_invalid");
      }
      for (const wrongType of [null, [], "envelope", 42]) {
        await writeEnvelope(rootDirectory, input.candidate_id, wrongType);
        const result = await store.read(input.candidate_id);
        assertFailure(result, "record_integrity_invalid");
        assertNoLeak(result);
      }
    });
  });

  await test("rejects extra, missing, null, and wrong-type Integrity metadata", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "integrity-schema" });
      const mutations = [
        value => { value.integrity.extra = true; },
        value => { delete value.integrity.algorithm; },
        value => { delete value.integrity.key_id; },
        value => { delete value.integrity.digest; },
        value => { value.integrity = null; },
        value => { value.integrity.algorithm = null; },
        value => { value.integrity.key_id = 42; },
        value => { value.integrity.digest = {}; },
        value => { value.candidate = null; },
        value => { value.candidate = []; },
        value => { value.candidate = "candidate"; },
        value => { value.candidate = 42; },
      ];
      for (const mutate of mutations) {
        await writeMutatedEnvelope(rootDirectory, input, mutate);
        const result = await store.read(input.candidate_id);
        assertFailure(result, "record_integrity_invalid");
        assertNoLeak(result);
      }
    });
  });
});

await group("Canonical semantic distinction oracles", async () => {
  await test("rejects reordered array elements as a digest mismatch", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({
        candidate_id: "array-ordering",
        completed: ["first", "second"],
      });
      assertSuccess(await store.write(input));
      await replaceEnvelope(rootDirectory, input.candidate_id, value => {
        value.candidate.completed.reverse();
      });
      const result = await store.read(input.candidate_id);
      assertFailure(result, "record_integrity_mismatch");
      assertNoLeak(result);
    });
  });

  await test("keeps NFC and NFD bytes distinct without normalization", async () => {
    const observed = [];
    const provider = buildProvider({
      keyed_digest: frozenFunction(input => {
        observed.push([...input.bytes]);
        return createHmac("sha256", KEY_MATERIAL[input.key_id])
          .update(Buffer.from(input.bytes))
          .digest("base64url");
      }),
    });
    const nfc = candidate({ candidate_id: "unicode-nfc", goal: "é" });
    const nfd = candidate({ candidate_id: "unicode-nfd", goal: "e\u0301" });
    const nfcEnvelope = envelope(nfc, provider);
    const nfdEnvelope = envelope(nfd, provider);
    assert.notEqual(nfcEnvelope.integrity.digest, nfdEnvelope.integrity.digest);
    assert.notDeepEqual(observed[0], observed[1]);

    await withStore(async ({ rootDirectory, store }) => {
      const stored = candidate({ candidate_id: "unicode-tamper", goal: "é" });
      assertSuccess(await store.write(stored));
      await replaceEnvelope(rootDirectory, stored.candidate_id, value => {
        value.candidate.goal = "e\u0301";
      });
      const result = await store.read(stored.candidate_id);
      assertFailure(result, "record_integrity_mismatch");
      assertNoLeak(result);
    });
  });
});

await group("Key rotation and identity binding", async () => {
  await test("accepts a valid previous verification key without rewriting it", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "previous-key-record" });
      const previousProvider = buildProvider({
        current_key_id: PREVIOUS_KEY_ID,
        verification_key_ids: Object.freeze([PREVIOUS_KEY_ID, CURRENT_KEY_ID]),
      });
      await writeEnvelope(rootDirectory, input.candidate_id, envelope(input, previousProvider));
      assert.deepEqual(assertSuccess(await store.read(input.candidate_id)), input);
      const stored = await readEnvelope(rootDirectory, input.candidate_id);
      assert.equal(stored.integrity.key_id, PREVIOUS_KEY_ID);
    });
  });

  await test("rejects a valid envelope containing the wrong Candidate", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const requested = candidate({ candidate_id: "requested-record" });
      const stored = candidate({ candidate_id: "stored-record" });
      await writeEnvelope(rootDirectory, requested.candidate_id, envelope(stored));
      const result = await store.read(requested.candidate_id);
      assertFailure(result, "record_invalid");
      assertNoLeak(result);
    });
  });

  await test("rejects current-digest key substitution to a trusted previous key", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "key-substitution" });
      assertSuccess(await store.write(input));
      await replaceEnvelope(rootDirectory, input.candidate_id, value => {
        value.integrity.key_id = PREVIOUS_KEY_ID;
      });
      const result = await store.read(input.candidate_id);
      assertFailure(result, "record_integrity_mismatch");
      assertNoLeak(result);
    });
  });
});

await group("Privacy and dependency failure boundaries", async () => {
  await test("maps provider exceptions to redacted deterministic failures", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "provider-failure" });
      assertSuccess(await store.write(input));
      const failingProvider = buildProvider({
        keyed_digest: frozenFunction(() => {
          throw new Error(`${RAW_PATH_MARKER} ${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
        }),
      });
      const failingResult = createPendingHandoffStore(storeOptions(rootDirectory, {
        integrityProvider: failingProvider,
      }));
      const failingStore = assertSuccess(failingResult);
      const captured = await captureOutput(() => failingStore.read(input.candidate_id));
      assertFailure(captured.result, "record_integrity_invalid");
      assert.deepEqual(captured.writes, []);
      assertNoLeak(captured.result);
    });
  });

  await test("rejects missing Integrity dependency without filesystem activity", () => {
    const result = createPendingHandoffStore({ rootDirectory: "/tmp/ignored-integrity-root" });
    assertFailure(result, "integrity_dependency_invalid");
    assertNoLeak(result);
  });

  await test("keeps the Candidate contract at exactly 17 fields", () => {
    assert.equal(CANDIDATE_FIELDS.length, 17);
    assert.doesNotMatch(CANDIDATE_SOURCE, /candidate_digest|integrity_version|integrity_key_id|state_revision/);
    const value = envelope(candidate()).candidate;
    assert.deepEqual(Object.keys(value), CANDIDATE_FIELDS);
  });
});

await group("safe_equal security oracles", async () => {
  await test("calls trusted safe_equal exactly once for a valid verification", async () => {
    let calls = 0;
    const argumentsSeen = [];
    const provider = buildProvider({
      safe_equal: frozenFunction((left, right) => {
        calls += 1;
        argumentsSeen.push([left, right]);
        return left === right;
      }),
    });
    await withStore(async ({ store }) => {
      const input = candidate({ candidate_id: "safe-equal-count" });
      assertSuccess(await store.write(input));
      assert.equal(calls, 0);
      assert.deepEqual(assertSuccess(await store.read(input.candidate_id)), input);
      assert.equal(calls, 1);
      assert.equal(argumentsSeen.length, 1);
      assert.equal(argumentsSeen[0][0], argumentsSeen[0][1]);
    }, { integrityProvider: provider });
  });

  await test("fails closed and redacts a safe_equal exception", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "safe-equal-throw" });
      assertSuccess(await store.write(input));
      const provider = buildProvider({
        safe_equal: frozenFunction(() => {
          throw new Error(`${RAW_PATH_MARKER} ${EXCEPTION_MARKER} ${PRIVATE_MARKER}`);
        }),
      });
      const captured = await captureOutput(() => readUsingProvider(rootDirectory, input.candidate_id, provider));
      assertFailure(captured.result, "record_integrity_invalid");
      assert.deepEqual(captured.writes, []);
      assertNoLeak(captured.result);
    });
  });

  await test("rejects non-boolean safe_equal results", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "safe-equal-types" });
      assertSuccess(await store.write(input));
      for (const output of [undefined, "true", {}]) {
        const provider = buildProvider({ safe_equal: frozenFunction(() => output) });
        const result = await readUsingProvider(rootDirectory, input.candidate_id, provider);
        assertFailure(result, "record_integrity_invalid");
        assertNoLeak(result);
      }
    });
  });

  await test("fails closed when safe_equal returns false for equal digests", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "safe-equal-false" });
      assertSuccess(await store.write(input));
      const provider = buildProvider({ safe_equal: frozenFunction(() => false) });
      const result = await readUsingProvider(rootDirectory, input.candidate_id, provider);
      assertFailure(result, "record_integrity_invalid");
      assertNoLeak(result);
    });
  });

  await test("rejects a safe_equal result that lies about unequal digests", async () => {
    await withStore(async ({ rootDirectory, store }) => {
      const input = candidate({ candidate_id: "safe-equal-lie" });
      assertSuccess(await store.write(input));
      await replaceEnvelope(rootDirectory, input.candidate_id, value => {
        value.integrity.digest = "A".repeat(43);
      });
      const provider = buildProvider({ safe_equal: frozenFunction(() => true) });
      const result = await readUsingProvider(rootDirectory, input.candidate_id, provider);
      assertFailure(result, "record_integrity_invalid");
      assertNoLeak(result);
    });
  });
});

await group("Malformed digest provider oracles", async () => {
  await test("fails closed for every malformed digest provider result", async () => {
    const malformedResults = [
      "",
      "A".repeat(42),
      "A".repeat(44),
      "!".repeat(43),
      null,
      42,
      {},
    ];
    for (const [index, output] of malformedResults.entries()) {
      const provider = buildProvider({ keyed_digest: frozenFunction(() => output) });
      await withStore(async ({ store }) => {
        const captured = await captureOutput(() => store.write(candidate({
          candidate_id: `malformed-digest-${index}`,
        })));
        assertFailure(captured.result, "record_integrity_invalid");
        assert.deepEqual(captured.writes, []);
        assertNoLeak(captured.result);
      }, { integrityProvider: provider });
    }
  });
});

await group("Static scope and wiring", async () => {
  await test("keeps Integrity separate from the Identity provider while limiting V4 to Delivery composition", () => {
    assert.match(STORE_SOURCE, /pending-handoff-integrity\.mjs/);
    assert.match(INTEGRITY_SOURCE, /hmac-sha256-base64url-v1/);
    assert.match(INTEGRITY_SOURCE, /phr-integrity-envelope-v2/);
    assert.match(INTEGRITY_SOURCE, /DELIVERY_ENVELOPE_VERSION/);
    assert.doesNotMatch(INTEGRITY_SOURCE, /consumption|session registry|sqlite/i);
    assert.match(STORE_SOURCE, /createPendingHandoffDeliveryConsumptionService/);
    assert.doesNotMatch(STORE_SOURCE, /session registry|sqlite/i);
    assert.doesNotMatch(INTEGRITY_SOURCE, /console|process\.stdout|process\.stderr|fetch/);
  });

  await test("wires Integrity before the Revision/CAS and Session Resolution fixtures in V1.x", () => {
    const makefile = readFileSync(fileURLToPath(new URL("../Makefile", import.meta.url)), "utf8");
    assert.equal((makefile.match(/^test-pending-handoff-integrity-fixtures:/gm) ?? []).length, 1);
    assert.match(
      makefile,
      /^test-pending-handoff-integrity-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-integrity-fixtures\.mjs$/m,
    );
    const lines = makefile.split("\n");
    const start = lines.findIndex(line => line.startsWith("test-v1x-fixtures:"));
    assert.notEqual(start, -1);
    const declaration = [lines[start]];
    while (declaration.at(-1).endsWith("\\")) declaration.push(lines[start + declaration.length]);
    const targets = declaration.join(" ").replace(/^test-v1x-fixtures:\s*/, "").replaceAll("\\", " ").trim().split(/\s+/);
    assert.equal(targets.at(-1), "test-pending-handoff-manual-resume-fixtures");
    assert.ok(targets.indexOf("test-pending-handoff-store-fixtures") < targets.indexOf("test-pending-handoff-integrity-fixtures"));
    assert.ok(targets.indexOf("test-pending-handoff-integrity-fixtures") < targets.indexOf("test-pending-handoff-revision-cas-fixtures"));
    assert.ok(targets.indexOf("test-pending-handoff-claim-lease-fixtures") < targets.indexOf("test-pending-handoff-delivery-consumption-fixtures"));
  });
});

process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS\n`);
