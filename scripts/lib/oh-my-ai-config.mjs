// 사용자 설정 저장소: ${XDG_CONFIG_HOME:-~/.config}/oh-my-ai/config.json (mode 0600, atomic write).
// 파일에는 명시적으로 set한 키만 저장한다. 기본값은 CONFIG_KEYS의 default에서 읽는다.
// 주의: update.policy=AUTO 는 저장만 한다. 아직 자동 실행되는 경로는 없다.
// 주의: context.inject=off 는 컨텍스트 주입만 끈다. Hook/guard/권한 계약은 영향을 받지 않는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_REPO_ROOT, coreIdsOf, discoverSkills } from "./skill-discovery.mjs";

export class ConfigError extends Error {}

// context.preload 허용 목록 = skill-discovery 의 Core 집합(과도기 목록 포함). 프로세스당 한 번만 계산한다.
let coreIdCache = null;
function knownCoreIds() {
  coreIdCache ??= new Set(coreIdsOf(discoverSkills(DEFAULT_REPO_ROOT)).map(entry => entry.id));
  return coreIdCache;
}

export const CONFIG_KEYS = Object.freeze({
  "update.policy": { type: "enum", values: ["OFF", "CHECK", "AUTO"], default: "CHECK" },
  "context.inject": { type: "enum", values: ["on", "off"], default: "on" },
  "context.preload": { type: "core-list", default: [] },
});

export function configFilePath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "oh-my-ai", "config.json");
}

// 파일을 읽어 검증한다. 없으면 빈 객체. 깨졌으면 ConfigError (덮어쓰지 않는다).
// warnings 배열을 넘기면 무시한 항목(Core에서 빠진 context.preload id)을 적어 준다.
// Core 목록이 바뀌어 저장된 id가 stale이 돼도 ConfigError로 취급하지 않는다: 그러면 config 가 실패하고
// hook 은 기본값(context.inject=on)으로 돌아가 사용자가 꺼 둔 주입이 다시 켜진다.
export function readConfigFile(file, warnings = null) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new ConfigError(`config unreadable: ${error.code || error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError("config.json is not valid JSON (file left untouched)");
  }
  return validateStored(raw, warnings);
}

function validateStored(raw, warnings) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("config.json must be an object");
  for (const section of Object.keys(raw)) {
    if (!["update", "context"].includes(section)) throw new ConfigError(`unknown config section: ${section}`);
  }
  const stored = {};
  for (const section of ["update", "context"]) {
    const body = raw[section];
    if (body === undefined) continue;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ConfigError(`config section ${section} must be an object`);
    }
    for (const name of Object.keys(body)) {
      const key = `${section}.${name}`;
      if (!CONFIG_KEYS[key]) throw new ConfigError(`unknown config key: ${key}`);
      let value = body[name];
      if (key === "context.preload" && Array.isArray(value)) {
        const known = knownCoreIds();
        const kept = value.filter(id => typeof id !== "string" || known.has(id));
        for (const id of value) {
          if (typeof id === "string" && !known.has(id)) {
            warnings?.push(`context.preload: "${id}" is no longer a Core skill; ignored (fix with: config set context.preload <ids>)`);
          }
        }
        value = kept;
      }
      stored[key] = validateValue(key, value);
    }
  }
  return stored;
}

// 저장된(이미 파싱된) 값 검증. 정규화된 값을 돌려준다.
export function validateValue(key, value) {
  const spec = CONFIG_KEYS[key];
  if (!spec) throw new ConfigError(`unknown config key: ${key}`);
  if (spec.type === "enum") {
    if (!spec.values.includes(value)) {
      throw new ConfigError(`${key} must be one of ${spec.values.join("|")} (got ${JSON.stringify(value)})`);
    }
    return value;
  }
  if (!Array.isArray(value)) throw new ConfigError(`${key} must be a list of Core skill ids`);
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !knownCoreIds().has(id)) {
      throw new ConfigError(`${key}: "${id}" is not a Core skill id`);
    }
    if (seen.has(id)) throw new ConfigError(`${key}: duplicate "${id}"`);
    seen.add(id);
  }
  return [...value];
}

// 사용자 입력 문자열을 값으로 바꾼다. preload는 쉼표 구분, 빈 문자열은 빈 목록.
export function parseInput(key, text) {
  const spec = CONFIG_KEYS[key];
  if (!spec) throw new ConfigError(`unknown config key: ${key}`);
  if (spec.type === "enum") return validateValue(key, text);
  const ids = text.trim() === "" ? [] : text.split(",").map(s => s.trim());
  return validateValue(key, ids);
}

export function effectiveConfig(stored) {
  const out = {};
  for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
    const isSet = Object.prototype.hasOwnProperty.call(stored, key);
    out[key] = {
      value: isSet ? stored[key] : structuredClone(spec.default),
      source: isSet ? "file" : "default",
    };
  }
  return out;
}

// 원자적 쓰기: 같은 디렉터리의 임시 파일(0600, fsync) → rename. 실패 시 임시 파일을 지운다.
export function writeConfigFile(file, stored) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const nested = {};
  for (const [key, value] of Object.entries(stored)) {
    const [section, name] = key.split(".");
    nested[section] ??= {};
    nested[section][name] = value;
  }
  const body = `${JSON.stringify(nested, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
