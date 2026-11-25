#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { buildCodexExecArgs as buildArgs, resolveCodexExecutable, buildSpawnEnv, classifyLoginStatus,
  classifyUsage, RUNNER_PRECONDITIONS } from "./lib/cross-runtime-codex-exec.mjs";
import { summarizeExecEvents, extractEffectiveSettings, evaluateExecOutcome, normalizeSandbox,
  usageDelta } from "./lib/cross-runtime-codex-observe.mjs";

function buildCodexExecArgs(request) {
  return buildArgs(request, "linux");
}

let count = 0;
function test(name, run) {
  try {
    run();
    count++;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

const boundary = { claim_status: "NOT_ACQUIRED", dispatch_status: "NOT_RUN" };
function expectBlocked(actual, code) {
  assert.deepEqual(actual, { status: "BLOCKED", code, attemptBoundary: boundary });
}
const request = { mode: "NEW", model: "gpt-6.1-terra", effort: "low", sandbox: "read-only",
  cwd: "/synthetic/worktree", outputLastMessagePath: "/synthetic/out" };
const threadId = "00000000-0000-0000-0000-000000000001";
for (const changes of [{ model: "" }, { effort: "" }, { effort: "invalid" }, { model: "-c" }, { model: "a b" }]) {
  test("invalid model or effort", () => expectBlocked(buildCodexExecArgs({ ...request, ...changes }),
    "MODEL_OR_EFFORT_MISSING"));
}
for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
  test("supported effort", () => assert.equal(buildCodexExecArgs({ ...request, effort }).status, "READY"));
}
for (const changes of [{ cwd: "" }, { cwd: null }, { outputLastMessagePath: " " },
  { outputLastMessagePath: undefined }]) {
  test("missing request path", () => expectBlocked(buildCodexExecArgs({ ...request, ...changes }), "REQUEST_INVALID"));
}
test("unknown mode", () => expectBlocked(buildCodexExecArgs({ ...request, mode: "OTHER" }), "MODE_INVALID"));
test("unsafe sandbox", () => expectBlocked(buildCodexExecArgs({ ...request, sandbox: "danger-full-access" }),
  "SANDBOX_NOT_ALLOWED"));
test("new argv", () => assert.deepEqual(buildCodexExecArgs(request), {
  status: "READY",
  argv: ["exec", "--json", "--skip-git-repo-check", "-m", request.model, "-c", "model_reasoning_effort=low",
    "-s", "read-only", "-C", request.cwd, "-o", request.outputLastMessagePath, "-"],
  spawnCwd: request.cwd,
}));
for (const sandbox of ["read-only", "workspace-write"]) {
  test("resume argv", () => {
    const result = buildCodexExecArgs({ ...request, mode: "RESUME", resumeThreadId: threadId, sandbox });
    assert.deepEqual(result, { status: "READY", argv: ["exec", "resume", threadId, "--json",
      "--skip-git-repo-check", "-m", request.model, "-c", "model_reasoning_effort=low", "-c",
      `sandbox_mode=${sandbox}`, "-o", request.outputLastMessagePath, "-"], spawnCwd: request.cwd });
    for (const forbidden of ["-s", "-C", "--sandbox", "--cd",
      "private prompt"]) assert.ok(!result.argv.includes(forbidden));
  });
}
test("bad resume id", () => expectBlocked(buildCodexExecArgs({ ...request, mode: "RESUME",
  resumeThreadId: "bad" }), "RESUME_ID_INVALID"));

const resolver = { platform: "win32", shimDir: "C:\\tools", worktreeRoots: [], exists: () => true };
function resolve(changes) {
  return resolveCodexExecutable({ ...resolver, ...changes });
}
test("vendor path", () => assert.match(resolve({}).path, /codex\.exe$/));
test("shim rejected", () => expectBlocked(resolve({ configuredPath: "C:\\tools\\codex.cmd" }),
  "EXECUTABLE_SHIM_REJECTED"));
test("worktree case insensitive", () => expectBlocked(resolve({ configuredPath: "C:\\WORK\\repo\\codex.exe",
  worktreeRoots: ["c:/work/REPO"] }), "EXECUTABLE_INSIDE_WORKTREE"));
test("extended prefix", () => expectBlocked(resolve({ configuredPath: "\\\\?\\C:\\work\\repo\\codex.exe",
  worktreeRoots: ["C:\\work\\repo"] }), "EXECUTABLE_INSIDE_WORKTREE"));
test("sibling prefix", () => assert.equal(resolve({ configuredPath: "C:\\ab\\codex.exe",
  worktreeRoots: ["C:\\a"] }).status, "READY"));
test("drive root", () => expectBlocked(resolve({ configuredPath: "C:\\a\\codex.exe",
  worktreeRoots: ["C:\\"] }), "EXECUTABLE_INSIDE_WORKTREE"));
test("relative root", () => expectBlocked(resolve({ worktreeRoots: ["relative"] }), "WORKTREE_ROOT_INVALID"));
test("posix case sensitive", () => assert.equal(resolve({ platform: "linux",
  configuredPath: "/work/Repo/codex", worktreeRoots: ["/work/repo"] }).status, "READY"));
test("relative executable", () => expectBlocked(resolve({ configuredPath: "relative.exe" }),
  "ENVIRONMENT_UNIDENTIFIED"));
test("missing executable", () => expectBlocked(resolve({ exists: () => false }), "ENVIRONMENT_UNIDENTIFIED"));
test("linux requires configured path", () => expectBlocked(resolve({ platform: "linux" }), "ENVIRONMENT_UNIDENTIFIED"));
test("environment windows", () => assert.deepEqual(buildSpawnEnv({ SystemRoot: "win", path: "x",
  OPENAI_API_KEY: "x", CODEX_API_KEY: "x" }, "win32"), { status: "READY", env: { SystemRoot: "win", path: "x" } }));
test("environment posix", () => assert.deepEqual(buildSpawnEnv({ path: "x", PATH: "y", SystemRoot: "z" },
  "linux"), { status: "READY", env: { PATH: "y" } }));

test("chatgpt login stderr", () => assert.deepEqual(classifyLoginStatus({ exitCode: 0,
  stderr: "Logged in using ChatGPT" }), { status: "READY", authMode: "chatgpt" }));
test("api key wins", () => expectBlocked(classifyLoginStatus({ exitCode: 0,
  stdout: "Logged in using ChatGPT\nAPI key secret" }), "AUTH_MODE_API_KEY"));
for (const input of [{ exitCode: 0 }, { exitCode: 1, stdout: "Logged in using ChatGPT" }, { exitCode: 0,
  stdout: "Logged in using ChatGPT (x)" }, { exitCode: 0, stdout: null }]) {
  test("login unobservable", () => {
    const result = classifyLoginStatus(input);
    expectBlocked(result, "AUTH_UNOBSERVABLE");
    assert.ok(!JSON.stringify(result).includes("Logged in"));
  });
}
const usage = { rateLimits: { primary: { usedPercent: 96 }, ordinaryUsageAllowed: true } };
const usageWindows = [{ name: "primary", usedPercent: 96, windowDurationMins: undefined }];
test("usage ceiling", () => assert.deepEqual(classifyUsage(usage, { ceilingPercent: 95 }),
  { status: "BLOCKED", code: "USAGE_CEILING", attemptBoundary: boundary, window: "primary" }));
test("usage exception", () => assert.deepEqual(classifyUsage(usage, { ceilingPercent: 95,
  ownerException: true }), { status: "READY", windows: usageWindows, ownerExceptionApplied: true }));
for (const input of [{}]) {
  test("unknown usage", () => expectBlocked(classifyUsage(input), "USAGE_UNKNOWN"));
}
for (const limits of [{ ordinaryUsageAllowed: false }, { rateLimitReachedType: "weekly" }]) {
  test("exhaustion overrides exception",
    () => expectBlocked(classifyUsage({ rateLimits: { primary: { usedPercent: 96 }, ...limits } },
    { ceilingPercent: 95, ownerException: true }), "USAGE_EXHAUSTED"));
}

function fixture(name) {
  return readFileSync(new URL(`../fixtures/cross-runtime/${name}`, import.meta.url), "utf8");
}
const effective = extractEffectiveSettings(fixture("rollout-terra-low.jsonl"));
const expectedEffective = { sessionId: threadId, turnId: "00000000-0000-0000-0000-000000000002",
  completedTurnId: "00000000-0000-0000-0000-000000000002", turnContextCount: 1, model: request.model,
  effort: "low", sandbox: { type: "read-only" },
  cwd: request.cwd, modelProvider: "openai" };
test("fixture settings", () => assert.deepEqual(effective, expectedEffective));
test("resume uses last context",
  () => assert.deepEqual(extractEffectiveSettings(fixture("rollout-realistic-resume.jsonl")),
    { ...expectedEffective, turnContextCount: 2 }));
test("null effort", () => assert.deepEqual(extractEffectiveSettings(fixture("rollout-null-effort.jsonl")),
  { ...expectedEffective, effort: "UNKNOWN" }));
test("normalize sandbox", () => {
  assert.equal(normalizeSandbox("workspace-write"), "workspace-write");
  assert.equal(normalizeSandbox({ type: "read-only" }), "read-only");
  assert.equal(normalizeSandbox({}), "UNKNOWN");
});
const started = JSON.stringify({ type: "thread.started", thread_id: threadId });
const completed = JSON.stringify({ type: "turn.completed",
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0 } });
const good = summarizeExecEvents([started, completed].join("\n"));
const requested = { model: request.model, effort: request.effort, sandbox: request.sandbox, cwd: request.cwd };
function outcome(changes = {}) {
  return evaluateExecOutcome({ requested, exitCode: 0, timedOut: false, events: good, effective, ...changes });
}
function expectIndeterminate(result, code) {
  assert.deepEqual(result, { status: "INDETERMINATE", code, retryAllowed: false });
}
test("successful outcome", () => assert.deepEqual(outcome(), { status: "SUCCEEDED" }));
for (const [field, value, code] of [["model", "other", "MODEL_MISMATCH"], ["effort", "high",
  "EFFORT_MISMATCH"], ["sandbox", "workspace-write", "SANDBOX_MISMATCH"], ["cwd", "/other", "CWD_MISMATCH"],
  ["modelProvider", "other", "MODEL_PROVIDER_MISMATCH"], ["effort", "UNKNOWN", "EFFECTIVE_SETTINGS_UNKNOWN"]]) {
  test(code, () => expectIndeterminate(outcome({ effective: { ...effective, [field]: value } }), code));
}
test("fallback model",
  () => expectIndeterminate(
    outcome({ effective: extractEffectiveSettings(fixture("rollout-sol-fallback.jsonl")) }), "MODEL_MISMATCH"));
