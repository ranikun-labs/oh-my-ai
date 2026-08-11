# Product Decision: Jira-driven Work Lifecycle

**Status:** Accepted product decision — RISK_TIERED_HYBRID.
**Date:** 2026-08-11
**Scope:** Jira planning ownership, execution-readiness, and Worker boundaries.

## Decision

oh-my-ai will model Jira work as two separate, optional skills:

1. `jira-ticket` authors a Ticket Contract. It collects sources, presents a
   preview, creates the Jira issue only after explicit user approval, reports
   the issue key and URL, and then stops.
2. `jira-work` is the Deep Lane execution-readiness gate. It validates either
   current Connector evidence plus the Main Contract, or a structured Main
   Handoff, and must consume the shared Git preflight before the Worker begins.

The boundary is intentional. Creating a record of planned work is not
authorization to create a branch, modify a repository, or change Jira status.

```text
Authoring
request / Confluence
  -> source confirmation -> Ticket preview -> explicit approval
  -> Jira issue creation -> key + URL report -> stop

Consumption
Main Contract + selected Source Mode
  -> claim-level Jira freshness -> shared Git preflight
  -> jira-work readiness result -> Worker
  -> implementation + verification -> commit + push + draft PR
```

`jira-ticket` must not create a branch, change code, commit, push, create a
PR, transition Jira status, or imply automatic start. `jira-work` must not
merge, release, tag, deploy, run a migration, change a secret, or work on a
different Ticket.

### Governing decisions

- `jira-ticket` and `jira-work` are separate optional skills.
- `jira-ticket` ends after an explicitly approved Jira creation.
- `jira-work` consumes current Connector evidence or a complete
  `jira-work-main-handoff/v1`; it does not infer a Contract from arbitrary
  prose.
- A Jira Ticket is an execution contract, not the canonical Product or
  Architecture Decision.
- If the Jira Ticket conflicts with an accepted decision or canonical
  repository Product/Architecture document, stop before branch creation and
  request a decision. Do not silently reconcile the conflict in Jira or code.
- One Ticket maps to one repository, one working branch, and one draft PR.
  Existing work may be resumed only after the same contract and preflight
  gates pass.
- `$jira-work` expresses intent to run the readiness gate; the Worker and active
  Execution Policy still control every mutation.
- Removing draft status, merge, release, tag, and deployment each require a
  separate explicit approval.
- In `MAIN_HANDOFF`, optional Jira freshness is `NOT_PERFORMED` and does not
  invalidate independently verifiable Repository claims. Required freshness
  without a Connector is `NOT_VERIFIABLE` and stops execution readiness.
- Git and Jira partial successes are preserved and reported. The workflow does
  not automatically roll them back.

## Source of Truth by lifecycle stage

The following orders apply to different stages, so they are not contradictory.

### Ticket authoring: `jira-ticket`

1. Accepted Decision
2. Canonical repository Product and Architecture documents
3. Confluence specification
4. Explicit user request
5. Handoff Candidate
6. Current conversation

There is no Jira Ticket at this point. The skill must produce a preview from
the confirmed sources and wait for explicit approval before writing to Jira.

### Ticket consumption: `jira-work`

1. Accepted Decision
2. Canonical repository Product and Architecture documents
3. Confluence specification
4. Jira Ticket
5. Handoff Candidate
6. Current conversation

At consumption time, `CONNECTOR_VERIFIED` requires actual current-session Jira
evidence. `MAIN_HANDOFF` requires a complete `jira-work-main-handoff/v1` with
`APPROVED_BY_MAIN`. That marker is declarative provenance, not authentication,
a digital signature, or cryptographic trust. Neither mode can override the
sources above it.

The Main Handoff contains Issue Key, Repository, Base Branch and expected Base
SHA, Goal, In Scope, Out of Scope, Do Not Touch, Acceptance Criteria,
Verification, Risk Tier, Jira Freshness Requirement, and the approval marker.
Digest and durable machine-verifiable evidence handoff remain out of scope.

## Risk-tiered route

- Fast Lane: ordinary UI, Feature, Small Bug, and simple documentation use Web
  Main → Git Preflight → Worker. `jira-work` is optional.
- Deep Lane: Auth/Security, Secret/Privacy, DB/Schema Migration, Backfill,
  CAS/Lock/Concurrency, Shared Platform, Cross-repository Contract, Destructive
  Git, Release/Deploy, and Repository Ownership use Web Main → `jira-work` →
  Worker.

## Common Ticket Contract

Both skills use the following fixed contract. `jira-ticket` previews and writes
it; `jira-work` reads and validates it. A field is not optional merely because
Jira does not have a dedicated native field for it.

| Field | Required meaning |
|---|---|
| Summary | Short, user-visible statement of the intended outcome. |
| Context | Why the work is needed and the relevant current state. |
| Goal | Observable outcome the Ticket intends to achieve. |
| Source of Truth | Specific accepted decision, canonical document, specification, or request used to derive the contract. |
| In Scope | Work permitted for this Ticket. |
| Out of Scope | Explicitly excluded work and non-goals. |
| Acceptance Criteria | Outcome conditions used to decide whether the requested change is complete. |
| Repository | The one repository that may be changed. |
| Base Branch | The branch from which work begins or against which existing work is checked. |
| Expected Branch Name | Expected working branch, if determined by the contract or repository convention. |
| Dependencies | Required prior decisions, tickets, services, approvals, or external inputs. |
| Verification | Ticket-required checks and their expected evidence. |
| Do Not Touch | Paths, systems, data, and operation classes prohibited for this Ticket. |
| Definition of Done | Required implementation, verification, Git, PR, and Jira evidence conditions. |

