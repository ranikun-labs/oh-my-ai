---
name: f1
description: Explicit-only Korean F1 development report. Applies the report order and, when a report file exists, runs the read-only F1 structure advisory. Invoke only when the user types /f1.
disable-model-invocation: true
metadata:
  source: born-here
  summary: 개발 결과를 F1 보고 순서로 정리하고, 보고서 파일이면 구조 advisory를 읽기 전용으로 실행
---

# /f1 — 개발 결과 F1 보고

명시 호출(`/f1`) 전용이다.

## 절차
1. `skills/engineering-communication-ko/SKILL.md`를 읽고 그 보고 순서와 증거 표현을 그대로 적용한다. F1 계약은 여기서 새로 쓰지 않는다.
2. 보고서가 파일로 있으면 읽기 전용으로 구조 검사를 실행한다.
   - `node scripts/f1-report-advisory.mjs <report.md>`
   - 옵션과 사용법은 스크립트 헤더와 `docs/examples/f1-report-rpl119.md`를 따른다.
   - 스크립트, 예시, 원본 보고서는 수정하지 않는다.
3. 결과를 한국어 F1로 전달한다.

## 한계
- advisory는 **구조 검사일 뿐**이다. URL·SHA·테스트 결과의 진실성, 독립 검토, Native Runtime 증명은 검증하지 않는다.
- Native 호출 성공은 이 Skill이 증명하지 않는다. CI·로컬 검증 결과와 구분해 적는다.

## 위임 경계
- 한국어 문장 다듬기는 `/한글화`에 맡기지 않는다. 한국어 작성은 `engineering-communication-ko`가 담당한다.
- `/f1`과 `/dev-main-flow`는 `/한글화`를 자동·반복 호출하지 않는다. 사용자가 명시 호출한 경우에만 쓴다 (토큰 절약).
