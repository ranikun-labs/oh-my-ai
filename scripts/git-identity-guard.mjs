#!/usr/bin/env node
// Git identity guard CLI (opt-in). Mistake blocker, not a bypass-proof control.
//
//   doctor                          read-only report (no writes, no network)
//   pre-commit                      checks author/committer of the commit being created
//   pre-push <remote-name> <url>    checks commits about to be pushed (git pre-push protocol)
//   gh-env [--remote <name>]        prints the GH_CONFIG_DIR prefix for the mapped account
//   prove [--remote <name>] [--no-gh]   opt-in network proof of the account (PROVEN|MISMATCH|UNPROVEN)
//
// Never calls `gh auth switch`, never runs `gh auth login`, never writes git config.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ALLOW_UNVERIFIED_ENV,
  CONFIG_ENV,
  REMOTE_ENV,
  compareProvenLogin,
  configBase,
  effectiveRemoteName,
  evaluateBinding,
  evaluateCommit,
  isZeroSha,
  loadEffectiveMapping,
  parseApiLogin,
  parseCredentialFill,
  parseGhLogin,
  parseIdent,
  parseSshGreeting,
  resolveRule,
  userApiUrl,
} from "./lib/git-identity-policy.mjs";

export const HOOK_MARKER = "oh-my-ai git-identity guard";
const LIMITS =
  "Limits: config and binding checks are not proof of authentication (use `prove` for that). Not covered: --no-verify, core.hooksPath overrides, other clients, web UI, other machines (server-side rules only).";
const NETWORK_TIMEOUT_MS = 15000;

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
  const mapping = loadEffectiveMapping(env);
  if (!mapping.ok) {
    return { ok: false, configPath: mapping.configPath, code: mapping.code, detail: mapping.detail, envOverride: mapping.envOverride };
  }
  return { ok: true, configPath: mapping.configPath, config: mapping.config, envOverride: mapping.envOverride, allowEnvOverrides: mapping.allowEnvOverrides };
}

function reportEnvOverride(mapping, sink) {
  if (mapping.envOverride === "IGNORED") {
    sink(`git-identity: NOTICE ${CONFIG_ENV} ignored (mapping file at ${mapping.configPath} does not set allow_env_overrides: true)`);
  } else if (mapping.envOverride === "APPLIED") {
    sink(`git-identity: NOTICE ${CONFIG_ENV} applied (allowed by allow_env_overrides in the default mapping file)`);
  }
}

function reportLoadFailure(mapping, sink) {
  sink(`git-identity: BLOCKED ${mapping.code}`);
  sink(`Config: ${mapping.configPath}`);
  sink(`Detail: ${mapping.detail}`);
  sink("Create the mapping file at that path (see profiles/example/git-identity.json.example).");
  if (mapping.envOverride === "IGNORED") {
    sink(`${CONFIG_ENV} is ignored unless the default mapping file sets "allow_env_overrides": true.`);
  }
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

// ---------- native hook state ----------

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

// Read-only. Used by doctor and by the runtime adapter (fail-closed checks for AI pushes).
export function nativeGuardState(dir = process.cwd()) {
  const toplevel = gitTry(["rev-parse", "--show-toplevel"], dir);
  if (!toplevel) {
    return { repo: null, preCommit: "NO_REPO", prePush: "NO_REPO", active: false, configured: null };
  }
  const hooks = hooksDirFor(toplevel);
  const preCommit = hookState(hooks.dir, "pre-commit");
  const prePush = hookState(hooks.dir, "pre-push");
  return { repo: toplevel, preCommit, prePush, active: preCommit === "ACTIVE" && prePush === "ACTIVE", configured: hooks.configured };
}

// ---------- doctor ----------

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
  out(`Env ${CONFIG_ENV}: ${mapping.envOverride === "NONE" ? "unset" : mapping.envOverride}`);
  out(`Env ${REMOTE_ENV}: ${env[REMOTE_ENV] ? (mapping.allowEnvOverrides ? "APPLIED" : "IGNORED") : "unset"}`);
  if (env[ALLOW_UNVERIFIED_ENV]) {
    out(`Env ${ALLOW_UNVERIFIED_ENV}: IGNORED (override needs an interactive /dev/tty confirmation)`);
  }

  const native = nativeGuardState(toplevel);
  out(`Repository: ${toplevel}`);
  out(`core.hooksPath: ${native.configured ?? "unset"}`);
  out(`Hook pre-commit: ${native.preCommit}`);
  out(`Hook pre-push: ${native.prePush}`);

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

  const guardActive = mapping.ok && native.active;
  out(`Guard: ${guardActive ? "ACTIVE" : "INACTIVE"}`);
  out(LIMITS);
  return 0;
}

// ---------- pre-commit ----------

