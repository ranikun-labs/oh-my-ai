import { collectF4CodexTurnReceipt } from "./f4-codex-turn-observation.mjs";

const unavailable = () => ({ ok: false, reason: "codex_result_unavailable" });

// Attach immediately after the Host starts its authorized App Server.
// The observer carries the Host-resolved identity of the approved test.
export async function forwardF4CodexProcessResult({ child, observer, receiveWorkerResult, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return unavailable();
  }

  let closed;
  let failed;
  let timer;
  let processClosed = false;
  try {
    const exit = new Promise(resolve => {
      closed = (code, signal) => {
        processClosed = true;
        resolve(code === 0 && signal === null);
      };
      failed = () => resolve(false);
      child.once("close", closed);
      child.once("error", failed);
    });
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const observation = collectF4CodexTurnReceipt(child.stdout, observer);
    const receipt = await Promise.race([
      exit.then(cleanExit => cleanExit ? observation : null),
      deadline,
    ]);
    if (receipt === null) return unavailable();
    clearTimeout(timer);
    // A timeout here is ambiguous: the Result may already be durable.
    // Retry reconciliation for this receipt, not the Worker dispatch.
    return await Promise.race([
      receiveWorkerResult(receipt),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({
          ok: false, reason: "codex_result_reconciliation_unknown",
        }), timeoutMs);
      }),
    ]);
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
    if (!processClosed) {
      child.stdout?.destroy();
      child.kill("SIGKILL");
    }
    child.removeListener("close", closed);
    child.removeListener("error", failed);
  }
}
