# Architecture Clarification: Shared Git Preflight and Jira Execution Boundary

**Status:** Accepted architecture clarification — RISK_TIERED_HYBRID.
**Date:** 2026-08-11
**Scope:** Shared Git preflight, Jira execution-readiness, and Worker boundaries.

This clarification records the implementation boundary for the product decision in
[Jira-driven Work Lifecycle](jira-driven-work-lifecycle.md) without changing
the current Public V1 `work-start` behavior.

## Existing `work-start` boundary remains intact

`work-start` continues to:

```text
create Candidate -> stop at Human Review
```

It does not choose execution, create a working branch, or run `jira-work`.
Conversely, `jira-work` must not directly invoke the `work-start` runtime.
These are different product boundaries: `work-start` gathers reviewable context
candidates, while `jira-work` gates an already-approved execution Contract.

## Shared `git-work-preflight` contract

The shared `git-work-preflight` capability is the read-only Repository gate.
Both `work-start` and `jira-work` consume its contract;
they retain their distinct runtime and stop boundaries.

The contract reports, at minimum:

| Check | Required conclusion |
|---|---|
| Repository | Local repository identity and whether it matches the Ticket Contract. |
| Canonical Repository | GitHub owner/repository identity, authoritative Base ref, canonical PR target, PR collision, and merged-PR state. |
| Push Remote | Configured Feature Branch push destination and its reachable/ref-resolvable state. It is not canonical truth merely because it is named `origin`. |
| Base Branch | Required base branch and its resolvability. |
| Local and remote HEAD | Actual revisions used to detect stale or divergent state. |
| Working Tree | Clean, dirty, staged, untracked, and conflicting state. |
| Existing Branch | Whether the expected branch exists locally or remotely and is safe to resume. |
| Existing PR | Whether a PR already exists for the branch/Ticket and its state. |
| Divergence | Ahead/behind/diverged conditions between relevant refs. |
| Do Not Touch | Contract prohibitions that make a proposed mutation unsafe. |
| Prohibited Git mutation | A direct declaration of any mutation the current gate forbids. |

The preflight is a gate, not a repair tool. It must surface a dirty tree,
diverged branch, unexpected remote, duplicate PR, or `Do Not Touch` conflict;
it must not reset, stash, clean, force checkout, force-push, rebase, delete
branches, perform any form of history rewrite, or silently select another
Ticket or branch. A failure remains evidence for human review.

This clean-tree check belongs to the Entry or Resume Readiness stage, before
implementation starts or resumes. Once approved implementation has produced
intentional changes, tests, builds, and diff checks are Execution Verification;
the Entry Preflight is not a mid-implementation verification gate. This stage
distinction is a workflow boundary, not a separate lifecycle runtime.

A clean local-only Issue Branch is new-work state rather than recovery state
only when its HEAD equals the authoritative canonical Base, its unique Feature
Commit count is zero, the Push Remote Feature Branch and canonical PR are both
verified absent, and the Issue-to-Branch association is exact. Any unique
commit, unclear ancestry, unavailable remote/PR evidence, or association gap
preserves `RECOVERY_REQUIRED`, `NOT_VERIFIABLE`, or `CONFLICTED`.

This common contract does not change `work-start`'s external behavior: it still
creates a Candidate and ends at Human Review.

## `jira-work` execution-readiness boundary

Before the Worker starts or resumes implementation, `jira-work` must establish:

```text
explicit invocation + selected Source Mode
-> complete Main-approved Contract
-> canonical source agreement
-> claim-level Jira freshness conclusion
-> actually executed shared Git preflight passed
-> JIRA_WORK_READY
```

`CONNECTOR_VERIFIED` is valid only with actual current-session Connector
evidence. `MAIN_HANDOFF` requires `jira-work-main-handoff/v1` and
`APPROVED_BY_MAIN`; the marker is declarative provenance, not identity or
cryptographic trust. Optional freshness without a Connector is
`NOT_PERFORMED`; required freshness is `NOT_VERIFIABLE` and stops. A pasted
preflight report does not count as consumption, and `jira-work` cannot return
ready unless the current preflight process returns `READY_NEW_WORK` or
`READY_RESUME` with exit code 0.

The Worker owns implementation, tests, commit, ordinary push, and Draft PR.
Removing Draft state, merge, release, deploy, migration, and secret changes
remain outside this gate.

## Worker evidence and recovery boundary

Every Worker mutation is independently observable and can partially succeed.
The Worker records actual state after each stage rather than assuming an
all-or-nothing transaction:

```text
Git branch / commit / push
  -> draft PR
  -> append-only Jira evidence comment
  -> permitted review transition
```

Retry begins by re-querying Ticket, branch, remote, PR, and Jira state. No
automatic rollback is issued. A successful PR with a failed Jira comment stays
open; a successful push with failed PR creation leaves the remote branch. A
review transition is attempted only after the append-only evidence comment has
succeeded. Required verification failures preserve changed work and report the
commands, failure evidence, and recovery action, while prohibiting commit,
push, and draft PR.

## Telemetry is a separate defect

Plugin-qualified skill names include `:`, but the current `harness-event`
validation regular expression rejects that character. This is not part of Jira
Lifecycle implementation. It is a minimal, independent bug fix with these
constraints:

- retain existing validation intent and fail-open behavior;
- extend only the telemetry fixture needed to prove qualified skill names; and
- do not add a `jira-work` step-level telemetry schema in this scope.

## RPL-67 implementation boundary

RPL-67 changes only the shared preflight contract and the `jira-work`
execution-readiness contract. It does not redesign `jira-ticket`, add an
Evidence Server or Cloud Runtime, implement durable machine-verifiable handoff,
automate merge/release/deploy, or execute a migration. Draft PR provider and
Jira write/reconciliation behavior remain Worker concerns outside this gate.
