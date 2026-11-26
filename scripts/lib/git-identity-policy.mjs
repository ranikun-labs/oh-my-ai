// Git identity policy: pure functions only. Nothing in this module writes files,
// runs git, or touches the network. The CLI (scripts/git-identity-guard.mjs) does I/O.
//
// This is a mistake blocker for mixing company and personal GitHub identities.
// It is not a bypass-proof control and does not prove which account authenticated.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const CONFIG_ENV = "OH_MY_AI_GIT_IDENTITY_CONFIG";
export const REMOTE_ENV = "OH_MY_AI_GIT_IDENTITY_REMOTE";
export const ALLOW_UNVERIFIED_ENV = "OH_MY_AI_GIT_IDENTITY_ALLOW_UNVERIFIED_BINDING";

const TOP_KEYS = new Set(["schema_version", "rules", "allow_env_overrides"]);
const RULE_KEYS = new Set([
  "match",
  "author_email",
  "author_name",
  "github_user",
  "ssh_host_alias",
  "preserve_author_emails",
]);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const HOST_RE = /^[a-z0-9.-]+$/;
const SEGMENT_RE = /^[a-z0-9._-]+$/;
const ALIAS_RE = /^[A-Za-z0-9._-]+$/;
const ZERO_SHA_RE = /^0+$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
const normalizeEmail = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

export function isZeroSha(sha) {
  return typeof sha === "string" && ZERO_SHA_RE.test(sha);
}

// $XDG_CONFIG_HOME (only when absolute), else ~/.config. Ignores env overrides on purpose:
// see loadEffectiveMapping.
export function configBase(env = process.env) {
  const home = nonEmpty(env.HOME) ? env.HOME : os.homedir();
  const xdg = env.XDG_CONFIG_HOME;
  return nonEmpty(xdg) && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
}

export function defaultConfigPath(env = process.env) {
  return path.join(configBase(env), "oh-my-ai", "git-identity.json");
}

// Env overrides (OH_MY_AI_GIT_IDENTITY_CONFIG, OH_MY_AI_GIT_IDENTITY_REMOTE) are a
// bypass channel for an AI agent that can set env vars. So they are honored only when the
// mapping file at the default location says "allow_env_overrides": true (default false).
// Otherwise the env value is ignored and reported as IGNORED.
// Returns the loadConfig result plus { configPath, envOverride, allowEnvOverrides }.
export function loadEffectiveMapping(env = process.env) {
  const defaultPath = defaultConfigPath(env);
  const base = loadConfig(defaultPath);
  const allowEnvOverrides = base.ok && base.config.allow_env_overrides === true;
  const requested = nonEmpty(env[CONFIG_ENV]) ? path.resolve(env[CONFIG_ENV]) : null;
  if (!requested) {
    return { ...base, configPath: defaultPath, envOverride: "NONE", allowEnvOverrides };
  }
  if (allowEnvOverrides) {
    return { ...loadConfig(requested), configPath: requested, envOverride: "APPLIED", allowEnvOverrides };
  }
  return { ...base, configPath: defaultPath, envOverride: "IGNORED", ignoredPath: requested, allowEnvOverrides };
}

// Remote name used by pre-commit. The env value counts only when the mapping allows overrides.
export function effectiveRemoteName(env, mapping) {
  const requested = nonEmpty(env[REMOTE_ENV]) ? env[REMOTE_ENV].trim() : null;
  if (requested && mapping.allowEnvOverrides) return requested;
  return "origin";
}

function fail(code, detail) {
  return { ok: false, code, detail };
}

// "host/owner/*" or "host/owner/repo". Lowercased; no port, no credentials, no .git suffix.
export function parseMatch(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().toLowerCase().split("/");
  if (parts.length !== 3) return null;
  const [host, owner, repo] = parts;
  if (!HOST_RE.test(host) || !SEGMENT_RE.test(owner)) return null;
  if (repo !== "*" && (!SEGMENT_RE.test(repo) || repo.endsWith(".git"))) return null;
  if (owner === "." || owner === "..") return null;
  return { host, owner, repo: repo === "*" ? null : repo, key: `${host}/${owner}/${repo}` };
}

