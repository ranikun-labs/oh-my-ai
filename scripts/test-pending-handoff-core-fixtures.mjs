import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_CHECKPOINT_STATUSES,
  PENDING_HANDOFF_EVENTS,
  PENDING_HANDOFF_SCHEMA_VERSION,
  PENDING_HANDOFF_STATUSES,
  PENDING_HANDOFF_TERMINAL_STATUSES,
  transitionCandidate,
  validateCandidate,
  validateTransition,
} from "./lib/pending-handoff-core.mjs";

let tests = 0;

function test(name, operation) {
  operation();
  tests += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function candidate(overrides = {}) {
  return {
    candidate_id: "candidate-opaque-001",
    schema_version: PENDING_HANDOFF_SCHEMA_VERSION,
    status: "candidate",
    created_at: "2026-07-30T01:00:00.000Z",
    expires_at: "2026-07-30T02:00:00.000Z",
    source_runtime: "codex",
    source_session_identity: "opaque-session-identity",
    repository_identity: "opaque-repository-identity",
    worktree_identity: "opaque-worktree-identity",
    goal: "Implement the pure pending handoff core.",
    completed: [],
    open_issues: [],
    verification: [],
    do_not_touch: [],
    next_action: "Review the pure core implementation.",
    context_checkpoint_status: "review_needed",
    privacy_redaction_status: "passed",
    ...overrides,
  };
}

function withStatus(status) {
  return candidate({ status });
}

function errorCodes(value) {
  return validateCandidate(value).errors.map(error => `${error.code}:${error.field}`);
}

test("domain constants are exact, separate, frozen, and immutable", () => {
  assert.deepEqual(PENDING_HANDOFF_STATUSES, [
    "candidate", "pending", "claimed", "delivered", "consumed", "expired", "invalid",
  ]);
  assert.deepEqual(PENDING_HANDOFF_TERMINAL_STATUSES, ["consumed", "expired", "invalid"]);
  assert.deepEqual(PENDING_HANDOFF_EVENTS, [
    "register", "claim", "confirm_delivery", "consume", "expire", "invalidate",
    "release_before_delivery", "lease_expired",
  ]);
  assert.deepEqual(CONTEXT_CHECKPOINT_STATUSES, [
    "checkpointed", "no_update", "review_needed", "unknown",
  ]);
  for (const forbidden of [
    "clean", "review_needed", "checkpointed", "no_update", "available", "unavailable",
  ]) {
    assert.equal(PENDING_HANDOFF_STATUSES.includes(forbidden), false);
  }
  for (const value of [
    PENDING_HANDOFF_STATUSES,
    PENDING_HANDOFF_TERMINAL_STATUSES,
    PENDING_HANDOFF_EVENTS,
    CONTEXT_CHECKPOINT_STATUSES,
  ]) {
    assert.equal(Object.isFrozen(value), true);
    assert.throws(() => value.push("mutation"));
  }
});

test("canonical Candidate validates without changing review_needed or status", () => {
  const input = candidate();
  const snapshot = structuredClone(input);
  assert.deepEqual(validateCandidate(input), { ok: true, errors: [] });
  assert.deepEqual(input, snapshot);
  assert.equal(input.context_checkpoint_status, "review_needed");
  assert.equal(input.status, "candidate");
});

test("every required field is enforced", () => {
  for (const field of Object.keys(candidate())) {
    const input = candidate();
    delete input[field];
    assert.equal(validateCandidate(input).ok, false, field);
    assert.ok(errorCodes(input).includes(`required_field_missing:${field}`), field);
  }
});

test("schema, status, timestamps, strings, arrays, enums, and privacy marker are validated", () => {
  assert.ok(errorCodes(candidate({ schema_version: "999" }))
    .includes("unsupported_schema_version:schema_version"));
  assert.ok(errorCodes(candidate({ status: "clean" })).includes("unsupported_status:status"));
  assert.ok(errorCodes(candidate({ created_at: "2026-02-30T01:00:00Z" }))
    .includes("invalid_timestamp:created_at"));
  assert.ok(errorCodes(candidate({ expires_at: "not-a-timestamp" }))
    .includes("invalid_timestamp:expires_at"));
  assert.ok(errorCodes(candidate({ expires_at: "2026-07-30T01:00:00.000Z" }))
    .includes("invalid_timestamp_order:expires_at"));
  assert.ok(errorCodes(candidate({ goal: 42 })).includes("invalid_field_type:goal"));
  assert.ok(errorCodes(candidate({ completed: "done" }))
    .includes("invalid_field_type:completed"));
  assert.ok(errorCodes(candidate({ open_issues: ["valid", 42] }))
    .includes("invalid_array_item:open_issues[1]"));
  assert.ok(errorCodes(candidate({ context_checkpoint_status: "clean" }))
    .includes("unsupported_context_checkpoint_status:context_checkpoint_status"));
  assert.ok(errorCodes(candidate({ privacy_redaction_status: "unknown" }))
    .includes("privacy_redaction_not_passed:privacy_redaction_status"));
});

test("blank string array items are rejected per index across all four arrays", () => {
  for (const field of ["completed", "open_issues", "verification", "do_not_touch"]) {
    for (const blank of ["", "   ", "\t\n"]) {
      const input = candidate({ [field]: [blank] });
      assert.equal(validateCandidate(input).ok, false, `${field}=${JSON.stringify(blank)}`);
      assert.deepEqual(
        errorCodes(input),
        [`invalid_array_item:${field}[0]`],
        `${field}=${JSON.stringify(blank)}`,
      );
    }
    // An empty array stays valid: only blank *items* are rejected.
    assert.equal(validateCandidate(candidate({ [field]: [] })).ok, true, field);
    assert.equal(validateCandidate(candidate({ [field]: ["real entry"] })).ok, true, field);
  }

  // Every offending index is accumulated, in ascending order, per declared field.
  assert.deepEqual(
    errorCodes(candidate({ completed: ["ok", "", 42, "  "], do_not_touch: ["", "fine"] })),
    [
      "invalid_array_item:completed[1]",
      "invalid_array_item:completed[2]",
      "invalid_array_item:completed[3]",
      "invalid_array_item:do_not_touch[0]",
    ],
  );
});

test("forbidden and unknown properties are rejected in deterministic order", () => {
  const forbiddenFields = [
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
  ];
  for (const field of forbiddenFields) {
    assert.ok(
      errorCodes(candidate({ [field]: "synthetic-marker" })).includes(`forbidden_field:${field}`),
      field,
    );
  }

  const input = candidate({
    z_unknown: true,
    prompt: "synthetic marker",
    a_unknown: true,
    raw_session_id: "synthetic-session",
  });
  const first = validateCandidate(input);
  const second = validateCandidate(input);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.errors.map(({ code, field }) => [code, field]),
    [
      ["forbidden_field", "prompt"],
      ["forbidden_field", "raw_session_id"],
      ["unknown_field", "a_unknown"],
      ["unknown_field", "z_unknown"],
    ],
  );
});

