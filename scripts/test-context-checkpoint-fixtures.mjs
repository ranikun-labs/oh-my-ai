#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  checkpointHandoffPreflight,
  checkpointStatus,
  notifyUnresolvedCheckpoint,
  recordCheckpointActivity,
  resolveCheckpoint,
} from "./lib/context-checkpoint-state.mjs";

const productRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const publicEntry = path.join(productRoot, "scripts", "oh-my-ai.mjs");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-ai-context-checkpoint."));
const cleanup = [];

try {
  const primary = makeRepository("primary");
  const isolated = makeRepository("isolated");
  const stateHome = path.join(sandbox, "state");
  const fixtureEnv = {
    ...process.env,
    HOME: path.join(sandbox, "home"),
    XDG_STATE_HOME: stateHome,
  };

  const noActivity = checkpointStatus({ cwd: primary, env: fixtureEnv });
  assert.equal(noActivity.availability, "available");
  assert.equal(noActivity.checkpoint_state, "clean");
  pass("FX-CCG-002 activity 없음은 clean");

  const unavailableStorageRepo = makeRepository("missing-state-unavailable-storage");
  const unavailableXdg = path.join(sandbox, "unavailable-xdg");
  fs.writeFileSync(unavailableXdg, "not a directory\n", "utf8");
  fs.writeFileSync(path.join(unavailableStorageRepo, ".oh-my-ai"), "not a directory\n", "utf8");
  const unavailableStorage = checkpointStatus({
    cwd: unavailableStorageRepo,
    env: {
      ...fixtureEnv,
      HOME: "",
      XDG_STATE_HOME: unavailableXdg,
    },
  });
  assert.equal(unavailableStorage.availability, "unavailable");
  assert.notEqual(unavailableStorage.checkpoint_state, "clean");
  assert.equal(unavailableStorage.manual_checkpoint_required, true);
  const unavailableStorageEnv = {
    ...fixtureEnv,
    HOME: "",
    XDG_STATE_HOME: unavailableXdg,
  };
  const unavailablePreflight = checkpointHandoffPreflight({
    cwd: unavailableStorageRepo,
    env: unavailableStorageEnv,
  });
  assert.equal(unavailablePreflight.availability, "unavailable");
  assert.notEqual(unavailablePreflight.checkpoint_state, "clean");
  assert.equal(unavailablePreflight.manual_checkpoint_required, true);
  for (const args of [
    ["context-checkpoint", "status", "--json"],
    ["context-checkpoint", "handoff-preflight", "--json"],
    ["context-checkpoint", "resolve", "no-update", "--json"],
  ]) {
    const command = runEntry(unavailableStorageRepo, unavailableStorageEnv, args);
    assert.equal(command.status, 1);
    const output = JSON.parse(command.stdout);
    assert.equal(output.availability, "unavailable");
    assert.notEqual(output.checkpoint_state, "clean");
    assert.equal(output.manual_checkpoint_required, true);
  }
  const unavailableSessionStart = runEntry(
    unavailableStorageRepo,
    unavailableStorageEnv,
    ["hook", "claude", "SessionStart"],
    {
      session_id: "unavailable-storage-session",
      cwd: unavailableStorageRepo,
      hook_event_name: "SessionStart",
      source: "startup",
    },
  );
  assert.equal(unavailableSessionStart.status, 0);
  const unavailableSessionStartOutput = JSON.parse(unavailableSessionStart.stdout);
  assert.match(unavailableSessionStartOutput.systemMessage, /availability: unavailable/);
  assert.match(
    unavailableSessionStartOutput.hookSpecificOutput.additionalContext,
    /Manual Context Checkpoint/,
  );
  pass("FX-CCG-002 missing State의 모든 저장소가 불가하면 clean으로 판정하지 않음");

  const fallbackRepo = makeRepository("missing-state-repo-fallback");
  const fallbackXdg = path.join(sandbox, "fallback-xdg-unavailable");
  fs.writeFileSync(fallbackXdg, "not a directory\n", "utf8");
  const fallbackEnv = {
    ...fixtureEnv,
    HOME: "",
    XDG_STATE_HOME: fallbackXdg,
  };
  const fallbackStatus = checkpointStatus({ cwd: fallbackRepo, env: fallbackEnv });
  assert.equal(fallbackStatus.availability, "available");
  assert.equal(fallbackStatus.checkpoint_state, "clean");
  assert.equal(
    allFiles(fallbackRepo).some(file => file.includes("capability-probe")),
    false,
  );
  const fallbackActivity = recordCheckpointActivity({
    cwd: fallbackRepo,
    runtime: "claude",
    sessionId: "fallback-session",
    eventId: "fallback-event",
    signalKind: "file_mutation",
    env: fallbackEnv,
  });
  assert.equal(fallbackActivity.availability, "available");
  assert.equal(fallbackActivity.checkpoint_state, "review_needed");
  assert.ok(
    allFiles(path.join(fallbackRepo, ".oh-my-ai", "state"))
      .some(file => file.endsWith("context-checkpoint-state.json")),
  );
  pass("FX-CCG-007 XDG가 불가하면 writable Repo fallback을 선택");

  for (const [faultName, fixtureName] of [
    ["probeWrite", "write"],
    ["probeRename", "rename"],
  ]) {
    const probeFailureRepo = makeRepository(`missing-state-probe-${fixtureName}-failure`);
    const probeFailure = checkpointStatus({
      cwd: probeFailureRepo,
      env: {
        ...fixtureEnv,
        XDG_STATE_HOME: path.join(sandbox, `probe-${fixtureName}-failure-state`),
      },
      faults: { [faultName]: true },
    });
    assert.equal(probeFailure.availability, "unavailable");
    assert.notEqual(probeFailure.checkpoint_state, "clean");
  }
  assert.equal(
    allFiles(sandbox).some(file => file.includes("capability-probe")),
    false,
  );
  pass("FX-CCG-007 capability probe write/rename 실패는 unavailable이며 Evidence를 정리");

  const firstActivity = recordCheckpointActivity({
    cwd: primary,
    runtime: "claude",
    sessionId: "session-one",
    eventId: "tool-use-one",
    signalKind: "file_mutation",
    env: fixtureEnv,
  });
  assert.equal(firstActivity.availability, "available");
  assert.equal(firstActivity.checkpoint_state, "review_needed");
  assert.deepEqual(firstActivity.activity_signal_kinds, ["file_mutation"]);
  pass("FX-CCG-001 Work-start 비의존 Activity는 review_needed");

  const firstEpoch = firstActivity.epoch_id;
  const duplicateActivity = recordCheckpointActivity({
    cwd: primary,
    runtime: "claude",
    sessionId: "session-one",
    eventId: "tool-use-one",
    signalKind: "file_mutation",
    env: fixtureEnv,
  });
  assert.equal(duplicateActivity.epoch_id, firstEpoch);
  assert.equal(duplicateActivity.activity_revision, 1);

  const checkpointed = resolveCheckpoint({
    cwd: primary,
    resolution: "checkpointed",
    promotionSourceRef: "context-checkpoint-20260728-a",
    env: fixtureEnv,
  });
  assert.equal(checkpointed.availability, "available");
  assert.equal(checkpointed.checkpoint_state, "clean");
  assert.equal(checkpointed.resolution, "checkpointed");
  assert.notEqual(checkpointed.epoch_id, firstEpoch);
  const repeatedCheckpoint = resolveCheckpoint({
    cwd: primary,
    resolution: "checkpointed",
    promotionSourceRef: "context-checkpoint-20260728-a",
    env: fixtureEnv,
  });
  assert.equal(repeatedCheckpoint.changed, false);
  assert.equal(repeatedCheckpoint.resolution, "checkpointed");
  pass("FX-CCG-003 Human-confirmed checkpoint는 멱등 해결");

  const beforeNoUpdate = recordCheckpointActivity({
    cwd: primary,
    runtime: "claude",
    sessionId: "session-two",
    eventId: "tool-use-two",
    signalKind: "validation_run",
    env: fixtureEnv,
  });
  const noUpdate = resolveCheckpoint({
    cwd: primary,
    resolution: "no_update",
    env: fixtureEnv,
  });
  assert.equal(noUpdate.checkpoint_state, "clean");
  assert.equal(noUpdate.resolution, "no_update");
  const repeatedNoUpdate = resolveCheckpoint({
    cwd: primary,
    resolution: "no_update",
    env: fixtureEnv,
  });
  assert.equal(repeatedNoUpdate.changed, false);
  pass("FX-CCG-004 Human-confirmed no_update는 멱등 해결");

  const afterResolution = recordCheckpointActivity({
    cwd: primary,
    runtime: "claude",
    sessionId: "session-three",
    eventId: "tool-use-three",
    signalKind: "file_mutation",
    env: fixtureEnv,
  });
  assert.equal(afterResolution.checkpoint_state, "review_needed");
  assert.equal(afterResolution.activity_revision, 1);
  assert.notEqual(afterResolution.epoch_id, beforeNoUpdate.epoch_id);
  assert.equal(afterResolution.epoch_id, noUpdate.epoch_id);
  const oneTime = notifyUnresolvedCheckpoint({
    cwd: primary,
    runtime: "claude",
    sessionId: "session-four",
    boundaryKind: "SessionStart",
    env: fixtureEnv,
  });
  assert.equal(oneTime.notify, true);
  const suppressed = notifyUnresolvedCheckpoint({
    cwd: primary,
    runtime: "claude",
    sessionId: "session-four",
    boundaryKind: "SessionStart",
    env: fixtureEnv,
  });
  assert.equal(suppressed.notify, false);
  pass("FX-CCG-005 새 Activity는 새 Epoch로 재진입하고 중복은 억제");

  assert.equal(checkpointStatus({ cwd: isolated, env: fixtureEnv }).checkpoint_state, "clean");
  pass("FX-CCG-010 다른 Repository 상태 격리");

  const linkedWorktree = makeLinkedWorktree(primary);
  assert.equal(checkpointStatus({ cwd: linkedWorktree, env: fixtureEnv }).checkpoint_state, "clean");
  pass("FX-CCG-011 같은 Repository의 다른 Worktree 상태 격리");

  const stateFile = findOnlyStateFile(stateHome);
  fs.writeFileSync(stateFile, "{ corrupt json\n", "utf8");
  const corrupt = checkpointStatus({ cwd: primary, env: fixtureEnv });
  assert.equal(corrupt.availability, "unavailable");
  assert.notEqual(corrupt.checkpoint_state, "clean");
  assert.equal(corrupt.manual_checkpoint_required, true);
  pass("FX-CCG-012 손상 State는 unavailable fail-open");

  const privacyRepo = makeRepository("privacy-secret-repository");
  runGit(privacyRepo, ["remote", "add", "origin", "https://token.example/credential.git"]);
  const privacyActivity = recordCheckpointActivity({
    cwd: privacyRepo,
    runtime: "claude",
    sessionId: "secret-session-value",
    eventId: "raw-tool-output-secret",
    signalKind: "file_mutation",
    env: fixtureEnv,
  });
  assert.equal(privacyActivity.availability, "available");
  const privacyState = fs.readFileSync(findStateFileForHash(stateHome, privacyActivity.repository_hash), "utf8");
  for (const forbidden of [
    privacyRepo,
    "https://token.example/credential.git",
    "secret-session-value",
    "raw-tool-output-secret",
  ]) {
    assert.equal(privacyState.includes(forbidden), false, `state leaked ${forbidden}`);
  }
  const rejectedPromotion = resolveCheckpoint({
    cwd: privacyRepo,
    resolution: "checkpointed",
    promotionSourceRef: "/absolute/private/context.md",
    env: fixtureEnv,
  });
  assert.equal(rejectedPromotion.availability, "unavailable");
  assert.notEqual(rejectedPromotion.resolution, "checkpointed");
  pass("FX-CCG-015 Raw Content와 민감 reference 미저장");

  const lifecycle = makeRepository("claude-lifecycle");
  const lifecycleEnv = {
    ...fixtureEnv,
    XDG_STATE_HOME: path.join(sandbox, "lifecycle-state"),
  };
  const activityPayload = {
    session_id: "claude-session-one",
    transcript_path: "/private/transcript/must-not-be-stored.jsonl",
    cwd: lifecycle,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: path.join(lifecycle, "src", "secret-file.txt"),
      content: "prompt and file content must not be stored",
    },
    tool_response: {
      filePath: path.join(lifecycle, "src", "secret-file.txt"),
      success: true,
    },
    tool_use_id: "tool-use-lifecycle",
  };
  assert.equal(runEntry(lifecycle, lifecycleEnv, ["hook", "claude", "PostToolUse"], activityPayload).status, 0);
  assert.equal(checkpointStatus({ cwd: lifecycle, env: lifecycleEnv }).checkpoint_state, "review_needed");
  const sessionEnd = runEntry(lifecycle, lifecycleEnv, ["hook", "claude", "SessionEnd"], {
    session_id: "claude-session-one",
    transcript_path: "/private/transcript/must-not-be-stored.jsonl",
    cwd: lifecycle,
    hook_event_name: "SessionEnd",
    reason: "other",
  });
  assert.equal(sessionEnd.status, 0);
  const sessionStart = runEntry(lifecycle, lifecycleEnv, ["hook", "claude", "SessionStart"], {
    session_id: "claude-session-two",
    transcript_path: "/private/transcript/must-not-be-stored.jsonl",
    cwd: lifecycle,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  assert.equal(sessionStart.status, 0);
  const diagnostic = JSON.parse(sessionStart.stdout);
  assert.match(diagnostic.systemMessage, /Project Context 검토가 완료되지 않았습니다/);
  assert.match(diagnostic.systemMessage, /Context Checkpoint 진행/);
  assert.match(diagnostic.systemMessage, /no_update/);
  assert.match(diagnostic.systemMessage, /나중에 검토/);
  const repeatedSessionStart = runEntry(lifecycle, lifecycleEnv, ["hook", "claude", "SessionStart"], {
    session_id: "claude-session-two",
    cwd: lifecycle,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  const repeatedDiagnostic = repeatedSessionStart.stdout.trim()
    ? JSON.parse(repeatedSessionStart.stdout).systemMessage || ""
    : "";
  assert.doesNotMatch(repeatedDiagnostic, /Project Context 검토가 완료되지 않았습니다/);
  pass("FX-CCG-006 Claude lifecycle은 다음 Session에 one-time diagnostic");

  const adapterNoActivity = makeRepository("adapter-no-activity");
  const adapterNoActivityEnv = {
    ...fixtureEnv,
    XDG_STATE_HOME: path.join(sandbox, "adapter-no-activity-state"),
  };
  runEntry(adapterNoActivity, adapterNoActivityEnv, ["hook", "claude", "PostToolUse"], {
    session_id: "read-only-session",
    cwd: adapterNoActivity,
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: path.join(adapterNoActivity, "README.md") },
    tool_response: { success: true, content: "must not be stored" },
    tool_use_id: "read-only-event",
  });
  runEntry(adapterNoActivity, adapterNoActivityEnv, ["hook", "claude", "PostToolUse"], {
    session_id: "read-only-session",
    cwd: adapterNoActivity,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "git status --short" },
    tool_response: { stdout: "", stderr: "" },
    tool_use_id: "generic-bash-event",
  });
  assert.equal(
    checkpointStatus({ cwd: adapterNoActivity, env: adapterNoActivityEnv }).checkpoint_state,
    "clean",
  );
  runEntry(adapterNoActivity, adapterNoActivityEnv, ["hook", "claude", "PostToolUse"], {
    session_id: "read-only-session",
    cwd: adapterNoActivity,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "make test-context-checkpoint-fixtures" },
    tool_response: { stdout: "private test output", stderr: "" },
    tool_use_id: "validation-event",
  });
  const validationActivity = checkpointStatus({ cwd: adapterNoActivity, env: adapterNoActivityEnv });
  assert.equal(validationActivity.checkpoint_state, "review_needed");
  assert.deepEqual(validationActivity.activity_signal_kinds, ["validation_run"]);

  const writeFailureRepo = makeRepository("write-failure");
  const writeFailure = recordCheckpointActivity({
    cwd: writeFailureRepo,
    runtime: "claude",
    sessionId: "session-write-failure",
    eventId: "event-write-failure",
    signalKind: "file_mutation",
    env: fixtureEnv,
    faults: { write: true },
  });
  assert.equal(writeFailure.availability, "unavailable");
  assert.notEqual(writeFailure.checkpoint_state, "clean");
  const renameFailureRepo = makeRepository("rename-failure");
  const renameFailure = recordCheckpointActivity({
    cwd: renameFailureRepo,
    runtime: "claude",
    sessionId: "session-rename-failure",
    eventId: "event-rename-failure",
    signalKind: "file_mutation",
    env: fixtureEnv,
    faults: { rename: true },
  });
  assert.equal(renameFailure.availability, "unavailable");
  assert.notEqual(renameFailure.checkpoint_state, "clean");
  const readFailure = checkpointStatus({
    cwd: renameFailureRepo,
    env: fixtureEnv,
    faults: { read: true },
  });
  assert.equal(readFailure.availability, "unavailable");
  assert.notEqual(readFailure.checkpoint_state, "clean");
  const schemaMismatchRepo = makeRepository("schema-mismatch");
  const schemaMismatchActivity = recordCheckpointActivity({
    cwd: schemaMismatchRepo,
    runtime: "claude",
    sessionId: "schema-session",
    eventId: "schema-event",
    signalKind: "file_mutation",
    env: fixtureEnv,
  });
  const schemaStateFile = findStateFileForHash(stateHome, schemaMismatchActivity.repository_hash);
  const schemaState = JSON.parse(fs.readFileSync(schemaStateFile, "utf8"));
  schemaState.schema_version = 999;
  fs.writeFileSync(schemaStateFile, `${JSON.stringify(schemaState)}\n`, "utf8");
  const schemaMismatch = checkpointStatus({ cwd: schemaMismatchRepo, env: fixtureEnv });
  assert.equal(schemaMismatch.availability, "unavailable");
  assert.equal(schemaMismatch.reason_code, "state_schema_mismatch");
  const missingSession = runEntry(lifecycle, lifecycleEnv, ["hook", "claude", "PostToolUse"], {
    cwd: lifecycle,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(lifecycle, "missing-session.txt"), content: "private" },
    tool_response: { success: true },
    tool_use_id: "missing-session-event",
  });
  assert.equal(missingSession.status, 0);
  assert.match(missingSession.stdout, /unavailable|Manual Context Checkpoint/);
  const malformedHook = runEntry(
    lifecycle,
    lifecycleEnv,
    ["hook", "claude", "PostToolUse"],
    "{ malformed",
  );
  assert.equal(malformedHook.status, 0);
  assert.match(malformedHook.stdout, /unavailable|Manual Context Checkpoint/);

  const serialRepo = makeRepository("serial-events");
  const serialEnv = {
    ...fixtureEnv,
    XDG_STATE_HOME: path.join(sandbox, "serial-state"),
  };
  const serialPayloads = Array.from({ length: 8 }, (_, index) => ({
    session_id: "serial-session",
    cwd: serialRepo,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(serialRepo, `${index}.txt`), content: "private" },
    tool_response: { success: true },
    tool_use_id: `serial-${index}`,
  }));
  const serialResults = [];
  for (const payload of serialPayloads) {
    serialResults.push(await runEntryAsync(
      serialRepo,
      serialEnv,
      ["hook", "claude", "PostToolUse"],
      payload,
    ));
  }
  const serialOutcomes = serialResults.map((result, index) => classifyChildOutcome(
    result,
    childLabel(index, serialPayloads[index]),
  ));
  assert.ok(serialOutcomes.every(outcome => outcome.kind === "available"));
  const serialStatus = checkpointStatus({ cwd: serialRepo, env: serialEnv });
  const serialStored = readStoredActivityForRepository(
    serialEnv.XDG_STATE_HOME,
    serialStatus.repository_hash,
  );
  assert.equal(serialStatus.activity_revision, 8);
  assert.equal(serialStored.activity_revision, 8);
  assert.equal(serialStored.seen_event_hashes.length, 8);
  assert.equal(new Set(serialStored.seen_event_hashes).size, 8);
  pass("FX-CCG-007 serial unique activities persist to revision 8");

  const lockExhaustionRepo = makeRepository("lock-exhaustion");
  const lockExhaustionEnv = {
    ...fixtureEnv,
    XDG_STATE_HOME: path.join(sandbox, "lock-exhaustion-state"),
  };
  const lockSeed = recordCheckpointActivity({
    cwd: lockExhaustionRepo,
    runtime: "claude",
    sessionId: "lock-session",
    eventId: "lock-seed",
    signalKind: "file_mutation",
    env: lockExhaustionEnv,
  });
  assert.equal(lockSeed.availability, "available");
  const lockStateFile = findStateFileForHash(
    lockExhaustionEnv.XDG_STATE_HOME,
    lockSeed.repository_hash,
  );
  const lockPath = `${lockStateFile}.lock`;
  const lockBefore = readStoredActivityState(lockStateFile);
  let lockCreated = false;
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    lockCreated = true;

    const directLockFailure = recordCheckpointActivity({
      cwd: lockExhaustionRepo,
      runtime: "claude",
      sessionId: "lock-session",
      eventId: "lock-direct-failure",
      signalKind: "file_mutation",
      env: lockExhaustionEnv,
    });
    assert.equal(directLockFailure.availability, "unavailable");
    assert.equal(directLockFailure.reason_code, "state_lock_failed");
    assert.equal(directLockFailure.changed, false);
    assert.equal(directLockFailure.manual_checkpoint_required, true);

    const publicLockPayload = {
      session_id: "lock-session",
      cwd: lockExhaustionRepo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: path.join(lockExhaustionRepo, "public-lock-failure.txt"),
        content: "private",
      },
      tool_response: { success: true },
      tool_use_id: "lock-public-failure",
    };
    const publicLockResult = await runEntryAsync(
      lockExhaustionRepo,
      lockExhaustionEnv,
      ["hook", "claude", "PostToolUse"],
      publicLockPayload,
    );
    const publicLockOutcome = classifyChildOutcome(
      publicLockResult,
      childLabel(0, publicLockPayload),
    );
    assert.equal(publicLockOutcome.kind, "unavailable");
    const lockAfter = readStoredActivityState(lockStateFile);
    assert.equal(lockAfter.activity_revision, lockBefore.activity_revision);
    assert.deepEqual(lockAfter.seen_event_hashes, lockBefore.seen_event_hashes);
    assert.equal(
      checkpointStatus({ cwd: lockExhaustionRepo, env: lockExhaustionEnv }).activity_revision,
      1,
    );
  } finally {
    if (lockCreated) fs.rmSync(lockPath, { recursive: true, force: true });
  }
  pass("FX-CCG-007 lock exhaustion remains fail-open and observable");

  const concurrentRepo = makeRepository("concurrent-events");
  const concurrentEnv = {
    ...fixtureEnv,
    XDG_STATE_HOME: path.join(sandbox, "concurrent-state"),
  };
  const concurrentPayloads = Array.from({ length: 8 }, (_, index) => ({
    session_id: "concurrent-session",
    cwd: concurrentRepo,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(concurrentRepo, `${index}.txt`), content: "private" },
    tool_response: { success: true },
    tool_use_id: `concurrent-${index}`,
  }));
  const concurrentRuns = concurrentPayloads.map(payload => runEntryAsync(
    concurrentRepo,
    concurrentEnv,
    ["hook", "claude", "PostToolUse"],
    payload,
  ));
  const concurrentResults = await Promise.all(concurrentRuns);
  const concurrentOutcomes = concurrentResults.map((result, index) => classifyChildOutcome(
    result,
    childLabel(index, concurrentPayloads[index]),
  ));
  const concurrentAvailableCount = concurrentOutcomes.filter(
    outcome => outcome.kind === "available",
  ).length;
  const concurrentUnavailableCount = concurrentOutcomes.filter(
    outcome => outcome.kind === "unavailable",
  ).length;
  assert.equal(concurrentAvailableCount + concurrentUnavailableCount, 8);
  assert.equal(
    concurrentOutcomes.filter(outcome => outcome.reason_code === "state_lock_failed").length,
    concurrentUnavailableCount,
  );
  const concurrentStatus = checkpointStatus({ cwd: concurrentRepo, env: concurrentEnv });
  const concurrentStored = readStoredActivityForRepository(
    concurrentEnv.XDG_STATE_HOME,
    concurrentStatus.repository_hash,
  );
  assert.equal(concurrentStatus.activity_revision, concurrentAvailableCount);
  assert.equal(concurrentStored.activity_revision, concurrentAvailableCount);
  assert.equal(concurrentStored.seen_event_hashes.length, concurrentAvailableCount);
  assert.equal(
    new Set(concurrentStored.seen_event_hashes).size,
    concurrentAvailableCount,
  );
  pass("FX-CCG-007 concurrent persistence outcome is reconciled with available writes");

  const existingStateRepo = makeRepository("existing-state-write-failure");
  const existingStateEnv = {
    ...fixtureEnv,
    XDG_STATE_HOME: path.join(sandbox, "existing-state-write-failure-state"),
  };
  const existingStateActivity = recordCheckpointActivity({
    cwd: existingStateRepo,
    runtime: "claude",
    sessionId: "existing-state-session",
    eventId: "existing-state-event-one",
    signalKind: "file_mutation",
    env: existingStateEnv,
  });
  assert.equal(existingStateActivity.availability, "available");
  const existingStateFile = findStateFileForHash(
    existingStateEnv.XDG_STATE_HOME,
    existingStateActivity.repository_hash,
  );
  const existingStateWriteFailure = recordCheckpointActivity({
    cwd: existingStateRepo,
    runtime: "claude",
    sessionId: "existing-state-session",
    eventId: "existing-state-event-two",
    signalKind: "validation_run",
    env: existingStateEnv,
    faults: { write: true },
  });
  assert.equal(existingStateWriteFailure.availability, "unavailable");
  assert.notEqual(existingStateWriteFailure.checkpoint_state, "clean");
  assert.equal(
    JSON.parse(fs.readFileSync(existingStateFile, "utf8"))
      .unresolved_epochs[0].activity_revision,
    1,
  );
  assert.equal(
    fs.existsSync(path.join(existingStateRepo, ".oh-my-ai", "state", "context-checkpoint-state.json")),
    false,
  );
  pass("FX-CCG-007 기존 State write 실패는 Repo fallback으로 split-brain을 만들지 않음");

  const sessionScopeRepo = makeRepository("session-scope");
  const sessionScopeEnv = {
    ...fixtureEnv,
    XDG_STATE_HOME: path.join(sandbox, "session-scope-state"),
  };
  const sessionA = recordCheckpointActivity({
    cwd: sessionScopeRepo,
    runtime: "claude",
    sessionId: "scope-session-a",
    eventId: "scope-event-a",
    signalKind: "file_mutation",
    env: sessionScopeEnv,
  });
  const sessionB = recordCheckpointActivity({
    cwd: sessionScopeRepo,
    runtime: "claude",
    sessionId: "scope-session-b",
    eventId: "scope-event-b",
    signalKind: "validation_run",
    env: sessionScopeEnv,
  });
  assert.notEqual(sessionA.epoch_id, sessionB.epoch_id);
  assert.notEqual(sessionA.session_hash, sessionB.session_hash);
  assert.equal(sessionB.unresolved_count, 2);
  assert.deepEqual(
    sessionB.unresolved_epochs.map(epoch => epoch.activity_revision),
    [1, 1],
  );
  assert.deepEqual(
    sessionB.unresolved_epochs.map(epoch => epoch.activity_signal_kinds),
    [["file_mutation"], ["validation_run"]],
  );
  const multiSessionStatus = checkpointStatus({
    cwd: sessionScopeRepo,
    env: sessionScopeEnv,
  });
  assert.equal(multiSessionStatus.epoch_id, null);
  assert.equal(multiSessionStatus.session_hash, null);

  const sessionCNotification = notifyUnresolvedCheckpoint({
    cwd: sessionScopeRepo,
    runtime: "claude",
    sessionId: "scope-session-c",
    boundaryKind: "SessionStart",
    env: sessionScopeEnv,
  });
  assert.equal(sessionCNotification.notify, true);
  assert.equal(sessionCNotification.prior_unresolved_count, 2);
  const sessionCSuppressed = notifyUnresolvedCheckpoint({
    cwd: sessionScopeRepo,
    runtime: "claude",
    sessionId: "scope-session-c",
    boundaryKind: "SessionStart",
    env: sessionScopeEnv,
  });
  assert.equal(sessionCSuppressed.notify, false);
  const sessionANotification = notifyUnresolvedCheckpoint({
    cwd: sessionScopeRepo,
    runtime: "claude",
    sessionId: "scope-session-a",
    boundaryKind: "SessionStart",
    env: sessionScopeEnv,
  });
  assert.equal(sessionANotification.notify, true);
  assert.equal(sessionANotification.prior_unresolved_count, 1);

  const ambiguousResolution = resolveCheckpoint({
    cwd: sessionScopeRepo,
    resolution: "no_update",
    env: sessionScopeEnv,
  });
  assert.equal(ambiguousResolution.availability, "unavailable");
  assert.equal(ambiguousResolution.reason_code, "multiple_unresolved_checkpoints");
  assert.equal(checkpointStatus({ cwd: sessionScopeRepo, env: sessionScopeEnv }).unresolved_count, 2);

  const resolvedACli = runEntry(
    sessionScopeRepo,
    sessionScopeEnv,
    [
      "context-checkpoint",
      "resolve",
      "no-update",
      "--epoch",
      sessionA.epoch_id,
      "--json",
    ],
  );
  assert.equal(resolvedACli.status, 0);
  const resolvedA = JSON.parse(resolvedACli.stdout);
  assert.equal(resolvedA.availability, "available");
  assert.equal(resolvedA.resolution, "no_update");
  assert.equal(resolvedA.unresolved_count, 1);
  assert.equal(resolvedA.unresolved_epochs[0].epoch_id, sessionB.epoch_id);
  pass("FX-CCG-006 Session source Epoch와 one-time 진단 및 resolve 격리");

  const concurrentSessionRepo = makeRepository("concurrent-session-scope");
  const concurrentSessionEnv = {
    ...fixtureEnv,
    XDG_STATE_HOME: path.join(sandbox, "concurrent-session-scope-state"),
  };
  const concurrentSessions = await Promise.all([
    runEntryAsync(
      concurrentSessionRepo,
      concurrentSessionEnv,
      ["hook", "claude", "PostToolUse"],
      {
        session_id: "concurrent-scope-a",
        cwd: concurrentSessionRepo,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: path.join(concurrentSessionRepo, "a.txt"), content: "private" },
        tool_response: { success: true },
        tool_use_id: "concurrent-scope-event-a",
      },
    ),
    runEntryAsync(
      concurrentSessionRepo,
      concurrentSessionEnv,
      ["hook", "claude", "PostToolUse"],
      {
        session_id: "concurrent-scope-b",
        cwd: concurrentSessionRepo,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "make test-context-checkpoint-fixtures" },
        tool_response: { stdout: "private", stderr: "" },
        tool_use_id: "concurrent-scope-event-b",
      },
    ),
  ]);
  const concurrentSessionOutcomes = concurrentSessions.map((result, index) => classifyChildOutcome(
    result,
    `session-scope-child-${index}`,
  ));
  assert.ok(concurrentSessionOutcomes.every(outcome => outcome.kind === "available"));
  const concurrentSessionStatus = checkpointStatus({
    cwd: concurrentSessionRepo,
    env: concurrentSessionEnv,
  });
  assert.equal(concurrentSessionStatus.unresolved_count, 2);
  assert.deepEqual(
    concurrentSessionStatus.unresolved_epochs.map(epoch => epoch.activity_revision),
    [1, 1],
  );
  pass("FX-CCG-007 독립 Process의 동시 Session Activity를 source Epoch별 직렬화");

  const migrationRepo = makeRepository("schema-v1-migration");
  const migrationEnv = {
    ...fixtureEnv,
    XDG_STATE_HOME: path.join(sandbox, "schema-v1-migration-state"),
  };
  const migrationActivity = recordCheckpointActivity({
    cwd: migrationRepo,
    runtime: "claude",
    sessionId: "migration-session",
    eventId: "migration-event-one",
    signalKind: "file_mutation",
    env: migrationEnv,
  });
  const migrationStateFile = findStateFileForHash(
    migrationEnv.XDG_STATE_HOME,
    migrationActivity.repository_hash,
  );
  const migrationV2 = JSON.parse(fs.readFileSync(migrationStateFile, "utf8"));
  const migrationEpoch = migrationV2.unresolved_epochs[0];
  fs.writeFileSync(migrationStateFile, `${JSON.stringify({
    schema_version: 1,
    repository_hash: migrationV2.repository_hash,
    worktree_hash: migrationV2.worktree_hash,
    runtime: migrationEpoch.runtime,
    session_hash: migrationEpoch.session_hash,
    epoch_id: migrationEpoch.epoch_id,
    activity_signal_kinds: migrationEpoch.activity_signal_kinds,
    activity_revision: migrationEpoch.activity_revision,
    seen_event_hashes: migrationEpoch.seen_event_hashes,
    first_activity_at: migrationEpoch.first_activity_at,
    last_activity_at: migrationEpoch.last_activity_at,
    checkpoint_state: "review_needed",
    last_notified_boundary: null,
    last_notified_revision: null,
    last_notified_at: null,
    resolution: null,
    resolved_at: null,
    promotion_source_ref: null,
    availability: "available",
    created_at: migrationV2.created_at,
  }, null, 2)}\n`, "utf8");
  const migratedStatus = checkpointStatus({ cwd: migrationRepo, env: migrationEnv });
  assert.equal(migratedStatus.schema_version, 2);
  assert.equal(migratedStatus.unresolved_count, 1);
  assert.equal(migratedStatus.unresolved_epochs[0].epoch_id, migrationEpoch.epoch_id);
  assert.equal(JSON.parse(fs.readFileSync(migrationStateFile, "utf8")).schema_version, 1);
  const migratedActivity = recordCheckpointActivity({
    cwd: migrationRepo,
    runtime: "claude",
    sessionId: "migration-session",
    eventId: "migration-event-two",
    signalKind: "validation_run",
    env: migrationEnv,
  });
  assert.equal(migratedActivity.activity_revision, 2);
  assert.equal(JSON.parse(fs.readFileSync(migrationStateFile, "utf8")).schema_version, 2);
  pass("FX-CCG-007 schema v1은 조회 시 보존하고 다음 mutation에서 v2로 전환");

  const unsupported = recordCheckpointActivity({
    cwd: lifecycle,
    runtime: "unsupported-runtime",
    sessionId: "unsupported-session",
    eventId: "unsupported-event",
    signalKind: "file_mutation",
    env: lifecycleEnv,
  });
  assert.equal(unsupported.availability, "unavailable");
  assert.equal(unsupported.manual_checkpoint_required, true);
  pass("FX-CCG-013 미지원 Runtime은 Manual fallback");

  const handoff = checkpointHandoffPreflight({ cwd: lifecycle, env: lifecycleEnv });
  assert.equal(handoff.allow_handoff, true);
  assert.equal(handoff.hard_block, false);
  assert.equal(handoff.context_checkpoint, "review_needed / unresolved");
  const handoffCli = runEntry(
    lifecycle,
    lifecycleEnv,
    ["context-checkpoint", "handoff-preflight", "--json"],
  );
  assert.equal(handoffCli.status, 0);
  assert.deepEqual(JSON.parse(handoffCli.stdout), handoff);
  pass("FX-CCG-014 Manual Handoff는 허용하며 unresolved truth 보존");

  const statusCli = runEntry(lifecycle, lifecycleEnv, ["context-checkpoint", "status", "--json"]);
  assert.equal(statusCli.status, 0);
  assert.equal(JSON.parse(statusCli.stdout).checkpoint_state, "review_needed");
  const resolveCli = runEntry(lifecycle, lifecycleEnv, [
    "context-checkpoint",
    "resolve",
    "checkpointed",
    "--promotion-source",
    "context-checkpoint-fixture",
    "--json",
  ]);
  assert.equal(resolveCli.status, 0);
  assert.equal(JSON.parse(resolveCli.stdout).resolution, "checkpointed");

  const storedLifecycleState = allFiles(lifecycleEnv.XDG_STATE_HOME)
    .filter(file => file.endsWith(".json"))
    .map(file => fs.readFileSync(file, "utf8"))
    .join("\n");
  for (const forbidden of [
    "/private/transcript/must-not-be-stored.jsonl",
    "prompt and file content must not be stored",
    path.join(lifecycle, "src", "secret-file.txt"),
  ]) {
    assert.equal(storedLifecycleState.includes(forbidden), false, `lifecycle state leaked ${forbidden}`);
  }

  const managedSettings = JSON.parse(
    fs.readFileSync(path.join(productRoot, "claude", "settings.json"), "utf8"),
  );
  const activityHooks = managedSettings.hooks.PostToolUse
    .filter(group => group.matcher !== "Skill")
    .flatMap(group => group.hooks);
  assert.equal(activityHooks.length, 1);
  assert.match(activityHooks[0].command, /hook claude PostToolUse/);
  assert.equal(managedSettings.hooks.SessionEnd.length, 1);
  assert.match(managedSettings.hooks.SessionEnd[0].hooks[0].command, /hook claude SessionEnd/);
} finally {
  for (const directory of cleanup.reverse()) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for isolated fixture directories only.
    }
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function makeRepository(name) {
  const directory = path.join(sandbox, name);
  fs.mkdirSync(directory, { recursive: true });
  runGit(directory, ["init", "-q"]);
  runGit(directory, ["config", "user.email", "fixture@example.invalid"]);
  runGit(directory, ["config", "user.name", "Fixture"]);
  fs.writeFileSync(path.join(directory, "README.md"), `${name}\n`, "utf8");
  runGit(directory, ["add", "README.md"]);
  runGit(directory, ["commit", "-qm", "fixture"]);
  return directory;
}

