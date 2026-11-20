# F1 종료 시점 형식 확인

Codex와 Claude Code에서 지원되는 `Stop` 이벤트를 받아 최종 보고의 형식을 확인하는 선택형 Hook 후보입니다. 기존 F1 검사기를 재사용하며, `서비스 기능`과 `이번 변경` 제목이 모두 있는 응답을 검사합니다. F1이 필수인 실행의 호출부에서만 Hook 프로세스에 `OH_MY_AI_EXPECT_F1=1`을 전달하면 제목이 전부 빠진 응답도 검사합니다. 일반 대화가 함께 실행되는 전역 설정에는 이 값을 지정하지 않습니다. 실제 테스트 성공 여부는 실행 근거에서 확인합니다.

Git 메타데이터가 있는 하네스 체크아웃과 Git 프로젝트에서 자동 연결을 지원합니다. 프로젝트의 `UserPromptSubmit` 및 `Stop`이 같은 세션 ID·턴 ID를 제공하면, 첫 토큰으로 명시 호출한 `$dev-main-flow`의 종료에서 제목이 전부 빠져도 검사합니다. 호출부는 원문 대신 ID 해시만 보관하며 해당 턴의 종료는 한 번 처리합니다. Codex Hook의 문서화된 입력에는 두 ID가 있습니다. Claude Code의 문서화된 입력에는 턴 ID가 없으므로 기본 F1 형식 감지 또는 격리된 실행의 명시 신호를 사용합니다. ID가 없거나 선택 이벤트가 프롬프트 문자열에 명시 토큰을 제공하지 않으면 이 자동 연결을 확인할 수 없습니다.

아래 `hooks` 항목을 대상 클라이언트의 기존 Hook 설정에 추가할 수 있습니다. 이미 `UserPromptSubmit`에 같은 명령이 등록돼 있으면 해당 등록을 재사용합니다. 예시는 Codex용입니다. Claude Code에서는 `codex`를 `claude`로 바꿉니다. Hook을 실행하는 환경에서 `oh-my-ai`를 찾을 수 있어야 합니다.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "oh-my-ai hook codex UserPromptSubmit" }] }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "oh-my-ai hook codex Stop"
          }
        ]
      }
    ]
  }
}
```

형식 누락을 찾으면 `systemMessage`로 누락 건수를 안내합니다. 정상 보고, 일반 응답, 재진입 이벤트는 빈 JSON 객체로 처리합니다. Hook은 추가 모델 턴을 요청하거나 응답을 차단하지 않습니다.

`node scripts/test-f1-stop-advisory.mjs`로 입력별 동작을 확인합니다. 실사용 검증 때는 대상 클라이언트와 버전, 활성 Hook 설정, 경고 표시 여부, 추가 턴이 생성되지 않았는지를 기록합니다. 공식 사용량이나 검수 판정이 보고에 들어가면 해당 실행 식별자까지 대조합니다.

[Codex Hooks](https://developers.openai.com/codex/hooks) · [Claude Code Hooks](https://code.claude.com/docs/en/hooks)

## Codex App Server 사용량 관측

직접 App Server 프로세스를 시작하는 클라이언트는 실행 명령으로 `node scripts/codex-app-server-f1.mjs`를 사용할 수 있습니다. 기존 인증과 환경 변수를 사용하는 `codex app-server --stdio`를 시작합니다. 표준 출력의 RPC는 그대로 전달하고 F1 사용량 행은 표준 오류에 출력합니다. 기존 Codex UI나 관리형 서버는 이 실행 경로를 선택했을 때만 연결됩니다.

완료 이벤트 직전까지 받은 같은 스레드·턴의 최신 `last`만 표시합니다. 이 값은 같은 턴 ID로 수신한 스냅샷입니다. Codex가 값을 새로 받지 못하면 이전 값이나 추정값이 남을 수 있습니다. 턴 전체 사용량은 UNKNOWN으로 표시합니다. 마지막 사용량 이벤트가 없거나 형식이 잘못되면 관측값은 `UNKNOWN`입니다. 완료 이후에 들어온 이벤트는 재생된 기록일 수 있어 포함하지 않습니다. RPC 프레임이 4 MiB를 넘으면 그 연결의 사용량 관측만 중단하고 RPC 전달은 유지합니다. 인증 여부, 실효 모델, 비용과 청구 값은 이 도구에서 확인하지 않습니다.