test("non-plain input fails without throwing", () => {
  for (const input of [null, [], "candidate", 42]) {
    assert.doesNotThrow(() => validateCandidate(input));
    assert.equal(validateCandidate(input).errors[0].code, "candidate_not_plain_object");
  }
});

test("normal lifecycle applies four pure transitions", () => {
  const registered = transitionCandidate(candidate(), {
    type: "register",
    candidate_validation_verified: true,
    privacy_validation_verified: true,
  });
  assert.equal(registered.ok, true);
  const claimed = transitionCandidate(registered.value, {
    type: "claim",
    preconditions_verified: true,
  });
  assert.equal(claimed.value.status, "claimed");
  const delivered = transitionCandidate(claimed.value, {
    type: "confirm_delivery",
    delivery_evidence_verified: true,
  });
  assert.equal(delivered.value.status, "delivered");
  const consumed = transitionCandidate(delivered.value, {
    type: "consume",
    delivery_evidence_verified: true,
    consumption_preconditions_verified: true,
  });
  assert.equal(consumed.value.status, "consumed");
});

test("expire and invalidate require externally verified facts", () => {
  for (const status of ["candidate", "pending", "claimed"]) {
    assert.deepEqual(
      validateTransition(withStatus(status), { type: "expire", expiration_verified: true }),
      { allowed: true, next_status: "expired" },
    );
    assert.equal(
      validateTransition(withStatus(status), { type: "expire" }).reason_code,
      "expiration_unverified",
    );
  }
  for (const status of ["candidate", "pending", "claimed", "delivered"]) {
    assert.deepEqual(
      validateTransition(withStatus(status), {
        type: "invalidate",
        invalidation_verified: true,
      }),
      { allowed: true, next_status: "invalid" },
    );
    assert.equal(
      validateTransition(withStatus(status), { type: "invalidate" }).reason_code,
      "invalidation_unverified",
    );
  }
});

