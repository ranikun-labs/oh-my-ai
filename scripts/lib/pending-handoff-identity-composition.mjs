import {
  compareIdentityScope,
  deriveRepositoryIdentity,
  deriveSourceSessionIdentity,
  deriveWorktreeIdentity,
  validateOpaqueIdentity,
} from "./pending-handoff-identity.mjs";
import { createIdentitySecurityDependencies } from "./pending-handoff-secret-provider.mjs";

const ROOT_KEYS = ["provider", "source", "current"];
const SOURCE_KEYS = ["session_identity", "repository_identity", "worktree_identity"];
const CURRENT_KEYS = [
  "runtime_id",
  "raw_session_id",
  "repository_evidence",
  "verified_canonical_root",
];
const REPOSITORY_EVIDENCE_KEYS = ["host", "path"];
const FACTORY_SUCCESS_KEYS = ["ok", "value"];
const FACTORY_FAILURE_KEYS = ["ok", "reason", "metadata"];
const BUNDLE_KEYS = ["current", "verification", "safe_equal"];
const ENTRY_KEYS = ["key_id", "keyed_digest"];
const DERIVATION_SUCCESS_KEYS = ["ok", "identity"];
const DERIVATION_FAILURE_KEYS = ["ok", "reason"];
const COMPARISON_SUCCESS_KEYS = ["ok", "result"];
const COMPARISON_FAILURE_KEYS = ["ok", "reason"];
const PROVIDER_FAILURE_REASONS = new Set([
  "secret_provider_invalid",
  "secret_provider_version_unsupported",
  "secret_key_id_invalid",
  "secret_verification_keys_invalid",
]);
const COMPARISON_FAILURE_REASONS = new Set([
  "session_identity_unknown",
  "repository_identity_unknown",
  "repository_mismatch",
  "worktree_identity_unknown",
  "worktree_mismatch",
  "identity_namespace_mismatch",
]);
const COMPARISON_RESULTS = new Set(["match", "same_session"]);

export function verifyPendingHandoffIdentityScope(input) {
  try {
    const root = inspectExactDataObject(input, ROOT_KEYS);
    if (!root.ok) return failure("identity_composition_input_invalid");

    const source = inspectExactDataObject(root.values.source, SOURCE_KEYS);
    if (!source.ok) return failure("identity_composition_input_invalid");

    const current = inspectExactDataObject(root.values.current, CURRENT_KEYS);
    if (!current.ok) return failure("identity_composition_input_invalid");

    const repositoryEvidence = inspectExactDataObject(
      current.values.repository_evidence,
      REPOSITORY_EVIDENCE_KEYS,
    );
    if (!repositoryEvidence.ok) return failure("identity_composition_input_invalid");

    const sourceSession = readSourceIdentity(
      source.values.session_identity,
      "session",
      "session_identity_unknown",
    );
    if (!sourceSession.ok) return failure(sourceSession.reason);

    const sourceRepository = readSourceIdentity(
      source.values.repository_identity,
      "repository",
      "repository_identity_unknown",
    );
    if (!sourceRepository.ok) return failure(sourceRepository.reason);

    const sourceWorktree = readSourceIdentity(
      source.values.worktree_identity,
      "worktree",
      "worktree_identity_unknown",
    );
    if (!sourceWorktree.ok) return failure(sourceWorktree.reason);

    if (!sameSourceNamespace(sourceSession.value, sourceRepository.value, sourceWorktree.value)) {
      return failure("identity_namespace_mismatch");
    }

    let dependencyResult;
    try {
      dependencyResult = createIdentitySecurityDependencies(root.values.provider);
    } catch {
      return failure("secret_provider_invalid");
    }
    const dependencyState = readFactoryResult(dependencyResult);
    if (!dependencyState.ok) return failure(dependencyState.reason);

    const selectedEntry = selectVerificationEntry(
      dependencyState.value.verification,
      sourceSession.value.key_id,
    );
    if (!selectedEntry.ok) return failure("identity_key_unavailable");

    const currentSessionResult = safeCall(() => deriveSourceSessionIdentity({
      runtime_id: current.values.runtime_id,
      raw_session_id: current.values.raw_session_id,
      key_id: selectedEntry.value.key_id,
      keyed_digest: selectedEntry.value.keyed_digest,
    }));
    const currentSession = readDerivedIdentity(currentSessionResult, "session_identity_unknown");
    if (!currentSession.ok) return failure(currentSession.reason);

    const currentRepositoryResult = safeCall(() => deriveRepositoryIdentity({
      repository_evidence: repositoryEvidence.values,
      key_id: selectedEntry.value.key_id,
      keyed_digest: selectedEntry.value.keyed_digest,
    }));
    const currentRepository = readDerivedIdentity(
      currentRepositoryResult,
      "repository_identity_unknown",
    );
    if (!currentRepository.ok) return failure(currentRepository.reason);

    const currentWorktreeResult = safeCall(() => deriveWorktreeIdentity({
      repository_identity: currentRepository.value,
      verified_canonical_root: current.values.verified_canonical_root,
      key_id: selectedEntry.value.key_id,
      keyed_digest: selectedEntry.value.keyed_digest,
    }));
    const currentWorktree = readDerivedIdentity(
      currentWorktreeResult,
      "worktree_identity_unknown",
    );
    if (!currentWorktree.ok) return failure(currentWorktree.reason);

    const comparisonResult = safeCall(() => compareIdentityScope({
      source: {
        session_identity: source.values.session_identity,
        repository_identity: source.values.repository_identity,
        worktree_identity: source.values.worktree_identity,
      },
      current: {
        session_identity: currentSession.value,
        repository_identity: currentRepository.value,
        worktree_identity: currentWorktree.value,
      },
      safe_equal: dependencyState.value.safe_equal,
    }));
    const comparison = readComparisonResult(comparisonResult);
    if (!comparison.ok) return failure(comparison.reason);
    if (!comparison.success) return failure(comparison.reason);

    const frozenCurrent = Object.freeze({
      session_identity: currentSession.value,
      repository_identity: currentRepository.value,
      worktree_identity: currentWorktree.value,
    });
    return Object.freeze({ ok: true, result: comparison.result, current: frozenCurrent });
  } catch {
    return failure("identity_composition_input_invalid");
  }
}

