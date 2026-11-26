#!/usr/bin/env node
// Real-execution tests for the native git identity hooks (hooks/git-identity/pre-commit and
// pre-push). Each temp repo sets core.hooksPath LOCALLY to the wrappers. Remotes use the
// mapped ssh alias form (git@github-work:acme-work/repo.git). Transport is a fake ssh script
// (GIT_SSH_COMMAND, env only) that runs git receive-pack against a local bare repo, so the
// pre-push hook sees the real mapped URL. No network, no global git config, no real keys.
//
// Note: url.<base>.insteadOf must NOT be used here. git applies it before the hook runs,
// so the hook would see a file:// URL and the mapping would not apply.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = path.join(ROOT, "hooks", "git-identity");
const WORK_EMAIL = "work@example.invalid";
const PERSONAL_EMAIL = "personal@example.invalid";
const MAPPED_REMOTE = "git@github-work:acme-work/repo.git";
const UNMAPPED_REMOTE = "git@example.invalid:some/repo.git";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-identity-native-"));
const home = path.join(tmp, "home");
const xdg = path.join(tmp, "xdg");
const bareParent = path.join(tmp, "bare");
// One bare repo per working repo, chosen by FAKE_SSH_BARE (env, per git invocation).
const bareFor = (dir) => path.join(bareParent, `${path.basename(dir)}.git`);
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(xdg, "oh-my-ai"), { recursive: true });
fs.mkdirSync(bareParent, { recursive: true });
fs.writeFileSync(path.join(tmp, "gitconfig-global"), "");
fs.writeFileSync(
  path.join(xdg, "oh-my-ai", "git-identity.json"),
  JSON.stringify({
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
  }),
);

// Fake ssh transport: ignores the host, serves the local bare repo for receive/upload-pack.
const fakeSsh = path.join(tmp, "fake-ssh.sh");
fs.writeFileSync(
  fakeSsh,
  `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  *receive-pack*) exec git receive-pack "$FAKE_SSH_BARE" ;;\n  *upload-pack*) exec git upload-pack "$FAKE_SSH_BARE" ;;\n  *) echo "fake-ssh: unexpected command" >&2; exit 1 ;;\nesac\n`,
);
fs.chmodSync(fakeSsh, 0o755);

const baseEnv = () => ({
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  HOME: home,
  XDG_CONFIG_HOME: xdg,
  GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig-global"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_SSH_COMMAND: fakeSsh,
});

// detached: no controlling terminal, so the hooks can never wait on a human prompt.
// FAKE_SSH_BARE is derived from the working repo's directory name (repos live directly under tmp).
function git(cwd, args, extraEnv = {}) {
  const bareEnv = { FAKE_SSH_BARE: bareFor(cwd) };
  return spawnSync("git", args, { cwd, env: { ...baseEnv(), ...bareEnv, ...extraEnv }, encoding: "utf8", detached: true });
}

function gitOk(cwd, args, extraEnv = {}) {
  const r = git(cwd, args, extraEnv);
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const results = [];
const observed = [];
function test(name, fn) {
  results.push({ name, fn });
}

function newRepo(name, userEmail = WORK_EMAIL) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  gitOk(tmp, ["init", "-q", "--bare", "-b", "main", bareFor(dir)]);
  gitOk(dir, ["init", "-q", "-b", "main"]);
  gitOk(dir, ["config", "user.name", "Work Example"]);
  gitOk(dir, ["config", "user.email", userEmail]);
  // Repo-local config only. Never global.
  gitOk(dir, ["config", "core.hooksPath", HOOKS_DIR]);
  gitOk(dir, ["remote", "add", "origin", MAPPED_REMOTE]);
  return dir;
}

let fileCounter = 0;
function commitFile(dir, message, extraEnv = {}) {
  fileCounter += 1;
  const name = `f-${fileCounter}.txt`;
  fs.writeFileSync(path.join(dir, name), name);
  gitOk(dir, ["add", name]);
  return git(dir, ["commit", "-q", "-m", message], extraEnv);
}

function headCommitter(dir) {
  return gitOk(dir, ["log", "-1", "--format=%ce"]);
}

function bareRefs(dir) {
  return gitOk(bareFor(dir), ["for-each-ref", "--format=%(refname)"]);
}

// ---------- real git commit / amend (pre-commit runs) ----------

test("commit: real git commit with matching committer runs pre-commit and succeeds", () => {
  const dir = newRepo("commit-ok");
  const r = commitFile(dir, "ok");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /git-identity: OK \(rule github\.com\/acme-work\/\*\)/);
  observed.push(["commit", "pre-commit runs", "allowed when identity matches"]);
});

test("commit: real git commit with personal committer is blocked by pre-commit (no commit created)", () => {
  const dir = newRepo("commit-bad", PERSONAL_EMAIL);
  assert.equal(git(dir, ["rev-parse", "-q", "--verify", "HEAD"]).status, 1, "fresh repo has no HEAD yet");
  const r = commitFile(dir, "bad");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BLOCKED COMMITTER_EMAIL_MISMATCH/);
  assert.equal(git(dir, ["rev-parse", "-q", "--verify", "HEAD"]).status, 1, "no commit was created");
  observed.push(["commit", "pre-commit runs", "blocks personal committer"]);
});

