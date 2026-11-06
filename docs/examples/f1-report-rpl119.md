# F1 실제 개발 결과 보고 예시 — RPL-119

> 기준: 2026-10-29 · 이 예시는 PR #88의 검증된 과거 HEAD `761b5d25197faf32f7ad4b678e318d9a0a1c2400`을 설명합니다. 현재 최신 HEAD·실시간 검증 결과를 자동으로 나타내지 않습니다.

## 문제

한국어 개발 결과 보고 Skill이 "개발 결과 보고하지 마"를 보고 명령으로 잘못 이해했고, 일부 설명 질문을 실제 보고 요청으로 오인하거나 과거형과 새로운 요청이 함께 있는 문장을 놓쳤습니다.

## 사용자에게 달라지는 점

보고를 요청하는 문장과 보고를 금지하거나 보고 방법을 묻는 문장을 더 잘 구분합니다. 다만 자동 Skill 선택은 아직 지원 Runtime에서 검증되지 않았습니다.

## 서비스 기능

- 서비스명: oh-my-ai
- 기능명: 한국어 개발 결과 F1 보고서 구조 검사와 보고 Skill 라우팅 pattern
- 현재 사용자 기능: 기준 HEAD에서는 사용자가 F1 필수 절과 다섯 Gate 상태의 구조를 검사할 수 있습니다. 이 candidate에서 추가한 서비스 필드 검사는 해당 과거 HEAD의 기능으로 주장하지 않습니다.

## 이번 변경

- 실제 변경: PR #88에서 broad keyword 라우팅을 좁은 pattern 조건으로 바꾸고, 보고 요청과 설명·부정 문장을 구분하는 회귀 사례를 추가했습니다.

PR #88에서 광범위한 `keyword` 라우팅을 좁은 `pattern`으로 변경하고, 실제 보고 요청·부정·과거형·인용·설명 질문을 다루는 라우팅 회귀 사례를 43개로 확장했습니다. 이 변경은 이미 기록된 두 커밋과 고정 HEAD에 적용된 결과입니다.

## 검증

- 구현 상태: PR #88 변경이 기준 HEAD 761b5d25197faf32f7ad4b678e318d9a0a1c2400에 반영됐습니다.
- 검증 상태: 해당 HEAD에서 보고 검사 17/17과 라우팅 검사 43/43이 CI에서 통과했습니다.
- 문서 상태: 이 예시 후보에 서비스별 필드를 보강했습니다. 이를 PR #88 당시의 별도 문서 변경으로 주장하지 않습니다.
- 배포 상태: 실제 설치와 운영 배포는 실행하지 않았습니다.

- Native Test: PASS — `node scripts/test-f1-report-advisory.mjs`를 GitHub Actions의 Node 22 환경에서 실행. 보고 검사 17/17, 라우팅 검사 43/43 PASS.
- CI: PASS — https://github.com/ranikun-labs/oh-my-ai/actions/runs/40837779670 (기준 HEAD `761b5d25197faf32f7ad4b678e318d9a0a1c2400`).
- Independent Review: NOT_RUN — 이 기준 HEAD에 대한 고정 SHA 독립 Reviewer 검증 증거가 없습니다.
- Runtime E2E: NOT_RUN — 실제 Codex·Claude Skill 자동 발견·호출은 검증하지 않았습니다.
- Owner Gate: PENDING — Source Merge, 실제 설치, 운영 적용은 승인되지 않았습니다.

## 아직 안 되는 것

- 미지원 기능: 지원 Runtime의 실제 자동 Skill 선택과 실제 사용자 환경에서의 E2E.
- 미지원 이유: PR #80의 pattern Router와 공유 Skill Index가 운영 기본 경로에 반영됐다는 증거가 없습니다.

PR #80의 `pattern` Router가 공식 기본 실행 경로에 병합되지 않았고, 공유 Skill Index 등록과 Installer 보안 Finding 해결도 남아 있습니다. 따라서 PR #88의 CI 통과만으로 자동 보고 Skill이 실제 환경에서 활성화됐다고 볼 수 없습니다.

## 다음 행동

- 다음 목표: 안전하고 단일한 Writer 경로에서 Router와 Skill Index를 연결합니다.
- 첫 행동: PR #80의 설치 안전성과 Writer 소유권을 확인합니다.
- 담당 Lane: oh-my-ai maintainer / Router integration
- 필요 조건: 설치 안전성 검토, 단일 Writer 지정, 독립 Review, 지원 Runtime 검증.

PR #80의 설치 안전성과 Writer 소유권을 해결하고, 두 PR의 Router·Skill Index를 승인된 단일 Writer로 통합합니다. 이후 독립 Reviewer와 실제 지원 Runtime의 Skill Discovery/Call을 검증합니다.

## 근거

- Jira: https://ranikunlabs.atlassian.net/browse/RPL-119
- PR: https://github.com/ranikun-labs/oh-my-ai/pull/88
- 검증 HEAD: `761b5d25197faf32f7ad4b678e318d9a0a1c2400`
- CI: https://github.com/ranikun-labs/oh-my-ai/actions/runs/40837779670
