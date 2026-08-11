import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PENDING_HANDOFF_SCHEMA_VERSION,
  PENDING_HANDOFF_STATUSES,
} from "./lib/pending-handoff-core.mjs";

let canonicalizePendingHandoffCandidate = null;
try {
  ({ canonicalizePendingHandoffCandidate } = await import(
    "./lib/pending-handoff-candidate.mjs"
  ));
} catch {
  // The first assertion reports a missing boundary without exposing an import path.
}

const FIELD_ORDER = Object.freeze([
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
const ARRAY_FIELDS = Object.freeze([
  "completed",
  "open_issues",
  "verification",
  "do_not_touch",
]);
const SESSION_IDENTITY = `phr1.session.key_A-1.${"A".repeat(43)}`;
const REPOSITORY_IDENTITY = `phr1.repository.key_A-1.${"B".repeat(43)}`;
const WORKTREE_IDENTITY = `phr1.worktree.key_A-1.${"C".repeat(43)}`;
const EXCEPTION_MARKER = "candidate-exception-marker";
const RAW_MARKER = "candidate-raw-marker";
const CANDIDATE_SOURCE_URL = new URL("./lib/pending-handoff-candidate.mjs", import.meta.url);
const CORE_SOURCE_URL = new URL("./lib/pending-handoff-core.mjs", import.meta.url);
const IDENTITY_SOURCE_URL = new URL("./lib/pending-handoff-identity.mjs", import.meta.url);
const CANDIDATE_SOURCE = readFileSync(fileURLToPath(CANDIDATE_SOURCE_URL), "utf8");

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

function candidate(overrides = {}) {
  return {
    candidate_id: "candidate-opaque-001",
    schema_version: PENDING_HANDOFF_SCHEMA_VERSION,
    status: "candidate",
    created_at: "2026-07-30T01:00:00.000Z",
    expires_at: "2026-07-30T02:00:00.000Z",
    source_runtime: "codex",
    source_session_identity: SESSION_IDENTITY,
    repository_identity: REPOSITORY_IDENTITY,
    worktree_identity: WORKTREE_IDENTITY,
    goal: "Implement the pure pending handoff candidate boundary.",
    completed: ["Fixture contract drafted."],
    open_issues: [],
    verification: ["Core and identity validators are available."],
    do_not_touch: ["Store and runtime adapters."],
    next_action: "Run the independent Main review.",
    context_checkpoint_status: "review_needed",
    privacy_redaction_status: "passed",
    ...overrides,
  };
}

function nullPrototypeCandidate(overrides = {}) {
  const value = Object.create(null);
  const source = candidate(overrides);
  for (const key of Reflect.ownKeys(source)) {
    Object.defineProperty(value, key, Object.getOwnPropertyDescriptor(source, key));
  }
  return value;
}

function invoke(input) {
  assert.equal(typeof canonicalizePendingHandoffCandidate, "function", "canonicalizer export is missing");
  return canonicalizePendingHandoffCandidate(input);
}

function assertPrototype(value, expected) {
  assert.equal(Object.getPrototypeOf(value), expected);
}

function assertFrozenData(value, key, expectedValue, enumerable = true) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  assert.ok(descriptor, `${key} descriptor is missing`);
  assert.equal(Object.hasOwn(descriptor, "value"), true, `${key} is not data`);
  assert.equal(Object.hasOwn(descriptor, "get"), false, `${key} has a getter`);
  assert.equal(Object.hasOwn(descriptor, "set"), false, `${key} has a setter`);
  assert.equal(descriptor.value, expectedValue, `${key} value differs`);
  assert.equal(descriptor.writable, false, `${key} is writable`);
  assert.equal(descriptor.enumerable, enumerable, `${key} enumerable flag differs`);
  assert.equal(descriptor.configurable, false, `${key} is configurable`);
}

function assertFailure(result, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  assertPrototype(result, Object.prototype);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(Object.isFrozen(result), true);
  assertFrozenData(result, "ok", false);
  assertFrozenData(result, "reason", reason);
  assert.equal(Object.hasOwn(result, "value"), false);
}

function assertSuccess(result, source) {
  assert.equal(result.ok, true);
  assertPrototype(result, Object.prototype);
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "value"]);
  assert.equal(Object.isFrozen(result), true);
  assertFrozenData(result, "ok", true);

  const value = result.value;
  assertPrototype(value, Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value), FIELD_ORDER);
  assert.equal(Object.isFrozen(value), true);
  for (const field of FIELD_ORDER) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    assert.ok(descriptor, `${field} descriptor is missing`);
    assert.equal(Object.hasOwn(descriptor, "value"), true, `${field} is not data`);
    assert.equal(Object.hasOwn(descriptor, "get"), false, `${field} has a getter`);
    assert.equal(Object.hasOwn(descriptor, "set"), false, `${field} has a setter`);
    assert.equal(descriptor.writable, false, `${field} is writable`);
    assert.equal(descriptor.enumerable, true, `${field} is not enumerable`);
    assert.equal(descriptor.configurable, false, `${field} is configurable`);
    if (!ARRAY_FIELDS.includes(field)) {
      assert.equal(descriptor.value, source[field], `${field} was rewritten`);
      continue;
    }
    const array = descriptor.value;
    assert.equal(Array.isArray(array), true, `${field} is not an array`);
    assert.deepEqual(array, source[field], `${field} values differ`);
    assertPrototype(array, Array.prototype);
    assert.equal(Object.isFrozen(array), true, `${field} is not frozen`);
    assert.deepEqual(
      Reflect.ownKeys(array),
      [...array.keys()].map(String).concat("length"),
      `${field} keys differ`,
    );
    const length = Object.getOwnPropertyDescriptor(array, "length");
    assert.deepEqual(length, {
      value: array.length,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    for (const index of array.keys()) assertFrozenData(array, String(index), array[index]);
  }
  assertFrozenData(result, "value", value);
  return value;
}

