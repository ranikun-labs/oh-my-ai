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
      - kind: keyword
        values:
          - 개발 결과 보고
          - 구현 결과 보고
          - 검증 결과 보고
          - 서비스 기능 보고
          - F1 보고서
      - kind: pattern
        values:
          - ^(?![\s\S]*(?:보고|정리|요약)\s*했(?:어|다|습니다|었(?:다|어))\s*[.!?]*$)(?![\s\S]*(?:보고|정리|요약)(?:의|에\s*관한)?\s*(?:정의|형식|사례|예시|패턴|동작|원리|사용법))(?![\s\S]*(?:skill|스킬)\s*(?:패턴|라우팅|동작|원리|사용법))(?![\s\S]*(?:보고|정리|요약)\s*(?:하지\s*(?:마|말|않)|안\s*(?:해|하|했)|할\s*필요\s*없|금지)(?![\s\S]*(?:보고|정리|요약)\s*(?:해\s*줘|해\s*주세요|해\s*줄래|해\s*봐|해\s*보자|부탁(?:해|드립니다|합니다)?|하자|해줘요|해주실래)))(?![\s\S]*(?:보고|정리|요약)\s*(?:하지\s*(?:마|말|않)|안\s*(?:해|하|했)|할\s*필요\s*없|금지)[\s\S]*(?:보고|정리|요약)\s*(?:해\s*줘|해\s*주세요|해\s*줄래|해\s*봐|해\s*보자|부탁(?:해|드립니다|합니다)?|하자|해줘요|해주실래)\s*[?？]\s*[\s\S]*(?<!결과의 )(?:의미|뜻|표현|문장)\s*(?:를|을|는|이)?\s*(?:설명|알려))(?![\s\S]*(?:라고\s*(?:했|말|쓰)|라는\s*(?:말|표현|문장)|문장을?\s*(?:설명|분석)|(?:무슨|어떤)\s*뜻|의미가?\s*뭐|과거형))(?![\s\S]*(?:방법|하는\s*법)[\s\S]*(?:알려|설명)\s*(?:해)?\s*줘)(?!\s*(?:왜|무엇|뭐|어떻게|방법|설명해줘|예시))(?=[\s\S]*(?:개발|구현|테스트|pr|작업|f1|핵심정리))(?=[\s\S]*(?:결과|보고|정리|성과))[\s\S]*(?:(?:보고|정리|요약)\s*(?:해\s*줘|해\s*주세요|해\s*줄래|해\s*봐|해\s*보자|부탁(?:해|드립니다|합니다)?|하자|해줘요|해주실래)|(?:보여\s*줘|설명\s*해\s*줘|알려\s*줘))\s*[.!?]*$
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
2. 서비스명, 기능명, 현재 사용자 기능
3. 이번에 실제 바뀐 코드·문서·PR과 새 Commit/HEAD
4. 검증 결과와 확인한 근거
5. 아직 되지 않거나 확인하지 않은 것
6. 다음 행동과 필요한 Owner 결정

## 서비스별 필수 필드

F1 보고서는 한 서비스를 설명한다. 여러 서비스의 변경을 보고할 때는 서비스별 보고서를 각각 작성한다.

서비스 기능 절에는 서비스명, 기능명, 현재 사용자 기능을 각각 명시한다. 현재 사용자 기능은 사용자가 실제로 할 수 있는 일을 문장으로 설명한다. Jira/PR 식별자, URL, SHA 목록만으로 설명을 대신하지 않는다.

필수 필드는 각각 독립된 Markdown 줄에 한 번만 쓴다. 값 문장에 다른 필드명과 콜론이 등장해도 별도 필드로 세지 않는다. 공백, `-`, `*`, 내용 없는 체크박스만으로 필수값을 채우지 않는다.

이번 변경 절에는 실제 변경을 둔다. 검증 절에는 구현 상태, 검증 상태, 문서 상태, 배포 상태를 각각 기록한 뒤 기존 다섯 Gate 상태를 따로 기록한다. 이 네 상태 값은 짧은 근거가 포함된 일반 문구로 쓴다. 기존 Gate 상태 어휘를 다른 상태에 확대하지 않는다.

아직 안 되는 것 절에는 미지원 기능과 미지원 이유를 각각 쓴다. 제한이 없으면 미지원 기능: 없음, 미지원 이유: 해당 없음처럼 명시한다.

다음 행동 절에는 다음 목표, 첫 행동, 담당 Lane, 필요 조건을 각각 둔다. 빈 값은 허용하지 않는다. 이 필드는 실행 책임과 필요한 선행조건을 읽기 쉽게 드러내기 위한 계약이며 실제 작업을 승인하지 않는다.

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
OH_MY_AI_ENTRY="$(command -v oh-my-ai || true)"
if [ -n "${OH_MY_AI_HOME:-}" ]; then
  OH_MY_AI_ROOT="$OH_MY_AI_HOME"
elif [ -n "$OH_MY_AI_ENTRY" ]; then
  OH_MY_AI_ROOT="$(node -e 'const fs=require("node:fs"); const path=require("node:path"); process.stdout.write(path.resolve(path.dirname(fs.realpathSync(process.argv[1])), ".."))' "$OH_MY_AI_ENTRY" 2>/dev/null || true)"
else
  OH_MY_AI_ROOT=""
fi

if [ -n "$OH_MY_AI_ROOT" ] && command -v node >/dev/null 2>&1 && [ -f "$OH_MY_AI_ROOT/scripts/f1-report-advisory.mjs" ]; then
  node "$OH_MY_AI_ROOT/scripts/f1-report-advisory.mjs" "$REPORT"
else
  echo "advisory validation NOT_RUN: checker source root or Node runtime unavailable" >&2
fi
```

`oh-my-ai`는 설치된 공개 진입점이며, 이 명령은 실행 중인 서비스 저장소의 현재 디렉터리와 무관하게 그 진입점의 실제 Source root에서 검사기를 실행한다. `$REPORT`는 현재 서비스 저장소의 보고서 경로로 지정한다. Source root를 확인할 수 없거나 Node 실행을 사용할 수 없으면 검사 상태를 `NOT_RUN`으로 기록하고, 확인된 사실로 F1 보고를 계속 작성한다. 이 제한은 F1 보고나 정책 상태를 `PASS`로 만들지 않는다.

검사기는 구조만 확인한다. URL·SHA·테스트·검수 독립성·Owner 승인의 진실성은 검증하지 않는다.
