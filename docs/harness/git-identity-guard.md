# Git Identity Guard (Slice 2)

## 목적

회사 GitHub 계정과 개인 GitHub 계정이 한 커밋·한 push에 섞이는 **실수**를 막는다.
이 가드는 실수 차단기(mistake blocker)다. 우회를 막는 통제(bypass-proof control)가 아니다.
고의 우회, `--no-verify`, 다른 클라이언트에서의 push는 막지 못한다.

Slice 1 (정책 resolver, doctor, 네이티브 git hook)에 이어 Slice 2는 다음을 더한다.
- 환경 변수 우회 차단 (매핑 파일이 명시적으로 허용해야만 env override가 적용된다)
- Claude PreToolUse 런타임 어댑터 (우회 명령 deny, 매핑된 repo의 AI push fail-closed)
- 계정별 `gh` 인증 분리 (`gh-env`, 전역 `gh auth switch` 금지)
- 신원 증명 (`prove`, opt-in 네트워크)
- 네이티브 hook 실행 검증 (실제 `git commit`/`--amend`/`cherry-pick`/`rebase`/`push`)

## 구성 레이어

| 레이어 | 위치 | 책임 |
|--------|------|------|
| 정책 (pure) | `scripts/lib/git-identity-policy.mjs` | 매핑 검증, remote 정규화, 판정, env override 규칙, 신원 증명 파서 |
| CLI | `scripts/git-identity-guard.mjs` | `doctor`, `pre-commit`, `pre-push`, `gh-env`, `prove` |
| 네이티브 hook 래퍼 (opt-in) | `hooks/git-identity/pre-commit`, `pre-push` | `git`이 호출하는 진입점. `core.hooksPath`로 연결 |
| 런타임 어댑터 (Claude, 예시 wiring) | `scripts/git-identity-runtime-guard.mjs` | PreToolUse(Bash) deny 판정. 설치는 아님 |
| 런타임 wiring 예시 | `profiles/example/claude-settings.git-identity.json.example` | `hooks.PreToolUse` 스니펫. `claude/settings.json`은 건드리지 않음 |
| Private 정책 (ai-instructions 등) | 레포 밖 | 어떤 계정 조합을 허용할지에 대한 상위 정책 |
| Private 매핑 | `$XDG_CONFIG_HOME/oh-my-ai/git-identity.json` (기본 `~/.config/...`) | 실제 remote ↔ 계정 매핑. 레포에 커밋하지 않는다 |

매핑 값은 설정(config)이다. 상태(state)가 아니므로 `docs/harness/user-local-state.md`의
state root에 두지 않는다.

## 설정 파일

스키마 v1. 예시는 `profiles/example/git-identity.json.example`을 복사해 placeholder를 채운다.

```json
{
  "schema_version": 1,
  "allow_env_overrides": false,
  "rules": [
    {
      "match": "github.com/<work-org>/*",
      "author_email": "<work-author-email>",
      "author_name": "<work-author-name>",
      "github_user": "<work-github-user>",
      "ssh_host_alias": "github-work",
      "preserve_author_emails": []
    }
  ]
}
```

