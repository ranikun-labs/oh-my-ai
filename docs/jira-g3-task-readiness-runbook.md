# Jira G3 Task — 안전한 활성화 준비표 (2026-10-22)

> STATUS: **REFERENCE_IMPLEMENTED / PRODUCTION_BLOCKED**. 이 문서는 적용 명령이 아니다.
> Policy SSOT: `ranikun-labs/harness-foundation-docs/docs/governance/jira-field-taxonomy.md` §8.0/§8.1 및
> `portfolio-work-management-governance.md`. 정책과 충돌하면 Foundation `main` 및 별도 Owner 결정을 따른다.

> **2026-10-27 최신 READ-ONLY 상태:** G2 118/118 저장 완료, Task Legacy/Target Admin 설정 PASS. 현재 Task Create는 Live Metadata Gate에서 차단된다. 실제 응답은 `{startAt,maxResults,total,fields:[{fieldId,...}]}`의 22개 필드이며 pagination bounds는 signed digest에 포함되고 불완전한 단일 페이지는 거부된다. wrapper `assignee`/`priority`/`labels`가 없고 `reporter`는 required/default 플래그만 있고 값이 없다. `customfield_10045`는 required/default account지만 현재 `allowedValues`가 없으며 `customfield_10015`/`duedate`도 required/default 없음. Issue Type ID `10010`의 현재 localized name은 `작업`. Exact Create preflight는 Search 전과 Intent/replay CAS 전에 검증된다. 누락 필드·계정 목록·기본값을 합성해 Gate를 통과시키지 않는다. 이 관측으로 Task Admin 설정을 재변경하지 않으며 실제 Create/Owner 승인 상태도 바뀌지 않는다.

## 제3자가 30초에 이해해야 할 결론

- G1: Target 필드는 생성됨. G2: 승인된 기존 이슈 **118/118**에 Target 분류값 저장, **Legacy가 계속 분류 권위**.
- PR #81: 새로운 Target 분류로 Jira 이슈를 만들기 위한 **Core 프로토콜** 병합 완료.
- 이 PR: Connector, 서명 Gate, filesystem CAS Intent/Origin Ledger, Reader를 통합하고 합성 Native fixture로 검증한다. 실 서비스 배포·Jira 쓰기 없음.
- Runtime의 실제 invokeTool 세션, signed evidence source, durable replay CAS, 운영 영속 볼륨, Board/Filter/Automation Reader 연결은 검증되지 않았다.
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
- **보안 경계:** 이 참조 구현은 `evidence_ref` 문자열의 발급자·서명·연결 진위와 freshness·expiry·provenance를 자체 검증하지 않는다. 프로덕션 Connector는 *사용자 입력과 분리된 인증된 Runtime*에서 증거 출처와 유효기간을 검증하고 Jira Site·Capability에 바인딩한 뒤 주입해야 한다. 따라서 이 보강만으로 운영 활성화 조건을 충족하지 않는다.
- 테스트: `node scripts/test-jira-ticket-g3-supervised-adapter.mjs` — 증거 없음, 타 Jira Origin, Ledger 증거 누락에서 원격 호출 전에 fail-closed. Node Native 실행 증거 없으면 **NOT_RUN**으로 보고한다.

## Trusted Gate 운영 계약

- `verifyGate({ stage: "intent", context })`는 외부 신뢰 원천에서 현재 Activation, Policy SHA, Live Metadata, 정확한 Owner 승인 범위를 확인하고 `allowed: true`, 비어 있지 않은 `evidence_ref`, 비어 있지 않은 `cutover_approval_ref`를 반환해야 한다. `cutover_approval_ref`는 해당 승인 기록에 연결된 안정적인 참조여야 한다.
- Adapter는 호출자가 보낸 승인 참조를 권위로 사용하지 않고 Intent Gate의 `cutover_approval_ref`를 immutable pending Intent에 저장한다. 값 누락/공백이면 Intent 저장과 Jira Create 전에 중단한다.
- `persistOrigin`은 Core가 보낸 승인 참조가 pending Intent와 정확히 같은지 확인하고, Ledger도 Origin 등록 및 Reader 경로에서 같은 값을 다시 대조한다. 불일치하면 Origin 등록을 거부하고 Reader는 `UNKNOWN_ORIGIN / none / frozen`을 반환한다.
- `evidence_ref`와 `cutover_approval_ref`는 감사 가능한 근거를 가리키는 식별자다. 식별자 문자열만으로 승인을 입증했다고 간주하지 않는다.

## 오프라인 Task Pilot 요청 모양 사전검사

