---
name: git-work-preflight
description: Use only when work-start, jira-work, or manual-review explicitly requests a shared read-only Git preflight before planning a future mutation. Separate the canonical GitHub repository from the configured push remote, then inspect authoritative base, working tree, branch, PR, and ancestry state without mutating Git or GitHub.
metadata:
  source: born-here
  summary: Git Mutation 전 공통으로 소비하는 읽기 전용 Repository 안전 Gate
---

# Git Work Preflight

## Purpose and invocation boundary

`git-work-preflight` is a consumer-only shared contract for `work-start`,
`jira-work`, and `manual-review`. implicit invocation is prohibited: it is not
an implicit end-user workflow and does not run from a general Git question. A consumer must explicitly request
the preflight; the preflight never invokes a consumer.

It is a read-only gate. It inspects one supplied repository and produces a
Preflight Report with evidence and a candidate next step. It never creates a
Branch, checks out, resets, restores, stashes, cleans, rebases, merges, pulls,
pushes, creates a PR, or changes a PR.

Use this clean-tree contract only as an Entry or Resume Readiness Gate before
implementation begins or resumes. After approved implementation has produced
intentional changes, use execution verification such as tests, builds, and
diff checks; do not rerun this Entry Gate as a mid-implementation verification
gate and reinterpret its expected dirty-tree result as a contract failure.

`work-start` continues to create a Candidate and stop at Human Review.
`jira-work` continues to require its Ticket Gate, canonical source agreement,
and Connector boundary before any future Git lifecycle. A successful preflight
is not approval to bypass either boundary.

## Best-effort telemetry

Attempt only the shared fail-open skill-start event. Do not send Repository
paths, Issue Keys, Branch names, or report content to telemetry.

```bash
if [ -x "$HOME/.local/bin/harness-event" ]; then
  "$HOME/.local/bin/harness-event" emit skill-start \
    --skill git-work-preflight \
    --runtime "${HARNESS_RUNTIME:-codex}" \
    || true
fi
```

Telemetry failure does not block the preflight. Git or GitHub evidence failure
is fail-closed: report `NOT_VERIFIABLE` or another blocking result.

## Input contract

Require exactly one local Repository, Canonical Repository, Push Remote,
Expected Base Branch, Execution Policy, and Consumer. The supported Consumers
are `work-start`, `jira-work`, and `manual-review`.

| Input | Requirement |
|---|---|
| Repository | Required. One local repository path only. Missing input is `Repository Required`. Its configured Fetch Repository must resolve by GitHub stable repository identity to the Canonical Repository or a direct verified fork. |
| Canonical Repository | Required GitHub `owner/repo`. Owns repository identity, authoritative Base, canonical PR target, PR collision, and merged-PR state. |
| Push Remote | Required configured remote name. Its Fetch URL and Git-effective Push URL are separate evidence. The Push URL owns Feature Branch existence/alignment only. |
| Expected Base Branch | Required. Missing input is `Base Branch Required`. |
| Expected Base SHA | Optional. If supplied, both local and remote Base must match it. |
| Expected Branch Name Candidate | Optional. Validate only; never generate or create a Branch. |
| Issue Key | Required for `jira-work`; optional for other Consumers. Do not infer or invent one. |
| Execution Policy | Required: `suggest-only`, `patch-with-approval`, or `auto-apply`. |
| Consumer | Required: `work-start`, `jira-work`, or `manual-review`. |
| Provided Evidence | Optional evidence reference. Never claim it was verified unless the consumer supplied verified evidence. |

Multiple values, unsafe input, unreadable Repository, unresolved Canonical
Repository or Push Remote, missing Base, unavailable GitHub query, or missing
required Repository rule evidence are never treated as branch absence or READY.

## Read-only runtime

Run [scripts/git-work-preflight.sh](../../scripts/git-work-preflight.sh) only
from an explicit consumer boundary. It accepts named arguments, quotes every
input, does not use `eval`, and rejects unsafe Base or Branch arguments before
using them as refs.

The Runtime may use only these read-only operations after confirming the
Repository and ref input are usable:

- `git check-ref-format --branch`, `git rev-parse`, `git status`, `git branch --list`, `git branch -vv`, `git remote get-url`, `git remote get-url --push`
- `git ls-remote`, `git rev-list`, `git merge-base`, `git log`
- `gh repo view`, `gh pr list`, `gh pr view`

The Runtime reports executed Evidence separately from supplied Evidence. An
unexecuted query is `NOT_CHECKED`, not a successful absence result. It parses
`gh pr list` with Node.js JSON parsing, so PR state never depends on JSON key
order; malformed, unavailable, or multiple records fail closed as appropriate.

For a Feature Branch, Local Base SHA is the merge base between current HEAD and
the authoritative canonical Base SHA. This detects a stale integration point
without treating a cached Push Remote Base as canonical truth.

The Runtime resolves Canonical Repository identity with `gh repo view`, queries
the authoritative Base with `git ls-remote` against that canonical repository,
and always queries PR state with `gh pr list --repo <canonical owner/repo>`.
It never assumes a remote named `origin` is canonical truth.

The configured remote is resolved into exactly one Fetch URL and exactly one
Git-effective Push URL. `git remote get-url --push` is authoritative for the
push destination; a remote name or Fetch URL is not a substitute. Multiple Push
URLs are `NOT_VERIFIABLE`. GitHub stable repository ID proves a redirect alias
as `SAME_CANONICAL_REPOSITORY`; a direct fork is accepted only when GitHub
metadata proves its parent is the Canonical Repository. Unavailable metadata or
unrelated repositories fail closed.

