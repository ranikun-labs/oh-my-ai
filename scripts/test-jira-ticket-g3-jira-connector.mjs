import assert from "node:assert/strict";
import { createG3SupervisedAdapter } from "./lib/jira-ticket-g3-supervised-adapter.mjs";
import { runJiraTicketCreateWorkflow } from "./lib/jira-ticket-create-workflow.mjs";
import { createG3JiraConnector, G3_JIRA_TOOL_NAMES } from "./lib/jira-ticket-g3-jira-connector.mjs";

const SITE = "https://jira.example.test";
const CLOUD = "123e4567-e89b-12d3-a456-426614174000";
const SESSION = { id: "trusted-session-1" };
const SUMMARY = 'Escalation "path" \\ parser';
const SEARCH_REQUEST = {
  project: "RPL", summary_keywords: SUMMARY, product: "Platform", repository: "oh-my-ai",
  area: "tickets", related_pr: null, branch: null, decision: null, existing_issue_key: null,
  created_after: null, contract_fingerprint_candidate: "not-used-as-jql",
};
const CREATE_REQUEST = {
  project: "RPL", issue_type: "Task", summary: SUMMARY, description: "Approved offline fixture",
  assignee: "account-id-1", priority: "High", labels: ["g3", "offline"],
  fields: { customfield_10108: { id: "101" }, customfield_10109: { id: "202" } },
};

function validProof({ capability, session }) {
  const now = Date.now();
  return {
    allowed: true, capability, session_id: session.id, site_origin: SITE, cloud_id: CLOUD,
    evidence_ref: `synthetic:${capability}`, checked_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 60000).toISOString(),
  };
}

function jiraIssue({ key = "RPL-42", summary = SUMMARY, project = "RPL", self = `${SITE}/rest/api/3/issue/RPL-42`, extraFields = {} } = {}) {
  return { key, self, fields: { project: { key: project }, issuetype: { id: "10010" }, summary, ...extraFields } };
}

async function connector(invokeTool, verifySession = validProof) {
  return createG3JiraConnector({ invokeTool, verifySession, session: SESSION, siteOrigin: SITE, cloudId: CLOUD });
}

async function successPath() {
  const calls = [];
  const jira = await connector(async (name, args) => {
    calls.push({ name, args });
    if (name === G3_JIRA_TOOL_NAMES.search) return {
      content: [{ type: "text", text: JSON.stringify({ issues: [jiraIssue()], total: 1 }) }],
    };
    if (name === G3_JIRA_TOOL_NAMES.create) return {
      structuredContent: jiraIssue({ extraFields: { summary: CREATE_REQUEST.summary } }),
    };
    if (name === G3_JIRA_TOOL_NAMES.read) return {
      structuredContent: jiraIssue({ extraFields: {
        customfield_10108: { id: "101" }, customfield_10109: { id: "202" }, customfield_10110: null,
      } }),
    };
    throw new Error(`unexpected tool name: ${name}`);
  });

  assert.equal(jira.capabilities["jira.search"].connection_verified, true);
  assert.equal(jira.capabilities["jira.create"].evidence_ref, "synthetic:jira.create");
  assert.equal(jira.capabilities["jira.read"].jira_site_origin, SITE);

  const search = await jira.search(SEARCH_REQUEST);
  assert.equal(search.status, "exact_duplicate");
  assert.equal(search.issue.key, "RPL-42");
  assert.equal(search.tool_call_count, 1);
  assert.match(calls[0].args.jql, /^project = RPL AND summary ~ /);
  assert.ok(calls[0].args.jql.includes('\\"path\\"'));
  assert.ok(!calls[0].args.jql.includes("OR project"));
  assert.equal(calls[0].args.searchResultMode, "issues");
  assert.equal(calls[0].args.maxResults, 100);

  const created = await jira.create(CREATE_REQUEST);
  assert.deepEqual(created, {
    kind: "created", key: "RPL-42", url: `${SITE}/browse/RPL-42`, project: "RPL",
    summary: SUMMARY, tool_call_count: 1,
  });
  assert.equal(calls[1].args.cloudId, CLOUD);
  assert.equal(calls[1].args.projectKey, "RPL");
  assert.equal(calls[1].args.issueTypeName, "Task");
  assert.equal(calls[1].args.assignee_account_id, "account-id-1");
  assert.deepEqual(calls[1].args.additional_fields, {
    priority: { name: "High" }, labels: ["g3", "offline"],
    customfield_10108: { id: "101" }, customfield_10109: { id: "202" },
  });

  const read = await jira.read({ key: "RPL-42", fields: ["issuetype", "customfield_10108", "customfield_10109", "customfield_10110"] });
  assert.deepEqual(read, {
    key: "RPL-42", issue_type_id: "10010", fields: {
      customfield_10108: { id: "101" }, customfield_10109: { id: "202" }, customfield_10110: null,
    }, tool_call_count: 1,
  });
  assert.deepEqual(calls[2].args.fields, ["project", "issuetype", "customfield_10108", "customfield_10109", "customfield_10110"]);
  assert.equal(calls[2].args.failFast, true);
  assert.equal(calls.length, 3);
}

