# Skill Source 레이아웃 규칙

Skill의 **물리적 Source 위치**와 **런타임 노출 경로**를 분리하는 규칙이다. 지금은 모든 Source가 `skills/<id>/` 평평한 구조에 있고, 이 문서는 나중에 Core/Library 파일럿으로 Source를 옮길 때 깨지지 않을 조건만 정한다. 실제 이동은 하지 않는다.

## 규칙

| 항목 | 규칙 |
|------|------|
| Skill 판정 | `SKILL.md`를 가진 디렉터리. 그룹 디렉터리 자체는 Skill이 아니다. |
| Skill ID | 디렉터리 이름 = frontmatter `name`. 위치(flat/그룹)와 무관하게 같아야 한다. |
| 예약 그룹 | `skills/core/`, `skills/library/` 만 그룹이다. 그 밖의 depth 1 디렉터리는 Skill이어야 한다(SKILL.md 필수). |
| 그룹 깊이 | 그룹 안의 Skill은 depth 2(`skills/<group>/<id>/`)만 허용한다. 그룹 안의 그룹은 없다. |
| 중복 | 같은 ID가 두 위치에 있으면 오류다. 어느 쪽도 고르지 않는다. |
| 런타임 노출 | 항상 평평하다: `~/.claude/skills/<id>`, `~/.agents/skills/<id>`, `.claude/skills/<id>`, `.agents/skills/<id>`. 그룹 이름은 노출 경로에 나타나지 않는다. |
| 노출 링크 | 상대 심볼릭 링크이고, realpath가 발견된 Source 디렉터리와 같아야 한다. 대상 Skill 이름과 링크 이름이 같아야 한다. |
| Source 조회 | 설치기·검사기는 `skills/<id>` 경로를 직접 조립하지 않고 `scripts/lib/skill-discovery.mjs --resolve <id>` 로 찾는다. |

## 검사 (게이트)

- `node scripts/lib/skill-discovery.mjs --check`: 발견 오류가 하나라도 있으면 실패.
- `node scripts/check-skill-source-boundary.mjs`: 발견 오류 + 라우팅 Skill이 `skill-index.json`에 모두 있는지.
- `node scripts/check-skill-exposure-links.mjs`: `.claude/skills`, `.agents/skills` 링크가 발견된 Source를 가리키는지(dangling, 절대 경로, 바깥 대상, ID 불일치, 실제 디렉터리 복사, 중복을 실패로 본다).
- `make test-skill-discovery`: 위 세 가지를 실행한다.

## 설치 동작 (이동 후에도 유지)

- 설치 대상 경로(`~/.claude/skills/<id>`, `.agents/skills/<id>`)는 바뀌지 않는다. Source만 바뀐다.
- 옛 flat 경로(`skills/<id>`)를 가리키는 기존 링크는 `stale-source`로 보고하고 **자동으로 다시 연결하지 않는다.** 사용자가 옛 링크를 확인해 제거한 뒤 재설치한다.
- 같은 ID가 두 곳에 있으면 링크를 만들지 않고 실패한다.
- 다른 Skill의 발견 오류는 이 Skill 설치를 막지 않는다(경고). 전체 오류는 위 게이트가 막는다.

## 파일럿 전제 조건

한 Skill을 `skills/library/<id>/` 로 옮기는 파일럿은 아래가 모두 green일 때만 시작한다.

1. `make test-skill-discovery` 통과
2. `make test-install-fixtures` 통과 (이동 후 같은 설치 경로, stale-source 보고 포함)
3. `make test-dev-main-flow-install-fixtures` 통과
4. `make instructions` 후 생성물 diff 0 (`skills/skill-index.json` 포함)
5. 검증 워크플로(`validate-dev-main-flow.yml`)의 노출 링크 검사 통과
6. 이동 대상 Skill에 대해 `make doctor` / `--doctor-dev-main-flow` 가 `ready`

## 아직 하지 않는 것

- 실제 Skill 이동(파일럿 없음). `skills/core/`, `skills/library/` 는 현재 비어 있다.
- 레지스트리 엔진(Skill ID를 등록·조회하는 별도 저장소나 서비스). 파일 시스템 발견만 쓴다.
- 런타임 노출 방식 변경(그룹별 노출, 중첩 노출). 노출은 계속 평평하다.
- 전체 디렉터리 링크(`~/.claude/skills` → `skills/`) 방식 정리. `setup.sh doctor`의 레거시 `path_state` 검사는 그대로 둔다.
