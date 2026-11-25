/**
 * RPL-118 PR-1: Codex `exec` 실행 계획 순수 모듈.
 *
 * 이 모듈은 프로세스를 띄우지 않는다. (1) argv 조립, (2) 신뢰 가능한 실행 파일 해석,
 * (3) 요청/실제 설정 비교, (4) JSONL 스트림 해석과 종료 결과 분류만 한다.
 * 실제 Codex CLI 호출·Writer Lease·재시도는 이 모듈의 범위 밖이다.
 *
 * UNVERIFIED: Codex CLI 플래그(`-c key=value` override, `exec resume`)와 JSONL 이벤트
 * 필드명은 실제 CLI로 검증하지 않았다. 아래 "이벤트 계약"은 Mock CLI 기준 가정이다.
 */
import nodePath from "node:path";

const isRecord = v => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (code, ...reasons) => ({ ok: false, code, reasons });

/* ------------------------------------------------------------------ */
/* 1~2. 정책 / argv 조립                                               */
/* ------------------------------------------------------------------ */

/**
 * RPL-116 `agent-manifest-guard.mjs`의 REASONING allowlist 사본(해당 상수는 export되지 않음).
 * 사본이 어긋나지 않도록 테스트가 실제 guard로 동등성을 검증한다. 호출자가 다른 목록을
 * policy.efforts로 넘길 수 있다. 기본값으로 자동 적용되지는 않는다(필수 입력).
 */
export const RPL116_REASONING_ALLOWLIST = Object.freeze(["low", "medium", "high", "max"]);
export const SANDBOX_MODES = Object.freeze(["read-only", "workspace-write"]); // danger-full-access는 PR-1에서 거부
export const APPROVAL_MODES = Object.freeze(["never", "on-request", "on-failure", "untrusted"]);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/; // 선행 '-' 금지, 따옴표/공백 금지(옵션·TOML 주입 차단)
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const MAX_PROMPT_BYTES = 1024 * 1024;
const REQUEST_KEYS = new Set(["mode", "executable", "sessionId", "model", "effort", "cwd", "sandbox", "approval", "prompt", "policy", "platform", "options"]);
const OPTION_KEYS = new Set(["skipGitRepoCheck"]);
const POLICY_KEYS = new Set(["models", "efforts"]);

export function isAbsolutePathFor(platform, p) {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) return false;
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p); // 드라이브 없는 `\foo` 거부
  return p.startsWith("/");
}

function validatePolicy(policy) {
  if (!isRecord(policy)) return ["policy({models,efforts}) required: no defaults"];
  const errors = [];
  for (const k of Object.keys(policy)) if (!POLICY_KEYS.has(k)) errors.push("unknown policy key: " + k);
  for (const k of POLICY_KEYS) {
    const list = policy[k];
    if (!Array.isArray(list) || list.length === 0 || !list.every(x => typeof x === "string" && TOKEN.test(x))) {
      errors.push("policy." + k + " must be a non-empty allow-list of safe tokens");
    }
  }
  return errors;
}

/**
 * 새 실행/재개 명령을 argv 배열로 조립한다. 쉘 문자열은 만들지 않는다.
 * 프롬프트는 stdin으로만 전달한다(argv 끝 `-`). 알 수 없는 키는 거부한다.
 * @returns {{ok:true, executable, argv, stdin, spawnCwd, requested, mode}|{ok:false, code, reasons}}
 */