test("windows cwd normalization", () => assert.equal(outcome({ platform: "win32", requested: { ...requested,
  cwd: "C:\\Work\\Repo\\" }, effective: { ...effective, cwd: "c:/work/repo" } }).status, "SUCCEEDED"));
test("missing events", () => expectIndeterminate(outcome({ events: undefined }), "NO_TERMINAL_EVENT"));
test("timeout", () => expectIndeterminate(outcome({ timedOut: true }), "TIMEOUT"));
test("unknown exit", () => expectIndeterminate(outcome({ exitCode: null }), "EXIT_UNKNOWN"));
test("failed", () => assert.deepEqual(outcome({ events: { ...good, terminal: "failed" } }),
  { status: "FAILED", retryAllowed: false }));
for (const [text, code] of [
  [[started, started, completed].join("\n"), "NO_TERMINAL_EVENT"],
  [`{"type":"thread.started","thread_id":"${threadId}"}`, "NO_TERMINAL_EVENT"],
  [[started, completed, completed].join("\n"), "NO_TERMINAL_EVENT"],
  [`{"type":"thread.started","thread_id":"${threadId}"}\n{"type":"turn.completed"}\n{"type":"turn.failed"}`,
    "NO_TERMINAL_EVENT"],
  ["{\"type\":\"thread.started\"}\n{\"type\":\"turn.completed\"}", "MALFORMED_OUTPUT"],
  ["bad", "MALFORMED_OUTPUT"],
]) {
  test("bad events", () => expectIndeterminate(outcome({ events: summarizeExecEvents(text) }), code));
}


