---
name: jira-ticket
description: "Use for an explicit request to create one Jira ticket from a valid Ticket Contract. Runs the Jira MCP-backed Create Workflow: capability gate, duplicate search, contract preview, current-preview approval, one Create request, and returned Issue verification."
metadata:
  source: born-here
  summary: Jira MCP-backed Create Workflow로 중복·승인·반환 Evidence를 fail-closed 처리
  routing:
    visibility: optional
    risk_level: medium
    task_types:
      - jira_ticket_planning
      - jira_ticket_create
      - jira_backlog_planning
    triggers:
      - kind: keyword
        values:
          - jira ticket
          - jira backlog
          - Jira 티켓
          - Jira 백로그
          - Confluence 명세
      - kind: intent
        values:
          - plan_jira_ticket
          - create_jira_ticket
          - plan_jira_backlog
    keywords:
      ko:
        - Jira 티켓
        - Jira 백로그
        - 티켓으로 정리
        - 티켓으로 만들어줘
      en:
        - jira ticket
        - jira backlog
        - create jira ticket
    use_when:
      - 명시적으로 Jira Ticket을 생성하거나 Ticket Preview 또는 Backlog 분해를 요청한 경우
    do_not_use_when:
      - Jira 연동 방식 설명 또는 Jira Issue와 무관한 일반 계획만 요청한 경우
    requires:
      - explicit_jira_planning_intent
---

# Jira MCP-backed Create Workflow

`jira-ticket`은 하나의 검증된 Ticket Contract를 안전하게 Jira Issue로
만드는 optional workflow다. MCP/Plugin이 실제 검색·생성을 수행하고, 이
Skill은 계약·순서·승인·중복 방지·Evidence 검증만 담당한다.

```text
jira-ticket Skill
  -> Contract / Duplicate / Preview / Approval / Evidence gate
Codex·Claude Jira MCP/Plugin adapter
  -> jira.search / jira.create capability and runtime tool invocation
Jira MCP/Plugin
  -> search and create
```

이 Workflow는 direct endpoint 호출, credential 저장, 자체 SDK가 아니다.
`jira-work` Read Workflow, Jira comment·status transition, Local Git
Lifecycle, Merge·Release·Deploy도 수행하지 않는다.

## Best-effort telemetry

```bash
if [ -x "$HOME/.local/bin/harness-event" ]; then
  "$HOME/.local/bin/harness-event" emit \
    skill-start \
    --skill jira-ticket \
    --runtime "${HARNESS_RUNTIME:-codex}" \
    || true
fi
```

Telemetry failure does not alter a Workflow gate. Ticket body, Issue Key, raw
MCP output, credential, token, Cloud ID, and account ID are never telemetry.

## Intent and scope

Start only for an explicit request such as `이 작업 Jira 티켓으로 만들어줘` or
`Jira 티켓 만들어줘`. A possibility question remains suggestion-only.

Single Ticket mode can create at most one Issue after the gates below. Backlog
mode remains a planning preview: each child needs its own valid Contract,
duplicate search, Preview, and current-preview approval before it can create.

## Ticket Contract gate

Use `templates/ticket-contract.md` for the immutable 14-field Contract:

```text
Summary
Context
Goal
Source of Truth
In Scope
Out of Scope
Acceptance Criteria
Repository
Base Branch
Expected Branch Name
Dependencies
Verification
Do Not Touch
Definition of Done
```

`Decision Required`, `Repository Required`, `Base Branch Required`, and `Not
Verifiable` are blocking sentinels. Missing, whitespace-only, unresolved,
contradictory, or source-conflicted fields also stop before search and Create.
Source order is Accepted Decision, Canonical Repository Product and
Architecture Documents, Confluence Specification, Explicit User Request,
Handoff Candidate, then Current Conversation. Unread content is `Not
Verifiable`; a URL is not evidence by itself. The canonical source name is
`Canonical Repository Product and Architecture Documents`.

Issue Type must be a semantic Feature, Story, Task, Bug, Research, or Tech
Debt candidate. Otherwise use `Issue Type Decision Required`. **Branch-name fallback** preserves the returned Issue Key only after verification:
`feat/<ISSUE-KEY>-<slug>`, `chore/<ISSUE-KEY>-<slug>`,
`fix/<ISSUE-KEY>-<slug>`, `research/<ISSUE-KEY>-<slug>`, or
`refactor/<ISSUE-KEY>-<slug>`; it never creates a branch.

