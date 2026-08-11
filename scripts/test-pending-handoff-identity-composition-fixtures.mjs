import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  deriveRepositoryIdentity,
  deriveSourceSessionIdentity,
  deriveWorktreeIdentity,
} from "./lib/pending-handoff-identity.mjs";
import { verifyPendingHandoffIdentityScope } from "./lib/pending-handoff-identity-composition.mjs";

const COMPOSITION_SOURCE_URL = new URL("./lib/pending-handoff-identity-composition.mjs", import.meta.url);
const IDENTITY_SOURCE_URL = new URL("./lib/pending-handoff-identity.mjs", import.meta.url);
const SECRET_SOURCE_URL = new URL("./lib/pending-handoff-secret-provider.mjs", import.meta.url);
const COMPOSITION_SOURCE = readFileSync(fileURLToPath(COMPOSITION_SOURCE_URL), "utf8");
const ROOT = "/Users/rani/work/Github/oh-my-ai-rpl-26-identity-scope-composition";
const HOST = "github.com";
const OLD_KEY = "previous_key";
const CURRENT_KEY = "current_key";
const RAW_SESSION_MARKER = "COMPOSITION_RAW_SESSION_MARKER";
const RAW_REPOSITORY_MARKER = "COMPOSITION_RAW_REPOSITORY_MARKER";
const RAW_ROOT_MARKER = "/composition/raw-root-marker";
const EXCEPTION_MARKER = "COMPOSITION_EXCEPTION_MARKER";

let groups = 0;
let tests = 0;
let instrumentedModuleId = 0;

async function group(name, operation) {
  await operation();
  groups += 1;
  process.stdout.write(`PASS GROUP ${groups} ${name}\n`);
}

async function test(name, operation) {
  await operation();
  tests += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function frozen(value) {
  return Object.freeze(value);
}

function digestFor({ key_id, purpose, bytes }) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let state = 2_166_136_261;
  for (const part of [key_id, purpose, ...bytes]) {
    for (const character of String(part)) {
      state ^= character.charCodeAt(0);
      state = Math.imul(state, 16_777_619) >>> 0;
    }
  }
  return Array.from({ length: 43 }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return alphabet[(state >>> 0) % alphabet.length];
  }).join("");
}

function provider(overrides = {}) {
  return frozen({
    version: "phr-secret-provider-v1",
    current_key_id: CURRENT_KEY,
    verification_key_ids: frozen([CURRENT_KEY, OLD_KEY]),
    keyed_digest: frozen(input => digestFor(input)),
    safe_equal: frozen((left, right) => left === right),
    ...overrides,
  });
}

function makeIdentities({
  keyId = OLD_KEY,
  runtimeId = "Codex",
  sessionId = "source-session",
  repositoryPath = "aixion1506/oh-my-ai",
  root = ROOT,
} = {}) {
  const session = deriveSourceSessionIdentity({
    runtime_id: runtimeId,
    raw_session_id: sessionId,
    key_id: keyId,
    keyed_digest: digestFor,
  });
  const repository = deriveRepositoryIdentity({
    repository_evidence: { host: HOST, path: repositoryPath },
    key_id: keyId,
    keyed_digest: digestFor,
  });
  const worktree = deriveWorktreeIdentity({
    repository_identity: repository.identity,
    verified_canonical_root: root,
    key_id: keyId,
    keyed_digest: digestFor,
  });
  assert.equal(session.ok, true);
  assert.equal(repository.ok, true);
  assert.equal(worktree.ok, true);
  return {
    session_identity: session.identity,
    repository_identity: repository.identity,
    worktree_identity: worktree.identity,
  };
}

function input({
  providerValue = provider(),
  sourceKey = OLD_KEY,
  sourceRuntime = "Codex",
  sourceSessionId = "source-session",
  sourceRepositoryPath = "aixion1506/oh-my-ai",
  sourceRoot = ROOT,
  currentRuntime = sourceRuntime,
  currentSessionId = "current-session",
  currentRepositoryPath = "aixion1506/oh-my-ai",
  currentRoot = ROOT,
  source,
  current,
} = {}) {
  const sourceValues = source ?? makeIdentities({
    keyId: sourceKey,
    runtimeId: sourceRuntime,
    sessionId: sourceSessionId,
    repositoryPath: sourceRepositoryPath,
    root: sourceRoot,
  });
  const currentValues = {
    runtime_id: currentRuntime,
    raw_session_id: currentSessionId,
    repository_evidence: { host: HOST, path: currentRepositoryPath },
    verified_canonical_root: currentRoot,
    ...current,
  };
  return {
    provider: providerValue,
    source: sourceValues,
    current: currentValues,
  };
}

