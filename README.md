# oh-my-ai

Claude Code나 Codex에서 새 작업을 시작할 때마다 프로젝트 배경과 주의사항을 다시 설명하는 일을 줄입니다.

oh-my-ai는 작업을 시작하기 전에 현재 Git Repository의 관련 코드, 문서, 기존 결정, 위험과 누락된 Context 후보를 찾아 사람이 검토할 수 있는 작업 Context 초안을 만듭니다.

**Local-only · Human-reviewed · Claude Code + Codex**

코드를 바로 수정하지 않습니다. 사용자가 초안을 검토하기 전에 다음 작업으로 진행하지 않으며, Worker 생성·실행이나 Merge도 자동으로 수행하지 않습니다.

## 해결하는 문제

- 새 AI 세션마다 프로젝트 배경과 주의사항을 다시 설명해야 합니다.
- 관련 문서나 기존 결정을 놓친 채 코드부터 수정하기 쉽습니다.
- AI가 요청 범위를 넘어 작업하거나 다음 단계를 대신 선택할 수 있습니다.
- 실행한 검증과 실행하지 않은 검증이 섞이면 결과를 신뢰하기 어렵습니다.

## 30초 동작 예시

Claude Code:

```text
/work-start 로그인 실패 메시지를 더 명확하게 바꾸고 싶어
```

Codex:

```text
$work-start 로그인 실패 메시지를 더 명확하게 바꾸고 싶어
```

명시적으로 위 명령을 실행하면:

1. 관련 코드·문서·결정·위험 후보를 탐색합니다.
2. 현재 Repository의 `.oh-my-ai/work-start/...` 아래에 검토용 Candidate를 만듭니다.
3. `Needs human review` 상태에서 멈춥니다.
4. 사용자가 `Gather Context`, `Plan First`, `Direct Handoff` 중 다음 단계를 직접 선택합니다.

이 단계까지 제품 코드는 수정되지 않으며 기본 선택지도 없습니다.

## Requirements

- macOS 또는 Linux
- Bash
- Git
- Make
- Node.js
- Claude Code 또는 Codex

Windows는 Public V1 검증 범위에 포함되지 않습니다. `ripgrep`은 선택 사항이며, 없어도 `grep`으로 제한된 검색을 수행합니다.

## Quick Start

```bash
git clone --branch v1.0.0 \
  https://github.com/aixion1506/oh-my-ai.git \
  ~/Github/oh-my-ai

cd ~/Github/oh-my-ai

make doctor
make install-shared
make doctor-strict
```

### Spec to Implementation Skill

`spec-to-implementation` guides substantial feature and architecture work from requirements and acceptance criteria through Owner approval, implementation, independent review, and a PR gate. It is not intended for simple questions or small fixes.

- **Codex Cloud:** the repository exposes it at `.agents/skills/spec-to-implementation`, linked to the canonical `skills/spec-to-implementation/SKILL.md`.
- **Codex Local:** `make install-shared` links it at `~/.agents/skills/spec-to-implementation`; `make doctor-strict` checks the installed path. Existing user-owned skill paths are preserved and reported as conflicts.
- **ChatGPT Web:** the repository Skill is not automatically loaded. Open the Skill file and paste its “ChatGPT Web 수동 대체 흐름” prompt when needed.

### Optional local completion notifications (macOS first)

