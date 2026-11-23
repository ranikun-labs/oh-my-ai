import { createHash } from "node:crypto";
import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";
import {
  publishUserLocalStateAtomically,
  readUserLocalState,
  resolveUserLocalStateLocation,
  withPhysicalStateLock,
} from "./user-local-state.mjs";

const roles = new Set(["coordinator", "writer", "reviewer", "architect"]);
const statuses = new Set(["active", "paused", "completed", "detached"]);
const transitions = {
  active: new Set(["paused", "completed", "detached"]),
  paused: new Set(["active", "completed", "detached"]),
};

function isIdentity(value, kind) {
  return validateOpaqueIdentity(value).kind === kind;
}

function requireAssociation(record) {
  if (!record || Object.keys(record).length !== 4
    || !/^[a-z][a-z0-9-]{0,31}$/.test(record.runtimeId ?? "")
    || typeof record.runtimeId !== "string"
    || !isIdentity(record.sessionId, "session")
    || !roles.has(record.role)
    || !statuses.has(record.status)) {
    throw new Error("association_record_invalid");
  }
  return record;
}

export function createTaskSessionAssociationStore({ cwd, stateRootOptions }) {
  function access(scope, operation) {
    const { taskRef, repositoryId, worktreeId } = scope;
    if (typeof taskRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(taskRef)
      || !isIdentity(repositoryId, "repository") || !isIdentity(worktreeId, "worktree")) {
      throw new Error("association_scope_invalid");
    }
    const scopeKey = createHash("sha256").update(JSON.stringify([taskRef, repositoryId, worktreeId])).digest("hex");
    const location = resolveUserLocalStateLocation(cwd, `task-session/association-${scopeKey}.json`, stateRootOptions);
    return withPhysicalStateLock(location, () => {
      const source = readUserLocalState(location);
      const current = source === null
        ? { version: 1, scopeKey, revision: 0, associations: [] }
        : JSON.parse(source);
      if (current?.version !== 1 || current.scopeKey !== scopeKey
        || !Number.isSafeInteger(current.revision) || current.revision < 0
        || !Array.isArray(current.associations)) {
        throw new Error("association_record_invalid");
      }
      current.associations.forEach(requireAssociation);
      return operation(current, associations => {
        const next = { ...current, revision: current.revision + 1, associations };
        publishUserLocalStateAtomically(location, JSON.stringify(next));
        return next;
      });
    });
  }

  function update(scope, { runtimeId, sessionId, role, expectedRevision }, status, link) {
    const desired = requireAssociation({ runtimeId, sessionId, role, status });
    return access(scope, (current, publish) => {
      const index = current.associations.findIndex(record =>
        record.runtimeId === runtimeId && record.sessionId === sessionId && record.role === role);
      const prior = current.associations[index];
      if (prior?.status === status) return current;
      if (expectedRevision !== current.revision) throw new Error("association_revision_conflict");
      if (link ? prior !== undefined : !transitions[prior?.status]?.has(status)) {
        throw new Error("association_transition_invalid");
      }
      if (role === "writer" && status === "active" && current.associations.some(record =>
        record.role === "writer" && record.status === "active")) {
        throw new Error("association_active_writer_exists");
      }
      return publish(index < 0
        ? [...current.associations, desired]
        : current.associations.map((record, position) => position === index ? desired : record));
    });
  }

  return Object.freeze({
    read: scope => access(scope, current => current),
    link: (scope, input) => update(scope, input, "active", true),
    setStatus: (scope, input) => update(scope, input, input.status, false),
  });
}
