import { normalizeVerifiedResult } from "./f4-worker-result.mjs";

// The Host must obtain the event from its authenticated App Server and bind
// the expected IDs and evidence to the approved Attempt and test invocation.
export function createF4CodexTurnResultVerifier({ resolveTrustedTurn }) {
  return async function verifyResult(observation) {
    const trusted = await resolveTrustedTurn(observation);
    if (!trusted || trusted.binding?.runtimeId !== "codex") return null;
    const { threadId, turnId, testItemId, testEvent, terminalEvent, evidenceRef, binding } = trusted;
    if (![threadId, turnId, testItemId].every(id => typeof id === "string" && id.length > 0)) {
      return null;
    }

    const { method, params } = terminalEvent ?? {};
    const turn = params?.turn;
    if (method !== "turn/completed" || params.threadId !== threadId
      || turn?.id !== turnId || turn.status !== "completed") {
      return null;
    }
    const test = testEvent?.params?.item;
    if (testEvent?.method !== "item/completed" || testEvent.params.threadId !== threadId
      || testEvent.params.turnId !== turnId || test?.id !== testItemId) return null;
    if (test.type !== "commandExecution" || !Number.isInteger(test.exitCode)) return null;
    if ((test.status === "completed" && test.exitCode !== 0)
      || (test.status === "failed" && test.exitCode === 0)
      || !["completed", "failed"].includes(test.status)) return null;

    return normalizeVerifiedResult({
      ...binding,
      outcome: test.exitCode === 0 ? "passed" : "failed",
      evidenceRef,
    });
  };
}