`node scripts/jira-ticket-g3-task-pilot-dry-run.mjs <local-json-file>`은 RPL Task(10010)의 입력 모양과 생성될 Jira 요청을 로컬에서 미리 확인한다. 입력에는 현재 Task Create Metadata의 22개 필드와 페이지 정보, 14개 Ticket Contract 항목, Product/Component/Concern 선택값의 정확한 ID·`value`, 실제로 확정된 시작일과 마감일이 있어야 한다. 요청 본문은 실제 Core Create 요청과 같은 빌더로 생성한다.

이 명령은 Jira Connector를 만들거나 Jira를 호출하지 않는다. 입력 Metadata는 **호출자가 제공한 미검증 자료**이며 서명·소유자 승인·Activation·인증 세션을 검증하지 않는다. 출력 `PREVIEW_ONLY`는 실행 승인이 아니고, `execution_authorized`, Owner/Policy/Metadata 서명 검증은 false, Jira/Create 호출 수는 0이다. Task Create 값으로 `reporter`와 `customfield_10045`를 받지 않는다. Metadata의 people 기본값은 형상 검증에만 사용하고 출력하지 않는다. Synthetic fixture 통과는 Live Jira 검증이나 Pilot 승인으로 승격하지 않는다.

검증 명령은 `make test-jira-ticket-g3-task-pilot-dry-run`이며 `make test-jira-ticket-g3-integrations`에도 포함된다. 이 사전검사를 통과해도 실제 Search/Create, Intent CAS, Origin 등록, Reader 확인은 별도 Runtime·서명·Owner Gate를 통과하기 전까지 금지한다.

## 2026-10-28 Task Pilot 후보 — READ-ONLY / 미승인

현재 Jira RPL Task(10010) Create Metadata를 READ-ONLY로 다시 관측했다. 응답은 단일 페이지 `startAt=0`, `maxResults=100`, `total=22`였다. Target Product(10108)와 Component(10109)는 필수·기본값 없음이며 현재 옵션에 `dev-harness (10027)` 및 `backend (10028)`가 각각 존재한다. Concern(10110)은 선택 필드이고 14개 허용 옵션이 있다. 시작일(10015)과 기한(`duedate`)은 필수 날짜이며 기본값이 없다. Reporter는 required/default 플래그가 있지만 `defaultValue`/`allowedValues` 키가 없다. `customfield_10045`는 required/default 플래그와 기본값이 응답됐지만 `allowedValues`는 없다. 계정 기본값은 이 문서나 출력에 복사하지 않는다. 이 Rovo 응답은 읽기 전용 관측이며 서명된 Trusted Gate Metadata 증거가 아니다.

### Owner 검토 초안 — PROPOSED / NOT APPROVED

Jira `RPL` / Task(10010); Target Product `dev-harness (10027)`, Component `backend (10028)`, Concern `[]`; 시작일 `2026-10-29`, 기한 `2026-10-30`.

1. **Summary:** `[G3 PILOT] Target 분류 단일 Task 검증`
2. **Context:** G2의 기존 118건 Target 값 저장은 검증됐으나 신규 Task 생성 및 Target 권위 활성화는 미검증 상태다.
3. **Goal:** 신규 Task 한 건의 Target 분류 저장, 재조회, Origin 등록 및 Reader 권위를 검증한다.
4. **Source of Truth:** `harness-foundation-docs/docs/governance/jira-field-taxonomy.md` §8.0 및 `oh-my-ai/docs/jira-g3-task-readiness-runbook.md`.
5. **In Scope:** 승인된 단일 Task Pilot, 필수 필드 검사, Create 1회, 재조회, 영속 증거 기록, 실패 격리.
6. **Out of Scope:** 기존 118건 일괄 Cutover, Story/Subtask 이전, G4 레거시 삭제, 운영 자동 대량 생성.
7. **Acceptance Criteria:** 정확한 승인·필드·서명 증거와 pending 기록이 선행돼야 한다. Create 후 IssueKey, Target 값, Origin과 Reader 권위가 일치해야 한다.
8. **Repository:** `ranikun-labs/oh-my-ai`
9. **Base Branch:** `fix/jira-g3-capability-evidence-fail-closed-20261022`
10. **Expected Branch Name:** `feat/jira-g3-integration-offline-20261022`
11. **Dependencies:** PR #84 코드, Jira Task Metadata, 승인된 Owner·Activation 증거, 단일 Writer, 영속 Ledger와 복구 경로.
12. **Verification:** Core Dry-run → 승인 검증 → 생성 전 pending → Create 최대 1회 → GET → Origin/Reader 대조 → 실패 시 격리 및 수동 복구.
13. **Do Not Touch:** 기존 이슈 Legacy 값, G2 Snapshot, 미지원 유형, Board/Filter/Automation 운영 설정, G4 필드 삭제.
14. **Definition of Done:** 승인된 단일 Pilot이 생성되고 필드·Origin·권위 검증 및 감사 증거가 완료되었거나, 실패 상태가 중복 생성 없이 안전하게 격리되어야 한다.

