# Model Policy Contract

> **Status:** Draft, library + standalone CLI only. Not wired into a dispatch runtime, not an orchestrator, no server, DB, AI selector, GUI or cost engine. The actual policy values are private and never live in this public repository.

## Problem and boundary

Model, effort, and mode choices must be changeable by the Owner without editing public skills. Public source carries **no model names and no personal preferences**. The Owner keeps a private, approved policy file. This module validates it, decides ALLOW or DENY for one requested selection, picks a role default deterministically, and manages the active file through diff / apply / rollback.

- `scripts/lib/model-policy.mjs`: `validateModelPolicy`, `resolveModelSelection`, `selectDefault`, `loadExecutionPolicy`, `describeActivePolicy`, `readPolicyFile`, `diffPolicies`, `applyPolicy`, `rollbackPolicy`.
- `scripts/model-policy.mjs`: `status | validate | check | diff | apply | rollback` CLI.
- `scripts/lib/agent-manifest-guard.mjs`: optional gate in `preflightDispatch`, and `compareEffective`.
- Not in scope: evaluation data loading, runtime queries, automatic fallback, cost enforcement, dispatch, AI-based selection.

## Evaluation is not the active policy

Two things are kept apart on purpose:

| | Evaluation | Active policy |
| --- | --- | --- |
| What | Measurements of candidate models (quality, cost, speed on real work). | The approved permission file the resolver reads. |
| Where | Outside the policy file. The policy only carries an opaque `evaluation_ref`. | `model-policy.json` in the execution location. |
| Who reads it | Owner and humans comparing candidates. | `resolveModelSelection`, `selectDefault`, the guard. |
| Effect on a decision | None. `evaluation_ref` never changes a decision (FX-MP-010). | Full. Only `status: ACTIVE` can execute. |

A good evaluation result does not by itself allow anything. Only an approved, applied policy version does.

## Policy file location

Two lookups, chosen by purpose:

| Purpose | Path used |
| --- | --- |
| `validate`, `diff`, `check` (dry) | `OH_MY_AI_MODEL_POLICY` if set, else the default location. Dry only. |
| Execution (guard via `modelPolicyEnv` or `loadExecutionPolicy`), `status`, `apply`, `rollback` | The **default location** `${XDG_CONFIG_HOME}/oh-my-ai/model-policy.json` when `XDG_CONFIG_HOME` is an absolute path, else `~/.config/oh-my-ai/model-policy.json`. The override is honored **only** if that default file is a valid `status: ACTIVE` policy that sets `"allow_path_override": true` (the same opt-in idea as the git-identity approach; that reference is not in this repository, so the rule is implemented as written here). |

Consequence: pointing `OH_MY_AI_MODEL_POLICY` at a draft cannot unlock execution. Pointing it at an ACTIVE file also does nothing unless the default active file opts in (FX-MP-017, FX-MP-018).

**`via` label.** Every location-aware output (`status`, `check`, guard loader) reports where the file came from:

| `via` | Meaning |
| --- | --- |
| `default` | `$HOME/.config/oh-my-ai/model-policy.json` (or an XDG value equal to `$HOME/.config`). |
| `xdg` | `XDG_CONFIG_HOME` is absolute and moves the location away from `$HOME/.config`. |
| `override` | `OH_MY_AI_MODEL_POLICY` (dry paths only, or execution after the opt-in above). |

