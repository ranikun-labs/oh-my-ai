import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractRoutingPrompt } from "./lib/routing-prompt-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-ai-agent-routing-"));
const harness = path.join(tmp, "harness source");
const product = path.join(tmp, "product 작업");
const index = path.join(tmp, "skills.json");
const files = [
  "scripts/prompt-routing-hook.mjs",
  "scripts/lib/routing-prompt-source.mjs",
  "scripts/lib/routing-status.mjs",
  "scripts/lib/jira-first-development-intent.mjs",
  "scripts/lib/work-start-execution-state.mjs",
  "scripts/lib/user-local-state.mjs",
];
const env = { ...process.env };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key];

const report = "로그인 API 오류 수정해줘. 구현 전에 관련 코드와 영향 범위를 먼저 모아줘. 매번 자동화 PR 생성 handoff project-context alpha.";
const agent = '<agent-message agent-id="worker" role="user">\n' + report + "\n</agent-message>";
const reviewer = '<agent-message agent-id="reviewer">\nMAJOR: ' + report + "\n</agent-message>";
const background = "<task-notification>\n" + report + "\n</task-notification>";
const request = "로그인 API 오류 수정해줘. beta";
const neutral = "What is HTTP?";
const fence = String.fromCharCode(96).repeat(3);
const sample = fence + "xml\n" + agent + "\n" + fence;

function snapshot(dir) {
  const entries = {};
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else entries[path.relative(dir, file)] = fs.readFileSync(file, "utf8");
    }
  }
  walk(dir);
  return entries;
}

