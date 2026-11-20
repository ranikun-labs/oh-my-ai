import { inspectUsageSegments } from './app-server-usage-segments.mjs';

// Finite caller-supplied notifications only. Completion is not stream
// authentication and does not prove that the capture was complete.
export function inspectCompletedTurnUsage(events, expected) {
  if (!Array.isArray(events)) return {status:'INVALID_EVENTS'};
  if (events.length > 10000) return {status:'EVENT_LIMIT_EXCEEDED'};
  if (!expected || typeof expected.threadId !== 'string' || !expected.threadId || typeof expected.turnId !== 'string' || !expected.turnId) return {status:'INVALID_EXPECTED_IDS'};
  let completed = false;
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.method !== 'string' || !event.method) return {status:'INVALID_NOTIFICATION'};
    if (event.method !== 'turn/completed') continue;
    const p = event.params;
    if (!p || typeof p !== 'object' || p.threadId !== expected.threadId || !p.turn || typeof p.turn !== 'object' || p.turn.id !== expected.turnId) return {status:'ID_MISMATCH'};
    if (completed) return {status:'MULTIPLE_COMPLETIONS_UNRESOLVED'};
    if (!Array.isArray(p.turn.items) || p.turn.status !== 'completed') return {status:'TURN_NOT_SUCCESSFUL'};
    completed = true;
  }
  if (!completed) return {status:'TURN_NOT_COMPLETED'};
  const usage = inspectUsageSegments([events], expected);
  if (usage.status !== 'SNAPSHOT_UNVERIFIED_SOURCE') return usage;
  return {...usage, turn_completion:'CALLER_STREAM_REPORTED'};
}
