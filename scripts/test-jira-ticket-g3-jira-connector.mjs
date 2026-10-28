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
const CREATE_GATE_PROOF = {
  allowed: true, evidence_ref: "synthetic:verified-metadata",
  issue_type_binding: { canonical_issue_type: "Task", issue_type_id: "10010",
    localized_issue_type_name: "Task", metadata_sha256: "a".repeat(64) },
};
const LOCALIZED_CREATE_GATE_PROOF = {
  ...CREATE_GATE_PROOF,
  issue_type_binding: { ...CREATE_GATE_PROOF.issue_type_binding, localized_issue_type_name: "작업" },
};

function validProof({ capability, session }) {
  const now = Date.now();
  return {
    allowed: true, capability, session_id: session.id, site_origin: SITE, cloud_id: CLOUD,
    evidence_ref: `synthetic:${capability}`, checked_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 60000).toISOString(),
  };
}

function jiraIssue({ key = "RPL-42", id = "10042", summary = SUMMARY, project = "RPL", self,
  extraFields = {}, ...extraIssueFields } = {}) {
  return { id, key, self: self ?? `${SITE}/rest/api/3/issue/${id}`,
    fields: { project: { key: project }, issuetype: { id: "10010" }, summary, ...extraFields }, ...extraIssueFields };
}

function rovoIssue({ key = "RPL-42", id = "10042", summary = SUMMARY, project = "RPL",
  webUrl = `${SITE}/browse/${key}`, extraFields = {}, ...extraIssueFields } = {}) {
  return { id, key,
    self: `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/${id}`,
    webUrl, fields: { project: { key: project }, issuetype: { id: "10010" }, summary, ...extraFields },
    ...extraIssueFields };
}

function rawRovoIssue(issue) {
  const { webUrl: _webUrl, ...raw } = issue;
  return raw;
}

function rovoSearchResponse(issues, { hasNextPage = false, pageInfo = { hasNextPage, endCursor: null },
  webUrl = `${SITE}/issues?jql=synthetic`, rawIssues = issues, isLast = !hasNextPage } = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify({ issues: rawIssues.map(rawRovoIssue), isLast }) }],
    structuredContent: { issues: { nodes: issues, webUrl, pageInfo }, context: {} },
  };
}

function rovoGetResponse(issue, { nodes = [issue], raw = rawRovoIssue(issue) } = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify(raw) }],
    structuredContent: { issues: { nodes }, context: {} },
  };
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

  const created = await jira.create(CREATE_REQUEST, LOCALIZED_CREATE_GATE_PROOF);
  assert.deepEqual(created, {
    kind: "created", key: "RPL-42", url: `${SITE}/browse/RPL-42`, project: "RPL",
    summary: SUMMARY, tool_call_count: 1,
  });
  assert.equal(calls[1].args.cloudId, CLOUD);
  assert.equal(calls[1].args.projectKey, "RPL");
  assert.equal(calls[1].args.issueTypeName, "작업");
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

async function verifiedIssueTypeBindingRequired() {
  let calls = 0;
  const jira = await connector(async () => { calls++; return { structuredContent: {} }; });
  await assert.rejects(jira.create(CREATE_REQUEST), error => error.code === "JIRA_CONNECTOR_ERROR"
    && error.mutation_status === "not_started" && error.tool_call_count === 0);
  await assert.rejects(jira.create(CREATE_REQUEST, { ...LOCALIZED_CREATE_GATE_PROOF,
    issue_type_binding: { ...LOCALIZED_CREATE_GATE_PROOF.issue_type_binding, issue_type_id: "10007" } }),
  error => error.code === "JIRA_CONNECTOR_ERROR" && error.tool_call_count === 0);
  assert.equal(calls, 0, "missing or mismatched signed type binding must block before an MCP call");
}

