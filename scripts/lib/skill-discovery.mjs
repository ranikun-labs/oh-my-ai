#!/usr/bin/env node
// Skill 탐색의 단일 원본. Skill = SKILL.md를 가진 디렉터리.
// 소스는 skills/<n>/ (flat) 또는 skills/{core,library}/<n>/ (그룹) 어디에도 둘 수 있고,
// 소비자는 항상 평평한 목록만 본다. 그룹 디렉터리 자체는 Skill이 아니다.
//
//   node scripts/lib/skill-discovery.mjs --list [--root <dir>] [--format paths|json]
//   node scripts/lib/skill-discovery.mjs --check [--root <dir>]
//   node scripts/lib/skill-discovery.mjs --resolve <id> [--root <dir>]   (절대 Source 디렉터리 1개 출력)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 그룹 디렉터리는 컨테이너일 뿐이다. 여기에 없는 이름은 depth 1 Skill로만 취급한다.
export const RESERVED_GROUPS = Object.freeze(["core", "library"]);
// skills/ 바로 아래 SKILL.md 없이 존재해도 되는 디렉터리 (현재 없음). 추가 시 사유를 남긴다.
export const NON_SKILL_DIRS = Object.freeze([]);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");

// 반환: { skills: [{name, dir, relPath, skillFile}], errors: string[], warnings: string[] }
// errors가 하나라도 있으면 소비자는 실패해야 한다(조용한 누락 방지). warnings는 로그만 남긴다.
export function discoverSkills(repoRoot = DEFAULT_REPO_ROOT) {
  const root = path.resolve(repoRoot);
  const skillsDir = path.join(root, "skills");
  const result = { skills: [], errors: [], warnings: [] };

  if (!isDirectory(skillsDir)) {
    result.errors.push(`skills/ directory not found under ${root}`);
    return result;
  }

  const found = [];
  const links = [];
  const rel = file => path.relative(root, file);

  for (const entry of readDir(skillsDir)) {
    const full = path.join(skillsDir, entry.name);
    if (entry.isSymbolicLink()) {
      links.push(full);
      continue;
    }
    if (!entry.isDirectory()) continue; // skill-index.json 등 파일은 Skill이 아니다
    if (RESERVED_GROUPS.includes(entry.name)) {
      scanGroup(full, entry.name);
      continue;
    }
    if (NON_SKILL_DIRS.includes(entry.name)) continue;
    if (fs.existsSync(path.join(full, "SKILL.md"))) {
      addSkill(full, entry.name);
    } else {
      result.errors.push(`${rel(full)}/: directory has no SKILL.md (add SKILL.md, move it into a group, or allow-list it in NON_SKILL_DIRS)`);
    }
  }

  // 심볼릭 링크는 실제 Skill이 모두 모인 뒤에 분류한다. 레포 안 실제 Skill을 가리키는 별칭은 중복이 아니므로 조용히 건너뛴다.
  const realSkills = new Set(found.map(skill => skill.real));
  for (const linkPath of links) {
    const display = rel(linkPath);
    let target;
    try {
      target = fs.realpathSync(linkPath);
    } catch {
      result.warnings.push(`${display} is a dangling symlink; skipped`);
      continue;
    }
    if (!isDirectory(target)) {
      result.warnings.push(`${display} does not point to a directory; skipped`);
      continue;
    }
    if (realSkills.has(target)) continue;
    result.warnings.push(`${display} points outside skills/ or to a non-skill path; skipped`);
  }

  const seen = new Map();
  for (const skill of found) {
    if (seen.has(skill.name)) {
      result.errors.push(`duplicate skill name "${skill.name}": ${seen.get(skill.name).relPath} and ${skill.relPath}`);
    } else {
      seen.set(skill.name, skill);
    }
  }

  result.skills = found
    .sort((a, b) => compare(a.name, b.name) || compare(a.relPath, b.relPath))
    .map(({ name, dir, relPath, skillFile }) => ({ name, dir, relPath, skillFile }));
  return result;

  function scanGroup(groupDir, group) {
    if (fs.existsSync(path.join(groupDir, "SKILL.md"))) {
      result.errors.push(`${rel(groupDir)}/SKILL.md: reserved group "${group}" is a container and cannot be a skill`);
    }
    for (const entry of readDir(groupDir)) {
      const full = path.join(groupDir, entry.name);
      if (entry.isSymbolicLink()) {
        links.push(full);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(full, "SKILL.md"))) {
        addSkill(full, entry.name);
      } else {
        result.errors.push(`${rel(full)}/: directory has no SKILL.md (groups hold skills at depth 2 only)`);
      }
    }
  }

  function addSkill(dir, dirName) {
    const skillFile = path.join(dir, "SKILL.md");
    const relPath = rel(skillFile);
    const name = readFrontmatterName(skillFile, relPath, result.errors);
    if (name === null) return;
    if (name !== dirName) {
      result.errors.push(`${relPath}: frontmatter name "${name}" must match directory "${dirName}"`);
    }
    found.push({ name, dir, relPath, skillFile, real: fs.realpathSync(dir) });
  }
}

