// Candidate for Codex app-server 0.159.2 thread/tokenUsage/updated.
// A parsed event is not evidence of origin; connect it to an authenticated,
// trusted stream before calling the values officially observed.
const required = ['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
function counts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of required) if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
  if (Object.hasOwn(value,'cacheWriteInputTokens') && (!Number.isSafeInteger(value.cacheWriteInputTokens) || value.cacheWriteInputTokens < 0)) return null;
  return Object.fromEntries([...required,'cacheWriteInputTokens'].map(key => [key, value[key] ?? 'UNKNOWN']));
}
export function parseUsageNotification(event, {threadId, turnId} = {}) {
  if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId) return {status:'INVALID_EXPECTED_IDS'};
  if (event?.method !== 'thread/tokenUsage/updated') return {status:'UNRELATED'};
  const p = event.params;
  if (!p || p.threadId !== threadId || p.turnId !== turnId) return {status:'ID_MISMATCH'};
  const last = counts(p.tokenUsage?.last), total = counts(p.tokenUsage?.total);
  if (!last || !total) return {status:'INVALID_USAGE'};
  // Identifiers are used only for exact matching and are never echoed.
  return {status:'PARSED_UNVERIFIED_SOURCE', last, total};
}
