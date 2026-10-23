/**
 * Read-only G3 authority resolver and Board/Filter/Automation projection.
 *
 * This module has no Jira or evidence-store connection of its own. The injected
 * Legacy resolver must authenticate its source records before returning them;
 * callers cannot pass evidence to a read method. Target authority is accepted
 * only from the supervised Adapter's Origin + Jira GET reader.
 */

const KEY = /^RPL-[1-9][0-9]*$/;
const FROZEN_KEYS = new Set(["RPL-112", "RPL-113", "RPL-114"]);
const TYPE_IDS = Object.freeze({ Task: "10010", Epic: "10007", Feature: "10009",
  Bug: "10012", Research: "10013" });
const LEGACY_FIELDS = Object.freeze({
  product: "customfield_10042",
  component: "customfield_10043",
  labels: "customfield_10044",
});
const TARGET_FIELDS = Object.freeze({
  product: "customfield_10108",
  component: "customfield_10109",
  concern: "customfield_10110",
});
const LEGACY_GET_FIELDS = Object.freeze(["issuetype", ...Object.values(LEGACY_FIELDS)]);

const nonEmpty = value => typeof value === "string" && value.trim().length > 0;
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function optionId(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (isRecord(value) && typeof value.id === "string" && value.id.trim()) return value.id;
  return null;
}