function expectedCurrent(value, keyId = OLD_KEY) {
  const session = deriveSourceSessionIdentity({
    runtime_id: value.current.runtime_id,
    raw_session_id: value.current.raw_session_id,
    key_id: keyId,
    keyed_digest: digestFor,
  });
  const repository = deriveRepositoryIdentity({
    repository_evidence: value.current.repository_evidence,
    key_id: keyId,
    keyed_digest: digestFor,
  });
  const worktree = deriveWorktreeIdentity({
    repository_identity: repository.identity,
    verified_canonical_root: value.current.verified_canonical_root,
    key_id: keyId,
    keyed_digest: digestFor,
  });
  return {
    session_identity: session.identity,
    repository_identity: repository.identity,
    worktree_identity: worktree.identity,
  };
}

function assertExactPrototype(value, expectedPrototype) {
  assert.equal(Object.getPrototypeOf(value), expectedPrototype);
}

function assertFrozenData(value, key, expectedValue) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  assert.ok(descriptor, `${key} descriptor missing`);
  assert.equal(Object.hasOwn(descriptor, "value"), true, `${key} is not data`);
  assert.equal(Object.hasOwn(descriptor, "get"), false, `${key} has getter`);
  assert.equal(Object.hasOwn(descriptor, "set"), false, `${key} has setter`);
  assert.equal(descriptor.value, expectedValue, `${key} value differs`);
  assert.equal(descriptor.writable, false, `${key} writable`);
  assert.equal(descriptor.enumerable, true, `${key} enumerable`);
  assert.equal(descriptor.configurable, false, `${key} configurable`);
}

function assertFailure(result, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  assertExactPrototype(result, Object.prototype);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.isFrozen(result), true);
  assertFrozenData(result, "ok", false);
  assertFrozenData(result, "reason", reason);
}

function assertSuccess(result, value, expectedResult = "match") {
  assert.equal(result.ok, true);
  assert.equal(result.result, expectedResult);
  assertExactPrototype(result, Object.prototype);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "result", "current"]);
  assert.equal(Object.isFrozen(result), true);
  assertFrozenData(result, "ok", true);
  assertFrozenData(result, "result", expectedResult);
  assertFrozenData(result, "current", result.current);
  assertExactPrototype(result.current, Object.prototype);
  assert.deepEqual(Reflect.ownKeys(result.current), [
    "session_identity",
    "repository_identity",
    "worktree_identity",
  ]);
  assert.equal(Object.isFrozen(result.current), true);
  for (const key of ["session_identity", "repository_identity", "worktree_identity"]) {
    assertFrozenData(result.current, key, result.current[key]);
  }
  assert.deepEqual(result.current, expectedCurrent(value));
  assert.notEqual(result.current, value.current);
  return result.current;
}

function assertNoRaw(result) {
  const serialized = JSON.stringify(result);
  for (const marker of [RAW_SESSION_MARKER, RAW_REPOSITORY_MARKER, RAW_ROOT_MARKER, EXCEPTION_MARKER]) {
    assert.equal(serialized.includes(marker), false, `raw marker leaked: ${marker}`);
  }
}

function assertTrace(calls, expected) {
  assert.deepEqual(calls.map(call => call.dependency), expected);
}

async function captureOutput(operation) {
  const writes = [];
  const original = {
    stdout: process.stdout.write,
    stderr: process.stderr.write,
    log: console.log,
    error: console.error,
  };
  process.stdout.write = () => { writes.push("stdout"); return true; };
  process.stderr.write = () => { writes.push("stderr"); return true; };
  console.log = () => writes.push("console.log");
  console.error = () => writes.push("console.error");
  try {
    return { result: await operation(), writes };
  } finally {
    process.stdout.write = original.stdout;
    process.stderr.write = original.stderr;
    console.log = original.log;
    console.error = original.error;
  }
}

function dataModuleUrl(source) {
  instrumentedModuleId += 1;
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(
    `// composition-fixture-module-${instrumentedModuleId}\n${source}`,
  )}`;
}

async function loadInstrumented(sourceTransform = source => source) {
  const stateUrl = dataModuleUrl("export const calls = [];\n");
  const identitySpyUrl = dataModuleUrl(`
import * as real from ${JSON.stringify(IDENTITY_SOURCE_URL.href)};
import { calls } from ${JSON.stringify(stateUrl)};
export function validateOpaqueIdentity(value) {
  calls.push({ dependency: "validateOpaqueIdentity" });
  return real.validateOpaqueIdentity(value);
}
export function deriveSourceSessionIdentity(value) {
  calls.push({ dependency: "deriveSourceSessionIdentity" });
  return real.deriveSourceSessionIdentity(value);
}
export function deriveRepositoryIdentity(value) {
  calls.push({ dependency: "deriveRepositoryIdentity" });
  return real.deriveRepositoryIdentity(value);
}
export function deriveWorktreeIdentity(value) {
  calls.push({ dependency: "deriveWorktreeIdentity" });
  return real.deriveWorktreeIdentity(value);
}
export function compareIdentityScope(value) {
  calls.push({ dependency: "compareIdentityScope" });
  return real.compareIdentityScope(value);
}
`);
  const secretSpyUrl = dataModuleUrl(`
