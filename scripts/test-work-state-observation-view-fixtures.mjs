#!/usr/bin/env node

import assert from "node:assert/strict";
import { formatWorkStateObservationView } from "./lib/work-state-observation-view.mjs";

const fields = [
  {
    name: "Jira 업무 상태",
    value: "할 일 · To Do",
    source_ref: "Jira:DEMO-1/10001",
    source_updated_at: "2026-11-09T10:00:00.123Z",
    observed_at: "2026-11-09T10:05:00Z",
  },
  {
    name: "PR 병합 상태",
    value: "병합",
    source_ref: "GitHub:demo/project#7/merge:abc123",
    source_updated_at: null,
    observed_at: "2026-11-09T10:06:00Z",
  },
  {
    name: "Native 실행",
    value: "UNKNOWN",
    source_ref: null,
    source_updated_at: null,
    observed_at: "2026-11-09T10:07:00Z",
  },
  { name: "제로", value: 0 },
  { name: "불리언", value: false },
];

const view = formatWorkStateObservationView({ fields });
assert.match(view, /Jira 업무 상태/);
assert.match(view, /할 일 · To Do/);
assert.match(view, /PR 병합 상태/);
assert.match(view, /병합/);
assert.match(view, /Native 실행/);
assert.match(view, /UNKNOWN/);
assert.match(view, /2026-11-09T10:00:00\.123Z/);
assert.match(view, /2026-11-09T10:05:00Z/);
assert.match(view, /\| 제로 \| 0 \|/);
assert.match(view, /\| 불리언 \| false \|/);
assert.match(view, /권한 판단, 완료 판정은 하지 않습니다/);
assert.doesNotMatch(view, /Objective 완료|자동 승인|완료: true/);
console.log("passed: known-and-unknown-fields-preserve-source-and-observation-times");
console.log("passed: zero-and-false-are-not-treated-as-missing");

const injectionView = formatWorkStateObservationView({
  fields: [{
    name: "이름 | 새 줄\n제목",
    value: "<img src=x onerror=alert(1)>\n| fake row | *bold* [link](javascript:alert(1))",
    source_ref: "fake\n| injected column",
    source_updated_at: null,
    observed_at: "2026-11-09T10:08:00Z",
  }],
});
assert.doesNotMatch(injectionView, /<img|<script|<\/script/i);
assert.match(injectionView, /&lt;img/);
assert.match(injectionView, /\\n/);
assert.match(injectionView, /\\\|/);
assert.match(injectionView, /\\\[link\\\]\\\(javascript/);
const tableRows = injectionView.split("\n").filter(line => line.startsWith("|"));
assert.equal(tableRows.length, 3, "one field must produce one physical table row");
for (const row of tableRows) {
  assert.equal((row.match(/(?<!\\)\|/g) || []).length, 6, "escaped data cannot add table columns");
}
console.log("passed: markdown-newlines-html-and-table-delimiters-are-escaped");

for (const invalid of [
  null,
  [],
  { fields: "not-an-array" },
  { fields: [] },
  { fields: [null] },
  { fields: [{}] },
  { fields: [{ name: "duplicate" }, { name: " duplicate " }] },
  { fields: [{ name: "object-value", value: { nested: true } }] },
  { fields: [{ name: "bad-time", observed_at: 123 }] },
  { fields: [{ name: "extra-key", unsupported: true }] },
  { fields: [{ name: "wrong-root" }], unexpected: true },
]) {
  assert.throws(() => formatWorkStateObservationView(invalid));
}
console.log("passed: invalid-root-fields-and-entry-shapes-are-rejected");
