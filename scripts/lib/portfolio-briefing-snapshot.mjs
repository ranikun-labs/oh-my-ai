const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const EXECUTION_STATES = new Set(["READY", "RUNNING", "BLOCKED", "REVIEW", "DONE"]);
const DEFAULT_MAX_AGE_SECONDS = 60 * 60;
const DEFAULT_REQUIRED_SOURCES = Object.freeze(["jira", "github", "confluence"]);

const QUALITY_RANK = Object.freeze({
  CURRENT: 0,
  STALE: 1,
  UNKNOWN: 2,
  DRIFT: 3,
});

/**
 * Build a read-only F6 briefing view from source snapshots.
 * Jira status and execution observations are deliberately kept separate.
 * This function normalizes evidence; it does not authenticate or fetch it.
 */
export function buildPortfolioBriefingSnapshot(input) {
  const errors = [];
  const capturedAtMs = parseTimestamp(input?.captured_at);
  if (capturedAtMs === null) errors.push("captured_at_invalid");

  const snapshots = Array.isArray(input?.source_snapshots) ? input.source_snapshots : [];
  if (!Array.isArray(input?.source_snapshots)) errors.push("source_snapshots_invalid");
  const requiredSources = normalizeRequiredSources(input?.required_sources, errors);
  const maxAgeSeconds = Number.isInteger(input?.max_age_seconds) && input.max_age_seconds >= 0
    ? input.max_age_seconds
    : DEFAULT_MAX_AGE_SECONDS;

  if (errors.length > 0) {
    return {
      status: "INVALID",
      verification_status: "UNKNOWN",
      errors,
      captured_at: null,
      sources: [],
      issues: [],
      pull_requests: [],
      counts: emptyCounts(),
    };
  }

  const sources = includeMissingSources(
    normalizeSources(snapshots, capturedAtMs, maxAgeSeconds),
    requiredSources,
  );
  const issueMap = collectIssues(snapshots, sources);
  const pullRequests = collectPullRequests(snapshots, sources, issueMap);
  const execution = collectExecutionObservations(input?.execution_observations, capturedAtMs, maxAgeSeconds);

  const issues = [...issueMap.values()].map(issue => {
    const executionObservation = execution.get(issue.key) || unknownExecutionObservation();
    const sourceQuality = issue.source_states.reduce(
      (quality, current) => worseQuality(quality, current),
      "CURRENT",
    );
    const quality = worseQuality(
      worseQuality(sourceQuality, issue.status_quality),
      executionObservationQuality(executionObservation),
    );
    return {
      key: issue.key,
      summary: issue.summary,
      summary_observations: issue.summary_observations,
      parent_key: issue.parent_key,
      parent_key_observations: issue.parent_key_observations,
      jira_status: issue.jira_status,
      jira_status_observations: issue.jira_status_observations,
      execution: executionObservation,
      linked_pull_requests: issue.linked_pull_requests,
      source_refs: issue.source_refs,
      quality,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));

  const countByStatus = Object.create(null);
  for (const issue of issues) {
    const label = issue.jira_status ?? "UNKNOWN";
    countByStatus[label] = (countByStatus[label] || 0) + 1;
  }

  let aggregateQuality = sources.reduce((quality, source) => worseQuality(quality, source.quality), "CURRENT");
  for (const issue of issues) aggregateQuality = worseQuality(aggregateQuality, issue.quality);
  for (const pullRequest of pullRequests) aggregateQuality = worseQuality(aggregateQuality, pullRequest.quality);
  if (sources.length === 0) aggregateQuality = "UNKNOWN";
  const verificationStatus = sources.length === 0
    || sources.some(source => source.verification_status === "UNKNOWN")
    ? "UNKNOWN"
    : "UNVERIFIED";
  return {
    status: aggregateQuality,
    verification_status: verificationStatus,
    captured_at: new Date(capturedAtMs).toISOString(),
    required_sources: requiredSources,
    sources,
    issues,
    pull_requests: pullRequests,
    counts: {
      unique_jira_issues: issues.length,
      unique_pull_requests: pullRequests.length,
      jira_status: countByStatus,
    },
  };
}

function normalizeSources(snapshots, capturedAtMs, maxAgeSeconds) {
  const normalized = snapshots.map((snapshot, index) => {
    const name = nonEmptyString(snapshot?.name)?.toLowerCase() || null;
    const scope = nonEmptyString(snapshot?.scope);
    const uri = nonEmptyString(snapshot?.uri);
    const checkedAtMs = parseTimestamp(snapshot?.checked_at);
    const revision = nonEmptyString(snapshot?.revision);
    const issuesValid = Array.isArray(snapshot?.issues);
    const pullRequestsValid = Array.isArray(snapshot?.pull_requests);
    const issues = issuesValid ? snapshot.issues : [];
    const pullRequests = pullRequestsValid ? snapshot.pull_requests : [];
    const sourceId = name && scope ? `${name}:${scope}` : `invalid:${index}`;
    const reasons = [];
    let quality = "CURRENT";

    if (snapshot?.status !== "available") {
      quality = "UNKNOWN";
      reasons.push(snapshot?.status === "unavailable" ? "source_unavailable" : "source_status_unknown");
    }
    if (!name || !scope || !uri) {
      quality = worseQuality(quality, "UNKNOWN");
      reasons.push("source_identity_incomplete");
    }
    if (!issuesValid || !pullRequestsValid) {
      quality = worseQuality(quality, "UNKNOWN");
      reasons.push("snapshot_records_incomplete");
    }
    if (checkedAtMs === null || !revision) {
      quality = worseQuality(quality, "UNKNOWN");
      reasons.push(checkedAtMs === null ? "checked_at_unknown" : "revision_unknown");
    } else {
      if (checkedAtMs > capturedAtMs) {
        quality = worseQuality(quality, "UNKNOWN");
        reasons.push("source_time_after_snapshot");
      }
      const ageSeconds = Math.max(0, (capturedAtMs - checkedAtMs) / 1000);
      if (ageSeconds > maxAgeSeconds) {
        quality = worseQuality(quality, "STALE");
        reasons.push("source_snapshot_stale");
      }
    }

    return {
      source_id: sourceId,
      name: name || "UNKNOWN",
      scope: scope || "UNKNOWN",
      uri: uri || "UNKNOWN",
      revision: revision || "UNKNOWN",
      checked_at: checkedAtMs === null ? null : new Date(checkedAtMs).toISOString(),
      quality,
      verification_status: snapshot?.status === "available" ? "UNVERIFIED" : "UNKNOWN",
      reasons,
      issues,
      pull_requests: pullRequests,
    };
  });

  const revisionsBySource = new Map();
  for (const source of normalized) {
    if (source.revision === "UNKNOWN") continue;
    const revisions = revisionsBySource.get(source.source_id) || new Set();
    revisions.add(source.revision);
    revisionsBySource.set(source.source_id, revisions);
  }
  for (const source of normalized) {
    if ((revisionsBySource.get(source.source_id)?.size || 0) > 1) {
      source.quality = "DRIFT";
      source.reasons = [...new Set([...source.reasons, "source_revision_conflict"])];
    }
  }

  return normalized;
}

function normalizeRequiredSources(value, errors) {
  const candidates = value === undefined ? DEFAULT_REQUIRED_SOURCES : value;
  if (!Array.isArray(candidates) || candidates.some(name => !nonEmptyString(name))) {
    errors.push("required_sources_invalid");
    return [];
  }
  return [...new Set(candidates.map(name => nonEmptyString(name).toLowerCase()))];
}

function includeMissingSources(sources, requiredSources) {
  const present = new Set(sources.map(source => source.name));
  for (const name of requiredSources) {
    if (present.has(name)) continue;
    sources.push({
      source_id: `missing:${name}`,
      name,
      scope: "UNKNOWN",
      uri: "UNKNOWN",
      revision: "UNKNOWN",
      checked_at: null,
      quality: "UNKNOWN",
      verification_status: "UNKNOWN",
      reasons: ["required_source_missing"],
      issues: [],
      pull_requests: [],
    });
  }
  return sources;
}

function executionObservationQuality(observation) {
  return observation.status === "STALE" || observation.status === "DRIFT"
    ? observation.status
    : "CURRENT";
}

function collectIssues(snapshots, normalizedSources) {
  const issueMap = new Map();
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index] || {};
    const source = normalizedSources[index];
    if (snapshot.status !== "available" || source.name !== "jira") continue;
    for (const record of source.issues) {
      const key = normalizeIssueKey(record?.key);
      if (!key) continue;
      const issue = issueMap.get(key) || {
        key,
        summary: null,
        parent_key: null,
        jira_status: null,
        summary_values: new Set(),
        parent_key_values: new Set(),
        summary_observations: [],
        parent_key_observations: [],
        jira_status_observations: [],
        status_values: new Set(),
        status_quality: "CURRENT",
        source_states: [],
        source_refs: [],
        linked_pull_requests: new Set(),
      };
      const summary = nonEmptyString(record.summary);
      if (summary) {
        issue.summary_values.add(summary);
        issue.summary_observations.push({ summary, source_id: source.source_id, revision: source.revision });
      }
      const parentKey = normalizeIssueKey(record.parent_key);
      if (parentKey) {
        issue.parent_key_values.add(parentKey);
        issue.parent_key_observations.push({ parent_key: parentKey, source_id: source.source_id, revision: source.revision });
      }
      const status = nonEmptyString(record.status);
      if (status) {
        issue.status_values.add(status);
        issue.jira_status_observations.push({ status, source_id: source.source_id, revision: source.revision });
      }
      issue.source_states.push(source.quality);
      issue.source_refs.push({ uri: source.uri, revision: source.revision, checked_at: source.checked_at });
      issueMap.set(key, issue);
    }
  }

  for (const issue of issueMap.values()) {
    const values = [...issue.status_values];
    const summaries = [...issue.summary_values];
    const parentKeys = [...issue.parent_key_values];
    issue.summary = summaries.length === 1 ? summaries[0] : null;
    issue.parent_key = parentKeys.length === 1 ? parentKeys[0] : null;
    if (summaries.length > 1 || parentKeys.length > 1) issue.status_quality = "DRIFT";
    if (values.length === 1) issue.jira_status = values[0];
    else if (values.length > 1) {
      issue.jira_status = "DRIFT";
      issue.status_quality = "DRIFT";
    } else {
      issue.jira_status = null;
      issue.status_quality = worseQuality(issue.status_quality, "UNKNOWN");
    }
  }
  return issueMap;
}

