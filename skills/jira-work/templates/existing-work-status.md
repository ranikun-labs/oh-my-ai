# Existing Work Status — Preflight Consumption Model

> Consume only the current `git-work-preflight` result. This template never
> reconstructs Local Git, Remote, or PR state from prose and never checks out,
> pushes, creates, or repairs a Branch.

## A. New Branch and PR absent

New work is ready when no branch exists, or when the preflight verified the
approved clean base-tip local-only Issue Branch exception.

## B. Normal Local and Remote Issue Branch

Future existing-work resume planning is possible after the same Contract and
preflight gates pass.

## C. Local-only Branch

A local-only Branch with unique work or unclear ancestry requires recovery or
alignment planning. The exact base-tip/zero-commit exception belongs to A.
Automatic checkout and push are forbidden.

## D. Remote-only Branch

Recovery or alignment planning is required. Automatic checkout and push are
forbidden.

## E. Open Draft PR

Future existing-work resume planning is possible; duplicate PR creation is
forbidden.

## F. Local and Remote Divergence

Hard stop: report `CONFLICTED` and request user judgment. Do not auto-align.

## G. Merge complete

Implementation planning is forbidden. Only a future Jira-state alignment
candidate may be reported.

## H. Branch collision with another Issue Key or PR

Hard stop: report `CONFLICTED` and request user judgment.
