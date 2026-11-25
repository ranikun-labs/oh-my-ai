# batch-report와 dev-main-flow 구성 계약

이 문서는 `skills/batch-report/SKILL.md`와 `skills/dev-main-flow/SKILL.md`가 병렬 에이전트 보고 타이밍을 어떻게 나눠 갖는지 정한다. 이 브랜치는 dev-main-flow를 수정하지 않는다. PR #211(`docs/RPL-113-jira-closure-comments-20261124`, head `2ce962a`)이 병합된 뒤 아래 한 줄을 적용한다.

## 관계

- dev-main-flow는 batch-report를 **참조로만** 소비한다. 여러 에이전트 결과를 한 보고로 묶을 때 batch-report를 호출하고, 입력 envelope과 집계 규칙은 batch-report가 소유한다.
- batch-report는 dev-main-flow를 참조하지 않는다(`skills/batch-report/SKILL.md` §9, 역방향 의존 금지). 따라서 batch-report 본문은 호출자 고유 항목의 목록을 복제하지 않고, 이 문서의 정본 표를 기준으로 호출자 계약을 가리킨다.

## 정본 표 (보고 타이밍 소유 경계, 단일 원본)

이 표가 "누가 무엇을 소유하나"의 유일한 정본이다. `skills/batch-report/SKILL.md` §1과 `skills/dev-main-flow/SKILL.md`는 이 표를 복제하지 않고 "호출자 계약"으로 참조한다.

| 항목 | 정본 owner | batch-report에서의 처리 | 근거 |
|---|---|---|---|
| 진행 신호 `[묶음] n/m 완료 (작업명)` 한 줄, 에이전트별 긴 보고 억제 | batch-report `start` | 소유, 본문에 기술 | SKILL §1 |
| 입력 envelope, 결과별 추출, 집계(최악 상태·출처·충돌·보존) | batch-report | 소유, 본문에 기술 | SKILL §2–§4 |
| 긴급 실패, 보안 문제, Owner Gate의 즉시 보고 | 호출자 계약 | 참조만, 묶음 종료까지 지연 금지 | SKILL §1 |
| 검증 전제를 뒤집는 발견, 비용·타인 영향(예: 공유 Runner 중지로 팀원 CI 대기), 승인 범위 이탈·hook 우회 시도 | 호출자 계약 | 참조만, 묶음 종료까지 지연 금지 | SKILL §1·§4 (운영 사례 반영, 호출자 목록에 추가) |
| blocker, handoff, recovery, AttemptOutcome, 필수 checkpoint의 즉시 갱신 | dev-main-flow F4 계약 | 참조만 | PR #211 `skills/dev-main-flow/SKILL.md` 77행 |
| PR 본문·Jira·F1 요약 같은 일반 갱신의 F4 fan-in 일괄 반영 | dev-main-flow F4 | 참조만 | PR #211 77행 |
| 완료 알림(completion-notify) 발화 | 런타임·훅 (두 Skill 모두 통제 불가) | 통제 불가 명시 | SKILL §10 |

핵심 원칙: **"언제 대화에 보고하나"는 batch-report `start`가, "언제 PR·Jira·F1을 외부에 갱신하나"는 dev-main-flow F4가 정한다.** 즉시 보고 항목은 위 표의 호출자 행에만 존재한다.

## 호출자 소유 위임 규칙 (이 Skill 밖, 정본은 호출자)

병렬 Worker를 띄우는 방법은 보고 타이밍이 아니다. 따라서 위 정본 표에 넣지 않고, batch-report 본문에도 넣지 않는다(SKILL §9: 호출자별 계약은 호출자 소유). 호출자(dev-main-flow 또는 실행 지시문)가 Worker 지시문에 아래를 넣는다.

