/**
 * Project a Result already accepted by the canonical Inventory owner into
 * the existing Scope Checkpoint. The Host port must keep the canonical Result,
 * Inventory revision, and approval valid while it awaits the callback. If it
 * cannot guard publication, it must return "pending" without calling it. A raw
 * Worker event or a successful test outcome cannot authorize a DONE update.
 */
export function createF4WorkerResultCheckpointReconciler({
  withCurrentInventoryResult, readScopeCheckpoint, reconcileScopeCheckpoint, projectScopeCheckpoint,
}) {
  return async function reconcileResultCheckpoint({ record, digest }) {
    const request = { objectiveId: record.objectiveId };
    let guardOpen = true;
    const project = async (observation, isCurrentWriter = () => true) => {
      const scope = observation?.approvedScope;
      const refresh = observation?.refresh;
      if ((observation?.status === "DONE" && record.outcome !== "passed")
        || observation?.resultDigest !== digest
        || observation.workstreamId !== record.workstreamId
        || scope?.objectiveId !== record.objectiveId
        || scope.scopeRevision !== record.scopeRevision
        || refresh?.coverage !== "COMPLETE"
        || !Array.isArray(refresh.observations)
        || !refresh.observations.some(item =>
          item.id === record.workstreamId && item.status === observation.status)) {
        return "pending";
      }

      const approvedSource = uri => typeof uri === "string"
        && (scope.source?.uri === uri || scope.requiredSources?.some(source => source.uri === uri));
      if (!approvedSource(refresh.sourceUri)) return "pending";
      if (refresh.observations.filter(item => item.id === record.workstreamId).length !== 1) return "pending";
      const current = await readScopeCheckpoint(request);
      if (!guardOpen || current?.ok !== true || current.value?.scopeRevision !== record.scopeRevision) return "pending";
      const applied = checkpoint => checkpoint?.objectiveId === record.objectiveId
        && checkpoint.scopeRevision === record.scopeRevision
        && checkpoint.sourceCoverage?.some(source => source.uri === refresh.sourceUri
          && source.revision === refresh.sourceRevision && source.coverage === "COMPLETE")
        && checkpoint.inventory?.some(item => item.id === record.workstreamId
          && item.scopeMember === true && item.status === observation.status
          && (item.status === "DONE"
            ? approvedSource(item.sourceUri)
            : item.sourceUri === refresh.sourceUri && item.sourceRevision === refresh.sourceRevision));
      const currentSource = current.value.sourceCoverage.find(source => source.uri === refresh.sourceUri);
      if (refresh.refreshScope === "INCREMENTAL_DELTA" && currentSource?.coverage !== "COMPLETE") return "pending";

      const update = {
        approvedScope: scope,
        expectedCheckpointRevision: current.value.checkpointRevision,
        refresh: refresh.refreshScope === "FULL_SOURCE"
          ? { ...refresh, expectedPriorRevision: currentSource?.revision ?? null } : refresh,
        recentExecution: null,
        nextReadyId: current.value.nextReadyId,
        stopReason: ["PARTIAL_DISCOVERY", "NO_VERIFIED_READY"].includes(current.value.stopReason)
          ? null : current.value.stopReason,
      };
      if (applied(current.value)) {
        const afterScopeCheck = projectScopeCheckpoint({
          ...update, refresh: null, currentCheckpoint: current.value,
        });
        return afterScopeCheck?.ok === true ? "already_applied" : "pending";
      }
      const planned = projectScopeCheckpoint({ ...update, currentCheckpoint: current.value });
      if (!guardOpen || planned?.ok !== true || !applied(planned.checkpoint)) return "pending";
      let committed = false;
      try {
        const updated = await reconcileScopeCheckpoint(update, () => guardOpen && isCurrentWriter());
        committed = updated?.ok === true && applied(updated.checkpoint);
      } catch {
        // Re-read after an ambiguous publication. Never dispatch from this path.
      }
      if (!guardOpen) return "pending";
      const after = await readScopeCheckpoint(request);
      if (!guardOpen || after?.ok !== true || !applied(after.value)) return "pending";
      return committed ? "applied" : "already_applied";
    };
    let projected;
    let resultStatus;
    try {
      const guardedStatus = await withCurrentInventoryResult({ record, digest }, (observation, isCurrentWriter) => {
        if (!guardOpen) return "pending";
        projected ??= project(observation, isCurrentWriter).catch(() => "pending").then(status => {
          resultStatus = status;
          return status;
        });
        return projected;
      });
      return resultStatus !== undefined && guardedStatus === resultStatus ? guardedStatus : "pending";
    } finally {
      guardOpen = false;
    }
  };
}
