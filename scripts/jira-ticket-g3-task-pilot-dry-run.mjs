#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildG3JiraCreateToolPayload } from "./lib/jira-ticket-g3-create-payload.mjs";
import { inspectG3TaskPilotDryRunRequest } from "./lib/jira-ticket-g3-trusted-gate.mjs";
import {
  buildJiraTicketCreateRequest,
  CONTRACT_FIELDS,
  isValidJiraTicketContract,
  isValidJiraTicketWorkflowText,
}
  from "./lib/jira-ticket-create-workflow.mjs";

const TARGET_FIELDS = {
  product: "customfield_10108", component: "customfield_10109", concern: "customfield_10110",
};
const TASK_KEYS = ["workflow_metadata", "contract", "selection", "start_date", "due_date"];
const WORKFLOW_METADATA_KEYS = ["project", "issue_type", "assignee", "priority", "product",
  "repository", "area", "branch", "pr", "current_head"];

function assertSafeJson(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJson(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error(`unsupported JSON object at ${path}`);
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error(`unsafe JSON property at ${path}.${key}`);
    assertSafeJson(child, `${path}.${key}`);
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new Error(`unsupported ${label} field: ${unknown}`);
}

function requireText(value, label) {
  if (!isValidJiraTicketWorkflowText(value)) throw new Error(`${label} is required or unresolved`);
}

function validateSelection(value, fieldId, fields, label) {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("|") !== "id|value"
    || typeof value.id !== "string" || !/^\d+$/.test(value.id)
    || typeof value.value !== "string" || !value.value.trim())
    throw new Error(`invalid ${label} option selection`);
  const field = fields.get(fieldId);
  if (!Array.isArray(field?.allowedValues)
    || !field.allowedValues.some(option => option?.id === value.id && option?.value === value.value))
    throw new Error(`${label} option ID/value is absent from current Jira metadata`);
}

function createCoreRequest(input) {
  if (!isPlainRecord(input)) throw new Error("Task Pilot input must be a JSON object");
  if (Object.hasOwn(input, "reporter")) throw new Error("Task Pilot input cannot specify reporter");
  assertOnlyKeys(input, ["metadata", "task"], "input");
  const { metadata, task } = input;
  if (!isPlainRecord(metadata) || !isPlainRecord(task))
    throw new Error("Task Pilot metadata and task must be JSON objects");
  if (Object.hasOwn(task, "reporter")) throw new Error("Task Pilot input cannot specify reporter");
  if (Object.hasOwn(task, "customfield_10045"))
    throw new Error("Task Pilot cannot provide customfield_10045; use only the signed Jira default");
  assertOnlyKeys(task, TASK_KEYS, "Task Pilot");

  const workflowMetadata = task.workflow_metadata;
  const contract = task.contract;
  const selection = task.selection;
  if (!isPlainRecord(workflowMetadata) || !isPlainRecord(contract) || !isPlainRecord(selection))
    throw new Error("Task Pilot requires workflow metadata, Ticket Contract, and Target selection objects");
  assertOnlyKeys(workflowMetadata, WORKFLOW_METADATA_KEYS, "workflow metadata");
  assertOnlyKeys(contract, CONTRACT_FIELDS, "Ticket Contract");
  assertOnlyKeys(selection, ["product", "component", "concerns"], "Target selection");
  if (Object.keys(contract).length !== CONTRACT_FIELDS.length || !isValidJiraTicketContract(contract))
    throw new Error("Task Pilot requires a complete, non-placeholder 14-field Ticket Contract");
  for (const [key, label] of [["project", "Project"], ["issue_type", "Issue Type"],
    ["assignee", "Assignee"], ["priority", "Priority"], ["product", "Product"],
    ["repository", "Primary Repository"], ["area", "Area"]])
    requireText(workflowMetadata[key], label);
  if (workflowMetadata.project !== "RPL" || workflowMetadata.issue_type !== "Task")
    throw new Error("Task Pilot supports only RPL Task Create");
  for (const key of ["branch", "pr", "current_head"])
    if (workflowMetadata[key] != null && typeof workflowMetadata[key] !== "string")
      throw new Error(`workflow metadata ${key} must be text when supplied`);

  const rows = metadata?.fields;
  if (!Array.isArray(rows)) throw new Error("Jira Task Metadata fields must be the complete field list");
  const fields = new Map();
  for (const row of rows) {
    if (!isPlainRecord(row) || typeof row.fieldId !== "string" || !row.fieldId.trim() || fields.has(row.fieldId))
      throw new Error("Jira Task Metadata has a missing or duplicate fieldId");
    fields.set(row.fieldId, row);
  }
  validateSelection(selection.product, TARGET_FIELDS.product, fields, "Product");
  validateSelection(selection.component, TARGET_FIELDS.component, fields, "Component");
  if (!Array.isArray(selection.concerns) || selection.concerns.length > 3)
    throw new Error("Task concerns must be an array of zero to three allowed options");
  const concernIds = new Set();
  for (const concern of selection.concerns) {
    validateSelection(concern, TARGET_FIELDS.concern, fields, "Concern");
    if (concernIds.has(concern.id)) throw new Error("Task concerns cannot contain duplicate options");
    concernIds.add(concern.id);
  }

  const snapshot = {
    project: workflowMetadata.project,
    issue_type: workflowMetadata.issue_type,
    contract,
    assignee: workflowMetadata.assignee,
    priority: workflowMetadata.priority,
    product: workflowMetadata.product,
    primary_repository: workflowMetadata.repository,
    area: workflowMetadata.area,
    branch: workflowMetadata.branch ?? null,
    pr: workflowMetadata.pr ?? null,
    current_head: workflowMetadata.current_head ?? null,
    target_create: {
      selection,
      supplemental_fields: { customfield_10015: task.start_date, duedate: task.due_date },
    },
  };
  const request = buildJiraTicketCreateRequest(snapshot);
  const { issue_type_name } = inspectG3TaskPilotDryRunRequest({ metadata, request });
  return { request, issue_type_name, concerns: selection.concerns };
}