- **Writer 분리**: Worktree·Terraform state 하나당 Writer 1명. 같은 대상을 쓰는 작업은 한 Worker에 순서대로 묶는다. 독립 작업은 한 메시지에서 병렬로 띄운다.
- **단일 핸드백**: 보고는 한 번만 한다. 핸드백이 delivered면 재전송하지 않는다.
- **정확한 커밋 명령**: `git commit -m "<msg>" -m "Co-Authored-By: ..."`만 쓴다. `git -c`, `core.hooksPath`, `--no-verify`는 금지한다. Worker가 hook 우회 옵션을 습관적으로 넣는 사례가 반복되어 명시한다. 우회 시도가 보이면 즉시 보고 항목이다(위 정본 표 호출자 행).
- **덮어쓰기 금지**: 기존 파일·백업은 덮어쓰지 않고 새 파일명을 쓴다. 임시 파일은 scratchpad에만 둔다. force push, rebase, history rewrite는 금지한다.
- **기존 Worker 우선**: 추가 지시가 이미 실행 중인 Worker 범위와 같으면 새 Worker를 띄우지 않고 그 Worker에게 메시지로 전달한다.
- 허용·불허 범위(push, merge, 배포, apply, CI 취소 등)는 지시문마다 명시한다. 읽기 전용이면 그렇게 적는다.

## 대안과 선택

- 대안 A: dev-main-flow에 batch-report의 `start` 규칙을 복제한다. 장점은 읽기 한 곳으로 끝난다. 단점은 두 정본이 생겨 한쪽만 바뀌는 드리프트가 생긴다. 기각.
- 대안 B: batch-report 본문에 호출자 즉시 보고 목록을 옮긴다. 장점은 독립 Skill만 읽어도 된다. 단점은 호출자 계약이 바뀔 때 두 곳을 고쳐야 하고, §9 역방향 의존 금지 원칙과 상충하지는 않지만 목록이 중복된다. 기각.
- 선택(추천): 이 문서의 정본 표 한 곳에 소유 경계를 두고, batch-report §1은 "호출자 계약 항목, 지연 금지"로만 참조한다.
- 숨은 비용: batch-report를 단독으로 쓰는 사용자는 이 문서를 보지 못할 수 있다. 그래서 SKILL §1에 "지연 금지" 원칙을 남겨 두어, 표를 보지 못해도 보안·Owner Gate가 묶음 뒤로 밀리지 않게 했다. 정본 표와 SKILL §1이 어긋나면 이 표를 먼저 고친다.

## 발견 사항 (Main 판단 대상)

- PR #211 77행 문장에는 보안 문제와 Owner Gate가 없다. 정본 표는 두 항목을 호출자 계약 항목으로 정했으므로, 아래 교체안에 명시 추가했다. #211을 병합하기 전에 Main이 이 추가를 승인해야 한다.

## #211 문장 교체안 (#211 병합 후 적용)

PR #211의 `skills/dev-main-flow/SKILL.md` 77행 문장을 아래처럼 바꾼다. 이 브랜치에서는 적용하지 않는다.

```diff
- Ordinary updates are batched at F4 fan-in; important blockers, handoffs, recovery, AttemptOutcome and required checkpoints are not deferred.
+ Ordinary PR-body, Jira, and F1 summary updates are batched at F4 fan-in; progress reporting during parallel agent work follows the `start` mode of `skills/batch-report/SKILL.md` §1; important blockers, security issues, Owner Gate items, handoffs, recovery, AttemptOutcome and required checkpoints are not deferred.
```

- `Ordinary updates`를 `Ordinary PR-body, Jira, and F1 summary updates`로 좁힌 이유: 진행 보고는 batch-report `start`가 소유하므로, F4 fan-in 일괄 반영의 대상은 외부 쓰기로 한정한다.
- 즉시 보고 항목(blockers, handoffs, recovery, AttemptOutcome, 필수 checkpoint)은 그대로 유지하고, 정본 표의 호출자 행에 맞춰 보안 문제와 Owner Gate를 추가했다.

## 노출 검증 (정적 근거와 Owner 수동 체크리스트)

### 정적 확인 (이 브랜치에서 실행, 런타임 호출 아님)

| 점검 | 기대값 | 결과 |
|---|---|---|
| `.claude/skills/batch-report` | 상대 심볼릭 링크 `../../skills/batch-report` | 확인 (아래 명령 결과 참조) |
| `.agents/skills/batch-report` | 상대 심볼릭 링크 `../../skills/batch-report` | 확인 |
| `skills/batch-report/SKILL.md` frontmatter | `disable-model-invocation: true` | 확인 |
| `skills/batch-report/agents/openai.yaml` | `policy.allow_implicit_invocation: false` | 확인 |

