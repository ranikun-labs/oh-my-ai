import { createHash } from "node:crypto";
import { buildPortfolioBriefingSnapshot } from "./portfolio-briefing-snapshot.mjs";

const DEFAULT_JIRA_BASE_URL = "https://ranikunlabs.atlassian.net";

/**
 * Normalize read-only host MCP connector results into the F6 snapshot contract.
 * This adapter does not invoke tools, authenticate, or perform network/Writer work;
 * the host must call read-only connectors and pass their CallToolResult objects.
 * Each result entry must carry checked_at from its connector-call observation;
 * captured_at is never substituted because cached results could look fresh.
 */
export function buildPortfolioBriefingFromMcpResults(input = {}) {
  const capturedAt = input.captured_at;
  const jiraBaseUrl = trimTrailingSlash(nonEmptyString(input.jira_base_url) || DEFAULT_JIRA_BASE_URL);
  const sourceSnapshots = [
    ...normalizeJiraResults(input.jira_results, jiraBaseUrl),
    ...normalizeGithubResults(input.github_results),
    ...normalizeConfluenceResults(input.confluence_results),
  ];

  return buildPortfolioBriefingSnapshot({
    captured_at: capturedAt,
    source_snapshots: sourceSnapshots,
    required_sources: input.required_sources,
    max_age_seconds: input.max_age_seconds,
    execution_observations: input.execution_observations,
  });
}

function normalizeJiraResults(entries, baseUrl) {
  if (!Array.isArray(entries)) return [];
  const snapshots = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] || {};
    const result = entry.result;
    const nodes = result?.structuredContent?.issues?.nodes;
    if (result?.isError || !Array.isArray(nodes) || nodes.length === 0) {
      const requestedKey = validIssueKey(entry.requested_issue_key) || `UNKNOWN-${index + 1}`;
      snapshots.push({
        name: "jira",
        scope: `issue:${requestedKey}`,
        uri: requestedKey.startsWith("UNKNOWN-") ? baseUrl : `${baseUrl}/browse/${requestedKey}`,
        revision: null,
        checked_at: nonEmptyString(entry.checked_at),
        status: "unavailable",
        issues: [],
        pull_requests: [],
      });
      continue;
    }

    for (const node of nodes) {
      const fields = node?.fields || {};
      const requestedKey = validIssueKey(entry.requested_issue_key);
      const returnedKey = validIssueKey(node?.key);
      const identityMatches = returnedKey !== null && (!requestedKey || requestedKey === returnedKey);
      const key = requestedKey || returnedKey;
      const updated = nonEmptyString(fields.updated);
      const id = nonEmptyString(node?.id);
      snapshots.push({
        name: "jira",
        scope: key ? `issue:${key}` : `query:${index + 1}`,
        uri: key ? `${baseUrl}/browse/${key}` : baseUrl,
        revision: identityMatches && id && updated ? `jira-issue:${id}:updated:${updated}` : null,
        checked_at: nonEmptyString(entry.checked_at),
        status: identityMatches ? "available" : "unavailable",
        // Explicit allowlist: omit assignee, reporter, email, description, and comments.
        issues: identityMatches ? [{
          key: returnedKey,
          summary: nonEmptyString(fields.summary),
          status: nonEmptyString(fields.status?.name),
          parent_key: validIssueKey(fields.parent?.key),
        }] : [],
        pull_requests: [],
      });
    }
  }
  return snapshots;
}

