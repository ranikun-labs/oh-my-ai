# devcontainer / oh-my-ai 워크플로 (상세)

> `instructions/harness.md`의 "devcontainer / oh-my-ai 작업 — 트리거"에서 가리키는 상세 레퍼런스.
> oh-my-ai 레포를 만지거나 `~/.claude`/`~/.codex` 연결 구조가 헷갈릴 때 읽는다. (평소 세션엔 불필요 → 항상 로드 안 함.)

## 심링크 구조 (매번 헤매던 부분)
- **`~/.claude/`, `~/.codex/`, `~/.agents/` 자체는 진짜 디렉토리다.** shared install은 그 안의 **개별 엔트리**만 non-destructive 방식으로 연결한다. instruction과 CLI entrypoint는 경로가 없거나 이미 이 레포가 관리하는 symlink일 때만 연결한다. `~/.claude/settings.json`과 `~/.codex/hooks.json`은 기존 JSON을 보존한 채 oh-my-ai 관리 Hook만 병합하고, Skill 디렉터리는 대체하지 않는다. `work-start`는 Claude와 Codex, `spec-to-implementation`은 Codex의 개별 Skill 경로로 연결한다.
- 그래서:
  - Claude 스킬/커맨드처럼 심링크된 엔트리를 고치면 레포에 바로 반영됨.
  - 공유 instruction과 인덱스는 생성물을 직접 고치지 말고 `instructions/harness.md`, `instructions/mine.md`, `instructions/adapters/*.md`, 또는 `SKILL.md` 메타데이터를 고친 뒤 `make instructions`를 실행한다.
  - `~/.claude/`나 `~/.codex/` 최상위에 **새 파일**을 만들면 레포에 안 들어간다 — 레포에 직접 만들고, 필요하면 별도 심링크를 건다.

## 설치 정책
- `make doctor` / `setup.sh --doctor`는 현재 symlink·settings·skills 상태만 읽고 충돌 가능성을 출력한다.
- `make install-shared` / `setup.sh --install-shared`는 shared instruction과 helper를 연결하고, 기존 설정에는 관리 Hook만 additive merge한다. 기존 `~/.claude/skills`, `~/.agents/skills`, agents는 대체하지 않으며 `work-start`와 `spec-to-implementation`을 각각 개별 연결한다. 사용자 소유의 같은 이름 경로가 있으면 덮어쓰지 않고 충돌로 보고한다.
- Codex Cloud는 저장소의 `.agents/skills/<skill>` 경로에서 Skill을 발견하도록 구성한다. `spec-to-implementation`은 `.agents/skills/spec-to-implementation -> ../../skills/spec-to-implementation` 링크를 커밋해 둔다. Cloud 세션에서 실제 발견됐는지는 해당 런타임에서 따로 확인한다.
- Hook 병합은 Runtime·이벤트·matcher 의미·oh-my-ai operation으로 identity를 판정한 뒤 유효 JSON을 임시 파일에 완성하고 atomic replace한다. 손상 JSON·충돌하는 `work-start`·누락된 관리 경로는 그대로 보존하고 설치를 성공으로 표시하지 않는다. `disableAllHooks: true` 또는 Codex `[features] hooks = false`는 자동 변경하지 않고 Runtime을 `incomplete`로 보고한다.
- `make install-profile PROFILE=<name>`은 명시한 profile만 opt-in 설치한다. `profiles/example/`은 템플릿이고, 실제 개인 profile은 커밋하지 않는 `profiles/local/<name>/`에 둔다.
- Codex CLI 설치와 인증/세션 관리는 instruction 배포와 분리한다. Codex Hook trust는 CLI에서 신뢰성 있게 읽지 못하므로 `configured` 이후에도 `/hooks`에서 사용자가 직접 검토한다.

## Portable 경로 (공유 설정 파일 위치 역추적 금지)
- 머신마다 절대경로가 다르고, `~/.claude/settings.json`·`~/.codex/hooks.json`은 여러 도구가 병합해서 쓰는 공유 설정 파일이 될 수 있다.
- 그래서 훅은 설정 파일 위치에서 레포 루트를 추측하지 않는다. 설정 파일에는 `oh-my-ai hook ...` 진입점만 두고, `~/.local/bin/oh-my-ai` symlink의 실제 위치로 레포 루트를 찾는다.
- 레포 위치를 옮기면 `make install-shared`를 다시 실행해 `~/.local/bin/oh-my-ai` 링크를 갱신한다.

## 커밋/푸시 — shared 기본 원칙
- 커밋·푸시 전 현재 `remote`, `branch`, `author`, GitHub 인증 계정을 확인한다.
- `setup.sh`는 특정 Git author나 GitHub 계정을 고정하지 않는다.
- shared workflow는 특정 계정 전환 스크립트나 push guard를 전제하지 않는다.
- 개인별 계정 정책, 커밋 자동화, push guard는 `profiles/local/` 아래 profile 또는 레포 밖 private script로 분리한다.