## A. Capability Gate

The runtime adapter checks the active Codex·Claude Jira MCP/Plugin and exposes
only these semantic capabilities to this Skill:

```text
jira.search
jira.create
```

The Skill must verify that both capabilities are actually connected for this
session, that the intended project is `RPL`, and that this check produced
evidence. Static runtime metadata describes possible support; it never proves
current connection state. Do not place runtime-specific tool function names in
this contract.

The canonical runtime entry is `oh-my-ai jira-ticket --json <protocol-input>`.
It emits `jira.search_required`, accepts the runtime-normalized search result,
emits a Preview and `preview_id`, accepts an approval object, emits
`jira.create_required`, then accepts the runtime-normalized Create result.
Codex·Claude adapters execute the actual MCP/Plugin Tool between these steps
and return `tool_call_count`, capability evidence, and Jira Site Origin; the
Core never receives a runtime Tool function name.

If either capability is unavailable or connection evidence is missing, stop:

```text
Mutation: 0
Create Attempted: false
Result: Not Verifiable
Allowed Next Step: Jira MCP 연결 또는 수동 Contract 검토
```

## B. Duplicate Search

Before every Create attempt, call `jira.search` exactly once using the Summary
keywords, Product, Repository, Area, related PR/Branch/Decision, a supplied
existing Issue Key, creation-time range, and a stable Contract fingerprint
candidate. The fingerprint is search evidence only; do not add a Jira Product
field for it.

| Search conclusion | Required action |
|---|---|
| Exact existing Issue | Reuse it; Create 0. |
| Similar Issue | Human decision required; Create 0. |
| No Issue | Show the Create Preview. |
| Failure, timeout, partial, or unclear | Not Verifiable; Create 0. |

## C. Ticket Contract Preview

Use `templates/mcp-create-preview.md`. Before approval it must show all 14
Contract fields, capability state, duplicate result and reuse candidate,
expected Product/Repository/Area, Assignee/Priority/Label, and `Mutation: 0`.
Preview Evidence must state that no Create call has run. Keep Preview Evidence
separate from Write Evidence.

## D. Current-preview human approval

Only a current Create Preview's explicit approval object authorizes one Create
call:

```json
{ "status": "approved", "preview_id": "<current SHA-256 preview_id>" }
```

The `preview_id` is SHA-256 over canonical Contract, Create Metadata (including
Technical Labels), duplicate
search/reuse result, Branch/PR/HEAD, runtime, and capability evidence. A
Contract, Metadata, or search-result change invalidates earlier approval.
Do not infer approval from general positivity, a previous session, Contract
edits, `검토해줘`, or `계속해`. Rejected, missing, or stale approval leaves
`Create Attempted: false` and `Mutation: 0`.

## E. Create

The minimum Create input is Project, Issue Type, Summary, Assignee, Priority,
Product, Primary Repository, and Area. A missing, whitespace-only, or `Not
Verifiable` value is a hard stop before Search or Create:

```text
Create Attempted: false
Create Call Count: 0
Mutation: 0
Verification Status: NOT_VERIFIABLE
Allowed Next Step: 누락 Metadata 보완
```

Branch and Current HEAD remain Description evidence, not minimum Create input.

After approval, derive the Create request only from that approved canonical
Preview Snapshot; do not reread mutable Contract or Metadata. Technical Labels
are canonicalized as a trimmed, deduplicated, lexically sorted set, so their
order is not meaningful but an addition, removal, or value change is stale.
Call `jira.create` exactly once with Project `RPL`, Issue Type,
Summary, Description, Assignee, Priority, and needed technical Labels. No
custom field is created. Description starts with:

```text
Product:
Primary Repository:
Area:
Assignee:
Priority:
Branch:
PR:
Current HEAD:
```

Product, Repository, and Area remain Description facts; generic Labels do not
replace them. Append all 14 Contract fields to the Description. Record the
actual invocation only in Write Evidence.

## E.1 G3 Target Create — optional, activation-gated

**Legacy Create remains the default.** A request without `metadata.target_create` MUST produce the existing `jira.create_required` payload unchanged. Target mode is **preparation only** until Jira Admin/Owner separately approves G3 activation. This Skill/PR does not authorize a test Issue, Admin change, or Cutover.

