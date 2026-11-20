// Transform caller-supplied Jira observations. This module never fetches or mutates Jira.
const JIRA_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function jiraTimestamp(value) {
  if (typeof value !== 'string' || value.length > 1000) return null;
  const clock = JIRA_TIMESTAMP.exec(value)?.[1];
  if (!clock || !Number.isFinite(Date.parse(value))) return null;

  // Date.parse normalizes impossible dates. Round-trip the local calendar and clock
  // in UTC, separately from the original offset and fractional seconds.
  const utcClock = new Date(`${clock}Z`);
  return Number.isFinite(utcClock.valueOf()) && utcClock.toISOString().slice(0, 19) === clock
    ? value : null;
}

export function jiraObservations(issues, observedAt) {
  if (!Array.isArray(issues) || issues.length > 500 || typeof observedAt !== 'string' || !observedAt.trim() || observedAt.length > 1000) throw new Error('invalid observations');
  const observationTime = jiraTimestamp(observedAt);
  const observationMillis = Date.parse(observationTime);
  let futureSourceUpdates = 0;
  const items = []; const relations = []; const keys = new Set(); let omittedRelationObservations = 0; let unsupportedLinkObservations = 0;
  const push = r => { if (relations.length >= 2000) throw new Error('too many relations'); relations.push(r); };
  for (const issue of issues) {
    if (!issue || typeof issue.key !== 'string' || issue.key.length > 100 || !/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(issue.key) || keys.has(issue.key)) throw new Error('invalid issue key');
    keys.add(issue.key);
    const updated = jiraTimestamp(issue.fields?.updated);
    const sourceUpdateAfterObservation = Date.parse(updated) > observationMillis;
    if (sourceUpdateAfterObservation) futureSourceUpdates++;
    items.push({
      key: issue.key,
      title: typeof issue.fields?.summary === 'string' ? issue.fields.summary.slice(0, 500) : 'UNKNOWN',
      status: typeof issue.fields?.status?.name === 'string' ? issue.fields.status.name.slice(0, 500) : 'UNKNOWN',
      source_ref: `jira:${issue.key}`,
      source_updated_at: sourceUpdateAfterObservation ? null : updated,
      observed_at: observationTime,
    });
  }
  for (const issue of issues) {
    const rawParent = issue.fields?.parent;
    const parent = rawParent?.key;
    if (rawParent != null && (typeof rawParent !== 'object' || Array.isArray(rawParent) || typeof parent !== 'string' || parent.length > 100 || !/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(parent))) throw new Error('invalid parent');
    if (parent === issue.key) throw new Error('invalid self parent');
    if (keys.has(parent)) push({from: parent, to: issue.key, type: 'parent', source_ref: `jira:${issue.key}`, observed_at: observationTime});
    else if (parent != null) omittedRelationObservations++;
    const links = issue.fields?.issuelinks;
    if (links != null && !Array.isArray(links)) throw new Error('invalid issue links');
    for (const link of links ?? []) {
      if (!link || typeof link !== 'object' || typeof link.type?.name !== 'string' || Boolean(link.outwardIssue) === Boolean(link.inwardIssue)) throw new Error('invalid issue link');
      const name = link.type.name.toLowerCase();
      if (!['blocks','relates'].includes(name)) { unsupportedLinkObservations++; continue; }
      const other = link.outwardIssue?.key ?? link.inwardIssue?.key;
      if (typeof other !== 'string' || other.length > 100 || !/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(other)) throw new Error('invalid link endpoint');
      if (other === issue.key) throw new Error('invalid self link');
      if (!keys.has(other)) { omittedRelationObservations++; continue; }
      const id = typeof link.id === 'string' && /^\d{1,100}$/.test(link.id) ? link.id : 'UNKNOWN';
      if (name === 'blocks') push({from: link.outwardIssue ? issue.key : other, to: link.outwardIssue ? other : issue.key, type: 'blocks', source_ref: `jira:${issue.key}:link:${id}`, observed_at: observationTime});
      else push({from: issue.key, to: other, type: 'relates', source_ref: `jira:${issue.key}:link:${id}`, observed_at: observationTime});
    }
  }
  return {items, relations, coverage: 'partial', observation_time: observationTime, source_updates_after_observation: futureSourceUpdates, omitted_relation_observations: omittedRelationObservations, unsupported_link_observations: unsupportedLinkObservations};
}
