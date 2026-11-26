---
name: work-start
description: "Use only when a user explicitly invokes Claude /work-start or Codex $work-start — to run the local Work-start Engine once, create a Work-start Candidate artifact, report the generated files, and stop for Human Review before any code edit, doc write, planning branch, worker handoff, or external action."
display-name: Work-start
disable-model-invocation: true
metadata:
  source: born-here
  summary: 작업 시작 시 외부 맥락 회수 → repo 컨텍스트 수집 → 중간 점검 → 컨펌의 conversation-native 플레이북
---

# Work Start — 작업 시작 플레이북

## 목적

작업을 시작할 때 가장 자주 발생하는 실패 원인은 **외부 맥락 누락**이다.

- 기존 티켓이 있는데 안 넣음 → 요구사항 누락
- 회의 결정이 있는데 안 넣음 → 이미 결정난 걸 다시 고민
- Slack 대화가 있는데 안 넣음 → 암묵적 제약 누락
- 기존 PR/이슈가 있는데 안 봄 → 같은 문제 반복

이 스킬은 repo 검색 전에 **먼저 사용자가 빠뜨린 외부 맥락을 회수**한다. 그 다음에 repo/docs/code를 본다.

## Claude Code Runtime Entry

사용자가 Claude Code에서 `/work-start <task>`를 명시 호출하면 다음으로 처리한다.

자연어 Intent는 이 스킬의 실행 트리거가 아니다. 자연어로 "시작 전에 정리", "구현 전에 관련 코드와 영향 범위 정리" 같은 요청이 들어오면 prompt hook은 suggestion-only 안내만 할 수 있고, 이 스킬·`make work-start`·`scripts/work-start.sh`는 실행하지 않는다.

```text
canonical_action_id = work-start
entry_mode = explicit
approval = not_required
```

```oh-my-ai-work-start-contract
version = 1
runtime = claude
public_entry = "$HOME/.local/bin/oh-my-ai" work-start -- "<single task argument>"
```

이 명시 호출은 Work-start 제품 동의가 이미 존재한다는 뜻이다. 단, Claude Code의 File·Shell·Network·Git permission은 그대로 유지한다.

실행 절차:

1. `<task>`를 원래 사용자 Task로 보존한다.
2. 현재 사용자 작업 Repository의 cwd에서 안정적인 Public Entry인 `"$HOME/.local/bin/oh-my-ai" work-start -- "<single task argument>"`를 한 번 실행한다. 설치된 Skill 경로나 현재 Repository에서 Engine 파일을 찾거나, oh-my-ai source Repository로 cwd를 변경하지 않는다.
3. 생성된 Artifact 경로와 생성 파일을 사용자에게 표시한다.
4. Human Review에서 Direct Handoff / Plan First / Gather Context 중 하나를 사용자가 직접 선택하도록 안내한다.
5. 현재 응답을 종료하고 사용자의 다음 선택을 기다린다.

Runtime Terminal Boundary (우선 적용): 이 명시 실행 절차는 이 문서의 이후 일반 플레이북보다 우선한다. Engine 종료 뒤에는 Artifact를 자동 Read하지 않고, 원래 Task를 분석하거나 다음 단계를 선택하지 않는다. 반드시 생성 경로·파일과 세 선택지만 보고한 뒤 현재 응답을 종료한다.

금지:

- 모델이 자연어 Intent만으로 이 스킬을 자동 호출하지 않는다.
- Suggestion 상태에서 `scripts/work-start.sh`를 실행하지 않는다.
- 승인 전 Artifact를 생성하지 않는다.
- Engine 실행 후 원래 Task 분석을 계속하지 않는다.
- 수정 계획을 제안하지 않는다.
- 코드 수정 여부를 묻지 않는다.
- 파일을 수정하지 않는다.
- Plan First / Gather Context / Direct Handoff 중 하나를 자동 선택하지 않는다.
- Runtime Invocation, Worker 자동 실행, Session Linking, Managed Task, 자동 Result 반환을 수행하지 않는다.

종료 Contract:

```text
This command creates a Work-start Candidate only.

After the Engine finishes:
- report the generated Artifact directory and files
- display the Human Review choices
- stop the current response

Do not continue analyzing or executing the original task.
Do not modify source files.
Do not ask for implementation confirmation.
Wait for the user to review and choose the next step.
```

## 트리거 예시

