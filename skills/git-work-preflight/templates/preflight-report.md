# Git Work Preflight Report

> Read-only shared Preflight. This report never creates a Branch, checks out,
> resets, restores, stashes, cleans, rebases, merges, pulls, pushes, creates a
> PR, or changes a PR. Mutation 0.

## Input

- Consumer:
- Repository:
- Canonical Repository:
- Push Remote:
- Expected Base Branch:
- Expected Base SHA:
- Expected Branch Candidate:
- Issue Key: required for `jira-work`; optional otherwise; never inferred.
- Execution Policy:
- Provided Evidence:

## Evidence

- Executed Evidence:
- Provided Evidence:
- Supplied Evidence:
- Unexecuted Checks: record as `NOT_CHECKED`, never as passed.

## Repository and Base

- Repository Verification:
- Canonical Repository Verification:
- Push Remote Verification:
- Configured Fetch URL: credential and query redacted; destination preserved.
- Configured Push URL: credential and query redacted; destination preserved.
- Fetch Repository Relation: `SAME_CANONICAL_REPOSITORY`,
  `VERIFIED_FORK_OF_CANONICAL`, `UNRELATED_REPOSITORY`, or `NOT_VERIFIABLE`.
- Push Repository Relation: same relation vocabulary as Fetch Repository.
- Actual Feature Push Target: configured Push URL plus the exact Feature ref.
- Canonical Base Verification:
- Push Remote Feature Verification:
- Current Branch:
- Current HEAD:
- Expected Base SHA:
- Cached Fetch-remote Base SHA:
- Authoritative Base SHA:
- Cached Fetch-remote Feature SHA:
- Actual Push-remote Feature SHA:
- Feature Integration Point:
- Local Base SHA:
- Ancestry Status:

## Working Tree Status

- Working Tree Status:
- Tracked Status:
- Staged Status:
- Unmerged Status:
- Untracked Local State:
- Ignored Local State:
- Mutation Safety:

## Branch and PR Status

- Expected Branch Candidate:
- Local Branch Status:
- Remote Branch Status:
- PR Status:
- Issue Association Status:
- Candidate Tip Evidence:
- Unique Feature Commits:
- Existing Work A-H:

## Preflight Result

- Preflight Result:
- READY_NEW_WORK
- READY_RESUME
- RECOVERY_REQUIRED
- BLOCKED_DIRTY_TREE
- BLOCKED_BASE_MISMATCH
- BLOCKED_DIVERGENCE
- ALREADY_MERGED
- CONFLICTED
- NOT_VERIFIABLE

## Blocking Items

- Blocking:
- Blocking Items: enumerate every required-input failure, unreadable Repository,
  Remote or GitHub failure, Base mismatch, dirty state, naming-rule gap,
  divergence, or collision. Do not downgrade an unavailable check to branch
  absence.

## Allowed Next Step

- Allowed Next Step:
- PLAN_NEW_WORK_ONLY, PLAN_RESUME_ONLY, RECOVERY_PLAN_ONLY,
  PLAN_WITH_SEPARATE_APPROVAL, PLAN_ONLY_RUNTIME_UNAVAILABLE,
  JIRA_RECONCILIATION_ONLY, or STOP.

## Process Exit Code

- Mutation: always `0`.
- Process Exit Code: `0` is allowed only for `READY_NEW_WORK` and `READY_RESUME`.
- Every recovery, blocked, merged, conflicted, or unverifiable result is
  non-zero.

## Prohibited Actions

- Prohibited Actions:
- Branch Creation
- Checkout
- Reset
- Restore
- Stash
- Clean
- Commit and Push
- Draft PR
- PR Edit
- Merge
- Release
- Tag
- Deploy
- Migration
- Secret change

## Unavailable Capabilities

- Unavailable Capabilities:
- Branch Creation
- Checkout
- Implementation
- Verification Execution
- Commit and Push
- Draft PR
- Jira Comment and Transition
- Merge
- Release
- Tag
- Deploy
- Migration
- Secret change
