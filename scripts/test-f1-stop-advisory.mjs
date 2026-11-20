import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkF1StopEvent } from "./f1-stop-advisory.mjs";

const completeReport = readFileSync(new URL("../docs/examples/f1-report-rpl119.md", import.meta.url), "utf8");
const incompleteReport = "## 서비스 기능\nPRIVATE-MARKER\n\n## 이번 변경\n설명";
const event = {
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: incompleteReport,
};

const advisory = checkF1StopEvent(event);
assert.deepEqual(Object.keys(advisory), ["systemMessage"]);
assert.match(advisory.systemMessage, /F1 보고 형식에 확인할 항목 \d+건/);
assert.doesNotMatch(advisory.systemMessage, /PRIVATE-MARKER/);
assert.deepEqual(checkF1StopEvent({ ...event, last_assistant_message: completeReport }), {});
assert.deepEqual(checkF1StopEvent({ ...event, last_assistant_message: "확인했어요." }), {});
assert.deepEqual(checkF1StopEvent({ ...event, stop_hook_active: true }), {});
assert.deepEqual(checkF1StopEvent({ ...event, hook_event_name: "SubagentStop" }), {});
assert.deepEqual(checkF1StopEvent({ ...event, last_assistant_message: null }), {});
assert.deepEqual(checkF1StopEvent(null), {});
const plainReply = { ...event, last_assistant_message: "확인했어요." };
assert.match(checkF1StopEvent(plainReply, { expectF1: true }).systemMessage, /F1 보고 형식/);
assert.deepEqual(checkF1StopEvent({ ...plainReply, expectF1: true }), {});
assert.deepEqual(checkF1StopEvent({ ...plainReply, stop_hook_active: true }, { expectF1: true }), {});
console.log("F1 Stop advisory: 12 assertions passed");