```
/work-start dual write 고민중인데 네카라 시니어 실무표준 어케 설계해야할까
/work-start 하네스 만든거 노션에 정리하고 싶어
/work-start auth middleware 새 compliance 요구사항에 맞게 수정
/work-start 이번 sprint 배포 전 체크리스트 정리
```

## Codex Runtime Entry

사용자가 Codex CLI에서 `$work-start <task>`를 명시 호출하거나 `/skills` 또는 `$` mention picker로 `work-start`를 직접 선택하면 다음으로 처리한다.

자연어 Intent는 이 스킬의 실행 트리거가 아니다. 자연어로 "시작 전에 정리", "구현 전에 관련 코드와 영향 범위 정리" 같은 요청이 들어오면 Codex `UserPromptSubmit` hook은 suggestion-only 안내만 할 수 있고, 이 스킬·`make work-start`·`scripts/work-start.sh`는 실행하지 않는다.

```text
canonical_action_id = work-start
runtime = codex-cli
entry_mode = explicit
approval = not_required
official_explicit_invocation = $work-start <task>
```

```oh-my-ai-work-start-contract
version = 1
runtime = codex
public_entry = "$HOME/.local/bin/oh-my-ai" work-start -- "<single task argument>"
```

이 명시 호출은 Work-start 제품 동의가 이미 존재한다는 뜻이다. 단, Codex의 sandbox·approval·filesystem·network permission은 그대로 유지한다.

실행 절차:

1. `<task>`를 원래 사용자 Task로 보존한다. 사용자의 전체 입력을 `TASK`로 전달하지 말고, 선두 명시 호출 토큰인 `$work-start` 뒤의 argument만 `TASK`로 전달한다.
2. Codex Entry Boundary에서 선두 `$work-start` 토큰만 제거한다. Task 본문 안의 일반 문자열 `work-start`는 보존한다.
3. 현재 사용자 작업 Repository의 cwd에서 안정적인 Public Entry인 `"$HOME/.local/bin/oh-my-ai" work-start -- "<single task argument>"`를 한 번 실행한다. 설치된 Skill 경로나 현재 Repository에서 Engine 파일을 찾거나, oh-my-ai source Repository로 cwd를 변경하지 않는다.
4. 생성된 Artifact 경로와 생성 파일을 사용자에게 표시한다.
5. Human Review에서 Direct Handoff / Plan First / Gather Context 중 하나를 사용자가 직접 선택하도록 안내한다.
6. 현재 응답을 종료하고 사용자의 다음 선택을 기다린다.

Runtime Terminal Boundary (우선 적용): 이 명시 실행 절차는 이 문서의 이후 일반 플레이북보다 우선한다. Engine 종료 뒤에는 Artifact를 자동 Read하지 않고, 원래 Task를 분석하거나 다음 단계를 선택하지 않는다. 반드시 생성 경로·파일과 세 선택지만 보고한 뒤 현재 응답을 종료한다.

금지:

- 모델이 자연어 Intent만으로 이 스킬을 자동 호출하지 않는다.
- Suggestion 상태에서 `scripts/work-start.sh`를 실행하지 않는다.
- 승인 전 Artifact를 생성하지 않는다.
- Engine 실행 후 원래 Task 분석을 계속하지 않는다.
- 수정 계획을 제안하지 않는다.
- 코드 수정 여부를 묻지 않는다.
- 파일을 수정하지 않는다.
- Plan First / Gather Context / Direct Handoff 중 하나를 자동 선택하지 않는다.
- Runtime Invocation, Worker 자동 실행, Session Linking, Managed Task, 자동 Result 반환을 수행하지 않는다.

종료 Contract:

```text
This skill creates a Work-start Candidate only.

After the Engine finishes:
- report the generated Artifact directory and files
- display the Human Review choices
- stop the current response

Do not continue analyzing or executing the original task.
Do not modify source files.
Do not ask for implementation confirmation.
Wait for the user to review and choose the next step.
```

트리거 예시:

```
$work-start dual write 고민중인데 네카라 시니어 실무표준 어케 설계해야할까
$work-start 하네스 만든거 노션에 정리하고 싶어
$work-start auth middleware 새 compliance 요구사항에 맞게 수정
$work-start 이번 sprint 배포 전 체크리스트 정리
```

---

## Human Review 이후 Continuation Boundary

