import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateWindowsF1TurnMarker } from "./lib/f1-windows-turn-marker.mjs";

const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "f1-windows-marker-"));
const location = { rootPath, repositoryId: "repository", worktreeId: "worktree" };
const turn = "test-turn";
const verify = () => true;
try {
  assert.equal(updateWindowsF1TurnMarker(location, turn, "submit", () => false), false);
  assert.deepEqual(fs.readdirSync(rootPath), []);
  assert.equal(updateWindowsF1TurnMarker(location, turn, "submit", verify), false);
  assert.equal(updateWindowsF1TurnMarker(location, turn, "stop", () => false), false);
  assert.equal(updateWindowsF1TurnMarker({ ...location, worktreeId: "other" }, turn, "stop", verify), false);
  assert.equal(updateWindowsF1TurnMarker(location, turn, "stop", verify), true);
  assert.equal(updateWindowsF1TurnMarker(location, turn, "stop", verify), "consumed");
  updateWindowsF1TurnMarker(location, turn, "submit", verify);
  assert.equal(updateWindowsF1TurnMarker(location, turn, "stop", verify), "consumed");
} finally {
  fs.rmSync(rootPath, { recursive: true, force: true });
}
console.log("F1 Windows marker lifecycle PASS (fixture ACL)");