function optionIds(value, { nullable = false } = {}) {
  if (value === null && nullable) return [];
  if (!Array.isArray(value)) return null;
  const ids = value.map(optionId);
  if (ids.some(id => id === null) || new Set(ids).size !== ids.length) return null;
  return [...ids].sort();
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeUnknown(issueKey, reason = "evidence_unverified") {
  return {
    status: "unknown",
    issue_key: typeof issueKey === "string" ? issueKey : null,
    origin: "UNKNOWN_ORIGIN",
    phase: "create_quarantined",
    read_authority: "none",
    write_authority: "frozen",
    classification: null,
    reason,
  };
}

function readTargetFields(value) {
  if (!isRecord(value)) return null;
  const productValue = value[TARGET_FIELDS.product] ?? value.product;
  const componentValue = value[TARGET_FIELDS.component] ?? value.component;
  const concernValue = value[TARGET_FIELDS.concern] ?? value.concern;
  if (!isRecord(productValue) || !isRecord(componentValue)) return null;
  const product = optionId(productValue);
  const component = optionId(componentValue);
  const concern = optionIds(concernValue, { nullable: true });
  if (!product || !component || concern === null) return null;
  return { product, component, concern };
}

function targetSnapshotFields(snapshot) {
  if (!isRecord(snapshot)) return null;
  return readTargetFields(snapshot);
}

function legacyFields(value) {
  if (!isRecord(value)) return null;
  const product = optionIds(value[LEGACY_FIELDS.product]);
  const component = optionIds(value[LEGACY_FIELDS.component]);
  const labels = optionIds(value[LEGACY_FIELDS.labels], { nullable: true });
  if (product === null || component === null || labels === null) return null;
  return { product, component, labels };
}

function validateVerifiedHeader(value, { issueKey, source, status = "verified" } = {}) {
  return isRecord(value) && value.status === status && value.source === source
    && value.issue_key === issueKey && value.verified === true && nonEmpty(value.evidence_ref);
}

function parseLegacyProof(value, issueKey) {
  if (!validateVerifiedHeader(value, { issueKey,
    source: "legacy_manifest_migration_history" })) return null;
  if (value.mode === "legacy_retained") {
    const { manifest, migration, history } = value;
    if (!validateVerifiedHeader(manifest, { issueKey, source: "legacy_manifest" })
      || !validateVerifiedHeader(migration, { issueKey, source: "legacy_migration" })
      || !validateVerifiedHeader(history, { issueKey, source: "jira_issue_history" })) return null;
    if (!Object.hasOwn(TYPE_IDS, manifest.issue_type)
      || manifest.project !== "RPL"
      || manifest.issue_type_id !== TYPE_IDS[manifest.issue_type]
      || history.issue_type !== manifest.issue_type
      || history.issue_type_id !== manifest.issue_type_id
      || history.manifest_ref !== manifest.evidence_ref
      || history.migration_ref !== migration.evidence_ref
      || migration.manifest_ref !== manifest.evidence_ref
      || migration.history_ref !== history.evidence_ref
      || !["staged", "verified"].includes(migration.state)
      || migration.classification_authority !== "legacy") return null;
    const fromManifest = legacyFields(manifest.fields);
    const fromHistory = legacyFields(history.fields);
    if (!fromManifest || !fromHistory
      || !sameArray(fromManifest.product, fromHistory.product)
      || !sameArray(fromManifest.component, fromHistory.component)
      || !sameArray(fromManifest.labels, fromHistory.labels)) return null;
    return {
      kind: "legacy_retained", issue_type: manifest.issue_type,
      issue_type_id: manifest.issue_type_id, fields: fromManifest,
      migration_state: migration.state,
      evidence_refs: { manifest: manifest.evidence_ref, migration: migration.evidence_ref,
        history: history.evidence_ref },
    };
  }
  if (value.mode === "migrated_target") {
    const { cutover, snapshot, parity } = value;
    if (!validateVerifiedHeader(cutover, { issueKey, source: "owner_cutover", status: "approved" })
      || !validateVerifiedHeader(snapshot, { issueKey, source: "target_migration_snapshot" })
      || !validateVerifiedHeader(parity, { issueKey, source: "migration_parity" })) return null;
    const fields = targetSnapshotFields(snapshot.fields);
    if (!fields || !Object.hasOwn(TYPE_IDS, snapshot.issue_type)
      || snapshot.issue_type_id !== TYPE_IDS[snapshot.issue_type]
      || parity.origin !== "legacy_migration"
      || parity.snapshot_ref !== snapshot.evidence_ref
      || parity.cutover_ref !== cutover.evidence_ref
      || parity.issue_type !== snapshot.issue_type
      || parity.issue_type_id !== snapshot.issue_type_id) return null;
    return {
      kind: "migrated_target", issue_type: snapshot.issue_type,
      issue_type_id: snapshot.issue_type_id, fields,
      evidence_refs: { cutover: cutover.evidence_ref, snapshot: snapshot.evidence_ref,
        parity: parity.evidence_ref },
    };
  }
  return null;
}

function parseNotLegacy(value, issueKey) {
  return validateVerifiedHeader(value, { issueKey,
    source: "legacy_manifest_migration_history", status: "not_legacy" });
}

function validateTargetResult(value, issueKey, migrationProof) {
  try {
    if (!isRecord(value) || value.read_authority !== "target"
      || value.write_authority !== "target"
      || value.source !== "jira_get_and_durable_origin"
      || (value.issue_key !== undefined && value.issue_key !== issueKey)
      || (value.key !== undefined && value.key !== issueKey)
      || !Object.hasOwn(TYPE_IDS, value.issue_type)) return null;
    const phase = value.origin === "target_create" ? "create_ready"
      : value.origin === "legacy_migration" ? "cutover" : null;
    if (phase === null || value.phase !== phase) return null;
    if (value.issue_type_id !== undefined && value.issue_type_id !== TYPE_IDS[value.issue_type]) return null;
    const fields = readTargetFields(value);
    if (!fields) return null;
    if (value.origin === "target_create") {
      return { origin: "target_create", phase, fields, issue_type: value.issue_type };
    }
    if (value.origin !== "legacy_migration" || migrationProof?.kind !== "migrated_target"
      || value.issue_type !== migrationProof.issue_type
      || fields.product !== migrationProof.fields.product
      || fields.component !== migrationProof.fields.component
      || !sameArray(fields.concern, migrationProof.fields.concern)) return null;
    return { origin: "legacy_migration", phase, fields, issue_type: value.issue_type };
  } catch {
    return null;
  }
}

function targetProjection(issueKey, target, migrationProof) {
  return {
    status: "classified",
    issue_key: issueKey,
    origin: target.origin,
    phase: target.phase,
    read_authority: "target",
    write_authority: "target",
    issue_type: target.issue_type,
    classification: {
      authority: "target",
      fields: {
        [TARGET_FIELDS.product]: { id: target.fields.product },
        [TARGET_FIELDS.component]: { id: target.fields.component },
        [TARGET_FIELDS.concern]: target.fields.concern.map(id => ({ id })),
      },
    },
    ...(target.origin === "legacy_migration"
      ? { migration_evidence: { ...migrationProof.evidence_refs } } : {}),
  };
}

function legacyProjection(issueKey, proof) {
  return {
    status: "classified",
    issue_key: issueKey,
    origin: "legacy_retained",
    phase: "migration_" + proof.migration_state,
    read_authority: "legacy",
    write_authority: "frozen",
    issue_type: proof.issue_type,
    classification: {
      authority: "legacy",
      fields: {
        [LEGACY_FIELDS.product]: proof.fields.product.map(id => ({ id })),
        [LEGACY_FIELDS.component]: proof.fields.component.map(id => ({ id })),
        [LEGACY_FIELDS.labels]: proof.fields.labels.map(id => ({ id })),
      },
    },
    legacy_evidence: { ...proof.evidence_refs, jira_get_parity: "verified" },
  };
}

/**
 * Compose trusted Legacy provenance, supervised Target Origin+GET, and a
 * Jira GET for retained-Legacy parity. Evidence is supplied only by the
 * injected resolver; read methods accept an IssueKey only.
 */
export function createG3AuthorityReader({ targetReader, resolveLegacyEvidence, jira }) {
  if (typeof targetReader?.readVerifiedClassification !== "function"
    || typeof resolveLegacyEvidence !== "function" || typeof jira?.read !== "function")
    throw new Error("G3 Reader requires a supervised Target reader, trusted Legacy evidence resolver, and Jira GET");

  async function readLegacyParity(issueKey, proof) {
    try {
      const current = await jira.read({ key: issueKey, fields: [...LEGACY_GET_FIELDS] });
      const actual = legacyFields(current?.fields);
      return current?.key === issueKey && current?.tool_call_count === 1
        && current?.issue_type_id === proof.issue_type_id
        && (current?.issue_type === undefined || current.issue_type === proof.issue_type)
        && actual !== null
        && sameArray(actual.product, proof.fields.product)
        && sameArray(actual.component, proof.fields.component)
        && sameArray(actual.labels, proof.fields.labels);
    } catch {
      return false;
    }
  }

  async function readClassification(issueKey) {
    if (typeof issueKey !== "string" || !KEY.test(issueKey)) return safeUnknown(issueKey, "invalid_issue_key");
    if (FROZEN_KEYS.has(issueKey)) return safeUnknown(issueKey, "protected_issue_key");

    let evidence;
    try { evidence = await resolveLegacyEvidence({ issue_key: issueKey }); }
    catch { return safeUnknown(issueKey, "legacy_evidence_unavailable"); }

    let explicitlyNotLegacy = false;
    try { explicitlyNotLegacy = parseNotLegacy(evidence, issueKey); }
    catch { return safeUnknown(issueKey, "legacy_evidence_unverified"); }
    if (explicitlyNotLegacy) {
      let targetResult;
      try { targetResult = await targetReader.readVerifiedClassification(issueKey); }
      catch { return safeUnknown(issueKey, "target_evidence_unavailable"); }
      const target = validateTargetResult(targetResult, issueKey, null);
      return target ? targetProjection(issueKey, target, null)
        : safeUnknown(issueKey, "target_origin_or_get_unverified");
    }

    let proof;
    try { proof = parseLegacyProof(evidence, issueKey); }
    catch { return safeUnknown(issueKey, "legacy_evidence_unverified"); }
    if (!proof) return safeUnknown(issueKey, "legacy_evidence_unverified");
    if (proof.kind === "legacy_retained") {
      if (!await readLegacyParity(issueKey, proof))
        return safeUnknown(issueKey, "legacy_jira_parity_unverified");
      return legacyProjection(issueKey, proof);
    }

    // A migrated Target needs independent cutover, snapshot, and parity proof
    // in addition to the supervised Adapter's Origin + live Jira GET result.
    let targetResult;
    try { targetResult = await targetReader.readVerifiedClassification(issueKey); }
    catch { return safeUnknown(issueKey, "target_evidence_unavailable"); }
    const target = validateTargetResult(targetResult, issueKey, proof);
    return target ? targetProjection(issueKey, target, proof)
      : safeUnknown(issueKey, "migrated_target_evidence_unverified");
  }

  async function projectReadOnlyView(issueKeys) {
    if (!Array.isArray(issueKeys)) throw new TypeError("projection requires an IssueKey array");
    const items = [];
    for (const issueKey of issueKeys) items.push(await readClassification(issueKey));
    const aggregate = { total: items.length, classified_count: 0,
      unknown_count: 0, by_authority: { legacy: 0, target: 0 } };
    for (const item of items) {
      if (item.read_authority === "legacy" || item.read_authority === "target") {
        aggregate.classified_count++;
        aggregate.by_authority[item.read_authority]++;
      } else {
        aggregate.unknown_count++;
      }
    }
    return { read_only: true, items, aggregate };
  }

  return Object.freeze({ readClassification, projectReadOnlyView });
}