Main Session은 Human Review, 계획·Context 검토, 결과 통합과 다음 단계 선택을 수행한다. Native Subagent는 Provider Runtime 기능이며, 사용자가 승인한 Handoff를 받아 구현·검증하는 별도 Worker Session과 동일하지 않다.

Continuation은 Work-start 실행이 끝난 **다음 사용자 메시지**에서 사용자가 Direct Handoff / Plan First / Gather Context 중 하나를 명시적으로 선택한 경우에만 시작한다. 이때 기존 Artifact만 Read하며 Public Entry·Engine을 다시 실행하거나 새 Artifact를 생성하지 않는다.

### Plan First

1. 사용자가 Human Review에서 Plan First를 명시적으로 선택한다.
2. Planning Skill 또는 수동 Planning Process를 수행한다.
3. 계획 결과를 Main Session에서 검토·통합한다.
4. 검토된 계획을 Handoff Candidate에 반영할지 사용자에게 확인한다.
5. 사용자가 승인한 경우에만 Candidate에 계획을 반영한다.
6. Candidate 상태는 `Needs human review`로 유지한다. Candidate 반영은 Direct Handoff 승인이 아니다.
7. Main Session은 구현·Commit·Push·PR·Merge를 시작하지 않는다.
8. 아래 종료 안내를 표시하고 현재 응답을 종료한다.

### Gather Context

1. 사용자가 Human Review에서 Gather Context를 명시적으로 선택한다.
2. 필요한 Context를 수집·확인한다.
3. 결과를 Main Session에서 검토·통합한다.
4. Candidate 반영 또는 재검토 여부를 사용자에게 확인한다.
5. 사용자가 승인한 경우에만 Candidate에 검토된 Context를 반영한다.
6. Candidate 상태는 `Needs human review`로 유지한다. Candidate 반영은 Direct Handoff 승인이 아니다.
7. Main Session은 구현·Commit·Push·PR·Merge를 시작하지 않는다.
8. 아래 종료 안내를 표시하고 현재 응답을 종료한다.

### 종료 안내와 Stop Boundary

Plan First 또는 Gather Context가 끝난 뒤에는 다음 의미를 사용자에게 전달한다. 문구는 상황에 맞게 바꿀 수 있지만 정보는 생략하지 않는다.

```text
<Plan First 또는 Gather Context>가 완료되었습니다.
Handoff Candidate 반영: <반영됨 | 아직 반영하지 않음>

현재 상태: Needs human review
Worker Session은 아직 생성되거나 실행되지 않았습니다.

구현을 진행하려면 Candidate를 최종 검토한 뒤 Direct Handoff를 별도로 명시적으로 선택하고,
새 Worker Session에 승인된 Candidate 또는 Handoff 내용을 수동으로 전달하세요.
```

이 안내 후 Main Session은 구현을 시작하지 않고 정지한다. Plan 완료 자동 감지, Candidate 자동 반영·완성, starter-prompt 자동 갱신, Ready for Handoff 상태, Direct Handoff 자동 선택, Worker Session 자동 생성·실행, Prompt 자동 주입, Session Linking, Result 자동 회수는 수행하지 않는다.

---

## v1 범위

| v1 IN | v1 OUT |
|-------|--------|
| Task classification | workflow preset 실행 |
| External context intake | review lens chain 실행 |
| Repo context gathering | multi-tool routing 실행 |
| Intermediate checkpoint | agent 자동 실행 |
| Confirmation protocol | ohmy CLI |
| Notion/Slack MCP 핸들링 (승인 후) | 외부 API 자동 호출 |
| Safety rules | cloud/API integration |
| context-manifest.yaml 생성 (hint 포함) | workflow preset / lens / tools 실행 |

`workflow_hint`와 `external_context`는 v1에서 **기록/힌트 전용**이다. 실행하지 않는다.

### v1.1 추가

| v1.1 IN | v1.1 OUT |
|---------|---------|
| `skills/` inventory 스캔 (존재하는 SKILL.md만) | skill auto-execution |
| task_type + keyword + description 기반 candidate 매칭 | private skill 자동 설치 |
| primary / secondary / optional 티어 구분 | runtime skill path 변경 |
| candidate + reason + matched signals 출력 | review lens chain |
| private profile skill → manual reference only 표시 | workflow preset |
| skill gap 표시 (repo에 없는 스킬 + fallback 제안) | orchestration |
| intermediate checkpoint에 추천 스킬 후보 섹션 추가 | |
| 컨펌 전 스킬 실행 금지 | |

