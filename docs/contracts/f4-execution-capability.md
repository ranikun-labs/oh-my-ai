# F4 Execution Capability Candidate

> Candidate contract for RPL-120. This document and its fixtures describe a
> deterministic evaluator only. They do not probe a host, create a Worker,
> dispatch a Runner, resume a Task, or prove Runtime E2E.

The integration candidate is based on public master
`6d2a93893c0c7a40e1d0b99b691a8f950aa17969`.

## Boundary

The evaluator consumes task requirements and observations from a trusted
environment adapter. No such adapter is implemented here. Fixture-provided
observations and verifier callbacks are synthetic and cannot be promoted to
environment or Runtime evidence.

The existing F4 Skill remains an explicit operational playbook. Reading or
invoking it does not grant approval or create a dispatcher. The existing
work-start Human Review boundary remains unchanged. The RPL-116 agent manifest
guard remains a standalone preflight contract, not an agent-spawn API.

Approval is a separate authorization gate. It is not a technical Capability
and cannot be inferred from a passing environment check. Public code does not
encode private model settings, install or merge anything, write Jira, or alter
private policy.

## Task and environment inputs

Task input has a non-empty capability list and an explicit approval requirement:

    {
      "task_id": "RPL-120-slice",
      "scope_ref": "owner-approved-scope-reference",
      "requirements": {
        "capabilities": ["git", "jvm", "github_api"],
        "capability_scopes": {
          "git": { "operation": "read", "resource": "repo:org/example" },
          "jvm": { "operation": "run-build", "resource": "repo:org/example" },
          "github_api": { "operation": "read", "resource": "repo:org/example" }
        },
        "approval_required": true
      },
      "authorization": {
        "status": "approved",
        "verified": true,
        "evidence_ref": "trusted-approval-record",
        "scope_ref": "owner-approved-scope-reference"
      }
    }

The current capability vocabulary is:

| Capability | Example need |
| --- | --- |
| git | Local repository and Git operations |
| git_proxy | Git remote traffic through a configured proxy |
| jvm | JVM-based build or test |
| socket | Required local or service socket access |
| github_api | GitHub API read or write access |
| actions | GitHub Actions read or dispatch access |
| cross_repo | Work spanning more than one repository |
| private_repo_checkout | Authorized checkout of a private repository |
| artifact_handoff | Required artifact transfer and retrieval |
| e2e | A real end-to-end target environment |