import * as real from ${JSON.stringify(SECRET_SOURCE_URL.href)};
import { calls } from ${JSON.stringify(stateUrl)};
export function createIdentitySecurityDependencies(value) {
  calls.push({ dependency: "createIdentitySecurityDependencies" });
  return real.createIdentitySecurityDependencies(value);
}
`);
  let source = sourceTransform(COMPOSITION_SOURCE);
  source = source.replace(
    'from "./pending-handoff-identity.mjs"',
    `from ${JSON.stringify(identitySpyUrl)}`,
  );
  source = source.replace(
    'from "./pending-handoff-secret-provider.mjs"',
    `from ${JSON.stringify(secretSpyUrl)}`,
  );
  const state = await import(stateUrl);
  const module = await import(dataModuleUrl(source));
  return { verify: module.verifyPendingHandoffIdentityScope, calls: state.calls };
}

async function instrumentedInvoke(value, sourceTransform = source => source) {
  const loaded = await loadInstrumented(sourceTransform);
  return { result: loaded.verify(value), calls: loaded.calls };
}

function replaceOnce(source, expected, replacement) {
  const count = source.split(expected).length - 1;
  if (count !== 1) throw new Error(`mutation anchor count ${count}: ${expected}`);
  return source.replace(expected, replacement);
}

function replaceBlock(source, startAnchor, endAnchor, replacement) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start);
  if (start < 0 || end < 0 || source.indexOf(startAnchor, end + endAnchor.length) >= 0) {
    throw new Error(`mutation block anchor missing: ${startAnchor}`);
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end + endAnchor.length)}`;
}

const IDENTITY_VALIDATION_TRACE = [
  "validateOpaqueIdentity",
  "validateOpaqueIdentity",
  "validateOpaqueIdentity",
];

function assertMutationDetected(mutation) {
  return mutation.verify(mutation.mutate).then(
    () => { throw new Error(`${mutation.name} survived its intended oracle`); },
    error => {
      assert.equal(error?.code, "ERR_ASSERTION", `${mutation.name} failed outside assertion oracle`);
    },
  );
}

