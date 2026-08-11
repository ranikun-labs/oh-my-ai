---
name: jira-work
description: Use only when a user explicitly invokes $jira-work for an existing Jira issue and needs the high-risk repository execution-readiness gate before implementation or resume.
metadata:
  source: born-here
  summary: Main Contract와 Repository Reality를 검증하는 high-risk execution readiness gate
---

# Jira Work — Execution Readiness Gate

## Purpose and invocation boundary

`jira-work` is the risk-based gate between a Main-approved work contract and a
Worker. It validates execution readiness; it does not author a Ticket, replace
Main as Planning Owner, or become an implementation orchestrator.

This is an **explicit-only** workflow. Require an explicit
`$jira-work <ISSUE-KEY>` invocation and the same non-empty Issue Key in the
selected source contract. General questions, branch-name requests, and prose
such as “start this work” do not invoke the gate. `allow_implicit_invocation`
remains false.

The Worker owns implementation, verification, commit, ordinary push, and Draft
PR after a ready result and the active Execution Policy permits those actions.
`jira-work` never merges, releases, deploys, runs a migration, changes a secret,
or expands the approved scope.

## Best-effort telemetry

At skill start, attempt only the shared fail-open event. Do not introduce a
step-level schema.

```bash
if [ -x "$HOME/.local/bin/harness-event" ]; then
  "$HOME/.local/bin/harness-event" emit \
    skill-start \
    --skill jira-work \
    --runtime "${HARNESS_RUNTIME:-codex}" \
    || true
fi
```

The missing binary or a telemetry failure never blocks the gate.
Issue Key, Summary, Ticket content를 Telemetry에 기록하지 않는다.

## Risk lane

Main classifies the work before invocation.

| Lane | Examples | Route |
|---|---|---|
| Fast Lane | General UI, ordinary Feature, Small Bug, simple documentation | Web Main → `git-work-preflight` → Worker. `jira-work` is optional. |
| Deep Lane | Auth/Security, Secret/Privacy, DB or Schema Migration, Backfill, CAS/Lock/Concurrency, Shared Platform, Cross-repository Contract, Destructive Git, Release/Deploy, Repository Ownership | Web Main → `jira-work` → Worker. The gate is mandatory. |

An explicit Fast Lane invocation still runs the full gate. Risk classification
does not weaken any claim once `jira-work` is invoked.

## Source modes

Choose exactly one mode. Never combine modes to fill missing claims.

### CONNECTOR_VERIFIED

Use only when the current session has actual Jira Connector evidence for the
named Issue. Read and validate live Jira state and the Main Contract against
the higher-priority sources below. A remembered, pasted, or prior-session Jira
result is not current Connector evidence. Missing current evidence makes
`Jira Live State: NOT_VERIFIABLE` and stops the gate.

### MAIN_HANDOFF

Use only a structured `jira-work-main-handoff/v1` envelope containing actual,
non-empty values for every field:

1. Issue Key
2. Contract Schema/Version (`jira-work-main-handoff/v1`)
3. Repository
4. Base Branch
5. Expected Base SHA
6. Goal
7. In Scope
8. Out of Scope
9. Do Not Touch
10. Acceptance Criteria
11. Verification
12. Risk Tier
13. Jira Freshness Requirement (`OPTIONAL` or `REQUIRED`)
14. Main Approval Marker (`APPROVED_BY_MAIN`)

`APPROVED_BY_MAIN` is a declarative provenance marker: it states the asserted
source of the handoff. It is not identity authentication, cryptographic proof,
or a digital signature, and it does not establish integrity, identity, or trust
by itself. Schema validation checks structural completeness and consistency;
it does not authenticate who supplied the envelope. Arbitrary user prose, the
marker without the complete schema, or a mismatched Issue Key is blocked. A
separate digest, signature system, and durable machine-verifiable evidence
handoff are out of scope.

## Contract and source validation

For `CONNECTOR_VERIFIED`, normalize and validate the existing Ticket Contract:
Summary, Context, Goal, Source of Truth, In Scope, Out of Scope, Acceptance
Criteria, Repository, Base Branch, Expected Branch Name, Dependencies,
Verification, Do Not Touch, and Definition of Done. For `MAIN_HANDOFF`, validate
the v1 envelope above; do not require Jira-only fields that are absent from that
schema.

Every required value must be non-empty and non-whitespace. `Decision Required`,
`Repository Required`, `Base Branch Required`, and `Not Verifiable` are blocking
sentinels. Unknown placeholders, contradictions, multiple repositories,
incomplete blocking dependencies, and conflicts among Repository, Base, scope,
Acceptance Criteria, Verification, or Do Not Touch block the gate.

## Source of Truth Gate

Validate sources in this order:

1. Accepted Decision
2. Canonical Repository Product and Architecture Documents
3. Confluence Specification
4. Jira Ticket
5. Handoff Candidate
6. Current Conversation

A Jira Ticket is an execution contract, not a canonical Product or
Architecture Decision. A higher-priority source conflict is `CONFLICTED`.
Unread required material is `NOT_VERIFIABLE`; a URL alone is not verified
content. `MAIN_HANDOFF` is approved planning provenance, not permission to
override a higher-priority accepted decision.