### v1.2 추가

| v1.2 IN | v1.2 OUT |
|---------|---------|
| Work-start Artifact 안에 `handoff-candidate.md` 초안 생성 | Worker Runtime 자동 실행 |
| Skill Candidate와 Project Context reference를 Handoff Candidate에서 참조 | Runtime Invocation |
| `templates/result-basic.md` 반환 Contract 연결 | Managed Task / Session Linking |
| Human Review 후 수동 Copy/Paste 안내 | 자동 Result 반환 |

### v1.3 추가

| v1.3 IN | v1.3 OUT |
|---------|---------|
| Human Review에서 Direct Handoff / Plan First / Gather Context 선택지 표시 | 시스템의 Next Step 자동 선택 |
| 선택 전 `Needs human review` 상태 유지 | 기본 선택값 지정 |
| External Context Checkpoint를 수동 확인 후보로 표시 | 작업 복잡도 자동 판정 |
| 사용자가 계획·외부 Context를 수동 보완한 뒤 Candidate 재검토 | Planning Skill 자동 호출 |
| Handoff Candidate 상태 유지 | Connector 호출 / 외부 자료 자동 검색 |

Next Step 선택지는 사용자 검토를 돕는 중립 표시다. Work-start는 어떤 선택지도 추천하거나 실행하지 않는다.

---

## 핵심 규칙

**Never jump directly into implementation or final advice if the task may depend on missing external context.**

외부 맥락이 필요할 수 있는 작업이면, repo를 보기 전에 먼저 외부 맥락 확인 질문을 한다.

---

## 1단계: Task Classification

작업을 분류해 이후 흐름을 결정한다.

| task_type | 예시 | 외부 맥락 질문 |
|-----------|------|---------------|
| `architecture_design` | dual-write 설계, 서비스 분리 | **필수** |
| `migration` | DB migration, infra cutover | **필수** |
| `documentation` | Notion 정리, 설계 문서 작성 | **필수** |
| `review` | PR 점검, 코드 리뷰 | **필수** |
| `handoff` | 인수인계, 세션 전환 | **필수** |
| `debugging` | 에러 분석, 재현 | 있으면 요청 |
| `code_change` | 기능 추가, 버그 수정 | 간단히 확인 |
| `refactor` | repo 내부 리팩터링 | 생략 가능 |
| `general` | 위 분류에 해당 없는 작업 | 간단히 확인 |

분류 결과를 첫 응답에 명시한다. 예: "이건 `documentation` 작업으로 분류됩니다."

---

## 2단계: External Context Intake

### 질문 형식

외부 맥락 질문이 필요한 task_type이면, **repo를 읽기 전에** 아래를 먼저 묻는다.

```
이 작업과 관련된 기존 자료가 있나요?

- Jira / GitHub 이슈 / 티켓
- Confluence / Notion 페이지
- Slack / 메신저 대화 발췌
- 회의록 / 회의 메모
- PR / 이슈 번호
- 제품 결정 / 요구사항 문서
- 작업 지시 텍스트

있다면 아래 중 편한 방식으로 주세요:
1. 직접 복붙
2. 로컬 파일 경로 (make work-start TASK_FILE=<path>)
3. Confluence / Notion / MCP로 접근 가능한 위치 알려주기
4. 없으면 "없음"

없어도 진행 가능하지만, 기존 결정사항이나 제약이 빠질 수 있습니다.
```

### 입력 형식 (accepted source forms)

| 입력 형태 | 처리 |
|-----------|------|
| 복붙 텍스트 | 그대로 외부 맥락으로 취급 |
| 로컬 파일 경로 (`.md`, `.txt`) | `make work-start TASK_FILE=<path>` 안내 또는 직접 읽기 |
| MCP/connector reference | 가능하면 사용 (Notion MCP, Confluence MCP 등) |
| URL | 직접 접근 가능한 경우 fetch, 아니면 복붙 요청 |
| "없음" | repo-local context로 진행, 외부 맥락 missing으로 표기 |

### "없음" 처리

```
외부 자료가 없으면 repo 기준으로 진행합니다.
단, 기존 결정사항·제약·팀 운영 규칙이 빠질 수 있습니다.
작업 중 발견되는 context gap은 중간 점검에서 명시합니다.
```

### Notion / Confluence / Jira / Slack 처리

