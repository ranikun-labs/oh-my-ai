#!/usr/bin/env node
// 파일럿 dry-run 점검: skills/<id> 를 skills/<group>/<id> 로 옮겼다고 가정하고 모든 게이트를 임시 복사본에서 돌린다.
// 실제 레포 트리는 읽기만 하고 아무것도 쓰지 않는다. 실제 Skill 이동은 하지 않는다.
//
//   node scripts/skill-pilot-check.mjs <id> <group> [--verbose] [--keep] [--fault-renderer=<skill-index|instructions>]
//
// 종료 코드: 0 PASS, 1 FAIL, 2 사용법 오류, 3 DEPENDENCY_MISSING(.github/ci/yaml 미설치 → npm ci --prefix .github/ci/yaml --ignore-scripts)
//
// 단계:
//   1 discovery-pre     복사본(이동 전) discovery --check
//   2 discovery-post    이동 후 discovery --check, --resolve 가 새 위치를 가리키는지
//   3 skill-index       render-skill-index 실행. exit 코드 확인. 실행 전 산출물을 지워 옛 파일로 통과하지 못하게 한다.
//                       항목 수 불변, 경로 외 필드 불변, 라우팅 Skill이면 index path 가 skills/<group>/<id>/SKILL.md 로 바뀌었는지 확인.
//   4 instructions      render-instructions.sh 실행. exit 코드 확인, 산출물 사전 삭제. 생성물 diff는 경로 치환만이고,
//                       기존 경로를 참조하던 파일은 반드시 바뀌어야 한다(MINE 줄 갱신 등).
//   5 exposure-links    노출 링크를 새 위치로 재지정 후 검사. 이동 전 노출 ID 기준선(--baseline 파일)의 모든 ID가 남아야 한다.
//   6 boundary          check-skill-source-boundary: 라우팅 Skill 수·인덱스 일치
//   7 install-fixture   임시 HOME에 설치 계약대로 링크를 만들고 setup.sh --doctor 의 종료 코드와 ready / stale-source 보고 확인
//
// --fault-renderer=<name> (테스트 전용): 복사본의 해당 생성기를 exit 9 스텁으로 바꿔 실패 전파를 검증한다. 실제 트리는 건드리지 않는다.
//
// 이 점검은 링크·인덱스·생성물 구조만 본다. Claude/Codex의 Native Skill 발견·호출은 증명하지 않는다.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESERVED_GROUPS, discoverSkills, resolveSkill } from "./lib/skill-discovery.mjs";
import { DEPENDENCY_MISSING_EXIT_CODE, missingYamlDependency } from "./lib/yaml-dependency.mjs";
import { EXPOSURE_DIRS, captureExposureBaseline, loadBaseline } from "./check-skill-exposure-links.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 생성물: render-instructions.sh 가 render-skill-index.mjs 도 다시 호출하므로 skill-index.json 도 함께 비교한다.
const GENERATED = ["skills/skill-index.json", "CLAUDE.md", "claude/CLAUDE.md", "AGENTS.md", "MINE.md"];
const FAULT_TARGETS = {
  "skill-index": path.join("scripts", "render-skill-index.mjs"),
  instructions: path.join("scripts", "render-instructions.sh"),
};

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const keep = args.includes("--keep");
const faultArg = args.find(arg => arg.startsWith("--fault-renderer="));
const fault = faultArg === undefined ? null : faultArg.slice("--fault-renderer=".length);
const positional = args.filter(arg => !arg.startsWith("--"));

function usage(message) {
  console.error(`${message}\nusage: node scripts/skill-pilot-check.mjs <id> <group> [--verbose] [--keep] [--fault-renderer=<skill-index|instructions>]`);
  process.exitCode = 2;
}

if (positional.length !== 2) {
  usage("expected exactly two arguments");
} else if (fault !== null && !Object.hasOwn(FAULT_TARGETS, fault)) {
  usage(`--fault-renderer must be one of: ${Object.keys(FAULT_TARGETS).join(", ")}`);
} else {
  main(positional[0], positional[1]);
}

