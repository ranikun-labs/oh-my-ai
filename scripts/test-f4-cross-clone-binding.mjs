import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareF4HandoffWorkspace } from "./lib/f4-handoff-workspace.mjs";
import { handoffF4Writer } from "./lib/f4-writer-continuation.mjs";
import { deriveWorktreeIdentity } from "./lib/pending-handoff-identity.mjs";

const root = mkdtempSync(path.join(tmpdir(), "f4-cross-clone-"));
const source = path.join(root, "source");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
try {
  git(root, "init", "-q", source);
  git(source, "config", "user.email", "test@example.invalid");
  git(source, "config", "user.name", "Test");
  writeFileSync(path.join(source, "tracked"), "original\n");
  git(source, "add", "tracked");
  git(source, "commit", "-qm", "initial");
  const task = { id: "TASK", commit: git(source, "rev-parse", "HEAD"), checkpoint: "checkpoint" };
  const repositoryId = `phr1.repository.test.${"r".repeat(43)}`;
  const derive = workspace => deriveWorktreeIdentity({ repository_identity: repositoryId,
    verified_canonical_root: realpathSync(workspace), key_id: "test",
    keyed_digest: ({ bytes }) => createHash("sha256").update(bytes).digest("base64url") }).identity;
  writeFileSync(path.join(source, "tracked"), "continued\n");
  const scope = { taskRef: task.id, repositoryId, worktreeId: derive(source) };
  let persisted;
  const result = await handoffF4Writer({
    scope, task, previous: {}, successor: {}, expectedRevision: 1,
    withFrozenSource: (_input, run) => run(),
    restoreWorkspace: () => prepareF4HandoffWorkspace({ source, parentDirectory: root, task }),
    deriveDestinationScope: ({ workspace }) => ({ ...scope, worktreeId: derive(workspace.workspace) }),
    acceptHandoff: ({ destinationScope }) => destinationScope,
    associationStore: { replaceWriter: (_scope, assignment) => { persisted = assignment; return { revision: 2 }; } },
    discardWorkspace: () => assert.fail("accepted workspace must remain available"),
    launchWriter: ({ workspace, destinationScope }) => {
      assert.equal(destinationScope.worktreeId, derive(workspace.workspace));
      assert.notEqual(destinationScope.worktreeId, scope.worktreeId);
      assert.equal(readFileSync(path.join(workspace.workspace, "tracked"), "utf8"), "continued\n");
      return { ok: true };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(persisted.destinationScope.worktreeId, derive(persisted.workspaceRef));
  console.log("F4 restored clone binding PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
