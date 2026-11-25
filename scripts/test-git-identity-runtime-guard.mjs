#!/usr/bin/env node
// Fixtures for the Claude PreToolUse runtime adapter (scripts/git-identity-runtime-guard.mjs).
// Matching is text-level and is a mistake barrier, not a security boundary. These tests pin
// the rules we chose, including the known gaps (see the NOT-covered list at the end).
// No network. Temp HOME/XDG; temp repos; no global git config is read or written.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateBashCommand, splitSegments, tokenize } from "./git-identity-runtime-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = path.join(ROOT, "scripts", "git-identity-runtime-guard.mjs");
const HOOKS_DIR = path.join(ROOT, "hooks", "git-identity");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-identity-runtime-"));
const home = path.join(tmp, "home");
const xdg = path.join(tmp, "xdg");
const globalGitconfig = path.join(tmp, "gitconfig-global");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(xdg, { recursive: true });
fs.writeFileSync(globalGitconfig, "");

const WORK_EMAIL = "work@example.invalid";
const mappingPath = path.join(xdg, "oh-my-ai", "git-identity.json");
const writeMapping = (value, raw) => {
  fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
  fs.writeFileSync(mappingPath, raw ?? JSON.stringify(value));
};
const removeMapping = () => fs.rmSync(mappingPath, { force: true });
const validMapping = () => ({
  schema_version: 1,
  rules: [
    {
      match: "github.com/acme-work/*",
      author_email: WORK_EMAIL,
      author_name: "Work Example",
      github_user: "work-example",
      ssh_host_alias: "github-work",
    },
  ],
});

