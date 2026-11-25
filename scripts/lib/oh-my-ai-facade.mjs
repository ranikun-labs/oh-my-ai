// 사용자용 명령 파사드 (ohmyai / oh-my-ai 공용). 새 설치 엔진을 만들지 않는다.
//  - version / status / skills: 읽기 전용 조회 (skill-discovery, merge-runtime-hooks 재사용)
//  - doctor / install: setup.sh 위임 (install 기본은 --dry-run)
//  - update: git fetch + 기준 ref 비교, --apply는 clean fast-forward 뒤 render + doctor
//  - config: ${XDG_CONFIG_HOME:-~/.config}/oh-my-ai/config.json 검증/저장
// 안전 경계: 이 파사드는 Hook/guard/권한 파일을 직접 쓰지 않는다. 쓰기는 setup.sh 또는 config.json 뿐이다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverSkills } from "./skill-discovery.mjs";
import { CORE_SKILLS } from "./oh-my-ai-core-skills.mjs";
import {
  CONFIG_KEYS,
  ConfigError,
  configFilePath,
  effectiveConfig,
  parseInput,
  readConfigFile,
  writeConfigFile,
} from "./oh-my-ai-config.mjs";

export const FACADE_COMMANDS = Object.freeze([
  "version", "--version", "status", "doctor", "install", "update", "config", "skills", "help", "--help", "-h",
]);

const BIN = "ohmyai";
const ALIAS = "oh-my-ai";
const EXECUTION_MODES = ["suggest-only", "patch-with-approval", "auto-apply"];
const GENERATED_FILES = ["CLAUDE.md", "claude/CLAUDE.md", "AGENTS.md", "MINE.md", "skills/skill-index.json"];

// ---------- entry ----------

// 반환: 종료 코드. ctx = { repoRoot, env, stdout(str), stderr(str) }
export function runFacade(command, args, ctx) {
  const out = line => process.stdout.write(`${line}\n`);
  const err = line => process.stderr.write(`${line}\n`);
  const io = { out, err };
  const { repoRoot, env = process.env } = ctx;
  switch (command) {
    case "version":
    case "--version":
      return cmdVersion(repoRoot, args, io);
    case "status":
      return cmdStatus(repoRoot, env, args, io);
    case "doctor":
      return cmdDoctor(repoRoot, env, args, io);
    case "install":
      return cmdInstall(repoRoot, env, args, io);
    case "update":
      return cmdUpdate(repoRoot, env, args, io);
    case "config":
      return cmdConfig(env, args, io);
    case "skills":
      return cmdSkills(repoRoot, env, args, io);
    case "help":
    case "--help":
    case "-h":
      return cmdHelp(io);
    default:
      err(`unknown command: ${command}`);
      return 2;
  }
}

// ---------- helpers ----------

function git(repoRoot, args) {
  const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || r.error?.message || "").trim() };
}

