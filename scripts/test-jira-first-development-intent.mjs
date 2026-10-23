#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { needsJiraFirstDevelopmentPreflight } from "./lib/jira-first-development-intent.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
  ["Carelog OAuth 개선 시작하자", true],
  ["RPL-113 기존 이슈 확인하고 이어서 개발해", true],
  ["이 PR #2 Finding 수정해줘", true],
  ["Finance의 새로운 이체 API 구현해줘", true],
  ["로그인 API 오류 수정해줘", true],
  ["Please fix the OAuth login API", true],
  ["Carelog OAuth 개선 아이디어만 설명해줘", false],
  ["Finance API 구현하지 마", false],
  ["이 PR #2 코드는 수정하지 말고 설명만 해줘", false],
  ["Jira 티켓 만들지 마", false],
  ["Jira 티켓이 뭔지 설명해줘", false],
  ["일반적인 캐시 전략이 뭐야?", false],
  ["What is an API?", false],
  ["이 변경은 앞으로 개발할 수 있을까?", false],
];
for (const [prompt, expected] of cases) {
  assert.equal(needsJiraFirstDevelopmentPreflight(prompt), expected, prompt);
}

for (const [prompt, expected] of [
  ["Carelog OAuth 개선 시작하자", true],
  ["RPL-113 기존 이슈 확인하고 이어서 개발해", true],
  ["Jira 티켓이 뭔지 설명해줘", false],
  ["Finance API 구현하지 마", false],
]) {
  const result = spawnSync(process.execPath, ["scripts/prompt-routing-hook.mjs", "--format=text"], {
    cwd: root,
    input: JSON.stringify({ prompt }),
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const hint = result.stdout.includes("Jira-first development preflight (advisory only)");
  assert.equal(hint, expected, prompt);
  if (expected) {
    assert.match(result.stdout, /do not implicitly invoke jira-work or work-start/);
    assert.match(result.stdout, /never approves Jira Create\/Update or Git Write/);
  }
}
console.log("passed: Jira-first advisory intent, positive/negative cases and Hook integration");
