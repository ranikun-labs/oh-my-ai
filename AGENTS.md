<!-- GENERATED FILE. Edit instructions/harness.md, instructions/adapters/*.md, or skills/*/SKILL.md metadata, then run make instructions. -->

# Codex adapter

This file is generated from the shared oh-my-ai instruction source.

- Source of truth: `instructions/harness.md`
- Regenerate with: `make instructions`
- Do not edit `AGENTS.md` directly. Edit `instructions/harness.md` or this adapter, then regenerate.

## Codex-specific interpretation

- Treat Claude-specific paths and command names as oh-my-ai harness concepts unless a Codex-native equivalent exists.
- Claude-generated `CLAUDE.md` files map to this generated `AGENTS.md` for Codex instruction discovery.
- Claude slash commands are workflow names. In Codex, follow the same intent using available tools and local files.
- Claude hooks/settings remain Claude-specific unless a Codex project config or hook is explicitly added.

## PR 작성 및 본문 갱신

- PR 생성 또는 본문 수정 전에 대상 base 브랜치의 `.github/PULL_REQUEST_TEMPLATE.md` 실제 내용을 확인한다.
- 저장소에 작업 유형별 전용 PR 템플릿이 있으면 현재 작업에 맞는 전용 형식을 우선한다.
- 이 저장소는 기존 `.github/PULL_REQUEST_TEMPLATE.md`를 우선한다. 공통 선택형 템플릿은 사용자가 명시적으로 선택한 경우에만 사용한다.
- `/핵심정리` 요청은 한국어로 `목적`, `변경`, `검증`, `Finding`, `Source Merge`, `Production Gate`, `참조`를 구분해 작성한다.
- 실제 실행한 검증과 근거만 기록하고, 실행하지 않은 항목은 `PASS`로 표시하지 말고 `NOT_RUN`으로 기록한다.
- 작성자(Writer)의 실행 결과와 독립 Reviewer의 판정을 구분한다. 독립 `PASS`는 Reviewer가 확인한 코드 HEAD와 근거가 일치할 때만 기록한다.
- 본문의 코드 HEAD, base 브랜치, 테스트 명령·결과·링크를 실제 ref 및 실행 근거와 대조한다.
- Source Merge 승인과 Production 배포 승인을 별도 Gate로 기록한다. PR 본문 작성이나 Writer의 검증 결과를 Merge 승인으로 간주하지 않는다.
- Secret, PII, 민감한 SQL 파라미터를 PR 본문에 기록하지 않는다. 설명이 필요하면 비식별·마스킹된 예시만 사용한다.

---

# Shared Harness

## 하네스 용어 (이 시스템의 공용어)
- **하네스**: 이 AI 시스템 전체 (공유 instruction 원본 + AI별 adapter + 스킬 + 커맨드 + 훅 + 인덱스).
- **상시 레이어(`instructions/harness.md`, AI별 instruction 파일로 렌더링되어 항상 켜짐)** 에는 두 종류가 산다:
  - **트리거**: "이 상황이면 → 저 플레이북(스킬)"으로 *연결*(dispatch). 절차가 두꺼우면 플레이북으로 뺀다.
  - **원칙(standing rule)**: 항상 적용되는 *행동 기준*. **단독 — 플레이북 없음.** (예: 표현 원칙, 품질 기준.)
- **플레이북(스킬, 필요시 로드)**: 트리거가 가리키는 두꺼운 절차.
- **cascade**: 변경 하나 → 연결된 산출물(트리거 엔트리·`MINE.md`·README·플레이북)이 **동반 갱신**되는 동작. (DB `ON UPDATE CASCADE` 비유. 무언가 만들거나 바꾸면 연결된 곳을 같이 갱신한다.)
- **규칙 충돌 시 우선순위**: 안전·정확 > 품질 깊이 > 간결 > 표현 스타일. (장황 금지와 "실패모드 다 짚기"가 부딪히면 → 깊이 우선, 단 군더더기 없이.)

## 응답 스타일
- 짧고 직접적으로. 설명 장황하게 하지 말 것.
- 코드 보여줄 때는 +/- diff 형식으로 변경 전/후를 명확히 구분한다. 변경 의도가 코드만 봐서 안 드러나면(숨은 이유·주의사항 등) 짧은 설명 주석을 덧붙인다.