// Validates and normalizes a parsed mapping document. Errors carry codes and field
// paths only; the values themselves are not echoed.
export function validateConfig(parsed) {
  if (!isObject(parsed)) {
    return fail("CONFIG_SCHEMA_INVALID", "root must be an object");
  }
  for (const key of Object.keys(parsed)) {
    if (!TOP_KEYS.has(key)) {
      return fail("CONFIG_SCHEMA_INVALID", `unknown top-level key: ${key}`);
    }
  }
  if (parsed.schema_version !== SCHEMA_VERSION) {
    return fail("CONFIG_SCHEMA_INVALID", "schema_version must be 1");
  }
  if (!Array.isArray(parsed.rules)) {
    return fail("CONFIG_SCHEMA_INVALID", "rules must be an array");
  }
  if (parsed.allow_env_overrides !== undefined && typeof parsed.allow_env_overrides !== "boolean") {
    return fail("CONFIG_SCHEMA_INVALID", "allow_env_overrides must be a boolean");
  }

  const rules = [];
  const seen = new Set();
  for (const [index, raw] of parsed.rules.entries()) {
    const at = `rules[${index}]`;
    if (!isObject(raw)) {
      return fail("CONFIG_SCHEMA_INVALID", `${at} must be an object`);
    }
    for (const key of Object.keys(raw)) {
      if (!RULE_KEYS.has(key)) {
        return fail("CONFIG_SCHEMA_INVALID", `${at}: unknown key ${key}`);
      }
    }
    const match = parseMatch(raw.match);
    if (!match) {
      return fail("CONFIG_SCHEMA_INVALID", `${at}.match must be host/owner/repo or host/owner/*`);
    }
    if (seen.has(match.key)) {
      return fail("CONFIG_SCHEMA_INVALID", `${at}.match duplicates an earlier rule`);
    }
    seen.add(match.key);

    if (typeof raw.author_email !== "string" || !EMAIL_RE.test(raw.author_email)) {
      return fail("CONFIG_SCHEMA_INVALID", `${at}.author_email must be an email address`);
    }
    if (!nonEmpty(raw.author_name)) {
      return fail("CONFIG_SCHEMA_INVALID", `${at}.author_name must be a non-empty string`);
    }
    if (typeof raw.github_user !== "string" || !LOGIN_RE.test(raw.github_user)) {
      return fail("CONFIG_SCHEMA_INVALID", `${at}.github_user must be a GitHub login`);
    }
    let sshHostAlias = null;
    if (raw.ssh_host_alias !== undefined) {
      if (typeof raw.ssh_host_alias !== "string" || !ALIAS_RE.test(raw.ssh_host_alias)) {
        return fail("CONFIG_SCHEMA_INVALID", `${at}.ssh_host_alias must be a plain host alias`);
      }
      sshHostAlias = raw.ssh_host_alias.toLowerCase();
    }
    const preserve = raw.preserve_author_emails ?? [];
    if (!Array.isArray(preserve) || preserve.some((email) => typeof email !== "string" || !EMAIL_RE.test(email))) {
      return fail("CONFIG_SCHEMA_INVALID", `${at}.preserve_author_emails must be an array of email addresses`);
    }

    rules.push({
      match: match.key,
      host: match.host,
      owner: match.owner,
      repo: match.repo,
      author_email: normalizeEmail(raw.author_email),
      author_name: raw.author_name.trim(),
      github_user: raw.github_user,
      ssh_host_alias: sshHostAlias,
      preserve_author_emails: preserve.map(normalizeEmail),
    });
  }

  // An alias is a local SSH host name, so it cannot be a real host in the rules, and all
  // rules that share one alias must point at the same host (the alias identifies one account).
  const hosts = new Set(rules.map((rule) => rule.host));
  const aliasHost = new Map();
  for (const rule of rules) {
    if (!rule.ssh_host_alias) continue;
    if (hosts.has(rule.ssh_host_alias)) {
      return fail("CONFIG_SCHEMA_INVALID", "ssh_host_alias must not equal a rule host");
    }
    const previous = aliasHost.get(rule.ssh_host_alias);
    if (previous && previous !== rule.host) {
      return fail("CONFIG_SCHEMA_INVALID", "ssh_host_alias maps to two different hosts");
    }
    aliasHost.set(rule.ssh_host_alias, rule.host);
  }

  return {
    ok: true,
    config: { schema_version: SCHEMA_VERSION, allow_env_overrides: parsed.allow_env_overrides === true, rules },
  };
}

