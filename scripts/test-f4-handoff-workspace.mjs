import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareF4HandoffWorkspace } from "./lib/f4-handoff-workspace.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "f4-handoff-test-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
try {
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "work.txt"), "initial\n");
  git(dir, "add", "work.txt");
  git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
  const commit = git(dir, "rev-parse", "HEAD");
  writeFileSync(path.join(dir, "work.txt"), "unfinished\n");
  const task = { id: "T-1", commit, checkpoint: "checkpoint", next: "test", testEvidence: "previous" };
  const result = prepareF4HandoffWorkspace({ source: dir, parentDirectory: os.tmpdir(), task });
  try {
    assert.equal(readFileSync(path.join(result.workspace, "work.txt"), "utf8"), "unfinished\n");
    assert.equal(readFileSync(path.join(dir, "work.txt"), "utf8"), "unfinished\n");
    assert.equal(result.testEvidenceStatus, "REVALIDATION_REQUIRED");
  } finally {
    rmSync(result.workspace, { recursive: true, force: true });
  }
  writeFileSync(path.join(dir, "untracked"), "important\n");
  assert.throws(() => prepareF4HandoffWorkspace({ source: dir, parentDirectory: os.tmpdir(), task }),
    /handoff_untracked_requires_preservation/);
  assert.equal(readFileSync(path.join(dir, "untracked"), "utf8"), "important\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("F4 handoff workspace preservation PASS");
