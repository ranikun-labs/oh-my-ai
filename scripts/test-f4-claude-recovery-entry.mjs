import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskSessionAssociationStore } from "./lib/task-session-association.mjs";
import { createIdentitySecurityDependencies } from "./lib/pending-handoff-secret-provider.mjs";
import { deriveSourceSessionIdentity, deriveWorktreeIdentity } from "./lib/pending-handoff-identity.mjs";
import { recoverF4ClaudeWriterFromHost } from "./lib/f4-claude-recovery-entry.mjs";

const root = mkdtempSync(path.join(tmpdir(), "f4-host-"));
try {
  const workspace = path.join(root, "workspace");
  const alternate = path.join(root, "alternate");
  mkdirSync(alternate);
  symlinkSync(root, workspace);
  const provider = Object.freeze({ version: "phr-secret-provider-v1", current_key_id: "test",
    verification_key_ids: Object.freeze(["test"]),
    keyed_digest: Object.freeze(({ bytes }) => createHmac("sha256", "test-key").update(bytes).digest("base64url")),
    safe_equal: Object.freeze((a, b) => a === b) });
  const entry = createIdentitySecurityDependencies(provider).value.current;
  const repositoryId = `phr1.repository.test.${"r".repeat(43)}`;
  const worktreeId = deriveWorktreeIdentity({ repository_identity: repositoryId, verified_canonical_root: realpathSync(root), ...entry }).identity;
  const identity = raw => deriveSourceSessionIdentity({ runtime_id: "claude", raw_session_id: raw, ...entry }).identity;
  const scope = { taskRef: "TASK-1", repositoryId, worktreeId };
  const stateRootOptions = { stateRootOverride: root };
  const store = createTaskSessionAssociationStore({ cwd: process.cwd(), stateRootOptions });
  const previous = { runtimeId: "claude", sessionId: identity("old"), role: "writer" };
  const successor = { ...previous, sessionId: identity("native") };
  store.link(scope, { ...previous, expectedRevision: 0 });
  store.replaceWriter(scope, { previous, successor, expectedRevision: 1, destinationScope: scope, workspaceRef: workspace });
  let mode = "ok";
  let calls = 0;
  const options = { cwd: process.cwd(), stateRootOptions, provider, scope, task: { id: scope.taskRef },
    loadSdk: async () => ({ listSessions: () => {
      calls++;
      if (mode === "lost") throw Error("lost");
      if (mode === "rebind") { unlinkSync(workspace); symlinkSync(alternate, workspace); }
      if (mode === "drift") store.setStatus(scope, { ...successor, status: "paused", expectedRevision: 2 });
      return [{ sessionId: mode === "mismatch" ? "other" : "native" }];
    }, query: () => assert.fail("no turn or resume") }) };
  const recover = () => recoverF4ClaudeWriterFromHost(options);
  const results = await Promise.all([recover(), recover()]);
  assert.equal(calls, 2);
  assert.ok(results.every(result => result.ok && result.associationRevision === 2));
  for (mode of ["lost", "mismatch", "rebind"]) assert.deepEqual(await recover(), { ok: false, reason: "recovery_required" });
  const beforeMismatch = calls;
  assert.deepEqual(await recover(), { ok: false, reason: "recovery_required" });
  assert.equal(calls, beforeMismatch);
  unlinkSync(workspace);
  symlinkSync(root, workspace);
  mode = "drift";
  assert.deepEqual(await recover(), { ok: false, reason: "recovery_required" });
  assert.deepEqual(await recover(), { ok: false, reason: "recovery_required" });
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("F4 Claude recovery host entry PASS");
