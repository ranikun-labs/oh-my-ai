#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatUsageObservationForF1, validateAiStatus, validateF1Report } from "./f1-report-advisory.mjs";
import { matchSkillCandidatesWithStatus } from "./lib/routing-status.mjs";

const validReport = `# F1 보고 구조 검사기

## 문제
개발 결과에서 사용자 영향, 실행 결과, 남은 범위가 한데 섞여 읽기 어려웠다.

## 사용자에게 달라지는 점
검사기가 보고서에 변경 효과와 각 검증 상태가 따로 기록됐는지 알려 준다.

## 서비스 기능
- 서비스명: oh-my-ai
- 기능명: F1 보고서 구조 검사
- 현재 사용자 기능: 사용자는 F1 보고서 필수 절과 다섯 Gate 상태의 구조를 확인할 수 있다.

## 이번 변경
 - 실제 변경: 한국어 보고 Skill 후보와 상태 표기 검사기, 서비스별 필수 보고 필드를 추가했다.
한국어 보고 Skill 후보와 상태 표기 검사기, 회귀 Fixture를 추가했다.

## 검증
 - 구현 상태: validator 후보가 실행 가능하다.
 - 검증 상태: Native Test fixture를 실행했다.
 - 문서 상태: Skill 계약과 RPL-119 예시를 갱신했다.
 - 배포 상태: 운영 배포는 하지 않았다.
- Native Test: PASS — \`node scripts/test-f1-report-advisory.mjs\`, 17/17
- CI: NOT_RUN — 이 로컬 실행에서는 CI를 호출하지 않았다.
- Independent Review: BLOCKED — 새 HEAD에 대한 별도 Reviewer가 아직 없다.
- Runtime E2E: NOT_RUN — 자동 Skill 호출은 시험하지 않았다.
- Owner Gate: PENDING — Source Merge 승인은 별도다.

## 아직 안 되는 것
 - 미지원 기능: 보고서 사실의 진실성 검사와 Runtime E2E.
 - 미지원 이유: 이 도구는 구조를 advisory로 검사하며 원격 근거를 확인하지 않는다.
Skill 자동 발견과 실제 Runtime E2E는 확인하지 않았다.

## 다음 행동
 - 다음 목표: F1 서비스별 보고 계약을 적용한다.
 - 첫 행동: 이 validator fixture와 RPL-119 예시를 실행해 확인한다.
 - 담당 Lane: oh-my-ai reporting
 - 필요 조건: report inputs와 고정 근거.
Skill Index 경로가 충돌 없이 열리면 생성물을 갱신하고 해당 HEAD를 검수한다.

## 근거
- Base: 6d2a93893c0c7a40e1d0b99b691a8f950aa17969
- Candidate: local fixture only
- Script: scripts/f1-report-advisory.mjs
`;

const mainOnlyAiStatus = `## AI 실행 현황
- 관측 범위: complete
- 확인된 참여자 수: 1
- 전체 참여자 수: 1
| Agent ID | 실제 역할 | 실제 참여 | spawn events | resume events | continue events | 요청 Model/Reasoning/Fast·출처 | 운영 선호·출처 | 실효 Model/Reasoning/Fast·출처 | 실제 작업·상태 | 공식 토큰·비용·구간·출처 |
|---|---|---|---:|---:|---:|---|---|---|---|---|
| Main | Main | YES | 0 | 0 | 1 | UNKNOWN — 이번 경로에서 생성 요청 없음 | Terra High — 운영 요청, 대화 근거 | UNKNOWN — Runtime 설정 근거 없음 | 요청 분석과 결과 취합을 수행 | UNKNOWN — 완료 후 공식 수치 없음 |
`;

const multiAgentAiStatus = `## AI 실행 현황
- 관측 범위: partial
- 확인된 참여자 수: 4
- 전체 참여자 수: UNKNOWN
| Agent ID | 실제 역할 | 실제 참여 | spawn events | resume events | continue events | 요청 Model/Reasoning/Fast·출처 | 운영 선호·출처 | 실효 Model/Reasoning/Fast·출처 | 실제 작업·상태 | 공식 토큰·비용·구간·출처 |
|---|---|---|---:|---:|---:|---|---|---|---|---|
| Main | Main | YES | 0 | 0 | 1 | UNKNOWN — 현재 턴에서 생성 요청 없음 | Terra High — 운영 요청 | UNKNOWN — 실효 설정 근거 없음 | Objective와 결과 취합 | UNKNOWN — 공식 계측 미제공 |
| writer-a | Writer | YES | 1 | 0 | 0 | Luna Max — 생성 요청 metadata | Luna Max — 운영 선호 | UNKNOWN — Runtime attestation 미제공 | Advisory 수정, 완료 | UNKNOWN — 해당 구간 수치 없음 |
| writer-b | Writer | YES | 1 | 0 | 0 | Luna Max — 생성 요청 metadata | Luna Max — 운영 선호 | UNKNOWN — Runtime attestation 미제공 | 회귀 fixture 수정, 완료 | UNKNOWN — 해당 구간 수치 없음 |
| reviewer-a | Reviewer | YES | 1 | 0 | 0 | Sol Medium — 생성 요청 metadata | Sol Medium — 운영 선호 | UNKNOWN — Runtime attestation 미제공 | 고정 HEAD 검토, 완료 | UNKNOWN — 해당 구간 수치 없음 |
| spawned-no-work | Helper | NO | 1 | 0 | 0 | UNKNOWN — 요청 metadata 없음 | UNKNOWN — 운영 선호 미관측 | UNKNOWN — Runtime attestation 미제공 | 생성됐으나 실제 작업에 참여하지 않음 | UNKNOWN — 참여·사용량 구간 없음 |
`;
const fullReportWithMainOnly = validReport.replace("## 아직 안 되는 것", `${mainOnlyAiStatus}\n## 아직 안 되는 것`);

function expectInvalid(label, markdown, expectedMessage) {
  const result = validateF1Report(markdown);
  assert.equal(result.valid, false, `${label}: expected invalid report`);
  assert.ok(result.errors.some((error) => error.includes(expectedMessage)), `${label}: ${result.errors.join("; ")}`);
}

const ok = validateF1Report(validReport);
assert.equal(ok.valid, true, ok.errors.join("; "));

const legacyMissingAiStatus = validateF1Report(validReport);
assert.equal(legacyMissingAiStatus.valid, true, "default F1 validation must stay backward compatible when AI status is not requested");

const afterVerification = "## 아직 안 되는 것";
const ciStatusPrefix = "- CI: NOT_RUN";
const sectionEndingHeadings = [
  "# 참고 자료",
  "#",
  "##",
  "## ###",
  "서론 예시\n2. 누적 관찰\n   # 부록",
  "-\t샘플\n\n  # 부록",
  "- \t샘플\n\n   # 부록",
  "- - -\n\n  # 부록",
  "-\n\n  # 부록",
  "1.\n\n   # 부록",
  "- 제목 예시\n  <div>확인</div>\n# 부록",
  "- 제목 예시\n  <script>\n# 부록",
];
for (const heading of sectionEndingHeadings) {
  expectInvalid(
    `a top-level ${heading} heading ends verification`,
    validReport.replace(ciStatusPrefix, `\n${heading}\n\n${ciStatusPrefix}`),
    "CI must have exactly one explicit status line"
  );
}
const sectionPreservingExamples = [
  "### 하위 검증 내역",
  "> # 인용 제목",
  "- 제목 예시\n\n  # 목록 안 제목",
  "- 제목 예시\n\n  ## 목록 안 제목",
  "서론 예시\n\n2. 누적 관찰\n   # 목록 안 제목",
  "1. 시작\n2. 누적 관찰\n   # 목록 안 제목",
  "-     샘플\n\n  # 목록 안 제목",
  "-\t샘플\n\n    # 목록 안 제목",
  "<pre>\n예시\n</pre># 부록",
  "-\n  # 목록 안 제목",
  "1.\n   # 목록 안 제목",
  "- 제목 예시\n  <div>\n  # HTML 블록 안 제목\n  </div>",
  "- 제목 예시\n  <script>\n  # HTML 블록 안 제목\n  </script>",
  "```markdown\n# 코드 예시 제목\n```",
  "#제목처럼 보이는 일반 텍스트",
];
for (const headingExample of sectionPreservingExamples) {
  const result = validateF1Report(validReport.replace(ciStatusPrefix, `\n${headingExample}\n\n${ciStatusPrefix}`));
  assert.equal(result.valid, true, `${headingExample}: ${result.errors.join("; ")}`);
}
const closedVerificationHeading = validateF1Report(validReport.replace("## 검증\n", "## 검증 ###\n"));
assert.equal(closedVerificationHeading.valid, true, closedVerificationHeading.errors.join("; "));
expectInvalid(
  "removing inline markup cannot turn literal title hashes into a closing hash sequence",
  validReport.replace("## 검증\n", "## 검증 ## <!-- 메모 -->\n"),
  "missing required section: ## 검증"
);
expectInvalid(
  "a closing hash sequence cannot hide a duplicate verification section",
  validReport.replace(afterVerification, `## 검증 ##\n\n중복 검증\n\n${afterVerification}`),
  "duplicate required section: ## 검증"
);

