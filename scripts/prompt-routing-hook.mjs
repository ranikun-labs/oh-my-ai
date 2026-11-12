#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { matchSkillCandidatesWithStatus } from "./lib/routing-status.mjs";
import { needsJiraFirstDevelopmentPreflight } from "./lib/jira-first-development-intent.mjs";
import {
  hasRecentWorkStartExecution,
  workStartSuggestionStatePath,
} from "./lib/work-start-execution-state.mjs";

const args = new Set(process.argv.slice(2));
const format = args.has("--format=routing-json")
  ? "routing-json"
  : args.has("--format=claude-json")
    ? "claude-json"
    : args.has("--format=codex-json")
      ? "codex-json"
      : args.has("--format=text")
        ? "text"
        : "codex-json";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const automationCandidatesPath = path.join(repoRoot, ".oh-my-ai", "state", "automation-candidates.log");
const SKILL_CANDIDATE_LIMIT = 2;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
});
process.stdin.on("end", () => {
  const event = parseInput(input);
  const prompt = String(event.prompt || event.user_prompt || event.message || input || "");
  if (isSyntheticPromptEvent(event, prompt)) {
    process.exit(0);
  }
  const runtime = format === "claude-json" ? "claude" : format === "codex-json" ? "codex" : "text";
  const sessionId = String(event.session_id || event.sessionId || "");
  const payload = buildPromptRoutingPayload(prompt, { runtime, sessionId });

  if (format === "routing-json") {
    process.stdout.write(`${JSON.stringify(payload.routing, null, 2)}\n`);
    return;
  }

  if (!payload.context && !payload.systemMessage) {
    process.exit(0);
  }

  if (format === "claude-json" || format === "codex-json") {
    writeUserPromptSubmitJson(payload);
    return;
  }

  process.stdout.write(payload.systemMessage || payload.context);
  process.stdout.write("\n");
});

function writeUserPromptSubmitJson(payload) {
  const output = {};

  if (payload.systemMessage) {
    output.systemMessage = payload.systemMessage;
  }

  if (payload.context) {
    output.hookSpecificOutput = {
      hookEventName: "UserPromptSubmit",
      additionalContext: payload.context,
    };
  }

  process.stdout.write(JSON.stringify(output));
  process.stdout.write("\n");
}

