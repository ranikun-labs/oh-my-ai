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
import { buildPreloadBlock, clipSummary, PRELOAD_BYTE_CAP, PRELOAD_SUMMARY_CHARS } from "./lib/oh-my-ai-context.mjs";
import { coreIdsOf, discoverSkills } from "./lib/skill-discovery.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_SKILLS = coreIdsOf(discoverSkills(repoRoot)).map(entry => entry.id);
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

// 훅 실행: stdin 을 넘기고 같은 임시 HOME/XDG 환경에서 실제 진입점을 돌린다.
function hookRun(sb, runtime, event, stdin = "", extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(sb.clone, "scripts", "oh-my-ai.mjs"), "hook", runtime, event], {
    cwd: sb.clone,
    env: envFor(sb, extraEnv),
    input: stdin,
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
  fs.mkdirSync(path.dirname(path.join(peer, file)), { recursive: true });
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
  // 기대값은 이 트리의 discovery 결과에서 계산한다 (특정 Skill의 존재/부재를 가정하지 않는다)
  const coreEntries = coreIdsOf(discoverSkills(sb.clone));
  assert.equal(s.core_skills.claude.total, coreEntries.length);
  for (const entry of coreEntries) {
    const item = s.core_skills.claude.items.find(i => i.id === entry.id);
    assert.equal(item.state === "missing-source", !entry.present, `${entry.id}: ${item.state}`);
  }
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
  const batchPresent = coreIdsOf(discoverSkills(sb.clone)).find(e => e.id === "batch-report").present;
  assert.equal(byId["batch-report"].exposure.claude, batchPresent ? "absent" : "missing-source");
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


test("context.inject=off: advisory hints and backlog skipped, Jira-first kept", () => {
  const sb = makeFixture("inject-off");
  fs.writeFileSync(path.join(sb.clone, "automation-backlog.md"), "BACKLOG-MARKER\n");
  const stdin = JSON.stringify({
    prompt: "이 기능 Jira 티켓 확인하고 구현해줘. 매번 같은 수동 작업이라 자동화하고 싶어",
    session_id: "s-inject",
  });
  const on = hookRun(sb, "claude", "UserPromptSubmit", stdin);
  assert.equal(on.status, 0, on.stderr);
  const onCtx = JSON.parse(on.stdout).hookSpecificOutput.additionalContext;
  assert.match(onCtx, /Toil signal/);
  assert.match(onCtx, /Skill routing candidates/);
  assert.match(onCtx, /Jira-first/);

  assert.equal(cli(sb, ["config", "set", "context.inject", "off"]).status, 0);
  const off = hookRun(sb, "claude", "UserPromptSubmit", stdin);
  assert.equal(off.status, 0, off.stderr);
  const offCtx = JSON.parse(off.stdout).hookSpecificOutput.additionalContext;
  assert.match(offCtx, /Jira-first/, "Jira-first hint must stay on");
  assert.doesNotMatch(offCtx, /Toil signal|Skill routing candidates|Project context signal/);

  const start = hookRun(sb, "claude", "SessionStart", "{}");
  assert.equal(start.status, 0);
  assert.doesNotMatch(start.stdout, /BACKLOG-MARKER/);

  assert.equal(cli(sb, ["config", "set", "context.inject", "on"]).status, 0);
  assert.match(hookRun(sb, "claude", "SessionStart", "{}").stdout, /BACKLOG-MARKER/);
});

test("context.preload: id and summary only, no per-line path, within the 2048-byte cap", () => {
  const sb = makeFixture("preload");
  const ids = ["work-start", "f1", "senior", "project-context", "handoff-prompt", "git-work-preflight",
    "execution-recovery", "dev-main-flow", "adaptive-goal-closure", "engineering-communication-ko", "batch-report"];
  assert.equal(cli(sb, ["config", "set", "context.preload", ids.join(",")]).status, 0);
  const r = hookRun(sb, "claude", "SessionStart", "{}");
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  const start = ctx.indexOf("[HARNESS:preload]");
  assert.ok(start >= 0, "preload block missing");
  const block = ctx.slice(start);
  assert.ok(Buffer.byteLength(block, "utf8") <= 2048, `preload is ${Buffer.byteLength(block, "utf8")} bytes`);
  assert.match(block, /^- work-start — .+$/m);
  const batchPresent = coreIdsOf(discoverSkills(sb.clone)).find(e => e.id === "batch-report").present;
  if (batchPresent) assert.match(block, /^- batch-report — .+$/m);
  else assert.match(block, /^- batch-report — \(missing source; not preloaded\)$/m);
  assert.doesNotMatch(block, /skills\//, "per-line paths must not be injected");
  assert.doesNotMatch(block, /^## /m, "full skill body must not be injected");
  assert.doesNotMatch(block, /^---$/m, "frontmatter must not be injected");
});

test("context.preload: no skill dropped when the cap allows, omissions reported exactly when not", () => {
  const ids = [...CORE_SKILLS];
  const full = buildPreloadBlock(repoRoot, ids);
  assert.ok(full.bytes <= PRELOAD_BYTE_CAP, `full bytes=${full.bytes}`);
  assert.deepEqual(full.omitted, []);
  assert.deepEqual(full.included, ids);
  assert.deepEqual(buildPreloadBlock(repoRoot, ids, full.bytes).omitted, [], "cap == full size must drop nothing");

  const tightCap = Math.floor(full.bytes / 2);
  const tight = buildPreloadBlock(repoRoot, ids, tightCap);
  assert.ok(tight.bytes <= tightCap, `tight bytes=${tight.bytes} cap=${tightCap}`);
  assert.ok(tight.omitted.length > 0, "half cap must omit something");
  assert.equal(tight.included.length + tight.omitted.length, ids.length);
  assert.match(tight.text, new RegExp(`\\+${tight.omitted.length} more not shown`));
  for (const id of tight.included) assert.ok(tight.text.includes(`\n- ${id} — `), `${id} missing from block`);
});

test("context.preload: long summary is clipped with an ellipsis and the skill is kept", () => {
  const fx = fs.mkdtempSync(path.join(root, "preload-clip-"));
  const dir = path.join(fx, "skills", "work-start");
  fs.mkdirSync(dir, { recursive: true });
  const longSummary = "가".repeat(150);
  fs.writeFileSync(path.join(dir, "SKILL.md"),
    `---\nname: work-start\ndescription: test\nmetadata:\n  summary: ${longSummary}\n---\n\n# body\n`);
  const r = buildPreloadBlock(fx, ["work-start"]);
  const line = r.text.split("\n").find(l => l.startsWith("- work-start — "));
  assert.ok(line, r.text);
  const shown = line.slice("- work-start — ".length);
  assert.equal(Array.from(shown).length, PRELOAD_SUMMARY_CHARS);
  assert.ok(shown.endsWith("…"), shown);
  assert.deepEqual(r.included, ["work-start"]);
  assert.deepEqual(r.omitted, []);
});

test("config read failure: defaults stay on, hook exits 0, SessionStart warns once", () => {
  const sb = makeFixture("config-broken");
  fs.mkdirSync(path.join(sb.cfg, "oh-my-ai"), { recursive: true });
  const file = path.join(sb.cfg, "oh-my-ai", "config.json");
  fs.writeFileSync(file, "{not json");
  const up = hookRun(sb, "claude", "UserPromptSubmit", JSON.stringify({ prompt: "이 기능 Jira 티켓 확인하고 구현해줘", session_id: "s-b" }));
  assert.equal(up.status, 0, up.stderr);
  assert.match(JSON.parse(up.stdout).hookSpecificOutput.additionalContext, /Jira-first/);
  const ss = hookRun(sb, "claude", "SessionStart", "{}");
  assert.equal(ss.status, 0, ss.stderr);
  assert.match(JSON.parse(ss.stdout).systemMessage, /기본값/);
  assert.equal(fs.readFileSync(file, "utf8"), "{not json", "broken config must not be overwritten");
  assert.equal(cli(sb, ["status"]).status, 0);
});

test("status: update.policy=AUTO shown as stored, auto-run NOT IMPLEMENTED", () => {
  const sb = makeFixture("status-auto");
  assert.equal(cli(sb, ["config", "set", "update.policy", "AUTO"]).status, 0);
  const text = cli(sb, ["status"]).stdout;
  assert.match(text, /update\.policy\s+AUTO → stored; auto-run NOT IMPLEMENTED \(behaves as CHECK\)/);
  const j = JSON.parse(cli(sb, ["status", "--json"]).stdout);
  assert.equal(j.honesty.settings["update.policy"].setting, "AUTO");
  assert.match(j.honesty.settings["update.policy"].effective, /NOT IMPLEMENTED/);
  assert.equal(j.honesty.discovery.native_discovery, "NOT_VERIFIED (requires runtime E2E)");
  assert.equal(j.honesty.guards.git_identity_guard, "not installed");
});

test("status: context.inject is effective only when the installed hook points to this source", () => {
  const sb = makeFixture("status-effective");
  assert.match(cli(sb, ["status"]).stdout, /context\.inject\s+on → not effective: hooks not installed\/other source/);

  // 이 소스를 가리키는 설치: 훅 설정 + 진입점 링크
  fs.mkdirSync(sb.claude, { recursive: true });
  fs.copyFileSync(path.join(sb.clone, "claude", "settings.json"), path.join(sb.claude, "settings.json"));
  fs.mkdirSync(sb.bin, { recursive: true });
  fs.symlinkSync(path.join(sb.clone, "scripts", "oh-my-ai.mjs"), path.join(sb.bin, "oh-my-ai"));
  const mine = cli(sb, ["status"]).stdout;
  assert.match(mine, /context\.inject\s+on → effective: hook reads config \(v1\.0\.0 @ [0-9a-f]+\)/);

  // 다른 소스를 가리키는 설치는 effective로 보지 않는다
  const other = path.join(sb.base, "other-source");
  fs.mkdirSync(path.join(other, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(other, "scripts", "oh-my-ai.mjs"), "// other\n");
  fs.rmSync(path.join(sb.bin, "oh-my-ai"));
  fs.symlinkSync(path.join(other, "scripts", "oh-my-ai.mjs"), path.join(sb.bin, "oh-my-ai"));
  const theirs = cli(sb, ["status"]).stdout;
  assert.match(theirs, /context\.inject\s+on → not effective: hooks point to other source/);
  assert.doesNotMatch(theirs, /effective: hook reads config/);
});

test("update --apply: refuses on a non-default branch unless --ref names it", () => {
  const sb = makeFixture("update-branch");
  git(sb.clone, ["checkout", "-q", "-b", "feature/x"]);
  git(sb.clone, ["push", "-q", "origin", "feature/x"]);
  const head = git(sb.clone, ["rev-parse", "HEAD"]);
  const refused = cli(sb, ["update", "--apply"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /non-default branch "feature\/x"/);
  assert.equal(git(sb.clone, ["rev-parse", "HEAD"]), head);
  const wrongRef = cli(sb, ["update", "--apply", "--ref", "origin/master"]);
  assert.equal(wrongRef.status, 1);
  assert.match(wrongRef.stderr, /non-default branch/);
  const matched = cli(sb, ["update", "--apply", "--ref", "origin/feature/x"], { CODEX_DIR: sb.codex });
  assert.equal(matched.status, 0, `${matched.stdout}\n${matched.stderr}`);
  assert.match(matched.stdout, /nothing to fast-forward/);
});

test("update --apply: refuses while another worktree has uncommitted changes; --force-worktrees overrides", () => {
  const sb = makeFixture("update-worktree");
  pushPeerCommit(sb, "peer-wt.txt", "x\n");
  const wt = path.join(sb.base, "writer-wt");
  git(sb.clone, ["worktree", "add", "-q", "-b", "writer", wt]);
  fs.writeFileSync(path.join(wt, "wip.txt"), "in progress\n");
  const head = git(sb.clone, ["rev-parse", "HEAD"]);

  const check = cli(sb, ["update"]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /1 other worktree\(s\) have uncommitted changes/);

  const refused = cli(sb, ["update", "--apply"], { CODEX_DIR: sb.codex });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /uncommitted changes/);
  assert.match(refused.stderr, /writer-wt/);
  assert.equal(git(sb.clone, ["rev-parse", "HEAD"]), head);

  const forced = cli(sb, ["update", "--apply", "--force-worktrees"], { CODEX_DIR: sb.codex });
  assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
  assert.match(forced.stdout, /warning: --force-worktrees set/);
  assert.equal(git(sb.clone, ["rev-parse", "HEAD"]), git(sb.clone, ["rev-parse", "origin/master"]));
});

test("doctor: prints bootstrap hint when ohmyai entrypoints are absent", () => {
  const sb = makeFixture("doctor-bootstrap");
  const r = cli(sb, ["doctor"]);
  assert.match(r.stdout, /=== bootstrap/);
  assert.match(r.stdout, /\.\/setup\.sh --install-shared --dry-run/);
  assert.match(r.stdout, /Windows Native/);
});

function coreOf(dir) {
  return coreIdsOf(discoverSkills(dir)).filter(e => e.present).map(e => e.skill);
}

function assertLinkedTo(linkPath, sourceDir) {
  assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), `${linkPath} is not a symlink`);
  assert.equal(fs.realpathSync(linkPath), fs.realpathSync(sourceDir));
}

test("install --apply: links every Core id into both runtimes; library only with --with", () => {
  const sb = makeFixture("install-core");
  const core = coreOf(sb.clone);
  assert.ok(core.length >= 11);
  const lib = discoverSkills(sb.clone).skills.find(s => s.tier === "library");
  const r = cli(sb, ["install", "--apply"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /CORE-LINKS: ids=\d+ linked=\d+/);
  for (const s of core) {
    assertLinkedTo(path.join(sb.claude, "skills", s.name), s.dir);
    assertLinkedTo(path.join(sb.agents, "skills", s.name), s.dir);
  }
  assert.equal(fs.existsSync(path.join(sb.claude, "skills", lib.name)), false, "library linked by default");

  const opt = cli(sb, ["install", "--apply", "--with", lib.name]);
  assert.equal(opt.status, 0, `${opt.stdout}\n${opt.stderr}`);
  assertLinkedTo(path.join(sb.claude, "skills", lib.name), lib.dir);
  assertLinkedTo(path.join(sb.agents, "skills", lib.name), lib.dir);
});

test("install --apply: user directory with the same name is preserved; PARTIAL and non-zero exit", () => {
  const sb = makeFixture("install-conflict");
  const userDir = path.join(sb.claude, "skills", "senior");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "mine.md"), "user\n");
  const r = cli(sb, ["install", "--apply"]);
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /PARTIAL/);
  assert.match(r.stderr, /senior/);
  assert.doesNotMatch(r.stdout, /install: OK/);
  assert.equal(fs.readFileSync(path.join(userDir, "mine.md"), "utf8"), "user\n");
  assert.ok(fs.lstatSync(path.join(sb.agents, "skills", "senior")).isSymbolicLink(), "other runtime still linked");
  const other = coreOf(sb.clone).find(s => s.name !== "senior");
  assertLinkedTo(path.join(sb.claude, "skills", other.name), other.dir);
});