async function explicitReporterRejectedBeforeCreateTool() {
  const calls = [];
  const jira = await connector(async (name, args) => {
    calls.push({ name, args });
    return { structuredContent: jiraIssue({ extraFields: { summary: CREATE_REQUEST.summary } }) };
  });
  for (const reporter of [null, undefined, { accountId: "unapproved-reporter" }]) {
    await assert.rejects(() => jira.create({ ...CREATE_REQUEST, reporter }, LOCALIZED_CREATE_GATE_PROOF),
      /Jira Create request does not match the G3 approved request shape/i);
  }
  assert.deepEqual(calls, [], "any top-level reporter property must fail before the Jira Create tool call");
}

async function optionalCreateWrappersAndCanonicalCloudId() {
  const request = { ...CREATE_REQUEST };
  delete request.assignee;
  delete request.priority;
  delete request.labels;
  let received;
  const jira = await connector(async (_name, args) => {
    received = args;
    return { structuredContent: jiraIssue({ extraFields: { summary: request.summary } }) };
  });
  await jira.create(request, LOCALIZED_CREATE_GATE_PROOF);
  assert.equal(Object.hasOwn(received, "assignee_account_id"), false);
  assert.deepEqual(received.additional_fields, {
    customfield_10108: { id: "101" }, customfield_10109: { id: "202" },
  });

  let verificationCalls = 0;
  await assert.rejects(createG3JiraConnector({ invokeTool: async () => {},
    verifySession: async input => { verificationCalls++; return validProof(input); },
    session: SESSION, siteOrigin: SITE, cloudId: SITE }), /requires a Cloud UUID/i);
  assert.equal(verificationCalls, 0, "site URLs must be rejected before session verification");

  const upperCaseCloudId = await createG3JiraConnector({ invokeTool: async () => ({}),
    verifySession: async input => validProof(input), session: SESSION, siteOrigin: SITE,
    cloudId: CLOUD.toUpperCase() });
  assert.equal(upperCaseCloudId.capabilities["jira.read"].connection_verified, true,
    "UUID casing is normalized before comparing signed session scope");
}