const MUTATION_CASES = [
  {
    name: "top-level exact-key bypass",
    mutate: source => replaceOnce(source, "const root = inspectExactDataObject(input, ROOT_KEYS);", "const root = { ok: true, values: input };") ,
    verify: async mutate => {
      const value = input(); value.unexpected = "extra";
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "identity_composition_input_invalid");
    },
  },
  {
    name: "source exact-key bypass",
    mutate: source => replaceOnce(source, "const source = inspectExactDataObject(root.values.source, SOURCE_KEYS);", "const source = { ok: true, values: root.values.source };") ,
    verify: async mutate => {
      const value = input(); value.source.unexpected = "extra";
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "identity_composition_input_invalid");
    },
  },
  {
    name: "current exact-key bypass",
    mutate: source => replaceOnce(source, "const current = inspectExactDataObject(root.values.current, CURRENT_KEYS);", "const current = { ok: true, values: root.values.current };") ,
    verify: async mutate => {
      const value = input(); value.current.unexpected = "extra";
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "identity_composition_input_invalid");
    },
  },
  {
    name: "repository evidence exact-key bypass",
    mutate: source => replaceOnce(
      source,
      "const repositoryEvidence = inspectExactDataObject(\n      current.values.repository_evidence,\n      REPOSITORY_EVIDENCE_KEYS,\n    );",
      "const repositoryEvidence = { ok: true, values: current.values.repository_evidence };",
    ),
    verify: async mutate => {
      const value = input(); value.current.repository_evidence.unexpected = "extra";
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "identity_composition_input_invalid");
    },
  },
  {
    name: "accessor acceptance and invocation",
    mutate: source => {
      let mutated = replaceOnce(
        source,
        "      || ownKeys.some(key => typeof key !== \"string\" || !expectedKeys.includes(key))\n    ) {",
        "      || ownKeys.filter(key => typeof key === \"string\").length !== expectedKeys.length\n    ) {",
      );
      mutated = replaceOnce(
        mutated,
        "      || ownKeys.filter(key => typeof key === \"string\").length !== expectedKeys.length\n    ) {",
        "      || ownKeys.filter(key => typeof key === \"string\").length !== expectedKeys.length\n    ) {",
      );
      mutated = replaceOnce(
        mutated,
        "    && Object.hasOwn(descriptor, \"value\")\n    && !Object.hasOwn(descriptor, \"get\")\n    && !Object.hasOwn(descriptor, \"set\");",
        "    && (Object.hasOwn(descriptor, \"value\") || Object.hasOwn(descriptor, \"get\"))\n    && (!Object.hasOwn(descriptor, \"set\") || descriptor.set === undefined);",
      );
      return replaceOnce(
        mutated,
        "      values[expectedKeys[index]] = descriptors[index].value;",
        "      values[expectedKeys[index]] = descriptors[index].value ?? value[expectedKeys[index]];",
      );
    },
    verify: async mutate => {
      const value = input();
      let getterCalled = false;
      Object.defineProperty(value.current, "raw_session_id", {
        get() { getterCalled = true; return "current-session"; },
        enumerable: true,
        configurable: true,
      });
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "identity_composition_input_invalid");
      assert.equal(getterCalled, false);
    },
  },
  {
    name: "Symbol key acceptance",
    mutate: source => replaceOnce(
      source,
      "    if (\n      ownKeys.length !== expectedKeys.length\n      || ownKeys.some(key => typeof key !== \"string\" || !expectedKeys.includes(key))\n    ) {",
      "    const stringKeys = ownKeys.filter(key => typeof key === \"string\");\n    if (\n      stringKeys.length !== expectedKeys.length\n      || stringKeys.some(key => !expectedKeys.includes(key))\n    ) {",
    ),
    verify: async mutate => {
      const value = input(); value[Symbol("unexpected")] = "extra";
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "identity_composition_input_invalid");
    },
  },
  ...["session", "repository", "worktree"].map(expectedKind => ({
    name: `${expectedKind} source kind bypass`,
    mutate: source => replaceOnce(
      source,
      "inspected.values.kind !== expectedKind",
      `expectedKind !== "${expectedKind}" && inspected.values.kind !== expectedKind`,
    ),
    verify: async mutate => {
      const value = input();
      const wrong = expectedKind === "session"
        ? value.source.repository_identity
        : expectedKind === "repository" ? value.source.worktree_identity : value.source.session_identity;
      const field = `${expectedKind}_identity`;
      value.source[field] = wrong;
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, `${expectedKind}_identity_unknown`);
      assertTrace(actual.calls, IDENTITY_VALIDATION_TRACE.slice(0, expectedKind === "session" ? 1 : expectedKind === "repository" ? 2 : 3));
    },
  })),
  {
    name: "source namespace bypass",
    mutate: source => replaceOnce(source, "if (!sameSourceNamespace(sourceSession.value, sourceRepository.value, sourceWorktree.value)) {", "if (false) {") ,
    verify: async mutate => {
      const value = input({ sourceKey: OLD_KEY });
      const currentKeySource = makeIdentities({ keyId: CURRENT_KEY });
      value.source.repository_identity = currentKeySource.repository_identity;
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "identity_namespace_mismatch");
      assertTrace(actual.calls, [...IDENTITY_VALIDATION_TRACE, "createIdentitySecurityDependencies"]);
    },
  },
  {
    name: "provider factory bypass",
    mutate: source => replaceOnce(source, "      dependencyResult = createIdentitySecurityDependencies(root.values.provider);", "      dependencyResult = { ok: true, value: root.values.provider };") ,
    verify: async mutate => {
      const actual = await instrumentedInvoke(input(), mutate);
      assertSuccess(actual.result, input());
    },
  },
  {
    name: "historical verification key selection bypass",
    mutate: source => replaceOnce(source, "dependencyState.value.verification,\n      sourceSession.value.key_id,", "dependencyState.value.current,\n      sourceSession.value.key_id,") ,
    verify: async mutate => {
      const value = input({ currentSessionId: "different-current-session" });
      const actual = await instrumentedInvoke(value, mutate);
      assertSuccess(actual.result, value);
    },
  },
  {
    name: "session derivation bypass",
    mutate: source => replaceBlock(
      source,
      "    const currentSessionResult = safeCall(() => deriveSourceSessionIdentity({",
      "    const currentSession = readDerivedIdentity(currentSessionResult, \"session_identity_unknown\");",
      "    const currentSessionResult = { ok: true, value: { ok: true, identity: source.values.session_identity } };\n",
    ),
    verify: async mutate => {
      const value = input({ currentSessionId: "different-current-session" });
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "session_identity_unknown");
    },
  },
  {
    name: "repository derivation bypass",
    mutate: source => replaceBlock(
      source,
      "    const currentRepositoryResult = safeCall(() => deriveRepositoryIdentity({",
      "    const currentRepository = readDerivedIdentity(\n      currentRepositoryResult,\n      \"repository_identity_unknown\",\n    );",
      "    const currentRepositoryResult = { ok: true, value: { ok: true, identity: source.values.repository_identity } };\n",
    ),
    verify: async mutate => {
      const value = input({ currentRepositoryPath: "aixion1506/other" });
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "repository_mismatch");
    },
  },
  {
    name: "worktree derivation bypass",
    mutate: source => replaceBlock(
      source,
      "    const currentWorktreeResult = safeCall(() => deriveWorktreeIdentity({",
      "    const currentWorktree = readDerivedIdentity(\n      currentWorktreeResult,\n      \"worktree_identity_unknown\",\n    );",
      "    const currentWorktreeResult = { ok: true, value: { ok: true, identity: source.values.worktree_identity } };\n",
    ),
    verify: async mutate => {
      const value = input({ currentRoot: `${ROOT}-other` });
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "worktree_mismatch");
    },
  },
  {
    name: "scope comparison bypass",
    mutate: source => replaceBlock(
      source,
      "    const comparisonResult = safeCall(() => compareIdentityScope({",
      "    const comparison = readComparisonResult(comparisonResult);",
      "    const comparisonResult = { ok: true, value: { ok: true, result: \"match\" } };\n",
    ),
    verify: async mutate => {
      const value = input({ currentRepositoryPath: "aixion1506/other" });
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "repository_mismatch");
    },
  },
  {
    name: "safe_equal failure promoted to match",
    mutate: source => replaceOnce(source, "safe_equal: dependencyState.value.safe_equal,", "safe_equal: () => true,") ,
    verify: async mutate => {
      const value = input();
      const actual = await instrumentedInvoke(value, mutate);
      assertFailure(actual.result, "session_identity_unknown");
    },
  },
  {
    name: "success outer freeze removed",
    mutate: source => replaceOnce(source, "return Object.freeze({ ok: true, result: comparison.result, current: frozenCurrent });", "return { ok: true, result: comparison.result, current: frozenCurrent };") ,
    verify: async mutate => {
      const value = input({ currentSessionId: "source-session" });
      const actual = await instrumentedInvoke(value, mutate);
      assert.equal(Object.isFrozen(actual.result), true);
    },
  },
  {
    name: "success current freeze removed",
    mutate: source => replaceOnce(source, "const frozenCurrent = Object.freeze({", "const frozenCurrent = Object.assign({}, {") ,
    verify: async mutate => {
      const value = input({ currentSessionId: "source-session" });
      const actual = await instrumentedInvoke(value, mutate);
      assert.equal(Object.isFrozen(actual.result.current), true);
    },
  },
  {
    name: "failure freeze removed",
    mutate: source => replaceOnce(source, "return Object.freeze({ ok: false, reason });", "return { ok: false, reason };") ,
    verify: async mutate => {
      const actual = await instrumentedInvoke(null, mutate);
      assert.equal(Object.isFrozen(actual.result), true);
    },
  },
  {
    name: "raw logging",
    mutate: source => replaceOnce(source, "export function verifyPendingHandoffIdentityScope(input) {\n", "export function verifyPendingHandoffIdentityScope(input) {\n  console.log(input);\n") ,
    verify: async mutate => {
      const captured = await captureOutput(() => instrumentedInvoke(input({ currentSessionId: RAW_SESSION_MARKER }), mutate));
      assert.deepEqual(captured.result.result.ok, true);
      assert.deepEqual(captured.writes, []);
    },
  },
  {
    name: "import-time side effect",
    mutate: source => replaceOnce(source, "import {\n", "console.log(\"COMPOSITION_IMPORT_SIDE_EFFECT\");\nimport {\n") ,
    verify: async mutate => {
      const captured = await captureOutput(() => loadInstrumented(mutate));
      assert.deepEqual(captured.writes, []);
    },
  },
];

