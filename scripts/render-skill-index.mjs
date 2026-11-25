#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// --root <dir>: render against another tree that contains skills/ (used by tests). Default: this repo.
const repoRoot = parseRootArg(process.argv.slice(2)) ?? path.resolve(__dirname, "..");
const skillsDir = path.join(repoRoot, "skills");
const outputPath = path.join(skillsDir, "skill-index.json");

const VISIBILITY = new Set(["always", "contextual", "optional", "hidden"]);
const RISK_LEVEL = new Set(["low", "medium", "high"]);
const TRIGGER_KIND = new Set(["keyword", "intent", "pattern"]);

const skills = enumerateSkillDirs(skillsDir)
  .sort()
  .map(name => path.join(skillsDir, name, "SKILL.md"))
  .filter(file => fs.existsSync(file))
  .map(readSkill)
  .filter(skill => skill.routing)
  .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

const index = {
  schema_version: 1,
  source: "skills/*/SKILL.md metadata.routing",
  skills,
};

fs.writeFileSync(outputPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(`Rendered ${path.relative(repoRoot, outputPath)}`);

function parseRootArg(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root") {
      if (!args[i + 1]) throw new Error("--root requires a directory");
      return path.resolve(args[i + 1]);
    }
    if (args[i].startsWith("--root=")) return path.resolve(args[i].slice("--root=".length));
    throw new Error(`unknown argument: ${args[i]}`);
  }
  return null;
}

// Real directories are canonical skills. A symlink is resolved explicitly, because
// Dirent.isDirectory() is false for symlinks and they would otherwise vanish silently.
function enumerateSkillDirs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  const canonical = new Set(names);
  const realDir = fs.realpathSync(dir);

  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(dir, entry.name);
    let target;
    try {
      target = fs.realpathSync(linkPath);
    } catch {
      console.error(`warning: ${relativePath(linkPath)} is a dangling symlink; skipped`);
      continue;
    }
    if (!fs.statSync(target).isDirectory()) {
      console.error(`warning: ${relativePath(linkPath)} does not point to a directory; skipped`);
      continue;
    }
    if (path.dirname(target) === realDir && canonical.has(path.basename(target))) {
      continue; // alias of a skill already counted as a real directory
    }
    console.error(`warning: ${relativePath(linkPath)} points outside skills/ or to a non-skill path; skipped`);
  }

  return names;
}

function readSkill(file) {
  const text = fs.readFileSync(file, "utf8");
  const frontmatter = extractFrontmatter(text, file);
  const routingStart = findKey(frontmatter, 2, "routing");
  if (routingStart === -1) {
    return { routing: null };
  }

  const name = scalarValue(frontmatter, 0, "name", file, true);
  const description = scalarValue(frontmatter, 0, "description", file, true);
  const summary = scalarValue(frontmatter, 2, "summary", file, true);
  const routing = parseRouting(frontmatter, routingStart, file);
  validateSkill({ name, description, summary, routing }, file);

  return {
    name,
    path: relativePath(file),
    description,
    summary,
    routing,
  };
}

function extractFrontmatter(text, file) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw new Error(`${relativePath(file)}: missing frontmatter start`);
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error(`${relativePath(file)}: missing frontmatter end`);
  }
  return lines.slice(1, end);
}

function parseRouting(lines, routingStart, file) {
  const routing = {};
  const end = blockEnd(lines, routingStart, 2);

  for (let i = routingStart + 1; i < end; i += 1) {
    if (isBlank(lines[i])) continue;
    assertIndent(lines[i], 4, file, "routing keys");
    const { key, value } = keyValue(lines[i], file);

    if (key === "visibility" || key === "risk_level") {
      routing[key] = requireInlineValue(value, file, key);
      continue;
    }

    if (["task_types", "use_when", "do_not_use_when", "requires"].includes(key)) {
      requireNoInlineValue(value, file, key);
      const parsed = parseScalarList(lines, i, 6, file, key);
      routing[key] = parsed.values;
      i = parsed.end - 1;
      continue;
    }

    if (key === "triggers") {
      requireNoInlineValue(value, file, key);
      const parsed = parseTriggers(lines, i, file);
      routing.triggers = parsed.values;
      i = parsed.end - 1;
      continue;
    }

    if (key === "keywords") {
      requireNoInlineValue(value, file, key);
      const parsed = parseKeywords(lines, i, file);
      routing.keywords = parsed.values;
      i = parsed.end - 1;
      continue;
    }

    throw new Error(`${relativePath(file)}: unsupported metadata.routing key "${key}"`);
  }

  return routing;
}

function parseTriggers(lines, start, file) {
  const end = blockEnd(lines, start, 4);
  const triggers = [];
  let current = null;

  for (let i = start + 1; i < end; i += 1) {
    if (isBlank(lines[i])) continue;
    const indent = countIndent(lines[i]);
    const trimmed = lines[i].trim();

    if (indent === 6 && trimmed.startsWith("- ")) {
      if (current) triggers.push(current);
      const rest = trimmed.slice(2);
      const { key, value } = keyValue(rest, file);
      if (key !== "kind") {
        throw new Error(`${relativePath(file)}: triggers list items must start with "- kind: ..."`);
      }
      current = { kind: requireInlineValue(value, file, "triggers.kind") };
      continue;
    }

    if (!current) {
      throw new Error(`${relativePath(file)}: trigger property before trigger item`);
    }

    if (indent === 8) {
      const { key, value } = keyValue(lines[i], file);
      if (key !== "values") {
        throw new Error(`${relativePath(file)}: unsupported trigger key "${key}"`);
      }
      requireNoInlineValue(value, file, "triggers.values");
      const parsed = parseScalarList(lines, i, 10, file, "triggers.values");
      current.values = parsed.values;
      i = parsed.end - 1;
      continue;
    }

    throw new Error(`${relativePath(file)}: unsupported triggers YAML shape near "${trimmed}"`);
  }

  if (current) triggers.push(current);
  return { values: triggers, end };
}

