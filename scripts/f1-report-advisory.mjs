#!/usr/bin/env node

// Advisory structure check for Korean F1 development reports. It does not
// verify the truth of URLs, SHAs, test results, reviewer independence, or gates.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED_SECTIONS = [
  "문제",
  "사용자에게 달라지는 점",
  "서비스 기능",
  "이번 변경",
  "검증",
  "아직 안 되는 것",
  "다음 행동",
  "근거",
];

const EVIDENCE_STATUSES = new Set(["PASS", "FAIL", "NOT_RUN", "BLOCKED", "UNKNOWN"]);
const OWNER_STATUSES = new Set(["APPROVED", "PENDING", "BLOCKED", "UNKNOWN", "NOT_REQUIRED"]);
const STATUS_LABELS = ["Native Test", "CI", "Independent Review", "Runtime E2E", "Owner Gate"];
const REQUIRED_REPORT_FIELDS = [
  { section: "서비스 기능", label: "서비스명", requireDescription: true },
  { section: "서비스 기능", label: "기능명", requireDescription: true },
  { section: "서비스 기능", label: "현재 사용자 기능", requireDescription: true },
  { section: "이번 변경", label: "실제 변경" },
  { section: "검증", label: "구현 상태" },
  { section: "검증", label: "검증 상태" },
  { section: "검증", label: "문서 상태" },
  { section: "검증", label: "배포 상태" },
  { section: "아직 안 되는 것", label: "미지원 기능" },
  { section: "아직 안 되는 것", label: "미지원 이유" },
  { section: "다음 행동", label: "다음 목표" },
  { section: "다음 행동", label: "첫 행동" },
  { section: "다음 행동", label: "담당 Lane" },
  { section: "다음 행동", label: "필요 조건" },
];

