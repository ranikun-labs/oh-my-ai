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
- `node scripts/skill-pilot-check.mjs <id> <group>`: 파일럿 dry-run. 임시 복사본에서만 `skills/<id>` → `skills/<group>/<id>` 로 옮기고 위 게이트·인덱스·생성물·노출 링크·설치 픽스처를 확인한다. 실제 트리는 건드리지 않으며 `make test-skill-discovery` 에는 넣지 않는다.

## 설치 동작 (이동 후에도 유지)

- 설치 대상 경로(`~/.claude/skills/<id>`, `.agents/skills/<id>`)는 바뀌지 않는다. Source만 바뀐다.
- 옛 flat 경로(`skills/<id>`)를 가리키는 기존 링크는 `stale-source`로 보고하고 **자동으로 다시 연결하지 않는다.** 사용자가 옛 링크를 확인해 제거한 뒤 재설치한다.
- 같은 ID가 두 곳에 있으면 링크를 만들지 않고 실패한다.
- 다른 Skill의 발견 오류는 이 Skill 설치를 막지 않는다(경고). 전체 오류는 위 게이트가 막는다.

## Doctor 보고 (읽기 전용)

- 디렉터리 전체 링크(`~/.claude/skills`, `~/.agents/skills` → `$REPO/skills`)를 가정하지 않는다. Runtime Skill 루트마다 **Skill ID별** 상태를 보고한다.
- 설치된 Skill만 상태를 출력한다: `ready` · `stale-source` · `dangling` · `conflict`. 링크가 없는 Skill은 개수만 센다(`not installed`, 선택 사항).
- `dangling`, `stale-source`, `conflict` 는 `--strict` 실패로 센다.
- 루트 자체가 `$REPO/skills` 를 가리키는 디렉터리 링크면 `legacy-dir-link` 경고만 낸다. core/, library/ 가 가짜 Skill로 노출되므로 사용자가 직접 제거한 뒤 재설치한다. Doctor는 이 링크를 고치거나 지우지 않고, strict 실패로도 세지 않는다.
- Doctor는 어떤 경우에도 파일·링크를 만들거나 바꾸지 않는다.

## 파일럿 전제 조건

한 Skill을 `skills/library/<id>/` 로 옮기는 파일럿은 아래가 모두 green일 때만 시작한다.

1. `make test-skill-discovery` 통과
2. `make test-install-fixtures` 통과 (이동 후 같은 설치 경로, stale-source 보고 포함)
3. `make test-dev-main-flow-install-fixtures` 통과
4. `make instructions` 후 생성물 diff 0 (`skills/skill-index.json` 포함)
5. 검증 워크플로(`validate-dev-main-flow.yml`)의 노출 링크 검사 통과
6. 이동 대상 Skill에 대해 `make doctor` / `--doctor-dev-main-flow` 가 `ready`
7. 후보의 `metadata.source` 가 확정돼 있다(이동이 소유 결정을 겸하지 않는다).
8. `node scripts/skill-pilot-check.mjs <id> <group>` 가 7/7 PASS다(아래 선정 기준 참고).

## 아직 하지 않는 것

- 실제 Skill 이동(파일럿 없음). `skills/core/`, `skills/library/` 는 현재 비어 있다.
- 레지스트리 엔진(Skill ID를 등록·조회하는 별도 저장소나 서비스). 파일 시스템 발견만 쓴다.
- 런타임 노출 방식 변경(그룹별 노출, 중첩 노출). 노출은 계속 평평하다.
- 전체 디렉터리 링크(`~/.claude/skills` → `skills/`) 자동 제거. Doctor는 `legacy-dir-link` 로 경고만 하고, 제거는 사용자가 한다.

## 파일럿 후보 선정 기준

후보를 고르는 기준이다. 실제 선택은 파일럿 실행 결과와 사용자 결정으로 한다.

| 기준 | 이유 |
|------|------|
| `metadata.source` 가 `born-here` 로 선언돼 있다 | 외부 파생이면 "이동"이 "소유 결정(커스터마이즈 승격)"을 겸한다. 출처 선언이 없으면 먼저 채운다. |
| 레포 안 노출 링크(`.claude/skills/<id>`, `.agents/skills/<id>`)가 있다 | 커밋된 상대 링크를 새 위치로 재지정하는 경로를 실제로 검증한다. 없으면 이 경로는 합성 링크로만 검증된다. |
| 라우팅 인덱스(`skills/skill-index.json`)에 있다 | 인덱스 경로 변경과 경계 게이트를 같이 본다. 라우팅 Skill은 `contextual` 등 런타임 노출 영향이 크다. |
| `MINE.md` 에 born-here 목록으로 나온다 | 생성물 경로 변경 범위가 넓어진다. 재생성 diff가 경로 치환만인지 확인해야 한다. |
| 파일 수·하위 디렉터리가 적다 | 실패 원인을 좁히기 쉽다. |
| 현재 설치 상태가 `ready` 로 확인된다 | 이동 뒤 `stale-source` 보고와 재설치 절차를 실제 설치에서 확인할 수 있다. |

### 점검 결과 (dry-run, 현재 트리)

| 후보 | 출처 | 인덱스 | 노출 링크 | MINE.md | 파일 | dry-run |
|------|------|--------|-----------|---------|------|---------|
| `senior` → `core` | born-here | 없음(라우팅 아님) | `.claude/skills/senior` 1개 (재지정 필요) | 1줄 경로 | 1 | 7/7 PASS |
| `postgres` → `library` | 선언 없음 (`metadata.author: planetscale`) | 있음 (경로 1줄) | 없음 (합성 링크로만 검사) | 없음 | 23 | 7/7 PASS |

### 추천 (결정 아님)

1순위 후보는 **`senior`**다. 이유:
- 출처가 `born-here` 라서 이동과 소유 결정을 분리할 수 있다.
- 커밋된 노출 링크를 실제로 재지정해야 하므로, 실제 이동에서 필요한 경로를 검증한다. dry-run에서도 이 링크는 이동 직후 검사에 실패했다(재지정 전). 재지정이 필수임을 보였다.
- 변경 범위가 `MINE.md` 1줄과 노출 링크 1개로 좁다.

`postgres` 는 2순위로 둔다. 출처 선언이 없고(외부 파생), 이동이 소유 결정을 겸하므로 파일럿 첫 대상으로는 부적합하다. 출처 선언을 먼저 확정하면 다시 평가한다.

### 파일럿 점검 실행 결과

```
$ node scripts/skill-pilot-check.mjs senior core
RESULT: PASS (7/7)
$ node scripts/skill-pilot-check.mjs postgres library
RESULT: PASS (7/7)
```
