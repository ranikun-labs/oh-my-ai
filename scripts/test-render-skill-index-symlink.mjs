#!/usr/bin/env node
// Fixture test for scripts/render-skill-index.mjs symlink handling.
// Real skill dirs are canonical; a symlink alias inside skills/ is skipped silently;
// an external or dangling symlink is skipped with a stderr warning (no failure).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderer = path.join(repoRoot, "scripts", "render-skill-index.mjs");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "render-skill-index-symlink-"));
const root = path.join(work, "root");
const external = path.join(work, "external");
const skillsDir = path.join(root, "skills");

try {
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(external, { recursive: true });

  writeSkill(path.join(skillsDir, "alpha"), "alpha");
  writeSkill(path.join(skillsDir, "beta"), "beta");
  writeSkill(path.join(external, "ext-skill"), "ext-skill");

  // alias of a real skill inside skills/: must not produce a duplicate entry
  fs.symlinkSync(path.join(skillsDir, "alpha"), path.join(skillsDir, "gamma"), "dir");
  // symlink pointing outside the repo tree: skipped with a warning
  fs.symlinkSync(path.join(external, "ext-skill"), path.join(skillsDir, "delta"), "dir");
  // dangling symlink: skipped with a warning, must not crash the renderer
  fs.symlinkSync(path.join(external, "missing"), path.join(skillsDir, "dangling"), "dir");

  const run = spawnSync(process.execPath, [renderer, "--root", root], { encoding: "utf8" });
  assert.equal(run.status, 0, `renderer exited ${run.status}: ${run.stderr}`);

  const index = JSON.parse(fs.readFileSync(path.join(skillsDir, "skill-index.json"), "utf8"));
  const names = index.skills.map(skill => skill.name).sort();
  assert.deepEqual(names, ["alpha", "beta"], "only real skills, each once");

  assert.match(run.stderr, /delta[^\n]*skipped/, "external symlink must warn");
  assert.match(run.stderr, /dangling[^\n]*dangling symlink/, "dangling symlink must warn");
  assert.doesNotMatch(run.stderr, /gamma/, "in-tree alias must be skipped silently");
  assert.ok(!names.includes("ext-skill"), "external target must not be indexed");

  console.log("render-skill-index symlink fixtures: PASS");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

function writeSkill(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${name} fixture skill`,
    "metadata:",
    "  source: born-here",
    `  summary: ${name} fixture`,
    "  routing:",
    "    visibility: optional",
    "    risk_level: low",
    "    task_types:",
    "      - test",
    "    triggers:",
    "      - kind: keyword",
    "        values:",
    `          - ${name}`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n"));
}