- **API/connector 가용 여부를 먼저 확인한다.** 자동으로 가정하지 않는다.
- Notion MCP, Confluence MCP가 세션에서 사용 가능하면 사용자 승인 후 사용한다.
- 가용하지 않으면 복붙 또는 로컬 파일로 요청한다.
- Slack export, Jira API는 사용자가 직접 연결한 경우에만 사용한다.

---

## 3단계: Repo Context Gathering

외부 맥락 수집이 끝난 뒤 repo를 본다.

수집 순서:

1. `git log --oneline -10` — 최근 작업 흐름
2. `git status --short` — 현재 worktree 상태
3. `git tag --sort=-version:refname | head -10` — 버전/릴리즈 히스토리
4. `docs/context/`, `CLAUDE.md`, `AGENTS.md`, `README` — 프로젝트 지침
5. `skills/` 목록 — 적용 가능한 플레이북
6. task와 관련된 파일 탐색 (`rg`, `find`)
7. 필요 시 `make work-start TASK="..."` helper 실행 (candidate 수집 보조)

### helper script와의 관계

`scripts/work-start.sh` (`make work-start`)는 repo candidate 수집 보조 도구다.  
이 스킬의 핵심 UX는 conversation 내 AI가 직접 담당한다. script는 선택적 보조 수단이다.

helper는 `.oh-my-ai/work-start/<timestamp>-<slug>/` 아래에 Local Artifact를 만든다.

기본 산출물:

- `context-manifest.yaml`
- `sources.md`
- `context-gap-report.md`
- `starter-prompt.md`
- `handoff-candidate.md`

`handoff-candidate.md`는 Structured Handoff Candidate 초안이다. Human Review 전에는 승인된 작업, Runtime 실행 명령, Managed Task가 아니다. 사용자가 검토·수정한 뒤 Worker Session에 수동 Copy/Paste하고, Worker 결과는 `templates/result-basic.md` 형식으로 반환받는다.

`handoff-candidate.md`의 Human Review는 다음 세 가지 수동 선택지를 표시한다.

- Direct Handoff: 사용자가 범위와 수행 방법이 충분히 명확하다고 판단한 경우, Candidate를 검토한 뒤 Worker에게 수동 전달한다.
- Plan First: 사용자가 영향 범위나 수행 순서를 먼저 정리해야 한다고 판단한 경우, Planning Skill 또는 수동 Planning Process를 수행하고 검토된 계획을 Candidate에 수동 반영한다.
- Gather Context: 사용자가 현재 정보가 충분하지 않다고 판단한 경우, 외부 자료 또는 추가 입력을 수동 확인한 뒤 Work-start 또는 Handoff를 다시 검토한다.

선택 전 상태는 `Needs human review`다. 기본 선택, 시스템 자동 선택, 자동 Planning, 자동 Workflow 분기, Connector 호출, Handoff 자동 승인은 v1.3 범위가 아니다.

`context-gap-report.md`와 `handoff-candidate.md`는 External Context Checkpoint를 수동 확인 후보로 표시할 수 있다. 이는 확인된 Fact나 검색 결과가 아니며, 외부 자료가 실제 존재한다고 단정하지 않는다.

---

## 3.5단계: Skill Candidate Routing

repo context 수집 후, task_type과 domain keyword를 기반으로 `skills/*/SKILL.md` inventory를 스캔해
적용 후보 스킬을 추천한다. **사용자 컨펌 전에는 어떤 스킬도 실행하지 않는다.**

### Skill Metadata 최소 표준

스킬 frontmatter에 아래 필드가 있으면 더 정확히 매칭된다.
없는 경우 `description` 텍스트 기반 heuristic으로 fallback한다.

```yaml
metadata:
  routing:
    task_types: [code_change, debugging]  # 적합한 task_type
    keywords: [golang, error]             # 매칭 키워드
    use_when:
      - "Go 코드에서 에러를 처리할 때"
    do_not_use_when:
      - "Python/Java 프로젝트에 적용할 때"
    visibility: public                    # public | private
    risk_level: low                       # low | medium | high
    requires: []                          # 선행 조건
```

현재 대부분의 스킬은 이 표준 metadata를 갖추지 않으므로 v1.1은 description 기반 heuristic을 사용한다.
metadata가 추가된 스킬은 자동으로 더 정확한 매칭을 얻는다.

### Candidate 스캔 순서

