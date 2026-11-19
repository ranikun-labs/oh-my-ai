const ROOT_KEYS = new Set(["fields"]);
const FIELD_KEYS = new Set([
  "name",
  "value",
  "source_ref",
  "source_updated_at",
  "observed_at",
]);
const MAX_FIELDS = 100;
const MAX_CELL_LENGTH = 4000;

export function formatWorkStateObservationView(input) {
  const fields = validateInput(input);
  const rows = fields.map(field => [
    cellValue(field.name),
    cellValue(field.value),
    cellValue(field.source_ref),
    cellValue(field.source_updated_at),
    cellValue(field.observed_at),
  ]);

  return [
    "# 작업 관찰 보기",
    "",
    "호출자가 전달한 관찰만 표시합니다. 자동 조회, 권한 판단, 완료 판정은 하지 않습니다.",
    "",
    "| 항목 | 관찰값 | 출처 | Source updated_at | observed_at |",
    "|---|---|---|---|---|",
    ...rows.map(row => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function validateInput(input) {
  if (!isPlainObject(input) || hasUnexpectedKeys(input, ROOT_KEYS)) {
    throw new TypeError("work-view input must be an object containing only fields");
  }
  if (!Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > MAX_FIELDS) {
    throw new TypeError(`work-view fields must contain 1 to ${MAX_FIELDS} entries`);
  }

  const names = new Set();
  return input.fields.map((field) => {
    if (!isPlainObject(field) || hasUnexpectedKeys(field, FIELD_KEYS)) {
      throw new TypeError("each work-view field must be an object with supported keys");
    }
    if (typeof field.name !== "string" || !field.name.trim() || field.name.length > 160) {
      throw new TypeError("each work-view field requires a non-empty name up to 160 characters");
    }
    const name = field.name.trim();
    if (names.has(name)) throw new TypeError("duplicate work-view field name");
    names.add(name);

    validateValue(field, "value", ["string", "number", "boolean"]);
    validateValue(field, "source_ref", ["string"]);
    validateValue(field, "source_updated_at", ["string"]);
    validateValue(field, "observed_at", ["string"]);

    return { ...field, name };
  });
}

function validateValue(field, key, allowedTypes) {
  if (!Object.hasOwn(field, key) || field[key] === null) return;
  if (!allowedTypes.includes(typeof field[key])) {
    throw new TypeError(`work-view ${key} must be a string, number, boolean, or null`);
  }
  if (typeof field[key] === "string" && field[key].length > MAX_CELL_LENGTH) {
    throw new TypeError(`work-view ${key} must be at most ${MAX_CELL_LENGTH} characters`);
  }
  if (typeof field[key] === "number" && !Number.isFinite(field[key])) {
    throw new TypeError("work-view value must be finite");
  }
}

function hasUnexpectedKeys(value, allowed) {
  return Object.keys(value).some(key => !allowed.has(key));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cellValue(value) {
  if (value === null || value === undefined) return "UNKNOWN";
  const text = typeof value === "string" ? value : String(value);
  if (!text.trim()) return "UNKNOWN";
  return escapeMarkdownCell(text);
}

function escapeMarkdownCell(value) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\n|\u2028|\u2029/g, "\\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, character => (
      `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`
    ))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/([`*_{}\[\]()#+!~])/g, "\\$1");
}
