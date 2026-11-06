import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

export const FAIL_OPEN_WARNING = "Skill routing unavailable; generic Work-start output generated.";

export function loadSkillIndexWithStatus(indexPath = defaultSkillIndexPath()) {
  let parsed;

  try {
    parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return unavailable("broken_index");
  }

  if (!parsed || !Array.isArray(parsed.skills)) {
    return unavailable("broken_index");
  }

  const skills = [];
  const warnings = [];

  for (const [position, entry] of parsed.skills.entries()) {
    if (!hasRequiredMetadata(entry)) {
      warnings.push(
        `Skill index entry at position ${position} ignored: missing required name or routing metadata.`,
      );
      continue;
    }
    skills.push(entry);
  }

  if (parsed.skills.length > 0 && skills.length === 0) {
    return unavailable("missing_metadata", warnings);
  }

  return {
    status: "ok",
    errorCode: null,
    skills,
    warnings,
  };
}

export function matchSkillCandidatesWithStatus(normalizedInput, options = {}) {
  const indexResult = options.indexResult || loadSkillIndexWithStatus(options.indexPath);
  if (indexResult.status === "unavailable") {
    return routingUnavailable(indexResult.errorCode, indexResult.warnings);
  }

  try {
    const excluded = new Set(options.excludeSkillNames || []);
    const candidates = [];
    let supportedTriggerCount = 0;
    let unsupportedTriggerCount = 0;

    for (const skill of indexResult.skills) {
      if (excluded.has(skill.name)) continue;

      const routing = skill.routing;
      const keywordTriggers = routing.triggers.filter(trigger => trigger.kind === "keyword");
      const patternTriggers = routing.triggers.filter(trigger => trigger.kind === "pattern");
      supportedTriggerCount += keywordTriggers.length + patternTriggers.length;
      unsupportedTriggerCount += routing.triggers.length - keywordTriggers.length - patternTriggers.length;

      if (routing.visibility === "hidden" || routing.risk_level === "high") continue;

      const keywordValues = keywordTriggers.flatMap(trigger => trigger.values);
      const matchedKeywords = keywordValues.filter(value => normalizedInput.includes(value.toLowerCase()));
      // Pattern triggers are opt-in, non-executing candidates. Cap input to
      // 2,000 characters to bound regex work on untrusted user prompts.
      const patternInput = normalizedInput.slice(0, 2000);
      const matchedPatterns = patternTriggers.flatMap(trigger => trigger.values)
        .filter(value => new RegExp(value, "i").test(patternInput))
        .map(() => "pattern:substantial-request");
      const matched = [...matchedKeywords, ...matchedPatterns];
      if (matched.length > 0) {
        candidates.push({
          name: skill.name,
          path: skill.path,
          matched,
          score: matched.length,
        });
      }
    }

    if (supportedTriggerCount === 0 && unsupportedTriggerCount > 0) {
      return routingUnavailable("unsupported_trigger", indexResult.warnings);
    }

    candidates.sort(compareCandidates);
    const status = candidateStatus(candidates);
    const limit = Number.isInteger(options.limit) ? options.limit : candidates.length;

    return {
      status,
      errorCode: null,
      candidates: candidates.slice(0, limit),
      warnings: [...indexResult.warnings],
    };
  } catch {
    return routingUnavailable("consumer_error", indexResult.warnings);
  }
}

function defaultSkillIndexPath() {
  return process.env.OH_MY_AI_SKILL_INDEX || path.join(repoRoot, "skills", "skill-index.json");
}

function hasRequiredMetadata(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (typeof entry.name !== "string" || entry.name.trim() === "") return false;

  const routing = entry.routing;
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) return false;
  if (typeof routing.visibility !== "string" || typeof routing.risk_level !== "string") return false;
  if (!Array.isArray(routing.task_types) || !Array.isArray(routing.triggers)) return false;
  if (routing.triggers.length === 0) return false;

  return routing.triggers.every(trigger => (
    trigger
    && typeof trigger === "object"
    && !Array.isArray(trigger)
    && typeof trigger.kind === "string"
    && Array.isArray(trigger.values)
    && trigger.values.length > 0
    && trigger.values.every(value => typeof value === "string" && value.length > 0)
  ));
}

function compareCandidates(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.name !== b.name) return a.name.localeCompare(b.name);
  return String(a.path || "").localeCompare(String(b.path || ""));
}

function candidateStatus(candidates) {
  if (candidates.length === 0) return "no_match";
  if (candidates.length === 1) return "matched";
  if (candidates[0].score === candidates[1].score) return "ambiguous";
  return "multiple_candidates";
}

function unavailable(errorCode, warnings = []) {
  return {
    status: "unavailable",
    errorCode,
    skills: [],
    warnings: withFailOpenWarning(warnings),
  };
}

function routingUnavailable(errorCode, warnings = []) {
  return {
    status: "unavailable",
    errorCode,
    candidates: [],
    warnings: withFailOpenWarning(warnings),
  };
}

function withFailOpenWarning(warnings) {
  return [...warnings.filter(warning => warning !== FAIL_OPEN_WARNING), FAIL_OPEN_WARNING];
}