test("install dry-run: prints exact planned links and creates nothing", () => {
  const sb = makeFixture("install-plan");
  const before = snapshot(sb.home);
  const r = cli(sb, ["install"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const senior = coreOf(sb.clone).find(s => s.name === "senior");
  assert.ok(r.stdout.includes(`plan: Claude senior  ${path.join(sb.claude, "skills", "senior")} -> ${senior.dir}`));
  assert.deepEqual(snapshot(sb.home), before);
});

test("update --apply: a Core skill that appears upstream is linked for both runtimes", () => {
  const sb = makeFixture("update-new-core");
  pushPeerCommit(sb, "skills/brand-new-core/SKILL.md", "---\nname: brand-new-core\ndescription: \"fixture\"\nmetadata:\n  source: born-here\n  summary: fixture core skill\n  tier: core\n---\n\n# fixture\n");
  const r = cli(sb, ["update", "--apply"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assertLinkedTo(path.join(sb.claude, "skills", "brand-new-core"), path.join(sb.clone, "skills", "brand-new-core"));
  assertLinkedTo(path.join(sb.agents, "skills", "brand-new-core"), path.join(sb.clone, "skills", "brand-new-core"));
});

test("preload clip: a cut never splits a backtick span or a bare token, and the id line stays whole", () => {
  // 백틱 span 이 상한 안에서 열린 채 끝나면 span 시작 전에서 자른다.
  assert.equal(clipSummary(`abc \`${"y".repeat(80)}\` tail`), "abc…");
  // 공백 없는 긴 토큰(경로·식별자) 한가운데면 토큰 시작 전에서 자른다.
  assert.equal(clipSummary(`ab ${"p".repeat(80)}`), "ab…");
  // 닫힌 span 뒤 토큰이 상한을 넘으면 그 토큰만 뺀다.
  assert.equal(clipSummary(`\`a b\` ${"z".repeat(80)}`), "`a b`…");
  // 일반 문장은 기존처럼 상한-1 글자 + …
  const prose = "가".repeat(100);
  assert.equal(Array.from(clipSummary(prose)).length, PRELOAD_SUMMARY_CHARS);

  const samples = [
    "`scripts/lib/oh-my-ai-facade.mjs` 를 고치고 `models` 서브커맨드를 추가하는 긴 설명 문장입니다 그리고 더 길게 이어짐",
    "경로 scripts/lib/some/very/deep/path/to/a/module-with-long-name.mjs 를 참조하는 요약 문장이 상한을 넘는다 끝",
    "a `b c d` e `f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee ff gg hh ii jj kk ll mm nn` tail words",
  ];
  for (const s of samples) {
    const clipped = clipSummary(s);
    assert.ok(Array.from(clipped).length <= PRELOAD_SUMMARY_CHARS, clipped);
    assert.ok(clipped.endsWith("…"), clipped);
    const kept = clipped.slice(0, -1);
    assert.ok(s.startsWith(kept), `${kept} is not a prefix`);
    assert.equal((kept.match(/`/g) ?? []).length % 2, 0, `split backtick span: ${kept}`);
    // 잘린 지점이 ASCII 식별자·경로 토큰 한가운데면 실패. 한글 문장 중간 절단은 허용.
    const tail = s.slice(kept.length).split(/\s/)[0] ?? "";
    const head = kept.split(/\s/).pop() ?? "";
    const straddles = head.length > 0 && tail.length > 0 && /[A-Za-z0-9_./\\-]/.test(head + tail);
    assert.ok(!straddles, `cut inside token: ${kept}`);
  }

  const fx = fs.mkdtempSync(path.join(root, "preload-token-"));
  const dir = path.join(fx, "skills", "work-start");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"),
    `---\nname: work-start\ndescription: test\nmetadata:\n  summary: ${samples[0]}\n---\n\n# body\n`);
  const block = buildPreloadBlock(fx, ["work-start"]);
  const line = block.text.split("\n").find(l => l.startsWith("- work-start — "));
  assert.ok(line, block.text);
  assert.ok(line.startsWith("- work-start — "));
  assert.ok(block.bytes <= PRELOAD_BYTE_CAP);
});

// model policy 스텁 (#227 scripts/model-policy.mjs 의 출력 형태를 따른다).
// status 는 describeActivePolicy() JSON 을 항상 출력하고 VALID 가 아니면 exit 1.
// 그 밖의 서브커맨드는 받은 argv 를 되돌려 준다. mode.txt: ok | draft | missing | garbage.
function writeModelStub(sb, mode = "ok") {
  const dir = path.join(sb.clone, "scripts");
  fs.writeFileSync(path.join(dir, "model-policy.mjs"), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const here = path.dirname(fileURLToPath(import.meta.url));",
    "const mode = fs.readFileSync(path.join(here, 'stub-mode.txt'), 'utf8').trim();",
    "const argv = process.argv.slice(2);",
    "if (argv[0] === 'status') {",
    "  if (mode === 'garbage') { console.log('not json'); process.exit(0); }",
    "  if (mode === 'missing') { console.log(JSON.stringify({ path: '/x', via: 'default', status: 'POLICY_MISSING', errors: [], advisory: ['cost_limits'] })); process.exit(1); }",
    "  const base = { path: '/x', via: 'default', errors: [], advisory: ['cost_limits'], policy_version: '2026.11.25-1', previous_version: null, enabled_models: [], roles: ['senior'] };",
    "  if (mode === 'draft') { console.log(JSON.stringify({ ...base, status: 'POLICY_NOT_APPROVED' })); process.exit(1); }",
    "  console.log(JSON.stringify({ ...base, status: 'VALID' }));",
    "  process.exit(0);",
    "}",
    "console.log(JSON.stringify({ argv }));",
    "process.exit(argv.some(a => a.startsWith('fail')) ? 3 : 0);",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "stub-mode.txt"), `${mode}\n`);
}

test("models: absent script prints not-available, status exits 0, mutating exits 2", () => {
  const sb = makeFixture("models-absent");
  const st = cli(sb, ["models", "status"]);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /model policy: not available in this source \(requires #227\)/);
  for (const args of [["models", "apply", "p.json", "--apply"], ["models", "rollback", "--apply"]]) {
    const r = cli(sb, args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /not available in this source/);
  }
  const line = JSON.parse(cli(sb, ["status", "--json"]).stdout).model_policy;
  assert.equal(line.state, "not available");
  assert.match(cli(sb, ["status"]).stdout, /model policy  not available \(requires #227\)/);
});

test("models: passthrough of each subcommand, --apply gate, exit status propagated", () => {
  const sb = makeFixture("models-passthrough");
  writeModelStub(sb, "ok");
  const argvOf = r => JSON.parse(r.stdout.trim().split("\n").pop()).argv;

  assert.deepEqual(argvOf(cli(sb, ["models", "validate", "p.json"])), ["validate", "p.json"]);
  assert.deepEqual(argvOf(cli(sb, ["models", "diff", "p.json"])), ["diff", "p.json"]);
  assert.deepEqual(
    argvOf(cli(sb, ["models", "check", "--role", "R", "--runtime", "claude", "--risk", "low", "--model", "M"])),
    ["check", "--role", "R", "--runtime", "claude", "--risk", "low", "--model", "M"],
  );
  // --apply 는 파사드 게이트이므로 스크립트로 넘어가지 않는다 (스크립트는 값 없는 플래그를 usage 오류로 거부).
  assert.deepEqual(argvOf(cli(sb, ["models", "apply", "p.json", "--apply"])), ["apply", "p.json"]);
  assert.deepEqual(argvOf(cli(sb, ["models", "rollback", "--apply"])), ["rollback"]);
  // validate 는 파일 없이도 스크립트 기본 경로를 본다.
  assert.deepEqual(argvOf(cli(sb, ["models", "validate"])), ["validate"]);

  // --apply 없이는 스크립트를 부르지 않는다.
  const noApply = cli(sb, ["models", "apply", "p.json"]);
  assert.equal(noApply.status, 2);
  assert.doesNotMatch(noApply.stdout, /argv/);
  assert.equal(cli(sb, ["models", "rollback"]).status, 2);
  // apply/diff 는 후보 파일이 필요하다.
  assert.equal(cli(sb, ["models", "apply", "--apply"]).status, 2);
  assert.equal(cli(sb, ["models", "diff"]).status, 2);
  assert.equal(cli(sb, ["models", "bogus"]).status, 2);
  // 스크립트 종료 코드를 그대로 돌려준다.
  assert.equal(cli(sb, ["models", "diff", "fail.json"]).status, 3);
});

test("models: status line shows version, approval and validation result for each policy state", () => {
  const sb = makeFixture("models-status-line");
  writeModelStub(sb, "ok");
  assert.match(cli(sb, ["status"]).stdout, /model policy  2026\.11\.25-1 · ACTIVE · validation VALID/);
  const ok = JSON.parse(cli(sb, ["status", "--json"]).stdout).model_policy;
  assert.deepEqual(ok, { state: "configured", version: "2026.11.25-1", approval: "ACTIVE", validation: "VALID" });

  // 스크립트 status 는 DRAFT 정책에 exit 1 을 주지만 JSON 은 그대로 읽는다.
  writeModelStub(sb, "draft");
  assert.match(cli(sb, ["status"]).stdout, /model policy  2026\.11\.25-1 · NOT ACTIVE · validation POLICY_NOT_APPROVED/);
  assert.equal(cli(sb, ["status", "--json"]).status, 0);

  writeModelStub(sb, "missing");
  assert.match(cli(sb, ["status"]).stdout, /model policy  not configured\n/);
  assert.equal(JSON.parse(cli(sb, ["status", "--json"]).stdout).model_policy.state, "not configured");

  writeModelStub(sb, "garbage");
  assert.match(cli(sb, ["status"]).stdout, /model policy  not configured \(UNREADABLE\)/);
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