function runHook(runtime, state, prompt, field = "prompt", extra = {}, format = runtime + "-json") {
  const input = field === null ? prompt : JSON.stringify({ ...extra, [field]: prompt });
  const result = spawnSync(process.execPath, [path.join(harness, files[0]), "--format=" + format], {
    cwd: product,
    env: { ...env, OH_MY_AI_STATE_ROOT: state, OH_MY_AI_SKILL_INDEX: index },
    input, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function candidateState(state) {
  const entries = Object.entries(snapshot(state)).filter(([file]) => path.basename(file) === "candidates.json");
  assert.equal(entries.length, 1, "expected exactly one isolated automation candidate file");
  return JSON.parse(entries[0][1]).candidates;
}

try {
  const pureCases = [
    [agent, null], [reviewer, null], [background, null],
    [agent + "\n" + background, null],
    [agent.replaceAll("\n", "\r\n"), null],
    [agent + "\n" + request, request],
    [request + "\n" + reviewer, request],
    [agent + "\n" + request + "\n" + background, request],
    [agent + " " + request, request],
    ["<agent-message>" + report + "</agent-message> " + request, request],
    ["<agent-message>\n" + report + "</agent-message>", null],
    ["<agent-message>\n" + background + "\n</agent-message>", null],
    ["<agent-message>\n" + fence + "xml\n</agent-message>\n" + fence + "\n" + report + "\n</agent-message>", null],
    [sample, null], [request + "\n" + sample, request],
    [request, request],
    ["Explain <agent-message> tag", "Explain <agent-message> tag"],
    ["<agent-message>\n" + request, "<agent-message>\n" + request],
    ["<agent-message>\n" + request + "\n</task-notification>", "<agent-message>\n" + request + "\n</task-notification>"],
    ["<agent-message role=user>\n" + request + "\n</agent-message>", "<agent-message role=user>\n" + request + "\n</agent-message>"],
  ];
  for (const [prompt, expected] of pureCases) {
    assert.equal(extractRoutingPrompt({ prompt }, prompt), expected, prompt);
  }
  assert.equal(extractRoutingPrompt({}, agent), agent, "raw text is not a provider event");
  assert.equal(extractRoutingPrompt({ prompt: request, source: "agent" }, request), request, "unverified metadata is not authority");

  for (const cwd of [harness, product]) {
    fs.mkdirSync(cwd, { recursive: true });
    const init = spawnSync("git", ["init", "-q"], { cwd, env, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr || init.error?.message);
  }
  for (const file of files) {
    const target = path.join(harness, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  fs.writeFileSync(index, JSON.stringify({
    schema_version: 1,
    skills: ["alpha", "beta"].map(name => ({
      name, path: "skills/" + name + "/SKILL.md",
      routing: { visibility: "contextual", risk_level: "low", task_types: ["test"],
        triggers: [{ kind: "keyword", values: [name] }] },
    })),
  }));

  for (const runtime of ["claude", "codex"]) {
    const state = path.join(tmp, runtime + "-state");
    fs.mkdirSync(state, { mode: 0o700 });
    const run = (prompt, field = "prompt", extra = {}, format) => runHook(runtime, state, prompt, field, extra, format);
    const seed = "구현 전에 관련 코드와 영향 범위를 먼저 모아줘. 매번 자동화 후보로 기록해줘.";
    const seeded = JSON.parse(run(seed));
    assert.match(seeded.systemMessage, /Suggested by oh-my-ai: Work-start/);
    assert.equal(candidateState(state).length, 1, "ordinary toil must still persist");
    const before = snapshot(state);
    assert.ok(Object.keys(before).some(file => path.basename(file) === "suggestions.json"), "ordinary suggestion must still persist");

    const returns = [agent, reviewer, background, agent + "\n" + reviewer, agent.replaceAll("\n", "\r\n"), sample,
      '<agent-message agent-id="worker">\nC:\\Users\\fixture\\report.md\n/Users/fixture/report.md\n' + report + "\n</agent-message>"];
    for (const prompt of returns) {
      for (const field of ["prompt", "user_prompt", "message"]) {
        assert.equal(run(prompt, field), "", runtime + ": pure return produced routing output");
        assert.deepEqual(snapshot(state), before, runtime + ": pure return changed state");
      }
      assert.equal(run(prompt, "prompt", {}, "routing-json"), "", "pure return must not route skills");
    }

    const neutralOutput = run(neutral);
    assert.equal(run(agent + "\n" + neutral), neutralOutput);
    assert.equal(run(neutral + "\n" + reviewer), neutralOutput);
    const expected = run(request);
    assert.match(expected, /Jira-first development preflight \(advisory only\)/);
    assert.match(expected, /never approves Jira Create\/Update or Git Write/);
    for (const mixed of [agent + "\n" + request, request + "\n" + reviewer,
      agent + "\r\n" + request + "\r\n" + background, agent + " " + request, request + "\n" + sample]) {
      assert.equal(run(mixed), expected, "mixed event must route only the real user request");
    }
    const routing = JSON.parse(run(agent + "\n" + request, "prompt", {}, "routing-json"));
    assert.deepEqual(routing.skill_candidates.map(candidate => candidate.name), ["beta"]);
    assert.equal(run(agent + "\n$adaptive-goal-closure"), run("$adaptive-goal-closure"), "explicit follow-up must be preserved");
    assert.equal(run(request, "prompt", { source: "agent" }), expected, "unverified origin metadata must not change routing");
    const malformed = "<agent-message role=user>\n" + request + "\n</agent-message>";
    assert.equal(run(malformed), run(malformed, null), "malformed markup must remain literal user text");
    assert.match(run(malformed), /Jira-first development preflight \(advisory only\)/);
    assert.deepEqual(snapshot(state), before, "non-toil mixed requests must not pollute state");

    const userToil = "매번 반복되는 beta 확인을 자동화 후보로 기록해줘.";
    run(agent + "\n" + userToil);
    const candidates = candidateState(state);
    assert.equal(candidates.length, 2, "mixed toil should add just one candidate");
    assert.equal(candidates[0].prompt_hash, crypto.createHash("sha256").update(userToil).digest("hex"), "only real user text may be hashed");

    const secret = "SYNTHETIC_LONG_INPUT_MARKER_";
    const longPrompt = "구현 전에 관련 코드와 영향 범위를 먼저 모아줘. " + secret.repeat(300);
    const longOutput = JSON.parse(run(longPrompt));
    const command = runtime === "claude" ? "/work-start" : "$work-start";
    assert.ok(longOutput.systemMessage.includes(command + " <작업 내용>"));
    assert.ok(longOutput.hookSpecificOutput.additionalContext.includes(command + " <작업 내용>"));
    assert.ok(longOutput.systemMessage.length <= 600);
    assert.ok(longOutput.hookSpecificOutput.additionalContext.length <= 1800);
    assert.ok(!JSON.stringify(longOutput).includes(secret), "suggestion must not copy prompt");
    assert.equal(fs.existsSync(path.join(product, ".oh-my-ai", "work-start")), false, "suggestion must not execute the engine");
    console.log("passed: " + runtime + " agent-return filtering, mixed request, bounded suggestion and state isolation");
  }
  console.log("all agent-return routing fixtures passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