async function searchFailuresAndPagination() {
  let calls = 0;
  const paged = await connector(async () => {
    calls += 1;
    return { structuredContent: { issues: [jiraIssue()], nextPageToken: "next-page" } };
  });
  assert.equal((await paged.search(SEARCH_REQUEST)).status, "similar");
  assert.equal(calls, 1);

  const emptyPaged = await connector(async () => {
    calls += 1;
    return { structuredContent: { issues: [], isLast: false } };
  });
  assert.deepEqual(await emptyPaged.search(SEARCH_REQUEST), { status: "failed", tool_call_count: 1 });
  assert.equal(calls, 2);

  const malformedTotal = await connector(async () => {
    calls += 1;
    return { structuredContent: { issues: [], total: "0" } };
  });
  assert.deepEqual(await malformedTotal.search(SEARCH_REQUEST), { status: "failed", tool_call_count: 1 });
  assert.equal(calls, 3);

  const toolError = await connector(async () => {
    calls += 1;
    return { isError: true, content: [{ type: "text", text: "synthetic Jira failure" }] };
  });
  assert.deepEqual(await toolError.search(SEARCH_REQUEST), { status: "failed", tool_call_count: 1 });
  assert.equal(calls, 4);

  const timeout = await connector(async () => { calls += 1; throw new Error("synthetic timeout"); });
  assert.deepEqual(await timeout.search(SEARCH_REQUEST), { status: "failed", tool_call_count: 1 });
  assert.equal(calls, 5);
}

async function createAmbiguityAndNoRetry() {
  let calls = 0;
  const timedOut = await connector(async () => { calls += 1; throw new Error("synthetic timeout"); });
  await assert.rejects(timedOut.create(CREATE_REQUEST), error => {
    assert.equal(error.code, "JIRA_CREATE_POSSIBLY_APPLIED");
    assert.equal(error.tool_call_count, 1);
    assert.equal(error.mutation_status, "possibly_applied");
    assert.equal(error.automatic_retry, false);
    return true;
  });
  assert.equal(calls, 1);

  const missingIdentity = await connector(async () => {
    calls += 1;
    return { structuredContent: { key: "RPL-42", id: "10042", self: `${SITE}/rest/api/3/issue/RPL-42` } };
  });
  await assert.rejects(missingIdentity.create(CREATE_REQUEST), error => {
    assert.equal(error.code, "JIRA_CREATE_POSSIBLY_APPLIED");
    assert.equal(error.tool_call_count, 1);
    assert.equal(error.mutation_status, "possibly_applied");
    return true;
  });
  assert.equal(calls, 2);

  const wrongSite = await connector(async () => {
    calls += 1;
    return { structuredContent: jiraIssue({ self: "https://other.example/rest/api/3/issue/RPL-42" }) };
  });
  await assert.rejects(wrongSite.create(CREATE_REQUEST), error => error.code === "JIRA_CREATE_POSSIBLY_APPLIED");
  assert.equal(calls, 3);
}

