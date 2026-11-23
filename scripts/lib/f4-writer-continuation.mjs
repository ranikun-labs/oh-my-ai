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
