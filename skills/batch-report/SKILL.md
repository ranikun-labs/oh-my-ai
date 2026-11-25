---
name: batch-report
description: Use when a long-running session delegates several parallel workstreams to sub-agents and results arrive one by one (or tasks are added mid-flight). Collects results per request batch (B-MMDD-N) and emits one consolidated F1 report when the batch closes, instead of a separate report per agent. Also triggers on "묶음", "배치 보고", "종합", "B-xxxx 보여줘".
metadata:
  source: born-here
  summary: 병렬 에이전트 결과를 요청 묶음 단위로 모아 F1 종합 1개로 보고해 흩어진 보고를 일일이 복사하던 수고를 없앰
---

# Batch Report — 요청 묶음 단위 보고

목적: 에이전트가 끝날 때마다 보고가 따로 나와 알아보기 어렵고 여러 번 복사해야 하는 문제를 없앤다.
진행 신호는 실시간으로 짧게(Claude식), 결론은 묶음이 끝날 때 한 번에(Codex 턴 종료식) 준다.
세션이 며칠 이어져도 묶음 ID로 추적한다.

## 1. 묶음 열기
- 작업 지시가 들어오고 열린 묶음이 없으면 새 묶음을 연다. ID `B-MMDD-N`(그날 N번째).
- 기록 파일: `~/.local/state/batches/B-MMDD-N.md`
  ```
  # B-1125-1 (열림 10:00 KST)
  | # | 작업 | 담당 | 상태 | 결과 요약 |
  ```
- 대화: `[B-1125-1] 열림 — 작업 목록` 한 줄.

## 2. 진행 중 추가
- 열린 묶음이 있으면 새 작업은 기본으로 합류: `[B-1125-1] +1 합류 — 작업명`.
- 사용자가 "따로"·"새 묶음"이라 하거나 주제가 완전히 다르면 새 묶음.

## 3. 결과 도착
- 상세는 묶음 파일에 쌓는다(작업 행 상태 갱신 + 상세 절). 실패·NOT_RUN·UNKNOWN·Drift를 지우지 않는다.
- 하위 에이전트 보고 중 사실과 다른 점은 파일에 정정 표시한다. 에이전트 보고를 그대로 옮기지 않는다.
- 대화에는 `[B-1125-1] 3/5 완료 (작업명)` 한 줄만.
- 즉시 보고 예외: Owner 결정 없이는 다른 작업이 막힘, 실패·사고, 승인 범위 이탈. 이 경우도 한 메시지로 모은다.

## 4. 묶음 닫기
- 모든 작업 종료 또는 사용자가 "종합" 요청 시 F1 종합을 응답 1개로 낸다.
  CI처럼 오래 걸리는 대기는 "대기 중"으로 표시하고 다음 묶음으로 이월할 수 있다.
- 형식: 업무별 `#` → 달라진 점 → 실제 검증(NOT_RUN/UNKNOWN 구분) → 남은 문제 → 맨 끝 `# Owner 결정` 번호 목록 하나.
- 같은 내용을 묶음 파일 끝에 붙이고 상태를 `닫힘 HH:MM`으로 바꾼다.

## 5. 조회·재개
- "B-1125-1 보여줘" → 파일의 F1 종합 절 출력.
- 세션 재개·Context 축약 후에는 `~/.local/state/batches/`에서 열린 묶음을 먼저 확인한다.
- 복사: WSL `cat <파일> | clip.exe`, macOS `pbcopy < <파일>`.
