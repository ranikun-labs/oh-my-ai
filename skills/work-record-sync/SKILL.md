---
name: work-record-sync
description: Prepare and, only within existing approved scope, apply a minimal update to an existing Jira issue or Confluence page with current-record checks and scoped readback. Never creates records or writes by default.
metadata:
  source: born-here
  summary: 기존 Jira·Confluence 기록을 승인·동시성 확인·범위 읽기 후 제한적으로 갱신
  routing:
    visibility: contextual
    risk_level: medium
    task_types:
      - jira_existing_record_update
      - confluence_existing_record_update
    triggers:
      - kind: keyword
        values:
          - update existing Jira issue
          - update existing Confluence page
          - 기존 Jira 이슈 수정
          - 기존 Confluence 페이지 수정
      - kind: intent
        values:
          - update_existing_jira_record
          - update_existing_confluence_record
    keywords:
      ko:
        - 기존 Jira 기록 업데이트
        - 기존 Confluence 페이지 반영
        - 기존 기록 수정
      en:
        - update existing Jira record
        - update existing Confluence record
    use_when:
      - Propose or apply a scoped change to one existing Jira issue or Confluence page.
    do_not_use_when:
      - Create a new Jira issue or Confluence page; use the existing creation workflow.
      - Ask a general Jira or Confluence question without an existing-record update request.
---

# Existing Jira and Confluence Record Updates

Use this compositional workflow when an explicit or contextual request concerns an existing Jira issue or Confluence page. Entry permits read-only inspection and a proposed delta. It never writes automatically: a full Skill invocation, a contextual match, a request to keep records current, or a technically available connector is not write approval.

This Skill updates existing records only. It does not create Jira issues or Confluence pages, transition an issue to Done by default, change status, assignee, parent, ownership, or Writer assignment by default, or create a local ledger, engine, controller, or schema. `jira-ticket` remains create-only; `jira-work` remains its explicit execution-readiness gate. `worklog-note` formats worklog text and is not a record-update adapter.

## 1. Identify the existing target and its authority

Resolve one exact existing target from authoritative context: Jira site/project and issue key or record ID, or Confluence site/space/page ID. Read the live target through a currently connected supported read capability. If the target is missing, ambiguous, inaccessible, or multiple records match, stop before mutation and report the precise gap; do not create a replacement.

Use accepted decisions and canonical accepted Git sources for product and architecture contracts. Use Jira as the live source for its current fields, status, Acceptance Criteria, dependencies, and next actions. Treat Confluence as a readable projection unless an accepted contract makes it canonical. Record source URI/revision or observed time, target identity, and the target's current version or equivalent concurrency marker. A URL, prior-session snapshot, static tool listing, or remembered content is not a current read.

Verify the current approved Objective or request scope and the exact target and fields it covers. Resolve who may mutate the record from the accepted task/Owner authority and authoritative target or workspace permission context; never infer record ownership or write authority from a Jira assignee, creator, last editor, page label, or directory name. A connected API permission is necessary capability evidence, not user approval. If authority, scope, or target custody is unclear, keep the result read-only and identify the exact missing decision.

## 2. Prepare an exact proposal

Show the target and each proposed field change as current value → proposed value, with the reason and source evidence. Include the live target version and separate verified facts from assumptions. Propose only fields within the existing approved scope. Do not update unspecified fields or silently turn a Confluence projection into a product decision.

For Confluence, identify the page and exact section or content delta. Preserve unrelated content. Do not replace a full page to simulate an unsupported fine-grained edit. If the connected API only supports full-body replacement, stop at the proposal unless the exact complete replacement has been approved, the full current body and version have just been read, all unrelated content is preserved, and the service supports a conditional version check that prevents overwriting intervening edits. Without all of those conditions, do not send a write.

## 3. Require matching approval, capability, and a fresh concurrency check

Write only when at least one of these applies: (a) the current explicit user instruction itself names the exact target, fields, and desired values/content; (b) the user clearly approves the displayed proposal for that exact target, fields, and values/content; or (c) an already-valid approved scope explicitly covers that same target and field/content change. A contextual route, general request to review or update, positive reaction without a clear tie to the proposal, role claim, or prior approval for different content is not enough. Any material change to source facts, target, fields, content, or scope invalidates the earlier proposal/approval.

Immediately before a write, confirm that the current session has a connected supported API/tool for the exact target and update operation, and reread the target's affected fields and version. Reconfirm the approved source facts, applicable authority, target custody, and permission. Use a supported conditional/version check when available to prevent a concurrent edit from being overwritten. If current content/version changed, the approval no longer matches, or the API cannot make the requested fine-grained update safely, stop without writing and present a revised proposal or blocker.

Do not change status, resolution, assignee, parent, record owner, or Writer ownership unless separate explicit authority names the exact field and value and the owning workflow permits it. Never transition Jira to Done without verified acceptance. Do not bypass `jira-ticket`'s create-only boundary or `jira-work`'s explicit readiness gate.

## 4. Write once and verify by scoped readback

After all gates pass, send only the approved delta to the supported connector/API. Do not use direct endpoints, store credentials, or claim that a Skill or connector enforces server-side policy. Do not retry a write when its response or acknowledgement is missing, timed out, or ambiguous. Perform a read-only check of the exact target and affected fields if possible; report `UNKNOWN` if the resulting state cannot be established. Never send a second write merely because the first acknowledgement was unclear.

After a clear write response, reread the same target and affected fields. Confirm that the stored values match the approved proposal and inspect the returned version or concurrency marker. If the write is partial, differs from approval, or has unexpected effects, stop and report the discrepancy; do not attempt an automatic repair. If scoped readback is unavailable, do not claim the update succeeded.

Report the target, source and target revisions, approved delta, whether a mutation was attempted, response evidence, scoped readback result, and remaining blocker or next action. Keep evidence minimal and do not copy unrelated page bodies, secrets, credentials, or private data into logs or handoffs. A proposal, an attempted write, and a readback-confirmed update are distinct states.