export function assembleCodexExecCommand(request) {
  if (!isRecord(request)) return fail("PLAN_INVALID", "request must be an object");
  const errors = [];
  for (const k of Object.keys(request)) if (!REQUEST_KEYS.has(k)) errors.push("unknown option: " + k);
  const platform = request.platform === undefined ? process.platform : request.platform;
  if (platform !== "win32" && platform !== "posix" && platform !== "linux" && platform !== "darwin") errors.push("platform invalid");
  const mode = request.mode;
  if (mode !== "new" && mode !== "resume") errors.push("mode must be new|resume");
  if (!isAbsolutePathFor(platform, request.executable)) errors.push("executable must be an absolute path (use resolveCodexExecutable)");
  if (!isAbsolutePathFor(platform, request.cwd)) errors.push("cwd must be an absolute path");
  errors.push(...validatePolicy(request.policy));
  const policy = isRecord(request.policy) ? request.policy : {};
  if (typeof request.model !== "string" || !TOKEN.test(request.model)) errors.push("model required (no default)");
  else if (Array.isArray(policy.models) && !policy.models.includes(request.model)) errors.push("model not in policy allow-list");
  if (typeof request.effort !== "string" || !TOKEN.test(request.effort)) errors.push("effort required (no default)");
  else if (Array.isArray(policy.efforts) && !policy.efforts.includes(request.effort)) errors.push("effort not in policy allow-list");
  if (!SANDBOX_MODES.includes(request.sandbox)) errors.push("sandbox must be explicit: " + SANDBOX_MODES.join("|"));
  if (!APPROVAL_MODES.includes(request.approval)) errors.push("approval must be explicit: " + APPROVAL_MODES.join("|"));
  if (typeof request.prompt !== "string" || request.prompt.trim() === "" || request.prompt.includes("\0")
      || Buffer.byteLength(request.prompt, "utf8") > MAX_PROMPT_BYTES) errors.push("prompt must be a non-empty string without NUL, <=1MiB");
  if (mode === "resume") {
    if (typeof request.sessionId !== "string" || !SESSION_ID.test(request.sessionId)) errors.push("resume requires a safe sessionId");
  } else if (request.sessionId !== undefined) errors.push("sessionId is only valid for resume");
  let skipGit = false;
  if (request.options !== undefined) {
    if (!isRecord(request.options)) errors.push("options must be an object");
    else {
      for (const k of Object.keys(request.options)) if (!OPTION_KEYS.has(k)) errors.push("unknown option: options." + k);
      if (request.options.skipGitRepoCheck !== undefined && typeof request.options.skipGitRepoCheck !== "boolean") errors.push("options.skipGitRepoCheck must be boolean");
      skipGit = request.options.skipGitRepoCheck === true;
    }
  }
  if (errors.length) return fail("PLAN_INVALID", ...errors);

  // UNVERIFIED: `-c key="value"` 오버라이드와 `exec resume <id>` 형태. 모든 설정을 -c로 통일해
  // new/resume의 플래그 지원 차이에 의존하지 않는다. cwd는 argv가 아니라 spawn cwd로 전달한다.
  const q = v => JSON.stringify(v);
  const argv = ["exec"];
  if (mode === "resume") argv.push("resume", request.sessionId);
  argv.push("--json");
  argv.push("-c", "model=" + q(request.model));
  argv.push("-c", "model_reasoning_effort=" + q(request.effort));
  argv.push("-c", "sandbox_mode=" + q(request.sandbox));
  argv.push("-c", "approval_policy=" + q(request.approval));
  if (skipGit) argv.push("--skip-git-repo-check");
  argv.push("-"); // 프롬프트는 stdin
  return {
    ok: true, mode, executable: request.executable, argv, stdin: request.prompt, spawnCwd: request.cwd,
    requested: { model: request.model, effort: request.effort, sandbox: request.sandbox, approval: request.approval },
  };
}

/* ------------------------------------------------------------------ */
/* 3. 신뢰 가능한 실행 파일 해석                                        */
/* ------------------------------------------------------------------ */

const WIN_EXTS = Object.freeze([".exe", ".cmd"]);

function pathModFor(platform) { return platform === "win32" ? nodePath.win32 : nodePath.posix; }
function norm(platform, p) {
  const n = pathModFor(platform).normalize(p);
  return platform === "win32" ? n.toLowerCase() : n;
}
function isInside(platform, child, parent) {
  const c = norm(platform, child), p = norm(platform, parent).replace(/[\\/]+$/, "");
  const sep = platform === "win32" ? "\\" : "/";
  return c === p || c.startsWith(p + sep);
}
function envGet(platform, env, key) {
  if (!isRecord(env)) return undefined;
  if (platform !== "win32") return env[key];
  const hit = Object.keys(env).find(k => k.toUpperCase() === key);
  return hit === undefined ? undefined : env[hit];
}