function makeLinkedWorktree(repository) {
  const directory = path.join(sandbox, "linked-worktree");
  runGit(repository, ["worktree", "add", "-q", "-b", "fixture-linked", directory]);
  cleanup.push(directory);
  return directory;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runEntry(cwd, env, args, payload) {
  return spawnSync(process.execPath, [publicEntry, ...args], {
    cwd,
    env,
    input: payload === undefined
      ? ""
      : typeof payload === "string"
        ? payload
        : JSON.stringify(payload),
    encoding: "utf8",
  });
}

function runEntryAsync(cwd, env, args, payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [publicEntry, ...args], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        pid: null,
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        spawnError: error,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve({
        pid: child.pid ?? null,
        code: exitCode,
        signal: exitSignal,
        stdout,
        stderr,
        spawnError,
      });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { spawnError = error; });
    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      settle();
    });
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch (error) {
      spawnError = error;
      try { child.kill(); } catch { /* close event carries the final evidence */ }
    }
  });
}

function classifyChildOutcome(result, label) {
  const evidence = childEvidence(result);
  assert.ok(result && typeof result === "object", `${label}: missing child result; ${evidence}`);
  assert.equal(
    typeof result.pid === "number" && result.pid > 0,
    true,
    `${label}: missing PID; ${evidence}`,
  );
  assert.equal(result.code, 0, `${label}: non-zero exit; ${evidence}`);
  assert.equal(result.signal, null, `${label}: unexpected signal; ${evidence}`);
  assert.equal(result.spawnError, null, `${label}: spawn error; ${evidence}`);
  assert.equal(result.stderr, "", `${label}: unexpected stderr; ${evidence}`);
  assert.equal(typeof result.stdout, "string", `${label}: invalid stdout; ${evidence}`);

  if (result.stdout === "") {
    return { kind: "available", availability: "available", reason_code: null };
  }

  let diagnostic;
  try {
    diagnostic = JSON.parse(result.stdout);
  } catch {
    assert.fail(`${label}: invalid stdout diagnostic; ${evidence}`);
  }
  assert.ok(
    diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic),
    `${label}: stdout diagnostic is not an object; ${evidence}`,
  );
  assert.deepEqual(
    Object.keys(diagnostic).sort(),
    ["systemMessage"],
    `${label}: unknown stdout diagnostic fields; ${evidence}`,
  );
  assert.equal(
    typeof diagnostic.systemMessage === "string",
    true,
    `${label}: diagnostic message missing; ${evidence}`,
  );
  assert.equal(
    diagnostic.systemMessage.includes("availability: unavailable (state_lock_failed)"),
    true,
    `${label}: unknown unavailable reason; ${evidence}`,
  );
  assert.equal(
    diagnostic.systemMessage.includes("Manual Context Checkpoint"),
    true,
    `${label}: manual checkpoint guidance missing; ${evidence}`,
  );
  return {
    kind: "unavailable",
    availability: "unavailable",
    reason_code: "state_lock_failed",
    diagnostic,
  };
}