function readVersion(repoRoot) {
  try {
    return fs.readFileSync(path.join(repoRoot, "VERSION"), "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function gitState(repoRoot) {
  const inside = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { isRepo: false };
  const head = git(repoRoot, ["rev-parse", "--short", "HEAD"]);
  const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = git(repoRoot, ["status", "--porcelain"]);
  const dirtyFiles = status.out ? status.out.split("\n").length : 0;
  return {
    isRepo: true,
    head: head.ok ? head.out : "unknown",
    branch: branch.ok ? branch.out : "unknown",
    dirtyFiles,
    dirty: dirtyFiles > 0,
  };
}

function dirsFor(env) {
  const home = os.homedir();
  return {
    claude: env.CLAUDE_DIR || path.join(home, ".claude"),
    codex: env.CODEX_DIR || path.join(home, ".codex"),
    agentSkills: env.AGENT_DIR || path.join(home, ".agents"),
    localBin: env.LOCAL_BIN || path.join(home, ".local", "bin"),
  };
}

function setupEnv(env) {
  return { ...env };
}

function runSetup(repoRoot, env, args, { inherit = false } = {}) {
  return spawnSync("bash", [path.join(repoRoot, "setup.sh"), ...args], {
    cwd: repoRoot,
    env: setupEnv(env),
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// setup.sh skill_link_state 와 같은 분류 (읽기 전용 미러).
// 출력: ready | absent | stale-source | dangling | conflict | legacy-dir-link
export function linkState(dest, skillId, source, repoRoot) {
  let st;
  try {
    st = fs.lstatSync(dest);
  } catch {
    return "absent";
  }
  if (!st.isSymbolicLink()) return "conflict";
  const target = fs.readlinkSync(dest);
  if (source && target === source) return "ready";
  const old = path.join(repoRoot, "skills", skillId);
  if (source && target === old && source !== old) return "stale-source";
  if (!fs.existsSync(dest)) return "dangling";
  return "conflict";
}

function skillRootState(root, repoRoot) {
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return "legacy-dir-link";
  } catch {
    // 없으면 아래에서 absent로 처리
  }
  return null;
}

// skill-discovery 결과를 이름별로 묶는다. 이름이 정확히 하나일 때만 source 디렉터리를 준다.
function discoveryIndex(repoRoot) {
  const discovery = discoverSkills(repoRoot);
  const byName = new Map();
  for (const skill of discovery.skills) {
    const list = byName.get(skill.name) || [];
    list.push(skill);
    byName.set(skill.name, list);
  }
  const sourceOf = id => {
    const list = byName.get(id) || [];
    return list.length === 1 ? list[0].dir : null;
  };
  return { discovery, byName, sourceOf };
}

function readSkillMeta(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { source: "unknown", explicitOnly: false };
  }
  const lines = text.split("\n");
  if (lines[0] !== "---") return { source: "unknown", explicitOnly: false };
  const end = lines.indexOf("---", 1);
  const fm = lines.slice(1, end === -1 ? lines.length : end);
  const explicitOnly = fm.some(l => /^disable-model-invocation:\s*true\s*$/.test(l));
  let source = "unknown";
  let inMeta = false;
  for (const line of fm) {
    if (/^metadata:\s*$/.test(line)) {
      inMeta = true;
      continue;
    }
    if (/^\S/.test(line)) inMeta = false;
    if (inMeta) {
      const m = line.match(/^\s+source:\s*(.+?)\s*$/);
      if (m) source = m[1].replace(/^["']|["']$/g, "");
    }
  }
  return { source, explicitOnly };
}

// ---------- version ----------

function cmdVersion(repoRoot, args, { out }) {
  if (args.length > 0) {
    out(`usage: ${BIN} version`);
    return 2;
  }
  const g = gitState(repoRoot);
  const sha = g.isRepo ? g.head : "no-git";
  const dirty = g.isRepo && g.dirty ? ", dirty" : "";
  out(`${BIN} ${readVersion(repoRoot)} (git ${sha}${dirty})`);
  return 0;
}

// ---------- status ----------

function hookMode(repoRoot, env, runtime, target, mode) {
  const dirs = dirsFor(env);
  const source = runtime === "claude"
    ? path.join(repoRoot, "claude", "settings.json")
    : path.join(repoRoot, "codex", "hooks.json");
  const args = [path.join(repoRoot, "scripts", "merge-runtime-hooks.mjs"), "--mode", mode, "--runtime", runtime, "--target", target];
  if (mode === "check") args.push("--source", source);
  if (mode === "enabled" && runtime === "codex") args.push("--config", path.join(dirs.codex, "config.toml"));
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (r.status !== 0) return "unknown";
  const value = (r.stdout || "").trim();
  return value || "unknown";
}

function hookReport(repoRoot, env) {
  const dirs = dirsFor(env);
  return {
    claude: {
      configured: hookMode(repoRoot, env, "claude", path.join(dirs.claude, "settings.json"), "check"),
      enabled: hookMode(repoRoot, env, "claude", path.join(dirs.claude, "settings.json"), "enabled"),
    },
    codex: {
      configured: hookMode(repoRoot, env, "codex", path.join(dirs.codex, "hooks.json"), "check"),
      enabled: hookMode(repoRoot, env, "codex", path.join(dirs.codex, "hooks.json"), "enabled"),
    },
  };
}

function entrypointState(repoRoot, linkPath) {
  const entry = path.join(repoRoot, "scripts", "oh-my-ai.mjs");
  try {
    const st = fs.lstatSync(linkPath);
    if (!st.isSymbolicLink()) return "conflict";
    if (!fs.existsSync(linkPath)) return "dangling";
    return fs.realpathSync(linkPath) === fs.realpathSync(entry) ? "ready" : "conflict";
  } catch {
    return "absent";
  }
}

// 생성물 drift: 임시 복사본에서 render-instructions.sh 를 돌리고 결과를 현재 파일과 비교한다. 원본은 쓰지 않는다.
function instructionDrift(repoRoot) {
  if (process.platform === "win32") return { state: "unsupported", files: [] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ohmyai-drift-"));
  try {
    const copy = path.join(tmp, "repo");
    fs.cpSync(repoRoot, copy, {
      recursive: true,
      verbatimSymlinks: true,
      filter: src => !/(^|[\\/])(\.git|node_modules|profiles[\\/]local)([\\/]|$)/.test(path.relative(repoRoot, src) ? path.relative(repoRoot, src) : ""),
    });
    const r = spawnSync("sh", [path.join(copy, "scripts", "render-instructions.sh")], { cwd: copy, encoding: "utf8" });
    if (r.status !== 0) return { state: "error", files: [], detail: (r.stderr || "").split("\n")[0] };
    const files = [];
    for (const rel of GENERATED_FILES) {
      const current = path.join(repoRoot, rel);
      const rendered = path.join(copy, rel);
      const a = fs.existsSync(current) ? fs.readFileSync(current) : null;
      const b = fs.existsSync(rendered) ? fs.readFileSync(rendered) : null;
      if (!a || !b || !a.equals(b)) files.push(rel);
    }
    return { state: files.length ? "drift" : "clean", files };
  } catch (error) {
    return { state: "error", files: [], detail: error.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function executionMode(repoRoot, env) {
  if (env.HARNESS_EXECUTION_MODE) return { value: env.HARNESS_EXECUTION_MODE, source: "env" };
  if (env.HARNESS_PROFILE) {
    const file = path.join(repoRoot, "profiles", "local", env.HARNESS_PROFILE, "PROFILE.md");
    try {
      const m = fs.readFileSync(file, "utf8").match(/HARNESS_EXECUTION_MODE=([\w-]+)/);
      if (m) return { value: m[1], source: "profile" };
    } catch {
      // 프로필 파일이 없으면 기본값
    }
  }
  return { value: "patch-with-approval", source: "default" };
}

function collectStatus(repoRoot, env) {
  const dirs = dirsFor(env);
  const git = gitState(repoRoot);
  const drift = instructionDrift(repoRoot);
  const mode = executionMode(repoRoot, env);
  const hooks = hookReport(repoRoot, env);
  const config = safeConfig(env);
  const index = discoveryIndex(repoRoot);

  const runtimes = {
    claude: { dir: dirs.claude, detected: isDir(dirs.claude) },
    codex: { dir: dirs.codex, detected: isDir(dirs.codex) },
  };
  const roots = { claude: path.join(dirs.claude, "skills"), codex: path.join(dirs.agentSkills, "skills") };
  const core = {};
  for (const runtime of ["claude", "codex"]) {
    const legacy = skillRootState(roots[runtime], repoRoot);
    const items = CORE_SKILLS.map(id => {
      const source = index.sourceOf(id);
      if (!source) return { id, state: "missing-source" };
      return { id, state: legacy || linkState(path.join(roots[runtime], id), id, source, repoRoot) };
    });
    core[runtime] = {
      root: roots[runtime],
      ready: items.filter(i => i.state === "ready").length,
      total: items.length,
      items,
    };
  }

  const entrypoints = {
    [BIN]: entrypointState(repoRoot, path.join(dirs.localBin, BIN)),
    [ALIAS]: entrypointState(repoRoot, path.join(dirs.localBin, ALIAS)),
  };

  const checks = [];
  const add = (level, area, message) => checks.push({ level, area, message });

  if (!git.isRepo) add("WARN", "source", "git 저장소가 아님: 버전/상태 비교 불가");
  else if (git.dirty) add("WARN", "source", `작업 트리에 변경 ${git.dirtyFiles}개 (dirty)`);
  else add("OK", "source", `clean (${git.branch} @ ${git.head})`);

  if (drift.state === "clean") add("OK", "instructions", "생성물이 원본과 일치");
  else if (drift.state === "drift") add("WARN", "instructions", `생성물 drift: ${drift.files.join(", ")} → make instructions`);
  else add("WARN", "instructions", `drift 확인 불가 (${drift.state})`);

  if (!EXECUTION_MODES.includes(mode.value)) add("WARN", "policy", `알 수 없는 실행 모드: ${mode.value}`);
  else add("OK", "policy", `execution=${mode.value} (${mode.source})`);

  if (config.error) add("FAIL", "config", config.error);
  else add("OK", "config", `update.policy=${config.values["update.policy"]} context.inject=${config.values["context.inject"]}`);

  for (const [name, state] of Object.entries(entrypoints)) {
    if (state === "ready") add("OK", "entrypoint", `${name} 링크 정상`);
    else add("WARN", "entrypoint", `${name} 링크 ${state} → ${BIN} install --apply`);
  }

  for (const runtime of ["claude", "codex"]) {
    const h = hooks[runtime];
    if (h.configured === "ready" && h.enabled === "enabled") add("OK", "hooks", `${runtime} hook 구성 및 활성`);
    else if (h.configured === "conflict") add("FAIL", "hooks", `${runtime} hook 충돌 (사용자 설정 확인 필요)`);
    else add("WARN", "hooks", `${runtime} hook: configured=${h.configured}, enabled=${h.enabled}`);
    if (!runtimes[runtime].detected) add("WARN", "runtime", `${runtime} 디렉터리 없음: ${runtimes[runtime].dir}`);
  }

  if (index.discovery.errors.length > 0) {
    add("FAIL", "skills", `skill source 트리 오류 ${index.discovery.errors.length}건 (node scripts/lib/skill-discovery.mjs --check)`);
  }
  for (const runtime of ["claude", "codex"]) {
    const c = core[runtime];
    for (const item of c.items) {
      if (item.state === "ready" || item.state === "missing-source") continue;
      const level = ["stale-source", "dangling", "conflict", "legacy-dir-link"].includes(item.state) ? "FAIL" : "WARN";
      add(level, "skills", `${runtime} ${item.id}: ${item.state}`);
    }
    const absent = c.items.filter(i => i.state === "absent").length;
    if (absent > 0) add("WARN", "skills", `${runtime} Core 미노출 ${absent}개 → ${BIN} install --apply`);
  }

  const summary = { OK: 0, WARN: 0, FAIL: 0 };
  for (const c of checks) summary[c.level] += 1;

  return {
    version: { version: readVersion(repoRoot), git: git.isRepo ? git.head : null, dirty: git.isRepo ? git.dirty : null },
    source: { path: repoRoot, branch: git.branch ?? null, head: git.head ?? null, dirty: git.dirty ?? null, dirty_files: git.dirtyFiles ?? null },
    instructions: drift,
    execution_mode: mode,
    runtimes,
    core_skills: core,
    hooks,
    entrypoints,
    config: config.error ? { error: config.error } : config.values,
    checks,
    summary,
  };
}

function safeConfig(env) {
  try {
    const stored = readConfigFile(configFilePath(env));
    const eff = effectiveConfig(stored);
    const values = {};
    for (const [k, v] of Object.entries(eff)) values[k] = v.value;
    return { values, sources: Object.fromEntries(Object.entries(eff).map(([k, v]) => [k, v.source])) };
  } catch (error) {
    if (error instanceof ConfigError) return { error: error.message, values: {} };
    throw error;
  }
}

function cmdStatus(repoRoot, env, args, { out }) {
  const json = args.includes("--json");
  if (args.some(a => a !== "--json")) {
    out(`usage: ${BIN} status [--json]`);
    return 2;
  }
  const s = collectStatus(repoRoot, env);
  if (json) {
    out(JSON.stringify(s, null, 2));
    return 0;
  }
  const coreLine = ["claude", "codex"].map(r => `${r} ${s.core_skills[r].ready}/${s.core_skills[r].total}`).join(" · ");
  const runtimeLine = ["claude", "codex"]
    .map(r => `${r}: ${s.runtimes[r].detected ? "detected" : "not detected"} (${s.runtimes[r].dir})`)
    .join("  ");
  const hookLine = ["claude", "codex"].map(r => `${r}: ${s.hooks[r].configured}/${s.hooks[r].enabled}`).join(" · ");
  const instr = s.instructions.state === "clean" ? "OK (generated files match sources)"
    : s.instructions.state === "drift" ? `WARN (${s.instructions.files.join(", ")})`
    : `WARN (${s.instructions.state})`;
  const cfg = s.config.error ? `FAIL (${s.config.error})`
    : `update.policy=${s.config["update.policy"]} · context.inject=${s.config["context.inject"]} · preload=${s.config["context.preload"].length}`;
  const lines = [
    `${BIN} status`,
    `  version       ${s.version.version} (git ${s.version.git ?? "no-git"}${s.version.dirty ? ", dirty" : ""})`,
    `  source        ${s.source.path}  branch=${s.source.branch ?? "-"}  dirty=${s.source.dirty === null ? "-" : s.source.dirty ? "yes" : "no"}`,
    `  instructions  ${instr}`,
    `  policy        execution=${s.execution_mode.value} (${s.execution_mode.source})`,
    `  runtimes      ${runtimeLine}`,
    `  core skills   ${coreLine} (ready/total)`,
    `  hooks         ${hookLine} (configured/enabled)`,
    `  entrypoints   ${BIN}=${s.entrypoints[BIN]} ${ALIAS}=${s.entrypoints[ALIAS]}`,
    `  config        ${cfg}`,
    `  checks        OK ${s.summary.OK} · WARN ${s.summary.WARN} · FAIL ${s.summary.FAIL}`,
    `  next          ${BIN} doctor  (details and fix hints)`,
  ];
  out(lines.join("\n"));
  return 0;
}

// ---------- doctor ----------

const FIX_HINTS = [
  [/stale-source/, "stale-source: 이동 전 옛 경로(skills/<id>)를 가리키는 링크입니다. 자동 재연결하지 않습니다. 해당 링크를 직접 제거한 뒤 `ohmyai install --apply`를 실행하세요."],
  [/dangling/, "dangling: 대상이 없는 깨진 링크입니다. 링크를 직접 제거한 뒤 `ohmyai install --apply`를 실행하세요 (출력의 'rm' 안내 참고)."],
  [/legacy-dir-link/, "legacy-dir-link: skills 디렉터리 자체가 repo 링크입니다. 링크를 직접 제거한 뒤 `ohmyai install --apply`로 Skill별 링크를 다시 만드세요."],
  [/conflict|exists-local|exists-symlink/, "conflict: 사용자 파일/디렉터리와 충돌합니다. 설치기는 기존 파일을 덮어쓰지 않습니다. 내용을 확인해 직접 옮기거나 유지하세요."],
  [/missing:/, "missing: 아직 설치되지 않았습니다. 필요하면 `ohmyai install --apply`를 실행하세요 (프로필 항목은 `make init-profile PROFILE=<name>`)."],
  [/incomplete/, "incomplete: 구성 요소가 덜 연결되었습니다. `ohmyai install --apply`를 다시 실행하세요."],
];

function cmdDoctor(repoRoot, env, args, { out, err }) {
  const strict = args.includes("--strict");
  if (args.some(a => a !== "--strict")) {
    out(`usage: ${BIN} doctor [--strict]`);
    return 2;
  }
  if (process.platform === "win32") {
    err("UNSUPPORTED: doctor delegates to setup.sh (bash). Use WSL on Windows.");
    return 1;
  }
  const setupArgs = strict ? ["--strict"] : [];
  const first = runSetup(repoRoot, env, ["--doctor", ...setupArgs]);
  const second = runSetup(repoRoot, env, ["--doctor-dev-main-flow"]);
  const text = `${first.stdout || ""}\n${second.stdout || ""}`;
  out((first.stdout || "").replace(/\n$/, ""));
  out((second.stdout || "").replace(/\n$/, ""));
  if (first.stderr) err(first.stderr.trim());
  if (second.stderr) err(second.stderr.trim());
  const hints = FIX_HINTS.filter(([re]) => re.test(text)).map(([, msg]) => msg);
  if (hints.length) {
    out("");
    out("=== how to fix ===");
    for (const h of hints) out(`- ${h}`);
  }
  const failed = (first.status !== 0) || (second.status !== 0);
  out("");
  out(`doctor exit: setup --doctor=${first.status}, --doctor-dev-main-flow=${second.status}${strict ? " (strict)" : ""}`);
  return failed ? 1 : 0;
}

// ---------- install ----------

function cmdInstall(repoRoot, env, args, { out, err }) {
  const opts = { apply: false, profile: null, devMain: false, handoff: false, recordSync: false, spec: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--profile") {
      opts.profile = args[i + 1] ?? "";
      i += 1;
    } else if (a === "--dev-main-flow") opts.devMain = true;
    else if (a === "--with-handoff") opts.handoff = true;
    else if (a === "--with-record-sync") opts.recordSync = true;
    else if (a === "--with-spec") opts.spec = true;
    else {
      err(`unknown argument: ${a}`);
      out(`usage: ${BIN} install [--profile <name>] [--dev-main-flow [--with-handoff] [--with-record-sync] [--with-spec]] [--apply]`);
      return 2;
    }
  }
  if (opts.profile !== null && (opts.profile === "" || !/^[A-Za-z0-9._-]+$/.test(opts.profile))) {
    err("--profile requires a name of letters, digits, '.', '_' or '-'");
    return 2;
  }
  if (opts.profile !== null && opts.devMain) {
    err("--profile and --dev-main-flow cannot be combined");
    return 2;
  }
  if (!opts.devMain && (opts.handoff || opts.recordSync || opts.spec)) {
    err("--with-* flags require --dev-main-flow");
    return 2;
  }
  if (process.platform === "win32") {
    err("UNSUPPORTED: install delegates to setup.sh (bash). Use WSL on Windows Native.");
    return 1;
  }

  let setupArgs;
  let label;
  if (opts.profile !== null) {
    setupArgs = ["--install-profile", "--profile", opts.profile];
    label = `profile ${opts.profile}`;
  } else if (opts.devMain) {
    setupArgs = ["--install-dev-main-flow"];
    if (opts.handoff) setupArgs.push("--with-handoff");
    if (opts.recordSync) setupArgs.push("--with-record-sync");
    if (opts.spec) setupArgs.push("--with-spec");
    label = "dev-main-flow bundle";
  } else {
    setupArgs = ["--install-shared"];
    label = "shared";
  }
  if (!opts.apply) setupArgs.push("--dry-run");

  out(opts.apply
    ? `${BIN} install (${label}): --apply. 기존 사용자 파일은 덮어쓰지 않습니다 (setup.sh 정책).`
    : `${BIN} install (${label}): dry-run. 변경하려면 --apply를 붙이세요.`);
  const r = runSetup(repoRoot, env, setupArgs, { inherit: true });
  return r.status ?? 1;
}

// ---------- update ----------

function classify(ahead, behind) {
  if (ahead === 0 && behind === 0) return "up-to-date";
  if (ahead === 0 && behind > 0) return "behind";
  if (ahead > 0 && behind === 0) return "ahead";
  return "diverged";
}

function cmdUpdate(repoRoot, env, args, { out, err }) {
  let apply = false;
  let ref = "origin/master";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--ref") {
      ref = args[i + 1] ?? "";
      i += 1;
    } else {
      err(`unknown argument: ${args[i]}`);
      out(`usage: ${BIN} update [--ref <ref>] [--apply]`);
      return 2;
    }
  }
  if (!ref || ref.startsWith("-")) {
    err("--ref requires a git ref");
    return 2;
  }
  const g = gitState(repoRoot);
  if (!g.isRepo) {
    err("update requires a git checkout of oh-my-ai");
    return 1;
  }
  const config = safeConfig(env);
  const policy = config.values?.["update.policy"] ?? "CHECK";
  const remote = ref.includes("/") ? ref.split("/")[0] : "origin";
  const fetched = git(repoRoot, ["fetch", "--quiet", remote]);
  if (!fetched.ok) {
    err(`fetch failed for remote "${remote}": ${fetched.err || "unknown error"} (no changes made)`);
    return 1;
  }
  const verify = git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!verify.ok) {
    err(`ref not found: ${ref}`);
    return 1;
  }
  const counts = git(repoRoot, ["rev-list", "--left-right", "--count", `HEAD...${ref}`]);
  const [ahead, behind] = counts.out.split(/\s+/).map(Number);
  const state = classify(ahead, behind);
  const dirty = g.dirty;

  out(`${BIN} update check`);
  out(`  local   ${g.branch} @ ${g.head}`);
  out(`  ref     ${ref} (fetched from ${remote})`);
  out(`  ahead ${ahead} · behind ${behind} · dirty ${dirty ? `yes (${g.dirtyFiles} files)` : "no"} → ${state}`);
  out(`  policy  update.policy=${policy} (AUTO is stored only; nothing runs automatically)`);

  if (!apply) {
    if (state === "behind") out(`  next    ${BIN} update --apply  (clean fast-forward only)`);
    return 0;
  }

  if (process.platform === "win32") {
    err("UNSUPPORTED: --apply runs render (sh) and doctor (bash). Use WSL on Windows Native.");
    return 1;
  }
  if (dirty) {
    err("refuse: working tree is dirty; commit or stash your changes yourself, then retry");
    return 1;
  }
  if (state === "diverged") {
    err("refuse: local and ref have diverged; resolve manually (no merge or rebase is done automatically)");
    return 1;
  }
  if (state !== "behind") {
    out(`nothing to fast-forward (state: ${state})`);
    return 0;
  }
  const ff = git(repoRoot, ["merge", "--ff-only", ref]);
  if (!ff.ok) {
    err(`fast-forward failed: ${ff.err}`);
    return 1;
  }
  out(`fast-forwarded to ${ref}`);
  const render = spawnSync("sh", [path.join(repoRoot, "scripts", "render-instructions.sh")], { cwd: repoRoot, encoding: "utf8" });
  if (render.status !== 0) {
    err(`render failed after update: ${(render.stderr || "").trim()} (run make instructions manually)`);
    return 1;
  }
  out("instructions re-rendered");
  const doctor = runSetup(repoRoot, env, ["--doctor"]);
  out((doctor.stdout || "").replace(/\n$/, ""));
  return doctor.status === 0 ? 0 : 1;
}

// ---------- config ----------

function cmdConfig(env, args, { out, err }) {
  const [sub, key, ...rest] = args;
  const file = configFilePath(env);
  const usage = () => {
    out(`usage: ${BIN} config list [--json]`);
    out(`       ${BIN} config get <key>`);
    out(`       ${BIN} config set <key> <value>`);
    out(`keys: ${Object.keys(CONFIG_KEYS).join(", ")}`);
    return 2;
  };
  let stored;
  try {
    stored = readConfigFile(file);
  } catch (error) {
    if (error instanceof ConfigError) {
      err(`config error: ${error.message} (${file})`);
      return 1;
    }
    throw error;
  }
  const eff = effectiveConfig(stored);

  if (sub === "list" && args.length <= 2 && (args.length === 1 || args[1] === "--json")) {
    if (args[1] === "--json") {
      out(JSON.stringify(Object.fromEntries(Object.entries(eff).map(([k, v]) => [k, v.value])), null, 2));
    } else {
      out(`file: ${file}`);
      for (const [k, v] of Object.entries(eff)) out(`${k} = ${JSON.stringify(v.value)} (${v.source})`);
    }
    return 0;
  }
  if (sub === "get" && key && rest.length === 0) {
    if (!CONFIG_KEYS[key]) {
      err(`unknown config key: ${key}`);
      return usage();
    }
    out(JSON.stringify(eff[key].value));
    return 0;
  }
  if (sub === "set" && key && rest.length === 1) {
    if (!CONFIG_KEYS[key]) {
      err(`unknown config key: ${key}`);
      return usage();
    }
    let value;
    try {
      value = parseInput(key, rest[0]);
    } catch (error) {
      err(`invalid value: ${error.message}`);
      return 2;
    }
    const next = { ...stored, [key]: value };
    try {
      writeConfigFile(file, next);
    } catch (error) {
      err(`config write failed: ${error.message} (file ${file})`);
      return 1;
    }
    out(`${key} = ${JSON.stringify(value)} (saved to ${file})`);
    return 0;
  }
  return usage();
}

// ---------- skills ----------

function cmdSkills(repoRoot, env, args, { out, err }) {
  let tier = "all";
  let json = false;
  for (const a of args) {
    if (a === "--core") tier = "core";
    else if (a === "--library") tier = "library";
    else if (a === "--all") tier = "all";
    else if (a === "--json") json = true;
    else {
      err(`unknown argument: ${a}`);
      out(`usage: ${BIN} skills [--core|--library|--all] [--json]`);
      return 2;
    }
  }
  const index = discoveryIndex(repoRoot);
  if (index.discovery.errors.length > 0) {
    for (const e of index.discovery.errors) err(`error: ${e}`);
    err("skill source tree has errors; fix them first (node scripts/lib/skill-discovery.mjs --check)");
    return 1;
  }
  const dirs = dirsFor(env);
  const roots = { claude: path.join(dirs.claude, "skills"), codex: path.join(dirs.agentSkills, "skills") };
  const rows = [];
  const seen = new Set();
  for (const skill of index.discovery.skills) {
    const id = skill.name;
    seen.add(id);
    const isCore = CORE_SKILLS.includes(id);
    const meta = readSkillMeta(skill.skillFile);
    rows.push({
      id,
      tier: isCore ? "core" : "library",
      provenance: meta.source,
      source_path: skill.relPath,
      explicit_only: meta.explicitOnly,
      exposure: Object.fromEntries(["claude", "codex"].map(r => [
        r,
        linkState(path.join(roots[r], id), id, skill.dir, repoRoot),
      ])),
    });
  }
  for (const id of CORE_SKILLS) {
    if (seen.has(id)) continue;
    rows.push({
      id,
      tier: "core",
      provenance: "unknown",
      source_path: null,
      explicit_only: false,
      exposure: { claude: "missing-source", codex: "missing-source" },
    });
  }
  rows.sort((a, b) => (a.tier === b.tier ? a.id.localeCompare(b.id) : a.tier === "core" ? -1 : 1));
  const shown = rows.filter(r => tier === "all" || r.tier === tier);

  if (json) {
    out(JSON.stringify(shown, null, 2));
    return 0;
  }
  out(`${BIN} skills (${tier}) — ${shown.length} shown`);
  out(`${"ID".padEnd(30)} ${"TIER".padEnd(8)} ${"SOURCE".padEnd(12)} ${"MODE".padEnd(10)} ${"CLAUDE".padEnd(16)} CODEX`);
  for (const r of shown) {
    out(`${r.id.padEnd(30)} ${r.tier.padEnd(8)} ${String(r.provenance).padEnd(12)} ${(r.explicit_only ? "explicit" : "auto").padEnd(10)} ${r.exposure.claude.padEnd(16)} ${r.exposure.codex}`);
  }
  out("Core list is provisional (scripts/lib/oh-my-ai-core-skills.mjs). Exposure = link state in each runtime's skills dir.");
  return 0;
}

// ---------- help ----------

function cmdHelp({ out }) {
  out(`usage: ${BIN} <command> [options]   (${ALIAS} is a compatibility alias of the same entry)`);
  out("");
  out("  version [--version]          VERSION + git SHA (+dirty)");
  out("  status [--json]              한 화면 요약 (읽기 전용)");
  out("  doctor [--strict]            setup.sh --doctor / --doctor-dev-main-flow 위임 + 수정 안내");
  out("  install [--profile N] [--dev-main-flow [--with-handoff] [--with-record-sync] [--with-spec]] [--apply]");
  out("                               기본 dry-run. --apply 해야 변경 (setup.sh 위임, 기존 파일 보존)");
  out("  update [--ref REF] [--apply] fetch 후 비교 (기본 origin/master). --apply는 clean fast-forward만");
  out("  config list|get|set         ~/.config/oh-my-ai/config.json (update.policy, context.inject, context.preload)");
  out("  skills [--core|--library|--all] [--json]   Skill 목록, 출처, explicit-only, 노출 상태");
  out("  help                         이 도움말 (--help, -h 동일)");
  out("");
  out("내부 명령 (hook, context-checkpoint, work-start, jira-ticket, work-view)은 기존과 동일하게 동작합니다.");
  out("자세한 내용: docs/harness/cli.md");
  return 0;
}