await group("reflection-safe input and source validation", async () => {
  await test("canonical scope comparison returns fresh frozen match", () => {
    const value = input();
    const result = verifyPendingHandoffIdentityScope(value);
    assertSuccess(result, value, "match");
  });
  await test("same session short-circuits later scope comparisons", async () => {
    const value = input({ currentSessionId: "source-session" });
    const actual = await instrumentedInvoke(value);
    assertSuccess(actual.result, value, "same_session");
    assertTrace(actual.calls, [...IDENTITY_VALIDATION_TRACE, "createIdentitySecurityDependencies", "deriveSourceSessionIdentity", "deriveRepositoryIdentity", "deriveWorktreeIdentity", "compareIdentityScope"]);
  });
  await test("wrong top-level values fail without dependencies", () => {
    for (const value of [null, undefined, "input", 42, true, [], () => {}]) {
      assertFailure(verifyPendingHandoffIdentityScope(value), "identity_composition_input_invalid");
    }
  });
  await test("missing extra Symbol inherited and null-prototype containers fail", () => {
    const missing = input(); delete missing.current.raw_session_id;
    assertFailure(verifyPendingHandoffIdentityScope(missing), "identity_composition_input_invalid");
    const extra = input(); extra.unexpected = "extra";
    assertFailure(verifyPendingHandoffIdentityScope(extra), "identity_composition_input_invalid");
    const symbol = input(); symbol[Symbol("extra")] = "extra";
    assertFailure(verifyPendingHandoffIdentityScope(symbol), "identity_composition_input_invalid");
    const inherited = Object.create({ inherited: true }); Object.assign(inherited, input());
    assertFailure(verifyPendingHandoffIdentityScope(inherited), "identity_composition_input_invalid");
    const nullPrototype = Object.create(null); Object.assign(nullPrototype, input());
    assertFailure(verifyPendingHandoffIdentityScope(nullPrototype), "identity_composition_input_invalid");
  });
  await test("accessors and hostile Proxy traps are rejected without invocation", () => {
    const accessor = input(); let getterCalled = false;
    Object.defineProperty(accessor.current, "raw_session_id", {
      get() { getterCalled = true; throw new Error(EXCEPTION_MARKER); }, enumerable: true, configurable: true,
    });
    assertFailure(verifyPendingHandoffIdentityScope(accessor), "identity_composition_input_invalid");
    assert.equal(getterCalled, false);
    const ownKeysProxy = new Proxy(input(), { ownKeys() { throw new Error(EXCEPTION_MARKER); } });
    assertFailure(verifyPendingHandoffIdentityScope(ownKeysProxy), "identity_composition_input_invalid");
    const descriptorProxy = new Proxy(input(), { getOwnPropertyDescriptor() { throw new Error(EXCEPTION_MARKER); } });
    assertFailure(verifyPendingHandoffIdentityScope(descriptorProxy), "identity_composition_input_invalid");
  });
});