const mainOnlyRequired = validateF1Report(fullReportWithMainOnly, {
  requireAiStatus: true,
  observedParticipants: ["Main"],
  observationCoverage: "complete",
});
assert.equal(mainOnlyRequired.valid, true, mainOnlyRequired.errors.join("; "));

const mainOnlyPartial = validateAiStatus(mainOnlyAiStatus, {
  observedParticipants: [{ id: "Main" }],
  observationCoverage: "complete",
});
assert.equal(mainOnlyPartial.valid, true, mainOnlyPartial.errors.join("; "));
assert.equal(mainOnlyPartial.scope, "AI_STATUS_ONLY");
const participantTableInAppendix = validateAiStatus(
  mainOnlyAiStatus.replace("| Agent ID", "\n# 추가 관측 예시\n\n| Agent ID"),
  { observedParticipants: ["Main"], observationCoverage: "complete" }
);
assert.equal(participantTableInAppendix.valid, false, "an appendix table cannot satisfy the AI section");
assert.ok(participantTableInAppendix.errors.includes("AI status must contain the required participant table"));
console.log(`f1 ATX section boundary fixtures passed: ${sectionEndingHeadings.length + sectionPreservingExamples.length + 4}`);

const setextAppendices = [
  "참고 자료\n===",
  "참고 자료\n---",
  " 별도\n   참고 자료\n ---",
  "### 앞 하위 절\n참고 자료\n---",
  "<pre>예시 출력</pre>\n참고 자료\n---",
  ">\n참고 자료\n---",
  "-\n참고 자료\n---",
  "> 내부 제목\n> ===\n참고 자료\n---",
  "- - # 내부 제목\n참고 자료\n---",
  "> ```md\n> 샘플\n> ```\n참고 자료\n---",
  "> ```md\n> 샘플\n참고 자료\n===",
  "- > ```md\n  > 샘플\n  > ```\n참고 자료\n---",
];
for (const appendix of setextAppendices) {
  expectInvalid(
    "a top-level Setext appendix ends verification",
    validReport.replace(ciStatusPrefix, `\n${appendix}\n\n${ciStatusPrefix}`),
    "CI must have exactly one explicit status line",
  );
}
const setextNonBoundaries = [
  "---",
  "> 참고 자료\n> ===",
  "- 참고 자료\n  ===",
  "> 기존 인용\n참고 자료\n===",
  "> ```샘플```\n참고 자료\n===",
  "- 목록 문단\n참고 자료\n===",
  "> ===\n참고 자료\n===",
  "[reference]: /docs\n---",
  "[reference]:\n  /docs\n---",
  '[reference]: /docs\n  "제목"\n---',
  '[reference]:\n  /docs\n  "제목"\n---',
  "> ```md\n> 샘플\n> > ```\n> 내부 제목\n> ===\n> ```",
  "    참고 자료\n    ===",
  "```markdown\n참고 자료\n===\n```",
  "열 A | 열 B\n--- | ---\n표 값 | 관측\n===",
];
for (const example of setextNonBoundaries) {
  const result = validateF1Report(validReport.replace(ciStatusPrefix, `\n${example}\n\n${ciStatusPrefix}`));
  assert.equal(result.valid, true, `${example}: ${result.errors.join("; ")}`);
}
const setextVerification = validateF1Report(validReport.replace("## 검증\n", "검증\n---\n"));
assert.equal(setextVerification.valid, true, setextVerification.errors.join("; "));
expectInvalid(
  "an ATX section and Setext section cannot repeat the same title",
  validReport.replace(afterVerification, `검증\n---\n\n중복 검증\n\n${afterVerification}`),
  "duplicate required section: ## 검증",
);
const setextParticipantTableInAppendix = validateAiStatus(
  mainOnlyAiStatus.replace("| Agent ID", "\n추가 관측 예시\n===\n\n| Agent ID"),
  { observedParticipants: ["Main"], observationCoverage: "complete" },
);
assert.equal(setextParticipantTableInAppendix.valid, false, "a Setext appendix table cannot satisfy the AI section");
assert.ok(setextParticipantTableInAppendix.errors.includes("AI status must contain the required participant table"));
console.log(`f1 Setext section boundary fixtures passed: ${setextAppendices.length + setextNonBoundaries.length + 3}`);

const preListExamples = [
  "- 출력 예시\n  <pre>\n  ## 보이지 않는 제목",
  "- <pre>\n  ## 보이지 않는 제목",
  "- 출력 예시\n  - <pre>\n    <!-- 닫히지 않은 주석",
];
for (const example of preListExamples) {
  const result = validateF1Report(validReport.replace(afterVerification, `${example}\n\n${afterVerification}`));
  assert.equal(result.valid, true, `${example}: ${result.errors.join("; ")}`);
}
expectInvalid(
  "a top-level unclosed pre block continues to hide later sections",
  validReport.replace(afterVerification, `<pre>\n\n${afterVerification}`),
  `missing required section: ${afterVerification}`,
);
expectInvalid(
  "a status inside a list pre block is hidden until the list ends",
  validReport.replace(/^- CI: NOT_RUN.*$/mu, "- <pre>\n\n  CI: PASS — https://example.invalid/example"),
  "CI must have exactly one explicit status line",
);
console.log(`f1 list pre boundaries fixtures passed: ${preListExamples.length + 2}`);

for (const duplicateValue of ["YES", "NO"]) {
  const duplicateHeader = mainOnlyAiStatus.split("\n").map((line) => {
    if (line.startsWith("| Agent ID |")) return line + " 실제 참여 |";
    if (line.startsWith("|---|")) return line + "---|";
    if (line.startsWith("| Main |")) return line + ` ${duplicateValue} |`;
    return line;
  }).join("\n");
  const result = validateAiStatus(duplicateHeader, {
    observedParticipants: ["Main"], observationCoverage: "complete",
  });
  assert.equal(result.valid, false, "duplicate required headers must be rejected");
  assert.ok(result.errors.some((error) => error.includes("must not repeat required header: 실제 참여")));
}

const participantSummary = [
  "- 관측 범위: complete",
  "- 확인된 참여자 수: 1",
  "- 전체 참여자 수: 1",
].join("\n");
const participantExampleLines = participantSummary.replace(/^- /gmu, "").split("\n");
const inlineFormattedParticipantSummary = participantSummary.replace("complete", "`complete`").replaceAll(": 1", ": `1`");
const completeAiStatusOptions = { observedParticipants: ["Main"], observationCoverage: "complete" };
for (const prefix of ["", "    ", "\t", "2. "]) {
  const exampleParticipantSummary = [
    "예시 ``",
    prefix + "설명 줄",
    ...participantExampleLines,
    "``",
  ].join("\n");
  const exampleOnly = validateAiStatus(
    mainOnlyAiStatus.replace(participantSummary, exampleParticipantSummary),
    completeAiStatusOptions,
  );
  assert.equal(exampleOnly.valid, false, "a multiline inline code example cannot supply participant summary labels");
  assert.ok(exampleOnly.errors.some((error) => error.includes("exactly one observation coverage line")));
  assert.ok(exampleOnly.errors.some((error) => error.includes("one numeric confirmed participant count")));
  assert.ok(exampleOnly.errors.some((error) => error.includes("exactly one total participant count")));

  const exampleWithVisibleSummary = validateAiStatus(
    mainOnlyAiStatus.replace(participantSummary, [exampleParticipantSummary, inlineFormattedParticipantSummary].join("\n\n")),
    completeAiStatusOptions,
  );
  assert.equal(exampleWithVisibleSummary.valid, true, exampleWithVisibleSummary.errors.join("; "));
}

for (const exampleMarker of ["", "- "]) {
  const summaryWithCodeValues = participantSummary.replace("complete", "``complete``");
  const followingListItems = [exampleMarker + "예시 ``", "    설명 줄", summaryWithCodeValues].join("\n");
  const visibleSummaryAfterProse = validateAiStatus(
    mainOnlyAiStatus.replace(participantSummary, followingListItems),
    completeAiStatusOptions,
  );
  assert.equal(visibleSummaryAfterProse.valid, true, visibleSummaryAfterProse.errors.join("; "));
}

const exampleInListFence = [
  "- 예시 ```",
  "    ```text",
  ...participantExampleLines.map((line) => "    " + line),
  "    ```",
].join("\n");
const listFenceWithVisibleSummary = validateAiStatus(
  mainOnlyAiStatus.replace(participantSummary, [exampleInListFence, participantSummary].join("\n\n")),
  completeAiStatusOptions,
);
assert.equal(listFenceWithVisibleSummary.valid, true, listFenceWithVisibleSummary.errors.join("; "));

