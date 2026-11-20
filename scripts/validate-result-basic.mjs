#!/usr/bin/env node
//
// Validates a filled-in Result Basic Markdown instance (templates/result-basic.md
// convention) against the structural and cross-field rules in
// docs/contracts/result-basic-contract.md (harness-foundation-docs), scoped to
// what a Markdown Manual Copy/Paste Artifact can actually express (V1 is
// Markdown, not the Contract's illustrative YAML).
//
// This does not implement Managed Result Return, Import, or automatic
// completion detection -- Result Basic remains a self-report Evidence
// Candidate; this validator only checks that the self-report is internally
// well-formed and does not contradict itself.

import fs from "node:fs";
import { readMarkdownEvidence, readTopLevelSectionHeadings, splitSections as splitVisibleSections } from "./f1-report-advisory.mjs";

const REQUIRED_HEADINGS = [
  "Contract Metadata",
  "Title",
  "Summary",
  "Work Performed",
  "Findings",
  "Evidence",
  "Files Read",
  "Files Changed",
  "Commands Executed",
  "Side Effects",
  "Validation Performed",
  "Validation Not Performed",
  "Validation Results",
  "Completion Criteria Results",
  "Assumptions",
  "Open Issues",
  "Scope Deviations",
  "Remaining Risks",
  "Blocked Reasons",
  "Recommended Next Action",
  "Runtime Context",
  "Truthfulness Checklist",
  "Human Review Boundary",
];

const EXECUTION_STATUS_VALUES = new Set(["complete", "partial", "failed", "blocked"]);
const BLOCKED_REASON_PROMPT = "<reason the work is blocked>";
const REQUIRED_METADATA_PLACEHOLDERS = new Map([
  ["schema_version", []],
  ["artifact_version", []],
  ["result_ref", ["<result-YYYYMMDD-HHMMSS-short-slug>"]],
  ["sensitive_data_status", ["<none_detected | redacted | contains_sensitive_data | unknown>"]],
  ["created_at", ["<YYYY-MM-DDTHH:MM:SSZ>"]],
  ["created_by", ["<worker runtime or person>"]],
  ["review_state", []],
]);

function splitSections(markdown, errors = []) {
  const lines = markdown.split("\n");
  const boundaries = readTopLevelSectionHeadings(markdown);
  const sections = Object.create(null);
  for (const [index, { marker, title, startLine, endLine }] of boundaries.entries()) {
    // Every H1/H2 ends the previous section. Result fields open only with
    // named ATX H2s as used in the manual template.
    if (marker !== "##" || startLine !== endLine || !title) continue;
    if (Object.hasOwn(sections, title)) {
      if (REQUIRED_HEADINGS.includes(title)) {
        errors.push(`duplicate required heading: ## ${title}`);
      }
      continue;
    }
    // Keep code blocks in the original body as evidence or deviations.
    const end = boundaries[index + 1]?.startLine ?? lines.length;
    sections[title] = lines.slice(endLine + 1, end).join("\n").trimEnd();
  }
  return sections;
}

function isNone(body) {
  const trimmed = body.trim();
  if (trimmed.length === 0) return true;
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  // Every remaining line is a "None" bullet (allowing surrounding backticks).
  return lines.every((l) => /^-?\s*`?none`?\.?$/i.test(l));
}

function isNoneOrTemplatePrompt(body, prompts = []) {
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  const promptSet = new Set(prompts);
  return lines.every((line) => {
    if (/^-?\s*`?none`?\.?$/i.test(line)) return true;
    const item = line.replace(/^[-*+]\s+/, "").trim();
    const inlineCode = /^`([^`]*)`$/.exec(item);
    return promptSet.has(inlineCode ? inlineCode[1] : item);
  });
}

function hasReportedBlocker(body) {
  const evidence = readMarkdownEvidence(body, { proseOnly: true }).text
    .replace(/<reason\s+the\s+work\s+is\s+blocked>/gu, BLOCKED_REASON_PROMPT)
    .replace(/(`+)\s*(none\.?|<reason the work is blocked>)\s*\1/giu, "$2");
  const reasons = evidence.split("\n")
    .map((line) => line.trim().replace(/^(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)+/u, ""))
    .join("\n");
  return !isNoneOrTemplatePrompt(reasons, [BLOCKED_REASON_PROMPT]);
}

function field(metadataBody, name) {
  const m = metadataFields(metadataBody, name)[0];
  return m ? m[1].trim() : null;
}

