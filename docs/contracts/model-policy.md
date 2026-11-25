# Model Policy Contract

> **Status:** Draft, library + standalone CLI only. Not wired into a dispatch runtime, not an orchestrator, no server or DB. The actual policy values are private and never live in this public repository.

## Problem and boundary

Model, effort, and mode choices must be changeable by the Owner without editing public skills. Public source carries **no model names and no personal preferences**. The Owner keeps a private policy file; this module validates it and answers ALLOW or DENY for one requested selection.

- `scripts/lib/model-policy.mjs`: `validateModelPolicy`, `resolveModelSelection`, `describeActivePolicy`, `readPolicyFile`, `rollbackPolicy`.
- `scripts/model-policy.mjs`: `status | validate | check | rollback` CLI.
- `scripts/lib/agent-manifest-guard.mjs`: optional gate in `preflightDispatch` (see RPL-116 contract).
- Not in scope: evaluation data loading, runtime queries, automatic fallback, cost enforcement, dispatch.

## Policy file location

1. `OH_MY_AI_MODEL_POLICY` (absolute or relative path), if set and non-empty.
2. Otherwise `${XDG_CONFIG_HOME:-~/.config}/oh-my-ai/model-policy.json`.

The file may be a symlink, for example into `profiles/local/` (gitignored). Rollback writes through the resolved target so the symlink survives. Archived copies (`model-policy.<version>.json`) are stored in the same directory as the resolved active file. The Owner creates the archive copy before publishing a new version. Nothing creates it automatically.

## Schema (schema_version 1)

Top-level keys are strict: unknown keys are `POLICY_INVALID`.

| Key | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | Must be `1`. |
| `policy_version` | yes | `[A-Za-z0-9._-]+`. Identifies this version. |
| `previous_version` | yes | `null`, or the `policy_version` of the archived copy used by rollback. Must differ from `policy_version`. |
| `models` | yes | Array of model entries (below). Unlisted models are disabled. |
| `roles` | yes | Object: role name -> array of allowed `{provider, model, effort, mode}` tuples. Missing role = nothing allowed. |
| `default` | no | One `{provider, model, effort, mode}` tuple, informational only. The resolver never uses it. |
| `cost_limits` | no | Free-form object: task type -> `{ ..., requires_approval: bool }`. Advisory. The resolver does not enforce it. |
| `substitutions` | no | Array of `{from, to, reason?}` tuple pairs. The only permitted fallbacks. |
| `evaluation_ref` | no | `null` or an opaque string pointing at evaluation data. Never loaded, never read by the resolver. |

### Model entry

```json
{
  "provider": "example",
  "id": "example-small",
  "enabled": true,
  "efforts": { "low": true, "medium": true, "high": false },
  "modes": { "standard": true, "fast": false }
}
```

- `provider` and `id` (exact model ID) identify the entry. Duplicates are invalid.
- `enabled`: boolean, required. Off means every selection for this model is denied.
- `efforts`: only the levels `low | medium | high | xhigh | max`. Unlisted or `false` = off. Unknown level keys are invalid.
- `modes`: only `standard | fast`. Unlisted or `false` = off.

### Tuple

`{ "provider": "...", "model": "...", "effort": "low|medium|high|xhigh|max", "mode": "standard|fast" }`. The provider/model must exist in `models`.

## Decision codes

`resolveModelSelection({ policy, role, requested, runtimeCapabilities, substitute? })` returns `{status, code, reasons, ...}`. `status` is `ALLOW` or `DENY`. Checks run in this order and the first failure wins:

| Order | Code | Condition |
| --- | --- | --- |
| 1 | `POLICY_MISSING` | No policy object supplied. |
| 2 | `POLICY_INVALID` | Policy fails validation (reasons list every error). |
| 3 | `UNKNOWN_MODEL` | `provider/model` not listed. Unlisted = disabled. |
| 4 | `MODEL_DISABLED` | `enabled !== true`. |
| 5 | `EFFORT_DISABLED` | Requested effort is not `true` in `efforts`. |
| 6 | `MODE_DISABLED` | Requested mode is not `true` in `modes`. |
| 7 | `ROLE_NOT_ALLOWED` | The role's list has no exact tuple match. |
| 8 | `RUNTIME_UNSUPPORTED` | Runtime capability missing, or it does not list the model/effort/mode. **Fail-closed when `runtimeCapabilities` is absent.** |
| - | `SUBSTITUTION_NOT_APPROVED` | Only when `substitute` is passed and the exact (requested -> substitute) pair is not in `substitutions`. |

Policy permission (checks 1-7) and runtime capability (check 8) are separate inputs. Both must pass. Runtime capability describes what a provider or runtime can do. It is not a preference and it does not grant permission. A static registry declaration does not count as runtime proof, the same rule RPL-116 applies.

### No implicit fallback

Nothing is substituted automatically. A denied request stays denied. A substitute is evaluated only when the caller explicitly passes `substitute`, and then only if the exact pair is listed. The substitute is evaluated in full (every check above) and is never a shortcut around policy.

### Evaluation reference

`evaluation_ref` has no effect on any decision. A test asserts that changing it leaves every decision identical.

## Runtime capability input

`runtimeCapabilities` is supplied by a trusted adapter and is keyed by provider:

```json
{ "example": { "models": ["example-small"], "efforts": ["low", "medium"], "modes": ["standard"] } }
```

This module never builds it. Absent or partial input denies (`RUNTIME_UNSUPPORTED`).

## Rollback

`scripts/model-policy.mjs rollback` (manual only, never automatic):

1. The active file must validate and declare `previous_version` (not `null`).
2. `model-policy.<previous_version>.json` must exist, validate, and carry the matching `policy_version`.
3. The active version is archived to `model-policy.<active policy_version>.json`. If that file already exists with different content, rollback is refused.
4. The previous copy replaces the active file via temp file + rename, mode `0600`.

Any failed precondition leaves the active file unchanged.

## Guard integration (RPL-116)

`preflightDispatch(manifest, capability, { modelPolicy, requireModelPolicy, runtimeModelCapabilities })`:

- Both options absent: unchanged behavior, no policy check.
- `modelPolicy` supplied: after all existing checks pass, the manifest is mapped to a tuple (`provider = requested.provider ?? runtime.id`, `effort = requested.reasoning`, `mode = requested.fast ? fast : standard`, `role = manifest.role`). Any DENY returns `BLOCKED` with that code.
- `requireModelPolicy: true` with no `modelPolicy`: `BLOCKED` with `POLICY_MISSING`. This is the require-policy flag. It defaults to off so CI does not break.

The guard keeps its generic reasoning allowlist (`low|medium|high|max`) as a capability constraint. The policy does not widen it.

## Verification

`make test-model-policy` runs `scripts/test-model-policy.mjs` against temp directories only. It never reads the real `$HOME` or XDG config. `profiles/example/model-policy.json.example` is a placeholder template that must validate.
