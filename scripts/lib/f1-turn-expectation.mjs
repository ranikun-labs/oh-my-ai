import { createHash } from "node:crypto";
import { updateWindowsF1TurnMarker } from "./f1-windows-turn-marker.mjs";
import {
  publishUserLocalStateAtomically, readUserLocalState, resolveUserLocalStateLocation,
  withPhysicalStateLock,
} from "./user-local-state.mjs";

const STATE_FILE = "diagnostics/f1-expected-turns.json";
const MAX_TURNS = 128;
const ID = /^[a-zA-Z0-9_-]{1,128}$/u;

// Correlate only native events carrying both identifiers. No prompt content is stored.
export function updateF1TurnExpectation(root, runtime, event, phase) {
  if (!["codex", "claude"].includes(runtime)
    || typeof event?.session_id !== "string" || !ID.test(event.session_id)
    || typeof event.turn_id !== "string" || !ID.test(event.turn_id)
    || typeof event.cwd !== "string" || !event.cwd
    || (phase === "submit"
      ? event.hook_event_name !== "UserPromptSubmit" || typeof event.prompt !== "string"
        || !/^(?:[ \t]*\r?\n)* {0,3}\$dev-main-flow(?=$|[ \t\r\n])/u.test(event.prompt)
      : phase !== "stop" || event.hook_event_name !== "Stop"
        || event.stop_hook_active !== false || typeof event.last_assistant_message !== "string")) return false;

  const hash = createHash("sha256").update(JSON.stringify([runtime, event.session_id, event.turn_id])).digest("hex");
  try {
    const location = resolveUserLocalStateLocation(root(), STATE_FILE, { protectedRepositoryCwds: [event.cwd] });
    if (process.platform === "win32") return updateWindowsF1TurnMarker(location, hash, phase);
    return withPhysicalStateLock(location, () => {
      const text = readUserLocalState(location);
      const rows = text === null ? {} : JSON.parse(text);
      if (!rows || typeof rows !== "object" || Array.isArray(rows)
        || Object.entries(rows).some(([key, value]) => !/^[a-f0-9]{64}$/u.test(key)
          || !["pending", "consumed"].includes(value))) return false;
      if (phase === "stop" && rows[hash] === "consumed") return "consumed";
      if (phase === "submit" ? Object.hasOwn(rows, hash) : rows[hash] !== "pending") return false;

      delete rows[hash];
      rows[hash] = phase === "submit" ? "pending" : "consumed";
      const retained = Object.fromEntries(Object.entries(rows).slice(-MAX_TURNS));
      publishUserLocalStateAtomically(location, JSON.stringify(retained));
      return phase === "stop";
    });
  } catch {
    return false;
  }
}