test("amend: git commit --amend with personal committer runs pre-commit and is blocked", () => {
  const dir = newRepo("amend");
  assert.equal(commitFile(dir, "good").status, 0);
  const headBefore = gitOk(dir, ["rev-parse", "HEAD"]);
  gitOk(dir, ["config", "user.email", PERSONAL_EMAIL]);
  const r = git(dir, ["commit", "-q", "--amend", "--no-edit"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BLOCKED COMMITTER_EMAIL_MISMATCH/);
  assert.equal(gitOk(dir, ["rev-parse", "HEAD"]), headBefore, "HEAD unchanged");
  observed.push(["commit --amend", "pre-commit runs", "blocks personal committer"]);
});

test("commit --author override with personal author is blocked by pre-commit", () => {
  const dir = newRepo("author-override");
  const r = git(dir, ["commit", "-q", "--allow-empty", "-m", "x", `--author=Other <${PERSONAL_EMAIL}>`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BLOCKED AUTHOR_EMAIL_MISMATCH/);
  observed.push(["commit --author", "pre-commit runs", "blocks personal author"]);
});

// ---------- cherry-pick / rebase (pre-commit NOT run on git 2.43) ----------

test("cherry-pick: pre-commit is NOT invoked on git 2.43 (observed); commit lands with personal committer", () => {
  const dir = newRepo("cherry");
  assert.equal(commitFile(dir, "base").status, 0);
  gitOk(dir, ["checkout", "-q", "-b", "feat"]);
  assert.equal(commitFile(dir, "feat-1").status, 0);
  const featSha = gitOk(dir, ["rev-parse", "HEAD"]);
  gitOk(dir, ["checkout", "-q", "main"]);
  gitOk(dir, ["config", "user.email", PERSONAL_EMAIL]);
  const r = git(dir, ["cherry-pick", featSha]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /git-identity:/, "pre-commit printed nothing, so it did not run");
  assert.equal(headCommitter(dir), PERSONAL_EMAIL);
  observed.push(["cherry-pick", "pre-commit NOT run", "personal committer commit created locally; pre-push is the backstop"]);
});

test("rebase: pre-commit is NOT invoked on git 2.43 (observed, merge backend); rebased commit gets personal committer", () => {
  const dir = newRepo("rebase");
  assert.equal(commitFile(dir, "base").status, 0);
  gitOk(dir, ["checkout", "-q", "-b", "topic"]);
  assert.equal(commitFile(dir, "topic-1").status, 0);
  gitOk(dir, ["checkout", "-q", "main"]);
  assert.equal(commitFile(dir, "main-2").status, 0);
  gitOk(dir, ["checkout", "-q", "topic"]);
  gitOk(dir, ["config", "user.email", PERSONAL_EMAIL]);
  const r = git(dir, ["rebase", "main"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /git-identity:/, "pre-commit printed nothing, so it did not run");
  assert.equal(headCommitter(dir), PERSONAL_EMAIL);
  observed.push(["rebase", "pre-commit NOT run", "rebased commits get personal committer; pre-push is the backstop"]);
});

// ---------- real git push (pre-push runs) ----------

test("push: matching commits push through the mapped alias remote (pre-push allows)", () => {
  const dir = newRepo("push-ok");
  assert.equal(commitFile(dir, "ok").status, 0);
  const r = git(dir, ["push", "-q", "origin", "main"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(bareRefs(dir), /refs\/heads\/main/);
  observed.push(["git push", "pre-push runs", "allowed when all pushed commits match"]);
});

test("push: a personal-committer commit on main is blocked by pre-push; bare repo gets nothing", () => {
  const dir = newRepo("push-bad", PERSONAL_EMAIL);
  // pre-commit would block this commit. Create it with hooks off (empty hooks dir) so the
  // commit exists and the pre-push backstop is what is tested.
  gitOk(dir, ["config", "core.hooksPath", "/dev/null"]);
  assert.equal(commitFile(dir, "personal-no-precommit").status, 0);
  gitOk(dir, ["config", "core.hooksPath", HOOKS_DIR]);
  const r = git(dir, ["push", "origin", "main"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /BLOCKED COMMITTER_EMAIL_MISMATCH/);
  assert.equal(bareRefs(dir).includes("refs/heads/main"), false, "bare repo unchanged by blocked push");
  observed.push(["git push", "pre-push runs", "blocks personal-committer commit (backstop for cherry-pick/rebase)"]);
});

test("push: unmapped remote is blocked by pre-push (fail-closed)", () => {
  const dir = newRepo("push-unmapped");
  assert.equal(commitFile(dir, "ok").status, 0);
  gitOk(dir, ["remote", "add", "other", UNMAPPED_REMOTE]);
  const r = git(dir, ["push", "other", "main"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /BLOCKED UNMAPPED_REMOTE/);
  observed.push(["git push (unmapped remote)", "pre-push runs", "blocked fail-closed"]);
});

test("push --no-verify: bypass succeeds (documented NOT covered; not a security boundary)", () => {
  const dir = newRepo("push-no-verify", PERSONAL_EMAIL);
  gitOk(dir, ["config", "core.hooksPath", "/dev/null"]);
  assert.equal(commitFile(dir, "personal").status, 0);
  gitOk(dir, ["config", "core.hooksPath", HOOKS_DIR]);
  const r = git(dir, ["push", "--no-verify", "-q", "origin", "main"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(bareRefs(dir), /refs\/heads\/main/);
  observed.push(["git push --no-verify", "pre-push SKIPPED", "push lands; this is the known bypass"]);
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

console.log("Observed hook paths (git 2.43, this suite):");
for (const [path_, ran, note] of observed) {
  console.log(`  ${path_.padEnd(28)} ${ran.padEnd(22)} ${note}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
