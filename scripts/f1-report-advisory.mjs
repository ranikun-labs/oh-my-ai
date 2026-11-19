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

function splitMarkdownTableRow(line) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;

  const cells = [];
  let cell = "";
  let escaped = false;
  for (const character of trimmed.slice(1, -1)) {
    if (character === "|" && !escaped) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
    if (character === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
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

function findAiStatusTable(sectionBody) {
  const lines = String(sectionBody).split(/\r?\n/u);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = splitMarkdownTableRow(lines[index]);
    const separators = splitMarkdownTableRow(lines[index + 1]);
    if (!headers || !separators || headers.length !== separators.length) continue;
    if (!separators.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;

    const normalizedHeaders = headers.map(normalizeTableHeader);
    if (!AI_STATUS_HEADERS.every((header) => normalizedHeaders.includes(header))) continue;

    const rows = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = splitMarkdownTableRow(lines[rowIndex]);
      if (!cells) break;
      rows.push(cells);
    }
    return { headers: normalizedHeaders, rows };
  }
  return null;
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

  const table = findAiStatusTable(section);
  if (!table) {
    errors.push("AI status must contain the required participant table");
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

function parseCliArguments(args) {
  const parsed = { file: null, options: {}, aiStatusOnly: false };
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
  return parsed;
}

function main() {
  let parsed;
  try {
    parsed = parseCliArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`usage: node scripts/f1-report-advisory.mjs <report.md> [--require-ai-status] [--observed-participants-json '<json>'] [--observation-coverage complete|partial|unknown] [--ai-status-only]`);
    console.error(`invalid_arguments: ${error.message}`);
    process.exit(2);
  }
  const { file } = parsed;
  if (!file) {
    console.error("usage: node scripts/f1-report-advisory.mjs <report.md> [--require-ai-status] [--observed-participants-json '<json>'] [--observation-coverage complete|partial|unknown] [--ai-status-only]");
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
