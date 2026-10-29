#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { validateF1Report } from "./f1-report-advisory.mjs";

const validReport = `# F1 보고 구조 검사기

## 문제
개발 결과에서 사용자 영향, 실행 결과, 남은 범위가 한데 섞여 읽기 어려웠다.

## 사용자에게 달라지는 점
검사기가 보고서에 변경 효과와 각 검증 상태가 따로 기록됐는지 알려 준다.

## 이번 변경
한국어 보고 Skill 후보와 상태 표기 검사기, 회귀 Fixture를 추가했다.

## 검증
- Native Test: PASS — \`node scripts/test-f1-report-advisory.mjs\`, 17/17
- CI: NOT_RUN — 이 로컬 실행에서는 CI를 호출하지 않았다.
- Independent Review: BLOCKED — 새 HEAD에 대한 별도 Reviewer가 아직 없다.
- Runtime E2E: NOT_RUN — 자동 Skill 호출은 시험하지 않았다.
- Owner Gate: PENDING — Source Merge 승인은 별도다.

## 아직 안 되는 것
Skill 자동 발견과 실제 Runtime E2E는 확인하지 않았다.

## 다음 행동
Skill Index 경로가 충돌 없이 열리면 생성물을 갱신하고 해당 HEAD를 검수한다.

## 근거
- Base: 6d2a93893c0c7a40e1d0b99b691a8f950aa17969
- Candidate: local fixture only
- Script: scripts/f1-report-advisory.mjs
`;

function expectInvalid(label, markdown, expectedMessage) {
  const result = validateF1Report(markdown);
  assert.equal(result.valid, false, `${label}: expected invalid report`);
  assert.ok(result.errors.some((error) => error.includes(expectedMessage)), `${label}: ${result.errors.join("; ")}`);
}

const ok = validateF1Report(validReport);
assert.equal(ok.valid, true, ok.errors.join("; "));

const skill = fs.readFileSync(new URL("../skills/engineering-communication-ko/SKILL.md", import.meta.url), "utf8");
assert.match(skill, /^name: engineering-communication-ko$/m);
assert.match(skill, /^[ \t]+summary: 개발 결과를 사용자 관점과 검증 근거 중심으로 한국어 보고$/m);
assert.match(skill, /^[ \t]+visibility: contextual$/m);
assert.match(skill, /^[ \t]+risk_level: low$/m);

