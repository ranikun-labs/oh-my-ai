import assert from "node:assert/strict";
import { createG3ReadOnlyJiraConnector, G3_JIRA_TOOL_NAMES } from "./lib/jira-ticket-g3-jira-connector.mjs";
import { runG3ReadOnlyRuntimeSmoke } from "./jira-ticket-g3-read-only-runtime.mjs";

const SITE = "https://jira.example.test";
const CLOUD = "123e4567-e89b-12d3-a456-426614174000";
const ISSUE_KEY = "RPL-122";
const SUMMARY = "Jira G3 — PR #84 Task Create Gate·Connector 결함 수정 및 독립 검수";
const SESSION = Object.freeze({ id: "fixture-session" });
const issue = {
  id: "10239", key: ISSUE_KEY,
  self: `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/10239`,
  webUrl: `${SITE}/browse/${ISSUE_KEY}`,
  fields: { summary: SUMMARY, project: { key: "RPL" }, issuetype: { id: "10010" }, status: { name: "To Do" } },
};

function fixture({ stale = false, wrongSite = false, wrongCloud = false, badIssueKey = false,
  badReadSummary = false } = {}) {
  const calls = [];
  const runtime = {
    session: SESSION, siteOrigin: SITE, cloudId: CLOUD,
    verifySession: async ({ capability, session, siteOrigin, cloudId }) => {
      const now = Date.now();
      return { allowed: true, capability, session_id: session.id,
        site_origin: wrongSite ? "https://other.example" : siteOrigin,
        cloud_id: wrongCloud ? "00000000-0000-4000-8000-000000000000" : cloudId,
        evidence_ref: `synthetic:${capability}`,
        checked_at: new Date(now - 1000).toISOString(),
        expires_at: new Date(now + (stale ? -1000 : 60_000)).toISOString() };
    },
    invokeTool: async (name, args) => {
      calls.push({ name, args });
      if (name === G3_JIRA_TOOL_NAMES.search) {
        const node = badIssueKey ? { ...issue, key: "RPL-999", webUrl: `${SITE}/browse/RPL-999` } : issue;
        const raw = { issues: { nodes: [{ id: node.id, key: node.key, self: node.self, webUrl: node.webUrl,
          fields: { summary: node.fields.summary, project: node.fields.project, issuetype: node.fields.issuetype } }],
        pageInfo: { hasNextPage: false, endCursor: null }, webUrl: `${SITE}/issues` } };
        return { content: [{ type: "text", text: JSON.stringify(raw) }],
          structuredContent: { ...raw, context: { private_session_id: "must-not-be-logged" } } };
      }
      if (name === G3_JIRA_TOOL_NAMES.read)
        return { structuredContent: { issue: { ...issue, fields: { project: issue.fields.project,
          issuetype: issue.fields.issuetype, status: issue.fields.status,
          summary: badReadSummary ? "stale issue summary" : issue.fields.summary } } } };
      throw new Error("must never call Jira Create");
    },
  };
  return { runtime, calls };
}

{
  const { runtime, calls } = fixture();
  const report = await runG3ReadOnlyRuntimeSmoke({ runtime, issueKey: ISSUE_KEY, searchSummary: SUMMARY });
  assert.equal(report.status, "READ_ONLY_CONNECTOR_SMOKE_PASSED");
  assert.deepEqual(report.runner_tool_calls, { search: 1, get: 1, create: 0 });
  assert.deepEqual(calls.map(call => call.name), [G3_JIRA_TOOL_NAMES.search, G3_JIRA_TOOL_NAMES.read]);
  assert.equal(JSON.stringify(report).includes("must-not-be-logged"), false);
  assert.equal(JSON.stringify(report).includes(SUMMARY), false);
  const connector = await createG3ReadOnlyJiraConnector({ ...runtime });
  assert.equal(Object.hasOwn(connector, "create"), false);
}

for (const options of [{ stale: true }, { wrongSite: true }, { wrongCloud: true }]) {
  const { runtime, calls } = fixture(options);
  await assert.rejects(runG3ReadOnlyRuntimeSmoke({ runtime, issueKey: ISSUE_KEY, searchSummary: SUMMARY }));
  assert.equal(calls.length, 0, "untrusted or stale session proof must fail before Jira calls");
}

{
  const { runtime, calls } = fixture({ badIssueKey: true });
  await assert.rejects(runG3ReadOnlyRuntimeSmoke({ runtime, issueKey: ISSUE_KEY, searchSummary: SUMMARY }),
    error => error.code === "JIRA_SEARCH_RESULT_MISMATCH");
  assert.equal(calls.length, 1, "mismatched Search result must stop before GET");
}

{
  const { runtime, calls } = fixture({ badReadSummary: true });
  await assert.rejects(runG3ReadOnlyRuntimeSmoke({ runtime, issueKey: ISSUE_KEY, searchSummary: SUMMARY }),
    error => error.code === "JIRA_GET_RESULT_MISMATCH");
  assert.equal(calls.length, 2, "GET summary drift must fail after the one permitted Search and GET");
}

{
  const { runtime, calls } = fixture();
  runtime.invokeTool = async (name, args) => {
    calls.push({ name, args });
    throw new Error("secret-bearing adapter failure must be suppressed");
  };
  await assert.rejects(runG3ReadOnlyRuntimeSmoke({ runtime, issueKey: ISSUE_KEY, searchSummary: SUMMARY }),
    error => error.code === "JIRA_SEARCH_RESULT_MISMATCH" || error.code === "JIRA_SEARCH_FAILED");
  assert.equal(calls.length, 1);
}

{
  await assert.rejects(runG3ReadOnlyRuntimeSmoke({ runtime: {}, issueKey: ISSUE_KEY, searchSummary: SUMMARY }),
    error => error.code === "RUNTIME_BRIDGE_INVALID");
}

process.stdout.write("Synthetic G3 read-only runtime runner checks passed.\n");
