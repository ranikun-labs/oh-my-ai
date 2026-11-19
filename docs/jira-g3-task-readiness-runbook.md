# Jira G3 Task 운영 검증 준비

> STATUS: **REFERENCE_IMPLEMENTED / PRODUCTION_BLOCKED**. 이 문서는 적용 명령이 아니다.
> Policy SSOT: `ranikun-labs/harness-foundation-docs/docs/governance/jira-field-taxonomy.md` §8.0/§8.1 및
> `portfolio-work-management-governance.md`. 정책과 충돌하면 Foundation `main` 및 별도 Owner 결정을 따른다.

## 제3자가 30초에 이해해야 할 결론

- **개발 검증 완료:** #168에서 승인 검증·Jira Connector·원장 복구·Reader를 `dev`에 반영했다. 고정 HEAD의 Jira 전용 CI와 공용 Source 검사를 통과했다.
- **현재 설정 확인:** 2026-11-19에 RPL Task(10010) 생성 메타데이터를 읽기 전용으로 조회했다. 첫 페이지에 전체 19개 필드가 있으며 마감일은 선택이다. 동일 구조를 사용한 오프라인 미리보기에서 마감일을 생략할 수 있었다.
- **운영 시험 대기:** Connector를 호출하는 인증 실행 환경, 서명 발급원, 영속 원장, Reader 소비자 연결이 필요하다. 승인된 실 Jira Create·재조회나 권위 전환을 수행한 근거는 아직 없다.