function normalizeGithubResults(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    const result = entry?.result;
    const info = result?.structuredContent || {};
    const requestedNumber = positiveInteger(entry?.requested_number);
    const returnedNumber = positiveInteger(info.number);
    const number = returnedNumber;
    const url = nonEmptyString(info.url);
    const repository = nonEmptyString(entry?.repository_full_name)
      || repositoryFromPullRequestUrl(url)
      || nonEmptyString(info.head_repo_full_name)
      || null;
    const identityMatches = returnedNumber !== null && (!requestedNumber || requestedNumber === returnedNumber);
    const identityAvailable = !result?.isError && identityMatches && url !== null && repository !== null;
    const statuses = entry?.status_result?.structuredContent?.statuses;
    const reviews = entry?.review_result?.structuredContent?.reviews;
    const ciState = entry?.status_result?.isError
      ? "UNKNOWN"
      : Array.isArray(statuses) && statuses.length > 0
        ? summarizeCheckStates(statuses)
        : "UNKNOWN";
    const reviewState = entry?.review_result?.isError
      ? "UNKNOWN"
      : Array.isArray(reviews) && reviews.length > 0
        ? [...new Set(reviews.map(review => nonEmptyString(review?.state)).filter(Boolean))].sort().join(",") || "UNKNOWN"
        : "NOT_OBSERVED";
    const titleKeys = [...new Set(extractIssueKeys(nonEmptyString(info.title) || ""))];
    const primaryKey = extractPrimaryJiraKey(nonEmptyString(info.body) || "");
    const jiraKeys = primaryKey ? [primaryKey] : titleKeys.length === 1 ? titleKeys : [];
    const headSha = nonEmptyString(info.head_sha);
    const updatedAt = nonEmptyString(info.updated_at);

    return {
      name: "github",
      scope: repository && number ? `${repository}#${number}` : `pull-request:${index + 1}`,
      uri: url || "UNKNOWN",
      revision: identityAvailable && headSha && updatedAt ? `github-head:${headSha}:updated:${updatedAt}` : null,
      checked_at: nonEmptyString(entry?.checked_at),
      status: identityAvailable ? "available" : "unavailable",
      issues: [],
      pull_requests: identityAvailable ? [{
        repository,
        number,
        url,
        state: nonEmptyString(info.state),
        head_sha: headSha,
        base_sha: nonEmptyString(info.base_sha),
        ci_state: ciState,
        review_state: reviewState,
        merge_state: info.merged === true
          ? "MERGED"
          : info.draft === true
            ? "DRAFT_OPEN_UNMERGED"
            : info.state === "open" ? "OPEN_UNMERGED" : "UNKNOWN",
        jira_keys: jiraKeys,
      }] : [],
    };
  });
}

function normalizeConfluenceResults(entries) {
  if (!Array.isArray(entries)) return [];
  const snapshots = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] || {};
    const result = entry.result;
    const nodes = result?.structuredContent?.content?.nodes;
    if (result?.isError || !Array.isArray(nodes) || nodes.length === 0) {
      snapshots.push({
        name: "confluence",
        scope: `page:${nonEmptyString(entry.requested_page_id) || `UNKNOWN-${index + 1}`}`,
        uri: "UNKNOWN",
        revision: null,
        checked_at: nonEmptyString(entry.checked_at),
        status: "unavailable",
        issues: [],
        pull_requests: [],
      });
      continue;
    }

    for (const page of nodes) {
      const requestedPageId = nonEmptyString(entry.requested_page_id);
      const returnedPageId = nonEmptyString(page?.id);
      const pageId = requestedPageId || returnedPageId;
      const identityMatches = returnedPageId !== null && (!requestedPageId || requestedPageId === returnedPageId);
      const body = typeof page?.body === "string" ? page.body : null;
      snapshots.push({
        name: "confluence",
        scope: pageId ? `page:${pageId}` : `page:unknown-${index + 1}`,
        uri: nonEmptyString(page?.webUrl) || "UNKNOWN",
        // The connector does not always expose a numeric page version; hash only the retrieved body.
        revision: body === null || !pageId || !identityMatches
          ? null
          : `content-sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`,
        checked_at: nonEmptyString(entry.checked_at),
        status: body === null || !pageId || !identityMatches ? "unavailable" : "available",
        issues: [],
        pull_requests: [],
      });
    }
  }
  return snapshots;
}

function summarizeCheckStates(statuses) {
  const states = statuses.map(status => nonEmptyString(status?.state)?.toLowerCase()).filter(Boolean);
  if (states.length === 0) return "UNKNOWN";
  if (states.every(state => state === "success")) return "SUCCESS";
  if (states.some(state => state === "failure" || state === "error")) return "FAILURE";
  return "PENDING_OR_MIXED";
}

function extractPrimaryJiraKey(body) {
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?Primary Jira(?:\*\*)?\s*:\s*(?:\*\*)?\s*\[?(RPL-[1-9][0-9]*)\b/i);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

function extractIssueKeys(text) {
  return [...text.matchAll(/\bRPL-[1-9][0-9]*\b/g)].map(match => match[0]);
}

function repositoryFromPullRequestUrl(value) {
  if (!value) return null;
  try {
    const segments = new URL(value).pathname.split("/").filter(Boolean);
    const pullIndex = segments.findIndex(segment => segment === "pull" || segment === "pulls");
    if (pullIndex < 2) return null;
    return `${segments[pullIndex - 2]}/${segments[pullIndex - 1]}`.toLowerCase();
  } catch {
    return null;
  }
}

function validIssueKey(value) {
  const key = nonEmptyString(value)?.toUpperCase();
  return key && /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(key) ? key : null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
