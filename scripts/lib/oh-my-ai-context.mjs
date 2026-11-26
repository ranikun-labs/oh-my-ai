// Hook 경로용 컨텍스트 주입 설정 로더와 preload 블록 빌더.
// 원칙: 이 모듈은 throw 하지 않는다. 설정을 못 읽으면 기본값(on, preload 없음)으로 돌아가고 이유 코드만 돌려준다.
// 주입이 꺼져도 Hook/guard/권한/checkpoint/telemetry 는 이 모듈과 무관하게 동작한다.
import fs from "node:fs";
import path from "node:path";
import { discoverSkills } from "./skill-discovery.mjs";
import { configFilePath, effectiveConfig, readConfigFile } from "./oh-my-ai-config.mjs";

export const PRELOAD_BYTE_CAP = 2048;
const SUMMARY_MAX_CHARS = 200;

export function loadContextConfig(env = process.env) {
  try {
    const eff = effectiveConfig(readConfigFile(configFilePath(env)));
    return {
      ok: true,
      inject: eff["context.inject"].value,
      preload: eff["context.preload"].value,
      errorCode: null,
    };
  } catch {
    // 설정 파일 손상/권한 등: 기본값으로 동작하고 hook 은 계속 진행한다.
    return { ok: false, inject: "on", preload: [], errorCode: "hook_config_unreadable" };
  }
}

// frontmatter 의 metadata.summary 한 줄만 읽는다 (본문은 읽지 않는다).
export function readSkillSummary(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  const fm = lines.slice(1, end === -1 ? lines.length : end);
  let inMeta = false;
  for (const line of fm) {
    if (/^metadata:\s*$/.test(line)) {
      inMeta = true;
      continue;
    }
    if (/^\S/.test(line)) inMeta = false;
    if (inMeta) {
      const m = line.match(/^\s+summary:\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "").slice(0, SUMMARY_MAX_CHARS);
    }
  }
  return null;
}

// preload 한 줄 요약 상한(말줄임 포함, 코드포인트 기준). 넘으면 자르고 "…"을 붙인다.
export const PRELOAD_SUMMARY_CHARS = 60;

// 코드포인트 기준으로 자른다 (한글·이모지 중간에서 끊기지 않게).
// 식별자·경로가 반쪽으로 잘리면 안 된다: 백틱 코드 span 이 열린 채 잘리면 span 시작 전으로,
// 공백 없는 토큰(경로·식별자) 중간이면 토큰 시작 전으로 되돌린다.
export function clipSummary(text, maxChars = PRELOAD_SUMMARY_CHARS) {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  let cut = maxChars - 1;
  let open = -1;
  for (let i = 0; i < cut; i += 1) {
    if (chars[i] === "`") open = open === -1 ? i : -1;
  }
  if (open !== -1) cut = open;
  const isSpace = ch => /\s/.test(ch);
  // 공백 없는 한글 문장은 토큰이 아니다. ASCII 식별자·경로 문자가 든 토큰만 통째로 뺀다.
  if (cut > 0 && cut < chars.length && !isSpace(chars[cut - 1]) && !isSpace(chars[cut])) {
    let start = cut;
    while (start > 0 && !isSpace(chars[start - 1])) start -= 1;
    let end = cut;
    while (end < chars.length && !isSpace(chars[end])) end += 1;
    if (/[A-Za-z0-9_./\\-]/.test(chars.slice(start, end).join(""))) cut = start;
  }
  const kept = chars.slice(0, cut).join("").replace(/\s+$/, "");
  return `${kept}…`;
}

// preload 대상 Core Skill 을 "id — summary" 한 줄로 담는다. 경로는 넣지 않는다(id → SKILL.md 는 skill discovery 로 해석).
// 항목 단위로 빼지 않고 요약만 자른다. 상한을 넘어 빠진 항목은 "+N more" 한 줄로 명시한다.
export function buildPreloadBlock(repoRoot, ids, capBytes = PRELOAD_BYTE_CAP) {
  if (!Array.isArray(ids) || ids.length === 0) return { text: "", bytes: 0, included: [], omitted: [] };
  let index = new Map();
  try {
    for (const skill of discoverSkills(repoRoot).skills) {
      if (!index.has(skill.name)) index.set(skill.name, skill);
    }
  } catch {
    index = new Map();
  }

  const header = "[HARNESS:preload] Core skills (id — summary; resolve path via skill discovery):";
  const omittedNote = n => `- (+${n} more not shown: preload byte cap ${capBytes})`;
  const lineOf = id => {
    const skill = index.get(id);
    if (!skill) return `- ${id} — (missing source; not preloaded)`;
    const summary = clipSummary(readSkillSummary(skill.skillFile) ?? "(no summary)");
    return `- ${id} — ${summary}`;
  };
  const size = line => Buffer.byteLength(`\n${line}`, "utf8");
  const headerBytes = Buffer.byteLength(header, "utf8");

  // 1차: 전부 들어가는지 본다. 들어가면 "+N more" 줄 없이 끝낸다.
  const layout = reserve => {
    const lines = [];
    const included = [];
    const omitted = [];
    let total = headerBytes;
    for (const id of ids) {
      const line = lineOf(id);
      if (total + size(line) + reserve > capBytes) {
        omitted.push(id);
        continue;
      }
      lines.push(line);
      included.push(id);
      total += size(line);
    }
    return { lines, included, omitted };
  };

  let out = layout(0);
  if (out.omitted.length > 0) {
    // 2차: 생략이 생기면 "+N more" 줄을 위해 그 줄 길이(최대 자릿수 기준)를 미리 남기고 다시 배치한다.
    out = layout(Buffer.byteLength(`\n${omittedNote(ids.length)}`, "utf8"));
    out.lines.push(omittedNote(out.omitted.length));
  }
  const text = [header, ...out.lines].join("\n");
  return { text, bytes: Buffer.byteLength(text, "utf8"), included: out.included, omitted: out.omitted };
}
