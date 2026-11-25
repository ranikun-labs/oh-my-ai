---
name: senior
description: Explicit-only senior design, contract, and risk review in three modes (Preflight, fixed-base read-only Review, Delta Closure) plus a one-pass Prompt Preflight that corrects a delegated or pasted work prompt before execution. Invoke only when the user types /senior.
disable-model-invocation: true
metadata:
  source: born-here
  summary: 시니어 수준 설계·계약·위험을 Preflight·독립 Review·Delta Closure 3모드와 작업 프롬프트 1회 사전 보정(Prompt Preflight)으로 검토
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
| Prompt Preflight | 위임·붙여넣기 작업 프롬프트를 실행 전에 한 번 보정 | 없음 (보정 결과는 프롬프트 문안에만 반영) |

- Preflight 판정: `READY` / `CHANGES_REQUIRED` / `BLOCKED` (Prompt Preflight도 같은 판정을 쓴다)
- Review 심각도: `BLOCKER` / `MAJOR` / `MINOR` / `NOTE`
- Delta 판정: Finding별 `CLOSED` / `OPEN` / `UNKNOWN`

## Prompt Preflight — 작업 프롬프트 1회 보정

적용 대상: 다른 세션·Worker에 위임하려는 프롬프트나 사용자가 붙여넣은 작업 지시문. `/senior`로 명시 호출했을 때만 수행한다.

**원칙**
- 1회만 본다. 전체 재조사, 반복 Review, 같은 질문 반복을 하지 않는다. 깊이는 프롬프트 크기와 위험에 비례한다. 사소한 프롬프트는 한 줄 판정으로 끝낸다.
- 보정은 Review가 아니라 착수 전 문안 정리다. 프롬프트의 목표·범위·전제를 고쳐 쓰는 데서 멈춘다.
- 승인 범위를 넓히지 않는다. 새 구현·원격 쓰기·모델 호출 권한은 이 모드로 생기지 않는다. 같은 워크스트림의 후속 프롬프트에도 같은 기준을 적용하되 승인 근거로 쓰지 않는다.

**점검 항목 (짧은 체크리스트)**
1. 목표 적합성: 사용자에게 최종적으로 보일 결과와 지시된 구현 범위가 맞는가.
2. 사실 정합성: 기술 전제, 경로, 티켓, PR, 런타임 지원을 최신 정본(Owner 승인 문서, 현재 코드/HEAD)과 대조했는가. 충돌하면 차이와 근거를 적고 맹목적으로 따르지 않는다.
3. 기존 자산 재사용: 기존 기능·스킬·어댑터·계약·검증과 중복되지 않는가.
4. 누락·위험: 권한, 동시성, 실패 복구, 호환성, 비용·사용량, 검증 조건이 빠지지 않았는가.
5. 과설계 방지: 더 단순하고 유지보수하기 쉬운 대안이 있는가. 있으면 추천 1개와 버리는 것을 적는다.
6. 완료 조건: "구현됨"과 "실제로 사용 가능함"을 구분하는 기준이 있는가.
7. AI 실행 효율: 반복 조사, 중복 Review, 불필요한 모델 호출과 컨텍스트를 줄였는가.

**보정 권한**
- 승인 범위 안의 저위험 공백(검증 조건, 용어, 경로 확인 순서 등)은 메인 세션이 문안에 직접 반영하고 이유를 한 줄 남긴다.
- 제품 목표 변경, 핵심 구현 권한, 보안 계약, 소스 병합, 운영 환경 변경은 보정하지 않고 Owner 결정으로 분리한다. 결정 항목마다 추천안 1개와 이유를 붙여 한 묶음으로 묻는다.
- 복잡하거나 위험한 항목은 적절한 독립 Reviewer를 요청하는 것으로 충분하다. 이 모드에서 직접 독립 Review를 대신하지 않는다.

**출력 (한국어, 이 순서)**
- 발견한 문제
- 보완한 사항과 이유
- 제외한 과설계·중복
- 남은 Owner 결정
- 착수 판정: `READY` / `CHANGES_REQUIRED` / `BLOCKED`

## 원칙
- 검토 기준(트레이드오프와 추천 1개, 실패 모드 우선, 증거 없는 단언 금지, 숨은 비용 명시)은 `instructions/harness.md`의 "품질 기준 — 네카라 시니어 실무급"을 따른다. 이 Skill에 복사하지 않는다.
- Dev 흐름에서 `/senior`의 위치는 `skills/dev-main-flow/SKILL.md`의 "Apply a proportional `/senior` review" 절을 따른다.
- 같은 세션에서 Writer와 Reviewer를 겸하면 독립 Review를 충족하지 않은 것으로 명시한다. `UNKNOWN`은 실제 세션 분리를 확인할 수 없을 때만 쓴다.

## 출력
- 한국어 F1 형식: 결론 → 근거 → 남은 범위 → 다음 행동
- 각 항목 상태: `PASS` / `FAIL` / `NOT_RUN` / `BLOCKED` / `UNKNOWN`
- 실행하지 않은 검증은 `NOT_RUN`으로 적는다.
