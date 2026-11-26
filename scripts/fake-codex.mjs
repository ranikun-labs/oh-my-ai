#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const scenarios = new Set(["ok", "no_terminal", "malformed", "failed", "hang"]);
const scenario = process.env.FAKE_CODEX_SCENARIO;
if (!scenarios.has(scenario)) {
  console.error("Unknown fake Codex scenario");
  process.exit(2);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_CODEX_RECORD) {
  writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ argv: process.argv.slice(2),
    stdinReceived: input.length > 0 }));
}
if (scenario === "hang") await new Promise(resolve => setTimeout(resolve, 60000));

function emit(event) {
  console.log(JSON.stringify(event));
}

emit({ type: "thread.started", thread_id: "00000000-0000-0000-0000-000000000001" });
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { type: "agent_message", text: "done" } });
if (scenario === "malformed") console.log("not-json");
if (scenario === "failed") {
  emit({ type: "turn.failed", error: { message: "x" } });
  process.exitCode = 1;
} else if (scenario !== "no_terminal" && scenario !== "malformed") {
  emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
}
