---
name: dev-main-flow
description: Explicit entry for resuming an existing approved development objective through current-context review, existing F4 execution, handoff, and service reporting. Status and design-only requests remain read-only.
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
These Jira references identify the owners of this Skill's Source contracts; they do not replace the caller's actual Workstream, Objective, or Primary Jira.
This file grants no new Writer assignment, branch custody, global installation, private-policy or private-data access, merge, deployment, or remote-write authority.

Every explicit `$dev-main-flow` workflow must end with a function-first Korean F1 section, including bare/status/design-only, full continuation, execution, BLOCKED/no-READY, and budget-stop outcomes. Do not wait for `/F1` or another prompt. This is an output requirement only: a bare call remains read-only planning and does not delegate F4 or grant write authority.

The direct explicit request below means: resume the existing approved objective, apply this complete workflow, and read/apply the existing F4 playbook when its gates pass. Other direct explicit `$dev-main-flow` requests that clearly ask to continue an existing approved objective use the same workflow. This is the Owner's explicit F4 request for that invocation; do not ask for a second long prompt or a separate `$adaptive-goal-closure` invocation.

```text
$dev-main-flow
Developer AI Platform 기존 목표 이어서 진행해.
```

That request does not create scope, approve new product decisions, authorize Jira fields or Git writes, assign or replace a Writer, grant Runtime capabilities, or satisfy the Objective/Scope/Acceptance Criteria/ownership gates below. A direct request limited to status, design review, or a next-goal recommendation remains read-only even when it names this Skill. An ordinary development conversation may receive only the existing read-only planning behavior when an approved runtime instruction already references it; a quoted or discussed invocation, ordinary conversation, or this candidate alone does not invoke the full workflow or establish automatic loading, Native discovery, or Apply.

## Full-wrapper workflow

Apply this ordered workflow only for a direct explicit continuation request. Start the run with an actual UTC timestamp and a default maximum budget of 60 minutes. Use the time for safe approved work, then checkpoint at the budget boundary; finish earlier when every approved READY item is exhausted. Never imply background execution, an automatic restart, or control over another Cloud session.

### 1. Resume the real workstream and establish current truth

Identify the existing Workstream, active Objective, Primary Jira, repository, PR, verified Base/HEAD, branch/worktree custody, checkpoint/context, prior decisions, dependencies, and actual Writer/Task. Use supported connected sources or the approved source reader; do not infer identity, ownership, or approval from a directory name, assignee, PR author, copied text, or missing search result. Read only relevant context and never inspect raw transcripts.

Follow the current explicit Owner instruction for this request and its authorized scope; an older summary or Skill recommendation cannot override it. Keep authority tied to the fact being checked: accepted decisions and canonical accepted Git documents govern product/architecture contracts; Jira is the live record for issue status, recorded Acceptance Criteria, dependencies, and next actions; actual repository HEAD/diff, tests/CI, and independent review establish implementation reality. Confluence is a human-readable projection and context source; verify the accepted Git source where available, and do not promote a projection or handoff candidate into a new approval. If sources conflict, preserve the conflict and request only the decision needed instead of silently replacing an accepted contract. For each source, retain its URI/path, revision or observed timestamp, and the time it was read. Prefer live retrieval during this run. Reuse older evidence only when its referenced revision/HEAD is unchanged and the evidence is still valid; otherwise refresh it or mark it stale/unknown. Do not claim “latest” without current retrieval evidence.

Compare Confluence and Git documentation, Jira facts/acceptance criteria/dependencies/next actions, and the actual PR/HEAD/checkpoint. Report contradictions as `CONFLICTED` and collect only the decision needed to resolve them. If a connector, document, checkpoint, or current runtime source is unavailable, name that gap and its effect; keep independent safe work moving.

