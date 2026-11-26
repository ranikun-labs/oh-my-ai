#!/usr/bin/env node
// 런타임 노출 링크 검사: .claude/skills/<id>, .agents/skills/<id> 가 발견된 Skill Source를 가리키는지 확인한다.
// 목적: Source를 skills/<id> 에서 skills/{core,library}/<id> 로 옮겨도 노출 경로(<id>)와 링크 구조가 깨지지 않게 한다.
// 링크 대상 경로를 문자열로 고정하지 않고, realpath가 discovery가 찾은 Source 디렉터리와 같은지로 판정한다.
//
//   node scripts/check-skill-exposure-links.mjs [--root <dir>] [--baseline <file|git-ref>]
//
// --baseline: 이동 전 노출 ID 기준선. 파일(줄마다 `.claude/skills/<id>` 또는 `.agents/skills/<id>`)이거나
//             git ref(예: HEAD)면 그 ref의 노출 링크 목록을 쓴다. 기준선의 모든 ID가 현재 트리에 남아 있어야 하며,
//             없어진 ID는 이름과 함께 FAIL 한다. (기준선 없이는 "남은 링크가 멀쩡한지"만 보므로 유실을 잡지 못한다.)
//
// 이 검사는 링크 구조만 본다. Claude/Codex의 Native Skill 발견·호출 성공은 증명하지 않는다.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DEFAULT_REPO_ROOT, discoverSkills, isEntrypoint } from "./lib/skill-discovery.mjs";
import { DEPENDENCY_MISSING_EXIT_CODE, missingYamlDependency } from "./lib/yaml-dependency.mjs";

// 고정 YAML 파서는 import 시점이 아니라 검사 시점에 로드한다. 미설치여도 모듈 import 자체는 실패하지 않고 DEPENDENCY_MISSING 으로 보고하기 위함.
const require = createRequire(import.meta.url);
let frontmatterValidator = null;
function validateSkillFrontmatter(frontmatter, name) {
  frontmatterValidator ??= require("./lib/skill-frontmatter-validation.cjs").validateSkillFrontmatter;
  return frontmatterValidator(frontmatter, name);
}

export const EXPOSURE_DIRS = Object.freeze([".claude/skills", ".agents/skills"]);
const EXPOSURE_KEY = /^(\.claude\/skills|\.agents\/skills)\/([^/]+)/;

// 노출 디렉터리의 모든 항목을 `<rel>/<id>` 키로 모은다. 이동 전 트리에서 호출해 기준선으로 쓴다.
export function captureExposureBaseline(repoRoot = DEFAULT_REPO_ROOT) {
  const root = path.resolve(repoRoot);
  const keys = [];
  for (const rel of EXPOSURE_DIRS) {
    let names;
    try {
      names = fs.readdirSync(path.join(root, rel));
    } catch {
      continue;
    }
    for (const name of names) keys.push(`${rel}/${name.normalize("NFC")}`);
  }
  return keys.sort();
}

// --baseline 값을 키 목록으로 바꾼다. 존재하는 파일이면 줄 단위로, 아니면 git ref로 ls-tree 한다.
export function loadBaseline(spec, repoRoot = DEFAULT_REPO_ROOT) {
  const file = path.resolve(spec);
  if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    return parseBaselineLines(fs.readFileSync(file, "utf8").split(/\r?\n/), spec, { trim: true });
  }
  // -z: 경로를 NUL 구분 원문으로 받는다. 없으면 한글 등 비ASCII 이름이 "\355\225\234..." 로 따옴표 이스케이프돼 파싱이 실패한다.
  const listed = spawnSync("git", ["-C", path.resolve(repoRoot), "ls-tree", "-r", "-z", "--name-only", spec, "--", ...EXPOSURE_DIRS], { encoding: "utf8" });
  if (listed.status !== 0) {
    throw new Error(`--baseline: "${spec}" is neither a file nor a git ref (${listed.stderr.trim() || "git ls-tree failed"})`);
  }
  return parseBaselineLines(listed.stdout.split("\0"), spec, { trim: false });
}

function parseBaselineLines(lines, spec, { trim }) {
  const keys = new Set();
  for (const raw of lines) {
    const line = trim ? raw.trim() : raw;
    if (line === "" || line.startsWith("#")) continue;
    const match = EXPOSURE_KEY.exec(line);
    if (!match) throw new Error(`--baseline "${spec}": not an exposure link path: ${line}`);
    keys.add(`${match[1]}/${match[2].normalize("NFC")}`);
  }
  if (keys.size === 0) throw new Error(`--baseline "${spec}": no exposure links listed (an empty baseline proves nothing)`);
  return [...keys].sort();
}

