# Jira G3 Task — 안전한 활성화 준비표 (2026-10-22)

> STATUS: **REFERENCE_IMPLEMENTED / PRODUCTION_BLOCKED**. 이 문서는 적용 명령이 아니다.
> Policy SSOT: `ranikun-labs/harness-foundation-docs/docs/governance/jira-field-taxonomy.md` §8.0/§8.1 및
> `portfolio-work-management-governance.md`. 정책과 충돌하면 Foundation `main` 및 별도 Owner 결정을 따른다.

## 제3자가 30초에 이해해야 할 결론

- G1: Target 필드는 생성됨. G2: 승인된 기존 이슈 27건에 Target 분류값 저장, **Legacy가 계속 분류 권위**.
- PR #81: 새로운 Target 분류로 Jira 이슈를 만들기 위한 **Core 프로토콜** 병합 완료.
- 이 PR: **단일 Writer·단일 Host의 Reference Adapter + filesystem CAS Intent/Origin Ledger + Reader + Mock 테스트**. 실 서비스 배포·Jira 쓰기 없음.
- 아직 실제 Atlassian Connector, 인증된 G3 Activation/Metadata verifier, 운영 영속 볼륨, Board/Filter/Automation의 Authority Reader 연결이 없다.
- 따라서 **이 PR을 병합해도 G3 Task 실제 Create나 권위 전환은 금지**한다.

## 데이터 흐름

```text
Owner 별도 G3 승인 / Live Jira metadata + Type별 Activation Gate
  -> Trusted verifyGate (운영 구현 아직 없음)
  -> Intent CAS 'pending' (CreateRequestId로 wx + fsync)
  -> Jira Create 요청 ID당 최대 1회 *시도* (운영 transport 아직 없음)
  -> IssueKey 별도 불변 영속 연결
  -> Jira GET: Task/Target Product/Component/Concern 실제 저장값 확인
  -> Origin 별도 불변 영속 등록(create_ready/target/target)
  -> Reader: Origin + Jira GET 둘 다 일치해야 Target 분류 노출
  -> 실패/불명확/출처 누락: UNKNOWN_ORIGIN/none/frozen, 자동 retry 금지
```

**범위 한계:** `scripts/lib/jira-ticket-g3-file-ledger.mjs`는 `fs.open('wx')`와 파일·디렉터리 `fsync`로 같은 파일시스템의 중복 pending 등록을 방어한다. 다중 호스트, NFS/object storage, 컨테이너 휘발 저장소, 복제·백업·장애 복구 내구성을 입증하지 않는다. 로컬 참조 구현이며 운영 승인된 공유 영속 Ledger가 아니다. `createG3SupervisedAdapter`는 **의존성 주입 인터페이스**로 실제 Jira 접근이나 Owner 증명 검증을 제공하지 않는다. Mock `verifyGate`는 테스트에서만 허용된다. 실 운영에서는 Owner 승인·Activation·Policy SHA·Live Metadata를 외부 신뢰 원천에서 인증하는 Gate를 구현해야 한다.

Foundation 정책 경계: §8.0에 해당하는 Owner 승인 소량·단일 Writer·직렬 운영은 승인/검증 근거 링크가 연결된 버전관리 CSV/JSON 원장을 사용할 수 있으며, 전용 Registry 서버나 DB가 일률적인 선행 조건은 아니다. 무인·동시·복수 Writer·대량 운영은 §8.1 통제에 따라야 한다. 저장 방식을 선택해도 이 로컬 참조 구현만으로 운영 내구성이나 정책 적합성이 입증되지는 않는다.

## 실제 Runtime Capability 증거 (후속 보강, 미배포)

- 주입된 `jira.search/create/read` 함수의 **존재만으로 연결됨이라고 표시하지 않는다**. `createG3SupervisedAdapter` 생성 시 `capabilityEvidence`의 5개 항목 (`jira.search`, `jira.create`, `jira.read`, `jira.intent.persist`, `jira.origin.persist`) 각각에 `available=true`, `connection_verified=true`, 빈 값이 아닌 `evidence_ref`가 있어야 한다.
- Jira Search/Create/GET의 `jira_site_origin`은 Adapter의 `siteOrigin`과 일치해야 한다. 누락·다른 사이트·빈 증거면 **Adapter 생성 단계에서 차단**. 가짜 Jira/MCP 객체와 임의 evidence 문자열은 **테스트 전용**이다.
- **보안 경계:** 이 참조 구현은 `evidence_ref` 문자열의 발급자·서명·연결 진위를 자체 검증하지 않는다. 프로덕션 Connector는 *사용자 입력과 분리된 인증된 Runtime*에서 이 증거를 검증한 후 주입해야 한다. 따라서 이 보강만으로 운영 활성화 조건을 충족하지 않는다.
- 테스트: `node scripts/test-jira-ticket-g3-supervised-adapter.mjs` — 증거 없음, 타 Jira Origin, Ledger 증거 누락에서 원격 호출 전에 fail-closed. Node Native 실행 증거 없으면 **NOT_RUN**으로 보고한다.

## Trusted Gate 운영 계약

