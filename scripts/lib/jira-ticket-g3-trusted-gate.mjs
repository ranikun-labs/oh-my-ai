import { createHash, createPublicKey, verify } from "node:crypto";

const TARGET_FIELDS = {
  product: "customfield_10108",
  component: "customfield_10109",
  concern: "customfield_10110",
};
const TARGET_IDS = Object.values(TARGET_FIELDS);
const ISSUE_TYPE_IDS = { Task: "10010", Epic: "10007", Feature: "10009", Bug: "10012", Research: "10013" };
const SIGNED_KEYS = ["key_id", "payload", "signature"];

function canonical(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item, index) => canonical(item, `${path}[${index}]`)).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => {
      if (value[key] === undefined) throw new Error(`non-JSON evidence at ${path}.${key}`);
      return `${JSON.stringify(key)}:${canonical(value[key], `${path}.${key}`)}`;
    }).join(",")}}`;
  }
  throw new Error(`non-JSON evidence at ${path}`);
}

export function g3EvidenceSha256(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function timestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
    throw new Error(`invalid ${label}`);
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`invalid ${label}`);
  return result;
}

function keyFor(trustedKeys, keyId) {
  const value = trustedKeys instanceof Map ? trustedKeys.get(keyId) : trustedKeys?.[keyId];
  if (!value) throw new Error(`untrusted G3 signing key: ${keyId}`);
  try { return value?.type === "public" ? value : createPublicKey(value); }
  catch { throw new Error(`invalid pinned G3 public key: ${keyId}`); }
}

function pinKeys(trustedKeys) {
  const entries = trustedKeys instanceof Map ? [...trustedKeys.entries()] : Object.entries(trustedKeys ?? {});
  if (!entries.length) throw new Error("G3 signing key set is empty");
  const result = new Map();
  for (const [keyId, value] of entries) {
    if (typeof keyId !== "string" || !keyId.trim() || result.has(keyId)) throw new Error("invalid G3 signing key id");
    try { result.set(keyId, createPublicKey(value)); }
    catch { throw new Error(`invalid pinned G3 public key: ${keyId}`); }
  }
  return result;
}

/** Verify a signed, time-bounded JSON envelope using an independently pinned Ed25519 key. */
export function verifyG3SignedEvidence(envelope, trustedKeys, { now = Date.now(), maxAgeMs = 5 * 60_000 } = {}) {
  if (!Number.isFinite(now) || !(maxAgeMs >= 0)) throw new Error("invalid G3 evidence verification clock");
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || Object.keys(envelope).sort().join("|") !== SIGNED_KEYS.slice().sort().join("|")
    || typeof envelope.key_id !== "string" || typeof envelope.signature !== "string"
    || !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload))
    throw new Error("malformed signed G3 evidence");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.signature))
    throw new Error("malformed G3 evidence signature");
  const signature = Buffer.from(envelope.signature, "base64");
  if (signature.toString("base64") !== envelope.signature
    || !verify(null, Buffer.from(canonical(envelope.payload), "utf8"), keyFor(trustedKeys, envelope.key_id), signature))
    throw new Error("invalid G3 evidence signature");
  const issued = timestamp(envelope.payload.issued_at, "evidence issued_at");
  const expires = timestamp(envelope.payload.expires_at, "evidence expires_at");
  if (issued > now || now >= expires || expires <= issued || now - issued > maxAgeMs)
    throw new Error("expired, future-dated, or stale G3 evidence");
  return envelope.payload;
}

function requireRef(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing ${label}`);
  return value;
}

function isHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

function isCurrentActivation(payload, now, stage) {
  if (payload.kind !== "g3_activation" || payload.status !== "active"
    || typeof payload.activation_ref !== "string" || !payload.activation_ref.trim()
    || !payload.scope || typeof payload.scope !== "object"
    || !Object.values(ISSUE_TYPE_IDS).includes(payload.scope.issue_type_id)
    || ISSUE_TYPE_IDS[payload.scope.issue_type] !== payload.scope.issue_type_id
    || !isHash(payload.policy_sha256) || !isHash(payload.metadata_sha256)
    || !Array.isArray(payload.scope.operations) || !payload.scope.operations.includes(stage))
    throw new Error("G3 Activation does not authorize this stage");
  const from = timestamp(payload.effective_from, "Activation effective_from");
  const to = timestamp(payload.effective_to, "Activation effective_to");
  if (from > now || now >= to) throw new Error("G3 Activation is outside its effective window");
  requireRef(payload.owner_approval_ref, "Owner approval reference");
  return payload;
}