function parseInput(input) {
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

function isSyntheticPromptEvent(event, prompt) {
  if (!event || typeof event !== "object") return false;

  // Both adapters pass the UserPromptSubmit JSON payload through unchanged.
  // A task notification is provider-inserted only when it occupies that prompt field.
  const hasPromptField = ["prompt", "user_prompt", "message"]
    .some(field => typeof event[field] === "string");
  if (!hasPromptField) return false;

  return /^\s*<task-notification(?:\s[^>]*)?>[\s\S]*<\/task-notification>\s*$/i.test(prompt);
}

function buildPromptRoutingPayload(prompt, options = {}) {
  const normalized = prompt.toLowerCase();
  const runtime = options.runtime;
  const sessionId = options.sessionId;
  const explicitWorkStart = hasExplicitWorkStartInvocation(prompt, runtime);
  const completedWorkStart = hasRecentWorkStartExecution(process.cwd(), runtime, sessionId, prompt);
  const routing = matchSkillCandidatesWithStatus(normalized, { limit: SKILL_CANDIDATE_LIMIT });

  // A Runtime can remove an explicit command token before a later
  // UserPromptSubmit event. Suppress only when the Engine supplied the same
  // runtime and session identifier; missing correlation deliberately fails open.
  if (explicitWorkStart || completedWorkStart) {
    return { context: "", systemMessage: "", routing: renderRoutingJson(routing) };
  }

  const notes = [];
  let workStartSuggestion = null;

  if (needsJiraFirstDevelopmentPreflight(prompt)) {
    notes.push("- Jira-first development preflight (advisory only): check for an existing RPL Primary Issue and reuse it when appropriate before implementation. If no issue exists, use the approved Ticket Contract/duplicate/preview/approval procedure. Inspect applicable Skill contracts; do not implicitly invoke jira-work or work-start. This hint never approves Jira Create/Update or Git Write.");
  }

  if (hasToilSignal(prompt, normalized)) {
    appendAutomationCandidate(prompt);
    notes.push("- Toil signal: check `.oh-my-ai/state/automation-candidates.log` for auto-detected candidates. Promote only user-confirmed items to `automation-backlog.md`; nudge only if the flow is recurring, stable, and worth automating. Do not create automation before user confirmation.");
  }

  const handoff = hasHandoffSignal(prompt, normalized);
  const pr = hasPrSignal(prompt, normalized);
  const legacyHandoffNudged = handoff || pr;
  if (legacyHandoffNudged) {
    const prSuffix = pr ? " For PR creation, verify first and also consider whether the `project-context` CONTEXT CHECKPOINT needs updating." : "";
    notes.push(
      "- Handoff/PR signal: consider the `handoff-prompt` skill for a short, confirmed next-session export." + prSuffix
    );
  }

  if (hasProjectContextSignal(prompt, normalized)) {
    notes.push("- Project context signal: consider `project-context` CREATE/UPDATE before proceeding; a durable context checkpoint must include decision background, not only a task list.");
  }

  if (
    (runtime === "claude" || runtime === "codex")
    && hasWorkStartIntentSignal(prompt, normalized)
  ) {
    workStartSuggestion = buildWorkStartSuggestion(prompt, options.runtime);
    if (workStartSuggestion) {
      notes.push(workStartSuggestion.context);
    }
  }

  const excludeSkillNames = legacyHandoffNudged ? ["handoff-prompt"] : [];
  const routedCandidates = matchSkillCandidatesWithStatus(normalized, {
    excludeSkillNames,
    limit: SKILL_CANDIDATE_LIMIT,
  });
  if (routedCandidates.status === "unavailable") {
    notes.push(
      `- Skill routing unavailable: routing_status=unavailable; routing_error_code=${routedCandidates.errorCode}; skill_candidates=[]. ${routedCandidates.warnings.join(" ")}`,
    );
  } else {
    for (const warning of routedCandidates.warnings) {
      notes.push(`- Skill routing warning: ${warning}`);
    }
  }

  if (routedCandidates.candidates.length > 0) {
    const rendered = routedCandidates.candidates
      .map(candidate => `\`${candidate.name}\` (matched: ${candidate.matched.join(", ")})`)
      .join(", ");
    notes.push(
      `- Skill routing candidates: ${rendered}. routing_status=${routing.status}. Do not auto-execute skills; inspect fit before applying.`,
    );
  }

  if (notes.length === 0 && !workStartSuggestion) {
    return { context: "", systemMessage: "", routing: renderRoutingJson(routedCandidates) };
  }

  const context = notes.length === 0 ? "" : [
    "[HARNESS:prompt-routing]",
    "The latest user prompt contains harness routing signals. Treat these as non-executing context before continuing:",
    ...notes,
  ].join("\n");

  return {
    context,
    systemMessage: workStartSuggestion ? workStartSuggestion.systemMessage : "",
    routing: renderRoutingJson(routedCandidates),
  };
}

function renderRoutingJson(routing) {
  return {
    routing_status: routing.status,
    routing_error_code: routing.errorCode,
    skill_candidates: routing.candidates.map(candidate => ({
      name: candidate.name,
      matched: candidate.matched,
    })),
    warnings: routing.warnings,
  };
}

function buildWorkStartSuggestion(prompt, runtime) {
  const normalizedPrompt = prompt.replace(/\s+/g, " ").trim();
  if (!normalizedPrompt) return "";

  const promptHash = crypto.createHash("sha256").update(normalizedPrompt).digest("hex");
  const promptKeys = workStartSuggestionKeys(runtime, promptHash);
  const statePath = workStartSuggestionStatePath(process.cwd());
  if (hasSuggestedWorkStart(statePath, promptKeys)) {
    return "";
  }

  rememberSuggestedWorkStart(statePath, promptKeys[0]);
  const command = runtime === "codex"
    ? `$work-start ${normalizedPrompt}`
    : `/work-start ${normalizedPrompt}`;
  const commandName = runtime === "codex" ? "$work-start" : "/work-start";

  const systemMessage = [
    "Suggested by oh-my-ai: Work-start",
    "",
    "이 요청은 구현 전에 관련 코드와 영향 범위를 정리하는 작업에 적합할 수 있습니다.",
    "",
    "Work-start는 로컬 Artifact를 생성합니다.",
    "아직 Work-start는 실행되지 않았습니다.",
    "",
    "실행:",
    command,
    "",
    "사용하지 않으려면 현재 요청을 그대로 계속하세요.",
  ].join("\n");

  const context = [
    "- Suggested by oh-my-ai: Work-start",
    "",
    "  이 요청은 범위와 관련 Context를 먼저 정리하는 작업에 적합할 수 있습니다.",
    "",
    "  Work-start can:",
    "  - find related Skill and local Repository Context candidates",
    "  - summarize scope, cautions, and context gaps",
    "  - generate a Structured Handoff Candidate",
    "",
    "  Consent boundary:",
    "  - state: SUGGESTED",
    "  - Work-start는 로컬 Artifact를 생성합니다",
    "  - 아직 Work-start는 실행되지 않았습니다",
    "  - no Work-start Engine has run",
    "  - no local Artifact has been created",
    "  - Suggestion text is not a tool instruction",
    "  - Suggestion text is not a Skill invocation request",
    "  - Suggestion text is not Engine consent",
    "",
    "  실행하려면 사용자가 다음 명시 명령을 직접 입력해야 합니다:",
    `  ${command}`,
    "",
    "  사용하지 않으려면 현재 요청을 그대로 계속하세요.",
    `  Do not run \`${commandName}\`, \`make work-start\`, \`scripts/work-start.sh\`, or the Work-start Skill from this suggestion.`,
    "  Do not suggest Work-start again for this same user request.",
  ].join("\n");

  return { context, systemMessage };
}

function appendAutomationCandidate(prompt) {
  try {
    fs.mkdirSync(path.dirname(automationCandidatesPath), { recursive: true });
    const summary = prompt.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!summary) return;
    const entry = {
      ts: new Date().toISOString(),
      source: "prompt-routing-hook",
      signal: "toil",
      prompt: summary,
    };
    fs.appendFileSync(automationCandidatesPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Routing context is helpful but must never block prompt submission.
  }
}

function hasSuggestedWorkStart(statePath, promptHash) {
  if (!statePath) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return Array.isArray(parsed.suggested_prompt_hashes)
      && [].concat(promptHash).some(hash => parsed.suggested_prompt_hashes.includes(hash));
  } catch {
    return false;
  }
}