for (const changes of [{ cwd: "-x" }, { cwd: "relative" }, { outputLastMessagePath: "-o" },
  { outputLastMessagePath: "relative" }]) {
  test("invalid request path", () => expectBlocked(buildCodexExecArgs({ ...request, ...changes }), "REQUEST_INVALID"));
}
test("windows absolute request", () => assert.equal(buildArgs({ ...request, cwd: "C:\\work",
  outputLastMessagePath: "C:\\out" }, "win32").status, "READY"));
test("option-like resume id", () => expectBlocked(buildCodexExecArgs({ ...request, mode: "RESUME",
  resumeThreadId: "-".repeat(36) }), "RESUME_ID_INVALID"));
for (const candidate of ["C:\\tools\\codex.cmd ", "C:\\tools\\codex.cmd.",
  "C:\\tools\\codex.js", "C:\\tools.\\codex.exe", "C:\\tools \\codex.exe"]) {
  test("invalid windows executable", () => expectBlocked(resolve({ configuredPath: candidate }),
    "EXECUTABLE_SHIM_REJECTED"));
}
for (const candidate of ["C:\\tools\\codex.cmd:s", "\\work\\codex.exe",
  "\\\\server\\share\\codex.exe", "\\\\?\\UNC\\server\\share\\codex.exe"]) {
  test("invalid windows path", () => expectBlocked(resolve({ configuredPath: candidate }), "EXECUTABLE_PATH_INVALID"));
}
test("root trailing dot", () => expectBlocked(resolve({ configuredPath: "C:\\work\\codex.exe",
  worktreeRoots: ["C:\\work.\\"] }), "EXECUTABLE_INSIDE_WORKTREE"));