function inspectExactDataObject(value, expectedKeys) {
  try {
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
      return { ok: false };
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expectedKeys.length
      || ownKeys.some(key => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      return { ok: false };
    }
    const descriptors = expectedKeys.map(key => Object.getOwnPropertyDescriptor(value, key));
    if (descriptors.some(descriptor => !isEnumerableDataDescriptor(descriptor))) {
      return { ok: false };
    }
    const values = {};
    for (let index = 0; index < expectedKeys.length; index += 1) {
      values[expectedKeys[index]] = descriptors[index].value;
    }
    return { ok: true, values };
  } catch {
    return { ok: false };
  }
}

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.hasOwn(descriptor, "value")
    && !Object.hasOwn(descriptor, "get")
    && !Object.hasOwn(descriptor, "set");
}

function readSourceIdentity(value, expectedKind, reason) {
  const validation = safeCall(() => validateOpaqueIdentity(value));
  if (!validation.ok) return { ok: false, reason };
  const inspected = inspectExactDataObject(validation.value, ["ok", "version", "kind", "key_id"]);
  if (!inspected.ok || inspected.values.ok !== true || inspected.values.kind !== expectedKind) {
    return { ok: false, reason };
  }
  if (typeof inspected.values.version !== "string" || typeof inspected.values.key_id !== "string") {
    return { ok: false, reason };
  }
  return { ok: true, value: inspected.values };
}

function sameSourceNamespace(session, repository, worktree) {
  return session.version === repository.version
    && session.version === worktree.version
    && session.key_id === repository.key_id
    && session.key_id === worktree.key_id;
}

function readFactoryResult(result) {
  const success = inspectExactDataObject(result, FACTORY_SUCCESS_KEYS);
  if (success.ok && success.values.ok === true) {
    const bundle = inspectDependencyBundle(success.values.value);
    return bundle.ok ? bundle : { ok: false, reason: "secret_provider_invalid" };
  }

  const rejected = inspectExactDataObject(result, FACTORY_FAILURE_KEYS);
  if (!rejected.ok || rejected.values.ok !== false) {
    return { ok: false, reason: "secret_provider_invalid" };
  }
  return {
    ok: false,
    reason: PROVIDER_FAILURE_REASONS.has(rejected.values.reason)
      ? rejected.values.reason
      : "secret_provider_invalid",
  };
}

