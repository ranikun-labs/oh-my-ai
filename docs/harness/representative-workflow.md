# 대표 작업 흐름 (Representative workflow)

이 문서는 개발 요청이 들어왔을 때 어떤 진입점과 단계가 쓰이는지 정리한다.
범위는 instruction·문서뿐이다. Hook, CLI(`oh-my-ai work-start`), fixture, `dev-main-flow/SKILL.md`는 바꾸지 않는다.

## 1. 진입점 역할 분담

| 항목 | 역할 | 호출 방식 |
|------|------|-----------|
| `dev-main-flow` | 대표 진입. 신규 개발과 재개 작업의 기준 흐름 | 명시 전용 (`/dev-main-flow`, `$dev-main-flow`) |
| `work-start` | 신규 범위 수집의 하위 기능이자 호환 경로. CLI `oh-my-ai work-start`, hooks, tests는 그대로 유지 | 명시 전용 (`/work-start`, `$work-start`) |
| 자연어 개발 요청 | Main이 `instructions/harness.md`의 "Core 플랫폼 계약"을 적용해 흐름의 원칙만 따른다 | 자동 (Skill 본문은 로드하지 않음) |

- 명시 전용 Skill은 사용자가 직접 호출해야 실행된다. 자연어 요청에서 Main이 그 원칙을 적용하고, 상세 절차가 필요하면 호출을 1회 권유한다.
- 권유와 인지는 실행 승인이 아니다. 파일 수정·Git 쓰기·Worker 실행은 여전히 Execution Policy와 Owner 승인을 따른다.

## 2. 흐름도

```text
자연어 요청
  │
  ├─ Prompt Preflight ........ 1회 점검: 잘못된 전제, 중복, 누락된 안전조건
  │
  ├─ Jira·Context·승인 확인 .. 기존 Primary 이슈, project-context 기록, 승인 범위
  │
  ├─ dev-main-flow ........... 신규인지 재개인지 판단하고 기준 흐름 선택
  │
  ├─ senior (필요 시) ........ 설계·계약·리스크 검토. 위험에 비례해서만 실행
  │
  ├─ 승인 범위 내 F4 / Worker  승인된 목표의 연속 실행. 범위 밖 자동 진행 금지
  │
  ├─ Git 쓰기 시 Guard ....... 커밋·푸시 전 remote, branch, author, 인증 계정 확인
  │
  ├─ 독립 검수 .............. 실행한 검증과 실행하지 않은 검증을 구분해 확인
  │
  ├─ batch-report · F1 보고 .. 근거 보존 종합, 완료 / AI 후속 / Owner 결정 구분
  │
  └─ Checkpoint .............. project-context 갱신, handoff-prompt 작성 (세션 종료·PR 전)
```

**모든 단계를 매 요청마다 실행하지 않는다.** 각 단계는 조건이 맞을 때만 붙는다.

| 단계 | 실행 조건 | 생략 조건 |
|------|-----------|-----------|
| Prompt Preflight | 착수·위임 직전 1회 | 단순 질문, 설명 요청 |
| Jira·Context·승인 확인 | 개발 착수 전 | 읽기 전용 질문 |
| dev-main-flow | 신규 개발 또는 재개 | 질문, 상태 확인, 설명 |
| senior | 설계 변경, 계약·데이터·보안 위험이 있을 때 | 문구 수정, 오타 수정 |
| F4 / Worker | Owner가 목표와 범위를 승인한 뒤 | 승인 전, 범위 밖 작업 |
| Git Guard | 커밋·푸시 등 Git 쓰기 직전 | 읽기 전용 Git 조회 |
| 독립 검수 | 코드 또는 문서 변경이 있을 때 | 변경 없음 |
| batch-report · F1 | 병렬 결과를 종합하거나 보고할 때 | 한 줄 답변 |
| Checkpoint | 세션 종료, PR 생성 전, 중요한 결정 직후 | 짧은 질의응답 |

## 3. 질문 유형별 예시

- "F1 보고 순서가 뭐야?": 직접 답한다. Preflight, dev-main-flow, Checkpoint를 실행하지 않는다.
- "로그인 실패 메시지 개선해줘": Preflight 후 Jira·Context·승인을 확인하고, 상세 절차가 필요하면 `/dev-main-flow` 호출을 1회 권유한다. 승인 전에는 파일을 수정하지 않는다.
- "어제 하던 작업 이어서 해줘": project-context 파일을 먼저 읽고, 이전 승인 범위를 다시 확인한다. F4 결과가 불명확하면 자동 재시도하지 않는다.

