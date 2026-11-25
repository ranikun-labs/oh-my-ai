#!/usr/bin/env node
// Deterministic fixtures for the git identity guard. No network: remotes are
// URLs passed to the CLI, never contacted. HOME, XDG and the global gitconfig are
// temp paths, so the developer's real git/gh/ssh state is never read or written.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateBinding,
  evaluateCommit,
  loadConfig,
  normalizeRemote,
  resolveRule,
  validateConfig,
} from "./lib/git-identity-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "git-identity-guard.mjs");
const WRAPPER_PRE_COMMIT = path.join(ROOT, "hooks", "git-identity", "pre-commit");
const WRAPPER_PRE_PUSH = path.join(ROOT, "hooks", "git-identity", "pre-push");
const EXAMPLE = path.join(ROOT, "profiles", "example", "git-identity.json.example");
const ZERO = "0".repeat(40);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-identity-test-"));
const home = path.join(tmp, "home");
const xdg = path.join(tmp, "xdg");
const globalGitconfig = path.join(tmp, "gitconfig-global");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(xdg, { recursive: true });
fs.writeFileSync(globalGitconfig, "");

const WORK_EMAIL = "work@example.invalid";
const OLD_WORK_EMAIL = "old-work@example.invalid";
const PERSONAL_EMAIL = "personal@example.invalid";
const EXACT_EMAIL = "exact@example.invalid";

const baseConfig = () => ({
  schema_version: 1,
  rules: [
    {
      match: "github.com/acme-work/*",
      author_email: WORK_EMAIL,
      author_name: "Work Example",
      github_user: "work-example",
      ssh_host_alias: "github-work",
      preserve_author_emails: [OLD_WORK_EMAIL],
    },
    {
      match: "github.com/acme-work/special-repo",
      author_email: EXACT_EMAIL,
      author_name: "Exact Example",
      github_user: "work-example",
    },
    {
      match: "github.com/personal-example/*",
      author_email: PERSONAL_EMAIL,
      author_name: "Personal Example",
      github_user: "personal-example",
      ssh_host_alias: "github-personal",
    },
  ],
});

let counter = 0;
function writeConfig(value, raw) {
  counter += 1;
  const file = path.join(tmp, `config-${counter}.json`);
  fs.writeFileSync(file, raw ?? JSON.stringify(value));
  return file;
}

function envFor(configPath, extra = {}) {
  return {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_GLOBAL: globalGitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    OH_MY_AI_GIT_IDENTITY_CONFIG: configPath,
    ...extra,
  };
}