function collectPullRequests(snapshots, normalizedSources, issueMap) {
  const pullRequests = new Map();
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    const source = normalizedSources[index];
    if (snapshot?.status !== "available" || source.name !== "github" || !Array.isArray(snapshot.pull_requests)) continue;
    for (const record of snapshot.pull_requests) {
      const number = Number.isInteger(record?.number) && record.number > 0 ? record.number : null;
      const repository = nonEmptyString(record?.repository)?.toLowerCase() || null;
      const url = nonEmptyString(record?.url);
      const identityResult = normalizePullRequestIdentity(repository, number, url);
      if (identityResult.conflict) {
        source.quality = worseQuality(source.quality, "DRIFT");
        source.reasons = [...new Set([...source.reasons, "pull_request_identity_conflict"])];
        continue;
      }
      const identity = identityResult.identity;
      if (!identity) {
        source.quality = worseQuality(source.quality, "UNKNOWN");
        source.reasons = [...new Set([...source.reasons, "pull_request_identity_incomplete"])];
        continue;
      }
      const { id, repository: normalizedRepository, number: normalizedNumber } = identity;
      const existing = pullRequests.get(id);
      const current = {
        id,
        repository: normalizedRepository || "UNKNOWN",
        number: normalizedNumber,
        url: url || "UNKNOWN",
        state: nonEmptyString(record.state) || "UNKNOWN",
        head_sha: nonEmptyString(record.head_sha) || "UNKNOWN",
        base_sha: nonEmptyString(record.base_sha) || "UNKNOWN",
        ci_state: nonEmptyString(record.ci_state) || "UNKNOWN",
        review_state: nonEmptyString(record.review_state) || "UNKNOWN",
        merge_state: nonEmptyString(record.merge_state) || "UNKNOWN",
        jira_keys: [...new Set((Array.isArray(record.jira_keys) ? record.jira_keys : [])
          .map(normalizeIssueKey).filter(Boolean))].sort(),
        quality: source.quality,
        verification_status: source.verification_status,
        observations: [{
          source_id: source.source_id,
          revision: source.revision,
          checked_at: source.checked_at,
          state: nonEmptyString(record.state) || "UNKNOWN",
          head_sha: nonEmptyString(record.head_sha) || "UNKNOWN",
          base_sha: nonEmptyString(record.base_sha) || "UNKNOWN",
          ci_state: nonEmptyString(record.ci_state) || "UNKNOWN",
          review_state: nonEmptyString(record.review_state) || "UNKNOWN",
          merge_state: nonEmptyString(record.merge_state) || "UNKNOWN",
        }],
        conflicts: {},
      };
      if (existing) {
        const observation = current.observations[0];
        existing.observations.push(observation);
        for (const field of ["state", "head_sha", "base_sha", "ci_state", "review_state", "merge_state"]) {
          const values = new Set(existing.observations
            .map(item => item[field])
            .filter(value => value !== "UNKNOWN"));
          if (values.size > 1) {
            existing.conflicts[field] = [...values];
            existing[field] = "DRIFT";
            existing.quality = "DRIFT";
          } else if (existing[field] === "UNKNOWN" && values.size === 1) {
            existing[field] = [...values][0];
          }
        }
        existing.quality = worseQuality(existing.quality, source.quality);
        for (const field of ["state", "url", "head_sha", "base_sha", "ci_state", "review_state", "merge_state"]) {
          if (existing[field] === "UNKNOWN" && current[field] !== "UNKNOWN") existing[field] = current[field];
        }
        existing.jira_keys = [...new Set([...existing.jira_keys, ...current.jira_keys])].sort();
      } else {
        pullRequests.set(id, current);
      }
    }
  }

  const result = [...pullRequests.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const pullRequest of result) {
    for (const key of pullRequest.jira_keys) {
      const issue = issueMap.get(key);
      if (issue) issue.linked_pull_requests.add(pullRequest.id);
    }
  }
  for (const issue of issueMap.values()) {
    issue.linked_pull_requests = [...issue.linked_pull_requests].sort();
  }
  return result;
}

