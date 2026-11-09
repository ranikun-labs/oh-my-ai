---
name: project-context
description: Use when starting a new session on a codebase, resuming interrupted work, after making an architectural or design decision, or before ending a session or creating a PR — to create, update, or checkpoint human-confirmed durable docs/context/ project context files.
metadata:
  source: born-here
  summary: 세션 간 설계 배경과 작업 상태를 이어주는 컨텍스트 관리
  routing:
    visibility: contextual
    risk_level: low
    task_types:
      - project-context
      - design-record
      - context-checkpoint
    triggers:
      - kind: keyword
        values:
          - docs/context
          - project-context
          - 하네스 context
          - 하네스 컨텍스트
          - context 기능
          - 컨텍스트 기능
          - 설계 저장
          - 설계를 파일에 저장
          - 결정 로그
      - kind: intent
        values:
          - preserve_design_context
          - update_project_context
    keywords:
      ko:
        - 컨텍스트
        - 설계 저장
        - 결정 로그
      en:
        - docs/context
        - project context
        - design record
    use_when:
      - 설계·결정 맥락을 docs/context에 장기 보존해야 하는 경우
      - 사용자가 하네스 context 기능이나 컨텍스트 파일 저장을 직접 언급한 경우
    do_not_use_when:
      - 단기 세션 전환용 붙여넣기 프롬프트만 필요한 경우
      - 일반 설계 상담만 요청했고 파일 저장·문서화 의도가 없는 경우
    requires:
      - human_confirmed_design_context
---

# Project Context — 생성·업데이트·체크포인트

## Overview

세션 간 컨텍스트 단절 문제를 해결하는 Human-confirmed Durable Context 관리 스킬.
`docs/context/<도메인>/<서비스>.md`를 생성·업데이트·체크포인트해서 장기 설계 배경과 결정 맥락을 보존한다.

**핵심 원칙: Context는 대화 Raw Log나 작업 전달 Artifact가 아니다.** 사용자 확인을 거친 결정 로그·설계 배경·파일 맵만 Durable Context로 저장한다.

- `CONTEXT CHECKPOINT`는 Structured Handoff Candidate가 아니다.
- Worker에게 현재 Task 실행을 위임할 때는 `handoff-prompt`를 사용한다.
- Context는 사용자 확인을 거쳐 Durable Context로 저장한다.

---

## 모드 선택

```
docs/context/ 파일 있음? ─── YES ──→ [UPDATE] 또는 [CONTEXT CHECKPOINT]
        │                                    │
        NO                          세션 끝/PR 전? ─── YES ──→ [CONTEXT CHECKPOINT]
        │                                    │
        ↓                                   NO
    [CREATE]                            [UPDATE] (결정 로그만)
```

---

## 파일 경로 규칙

```
docs/context/<도메인>/<서비스>.md
```

**도메인 결정 순서:**
1. 현재 git 브랜치 → 이슈 트래커 항목 → 상위 작업 (`<ISSUE-123>` → parent `<EPIC-456>` → `<domain-name>`)
2. 작업 디렉토리명 (`audit/`, `url-scanner/` 등)
3. 모호하면 사용자에게 확인

**예시:**
- `docs/context/db-migration/audit.md`
- `docs/context/url-scanner/request-collapsing.md`
- `docs/context/console/audit-targetid.md`

---

## [CREATE] 신규 생성

컨텍스트 파일이 없을 때.

1. 도메인·서비스명 결정 (위 경로 규칙 따라)
2. 아래 템플릿으로 생성
3. 현재 브랜치·이슈 트래커·알려진 상태로 채움
4. 사용자 확인 후 파일 작성

### 템플릿

```markdown
---
module: <서비스명>
last_updated: <YYYY-MM-DD>
issue_parent: <EPIC-456> (<상위 작업 제목>)
branch: <현재 브랜치>
---

## 현재 상태

| 작업 | 이슈 | 상태 | 비고 |
|------|------|------|------|
| ...  | ...  | ⏳   |      |

## 핵심 결정 로그

| 날짜 | 결정 | 이유 |
|------|------|------|

## 파일 맵

```
<서비스>/
├── ...  # 주요 파일과 역할
```

## 남은 태스크

| # | 작업 | 파일 |
|---|------|------|

## CONTEXT CHECKPOINT

- 마지막 확인 시점: <YYYY-MM-DD>
- 확인된 현재 상태: <완료·진행·미착수 상태>
- 확인된 주요 결정: <결정과 이유>
- 확인된 Risk·Blocker: <장기 보존할 위험 또는 없음>
- Promotion Source: <사용자가 검토한 Result/PR/결정 출처>
```

---

## [UPDATE] 결정 로그 추가

세션 중 아키텍처·설계 결정을 내렸을 때.

1. 기존 파일 Read
2. `핵심 결정 로그` 테이블에 행 추가:
   - 날짜: 오늘
   - 결정: 결정 내용 (무엇을 선택했나)
   - 이유: 선택하지 않은 대안 포함한 근거
3. `현재 상태` 표 상태 변경 있으면 업데이트
4. Risk·Blocker 또는 구현·검증 상태 변경이 있으면 관련 섹션 갱신
5. 사용자 확인 후 반영하고 `last_updated` 갱신

---