## 표현 원칙 (커밋·PR·일일보고·문서·설명 공통)
- **목적(왜/무엇을 위해) 위주로 표현한다.** 무엇을 바꿨나(what)보다 왜·무엇을 위해(why/intent)가 드러나야 한다.
- 길이는 중간. **한 줄짜리 너무 짧은 표현도, 주절주절 장황한 것도 안 된다.** 목적 + 핵심 변경이 한눈에 들어오는 정도.
- **"무엇을 만들었나"가 아니라 "어떤 문제/목적을 해결했나"를 앞세운다.** 예를 들어 반복 수작업을 도구화했으면 "X 커맨드 추가"가 아니라 "반복되던 X를 자동화"라고 쓴다.
- 업무 보고·문서·커밋 모두 동일하다. 한 일을 단순 나열하지 말고 **목적/성과 위주로** 묶는다. 예: "A 수정, B 수정, C 수정" ❌ → "반복되던 수동 검증을 자동화해 배포 전 누락을 줄임" ✅
- 커밋 메시지 예: `feat(harness): 반복되던 수동 검증을 자동화해 배포 전 누락 방지` (목적이 제목에 드러남, 세부는 필요시 본문 1~2줄).

## 품질 기준 — 네카라 시니어 실무급 (원칙)
모든 작업의 디폴트 깊이. "네카라 시니어급으로"·"딥하게" 키워드는 이 기준을 한 단계 더 올리라는 신호.
- **결정은 트레이드오프 + 추천 1개.** 옵션 나열 금지 — "나라면 X, 이유 Y, 버리는 건 Z." 근거 없는 동의·나열 금지.
- **happy path 금지, 실패모드부터.** 엣지케이스·장애·롤백·동시성·데이터 정합성·보안을 안 물어봐도 반사적으로 짚는다.
- **증상 아닌 근본 원인.** 제1원리·재현부터. (→ systematic-debugging 스킬)
- **증거 없이 단언 금지.** "될 거예요" 대신 실행·검증 후 결과로 말한다. (→ verification-before-completion 스킬)
- **비판적 푸시백.** 사용자가 틀렸거나 더 나은 길이 있으면 직언. 듣기 좋은 말로 미루지 않는다 (sycophancy 금지).
- **숨은 비용 명시.** 유지보수성·결합도·기술부채·확장성 트레이드오프를 같이 말한다.
- 간결하되 깊게 (표현 원칙과 함께).

## 작업 라우팅 (어떤 일이면 무엇이 자동으로 붙나)
작업을 시작하면 그 도메인에 연결된 스킬/커맨드/문서를 **먼저 붙인다.** 현재 매핑:

| 작업 | 붙는 것 |
|------|---------|
| 반복 업무(toil) 감지·도구화 | `harness-automation` 스킬 (트리거는 아래 섹션) |
| 새 도메인·서비스 작업 시작 (context 없음) | `project-context` 스킬 (CREATE 모드) |
| 설계·결정 맥락을 `docs/context/`에 저장·정리 요청 | `project-context` 스킬 (CREATE/UPDATE 모드) |
| 중요 설계·아키텍처 결정 내린 직후 | `project-context` 스킬 (UPDATE 모드) |
| 세션 종료 / PR 생성 전 | `project-context` 스킬 (CONTEXT CHECKPOINT) |

**확장 규칙 — 커스텀 스킬의 단일 원본은 `SKILL.md`다:**
1. frontmatter `description`을 날카롭게 쓴다 — 작업과 매칭돼 자동 발동시키는 핵심
2. `metadata.source`와 `metadata.summary`를 쓴다 — `MINE.md` 등록 원본
3. 반드시 상시 라우팅할 스킬만 `metadata.route`를 쓴다 — 위 표의 생성 원본
4. `make instructions`를 실행한다 — 라우팅 표·`MINE.md`·AI별 instruction을 한 번에 생성
→ 기본은 description 기반 확률적 발견이다. 반드시 떠야 하는 작업만 `route`로 상시 토큰을 사용한다.

