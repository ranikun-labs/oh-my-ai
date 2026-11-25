#!/usr/bin/env node
// Git identity guard CLI (opt-in). Mistake blocker, not a bypass-proof control.
//
//   doctor                          read-only report (no writes, no network)
//   pre-commit                      checks author/committer of the commit being created
//   pre-push <remote-name> <url>    checks commits about to be pushed (git pre-push protocol)
//
// Never calls `gh auth switch` and never writes git config.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CONFIG_ENV,
  evaluateBinding,
  evaluateCommit,
  isZeroSha,
  loadConfig,
  parseIdent,
  resolveConfigPath,
  resolveRule,
  sameLogin,
} from "./lib/git-identity-policy.mjs";

export const HOOK_MARKER = "oh-my-ai git-identity guard";
const ALLOW_UNVERIFIED_ENV = "OH_MY_AI_GIT_IDENTITY_ALLOW_UNVERIFIED_BINDING";
const REMOTE_ENV = "OH_MY_AI_GIT_IDENTITY_REMOTE";
const LIMITS =
  "Limits: config and binding checks are not proof of authentication. Not covered: --no-verify, core.hooksPath overrides, other clients, web UI, other machines (server-side rules only).";

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line = "") => process.stderr.write(`${line}\n`);

function git(args, cwd = process.cwd()) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

function gitTry(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function loadMapping(env) {
  const configPath = resolveConfigPath(env);
  const loaded = loadConfig(configPath);
  if (!loaded.ok) {
    return { ok: false, configPath, code: loaded.code, detail: loaded.detail };
  }
  return { ok: true, configPath, config: loaded.config };
}

function reportLoadFailure(mapping, sink) {
  sink(`git-identity: BLOCKED ${mapping.code}`);
  sink(`Config: ${mapping.configPath}`);
  sink(`Detail: ${mapping.detail}`);
  sink(`Set ${CONFIG_ENV} or create the mapping file (see profiles/example/git-identity.json.example).`);
}

function describeRemote(resolution) {
  if (!resolution.remote) return "UNPARSEABLE (URL not shown)";
  const { host, owner, repo } = resolution.remote;
  return `${host}/${owner}/${repo}`;
}

function credentialUsernameFor(resolution, cwd) {
  const { canonicalHost, remote } = resolution;
  const url = `https://${canonicalHost}/${remote.owner}/${remote.repo}`;
  return gitTry(["config", "--get-urlmatch", "credential.username", url], cwd) ?? null;
}

// ---------- doctor ----------

function hooksDirFor(toplevel) {
  const configured = gitTry(["config", "--get", "core.hooksPath"], toplevel);
  if (configured) {
    return { dir: path.resolve(toplevel, configured), configured };
  }
  const gitPath = gitTry(["rev-parse", "--git-path", "hooks"], toplevel);
  return { dir: path.resolve(toplevel, gitPath ?? ".git/hooks"), configured: null };
}

function hookState(dir, name) {
  const file = path.join(dir, name);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "MISSING";
  }
  return text.includes(HOOK_MARKER) ? "ACTIVE" : "FOREIGN_HOOK_NOT_GUARD";
}

