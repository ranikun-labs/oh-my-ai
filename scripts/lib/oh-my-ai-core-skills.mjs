// Core Skill 목록 (잠정). 사용자에게 기본 노출을 권하는 Skill ID 집합이다.
// 확정 기준이 없으므로 변경 시 docs/harness/cli.md 의 Core 절과 함께 갱신한다.
// 목록에 있어도 source 트리에 없으면 skills 명령이 missing-source 로 표시한다.
export const CORE_SKILLS = Object.freeze([
  "dev-main-flow",
  "adaptive-goal-closure",
  "senior",
  "f1",
  "engineering-communication-ko",
  "한글화",
  "project-context",
  "handoff-prompt",
  "git-work-preflight",
  "execution-recovery",
  "work-start",
  "batch-report",
]);