const mainParticipantTable = mainOnlyAiStatus.slice(mainOnlyAiStatus.indexOf("| Agent ID")).trimEnd();
const [participantHeader, participantDelimiter, mainParticipantRow] = mainParticipantTable.split("\n");
const exampleHeader = `| ${Array.from({ length: 11 }, (_, index) => `Example ${index + 1}`).join(" | ")} |`;
const conflictingParticipantTable = `${mainParticipantTable}\n| unobserved-writer | Writer | YES | 1 | 0 | 0 | UNKNOWN | UNKNOWN | UNKNOWN | 별도 작업 수행 | UNKNOWN |`;
const conflictingTableWithoutOuterPipes = conflictingParticipantTable.replace(/^\|\s*|\s*\|$/gmu, "");
const rawParticipantExample = `<report-example>\n${conflictingParticipantTable}\n</report-example>`;
const preformattedParticipantExample = `<pre>\n\n${mainParticipantTable}\n\n</pre>`;
const collapsedParticipantTable = `<details>\n<summary>참여 기록</summary>\n\n${mainParticipantTable}\n\n</details>`;
const aiStatusOptions = { observedParticipants: ["Main"], observationCoverage: "complete" };
const duplicateTableError = "AI status must contain exactly one participant table";
const aiStatusWithConflictingTable = `${mainOnlyAiStatus}\n${conflictingParticipantTable}\n`;
const duplicateTableCases = [
  ["conflicting table after the matching table", aiStatusWithConflictingTable],
  ["conflicting table before the matching table", mainOnlyAiStatus.replace(mainParticipantTable, `${conflictingParticipantTable}\n\n${mainParticipantTable}`)],
  ["two matching tables", `${mainOnlyAiStatus}\n${mainParticipantTable}\n`],
  ["collapsed matching table before a conflicting table", aiStatusWithConflictingTable.replace(mainParticipantTable, collapsedParticipantTable)],
  ["second table omits optional outer pipes", `${mainOnlyAiStatus}\n${conflictingTableWithoutOuterPipes}\n`],
  ["second table uses one hyphen per delimiter cell", `${mainOnlyAiStatus}\n${conflictingParticipantTable.replace(participantDelimiter, participantDelimiter.replace(/-{3}/gu, "-"))}\n`],
  ["thematic break ends the first table", `${mainOnlyAiStatus}---\n${conflictingParticipantTable}\n`],
  ["literal fence inside raw HTML before the second table", `${mainOnlyAiStatus}\n<div>\n\`\`\`\n</div>\n\n${conflictingParticipantTable}\n`],
  ["literal heading inside raw HTML before the second table", `${mainOnlyAiStatus}\n<div>\n## 메모\n</div>\n\n${conflictingParticipantTable}\n`],
  ["inline custom tag does not start a raw HTML block inside a paragraph", `${mainOnlyAiStatus}\n예제 설명\n<report-example>\n### 실제 참여 표\n${conflictingParticipantTable}\n`],
  ["case-insensitive script closing tag exposes the second table", `${mainOnlyAiStatus}\n<script>\n</SCRIPT>\n\n${conflictingParticipantTable}\n`],
  ["indentation inside a paragraph cannot start a code block", `${mainOnlyAiStatus}\n예제 설명\n    설명이 이어진다\n<report-example>\n### 실제 참여 표\n${conflictingParticipantTable}\n`],
  ["setext underline without heading text is a paragraph", `${mainOnlyAiStatus}\n===\n<report-example>\n### 실제 참여 표\n${conflictingParticipantTable}\n`],
  ["custom element with a pre prefix ends at a blank line", `${mainOnlyAiStatus}\n<pre-example>\nexample\n</pre-example>\n\n${conflictingParticipantTable}\n`],
];
for (const [description, report] of duplicateTableCases) {
  const result = validateAiStatus(report, aiStatusOptions);
  assert.equal(result.valid, false, description);
  assert.ok(result.errors.includes(duplicateTableError), `${description}: ${result.errors.join("; ")}`);
}

const singleTableCases = [
  ["unrelated table before the participant table", mainOnlyAiStatus.replace(mainParticipantTable, `| 메모 |\n|---|\n| 실행 환경 참고 |\n\n${mainParticipantTable}`)],
  ["fenced table example", `${mainOnlyAiStatus}\n\`\`\`markdown\n${conflictingParticipantTable}\n\`\`\`\n`],
  ["single collapsed participant table", mainOnlyAiStatus.replace(mainParticipantTable, collapsedParticipantTable)],
  ["sample header and delimiter interrupted by a fence", `${mainOnlyAiStatus}\n${participantHeader}\n\`\`\`markdown\nSeparate code example\n\`\`\`\n${participantDelimiter}\n${mainParticipantRow}\n`],
  ["sample table inside a textarea", `${mainOnlyAiStatus}\n<textarea>\n${conflictingParticipantTable}\n</textarea>\n`],
  ["sample table inside pre after a blank line", `${mainOnlyAiStatus}\n${preformattedParticipantExample}\n`],
  ["visible table after a preformatted sample", mainOnlyAiStatus.replace(mainParticipantTable, `\n${preformattedParticipantExample}\n\n${mainParticipantTable}`)],
  ["sample table inside a raw HTML block", `${mainOnlyAiStatus}\n<div>\n${conflictingParticipantTable}\n</div>\n`],
  ["sample table inside a custom HTML block", `${mainOnlyAiStatus}\n<report-example data-label=\">\">\n${conflictingParticipantTable}\n</report-example>\n`],
  ["space before script closing angle bracket keeps the example inside the raw block", `${mainOnlyAiStatus}\n<script>\n</script >\n\n${conflictingParticipantTable}\n</script>\n`],
  ["custom raw HTML after indented code", `${mainOnlyAiStatus}\n    들여쓴 예제\n${rawParticipantExample}\n`],
  ["custom raw HTML after a comment block", `${mainOnlyAiStatus}\n<!-- 예제 주석 -->\n${rawParticipantExample}\n`],
  ["custom raw HTML after a processing instruction", `${mainOnlyAiStatus}\n<?example?>\n${rawParticipantExample}\n`],
  ["custom raw HTML after a declaration", `${mainOnlyAiStatus}\n<!EXAMPLE>\n${rawParticipantExample}\n`],
  ["custom raw HTML after a setext heading", `${mainOnlyAiStatus}\n예제 제목\n===\n${rawParticipantExample}\n`],
  ["sample table inside a raw CDATA block", `${mainOnlyAiStatus}\n<![CDATA[\n\n${conflictingParticipantTable}\n]]>\n`],
  ["sample table inside an HTML processing instruction", `${mainOnlyAiStatus}\n<?example\n${conflictingParticipantTable}\n?>\n`],
  ["sample table inside an HTML declaration", `${mainOnlyAiStatus}\n<!EXAMPLE\n${conflictingParticipantTable}\n>\n`],
  ["comment prefix makes the sample header raw HTML", `${mainOnlyAiStatus}\n<!-- sample -->${conflictingParticipantTable}\n`],
  ["sample rows inside an unrelated table", `${mainOnlyAiStatus}\n### 표 구조 예시\n\n${exampleHeader}\n${participantDelimiter}\n${mainParticipantTable}\n`],
  ["unrelated table continues after a row with no pipes", `${mainOnlyAiStatus}\n${exampleHeader}\n${participantDelimiter}\n표 구조를 예로 든다\n${mainParticipantTable}\n`],
  ["literal backtick in a participant row", mainOnlyAiStatus.replace("결과 취합을 수행", "결과 취합과 리터럴 ` 기호 기록을 수행")],
];
for (const [description, report] of singleTableCases) {
  const result = validateAiStatus(report, aiStatusOptions);
  assert.equal(result.valid, true, `${description}: ${result.errors.join("; ")}`);
}

const onlyPreformattedTable = validateAiStatus(
  mainOnlyAiStatus.replace(mainParticipantTable, `\n${preformattedParticipantExample}`),
  aiStatusOptions,
);
assert.equal(onlyPreformattedTable.valid, false, "a preformatted sample alone cannot satisfy the participant table requirement");
assert.ok(onlyPreformattedTable.errors.includes("AI status must contain the required participant table"));

const fullReportWithConflictingTable = fullReportWithMainOnly.replace(mainOnlyAiStatus, aiStatusWithConflictingTable);
const fullReportWithDuplicateTableResult = validateF1Report(fullReportWithConflictingTable, {
  ...aiStatusOptions,
  requireAiStatus: true,
});
assert.equal(fullReportWithDuplicateTableResult.valid, false);
assert.ok(fullReportWithDuplicateTableResult.errors.includes(duplicateTableError));
console.log(`f1 participant table fixtures passed: ${duplicateTableCases.length + singleTableCases.length + 2}`);

const unknownCoverage = validateAiStatus(
  mainOnlyAiStatus.replace("관측 범위: complete", "관측 범위: unknown").replace("전체 참여자 수: 1", "전체 참여자 수: UNKNOWN"),
  { observationCoverage: "unknown" },
);
assert.equal(unknownCoverage.valid, true, unknownCoverage.errors.join("; "));
assert.equal(
  validateF1Report(mainOnlyAiStatus, { requireAiStatus: true, observedParticipants: ["Main"], observationCoverage: "complete" }).valid,
  false,
  "a partial AI-status check cannot stand in for the canonical eight-section report",
);

const requiredWithoutStatus = validateF1Report(validReport, { requireAiStatus: true, observationCoverage: "unknown" });
assert.equal(requiredWithoutStatus.valid, false);
assert.ok(requiredWithoutStatus.errors.some((error) => error.includes("missing required section: ## AI 실행 현황")));

const completeMultiAgent = validateAiStatus(multiAgentAiStatus, {
  observedParticipants: ["Main", "writer-a", "writer-b", "reviewer-a"],
  observationCoverage: "partial",
});
assert.equal(completeMultiAgent.valid, true, completeMultiAgent.errors.join("; "));

