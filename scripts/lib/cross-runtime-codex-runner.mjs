import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnDefault } from "node:child_process";
import { buildCodexExecArgs, resolveCodexExecutable, buildSpawnEnv, classifyLoginStatus,
  classifyUsage } from "./cross-runtime-codex-exec.mjs";
import { summarizeExecEvents, extractEffectiveSettings, evaluateExecOutcome,
  normalizeSandbox } from "./cross-runtime-codex-observe.mjs";

const boundary = { claim_status: "NOT_ACQUIRED", dispatch_status: "NOT_RUN" };
const blocked = code => ({ status: "BLOCKED", code, attemptBoundary: { ...boundary } });
const limit = 64 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const fields = ["input_tokens", "cached_input_tokens", "output_tokens", "cache_write_input_tokens",
    "reasoning_output_tokens"];
  return Object.fromEntries(fields.filter(key => Number.isSafeInteger(usage[key])).map(key => [key, usage[key]]));
}

function rollout(fs, root, id) {
  if (!uuid.test(id || "")) return null;
  const matches = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.startsWith("rollout-") &&
        entry.name.endsWith(`-${id}.jsonl`)) matches.push(file);
    }
  }
  walk(path.join(root, "sessions"), 0);
  return matches.length === 1 ? matches[0] : null;
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(":");
}

function checkSegments(fs, file, platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const parsed = paths.parse(file);
  let current = parsed.root;
  for (const segment of file.slice(parsed.root.length).split(/[\\/]/).filter(Boolean)) {
    current = paths.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (stat.fileAttributes & 0x400)) return false;
  }
  return true;
}

export async function defaultKillTree({ child, platform, env, spawn }) {
  if (!child.pid) return false;
  if (platform === "win32") {
    // Exit 128 after root exit cannot prove orphan absence; PID reuse also limits confirmation.
    const root = Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
    if (!root) return false;
    return new Promise(resolve => {
      try {
        const killer = spawn(path.win32.join(root, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore" });
        killer.on("error", () => resolve(false));
        killer.on("exit", code => resolve(code === 0 || code === 128));
        setTimeout(() => resolve(false), 5000).unref();
      } catch { resolve(false); }
    });
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") return false; }
  // Unreaped zombies can leave the group visible and conservatively prevent confirmation.
  for (let i = 0; i < 100; i++) {
    try { process.kill(-child.pid, 0); } catch (error) { return error.code === "ESRCH"; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

function runProcess(spawn, exe, args, options, timeout, platform, env, input, rpc = false, killTree = defaultKillTree) {
  return new Promise(resolve => {
    let child, stdout = "", stderr = "", bytes = 0, timedOut = false, overflow = false;
    let rpcBuffer = "", initialized = false;
    let exited = false, closed = false, exitCode = null, settled = false, timer, cleanupStarted = false;
    const finish = confirmed => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut, overflow, exited, treeConfirmed: confirmed && exited });
    };
    const cleanup = async () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      let confirmed = false;
      try { confirmed = await killTree({ child, platform, env, spawn }); } catch {}
      if (!exited) await new Promise(resolveExit => {
        child.once("exit", resolveExit);
        setTimeout(resolveExit, 2000).unref();
      });
      if (!closed) await new Promise(resolveClose => {
        child.once("close", resolveClose);
        setTimeout(resolveClose, 2000).unref();
      });
      finish(confirmed);
    };
    try {
      child = spawn(exe, args, { ...options, shell: false, stdio: "pipe", detached: platform !== "win32" });
      child.on("error", () => { void cleanup(); });
      child.on("exit", code => { clearTimeout(timer); exited = true; exitCode = code; void cleanup(); });
      child.on("close", () => { closed = true; });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > limit) { if (!overflow) { overflow = true; void cleanup(); } return; }
        stdout += chunk.toString();
        if (rpc) {
          rpcBuffer += chunk;
          let end;
          while ((end = rpcBuffer.indexOf("\n")) !== -1) {
            const line = rpcBuffer.slice(0, end);
            rpcBuffer = rpcBuffer.slice(end + 1);
            try {
              const msg = JSON.parse(line);
              if (msg.id === 1 && !initialized) {
                initialized = true;
                if (msg.error || !msg.result) { void cleanup(); continue; }
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" }) + "\n");
              }
              if (msg.id === 2) void cleanup();
            } catch {}
          }
        }
      });
      child.stderr.on("data", chunk => { if (stderr.length < 65536) stderr += chunk.toString().slice(0, 65536); });
      child.stdin.on("error", () => {});
      if (rpc) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { clientInfo: { name: "oh-my-ai-runner", version: "0" } } }) + "\n");
      else child.stdin.end(input || "");
      timer = setTimeout(() => { timedOut = true; void cleanup(); }, timeout);
    } catch { finish(false); }
  });
}