1. `node scripts/lib/skill-discovery.mjs --list` — 현재 repo에 실제 존재하는 스킬만 대상 (flat `skills/<n>/` 과 `skills/{core,library}/<n>/` 모두 포함)
2. `profiles/local/` 아래 스킬은 스캔하지 않고 manual reference로만 표시
3. 각 스킬을 아래 기준으로 scoring 후 tier 분류

### Candidate Scoring 기준

| 신호 | 가중치 |
|------|--------|
| task_type이 routing.task_types에 포함 | 높음 |
| task 텍스트 keyword가 routing.keywords 또는 description에 포함 | 중간 |
| use_when 조건이 현재 context와 일치 | 중간 |
| description이 task와 의미적으로 관련 | 낮음 |
| visibility: private | 제외 (manual reference만) |

### Tier 정의

| tier | 기준 |
|------|------|
| **primary** | task_type 직접 매칭 + keyword 일치. 이 작업에서 거의 항상 필요 |
| **secondary** | keyword 또는 description 매칭. 상황에 따라 유용 |
| **optional** | 간접 관련. 사용자가 필요하면 참고 |

### task_type별 routing table

`skills/` 에 실제 존재하는 스킬만 포함한다. 없는 스킬은 skill gap으로 처리한다.

**code_change**

| tier | 스킬 | 조건 |
|------|------|------|
| primary | `golang-error-handling` | golang 키워드 |
| primary | `kotlin-patterns` | kotlin 키워드 |
| primary | `springboot-patterns` | spring/java 키워드 |
| secondary | `golang-dependency-injection` | golang + DI/서비스 구조 |
| secondary | `golang-grpc` | golang + grpc/protobuf |
| secondary | `kotlin-coroutines-flows` | kotlin + async/flow |
| secondary | `kotlin-ktor-patterns` | kotlin + ktor/API |
| secondary | `springboot-tdd` | spring + 테스트 |
| secondary | `springboot-security` | spring + auth/security |
| secondary | `jpa-patterns` | spring + DB/entity |
| secondary | `postgres` | postgres/postgresql 키워드 |
| secondary | `redis-development` | redis/cache 키워드 |
| optional | `springboot-verification` | spring + 배포 전 검증 |
| optional | `execution-recovery` | 도구 실패 동반 시 |

**architecture_design**

| tier | 스킬 | 조건 |
|------|------|------|
| primary | `project-context` | 항상 |
| secondary | `golang-grpc` | golang + API/MSA 설계 |
| secondary | `kotlin-ktor-patterns` | kotlin + 서버 설계 |
| secondary | `springboot-patterns` | spring + 레이어 설계 |
| secondary | `golang-dependency-injection` | golang + 서비스 구조 |
| secondary | `redis-development` | 캐시 아키텍처 포함 |
| secondary | `kubernetes-skill` | 인프라/배포 설계 포함 |
| optional | `database-migration` | 데이터 설계 포함 |

**migration**

| tier | 스킬 | 조건 |
|------|------|------|
| primary | `database-migration` | DB/schema migration |
| primary | `legacy-modernizer` | 시스템 현대화/모노리스 분리 |
| primary | `kubernetes-skill` | 인프라/k8s migration |
| secondary | `jpa-patterns` | JPA/Hibernate 관련 |
| secondary | `postgres` | PostgreSQL migration |
| secondary | `springboot-patterns` | Spring Boot 업그레이드 |
| optional | `springboot-verification` | 검증 단계 포함 |

**debugging**

| tier | 스킬 | 조건 |
|------|------|------|
| primary | `execution-recovery` | 도구/인프라 장애 |
| secondary | `golang-error-handling` | golang 에러 추적 |
| secondary | `postgres` | DB 쿼리/성능 문제 |
| secondary | `springboot-patterns` | Spring 애플리케이션 디버깅 |
| optional | `kubernetes-skill` | k8s 환경 문제 |

**documentation**

| tier | 스킬 | 조건 |
|------|------|------|
| primary | `worklog-note` | Notion 정리 |
| primary | `release-note` | 릴리즈 노트/Jira fixVersion |
| primary | `daily-report` | Slack/일일보고 |
| secondary | `project-context` | 설계 문서/decision record |
| optional | `handoff-prompt` | 세션 전환 문서 포함 |

**review**

