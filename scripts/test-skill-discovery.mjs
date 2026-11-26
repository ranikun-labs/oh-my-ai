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
import { coreIdsOf, discoverSkills } from "./lib/skill-discovery.mjs";
import { captureExposureBaseline, checkExposureLinks, loadBaseline } from "./check-skill-exposure-links.mjs";
import { DEPENDENCY_MISSING_EXIT_CODE, missingYamlDependency } from "./lib/yaml-dependency.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "scripts", "lib", "skill-discovery.mjs");
const renderer = path.join(repoRoot, "scripts", "render-skill-index.mjs");
const gate = path.join(repoRoot, "scripts", "check-skill-source-boundary.mjs");
const exposureGate = path.join(repoRoot, "scripts", "check-skill-exposure-links.mjs");

// realpath 로 고정: 심링크 tmp(macOS /var → /private/var)에서도 CLI 진입점·경로 비교가 같은 문자열을 쓰게 한다.
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-discovery-")));
let counter = 0;

try {
  testPositiveLayout();
  testNoSkillFileIsError();
  testDuplicateNameIsError();
  testGroupCannotBeSkill();
  testNameMismatchIsError();
  testCli();
  testRealTreeRegression();
  testResolve();
  testExposureLinksPass();
  testExposureLinksFailures();
  testExposureLinksCli();
  testPilotDependencyMissing();
  testExposureBaselineLoss();
  testExposureBaselineCli();
  testExposureBaselineNonAscii();
  testExposureBaselineRealTree();
  testPilotGates();
  testTierPrecedence();
  console.log("skill-discovery fixtures: PASS");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

// Tier 우선순위: 물리 그룹 > metadata.tier > TRANSITIONAL_CORE_IDS > library 기본.
function testTierPrecedence() {
  const root = newRoot("tier");
  writeSkill(path.join(root, "skills", "core", "grouped-core"), "grouped-core");
  writeSkill(path.join(root, "skills", "library", "senior"), "senior"); // 과도기 목록에 있어도 물리 그룹이 이긴다
  writeTiered(path.join(root, "skills", "meta-core"), "meta-core", "core");
  writeTiered(path.join(root, "skills", "meta-lib"), "meta-lib", "library");
  writeSkill(path.join(root, "skills", "plain"), "plain");
  writeSkill(path.join(root, "skills", "library", "meta-in-group"), "meta-in-group");
  writeTiered(path.join(root, "skills", "core", "meta-in-group-x"), "meta-in-group-x", "library");
  const result = discoverSkills(root);
  const byName = Object.fromEntries(result.skills.map(s => [s.name, s]));
  assert.deepEqual([byName["grouped-core"].tier, byName["grouped-core"].tierSource], ["core", "group"]);
  assert.deepEqual([byName["meta-core"].tier, byName["meta-core"].tierSource], ["core", "metadata"]);
  assert.deepEqual([byName["meta-lib"].tier, byName["meta-lib"].tierSource], ["library", "metadata"]);
  assert.deepEqual([byName.plain.tier, byName.plain.tierSource], ["library", "default"]);
  assert.deepEqual([byName.senior.tier, byName.senior.tierSource], ["library", "group"]);
  assert.equal(byName["meta-in-group-x"].tier, "core");
  assert.equal(byName["meta-in-group-x"].tierSource, "group");
  assert.ok(result.warnings.some(w => /meta-in-group-x.*ignored; physical group "core" wins/.test(w)));
  // 과도기 목록: 같은 이름이 flat 으로 있을 때만 manifest 경로 검증은 별도 root 로 한다
  const manifestRoot = newRoot("tier-manifest");
  writeSkill(path.join(manifestRoot, "skills", "senior"), "senior");
  const m = discoverSkills(manifestRoot).skills[0];
  assert.deepEqual([m.tier, m.tierSource], ["core", "manifest"]);
  // coreIdsOf: 과도기 ID가 library 그룹에 있으면 core 가 아니고 missing 도 아니다
  const coreIds = coreIdsOf(result).map(e => e.id);
  assert.ok(!coreIds.includes("senior"), "senior under library/ must not be core");
  // 잘못된 metadata.tier 값은 오류 (소비자 실패)
  const badRoot = newRoot("tier-bad");
  writeTiered(path.join(badRoot, "skills", "bad"), "bad", "gold");
  const bad = discoverSkills(badRoot);
  assert.ok(bad.errors.some(e => /metadata\.tier "gold" must be one of core\|library/.test(e)));
  console.log("ok: tier precedence (group > metadata > manifest > default) and invalid metadata.tier");
}

function writeTiered(dir, name, tier) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${name} fixture skill`,
    "metadata:",
    "  source: born-here",
    `  tier: ${tier}`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n"));
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

  const names = spawnSync(process.execPath, [cli, "--list", "--root", good, "--format", "names"], { encoding: "utf8" });
  assert.equal(names.status, 0, names.stderr);
  assert.equal(names.stdout, "a-skill\n", "names format lists Skill IDs only");

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

// --resolve: 그룹 Source도 ID 하나로 절대 디렉터리 하나를 돌려준다. 없음·발견 오류는 exit 1.
function testResolve() {
  const root = newRoot("resolve");
  writeSkill(path.join(root, "skills", "library", "lib-one"), "lib-one");
  writeSkill(path.join(root, "skills", "flat-one"), "flat-one");
  const grouped = spawnSync(process.execPath, [cli, "--resolve", "lib-one", "--root", root], { encoding: "utf8" });
  assert.equal(grouped.status, 0, grouped.stderr);
  assert.equal(grouped.stdout, `${path.join(root, "skills", "library", "lib-one")}\n`);
  const flat = spawnSync(process.execPath, [cli, "--resolve", "flat-one", "--root", root], { encoding: "utf8" });
  assert.equal(flat.stdout, `${path.join(root, "skills", "flat-one")}\n`);
  const missing = spawnSync(process.execPath, [cli, "--resolve", "nope", "--root", root], { encoding: "utf8" });
  assert.equal(missing.status, 1, "unknown id must exit 1");
  assert.match(missing.stderr, /skill "nope" must resolve to exactly one source/);
  assert.match(missing.stderr, /found 0/);

  writeSkill(path.join(root, "skills", "library", "flat-one"), "flat-one");
  const dup = spawnSync(process.execPath, [cli, "--resolve", "flat-one", "--root", root], { encoding: "utf8" });
  assert.equal(dup.status, 1, "duplicate id must exit 1, not pick one");
  assert.equal(dup.stdout, "");

  // 다른 Skill의 발견 오류는 이 ID의 Source 해석을 막지 않는다(경고로만 남긴다).
  const isolated = newRoot("resolve-isolated");
  writeSkill(path.join(isolated, "skills", "keep-me"), "keep-me");
  fs.mkdirSync(path.join(isolated, "skills", "broken-sibling"));
  const kept = spawnSync(process.execPath, [cli, "--resolve", "keep-me", "--root", isolated], { encoding: "utf8" });
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(kept.stdout, `${path.join(isolated, "skills", "keep-me")}\n`);
  assert.match(kept.stderr, /warning: unrelated to "keep-me": .*broken-sibling/);
  const broken = spawnSync(process.execPath, [cli, "--resolve", "broken-sibling", "--root", isolated], { encoding: "utf8" });
  assert.equal(broken.status, 1, "a skill whose own directory is broken must not resolve");
  console.log("ok: --resolve returns one absolute source; missing, duplicate and self-broken fail; sibling errors only warn");
}

function exposureRoot(label) {
  const root = newRoot(label);
  fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agents", "skills"), { recursive: true });
  writeSkill(path.join(root, "skills", "flat-a"), "flat-a");
  writeSkill(path.join(root, "skills", "library", "grouped-b"), "grouped-b");
  return root;
}

function relLink(root, exposureDir, id, targetDir) {
  const linkPath = path.join(root, exposureDir, id);
  fs.symlinkSync(path.relative(path.dirname(linkPath), targetDir), linkPath, "dir");
}

function testExposureLinksPass() {
  const root = exposureRoot("exposure-pass");
  relLink(root, ".claude/skills", "flat-a", path.join(root, "skills", "flat-a"));
  relLink(root, ".claude/skills", "grouped-b", path.join(root, "skills", "library", "grouped-b"));
  relLink(root, ".agents/skills", "flat-a", path.join(root, "skills", "flat-a"));
  relLink(root, ".agents/skills", "grouped-b", path.join(root, "skills", "library", "grouped-b"));
  const result = checkExposureLinks(root);
  assert.deepEqual(result.problems, [], result.problems.join("\n"));
  assert.equal(result.ok, true);
  console.log("ok: exposure links pass for flat and grouped sources in both runtime dirs");
}

function testExposureLinksFailures() {
  const expect = (label, setup, pattern) => {
    const root = exposureRoot(`exposure-${label}`);
    relLink(root, ".claude/skills", "flat-a", path.join(root, "skills", "flat-a"));
    relLink(root, ".agents/skills", "grouped-b", path.join(root, "skills", "library", "grouped-b"));
    setup(root);
    const result = checkExposureLinks(root);
    assert.equal(result.ok, false, `${label} must fail`);
    assert.ok(result.problems.some(problem => pattern.test(problem)), `${label}: ${result.problems.join(" | ")}`);
  };

  expect("dangling", root => relLink(root, ".claude/skills", "gone", path.join(root, "skills", "gone")), /\[\.claude\/skills\/gone\] is a dangling link/);
  expect("absolute", root => fs.symlinkSync(path.join(root, "skills", "flat-a"), path.join(root, ".claude", "skills", "abs-a"), "dir"), /abs-a\] is an absolute link/);
  expect("outside", root => {
    const external = path.join(work, `outside-${counter += 1}`, "ext");
    writeSkill(external, "ext");
    relLink(root, ".claude/skills", "ext", external);
  }, /\[\.claude\/skills\/ext\] points outside/);
  expect("id-mismatch", root => relLink(root, ".agents/skills", "wrong-id", path.join(root, "skills", "flat-a")), /wrong-id\] id mismatch: exposed as "wrong-id" but the target Skill is "flat-a"/);
  expect("real-copy", root => writeSkill(path.join(root, ".claude", "skills", "copied"), "copied"), /copied\] is a real directory copy/);
  expect("regular-file", root => fs.writeFileSync(path.join(root, ".claude", "skills", "plain"), "x\n"), /plain\] is a regular file/);
  // 대상은 심볼릭 링크다. rmSync(path) 는 일부 플랫폼(macOS Node 24.3)에서 링크 대상 디렉터리로 해석해 EISDIR 을 낸다.
  // 링크만 지우는 unlinkSync 를 쓴다 (대상 Skill 디렉터리는 건드리지 않는다).
  expect("empty-dir", root => fs.unlinkSync(path.join(root, ".claude", "skills", "flat-a")), /\.claude\/skills: no exposure links to check/);
  expect("missing-dir", root => fs.rmSync(path.join(root, ".agents", "skills"), { recursive: true, force: true }), /\.agents\/skills: cannot read directory/);
  expect("discovery-error", root => fs.mkdirSync(path.join(root, "skills", "orphan")), /skills\/orphan\/: directory has no SKILL\.md/);
  expect("duplicate-normalized", root => {
    writeSkill(path.join(root, "skills", "\uD55C\uAE00"), "\uD55C\uAE00");
    relLink(root, ".claude/skills", "\uD55C\uAE00", path.join(root, "skills", "\uD55C\uAE00"));
    relLink(root, ".claude/skills", "\u1112\u1161\u11AB\u1100\u1173\u11AF", path.join(root, "skills", "\uD55C\uAE00"));
  }, /duplicate exposure id/);
  console.log("ok: exposure link failures: dangling, absolute, outside, id mismatch, copy, file, empty, missing dir, discovery error, duplicate");
}

function testExposureLinksCli() {
  const good = exposureRoot("exposure-cli-good");
  relLink(good, ".claude/skills", "flat-a", path.join(good, "skills", "flat-a"));
  relLink(good, ".agents/skills", "flat-a", path.join(good, "skills", "flat-a"));
  const passed = spawnSync(process.execPath, [exposureGate, "--root", good], { encoding: "utf8" });
  assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);
  assert.match(passed.stdout, /skill-exposure-links: OK/);

  const bad = exposureRoot("exposure-cli-bad");
  relLink(bad, ".claude/skills", "gone", path.join(bad, "skills", "gone"));
  const failed = spawnSync(process.execPath, [exposureGate, "--root", bad], { encoding: "utf8" });
  assert.equal(failed.status, 1, "CLI must exit 1 on a dangling link");
  assert.match(failed.stderr, /FAIL: \[\.claude\/skills\/gone\]/);

  const real = spawnSync(process.execPath, [exposureGate], { encoding: "utf8" });
  assert.equal(real.status, 0, `repository exposure links must pass: ${real.stdout}${real.stderr}`);
  console.log("ok: exposure-link CLI exit codes, and the real repository passes");
}

// 고정 YAML 파서가 없으면 pilot-check 는 generic step FAIL 이 아니라 DEPENDENCY_MISSING(exit 3)으로 멈춰야 한다.
function testPilotDependencyMissing() {
  const hint = /^DEPENDENCY_MISSING: \.github\/ci\/yaml\/node_modules\/yaml not installed; fix: npm ci --prefix \.github\/ci\/yaml --ignore-scripts$/;
  const bare = newRoot("yaml-dep-missing");
  assert.match(missingYamlDependency(bare), hint);

  const installed = newRoot("yaml-dep-installed");
  fs.mkdirSync(path.join(installed, ".github", "ci", "yaml", "node_modules", "yaml"), { recursive: true });
  fs.writeFileSync(path.join(installed, ".github", "ci", "yaml", "node_modules", "yaml", "package.json"), "{\"name\":\"yaml\"}\n");
  assert.equal(missingYamlDependency(installed), null);

  // 실제 CLI: scripts/ 만 복사하고 node_modules 없이 실행 → 단계표 없이 DEPENDENCY_MISSING 으로 끝나야 한다.
  const copy = newRoot("yaml-dep-cli");
  fs.cpSync(path.join(repoRoot, "scripts"), path.join(copy, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(copy, ".github", "ci", "yaml"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, ".github", "ci", "yaml", "package.json"), path.join(copy, ".github", "ci", "yaml", "package.json"));
  const run = spawnSync(process.execPath, [path.join(copy, "scripts", "skill-pilot-check.mjs"), "senior", "core"], { encoding: "utf8" });
  assert.equal(run.status, DEPENDENCY_MISSING_EXIT_CODE, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /skill-pilot-check: DEPENDENCY_MISSING: /);
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /STEP|FAIL/, "must not report generic step results");
  console.log("ok: pilot-check reports DEPENDENCY_MISSING (exit 3) when the pinned YAML parser is absent");
}

// 이동 후 노출 링크 유실: 기준선(이동 전 ID)에 있던 링크가 사라지면 FAIL 해야 한다. 기준선이 없으면 남은 링크만 보고 통과한다(대조군).
function testExposureBaselineLoss() {
  const root = exposureBaselineRoot("exposure-baseline-loss");
  const baseline = captureExposureBaseline(root);
  assert.deepEqual(baseline, [".agents/skills/flat-a", ".claude/skills/flat-a", ".claude/skills/grouped-b"]);
  assert.equal(checkExposureLinks(root, { baseline }).ok, true);

  fs.unlinkSync(path.join(root, ".claude", "skills", "flat-a"));
  assert.equal(checkExposureLinks(root).ok, true, "without a baseline the remaining links still pass (loss is invisible)");
  const lost = checkExposureLinks(root, { baseline });
  assert.equal(lost.ok, false, "a baseline ID that disappeared must fail");
  assert.ok(lost.problems.some(p => /^baseline exposure link\(s\) missing \(1\): \.claude\/skills\/flat-a$/.test(p)), lost.problems.join(" | "));
  console.log("ok: exposure baseline: a link lost after the move FAILs and names the id; without a baseline it passes");
}

// CLI --baseline: 파일 기준선과 git ref 기준선 모두. 정상은 exit 0, 유실은 exit 1(ID 목록), 잘못된 기준선은 exit 2.
function testExposureBaselineCli() {
  const root = exposureBaselineRoot("exposure-baseline-cli");
  const baselineFile = path.join(work, `baseline-${counter += 1}.txt`);
  fs.writeFileSync(baselineFile, `${captureExposureBaseline(root).join("\n")}\n`);
  const gateArgs = file => [exposureGate, "--root", root, "--baseline", file];

  const passed = spawnSync(process.execPath, gateArgs(baselineFile), { encoding: "utf8" });
  assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);
  assert.match(passed.stdout, /skill-exposure-links: OK .*baseline=3 id\(s\) present/);

  fs.unlinkSync(path.join(root, ".claude", "skills", "flat-a"));
  const failed = spawnSync(process.execPath, gateArgs(baselineFile), { encoding: "utf8" });
  assert.equal(failed.status, 1, `${failed.stdout}${failed.stderr}`);
  assert.match(failed.stderr, /FAIL: baseline exposure link\(s\) missing \(1\): \.claude\/skills\/flat-a/);

  // git ref 기준선: 커밋된 상태의 노출 링크 목록을 쓴다.
  const gitRoot = exposureBaselineRoot("exposure-baseline-git");
  const git = ["-C", gitRoot, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
  assert.equal(spawnSync("git", [...git, "init", "-q"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", [...git, "add", "-A"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", [...git, "commit", "-q", "-m", "baseline"], { encoding: "utf8" }).status, 0);
  const viaRef = spawnSync(process.execPath, [exposureGate, "--root", gitRoot, "--baseline", "HEAD"], { encoding: "utf8" });
  assert.equal(viaRef.status, 0, `${viaRef.stdout}${viaRef.stderr}`);
  fs.unlinkSync(path.join(gitRoot, ".agents", "skills", "flat-a"));
  const viaRefLost = spawnSync(process.execPath, [exposureGate, "--root", gitRoot, "--baseline", "HEAD"], { encoding: "utf8" });
  assert.equal(viaRefLost.status, 1, `${viaRefLost.stdout}${viaRefLost.stderr}`);
  assert.match(viaRefLost.stderr, /FAIL: baseline exposure link\(s\) missing \(1\): \.agents\/skills\/flat-a/);

  const bad = spawnSync(process.execPath, [exposureGate, "--root", root, "--baseline", "no-such-ref-for-fixture"], { encoding: "utf8" });
  assert.equal(bad.status, 2, `${bad.stdout}${bad.stderr}`);
  assert.match(bad.stderr, /neither a file nor a git ref/);
  console.log("ok: exposure --baseline: file and git-ref baselines pass when complete, FAIL with the lost id, exit 2 for a bad baseline");
}

// 파일럿 게이트 회귀: 정상 PASS 7/7, 생성기 exit 9 주입 시 해당 단계 FAIL(exit 코드 표기), 생성기가 거부하는 손상 시 옛 산출물로 통과하지 않는다.
function testPilotGates() {
  const pilot = path.join(repoRoot, "scripts", "skill-pilot-check.mjs");
  const normal = spawnSync(process.execPath, [pilot, "senior", "core"], { encoding: "utf8" });
  assert.equal(normal.status, 0, `${normal.stdout}${normal.stderr}`);
  assert.match(normal.stdout, /RESULT: PASS \(7\/7\)/);

  for (const renderer of ["skill-index", "instructions"]) {
    const faulted = spawnSync(process.execPath, [pilot, "senior", "core", `--fault-renderer=${renderer}`], { encoding: "utf8" });
    assert.equal(faulted.status, 1, `${renderer}: ${faulted.stdout}${faulted.stderr}`);
    assert.match(faulted.stdout, new RegExp(`^${renderer}\\s+FAIL\\s+render-.*exit 9`, "m"), `${renderer} must FAIL with exit 9`);
    assert.match(faulted.stdout, /RESULT: FAIL/);
  }
  const badFault = spawnSync(process.execPath, [pilot, "senior", "core", "--fault-renderer=nope"], { encoding: "utf8" });
  assert.equal(badFault.status, 2);

  // 손상 복사본: postgres 의 visibility 를 렌더러가 거부하는 값으로 바꾼다. 옛 skill-index.json 이 남아 있어도 PASS 하면 안 된다.
  const corrupt = path.join(work, `pilot-corrupt-${counter += 1}`);
  fs.cpSync(repoRoot, corrupt, {
    recursive: true,
    verbatimSymlinks: true,
    filter: src => path.relative(repoRoot, src).split(path.sep)[0] !== ".git",
  });
  const postgres = path.join(corrupt, "skills", "postgres", "SKILL.md");
  const original = fs.readFileSync(postgres, "utf8");
  const broken = original.replace("visibility: contextual", "visibility: bogus");
  assert.notEqual(broken, original, "fixture must actually corrupt postgres routing");
  fs.writeFileSync(postgres, broken);
  assert.ok(fs.existsSync(path.join(corrupt, "skills", "skill-index.json")), "stale index exists in the copy");
  const corruptRun = spawnSync(process.execPath, [path.join(corrupt, "scripts", "skill-pilot-check.mjs"), "senior", "core"], { encoding: "utf8" });
  assert.equal(corruptRun.status, 1, `${corruptRun.stdout}${corruptRun.stderr}`);
  assert.match(corruptRun.stdout, /^skill-index\s+FAIL\s+render-skill-index failed: .*exit 1/m, corruptRun.stdout);
  assert.match(corruptRun.stdout, /^instructions\s+FAIL/m, corruptRun.stdout);
  console.log("ok: pilot-check PASSes 7/7 normally, FAILs with exit 9 when a renderer is injected to fail, and does not pass on stale outputs when a renderer rejects the tree");
}

// 비ASCII 노출 ID(예: 한글화): git ls-tree 기본 출력은 "\355\225\234..." 로 따옴표 이스케이프된다. -z 파싱 회귀 방지.
function testExposureBaselineNonAscii() {
  const root = exposureRoot("exposure-baseline-nonascii");
  const id = "한글화";
  writeSkill(path.join(root, "skills", id), id);
  relLink(root, ".claude/skills", id, path.join(root, "skills", id));
  relLink(root, ".agents/skills", id, path.join(root, "skills", id));
  const git = ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
  assert.equal(spawnSync("git", [...git, "init", "-q"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", [...git, "add", "-A"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", [...git, "commit", "-q", "-m", "baseline"], { encoding: "utf8" }).status, 0);

  const keys = loadBaseline("HEAD", root);
  assert.ok(keys.includes(`.claude/skills/${id}`), `non-ASCII id must parse from git ref: ${keys.join(", ")}`);
  const passed = spawnSync(process.execPath, [exposureGate, "--root", root, "--baseline", "HEAD"], { encoding: "utf8" });
  assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);

  fs.unlinkSync(path.join(root, ".claude", "skills", id));
  const failed = spawnSync(process.execPath, [exposureGate, "--root", root, "--baseline", "HEAD"], { encoding: "utf8" });
  assert.equal(failed.status, 1, `${failed.stdout}${failed.stderr}`);
  assert.match(failed.stderr, /FAIL: baseline exposure link\(s\) missing \(1\): \.claude\/skills\/한글화/);
  console.log("ok: exposure baseline with a non-ASCII id (git ref, -z): passes when complete, FAILs by name when the link is deleted");
}

// 실제 트리: HEAD 기준선이 비ASCII 노출 링크를 포함해 파싱되고 CLI가 exit 0 이어야 한다. git 저장소가 아니면 SKIP 사유를 찍는다.
function testExposureBaselineRealTree() {
  const inGit = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "-q", "HEAD^{commit}"], { encoding: "utf8" }).status === 0;
  if (!inGit) {
    console.log("SKIP: real-tree exposure baseline (repository has no git HEAD; run from a git checkout)");
    return;
  }
  const keys = loadBaseline("HEAD", repoRoot);
  assert.ok(keys.some(key => /[^\x00-\x7f]/.test(key)), `real tree HEAD must list a non-ASCII exposure id (fixture drift?): ${keys.join(", ")}`);
  const real = spawnSync(process.execPath, [exposureGate, "--baseline", "HEAD"], { encoding: "utf8" });
  assert.equal(real.status, 0, `real tree must pass against HEAD baseline: ${real.stdout}${real.stderr}`);
  assert.match(real.stdout, /baseline=\d+ id\(s\) present/);
  console.log(`ok: real tree exposure links pass against git HEAD baseline (${keys.length} ids, incl. non-ASCII)`);
}

function exposureBaselineRoot(label) {
  const root = exposureRoot(label);
  relLink(root, ".claude/skills", "flat-a", path.join(root, "skills", "flat-a"));
  relLink(root, ".claude/skills", "grouped-b", path.join(root, "skills", "library", "grouped-b"));
  relLink(root, ".agents/skills", "flat-a", path.join(root, "skills", "flat-a"));
  return root;
}
