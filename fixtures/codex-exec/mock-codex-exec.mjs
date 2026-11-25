#!/usr/bin/env node
// Mock Codex exec CLI (RPL-118 PR-1). 실제 codex/모델을 호출하지 않는다.
// 시나리오는 환경변수 MOCK_CODEX_SCENARIO로 고른다. 이벤트 필드명은 UNVERIFIED 가정.
// MOCK_CODEX_RECORD=<file>이면 argv/stdin을 JSON으로 기록한다.
import fs from "node:fs";

const scenario = process.env.MOCK_CODEX_SCENARIO || "success";
const model = process.env.MOCK_CODEX_MODEL || "mock-model";
const effort = process.env.MOCK_CODEX_EFFORT || "high";
const argv = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + "\n");
const sid = argv[0] === "exec" && argv[1] === "resume" ? argv[2] : "mock-session-0001";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => { stdin += d; });
process.stdin.on("end", () => {
  if (process.env.MOCK_CODEX_RECORD) fs.writeFileSync(process.env.MOCK_CODEX_RECORD, JSON.stringify({ argv, stdin }));
  const start = () => out({ type: "thread.started", thread_id: sid, model, reasoning_effort: effort });
  const done = () => out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  switch (scenario) {
    case "success": start(); out({ type: "turn.started" }); out({ type: "item.completed", item: { type: "agent_message", text: "ok" } }); done(); break;
    case "no_config": out({ type: "thread.started", thread_id: sid }); done(); break;
    case "turn_failed": start(); out({ type: "turn.failed", error: { message: "mock failure" } }); process.exitCode = 1; break;
    case "nonzero_exit": start(); done(); process.exitCode = 3; break;
    case "no_terminal": start(); out({ type: "turn.started" }); break;
    case "malformed": start(); process.stdout.write("{not json\n"); done(); break;
    case "truncated": start(); process.stdout.write('{"type":"turn.compl'); break;
    case "cancelled": start(); out({ type: "turn.cancelled" }); process.exitCode = 130; break;
    case "error_and_complete": start(); out({ type: "error", message: "mock error" }); done(); break;
    default: process.stderr.write("unknown mock scenario\n"); process.exitCode = 64;
  }
});
