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

// The Host proves the old session is stopped and provides a reserved successor
// identity. Reserving an identity must not start execution.
export async function handoffF4Writer({
  scope, task, previous, successor, expectedRevision, associationStore,
  restoreWorkspace, acceptHandoff, launchWriter,
}) {
  if (scope.taskRef !== task.id) return { ok: false, reason: "handoff_scope_mismatch" };
  const workspace = await restoreWorkspace(task);
  if (workspace.taskId !== task.id || workspace.commit !== task.commit
    || workspace.checkpoint !== task.checkpoint
    || await acceptHandoff({ scope, task, previous, successor, workspace }) !== true) {
    return { ok: false, reason: "handoff_not_accepted" };
  }

  let assignment;
  try {
    assignment = associationStore.replaceWriter(scope, { previous, successor, expectedRevision });
  } catch (error) {
    if (error.message === "association_revision_conflict") return { ok: false, reason: "handoff_already_changed" };
    throw error;
  }
  try {
    return await launchWriter({ task, workspace, successor, associationRevision: assignment.revision });
  } catch {
    // The launch may have succeeded. Reconcile the assigned session before retry.
    return { ok: false, reason: "recovery_required", associationRevision: assignment.revision };
  }
}
