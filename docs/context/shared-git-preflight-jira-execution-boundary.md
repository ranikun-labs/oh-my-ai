# Architecture Clarification: Shared Git Preflight and Jira Execution Boundary

**Status:** Accepted architecture clarification — adopted by PM Product
Decision; canonical repository context only after merge to `master`.
**Date:** 2026-07-28
**Scope:** Future implementation boundaries only. No runtime, hook, Connector,
installer, or telemetry behavior is changed by this document. This PR does not
release a Skill or Runtime feature.

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
candidates, while `jira-work` executes an already-approved Ticket Contract.

## Shared `git-work-preflight` contract

Future implementation may extract a shared `git-work-preflight` capability.
Both `work-start` and `jira-work` consume its read-only preflight contract;
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

Extracting this common contract must not change `work-start`'s external
behavior: it still creates a Candidate and ends at Human Review. Function
names, files, language choice, data shape, and call graph are deliberately
deferred to an implementation design after the pure contracts and fixtures
exist.

## `jira-work` gate and mutation boundary

Before any branch creation, `jira-work` must establish all of the following:

```text
existing Ticket Contract
-> canonical source agreement
-> no blocking sentinel
-> Connector available
-> shared Git preflight passed
-> Execution Policy permits the next action
```

V1 has no Connector-less degraded path: absent Connector means no Git mutation,
even where local Git checks could otherwise run. The Connector must obtain its
configuration at runtime or approved environment configuration; credentials,
Cloud ID, project key, and account ID are never embedded in the skill.

After a permitted mutation begins, the workflow may use a draft-PR provider
behind an abstraction boundary. `gh` is acceptable for an initial provider,
but provider selection and its authentication/error semantics must be verified
in the future implementation architecture. Draft-only is part of the boundary;
removing the draft state, merge, release, tag, production deployment,
migration, and secret changes stay outside it.

## Evidence and recovery boundary

Every external mutation is independently observable and can partially succeed.
Therefore future runtime behavior records actual state after each stage rather
than assuming an all-or-nothing transaction:

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

## Approved implementation sequence

| PR | Purpose | Depends on |
|---|---|---|
| PR 0 | Fix the telemetry `:` validation bug and its fixture. | None; intentionally independent. |
| PR 1 | Record this Product Decision and Architecture Clarification. | Accepted design input; independent of PR 0. |
| PR 2 | Add `jira-ticket` pure contract, preview, and fixture. | PR 1. |
| PR 3 | Add `jira-work` pure contract, Ticket gate, and fixture. | PR 1 and the shared Ticket Contract from PR 2. |
| PR 4 | Extract shared `git-work-preflight`. | PR 3; retain the existing `work-start` stop boundary. |
| PR 5 | Add `jira-work` local Git mutation lifecycle. | PR 3 and PR 4. |
| PR 6 | Add `jira-ticket` Atlassian write integration. | PR 2. |
| PR 7 | Add `jira-work` Atlassian comment and transition integration. | PR 5 and PR 6. |
| PR 8 | Decide optional installation, README, and full E2E coverage. | PR 0 through PR 7. |

PR 8 is the first point at which installation instructions can be selected.
Until then, no installer or README feature claim is authorized.

## Open decisions retained for later PRs

- Ticket-level verification exception format.
- Optional-skill installation path: manual guidance, generic installer, or
  Jira-specific opt-in installer.
- Draft PR provider selection and provider-specific recovery semantics.
- Exact `git-work-preflight` module/files/language and how it is consumed
  without changing `work-start`'s public behavior.
- Jira field mapping, allowed transitions, and permission/error handling after
  Connector capability is verified.
