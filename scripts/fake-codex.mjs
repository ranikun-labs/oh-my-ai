#!/usr/bin/env node
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "login") {
  console.error(process.env.FAKE_CODEX_LOGIN_STDERR || "Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] === "app-server") {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    const msg = JSON.parse(line);
    if (process.env.FAKE_CODEX_RPC === "timeout") continue;
    if (process.env.FAKE_CODEX_RPC === "noise") process.stdout.write("bad json\n{partial\n");
    if (process.env.FAKE_CODEX_RPC === "init-error" && msg.id === 1) {
      console.log(JSON.stringify({ id: 1, error: { code: -1 } }));
      continue;
    }
    if (process.env.FAKE_CODEX_RPC === "error" && msg.id === 2) {
      console.log(JSON.stringify({ id: 2, error: { code: -1 } }));
      continue;
    }
    if (msg.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (msg.id === 2) {
      const result = JSON.parse(process.env.FAKE_CODEX_RATE_LIMITS ||
        '{"rateLimits":{"ordinaryUsageAllowed":true,"primary":{"usedPercent":10}}}');
      console.log(JSON.stringify({ id: 2, result }));
    }
  }
  process.exit(0);
}
const scenarios = new Set(["ok", "no_terminal", "malformed", "failed", "hang", "mismatch",
  "stale", "two-turns", "new-two-turns", "overflow", "spawn_grandchild_hang"]);
const scenario = process.env.FAKE_CODEX_SCENARIO || "ok";
if (!scenarios.has(scenario)) {
  console.error("Unknown fake Codex scenario");
  process.exit(2);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_CODEX_RECORD) {
  writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ argv: args, envNames: Object.keys(process.env),
    stdinReceived: input.length > 0 }));
}
if (scenario === "spawn_grandchild_hang") {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  if (process.env.FAKE_CODEX_PID_FILE) writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(child.pid));
}
if (scenario === "hang" || scenario === "spawn_grandchild_hang") {
  await new Promise(resolve => setTimeout(resolve, 60000));
}
if (scenario === "overflow") {
  const chunk = "x".repeat(1024 * 1024);
  for (let i = 0; i < 65; i++) await new Promise(resolve => process.stdout.write(chunk, resolve));
}
const thread = args[1] === "resume" ? args[2] : "00000000-0000-0000-0000-000000000001";
const value = flag => args[args.indexOf(flag) + 1];
if (process.env.CODEX_HOME && args.includes("-o")) {
  const dir = path.join(process.env.CODEX_HOME, "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-x-${thread}.jsonl`);
  const resume = args[1] === "resume";
  const model = scenario === "mismatch" ? "different-model" : value("-m");
  const effort = args.find(arg => arg.startsWith("model_reasoning_effort="))?.split("=")[1];
  const sandbox = args.includes("-s") ? value("-s") :
    args.find(arg => arg.startsWith("sandbox_mode="))?.slice("sandbox_mode=".length);
  const context = id => JSON.stringify({ type: "turn_context", payload: { turn_id: id, model, effort,
    sandbox, cwd: args.includes("-C") ? value("-C") : process.cwd() } }) + "\n" +
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: id } }) + "\n";
  if (!resume || !existsSync(file)) {
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: thread, model_provider: "openai" } }) +
      "\n" + context("turn-1") + (scenario === "new-two-turns" ? context("turn-2") : ""));
  } else if (scenario !== "stale") {
    appendFileSync(file, context("turn-2") + (scenario === "two-turns" ? context("turn-3") : ""));
  }
  writeFileSync(value("-o"), "fake final message");
}
function emit(event) { console.log(JSON.stringify(event)); }
emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { type: "agent_message", text: "done" } });
if (scenario === "malformed") console.log("not-json");
if (scenario === "failed") {
  emit({ type: "turn.failed", error: { message: "x" } });
  process.exitCode = 1;
} else if (scenario !== "no_terminal" && scenario !== "malformed") {
  emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
}