/**
 * `codex` 실행 파일을 explicitPath 또는 PATH에서 해석한다. 순수 함수(fs/env 주입).
 * - 절대 경로, 일반 파일, 실행 가능만 허용. 상대/빈 PATH 항목과 cwd(작업공간) 내부 후보는 거부.
 * - win32: PATHEXT와 {.exe,.cmd}의 교집합만 후보. `.cmd`는 shell:false에서 직접 spawn 불가
 *   (Node EINVAL)하므로 allowCmdShim=true일 때만 허용하며 결과에 cmdShim:true를 표시한다.
 * @param {{platform?:string, env?:object, fs:{statSync:Function,accessSync?:Function}, cwd?:string, explicitPath?:string, allowCmdShim?:boolean, name?:string}} input
 */
export function resolveCodexExecutable(input) {
  if (!isRecord(input) || !isRecord(input.fs) || typeof input.fs.statSync !== "function") return fail("RESOLVE_INVALID", "fs.statSync required");
  const platform = input.platform === undefined ? process.platform : input.platform;
  const win = platform === "win32";
  const pm = pathModFor(platform);
  const name = input.name === undefined ? "codex" : input.name;
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) return fail("RESOLVE_INVALID", "name invalid");
  if (input.cwd !== undefined && !isAbsolutePathFor(platform, input.cwd)) return fail("RESOLVE_INVALID", "cwd must be absolute");
  const skipped = [];

  const check = (candidate, source) => {
    const ext = win ? pm.extname(candidate).toLowerCase() : "";
    if (win && !WIN_EXTS.includes(ext)) { skipped.push({ path: candidate, reason: "EXT_UNSUPPORTED" }); return null; }
    if (input.cwd !== undefined && isInside(platform, candidate, input.cwd)) { skipped.push({ path: candidate, reason: "WORKSPACE_LOCAL" }); return null; }
    let st;
    try { st = input.fs.statSync(candidate); } catch { skipped.push({ path: candidate, reason: "NOT_FOUND" }); return null; }
    if (!st || typeof st.isFile !== "function" || !st.isFile()) { skipped.push({ path: candidate, reason: "NOT_REGULAR_FILE" }); return null; }
    if (!win) {
      try { input.fs.accessSync(candidate, 1 /* X_OK */); } catch { skipped.push({ path: candidate, reason: "NOT_EXECUTABLE" }); return null; }
    }
    if (win && ext === ".cmd" && input.allowCmdShim !== true) { skipped.push({ path: candidate, reason: "CMD_SHIM_UNSUPPORTED" }); return null; }
    return { ok: true, path: candidate, source, ext, cmdShim: win && ext === ".cmd", skipped };
  };

  if (input.explicitPath !== undefined) {
    if (!isAbsolutePathFor(platform, input.explicitPath)) return fail("EXPLICIT_PATH_INVALID", "explicitPath must be absolute");
    const hit = check(pm.normalize(input.explicitPath), "explicit");
    return hit ?? { ok: false, code: "EXPLICIT_PATH_REJECTED", reasons: [skipped[skipped.length - 1].reason], skipped };
  }

  const rawPath = envGet(platform, input.env, "PATH");
  if (typeof rawPath !== "string" || rawPath === "") return { ok: false, code: "CODEX_NOT_FOUND", reasons: ["PATH empty"], skipped };
  let exts = [""];
  if (win) {
    const pathext = envGet(platform, input.env, "PATHEXT");
    const declared = typeof pathext === "string" && pathext !== "" ? pathext.split(";").map(s => s.trim().toLowerCase()) : WIN_EXTS;
    exts = declared.filter(e => WIN_EXTS.includes(e));
    if (exts.length === 0) return { ok: false, code: "CODEX_NOT_FOUND", reasons: ["PATHEXT excludes .exe/.cmd"], skipped };
  }
  for (let entry of rawPath.split(win ? ";" : ":")) {
    if (win) entry = entry.trim().replace(/^"(.*)"$/, "$1");
    if (entry === "") { skipped.push({ path: "", reason: "EMPTY_PATH_ENTRY" }); continue; }
    if (!isAbsolutePathFor(platform, entry)) { skipped.push({ path: entry, reason: "RELATIVE_PATH_ENTRY" }); continue; }
    for (const ext of exts) {
      const hit = check(pm.join(entry, name + ext), "PATH");
      if (hit) return hit;
    }
  }
  return { ok: false, code: "CODEX_NOT_FOUND", reasons: ["no trusted candidate on PATH"], skipped };
}

