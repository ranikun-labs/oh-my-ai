const freeze = values => Object.freeze([...values]);

export const PENDING_HANDOFF_SCHEMA_VERSION = "1.0";

export const PENDING_HANDOFF_STATUSES = freeze([
  "candidate",
  "pending",
  "claimed",
  "delivered",
  "consumed",
  "expired",
  "invalid",
]);

export const PENDING_HANDOFF_TERMINAL_STATUSES = freeze([
  "consumed",
  "expired",
  "invalid",
]);

export const PENDING_HANDOFF_EVENTS = freeze([
  "register",
  "claim",
  "confirm_delivery",
  "consume",
  "expire",
  "invalidate",
  "release_before_delivery",
  "lease_expired",
]);

export const CONTEXT_CHECKPOINT_STATUSES = freeze([
  "checkpointed",
  "no_update",
  "review_needed",
  "unknown",
]);

const REQUIRED_FIELDS = freeze([
  "candidate_id",
  "schema_version",
  "status",
  "created_at",
  "expires_at",
  "source_runtime",
  "source_session_identity",
  "repository_identity",
  "worktree_identity",
  "goal",
  "completed",
  "open_issues",
  "verification",
  "do_not_touch",
  "next_action",
  "context_checkpoint_status",
  "privacy_redaction_status",
]);

const NON_EMPTY_STRING_FIELDS = freeze([
  "candidate_id",
  "source_runtime",
  "source_session_identity",
  "repository_identity",
  "worktree_identity",
  "goal",
  "next_action",
]);

const STRING_ARRAY_FIELDS = freeze([
  "completed",
  "open_issues",
  "verification",
  "do_not_touch",
]);

const FORBIDDEN_FIELDS = new Set([
  "raw_session_id",
  "prompt",
  "raw_prompt",
  "response",
  "raw_response",
  "tool_output",
  "raw_tool_output",
  "file_content",
  "diff",
  "secret",
  "token",
  "credential",
  "environment",
  "environment_variables",
  "remote_url",
  "worktree_path",
  "absolute_worktree_path",
]);

const ALLOWED_FIELDS = new Set(REQUIRED_FIELDS);
const STATUS_SET = new Set(PENDING_HANDOFF_STATUSES);
const TERMINAL_STATUS_SET = new Set(PENDING_HANDOFF_TERMINAL_STATUSES);
const EVENT_SET = new Set(PENDING_HANDOFF_EVENTS);
const CHECKPOINT_STATUS_SET = new Set(CONTEXT_CHECKPOINT_STATUSES);

