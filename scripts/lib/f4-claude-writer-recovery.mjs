import { realpath } from "node:fs/promises";
import { recoverF4Writer } from "./f4-writer-continuation.mjs";
import { createPendingHandoffClaudeSessionResolutionAdapter } from "./pending-handoff-claude-runtime-adapter.mjs";

// The Host supplies the trusted association store and the same identity
// deriver used when it registered the Writer. The SDK only reads session metadata.
export function recoverF4ClaudeWriter({
  scope, task, associationStore, sessionIdentityDeriver,
  loadSdk = () => import("@anthropic-ai/claude-agent-sdk"),
}) {
  return recoverF4Writer({
    scope, task, associationStore,
    async observeWriter({ workspaceRef, successor }) {
      if (successor.runtimeId !== "claude") return { status: "unknown" };

      const dir = await realpath(workspaceRef);
      const sdk = await loadSdk();
      const adapter = createPendingHandoffClaudeSessionResolutionAdapter({
        sessionIdentityDeriver,
        currentSessionObserver: () => null,
        getSessionInfo: () => null,
        listSessions: ({ limit }) => sdk.listSessions({ dir, limit, includeWorktrees: false }),
      });
      if (!adapter.ok) return { status: "unknown" };

      const session = await adapter.value.resolveTargetSession({
        runtime_id: successor.runtimeId, session_identity: successor.sessionId,
      });
      if (session.session_identity !== successor.sessionId) return { status: "unknown" };
      return { status: "available", sessionIdentity: session.session_identity, session };
    },
  });
}
