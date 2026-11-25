# ohmyai CLI (사용자용 명령 파사드)

사용자가 Makefile·setup.sh 내부를 몰라도 플랫폼을 관리하도록 하는 얇은 명령 계층이다.
공식 이름은 `ohmyai`, 하위 호환 별칭은 `oh-my-ai`다. 두 이름은 같은 진입점
`scripts/oh-my-ai.mjs`와 같은 구현(`scripts/lib/oh-my-ai-facade.mjs`)을 공유한다. 별도 CLI 엔진은 없다.

## 처음 설치 (ohmyai가 아직 없는 환경)

`ohmyai` 명령은 설치 후에야 생긴다. 처음에는 저장소의 스크립트를 직접 실행한다.

```bash
git clone <oh-my-ai 저장소 URL> && cd oh-my-ai
./setup.sh --install-shared --dry-run     # 변경 없이 무엇이 만들어질지 확인
./setup.sh --install-shared               # 적용 (기존 사용자 파일은 덮어쓰지 않는다)
ohmyai status                             # 설치 결과 확인 (또는 node scripts/oh-my-ai.mjs status)
```

- **PATH 확인**: 링크는 `~/.local/bin`(`LOCAL_BIN`으로 변경 가능)에 만들어진다.
  `echo $PATH` 에 이 디렉터리가 없으면 셸 설정(`~/.bashrc`, `~/.zshrc` 등)에 추가하고 새 셸을 연다.
  `ohmyai status` 의 `PATH` 줄이 이 상태를 보여 준다.
- **플랫폼**: `install`, `doctor`, `update --apply`, `status` 의 drift 확인은 bash가 필요하다.
  Windows Native에서는 `UNSUPPORTED`로 종료한다(조용히 실패하지 않는다). **Windows에서는 WSL 안에서 위 절차를 실행한다.**
- `ohmyai doctor` 는 진입점 링크(`ohmyai`, `oh-my-ai`)가 둘 다 없으면 이 부트스트랩 안내를 함께 출력한다.

## 설치 링크

`setup.sh --install-shared` 가 기존 `safe_link` 정책으로 `~/.local/bin/ohmyai` 와
`~/.local/bin/oh-my-ai` 두 링크를 만든다. 기존 사용자 파일은 덮어쓰지 않는다.
`LOCAL_BIN` 환경 변수로 위치를 바꿀 수 있다. 셸 alias에 의존하지 않는다.

## 명령

