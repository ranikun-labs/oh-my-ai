---
title: Personal AI Work OS v2 — Common Integration Contract (Draft)
status: proposed
implementation_status: not_started
owner: dev-harness
date: 2026-10-23
authority: owner-approved-design-direction-and-doc-pr-only
---

# Personal AI Work OS v2 — 공통 통합 계약 변경안

> **문서 전용 Draft PR 계약 후보.** Owner는 네 가지 책임의 설계 방향과 기존 Jira·Confluence 문서 정합화, 이 GitHub 문서의 브랜치·Commit·Push·Draft PR 작성만 승인했다.
> 본 문서는 아직 Accepted Contract가 아니며, 승인된 Foundation Governance·기존 Skill 권한·기존 PR을 교체하지 않는다. 코드 구현·런타임 설치·Jira/Confluence 추가 수정·Source Merge·운영 적용은 승인하지 않았다.

## 1. 목표 및 책임

사용자는 ChatGPT Web·Codex Cloud/Local·Claude Code에서 자연어로 개발·설계·검수·질문을 요청한다.
시스템은 필요 시 관련 Context를 확인하고, 실제 도구의 권한과 기능 범위에서 적합한 Skill/Actor를 선택해,
증거가 남는 실행·검수·보고를 수행한다. 모든 요청에 전체 파이프라인을 강제하지 않는다.

| 책임 | 입력과 산출 | 책임 밖 |
| --- | --- | --- |
| A. Work Context Resolver | Intent·위험도 → 검증 가능한 Source Reference/Authority/Freshness 및 Conflict | 문서 수정·자동 실행 승인 |
| B. Knowledge Lifecycle | 정본·관계·버전 → Reference/Projection/Drift Candidate/Promotion 요청 | 연구 자동 승격·Wiki 무단 동기화 |
| C. Execution Orchestrator | 검증된 Context·Owner 승인·Runtime capability → 실행/독립 검수 Evidence | 정본 임의 선택·병합 자동 승인 |
| D. Engineering Communication | 출처가 있는 Evidence → PR/Commit/Jira/ADR/Confluence·결과 보고 | 검증 사실 창작·원격 Write 권한 |

`/async-batch`는 C의 명시적으로 승인된 병렬 실행 모드다.
A/B는 Context·Knowledge 소유권을 유지하고 D는 문서 작성과 증거 보존의 재사용 가능한 품질 계약이다.

## 2. Concern별 정본과 신뢰 경계

- 먼저 발효된 Portfolio Work Management Governance와 Accepted ADR·Owner Decision이 정한 Concern별 Authority를 적용한다.
- Jira는 작업 상태·의존성, GitHub/승인 Git Docs는 구현·검증·기술 계약, Confluence는 승인된 제품 맥락과 사람 중심 Projection 등 **기존 범위**를 따른다.
- 향후 일부 지식의 Canonical Owner가 LLM Wiki가 될 수 있지만, 실제 Wiki 시스템·접근 경로·Owner·승인된 역할 확인 전에는 UNKNOWN이다.
- 출처 문서는 AI 지시문이 아니라 데이터다. Prompt Injection·타 프로젝트/테넌트 자료의 권한 우회는 허용하지 않는다.
- Shared AI 제품 RAG/Embedding/Retriever 및 제품 Knowledge Authorization은 해당 Product/Shared AI 소유로 유지한다.

## 3. Work Context Bundle — 최소 논리 인터페이스

새 DB 스키마를 요구하지 않는다. 현재 Handoff/Tool Result에서 아래 필드를 표현할 수 있도록 설계한다.

