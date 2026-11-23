// The host supplies fresh session observations, isolated workspaces, and the
// existing checkpoint. This module does not treat session lookup as approval.
export async function continueF4Writer({ task, observeWriter, resumeWriter, startWriter }) {
  const observed = await observeWriter(task);
  if (observed.status === "available") {
    return resumeWriter({ task, session: observed.session });
  }
  if (!["unavailable", "unknown"].includes(observed.status)) {
    throw new Error("writer_observation_invalid");
  }

  // An indeterminate old session may still write. The host must give the
  // successor an isolated workspace before it can start.
  return startWriter({
    task,
    previousSession: observed.session ?? null,
    requireIsolatedWorkspace: true,
    previousStatus: observed.status,
  });
}
