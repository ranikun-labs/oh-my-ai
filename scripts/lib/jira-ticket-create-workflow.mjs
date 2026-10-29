import { createHash } from "node:crypto";

const CONTRACT_FIELDS = [
  "Summary", "Context", "Goal", "Source of Truth", "In Scope", "Out of Scope",
  "Acceptance Criteria", "Repository", "Base Branch", "Expected Branch Name",
  "Dependencies", "Verification", "Do Not Touch", "Definition of Done",
];
const BLOCKING_SENTINELS = new Set([
  "decision required", "repository required", "base branch required", "not verifiable",
]);

function baseReport() {
  return {
    search_attempted: false,
    search_result: "not_performed",
    duplicate_status: "not_checked",
    approval_status: "not_requested",
    create_attempted: false,
    create_call_count: 0,
    mutation_status: "0",
    automatic_retry: false,
    actual_issue_key: null,
    actual_issue_url: null,
    verification_status: "not_verifiable",
    allowed_next_step: "Review the Ticket Contract",
    preview_evidence: [],
    write_evidence: [],
  };
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isBlocking(value) {
  return BLOCKING_SENTINELS.has(normalizedText(value).toLowerCase());
}

export function isValidJiraTicketWorkflowText(value) {
  return normalizedText(value).length > 0 && !isBlocking(value);
}

export function isValidJiraTicketContract(contract) {
  return CONTRACT_FIELDS.every((field) => isValidJiraTicketWorkflowText(contract?.[field]));
}

function hasValidContract(contract) {
  return isValidJiraTicketContract(contract);
}

function missingCreateMetadata(contract, metadata) {
  const required = [
    ["Project", metadata?.project], ["Issue Type", metadata?.issue_type], ["Summary", contract?.Summary],
    ["Assignee", metadata?.assignee], ["Priority", metadata?.priority], ["Product", metadata?.product],
    ["Primary Repository", metadata?.repository], ["Area", metadata?.area],
  ];
  return required.filter(([, value]) => !isValidJiraTicketWorkflowText(value)).map(([field]) => field);
}

function hasCapability(state, capability) {
  const record = state.capabilities?.[capability];
  return record?.available === true && record?.connection_verified === true;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value ?? null;
}

// Jira labels are a set for this workflow: whitespace and duplicates have no
// semantic meaning, and order must not invalidate an otherwise current Preview.
function canonicalLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels.filter((label) => typeof label === "string").map((label) => label.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}


const TARGET_FIELDS = {
  product: "customfield_10108", component: "customfield_10109", concern: "customfield_10110",
};
const LEGACY_CLASSIFICATION_FIELDS = ["customfield_10042", "customfield_10043", "customfield_10044"];
const SUPPLEMENTAL_CREATE_FIELDS = new Set(["customfield_10015", "customfield_10045", "duedate"]);
const TARGET_ISSUE_TYPES = new Map([
  ["Task", "10010"], ["작업", "10010"], ["Epic", "10007"], ["에픽", "10007"],
  ["Feature", "10009"], ["기능", "10009"], ["Bug", "10012"], ["버그", "10012"],
  ["Research", "10013"],
]);

function validSupplementalValue(id, value) {
  if (id === "customfield_10045") return Array.isArray(value) && value.length > 0
    && value.every(v => normalizedText(v?.accountId))
    && new Set(value.map(v => v.accountId)).size === value.length;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function targetCreateError(target, metadata) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return "Target Create 설정 없음";
  if (target.mode !== "single_supervised") return "승인된 직렬·단일 Writer 모드 필요";
  const cutover = target.cutover, live = target.create_metadata, chosen = target.selection;
  if (!cutover || cutover.status !== "approved"
    || ![cutover.approval_ref, cutover.activation_ref, cutover.effective_from, cutover.effective_to,
      cutover.request_time, cutover.rollback_ref].every(normalizedText)) return "유형별 G3 Cutover 승인·기간·복구 증거 부족";
  const from = Date.parse(cutover.effective_from), to = Date.parse(cutover.effective_to);
  const requested = Date.parse(cutover.request_time), checked = Date.parse(live?.observed_at);
  const now = Date.now();
  // Never trust a caller-provided request_time as the actual current clock.
  // Late replays must not reuse a previously valid activation window.
  if (![from, to, requested, checked].every(Number.isFinite) || !(from <= now && now <= to)
    || Math.abs(now - requested) > 5 * 60 * 1000
    || checked > now || now - checked > 60 * 60 * 1000) return "G3 활성 기간 또는 최신 Jira Metadata 증거 불일치";
  if (!target.request_id || !normalizedText(target.ledger_ref)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(target.request_id)) return "지속 저장 가능한 CreateRequestId 및 Ledger 필요";
  if (!["reader", "board", "automation", "rollback", "ledger"].every(k => target.readiness?.[k] === true))
    return "Reader/Board/Automation/Rollback/Ledger 사전 검증 미완료";
  const supportedTypeId = TARGET_ISSUE_TYPES.get(metadata?.issue_type);
  if (!supportedTypeId || metadata.project !== "RPL" || !live
    || live.source !== "live_jira_create_metadata" || live.project !== metadata.project
    || live.issue_type !== metadata.issue_type
    || live.issue_type_id !== supportedTypeId) return "Jira Issue Type·실제 Create Metadata 불일치";
  const fields = live.fields;
  const allowMissingLegacy = metadata.project === "RPL" && supportedTypeId === "10010"
    && live.issue_type === "Task" && live.issue_type_id === "10010";
  if (!fields || typeof fields !== "object" || Array.isArray(fields)
    || LEGACY_CLASSIFICATION_FIELDS.some(k => {
      if (!Object.hasOwn(fields, k)) return !allowMissingLegacy;
      return !fields[k] || fields[k].required !== false || fields[k].hasDefaultValue !== false
        || (fields[k].defaultValue != null
          && !(Array.isArray(fields[k].defaultValue) && fields[k].defaultValue.length === 0));
    }))
    return "Legacy 필수/기본값 해제 미검증";
  if (fields[TARGET_FIELDS.product]?.required !== true || fields[TARGET_FIELDS.component]?.required !== true
    || fields[TARGET_FIELDS.concern]?.required !== false) return "Target 필수/선택 계약 미검증";
  for (const [kind, id] of Object.entries(TARGET_FIELDS)) {
    const field = fields[id], schema = field.schema;
    if (field.hasDefaultValue !== false || field.defaultValue != null
      || (kind === "concern"
        ? schema?.type !== "array" || schema.items !== "option"
          || schema.custom !== "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes"
        : schema?.type !== "option"
          || schema.custom !== "com.atlassian.jira.plugin.system.customfieldtypes:select"))
      return "Target 타입 또는 기본값 없음 미검증";
  }
  if (!chosen || !Array.isArray(chosen.concerns) || chosen.concerns.length > 3)
    return "Target Product·Component 또는 Concern 0~3개가 필요";
  for (const [kind, values] of [["product", [chosen.product]], ["component", [chosen.component]],
    ["concern", chosen.concerns]]) {
    const field = fields[TARGET_FIELDS[kind]];
    if (!Array.isArray(field.allowedValues)) return "실제 Target 허용 옵션 목록 미확인";
    if (values.some(v => !v || typeof v.id !== "string" || !/^\d+$/.test(v.id) || !normalizedText(v.value)
      || !field.allowedValues.some(a => a.id === v.id && a.value === v.value)))
      return "선택한 Target 옵션 ID/값이 Jira Metadata와 불일치";
  }
  if (new Set(chosen.concerns.map(v => v.id)).size !== chosen.concerns.length) return "중복 Concern 옵션";
  const extra = target.supplemental_fields ?? {};
  if (!extra || typeof extra !== "object" || Array.isArray(extra)
    || Object.keys(extra).some(k => !SUPPLEMENTAL_CREATE_FIELDS.has(k) || extra[k] == null))
    return "승인 외 보조 Create 필드 또는 누락 값";
  for (const id of SUPPLEMENTAL_CREATE_FIELDS) {
    const field = fields[id], schema = field?.schema;
    if (!field || typeof field.required !== "boolean" || typeof field.hasDefaultValue !== "boolean"
      || (id === "customfield_10045" ? schema?.type !== "array" || schema.items !== "user"
        : schema?.type !== "date")) return "보조 Create 필드 Metadata·타입 미검증";
    if ((field.hasDefaultValue && !validSupplementalValue(id, field.defaultValue))
      || (!field.hasDefaultValue && field.defaultValue != null))
      return "보조 Create 필드 기본값 증거 불일치";
    const value = extra[id];
    if (value === undefined) {
      if (field.required && !field.hasDefaultValue) return "필수 보조 Create 필드 값 누락";
      continue;
    }
    if (!validSupplementalValue(id, value)) return "보조 Create 필드 값·타입 불일치";
  }
  return null;
}

function targetCreateFields(snapshot, includeSupplemental = true) {
  const t = snapshot.target_create, selected = t.selection;
  return {
    [TARGET_FIELDS.product]: { id: selected.product.id },
    [TARGET_FIELDS.component]: { id: selected.component.id },
    ...(selected.concerns.length ? { [TARGET_FIELDS.concern]: selected.concerns.map(v => ({ id: v.id })) } : {}),
    ...(includeSupplemental ? t.supplemental_fields : {}),
  };
}

// Protocol state is transport data, not a new approval. Preserve the displayed
// Snapshot and verified capabilities at every Target boundary. The external
// adapter still authenticates approval, live metadata, and durable receipts.
function approvedTargetSnapshotError(state, revalidateLive = false) {
  const snapshot = state.approved_snapshot;
  if (!state.target_mode || !snapshot?.target_create || !state.preview_id
    || previewId(snapshot) !== state.preview_id) return "Approved Preview integrity mismatch";
  try {
    if (!state.search || previewId(previewPayload(state, state.search)) !== state.preview_id)
      return "Current Target state differs from approved Preview";
  } catch { return "Incomplete approved Target state"; }
  if (["await_read", "await_origin"].includes(state.stage)
    && (state.created_issue?.key !== state.report.actual_issue_key
      || state.created_issue?.url !== state.report.actual_issue_url
      || !issueUrlMatches(state.created_issue?.url, snapshot.runtime_evidence?.jira_site_origin,
        state.created_issue?.key))) return "Created Issue identity differs from Create evidence";
  if (!["jira.search", "jira.create", "jira.intent.persist", "jira.read", "jira.origin.persist"]
    .every(capability => hasCapability(state, capability))) return "Target capability no longer verified";
  if (revalidateLive && (targetCreateError(snapshot.target_create, snapshot)
    || targetCreateError(state.metadata?.target_create, state.metadata)))
    return "G3 activation or Metadata expired before Jira Create";
  return null;
}

function targetQuarantine(state, reason) {
  state.stage = "quarantined";
  return terminal(state, {
    mutation_status: "possibly_applied", verification_status: "not_verifiable",
    origin_status: "UNKNOWN_ORIGIN", read_authority: "none", write_authority: "frozen",
    allowed_next_step: reason + "; no automatic retry or legacy fallback",
  });
}

function previewPayload(state, search) {
  return canonicalize({
    contract: Object.fromEntries(CONTRACT_FIELDS.map((field) => [field, state.contract[field]])),
    project: state.metadata.project,
    issue_type: state.metadata.issue_type,
    assignee: state.metadata.assignee,
    priority: state.metadata.priority,
    labels: canonicalLabels(state.metadata.labels),
    product: state.metadata.product,
    primary_repository: state.metadata.repository,
    area: state.metadata.area,
    branch: state.metadata.branch ?? null,
    pr: state.metadata.pr ?? null,
    current_head: state.metadata.current_head ?? null,
    ...(state.target_mode ? { target_create: state.metadata.target_create } : {}),
    duplicate_search: search,
    reuse_candidate: search.issue ?? null,
    runtime: state.runtime,
    capability_evidence: state.capabilities,
    runtime_evidence: state.runtime_evidence,
  });
}

function previewId(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function createDescription(snapshot) {
  const header = [
    `Product: ${snapshot.product}`, `Primary Repository: ${snapshot.primary_repository}`, `Area: ${snapshot.area}`,
    `Assignee: ${snapshot.assignee}`, `Priority: ${snapshot.priority}`,
    `Branch: ${normalizedText(snapshot.branch) || "Not Verifiable"}`,
    `PR: ${snapshot.pr ?? "Not created"}`, `Current HEAD: ${snapshot.current_head ?? "Not Verifiable"}`,
  ];
  return [...header, "", ...CONTRACT_FIELDS.map((field) => `## ${field}\n${snapshot.contract[field]}`)].join("\n");
}

function searchRequest(contract, metadata) {
  const request = {
    project: "RPL", summary_keywords: contract.Summary, product: metadata.product,
    repository: metadata.repository, area: metadata.area, related_pr: metadata.pr ?? null,
    branch: metadata.branch ?? null, decision: metadata.decision ?? null,
    existing_issue_key: metadata.existing_issue_key ?? null, created_after: metadata.created_after ?? null,
    contract_fingerprint_candidate: `${contract.Summary}|${metadata.product}|${metadata.repository}|${metadata.area}`,
  };
  if (metadata.target_create) {
    request.create_preflight = buildJiraTicketCreateRequest({
      project: metadata.project, issue_type: metadata.issue_type, contract,
      assignee: metadata.assignee, priority: metadata.priority,
      labels: canonicalLabels(metadata.labels), product: metadata.product,
      primary_repository: metadata.repository, area: metadata.area,
      branch: metadata.branch ?? null, pr: metadata.pr ?? null,
      current_head: metadata.current_head ?? null, target_create: metadata.target_create,
    });
  }
  return request;
}

function terminal(state, patch) {
  Object.assign(state.report, patch);
  return { state, report: state.report, required_action: null };
}

/** Pure Core payload builder shared with offline previews; it grants no authorization. */
export function buildJiraTicketCreateRequest(snapshot) {
  return {
    project: snapshot.project, issue_type: snapshot.issue_type, summary: snapshot.contract.Summary,
    description: createDescription(snapshot),
    // Logical Ticket Contract metadata is not automatically a Jira Create field.
    // The live G3 Task schema omits these wrappers. Legacy Create is unchanged.
    ...(snapshot.target_create
      ? { fields: targetCreateFields(snapshot) }
      : { assignee: snapshot.assignee, priority: snapshot.priority, labels: snapshot.labels }),
  };
}

function validSiteOrigin(origin) {
  try { return new URL(origin).origin === origin; } catch { return false; }
}

function issueUrlMatches(url, siteOrigin, key) {
  try {
    const parsed = new URL(url);
    return parsed.origin === siteOrigin && parsed.pathname === `/browse/${key}`;
  } catch {
    return false;
  }
}

/** Runtime-neutral first stage. It emits a semantic action; it never invokes Jira. */
export function beginJiraTicketCreateWorkflow(input) {
  const state = {
    runtime: input.runtime,
    contract: input.contract,
    metadata: input.metadata,
    capabilities: input.capabilities ?? {},
    runtime_evidence: input.runtime_evidence ?? {},
    report: baseReport(),
  };
  state.report.preview_evidence.push(`Runtime: ${state.runtime ?? "unknown"}`);
  state.target_mode = state.metadata?.target_create != null;
  if (state.target_mode) {
    const targetProblem = targetCreateError(state.metadata.target_create, state.metadata);
    if (targetProblem) return terminal(state, {
      approval_status: "blocked", verification_status: "not_verifiable",
      allowed_next_step: targetProblem, target_create_status: "blocked",
    });
    for (const capability of ["jira.intent.persist", "jira.read", "jira.origin.persist"]) {
      if (!hasCapability(state, capability)) return terminal(state, {
        approval_status: "blocked", allowed_next_step: "Missing verified capability: " + capability,
        target_create_status: "blocked",
      });
    }
  }
  const missing = missingCreateMetadata(state.contract, state.metadata);
  if (missing.length) return terminal(state, {
    missing_metadata: missing, approval_status: "blocked", verification_status: "NOT_VERIFIABLE", allowed_next_step: "누락 Metadata 보완",
  });
  if (!hasValidContract(state.contract)) return terminal(state, {
    approval_status: "blocked", allowed_next_step: "Resolve the Ticket Contract validation failures",
  });
  if (state.metadata.project !== "RPL") return terminal(state, {
    verification_status: "not_verifiable", allowed_next_step: "Project를 RPL로 수정",
  });
  if (!hasCapability(state, "jira.search")) return terminal(state, {
    allowed_next_step: "Connect Jira MCP/Plugin or review the Ticket Contract manually",
  });
  state.report.search_attempted = true;
  return { state, report: state.report, required_action: { type: "jira.search_required", request: searchRequest(state.contract, state.metadata) } };
}

/** Accepts a runtime-normalized result after exactly one Jira search tool call. */
export function applyJiraSearchResult(state, search) {
  if (state.target_mode) {
    const problem = targetCreateError(state.metadata?.target_create, state.metadata);
    if (problem) return terminal(state, {
      approval_status: "blocked", target_create_status: "blocked",
      allowed_next_step: "Target metadata changed after Search: " + problem,
    });
  }
  if (search?.tool_call_count !== 1) return terminal(state, {
    search_result: "unclear", duplicate_status: "unknown", allowed_next_step: "Resolve Jira search evidence before creating an Issue",
  });
  state.search = search;
  state.report.search_result = search.status ?? "unclear";
  state.report.preview_evidence.push(`Search result: ${search.status ?? "unknown"}`, `Search tool calls: ${search.tool_call_count}`);
  if (search.status === "exact_duplicate") return terminal(state, {
    duplicate_status: "exact", reuse_candidate: search.issue ?? null, allowed_next_step: "Reuse the existing Jira Issue",
  });
  if (search.status === "similar") return terminal(state, {
    duplicate_status: "similar", approval_status: "decision_required", reuse_candidate: search.issue ?? null, allowed_next_step: "Ask a human whether to reuse or create a Jira Issue",
  });
  if (search.status === "failed") return terminal(state, {
    duplicate_status: "unknown", allowed_next_step: "Resolve Jira search evidence before creating an Issue",
  });
  if (search.status !== "none") return terminal(state, {
    search_result: "unclear", duplicate_status: "unknown", allowed_next_step: "Resolve Jira search evidence before creating an Issue",
  });
  state.report.duplicate_status = "none";
  state.preview = previewPayload(state, search);
  state.preview_id = previewId(state.preview);
  state.report.preview_id = state.preview_id;
  if (!hasCapability(state, "jira.create")) return terminal(state, {
    allowed_next_step: "Connect Jira Create capability before approving a Create Preview",
  });
  if (!validSiteOrigin(state.runtime_evidence.jira_site_origin)) return terminal(state, {
    allowed_next_step: "Verify the Jira Site Origin before approving a Create Preview",
  });
  return { state, report: state.report, required_action: { type: "preview_required", preview_id: state.preview_id, preview: state.preview } };
}

/** Approval is valid only for the exact canonical Preview emitted above. */
export function applyJiraPreviewApproval(state, approval) {
  if (state.target_mode && targetCreateError(state.metadata?.target_create, state.metadata))
    return terminal(state, { approval_status: "blocked", target_create_status: "blocked",
      allowed_next_step: "Revalidate live Target metadata before Preview approval" });
  if (state.target_mode && state.stage) return terminal(state, {
    approval_status: "blocked", allowed_next_step: "Duplicate Target approval stage; no additional Create allowed",
  });
  const currentSnapshot = state.search ? previewPayload(state, state.search) : null;
  const currentPreviewId = currentSnapshot ? previewId(currentSnapshot) : null;
  // state.preview is untrusted protocol state after it leaves the renderer.
  // It proves that the displayed Preview is still current, but never supplies
  // data for the Jira mutation request.
  const storedPreviewId = state.preview ? previewId(state.preview) : null;
  if (approval?.status === "pending") return terminal(state, {
    approval_status: "pending", allowed_next_step: "Obtain explicit approval for this Create Preview",
  });
  if (approval?.status === "rejected") return terminal(state, {
    approval_status: "rejected", allowed_next_step: "Keep the preview without creating a Jira Issue",
  });
  if (approval?.status !== "approved" || !approval.preview_id || approval.preview_id !== state.preview_id || approval.preview_id !== currentPreviewId || storedPreviewId !== currentPreviewId) {
    return terminal(state, {
      approval_status: "stale_or_missing", verification_status: "not_verifiable", allowed_next_step: "현재 Preview를 다시 승인",
    });
  }
  state.report.approval_status = "approved";
  // Snapshot through the JSON protocol boundary before emitting the mutation.
  // The Create request and later result verification share this exact snapshot;
  // neither rereads mutable state.preview, state.contract, or state.metadata.
  state.approved_snapshot = JSON.parse(JSON.stringify(currentSnapshot));
  if (state.target_mode) {
    state.stage = "await_intent";
    const target = state.approved_snapshot.target_create;
    return { state, report: state.report, required_action: {
      type: "jira.intent_persist_required", preview_id: state.preview_id,
      request: { create_request_id: target.request_id, ledger_ref: target.ledger_ref,
        activation_ref: target.cutover.activation_ref, status: "pending",
        approved_preview_id: state.preview_id, issue_type: state.approved_snapshot.issue_type,
        fields: targetCreateFields(state.approved_snapshot),
        create_request: buildJiraTicketCreateRequest(state.approved_snapshot) },
    } };
  }
  return { state, report: state.report, required_action: { type: "jira.create_required", request: buildJiraTicketCreateRequest(state.approved_snapshot), preview_id: state.preview_id } };
}

/** Validates a runtime-normalized Create result without constructing a Jira URL or Key. */
export function applyJiraCreateResult(state, created) {
  state.report.create_attempted = true;
  // A Jira Create result may already represent a real mutation. Until both GET
  // and durable Origin registration pass it is never safe to report 0 writes.
  const targetExpected = Boolean(state?.approved_snapshot?.target_create || state?.metadata?.target_create || state?.preview?.target_create);
  if (targetExpected) state.report.mutation_status = "possibly_applied";
  state.report.create_call_count = created?.tool_call_count ?? 0;
  state.report.actual_issue_key = created?.key ?? null;
  state.report.actual_issue_url = created?.url ?? null;
  state.report.write_evidence.push(`Create tool calls: ${created?.tool_call_count ?? 0}`);
  if (created?.key) state.report.write_evidence.push(`Returned Issue Key: ${created.key}`);
  if (created?.url) state.report.write_evidence.push(`Returned Issue URL: ${created.url}`);
  const keyValid = /^RPL-[1-9][0-9]*$/.test(created?.key ?? "");
  const verified = created?.kind === "created" && created?.tool_call_count === 1 && keyValid
    && created.project === "RPL" && created.summary === state.approved_snapshot?.contract?.Summary
    && issueUrlMatches(created.url, targetExpected
      ? state.approved_snapshot?.runtime_evidence?.jira_site_origin
      : state.runtime_evidence.jira_site_origin, created.key);
  if (targetExpected && state.target_mode !== true)
    return targetQuarantine(state, "Target classification stage flag tampered");
  if (state.target_mode) {
    if (state.stage !== "await_create" || approvedTargetSnapshotError(state))
      return targetQuarantine(state, "Create result outside approved Intent or immutable Preview stage");
    if (!verified) return targetQuarantine(state, "Target Create identity not verified");
    state.created_issue = { key: created.key, url: created.url };
    state.stage = "await_read";
    return { state, report: state.report, required_action: {
      type: "jira.read_required", request: { key: created.key,
        fields: ["issuetype", ...Object.values(TARGET_FIELDS)] },
    } };
  }
  if (!verified) return terminal(state, {
    mutation_status: "possibly_applied", verification_status: "not_verifiable",
    allowed_next_step: "Re-search Jira with the same contract evidence; automatic retry is false",
  });
  return terminal(state, {
    mutation_status: "applied", verification_status: "verified", allowed_next_step: "Report the verified Jira Issue and stop",
  });
}


/** Target mode: a durable, matching pre-Create Intent is mandatory. */
export function applyJiraIntentResult(state, result) {
  if (!state.target_mode || state.stage !== "await_intent" || !state.approved_snapshot?.target_create) return terminal(state, {
    approval_status: "blocked", allowed_next_step: "Unexpected Intent result; Create forbidden",
  });
  const snapshotProblem = approvedTargetSnapshotError(state, true);
  if (snapshotProblem) {
    state.stage = "intent_blocked";
    return terminal(state, { target_create_status: "intent_blocked", allowed_next_step: snapshotProblem });
  }
  const t = state.approved_snapshot.target_create;
  if (result?.status !== "persisted" || result?.durable !== true || result?.tool_call_count !== 1
    || result?.create_request_id !== t.request_id || result?.ledger_ref !== t.ledger_ref
    || result?.approved_preview_id !== state.preview_id
    || result?.activation_ref !== t.cutover.activation_ref
    || result?.created_new !== true || result?.prior_issue_key != null) {
    state.stage = "intent_blocked";
    return terminal(state, { target_create_status: "intent_blocked",
      allowed_next_step: "Durable pre-Create Intent not verified; Create forbidden" });
  }
  state.stage = "await_create";
  return { state, report: state.report, required_action: {
    type: "jira.create_required", preview_id: state.preview_id,
    request: buildJiraTicketCreateRequest(state.approved_snapshot),
  } };
}

/** Compare the actual Jira GET with the exact approved option snapshot. */
export function applyJiraReadResult(state, result) {
  if (!state.target_mode || state.stage !== "await_read" || !state.created_issue?.key
    || approvedTargetSnapshotError(state))
    return targetQuarantine(state, "Unexpected or incomplete post-Create read or Preview mismatch");
  const t = state.approved_snapshot.target_create;
  const expected = t.selection, f = result?.fields;
  const expectedConcern = expected.concerns.map(v => v.id).sort();
  const concern = f?.[TARGET_FIELDS.concern];
  const concernPresent = f && Object.hasOwn(f, TARGET_FIELDS.concern);
  const concernShape = concern === null || (Array.isArray(concern)
    && concern.every(v => typeof v?.id === "string" && /^\d+$/.test(v.id)));
  const actualConcern = Array.isArray(concern) ? concern.map(v => v?.id).sort() : [];
  const good = result?.tool_call_count === 1 && result?.key === state.created_issue.key
    && concernPresent && concernShape
    && result?.issue_type_id === t.create_metadata.issue_type_id
    && f?.[TARGET_FIELDS.product]?.id === expected.product.id
    && f?.[TARGET_FIELDS.component]?.id === expected.component.id
    && JSON.stringify(expectedConcern) === JSON.stringify(actualConcern);
  if (!good) return targetQuarantine(state, "Target Create Jira GET or option mismatch");
  state.stage = "await_origin";
  return { state, report: state.report, required_action: {
    type: "jira.origin_persist_required",
    request: { issue_key: state.created_issue.key, create_request_id: t.request_id,
      ledger_ref: t.ledger_ref, create_activation_ref: t.cutover.activation_ref,
      cutover_approval_ref: t.cutover.approval_ref, origin: "target_create",
      phase: "create_ready", read_authority: "target", write_authority: "target",
      verified_fields: { ...targetCreateFields(state.approved_snapshot, false),
        [TARGET_FIELDS.concern]: expectedConcern.map(id => ({ id })) }, legacy_snapshot_ref: "not_applicable" },
  } };
}

/** Report successful Target Create only after durable per-Issue Origin registration. */
export function applyJiraOriginResult(state, result) {
  if (!state.target_mode || state.stage !== "await_origin" || !state.created_issue?.key
    || approvedTargetSnapshotError(state))
    return targetQuarantine(state, "Unexpected or incomplete Origin confirmation or Preview mismatch");
  const t = state.approved_snapshot.target_create;
  if (result?.tool_call_count !== 1 || result?.status !== "persisted" || result?.durable !== true
    || result?.issue_key !== state.created_issue.key || result?.create_request_id !== t.request_id
    || result?.ledger_ref !== t.ledger_ref || result?.phase !== "create_ready"
    || result?.cutover_approval_ref !== t.cutover.approval_ref
    || result?.create_activation_ref !== t.cutover.activation_ref
    || result?.origin !== "target_create"
    || result?.read_authority !== "target" || result?.write_authority !== "target")
    return targetQuarantine(state, "Durable Target Origin registration failed");
  state.stage = "completed";
  return terminal(state, { mutation_status: "applied", verification_status: "verified",
    target_create_status: "create_ready", origin_status: "target_create",
    read_authority: "target", write_authority: "target",
    allowed_next_step: "Report the verified Target Issue and stop" });
}

/** Fixture convenience only; production uses the three stages through oh-my-ai jira-ticket. */
export async function runJiraTicketCreateWorkflow({ adapter, contract, metadata, approval }) {
  let step = beginJiraTicketCreateWorkflow({ runtime: adapter?.runtime, contract, metadata, capabilities: adapter?.capabilities, runtime_evidence: adapter?.runtime_evidence });
  if (step.required_action?.type !== "jira.search_required") return step.report;
  let search;
  try { search = await adapter.search(step.required_action.request); } catch { search = { status: "failed", tool_call_count: 1 }; }
  step = applyJiraSearchResult(step.state, search);
  if (step.required_action?.type !== "preview_required") return step.report;
  const normalizedApproval = approval?.current === true
    ? { status: "approved", preview_id: step.state.preview_id }
    : approval === "pending" ? { status: "pending" }
      : approval === "rejected" ? { status: "rejected" }
        : approval;
  step = applyJiraPreviewApproval(step.state, normalizedApproval);
  if (step.required_action?.type === "jira.intent_persist_required") {
    let intent;
    try { intent = await adapter.persistIntent(step.required_action.request); } catch { intent = null; }
    step = applyJiraIntentResult(step.state, intent);
  }
  if (step.required_action?.type !== "jira.create_required") return step.report;
  let created;
  try { created = await adapter.create(step.required_action.request); } catch { created = { kind: "timeout", tool_call_count: 1 }; }
  step = applyJiraCreateResult(step.state, created);
  if (step.required_action?.type === "jira.read_required") {
    let read;
    try { read = await adapter.read(step.required_action.request); } catch { read = null; }
    step = applyJiraReadResult(step.state, read);
  }
  if (step.required_action?.type === "jira.origin_persist_required") {
    let origin;
    try { origin = await adapter.persistOrigin(step.required_action.request); } catch { origin = null; }
    step = applyJiraOriginResult(step.state, origin);
  }
  return step.report;
}

export { BLOCKING_SENTINELS, CONTRACT_FIELDS, canonicalLabels, createDescription, missingCreateMetadata, previewId, searchRequest };
