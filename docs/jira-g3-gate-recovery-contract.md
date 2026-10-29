# G3 승인 Gate 및 수동 Ledger 복구 계약

이 문서는 `scripts/lib/jira-ticket-g3-trusted-gate.mjs`와 `scripts/lib/jira-ticket-g3-ledger-recovery.mjs`의 오프라인 연동 경계를 정의한다. Jira, Owner, Policy, Activation 또는 replay-claim 연결은 제공하지 않는다. 실제 연동은 caller context와 분리된 신뢰 가능한 source와 별도로 고정한 공개키를 주입해야 한다.

## 서명 증거와 Gate

`createG3TrustedGate({ source, trustedKeys, now, maxEvidenceAgeMs })`는 어댑터가 호출하는 `verifyGate({ stage, context })`를 반환한다. source가 반환하는 각 증거는 다음 형태의 Ed25519 envelope이며, 서명은 정렬된 JSON key와 순서가 보존된 array를 사용하는 UTF-8 canonical JSON에 적용한다.

```json
{
  "key_id": "pinned-key-name",
  "payload": { "kind": "g3_activation" },
  "signature": "base64-ed25519-signature"
}
```

`key_id`는 Gate의 `trustedKeys`에서만 해석한다. caller가 보낸 승인 boolean, 참조 문자열, metadata 복사본은 권한 근거가 아니다. 서명 payload의 `issued_at`/`expires_at`은 UTC 시각이어야 하며 미래 발급, 오래된 증거, `now >= expires_at`은 거부한다. Activation의 `effective_to`와 metadata `observed_at`도 별도로 확인한다. source await 뒤와 허용 반환 직전에 만료·범위·metadata 신선도를 다시 확인한다.

필수 `source` 메서드는 모두 서명 envelope를 반환한다.

| 메서드 | 용도 |
|---|---|
| `fetchActivation({ activation_ref, project, issue_type })` | Intent/Create/read/Origin의 유형별 Activation |
| `fetchCurrentActivation({ project })` | 검색 전 현재 Create 경로 확인 |
| `fetchPolicy({ policy_sha256 })` | Activation이 지정한 현재 Policy |
| `fetchLiveMetadata({ project, issue_type })` | caller 설정과 분리된 Jira Create metadata |
| `fetchOwnerApproval({ approval_ref, create_request_id })` | 해당 Intent와 완전한 Create body에 대한 Owner 승인 |
| `claimReplay({ claim_key, activation_ref, create_request_id, approved_preview_id, expires_at })` | 재시작·다른 Gate 인스턴스 간 원자적 단일 사용 예약 |
| `fetchReadAuthority({ issue_key })` | 이미 생성된 개별 이슈에 대한 유형별 기간과 독립된 Target 읽기 권한 |

Activation은 `status: "active"`, 프로젝트/유형/ID, ledger, 고유 `request_id`, Preview digest, 허용 operation, Policy/metadata digest, 승인 참조와 유효 기간을 묶는다. Policy는 Activation과 digest가 일치하고 `mode: "single_supervised"`여야 한다. metadata digest는 `g3EvidenceSha256({ project, issue_type, issue_type_id, startAt, maxResults, total, fields })`이며 Activation snapshot과 일치해야 한다. Rovo의 원본 `fields[]` 배열과 pagination envelope는 서명/digest 검증 전에 재정렬하거나 keyed object로 바꾸지 않는다. Gate는 한 페이지(`startAt === 0`, `total === fields.length`, `maxResults >= fields.length`)만 받으며 다중 페이지를 합친다고 주장하지 않는다. 검증 뒤에만 고유 `fieldId` 기준 내부 조회 map으로 변환하며 누락/중복 ID는 거부한다.

Task Type binding은 canonical `Task` → 현재 signed Type ID `10010` → metadata `issuetype.allowedValues`의 정확히 하나인 `name` 순서로 검증한다. Intent Gate가 발급한 binding은 pending Intent에 Type ID와 함께 보존하고, Create Gate와 Connector도 같은 binding을 확인한다. Search 전에 exact Create preflight를 metadata와 대조하고, Intent 및 replay CAS 전에 같은 Owner-approved request digest와 필수 wrapper/account/default 값을 다시 검증한다. 이 preflight는 durable Intent에 복사하지 않는다. 선택 wrapper `assignee`/`priority`/`labels`는 metadata에 없고 승인 요청에도 값이 없을 때만 생략한다. 값이 있으면 현재 metadata 검증을 요구하며 없는 schema/account를 추정하지 않는다. `customfield_10045.allowedValues`가 없으면 서명된 현재 metadata가 제공한 정확한 비어 있지 않은 Jira default만 사용할 수 있고, 명시한 계정은 여전히 현재 허용값이 있어야 한다. Reporter는 요청에서 생략해야 한다. Gate의 Search/Intent/Create와 Connector는 `reporter` 속성이 존재하기만 해도 값이 `null`인 경우를 포함해 거부한다. 생략한 경우 서버 기본값은 서명된 Metadata가 `required: true`, `hasDefaultValue: true`, `schema.type: "user"`이고 `defaultValue`와 `allowedValues` 키를 모두 제공하지 않은 경우에만 허용한다. 명시적 `defaultValue: null`은 이 예외에 해당하지 않아 차단된다. 이는 코드상 입력 계약이며 실제 Jira Create 또는 운영 연결 검증을 뜻하지 않는다. 2026-10-28 READ-ONLY Task Metadata 관측에서 reporter는 required/default로 표시됐지만 두 키가 반환되지 않았다. 시작일·기한과 Target Product/Component의 필수 입력도 정확한 요청 및 live allowedValues가 없으면 차단한다. 누락된 값은 합성하지 않는다.