/* ------------------------------------------------------------------ */
/* 5. JSONL 스트림 파서 (부분 라인 허용)                                */
/* ------------------------------------------------------------------ */

const MAX_LINE_CHARS = 1024 * 1024;

/** chunk 경계와 무관하게 줄 단위로 해석한다. finish() 시 개행 없는 잔여는 truncated로 표시. */
export function createJsonlParser() {
  let buf = "";
  let overflow = false;
  const events = [];
  const malformed = [];
  const take = line => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.trim() === "") return;
    try {
      const v = JSON.parse(text);
      if (isRecord(v) && typeof v.type === "string") events.push(v);
      else malformed.push({ reason: "NOT_EVENT_OBJECT", line: text.slice(0, 200) });
    } catch { malformed.push({ reason: "JSON_PARSE", line: text.slice(0, 200) }); }
  };
  return {
    feed(chunk) {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.length > MAX_LINE_CHARS) { overflow = true; malformed.push({ reason: "LINE_TOO_LONG", line: "" }); } else take(line);
      }
      if (buf.length > MAX_LINE_CHARS) { overflow = true; malformed.push({ reason: "LINE_TOO_LONG", line: "" }); buf = ""; }
    },
    finish() {
      const truncated = buf.trim() !== "";
      if (truncated) { malformed.push({ reason: "TRUNCATED_FINAL_LINE", line: buf.slice(0, 200) }); }
      buf = "";
      return { events: events.slice(), malformed: malformed.slice(), truncated, overflow };
    },
  };
}

export function parseJsonl(text) {
  const p = createJsonlParser();
  p.feed(text);
  return p.finish();
}

/* ------------------------------------------------------------------ */
/* 4. 요청 vs 실제 설정 비교                                            */
/* ------------------------------------------------------------------ */

/**
 * UNVERIFIED 이벤트 계약(Mock 기준): 어떤 이벤트든 `model` / `reasoning_effort` 문자열 필드를
 * 보고하면 CLI가 보고한 실제 설정으로 본다. (실제 Codex가 이를 내보내는지는 미검증.)
 * 필드가 하나라도 서로 다른 값으로 보고되면 MISMATCH. 보고가 없으면 UNKNOWN.
 */
export function compareRequestedVsReported(requested, events) {
  const collect = field => [...new Set(events.filter(e => typeof e[field] === "string" && e[field] !== "").map(e => e[field]))];
  const one = (want, field) => {
    const seen = collect(field);
    if (seen.length === 0) return { status: "UNKNOWN", requested: want, reported: [] };
    return { status: seen.length === 1 && seen[0] === want ? "MATCH" : "MISMATCH", requested: want, reported: seen };
  };
  const model = one(requested.model, "model");
  const effort = one(requested.effort, "reasoning_effort");
  const status = model.status === "MISMATCH" || effort.status === "MISMATCH" ? "MISMATCH"
    : model.status === "MATCH" && effort.status === "MATCH" ? "MATCH" : "UNKNOWN";
  return { status, model, effort };
}

/* ------------------------------------------------------------------ */
/* 5. 종료 결과 분류                                                    */
/* ------------------------------------------------------------------ */

const T_OK = new Set(["turn.completed"]);
const T_FAIL = new Set(["turn.failed"]);
const T_CANCEL = new Set(["turn.cancelled", "turn.aborted"]);