| 명령 | 하는 일 | 위임 대상 |
|------|---------|-----------|
| `ohmyai version` / `--version` | `VERSION` + git 짧은 SHA(+dirty) | 직접 |
| `ohmyai status [--json]` | 한 화면 요약 (읽기 전용). OK/WARN/FAIL 집계 후 `doctor` 안내 | skill-discovery, merge-runtime-hooks, render-instructions(임시 복사본) |
| `ohmyai doctor [--strict]` | 점검 결과 + 상태별 수정 안내 | `setup.sh --doctor`, `setup.sh --doctor-dev-main-flow` |
| `ohmyai install [--profile N] [--dev-main-flow [--with-handoff] [--with-record-sync] [--with-spec]] [--apply]` | 기본은 dry-run. `--apply` 해야 변경 | `setup.sh --install-shared` / `--install-profile` / `--install-dev-main-flow` |
| `ohmyai update [--ref REF] [--apply]` | `git fetch` 후 기준 ref(기본 `origin/master`)와 비교 | git; `--apply` 시 render + doctor |
| `ohmyai config list|get|set` | 사용자 설정 조회·저장 | 직접 (`config.json`) |
| `ohmyai skills [--core\|--library\|--all] [--json]` | Skill 목록, 출처, explicit-only, 노출 상태 | skill-discovery |
| `ohmyai models status\|validate\|diff\|check\|apply\|rollback` | model policy 위임. `apply`·`rollback`은 `--apply` 필요. `scripts/model-policy.mjs`(#227)가 없으면 status는 "not available" 안내 후 0, 변경 명령은 2 | `scripts/model-policy.mjs` (정책 로직 없음) |
| `ohmyai help` / `--help` / `-h` | 사용법 | 직접 |

내부 명령 `hook`, `context-checkpoint`, `work-start`, `jira-ticket`, `work-view` 는 기존과 바이트 단위로 같게 동작한다.
Hook 설정과 스크립트가 `oh-my-ai <internal>` 형태로 호출하는 경로도 그대로다.

### status 출력 예 (정직성 구간)

저장된 설정 값, 실제 동작, 설치된 것, 이 소스를 구분해서 보여 준다. **저장된 값이 곧 실행된 값은 아니다.**

```
ohmyai status
  version       1.0.0 (git befe8b3, dirty)
  ...
  config        update.policy=AUTO · context.inject=on · preload=0
  -- setting vs effective (저장된 값과 실제 동작은 다를 수 있음) --
  update.policy    AUTO → stored; auto-run NOT IMPLEMENTED (behaves as CHECK)
  context.inject   on → not effective: hooks not installed/other source
  context.preload  [] → not injected (empty list)
  -- installed vs this source --
  entrypoint ohmyai    absent
  entrypoint oh-my-ai  absent
  core links    claude this=0 other=0 absent=11 · codex this=0 other=0 absent=11
  PATH          local bin NOT on PATH (see bootstrap in docs/harness/cli.md)
  -- discovery and guards --
  skill files   11/12 Core present in this source
  discovery     NOT_VERIFIED (requires runtime E2E)
  hook entries  claude configured=incomplete enabled=enabled · codex ... (registration is not protection)
  git-identity  not installed
  checks        OK 3 · WARN 31 · FAIL 0
  next          ohmyai doctor  (details and fix hints)
```

- **설정 vs 실제**: `context.inject=on` 은 설치된 훅이 **이 소스**의 `oh-my-ai` 진입점을 가리킬 때만
  `effective: hook reads config (vX @ HEAD)` 가 된다. 아니면 `not effective`.
  `update.policy=AUTO` 는 항상 `auto-run NOT IMPLEMENTED (behaves as CHECK)` 로 표시한다.
- **설치 vs 이 소스**: 진입점과 Core 링크 대상이 이 체크아웃인지(`this`), 다른 체크아웃인지(`other`, 그 HEAD 포함) 보여 준다.
- **native discovery**: Skill 파일이 소스에 있어도 런타임이 실제로 발견·호출하는지는 확인하지 않는다.
  항상 `NOT_VERIFIED (requires runtime E2E)` 로 출력한다.
- **guard**: 훅 등록은 보호가 켜졌다는 뜻이 아니다. 이 소스에는 git-identity guard가 없으므로 `not installed` 로 출력한다.
  guard가 생기면 그 guard 자체의 doctor로만 `ACTIVE` 를 판정한다.
- `status --json` 에는 같은 내용이 `honesty` 객체로 들어 있다.

- instruction drift: 원본 레포를 쓰지 않는다. 임시 디렉터리에 복사한 뒤 `render-instructions.sh`를 돌리고
  생성물 5개(`CLAUDE.md`, `claude/CLAUDE.md`, `AGENTS.md`, `MINE.md`, `skills/skill-index.json`)를 비교한다.
- runtime 경로: Claude는 `CLAUDE_DIR`(기본 `~/.claude`), Codex 설정은 `CODEX_DIR`(기본 `~/.codex`),
  Codex Skill 루트는 `AGENT_DIR`(기본 `~/.agents`)을 쓴다. `setup.sh`와 같은 규칙이다.
- execution mode: `HARNESS_EXECUTION_MODE` → `HARNESS_PROFILE`의 local profile → 기본 `patch-with-approval` 순서다.

### doctor 수정 안내 매핑

| 상태 | 의미 | 안내 |
|------|------|------|
| stale-source | 이동 전 옛 경로(`skills/<id>`)를 가리키는 링크 | 링크를 직접 제거 후 `ohmyai install --apply` |
| dangling | 대상이 없는 깨진 링크 | 출력의 `rm` 안내대로 제거 후 재설치 |
| legacy-dir-link | skills 디렉터리 전체가 repo 링크 | 직접 제거 후 재설치 |
| conflict / exists-local | 사용자 파일과 충돌 | 설치기는 보존한다. 내용을 확인해 직접 옮기거나 유지 |
| missing | 아직 설치되지 않음 | `ohmyai install --apply` (프로필은 `make init-profile PROFILE=<name>`) |
| incomplete | 구성 요소 미완성 | `ohmyai install --apply` 재실행 |

## update 동작

- CHECK(기본): fetch 후 `ahead / behind / dirty` 를 보고한다. 아무것도 바꾸지 않는다.
- `--apply`: 아래 조건을 모두 만족할 때만 `git merge --ff-only` 를 수행한다.
  - 작업 트리가 clean
  - **기본 브랜치(`master`)이거나, `--ref origin/<현재 브랜치>` 로 그 브랜치를 명시한 경우**.
    다른 브랜치에서 `--ref` 없이 실행하면 거부한다(실수로 feature 브랜치를 옮기지 않도록).
  - **같은 레포의 다른 worktree 중 미커밋 변경이 있는 것이 없음.** 있으면 목록을 보여 주고 거부한다
    (다른 Writer가 작업 중일 수 있다). 현재 worktree는 제외한다.
  - 로컬과 ref가 분기(diverged)되지 않음
  - 실패하면 변경 없이 종료
  - 성공 후 `render-instructions.sh` 와 `setup.sh --doctor` 를 실행한다.
- `--force-worktrees`: 위 worktree 거부를 무시한다. **사람 전용 override다.** 에이전트나 자동화는 이 플래그를 붙이지 않는다.
  사용하면 경고를 출력하고 진행한다.
- merge·rebase·stash는 자동으로 하지 않는다.
- `update.policy=AUTO` 는 설정으로 저장만 된다. 자동으로 실행되는 경로는 아직 없다(status에 NOT IMPLEMENTED로 표시).

## config

- 위치: `${XDG_CONFIG_HOME:-~/.config}/oh-my-ai/config.json`, 권한 0600, 임시 파일 쓰기 후 rename.
- 파일에는 명시적으로 set한 키만 저장한다.

| 키 | 값 | 기본 |
|----|----|------|
| `update.policy` | `OFF` \| `CHECK` \| `AUTO` | `CHECK` |
| `context.inject` | `on` \| `off` | `on` |
| `context.preload` | Core skill id 목록 (`set`은 쉼표 구분, 빈 문자열은 빈 목록) | `[]` |

- 알 수 없는 키나 섹션, 잘못된 값은 거부한다. 깨진 파일은 읽기 단계에서 보고하며 덮어쓰지 않는다.

### 런타임 동작 (Hook 경로)

`UserPromptSubmit` 과 `SessionStart` 가 이 설정을 읽는다. 설정을 읽지 못하면 **기본값(on, preload 없음)** 으로 동작하고
Hook은 항상 exit 0 이다. `SessionStart` 에서만 세션당 한 번 경고 시스템 메시지를 띄우고, `ohmyai status` 가 config FAIL로 보여 준다.

- `context.inject=off` 가 끄는 것 (advisory 문구만):
  - 스킬 후보(`Skill routing candidates`), toil / handoff / PR / project-context 힌트, work-start 제안
  - `SessionStart` 의 `automation-backlog.md` 주입과 `context.preload` 주입
- `context.inject=off` 가 **끄지 않는 것**:
  - **Jira-first 힌트.** 중복 이슈 방지와 Jira Create/Update 승인 경계를 알리는 안전 문구라서 주입 설정으로 끄지 않는다
    (설정이 꺼져도 Jira 생성 승인과 Git Write 승인은 그대로 필요하다).
  - 라우팅·state 쓰기(toil 후보 기록), 실패 진단 문구, 가드, checkpoint 훅, telemetry.
- `context.preload` (Core skill id 목록): `SessionStart` 에 **`id — summary` 한 줄씩** 주입한다. 경로는 줄마다 넣지 않고 헤더 한 번으로 안내하며, id → SKILL.md 는 skill discovery 로 해석한다. 본문은 넣지 않는다.
  - 요약은 60자(말줄임 `…` 포함)로 자른다. 항목을 통째로 빼지 않는다.
  - 바이트 상한 **2048 bytes** (블록 전체, 헤더 포함). 그래도 넘으면 빠진 항목을 `+N more not shown` 한 줄로 명시한다.
  - 측정: Core 12개 전부 = 1471 bytes (상한 이내, 단일 항목 약 120 bytes).
  - `inject=off` 이면 preload도 주입하지 않는다. 소스에 없는 id는 `(missing source; not preloaded)` 로 표시한다.

## Core skill 분류 (단일 원본)

Tier 는 `scripts/lib/skill-discovery.mjs` 가 Skill마다 계산한다. 우선순위:

1. 물리 그룹: `skills/core/<n>/` → core, `skills/library/<n>/` → library (그룹이 이긴다)
2. frontmatter `metadata.tier: core | library`
3. `TRANSITIONAL_CORE_IDS` (과도기 목록, 같은 파일). Skill을 그룹으로 옮기면 이 목록에서 뺀다.

`ohmyai install --apply` 는 shared 설치 뒤 Core 전부를 claude/codex skill 디렉터리에 심볼릭 링크한다.
이미 있는 사용자 파일·디렉터리·옛 링크는 덮어쓰지 않고 `FAIL` 로 보고하며 `PARTIAL` 요약과 exit 1 이 된다.
Library 는 기본으로 링크하지 않고 `--with <id>` 로만 추가한다. `ohmyai update --apply` 는 fast-forward 뒤 render → Core 링크 → doctor 를 같은 방식으로 판정한다.
`batch-report` 처럼 소스가 없는 Core id 는 `missing-source` 로 표시되고 링크되지 않는다.

## 안전 경계

- 파사드는 Hook, guard, 권한 파일을 직접 쓰지 않는다. 쓰기는 `setup.sh`(install/doctor 위임)와 `config.json` 뿐이다.
- `status`, `skills`, `update`(check 모드), `config list/get` 은 읽기 전용이다. 생성물 drift 확인은 임시 복사본에서만 한다.
- `install` 은 기본이 dry-run이다. 기존 사용자 파일과 디렉터리는 `setup.sh` 정책대로 보존된다.
- 설치 경로는 `CLAUDE_DIR`, `CODEX_DIR`, `AGENT_DIR`, `LOCAL_BIN`, `XDG_CONFIG_HOME` 환경 변수로 바꿀 수 있다. 테스트는 모두 임시 디렉터리를 쓴다.

## 플랫폼

- 순수 Node로 구현된 명령: `version`, `status`(drift 제외), `skills`, `config`, `help`.
- `doctor`, `install`, `update --apply`, `status` 의 drift 확인은 bash·sh 가 필요하다.
- Windows Native에서는 해당 명령이 `UNSUPPORTED` 를 출력하고 종료 코드 1로 끝난다. 조용히 실패하지 않는다.
  Windows에서는 WSL을 쓴다.

## 테스트

```bash
make test-oh-my-ai-cli      # scripts/test-oh-my-ai-cli.mjs (임시 HOME/XDG, 로컬 bare 원격, 네트워크 없음)
make test-skill-discovery
make test-routing-fixtures
make test-work-start-fixtures
```

테스트 범위: version, status JSON 필드와 drift 감지(읽기 전용 확인), config 검증과 파일 모드, update check/apply 의
clean·behind·dirty·diverged·fetch 실패 경우, 비기본 브랜치·다른 worktree 거부와 `--force-worktrees`,
install dry-run 무변경과 두 링크 생성, doctor 위임·수정 안내·부트스트랩 안내,
skills 분류, help/--help 동일성, 내부 명령 호환 smoke,
`context.inject=off` (advisory 제거, Jira-first 유지, backlog 제거), `context.preload` 내용과 2048 바이트 상한,
설정 파일 손상 시 기본값 fallback과 exit 0, status의 AUTO 표시와 effective 판정.