expectInvalid("missing user impact", validReport.replace(/## 사용자에게 달라지는 점[\s\S]*?(?=## 이번 변경)/, ""), "사용자에게 달라지는 점");
expectInvalid("missing limitations", validReport.replace(/## 아직 안 되는 것[\s\S]*?(?=## 다음 행동)/, "## 아직 안 되는 것\n없음\n\n"), "section must contain a concrete statement");
const emptyBulletReport = validReport
  .replace("## 사용자에게 달라지는 점\n검사기가 보고서에 변경 효과와 각 검증 상태가 따로 기록됐는지 알려 준다.", "## 사용자에게 달라지는 점\n-")
  .replace("## 아직 안 되는 것\nSkill 자동 발견과 실제 Runtime E2E는 확인하지 않았다.", "## 아직 안 되는 것\n-");
expectInvalid("empty bullets do not satisfy required sections", emptyBulletReport, "section must contain a concrete statement");
const fencedOnlyReport = `\`\`\`markdown
## 문제
fake
## 사용자에게 달라지는 점
fake
## 이번 변경
fake
## 검증
- Native Test: PASS — node test.mjs, 1/1
- CI: PASS — https://example.invalid/run
- Independent Review: PASS — reviewer: fake, HEAD: deadbeef
- Runtime E2E: PASS — runtime: fake, evidence deadbeef
- Owner Gate: APPROVED — https://example.invalid/approval
## 아직 안 되는 것
fake
## 다음 행동
fake
## 근거
- deadbeef
\`\`\``;
expectInvalid("fenced Markdown cannot satisfy report sections", fencedOnlyReport, "missing required section: ## 문제");
const fencedTildeReport = fencedOnlyReport.replaceAll("\`\`\`", "~~~");
expectInvalid("tilde-fenced Markdown cannot satisfy report sections", fencedTildeReport, "missing required section: ## 문제");
expectInvalid("missing native test status", validReport.replace(/- Native Test:.*\n/, ""), "Native Test must have exactly one");
expectInvalid("native pass without command or count", validReport.replace(/Native Test: PASS .*17\/17/, "Native Test: PASS — done"), "Native Test PASS requires a command or a passed/total count");
expectInvalid("CI pass without evidence", validReport.replace("CI: NOT_RUN — 이 로컬 실행에서는 CI를 호출하지 않았다.", "CI: PASS — 성공"), "CI PASS requires a run URL");
expectInvalid("review pass without identity", validReport.replace("Independent Review: BLOCKED — 새 HEAD에 대한 별도 Reviewer가 아직 없다.", "Independent Review: PASS — 검토 완료"), "reviewer identity");
expectInvalid("review pass without pinned head", validReport.replace("Independent Review: BLOCKED — 새 HEAD에 대한 별도 Reviewer가 아직 없다.", "Independent Review: PASS — reviewer: reviewer-1"), "reviewed HEAD");
expectInvalid("runtime not run without reason", validReport.replace("Runtime E2E: NOT_RUN — 자동 Skill 호출은 시험하지 않았다.", "Runtime E2E: NOT_RUN"), "Runtime E2E NOT_RUN requires");
expectInvalid("runtime pass without runtime evidence", validReport.replace("Runtime E2E: NOT_RUN — 자동 Skill 호출은 시험하지 않았다.", "Runtime E2E: PASS — 완료"), "Runtime E2E PASS requires the runtime name");
expectInvalid("owner approval unsupported", validReport.replace("Owner Gate: PENDING — Source Merge 승인은 별도다.", "Owner Gate: PASS — owner said yes"), "unsupported status");
expectInvalid("approval without reference", validReport.replace("Owner Gate: PENDING — Source Merge 승인은 별도다.", "Owner Gate: APPROVED — owner approved"), "linked issue, comment, or approval URL");
expectInvalid("evidence lacks identifier", validReport.replace("- Base: 6d2a93893c0c7a40e1d0b99b691a8f950aa17969", "- Base: unknown"), "must include a URL or a source SHA");
expectInvalid("status outside verification section", validReport.replace(/- Native Test:.*\n/, "").replace("- Script: scripts/f1-report-advisory.mjs", "- Script: scripts/f1-report-advisory.mjs\n- Native Test: PASS — node scripts/test-f1-report-advisory.mjs"), "Native Test must have exactly one");

console.log("f1 report advisory fixtures passed: 17/17");


// F1 routing metadata regression fixtures.
// This exercises regex metadata as the #80 Router consumes it. It does NOT
// prove that #80 is merged, the Skill is indexed, or Runtime E2E has run.
const frontmatter = skill.split("\n---\n")[0];
assert.doesNotMatch(frontmatter, /^\s*-\s*kind:\s*keyword\s*$/m, "broad keywords can bypass the guarded pattern");
const patternEntry = frontmatter.match(/^\s*-\s*kind:\s*pattern\s*\n\s*values:\s*\n\s*-\s*(.+)$/m);
assert.ok(patternEntry, "F1 routing must expose a pattern trigger");
const reportPattern = new RegExp(patternEntry[1].trim(), "i");
const positiveRoutingInputs = [
  "개발 결과 보고해줘",
  "개발 결과 보고해주세요",
  "구현 결과 정리해줘",
  "테스트 결과 보고 부탁해",
  "PR 결과 보고해줘",
  "이번 PR 결과 보고해줘",
  "개발 결과 보고해봐",
  "이번 개발 결과 요약해줘",
  "F1 기반으로 이번 회차 결과 정리해줘",
  "/F1 이번 작업 결과 보여줘",
  "이번 구현 결과 보고 부탁합니다",
  "F1 기준 이번 결과 설명해줘",
  "테스트 결과 보고하자",
  "개발 결과 보고해줄래",
  "이번 작업 결과를 한국어로 요약해줘",
  "/핵심정리 이번 업무 결과 알려줘",
  "어제는 개발 결과 보고했지만, 오늘 변경한 PR 결과 보고해줘",
  "이전 결과는 보고했어. 이번 테스트 결과는 다시 정리해줘",
  "F1 기반으로 f4 적응형 골모드로 진행하고 결과도 제3자 직관적으로 정리해줘",
  "이번 작업 결과와 남은 문제를 정리해줘",
  "PR 결과를 요약해 주세요",
  "이번 개발 결과를 보고서로 정리해줘"
];
const negativeRoutingInputs = [
  "개발 결과 보고하지 마",
  "테스트 결과 보고 안 해",
  "구현 결과 정리하지 말아줘",
  "개발 결과 보고했어",
  "어제 개발 결과 보고했었다",
  "PR 결과 보고가 뭐야?",
  "'개발 결과 보고해줘'라는 문장 분석해줘",
  "\"개발 결과 보고해줘\"라고 썼어",
  "이번 개발 결과 보고 방법 설명해줘",
  "F1 결과를 왜 보고하는 거야?",
  "개발 결과 보고하지 마, 대신 코드만 줘",
  "구현 결과 정리하지 않아도 돼",
  "F1 결과 보고했어",
  "이게 PR 결과 보고라는 표현이야?",
  "테스트 결과 보고해줘라고 말했지",
  "이번 F1 결과 정리하는 방법 알려줘",
  "PR 결과 보고의 정의를 정리해줘",
  "개발 결과 보고 형식 정리해줘",
  "테스트 결과 보고 사례를 설명해줘",
  "보고하지 마. 이전 대화를 정리해줘",
  "F1 보고 Skill 패턴 동작을 설명해줘"
];
for (const input of positiveRoutingInputs) {
  assert.equal(reportPattern.test(input.toLowerCase().slice(0, 2000)), true, "F1 positive route missed: " + input);
}
for (const input of negativeRoutingInputs) {
  assert.equal(reportPattern.test(input.toLowerCase().slice(0, 2000)), false, "F1 negative route matched: " + input);
}
console.log("f1 skill pattern fixtures passed: " + (positiveRoutingInputs.length + negativeRoutingInputs.length) + "/" + (positiveRoutingInputs.length + negativeRoutingInputs.length));
