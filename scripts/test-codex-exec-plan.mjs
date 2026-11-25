#!/usr/bin/env node
// FX-CXP: RPL-118 PR-1 codex-exec-plan 회귀. Mock CLI만 사용하며 실제 codex/모델 호출 없음.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateAgentManifest } from "./lib/agent-manifest-guard.mjs";
import {
  RPL116_REASONING_ALLOWLIST, assembleCodexExecCommand, resolveCodexExecutable,
  createJsonlParser, parseJsonl, compareRequestedVsReported, classifyCodexExecRun,
} from "./lib/codex-exec-plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(here, "..", "fixtures", "codex-exec", "mock-codex-exec.mjs");
let n = 0;
const t = (id, fn) => { fn(); n += 1; console.log("PASS " + id); };

const policy = { models: ["mock-model", "other-model"], efforts: [...RPL116_REASONING_ALLOWLIST] };
const base = (over = {}) => ({
  mode: "new", executable: "/usr/local/bin/codex", model: "mock-model", effort: "high", cwd: "/work/repo",
  sandbox: "workspace-write", approval: "never", prompt: "do the thing\n--not-an-option", policy, platform: "linux", ...over,
});
const bad = (req, needle) => {
  const r = assembleCodexExecCommand(req);
  assert.equal(r.ok, false); assert.equal(r.code, "PLAN_INVALID");
  if (needle) assert.ok(r.reasons.some(x => x.includes(needle)), needle + " in " + JSON.stringify(r.reasons));
};

