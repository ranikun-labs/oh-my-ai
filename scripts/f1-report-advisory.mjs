#!/usr/bin/env node

// Advisory structure check for Korean F1 development reports. It does not
// verify the truth of URLs, SHAs, test results, reviewer independence, or gates.

import fs from "node:fs";
import { types as utilTypes } from "node:util";
import { pathToFileURL } from "node:url";
import { validateOpaqueIdentity } from "./lib/pending-handoff-identity.mjs";

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
const AI_STATUS_SECTION = "AI 실행 현황";
const AI_STATUS_HEADERS = [
  "agent id",
  "실제 역할",
  "실제 참여",
  "spawn events",
  "resume events",
  "continue events",
  "요청 model/reasoning/fast·출처",
  "운영 선호·출처",
  "실효 model/reasoning/fast·출처",
  "실제 작업·상태",
  "공식 토큰·비용·구간·출처",
];
const OBSERVATION_COVERAGES = new Set(["complete", "partial", "unknown"]);
const HTML_PRE_OPEN = /^<pre(?=[ \t/>])[^>]*>/iu;
const HTML_BLOCK_TAG = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \t/>]|$)/iu;
const HTML_TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const HTML_ATTRIBUTE = "[ \\t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:\"[^\"]*\"|'[^']*'|[^ \\t\"'=<>`]+))?";
const STANDALONE_HTML_TAG = new RegExp(`^ {0,3}(?:</${HTML_TAG_NAME}[ \\t]*>|<${HTML_TAG_NAME}(?:${HTML_ATTRIBUTE})*[ \\t]*/?>)[ \\t]*$`, "u");
const THEMATIC_BREAK = /^ {0,3}(?:\*(?:[ \t]*\*){2,}|-(?:[ \t]*-){2,}|_(?:[ \t]*_){2,})[ \t]*$/u;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/u;
const MARKDOWN_LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]{1,4}(?=\S)/u;

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
const REPORT_LIST_LABELS = new Set([
  ...STATUS_LABELS.map((label) => label.toLowerCase()),
  ...REQUIRED_REPORT_FIELDS.map(({ label }) => label),
]);
const CODEX_USAGE_SOURCE = "Codex App Server JSON-RPC thread/tokenUsage/updated";
const MAX_USAGE_OBSERVATION_BYTES = 32 * 1024;