Gate는 서명된 live metadata로 Target 필드 schema/default/options를 확인한다. Legacy 분류 필드 `customfield_10042`, `customfield_10043`, `customfield_10044`가 metadata에 있으면 모두 optional이고 default가 없어야 하며, Create 화면에서 제거된 필드는 완전한 signed metadata 페이지에서 생략될 수 있다. G3 Create 요청은 Legacy 값을 계속 금지한다. Create에 포함된 필드는 현재 metadata에 있어야 하고 Policy `allowed_create_fields` 범위여야 한다. metadata가 표시하는 모든 필수 필드는 요청에 있거나 유효한 Jira default가 있어야 한다. Target 옵션·보조 date 값은 signed schema에 맞춰야 하고 user/assignee 값은 현재 허용 account와 일치해야 한다. caller/Core의 `create_metadata` 값은 이 검사에 사용하지 않는다.

Owner 승인은 `fields_sha256`로 durable Intent 필드를, `create_request_sha256`로 summary, description, assignee, priority, labels 및 모든 Jira fields를 포함한 전체 Create 요청을 묶는다. 두 digest 모두 `g3EvidenceSha256`를 사용한다. Intent gate는 승인 reference를 반환하고, 어댑터는 이를 pending Intent에 저장한다. Create 전에 승인된 요청과 실제 요청 전체가 일치해야 한다.

`authority_read`는 현재 Create Activation/effective window를 요구하지 않는다. 신규 Target Create를 중지하거나 기간이 끝나도 이미 생성된 Target 이슈의 권한은 남기 때문이다. 대신 `g3_read_authority`는 정확한 `RPL` IssueKey와 유형/ID, `origin: "target_create"`, 비어 있지 않은 `origin_ref`, `read_authority: "target"`, Policy digest 및 유효 시각을 서명해야 한다. Adapter는 서명된 Issue Type·Origin·OriginRef를 실제 Ledger authority와 모두 비교한 뒤 Jira GET의 Issue Type ID와 Target 값을 비교한다. 하나라도 다르면 UNKNOWN/frozen으로 격리한다. file Ledger의 OriginRef는 `g3-file-origin-v1:` 접두어와 `{ ledger_ref, create_request_id, issue_key, issue_type_id }`의 결정적 SHA-256 식별자다. 발급자는 현재 Ledger가 반환한 이 값을 서명해야 한다. 위조·만료·다른 이슈/Origin에 대한 증거는 거부한다.

Jira Cloud ID 입력은 UUID 형식만 받으며 Jira Site URL은 Cloud ID로 취급하지 않는다. Rovo 응답에 원시 및 구조화된 Issue/pageInfo 표현이 함께 있으면 Issue와 pagination 값을 모두 대조하고 충돌 시 Search를 실패 처리한다.

검색은 현재 Create Activation에 의해 별도로 허가된다. Intent/Create/read/Origin 순서는 Gate 인스턴스에 저장되고, durable replay claim은 Gate 인스턴스와 재시작을 넘어 중복 요청을 차단해야 한다.

## 수동 Ledger 복구

`createG3LedgerRecovery({ ledger, root, ledgerRef, jiraRead, trustedKeys, siteOrigin, now })`는 기존 file Ledger와 읽기 전용 Jira GET 하나만 받는다. `plan(requestId)`과 `reconcile({ request_id, authorization })`만 노출하며 Jira Create, 검색, Admin 작업 또는 네트워크 쓰기는 없다. `plan`은 ledger를 읽고, `pending_sha256`, `fields_sha256`, Target snapshot을 제시할 뿐 원격 호출이나 ledger 변경을 하지 않는다.

수동 승인 payload `g3_manual_recovery_authorization`은 `action: "reconcile_existing_issue"`, 승인 상태, 고유 승인 참조, 정확한 `CreateRequestId`, `LedgerRef`, 알려진 `IssueKey`, Activation/Owner 승인 참조, 유형/ID와 두 intent digest를 묶는다. 승인 서명키는 별도의 maintainer 신뢰 경계다.

복구는 정확한 이슈 유형과 세 Target 필드만 한 번 GET한다. 응답 key/type/option이 pending Intent와 일치하고 수동 승인이 아직 유효한 경우에만 이어간다. 기존 Intent/link/Origin을 durable로 취급하기 전 파일과 부모 디렉터리를 fsync한다. 정확히 일치하면 누락 link를 복원하거나 Origin을 기록하고, 이미 연결된 일치는 재검증 후 멱등 반환한다. 잘못된 승인, 만료, 부분 JSON, 불일치, GET 결과 불명, fsync 실패는 복구를 멈춘다. 알 수 없는 GET 결과는 Create 재시도 사유가 아니며, 한 recovery 인스턴스는 같은 요청을 두 번 조회하지 않는다. 테스트용 `syncReceipt` 주입을 제외하면 실제 파일과 디렉터리 fsync를 유지해야 한다.

## 오프라인 검증

```sh
node scripts/test-jira-ticket-g3-trusted-gate.mjs
node scripts/test-jira-ticket-g3-ledger-recovery.mjs
```

Fixture는 실행 중 임시 Ed25519 키와 synthetic evidence를 만들고 실제 임시 디렉터리의 file Ledger를 사용한다. Atlassian, Admin, Owner, 외부 네트워크에는 연결하지 않는다.