## 배치 규칙 (새 지시·기능은 성격대로 — root 비대화 방지)
새로 추가할 땐 생성물(`CLAUDE.md`, `claude/CLAUDE.md`, `AGENTS.md`)에 바로 쓰지 말고 성격으로 분류한다:

| 성격 | 위치 |
|------|------|
| 항상 적용되는 행동 원칙 | `instructions/harness.md` (원칙) |
| "이 작업이면 X 켜라" | `instructions/harness.md` (트리거 1줄) → 스킬 |
| 여러 단계 절차·체크리스트 | 스킬 (플레이북) |
| "반드시/절대" 강제 | 훅 (결정적) |
| 회사·특정 레포 전용 | 그 프로젝트의 instruction 파일 (`AGENTS.md`, `CLAUDE.md` 등) |
| 독립 분석(결과만 필요) | 서브에이전트 |

→ root엔 *모든 세션에 늘 필요한 것*만. 나머진 필요할 때 깨어나는 곳으로. (200줄은 목표가 아니라 이 규칙의 자연 부산물.)

## 스킬 출처 (provenance) — 커스텀 vs 외부 파생
- 외부 스킬은 **실제로 커스터마이즈할 때만** 레포로 가져온다(승격). 손 안 댈 거면 마켓플레이스(plugin) 의존으로 두고 vendoring 하지 않는다. (premature vendoring 금지 — 자동화의 rule of three와 동일 논리: 실제로 손대기 시작할 때만 소유한다.)
- 레포에 둔 스킬은 frontmatter `metadata.source` 로 출처를 남긴다:
  - `source: born-here` — 처음부터 이 레포에서 만든 것
  - `source: <origin>` — 외부 베이스 (예: `planetscale/postgres`). 재동기화·출처표시용.
- 외부를 승격하거나 새로 만들면 `MINE.md` 에도 등록한다.

## 스킬 사용 로그 — 원칙
사용 로그는 oh-my-ai의 XDG application state directory에 모은다: `${XDG_STATE_HOME:-$HOME/.local/state}/oh-my-ai/harness-usage.log`.
- Claude의 명시적 `Skill` 도구 호출은 PostToolUse 훅이 자동 기록한다.
- Codex 또는 암묵적으로 스킬을 적용할 때는 작업 시작 시 아래 공용 이벤트를 한 번 발생시킨다:
```bash
"$HOME/.local/bin/harness-event" emit skill-start --skill <skill-name> --runtime <claude|codex>
```
- global state 기록이 sandbox·권한 문제로 실패하면 repo-local ignored state(`.oh-my-ai/state/harness-usage.log`)로 fallback한다.
- repo-local fallback도 실패하면 telemetry만 포기하고 원래 작업을 계속한다. 이 실패는 `execution-recovery` 트리거에서 제외하고 사용자에게 반복 보고하지 않는다.
Git remote는 credential을 제거한 `host/owner/repo`로 정규화되어 저장소별로 집계된다.

## 프로젝트 컨텍스트 — 트리거
- 세션 시작 시 `[HARNESS:context]` 메시지가 보이면: 목록에서 현재 작업(브랜치·이슈 트래커·도메인)과 관련된 파일을 **먼저 Read**한다.
- `[HARNESS:context]` 에 파일이 없거나 목록 자체가 없으면: `project-context` 스킬로 **즉시 CREATE**.
- 태스크 목록만으로는 핸드오프 불가 — 결정 로그·설계 배경이 함께 있어야 다음 세션이 이어받을 수 있다.

## 실행 장애 복구 — 트리거
- 도구·명령 실패 시 오류 지문(도구·작업·종료코드·핵심 오류)을 분류하고 execution-recovery 스킬을 적용한다.
- 동일 실패는 최대 1회다. 권한·sandbox·정책 거부는 같은 방식으로 재시도하지 않는다.
- 대피 경로와 승인 요청은 각각 1회다. 복구가 비대해지면 중단하고 blocker를 보고한다.

## 반복 업무 자동화 (하네스 엔지니어링) — 트리거
- **감지는 에이전트 몫**(사용자가 짚어주길 기대하지 않는다). 아래 toil 신호가 보이면 **한 줄 넛지**로 던지고, **컨펌 전엔 만들지 않는다**(반응 없으면 흘려보냄, 재촉 X).
  - 신호: 같은 흐름 3회+ / 다단계 수동(인증 전환·배포·릴리즈) / 복붙·치환 반복 / "매번·또·맨날·귀찮" 류 표현
