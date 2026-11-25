---
name: batch-report
description: Explicit-only consolidation of several parallel agent results into one evidence-preserving report that Main can verify and decide from. Invoke only when the user types /batch-report or $batch-report.
disable-model-invocation: true
metadata:
  source: born-here
  summary: 병렬 에이전트 결과를 Main이 검증하고 다음 판단을 내릴 수 있도록 근거를 보존해 묶고, 사용자에게 종합 1개로 전달
---

# /batch-report — 병렬 결과의 근거 보존 종합

명시 호출(`/batch-report`, `$batch-report`) 전용이다. 여러 에이전트 결과를 요약하는 도구가 아니다.
목적은 Main이 각 결과를 검증하고 다음 판단을 내릴 수 있는 입력을 만들고, 사용자에게 종합 결과 하나를 주는 것이다.

독립 Core Skill이다. 단독으로 쓰거나 다른 workflow가 참조해 쓴다. 이 Skill은 다른 workflow를 참조하지 않는다(역방향 의존 금지). 파일·상태를 저장하지 않는다.

## 1. 호출 모드
- `start`: 묶음 시작 시 보고 타이밍 정책을 적용한다. 진행 신호는 `[묶음] n/m 완료 (작업명)` 한 줄로 짧게 쓰고, 에이전트마다 긴 보고를 따로 내지 않는다.
  즉시 보고 항목은 이 Skill이 목록을 소유하지 않는다. 호출자 계약이 정하고, 묶음 종료까지 미루지 않는다.
  보안 문제와 Owner Gate도 호출자 계약 항목이며 단독 사용에서도 지연하지 않는다.
- `checkpoint` | `final`: 받은 결과를 집계한다. `final`은 묶음의 모든 입력을 포함한다. 두 모드 모두 §7의 ledger 블록을 남긴다.

## 2. 입력 envelope (결과 1건당)
호출자는 아래 필드를 채운다. 특정 상위 workflow의 용어나 필드명을 호출자에게 요구하지 않는다.
- `agent`: 에이전트 ID와 역할
- `task`: 작업 참조(ID 또는 제목)
- `claim`: 에이전트가 주장한 결과 (원문 유지)
- `evidence`: SHA, PR, 테스트 수, CI 링크와 결과
- `task_status`: `PASS` | `FAIL` | `NOT_RUN` | `UNKNOWN` | `BLOCKED`
- `findings`, `blockers`, `owner_requests`
- 선택: `objective_ref`, `ac_ref`, `approved_scope_ref`. 없으면 `입력 없음`으로 쓴다.

## 3. 결과별 추출 (빠뜨리거나 바꾸지 않는다)
각 입력에서 다음을 뽑는다.
- 목적과 실제로 달성한 능력 (주장과 구분해 쓴다)
- 사용자에게 보이는 효과
- 구현·테스트·CI·독립 검수·배포의 실제 상태 (각각 분리)
- 실패, 발견사항, 미검증 항목, blocker
- AC 영향
- 후속 작업과 실행 가능 여부 (기존 승인 범위 안인지 표시)
- 항목별 구분: Main 판단 대상 / Owner 결정 대상

SHA, 수치, trade-off, 위험, unknown은 요약하면서 줄이거나 다른 값으로 바꾸지 않는다.

## 4. 집계 규칙 (이 Skill만 소유한다)
a. **보존**: 입력 N개는 설명 N개가 된다. 병합·누락·삭제를 하지 않는다. 빠진 입력은 `입력 없음`으로 드러낸다.
   단, 동일한 `agent`·`task`·`claim`·`evidence`가 여러 번 도착한 중복 수신은 입력 1건으로 세고 중복 횟수를 함께 적는다. 내용이 다른 재보고는 별도 입력으로 보존한다.
b. **악화만**: 묶음 상태는 작업 상태 중 최악이다. 순서는 `FAIL > BLOCKED > UNKNOWN > NOT_RUN > PASS`.
   주장만으로는 `PASS`가 되지 않는다. `PASS`에는 실행 명령, CI 링크, 고정 SHA 같은 evidence ref가 있어야 한다.
   작업별 상태는 묶음 상태와 분리한다. Objective 판정은 Main 또는 호출자가 내며, 이 Skill은 Objective `PASS`를 만들지 않는다.
