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
