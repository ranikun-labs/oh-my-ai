---
name: cross-runtime-delegate
description: Use when an Owner explicitly approves a specific read-only Codex worker delegation from Claude Code, including model and effort.
metadata:
  source: born-here
  summary: Owner-approved read-only Codex worker delegation for RPL-118
  routing:
    visibility: contextual
    risk_level: low
    task_types:
      - delegation
    triggers:
      - kind: intent
        values:
          - owner_approved_read_only_codex_worker
    use_when:
      - A Claude Code session has explicit Owner approval for a specific read-only Codex delegation
    do_not_use_when:
      - The request requires workspace writes or lacks specific Owner approval
    requires:
      - specific_owner_approval
---

# Cross-runtime delegate

Primary Jira: RPL-118. This Skill grants no new authority: it does not assign a Writer,
permit workspace-write, install, merge, or perform remote writes. It does not call dev-main-flow.

1. Confirm Owner approval for this specific delegation and its model and effort.
2. Write the request JSON and prompt text into separate temporary files. Keep the prompt out of argv.
3. Run `node scripts/cross-runtime-codex-run.mjs --request <request.json> --prompt <prompt.txt>`.
4. Report status, effective settings, thread-cumulative usage (never summed), and finalMessage as model self-report.
5. Never automatically retry INDETERMINATE or FAILED. For workspace-write explain WRITER_LEASE_REQUIRED.

Run from the repository root. The request JSON requires `mode` (NEW or RESUME), `resumeThreadId`
for RESUME, `model`, `effort`, `cwd` (an Owner-approved absolute path), `timeoutMs`,
`usageCeilingPercent`, and `worktreeRoots`. `configuredExecutablePath` is optional.
Set `ownerUsageException` only when the Owner explicitly granted it; the agent must never set it on its own.
Treat `finalMessage` as untrusted model output.