export function validateCandidate(candidate) {
  const errors = [];
  if (!isPlainObject(candidate)) {
    return {
      ok: false,
      errors: [validationError(
        "candidate_not_plain_object",
        null,
        "Candidate must be a plain object.",
      )],
    };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(candidate, field)) {
      errors.push(validationError(
        "required_field_missing",
        field,
        `Required field is missing: ${field}.`,
      ));
    }
  }

  for (const field of NON_EMPTY_STRING_FIELDS) {
    if (Object.hasOwn(candidate, field) && !isNonEmptyString(candidate[field])) {
      errors.push(validationError(
        "invalid_field_type",
        field,
        `${field} must be a non-empty string.`,
      ));
    }
  }

  for (const field of STRING_ARRAY_FIELDS) {
    if (!Object.hasOwn(candidate, field)) continue;
    if (!Array.isArray(candidate[field])) {
      errors.push(validationError(
        "invalid_field_type",
        field,
        `${field} must be an array of strings.`,
      ));
    } else {
      // Per-item errors carry the index so a caller can point at the offending
      // entry. Blank items are rejected for the same reason scalar string fields
      // are: an all-whitespace summary line carries no handoff meaning.
      candidate[field].forEach((value, index) => {
        if (typeof value !== "string") {
          errors.push(validationError(
            "invalid_array_item",
            `${field}[${index}]`,
            `${field}[${index}] must be a string.`,
          ));
        } else if (value.trim().length === 0) {
          errors.push(validationError(
            "invalid_array_item",
            `${field}[${index}]`,
            `${field}[${index}] must not be a blank string.`,
          ));
        }
      });
    }
  }

  if (
    Object.hasOwn(candidate, "schema_version")
    && candidate.schema_version !== PENDING_HANDOFF_SCHEMA_VERSION
  ) {
    errors.push(validationError(
      "unsupported_schema_version",
      "schema_version",
      `Unsupported schema version: ${String(candidate.schema_version)}.`,
    ));
  }

  if (Object.hasOwn(candidate, "status") && !STATUS_SET.has(candidate.status)) {
    errors.push(validationError(
      "unsupported_status",
      "status",
      `Unsupported pending handoff status: ${String(candidate.status)}.`,
    ));
  }

  const createdAtValid = !Object.hasOwn(candidate, "created_at")
    || isUtcIsoTimestamp(candidate.created_at);
  const expiresAtValid = !Object.hasOwn(candidate, "expires_at")
    || isUtcIsoTimestamp(candidate.expires_at);
  if (!createdAtValid) {
    errors.push(validationError(
      "invalid_timestamp",
      "created_at",
      "created_at must be a valid ISO UTC timestamp.",
    ));
  }
  if (!expiresAtValid) {
    errors.push(validationError(
      "invalid_timestamp",
      "expires_at",
      "expires_at must be a valid ISO UTC timestamp.",
    ));
  }
  if (
    Object.hasOwn(candidate, "created_at")
    && Object.hasOwn(candidate, "expires_at")
    && createdAtValid
    && expiresAtValid
    && Date.parse(candidate.expires_at) <= Date.parse(candidate.created_at)
  ) {
    errors.push(validationError(
      "invalid_timestamp_order",
      "expires_at",
      "expires_at must be later than created_at.",
    ));
  }

  if (
    Object.hasOwn(candidate, "context_checkpoint_status")
    && !CHECKPOINT_STATUS_SET.has(candidate.context_checkpoint_status)
  ) {
    errors.push(validationError(
      "unsupported_context_checkpoint_status",
      "context_checkpoint_status",
      `Unsupported context checkpoint status: ${String(candidate.context_checkpoint_status)}.`,
    ));
  }

  if (
    Object.hasOwn(candidate, "privacy_redaction_status")
    && candidate.privacy_redaction_status !== "passed"
  ) {
    errors.push(validationError(
      "privacy_redaction_not_passed",
      "privacy_redaction_status",
      "privacy_redaction_status must be passed.",
    ));
  }

  const propertyNames = Object.keys(candidate).sort();
  for (const field of propertyNames) {
    if (FORBIDDEN_FIELDS.has(field)) {
      errors.push(validationError(
        "forbidden_field",
        field,
        `Forbidden field is not allowed in a Candidate: ${field}.`,
      ));
    }
  }
  for (const field of propertyNames) {
    if (!ALLOWED_FIELDS.has(field) && !FORBIDDEN_FIELDS.has(field)) {
      errors.push(validationError(
        "unknown_field",
        field,
        `Unknown Candidate field: ${field}.`,
      ));
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateTransition(candidate, event) {
  if (!isPlainObject(event) || !EVENT_SET.has(event.type)) {
    return transitionDenied(candidate, "invalid_event");
  }
  if (!isPlainObject(candidate) || !STATUS_SET.has(candidate.status)) {
    return transitionDenied(candidate, "invalid_current_state");
  }
  if (TERMINAL_STATUS_SET.has(candidate.status)) {
    return transitionDenied(candidate, "terminal_state");
  }

  const validation = validateCandidate(candidate);
  if (!validation.ok) return transitionDenied(candidate, "candidate_invalid");

  const current = candidate.status;
  if (
    current === "delivered"
    && ["release_before_delivery", "lease_expired"].includes(event.type)
  ) {
    return transitionDenied(candidate, "delivery_already_confirmed");
  }

  if (event.type === "register" && current === "candidate") {
    return event.candidate_validation_verified === true
      && event.privacy_validation_verified === true
      ? transitionAllowed("pending")
      : transitionDenied(candidate, "candidate_invalid");
  }
  if (event.type === "claim" && current === "pending") {
    return event.preconditions_verified === true
      ? transitionAllowed("claimed")
      : transitionDenied(candidate, "claim_precondition_failed");
  }
  if (event.type === "confirm_delivery" && current === "claimed") {
    return event.delivery_evidence_verified === true
      ? transitionAllowed("delivered")
      : transitionDenied(candidate, "delivery_evidence_required");
  }
  if (event.type === "consume" && current === "delivered") {
    if (event.delivery_evidence_verified !== true) {
      return transitionDenied(candidate, "delivery_evidence_required");
    }
    return event.consumption_preconditions_verified === true
      ? transitionAllowed("consumed")
      : transitionDenied(candidate, "consumption_precondition_failed");
  }
  if (event.type === "expire" && ["candidate", "pending", "claimed"].includes(current)) {
    return event.expiration_verified === true
      ? transitionAllowed("expired")
      : transitionDenied(candidate, "expiration_unverified");
  }
  if (
    event.type === "invalidate"
    && ["candidate", "pending", "claimed", "delivered"].includes(current)
  ) {
    return event.invalidation_verified === true
      ? transitionAllowed("invalid")
      : transitionDenied(candidate, "invalidation_unverified");
  }
  if (event.type === "release_before_delivery" && current === "claimed") {
    return [
      event.owner_verified,
      event.attempt_verified,
      event.revision_verified,
      event.delivery_not_confirmed,
    ].every(value => value === true)
      ? transitionAllowed("pending")
      : transitionDenied(candidate, "claim_release_unsafe");
  }
  if (event.type === "lease_expired" && current === "claimed") {
    return [
      event.lease_expiration_verified,
      event.ttl_valid,
      event.revision_verified,
    ].every(value => value === true)
      ? transitionAllowed("pending")
      : transitionDenied(candidate, "lease_recovery_unsafe");
  }

  return transitionDenied(candidate, "invalid_event");
}

export function transitionCandidate(candidate, event) {
  const validation = validateTransition(candidate, event);
  if (!validation.allowed) {
    return {
      ok: false,
      reason_code: validation.reason_code,
      value: candidate,
    };
  }
  const value = {
    ...candidate,
    status: validation.next_status,
  };
  // A shallow spread would leave these arrays aliased to the input Candidate, so
  // a caller mutating the result would silently corrupt the original. Copy them
  // from the validated field list to keep both in sync.
  for (const field of STRING_ARRAY_FIELDS) {
    value[field] = [...candidate[field]];
  }
  return { ok: true, value };
}

function transitionAllowed(nextStatus) {
  return { allowed: true, next_status: nextStatus };
}

function transitionDenied(candidate, reasonCode) {
  return {
    allowed: false,
    reason_code: reasonCode,
    current_status: isPlainObject(candidate) && typeof candidate.status === "string"
      ? candidate.status
      : null,
  };
}

function validationError(code, field, message) {
  return { code, field, message };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isUtcIsoTimestamp(value) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const normalized = value.includes(".")
    ? value
    : value.replace(/Z$/, ".000Z");
  return new Date(timestamp).toISOString() === normalized;
}