function runCli(args, { cwd, env, input = "" }) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd, args, env) {
  return execFileSync("git", args, { cwd, env: env ?? envFor(path.join(tmp, "unused.json")), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");
}

let repoCounter = 0;
function makeRepo({ origin, userEmail = WORK_EMAIL, userName = "Work Example" } = {}) {
  repoCounter += 1;
  const dir = path.join(tmp, `repo-${repoCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", userName]);
  git(dir, ["config", "user.email", userEmail]);
  if (origin) git(dir, ["remote", "add", "origin", origin]);
  return dir;
}

function commit(dir, { authorEmail, committerEmail, message = "change" }) {
  const env = {
    ...envFor(path.join(tmp, "unused.json")),
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: "Test Committer",
    GIT_COMMITTER_EMAIL: committerEmail,
  };
  git(dir, ["commit", "-q", "--allow-empty", "--no-verify", "-m", message], env);
  return git(dir, ["rev-parse", "HEAD"]);
}

function pushLine(localSha, remoteSha = ZERO, ref = "refs/heads/main") {
  return `${ref} ${localSha} ${ref} ${remoteSha}\n`;
}

function configSnapshot(dir, env) {
  return git(dir, ["config", "--list", "--show-origin"], env);
}

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

// ---------- policy library ----------

test("normalizeRemote handles https, scp, ssh:// and aliases, and strips credentials", () => {
  assert.deepEqual(normalizeRemote("https://github.com/Acme-Work/Repo.git"), { host: "github.com", owner: "acme-work", repo: "repo", via: "https" });
  const withCreds = normalizeRemote("https://user:s3cret@github.com/acme-work/repo/");
  assert.deepEqual(withCreds, { host: "github.com", owner: "acme-work", repo: "repo", via: "https" });
  assert.ok(!JSON.stringify(withCreds).includes("s3cret"));
  assert.deepEqual(normalizeRemote("git@github.com:acme-work/repo.git"), { host: "github.com", owner: "acme-work", repo: "repo", via: "ssh" });
  assert.deepEqual(normalizeRemote("ssh://git@github.com:22/acme-work/repo.git"), { host: "github.com", owner: "acme-work", repo: "repo", via: "ssh" });
  assert.deepEqual(normalizeRemote("git@github-work:acme-work/repo.git"), { host: "github-work", owner: "acme-work", repo: "repo", via: "ssh" });
  assert.equal(normalizeRemote("/tmp/some/repo.git"), null);
  assert.equal(normalizeRemote("file:///x/y/z"), null);
  assert.equal(normalizeRemote("https://github.com/acme-work"), null);
  assert.equal(normalizeRemote("https://github.com/a/b/c"), null);
  assert.equal(normalizeRemote(""), null);
});

test("resolveRule: exact repo beats owner/*, alias maps to its host, alias never falls through", () => {
  const { config } = validateConfig(baseConfig());
  assert.equal(resolveRule("https://github.com/acme-work/special-repo.git", config).rule.match, "github.com/acme-work/special-repo");
  assert.equal(resolveRule("https://github.com/acme-work/other.git", config).rule.match, "github.com/acme-work/*");
  const viaAlias = resolveRule("git@github-work:acme-work/other.git", config);
  assert.equal(viaAlias.rule.match, "github.com/acme-work/*");
  assert.equal(viaAlias.viaAlias, true);
  assert.equal(viaAlias.canonicalHost, "github.com");
  // The personal alias must not map an acme-work repo onto the work rule or vice versa.
  assert.equal(resolveRule("git@github-personal:acme-work/x.git", config).status, "UNMAPPED");
  assert.equal(resolveRule("https://gitlab.example.invalid/acme-work/x.git", config).status, "UNMAPPED");
  assert.equal(resolveRule("https://github.com/unknown-org/x.git", config).reason, "NO_RULE");
});

test("binding: alias or matching credential.username verifies config; anything else is UNVERIFIED", () => {
  const { config } = validateConfig(baseConfig());
  assert.equal(evaluateBinding(resolveRule("git@github-work:acme-work/x.git", config), null).status, "VERIFIED_CONFIG");
  assert.equal(evaluateBinding(resolveRule("https://github.com/acme-work/x.git", config), "Work-Example").status, "VERIFIED_CONFIG");
  assert.equal(evaluateBinding(resolveRule("https://github.com/acme-work/x.git", config), "personal-example").status, "UNVERIFIED_BINDING");
  assert.equal(evaluateBinding(resolveRule("https://github.com/acme-work/x.git", config), null).status, "UNVERIFIED_BINDING");
});

test("evaluateCommit: committer must be rule email; author may be rule or preserved email", () => {
  const { config } = validateConfig(baseConfig());
  const rule = config.rules[0];
  const ok = (a, c) => evaluateCommit({ author: { email: a }, committer: { email: c }, rule }).code;
  assert.equal(ok(WORK_EMAIL, WORK_EMAIL), "OK");
  assert.equal(ok(OLD_WORK_EMAIL, WORK_EMAIL), "OK");
  assert.equal(ok(PERSONAL_EMAIL, WORK_EMAIL), "AUTHOR_EMAIL_MISMATCH");
  assert.equal(ok(WORK_EMAIL, PERSONAL_EMAIL), "COMMITTER_EMAIL_MISMATCH");
  assert.equal(ok("", WORK_EMAIL), "IDENTITY_MISSING");
});

test("config validation fails closed with stable codes", () => {
  const missing = loadConfig(path.join(tmp, "does-not-exist.json"));
  assert.equal(missing.code, "CONFIG_MISSING");
  assert.equal(loadConfig(writeConfig(null, "{not json")).code, "CONFIG_INVALID_JSON");
  assert.equal(validateConfig({ ...baseConfig(), schema_version: 2 }).code, "CONFIG_SCHEMA_INVALID");
  assert.equal(validateConfig({ ...baseConfig(), extra: true }).code, "CONFIG_SCHEMA_INVALID");
  const unknownKey = baseConfig();
  unknownKey.rules[0].surprise = 1;
  assert.equal(validateConfig(unknownKey).code, "CONFIG_SCHEMA_INVALID");
  const duplicate = baseConfig();
  duplicate.rules.push({ ...duplicate.rules[0], match: "GitHub.com/ACME-WORK/*" });
  assert.equal(validateConfig(duplicate).code, "CONFIG_SCHEMA_INVALID");
  const badEmail = baseConfig();
  badEmail.rules[0].author_email = "not-an-email";
  assert.equal(validateConfig(badEmail).code, "CONFIG_SCHEMA_INVALID");
  const aliasIsHost = baseConfig();
  aliasIsHost.rules[0].ssh_host_alias = "github.com";
  assert.equal(validateConfig(aliasIsHost).code, "CONFIG_SCHEMA_INVALID");
  const aliasTwoHosts = baseConfig();
  aliasTwoHosts.rules.push({ match: "gitlab.example.invalid/b/*", author_email: WORK_EMAIL, author_name: "x", github_user: "x", ssh_host_alias: "github-work" });
  assert.equal(validateConfig(aliasTwoHosts).code, "CONFIG_SCHEMA_INVALID");
});

test("example mapping file is valid once placeholders are filled, and is rejected while unfilled", () => {
  assert.equal(loadConfig(EXAMPLE).code, "CONFIG_SCHEMA_INVALID");
  const filled = fs.readFileSync(EXAMPLE, "utf8").replace(/<([^>]+)>/g, (_, name) => {
    if (name.includes("email")) return `${name.replace(/[^a-z]/g, "")}@example.invalid`;
    return `example-${name.replace(/[^a-z]/g, "")}`;
  });
  const loaded = loadConfig(writeConfig(null, filled));
  assert.equal(loaded.ok, true, loaded.detail);
});

// ---------- CLI: pre-commit ----------

test("pre-commit: unmapped remote warns and exits 0", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "https://example.invalid/some/repo.git" });
  const run = runCli(["pre-commit"], { cwd: repo, env: envFor(configPath) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /WARN UNMAPPED_REMOTE/);
});

test("pre-commit: mapped remote with matching identity passes", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "https://github.com/acme-work/repo.git", userEmail: WORK_EMAIL });
  const run = runCli(["pre-commit"], { cwd: repo, env: envFor(configPath) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /OK/);
});

test("pre-commit: mapped remote with personal identity is blocked", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "https://github.com/acme-work/repo.git", userEmail: PERSONAL_EMAIL, userName: "Personal Example" });
  const run = runCli(["pre-commit"], { cwd: repo, env: envFor(configPath) });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /BLOCKED COMMITTER_EMAIL_MISMATCH/);
});

test("pre-commit: invalid config fails closed", () => {
  const configPath = writeConfig(null, "{");
  const repo = makeRepo({ origin: "https://github.com/acme-work/repo.git" });
  const run = runCli(["pre-commit"], { cwd: repo, env: envFor(configPath) });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /BLOCKED CONFIG_INVALID_JSON/);
});

test("pre-commit wrapper (symlinked into .git/hooks) blocks --author override and allows preserved author", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "https://github.com/acme-work/repo.git", userEmail: WORK_EMAIL });
  const hookDir = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.symlinkSync(WRAPPER_PRE_COMMIT, path.join(hookDir, "pre-commit"));
  const env = envFor(configPath);
  const preserved = spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "cherry", `--author=Old <${OLD_WORK_EMAIL}>`], { cwd: repo, env, encoding: "utf8" });
  assert.equal(preserved.status, 0, preserved.stderr);
  const override = spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "bad", `--author=Other <${PERSONAL_EMAIL}>`], { cwd: repo, env, encoding: "utf8" });
  assert.notEqual(override.status, 0);
  assert.match(override.stderr, /AUTHOR_EMAIL_MISMATCH/);
});

// ---------- CLI: pre-push ----------

test("pre-push: unmapped remote is blocked (fail-closed)", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "https://example.invalid/some/repo.git" });
  const sha = commit(repo, { authorEmail: WORK_EMAIL, committerEmail: WORK_EMAIL });
  const run = runCli(["pre-push", "origin", "https://example.invalid/some/repo.git"], { cwd: repo, env: envFor(configPath), input: pushLine(sha) });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /BLOCKED UNMAPPED_REMOTE/);
});

test("pre-push: committer mismatch is blocked when binding is verified", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "https://github.com/acme-work/repo.git" });
  git(repo, ["config", "credential.https://github.com.username", "work-example"]);
  const sha = commit(repo, { authorEmail: WORK_EMAIL, committerEmail: PERSONAL_EMAIL });
  const run = runCli(["pre-push", "origin", "https://github.com/acme-work/repo.git"], { cwd: repo, env: envFor(configPath), input: pushLine(sha) });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /COMMITTER_EMAIL_MISMATCH/);
});

test("pre-push: preserved author (cherry-pick) is allowed", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  const sha = commit(repo, { authorEmail: OLD_WORK_EMAIL, committerEmail: WORK_EMAIL });
  const run = runCli(["pre-push", "origin", "git@github-work:acme-work/repo.git"], { cwd: repo, env: envFor(configPath), input: pushLine(sha) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /OK/);
});

test("pre-push: unverified binding blocks, and the explicit override allows with a stderr notice", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "https://github.com/acme-work/repo.git" });
  const sha = commit(repo, { authorEmail: WORK_EMAIL, committerEmail: WORK_EMAIL });
  const url = "https://github.com/acme-work/repo.git";
  const blocked = runCli(["pre-push", "origin", url], { cwd: repo, env: envFor(configPath), input: pushLine(sha) });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /BLOCKED UNVERIFIED_BINDING/);
  const overridden = runCli(["pre-push", "origin", url], {
    cwd: repo,
    env: envFor(configPath, { OH_MY_AI_GIT_IDENTITY_ALLOW_UNVERIFIED_BINDING: "1" }),
    input: pushLine(sha),
  });
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.match(overridden.stderr, /OVERRIDE UNVERIFIED_BINDING/);
});

test("pre-push: alias remote verifies binding without credential config", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  const sha = commit(repo, { authorEmail: WORK_EMAIL, committerEmail: WORK_EMAIL });
  const run = runCli(["pre-push", "origin", "git@github-work:acme-work/repo.git"], { cwd: repo, env: envFor(configPath), input: pushLine(sha) });
  assert.equal(run.status, 0, run.stderr);
});

test("pre-push: new branch (zero remote sha) checks the whole reachable range", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  commit(repo, { authorEmail: WORK_EMAIL, committerEmail: WORK_EMAIL, message: "good" });
  const bad = commit(repo, { authorEmail: WORK_EMAIL, committerEmail: PERSONAL_EMAIL, message: "bad" });
  const run = runCli(["pre-push", "origin", "git@github-work:acme-work/repo.git"], { cwd: repo, env: envFor(configPath), input: pushLine(bad, ZERO) });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /COMMITTER_EMAIL_MISMATCH/);
});

test("pre-push: commits already on a remote-tracking ref are not re-checked", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  const bad = commit(repo, { authorEmail: WORK_EMAIL, committerEmail: PERSONAL_EMAIL, message: "already on remote" });
  git(repo, ["update-ref", "refs/remotes/origin/main", bad]);
  const good = commit(repo, { authorEmail: WORK_EMAIL, committerEmail: WORK_EMAIL, message: "new" });
  const run = runCli(["pre-push", "origin", "git@github-work:acme-work/repo.git"], { cwd: repo, env: envFor(configPath), input: pushLine(good, bad) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /checked 1 commit/);
});

test("pre-push: deleting a remote ref (zero local sha) is ignored", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  const remoteSha = commit(repo, { authorEmail: PERSONAL_EMAIL, committerEmail: PERSONAL_EMAIL, message: "old" });
  const run = runCli(["pre-push", "origin", "git@github-work:acme-work/repo.git"], {
    cwd: repo,
    env: envFor(configPath),
    input: `(delete) ${ZERO} refs/heads/old ${remoteSha}\n`,
  });
  assert.equal(run.status, 0, run.stderr);
});

// ---------- doctor ----------

test("doctor never mutates git config and does not print credentials", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "https://user:s3cret@github.com/acme-work/repo.git" });
  const env = envFor(configPath);
  const before = configSnapshot(repo, env);
  const run = runCli(["doctor"], { cwd: repo, env });
  const after = configSnapshot(repo, env);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(after, before);
  assert.match(run.stdout, /Rule: github\.com\/acme-work\/\*/);
  assert.match(run.stdout, /Push binding: UNVERIFIED_BINDING/);
  assert.match(run.stdout, /Guard: INACTIVE/);
  assert.match(run.stdout, /not proof of authentication/);
  assert.ok(!run.stdout.includes("s3cret"));
});

test("doctor reports Guard ACTIVE only when both wrappers are installed and config is valid", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "git@github-work:acme-work/repo.git" });
  const hookDir = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.symlinkSync(WRAPPER_PRE_COMMIT, path.join(hookDir, "pre-commit"));
  fs.symlinkSync(WRAPPER_PRE_PUSH, path.join(hookDir, "pre-push"));
  const run = runCli(["doctor"], { cwd: repo, env: envFor(configPath) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Hook pre-push: ACTIVE/);
  assert.match(run.stdout, /Push binding: VERIFIED_CONFIG \(basis: ssh_host_alias\)/);
  assert.match(run.stdout, /Guard: ACTIVE/);
});

test("doctor with core.hooksPath set reads the configured directory and changes nothing", () => {
  const configPath = writeConfig(baseConfig());
  const repo = makeRepo({ origin: "https://github.com/acme-work/repo.git" });
  git(repo, ["config", "core.hooksPath", "custom-hooks"]);
  const env = envFor(configPath);
  const before = configSnapshot(repo, env);
  const run = runCli(["doctor"], { cwd: repo, env });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /core\.hooksPath: custom-hooks/);
  assert.equal(configSnapshot(repo, env), before);
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