function normalizePullRequestIdentity(repository, number, url) {
  const fieldIdentity = repository && number ? { repository, number } : null;
  let urlIdentity = null;
  if (url) {
    try {
      const segments = new URL(url).pathname.split("/").filter(Boolean);
      const pullIndex = segments.findIndex(segment => segment === "pull" || segment === "pulls");
      if (pullIndex > 1) {
        const urlNumber = Number(segments[pullIndex + 1]);
        if (Number.isInteger(urlNumber) && urlNumber > 0) {
          let repoIndex = pullIndex - 2;
          if (segments[repoIndex] === "repos" && pullIndex >= 4) repoIndex += 1;
          const owner = segments[repoIndex];
          const repo = segments[repoIndex + 1];
          if (owner && repo) urlIdentity = { repository: `${owner}/${repo}`.toLowerCase(), number: urlNumber };
        }
      }
    } catch {
      // A malformed URL is not a canonical identity source.
    }
  }

  if (urlIdentity) {
    if ((repository && repository !== urlIdentity.repository) || (number && number !== urlIdentity.number)) {
      return { identity: null, conflict: true };
    }
    return { identity: { ...urlIdentity, id: `${urlIdentity.repository}#${urlIdentity.number}` }, conflict: false };
  }
  return {
    identity: fieldIdentity ? { ...fieldIdentity, id: `${fieldIdentity.repository}#${fieldIdentity.number}` } : null,
    conflict: false,
  };
}