function main(id, group) {
  // 고정 YAML 파서가 없으면 게이트 단계가 generic FAIL로 흩어지므로 먼저 멈춘다.
  const dependency = missingYamlDependency(repoRoot);
  if (dependency) {
    console.error(`skill-pilot-check: ${dependency}`);
    process.exitCode = DEPENDENCY_MISSING_EXIT_CODE;
    return;
  }
  if (!RESERVED_GROUPS.includes(group)) {
    return usage(`group must be one of: ${RESERVED_GROUPS.join(", ")}`);
  }
  const realDiscovery = discoverSkills(repoRoot);
  const real = realDiscovery.skills.filter(skill => skill.name === id);
  if (real.length !== 1 || real[0].relPath !== `skills/${id}/SKILL.md`) {
    return usage(`"${id}" must be exactly one flat Skill at skills/${id}/ in the real tree (found ${real.map(s => s.relPath).join(", ") || "none"})`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `skill-pilot-${id}-`));
  const results = [];
  const record = (step, ok, detail) => results.push({ step, ok, detail });
  try {
    const base = path.join(work, "base");
    const moved = path.join(work, "moved");
    copyTree(repoRoot, base);
    copyTree(repoRoot, moved);

    // 1. 이동 전 발견
    const pre = run(base, [path.join("scripts", "lib", "skill-discovery.mjs"), "--check", "--root", base]);
    record("discovery-pre", pre.status === 0, firstLine(pre));

    // 이동: skills/<id> -> skills/<group>/<id> (복사본에서만)
    fs.mkdirSync(path.join(moved, "skills", group), { recursive: true });
    fs.renameSync(path.join(moved, "skills", id), path.join(moved, "skills", group, id));
    const newSource = path.join(moved, "skills", group, id);

    // 2. 이동 후 발견 + resolve
    const post = run(moved, [path.join("scripts", "lib", "skill-discovery.mjs"), "--check", "--root", moved]);
    const resolved = resolveSkill(moved, id);
    const resolvesToNew = resolved.ok && resolved.skill.dir === fs.realpathSync(newSource);
    const countSame = discoverSkills(base).skills.length === discoverSkills(moved).skills.length;
    record("discovery-post", post.status === 0 && resolvesToNew && countSame,
      `${firstLine(post)}; resolve=${resolved.ok ? path.relative(moved, resolved.skill.dir) : resolved.errors.join("; ")}`);

    if (fault !== null) {
      // 테스트 전용 주입: 복사본의 생성기를 exit 9 스텁으로 바꾼다.
      fs.writeFileSync(path.join(moved, FAULT_TARGETS[fault]), fault === "instructions" ? "exit 9\n" : "process.exit(9);\n");
    }

    // 3. skill-index: 실행 실패는 step FAIL(exit 코드 포함). 항목 수·경로 외 필드 불변, 라우팅 Skill은 경로 변경이 실제로 나타나야 한다.
    const indexBase = generate(base, [path.join("scripts", "render-skill-index.mjs"), "--root", base], ["skills/skill-index.json"]);
    const indexMoved = generate(moved, [path.join("scripts", "render-skill-index.mjs"), "--root", moved], ["skills/skill-index.json"]);
    const indexError = renderErrors([["base", indexBase], ["moved", indexMoved]]);
    if (indexError) {
      record("skill-index", false, `render-skill-index failed: ${indexError}`);
    } else {
      const baseIndex = readJson(path.join(base, "skills", "skill-index.json"));
      const movedIndex = readJson(path.join(moved, "skills", "skill-index.json"));
      const baseEntry = baseIndex.skills.find(entry => entry.name === id);
      const movedEntry = movedIndex.skills.find(entry => entry.name === id);
      const pathOk = baseEntry === undefined
        ? movedEntry === undefined
        : baseEntry.path === `skills/${id}/SKILL.md` && movedEntry?.path === `skills/${group}/${id}/SKILL.md`;
      const countOk = baseIndex.skills.length === movedIndex.skills.length;
      const fieldsOk = normalizePaths(JSON.stringify(movedIndex), id, group) === JSON.stringify(baseIndex);
      const pathNote = baseEntry ? `path ${baseEntry.path} -> ${movedEntry?.path ?? "MISSING"}` : "not routed (no index entry on either side)";
      record("skill-index", countOk && fieldsOk && pathOk,
        `entries ${baseIndex.skills.length} -> ${movedIndex.skills.length}; ${pathNote}; non-path fields ${fieldsOk ? "identical" : "DIFFER"}`);
    }

    // 4. render-instructions: 실행 실패는 step FAIL. 생성물 diff는 경로 치환만이며, 옛 경로를 참조하던 파일은 반드시 바뀌어야 한다.
    const instrBase = generate(base, ["scripts/render-instructions.sh"], GENERATED, { shell: true });
    const instrMoved = generate(moved, ["scripts/render-instructions.sh"], GENERATED, { shell: true });
    const instrError = renderErrors([["base", instrBase], ["moved", instrMoved]]);
    if (instrError) {
      record("instructions", false, `render-instructions failed: ${instrError}`);
    } else {
      const oldPathRef = new RegExp(`skills/${escapeRegExp(id)}(?![A-Za-z0-9_-])`);
      const changed = [];
      const problems = [];
      for (const file of GENERATED) {
        const b = fs.readFileSync(path.join(base, file), "utf8").split("\n");
        const m = fs.readFileSync(path.join(moved, file), "utf8").split("\n");
        if (b.length !== m.length) {
          problems.push(`${file}: line count ${b.length} -> ${m.length}`);
          continue;
        }
        let fileChanged = 0;
        for (let i = 0; i < b.length; i += 1) {
          if (b[i] === m[i]) continue;
          fileChanged += 1;
          changed.push(`${file}:${i + 1}`);
          if (!m[i].includes(`skills/${group}/${id}`) || normalizePaths(m[i], id, group) !== b[i]) {
            problems.push(`${file}:${i + 1} is not a pure path rewrite`);
          }
        }
        if (oldPathRef.test(b.join("\n")) && fileChanged === 0) {
          problems.push(`${file}: references skills/${id} but no path changed`);
        }
      }
      const instructionsOk = problems.length === 0;
      record("instructions", instructionsOk,
        `${changed.length} changed line(s); ${instructionsOk ? "all expected path rewrites" : problems.join("; ")}`);
    }

    // 5. 노출 링크: 새 위치로 재지정 (복사본에서만). 링크가 없던 Skill이면 검사용 링크를 복사본에만 만든다.
    // 기준선 = 커밋된 HEAD의 노출 ID 전체(작업 트리를 찍은 복사본이 아님). 작업 트리에서 이미 사라진 링크도 여기서 잡힌다.
    // git 기준선을 얻을 수 없으면(.git 없는 트리 등) 파일시스템 목록으로 대체하고 그 사실을 결과에 표기한다.
    // 주의: 이 시점의 복사본은 재지정 전 상태여야 하며, 아래 루프가 이 목록을 다시 쓰지 않는다.
    let baseline;
    let baselineSource = "HEAD";
    try {
      baseline = loadBaseline("HEAD", repoRoot);
    } catch {
      baseline = captureExposureBaseline(repoRoot);
      baselineSource = "filesystem (no git HEAD)";
    }
    const baselineFile = path.join(work, "exposure-baseline.txt");
    fs.writeFileSync(baselineFile, `${baseline.join("\n")}\n`);
    const linkRows = [];
    for (const rel of EXPOSURE_DIRS) {
      const linkPath = path.join(moved, rel, id);
      const hadLink = isSymlink(linkPath);
      const before = hadLink ? run(moved, ["scripts/check-skill-exposure-links.mjs", "--root", moved]) : null;
      if (hadLink) fs.unlinkSync(linkPath);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(linkPath), newSource), linkPath);
      linkRows.push(`${rel}/${id}: ${hadLink ? "re-pointed" : "synthetic link in copy"}${before && before.status !== 0 ? " (old link failed before re-point)" : ""}`);
    }
    const exposure = run(moved, ["scripts/check-skill-exposure-links.mjs", "--root", moved, "--baseline", baselineFile]);
    record("exposure-links", exposure.status === 0,
      `${linkRows.join("; ")}; baseline ${baseline.length} id(s) from ${baselineSource} | ${firstLine(exposure)}`);

    // 6. 경계 게이트
    const boundary = run(moved, [path.join("scripts", "check-skill-source-boundary.mjs"), "--root", moved]);
    record("boundary", boundary.status === 0, firstLine(boundary));

    // 7. 설치 픽스처 (임시 HOME)
    const home = path.join(work, "home");
    const codexRoot = path.join(home, ".agents", "skills");
    const claudeRoot = path.join(home, ".claude", "skills");
    fs.mkdirSync(codexRoot, { recursive: true });
    fs.mkdirSync(claudeRoot, { recursive: true });
    // 설치기 계약(dev_main_flow_install_one): 발견된 Source 디렉터리로 절대 심볼릭 링크를 만든다.
    fs.symlinkSync(fs.realpathSync(newSource), path.join(codexRoot, id));
    // 옛 flat 경로를 가리키는 링크는 자동 재연결 없이 stale-source로 보고돼야 한다.
    fs.symlinkSync(path.join(moved, "skills", id), path.join(claudeRoot, id));
    const doctor = spawnSync("bash", [path.join(moved, "setup.sh"), "--doctor"], {
      cwd: moved,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_DIR: path.join(home, ".claude"),
        CODEX_DIR: path.join(home, ".codex"),
        AGENT_DIR: path.join(home, ".agents"),
        LOCAL_BIN: path.join(home, ".local", "bin"),
      },
    });
    const out = `${doctor.stdout}${doctor.stderr}`;
    const claudeSection = out.slice(out.indexOf("Claude skill links"), out.indexOf("Codex skill links"));
    const codexSection = out.slice(out.indexOf("Codex skill links"));
    const installOk = doctor.status === 0 && codexSection.includes(`  ${id}: ready`) && claudeSection.includes(`  ${id}: stale-source`)
      && fs.realpathSync(path.join(codexRoot, id)) === fs.realpathSync(newSource);
    record("install-fixture", installOk,
      `setup.sh --doctor exit ${doctor.status}; codex=${matchState(codexSection, id)}; claude=${matchState(claudeSection, id)} (temp HOME)`);

    if (verbose) {
      for (const [label, r] of [["discovery-pre", pre], ["discovery-post", post], ["exposure-links", exposure], ["boundary", boundary]]) {
        console.log(`--- ${label} output ---\n${r.stdout}${r.stderr}`);
      }
      console.log(`--- setup.sh --doctor (temp HOME) ---\n${out}`);
    }
  } finally {
    if (keep) console.log(`kept temp copy: ${work}`);
    else fs.rmSync(work, { recursive: true, force: true });
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`skill-pilot-check: id=${id} group=${group} (dry-run; real tree untouched${fault ? `; fault-renderer=${fault}` : ""})`);
  console.log("STEP              RESULT  DETAIL");
  for (const r of results) console.log(`${r.step.padEnd(18)}${(r.ok ? "PASS" : "FAIL").padEnd(8)}${r.detail}`);
  console.log(`RESULT: ${passed === results.length ? "PASS" : "FAIL"} (${passed}/${results.length})`);
  if (passed !== results.length) process.exitCode = 1;
}

