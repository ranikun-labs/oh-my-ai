#!/usr/bin/env node
// Fixture tests for scripts/lib/skill-discovery.mjs and its consumers.
// Covers: flat + core/library layouts, symlink aliases vs external/dangling links,
// invariant errors (no SKILL.md, duplicate names, group-as-skill, name mismatch),
// CLI exit codes, and a regression that moving a real skill into library/ keeps it indexed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "./lib/skill-discovery.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "scripts", "lib", "skill-discovery.mjs");
const renderer = path.join(repoRoot, "scripts", "render-skill-index.mjs");
const gate = path.join(repoRoot, "scripts", "check-skill-source-boundary.mjs");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "skill-discovery-"));
let counter = 0;

try {
  testPositiveLayout();
  testNoSkillFileIsError();
  testDuplicateNameIsError();
  testGroupCannotBeSkill();
  testNameMismatchIsError();
  testCli();
  testRealTreeRegression();
  console.log("skill-discovery fixtures: PASS");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

function newRoot(label) {
  const root = path.join(work, `${label}-${counter += 1}`);
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
  return root;
}

function writeSkill(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${name} fixture skill`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n"));
}

function testPositiveLayout() {
  const root = newRoot("positive");
  const skills = path.join(root, "skills");
  const external = path.join(work, "external-positive");
  writeSkill(path.join(skills, "flat-one"), "flat-one");
  writeSkill(path.join(skills, "core", "core-one"), "core-one");
  writeSkill(path.join(skills, "library", "lib-one"), "lib-one");
  writeSkill(path.join(external, "ext-skill"), "ext-skill");
  fs.writeFileSync(path.join(skills, "skill-index.json"), "{}\n");
  fs.symlinkSync(path.join(skills, "flat-one"), path.join(skills, "alias-flat"), "dir");
  fs.symlinkSync(path.join(skills, "library", "lib-one"), path.join(skills, "core", "alias-lib"), "dir");
  fs.symlinkSync(path.join(external, "ext-skill"), path.join(skills, "external-link"), "dir");
  fs.symlinkSync(path.join(external, "missing"), path.join(skills, "dangling-link"), "dir");

  const result = discoverSkills(root);
  assert.deepEqual(result.errors, [], "valid layout must produce no errors");
  assert.deepEqual(
    result.skills.map(skill => [skill.name, skill.relPath]),
    [
      ["core-one", "skills/core/core-one/SKILL.md"],
      ["flat-one", "skills/flat-one/SKILL.md"],
      ["lib-one", "skills/library/lib-one/SKILL.md"],
    ],
    "skills sorted by name; groups and aliases never listed twice; groups not skills",
  );
  const warnings = result.warnings.join("\n");
  assert.match(warnings, /external-link[^\n]*points outside/, "external symlink must warn");
  assert.match(warnings, /dangling-link[^\n]*dangling symlink/, "dangling symlink must warn");
  assert.doesNotMatch(warnings, /alias-/, "in-repo alias must be skipped silently");
  assert.doesNotMatch(warnings, /skill-index\.json/, "plain files under skills/ are ignored");
  console.log("ok: positive layout (flat, core, library, aliases, external, dangling)");
}

function testNoSkillFileIsError() {
  const root = newRoot("no-skill");
  writeSkill(path.join(root, "skills", "ok-skill"), "ok-skill");
  fs.mkdirSync(path.join(root, "skills", "orphan"));
  fs.writeFileSync(path.join(root, "skills", "orphan", "notes.md"), "x\n");
  const result = discoverSkills(root);
  assert.ok(result.errors.some(error => /skills\/orphan\/: directory has no SKILL\.md/.test(error)), result.errors.join("\n"));
  console.log("ok: directory without SKILL.md is an error");
}

function testDuplicateNameIsError() {
  const root = newRoot("duplicate");
  writeSkill(path.join(root, "skills", "dup"), "dup");
  writeSkill(path.join(root, "skills", "library", "dup"), "dup");
  const result = discoverSkills(root);
  assert.ok(result.errors.some(error => /duplicate skill name "dup"/.test(error)), result.errors.join("\n"));
  console.log("ok: duplicate name across roots is an error");
}

function testGroupCannotBeSkill() {
  const root = newRoot("group-skill");
  writeSkill(path.join(root, "skills", "core", "child"), "child");
  writeSkill(path.join(root, "skills", "core"), "core");
  const result = discoverSkills(root);
  assert.ok(result.errors.some(error => /skills\/core\/SKILL\.md: reserved group "core"/.test(error)), result.errors.join("\n"));
  console.log("ok: reserved group containing SKILL.md is an error");
}

function testNameMismatchIsError() {
  const root = newRoot("mismatch");
  writeSkill(path.join(root, "skills", "dir-name"), "other-name");
  const result = discoverSkills(root);
  assert.ok(result.errors.some(error => /must match directory "dir-name"/.test(error)), result.errors.join("\n"));
  console.log("ok: frontmatter name must match directory");
}

function testCli() {
  const good = newRoot("cli-good");
  writeSkill(path.join(good, "skills", "core", "a-skill"), "a-skill");
  const list = spawnSync(process.execPath, [cli, "--list", "--root", good, "--format", "paths"], { encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, "skills/core/a-skill/SKILL.md\n");

  const check = spawnSync(process.execPath, [cli, "--check", "--root", good], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /OK \(1 skills\)/);

  const bad = newRoot("cli-bad");
  fs.mkdirSync(path.join(bad, "skills", "orphan"));
  const failed = spawnSync(process.execPath, [cli, "--check", "--root", bad], { encoding: "utf8" });
  assert.equal(failed.status, 1, "--check must exit 1 on invariant errors");
  assert.match(failed.stderr, /error: .*orphan/);

  const usage = spawnSync(process.execPath, [cli, "--root", good], { encoding: "utf8" });
  assert.equal(usage.status, 2, "missing mode must be a usage error");
  console.log("ok: CLI --list / --check exit codes");
}

// Regression: the real skills/ tree, with one skill physically moved into library/,
// must render the same entries (only the path changes) and pass the boundary gate.
function testRealTreeRegression() {
  const root = newRoot("real-tree");
  const realSkills = path.join(repoRoot, "skills");
  const copySkills = path.join(root, "skills");
  fs.cpSync(realSkills, copySkills, { recursive: true });

  const baseline = render(root);
  assert.equal(baseline.status, 0, baseline.stderr);
  const baselineIndex = JSON.parse(fs.readFileSync(path.join(copySkills, "skill-index.json"), "utf8"));
  const committed = fs.readFileSync(path.join(realSkills, "skill-index.json"), "utf8");
  assert.equal(fs.readFileSync(path.join(copySkills, "skill-index.json"), "utf8"), committed, "--root render of current tree must match committed index byte-for-byte");

  fs.mkdirSync(path.join(copySkills, "library"), { recursive: true });
  fs.renameSync(path.join(copySkills, "postgres"), path.join(copySkills, "library", "postgres"));

  const moved = render(root);
  assert.equal(moved.status, 0, `renderer must not fail on moved skill: ${moved.stderr}`);
  const movedIndex = JSON.parse(fs.readFileSync(path.join(copySkills, "skill-index.json"), "utf8"));
  assert.equal(movedIndex.skills.length, baselineIndex.skills.length, "moving postgres must not drop any indexed skill");

  const entry = movedIndex.skills.find(skill => skill.name === "postgres");
  assert.ok(entry, "postgres must still be indexed after the move");
  assert.equal(entry.path, "skills/library/postgres/SKILL.md");

  const stripped = movedIndex.skills.map(({ path: p, ...rest }) => rest);
  const originalStripped = baselineIndex.skills.map(({ path: p, ...rest }) => rest);
  assert.deepEqual(stripped, originalStripped, "only the path field may change");

  const gateRun = spawnSync(process.execPath, [gate, "--root", root], { encoding: "utf8" });
  assert.equal(gateRun.status, 0, `boundary gate must pass after a rendered move: ${gateRun.stdout}${gateRun.stderr}`);

  // Stale index (postgres dropped) must be caught by the independent gate.
  movedIndex.skills = movedIndex.skills.filter(skill => skill.name !== "postgres");
  fs.writeFileSync(path.join(copySkills, "skill-index.json"), `${JSON.stringify(movedIndex, null, 2)}\n`);
  const staleRun = spawnSync(process.execPath, [gate, "--root", root], { encoding: "utf8" });
  assert.equal(staleRun.status, 1, "gate must fail when a routed skill is missing from the index");
  assert.match(`${staleRun.stdout}${staleRun.stderr}`, /postgres/);
  console.log("ok: real tree regression (postgres -> library/) and boundary gate");
}

function render(root) {
  return spawnSync(process.execPath, [renderer, "--root", root], { encoding: "utf8" });
}