- `verifyGate({ stage: "intent", context })`는 외부 신뢰 원천에서 현재 Activation, Policy SHA, Live Metadata, 정확한 Owner 승인 범위를 확인하고 `allowed: true`, 비어 있지 않은 `evidence_ref`, 비어 있지 않은 `cutover_approval_ref`를 반환해야 한다. `cutover_approval_ref`는 해당 승인 기록에 연결된 안정적인 참조여야 한다.
- Adapter는 호출자가 보낸 승인 참조를 권위로 사용하지 않고 Intent Gate의 `cutover_approval_ref`를 immutable pending Intent에 저장한다. 값 누락/공백이면 Intent 저장과 Jira Create 전에 중단한다.
- `persistOrigin`은 Core가 보낸 승인 참조가 pending Intent와 정확히 같은지 확인하고, Ledger도 Origin 등록 및 Reader 경로에서 같은 값을 다시 대조한다. 불일치하면 Origin 등록을 거부하고 Reader는 `UNKNOWN_ORIGIN / none / frozen`을 반환한다.
- `evidence_ref`와 `cutover_approval_ref`는 감사 가능한 근거를 가리키는 식별자다. 식별자 문자열만으로 승인을 입증했다고 간주하지 않는다.

## Task(10010)만 실제 G3 시험할 때 필요한 Owner 결정

| 항목 | 현행(READ-ONLY 확인) | 변경/검증 예정 | 권한 |
|---|---|---|---|
| Legacy Product `customfield_10042` | Required, 기본값 있음 | Optional, default 해제, 기존 값 보존 | Jira Admin 별도 승인 |
| Legacy Component `customfield_10043` | Required, 기본값 있음 | Optional, default 해제, 기존 값 보존 | Jira Admin 별도 승인 |
| Legacy custom Labels `customfield_10044` | Required | Optional, 기본값 없음 유지 | Jira Admin 별도 승인 |
| Target Product `customfield_10108` | Optional, default 없음 | Task에서만 Required, 단일 옵션 | Jira Admin 별도 승인 |
| Target Component `customfield_10109` | Optional, default 없음 | Task에서만 Required, 단일 옵션 | Jira Admin 별도 승인 |
| Target Concern `customfield_10110` | Optional, 14개 옵션 | 0–3개 검증, 중복 방지, default 없음 | Metadata/실증 |
| 그 외 시작일·기한·커스텀 담당자 | 기존 필수 요건 | 승인된 실제 값과 계정·날짜 검증 | 시험 Create 별도 승인 |
| Issue Type | Epic/Task/Feature/Bug/Research 지원 | 우선 **Task 1개 유형만** | Owner 별도 승인 |

**Task만 설정 변경할 수 있는지**와 **Concern 0~3개 UI/API 제한**은 별도 검증 전까지 NOT_VERIFIED. Story/Subtask/Tech Debt는 이번 활성화에서 제외.

## 실행 이전 Gate — 순서 엄수

1. 이번 reference Draft PR의 별도 Native Node 테스트, 독립 Reviewer PASS, Owner Merge 승인을 완료한다.
2. 실제 운영 환경·단일 Writer, trusted `verifyGate` + Jira Search/Create/GET client, 정책 분류에 맞는 원장·정합성, 장애 후 조회/복구 경로를 정하고 구현한다. `readVerifiedClassification`을 실제 Reader/Board/Automation에 연결한다. 구현 PR과 독립 검수 증거를 제출한다.
3. 저장소·Jira 관리자 **READ-ONLY**: 현재 스키마/옵션/필수·기본값, Board/Filter/Automation, 권한·연동 Writer 상태, rollback export/복구 가능 여부를 재확인한다.
4. Owner가 **Task Admin 설정 변경** 범위·전환 시간·원상복구 방식을 명시 승인하면 Before export → 해당 유형 설정 변경 → Create Metadata GET 재확인. 미승인 변경 금지.
5. 시험 Create는 **Owner가 정확한 1건**을 별도 승인한 뒤 실행. 추천 표본: `RPL/Task(10010)`, `dev-harness(10027)/backend(10028)`, Concern `[]`, 제목 `[G3 TEST] Task Target Create 단일 생성 검증`. 실제 담당자/시작 날짜/기한/보존 정책을 Owner가 확정해야 한다.
6. 승인된 activation 기간과 `CreateRequestId`를 고정해 **pending CAS → Create 1회 → IssueKey link → Jira GET → Origin durable record → Reader parity → Board/Automation/Recovery**를 실제로 검증한다. 불명확 시 새 Create 금지.
7. 실제 성공한 Task 증거·실패 격리·복구를 Owner에게 보고한다. **G3 활성화(실사용 전환)는 별도 Owner Cutover 승인 전까지 금지**한다. G4 Legacy Field 삭제도 별도 Gate이다.

## 사고/격리

- Intent write 실패/기존 requestId: Jira Create **0회**. Ledger를 지우거나 requestId 변경으로 재시도하지 않는다.
- Jira Create timeout/응답 소실/IssueKey link 실패: `possibly_applied / UNKNOWN_ORIGIN / none/frozen`; 요청 ID 기준 기존 Jira·Ledger 상태를 Maintainer가 수동 조사한다.
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