- 컨펌되면 `harness-automation` 스킬을 따라 게이트·형태선택·구조화·정리.

## Execution Policy
- 파일 직접 수정 여부는 `execution mode`로 제어한다. 상세 정의는 `instructions/execution-policy.md`를 따른다.
- shared 기본값은 `patch-with-approval`이다.
- 지원 모드: `suggest-only`, `patch-with-approval`, `auto-apply`.
- 개인별 기본 모드는 `HARNESS_EXECUTION_MODE` 또는 local/private profile에서 override한다.
- 어떤 모드에서도 generated file 직접 수정, 기존 미커밋 변경 덮어쓰기, secret 기록, 승인 없는 destructive command는 금지한다.

## Git / GitHub 작업 원칙
- 커밋·푸시 전 현재 `remote`, `branch`, `author`, GitHub 인증 계정을 확인한다.
- master에는 직접 커밋하거나 푸시하지 않는다. 모든 변경은 목적별 브랜치에서 작업하고 PR을 통해 병합한다.
- 하나의 PR에는 하나의 명확한 목적만 포함한다.
- 다른 세션의 dirty/untracked/stash 작업을 PR 범위에 섞지 않는다.
- stacked PR(다른 PR 브랜치를 base로 하는 PR)인 경우 base/head 관계와 선행 PR의 merge 순서를 PR 설명에 명시한다.
- shared instruction은 특정 GitHub 계정, 계정 전환 스크립트, 개인 push guard를 전제하지 않는다.
- 개인별 GitHub 계정 정책, 커밋 자동화, push guard는 `profiles/local/` 또는 레포 밖 private script로 분리한다.
- shared 설치는 보수적 opt-in이다. 기존 `~/.claude/skills`, `~/.agents/skills`, settings, hooks, agents를 자동으로 덮어쓰지 않는다. 먼저 `make doctor`로 충돌 가능성을 확인한다.
- 생성물은 직접 수정하지 않고 source instruction을 수정한 뒤 재생성한다.
- 심링크 구조·portable 경로·setup.sh 등 **상세는 작업 전 `docs/devcontainer-workflow.md` 를 읽는다.**

## 문서 산출물 추적 정책 (Document artifact tracking policy)
- 기본 원칙: 작업 중 생기는 markdown 산출물은 **기본 ignore 유지**, 최종 산출물만 **좁은 파일 단위로 추적**한다. 디렉터리 전체 unignore는 피한다.
- internal planning docs는 이 public repository에 커밋하지 않는다. 예: roadmap draft, strategy note, architecture design draft, internal contract, MVP plan, scope creep analysis, pricing note, business model note, feature gating note, private product decision.
- internal planning docs는 레포 밖 private docs 또는 명시적으로 private이고 gitignored된 local profile path에 둔다.
- scratch / working note: 임시 조사, 회의 준비, 로컬 초안은 ignore 상태로 두고 커밋하지 않는다.
- review candidate: 검토 후보도 ignore 상태를 유지한다. 임시 리뷰를 위해 `.gitignore`를 풀지 말고 `git diff --no-index`, `diff -u`, 원본 파일 비교 등으로 확인한다.
- final artifact: 팀 공유용 decision record, 설계 문서, 재사용 reference가 되면 그때만 추적한다. 정확한 파일만 `.gitignore` 예외 처리하거나 `git add -f <file>`로 강제 staging한다.
- 예외: oh-my-ai 자신의 아키텍처/제품 경계 audit 은 이 repo 의 공개 대상이다. 단, 대외 비공개 roadmap 과 pricing/business 판단은 계속 제외한다.
- 확인 명령:
  - 왜 ignore되는지: `git check-ignore -v <file>`
  - ignored 신규 문서 diff: `git diff --no-index /dev/null <file>`
  - 최종 승인 문서 staging: `git add -f <file1> <file2> <file3>`
  - staged 문서 검토: `git diff --cached -- <file1> <file2> <file3>`
