#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(scriptDir);
const harnessEvent = path.join(scriptDir, "harness-event.mjs");
const fixturePath = path.join(
  repo,
  "fixtures",
  "harness-event",
  "skill-name-validation.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "oh-my-ai-harness-event-fixtures."),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function emit(skill, stateHome) {
  return spawnSync(
    process.execPath,
    [
      harnessEvent,
      "emit",
      "skill-start",
      "--skill",
      skill,
      "--runtime",
      "codex",
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, XDG_STATE_HOME: stateHome },
    },
  );
}

try {
  const stateHome = path.join(tempRoot, "state");
  const accepted = [
    ...fixture.valid,
    ...fixture.continuousSeparators.values,
  ];

  for (const skill of accepted) {
    const result = emit(skill, stateHome);
    assert(
      result.status === 0,
      `expected valid skill name '${skill}', got: ${result.stderr.trim()}`,
    );
  }

  for (const { label, value } of fixture.invalid) {
    const result = emit(value, stateHome);
    assert(result.status === 1, `expected ${label} to be rejected`);
    assert(
      result.stderr.includes("invalid --skill"),
      `expected validation error for ${label}`,
    );
  }

  const logPath = path.join(stateHome, "oh-my-ai", "harness-usage.log");
  const records = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(records.length === accepted.length, "unexpected telemetry record count");
  assert(
    records.every((record, index) => record.skill === accepted[index]),
    "telemetry did not preserve an accepted skill name",
  );

  const reportState = path.join(tempRoot, "report-state");
  const reportLog = path.join(reportState, "oh-my-ai", "harness-usage.log");
  fs.mkdirSync(path.dirname(reportLog), { recursive: true });
  const now = Date.UTC(2026, 10, 20, 3);
  const day = 86400000;
  const reportRecord = (skill, timestamp, repo = "no-git") => ({
    v: 1, event: "skill_start", timestamp, skill, repo, runtime: "codex",
  });
  const recent = new Date(now - day / 2).toISOString();
  const previousYear = new Date(now).getUTCFullYear() - 1;
  const invalidCalendarDate = `${previousYear}-02-30T00:00:00.000Z`;
  fs.writeFileSync(reportLog, [
    reportRecord("recent", recent),
    reportRecord("old", new Date(now - 2 * day).toISOString()),
    reportRecord("invalid-date", "bad-date"),
    reportRecord("invalid-calendar-date", invalidCalendarDate),
    reportRecord("future", new Date(now + day).toISOString()),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");

  function report(...args) {
    const clock = `data:text/javascript,Date.now%20%3D%20()%20%3D%3E%20${now}`;
    return spawnSync(process.execPath, ["--import", clock, harnessEvent, "report", ...args], {
      cwd: tempRoot,
      encoding: "utf8",
      env: { ...process.env, XDG_STATE_HOME: reportState },
    });
  }

  const recentReport = "count\trepo\truntime\tskill\n1\tno-git\tcodex\trecent\n";
  for (const args of [
    ["--since-days", "1"],
    ["--since-days", "0.75"],
    ["--repo", "no-git", "--since-days", "1"],
  ]) {
    const result = report(...args);
    assert(result.status === 0 && result.stdout === recentReport,
      `expected recent report for ${args.join(" ")}: ${result.stderr}${result.stdout}`);
  }

  const wideReport = report("--since-days", "730");
  assert(wideReport.status === 0 && !wideReport.stdout.includes("invalid-calendar-date"),
    `expected invalid calendar date to be excluded: ${wideReport.stderr}${wideReport.stdout}`);
  fs.appendFileSync(reportLog,
    "null\n{broken\n" + JSON.stringify(reportRecord("other-repo-recent", recent, "other-repo")) + "\n");
  const allRecent = report("--all", "--since-days", "1");
  assert(allRecent.status === 0 &&
    allRecent.stdout === recentReport + "1\tother-repo\tcodex\tother-repo-recent\n",
    `expected valid rows after malformed lines: ${allRecent.stderr}${allRecent.stdout}`);
  const otherRepo = report("--repo", "other-repo", "--since-days", "1");
  assert(otherRepo.status === 0 &&
    otherRepo.stdout === "count\trepo\truntime\tskill\n1\tother-repo\tcodex\tother-repo-recent\n",
    `expected explicit other repository: ${otherRepo.stderr}${otherRepo.stdout}`);
  const unbounded = report();
  for (const days of ["0", "-0", "-0.0e123"]) {
    const unboundedZero = report("--since-days", days);
    assert(unbounded.status === 0 && unboundedZero.status === 0 &&
      unbounded.stdout === unboundedZero.stdout && unbounded.stdout.includes("\tcodex\told\n") &&
      !unbounded.stdout.includes("other-repo"),
      `expected unchanged unbounded report for ${days}: ${unbounded.stderr}${unboundedZero.stderr}`);
  }

  for (const args of [
    ["--since-days"],
    ...["", "typo", "-1", "-1e-999", "1e-999", "Infinity"].map(value => ["--since-days", value]),
    ["--since-days", "0", "--since-days", "1"],
    ["--since-days", "1", "--since-days", "1"],
    ["--since-days=abc"],
    ["--since-days=1"],
    ["--since-days", "1", "--since-days=0"],
  ]) {
    const result = report(...args);
    assert(result.status === 1 && result.stderr.includes("invalid --since-days") && !result.stdout,
      `expected invalid report window to fail: ${JSON.stringify(args)}`);
  }

  const upper = new Date(now).toISOString();
  const lower = new Date(now - day).toISOString();
  const justBefore = new Date(now - day - 1).toISOString();
  fs.appendFileSync(reportLog, [
    reportRecord("upper-bound", upper.replace("Z", "0000Z")),
    reportRecord("past-upper-bound", upper.replace("Z", "0001Z")),
    reportRecord("lower-bound", lower),
    reportRecord("after-lower-bound", lower.replace("Z", "0001Z")),
    reportRecord("before-lower-bound", justBefore.replace("Z", "9999Z")),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const boundary = report("--since-days", "1");
  assert(boundary.status === 0 && boundary.stdout === recentReport +
    "1\tno-git\tcodex\tupper-bound\n" +
    "1\tno-git\tcodex\tlower-bound\n" +
    "1\tno-git\tcodex\tafter-lower-bound\n",
    `expected report to respect sub-millisecond boundaries: ${boundary.stderr}${boundary.stdout}`);

  const precedingMs = new Date(now - 1).toISOString();
  fs.appendFileSync(reportLog, [
    reportRecord("fractional-cutoff", precedingMs.replace("Z", "500000000000000003200Z")),
    reportRecord("before-fractional-cutoff", precedingMs.replace("Z", "499999999999999999999Z")),
    reportRecord("after-fractional-cutoff", precedingMs.replace("Z", "500000000000000003201Z")),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const fractionalWindow = report("--since-days", "5.787037037037037e-9");
  assert(fractionalWindow.status === 0 && fractionalWindow.stdout ===
    "count\trepo\truntime\tskill\n1\tno-git\tcodex\tupper-bound\n" +
    "1\tno-git\tcodex\tfractional-cutoff\n1\tno-git\tcodex\tafter-fractional-cutoff\n",
    `expected fractional report window to include its cutoff: ${fractionalWindow.stderr}${fractionalWindow.stdout}`);

  const eightHoursAgo = new Date(now - 8 * 3600000).toISOString();
  fs.writeFileSync(reportLog, [
    reportRecord("exact-decimal-cutoff", eightHoursAgo.replace("Z", "288Z")),
    reportRecord("before-decimal-cutoff", eightHoursAgo.replace("Z", "287999999999999999Z")),
    reportRecord("after-decimal-cutoff", eightHoursAgo.replace("Z", "288000000000000001Z")),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const exactWindow = report("--since-days", "0.33333333");
  assert(exactWindow.status === 0 && exactWindow.stdout ===
    "count\trepo\truntime\tskill\n1\tno-git\tcodex\texact-decimal-cutoff\n" +
    "1\tno-git\tcodex\tafter-decimal-cutoff\n",
    `expected exact decimal cutoff: ${exactWindow.stderr}${exactWindow.stdout}`);

  const hookHome = path.join(tempRoot, "hook-home");
  const localBin = path.join(hookHome, ".local", "bin");
  const fakeBin = path.join(tempRoot, "fake-bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.symlinkSync(harnessEvent, path.join(localBin, "harness-event"));
  const fakeJq = path.join(fakeBin, "jq");
  fs.writeFileSync(
    fakeJq,
    "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' 'Plugin:skill'\n",
    { mode: 0o755 },
  );

  const settings = JSON.parse(
    fs.readFileSync(path.join(repo, "claude", "settings.json"), "utf8"),
  );
  const hook = settings.hooks.PostToolUse
    .flatMap((group) => group.hooks)
    .find((candidate) => candidate.command.includes("harness-event"));
  assert(hook, "missing harness-event fail-open hook");

  const failOpen = spawnSync("bash", ["-c", hook.command], {
    cwd: repo,
    encoding: "utf8",
    input: "{}\n",
    env: {
      ...process.env,
      HOME: hookHome,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      XDG_STATE_HOME: path.join(tempRoot, "fail-open-state"),
    },
  });
  assert(failOpen.status === 0, "validation failure escaped the fail-open hook");
  assert(
    failOpen.stderr.includes("invalid --skill"),
    "fail-open fixture did not exercise skill-name validation",
  );

  console.log(
    `harness-event fixtures passed: ${accepted.length} accepted, `
      + `${fixture.invalid.length} rejected, report windows and fail-open preserved`,
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
