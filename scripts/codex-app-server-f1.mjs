#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createAppServerLiveF1Observer } from "./lib/app-server-live-f1.mjs";

if (process.argv.length !== 2) {
  console.error("usage: node scripts/codex-app-server-f1.mjs");
  process.exit(2);
}

const observer = createAppServerLiveF1Observer(message => process.stderr.write(`[F1] ${message}\n`));
const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["inherit", "pipe", "inherit"] });
child.stdout.pipe(process.stdout, { end: false });
const forwardedSignals = new Map([
  ["SIGINT", () => child.kill("SIGINT")],
  ["SIGTERM", () => child.kill("SIGTERM")],
]);
for (const [signal, handler] of forwardedSignals) process.on(signal, handler);
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
let segments = [];
let size = 0;
let observationAvailable = true;
child.stdout.on("data", chunk => {
  if (!observationAvailable) return;
  let offset = 0;
  while (offset < chunk.length) {
    const end = chunk.indexOf(10, offset);
    const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
    size += part.length;
    if (size > MAX_FRAME_BYTES) {
      segments = [];
      observationAvailable = false;
      console.error("[F1] App Server 사용량 UNKNOWN (RPC 관측 크기 제한 초과)");
      return;
    }
    if (part.length) segments.push(part);
    if (end < 0) break;
    let event;
    try { event = JSON.parse(Buffer.concat(segments).toString("utf8")); } catch { /* Forwarded as-is. */ }
    if (event) observer.observe(event);
    segments = [];
    size = 0;
    offset = end + 1;
  }
});
child.on("error", () => {
  console.error("[F1] Codex App Server 시작 실패");
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  for (const [name, handler] of forwardedSignals) process.off(name, handler);
  process.exitCode = signal ? 1 : (code ?? 1);
});