function blockedReport(reason) {
  return {
    status: "BLOCKED",
    execution_authorized: false,
    owner_approval_verified: false,
    policy_signature_verified: false,
    metadata_signature_verified: false,
    jira_call_count: 0,
    create_call_count: 0,
    reason,
  };
}

/** Produce a preview from caller-supplied JSON; this never creates a Jira client. */
export function createG3TaskPilotDryRunReport(input) {
  try {
    assertSafeJson(input);
    const { request, issue_type_name, concerns } = createCoreRequest(input);
    return {
      status: "PREVIEW_ONLY",
      execution_authorized: false,
      owner_approval_verified: false,
      policy_signature_verified: false,
      metadata_signature_verified: false,
      jira_call_count: 0,
      create_call_count: 0,
      create_request: request,
      jira_create_tool_payload_without_runtime_identity:
        buildG3JiraCreateToolPayload(request, issue_type_name),
      requested_concerns: concerns.map(({ id, value }) => ({ id, value })),
      omitted_fields: ["reporter", "assignee", "priority", "labels", "customfield_10045"],
      note: "Caller-supplied metadata is unverified. Cloud ID and authenticated Runtime proof are intentionally omitted; this preview does not authorize Create.",
    };
  } catch (error) {
    return blockedReport(error instanceof Error ? error.message : "Task Pilot preflight failed");
  }
}

/** CLI runner is injectable for fixture tests and performs only a local file read. */
export async function runG3TaskPilotDryRunCli(argv = process.argv.slice(2), {
  readInput = readFile, writeOutput = value => process.stdout.write(value),
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 1) {
    writeOutput(`${JSON.stringify(blockedReport("provide exactly one local JSON input file"), null, 2)}\n`);
    return 2;
  }
  let input;
  try {
    input = JSON.parse(await readInput(resolve(argv[0]), "utf8"));
  } catch {
    writeOutput(`${JSON.stringify(blockedReport("input file could not be read as valid JSON"), null, 2)}\n`);
    return 1;
  }
  const report = createG3TaskPilotDryRunReport(input);
  writeOutput(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === "PREVIEW_ONLY" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runG3TaskPilotDryRunCli();
