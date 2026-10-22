/**
 * Dependency-injected, single-writer G3 reference adapter.
 *
 * This module has NO authenticated Jira/GitHub/Owner connector of its own.
 * The caller must inject a trusted gate that verifies the current activation,
 * policy revision, live metadata and Owner approval using external sources.
 * Until then this is an offline integration seam, not production activation.
 */
export function createG3SupervisedAdapter({ jira, ledger, verifyGate, siteOrigin, runtime = "codex" }) {
  if (!jira || !ledger || typeof verifyGate !== "function"
    || typeof jira.search !== "function" || typeof jira.create !== "function"
    || typeof jira.read !== "function" || typeof ledger.persistIntent !== "function"
    || typeof ledger.linkIssue !== "function" || typeof ledger.persistOrigin !== "function"
    || typeof ledger.readClassificationAuthority !== "function")
    throw new Error("G3 requires explicit trusted Jira, authorization and durable Ledger integrations");
  if (!/^https:\/\/[^/]+$/.test(siteOrigin ?? "")) throw new Error("verified Jira site origin required");
  let active = null;
  let createStarted = false;
  let readConfirmed = false;
  const typeId = { Task: "10010", Epic: "10007", Feature: "10009",
    Bug: "10012", Research: "10013" };
  function sameTargets(expected, fields) {
    if (!fields || !Object.hasOwn(fields, "customfield_10110")
      || (fields.customfield_10110 !== null && !Array.isArray(fields.customfield_10110))
      || fields.customfield_10108?.id !== expected.customfield_10108?.id
      || fields.customfield_10109?.id !== expected.customfield_10109?.id) return false;
    const ids = values => values.map(v => v?.id).sort();
    const concerns = fields.customfield_10110 ?? [];
    return concerns.every(v => typeof v?.id === "string")
      && JSON.stringify(ids(concerns)) === JSON.stringify(ids(expected.customfield_10110 ?? []));
  }

  async function gate(stage, context) {
    const proof = await verifyGate({ stage, context });
    if (proof?.allowed !== true || typeof proof?.evidence_ref !== "string"
      || !proof.evidence_ref.trim()) throw new Error("G3 trusted external authorization missing: " + stage);
  }
  return {
    runtime,
    runtime_evidence: { jira_site_origin: siteOrigin },
    capabilities: Object.fromEntries([
      "jira.search", "jira.create", "jira.read", "jira.intent.persist", "jira.origin.persist",
    ].map(k => [k, { available: true, connection_verified: true }])),
    async search(request) {
      await gate("search", request);
      const result = await jira.search(request);
      if (result?.tool_call_count !== 1) throw new Error("Jira Search must have exactly one verified call");
      return result;
    },
    async persistIntent(request) {
      if (active) throw new Error("this supervised Writer already has an Intent");
      await gate("intent", request);
      const receipt = await ledger.persistIntent(request);
      if (receipt.status === "persisted" && receipt.created_new === true)
        active = { id: request.create_request_id, activation: request.activation_ref,
          issueType: request.issue_type, expectedFields: request.fields };
      return { ...receipt, tool_call_count: 1 };
    },
    async create(request) {
      if (!active || createStarted) throw new Error("missing/new Intent or replayed Jira Create");
      await gate("create", { request, create_request_id: active.id, activation_ref: active.activation });
      createStarted = true; // ambiguity on failure permanently prevents retry in this instance
      const result = await jira.create(request);
      let identityValid = false;
      try {
        const u = new URL(result?.url);
        identityValid = u.origin === siteOrigin && u.pathname === "/browse/" + result?.key;
      } catch { /* invalid/partial response */ }
      if (result?.kind !== "created" || result?.tool_call_count !== 1
        || !/^RPL-[1-9][0-9]*$/.test(result?.key ?? "")
        || result.project !== "RPL" || result.summary !== request.summary || !identityValid)
        throw new Error("ambiguous Jira Create identity; do not automatically retry");
      // Link the returned IssueKey to a durable Intent *before* post-Create GET.
      // If linking fails, Core quarantines rather than pretending nothing was created.
      await ledger.linkIssue(active.id, result);
      return result;
    },
    async read(request) {
      if (!createStarted || !active || !/^RPL-[1-9][0-9]*$/.test(request?.key ?? ""))
        throw new Error("post-Create Jira GET without Intent");
      await gate("read", { ...request, create_request_id: active.id });
      const result = await jira.read(request);
      if (result?.tool_call_count !== 1 || result?.key !== request.key
        || result?.issue_type_id !== typeId[active.issueType]
        || !sameTargets(active.expectedFields, result?.fields))
        throw new Error("Jira GET is inconsistent with the durable approved Intent");
      readConfirmed = true; // Core independently checks the same saved Target values
      return result;
    },
    async persistOrigin(request) {
      if (!active || !createStarted || !readConfirmed || request?.create_request_id !== active.id)
        throw new Error("Origin without linked Intent, Create and GET");
      await gate("origin", request);
      const receipt = await ledger.persistOrigin(request);
      return { ...receipt, tool_call_count: 1 };
    },
    async readClassificationAuthority(issueKey) {
      await gate("authority_read", { issue_key: issueKey });
      return ledger.readClassificationAuthority(issueKey);
    },
    async readVerifiedClassification(issueKey) {
      await gate("authority_read", { issue_key: issueKey });
      const authority = await ledger.readClassificationAuthority(issueKey);
      if (authority.read_authority !== "target") return authority;
      const typeIds = { Task: "10010", Epic: "10007", Feature: "10009",
        Bug: "10012", Research: "10013" };
      const expectedType = typeIds[authority.issue_type];
      const fail = { origin: "UNKNOWN_ORIGIN", phase: "create_quarantined",
        read_authority: "none", write_authority: "frozen" };
      if (!expectedType) return fail;
      let current;
      try { current = await jira.read({ key: issueKey,
        fields: ["issuetype", "customfield_10108", "customfield_10109", "customfield_10110"] }); }
      catch { return fail; }
      const fields = current?.fields, concern = fields?.customfield_10110;
      if (!fields || !Object.hasOwn(fields, "customfield_10110")
        || (concern !== null && !Array.isArray(concern))
        || current?.key !== issueKey || current?.tool_call_count !== 1
        || current?.issue_type_id !== expectedType
        || fields.customfield_10108?.id !== authority.product?.id
        || fields.customfield_10109?.id !== authority.component?.id)
        return fail;
      const ids = values => values.map(x => x?.id).sort();
      const actual = concern ?? [], expected = authority.concern;
      if (!Array.isArray(expected) || actual.some(x => typeof x?.id !== "string")
        || JSON.stringify(ids(actual)) !== JSON.stringify(ids(expected))) return fail;
      return { ...authority, source: "jira_get_and_durable_origin" };
    },
  };
}
