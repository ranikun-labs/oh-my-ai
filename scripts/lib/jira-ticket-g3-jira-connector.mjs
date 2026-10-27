const TOOL = Object.freeze({
  search: "mcp__codex_apps__atlassian_rovo__legacy__atlassian_rovo_legacy_searchjiraissuesusingjql",
  create: "mcp__codex_apps__atlassian_rovo__legacy__atlassian_rovo_legacy_createjiraissue",
  read: "mcp__codex_apps__atlassian_rovo__legacy__atlassian_rovo_legacy_getjiraissue",
});

const ISSUE_KEY = /^RPL-[1-9][0-9]*$/;
const ISSUE_TYPE_IDS = new Map([
  ["Task", "10010"], ["작업", "10010"], ["Epic", "10007"], ["에픽", "10007"],
  ["Feature", "10009"], ["기능", "10009"], ["Bug", "10012"], ["버그", "10012"],
  ["Research", "10013"],
]);
const CAPABILITY = Object.freeze({ search: "jira.search", create: "jira.create", read: "jira.read" });
const DEFAULT_MAX_PROOF_AGE_MS = 5 * 60 * 1000;
const APPROVED_CREATE_FIELD_NAMES = new Set([
  "customfield_10108", "customfield_10109", "customfield_10110",
  "customfield_10015", "customfield_10045", "duedate",
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}

function assertOrigin(value) {
  if (!validOrigin(value)) throw new Error("Jira siteOrigin must be a canonical HTTPS origin");
}

function siteCloudId(value, siteOrigin) {
  if (!nonEmpty(value)) return false;
  if (/^https:\/\//i.test(value)) {
    try { return new URL(value).origin === siteOrigin; } catch { return false; }
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasSiteIdentity(issue, siteOrigin, key, cloudId) {
  // Rovo returns Jira's cloud-scoped API self URL plus a browser URL. Bind both
  // the API cloud/issue id and browser site/key before accepting that shape.
  if (typeof issue?.self === "string") {
    try {
      const self = new URL(issue.self);
      if (self.hostname === "api.atlassian.com" && self.pathname.startsWith("/ex/jira/")) {
        const match = /^\/ex\/jira\/([^/]+)\/rest\/api\/3\/issue\/([1-9][0-9]*)$/.exec(self.pathname);
        const id = String(issue.id ?? "");
        const browserUrl = `${siteOrigin}/browse/${key}`;
        return Boolean(self.origin === "https://api.atlassian.com" && match && match[1] === cloudId
          && match[2] === id && issue.key === key
          && ISSUE_KEY.test(key ?? "") && issue.webUrl === `${siteOrigin}/browse/${key}`
          && !self.username && !self.password && !self.search && !self.hash
          && (issue.url == null || issue.url === browserUrl)
          && (issue.browse_url == null || issue.browse_url === browserUrl));
      }
    } catch { return false; }
  }
  const supplied = [issue?.self, issue?.url, issue?.browse_url].filter(value => value !== undefined && value !== null);
  if (!supplied.length || (issue.id !== undefined && !/^\d+$/.test(issue.id ?? ""))) return false;
  if (issue.webUrl != null && issue.webUrl !== `${siteOrigin}/browse/${key}`) return false;
  return supplied.every(value => {
    if (!nonEmpty(value)) return false;
    try {
      const url = new URL(value);
      if (url.origin !== siteOrigin || url.username || url.password || url.href.includes("?") || url.href.includes("#")) return false;
      if (url.pathname === `/browse/${key}`) return true;
      if (url.pathname === `/rest/api/2/issue/${key}` || url.pathname === `/rest/api/3/issue/${key}`) return true;
      return nonEmpty(issue.id) && (url.pathname === `/rest/api/2/issue/${issue.id}`
        || url.pathname === `/rest/api/3/issue/${issue.id}`);
    } catch { return false; }
  });
}

function nonEmptyError(value) {
  if (value == null || value === false || value === "" || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function hasSemanticError(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return true;
  return data.isError === true || nonEmptyError(data.error)
    || nonEmptyError(data.errors) || nonEmptyError(data.errorMessages);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedTextPayloads(result) {
  const parsed = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const value = JSON.parse(item.text);
      parsed.push(value);
    } catch {
      if (/^[\[{]/.test(item.text.trim())) return null;
      /* MCP may include explanatory text alongside JSON. */
    }
  }
  return parsed;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sameRovoIssueEvidence(raw, node, expectedFields) {
  if (!isRecord(raw) || !isRecord(node) || String(raw.id ?? "") !== String(node.id ?? "")
    || raw.key !== node.key || raw.self !== node.self) return false;
  for (const name of expectedFields) {
    if (!isRecord(raw.fields) || !isRecord(node.fields)
      || !Object.hasOwn(raw.fields, name) || !Object.hasOwn(node.fields, name)
      || stableJson(raw.fields[name]) !== stableJson(node.fields[name])) return false;
  }
  return raw.webUrl === undefined || raw.webUrl === node.webUrl;
}

function rovoRawIssues(payload) {
  if (!isRecord(payload)) return null;
  if (Array.isArray(payload.issues)) return payload.issues;
  if (isRecord(payload.issues) && Array.isArray(payload.issues.nodes)) return payload.issues.nodes;
  if (typeof payload.key === "string") return [payload];
  return null;
}

function validRovoEnvelope(result, data, expectedFields) {
  const wrapper = data?.issues;
  if (!isRecord(wrapper) || !Array.isArray(wrapper.nodes)) return true;
  const nodes = wrapper.nodes;
  if (nodes.some(node => !isRecord(node))) return false;
  if (Object.hasOwn(wrapper, "pageInfo")) {
    const pageInfo = wrapper.pageInfo;
    if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean" || pageInfo.hasNextPage
      || !Object.hasOwn(pageInfo, "endCursor")
      || (pageInfo.endCursor !== null && !nonEmpty(pageInfo.endCursor))) return false;
  }
  const payloads = parsedTextPayloads(result);
  if (!payloads || payloads.length > 1) return false;
  if (!payloads.length) return true;
  const raw = payloads[0];
  if (!isRecord(raw) || hasSemanticError(raw)) return false;
  const rawIssues = rovoRawIssues(raw);
  if (!rawIssues || rawIssues.length !== nodes.length
    || !rawIssues.every((issue, index) => sameRovoIssueEvidence(issue, nodes[index], expectedFields))) return false;
  if (Object.hasOwn(raw, "isLast")
    && (typeof raw.isLast !== "boolean" || !isRecord(wrapper.pageInfo)
      || raw.isLast === wrapper.pageInfo.hasNextPage)) return false;
  if (raw.nextPageToken != null && raw.nextPageToken !== ""
    && (!isRecord(wrapper.pageInfo) || wrapper.pageInfo.hasNextPage !== true)) return false;
  if (Object.hasOwn(raw, "total") && (!Number.isSafeInteger(raw.total) || raw.total !== nodes.length)) return false;
  return true;
}

function responseObject(result, expectedFields = []) {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.isError === true) return null;
  if (result.structuredContent != null && !isRecord(result.structuredContent)) return null;
  if (result.structuredContent && typeof result.structuredContent === "object"
    && !Array.isArray(result.structuredContent)) {
    return hasSemanticError(result.structuredContent) || !validRovoEnvelope(result, result.structuredContent, expectedFields)
      ? null : result.structuredContent;
  }
  if (!Array.isArray(result.content)) return null;
  const texts = result.content.filter(item => item?.type === "text" && typeof item.text === "string");
  for (const item of texts) {
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return hasSemanticError(parsed) ? null : parsed;
    } catch { /* MCP may include non-JSON explanatory text alongside JSON. */ }
  }
  return null;
}

function responseIssue(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (Object.hasOwn(data, "issues")) {
    const nodes = data.issues?.nodes;
    return Array.isArray(nodes) && nodes.length === 1 && isRecord(nodes[0]) ? nodes[0] : null;
  }
  const candidate = data.issue && typeof data.issue === "object" ? data.issue : data;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : null;
}

function normalizeCreated(data, siteOrigin, cloudId, request) {
  const issue = responseIssue(data);
  const key = issue?.key;
  const fields = issue?.fields;
  const project = fields?.project?.key;
  const summary = fields?.summary;
  const issueTypeId = fields?.issuetype?.id;
  const expectedIssueTypeId = ISSUE_TYPE_IDS.get(request.issue_type);
  if (!ISSUE_KEY.test(key ?? "") || project !== request.project || summary !== request.summary
    || !/^\d+$/.test(issueTypeId ?? "")
    || (expectedIssueTypeId ? issueTypeId !== expectedIssueTypeId : fields?.issuetype?.name !== request.issue_type)
    || !hasSiteIdentity(issue, siteOrigin, key, cloudId)) return null;
  // The returned key, project, summary and same-site Jira self URL bind this
  // browse URL to the Create response; no key or site identity is guessed.
  return { kind: "created", key, url: issue.webUrl ?? `${siteOrigin}/browse/${key}`, project, summary, tool_call_count: 1 };
}

function normalizeRead(data, siteOrigin, cloudId, request) {
  const issue = responseIssue(data);
  const fields = issue?.fields;
  const key = issue?.key;
  if (key !== request.key || !ISSUE_KEY.test(key ?? "") || fields?.project?.key !== "RPL"
    || !nonEmpty(fields?.issuetype?.id) || !hasSiteIdentity(issue, siteOrigin, key, cloudId)) return null;
  if (!request.fields.every(name => Object.hasOwn(fields, name))) return null;
  const returnedFields = Object.fromEntries(request.fields.filter(name => name !== "issuetype")
    .map(name => [name, fields[name]]));
  return { key, issue_type_id: fields.issuetype.id, fields: returnedFields, tool_call_count: 1 };
}

function escapeJqlString(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Jira Search summary contains control characters");
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function searchArgs(request, cloudId) {
  if (request?.project !== "RPL" || !nonEmpty(request?.summary_keywords))
    throw new Error("Jira Search requires the approved RPL project and summary");
  const phrase = escapeJqlString(request.summary_keywords.trim());
  return {
    cloudId,
    jql: `project = RPL AND summary ~ "\\"${phrase}\\""`,
    fields: ["summary", "project", "issuetype"],
    maxResults: 100,
    searchResultMode: "issues",
  };
}

function validRovoSearchWebUrl(value, siteOrigin) {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === siteOrigin && url.pathname === "/issues"
      && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function searchOutcome(data, request, siteOrigin, cloudId) {
  if (isRecord(data?.issues) && Array.isArray(data.issues.nodes)) {
    const result = data.issues;
    const pageInfo = result.pageInfo;
    if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean"
      || !Object.hasOwn(pageInfo, "endCursor")
      || (pageInfo.endCursor !== null && !nonEmpty(pageInfo.endCursor))
      || !validRovoSearchWebUrl(result.webUrl, siteOrigin) || pageInfo.hasNextPage)
      return { status: "failed", tool_call_count: 1 };
    if (!result.nodes.length) return { status: "none", tool_call_count: 1 };
    const normalized = [];
    for (const issue of result.nodes) {
      const key = issue?.key, fields = issue?.fields;
      if (!ISSUE_KEY.test(key ?? "") || fields?.project?.key !== request.project
        || typeof fields?.summary !== "string" || !fields.summary.trim()
        || !/^\d+$/.test(fields?.issuetype?.id ?? "")
        || !hasSiteIdentity(issue, siteOrigin, key, cloudId))
        return { status: "failed", tool_call_count: 1 };
      normalized.push({ key, project: fields.project.key, summary: fields.summary, url: issue.webUrl });
    }
    const exact = normalized.find(issue => issue.summary.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()
      === request.summary_keywords.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase());
    const candidate = exact ?? normalized[0];
    return { status: exact ? "exact_duplicate" : "similar", issue: candidate, tool_call_count: 1 };
  }
  const issues = data?.issues;
  if (!Array.isArray(issues)) return { status: "failed", tool_call_count: 1 };
  const hasTotal = Object.hasOwn(data, "total");
  const invalidTotal = hasTotal && (!Number.isSafeInteger(data.total) || data.total < issues.length || data.total < 0);
  const incomplete = issues.length >= 100 || nonEmpty(data.nextPageToken) || data.isLast === false || data.hasMore === true
    || invalidTotal || (Number.isSafeInteger(data.total) && data.total > issues.length);
  if (!issues.length) return incomplete
    ? { status: "failed", tool_call_count: 1 }
    : { status: "none", tool_call_count: 1 };

  const normalized = [];
  for (const issue of issues) {
    const key = issue?.key, fields = issue?.fields;
    if (!ISSUE_KEY.test(key ?? "") || fields?.project?.key !== request.project
      || typeof fields?.summary !== "string" || !fields.summary.trim()
      || !/^\d+$/.test(fields?.issuetype?.id ?? "")
      || !hasSiteIdentity(issue, siteOrigin, key, cloudId))
      return { status: "similar", tool_call_count: 1 };
    normalized.push({ key, project: fields.project.key, summary: fields.summary,
      ...(nonEmpty(issue.browse_url) ? { url: issue.browse_url } : nonEmpty(issue.self) ? { url: issue.self } : {}) });
  }
  const exact = normalized.find(issue => issue.summary.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()
    === request.summary_keywords.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase());
  const candidate = exact ?? normalized[0];
  return { status: exact && !incomplete ? "exact_duplicate" : "similar", issue: candidate, tool_call_count: 1 };
}

function assertCreateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || request.project !== "RPL" || !nonEmpty(request.issue_type) || !nonEmpty(request.summary)
    || !nonEmpty(request.description) || !nonEmpty(request.assignee) || !nonEmpty(request.priority)
    || !Array.isArray(request.labels) || request.labels.some(label => typeof label !== "string")
    || (request.fields != null && (!request.fields || typeof request.fields !== "object" || Array.isArray(request.fields)
      || Object.keys(request.fields).some(name => !APPROVED_CREATE_FIELD_NAMES.has(name)))) )
    throw new Error("Jira Create request does not match the G3 approved request shape");
}

function createArgs(request, cloudId, gateProof) {
  assertCreateRequest(request);
  const binding = gateProof?.issue_type_binding;
  const expectedIssueTypeId = ISSUE_TYPE_IDS.get(request.issue_type);
  if (gateProof?.allowed !== true || !nonEmpty(gateProof.evidence_ref)
    || !binding || binding.canonical_issue_type !== request.issue_type
    || binding.issue_type_id !== expectedIssueTypeId
    || !nonEmpty(binding.localized_issue_type_name)
    || !/^[a-f0-9]{64}$/.test(binding.metadata_sha256 ?? ""))
    throw createError("Jira Create requires the current verified issue type binding", { toolCallCount: 0 });
  return {
    cloudId,
    projectKey: request.project,
    issueTypeName: binding.localized_issue_type_name,
    summary: request.summary,
    description: request.description,
    assignee_account_id: request.assignee,
    additional_fields: {
      priority: { name: request.priority },
      labels: [...request.labels],
      ...(request.fields ?? {}),
    },
  };
}

function createError(message, { toolCallCount = 0, possibleApplied = false, cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = possibleApplied ? "JIRA_CREATE_POSSIBLY_APPLIED" : "JIRA_CONNECTOR_ERROR";
  error.tool_call_count = toolCallCount;
  error.mutation_status = possibleApplied ? "possibly_applied" : "not_started";
  error.automatic_retry = false;
  return error;
}

function parseProofTime(value) {
  if (typeof value !== "string") return NaN;
  return Date.parse(value);
}

function validateProof(proof, { capability, session, siteOrigin, cloudId, maxProofAgeMs, now }) {
  if (!proof || proof.allowed !== true || proof.capability !== capability
    || proof.site_origin !== siteOrigin || proof.cloud_id !== cloudId
    || proof.session_id !== session.id || !nonEmpty(proof.evidence_ref)) return null;
  const checked = parseProofTime(proof.checked_at), expires = parseProofTime(proof.expires_at);
  if (!Number.isFinite(checked) || !Number.isFinite(expires) || checked > now
    || now - checked > maxProofAgeMs || expires <= now || expires <= checked) return null;
  return { available: true, connection_verified: true, evidence_ref: proof.evidence_ref,
    jira_site_origin: siteOrigin };
}

/**
 * Creates the Jira half of the PR83 G3 connector contract. The supplied
 * verifySession function is the trust boundary: it must validate a current
 * authenticated session and return a site/cloud/capability-scoped proof.
 * Injected tool functions alone never establish authentication.
 */
export async function createG3JiraConnector({ invokeTool, verifySession, session, siteOrigin, cloudId,
  maxProofAgeMs = DEFAULT_MAX_PROOF_AGE_MS, now = () => Date.now() } = {}) {
  assertOrigin(siteOrigin);
  if (!siteCloudId(cloudId, siteOrigin) || !nonEmpty(session?.id)
    || typeof invokeTool !== "function" || typeof verifySession !== "function"
    || !Number.isSafeInteger(maxProofAgeMs) || maxProofAgeMs <= 0 || typeof now !== "function")
    throw new Error("G3 Jira connector requires a scoped session verifier, Jira tools and site identity");

  async function authorize(operation) {
    const capability = CAPABILITY[operation];
    const proof = await verifySession({ session, siteOrigin, cloudId, capability });
    const normalized = validateProof(proof, { capability, session, siteOrigin, cloudId, maxProofAgeMs, now: now() });
    if (!normalized) throw createError(`Trusted Jira session proof missing, stale or out of scope for ${capability}`);
    return normalized;
  }

  const capabilities = {};
  for (const operation of ["search", "create", "read"]) {
    capabilities[CAPABILITY[operation]] = await authorize(operation);
  }

  // Capability evidence proves a current scoped session, not endpoint health;
  // each operation rechecks session freshness before making one Jira call.
  return {
    capabilities,
    async search(request) {
      const args = searchArgs(request, cloudId);
      await authorize("search");
      let response;
      try { response = await invokeTool(TOOL.search, args); }
      catch { return { status: "failed", tool_call_count: 1 }; }
      const data = responseObject(response, ["project", "issuetype", "summary"]);
      return data ? searchOutcome(data, request, siteOrigin, cloudId) : { status: "failed", tool_call_count: 1 };
    },
    async create(request, gateProof) {
      const args = createArgs(request, cloudId, gateProof);
      await authorize("create");
      let response;
      try { response = await invokeTool(TOOL.create, args); }
      catch (cause) {
        throw createError("Jira Create response was lost or timed out; it may have applied. Do not retry.",
          { toolCallCount: 1, possibleApplied: true, cause });
      }
      const data = responseObject(response, ["project", "issuetype", "summary"]);
      const result = data && normalizeCreated(data, siteOrigin, cloudId, request);
      if (result) return result;
      throw createError("Jira Create returned no complete same-site key, summary and project identity; it may have applied. Do not retry.",
        { toolCallCount: 1, possibleApplied: true });
    },
    async read({ key, fields } = {}) {
      if (!ISSUE_KEY.test(key ?? "") || !Array.isArray(fields) || !fields.length
        || fields.some(name => typeof name !== "string" || !name.trim()))
        throw createError("Jira GET requires an RPL IssueKey and explicit fields");
      await authorize("read");
      let response;
      try {
        response = await invokeTool(TOOL.read, {
          cloudId, issueIdOrKey: key, fields: [...new Set(["project", ...fields])], failFast: true, updateHistory: false,
        });
      } catch (cause) {
        throw createError("Jira GET failed or timed out", { toolCallCount: 1, cause });
      }
      const data = responseObject(response, [...new Set(["project", ...fields])]);
      const normalized = data && normalizeRead(data, siteOrigin, cloudId, { key, fields });
      if (!normalized) throw createError("Jira GET response is malformed, incomplete or outside the verified site", { toolCallCount: 1 });
      return normalized;
    },
  };
}

export const G3_JIRA_TOOL_NAMES = TOOL;