## [CONTEXT CHECKPOINT] 세션 종료·PR 전

현재까지 확인된 Durable Context가 실제 작업 상태보다 오래되지 않도록 체크포인트를 갱신한다.

1. 기존 파일 Read
2. `현재 상태` 표 갱신 (이번 세션에서 완료된 것 ✅, 새로 시작된 것 🔄)
3. `남은 태스크` 갱신
4. `CONTEXT CHECKPOINT` 갱신:
   - 사용자가 확인한 현재 상태와 주요 결정
   - 장기 보존해야 하는 Risk·Blocker
   - Promotion Source
5. `last_updated` 갱신
6. 사용자 확인 후 Durable Context로 저장
7. Durable Context 저장이 성공한 뒤에만 Guard 상태를 해결:

```bash
oh-my-ai context-checkpoint resolve checkpointed \
  --promotion-source context-checkpoint-<YYYYMMDD>-<short-slug>
```

`promotion-source`는 절대 경로, URL, Secret·Token·Credential이 아닌 opaque local identifier
또는 sanitized local reference만 사용한다. 명령이 실패하면 `checkpointed`로 보고하지 않고
Guard 상태를 unresolved로 유지한다.

`CONTEXT CHECKPOINT`는 장기 맥락 갱신이며 Worker 실행 지시문이 아니다. 현재 Task를 다음 Worker Session에 전달해야 하면 최신 Context를 준비한 뒤 `handoff-prompt`로 Structured Handoff Candidate를 별도 생성한다.

---

## Context 갱신 사건

모든 대화를 저장하지 않는다. 다음 사건에서 기존 CREATE 또는 UPDATE 흐름을 사용한다.

- 작업 시작
- Scope 또는 주요 Decision 변경
- Risk·Blocker 발견
- 구현 또는 검증 완료
- PR·Merge 전
- Session 종료 또는 Handoff 전

---

## Result Promotion 경계

Worker Result는 Durable Context가 아니라 Evidence Candidate다. 다음 순서를 지킨다.

```text
Result
→ Context Update Candidate
→ Human Review
→ Promotion
```

- Promotion 승인 주체는 사용자다.
- Promotion Source를 Context에 기록한다.
- 기존 Durable Context와 충돌하면 자동으로 덮어쓰지 않고 사용자에게 충돌을 제시한다.
- Reject된 Result는 Promotion하지 않는다.
- 승인 전 Candidate를 Confirmed Fact나 Durable Context로 표현하지 않는다.

## 연결 작업 보기

여러 작업 도구의 현황을 한눈에 볼 필요가 있으면 Jira, PR, CI, 독립 리뷰, merge, runtime, handoff와 evidence의 기존 출처를 연결한 짧은 사람용 보기를 만들 수 있다. 이 보기는 원본 기록을 대체하지 않는 읽기 전용 요약이며, 새 레코드를 만들거나 갱신하지 않는다.

- 보기를 모은 실제 시각(`observed_at`)과 각 원본의 `updated_at`은 따로 적는다. 원본 갱신 시각을 관찰 시각으로 대신 쓰지 않는다. 관찰 시각을 확인할 수 없으면 `UNKNOWN`으로 남긴다.
- Jira의 업무 상태와 Source/PR, 검증, merge, runtime, handoff 상태를 서로 다른 사실로 표시한다. 한 상태에서 다른 상태를 추론하지 않는다.
- 각 사실에 원본 링크 또는 식별자, 관찰 시각, 그리고 적용되는 경우 원본 `updated_at`을 붙인다. `UNKNOWN`이나 `NOT_RUN`은 그대로 표시하고 성공으로 간주하지 않는다.
- 그 보기의 정보를 바탕으로 행동하기 전에는 해당 출처를 다시 열어 결정에 필요한 사실을 새로 확인한다. 갱신되지 않은 관찰은 오래된 정보로 표시한다.
- 보기의 생성·갱신은 Context의 자동 쓰기나 승격 권한을 주지 않는다. Durable Context에 저장하거나 기존 기록을 바꾸려면 각각의 기존 사용자 확인 및 승인 경계를 따른다.

---

## 발동 시점 요약

| 상황 | 모드 |
|------|------|
| 세션 시작 + `[HARNESS:context]` 목록 보임 | 목록에서 관련 파일 Read |
| 세션 시작 + context 파일 없음 | CREATE (사용자 확인 후 저장) |
| 중요 결정 내린 직후 | UPDATE (결정 로그) |
| Scope·Risk·구현·검증 상태 변경 | UPDATE |
| 세션 종료 / PR 생성 전 | CONTEXT CHECKPOINT |
| 새 기능·서비스 착수 | CREATE |

---

## 흔한 실수

| 실수 | 올바른 방법 |
|------|-------------|
| 대화 Raw Log를 그대로 저장 | 사용자 확인을 거친 장기 맥락만 선별 |
| Context에 Worker 실행 지시문 작성 | `handoff-prompt`로 Structured Handoff Candidate 생성 |
| Result를 자동 반영 | Candidate → Human Review → Promotion 순서 준수 |
| 세션 끝에 체크포인트 누락 | PR 커밋 전에 Context 최신성 확인 |
| 도메인 구분 없이 flat하게 | `docs/context/<도메인>/` 하위로 분류 |