function leadingIndentation(line) {
  let columns = 0;
  let length = 0;
  for (const character of line) {
    if (character === " ") {
      columns += 1;
    } else if (character === "\t") {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
    length += 1;
  }
  return { columns, length };
}

function isIndentedCodeLine(line) {
  return leadingIndentation(line).columns >= 4;
}

function relativeListLine(line, listIndent) {
  if (listIndent === 0) return line;
  const { columns, length } = leadingIndentation(line);
  return " ".repeat(Math.max(0, columns - listIndent)) + line.slice(length);
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

function startsHtmlBlock(line, atBlockBoundary) {
  // The pre scanner keeps blank lines inside the block and ignores comment-wrapped closers.
  if (HTML_PRE_OPEN.test(line.trimStart())) return false;
  return HTML_BLOCK_TAG.test(line) || (atBlockBoundary && STANDALONE_HTML_TAG.test(line));
}

function findRawHtmlBlockEnd(line) {
  const element = /^ {0,3}<(script|style|textarea)(?=[ \t>]|$)/iu.exec(line);
  if (element) return new RegExp(`</${element[1]}>`, "iu");
  if (/^ {0,3}<!--/u.test(line)) return /-->/u;
  if (/^ {0,3}<!\[CDATA\[/u.test(line)) return /\]\]>/u;
  if (/^ {0,3}<\?/u.test(line)) return /\?>/u;
  if (/^ {0,3}<![A-Z]/u.test(line)) return />/u;
  return null;
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

function visibleMarkdownLines(markdown, statusEvidenceOnly = false) {
  const sourceLines = String(markdown).split(/\r?\n/);
  const visibleLines = [];
  let openFence = null;
  let insideHtmlComment = false;
  let insideHtmlPreBlock = false;
  let rawHtmlBlockEnd = null;
  let insideHtmlBlock = false;
  let inlineCodeDelimiterLength = 0;
  let atBlockBoundary = true;
  const listContexts = [];

  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    let line = sourceLines[lineIndex];
    if (line.trim()) {
      if (openFence === null && rawHtmlBlockEnd === null && !insideHtmlBlock
        && !insideHtmlComment && !insideHtmlPreBlock && isAtxHeadingLine(line)) {
        listContexts.length = 0;
      }
      const { columns } = leadingIndentation(line);
      while (listContexts.length && columns < listContexts.at(-1).indent) listContexts.pop();
    }
    const parentItem = listContexts.at(-1);
    let listIndent = parentItem?.indent ?? 0;
    let blockLine = relativeListLine(line, listIndent);
    // A raw HTML block ends at a blank line. Its contents cannot start Markdown blocks.
    if (insideHtmlBlock) {
      if (line.trim().length > 0) continue;
      insideHtmlBlock = false;
    }
    if (openFence !== null) {
      if (line.trim() && listIndent < openFence.listIndent) {
        // A fenced block inside a list also ends when its list item ends.
        openFence = null;
      } else {
        if (isFenceClosing(blockLine, openFence)) openFence = null;
        continue;
      }
    }

    if (rawHtmlBlockEnd !== null) {
      if (rawHtmlBlockEnd.test(line)) rawHtmlBlockEnd = null;
      continue;
    }

    if (insideHtmlPreBlock) {
      const preClose = findHtmlPreCloseOutsideComment(line, insideHtmlComment);
      insideHtmlComment = preClose.insideHtmlComment;
      if (preClose.end === null) continue;
      line = line.slice(preClose.end);
      listIndent = 0;
      blockLine = line;
      insideHtmlPreBlock = false;
      insideHtmlComment = false;
    }

    if (inlineCodeDelimiterLength === 0 && !insideHtmlComment && !insideHtmlPreBlock
      && isIndentedCodeLine(blockLine) && line.trim().length > 0) continue;

    if (inlineCodeDelimiterLength === 0 && !insideHtmlComment && !insideHtmlPreBlock) {
      const listItem = MARKDOWN_LIST_ITEM.exec(blockLine);
      const itemPrefixLength = listItem?.[0].length ?? 0;
      const itemText = blockLine.slice(itemPrefixLength);
      if (listItem) {
        const itemLabel = itemText.split(":", 1)[0].trim().toLowerCase();
        listContexts.push({
          indent: listIndent + itemPrefixLength,
          reportContent: REPORT_LIST_LABELS.has(itemLabel),
        });
      }
      const fenceStart = parseFenceStart(itemText);
      if (fenceStart !== null) {
        openFence = { ...fenceStart, listIndent: listIndent + itemPrefixLength };
        atBlockBoundary = true;
        continue;
      }
      const rawEnd = findRawHtmlBlockEnd(blockLine);
      if (rawEnd) {
        if (!rawEnd.test(blockLine)) rawHtmlBlockEnd = rawEnd;
        atBlockBoundary = true;
        continue;
      }
      if (startsHtmlBlock(blockLine, atBlockBoundary)) {
        insideHtmlBlock = true;
        atBlockBoundary = true;
        continue;
      }
    }

    const tableLine = !insideHtmlComment;
    const headingCandidate = inlineCodeDelimiterLength === 0
      && !insideHtmlComment
      && !insideHtmlPreBlock
      && listIndent === 0
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

      const preOpen = HTML_PRE_OPEN.exec(line.slice(cursor));
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

    // Track whether a standalone HTML tag may start a block on the next line.
    atBlockBoundary = line.trim().length === 0
      || isAtxHeadingLine(line)
      || THEMATIC_BREAK.test(line)
      || (!atBlockBoundary && SETEXT_UNDERLINE.test(line));
    if (isIndentedCodeLine(statusEvidenceOnly ? relativeListLine(visible, listIndent) : visible)) continue;
    const nestedReportEvidence = parentItem?.reportContent && isIndentedCodeLine(line);
    visibleLines.push({
      text: visible,
      statusText: relativeListLine(statusVisible, listIndent),
      fieldText: fieldVisible,
      tableText: tableLine ? visible : "",
      headingCandidate,
      nestedReportEvidence,
      lineIndex,
    });
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

  for (const { text: line, statusText, fieldText, tableText, headingCandidate, nestedReportEvidence, lineIndex } of visibleMarkdownLines(markdown, statusEvidenceOnly)) {
    const heading = headingCandidate ? /^ {0,3}##[ \t]+(.+?)[ \t]*$/.exec(line) : null;
    if (heading) {
      flush();
      current = heading[1];
      body.length = 0;
      fieldBody.length = 0;
    } else if (current !== null) {
      body.push(line);
      fieldBody.push({ text: line, fieldText, tableText, statusText, nestedReportEvidence, lineIndex });
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

function splitMarkdownTableRow(line, allowSingleCell = false) {
  if (isAtxHeadingLine(line) || THEMATIC_BREAK.test(line) || /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])[ \t])/u.test(line)) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  const leadingPipe = trimmed.startsWith("|");
  const trailingPipe = trimmed.endsWith("|") && !isEscapedAt(trimmed, trimmed.length - 1);
  const content = trimmed.slice(leadingPipe ? 1 : 0, trailingPipe ? -1 : undefined);

  const cells = [];
  let cell = "";
  let escaped = false;
  for (const character of content) {
    if (character === "|" && !escaped) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
    if (character === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  if (!allowSingleCell && !leadingPipe && !trailingPipe && cells.length === 0) return null;
  cells.push(cell.trim());
  return cells;
}

function normalizeTableHeader(value) {
  return String(value)
    .replaceAll("`", "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function readAiStatusTable(lines, errors) {
  let table = null;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index + 1].lineIndex !== lines[index].lineIndex + 1) continue;
    const headers = splitMarkdownTableRow(lines[index].tableText);
    const separators = splitMarkdownTableRow(lines[index + 1].tableText);
    if (!headers || !separators || headers.length !== separators.length) continue;
    if (!separators.every((cell) => /^:?-+:?$/u.test(cell))) continue;

    // Data rows inside any table cannot start a second table.
    const rows = [];
    let rowIndex = index + 2;
    for (; rowIndex < lines.length; rowIndex += 1) {
      if (lines[rowIndex].lineIndex !== lines[rowIndex - 1].lineIndex + 1) break;
      const cells = splitMarkdownTableRow(lines[rowIndex].tableText, true);
      if (!cells) break;
      rows.push(cells);
    }
    index = rowIndex - 1;

    const normalizedHeaders = headers.map(normalizeTableHeader);
    if (!AI_STATUS_HEADERS.every((header) => normalizedHeaders.includes(header))) continue;

    if (table) {
      errors.push("AI status must contain exactly one participant table");
      return null;
    }
    table = { headers: normalizedHeaders, rows };
  }

  if (!table) {
    errors.push("AI status must contain the required participant table");
  }
  return table;
}

function findAiStatusLabel(sectionBody, label) {
  const pattern = new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?${label}[ \\t]*:[ \\t]*(.*)$`, "gimu");
  return [...String(sectionBody).matchAll(pattern)].map((match) => match[1].trim().replaceAll("`", ""));
}

function normalizeParticipantId(participant) {
  if (typeof participant === "string") return participant.trim();
  if (participant && typeof participant === "object" && typeof participant.id === "string") {
    return participant.id.trim();
  }
  return null;
}

function validateAiStatus(markdown, options = {}) {
  const errors = [];
  const sectionScan = splitSections(markdown);
  if (sectionScan.duplicates.has(AI_STATUS_SECTION)) {
    errors.push(`duplicate AI status section: ## ${AI_STATUS_SECTION}`);
  }

  const section = sectionScan.sections.get(AI_STATUS_SECTION);
  if (section === undefined) {
    errors.push(`missing required section: ## ${AI_STATUS_SECTION}`);
    return { valid: false, errors, scope: "AI_STATUS_ONLY" };
  }

  const coverage = options.observationCoverage ?? "unknown";
  if (typeof coverage !== "string" || !OBSERVATION_COVERAGES.has(coverage)) {
    errors.push("observationCoverage must be complete, partial, or unknown");
  }

  const coverageLabels = findAiStatusLabel(section, "관측 범위");
  if (coverageLabels.length !== 1) {
    errors.push("AI status must have exactly one observation coverage line");
  } else if (coverageLabels[0].toLowerCase() !== String(coverage).toLowerCase()) {
    errors.push(`AI status observation coverage must match the supplied value: ${coverage}`);
  }

  const table = readAiStatusTable(sectionScan.fieldSections.get(AI_STATUS_SECTION), errors);
  if (!table) {
    return { valid: false, errors, scope: "AI_STATUS_ONLY" };
  }

  for (const header of AI_STATUS_HEADERS) {
    if (table.headers.filter((value) => value === header).length > 1) {
      errors.push(`AI status table must not repeat required header: ${header}`);
    }
  }

  const headerIndexes = new Map(table.headers.map((header, index) => [header, index]));
  const indexOf = (header) => headerIndexes.get(header);
  const malformedRows = table.rows.filter((row) => row.length !== table.headers.length).length;
  if (malformedRows > 0) errors.push("AI status table rows must match the header column count");
  const rows = table.rows.filter((row) => row.length === table.headers.length);
  if (rows.length === 0) errors.push("AI status participant table must contain at least one participant row");

  const agentIds = [];
  const participantIds = [];
  let mainParticipantFound = false;
  let unknownParticipationCount = 0;
  for (const row of rows) {
    const participantId = row[indexOf("agent id")].replaceAll("`", "").trim();
    const role = row[indexOf("실제 역할")].replaceAll("`", "").trim();
    const participation = row[indexOf("실제 참여")].replaceAll("`", "").trim();
    if (!participantId) errors.push("AI status participant row must include an Agent ID");
    else agentIds.push(participantId);
    if (!role) errors.push(`AI status participant ${participantId || "UNKNOWN"} must include an actual role`);
    const isParticipant = /^(?:yes|true|1|예|참여)$/iu.test(participation);
    const isNonParticipant = /^(?:no|false|0|아니오|미참여)$/iu.test(participation);
    const isUnknownParticipation = /^unknown$/iu.test(participation);
    if (!isParticipant && !isNonParticipant && !isUnknownParticipation) {
      errors.push(`AI status participant ${participantId || "UNKNOWN"} must mark participation yes, no, or UNKNOWN`);
    }
    if (isParticipant) participantIds.push(participantId);
    if (isUnknownParticipation) unknownParticipationCount += 1;
    if (/\bmain\b/iu.test(role) && isParticipant) mainParticipantFound = true;

    for (const header of AI_STATUS_HEADERS.slice(6)) {
      const value = row[indexOf(header)].trim();
      if (!value) errors.push(`AI status ${header} must be explicit; use UNKNOWN when unavailable`);
    }
    const lifecycleCounts = [];
    for (const header of ["spawn events", "resume events", "continue events"]) {
      const value = row[indexOf(header)].trim();
      if (!/^(?:\d+|UNKNOWN)$/iu.test(value)) {
        errors.push(`AI status ${header} must be a non-negative count or UNKNOWN`);
      }
      lifecycleCounts.push(value.toUpperCase());
    }
    const hasObservedLifecycleEvent = lifecycleCounts.some((count) => /^\d+$/u.test(count) && /[1-9]/u.test(count));
    if (isNonParticipant && !hasObservedLifecycleEvent) {
      errors.push(`AI status nonparticipant ${participantId || "UNKNOWN"} must have an observed spawn, resume, or continue event with a positive count`);
    }
  }

  if (!mainParticipantFound) errors.push("AI status must include the participating Main row, including Main-only runs");
  if (new Set(agentIds).size !== agentIds.length) {
    errors.push("AI status must contain one row per unique Agent ID");
  }
  if (coverage === "complete" && unknownParticipationCount > 0) {
    errors.push("complete AI status coverage cannot include UNKNOWN participation rows");
  }

  const confirmedCounts = findAiStatusLabel(section, "확인된 참여자 수");
  if (confirmedCounts.length !== 1 || !/^\d+$/u.test(confirmedCounts[0])) {
    errors.push("AI status must have one numeric confirmed participant count");
  } else if (Number(confirmedCounts[0]) !== participantIds.length) {
    errors.push("AI status confirmed participant count must match participant table rows");
  }

  const totalCounts = findAiStatusLabel(section, "전체 참여자 수");
  if (totalCounts.length !== 1) {
    errors.push("AI status must have exactly one total participant count");
  } else if (coverage === "complete") {
    if (!/^\d+$/u.test(totalCounts[0]) || Number(totalCounts[0]) !== participantIds.length) {
      errors.push("complete AI status coverage must report the table row count as the total participant count");
    }
  } else if (totalCounts[0].toUpperCase() !== "UNKNOWN") {
    errors.push("partial or unknown AI status coverage must report total participants as UNKNOWN");
  }

  if (options.observedParticipants !== undefined) {
    if (!Array.isArray(options.observedParticipants)) {
      errors.push("observedParticipants must be an array when supplied");
    } else {
      const observedIds = options.observedParticipants.map(normalizeParticipantId);
      if (observedIds.some((id) => id === null || id.length === 0)) {
        errors.push("observedParticipants entries must be Agent IDs or objects with an id");
      }
      const validObservedIds = observedIds.filter((id) => id !== null && id.length > 0);
      if (new Set(validObservedIds).size !== validObservedIds.length) {
        errors.push("observedParticipants must not contain duplicate Agent IDs");
      }
      const observedSet = new Set(validObservedIds);
      const reportedSet = new Set(participantIds);
      for (const id of validObservedIds) {
        if (!reportedSet.has(id)) errors.push(`AI status does not confirm observed participant: ${id}`);
      }
      for (const id of participantIds) {
        if (!observedSet.has(id)) errors.push(`AI status participant is absent from observedParticipants: ${id}`);
      }
    }
  } else if (coverage === "complete") {
    errors.push("complete AI status coverage requires observedParticipants");
  }

  return { valid: errors.length === 0, errors, scope: "AI_STATUS_ONLY" };
}

function hasUsableContent(body) {
  if (!body) return false;
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => {
    if (/^[-*][ \t]*(?:\[\s*\][ \t]*)?$/.test(line)) return false;
    return !/^[-*]?\s*(none|없음|미정|n\/a)\.?$/i.test(line);
  });
}

function parseStatusLines(lines) {
  const found = new Map();
  const canonicalLabels = new Map(STATUS_LABELS.map((label) => [label.toLowerCase(), label]));
  const labelPattern = new RegExp(
    `^(\\*{1,3}|_{1,3})?(${STATUS_LABELS.join("|")})[ \\t]*(?:(\\1)[ \\t]*)?:[ \\t]*(.*)$`,
    "i"
  );
  const statusPattern = /^(\*{1,3}|_{1,3}|`+)?([A-Z_]+)\1(?:[ \t]*[—-][ \t]*(.*))?[ \t]*$/i;
  for (const { statusText: line, nestedReportEvidence } of lines) {
    const item = MARKDOWN_LIST_ITEM.exec(line);
    // A nested report-field list item can expose a contradiction, but is not
    // standalone evidence for a required status.
    if (nestedReportEvidence && !item) continue;
    const subject = item
      ? line.slice(item[0].length).replace(/^\[[ xX]\][ \t]+/u, "")
      : line.trimStart().replace(/^-(?=[A-Za-z])/u, "");
    const match = labelPattern.exec(subject);
    if (!match) continue;
    const [, emphasis, rawLabel, closedLabel, rawStatus] = match;
    let statusText = rawStatus;
    if (emphasis && !closedLabel) {
      // Emphasis can close after the colon, status, or entire status line.
      const closer = new RegExp(`${emphasis.replaceAll("*", "\\*")}(?=[ \\t—-]|$)`, "u");
      if (!closer.test(statusText) && emphasis !== "*") continue;
      statusText = statusText.replace(closer, "").trimStart();
    }
    const value = statusPattern.exec(statusText);
    // A label followed by ordinary explanation is not an explicit status.
    if (!value) continue;
    const label = canonicalLabels.get(rawLabel.toLowerCase());
    const [, , status, detail] = value;
    const items = found.get(label) ?? [];
    items.push({ status: status.toUpperCase(), detail: (detail ?? "").trim(), nestedReportEvidence });
    found.set(label, items);
  }
  return found;
}

function validateF1Report(markdown, options = {}) {
  const errors = [];
  const requireAiStatus = options?.requireAiStatus ?? false;
  if (typeof requireAiStatus !== "boolean") {
    errors.push("requireAiStatus must be a boolean");
  } else if (requireAiStatus) {
    errors.push(...validateAiStatus(markdown, options).errors);
  }
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

  const statusSections = splitSections(markdown, true).fieldSections;
  const statusLines = parseStatusLines(statusSections.get("검증") ?? []);
  for (const label of STATUS_LABELS) {
    const entries = statusLines.get(label) ?? [];
    if (entries.length !== 1 || entries[0].nestedReportEvidence) {
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

function inspectF1DataObject(value, requiredKeys, optionalKeys = []) {
  try {
    if (utilTypes.isProxy(value) || value === null || typeof value !== "object"
      || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return null;
    if (requiredKeys.some((key) => !Object.hasOwn(value, key))) return null;
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
        || Object.hasOwn(descriptor, "get") || Object.hasOwn(descriptor, "set")) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function isNonEmptyF1Label(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().toUpperCase() !== "UNKNOWN"
    && value.length <= 128
    && /^[\p{L}\p{N} ._@-]+$/u.test(value.trim());
}

function projectUsageCounterBreakdown(value) {
  const inspected = inspectF1DataObject(value, [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ], ["cacheWriteInputTokens"]);
  if (!inspected) return null;
  const projected = {};
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]) {
    if (!Number.isSafeInteger(inspected[key]) || inspected[key] < 0) return null;
    projected[key] = inspected[key];
  }
  if (Object.hasOwn(inspected, "cacheWriteInputTokens")) {
    if (!Number.isSafeInteger(inspected.cacheWriteInputTokens) || inspected.cacheWriteInputTokens < 0) return null;
    projected.cacheWriteInputTokens = inspected.cacheWriteInputTokens;
  } else {
    projected.cacheWriteInputTokens = "UNKNOWN";
  }
  return projected;
}

function formatUsageCounters(breakdown) {
  return `input=${breakdown.inputTokens}, cached_input=${breakdown.cachedInputTokens}, cache_write_input=${breakdown.cacheWriteInputTokens}, output=${breakdown.outputTokens}, reasoning_output=${breakdown.reasoningOutputTokens}, reported_total=${breakdown.totalTokens}`;
}

function unknownUsageCell(reason) {
  return `UNKNOWN — ${reason}; Agent execution tokens, model/reasoning/Fast, turn attribution, runtime/source verification, coverage, and cost remain UNKNOWN.`;
}

// This renders one opt-in adapter result into a pasteable F1 usage cell. Agent/role are caller assertions;
// the adapter event itself does not carry either identity and its token counters are not verified billing.
export function formatUsageObservationForF1(envelope, attribution) {
  const attributed = inspectF1DataObject(attribution, ["agent_id", "role"]);
  if (!attributed || !isNonEmptyF1Label(attributed.agent_id) || !isNonEmptyF1Label(attributed.role)) {
    return Object.freeze({
      agent_id: "UNKNOWN",
      role: "UNKNOWN",
      attribution: "UNKNOWN",
      usage_cell: unknownUsageCell("F1 row attribution was not supplied"),
    });
  }
  const row = Object.freeze({
    agent_id: attributed.agent_id.trim(),
    role: attributed.role.trim(),
    attribution: "CALLER_ASSERTED_F1_ROW; adapter event has no Agent/run ID",
  });
  const invocation = inspectF1DataObject(envelope, ["result", "usage_observation"]);
  if (!invocation || invocation.result === null || typeof invocation.result !== "object") {
    return Object.freeze({ ...row, usage_cell: unknownUsageCell("input is not one per-invocation adapter result") });
  }
  const observation = inspectF1DataObject(invocation.usage_observation, [
    "status", "source", "source_verification", "runtime_version", "coverage", "observed_at",
    "operation_window", "session_identity", "turn_attribution", "deduplication", "aggregation",
    "notification_count", "model", "reasoning_effort", "fast", "token_usage",
  ]);
  if (!observation) {
    return Object.freeze({ ...row, usage_cell: unknownUsageCell("usage observation shape is missing or invalid") });
  }
  const sessionIdentity = validateOpaqueIdentity(observation.session_identity);
  const absence = observation.status === "NO_NOTIFICATION_OBSERVED";
  if ((!absence && observation.status !== "UNVERIFIED_USAGE_NOTIFICATION")
    || observation.source !== CODEX_USAGE_SOURCE
    || observation.source_verification !== "UNKNOWN"
    || observation.runtime_version !== "UNKNOWN"
    || observation.coverage !== "UNKNOWN"
    || observation.turn_attribution !== "UNKNOWN"
    || observation.model !== "UNKNOWN"
    || observation.reasoning_effort !== "UNKNOWN"
    || observation.fast !== "UNKNOWN"
    || observation.deduplication !== "NOT_PERFORMED"
    || observation.aggregation !== "LATEST_NOTIFICATION_ONLY_NO_SUM"
    || !Number.isSafeInteger(observation.notification_count)
    || sessionIdentity.ok !== true || sessionIdentity.kind !== "session"
    || (absence
      ? observation.notification_count !== 0 || observation.token_usage !== null
      : observation.notification_count < 1)) {
    return Object.freeze({ ...row, usage_cell: unknownUsageCell("source, scope, or attribution evidence is incomplete") });
  }
  const canonicalTime = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
  };
  const observedAt = canonicalTime(observation.observed_at);
  const operationWindow = inspectF1DataObject(observation.operation_window, ["started_at", "finished_at"]);
  const startedAt = canonicalTime(operationWindow?.started_at);
  const finishedAt = canonicalTime(operationWindow?.finished_at);
  if (!observedAt || !startedAt || !finishedAt || startedAt > observedAt || observedAt > finishedAt) {
    return Object.freeze({ ...row, usage_cell: unknownUsageCell("observation time window is missing or invalid") });
  }
  if (absence) {
    return Object.freeze({
      ...row,
      usage_cell: unknownUsageCell("no matching notification was observed in this operation window; this does not prove the run had no usage"),
    });
  }
  const tokenUsage = inspectF1DataObject(observation.token_usage, ["last", "total"]);
  const last = tokenUsage ? projectUsageCounterBreakdown(tokenUsage.last) : null;
  const total = tokenUsage ? projectUsageCounterBreakdown(tokenUsage.total) : null;
  if (!last || !total) {
    return Object.freeze({ ...row, usage_cell: unknownUsageCell("counter values are missing or invalid") });
  }
  const usageCell = [
    "Agent execution usage UNKNOWN (caller-attributed F1 row only; event has no Agent/run/turn attribution)",
    `unverified thread counters from ${CODEX_USAGE_SOURCE}`,
    `observed_at=${observedAt}; operation=${startedAt}..${finishedAt}`,
    `notifications=${observation.notification_count}; latest matched notification only; no deduplication or sum`,
    `last{${formatUsageCounters(last)}}`,
    `adapter_total_snapshot{${formatUsageCounters(total)}}`,
    "zero-versus-no-update meaning UNKNOWN; model/reasoning/Fast, runtime/source verification, and cost UNKNOWN",
  ].join("; ");
  return Object.freeze({ ...row, usage_cell: usageCell });
}

function readBoundedUsageInput(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const chunks = [];
  let totalBytes = 0;
  try {
    const inputStat = fs.fstatSync(fd);
    if (!inputStat.isFile() || inputStat.size > MAX_USAGE_OBSERVATION_BYTES) throw new Error("oversized input");
    while (true) {
      const buffer = Buffer.allocUnsafe(4096);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_USAGE_OBSERVATION_BYTES) throw new Error("oversized input");
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function parseCliArguments(args) {
  const parsed = { file: null, options: {}, aiStatusOnly: false, usageObservation: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--require-ai-status") {
      parsed.options.requireAiStatus = true;
    } else if (argument === "--ai-status-only") {
      parsed.aiStatusOnly = true;
      parsed.options.requireAiStatus = true;
    } else if (argument === "--observed-participants-json" || argument === "--observation-coverage") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
      index += 1;
      if (argument === "--observation-coverage") {
        parsed.options.observationCoverage = value;
      } else {
        try {
          parsed.options.observedParticipants = JSON.parse(value);
        } catch {
          throw new Error("--observed-participants-json must contain valid JSON");
        }
      }
    } else if (argument === "--usage-observation-json" || argument === "--usage-agent-id" || argument === "--usage-role") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
      index += 1;
      parsed.usageObservation ??= {};
      const key = argument === "--usage-observation-json" ? "input" : argument === "--usage-agent-id" ? "agent_id" : "role";
      if (Object.hasOwn(parsed.usageObservation, key)) throw new Error(`duplicate option: ${argument}`);
      parsed.usageObservation[key] = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else if (parsed.file === null) {
      parsed.file = argument;
    } else {
      throw new Error(`unexpected argument: ${argument}`);
    }
  }
  if ((parsed.options.observedParticipants !== undefined || parsed.options.observationCoverage !== undefined)
    && !parsed.options.requireAiStatus) {
    throw new Error("participant options require --require-ai-status or --ai-status-only");
  }
  if (parsed.usageObservation !== null) {
    if (parsed.file !== null || parsed.aiStatusOnly || parsed.options.requireAiStatus
      || parsed.options.observedParticipants !== undefined || parsed.options.observationCoverage !== undefined
      || !Object.hasOwn(parsed.usageObservation, "input")
      || !Object.hasOwn(parsed.usageObservation, "agent_id")
      || !Object.hasOwn(parsed.usageObservation, "role")) {
      throw new Error("usage observation mode requires only --usage-observation-json, --usage-agent-id, and --usage-role");
    }
  }
  return parsed;
}

function main() {
  let parsed;
  try {
    parsed = parseCliArguments(process.argv.slice(2));
  } catch (error) {
    console.error("usage: node scripts/f1-report-advisory.mjs <report.md> [--require-ai-status] [--observed-participants-json '<json>'] [--observation-coverage complete|partial|unknown] [--ai-status-only]");
    console.error("       node scripts/f1-report-advisory.mjs --usage-observation-json <file> --usage-agent-id <id> --usage-role <role>");
    console.error(`invalid_arguments: ${error.message}`);
    process.exit(2);
  }
  if (parsed.usageObservation !== null) {
    let envelope;
    try {
      envelope = JSON.parse(readBoundedUsageInput(parsed.usageObservation.input));
    } catch (error) {
      console.error(`invalid_usage_observation: ${error.message === "oversized input" ? error.message : "input must be bounded valid JSON"}`);
      process.exit(2);
    }
    const formatted = formatUsageObservationForF1(envelope, {
      agent_id: parsed.usageObservation.agent_id,
      role: parsed.usageObservation.role,
    });
    console.log(JSON.stringify({
      mode: "MANUAL_F1_USAGE_CELL; not inserted into a report",
      ...formatted,
    }));
    return;
  }
  const { file } = parsed;
  if (!file) {
    console.error("usage: node scripts/f1-report-advisory.mjs <report.md> [--require-ai-status] [--observed-participants-json '<json>'] [--observation-coverage complete|partial|unknown] [--ai-status-only]");
    console.error("       node scripts/f1-report-advisory.mjs --usage-observation-json <file> --usage-agent-id <id> --usage-role <role>");
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`missing_report: ${file}`);
    process.exit(3);
  }

  const markdown = fs.readFileSync(file, "utf8");
  const result = parsed.aiStatusOnly
    ? validateAiStatus(markdown, parsed.options)
    : validateF1Report(markdown, parsed.options);
  if (!result.valid) {
    for (const error of result.errors) console.error(`invalid: ${error}`);
    console.error("advisory_only: report facts, URLs, SHAs, and review independence are not verified");
    process.exit(1);
  }
  if (parsed.aiStatusOnly) {
    console.log(`f1_ai_status_structure_valid_partial: ${file}`);
    console.log("advisory_scope: AI_STATUS_ONLY; this does not mean the full eight-section F1 is valid");
  } else {
    console.log(`f1_report_structure_valid: ${file}`);
  }
  console.log("advisory_only: report facts, URLs, SHAs, and review independence are not verified");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { AI_STATUS_SECTION, REQUIRED_SECTIONS, validateAiStatus, validateF1Report, splitSections };
