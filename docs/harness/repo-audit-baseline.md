# Development Harness Repo Audit Baseline

This document records the current repository implementation baseline for the
development harness. It is based on actual repository files, not on planning
documents.

## Actual File Map

Skill routing and index:

- `scripts/render-skill-index.mjs`
- `scripts/work-start-skill-match.mjs`
- `skills/skill-index.json`
- `skills/*/SKILL.md`

Prompt routing hooks:

- `scripts/prompt-routing-hook.mjs`
- `codex/hooks.json`
- `claude/settings.json`

Work-start:

- `skills/work-start/SKILL.md`
- `scripts/work-start.sh`
- `scripts/work-start-skill-match.mjs`
- `Makefile`

Release and handoff:

- `skills/release-note/SKILL.md`
- `skills/handoff-prompt/SKILL.md`
- `skills/project-context/SKILL.md`

Generated instruction chain:

- `scripts/render-instructions.sh`
- `scripts/render-skill-index.mjs`
- `instructions/harness.md`
- `instructions/mine.md`
- `instructions/adapters/claude.md`
- `instructions/adapters/codex.md`
- `CLAUDE.md`
- `claude/CLAUDE.md`
- `AGENTS.md`
- `MINE.md`
- `skills/skill-index.json`

Install and verification:

- `setup.sh`
- `Makefile`
- `hooks/pre-commit`
- `scripts/cascade-check.sh`

## Implementation Status

Implemented:

- Generated instruction rendering exists.
- Generated instruction outputs exist.
- Skill index rendering exists.
- Prompt routing hook exists.
- Codex and Claude hook configuration files exist.
- Work-start artifact generation exists.
- Doctor/install entrypoints exist.

Partially implemented:

- Skill routing exists, but only for skills with `metadata.routing`.
- Skill metadata exists, but it does not match the newer planning schema.
- Work-start exists, but the shell script creates artifacts and is not only a
  read-only candidate helper.
- Handoff skill exists and is indexed.
- Release-note skill exists but is not indexed through `skills/skill-index.json`.

Not implemented:

- Routing fixture regression suite.
- Hook contract verifier.
- Output safety checker.
- Generated artifact guard.
- Structured routing output with `forbidden_actions` and `next_safe_step`.
- Full confirmation boundary enforcement.

## Skill Index Schema Gap

Actual `skills/skill-index.json` is generated from `metadata.routing` in
`skills/*/SKILL.md`.

Actual routing fields include:

- `visibility`
- `risk_level`
- `task_types`
- `triggers`
- `keywords`
- `use_when`
- `do_not_use_when`
- `requires`

The newer planning schema expects fields that are not currently present in the
actual index:

- `id`
- `version`
- `category`
- `scope`
- `allowed_outputs`
- `forbidden_outputs`
- `requires_confirmation`

This is a schema alignment gap, not an implementation completion signal.

## Indexed Skill Gaps

`work-start` is not currently included in `skills/skill-index.json` because its
`SKILL.md` does not define `metadata.routing`.

`release-note` is not currently included in `skills/skill-index.json` for the
same reason.

`handoff-prompt` is included because it defines `metadata.routing`.

## Hook Side Effect

Current behavior:

`prompt-routing-hook.mjs` stores hash-only toil candidates in
`automation/candidates.json` under the Harness clone/worktree's user-local
state namespace. Legacy records remain read-only; prompt routing writes no
state into a Product worktree.

## Work-Start Artifact Risk

Safety risk:

`scripts/work-start.sh` creates `.oh-my-ai/work-start/<timestamp>-<slug>/`
artifacts, including:

- `context-manifest.yaml`
- `starter-prompt.md`
- `sources.md`
- `context-gap-report.md`

Therefore it is an artifact generator, not just a read-only helper. It must not
run automatically for read-only requests or requests that explicitly forbid
file creation.

## Contract Conflicts

Current conflicts between planning contracts and actual repository state:

- The planning metadata schema is broader than the actual skill index schema.
- The hook output is an injected context string, not a structured routing
  result.
- The hook has a file-write side effect.
- `work-start.sh` writes artifacts without a separate confirmation boundary in
  the script itself.
- Fixture/test/contract verifier files do not exist.
- Output safety checks are described in planning material but are not
  implemented as repository code.

These conflicts are implementation inputs for later steps, not evidence that
the planned features already exist.