// Skill ID(= 디렉터리 이름)로 Source 디렉터리를 하나 찾는다.
// 실패: 해당 ID가 없거나 여러 개이거나, 해당 ID의 디렉터리 자체에 발견 오류가 있을 때.
// 다른 Skill의 오류는 실패로 막지 않는다(한 개의 선택 Skill 누락이 다른 Skill 설치를 막지 않게 함).
// 전체 트리 오류는 check-skill-source-boundary / --check 가 계속 실패시킨다(조용한 누락 방지는 그쪽이 담당).
// 설치기는 이 결과만 Source로 쓰고, 경로 문자열(skills/<id>)을 직접 조립하지 않는다.
export function resolveSkill(repoRoot, id) {
  const discovery = discoverSkills(repoRoot);
  const matches = discovery.skills.filter(skill => skill.name === id);
  if (matches.length !== 1) {
    return { ok: false, errors: [`skill "${id}" must resolve to exactly one source under ${path.resolve(repoRoot)} (found ${matches.length})`] };
  }
  const skill = matches[0];
  const related = discovery.errors.filter(error => error.includes(skill.relPath) || error.includes(`/${id}/`) || error.includes(`"${id}"`));
  if (related.length > 0) {
    return { ok: false, errors: related };
  }
  return { ok: true, skill, otherErrors: discovery.errors.filter(error => !related.includes(error)) };
}

function readFrontmatterName(file, relPath, errors) {
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch (error) {
    errors.push(`${relPath}: unreadable (${error.code ?? error.message})`);
    return null;
  }
  if (lines[0] !== "---") {
    errors.push(`${relPath}: missing frontmatter start`);
    return null;
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    errors.push(`${relPath}: missing frontmatter end`);
    return null;
  }
  const nameLine = lines.slice(1, end).find(line => line.startsWith("name:"));
  if (nameLine === undefined) {
    errors.push(`${relPath}: missing frontmatter key "name"`);
    return null;
  }
  return unquote(nameLine.slice("name:".length).trim());
}

function readDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name));
}

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function unquote(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

// 코드 유닛 순서. 로케일에 따라 정렬이 달라지지 않도록 고정한다.
function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function parseArgs(argv) {
  const opts = { mode: null, root: DEFAULT_REPO_ROOT, format: "paths" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list" || arg === "--check") {
      opts.mode = arg.slice(2);
    } else if (arg === "--resolve") {
      if (!argv[i + 1]) throw new Error("--resolve requires a skill id");
      opts.mode = "resolve";
      opts.id = argv[i + 1];
      i += 1;
    } else if (arg === "--root") {
      if (!argv[i + 1]) throw new Error("--root requires a directory");
      opts.root = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--root=")) {
      opts.root = path.resolve(arg.slice("--root=".length));
    } else if (arg === "--format") {
      opts.format = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--format=")) {
      opts.format = arg.slice("--format=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!opts.mode) throw new Error("usage: skill-discovery.mjs (--list [--format paths|json] | --check | --resolve <id>) [--root <dir>]");
  if (!["paths", "json"].includes(opts.format)) throw new Error("--format must be paths or json");
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  if (opts.mode === "resolve") {
    const resolved = resolveSkill(opts.root, opts.id);
    if (!resolved.ok) {
      for (const error of resolved.errors) console.error(`error: ${error}`);
      return 1;
    }
    for (const error of resolved.otherErrors) console.error(`warning: unrelated to "${opts.id}": ${error}`);
    console.log(resolved.skill.dir);
    return 0;
  }

  const result = discoverSkills(opts.root);
  for (const warning of result.warnings) console.error(`warning: ${warning}`);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`error: ${error}`);
    return 1;
  }

  if (opts.mode === "check") {
    console.log(`skill-discovery: OK (${result.skills.length} skills)`);
    return 0;
  }
  if (opts.format === "json") {
    console.log(JSON.stringify(result.skills, null, 2));
  } else {
    for (const skill of result.skills) console.log(skill.relPath);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
