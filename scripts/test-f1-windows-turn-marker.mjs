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

if (process.platform === "win32") {
  const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f1-native-acl-"));
  const originalModulePath = process.env.PSModulePath;
  try {
    process.env.PSModulePath = path.join(nativeRoot, "missing-modules");
    const nativeLocation = { ...location, rootPath: nativeRoot };
    updateWindowsF1TurnMarker(nativeLocation, turn, "submit");
    assert.equal(updateWindowsF1TurnMarker(nativeLocation, turn, "stop"), true);
    assert.equal(updateWindowsF1TurnMarker(nativeLocation, turn, "stop"), "consumed");
    console.log("F1 Windows marker lifecycle PASS (native ACL with missing module path)");
  } finally {
    if (originalModulePath === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = originalModulePath;
    fs.rmSync(nativeRoot, { recursive: true, force: true });
  }
}