| tier | 스킬 | 조건 |
|------|------|------|
| primary | `springboot-verification` | Spring Boot 프로젝트 |
| secondary | `springboot-security` | 보안 리뷰 |
| secondary | `golang-error-handling` | golang PR 리뷰 |
| secondary | `golang-grpc` | gRPC API 리뷰 |
| secondary | `healthcare-phi-compliance` | healthcare/PHI 관련 |
| optional | `hipaa-compliance` | HIPAA 컴플라이언스 리뷰 |

**handoff**

| tier | 스킬 | 조건 |
|------|------|------|
| primary | `handoff-prompt` | 항상 |
| secondary | `project-context` | 설계 배경 포함 시 |
| optional | `daily-report` | 일일 보고 포함 시 |

**refactor**

| tier | 스킬 | 조건 |
|------|------|------|
| primary | `legacy-modernizer` | 레거시 개선/모노리스 |
| secondary | `golang-dependency-injection` | golang DI 리팩터 |
| secondary | `springboot-patterns` | Spring 리팩터 |
| secondary | `kotlin-patterns` | Kotlin 리팩터 |
| optional | `database-migration` | 스키마 리팩터 포함 |

### Skill Gap 처리

repo에 없는 스킬이 필요한 경우 확정 추천하지 않는다.
"skill gap — 현재 skills/ 에 없음" 으로 표시하고 fallback을 제안한다.

현재 알려진 skill gap:

| 필요한 스킬 | 상태 | fallback |
|-----------|------|---------|
| `systematic-debugging` | Superpowers plugin — skills/ 없음 | `execution-recovery` (인프라 장애 한정) |
| `verification-before-completion` | Superpowers plugin — skills/ 없음 | `springboot-verification` (Spring 한정) |
| `code-review` | `/code-review` 커맨드 존재, skills/ 없음 | `/code-review` 커맨드 직접 사용 |
| `test-driven-development` | skills/ 없음 | `springboot-tdd` (Spring), `kotlin-testing` (Kotlin) |

### Private Profile Skill 처리

- `profiles/local/` 아래 스킬은 자동 스캔하지 않는다.
- 사용자가 명시적으로 언급한 경우에만 `(private — manual reference only)` 로 표시한다.
- 자동 로딩, 자동 실행, 경로 노출 금지.

### Candidate 출력 형식

```
추천 스킬 후보:

| tier | 스킬 | reason | matched signals |
|------|------|--------|----------------|
| primary | `golang-error-handling` | golang 에러 처리 작업 | keyword: golang, task_type: code_change |
| secondary | `golang-dependency-injection` | DI 구조 변경 포함 가능 | keyword: golang, service |
| optional | `execution-recovery` | 도구 실패 시 참고 | task: 인프라 포함 |

skill gap:
- `systematic-debugging` — skills/ 없음. fallback: `execution-recovery` (인프라 장애 한정)
```

---

## 4단계: Intermediate Checkpoint

repo context 수집 후, **액션 전에** 중간 점검을 보고한다.

형식:

```
## 중간 점검

### 확인된 내용
- <git log, PR, 관련 파일에서 파악한 사실>

### 빠진 외부 맥락
- <없다고 한 항목 / 확보 못 한 항목>

### 작업 유형
- task_type: <분류>

### 추천 스킬 후보
| tier | 스킬 | reason | matched signals |
|------|------|--------|----------------|
| primary | `<skill-name>` | <이유> | <keyword, task_type 등> |
| secondary | `<skill-name>` | <이유> | <keyword 등> |

skill gap:
- `<skill-name>` — skills/ 없음. fallback: <대안>

(매칭 없으면: "매칭된 스킬 후보 없음 — skills/ 목록을 직접 확인하거나 스킬을 지정해주세요")

### 후보 방향
- <진행 방향 후보 1~2개, candidate로 표기>

### 식별된 리스크
- <data, security, rollback, compatibility, scope 관련>

위 스킬을 적용하면서 진행할까요?
다른 스킬을 지정하거나 스킬 없이 진행할 수도 있습니다.
```

---

## 5단계: Confirmation Protocol

중간 점검 이후 사용자가 컨펌하면 진행한다.

컨펌이 필요한 액션:

| 액션 | 컨펌 필요 |
|------|----------|
| 코드 파일 수정 | 필수 |
| 문서 작성 / Notion 업데이트 | 필수 |
| PR 생성 / 커밋 | 필수 |
| 외부 서비스 API 호출 | 필수 |
| git push | 필수 |

컨펌 없이 진행하지 않는다.

