---
name: spec-to-implementation
description: Use for substantial feature requests or architecture changes that need explicit requirements, acceptance criteria, repository source-of-truth review, Owner decisions, approved implementation, independent review, and a PR gate. Do not impose this workflow on small fixes or simple questions. A Work-start Candidate is never an approved specification.
metadata:
  source: born-here
  summary: 큰 변경을 승인 가능한 명세부터 독립 검수와 PR Gate까지 이끄는 구현 절차
  routing:
    visibility: contextual
    risk_level: medium
    task_types:
      - feature-planning
      - architecture-change
      - implementation-workflow
    triggers:
      - kind: intent
        values:
          - plan_and_implement_substantial_change
          - define_acceptance_criteria_before_implementation
      - kind: keyword
        values:
          - spec-to-implementation
          - 추상 요구
          - 명세부터 구현
          - 승인된 명세
          - 요구사항과 인수 기준
      - kind: pattern
        values:
          - (?=.*\b(?:build|implement|develop|create|add|design|plan)\b)(?=.*\brequirements and acceptance criteria\b)^(?!\s*(?:what|why|how|explain|tell me|can you explain|could you explain)\b)[\s\S]{1,2000}$
    keywords:
      ko:
        - 요구사항
        - 인수 기준
        - 승인된 명세
        - 독립 검수
      en:
        - acceptance criteria
        - approved specification
        - independent review
        - implementation plan
    use_when:
      - 새 기능이나 구조 변경처럼 여러 파일·계약·책임이 걸리고 구현 전 합의가 필요한 경우
      - 사용자가 요구사항 정리, 승인, 구현, 독립 검수까지 이어지는 작업을 요청한 경우
    do_not_use_when:
      - 단순 질문, 문구 변경, 작은 국소 수정처럼 별도 명세 절차가 과한 경우
      - 사용자가 아직 아이디어 탐색만 원하고 구현 준비를 요청하지 않은 경우
    requires:
      - substantial_change_or_explicit_workflow_request
---

# Spec to Implementation

## 적용 범위와 정지 조건

이 플레이북은 명세 검토가 필요한 큰 기능·구조 변경에만 사용한다. 단순 질문, 작은 버그 수정, 문구 변경에는 강제하지 않는다. 적용 여부가 모호하면 짧게 확인하고, 아이디어 탐색을 구현 요청으로 바꾸어 해석하지 않는다.

Owner는 제품·도메인·API·데이터 계약의 결정을 승인할 책임자다. Writer는 승인된 범위만 구현하고, Reviewer는 Writer와 다른 사람 또는 별도 세션이어야 한다. Owner 결정이 비어 있거나 파일 충돌·기존 미커밋 변경의 소유자가 불명확하면 해당 경계에서 멈추고 근거와 필요한 결정을 보고한다.

기존 사용자·저장소 권한, sandbox, 승인 및 Git 정책이 이 절차보다 우선한다. 이 Skill은 권한을 늘리지 않는다. 구현, 파일 변경, Commit, Push, PR 생성은 각각 현재 세션의 명시적 허용 범위 안에서만 수행한다. Merge와 배포는 별도 Owner Gate다.

## 절차

### 1. Idea / Request 정리

문제, 기대 결과, 사용자·운영자, 범위 안팎, 제약, 의존성, 알려진 가정과 미확정 질문을 분리한다. 외부 맥락이 필요하면 사용자에게 출처를 확인한다.

사용자가 `work-start`를 명시적으로 선택했다면 그 결과는 맥락 수집용 **Work-start Candidate**다. Candidate를 승인된 명세, Acceptance Criteria, Owner 결정 또는 구현 허가로 간주하지 않는다. Candidate의 Human Review 경계를 그대로 따른다.

### 2. 요구사항과 Acceptance Criteria

관찰 가능하고 검증 가능한 Acceptance Criteria를 작성한다. 각 기준에 성공 조건과 검증 방법을 연결하고, 범위 밖 항목·비기능 요구·호환성·실패 동작·롤백 필요성을 표시한다. 가정과 확정 사실을 구분하고, 추측은 결정으로 승격하지 않는다.

### 3. 기존 SSOT / API / Domain / DB 확인

