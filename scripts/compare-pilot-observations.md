# 개발 실행 Pilot 비교

`node scripts/compare-pilot-observations.mjs < observations.jsonl`로 실행합니다. UTF-8 JSON 객체를 비교 기준과 비교 대상 순서로 한 줄씩 넣고 각 실행에 서로 다른 `runId`를 사용합니다. Lean은 `baseline`과 `lean`을, Context는 `resume`, `compact-resume`, `handoff` 중 서로 다른 두 경로를 비교합니다.

각 관측값의 `conditions`에 `scenario`, `scopeRevision`, `risk`, `runtime`, `runtimeVersion`, `model`, `reasoning`, `fast`(불리언), `window`, `controls`를 기록합니다. 실제 Runtime과 실효 설정을 사용합니다. 승인 범위·완료 기준, 시작·종료 기준, 입력·작업량, 측정·승인 조건을 확인해 같은 조건에만 같은 참조값을 부여합니다. 조건이 누락되거나 미확인 상태(`UNKNOWN` 및 상세 사유 포함)이거나 서로 다르면 `NOT_COMPARABLE`(종료 코드 1)을 반환합니다. 형식이 잘못되거나 크기 한도를 넘으면 종료 코드 2를 반환합니다.

`metrics`에는 `elapsedMs`, `sourceReads`, `validationRuns`, `reworkCount`, `agentInvocations`, `coordinationCalls`, `reports`의 관측값을 0 이상의 정수로 넣을 수 있습니다. 관측값이 빠지면 `UNKNOWN`을 반환합니다. `delta`는 비교 대상에서 기준값을 뺀 값입니다.

Codex 사용량을 비교할 때는 `conditions.runtime`을 `codex`로 쓰고 `agentId`와 기존 `scripts/role-usage.mjs`의 JSON 출력을 `usage`에 그대로 넣습니다. 수집 출처와 범위는 기존 stdin 수집 계약과 일치해야 합니다. 각 행의 Agent·Run 식별자와 수집 결과가 일치하고 두 실행의 역할이 같아야 합니다. 완전한 스키마로 선언된 단일 레코드와 두 누락 필드 목록을 함께 확인합니다. 재개 전 사용량의 누적 여부까지 확인해 관측 구간이 정확히 맞는 경우에만 `usageWindow`를 해당 `window` 참조로 지정합니다. 사용량이 누락·중복·불완전하거나 수신한 0의 의미가 확인되지 않으면 `UNKNOWN`으로 남깁니다. 결과의 토큰은 수신된 관측값입니다. 공식 사용량, 비용, 품질, 승인 결과는 각각 별도 근거가 필요합니다.

Context Pilot 전에는 Objective, 완료 기준, 승인, HEAD, Writer, 결과·Finding 참조와 다음 READY를 기존 Checkpoint/Handoff에 보존합니다. 재개 후 해당 내용이 일치하는지 확인한 뒤 비교합니다. Lean Pilot에서는 시간과 작업량의 차이를 해석하기 전에 필수 검증과 승인 결과를 확인합니다.
