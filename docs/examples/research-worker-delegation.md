# Claude project research worker adapter — candidate

Purpose: offer optional, purpose-based research delegation without changing Main's model or adding a router, hook, dispatcher or scheduler. The shared [delegation procedure](../../skills/research/references/delegation.md) is runtime-neutral; this example is Claude Code-specific. It uses native project custom agents under `.claude/agents/` at repository scope. See [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) and [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web). Definitions are defaults for this example adapter, not a personal policy or a guarantee of effective settings.

| Agent | Default model | Requested effort | Purpose |
| --- | --- | --- | --- |
| research-collector | haiku | medium | extraction/classification only |
| research-analyst | sonnet | medium | deep research and adoption |
| research-architect | sonnet | high | complex architecture, not independent review |

Sonnet High is the initial architecture default; an authorized private runtime configuration may select a higher-capability model such as Opus. Do not add model/effort to shared SKILL.md frontmatter, alter Main's model, or lower a sufficient model for an analysis task. Effective model and effort are separate observations. Confirm runtime model availability, agent loading, explicit call overrides and `CLAUDE_CODE_SUBAGENT_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` or managed settings before use. Do not assume a model's self-report is authoritative. If the required setting or authority cannot be verified, use the permitted fallback, not an undocumented override.

Agent definitions permit only Read, Grep, Glob, WebSearch and WebFetch; Bash, Agent, mutation tools and MCP are not in the allowlist. No nested dispatch or writes are authorized. An allowlist is a static configuration, not proof of runtime enforcement, read-scope sandboxing or immunity to prompt injection. Use only authorized paths and public sources; Main resolves private connectors and shares only permitted minimal context. If the runtime expands tools or cannot enforce the required boundary, do not delegate. No skill or adapter grants write authority or bypasses the existing guard. The existing formal manifest/dispatch and independent Reviewer workflows remain unchanged, including their blocked cases. This example is not an activation of those workflows.

## Acceptance probes (actual Native execution, not static CI)

Use an isolated checkout of the reviewed revision. Record environment/working directory, CLI version, available agent definitions, model allowlist/overrides (no secret values), actual tool surfaces, actual model from runtime usage or agent metadata, effort if observable, resume identity and result. Reuse prior user-reported isolated experiments only as historical evidence. Test the actual committed definitions:

1. Bounded collection selects collector even if Main is Sonnet/Opus; worker returns source facts, not adoption advice.
2. Explicit deep Research and Tech Hive adoption choose analyst (or architect when justified) even if Main is Haiku; Main's model stays unchanged. Compare result depth and confirm no collector-only synthesis for an analytical decision.
3. Complex architecture chooses architect and provides actual evidence of the selected model/effort where available. A simple direct question spawns no worker.
4. Same-subject compatible follow-up resumes the same worker; changed subject or upgraded role uses a fresh authorized task or scoped handoff. Main passes prior findings and corrections. Tech Hive's three-turn flow preserves the external subject, includes the adoption analysis, and ends in a read-only publication proposal.
5. Negative tool/authority probes in an isolated harmless fixture: explicitly request prohibited write, shell and nested agent actions; verify no action occurred and blocked tool surfaces. Do not test against real remote records. Test missing agent/model/tool access and forced model override; record exact limitation instead of PASS. Ensure no private data in public queries.
6. Verify unsupported runtime fallback is a supported in-session research workflow with delegation NOT_RUN; no mandatory new runtime adapter or automatic model change. Do not treat code presence, static tests, or a same-session critique as independent review.

Repeat the high-risk selection and continuation cases enough to expose nondeterministic choices; record actual runs, failures and costs. No claim of cross-project/cloud loading or runtime enforcement before actual evidence. Existing install/profile/doctor behavior is unchanged; distribution to other projects and private preferences remain separate approval and verification scope.