test("claim release and lease recovery require every safety fact", () => {
  const release = {
    type: "release_before_delivery",
    owner_verified: true,
    attempt_verified: true,
    revision_verified: true,
    delivery_not_confirmed: true,
  };
  assert.deepEqual(validateTransition(withStatus("claimed"), release), {
    allowed: true,
    next_status: "pending",
  });
  assert.equal(
    validateTransition(withStatus("claimed"), { ...release, owner_verified: false }).reason_code,
    "claim_release_unsafe",
  );

  const recovery = {
    type: "lease_expired",
    lease_expiration_verified: true,
    ttl_valid: true,
    revision_verified: true,
  };
  assert.deepEqual(validateTransition(withStatus("claimed"), recovery), {
    allowed: true,
    next_status: "pending",
  });
  assert.equal(
    validateTransition(withStatus("claimed"), { ...recovery, ttl_valid: false }).reason_code,
    "lease_recovery_unsafe",
  );
  assert.equal(
    validateTransition(withStatus("delivered"), release).reason_code,
    "delivery_already_confirmed",
  );
});

test("evidence, claim, registration, and consumption preconditions cannot be bypassed", () => {
  assert.equal(
    validateTransition(candidate(), { type: "register" }).reason_code,
    "candidate_invalid",
  );
  assert.equal(
    validateTransition(withStatus("pending"), { type: "claim" }).reason_code,
    "claim_precondition_failed",
  );
  assert.equal(
    validateTransition(withStatus("claimed"), { type: "confirm_delivery" }).reason_code,
    "delivery_evidence_required",
  );
  assert.equal(
    validateTransition(withStatus("delivered"), {
      type: "consume",
      consumption_preconditions_verified: true,
    }).reason_code,
    "delivery_evidence_required",
  );
  assert.equal(
    validateTransition(withStatus("delivered"), {
      type: "consume",
      delivery_evidence_verified: true,
    }).reason_code,
    "consumption_precondition_failed",
  );
});

test("terminal states reject every event and unsupported transitions stay closed", () => {
  for (const status of PENDING_HANDOFF_TERMINAL_STATUSES) {
    for (const type of PENDING_HANDOFF_EVENTS) {
      assert.equal(
        validateTransition(withStatus(status), { type }).reason_code,
        "terminal_state",
        `${status} + ${type}`,
      );
    }
  }
  assert.equal(
    validateTransition(withStatus("delivered"), {
      type: "lease_expired",
      lease_expiration_verified: true,
      ttl_valid: true,
      revision_verified: true,
    }).reason_code,
    "delivery_already_confirmed",
  );
  assert.equal(
    validateTransition(candidate(), { type: "unsupported" }).reason_code,
    "invalid_event",
  );
  assert.equal(
    validateTransition(candidate({ status: "clean" }), { type: "register" }).reason_code,
    "invalid_current_state",
  );
});

