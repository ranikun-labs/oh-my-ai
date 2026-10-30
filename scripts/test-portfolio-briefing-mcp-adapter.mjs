import assert from "node:assert/strict";
import { buildPortfolioBriefingFromMcpResults } from "./lib/portfolio-briefing-mcp-adapter.mjs";

const capturedAt = "2026-10-30T10:40:00.000Z";
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function jiraResult(key, summary, status, updated = "2026-10-30T10:30:00.000Z") {
  return {
    requested_issue_key: key,
    checked_at: capturedAt,
    result: {
      isError: false,
      structuredContent: {
        issues: { nodes: [{
          id: `id-${key}`,
          key,
          fields: {
            summary,
            status: { name: status },
            updated,
            parent: { key: "RPL-112" },
            assignee: { emailAddress: "private@example.test", displayName: "Private Name" },
          },
        }] },
      },
    },
  };
}

function githubResult(number, overrides = {}) {
  return {
    requested_number: number,
    checked_at: capturedAt,
    repository_full_name: "ranikun-labs/oh-my-ai",
    result: {
      isError: false,
      structuredContent: {
        number,
        url: `https://github.com/ranikun-labs/oh-my-ai/pull/${number}`,
        head_repo_full_name: "ranikun-labs/oh-my-ai",
        head_sha: `head-${number}`,
        base_sha: "base-sha",
        state: "open",
        draft: true,
        merged: false,
        updated_at: "2026-10-30T10:35:00Z",
        title: `feat(RPL-119): report for PR ${number}`,
        body: "RPL-115 is referenced as a dependency.\nPrimary Jira: RPL-119",
        ...overrides,
      },
    },
    status_result: { structuredContent: { statuses: [] } },
    review_result: { structuredContent: { reviews: [] } },
  };
}

function confluenceResult(body = "read-only roadmap body") {
  return {
    requested_page_id: "21495809",
    checked_at: capturedAt,
    result: {
      isError: false,
      structuredContent: {
        content: { nodes: [{
          id: "21495809",
          title: "Personal AI Work OS",
          webUrl: "https://ranikunlabs.atlassian.net/wiki/spaces/RLAB/pages/21495809",
          body,
        }] },
      },
    },
  };
}

test("normalizes real MCP envelope shapes and keeps Jira status separate from execution", () => {
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [
      jiraResult("RPL-119", "Korean result reporting", "할 일"),
      jiraResult("RPL-115", "Single actor E2E", "할 일"),
    ],
    github_results: [{
      ...githubResult(88, { body: "Primary Jira: RPL-119; see RPL-115 for a dependency." }),
      status_result: { structuredContent: { statuses: [{ state: "success" }] } },
      review_result: { structuredContent: { reviews: [{ state: "COMMENTED" }] } },
    }],
    confluence_results: [confluenceResult()],
  });

  assert.equal(result.status, "CURRENT");
  assert.equal(result.verification_status, "UNVERIFIED");
  assert.equal(result.issues[0].jira_status, "할 일");
  assert.equal(result.issues[0].execution.state, "UNKNOWN");
  assert.deepEqual(result.issues.find(issue => issue.key === "RPL-119").linked_pull_requests, ["ranikun-labs/oh-my-ai#88"]);
  assert.deepEqual(result.issues.find(issue => issue.key === "RPL-115").linked_pull_requests, []);
  assert.deepEqual(result.pull_requests[0].jira_keys, ["RPL-119"]);
  assert.equal(result.pull_requests[0].ci_state, "SUCCESS");
  assert.equal(result.pull_requests[0].review_state, "COMMENTED");
  assert.equal(result.pull_requests[0].merge_state, "DRAFT_OPEN_UNMERGED");
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
  assert.equal(JSON.stringify(result).includes("Private Name"), false);
});

test("does not infer a Jira association from non-primary PR body references", () => {
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    github_results: [githubResult(88, { title: "feature report", body: "RPL-115 is mentioned, but not the primary Jira." })],
    jira_results: [jiraResult("RPL-115", "E2E", "할 일")],
    confluence_results: [confluenceResult()],
  });
  assert.deepEqual(result.pull_requests[0].jira_keys, []);
  assert.deepEqual(result.issues[0].linked_pull_requests, []);
});

test("preserves unknown CI and Reviewer data when connectors return no evidence", () => {
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jiraResult("RPL-119", "Report", "할 일")],
    github_results: [githubResult(88)],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.pull_requests[0].ci_state, "UNKNOWN");
  assert.equal(result.pull_requests[0].review_state, "NOT_OBSERVED");
  assert.equal(result.issues[0].execution.status, "NOT_OBSERVED");
  assert.equal(result.verification_status, "UNVERIFIED");
});

test("keeps Reviewer lookup errors distinct from an empty review list", () => {
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jiraResult("RPL-119", "Report", "할 일")],
    github_results: [{ ...githubResult(88), review_result: { isError: true } }],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.pull_requests[0].review_state, "UNKNOWN");
});