const nonParticipantWithoutLifecycleEvent = validateAiStatus(
  multiAgentAiStatus.replace("| spawned-no-work | Helper | NO | 1 | 0 | 0 |", "| spawned-no-work | Helper | NO | 0 | 0 | 0 |"),
  { observedParticipants: ["Main", "writer-a", "writer-b", "reviewer-a"], observationCoverage: "partial" },
);
assert.equal(nonParticipantWithoutLifecycleEvent.valid, false);
assert.ok(nonParticipantWithoutLifecycleEvent.errors.some((error) => error.includes("must have an observed spawn, resume, or continue event")));

const nonParticipantWithUnknownLifecycleEvents = validateAiStatus(
  multiAgentAiStatus.replace("| spawned-no-work | Helper | NO | 1 | 0 | 0 |", "| spawned-no-work | Helper | NO | UNKNOWN | UNKNOWN | UNKNOWN |"),
  { observedParticipants: ["Main", "writer-a", "writer-b", "reviewer-a"], observationCoverage: "partial" },
);
assert.equal(nonParticipantWithUnknownLifecycleEvents.valid, false);
assert.ok(nonParticipantWithUnknownLifecycleEvents.errors.some((error) => error.includes("must have an observed spawn, resume, or continue event with a positive count")));

const missingObservedParticipant = validateAiStatus(multiAgentAiStatus, {
  observedParticipants: ["Main", "writer-a", "writer-b", "reviewer-a", "writer-c"],
  observationCoverage: "partial",
});
assert.equal(missingObservedParticipant.valid, false);
assert.ok(missingObservedParticipant.errors.some((error) => error.includes("does not confirm observed participant: writer-c")));

const incompleteCoverageClaim = validateAiStatus(
  multiAgentAiStatus.replace("전체 참여자 수: UNKNOWN", "전체 참여자 수: 3"),
  { observedParticipants: ["Main", "writer-a", "writer-b", "reviewer-a"], observationCoverage: "partial" },
);
assert.equal(incompleteCoverageClaim.valid, false);
assert.ok(incompleteCoverageClaim.errors.some((error) => error.includes("partial or unknown AI status coverage")));

const completeCoverageMismatch = validateAiStatus(
  multiAgentAiStatus.replace("관측 범위: partial", "관측 범위: complete").replace("전체 참여자 수: UNKNOWN", "전체 참여자 수: 3"),
  { observedParticipants: ["Main", "writer-a"], observationCoverage: "complete" },
);
assert.equal(completeCoverageMismatch.valid, false);
assert.ok(completeCoverageMismatch.errors.some((error) => error.includes("participant is absent from observedParticipants: reviewer-a")));
const partialCoverageMismatch = validateAiStatus(multiAgentAiStatus, {
  observedParticipants: ["Main", "writer-a", "reviewer-a"],
  observationCoverage: "partial",
});
assert.equal(partialCoverageMismatch.valid, false);
assert.ok(partialCoverageMismatch.errors.some((error) => error.includes("participant is absent from observedParticipants: writer-b")));
const completeWithoutObservedList = validateAiStatus(
  mainOnlyAiStatus,
  { observationCoverage: "complete" },
);
assert.equal(completeWithoutObservedList.valid, false);
assert.ok(completeWithoutObservedList.errors.some((error) => error.includes("complete AI status coverage requires observedParticipants")));

const quotedSkillMention = validReport.replace("## 근거", "## 근거\n- `$dev-main-flow`라는 Skill 이름을 인용한 문장일 뿐 실제 호출은 아니다.");
assert.equal(validateF1Report(quotedSkillMention).valid, true, "quoted Skill names must not implicitly enable AI-status checks");
const quotedSkillCannotSatisfyRequiredStatus = validateF1Report(quotedSkillMention, { requireAiStatus: true });
assert.equal(quotedSkillCannotSatisfyRequiredStatus.valid, false, "quoted Skill names must not prove execution or participant coverage");
assert.ok(quotedSkillCannotSatisfyRequiredStatus.errors.some((error) => error.includes("missing required section: ## AI 실행 현황")));

const conciseHumanSummary = `## 결과
서비스별 F1 결과와 이번 변경을 요약한다.

## 검증 및 남은 범위
각 Gate의 상태와 남은 확인 사항을 요약한다.

## 다음 행동
목표와 첫 행동을 제시한다.

## 결정 요청
필요한 Owner 결정의 범위를 제시한다.
`;
expectInvalid(
  "summary-only human F1 is not a canonical checker PASS",
  conciseHumanSummary,
  "missing required section: ## 문제"
);

const inlineCommandEvidence = validReport.replace(
  /- Native Test:[^\n]*/,
  "- Native Test: PASS — `node scripts/test-f1-report-advisory.mjs`"
);
const inlineCommandResult = validateF1Report(inlineCommandEvidence);
assert.equal(inlineCommandResult.valid, true, inlineCommandResult.errors.join("; "));

const inlineFailCannotJoinPass = validReport.replace(
  "CI: NOT_RUN — 이 로컬 실행에서는 CI를 호출하지 않았다.",
  "CI: `FAIL`PASS — https://example.invalid/run"
);
expectInvalid(
  "inline code status cannot be removed to synthesize PASS",
  inlineFailCannotJoinPass,
  "CI must have exactly one explicit status line"
);

const commentedFailCannotJoinPass = validReport.replace(
  "CI: NOT_RUN — 이 로컬 실행에서는 CI를 호출하지 않았다.",
  "CI: FAIL<!-- hidden -->PASS — https://example.invalid/run"
);
expectInvalid(
  "HTML comment removal cannot join conflicting status words",
  commentedFailCannotJoinPass,
  "CI has unsupported status: FAILPASS"
);

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
const ownerGateLine = "- Owner Gate: PENDING — Source Merge 승인은 별도다.";
const visibleConflictingGateLines = [
  "- owner gate: BLOCKED — another decision",
  "+ Owner Gate: BLOCKED — another decision",
  "1. Owner Gate: BLOCKED — another decision",
  "2) Owner Gate: BLOCKED — another decision",
  "- **Owner Gate:** BLOCKED — another decision",
  "- __Owner Gate__: BLOCKED — another decision",
  "- *Owner Gate:* BLOCKED — another decision",
  "- **Owner Gate: BLOCKED** — another decision",
  "- ***Owner Gate:*** BLOCKED — another decision",
  "- Owner Gate: *BLOCKED* — another decision",
  "- Owner Gate: **BLOCKED** — another decision",
  "- Owner Gate: `BLOCKED` — another decision",
  "- [x] Owner Gate: BLOCKED — another decision",
  "   - Main gate details\n     - Owner Gate: BLOCKED — another decision",
];
const duplicateGateCases = [...visibleConflictingGateLines, "- Owner Gate: UNKNOWN_STATUS — another decision"];
for (const line of duplicateGateCases) {
  expectInvalid(
    `visible duplicate Owner Gate is ambiguous even when formatted differently: ${line}`,
    validReport.replace(ownerGateLine, `${ownerGateLine}\n\n${line}`),
    "Owner Gate must have exactly one explicit status line"
  );
}
const nestedGateParents = [ownerGateLine, " - 검증 상태: Native Test fixture를 실행했다."];
const nestedGateIndents = ["    ", "\t"];
for (const indent of nestedGateIndents) {
  for (const parent of nestedGateParents) {
    expectInvalid(
      "a visible nested Gate list item conflicts with the explicit Gate even under another report field",
      validReport.replace(parent, `${parent}\n${indent}- Owner Gate: BLOCKED — another decision`),
      "Owner Gate must have exactly one explicit status line"
    );
  }
}
for (const line of visibleConflictingGateLines) {
  const result = validateF1Report(validReport.replace(ownerGateLine, line));
  assert.equal(result.valid, true, `a single explicit Owner Gate is valid: ${line}: ${result.errors.join("; ")}`);
}
const nonStatusGateReferences = [
  "> **Owner Gate:** BLOCKED — quoted",
  "```md\n+ Owner Gate: BLOCKED — example\n```",
  "- ```md\n  - Owner Gate: BLOCKED — example\n  ```",
  "   - Main gate examples\n     ```md\n     - Owner Gate: BLOCKED — example\n     ```",
  "Owner Gate: The release criteria are in the linked issue.",
  "- Owner Gate: approval scope appears in the linked issue.",
  "Owner Gate: 독자가 구분할 승인 범위는 별도 문서에 설명한다.",
];
for (const line of nonStatusGateReferences) {
  const result = validateF1Report(validReport.replace(ownerGateLine, `${ownerGateLine}\n\n${line}`));
  assert.equal(result.valid, true, `examples and prose do not add a Gate status: ${line}: ${result.errors.join("; ")}`);
}
const gateCaseCount = duplicateGateCases.length + nestedGateParents.length * nestedGateIndents.length
  + visibleConflictingGateLines.length + nonStatusGateReferences.length;
console.log(`f1 visible Gate status fixtures passed: ${gateCaseCount}/${gateCaseCount}`);
expectInvalid("evidence lacks identifier", validReport.replace("- Base: 6d2a93893c0c7a40e1d0b99b691a8f950aa17969", "- Base: unknown"), "must include a URL or a source SHA");
expectInvalid("status outside verification section", validReport.replace(/- Native Test:.*\n/, "").replace("- Script: scripts/f1-report-advisory.mjs", "- Script: scripts/f1-report-advisory.mjs\n- Native Test: PASS — node scripts/test-f1-report-advisory.mjs"), "Native Test must have exactly one");
const replaceNativeStatus = (replacement) =>
  validReport.replace(/- Native Test:[^\n]*/, replacement);