async function rovoEnvelopeCompatibility() {
  // Sanitized shape captured from Rovo Search/Get: webUrl exists only in the
  // structured node; content preserves the underlying Jira API issue fields.
  const calls = [];
  const jira = await connector(async (name, args) => {
    calls.push({ name, args });
    if (name === G3_JIRA_TOOL_NAMES.search) return rovoSearchResponse([rovoIssue()]);
    if (name === G3_JIRA_TOOL_NAMES.create) return rovoGetResponse(rovoIssue({ summary: CREATE_REQUEST.summary }));
    if (name === G3_JIRA_TOOL_NAMES.read) return rovoGetResponse(rovoIssue({ extraFields: {
      customfield_10108: { id: "101" }, customfield_10109: { id: "202" }, customfield_10110: null,
    } }));
    throw new Error(`unexpected tool name: ${name}`);
  });

  const search = await jira.search(SEARCH_REQUEST);
  assert.equal(search.status, "exact_duplicate");
  assert.equal(search.issue.url, `${SITE}/browse/RPL-42`);
  assert.equal(search.tool_call_count, 1);
  const created = await jira.create(CREATE_REQUEST, CREATE_GATE_PROOF);
  assert.deepEqual(created, { kind: "created", key: "RPL-42", url: `${SITE}/browse/RPL-42`,
    project: "RPL", summary: SUMMARY, tool_call_count: 1 });
  const read = await jira.read({ key: "RPL-42", fields: ["issuetype", "customfield_10108", "customfield_10109", "customfield_10110"] });
  assert.deepEqual(read, { key: "RPL-42", issue_type_id: "10010", fields: {
    customfield_10108: { id: "101" }, customfield_10109: { id: "202" }, customfield_10110: null,
  }, tool_call_count: 1 });
  assert.deepEqual(calls.map(call => call.name), [G3_JIRA_TOOL_NAMES.search, G3_JIRA_TOOL_NAMES.create, G3_JIRA_TOOL_NAMES.read]);

  const badSearchResponses = [
    { content: [{ type: "text", text: JSON.stringify({ issues: [], hasMore: true }) }],
      structuredContent: { issues: { nodes: [], webUrl: `${SITE}/issues`,
        pageInfo: { hasNextPage: false, endCursor: null } }, context: {} } },
    { content: [{ type: "text", text: JSON.stringify({ issues: [],
      pageInfo: { hasNextPage: true, endCursor: "top-level-next" } }) }],
      structuredContent: { issues: { nodes: [], webUrl: `${SITE}/issues`,
        pageInfo: { hasNextPage: false, endCursor: null } }, context: {} } },
    { content: [{ type: "text", text: JSON.stringify({ issues: {
      nodes: [rawRovoIssue(rovoIssue())], pageInfo: { hasNextPage: true, endCursor: "untrusted-next" },
    } }) }], structuredContent: { issues: { nodes: [rovoIssue()], webUrl: `${SITE}/issues`,
      pageInfo: { hasNextPage: false, endCursor: null } }, context: {} } },
    { content: [{ type: "text", text: JSON.stringify({ issues: {
      nodes: [rawRovoIssue(rovoIssue())], pageInfo: { hasNextPage: false, endCursor: "conflicting-cursor" },
    } }) }], structuredContent: { issues: { nodes: [rovoIssue()], webUrl: `${SITE}/issues`,
      pageInfo: { hasNextPage: false, endCursor: null } }, context: {} } },
    rovoSearchResponse([rovoIssue()], { hasNextPage: true }),
    rovoSearchResponse([rovoIssue()], { pageInfo: {} }),
    rovoSearchResponse([rovoIssue()], { webUrl: "https://other.example/issues" }),
    rovoSearchResponse([rovoIssue()], { rawIssues: [rawRovoIssue(rovoIssue({ key: "RPL-43" }))] }),
    { content: [{ type: "text", text: JSON.stringify({ issues: [rawRovoIssue(rovoIssue())], isLast: true,
      errors: { permission: "denied" } }) }],
      structuredContent: { issues: { nodes: [rovoIssue()], webUrl: `${SITE}/issues`,
        pageInfo: { hasNextPage: false, endCursor: null } }, context: {} } },
    { ...rovoSearchResponse([rovoIssue()]), content: [{ type: "text", text: "[]" }] },
    rovoSearchResponse([rovoIssue({ self: `https://api.atlassian.com/ex/jira/wrong-cloud/rest/api/3/issue/10042` })]),
    rovoSearchResponse([rovoIssue({ self: `http://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/10042` })]),
    rovoSearchResponse([rovoIssue({ self: `https://api.atlassian.com:8443/ex/jira/${CLOUD}/rest/api/3/issue/10042` })]),
    rovoSearchResponse([rovoIssue({ self: `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/99999` })]),
    rovoSearchResponse([rovoIssue({ webUrl: "https://other.example/browse/RPL-42" })]),
    rovoSearchResponse([rovoIssue({ fields: { summary: SUMMARY, issuetype: { id: "10010" } } })]),
  ];
  for (const response of badSearchResponses) {
    let searchCalls = 0;
    const invalid = await connector(async () => { searchCalls += 1; return response; });
    assert.equal((await invalid.search(SEARCH_REQUEST)).status, "failed");
    assert.equal(searchCalls, 1, "Search must fail closed without retrying incomplete or conflicting evidence");
  }

  const emptySearch = await connector(async () => rovoSearchResponse([]));
  assert.deepEqual(await emptySearch.search(SEARCH_REQUEST), { status: "none", tool_call_count: 1 });

  const malformedStructuredSearch = await connector(async () => ({
    structuredContent: [], content: [{ type: "text", text: JSON.stringify({ issues: [rawRovoIssue(rovoIssue())] }) }],
  }));
  assert.deepEqual(await malformedStructuredSearch.search(SEARCH_REQUEST), { status: "failed", tool_call_count: 1 });

  const invalidGetResponses = [
    { content: [{ type: "text", text: JSON.stringify({ issues: [] }) }],
      structuredContent: { issues: { nodes: [] }, context: {} } },
    { content: [{ type: "text", text: JSON.stringify({ issues: [rawRovoIssue(rovoIssue()), rawRovoIssue(rovoIssue({ key: "RPL-43", id: "10043" }))] }) }],
      structuredContent: { issues: { nodes: [rovoIssue(), rovoIssue({ key: "RPL-43", id: "10043" })] }, context: {} } },
    { content: [{ type: "text", text: JSON.stringify(rawRovoIssue(rovoIssue())) }],
      structuredContent: { issues: { nodes: [rovoIssue()], pageInfo: { hasNextPage: true, endCursor: "next" } }, context: {} } },
    { content: [{ type: "text", text: JSON.stringify({ issues: [rawRovoIssue(rovoIssue())], total: 2 }) }],
      structuredContent: { issues: { nodes: [rovoIssue()] }, context: {} } },
    rovoGetResponse(rovoIssue({ self: `https://api.atlassian.com/ex/jira/wrong-cloud/rest/api/3/issue/10042` })),
    rovoGetResponse(rovoIssue({ self: `http://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/10042` })),
    rovoGetResponse(rovoIssue({ self: `https://api.atlassian.com:8443/ex/jira/${CLOUD}/rest/api/3/issue/10042` })),
    rovoGetResponse(rovoIssue({ self: `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/99999` })),
    rovoGetResponse(rovoIssue({ webUrl: "https://other.example/browse/RPL-42" })),
    rovoGetResponse(rovoIssue({ fields: { summary: SUMMARY, issuetype: { id: "10010" } } })),
    rovoGetResponse(rovoIssue(), { raw: rawRovoIssue(rovoIssue({ id: "10043", key: "RPL-43" })) }),
    { structuredContent: [], content: [{ type: "text", text: JSON.stringify(rawRovoIssue(rovoIssue())) }] },
    { ...rovoGetResponse(rovoIssue()), content: [{ type: "text", text: "[]" }] },
  ];
  for (const response of invalidGetResponses) {
    let readCalls = 0;
    const invalid = await connector(async () => { readCalls += 1; return response; });
    await assert.rejects(invalid.read({ key: "RPL-42", fields: ["issuetype"] }),
      error => error.code === "JIRA_CONNECTOR_ERROR" && error.tool_call_count === 1);
    assert.equal(readCalls, 1);
  }

  const apiOnlyGet = await connector(async () => ({ content: [{ type: "text", text: JSON.stringify(rawRovoIssue(rovoIssue())) }] }));
  await assert.rejects(apiOnlyGet.read({ key: "RPL-42", fields: ["issuetype"] }),
    error => error.code === "JIRA_CONNECTOR_ERROR");

  const conflictNode = rovoIssue({ extraFields: { customfield_10108: { id: "101" } } });
  const conflictRaw = rawRovoIssue({ ...conflictNode,
    fields: { ...conflictNode.fields, customfield_10108: { id: "999" } } });
  const conflictingRequestedField = await connector(async () => rovoGetResponse(conflictNode, { raw: conflictRaw }));
  await assert.rejects(conflictingRequestedField.read({ key: "RPL-42", fields: ["issuetype", "customfield_10108"] }),
    error => error.code === "JIRA_CONNECTOR_ERROR");

  const apiCreate = await connector(async () => rovoGetResponse(rovoIssue({ summary: CREATE_REQUEST.summary })));
  assert.equal((await apiCreate.create(CREATE_REQUEST, CREATE_GATE_PROOF)).url, `${SITE}/browse/RPL-42`);
  for (const issue of [
    rovoIssue({ summary: CREATE_REQUEST.summary, self: `https://api.atlassian.com/ex/jira/wrong-cloud/rest/api/3/issue/10042` }),
    rovoIssue({ summary: CREATE_REQUEST.summary, self: `http://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/10042` }),
    rovoIssue({ summary: CREATE_REQUEST.summary, self: `https://api.atlassian.com:8443/ex/jira/${CLOUD}/rest/api/3/issue/10042` }),
    rovoIssue({ summary: CREATE_REQUEST.summary, self: `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/99999` }),
    rovoIssue({ summary: CREATE_REQUEST.summary, webUrl: "https://other.example/browse/RPL-42" }),
    rovoIssue({ summary: CREATE_REQUEST.summary, url: "" }),
    rovoIssue({ summary: CREATE_REQUEST.summary, fields: { summary: CREATE_REQUEST.summary, issuetype: { id: "10010" } } }),
    rovoIssue({ summary: CREATE_REQUEST.summary, webUrl: null }),
  ]) {
    let createCalls = 0;
    const invalid = await connector(async () => { createCalls += 1; return rovoGetResponse(issue); });
    await assert.rejects(invalid.create(CREATE_REQUEST, CREATE_GATE_PROOF), error => {
      assert.equal(error.code, "JIRA_CREATE_POSSIBLY_APPLIED");
      assert.equal(error.mutation_status, "possibly_applied");
      assert.equal(error.automatic_retry, false);
      return true;
    });
    assert.equal(createCalls, 1, "ambiguous Create results must not be retried");
  }
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

  const structuredError = await connector(async () => {
    calls += 1;
    return { structuredContent: { issues: [], total: 0, errorMessages: [], errors: { permission: "denied" } } };
  });
  assert.deepEqual(await structuredError.search(SEARCH_REQUEST), { status: "failed", tool_call_count: 1 });
  assert.equal(calls, 5);

  const timeout = await connector(async () => { calls += 1; throw new Error("synthetic timeout"); });
  assert.deepEqual(await timeout.search(SEARCH_REQUEST), { status: "failed", tool_call_count: 1 });
  assert.equal(calls, 6);
}