- 전역 기본 규칙은 없다. 매핑되지 않은 remote는 pre-commit에서 경고만 하고, pre-push에서는 차단된다.
- `match`는 `host/owner/*` 또는 `host/owner/repo`. 대소문자를 구분하지 않는다. 더 구체적인 규칙이 이긴다 (exact repo > owner/*).
- `ssh_host_alias`는 `~/.ssh/config`의 Host 별칭이다 (아래 "remote 정규화와 alias").
- `preserve_author_emails`는 cherry-pick/rebase로 보존된 원작성자 이메일 목록이다.
- `allow_env_overrides`(기본 `false`)는 env override를 허용할지 정한다 (아래 "환경 변수").

## 환경 변수 (Slice 2 변경: AI가 env로 우회할 수 없게)

이전 슬라이스는 `OH_MY_AI_GIT_IDENTITY_CONFIG`, `_REMOTE`, `_ALLOW_UNVERIFIED_BINDING=1`을
env 한 줄로 쓸 수 있었다. AI 에이전트가 Bash로 env를 설정할 수 있으므로 이는 우회 경로였다.

| 변수 | 동작 |
|------|------|
| `OH_MY_AI_GIT_IDENTITY_CONFIG` | 기본 매핑 파일이 `"allow_env_overrides": true`일 때만 적용 (`APPLIED`). 아니면 무시하고 `IGNORED`로 보고. 기본 매핑이 없으면 env로 대체하지 않는다 (fail closed) |
| `OH_MY_AI_GIT_IDENTITY_REMOTE` | 같은 규칙. 허용되지 않으면 `origin`을 본다 |
| `OH_MY_AI_GIT_IDENTITY_ALLOW_UNVERIFIED_BINDING` | **env로는 더 이상 통과하지 않는다.** 설정돼 있으면 notice만 출력한다 |

### 왜 이렇게 설계했나

- 기본 매핑 파일을 **유일한 권한 원천**으로 둔다. env는 그 파일이 열어준 범위에서만 쓰인다.
  env만으로는 "더 느슨한 매핑 파일"을 가리킬 수 없다.
- `allow_env_overrides`를 매핑 파일 안에 둔 이유: 테스트나 다른 매핑을 쓰려는 사람이 명시적으로 켜야 한다는 것을 파일 자체에 남긴다.
  기본 `false`라서 기존 사용자는 env를 쓰던 경우 `CONFIG_MISSING`으로 드러난다 (조용히 우회되지 않는다).
- 테스트는 env 경로 대신 임시 `XDG_CONFIG_HOME` 아래 기본 위치에 매핑을 쓴다. 테스트 전용 env 경로는 두지 않았다.

### 사람 전용 override (unverified binding)

`UNVERIFIED_BINDING`(설정상 계정 연결을 증명할 수 없음)은 사람만 풀 수 있다.
pre-push가 `/dev/tty`에 직접 묻고, 사용자가 규칙 match 문자열을 **정확히** 입력해야 통과한다.

- 선택 이유: 비대화형 프로세스(에이전트의 Bash 도구, CI, 분리된 자식 프로세스)는 controlling terminal이 없어 `/dev/tty`를 열 수 없다. 따라서 env나 stdin으로는 답할 수 없다.
- 한계: 에이전트가 pty를 만들 수 있다면(`script` 등) 답할 수 있다. 런타임 어댑터는 `script`로 git을 감싸는 명령을 잡지 않는다 (아래 NOT covered).
- 옵션으로 검토한 one-shot 토큰 파일은 에이전트도 파일을 쓸 수 있어서 기각했다.

## remote 정규화와 alias

- 지원 형식: `https://`, `http://`, `ssh://`, scp형 `[user@]host:owner/repo`.
- 정규화 결과는 `host/owner/repo` (소문자, 포트·사용자·자격증명·`.git` 제거). 자격증명은 저장하거나 출력하지 않는다.
- 로컬 경로와 `file://`은 정규화되지 않는다 (UNMAPPED).
- **alias 해석**: ssh 형식의 remote host가 어떤 규칙의 `ssh_host_alias`와 같으면, 그 규칙들만 후보가 되고 canonical host는 규칙의 `match` host가 된다. 다른 규칙으로 떨어지지 않는다.
- `git remote get-url`과 pre-push 인자는 `url.<base>.insteadOf`가 적용된 URL이다 (실험으로 확인). 그래서 네이티브 hook과 런타임 어댑터가 같은 URL을 본다.

## 판정

- **binding (push 대상 계정 연결)**: `VERIFIED_CONFIG`는 remote가 규칙의 ssh alias를 쓰거나, `git config --get-urlmatch credential.username <url>` 값이 `github_user`와 같을 때다. 그 밖은 `UNVERIFIED_BINDING`.
  - **이것은 설정 일치 검사이지 인증 증명이 아니다.** 실제 증명은 `prove`가 담당한다.
- **commit 판정**: committer 이메일은 반드시 규칙의 `author_email`과 같아야 한다. author 이메일은 `author_email` 또는 `preserve_author_emails` 중 하나여야 한다. 이름은 판정에 쓰지 않는다.
- pre-push는 `git rev-list <local> --not --remotes=<remote-name>`로 push될 커밋만 검사한다. 새 브랜치(원격 sha가 0)는 도달 가능한 전체 범위를 검사한다. 삭제(local sha가 0)는 검사하지 않는다.

## 런타임 어댑터 (Claude PreToolUse, 예시 wiring)

`scripts/git-identity-runtime-guard.mjs`는 Claude Code PreToolUse(matcher `Bash`) hook JSON을 stdin으로 받는다.
deny면 `hookSpecificOutput.permissionDecision: "deny"`를 출력하고, 아니면 아무것도 출력하지 않는다.

| 규칙 | 코드 | 비고 |
|------|------|------|
| `--no-verify` (git 토큰, 또는 중첩 셸 안) | `NO_VERIFY` | `git commit -n`은 `COMMIT_NO_VERIFY` (짧은 옵션 묶음 포함, `-m` 값 제외) |
| `git -c core.hooksPath=...`, `core.hooksPath=` 텍스트 | `HOOKSPATH_OVERRIDE`, `CONFIG_OVERRIDE` | `-c user.*`/`author.*`/`committer.*`도 deny |
| `git config core.hooksPath <v>`, `--unset` | `HOOKSPATH_CONFIG_WRITE` | 읽기(`--get`, `--list`)는 통과 |
| `git config --global/--system` 쓰기 | `GLOBAL_CONFIG_WRITE` | 읽기는 통과 |
| `gh auth switch`, `gh auth login` | `GH_AUTH_SWITCH_OR_LOGIN` | |
| `OH_MY_AI_GIT_IDENTITY_*=` 설정 | `SET_GUARD_ENV` | 토큰 단위, `export`/prefix 모두 |
| `GIT_AUTHOR_*`, `GIT_COMMITTER_*` override | `IDENTITY_ENV_OVERRIDE` | |
| `GIT_CONFIG_COUNT/KEY_n/VALUE_n/PARAMETERS/GLOBAL` | `CONFIG_ENV_OVERRIDE` | config 우회 경로 |
| 매핑된 repo에서 `git push`, `gh pr create|merge`, `gh api` 쓰기(POST/PATCH/PUT/DELETE, 또는 `-f`/`-F` 필드) | `NATIVE_GUARD_INACTIVE` | 네이티브 hook(pre-commit+pre-push)이 ACTIVE가 아니면 deny. fail-closed |
| 매핑 파일이 깨짐 + push/gh 쓰기 | `CONFIG_INVALID` | 매핑 파일이 **없으면** 가드 미사용으로 보고 통과 |
| hook 입력 JSON 파싱 실패 | `HOOK_INPUT_UNPARSEABLE` | fail-closed |

- `cd <dir>`와 `git -C <dir>`는 추적한다. `git push`의 대상 remote는 인자 이름 또는 URL로 판단한다.
- 읽기 전용 명령(`git status`, `git log`, `git diff`, `git config --get`, `gh pr view`, `gh api` GET)은 통과한다.
- **문자열 매칭은 실수 차단기이지 보안 경계가 아니다.** 셸 간접 참조(변수, `eval`, 별칭, 스크립트 파일, 중첩 따옴표 깊은 곳), 다른 도구(MCP, 웹 UI), 매핑 파일 편집으로 우회된다.
- 설치 방법: `profiles/example/claude-settings.git-identity.json.example`의 `hooks.PreToolUse`를 본인 settings에 **직접 병합**한다. `merge-runtime-hooks.mjs`는 PreToolUse를 관리하지 않는다. 설치는 Owner 게이트다.
- **Codex**: `codex/hooks.json`에 PreToolUse 이벤트가 없고, 이 레포에 Codex PreToolUse 입력 형식의 근거도 없다. **UNSUPPORTED** (이번 슬라이스에서 wiring 없음).

## gh 인증 분리 (`gh-env`)

- `gh auth switch`(머신 전역)는 금지한다.
- `scripts/git-identity-guard.mjs gh-env [--remote <name>]`는 매핑된 remote의 계정에 대응하는 `GH_CONFIG_DIR` 접두사를 출력한다.
  - 경로: `$XDG_CONFIG_HOME/oh-my-ai/gh/<github_user 소문자>` (기본 `~/.config/...`).
  - 예: `GH_CONFIG_DIR=/home/u/.config/oh-my-ai/gh/work-example gh pr create ...`
- 토큰 값은 출력하지 않는다. `GH_TOKEN`/`GITHUB_TOKEN`이 환경에 있으면 차단한다 (GH_CONFIG_DIR보다 우선하기 때문).
- 디렉터리에 `hosts.yml`이 없으면 `GH_CONFIG_MISSING`으로 차단한다. 계정 로그인은 **사람이** 한 번 수행한다 (`GH_CONFIG_DIR=<dir> gh auth login`). 런타임 어댑터는 `gh auth login`을 deny한다.
- 주의: gh는 기본적으로 토큰을 OS keyring에 저장한다. keyring은 호스트+사용자 기준이라 디렉터리 분리가 계정 분리를 보장하지 않을 수 있다. 실제 분리 여부는 `prove`로 확인한다.

## 신원 증명 (`prove`, opt-in 네트워크)

`scripts/git-identity-guard.mjs prove [--remote <name>] [--no-gh]`는 **네트워크를 쓴다**. `doctor`와 달리 자동 실행되지 않는다.

| 채널 | 방법 | 결과 |
|------|------|------|
| push (SSH) | `ssh -T -o BatchMode=yes git@<host>`의 `Hi <login>! You've successfully authenticated` 파싱 | PROVEN / MISMATCH / UNPROVEN |
| push (HTTPS) | `git credential fill`로 토큰 조회 → 아래 REST `GET /user`의 `login` 비교. 토큰은 메모리에서만 쓰고 출력하지 않음 | 동일 |
| gh | `GH_CONFIG_DIR=<계정 dir> gh api user --jq .login` | 동일 |
| MCP | CLI로 증명 불가. 출력에 "Runtime must call the GitHub MCP get_me" 지시를 넣는다 | 항상 UNPROVEN (CLI_CANNOT_PROVE) |

- REST 엔드포인트: `github.com`은 `https://api.github.com/user`, 그 외 호스트는 `https://<host>/api/v3/user`.
  (요청 원문의 `api.<host>`는 GitHub 전용 형식이라 GHE에서 맞지 않아 이렇게 바꿨다.)
- 비교는 대소문자 무시. `PROVEN`은 **일치하는 login이 관측된 경우에만**이다. 관측 실패는 `UNPROVEN`이다.
- 종료 코드: CLI 채널(push, gh)이 모두 PROVEN일 때만 `0`. MCP는 항상 UNPROVEN으로 남으므로 자동 판정에 쓰지 않는다.
- 증명 범위: **호출 시점에 쓸 수 있는 자격증명**에 대한 것이다. 서버 측 규칙, 다른 클라이언트, 다른 머신은 증명하지 않는다.

## 네이티브 hook 실제 실행 결과 (git 2.43, 검증됨)

`scripts/test-git-identity-native-hooks.mjs`는 임시 repo의 **로컬** `core.hooksPath`를 래퍼로 두고,
원격은 매핑된 ssh alias URL(`git@github-work:acme-work/repo.git`)로 둔다.
전송은 `GIT_SSH_COMMAND`(env) 가짜 ssh가 로컬 bare repo에 `receive-pack`을 붙이는 방식이다. 네트워크와 실제 키를 쓰지 않는다.
`url.<base>.insteadOf`는 쓰지 않는다. git이 훅 호출 전에 URL을 바꿔서 훅이 매핑을 못 찾기 때문이다 (실험으로 확인).

| 경로 | pre-commit | pre-push | 관측 |
|------|-----------|----------|------|
| `git commit` | 실행됨 | — | 일치 시 통과, 불일치 committer 차단 |
| `git commit --amend` | 실행됨 | — | 불일치 committer 차단, HEAD 변화 없음 |
| `git commit --author=<personal>` | 실행됨 | — | `AUTHOR_EMAIL_MISMATCH` 차단 |
| `git cherry-pick` | **실행 안 됨** | — | 개인 committer 커밋이 로컬에 생성됨. **pre-push가 백스탑** |
| `git rebase` (merge backend) | **실행 안 됨** | — | rebase된 커밋의 committer가 개인 계정으로 바뀜. **pre-push가 백스탑** |
| `git push` (매핑 remote, 일치) | — | 실행됨 | 통과, bare에 반영 |
| `git push` (개인 committer 커밋) | — | 실행됨 | `COMMITTER_EMAIL_MISMATCH` 차단, bare 변화 없음 |
| `git push` (미매핑 remote) | — | 실행됨 | `UNMAPPED_REMOTE` fail-closed 차단 |
| `git push --no-verify` | — | **실행 안 됨** | 통과 (알려진 우회) |

해석: cherry-pick과 rebase는 로컬에 잘못된 committer 커밋을 만들 수 있다. 이 커밋은 push 시점에 pre-push가 잡는다.
따라서 push 전에 로컬 커밋이 섞였는지는 pre-push에 의존한다. 이 검증은 git 2.43 기준이다. 다른 버전은 NOT_RUN.

## 보호 범위 (검증 상태 표시)

| 경로 | 막는 것 | 막지 못하는 것 | 상태 |
|------|---------|----------------|------|
| `pre-commit` (opt-in) | 매핑 remote에서 committer·author 불일치 커밋 (`commit`, `--amend`, `--author`) | `--no-verify`, `core.hooksPath` 변경, **cherry-pick·rebase**, 매핑 파일 삭제·수정 | commit/amend/author: VERIFIED. cherry-pick/rebase: VERIFIED as NOT covered |
| `pre-push` (opt-in) | 미매핑 remote push, push될 커밋의 committer·author 불일치, 미검증 binding(사람 TTY 확인 없으면) | `--no-verify`, `core.hooksPath` 변경, 웹 UI·API·MCP 쓰기, 다른 머신·클라이언트 | push 차단/허용/미매핑/`--no-verify`: VERIFIED |
| 런타임 어댑터 (Claude, 예시) | 셸 텍스트상의 우회 명령, 매핑 repo AI push/gh 쓰기(hooks 없을 때) | 셸 간접 참조, 스크립트 파일, 별칭, 다른 도구, 매핑 파일 편집, 중첩 깊은 따옴표 | 규칙 테스트 53건 VERIFIED (텍스트 매칭). 실제 Claude 세션 hook 실행: **NOT_RUN** |
| `gh-env` | 계정별 `GH_CONFIG_DIR` 제공, `GH_TOKEN` env 차단 | keyring 공유, gh를 직접 호출하면 막을 수 없음 (런타임 어댑터의 gh 쓰기 gate는 hooks 없을 때만) | 단위 테스트 VERIFIED. 실제 계정 분리: **NOT_RUN** |
| `prove` | 호출 시점 자격증명의 login 관측 및 비교 | 서버 측 규칙, MCP 채널(CLI 불가), 미호출 시점 | 파서·비교 로직 VERIFIED. 실제 네트워크 호출: **NOT_RUN** |
| `doctor` | 읽기 전용 상태 보고 (env override 상태 포함) | 아무것도 막지 않음 | VERIFIED |

서버 측 제약(브랜치 보호, 조직 정책, 계정 권한)만이 위 경로를 모두 막을 수 있다. 이 가드는 로컬 실수를 줄이는 역할이다.

### 알려진 한계

- `remote-name`이 설정된 remote 이름이 아니라 URL로 들어오면 `--remotes=<url>`이 아무 ref와도 맞지 않는다. 그러면 도달 가능한 모든 커밋을 검사한다 (fail-closed, 과차단 가능).
- tag push의 tagger 이메일은 검사하지 않는다.
- pre-commit은 cherry-pick·rebase에서 실행되지 않는다 (위 표). pre-push가 최종 방어선이다.
- 런타임 어댑터의 gh 쓰기 gate는 `gh -R <other>`처럼 cwd가 아닌 repo를 지정하면 cwd의 origin을 본다.
- 런타임 어댑터는 중첩 셸 안의 `git commit -n`은 잡지 않는다 (`--no-verify`와 env/config 패턴만 중첩 검사).
- `gh` 쓰기 gate는 hooks가 설치된 repo에서는 통과시킨다. 네이티브 hook은 `gh`를 보지 않으므로, 이 경우 `gh pr create`는 가드 밖이다.

## cherry-pick / rebase 규칙

- cherry-pick과 rebase는 원작성자(author)를 보존한다. committer는 현재 설정 계정이다.
- 판정은 committer = 규칙 이메일, author = 규칙 이메일 또는 `preserve_author_emails`로 한다.
- 보존 목록에는 과거에 실제로 쓴 원작성자 이메일만 넣는다. 임의 이메일을 넣어 우회하지 않는다.
- pre-commit은 이 두 경로에서 실행되지 않으므로 committer 불일치는 push 시점에 잡힌다.

## 기존 hook이 있는 사용자 (수동 연결)

`setup.sh`는 이 가드를 연결하지 않는다. 기존 `.git/hooks/pre-commit` 또는 `pre-push`를 **덮어쓰지 않는다**. 직접 연결하려면 기존 파일을 보존한 채 앞에 호출을 추가한다.

pre-commit 예:

```sh
#!/bin/sh
# 기존 pre-commit 로직은 그대로 둔다.
"/path/to/oh-my-ai/hooks/git-identity/pre-commit" || exit 1
# ... 기존 명령 ...
```

pre-push는 stdin이 한 번만 읽힌다. 가드가 stdin을 먼저 소비하면 뒤의 hook이 빈 입력을 받는다. 따라서 stdin을 임시 파일에 저장한 뒤 두 번 쓴다:

```sh
#!/bin/sh
tmp="$(mktemp)" || exit 1
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
"/path/to/oh-my-ai/hooks/git-identity/pre-push" "$@" < "$tmp" || exit 1
# ... 기존 pre-push 로직은 "$tmp"를 stdin으로 다시 읽는다 ...
```

가드 상태는 읽기 전용 doctor로 확인한다:

```sh
node /path/to/oh-my-ai/scripts/git-identity-guard.mjs doctor
```

## 종료 코드

- `0`: 허용 (또는 pre-commit에서 미매핑 remote 경고). `prove`는 CLI 채널 모두 PROVEN일 때만.
- `1`: 차단 또는 fail-closed (설정 누락·손상, 신원 확인 불가, git 오류, TTY 확인 실패 포함). `gh-env` 차단 포함.
- `2`: 사용법 오류

## 다음 슬라이스 (이 슬라이스 범위 밖)

1. **런타임 어댑터 설치와 Codex**: 설치는 Owner 게이트. Codex PreToolUse는 UNSUPPORTED 상태.
2. **MCP `get_me` 강제**: 현재는 `prove`가 지시문만 출력한다. Runtime이 쓰기 전에 호출해 비교하는 실제 gate는 없다.
3. **gh 쓰기 명령 전면 gate**: hooks가 있어도 `gh pr create|merge` 등은 `GH_CONFIG_DIR` 접두사 없이 실행되면 막는 규칙이 필요하다.
4. **cherry-pick/rebase 시점 검사**: pre-commit이 실행되지 않으므로 `post-rewrite` 또는 push 전 로컬 검사가 필요할 수 있다.
5. **Cloud/MCP 쓰기 정책**: 회사 레포 쓰기는 검증된 회사 계정 + 작업 승인이 있을 때만 허용.

## 검증 상태

`make test-git-identity-guard` (99건, 네트워크 없음, 임시 HOME·XDG·global gitconfig 사용):

- `scripts/test-git-identity-guard.mjs` (36): 정책, 설정 검증, env override 규칙, pre-commit/pre-push CLI, TTY 확인(`script`로 pty 구성), doctor, gh-env, prove 파서.
- `scripts/test-git-identity-runtime-guard.mjs` (53): 토크나이저, deny/allow 표, 중첩 셸, 매핑 repo gate, hook JSON I/O.
- `scripts/test-git-identity-native-hooks.mjs` (10): 실제 `git commit`/`--amend`/`--author`/`cherry-pick`/`rebase`/`push`/`--no-verify`.

NOT_RUN (이 슬라이스에서 실행하지 않음):

- 실제 GitHub 계정, 실제 ssh 키, 실제 `ssh -T`/API/`gh` 호출을 쓰는 `prove` (네트워크).
- 실제 Claude 세션에서 PreToolUse hook이 호출되는지 (설치는 Owner 게이트).
- Codex 런타임 (UNSUPPORTED).
- 다른 git 버전의 cherry-pick/rebase hook 동작 (검증은 git 2.43).
- macOS keyring 저장 환경의 `gh` 계정 분리.
