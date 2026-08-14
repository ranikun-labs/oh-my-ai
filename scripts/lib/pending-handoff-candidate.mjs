import { validateCandidate } from "./pending-handoff-core.mjs";
import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";

const CANDIDATE_FIELDS = Object.freeze([
  "candidate_id",
  "schema_version",
  "status",
  "created_at",
  "expires_at",
  "source_runtime",
  "source_session_identity",
  "repository_identity",
  "worktree_identity",
  "goal",
  "completed",
  "open_issues",
  "verification",
  "do_not_touch",
  "next_action",
  "context_checkpoint_status",
  "privacy_redaction_status",
]);

const CANDIDATE_FIELD_SET = new Set(CANDIDATE_FIELDS);

export function canonicalizePendingHandoffCandidate(input) {
  const snapshot = inspectCandidate(input);
  if (snapshot === null) return failure("candidate_input_invalid");

  let validation;
  try {
    validation = validateCandidate(snapshot);
  } catch {
    return failure("candidate_semantic_invalid");
  }
  if (!validation.ok) {
    return failure(hasStructuralValidationError(validation)
      ? "candidate_input_invalid"
      : "candidate_semantic_invalid");
  }
  if (snapshot.status !== "candidate") {
    return failure("candidate_semantic_invalid");
  }

  for (const [field, expectedKind] of [
    ["source_session_identity", "session"],
    ["repository_identity", "repository"],
    ["worktree_identity", "worktree"],
  ]) {
    let identity;
    try {
      identity = validateOpaqueIdentity(snapshot[field]);
    } catch {
      return failure("candidate_identity_invalid");
    }
    if (!identity.ok || identity.kind !== expectedKind) {
      return failure("candidate_identity_invalid");
    }
  }

  try {
    for (const key of Reflect.ownKeys(snapshot)) {
      const descriptor = Object.getOwnPropertyDescriptor(snapshot, key);
      if (Array.isArray(descriptor.value)) Object.freeze(descriptor.value);
    }
    Object.freeze(snapshot);
    return Object.freeze({ ok: true, value: snapshot });
  } catch {
    return failure("candidate_input_invalid");
  }
}

function inspectCandidate(input) {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype) return null;

    const ownKeys = Reflect.ownKeys(input);
    if (!hasExactCandidateKeys(ownKeys)) return null;

    const snapshot = Object.create(Object.prototype);
    for (const key of CANDIDATE_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!isEnumerableDataDescriptor(descriptor)) return null;

      const value = descriptor.value;
      if (typeof value === "function") return null;
      const valueIsArray = Array.isArray(value);
      if (value !== null && typeof value === "object" && !valueIsArray) return null;
      const copiedValue = valueIsArray ? copyDenseArray(value) : value;
      if (valueIsArray && copiedValue === null) return null;
      Object.defineProperty(snapshot, key, {
        value: copiedValue,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

function hasExactCandidateKeys(keys) {
  if (keys.length !== CANDIDATE_FIELDS.length) return false;

  const seen = new Set();
  for (const key of keys) {
    if (typeof key !== "string" || seen.has(key) || !CANDIDATE_FIELD_SET.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return seen.size === CANDIDATE_FIELDS.length;
}

function copyDenseArray(input) {
  try {
    if (Object.getPrototypeOf(input) !== Array.prototype) return null;

    const keys = Reflect.ownKeys(input);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (!isDataDescriptor(lengthDescriptor)
      || lengthDescriptor.enumerable
      || lengthDescriptor.configurable
      || typeof lengthDescriptor.value !== "number"
      || !Number.isInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > 4_294_967_295
      || keys.length !== lengthDescriptor.value + 1
      || keys[keys.length - 1] !== "length") {
      return null;
    }

    const copy = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const key = String(index);
      if (keys[index] !== key) return null;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!isEnumerableDataDescriptor(descriptor)) return null;
      Object.defineProperty(copy, key, {
        value: descriptor.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
  } catch {
    return null;
  }
}

function isEnumerableDataDescriptor(descriptor) {
  return isDataDescriptor(descriptor) && descriptor.enumerable === true;
}

function isDataDescriptor(descriptor) {
  return descriptor !== undefined
    && descriptor !== null
    && Object.hasOwn(descriptor, "value")
    && !Object.hasOwn(descriptor, "get")
    && !Object.hasOwn(descriptor, "set");
}

function hasStructuralValidationError(validation) {
  return Array.isArray(validation.errors)
    && validation.errors.some(error => [
      "required_field_missing",
      "unknown_field",
      "forbidden_field",
    ].includes(error.code));
}

function failure(reason) {
  return Object.freeze({ ok: false, reason });
}
