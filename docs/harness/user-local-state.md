# User-local State

Mutable Harness state belongs outside Product repositories. The default root is
`$XDG_STATE_HOME/oh-my-ai` or `~/.local/state/oh-my-ai`; set
`OH_MY_AI_STATE_ROOT` to override that complete application root.
New directories use mode `0700` and files use `0600`. Existing app directories
owned by the current user are tightened to `0700`; foreign-owned, linked, or
otherwise unsafe roots fail with a permission/path error.

The namespace is keyed by a hash of the Git common directory and a separate
hash of the Git directory. Clones and linked worktrees therefore get separate
state, while switching branches in one worktree keeps its namespace. Branch
names and remote URLs are not persistent identity inputs.

## Physical API

`scripts/lib/user-local-state.mjs` exports the physical storage primitives:

- `resolveUserLocalStateRoot(options)` returns the checked absolute state root.
- `resolveUserLocalStateLocation(cwd, relativePath, options)` returns an opaque,
  validated location. Callers must pass this location to the other functions.
- `readUserLocalState(location)` returns UTF-8 text or `null` when the file is
  missing. Corrupt permissions, unsafe paths, and I/O errors throw
  `UserLocalStateError` with a stable `code`.
- `publishUserLocalStateAtomically(location, contents)` writes a private
  temporary file, syncs it, atomically renames it, and syncs its directory.
  Read-modify-write callers must hold the matching physical lock.
- `withPhysicalStateLock(location, callback, options)` runs a synchronous
  callback under an exclusive filesystem lock. It waits up to `timeoutMs`
  (default 5000 ms). A dead same-host PID can be recovered; a foreign host,
  malformed owner, or ambiguous recovery fails closed.

The publication call can throw `state_publish_durability_unknown` after the
rename succeeded but the directory sync failed. The new contents may already
be visible, so callers must read and reconcile before retrying a write.

## Work-start API

`scripts/lib/work-start-execution-state.mjs` provides consumer-level operations:

- `getWorkStartExecutionStatus(cwd, runtime, sessionId, prompt)` returns
  `{ recent, errorCode }`. Storage or compatibility failures return
  `recent: false` and a sanitized code; prompt routing continues fail-open.
- `rememberWorkStartExecution(cwd, runtime, sessionId, task)` returns
  `{ persisted, errorCode }`. Missing runtime/session correlation is an
  expected no-op. Engine success remains successful when persistence fails.
- `claimWorkStartSuggestion(cwd, runtime, promptHash)` returns
  `{ claimed, persisted, errorCode }`. The physical lock makes the
  once-per-prompt claim atomic across processes.
- `appendAutomationCandidate(harnessRepositoryRoot, prompt)` returns
  `{ persisted, errorCode }`. Candidate history is scoped to the Harness clone
  and worktree, matching the legacy Harness-owned log. New records store a
  prompt SHA-256, never prompt text. Execution markers and suggestion claims
  are scoped to the caller's target Product repository and worktree.
- `appendHookFailure(harnessRepositoryRoot, runtime, eventName, errorCode)`
  stores bounded, sanitized Hook failure codes in the same clone/worktree
  namespace. It omits stderr, free-form reasons, and repository paths.

New writes use version 1 files under `work-start/` and `automation/` in the
user-local namespace. Legacy files under `.oh-my-ai/state/` are read-only. A
valid legacy snapshot is carried into the next external write with a snapshot
hash; the legacy file is left intact. If the old and new copies later diverge,
the operation returns `state_legacy_conflict` and does not overwrite either
copy. Corrupt primary or legacy data is preserved and returned as an explicit
error. Work-start task text, session IDs, and prompt bodies are not persisted;
execution correlation and toil candidates use SHA-256 digests.
Historical `hook-failures.log` files from the former XDG or repository-local
locations are left untouched; new Hook failures use the versioned diagnostics
state and do not persist stderr or free-form reasons.

## Failure codes

`UserLocalStateError.code` is stable for programmatic handling. Common physical
codes include `state_root_invalid`, `state_root_unavailable`,
`repository_identity_unavailable`, `state_path_unsafe`,
`state_permissions_unsafe`, `state_read_failed`, `state_write_failed`,
`state_publish_failed`, `state_publish_durability_unknown`,
`state_lock_callback_invalid`, `state_lock_acquire_failed`, `state_lock_timeout`,
`state_lock_owner_unknown`, `state_lock_recovery_unknown`,
`state_lock_recovery_failed`, and `state_lock_release_failed`.

Compatibility failures include `state_primary_corrupt`, `state_legacy_corrupt`,
`state_legacy_unsafe`, `state_legacy_read_failed`, and
`state_legacy_conflict`. Callers should preserve primary/legacy bytes on these
errors and choose fail-open or fail-closed behavior for their own operation.