function inspectDependencyBundle(value) {
  try {
    if (!isFrozen(value)) return { ok: false };
    const bundle = inspectExactDataObject(value, BUNDLE_KEYS);
    if (!bundle.ok) return { ok: false };

    const current = inspectDependencyEntry(bundle.values.current);
    if (!current.ok) return { ok: false };

    const verification = inspectFrozenDenseArray(bundle.values.verification);
    if (!verification.ok || verification.value.length === 0) return { ok: false };
    const entries = [];
    for (const valueEntry of verification.value) {
      const entry = inspectDependencyEntry(valueEntry);
      if (!entry.ok) return { ok: false };
      entries.push(entry.value);
    }

    if (typeof bundle.values.safe_equal !== "function" || !isFrozen(bundle.values.safe_equal)) {
      return { ok: false };
    }
    return {
      ok: true,
      value: {
        current: current.value,
        verification: entries,
        safe_equal: bundle.values.safe_equal,
      },
    };
  } catch {
    return { ok: false };
  }
}

function inspectDependencyEntry(value) {
  if (!isFrozen(value)) return { ok: false };
  const entry = inspectExactDataObject(value, ENTRY_KEYS);
  if (!entry.ok || typeof entry.values.key_id !== "string") return { ok: false };
  if (typeof entry.values.keyed_digest !== "function" || !isFrozen(entry.values.keyed_digest)) {
    return { ok: false };
  }
  return { ok: true, value: entry.values };
}

function inspectFrozenDenseArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !isFrozen(value)) {
      return { ok: false };
    }
    const ownKeys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.enumerable
      || lengthDescriptor.writable
      || lengthDescriptor.configurable
      || !Number.isInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || ownKeys.length !== lengthDescriptor.value + 1
      || ownKeys[ownKeys.length - 1] !== "length"
    ) {
      return { ok: false };
    }
    const values = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!isEnumerableDataDescriptor(descriptor)) return { ok: false };
      values.push(descriptor.value);
    }
    return { ok: true, value: values };
  } catch {
    return { ok: false };
  }
}

function selectVerificationEntry(verification, keyId) {
  try {
    for (const entry of verification) {
      if (entry.key_id === keyId) return { ok: true, value: entry };
    }
  } catch {
    return { ok: false };
  }
  return { ok: false };
}

function readDerivedIdentity(result, reason) {
  if (!result.ok) return { ok: false, reason };
  const inspected = inspectExactDataObject(result.value, DERIVATION_SUCCESS_KEYS);
  if (!inspected.ok || inspected.values.ok !== true || typeof inspected.values.identity !== "string") {
    return { ok: false, reason };
  }
  return { ok: true, value: inspected.values.identity };
}

function readComparisonResult(result) {
  if (!result.ok) return { ok: false, reason: "session_identity_unknown" };

  const success = inspectExactDataObject(result.value, COMPARISON_SUCCESS_KEYS);
  if (success.ok && success.values.ok === true) {
    if (!COMPARISON_RESULTS.has(success.values.result)) {
      return { ok: false, reason: "session_identity_unknown" };
    }
    return { ok: true, success: true, result: success.values.result };
  }

  const failureResult = inspectExactDataObject(result.value, COMPARISON_FAILURE_KEYS);
  if (!failureResult.ok || failureResult.values.ok !== false) {
    return { ok: false, reason: "session_identity_unknown" };
  }
  return {
    ok: true,
    success: false,
    reason: COMPARISON_FAILURE_REASONS.has(failureResult.values.reason)
      ? failureResult.values.reason
      : "session_identity_unknown",
  };
}

function safeCall(operation) {
  try {
    return { ok: true, value: operation() };
  } catch {
    return { ok: false };
  }
}

function isFrozen(value) {
  try {
    return Object.isFrozen(value);
  } catch {
    return false;
  }
}

function failure(reason) {
  return Object.freeze({ ok: false, reason });
}
