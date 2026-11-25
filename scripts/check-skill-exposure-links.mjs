#!/usr/bin/env node
// 런타임 노출 링크 검사: .claude/skills/<id>, .agents/skills/<id> 가 발견된 Skill Source를 가리키는지 확인한다.
// 목적: Source를 skills/<id> 에서 skills/{core,library}/<id> 로 옮겨도 노출 경로(<id>)와 링크 구조가 깨지지 않게 한다.
// 링크 대상 경로를 문자열로 고정하지 않고, realpath가 discovery가 찾은 Source 디렉터리와 같은지로 판정한다.
//
//   node scripts/check-skill-exposure-links.mjs [--root <dir>]
//
// 이 검사는 링크 구조만 본다. Claude/Codex의 Native Skill 발견·호출 성공은 증명하지 않는다.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DEFAULT_REPO_ROOT, discoverSkills } from "./lib/skill-discovery.mjs";
import { DEPENDENCY_MISSING_EXIT_CODE, missingYamlDependency } from "./lib/yaml-dependency.mjs";

// 고정 YAML 파서는 import 시점이 아니라 검사 시점에 로드한다. 미설치여도 모듈 import 자체는 실패하지 않고 DEPENDENCY_MISSING 으로 보고하기 위함.
const require = createRequire(import.meta.url);
let frontmatterValidator = null;
function validateSkillFrontmatter(frontmatter, name) {
  frontmatterValidator ??= require("./lib/skill-frontmatter-validation.cjs").validateSkillFrontmatter;
  return frontmatterValidator(frontmatter, name);
}

export const EXPOSURE_DIRS = Object.freeze([".claude/skills", ".agents/skills"]);

export function checkExposureLinks(repoRoot = DEFAULT_REPO_ROOT) {
  const root = path.resolve(repoRoot);
  const problems = [];
  const counts = {};

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
      if (seenIds.has(normalized)) {
        problems.push(`${label} duplicate exposure id (also ${seenIds.get(normalized)})`);
        continue;
      }
      seenIds.set(normalized, id);
      const problem = checkEntry(root, dir, entry, sourceByReal);
      if (problem) problems.push(`${label} ${problem}`);
    }
  }

  return { ok: problems.length === 0, problems, counts };
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

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return DEFAULT_REPO_ROOT;
  if (!argv[index + 1]) throw new Error("--root requires a directory");
  return path.resolve(argv[index + 1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = checkExposureLinks(parseRoot(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
  if (result) {
    if (result.ok) {
      const summary = Object.entries(result.counts).map(([dir, n]) => `${dir}=${n}`).join(", ");
      console.log(`skill-exposure-links: OK (${summary})`);
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