function metadataContent(payload) {
  return { project: payload.project, issue_type: payload.issue_type,
    issue_type_id: payload.issue_type_id, fields: payload.fields };
}

function matchesPolicyAndMetadata(activation, policy, metadata) {
  const scope = activation.scope;
  if (policy.kind !== "g3_policy" || policy.status !== "active"
    || policy.policy_sha256 !== activation.policy_sha256
    || policy.project !== scope.project || policy.allowed_issue_types?.[scope.issue_type] !== scope.issue_type_id
    || policy.mode !== "single_supervised" || !Array.isArray(policy.allowed_create_fields)
    || new Set(policy.allowed_create_fields).size !== policy.allowed_create_fields.length
    || !Number.isInteger(policy.max_concerns) || policy.max_concerns < 0 || policy.max_concerns > 3)
    throw new Error("current G3 policy does not match Activation scope");
  const metadataHash = g3EvidenceSha256(metadataContent(metadata));
  if (metadata.kind !== "g3_live_metadata" || metadata.project !== scope.project
    || metadata.issue_type !== scope.issue_type || metadata.issue_type_id !== scope.issue_type_id
    || metadata.metadata_sha256 !== metadataHash || activation.metadata_sha256 !== metadataHash
    || !metadata.fields || typeof metadata.fields !== "object")
    throw new Error("live Jira metadata does not match Activation snapshot");
  const observedAt = timestamp(metadata.observed_at, "metadata observed_at");
  const issuedAt = timestamp(metadata.issued_at, "metadata issued_at");
  if (observedAt > issuedAt) throw new Error("live Jira metadata observation is future-dated");
  const product = metadata.fields[TARGET_FIELDS.product], component = metadata.fields[TARGET_FIELDS.component];
  const concern = metadata.fields[TARGET_FIELDS.concern];
  const selectSchema = f => f?.schema?.type === "option"
    && f.schema.custom === "com.atlassian.jira.plugin.system.customfieldtypes:select";
  if (product?.required !== true || component?.required !== true || concern?.required !== false
    || product.hasDefaultValue !== false || component.hasDefaultValue !== false || concern.hasDefaultValue !== false
    || product.defaultValue != null || component.defaultValue != null || concern.defaultValue != null
    || !selectSchema(product) || !selectSchema(component)
    || concern.schema?.type !== "array" || concern.schema?.items !== "option"
    || concern.schema?.custom !== "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes"
    || !Array.isArray(product.allowedValues) || !Array.isArray(component.allowedValues)
    || !Array.isArray(concern.allowedValues))
    throw new Error("live Jira Target field schema is not approved");
  return { policy, metadata, policy_sha256: policy.policy_sha256 };
}

function assertTargetOptions(fields, metadata, policy) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("missing approved Create fields");
  if (Object.keys(fields).some(id => !policy.allowed_create_fields.includes(id)))
    throw new Error("Create fields exceed current G3 policy scope");
  const productId = fields[TARGET_FIELDS.product]?.id, componentId = fields[TARGET_FIELDS.component]?.id;
  const concerns = fields[TARGET_FIELDS.concern] ?? [];
  if (typeof productId !== "string" || typeof componentId !== "string"
    || Object.keys(fields[TARGET_FIELDS.product] ?? {}).join("|") !== "id"
    || Object.keys(fields[TARGET_FIELDS.component] ?? {}).join("|") !== "id"
    || (Object.hasOwn(fields, TARGET_FIELDS.concern) && !Array.isArray(fields[TARGET_FIELDS.concern]))
    || !Array.isArray(concerns) || concerns.length > policy.max_concerns
    || new Set(concerns.map(value => value?.id)).size !== concerns.length
    || concerns.some(value => typeof value?.id !== "string" || Object.keys(value).join("|") !== "id"))
    throw new Error("Create Target option shape violates current G3 policy");
  const hasOption = (field, id) => metadata.fields[field].allowedValues.some(option => option?.id === id);
  if (!hasOption(TARGET_FIELDS.product, productId) || !hasOption(TARGET_FIELDS.component, componentId)
    || concerns.some(value => !hasOption(TARGET_FIELDS.concern, value.id)))
    throw new Error("Create option is absent from current Jira metadata");
}

function targetsOnly(fields) {
  return {
    [TARGET_FIELDS.product]: fields?.[TARGET_FIELDS.product] ?? null,
    [TARGET_FIELDS.component]: fields?.[TARGET_FIELDS.component] ?? null,
    [TARGET_FIELDS.concern]: fields?.[TARGET_FIELDS.concern] ?? [],
  };
}

