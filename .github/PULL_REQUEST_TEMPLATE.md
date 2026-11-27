## PR 유형
<!-- 해당하는 것 모두 체크 (하나에 걸치는 PR도 있음) -->
- [ ] 기능 개발 (훅/스크립트에 새 로직 추가·확장)
- [ ] 환경/안전 구성 (실행 환경·인프라 수리, 샌드박스/권한/복구)
- [ ] 스킬/메타데이터 보강 (SKILL.md 콘텐츠·routing metadata 등 선언적 데이터)
- [ ] 원칙/표현 정의 (harness.md 상시 규칙·응답 스타일 등)
- [ ] 하네스 운영/정리 (브랜치·PR 정책, 백로그 정리, 문서 산출물 추적)
- [ ] 외부 소스/벤더 (벤더 스킬 승격, provenance, 마켓플레이스 동기화)
- [ ] 세션/위임 자동화 (sub-session delegation, handoff 자동화) — *아직 검증 안 된 후보 카테고리, 반복 안 되면 제거*

## 목적
<!-- 기존 문제와 해결 목적을 한 문장에 담고, 변경 후 사용자가 할 수 있는 일을 적습니다. 관련 Jira를 연결합니다. -->

## PR 의존성
- [ ] base branch:
- [ ] 선행 PR 없음
- [ ] 선행 PR 있음: (번호/브랜치, merge 순서)
- [ ] stacked PR인 경우 base/head 관계와 merge 순서를 설명함

## 영향 표면
<!-- 해당하는 것 체크 -->
- [ ] hook/runtime 동작 변경 (prompt-routing-hook.mjs, work-start-skill-match.mjs 등)
- [ ] skill routing / skill-index 변경
- [ ] generated instruction 파일 변경 (CLAUDE.md, AGENTS.md, MINE.md 등)
- [ ] 설치/setup/doctor/pre-commit 동작 변경

## 변경 범위
- [ ] 변경 파일이 아래 목록과 정확히 일치함
  -
- [ ] 목록 밖 파일(무관한 dirty 파일, 다른 세션 작업) 미포함

## Generated Artifacts (해당 시)
- [ ] `make instructions` 실행함
- [ ] 실제로 바뀐 파일만 diff에 있음: `skill-index.json` / `CLAUDE.md` / `claude/CLAUDE.md` / `AGENTS.md` / `MINE.md` 중 ( )

## Routing / Hook 변경 (해당 시)
발동해야 하는 입력:
-

발동하면 안 되는 입력:
-

## 이번 PR에서 건드리지 않은 것
<!-- 예: prompt-routing-hook.mjs, work-start SKILL.md, vendor/openclaw metadata 등 -->
- [ ]

## 검증
<!-- 실행한 검증은 명령·결과·대상 HEAD와 함께 적습니다. 미실행 항목은 NOT_RUN과 이유를 남깁니다. -->
- [ ] `git diff --check`
- [ ] (해당 시) `node --check` / `bash -n` / `make doctor`
- [ ] 기능 스모크 테스트:

## 동시 세션 위생
<!-- 이 레포는 여러 세션이 같은 워킹트리를 공유할 수 있음 -->
- [ ] 작성 시점 기준 `git status --short`에 무관 dirty/untracked 파일 없음
- [ ] base branch 기준으로 이 PR용 커밋만 포함됨 (`git log --oneline <base>..HEAD`)
- [ ] 다른 세션의 stash / untracked 파일을 건드리지 않음
- [ ] PR에 포함하지 않을 파일을 명시적으로 제외함

## 리뷰 포커스
<!-- 리뷰어가 특히 봐야 할 부분 -->
-

## 머지 계획
- [ ] draft / ready 전환 필요
- [ ] self-merge 예정 (squash/merge)

## 남은 것 / 방향 결정 필요
<!-- 이번 PR 밖으로 미룬 것 -->
