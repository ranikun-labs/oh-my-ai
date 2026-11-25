# Git Identity Guard (Slice 1)

## 목적

회사 GitHub 계정과 개인 GitHub 계정이 한 커밋·한 push에 섞이는 **실수**를 막는다.
이 가드는 실수 차단기(mistake blocker)다. 우회를 막는 통제(bypass-proof control)가 아니다.
고의 우회, `--no-verify`, 다른 클라이언트에서의 push는 막지 못한다.

이 슬라이스는 정책 resolver, 읽기 전용 doctor, opt-in 네이티브 git hook, 테스트만 포함한다.
런타임 어댑터, `gh` 토큰 주입, MCP `get_me` 검사는 다음 슬라이스다 (아래 "다음 슬라이스").

## 구성 레이어

| 레이어 | 위치 | 책임 |
|--------|------|------|
| Public guard (이 레포) | `scripts/lib/git-identity-policy.mjs`, `scripts/git-identity-guard.mjs`, `hooks/git-identity/` | 정책 판정, CLI, git hook 래퍼 |
| Private 정책 (ai-instructions 등) | 레포 밖 | 어떤 계정 조합을 허용할지에 대한 상위 정책 |
| Private profile 매핑 | `$XDG_CONFIG_HOME/oh-my-ai/git-identity.json` 또는 `OH_MY_AI_GIT_IDENTITY_CONFIG` | 실제 remote ↔ 계정 매핑 값. 레포에 커밋하지 않는다 |

매핑 값은 설정(config)이다. 상태(state)가 아니므로 `docs/harness/user-local-state.md`의
state root에 두지 않는다.

## 설정 파일

스키마 v1. 예시는 `profiles/example/git-identity.json.example`을 복사해 placeholder를 채운다.

```json
{
  "schema_version": 1,
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

## remote 정규화와 alias

- 지원 형식: `https://`, `http://`, `ssh://`, scp형 `[user@]host:owner/repo`.
- 정규화 결과는 `host/owner/repo` (소문자, 포트·사용자·자격증명·`.git` 제거). 자격증명은 저장하거나 출력하지 않는다.
- 로컬 경로와 `file://`은 정규화되지 않는다 (UNMAPPED).
- **alias 해석**: ssh 형식의 remote host가 어떤 규칙의 `ssh_host_alias`와 같으면, 그 규칙들만 후보가 되고 canonical host는 규칙의 `match` host가 된다. 다른 규칙으로 떨어지지 않는다. 예: `git@github-personal:acme-work/x`는 personal alias 규칙 후보만 보므로 acme-work 규칙에 매핑되지 않는다.
- alias 설정 검증: alias는 실제 host와 같을 수 없고, 같은 alias를 가진 규칙은 같은 host를 가리켜야 한다.

## 판정

- **binding (push 대상 계정 연결)**: `VERIFIED_CONFIG`는 remote가 규칙의 ssh alias를 쓰거나, `git config --get-urlmatch credential.username <url>` 값이 `github_user`와 같을 때다. 그 밖은 `UNVERIFIED_BINDING`.
  - **이것은 설정 일치 검사이지 인증 증명이 아니다.** 어떤 키나 토큰이 실제로 쓰이는지는 검증하지 않는다.
- **commit 판정**: committer 이메일은 반드시 규칙의 `author_email`과 같아야 한다. author 이메일은 `author_email` 또는 `preserve_author_emails` 중 하나여야 한다. 이름은 판정에 쓰지 않는다.
- pre-push는 `git rev-list <local> --not --remotes=<remote-name>`로 push될 커밋만 검사한다. 새 브랜치(원격 sha가 0)는 도달 가능한 전체 범위를 검사한다. 삭제(local sha가 0)는 검사하지 않는다.

## 보호 범위

| 경로 | 막는 것 | 막지 못하는 것 |
|------|---------|----------------|
| `pre-commit` (opt-in) | 매핑된 remote에서 committer 또는 author 이메일이 규칙과 다른 커밋 생성. `git commit --author=...` 포함 | `--no-verify`, `core.hooksPath` 변경, 매핑 파일 삭제·수정 |
| `pre-push` (opt-in) | 매핑되지 않은 remote로의 push, push될 커밋 중 committer·author 불일치, binding 미검증 | `--no-verify`, `core.hooksPath` 변경, 웹 UI·GitHub API·MCP로 직접 쓰는 경로, 다른 머신·다른 클라이언트 |
| `doctor` | 읽기 전용 상태 보고 | 아무것도 막지 않는다 |