The environment adapter supplies a stable fingerprint, provider ID, runtime ID,
and one observation per required capability. An observation includes status
(available, unavailable, or unknown), a verification flag, provider ID,
runtime ID, capability, task ID, task scope reference, operation, resource,
environment fingerprint, timestamp, and evidence reference. The observation's
runtime ID must match its environment's runtime ID. `planRunnerRouting` also
requires that environment runtime ID to equal the selected runner ID and passes
that identity to the trusted capability verifier. A mismatch blocks routing
before a capability evidence verifier can approve the observation. Every
required capability must have a concrete operation/resource scope; missing
scopes and extra unrequested scopes are invalid. Operation tokens use the
canonical lowercase grammar
^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$. Tokens all, any, unknown, unspecified, none,
default, and wildcard are reserved and rejected as whole operation tokens or
hyphen-delimited segments; read-all and unknown-run are invalid. Explicit verbs
such as read, run-build, publish-and-fetch, connect, and checkout remain valid.
Resource identifiers use a lowercase type prefix followed by a concrete path:
the type matches ^[a-z][a-z0-9-]*$, and path segments contain only lowercase
ASCII letters, digits, period, underscore, or hyphen, separated by slash or
plus. Empty segments and segments equal to period or double-period are invalid.
Wildcard/glob characters *, ?, [, ], {, }, and % are rejected. For example,
repo:org/name and
workspace:oh-my-ai+finance-harness are valid; repo:*, repo:org/*, and
repo:org/../other are invalid. An observation for GitHub read or repo A cannot
satisfy GitHub write or repo B.

Each observation fingerprint must equal the current environment fingerprint.
Preflight rejects observations older than five minutes or more than 30 seconds
in the future. It passes task ID/scope, the exact requested operation/resource,
the environment fingerprint, observed/check timestamps, and both freshness
bounds to a trusted verifier callback. The callback must verify those values
and provenance. A boolean flag alone is not proof. Missing, stale-shaped,
mismatched, replayed, or unverified observations block preflight.

When approval is required, the task scope and approval scope must match, the
approval must be explicitly approved, and a trusted approval verifier must
confirm its evidence. Without that verifier, preflight remains blocked.

## Preflight and routing plan

preflightExecution(task, environment) returns one of:

| Status / code | Meaning |
| --- | --- |
| READY / CAPABILITIES_VERIFIED | All requested capability observations and approval evidence pass their trusted verifiers |
| BLOCKED / ENVIRONMENT_BLOCKED | A capability is unavailable, unknown, missing, or lacks provenance |
| BLOCKED / APPROVAL_BLOCKED | Approval is missing, pending, denied, unverified, or for another scope |
| BLOCKED / PREFLIGHT_INVALID | Task requirements are malformed |
| BLOCKED / ENVIRONMENT_UNIDENTIFIED | No stable environment fingerprint was supplied |

planRunnerRouting(task, runners) evaluates each runner independently and
selects the highest-priority compatible candidate, preserving input order for
ties. A runner is compatible only when each observation and its environment are
bound to that runner's exact ID. It returns ROUTE_PLANNED with dispatch_status:
NOT_RUN. If no runner
meets every task requirement, it returns BLOCKED / NO_COMPATIBLE_RUNNER.

The routing result is a plan only. This module never calls a Runner or Runtime
Adapter, and never returns a dispatch success. Capability evidence is scoped to
the selected environment; it is not a static support declaration.

## Failure separation and retry bound

Callers classify a failure as environment or code:

- An environment-blocked attempt may be reconsidered only after the stable
  environment fingerprint changes. The same blocker under the same fingerprint
  stops immediately. A changed environment allows at most one bounded
  re-evaluation per failure fingerprint.
- A code failure may be reconsidered only after the Git tree SHA changes. The
  same failure on the same tree stops immediately. One changed-tree retry is
  allowed per failure fingerprint.
- A missing fingerprint or tree SHA blocks retry evaluation. Environment
  failure is never rewritten as a code defect, and vice versa.

These are decisions about whether a retry is useful. They do not run the retry.
`decideRetry` also requires an `attempt_boundary` that records
`claim_status: "NOT_ACQUIRED"` and `dispatch_status: "NOT_RUN"`. A missing,
claimed, dispatched, or unknown boundary stops with `RETRY_BOUNDARY_UNSAFE`.
This keeps a changed tree or environment from authorizing a second action after
Claim or an ambiguous Runtime result.

`decideRetry` is intentionally not called by
`createPendingHandoffManualResumeRuntimeComposition`. The composition handles
one explicit action request and makes at most one `resolveAndResume` call per
invocation. It does not own durable failure history or classify sanitized
executor failures into environment/code fingerprints. `decideRetry` alone does
not authorize another call: after Claim, the composition's early revision guard
rejects the original expected revision, while the service rejects the claimed
revision as a replay mismatch. Thus the current composition has no supported
second invocation after Claim, even with the same attempt ID. A future RPL-120
recovery path must first reconcile the durable Claim and establish runtime
deduplication for that attempt; only then may a caller use `decideRetry` to
consider changed environment/tree evidence. Until that recovery contract exists,
do not retry a post-Claim or ambiguous action result. `resume_accepted` and a
generic action failure alone never authorize an automatic retry.

The composition reserves a candidate/attempt pair before its first await, so
concurrent calls through composition instances in the same Node process return
`manual_resume_attempt_in_progress` without a second Claim or Runtime call.
Before dispatch it also calls the Store-backed
`claimLease.acquireClaimForDispatch` operation. The existing Store arbitrates
mutations with a per-record filesystem lock and revision CAS. This operation
rejects an already-persisted same-owner/same-attempt Claim instead of replaying
it as a fresh acquisition. Two independent processes racing the same attempt
therefore cannot both receive dispatch authority: one CAS may publish the
Claim, and the other call sees either the revision conflict or the persisted
Claim replay and fails closed. The generic `acquireClaim` operation retains its
existing idempotent replay behavior for non-dispatch callers.

The current composition reports `manual_resume_claim_outcome_unknown` when a
Claim may have persisted but no validated action request is available. Once the
executor is invoked, a thrown, malformed, or non-accepted result is reported as
`manual_resume_action_outcome_unknown`, except for the adapter's explicit
unsupported-runtime response. A persisted active Claim blocks a sequential
restart from acquiring dispatch authority again, including after lease expiry
until explicit clearing occurs. The current Claim schema has no durable
resume-outcome tombstone. Both `recoverClaimLease` and
`releaseClaimBeforeDelivery` can clear a Claim back to pending without knowing
whether Manual Resume dispatched or the Runtime accepted the action. A later
call with the new revision could then acquire fresh dispatch authority for the
same UNKNOWN outcome. The Manual Resume composition neither exposes nor calls
these clearing operations, and callers must not clear an UNKNOWN Runtime
outcome. That caller rule is not enforced by the shared Claim service, so M1
remains open for explicit Claim clearing followed by redispatch. Safe
post-clear recovery, authoritative outcome reconciliation, and result/checkpoint
CAS remain blocked on an owned durable Attempt/Outcome contract.

## Checkpoint evidence reuse

assessCheckpointResume(checkpoint, current, verifier) is eligible only when:

1. The checkpoint belongs to the same repository and is interrupted or blocked.
2. Full commit SHA and tree SHA exactly match the current target.
3. Environment fingerprint exactly matches.
4. A non-empty next step exists.
5. A passing test record matches the same SHA, tree, environment, test-plan ID,
   test-plan digest, and repository.
6. A trusted verifier confirms the test record while receiving the expected
   repository, SHA, tree, environment fingerprint, and test-plan ID/digest.

It returns RESUME_ELIGIBLE and resume_status: ELIGIBLE_ONLY; execution remains
NOT_RUN. Missing or stale evidence fails closed. A fixture callback is not a
trusted production verifier.

## Required regression blockers

| Case | Required observation | Expected result |
| --- | --- | --- |
| Finance JVM | jvm: unavailable | Environment block; no Runner selected; same-fingerprint retry stopped |
| Carelog Socket | socket: unavailable | Environment block; no Runner selected; same-fingerprint retry stopped |
| Git Proxy | git_proxy: unavailable | Environment block; no Runner selected; same-fingerprint retry stopped |
| Artifact Handoff | artifact_handoff: unavailable | Environment block; no Runner selected; same-fingerprint retry stopped |
| Private Repo Checkout | private_repo_checkout: unavailable | Environment block; no Runner selected; same-fingerprint retry stopped |
| Actual E2E not ready | e2e: unavailable | Environment block; no Runner selected; same-fingerprint retry stopped |

The native fixtures use only synthetic observations. They validate evaluator
behavior, not Finance/Carelog connectivity, Git Proxy, private repository
authorization, Artifact transfer, Actions, E2E readiness, or Runtime dispatch.
Run the candidate fixtures directly with:

    node scripts/test-f4-execution-capability-fixtures.mjs

Additional fixtures reject operation/resource mismatches, task/scope replay,
observations reused across environment fingerprints, stale observations,
future timestamps outside the skew bound, and checkpoint test evidence from a
different repository even when SHA, tree, and test plan match.

## Integration gates

- The existing RPL-120 `createPendingHandoffManualResumeRuntimeComposition`
  boundary now requires an injected `capabilityContext` port. Its
  `resolveManualResumeContext({ candidate_id, runtime_id,
  persisted_candidate })` call receives a frozen, validated snapshot of the
  persisted candidate ID, revision, source runtime, source session identity,
  repository identity, and worktree identity. The result must provide runtime
  bound environment evidence, a task scope, and explicit checkpoint/current/
  test-plan evidence. The required `verifyManualResumeBinding` callback must
  attest that the task resource/scope and checkpoint/current/test evidence map
  to that exact snapshot; SHA/tree/test verification also receives the expected
  repository/worktree identities and revision. The composition runs RPL-118 routing and
  `assessCheckpointResume` before constructing the manual-resume service,
  acquiring a Claim, or calling the existing executor. Missing, malformed,
  blocked, or mismatched evidence returns the stable sanitized
  `manual_resume_capability_preflight_blocked` result.
- The capability scope snapshot preserves every own key, including an own
  `__proto__` property. Such an extra scope remains visible to validation and
  is rejected as an unrequested scope rather than disappearing during copying.
- The persisted handoff schema does not contain the SHA/tree/test-plan proof
  needed for checkpoint reuse. The composition does not derive it from
  `verification` text. A context provider must supply and verify that evidence;
  otherwise preflight fails closed. No production context provider or runtime
  probe is supplied by this candidate.
- The composition fixtures use synthetic evidence and a fake executor. They
  verify gate ordering and that a verified fixture can reach that fake
  executor; they cover repository, worktree, revision, and Codex/Claude runtime
  cross-binding failures. They do not demonstrate Runtime dispatch, a real
  resume, or E2E.
- A future adapter must collect current evidence, validate its provenance, and
  supply a stable fingerprint before this evaluator can make an environment
  decision.
- RPL-116's real-dispatch trust boundary must remain in force for Writer or
  Reviewer creation. Requested and effective model settings remain distinct;
  unknown settings do not become Reviewer PASS.
- Runtime dispatch, production checkpoint persistence, actual resume,
  Writer-to-Reviewer E2E, and 30–60 minute unattended execution remain
  NOT_IMPLEMENTED and NOT_RUN until a supported, controllable Runtime Adapter
  exists.
- Owner approval, Jira status changes, PR creation, Source Merge, global
  installation, deployment, and private policy changes are outside this
  candidate.

## Required durable Attempt / Outcome contract — not implemented

The current pending-handoff Claim record is not an RPL-120 Attempt/Outcome
record. It has only owner, Claim timestamps, and `claim_attempt_id`; the
filesystem Store exposes candidate-state CAS, not result/checkpoint CAS. A
Claim lease expiry therefore does not prove that a Runtime action was never
sent. `recoverClaimLease` and `releaseClaimBeforeDelivery` must not authorize a
Manual Resume retry based on lease expiry, caller assertion, or Claim revision
alone. The current implementation cannot distinguish a Resume Claim from
other Claim uses after persistence, so this candidate leaves M1 OPEN.

RPL-120 needs a separately owned injected port with durable per-attempt CAS.
The following is the proposed public contract, not an implemented Store or
Runtime adapter:

```js
identity = {
  candidate_id,
  claim_attempt_id,
  runtime_id,
  association_ref,
  repository_identity,
  worktree_identity,
}

attemptOutcomePort = {
  reserveAttempt({ identity, expected_candidate_revision }),
  bindClaim({ identity, expected_attempt_revision, claim_revision }),
  markDispatchStarted({ identity, expected_attempt_revision, claim_revision }),
  recordOutcome({ identity, expected_attempt_revision, outcome, evidence_ref }),
  reconcileOutcome({ identity, expected_attempt_revision, observation_ref }),
  abandonBeforeDispatch({ identity, expected_attempt_revision, claim_revision }),
  commitResultAndCheckpoint({ identity, expected_attempt_revision, expected_checkpoint_revision, result_ref, checkpoint }),
  readAttempt({ identity }),
}
```

Required semantics:

1. `reserveAttempt` creates one durable record for `(candidate_id,
   claim_attempt_id)` and is idempotent only for the exact same reservation.
   A different attempt cannot acquire an active candidate's dispatch right.
2. `markDispatchStarted` performs the durable CAS **before** calling the
   Runtime. It changes the attempt to `DISPATCH_UNKNOWN`; a crash after this
   write is ambiguous and cannot be retried without authoritative Runtime
   reconciliation or an adapter's real idempotency guarantee.
3. `abandonBeforeDispatch` wins only by atomically changing a still-reserved or
   claim-bound attempt to terminal `NOT_DISPATCHED`. It races `markDispatchStarted`
   on the same attempt revision. If Dispatch has started, the method must fail
   without changing either attempt or Claim. Claim release happens only after
   this terminal CAS succeeds.
4. `recordOutcome` distinguishes `NOT_DISPATCHED`, `ACCEPTED`, `COMPLETED`, and
   `UNKNOWN`. After `DISPATCH_UNKNOWN`, only `reconcileOutcome` may establish a
   definitive result from authoritative Runtime evidence; a caller-supplied
   result cannot rewrite an unknown outcome. The current adapter's
   `resume_accepted` maps only to `ACCEPTED`, never to completed work. Lost
   receipts and malformed responses remain `UNKNOWN`.
5. `commitResultAndCheckpoint` commits a sanitized result reference and the
   corresponding checkpoint under the same expected attempt/checkpoint
   revisions. If the backing store cannot transact both records, it must use a
   durable write-ahead state that can reconcile partial writes idempotently.
6. All operations bind candidate, attempt, runtime semantic ID, Association
   reference, claim revision, and opaque repository/worktree scope. They do not
   persist native session IDs, prompts, transcripts, responses, or tool output.
7. Stale CAS, missing records, unavailable storage, response loss, or unknown
   Runtime state fail closed. No caller-supplied boolean or fixture verifier
   authorizes recovery.

No concrete RPL-95 physical-state adapter, RPL-94 Association API, RPL-93 M5
Task Context/Fresh Observation/Resume entrypoint, or supported Runtime Result
provider is available on this PR's public base. RPL-120 must consume those
published contracts when available; it must not write parallel RPL-95 state
or redefine RPL-94 Association lifecycle. Until the Attempt/Outcome CAS port is
implemented and connected, cross-process duplicate Claim arbitration is
verified separately from safe UNKNOWN recovery, result/checkpoint persistence,
and product Manual Resume E2E.