---

## 안전 경계

- 코드 자동 수정 금지 — 계획을 먼저 보여주고 컨펌 후 수정한다.
- `docs/strategy/`, `docs/internal/`, `docs/roadmap-private/`, `profiles/local/` 내용을 출력하거나 타 서비스로 전송하지 않는다.
- 검색 결과(candidate)를 사실(fact)로 단정하지 않는다. 항상 "후보"로 표기한다.
- 외부 MCP/API는 사용자 승인 없이 호출하지 않는다.
- secret, token, 개인 경로를 외부 서비스에 전송하지 않는다.
- Notion, Confluence, Slack, Jira 자동 write는 명시적 컨펌 후에만 한다.

---

## v2 호환 — Manifest Hint Fields

`make work-start`가 생성하는 `context-manifest.yaml`에는 v2 호환용 빈 필드가 포함된다.
**v1에서는 이 필드를 읽기만 하고 실행하지 않는다.**

```yaml
workflow_hint:
  preset: <task_type 기반 keyword 추론 — hint only>
  lenses: []          # v1에서 항상 빈 배열
  tools: []           # v1에서 항상 빈 배열
  note: "Hint only. Not executed in v1."

external_context:
  status: missing | partial | provided
  sources: []         # 사용자가 제공한 경우에만 채워짐
  note: "External context is user-provided only in v1."
```

`preset` 추론 규칙 (keyword 기반, v1):

| keyword | preset |
|---------|--------|
| migration, cutover, dual-write | migration |
| debug, bug, fix, error, crash | bugfix |
| refactor, cleanup, restructure | refactor |
| review, pull request | review |
| doc, notion, confluence, readme, 정리 | documentation |
| handoff, 인수인계 | handoff |
| design, architect, 설계 | architecture_design |
| (기타) | general |

v2에서는 이 필드에 preset 실행, lens 체인, tool routing이 붙는다.

---

## UX 예시

### 예시 1: architecture/design

```
사용자: /work-start dual write 고민중인데 네카라 시니어 실무표준 어케 설계해야할까

AI: 이건 architecture_design 작업으로 분류됩니다.

바로 설계 방향을 드리기 전에 먼저 확인할 게 있습니다.
이 작업과 관련된 기존 자료가 있나요?
- 기존 티켓 / GitHub 이슈
- Confluence / Notion 설계 문서
- 팀 Slack 대화나 회의 결정
- 기존 PR / ADR
- 현재 DB 스키마나 migration plan

있다면 복붙, 파일 경로, 또는 MCP 위치로 주세요. 없으면 "없음"이라고 말씀해주세요.
없어도 진행 가능하지만, 팀이 이미 결정한 제약이나 기존 migration 이력이 빠질 수 있습니다.
```

### 예시 2: documentation

```
사용자: /work-start 하네스 만든거 노션에 정리하고 싶어

AI: 이건 documentation 작업으로 분류됩니다.

정리 기준이 될 외부 자료가 있나요?
- 기존 Notion 페이지 (정리하려는 대상 페이지)
- 희망하는 문서 구조 / 형식
- 회의 메모나 공유한 roadmap 문서
- PR 목록이나 release 기준

있다면 복붙, 파일 경로, 또는 Notion MCP 위치로 주세요. 없으면 "없음"이라고 말씀해주세요.
없으면 repo의 git log, PR 흐름, skills 목록, README 기준으로 초안을 만들겠습니다.
```

```
사용자: 없음

AI: repo 기준으로 진행합니다. 외부 자료가 없으므로 이미 결정된 제약이나 팀 기준이 빠질 수 있습니다.

[git log, PR 목록, skills 목록 확인 후]

## 중간 점검

### 확인된 진행 내역
- v0.5 profile onboarding
- v0.5.1 telemetry fallback
- v0.6 SearchBackend boundary 정리
- internal planning doc guardrail
- private profile skill doctor 안내
- v0.7.1 work-start local MVP

### 빠진 외부 맥락
- 기존 Notion 페이지 구조 미확인
- 정리 형식 / 대상 독자 미확인

### 후보 방향
- 버전/마일스톤 단위 타임라인 구조
- 스킬/커맨드/훅/인프라 레이어별 구조

### 식별된 리스크
- Notion MCP 가용 여부 미확인

어떤 구조로 정리할지, Notion MCP가 연결되어 있는지 확인 후 진행하겠습니다.
```
