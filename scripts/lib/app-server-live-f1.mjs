import { inspectCompletedTurnUsage } from "./app-server-turn-usage.mjs";
import { parseUsageNotification } from "./app-server-usage.mjs";
import { appServerTurnUsageF1Cell } from "./usage-f1.mjs";

const MAX_TURNS = 128;

export function createAppServerLiveF1Observer(onReport) {
  const turns = new Map();

  function report(row) {
    if (row.reported) return;
    row.reported = true;
    onReport(appServerTurnUsageF1Cell(inspectCompletedTurnUsage(
      row.usage ? [row.usage, row.completion] : [row.completion],
      row.identity,
    )).replace("(호출자 제공 캡처)", "(로컬 App Server 스냅샷, 턴 전체 사용량 UNKNOWN)"));
  }

  return {
    observe(event) {
      const params = event?.params;
      const usage = event?.method === "thread/tokenUsage/updated";
      const completion = event?.method === "turn/completed";
      if (!usage && !completion) return;
      const threadId = params?.threadId;
      const turnId = usage ? params?.turnId : params?.turn?.id;
      if (typeof threadId !== "string" || !threadId || threadId.length > 256
        || typeof turnId !== "string" || !turnId || turnId.length > 256) return;
      const key = JSON.stringify([threadId, turnId]);
      let row = turns.get(key);
      if (!row) {
        if (turns.size === MAX_TURNS) {
          const oldest = turns.keys().next().value;
          turns.delete(oldest);
        }
        row = { identity: { threadId, turnId }, usage: null, completion: null, reported: false };
        turns.set(key, row);
      }
      if (row.reported) return;
      if (usage) {
        const parsed = parseUsageNotification(event, row.identity);
        if (parsed.status !== "PARSED_UNVERIFIED_SOURCE") {
          row.usage = null;
        } else {
          const tokenUsage = { last: parsed.last, total: parsed.total };
          for (const counts of Object.values(tokenUsage)) {
            if (counts.cacheWriteInputTokens === "UNKNOWN") delete counts.cacheWriteInputTokens;
          }
          row.usage = { method: event.method, params: { threadId, turnId, tokenUsage } };
        }
      }
      if (completion) row.completion = {
        method: event.method,
        params: { threadId, turn: { id: turnId, status: params.turn.status === "completed" ? "completed" : null, items: Array.isArray(params.turn.items) ? [] : null } },
      };
      // Later updates can be replayed history. Use only observations preceding completion.
      if (completion) report(row);
    },
  };
}
