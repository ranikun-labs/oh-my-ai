# G3 Task Pilot — corrected Core Description candidate (NOT APPROVED)

**Status:** PROPOSED / PREVIEW_REVIEW_ONLY / NOT_CREATED. This is a review artifact, not signed Approval, Policy, Activation, Metadata or Runtime proof. Jira Create/Admin/Cutover calls: **0**.

- Primary governance Jira: `RPL-122`; Pilot would be a **new** RPL Task(10010)
- Core Ticket Contract: 14 entries from `docs/jira-g3-task-readiness-runbook.md`; Base Branch corrected to actual PR #84 base
- Product: `dev-harness (10027)`; Component: `backend (10028)`; Concern: `[]`
- Proposed start: `2026-10-29`; proposed due: `2026-10-30`
- Logical Description-only Assignee `박성환`; Priority `Medium`; Area `Jira Migration` — **not Owner-approved**
- `Current HEAD` in the Description is deliberately pinned to last reviewed **code** HEAD `812ddfad6d03b0ca6e6143ace9c833608393970c`. PR docs HEAD may change. Approval must bind the exact full Preview/request digest.
- Do not transmit reporter, Jira assignee/priority/labels wrappers or `customfield_10045`. Jira Metadata people defaults must not appear here.
- Description below is assembled following the checked Core `createDescription` header and 14-field ordering. **It is not a fresh executable CLI/Core test result**: previous PREVIEW_ONLY had an incorrect Base Branch; a new runnable Preview and signed Gate are required before Create.

## Exact Description candidate for Owner review

```text
Product: dev-harness
Primary Repository: ranikun-labs/oh-my-ai
Area: Jira Migration
Assignee: 박성환
Priority: Medium
Branch: feat/jira-g3-integration-offline-20261022
PR: #84
Current HEAD: 812ddfad6d03b0ca6e6143ace9c833608393970c

## Summary
[G3 PILOT] Target 분류 단일 Task 검증
## Context
G2의 기존 118건 Target 값 저장은 검증됐으나 신규 Task 생성 및 Target 권위 활성화는 미검증 상태다.
## Goal
신규 Task 한 건의 Target 분류 저장, 재조회, Origin 등록 및 Reader 권위를 검증한다.
## Source of Truth
harness-foundation-docs/docs/governance/jira-field-taxonomy.md §8.0 및 oh-my-ai/docs/jira-g3-task-readiness-runbook.md.
## In Scope
승인된 단일 Task Pilot, 필수 필드 검사, Create 1회, 재조회, 영속 증거 기록, 실패 격리.
## Out of Scope
기존 118건 일괄 Cutover, Story/Subtask 이전, G4 레거시 삭제, 운영 자동 대량 생성.
## Acceptance Criteria
정확한 승인·필드·서명 증거와 pending 기록이 선행돼야 한다. Create 후 IssueKey, Target 값, Origin과 Reader 권위가 일치해야 한다.
## Repository
ranikun-labs/oh-my-ai
## Base Branch
fix/jira-g3-capability-evidence-fail-closed-20261022
## Expected Branch Name
feat/jira-g3-integration-offline-20261022
## Dependencies
PR #84 코드, Jira Task Metadata, 승인된 Owner·Activation 증거, 단일 Writer, 영속 Ledger와 복구 경로.
## Verification
Core Dry-run → 승인 검증 → 생성 전 pending → Create 최대 1회 → GET → Origin/Reader 대조 → 실패 시 격리 및 수동 복구.
## Do Not Touch
기존 이슈 Legacy 값, G2 Snapshot, 미지원 유형, Board/Filter/Automation 운영 설정, G4 필드 삭제.
## Definition of Done
승인된 단일 Pilot이 생성되고 필드·Origin·권위 검증 및 감사 증거가 완료되었거나, 실패 상태가 중복 생성 없이 안전하게 격리되어야 한다.
```

## Execution boundary

This document alone never authorizes Jira writes. Revalidate live Create Metadata and exact accepted Preview, Owner-approved scope/time, trusted identity and signed activation, durable pending-before-Create, single Writer, one attempt, GET/Origin/Reader parity and quarantine/restore. Jira Migration G3 §8.0 Fast Track can use a supervised versioned CSV/JSON ledger but cannot omit the authority lifecycle. G4 Legacy deletion remains separately gated.