test("invalid roots type", () => expectBlocked(resolve({ worktreeRoots: null }), "WORKTREE_ROOT_INVALID"));
test("missing exists", () => expectBlocked(resolve({ exists: null }), "ENVIRONMENT_UNIDENTIFIED"));
test("throwing exists", () => expectBlocked(resolve({ exists: () => { throw new Error("x"); } }),
  "ENVIRONMENT_UNIDENTIFIED"));
// 8.3 aliases are not detected: the caller must resolve real paths.
test("8.3 alias requires realpath", () => assert.equal(resolve({ configuredPath: "C:\\PROGRA~1\\codex.exe",
  worktreeRoots: ["C:\\Program Files"] }).status, "READY"));
test("ambiguous env", () => expectBlocked(buildSpawnEnv({ PATH: "a", Path: "b" }, "win32"), "ENV_AMBIGUOUS"));
test("duplicate same env", () => assert.deepEqual(buildSpawnEnv({ PATH: "a", Path: "a" }, "win32"),
  { status: "READY", env: { PATH: "a" } }));
test("usage without ceiling", () => assert.deepEqual(classifyUsage({ rateLimits: { primary: { usedPercent: 50 },
  ordinaryUsageAllowed: true } }), { status: "READY", windows: [{ name: "primary", usedPercent: 50,
    windowDurationMins: undefined }] }));
test("cumulative usage basis", () => assert.equal(good.usageBasis, "THREAD_CUMULATIVE"));
test("usage delta", () => assert.deepEqual(usageDelta(
  { input_tokens: 269010, cached_input_tokens: 245888, output_tokens: 7040 },
  { input_tokens: 510398, cached_input_tokens: 485120, output_tokens: 14881 }),
  { input_tokens: 241388, cached_input_tokens: 239232, output_tokens: 7841, nonCachedInput: 2156 }));