The following values are Contract Validation Failures, not placeholders that
may be ignored:

```text
Decision Required
Repository Required
Base Branch Required
Not Verifiable
```

The following are also Contract Validation Failures:

- a required field is missing, an empty string, or whitespace-only;
- an unresolved or unknown placeholder remains;
- fields in the same Ticket contradict each other; or
- Source of Truth, Repository, Base Branch, In Scope, or Verification conflict
  with one another.

If any Contract Validation Failure exists, `jira-work` fails the Ticket Gate.
It must not create a branch, perform any Git mutation, or transition Jira
status. It reports the missing or contradictory content and stops. The Ticket
Contract must be corrected before a new execution attempt.

## Execution Policy

Execution Policy is a higher-order control than a `jira-work` invocation.

| Mode | Allowed lifecycle outcome |
|---|---|
| `suggest-only` | Read the Contract, sources, and Git state; present readiness and a plan only. |
| `patch-with-approval` | After source and preflight gates pass, the Worker still needs the policy's separate mutation approval. |
| `auto-apply` | After every readiness gate passes, the Worker may proceed within the approved scope. |

No mode automatically removes draft status, merges, releases, tags, deploys to
production, runs a migration, or changes secrets. These remain separate
approvals even in `auto-apply`.

## Branch and commit identity

Repository-enforced branch naming, protection, and base-branch rules always
take precedence over a Ticket's `Expected Branch Name`. They differ from a
repository's general naming preference: a general convention applies only when
the Ticket does not supply an expected name that already satisfies enforced
rules.

Branch selection is deterministic in this order:

1. Confirm repository-enforced naming, protection, and base-branch constraints.
2. Use `Expected Branch Name` when it conforms to those enforced constraints.
3. When it is absent, apply the repository's general convention.
4. When neither supplies a name, apply the common fallback.

If `Expected Branch Name` conflicts with a repository-enforced rule,
`jira-work` must not automatically fall back or invent a replacement name. It
must not create a branch, must stop with `Decision Required`, and requires the
Ticket Contract to be corrected and explicitly reapproved before retrying.

| Issue type | Common fallback |
|---|---|
| Feature / Story | `feat/<KEY>-<slug>` |
| Task | `chore/<KEY>-<slug>` |
| Bug | `fix/<KEY>-<slug>` |
| Docs | `docs/<KEY>-<slug>` |
| Tech Debt | `refactor/<KEY>-<slug>` |
| Research | `research/<KEY>-<slug>` |

The issue key preserves its original case. The slug is ASCII lowercase. If a
stable slug cannot be produced, `<prefix>/<KEY>` is valid; arbitrary
romanization is not. An unknown custom issue type requires user judgment rather
than an invented fallback. Commit conventions remain repository-owned, but a
Ticket commit includes the exact Issue Key exactly once.

## Verification and partial failure

Ticket-level Verification and repository verification rules are both mandatory.
If a required check fails, or cannot be executed, the work is not verified:
commit, push, and draft PR are prohibited. The changed files are preserved, and
the result must report the failure evidence and a recovery procedure. This
decision deliberately does not introduce a Ticket-level verification-exception
format; that is an open follow-up decision.

Partial success is state to preserve, not a reason to issue compensating
mutations:

- Never automatically roll back a created branch, commit, push, PR, Jira
  comment, or Jira transition.
- Before retrying, re-read Ticket, branch, remote, PR, and Jira state.
- If push succeeds but PR creation fails, retain and report the remote branch.
- If PR creation succeeds but a Jira comment fails, retain and report the PR.
- Transition to review only after the Jira evidence comment succeeds.
- Report only steps that actually succeeded; do not describe a planned or
  failed step as completed.

Jira evidence comments are append-only by default so recovery retains the
historical evidence rather than rewriting it.

## Optional integration boundary

`jira-ticket` and `jira-work` are not required Public Core skills and are not
included automatically by `make install-shared`. README must not advertise an
uninstalled command as current product functionality.

Jira Connector configuration is optional and must not hard-code credentials,
Cloud ID, project key, or account ID. Connector availability controls
`CONNECTOR_VERIFIED` and required-freshness claims; it does not make optional
`MAIN_HANDOFF` Repository evidence unverifiable. Draft PR and Jira write
providers belong to the Worker lifecycle, not this readiness gate.

## Consequences and non-goals

This decision favors explicit, claim-level gates over a convenient
single-command workflow. It adds handoff-contract maintenance, but prevents
unstructured prose or stale Jira state from becoming repository authorization.
`jira-work` remains a gate rather than an implementation orchestrator. The
implementation boundary is specified in
[Shared Git Preflight and Jira Execution Boundary](shared-git-preflight-jira-execution-boundary.md).
