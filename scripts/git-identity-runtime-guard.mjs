#!/usr/bin/env node
// Runtime adapter for the git identity guard: Claude Code PreToolUse hook, matcher "Bash".
// Reads the hook JSON on stdin. Prints a PreToolUse deny decision on stdout (exit 0) or prints
// nothing (allow). Wiring is an example only: profiles/example/claude-settings.git-identity.json.example.
//
// MISTAKE BARRIER, NOT A SECURITY BOUNDARY. This matches command text. It is bypassed by shell
// indirection (variables, eval, aliases, scripts, `sh -c` with nested quoting, here-docs),
// by other tools (MCP, web UI, other clients), and by editing the mapping file. Native hooks
// and server-side rules are the backstop.
//
// Fail-closed where it matters for an AI path: unparseable hook input, invalid mapping file,
// and push/gh-write into a mapped repo whose native hooks are not installed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEffectiveMapping, resolveRule } from "./lib/git-identity-policy.mjs";
import { nativeGuardState } from "./git-identity-guard.mjs";

const GH_WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const GIT_READ_CONFIG_FLAGS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l",
  "--show-origin",
  "--show-scope",
  "--name-only",
]);
const GIT_WRITE_CONFIG_FLAGS = new Set(["--unset", "--unset-all", "--add", "--replace-all", "--remove-section", "--rename-section", "--edit", "-e"]);
const GIT_OPTS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const COMMIT_OPTS_WITH_ARG = new Set(["-m", "-F", "-C", "-c", "-t", "--author", "--date", "--cleanup", "--template", "--fixup", "--squash"]);
const PUSH_OPTS_WITH_ARG = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
const GH_GLOBAL_OPTS_WITH_ARG = new Set(["-R", "--repo", "--hostname"]);
const GH_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

const deny = (code, reason) => ({ decision: "deny", code, reason });
const ALLOW = { decision: "allow" };

// Splits a shell command into simple-command segments. Quote-aware; operators are
// ; | & newline ( ) and backtick. Not a shell parser.
export function splitSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      current += c;
      if (c === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      current += c + command[i + 1];
      i += 1;
      continue;
    }
    if (";|&\n()`".includes(c)) {
      segments.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

// Whitespace tokens with quotes removed. Not a full shell lexer.
export function tokenize(segment) {
  const tokens = [];
  let current = "";
  let has = false;
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1];
        i += 1;
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\" && i + 1 < segment.length) {
      current += segment[i + 1];
      has = true;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) tokens.push(current);
      current = "";
      has = false;
      continue;
    }
    current += c;
    has = true;
  }
  if (has) tokens.push(current);
  return tokens;
}

// Leading VAR=value assignments and `env` wrappers are not the command word.
function splitPrefix(tokens) {
  let index = 0;
  const assignments = [];
  while (index < tokens.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
      assignments.push(tokens[index]);
      index += 1;
    } else if (tokens[index] === "env") {
      index += 1;
    } else {
      break;
    }
  }
  return { assignments, words: tokens.slice(index) };
}

function parseGit(words) {
  const dirs = [];
  const configs = [];
  let index = 1;
  while (index < words.length && words[index].startsWith("-")) {
    const word = words[index];
    if (word === "-C") dirs.push(words[index + 1] ?? "");
    if (word === "-c") configs.push(words[index + 1] ?? "");
    index += GIT_OPTS_WITH_ARG.has(word) ? 2 : 1;
  }
  return { sub: words[index] ?? null, rest: words.slice(index + 1), dirs, configs };
}

function parseGh(words) {
  const positional = [];
  let index = 1;
  while (index < words.length && positional.length < 2) {
    const word = words[index];
    if (word.startsWith("-")) {
      index += GH_GLOBAL_OPTS_WITH_ARG.has(word) ? 2 : 1;
      continue;
    }
    positional.push(word);
    index += 1;
  }
  return { sub1: positional[0] ?? null, sub2: positional[1] ?? null, rest: words.slice(index) };
}

function configFinding(rest) {
  const hasRead = rest.some((t) => GIT_READ_CONFIG_FLAGS.has(t));
  const hasWrite = rest.some((t) => GIT_WRITE_CONFIG_FLAGS.has(t));
  const positional = rest.filter((t) => !t.startsWith("-"));
  const isWrite = hasWrite || (!hasRead && positional.length >= 2);
  if (!isWrite) return null;
  const isGlobal = rest.some((t) => t === "--global" || t === "--system");
  if (isGlobal) {
    return deny("GLOBAL_CONFIG_WRITE", "git config --global/--system writes change every repo and session on this machine. Set identity per repo, or ask the owner.");
  }
  if (positional.some((t) => t.toLowerCase() === "core.hookspath")) {
    return deny("HOOKSPATH_CONFIG_WRITE", "Changing core.hooksPath disables the identity hooks. Blocked.");
  }
  return null;
}