await group("validation order and dependency short-circuit", async () => {
  await test("source kinds validate Session then Repository then Worktree", async () => {
    for (const [field, wrong, count] of [
      ["session_identity", input().source.repository_identity, 1],
      ["repository_identity", input().source.worktree_identity, 2],
      ["worktree_identity", input().source.session_identity, 3],
    ]) {
      const value = input(); value.source[field] = wrong;
      const actual = await instrumentedInvoke(value);
      assertFailure(actual.result, `${field.replace("_identity", "")}_identity_unknown`);
      assertTrace(actual.calls, IDENTITY_VALIDATION_TRACE.slice(0, count));
    }
  });
  await test("namespace mismatch stops before provider construction", async () => {
    const value = input(); value.source.repository_identity = makeIdentities({ keyId: CURRENT_KEY }).repository_identity;
    const actual = await instrumentedInvoke(value);
    assertFailure(actual.result, "identity_namespace_mismatch");
    assertTrace(actual.calls, IDENTITY_VALIDATION_TRACE);
  });
  await test("provider construction follows all source validation", async () => {
    const actual = await instrumentedInvoke(input());
    assertTrace(actual.calls, [...IDENTITY_VALIDATION_TRACE, "createIdentitySecurityDependencies", "deriveSourceSessionIdentity", "deriveRepositoryIdentity", "deriveWorktreeIdentity", "compareIdentityScope"]);
  });
});

await group("provider and historical key boundaries", async () => {
  await test("provider failures are mapped to allowed redacted reasons", () => {
    const invalidVersion = input({ providerValue: provider({ version: "secret-provider-unknown" }) });
    assertFailure(verifyPendingHandoffIdentityScope(invalidVersion), "secret_provider_version_unsupported");
    const invalidKey = input({ providerValue: provider({ current_key_id: "bad key" }) });
    assertFailure(verifyPendingHandoffIdentityScope(invalidKey), "secret_key_id_invalid");
    const invalidKeys = input({ providerValue: provider({ verification_key_ids: frozen([CURRENT_KEY, CURRENT_KEY]) }) });
    assertFailure(verifyPendingHandoffIdentityScope(invalidKeys), "secret_verification_keys_invalid");
    const invalidShape = input({ providerValue: { version: "phr-secret-provider-v1" } });
    assertFailure(verifyPendingHandoffIdentityScope(invalidShape), "secret_provider_invalid");
    const hostileProvider = new Proxy(provider(), { ownKeys() { throw new Error(EXCEPTION_MARKER); } });
    const hostileResult = verifyPendingHandoffIdentityScope(input({ providerValue: hostileProvider }));
    assertFailure(hostileResult, "secret_provider_invalid");
    assertNoRaw(hostileResult);
  });
  await test("unknown historical key fails closed without derivation", async () => {
    const value = input({ sourceKey: "missing_key" });
    const actual = await instrumentedInvoke(value);
    assertFailure(actual.result, "identity_key_unavailable");
    assertTrace(actual.calls, [...IDENTITY_VALIDATION_TRACE, "createIdentitySecurityDependencies"]);
  });
  await test("historical verification entry is used for every derivation", async () => {
    const value = input({ currentSessionId: "different-current-session" });
    const actual = await instrumentedInvoke(value);
    assertSuccess(actual.result, value, "match");
    assertTrace(actual.calls, [...IDENTITY_VALIDATION_TRACE, "createIdentitySecurityDependencies", "deriveSourceSessionIdentity", "deriveRepositoryIdentity", "deriveWorktreeIdentity", "compareIdentityScope"]);
  });
});