## Jira freshness claim

Evaluate Jira freshness independently from Repository claims.

| Mode / requirement | Jira Live State | Repository gate |
|---|---|---|
| `CONNECTOR_VERIFIED` with current evidence | `VERIFIED` or the observed mismatch | Continue only when verified and consistent. |
| `MAIN_HANDOFF` + `OPTIONAL`, without Connector | `NOT_PERFORMED` | Continue; do not downgrade verifiable Repository claims. |
| `MAIN_HANDOFF` + `REQUIRED`, without Connector | `NOT_VERIFIABLE` | Stop the execution gate. |

`NOT_PERFORMED` is not `VERIFIED`. It is allowed only because the approved v1
contract explicitly made Jira freshness optional for that invocation.

## Required Git reality consumption

Run [scripts/git-work-preflight.sh](../../scripts/git-work-preflight.sh) in the
current `jira-work` invocation with the local Repository, Canonical Repository,
Push Remote, Base Branch, Expected Base SHA, expected Issue Branch, Issue Key,
Execution Policy, `--consumer jira-work`, repository-rule evidence, and the
exact Issue-to-Branch association marker.

The preflight must be actually executed. A pasted report, a prior run, or
supplied prose is not consumption. `jira-work` may return ready only when the
current process has `Process Exit Code: 0` and `Preflight Result` is exactly
`READY_NEW_WORK` or `READY_RESUME`. It must consume the fields rather than
reimplement Git safety rules.

Map all other preflight results fail-closed:

| Preflight result | Jira-work conclusion |
|---|---|
| `RECOVERY_REQUIRED` | `JIRA_WORK_BLOCKED`; report recovery evidence. |
| `BLOCKED_DIRTY_TREE`, `BLOCKED_BASE_MISMATCH`, `BLOCKED_DIVERGENCE` | `JIRA_WORK_BLOCKED`; stop. |
| `CONFLICTED`, `NOT_VERIFIABLE` | `JIRA_WORK_BLOCKED`; stop. |
| `ALREADY_MERGED` | `JIRA_WORK_BLOCKED`; implementation forbidden, Jira reconciliation only. |
| Not executed or non-zero exit | `JIRA_WORK_BLOCKED`; stop. |

Repository, Base Branch/SHA, Issue association, Working Tree, local/Push Remote
branch relation, canonical PR state, other-Issue collision, divergence, and
already-merged state remain authoritative outputs of `git-work-preflight`.

## Gate result and lean output

Return `JIRA_WORK_READY` only when the source contract, source priority, Jira
freshness claim, and current Git preflight all pass. The next step is
`PROCEED_TO_IMPLEMENTATION`; it is not proof that implementation occurred.

For a normal ready result use only the lean fields in
[ticket-gate-report.md](templates/ticket-gate-report.md). For any mismatch,
return `JIRA_WORK_BLOCKED` and include detailed claim-level Evidence, the exact
blocking item, and the single safe next step. Do not bury a mismatch in a long
successful-looking report.

Legacy claim-level conclusions such as READY, BLOCKED, NOT_VERIFIABLE,
ALREADY_IN_PROGRESS, ALREADY_MERGED, and CONFLICTED may describe Contract or
Existing Work evidence, but they are not the final execution result.

## Existing Work and branch candidate

Consume the A–H conclusion from `git-work-preflight`; do not reconstruct it
from prose. See [existing-work-status.md](templates/existing-work-status.md).

When a branch candidate is needed, Repository-enforced rules outrank a Ticket
name and general convention. Common fallbacks remain:

| Issue Type | Candidate |
|---|---|
| Feature / Story | `feat/<ISSUE-KEY>-<slug>` |
| Task | `chore/<ISSUE-KEY>-<slug>` |
| Bug | `fix/<ISSUE-KEY>-<slug>` |
| Docs | `docs/<ISSUE-KEY>-<slug>` |
| Tech Debt | `refactor/<ISSUE-KEY>-<slug>` |
| Research | `research/<ISSUE-KEY>-<slug>` |

Preserve Issue Key case. A slug is ASCII lowercase. `Unknown Custom Issue Type`
is `Decision Required`. Never invent a replacement for a verified naming
conflict.

## Execution Policy and safety boundary

`suggest-only` returns the gate evidence and plan only.
`patch-with-approval` requires the separate approval defined by the active
execution policy. `auto-apply` still cannot cross the explicit out-of-scope
boundaries below.

No mode in this PR can remove a Draft state, Merge, Release, Tag, deploy to
production, run a migration, or change a secret. `jira-work` does not create a
Branch, implement code, execute Ticket Verification, commit, push, create a
Draft PR, comment on Jira, or transition Jira; those are Worker actions after
readiness and policy gates. Mutation 0 is the gate's own result.

Never persist a Jira Description, Confluence body, Raw Transcript, Raw Tool Output,
Credential, Token, Secret, Cloud ID, or Account ID. Default Artifact creation is
prohibited.