Only Owner-supervised, **one Writer, serial Create** may enable `metadata.target_create.mode="single_supervised"` when all of the following are externally verified and supplied to Core:

- Live Jira Create metadata for the exact `RPL` Issue Type, with the **Legacy Product/Component/custom Labels no longer required and default-free**, new Product/Component required, and Concern optional; supported types are Epic/Task/Feature/Bug/Research. Story/Subtask/Tech Debt are not eligible.
- Exact verified option pairs (`id`, `value`) for `customfield_10108` Product, `customfield_10109` Component, and 0–3 distinct `customfield_10110` Concern options. An unknown value, unsupported type, or stale metadata blocks **before Jira Search/Create**. The runtime adapter (not user prose alone) must supply `source=live_jira_create_metadata`, `observed_at`, exact field requirements and `allowedValues`.
- Separate G3 Owner `cutover.approval_ref`, `activation_ref`, effective-from/to and runtime request time, verified Reader/Board/Automation/Rollback/Ledger readiness, and stable `request_id` + `ledger_ref`. These must be actual evidence; an invented reference or `true` flag is NOT approval.
- Verified connected capabilities `jira.search`, `jira.create`, `jira.read`, `jira.intent.persist`, and `jira.origin.persist`. Capability advertisement alone is insufficient.

**Target workflow (semantic actions, runtime adapter executes external persistence and Jira):**

1. Existing duplicate Search → current Preview → one explicit `preview_id` approval. The Preview SHA binds Target field IDs/options, live metadata, G3 activation, and Create request ID. Altered selection/metadata invalidates approval.
2. `jira.intent_persist_required`: store a **durable pending Intent before Create** with unique `create_request_id`, activation and approved Preview reference. Accept `intent_result` only when persisted with matching IDs and durability evidence. No Create if it fails.
3. `jira.create_required`: use approved Snapshot only. Send Target Product/Component/Concern field IDs plus approved nonclassification fields, never legacy Product/Component/custom Labels. Generic technical `labels` remain distinct.
4. `jira.read_required`: GET the returned Issue and confirm IssueKey/Type and **actual saved Target option IDs**. On mismatch, absence, timeout, or uncertain Create, quarantine and never automatically retry or silently fall back to Legacy.
5. `jira.origin_persist_required`: persist IssueKey + request ID + `Origin=target_create`, `Phase=create_ready`, `ReadAuthority=target`, `WriteAuthority=target` in the approved ledger. Report success only on matching `origin_result` durability evidence. Failure means `UNKNOWN_ORIGIN`, `none/frozen`.

Runtime must preserve the Intent/Origin ledger as a versioned, durable source that the actual Reader/Board/Automation consume. This code **emits semantic actions; it does not provide a production ledger adapter**, change Jira Admin fields, or itself perform remote actions. `approval_ref`, `activation_ref`, and `readiness` are preconditions supplied after independent verification, not generated by the workflow.

## F. Result verification

Accept success only when the returned Create result—not a local guess—contains
an Issue Key and URL, Project `RPL`, the requested Summary, and evidence that
it is a Create result rather than a search hit. The Key must match
`^RPL-[1-9][0-9]*$`; its prefix must be `RPL`; the URL must be a
`/browse/<returned-key>` URL on the Jira Site Origin verified by the Runtime
Adapter. Also report the normalized Tool Call Count. A partial Key or URL is
preserved as Evidence but remains `possibly_applied / not_verifiable`.

## G. Ambiguous result and idempotency

Timeout, connection reset, missing response, a success message without Key,
partial response, wrong Project, or mismatched Summary is never retried
automatically:

```text
Mutation Status: Possibly Applied
Result: Not Verifiable
Automatic Retry: false
Next Action: 동일 조건으로 Jira 재검색
```

The next run starts from Duplicate Search. If it finds the Issue, reuse it; if
search remains unclear, stop for human judgment. Never issue a compensating
Create or automatic rollback.

## Output boundary

Report only observed evidence: Capability Gate, Search Attempted/Search Result,
Duplicate Status, Approval Status, Create Attempted/Create Call Count, Mutation
Status, Actual Issue Key/URL, Verification Status, and Allowed Next Step. Do
not claim a Jira mutation, Issue Key, URL, comment, transition, branch, code,
commit, push, PR, or merge without returned evidence.