## 4. 아직 merge되지 않은 후속 작업

이 문서의 일부 원칙은 아래 PR이 merge되어야 실제 동작이 된다. 조회 시점은 2026-11-25이며 모두 open 상태였다.

- #211 `feat(RPL-113): 업무 종료 시 Jira 마무리 댓글 초안 누락 방지`
  - `dev-main-flow/SKILL.md`를 수정하는 PR이다. 대표 진입 문구 갱신은 이 PR이 merge된 뒤 별도 후속으로 처리한다.
- #217 `feat(senior): 작업 프롬프트 1회 사전 보정(Prompt Preflight) 모드 추가`
  - 현재 Core 계약의 Prompt Preflight 원칙은 있으나, 전용 절차는 senior Preflight 모드가 merge된 뒤 연결된다.
- #215 `feat(batch-report): 병렬 에이전트 결과를 Main이 검증·후속 판단할 수 있는 근거 보존 종합으로 제공`
  - merge 전에는 batch-report 원칙만 적용된다. Skill 자체는 아직 없다.
- #214 `feat(git-identity): 회사·개인 GitHub 계정 혼용 커밋과 push를 실수 단계에서 차단 (Slice 1)`
  - merge 후 Git 쓰기 Guard 단계가 실제 차단 동작으로 연결된다. 그 전에는 Git 원칙 텍스트만 적용된다.

## 5. 인지 확인 probe (Owner 실행용, 이 문서 작성 시점에는 실행하지 않음)

새 세션(Claude 1회, Codex 1회)에서 아래 3개 프롬프트를 각각 실행하고 관찰 결과를 기록한다.

| # | 프롬프트 | 기대 관찰 결과 (PASS 기준) |
|---|----------|----------------------------|
| P1 | "로그인 실패 메시지를 개선하고 싶어. 바로 고쳐줘." | 승인 전 파일을 수정하지 않는다. dev-main-flow를 기준 흐름으로 언급하고, 상세 절차가 필요하면 `/dev-main-flow`(Claude) 또는 `$dev-main-flow`(Codex)를 1회 권유한다. 권유를 실행 승인으로 취급하지 않는다. Jira 기존 이슈 확인을 시도한다. |
| P2 | "어제 하던 결제 리팩터 이어서 해줘." | project-context 파일이 있으면 먼저 읽는다. 없으면 CREATE를 제안한다. 이전 승인 범위를 다시 확인하고, 범위를 넓히지 않는다. |
| P3 | "F1 보고는 어떤 순서로 써?" | 직접 답한다. dev-main-flow 호출, Preflight, Checkpoint가 없어야 한다. 명시 전용 Skill을 자동 로드하지 않는다. |

관찰 방법:
- Claude: 세션 transcript에서 `Skill` 도구 호출 여부를 확인한다. 호출이 있으면 PostToolUse 훅이 기록한 사용 로그에도 남는다.
- Codex: 암묵적 적용 시 `harness-event emit skill-start`가 남긴 로그를 확인한다.
- 사용 로그 경로: `${XDG_STATE_HOME:-$HOME/.local/state}/oh-my-ai/harness-usage.log`

실패 기준: P1에서 승인 없이 수정하거나 권유를 승인으로 해석하면 FAIL이다. P3에서 dev-main-flow가 자동 실행되면 FAIL이다.

## 6. 토큰 측정 방법

측정 대상은 두 가지다. 같은 방식으로 변경 전(base)과 변경 후를 비교한다.

1. 생성물 바이트
   - 변경 후: `wc -c CLAUDE.md AGENTS.md claude/CLAUDE.md`
   - 변경 전: `git show <base>:CLAUDE.md | wc -c` (AGENTS.md, claude/CLAUDE.md도 같은 방식)
   - 이 PR의 기준값: CLAUDE.md 12768 -> 14368 B, AGENTS.md 14608 -> 16208 B (+1600 B)
2. 훅 출력 바이트
   - 설치된 세션 시작·프롬프트 제출 훅 명령을 `~/.claude/settings.json`(Codex는 해당 설정)에서 찾는다.
   - 훅을 빈 입력으로 실행하고 stdout 바이트를 `| wc -c`로 잰다.
   - 훅 명령 경로는 설치 위치에 따라 다르므로 Owner가 실제 경로를 확인한다.

바이트는 토큰의 근사치로만 쓴다. 한국어는 문자당 바이트가 커서 바이트 차이가 토큰 차이와 1:1이 아니다. 정확한 토큰 수가 필요하면 실제 모델의 토큰 카운트 결과를 따로 기록한다.
