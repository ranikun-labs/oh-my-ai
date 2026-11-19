import assert from "node:assert/strict";
import fs from "node:fs";
import { matchSkillCandidatesWithStatus } from "./lib/routing-status.mjs";

for (const input of ["이번 주 슬랙 주간보고 작성해줘", "write a weekly report for slack", "오늘 Slack 일일보고를 작성해줘"]) {
  const names = matchSkillCandidatesWithStatus(input).candidates.map((candidate) => candidate.name);
  assert.ok(names.includes("daily-report"), `daily-report missing for ${input}`);
  assert.ok(!names.includes("engineering-communication-ko"), `unexpected F1 route for ${input}`);
}
const f1 = matchSkillCandidatesWithStatus("이번 개발 결과 보고해줘").candidates.map((candidate) => candidate.name);
assert.ok(f1.includes("engineering-communication-ko"));
assert.ok(!f1.includes("daily-report"));
const skill = fs.readFileSync(new URL("../skills/daily-report/SKILL.md", import.meta.url), "utf8");
for (const required of ["양 끝 포함", "어느 한쪽이라도 없으면 날짜를 요청", "[YYYY-MM-DD ~ YYYY-MM-DD]", "가장 최신 날짜 기록", "이전보다 낮아도", "같은 날짜", "충돌을 표시", "기간 밖 기록은 제외", "일일보고 중복 주의", "worklog-note"]) {
  assert.ok(skill.includes(required), `weekly contract missing: ${required}`);
}
console.log("weekly report routing and contract checks passed");
