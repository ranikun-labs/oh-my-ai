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
import { splitSections as splitVisibleSections } from "./f1-report-advisory.mjs";

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
const REQUIRED_METADATA_UNFILLED_VALUES = new Map([
  ["schema_version", []],
  ["artifact_version", []],
  ["result_ref", ["<result-YYYYMMDD-HHMMSS-short-slug>"]],
  ["sensitive_data_status", ["<none_detected | redacted | contains_sensitive_data | unknown>"]],
  ["created_at", ["<YYYY-MM-DDTHH:MM:SSZ>"]],
  ["created_by", ["<worker runtime or person>"]],
  ["review_state", []],
]);

function splitSections(markdown, errors = []) {
  // Use the existing scanner to locate visible headings, but slice Result
  // bodies from the original text: code blocks can contain actual evidence
  // or deviations and must not disappear before cross-field validation.
  const lines = markdown.split("\n");
  let marker = "RESULT_SECTION_LINE_";
  while (markdown.includes(marker)) marker += "_";
  const marked = lines.map((line, index) => line.replace(
    /^( {0,3}##[ \t]+)(.*)$/,
    (_, prefix, heading) => `${prefix}${marker}${index}__${heading}`,
  )).join("\n");
  const boundaries = [];
  for (const heading of splitVisibleSections(marked).sections.keys()) {
    const match = new RegExp(`^${marker}(\\d+)__(.*)$`).exec(heading);
    if (match && match[2].trim()) {
      boundaries.push({ index: Number(match[1]), heading: match[2].trim() });
    }
  }
  const sections = Object.create(null);
  for (const [index, boundary] of boundaries.entries()) {
    if (Object.hasOwn(sections, boundary.heading)) {
      if (REQUIRED_HEADINGS.includes(boundary.heading)) {
        errors.push(`duplicate required heading: ## ${boundary.heading}`);
      }
      continue;
    }
    const end = boundaries[index + 1]?.index ?? lines.length;
    sections[boundary.heading] = lines.slice(boundary.index + 1, end).join("\n").trim();
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

function field(metadataBody, name) {
  const m = metadataFields(metadataBody, name)[0];
  return m ? m[1].trim() : null;
}

function metadataFields(metadataBody, name) {
  const re = new RegExp(`^-\\s*\`${name}\`:\\s*\`?([^\`\\n]*)\`?\\s*$`, "gm");
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

  const meta = splitVisibleSections(
    `## Contract Metadata\n${sections["Contract Metadata"]}`,
  ).sections.get("Contract Metadata") ?? "";
  // These fields drive validation decisions. Never silently choose one of
  // several reported values, even when the repeated values happen to agree.
  for (const name of ["execution_status", "receipt_status", "created_by", "source_handoff_ref"]) {
    if (metadataFields(meta, name).length > 1) {
      errors.push(`duplicate Contract Metadata field: ${name}`);
    }
  }
  if (errors.length > 0) return errors;
  const executionStatus = field(meta, "execution_status");
  if (!EXECUTION_STATUS_VALUES.has(executionStatus)) {
    errors.push(`execution_status must be one of complete/partial/failed/blocked, got: ${executionStatus}`);
  }

  const blockedReasonsEmpty = isNone(sections["Blocked Reasons"]);
  const validationPerformedEmpty = isNone(sections["Validation Performed"]);
  const validationNotPerformedEmpty = isNone(sections["Validation Not Performed"]);
  const openIssuesEmpty = isNone(sections["Open Issues"]);
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
  } else if (!blockedReasonsEmpty) {
    errors.push(`execution_status=${executionStatus} but Blocked Reasons is non-empty (Blocked Reasons is for status=blocked only)`);
  }

  if (executionStatus === "complete") {
    if (validationPerformedEmpty) {
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
    if (validationNotPerformedEmpty && openIssuesEmpty) {
      errors.push("execution_status=partial requires evidence of incompleteness under Validation Not Performed or Open Issues");
    }
  }

  if (executionStatus === "failed") {
    if (filesChangedEmpty && filesReadEmpty && validationPerformedEmpty) {
      // Not a hard requirement, but a failed Result with literally nothing
      // attempted/observed is suspicious; flag it as a truthfulness concern.
      errors.push("execution_status=failed but no Files Read, Files Changed, or Validation Performed is recorded; nothing observable was actually attempted");
    }
  }

  // Truthfulness: never allow "Validation Not Performed" to be silently
  // absent from consideration -- it must be present as a heading (checked
  // above) and, if execution_status is not complete, having it fully empty
  // AND Open Issues fully empty AND execution_status=partial is already
  // caught. For complete/blocked/failed we do not force it non-empty, since
  // a complete run legitimately can have performed every validation it needed.

  const createdBy = field(meta, "created_by");
  if (!createdBy) errors.push("Contract Metadata missing created_by");

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

  // The shipped template marks these metadata fields as required. Reject only
  // explicit None values and each field's exact unfilled template placeholder;
  // keep all other values opaque and do not add format or truth checks here.
  for (const [name, placeholders] of REQUIRED_METADATA_UNFILLED_VALUES) {
    const value = field(meta, name);
    if (value === null) continue; // Missing-field behavior is outside this check.
    const normalized = value.trim();
    if (normalized.toLowerCase() === "none" || placeholders.includes(normalized)) {
      errors.push(`Contract Metadata has unfilled required field: ${name}`);
    }
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