test("usage delta unknown", () => {
  assert.equal(usageDelta({}, {}), "UNKNOWN");
  assert.equal(usageDelta({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 0 },
    { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 }), "UNKNOWN");
  assert.equal(usageDelta({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 0 },
    { input_tokens: 11, cached_input_tokens: 5, output_tokens: 0 }), "UNKNOWN");
});

test("runner preconditions", () => {
  assert.ok(Object.isFrozen(RUNNER_PRECONDITIONS));
  assert.deepEqual(RUNNER_PRECONDITIONS, [
    "realpath_executable_outside_worktree", "reject_reparse_points_junction_symlink", "resolve_8dot3_short_names",
    "revalidate_executable_identity_at_spawn_toctou", "writer_lease_acquired_and_dispatched_recorded",
    "clean_worktree_and_head_revalidated", "spawn_without_shell_with_argv_array", "prompt_via_stdin_then_eof",
    "process_tree_exit_confirmed_before_release",
  ]);
});
for (const value of [-1, 101, NaN, Infinity, "1", null]) {
  test("invalid window usage", () => expectBlocked(classifyUsage({ rateLimits: {
    primary: { usedPercent: value }, ordinaryUsageAllowed: true } }, { ownerException: true }), "USAGE_INVALID"));
  test("invalid ceiling", () => expectBlocked(classifyUsage(usage, { ceilingPercent: value,
    ownerException: true }), "USAGE_INVALID"));
}
for (const value of [0, -1, Infinity]) {
  test("invalid duration", () => expectBlocked(classifyUsage({ rateLimits: {
    primary: { usedPercent: 1, windowDurationMins: value }, ordinaryUsageAllowed: true } }), "USAGE_INVALID"));
}
test("null duration is absent", () => assert.equal(classifyUsage({ rateLimits: {
  primary: { usedPercent: 1, windowDurationMins: null }, ordinaryUsageAllowed: true } }).status, "READY"));
for (const [nested, top, code] of [[true, false, "USAGE_EXHAUSTED"], [false, true, "USAGE_EXHAUSTED"],
  [true, "yes", "USAGE_UNKNOWN"], ["yes", true, "USAGE_UNKNOWN"]]) {
  test("conflicting usage authorization", () => expectBlocked(classifyUsage({
    rateLimits: { primary: { usedPercent: 1 }, ordinaryUsageAllowed: nested }, ordinaryUsageAllowed: top,
  }), code));
}
test("secondary ceiling", () => assert.deepEqual(classifyUsage({ rateLimits: {
  primary: { usedPercent: 10 }, secondary: { usedPercent: 90, windowDurationMins: 10080 },
  ordinaryUsageAllowed: true } }, { ceilingPercent: 80 }),
{ status: "BLOCKED", code: "USAGE_CEILING", attemptBoundary: boundary, window: "secondary" }));
test("missing usage authorization", () => expectBlocked(classifyUsage({ rateLimits: {
  primary: { usedPercent: 10 } } }, { ownerException: true }), "USAGE_UNKNOWN"));