test("does not trust success statuses returned alongside a CI connector error", () => {
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jiraResult("RPL-119", "Report", "할 일")],
    github_results: [{
      ...githubResult(88),
      status_result: { isError: true, structuredContent: { statuses: [{ state: "success" }] } },
    }],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.pull_requests[0].ci_state, "UNKNOWN");
});

test("maps failed or missing connector responses to fail-closed source states", () => {
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [{ requested_issue_key: "RPL-119", result: { isError: true } }],
    github_results: [],
    confluence_results: [{ requested_page_id: "21495809", result: { isError: true } }],
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.sources.find(source => source.name === "jira").quality, "UNKNOWN");
  assert.equal(result.sources.find(source => source.name === "confluence").quality, "UNKNOWN");
  assert.equal(result.sources.find(source => source.name === "github").reasons.includes("required_source_missing"), true);
});

test("marks a requested PR whose returned URL points to another identity as DRIFT", () => {
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jiraResult("RPL-119", "Report", "할 일")],
    github_results: [githubResult(88, { url: "https://github.com/ranikun-labs/oh-my-ai/pull/89" })],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.status, "DRIFT");
  assert.equal(result.sources.find(source => source.name === "github").reasons.includes("pull_request_identity_conflict"), true);
  assert.equal(result.counts.unique_pull_requests, 0);
});

test("does not silently replace the requested PR number with a different response number", () => {
  const entry = githubResult(88);
  entry.requested_number = 89;
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jiraResult("RPL-119", "Report", "할 일")],
    github_results: [entry],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.sources.find(source => source.name === "github").quality, "UNKNOWN");
  assert.equal(result.counts.unique_pull_requests, 0);
});

test("rejects a response number that conflicts with the requested number even when URL matches", () => {
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jiraResult("RPL-119", "Report", "할 일")],
    github_results: [githubResult(88, { number: 89 })],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.counts.unique_pull_requests, 0);
});

test("uses the requested target repository instead of a fork's head repository", () => {
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jiraResult("RPL-119", "Report", "할 일")],
    github_results: [githubResult(88, { head_repo_full_name: "contributor/oh-my-ai" })],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.pull_requests[0].id, "ranikun-labs/oh-my-ai#88");
  assert.equal(result.status, "CURRENT");
});

test("rejects a Jira response whose issue key differs from the requested issue", () => {
  const entry = jiraResult("RPL-119", "Wrong issue", "할 일");
  entry.result.structuredContent.issues.nodes[0].key = "RPL-115";
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [entry],
    github_results: [githubResult(88)],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.issues.length, 0);
  assert.equal(result.sources.find(source => source.name === "jira").quality, "UNKNOWN");
});

test("rejects a Jira response without a returned issue key", () => {
  const entry = jiraResult("RPL-119", "Report", "할 일");
  entry.result.structuredContent.issues.nodes[0].key = null;
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [entry],
    github_results: [githubResult(88)],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.issues.length, 0);
  assert.equal(result.sources.find(source => source.name === "jira").quality, "UNKNOWN");
});

test("rejects a Confluence response whose page ID differs from the requested page", () => {
  const entry = confluenceResult();
  entry.result.structuredContent.content.nodes[0].id = "99999999";
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jiraResult("RPL-119", "Report", "할 일")],
    github_results: [githubResult(88)],
    confluence_results: [entry],
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.sources.find(source => source.name === "confluence").quality, "UNKNOWN");
});

test("rejects a Confluence response without a returned page ID", () => {
  const entry = confluenceResult();
  entry.result.structuredContent.content.nodes[0].id = null;
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jiraResult("RPL-119", "Report", "할 일")],
    github_results: [githubResult(88)],
    confluence_results: [entry],
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.sources.find(source => source.name === "confluence").quality, "UNKNOWN");
});

test("requires the connector observation time instead of treating capture time as query time", () => {
  const jira = jiraResult("RPL-119", "Report", "할 일");
  delete jira.checked_at;
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jira],
    github_results: [githubResult(88)],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.sources.find(source => source.name === "jira").quality, "UNKNOWN");
  assert.equal(result.issues[0].quality, "UNKNOWN");
});

test("propagates an old connector observation time as STALE", () => {
  const jira = jiraResult("RPL-119", "Report", "할 일");
  jira.checked_at = "2026-10-30T08:00:00.000Z";
  const result = buildPortfolioBriefingFromMcpResults({
    captured_at: capturedAt,
    jira_results: [jira],
    github_results: [githubResult(88)],
    confluence_results: [confluenceResult()],
  });
  assert.equal(result.sources.find(source => source.name === "jira").quality, "STALE");
  assert.equal(result.issues[0].quality, "STALE");
});

process.stdout.write(`PORTFOLIO BRIEFING MCP ADAPTER FIXTURES ${passed}/${passed} PASS\n`);
