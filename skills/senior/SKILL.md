---
name: senior
description: Explicit-only senior design, contract, and risk review in three modes (Preflight, fixed-base read-only Review, Delta Closure). Invoke only when the user types /senior.
disable-model-invocation: true
metadata:
  source: born-here
  summary: 시니어 수준 설계·계약·위험을 Preflight·독립 Review·Delta Closure 3모드로 검토
---

# /senior — 시니어 설계·위험 검토

명시 호출(`/senior`) 전용이다. 모델이 자율적으로 호출하지 않는다.

## 입력
- 대상 Repository와 PR 번호 또는 작업 설명
- Base/HEAD 커밋 (Review·Delta 모드에서 필수)
- 이전 Finding 목록 (Delta 모드에서 필수)

## 모드

| 모드 | 목적 | 쓰기 |
|------|------|------|
| Preflight | 실행 전 범위·권한·위험 사전 점검 | 없음 (읽기 전용) |
| Review | 고정 Base/HEAD에 대한 독립 검토 | 없음, 원격 쓰기 금지 |
| Delta Closure | 기존 Finding이 새 HEAD에서 닫혔는지 확인 | 없음 |

- Preflight 판정: `READY` / `CHANGES_REQUIRED` / `BLOCKED`
- Review 심각도: `BLOCKER` / `MAJOR` / `MINOR` / `NOTE`
- Delta 판정: Finding별 `CLOSED` / `OPEN` / `UNKNOWN`

## 원칙
- 검토 기준(트레이드오프와 추천 1개, 실패 모드 우선, 증거 없는 단언 금지, 숨은 비용 명시)은 `instructions/harness.md`의 "품질 기준 — 네카라 시니어 실무급"을 따른다. 이 Skill에 복사하지 않는다.
- Dev 흐름에서 `/senior`의 위치는 `skills/dev-main-flow/SKILL.md`의 "Apply a proportional `/senior` review" 절을 따른다.
- 작성과 검토를 같은 세션이 겸하면 독립성은 `UNKNOWN`으로 기록한다.

## 출력
- 한국어 F1 형식: 결론 → 근거 → 남은 범위 → 다음 행동
- 각 항목 상태: `PASS` / `FAIL` / `NOT_RUN` / `BLOCKED` / `UNKNOWN`
- 실행하지 않은 검증은 `NOT_RUN`으로 적는다.