Establish separately: (a) current user-facing capability by service/function, (b) actual work completed and remaining against the approved Objective, (c) approved executable READY work, and (d) a recommended next user goal with benefit and prerequisites. A recommendation is not approved scope or READY work. If the active Objective or its approval cannot be verified, do not infer one; stop execution with `BLOCKED/NOT_VERIFIABLE`, identify the exact Owner input needed, and continue only independent safe review. Distinguish a completed Slice from a completed Objective.

### 2. Apply a proportional `/senior` review and resolve only real decisions

Review the accepted goal, scope, current implementation and documentation, failure modes, dependencies, security/privacy risks, whether acceptance criteria are observable and cover the goal, rollout and rollback. Identify design gaps and the smallest scope that meets the existing need; recommend a proportionate improvement without adding speculative architecture or re-opening valid decisions. Reuse unchanged approvals and evidence.

Bundle only unresolved product or authority decisions that prevent a READY item. For each, state the exact scope or authority needed, why it blocks, the consequence of each viable choice, and one recommendation with its reason. Ask once for the bundle and continue other independent approved READY work. Keep proposed scope changes outside the current Objective until the Owner approves them. Do not turn a recommended improvement, missing source, or Jira discrepancy into a guessed decision.

### 3. Maintain existing Jira records only within explicit field scope

Read existing Jira facts and reconcile progress, Acceptance Criteria, dependencies, and next actions against current evidence. Update an existing issue only when the authorization identifies the target issue and fields, or an exact previously approved reusable scope covers those fields, and the connected Jira role/field policy permits the update. Otherwise provide the proposed field delta without writing it. Jira progress metadata is not implementation evidence.

Do not create an issue by default, transition an issue to Done without proven acceptance, change assignee or ownership, or update unspecified fields. Treat any role/ownership metadata separately from implementation and require its own explicit authority. A missing Jira connector or policy check blocks only that Jira mutation; it does not block independent read-only review or approved repository work.

### 4. Enter the existing F4 playbook without weakening its gates

The full-wrapper request above is the explicit request to apply the existing adaptive-goal-closure playbook, so no second prompt is needed. Read the actual dependency through supported Skill discovery/catalog or an approved source reader; retain its source URI and revision and follow its current contract. If Native Skill discovery or Apply is unavailable but the approved source is readable and the existing authority permits manual use, label that evidence `MANUAL_READ_APPLY`; never report it as Native. Do not treat the copy in this Skill or a manually remembered procedure as proof that the dependency was loaded. If the source or required authority cannot be verified, mark only the F4 execution stage `BLOCKED/NOT_RUN`, report the actual limit and safe alternatives, and continue independent read-only review or other approved READY work.

Before any writable F4 lane, verify the existing approved Objective, exact Scope, Acceptance Criteria, permitted actions, repository/Base/HEAD, current Task and Writer custody, runtime/tool/CI capability, and required Git/Jira evidence. `git-work-preflight` is consumer-only: it may be requested only by an explicitly invoked `work-start`, `jira-work`, or `manual-review` consumer. This wrapper does not invoke those consumers or the preflight implicitly. If that evidence is required but unavailable, block only the affected lane and continue independent approved READY work. The wrapper invocation supplies explicit F4 intent but none of those facts or permissions. If Writer identity or worktree custody is unknown, block that writable lane without blocking independent READY reviews. Do not start a duplicate Writer, take over another Writer's branch, create Writer succession, or dispatch a Worker without supported Runtime capability and explicit ownership/dispatch authority.

Follow the existing playbook's loop: authorized Writer → actual tests/CI → independent review of a fixed HEAD → finding returned to the same Writer → targeted retest and Delta review → fan-in → next independent approved READY. Keep Writer, Test/CI, Reviewer, and Owner decisions distinct; use only the safe, bounded parallelism and evidence reuse allowed by the dependency. Do not repeat an unchanged blocked diagnosis or duplicate the F4 engine contract here.

