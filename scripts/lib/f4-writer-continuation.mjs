import path from "node:path";
import { realpathSync } from "node:fs";

// The Host owns durable Claim/recovery and checks the actual workspace and
// restored checkpoint. No local flag can prove another Writer has stopped.
export async function continueF4Writer({ task, observeWriter, resumeWriter, handoffWriter }) {
  let observed;
  try {
    observed = await observeWriter(task);
  } catch {
    return { ok: false, reason: "recovery_required" };
  }
  if (observed?.status === "available" && observed.session) {
    return resumeWriter({ task, session: observed.session });
  }
  if (observed?.status === "unknown") {
    return { ok: false, reason: "recovery_required" };
  }
  if (observed?.status !== "unavailable") {
    throw new Error("writer_observation_invalid");
  }

  // The Host must atomically reserve the handoff, fence the old result, verify
  // the restored source and checkpoint, then launch the accepted successor.
  return handoffWriter({ task, previousSession: observed.session ?? null });
}

// The Host holds the original Writer's write fence through restoration and
// assignment. The reserved successor identity must not start execution.
export async function handoffF4Writer({
  scope, destinationScope = scope, sourceWorkspaceRef, task, previous, successor, expectedRevision, associationStore,
  withFrozenSource, restoreWorkspace, deriveDestinationScope, acceptHandoff, discardWorkspace, launchWriter,
}) {
  if (scope?.taskRef !== task.id || destinationScope?.taskRef !== task.id) {
    return { ok: false, reason: "handoff_scope_mismatch" };
  }
  const recovery = { ok: false, reason: "recovery_required" };
  let workspace;
  let assignment;
  let saveAttempted = false;
  let preparation;
  let fenceOpen = true;
  let failure = recovery;

  async function prepare() {
    workspace = await restoreWorkspace(task);
    if (!fenceOpen) return recovery;
    if (workspace.taskId !== task.id || workspace.commit !== task.commit
      || workspace.checkpoint !== task.checkpoint) return { ok: false, reason: "handoff_not_accepted" };
    // A fresh clone's path is only known after restoration. Let the Host derive
    // its scope from that actual workspace while the source remains fenced.
    if (workspace.workspace !== undefined || !sameScope(destinationScope, scope)) {
      if (typeof workspace.workspace !== "string" || !path.isAbsolute(workspace.workspace)
        || workspace.workspace.includes("\0") || typeof deriveDestinationScope !== "function") {
        return { ok: false, reason: "handoff_scope_not_supported" };
      }
      const requestedScope = destinationScope;
      const derivedScope = await deriveDestinationScope({ scope, task, workspace });
      if (!fenceOpen) return recovery;
      if (derivedScope?.taskRef !== task.id || !derivedScope.repositoryId || !derivedScope.worktreeId
        || derivedScope.workspaceRef !== workspace.workspace
        || (!sameScope(requestedScope, scope) && !sameScope(requestedScope, derivedScope))) {
        return { ok: false, reason: "handoff_scope_not_supported" };
      }
      if (sameScope(derivedScope, scope)) {
        try {
          if (typeof sourceWorkspaceRef !== "string" || !path.isAbsolute(sourceWorkspaceRef)
            || realpathSync(sourceWorkspaceRef) !== realpathSync(workspace.workspace)) {
            return { ok: false, reason: "handoff_scope_not_supported" };
          }
        } catch {
          return { ok: false, reason: "handoff_scope_not_supported" };
        }
      }
      destinationScope = { taskRef: derivedScope.taskRef, repositoryId: derivedScope.repositoryId,
        worktreeId: derivedScope.worktreeId };
    }
    const acceptedScope = await acceptHandoff({ scope, destinationScope, task, previous, successor, workspace });
    if (!fenceOpen) return recovery;
    if (acceptedScope?.taskRef !== destinationScope.taskRef || acceptedScope.repositoryId !== destinationScope.repositoryId
      || acceptedScope.worktreeId !== destinationScope.worktreeId) {
      return { ok: false, reason: "handoff_scope_not_supported" };
    }
    try {
      saveAttempted = true;
      assignment = associationStore.replaceWriter(scope, {
        previous, successor, expectedRevision, destinationScope, workspaceRef: workspace.workspace,
      });
      return { ok: true };
    } catch (error) {
      if (error.message === "association_revision_conflict") return { ok: false, reason: "handoff_already_changed" };
      throw error;
    }
  }

  try {
    // The Host must hold the write fence until the callback settles.
    const result = await withFrozenSource({ scope, task, previous }, () => {
      if (!fenceOpen) return recovery;
      preparation ??= prepare();
      // Observe rejection even if the Host fails to await this callback.
      preparation.catch(() => {});
      return preparation;
    });
    fenceOpen = false;
    if (preparation) {
      const prepared = await preparation;
      if (prepared.ok !== true) failure = prepared;
    }
    if (assignment && result?.ok === true) {
      const launched = await launchWriter({ task, workspace, successor, associationScope: scope,
        destinationScope, associationRevision: assignment.revision });
      if (launched?.ok === true) return launched;
    }
  } catch {
    fenceOpen = false;
    if (preparation) {
      const prepared = await preparation.catch(() => null);
      if (prepared?.ok === false && prepared.reason !== recovery.reason) {
        failure = { ...recovery, preparationFailure: prepared.reason };
      }
    }
  }
  if (saveAttempted && !assignment) {
    // A write may have committed before throwing. Delete only after a fresh
    // authoritative read proves neither this successor nor workspace is stored.
    let definitelyUnstored = false;
    let savedRevision;
    try {
      const current = await associationStore.read(scope);
      const saved = current.associations?.filter(row => row.role === "writer" && row.status === "active"
        && row.runtimeId === successor.runtimeId && row.sessionId === successor.sessionId
        && row.workspaceRef === workspace?.workspace && row.repositoryId === destinationScope.repositoryId
        && row.worktreeId === destinationScope.worktreeId);
      if (Number.isSafeInteger(current.revision) && saved?.length === 1) savedRevision = current.revision;
      definitelyUnstored = Number.isSafeInteger(current?.revision) && current.revision >= expectedRevision
        && Array.isArray(current.associations) && !current.associations.some(row =>
          (workspace?.workspace && row.workspaceRef === workspace.workspace)
          || (row.runtimeId === successor.runtimeId && row.sessionId === successor.sessionId
            && row.role === "writer" && !row.workspaceRef));
    } catch { /* unknown save outcome */ }
    if (!definitelyUnstored) return {
      ...recovery, associationScope: scope, destinationScope, successor, workspaceRef: workspace?.workspace,
      ...(savedRevision === undefined ? {} : { associationRevision: savedRevision }),
    };
  }
  if (assignment) return {
    ...recovery, associationRevision: assignment.revision, associationScope: scope,
    destinationScope, successor, workspaceRef: workspace.workspace,
  };
  if (workspace) {
    try {
      await discardWorkspace(workspace);
    } catch {
      return { ...failure, workspaceCleanup: "failed", workspace: workspace.workspace };
    }
  }
  return failure;
}