async function createAmbiguityAndNoRetry() {
  let calls = 0;
  const timedOut = await connector(async () => { calls += 1; throw new Error("synthetic timeout"); });
  await assert.rejects(timedOut.create(CREATE_REQUEST, CREATE_GATE_PROOF), error => {
    assert.equal(error.code, "JIRA_CREATE_POSSIBLY_APPLIED");
    assert.equal(error.tool_call_count, 1);
    assert.equal(error.mutation_status, "possibly_applied");
    assert.equal(error.automatic_retry, false);
    return true;
  });
  assert.equal(calls, 1);

  const missingIdentity = await connector(async () => {
    calls += 1;
    return { structuredContent: { key: "RPL-42", id: "10042", self: `${SITE}/rest/api/3/issue/10042` } };
  });
  await assert.rejects(missingIdentity.create(CREATE_REQUEST, CREATE_GATE_PROOF), error => {
    assert.equal(error.code, "JIRA_CREATE_POSSIBLY_APPLIED");
    assert.equal(error.tool_call_count, 1);
    assert.equal(error.mutation_status, "possibly_applied");
    return true;
  });
  assert.equal(calls, 2);

  const wrongSite = await connector(async () => {
    calls += 1;
    return { structuredContent: jiraIssue({ self: "https://other.example/rest/api/3/issue/10042" }) };
  });
  await assert.rejects(wrongSite.create(CREATE_REQUEST, CREATE_GATE_PROOF), error => error.code === "JIRA_CREATE_POSSIBLY_APPLIED");
  assert.equal(calls, 3);

  const mismatchedNumericId = await connector(async () => {
    calls += 1;
    return { structuredContent: jiraIssue({ self: `${SITE}/rest/api/3/issue/99999` }) };
  });
  await assert.rejects(mismatchedNumericId.create(CREATE_REQUEST, CREATE_GATE_PROOF), error => error.code === "JIRA_CREATE_POSSIBLY_APPLIED");
  assert.equal(calls, 4);

  const conflictingIdentities = await connector(async () => {
    calls += 1;
    return { structuredContent: jiraIssue({ url: "https://other.example/browse/RPL-42" }) };
  });
  await assert.rejects(conflictingIdentities.create(CREATE_REQUEST, CREATE_GATE_PROOF), error => error.code === "JIRA_CREATE_POSSIBLY_APPLIED");
  assert.equal(calls, 5);

  const credentialsOrQuery = await connector(async () => {
    calls += 1;
    return { structuredContent: jiraIssue({ url: `https://user@jira.example.test/browse/RPL-42?expand=fields` }) };
  });
  await assert.rejects(credentialsOrQuery.create(CREATE_REQUEST, CREATE_GATE_PROOF), error => error.code === "JIRA_CREATE_POSSIBLY_APPLIED");
  assert.equal(calls, 6);

  const wrongBrowseKey = await connector(async () => {
    calls += 1;
    return { structuredContent: jiraIssue({ url: `${SITE}/browse/RPL-43` }) };
  });
  await assert.rejects(wrongBrowseKey.create(CREATE_REQUEST, CREATE_GATE_PROOF), error => error.code === "JIRA_CREATE_POSSIBLY_APPLIED");
  assert.equal(calls, 7);

  const oldKeyPath = await connector(async () => {
    calls += 1;
    return { structuredContent: jiraIssue({ self: `${SITE}/rest/api/3/issue/RPL-42` }) };
  });
  assert.equal((await oldKeyPath.create(CREATE_REQUEST, CREATE_GATE_PROOF)).key, "RPL-42");
  assert.equal(calls, 8);

  const browsePath = await connector(async () => {
    calls += 1;
    return { structuredContent: jiraIssue({ self: `${SITE}/browse/RPL-42` }) };
  });
  assert.equal((await browsePath.create(CREATE_REQUEST, CREATE_GATE_PROOF)).key, "RPL-42");
  assert.equal(calls, 9);
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

async function supervisedWorkflowIntegration(rovoEnvelope = false) {
  const toolCalls = [];
  const jira = await connector(async (name, args) => {
    toolCalls.push({ name, args });
    if (name === G3_JIRA_TOOL_NAMES.search) return rovoEnvelope ? rovoSearchResponse([])
      : { structuredContent: { issues: [], total: 0 } };
    if (name === G3_JIRA_TOOL_NAMES.create) {
      const issue = {
      id: "10073", key: "RPL-73", self: `${SITE}/rest/api/3/issue/10073`,
      fields: { project: { key: args.projectKey }, issuetype: { id: "10010" }, summary: args.summary },
      };
      return rovoEnvelope ? rovoGetResponse(rovoIssue({ id: "10073", key: "RPL-73", summary: args.summary }))
        : { structuredContent: issue };
    }
    if (name === G3_JIRA_TOOL_NAMES.read) {
      const issue = {
      id: "10073", key: "RPL-73", self: `${SITE}/rest/api/3/issue/10073`,
      fields: { project: { key: "RPL" }, issuetype: { id: "10010" },
        customfield_10108: { id: "101" }, customfield_10109: { id: "202" }, customfield_10110: null },
      };
      return rovoEnvelope ? rovoGetResponse(rovoIssue({ id: "10073", key: "RPL-73", extraFields: {
        customfield_10108: { id: "101" }, customfield_10109: { id: "202" }, customfield_10110: null,
      } })) : { structuredContent: issue };
    }
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
      ...(stage === "intent" ? { cutover_approval_ref: "synthetic:approval",
        issue_type_binding: { canonical_issue_type: "Task", issue_type_id: "10010",
          localized_issue_type_name: "작업", metadata_sha256: "b".repeat(64) } } : {}),
      ...(stage === "create" ? { issue_type_binding: { canonical_issue_type: "Task",
        issue_type_id: "10010", localized_issue_type_name: "작업", metadata_sha256: "b".repeat(64) } } : {}) }),
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
await verifiedIssueTypeBindingRequired();
await explicitReporterRejectedBeforeCreateTool();
await optionalCreateWrappersAndCanonicalCloudId();
await rovoEnvelopeCompatibility();
await searchFailuresAndPagination();
await createAmbiguityAndNoRetry();
await authScopeAndGetValidation();
await supervisedWorkflowIntegration();
await supervisedWorkflowIntegration(true);
process.stdout.write("Synthetic G3 Jira connector checks passed.\n");
