#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "./cross-runtime-codex-run.mjs";
import { runCodexReadOnly, defaultKillTree } from "./lib/cross-runtime-codex-runner.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-tests-"));
const fake = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
const node = fs.realpathSync.native(process.execPath);
const thread = "00000000-0000-0000-0000-000000000001";
let count = 0;
async function test(name, fn) {
  try { await fn(); count++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
function fixture(scenario = "ok", extraEnv = {}, extra = {}) {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  const env = { ...process.env, CODEX_HOME: home, ...extraEnv };
  const calls = [];
  const shim = (exe, args, options) => {
    calls.push({ exe, args, options });
    if (exe !== node) return spawn(exe, args, options);
    return spawn(process.execPath, [fake, ...args], { ...options,
      env: { ...options.env, FAKE_CODEX_SCENARIO: scenario, ...extraEnv } });
  };
  const killTree = async ({ child }) => { try { child.kill("SIGKILL"); } catch {} return true; };
  return { request: { mode: "NEW", model: "test-model", effort: "low", cwd: root,
    promptText: "private prompt marker", timeoutMs: 5000, usageCeilingPercent: 80,
    configuredExecutablePath: node, worktreeRoots: [root] },
  deps: { spawn: shim, env, codexHome: home, tmpDir: root, killTree, ...extra }, home, calls };
}
async function run(f) { return runCodexReadOnly(f.request, f.deps); }
function wrapFs(overrides) { return { ...fs, ...overrides }; }
try {
  await test("write blocked", async () => {
    const f = fixture(); f.request.sandbox = "workspace-write";
    assert.equal((await run(f)).code, "WRITER_LEASE_REQUIRED");
  });
  await test("realpath resolves inside worktree", async () => {
    const f = fixture();
    f.deps.fs = wrapFs({ realpathSync: { native: file => file === root ? root : path.join(root, "codex.exe") },
      existsSync: () => true });
    assert.equal((await run(f)).code, "EXECUTABLE_INSIDE_WORKTREE");
  });
  await test("reparse point", async () => {
    const f = fixture();
    f.deps.fs = wrapFs({ lstatSync: () => ({ isSymbolicLink: () => false, fileAttributes: 0x400 }) });
    assert.equal((await run(f)).code, "EXECUTABLE_REPARSE_POINT");
  });
  await test("identity changed", async () => {
    const f = fixture(); let calls = 0;
    f.deps.fs = wrapFs({ statSync: file => {
      const stat = fs.statSync(file);
      if (file === fs.realpathSync.native(process.execPath) && ++calls === 4) return { ...stat, size: stat.size + 1 };
      return stat;
    } });
    assert.equal((await run(f)).code, "EXECUTABLE_CHANGED");
  });
  await test("ambiguous environment", async () => {
    const f = fixture();
    f.deps.platform = "win32"; f.deps.env = { PATH: "a", Path: "b" };
    f.deps.fs = wrapFs({ existsSync: () => true, realpathSync: { native: file => file },
      lstatSync: () => ({ isSymbolicLink: () => false }), statSync: () => ({}) });
    f.request.configuredExecutablePath = "C:\\codex.exe"; f.request.worktreeRoots = ["C:\\work"];
    assert.equal((await run(f)).code, "ENV_AMBIGUOUS");
  });
  await test("API key", async () => {
    const f = fixture("ok", { FAKE_CODEX_LOGIN_STDERR: "Logged in using API key" });
    assert.equal((await run(f)).code, "AUTH_MODE_API_KEY");
  });
  await test("usage ceiling", async () => {
    const f = fixture(); f.request.usageCeilingPercent = 10;
    assert.equal((await run(f)).code, "USAGE_CEILING");
  });
  await test("invalid requests never spawn", async () => {
    for (const [key, values] of [["usageCeilingPercent", [undefined, NaN, -1, 101]],
      ["timeoutMs", [0, 1.5, 2147483648]], ["model", [""]]]) {
      for (const value of values) {
        const f = fixture(); f.request[key] = value;
        assert.equal((await run(f)).status, "BLOCKED");
        assert.equal(f.calls.length, 0);
      }
    }
  });
  await test("invalid worktree root", async () => {
    const f = fixture(); f.request.worktreeRoots = [path.join(root, "missing")];
    assert.equal((await run(f)).code, "WORKTREE_ROOT_INVALID");
  });
  await test("canonical worktree root protects executable", async () => {
    const f = fixture();
    f.deps.fs = wrapFs({ realpathSync: { native: file => file === root ? path.dirname(node) : node } });
    assert.equal((await run(f)).code, "EXECUTABLE_INSIDE_WORKTREE");
    assert.equal(f.calls.length, 0);
  });
  await test("argv stdin and spawn isolation", async () => {
    const record = path.join(root, "record.json");
    const f = fixture("ok", { FAKE_CODEX_RECORD: record });
    for (const mode of ["NEW", "RESUME"]) {
      f.request.mode = mode; f.request.resumeThreadId = thread;
      assert.equal((await run(f)).status, "SUCCEEDED");
      const saved = JSON.parse(fs.readFileSync(record, "utf8"));
      const flag = mode === "NEW" ? "-s" : "-c";
      const value = mode === "NEW" ? "read-only" : "sandbox_mode=read-only";
      assert.ok(saved.argv.some((arg, i) => arg === flag && saved.argv[i + 1] === value));
      assert.equal(saved.argv.at(-1), "-");
      assert.ok(!saved.argv.includes(f.request.promptText));
      assert.equal(saved.stdinReceived, true);
      assert.ok(!saved.envNames.includes("SECRET_MARKER"));
      const call = f.calls.filter(item => item.args[0] === "exec").at(-1);
      assert.equal(call.options.shell, false);
      if (process.platform !== "win32") assert.equal(call.options.detached, true);
      for (const preflight of f.calls.filter(item => item.args[0] !== "exec")) {
        assert.equal(preflight.options.cwd, os.tmpdir());
      }
    }
  });
  await test("rpc errors and malformed lines", async () => {
    for (const mode of ["error", "init-error"]) {
      assert.equal((await run(fixture("ok", { FAKE_CODEX_RPC: mode }))).code, "USAGE_UNKNOWN");
    }
    assert.equal((await run(fixture("ok", { FAKE_CODEX_RPC: "noise" }))).status, "SUCCEEDED");
  });
  await test("rpc timeout", async () => {
    assert.equal((await run(fixture("ok", { FAKE_CODEX_RPC: "timeout" }))).code, "USAGE_UNKNOWN");
  });
  await test("new chooses event thread rollout", async () => {
    const f = fixture();
    const dir = path.join(f.home, "sessions", "2026", "01", "01");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rollout-x-00000000-0000-0000-0000-000000000002.jsonl"), "invalid");
    assert.equal((await run(f)).status, "SUCCEEDED");
  });
  await test("new requires one turn", async () => {
    assert.equal((await run(fixture("new-two-turns"))).code, "TURN_COUNT_UNEXPECTED");
  });
  await test("observed sandbox mismatch blocks success", async () => {
    const f = fixture();
    const original = f.deps.spawn;
    f.deps.spawn = (exe, args, options) => {
      const changed = [...args];
      if (changed.includes("-s")) changed[changed.indexOf("-s") + 1] = "workspace-write";
      return original(exe, changed, options);
    };
    assert.equal((await run(f)).code, "SANDBOX_MISMATCH");
  });
  await test("missing rollout", async () => {
    const f = fixture(); f.request.mode = "RESUME"; f.request.resumeThreadId = thread;
    assert.equal((await run(f)).code, "ROLLOUT_NOT_FOUND");
  });
  await test("happy and redaction", async () => {
    const f = fixture(); f.deps.env.SECRET_MARKER = "private environment marker";
    const result = await run(f);
    assert.equal(result.status, "SUCCEEDED", JSON.stringify(result));
    assert.equal(result.finalMessage, "fake final message");
    assert.equal(result.processTreeExitConfirmed, true);
    assert.doesNotMatch(JSON.stringify(result), /private prompt marker|private environment marker/);
  });
  await test("stale resume", async () => {
    const f = fixture("stale"); assert.equal((await run(f)).status, "SUCCEEDED");
    f.request.mode = "RESUME"; f.request.resumeThreadId = thread;
    assert.equal((await run(f)).code, "STALE_TURN");
  });
  await test("model mismatch", async () => {
    const result = await run(fixture("mismatch"));
    assert.equal(result.code, "MODEL_MISMATCH");
  });
  await test("timeout", async () => {
    const f = fixture("hang"); f.request.timeoutMs = 300;
    const result = await run(f);
    assert.equal(result.code, "TIMEOUT"); assert.equal(result.processTreeExitConfirmed, true);
  });
  await test("output overflow", async () => {
    const f = fixture("overflow"); f.request.timeoutMs = 30000;
    assert.equal((await run(f)).code, "OUTPUT_LIMIT");
  });
  await test("unconfirmed tree", async () => {
    const f = fixture(); let calls = 0;
    f.deps.killTree = async ({ child }) => { calls++; if (calls < 3) { child.kill(); return true; } return false; };
    assert.equal((await run(f)).code, "PROCESS_TREE_EXIT_UNCONFIRMED");
  });
  await test("CLI missing args", () => {
    assert.equal(spawnSync(process.execPath, ["scripts/cross-runtime-codex-run.mjs"]).status, 2);
  });
  await test("CLI blocked", () => {
    const request = path.join(root, "request.json"), prompt = path.join(root, "prompt.txt");
    fs.writeFileSync(request, JSON.stringify({ sandbox: "workspace-write" })); fs.writeFileSync(prompt, "secret");
    assert.equal(spawnSync(process.execPath, ["scripts/cross-runtime-codex-run.mjs", "--request", request,
      "--prompt", prompt]).status, 3);
  });
  await test("resume with new turn", async () => {
    const f = fixture(); assert.equal((await run(f)).status, "SUCCEEDED");
    f.request.mode = "RESUME"; f.request.resumeThreadId = thread;
    assert.equal((await run(f)).status, "SUCCEEDED");
  });
  await test("resume with two turns", async () => {
    const f = fixture("two-turns"); assert.equal((await run(f)).status, "SUCCEEDED");
    f.request.mode = "RESUME"; f.request.resumeThreadId = thread;
    assert.equal((await run(f)).code, "TURN_COUNT_UNEXPECTED");
  });
  await test("CLI status mappings", async () => {
    const args = ["--request", "r", "--prompt", "p"];
    const read = file => file === "r" ? "{}" : "prompt";
    for (const [status, code] of [["SUCCEEDED", 0], ["BLOCKED", 3], ["INDETERMINATE", 4], ["FAILED", 5]]) {
      const result = await main(args, async request => { assert.equal(request.promptText, "prompt");
        return { status }; }, read);
      assert.equal(result.exitCode, code);
    }
  });
  await test("Windows taskkill status and absolute path", async () => {
    for (const [code, expected] of [[0, true], [128, true], [1, false]]) {
      let called;
      const fakeSpawn = (exe, args, options) => {
        called = { exe, args, options };
        const process = new EventEmitter();
        queueMicrotask(() => process.emit("exit", code));
        return process;
      };
      assert.equal(await defaultKillTree({ child: { pid: 123 }, platform: "win32",
        env: { SystemRoot: "C:\\Windows" }, spawn: fakeSpawn }), expected);
      assert.equal(called.exe, "C:\\Windows\\System32\\taskkill.exe");
      assert.deepEqual(called.args, ["/PID", "123", "/T", "/F"]);
      assert.equal(called.options.shell, false);
    }
  });
  await test("default tree kill removes grandchild", async () => {
    const pidFile = path.join(root, "grandchild.pid");
    const f = fixture("spawn_grandchild_hang", { FAKE_CODEX_PID_FILE: pidFile });
    delete f.deps.killTree; f.request.timeoutMs = 1000;
    const result = await run(f);
    assert.equal(result.processTreeExitConfirmed, true, JSON.stringify(result));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
  console.log(`cross-runtime runner tests passed: ${count}`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