async function authScopeAndGetValidation() {
  let calls = 0, verifyCalls = 0;
  const staleOnUse = await connector(async () => { calls += 1; return { structuredContent: { issues: [] } }; }, input => {
    verifyCalls += 1;
    const proof = validProof(input);
    if (verifyCalls > 3) proof.expires_at = new Date(Date.now() - 1).toISOString();
    return proof;
  });
  await assert.rejects(staleOnUse.search(SEARCH_REQUEST), error => error.code === "JIRA_CONNECTOR_ERROR");
  assert.equal(calls, 0);

  await assert.rejects(createG3JiraConnector({
    invokeTool: async () => { calls += 1; }, verifySession: input => ({
      ...validProof(input), site_origin: "https://other.example",
    }), session: SESSION, siteOrigin: SITE, cloudId: CLOUD,
  }), /proof missing, stale or out of scope/);
  assert.equal(calls, 0);

  const incompleteGet = await connector(async () => {
    calls += 1;
    return { structuredContent: jiraIssue({ extraFields: { customfield_10108: { id: "101" } } }) };
  });
  await assert.rejects(incompleteGet.read({ key: "RPL-42", fields: ["issuetype", "customfield_10108", "customfield_10109"] }),
    error => error.code === "JIRA_CONNECTOR_ERROR" && error.tool_call_count === 1);
  assert.equal(calls, 1);

  await assert.rejects(createG3JiraConnector({
    invokeTool: async () => {}, verifySession: async () => { throw new Error("no trusted verifier result"); },
    session: SESSION, siteOrigin: "http://jira.example.test", cloudId: CLOUD,
  }), /canonical HTTPS origin/);
}

