import assert from "node:assert/strict";
import { matchSkillCandidatesWithStatus } from "./lib/routing-status.mjs";
const patternOnly = { name: "engineering-communication-ko", path: "f1", routing: { visibility: "contextual", risk_level: "low", task_types: ["reporting"], triggers: [{ kind: "pattern", values: ["^hello$"] }] } };
const options = { indexResult: { status: "ok", skills: [patternOnly], warnings: [] } };
assert.equal(matchSkillCandidatesWithStatus("hello", options).status, "matched");
assert.equal(matchSkillCandidatesWithStatus("no", options).status, "no_match");
assert.equal(matchSkillCandidatesWithStatus("hello" + "x".repeat(2000), options).status, "no_match");
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

const cases = [
  ...positiveRoutingInputs.map(input => ({ input, expected: true })),
  ...negativeRoutingInputs.map(input => ({ input, expected: false })),
  { input: "개발 결과 보고", expected: true },
  { input: "F1 보고서", expected: true },
  { input: "  개발 결과 보고  ", expected: true },
  { input: "일일보고 작성해줘", expected: false, other: "daily-report" },
  { input: "기록" + ".".repeat(1987) + "개발 결과 보고해줘 아니, 개발 결과 보고하지 마", expected: false },
];
for (const { input, expected, other } of cases) {
  console.log(`${Buffer.from(input).toString("base64")}\t${expected}\t${other || ""}`);
}
