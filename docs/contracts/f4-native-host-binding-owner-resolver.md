# F4 Native Host Binding and Owner Resolver Contract Candidate

Status: integration candidate. The approved MVP rule is automatic Resume only when the trusted Host confirms the same Repository, Worktree, and State Root tuple. Cross-worktree Resume and unapproved Scope Revision changes remain blocked.

## Host binding

The F4 composition receives a current RPL-95 physical binding with contract `rpl95-worktree-state-v2`, a state-root identity, a repository-instance identity, and a physical-worktree identity. The state-root identity includes the canonical root path and directory generation. This value detects a replaced directory at the same path; it does not authenticate the Host by itself.

The trusted Host verifier must compare that observed tuple with a Host-owned binding record that is independent of the RPL-95 State Root, Attempt records, and Scope Checkpoint. That record must survive a Worker restart. The Host must also verify that the current task context is authorized for the same repository and worktree. Caller-supplied candidate fields are claims to compare, never the source of expected identity.

The current F4 port is `verifyWorktreeStateBinding(input)`. Its input contains `repository_cwd`, `candidate_id`, `repository_identity`, `worktree_identity`, and `physical_state`. The verifier returns literal `true` only when all values match a fresh, trusted Host observation and its independent record. Missing, stale, unavailable, malformed, or mismatched evidence returns false or throws; F4 fails closed.

The order is: read the pending candidate metadata; resolve the current RPL-95 physical binding; verify the binding with the trusted Host; run the RPL-118 capability preflight and trusted Owner/Inventory check; then read or reserve the Attempt, acquire Claim, and invoke the existing Runtime adapter. A Host mismatch must prevent Attempt lookup, Claim, and Runtime dispatch. The checkpoint store uses the same verifier before reading or publishing its projection.

If a State Root changes after a restart, the Host's independent record must reject the new root before F4 treats the empty store as a new Attempt. If the Host has no independent record or cannot prove persistence across restart, Resume remains blocked. The Host record format, owner, freshness window, and revocation behavior belong to the Host owner; F4 must not invent them.

## Approved Workstream resolution

`resolveApprovedWorkstreamForManualResume` must read the canonical approved Objective and Inventory. It returns the Objective ID, Scope Revision, selected Workstream ID, fresh observed status, complete Coverage, Inventory Source URI, and Inventory Source Revision. It must preserve discovery failures and pagination gaps as incomplete coverage, and must not promote newly discovered out-of-scope work to READY.

F4 compares that fresh result with the durable Checkpoint projection before Claim. The Checkpoint is not an authority for approval. READY is only a preflight result; it is not Runtime acceptance. RPL-113 owns discovery, the canonical Owner owns Objective and Scope, and RPL-120 consumes those contracts.

## Ownership and implementation boundary

- RPL-95 owns State Root selection, Repository/Worktree identity, atomic publication, and physical locking. F4 consumes its exact exports and adds only the Attempt-specific CAS adapter.
- The trusted Host owns authenticated workspace identity and the independent binding record. F4 may verify a supplied contract; it must not implement a Runner, Cloud control plane, or replacement identity provider.
- RPL-118 owns Capability decisions. A READY result does not authorize dispatch.
- RPL-115 owns the real single-Task Actor execution evidence. Its status and actual Actor/Resume support must be checked before claiming Native E2E.
- Same-tuple Resume is in scope. Cross-worktree Resume and Scope Revision transitions require a separate Owner decision.

## Evidence boundary

F4 fixture tests can prove that a missing or mismatched verifier blocks Attempt/Claim and that a root-generation change is detectable. A test record written outside the RPL-95 root is still synthetic Host evidence. Only an actual Host provider plus RPL-115 Task/Actor logs can prove Host binding, Checkpoint, process restart, and Resume end to end.