function runDoctor(env) {
  const toplevel = gitTry(["rev-parse", "--show-toplevel"]);
  out("# Git identity guard doctor (read-only, no network, no writes)");
  if (!toplevel) {
    out("Repository: not inside a git repository");
    return 1;
  }
  const mapping = loadMapping(env);
  out(`Config: ${mapping.configPath}`);
  out(`Config status: ${mapping.ok ? "OK" : mapping.code}`);

  const hooks = hooksDirFor(toplevel);
  out(`Repository: ${toplevel}`);
  out(`core.hooksPath: ${hooks.configured ?? "unset"}`);
  const preCommit = hookState(hooks.dir, "pre-commit");
  const prePush = hookState(hooks.dir, "pre-push");
  out(`Hook pre-commit: ${preCommit}`);
  out(`Hook pre-push: ${prePush}`);

  const remoteNames = (gitTry(["remote"], toplevel) ?? "").split("\n").filter(Boolean);
  if (remoteNames.length === 0) {
    out("Remotes: none");
  }
  for (const name of remoteNames) {
    const url = gitTry(["remote", "get-url", name], toplevel) ?? "";
    out(`Remote ${name}:`);
    if (!mapping.ok) {
      out("  Rule: UNKNOWN (config not loaded)");
      continue;
    }
    const resolution = resolveRule(url, mapping.config);
    out(`  Endpoint: ${describeRemote(resolution)}`);
    if (!resolution.rule) {
      out("  Rule: UNMAPPED");
      continue;
    }
    const rule = resolution.rule;
    out(`  Rule: ${rule.match}`);
    const email = gitTry(["config", "--get", "user.email"], toplevel);
    const userName = gitTry(["config", "--get", "user.name"], toplevel);
    let identity = "NOT_SET";
    if (email) identity = email.trim().toLowerCase() === rule.author_email ? "MATCH" : "MISMATCH";
    out(`  Effective identity: ${identity} (user.email ${email ? "set" : "unset"}, user.name ${userName ? "set" : "unset"})`);
    const binding = evaluateBinding(resolution, credentialUsernameFor(resolution, toplevel));
    out(`  Push binding: ${binding.status} (basis: ${binding.basis})`);
  }

  const guardActive = mapping.ok && preCommit === "ACTIVE" && prePush === "ACTIVE";
  out(`Guard: ${guardActive ? "ACTIVE" : "INACTIVE"}`);
  out(LIMITS);
  return 0;
}

// ---------- pre-commit ----------

function runPreCommit(env) {
  const mapping = loadMapping(env);
  if (!mapping.ok) {
    reportLoadFailure(mapping, err);
    return 1;
  }

  const remoteName = nonEmptyOr(env[REMOTE_ENV], "origin");
  const url = gitTry(["remote", "get-url", remoteName]) ?? "";
  const resolution = resolveRule(url, mapping.config);
  if (!resolution.rule) {
    err(`git-identity: WARN UNMAPPED_REMOTE`);
    err(`Remote: ${remoteName} (${describeRemote(resolution)})`);
    err("Commit identity not checked. Add a rule to the mapping file to enable the check.");
    return 0;
  }

  const author = parseIdent(gitTry(["var", "GIT_AUTHOR_IDENT"]));
  const committer = parseIdent(gitTry(["var", "GIT_COMMITTER_IDENT"]));
  if (!author || !committer) {
    err("git-identity: BLOCKED IDENTITY_UNAVAILABLE");
    err("Could not read author/committer identity from git var. Set user.name and user.email.");
    return 1;
  }

  const verdict = evaluateCommit({ author, committer, rule: resolution.rule, mode: "commit" });
  if (verdict.ok) {
    out(`git-identity: OK (rule ${resolution.rule.match})`);
    return 0;
  }
  err(`git-identity: BLOCKED ${verdict.code}`);
  err(`Rule: ${resolution.rule.match}`);
  err(`Remote: ${describeRemote(resolution)}`);
  err(`Expected author_email and committer email: ${resolution.rule.author_email} (or a preserve_author_emails entry for the author)`);
  err("Fix with: git config user.email <rule email>, or amend the author explicitly if this is a cherry-pick/rebase.");
  return 1;
}

