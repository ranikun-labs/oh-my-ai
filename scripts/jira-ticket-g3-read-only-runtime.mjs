#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createG3ReadOnlyJiraConnector, G3_JIRA_TOOL_NAMES } from "./lib/jira-ticket-g3-jira-connector.mjs";

const ISSUE_KEY = /^RPL-[1-9][0-9]*$/;
const CAPABILITIES = ["jira.read", "jira.search"];
const READ_FIELDS = ["issuetype", "status", "summary"];

function blocked(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function expectedJql(summary) {
  if (/[\u0000-\u001f\u007f]/.test(summary)) throw blocked("INVALID_SEARCH_SUMMARY");
  const escaped = summary.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `project = RPL AND summary ~ "\\"${escaped}\\""`;
}

function normalizeSummary(summary) {
  return summary.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function validateRuntime(runtime) {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)
    || typeof runtime.siteOrigin !== "string" || typeof runtime.cloudId !== "string"
    || typeof runtime.session?.id !== "string" || !runtime.session.id.trim()
    || typeof runtime.invokeTool !== "function" || typeof runtime.verifySession !== "function")
    throw blocked("RUNTIME_BRIDGE_INVALID");
}

/**
 * Execute only a Search and GET through a trusted host-provided runtime bridge.
 * The bridge must validate the real authenticated session; this module never
 * turns an MCP account/session identifier into G3 capability evidence itself.
 */
export async function runG3ReadOnlyRuntimeSmoke({ runtime, issueKey, searchSummary } = {}) {
  validateRuntime(runtime);
  if (!ISSUE_KEY.test(issueKey ?? "") || typeof searchSummary !== "string" || !searchSummary.trim())
    throw blocked("INVALID_SMOKE_TARGET");
  const jql = expectedJql(searchSummary.trim());
  let searchCalls = 0, readCalls = 0;

  const invokeTool = async (name, args) => {
    if (name === G3_JIRA_TOOL_NAMES.search) {
      if (args?.cloudId !== runtime.cloudId || args.jql !== jql
        || JSON.stringify(args.fields) !== JSON.stringify(["summary", "project", "issuetype"])
        || args.maxResults !== 100 || args.searchResultMode !== "issues")
        throw blocked("SEARCH_SCOPE_MISMATCH");
      searchCalls += 1;
    } else if (name === G3_JIRA_TOOL_NAMES.read) {
      if (args?.cloudId !== runtime.cloudId || args.issueIdOrKey !== issueKey
        || args.updateHistory !== false
        || JSON.stringify(args.fields) !== JSON.stringify(["project", ...READ_FIELDS]))
        throw blocked("READ_SCOPE_MISMATCH");
      readCalls += 1;
    } else {
      throw blocked("TOOL_NOT_ALLOWED");
    }
    try {
      return await runtime.invokeTool(name, structuredClone(args));
    } catch {
      throw blocked(name === G3_JIRA_TOOL_NAMES.search ? "JIRA_SEARCH_FAILED" : "JIRA_GET_FAILED");
    }
  };

  const verifySession = async proofRequest => {
    if (proofRequest?.session !== runtime.session || proofRequest.siteOrigin !== runtime.siteOrigin
      || proofRequest.cloudId !== runtime.cloudId || !CAPABILITIES.includes(proofRequest.capability))
      throw blocked("SESSION_SCOPE_MISMATCH");
    try { return await runtime.verifySession(proofRequest); }
    catch { throw blocked("SESSION_VERIFICATION_FAILED"); }
  };

  let jira;
  try {
    jira = await createG3ReadOnlyJiraConnector({
      invokeTool, verifySession, session: runtime.session,
      siteOrigin: runtime.siteOrigin, cloudId: runtime.cloudId,
    });
  } catch {
    throw blocked("READ_ONLY_CAPABILITY_UNVERIFIED");
  }
  if (Object.hasOwn(jira, "create") || Object.getPrototypeOf(jira) !== null
    || Object.keys(jira.capabilities).sort().join("|") !== CAPABILITIES.join("|"))
    throw blocked("READ_ONLY_BOUNDARY_INVALID");

  let search;
  try {
    search = await jira.search({ project: "RPL", summary_keywords: searchSummary.trim() });
  } catch { throw blocked("JIRA_SEARCH_FAILED"); }
  if (search.status !== "exact_duplicate" || search.issue?.key !== issueKey
    || search.tool_call_count !== 1 || searchCalls !== 1)
    throw blocked("JIRA_SEARCH_RESULT_MISMATCH");

  let issue;
  try { issue = await jira.read({ key: issueKey, fields: READ_FIELDS }); }
  catch { throw blocked("JIRA_GET_FAILED"); }
  if (issue?.key !== issueKey || issue.tool_call_count !== 1 || readCalls !== 1
    || !/^\d+$/.test(issue.issue_type_id ?? "")
    || typeof issue.fields?.summary !== "string"
    || normalizeSummary(issue.fields.summary) !== normalizeSummary(searchSummary))
    throw blocked("JIRA_GET_RESULT_MISMATCH");

  return Object.freeze({
    status: "READ_ONLY_CONNECTOR_SMOKE_PASSED",
    site_origin: runtime.siteOrigin,
    cloud_id_fingerprint: createHash("sha256").update(runtime.cloudId).digest("hex").slice(0, 12),
    issue_key: issueKey,
    accepted_capability_proofs: CAPABILITIES,
    search: "PASS",
    get: "PASS",
    runner_tool_calls: { search: searchCalls, get: readCalls, create: 0 },
    raw_response_logged_by_runner: false,
  });
}

function parseArgs(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help") return { help: true };
    if (!["--runtime-module", "--issue", "--summary"].includes(key)
      || options[key] !== undefined || typeof argv[index + 1] !== "string" || argv[index + 1].startsWith("--"))
      throw blocked("INVALID_ARGUMENTS");
    options[key] = argv[++index];
  }
  if (!options["--runtime-module"] || !options["--issue"] || !options["--summary"])
    throw blocked("RUNTIME_BRIDGE_REQUIRED");
  return { runtimeModule: options["--runtime-module"], issueKey: options["--issue"],
    searchSummary: options["--summary"] };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write("Usage: node scripts/jira-ticket-g3-read-only-runtime.mjs --runtime-module <trusted-module> --issue <RPL-key> --summary <exact-summary>\n");
    return;
  }
  const moduleUrl = pathToFileURL(resolve(options.runtimeModule)).href;
  let bridgeModule;
  try { bridgeModule = await import(moduleUrl); }
  catch { throw blocked("RUNTIME_BRIDGE_UNAVAILABLE"); }
  const createRuntime = bridgeModule.createG3ReadOnlyRuntime ?? bridgeModule.default;
  if (typeof createRuntime !== "function") throw blocked("RUNTIME_BRIDGE_INVALID");
  let runtime;
  try { runtime = await createRuntime(); }
  catch { throw blocked("RUNTIME_BRIDGE_UNAVAILABLE"); }
  const report = await runG3ReadOnlyRuntimeSmoke({ ...options, runtime });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${JSON.stringify({ status: "BLOCKED", code: error?.code ?? "RUNTIME_FAILED" })}\n`);
    process.exitCode = 2;
  });
}
