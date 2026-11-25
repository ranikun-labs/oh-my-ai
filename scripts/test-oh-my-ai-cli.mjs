#!/usr/bin/env node
// ohmyai / oh-my-ai 파사드 테스트.
// 모든 경로(HOME, XDG, CLAUDE/CODEX/AGENT/LOCAL_BIN, TMPDIR)는 임시 디렉터리 안이다.
// 원격은 로컬 bare 저장소이며 네트워크를 쓰지 않는다. 원본 레포는 읽기만 하고 복사본에서 작업한다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ohmyai-cli-test-"));
const results = [];

const GIT_ID = ["-c", "user.name=ohmyai-test", "-c", "user.email=ohmyai-test@example.invalid"];

function sandbox(name) {
  const base = path.join(root, name);
  const dirs = {
    base,
    home: path.join(base, "home"),
    cfg: path.join(base, "cfg"),
    claude: path.join(base, "home", ".claude"),
    codex: path.join(base, "home", ".codex"),
    agents: path.join(base, "home", ".agents"),
    bin: path.join(base, "home", ".local", "bin"),
    tmp: path.join(base, "tmp"),
    clone: path.join(base, "clone"),
    remote: path.join(base, "remote.git"),
  };
  for (const d of [dirs.home, dirs.tmp]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

function envFor(sb, extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: sb.home,
    TMPDIR: sb.tmp,
    XDG_CONFIG_HOME: sb.cfg,
    CLAUDE_DIR: sb.claude,
    CODEX_DIR: sb.codex,
    AGENT_DIR: sb.agents,
    LOCAL_BIN: sb.bin,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function cli(sb, args, extraEnv = {}, { cwd } = {}) {
  return spawnSync(process.execPath, [path.join(sb.clone, "scripts", "oh-my-ai.mjs"), ...args], {
    cwd: cwd ?? sb.clone,
    env: envFor(sb, extraEnv),
    encoding: "utf8",
  });
}

function git(cwd, args) {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function copyTree(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: src2 => {
      const rel = path.relative(src, src2);
      return !/^(\.git|node_modules|\.oh-my-ai|profiles\/local)(\/|$)/.test(rel);
    },
  });
}

// 복사본 + 로컬 bare 원격. 원격 master 에 초기 커밋이 있고 clone 은 그와 같다.
function makeFixture(name) {
  const sb = sandbox(name);
  copyTree(repoRoot, sb.clone);
  git(sb.clone, ["init", "-q", "-b", "master"]);
  git(sb.clone, ["add", "-A"]);
  git(sb.clone, ["commit", "-q", "-m", "fixture base"]);
  spawnSync("git", ["clone", "-q", "--bare", sb.clone, sb.remote], { encoding: "utf8" });
  git(sb.clone, ["remote", "add", "origin", sb.remote]);
  git(sb.clone, ["fetch", "-q", "origin"]);
  git(sb.clone, ["branch", "-q", "--set-upstream-to=origin/master", "master"]);
  return sb;
}

function pushPeerCommit(sb, file, text) {
  const peer = path.join(sb.base, `peer-${Math.random().toString(36).slice(2)}`);
  spawnSync("git", ["clone", "-q", sb.remote, peer], { encoding: "utf8" });
  fs.writeFileSync(path.join(peer, file), text);
  git(peer, ["add", file]);
  git(peer, ["commit", "-q", "-m", `peer ${file}`]);
  git(peer, ["push", "-q", "origin", "HEAD:master"]);
}

function snapshot(dir) {
  const out = [];
  const walk = d => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(`${p}|${e.isSymbolicLink() ? "link" : e.isDirectory() ? "dir" : "file"}`);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

// ---------------- tests ----------------

test("version: VERSION + git sha, clean then dirty", () => {
  const sb = makeFixture("version");
  for (const args of [["version"], ["--version"]]) {
    const r = cli(sb, args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ohmyai 1\.0\.0 \(git [0-9a-f]+\)\n$/);
  }
  fs.writeFileSync(path.join(sb.clone, "dirty.txt"), "x");
  const dirty = cli(sb, ["version"]);
  assert.match(dirty.stdout, /dirty/);
});

test("status --json: required fields, read-only, drift detection", () => {
  const sb = makeFixture("status");
  const before = fs.readFileSync(path.join(sb.clone, "CLAUDE.md"));
  fs.mkdirSync(sb.claude, { recursive: true });
  const r = cli(sb, ["status", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  for (const key of ["version", "source", "instructions", "execution_mode", "runtimes", "core_skills", "hooks", "entrypoints", "config", "checks", "summary"]) {
    assert.ok(key in s, `missing field ${key}`);
  }
  assert.equal(s.instructions.state, "clean");
  assert.equal(s.execution_mode.value, "patch-with-approval");
  assert.equal(s.config["update.policy"], "CHECK");
  assert.equal(s.config["context.inject"], "on");
  assert.deepEqual(s.config["context.preload"], []);
  assert.equal(s.core_skills.claude.total, 12);
  assert.ok(s.core_skills.claude.items.some(i => i.id === "batch-report" && i.state === "missing-source"));
  assert.equal(s.runtimes.claude.detected, true);
  assert.equal(s.runtimes.codex.detected, false);

  // drift: source 변경 후 생성물은 그대로여야 한다 (status는 쓰지 않는다)
  fs.appendFileSync(path.join(sb.clone, "instructions", "harness.md"), "\n<!-- drift fixture -->\n");
  const d = JSON.parse(cli(sb, ["status", "--json"]).stdout);
  assert.equal(d.instructions.state, "drift");
  assert.ok(d.instructions.files.includes("CLAUDE.md"));
  assert.deepEqual(fs.readFileSync(path.join(sb.clone, "CLAUDE.md")), before);

  const text = cli(sb, ["status"]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /checks\s+OK \d+ · WARN \d+ · FAIL \d+/);
  assert.match(text.stdout, /ohmyai doctor/);
});

test("config: set/get/list, validation, file mode 0600, atomic", () => {
  const sb = makeFixture("config");
  assert.equal(cli(sb, ["config", "set", "update.policy", "AUTO"]).status, 0);
  assert.equal(cli(sb, ["config", "get", "update.policy"]).stdout.trim(), '"AUTO"');
  assert.equal(cli(sb, ["config", "set", "context.inject", "off"]).status, 0);
  assert.equal(cli(sb, ["config", "set", "context.preload", "work-start,f1"]).status, 0);
  const list = JSON.parse(cli(sb, ["config", "list", "--json"]).stdout);
  assert.deepEqual(list, { "update.policy": "AUTO", "context.inject": "off", "context.preload": ["work-start", "f1"] });

  const file = path.join(sb.cfg, "oh-my-ai", "config.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n => n.endsWith(".tmp")), []);

  // invalid values and unknown keys are rejected, file is not changed
  const before = fs.readFileSync(file, "utf8");
  assert.equal(cli(sb, ["config", "set", "update.policy", "SOMETIMES"]).status, 2);
  assert.equal(cli(sb, ["config", "set", "context.inject", "maybe"]).status, 2);
  assert.equal(cli(sb, ["config", "set", "context.preload", "not-a-core-skill"]).status, 2);
  assert.equal(cli(sb, ["config", "set", "unknown.key", "x"]).status, 2);
  assert.equal(cli(sb, ["config", "set", "context.preload", "f1,f1"]).status, 2);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  // corrupt file: reported, never overwritten
  fs.writeFileSync(file, "{not json");
  const bad = cli(sb, ["config", "get", "update.policy"]);
  assert.equal(bad.status, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "{not json");
  fs.writeFileSync(file, JSON.stringify({ update: { policy: "CHECK", extra: 1 } }));
  assert.equal(cli(sb, ["config", "list"]).status, 1);
});

test("update: behind is reported; clean fast-forward applies", () => {
  const sb = makeFixture("update-behind");
  pushPeerCommit(sb, "peer-behind.txt", "x\n");
  const check = cli(sb, ["update"]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /ahead 0 · behind 1 · dirty no → behind/);
  assert.notEqual(git(sb.clone, ["rev-parse", "HEAD"]), git(sb.clone, ["rev-parse", "origin/master"]));

  const apply = cli(sb, ["update", "--apply"], { CODEX_DIR: sb.codex });
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  assert.equal(git(sb.clone, ["rev-parse", "HEAD"]), git(sb.clone, ["rev-parse", "origin/master"]));
  assert.ok(fs.existsSync(path.join(sb.clone, "peer-behind.txt")));
});

test("update: dirty refuses --apply and keeps HEAD", () => {
  const sb = makeFixture("update-dirty");
  pushPeerCommit(sb, "peer-dirty.txt", "x\n");
  fs.appendFileSync(path.join(sb.clone, "README.md"), "\nlocal edit\n");
  const check = cli(sb, ["update"]);
  assert.match(check.stdout, /dirty yes/);
  const head = git(sb.clone, ["rev-parse", "HEAD"]);
  const apply = cli(sb, ["update", "--apply"]);
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /dirty/);
  assert.equal(git(sb.clone, ["rev-parse", "HEAD"]), head);
});

test("update: diverged refuses --apply and keeps HEAD", () => {
  const sb = makeFixture("update-diverged");
  pushPeerCommit(sb, "peer-div.txt", "x\n");
  fs.writeFileSync(path.join(sb.clone, "local-div.txt"), "y\n");
  git(sb.clone, ["add", "local-div.txt"]);
  git(sb.clone, ["commit", "-q", "-m", "local"]);
  const check = cli(sb, ["update"]);
  assert.match(check.stdout, /ahead 1 · behind 1 · dirty no → diverged/);
  const head = git(sb.clone, ["rev-parse", "HEAD"]);
  const apply = cli(sb, ["update", "--apply"]);
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /diverged/);
  assert.equal(git(sb.clone, ["rev-parse", "HEAD"]), head);
});

test("update: unreachable remote fails without changes", () => {
  const sb = makeFixture("update-nofetch");
  git(sb.clone, ["remote", "set-url", "origin", path.join(sb.base, "missing.git")]);
  const r = cli(sb, ["update"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fetch failed/);
});

test("install: default is dry-run and changes nothing", () => {
  const sb = makeFixture("install-dry");
  const before = snapshot(sb.home);
  const r = cli(sb, ["install"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /dry-run/);
  assert.deepEqual(snapshot(sb.home), before);
});

test("install --apply: creates both ohmyai and oh-my-ai links, and a rerun keeps them", () => {
  const sb = makeFixture("install-apply");
  const first = cli(sb, ["install", "--apply"]);
  assert.match(first.stdout, /linked: ohmyai|ok: ohmyai/);
  for (const name of ["ohmyai", "oh-my-ai"]) {
    const p = path.join(sb.bin, name);
    assert.ok(fs.lstatSync(p).isSymbolicLink(), `${name} is not a symlink`);
    assert.equal(fs.realpathSync(p), fs.realpathSync(path.join(sb.clone, "scripts", "oh-my-ai.mjs")));
  }
  // 기존 사용자 파일은 덮어쓰지 않는다
  const userFile = path.join(sb.bin, "ohmyai");
  fs.rmSync(userFile);
  fs.writeFileSync(userFile, "user file\n");
  cli(sb, ["install", "--apply"]);
  assert.equal(fs.readFileSync(userFile, "utf8"), "user file\n");
});

test("doctor: delegates to setup.sh, prints fix hints for dangling links, strict fails", () => {
  const sb = makeFixture("doctor");
  fs.mkdirSync(sb.bin, { recursive: true });
  fs.symlinkSync(path.join(sb.base, "gone", "oh-my-ai.mjs"), path.join(sb.bin, "oh-my-ai"));
  const r = cli(sb, ["doctor"]);
  assert.match(r.stdout, /=== oh-my-ai doctor \(read-only\) ===/);
  assert.match(r.stdout, /=== how to fix ===/);
  assert.match(r.stdout, /dangling/);
  const strict = cli(sb, ["doctor", "--strict"]);
  assert.notEqual(strict.status, 0);
});

test("skills: tiers, provenance, explicit-only, exposure", () => {
  const sb = makeFixture("skills");
  const r = cli(sb, ["skills", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  const byId = Object.fromEntries(rows.map(x => [x.id, x]));
  assert.equal(byId["work-start"].tier, "core");
  assert.equal(byId["work-start"].explicit_only, true);
  assert.equal(byId["work-start"].provenance, "born-here");
  assert.equal(byId["senior"].exposure.claude, "absent");
  assert.equal(byId["batch-report"].exposure.claude, "missing-source");
  assert.equal(byId["golang-grpc"].tier, "library");
  const core = JSON.parse(cli(sb, ["skills", "--core", "--json"]).stdout);
  assert.ok(core.every(x => x.tier === "core"));
  const lib = JSON.parse(cli(sb, ["skills", "--library", "--json"]).stdout);
  assert.ok(lib.every(x => x.tier === "library"));
  assert.equal(cli(sb, ["skills", "--bogus"]).status, 2);
});

test("help and --help are identical and name ohmyai as primary", () => {
  const sb = makeFixture("help");
  const a = cli(sb, ["help"]);
  const b = cli(sb, ["--help"]);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
  assert.match(a.stdout, /usage: ohmyai/);
  assert.match(a.stdout, /oh-my-ai.*alias/);
});

test("internal subcommands stay compatible (smoke)", () => {
  const sb = makeFixture("internal");
  const hook = cli(sb, ["hook", "claude", "Unknown"]);
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, "");
  const ws = cli(sb, ["work-start"]);
  assert.equal(ws.status, 2);
  assert.match(ws.stderr, /^usage: oh-my-ai work-start -- <task>\n$/);
  const jt = cli(sb, ["jira-ticket"]);
  assert.equal(jt.status, 2);
  assert.match(jt.stderr, /^usage: oh-my-ai jira-ticket --json/);
  const ctx = cli(sb, ["context-checkpoint", "status", "--json"]);
  assert.doesNotThrow(() => JSON.parse(ctx.stdout));
  const unknown = cli(sb, ["no-such-command"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command: no-such-command/);
});

// ---------------- report ----------------

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`PASS ${r.name}`);
  else {
    failed += 1;
    console.log(`FAIL ${r.name}\n  ${r.error.message.split("\n").slice(0, 8).join("\n  ")}`);
  }
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`\noh-my-ai cli tests: ${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
