import assert from "node:assert/strict";
import {
  CONTRACT_FIELDS,
  buildJiraTicketCreateRequest,
} from "./lib/jira-ticket-create-workflow.mjs";
import {
  createG3TaskPilotDryRunReport,
  runG3TaskPilotDryRunCli,
} from "./jira-ticket-g3-task-pilot-dry-run.mjs";

const row = (fieldId, required, hasDefaultValue, schema, extra = {}) =>
  ({ fieldId, required, hasDefaultValue, ...(schema ? { schema } : {}), ...extra });
const optionField = (fieldId, id, value) => row(fieldId, true, false,
  { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
  { allowedValues: [{ id, value }] });

const fields = [
  row("project", true, false, { type: "project" }, { allowedValues: [{ id: "10000", key: "RPL" }] }),
  row("issuetype", false, false, { type: "issuetype" }, { allowedValues: [{ id: "10010", name: "작업" }] }),
  row("summary", true, false, { type: "string" }),
  row("description", false, false, { type: "string" }),
  // Jira's live Task metadata allows its server-side reporter default only when omitted.
  row("reporter", true, true, { type: "user" }),
  ...[
    ["attachment", { type: "array", items: "attachment" }],
    ["customfield_10000", { type: "any" }],
    ["customfield_10019", { type: "any" }],
    ["customfield_10021", { type: "array", items: "option" }],
    ["customfield_10037", { type: "any" }],
    ["fixVersions", { type: "array", items: "version" }],
    ["issuelinks", { type: "array", items: "issuelinks" }],
    ["parent", { type: "issuelink" }],
  ].map(([fieldId, schema]) => row(fieldId, false, false, schema)),
  ...["customfield_10042", "customfield_10043", "customfield_10044"]
    .map(fieldId => row(fieldId, false, false, { type: "option" })),
  row("customfield_10015", true, false, { type: "date" }),
  row("duedate", true, false, { type: "date" }),
  row("customfield_10045", true, true, { type: "array", items: "user" },
    { defaultValue: [{ accountId: "fixture-default-account", active: true }] }),
  optionField("customfield_10108", "10027", "dev-harness"),
  optionField("customfield_10109", "10028", "backend"),
  row("customfield_10110", false, false,
    { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" },
    { allowedValues: [{ id: "10038", value: "integration" }] }),
];

const contract = () => Object.fromEntries(CONTRACT_FIELDS.map(field => [
  field,
  field === "Summary" ? "Offline Task Pilot preview" : `Synthetic ${field} for local preview only`,
]));

const validInput = () => ({
  metadata: {
    project: "RPL", issue_type: "Task", issue_type_id: "10010",
    startAt: 0, maxResults: 100, total: 22, fields: structuredClone(fields),
  },
  task: {
    workflow_metadata: {
      project: "RPL", issue_type: "Task", assignee: "Logical Owner", priority: "High",
      product: "Dev Harness", repository: "ranikun-labs/oh-my-ai", area: "Jira Migration",
      branch: "feat/jira-g3-integration-offline-20261022", pr: "#84",
      current_head: "6704c37526eedfa958c94e6dd7873a7515815c29",
    },
    contract: contract(),
    selection: {
      product: { id: "10027", value: "dev-harness" },
      component: { id: "10028", value: "backend" },
      concerns: [],
    },
    start_date: "2026-11-02",
    due_date: "2026-11-10",
  },
});

function expectedCoreRequest(input) {
  const { workflow_metadata: metadata, contract: ticket, selection } = input.task;
  return buildJiraTicketCreateRequest({
    project: metadata.project,
    issue_type: metadata.issue_type,
    contract: ticket,
    assignee: metadata.assignee,
    priority: metadata.priority,
    product: metadata.product,
    primary_repository: metadata.repository,
    area: metadata.area,
    branch: metadata.branch ?? null,
    pr: metadata.pr ?? null,
    current_head: metadata.current_head ?? null,
    target_create: {
      selection,
      supplemental_fields: {
        customfield_10015: input.task.start_date,
        duedate: input.task.due_date,
      },
    },
  });
}

function expectBlocked(input, pattern) {
  const report = createG3TaskPilotDryRunReport(input);
  assert.equal(report.status, "BLOCKED", JSON.stringify(report));
  assert.equal(report.execution_authorized, false);
  assert.equal(report.jira_call_count, 0);
  assert.equal(report.create_call_count, 0);
  if (pattern) assert.match(report.reason, pattern);
  return report;
}

const input = validInput();
const report = createG3TaskPilotDryRunReport(input);
assert.equal(report.status, "PREVIEW_ONLY", JSON.stringify(report));
assert.equal(report.execution_authorized, false);
assert.equal(report.owner_approval_verified, false);
assert.equal(report.policy_signature_verified, false);
assert.equal(report.metadata_signature_verified, false);
assert.equal(report.jira_call_count, 0);
assert.equal(report.create_call_count, 0);
assert.deepEqual(report.requested_concerns, []);
assert.deepEqual(report.create_request, expectedCoreRequest(input),
  "preview must use the same Core builder as the actual workflow request");
assert.equal(report.create_request.summary, input.task.contract.Summary);
assert.match(report.create_request.description, /^Product: Dev Harness\nPrimary Repository: ranikun-labs\/oh-my-ai/);
for (const field of CONTRACT_FIELDS)
  assert.ok(report.create_request.description.includes(`## ${field}\n${input.task.contract[field]}`));
assert.deepEqual(report.create_request.fields, {
  customfield_10108: { id: "10027" },
  customfield_10109: { id: "10028" },
  customfield_10015: "2026-11-02",
  duedate: "2026-11-10",
});
assert.equal(Object.hasOwn(report.create_request, "reporter"), false);
assert.equal(Object.hasOwn(report.create_request, "assignee"), false);
assert.equal(Object.hasOwn(report.create_request, "priority"), false);
assert.equal(Object.hasOwn(report.create_request, "labels"), false);
assert.deepEqual(report.jira_create_tool_payload_without_runtime_identity, {
  projectKey: "RPL", issueTypeName: "작업", summary: report.create_request.summary,
  description: report.create_request.description, additional_fields: report.create_request.fields,
});
assert.doesNotMatch(JSON.stringify(report), /fixture-default-account/,
  "the Jira people default must never be copied to preview output");

const missingSummary = validInput();
missingSummary.task.contract.Summary = "";
expectBlocked(missingSummary, /required|placeholder|Summary/i);
const missingContractBody = validInput();
missingContractBody.task.contract.Context = "";
expectBlocked(missingContractBody, /14-field Ticket Contract/i);
for (const missing of ["start_date", "due_date"]) {
  const invalid = validInput();
  invalid.task[missing] = "";
  expectBlocked(invalid, /required|missing|date/i);
}
const invalidDate = validInput();
invalidDate.task.start_date = "2026-02-30";
expectBlocked(invalidDate, /date/i);

const invalidProduct = validInput();
invalidProduct.task.selection.product = { id: "99999", value: "dev-harness" };
expectBlocked(invalidProduct, /Product option ID\/value/i);
const staleProductLabel = validInput();
staleProductLabel.task.selection.product = { id: "10027", value: "another-product" };
expectBlocked(staleProductLabel, /Product option ID\/value/i);
const alternateProductLabel = validInput();
alternateProductLabel.metadata.fields.find(value => value.fieldId === "customfield_10108").allowedValues = [
  { id: "10027", name: "dev-harness" },
];
expectBlocked(alternateProductLabel, /Product option ID\/value/i);
const invalidConcern = validInput();
invalidConcern.task.selection.concerns = [{ id: "99999", value: "unknown" }];
expectBlocked(invalidConcern, /Concern option ID\/value/i);
const unresolvedAssignee = validInput();
unresolvedAssignee.task.workflow_metadata.assignee = "Decision Required";
expectBlocked(unresolvedAssignee, /Assignee is required or unresolved/i);

const explicitReporter = validInput();
explicitReporter.task.reporter = null;
expectBlocked(explicitReporter, /cannot specify reporter/i);
const topLevelReporter = validInput();
topLevelReporter.reporter = null;
expectBlocked(topLevelReporter, /cannot specify reporter/i);
const arbitraryPeople = validInput();
arbitraryPeople.task.customfield_10045 = [{ accountId: "invented-account" }];
expectBlocked(arbitraryPeople, /cannot provide customfield_10045/i);
for (const forbidden of ["assignee", "priority", "labels", "description"]) {
  const invalid = validInput();
  invalid.task[forbidden] = forbidden === "labels" ? [] : "invented";
  expectBlocked(invalid, new RegExp(`unsupported Task Pilot field: ${forbidden}`));
}

const incompletePage = validInput();
incompletePage.metadata.fields.pop();
incompletePage.metadata.total = 21;
expectBlocked(incompletePage, /22-field page/i);
const inconsistentPage = validInput();
inconsistentPage.metadata.total = 21;
expectBlocked(inconsistentPage, /incomplete or has inconsistent pagination/i);
const nullReporterDefault = validInput();
nullReporterDefault.metadata.fields.find(value => value.fieldId === "reporter").defaultValue = null;
expectBlocked(nullReporterDefault, /default value is missing despite hasDefaultValue for reporter/i);
const unexpectedProductDefault = validInput();
unexpectedProductDefault.metadata.fields.find(value => value.fieldId === "customfield_10108").defaultValue = { id: "10027" };
expectBlocked(unexpectedProductDefault, /Target Product\/Component\/Concern metadata/i);
const missingConcernOptions = validInput();
delete missingConcernOptions.metadata.fields.find(value => value.fieldId === "customfield_10110").allowedValues;
expectBlocked(missingConcernOptions, /Target Product\/Component\/Concern metadata/i);
const missingPeopleDefault = validInput();
delete missingPeopleDefault.metadata.fields.find(value => value.fieldId === "customfield_10045").defaultValue;
expectBlocked(missingPeopleDefault, /live Jira default value is missing/i);

const unsafeJson = validInput();
Object.defineProperty(unsafeJson.task, "__proto__", { value: { polluted: true }, enumerable: true });
expectBlocked(unsafeJson, /unsafe JSON property/i);

let cliOutput = "";
const cliStatus = await runG3TaskPilotDryRunCli(["task-pilot.json"], {
  readInput: async () => JSON.stringify(validInput()),
  writeOutput: value => { cliOutput += value; },
});
assert.equal(cliStatus, 0);
assert.equal(JSON.parse(cliOutput).status, "PREVIEW_ONLY");
cliOutput = "";
const badInputCliStatus = await runG3TaskPilotDryRunCli(["task-pilot.json"], {
  readInput: async () => "not JSON",
  writeOutput: value => { cliOutput += value; },
});
assert.equal(badInputCliStatus, 1);
assert.equal(JSON.parse(cliOutput).status, "BLOCKED");
assert.equal(JSON.parse(cliOutput).jira_call_count, 0);

console.log("PASS: Task Pilot preview shares the Core Create request and validates the 22-field metadata shape");
console.log("PASS: missing values, stale options, explicit reporter/people, metadata gaps and unsafe JSON block with zero Jira calls");
