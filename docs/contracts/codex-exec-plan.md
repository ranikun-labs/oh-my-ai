# Codex exec 실행 계획 계약 (RPL-118 PR-1)

> **Status:** Draft, 순수 모듈 + Mock CLI 회귀만. 실제 Codex CLI/모델 호출, Writer Lease, 설치·배선은 **NOT_RUN / NOT_IMPLEMENTED**.

## 목적

`codex exec`로 무인 실행을 붙이기 전에, "무엇을 어떤 설정으로 실행했고 결과를 어떻게 믿을 것인가"를 결정적으로 검증할 수 있게 한다. 모델/effort가 조용히 바뀌거나, PATH 하이재킹, 잘린 스트림이 성공으로 오인되는 사고를 PR-1에서 차단한다.

- `scripts/lib/codex-exec-plan.mjs` — 프로세스를 띄우지 않는 순수 함수
- `fixtures/codex-exec/mock-codex-exec.mjs` — JSONL 시나리오를 내는 Mock CLI (실제 codex 아님)
- `scripts/test-codex-exec-plan.mjs` / `make test-codex-exec-plan` — 25개 회귀

## 구성 요소

| 함수 | 역할 |
| --- | --- |
| `assembleCodexExecCommand` | new/resume argv 배열 조립. 쉘 문자열 없음, 프롬프트는 stdin(`-`), 알 수 없는 옵션 거부 |
| `resolveCodexExecutable` | explicit path 또는 PATH에서 신뢰 가능한 `codex` 해석 (fs/env/platform 주입) |
| `createJsonlParser` / `parseJsonl` | chunk 경계·CRLF 허용, malformed/truncated 표시 |
| `compareRequestedVsReported` | 요청 vs CLI 보고 model/effort → MATCH / MISMATCH / UNKNOWN |
| `classifyCodexExecRun` | SUCCESS / UNVERIFIED_CONFIG / FAILED / CANCELLED / UNKNOWN 분류 (+ `approvalBlocked`, `autoFollowUpAllowed`) |

## 불변식

1. **model/effort는 필수, 기본값 없음.** `policy.models`/`policy.efforts` allow-list 밖이면 거부. effort allow-list는 RPL-116 `agent-manifest-guard`의 reasoning 목록(`low|medium|high|max`) 사본(`RPL116_REASONING_ALLOWLIST`)을 쓸 수 있으며, 테스트가 실제 guard와 동등성을 검증한다. 모델 allow-list는 공개 소스에 하드코딩하지 않고 호출자가 넘긴다. 자동 매핑(`xhigh` 등) 없음.
2. **cwd는 절대 경로, sandbox/approval은 명시.** sandbox는 `read-only|workspace-write`만(`danger-full-access` 거부). cwd는 argv가 아니라 spawn cwd로 전달.
3. **값 주입 차단.** model/effort/sessionId는 선행 `-`·공백·따옴표 없는 토큰만. 프롬프트는 argv에 넣지 않는다.
4. **실행 파일 해석은 fail-closed.** 절대 경로, 일반 파일, (POSIX) 실행 비트. 빈/상대 PATH 항목과 cwd(작업공간) 내부 후보 거부. Windows는 PATHEXT∩{`.exe`,`.cmd`}만, 대소문자 무시 `Path`, 따옴표 항목 처리. `.cmd` shim은 `shell:false`로 직접 spawn할 수 없으므로 `allowCmdShim: true`일 때만 허용하며 `cmdShim:true`로 표시(쉘 문자열로 우회 금지).
5. **MISMATCH는 조용히 수용하지 않는다.** 보고 설정이 요청과 다르면 exit 0이어도 `FAILED`로 격상. 보고가 없어 비교가 `UNKNOWN`이면 exit 0 + 완료 이벤트여도 `SUCCESS`가 아니라 **`UNVERIFIED_CONFIG`** 로 분류한다(`approvalBlocked:true`, `autoFollowUpAllowed:false`). 설정을 검증하지 못한 실행은 승인 근거로 쓰지 않고 자동 후속 실행도 막는다(Owner 결정). 계약은 별도 outcome 방식 하나로 고정(SUCCESS+플래그 방식 아님).
6. **SUCCESS는 좁다.** exit 0 + 신호/타임아웃 없음 + malformed/truncated 없음 + `turn.completed` 존재 + 실패/취소/`error` 이벤트 없음 + MISMATCH 아님. `requested`가 있고 비교 MATCH일 때만 `autoFollowUpAllowed:true`(`requested` 미전달 시 비교 자체를 안 한 것이므로 SUCCESS 유지). 비정상 exit → FAILED, 종료 이벤트 없음/절단/exit 정보 없음/타임아웃 → UNKNOWN.
7. **자동 재시도 없음.** 모든 결과에 `autoRetry:false`. UNKNOWN은 부작용 여부를 모르므로 사람/상위 정책 판단 전 재실행 금지.

