import assert from "node:assert/strict";
import {
  compareIdentityScope,
  deriveRepositoryIdentity,
  deriveSourceSessionIdentity,
  deriveWorktreeIdentity,
  validateOpaqueIdentity,
} from "./lib/pending-handoff-identity.mjs";

let tests = 0;

function test(name, operation) {
  operation();
  tests += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function fakeDigest({ key_id, purpose, bytes }) {
  const decoded = new TextDecoder().decode(bytes);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let state = 2_166_136_261;
  for (const value of `${key_id}:${purpose}:${decoded}`) {
    state ^= value.charCodeAt(0);
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  return Array.from({ length: 43 }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return alphabet[(state >>> 0) % alphabet.length];
  }).join("");
}

function observedDigest(calls) {
  return ({ key_id, purpose, bytes }) => {
    calls.push({
      key_id,
      purpose,
      preimage: JSON.parse(new TextDecoder().decode(bytes)),
    });
    return fakeDigest({ key_id, purpose, bytes });
  };
}

function safeEqual(left, right) {
  return left === right;
}

function session(overrides = {}) {
  return deriveSourceSessionIdentity({
    runtime_id: " Codex ",
    raw_session_id: "session-001",
    key_id: "key_A-1",
    keyed_digest: fakeDigest,
    ...overrides,
  });
}

function repository(overrides = {}) {
  return deriveRepositoryIdentity({
    repository_evidence: { host: " GitHub.COM ", path: " aixion1506/oh-my-ai.git/ " },
    key_id: "key_A-1",
    keyed_digest: fakeDigest,
    ...overrides,
  });
}

function worktree(overrides = {}) {
  return deriveWorktreeIdentity({
    repository_identity: repository().identity,
    verified_canonical_root: "/Users/rani/work/Github/oh-my-ai-rpl-26",
    key_id: "key_A-1",
    keyed_digest: fakeDigest,
    ...overrides,
  });
}

function scope(source, current, overrides = {}) {
  return compareIdentityScope({ source, current, safe_equal: safeEqual, ...overrides });
}

test("session derivation preserves raw session bytes and binds the normalized runtime", () => {
  const calls = [];
  const first = session({ keyed_digest: observedDigest(calls) });
  const second = session({ keyed_digest: observedDigest(calls) });
  const otherRuntime = session({ runtime_id: "claude", keyed_digest: observedDigest(calls) });
  const otherSession = session({ raw_session_id: "session-002", keyed_digest: observedDigest(calls) });

  assert.deepEqual(first, second);
  assert.notEqual(first.identity, otherRuntime.identity);
  assert.notEqual(first.identity, otherSession.identity);
  assert.deepEqual(calls.map(call => call.preimage), [
    ["phr1", "session", "codex", "session-001"],
    ["phr1", "session", "codex", "session-001"],
    ["phr1", "session", "claude", "session-001"],
    ["phr1", "session", "codex", "session-002"],
  ]);
  assert.ok(calls.every(call => call.purpose === "pending-handoff-identity"));
});

test("repository derivation normalizes only approved evidence fields", () => {
  const calls = [];
  const first = repository({ keyed_digest: observedDigest(calls) });
  const equivalent = repository({
    repository_evidence: { host: "github.com", path: "aixion1506/oh-my-ai" },
    keyed_digest: observedDigest(calls),
  });
  const other = repository({
    repository_evidence: { host: "github.com", path: "aixion1506/other" },
    keyed_digest: observedDigest(calls),
  });

  assert.deepEqual(first, equivalent);
  assert.notEqual(first.identity, other.identity);
  assert.deepEqual(calls.map(call => call.preimage), [
    ["phr1", "repository", "github.com", "aixion1506/oh-my-ai"],
    ["phr1", "repository", "github.com", "aixion1506/oh-my-ai"],
    ["phr1", "repository", "github.com", "aixion1506/other"],
  ]);
});

test("worktree derivation binds the repository opaque identity and preserves root case", () => {
  const repositoryOne = repository().identity;
  const repositoryTwo = repository({
    repository_evidence: { host: "github.com", path: "aixion1506/other" },
  }).identity;
  const calls = [];
  const first = worktree({ repository_identity: repositoryOne, keyed_digest: observedDigest(calls) });
  const same = worktree({ repository_identity: repositoryOne, keyed_digest: observedDigest(calls) });
  const otherRoot = worktree({
    repository_identity: repositoryOne,
    verified_canonical_root: "/Users/rani/work/Github/oh-my-ai-rpl-27",
    keyed_digest: observedDigest(calls),
  });
  const otherRepository = worktree({ repository_identity: repositoryTwo, keyed_digest: observedDigest(calls) });
  const caseChangedRoot = worktree({
    repository_identity: repositoryOne,
    verified_canonical_root: "/Users/rani/work/Github/Oh-My-AI-rpl-26",
    keyed_digest: observedDigest(calls),
  });

  assert.deepEqual(first, same);
  assert.notEqual(first.identity, otherRoot.identity);
  assert.notEqual(first.identity, otherRepository.identity);
  assert.notEqual(first.identity, caseChangedRoot.identity);
  assert.deepEqual(calls.map(call => call.preimage), [
    ["phr1", "worktree", repositoryOne, "/Users/rani/work/Github/oh-my-ai-rpl-26"],
    ["phr1", "worktree", repositoryOne, "/Users/rani/work/Github/oh-my-ai-rpl-26"],
    ["phr1", "worktree", repositoryOne, "/Users/rani/work/Github/oh-my-ai-rpl-27"],
    ["phr1", "worktree", repositoryTwo, "/Users/rani/work/Github/oh-my-ai-rpl-26"],
    ["phr1", "worktree", repositoryOne, "/Users/rani/work/Github/Oh-My-AI-rpl-26"],
  ]);
});

test("blank or credential-bearing inputs produce only redacted errors", () => {
  const rawSessionMarker = "raw-session-marker-should-not-leak";
  const credentialMarker = "credential-marker-should-not-leak";
  const absolutePathMarker = "/absolute-path-marker-should-not-leak";
  const results = [
    session({ runtime_id: "   " }),
    session({ raw_session_id: "" }),
    repository({ repository_evidence: { host: `${credentialMarker}@github.com`, path: "owner/repo" } }),
    worktree({ verified_canonical_root: "" }),
    worktree({ verified_canonical_root: absolutePathMarker, repository_identity: "invalid" }),
    session({ raw_session_id: rawSessionMarker, keyed_digest: () => { throw new Error(rawSessionMarker); } }),
  ];
  const serialized = JSON.stringify(results);

  assert.ok(results.every(result => result.ok === false));
  assert.ok(results.every(result => typeof result.reason === "string"));
  assert.equal(serialized.includes(rawSessionMarker), false);
  assert.equal(serialized.includes(credentialMarker), false);
  assert.equal(serialized.includes(absolutePathMarker), false);
  assert.deepEqual(results.map(result => result.reason), [
    "identity_input_invalid",
    "identity_input_invalid",
    "identity_input_invalid",
    "identity_input_invalid",
    "identity_format_invalid",
    "identity_digest_unavailable",
  ]);
});

test("key id, digest, and opaque identity format are validated without exposing the digest", () => {
  const valid = session();
  assert.deepEqual(validateOpaqueIdentity(valid.identity), {
    ok: true,
    version: "phr1",
    kind: "session",
    key_id: "key_A-1",
  });
  assert.deepEqual(session({ key_id: "" }), { ok: false, reason: "identity_key_id_invalid" });
  assert.deepEqual(session({ key_id: "not.allowed" }), {
    ok: false,
    reason: "identity_key_id_invalid",
  });
  assert.deepEqual(session({ keyed_digest: () => "short" }), {
    ok: false,
    reason: "identity_digest_invalid",
  });
  assert.deepEqual(session({ keyed_digest: () => "!".repeat(43) }), {
    ok: false,
    reason: "identity_digest_invalid",
  });
  assert.deepEqual(validateOpaqueIdentity("phr1.session.key_A-1.short"), {
    ok: false,
    reason: "identity_format_invalid",
  });
  assert.deepEqual(validateOpaqueIdentity("phr1.unknown.key_A-1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), {
    ok: false,
    reason: "identity_format_invalid",
  });
});

test("comparison is fail-closed and distinguishes session repository and worktree outcomes", () => {
  const source = {
    session_identity: session().identity,
    repository_identity: repository().identity,
    worktree_identity: worktree().identity,
  };
  const otherSession = { ...source, session_identity: session({ raw_session_id: "session-002" }).identity };
  const otherRepository = {
    ...otherSession,
    repository_identity: repository({
      repository_evidence: { host: "github.com", path: "aixion1506/other" },
    }).identity,
  };
  const otherWorktree = {
    ...source,
    session_identity: otherSession.session_identity,
    worktree_identity: worktree({
      verified_canonical_root: "/Users/rani/work/Github/oh-my-ai-rpl-27",
    }).identity,
  };
  const differentKey = {
    ...source,
    session_identity: session({ key_id: "key_B-2" }).identity,
  };

  assert.deepEqual(scope(source, source), { ok: true, result: "same_session" });
  assert.deepEqual(scope(source, otherSession), { ok: true, result: "match" });
  assert.deepEqual(scope(source, otherRepository), { ok: false, reason: "repository_mismatch" });
  assert.deepEqual(scope(source, otherWorktree), { ok: false, reason: "worktree_mismatch" });
  assert.deepEqual(scope(source, differentKey), { ok: false, reason: "identity_namespace_mismatch" });
  assert.deepEqual(scope({ ...source, session_identity: "invalid" }, otherSession), {
    ok: false,
    reason: "session_identity_unknown",
  });
  assert.deepEqual(scope(otherSession, { ...source, repository_identity: "invalid" }), {
    ok: false,
    reason: "repository_identity_unknown",
  });
  assert.deepEqual(scope(otherSession, { ...source, worktree_identity: "invalid" }), {
    ok: false,
    reason: "worktree_identity_unknown",
  });
  assert.deepEqual(scope(otherSession, { ...otherSession, worktree_identity: source.worktree_identity }, {
    safe_equal: () => { throw new Error("comparison details must not leak"); },
  }), { ok: false, reason: "session_identity_unknown" });
});

test("identity module has no runtime filesystem process network or crypto imports", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(
    new URL("./lib/pending-handoff-identity.mjs", import.meta.url),
    "utf8",
  ));
  assert.equal(/from\s+["']node:(?:fs|path|child_process|process|net|http|https|crypto)["']/.test(source), false);
  assert.equal(/import\s*\(\s*["']node:(?:fs|path|child_process|process|net|http|https|crypto)["']\s*\)/.test(source), false);
});

process.stdout.write(`PASS ${tests} identity fixtures\n`);