이 초안은 **Owner 승인·서명·Create 권한이 아니다**. Core Description은 위 14개 항목 외에 Workflow Metadata 헤더 `Product`, `Primary Repository`, `Area`, `Assignee`, `Priority`, `Branch`, `PR`, `Current HEAD`를 포함해 생성된다. Project/Issue Type, Repository, Branch, PR, Current HEAD는 현재 업무에서 확인되며 Product는 Target 값 `dev-harness`를 제안값으로 쓸 수 있다. **논리적 Assignee와 Priority는 아직 제안되지 않았다.** Area는 현재 `Jira Migration`으로 사용할지 Owner 확인이 필요하다. 이 값들은 Jira Create의 assignee/priority wrapper로 전송되지 않지만 Core가 Description을 만들기 위해 필요하다.

따라서 현재 초안만으로는 전체 Core Description을 생성하거나 Offline Preflight를 통과시킬 수 없다. 필수 Workflow Metadata 중 논리적 Assignee와 Priority가 없고 Area도 Owner 확인 전이므로 Offline Preflight는 **NOT_RUN**이다. 이 값들을 임의로 채우지 않는다. 확정 뒤 Core가 만든 전체 Description을 초안의 핵심 설명과 함께 Owner가 검토해야 한다. **이번 초안은 아직 Create하지 않아 `NOT_CREATED`다.** Create 전 차단은 `NOT_CREATED / BLOCKED`로, Create 시도 후 결과가 불명확하면 실제 이슈가 생성됐을 수 있으므로 `POSSIBLY_APPLIED / QUARANTINED`로 보고하며 자동 재시도하지 않는다. 어느 격리 상태도 Pilot 성공이 아니다. Live Metadata의 Rovo 응답도 unsigned이므로 서명된 Gate 증거를 대신하지 않는다. 이 초안으로 Jira Create는 실행하지 않았다.

기존 `createG3FileLedger`는 같은 파일시스템에서 immutable JSON pending/link/origin 레코드, create-if-absent와 fsync를 구현하지만, Codex Cloud의 승인된 지속 볼륨·백업·복원 또는 Git 버전 이력을 보증하지 않는다. §8.0 경량 Fast Track은 별도 Registry 서버를 요구하지 않아도 되지만, 실제 실행 전에는 Owner가 durable 저장 경로와 증거 대장을 지정하고 pending 기록을 Create보다 먼저 남겨야 한다. 승인 없는 후보 행을 실제 실행 기록으로 만들지 않는다.

기존 Core/Gate/Adapter가 요청 digest·CreateRequestId·pending CAS·단일 Create·IssueKey link·GET/Target 대조·Origin·Reader와 불명확 결과 격리를 제공한다. 이 경로의 운영용 신뢰 발급원·durable replay/ledger 연결은 아직 검증되지 않았다. 기존 이슈 Cutover, Board/Filter/Automation의 실제 Legacy 소비처 export도 완료되지 않았으므로 G4 변경은 HOLD다.

## G3 Cutover 후보 색인 회수 — READ-ONLY / 미승인 (2026-10-28)

기존 조사에서 `oh-my-ai` 저장소에 103건 후보 Manifest가 없다고 보고했지만, 정본 G2 감사 자료는 **별도 저장소** `ranikun-labs/platform-services`의 `audit/jira-g2-full-118-20261023` 브랜치에 있었다. 증거 Commit `530dd0f88e5819158362b620ca1591779a50cba5`, `governance/jira-g2-full-118/final118-verification-20261023.json` (Blob `aea968a4dca76194b0de96db6fe20c1c20648470`)의 `current_118`를 읽기 전용으로 기계 분류했다.

[**G3 103건 후보 색인**](jira-g3-cutover-candidate-index-20261028.json)에는 지원 유형 Epic 8 / Feature 31 / Task 50 / Bug 5 / Research 9 = **103건**, Story 4·Subtask 8 = **12건 제외**, Origin 불명 `RPL-112/113/114` = **3건 격리**가 고정돼 있다. `RPL-122/124`는 해당 G2 118건 Snapshot 밖의 추가 보호 대상이다. **G2 데이터 저장값 검증을 재실행하거나 Cutover 승인으로 승격하지 않았다.**

