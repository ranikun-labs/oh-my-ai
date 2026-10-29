#!/usr/bin/env node

// RPL-119 isolation integration: actual #80 Router consumers + #88 F1 Skill.
// The caller must prepare a disposable #80 checkout and regenerate its Index.
// This test does not install any global skill or mutate Jira/GitHub.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const currentRepo = path.resolve(scriptDir, "..");
const integrationRoot = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2], "usage: node scripts/test-f1-cross-pr-routing.mjs <isolated-router-root>");
assert.notEqual(integrationRoot, currentRepo, "integration must use an isolated checkout");

const indexFile = path.join(integrationRoot, "skills", "skill-index.json");
const skillIndex = JSON.parse(fs.readFileSync(indexFile, "utf8"));
assert.equal(skillIndex.skills.length, 15, "#80 14 skills + #88 F1 should yield 15");
const registeredF1 = skillIndex.skills.find((skill) => skill.name === "engineering-communication-ko");
assert.ok(registeredF1, "F1 Skill must be generated into the actual Index");
assert.equal(registeredF1.path, "skills/engineering-communication-ko/SKILL.md");
assert.equal(registeredF1.routing.triggers.some((trigger) => trigger.kind === "pattern"), true);
assert.equal(registeredF1.routing.triggers.some((trigger) => trigger.kind === "keyword"), false);

const fixtureSource = fs.readFileSync(path.join(currentRepo, "scripts", "test-f1-report-advisory.mjs"), "utf8");
function loadCases(name) {
  const prefix = "const " + name + " = ";
  const start = fixtureSource.indexOf(prefix);
  assert.notEqual(start, -1, "missing fixture array: " + name);
  const begin = start + prefix.length;
  const end = fixtureSource.indexOf("\n];", begin);
  assert.notEqual(end, -1, "unterminated fixture array: " + name);
  return JSON.parse(fixtureSource.slice(begin, end + 2));
}

const positives = loadCases("positiveRoutingInputs");
const negatives = loadCases("negativeRoutingInputs");
assert.equal(positives.length, 22, "unexpected positive fixture count");
assert.equal(negatives.length, 21, "unexpected negative fixture count");

const env = { ...process.env, OH_MY_AI_SKILL_INDEX: indexFile };
function runConsumer(relativePath, format, prompt) {
  const child = spawnSync(process.execPath, [path.join(integrationRoot, relativePath), format], {
    cwd: integrationRoot,
    env,
    input: prompt,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, relativePath + " failed: " + (child.stderr || child.stdout));
  return JSON.parse(child.stdout);
}

function verifyPrompt(prompt, expected, group) {
  const work = runConsumer("scripts/work-start-skill-match.mjs", "--format=json", prompt);
  const hook = runConsumer("scripts/prompt-routing-hook.mjs", "--format=routing-json", prompt);
  const names = (item) => item.skill_candidates.map((candidate) => candidate.name);
  assert.notEqual(work.routing_status, "unavailable", "Work-start Router unavailable: " + prompt);
  assert.notEqual(hook.routing_status, "unavailable", "Hook Router unavailable: " + prompt);
  assert.deepEqual(names(work), names(hook), "two consumers disagree for: " + prompt);
  assert.equal(names(work).includes("engineering-communication-ko"), expected, group + " mismatch: " + prompt);
}

for (const prompt of positives) verifyPrompt(prompt, true, "positive");
for (const prompt of negatives) verifyPrompt(prompt, false, "negative");

// Ensure reporting is not accidentally selected for an unrelated coding task,
// and that the existing daily-report skill still takes its own requests.
verifyPrompt("로그인 오류 수정해줘", false, "unrelated-development");
verifyPrompt("일일보고 작성해줘", false, "daily-report");

console.log("F1 cross-PR native consumers passed: 43/43 F1 routes, 2/2 other intents");
console.log("Isolation only: no installed runtime, independent review, or Source Merge.");