서버 측 제약(브랜치 보호, 조직 정책, 계정 권한)만이 위 경로를 모두 막을 수 있다. 이 가드는 로컬 실수를 줄이는 역할이다.

### 알려진 한계

- `remote-name`이 설정된 remote 이름이 아니라 URL로 들어오면 `--remotes=<url>`이 아무 ref와도 맞지 않는다. 그러면 도달 가능한 모든 커밋을 검사한다 (fail-closed, 과차단 가능).
- tag push의 tagger 이메일은 검사하지 않는다.
- pre-commit은 `git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT`를 읽는다. `--author` 재정의가 여기에 보이는지는 실제로 확인했다. amend·rebase·cherry-pick에서 pre-commit이 실행되는지는 이 슬라이스에서 검증하지 않았다 (NOT_RUN). 최종 방어선은 pre-push다.

## 왜 `gh auth switch`(전역 활성 계정 전환)를 금지하는가

`gh auth switch`는 머신 전역의 활성 계정을 바꾼다. 다른 세션·다른 레포·백그라운드 작업이 같은 상태를 공유하므로, 한 작업의 전환이 다른 작업의 push를 조용히 바꾼다. 이 가드는 `gh auth switch`를 호출하지 않으며, git config도 쓰지 않는다. 계정을 명시적으로 고르려면 호출 단위 토큰(`GH_TOKEN`)을 쓰는 방식이 다음 슬라이스의 방향이다.

## cherry-pick / rebase 규칙

- cherry-pick과 rebase는 원작성자(author)를 보존한다. committer는 현재 설정 계정이다.
- 그래서 판정은 committer = 규칙 이메일, author = 규칙 이메일 또는 `preserve_author_emails`로 한다.
- 보존 목록에는 과거에 실제로 쓴 원작성자 이메일만 넣는다. 임의 이메일을 넣어 우회하지 않는다.

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

가드 상태는 `make doctor`가 아니라 이 가드의 doctor 명령으로 확인한다 (읽기 전용):

```sh
node /path/to/oh-my-ai/scripts/git-identity-guard.mjs doctor
```

## 환경 변수

| 변수 | 의미 |
|------|------|
| `OH_MY_AI_GIT_IDENTITY_CONFIG` | 매핑 파일 경로 (기본: `$XDG_CONFIG_HOME/oh-my-ai/git-identity.json`, 없으면 `~/.config/oh-my-ai/git-identity.json`) |
| `OH_MY_AI_GIT_IDENTITY_REMOTE` | pre-commit이 확인할 remote 이름 (기본 `origin`) |
| `OH_MY_AI_GIT_IDENTITY_ALLOW_UNVERIFIED_BINDING=1` | 사람이 명시적으로 허용하는 override. 미검증 binding을 허용하며 stderr에 기록한다 |

## 종료 코드

- `0`: 허용 (또는 pre-commit에서 미매핑 remote 경고)
- `1`: 차단 또는 fail-closed (설정 누락·손상, 신원 확인 불가, git 오류 포함)
- `2`: 사용법 오류

## 다음 슬라이스 (이 슬라이스 범위 밖)

1. **런타임 어댑터**: Claude/Codex PreToolUse에서 `git push --no-verify`, `git -c core.hooksPath=...`, `gh auth switch` 같은 우회 명령을 deny.
2. **호출 단위 토큰**: `gh`를 전역 전환하지 않고 명령마다 `GH_TOKEN`을 주입.
3. **MCP `get_me` 검사**: 쓰기 전에 현재 MCP 인증 계정이 규칙과 맞는지 확인.
4. **Cloud/MCP 쓰기 정책**: 회사 레포 쓰기는 검증된 회사 계정 + 작업 승인이 있을 때만 허용.

## 검증 상태

이 슬라이스의 검증은 `make test-git-identity-guard` (합성 fixture 22개, 네트워크 없음, 임시 HOME·XDG·global gitconfig 사용)다.
실제 GitHub 계정, 실제 ssh 키, 실제 push 경로는 검증하지 않았다 (NOT_RUN).
