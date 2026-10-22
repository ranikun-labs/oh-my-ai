# G3 Trusted Gate and Manual Recovery Contract

This contract documents the offline integration seam in `scripts/lib/jira-ticket-g3-trusted-gate.mjs` and `scripts/lib/jira-ticket-g3-ledger-recovery.mjs`. It does not provide a Jira, Owner, Policy, Activation, or replay-claim connector. A deployment must inject those trusted sources and pin public keys independently from workflow context.

## Signed evidence

`createG3TrustedGate({ source, trustedKeys, now, maxEvidenceAgeMs })` returns the adapter-compatible `verifyGate({ stage, context })` function. Each fetched record is an object with exactly these envelope keys:

```json
{
  "key_id": "pinned-key-name",
  "payload": { "kind": "g3_activation" },
  "signature": "base64-ed25519-signature"
}
```

The Ed25519 signature is over UTF-8 canonical JSON: object keys sort lexically, arrays retain order, and JSON scalar spelling follows `JSON.stringify`. The key name resolves only through the gate's pinned `trustedKeys`; caller-provided references, booleans, and signatures have no authority. Every payload has UTC `issued_at` and `expires_at`; the gate rejects future issue times, stale records, and `now >= expires_at`. Activation `effective_to` is also exclusive. Live metadata must additionally have a recent `observed_at`.

The trusted `source` implements these methods, each returning a signed envelope:

| Method | Input | Signed payload kind |
|---|---|---|
| `fetchActivation({ activation_ref, project, issue_type })` | exact mutation/read request scope | `g3_activation` |
| `fetchCurrentActivation({ project })` | search and authority-read stages, which run before/without an in-memory Intent | `g3_activation` |
| `fetchPolicy({ policy_sha256 })` | current signed Activation policy digest | `g3_policy` |
| `fetchLiveMetadata({ project, issue_type })` | trusted live Jira metadata source | `g3_live_metadata` |
| `fetchOwnerApproval({ approval_ref, create_request_id })` | separate Owner approval record | `g3_owner_approval` |
| `claimReplay({ claim_key, activation_ref, create_request_id, approved_preview_id, expires_at })` | durable atomic single-use reservation | `g3_replay_claim` |

The `claimReplay` source must persist a compare-and-set claim across gate instances and restarts. Returning a signed in-memory claim does not satisfy this requirement. A duplicate must return a signed claim whose `status` is not `claimed`; the gate rejects it.

The Activation payload contains `kind`, `status: "active"`, `activation_ref`, `owner_approval_ref`, `policy_sha256`, `metadata_sha256`, signed time fields, `effective_from`, `effective_to`, and a `scope` object. Scope contains `project`, `issue_type`, `issue_type_id`, `ledger_ref`, `request_id`, `approved_preview_id`, and an `operations` array. A specific intent must exactly match its request ID, ledger, preview digest, project and issue type. Search and `authority_read` resolve the currently active project Activation separately and require their own operation scope.

The policy payload contains `kind: "g3_policy"`, `status: "active"`, `policy_sha256`, `project`, `allowed_issue_types`, `mode: "single_supervised"`, `allowed_create_fields`, `max_concerns` (0–3), and optional `max_metadata_age_ms`. Its digest must match the Activation. The live metadata payload contains `kind: "g3_live_metadata"`, project/type/id, `fields`, `metadata_sha256`, `observed_at`, and signed time fields. The metadata digest is `g3EvidenceSha256({ project, issue_type, issue_type_id, fields })`; it must match both the signed payload and Activation. The gate checks Target field schemas, no defaults, selected IDs against live allowed values, and current policy field/concern limits.

The Owner approval payload contains `kind: "g3_owner_approval"`, `status: "approved"`, stable `approval_ref`, Activation/policy/project/type/ledger references, exact `create_request_id`, exact `approved_preview_id`, `fields_sha256`, and `create_request_sha256`. Both digests use `g3EvidenceSha256`. `fields_sha256` binds the immutable Intent fields. `create_request_sha256` binds the complete Jira Create body, including summary, description, assignee, priority, labels, and fields. The approval expiry cannot outlive the Activation. At the Intent stage the gate returns the stable `cutover_approval_ref`; the adapter stores that trusted reference in the durable pending Intent.

The adapter calls these contexts:

- `search`: the duplicate-search request; the gate resolves current signed Activation/Policy/Metadata.
- `intent`: CreateRequestId, ledger, Activation, approved preview ID, issue type and immutable fields.
- `create`: `{ request, create_request_id, activation_ref }`; `request` must match the signed full Create digest.
- `read`: `{ key, fields, create_request_id }`; it must follow the one authorized Create attempt and request the exact issue type/Target fields.
- `origin`: the flat Origin record; key, Intent, activation, approval reference, authorities and exact verified Target IDs must match prior gate state.
- `authority_read`: `{ issue_key }`; the current signed read scope is checked before the adapter compares Ledger and Jira GET authority.

The gate refreshes signature expiry, Activation effective time, policy/metadata scope, and metadata age after source awaits and immediately before returning `allowed: true`. Intent/Create/read/Origin sequencing is held in gate memory. The durable replay claim and file Ledger remain responsible for cross-instance request replay and durable receipts.

## Manual ledger recovery

`createG3LedgerRecovery({ ledger, root, ledgerRef, jiraRead, trustedKeys, siteOrigin, now })` accepts the existing file Ledger and one read-only Jira GET function. It exposes only `plan(requestId)` and `reconcile({ request_id, authorization })`; it has no Create, search, Admin, or network-write method. `plan` only inspects the pending Intent, IssueKey link, and Origin files. It returns stable `pending_sha256`, `fields_sha256`, and a Target snapshot for a maintainer to review and sign.

The signed manual authorization has `kind: "g3_manual_recovery_authorization"`, `status: "approved"`, `action: "reconcile_existing_issue"`, `authorization_ref`, exact `create_request_id`, `ledger_ref`, `issue_key`, `activation_ref`, `cutover_approval_ref`, `issue_type`, `issue_type_id`, `pending_sha256`, `fields_sha256`, `issued_at`, and `expires_at`. The two digests must match the exact durable Intent. The pinned signing key is the maintainer trust boundary; an authorization reference string alone is not proof.

Reconciliation performs exactly one Jira GET for `issuetype` and the three Target fields. It verifies returned key, issue type ID, Product, Component, Concern values, and the still-current signed authorization before any ledger write. Before treating an existing Intent/link/Origin as durable, it fsyncs the receipt file and containing directory; a readable file whose fsync fails remains frozen. It can restore a missing link, persist a matching Origin, or report a matching durable Origin. Partial/corrupt JSON, mismatch, expiry, fsync failure, and unknown GET outcomes freeze recovery. An unknown outcome never calls Create or retries the GET in the same recovery instance. `syncReceipt` may be injected for filesystem fault tests, but production must keep a real file and parent-directory fsync implementation.

## Offline validation

```sh
node scripts/test-jira-ticket-g3-trusted-gate.mjs
node scripts/test-jira-ticket-g3-ledger-recovery.mjs
```

The fixtures generate ephemeral Ed25519 keys and synthetic evidence in process. Recovery uses real temporary directories and the existing file Ledger. No Jira, Admin, Owner, or external network calls are made.
