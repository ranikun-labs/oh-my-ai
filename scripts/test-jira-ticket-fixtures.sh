#!/usr/bin/env bash
set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO"

SKILL="skills/jira-ticket/SKILL.md"
CONTRACT="skills/jira-ticket/templates/ticket-contract.md"
PREVIEW="skills/jira-ticket/templates/mcp-create-preview.md"
BACKLOG="skills/jira-ticket/templates/backlog-preview.md"
FIXTURE="fixtures/jira-ticket/pure-contract-fixtures.json"
WORKFLOW_FIXTURE="fixtures/jira-ticket/mcp-create-workflow-fixtures.json"
RUNTIME_FIXTURE="fixtures/jira-ticket/runtime-protocol-fixtures.json"

fail() { echo "jira-ticket fixture failure: $*" >&2; exit 1; }
require_file() { [ -f "$1" ] || fail "missing file: $1"; }
require_text() { rg -q -F -- "$2" "$1" || fail "missing text '$2' in $1"; }

for file in "$SKILL" "$CONTRACT" "$PREVIEW" "$BACKLOG" "$FIXTURE" "$WORKFLOW_FIXTURE" "$RUNTIME_FIXTURE"; do
  require_file "$file"
done

for field in \
  "Summary" "Context" "Goal" "Source of Truth" "In Scope" "Out of Scope" \
  "Acceptance Criteria" "Repository" "Base Branch" "Expected Branch Name" \
  "Dependencies" "Verification" "Do Not Touch" "Definition of Done"; do
  require_text "$CONTRACT" "## $field"
  require_text "$PREVIEW" "### $field"
  require_text "$BACKLOG" "### $field"
done

for sentinel in "Decision Required" "Repository Required" "Base Branch Required" "Not Verifiable"; do
  require_text "$SKILL" "$sentinel"
  require_text "$CONTRACT" "$sentinel"
done

for source in \
  "Accepted Decision" \
  "Canonical Repository Product and Architecture Documents" \
  "Confluence Specification" \
  "Explicit User Request" \
  "Handoff Candidate" \
  "Current Conversation"; do
  require_text "$SKILL" "$source"
  require_text "$BACKLOG" "$source"
done

for heading in \
  "## Source Status" "## Mode" "## Epic Candidate" "## Child Ticket Index Summary" \
  "## Complete Child Ticket Contracts" "## Jira MCP-backed Create boundary" "## Approval Boundary"; do
  require_text "$BACKLOG" "$heading"
done

require_text "$BACKLOG" "does not replace a"
require_text "$BACKLOG" "complete Child Ticket Contract"
require_text "$BACKLOG" "Contracts must be Valid"
require_text "$BACKLOG" "do not show the Jira creation approval"
require_text "$CONTRACT" "<ISSUE-KEY>"
require_text "$SKILL" '[ -x "$HOME/.local/bin/harness-event" ]'
require_text "$SKILL" "|| true"
require_text "$SKILL" "Issue Type Decision Required"
require_text "$SKILL" "Source order is Accepted Decision"
require_text "$SKILL" "Branch-name fallback"

backlog_boundary_line="$(rg -n -m 1 '^## Jira MCP-backed Create boundary$' "$BACKLOG" | cut -d: -f1)"
approval_boundary_line="$(rg -n -m 1 '^## Approval Boundary$' "$BACKLOG" | cut -d: -f1)"
[ -n "$backlog_boundary_line" ] && [ -n "$approval_boundary_line" ] && [ "$backlog_boundary_line" -lt "$approval_boundary_line" ] \
  || fail "Backlog Create boundary must appear before Approval Boundary"

for text in \
  "Jira MCP-backed Create Workflow" \
  "Codex·Claude Jira MCP/Plugin" \
  "jira.search" \
  "jira.create" \
  "Create Attempted: false" \
  "exactly once" \
  "Automatic Retry: false" \
  "Product:" \
  "Primary Repository:" \
  "Area:" \
  "Current HEAD:"; do
  require_text "$SKILL" "$text"
done

node - "$FIXTURE" "$WORKFLOW_FIXTURE" "$RUNTIME_FIXTURE" <<'NODE'
const fs = require("fs");
const preview = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const workflow = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const runtime = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const legacy = new Set([
  "single-technical-task", "user-feature", "existing-defect", "pre-implementation-research",
  "structural-improvement", "multi-repository-specification", "before-approval",
  "connector-unavailable", "ambiguous-intent", "canonical-source-conflict",
  "repository-required", "blank-or-whitespace-field", "scope-conflict",
  "secret-bearing-input", "before-jira-key", "telemetry-fail-open",
]);
if (preview.contract !== "jira-ticket-pure-contract-preview-v1" || preview.network || preview.external_write || preview.artifact_write) process.exit(1);
const previewIds = new Set(preview.scenarios.map((scenario) => scenario.id));
if (legacy.size !== previewIds.size || [...legacy].some((id) => !previewIds.has(id))) process.exit(1);
const required = [
  "mcp-unavailable", "search-only", "search-failed", "search-unclear", "exact-duplicate",
  "similar-duplicate", "no-result-before-approval", "non-explicit-positive-is-not-approval", "no-result-approval-rejected", "create-success",
  "actual-key-url-verification", "wrong-project-response", "keyless-success", "create-timeout",
  "response-loss-rerun-finds-duplicate", "single-create-call", "codex-adapter", "claude-adapter",
  "preview-write-evidence-separated", "description-header", "fourteen-field-contract-regression",
  "project-missing", "issue-type-missing", "assignee-missing", "priority-missing",
  "product-repository-area-missing", "metadata-whitespace", "metadata-not-verifiable",
  "all-required-metadata-normal", "FX-JT-MCP-CODEX-SEARCH", "FX-JT-MCP-CODEX-CREATE",
  "FX-JT-MCP-CLAUDE-SEARCH", "FX-JT-MCP-CLAUDE-CREATE",
];
const fields = [
  "search_attempted", "search_result", "duplicate_status", "approval_status", "create_attempted",
  "create_call_count", "mutation_status", "actual_issue_key", "actual_issue_url", "verification_status",
  "allowed_next_step", "automatic_retry",
];
if (workflow.contract !== "jira-ticket-mcp-backed-create-workflow-v1") process.exit(1);
if (required.some((id) => !workflow.scenarios.some((scenario) => scenario.id === id))) process.exit(1);
if (fields.some((field) => !workflow.required_report_fields.includes(field))) process.exit(1);
if (runtime.contract !== "jira-ticket-runtime-protocol-v1" || !runtime.search_only) process.exit(1);
NODE

node scripts/test-jira-ticket-mcp-create-workflow.mjs
node scripts/test-jira-ticket-preview-regression.mjs
node scripts/test-jira-ticket-runtime-protocol.mjs
node scripts/test-jira-ticket-g3-supervised-adapter.mjs
echo "jira-ticket MCP-backed Create Workflow and offline G3 fixtures passed"
