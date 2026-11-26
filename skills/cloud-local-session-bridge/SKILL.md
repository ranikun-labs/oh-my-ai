---
name: cloud-local-session-bridge
description: Use when a Claude Code cloud session must reach the owner's own computer (Mac mini, Windows, WSL2) or a local/Remote Control session on it — to hand off work, send a prompt, or receive results — or when such a connection "doesn't work". Diagnoses which direction is blocked (folder attach, session listing, message send) and the owner approval each needs, instead of retrying blindly or falling back to copy-paste too early.
metadata:
  source: born-here
  summary: 클라우드 세션과 로컬(Mac·Windows) 세션 사이 연결이 막힐 때 막힌 방향을 진단하고 필요한 승인만 받아 인계하는 플레이북
  routing:
    visibility: contextual
    risk_level: medium
    task_types:
      - handoff
      - session-transfer
    triggers:
      - kind: keyword
        values:
          - 로컬 세션
          - Mac 세션
          - 세션 간 통신
          - Remote Control
          - 클라우드 연결
      - kind: intent
        values:
          - reach_local_session_from_cloud
    keywords:
      ko:
        - 로컬 세션
        - 맥미니
        - 세션 간 통신
        - 원격 연결
      en:
        - remote control
        - cross-session
        - local session
    use_when:
      - 클라우드 세션이 사용자 컴퓨터의 로컬 세션에 인계하거나 결과를 받아야 하는 경우
      - 클라우드와 로컬 세션 사이 메시지나 폴더 연결이 거절된 경우
    do_not_use_when:
      - 같은 세션 안에서 서브에이전트에 일을 맡기는 경우
    requires:
      - session_ids
---

# Cloud ↔ Local session bridge

클라우드 세션(claude.ai/code)과 사용자의 컴퓨터(Mac mini, Windows 등)에서 도는 로컬 세션 사이에 일을 넘기거나 결과를 받을 때 쓰는 플레이북이다.

## 먼저 알아둘 것: 통로는 세 개이고 각각 따로 막힌다

| 통로 | 도구 | 막히는 흔한 이유 |
|---|---|---|
| A. 폴더 연결 (클라우드에서 로컬 파일·명령 실행) | `list_computer_folders` → `request_computer_folder` | 폴더가 `cannot_be_used: not_available`. 홈 바로 아래 숨김 폴더나 `~/Library` 안에 있거나, 그 컴퓨터의 Claude 앱이 오래됨 |
| B. 로컬 → 클라우드 메시지 | 로컬 세션의 `ListAgents`·`list_sessions` → `SendMessage` | 클라우드 세션 이름은 로컬 목록에 안 보일 수 있다. **세션 ID**(`session_...`)로 찾는다 |
| C. 클라우드 → 로컬 메시지 (기존 세션) | 클라우드의 `mcp__claude-code-remote__send_message`(session_id) | 클라우드의 `ListAgents`에는 로컬 세션이 안 보인다. `SendMessage`로 보내면 401. remote `send_message`는 `elevated_session_untrusted_device`로 거절된다 |

카페인·tmux는 Mac을 깨워 두고 프로세스를 유지할 뿐이다. A·C의 권한 문제는 해결하지 않는다.

## 가장 확실한 길: 로컬 기기에 새 세션을 만든다 (create_session)

기존 로컬 세션에 메시지를 보내면, 받는 쪽은 그 메시지를 동료 세션의 데이터로만 취급한다. 그래서 사용자가 그 세션에서 다시 승인해야 한다.
`create_session`으로 그 기기에 **새 세션**을 만들면 사정이 다르다. 넘긴 prompt가 그 세션의 첫 작업으로 바로 실행되고, 결과는 `send_message`로 부모 세션에 돌아온다.

1. `list_sessions`에서 `environment_kind: "bridge"`인 로컬 세션을 찾고, `get_session`으로 그 세션의 `environment_id`(예: Mac mini bridge 환경)를 얻는다.
2. 처음 한 번은 `confirm_repository_trust`로 신뢰 승인을 받는다(아래 3절과 같은 절차).
3. `create_session(environment_id=<bridge 환경>, model, title, prompt=<할 일 전체와 회신 방법>)`을 호출한다. 생성된 세션은 `parent_session_id`로 부모에 묶인다.
4. 그 기기에서 Claude 앱이나 `claude remote-control`이 켜져 있어야 한다. 꺼져 있으면 세션이 "연결 대기"로 남는다.
5. 폴더 직접 연결(`request_computer_folder`, 폴더가 `not_available`)과는 다른 경로다. 폴더가 막혀 있어도 bridge 환경으로 세션 생성과 메시지는 동작한다.
6. 키 입력, 실제 모델 호출, 배포처럼 사람이 확인할 단계는 prompt 안에 "그 시점에 사용자를 불러라"로 명시한다.

이미 진행 중인 로컬 세션(작업트리, 대기 상태 보유)이 있으면 새로 만들지 말고 그 세션을 이어 쓴다. 중복 세션은 같은 작업을 두 번 실행할 위험이 있다.

