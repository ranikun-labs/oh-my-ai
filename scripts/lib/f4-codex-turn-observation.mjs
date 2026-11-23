// One collector per approved test invocation. Only the Host owning the
// App Server connection should feed notifications into this collector.
export function createF4CodexTurnObservation({ threadId, turnId, testItemId, binding, evidenceRef }) {
  const receipt = Object.freeze({});
  const boundResult = Object.freeze({ ...binding });
  let testEvent = null;
  let terminalEvent = null;
  let invalid = false;

  return Object.freeze({
    observe(event) {
      const { method, params } = event ?? {};
      if (invalid || params?.threadId !== threadId) return;
      if (method === "item/completed" && params.turnId === turnId && params.item?.id === testItemId) {
        if (testEvent !== null || terminalEvent !== null) {
          invalid = true;
          return;
        }
        const { id, type, status, exitCode } = params.item;
        testEvent = { method, params: { threadId, turnId, item: { id, type, status, exitCode } } };
      }
      if (method === "turn/completed" && params.turn?.id === turnId) {
        if (terminalEvent !== null || testEvent === null || params.turn.status !== "completed") {
          invalid = true;
          return;
        }
        terminalEvent = { method, params: { threadId, turn: { id: turnId, status: params.turn.status } } };
      }
    },
    getReceipt() {
      return !invalid && terminalEvent !== null ? receipt : null;
    },
    resolveTrustedTurn(candidate) {
      if (candidate !== receipt || invalid || terminalEvent === null) return null;
      return structuredClone({
        threadId, turnId, testItemId, binding: boundResult, evidenceRef, testEvent, terminalEvent,
      });
    },
  });
}

// Consume stdout from the Host's App Server connection. The Host owns the
// process lifecycle and must terminate the stream on timeout or cancellation.
export async function collectF4CodexTurnReceipt(stdout, observer) {
  const maxFrameBytes = 4 * 1024 * 1024;
  let segments = [];
  let size = 0;
  try {
    for await (const chunk of stdout) {
      if (!Buffer.isBuffer(chunk)) return null;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        size += part.length;
        if (size > maxFrameBytes) return null;
        if (part.length > 0) segments.push(part);
        if (newline < 0) break;

        const line = Buffer.concat(segments).toString("utf8").trim();
        if (line) {
          const message = JSON.parse(line);
          if (message === null || typeof message !== "object" || Array.isArray(message)
            || (Object.hasOwn(message, "jsonrpc") && message.jsonrpc !== "2.0")) return null;
          if (!Object.hasOwn(message, "id")) observer.observe(message);
        }
        segments = [];
        size = 0;
        offset = newline + 1;
      }
    }
    return size === 0 ? observer.getReceipt() : null;
  } catch {
    return null;
  }
}