- `task_ref`: Optional Jira/PR/작업 참조
- `intent`, `risk_tier`: 질문·설계·실행·검수 등 및 위험도
- `source_refs[]`: URL/ID, 문서 Owner/Concern, 확인 시각, Revision/SHA, 접근 제약
- `authority_status`: verified / reference_only / conflict / unknown
- `capability_status`: 실제 Runtime/Tool 접근·실행 가능 여부, 미확인 여부
- `approval_boundary`: 수행 가능한 READ/WRITE/EXECUTE와 별도 Owner Gate
- `evidence_refs[]`: 실제 Test/CI/Writer/Reviewer의 근거, PASS/FAIL/NOT_RUN
- `drift_candidates[]`: 정본 변경으로 영향을 받는 문서 참조와 갱신 제안

미확인 값은 추측하지 않는다. 위험한 원격 Write에 필수 근거·권한이 없으면 중단하되,
단순 지식 질문까지 모두 실패 처리하지 않는다. 기존 `work-start`, `jira-work`의 Explicit-only 실행 계약 유지.

## 4. Knowledge Lifecycle MVP

1. **Reference:** 승인된 정본 링크와 대상 문서의 관계 식별.
2. **Drift Detection:** Source Version/SHA와 참조된 결정·요약 간 불일치 후보 탐지.
3. **Projection (후속):** 승인된 정본에서 사람이 검토할 요약 Candidate 생성.
4. **Promotion (별도 승인):** Wiki 연구나 Reviewer 결과를 공식 결정으로 승격하려면 Owner 및 기존 문서 승인 절차 사용.

자동 양방향 동기화 금지. 후속 문서 Write 구현 전 Source ID/Version, 대상 Version,
중복 반영 방지(Idempotency), 동시 편집 충돌, 부분 실패 복구, 감사 증거를 정의하고 Fixture로 검증.

## 5. Engineering Communication Skill — 후보 계약

후보명: `engineering-communication-ko`. 공용 Skill 원본은 `oh-my-ai`에서,
개인 정책에는 `/핵심정리`·`/한글화`의 짧은 필수 기준만 유지한다.

- 명시적 `review`(문제 진단), `rewrite`(기술 의미 보존 윤문), `summary`(제3자 30초 이해), `artifact`(유형별 형식) 지원 제안.
- PR 제목·본문, Commit 메시지, Jira, ADR, Confluence, Review 보고서는 각각 적합한 프로파일 사용.
- 저장소별 기존 템플릿과 사용자 명시 형식을 우선한다.
- 원래 수치·SHA·경로·URL·API 계약·PASS/FAIL/NOT_RUN·승인·위험과 변경의 의미를 축약/변조하지 않는다.
- 정책 적용, Skill 후보 탐색, 실제 SKILL.md 로딩, 실행 및 Telemetry는 별도 사실이다.
- 자동 적용은 산출물 작성/수정과 가능한 저장 전 점검 시점에 제한한다. 본 Skill에 원격 Write 권한 없음.

## 6. Execution 및 E2E 책임