expectInvalid(
  "four-space indented status is not evidence",
  replaceNativeStatus("    - Native Test: PASS — node fake-test.mjs 1/1"),
  "Native Test must have exactly one explicit status line"
);
expectInvalid(
  "tab-indented status is not evidence",
  replaceNativeStatus("\t- Native Test: PASS — node fake-test.mjs 1/1"),
  "Native Test must have exactly one explicit status line"
);
expectInvalid(
  "leading blank lines do not expose indented status",
  replaceNativeStatus("\n\n    - Native Test: PASS — node fake-test.mjs 1/1"),
  "Native Test must have exactly one explicit status line"
);
expectInvalid(
  "single-line HTML comment is not evidence",
  replaceNativeStatus("<!-- Native Test: PASS — node fake-test.mjs 1/1 -->"),
  "Native Test must have exactly one explicit status line"
);
expectInvalid(
  "multi-line HTML comment is not evidence",
  replaceNativeStatus(["<!--", "- Native Test: PASS — node fake-test.mjs 1/1", "-->"].join("\n")),
  "Native Test must have exactly one explicit status line"
);
expectInvalid(
  "fenced status inside verification section is not evidence",
  replaceNativeStatus(["```text", "- Native Test: PASS — node fake-test.mjs 1/1", "```"].join("\n")),
  "Native Test must have exactly one explicit status line"
);
const fakeStatusLines = [
  "- Native Test: FAIL — node fake-test.mjs 0/1",
  "- CI: FAIL — https://example.invalid/fake-run",
  "- Independent Review: FAIL — reviewer: fake, HEAD: deadbeef",
  "- Runtime E2E: FAIL — runtime: fake, evidence deadbeef",
  "- Owner Gate: BLOCKED — fake"
];
const hiddenStatuses = validReport.replace(
  "## 검증\n",
  "## 검증\n<!--\n" + fakeStatusLines.join("\n") + "\n-->\n"
    + fakeStatusLines.map((line) => "    " + line).join("\n") + "\n"
    + fakeStatusLines.map((line) => "\t" + line).join("\n") + "\n"
);
const hiddenStatusResult = validateF1Report(hiddenStatuses);
assert.equal(hiddenStatusResult.valid, true, hiddenStatusResult.errors.join("; "));
for (const indentation of [" ", "   "]) {
  // Indent headings after prose only. An indented heading after a list can belong to its last item.
  const indentedHeadings = validReport.replace(/^## (?=문제|사용자에게 달라지는 점|서비스 기능)/gm, `${indentation}## `);
  const indentedHeadingsResult = validateF1Report(indentedHeadings);
  assert.equal(indentedHeadingsResult.valid, true, indentedHeadingsResult.errors.join("; "));
}
const fourSpaceIndentedHeadingReport = validReport.replace(
  /## 검증\n[\s\S]*?(?=## 아직 안 되는 것)/,
  ["    ## 검증", ...fakeStatusLines.map((line) => "    " + line), ""].join("\n")
);
expectInvalid(
  "four-space indented heading remains code rather than a section",
  fourSpaceIndentedHeadingReport,
  "missing required section: ## 검증"
);
const duplicateVerificationReport = validReport.replace(
  "## 아직 안 되는 것",
  [
    "## 검증",
    "- Native Test: FAIL — node fake-test.mjs 0/1",
    "- CI: FAIL — https://example.invalid/fake-run",
    "- Independent Review: FAIL — reviewer: fake, HEAD: deadbeef",
    "- Runtime E2E: FAIL — runtime: fake, evidence deadbeef",
    "- Owner Gate: BLOCKED — duplicate conflicting evidence",
    "",
    "## 아직 안 되는 것"
  ].join("\n")
);
expectInvalid(
  "duplicate verification section cannot overwrite earlier evidence",
  duplicateVerificationReport,
  "duplicate required section: ## 검증"
);
const commentHiddenVerification = [
  "<!--",
  "## 검증",
  ...fakeStatusLines,
  "-->"
].join("\n");
const commentHiddenHeadingReport = validReport.replace(
  /## 검증\n[\s\S]*?(?=## 아직 안 되는 것)/,
  commentHiddenVerification + "\n\n"
);
expectInvalid(
  "verification heading and five fake statuses inside an HTML comment are hidden",
  commentHiddenHeadingReport,
  "missing required section: ## 검증"
);
const indentedCommentOpenerReport = validReport.replace("## 검증\n", "## 검증\n    <!--\n");
const indentedCommentOpenerResult = validateF1Report(indentedCommentOpenerReport);
assert.equal(indentedCommentOpenerResult.valid, true, indentedCommentOpenerResult.errors.join("; "));
const fence = String.fromCharCode(96).repeat(3);
const fencedCommentOpenerReport = validReport.replace(
  "## 검증\n",
  "## 검증\n" + fence + "text\n<!--\nfake status text\n" + fence + "\n"
);
const fencedCommentOpenerResult = validateF1Report(fencedCommentOpenerReport);
assert.equal(fencedCommentOpenerResult.valid, true, fencedCommentOpenerResult.errors.join("; "));
const inlineCodeCommentReport = validReport.replace(
  "## 검증\n",
  "## 검증\nThe literal " + String.fromCharCode(96) + "<!--" + String.fromCharCode(96) + " appears here.\n"
);
const inlineCodeCommentResult = validateF1Report(inlineCodeCommentReport);
assert.equal(inlineCodeCommentResult.valid, true, inlineCodeCommentResult.errors.join("; "));
const escapedCommentReport = validReport.replace(
  "## 검증\n",
  "## 검증\nThe literal \\<!-- appears here.\n"
);
const escapedCommentResult = validateF1Report(escapedCommentReport);
assert.equal(escapedCommentResult.valid, true, escapedCommentResult.errors.join("; "));
const commentPrefixedHeading = [
  "<!-- -->## 검증",
  ...fakeStatusLines
].join("\n");
const commentPrefixedHeadingReport = validReport.replace(
  /## 검증\n[\s\S]*?(?=## 아직 안 되는 것)/,
  commentPrefixedHeading + "\n\n"
);
expectInvalid(
  "comment removal cannot synthesize a verification heading",
  commentPrefixedHeadingReport,
  "missing required section: ## 검증"
);
const commentPrefixedFenceReport = validReport.replace(
  "## 검증\n",
  "## 검증\n<!-- -->" + fence + "text\n"
);
const commentPrefixedFenceResult = validateF1Report(commentPrefixedFenceReport);
assert.equal(commentPrefixedFenceResult.valid, true, commentPrefixedFenceResult.errors.join("; "));
const multilineInlineCodeCommentReport = validReport.replace(
  "## 검증\n",
  "## 검증\nLiteral " + String.fromCharCode(96) + "<!--\n"
    + String.fromCharCode(96) + " marker in a multiline code span.\n"
);
const multilineInlineCodeCommentResult = validateF1Report(multilineInlineCodeCommentReport);
assert.equal(multilineInlineCodeCommentResult.valid, true, multilineInlineCodeCommentResult.errors.join("; "));

const backtick = String.fromCharCode(96);
const fakeNativeInMultilineCode = validReport
  .replace(/- Native Test:[^\n]*\n/, "")
  .replace(
    "## 검증\n",
    "## 검증\nHere is " + backtick + "\n"
      + "Native Test: PASS — node fake.mjs 1/1\n"
      + backtick + " marker.\n"
  );
expectInvalid(
  "Native Test inside multiline inline code is not evidence",
  fakeNativeInMultilineCode,
  "Native Test must have exactly one explicit status line"
);
const twoSpaceFakeNativeInMultilineCode = fakeNativeInMultilineCode.replace(
  "Native Test: PASS — node fake.mjs 1/1",
  "  Native Test: PASS — node fake.mjs 1/1"
);
expectInvalid(
  "two-space-indented Native Test inside multiline inline code is not evidence",
  twoSpaceFakeNativeInMultilineCode,
  "Native Test must have exactly one explicit status line"
);
for (const indentation of ["    ", "\t"]) {
  const fakeNativeAfterIndent = fakeNativeInMultilineCode.replace(
    "Native Test: PASS — node fake.mjs 1/1",
    indentation + "The example continues.\nNative Test: PASS — node fake.mjs 1/1",
  );
  expectInvalid(
    "a multiline inline code example continues across an indented line",
    fakeNativeAfterIndent,
    "Native Test must have exactly one explicit status line",
  );
}
const fakePassingStatusLines = [
  "Native Test: PASS — node fake.mjs 1/1",
  "CI: PASS — https://example.invalid/fake-run",
  "Independent Review: PASS — reviewer: fake, HEAD: deadbeef",
  "Runtime E2E: PASS — runtime: fake, evidence deadbeef",
  "Owner Gate: APPROVED — RPL-119 fake approval"
];
const allStatusesInMultilineCode = validReport
  .replace(/- (?:Native Test|CI|Independent Review|Runtime E2E|Owner Gate):[^\n]*\n/g, "")
  .replace(
    "## 검증\n",
    "## 검증\nHere is " + backtick + "\n"
      + fakePassingStatusLines.join("\n") + "\n"
      + backtick + " marker.\n"
  );
expectInvalid(
  "all five statuses inside multiline inline code are not evidence",
  allStatusesInMultilineCode,
  "Native Test must have exactly one explicit status line"
);





const htmlPreBacktick = String.fromCharCode(96);
const ciLine = "- CI: NOT_RUN — 이 로컬 실행에서는 CI를 호출하지 않았다.";
const visibleCiAfterListFence = validateF1Report(validReport.replace(ciLine, [
  "- Example ```",
  "    ```text",
  "    CI: PASS — https://example.invalid/quoted-run",
  "    ```",
  ciLine,
].join("\n")));
assert.equal(visibleCiAfterListFence.valid, true, visibleCiAfterListFence.errors.join("; "));
const unclosedBeforeStatus = validReport.replace(
  ciLine,
  "- CI: " + htmlPreBacktick + "PASS — https://example.invalid/fake-run"
);
expectInvalid(
  "unclosed inline code cannot contribute a fake CI status",
  unclosedBeforeStatus,
  "CI must have exactly one explicit status line"
);
const unclosedStatusEvidence = validReport.replace(
  ciLine,
  "- CI: PASS — " + htmlPreBacktick + "https://example.invalid/fake-run"
);
expectInvalid(
  "unclosed inline code cannot provide CI evidence",
  unclosedStatusEvidence,
  "CI PASS requires evidence or a reason after an em dash"
);
const fakePreStatus = validReport.replace(
  ciLine,
  "<pre>CI: PASS — https://example.invalid/fake-run</pre>"
);
expectInvalid(
  "HTML pre status is not evidence",
  fakePreStatus,
  "CI must have exactly one explicit status line"
);
const multilinePreStatus = validReport.replace(
  ciLine,
  "<pre>\nCI: PASS — https://example.invalid/fake-run\n</pre>"
);
expectInvalid(
  "multiline HTML pre status is not evidence",
  multilinePreStatus,
  "CI must have exactly one explicit status line"
);
expectInvalid(
  "a blank line in a pre block does not expose a fake CI status",
  validReport.replace(ciLine, "\n<pre>\n\n- CI: PASS — https://example.invalid/fake-run\n\n</pre>\n"),
  "CI must have exactly one explicit status line"
);
const commentedPreCloseStatus = validReport.replace(
  ciLine,
  "<pre>\n<!-- </pre> -->\nCI: PASS — https://example.invalid/fake-run\n</pre>"
);
expectInvalid(
  "HTML pre close inside a comment does not expose fake status",
  commentedPreCloseStatus,
  "CI must have exactly one explicit status line"
);
const visibleStatusAfterPre = validReport.replace(
  ciLine,
  "<pre>CI: PASS — https://example.invalid/fake-run</pre>\n- CI: PASS — https://example.invalid/actual-run"
);
const visibleStatusAfterPreResult = validateF1Report(visibleStatusAfterPre);
assert.equal(visibleStatusAfterPreResult.valid, true, visibleStatusAfterPreResult.errors.join("; "));

const listHtmlBlocks = [
  ["- <textarea>", "  </textarea>"],
  ["1. <script>", "   </script>"],
  ["- <!--", "  -->"],
  ["- <details>", "  </details>"],
  ["- <report-example>", "  </report-example>"],
  ["- 출력 예시\n  - <textarea>", "    </textarea>"],
  ["- - <textarea>", "    </textarea>"],
];
for (const [opening, closing] of listHtmlBlocks) {
  const indentation = closing.match(/^ +/u)[0];
  const example = `${opening}\n${indentation}CI: PASS — https://example.invalid/example`;
  expectInvalid(
    "an HTML block opening on a list marker cannot supply CI evidence",
    validReport.replace(ciLine, `\n${example}\n${closing}\n`),
    "CI must have exactly one explicit status line"
  );
  const afterBlock = validateF1Report(validReport.replace(ciLine, `\n${example}\n${ciLine}`));
  assert.equal(afterBlock.valid, true, `${opening}: ${afterBlock.errors.join("; ")}`);
}
const tagInListParagraph = validateF1Report(validReport.replace(
  ciLine,
  "- 출력 예시\n  <report-example>\n  CI: NOT_RUN — 이 문단에서 실제 상태를 보고했다."
));
assert.equal(tagInListParagraph.valid, true, tagInListParagraph.errors.join("; "));
expectInvalid(
  "text after a same-line HTML block comment is not a Markdown status",
  validReport.replace(ciLine, "- <!-- 예시 --> CI: PASS — https://example.invalid/example"),
  "CI must have exactly one explicit status line"
);
const parentListAfterHtml = validateF1Report(validReport.replace(ciLine, [
  "- - <textarea>",
  "    CI: PASS — https://example.invalid/example",
  `  ${ciLine}`,
].join("\n")));
assert.equal(parentListAfterHtml.valid, true, parentListAfterHtml.errors.join("; "));
console.log(`f1 list HTML block fixtures passed: ${listHtmlBlocks.length * 2 + 3}`);

const serviceContractFields = [
  { label: "서비스명", line: "- 서비스명: oh-my-ai" },
  { label: "기능명", line: "- 기능명: F1 보고서 구조 검사" },
  { label: "현재 사용자 기능", line: "- 현재 사용자 기능: 사용자는 F1 보고서 필수 절과 다섯 Gate 상태의 구조를 확인할 수 있다." },
  { label: "실제 변경", line: " - 실제 변경: 한국어 보고 Skill 후보와 상태 표기 검사기, 서비스별 필수 보고 필드를 추가했다." },
  { label: "구현 상태", line: " - 구현 상태: validator 후보가 실행 가능하다." },
  { label: "검증 상태", line: " - 검증 상태: Native Test fixture를 실행했다." },
  { label: "문서 상태", line: " - 문서 상태: Skill 계약과 RPL-119 예시를 갱신했다." },
  { label: "배포 상태", line: " - 배포 상태: 운영 배포는 하지 않았다." },
  { label: "미지원 기능", line: " - 미지원 기능: 보고서 사실의 진실성 검사와 Runtime E2E." },
  { label: "미지원 이유", line: " - 미지원 이유: 이 도구는 구조를 advisory로 검사하며 원격 근거를 확인하지 않는다." },
  { label: "다음 목표", line: " - 다음 목표: F1 서비스별 보고 계약을 적용한다." },
  { label: "첫 행동", line: " - 첫 행동: 이 validator fixture와 RPL-119 예시를 실행해 확인한다." },
  { label: "담당 Lane", line: " - 담당 Lane: oh-my-ai reporting" },
  { label: "필요 조건", line: " - 필요 조건: report inputs와 고정 근거." }
];

for (const field of serviceContractFields) {
  const missing = validReport.replace(field.line + "\n", "");
  assert.notEqual(missing, validReport, "fixture contains " + field.label);
  expectInvalid("missing service report field " + field.label, missing, "missing required field: " + field.label);
  const empty = validReport.replace(field.line, "- " + field.label + ":   ");
  expectInvalid("empty service report field " + field.label, empty, "empty required field: " + field.label);
}

const blankCodeValue = validReport.replace(
  "- 서비스명: oh-my-ai",
  "- 서비스명: " + String.fromCharCode(96) + "  " + String.fromCharCode(96)
);
expectInvalid("inline code whitespace is an empty service value", blankCodeValue, "empty required field: 서비스명");

const referenceOnlyFeature = validReport.replace(
  "- 현재 사용자 기능: 사용자는 F1 보고서 필수 절과 다섯 Gate 상태의 구조를 확인할 수 있다.",
  "- 현재 사용자 기능: RPL-119 PR #88 761b5d25197faf32f7ad4b678e318d9a0a1c2400 https://example.invalid"
);
expectInvalid(
  "Jira, PR, SHA and URL references alone do not describe the current user feature",
  referenceOnlyFeature,
  "현재 사용자 기능 must describe"
);

const labeledReferenceOnlyFeature = validReport.replace(
  "- 현재 사용자 기능: 사용자는 F1 보고서 필수 절과 다섯 Gate 상태의 구조를 확인할 수 있다.",
  "- 현재 사용자 기능: Jira: RPL-119; commit SHA: 761b5d25197faf32f7ad4b678e318d9a0a1c2400"
);
expectInvalid(
  "Jira and SHA labels do not turn reference lists into a feature description",
  labeledReferenceOnlyFeature,
  "현재 사용자 기능 must describe"
);

const duplicateService = validReport.replace(
  "- 서비스명: oh-my-ai",
  "- 서비스명: oh-my-ai\n- 서비스명: another-service"
);
expectInvalid("duplicate service field is ambiguous", duplicateService, "ambiguous duplicate field: 서비스명");

const sameLineDuplicateService = validReport.replace(
  "- 서비스명: oh-my-ai",
  "- 서비스명: oh-my-ai 서비스명: another"
);
expectInvalid("same-line repeated explicit service field is ambiguous", sameLineDuplicateService, "ambiguous duplicate field: 서비스명");

const inlineCodeFieldExample = validReport.replace(
  "- 서비스명: oh-my-ai",
  "- 서비스명: oh-my-ai " + backtick + "서비스명: example" + backtick
);
const inlineCodeFieldExampleResult = validateF1Report(inlineCodeFieldExample);
assert.equal(inlineCodeFieldExampleResult.valid, true, inlineCodeFieldExampleResult.errors.join("; "));

const commentFieldExample = validReport.replace(
  "- 서비스명: oh-my-ai",
  "- 서비스명: oh-my-ai <!-- 서비스명: example -->"
);
const commentFieldExampleResult = validateF1Report(commentFieldExample);
assert.equal(commentFieldExampleResult.valid, true, commentFieldExampleResult.errors.join("; "));

const proseFieldNameAndColon = validReport.replace(
  " - 실제 변경: 한국어 보고 Skill 후보와 상태 표기 검사기, 서비스별 필수 보고 필드를 추가했다.",
  " - 실제 변경: 입력 예시의 서비스명: 표기를 설명하고, 한국어 보고 Skill 후보와 상태 표기 검사기, 서비스별 필수 보고 필드를 추가했다."
);
const proseFieldNameResult = validateF1Report(proseFieldNameAndColon);
assert.equal(proseFieldNameResult.valid, true, proseFieldNameResult.errors.join("; "));

const wrongSectionService = validReport
  .replace("- 서비스명: oh-my-ai\n", "")
  .replace("## 문제\n", "## 문제\n- 서비스명: oh-my-ai\n");
expectInvalid("service fields are confined to the service section", wrongSectionService, "field must be a visible Markdown label in ## 서비스 기능: 서비스명");

for (const placeholder of [
  { label: "미지원 이유", marker: "-" },
  { label: "구현 상태", marker: "*" },
  { label: "필요 조건", marker: "- [ ]" }
]) {
  const field = serviceContractFields.find((entry) => entry.label === placeholder.label);
  const labelPrefix = field.line.slice(0, field.line.indexOf(":") + 1);
  const report = validReport.replace(field.line, labelPrefix + " " + placeholder.marker);
  expectInvalid(
    "structural placeholder is not a required value for " + placeholder.label,
    report,
    "placeholder-only required field: " + placeholder.label
  );
}

const explicitNoUnsupported = validReport
  .replace(" - 미지원 기능: 보고서 사실의 진실성 검사와 Runtime E2E.", " - 미지원 기능: 없음")
  .replace(" - 미지원 이유: 이 도구는 구조를 advisory로 검사하며 원격 근거를 확인하지 않는다.", " - 미지원 이유: 해당 없음");
const explicitNoUnsupportedResult = validateF1Report(explicitNoUnsupported);
assert.equal(explicitNoUnsupportedResult.valid, true, explicitNoUnsupportedResult.errors.join("; "));

const hiddenFieldCases = [
  {
    name: "HTML comment",
    report: validReport.replace("- 서비스명: oh-my-ai", "<!-- - 서비스명: hidden -->"),
    missingLabel: "서비스명"
  },
  {
    name: "fenced block",
    report: validReport.replace(
      " - 구현 상태: validator 후보가 실행 가능하다.",
      backtick.repeat(3) + "text\n- 구현 상태: hidden\n" + backtick.repeat(3)
    ),
    missingLabel: "구현 상태"
  },
  {
    name: "indented code",
    report: validReport.replace(" - 첫 행동: 이 validator fixture와 RPL-119 예시를 실행해 확인한다.", "    - 첫 행동: hidden"),
    missingLabel: "첫 행동"
  },
  {
    name: "multiline inline code",
    report: validReport.replace(
      "- 현재 사용자 기능: 사용자는 F1 보고서 필수 절과 다섯 Gate 상태의 구조를 확인할 수 있다.",
      "문자열 " + backtick + "\n현재 사용자 기능: hidden\n" + backtick + " 안의 예시"
    ),
    missingLabel: "현재 사용자 기능"
  }
];
for (const hidden of hiddenFieldCases) {
  expectInvalid(
    "field inside " + hidden.name + " is not visible evidence",
    hidden.report,
    "missing required field: " + hidden.missingLabel
  );
}

const inlineValueService = validReport.replace(
  "- 서비스명: oh-my-ai",
  "- 서비스명: " + backtick + "oh-my-ai" + backtick
);
const inlineValueResult = validateF1Report(inlineValueService);
assert.equal(inlineValueResult.valid, true, inlineValueResult.errors.join("; "));
console.log("f1 service report field fixtures passed: " + (serviceContractFields.length * 2 + hiddenFieldCases.length + 14) + "/46");

console.log("f1 report advisory fixtures passed: 50/50");


// Preserve the original report pattern fixtures. Current master’s actual
// routing-status consumer matches keyword triggers only; consumer integration
// is checked separately below after skills/skill-index.json is regenerated.
const frontmatter = skill.split("\n---\n")[0];
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
  "이번 개발 결과를 보고서로 정리해줘",
  "어제 개발 결과 보고하지 마. 오늘 PR 결과 보고해줘",
  "개발 결과 보고하지 마. 오늘 PR 결과 보고해줘. 검증 근거도 설명해줘",
  "PR 결과 보고해줘? 결과의 의미를 설명해줘",
  "개발 결과 보고하지 마. 오늘 PR 결과 보고해줘? 결과의 의미를 설명해줘"
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
  "F1 보고 Skill 패턴 동작을 설명해줘",
  "개발 결과 보고해줘. 아니, 보고하지 마",
  "개발 결과 보고하지 마. PR 결과 보고해줘? 의미를 설명해줘"
];
for (const input of positiveRoutingInputs) {
  assert.equal(reportPattern.test(input.toLowerCase().slice(0, 2000)), true, "F1 positive route missed: " + input);
}
for (const input of negativeRoutingInputs) {
  assert.equal(reportPattern.test(input.toLowerCase().slice(0, 2000)), false, "F1 negative route matched: " + input);
}
console.log("f1 skill pattern fixtures passed: " + (positiveRoutingInputs.length + negativeRoutingInputs.length) + "/" + (positiveRoutingInputs.length + negativeRoutingInputs.length));