현재 브랜치와 작업 트리를 확인하고 저장소의 `AGENTS.md`, 관련 코드·테스트·문서·프로젝트 맥락을 읽는다. API 계약, Domain 규칙, DB 스키마·마이그레이션의 원본(SSOT)을 찾아 경로와 근거를 명시한다. 찾지 못한 항목은 `NOT_VERIFIABLE` 또는 미확정으로 남긴다.

장기 설계 맥락을 기록·갱신할 때는 `project-context`를 재사용한다. 이 Skill 본문에 그 저장 정책을 복제하지 않는다. Read-only Git 사전 점검은 `git-work-preflight`의 명시적 소비자·호출 계약이 허용하는 경우에만 재사용하고, 그렇지 않으면 기존 권한 안에서 필요한 읽기 전용 확인만 한다. Preflight 성공도 명세 승인이나 변경 허가가 아니다.

### 4. Owner Decision과 책임 분리

Owner가 정해야 할 제품 동작, API 호환성, 데이터·마이그레이션, 보안·운영 트레이드오프를 질문과 선택지로 정리한다. 각 결정의 Owner, 상태, 선택, 근거를 기록한다. 결정이 구현 범위에 영향을 주면 추정으로 진행하지 말고 Owner 응답을 기다린다.

명세와 구현 계획을 함께 제시하고 **특정 버전의 명세·Acceptance Criteria와 범위에 대한 명시적 Owner 승인**을 받는다. 승인 전에는 구현을 시작하지 않는다. 사용자의 일반적인 아이디어 제시나 Work-start Candidate 검토는 이 승인이 아니다.

### 5. 구현 계획

승인된 명세를 기준으로 변경 파일·계약·작업 순서, 테스트와 데이터 변경·롤백 계획, 의존성, 위험 및 Reviewer가 볼 항목을 정리한다. 계획이 승인 범위와 다르면 구현 전에 다시 Owner 결정을 받는다. 기존 파일이 이미 변경됐거나 소유권이 불명확하면 덮어쓰지 말고 중단한다.

### 6. 승인된 Writer의 구현

Owner가 승인한 Writer만 승인된 계획·범위 안에서 구현한다. 시작 전 브랜치·작업 트리·기존 변경과 저장소 지침을 재확인한다. Owner 결정이 새로 필요하거나 승인 범위를 바꾸어야 하면 먼저 멈춘다. 실행한 검증은 결과와 함께 기록하고, 실행하지 못한 검증은 `NOT_RUN`으로 남긴다.

`AGENTS.md`, `MINE.md`, `skills/skill-index.json` 등 Generated Artifact는 원본을 수정한 뒤 프로젝트의 정식 생성 명령을 실행한다. 생성물을 직접 고치지 않는다. 이번 저장소에서는 Skill 원본·메타데이터 수정 후 `make instructions`를 실행한다.

### 7. 독립 Reviewer

Writer가 아닌 Reviewer가 승인된 명세·AC와 실제 diff를 대조한다. 최소 검수 범위:

- AC별 구현 및 검증 근거, 빠진 범위와 우발 변경
- SSOT·API·Domain·DB 계약과 호환성, 마이그레이션·롤백
- 경계값·실패 경로·권한 및 보안 영향
- 테스트 결과와 `NOT_RUN` 항목, 재현 가능한 검증 명령
- Generated Artifact가 원본에서 정식 재생성됐는지

Writer의 자체 검토는 독립 Review를 대체하지 않는다. 미해결 결함은 Writer에게 돌려보내고 수정 diff를 다시 검수한다.

### 8. PR 및 병합 Gate

PR을 만들 권한이 현재 명시적으로 허용된 경우에만 승인된 브랜치에서 PR을 만든다. PR에는 목적, 승인된 명세·AC와의 대응, 변경 요약, 실행한 검증과 `NOT_RUN`, 독립 Reviewer 결과, 남은 결정·위험을 적는다. 세션이나 Writer를 넘길 때는 기존 `handoff-prompt`의 수동 Handoff 흐름을 재사용하며, Handoff Candidate도 승인 자체가 아니다.

Owner는 PR의 변경·검증·Review를 확인한 뒤 별도로 병합을 결정한다. 이 Skill은 Merge·운영 배포를 자동 수행하거나 PR 생성만으로 승인을 추론하지 않는다.

