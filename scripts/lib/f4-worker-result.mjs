import { createHash } from "node:crypto";

const BINDING_FIELDS = [
  "objectiveId", "workstreamId", "scopeRevision", "candidateId", "actionKind",
  "attemptId", "candidateRevision", "claimRevision", "associationId", "actorId",
  "runtimeId", "executionId", "repositoryId", "worktreeId", "stateRootId",
  "repositoryInstanceId", "physicalWorktreeId",
  "commit", "tree", "environmentId", "testPlanId", "testPlanDigest",
];
const REVISION_FIELDS = new Set(["candidateRevision", "claimRevision"]);
const RESULT_FIELDS = ["outcome", "evidenceRef"];
const TERMINAL_OUTCOMES = new Set(["passed", "failed", "cancelled"]);

const failure = reason => ({ ok: false, reason });

export function isWorkerResultCandidateId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function normalizeVerifiedResult(result) {
  if (result === null || typeof result !== "object") return null;
  const fields = [...BINDING_FIELDS, ...RESULT_FIELDS];
  const record = Object.fromEntries(fields.map(field => [field, result[field]]));
  const valid = BINDING_FIELDS.every(field => REVISION_FIELDS.has(field)
    ? Number.isSafeInteger(record[field]) && record[field] >= 0
    : field === "candidateId" ? isWorkerResultCandidateId(record[field])
      : typeof record[field] === "string" && /^[a-zA-Z0-9_.:@/-]{1,256}$/u.test(record[field]));
  if (!valid || record.actionKind !== "manual_resume"
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(record.commit)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(record.tree)
    || !/^[a-f0-9]{64}$/u.test(record.testPlanDigest)
    || !TERMINAL_OUTCOMES.has(record.outcome)
    || typeof record.evidenceRef !== "string"
    || !/^[a-zA-Z0-9_.:/-]{1,256}$/u.test(record.evidenceRef ?? "")) return null;
  return Object.freeze(record);
}

function fingerprint(record) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

/**
 * Host-only result handling. verifyResult must authenticate the Runtime event
 * and resolve the binding against the durable, dispatch-armed Attempt and the
 * current approval. Result and Inventory ports own their atomic writes and
 * revalidate authority at publication. This boundary has no dispatch port.
 */
export function createF4WorkerResultHandler({ verifyResult, resultStore, reconcileInventory }) {
  return async function receiveResult(observation) {
    let record;
    try {
      record = normalizeVerifiedResult(await verifyResult(observation));
    } catch {
      return failure("worker_result_unverified");
    }
    if (record === null) return failure("worker_result_unverified");

    const key = Object.freeze({
      candidateId: record.candidateId, actionKind: record.actionKind, attemptId: record.attemptId,
    });
    const digest = fingerprint(record);
    // Always read back canonical state, even if the write returned success.
    try { await resultStore.createIfAbsent(key, record); } catch { /* The write may have succeeded. */ }

    let stored;
    try {
      stored = normalizeVerifiedResult(await resultStore.read(key));
    } catch {
      return failure("worker_result_storage_unknown");
    }
    if (stored === null) return failure("worker_result_storage_unknown");
    if (fingerprint(stored) !== digest) return failure("worker_result_conflict");

    try {
      const reconciliation = await reconcileInventory(Object.freeze({ key, digest, record: stored }));
      if (reconciliation === "applied" || reconciliation === "already_applied") {
        return { ok: true, resultRecorded: true, reconciliation };
      }
    } catch { /* A subsequent delivery can reconcile from the same result. */ }
    return { ok: false, reason: "worker_result_reconciliation_pending", resultRecorded: true };
  };
}
