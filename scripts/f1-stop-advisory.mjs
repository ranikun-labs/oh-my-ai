#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { splitSections, validateF1Report } from "./f1-report-advisory.mjs";

const MAX_INPUT_BYTES = 256 * 1024;

export function checkF1StopEvent(event, { expectF1 = false } = {}) {
  if (event?.hook_event_name !== "Stop" || event.stop_hook_active !== false
    || typeof event.last_assistant_message !== "string") return {};

  const report = event.last_assistant_message;
  if (!expectF1) {
    const { sections } = splitSections(report);
    if (!sections.has("서비스 기능") || !sections.has("이번 변경")) return {};
  }

  const { errors } = validateF1Report(report);
  if (!errors.length) return {};
  return {
    systemMessage: `F1 보고 형식에 확인할 항목 ${errors.length}건이 있습니다. 검증 상태와 근거를 확인하세요.`,
  };
}

export async function runF1StopAdvisory({ expectF1 = false, takeExpectation = () => false } = {}) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) return console.log("{}");
      chunks.push(chunk);
    }
    const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const scopedExpectation = takeExpectation(event);
    const result = scopedExpectation === "consumed"
      ? {}
      : checkF1StopEvent(event, { expectF1: expectF1 || scopedExpectation === true });
    console.log(JSON.stringify(result));
  } catch {
    console.log("{}");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runF1StopAdvisory();
