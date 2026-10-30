import assert from "node:assert/strict";
import {
  createPendingHandoffManualResumeAttemptOutcomeService,
} from "./lib/pending-handoff-manual-resume-attempt-outcome.mjs";
import {
  createPendingHandoffManualResumeAttemptOutcomeStoreAdapter,
  RPL120_MANUAL_RESUME_ATTEMPT_STORE_NAMESPACE,
} from "./lib/pending-handoff-manual-resume-attempt-outcome-store-adapter.mjs";

const ATTEMPT_ID = "123e4567-e89b-42d3-a456-426614174000";
const IDENTITY = Object.freeze({
  candidate_id: "rpl120-store-adapter-fixture-candidate",
  action_kind: "manual_resume",
  attempt_id: ATTEMPT_ID,
  runtime_id: "codex",
  actor_identity: `phr1.session.key_A-1.${"O".repeat(43)}`,
  scope_ref: "rpl120-store-adapter-fixture-candidate",
  repository_identity: `phr1.repository.key_A-1.${"R".repeat(43)}`,
  worktree_identity: `phr1.worktree.key_A-1.${"W".repeat(43)}`,
  candidate_revision: 7,
});

let tests = 0;
function success(value) { return { ok: true, value }; }
function failure(reason) { return { ok: false, reason }; }
function assertFailure(result, reason) { assert.deepEqual(result, { ok: false, reason }); }

function clone(value) { return value === null ? null : { ...value }; }

function createMemoryRecordStore(overrides = {}) {
  const records = new Map();
  const calls = [];
  const keyOf = request => `${request.namespace}:${request.record_key}`;
  const recordStore = Object.freeze({
    readRecord: async request => {
      calls.push({ operation: "read", request });
      if (overrides.readRecord) return overrides.readRecord(request, records, keyOf);
      return success(clone(records.get(keyOf(request)) ?? null));
    },
    compareAndSetRecord: async request => {
      calls.push({ operation: "compareAndSet", request });
      if (overrides.compareAndSetRecord) {
        return overrides.compareAndSetRecord(request, records, keyOf);
      }
      const current = records.get(keyOf(request)) ?? null;
      if ((request.expected_revision === null && current !== null)
        || (request.expected_revision !== null
          && current?.revision !== request.expected_revision)) {
        return failure("revision_conflict");
      }
      const stored = clone(request.next_record);
      records.set(keyOf(request), stored);
      return success(clone(stored));
    },
  });
  return { calls, records, recordStore };
}

function adapterFor(recordStore) {
  const result = createPendingHandoffManualResumeAttemptOutcomeStoreAdapter({ recordStore });
  assert.equal(result.ok, true);
  return result.value;
}

function serviceFor(recordStore) {
  const result = createPendingHandoffManualResumeAttemptOutcomeService({
    store: adapterFor(recordStore),
  });
  assert.equal(result.ok, true);
  return result.value;
}

async function test(name, callback) {
  tests += 1;
  try { await callback(); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

await test("requires the generic physical record CAS provider contract", () => {
  assert.deepEqual(createPendingHandoffManualResumeAttemptOutcomeStoreAdapter({}), {
    ok: false,
    reason: "manual_resume_attempt_store_invalid",
  });
  assert.deepEqual(createPendingHandoffManualResumeAttemptOutcomeStoreAdapter({
    recordStore: { readRecord: async () => success(null) },
  }), {
    ok: false,
    reason: "manual_resume_attempt_store_invalid",
  });
});

await test("maps the domain key into a stable namespaced path-safe record key", async () => {
  const fixture = createMemoryRecordStore();
  const adapter = adapterFor(fixture.recordStore);
  assert.deepEqual(await adapter.readAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
  }), success(null));
  const request = fixture.calls[0].request;
  assert.equal(request.namespace, RPL120_MANUAL_RESUME_ATTEMPT_STORE_NAMESPACE);
  assert.match(request.record_key, /^attempt-[0-9a-f]{64}$/);
  const secondAdapter = adapterFor(fixture.recordStore);
  await secondAdapter.readAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
  });
  assert.equal(fixture.calls[1].request.record_key, request.record_key);
  await secondAdapter.readAttempt({
    candidate_id: `${IDENTITY.candidate_id}-other`,
    action_kind: IDENTITY.action_kind,
  });
  assert.notEqual(fixture.calls[2].request.record_key, request.record_key);
});

