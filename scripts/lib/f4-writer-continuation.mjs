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
  scope, task, previous, successor, expectedRevision, associationStore,
  withFrozenSource, restoreWorkspace, acceptHandoff, discardWorkspace, launchWriter,
}) {
  if (scope.taskRef !== task.id) return { ok: false, reason: "handoff_scope_mismatch" };
  let workspace;
  let assignment;
  try {
    const result = await withFrozenSource({ scope, task, previous }, async () => {
      workspace = await restoreWorkspace(task);
      if (workspace.taskId !== task.id || workspace.commit !== task.commit
        || workspace.checkpoint !== task.checkpoint) return { ok: false, reason: "handoff_not_accepted" };
      const acceptedScope = await acceptHandoff({ scope, task, previous, successor, workspace });
      if (acceptedScope?.taskRef !== scope.taskRef || acceptedScope.repositoryId !== scope.repositoryId
        || acceptedScope.worktreeId !== scope.worktreeId) {
        return { ok: false, reason: "handoff_scope_not_supported" };
      }
      try {
        assignment = associationStore.replaceWriter(scope, { previous, successor, expectedRevision });
        return { ok: true };
      } catch (error) {
        if (error.message === "association_revision_conflict") return { ok: false, reason: "handoff_already_changed" };
        throw error;
      }
    });
    if (!assignment) return result ?? { ok: false, reason: "recovery_required" };
    if (result?.ok === true) {
      const launched = await launchWriter({ task, workspace, successor, associationRevision: assignment.revision });
      if (launched?.ok === true) return launched;
    }
  } catch (error) {
    if (!assignment) throw error;
  } finally {
    if (workspace && !assignment) await discardWorkspace(workspace);
  }
  // Reconcile the assigned session before retrying any uncertain launch.
  return { ok: false, reason: "recovery_required", associationRevision: assignment.revision };
}
