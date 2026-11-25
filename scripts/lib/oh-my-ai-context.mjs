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

// preload 대상 Core Skill 의 summary + 경로만 담는다. 본문은 넣지 않는다.
// 바이트 상한을 넘는 항목은 빼고 "+N more" 한 줄로 알린다 (상한 안에 머문다).
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

  const header = "[HARNESS:preload] Core skills (summary and path only; open SKILL.md when needed):";
  const lines = [];
  const included = [];
  const omitted = [];
  const omittedNote = n => `- (+${n} more not shown: preload byte cap ${capBytes})`;
  const reserve = Buffer.byteLength(omittedNote(ids.length), "utf8");
  let total = Buffer.byteLength(header, "utf8");

  ids.forEach(id => {
    const skill = index.get(id);
    let line;
    if (!skill) {
      line = `- ${id}: (missing source; not preloaded)`;
    } else {
      const summary = readSkillSummary(skill.skillFile) ?? "(no summary)";
      const rel = path.relative(repoRoot, skill.skillFile).split(path.sep).join("/");
      line = `- ${id}: ${summary} — ${rel}`;
    }
    const size = Buffer.byteLength(`\n${line}`, "utf8");
    // 상한 안에 "+N more" 줄이 항상 들어가도록 그 줄 길이를 미리 남겨 둔다.
    if (total + size + reserve > capBytes) {
      omitted.push(id);
      return;
    }
    lines.push(line);
    included.push(id);
    total += size;
  });

  if (omitted.length > 0) {
    const note = omittedNote(omitted.length);
    lines.push(note);
    total += Buffer.byteLength(`\n${note}`, "utf8");
  }
  const text = [header, ...lines].join("\n");
  return { text, bytes: Buffer.byteLength(text, "utf8"), included, omitted };
}
