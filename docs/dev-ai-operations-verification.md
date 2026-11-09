# Verify developer operations improvements

This reference turns operating changes into observable checks. It consumes the existing contracts below; it does not create a new coordinator, task registry, approval policy or automatic execution service.

## Reuse the owning contracts

- [Dev Main Flow](../skills/dev-main-flow/SKILL.md): approved Objective, role boundaries, evidence reuse, next READY and closure.
- [Korean engineering communication](../skills/engineering-communication-ko/SKILL.md): function-first F1, approval explanation, requested versus effective settings, and usage evidence.
- [Client readiness profile](../skills/dev-main-flow/client-profile.md): Source, actual loading, discovery and invocation checks, including pinned official authoring references.
- [Project Context](../skills/project-context/SKILL.md): human-confirmed durable context. It is not a raw transcript store or a Worker instruction.
- [Work Record Sync](../skills/work-record-sync/SKILL.md): existing-record target, approval, concurrency and readback gates.
- [Shared quality principles](../instructions/harness.md) and the target project's existing verification Skill: failure modes, responsibility boundaries and evidence. Language-specific verification Skills are used only for the corresponding project; this reference does not impose their coverage thresholds on unrelated code.

## Collect comparable evidence

Use the approved Objective, original acceptance criteria, fixed Source revision and existing result/checkpoint references as the boundaries of a check. Name the actual client/runtime and whether the check is static, a synthetic fixture, manual application, or an observed runtime execution. Do not collect raw transcripts or introduce global instrumentation for this comparison.

For each scenario, retain the observed action, relevant immutable evidence, unperformed checks, outcome and next action in the existing result/checkpoint. Mark missing evidence `UNKNOWN` or the unperformed execution `NOT_RUN`. A report, requested setting or installation file alone cannot prove an action happened.

Inspect duplicate work and context delivery separately. Zero Main code/log rereads can coexist with large inherited context and progress/report messages. When the Runtime supports scoped task inputs, supply the task contract and fixed evidence references instead of the full conversation; keep the original approval available to independent review. Compare visible character or byte counts only over equally observed intervals, and never present such counts as billed tokens or derive costs from elapsed time.

## Behavior acceptance scenarios

| Area | Scenario | Observable acceptance and evidence |
|---|---|---|
| Separate core work and operating improvements | A new improvement is suggested during an approved implementation. | A defect that blocks current safety, execution or acceptance is escalated with its impact. Other suggestions remain in the existing improvement queue; the approved core Scope is not silently expanded. Retain the scope decision and next READY. |
| Main and execution lead | A Writer encounters an in-scope technical failure or Reviewer finding. | The lead connects the same Writer's correction, affected verification and fixed-HEAD delta review without routine Main reapproval. Main receives the actual exception or concise final result. A repeated Source lookup identifies changed, stale or conflicting evidence. |
| Objective coverage and safe parallelism | One lane is blocked while an independent approved READY remains. | Only the affected action is isolated; the other READY proceeds within verified permissions and file boundaries. Unknown original custody is not a claim of Writer termination. If a new isolated candidate is explicitly authorized, follow the owning contract while preserving the original branch and uncommitted work. |
| F1 and approval explanation | A reader sees the final result without earlier chat. | The reader can identify the user function, actual change, usable/unverified state, next action and exact approval effect. Agent-verifiable facts are investigated first; a Merge decision is not bundled with a guarantee that no other Writer or external deployment exists. |
| Model and usage reporting | Roles have different visibility or incomplete official usage. | Requested and directly observed effective settings are separate. Official usage and any visible-text proxy identify the same bounded interval; overlapping totals are not added. Missing official costs remain unknown, and incomparable text estimates are not used for savings or model rankings. |
| Skill authoring and supply | A candidate passes local format checks but the target client has not been observed. | Record the pinned authoring tool/profile and format result, then independently check Source revision, loading, discovery, explicit invocation and dependencies. Preserve canonical client policies. Manual Read/Apply and static fixtures do not become Native or runtime success. |
| Code and verification quality | A change spans several responsibilities or a risky boundary. | The review identifies responsibility boundaries and independently testable failure paths. Targeted tests cover changed behavior; relevant integration checks cover shared boundaries. Reuse valid unchanged evidence and rerun affected checks after a change. Required final CI, independent review, acceptance and deployment gates remain separate. |
| Conversation to existing record | An approved change is prepared for an existing issue or page. | The exact target, authorized delta and fresh concurrency marker are checked before writing; the stored delta is read back afterward. An unavailable safe write capability blocks that record action, not independent READY work. A prepared proposal is not a successful write. |
| PR and ticket closure | Implementation is complete but the original DoD requires further closure. | Track implementation, fixed-HEAD verification/review, Merge, candidate acceptance and ticket completion separately. Continue only authorized actions. Preserve an original unmerged-candidate DoD, and retain any missing evidence, authority and next action rather than claiming the whole Objective complete. |

These are observation criteria for the existing workflow, not a simulation that marks the Agent compliant by evaluating expected answers. Synthetic cases must retain their synthetic label. A static contract or routing test establishes only the property it actually checks.

The [closure review cases](../fixtures/dev-main-flow/closure-contract-fixtures.json) provide concrete inputs and expected boundaries for manual review or a supported runtime trial. They are review inputs, not executable policy or evidence that those actions occurred.

## Check quality in proportion to risk

Review responsibility before size: a long method may expose mixed concerns, but an arbitrary line limit or mechanically extracting helpers does not demonstrate better design. Identify what must change together, what should be tested independently, and how errors and partial completion cross those boundaries. Reuse existing project conventions and reviewers.

Select checks from changed behavior and impact: ordinary local behavior needs relevant targeted tests; shared APIs, authentication/authorization, data mutations, concurrency, installation and execution permissions need their existing applicable integration and safety checks. Verification during development provides feedback; the required final fixed-candidate CI and independent review still determine their own gates. A test count, coverage number or one service's successful check does not prove a cross-service acceptance criterion.

## Temporary use and eventual code enforcement

A Skill or reviewed manual procedure can make a change usable before runtime integration. Report that as manual/procedural use and preserve its limitations. Do not label a document update as enforced behavior.

For a recurring condition that can be checked mechanically, first locate its owning code boundary and existing inputs: exact Source identity, current authorization, permitted action, recorded result or concurrency marker. Reuse the existing validator or adapter and fail safely when required evidence is absent. Keep product judgment and explanation quality in the appropriate review rather than pretending a keyword match can establish them.

A hook is eligible only when the target runtime supports the event and exposes the required trustworthy context. A notification or SessionEnd event is neither Merge approval nor completion proof. If that connection is unavailable, record the integration gap and continue the approved manual subset; do not create a new background worker or install global configuration as a workaround.

An improvement is code-enforced only after the actual supported path exercises the check, rejects the relevant failure case, and preserves the approved success case. Source presence, a static contract test and a manually inspected example cannot replace that evidence.