export function checkExposureLinks(repoRoot = DEFAULT_REPO_ROOT, options = {}) {
  const root = path.resolve(repoRoot);
  const problems = [];
  const counts = {};
  const presentKeys = new Set();

  const dependency = missingYamlDependency(DEFAULT_REPO_ROOT);
  if (dependency) return { ok: false, problems: [dependency], counts, dependencyMissing: true };

  // discovery 오류가 있으면 Source 집합 자체를 믿을 수 없으므로 그대로 실패시킨다.
  const discovery = discoverSkills(root);
  if (discovery.errors.length > 0) {
    return { ok: false, problems: discovery.errors, counts };
  }
  // 발견된 Source를 realpath로 색인한다. 링크 대상이 이 목록 밖이면 실패한다.
  const sourceByReal = new Map();
  for (const skill of discovery.skills) {
    sourceByReal.set(fs.realpathSync(skill.dir), skill);
  }

  for (const rel of EXPOSURE_DIRS) {
    const dir = path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      problems.push(`${rel}: cannot read directory (${error.code ?? error.message})`);
      continue;
    }
    if (entries.length === 0) {
      problems.push(`${rel}: no exposure links to check (directory is empty or was lost)`);
      continue;
    }
    counts[rel] = entries.length;

    const seenIds = new Map();
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      const id = entry.name;
      const label = `[${rel}/${id}]`;
      // 같은 노출 디렉터리 안에서 유니코드 정규화만 다른 이름(NFC/NFD)은 중복으로 본다.
      const normalized = id.normalize("NFC");
      presentKeys.add(`${rel}/${normalized}`);
      if (seenIds.has(normalized)) {
        problems.push(`${label} duplicate exposure id (also ${seenIds.get(normalized)})`);
        continue;
      }
      seenIds.set(normalized, id);
      const problem = checkEntry(root, dir, entry, sourceByReal);
      if (problem) problems.push(`${label} ${problem}`);
    }
  }

  // 기준선의 ID가 하나라도 사라졌으면 실패한다. 남은 링크가 멀쩡해도 유실은 유실이다.
  if (options.baseline) {
    const missing = options.baseline.filter(key => !presentKeys.has(key));
    if (missing.length > 0) {
      problems.push(`baseline exposure link(s) missing (${missing.length}): ${missing.join(", ")}`);
    }
  }

  return { ok: problems.length === 0, problems, counts, baselineCount: options.baseline ? options.baseline.length : null };
}

function checkEntry(root, dir, entry, sourceByReal) {
  const linkPath = path.join(dir, entry.name);
  if (!entry.isSymbolicLink()) {
    return entry.isDirectory()
      ? "is a real directory copy; must be a symbolic link to the Skill source"
      : "is a regular file; must be a symbolic link to the Skill source";
  }
  const target = fs.readlinkSync(linkPath);
  if (path.isAbsolute(target)) {
    return `is an absolute link (${target}); must be a relative link`;
  }
  let real;
  try {
    real = fs.realpathSync(linkPath);
  } catch (error) {
    if (error.code === "ENOENT") return `is a dangling link (${target})`;
    throw error;
  }
  const source = sourceByReal.get(real);
  if (!source) {
    return `points outside the discovered Skill sources (${target})`;
  }
  if (source.name !== entry.name) {
    return `id mismatch: exposed as "${entry.name}" but the target Skill is "${source.name}" (${path.relative(root, source.dir)})`;
  }
  const linkedSkill = path.join(linkPath, "SKILL.md");
  if (!fs.statSync(linkedSkill, { throwIfNoEntry: false })?.isFile()) {
    return "has no readable SKILL.md through the link";
  }
  const frontmatter = frontmatterText(linkedSkill);
  if (frontmatter === null) return "SKILL.md has no frontmatter";
  try {
    validateSkillFrontmatter(frontmatter, entry.name);
  } catch (error) {
    return error.message;
  }
  return null;
}

function frontmatterText(file) {
  const match = fs.readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1] : null;
}

function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function parseArgs(argv) {
  const options = { root: DEFAULT_REPO_ROOT, baseline: null };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag !== "--root" && flag !== "--baseline") throw new Error(`unknown argument: ${flag}`);
    if (!argv[i + 1]) throw new Error(`${flag} requires a value`);
    if (flag === "--root") options.root = path.resolve(argv[i + 1]);
    else options.baseline = argv[i + 1];
  }
  return options;
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  let result;
  try {
    const options = parseArgs(process.argv.slice(2));
    const baseline = options.baseline === null ? null : loadBaseline(options.baseline, options.root);
    result = checkExposureLinks(options.root, { baseline });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
  if (result) {
    if (result.ok) {
      const summary = Object.entries(result.counts).map(([dir, n]) => `${dir}=${n}`).join(", ");
      const baselineNote = result.baselineCount === null ? "" : `; baseline=${result.baselineCount} id(s) present`;
      console.log(`skill-exposure-links: OK (${summary}${baselineNote})`);
      console.log("This check validates link structure only; it does not prove Native Skill discovery or invocation.");
    } else if (result.dependencyMissing) {
      console.error(result.problems[0]);
      process.exitCode = DEPENDENCY_MISSING_EXIT_CODE;
    } else {
      for (const problem of result.problems) console.error(`FAIL: ${problem}`);
      process.exitCode = 1;
    }
  }
}