function isIndentedCodeLine(line) {
  let columns = 0;
  for (const character of line) {
    if (character === " ") {
      columns += 1;
    } else if (character === "\t") {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
  }
  return columns >= 4;
}

function parseFenceStart(line) {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  const character = line[index];
  if (character !== String.fromCharCode(96) && character !== "~") return null;

  let end = index;
  while (line[end] === character) end += 1;
  if (end - index < 3) return null;
  return { character, length: end - index };
}

function isFenceClosing(line, openFence) {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  if (line[index] !== openFence.character) return false;

  let end = index;
  while (line[end] === openFence.character) end += 1;
  if (end - index < openFence.length) return false;

  for (; end < line.length; end += 1) {
    if (line[end] !== " " && line[end] !== "\t") return false;
  }
  return true;
}

// One document-level scan keeps heading and status visibility in the same Markdown context.
function isEscapedAt(text, index) {
  const backslash = String.fromCharCode(92);
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === backslash; cursor -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function backtickRunLength(text, start) {
  const backtick = String.fromCharCode(96);
  let end = start;
  while (text[end] === backtick) end += 1;
  return end - start;
}

function isAtxHeadingLine(line) {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;

  let level = 0;
  while (level < 6 && line[index] === "#") {
    index += 1;
    level += 1;
  }

  return level > 0 && (index === line.length || line[index] === " " || line[index] === "\t");
}

function findClosingBacktickRun(lines, startLine, startColumn, runLength) {
  const backtick = String.fromCharCode(96);

  for (let lineIndex = startLine; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (lineIndex > startLine
      && (line.trim().length === 0
        || isIndentedCodeLine(line)
        || parseFenceStart(line) !== null
        || isAtxHeadingLine(line))) {
      return null;
    }

    let cursor = lineIndex === startLine ? startColumn : 0;
    while (cursor < line.length) {
      const next = line.indexOf(backtick, cursor);
      if (next === -1) break;
      const length = backtickRunLength(line, next);
      if (length === runLength) return { lineIndex, end: next + length };
      cursor = next + length;
    }
  }

  return null;
}

function findHtmlPreCloseOutsideComment(line, insideHtmlComment) {
  let cursor = 0;
  while (cursor < line.length) {
    if (insideHtmlComment) {
      const closeComment = line.indexOf("-->", cursor);
      if (closeComment === -1) return { end: null, insideHtmlComment: true };
      insideHtmlComment = false;
      cursor = closeComment + 3;
      continue;
    }

    if (line.startsWith("<!--", cursor) && !isEscapedAt(line, cursor)) {
      insideHtmlComment = true;
      cursor += 4;
      continue;
    }

    const closePre = /^<\/pre\s*>/i.exec(line.slice(cursor));
    if (closePre) return { end: cursor + closePre[0].length, insideHtmlComment: false };
    cursor += 1;
  }
  return { end: null, insideHtmlComment };
}

function visibleMarkdownLines(markdown) {
  const sourceLines = String(markdown).split(/\r?\n/);
  const visibleLines = [];
  let openFence = null;
  let insideHtmlComment = false;
  let insideHtmlPreBlock = false;
  let inlineCodeDelimiterLength = 0;

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    let line = sourceLines[lineIndex];
    if (openFence !== null) {
      if (isFenceClosing(line, openFence)) openFence = null;
      continue;
    }

    if (insideHtmlPreBlock) {
      const preClose = findHtmlPreCloseOutsideComment(line, insideHtmlComment);
      insideHtmlComment = preClose.insideHtmlComment;
      if (preClose.end === null) continue;
      line = line.slice(preClose.end);
      insideHtmlPreBlock = false;
      insideHtmlComment = false;
    }

    if (inlineCodeDelimiterLength === 0 && !insideHtmlComment && !insideHtmlPreBlock && isIndentedCodeLine(line)) continue;

    if (inlineCodeDelimiterLength === 0 && !insideHtmlComment && !insideHtmlPreBlock) {
      const fenceStart = parseFenceStart(line);
      if (fenceStart !== null) {
        openFence = fenceStart;
        continue;
      }
    }

    const headingCandidate = inlineCodeDelimiterLength === 0
      && !insideHtmlComment
      && !insideHtmlPreBlock
      && /^ {0,3}##[ \t]+/.test(line);
    let visible = "";
    let statusVisible = "";
    let fieldVisible = "";
    let cursor = 0;
    const backtick = String.fromCharCode(96);

    while (cursor < line.length) {
      if (insideHtmlPreBlock) {
        const preClose = findHtmlPreCloseOutsideComment(line.slice(cursor), insideHtmlComment);
        insideHtmlComment = preClose.insideHtmlComment;
        if (preClose.end === null) {
          cursor = line.length;
          break;
        }
        cursor += preClose.end;
        insideHtmlPreBlock = false;
        insideHtmlComment = false;
        continue;
      }

      if (insideHtmlComment) {
        const close = line.indexOf("-->", cursor);
        if (close === -1) break;
        insideHtmlComment = false;
        cursor = close + 3;
        continue;
      }

      if (inlineCodeDelimiterLength > 0) {
        const close = findClosingBacktickRun(sourceLines, lineIndex, cursor, inlineCodeDelimiterLength);
        if (close !== null && close.lineIndex === lineIndex) {
          visible += line.slice(cursor, close.end);
          cursor = close.end;
          inlineCodeDelimiterLength = 0;
          continue;
        }

        visible += line.slice(cursor);
        cursor = line.length;
        continue;
      }

      if (line[cursor] === backtick && !isEscapedAt(line, cursor)) {
        const runLength = backtickRunLength(line, cursor);
        const close = findClosingBacktickRun(sourceLines, lineIndex, cursor + runLength, runLength);
        if (close !== null) {
          if (close.lineIndex === lineIndex) {
            const inlineCode = line.slice(cursor, close.end);
            visible += inlineCode;
            statusVisible += inlineCode;
            cursor = close.end;
          } else {
            visible += line.slice(cursor);
            cursor = line.length;
            inlineCodeDelimiterLength = runLength;
          }
          continue;
        }

        visible += line.slice(cursor);
        cursor = line.length;
        continue;
      }

      if (line.startsWith("<!--", cursor) && !isEscapedAt(line, cursor)) {
        insideHtmlComment = true;
        cursor += 4;
        continue;
      }

      const preOpen = /^<pre\b[^>]*>/i.exec(line.slice(cursor));
      if (preOpen && !isEscapedAt(line, cursor)) {
        insideHtmlPreBlock = true;
        cursor += preOpen[0].length;
        continue;
      }

      visible += line[cursor];
      statusVisible += line[cursor];
      fieldVisible += line[cursor];
      cursor += 1;
    }

    if (isIndentedCodeLine(visible)) continue;
    visibleLines.push({ text: visible, statusText: statusVisible, fieldText: fieldVisible, headingCandidate });
  }

  return visibleLines;
}

function splitSections(markdown, statusEvidenceOnly = false) {
  const sections = new Map();
  const fieldSections = new Map();
  const duplicates = new Set();
  let current = null;
  const body = [];
  const fieldBody = [];
  const flush = () => {
    if (current === null) return;
    if (sections.has(current)) {
      duplicates.add(current);
      return;
    }
    sections.set(current, body.join("\n").trimEnd());
    fieldSections.set(current, [...fieldBody]);
  };

  for (const { text: line, statusText, fieldText, headingCandidate } of visibleMarkdownLines(markdown)) {
    const heading = headingCandidate ? /^ {0,3}##[ \t]+(.+?)[ \t]*$/.exec(line) : null;
    if (heading) {
      flush();
      current = heading[1];
      body.length = 0;
      fieldBody.length = 0;
    } else if (current !== null) {
      body.push(statusEvidenceOnly ? statusText : line);
      fieldBody.push({ text: line, fieldText });
    }
  }
  flush();
  return { sections, fieldSections, duplicates };
}

function isReferenceOnly(value) {
  const remainder = String(value)
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\bRPL-\d+\b/giu, " ")
    .replace(/\bPR\s*#?\s*\d+\b/giu, " ")
    .replace(/\b[a-f0-9]{7,40}\b/giu, " ")
    .replace(/\b(?:jira|issue|commit|sha(?:1|256)?|hash|url|link)\b/giu, " ")
    .replace(/[^\p{L}\p{N}]/gu, "");
  return remainder.length === 0;
}

function isStructuralPlaceholder(value) {
  const lines = String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((line) => /^(?:[-*](?:[ \t]*\[[ xX]?\])?|\[[ xX]?\])$/u.test(line));
}

function validateRequiredReportFields(sectionScan) {
  const errors = [];
  for (const field of REQUIRED_REPORT_FIELDS) {
    const occurrences = [];
    let repeatedOnLine = false;
    const explicitVisiblePattern = new RegExp("^[ \\t]*(?:[-*][ \\t]*)?" + field.label + "[ \\t]*:[ \\t]*(.*)$", "u");
    const explicitPattern = new RegExp("^[ \\t]*(?:[-*][ \\t]*)?" + field.label + "[ \\t]*:[ \\t]*(.*)$", "u");

    for (const [section, lines] of sectionScan.fieldSections) {
      for (const line of lines) {
        const visibleMatch = explicitVisiblePattern.exec(line.fieldText);
        if (!visibleMatch) continue;
        const repeatedLabelPattern = new RegExp(field.label + "[ \\t]*:", "gu");
        if ([...visibleMatch[1].matchAll(repeatedLabelPattern)].length > 0) repeatedOnLine = true;
        occurrences.push({ section, match: explicitPattern.exec(line.text) });
      }
    }

    if (occurrences.length === 0) {
      errors.push("missing required field: " + field.label);
      continue;
    }
    if (occurrences.length > 1 || repeatedOnLine) {
      errors.push("ambiguous duplicate field: " + field.label);
      continue;
    }

    const occurrence = occurrences[0];
    if (occurrence.section !== field.section || !occurrence.match) {
      errors.push("field must be a visible Markdown label in ## " + field.section + ": " + field.label);
      continue;
    }

    const value = occurrence.match[1].trim();
    if (value.replaceAll(String.fromCharCode(96), "").trim().length === 0) {
      errors.push("empty required field: " + field.label);
      continue;
    }
    if (isStructuralPlaceholder(value.replaceAll(String.fromCharCode(96), ""))) {
      errors.push("placeholder-only required field: " + field.label);
      continue;
    }
    if (field.requireDescription && isReferenceOnly(value)) {
      errors.push(field.label + " must describe the service or user-visible function, not only Jira/PR references, URLs, or SHAs");
    }
  }
  return errors;
}

function hasUsableContent(body) {
  if (!body) return false;
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => {
    if (/^[-*][ \t]*(?:\[\s*\][ \t]*)?$/.test(line)) return false;
    return !/^[-*]?\s*(none|없음|미정|n\/a)\.?$/i.test(line);
  });
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
  const sectionScan = splitSections(markdown);
  const sections = sectionScan.sections;
  for (const duplicate of sectionScan.duplicates) {
    if (REQUIRED_SECTIONS.includes(duplicate)) {
      errors.push(`duplicate required section: ## ${duplicate}`);
    }
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!sections.has(section)) {
      errors.push(`missing required section: ## ${section}`);
    } else if (!hasUsableContent(sections.get(section))) {
      errors.push(`section must contain a concrete statement: ## ${section}`);
    }
  }

  errors.push(...validateRequiredReportFields(sectionScan));

  const statusSections = splitSections(markdown, true).sections;
  const statusLines = parseStatusLines(statusSections.get("검증") ?? "");
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
