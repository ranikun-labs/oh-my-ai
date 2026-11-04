import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  f4PhysicalStateBindingFromLocation,
  sameF4PhysicalStateBinding,
} from "./lib/f4-physical-state-binding.mjs";
import {
  createPendingHandoffManualResumeAttemptOutcomeStoreAdapter,
} from "./lib/pending-handoff-manual-resume-attempt-outcome-store-adapter.mjs";
import {
  createPendingHandoffManualResumeAttemptOutcomeUserLocalRecordProvider,
} from "./lib/pending-handoff-manual-resume-attempt-outcome-user-local-provider.mjs";
import {
  createPendingHandoffManualResumeAttemptOutcomeService,
} from "./lib/pending-handoff-manual-resume-attempt-outcome.mjs";

const rpl95ModulePath = process.env.F4_RPL95_USER_LOCAL_STATE_MODULE;
const repositoryCwd = process.env.F4_TEST_REPOSITORY_CWD ?? process.cwd();
assert.equal(typeof rpl95ModulePath, "string", "pin the RPL-95 source module path");
assert.equal(path.isAbsolute(rpl95ModulePath), true, "the RPL-95 source module path must be absolute");

const rpl95 = await import(pathToFileURL(rpl95ModulePath).href);
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f4-rpl95-attempt-integration-"));
const replacedRoot = stateRoot + ".previous";
const hostRecordPath = stateRoot + ".host-binding.json";
let userLocalReads = 0;
const userLocalState = Object.freeze({
  resolveUserLocalStateLocation: rpl95.resolveUserLocalStateLocation,
  readUserLocalState(location) {
    userLocalReads += 1;
    return rpl95.readUserLocalState(location);
  },
  publishUserLocalStateAtomically: rpl95.publishUserLocalStateAtomically,
  withPhysicalStateLock: rpl95.withPhysicalStateLock,
});

try {
  const identity = attemptIdentity("123e4567-e89b-42d3-a456-426614174000");
  const first = createAttemptService();
  const firstBinding = first.provider.readPhysicalStateBinding();
  assert.equal(firstBinding.ok, true, JSON.stringify(firstBinding));
  const reserved = await first.service.reserveAttempt({ identity });
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  const claimed = await first.service.bindClaim({
    identity,
    expected_attempt_revision: reserved.value.revision,
    claim_revision: 2,
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const unknown = await first.service.markDispatchStarted({
    identity,
    expected_attempt_revision: claimed.value.revision,
    claim_revision: 2,
  });
  assert.equal(unknown.ok, true, JSON.stringify(unknown));
  assert.equal(unknown.value.status, "dispatch_unknown");

  const physicalState = rpl95.resolveUserLocalStateLocation(
    repositoryCwd,
    "f4/manual-resume-attempts/attempt-" + "0".repeat(64) + ".json",
    { stateRootOverride: stateRoot },
  );
  const directBinding = f4PhysicalStateBindingFromLocation(physicalState);
  assert.equal(directBinding.ok, true, JSON.stringify(directBinding));
  assert.equal(sameF4PhysicalStateBinding(firstBinding.value, directBinding.value), true);

  const attemptDirectory = path.join(
    stateRoot,
    "repositories",
    firstBinding.value.repository_instance_id,
    "worktrees",
    firstBinding.value.physical_worktree_id,
    "f4",
    "manual-resume-attempts",
  );
  const recordFiles = fs.readdirSync(attemptDirectory);
  assert.equal(recordFiles.length, 1);
  assert.match(recordFiles[0], /^attempt-[a-f0-9]{64}\.json$/);
  const persisted = JSON.parse(fs.readFileSync(path.join(attemptDirectory, recordFiles[0]), "utf8"));
  assert.equal(persisted.value.status, "dispatch_unknown");

  fs.writeFileSync(hostRecordPath, JSON.stringify(firstBinding.value), { flag: "wx", mode: 0o600 });
  assert.equal(path.relative(stateRoot, hostRecordPath).startsWith(".."), true);

  const restarted = createAttemptService();
  const resumedRead = await restarted.service.readAttempt({
    candidate_id: identity.candidate_id,
    action_kind: identity.action_kind,
  });
  assert.equal(resumedRead.ok, true, JSON.stringify(resumedRead));
  assert.equal(resumedRead.value.status, "dispatch_unknown");
  assert.equal(resumedRead.value.attempt_id, identity.attempt_id);
  const freshAttempt = await restarted.service.reserveAttempt({
    identity: attemptIdentity("123e4567-e89b-42d3-a456-426614174001"),
  });
  assert.deepEqual(freshAttempt, { ok: false, reason: "manual_resume_attempt_recovery_required" });

  const readsBeforeRootCheck = userLocalReads;
  fs.renameSync(stateRoot, replacedRoot);
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const afterRootReplacement = createAttemptService();
  const newBinding = afterRootReplacement.provider.readPhysicalStateBinding();
  assert.equal(newBinding.ok, true, JSON.stringify(newBinding));
  const independentlyRetainedHostBinding = JSON.parse(fs.readFileSync(hostRecordPath, "utf8"));
  assert.equal(newBinding.value.repository_instance_id, independentlyRetainedHostBinding.repository_instance_id);
  assert.equal(newBinding.value.physical_worktree_id, independentlyRetainedHostBinding.physical_worktree_id);
  assert.notEqual(newBinding.value.state_root_identity, independentlyRetainedHostBinding.state_root_identity);
  assert.equal(sameF4PhysicalStateBinding(independentlyRetainedHostBinding, newBinding.value), false);
  assert.equal(userLocalReads, readsBeforeRootCheck, "Host binding must reject the new root before Attempt read");

  process.stdout.write("F4/RPL-95 exact-source integration: PASS (UNKNOWN survives same-root restart; fresh Attempt blocked; replaced root mismatches the out-of-root Host binding fixture)\n");
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
  fs.rmSync(replacedRoot, { recursive: true, force: true });
  fs.rmSync(hostRecordPath, { force: true });
}

function createAttemptService() {
  const provider = createPendingHandoffManualResumeAttemptOutcomeUserLocalRecordProvider({
    cwd: repositoryCwd,
    userLocalState,
    stateRootOptions: { stateRootOverride: stateRoot },
  });
  assert.equal(provider.ok, true, JSON.stringify(provider));
  const attemptStore = createPendingHandoffManualResumeAttemptOutcomeStoreAdapter({
    recordStore: {
      readRecord: provider.value.readRecord,
      compareAndSetRecord: provider.value.compareAndSetRecord,
    },
  });
  assert.equal(attemptStore.ok, true, JSON.stringify(attemptStore));
  const service = createPendingHandoffManualResumeAttemptOutcomeService({ store: attemptStore.value });
  assert.equal(service.ok, true, JSON.stringify(service));
  return { provider: provider.value, service: service.value };
}

function attemptIdentity(attemptId) {
  return Object.freeze({
    candidate_id: "candidate-private-id",
    action_kind: "manual_resume",
    attempt_id: attemptId,
    runtime_id: "codex",
    actor_identity: "phr1.session.key_A-1." + "O".repeat(43),
    scope_ref: "candidate-private-id",
    repository_identity: "phr1.repository.key_A-1." + "R".repeat(43),
    worktree_identity: "phr1.worktree.key_A-1." + "W".repeat(43),
    candidate_revision: 1,
  });
}