test("successful and rejected transitions preserve the input Candidate", () => {
  const acceptedInput = candidate();
  const acceptedSnapshot = structuredClone(acceptedInput);
  const accepted = transitionCandidate(acceptedInput, {
    type: "register",
    candidate_validation_verified: true,
    privacy_validation_verified: true,
  });
  assert.notEqual(accepted.value, acceptedInput);
  assert.deepEqual(acceptedInput, acceptedSnapshot);
  assert.equal(accepted.value.status, "pending");

  const rejectedInput = withStatus("consumed");
  const rejectedSnapshot = structuredClone(rejectedInput);
  const rejected = transitionCandidate(rejectedInput, { type: "claim" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason_code, "terminal_state");
  assert.equal(rejected.value, rejectedInput);
  assert.deepEqual(rejectedInput, rejectedSnapshot);
});

test("successful transition deep-copies string arrays so results cannot alias input", () => {
  const input = candidate({
    completed: ["did the thing"],
    open_issues: ["still open"],
    verification: ["ran fixtures"],
    do_not_touch: ["generated files"],
  });
  const snapshot = structuredClone(input);
  const result = transitionCandidate(input, {
    type: "register",
    candidate_validation_verified: true,
    privacy_validation_verified: true,
  });

  assert.equal(result.ok, true);
  assert.notEqual(result.value, input);
  assert.notEqual(result.value.completed, input.completed);
  assert.notEqual(result.value.open_issues, input.open_issues);
  assert.notEqual(result.value.verification, input.verification);
  assert.notEqual(result.value.do_not_touch, input.do_not_touch);
  assert.deepEqual(result.value.completed, input.completed);

  result.value.completed.push("mutated");
  result.value.open_issues.push("mutated");
  result.value.verification.push("mutated");
  result.value.do_not_touch.push("mutated");

  assert.deepEqual(input, snapshot);
  assert.equal(input.completed.includes("mutated"), false);
  assert.equal(input.open_issues.includes("mutated"), false);
  assert.equal(input.verification.includes("mutated"), false);
  assert.equal(input.do_not_touch.includes("mutated"), false);

  // A rejected transition still hands back the original reference untouched.
  const rejectedInput = candidate({ completed: ["kept"] });
  const rejectedSnapshot = structuredClone(rejectedInput);
  const rejected = transitionCandidate(rejectedInput, { type: "claim" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.value, rejectedInput);
  assert.deepEqual(rejectedInput, rejectedSnapshot);
});

test("pure core has no filesystem, process, runtime, network, or hook imports", () => {
  const corePath = fileURLToPath(new URL("./lib/pending-handoff-core.mjs", import.meta.url));
  const source = fs.readFileSync(corePath, "utf8");
  assert.doesNotMatch(
    source,
    /(?:from\s+|import\s*\()\s*["']node:(?:fs|child_process|http|https|net|tls|dgram|cluster|worker_threads)["']/,
  );
  assert.doesNotMatch(source, /\bprocess\.(?:exit|env|cwd)\b|\bspawn(?:Sync)?\b|\bexec(?:File|Sync)?\b/);
  assert.doesNotMatch(source, /\b(?:SessionStart|SessionEnd|PostToolUse|UserPromptSubmit)\b/);
});

process.stdout.write("\n");
process.stdout.write("Pure Core nested immutability: PASS\n");
process.stdout.write("String-array item validation: PASS\n");
process.stdout.write("Candidate Schema pure sub-assertion: PASS\n");
process.stdout.write("Lifecycle pure sub-assertion: PASS\n");
process.stdout.write("FX-PHR-019 domain isolation sub-assertion: PASS\n");
process.stdout.write("FX-PHR-020 pure-core boundary sub-assertion: PASS\n");
process.stdout.write(`Pure fixture tests: ${tests} PASS\n`);
