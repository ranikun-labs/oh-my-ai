import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

const STATUS = new Set(["READY", "BLOCKED", "WAITING", "DONE"]);
const COVERAGE = new Set(["COMPLETE", "PARTIAL_DISCOVERY"]);
const REFRESH_SCOPES = new Set(["FULL_SOURCE", "INCREMENTAL_DELTA"]);
const PARTIAL_REASONS = new Set(["PAGINATION", "PERMISSION", "NETWORK", "SOURCE_FAILURE", "UNKNOWN"]);
const STOP_REASONS = new Set([
  "NO_VERIFIED_READY",
  "PARTIAL_DISCOVERY",
  "REVISION_CONFLICT",
  "SCOPE_CHANGE_REQUIRES_REVIEW",
  "OWNER_DECISION_REQUIRED",
]);

/**
 * Build an F4 checkpoint projection without replacing the approved Objective
 * scope with the most recently queried work. This is a pure projection: the
 * caller must persist it with the canonical store's revision CAS and supply
 * source observations from trusted Jira/GitHub readers.
 *
 * Scope revision changes fail closed until a trusted authority verifier is
 * configured at the Host boundary. This helper does not discover tasks,
 * dispatch Actors, or act as an Inventory server.
 */
export function createF4ScopePreservingCheckpoint(input) {
  const snapshot = snapshotData(input);
  if (!snapshot.ok) return blocked("INVALID_CHECKPOINT_INPUT", null);
  const validation = validateInput(snapshot.value);
  if (!validation.ok) return blocked(validation.reason, null);

  const {
    approvedScope,
    currentCheckpoint,
    expectedCheckpointRevision,
    refresh,
    recentExecution,
    nextReadyId,
    stopReason,
  } = validation.value;

  const currentRevision = currentCheckpoint?.checkpointRevision ?? null;
  if (currentRevision !== expectedCheckpointRevision) {
    return blocked("STALE_CHECKPOINT_REVISION", currentCheckpoint);
  }
  if (currentCheckpoint !== null
    && currentCheckpoint.objectiveId !== approvedScope.objectiveId) {
    return blocked("OBJECTIVE_MISMATCH", currentCheckpoint);
  }

  const scopeChanged = currentCheckpoint !== null
    && currentCheckpoint.scopeRevision !== approvedScope.scopeRevision;
  if (currentCheckpoint !== null && !scopeChanged
    && !hasSameScopeContent(currentCheckpoint, approvedScope)) {
    return blocked("SCOPE_CONTENT_MISMATCH_REQUIRES_NEW_REVISION", currentCheckpoint);
  }
  if (scopeChanged) return blocked("SCOPE_CHANGE_REQUIRES_TRUSTED_VERIFIER", currentCheckpoint);

  const approvedById = new Map(approvedScope.items.map(item => [item.id, item]));
  const inventoryById = new Map();

  // Preserve every prior row, including DONE/BLOCKED/WAITING. A verified
  // scope-revision transition needs a Host verifier and is blocked above.
  for (const item of currentCheckpoint?.inventory ?? []) {
    inventoryById.set(item.id, {
      id: item.id,
      primaryJira: item.primaryJira ?? null,
      owner: item.owner ?? null,
      status: item.status,
      scopeMember: approvedById.has(item.id),
      sourceUri: item.sourceUri ?? null,
      sourceRevision: item.sourceRevision ?? null,
    });
  }

  // Newly approved scope members start WAITING. They cannot become READY from
  // discovery alone; a trusted source observation must explicitly establish it.
  for (const item of approvedScope.items) {
    const prior = inventoryById.get(item.id);
    inventoryById.set(item.id, {
      id: item.id,
      primaryJira: item.primaryJira ?? null,
      owner: item.owner ?? null,
      status: prior?.status ?? "WAITING",
      scopeMember: true,
      sourceUri: prior?.sourceUri ?? null,
      sourceRevision: prior?.sourceRevision ?? null,
    });
  }

  const allowedSourceUris = new Set([
    approvedScope.source.uri,
    ...approvedScope.requiredSources.map(source => source.uri),
  ]);
  const sourceCoverage = new Map();
  for (const source of currentCheckpoint?.sourceCoverage ?? []) {
    if (!allowedSourceUris.has(source.uri)) continue;
    sourceCoverage.set(source.uri, {
      uri: source.uri,
      revision: source.revision ?? null,
      coverage: source.coverage,
    });
  }
  if (!sourceCoverage.has(approvedScope.source.uri)) {
    sourceCoverage.set(approvedScope.source.uri, {
      uri: approvedScope.source.uri,
      revision: approvedScope.source.revision,
      coverage: approvedScope.source.coverage,
    });
  }

  const unverifiedRanges = new Map(
    (currentCheckpoint?.unverifiedDiscoveryRanges ?? []).map(range => [discoveryKey(range), range]),
  );
  const unverifiedDiscoveries = new Map(
    (currentCheckpoint?.unverifiedDiscoveries ?? []).map(item => [discoveryKey(item), item]),
  );
  if (sourceCoverage.get(approvedScope.source.uri)?.coverage === "PARTIAL_DISCOVERY") {
    const range = {
      sourceUri: approvedScope.source.uri,
      sourceRevision: approvedScope.source.revision,
      reason: "UNKNOWN",
    };
    unverifiedRanges.set(discoveryKey(range), range);
  }

  if (refresh !== null) {
    const previousSourceRevision = sourceCoverage.get(refresh.sourceUri)?.revision ?? null;
    const previousSourceCoverage = sourceCoverage.get(refresh.sourceUri)?.coverage ?? null;
    if (previousSourceRevision !== refresh.expectedPriorRevision) {
      return blocked("INVENTORY_SOURCE_REVISION_CONFLICT", currentCheckpoint);
    }
    if (refresh.sourceUri === approvedScope.source.uri
      && refresh.sourceRevision !== null
      && refresh.sourceRevision !== approvedScope.source.revision) {
      return blocked("SCOPE_SOURCE_REVISION_MISMATCH_REQUIRES_NEW_SCOPE_REVISION", currentCheckpoint);
    }
    const trustedSource = allowedSourceUris.has(refresh.sourceUri);
    const effectiveCoverage = refresh.refreshScope === "INCREMENTAL_DELTA"
      && previousSourceCoverage !== "COMPLETE"
      ? "PARTIAL_DISCOVERY"
      : refresh.coverage;
    const recordedSourceUri = trustedSource ? refresh.sourceUri : hashUri(refresh.sourceUri);
    const recordedSourceRevision = trustedSource || refresh.sourceRevision === null
      ? refresh.sourceRevision
      : hashRevision(refresh.sourceRevision);
    if (trustedSource) {
      sourceCoverage.set(refresh.sourceUri, {
        uri: refresh.sourceUri,
        revision: refresh.sourceRevision,
        coverage: effectiveCoverage,
      });
      if (effectiveCoverage === "COMPLETE") {
        for (const [key, range] of unverifiedRanges) {
          if (range.sourceUri === refresh.sourceUri) unverifiedRanges.delete(key);
        }
      }
    } else {
      const range = {
        sourceUri: recordedSourceUri,
        sourceRevision: recordedSourceRevision,
        reason: "UNKNOWN",
      };
      unverifiedRanges.set(discoveryKey(range), range);
    }
    if (trustedSource && effectiveCoverage === "PARTIAL_DISCOVERY") {
      const reasons = refresh.partialReasons.length > 0 ? refresh.partialReasons : ["UNKNOWN"];
      for (const reason of reasons) {
        const range = {
          sourceUri: recordedSourceUri,
          sourceRevision: recordedSourceRevision,
          reason,
        };
        unverifiedRanges.set(discoveryKey(range), range);
      }
    }

    for (const observation of refresh.observations) {
      if (!trustedSource || !approvedById.has(observation.id)) {
        const discovery = {
          id: observation.id,
          sourceUri: recordedSourceUri,
          sourceRevision: recordedSourceRevision,
          disposition: trustedSource ? "UNVERIFIED_OUT_OF_SCOPE" : "UNVERIFIED_SOURCE",
        };
        unverifiedDiscoveries.set(discoveryKey(discovery), discovery);
        continue;
      }
      const prior = inventoryById.get(observation.id);
      inventoryById.set(observation.id, {
        id: prior.id,
        primaryJira: prior.primaryJira,
        owner: prior.owner,
        status: observation.status,
        scopeMember: true,
        sourceUri: refresh.sourceUri,
        sourceRevision: refresh.sourceRevision,
      });
    }
  }

  const activeInventory = [...inventoryById.values()]
    .filter(item => item.scopeMember)
    .sort((left, right) => left.id.localeCompare(right.id));
  const coverageRows = [...sourceCoverage.values()].sort((left, right) => left.uri.localeCompare(right.uri));
  const requiredSourceCoverageComplete = approvedScope.requiredSources.every(required => {
    const observed = sourceCoverage.get(required.uri);
    return observed?.coverage === "COMPLETE" && observed.revision !== null;
  });
  const scopeSourceCoverage = sourceCoverage.get(approvedScope.source.uri);
  const scopeCoverageComplete = approvedScope.source.coverage === "COMPLETE"
    && scopeSourceCoverage?.coverage === "COMPLETE"
    && scopeSourceCoverage.revision !== null
    && scopeSourceCoverage.revision === approvedScope.source.revision
    && requiredSourceCoverageComplete
    && approvedScope.items.every(item => inventoryById.has(item.id));
  const statuses = Object.fromEntries([...STATUS].map(status => [
    status,
    activeInventory.filter(item => item.status === status).length,
  ]));
  const requestedReady = nextReadyId !== null
    && activeInventory.some(item => item.id === nextReadyId && item.status === "READY")
    ? nextReadyId
    : null;
  const verifiedNextReady = requestedReady
    ?? activeInventory.find(item => item.status === "READY")?.id
    ?? null;
  const normalizedStopReason = stopReason === "NO_VERIFIED_READY" && verifiedNextReady !== null
    ? null
    : stopReason;
  const resolvedStopReason = normalizedStopReason
    ?? (!scopeCoverageComplete
      ? "PARTIAL_DISCOVERY"
      : activeInventory.every(item => item.status === "DONE")
        ? null
        : verifiedNextReady === null ? "NO_VERIFIED_READY" : null);
  const checkpoint = {
    objectiveId: approvedScope.objectiveId,
    scopeRevision: approvedScope.scopeRevision,
    // Keep the immutable approved scope citation separate from mutable
    // observations in sourceCoverage.
    scopeSource: { ...approvedScope.source },
    requiredSources: approvedScope.requiredSources.map(source => ({ uri: source.uri })),
    sourceCoverage: coverageRows,
    inventory: [...inventoryById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    statusSummary: statuses,
    scopeCoverage: scopeCoverageComplete ? "COMPLETE" : "PARTIAL_DISCOVERY",
    recentExecution: recentExecution === null ? currentCheckpoint?.recentExecution ?? null : { ...recentExecution },
    unverifiedDiscoveryRanges: [...unverifiedRanges.values()].sort(compareDiscovery),
    unverifiedDiscoveries: [...unverifiedDiscoveries.values()].sort(compareDiscovery),
    nextReadyId: verifiedNextReady,
    stopReason: resolvedStopReason,
    goalDoneEligible: scopeCoverageComplete
      && activeInventory.every(item => item.status === "DONE")
      && resolvedStopReason === null,
    checkpointRevision: currentRevision === null ? 1 : currentRevision + 1,
  };
  return { ok: true, accepted: true, checkpoint };
}

export function isF4ScopePreservationCheckpoint(value) {
  const snapshot = snapshotData(value);
  return snapshot.ok && isCheckpoint(snapshot.value);
}

function validateInput(input) {
  try {
    const checks = {
      plain: isPlainObject(input),
      keys: isPlainObject(input) && hasOnlyKeys(input, [
        "approvedScope", "currentCheckpoint", "expectedCheckpointRevision", "refresh",
        "recentExecution", "nextReadyId", "stopReason",
      ]),
      scope: isApprovedScope(input.approvedScope),
      checkpoint: input.currentCheckpoint === null || isF4ScopePreservationCheckpoint(input.currentCheckpoint),
      expectedRevision: input.expectedCheckpointRevision === null || isNonnegativeInteger(input.expectedCheckpointRevision),
      refresh: input.refresh === null || isRefresh(input.refresh),
      execution: input.recentExecution === null || isRecentExecution(input.recentExecution),
      nextReady: input.nextReadyId === null || isNonEmptyString(input.nextReadyId),
      stopReason: input.stopReason === null || STOP_REASONS.has(input.stopReason),
    };
    if (!Object.values(checks).every(Boolean)) {
      return { ok: false, reason: "INVALID_CHECKPOINT_INPUT" };
    }
    return { ok: true, value: input };
  } catch {
    return { ok: false, reason: "INVALID_CHECKPOINT_INPUT" };
  }
}

function isApprovedScope(scope) {
  return isPlainObject(scope)
    && hasOnlyKeys(scope, ["objectiveId", "scopeRevision", "source", "requiredSources", "items"])
    && isSafeIdentifier(scope.objectiveId)
    && isSafeRevision(scope.scopeRevision)
    && isSource(scope.source)
    && Array.isArray(scope.requiredSources)
    && scope.requiredSources.every(source => isPlainObject(source)
      && hasOnlyKeys(source, ["uri"]) && isCanonicalSourceUri(source.uri))
    && new Set(scope.requiredSources.map(source => source.uri)).size === scope.requiredSources.length
    && Array.isArray(scope.items)
    && scope.items.length > 0
    && scope.items.every(item => isPlainObject(item)
      && hasOnlyKeys(item, ["id", "primaryJira", "owner"])
      && isSafeIdentifier(item.id)
      && (item.primaryJira === undefined || isSafeIdentifier(item.primaryJira))
      && (item.owner === undefined || isSafeIdentifier(item.owner)))
    && new Set(scope.items.map(item => item.id)).size === scope.items.length;
}

function isSource(source) {
  return isPlainObject(source)
    && hasOnlyKeys(source, ["uri", "revision", "coverage"])
    && isCanonicalSourceUri(source.uri)
    && (source.revision === null || isSafeRevision(source.revision))
    && COVERAGE.has(source.coverage)
    && (source.coverage !== "COMPLETE" || source.revision !== null);
}

function isRefresh(refresh) {
  return isPlainObject(refresh)
    && hasOnlyKeys(refresh, ["sourceUri", "sourceRevision", "expectedPriorRevision", "refreshScope", "coverage", "partialReasons", "observations"])
    && isSafeRefreshUri(refresh.sourceUri)
    && (refresh.sourceRevision === null || isSafeRevision(refresh.sourceRevision))
    && (refresh.expectedPriorRevision === null || isSafeRevision(refresh.expectedPriorRevision))
    && REFRESH_SCOPES.has(refresh.refreshScope)
    && COVERAGE.has(refresh.coverage)
    && (refresh.coverage !== "COMPLETE" || refresh.sourceRevision !== null)
    && Array.isArray(refresh.partialReasons)
    && refresh.partialReasons.every(reason => PARTIAL_REASONS.has(reason))
    && Array.isArray(refresh.observations)
    && refresh.observations.every(observation => isPlainObject(observation)
      && hasOnlyKeys(observation, ["id", "status"])
      && isSafeIdentifier(observation.id)
      && STATUS.has(observation.status));
}

function isCheckpoint(checkpoint) {
  return isPlainObject(checkpoint)
    && hasOnlyKeys(checkpoint, [
      "objectiveId", "scopeRevision", "scopeSource", "requiredSources", "sourceCoverage",
      "inventory", "statusSummary", "scopeCoverage", "recentExecution",
      "unverifiedDiscoveryRanges", "unverifiedDiscoveries", "nextReadyId", "stopReason",
      "goalDoneEligible", "checkpointRevision",
    ])
    && isSafeIdentifier(checkpoint.objectiveId)
    && isSafeRevision(checkpoint.scopeRevision)
    && isPositiveInteger(checkpoint.checkpointRevision)
    && isSource(checkpoint.scopeSource)
    && Array.isArray(checkpoint.requiredSources)
    && checkpoint.requiredSources.every(source => isPlainObject(source)
      && hasOnlyKeys(source, ["uri"]) && isCanonicalSourceUri(source.uri))
    && new Set(checkpoint.requiredSources.map(source => source.uri)).size === checkpoint.requiredSources.length
    && Array.isArray(checkpoint.sourceCoverage)
    && checkpoint.sourceCoverage.every(source => isSource(source))
    && new Set(checkpoint.sourceCoverage.map(source => source.uri)).size === checkpoint.sourceCoverage.length
    && Array.isArray(checkpoint.inventory)
    && checkpoint.inventory.every(item => isPlainObject(item)
      && hasOnlyKeys(item, ["id", "primaryJira", "owner", "status", "scopeMember", "sourceUri", "sourceRevision"])
      && isSafeIdentifier(item.id)
      && (item.primaryJira === null || isSafeIdentifier(item.primaryJira))
      && (item.owner === null || isSafeIdentifier(item.owner))
      && STATUS.has(item.status)
      && typeof item.scopeMember === "boolean"
      && (item.sourceUri === null || isCanonicalSourceUri(item.sourceUri))
      && (item.sourceRevision === null || isSafeRevision(item.sourceRevision)))
    && new Set(checkpoint.inventory.map(item => item.id)).size === checkpoint.inventory.length
    && isPlainObject(checkpoint.statusSummary)
    && hasOnlyKeys(checkpoint.statusSummary, [...STATUS])
    && [...STATUS].every(status => Number.isSafeInteger(checkpoint.statusSummary[status])
      && checkpoint.statusSummary[status] >= 0)
    && [...STATUS].every(status => checkpoint.statusSummary[status]
      === checkpoint.inventory.filter(item => item.scopeMember && item.status === status).length)
    && COVERAGE.has(checkpoint.scopeCoverage)
    && isCheckpointCoverageConsistent(checkpoint)
    && (checkpoint.nextReadyId === null || checkpoint.inventory.some(item => (
      item.id === checkpoint.nextReadyId && item.scopeMember && item.status === "READY"
    )))
    && (checkpoint.recentExecution === null || isRecentExecution(checkpoint.recentExecution))
    && Array.isArray(checkpoint.unverifiedDiscoveryRanges)
    && checkpoint.unverifiedDiscoveryRanges.every(range => isPlainObject(range)
      && hasOnlyKeys(range, ["sourceUri", "sourceRevision", "reason"])
      && isRecordedSourceUri(range.sourceUri)
      && (range.sourceRevision === null || isSafeRevision(range.sourceRevision))
      && PARTIAL_REASONS.has(range.reason))
    && Array.isArray(checkpoint.unverifiedDiscoveries)
    && checkpoint.unverifiedDiscoveries.every(item => isPlainObject(item)
      && hasOnlyKeys(item, ["id", "sourceUri", "sourceRevision", "disposition"])
      && isSafeIdentifier(item.id)
      && isRecordedSourceUri(item.sourceUri)
      && (item.sourceRevision === null || isSafeRevision(item.sourceRevision))
      && ["UNVERIFIED_OUT_OF_SCOPE", "UNVERIFIED_SOURCE"].includes(item.disposition))
    && (checkpoint.nextReadyId === null || isNonEmptyString(checkpoint.nextReadyId))
    && (checkpoint.stopReason === null || STOP_REASONS.has(checkpoint.stopReason))
    && (checkpoint.stopReason !== "NO_VERIFIED_READY" || checkpoint.nextReadyId === null)
    && typeof checkpoint.goalDoneEligible === "boolean"
    && (!checkpoint.goalDoneEligible || (checkpoint.scopeCoverage === "COMPLETE"
      && checkpoint.inventory.some(item => item.scopeMember)
      && checkpoint.inventory.filter(item => item.scopeMember).every(item => item.status === "DONE")
      && checkpoint.stopReason === null));
}

function isRecentExecution(execution) {
  return isPlainObject(execution)
    && hasOnlyKeys(execution, ["primaryJira", "writer", "prHead"])
    && isSafeIdentifier(execution.primaryJira)
    && isSafeIdentifier(execution.writer)
    && (execution.prHead === null || /^[0-9a-f]{40}$/i.test(execution.prHead));
}

function hasSameScopeContent(checkpoint, approvedScope) {
  const approvedIds = approvedScope.items.map(item => item.id).sort();
  const priorItems = checkpoint.inventory.filter(item => item.scopeMember).sort((left, right) => left.id.localeCompare(right.id));
  const priorSources = checkpoint.requiredSources.map(source => source.uri).sort();
  const approvedSources = approvedScope.requiredSources.map(source => source.uri).sort();
  return checkpoint.scopeSource.uri === approvedScope.source.uri
    && checkpoint.scopeSource.revision === approvedScope.source.revision
    && checkpoint.scopeSource.coverage === approvedScope.source.coverage
    && JSON.stringify(priorSources) === JSON.stringify(approvedSources)
    && JSON.stringify(priorItems.map(item => item.id)) === JSON.stringify(approvedIds)
    && approvedScope.items.every(item => {
      const prior = priorItems.find(row => row.id === item.id);
      return prior?.primaryJira === (item.primaryJira ?? null)
        && prior?.owner === (item.owner ?? null);
    });
}

function isCheckpointCoverageConsistent(checkpoint) {
  if (checkpoint.scopeCoverage !== "COMPLETE") return true;
  const scopeSource = checkpoint.sourceCoverage.find(source => source.uri === checkpoint.scopeSource.uri);
  return checkpoint.scopeSource.coverage === "COMPLETE"
    && scopeSource?.coverage === "COMPLETE"
    && scopeSource.revision === checkpoint.scopeSource.revision
    && checkpoint.requiredSources.every(required => {
      const source = checkpoint.sourceCoverage.find(row => row.uri === required.uri);
      return source?.coverage === "COMPLETE" && source.revision !== null;
    });
}

function blocked(reason, checkpoint) {
  const safeCheckpoint = checkpoint === null ? null : JSON.parse(JSON.stringify(checkpoint));
  return { ok: false, accepted: false, reason, checkpoint: safeCheckpoint };
}

function discoveryKey(entry) {
  return [entry.id ?? "", entry.sourceUri ?? "", entry.sourceRevision ?? "", entry.reason ?? entry.disposition ?? ""].join("\u0000");
}

function compareDiscovery(left, right) {
  return discoveryKey(left).localeCompare(discoveryKey(right));
}

function hasOnlyKeys(value, allowed) {
  return Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotData(value) {
  let nodes = 0;
  const ancestors = new Set();
  const fail = () => ({ ok: false });
  function copy(input, depth) {
    nodes += 1;
    if (nodes > 20000 || depth > 12) return fail();
    if (input === null || typeof input === "string" || typeof input === "boolean") {
      return { ok: true, value: input };
    }
    if (typeof input === "number") {
      return Number.isFinite(input) ? { ok: true, value: input } : fail();
    }
    if (typeof input !== "object" || utilTypes.isProxy(input) || ancestors.has(input)) return fail();
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype) return fail();
        const length = input.length;
        if (!Number.isSafeInteger(length) || length < 0 || length > 10000) return fail();
        const keys = Reflect.ownKeys(input);
        if (keys.some(key => key !== "length"
          && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) {
          return fail();
        }
        const output = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!isEnumerableDataDescriptor(descriptor)) return fail();
          const child = copy(descriptor.value, depth + 1);
          if (!child.ok) return child;
          output.push(child.value);
        }
        return { ok: true, value: output };
      }
      if (!isPlainObject(input)) return fail();
      const keys = Reflect.ownKeys(input);
      if (keys.length > 200 || keys.some(key => typeof key !== "string")) return fail();
      const output = Object.create(null);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!isEnumerableDataDescriptor(descriptor)) return fail();
        const child = copy(descriptor.value, depth + 1);
        if (!child.ok) return child;
        Object.defineProperty(output, key, {
          value: child.value,
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
      return { ok: true, value: output };
    } catch {
      return fail();
    } finally {
      ancestors.delete(input);
    }
  }
  return copy(value, 0);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeIdentifier(value) {
  return typeof value === "string"
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(value);
}