c. **출처 표시**: 각 사실에 `에이전트 주장` 또는 `Main 직접 확인`을 붙인다. Main이 명령이나 링크로 직접 확인한 것만 후자다.
d. **충돌 노출**: 서로 다른 결과(예: 같은 SHA에 대해 한쪽 PASS, 다른 쪽 FAIL)는 나란히 보여준다. 합치거나 임의로 하나를 고르지 않는다. 원인 확인은 Main 판단 항목으로 넘긴다.
e. **권한 확장 금지**: `AI가 이어서 할 일`은 제안이다. 실행은 호출자의 기존 승인·workflow 범위 안에서만 한다. 묶음에 합류했다는 사실은 실행·쓰기·승인 권한을 주지 않는다.
f. **정정 기록**: 에이전트 보고를 그대로 믿지 않는다. 주장이 이 세션에서 이미 확인된 사실과 다르면(예: 원인을 `UNKNOWN`이라 했으나 이미 확인된 원인이 있음) 원문 주장은 지우지 않고 그 아래에 `정정: <확인된 사실> (근거: Main 직접 확인 또는 evidence ref)`를 붙인다. 정정된 값으로 원문을 덮어쓰지 않는다. 값싼 핵심 사실(커밋 diff, CI 상태)은 Main이 한 번 직접 확인할 수 있다.

## 5. 출력 매핑 (engineering-communication-ko 구조를 참조한다)
새 F1 형식을 정의하지 않는다. 보고 구조와 증거 표현은 `skills/engineering-communication-ko/SKILL.md`를 따른다.

| 이 Skill의 출력 | 참조하는 구조 |
|---|---|
| 완료된 기능 (사용자 관점, 실제 확인된 것만) | 결과 (보고 순서 1–3) |
| 검증 및 남은 범위 (테스트·CI·검수 상태, 미확인 항목) | 검증 및 남은 범위 |
| AI가 이어서 할 일 (제안, 승인 범위 표시) | 다음 행동 |
| Owner 결정 (정확한 범위, 없으면 `없음`) | 결정 요청 |
| 에이전트별 행 | AI 실행 현황 표 (같은 열 구성, 관측되지 않은 값은 `UNKNOWN`) |

- 출력 순서는 위 표의 순서로 고정한다: 완료된 기능 → 검증 및 남은 범위 → AI가 이어서 할 일 → Owner 결정 → 에이전트별 행. 즉시 확인이 필요한 항목은 맨 앞에 둔다.
- Owner 결정 항목은 각각 추천안 1개를 붙인다. 이미 받은 승인은 다시 묻지 않는다.
- 파일 경로는 전체 절대경로로 쓴다.
- 시각(열림·닫힘 등)은 실행 환경에서 얻은 실제 값만 쓴다. 값을 얻지 못했으면 추정하지 않고 `UNKNOWN`으로 쓴다.
- 관측 범위는 `complete` | `partial` | `unknown`으로 표시한다. `complete`는 호출자가 이 묶음의 입력을 빠짐없이 넘겼다고 확인한 경우에만 쓴다.
- 보존 불변식은 `skills/한글화/SKILL.md`의 `## 보존 대상 (변경 금지)` 절을 따른다. 목록을 이 Skill에 복제하지 않는다.
- 이 Skill은 `/한글화`와 `/f1`을 호출하지 않는다. 두 Skill은 명시 호출 전용이며, 여기서는 기준만 참조한다.

## 6. 관측 범위와 증거 표현
- 에이전트 주장, Main 직접 확인, 미확인(`UNKNOWN`), 미실행(`NOT_RUN`)을 섞지 않는다.
- 독립 검수는 검수자가 다른 주체이고 고정 HEAD 또는 불변 patch를 본 경우에만 독립이라고 쓴다. 작성자의 자기 점검은 독립 검수가 아니다.
- 합성 fixture, 코드 리뷰, 공식 CI, 실제 Runtime E2E는 서로 대신하지 않는다.

## 7. 컨텍스트 압축 안전
checkpoint마다 대화 안에 ledger 블록을 남긴다(파일이 아니다).

```text
[ledger] batch=<묶음 참조> 관측 범위=<complete|partial|unknown>
- <task id> | <agent> | <task_status> | <evidence refs>
```

압축 후 재개했을 때 ledger에 없는 항목은 `UNKNOWN`으로 보고한다. 조용히 버리지 않는다. Main이 재확인하거나 호출자가 결과를 다시 넘겨야 한다.

