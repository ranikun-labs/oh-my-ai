import assert from "node:assert/strict";
import { createAppServerLiveF1Observer } from "./lib/app-server-live-f1.mjs";

const reports = [];
const observer = createAppServerLiveF1Observer(report => reports.push(report));
const usage = (threadId, turnId, inputTokens = 100) => ({
  method: "thread/tokenUsage/updated",
  params: { threadId, turnId, tokenUsage: {
    last: { inputTokens, cachedInputTokens: 12, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: inputTokens + 5 },
    total: { inputTokens: 1234, cachedInputTokens: 0, outputTokens: 22, reasoningOutputTokens: 0, totalTokens: 1256 },
  } },
});
const completed = (threadId, id) => ({
  method: "turn/completed",
  params: { threadId, turn: { id, status: "completed", items: [] } },
});

observer.observe(usage("thread-private", "turn-a"));
observer.observe(completed("thread-other", "turn-a"));
assert.match(reports[0], /관측값 UNKNOWN/u);
observer.observe(completed("thread-private", "turn-a"));
observer.observe(completed("thread-private", "turn-a"));
assert.equal(reports.length, 2);
assert.match(reports[1], /입력 100.*캐시 읽기 12.*출력 5/u);
assert.doesNotMatch(reports[1], /1234|thread-private|turn-a/u);
observer.observe(completed("thread-private", "turn-b"));
observer.observe(usage("thread-private", "turn-b", 109));
assert.equal(reports.length, 3);
assert.match(reports[2], /관측값 UNKNOWN/u);
observer.observe(usage("thread-private", "turn-c"));
observer.observe(usage("thread-private", "turn-c", 101));
observer.observe(completed("thread-private", "turn-c"));
assert.equal(reports.length, 4);
assert.match(reports[3], /입력 101.*턴 전체 사용량 UNKNOWN/u);
observer.observe(usage("thread-private", "turn-d"));
observer.observe({ ...usage("thread-private", "turn-d"), params: { threadId: "thread-private", turnId: "turn-d" } });
observer.observe(completed("thread-private", "turn-d"));
assert.match(reports[4], /관측값 UNKNOWN/u);
console.log("App Server live F1 observer PASS");
