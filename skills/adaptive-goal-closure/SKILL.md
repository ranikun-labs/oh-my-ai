---
name: adaptive-goal-closure
description: Use only when the user explicitly requests F4 Adaptive Goal Closure or names this skill to continue an approved development objective. Reuse task context, separate independent READY and BLOCKED work, coordinate Writer/Test/Independent Review/Fan-in, and report evidence without bypassing Owner or Runtime gates. This is a playbook, not an autonomous cloud dispatcher.
disable-model-invocation: true
metadata:
  source: born-here
  summary: 승인된 목표를 READY→실행→검증→독립 검수→재개까지 이어가는 F4 명시 호출 플레이북
---

# Adaptive Goal Closure — F4 explicit playbook

## Purpose and invocation

Use when the Owner explicitly requests `F4 Adaptive Goal Closure`, `/F4-ADAPTIVE-GOAL`, or this Skill by name for an **approved** workstream objective. Do not invoke merely because a question mentions F4 or "agent loops". This Skill is an operational playbook, not a scheduler, Agent creation API, Runtime permission, or unattended execution guarantee.

**Do not modify the existing `work-start` invocation contract.** A `work-start` Candidate stops at Human Review; it does not authorize this Skill to execute, dispatch an Agent, select a branch, or write to a remote system. An explicit F4 request still requires its own scope and authorization checks.

Existing authority remains outside this file:
- Approved Portfolio / AI Session Governance and the Repository's current `AGENTS.md` or equivalent.
- Jira and accepted Product / Git Docs for the work item, Owner decisions, and current Git/PR state.
- The user's **private** runtime/model/permission policy, when available. Do not copy that private policy into this public Skill.
- Runtime sandbox, tool permissions, installation ownership, Source Merge and Production gates.

## Minimal task input

Prefer a short request containing `Workstream / Objective / Primary Jira / Repo + existing PR / desired result / permitted writes + tests`. Obtain missing **facts** from authoritative sources before making changes. Do not invent a missing Jira, Base, HEAD, Actor, branch, policy state, or permission. If a required write gate remains unknown, perform safe read-only checks or prepare an isolated candidate; do not change another Writer's source.

### Preflight — reuse before creating

1. Identify the single active Objective for this Workstream; confirm the requested work fits its approved scope.
2. Resume the existing Task/Writer and trust only current Task ID or explicit Handoff evidence; a PR author, Jira assignee, or lack of a Cloud listing does **not** prove Writer ownership.
3. Check exact Repo, Base, HEAD, existing branch/worktree and dirty/untracked state, Primary Jira, ownership, dependency, files, YOU-CORE/AI-WRITE/REVIEW split, runtime/tool/CI capability and authorized mutation scope.
4. Mark independent tasks **READY**, tasks waiting for approval/ownership/runner **BLOCKED**, and read-only reviews **REVIEW_ONLY**. Isolate an uncertain lane, not the entire Workstream.
5. Never start a second Writer for the same Primary Jira or writable worktree; never overwrite unrelated changes. Reuse valid evidence from an unchanged HEAD and run targeted Delta verification when appropriate.

## Goal Closure loop (bounded)

```text
Objective + Gate check
  -> READY selection (critical path first)
  -> assigned Writer implements within authorized scope
  -> Native / integration tests and evidence
  -> separate Reviewer on a fixed HEAD or immutable patch
  -> Finding? existing Writer fixes -> targeted retest -> Delta review
  -> Fan-in (real diff, CI, review, unresolved gates)
  -> close this approved Slice -> next READY in the SAME Objective
  -> stop, hand off or checkpoint if no safe READY remains
```

- **Adaptive fan-out:** start with the fewest Workers. Increase only for independent READY items with confirmed owners, no mutable-file/contract collisions, supported Runner, and a measurable benefit. Independent tasks may run in parallel; each task's Writer→Reviewer dependency is sequential.
- **Adaptive reuse/scale-down:** prefer existing session/context and valid test evidence. Return the slot when done or blocked; do not repeatedly spawn an Agent to solve an unchanged gate.
- **Review:** a Writer's self-check, a CI PASS, and a policy-compliant independent Reviewer are separate outcomes. A Reviewer does not fix source. Treat requested model/reasoning/Fast and effective attested values as separate; unknown remains `UNKNOWN`.
- **Failure:** distinguish code defect, environment failure, missing authority, response loss, duplicate execution, stale callback, and unavailable Runner. Do not retry ambiguous remote writes automatically. Avoid the same failing investigation loop.
- **Stop:** approved Objective completed, budget/runtime limit, unsafe work, necessary Owner decision, or all approved READY lanes blocked. Do not expand into a different Objective or create more work just to keep the loop alive. No promise of background or timed execution without actual Runtime support.

## Remote mutation and completion gates

- Explicit Skill invocation is **not** permission to Create/Update Jira, spawn Cloud Workers, install globally, modify private policy, merge/rebase/force/clean Git, deploy, or execute DB cutovers.
- For Jira writes read effective governance and actual field/role permissions first. For Git writes confirm canonical Repo/Base/HEAD, Author/Writer scope and the existing PR template. No implicit task reassignment.
- A safe isolated patch with tests may be `TECHNICAL_CANDIDATE`; it is **not** a verified remote PR fix. PR CI PASS is not Runtime E2E PASS, and a Draft PR is not Source Merge authorization.
- Only say `DONE` when the approved Slice Acceptance Criteria have executable evidence and required Review/Owner gates. Otherwise state `PARTIAL`, `BLOCKED`, or `NOT_RUN` precisely.

## F1 result / checkpoint

Explain first in Korean for someone not in the session: **what changed → user impact → what works → what is still blocked → next action**. Put technical evidence underneath, not before the user outcome.

Record per Primary Jira: Objective, Repo/PR/Branch, Base & verified HEAD, Writer identity and ownership evidence, actual modified files/commits, Native Test, CI, independent Review, Runtime E2E, effective model settings if available, risks and STOP condition. Keep previous evidence as historical, not a new PASS.

### Short task example

```text
Read skills/adaptive-goal-closure/SKILL.md and apply F4.
Workstream: Developer AI Platform
Primary Jira: RPL-120
Repo: ranikun-labs/oh-my-ai
Objective: reduce repeated Codex F4 prompts with a reusable playbook.
Scope: this Skill, its repo-local Codex explicit-discovery link and descriptor, and generated index only; draft PR, no global installation, merge, or production changes.
Acceptance: unchanged work-start gate, generated instructions check,
and clear manual vs actual-runtime evidence.
```

The example is not a standing authorization for that Jira or Repository.