정적 확인은 "링크와 설정이 맞게 되어 있다"만 증명한다. Claude의 `/batch-report` 호출 성공이나 Codex의 `$batch-report` 활성화는 증명하지 않는다. 그 부분은 아래 라이브 항목이며 **NOT_RUN**이다.

### Owner 수동 체크리스트 (라이브 호출, 전부 NOT_RUN)

각 단계의 "관측 기대값"과 실제 관측을 비교해 기록한다. 기록은 대화나 PR 설명에 남기고, 이 문서에는 결과를 쓰지 않는다.

Claude Code

1. 레포 루트에서 새 세션으로 `claude`를 실행한다.
2. 입력창에 `/batch-report 테스트 결과 2건 종합` 을 입력한다. 관측 기대값: batch-report 본문이 로드되고, 입력 envelope을 요구하거나 종합을 시작한다.
3. 새 세션에서 슬래시 없이 `병렬 에이전트 결과 2개 종합해줘` 라고 입력한다. 관측 기대값: 대화 기록에 batch-report Skill 호출이 나타나지 않는다(`disable-model-invocation: true`).
4. 레포 밖 디렉터리(예: 홈의 임시 디렉터리)에서 `claude`를 실행하고 `/batch-report` 를 입력한다. 관측 기대값: 레포 로컬 링크가 없으므로 해당 명령을 찾지 못한다. 이는 노출이 레포 로컬뿐이라는 설계 확인이다.

Codex

1. 레포 루트에서 `codex`를 실행한다.
2. `$batch-report 테스트 결과 2건 종합` 을 입력한다. 관측 기대값: batch-report Skill이 활성화되어 종합을 시작한다.
3. `$` 없이 `병렬 에이전트 결과 2개 종합해줘` 라고 입력한다. 관측 기대값: `allow_implicit_invocation: false`에 따라 batch-report가 암묵적으로 활성화되지 않는다.

관측 기록 양식

```text
[노출 검증] runtime=<claude|codex> step=<번호> expected=<기대값> observed=<관측> result=<PASS|FAIL|NOT_RUN>
```

## completion-notify 런타임 프로브 (Owner 실행, 아직 NOT_RUN)

목적: N개 배경 에이전트가 끝날 때 Main 텍스트, 디스패처 로그, OS 알림이 몇 번 나오는지 관측해, 완료 알림이 배치 단위로 묶이는지 확인한다. 정적 분석 근거는 `skills/batch-report/SKILL.md` §10에 있다.

### 전제

- macOS, `make install-completion-notify ENABLE_COMPLETION_NOTIFY=1`로 설치되어 `make completion-notify-status`가 정상이다. 이 프로브는 설치 상태를 바꾸지 않는다.
- 디스패처 로그 경로는 `${XDG_STATE_HOME:-$HOME/.local/state}/oh-my-ai/completion-notify.log`다(`scripts/completion-notify-dispatcher.sh:9-10`). 임시 경로로 돌리려면 `XDG_STATE_HOME`을 임시 디렉터리로 지정한다.

### 절차

1. 임시 상태 경로를 만들고 로그 경로를 고정한다. 프로브 후 이 디렉터리를 삭제한다.
   ```bash
   export PROBE_STATE="$(mktemp -d)/state"
   export XDG_STATE_HOME="$PROBE_STATE"
   export PROBE_LOG="$PROBE_STATE/oh-my-ai/completion-notify.log"
   ```
2. 같은 셸에서 `claude`를 실행한다(환경 변수가 훅 프로세스까지 전달되어야 한다). 빈 임시 레포 디렉터리에서 실행한다.
3. 첫 메시지로 다음을 입력한다: `Agent 도구로 run_in_background=true 배경 에이전트 3개를 띄워 각각 "ok"만 반환하게 하라. 결과를 기다리지 말고 이 턴을 끝내라.`
4. 3개가 모두 끝날 때까지 기다린 뒤(예: 30초) 다음을 센다.
   - (a) Main 텍스트 블록 수: 세션 transcript `~/.claude/projects/<cwd 변환 경로>/<session-id>.jsonl`에서 `assistant` 메시지의 `text` 블록 수. 명령 예: `jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | "x"' <jsonl> | wc -l`
   - (b) 디스패처 로그 줄 수: `grep -c 'dispatcher invoked' "$PROBE_LOG"`. 잠금을 통과한 이벤트만 기록된다. 잠금 실패로 버려진 이벤트는 로그에 남지 않는다(`scripts/completion-notify-dispatcher.sh:61-80`).
   - (c) OS 알림 수: Notification Center 배너를 육안으로 센다.