## Codex Cloud / Local 발견

- Codex Cloud: 저장소의 `.agents/skills/spec-to-implementation` 항목을 통해 `skills/spec-to-implementation/SKILL.md`를 발견하도록 둔다. 프로젝트에 이 링크가 포함되어야 한다. 실제 세션에서 Skill이 로드됐는지 확인할 수 없다면 로드된 척하지 말고, 아래 Web 수동 흐름처럼 파일을 직접 참조한다.
- Codex Local: 저장소 루트에서 `make install-shared`를 실행하면 `~/.agents/skills/spec-to-implementation` 개별 링크를 설치한다. 기존 사용자 소유 경로가 있으면 설치기는 보존하고 충돌로 보고한다. 별도 Codex 설정·승인 권한은 변경하지 않는다.
- 프로젝트 링크가 없는 로컬 체크아웃에서는 `mkdir -p ~/.agents/skills` 후 `ln -s /path/to/oh-my-ai/skills/spec-to-implementation ~/.agents/skills/spec-to-implementation`를 사용할 수 있다. 대상이 이미 있으면 덮어쓰지 말고 충돌을 확인한다.

## ChatGPT Web 수동 대체 흐름

ChatGPT Web이 저장소의 `SKILL.md`를 자동 실행한다고 가정하지 않는다. Skill 미설치 또는 저장소 파일에 접근할 수 없는 대화에서는 사용자가 아래 지시를 메시지로 제공해 같은 절차를 수동 적용한다. 영구 개인 지침에 넣는 것은 별도 사용자 선택이며, 이 Skill이 자동 설치하지 않는다.

> 이 변경이 큰 기능·구조 변경인지 먼저 판단하고, 단순 질문·작은 수정이면 짧게 처리하세요. 큰 변경이면 Idea/Request를 요구사항과 검증 가능한 AC로 정리하고, 저장소에서 AGENTS·SSOT·API·Domain·DB 원본을 근거와 함께 확인하세요. Work-start 결과는 Candidate일 뿐 승인 명세가 아닙니다. Owner 결정이 필요한 항목과 Writer/독립 Reviewer 책임을 분리하고, 특정 명세·AC·계획의 Owner 승인을 받은 뒤에만 승인된 Writer가 구현하게 하세요. Writer와 다른 Reviewer가 diff와 검증 근거를 확인하고 PR Gate를 준비하세요. 실행하지 않은 검증은 NOT_RUN으로 표시하고, 결정 미해결·파일 충돌은 멈춰 보고하세요. 저장소 권한·승인 경계를 유지하고 Merge/배포를 자동으로 하지 마세요.

    keywords:
      ko:
        - 요구사항
        - 인수 기준
        - 승인된 명세
        - 독립 검수
      en:
        - acceptance criteria
        - approved specification
        - independent review
        - implementation plan
    use_when:
      - 새 기능이나 구조 변경처럼 여러 파일·계약·책임이 걸리고 구현 전 합의가 필요한 경우
      - 사용자가 요구사항 정리, 승인, 구현, 독립 검수까지 이어지는 작업을 요청한 경우
    do_not_use_when:
      - 단순 질문, 문구 변경, 작은 국소 수정처럼 별도 명세 절차가 과한 경우
      - 사용자가 아직 아이디어 탐색만 원하고 구현 준비를 요청하지 않은 경우
    requires:
      - substantial_change_or_explicit_workflow_request
---

# Spec to Implementation

## 적용 범위와 정지 조건

이 플레이북은 명세 검토가 필요한 큰 기능·구조 변경에만 사용한다. 단순 질문, 작은 버그 수정, 문구 변경에는 강제하지 않는다. 적용 여부가 모호하면 짧게 확인하고, 아이디어 탐색을 구현 요청으로 바꾸어 해석하지 않는다.

Owner는 제품·도메인·API·데이터 계약의 결정을 승인할 책임자다. Writer는 승인된 범위만 구현하고, Reviewer는 Writer와 다른 사람 또는 별도 세션이어야 한다. Owner 결정이 비어 있거나 파일 충돌·기존 미커밋 변경의 소유자가 불명확하면 해당 경계에서 멈추고 근거와 필요한 결정을 보고한다.