function nonEmptyOr(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

// ---------- pre-push ----------

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parsePushLines(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const fields = raw.trim().split(/\s+/);
    if (fields.length !== 4) return null;
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    lines.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return lines;
}

// Commits reachable from the pushed tip but not on any remote-tracking ref of this remote.
// Limitation: if remoteName is a URL (not a configured remote), no ref matches and every
// reachable commit is checked, which fails closed.
function commitsToCheck(localSha, remoteName, cwd) {
  const output = git(["rev-list", localSha, "--not", `--remotes=${remoteName}`], cwd);
  return output === "" ? [] : output.split("\n").filter(Boolean);
}

function commitIdentities(shas, cwd) {
  const identities = [];
  for (let index = 0; index < shas.length; index += 200) {
    const chunk = shas.slice(index, index + 200);
    const output = git(["log", "--no-walk=unsorted", "--format=%H%x1f%ae%x1f%ce", ...chunk], cwd);
    for (const line of output.split("\n").filter(Boolean)) {
      const [sha, authorEmail, committerEmail] = line.split("\x1f");
      identities.push({ sha, author: { email: authorEmail }, committer: { email: committerEmail } });
    }
  }
  return identities;
}

function runPrePush(args, env) {
  if (args.length < 2) {
    err("usage: git-identity-guard.mjs pre-push <remote-name> <remote-url>");
    return 2;
  }
  const [remoteName, remoteUrl] = args;
  const cwd = process.cwd();

  const mapping = loadMapping(env);
  if (!mapping.ok) {
    reportLoadFailure(mapping, err);
    return 1;
  }

  const resolution = resolveRule(remoteUrl, mapping.config);
  if (!resolution.rule) {
    err("git-identity: BLOCKED UNMAPPED_REMOTE");
    err(`Remote: ${remoteName} (${describeRemote(resolution)})`);
    err("Pushes to unmapped remotes are blocked (fail-closed). Add a rule to the mapping file.");
    return 1;
  }

  const binding = evaluateBinding(resolution, credentialUsernameFor(resolution, cwd));
  if (binding.status !== "VERIFIED_CONFIG") {
    if (env[ALLOW_UNVERIFIED_ENV] !== "1") {
      err("git-identity: BLOCKED UNVERIFIED_BINDING");
      err(`Rule: ${resolution.rule.match}`);
      err(`Remote: ${describeRemote(resolution)}`);
      err("Neither an ssh_host_alias nor credential.username matches the rule. Configuration cannot prove which account will authenticate.");
      err(`Human override: ${ALLOW_UNVERIFIED_ENV}=1 git push ... (this is printed here and is not a proof of identity).`);
      return 1;
    }
    err("git-identity: OVERRIDE UNVERIFIED_BINDING");
    err(`Rule: ${resolution.rule.match}`);
    err(`Accepted by ${ALLOW_UNVERIFIED_ENV}=1; binding was not verified.`);
  }

  const pushLines = parsePushLines(readStdin());
  if (pushLines === null) {
    err("git-identity: BLOCKED PROTOCOL_INVALID");
    err("pre-push stdin did not match '<local ref> <local sha> <remote ref> <remote sha>'.");
    return 1;
  }
  if (pushLines.length === 0) {
    out("git-identity: OK (no refs in pre-push input)");
    return 0;
  }

  const failures = [];
  let checked = 0;
  try {
    for (const line of pushLines) {
      // Deleting a remote ref pushes no commits.
      if (isZeroSha(line.localSha)) continue;
      const shas = commitsToCheck(line.localSha, remoteName, cwd);
      const identities = commitIdentities(shas, cwd);
      for (const commit of identities) {
        checked += 1;
        const verdict = evaluateCommit({ author: commit.author, committer: commit.committer, rule: resolution.rule, mode: "push" });
        if (!verdict.ok) failures.push({ sha: commit.sha.slice(0, 12), ref: line.localRef, code: verdict.code });
      }
    }
  } catch (error) {
    err("git-identity: BLOCKED GIT_ERROR");
    err(`Could not enumerate pushed commits (${error?.message?.split("\n")[0] ?? "unknown"}). Fail-closed.`);
    return 1;
  }

  if (failures.length > 0) {
    err(`git-identity: BLOCKED ${failures[0].code} (${failures.length} commit(s))`);
    err(`Rule: ${resolution.rule.match}`);
    for (const failure of failures.slice(0, 20)) {
      err(`  ${failure.sha} ${failure.ref} ${failure.code}`);
    }
    err(`Expected author and committer email: ${resolution.rule.author_email} (or preserve_author_emails for the author)`);
    return 1;
  }

  out(`git-identity: OK (rule ${resolution.rule.match}, checked ${checked} commit(s))`);
  return 0;
}

// ---------- entry ----------

function usage() {
  err("usage: git-identity-guard.mjs doctor | pre-commit | pre-push <remote-name> <remote-url>");
  return 2;
}

export function main(argv, env = process.env) {
  const [command, ...args] = argv;
  switch (command) {
    case "doctor":
      return runDoctor(env);
    case "pre-commit":
      return runPreCommit(env);
    case "pre-push":
      return runPrePush(args, env);
    default:
      return usage();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