// `git commit -n` is --no-verify. Scan short-flag clusters, skipping values of -m/-F/...
function commitNoVerify(rest) {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (COMMIT_OPTS_WITH_ARG.has(token)) {
      index += 1;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(token) && token.includes("n")) return true;
  }
  return false;
}

function pushArgs(rest) {
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (PUSH_OPTS_WITH_ARG.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    positional.push(token);
  }
  return positional;
}

function ghMethodOf(rest) {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "-X" || token === "--method") return (rest[index + 1] ?? "").toUpperCase();
    if (token.startsWith("--method=")) return token.slice("--method=".length).toUpperCase();
    if (/^-X[A-Za-z]+$/.test(token)) return token.slice(2).toUpperCase();
  }
  return null;
}

function remoteUrlOf(name, dir) {
  try {
    return execFileSync("git", ["remote", "get-url", name], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// A push or gh write is allowed only when it cannot land in a mapped repo without the native
// hooks. Unmapped repos and repos without a mapping file are not this guard's concern.
function mappedRepoGate({ dir, env, kind, remoteName, remoteUrl }) {
  const mapping = loadEffectiveMapping(env);
  if (!mapping.ok) {
    if (mapping.code === "CONFIG_MISSING") return null;
    return deny("CONFIG_INVALID", `${kind} blocked fail-closed: the git identity mapping file is invalid (${mapping.code}). Fix it, then retry.`);
  }
  const url = remoteUrl ?? remoteUrlOf(remoteName ?? "origin", dir);
  if (!url) return null;
  const resolution = resolveRule(url, mapping.config);
  if (!resolution.rule) return null;
  const native = nativeGuardState(dir);
  if (native.active) return null;
  return deny(
    "NATIVE_GUARD_INACTIVE",
    `${kind} into mapped rule ${resolution.rule.match} is blocked: the identity hooks are not active for this repo (pre-commit ${native.preCommit}, pre-push ${native.prePush}). Install them, then retry.`,
  );
}

// Pure decision for one Bash command. `cwd` is the directory the command starts in.
// Token-level env/config overrides. Checked on every token of every segment, so both a prefix
// assignment (`X=1 git ...`) and `export X=1` are caught, while a commit message that merely
// mentions the text is not (its token does not start with the name).
const ENV_OVERRIDES = [
  [/^OH_MY_AI_GIT_IDENTITY_[A-Z0-9_]*=/, "SET_GUARD_ENV", "Setting OH_MY_AI_GIT_IDENTITY_* changes the guard. Only a human sets these."],
  [/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)=/, "IDENTITY_ENV_OVERRIDE", "GIT_AUTHOR_*/GIT_COMMITTER_* overrides change the commit identity. Blocked."],
  [
    /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL)=/,
    "CONFIG_ENV_OVERRIDE",
    "GIT_CONFIG_* environment overrides can change hooksPath or identity. Blocked.",
  ],
  [/^core\.hookspath=/i, "HOOKSPATH_OVERRIDE", "core.hooksPath=... disables the identity hooks. Blocked."],
];
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval"]);
// Unanchored versions, used only on the joined text of a nested segment.
const NESTED_OVERRIDES = [
  [/\bOH_MY_AI_GIT_IDENTITY_[A-Z0-9_]*=/, "SET_GUARD_ENV", ENV_OVERRIDES[0][2]],
  [/\bGIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)=/, "IDENTITY_ENV_OVERRIDE", ENV_OVERRIDES[1][2]],
  [/\bGIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL)=/, "CONFIG_ENV_OVERRIDE", ENV_OVERRIDES[2][2]],
  [/core\.hookspath=/i, "HOOKSPATH_OVERRIDE", ENV_OVERRIDES[3][2]],
];

// Nested shells (`bash -c "..."`, `eval`, or a token that embeds `git`) hide the real command
// inside one quoted token, so these patterns are applied to the joined text of that segment.
function nestedFinding(tokens) {
  const joined = tokens.join(" ");
  if (/--no-verify\b/.test(joined)) return deny("NO_VERIFY", "--no-verify skips the identity hooks. Blocked.");
  for (const [pattern, code, reason] of NESTED_OVERRIDES) {
    if (pattern.test(joined)) return deny(code, reason);
  }
  return null;
}