기존 사용자·저장소 권한, sandbox, 승인 및 Git 정책이 이 절차보다 우선한다. 이 Skill은 권한을 늘리지 않는다. 구현, 파일 변경, Commit, Push, PR 생성은 각각 현재 세션의 명시적 허용 범위 안에서만 수행한다. Merge와 배포는 별도 Owner Gate다.

## 절차

### 1. Idea / Request 정리

문제, 기대 결과, 사용자·운영자, 범위 안팎, 제약, 의존성, 알려진 가정과 미확정 질문을 분리한다. 외부 맥락이 필요하면 사용자에게 출처를 확인한다.

사용자가 `work-start`를 명시적으로 선택했다면 그 결과는 맥락 수집용 **Work-start Candidate**다. Candidate를 승인된 명세, Acceptance Criteria, Owner 결정 또는 구현 허가로 간주하지 않는다. Candidate의 Human Review 경계를 그대로 따른다.

### 2. 요구사항과 Acceptance Criteria

관찰 가능하고 검증 가능한 Acceptance Criteria를 작성한다. 각 기준에 성공 조건과 검증 방법을 연결하고, 범위 밖 항목·비기능 요구·호환성·실패 동작·롤백 필요성을 표시한다. 가정과 확정 사실을 구분하고, 추측은 결정으로 승격하지 않는다.

### 3. 기존 SSOT / API / Domain / DB 확인

현재 브랜치와 작업 트리를 확인하고 저장소의 `AGENTS.md`, 관련 코드·테스트·문서·프로젝트 맥락을 읽는다. API 계약, Domain 규칙, DB 스키마·마이그레이션의 원본(SSOT)을 찾아 경로와 근거를 명시한다. 찾지 못한 항목은 `NOT_VERIFIABLE` 또는 미확정으로 남긴다.

장기 설계 맥락을 기록·갱신할 때는 `project-context`를 재사용한다. 이 Skill 본문에 그 저장 정책을 복제하지 않는다. Read-only Git 사전 점검은 `git-work-preflight`의 명시적 소비자·호출 계약이 허용하는 경우에만 재사용하고, 그렇지 않으면 기존 권한 안에서 필요한 읽기 전용 확인만 한다. Preflight 성공도 명세 승인이나 변경 허가가 아니다.

### 4. Owner Decision과 책임 분리

Owner가 정해야 할 제품 동작, API 호환성, 데이터·마이그레이션, 보안·운영 트레이드오프를 질문과 선택지로 정리한다. 각 결정의 Owner, 상태, 선택, 근거를 기록한다. 결정이 구현 범위에 영향을 주면 추정으로 진행하지 말고 Owner 응답을 기다린다.

명세와 구현 계획을 함께 제시하고 **특정 버전의 명세·Acceptance Criteria와 범위에 대한 명시적 Owner 승인**을 받는다. 승인 전에는 구현을 시작하지 않는다. 사용자의 일반적인 아이디어 제시나 Work-start Candidate 검토는 이 승인이 아니다.

### 5. 구현 계획

승인된 명세를 기준으로 변경 파일·계약·작업 순서, 테스트와 데이터 변경·롤백 계획, 의존성, 위험 및 Reviewer가 볼 항목을 정리한다. 계획이 승인 범위와 다르면 구현 전에 다시 Owner 결정을 받는다. 기존 파일이 이미 변경됐거나 소유권이 불명확하면 덮어쓰지 말고 중단한다.

### 6. 승인된 Writer의 구현

Owner가 승인한 Writer만 승인된 계획·범위 안에서 구현한다. 시작 전 브랜치·작업 트리·기존 변경과 저장소 지침을 재확인한다. Owner 결정이 새로 필요하거나 승인 범위를 바꾸어야 하면 먼저 멈춘다. 실행한 검증은 결과와 함께 기록하고, 실행하지 못한 검증은 `NOT_RUN`으로 남긴다.

`AGENTS.md`, `MINE.md`, `skills/skill-index.json` 등 Generated Artifact는 원본을 수정한 뒤 프로젝트의 정식 생성 명령을 실행한다. 생성물을 직접 고치지 않는다. 이번 저장소에서는 Skill 원본·메타데이터 수정 후 `make instructions`를 실행한다.