// 산출물을 먼저 지운 뒤 생성한다. 실행이 실패하거나 파일이 다시 쓰이지 않으면 오류다(옛 파일로 통과 금지).
function generate(tree, argv, outputs, options = {}) {
  for (const file of outputs) fs.rmSync(path.join(tree, file), { force: true });
  const result = run(tree, argv, options);
  if (result.status !== 0) return { error: firstLine(result) };
  const missing = outputs.filter(file => !fs.existsSync(path.join(tree, file)));
  return { error: missing.length > 0 ? `exit 0 but did not write ${missing.join(", ")}` : null };
}

function renderErrors(pairs) {
  const errors = pairs.filter(([, gen]) => gen.error !== null).map(([label, gen]) => `${label} ${gen.error}`);
  return errors.length > 0 ? errors.join("; ") : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    verbatimSymlinks: true,
    filter: file => path.relative(src, file).split(path.sep)[0] !== ".git",
  });
}

function run(cwd, argv, options = {}) {
  const result = options.shell
    ? spawnSync("sh", argv, { cwd, encoding: "utf8" })
    : spawnSync(process.execPath, argv, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function firstLine(result) {
  const text = `${result.stdout}${result.stderr}`.trim().split("\n").find(line => line.trim() !== "") ?? "(no output)";
  return result.status === 0 ? text : `exit ${result.status}: ${text}`;
}

function normalizePaths(text, id, group) {
  return text.replace(new RegExp(`skills/${group}/${escapeRegExp(id)}(?![A-Za-z0-9_-])`, "g"), `skills/${id}`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function matchState(section, id) {
  const line = section.split("\n").find(l => l.startsWith(`  ${id}: `));
  return line ? line.slice(`  ${id}: `.length).trim() : "not reported";
}
