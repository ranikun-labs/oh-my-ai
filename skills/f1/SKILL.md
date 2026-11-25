---
name: f1
description: Explicit-only Korean F1 summary and development reporting. Choose a concise answer for questions, design or research and preserve the existing report and advisory contract for development outcomes. Invoke only when the user types /f1.
disable-model-invocation: true
metadata:
  source: born-here
  summary: 일반 질문·설계·연구의 핵심정리와 개발 F1 보고를 구분하고 정식 보고서의 구조 검사를 유지
---

# /f1 — 목표 중심 핵심정리와 개발 결과 보고

명시 호출(`/f1`) 전용이다. 질문 의도와 요청한 산출물에 맞게 출력 형태를 선택한다. 별도의 실행·위임·원격 쓰기 권한을 부여하지 않는다.

## 절차
1. `skills/engineering-communication-ko/SKILL.md`의 공통 작성 원칙과 출력 선택 기준을 읽고 적용한다. F1 계약은 여기서 중복 정의하지 않는다.
2. 일반 질문·설계·연구·검수의 핵심 설명은 목적과 결론, 필요한 이유·근거·다음 행동을 중심으로 질문 규모에 비례해 답한다. 정식 개발 보고서의 필수 절·필드를 일반 질문에 강제하지 않는다.
3. 개발 결과 보고와 정식 F1 보고서는 기존 보고 순서, 증거 표현, 필수 필드·Gate 및 적용되는 AI 실행 현황 계약을 유지한다. `dev-main-flow`가 요구하는 F1을 일반 설명으로 대체하지 않는다.
4. 정식 개발 F1 보고서가 파일로 존재하거나 사용자가 파일의 F1 구조 검사를 요청하면 읽기 전용 구조 검사를 실행한다.
   - `node scripts/f1-report-advisory.mjs <report.md>`
   - 옵션과 사용법은 스크립트 헤더와 `docs/examples/f1-report-rpl119.md`를 따른다.
   - 스크립트, 예시, 원본 보고서는 수정하지 않는다. 구조 오류가 있는 정식 보고서를 일반 핵심정리로 재분류하여 검사 실패를 피하지 않는다.
   - 일반 연구·설계·질문 자료 파일이라는 이유만으로 정식 개발 F1 검사기를 실행하지 않는다. 기존 정식 보고 및 검사 상태는 그대로 기록한다.
5. 결과를 자연스러운 한국어로 전달한다. 필요한 배경과 실제 의미를 먼저, 검증 근거는 보존하여 뒤에 둔다.

## 한계
- advisory는 **구조 검사일 뿐**이다. 독자의 이해도·URL·SHA·테스트 결과의 진실성, 독립 검토, Native Runtime 증명은 검증하지 않는다.
- Native 호출 성공은 이 Skill이 증명하지 않는다. CI·로컬 검증 결과와 구분해 적는다.
- 일반 `/핵심정리` 요청에도 공통 설명 원칙을 적용하되 이 Skill의 Native alias가 존재하거나 호출됐다고 추정하지 않는다. 기존 PR/Commit의 작성 형식과 승인·검증 필드는 유지한다.

## 위임 경계
- 한국어 문장 작성은 `engineering-communication-ko`가 담당한다. `/f1`과 `/dev-main-flow`는 `/한글화`를 자동·반복 호출하지 않는다.
- 사용자가 `/f1 /한글화`를 함께 명시하면 F1의 요청된 구조와 한글화의 원문 보존 계약을 한 번의 작성에 함께 적용한다. 의미·수치·코드·링크·식별자·검증 상태를 잃지 않으며 원문 보존 또는 정식 형식 요청을 존중한다. 별도 변환 모델·Reviewer 호출을 강제하지 않는다.