The Fetch remote-tracking cache is reported as evidence but never outranks the
authoritative canonical Base or the actual Push URL. Feature Branch existence
and alignment are queried from the actual Push URL. When Fetch and Push resolve
to different verified repositories, Fetch remote-tracking refs are not treated
as Push destination refs. The report keeps Expected Base SHA, Cached
Fetch-remote Base SHA, Authoritative Base SHA, Feature Integration Point,
Cached Fetch-remote Feature SHA, Actual Push-remote Feature SHA, and Actual
Feature Push Target separate.

When both local and Push Remote Issue Branches exist, the Runtime verifies their
actual tips first, classifies local-ahead, remote-ahead, or divergence, and
performs a merge conclusion only for an aligned tip. A clean local-only Issue
Branch is `READY_NEW_WORK` only when its local tip and current HEAD equal the
authoritative Base, its unique Feature Commit count is exactly zero, the Push
Remote Feature is verified absent, the canonical PR is verified absent, and
the jira-work consumer supplied the exact Issue-to-Branch association. A
local-only Branch with unique commits or unclear ancestry remains
`RECOVERY_REQUIRED` or `NOT_VERIFIABLE`.

Expected Base and Feature Branch names are accepted only after
`git check-ref-format --branch` succeeds. A malformed ref is never converted
into evidence that a remote branch is absent.

## Result model

| Result | Required conclusion |
|---|---|
| READY_NEW_WORK | Repository, Base, tree, Branch, Remote, PR, and rule evidence permit a future new-work plan only. |
| READY_RESUME | Same Issue Branch or Draft PR is aligned and permits a future resume plan only. |
| RECOVERY_REQUIRED | Local-only, Remote-only, untracked relationship, or incomplete Branch/PR state requires a recovery plan only. |
| BLOCKED_DIRTY_TREE | Tracked, staged, or unmerged Working Tree state is a hard stop. |
| BLOCKED_BASE_MISMATCH | Expected Base SHA, local Base, or remote Base differs. |
| BLOCKED_DIVERGENCE | Local and Remote Issue Branches diverge. |
| ALREADY_MERGED | Merged PR or ancestor evidence forbids a new implementation plan. |
| CONFLICTED | Repository mismatch, naming conflict, duplicate PR, non-Draft PR, closed PR, or other Issue collision needs judgment. |
| NOT_VERIFIABLE | Git, Remote, GitHub, Base rule, or supplied evidence cannot be verified. |

All blocking results prohibit a mutation plan. `READY_NEW_WORK` and
`READY_RESUME` are planning results, never a Branch-creation, checkout, or
Push authorization.

Only `READY_NEW_WORK` and `READY_RESUME` may return process exit code `0`.
Every other result is non-zero; the Runtime owns this mapping centrally.

## Existing Work A–H

Use the shared model without changing `jira-work` semantics.

| Existing Work | Preflight Result | Allowed Next Step |
|---|---|---|
| A. New Branch and PR absent | READY_NEW_WORK | PLAN_NEW_WORK_ONLY |
| B. Normal Local and Remote Issue Branch | READY_RESUME | PLAN_RESUME_ONLY |
| C. Local-only Branch with unique work or unclear ancestry | RECOVERY_REQUIRED | RECOVERY_PLAN_ONLY |
| D. Remote-only Branch | RECOVERY_REQUIRED | RECOVERY_PLAN_ONLY |
| E. Open Draft PR | READY_RESUME | PLAN_RESUME_ONLY; duplicate PR forbidden |
| F. Local and Remote Divergence | BLOCKED_DIVERGENCE | STOP |
| G. Merge complete | ALREADY_MERGED | JIRA_RECONCILIATION_ONLY |
| H. Branch collision with another Issue Key or PR | CONFLICTED | STOP |

## Working Tree and naming policy

Report tracked modification, staged modification, unmerged conflict, untracked
file, ignored file, and local generated state separately. Tracked, staged, and
unmerged state are `BLOCKED_DIRTY_TREE`. Known local state such as `.DS_Store`
or `.oh-my-ai/` is reported, never deleted or silently called clean. Unknown
untracked state is `NOT_VERIFIABLE` until a Repository policy supplies a safe
interpretation.

Repository-enforced Base and naming rules outrank a Ticket candidate and any
general convention. This preflight does not create names. If a supplied
candidate conflicts with verified rules, report `CONFLICTED`; if the rules are
not verified, report `NOT_VERIFIABLE`.

For a `jira-work` invocation, the Issue Key is required and the Consumer must
supply an explicit Issue-to-Branch association evidence marker. The Runtime
never infers an Issue Key from a Branch or PR name: a missing Issue Key or
association evidence is `NOT_VERIFIABLE`, and an evidence marker for another
Branch is `CONFLICTED`.
This association gate runs before the Canonical PR terminal probe and before
any merge conclusion; an unverified association cannot be bypassed by ancestry
evidence. The Canonical PR terminal probe then requests exactly one
record with `state`, `headRefName`, `baseRefName`, and `headRefOid`; only an
exact merged head/base with every existing Local or Push Feature tip equal to
`headRefOid` may return `ALREADY_MERGED`. That terminal probe runs before the
historical Base/ancestry and Working Tree readiness gates. No Jira association
is required for `manual-review` or `work-start`.
No Jira read or write integration is performed here.

## Execution Policy and output

All policies report Mutation 0.

| Policy | Preflight output |
|---|---|
| suggest-only | Evidence, result, and a candidate plan only. |
| patch-with-approval | Candidate future mutation plan with separate approval required. |
| auto-apply | State that Local Git Lifecycle is unavailable; Mutation 0. |

Use [preflight-report.md](templates/preflight-report.md). The Runtime has no
Branch Creation, Checkout, Implementation, Verification Execution, Commit and
Push, Draft PR, Jira Comment and Transition, Merge, Release, Tag, Deploy,
Migration, or Secret-change capability.