A **relative** `XDG_CONFIG_HOME` is ignored (it would resolve against the caller's cwd) and the default `$HOME/.config` is used (FX-MP-028).

**Trust assumption.** Whoever controls the process environment controls the policy location: setting `XDG_CONFIG_HOME` or `OH_MY_AI_MODEL_POLICY` (with the opt-in) can redirect execution. Env write access is therefore policy authority. The `via` label makes a redirect visible in output; it does not prevent one.

**Dry results are never execution approval.** `check` is always a dry resolve. When the dry path comes from `OH_MY_AI_MODEL_POLICY`, its output carries `"via": "override"` and `"dry_run": true`, and `policy_path` names the file read. An agent-written ACTIVE file at that path can produce `ALLOW` in `check`, but `status` and the guard still read only the execution location (FX-MP-026). Only the guard's execution path (`loadExecutionPolicy` / `modelPolicyEnv`) gates a dispatch.

The file may be a symlink, for example into `profiles/local/` (gitignored). Apply and rollback write through the resolved target so the symlink survives. Archived copies (`model-policy.<version>.json`) sit next to the resolved active file.

## Schema (schema_version 1)

Top-level keys are strict: unknown keys are `POLICY_INVALID`.

| Key | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | Must be `1`. |
| `policy_version` | yes | `[A-Za-z0-9._-]+`. Identifies this version. |
| `previous_version` | yes | `null`, or the `policy_version` of the archived copy used by rollback and apply. Must differ from `policy_version`. |
| `status` | yes | `ACTIVE`, or any value starting with `DRAFT`. Only `ACTIVE` can execute. |
| `approved_by` | ACTIVE: yes | Owner identity string. For `DRAFT*` it must be absent or null. |
| `approved_at` | ACTIVE: yes | ISO-8601 timestamp. For `DRAFT*` it must be absent or null. |
| `allow_path_override` | no | Boolean, default `false`. Lets `OH_MY_AI_MODEL_POLICY` be used for execution (see above). |
| `models` | yes | Array of model entries (below). Unlisted models are disabled. |
| `roles` | yes | Object: role name -> `{ "allowed": [tuple...], "default": [rule...] }`. Missing role = nothing allowed, no default. |
| `cost_limits` | no | Free-form object: task type -> `{ ..., requires_approval: bool }`. **Advisory, not enforced** (see below). |
| `substitutions` | no | Array of `{from, to}` tuple pairs. The only permitted fallbacks. |
| `evaluation_ref` | no | `null` or an opaque string pointing at evaluation data. Never loaded, never read by the resolver. |

The former top-level `default` key is removed. Role defaults now live in `roles[role].default`.

### Model entry

```json
{
  "provider": "example",
  "family": "example-family",
  "version": "2",
  "id": "example-large",
  "enabled": true,
  "efforts": { "low": true, "medium": true, "high": true, "xhigh": false, "max": false },
  "modes": { "standard": true, "fast": false }
}
```

- `provider`, `family`, `version`, `id` (exact model ID) are required non-empty strings. `provider` + `id` must be unique.
- `enabled`: boolean, required. Off means every selection for this model is denied.
- `efforts`: only `low | medium | high | xhigh | max`. **Default OFF**: an unlisted level is OFF, so `xhigh` is representable but off unless listed `true`.
- `modes`: only `standard | fast`. Independent switches: fast ON does not imply standard ON or the reverse.

### Role entry and defaults

```json
"roles": {
  "writer": {
    "allowed": [ { "provider": "example", "model": "example-small", "effort": "high", "mode": "standard" } ],
    "default": [
      { "runtime": "example-runtime", "risk": "low", "provider": "example", "model": "example-small", "effort": "high", "mode": "standard" },
      { "runtime": "*", "risk": "*", "provider": "example", "model": "example-small", "effort": "high", "mode": "standard" }
    ]
  }
}
```

- `allowed`: the only tuples the role may use. Resolver checks membership.
- `default`: rules keyed by `runtime` (any string, or `*`) and `risk` (`low | medium | high | *`). Each `runtime|risk` pair is unique per role.
- Validation rejects a default that is not in `allowed`, or that points at an option that is OFF. A default must be executable under the policy itself.

Selection (`selectDefault({ policy, role, runtime, risk })`, no AI call):

1. The key must be a concrete runtime and `risk` in `low|medium|high`. Otherwise `NO_DEFAULT`.
2. Matching rules are those where `runtime` equals the key or is `*`, and `risk` equals the key or is `*`.
3. Most specific wins: an exact runtime outranks an exact risk (exact runtime + wildcard risk beats wildcard runtime + exact risk). Ties cannot occur because each slot is unique.
4. No match -> `NO_DEFAULT`. **Blocked, never a fallback** to another rule or model.
5. The result is only a candidate tuple. It still must pass `resolveModelSelection`, which adds the runtime-support check.

### Tuple

`{ "provider": "...", "model": "...", "effort": "low|medium|high|xhigh|max", "mode": "standard|fast" }`. The provider/model must exist in `models`.

## Validation and runtime support

`validateModelPolicy(policy, { runtimeCapabilities? })`.

- Without `runtimeCapabilities`: structural validation only (used by resolve and by drafts).
- With `runtimeCapabilities` (the `validate` CLI takes `--runtime-capabilities FILE`): any model that is enabled (or has any effort/mode ON) must be declared by the runtime, and every ON effort/mode must be declared. Otherwise `POLICY_INVALID`. This is the **validate-time** rule: the Owner cannot enable an option the runtime does not declare.

Runtime capability input is provider-keyed. An optional per-model narrowing `by_model` overrides the provider-level lists for one model:

```json
{ "example": { "models": ["example-small", "example-large"], "efforts": ["low", "medium", "high", "max"], "modes": ["standard", "fast"],
               "by_model": { "example-small": { "efforts": ["low"], "modes": ["standard"] } } } }
```

## Decision codes

`resolveModelSelection({ policy, role, requested, runtimeCapabilities, substitute? })` returns `{status, code, reasons, ...}`. `status` is `ALLOW` or `DENY`. Checks run in this order and the first failure wins:

| Order | Code | Condition |
| --- | --- | --- |
| 1 | `POLICY_MISSING` | No policy object supplied. |
| 2 | `POLICY_INVALID` | Policy fails structural validation (reasons list every error). |
| 3 | `POLICY_NOT_APPROVED` | `status` is not `ACTIVE`. Drafts pass `validate`/`diff` but never execute. |
| 4 | `UNKNOWN_MODEL` | `provider/model` not listed. Unlisted = disabled. |
| 5 | `MODEL_DISABLED` | `enabled !== true`. |
| 6 | `EFFORT_DISABLED` | Requested effort is not `true` in `efforts`. |
| 7 | `MODE_DISABLED` | Requested mode is not `true` in `modes`. |
| 8 | `ROLE_NOT_ALLOWED` | The role's `allowed` list has no exact tuple match. |
| 9 | `RUNTIME_UNSUPPORTED` | Runtime capability missing, or it does not list the model/effort/mode (after `by_model` narrowing). **Fail-closed when `runtimeCapabilities` is absent.** No conversion to another effort or mode. |
| - | `SUBSTITUTION_NOT_APPROVED` | Only when `substitute` is passed and the exact (requested -> substitute) pair is not in `substitutions`. |

Policy permission (checks 1-8) and runtime capability (check 9) are separate inputs. Both must pass. Runtime capability describes what a provider or runtime can do. It is not a preference and it does not grant permission. A static registry declaration does not count as runtime proof, the same rule RPL-116 applies.

`selectDefault` returns `SELECTED` / `DEFAULT_SELECTED`, or `DENY` with `POLICY_MISSING`, `POLICY_INVALID`, `POLICY_NOT_APPROVED`, or `NO_DEFAULT`.

### No implicit fallback

Nothing is substituted automatically. A denied request stays denied. A substitute is evaluated only when the caller explicitly passes `substitute`, and then only if the exact pair is listed. The substitute is evaluated in full (every check above) and is never a shortcut around policy. A default cannot point at an OFF option, so disabling a model that a default uses makes the policy invalid until the default is moved in the same change.

### Evaluation reference

`evaluation_ref` has no effect on any decision. A test asserts that changing it leaves every decision identical.

### cost_limits: advisory, not enforced

`cost_limits` is documented metadata only. The resolver never reads it and never returns an approval from it (FX-MP-024). A **missing** cost limit is **not** unlimited approval. Any task that requires cost approval stays gated by the **existing Owner Gate**, outside this module. `describeActivePolicy` reports `advisory: ["cost_limits"]` so the status output says so.

## Owner change management (CLI)

| Command | Behavior |
| --- | --- |
| `status` | Shows the execution policy (path, via, status, approval fields, enabled models with family/version, roles). Output fields below. |
| `validate [FILE] [--runtime-capabilities F]` | Structural validation of FILE (or the dry path). Drafts are VALID. With F, enforces the runtime rule. |
| `check --role R --model M --effort E --mode X [--provider P] [--runtime-capabilities F]` | Dry resolve against the dry path. Drafts give `POLICY_NOT_APPROVED`. |
| `diff CANDIDATE` | Reads the dry-path active file and reports changes: `ON`/`OFF` for model enablement, effort and mode flags; `ADDED`/`REMOVED`/`CHANGED` for allowed tuples, role defaults, substitutions, cost_limits. Works for drafts. |
| `apply CANDIDATE` | Only a candidate with `status: ACTIVE` and approval fields. Its `previous_version` must equal the current active `policy_version` (or be `null` if none). **Requires an interactive TTY on stdin**: otherwise `DENY APPLY_REQUIRES_TTY` before anything is read or written. The operator then types the candidate's `policy_version` to confirm (anything else: `DENY APPLY_NOT_CONFIRMED`, nothing written). Steps after confirmation: copy the current active to `model-policy.<active version>.json` (refused if that archive differs), then replace the active file atomically with mode `0600`. Manual only. |
| `rollback` | Manual only. Swaps the active file with the archived copy named by `previous_version`; the copy must be ACTIVE. Refuses with no change if anything is missing or invalid. **Same TTY gate as `apply`**: non-TTY stdin gives `DENY ROLLBACK_REQUIRES_TTY` before anything is read or written. On a TTY the operator types the target (`previous_version`) to confirm; anything else gives `DENY ROLLBACK_NOT_CONFIRMED` and nothing is written. |

The resolver never reads evaluation data, and nothing calls `apply` or `rollback` automatically.

### `status` output

`describeActivePolicy()` returns the same object as `model-policy.mjs status` (JSON). Consumers read approval state from these fields and must not infer it:

| Field | Meaning |
| --- | --- |
| `status` | Validation / execution result, unchanged: `VALID`, `POLICY_NOT_APPROVED`, `POLICY_MISSING`, `POLICY_INVALID`. |
| `policy_status` | The file's own `status`: `ACTIVE`, or `DRAFT*`. Present when the file is readable and valid. |
| `approved_by` | Owner identity, **masked by default** as first character + `***` (e.g. `o***`). Full value only with `describeActivePolicy(env, { showApprover: true })` or `model-policy.mjs status --show-approver`. `null` when absent (always `null` for drafts). |
| `approved_at` | ISO-8601 approval timestamp from the file, or `null` when absent. |

- `ACTIVE` file: `status: VALID`, `policy_status: ACTIVE`, `approved_by` masked (unless `--show-approver`), `approved_at` filled, plus the policy summary (`policy_version`, `enabled_models`, `roles`, ...).
- `DRAFT*` file: `status: POLICY_NOT_APPROVED`, `policy_status: DRAFT*`, both approval fields `null`. No policy body (models, roles, `evaluation_ref`) is printed.
- Missing or invalid file: the fields above are not added. Output is unchanged from before.
- No secret values are exposed. The output never includes the file's cost_limits contents, substitutions, or evaluation data beyond the existing summary.

## Rollback

1. The active file must validate and declare `previous_version` (not `null`).
2. `model-policy.<previous_version>.json` must exist, validate, be `ACTIVE`, and carry the matching `policy_version`.
3. The active version is archived to `model-policy.<active policy_version>.json`. If that file already exists with different content, rollback is refused.
4. The previous copy replaces the active file via temp file + rename, mode `0600`.
5. Before step 3 writes anything, the caller must pass the TTY gate (`ROLLBACK_REQUIRES_TTY`) and the operator must type the target version (`ROLLBACK_NOT_CONFIRMED` otherwise).

Any failed precondition leaves the active file unchanged.

## 신모델 대응 절차 (new model onboarding)

Run these in order. Each step has an owner check; do not skip ahead.

1. **평가 추가**: record the new model in the evaluation material (outside the policy). Set `evaluation_ref` only as an opaque pointer when you draft. The resolver ignores it.
2. **비교**: compare the candidate against the current models on the same real tasks. Note quality, latency, and cost per task. Evaluation output is not a permission.
3. **스윗스팟**: pick the effort and mode (standard or fast) that gives the best result for the lowest cost on each role. Keep xhigh and max OFF unless they clearly win.
4. **업무 검증**: run the chosen selection on representative real work in a sandbox. Record the outcome as evaluation data.
5. **변경안**: write a candidate file with `status: DRAFT`, the new model entry (`family`, `version`, `id`, exact effort/mode ON/OFF), updated `roles[role].allowed` and `default`, and `previous_version` set to the current active `policy_version`.
6. **검증·diff**: `model-policy.mjs validate CANDIDATE --runtime-capabilities RUNTIME.json` must pass, and `model-policy.mjs diff CANDIDATE` must show only the intended ON/OFF and default changes.
7. **Owner 승인**: the Owner reviews the diff and sets `status: ACTIVE`, `approved_by`, `approved_at` on the candidate. No agent may set these fields. This is a convention enforced by review, not by code: see "Approval trust model" below.
8. **apply**: `model-policy.mjs apply CANDIDATE` in an interactive terminal. The operator types the new `policy_version` to confirm. The previous version is archived and the active file is replaced at mode `0600`.

### Approval trust model (what the checks do and do not prove)

- `approved_by` and `approved_at` are a **declaration**. The code checks that they are present and that `approved_at` parses. It does not verify who the approver is.
- **File write access to the execution location equals approval authority.** Anyone who can write the active file, or both the candidate and the active file, can make a policy ACTIVE by writing its fields directly, with no `apply` at all. `apply` does not add a security boundary over that.
- The **TTY check on `apply` is a mistake-guard, not a security boundary.** It stops a scripted or non-interactive run (for example a closed stdin with an arbitrary `approved_by`) from applying by accident. A process that can allocate a pseudo-terminal, or call `applyPolicy` directly with its own `isTTY`/`confirm` options, bypasses it. The library seam (`options.isTTY`, `options.confirm`) is for tests and programmatic callers; the environment cannot set it.
- `rollback` sits behind the same TTY gate as `apply` (`ROLLBACK_REQUIRES_TTY`, confirmation by typing the target version). It is the same class of write and carries the same authority assumption, so the same limits apply.
- Where a stronger boundary is needed, it must come from outside this code, for example filesystem ownership of the execution directory, or a signed approval. Neither is implemented here.
9. **Runtime 회귀**: run the guard path with a real runtime adapter for the new selection. The runtime must report the effective model, effort and mode. Compare them with `compareEffective`. A `MISMATCH` or `UNKNOWN` result (reported as `UNVERIFIED_CONFIG`) blocks the change from being treated as verified. Roll back with `model-policy.mjs rollback` if regression fails.

## Effective settings comparison

`compareEffective({ requested, effective })` in `agent-manifest-guard.mjs` compares `model`, `effort`, and `mode` (`standard|fast`):

- Per field: `MATCH` when both sides are known and equal, `MISMATCH` when both are known and differ, `UNKNOWN` when either side is missing or `"UNKNOWN"`.
- Overall: any `MISMATCH` -> `MISMATCH`; otherwise any `UNKNOWN` -> `UNKNOWN`; otherwise `MATCH`.
- **`UNKNOWN` is reported as `UNVERIFIED_CONFIG` (`label`) and is never presented as a match or as PASS.** The vocabulary follows the PR #220 contract. No code is imported from it.

## Guard integration (RPL-116)

`preflightDispatch(manifest, capability, { modelPolicy, modelPolicyEnv, requireModelPolicy, runtimeModelCapabilities })`:

- All three absent: unchanged behavior, no policy check.
- `modelPolicy` (object) supplied: the caller loaded it. The resolver still rejects drafts (`POLICY_NOT_APPROVED`) and invalid files.
- `modelPolicyEnv` (env object) supplied: the guard reads **only the execution location** through `loadExecutionPolicy` (see the path table). A missing or draft file blocks with `POLICY_MISSING` or `POLICY_NOT_APPROVED`.
- After all existing checks pass, the manifest is mapped to a tuple (`provider = requested.provider ?? runtime.id`, `effort = requested.reasoning`, `mode = requested.fast ? fast : standard`, `role = manifest.role`). Any DENY returns `BLOCKED` with that code.
- `requireModelPolicy: true` with no policy: `BLOCKED` with `POLICY_MISSING`. This is the require-policy flag. It defaults to off so CI does not break.

The guard keeps its generic reasoning allowlist (`low|medium|high|max`) as a capability constraint. The policy does not widen it.

## Verification

`make test-model-policy` runs `scripts/test-model-policy.mjs` (31 fixtures: draft rejection, env path cannot unlock execution, unsupported option -> `POLICY_INVALID` at validate and `RUNTIME_UNSUPPORTED` at resolve, xhigh default OFF, fast independent, default specificity and `NO_DEFAULT`, diff, apply, rollback, compareEffective, cost_limits advisory, check provenance (FX-MP-026), apply TTY gate (FX-MP-027), rollback TTY gate (FX-MP-030), XDG `via` labels (FX-MP-028), `substitutions`-less policy DENY (FX-MP-029)). The apply tests pass an explicit in-process confirm seam; no test relies on a real terminal. Every test passes explicit temp `HOME` and `XDG_CONFIG_HOME`; none reads the real $HOME or XDG config. `profiles/example/model-policy.json.example` is a `DRAFT` placeholder template that must validate and must not execute.
