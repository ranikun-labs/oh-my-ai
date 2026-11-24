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
  scope, destinationScope = scope, task, previous, successor, expectedRevision, associationStore,
  withFrozenSource, restoreWorkspace, deriveDestinationScope, acceptHandoff, discardWorkspace, launchWriter,
}) {
  if (scope?.taskRef !== task.id || destinationScope?.taskRef !== task.id) {
    return { ok: false, reason: "handoff_scope_mismatch" };
  }
  const recovery = { ok: false, reason: "recovery_required" };
  let workspace;
  let assignment;
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
    if (deriveDestinationScope) {
      destinationScope = await deriveDestinationScope({ scope, task, workspace });
      if (!fenceOpen) return recovery;
      if (destinationScope?.taskRef !== task.id) return { ok: false, reason: "handoff_scope_mismatch" };
    }
    const acceptedScope = await acceptHandoff({ scope, destinationScope, task, previous, successor, workspace });
    if (!fenceOpen) return recovery;
    if (acceptedScope?.taskRef !== destinationScope.taskRef || acceptedScope.repositoryId !== destinationScope.repositoryId
      || acceptedScope.worktreeId !== destinationScope.worktreeId) {
      return { ok: false, reason: "handoff_scope_not_supported" };
    }
    try {
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
