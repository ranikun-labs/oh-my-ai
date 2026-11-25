# ohmyai CLI (사용자용 명령 파사드)

사용자가 Makefile·setup.sh 내부를 몰라도 플랫폼을 관리하도록 하는 얇은 명령 계층이다.
공식 이름은 `ohmyai`, 하위 호환 별칭은 `oh-my-ai`다. 두 이름은 같은 진입점
`scripts/oh-my-ai.mjs`와 같은 구현(`scripts/lib/oh-my-ai-facade.mjs`)을 공유한다. 별도 CLI 엔진은 없다.

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
| `ohmyai help` / `--help` / `-h` | 사용법 | 직접 |

내부 명령 `hook`, `context-checkpoint`, `work-start`, `jira-ticket`, `work-view` 는 기존과 바이트 단위로 같게 동작한다.
Hook 설정과 스크립트가 `oh-my-ai <internal>` 형태로 호출하는 경로도 그대로다.

### status 출력 예

```
ohmyai status
  version       1.0.0 (git befe8b3, dirty)
  source        /path/to/oh-my-ai  branch=wip/cli-facade  dirty=yes
  instructions  OK (generated files match sources)
  policy        execution=patch-with-approval (default)
  runtimes      claude: detected (/root/.claude)  codex: not detected (/root/.codex)
  core skills   claude 0/12 · codex 0/12 (ready/total)
  hooks         claude: incomplete/enabled · codex: incomplete/enabled (configured/enabled)
  entrypoints   ohmyai=absent oh-my-ai=absent
  config        update.policy=CHECK · context.inject=on · preload=0
  checks        OK 3 · WARN 30 · FAIL 0
  next          ohmyai doctor  (details and fix hints)
```

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
  - 로컬과 ref가 분기(diverged)되지 않음
  - 실패하면 변경 없이 종료
  - 성공 후 `render-instructions.sh` 와 `setup.sh --doctor` 를 실행한다.
- merge·rebase·stash는 자동으로 하지 않는다.
- `update.policy=AUTO` 는 설정으로 저장만 된다. 자동으로 실행되는 경로는 아직 없다.

## config

- 위치: `${XDG_CONFIG_HOME:-~/.config}/oh-my-ai/config.json`, 권한 0600, 임시 파일 쓰기 후 rename.
- 파일에는 명시적으로 set한 키만 저장한다.

| 키 | 값 | 기본 |
|----|----|------|
| `update.policy` | `OFF` \| `CHECK` \| `AUTO` | `CHECK` |
| `context.inject` | `on` \| `off` | `on` |
| `context.preload` | Core skill id 목록 (`set`은 쉼표 구분, 빈 문자열은 빈 목록) | `[]` |

- 알 수 없는 키나 섹션, 잘못된 값은 거부한다. 깨진 파일은 읽기 단계에서 보고하며 덮어쓰지 않는다.
- `context.inject=off` 는 컨텍스트 주입만 끈다. **Hook, guard, 권한 계약은 이 설정과 무관하게 그대로 동작한다.**
  이 설정 자체는 아직 주입 경로에 연결되어 있지 않다.

## Core skill 목록 (잠정)

`scripts/lib/oh-my-ai-core-skills.mjs` 의 상수다. 확정된 기준이 없으므로 provisional로 둔다.
`batch-report` 는 이 레포에 없어서 `missing-source` 로 표시된다.

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
clean·behind·dirty·diverged·fetch 실패 경우, install dry-run 무변경과 두 링크 생성, doctor 위임과 수정 안내,
skills 분류, help/--help 동일성, 내부 명령 호환 smoke.
