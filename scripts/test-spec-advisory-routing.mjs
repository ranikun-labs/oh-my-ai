import assert from "node:assert/strict";
import { matchSkillCandidatesWithStatus } from "./lib/routing-status.mjs";

const cases = [
  ["Please build a new permissions system with requirements and acceptance criteria", true],
  ["요구사항과 인수 기준을 정해서 권한 기능 구현해줘", true],
  ["승인된 명세 사용하지 마", false],
  ["Do not build with requirements and acceptance criteria", false],
  ["요구사항과 인수 기준을 정해서 구현하지 마", false],
  ["Explain how to build with requirements and acceptance criteria", false],
  ['이 문구를 검토해: "요구사항과 인수 기준을 정해서 권한 기능 구현해줘"', false],
  ["요구사항과 인수 기준을 정리해줘. 아이디어만 검토해", false],
  ["Please explain how to build a permissions system with requirements and acceptance criteria.", false],
  ["Can you explain how to build a permissions system with requirements and acceptance criteria?", false],
  ["Please add one comma to the requirements and acceptance criteria.", false],
  ["'Build a permissions system with requirements and acceptance criteria'", false],
  ["요구사항과 인수 기준을 정해서 권한 기능 구현해줘. 실제 구현은 안 해도 돼.", false],
  ["Define requirements and acceptance criteria first for the new cross-tenant authorization system.", true],
  ["요구사항과 인수 기준을 정해서 권한 기능 구현해줘라는 문장은 무슨 뜻이야?", false],
  ["이번 개발 결과 보고해줘", false],
  ["Please build with requirements and acceptance criteria" + " ".repeat(2100), false],
];

for (const [input, expected] of cases) {
  const { candidates } = matchSkillCandidatesWithStatus(input.toLowerCase());
  assert.equal(candidates.some(({ name }) => name === "spec-to-implementation"), expected, input.slice(0, 90));
}
console.log(`spec advisory routing: ${cases.length}/${cases.length} PASS`);
