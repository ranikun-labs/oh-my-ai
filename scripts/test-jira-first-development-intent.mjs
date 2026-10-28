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
  // One explanatory/negative clause must not suppress a separate action.
  ["Carelog OAuth가 뭐야? 로그인 API 오류도 수정해줘", true],
  ["Finance API 구현하지 마. 대신 Carelog OAuth 로그인 오류 수정해줘", true],
  // A bare question is not an implementation instruction.
  ["Carelog OAuth 코드를 개발해?", false],
  ["우리 Backend API 구현해준 적 있어?", false],
  // Natural request variants absent from the original finite verb list.
  ["로그인 기능 변경해줘", true],
  ["PR #85 수정 좀 부탁해", true],
  ["/async-batch RPL-113 이어서 처리해줘", true],
  ["로그인 API 수정해줘?", true],
  ["로그인 API 구현해?", false],
  ["Carelog OAuth가 뭐야?", false],
  ["그 OAuth 수정하지 마. API 문서 구현해줘", true],
  // Advisory Jira-first preflight: explicit additions are development requests.
  ["로그인 API에 토큰 만료 검증을 추가해줘", true],
  ["로그인 API에 검증 추가해줘", true],
  ["로그인 API에 토큰 만료 검증을 추가해줄래?", true],
  ["로그인 API 추가해줘?", true],
  // Negated additions, concept questions, and bare questions are not requests.
  ["로그인 API 검증을 추가하지 마", false],
  ["로그인 API 검증 추가해주지 마", false],
  ["로그인 API에 검증 추가해 주지 말아줘", false],
  ["로그인 API에 검증 추가해?", false],
  ["로그인 API가 뭔지 설명해줘", false],
  // An explanatory clause must not hide an independent addition request.
  ["Carelog OAuth가 뭐야? 로그인 API에 검증 추가해줘", true],
];
// Independent actions and exclusions inside one sentence must not suppress one another.
const scopeCases = [
  ["로그인 API 검증 추가해줘, 다른 건 수정하지 마", true],
  ["로그인 API 구현하지 말고, OAuth 오류 수정해줘", true],
  ["로그인 API 변경하지 말고 결제 API에 보안 검증 추가해줘", true],
  ["로그인 API 테스트 추가해줘, 나머지는 변경하지 마", true],
  ["로그인 API 검증 추가해줘, 그 외는 수정하지 마", true],
  ["로그인 API 테스트 추가해줘, 단 실제로는 구현하지 마", false],
  ["로그인 API 구현하지 말고, 설명만 해줘", false],
  ["로그인 API 변경하지 마, 다른 건 설명해줘", false],
  ["로그인 API 추가해주지 마, 다른 것도 수정하지 마", false],
  ["로그인 API 추가해줘?", true],
];
cases.push(...scopeCases);
// Additional adversarial regression: scope, retraction, natural requests.
const additionalCases = [
  ['로그인 API 오류를 고쳐줘. 그런데 나머지는 수정하지 마',true],
  ['로그인 API 버그를 수정해줘, 다만 테스트는 추가하지 마',true],
  ['로그인 API 인증 오류를 수정하지 마, 다른 건 로그인 기능 개선해줘',true],
  ['로그인 API 오류 수정해줘, 그 외는 손대지 마',true],
  ['로그인 API 오류 수정해줘, 기존 코드는 변경하지 마',true],
  ['로그인 API 오류 수정하지 말고 새로운 기능 추가해줘',true],
  ['로그인 API 오류 수정하지 말고, 기능 추가해줘',true],
  ['로그인 API 오류 수정하지 마; 대신 토큰 검증 추가해줘',true],
  ['로그인 API 수정하지 말고 OAuth 개선해줘',true],
  ['로그인 API 오류 고쳐줘 하지만 실제로는 수정하지 마',false],
  ['로그인 API 추가해줘 단 실제로는 추가하지 마',false],
  ['로그인 API를 추가해줘? 아니, 취소할게',false],
  ['로그인 API 코드를 고쳐줘, 아니 그냥 설명해줘',false],
  ['로그인 API 수정해줘(실행하지 말고 예시만)',false],
  ['로그인 API에 토큰 체크를 추가해 주세요',true],
  ['로그인 API에 토큰 체크 추가해주세요',true],
  ['로그인 API 기능을 새로 만들어줘',true],
  ['OAuth 기능을 구현해주세요',true],
  ['RPL-113 진행시켜',true],
  ['로그인 API를 고쳐줄 수 있어?',false],
  ['로그인 API를 고쳐줄래?',true],
  ['로그인 API는 설명해줘, Finance API 오류는 수정해줘',true],
  ['로그인 API 개선해줘, 대신 Finance API는 건드리지 마',true],
  ['로그인 API 개선해줘, 대신 Finance API 오류도 수정해줘',true],
  ['로그인 API에 변경 사항을 추가해 줘',true],
  ['로그인 API 추가하는 법만 설명해줘',false],
  ['API 구현하지 말고 기능 개선 방법 설명해줘',false],
  ['로그인 API 수정하지 말고 기능 개선만 해줘',true],
];
cases.push(...additionalCases);

for (const [prompt, expected] of cases) {
  assert.equal(needsJiraFirstDevelopmentPreflight(prompt), expected, prompt);
}

for (const [prompt, expected] of [
  ["Carelog OAuth 개선 시작하자", true],
  ["RPL-113 기존 이슈 확인하고 이어서 개발해", true],
  ["Jira 티켓이 뭔지 설명해줘", false],
  ["Finance API 구현하지 마", false],
  ["로그인 기능 변경해줘", true],
  ["PR #85 수정 좀 부탁해", true],
  ["Carelog OAuth가 뭐야? 로그인 API 오류도 수정해줘", true],
  ["Carelog OAuth 코드를 개발해?", false],
  ["로그인 API에 토큰 만료 검증을 추가해줘", true],
  ["로그인 API 검증을 추가하지 마", false],
  ["로그인 API 버그를 수정해줘, 다만 테스트는 추가하지 마", true],
  ["로그인 API를 추가해줘? 아니, 취소할게", false],
  ["RPL-113 진행시켜", true],
  ["로그인 API 오류 고쳐줘 하지만 실제로는 수정하지 마", false],
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