function runPreCommit(env) {
  const mapping = loadMapping(env);
  reportEnvOverride(mapping, err);
  if (!mapping.ok) {
    reportLoadFailure(mapping, err);
    return 1;
  }

  const remoteName = effectiveRemoteName(env, mapping);
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

// ---------- pre-push ----------

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Human-only override. Reads the answer from /dev/tty, so a process without a controlling
// terminal (an AI agent's Bash tool, CI, a detached child) cannot answer. Returns null when
// there is no terminal.
export function confirmOnTty(question) {
  let fd;
  try {
    fd = fs.openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
  try {
    fs.writeSync(fd, question);
    let line = "";
    const buf = Buffer.alloc(1);
    while (line.length < 256) {
      const n = fs.readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString("utf8");
      if (ch === "\n") break;
      if (ch !== "\r") line += ch;
    }
    return line.trim();
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore close failure
    }
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
  reportEnvOverride(mapping, err);
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
    if (env[ALLOW_UNVERIFIED_ENV]) {
      err(`git-identity: NOTICE ${ALLOW_UNVERIFIED_ENV} ignored (env cannot confirm an override; a terminal prompt is required)`);
    }
    const question =
      `git-identity: UNVERIFIED_BINDING for rule ${resolution.rule.match} (remote ${describeRemote(resolution)}).\n` +
      `Type the rule match exactly to push anyway, or press Enter to abort: `;
    const answer = confirmOnTty(question);
    if (answer === null) {
      err("git-identity: BLOCKED UNVERIFIED_BINDING");
      err(`Rule: ${resolution.rule.match}`);
      err(`Remote: ${describeRemote(resolution)}`);
      err("Neither an ssh_host_alias nor credential.username matches the rule, and no terminal is available to confirm an override.");
      return 1;
    }
    if (answer !== resolution.rule.match) {
      err("git-identity: BLOCKED UNVERIFIED_BINDING (override not confirmed)");
      err(`Rule: ${resolution.rule.match}`);
      err(`Remote: ${describeRemote(resolution)}`);
      return 1;
    }
    err("git-identity: OVERRIDE UNVERIFIED_BINDING");
    err(`Rule: ${resolution.rule.match}`);
    err("Confirmed on the terminal. The binding was not verified; this is not a proof of identity.");
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

// ---------- gh-env ----------

// Per-account gh config directory. Never a global `gh auth switch`.
export function ghConfigDirFor(env, login) {
  return path.join(configBase(env), "oh-my-ai", "gh", login.toLowerCase());
}

function tokenEnvSet(env) {
  return ["GH_TOKEN", "GITHUB_TOKEN"].filter((name) => typeof env[name] === "string" && env[name].trim() !== "");
}

function remoteUrlFor(name, cwd) {
  return gitTry(["remote", "get-url", name], cwd) ?? "";
}

function parseRemoteFlag(args) {
  const index = args.indexOf("--remote");
  if (index === -1) return { remote: "origin", rest: args };
  const remote = args[index + 1];
  if (!remote) return { remote: null, rest: args };
  return { remote, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

function runGhEnv(args, env) {
  const parsed = parseRemoteFlag(args);
  if (!parsed.remote || parsed.rest.length > 0) {
    err("usage: git-identity-guard.mjs gh-env [--remote <name>]");
    return 2;
  }
  const mapping = loadMapping(env);
  reportEnvOverride(mapping, err);
  if (!mapping.ok) {
    reportLoadFailure(mapping, err);
    return 1;
  }
  const resolution = resolveRule(remoteUrlFor(parsed.remote), mapping.config);
  if (!resolution.rule) {
    err("git-identity: BLOCKED UNMAPPED_REMOTE (gh-env has no account for this remote)");
    return 1;
  }
  const set = tokenEnvSet(env);
  if (set.length > 0) {
    err(`git-identity: BLOCKED ${set.join("+")}_ENV_SET`);
    err("A token in the environment overrides GH_CONFIG_DIR. Unset it for this session, then retry.");
    return 1;
  }
  const dir = ghConfigDirFor(env, resolution.rule.github_user);
  if (!fs.existsSync(path.join(dir, "hosts.yml"))) {
    err("git-identity: BLOCKED GH_CONFIG_MISSING");
    err(`No gh config for ${resolution.rule.github_user} at ${dir}.`);
    err("A human sets it up once: GH_CONFIG_DIR=<that dir> gh auth login (run it yourself; the AI guard denies gh auth login).");
    return 1;
  }
  out(`GH_CONFIG_DIR=${dir}`);
  return 0;
}

// ---------- prove (opt-in, network) ----------

function runSshProbe(host, env) {
  const result = spawnSync(
    "ssh",
    ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `git@${host}`],
    { env, encoding: "utf8", timeout: NETWORK_TIMEOUT_MS },
  );
  if (result.error) return { ok: false, reason: "SSH_UNAVAILABLE" };
  return { ok: true, login: parseSshGreeting(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) };
}

async function runHttpsProbe(host) {
  const fill = spawnSync("git", ["credential", "fill"], {
    input: `protocol=https\nhost=${host}\n\n`,
    encoding: "utf8",
    timeout: NETWORK_TIMEOUT_MS,
  });
  const credential = parseCredentialFill(fill.stdout ?? "");
  if (!credential) return { ok: false, reason: "NO_CREDENTIAL" };
  let response;
  try {
    response = await fetch(userApiUrl(host), {
      headers: {
        Authorization: `Bearer ${credential.password}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "oh-my-ai-git-identity-guard",
      },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: `API_UNREACHABLE (${error?.name ?? "error"})` };
  }
  if (!response.ok) return { ok: false, reason: `API_HTTP_${response.status}` };
  return { ok: true, login: parseApiLogin(await response.text()) };
}

function runGhProbe(login, env) {
  const dir = ghConfigDirFor(env, login);
  if (!fs.existsSync(path.join(dir, "hosts.yml"))) return { ok: false, reason: "GH_CONFIG_MISSING" };
  const result = spawnSync("gh", ["api", "user", "--jq", ".login"], {
    env: { ...env, GH_CONFIG_DIR: dir },
    encoding: "utf8",
    timeout: NETWORK_TIMEOUT_MS,
  });
  if (result.error) return { ok: false, reason: "GH_UNAVAILABLE" };
  if (result.status !== 0) return { ok: false, reason: "GH_API_FAILED" };
  return { ok: true, login: parseGhLogin(result.stdout) };
}

async function runProve(args, env) {
  const parsed = parseRemoteFlag(args);
  const skipGh = parsed.rest.includes("--no-gh");
  const unknown = parsed.rest.filter((arg) => arg !== "--no-gh");
  if (!parsed.remote || unknown.length > 0) {
    err("usage: git-identity-guard.mjs prove [--remote <name>] [--no-gh]");
    return 2;
  }
  const mapping = loadMapping(env);
  reportEnvOverride(mapping, err);
  if (!mapping.ok) {
    reportLoadFailure(mapping, err);
    return 1;
  }
  const resolution = resolveRule(remoteUrlFor(parsed.remote), mapping.config);
  if (!resolution.rule) {
    err("git-identity: BLOCKED UNMAPPED_REMOTE (nothing to prove for this remote)");
    return 1;
  }
  const expected = resolution.rule.github_user;
  out(`# Identity proof (network, opt-in). Rule: ${resolution.rule.match} Expected login: ${expected}`);

  const channels = [];
  if (resolution.remote.via === "ssh") {
    const probe = runSshProbe(resolution.remote.host, env);
    channels.push({ name: "push(ssh)", probe });
  } else {
    const probe = await runHttpsProbe(resolution.remote.host);
    channels.push({ name: "push(https)", probe });
  }
  if (!skipGh) {
    channels.push({ name: "gh", probe: runGhProbe(expected, env) });
  }

  let allProven = true;
  for (const { name, probe } of channels) {
    if (!probe.ok) {
      allProven = false;
      out(`${name}: UNPROVEN (${probe.reason})`);
      continue;
    }
    const verdict = compareProvenLogin(probe.login, expected);
    if (verdict.status !== "PROVEN") allProven = false;
    const observed = verdict.status === "MISMATCH" ? ` observed login: ${probe.login}` : "";
    out(`${name}: ${verdict.status} (${verdict.reason})${observed}`);
  }
  out(`mcp: UNPROVEN (CLI_CANNOT_PROVE) -> Runtime must call the GitHub MCP get_me and compare its login with ${expected}.`);
  out(`Overall (CLI channels): ${allProven ? "PROVEN" : "NOT_PROVEN"}`);
  out("Proof covers the credentials available at this moment, not server-side rules or other clients.");
  return allProven ? 0 : 1;
}

// ---------- entry ----------

function usage() {
  err("usage: git-identity-guard.mjs doctor | pre-commit | pre-push <remote-name> <remote-url> | gh-env [--remote <name>] | prove [--remote <name>] [--no-gh]");
  return 2;
}

export async function main(argv, env = process.env) {
  const [command, ...args] = argv;
  switch (command) {
    case "doctor":
      return runDoctor(env);
    case "pre-commit":
      return runPreCommit(env);
    case "pre-push":
      return runPrePush(args, env);
    case "gh-env":
      return runGhEnv(args, env);
    case "prove":
      return runProve(args, env);
    default:
      return usage();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      err("git-identity: BLOCKED INTERNAL_ERROR (fail-closed)");
      process.exitCode = 1;
    },
  );
}