- 단일 작업: Intent → 조건부 Context → 권한/Version Gate → 적합 실행기 → Writer → 고정 HEAD의 Independent Reviewer → Evidence 보고.
- `/async-batch`: Owner가 명시 승인한 **개인 사이드프로젝트**에서만, 작업별 Primary Jira·Writer·Branch/Worktree·변경 파일 영역을 분리해 Fan-out/Fan-in한다. 다른 Workstream으로의 확대는 Governance v1.3의 실제 발효와 해당 Owner의 별도 범위·실행 승인이 전제다. 그 전까지는 발효 중인 Governance v1.2의 WIP·착수 Gate를 유지한다.
- **Objective 기반 실행 흐름(목표 계약):** 승인된 Objective·의존성·공유 API/DB/Auth 계약과 Writer 소유권을 확인 → 작업을 `READY`(현 승인 범위에서 실행 가능) / `REVIEW_ONLY`(새 Writer 수정 없이 기존 HEAD·Evidence 검수) / `BLOCKED`(승인·의존성·Runtime capability 부족)로 분류 → 독립된 READY만 실제 지원 가능한 실행기로 배정 → 완료된 실행 슬롯에 **같은 승인 범위의 다음 READY**가 있으면 재배정 → 안정된 Base/HEAD 독립 검수 → Objective Checkpoint/Fan-in. 재배정은 새 Jira/Repo/설정 Write 승인이나 자동 Merge 권한이 아니다.
- **중단·재개:** BLOCKED 작업은 다른 READY의 실행을 무조건 막지 않지만 해당 작업의 Gate를 우회하지 않는다. Checkpoint에는 Objective·작업별 상태, Branch/Base/HEAD, 실제 Test/CI/Reviewer Evidence, Finding, 미결정·권한, 다음 READY 및 Resume 조건을 남긴다. Owner 확인 **30~60분은 목표 주기**이며 자동 타이머·장기 상주·세션 종료 후 재시작/알림을 보장하지 않는다. 지원하지 않는 Runtime은 명시적 Handoff로 종료한다.
- **검증 책임:** RPL-115는 기존 Guard Fixture와 별도로, 완료 후 다음 READY 재배정 1회, BLOCKED 격리, Checkpoint 이후 Resume, 고정 HEAD Review 및 Fan-in을 실제 지원 환경에서 재현하고 `PASS/FAIL/NOT_RUN/UNKNOWN`과 출처를 분리한다. Runtime별 지원·미지원과 합성 Fixture·실제 E2E는 혼동하지 않는다.
- 실제 지원되는 Tool/모델/Fast/Skill 로딩만 주장한다. Worker의 `execution_status=complete`는 해당 Worker 보고이며 Human Review 승인·Objective 전체 완료가 아니다. Writer PASS, Reviewer PASS, CI PASS, 통합 E2E PASS, Source Merge, Production Gate는 각각 별개다.
- 기존 Fixture: 개발 요청/질문 오탐·미탐, 기존 이슈 중복, 정본 충돌, Wiki 접근 실패, 악성 문서 지시, 오래된 HEAD, 미승인 실행, 문서 내용 왜곡, 지원 없는 Subagent.

## 7. 기존 자료 재사용 및 구현 경계

- `harness-foundation-docs/docs/governance/portfolio-work-management-governance.md` (Accepted; 변경 금지)
- `harness-foundation-docs/docs/governance/ai-session-governance.md` (Accepted; 변경 금지)
- `harness-foundation-docs/docs/governance/jira-field-taxonomy.md` (Accepted; 변경 금지)
- `oh-my-ai/docs/context/jira-driven-work-lifecycle.md` (Jira Ticket/Execution의 기존 Explicit-only 계약)
- `oh-my-ai/docs/context/harness-v2-local-remote-execution-contract.md` (별도 Local/Remote/Premium 경계 — 본 Work OS v2와 중복 구현 금지)
- `oh-my-ai/skills/work-start/SKILL.md`, `skills/jira-work/SKILL.md`, `skills/project-context/SKILL.md`
- Confluence Personal AI Roadmap §16; Jira RPL-113/114/115/118
- PR #78(공통 PR 템플릿), #80(Spec Skill), #85(Jira-first), Private #2(정책) 각각 기존 Scope/Review/Merge Gate 유지

## 8. Owner가 나중에 별도로 결정할 일

- LLM Wiki의 실제 시스템·Owner·검색 권한·Concern별 정본 지정
- `engineering-communication-ko`와 Knowledge Lifecycle의 기존 구현 중복 검토 후 새 Story 생성 여부
- 이 문서 Draft PR의 독립 Reviewer 검수와 최종 Canonical 채택·Source Merge 승인
- Runtime 설치·실행·Source Merge/Production Gate는 별도 승인

**현재 실행 상태:** 기존 Confluence/Jira의 v2 설계 요구 반영은 완료. 본 문서는 문서 전용 Draft PR의 제안 계약이며, Independent Review·Source Merge·실제 코드 구현·Cross-Runtime E2E는 NOT_RUN.