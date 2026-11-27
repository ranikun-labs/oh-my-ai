---
name: execution-recovery
description: Use when a tool, command, sandbox, permission, network, dependency, or approval operation fails or repeats the same infrastructure error — classify the failure, cap retries, choose one bounded fallback, and stop before recovery consumes excessive tokens or time.
metadata:
  source: born-here
  summary: 도구·권한·샌드박스 장애의 재시도 폭주를 차단하고 안전하게 대피
---

# 실행 장애 복구

복구 비용이 원래 작업보다 커지는 것을 막는다.

## 실패 지문

도구·작업·종료 코드·핵심 오류 한 줄을 묶는다. 인자만 바뀌고 핵심 오류가 같으면 동일 실패다.

## 재시도 예산

| 실패 유형 | 동일 방식 재시도 |
|------|------|
| 입력·anchor·문법 오류 | 원인 수정 후 1회 |
| 일시적 timeout·경합 | 1회 |
| 권한·sandbox·정책 거부 | 0회 |
| command not found·의존성 부재 | 0회 |
| 원인 불명 | 진단 1회 후 중단 |

두 번째 동일 실패가 나오면 circuit을 열고 그 도구를 더 호출하지 않는다. 재개 시 실패 지문과 차단 근거를 확인한다. 원인·환경·권한이 그대로면 동일 진단이나 승인 요청을 반복하지 않고, 새 근거가 생긴 경우에만 영향받는 작업을 다시 평가한다.

## 대피 경로

1. scoped escalation을 정확히 한 번 요청한다.
2. 불가능하면 설치된 친숙한 런타임으로 작은 대체 작업을 한 번 수행한다.
3. 대체 명령이 원래 변경보다 커지면 중단하고 blocker를 보고한다.

승인 요청과 대피 경로는 같은 목적에 각각 한 번만 허용한다.

### Codex bwrap slave 권한 오류

`bwrap: Failed to make / slave: Permission denied`는 sandbox infra failure로 분류한다.

- 파일 read/write 중 이 오류가 발생하면 같은 도구·같은 방식으로 재시도하지 않는다.
- 읽기는 우선 `rg -n`으로 필요한 범위를 확인한다.
- 라인 번호가 꼭 필요하면 scoped escalation으로 `nl -ba <file>`을 한 번만 요청한다.
- 쓰기는 `apply_patch`가 같은 오류로 실패하면 scoped escalation으로 좁은 단일 치환 명령을 사용한다.
- 승인 요청은 목적과 대상 파일을 좁게 적고, broad prefix rule을 요청하지 않는다.
- 복구 과정이 원래 작업보다 커지면 중단하고 blocker를 보고한다.

## 토큰 circuit breaker

- 큰 payload를 Base64로 감싸지 않는다.
- 긴 일회성 prefix rule을 저장하지 않는다.
- 실패한 전체 patch를 다시 전송하지 않는다.
- 핵심 오류·시도 횟수·다음 선택만 기록한다.
- 복구가 비대해지면 완성보다 중단을 선택한다.

## 종료

복구 완료, 사용자 승인 필요, 환경 복구 필요, 작업 설계 오류 중 하나로 끝낸다. 영향이 크면 incident에 원인·낭비·방지 규칙·검증을 기록한다.