function rememberSuggestedWorkStart(statePath, promptHash) {
  if (!statePath) return;
  try {
    let hashes = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (Array.isArray(parsed.suggested_prompt_hashes)) hashes = parsed.suggested_prompt_hashes;
    } catch {
      hashes = [];
    }
    hashes = [promptHash, ...hashes.filter(hash => hash !== promptHash)].slice(0, 100);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      updated_at: new Date().toISOString(),
      suggested_prompt_hashes: hashes,
    }, null, 2) + "\n", "utf8");
  } catch {
    // Suggestion suppression is helpful but must never block prompt submission.
  }
}

function workStartSuggestionKeys(runtime, promptHash) {
  if (runtime === "claude") {
    return [`claude:${promptHash}`, promptHash];
  }
  if (runtime === "codex") {
    return [`codex:${promptHash}`];
  }
  return [promptHash];
}

function hasExplicitWorkStartInvocation(prompt, runtime) {
  const trimmed = prompt.trim();
  if (runtime === "claude") {
    return /^\/work-start(?:\s|$)/.test(trimmed);
  }
  if (runtime === "codex") {
    return /^\$work-start(?:\s|$)/.test(trimmed);
  }
  return false;
}

function hasToilSignal(prompt, normalized) {
  const directSignals = [
    "매번",
    "맨날",
    "귀찮",
    "자동으로",
    "자동화",
    "반복",
    "스킬로",
    "커맨드로",
  ];
  if (directSignals.some(signal => prompt.includes(signal))) return true;
  if (/\b(automate|automation|repetitive|again and again|every time)\b/.test(normalized)) return true;

  // "또" is common in normal Korean prose, so require nearby toil-like context.
  return /또\s*(해야|하네|하는|같은|반복|수동|놓쳤|까먹|실수|귀찮)/.test(prompt);
}