async function supervisedWorkflowIntegration() {
  const toolCalls = [];
  const jira = await connector(async (name, args) => {
    toolCalls.push({ name, args });
    if (name === G3_JIRA_TOOL_NAMES.search) return { structuredContent: { issues: [], total: 0 } };
    if (name === G3_JIRA_TOOL_NAMES.create) return { structuredContent: {
      key: "RPL-73", self: `${SITE}/rest/api/3/issue/RPL-73`,
      fields: { project: { key: args.projectKey }, issuetype: { id: "10010" }, summary: args.summary },
    } };
    if (name === G3_JIRA_TOOL_NAMES.read) return { structuredContent: {
      key: "RPL-73", self: `${SITE}/rest/api/3/issue/RPL-73`,
      fields: { project: { key: "RPL" }, issuetype: { id: "10010" },
        customfield_10108: { id: "101" }, customfield_10109: { id: "202" }, customfield_10110: null },
    } };
    throw new Error(`unexpected tool name: ${name}`);
  });
  const capabilityEvidence = {
    ...jira.capabilities,
    "jira.intent.persist": { available: true, connection_verified: true, evidence_ref: "synthetic:ledger-intent" },
    "jira.origin.persist": { available: true, connection_verified: true, evidence_ref: "synthetic:ledger-origin" },
  };
  let intent;
  const ledger = {
    async persistIntent(request) {
      intent = structuredClone(request);
      return { status: "persisted", durable: true, created_new: true, prior_issue_key: null,
        create_request_id: request.create_request_id, ledger_ref: request.ledger_ref,
        approved_preview_id: request.approved_preview_id, activation_ref: request.activation_ref };
    },
    async linkIssue(requestId, issue) {
      assert.equal(requestId, intent.create_request_id);
      assert.equal(issue.key, "RPL-73");
      return { linked: true };
    },
    async persistOrigin(request) {
      return { status: "persisted", durable: true, issue_key: request.issue_key,
        create_request_id: request.create_request_id, ledger_ref: request.ledger_ref,
        phase: request.phase, cutover_approval_ref: request.cutover_approval_ref,
        create_activation_ref: request.create_activation_ref, origin: request.origin,
        read_authority: request.read_authority, write_authority: request.write_authority };
    },
    async readClassificationAuthority() { throw new Error("unused by this write workflow"); },
  };
  const adapter = createG3SupervisedAdapter({
    jira,
    ledger,
    verifyGate: async ({ stage }) => ({ allowed: true, evidence_ref: `synthetic:owner-gate:${stage}`,
      ...(stage === "intent" ? { cutover_approval_ref: "synthetic:approval" } : {}) }),
    siteOrigin: SITE,
    capabilityEvidence,
  });
  const contract = {
    Summary: "Offline Jira connector integration fixture",
    Context: "Synthetic test only", Goal: "Verify the callable bridge contract",
    "Source of Truth": "Local test source", "In Scope": "One fake Jira issue",
    "Out of Scope": "Remote tools and production authorization",
    "Acceptance Criteria": "One Search and one Create are normalized from returned data",
    Repository: "oh-my-ai", "Base Branch": "main", "Expected Branch Name": "test/g3-connector",
    Dependencies: "None", Verification: "Synthetic node test", "Do Not Touch": "Jira service",
    "Definition of Done": "Verified synthetic report",
  };
  const now = Date.now();
  const at = offset => new Date(now + offset).toISOString();
  const noDefault = { required: false, hasDefaultValue: false, defaultValue: null };
  const selectCustom = "com.atlassian.jira.plugin.system.customfieldtypes:select";
  const fields = {
    customfield_10042: { ...noDefault }, customfield_10043: { ...noDefault }, customfield_10044: { ...noDefault },
    customfield_10108: { required: true, hasDefaultValue: false, defaultValue: null,
      schema: { type: "option", custom: selectCustom }, allowedValues: [{ id: "101", value: "Platform" }] },
    customfield_10109: { required: true, hasDefaultValue: false, defaultValue: null,
      schema: { type: "option", custom: selectCustom }, allowedValues: [{ id: "202", value: "Connector" }] },
    customfield_10110: { required: false, hasDefaultValue: false, defaultValue: null,
      schema: { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" }, allowedValues: [] },
    customfield_10015: { ...noDefault, schema: { type: "date" } },
    customfield_10045: { ...noDefault, schema: { type: "array", items: "user" } },
    duedate: { ...noDefault, schema: { type: "date" } },
  };
  const metadata = {
    project: "RPL", issue_type: "Task", assignee: "account-id-1", priority: "High",
    product: "Platform", repository: "oh-my-ai", area: "tickets", labels: [],
    target_create: {
      mode: "single_supervised", request_id: "request-offline-123", ledger_ref: "synthetic-g3-ledger",
      cutover: { status: "approved", approval_ref: "synthetic:approval", activation_ref: "synthetic:activation",
        effective_from: at(-60_000), effective_to: at(3_600_000), request_time: at(0), rollback_ref: "synthetic:rollback" },
      readiness: { reader: true, board: true, automation: true, rollback: true, ledger: true },
      create_metadata: { source: "live_jira_create_metadata", project: "RPL", issue_type: "Task",
        issue_type_id: "10010", observed_at: at(-10_000), fields },
      selection: { product: { id: "101", value: "Platform" }, component: { id: "202", value: "Connector" }, concerns: [] },
      supplemental_fields: {},
    },
  };
  const report = await runJiraTicketCreateWorkflow({
    adapter, contract, metadata, approval: { current: true },
  });
  assert.equal(report.search_result, "none");
  assert.equal(report.duplicate_status, "none");
  assert.equal(report.create_call_count, 1);
  assert.equal(report.mutation_status, "applied");
  assert.equal(report.verification_status, "verified");
  assert.equal(report.origin_status, "target_create");
  assert.equal(report.actual_issue_key, "RPL-73");
  assert.equal(report.actual_issue_url, `${SITE}/browse/RPL-73`);
  assert.deepEqual(toolCalls.map(call => call.name), [G3_JIRA_TOOL_NAMES.search, G3_JIRA_TOOL_NAMES.create, G3_JIRA_TOOL_NAMES.read]);
}

await successPath();
await searchFailuresAndPagination();
await createAmbiguityAndNoRetry();
await authScopeAndGetValidation();
await supervisedWorkflowIntegration();
process.stdout.write("Synthetic G3 Jira connector checks passed.\n");
