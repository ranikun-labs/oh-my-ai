---
name: tech-hive
description: Deep technical research for a Tech Hive knowledge workflow, with follow-up adoption advice and explicit authorized knowledge publication. Use for /tech-hive, $tech-hive, TechHive 기준 F1 핵심정리, 테크하이브 스킬 사용, or a request to research, refine, retrieve or register technology in Tech Hive. Do not use for generic F1 questions, quoted commands or prohibited actions. Initial research is deep and read-only.
metadata:
  source: born-here
  summary: 초기 심층 기술 조사·요청 기반 적용 검토·지식 등록
  routing:
    visibility: optional
    risk_level: medium
    task_types:
      - technical_knowledge_research
      - technical_knowledge_publish
    triggers:
      - kind: keyword
        values:
          - /tech-hive
          - $tech-hive
          - techhive 기준
          - 테크하이브 기준
          - 테크 하이브 기준
          - 테크하이브 스킬 사용
          - techhive에 등록
          - techhive에 정리
          - 테크하이브에 등록
          - 테크 하이브에 등록
          - 테크하이브에 정리
          - 테크 하이브에 정리
      - kind: intent
        values:
          - research_technology_for_knowledge_hub
          - publish_approved_technology_knowledge
    use_when:
      - Tech Hive 기술 조사 또는 이미 시작한 연구의 후속 적용 검토·등록 요청
    do_not_use_when:
      - 일반 F1 요청·인용·금지된 조사 또는 게시
---

# Tech Hive — research, adoption and publication

## Intent and continuity
- Select actions from the actual request and active research subject, not a required subcommand. A routing match, quoted text, or a question about this skill is not an action request. A bare skill invocation starts read-only research if a subject is established; otherwise identify the missing subject. It never grants write permission.
- For a new technical subject, perform deep initial research by default. For a follow-up, reuse the active subject, evidence, open questions, decisions and user corrections. A new subject starts a separate context. Do not assume persistence across sessions; recover from authorized handoff or catalog only when available.
- Determine independent action intents: initial/refined research, adoption evaluation, rediscovery, publication. A request may combine them. Adoption is done when requested; publication requires explicit action intent and authorization for the exact target and delta. If both are requested, complete research first and preserve all existing gates.

## Initial research (default)
- Read the sibling `../research/SKILL.md` through actual skill discovery or an authorized source path, and apply its research procedure. This is composition of a read-only procedure, not proof of native skill invocation. If unavailable, continue only with supported research and disclose the missing dependency; never claim it was loaded.
- Explain what the technology solves, its real structure and components, input/processing/output, control/data flow, usage examples, relevant alternatives, trade-offs, maturity, limits and failure modes. Inspect official sources and decision-relevant source/config/test paths. Do not merely summarize the README; do not perform unrelated repo-wide scans.
- Return a F1-first explanation backed by detailed evidence. Use diagrams for architecture where useful. Separate facts, inference and proposal. Do not automatically investigate all internal projects, publish, or create Jira issues for one-off technology research.

## Adoption, on request
- Read [adoption procedure](references/adoption.md). Compare existing relevant assets and constraints from authorized current sources, identify concrete application points, user setup/implementation steps, risks, expected effects and measurable acceptance. Reuse initial research.

## Rediscovery, on request
- Read the configured knowledge catalog and relevant detail documents if available. Search by subject, aliases, source URL and problem; return links, last verified evidence and decision/revisit conditions. Do not create records or assume unavailable content.

## Publish, only on explicit authorized request
- Read [publishing procedure](references/publishing.md). Resolve the configured private workspace bindings and original writing guide/template; never infer them from public data or copy them into this public skill.
- Synthesize all relevant prior research, adoption findings and user corrections. Do not publish only the last answer. Verify duplicate identity and current records, plan the smallest valid mutation, apply only approved scope and reread the stored result. Preserve successful partial writes and reconcile before retrying.
- If publication is not authorized or a connector/target is unavailable, return a ready-to-publish draft and exact blocker; do not claim publication. Do not perform Jira creation, source merge, deployment or policy promotion as a side effect.

## Report
State the decision, actual evidence, what remains unverified, and next action. For publication include actual page/catalog links, disposition (existing/new/catalog-only), write and readback status, and any partial failure. A research or static review result is not a product implementation or independent reviewer PASS.