## 8. 저장하지 않는다
- 파일, 상태 디렉터리, DB를 만들지 않는다. 이전 버전의 `~/.local/state/batches/` 방식은 폐기한다.
- 재개와 checkpoint 저장은 체크포인트 계약(RPL-120)과 user-local-state(RPL-95)의 소관이다. 재개 시 결과는 호출자가 다시 넘긴다.

## 9. 호출 관계
- 단독 사용과 다른 workflow의 참조 사용을 모두 허용한다.
- 노출 범위: 레포 로컬 상대 심볼릭 링크(`.claude/skills/batch-report`, `.agents/skills/batch-report`)만 추가한다. setup.sh와 전역 설치(`~/.claude/skills`, `~/.agents/skills`)는 바꾸지 않는다.
- 호출자가 바뀌어도 입력 envelope와 집계 규칙은 같다. 호출자별 계약은 호출자가 소유한다.

## 10. 런타임 경계 (Claude Code · Codex 공통)
- 공통 계약: 사용자에게 가는 모든 결과는 Main의 응답 텍스트다.
- Skill이 통제하는 것: Main이 쓰는 텍스트(진행 신호, 종합, ledger).
- Skill이 통제하지 못하는 것: 런타임·harness 알림, UI 배지, 완료 알림 훅의 발화 시점과 횟수.

### completion-notify 정적 분석 (저장소 코드 근거, 런타임 실행 아님)
- 등록 이벤트: Claude는 `hooks.Stop` 배열에만 항목을 추가한다(`scripts/completion-notify.py:247`, `:253-266`, matcher 없음). `SubagentStop`·`Notification` 등록은 저장소에 없다. Codex는 최상위 `notify` 한 항목을 쓴다(`scripts/completion-notify.py:201`).
- 이벤트 변환: Claude 어댑터는 입력 페이로드의 응답 필드를 버리고 `agent-turn-complete`를 무조건 만든다. 어떤 Stop이 Main 턴 종료인지 서브에이전트 종료인지 구분하지 않는다(`scripts/completion-notify-claude.sh:6-15`).
- 중복 제거: 디스패처는 `flock(LOCK_EX|LOCK_NB)` 실패 시 큐잉 없이 `exit 0`으로 이벤트를 버린다(`scripts/completion-notify-dispatcher.sh:61-70`). 잠금은 공급자 실행 구간 동안만 유지된다(기본 1초, 상한 5초: `:58`; 종료는 SIGTERM 후 0.15초 뒤 SIGKILL: `:113-135`). 따라서 timeout 창 안에 들어온 이벤트는 합쳐지는 것이 아니라 버려지고, 창 밖의 이벤트는 각각 알림이 된다. 배치 단위 합치기는 없다.
- 로그 한계: `dispatcher invoked` 로그는 잠금 획득 뒤에만 쓰므로(`:80`) 버려진 이벤트는 로그에도 남지 않는다.
- 알림: 어댑터는 고정 제목·본문으로 `osascript display notification`을 호출한다(`scripts/completion-notify-macos.sh:22-27`). 이벤트당 1회이며 추가 dedupe는 없다.
- 결론: 알림 수는 Stop 발화 수에서 잠금 창 중복을 뺀 값이다. N개 배경 에이전트가 끝날 때마다 Main 턴과 Stop이 열리는지는 저장소 코드로 결정되지 않는다(런타임 의존). 열린다면 창 밖 간격의 완료마다 알림이 나올 수 있다. 단, 이 Skill은 알림 발화를 통제하지 못한다.

### 런타임 프로브: NOT_RUN
- 프로브 계획:
  1. 즉시 종료하는 배경 에이전트 3개를 띄운다.
  2. 런타임별로 (1) 사용자에게 보인 Main 텍스트 블록 수, (2) 로그 `${XDG_STATE_HOME:-$HOME/.local/state}/oh-my-ai/completion-notify.log`의 `dispatcher invoked` 줄 수(잠금 통과분만), (3) 런타임 UI 알림 수를 센다.
  3. 각 항목을 Skill 통제 가능 / 불가로 분류한다.
  4. 결과는 `capabilities/runtime-capabilities.json`에 나중에 기록한다. 이번 변경에서는 수정하지 않는다.

## 11. 하지 않는 일
- 근거 없는 완료 표현을 만들지 않는다.
- 권한, 승인, 범위를 집계 과정에서 넓히지 않는다.
- 에이전트 보고를 요약하면서 SHA·수치·위험을 빼지 않는다.