function metadataFields(metadataBody, name) {
  // Legacy metadata allows the key immediately after a lone list marker.
  // A wrapped value must follow immediately as indented list-item content
  // or a standalone code span used as a lazy continuation of the list item.
  const blockMarker = "(?:[-+*]|\\d+[.)]|#{1,6})(?:[ \\t]|$)|>|(?:(?:-[ \\t]*){3,}|(?:\\*[ \\t]*){3,}|(?:_[ \\t]*){3,})$";
  const indentedValue = `(?: {2,}|[ \\t]*\\t[ \\t]*)(?=\\S)(?!${blockMarker})`;
  const lazyCodeValue = " {0,1}(?=\`[^\`\\n]+\`[ \\t]*$)";
  const re = new RegExp(
    `^-[ \\t]*(?:\\n[ \\t]*)?\`${name}\`:[ \\t]*(?:\\n(?:${indentedValue}|${lazyCodeValue}))?\`?([^\`\\n]*)\`?[ \\t]*$`,
    "gm",
  );
  return [...metadataBody.matchAll(re)];
}

function normalizeInlineCode(value) {
  const trimmed = value.trim();
  const inlineCode = /^`([^`]*)`$/.exec(trimmed);
  return (inlineCode ? inlineCode[1] : trimmed).trim();
}

function validate(markdown) {
  const errors = [];
  const sections = splitSections(markdown, errors);

  for (const heading of REQUIRED_HEADINGS) {
    if (!(heading in sections)) errors.push(`missing required heading: ## ${heading}`);
  }
  if (errors.length > 0) return errors; // structural failure; stop here

  const metadataLines = splitVisibleSections(
    `## Contract Metadata\n${sections["Contract Metadata"]}`,
  ).fieldSections.get("Contract Metadata") ?? [];
  // Keep gaps where the shared scanner removed a comment or code block.
  // Their surrounding lines must not become a multiline metadata entry.
  const visibleMetadata = [];
  for (const { text, lineIndex } of metadataLines) visibleMetadata[lineIndex] = text;
  const meta = visibleMetadata.join("\n");
  // Do not silently choose one of several reported values for a required field.
  for (const name of ["execution_status", "receipt_status", "source_handoff_ref", ...REQUIRED_METADATA_PLACEHOLDERS.keys()]) {
    if (metadataFields(meta, name).length > 1) {
      errors.push(`duplicate Contract Metadata field: ${name}`);
    }
  }
  if (errors.length > 0) return errors;
  const executionStatus = field(meta, "execution_status");
  if (!EXECUTION_STATUS_VALUES.has(executionStatus)) {
    errors.push(`execution_status must be one of complete/partial/failed/blocked, got: ${executionStatus}`);
  }

  // Untouched template prompts are instructions to the worker, not evidence
  // that a status gate was satisfied.
  const blockedReasons = sections["Blocked Reasons"];
  const blockedReasonsEmpty = isNoneOrTemplatePrompt(blockedReasons, [BLOCKED_REASON_PROMPT]);
  const validationPerformed = sections["Validation Performed"];
  const validationPrompts = ["<validation that was actually performed>"];
  const validationNotPerformedEmpty = isNoneOrTemplatePrompt(sections["Validation Not Performed"], [
    "<validation that was requested or expected but not performed, with reason>",
  ]);
  const openIssuesEmpty = isNoneOrTemplatePrompt(sections["Open Issues"], [
    "<open issue or question>",
  ]);
  const scopeDeviationsEmpty = isNone(sections["Scope Deviations"]);
  const filesReadEmpty = isNone(sections["Files Read"]);
  const filesChangedEmpty = isNone(sections["Files Changed"]);

  // "Files Read / Changed 분리" is a structural requirement: the two must
  // exist as independently headed sections (checked above via
  // REQUIRED_HEADINGS), each individually listed. It is not a requirement
  // that their contents differ -- reading a file and then changing it is the
  // normal case, and both sections should legitimately list it.

  if (executionStatus === "blocked") {
    if (blockedReasonsEmpty) {
      errors.push("execution_status=blocked requires at least one entry under Blocked Reasons");
    }
  } else if (executionStatus !== "partial" && !blockedReasonsEmpty) {
    errors.push(`execution_status=${executionStatus} but Blocked Reasons is non-empty (Blocked Reasons is for status=blocked or partial)`);
  }

  if (executionStatus === "complete") {
    const evidence = readMarkdownEvidence(validationPerformed);
    if (!evidence.hasOpaqueEvidence && isNoneOrTemplatePrompt(evidence.text, validationPrompts)) {
      errors.push("execution_status=complete requires at least one entry under Validation Performed (cannot claim complete with zero validation performed)");
    }
    if (!scopeDeviationsEmpty) {
      errors.push("execution_status=complete but Scope Deviations is non-empty (Contract §23: complete requires no Material Scope Deviation)");
    }
    // Owner decision: these are the required criteria of the currently
    // approved completion unit. Do not infer extra criteria from validation
    // failures, later deployment stages, or the fact that a PR is unmerged.
    // Reuse the visible scanner so comments/examples are not status claims;
    // keep the original bodies intact for the other evidence checks.
    const criteria = splitVisibleSections(
      `## Completion Criteria Results\n${sections["Completion Criteria Results"]}`,
    ).sections.get("Completion Criteria Results") ?? "";
    const entries = criteria.split("\n").map((line) => line.trim()).filter(Boolean);
    if (entries.length === 0 || isNone(criteria)) {
      errors.push("execution_status=complete requires explicit met Completion Criteria Results for the current approved completion unit");
    } else {
      for (const entry of entries) {
        const criterion = /^-\s+`([^`]+)`:\s*`(met|unmet|partial|blocked)`\s*-\s*(\S.*)$/.exec(entry);
        if (!criterion) {
          errors.push("execution_status=complete requires Completion Criteria Results entries in the template format with status met (unrecognized criterion or status)");
        } else {
          const criterionName = criterion[1].trim();
          const criterionEvidence = normalizeInlineCode(criterion[3]);
          if (criterionName.toLowerCase() === "none" || criterionName === "<criterion>") {
            errors.push("execution_status=complete requires a filled Completion Criteria Results criterion name");
          }
          if (criterionEvidence.toLowerCase() === "none" || criterionEvidence === "<evidence or reason>") {
            errors.push("execution_status=complete requires Completion Criteria Results evidence or a reason");
          }
          if (criterion[2] !== "met") {
            errors.push(`execution_status=complete contradicts Completion Criteria Results status=${criterion[2]} for ${criterion[1]}`);
          }
        }
      }
    }
  }

  if (executionStatus === "partial") {
    // Contract §§23 and 28 let a usable partial result explain why its
    // remaining work is blocked. Only a stated reason supplies that evidence.
    if (validationNotPerformedEmpty && openIssuesEmpty && !hasReportedBlocker(blockedReasons)) {
      errors.push("execution_status=partial requires evidence of incompleteness under Validation Not Performed, Open Issues, or Blocked Reasons");
    }
  }

  if (executionStatus === "failed") {
    if (filesChangedEmpty && filesReadEmpty && isNoneOrTemplatePrompt(validationPerformed, validationPrompts)) {
      // Not a hard requirement, but a failed Result with literally nothing
      // attempted/observed is suspicious; flag it as a truthfulness concern.
      errors.push("execution_status=failed but no Files Read, Files Changed, or Validation Performed is recorded; nothing observable was actually attempted");
    }
  }

  // Truthfulness: never allow "Validation Not Performed" to be silently
  // absent from consideration -- it must be present as a heading (checked
  // above) and, if execution_status is not complete, having it fully empty
  // AND Open Issues and Blocked Reasons fully empty for a partial result is
  // already caught. For complete/blocked/failed we do not force it non-empty, since
  // a complete run legitimately can have performed every validation it needed.

  // The existing manual template requires the Handoff reference. A returned
  // Result without that reference cannot identify the task it reports on;
  // this checks presence only, not task correlation or Handoff acceptance.
  const sourceHandoffRef = field(meta, "source_handoff_ref");
  // Reject only explicit unfilled markers; the reference's actual format stays opaque.
  const unfilledSourceHandoffRefs = new Set([
    "none",
    "<handoff_ref from the structured handoff candidate>",
  ]);
  if (!sourceHandoffRef || unfilledSourceHandoffRefs.has(sourceHandoffRef.toLowerCase())) {
    errors.push("Contract Metadata missing source_handoff_ref");
  }

  const receiptStatus = field(meta, "receipt_status");
  if (receiptStatus !== "received") {
    errors.push(`receipt_status must be 'received' for a Result Basic that was actually returned, got: ${receiptStatus}`);
  }

  // The shipped template requires these fields. Keep provided values opaque
  // after checking for omissions and unfilled template entries.
  for (const [name, placeholders] of REQUIRED_METADATA_PLACEHOLDERS) {
    const value = field(meta, name);
    if (value === null) {
      errors.push(`Contract Metadata missing ${name}`);
    } else if (value === "" || value.toLowerCase() === "none" || placeholders.includes(value)) {
      errors.push(`Contract Metadata has unfilled required field: ${name}`);
    }
  }

  // These processing-state fields may explicitly use None in manual Results.
  for (const name of ["contract_validation_status", "parse_status", "artifact_write_status"]) {
    if (field(meta, name) === null) errors.push(`Contract Metadata missing ${name}`);
  }

  return errors;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: validate-result-basic.mjs <path-to-result-basic.md>");
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    // Missing Result is a distinct, valid state (Contract §40), not a
    // validator crash -- report it as such on stderr and a distinct exit code.
    console.error("missing_result: no Result Basic file was returned (receipt_status: missing, execution_status: unknown)");
    process.exit(3);
  }
  const markdown = fs.readFileSync(file, "utf8");
  const errors = validate(markdown);
  if (errors.length > 0) {
    for (const e of errors) console.error(`invalid: ${e}`);
    process.exit(1);
  }
  console.log(`valid: ${file}`);
  process.exit(0);
}

main();

export { validate, splitSections, isNone, field };