Stop the whole run at the approved Objective boundary, when no approved READY item remains that can safely proceed, or at the 60-minute budget. A required Owner decision or lane-specific unsafe condition blocks only the affected scope; continue independent approved READY work unless the constraint applies to the whole run. All approved READY items being exhausted is a normal early stop. Record actual start/stop timestamps and a checkpoint with completed Slice, next READY or blocker, evidence, and required Owner decision. Never describe a Slice as whole-Objective completion without the Objective's acceptance evidence. Do not claim successful Native invocation, Subagent/Cloud execution, or effective model settings without direct evidence; requested model/reasoning/Fast remain distinct from actual attestation, and unknown is `UNKNOWN`.

## Resolve existing dependencies

Read the actual owning contract before using it; retain its source URI and revision.
Resolve dependencies through the supported runtime discovery/catalog or approved source reader,
not paths guessed relative to the user's current working directory.
If a dependency is unavailable, report that stage BLOCKED/NOT_RUN; keep independent authorized planning open.

- Intent and bounded context: existing RPL-113 route/Hook and authoritative task sources.
- Git/work ownership: `git-work-preflight` is consumer-only and may be requested only by explicit `work-start`, `jira-work`, or `manual-review` consumers; this wrapper invokes none of them or the preflight implicitly.
- Execution: existing adaptive-goal-closure SKILL.md; this explicit wrapper request supplies the F4 invocation, while its Objective, ownership, Runtime, and mutation gates remain unchanged.
- Handoff: existing handoff-prompt SKILL.md and owning Handoff/Association contracts.
- Korean results: existing engineering-communication-ko SKILL.md and its advisory checker.
- Runtime/authority/cost: existing capability and private-policy contracts when available.

Do not implement a router, scheduler, claim store, handoff transport, report parser,
or a duplicate dependency body here. Do not copy private policy into this public Skill.

## Read-only status and planning requests

For a status, design-only, or recommendation request, identify the caller's actual Workstream, Lane, existing Primary, repository and valid approval scope. Obtain missing facts from bounded authoritative sources; do not infer Lane or ownership from a directory name. Check current user functions, unfinished Objective criteria, relevant Jira/PR/HEAD/CI/review and dependencies. Reuse unchanged valid evidence. Check targeted incoming handoff references through existing Issues/links/records. An absent search result is not proof of no work, no handoff, or a released Writer.

Keep three facts distinct in the final F1: current capability, one recommended next user goal with effect/prerequisites,
and executable approved READY items. Recommendations and READY are not interchangeable.

## One Owner decision bundle

After goal selection, collect only unresolved product contracts and new authority needs.
Keep existing valid approvals; do not ask again merely because a new session or Slice starts.
A selected goal is not YOU-CORE delegation, Actor dispatch, Jira mutation, or Git-write approval.
Unknown Writer Task/branch/worktree custody blocks that writable scope without blocking other safe READY work.
Do not create Jira, reassign a Writer, or edit another Writer's worktree.

## Existing F4 gates (apply during full continuation)

The direct full-wrapper invocation supplies explicit F4 intent as defined above. A status/design-only request, an approval-only message, or goal selection without that invocation remains planning. Still require a valid approved Objective/Scope/AC and all source playbook gates before entering execution. Pass exact Primary, source revisions, approvals, allowed writes/tests, budget and existing ownership evidence. Do not reproduce or replace the F4 dependency's execution contract.

## Generic handoff through the existing owner

This applies to another Writer, session, Lane or Workstream, not only AI-to-Normal.
Distinguish product-contract/task handoff from Source Writer-session succession.
Use the existing handoff-prompt human-controlled preparation and review process.
Supply confirmed references and missing-field checks as inputs; do not auto-promote a summary,
read raw transcripts, auto-send a Worker contract, or replace its template with a new schema/validator.

Minimum contextual facts to provide to that existing process:
Source/Target Issue, From/To role or Lane, ContractRef/revision, Source HEAD/CI/Review,
handoff kind/state, acceptance conditions and NextAction. Treat these as supplied context for the existing human-reviewed template, not a new schema or Jira fields.
Treat handoff as applicable across Writers, sessions, Lanes and Workstreams. Never treat a product/task handoff as Writer succession.
The intake labels below are not aliases for handoff-prompt lifecycle_status or review_state.
Preserve its Context Preflight, unresolved markers, Human Review and manual-transfer template.