function childLabel(index, payload) {
  return `child index=${index} tool_use_id=${String(payload?.tool_use_id || "unknown")}`;
}

function childEvidence(result) {
  const spawnError = result?.spawnError;
  return JSON.stringify({
    pid: typeof result?.pid === "number" ? result.pid : null,
    exit_code: result?.code ?? null,
    signal: result?.signal ?? null,
    stdout_bytes: typeof result?.stdout === "string" ? Buffer.byteLength(result.stdout) : null,
    stderr_bytes: typeof result?.stderr === "string" ? Buffer.byteLength(result.stderr) : null,
    spawn_error: spawnError
      ? { name: spawnError.name || "Error", code: spawnError.code || null }
      : null,
  });
}

function readStoredActivityForRepository(root, repositoryHash) {
  const files = allFiles(root)
    .filter(file => file.includes(repositoryHash) && file.endsWith(".json"));
  assert.equal(files.length <= 1, true, "unexpected multiple state files for repository");
  return files.length === 0
    ? { activity_revision: 0, seen_event_hashes: [] }
    : readStoredActivityState(files[0]);
}

function readStoredActivityState(stateFile) {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(Array.isArray(state.unresolved_epochs), true, "stored state epochs missing");
  assert.equal(state.unresolved_epochs.length, 1, "expected one stored activity epoch");
  const epoch = state.unresolved_epochs[0];
  return {
    activity_revision: epoch.activity_revision,
    seen_event_hashes: [...epoch.seen_event_hashes],
  };
}

function findOnlyStateFile(root) {
  const files = allFiles(root).filter(file => file.endsWith(".json"));
  assert.ok(files.length >= 1, "expected at least one state file");
  return files[0];
}

function findStateFileForHash(root, repositoryHash) {
  const file = allFiles(root).find(candidate => candidate.includes(repositoryHash) && candidate.endsWith(".json"));
  assert.ok(file, `missing state for ${repositoryHash}`);
  return file;
}

function allFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name));
}

function pass(label) {
  process.stdout.write(`passed: ${label}\n`);
}
