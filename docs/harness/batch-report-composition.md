# batch-report와 dev-main-flow 구성 계약

이 문서는 `skills/batch-report/SKILL.md`와 `skills/dev-main-flow/SKILL.md`가 병렬 에이전트 보고 타이밍을 어떻게 나눠 갖는지 정한다. 이 브랜치는 dev-main-flow를 수정하지 않는다. PR #211(`docs/RPL-113-jira-closure-comments-20261124`, head `2ce962a`)이 병합된 뒤 아래 한 줄을 적용한다.

## 관계

- dev-main-flow는 batch-report를 **참조로만** 소비한다. 여러 에이전트 결과를 한 보고로 묶을 때 batch-report를 호출하고, 입력 envelope과 집계 규칙은 batch-report가 소유한다.
- batch-report는 dev-main-flow를 참조하지 않는다(`skills/batch-report/SKILL.md` §9, 역방향 의존 금지). 따라서 dev-main-flow 고유의 즉시 보고 항목은 batch-report 안에 옮기지 않고, dev-main-flow가 자기 계약으로 직접 적용한다.

## 소유 경계

| 항목 | 정본 owner | 근거 |
|---|---|---|
| 병렬 작업 중 진행 보고 타이밍 (`[묶음] n/m 완료` 한 줄, 에이전트별 긴 보고 억제) | batch-report `start` 모드 | `skills/batch-report/SKILL.md` §1 |
| 긴급 실패, 보안 문제, blocker, Owner Gate의 즉시 보고 | batch-report §1 예외 + 호출자 계약 | §1 즉시 보고 예외 |
| blocker, handoff, recovery, AttemptOutcome, 필수 checkpoint의 즉시 갱신 | dev-main-flow F4 계약 | PR #211 `skills/dev-main-flow/SKILL.md` 77행 |
| PR 본문·Jira·F1 요약 같은 일반 갱신의 F4 fan-in 일괄 반영 | dev-main-flow F4 | PR #211 77행 |
| 결과 집계 (최악 상태, 출처 표시, 충돌 노출, 입력 보존) | batch-report §4 | `skills/batch-report/SKILL.md` §4 |
| 완료 알림(completion-notify) 발화 | 런타임·훅 (두 Skill 모두 통제 불가) | `skills/batch-report/SKILL.md` §10 |

핵심 원칙: **"언제 보고하나"는 batch-report `start`가, "언제 PR·Jira·F1을 갱신하나"는 dev-main-flow F4가 정한다.** 둘이 겹치는 부분은 진행 신호(대화 텍스트)와 일반 갱신(외부 쓰기)으로 나눠진다.

## 대안과 선택

- 대안 A: dev-main-flow에 batch-report의 `start` 규칙을 복제한다. 장점은 읽기 한 곳으로 끝난다. 단점은 두 정본이 생겨 한쪽만 바뀌는 드리프트가 생긴다. 기각.
- 대안 B: batch-report가 dev-main-flow의 즉시 보고 목록을 참조한다. 장점은 목록이 한 곳에 있다. 단점은 §9의 역방향 의존 금지를 깬다. 기각.
- 선택(추천): 참조 구조. dev-main-flow는 한 문장으로 batch-report `start`를 가리키고, 즉시 보고 목록은 dev-main-flow에 남긴다. 숨은 비용은 두 목록(batch-report §1 예외, dev-main-flow 즉시 목록)이 서로 다른 항목을 가진다는 점이다. 이 차이는 아래 표의 owner 구분으로 명시해 두고, 실제로 어긋나면 dev-main-flow 쪽을 먼저 고친다.

## #211 문장 교체안 (#211 병합 후 적용)

PR #211의 `skills/dev-main-flow/SKILL.md` 77행 문장을 아래처럼 바꾼다. 이 브랜치에서는 적용하지 않는다.

```diff
- Ordinary updates are batched at F4 fan-in; important blockers, handoffs, recovery, AttemptOutcome and required checkpoints are not deferred.
+ Ordinary PR-body, Jira, and F1 summary updates are batched at F4 fan-in; progress reporting during parallel agent work follows the `start` mode of `skills/batch-report/SKILL.md` §1; important blockers, handoffs, recovery, AttemptOutcome and required checkpoints are not deferred.
```

- `Ordinary updates`를 `Ordinary PR-body, Jira, and F1 summary updates`로 좁힌 이유: 진행 보고는 batch-report `start`가 소유하므로, F4 fan-in 일괄 반영의 대상은 외부 쓰기로 한정한다.
- 즉시 보고 항목(blockers, handoffs, recovery, AttemptOutcome, 필수 checkpoint)은 문장 그대로 유지한다.
