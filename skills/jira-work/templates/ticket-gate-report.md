# Jira Work Execution Readiness Report

## Lean ready result

```text
JIRA_WORK_READY

Issue: <ISSUE-KEY>
Source: <CONNECTOR_VERIFIED|MAIN_HANDOFF>
Jira Live State: <VERIFIED|NOT_PERFORMED>
Repository: EXACT
Base SHA: EXACT
Working Tree: CLEAN
Existing Branch: <NONE|ALIGNED>
Open PR Collision: NONE

Next:
PROCEED_TO_IMPLEMENTATION
```

Use this short form only after `git-work-preflight` was actually executed with
`Process Exit Code: 0` and returned `READY_NEW_WORK` or `READY_RESUME`.

## Detailed blocked result

Start with `JIRA_WORK_BLOCKED`, then report only the claims needed to explain
the mismatch and the single safe next step.

### Source and freshness

- Source Mode: CONNECTOR_VERIFIED or MAIN_HANDOFF
- Jira Ticket Connector Read: CURRENT_SESSION or NOT_PERFORMED
- Jira Live State: VERIFIED, NOT_PERFORMED, or NOT_VERIFIABLE
- Jira Freshness Requirement: OPTIONAL or REQUIRED
- Main Approval Marker: APPROVED_BY_MAIN or the observed mismatch

### Contract Validation

- Summary
- Context
- Goal
- Source of Truth
- In Scope
- Out of Scope
- Acceptance Criteria
- Repository
- Base Branch
- Expected Base SHA
- Expected Branch Name
- Dependencies
- Verification
- Do Not Touch
- Definition of Done
- Contract Schema/Version
- Risk Tier
- Blocking sentinels: Decision Required, Repository Required, Base Branch Required, Not Verifiable

## Source of Truth Validation

1. Accepted Decision
2. Canonical Repository Product and Architecture Documents
3. Confluence Specification
4. Jira Ticket
5. Handoff Candidate
6. Current Conversation

### Repository Evidence

- Git Preflight: ACTUALLY_EXECUTED or NOT_EXECUTED
- Process Exit Code
- Preflight Result
- Repository exactness
- Base Branch/SHA exactness
- Working Tree
- Local and Push Remote Branch
- Open PR Collision
- Divergence / other Issue collision / already merged

### Gate Result

- JIRA_WORK_BLOCKED
- Claim-level status, when relevant: READY, BLOCKED, NOT_VERIFIABLE, ALREADY_IN_PROGRESS, ALREADY_MERGED, or CONFLICTED
- Blocking Items: exact mismatched or unavailable claims
- Next: STOP, CORRECT_MAIN_HANDOFF, PROVIDE_CONNECTOR, or RESOLVE_REPOSITORY_STATE

## Unavailable gate capabilities

- Branch Creation
- Implementation
- Verification Execution
- Commit and Push
- Draft PR
- Jira Comment and Transition
