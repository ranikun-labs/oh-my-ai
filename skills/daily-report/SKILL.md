---
name: daily-report
description: Optional workflow skill for Slack-style daily or weekly reports. Use for project-based progress summaries of today or an explicitly supplied date range, optionally using Notion worklogs/Todo pages as input.
metadata:
  source: born-here
  summary: Optional Slack/Notion 일일보고 workflow
  routing:
    visibility: contextual
    risk_level: low
    task_types:
      - reporting
    triggers:
      - kind: keyword
        values:
          - 일일보고
          - 주간보고
          - 데일리 리포트
          - daily report
          - weekly report
      - kind: intent
        values:
          - summarize_work_for_slack
          - summarize_weekly_work
    keywords:
      ko:
        - 일일보고
        - 주간보고
        - 보고
        - 진척률
      en:
        - daily report
        - weekly report
        - slack report
        - progress
    use_when:
      - 회사 Slack 일일보고 또는 주간보고 형식으로 작업을 프로젝트별 진척률과 함께 정리해야 하는 경우
    do_not_use_when:
      - Notion 업무일지나 Done/Todo 형식으로 스캔 가능한 개인 기록을 작성하는 경우
    requires:
      - today_session_context
---

# 슬랙 일일/주간보고 작성

오늘 또는 명시된 기간에 한 일을 **회사 슬랙 보고**로 정리한다. 목적기반 한 줄, 프로젝트별 묶음, 진척률 표기.

> 노션 개인 업무일지/Todo 정리는 다른 산출물 — `worklog-note` 참조. 이건 **슬랙 보고**용(평문, 표 X).

## 입력 (하이브리드)
세션마다 다루는 태스크가 달라서 둘을 합친다:
1. **이 세션 대화에서 한 일** (직접 취합)
2. **+ 노션 업무일지/Todo 페이지** — `notion-fetch`로 해당 기간의 Done/진행 항목을 가져와 보완. 페이지 URL은 사용자에게 확인.

주간보고는 사용자가 제공한 시작일과 종료일을 **양 끝 포함** 범위로 사용한다. 어느 한쪽이라도 없으면 날짜를 요청하고 임의의 주간 범위를 정하지 않는다. 기간 밖 기록은 제외하고, 날짜를 확인할 수 없는 기록은 포함 여부를 확인한다.

## 출력 포맷 (슬랙 — 평문 라인, 표 금지)
```
[YYYY-MM-DD]
<프로젝트명>
<작업명> (<진척%>, ~<데드라인>)
<작업명> (<진척%>)

기타
<항목> (<진척%>)
```
- 주간보고는 개별 날짜 헤더 대신 최상단에 `[YYYY-MM-DD ~ YYYY-MM-DD]` 기간 헤더를 쓴다. 두 날짜 모두 포함한다.
- 진척률 `(100%)` `(40%, ~7/23)` 형태. 데드라인 있으면 `~날짜`.
- 슬랙 강조는 `*텍스트*` (단일 별표). `**` 안 됨.

## 작성 원칙
- **목적기반 한 줄**: "무엇을 만들었나"가 아니라 **"어떤 목적/문제를 해결했나"**. 예: "복합 PK DDL 작성" ❌ → "audit 시계열 이관 검증 (복합 PK·hypertable)" ✅.
- **프로젝트별로 묶기**, 단순 나열 금지. 주간보고에서 날짜별 한 줄 기록을 합칠 때도 작업별 한 줄을 유지한다.
- **주간 중복 작업**: 같은 작업의 가장 최신 날짜 기록에서 진척률과 데드라인을 사용한다. 최신값이 이전보다 낮아도 높은 값으로 바꾸지 않는다. 최신 날짜에 서로 충돌하는 값이 있으면 임의로 고르지 말고 충돌을 표시하고 사용자에게 확인한다. 최신 기록에 값이 없으면 이전 값을 최신값으로 단정하지 않는다.
- **진척% 필수** (회사 포맷 일관성). 모르면 체감으로 추정 표기.
- **개인 작업(하네스·도구 등)** 은 회사 보고에 안 맞으면 `기타`로 빼거나 생략.
- **일일보고는 오늘 것만**, 주간보고는 명시된 기간의 기록만 포함한다.
- **일일보고 중복 주의**: 어제 일일보고에 100%로 올린 항목을 또 올리지 않기.

## 출력 전 self-check
- 각 줄이 "왜/무엇을 위해"가 먼저 읽히나?
- 모든 작업 줄에 진척% 있나?
- 일일보고는 오늘 것만인가? 주간보고는 명시된 양 끝 포함 기간만 사용하고 기간 헤더를 표시했나?
- 중복 작업의 최신 날짜 값과 같은 날짜의 충돌을 확인했나?
- 슬랙에 깨지는 마크다운(표·`**`) 없나?
