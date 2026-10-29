---
name: engineering-communication-ko
description: Write clear Korean reports for software development outcomes, keeping user impact, evidence, limits, and next action distinct.
metadata:
  source: born-here
  summary: 개발 결과를 사용자 관점과 검증 근거 중심으로 한국어 보고
  routing:
    visibility: contextual
    risk_level: low
    task_types:
      - reporting
    triggers:
      - kind: pattern
        values:
          - ^(?![\s\S]*(?:보고|정리|요약)\s*했(?:어|다|습니다|었(?:다|어))\s*[.!?]*$)(?![\s\S]*(?:보고|정리|요약)(?:의|에\s*관한)?\s*(?:정의|형식|사례|예시|패턴|동작|원리|사용법))(?![\s\S]*(?:skill|스킬)\s*(?:패턴|라우팅|동작|원리|사용법))(?![\s\S]*(?:보고|정리|요약)\s*(?:하지\s*(?:마|말|않)|안\s*(?:해|하|했)|할\s*필요\s*없|금지))(?![\s\S]*(?:라고\s*(?:했|말|쓰)|라는\s*(?:말|표현|문장)|문장을?\s*(?:설명|분석)|(?:무슨|어떤)\s*뜻|의미가?\s*뭐|과거형))(?![\s\S]*(?:방법|하는\s*법)[\s\S]*(?:알려|설명)\s*(?:해)?\s*줘)(?!\s*(?:왜|무엇|뭐|어떻게|방법|설명해줘|예시))(?=[\s\S]*(?:개발|구현|테스트|pr|작업|f1|핵심정리))(?=[\s\S]*(?:결과|보고|정리|성과))[\s\S]*(?:(?:보고|정리|요약)\s*(?:해\s*줘|해\s*주세요|해\s*줄래|해\s*봐|해\s*보자|부탁(?:해|드립니다|합니다)?|하자|해줘요|해주실래)|(?:보여\s*줘|설명\s*해\s*줘|알려\s*줘))\s*[.!?]*$
      - kind: intent
        values:
          - summarize_development_outcome_in_korean
    keywords:
      ko:
        - 개발 결과
        - 구현 결과
        - 검증 결과
        - 남은 작업
    use_when:
      - 구현·검수·통합 결과를 한국어로 쉽게 설명해야 하는 경우
    do_not_use_when:
      - 사용자가 원문 로그나 기계용 산출물만 요청한 경우
      - 검증되지 않은 작업 완료를 꾸며 내야 하는 상황
    requires:
      - task_scope
      - available_evidence
---

# 한국어 개발 결과 보고

첫 문장은 사용자가 겪던 문제와 이번에 달라진 점을 말한다. 세부 로그나 파일 목록으로 시작하지 않는다.

## 보고 순서

1. 해결하려던 문제와 사용자에게 생기는 변화
2. 이번에 실제 바뀐 코드·문서·PR과 새 Commit/HEAD
3. 검증 결과와 확인한 근거
4. 아직 되지 않거나 확인하지 않은 것
5. 다음 행동과 필요한 Owner 결정

## 증거 표현

- `Native Test`, `CI`, `Independent Review`, `Runtime E2E`, `Owner Gate`를 각각 별도 상태로 적는다.
- 상태는 `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED`, `UNKNOWN` 중 하나로 쓴다. Owner Gate는 `APPROVED`, `PENDING`, `BLOCKED`, `UNKNOWN`, `NOT_REQUIRED`를 쓴다.
- PASS에는 실행 명령·CI 링크·검수자와 고정 HEAD 등 확인 가능한 근거를 붙인다.
- 요청 모델/Reasoning/Fast와 실제 적용값을 구분한다. 실효 설정을 못 읽으면 `UNKNOWN`으로 남긴다.
- 합성 Fixture, 코드 리뷰, 공식 CI, 실제 Runtime E2E는 서로 대신하지 않는다.
- 계획·Patch Candidate·로컬 수정은 Commit이나 PR 업데이트로 표현하지 않는다.
- Reviewer가 자신의 변경을 검수한 결과를 독립 Review로 표시하지 않는다.
- 개인 정책, 비공개 데이터, Secret을 공개 보고에 넣지 않는다.

## Advisory 검사기

Markdown 보고서의 필수 절과 상태 표기를 점검하려면 다음을 사용한다:

```bash
node scripts/f1-report-advisory.mjs <report.md>
```

검사기는 구조만 확인한다. URL·SHA·테스트·검수 독립성·Owner 승인의 진실성은 검증하지 않는다.