await test("create-if-absent and revision CAS drive the whole attempt lifecycle", async () => {
  const fixture = createMemoryRecordStore();
  const service = serviceFor(fixture.recordStore);
  const reserved = await service.reserveAttempt({ identity: IDENTITY });
  assert.equal(reserved.ok, true);
  assert.equal(fixture.calls[0].operation, "read");
  assert.equal(fixture.calls[1].request.expected_revision, null);

  const bound = await service.bindClaim({
    identity: IDENTITY,
    expected_attempt_revision: reserved.value.revision,
    claim_revision: 8,
  });
  const started = await service.markDispatchStarted({
    identity: IDENTITY,
    expected_attempt_revision: bound.value.revision,
    claim_revision: 8,
  });
  const accepted = await service.recordValidatedAdapterAcceptance({
    identity: IDENTITY,
    expected_attempt_revision: started.value.revision,
    adapter_version: "fixture-adapter-v1",
  });
  assert.deepEqual([reserved.value.status, bound.value.status, started.value.status, accepted.value.status], [
    "reserved", "claim_bound", "dispatch_unknown", "accepted",
  ]);
  assert.deepEqual(fixture.calls.filter(call => call.operation === "compareAndSet")
    .map(call => call.request.expected_revision), [null, 1, 2, 3]);
  assert.equal((await service.readAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
  })).value.status, "accepted");
});

await test("create-if-absent and stale revisions return conflict without overwriting", async () => {
  const fixture = createMemoryRecordStore();
  const adapter = adapterFor(fixture.recordStore);
  const initial = {
    ...IDENTITY,
    revision: 1,
    claim_revision: null,
    status: "reserved",
    adapter_version: null,
  };
  assert.equal((await adapter.compareAndSetAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
    expected_revision: null,
    next_record: initial,
  })).ok, true);
  assertFailure(await adapter.compareAndSetAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
    expected_revision: null,
    next_record: initial,
  }), "manual_resume_attempt_revision_conflict");
  const next = { ...initial, revision: 2, claim_revision: 8, status: "claim_bound" };
  assert.equal((await adapter.compareAndSetAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
    expected_revision: 1,
    next_record: next,
  })).ok, true);
  assertFailure(await adapter.compareAndSetAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
    expected_revision: 1,
    next_record: { ...next, revision: 2, status: "dispatch_unknown" },
  }), "manual_resume_attempt_revision_conflict");
  assert.equal((await adapter.readAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
  })).value.revision, 2);
});

await test("scope-mismatched and malformed backend records fail closed", async () => {
  const foreign = {
    ...IDENTITY,
    candidate_id: "other-candidate",
    revision: 1,
    claim_revision: null,
    status: "reserved",
    adapter_version: null,
  };
  const misrouted = createMemoryRecordStore({
    readRecord: async () => success(foreign),
  });
  assertFailure(await adapterFor(misrouted.recordStore).readAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
  }), "manual_resume_attempt_record_invalid");

  const malformed = createMemoryRecordStore({
    readRecord: async () => success({ candidate_id: IDENTITY.candidate_id }),
  });
  assertFailure(await adapterFor(malformed.recordStore).readAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
  }), "manual_resume_attempt_record_invalid");
});

await test("provider outage and ambiguous write receipt never authorize a retry", async () => {
  const fixture = createMemoryRecordStore({
    compareAndSetRecord: async (request, records, keyOf) => {
      records.set(keyOf(request), clone(request.next_record));
      return failure("store_unavailable");
    },
  });
  const service = serviceFor(fixture.recordStore);
  assertFailure(await service.reserveAttempt({ identity: IDENTITY }), "manual_resume_attempt_store_unavailable");
  const restarted = serviceFor(fixture.recordStore);
  assertFailure(await restarted.reserveAttempt({ identity: IDENTITY }), "manual_resume_attempt_replay_blocked");

  const unavailable = createMemoryRecordStore({
    readRecord: async () => { throw new Error("private root detail"); },
  });
  assertFailure(await adapterFor(unavailable.recordStore).readAttempt({
    candidate_id: IDENTITY.candidate_id,
    action_kind: IDENTITY.action_kind,
  }), "manual_resume_attempt_store_unavailable");
});

process.stdout.write(`PASS TOTAL ${tests} TESTS RC 0\n`);
