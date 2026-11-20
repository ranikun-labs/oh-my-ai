import { parseUsageNotification } from './app-server-usage.mjs';

// Combine caller-supplied segments within one process. This does not prove the
// source, persist checkpoints, interpret producer counters, or sum snapshots.
export function inspectUsageSegments(segments, expected) {
  if (!Array.isArray(segments)) return {status:'INVALID_SEGMENTS'};
  if (segments.length > 100) return {status:'SEGMENT_LIMIT_EXCEEDED'};
  let eventCount = 0;
  let snapshot = null;
  let fingerprint = null;
  let sameValueObservations = 0;
  for (const segment of segments) {
    if (!Array.isArray(segment)) return {status:'INVALID_SEGMENTS'};
    eventCount += segment.length;
    if (eventCount > 10000) return {status:'EVENT_LIMIT_EXCEEDED'};
    for (const event of segment) {
      const parsed = parseUsageNotification(event, expected);
      if (parsed.status === 'UNRELATED') continue;
      if (parsed.status !== 'PARSED_UNVERIFIED_SOURCE') return {status:parsed.status};
      const current = JSON.stringify({last:parsed.last,total:parsed.total});
      if (fingerprint === null) {
        fingerprint = current;
        snapshot = {last:parsed.last,total:parsed.total};
        sameValueObservations = 1;
      } else if (fingerprint === current) {
        sameValueObservations++;
      } else {
        // Producer semantics for multiple different snapshots are unknown.
        return {status:'MULTIPLE_DISTINCT_SNAPSHOTS_UNRESOLVED'};
      }
    }
  }
  if (snapshot === null) return {status:'NO_USAGE'};
  return {status:'SNAPSHOT_UNVERIFIED_SOURCE', ...snapshot, sameValueObservations, uniqueness:'UNKNOWN'};
}