function assertNoRawValue(result) {
  assert.deepEqual(Reflect.ownKeys(result), ["ok", "reason"]);
  assert.equal(result.reason.includes(RAW_MARKER), false);
  assert.equal(result.reason.includes(EXCEPTION_MARKER), false);
}

function assertInputInvalid(input) { assertFailure(invoke(input), "candidate_input_invalid"); }
function assertSemanticInvalid(input) { assertFailure(invoke(input), "candidate_semantic_invalid"); }
function assertIdentityInvalid(input) { assertFailure(invoke(input), "candidate_identity_invalid"); }

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
    `// candidate-fixture-module-${instrumentedModuleId}\n${source}`,
  )}`;
}

async function loadInstrumentedCandidate(sourceTransform = source => source) {
  const stateUrl = dataModuleUrl("export const calls = [];\n");
  const coreSpyUrl = dataModuleUrl(`
import { validateCandidate as real } from ${JSON.stringify(CORE_SOURCE_URL.href)};
import { calls } from ${JSON.stringify(stateUrl)};
export function validateCandidate(value) {
  calls.push({ dependency: "core" });
  return real(value);
}
`);
  const identitySpyUrl = dataModuleUrl(`
import { validateOpaqueIdentity as real } from ${JSON.stringify(IDENTITY_SOURCE_URL.href)};
import { calls } from ${JSON.stringify(stateUrl)};
export function validateOpaqueIdentity(value) {
  calls.push({ dependency: "identity", value });
  return real(value);
}
`);
  const source = sourceTransform(CANDIDATE_SOURCE)
    .replace('from "./pending-handoff-core.mjs"', `from ${JSON.stringify(coreSpyUrl)}`)
    .replace('from "./pending-handoff-identity.mjs"', `from ${JSON.stringify(identitySpyUrl)}`);
  const state = await import(stateUrl);
  const module = await import(dataModuleUrl(source));
  return { canonicalize: module.canonicalizePendingHandoffCandidate, calls: state.calls };
}

async function instrumentedInvoke(input, sourceTransform) {
  const loaded = await loadInstrumentedCandidate(sourceTransform);
  return { result: loaded.canonicalize(input), calls: loaded.calls };
}

function assertTrace(actual, expected) {
  assert.equal(actual.filter(call => call.dependency === "core").length,
    expected.filter(call => call.dependency === "core").length);
  assert.equal(actual.filter(call => call.dependency === "identity").length,
    expected.filter(call => call.dependency === "identity").length);
  assert.deepEqual(actual, expected);
}

function replaceOnce(source, expected, replacement) {
  const count = source.split(expected).length - 1;
  if (count !== 1) throw new Error(`mutation anchor count ${count}: ${expected}`);
  return source.replace(expected, replacement);
}

function replaceFunctionOnce(source, name, replacement) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf("\nfunction isEnumerableDataDescriptor", start);
  if (start < 0 || end < 0) throw new Error(`mutation function anchor missing: ${name}`);
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

const SPARSE_ARRAY_MUTANT = `function copyDenseArray(input) {
  try {
    if (Object.getPrototypeOf(input) !== Array.prototype) return null;
    const keys = Reflect.ownKeys(input);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    const isIndexKey = key => typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key);
    if (!isDataDescriptor(lengthDescriptor) || lengthDescriptor.enumerable
      || lengthDescriptor.configurable || typeof lengthDescriptor.value !== "number"
      || !Number.isInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
      || lengthDescriptor.value > 4_294_967_295 || keys[keys.length - 1] !== "length"
      || keys.some(key => key !== "length" && !isIndexKey(key))) return null;
    const copy = [];
    copy.length = lengthDescriptor.value;
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined) continue;
      if (!isEnumerableDataDescriptor(descriptor)) return null;
      Object.defineProperty(copy, key, {
        value: descriptor.value, writable: true, enumerable: true, configurable: true,
      });
    }
    return copy;
  } catch { return null; }
}`;

const boundaryMutation = (input, reason, calls) => async mutate => {
  const actual = await instrumentedInvoke(input, mutate);
  assertFailure(actual.result, reason);
  assertTrace(actual.calls, calls);
};
const successMutation = assertion => async mutate => {
  const input = candidate();
  const actual = await instrumentedInvoke(input, mutate);
  assert.equal(actual.result.ok, true);
  assertion(actual.result, input);
};
const kindMutation = field => source => replaceOnce(
  source,
  "identity.kind !== expectedKind",
  `field !== "${field}" && identity.kind !== expectedKind`,
);

const MUTATION_CASES = [
  {
    name: "exact-key gate bypass",
    mutate: source => replaceOnce(source, "if (!hasExactCandidateKeys(ownKeys)) return null;", "if (false) return null;"),
    verify: boundaryMutation(candidate({ unexpected: "extra" }), "candidate_input_invalid", []),
  },
  {
    name: "accessor allowed",
    mutate: source => replaceOnce(
      source,
      "      if (!isEnumerableDataDescriptor(descriptor)) return null;\n\n      const value = descriptor.value;",
      "      if (descriptor === undefined) return null;\n\n      const value = descriptor.value;",
    ),
    verify: async mutate => {
      const input = candidate();
      let getterCalled = false;
      Object.defineProperty(input, "goal", {
        get() { getterCalled = true; return "accessor-value"; }, enumerable: true, configurable: true,
      });
      const actual = await instrumentedInvoke(input, mutate);
      assertFailure(actual.result, "candidate_input_invalid");
      assertTrace(actual.calls, []);
      assert.equal(getterCalled, false);
    },
  },
  {
    name: "Symbol key allowed",
    mutate: source => replaceOnce(
      source,
      "if (!hasExactCandidateKeys(ownKeys)) return null;",
      "if (!hasExactCandidateKeys(ownKeys.filter(key => typeof key === \"string\"))) return null;",
    ),
    verify: boundaryMutation(
      Object.assign(candidate(), { [Symbol("unexpected")]: "extra" }),
      "candidate_input_invalid",
      [],
    ),
  },
  {
    name: "sparse array allowed",
    mutate: source => replaceFunctionOnce(source, "copyDenseArray(input)", SPARSE_ARRAY_MUTANT),
    verify: boundaryMutation(
      (() => { const value = candidate(); const sparse = []; sparse.length = 1; value.completed = sparse; return value; })(),
      "candidate_input_invalid",
      [],
    ),
  },
  {
    name: "Core validator bypass",
    mutate: source => replaceOnce(source, "validation = validateCandidate(snapshot);", "validation = { ok: true };") ,
    verify: boundaryMutation(candidate({ schema_version: "9.9" }), "candidate_semantic_invalid", [{ dependency: "core" }]),
  },
  {
    name: "Status gate bypass",
    mutate: source => replaceOnce(
      source,
      '  if (snapshot.status !== "candidate") {\n    return failure("candidate_semantic_invalid");\n  }',
      '  if (false) {\n    return failure("candidate_semantic_invalid");\n  }',
    ),
    verify: boundaryMutation(candidate({ status: "pending" }), "candidate_semantic_invalid", [{ dependency: "core" }]),
  },
  ...["source_session_identity", "repository_identity", "worktree_identity"].map((field, index) => {
    const wrong = [REPOSITORY_IDENTITY, WORKTREE_IDENTITY, SESSION_IDENTITY][index];
    const expectedCalls = [
      [{ dependency: "core" }, { dependency: "identity", value: wrong }],
      [{ dependency: "core" }, { dependency: "identity", value: SESSION_IDENTITY }, { dependency: "identity", value: wrong }],
      [{ dependency: "core" }, { dependency: "identity", value: SESSION_IDENTITY }, { dependency: "identity", value: REPOSITORY_IDENTITY }, { dependency: "identity", value: wrong }],
    ][index];
    return {
      name: `${field.replaceAll("_identity", "")} identity kind bypass`,
      mutate: kindMutation(field),
      verify: boundaryMutation(candidate({ [field]: wrong }), "candidate_identity_invalid", expectedCalls),
    };
  }),
  {
    name: "input Candidate alias returned",
    mutate: source => replaceOnce(source, "return Object.freeze({ ok: true, value: snapshot });", "return Object.freeze({ ok: true, value: input });"),
    verify: successMutation((result, input) => assert.notEqual(result.value, input)),
  },
  {
    name: "nested array alias returned",
    mutate: source => replaceOnce(source, "const copiedValue = valueIsArray ? copyDenseArray(value) : value;", "const copiedValue = valueIsArray ? value : value;"),
    verify: successMutation((result, input) => assert.notEqual(result.value.completed, input.completed)),
  },
  {
    name: "result freeze missing",
    mutate: source => replaceOnce(source, "return Object.freeze({ ok: true, value: snapshot });", "return { ok: true, value: snapshot };") ,
    verify: successMutation(result => assert.equal(Object.isFrozen(result), true)),
  },
  {
    name: "Candidate freeze missing",
    mutate: source => replaceOnce(source, "    Object.freeze(snapshot);\n    return Object.freeze({ ok: true, value: snapshot });", "    void snapshot;\n    return Object.freeze({ ok: true, value: snapshot });"),
    verify: successMutation(result => assert.equal(Object.isFrozen(result.value), true)),
  },
  {
    name: "nested array freeze missing",
    mutate: source => replaceOnce(source, "if (Array.isArray(descriptor.value)) Object.freeze(descriptor.value);", "if (false && Array.isArray(descriptor.value)) Object.freeze(descriptor.value);"),
    verify: successMutation(result => assert.equal(Object.isFrozen(result.value.completed), true)),
  },
  {
    name: "raw-value logging",
    mutate: source => replaceOnce(source, "export function canonicalizePendingHandoffCandidate(input) {\n", "export function canonicalizePendingHandoffCandidate(input) {\n  console.log(input);\n"),
    verify: async mutate => {
      const input = candidate({ goal: RAW_MARKER });
      const captured = await captureOutput(async () => (await loadInstrumentedCandidate(mutate)).canonicalize(input));
      assert.equal(captured.result.ok, true);
      assert.deepEqual(captured.writes, []);
    },
  },
  {
    name: "import-time side effect",
    mutate: source => replaceOnce(source, 'import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";\n', 'import { validateOpaqueIdentity } from "./pending-handoff-identity.mjs";\nconsole.log("candidate-raw-marker");\n'),
    verify: async mutate => {
      const captured = await captureOutput(() => loadInstrumentedCandidate(mutate));
      assert.deepEqual(captured.writes, []);
    },
  },
];

const mutationEvidence = [];
async function assertMutationDetected(mutation) {
  let error = null;
  try { await mutation.verify(mutation.mutate); } catch (candidateError) { error = candidateError; }
  assert.ok(error, `${mutation.name} survived its intended oracle`);
  assert.equal(error.code, "ERR_ASSERTION", `${mutation.name} failed outside an assertion oracle`);
  mutationEvidence.push(mutation.name);
}

await group("reflection-safe top-level input and Proxy fail-closed behavior", async () => {
  await test("canonical 17-field object succeeds", () => assertSuccess(invoke(candidate()), candidate()));
  await test("null-prototype Candidate fails without dependencies or output", async () => {
    const captured = await captureOutput(() => instrumentedInvoke(nullPrototypeCandidate()));
    assertFailure(captured.result.result, "candidate_input_invalid");
    assertTrace(captured.result.calls, []); assert.deepEqual(captured.writes, []);
    let getterCalled = false;
    const accessor = nullPrototypeCandidate();
    Object.defineProperty(accessor, "goal", { get() { getterCalled = true; throw new Error(EXCEPTION_MARKER); }, enumerable: true, configurable: true });
    const second = await instrumentedInvoke(accessor);
    assertFailure(second.result, "candidate_input_invalid"); assertTrace(second.calls, []); assert.equal(getterCalled, false);
  });
  await test("wrong top-level types fail without throwing", () => {
    for (const input of [null, undefined, "candidate", 42, true, () => {}, []]) assertInputInvalid(input);
  });
  await test("missing, additional, Symbol, inherited, non-enumerable, and accessor keys fail", () => {
    const missing = candidate(); delete missing.goal; assertInputInvalid(missing);
    assertInputInvalid(candidate({ unexpected: "extra" }));
    const withSymbol = candidate(); withSymbol[Symbol("unexpected")] = "extra"; assertInputInvalid(withSymbol);
    const inherited = Object.create({ extra: "inherited" });
    for (const key of FIELD_ORDER) Object.defineProperty(inherited, key, Object.getOwnPropertyDescriptor(candidate(), key));
    assertInputInvalid(inherited);
    const nonEnumerable = candidate();
    Object.defineProperty(nonEnumerable, "goal", { value: nonEnumerable.goal, enumerable: false, writable: true, configurable: true });
    assertInputInvalid(nonEnumerable);
    let getterCalled = false;
    const accessor = candidate();
    Object.defineProperty(accessor, "goal", { get() { getterCalled = true; throw new Error(EXCEPTION_MARKER); }, enumerable: true, configurable: true });
    assertInputInvalid(accessor); assert.equal(getterCalled, false);
  });
  await test("each hostile descriptor Proxy is called once and leaks no exception", () => {
    const ownKeysProxy = new Proxy(candidate(), { ownKeys() { throw new Error(EXCEPTION_MARKER); } });
    assertInputInvalid(ownKeysProxy);
    const descriptorProxy = new Proxy(candidate(), { getOwnPropertyDescriptor() { throw new Error(EXCEPTION_MARKER); } });
    const result = invoke(descriptorProxy);
    assertFailure(result, "candidate_input_invalid"); assertNoRawValue(result);
  });
});

await group("exact dense array inspection", async () => {
  await test("sparse arrays fail for every Candidate array field", () => {
    for (const field of ARRAY_FIELDS) { const input = candidate(); const sparse = []; sparse.length = 1; input[field] = sparse; assertInputInvalid(input); }
  });
  await test("array accessors and Proxy traps are not invoked", () => {
    let getterCalled = false;
    const values = []; Object.defineProperty(values, "0", { get() { getterCalled = true; throw new Error(EXCEPTION_MARKER); }, enumerable: true, configurable: true }); values.length = 1;
    const input = candidate({ completed: values }); assertInputInvalid(input); assert.equal(getterCalled, false);
    const proxied = new Proxy(candidate().completed, { getOwnPropertyDescriptor() { throw new Error(EXCEPTION_MARKER); } });
    assertInputInvalid(candidate({ completed: proxied }));
  });
  await test("array extra keys, Symbols, and exotic prototypes fail", () => {
    const extra = candidate(); extra.completed.extra = "unexpected"; assertInputInvalid(extra);
    const symbol = candidate(); symbol.open_issues[Symbol("unexpected")] = "extra"; assertInputInvalid(symbol);
    const exotic = candidate(); Object.setPrototypeOf(exotic.verification, null); assertInputInvalid(exotic);
  });
  await test("invalid nested objects never reach coercion hooks", () => {
    let toStringCalled = false;
    const input = candidate({ schema_version: { toString() { toStringCalled = true; throw new Error(EXCEPTION_MARKER); } } });
    assertInputInvalid(input); assert.equal(toStringCalled, false);
  });
});

await group("existing Core semantic validation", async () => {
  await test("required strings, arrays, timestamps, checkpoint, and privacy delegate to Core", () => {
    for (const field of ["candidate_id", "source_runtime", "source_session_identity", "repository_identity", "worktree_identity", "goal", "next_action"]) assertSemanticInvalid(candidate({ [field]: "" }));
    for (const field of ARRAY_FIELDS) {
      assertSemanticInvalid(candidate({ [field]: "not-an-array" }));
      assertSemanticInvalid(candidate({ [field]: ["valid", 42] }));
      assertSemanticInvalid(candidate({ [field]: ["   "] }));
    }
    for (const overrides of [{ schema_version: "9.9" }, { created_at: "not-a-timestamp" }, { expires_at: "2026-07-30T00:00:00.000Z" }, { context_checkpoint_status: "clean" }, { privacy_redaction_status: "unknown" }]) assertSemanticInvalid(candidate(overrides));
  });
});

await group("Candidate-only lifecycle", async () => {
  await test("every non-candidate status is rejected semantically", () => {
    for (const status of [...PENDING_HANDOFF_STATUSES, "unknown"]) if (status !== "candidate") assertSemanticInvalid(candidate({ status }));
  });
});

await group("opaque identity kind and format", async () => {
  await test("session, repository, and worktree require exact kinds", () => {
    for (const [field, value] of [["source_session_identity", "invalid"], ["source_session_identity", REPOSITORY_IDENTITY], ["repository_identity", "invalid"], ["repository_identity", WORKTREE_IDENTITY], ["worktree_identity", "invalid"], ["worktree_identity", SESSION_IDENTITY]]) assertIdentityInvalid(candidate({ [field]: value }));
  });
  await test("raw-looking and boxed identities fail without echo", () => {
    for (const [field, value] of [["source_session_identity", "/absolute/session/path"], ["repository_identity", "https://user:credential@host/repository"], ["worktree_identity", "/absolute/worktree/path"]]) { const result = invoke(candidate({ [field]: value })); assertFailure(result, "candidate_identity_invalid"); assertNoRawValue(result); }
    assertInputInvalid(candidate({ source_session_identity: new String(SESSION_IDENTITY) }));
  });
});

await group("success shape, freeze, freshness, and non-aliasing", async () => {
  await test("success output is exact frozen data with fresh arrays", () => {
    const input = candidate(); const result = invoke(input); const value = assertSuccess(result, input);
    assert.notEqual(value, input); for (const field of ARRAY_FIELDS) assert.notEqual(value[field], input[field]);
  });
  await test("each successful call returns fresh snapshots", () => {
    const input = candidate(); const first = invoke(input); const second = invoke(input); assertSuccess(first, input); assertSuccess(second, input);
    assert.notEqual(first, second); assert.notEqual(first.value, second.value); for (const field of ARRAY_FIELDS) assert.notEqual(first.value[field], second.value[field]);
  });
  await test("frozen Candidate and arrays reject mutation", () => {
    const input = candidate(); const result = invoke(input); assertSuccess(result, input);
    assert.throws(() => { result.value.goal = "mutation"; }, TypeError); assert.throws(() => { result.value.completed.push("mutation"); }, TypeError);
  });
});

await group("failure shape, reason taxonomy, freshness, and leakage", async () => {
  await test("only the three contract reasons are returned", () => {
    const results = [invoke(null), invoke(candidate({ status: "pending" })), invoke(candidate({ source_session_identity: "invalid" }))];
    assert.deepEqual(results.map(result => result.reason), ["candidate_input_invalid", "candidate_semantic_invalid", "candidate_identity_invalid"]);
    for (const result of results) assert.ok(["candidate_input_invalid", "candidate_semantic_invalid", "candidate_identity_invalid"].includes(result.reason));
  });
  await test("failure envelopes are frozen, fresh, exact, and metadata-free", () => {
    const first = invoke(candidate({ status: "pending" })); const second = invoke(candidate({ status: "pending" }));
    assertFailure(first, "candidate_semantic_invalid"); assertFailure(second, "candidate_semantic_invalid"); assert.notEqual(first, second);
    assert.equal(Object.hasOwn(first, "metadata"), false); assert.equal(Object.hasOwn(first, "field"), false);
  });
  await test("validator messages, fields, exceptions, and raw markers never escape", () => {
    const result = invoke(candidate({ status: "pending", goal: RAW_MARKER, next_action: EXCEPTION_MARKER })); assertFailure(result, "candidate_semantic_invalid"); assertNoRawValue(result);
  });
});

await group("input preservation and dependency short-circuit", async () => {
  await test("successful canonicalization preserves input keys and values", () => {
    const input = candidate(); const before = FIELD_ORDER.map(field => input[field]); const keys = Reflect.ownKeys(input); assertSuccess(invoke(input), input);
    assert.deepEqual(Reflect.ownKeys(input), keys); for (let index = 0; index < FIELD_ORDER.length; index += 1) assert.equal(input[FIELD_ORDER[index]], before[index]);
  });
  await test("Core failure prevents identity validation and coercion", () => {
    const input = candidate({ status: "pending", source_session_identity: RAW_MARKER, repository_identity: RAW_MARKER, worktree_identity: RAW_MARKER });
    const result = invoke(input); assertFailure(result, "candidate_semantic_invalid"); assertNoRawValue(result);
    const calls = []; const hooked = candidate(); for (const name of ["toJSON", "valueOf", "toString"]) Object.defineProperty(hooked, name, { value: () => calls.push(name), enumerable: true, configurable: true });
    Object.defineProperty(hooked, Symbol.toPrimitive, { value: () => calls.push("toPrimitive"), enumerable: true, configurable: true }); assertInputInvalid(hooked); assert.deepEqual(calls, []);
  });
});

await group("real dependency call order and short-circuit counts", async () => {
  await test("success calls Core once then Session, Repository, Worktree identities", async () => {
    const input = candidate(); const actual = await instrumentedInvoke(input); assertSuccess(actual.result, input);
    assertTrace(actual.calls, [{ dependency: "core" }, { dependency: "identity", value: SESSION_IDENTITY }, { dependency: "identity", value: REPOSITORY_IDENTITY }, { dependency: "identity", value: WORKTREE_IDENTITY }]);
  });
  await test("structural, Core, status, and each identity failure short-circuit", async () => {
    const structural = candidate(); delete structural.goal;
    const accessor = candidate(); Object.defineProperty(accessor, "goal", { get() { throw new Error(EXCEPTION_MARKER); }, enumerable: true, configurable: true });
    const cases = [
      [structural, "candidate_input_invalid", []],
      [candidate({ unexpected: "extra" }), "candidate_input_invalid", []],
      [Object.assign(candidate(), { [Symbol("unexpected")]: "extra" }), "candidate_input_invalid", []],
      [accessor, "candidate_input_invalid", []],
      [candidate({ schema_version: "9.9" }), "candidate_semantic_invalid", [{ dependency: "core" }]],
      [candidate({ status: "pending" }), "candidate_semantic_invalid", [{ dependency: "core" }]],
      [candidate({ source_session_identity: "invalid" }), "candidate_identity_invalid", [{ dependency: "core" }, { dependency: "identity", value: "invalid" }]],
      [candidate({ repository_identity: "invalid" }), "candidate_identity_invalid", [{ dependency: "core" }, { dependency: "identity", value: SESSION_IDENTITY }, { dependency: "identity", value: "invalid" }]],
      [candidate({ worktree_identity: "invalid" }), "candidate_identity_invalid", [{ dependency: "core" }, { dependency: "identity", value: SESSION_IDENTITY }, { dependency: "identity", value: REPOSITORY_IDENTITY }, { dependency: "identity", value: "invalid" }]],
    ];
    for (const [input, reason, calls] of cases) { const actual = await instrumentedInvoke(input); assertFailure(actual.result, reason); assertTrace(actual.calls, calls); }
  });
});

await group("privacy capture across stdout, stderr, and console", async () => {
  await test("invalid identity and Proxy exception paths do not log or echo", async () => {
    const raw = candidate({ source_session_identity: RAW_MARKER, goal: EXCEPTION_MARKER });
    const captured = await captureOutput(() => invoke(raw)); assertFailure(captured.result, "candidate_identity_invalid"); assertNoRawValue(captured.result); assert.deepEqual(captured.writes, []);
    const proxy = new Proxy(candidate(), { ownKeys() { throw new Error(EXCEPTION_MARKER); } });
    const proxyCaptured = await captureOutput(() => invoke(proxy)); assertFailure(proxyCaptured.result, "candidate_input_invalid"); assertNoRawValue(proxyCaptured.result); assert.deepEqual(proxyCaptured.writes, []);
  });
});

await group("static production boundary and import side-effect zero", async () => {
  await test("production has one public export and only Core/Identity imports", () => {
    assert.equal((CANDIDATE_SOURCE.match(/^export\s+/gm) ?? []).length, 1);
    assert.match(CANDIDATE_SOURCE, /export function canonicalizePendingHandoffCandidate\(input\)/);
    assert.match(CANDIDATE_SOURCE, /from "\.\/pending-handoff-core\.mjs"/); assert.match(CANDIDATE_SOURCE, /from "\.\/pending-handoff-identity\.mjs"/);
    assert.doesNotMatch(CANDIDATE_SOURCE, /from ["']node:/); assert.doesNotMatch(CANDIDATE_SOURCE, /\b(?:console|process|fetch|crypto|randomUUID|setTimeout)\b/);
  });
  await test("importing production emits no stdout or stderr", () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./scripts/lib/pending-handoff-candidate.mjs');"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
    assert.equal(child.status, 0); assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
  });
});

await group("Makefile target and V1.x aggregate wiring", async () => {
  await test("Candidate target and recipe are declared once", () => {
    const makefile = readFileSync(fileURLToPath(new URL("../Makefile", import.meta.url)), "utf8");
    assert.equal((makefile.match(/^test-pending-handoff-candidate-fixtures:/gm) ?? []).length, 1);
    assert.match(makefile, /^test-pending-handoff-candidate-fixtures:\n\tnode \.\/scripts\/test-pending-handoff-candidate-fixtures\.mjs$/m);
    assert.equal((makefile.match(/^\.PHONY:.*test-pending-handoff-candidate-fixtures/m) ?? []).length, 1);
  });
  await test("one V1.x declaration and actual dry-run order contain each target once", () => {
    const makefile = readFileSync(fileURLToPath(new URL("../Makefile", import.meta.url)), "utf8");
    const lines = makefile.split("\n"); const start = lines.findIndex(line => line.startsWith("test-v1x-fixtures:")); assert.notEqual(start, -1);
    const declaration = [lines[start]]; while (declaration.at(-1).endsWith("\\")) declaration.push(lines[start + declaration.length]);
    assert.equal(lines.filter(line => line.startsWith("test-v1x-fixtures:")).length, 1);
    const expectedTargets = ["test-v1-fixtures", "test-context-checkpoint-fixtures", "test-pending-handoff-core-fixtures", "test-pending-handoff-identity-fixtures", "test-pending-handoff-secret-provider-fixtures", "test-pending-handoff-identity-composition-fixtures", "test-pending-handoff-candidate-fixtures", "test-pending-handoff-store-fixtures", "test-pending-handoff-integrity-fixtures", "test-pending-handoff-revision-cas-fixtures", "test-pending-handoff-claim-lease-fixtures"];
    assert.deepEqual(declaration.join(" ").replace(/^test-v1x-fixtures:\s*/, "").replaceAll("\\", " ").trim().split(/\s+/), expectedTargets);
    const dryRun = spawnSync("make", ["-n", "test-v1x-fixtures"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }); assert.equal(dryRun.status, 0);
    const commands = ["node ./scripts/test-context-checkpoint-fixtures.mjs", "node ./scripts/test-context-checkpoint-codex-fixtures.mjs", "node ./scripts/test-pending-handoff-core-fixtures.mjs", "node ./scripts/test-pending-handoff-identity-fixtures.mjs", "node ./scripts/test-pending-handoff-secret-provider-fixtures.mjs", "node ./scripts/test-pending-handoff-candidate-fixtures.mjs", "node ./scripts/test-pending-handoff-store-fixtures.mjs", "node ./scripts/test-pending-handoff-integrity-fixtures.mjs", "node ./scripts/test-pending-handoff-revision-cas-fixtures.mjs", "node ./scripts/test-pending-handoff-claim-lease-fixtures.mjs"];
    const outputLines = dryRun.stdout.trim().split("\n"); const positions = commands.map(command => { const found = outputLines.map((line, index) => ({ line, index })).filter(entry => entry.line === command); assert.equal(found.length, 1, `${command} dry-run count differs`); return found[0].index; });
    for (let index = 1; index < positions.length; index += 1) assert.ok(positions[index - 1] < positions[index]);
  });
});

await group("one-defect production mutation matrix", async () => {
  for (const mutation of MUTATION_CASES) await test(`mutation detected: ${mutation.name}`, () => assertMutationDetected(mutation));
});

assert.equal(mutationEvidence.length, 16);
process.stdout.write(`PASS TOTAL ${groups} GROUPS ${tests} TESTS MUTATIONS ${mutationEvidence.length}\n`);