await group("derivation failures and scope comparison counts", async () => {
  await test("session derivation failure stops repository and worktree", async () => {
    const value = input({ providerValue: provider({ keyed_digest: frozen(() => { throw new Error(EXCEPTION_MARKER); }) }) });
    const actual = await instrumentedInvoke(value);
    assertFailure(actual.result, "session_identity_unknown");
    assertTrace(actual.calls, [...IDENTITY_VALIDATION_TRACE, "createIdentitySecurityDependencies", "deriveSourceSessionIdentity"]);
    assertNoRaw(actual.result);
  });
  await test("repository derivation failure stops worktree and comparison", async () => {
    const value = input({
      providerValue: provider({ keyed_digest: frozen(({ bytes }) => {
        const decoded = new TextDecoder().decode(bytes);
        if (decoded.includes("repository")) throw new Error(EXCEPTION_MARKER);
        return digestFor({ key_id: OLD_KEY, purpose: "pending-handoff-identity", bytes });
      }) }),
    });
    const actual = await instrumentedInvoke(value);
    assertFailure(actual.result, "repository_identity_unknown");
    assertTrace(actual.calls, [...IDENTITY_VALIDATION_TRACE, "createIdentitySecurityDependencies", "deriveSourceSessionIdentity", "deriveRepositoryIdentity"]);
  });
  await test("worktree derivation failure stops comparison", async () => {
    const value = input({
      providerValue: provider({ keyed_digest: frozen(({ bytes }) => {
        const decoded = new TextDecoder().decode(bytes);
        if (decoded.includes("worktree")) throw new Error(EXCEPTION_MARKER);
        return digestFor({ key_id: OLD_KEY, purpose: "pending-handoff-identity", bytes });
      }) }),
    });
    const actual = await instrumentedInvoke(value);
    assertFailure(actual.result, "worktree_identity_unknown");
    assertTrace(actual.calls, [...IDENTITY_VALIDATION_TRACE, "createIdentitySecurityDependencies", "deriveSourceSessionIdentity", "deriveRepositoryIdentity", "deriveWorktreeIdentity"]);
  });
  await test("session repository and worktree comparison outcomes use exact callback counts", async () => {
    const cases = [
      [input({ currentSessionId: "source-session" }), "same_session", 1],
      [input(), "match", 3],
      [input({ currentRepositoryPath: "aixion1506/other" }), "repository_mismatch", 2],
      [input({ currentRoot: `${ROOT}-other` }), "worktree_mismatch", 3],
    ];
    for (const [caseValue, expected, compareCount] of cases) {
      let safeEqualCalls = 0;
      const value = {
        ...caseValue,
        provider: provider({
          safe_equal: frozen((left, right) => {
            safeEqualCalls += 1;
            return left === right;
          }),
        }),
      };
      const actual = await instrumentedInvoke(value);
      if (expected === "same_session" || expected === "match") assertSuccess(actual.result, value, expected);
      else assertFailure(actual.result, expected);
      assert.equal(actual.calls.filter(call => call.dependency === "compareIdentityScope").length, 1);
      assert.equal(safeEqualCalls, compareCount);
    }
  });
  await test("keyed_digest runs exactly once for each real derivation stage", async () => {
    const digestStages = [];
    const value = input({
      providerValue: provider({
        keyed_digest: frozen(({ key_id, purpose, bytes }) => {
          const preimage = JSON.parse(new TextDecoder().decode(bytes));
          digestStages.push(preimage[1]);
          return digestFor({ key_id, purpose, bytes });
        }),
      }),
    });
    const actual = await instrumentedInvoke(value);
    assertSuccess(actual.result, value, "match");
    assert.deepEqual(digestStages, ["session", "repository", "worktree"]);
    assert.equal(digestStages.filter(stage => stage === "session").length, 1);
    assert.equal(digestStages.filter(stage => stage === "repository").length, 1);
    assert.equal(digestStages.filter(stage => stage === "worktree").length, 1);
    assertTrace(actual.calls, [...IDENTITY_VALIDATION_TRACE, "createIdentitySecurityDependencies", "deriveSourceSessionIdentity", "deriveRepositoryIdentity", "deriveWorktreeIdentity", "compareIdentityScope"]);
  });
  await test("safe_equal exception is sanitized and never escapes", async () => {
    const value = input({ providerValue: provider({ safe_equal: frozen(() => { throw new Error(EXCEPTION_MARKER); }) }) });
    const actual = await instrumentedInvoke(value);
    assertFailure(actual.result, "session_identity_unknown");
    assertNoRaw(actual.result);
  });
  await test("safe_equal throw short-circuits later comparator calls and effects", async () => {
    const throwAt = 2;
    let safeEqualCalls = 0;
    let thrown = false;
    const comparisonEvents = [];
    const value = input({
      providerValue: provider({
        safe_equal: frozen((left, right) => {
          safeEqualCalls += 1;
          comparisonEvents.push(`call:${safeEqualCalls}`);
          if (safeEqualCalls === throwAt) {
            thrown = true;
            comparisonEvents.push(`throw:${safeEqualCalls}`);
            throw new Error(EXCEPTION_MARKER);
          }
          if (thrown) comparisonEvents.push(`post-throw:${safeEqualCalls}`);
          comparisonEvents.push(`return:${safeEqualCalls}`);
          return left === right;
        }),
      }),
    });
    const actual = await instrumentedInvoke(value);
    assertFailure(actual.result, "repository_identity_unknown");
    assertNoRaw(actual.result);
    assert.equal(safeEqualCalls, throwAt);
    assert.deepEqual(comparisonEvents, ["call:1", "return:1", "call:2", "throw:2"]);
    assertTrace(actual.calls, [...IDENTITY_VALIDATION_TRACE, "createIdentitySecurityDependencies", "deriveSourceSessionIdentity", "deriveRepositoryIdentity", "deriveWorktreeIdentity", "compareIdentityScope"]);
  });
});