function hasHandoffSignal(prompt, normalized) {
  if (/(핸드오프|handoff|인수인계|토스|넘겨|넘긴|넘길|새 세션|다른 세션)/i.test(prompt)) return true;
  return /\bcodex\b/.test(normalized) && /(넘겨|넘긴|넘길|토스|핸드오프|새 세션|다른 세션|전환|handoff|continue|resume)/i.test(prompt);
}

function hasPrSignal(prompt, normalized) {
  if (/(pr|pull request|풀리퀘).{0,20}(만들|생성|올려|열어|create|open)/i.test(prompt)) return true;
  if (/(만들|생성|올려|열어|create|open).{0,20}(pr|pull request|풀리퀘)/i.test(prompt)) return true;
  return /\bgh\s+pr\s+create\b/.test(normalized);
}

function hasProjectContextSignal(prompt, normalized) {
  if (/(context 없|컨텍스트 없|맥락 없|이 서비스 처음|새 서비스|새 도메인|처음.{0,10}서비스|처음.{0,10}도메인)/i.test(prompt)) return true;
  if (/(하네스\s*(context|컨텍스트)|(context|컨텍스트)\s*기능|docs\/context|project-context)/i.test(prompt)) return true;
  if (/(설계|결정|맥락|컨텍스트).{0,24}(파일|문서|저장|정리|남겨|기록)/i.test(prompt)) return true;
  if (/(파일|문서|저장|정리|남겨|기록).{0,24}(설계|결정|맥락|컨텍스트)/i.test(prompt)) return true;
  return /\b(no|without|missing)\s+(project\s+)?context\b/.test(normalized);
}

function hasWorkStartIntentSignal(prompt, normalized) {
  if (/(다른\s*세션에\s*넘길\s*수\s*있게\s*정리|작업\s*지시문으로\s*만들|관련\s*(문서|코드|범위).{0,20}먼저\s*모아|handoff\s*(prep|prepare|packet|candidate)|prepare\s*(a\s*)?handoff|turn\s*this\s*into\s*a\s*work\s*instruction)/i.test(prompt)) {
    return true;
  }

  const hasPreparationIntent = /(시작하기\s*전에|구현\s*전에|수정\s*전에|먼저|착수\s*전에|넘기기\s*전에|before\s*(implementing|coding|editing|starting)|prior\s*to\s*(implementation|coding)|first\b)/i.test(prompt);
  const hasWorkStartObject = /(범위|영향\s*범위|관련\s*코드|관련\s*문서|결정\s*문서|컨텍스트|context|handoff|핸드오프|다른\s*세션|scope|impact|related\s*(code|docs|documents)|decision\s*(doc|record)|work-start)/i.test(prompt);

  if (!hasPreparationIntent || !hasWorkStartObject) return false;

  if (/(이\s*버그\s*고쳐|이\s*함수\s*설명|테스트\s*하나\s*추가|이\s*에러가\s*뭐야|코드\s*리뷰|fix\s*this\s*bug|explain\s*this\s*function|add\s*a\s*test|what\s*is\s*this\s*error|review\s*this\s*code)/i.test(prompt)) {
    return false;
  }

  return true;
}