const envFor = () => ({
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  HOME: home,
  XDG_CONFIG_HOME: xdg,
  GIT_CONFIG_GLOBAL: globalGitconfig,
  GIT_CONFIG_NOSYSTEM: "1",
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: envFor(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");
}

let repoCounter = 0;
function makeRepo({ origin, hooks = false }) {
  repoCounter += 1;
  const dir = path.join(tmp, `repo-${repoCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  if (origin) git(dir, ["remote", "add", "origin", origin]);
  if (hooks) git(dir, ["config", "core.hooksPath", HOOKS_DIR]);
  return dir;
}

function runHook(payload, { cwd = tmp, env = envFor(), raw } = {}) {
  const input = raw ?? JSON.stringify(payload);
  const result = spawnSync(process.execPath, [RUNTIME], { cwd, env, input, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const bash = (command, cwd = tmp) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });
const pureEnv = { HOME: "/nonexistent-home-for-tests", XDG_CONFIG_HOME: "/nonexistent-home-for-tests/.config" };

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

// ---------- tokenizer and segment splitter ----------

test("splitSegments and tokenize respect quotes and operators", () => {
  assert.deepEqual(splitSegments("git status && git log; echo 'a;b' | cat"), ["git status", "git log", "echo 'a;b'", "cat"]);
  assert.deepEqual(tokenize(`git commit -m "fix -n handling" --amend`), ["git", "commit", "-m", "fix -n handling", "--amend"]);
  assert.deepEqual(tokenize("gh api x -f 'a=b c'"), ["gh", "api", "x", "-f", "a=b c"]);
});

// ---------- pure decisions: must deny ----------

const MUST_DENY = [
  ["git commit --no-verify -m x", "NO_VERIFY"],
  ["git push --no-verify origin main", "NO_VERIFY"],
  ["git commit -n -m x", "COMMIT_NO_VERIFY"],
  ["git commit -an -m msg", "COMMIT_NO_VERIFY"],
  ["git -c core.hooksPath=/tmp/x commit -m y", "HOOKSPATH_OVERRIDE"],
  ["git -c core.hooksPath=/tmp/x status", "HOOKSPATH_OVERRIDE"],
  ["git config core.hooksPath /tmp/x", "HOOKSPATH_CONFIG_WRITE"],
  ["git config --unset core.hooksPath", "HOOKSPATH_CONFIG_WRITE"],
  ["gh auth switch", "GH_AUTH_SWITCH_OR_LOGIN"],
  ["gh auth switch --user other", "GH_AUTH_SWITCH_OR_LOGIN"],
  ["gh auth login --hostname github.com", "GH_AUTH_SWITCH_OR_LOGIN"],
  ["OH_MY_AI_GIT_IDENTITY_ALLOW_UNVERIFIED_BINDING=1 git push origin main", "SET_GUARD_ENV"],
  ["export OH_MY_AI_GIT_IDENTITY_CONFIG=/tmp/x.json", "SET_GUARD_ENV"],
  ["git config --global user.email a@b.invalid", "GLOBAL_CONFIG_WRITE"],
  ["git config --global --unset credential.helper", "GLOBAL_CONFIG_WRITE"],
  ["git config --system core.autocrlf false", "GLOBAL_CONFIG_WRITE"],
  ["GIT_AUTHOR_EMAIL=x@y.invalid git commit -m z", "IDENTITY_ENV_OVERRIDE"],
  ["GIT_COMMITTER_NAME=x git commit -m z", "IDENTITY_ENV_OVERRIDE"],
  ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath git status", "CONFIG_ENV_OVERRIDE"],
  ["GIT_CONFIG_GLOBAL=/tmp/evil git status", "CONFIG_ENV_OVERRIDE"],
  ["git -c user.email=x@y.invalid commit -m z", "CONFIG_OVERRIDE"],
];

for (const [command, code] of MUST_DENY) {
  test(`deny: ${command}`, () => {
    const r = evaluateBashCommand(command, { cwd: tmp, env: pureEnv });
    assert.equal(r.decision, "deny", `expected deny for: ${command}`);
    assert.equal(r.code, code);
  });
}

// gh API/PR writes are denied only in mapped repos without hooks (see the gate tests below).

// ---------- pure decisions: must allow (read-only and unrelated) ----------

const MUST_ALLOW = [
  "git status && git log -3",
  "git config --get core.hooksPath",
  "git config --global --get user.email",
  "git config --list --show-origin",
  "git commit -m 'fix -n handling'",
  "git commit -m \"document --no-verify behavior\"",
  "git diff --stat",
  "git fetch origin",
  "gh pr view 1",
  "gh api repos/a/b",
  "gh api repos/a/b -X GET",
  "gh auth status",
  "echo ok",
  "ls -la",
];
for (const command of MUST_ALLOW) {
  test(`allow: ${command}`, () => {
    const r = evaluateBashCommand(command, { cwd: tmp, env: pureEnv });
    assert.equal(r.decision, "allow", `expected allow for: ${command} (got ${r.code})`);
  });
}

test("allow: pushes and gh writes outside any mapping are not this guard's concern (no mapping file)", () => {
  for (const command of ["git push origin main", "gh pr create --title x", "gh api repos/a/b -X POST"]) {
    const r = evaluateBashCommand(command, { cwd: tmp, env: pureEnv });
    assert.equal(r.decision, "allow", command);
  }
});

test("nested shells: --no-verify and env overrides hidden in bash -c / eval are denied", () => {
  const env = pureEnv;
  assert.equal(evaluateBashCommand(`bash -c "git commit --no-verify -m x"`, { cwd: tmp, env }).code, "NO_VERIFY");
  assert.equal(evaluateBashCommand(`sh -c 'export OH_MY_AI_GIT_IDENTITY_CONFIG=/x.json'`, { cwd: tmp, env }).code, "SET_GUARD_ENV");
  assert.equal(evaluateBashCommand(`eval "git -c core.hooksPath=/x commit -m y"`, { cwd: tmp, env }).code, "HOOKSPATH_OVERRIDE");
  assert.equal(evaluateBashCommand(`sh -c "git status"`, { cwd: tmp, env }).decision, "allow");
});

test("message text is not a command: commit messages that mention the guard are allowed", () => {
  const env = pureEnv;
  assert.equal(evaluateBashCommand(`git commit -m "document core.hooksPath=x and --no-verify"`, { cwd: tmp, env }).decision, "allow");
  assert.equal(evaluateBashCommand(`echo "OH_MY_AI_GIT_IDENTITY_CONFIG note"`, { cwd: tmp, env }).decision, "allow");
});

// ---------- mapped-repo gating (fail-closed for AI pushes) ----------

test("gate: git push into a mapped repo WITHOUT native hooks is denied (NATIVE_GUARD_INACTIVE)", () => {
  writeMapping(validMapping());
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  const r = evaluateBashCommand("git push origin main", { cwd: repo, env: envFor() });
  assert.equal(r.decision, "deny");
  assert.equal(r.code, "NATIVE_GUARD_INACTIVE");
});

test("gate: git push into a mapped repo WITH native hooks installed is allowed", () => {
  writeMapping(validMapping());
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git", hooks: true });
  const r = evaluateBashCommand("git push origin main", { cwd: repo, env: envFor() });
  assert.equal(r.decision, "allow", r.reason);
});

test("gate: gh pr create / merge and gh api writes in a mapped repo without hooks are denied; GET is allowed", () => {
  writeMapping(validMapping());
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  for (const command of [
    "gh pr create --title x",
    "gh pr merge 12 --squash",
    "gh api repos/acme-work/repo/issues -f title=x",
    "gh api repos/acme-work/repo -X PATCH -f name=x",
    "gh api repos/acme-work/repo -XDELETE",
    "gh api repos/acme-work/repo --method=PUT",
  ]) {
    assert.equal(evaluateBashCommand(command, { cwd: repo, env: envFor() }).decision, "deny", command);
  }
  assert.equal(evaluateBashCommand("gh api repos/acme-work/repo", { cwd: repo, env: envFor() }).decision, "allow");
  assert.equal(evaluateBashCommand("gh pr view 12", { cwd: repo, env: envFor() }).decision, "allow");
});

test("gate: an unmapped repo is not gated (push and gh writes allowed)", () => {
  writeMapping(validMapping());
  const repo = makeRepo({ origin: "https://example.invalid/some/repo.git" });
  assert.equal(evaluateBashCommand("git push origin main", { cwd: repo, env: envFor() }).decision, "allow");
  assert.equal(evaluateBashCommand("gh pr create --title x", { cwd: repo, env: envFor() }).decision, "allow");
});

test("gate: cd into a mapped repo, then push, is denied (cwd tracked through cd)", () => {
  writeMapping(validMapping());
  const unmapped = makeRepo({ origin: "https://example.invalid/some/repo.git" });
  const mapped = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  const r = evaluateBashCommand(`cd ${mapped} && git push origin main`, { cwd: unmapped, env: envFor() });
  assert.equal(r.decision, "deny");
  assert.equal(r.code, "NATIVE_GUARD_INACTIVE");
});

test("gate: git -C <mapped repo> push from an unmapped cwd is denied", () => {
  writeMapping(validMapping());
  const unmapped = makeRepo({ origin: "https://example.invalid/some/repo.git" });
  const mapped = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  const r = evaluateBashCommand(`git -C ${mapped} push origin main`, { cwd: unmapped, env: envFor() });
  assert.equal(r.decision, "deny");
});

test("gate: git push to a mapped URL argument (no remote) is denied when hooks are absent", () => {
  writeMapping(validMapping());
  const unmapped = makeRepo({ origin: "https://example.invalid/some/repo.git" });
  const r = evaluateBashCommand("git push git@github-work:acme-work/other.git main", { cwd: unmapped, env: envFor() });
  assert.equal(r.decision, "deny");
  assert.equal(r.code, "NATIVE_GUARD_INACTIVE");
});

test("gate: an INVALID mapping file fails closed for pushes (CONFIG_INVALID)", () => {
  writeMapping(null, "{ not json");
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git", hooks: true });
  const r = evaluateBashCommand("git push origin main", { cwd: repo, env: envFor() });
  assert.equal(r.decision, "deny");
  assert.equal(r.code, "CONFIG_INVALID");
});

test("gate: a MISSING mapping file means the guard is not opted in (push allowed)", () => {
  removeMapping();
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  assert.equal(evaluateBashCommand("git push origin main", { cwd: repo, env: envFor() }).decision, "allow");
});

// ---------- hook JSON I/O ----------

test("hook: deny decision is printed as PreToolUse JSON with exit 0", () => {
  writeMapping(validMapping());
  const r = runHook(bash("git commit --no-verify -m x"));
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /\[NO_VERIFY\]/);
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /mistake barrier/);
});

test("hook: allow prints nothing (exit 0)", () => {
  const r = runHook(bash("git status"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("hook: non-Bash tools pass through untouched", () => {
  const r = runHook({ tool_name: "Write", tool_input: { file_path: "x", content: "git commit --no-verify" }, cwd: tmp });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("hook: unparseable input is denied (fail-closed)", () => {
  const r = runHook(null, { raw: "{not json" });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /HOOK_INPUT_UNPARSEABLE/);
});

test("hook: payload cwd is used for the mapped-repo gate", () => {
  writeMapping(validMapping());
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  const r = runHook(bash("git push origin main", repo), { env: envFor() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NATIVE_GUARD_INACTIVE/);
});

// ---------- runner ----------

let failed = 0;
for (const { name, fn } of results) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${(error.message ?? String(error)).split("\n").slice(0, 8).join("\n     ")}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
