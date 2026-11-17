---
name: 한글화
description: Explicit-only Korean sentence polishing contract that keeps meaning, numbers, links, code, paths, identifiers, and Markdown structure unchanged. Invoke only when the user types /한글화.
disable-model-invocation: true
metadata:
  source: born-here
  summary: 의미·수치·코드·링크·구조를 보존한 채 문장을 자연스러운 한국어로 변환
---

# /한글화 — 한국어 문장 변환

명시 호출 전용이다. 일반 텍스트, PR 본문, 문서에 단독으로 적용한다.

## 보존 대상 (변경 금지)
- 의미, 수치, 단위, 날짜
- URL, 링크, 인용
- 코드 블록과 인라인 코드
- 파일 경로, 식별자, SHA, 명령어
- 표·목록·Markdown 구조와 제목 레벨
- 고유명사 (서비스명, 제품명, 사람 이름)

## 할 일
- 번역투와 어색한 문장을 자연스러운 한국어로 바꾼다.
- 원문과 같은 문장 수와 항목 수를 유지한다.

## 하지 않을 일
- 요약, 내용 추가, 해석, 결론 변경을 하지 않는다.
- 근거 없는 완료 표현을 만들지 않는다.

## 출력
- 변환 결과만 준다.
- 사용자가 요청한 경우에만 변경 메모를 덧붙인다.

## 기준 참조
- 작성 원칙은 `skills/engineering-communication-ko/SKILL.md`와 `instructions/harness.md`의 "표현 원칙"을 따른다. 이 Skill에 복제하지 않는다.

## 위임 경계
- `/f1`과 `/dev-main-flow`는 이 Skill을 자동·반복 호출하지 않는다. 토큰 절약을 위해 사용자가 명시 호출한 경우에만 적용한다.
