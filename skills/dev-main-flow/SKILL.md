---
name: dev-main-flow
description: Explicit temporary entry for reviewing an existing development workstream, recommending the next user goal, collecting unresolved Owner decisions, and handing approved work to existing execution, handoff, and Korean reporting skills. General conversation remains read-only planning.
disable-model-invocation: true
metadata:
  source: born-here
  summary: 기존 개발 기능·승인·실행·범용 인계·서비스별 보고를 연결하는 임시 진입 안내
---

# Dev Main Flow — temporary composition entry

## Ownership and invocation

Primary Jira: RPL-113, for Intent/Skill entry only. RPL-120 owns F4, RPL-119 owns F1,
and RPL-93/94/115 plus existing Handoff owners retain their contracts.
RPL-113 and RPL-120 are separate work items under the existing Workstream objective.
This file grants no Writer, branch, installation, merge, deployment, or remote-write authority.

Explicit `$dev-main-flow` starts with read-only planning. A general development conversation
may use the same planning behavior when the approved existing runtime instruction layer
references it; this candidate alone does not establish automatic loading or implicit Native invocation.
Ordinary questions do not require a workstream-wide lookup or start execution.

## Resolve existing dependencies

Read the actual owning contract before using it; retain its source URI and revision.
Resolve dependencies through the supported runtime discovery/catalog or approved source reader,
not paths guessed relative to the user's current working directory.
If a dependency is unavailable, report that stage BLOCKED/NOT_RUN; keep independent authorized planning open.

- Intent and bounded context: existing RPL-113 route/Hook and authoritative task sources.
- Git/work ownership: existing git-work-preflight; keep work-start and jira-work explicit-only.
- Execution: existing adaptive-goal-closure SKILL.md, unchanged explicit invocation and approval gates.
- Handoff: existing handoff-prompt SKILL.md and owning Handoff/Association contracts.
- Korean results: existing engineering-communication-ko SKILL.md and its advisory checker.
- Runtime/authority/cost: existing capability and private-policy contracts when available.

Do not implement a router, scheduler, claim store, handoff transport, report parser,
or a duplicate dependency body here. Do not copy private policy into this public Skill.

## 1. Read-only current work

Identify the caller's actual Workstream, Lane, existing Primary, repository and valid approval scope.
Obtain missing facts from bounded authoritative sources; do not infer Lane or ownership from a directory name.
Check current user functions, unfinished Objective criteria, relevant Jira/PR/HEAD/CI/review and dependencies.
Reuse unchanged valid evidence. Check targeted incoming handoff references through existing Issues/links/records.
An absent search result is not proof of no work, no handoff, or a released Writer.

Return three distinct things: current capability, one recommended next user goal with effect/prerequisites,
and executable approved READY items. Recommendations and READY are not interchangeable.

## 2. One Owner decision bundle

After goal selection, collect only unresolved product contracts and new authority needs.
Keep existing valid approvals; do not ask again merely because a new session or Slice starts.
A selected goal is not YOU-CORE delegation, Actor dispatch, Jira mutation, or Git-write approval.
Unknown Writer Task/branch/worktree custody blocks that writable scope without blocking other safe READY work.
Do not create Jira, reassign a Writer, or edit another Writer's worktree.

## 3. Existing F4 only after its gate

Require both explicit F4 delegation and a valid approved Objective/Scope/AC before entering execution.
Approval-only or a goal selection without explicit F4 remains planning.
Load/apply the existing adaptive-goal-closure contract; do not reproduce its execution loop here.
Pass exact Primary, source revisions, approvals, allowed writes/tests, budget and existing ownership evidence.
Use its Writer -> Test/CI -> independent fixed-HEAD Review -> Finding Delta -> next READY process.
A complete Slice is not a complete Active Objective. If another approved READY remains, continue;
an actual budget/safety stop needs evidence. Unchanged BLOCKED work is not repeatedly diagnosed.
Record actual timestamps and checkpoint evidence; never claim automatic restart or Cloud-to-Cloud control.

## 4. Generic handoff through the existing owner

This applies to another Writer, session, Lane or Workstream, not only AI-to-Normal.
Distinguish product-contract/task handoff from Source Writer-session succession.
Use the existing handoff-prompt human-controlled preparation and review process.
Supply confirmed references and missing-field checks as inputs; do not auto-promote a summary,
read raw transcripts, auto-send a Worker contract, or replace its template with a new schema/validator.

Minimum contextual facts to provide to that existing process:
Source/Target Issue, From/To role or Lane, ContractRef/revision, Source HEAD/CI/Review,
handoff kind/state, acceptance conditions and NextAction.
Treat these as contextual facts in existing records, not new Jira fields or workflow states.
The intake labels below are not aliases for handoff-prompt lifecycle_status or review_state.
Preserve its Context Preflight, unresolved markers, Human Review and manual-transfer template.

PREPARE: evidence, Target, or required contract/review is incomplete.
READY_FOR_ACCEPTANCE: required source evidence and acceptance conditions are ready; Target has not accepted.
ACCEPTED: the authorized Target has freshly checked the exact contract/revision and explicitly acknowledged it.
If Target identity/Issue or acknowledgement is unknown, do not claim acceptance or completeness.
Changed contract/revision requires fresh acceptance under the owning contract.
Product/task acceptance does not release the original Writer, transfer a branch, mark Jira Done,
approve new implementation, or authorize merge/deployment.

## 5. Service F1 and next READY

Use existing engineering-communication-ko reporting; do not implement or bypass its advisory checker.
Report per service/function: current user capability -> actual change ->
implementation / verification / documentation / deployment states ->
unavailable functions and reasons -> next goal, first action, responsible Lane and required conditions.
Keep Jira/PR/SHA as evidence; do not substitute numbers for function descriptions.
If the existing report Skill/checker lacks a requested field, show the contract gap under RPL-119;
do not invent a PASS or fork its implementation here.
End with next independent approved READY, or a precise checkpoint/Owner Gate when none can run.
When no approved READY remains, also recommend one next user goal, its benefit and the exact
Owner decisions or prerequisites needed to make it READY. Do not execute or silently add that
new goal to the current approved Objective.

## Evidence levels and stop boundary

Record separately: Source exists; actual instruction loading; Skill discovery;
Native invocation/apply; actual Subagent execution; Objective Goal Closure; final service F1.
Manual Read/Apply, a descriptor prompt, or a successful Source fixture is not Native invocation evidence.
A local CLI probe or this session's Subagent is not a new Normal/AI Cloud session.
Requested model/reasoning/Fast is not effective attestation; unknown remains UNKNOWN.

This temporary Skill can be removed after the approved default instruction entry covers the same behavior.
Removal or replacement requires its existing Source Owner; no second permanent control plane is created.
