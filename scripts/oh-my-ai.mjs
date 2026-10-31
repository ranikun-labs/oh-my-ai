#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleClaudeCheckpointHook } from "./lib/context-checkpoint-claude.mjs";
import { handleCodexCheckpointHook } from "./lib/context-checkpoint-codex.mjs";
import {
  checkpointHandoffPreflight,
  checkpointStatus,
  resolveCheckpoint,
} from "./lib/context-checkpoint-state.mjs";
import { rememberWorkStartExecution } from "./lib/work-start-execution-state.mjs";
import { handleJiraTicketRuntimeInput } from "./lib/jira-ticket-runtime-entry.mjs";

const args = process.argv.slice(2);
const command = args[0];

if (command === "hook") {
  runHook(args.slice(1));
} else if (command === "context-checkpoint") {
  runContextCheckpoint(args.slice(1));
} else if (command === "work-start") {
  runWorkStart(args.slice(1));
} else if (command === "jira-ticket") {
  runJiraTicket(args.slice(1));
} else {
  usage(command ? `unknown command: ${command}` : "");
}

function runJiraTicket(args) {
  if (args.length !== 2 || args[0] !== "--json") {
    process.stderr.write("usage: oh-my-ai jira-ticket --json <runtime-protocol-json>\n");
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(args[1]);
  } catch {
    process.stderr.write("jira-ticket input must be valid JSON\n");
    process.exit(2);
  }
  if (!['codex', 'claude'].includes(input.runtime) && input.event === 'start') {
    process.stderr.write("jira-ticket start runtime must be codex or claude\n");
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(handleJiraTicketRuntimeInput(input))}\n`);
  } catch (error) {
    process.stderr.write(`jira-ticket runtime protocol failed: ${error.message}\n`);
    process.exit(2);
  }
}

function runWorkStart(args) {
  if (args.length !== 2 || args[0] !== "--" || !args[1].trim()) {
    process.stderr.write("usage: oh-my-ai work-start -- <task>\n");
    process.exit(2);
  }
  // The public entry accepts exactly one argv task. Do not reconstruct it:
  // quoting and shell metacharacters are part of the caller's original task.
  const task = args[1];

  const repoRoot = findRepoRoot();
  const engine = path.join(repoRoot, "scripts", "work-start.sh");
  try {
    fs.accessSync(engine, fs.constants.X_OK);
  } catch {
    process.stderr.write(`work-start engine is unavailable: ${engine}\n`);
    process.exit(1);
  }

  // Keep the caller's cwd: work-start resolves the target repository from it.
  const result = spawnSync(engine, [], {
    cwd: process.cwd(),
    env: { ...process.env, TASK: task },
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`work-start engine failed to start: ${result.error.message}\n`);
    process.exit(1);
  }
  const status = result.status ?? 1;
  if (status === 0) {
    const execution = workStartExecutionContext();
    const persistence = rememberWorkStartExecution(
      process.cwd(),
      execution.runtime,
      execution.sessionId,
      task,
    );
    if (persistence.errorCode) {
      process.stderr.write(`work-start execution state was not saved: state_error_code=${persistence.errorCode}\n`);
    }
  }
  process.exit(status);
}

function workStartExecutionContext() {
  if (process.env.CLAUDE_CODE_SESSION_ID) {
    return { runtime: "claude", sessionId: process.env.CLAUDE_CODE_SESSION_ID };
  }
  if (process.env.OH_MY_AI_WORK_START_RUNTIME === "codex" && process.env.OH_MY_AI_WORK_START_SESSION_ID) {
    return { runtime: "codex", sessionId: process.env.OH_MY_AI_WORK_START_SESSION_ID };
  }
  return { runtime: "", sessionId: "" };
}

function runHook(args) {
  const runtime = args[0] || "";
  const eventName = args[1] || "";
  const input = readStdin();

  if (
    runtime === "claude"
    && ["PostToolUse", "SessionEnd", "SessionStart"].includes(eventName)
  ) {
    const output = handleClaudeCheckpointHook(eventName, input, { env: process.env });
    if (eventName === "SessionStart") {
      const backlog = sessionStartBacklog();
      if (backlog) {
        output.additionalContext = [output.additionalContext, backlog].filter(Boolean).join("\n\n");
      }
    }
    writeClaudeHookOutput(eventName, output);
    process.exit(0);
  }

  let codexCheckpointOutput = {};
  if (
    runtime === "codex"
    && ["PostToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"].includes(eventName)
  ) {
    codexCheckpointOutput = handleCodexCheckpointHook(eventName, input, { env: process.env });
    if (eventName !== "UserPromptSubmit") {
      writeHookOutput(eventName, codexCheckpointOutput);
      process.exit(0);
    }
  }

  if (eventName !== "UserPromptSubmit") {
    process.exit(0);
  }

  const format =
    runtime === "claude"
      ? "claude-json"
      : runtime === "codex"
        ? "codex-json"
        : "";

  if (!format) {
    logHookFailure({ runtime, eventName, reason: "unsupported runtime" });
    process.exit(0);
  }

  const repoRoot = findRepoRoot();
  const hookScript = path.join(repoRoot, "scripts", "prompt-routing-hook.mjs");
  if (!fs.existsSync(hookScript)) {
    logHookFailure({ runtime, eventName, reason: "missing prompt-routing-hook.mjs", repoRoot });
    process.exit(0);
  }

  const result = spawnSync(process.execPath, [hookScript, `--format=${format}`], {
    input,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  if (runtime === "codex") {
    writeMergedCodexPromptOutput(codexCheckpointOutput, result.stdout);
  } else if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.status !== 0 || result.error) {
    logHookFailure({
      runtime,
      eventName,
      reason: result.error ? result.error.message : `exit ${result.status}`,
      stderr: result.stderr,
    });
  }

  process.exit(0);
}

function sessionStartBacklog() {
  const repoRoot = findRepoRoot();
  const backlog = path.join(repoRoot, "automation-backlog.md");
  try {
    return fs.existsSync(backlog) ? fs.readFileSync(backlog, "utf8") : "";
  } catch (error) {
    logHookFailure({ runtime: "claude", eventName: "SessionStart", reason: error.message });
    return "";
  }
}

function writeClaudeHookOutput(eventName, output) {
  writeHookOutput(eventName, output);
}

function writeHookOutput(eventName, output) {
  if (!output.systemMessage && !output.additionalContext) return;
  const payload = {};
  if (output.systemMessage) payload.systemMessage = output.systemMessage;
  if (output.additionalContext) {
    payload.hookSpecificOutput = {
      hookEventName: eventName,
      additionalContext: output.additionalContext,
    };
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function writeMergedCodexPromptOutput(checkpointOutput, routingStdout) {
  let routingOutput = {};
  if (routingStdout?.trim()) {
    try {
      routingOutput = JSON.parse(routingStdout);
    } catch {
      process.stdout.write(routingStdout);
      return;
    }
  }
  const systemMessage = [
    checkpointOutput.systemMessage,
    routingOutput.systemMessage,
  ].filter(Boolean).join("\n\n");
  const additionalContext = [
    checkpointOutput.additionalContext,
    routingOutput.hookSpecificOutput?.additionalContext,
  ].filter(Boolean).join("\n\n");
  writeHookOutput("UserPromptSubmit", { systemMessage, additionalContext });
}

function runContextCheckpoint(args) {
  const action = args[0] || "";
  const wantsJson = args.includes("--json");
  let result;

  if (action === "status" && onlyOptions(args.slice(1), ["--json"])) {
    result = checkpointStatus({ cwd: process.cwd(), env: process.env });
  } else if (
    action === "handoff-preflight"
    && onlyOptions(args.slice(1), ["--json"])
  ) {
    result = checkpointHandoffPreflight({ cwd: process.cwd(), env: process.env });
  } else if (action === "resolve") {
    const resolution = args[1] || "";
    const sourceIndex = args.indexOf("--promotion-source");
    const promotionSourceRef = sourceIndex === -1 ? "" : args[sourceIndex + 1] || "";
    const epochIndex = args.indexOf("--epoch");
    const epochId = epochIndex === -1 ? "" : args[epochIndex + 1] || "";
    const allowed = resolution.replace("-", "_") === "checkpointed"
      ? ["--json", "--promotion-source", promotionSourceRef, "--epoch", epochId]
      : ["--json", "--epoch", epochId];
    if (
      !["checkpointed", "no-update", "no_update"].includes(resolution)
      || !onlyOptions(args.slice(2), allowed)
      || (sourceIndex !== -1 && !promotionSourceRef)
      || (epochIndex !== -1 && !epochId)
    ) {
      contextCheckpointUsage();
    }
    result = resolveCheckpoint({
      cwd: process.cwd(),
      resolution,
      promotionSourceRef,
      epochId,
      env: process.env,
    });
  } else {
    contextCheckpointUsage();
  }

  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    writeContextCheckpointText(action, result);
  }
  process.exit(result.availability === "available" ? 0 : 1);
}

function onlyOptions(values, allowed) {
  const allowedSet = new Set(allowed);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!allowedSet.has(value)) return false;
    if (value === "--promotion-source" || value === "--epoch") index += 1;
  }
  return true;
}

function writeContextCheckpointText(action, result) {
  process.stdout.write(`availability: ${result.availability}\n`);
  process.stdout.write(`checkpoint_state: ${result.checkpoint_state ?? "unknown"}\n`);
  if (Number.isInteger(result.unresolved_count)) {
    process.stdout.write(`unresolved_count: ${result.unresolved_count}\n`);
  }
  if (result.unresolved_count > 1) {
    for (const epoch of result.unresolved_epochs || []) {
      process.stdout.write(`unresolved_epoch: ${epoch.epoch_id}\n`);
    }
  }
  if (result.resolution) process.stdout.write(`resolution: ${result.resolution}\n`);
  if (action === "handoff-preflight") {
    process.stdout.write(`context_checkpoint: ${result.context_checkpoint}\n`);
    process.stdout.write("handoff: allowed (advisory; not a hard block)\n");
    if (result.checkpoint_state === "review_needed") {
      process.stdout.write("choices: checkpoint | no_update | continue_unresolved\n");
    }
  }
  if (result.manual_checkpoint_required) {
    process.stdout.write("manual_action: run a Manual Context Checkpoint review\n");
  }
}

function contextCheckpointUsage() {
  process.stderr.write("usage: oh-my-ai context-checkpoint status [--json]\n");
  process.stderr.write("       oh-my-ai context-checkpoint handoff-preflight [--json]\n");
  process.stderr.write("       oh-my-ai context-checkpoint resolve checkpointed --promotion-source <sanitized-ref> [--epoch <opaque-epoch-id>] [--json]\n");
  process.stderr.write("       oh-my-ai context-checkpoint resolve no-update [--epoch <opaque-epoch-id>] [--json]\n");
  process.exit(2);
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function findRepoRoot() {
  if (process.env.OH_MY_AI_HOME) return process.env.OH_MY_AI_HOME;

  const entrypoint = fs.realpathSync(process.argv[1] || fileURLToPath(import.meta.url));
  return path.resolve(path.dirname(entrypoint), "..");
}

function logHookFailure(details) {
  const repoRoot = safeRepoRoot();
  const entry = {
    ts: new Date().toISOString(),
    source: "oh-my-ai",
    ...details,
  };

  for (const file of hookFailureLogCandidates(repoRoot)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
      return;
    } catch {
      // Hook diagnostics must never block prompt submission.
    }
  }
}

function hookFailureLogCandidates(repoRoot) {
  const stateHome = process.env.XDG_STATE_HOME || path.join(process.env.HOME || "", ".local", "state");
  return [
    path.join(stateHome, "oh-my-ai", "hook-failures.log"),
    path.join(repoRoot, ".oh-my-ai", "state", "hook-failures.log"),
  ];
}

function safeRepoRoot() {
  try {
    return findRepoRoot();
  } catch {
    return process.cwd();
  }
}

function usage(error) {
  if (error) process.stderr.write(`${error}\n`);
  process.stderr.write("usage: oh-my-ai hook <codex|claude> <event>\n");
  process.stderr.write("       oh-my-ai context-checkpoint <status|handoff-preflight|resolve> ...\n");
  process.stderr.write("       oh-my-ai work-start -- <task>\n");
  process.stderr.write("       oh-my-ai jira-ticket --json <runtime-protocol-json>\n");
  process.exit(error ? 2 : 0);
}