## 절차

1. **방향부터 확인한다.** 클라우드에서 `ListAgents`, `list_computer_folders`를 각각 한 번씩만 호출한다. 결과를 표로 남긴다. 같은 호출을 반복하지 않는다.
2. **B를 먼저 연다.** 사용자에게 로컬 세션에서 아래를 실행하도록 한 줄로 안내한다.
   `list_sessions로 클라우드 세션 <session_id>를 찾아 "연결 확인"을 보내.`
   메시지가 오면 `from` 값에서 로컬 세션 ID(`bridge:session_...`)를 얻는다.
3. **C를 연다.**
   - 클라우드에서 `mcp__claude-code-remote__send_message`로 그 session_id에 보낸다. 앞의 `bridge:`는 뗀다.
   - `elevated_session_untrusted_device` 거절에 `content_digest`가 있으면 `confirm_repository_trust`를 그 digest로 **한 번** 호출한다. 이 호출이 곧 승인 카드라서 채팅으로 먼저 묻지 않는다.
   - 승인되면 같은 전송을 **새로** 한 번 다시 보낸다. 승인했다고 거절된 전송이 자동으로 다시 나가지 않는다.
   - 승인하면 이 클라우드 세션은 신뢰된 기기 전용으로 영구 제한된다. 되돌릴 수 없으니 결과 보고에 적는다.
4. **A는 필요할 때만 연다.** 클라우드가 로컬 파일을 직접 만져야 할 때만 쓴다. `not_available`이면 원인 두 가지(앱 업데이트, 숨김 경로 아닌 폴더를 Remote Control 목록에 추가)만 안내하고 멈춘다. 폴더를 연결하면 그 뒤로 다른 세션에 메시지를 보낼 수 없게 되므로, C가 필요하면 C를 먼저 쓴다.
5. **모두 막히면** 붙여 넣을 인계 프롬프트 전문을 한 번 출력하고 멈춘다. `handoff-prompt` 스킬을 참고한다.

## 승인 프롬프트를 줄이는 법

- **클라우드 쪽 신뢰 승인**(`confirm_repository_trust`): 세션마다 한 번만 받으면 영구 적용된다. 같은 세션에서 다시 묻지 않는다. 새 클라우드 세션은 다시 한 번 받는다.
- **로컬 받는 쪽:** 메시지에 `from-mode="prompting"`이 보이면, 그 로컬 세션이 다른 권한 모드라서 받은 메시지를 사용자 승인 대기로 묶는다. 로컬 세션을 Auto 등 같은 권한 모드로 맞추면 대기가 줄어든다.
- **클라우드 쪽 도구 확인:** 프롬프트 옆 모드에서 Auto를 고르면 대부분의 도구 호출이 확인 없이 실행된다. 특정 명령만 허용하려면 저장소 `.claude/settings.json`의 `permissions.allow`에 넣고 커밋한다. 저장소가 하나인 세션만 이 파일을 읽는다.
- 위험한 승인(키 입력, 실제 모델 호출, 배포)은 계속 사람이 확인한다.

## 인계 메시지 규칙

- 첫 줄에 보낸 세션(이름과 session_id)과 "사용자 지시에 따른 인계"임을 적는다. 받는 쪽은 이 메시지를 사용자 입력이 아니라 동료 세션의 요청으로 받는다.
- 고정 SHA·tree, 범위, 금지사항, 회신 형식(한국어 F1)을 메시지 하나에 담는다.
- 비밀값, 키, 질문·답변 원문은 넣지 않는다. 키가 필요하면 로컬 터미널 숨김 입력(`read -rs`)으로 받는다.
- 전송 결과가 `delivered`여도 상대가 읽었다는 뜻은 아니다. "전달됨, 읽음 미확인"으로 보고한다.

## 하지 말 것

- 거절된 호출을 같은 방식으로 반복하지 않는다(`execution-recovery`와 같은 원칙).
- 권한 승인을 다른 세션에 대신 받게 하지 않는다(permission laundering).
- 막혔다고 로컬 결과를 추정하거나 지어내지 않는다.
- 다른 세션의 기록 읽기(`list_events`)가 거절되면, 사용자가 신뢰된 기기에서 그 세션을 열도록 안내한다.

## 사례 (2026-11-26)

- **증상:** 클라우드 메인 세션 → Mac mini "하이" 세션으로 인계가 안 됨.
- **원인:**
  1. 클라우드 `ListAgents`에 로컬 세션이 0개로 보임.
  2. Mac 폴더 3개가 모두 `not_available`.
  3. `SendMessage`는 401.
  4. remote `send_message`는 `elevated_session_untrusted_device`로 거절.
- **해결:**
  1. Mac 세션이 `list_sessions`로 클라우드 세션 ID를 찾아 "연결 확인"을 보냈다(B 열림).
  2. 클라우드에서 `confirm_repository_trust`를 호출했고, 사용자가 카드에서 허용했다.
  3. 같은 메시지를 새로 보내 `delivered`를 받았다(C 열림).