export async function runCodexReadOnly(request, deps = {}) {
  const fs = deps.fs || fsDefault, spawn = deps.spawn || spawnDefault, env = deps.env || process.env;
  const platform = deps.platform || process.platform, now = deps.now || Date.now;
  const start = now();
  let dispatched = false, dir;
  const requested = { model: request?.model, effort: request?.effort, sandbox: "read-only",
    cwd: request?.cwd, mode: request?.mode, modelProvider: "openai" };
  try {
    if (request?.sandbox !== undefined && request.sandbox !== "read-only") return blocked("WRITER_LEASE_REQUIRED");
    if (!Array.isArray(request.worktreeRoots)) return blocked("WORKTREE_ROOT_INVALID");
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2147483647 ||
        !Number.isFinite(request.usageCeilingPercent) || request.usageCeilingPercent < 0 ||
        request.usageCeilingPercent > 100 || typeof request.promptText !== "string") return blocked("REQUEST_INVALID");
    const paths = platform === "win32" ? path.win32 : path.posix;
    const validation = buildCodexExecArgs({ ...request, sandbox: "read-only",
      outputLastMessagePath: paths.join(paths.parse(request.cwd || "").root || paths.sep, "message.txt") }, platform);
    if (validation.status !== "READY") return validation;
    if (request.worktreeRoots.some(root => typeof root !== "string" || !paths.isAbsolute(root))) {
      return blocked("WORKTREE_ROOT_INVALID");
    }
    let roots;
    try { roots = request.worktreeRoots.map(root => fs.realpathSync.native(root)); }
    catch { return blocked("WORKTREE_ROOT_INVALID"); }
    const resolve = configuredPath => resolveCodexExecutable({ platform, configuredPath,
      worktreeRoots: [...request.worktreeRoots, ...roots], exists: file => fs.existsSync(file) });
    const candidate = resolve(request.configuredExecutablePath);
    if (candidate.status !== "READY") return candidate;
    if (!checkSegments(fs, candidate.path, platform)) return blocked("EXECUTABLE_REPARSE_POINT");
    const executable = fs.realpathSync.native(candidate.path);
    const real = resolve(executable);
    if (real.status !== "READY") return real;
    if (!checkSegments(fs, executable, platform)) return blocked("EXECUTABLE_REPARSE_POINT");
    const initial = identity(fs.statSync(executable));
    const clean = buildSpawnEnv(env, platform);
    if (clean.status !== "READY") return clean;
    const options = { env: clean.env, cwd: os.tmpdir() };
    if (identity(fs.statSync(executable)) !== initial) return blocked("EXECUTABLE_CHANGED");
    const login = await runProcess(spawn, executable, ["login", "status"], options, 10000, platform,
      clean.env, null, false, deps.killTree);
    if (!login.treeConfirmed) return blocked("PROCESS_TREE_EXIT_UNCONFIRMED");
    const auth = classifyLoginStatus(login);
    if (auth.status !== "READY") return auth;
    if (identity(fs.statSync(executable)) !== initial) return blocked("EXECUTABLE_CHANGED");
    const usageProcess = await runProcess(spawn, executable, ["app-server"], options, 15000, platform, clean.env,
      null, true, deps.killTree);
    if (!usageProcess.treeConfirmed) return blocked("PROCESS_TREE_EXIT_UNCONFIRMED");
    if (usageProcess.timedOut) return blocked("USAGE_UNKNOWN");
    let usageResult;
    for (const line of usageProcess.stdout.split(/\r?\n/)) {
      try { const item = JSON.parse(line); if (item.id === 2) usageResult = item.result; } catch {}
    }
    const usageGate = classifyUsage(usageResult, { ceilingPercent: request.usageCeilingPercent,
      ownerException: request.ownerUsageException === true });
    if (usageGate.status !== "READY") return usageGate;
    const home = deps.codexHome || clean.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const readRollout = file => {
      if (fs.statSync(file).size > limit) throw new Error("rollout too large");
      const data = fs.readFileSync(file);
      if (data.length > limit) throw new Error("rollout too large");
      return data.toString("utf8");
    };
    let baseline;
    if (request.mode === "RESUME") {
      const file = rollout(fs, home, request.resumeThreadId);
      if (!file) return blocked("ROLLOUT_NOT_FOUND");
      try { baseline = extractEffectiveSettings(readRollout(file)).turnIds; }
      catch { return { status: "INDETERMINATE", code: "ROLLOUT_UNREADABLE", retryAllowed: false }; }
    }
    dir = fs.mkdtempSync(path.join(deps.tmpDir || os.tmpdir(), "codex-runner-"));
    const outputLastMessagePath = path.join(dir, "message.txt");
    if (fs.existsSync(outputLastMessagePath)) return blocked("OUTPUT_PATH_EXISTS");
    const args = buildCodexExecArgs({ ...request, sandbox: "read-only", outputLastMessagePath }, platform);
    if (args.status !== "READY") return args;
    if (identity(fs.statSync(executable)) !== initial) return blocked("EXECUTABLE_CHANGED");
    // A TOCTOU window remains between this final identity check and the OS spawn.
    dispatched = true;
    const execution = await runProcess(spawn, executable, args.argv, { ...options, cwd: args.spawnCwd },
      request.timeoutMs, platform, clean.env, request.promptText, false, deps.killTree);
    const events = summarizeExecEvents(execution.stdout);
    const threadId = request.mode === "RESUME" ? request.resumeThreadId : events.threadId;
    const file = rollout(fs, home, threadId);
    let effective = {};
    if (file) {
      try { effective = extractEffectiveSettings(readRollout(file)); }
      catch { return { status: "INDETERMINATE", code: "ROLLOUT_UNREADABLE", retryAllowed: false,
        processTreeExitConfirmed: execution.treeConfirmed }; }
    }
    let outcome = execution.overflow ? { status: "INDETERMINATE", code: "OUTPUT_LIMIT", retryAllowed: false } :
      evaluateExecOutcome({ requested, exitCode: execution.exitCode, timedOut: execution.timedOut, events,
        effective, baseline: baseline ? { turnIds: baseline } : undefined, platform });
    if (outcome.status === "SUCCEEDED" && request.mode === "NEW" && effective.turnContextCount !== 1) {
      outcome = { status: "INDETERMINATE", code: "TURN_COUNT_UNEXPECTED", retryAllowed: false };
    }
    if (!execution.treeConfirmed) {
      outcome = { status: "INDETERMINATE", code: "PROCESS_TREE_EXIT_UNCONFIRMED", retryAllowed: false };
    }
    let finalMessage = null;
    if (outcome.status === "SUCCEEDED") {
      try {
        const stat = fs.lstatSync(outputLastMessagePath);
        if (stat.size > 1024 * 1024 || !stat.isFile() || stat.isSymbolicLink()) throw new Error();
        const message = fs.readFileSync(outputLastMessagePath);
        if (message.length > 1024 * 1024) throw new Error();
        finalMessage = message.toString("utf8");
      } catch { outcome = { status: "INDETERMINATE", code: "FINAL_MESSAGE_UNAVAILABLE", retryAllowed: false }; }
    }
    return { ...outcome, threadId, turnId: effective.turnId, requested,
      effective: { model: effective.model, effort: effective.effort, sandbox: normalizeSandbox(effective.sandbox),
        cwd: effective.cwd, modelProvider: effective.modelProvider }, usage: safeUsage(events.usage),
      usageBasis: events.usageBasis, finalMessage, durationMs: now() - start,
      processTreeExitConfirmed: execution.treeConfirmed, retryAllowed: outcome.status === "SUCCEEDED" };
  } catch {
    return dispatched ? { status: "INDETERMINATE", code: "RUNNER_ERROR", retryAllowed: false,
      processTreeExitConfirmed: false, durationMs: now() - start } : blocked("RUNNER_ERROR");
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}