근거: [개발 검증 #168](https://github.com/ranikun-labs/oh-my-ai/pull/168) · [운영 검증 원본 #84](https://github.com/ranikun-labs/oh-my-ai/pull/84) · [실행 기준 RPL-122](https://ranikunlabs.atlassian.net/browse/RPL-122).

## 데이터 흐름

```text
Owner 별도 G3 승인 / Live Jira metadata + Type별 Activation Gate
  -> Trusted Gate 서명·유효기간 검증 (운영 증거 공급원 연결 대기)
  -> Intent CAS 'pending' (CreateRequestId로 wx + fsync)
  -> Jira Create 요청 ID당 최대 1회 *시도* (운영 transport 아직 없음)
  -> IssueKey 별도 불변 영속 연결
  -> Jira GET: Task/Target Product/Component/Concern 실제 저장값 확인
  -> Origin 별도 불변 영속 등록(create_ready/target/target)
  -> Reader: Origin + Jira GET 둘 다 일치해야 Target 분류 노출
  -> 실패/불명확/출처 누락: UNKNOWN_ORIGIN/none/frozen, 자동 retry 금지
```

**범위 한계:** `scripts/lib/jira-ticket-g3-file-ledger.mjs`는 `fs.open('wx')`와 파일·디렉터리 `fsync`로 같은 파일시스템의 중복 pending 등록을 방어한다. 다중 호스트, NFS/object storage, 컨테이너 휘발 저장소, 복제·백업·장애 복구 내구성을 입증하지 않는다. 로컬 참조 구현이며 운영 승인된 공유 영속 Ledger가 아니다. `createG3SupervisedAdapter`는 **의존성 주입 인터페이스**로 실제 Jira 접근이나 Owner 증명 검증을 제공하지 않는다. Mock `verifyGate`는 테스트에서만 허용된다. Trusted Gate는 주입된 Owner 승인·Activation·Policy·메타데이터의 서명을 확인한다. 운영에는 실제 서명 증거 공급원과 고정 공개키를 연결해야 한다.

Foundation 정책 경계: §8.0에 해당하는 Owner 승인 소량·단일 Writer·직렬 운영은 승인/검증 근거 링크가 연결된 버전관리 CSV/JSON 원장을 사용할 수 있으며, 전용 Registry 서버나 DB가 일률적인 선행 조건은 아니다. 무인·동시·복수 Writer·대량 운영은 §8.1 통제에 따라야 한다. 저장 방식을 선택해도 이 로컬 참조 구현만으로 운영 내구성이나 정책 적합성이 입증되지는 않는다.

## 실제 Runtime Capability 증거 (후속 보강, 미배포)

- 주입된 `jira.search/create/read` 함수의 **존재만으로 연결됨이라고 표시하지 않는다**. `createG3SupervisedAdapter` 생성 시 `capabilityEvidence`의 5개 항목 (`jira.search`, `jira.create`, `jira.read`, `jira.intent.persist`, `jira.origin.persist`) 각각에 `available=true`, `connection_verified=true`, 빈 값이 아닌 `evidence_ref`가 있어야 한다.
- Adapter는 Jira Search/Create/GET과 사이트 주소의 일치를 확인한다. G3 Connector는 주입된 세션 검증기로 기능별 증거의 사이트 주소·Cloud ID·유효기간을 확인한다. 증거가 없거나 일치하지 않으면 생성 전에 중단한다. 가짜 Jira/MCP 객체는 테스트 전용이다.
- **보안 경계:** 운영 Host가 인증된 세션을 검증하고 Jira 호출 함수와 증거 공급원을 연결해야 한다. Adapter가 받은 `evidence_ref`는 추적용 참조다. Trusted Gate의 서명 검증은 고정 공개키를 사용한다.
- 테스트: `node scripts/test-jira-ticket-g3-supervised-adapter.mjs` — 증거 없음, 타 Jira Origin, Ledger 증거 누락에서 원격 호출 전에 fail-closed. Node Native 실행 증거 없으면 **NOT_RUN**으로 보고한다.

## Trusted Gate 운영 계약

- `verifyGate({ stage: "intent", context })`는 외부 신뢰 원천에서 현재 Activation, Policy SHA, Live Metadata, 정확한 Owner 승인 범위를 확인하고 `allowed: true`, 비어 있지 않은 `evidence_ref`, 비어 있지 않은 `cutover_approval_ref`를 반환해야 한다. `cutover_approval_ref`는 해당 승인 기록에 연결된 안정적인 참조여야 한다.
- Adapter는 호출자가 보낸 승인 참조를 권위로 사용하지 않고 Intent Gate의 `cutover_approval_ref`를 immutable pending Intent에 저장한다. 값 누락/공백이면 Intent 저장과 Jira Create 전에 중단한다.
- `persistOrigin`은 Core가 보낸 승인 참조가 pending Intent와 정확히 같은지 확인하고, Ledger도 Origin 등록 및 Reader 경로에서 같은 값을 다시 대조한다. 불일치하면 Origin 등록을 거부하고 Reader는 `UNKNOWN_ORIGIN / none / frozen`을 반환한다.
- `evidence_ref`와 `cutover_approval_ref`는 감사 가능한 근거를 가리키는 식별자다. 식별자 문자열만으로 승인을 입증했다고 간주하지 않는다.

## 현재 Task(10010) 생성 필드

| 필드 | 2026-11-19 읽기 전용 관측 | 실제 시험 준비 |
|---|---|---|
| Legacy 분류 3개 | Task 생성 메타데이터에 없음 | 기존 이슈의 값과 분류 권위를 보존 |
| Target Product·Component | 필수, 기본값 없음 | 시험 요청에서 현재 허용 옵션을 정확히 지정 |
| Target Concern | 선택, 14개 옵션 | 0~3개와 중복 방지는 G3 요청에서 검사 |
| 시작일·마감일 | 시작일 필수, 마감일 선택 | 시작일 지정. 마감일은 요청에 있는 경우 유효한 날짜 검사 |
| Reporter·커스텀 담당자 필드 | Jira 서버 기본값 사용 조건이 표시됨 | 명시 Reporter를 넣지 않고 서명된 현재 메타데이터로 기본값 계약 검증 |
| 시스템 담당자·우선순위·라벨 | Task 생성 메타데이터에 없음 | Jira 생성 요청에서 생략. 업무 설명의 논리 담당자·우선순위는 보존 |

이 관측은 Task 유형에만 적용한다. 조회의 `total`만으로 누락 여부를 판단하지 않는다. 필수·선택 필드를 모두 포함한 첫 페이지에서 실제 전체 필드 목록을 확인한다. 실행할 때는 현재 메타데이터를 읽고 서명된 증거와 대조한다. 설정 변경이 필요한 경우 변경 범위·원상복구를 별도로 승인받는다.

## 실제 단건 검증 순서

1. 기존 승인 범위와 단일 Writer를 확인한다. 인증된 Jira 세션 검증, 서명 발급원과 고정 공개키, 재시작 후 유지되는 원장 및 원자적 중복 예약을 연결한다.
2. 변경된 서명 형식으로 현재 Jira 주소·Cloud ID·Task 메타데이터를 함께 고정한다. 운영 키나 사용자 기본값을 검증 로그 또는 저장소에 복사하지 않는다.
3. 운영 연결을 읽기 전용으로 확인한다. Task 메타데이터, 실행 권한, 기존 원장과 연결된 Reader, Board·Filter·Automation, 복구 가능 여부를 확인한다.
4. 대상 Jira·필드·요청 내용·보존 방법을 정한 정확한 단건 시험을 별도 승인받는다. 같은 승인으로 진행할 수 있는 단계는 반복해서 승인받지 않는다.
5. 승인된 기간에 고정된 요청 ID로 검색 → Intent 원장 기록 → 최대 1회 Create 시도 → IssueKey 연결 → Jira GET → Origin 기록 → Reader 대조까지 확인한다. 결과가 불명확하면 동일 요청을 다시 보내지 않는다.
6. 실제 결과와 실패 복구 근거를 보존한다. 실사용 전환 및 Legacy 필드 변경 여부는 각각 기존 승인 경계를 따른다.

## 사고/격리

- Intent write 실패/기존 requestId: Jira Create **0회**. Ledger를 지우거나 requestId 변경으로 재시도하지 않는다.
- Jira Create timeout/응답 소실/IssueKey link 실패: `possibly_applied / UNKNOWN_ORIGIN / none/frozen`; 요청 ID 기준 기존 Jira·Ledger 상태를 Maintainer가 수동 조사한다.
- 유형 ID나 유형에 묶인 Origin 참조가 없는 기존 원장 기록은 보존하고 격리한다. 누락된 식별자를 추정해 보완하거나 요청 ID를 바꾸지 않는다. 기존에 확인된 IssueKey의 별도 서명 복구 절차는 유효한 원장 증거를 갖춘 경우에 GET 최대 1회와 Create 0회로 확인한다.
- Origin/Reader mismatch: 기존 Create를 다시 보내지 않는다. 실제 IssueKey·Snapshot·Changelog·Origin 증거를 보존하고 분류 Read/Write 중지.
- Admin 설정 롤백: 사전 export와 필수/default를 되돌린 뒤 Create Metadata 재조회. **이미 생성한 Target Issue를 자동 Legacy로 전환하지 않는다.**
- Codex Cloud/CI runner의 로컬 디스크가 재기동 뒤 유지된다고 가정하지 않는다. 파일 fsync != 운영 복원 검증.

## 자체 테스트

```bash
node scripts/test-jira-ticket-g3-supervised-adapter.mjs
make test-jira-ticket-fixtures
git diff --check
```

위 fixture는 임시 디렉터리 + 가짜 Jira·가짜 Owner Gate 사용. 실 Jira Create나 조직 Admin 호출이 없다.

## 정확한 멱등성 보장 범위

- **보장 후보(단일 공유 로컬 파일시스템·동일 RequestId):** pending Intent의 `wx` CAS가 성공한 Writer만 Jira Create 호출 단계로 진행하며, 동일 ID의 자동 재시도는 차단한다.
- **보장하지 않음:** Jira 서버 자체의 `CreateRequestId` 멱등 API, 전역/다중 호스트 exactly-once 생성, 다른 RequestId로 같은 이슈를 중복 요청하는 경우, 응답 소실 뒤 자동 결과 복구.
- **복구:** Create가 성공했지만 응답·IssueKey 연결을 잃으면 `possibly_applied / UNKNOWN_ORIGIN`으로 격리하고 Maintainer가 Jira와 대장을 수동 대조한다. Create 재실행은 금지.
- **권위 Reader:** 노출하는 두 Adapter Reader API 모두 Live Jira GET와 Ledger Origin 대조를 거쳐야 Target 값을 반환한다. Ledger 단독 조회는 특권 감사·복구 용도로만 사용한다.
