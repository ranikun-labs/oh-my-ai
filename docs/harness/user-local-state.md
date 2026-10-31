# User-local State

Mutable Harness state belongs outside Product repositories. The default root is
`$XDG_STATE_HOME/oh-my-ai` or `~/.local/state/oh-my-ai`; set
`OH_MY_AI_STATE_ROOT` to override that complete application root.
New directories use mode `0700` and files use `0600`. Existing default app
directories owned by the current user are tightened to `0700` to recover from
older Harness-created roots. An explicit `OH_MY_AI_STATE_ROOT` must already be
private; unsafe roots fail without changing the selected directory's mode.

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

## Consumer contract

RPL-94/93 can use the physical location, read, atomic publish, and physical lock
exports above, plus `getWorkStartExecutionStatus` and
`rememberWorkStartExecution` for best-effort Work-start suppression. The stored
execution marker is hash-correlated; this API does not create a canonical
Task-to-Session association, Resume record, or Task lifecycle. Suggestion
deduplication is only the atomic `claimWorkStartSuggestion` operation for one
prompt hash.

RPL-120 can compose Attempt-specific files from the same atomic publish and
physical lock primitives. The lock serializes operations that use the same
location; it is not a compare-and-swap API or a transaction across multiple
files. This package does not define RPL-120 Attempt/Outcome semantics.

Consumers should handle failures as follows:

- A missing file reads as `null`. An unavailable repository identity or
  invalid state root/path is an explicit error; do not invent a shared fallback
  namespace.
- `state_publish_durability_unknown` means rename may already be visible but
  directory durability was not confirmed. Read and reconcile before retrying.
- A lock timeout, unknown owner, foreign-host lock, or ambiguous recovery fails
  closed: the callback is not run until the physical lock is safely acquired.
- Corrupt primary/legacy data and `state_legacy_conflict` preserve both copies;
  surface or quarantine the error without overwriting either copy.
- Work-start status lookup failures return `recent: false` with a sanitized
  `errorCode`, so routing proceeds without suppression. Missing runtime/session
  correlation is an expected no-op. Persistence failure does not reverse a
  successful engine operation.
- Suggestion claim failures return `claimed: false`, `persisted: false`, and a
  sanitized `errorCode`; a caller may leave the suggestion available. Candidate
  persistence errors likewise do not block routing, and candidate files store
  prompt hashes rather than prompt text.

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
