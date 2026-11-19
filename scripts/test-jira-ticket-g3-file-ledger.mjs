import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createG3FileLedger } from "./lib/jira-ticket-g3-file-ledger.mjs";

const ledgerRef = "fixture-g3-file-ledger";
const pending = (id, product = "10027") => ({
  create_request_id: id,
  ledger_ref: ledgerRef,
  status: "pending",
  approved_preview_id: "a".repeat(64),
  activation_ref: "fixture-activation",
  cutover_approval_ref: "fixture-owner-approval",
  issue_type: "Task",
  issue_type_id: "10010",
  fields: {
    customfield_10108: { id: product },
    customfield_10109: { id: "10028" },
    customfield_10110: [],
  },
});
const intentPath = (root, id) => join(root, "intents",
  `${createHash("sha256").update(id, "utf8").digest("hex")}.json`);
async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "jira-g3-file-ledger-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

await withRoot(async root => {
  const request = pending("g3-file-ledger-exact-duplicate-0001");
  const first = await createG3FileLedger({ root, ledgerRef }).persistIntent(request);
  assert.equal(first.status, "persisted");
  assert.equal(first.durable, true);

  const duplicate = await createG3FileLedger({ root, ledgerRef }).persistIntent({
    ...request,
    fields: {
      customfield_10110: [],
      customfield_10109: { id: "10028" },
      customfield_10108: { id: "10027" },
    },
  });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.durable, true);
  assert.equal(duplicate.created_new, false);
  console.log("PASS: exact re-entry returns duplicate only after the existing Intent is revalidated and synced");
});

await withRoot(async root => {
  const request = pending("g3-file-ledger-corrupt-0001");
  await createG3FileLedger({ root, ledgerRef }).persistIntent(request);
  await writeFile(intentPath(root, request.create_request_id), "{ partial JSON", "utf8");
  await assert.rejects(() => createG3FileLedger({ root, ledgerRef }).persistIntent(request), /corrupt/i);
  console.log("PASS: corrupt pending Intent never produces a durable duplicate response");
});

await withRoot(async root => {
  const request = pending("g3-file-ledger-partial-0001");
  await createG3FileLedger({ root, ledgerRef }).persistIntent(request);
  await writeFile(intentPath(root, request.create_request_id), `${JSON.stringify({
    create_request_id: request.create_request_id,
    ledger_ref: ledgerRef,
    status: "pending",
    phase: "pending",
    stored_at: new Date().toISOString(),
  })}\n`, "utf8");
  await assert.rejects(() => createG3FileLedger({ root, ledgerRef }).persistIntent(request), /does not match/i);
  console.log("PASS: syntactically valid but partial pending Intent is rejected");
});

await withRoot(async root => {
  const request = pending("g3-file-ledger-invalid-time-0001");
  const ledger = createG3FileLedger({ root, ledgerRef });
  await ledger.persistIntent(request);
  const path = intentPath(root, request.create_request_id);
  const existing = JSON.parse(await readFile(path, "utf8"));
  existing.stored_at = "not-an-ISO-timestamp";
  await writeFile(path, `${JSON.stringify(existing)}\n`, "utf8");
  await assert.rejects(() => ledger.persistIntent(request), /does not match/i);
  console.log("PASS: malformed pending Intent timestamp cannot produce a durable duplicate");
});

await withRoot(async root => {
  const request = pending("g3-file-ledger-extra-key-0001");
  const ledger = createG3FileLedger({ root, ledgerRef });
  await ledger.persistIntent(request);
  const path = intentPath(root, request.create_request_id);
  const existing = JSON.parse(await readFile(path, "utf8"));
  existing.unexpected = "tampered";
  await writeFile(path, `${JSON.stringify(existing)}\n`, "utf8");
  await assert.rejects(() => ledger.persistIntent(request), /does not match/i);
  console.log("PASS: extra pending Intent fields fail closed");
});

await withRoot(async root => {
  const request = pending("g3-file-ledger-duplicate-key-0001");
  const ledger = createG3FileLedger({ root, ledgerRef });
  await ledger.persistIntent(request);
  const path = intentPath(root, request.create_request_id);
  const original = await readFile(path, "utf8");
  const duplicateKey = original.replace('"status":"pending"', '"status":"pending","status":"pending"');
  assert.notEqual(duplicateKey, original);
  await writeFile(path, duplicateKey, "utf8");
  await assert.rejects(() => ledger.persistIntent(request), /encoding is not intact/i);
  console.log("PASS: duplicate JSON keys fail closed instead of being collapsed by JSON.parse");
});

await withRoot(async root => {
  const request = pending("g3-file-ledger-mismatch-0001");
  await createG3FileLedger({ root, ledgerRef }).persistIntent(request);
  await assert.rejects(() => createG3FileLedger({ root, ledgerRef }).persistIntent(
    pending(request.create_request_id, "10026")), /does not match/i);
  console.log("PASS: same CreateRequestId with different approved Target values is rejected");
});

await withRoot(async root => {
  const request = pending("g3-file-ledger-race-0001");
  const ledgers = [createG3FileLedger({ root, ledgerRef }), createG3FileLedger({ root, ledgerRef })];
  const outcomes = await Promise.allSettled(ledgers.map(ledger => ledger.persistIntent(request)));
  assert.equal(outcomes.filter(value => value.status === "fulfilled" && value.value.created_new).length, 1);
  const duplicates = outcomes.filter(value => value.status === "fulfilled" && value.value.status === "duplicate");
  assert.ok(duplicates.length <= 1);
  assert.ok(duplicates.every(value => value.value.durable));
  // A second writer that observes the winner's in-progress partial file must fail
  // closed; it may report duplicate only after the complete request is verified.
  const retry = await ledgers[0].persistIntent(request);
  assert.equal(retry.status, "duplicate");
  assert.equal(retry.durable, true);
  console.log("PASS: concurrent CAS permits one durable writer; re-entry is verified or fails closed");
});

await withRoot(async root => {
  const request = pending("g3-file-ledger-backup-restore-0001");
  const ledger = createG3FileLedger({ root, ledgerRef });
  await ledger.persistIntent(request);
  const storedPath = intentPath(root, request.create_request_id);
  assert.equal((await stat(join(root, "intents"))).mode & 0o777, 0o700);
  assert.equal((await stat(storedPath)).mode & 0o777, 0o600);

  const staging = await mkdtemp(join(tmpdir(), "jira-g3-file-ledger-backup-"));
  try {
    const backup = join(staging, "backup");
    const restored = join(staging, "restored");
    await cp(root, backup, { recursive: true });
    await cp(backup, restored, { recursive: true });
    const restoredLedger = createG3FileLedger({ root: restored, ledgerRef });
    const restoredRecord = await restoredLedger.inspectRequest(request.create_request_id);
    assert.equal(restoredRecord.pending.create_request_id, request.create_request_id);
    const duplicate = await restoredLedger.persistIntent(request);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.created_new, false);
  } finally { await rm(staging, { recursive: true, force: true }); }
  console.log("PASS: file modes and copied/restored pending Intent prevent a new ledger claim");
});