/**
 * 종료 결과를 SUCCESS / UNVERIFIED_CONFIG / FAILED / CANCELLED / UNKNOWN으로 분류한다.
 * UNVERIFIED_CONFIG: 정상 종료(exit 0 + 완료 이벤트)지만 요청/보고 설정 비교가 UNKNOWN. 승인 불가(approvalBlocked)·자동 후속 실행 금지.
 * SUCCESS 조건: exit 0 + 신호/타임아웃 없음 + 파싱 오류·절단 없음 + 완료 이벤트 존재 + 실패/취소 이벤트 없음
 *   + 요청/보고 설정 MISMATCH 아님. MISMATCH면 SUCCESS 금지(FAILED로 격상).
 * 자동 재시도는 어떤 결과에서도 허용하지 않는다(autoRetry:false). 특히 UNKNOWN은 부작용 여부를
 * 알 수 없으므로 사람/상위 정책의 판단 전까지 재실행 금지.
 * @param {{stdout:string|string[], exitCode:number|null, signal?:string|null, timedOut?:boolean, requested?:object}} run
 */
export function classifyCodexExecRun(run) {
  if (!isRecord(run)) return { outcome: "UNKNOWN", reasons: ["run must be an object"], autoRetry: false, approvalBlocked: false, autoFollowUpAllowed: false };
  const text = Array.isArray(run.stdout) ? run.stdout.join("") : run.stdout;
  const parsed = parseJsonl(typeof text === "string" ? text : "");
  const types = parsed.events.map(e => e.type);
  const has = set => types.some(t => set.has(t));
  const sessionEvt = parsed.events.find(e => typeof e.thread_id === "string" && e.thread_id !== "");
  const config = run.requested ? compareRequestedVsReported(run.requested, parsed.events) : null;
  const base = {
    sessionId: sessionEvt ? sessionEvt.thread_id : null,
    eventCount: parsed.events.length,
    malformedCount: parsed.malformed.length,
    truncated: parsed.truncated,
    config,
    autoRetry: false,
  };
  const reasons = [];
  let outcome;
  if (has(T_FAIL)) { outcome = "FAILED"; reasons.push("terminal failure event"); }
  else if (has(T_CANCEL) || run.signal === "SIGINT" || (run.signal === "SIGTERM" && run.timedOut !== true)) {
    outcome = "CANCELLED"; reasons.push("cancel event or signal");
  } else if (run.timedOut === true) { outcome = "UNKNOWN"; reasons.push("timed out; side effects unknown"); }
  else if (typeof run.exitCode === "number" && run.exitCode !== 0) { outcome = "FAILED"; reasons.push("non-zero exit " + run.exitCode); }
  else if (run.exitCode !== 0) { outcome = "UNKNOWN"; reasons.push("exit status unavailable"); }
  else if (parsed.malformed.length > 0 || parsed.truncated) { outcome = "UNKNOWN"; reasons.push("malformed or truncated stream"); }
  else if (!has(T_OK)) { outcome = "UNKNOWN"; reasons.push("terminal event missing"); }
  else if (types.includes("error")) { outcome = "UNKNOWN"; reasons.push("error event alongside completion"); }
  else { outcome = "SUCCESS"; }
  if (outcome === "SUCCESS" && config && config.status === "MISMATCH") {
    outcome = "FAILED"; reasons.push("requested/reported model or effort MISMATCH; not accepted");
  } else if (outcome === "SUCCESS" && config && config.status === "UNKNOWN") {
    // 설정 검증 불가 → 승인 근거로 못 쓰므로 SUCCESS가 아닌 별도 outcome으로 분리한다.
    outcome = "UNVERIFIED_CONFIG"; reasons.push("reported model/effort UNKNOWN; settings not verified");
  }
  // 자동 후속 실행은 SUCCESS(검증 통과 또는 비교 미요청)일 때만 허용. 승인 차단은 UNVERIFIED_CONFIG 전용.
  return {
    ...base, outcome, reasons,
    approvalBlocked: outcome === "UNVERIFIED_CONFIG",
    autoFollowUpAllowed: outcome === "SUCCESS",
  };
}