export function evaluateBashCommand(command, { cwd = process.cwd(), env = process.env } = {}) {
  const raw = String(command);

  let dir = cwd;
  for (const segment of splitSegments(raw)) {
    const tokens = tokenize(segment);
    const { words } = splitPrefix(tokens);

    for (const token of tokens) {
      for (const [pattern, code, reason] of ENV_OVERRIDES) {
        if (pattern.test(token)) return deny(code, reason);
      }
    }
    if (words.length === 0) continue;

    const nested = SHELL_WRAPPERS.has(words[0]) || (words[0] !== "git" && tokens.some((t) => /\bgit\b/.test(t)));
    if (nested) {
      const finding = nestedFinding(tokens);
      if (finding) return finding;
    }

    if (words[0] === "cd") {
      dir = path.resolve(dir, words[1] ?? os.homedir());
      continue;
    }

    if (words[0] === "git") {
      if (tokens.some((t) => t === "--no-verify" || t.startsWith("--no-verify="))) {
        return deny("NO_VERIFY", "--no-verify skips the identity hooks. Blocked.");
      }
      const git = parseGit(words);
      const dirAfterC = git.dirs.reduce((acc, d) => path.resolve(acc, d), dir);
      for (const config of git.configs) {
        if (/^(core\.hookspath|user\.|author\.|committer\.)/i.test(config)) {
          return deny("CONFIG_OVERRIDE", `git -c ${config.split("=")[0]} overrides identity or hooks. Blocked.`);
        }
      }
      if (git.sub === "config") {
        const finding = configFinding(git.rest);
        if (finding) return finding;
      }
      if (git.sub === "commit" && commitNoVerify(git.rest)) {
        return deny("COMMIT_NO_VERIFY", "git commit -n is --no-verify. Blocked.");
      }
      if (git.sub === "push") {
        const [repoArg] = pushArgs(git.rest);
        const isUrl = repoArg !== undefined && /[/:@]/.test(repoArg);
        const gate = mappedRepoGate({
          dir: dirAfterC,
          env,
          kind: "git push",
          remoteName: repoArg && !isUrl ? repoArg : "origin",
          remoteUrl: isUrl ? repoArg : undefined,
        });
        if (gate) return gate;
      }
    }

    if (words[0] === "gh") {
      const gh = parseGh(words);
      if (gh.sub1 === "auth" && (gh.sub2 === "switch" || gh.sub2 === "login")) {
        return deny("GH_AUTH_SWITCH_OR_LOGIN", "gh auth switch/login changes machine-wide account state. Use gh-env (GH_CONFIG_DIR per account) instead.");
      }
      let isWrite = false;
      if (gh.sub1 === "pr" && (gh.sub2 === "create" || gh.sub2 === "merge")) isWrite = true;
      if (gh.sub1 === "api") {
        const method = ghMethodOf(gh.rest);
        const hasFields = gh.rest.some((t) => GH_FIELD_FLAGS.has(t) || t.startsWith("--field=") || t.startsWith("--raw-field="));
        isWrite = method ? GH_WRITE_METHODS.has(method) : hasFields;
      }
      if (isWrite) {
        const gate = mappedRepoGate({ dir, env, kind: `gh ${gh.sub1}${gh.sub2 ? ` ${gh.sub2}` : ""} (write)`, remoteName: "origin" });
        if (gate) return gate;
      }
    }
  }
  return ALLOW;
}

// Hook entry. Non-Bash tools pass. Unparseable input is denied (fail-closed).
export function decideFromHookInput(rawInput, env = process.env) {
  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    return deny("HOOK_INPUT_UNPARSEABLE", "git identity runtime guard could not read the hook input. Fail-closed.");
  }
  if (!payload || typeof payload !== "object") {
    return deny("HOOK_INPUT_UNPARSEABLE", "git identity runtime guard received a non-object hook input. Fail-closed.");
  }
  if (payload.tool_name !== "Bash") return ALLOW;
  const command = payload.tool_input?.command;
  if (typeof command !== "string") return ALLOW;
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
  return evaluateBashCommand(command, { cwd, env });
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function main(env = process.env) {
  const decision = decideFromHookInput(readStdin(), env);
  if (decision.decision === "deny") {
    const reason = `git-identity guard [${decision.code}]: ${decision.reason} (mistake barrier, not a security boundary)`;
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`,
    );
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = main();
}