const f1Route = matchSkillCandidatesWithStatus("이번 개발 결과 보고해줘");
assert.ok(f1Route.candidates.some((candidate) => candidate.name === "engineering-communication-ko"), "current router must discover F1 service reports from a narrow keyword trigger");
assert.ok(!f1Route.candidates.some((candidate) => candidate.name === "daily-report"), "F1 development reports must not route to daily-report");

const dailyRoute = matchSkillCandidatesWithStatus("오늘 Slack 일일보고를 프로젝트별 진척률로 작성해줘");
assert.ok(dailyRoute.candidates.some((candidate) => candidate.name === "daily-report"), "Slack/Notion daily-report route must remain available");
assert.ok(!dailyRoute.candidates.some((candidate) => candidate.name === "engineering-communication-ko"), "generic Slack daily reports must not route to F1 development reporting");
console.log("f1 current-master skill routing compatibility fixtures passed: 2/2");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "scripts", "f1-report-advisory.mjs");
const examplePath = path.join(repoRoot, "docs", "examples", "f1-report-rpl119.md");
const absoluteSourceRootCli = spawnSync(process.execPath, [checkerPath, examplePath], {
  cwd: os.tmpdir(),
  encoding: "utf8",
  env: { ...process.env, OH_MY_AI_HOME: repoRoot },
  timeout: 5000,
});
if (absoluteSourceRootCli.error?.code === "EPERM") {
  console.log("f1 source-root advisory CLI child-process fixture NOT_RUN: sandbox spawnSync EPERM");
} else {
  assert.equal(absoluteSourceRootCli.error, undefined, absoluteSourceRootCli.error?.message);
  assert.equal(absoluteSourceRootCli.signal, null, absoluteSourceRootCli.stderr);
  assert.equal(absoluteSourceRootCli.status, 0, absoluteSourceRootCli.stderr);
  assert.match(absoluteSourceRootCli.stdout, /f1_report_structure_valid:/);
  assert.match(absoluteSourceRootCli.stdout, /advisory_only:/);
  console.log("f1 source-root advisory CLI child-process fixture passed: 1/1");
}

const aiStatusFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "f1-ai-status-cli-"));
try {
  const fullF1Path = path.join(aiStatusFixtureDir, "full-f1.md");
  const conciseStatusPath = path.join(aiStatusFixtureDir, "ai-status.md");
  const conflictingStatusPath = path.join(aiStatusFixtureDir, "conflicting-ai-status.md");
  fs.writeFileSync(fullF1Path, fullReportWithMainOnly);
  fs.writeFileSync(conciseStatusPath, mainOnlyAiStatus);
  fs.writeFileSync(conflictingStatusPath, aiStatusWithConflictingTable);

  const fullAiStatusCli = spawnSync(process.execPath, [
    checkerPath,
    fullF1Path,
    "--require-ai-status",
    "--observed-participants-json",
    '["Main"]',
    "--observation-coverage",
    "complete",
  ], { cwd: os.tmpdir(), encoding: "utf8", timeout: 5000 });
  if (fullAiStatusCli.error?.code === "EPERM") {
    console.log("f1 AI status CLI fixtures NOT_RUN: sandbox spawnSync EPERM");
  } else {
    assert.equal(fullAiStatusCli.error, undefined, fullAiStatusCli.error?.message);
    assert.equal(fullAiStatusCli.signal, null, fullAiStatusCli.stderr);
    assert.equal(fullAiStatusCli.status, 0, fullAiStatusCli.stderr);
    assert.match(fullAiStatusCli.stdout, /f1_report_structure_valid:/);
    assert.doesNotMatch(fullAiStatusCli.stdout, /partial/);

    const partialAiStatusCli = spawnSync(process.execPath, [
      checkerPath,
      conciseStatusPath,
      "--ai-status-only",
      "--observed-participants-json",
      '["Main"]',
      "--observation-coverage",
      "complete",
    ], { cwd: os.tmpdir(), encoding: "utf8", timeout: 5000 });
    assert.equal(partialAiStatusCli.error, undefined, partialAiStatusCli.error?.message);
    assert.equal(partialAiStatusCli.signal, null, partialAiStatusCli.stderr);
    assert.equal(partialAiStatusCli.status, 0, partialAiStatusCli.stderr);
    assert.match(partialAiStatusCli.stdout, /f1_ai_status_structure_valid_partial:/);
    assert.match(partialAiStatusCli.stdout, /does not mean the full eight-section F1 is valid/i);
    assert.doesNotMatch(partialAiStatusCli.stdout, /f1_report_structure_valid:/);

    const conflictingAiStatusCli = spawnSync(process.execPath, [
      checkerPath,
      conflictingStatusPath,
      "--ai-status-only",
      "--observed-participants-json",
      '["Main"]',
      "--observation-coverage",
      "complete",
    ], { cwd: os.tmpdir(), encoding: "utf8", timeout: 5000 });
    assert.equal(conflictingAiStatusCli.error, undefined, conflictingAiStatusCli.error?.message);
    assert.equal(conflictingAiStatusCli.signal, null, conflictingAiStatusCli.stderr);
    assert.equal(conflictingAiStatusCli.status, 1);
    assert.ok(conflictingAiStatusCli.stderr.includes(`invalid: ${duplicateTableError}`), conflictingAiStatusCli.stderr);
    console.log("f1 AI status CLI fixtures passed: 3/3");
  }
} finally {
  fs.rmSync(aiStatusFixtureDir, { recursive: true, force: true });
}