PREPARE: evidence, Target, or required contract/review is incomplete.
READY_FOR_ACCEPTANCE: required source evidence and acceptance conditions are ready; Target has not accepted.
ACCEPTED: the authorized Target has freshly checked the exact contract/revision and explicitly acknowledged it.
If Target identity/Issue or acknowledgement is unknown, do not claim acceptance or completeness.
Changed contract/revision requires fresh acceptance under the owning contract.
Product/task acceptance does not release the original Writer, transfer a branch, mark Jira Done,
approve new implementation, or authorize merge/deployment.

## Mandatory service and function-first Korean F1 on every path

This is the final user-facing section for every explicit `$dev-main-flow` workflow. Use the existing `engineering-communication-ko` Skill and advisory checker; do not implement, replace, or bypass either. If either dependency cannot be read, mark it `BLOCKED/NOT_RUN`, still provide the F1 fields from verified facts, and do not claim an advisory PASS. Honor an explicit response-format request while preserving these facts. The F1 contract does not change read-only boundaries or grant F4, Jira, Git, Runtime, Merge, install, or deployment authority.

Lead in plain Korean that a colleague outside the conversation can understand without reading earlier chat. Start with the service and product function, then say what users can do now. Separate cumulative capability from this run's actual change. State `이번 실행에서 새로 구현한 제품 기능은 없습니다.` only when no product or Skill behavior was implemented or changed and the work was limited to research, documentation, Jira metadata, handoff, test preparation, or verification of unchanged behavior. If product or Skill behavior changed but is still an unmerged candidate or unavailable in a supported Runtime, name the actual change and report Source, merge, Native/apply, usability, and deployment states separately; do not label it zero merely because it is undeployed. Do not describe preparation, a closed Jira item, a changed document, or a test result as a new product function. If facts are missing, include the field and mark it `UNKNOWN`, `BLOCKED`, `NOT_VERIFIABLE`, or `NOT_RUN` with the reason.

For each service/function, report these facts in this order:

1. Service and product function, with the capability users can currently use.
2. What this run actually changed; state zero new product functions when applicable and distinguish prior capability from this-run delta.
3. Implementation, test/verification and CI, documentation, and deployment states separately, using the existing F1 contract's status rules and evidence.
4. Functions unavailable or unverified and the specific reason. Distinguish source prepared from source merged, Native-loaded/applied, usable in the supported Runtime, and deployed.
5. Next user goal, first action, responsible Lane, and required conditions/prerequisites. Keep the recommended next goal separate from executable approved READY work.

When no approved READY remains, recommend one next user goal, its benefit, and the exact Owner decisions or prerequisites needed to make it READY. Do not execute or silently add that goal to the current approved Objective. If a lane is blocked, report the unaffected next READY separately. Put Jira, PR, SHA, test counts, and links below the function result as evidence. Do not invent PASS states or fork the RPL-119 checker.

Before returning, check that a third-party reader can answer: what product function exists, what changed in this run, what is usable or unavailable and why, and what happens next. If any answer is missing, revise the F1 before sending it.

## Evidence levels and stop boundary

Record separately: Source exists; actual instruction loading; Skill discovery;
Native invocation/apply; actual Subagent execution; Objective Goal Closure; final service F1.
Manual Read/Apply, a descriptor prompt, or a successful Source fixture is not Native invocation evidence.
A local CLI probe or this session's Subagent is not a new Normal/AI Cloud session.
Requested model/reasoning/Fast is not effective attestation; unknown remains UNKNOWN.

This temporary Skill can be removed or replaced only after an approved default entry covers the same behavior, including the mandatory function-first Korean F1 for every explicit workflow. Removal or replacement requires its existing Source Owner; do not silently drop this output contract or create a second control plane. This source change does not prove that installed copies or supported Runtimes have been updated.