The completion notification management commands (`install-completion-notify`,
`completion-notify-status`, `test-completion-notify`, `doctor-completion-notify`,
`uninstall-completion-notify`, and `install`'s optional opt-in) require
**Python 3.11 or newer** (they parse Codex's TOML config with the standard
library `tomllib`). macOS ships `/usr/bin/python3` at 3.9 by default, which
fails a startup check with a clear error instead of installing/removing
anything. If your default `python3` is older than 3.11, install one and pass
it explicitly via the Makefile's `PYTHON` override — no other oh-my-ai command
requires this:

```bash
brew install python@3.11

make install-completion-notify \
  PYTHON="$(brew --prefix python@3.11)/bin/python3.11" \
  ENABLE_COMPLETION_NOTIFY=1
```

`make install` preserves its existing shared-install behavior. Completion Notification
is explicit opt-in only and prompt-free:

```bash
# Shared install only; completion notification is skipped when not opted in
make install

# Explicit opt-in: require literal ENABLE_COMPLETION_NOTIFY=1
make install ENABLE_COMPLETION_NOTIFY=1

# Prompt-free standalone install (requires literal ENABLE_COMPLETION_NOTIFY=1)
make install-completion-notify ENABLE_COMPLETION_NOTIFY=1
```

Running `make install-completion-notify` without `ENABLE_COMPLETION_NOTIFY=1` exits
with code 2 and performs no completion-notification mutation.
Internally, direct installer invocation is non-interactive and requires both
`ENABLE_COMPLETION_NOTIFY=1` and `--yes`; the Make targets pass `--yes` only
after their literal environment-value gate succeeds.

If your default `python3` is older than 3.11, use a 3.11+ interpreter explicitly for
the completion-notification install path:

```bash
make install \
  PYTHON="$(brew --prefix python@3.11)/bin/python3.11" \
  ENABLE_COMPLETION_NOTIFY=1
```

It installs **Codex Turn 완료** and **Claude Turn 완료** notifications. A Turn
notification is not proof that a task, validation, PR, or deployment
succeeded. The title is the fixed runtime allowlist value `Codex Turn 완료` or
`Claude Turn 완료` (`AI Turn 완료` for any unknown runtime); the body is always
`응답이 완료되었습니다. 결과를 확인하세요.` It never includes cwd, project or
path components, assistant-response content, prompts, code, diffs, branches,
Jira keys, terminal output, or secrets.
The Claude adapter never reads or includes assistant-response text in the
shared event; the macOS provider receives no response text from either runtime.

Before changing configuration, the installer shows a preview and backup path,
then applies only on explicit opt-in. Codex's existing `notify` target is preserved as a
bounded asynchronous downstream provider. That provider is a pre-existing
user target and therefore keeps its original Codex event contract. Claude's
`Stop` hook is merged additively and never creates a new downstream for
assistant-response text. Configuration writes are regular-file-only, atomic, permission
scoped, and transactionally rolled back on failure. Any provider failure is
fail-open and cannot block a Turn indefinitely. User-specific commands and
paths live outside this repository under `~/.local/share/oh-my-ai/notifications/`.

```bash
make completion-notify-status
make test-completion-notify
make doctor-completion-notify
make uninstall-completion-notify
```

The current provider is macOS `osascript` only. Linux desktop, SSH, ntfy,
mobile, and cloud notifications are intentionally outside this integration.
The automated fixtures use a disposable HOME and fake providers. Notification
Center delivery remains a separate manual E2E on an explicitly approved Mac.

When creating a PR from a shell, write Markdown through `gh --body-file` or a
single-quoted heredoc. Do not pass Markdown with backticks through a
double-quoted shell argument or an unquoted heredoc, because shell command
substitution can execute an installation example.

- `make doctor`: 기존 설정·Hook·Skill 충돌 가능성을 읽기 전용으로 점검합니다.
- `make install-shared`: 기존 설정을 무단으로 덮어쓰지 않고 공유 Runtime Entry와 Work-start Skill을 설치합니다.
- `make doctor-strict`: 설치된 Runtime Entry, 필수 Hook과 Skill 경계를 엄격하게 검증합니다.

설치는 non-destructive 방식입니다. 같은 이름의 사용자 Skill이나 손상된 설정처럼 자동으로 해결할 수 없는 충돌은 원본을 보존하고 실패로 보고합니다.

이 Quick Start는 `v1.0.0` Stable Tag에 설치를 고정합니다. Git에는 branch 이름 대신 `HEAD (no branch)`가 표시되는데, 이는 현재 설치가 특정 Release Version에 고정되어 `master`의 이후 변경을 자동으로 받지 않는 정상 상태입니다. 새 버전은 자동으로 설치되지 않으며, 이 설치 방식에서는 `make update`를 사용하지 않습니다.

## 업데이트

### Stable Tag 설치

[GitHub Releases](https://github.com/aixion1506/oh-my-ai/releases)에서 새 Stable Tag를 확인한 뒤 해당 버전으로 직접 이동합니다.

```bash
cd ~/Github/oh-my-ai

git fetch --tags --prune
git switch --detach <new-version-tag>

make install-shared
make doctor-strict
```

`<new-version-tag>`는 GitHub Releases에서 확인한 새 Release 번호를 넣는 문법 자리입니다. 이 절차는 자동 Update가 아니며, Tag 이동 후 설치와 엄격 검증을 다시 수행합니다. 기존 사용자 설정은 non-destructive 설치 정책에 따라 보존됩니다.

### Branch-tracking 설치

`make update`는 `master` 같은 Git Branch를 추적하는 개발·검증용 Clone에서만 사용할 수 있습니다. Stable Tag 설치본에서는 사용하지 않습니다.

```bash
make update
make doctor-strict
```

Branch-tracking 설치는 최신 branch 변경을 추적하는 개발용 방식이며, Public Stable Release에 고정된 기본 설치가 아닙니다.

## 첫 실행

설치가 끝나면 **oh-my-ai Source Repository가 아니라 실제로 작업하려는 Git Repository**로 이동합니다.

```bash
cd ~/Github/my-project
```

Claude Code에서:

```text
/work-start 로그인 실패 메시지를 개선해줘
```

Codex에서:

```text
$work-start 로그인 실패 메시지를 개선해줘
```

Work-start는 이처럼 사용자가 명시적으로 호출할 때만 실행됩니다. 자연어 요청만으로 Engine이나 Artifact가 자동 실행·생성되지는 않습니다.

## 생성되는 파일

```text
.oh-my-ai/work-start/<timestamp>-<slug>/
├── handoff-candidate.md
├── starter-prompt.md
├── context-manifest.yaml
├── sources.md
└── context-gap-report.md
```

- `handoff-candidate.md`: 목표·범위·금지사항·위험을 정리한 검토용 작업 계약 초안
- `starter-prompt.md`: 관련 후보와 확인 질문을 담은 검토용 시작 Prompt
- `context-manifest.yaml`: Repository, 검색 상태와 Context 후보를 구조화한 Manifest
- `sources.md`: 탐색에서 참고한 코드·문서 후보 목록
- `context-gap-report.md`: 아직 확인하지 못했거나 추가 입력이 필요한 Context

모든 Candidate는 `Needs human review`로 시작합니다. 검토 후 다른 Claude Code나 Codex 세션에 전달하더라도 복사·붙여넣기와 실행은 사용자가 직접 수행합니다.

## Public V1이 하지 않는 것

- 자동 코드 수정
- 자동 Worker Session 생성·실행
- 자동 Worktree 생성
- 자동 Result 회수
- 자동 승인·Apply·Merge
- 자동 Update·설치·Login
- Prompt, Repository Context나 사용자 코드의 Cloud 전송

전체 범위는 [V1 Non-goals](#v1-non-goals)에서 확인할 수 있습니다.

## Privacy와 Network 요약

- Prompt, Task, Repository 이름·경로, Git Remote, Candidate, Artifact와 사용자 코드는 외부로 전송하지 않습니다.
- 기본 Network 예외는 명시적 Work-start 실행 시 stale Product Notice Manifest를 읽는 비차단 요청입니다.
- Product Notice는 cache-first·next-run·fail-open이며 자동 Update가 아닙니다.
- 원격 Notice 확인은 [opt-out](#notice-opt-outdismiss)할 수 있습니다.

## 상세 문서

- [설치 및 충돌 정책](#설치)
- [Troubleshooting](#troubleshooting)
- [Runtime 검증 범위](#지원-runtime)
- [V1.0.0 Release](https://github.com/aixion1506/oh-my-ai/releases/tag/v1.0.0)
- [V1.0.0 Release verification record](docs/release/v1.0.0.md)
- [Architecture / Design](docs/harness-design.md)
- [V1 Non-goals](#v1-non-goals)
- [License](LICENSE)

## Public V1

### 지원 Runtime

Static Capability 선언은 [`capabilities/runtime-capabilities.json`](capabilities/runtime-capabilities.json)이 canonical source다. `make test-capability-fixtures`가 이 파일의 정합성을 검증한다.

| Runtime | Entry 진입점 | 검증 수준 |
|---|---|---|
| Claude Code | `/work-start <task>` | `advertised_support: true` — 이 세션에서 file.read/file.edit/shell.execute/validation.run을 실제로 사용해 검증 |
| Codex | `$work-start <task>` | `advertised_support: true` — Entry/Hook 계층은 Fixture로 검증됐고, prompt/file.read/file.edit/shell.execute/validation.run/result.freeform은 사용자가 직접 실행한 별도 Codex CLI 세션(`docs/testing/codex-cross-process-e2e.md`)으로 검증됨. 다만 PID·session-id 기반 프로세스 격리 증명이나 자동화된 재현은 아직 없고, session.resume/자동 Session 생성/자동 Result 회수는 여전히 `unknown` |

`unknown`은 "안 되는 것"이 아니라 "아직 이 하네스가 직접 확인하지 않은 것"이다. 검증 안 된 기능을 `supported`로 과장하지 않는다.

### Explicit Work-start Entry

Work-start는 **명시 호출로만** 실행된다. 자연어로 "시작 전에 정리해줘" 같은 요청을 해도 Engine이 자동 실행되지 않는다.

```text
Claude Code: /work-start <task>
Codex:       $work-start <task>
```

설치된 Skill은 공통 Engine 파일을 현재 프로젝트에서 찾지 않는다. 대신 `make install-shared`가 관리하는 `"$HOME/.local/bin/oh-my-ai" work-start -- "<single task argument>"` Public Entry를 호출한다. `--`와 단일 Task argv는 필수이며, Entry는 Task를 재조합하지 않는다. Engine은 oh-my-ai source에서 해석하지만 실행 cwd는 현재 작업 Repository로 유지하므로 Artifact는 항상 현재 Repository의 `.oh-my-ai/work-start/`에 생성된다. source Repository를 옮긴 뒤에는 `make install-shared`를 다시 실행해 managed entry를 갱신한다.

### Natural Suggestion과 실행 동의 차이

자연어 요청이 Work-start와 관련 있어 보이면, prompt hook이 **제안(Suggestion)만** 한다. 이 시점에는:

```text
Engine이 실행되지 않음
Artifact가 생성되지 않음
```

제안은 위 명시 명령을 사용자가 직접 입력해야 실행으로 이어진다. 같은 요청을 거절하면 동일 요청에 대한 재제안은 억제된다.

### Human Review

Work-start Candidate는 항상 `Needs human review` 상태로 시작한다. 사용자가 명시적으로 하나를 선택한다.

```text
Direct Handoff  — 범위가 충분히 명확하면 바로 Worker에게 전달
Plan First      — 먼저 계획을 정리한 뒤 Handoff Candidate에 반영
Gather Context  — 외부 자료를 더 확인한 뒤 재검토
```

기본 선택지는 없다. 시스템이 대신 고르지 않는다.

### Manual Worker Handoff

`handoff-candidate.md`를 검토한 뒤 그 내용을 Worker Session에 **수동으로 복사/붙여넣기**한다. Worker Session은 자동 생성되지 않고, 자동으로 실행되지 않는다.

### Result Return

Worker는 [`templates/result-basic.md`](templates/result-basic.md) 형식으로 결과를 돌려준다. 최소한 다음을 분리해서 기록해야 한다.

```text
Validation Performed / Validation Not Performed
Files Read / Files Changed
Scope Deviations
Remaining Risks
Blocked Reasons (execution_status: blocked일 때만)
```

Result Basic은 **Evidence Candidate**이지 자동 완료 증명이 아니다. 사람이 `not_reviewed → accepted/edited_and_accepted/rejected`로 검토해야 한다. `execution_status: complete`도 Human-approved를 의미하지 않는다.

### Product Notice

Public V1은 향후 V2 출시·보안·호환성 공지를 터미널에서 인지시키는 최소 채널을 갖는다.

```text
명시적 Work-start 실행에만 부수
Cache-first: 표시는 실행 시작 시점 Cache Snapshot으로만 결정
Next-run: 이번 실행에서 새로 받은 공지는 다음 Work-start부터 표시
Fail-open: Notice 실패는 Work-start 결과에 전혀 영향 없음
```

Notice는 자동 Update·자동 설치·자동 Login이 **아니다.**

### Network Behavior

기본적으로 oh-my-ai는 Network를 사용하지 않는다. 유일한 예외:

```text
명시적 Work-start 실행 시
→ Notice Cache가 stale이면
→ https://raw.githubusercontent.com/aixion1506/oh-my-ai/master/notices/manifest.json 에
→ 비차단 one-shot 요청 (최대 2초 Hard Timeout)
```

이 요청은 Prompt·Task·Repository 이름·경로·Candidate·Artifact·코드를 전혀 담지 않는다. 정적 Manifest에 대한 읽기 전용 요청이다.

일반적인 HTTPS 요청 과정에서 Client IP·요청 시각 같은 Network Metadata가 요청 대상 Host에 노출될 수 있다는 점은 축소하지 않고 명시한다. 이는 oh-my-ai가 별도로 수집·전송하는 데이터가 아니라 HTTPS 요청 자체의 일반 속성이다.

```text
Suggestion·Synthetic Event·Worker Session·Result Basic 생성·기본 Doctor·기본 setup.sh
→ Network 호출 없음
```

첫 실행에서 Notice가 반드시 표시되는 것은 아니다 (Cache가 비어 있으므로). 새 Notice는 항상 **다음** Work-start부터 표시된다.

### Notice Opt-out·Dismiss

```bash
node scripts/notice.mjs status        # 현재 Notice/Opt-out 상태 확인
node scripts/notice.mjs dismiss <id>  # 특정 Notice 숨기기
node scripts/notice.mjs opt-out       # 원격 Notice 확인 전체 중단 (Network 호출 자체가 사라짐)
node scripts/notice.mjs opt-in        # 다시 활성화
```

Opt-out 상태에서는 Cache 읽기도, Network 요청도 발생하지 않는다.

### Privacy

```text
전송하지 않음: Prompt, Task, Repository 이름, Git Remote, 작업 경로, Candidate, Artifact, 사용자 코드
전송 대상:     정적 Notice Manifest 요청뿐 (사용자 데이터 없음)
```

사용 측정(harness-event)은 별도 로컬 XDG 로그이며 Git에 커밋되지 않고 외부로 전송되지 않는다. 자세한 내용은 [스킬 사용량 조회](#스킬-사용량-조회) 참고.

### Handoff Example

`handoff-candidate.md`에서 실제로 생성되는 형태(발췌):

```markdown
## Human Review: Choose the Next Step

- [ ] Direct Handoff
- [ ] Plan First
- [ ] Gather Context

Candidate state before selection: Needs human review.
No next step is selected by default, and Work-start does not choose,
recommend, or run any next step automatically.

## Goal
- 로그인 실패 시 에러 메시지를 더 명확하게 바꾸고 싶어

## Allowed Actions
- Needs human review: no Worker action is approved by this Candidate alone.

## Prohibited Actions
- Do not treat this Candidate as Runtime Invocation, Worker auto-creation,
  Session Linking, Managed Task, automatic Result return, automatic Apply,
  or automatic Merge.
```

### Result Example

`templates/result-basic.md`를 따라 실제로 작성된 결과(발췌, 실제 Manual Result Return E2E 실행분 — [`docs/testing/manual-result-return-e2e.md`](docs/testing/manual-result-return-e2e.md) 참고):

```markdown
## Findings
- fixtures/notice/manifests/invalid.json 는 파싱 실패 (의도된 negative fixture, 결함 아님)

## Validation Performed
- 6개 파일 각각을 실제로 JSON.parse로 검사; 결과를 파일별로 개별 기록

## Validation Not Performed
- Schema-level 검증(schema_version, notice 필드 형태)은 이번 작업 범위 밖이라 수행하지 않음
```

### Troubleshooting

| 증상 | 원인 | 조치 |
|---|---|---|
| `make doctor-strict`가 실패함 | 기존에 이미 존재하던 dangling symlink 때문일 수 있음 | `make doctor`(non-strict)로 먼저 원인 확인. 이 하네스가 만들지 않은 기존 링크라면 Host Pre-existing Failure로 취급하고 PASS로 잘못 기록하지 않는다 |
| Work-start가 검색 결과를 못 찾음 | `rg`도 `grep`도 없음 | `content_scan: scan_unavailable`로 정직하게 기록됨(부재 단언 아님). `ripgrep` 설치 권장 |
| Notice가 안 보임 | 정상일 수 있음 | Cache가 비어 있으면 표시 없이 Refresh만 수행. 다음 실행부터 표시됨. `node scripts/notice.mjs status`로 상태 확인 |
| Offline인데 Work-start가 느림/실패함 | Notice Refresh는 2초 Hard Timeout이 있어 정상적으로는 영향 없음 | `node scripts/notice.mjs opt-out`으로 Network 시도 자체를 제거 가능 |

### Doctor / Doctor Strict

```bash
make doctor          # 읽기 전용 점검, 항상 exit 0
make doctor-strict   # 위와 동일한 점검을 하되, 문제 발견 시 exit 0이 아님
```

`doctor-strict`는 CLI, Runtime별 필수 Hook, `work-start` Skill, `harness-event`, Hook 활성화 상태와 설치된 Public Engine Entry를 모두 확인한다. Public Entry가 현재 source의 실행 가능한 `scripts/work-start.sh` 또는 Skill 계약으로 이어지지 않으면 Runtime은 `incomplete`이며 strict는 실패한다. Codex trust 미확인만으로는 strict를 실패시키지 않지만 `/hooks`의 수동 검토는 별도로 필요하다. `doctor-strict`가 실패해도 원인이 이 레포가 만들지 않은 기존 dangling link라면, 그 실패는 이 레포의 결함이 아니라 Host Pre-existing 상태다. `make doctor`로 원인을 먼저 구분한다.

정상 설치의 Runtime 상태는 `configured`다. `disableAllHooks: true`(Claude) 또는 `~/.codex/config.toml`의 `[features] hooks = false`(Codex)는 정의된 Hook을 실행하지 않으므로 `incomplete`와 non-zero로 처리하며, 설치기는 해당 사용자 설정을 자동 변경하지 않는다. Codex는 CLI에서 Hook trust를 신뢰성 있게 읽을 수 없어 `trust: unverified`로 표시한다. 설치 후 Codex `/hooks`에서 Hook을 직접 검토·승인해야 한다.

### Release Notes

```text
VERSION      = 현재 제품 Runtime Version Source (Network 없이 읽음)
```

현재 Public V1 Runtime Version은 `1.0.0`이다.

Public Stable Release Tag는 `v1.0.0`처럼 SemVer-clean 형식을 쓴다. 설명은 Tag 접미사가 아니라 GitHub Release Title/Notes에 적는다.

- [V1.0.0 Release](https://github.com/aixion1506/oh-my-ai/releases/tag/v1.0.0)
- [V1.0.0 Release verification record](docs/release/v1.0.0.md)

### License

Community V1 Repository의 코드와 문서는 [Apache License 2.0](LICENSE)(`Apache-2.0`)으로 배포된다. Copyright 2026 박성환.

이 License는 이 Repository에 공개된 Community V1 Work에 적용된다. 별도 V2 Hosted Service의 가격·운영·상용 제공 조건을 정의하지 않는다.

### V2 Boundary

V2는 독립 CLI + Login + Device 인증 + Cloud Control Plane이다. V1에는 전혀 포함되지 않는다. V1 사용자는 V2가 출시된 뒤에도 로그인 없이 V1 무료 기능을 계속 쓸 수 있다.

### V1 Non-goals

```text
Cloud Account / Auth / Billing / Entitlement
자동 Update / 자동 설치 / 자동 Login
자동 Worker Session 생성 / Session Linking
Result 자동 회수 / 자동 승인
Managed Task ID / Task Registry
Runtime Invocation (자동 실행)
Worktree 자동 생성
Organization Governance
Telemetry / Analytics / Push Notification
상주 Daemon / Scheduler / OS Service
```

<details>
<summary><strong>Architecture Vision과 Repository 내부 구조 (Roadmap)</strong></summary>

## Architecture Vision (Roadmap)

> Public V1은 위 Manual Artifact Workflow가 전부다. 아래는 장기 방향성이며, 현재 자동 Agent orchestration이나 자동 Worker 실행을 제공한다는 뜻이 아니다.

oh-my-ai는 장기적으로 하나의 AI agent가 아니라, 여러 런타임과 도구를 붙였다 떼는 **control plane / orchestration harness**를 지향한다. 원칙·컨텍스트·스킬·안전 정책·작업 라우팅은 oh-my-ai에 남기고, Claude Code/Codex/OpenClone 같은 실행 표면은 adapter로 연결하는 구조다. Jikji, Superpowers, MCP, `rg`/`find`, `rsync` 같은 외부 도구도 필요하면 optional backend/adapter로 붙일 수 있다. 좋은 도구가 나오면 모듈처럼 붙이고, 마음에 안 들면 교체한다. 특정 모델·런타임·도구가 아니라 **사용자 워크플로 레이어**가 본체라는 게 이 비전의 핵심이다.

이 방향에서 이미 동작 중인 조각들(Public V1과 별개로, oh-my-ai 자신을 관리하는 메타 레이어):

- **감지 + 컨펌 게이트**: 반복·수작업·실수 잦은 절차가 보이면 AI가 "이거 자동화할까?" 넛지 → **컨펌해야** 커맨드/스킬로 구조화한다 (안 누르면 안 만듦). (`skills/harness-automation`, `automation-backlog.md`)
- **작업 라우팅**: 작업을 시작하면 그 도메인에 맞는 스킬·커맨드·문서가 자동으로 붙는다. (`instructions/harness.md`의 라우팅 표)
- **경험 누적 = 커스텀 파생 스킬**: 외부 스킬을 베이스로 사용자 경험·context를 얹어 profile/local workflow에 맞게 키운다.
- **세션이 끊겨도 이어짐**: 작업 맥락(결정·설계 배경)을 `docs/context/`에 남겨, 새 세션·다른 날에도 이어받는다. (`skills/project-context`)
- **사용 측정**: 어떤 스킬을 실제 쓰는지 Git 저장소 정보와 함께 **oh-my-ai XDG state**에 기록한다 (`~/.local/state/oh-my-ai/harness-usage.log`). 개인 계정 정책이나 push guard는 profile/private script로 분리한다.
- **목적 위주 표현 원칙**: 커밋·일일보고·문서를 "무엇을 했나"가 아니라 "왜/무엇을 위해"로 쓴다.
- **커스텀 산출물 인덱스**: 커스텀 산출물만 모아 한눈에 → [`MINE.md`](MINE.md)

이 메타 레이어의 핵심 기능:

| 기능 | 설명 |
|------|------|
| Runtime adapters | Claude Code, Codex 등 런타임별 instruction을 공통 원본에서 생성한다 |
| Skill routing | 작업 유형에 맞는 스킬·플레이북을 연결하고, 두꺼운 절차는 필요할 때만 로드한다 |
| Project context | 설계 배경·결정 로그·파일 맵·핸드오프를 `docs/context/`에 축적한다 |
| Human-gated automation | 반복 작업을 감지하되, 사람이 승인해야 스킬·커맨드·스크립트로 굳힌다 |
| Profile/local guards | 개인별 계정·커밋 정책은 profile, local hook, private script로 분리하고 기본 설치에서는 활성화하지 않는다 |
| Execution modes | `suggest-only`, `patch-with-approval`, `auto-apply`로 파일 수정 방식을 선택한다 |
| Usage observability | 스킬 사용을 저장소 단위로 기록해 죽은 스킬은 정리하고 자주 쓰는 흐름은 강화한다 |
| Instruction cascade | `SKILL.md` 메타데이터에서 `AGENTS.md`, `CLAUDE.md`, `MINE.md`를 생성한다 |
| Optional backends | Jikji, Superpowers, MCP, `rg`/`find`, `rsync` 같은 도구를 필요할 때 adapter/backend로 붙인다 |

### 설계 원칙 (다른 dotfiles와 다른 점)

- **런타임 비속박**: 공유 규칙의 근원은 `instructions/harness.md`이고, `CLAUDE.md`, `claude/CLAUDE.md`, `AGENTS.md`는 AI별 adapter로 생성된다. 특정 모델·런타임·도구에 묶이지 않는다. Claude Code/Codex/OpenClone 같은 런타임과 Jikji/Superpowers/MCP/`rg`/`find`/`rsync` 같은 도구는 backend/adapter로 느슨하게 붙이고, 성능·취향·안전 기준에 따라 갈아끼운다. 레이어는 유지한다.
- **사람이 고삐 (human-gate)**: 회사 코드를 다루므로 AI에 전권을 주지 않는다. 도구는 제안·보조하고, **실행 결정은 사람이** 내린다.

개념 구조:

```text
oh-my-ai (Shared AI Agent Control Plane / Orchestration Harness — Vision)
├─ source of truth: instructions / context docs / skills / safety policy / routing
├─ implemented adapters: Claude Code, Codex
├─ implemented tools: hooks, harness-event, rg/find-based local inspection
└─ optional backend candidates: Jikji, Superpowers, MCP, rsync, other agent runtimes
```

> 설계·결정·현황 전체는 [`docs/harness-design.md`](docs/harness-design.md) (단일 기준점).

### 왜 만들었나

AI coding tool을 쓰다 보면 사용자별 스타일·자주 쓰는 스킬·커맨드, 그리고 **작업 맥락(결정·설계 배경)** 이 쌓인다. 이게 `~/.claude/` 나 한 세션 안에만 있으면:

- 컴퓨터가 여러 대면 매번 세팅 다시 해야 함
- devcontainer 열 때마다 초기화됨
- **세션·머신이 바뀌면 맥락이 날아가 같은 설명을 또 하게 됨**
- 어딘가에서 바꾼 내용이 다른 곳엔 없음

1차 목적은 설정과 맥락을 git으로 한 곳에 모아 **어디서든·언제든 같은 환경 + 컨텍스트**가 유지되게 하는 것.

근데 단순 동기화에서 멈추지 않는다 — **반복 작업을 AI가 감지해 제안하고, 사용자가 컨펌해 커스텀 도구(스킬·커맨드·스크립트·훅)로 쌓는다.** 다른 dotfiles/설정 모음과 달리, **도구를 제안받아 사람이 게이트하며 사용자 워크플로에 맞춰 쌓이는 레이어**다.

### 뭐가 편해지나

| 상황 | 기존 | 이후 |
|------|------|------|
| 새 컴 세팅 | AI별 설정 수동 세팅 | `make doctor`로 충돌 확인 후 `make install-shared` |
| devcontainer | AI별 설정 없음 | VS Code Dotfiles로 자동 적용 |
| 설정 수정 | 머신별로 따로 | Branch-tracking 개발 Clone에서 수정 → `git push` → `make update` |
| 스킬 추가 | 해당 머신에만 존재 | `git push`하면 다른 머신에도 동기화 |

### 구조

```text
instructions/
  harness.md             ← 공유 표현 원칙·품질 기준·작업 라우팅·자동화 트리거의 원본
  execution-policy.md    ← 파일 수정 방식 선택을 위한 execution mode 정책
  mine.md                ← 커스텀 산출물 인덱스 템플릿
  adapters/
    claude.md            ← Claude Code용 adapter header
    codex.md             ← Codex용 adapter header
CLAUDE.md                ← Claude가 루트에서 읽는 생성물 (make instructions로 재생성)
AGENTS.md                ← Codex가 루트에서 읽는 생성물 (make instructions로 재생성)
automation-backlog.md    ← 공용 자동화 후보 누적장
MINE.md                  ← SKILL.md 메타데이터로 생성되는 커스텀 산출물 인덱스
skills/
  ...                    ← 공유 가능한 custom skill 원본 (harness-automation, project-context …)
claude/
  CLAUDE.md              ← ~/.claude/CLAUDE.md로 연결되는 Claude 생성물
  settings.json          ← 플러그인 설정 + 훅(SessionStart 주입 / 사용 측정)
  hooks/                 ← 공유 훅 스크립트
  agents/                ← 커스텀 에이전트
scripts/
  render-instructions.sh ← 스킬 메타데이터로 라우팅·MINE·AI별 instruction 생성
  oh-my-ai.mjs           ← 런타임 훅의 전역 진입점
  harness-event.mjs      ← 런타임 중립 SkillStart 기록·저장소별 집계
  cascade-check.sh       ← 비스킬 산출물 등록 drift 검사
hooks/
  pre-commit             ← 하네스 원본 변경 시 파생 산출물 자동 재생성
profiles/
  example/PROFILE.md     ← 개인 profile 템플릿
  example/*.example      ← 개인 helper/local hook 예시 템플릿
  local/                 ← 커밋하지 않는 실제 개인 profile/private script 위치
docs/
  harness-design.md      ← 하네스 설계·결정·현황 (단일 기준점)
  devcontainer-workflow.md ← oh-my-ai/심링크 워크플로 상세
```

</details>

## 스킬 사용량 조회

공용 로그는 Git에 커밋하지 않고 `${XDG_STATE_HOME:-$HOME/.local/state}/oh-my-ai/harness-usage.log`에 JSONL로 저장한다. Codex sandbox 등에서 global state 기록이 막히면 `.oh-my-ai/state/harness-usage.log`에 repo-local ignored state로 fallback한다.

```bash
harness-event report                                      # 현재 Git 저장소
harness-event report --all                                # 전체 저장소
harness-event report --repo github.com/aixion1506/oh-my-ai
harness-event report --since-days 30
```

## 설치

### 실제 머신 (심링크 방식)

Quick Start의 clone + `make install-shared`(`make install`은 동일 동작의 별칭)가 기본 흐름이다. `make doctor`는 읽기 전용이며 기존 스킬·설정·훅을 바꾸지 않는다.

```bash
make doctor
```

공유 core 설치는 opt-in이고 **non-destructive**다. 기존 settings/hooks가 유효 JSON이면 oh-my-ai 관리 Hook만 additive merge하고, 기존 `~/.claude/skills`·`~/.agents/skills`는 대체하지 않으며 `work-start`만 개별 연결한다. 공백, 안전한 double-quote 차이, 이전 direct entrypoint는 같은 관리 operation으로 정리하지만, 단순히 `oh-my-ai`라는 문자열만 포함한 사용자 Hook은 보존한다. 같은 이름의 사용자 Skill 또는 손상 JSON은 자동으로 바꾸지 않고 `conflict`/`incomplete`로 종료된다.

```bash
make install-shared
```

개인 profile은 별도 opt-in이다. 공유 예시는 `profiles/example/`에 두고, 실제 개인 profile은 커밋하지 않는 `profiles/local/<name>/`에 둔다. 기존 스킬과 자동 병합하지 않으므로 충돌 시 수동으로 비교·병합한다.

```bash
make install-profile PROFILE=<name>
```

공유 규칙은 `instructions/harness.md` 또는 `instructions/execution-policy.md`를 수정한 뒤 `make instructions`로 재생성한다. 공유 템플릿 릴리스 기준점은 충돌 방지 정책까지 포함된 `v0.3.0-shared-template` 이후로 본다.

### 검색 backend (ripgrep은 optional)

`ripgrep`(`rg`)은 **필수가 아니다.** Work-start의 문서·코드·Decision·Risk 검색은 backend를 감지해 단계적으로 degrade하고, 감지 결과를 artifact에 그대로 기록한다.

| PATH 상태 | backend | artifact 기록 | 동작 |
|-----------|---------|---------------|------|
| `rg` 있음 | `rg` | `degraded: false`, `content_scan: scanned` | 전체 정밀 검색 |
| `rg` 없고 `grep` 있음 | `grep` | `degraded: true`, `content_scan: scanned` | fallback 검색. 제외 규칙이 거칠고 스캔 파일 수에 상한이 있어 일부 후보를 놓칠 수 있다 |
| 둘 다 없음 | `none` | `content_scan: scan_unavailable` | 내용 검색을 수행하지 않는다 |

**Truthfulness 계약**: 검색을 수행하지 못한 상태는 후보가 없는 상태와 다르다. backend가 `none`이면 Work-start는 "No decision candidates were found" 같은 부재 단언을 출력하지 않고 `scan unavailable`로 기록한다. 세 경우 모두 exit 0으로 완료된다.

`rg` 유무는 `context-manifest.yaml`의 `search:` 블록과 `context-gap-report.md`의 `## Search Backend Status`에서 확인한다. 정밀 검색이 필요하면 `ripgrep`을 직접 설치한다. 이 레포는 `rg` 바이너리를 번들하지 않는다.

### 설치 정책

- shared 설치는 non-destructive다. 기존 설정에는 관리 Hook만 additive merge하고, 기존 Skill 디렉터리는 보존한 채 `work-start`만 개별 연결한다.
- Hook 병합은 유효 JSON을 임시 파일에 완성한 뒤 atomic replace한다. 손상 JSON 또는 충돌 경로는 원본을 보존하고 성공으로 처리하지 않는다.
- 설치와 fixture는 Node 표준 라이브러리만 사용해 macOS와 Linux에서 같은 파일·symlink·byte hash 검사를 수행한다.
- Codex trust는 자동 검증하거나 우회하지 않는다. `configured` 뒤에도 Codex `/hooks`에서 직접 trust 상태를 확인한다.
- 런타임 훅은 설정 파일 위치를 레포 위치로 추측하지 않고, `~/.local/bin/oh-my-ai` 진입점을 호출한다.
- `make doctor`는 현재 링크/로컬 파일 상태를 읽기 전용으로 보여준다.
- 개인 profile은 opt-in이다. 실제 profile/private script는 `profiles/local/<name>/`에 두고 커밋하지 않는다.
- profile script를 설치하려면 `make install-profile PROFILE=<name>`을 사용한다. profile hook/settings는 자동 활성화하지 않고 직접 병합한다.
- 선택적 Claude plugin/settings 예시는 `profiles/example/claude-settings.json.example`에서 확인하고, 필요한 항목만 사용자가 직접 opt-in해 병합한다.

업데이트 방식은 설치 유형에 따라 다르다. Stable Tag 설치는 새 Tag로 직접 이동하고, `make update`는 Branch-tracking 개발 Clone에서만 사용한다. 자세한 명령은 [업데이트](#업데이트)를 따른다.

### Local skills policy

`skills/*`는 이 shared repo에 커밋해도 되는 공유/custom skill 원본으로 간주한다. 개인 장비·회사 계정·비공개 워크플로에 묶인 local skill은 shared repo에 넣지 않고 `~/.claude/skills`, `~/.agents/skills`, 별도 private repo, 또는 private plugin으로 관리한다.

기존 `~/.claude/skills`와 `~/.agents/skills`는 디렉터리 단위로 대체하지 않는다. `make install-shared`는 `work-start`만 개별 연결하고, 같은 이름의 local Skill은 보존한 채 conflict를 보고한다. `make doctor`는 현재 runtime readiness와 충돌을 읽기 전용으로 보여준다.

기존 local skills와 shared skills를 동시에 쓰고 싶다면 자동 병합에 의존하지 말고 다음 중 하나를 수동으로 고른다.

- 기존 local skills를 유지하고 필요한 shared skill만 직접 복사한다.
- 기존 local skills를 백업한 뒤 shared `skills/` symlink로 전환한다.
- private repo/plugin에 개인 skill을 두고 런타임별 설정에서 명시적으로 연결한다.

### Execution Mode 선택

기본값은 `patch-with-approval`이다. 전체 정의는 `instructions/execution-policy.md`를 본다.

| Mode | 동작 |
|------|------|
| `suggest-only` | 파일을 직접 수정하지 않고 변경 전/후, diff, patch, 명령어만 제시 |
| `patch-with-approval` | 변경 계획과 diff를 먼저 제시하고 승인 후 수정 |
| `auto-apply` | 명시된 범위 안에서 직접 수정하고 검증 결과와 남은 리스크 보고 |

로컬에서 override하려면 `.env.local` 또는 private profile에 둔다.

```bash
HARNESS_EXECUTION_MODE=patch-with-approval
```

### devcontainer (복사 방식)

VS Code Settings (JSON)에 한 번만 추가:

```json
"dotfiles.repository": "https://github.com/aixion1506/oh-my-ai",
"dotfiles.installCommand": "setup.sh"
```

이후 새 devcontainer 뜰 때마다 VS Code가 자동으로 레포 clone + `setup.sh` 실행. 기본 `setup.sh`는 non-destructive shared install로 관리 Hook만 additive merge하고 `work-start`만 개별 설치한다. 기존 다른 settings, hooks, skills는 보존한다.

### devcontainer (심링크 방식)

복사 방식은 스킬/커맨드 수정이 레포에 바로 반영되지 않음. 실제 머신처럼 심링크를 유지하고 싶다면 별도 가이드 참고.

→ [docs/devcontainer-symlink.md](docs/devcontainer-symlink.md)

## Optional workflow skills

일부 born-here 스킬은 shared core가 아니라 특정 업무 도구를 쓰는 사용자를 위한 optional workflow다. 기본 라우팅에는 노출하지 않고, 필요한 사용자가 스킬 이름으로 직접 호출한다.

| Skill | 필요한 context | 용도 |
|------|----------------|------|
| `daily-report` | Slack daily report, optional Notion worklog/Todo | 오늘 한 일을 프로젝트별 진척률과 함께 일일보고로 정리 |
| `worklog-note` | Notion or similar worklog/Todo workspace | 장황한 업무일지·Todo·회의 메모를 스캔 가능하게 정리 |
| `release-note` | Jira fixVersion/release-report, optional Confluence page | Jira 릴리즈 이슈를 사용자 체감 릴리즈 노트로 정리 |

이 스킬들은 삭제하지 않는다. Slack/Notion/Jira/Confluence를 쓰지 않는 사용자에게 기본값처럼 보이지 않도록 `metadata.route`만 제거한다.

## 스킬/커맨드/에이전트 추가

커스텀 스킬은 `SKILL.md` frontmatter에 `source`, `summary`, 필요시 `route`를 한 번만 작성한다. `make instructions`가 라우팅 표와 `MINE.md`를 생성한다.

기존 `~/.claude/skills`나 `~/.agents/skills`가 있어도 core `work-start`는 개별 설치한다. 그 밖의 shared skill은 자동 병합하지 않으므로, 필요하면 `make doctor` 결과를 보고 직접 연결 방식을 결정한다. 커밋·푸시 전 현재 `remote`, `branch`, `author`, GitHub 인증 계정을 확인한다. 특정 계정 전환 스크립트나 push guard가 필요하면 `profiles/local/` 아래 개인 profile 또는 레포 밖 private script로 분리해서 운영한다.
