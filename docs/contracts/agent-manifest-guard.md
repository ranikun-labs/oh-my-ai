# Agent Manifest & Dispatch Evidence Contract (RPL-116)

> **Status:** Draft PR candidate, **standalone guard only**. Not wired to a Codex/Claude agent-spawn API, not installed, not a proven Runtime E2E. Private model policy and credentials stay outside this public repository.

## Problem and boundary

A parent Writer's requested model, reasoning effort, or Fast mode must not silently carry into an independent Reviewer. Free-text prompt instructions are not reliable proof of effective runtime settings. New, temporary, and research agents require the same explicit manifest preflight. This public module supplies deterministic checks; **the caller/adapter must enforce them at every actual dispatch boundary**.

- `scripts/lib/agent-manifest-guard.mjs`: pure `validateAgentManifest`, `preflightDispatch`, `verifyDispatchEvidence`.
- `scripts/validate-agent-manifest.mjs`: JSON **shape-only** CLI. Exit 0 means a well-formed manifest, **not approved/supported/dispatched**.
- `scripts/test-agent-manifest-fixtures.mjs`: 30 synthetic `FX-AGM-*` cases. Positive callback stubs are **not real runtime attestations**.
- `make test-agent-manifest-fixtures`: run just these fixtures. Existing `FX-CAP-*` checks cover **static** runtime declarations and are intentionally separate.

## Manifest input (public generic role contract)

```json
{
  "agent_id": "writer-a",
  "role": "writer",
  "task": "Implement the approved bounded change",
  "permissions": "scoped-write",
  "requested": { "model": "example-model", "reasoning": "high", "fast": true },
  "runtime": { "id": "example-runtime" },
  "authorization": {
    "status": "approved",
    "scope": "approved bounded change",
    "evidence_ref": "owner-approved-scope-reference"
  },
  "target": {
    "repo": "example/example-repository",
    "branch": "feature/approved-scope",
    "primary_jira": "EXAMPLE-123"
  }
}
```

A Reviewer needs `read-only` permission, fixed 40-hex `target.base_sha` and `target.head_sha`, and a distinct `reviewing_agent_id` (Writer being reviewed). The reviewed Base/HEAD must be inside the runtime-verified attestation; caller-supplied `observation.reviewed` is not trusted. The requester must provide an actual valid model/reasoning/Fast setting; public source **must not** hard-code a particular person's preferred model. A text `authorization.evidence_ref` or `authorization.status=approved` is only a claim: the caller must check its authority against the real permission system before dispatch.

## Fail-closed outcomes

| Code | Meaning |
| --- | --- |
| `F4_PROMPT_INVALID` | Required Agent Manifest field, role, permission, or fixed HEAD is missing/invalid |
| `APPROVAL_BLOCKED` | Manifest lacks approved scope claim |
| `CAPABILITY_BLOCKED` | Verified runtime model/reasoning/Fast override and reviewer isolation support unavailable |
| `READY_TO_DISPATCH` | Eligible for an adapter to **attempt** dispatch, not an agent-creation or settings proof |
| `NOT_RUN`, `ROUTING_UNVERIFIED` | No actual dispatch or trusted attestation |
| `SETTING_MISMATCH` | Effective model/reasoning/Fast differs from requested; no silent fallback |
| `REVIEW_UNVERIFIED` | Reviewer independent context or fixed Base/HEAD cannot be established |
| `SETTINGS_VERIFIED` | Only possible with an **actually trusted adapter**; still `review_acceptance=NOT_EVALUATED` |

## Current evidence and remaining gate

Run `make test-agent-manifest-fixtures` and `node --check` for the 3 script files. These tests use synthetic adapter capability objects and an intentionally fake positive verifier; **30/30 fixtures do not prove real Codex/ChatGPT setting control**.

The repository's current V1 CLI/work-start flow does **not** itself spawn independent subagents. **Dispatch integration remains NOT_IMPLEMENTED** until a real controllable/verifiable Runtime Adapter entry point exists and the Guard is invoked before *every* agent creation path. Unknown effective model/reasoning/Fast or unsupported reviewer isolation => **do not auto-dispatch the Reviewer**; hand off fixed Base/HEAD to a separately controlled, verified Standard session. Actual Writer→Reviewer E2E and independent PR review are **NOT_RUN** for this Draft.

No automatic Jira status transition, Git Merge, global installation, private configuration publication, or production change is authorized by this document.
