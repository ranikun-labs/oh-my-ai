import { normalizeVerifiedResult } from "./f4-worker-result.mjs";

// The Host authenticates the stream and associates the test process exit
// with the approved invocation. Claude's result event alone is insufficient.
export function createF4ClaudeSessionResultVerifier({ resolveTrustedClaudeResult }) {
  return async function verifyResult(observation) {
    const trusted = await resolveTrustedClaudeResult(observation);
    if (!trusted || trusted.binding?.runtimeId !== "claude") return null;
    const { sessionId, terminalEvent, testExitCode, evidenceRef, binding } = trusted;
    if (typeof sessionId !== "string" || sessionId.length === 0
      || terminalEvent?.type !== "result" || terminalEvent.session_id !== sessionId
      || terminalEvent.subtype !== "success" || terminalEvent.is_error !== false
      || !Number.isInteger(testExitCode) || testExitCode < 0) return null;

    return normalizeVerifiedResult({
      ...binding,
      outcome: testExitCode === 0 ? "passed" : "failed",
      evidenceRef,
    });
  };
}
