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

## Mandatory execution-role isolation

These are invariants of every authorized F4 execution, including direct invocation, wrapper composition, resumed work, and Finding closure. They are not model-selection preferences.

- **Main / Lead (when assigned):** decide goals and scope, coordinate and delegate, reconcile custody, check evidence/HEAD/CI identity proportionately, perform fan-in, and select the next approved READY. Do not implement source or take over Writer verification, including through another coordinating actor.
- **Authorized Writer:** own the approved Slice end to end: implementation, final edits, test authoring, builds, self-tests, failure investigation and fixes, affected regression tests, required CI follow-through and evidence. An intermediate patch or pending required CI is not a completed Writer result. An explicitly authorized integration Writer may perform integration tests under the same custody rules.
- **Independent Reviewer:** inspect the fixed HEAD or immutable patch and perform risk-proportionate independent verification; return Findings to the Writer. Never fix the reviewed source or represent a Writer self-check as independent review.

**No Main takeover.** Neither Main nor Lead may perform Writer work merely because it is small, only one edit or test remains, a Writer finished early, delegation failed, a budget was exhausted, or the assigned model is unavailable. This applies to work not yet delegated as well as work already delegated. Resume the current Writer after verifying identity, ownership, scope and current evidence. If unavailable, use only an authorized succession or handoff after reconciling prior attempts and custody; otherwise checkpoint the affected Lane as BLOCKED and continue independent approved READY. Never silently promote a coordinating actor to Writer. Only an explicit Owner assignment to change that actor's role for a bounded scope permits Writer execution; record the assignment, verify custody and policy, and preserve any required independent Review and Merge gates. It does not authorize concurrent Writers, self-approval, or an exception for future work.

**No silent model escalation.** Before dispatch, resume or succession, use the approved role-specific model, reasoning and speed/service-tier policy and verified Runtime capability. Do not replace the Writer with a more expensive Main, Reviewer, or alternative model merely to finish. If the policy cannot be satisfied or mandatory settings cannot be attested under the existing policy, stop that Lane and preserve the checkpoint. Keep requested and effective settings separate; mark unobserved values UNKNOWN. An approved role or model change is not proof of effective application.

**Evidence reuse, not duplicate execution.** Main/Lead may read bounded evidence to verify the approved scope, fixed HEAD, CI status, acceptance and approval facts; they must not redo the Writer's full code investigation, build or regression suite as a substitute for valid evidence. If the evidence is stale, incomplete or conflicting, request only the relevant additional work from the Writer or independent verification from the Reviewer. Preserve risk-required verification; this is not a reason to skip required tests on changed code.

**Role-compliance gate.** Check assignment, custody, policy and capability at dispatch, resume, Finding handoff and next READY. At fan-in distinguish actual actors and work performed, requested/effective settings, available usage evidence and unresolved gaps. If unauthorized takeover or escalation is observed, stop that Lane, preserve changes and evidence, reconcile ownership and route the necessary recovery/verification to the authorized actors. Do not promote a violation to a normal completed Slice; report the violation, impact, recovery and remaining gates. Unknown observation coverage is not evidence of compliance. Reuse the existing reporting and policy contracts; do not invent telemetry, a new orchestrator, or tool enforcement. This playbook is an instruction contract, not proof of Runtime-level prevention.

## Goal Closure loop (bounded)

```text
Objective + Gate check
  -> READY selection (critical path first)
  -> assigned Writer implements, fixes, tests and follows through required CI within authorized scope
  -> Writer returns fixed HEAD / immutable patch and evidence
  -> separate Reviewer on a fixed HEAD or immutable patch
  -> Finding? existing Writer fixes -> targeted retest -> Delta review
  -> Fan-in (real diff, CI, review, role compliance, unresolved gates)
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

Record per Primary Jira: Objective, Repo/PR/Branch, Base & verified HEAD, Writer identity and ownership evidence, actual modified files/commits, Native Test, CI, independent Review, Runtime E2E, actual role participation and role compliance/violations, requested/effective model settings, available usage evidence (UNKNOWN when unobserved), risks and STOP condition. Keep previous evidence as historical, not a new PASS.

### Short task example

```text
Apply the invoked adaptive-goal-closure SKILL.md procedure to the approved objective.
Workstream: Developer AI Platform
Primary Jira: RPL-120
Repo: ranikun-labs/oh-my-ai
Objective: reduce repeated Codex F4 prompts with a reusable playbook.
Scope: this Skill, its repo-local Codex explicit-discovery link and descriptor, and generated index only; draft PR, no global installation, merge, or production changes.
Acceptance: unchanged work-start gate, generated instructions check,
and clear manual vs actual-runtime evidence.
```

The example is not a standing authorization for that Jira or Repository.
