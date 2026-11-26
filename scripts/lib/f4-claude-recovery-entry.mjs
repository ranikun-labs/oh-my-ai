import { realpathSync } from "node:fs";
import { createTaskSessionAssociationStore } from "./task-session-association.mjs";
import { createIdentitySecurityDependencies } from "./pending-handoff-secret-provider.mjs";
import { deriveSourceSessionIdentity, deriveWorktreeIdentity, validateOpaqueIdentity } from "./pending-handoff-identity.mjs";
import { recoverF4ClaudeWriter } from "./f4-claude-writer-recovery.mjs";

// The caller supplies the same state root and secret provider used to register the Writer.
export async function recoverF4ClaudeWriterFromHost({ cwd, stateRootOptions, provider, scope, task, loadSdk }) {
  const failure = { ok: false, reason: "recovery_required" };
  try {
    const dependencies = createIdentitySecurityDependencies(provider);
    if (!dependencies.ok) return failure;
    const store = createTaskSessionAssociationStore({ cwd, stateRootOptions });
    const snapshot = store.read(scope);
    const writers = snapshot.associations.filter(row => row.role === "writer" && row.status === "active");
    if (writers.length !== 1) return failure;
    const writer = writers[0];
    const sessionKey = validateOpaqueIdentity(writer.sessionId);
    const worktreeKey = validateOpaqueIdentity(writer.worktreeId);
    const sessionEntry = dependencies.value.verification.find(entry => entry.key_id === sessionKey.key_id);
    const worktreeEntry = dependencies.value.verification.find(entry => entry.key_id === worktreeKey.key_id);
    if (!sessionKey.ok || sessionKey.kind !== "session" || !worktreeKey.ok || worktreeKey.kind !== "worktree"
      || !sessionEntry || !worktreeEntry) return failure;
    const workspace = realpathSync(writer.workspaceRef);
    const worktree = deriveWorktreeIdentity({ repository_identity: writer.repositoryId,
      verified_canonical_root: workspace, ...worktreeEntry });
    if (!worktree.ok || !dependencies.value.safe_equal(worktree.identity, writer.worktreeId)) return failure;
    const associationStore = { read(readScope) {
      const current = store.read(readScope);
      const active = current.associations.filter(row => row.role === "writer" && row.status === "active");
      if (current.revision !== snapshot.revision || active.length !== 1
        || active[0].sessionId !== writer.sessionId || active[0].workspaceRef !== writer.workspaceRef
        || active[0].repositoryId !== writer.repositoryId || active[0].worktreeId !== writer.worktreeId
        || realpathSync(writer.workspaceRef) !== workspace) throw new Error("recovery_binding_changed");
      return current;
    } };
    return await recoverF4ClaudeWriter({ scope, task, associationStore, loadSdk,
      sessionIdentityDeriver: input => deriveSourceSessionIdentity({ ...input, ...sessionEntry }) });
  } catch {
    return failure;
  }
}