이 색인의 `candidates` 103건은 **Issue Type 지원 여부만 분류한 정적 목록**이며 Cutover 적격·실행 승인 목록이 아니다. 같은 G2 Snapshot의 `statusCategory`로 추가 선별한 `cutover_scope_screen`은 완료 상태 **75건**과 정책상 폐기된 `RPL-40` **1건**을 기본 검토 대상에서 제외하고, 아직 미완료·비폐기인 **27건**만 추가 근거 수집 대상으로 남겼다. 이 27건도 **승인 0건 / Jira 현재 상태 미재조회**이며 `READ_ONLY / NOT_APPROVED`다. 역사적으로 완료된 76건을 제외한다는 Foundation 정책 수치와 이 Snapshot의 지원 유형 중 완료 상태 75건은 **서로 다른 집계 기준**이므로 혼동하지 않는다.

Owner의 정확한 Cutover 승인, 이슈별 Origin/Legacy Snapshot/동등성/Changelog/영향 보존 근거, 승인된 Reader 기록·Rollback은 별도로 필요하다. `RPL-112/113/114` 격리 및 G2 Snapshot 밖 `RPL-122/124` 격리도 유지한다. 이 파일만으로 `ReadAuthority`, `WriteAuthority`, Jira 상태·필드·설정을 변경하거나 G4 Legacy를 삭제하지 않는다.

## Task(10010)만 실제 G3 시험할 때 필요한 Owner 결정

### 후속 통합 코드의 검증 범위

- `jira-ticket-g3-jira-connector.mjs`: 현재 Plugin 도구의 Search/Create/GET 인자에 매핑하고, 별도로 주입된 세션 검증자의 Site/Cloud/Capability·유효기간 증거를 매 호출 전에 검사한다. 합성 응답만 검증했으며 실제 운영 인증·도구 응답 호환성·연결 상태는 **NOT_VERIFIED**다. Create 응답이 `{id,key,self}`뿐이거나 반환 Project/Summary/IssueType 근거가 부족하면 `possibly_applied`로 격리하며 자동 재시도하지 않는다.
- `jira-ticket-g3-trusted-gate.mjs`: 독립적으로 고정한 공개키로 Owner 승인·Activation·정책·실시간 Metadata의 서명과 기간·정확한 Preview/Create 범위를 검증한다. Legacy required/default와 필수 일정·담당자도 신뢰 Metadata로 확인한다. 기존 Target 읽기는 별도의 이슈별 서명 권한을 검증하므로 미래 Create의 만료·Rollback과 분리된다. 실제 발급자, 키 배포·폐기, 신뢰 원천 조회 및 영속 Replay CAS 연결은 운영 환경에서 별도 검증해야 한다. 테스트의 임시 서명자는 운영 Owner가 아니다.
- `jira-ticket-g3-ledger-recovery.mjs`: 기존 파일 원장과 별도 서명된 수동 복구 승인으로 알려진 IssueKey를 GET·대조하고 연결/Origin을 복구한다. Create/Search/Admin 호출은 없으며 손상·불일치·조회 소실 시 격리한다. 운영 원장 버전 보존·백업·복구를 대신하지 않는다.
- `jira-ticket-g3-authority-reader.mjs`: 인증된 Legacy 출처 resolver와 Target Origin+GET Reader를 결합한다. Legacy 다중 선택값은 전부 보존하고, 기존 이전 이슈는 별도 `cutover` 근거를 요구한다. 현 파일 Ledger는 `target_create`만 저장하므로 기존 이전 이슈에는 별도 검증된 Migration Reader가 필요하다. RPL-112/113/114는 항상 격리하고, UNKNOWN은 집계의 분류 건수에서 제외한다. Board/Filter/Automation 설정을 변경하는 코드는 없다.

```bash
make test-jira-ticket-g3-integrations
```

이 명령은 합성 Jira·임시 서명키·임시 원장만 사용한다. §8.0의 소량·단일 Writer·직렬 경량 대장 허용은 유지하며, 병렬 개발·테스트는 운영 동시 Writer 승인을 뜻하지 않는다. 이 통합 코드를 병합하더라도 실제 Connector 연결, Task Admin 변경, 시험 Create 최대 1건 및 G3 Cutover는 각각 Owner Gate를 통과해야 한다.

> 아래 Admin 표는 Task 설정 변경 전 계획 Snapshot이다. 2026-10-27 기준 Task Admin 변경은 완료되었으며, 상단 Live Metadata Gate 차단 상태가 현재 기준이다.

| 항목 | 당시 현행(READ-ONLY 확인) | 당시 변경/검증 계획 | 권한 |
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
