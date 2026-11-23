import { types as utilTypes } from "node:util";

// A Host supplies the task scope and the existing runtime resolution port.
export function bindTaskWriterSessionResolution({ associationStore, scope, sessionResolution }) {
  return bindTaskWriterRuntime({ associationStore, scope, sessionResolution }).sessionResolution;
}

export function bindTaskWriterRuntime({ associationStore, scope, sessionResolution, executor }) {
  const taskScope = Object.freeze({
    taskRef: scope.taskRef,
    repositoryId: scope.repositoryId,
    worktreeId: scope.worktreeId,
  });

  function readWriter() {
    const snapshot = associationStore.read(taskScope);
    if (!snapshot || utilTypes.isProxy(snapshot) || !Number.isSafeInteger(snapshot.revision)
      || snapshot.revision < 0 || !Array.isArray(snapshot.associations)
      || utilTypes.isProxy(snapshot.associations)) {
      throw new Error("association_snapshot_invalid");
    }
    const writers = snapshot.associations.filter(
      record => record.role === "writer" && record.status === "active",
    );
    return { revision: snapshot.revision, writer: writers.length === 1 ? writers[0] : null };
  }

  const resolution = Object.freeze({
    resolveCurrentSession: request => sessionResolution.resolveCurrentSession(request),
    async resolveTargetSession(request) {
      try {
        const before = readWriter();
        if (before.writer?.runtimeId !== request.runtime_id
          || before.writer?.sessionId !== request.session_identity) {
          return failure("session_resolution_denied");
        }
        const observation = await sessionResolution.resolveTargetSession(request);
        const after = readWriter();
        if (after.revision !== before.revision
          || after.writer?.runtimeId !== before.writer.runtimeId
          || after.writer?.sessionId !== before.writer.sessionId) {
          return failure("session_resolution_stale");
        }
        return observation;
      } catch {
        return failure("session_resolution_unavailable");
      }
    },
  });
  function canDispatch(request) {
    try {
      const { writer } = readWriter();
      return writer?.runtimeId === request.target.runtime_id
        && writer?.sessionId === request.target.session_identity;
    } catch {
      return false;
    }
  }

  return {
    sessionResolution: resolution,
    executor: executor === undefined ? undefined : Object.freeze({
      canDispatch,
      resolveAndResume(request) {
        if (!canDispatch(request)) return failure("codex_action_denied");
        return executor.resolveAndResume(request);
      },
    }),
  };
}

function failure(reason) {
  return { ok: false, reason };
}