function sameScope(left, right) {
  return left?.taskRef === right?.taskRef && left?.repositoryId === right?.repositoryId
    && left?.worktreeId === right?.worktreeId;
}

// Recovery is a read-only lookup of the persisted owner. An unknown or
// unavailable Host response never authorizes another launch or resume.
export async function recoverF4Writer({ scope, task, associationStore, observeWriter }) {
  const recovery = { ok: false, reason: "recovery_required" };
  try {
    if (scope?.taskRef !== task?.id) return recovery;
    const current = await associationStore.read(scope);
    const writers = current.associations.filter(row => row.role === "writer" && row.status === "active");
    if (!Number.isSafeInteger(current.revision) || writers.length !== 1) return recovery;
    const writer = writers[0];
    if (!writer.repositoryId || !writer.worktreeId || typeof writer.workspaceRef !== "string"
      || !path.isAbsolute(writer.workspaceRef) || writer.workspaceRef.includes("\0")) return recovery;
    const destinationScope = { taskRef: scope.taskRef, repositoryId: writer.repositoryId, worktreeId: writer.worktreeId };
    const request = { task, associationScope: scope, associationRevision: current.revision,
      destinationScope, successor: { runtimeId: writer.runtimeId, sessionId: writer.sessionId, role: writer.role },
      workspaceRef: writer.workspaceRef };
    const observed = await observeWriter(request);
    if (observed?.status !== "available" || !observed.session
      || observed.sessionIdentity !== writer.sessionId) return recovery;
    const fresh = await associationStore.read(scope);
    const active = fresh.associations.filter(row => row.role === "writer" && row.status === "active");
    if (fresh.revision !== current.revision || active.length !== 1
      || active[0].runtimeId !== writer.runtimeId || active[0].sessionId !== writer.sessionId
      || active[0].workspaceRef !== writer.workspaceRef || active[0].repositoryId !== writer.repositoryId
      || active[0].worktreeId !== writer.worktreeId) return recovery;
    return { ok: true, ...request, session: observed.session };
  } catch {
    return recovery;
  }
}