export function loadConfig(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fail("CONFIG_MISSING", "mapping file not found");
    }
    return fail("CONFIG_UNREADABLE", `read failed (${error?.code ?? "unknown"})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("CONFIG_INVALID_JSON", "mapping file is not valid JSON");
  }
  return validateConfig(parsed);
}

// Accepts https, http, ssh://, scp-like ([user@]host:path) and returns
// { host, owner, repo, via } with host/owner/repo lowercased and credentials, ports and
// .git removed. Returns null for anything else (local paths, file://, unknown schemes).
export function normalizeRemote(input) {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw === "") return null;

  let host;
  let pathname;
  let via;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:"].includes(url.protocol)) return null;
    host = url.hostname;
    pathname = url.pathname;
    via = url.protocol === "ssh:" ? "ssh" : "https";
  } else {
    // scp-like: [user@]host:owner/repo. A path starting with "/" is a local path, not scp.
    const match = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/.exec(raw);
    if (!match) return null;
    host = match[1];
    pathname = match[2];
    via = "ssh";
  }

  const segments = pathname
    .replace(/\/+$/, "")
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (segments.length !== 2) return null;
  const owner = segments[0].toLowerCase();
  const repo = segments[1].toLowerCase();
  const hostLower = host.toLowerCase();
  if (!HOST_RE.test(hostLower) || !SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo)) return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return { host: hostLower, owner, repo, via };
}

// Resolution order:
// 1. ssh remote whose host equals some rule's ssh_host_alias -> only those alias rules are
//    candidates, and the canonical host is the rule's host (viaAlias = true).
// 2. Otherwise the remote host must equal a rule's host.
// Among candidates, an exact host/owner/repo rule beats host/owner/* rule.
export function resolveRule(remoteUrl, config) {
  const remote = normalizeRemote(remoteUrl);
  if (!remote) {
    return { status: "UNMAPPED", reason: "REMOTE_UNPARSEABLE", remote: null, rule: null, canonicalHost: null, viaAlias: false };
  }

  const aliasRules = remote.via === "ssh" ? config.rules.filter((rule) => rule.ssh_host_alias === remote.host) : [];
  const viaAlias = aliasRules.length > 0;
  const pool = viaAlias ? aliasRules : config.rules.filter((rule) => rule.host === remote.host);
  const canonicalHost = viaAlias ? aliasRules[0].host : remote.host;

  const candidates = pool
    .filter((rule) => rule.owner === remote.owner && (rule.repo === null || rule.repo === remote.repo))
    .sort((a, b) => Number(b.repo !== null) - Number(a.repo !== null));
  const rule = candidates[0] ?? null;

  return {
    status: rule ? "MAPPED" : "UNMAPPED",
    reason: rule ? "RULE_MATCHED" : "NO_RULE",
    remote,
    rule,
    canonicalHost,
    viaAlias,
  };
}

// Binding is a configuration check, not proof of authentication.
// credentialUsername is read by the CLI from `credential.<url>.username`.
export function evaluateBinding(resolution, credentialUsername) {
  if (!resolution.rule) {
    return { status: "NOT_APPLICABLE", basis: "NO_RULE" };
  }
  if (resolution.viaAlias) {
    return { status: "VERIFIED_CONFIG", basis: "ssh_host_alias" };
  }
  if (nonEmpty(credentialUsername) && credentialUsername.trim().toLowerCase() === resolution.rule.github_user.toLowerCase()) {
    return { status: "VERIFIED_CONFIG", basis: "credential_username" };
  }
  return { status: "UNVERIFIED_BINDING", basis: credentialUsername ? "credential_username_mismatch" : "no_credential_username" };
}

// Parses `git var GIT_AUTHOR_IDENT` style output: "Name <email> 1700000000 +0900".
export function parseIdent(line) {
  const match = /^(.*?)\s*<([^>]*)>/.exec(String(line ?? ""));
  if (!match) return null;
  return { name: match[1].trim(), email: match[2].trim() };
}

// mode ("commit" | "push") only labels the result; the rule is the same for both.
// Preserved authors (cherry-pick / rebase) are accepted in both modes, because a
// pre-commit check that rejected them would make the exception unusable.
export function evaluateCommit({ author, committer, rule, mode = "commit" }) {
  const authorEmail = normalizeEmail(author?.email);
  const committerEmail = normalizeEmail(committer?.email);
  if (!authorEmail || !committerEmail) {
    return { ok: false, code: "IDENTITY_MISSING", mode };
  }
  if (committerEmail !== rule.author_email) {
    return { ok: false, code: "COMMITTER_EMAIL_MISMATCH", mode };
  }
  if (authorEmail !== rule.author_email && !rule.preserve_author_emails.includes(authorEmail)) {
    return { ok: false, code: "AUTHOR_EMAIL_MISMATCH", mode };
  }
  return { ok: true, code: "OK", mode };
}

export function sameLogin(a, b) {
  return nonEmpty(a) && nonEmpty(b) && a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---------- identity proof parsers (pure; the CLI does the I/O) ----------

// `ssh -T git@<host>` greeting: "Hi <login>! You've successfully authenticated...".
// Returns the login or null. A bare "Permission denied" line never matches.
export function parseSshGreeting(text) {
  const match = /^Hi ([A-Za-z0-9][A-Za-z0-9-]{0,38})! You've successfully authenticated/m.exec(String(text ?? ""));
  return match ? match[1] : null;
}

// `git credential fill` output (key=value lines). Returns { username, password } or null.
// The password is for in-process use only; callers must never print it.
export function parseCredentialFill(text) {
  const fields = {};
  for (const line of String(text ?? "").split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1);
  }
  if (!nonEmpty(fields.password)) return null;
  return { username: fields.username ?? null, password: fields.password };
}

// REST `GET /user` JSON body. Returns the login or null.
export function parseApiLogin(text) {
  try {
    const login = JSON.parse(String(text ?? "")).login;
    return typeof login === "string" && LOGIN_RE.test(login) ? login : null;
  } catch {
    return null;
  }
}

// `gh api user --jq .login` prints one login line.
export function parseGhLogin(text) {
  const line = String(text ?? "").trim();
  return LOGIN_RE.test(line) ? line : null;
}

// REST user endpoint for a git host. github.com has its own API host; other hosts
// (GitHub Enterprise Server) serve the API under /api/v3.
export function userApiUrl(host) {
  if (host === "github.com") return "https://api.github.com/user";
  return `https://${host}/api/v3/user`;
}

// PROVEN only when the observed login equals the rule's github_user. A different login is
// MISMATCH. Missing or unparseable evidence is UNPROVEN.
export function compareProvenLogin(observed, expected) {
  if (!nonEmpty(observed)) return { status: "UNPROVEN", reason: "NO_LOGIN_OBSERVED" };
  return sameLogin(observed, expected)
    ? { status: "PROVEN", reason: "LOGIN_MATCHES" }
    : { status: "MISMATCH", reason: "LOGIN_DIFFERS" };
}
