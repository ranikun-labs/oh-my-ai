const VERSION = "phr1";
const PURPOSE = "pending-handoff-identity";
const KINDS = new Set(["session", "repository", "worktree"]);
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function deriveSourceSessionIdentity(input) {
  const keyId = validKeyId(input?.key_id);
  if (!keyId) return failure("identity_key_id_invalid");
  if (!isPlainObject(input)) return failure("identity_input_invalid");

  const runtimeId = normalizeRuntimeId(input.runtime_id);
  if (!runtimeId || !isNonEmptyString(input.raw_session_id)) {
    return failure("identity_input_invalid");
  }

  return deriveIdentity({
    kind: "session",
    keyId,
    keyedDigest: input.keyed_digest,
    preimage: [VERSION, "session", runtimeId, input.raw_session_id],
  });
}

export function deriveRepositoryIdentity(input) {
  const keyId = validKeyId(input?.key_id);
  if (!keyId) return failure("identity_key_id_invalid");
  if (!isPlainObject(input)) return failure("identity_input_invalid");

  const evidence = normalizeRepositoryEvidence(input.repository_evidence);
  if (!evidence) return failure("identity_input_invalid");

  return deriveIdentity({
    kind: "repository",
    keyId,
    keyedDigest: input.keyed_digest,
    preimage: [VERSION, "repository", evidence.host, evidence.path],
  });
}

export function deriveWorktreeIdentity(input) {
  const keyId = validKeyId(input?.key_id);
  if (!keyId) return failure("identity_key_id_invalid");
  if (!isPlainObject(input)) return failure("identity_input_invalid");

  const repository = validateOpaqueIdentity(input.repository_identity);
  if (!repository.ok || repository.kind !== "repository") {
    return failure("identity_format_invalid");
  }
  if (
    typeof input.verified_canonical_root !== "string"
    || input.verified_canonical_root.trim().length === 0
  ) {
    return failure("identity_input_invalid");
  }

  return deriveIdentity({
    kind: "worktree",
    keyId,
    keyedDigest: input.keyed_digest,
    preimage: [VERSION, "worktree", input.repository_identity, input.verified_canonical_root],
  });
}

export function validateOpaqueIdentity(opaqueIdentity) {
  if (typeof opaqueIdentity !== "string") return failure("identity_format_invalid");
  const parts = opaqueIdentity.split(".");
  if (parts.length !== 4) return failure("identity_format_invalid");
  const [version, kind, keyId, digest] = parts;
  if (version !== VERSION || !KINDS.has(kind) || !validKeyId(keyId) || !DIGEST_PATTERN.test(digest)) {
    return failure("identity_format_invalid");
  }
  return { ok: true, version, kind, key_id: keyId };
}

export function compareIdentityScope(input) {
  if (!isPlainObject(input) || !isPlainObject(input.source) || !isPlainObject(input.current)) {
    return failure("session_identity_unknown");
  }

  const sourceSession = validateKind(input.source.session_identity, "session");
  const currentSession = validateKind(input.current.session_identity, "session");
  if (!sourceSession || !currentSession) return failure("session_identity_unknown");
  if (!sameNamespace(sourceSession, currentSession)) return failure("identity_namespace_mismatch");
  const sessionEqual = safeEqual(
    input.safe_equal,
    input.source.session_identity,
    input.current.session_identity,
  );
  if (sessionEqual === null) {
    return failure("session_identity_unknown");
  }
  if (sessionEqual) {
    return { ok: true, result: "same_session" };
  }

  const sourceRepository = validateKind(input.source.repository_identity, "repository");
  const currentRepository = validateKind(input.current.repository_identity, "repository");
  if (!sourceRepository || !currentRepository) return failure("repository_identity_unknown");
  if (!sameNamespace(sourceRepository, currentRepository)) return failure("identity_namespace_mismatch");
  const repositoryEqual = safeEqual(
    input.safe_equal,
    input.source.repository_identity,
    input.current.repository_identity,
  );
  if (repositoryEqual === null) return failure("repository_identity_unknown");
  if (!repositoryEqual) {
    return failure("repository_mismatch");
  }

  const sourceWorktree = validateKind(input.source.worktree_identity, "worktree");
  const currentWorktree = validateKind(input.current.worktree_identity, "worktree");
  if (!sourceWorktree || !currentWorktree) return failure("worktree_identity_unknown");
  if (!sameNamespace(sourceWorktree, currentWorktree)) return failure("identity_namespace_mismatch");
  const worktreeEqual = safeEqual(
    input.safe_equal,
    input.source.worktree_identity,
    input.current.worktree_identity,
  );
  if (worktreeEqual === null) return failure("worktree_identity_unknown");
  if (!worktreeEqual) {
    return failure("worktree_mismatch");
  }
  return { ok: true, result: "match" };
}

function deriveIdentity({ kind, keyId, keyedDigest, preimage }) {
  if (typeof keyedDigest !== "function") return failure("identity_digest_unavailable");

  let digest;
  try {
    digest = keyedDigest({
      key_id: keyId,
      purpose: PURPOSE,
      bytes: new TextEncoder().encode(JSON.stringify(preimage)),
    });
  } catch {
    return failure("identity_digest_unavailable");
  }
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
    return failure("identity_digest_invalid");
  }
  return { ok: true, identity: `${VERSION}.${kind}.${keyId}.${digest}` };
}

function normalizeRuntimeId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/[A-Z]/g, character => character.toLowerCase());
}

function normalizeRepositoryEvidence(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("host") || !keys.includes("path")) return null;
  if (typeof value.host !== "string" || typeof value.path !== "string") return null;

  const host = value.host.trim().replace(/[A-Z]/g, character => character.toLowerCase());
  let path = value.path.trim();
  if (hasCredentialOrUrlSyntax(host) || hasCredentialOrUrlSyntax(path)) return null;
  if (host.length === 0 || path.length === 0) return null;

  path = path.replace(/\/+$/, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  if (path.length === 0) return null;
  return { host, path };
}

function hasCredentialOrUrlSyntax(value) {
  return value.includes("@") || value.includes("://") || /[?#]/.test(value);
}

function validateKind(value, expectedKind) {
  const validated = validateOpaqueIdentity(value);
  return validated.ok && validated.kind === expectedKind ? validated : null;
}

function sameNamespace(left, right) {
  return left.version === right.version && left.kind === right.kind && left.key_id === right.key_id;
}

function safeEqual(safeEqualDependency, left, right) {
  if (typeof safeEqualDependency !== "function") return null;
  try {
    return safeEqualDependency(left, right) === true;
  } catch {
    return null;
  }
}

function validKeyId(value) {
  return typeof value === "string" && KEY_ID_PATTERN.test(value) ? value : null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function failure(reason) {
  return { ok: false, reason };
}