await group("fresh output freeze non-aliasing and privacy", async () => {
  await test("success and nested current are fresh frozen exact objects", () => {
    const value = input({ currentSessionId: "source-session" });
    const first = verifyPendingHandoffIdentityScope(value);
    const second = verifyPendingHandoffIdentityScope(value);
    assertSuccess(first, value, "same_session");
    assertSuccess(second, value, "same_session");
    assert.notEqual(first, second);
    assert.notEqual(first.current, second.current);
    assert.throws(() => { first.current.session_identity = "mutation"; }, TypeError);
    assert.throws(() => { first.result = "mutation"; }, TypeError);
    assert.deepEqual(Object.keys(value), ["provider", "source", "current"]);
  });
  await test("failures are fresh frozen exact objects without metadata", () => {
    const first = verifyPendingHandoffIdentityScope(null);
    const second = verifyPendingHandoffIdentityScope(null);
    assertFailure(first, "identity_composition_input_invalid");
    assertFailure(second, "identity_composition_input_invalid");
    assert.notEqual(first, second);
    assert.equal(Object.hasOwn(first, "metadata"), false);
    assertNoRaw(first);
  });
  await test("raw evidence and exception markers never cross the boundary", async () => {
    const value = input({
      currentSessionId: RAW_SESSION_MARKER,
      currentRepositoryPath: RAW_REPOSITORY_MARKER,
      currentRoot: RAW_ROOT_MARKER,
      providerValue: provider({ keyed_digest: frozen(() => { throw new Error(EXCEPTION_MARKER); }) }),
    });
    const captured = await captureOutput(() => verifyPendingHandoffIdentityScope(value));
    assertFailure(captured.result, "session_identity_unknown");
    assertNoRaw(captured.result);
    assert.deepEqual(captured.writes, []);
  });
});

await group("static boundary and Makefile contract", async () => {
  await test("production has one public export and only approved local imports", () => {
    assert.equal((COMPOSITION_SOURCE.match(/^export\s+/gm) ?? []).length, 1);
    assert.match(COMPOSITION_SOURCE, /export function verifyPendingHandoffIdentityScope\(input\)/);
    assert.match(COMPOSITION_SOURCE, /from "\.\/pending-handoff-identity\.mjs"/);
    assert.match(COMPOSITION_SOURCE, /from "\.\/pending-handoff-secret-provider\.mjs"/);
    assert.doesNotMatch(COMPOSITION_SOURCE, /from ["']node:/);
    assert.doesNotMatch(COMPOSITION_SOURCE, /\b(?:console|process|fetch|crypto|randomUUID|setTimeout|readFileSync|writeFileSync)\b/);
  });
  await test("importing production has no side effect", () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./scripts/lib/pending-handoff-identity-composition.mjs');"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
    });
    assert.equal(child.status, 0);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "");
  });
  await test("Makefile composition target and aggregate dependency are exact", () => {
    const makefile = readFileSync(fileURLToPath(new URL("../Makefile", import.meta.url)), "utf8");
    assert.equal((makefile.match(/^\.PHONY:.*test-pending-handoff-identity-composition-fixtures/m) ?? []).length, 1);
    assert.equal((makefile.match(/^test-pending-handoff-identity-composition-fixtures:/gm) ?? []).length, 1);
    assert.match(makefile, /^test-pending-handoff-identity-composition-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-identity-composition-fixtures\.mjs$/m);
    const lines = makefile.split("\n");
    const start = lines.findIndex(line => line.startsWith("test-v1x-fixtures:"));
    assert.notEqual(start, -1);
    const declaration = [lines[start]];
    while (declaration.at(-1).endsWith("\\")) declaration.push(lines[start + declaration.length]);
    assert.deepEqual(declaration.join(" ").replace(/^test-v1x-fixtures:\s*/, "").replaceAll("\\", " ").trim().split(/\s+/).slice(-6), [
      "test-pending-handoff-identity-fixtures",
      "test-pending-handoff-secret-provider-fixtures",
      "test-pending-handoff-identity-composition-fixtures",
      "test-pending-handoff-candidate-fixtures",
      "test-pending-handoff-store-fixtures",
      "test-pending-handoff-integrity-fixtures",
    ]);
  });
});

const mutationEvidence = [];
await group("one-defect production mutation matrix", async () => {
  for (const mutation of MUTATION_CASES) {
    await test(`mutation detected: ${mutation.name}`, async () => {
      await assertMutationDetected(mutation);
      mutationEvidence.push(mutation.name);
    });
  }
});

assert.equal(mutationEvidence.length, 22);
process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS MUTATIONS ${mutationEvidence.length}\n`);
