const SOURCE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function sourceTimestampOrNull(value) {
  if (typeof value !== "string" || value.length > 1000) return null;
  const clock = SOURCE_TIMESTAMP.exec(value)?.[1];
  if (!clock || !Number.isFinite(Date.parse(value))) return null;

  // Date.parse normalizes impossible dates. Check the calendar and clock
  // independently of the original offset and fractional seconds.
  const utcClock = new Date(`${clock}Z`);
  return Number.isFinite(utcClock.valueOf()) && utcClock.toISOString().slice(0, 19) === clock
    ? value : null;
}
