# Dev Main Flow Client Readiness Profile

This is a source-evidence snapshot of Codex Local and Codex Cloud readiness. It does not establish client compatibility or registration, configure a client, or prove that a client can discover or invoke the Skill. Use the existing `find-skills` workflow and the pinned official references below for future discovery or export work; do not add a registry or installer here.

## Verified Source

- Canonical repository: `ranikun-labs/oh-my-ai`, default branch `master`, verified at commit [`bc307f07939ab5f676e30cbbeae983f07eeb8a10`](https://github.com/ranikun-labs/oh-my-ai/commit/bc307f07939ab5f676e30cbbeae983f07eeb8a10), tree `a9077a0f8f0a13f5d1fd0a00a61ab0da105f4eba`.
- `skills/dev-main-flow/SKILL.md` is present at blob `a76e92fb8757d08b4d256e945f5d6076041e8e41`; its frontmatter retains `disable-model-invocation: true`.
- `skills/dev-main-flow/agents/openai.yaml` is present at blob `de84c46575a1f85d1a34339b55291babab9d637a`; its policy retains `allow_implicit_invocation: false`.
- `.agents/skills/dev-main-flow` is a tracked repository symlink to `../../skills/dev-main-flow` (blob `58c5312d31d6f085f533c59ac5bc2ad6d3f5be19`). A repo-local discovery link is source evidence only; it does not establish a user-machine installation or call.

## Client Readiness Matrix

| Surface | Verified evidence | State | Claim limit and next validation |
|---|---|---|---|
| Codex Local repository source | The master snapshot contains the Skill, the `agents/openai.yaml` policy, and the repo-local `.agents/skills` symlink. | `SOURCE_PRESENT`; explicit-only policy declared | This does not prove the user's checkout, installed profile, client catalog, or invocation. On the target machine, inspect its actual source/discovery path and compare the loaded revision before testing an explicit call and read-only controls. |
| Codex Local user-machine installation and call | No user-machine profile or live Codex UI was inspected. | `NOT_RUN/UNKNOWN` | Do not claim installed, discovered, or invoked. Verify only in the actual target environment under its existing install and approval gates. |
| Codex Cloud discovery and invocation | In this run, `/workspace` is not a Git repository and has no `.agents/skills` directory. No Cloud catalog, Source root, or loaded version was observed. | `UNKNOWN/NOT_VERIFIED` | The `/workspace` observation applies only to this environment and does not prove Cloud is unsupported. Identify the actual Cloud runtime and inspect its supported catalog/source reader and loaded revision before making a client claim. |
| OpenAI Skill frontmatter compatibility | At the pinned OpenAI Creator revision, the official validator allows top-level `name`, `description`, `license`, `allowed-tools`, and `metadata`; `disable-model-invocation` is outside that set. | `COMPATIBILITY_WARNING` | This is a format warning, not proof that a picker or client failed because of this key. Preserve the canonical Claude-facing flag. Do not run the downloaded validator or claim its PASS without separately approved, pinned local validation. |
| Full F4/F1 package readiness | The verified master tree does not contain a canonical `skills/adaptive-goal-closure` Skill. The F1 advisory checker resolves through an external installed `oh-my-ai` root rather than this repository. | `NOT_SELF_CONTAINED`; affected stages `BLOCKED/NOT_RUN` until dependencies are resolved | Do not bundle unmerged dependency PRs or describe a source copy as a complete F4/F1 package. Read-only planning may continue; never claim F4 execution or an F1 checker PASS from this profile. |

## Client Boundaries

- Keep Claude's existing `disable-model-invocation: true` in the canonical Skill Source.
- Keep the OpenAI/Codex descriptor's `policy.allow_implicit_invocation: false` unchanged.
- Do not infer that one client's metadata controls another client's loader or invocation policy. The Skill frontmatter, repo-local link, and descriptor express Source intent; they are not evidence of installation, registration, client enforcement, or a successful call.
- Do not infer Codex Local or Codex Cloud UI behavior from another client's Skill-selection flow. The target UI and invocation affordances remain unverified.

## Pinned Official References

The compatibility notes above use these pinned official references:

- [OpenAI Creator validator at pinned commit `49f948faa9258a0c61caceaf225e179651397431`](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.system/skill-creator/scripts/quick_validate.py), file blob `0547b4041a5f58fa19892079a114a1df98286406`. Read-only inspection only; not executed.
- [OpenAI Creator guidance at the same pinned commit](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.system/skill-creator/SKILL.md), file blob `72bc0b97e7a6476254a9d5c424c9971748402ec3`. It says `name` and `description` determine when a Skill is used and advises against extra frontmatter fields.
- [Agent Skills format specification at pinned commit `83021e2be457a9b6679148719c1f6074f0ad975e`](https://github.com/agentskills/agentskills/blob/83021e2be457a9b6679148719c1f6074f0ad975e/docs/specification.mdx), file blob `d9a2db099d905da8b879a5c6f996728073985279`. The standard frontmatter does not list `disable-model-invocation`; its `metadata` map is for string values.

## Next Validation

1. Resolve the exact Codex Local and Cloud surfaces and their supported Source/catalog readers; compare each loaded Source revision with the canonical commit above.
2. Validate the applicable profile with its pinned, source-reviewed client tooling only after the target environment and approval are known. Do not download, execute, or install tooling from this profile.
3. In each confirmed client, verify discovery separately from an explicit `$dev-main-flow` call and read-only status/quoted controls. Keep the two invocation policies independent.
4. Resolve the canonical F4 and F1 checker dependencies in that same client before claiming full workflow readiness. Until then, report the dependency limits and use only the safe read-only subset.

No client installation, UI upload, marketplace publication, Native invocation, or remote Source change was performed for this profile.
