# Jira 업무 티켓 계획 — FX·jira-ticket 제품 계약

**상태:** 사용자 승인 방향을 문서화한 설계. Runtime 구현·적용은 미완료.  
**적용 범위:** oh-my-ai를 사용하는 모든 제품·기술 업무. AI 전용 업무 모델이 아니다.  
**계층 거버넌스 정본:** [harness-foundation-docs — Jira 업무 계층](https://github.com/ranikun-labs/harness-foundation-docs/blob/main/docs/governance/jira-work-item-hierarchy.md)

## 사용자가 원하는 결과

새 기능을 대화 속 설명에만 남기지 않고, 처음 보는 사람도 다음을 추적할 수 있게 한다.

- 어떤 큰 결과(Epic)를 위한 일인가?
- 중간 Story로 묶을 만큼의 사용자 결과가 있는가?
- 어떤 Feature를 각각 만들고 어떻게 완료를 확인하는가?
- 실제 Jira에서 부모·자식 관계가 저장됐는가?

## 티켓 구조

```text
Epic
├── Story (필요할 때만)
│   ├── Feature
│   └── Feature
└── Feature (Story 묶음이 불필요하면 직접 배치)
```

- **Epic:** 여러 작업이 함께 달성할 사용자·제품 결과.
- **Story:** 공유 결과를 가진 Feature를 묶는 선택적 단위. 계층을 채우려고 만들지 않는다.
- **Feature:** 독립된 목표·범위·수락 기준·검증 증거를 갖는 작업 단위.
- **Sub-task:** Feature의 내부 실행 단계. 독립 기능의 티켓을 대신하지 않는다.

## FX와 jira-ticket의 목표 흐름

```text
요청·설계 논의
  → 기존 Jira 검색과 중복 확인
  → Epic / 선택적 Story / Feature 분류
  → 한국어 F1 티켓 미리보기
  → 명시적 Jira 쓰기 승인
  → 현재 Jira가 지원하는 Parent 관계로 생성
  → Issue Type·Parent·수락 기준 재조회
  → 사용자가 실행을 요청한 경우에만 jira-work / Worker로 인계
```

미리보기에는 최소한 각 티켓의 유형·제목·목적·범위·수락 기준·검증 방법·정확한 Parent 후보·의존성이 보여야 한다. 여러 Feature를 한 번에 제안해도 각 Issue를 구분해 보여주고, 기존 승인 경계를 따른다.

티켓 작성은 승인 후 Jira 기록을 만드는 단계다. 브랜치, 코드, PR, 상태 전환, Merge, 배포를 자동으로 승인하거나 시작하지 않는다. 기존 `jira-ticket`과 `jira-work`의 역할 분리는 유지한다.

## 현재 Jira와의 차이

2026-11-13에 확인한 RPL Issue Type 메타데이터에서 Epic은 계층 1, Story·Feature는 계층 0, Sub-task는 계층 -1이다.

따라서 현재 RPL은 Epic→Story 또는 Epic→Feature를 표현할 수 있지만 Story→Feature Parent는 지원하지 않는다.

- 계층에 맞는 직접 Epic→Feature는 실제 Parent로 기록한다.
- Story→Feature가 필요한 경우 Issue Link나 Sub-task로 가장하지 않는다.
- 실제 계층이 필요한 티켓은 Jira 설정이 지원되거나 Owner가 대체 방식을 승인할 때까지 관계를 미지원으로 표시한다.
- Jira 전역 설정 변경은 이 설계 문서나 Skill 호출로 승인되지 않는다.

## 구현 상태와 필요한 Runtime 연결

현재 `jira-ticket`의 공통 티켓 계약에는 목표·범위·수락 기준 등 14개 필드는 있지만, 계층 유형과 Parent를 일관되게 해결·검증하는 계약은 확인되지 않았다. 이 문서만으로 동작이 바뀌지는 않는다.

후속 구현에서 확인·보완할 접점은 다음과 같다.

1. FX가 새 기능 제안을 기존 Jira 업무에 연결할 때, 중복 검색과 Parent 후보를 함께 고른다.
2. `jira-ticket` 미리보기가 Issue Type과 실제 Parent 후보를 필수 표시한다.
3. Jira Writer가 해당 Project·Issue Type 조합에서 Parent를 저장할 수 있는지 메타데이터로 검증한다.
4. 지원되지 않는 관계는 생성 전에 분명하게 표시하고, 연결 도구가 허용하는 관계로 위장하지 않는다.
5. 생성 후 실제 Issue Type·Parent·본문을 다시 조회해 미리보기와 대조한다.
6. 각 Feature가 독립 수락 기준과 검증 증거를 갖는지 확인한다.

실제 Jira G3 Create 경로에는 기존 Writer와 진행 중인 변경이 있을 수 있다. 이 문서는 해당 코드를 인수하거나 수정하지 않으며, 구현은 현재 Writer·승인·G3 Gate를 확인한 별도 Delta로 진행해야 한다.

## Source 경계

- Jira가 티켓·Parent·상태의 실제 기록을 소유한다.
- harness-foundation-docs가 공통 계층·거버넌스 기준을 소유한다.
- oh-my-ai가 요청 인식, 티켓 초안, 승인된 Create 연결을 구현한다.
- Confluence는 이 정본들로 연결되는 요약·문서 색인이다.

**문서화 완료는 Jira 설정 완료·티켓 생성 자동화·FX/Native Skill 적용 완료를 뜻하지 않는다.**