function signedRef(envelopes) {
  return "signed-g3:" + g3EvidenceSha256(envelopes.map(({ key_id, payload, signature }) => ({ key_id, payload, signature })));
}

/**
 * Build the adapter's verifyGate from authenticated, independently supplied evidence.
 * `source` methods fetch signed records; `claimReplay` must perform durable atomic CAS.
 */
export function createG3TrustedGate({ source, trustedKeys, now = Date.now, maxEvidenceAgeMs = 5 * 60_000 }) {
  const required = ["fetchActivation", "fetchCurrentActivation", "fetchPolicy", "fetchLiveMetadata",
    "fetchOwnerApproval", "claimReplay"];
  if (!source || required.some(name => typeof source[name] !== "function")
    || !trustedKeys || typeof now !== "function" || !Number.isFinite(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0)
    throw new Error("G3 trusted gate requires signed evidence sources, pinned keys, and durable replay claims");
  const pinnedKeys = pinKeys(trustedKeys);

  const bindings = new Map();
  const completed = new Set();

  function refreshRecords(records, stage, additionalEnvelopes = []) {
    const time = now();
    if (!Number.isFinite(time)) throw new Error("invalid G3 gate clock");
    const activation = verifyG3SignedEvidence(records.activationEnvelope, pinnedKeys,
      { now: time, maxAgeMs: maxEvidenceAgeMs });
    const policy = verifyG3SignedEvidence(records.policyEnvelope, pinnedKeys,
      { now: time, maxAgeMs: maxEvidenceAgeMs });
    const metadata = verifyG3SignedEvidence(records.metadataEnvelope, pinnedKeys,
      { now: time, maxAgeMs: maxEvidenceAgeMs });
    isCurrentActivation(activation, time, stage);
    matchesPolicyAndMetadata(activation, policy, metadata);
    const ageLimit = Math.min(maxEvidenceAgeMs, policy.max_metadata_age_ms ?? maxEvidenceAgeMs);
    if (time - timestamp(metadata.observed_at, "metadata observed_at") > ageLimit)
      throw new Error("live Jira metadata is stale");
    for (const envelope of additionalEnvelopes)
      verifyG3SignedEvidence(envelope, pinnedKeys, { now: time, maxAgeMs: maxEvidenceAgeMs });
    return time;
  }

  async function loadEvidence(stage, context, { current = false } = {}) {
    const activationEnvelope = current
      ? await source.fetchCurrentActivation({ project: context.project })
      : await source.fetchActivation({ activation_ref: context.activation_ref,
        project: context.project, issue_type: context.issue_type });
    const activationTime = now();
    if (!Number.isFinite(activationTime)) throw new Error("invalid G3 gate clock");
    const activation = verifyG3SignedEvidence(activationEnvelope, pinnedKeys,
      { now: activationTime, maxAgeMs: maxEvidenceAgeMs });
    isCurrentActivation(activation, activationTime, stage);
    if (!current && (activation.activation_ref !== context.activation_ref
      || activation.scope.project !== context.project || activation.scope.issue_type !== context.issue_type))
      throw new Error("G3 Activation scope mismatch");
    if (current && activation.scope.project !== context.project)
      throw new Error("current G3 Activation project mismatch");
    const [policyEnvelope, metadataEnvelope] = await Promise.all([
      source.fetchPolicy({ policy_sha256: activation.policy_sha256 }),
      source.fetchLiveMetadata({ project: activation.scope.project, issue_type: activation.scope.issue_type }),
    ]);
    const time = now();
    if (!Number.isFinite(time)) throw new Error("invalid G3 gate clock");
    const policy = verifyG3SignedEvidence(policyEnvelope, pinnedKeys, { now: time, maxAgeMs: maxEvidenceAgeMs });
    const metadata = verifyG3SignedEvidence(metadataEnvelope, pinnedKeys, { now: time, maxAgeMs: maxEvidenceAgeMs });
    matchesPolicyAndMetadata(activation, policy, metadata);
    const ageLimit = Math.min(maxEvidenceAgeMs, policy.max_metadata_age_ms ?? maxEvidenceAgeMs);
    if (time - timestamp(metadata.observed_at, "metadata observed_at") > ageLimit)
      throw new Error("live Jira metadata is stale");
    const records = { activation, activationEnvelope, policy, policyEnvelope, metadata, metadataEnvelope, time };
    records.time = refreshRecords(records, stage);
    return records;
  }

  async function ownerEvidence(records, context) {
    const envelope = await source.fetchOwnerApproval({ approval_ref: records.activation.owner_approval_ref,
      create_request_id: context.create_request_id });
    const evidenceTime = now();
    const approval = verifyG3SignedEvidence(envelope, pinnedKeys, { now: evidenceTime, maxAgeMs: maxEvidenceAgeMs });
    if (approval.kind !== "g3_owner_approval" || approval.status !== "approved"
      || approval.approval_ref !== records.activation.owner_approval_ref
      || approval.activation_ref !== records.activation.activation_ref
      || approval.policy_sha256 !== records.policy.policy_sha256
      || approval.project !== records.activation.scope.project
      || approval.issue_type !== records.activation.scope.issue_type
      || approval.issue_type_id !== records.activation.scope.issue_type_id
      || approval.ledger_ref !== records.activation.scope.ledger_ref
      || approval.create_request_id !== context.create_request_id
      || approval.approved_preview_id !== context.approved_preview_id
      || !isHash(approval.approved_preview_id) || !isHash(approval.fields_sha256)
      || !isHash(approval.create_request_sha256))
      throw new Error("Owner approval does not bind this exact G3 request and Preview");
    if (timestamp(approval.expires_at, "Owner approval expires_at") > timestamp(records.activation.expires_at, "Activation expires_at"))
      throw new Error("Owner approval outlives G3 Activation");
    records.time = refreshRecords(records, "intent", [envelope]);
    return { approval, envelope };
  }

  return async function verifyGate({ stage, context }) {
    if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error("missing G3 gate context");
    context = structuredClone(context);
    if (stage === "search" || stage === "authority_read") {
      const project = stage === "search" ? context.project : "RPL";
      if (stage === "authority_read" && !/^RPL-[1-9][0-9]*$/.test(context.issue_key ?? ""))
        throw new Error("invalid G3 authority-read IssueKey");
      if (project !== "RPL") throw new Error("G3 project outside approved scope");
      const records = await loadEvidence(stage, { project }, { current: true });
      records.time = refreshRecords(records, stage);
      return { allowed: true, evidence_ref: signedRef([records.activationEnvelope, records.policyEnvelope, records.metadataEnvelope]) };
    }
    if (!["intent", "create", "read", "origin"].includes(stage)) throw new Error("unsupported G3 gate stage");

    const request = stage === "create" ? context.request : context;
    const createRequestId = stage === "create" ? context.create_request_id : context.create_request_id;
    const binding = bindings.get(createRequestId);
    const activationRef = stage === "intent" ? context.activation_ref : context.activation_ref ?? binding?.activation_ref;
    const project = stage === "create" ? request?.project : stage === "intent" ? "RPL" : binding?.project;
    const issueType = stage === "create" ? request?.issue_type : stage === "intent" ? context.issue_type : binding?.issue_type;
    const previewId = stage === "intent" ? context.approved_preview_id : binding?.approved_preview_id;
    const records = await loadEvidence(stage, { activation_ref: activationRef, project, issue_type: issueType });
    const { activation, policy, metadata } = records;
    if (activation.scope.ledger_ref !== context.ledger_ref && stage === "intent")
      throw new Error("G3 ledger reference is outside Activation scope");
    if (stage === "intent") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(context.create_request_id ?? "")
        || context.ledger_ref !== activation.scope.ledger_ref
        || context.create_request_id !== activation.scope.request_id
        || context.approved_preview_id !== activation.scope.approved_preview_id
        || context.issue_type !== activation.scope.issue_type || context.status !== "pending"
        || bindings.has(context.create_request_id) || completed.has(context.create_request_id))
        throw new Error("Intent request is outside one-time G3 Activation scope");
      assertTargetOptions(context.fields, metadata, policy);
      const { approval, envelope: approvalEnvelope } = await ownerEvidence(records, context);
      if (approval.fields_sha256 !== g3EvidenceSha256(context.fields))
        throw new Error("Owner approval does not bind the immutable Intent fields");
      const claimKey = g3EvidenceSha256({ activation_ref: activation.activation_ref,
        create_request_id: context.create_request_id, approved_preview_id: context.approved_preview_id });
      const claimEnvelope = await source.claimReplay({ claim_key: claimKey, activation_ref: activation.activation_ref,
        create_request_id: context.create_request_id, approved_preview_id: context.approved_preview_id,
        expires_at: activation.expires_at });
      const claimTime = now();
      const claim = verifyG3SignedEvidence(claimEnvelope, pinnedKeys, { now: claimTime, maxAgeMs: maxEvidenceAgeMs });
      if (claim.kind !== "g3_replay_claim" || claim.status !== "claimed" || claim.claim_key !== claimKey
        || claim.activation_ref !== activation.activation_ref || claim.create_request_id !== context.create_request_id
        || claim.approved_preview_id !== context.approved_preview_id)
        throw new Error("CreateRequestId replay or invalid durable G3 claim");
      records.time = refreshRecords(records, stage, [approvalEnvelope, claimEnvelope]);
      const bindingRecord = { activation_ref: activation.activation_ref, project, issue_type: issueType,
        ledger_ref: context.ledger_ref, create_request_id: context.create_request_id,
        approved_preview_id: context.approved_preview_id, fields_sha256: g3EvidenceSha256(context.fields),
        target_sha256: g3EvidenceSha256(targetsOnly(context.fields)), approval_ref: approval.approval_ref,
        create_request_sha256: approval.create_request_sha256, approvalEnvelope,
        read_key: null, create_attempted: false, origin_attempted: false };
      bindings.set(context.create_request_id, bindingRecord);
      return { allowed: true, evidence_ref: signedRef([records.activationEnvelope, records.policyEnvelope,
        records.metadataEnvelope, approvalEnvelope, claimEnvelope]), cutover_approval_ref: approval.approval_ref };
    }

    const ledgerRef = stage === "intent" ? context.ledger_ref : binding?.ledger_ref;
    if (!binding || binding.activation_ref !== activation.activation_ref
      || binding.ledger_ref !== ledgerRef || previewId !== activation.scope.approved_preview_id)
      throw new Error("G3 stage has no matching in-memory durable Intent authorization");
    const approval = verifyG3SignedEvidence(binding.approvalEnvelope, pinnedKeys,
      { now: now(), maxAgeMs: maxEvidenceAgeMs });
    if (approval.approval_ref !== binding.approval_ref || approval.approved_preview_id !== previewId
      || approval.create_request_id !== createRequestId)
      throw new Error("G3 Owner approval expired or changed during the request");

    if (stage === "create") {
      if (binding.create_attempted || activation.scope.request_id !== createRequestId
        || activation.scope.approved_preview_id !== previewId || request?.project !== project
        || request?.issue_type !== issueType || g3EvidenceSha256(request.fields ?? {}) !== binding.fields_sha256
        || g3EvidenceSha256(request) !== binding.create_request_sha256)
        throw new Error("Jira Create request differs from exact Owner-approved Preview");
      assertTargetOptions(request.fields, metadata, policy);
    } else if (stage === "read") {
      const read = context;
      const expected = ["issuetype", ...TARGET_IDS];
      if (!binding.create_attempted || binding.read_key || !/^RPL-[1-9][0-9]*$/.test(read?.key ?? "")
        || !Array.isArray(read?.fields) || read.fields.join("|") !== expected.join("|")
        || read.key !== binding.read_key && binding.read_key !== null)
        throw new Error("Jira GET is outside the approved single Create read scope");
    } else {
      if (!binding.create_attempted || !binding.read_key || binding.origin_attempted
        || context.issue_key !== binding.read_key || context.create_activation_ref !== activation.activation_ref
        || context.cutover_approval_ref !== binding.approval_ref || context.ledger_ref !== binding.ledger_ref
        || context.origin !== "target_create" || context.phase !== "create_ready"
        || context.read_authority !== "target" || context.write_authority !== "target"
        || Object.keys(context.verified_fields ?? {}).sort().join("|") !== TARGET_IDS.slice().sort().join("|")
        || TARGET_IDS.slice(0, 2).some(id => Object.keys(context.verified_fields?.[id] ?? {}).join("|") !== "id")
        || !Array.isArray(context.verified_fields?.[TARGET_FIELDS.concern])
        || (context.verified_fields?.[TARGET_FIELDS.concern] ?? []).some(value =>
          Object.keys(value ?? {}).join("|") !== "id" || typeof value?.id !== "string")
        || g3EvidenceSha256(targetsOnly(context.verified_fields)) !== binding.target_sha256)
        throw new Error("Origin does not match exact approved and read-back G3 Intent");
    }
    records.time = refreshRecords(records, stage, [binding.approvalEnvelope]);
    if (stage === "create") binding.create_attempted = true;
    else if (stage === "read") binding.read_key = context.key;
    else {
      binding.origin_attempted = true;
      completed.add(createRequestId);
    }
    return { allowed: true, evidence_ref: signedRef([records.activationEnvelope, records.policyEnvelope,
      records.metadataEnvelope, binding.approvalEnvelope]), cutover_approval_ref: binding.approval_ref };
  };
}