5. Stop 발화 수는 현재 구성으로 직접 관측할 수 없다. 기록에는 `UNKNOWN(Stop 발화 수 미관측)`으로 쓴다. 발화 수가 필요하면 별도 승인을 받아 임시 로깅 훅을 추가하고, 프로브 후 즉시 제거한다.
6. 정리: `unset XDG_STATE_HOME PROBE_STATE PROBE_LOG`, `rm -rf` 임시 디렉터리, 임시 레포를 삭제한다.

### 결정 표

| (a) Main 텍스트 | (b) 로그 줄 | (c) 알림 | 해석 | 기록 상태 |
|---|---|---|---|---|
| 1 | 1 | 1 | 완료가 묶여 한 번만 발화. 단일 관측이므로 재현 확인 필요 | `unknown` 유지, 관측 메모 |
| 3 | 3 | 3 | 완료마다 Main 턴과 Stop이 열린다. 배치 단위 묶음 없음 | `conditional` (아래 형태) |
| 3 | 1 | 1 | 디스패처 잠금이 창 안의 이벤트를 버린다. 알림은 1회 | `conditional` (아래 형태) |
| 0 | 1 이상 | 0 | 디스패처는 실행됐으나 알림 미표시(macOS 알림 권한 등 의심) | `unknown`, 권한 점검 후 재관측 |
| 0 | 0 | 0 | 훅 미발화 또는 설치 문제 | `unknown`, `make doctor-completion-notify` 결과 첨부 |

Skill 통제 여부: 세 값 모두 Skill이 통제할 수 없다. 기록할 때 "Skill 측 대응 없음"을 `safe_fallback`에 명시한다.

### runtime-capabilities.json 기록 형태

이 프로브 결과는 `capabilities/runtime-capabilities.json`의 `runtimes.claude.capabilities` 배열에 기록한다. 이번 변경은 실제 항목을 추가하지 않는다. 아래는 형태만 보여준다. `<...>`는 Owner가 채울 값이다.

프로브 전 placeholder (`unknown`, evidence 없음):

```json
{
  "capability_id": "capability.notification.turn_complete_per_background_agent",
  "declared_status": "unknown",
  "drift_status": "current",
  "effective_status": "unknown",
  "conditions": [],
  "limitations": [],
  "unknown_reason": "<프로브 미실행>",
  "verification_needed": "<프로브 절차 1-6 실행 후 (a)(b)(c) 기록>",
  "safe_fallback": "<Skill 측 대응 없음, 알림 발화는 런타임 소관>",
  "required_manual_step": [],
  "source": { "type": "not_verified", "reference": null },
  "evidence_refs": [],
  "last_verified_at": null,
  "notes": [],
  "required_for_advertised_support": false
}
```

관측 후 `conditional` 형태 (결정 표의 3/3/3 또는 3/1/1 행): `conditions`, `failure_mode`, `required_manual_step`, `evidence_refs`가 모두 비어 있으면 validator가 거부한다. `evidence_refs`에는 프로브 기록의 식별자(예: 세션 ID, 로그 해시)를 넣는다.

```json
{
  "capability_id": "capability.notification.turn_complete_per_background_agent",
  "declared_status": "conditional",
  "drift_status": "current",
  "effective_status": "conditional",
  "conditions": ["<관측 조건, 예: 배경 에이전트 완료마다 Stop 발화>"],
  "limitations": ["<관측 한계>"],
  "failure_mode": "<예: 완료 알림이 에이전트 수만큼 발생>",
  "required_manual_step": ["<Owner 설정 조정 절차>"],
  "source": { "type": "manual_fixture", "reference": "<프로브 기록 위치>" },
  "evidence_refs": ["<프로브 기록 ID>"],
  "last_verified_at": "<YYYY-MM-DDTHH:MM:SSZ>",
  "notes": [],
  "required_for_advertised_support": false
}
```

검증: 실제 파일을 건드리지 않고 임시 사본에 항목을 넣어 `node scripts/validate-capabilities.mjs <사본>`으로 확인한다. 이 단계는 이번 변경에서 수행했다(결과는 Main 보고 참조).