function collectExecutionObservations(observations, capturedAtMs, maxAgeSeconds) {
  const grouped = new Map();
  if (!Array.isArray(observations)) return grouped;
  for (const observation of observations) {
    const key = normalizeIssueKey(observation?.issue_key);
    const state = nonEmptyString(observation?.state)?.toUpperCase();
    const observedAtMs = parseTimestamp(observation?.observed_at);
    const evidenceRef = nonEmptyString(observation?.evidence_ref);
    const source = nonEmptyString(observation?.source);
    if (!key || !state || !EXECUTION_STATES.has(state) || observedAtMs === null
      || observedAtMs > capturedAtMs || !evidenceRef || !source) continue;
    const list = grouped.get(key) || [];
    list.push({ state, observedAtMs, evidenceRef, source });
    grouped.set(key, list);
  }

  for (const [key, list] of grouped) {
    list.sort((a, b) => b.observedAtMs - a.observedAtMs);
    const latestAt = list[0].observedAtMs;
    const latest = list.filter(item => item.observedAtMs === latestAt);
    const states = new Set(latest.map(item => item.state));
    if (states.size > 1) {
      grouped.set(key, {
        state: "UNKNOWN",
        status: "DRIFT",
        verification_status: "UNKNOWN",
        evidence_ref: null,
        source: null,
        observed_at: null,
      });
      continue;
    }
    const selected = latest[0];
    if ((capturedAtMs - selected.observedAtMs) / 1000 > maxAgeSeconds) {
      grouped.set(key, {
        state: "UNKNOWN",
        status: "STALE",
        verification_status: "UNKNOWN",
        reported_state: selected.state,
        evidence_ref: selected.evidenceRef,
        source: selected.source,
        observed_at: new Date(selected.observedAtMs).toISOString(),
      });
      continue;
    }
    grouped.set(key, {
      state: selected.state,
      status: "REPORTED",
      verification_status: "UNVERIFIED",
      evidence_ref: selected.evidenceRef,
      source: selected.source,
      observed_at: new Date(selected.observedAtMs).toISOString(),
    });
  }
  return grouped;
}

function unknownExecutionObservation() {
  return {
    state: "UNKNOWN",
    status: "NOT_OBSERVED",
    verification_status: "UNKNOWN",
    evidence_ref: null,
    source: null,
    observed_at: null,
  };
}

function emptyCounts() {
  return { unique_jira_issues: 0, unique_pull_requests: 0, jira_status: {} };
}

function normalizeIssueKey(value) {
  const key = nonEmptyString(value)?.toUpperCase();
  return key && ISSUE_KEY_PATTERN.test(key) ? key : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseTimestamp(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function worseQuality(left, right) {
  return QUALITY_RANK[right] > QUALITY_RANK[left] ? right : left;
}