## UNVERIFIED 가정 (실제 Codex CLI로 검증하지 않음)

- `-c key="value"` 오버라이드 키: `model`, `model_reasoning_effort`, `sandbox_mode`, `approval_policy`
- `codex exec resume <session-id> --json ... -` 형태 및 stdin 프롬프트(`-`)
- JSONL 이벤트: `thread.started{thread_id}`, `turn.completed`, `turn.failed`, `turn.cancelled|turn.aborted`, `error`
- 설정 보고 필드 `model`, `reasoning_effort`가 이벤트에 실린다는 점 (실제 CLI가 보고하지 않으면 항상 UNKNOWN이 되어 설정 검증 근거가 못 된다)
- Windows `.cmd`/`.exe` 동작은 가짜 fs로 시뮬레이션했을 뿐 실제 Windows 실행은 NOT_RUN

## 하지 않는 것 (NOT done)

- 실제 `codex`/모델 호출, 실제 Runtime E2E
- Writer Lease / 동시 실행 방지 / 소유권 관리
- 프로세스 spawn·타임아웃·종료 처리 (호출자 몫; 분류기는 결과만 받는다)
- 기존 App Server 어댑터(`pending-handoff-codex-runtime-adapter.mjs`) 재사용·수정 — **평가만** 한다(아래 부록)
- 설치/배선, `make test-v1-fixtures` 편입

## 부록: 기존 App Server 어댑터의 Windows ENOENT 가능성 (코드 추론, 확정 결함 아님)

`pending-handoff-codex-runtime-adapter.mjs`의 `APP_SERVER_EXECUTABLE = "codex"`는 `defaultSpawnAppServer`에서 `nodeSpawn("codex", argv, { shell: false })`로 그대로 전달된다. 코드상 PATH 해석·PATHEXT 처리가 없다.

- Windows에서 npm 전역 설치 Codex가 `codex.cmd` shim 형태라면, `shell:false` spawn은 확장자 없는 `codex`를 찾지 못해 `ENOENT`가 날 **가능성이 있다**. 다만 `codex.exe`(네이티브 배포)이거나 CreateProcess가 `.exe`를 붙여 찾는 경우에는 발생하지 않을 수 있어, 설치 방식에 따라 다르다. 실제 Windows에서 재현하지 않았으므로 **확정 결함이 아니다 (UNVERIFIED)**.
- 이 PR의 `resolveCodexExecutable`을 앞단에 두면 PATH/PATHEXT를 거쳐 절대 경로 `.exe`를 얻거나, `.cmd`만 있을 때 `CMD_SHIM_UNSUPPORTED`로 **원인을 명시적으로 드러낼 수** 있다. 단 `.cmd`는 Node(`shell:false`)에서 직접 실행할 수 없어(EINVAL) 해석기만으로 해결되지 않으며, `.cmd`를 위한 별도 launch 설계가 필요하다.
- 어댑터는 `spawnAppServer`를 주입받는 구조이므로, 호출 측에서 `{executable}`을 해석된 절대 경로로 대체하는 통합이 가능해 보이나 어댑터가 `executable`을 고정 상수로 넘기는 지점은 확인이 필요하다. 변경은 별도 PR/평가 대상이며 PR-1에서 수정하지 않았다.