// ---- 1. assembler ----
t("CXP-01 new run argv deterministic, prompt on stdin", () => {
  const r = assembleCodexExecCommand(base());
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ["exec", "--json", "-c", 'model="mock-model"', "-c", 'model_reasoning_effort="high"',
    "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"', "-"]);
  assert.equal(r.stdin, "do the thing\n--not-an-option");
  assert.equal(r.spawnCwd, "/work/repo");
  assert.ok(!r.argv.some(a => a.includes("do the thing")));
  assert.deepEqual(assembleCodexExecCommand(base()), r);
});
t("CXP-02 resume argv", () => {
  const r = assembleCodexExecCommand(base({ mode: "resume", sessionId: "mock-session-0001", options: { skipGitRepoCheck: true } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv.slice(0, 4), ["exec", "resume", "mock-session-0001", "--json"]);
  assert.equal(r.argv.at(-2), "--skip-git-repo-check"); assert.equal(r.argv.at(-1), "-");
});
t("CXP-03 resume/new sessionId rules", () => {
  bad(base({ mode: "resume" }), "sessionId");
  bad(base({ mode: "resume", sessionId: "--last" }), "sessionId");
  bad(base({ mode: "resume", sessionId: "x; rm -rf /" }), "sessionId");
  bad(base({ sessionId: "mock-session-0001" }), "only valid for resume");
});
t("CXP-04 unknown options rejected", () => {
  bad(base({ dangerouslyBypass: true }), "unknown option");
  bad(base({ options: { fullAuto: true } }), "options.fullAuto");
  bad(base({ policy: { models: ["a"], efforts: ["low"], x: 1 } }), "unknown policy key");
});
t("CXP-05 model/effort mandatory, no defaults, policy enforced", () => {
  bad(base({ model: undefined }), "model required");
  bad(base({ effort: undefined }), "effort required");
  bad(base({ policy: undefined }), "policy");
  bad(base({ model: "rogue-model" }), "model not in policy");
  bad(base({ effort: "xhigh" }), "effort not in policy");
  bad(base({ model: 'x" -c sandbox_mode="danger-full-access' }), "model required");
  bad(base({ effort: "-high" }), "effort required");
});
t("CXP-06 RPL-116 allowlist mirror matches real guard", () => {
  const manifest = reasoning => ({ agent_id: "a", role: "writer", task: "t", permissions: "scoped-write",
    requested: { model: "m", reasoning, fast: false }, runtime: { id: "r" },
    authorization: { status: "approved", scope: "s", evidence_ref: "e" }, target: { repo: "r", branch: "b", primary_jira: "J-1" } });
  for (const e of RPL116_REASONING_ALLOWLIST) assert.equal(validateAgentManifest(manifest(e)).status, "VALID", e);
  for (const e of ["xhigh", "ultra", "minimal", ""]) assert.equal(validateAgentManifest(manifest(e)).status, "BLOCKED", e);
});
t("CXP-07 cwd absolute, sandbox/approval explicit, prompt valid", () => {
  bad(base({ cwd: "relative/dir" }), "cwd");
  bad(base({ cwd: undefined }), "cwd");
  bad(base({ platform: "win32", cwd: "\\rooted-no-drive", executable: "C:\\bin\\codex.exe" }), "cwd");
  assert.equal(assembleCodexExecCommand(base({ platform: "win32", cwd: "C:\\work\\repo", executable: "C:\\bin\\codex.exe" })).ok, true);
  bad(base({ sandbox: undefined }), "sandbox");
  bad(base({ sandbox: "danger-full-access" }), "sandbox");
  bad(base({ approval: undefined }), "approval");
  bad(base({ prompt: "  " }), "prompt");
  bad(base({ prompt: "a\0b" }), "prompt");
  bad(base({ executable: "codex" }), "executable");
});

// ---- 3. resolver (fake fs) ----
const fakeFs = (files, execOk = () => true) => ({
  statSync(p) {
    const f = files[p];
    if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { isFile: () => f === "file" };
  },
  accessSync(p) { if (!execOk(p)) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
});
t("CXP-10 posix PATH resolution, skips relative/empty/non-exec/dir", () => {
  const fs_ = fakeFs({ "/a/codex": "file", "/b/codex": "file", "/c/codex": "dir" }, p => p !== "/a/codex");
  const r = resolveCodexExecutable({ platform: "linux", fs: fs_, env: { PATH: ":rel/bin:./x:/c:/a:/b" } });
  assert.equal(r.ok, true); assert.equal(r.path, "/b/codex"); assert.equal(r.source, "PATH");
  const reasons = r.skipped.map(s => s.reason);
  for (const x of ["EMPTY_PATH_ENTRY", "RELATIVE_PATH_ENTRY", "NOT_REGULAR_FILE", "NOT_EXECUTABLE"]) assert.ok(reasons.includes(x), x);
});
t("CXP-11 posix: only relative/empty PATH or cwd-local => not found", () => {
  const fs_ = fakeFs({ "/work/repo/bin/codex": "file", "/work/repo/codex": "file" });
  const r = resolveCodexExecutable({ platform: "linux", fs: fs_, cwd: "/work/repo", env: { PATH: "bin::.:/work/repo/bin:/work/repo" } });
  assert.equal(r.ok, false); assert.equal(r.code, "CODEX_NOT_FOUND");
  assert.ok(r.skipped.some(s => s.reason === "WORKSPACE_LOCAL"));
  assert.equal(resolveCodexExecutable({ platform: "linux", fs: fs_, env: {} }).ok, false);
});
t("CXP-12 explicit path", () => {
  const fs_ = fakeFs({ "/opt/codex/bin/codex": "file" });
  assert.equal(resolveCodexExecutable({ platform: "linux", fs: fs_, explicitPath: "/opt/codex/bin/codex" }).path, "/opt/codex/bin/codex");
  assert.equal(resolveCodexExecutable({ platform: "linux", fs: fs_, explicitPath: "codex" }).code, "EXPLICIT_PATH_INVALID");
  assert.equal(resolveCodexExecutable({ platform: "linux", fs: fs_, explicitPath: "/nope/codex" }).code, "EXPLICIT_PATH_REJECTED");
  assert.equal(resolveCodexExecutable({ platform: "linux", fs: fs_, cwd: "/opt/codex", explicitPath: "/opt/codex/bin/codex" }).code, "EXPLICIT_PATH_REJECTED");
});
const W = "C:\\Tools\\npm";
t("CXP-13 win32 PATHEXT order, case-insensitive Path key, quoted entries", () => {
  const fs_ = fakeFs({ [W + "\\codex.cmd"]: "file", "C:\\Prog Files\\codex.exe": "file" });
  const env = { Path: '"C:\\Prog Files";' + W, PATHEXT: ".COM;.EXE;.CMD" };
  const r = resolveCodexExecutable({ platform: "win32", fs: fs_, env });
  assert.equal(r.ok, true); assert.equal(r.path, "C:\\Prog Files\\codex.exe"); assert.equal(r.cmdShim, false);
});
t("CXP-14 win32 .cmd shim rejected by default, allowed explicitly with flag", () => {
  const fs_ = fakeFs({ [W + "\\codex.cmd"]: "file" });
  const env = { PATH: W, PATHEXT: ".EXE;.CMD" };
  const r = resolveCodexExecutable({ platform: "win32", fs: fs_, env });
  assert.equal(r.ok, false); assert.ok(r.skipped.some(s => s.reason === "CMD_SHIM_UNSUPPORTED"));
  const ok = resolveCodexExecutable({ platform: "win32", fs: fs_, env, allowCmdShim: true });
  assert.equal(ok.ok, true); assert.equal(ok.cmdShim, true);
});
t("CXP-15 win32 rejects relative/cwd-local/bat/ps1/no-PATHEXT", () => {
  const fs_ = fakeFs({ "C:\\work\\repo\\codex.exe": "file", ".\\codex.exe": "file", "C:\\x\\codex.bat": "file", "C:\\x\\codex.ps1": "file" });
  const r = resolveCodexExecutable({ platform: "win32", fs: fs_, cwd: "C:\\Work\\Repo", env: { PATH: ".;;C:\\work\\repo;C:\\x" } });
  assert.equal(r.ok, false);
  const reasons = r.skipped.map(s => s.reason);
  assert.ok(reasons.includes("RELATIVE_PATH_ENTRY") && reasons.includes("EMPTY_PATH_ENTRY") && reasons.includes("WORKSPACE_LOCAL"));
  assert.equal(resolveCodexExecutable({ platform: "win32", fs: fs_, env: { PATH: "C:\\x", PATHEXT: ".BAT;.PS1" } }).ok, false);
  assert.equal(resolveCodexExecutable({ platform: "win32", fs: fs_, explicitPath: "C:\\x\\codex.bat" }).code, "EXPLICIT_PATH_REJECTED");
  assert.equal(resolveCodexExecutable({ platform: "win32", fs: fs_, explicitPath: "codex.exe" }).code, "EXPLICIT_PATH_INVALID");
});

// ---- 5. parser ----
t("CXP-20 parser tolerant to partial chunks and CRLF", () => {
  const p = createJsonlParser();
  for (const c of ['{"type":"a"}\r\n{"ty', 'pe":"b"}\n', '\n{"type":"c"}\n']) p.feed(c);
  const r = p.finish();
  assert.deepEqual(r.events.map(e => e.type), ["a", "b", "c"]);
  assert.equal(r.malformed.length, 0); assert.equal(r.truncated, false);
});
t("CXP-21 parser flags malformed, non-event, truncated tail", () => {
  const r = parseJsonl('{bad\n[1]\n{"x":1}\n{"type":"ok"}\n{"type":"tr');
  assert.deepEqual(r.events.map(e => e.type), ["ok"]);
  assert.equal(r.truncated, true); assert.equal(r.malformed.length, 4);
});

// ---- 4. config comparison ----
t("CXP-30 compare MATCH / MISMATCH / UNKNOWN", () => {
  const req = { model: "m", effort: "high" };
  assert.equal(compareRequestedVsReported(req, [{ type: "x", model: "m", reasoning_effort: "high" }]).status, "MATCH");
  assert.equal(compareRequestedVsReported(req, [{ type: "x", model: "z", reasoning_effort: "high" }]).status, "MISMATCH");
  assert.equal(compareRequestedVsReported(req, [{ type: "x", model: "m", reasoning_effort: "low" }]).status, "MISMATCH");
  assert.equal(compareRequestedVsReported(req, [{ type: "x" }]).status, "UNKNOWN");
  assert.equal(compareRequestedVsReported(req, [{ type: "x", model: "m" }]).status, "UNKNOWN");
  assert.equal(compareRequestedVsReported(req, [{ type: "x", model: "m", reasoning_effort: "high" }, { type: "y", model: "z" }]).status, "MISMATCH");
});

// ---- 5/6. classification via Mock CLI ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxp-"));
const runMock = (scenario, { mode = "new", model, effort, requestOver = {} } = {}) => {
  const rec = path.join(tmp, scenario + "-" + mode + ".json");
  const resolved = resolveCodexExecutable({ fs, explicitPath: MOCK, cwd: tmp });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const plan = assembleCodexExecCommand(base({
    executable: resolved.path, cwd: tmp, platform: process.platform, mode,
    ...(mode === "resume" ? { sessionId: "mock-session-0001" } : {}), ...requestOver,
  }));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const env = { ...process.env, MOCK_CODEX_SCENARIO: scenario, MOCK_CODEX_RECORD: rec };
  if (model) env.MOCK_CODEX_MODEL = model;
  if (effort) env.MOCK_CODEX_EFFORT = effort;
  const proc = spawnSync(plan.executable, plan.argv, { input: plan.stdin, cwd: plan.spawnCwd, env, encoding: "utf8", shell: false });
  assert.equal(proc.error, undefined);
  const cls = classifyCodexExecRun({ stdout: proc.stdout, exitCode: proc.status, signal: proc.signal, requested: plan.requested });
  return { plan, proc, cls, rec: JSON.parse(fs.readFileSync(rec, "utf8")) };
};
t("CXP-40 mock success => SUCCESS + MATCH, argv/stdin delivered", () => {
  const { cls, rec, plan } = runMock("success");
  assert.equal(cls.outcome, "SUCCESS"); assert.equal(cls.config.status, "MATCH");
  assert.equal(cls.sessionId, "mock-session-0001"); assert.equal(cls.autoRetry, false);
  assert.deepEqual(rec.argv, plan.argv); assert.equal(rec.stdin, plan.stdin);
});
t("CXP-41 mock resume keeps the session id", () => {
  const { cls, rec } = runMock("success", { mode: "resume" });
  assert.equal(cls.outcome, "SUCCESS"); assert.equal(cls.sessionId, "mock-session-0001");
  assert.deepEqual(rec.argv.slice(0, 3), ["exec", "resume", "mock-session-0001"]);
});
t("CXP-42 model/effort mismatch is never SUCCESS", () => {
  const m = runMock("success", { model: "other-model" });
  assert.equal(m.cls.config.status, "MISMATCH"); assert.equal(m.cls.outcome, "FAILED");
  const e = runMock("success", { effort: "low" });
  assert.equal(e.cls.config.status, "MISMATCH"); assert.equal(e.cls.outcome, "FAILED");
});
t("CXP-43 unreported settings => UNVERIFIED_CONFIG, approval and auto follow-up blocked", () => {
  const { cls } = runMock("no_config");
  assert.equal(cls.outcome, "UNVERIFIED_CONFIG"); assert.equal(cls.config.status, "UNKNOWN");
  assert.equal(cls.approvalBlocked, true); assert.equal(cls.autoFollowUpAllowed, false);
  assert.equal(cls.autoRetry, false);
  assert.ok(cls.reasons.some(r => r.includes("UNKNOWN")));
});
t("CXP-43b MATCH => SUCCESS allows follow-up; non-success never allows it", () => {
  const ok = runMock("success").cls;
  assert.equal(ok.outcome, "SUCCESS"); assert.equal(ok.approvalBlocked, false); assert.equal(ok.autoFollowUpAllowed, true);
  const bad = runMock("success", { model: "other-model" }).cls;
  assert.equal(bad.outcome, "FAILED"); assert.equal(bad.autoFollowUpAllowed, false);
  assert.equal(classifyCodexExecRun(null).autoFollowUpAllowed, false);
});
t("CXP-44 failure shapes", () => {
  assert.equal(runMock("turn_failed").cls.outcome, "FAILED");
  assert.equal(runMock("nonzero_exit").cls.outcome, "FAILED");
  assert.equal(runMock("cancelled").cls.outcome, "CANCELLED");
});
t("CXP-45 truncated / malformed / no terminal / error+complete => UNKNOWN, no auto retry", () => {
  for (const s of ["truncated", "malformed", "no_terminal", "error_and_complete"]) {
    const { cls } = runMock(s);
    assert.equal(cls.outcome, "UNKNOWN", s); assert.equal(cls.autoRetry, false, s);
  }
  assert.equal(runMock("truncated").cls.truncated, true);
});
t("CXP-46 classifier edge inputs never yield SUCCESS", () => {
  const ok = '{"type":"turn.completed"}\n';
  const req = { model: "m", effort: "high" };
  const rep = '{"type":"x","model":"m","reasoning_effort":"high"}\n' + ok;
  // requested 없이 완료만 있는 실행은 SUCCESS가 아니다.
  assert.equal(classifyCodexExecRun({ stdout: ok, exitCode: 0 }).outcome, "UNVERIFIED_CONFIG");
  assert.equal(classifyCodexExecRun({ stdout: ok, exitCode: null, requested: req }).outcome, "UNKNOWN");
  assert.equal(classifyCodexExecRun({ stdout: ok, exitCode: 0, timedOut: true, requested: req }).outcome, "UNKNOWN");
  assert.equal(classifyCodexExecRun({ stdout: ok, exitCode: 1, requested: req }).outcome, "FAILED");
  assert.equal(classifyCodexExecRun({ stdout: "", exitCode: 0, requested: req }).outcome, "UNKNOWN");
  assert.equal(classifyCodexExecRun({ stdout: ok + '{"type":"turn.failed"}\n', exitCode: 0, requested: req }).outcome, "FAILED");
  assert.equal(classifyCodexExecRun({ stdout: ok, exitCode: null, signal: "SIGINT", requested: req }).outcome, "CANCELLED");
  assert.equal(classifyCodexExecRun({ stdout: [rep.slice(0, 10), rep.slice(10)], exitCode: 0, requested: req }).outcome, "SUCCESS");
  assert.equal(classifyCodexExecRun(null).outcome, "UNKNOWN");
});
t("CXP-46b requested missing/partial => UNVERIFIED_CONFIG REQUESTED_CONFIG_MISSING, blocked", () => {
  const rep = '{"type":"x","model":"m","reasoning_effort":"high"}\n{"type":"turn.completed"}\n';
  for (const requested of [undefined, null, {}, { model: "m" }, { effort: "high" }, { model: "", effort: "high" }, "m"]) {
    const c = classifyCodexExecRun({ stdout: rep, exitCode: 0, requested });
    assert.equal(c.outcome, "UNVERIFIED_CONFIG", JSON.stringify(requested));
    assert.equal(c.unverifiedReason, "REQUESTED_CONFIG_MISSING");
    assert.equal(c.execution, "completed"); assert.equal(c.configVerification, "NOT_REQUESTED");
    assert.equal(c.approvalBlocked, true); assert.equal(c.autoFollowUpAllowed, false); assert.equal(c.autoRetry, false);
  }
  // 요청 누락이어도 실행 자체가 실패/불명이면 해당 outcome 유지(UNVERIFIED로 덮지 않음).
  assert.equal(classifyCodexExecRun({ stdout: rep, exitCode: 1 }).outcome, "FAILED");
  assert.equal(classifyCodexExecRun({ stdout: rep, exitCode: null }).outcome, "UNKNOWN");
});
t("CXP-46c execution / configVerification / outcome are separated", () => {
  const req = { model: "m", effort: "high" };
  const done = '{"type":"turn.completed"}\n';
  const cases = [
    [{ stdout: '{"type":"x","model":"m","reasoning_effort":"high"}\n' + done, exitCode: 0, requested: req }, "completed", "MATCH", "SUCCESS", null],
    [{ stdout: '{"type":"x","model":"z","reasoning_effort":"high"}\n' + done, exitCode: 0, requested: req }, "completed", "MISMATCH", "FAILED", null],
    [{ stdout: done, exitCode: 0, requested: req }, "completed", "UNKNOWN", "UNVERIFIED_CONFIG", "REPORTED_CONFIG_UNKNOWN"],
    [{ stdout: done, exitCode: 0 }, "completed", "NOT_REQUESTED", "UNVERIFIED_CONFIG", "REQUESTED_CONFIG_MISSING"],
    [{ stdout: done, exitCode: 2, requested: req }, "failed", "UNKNOWN", "FAILED", null],
    [{ stdout: done, exitCode: null, signal: "SIGINT", requested: req }, "cancelled", "UNKNOWN", "CANCELLED", null],
    [{ stdout: "", exitCode: 0, requested: req }, "unknown", "UNKNOWN", "UNKNOWN", null],
  ];
  for (const [run, ex, cv, out, why] of cases) {
    const c = classifyCodexExecRun(run);
    assert.deepEqual([c.execution, c.configVerification, c.outcome, c.unverifiedReason], [ex, cv, out, why], JSON.stringify(run));
    assert.equal(c.autoFollowUpAllowed, out === "SUCCESS"); assert.equal(c.approvalBlocked, out === "UNVERIFIED_CONFIG");
  }
});
t("CXP-46d assembler blocks missing model/effort at plan creation", () => {
  for (const k of ["model", "effort"]) {
    const rest = { ...base({}) };
    delete rest[k];
    const p = assembleCodexExecCommand(rest);
    assert.equal(p.ok, false); assert.equal(p.code, "PLAN_INVALID");
    assert.ok(p.reasons.some(r => r.startsWith(k + " required")));
  }
});
t("CXP-47 real-fs resolver rejects non-executable file (Mock acceptance covered by runMock)", () => {
  const plain = path.join(tmp, "codex");
  fs.writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
  if (process.platform !== "win32") {
    assert.equal(resolveCodexExecutable({ fs, explicitPath: plain }).ok, false);
    assert.equal(resolveCodexExecutable({ fs, env: { PATH: tmp + path.delimiter + path.dirname(MOCK) } }).ok, false); // 'codex'라는 이름 없음/비실행
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log("codex-exec-plan fixtures: " + n + "/" + n + " passed");
