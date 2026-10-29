#!/usr/bin/env node

// Advisory structure check for Korean F1 development reports. It does not
// verify the truth of URLs, SHAs, test results, reviewer independence, or gates.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED_SECTIONS = [
  "문제",
  "사용자에게 달라지는 점",
  "이번 변경",
  "검증",
  "아직 안 되는 것",
  "다음 행동",
  "근거",
];

const EVIDENCE_STATUSES = new Set(["PASS", "FAIL", "NOT_RUN", "BLOCKED", "UNKNOWN"]);
const OWNER_STATUSES = new Set(["APPROVED", "PENDING", "BLOCKED", "UNKNOWN", "NOT_REQUIRED"]);
const STATUS_LABELS = ["Native Test", "CI", "Independent Review", "Runtime E2E", "Owner Gate"];

function splitSections(markdown) {
  const sections = new Map();
  let current = null;
  const body = [];
  const flush = () => {
    if (current !== null) sections.set(current, body.join("\n").trim());
  };

  for (const line of String(markdown).split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1];
      body.length = 0;
    } else if (current !== null) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function hasUsableContent(body) {
  if (!body) return false;
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => !/^[-*]?\s*(none|없음|미정|n\/a)\.?$/i.test(line));
}

function parseStatusLines(markdown) {
  const found = new Map();
  const re = /^[ \t]*(?:[-*][ \t]*)?(Native Test|CI|Independent Review|Runtime E2E|Owner Gate)[ \t]*:[ \t]*([A-Z_]+)(?:[ \t]*[—-][ \t]*([^\r\n]*))?[ \t]*$/gim;
  for (const match of String(markdown).matchAll(re)) {
    const label = match[1];
    const status = match[2].toUpperCase();
    const items = found.get(label) ?? [];
    items.push({ status, detail: (match[3] ?? "").trim() });
    found.set(label, items);
  }
  return found;
}

function validateF1Report(markdown) {
  const errors = [];
  const sections = splitSections(markdown);

  for (const section of REQUIRED_SECTIONS) {
    if (!sections.has(section)) {
      errors.push(`missing required section: ## ${section}`);
    } else if (!hasUsableContent(sections.get(section))) {
      errors.push(`section must contain a concrete statement: ## ${section}`);
    }
  }

  const statusLines = parseStatusLines(sections.get("검증") ?? "");
  for (const label of STATUS_LABELS) {
    const entries = statusLines.get(label) ?? [];
    if (entries.length !== 1) {
      errors.push(`${label} must have exactly one explicit status line`);
      continue;
    }

    const { status, detail } = entries[0];
    const allowed = label === "Owner Gate" ? OWNER_STATUSES : EVIDENCE_STATUSES;
    if (!allowed.has(status)) {
      errors.push(`${label} has unsupported status: ${status}`);
      continue;
    }

    if (detail.length === 0) {
      errors.push(`${label} ${status} requires evidence or a reason after an em dash`);
    }
    if (label === "Native Test" && status === "PASS" && !/(?:\bnode\b|\bnpm\b|\bmake\b|\bpytest\b|\bgo test\b|\bcargo test\b|\b\d+\/\d+\b)/i.test(detail)) {
      errors.push("Native Test PASS requires a command or a passed/total count");
    }
    if (label === "CI" && status === "PASS" && !/https?:\/\//i.test(detail)) {
      errors.push("CI PASS requires a run URL");
    }
    if (label === "Owner Gate" && status === "APPROVED" && detail.length === 0) {
      errors.push("Owner Gate APPROVED requires an approval evidence reference");
    }
    if (label === "Owner Gate" && status === "APPROVED" && !/(?:https?:\/\/|\bRPL-\d+\b|comment\s*#\d+)/i.test(detail)) {
      errors.push("Owner Gate APPROVED requires a linked issue, comment, or approval URL");
    }
    if (label === "Independent Review" && status === "PASS") {
      if (!/reviewer\s*[:=]\s*\S+/i.test(detail)) {
        errors.push("Independent Review PASS requires reviewer identity");
      }
      if (!/\bHEAD\b\s*[:=]?\s*[a-f0-9]{7,40}\b/i.test(detail)) {
        errors.push("Independent Review PASS requires the reviewed HEAD");
      }
    }
    if (label === "Runtime E2E" && status === "PASS") {
      if (!/runtime\s*[:=]\s*\S+/i.test(detail)) {
        errors.push("Runtime E2E PASS requires the runtime name");
      }
      if (!/(?:https?:\/\/|\b[a-f0-9]{7,40}\b)/i.test(detail)) {
        errors.push("Runtime E2E PASS requires an evidence URL or SHA");
      }
    }
  }

  const evidence = sections.get("근거") ?? "";
  if (hasUsableContent(evidence) && !/(?:https?:\/\/|\b[a-f0-9]{7,40}\b)/i.test(evidence)) {
    errors.push("근거 must include a URL or a source SHA");
  }

  return { valid: errors.length === 0, errors };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/f1-report-advisory.mjs <report.md>");
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`missing_report: ${file}`);
    process.exit(3);
  }

  const result = validateF1Report(fs.readFileSync(file, "utf8"));
  if (!result.valid) {
    for (const error of result.errors) console.error(`invalid: ${error}`);
    console.error("advisory_only: report facts, URLs, SHAs, and review independence are not verified");
    process.exit(1);
  }
  console.log(`f1_report_structure_valid: ${file}`);
  console.log("advisory_only: report facts, URLs, SHAs, and review independence are not verified");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { REQUIRED_SECTIONS, validateF1Report, splitSections };
