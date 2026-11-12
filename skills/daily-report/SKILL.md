---
name: daily-report
description: Optional workflow skill for Slack-style daily or weekly reports. Use only when the user works with Slack-style daily reports, weekly reports, or asks to merge several dated work logs into concise project-based lines with progress percentages; optionally use Notion worklogs/Todo pages as input.
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
          - weekly report
          - daily report
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
      - 회사 Slack 일일보고나 주간보고 형식으로 작업을 프로젝트별 진척률과 함께 정리해야 하는 경우
      - 날짜별 업무 로그 여러 개를 하나의 주간보고로 합치되, 입력처럼 한 줄 위주로 유지해야 하는 경우
    do_not_use_when:
      - Notion 업무일지나 Done/Todo 형식으로 스캔 가능한 개인 기록을 작성하는 경우
    requires:
      - today_session_context
---

# 슬랙 일일/주간보고 작성

오늘 또는 이번 주에 한 일을 **회사 슬랙 보고**로 정리한다. 목적기반 한 줄, 프로젝트별 묶음, 진척률 표기.

> 노션 개인 업무일지/Todo 정리는 다른 산출물 — `worklog-note` 참조. 이건 **슬랙 보고**용(평문, 표 X).

## 입력 (하이브리드)
세션마다 다루는 태스크가 달라서 둘을 합친다:
1. **이 세션 대화에서 한 일** (직접 취합)
2. **+ 노션 업무일지/Todo 페이지** — `notion-fetch`로 그날 Done/진행 항목 가져와 보완. 페이지 URL은 사용자에게 확인.

## 출력 포맷 (슬랙 — 평문 라인, 표 금지)
```
[YYYY-MM-DD]
<프로젝트명>
<작업명> (<진척%>, ~<데드라인>)
<작업명> (<진척%>)

기타
<항목> (<진척%>)
```
- 주간보고처럼 여러 날짜를 합칠 때는 날짜 헤더를 제거하고 프로젝트별 한 줄 목록으로 압축한다.
- 진척률 `(100%)` `(40%, ~7/23)` 형태. 데드라인 있으면 `~날짜`.
- 슬랙 강조는 `*텍스트*` (단일 별표). `**` 안 됨.

## 작성 원칙
- **목적기반 한 줄**: "무엇을 만들었나"가 아니라 **"어떤 목적/문제를 해결했나"**. 예: "복합 PK DDL 작성" ❌ → "audit 시계열 이관 검증 (복합 PK·hypertable)" ✅.
- **사용자 입력이 한 줄 위주면 출력도 한 줄 위주**: 주간보고로 합쳐도 문단 요약으로 바꾸지 말고 `<작업명> (<진척%>)` 라인을 유지한다.
- **프로젝트별로 묶기**, 단순 나열 금지.
- **중복 항목은 최신 진척률로 합치기**: 같은 작업이 여러 날짜에 반복되면 가장 최신/가장 높은 진척률과 데드라인을 남긴다.
- **진척% 필수** (회사 포맷 일관성). 모르면 체감으로 추정 표기.
- **개인 작업(하네스·도구 등)** 은 회사 보고에 안 맞으면 `기타`로 빼거나 생략.
- **일일보고는 오늘 것만**, **주간보고는 받은 기간만** — 범위 밖 항목을 섞지 말 것.
- **중복 주의**: 어제 보고에 100%로 올린 항목을 또 올리지 않기.

## 출력 전 self-check
- 각 줄이 "왜/무엇을 위해"가 먼저 읽히나?
- 모든 작업 줄에 진척% 있나?
- 일일보고면 오늘만, 주간보고면 받은 기간만 포함했나? (날짜 확인)
- 입력이 한 줄 중심인데 문단형으로 뭉개지 않았나?
- 슬랙에 깨지는 마크다운(표·`**`) 없나?
