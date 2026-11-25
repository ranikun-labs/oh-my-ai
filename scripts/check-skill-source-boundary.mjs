#!/usr/bin/env node
// Independent gate: a Skill that carries routing metadata must appear in skills/skill-index.json,
// wherever its source lives (flat or core/library). Moving a skill must never silently drop it.
// Not part of cascade-check; run via `make test-skill-discovery`.
//
//   node scripts/check-skill-source-boundary.mjs [--root <dir>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REPO_ROOT, discoverSkills } from "./lib/skill-discovery.mjs";

export function checkSkillSourceBoundary(repoRoot = DEFAULT_REPO_ROOT) {
  const root = path.resolve(repoRoot);
  const problems = [];

  const discovery = discoverSkills(root);
  problems.push(...discovery.errors);

  const indexFile = path.join(root, "skills", "skill-index.json");
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  } catch (error) {
    return { ok: false, problems: [...problems, `cannot read skills/skill-index.json: ${error.message}`] };
  }

  // routing 블록 존재 여부는 render-skill-index와 같은 규칙(frontmatter 안의 2칸 들여쓴 routing:)으로 판정한다.
  const expected = discovery.skills.filter(skill => hasRoutingBlock(fs.readFileSync(skill.skillFile, "utf8")));
  const expectedPaths = new Set(expected.map(skill => skill.relPath));
  const indexedPaths = new Set(index.skills.map(skill => skill.path));

  for (const skill of expected) {
    if (!indexedPaths.has(skill.relPath)) {
      problems.push(`routed skill "${skill.name}" (${skill.relPath}) is missing from skill-index.json`);
    }
  }
  for (const entry of index.skills) {
    if (!expectedPaths.has(entry.path)) {
      problems.push(`skill-index.json entry "${entry.name}" (${entry.path}) does not match a discovered routed skill`);
    }
  }

  if (index.skills.length !== expected.length) {
    problems.push(`index count ${index.skills.length} != routed skill count ${expected.length}`);
  }
  return { ok: problems.length === 0, problems, count: expected.length };
}

function hasRoutingBlock(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return false;
  const end = lines.indexOf("---", 1);
  if (end === -1) return false;
  return lines.slice(1, end).some(line => /^ {2}routing:/.test(line));
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
    result = checkSkillSourceBoundary(parseRoot(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
  if (result) {
    if (result.ok) {
      console.log(`skill-source-boundary: OK (${result.count} routed skills indexed)`);
    } else {
      for (const problem of result.problems) console.error(`FAIL: ${problem}`);
      process.exitCode = 1;
    }
  }
}