const syntheticUsageEnvelope = {
  result: { ok: true },
  usage_observation: {
    status: "UNVERIFIED_USAGE_NOTIFICATION",
    source: "Codex App Server JSON-RPC thread/tokenUsage/updated",
    source_verification: "UNKNOWN",
    runtime_version: "UNKNOWN",
    coverage: "UNKNOWN",
    observed_at: "2026-11-19T10:02:00.000Z",
    operation_window: {
      started_at: "2026-11-19T10:01:00.000Z",
      finished_at: "2026-11-19T10:02:00.000Z",
    },
    session_identity: "phr1.session.fixture.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    turn_attribution: "UNKNOWN",
    deduplication: "NOT_PERFORMED",
    aggregation: "LATEST_NOTIFICATION_ONLY_NO_SUM",
    notification_count: 1,
    model: "UNKNOWN",
    reasoning_effort: "UNKNOWN",
    fast: "UNKNOWN",
    token_usage: {
      last: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 10, cacheWriteInputTokens: 0 },
      total: { inputTokens: 70, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 100, cacheWriteInputTokens: 0 },
    },
  },
};
const syntheticAttribution = { agent_id: "writer-7", role: "Writer" };
const renderedUsage = formatUsageObservationForF1(syntheticUsageEnvelope, syntheticAttribution);
assert.equal(renderedUsage.agent_id, "writer-7");
assert.equal(renderedUsage.role, "Writer");
assert.match(renderedUsage.attribution, /CALLER_ASSERTED/);
assert.match(renderedUsage.usage_cell, /Agent execution usage UNKNOWN/);
assert.match(renderedUsage.usage_cell, /input=7/);
assert.match(renderedUsage.usage_cell, /reported_total=100/);
assert.match(renderedUsage.usage_cell, /latest matched notification only; no deduplication or sum/);
assert.match(renderedUsage.usage_cell, /model\/reasoning\/Fast.*UNKNOWN/);
assert.doesNotMatch(JSON.stringify(renderedUsage), /phr1.session.fixture.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);

for (const agentId of ["/root", "/root/review_usage/reader_2"]) {
  const usage = formatUsageObservationForF1(syntheticUsageEnvelope, { agent_id: agentId, role: "Writer" });
  assert.equal(usage.agent_id, agentId);
  assert.match(usage.attribution, /CALLER_ASSERTED/);
  assert.match(usage.usage_cell, /input=7/);
}
for (const agentId of ["/root/../writer", "/root//writer", "/root/", "/other/writer", "/root/writer|row"]) {
  assert.equal(formatUsageObservationForF1(syntheticUsageEnvelope, { agent_id: agentId, role: "Writer" }).agent_id, "UNKNOWN");
}
assert.equal(formatUsageObservationForF1(syntheticUsageEnvelope, { agent_id: "/root", role: "/root/writer" }).role, "UNKNOWN");

const noNotificationEnvelope = structuredClone(syntheticUsageEnvelope);
noNotificationEnvelope.usage_observation.status = "NO_NOTIFICATION_OBSERVED";
noNotificationEnvelope.usage_observation.token_usage = null;
noNotificationEnvelope.usage_observation.notification_count = 0;
const noNotificationUsage = formatUsageObservationForF1(noNotificationEnvelope, syntheticAttribution);
assert.match(noNotificationUsage.usage_cell, /does not prove the run had no usage/);
assert.doesNotMatch(noNotificationUsage.usage_cell, /input=7|reported_total=100/);
assert.equal(formatUsageObservationForF1(syntheticUsageEnvelope, { agent_id: "writer|injected", role: "Writer" }).agent_id, "UNKNOWN");
const wrongSourceEnvelope = structuredClone(syntheticUsageEnvelope);
wrongSourceEnvelope.usage_observation.source = "another-source";
assert.match(formatUsageObservationForF1(wrongSourceEnvelope, syntheticAttribution).usage_cell, /^UNKNOWN/);
const proxyEnvelope = new Proxy({}, { get() { throw new Error("getter must not execute"); } });
assert.match(formatUsageObservationForF1(proxyEnvelope, syntheticAttribution).usage_cell, /^UNKNOWN/);
const injectedTimestamp = structuredClone(syntheticUsageEnvelope);
injectedTimestamp.usage_observation.observed_at = "2026-11-19 (private-sentinel)";
const rejectedTimestamp = formatUsageObservationForF1(injectedTimestamp, syntheticAttribution);
assert.match(rejectedTimestamp.usage_cell, /^UNKNOWN/);
assert.doesNotMatch(rejectedTimestamp.usage_cell, /private-sentinel/);
const outOfWindow = structuredClone(syntheticUsageEnvelope);
outOfWindow.usage_observation.observed_at = "2026-11-19T10:03:00.000Z";
assert.match(formatUsageObservationForF1(outOfWindow, syntheticAttribution).usage_cell, /^UNKNOWN/);
const falseAbsence = structuredClone(noNotificationEnvelope);
falseAbsence.usage_observation.notification_count = 1;
assert.doesNotMatch(formatUsageObservationForF1(falseAbsence, syntheticAttribution).usage_cell, /no matching notification was observed/);
falseAbsence.usage_observation.notification_count = 0;
falseAbsence.usage_observation.source = "another-source";
assert.doesNotMatch(formatUsageObservationForF1(falseAbsence, syntheticAttribution).usage_cell, /no matching notification was observed/);
const unknownSession = structuredClone(syntheticUsageEnvelope);
unknownSession.usage_observation.session_identity = "UNKNOWN";
assert.doesNotMatch(formatUsageObservationForF1(unknownSession, syntheticAttribution).usage_cell, /input=7/);
console.log("f1 usage observation formatter fixtures passed: 10/10");

const usageFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "f1-usage-observation-"));
try {
  const usageInputPath = path.join(usageFixtureDir, "observation.json");
  fs.writeFileSync(usageInputPath, JSON.stringify(syntheticUsageEnvelope));
  const usageConsumerCli = spawnSync(process.execPath, [
    checkerPath,
    "--usage-observation-json", usageInputPath,
    "--usage-agent-id", "/root/review_usage",
    "--usage-role", "Writer",
  ], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: 5000,
  });
  if (usageConsumerCli.error?.code === "EPERM") {
    console.log("f1 usage observation consumer CLI fixture NOT_RUN: sandbox spawnSync EPERM");
  } else {
    assert.equal(usageConsumerCli.error, undefined, usageConsumerCli.error?.message);
    assert.equal(usageConsumerCli.signal, null, usageConsumerCli.stderr);
    assert.equal(usageConsumerCli.status, 0, usageConsumerCli.stderr);
    const cliUsage = JSON.parse(usageConsumerCli.stdout);
    assert.equal(cliUsage.mode, "MANUAL_F1_USAGE_CELL; not inserted into a report");
    assert.equal(cliUsage.agent_id, "/root/review_usage");
    assert.match(cliUsage.attribution, /CALLER_ASSERTED/);
    assert.match(cliUsage.usage_cell, /Agent execution usage UNKNOWN/);
    assert.match(cliUsage.usage_cell, /input=7/);
    assert.doesNotMatch(usageConsumerCli.stdout, /phr1.session.fixture.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
    console.log("f1 usage observation formatter and CLI fixtures passed: 1 CLI + 7 contract cases");
  }
} finally {
  fs.rmSync(usageFixtureDir, { recursive: true, force: true });
}