function parseKeywords(lines, start, file) {
  const end = blockEnd(lines, start, 4);
  const keywords = {};

  for (let i = start + 1; i < end; i += 1) {
    if (isBlank(lines[i])) continue;
    assertIndent(lines[i], 6, file, "keywords language keys");
    const { key, value } = keyValue(lines[i], file);
    requireNoInlineValue(value, file, `keywords.${key}`);
    const parsed = parseScalarList(lines, i, 8, file, `keywords.${key}`);
    keywords[key] = parsed.values;
    i = parsed.end - 1;
  }

  return { values: keywords, end };
}

function parseScalarList(lines, start, itemIndent, file, field) {
  const parentIndent = itemIndent - 2;
  const end = blockEnd(lines, start, parentIndent);
  const values = [];

  for (let i = start + 1; i < end; i += 1) {
    if (isBlank(lines[i])) continue;
    assertIndent(lines[i], itemIndent, file, field);
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("- ")) {
      throw new Error(`${relativePath(file)}: ${field} only supports "- value" scalar lists`);
    }
    const value = trimmed.slice(2).trim();
    if (!value || value.includes(": ")) {
      throw new Error(`${relativePath(file)}: ${field} list item must be a scalar string`);
    }
    values.push(unquote(value));
  }

  return { values, end };
}

function validateSkill(skill, file) {
  const { routing } = skill;
  requiredEnum(routing, "visibility", VISIBILITY, file);
  requiredEnum(routing, "risk_level", RISK_LEVEL, file);
  requiredArray(routing, "task_types", file);
  requiredArray(routing, "triggers", file);
  optionalArray(routing, "use_when", file);
  optionalArray(routing, "do_not_use_when", file);
  optionalArray(routing, "requires", file);

  for (const trigger of routing.triggers) {
    if (!TRIGGER_KIND.has(trigger.kind)) {
      throw new Error(`${relativePath(file)}: routing.triggers.kind must be one of ${[...TRIGGER_KIND].join(", ")}`);
    }
    if (!Array.isArray(trigger.values) || trigger.values.length === 0) {
      throw new Error(`${relativePath(file)}: routing.triggers.values must be a non-empty array`);
    }
  }

  if (routing.keywords !== undefined) {
    if (!routing.keywords || Array.isArray(routing.keywords) || typeof routing.keywords !== "object") {
      throw new Error(`${relativePath(file)}: routing.keywords must be an object of language arrays`);
    }
    for (const [lang, values] of Object.entries(routing.keywords)) {
      if (!/^[a-z][a-z0-9_-]*$/i.test(lang)) {
        throw new Error(`${relativePath(file)}: routing.keywords language "${lang}" is invalid`);
      }
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(`${relativePath(file)}: routing.keywords.${lang} must be a non-empty array`);
      }
    }
  }
}

function requiredEnum(object, key, allowed, file) {
  if (!allowed.has(object[key])) {
    throw new Error(`${relativePath(file)}: routing.${key} must be one of ${[...allowed].join(", ")}`);
  }
}

function requiredArray(object, key, file) {
  if (!Array.isArray(object[key]) || object[key].length === 0) {
    throw new Error(`${relativePath(file)}: routing.${key} must be a non-empty array`);
  }
}

function optionalArray(object, key, file) {
  if (object[key] !== undefined && (!Array.isArray(object[key]) || object[key].length === 0)) {
    throw new Error(`${relativePath(file)}: routing.${key} must be a non-empty array when present`);
  }
}

function scalarValue(lines, indent, key, file, required = false) {
  const index = findKey(lines, indent, key);
  if (index === -1) {
    if (required) throw new Error(`${relativePath(file)}: missing frontmatter key "${key}"`);
    return "";
  }
  return requireInlineValue(keyValue(lines[index], file).value, file, key);
}

function findKey(lines, indent, key) {
  return lines.findIndex(line => !isBlank(line) && countIndent(line) === indent && line.trim().startsWith(`${key}:`));
}

function blockEnd(lines, start, parentIndent) {
  let i = start + 1;
  for (; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    if (countIndent(lines[i]) <= parentIndent) break;
  }
  return i;
}

function keyValue(line, file) {
  const trimmed = line.trim();
  const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(trimmed);
  if (!match) {
    throw new Error(`${relativePath(file)}: expected "key: value" near "${trimmed}"`);
  }
  return { key: match[1], value: match[2].trim() };
}

function requireInlineValue(value, file, key) {
  if (!value) {
    throw new Error(`${relativePath(file)}: "${key}" requires an inline scalar value`);
  }
  if (value.startsWith("[") || value.startsWith("{")) {
    throw new Error(`${relativePath(file)}: "${key}" does not support inline YAML collections`);
  }
  return unquote(value);
}

function requireNoInlineValue(value, file, key) {
  if (value) {
    throw new Error(`${relativePath(file)}: "${key}" must use an indented block, not an inline value`);
  }
}

function assertIndent(line, expected, file, context) {
  const actual = countIndent(line);
  if (actual !== expected) {
    throw new Error(`${relativePath(file)}: ${context} expected indent ${expected}, got ${actual}`);
  }
}

function countIndent(line) {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

function isBlank(line) {
  return line.trim() === "";
}

function unquote(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function relativePath(file) {
  return path.relative(repoRoot, file);
}