for (const [changes, code] of [
  [{ events: { ...good, threadId: null } }, "THREAD_BINDING_UNKNOWN"],
  [{ effective: { ...effective, sessionId: undefined } }, "THREAD_BINDING_UNKNOWN"],
  [{ effective: { ...effective, sessionId: "other" } }, "THREAD_BINDING_MISMATCH"],
  [{ effective: { ...effective, turnId: undefined } }, "TURN_BINDING_UNKNOWN"],
  [{ effective: { ...effective, completedTurnId: undefined } }, "TURN_BINDING_UNKNOWN"],
  [{ effective: { ...effective, completedTurnId: "other" } }, "TURN_BINDING_MISMATCH"],
  [{ events: { ...good, usage: undefined } }, "USAGE_EVIDENCE_MISSING"],
]) test(code, () => expectIndeterminate(outcome(changes), code));
test("attributed completion", () => {
  const text = fixture("rollout-terra-low.jsonl").replace('"turn_id":"00000000-0000-0000-0000-000000000002"}}',
    '"turn_attribution":{"turn_id":"00000000-0000-0000-0000-000000000002"}}}');
  assert.equal(extractEffectiveSettings(text).completedTurnId, effective.turnId);
});
const validTokens = { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 };
for (const invalid of [{}, "x", 5, { ...validTokens, input_tokens: -1 },
  { ...validTokens, cached_input_tokens: 11 }]) {
  test("invalid usage evidence", () => expectIndeterminate(outcome({ events: { ...good, usage: invalid } }),
    "USAGE_EVIDENCE_INVALID"));
}
for (const invalid of [null, [], {}, { ...validTokens, input_tokens: -1 },
  { ...validTokens, output_tokens: 1.5 }, { ...validTokens, cached_input_tokens: 11 },
  { ...validTokens, cache_write_input_tokens: Infinity }]) {
  test("invalid usage delta inputs", () => {
    assert.equal(usageDelta(invalid, validTokens), "UNKNOWN");
    assert.equal(usageDelta(validTokens, invalid), "UNKNOWN");
  });
}
test("optional usage delta", () => assert.deepEqual(usageDelta(
  { ...validTokens, reasoning_output_tokens: 1 }, { input_tokens: 20, cached_input_tokens: 8,
    output_tokens: 4, reasoning_output_tokens: 3, cache_write_input_tokens: 2 }),
{ input_tokens: 10, cached_input_tokens: 3, output_tokens: 2, reasoning_output_tokens: 2, nonCachedInput: 7 }));
test("optional usage decreases", () => assert.equal(usageDelta(
  { ...validTokens, reasoning_output_tokens: 2 }, { ...validTokens, reasoning_output_tokens: 1 }), "UNKNOWN"));

const directory = mkdtempSync(path.join(tmpdir(), "fake-codex-"));
async function runFake(scenario, timeoutMs, record = true) {
  const recordPath = path.join(directory, `${scenario}.json`);
  const env = { ...process.env, FAKE_CODEX_SCENARIO: scenario };
  if (record) env.FAKE_CODEX_RECORD = recordPath;
  else delete env.FAKE_CODEX_RECORD;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-codex.mjs", import.meta.url)), "exec",
    "-"], { shell: false, env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.end("private prompt");
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { stdout, stderr, exitCode, timedOut, record: record
      && scenario !== "unknown" ? JSON.parse(readFileSync(recordPath, "utf8")) : null };
  } finally {
    clearTimeout(timer);
  }
}
try {
  for (const scenario of ["ok", "no_terminal", "malformed", "failed", "hang"]) {
    const result = await runFake(scenario, scenario === "hang" ? 3000 : 10000);
    test("fake stdin and argv", () => {
      assert.equal(result.record.stdinReceived, true);
      assert.ok(!result.record.argv.includes("private prompt"));
    });
    const actual = outcome({ events: summarizeExecEvents(result.stdout), exitCode: result.exitCode,
      timedOut: result.timedOut });
    test("fake outcome", () => {
      const expected = { ok: "SUCCEEDED", no_terminal: "NO_TERMINAL_EVENT", malformed: "MALFORMED_OUTPUT",
        failed: "FAILED", hang: "TIMEOUT" }[scenario];
      assert.equal(actual.code ?? actual.status, expected);
      if (actual.status !== "SUCCEEDED") {
        assert.equal(actual.retryAllowed, false);
        assert.ok(!("attemptBoundary" in actual));
      }
    });
  }
  const unknown = await runFake("unknown", 10000);
  test("unknown scenario", () => {
    assert.equal(unknown.exitCode, 2);
    assert.ok(unknown.stderr);
  });
  const noRecord = await runFake("ok", 10000, false);
  test("optional record", () => assert.equal(noRecord.exitCode, 0));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(`cross-runtime codex exec tests passed: ${count}`);