function isSafeRevision(value) {
  return typeof value === "string"
    && value.length <= 192
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && Object.hasOwn(descriptor, "value")
    && descriptor.enumerable === true;
}

function isSafeRefreshUri(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.port === ""
      && parsed.search === ""
      && parsed.hash === ""
      && /^\/[A-Za-z0-9._/-]*$/.test(parsed.pathname)
      && !parsed.pathname.split("/").some(segment => segment === ".." || segment.length > 64);
  } catch {
    return false;
  }
}

function isCanonicalSourceUri(value) {
  if (!isSafeRefreshUri(value)) return false;
  const parsed = new URL(value);
  if (parsed.hostname === "ranikunlabs.atlassian.net") {
    return /^\/browse\/RPL-\d+$/i.test(parsed.pathname)
      || parsed.pathname === "/rest/api/3/search"
      || /^\/rest\/api\/3\/issue\/RPL-\d+$/i.test(parsed.pathname);
  }
  if (parsed.hostname === "github.com") {
    return /^\/ranikun-labs\/oh-my-ai(?:\/(?:pull|issues)\/\d+)?$/i.test(parsed.pathname);
  }
  if (parsed.hostname === "api.github.com") {
    return /^\/repos\/ranikun-labs\/oh-my-ai\/(?:pulls|issues)(?:\/\d+)?$/i.test(parsed.pathname);
  }
  return false;
}

function isRecordedSourceUri(value) {
  return isCanonicalSourceUri(value) || /^urn:sha256:[a-f0-9]{64}$/.test(value);
}

function hashUri(value) {
  return `urn:sha256:${createSha256(value)}`;
}

function hashRevision(value) {
  return `sha256/${createSha256(value)}`;
}

function createSha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
