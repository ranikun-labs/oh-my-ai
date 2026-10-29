/**
 * Dependency-injected, single-writer G3 reference adapter.
 *
 * This module has NO authenticated Jira/GitHub/Owner connector of its own.
 * The caller must inject a trusted gate that verifies the current activation,
 * policy revision, live metadata and Owner approval using external sources.
 * Until then this is an offline integration seam, not production activation.
 */
export function createG3SupervisedAdapter({ jira, ledger, verifyGate, siteOrigin, capabilityEvidence, runtime = "codex" }) {
  if (!jira || !ledger || typeof verifyGate !== "function"
    || typeof jira.search !== "function" || typeof jira.create !== "function"
    || typeof jira.read !== "function" || typeof ledger.persistIntent !== "function"
    || typeof ledger.linkIssue !== "function" || typeof ledger.persistOrigin !== "function"
    || typeof ledger.readClassificationAuthority !== "function")
    throw new Error("G3 requires explicit trusted Jira, authorization and durable Ledger integrations");
  if (!/^https:\/\/[^/]+$/.test(siteOrigin ?? "")) throw new Error("verified Jira site origin required");
  // Capability claims must come from a trusted runtime integration, not from
  // the presence of dependency-injected methods. Mock callers supply explicit
  // synthetic evidence in fixtures. The G3 reference never authenticates
  // evidence_ref itself; production connectors must do that before injection.
  const requiredCapabilities = [
    "jira.search", "jira.create", "jira.read", "jira.intent.persist", "jira.origin.persist",
  ];
  const capabilities = {};
  for (const name of requiredCapabilities) {
    const proof = capabilityEvidence?.[name];
    if (proof?.available !== true || proof?.connection_verified !== true
      || typeof proof?.evidence_ref !== "string" || !proof.evidence_ref.trim()
      || (["jira.search", "jira.create", "jira.read"].includes(name)
        && proof.jira_site_origin !== siteOrigin))
      throw new Error("missing verified capability evidence: " + name);
    capabilities[name] = { available: true, connection_verified: true,
      evidence_ref: proof.evidence_ref };
  }
  let active = null;
  let intentReserved = false;
  let createReserved = false;
  let createStarted = false;
  let readConfirmed = false;
  let createdKey = null;
  let verifiedReadFields = null;
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
    const proof = await verifyGate({ stage, context: structuredClone(context) });
    if (proof?.allowed !== true || typeof proof?.evidence_ref !== "string"
      || !proof.evidence_ref.trim()) throw new Error("G3 trusted external authorization missing: " + stage);
    return proof;
  }
  // Both public Reader entry points enforce Jira GET parity; raw Ledger reads
  // are available only through the injected Ledger for privileged diagnostics.
  async function readVerifiedClassificationInternal(issueKey) {
    const signedAuthority = await gate("authority_read", { issue_key: issueKey });
    const authority = await ledger.readClassificationAuthority(issueKey);
    if (authority.read_authority !== "target") return authority;
    const fail = { origin: "UNKNOWN_ORIGIN", phase: "create_quarantined",
      read_authority: "none", write_authority: "frozen" };
    const expectedType = typeId[authority.issue_type];
    if (!expectedType || authority.issue_type_id !== expectedType
      || signedAuthority.issue_key !== issueKey || signedAuthority.project !== "RPL"
      || signedAuthority.issue_type !== authority.issue_type
      || signedAuthority.issue_type_id !== authority.issue_type_id
      || signedAuthority.origin !== authority.origin || signedAuthority.origin_ref !== authority.origin_ref
      || signedAuthority.read_authority !== "target" || !authority.origin_ref) return fail;
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
  }
  return {
    runtime,
    runtime_evidence: { jira_site_origin: siteOrigin },
    capabilities,
    async search(request) {
      const searchRequest = structuredClone(request);
      const createPreflight = searchRequest.create_preflight;
      delete searchRequest.create_preflight;
      await gate("search", { ...searchRequest, create_preflight: createPreflight });
      const result = await jira.search(searchRequest);
      if (result?.tool_call_count !== 1) throw new Error("Jira Search must have exactly one verified call");
      return result;
    },
    async persistIntent(request) {
      if (active || intentReserved) throw new Error("this supervised Writer already has an Intent or pending Intent gate");
      intentReserved = true; // Reserve synchronously before awaiting the external gate.
      const intent = structuredClone(request);
      const createRequest = intent.create_request;
      delete intent.create_request;
      const proof = await gate("intent", { ...intent, create_request: createRequest });
      const approvalRef = proof.cutover_approval_ref;
      if (typeof approvalRef !== "string" || !approvalRef.trim())
        throw new Error("G3 intent gate must prove a non-empty cutover approval reference");
      const typeBinding = proof.issue_type_binding;
      if (!typeBinding || typeBinding.canonical_issue_type !== intent.issue_type
        || typeBinding.issue_type_id !== typeId[intent.issue_type]
        || typeof typeBinding.localized_issue_type_name !== "string" || !typeBinding.localized_issue_type_name.trim()
        || !/^[a-f0-9]{64}$/.test(typeBinding.metadata_sha256 ?? ""))
        throw new Error("G3 intent gate must bind the signed Issue Type and live metadata");
      const immutablePending = { ...intent, issue_type_id: typeBinding.issue_type_id,
        cutover_approval_ref: approvalRef };
      const receipt = await ledger.persistIntent(immutablePending);
      if (receipt.status === "persisted" && receipt.created_new === true)
        active = { id: immutablePending.create_request_id, activation: immutablePending.activation_ref,
          issueType: immutablePending.issue_type, issueTypeId: immutablePending.issue_type_id,
          expectedFields: structuredClone(immutablePending.fields),
          cutoverApprovalRef: approvalRef };
      return { ...receipt, tool_call_count: 1 };
    },
    async create(request) {
      if (!active || createReserved) throw new Error("missing/new Intent or replayed Jira Create");
      const createRequest = structuredClone(request);
      createReserved = true; // Synchronous reservation closes the gate-await race.
      const proof = await gate("create", { request: createRequest,
        create_request_id: active.id, activation_ref: active.activation });
      const typeBinding = proof.issue_type_binding;
      if (!typeBinding || typeBinding.canonical_issue_type !== createRequest.issue_type
        || typeBinding.issue_type_id !== typeId[createRequest.issue_type]
        || typeBinding.issue_type_id !== active.issueTypeId
        || typeof typeBinding.localized_issue_type_name !== "string"
        || !typeBinding.localized_issue_type_name.trim()
        || !/^[a-f0-9]{64}$/.test(typeBinding.metadata_sha256 ?? ""))
        throw new Error("G3 Create requires the current signed Jira issue type binding");
      createStarted = true; // Any Jira call failure permanently prevents retry in this instance.
      const result = await jira.create(createRequest, proof);
      let identityValid = false;
      try {
        const u = new URL(result?.url);
        identityValid = u.origin === siteOrigin && u.pathname === "/browse/" + result?.key;
      } catch { /* invalid/partial response */ }
      if (result?.kind !== "created" || result?.tool_call_count !== 1
        || !/^RPL-[1-9][0-9]*$/.test(result?.key ?? "")
        || result.project !== "RPL" || result.summary !== createRequest.summary || !identityValid)
        throw new Error("ambiguous Jira Create identity; do not automatically retry");
      // Link the returned IssueKey to a durable Intent *before* post-Create GET.
      // If linking fails, Core quarantines rather than pretending nothing was created.
      await ledger.linkIssue(active.id, result);
      createdKey = result.key;
      return result;
    },
    async read(request) {
      const readRequest = structuredClone(request);
      if (!createStarted || !createdKey || !active || !/^RPL-[1-9][0-9]*$/.test(readRequest?.key ?? ""))
        throw new Error("post-Create Jira GET without Intent");
      await gate("read", { ...readRequest, create_request_id: active.id });
      const result = await jira.read(readRequest);
      if (result?.tool_call_count !== 1 || result?.key !== readRequest.key
        || result?.key !== createdKey || result?.issue_type_id !== active.issueTypeId
        || !sameTargets(active.expectedFields, result?.fields))
        throw new Error("Jira GET is inconsistent with the durable approved Intent");
      // A successful GET is tied to exactly the Issue created by this Adapter.
      verifiedReadFields = structuredClone(result.fields);
      readConfirmed = true; // Core independently checks the same saved Target values
      return result;
    },
    async persistOrigin(request) {
      const originRequest = structuredClone(request);
      if (!active || !createStarted || !readConfirmed
        || originRequest?.create_request_id !== active.id || originRequest?.issue_key !== createdKey
        || originRequest?.cutover_approval_ref !== active.cutoverApprovalRef
        || (originRequest?.issue_type != null && originRequest.issue_type !== active.issueType)
        || (originRequest?.issue_type_id != null && originRequest.issue_type_id !== active.issueTypeId)
        || !sameTargets(verifiedReadFields, originRequest?.verified_fields))
        throw new Error("Origin without same-Issue, verified GET Target values and Intent");
      const boundOrigin = { ...originRequest, issue_type: active.issueType, issue_type_id: active.issueTypeId };
      await gate("origin", boundOrigin);
      const receipt = await ledger.persistOrigin(boundOrigin);
      return { ...receipt, tool_call_count: 1 };
    },
    async readClassificationAuthority(issueKey) {
      return readVerifiedClassificationInternal(issueKey);
    },
    async readVerifiedClassification(issueKey) {
      return readVerifiedClassificationInternal(issueKey);
    },
  };
}