### 7. 독립 Reviewer

Writer가 아닌 Reviewer가 승인된 명세·AC와 실제 diff를 대조한다. 최소 검수 범위:

- AC별 구현 및 검증 근거, 빠진 범위와 우발 변경
- SSOT·API·Domain·DB 계약과 호환성, 마이그레이션·롤백
- 경계값·실패 경로·권한 및 보안 영향
- 테스트 결과와 `NOT_RUN` 항목, 재현 가능한 검증 명령
- Generated Artifact가 원본에서 정식 재생성됐는지

Writer의 자체 검토는 독립 Review를 대체하지 않는다. 미해결 결함은 Writer에게 돌려보내고 수정 diff를 다시 검수한다.

### 8. PR 및 병합 Gate

PR을 만들 권한이 현재 명시적으로 허용된 경우에만 승인된 브랜치에서 PR을 만든다. PR에는 목적, 승인된 명세·AC와의 대응, 변경 요약, 실행한 검증과 `NOT_RUN`, 독립 Reviewer 결과, 남은 결정·위험을 적는다. 세션이나 Writer를 넘길 때는 기존 `handoff-prompt`의 수동 Handoff 흐름을 재사용하며, Handoff Candidate도 승인 자체가 아니다.

Owner는 PR의 변경·검증·Review를 확인한 뒤 별도로 병합을 결정한다. 이 Skill은 Merge·운영 배포를 자동 수행하거나 PR 생성만으로 승인을 추론하지 않는다.

## Codex Cloud / Local 발견

- Codex Cloud: 저장소의 `.agents/skills/spec-to-implementation` 항목을 통해 `skills/spec-to-implementation/SKILL.md`를 발견하도록 둔다. 프로젝트에 이 링크가 포함되어야 한다. 실제 세션에서 Skill이 로드됐는지 확인할 수 없다면 로드된 척하지 말고, 아래 Web 수동 흐름처럼 파일을 직접 참조한다.
- Codex Local: 저장소 루트에서 `make install-shared`를 실행하면 `~/.agents/skills/spec-to-implementation` 개별 링크를 설치한다. 기존 사용자 소유 경로가 있으면 설치기는 보존하고 충돌로 보고한다. 별도 Codex 설정·승인 권한은 변경하지 않는다.
- 프로젝트 링크가 없는 로컬 체크아웃에서는 `mkdir -p ~/.agents/skills` 후 `ln -s /path/to/oh-my-ai/skills/spec-to-implementation ~/.agents/skills/spec-to-implementation`를 사용할 수 있다. 대상이 이미 있으면 덮어쓰지 말고 충돌을 확인한다.

## ChatGPT Web 수동 대체 흐름

ChatGPT Web이 저장소의 `SKILL.md`를 자동 실행한다고 가정하지 않는다. Skill 미설치 또는 저장소 파일에 접근할 수 없는 대화에서는 사용자가 아래 지시를 메시지로 제공해 같은 절차를 수동 적용한다. 영구 개인 지침에 넣는 것은 별도 사용자 선택이며, 이 Skill이 자동 설치하지 않는다.

> 이 변경이 큰 기능·구조 변경인지 먼저 판단하고, 단순 질문·작은 수정이면 짧게 처리하세요. 큰 변경이면 Idea/Request를 요구사항과 검증 가능한 AC로 정리하고, 저장소에서 AGENTS·SSOT·API·Domain·DB 원본을 근거와 함께 확인하세요. Work-start 결과는 Candidate일 뿐 승인 명세가 아닙니다. Owner 결정이 필요한 항목과 Writer/독립 Reviewer 책임을 분리하고, 특정 명세·AC·계획의 Owner 승인을 받은 뒤에만 승인된 Writer가 구현하게 하세요. Writer와 다른 Reviewer가 diff와 검증 근거를 확인하고 PR Gate를 준비하세요. 실행하지 않은 검증은 NOT_RUN으로 표시하고, 결정 미해결·파일 충돌은 멈춰 보고하세요. 저장소 권한·승인 경계를 유지하고 Merge/배포를 자동으로 하지 마세요.
