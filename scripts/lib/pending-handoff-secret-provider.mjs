const PROVIDER_VERSION = "phr-secret-provider-v1";
const PURPOSE = "pending-handoff-identity";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_KEYS = [
  "version",
  "current_key_id",
  "verification_key_ids",
  "keyed_digest",
  "safe_equal",
];

export function createIdentitySecurityDependencies(provider) {
  try {
    return createDependencies(provider);
  } catch {
    return failure("secret_provider_invalid", { operation: "factory" });
  }
}

function createDependencies(provider) {
  const inspected = inspectExactDataObject(provider, PROVIDER_KEYS);
  if (!inspected.ok || !isFrozen(provider)) {
    return failure("secret_provider_invalid", { operation: "factory" });
  }

  const values = inspected.values;
  if (values.version !== PROVIDER_VERSION) {
    return failure("secret_provider_version_unsupported", {
      operation: "factory",
      provider_version_present: typeof values.version === "string",
      provider_version_supported: false,
    });
  }
  if (!Array.isArray(values.verification_key_ids) || !isFrozen(values.verification_key_ids)) {
    return failure("secret_provider_invalid", { operation: "factory" });
  }
  if (!validKeyId(values.current_key_id)) {
    return failure("secret_key_id_invalid", {
      operation: "factory",
      key_id_present: typeof values.current_key_id === "string" && values.current_key_id.length > 0,
    });
  }
  if (!validVerificationKeys(values.verification_key_ids, values.current_key_id)) {
    return failure("secret_verification_keys_invalid", {
      operation: "factory",
      verification_key_count: Array.isArray(values.verification_key_ids)
        ? values.verification_key_ids.length
        : 0,
    });
  }
  if (!validProviderFunction(values.keyed_digest) || !validProviderFunction(values.safe_equal)) {
    return failure("secret_provider_invalid", { operation: "factory" });
  }

  const keyIds = [...values.verification_key_ids];
  const entries = keyIds.map(keyId => Object.freeze({
    key_id: keyId,
    keyed_digest: createKeyedDigestWrapper(values.keyed_digest, keyId),
  }));
  const current = entries[0];
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      current,
      verification: Object.freeze(entries),
      safe_equal: createSafeEqualWrapper(values.safe_equal),
    }),
  });
}

function inspectExactDataObject(value, expectedKeys) {
  try {
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
      return { ok: false };
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length || ownKeys.some(key => typeof key !== "string" || !expectedKeys.includes(key))) {
      return { ok: false };
    }
    const values = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor
        || descriptor.enumerable !== true
        || !("value" in descriptor)
        || "get" in descriptor
        || "set" in descriptor
      ) {
        return { ok: false };
      }
      values[key] = descriptor.value;
    }
    return { ok: true, values };
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

function validKeyId(value) {
  return typeof value === "string" && KEY_ID_PATTERN.test(value);
}

function validVerificationKeys(value, currentKeyId) {
  try {
    if (value.length < 1 || value.length > 2) return false;
    if (value[0] !== currentKeyId || value.some(keyId => !validKeyId(keyId))) return false;
    return new Set(value).size === value.length;
  } catch {
    return false;
  }
}

function validProviderFunction(value) {
  try {
    return typeof value === "function"
      && isFrozen(value)
      && !Object.prototype.hasOwnProperty.call(value, "toJSON");
  } catch {
    return false;
  }
}

function callRawDigest(keyedDigest, keyId, bytes) {
  try {
    const value = keyedDigest({ key_id: keyId, purpose: PURPOSE, bytes: new Uint8Array(bytes) });
    return typeof value === "string" && DIGEST_PATTERN.test(value)
      ? { ok: true, value }
      : { ok: false, reason: "secret_digest_invalid" };
  } catch {
    return { ok: false, reason: "secret_digest_failed" };
  }
}

function createKeyedDigestWrapper(rawKeyedDigest, boundKeyId) {
  return Object.freeze(input => {
    const inspected = inspectExactDataObject(input, ["key_id", "purpose", "bytes"]);
    if (!inspected.ok || !(inspected.values.bytes instanceof Uint8Array)) {
      throw sanitizedError("secret_digest_invalid", "digest");
    }
    if (inspected.values.key_id !== boundKeyId) {
      throw sanitizedError("secret_key_not_found", "digest");
    }
    if (inspected.values.purpose !== PURPOSE) {
      throw sanitizedError("secret_purpose_invalid", "digest");
    }
    const result = callRawDigest(rawKeyedDigest, boundKeyId, inspected.values.bytes);
    if (!result.ok) throw sanitizedError(result.reason, "digest");
    return result.value;
  });
}

function createSafeEqualWrapper(rawSafeEqual) {
  return Object.freeze((left, right) => {
    if (typeof left !== "string" || typeof right !== "string") {
      throw sanitizedError("secret_compare_invalid", "compare");
    }
    if (left.length !== right.length) return false;
    let result;
    try {
      result = rawSafeEqual(left, right);
    } catch {
      throw sanitizedError("secret_compare_failed", "compare");
    }
    if (typeof result !== "boolean" || result !== (left === right)) {
      throw sanitizedError("secret_compare_invalid", "compare");
    }
    return result;
  });
}

function failure(reason, metadata) {
  return Object.freeze({ ok: false, reason, metadata: Object.freeze(metadata) });
}

function sanitizedError(code, operation) {
  return Object.freeze({
    name: "SecretProviderError",
    code,
    metadata: Object.freeze({ operation }),
  });
}
