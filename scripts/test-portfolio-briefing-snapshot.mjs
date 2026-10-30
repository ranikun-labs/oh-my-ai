import assert from "node:assert/strict";
import { buildPortfolioBriefingSnapshot } from "./lib/portfolio-briefing-snapshot.mjs";

const capturedAt = "2026-10-30T10:00:00.000Z";
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function buildScopedSnapshot(input) {
  const sourceNames = Array.isArray(input.source_snapshots)
    ? [...new Set(input.source_snapshots.map(source => source?.name).filter(name => typeof name === "string"))]
    : [];
  return buildPortfolioBriefingSnapshot({ required_sources: sourceNames, ...input });
}

function jiraSnapshot(scope, issues, overrides = {}) {
  return {
    name: "jira",
    scope,
    uri: `https://jira.example.test/query/${scope}`,
    revision: "jira-snapshot-r1",
    checked_at: "2026-10-30T09:55:00.000Z",
    status: "available",
    issues,
    pull_requests: [],
    ...overrides,
  };
}

test("deduplicates Epic/child query overlap and never infers execution from Jira status", () => {
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [
      jiraSnapshot("project", [
        { key: "RPL-112", summary: "Parent Epic", status: "Done" },
        { key: "RPL-119", summary: "F1 report", status: "In Progress", parent_key: "RPL-112", assignee: "Owner" },
      ]),
      jiraSnapshot("epic-RPL-112", [
        { key: "RPL-119", summary: "F1 report", status: "In Progress", parent_key: "RPL-112" },
      ]),
      {
        name: "github",
        scope: "oh-my-ai",
        uri: "https://api.github.com/repos/ranikun-labs/oh-my-ai/pulls",
        revision: "gh-r1",
        checked_at: "2026-10-30T09:56:00.000Z",
        status: "available",
        issues: [],
        pull_requests: [{
          repository: "ranikun-labs/oh-my-ai",
          number: 88,
          url: "https://github.com/ranikun-labs/oh-my-ai/pull/88",
          state: "open",
          head_sha: "abc123",
          base_sha: "def456",
          ci_state: "success",
          review_state: "NOT_RUN",
          merge_state: "BLOCKED",
          jira_keys: ["RPL-119"],
        }],
      },
    ],
  });

  assert.equal(result.status, "CURRENT");
  assert.equal(result.verification_status, "UNVERIFIED");
  assert.equal(result.counts.unique_jira_issues, 2);
  assert.equal(result.sources[0].verification_status, "UNVERIFIED");
  assert.equal(result.issues.find(item => item.key === "RPL-119").jira_status, "In Progress");
  assert.equal(result.issues.find(item => item.key === "RPL-119").execution.state, "UNKNOWN");
  assert.equal(result.issues.find(item => item.key === "RPL-119").execution.status, "NOT_OBSERVED");
  assert.deepEqual(result.issues.find(item => item.key === "RPL-119").linked_pull_requests, ["ranikun-labs/oh-my-ai#88"]);
  assert.equal(result.counts.unique_pull_requests, 1);
  assert.equal(result.pull_requests[0].verification_status, "UNVERIFIED");
});

test("uses a separately supplied execution observation with provenance", () => {
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [jiraSnapshot("project", [{ key: "RPL-115", status: "To Do" }])],
    execution_observations: [{
      issue_key: "RPL-115",
      state: "REVIEW",
      source: "codex-task-observation",
      observed_at: "2026-10-30T09:59:00.000Z",
      evidence_ref: "task://opaque-ref",
    }],
  });
  const issue = result.issues[0];
  assert.equal(issue.jira_status, "To Do");
  assert.equal(issue.execution.state, "REVIEW");
  assert.equal(issue.execution.status, "REPORTED");
  assert.equal(issue.execution.verification_status, "UNVERIFIED");
  assert.equal(issue.execution.evidence_ref, "task://opaque-ref");
});

test("marks conflicting duplicate Jira statuses as DRIFT without choosing a winner", () => {
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [
      jiraSnapshot("project", [{ key: "RPL-121", summary: "Briefing", status: "To Do" }]),
      jiraSnapshot("project", [{ key: "RPL-121", summary: "Briefing", status: "In Progress" }], { revision: "jira-snapshot-r2" }),
    ],
  });
  assert.equal(result.status, "DRIFT");
  assert.equal(result.issues[0].jira_status, "DRIFT");
  assert.deepEqual(result.issues[0].jira_status_observations.map(item => item.status), ["To Do", "In Progress"]);
});

test("marks conflicting revisions for one source scope as DRIFT", () => {
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [
      jiraSnapshot("project", [{ key: "RPL-121", status: "To Do" }]),
      jiraSnapshot("project", [{ key: "RPL-122", status: "To Do" }], { revision: "jira-snapshot-r2" }),
    ],
  });
  assert.equal(result.sources[0].quality, "DRIFT");
  assert.equal(result.sources[1].quality, "DRIFT");
  assert.equal(result.status, "DRIFT");
});

test("marks unavailable and revision-less sources UNKNOWN", () => {
  const unavailable = jiraSnapshot("project", [], { status: "unavailable" });
  const noRevision = jiraSnapshot("epic", [], { revision: "" });
  const result = buildScopedSnapshot({ captured_at: capturedAt, source_snapshots: [unavailable, noRevision] });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.verification_status, "UNKNOWN");
  assert.equal(result.sources[0].quality, "UNKNOWN");
  assert.equal(result.sources[0].verification_status, "UNKNOWN");
  assert.equal(result.sources[0].reasons.includes("source_unavailable"), true);
  assert.equal(result.sources[1].quality, "UNKNOWN");
  assert.equal(result.sources[1].revision, "UNKNOWN");
});

test("requires every expected F6 source before reporting a current portfolio", () => {
  const result = buildPortfolioBriefingSnapshot({
    captured_at: capturedAt,
    source_snapshots: [jiraSnapshot("project", [{ key: "RPL-121", status: "To Do" }])],
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.verification_status, "UNKNOWN");
  assert.deepEqual(result.required_sources, ["jira", "github", "confluence"]);
  assert.equal(result.sources.find(source => source.name === "github").reasons.includes("required_source_missing"), true);
  assert.equal(result.sources.find(source => source.name === "confluence").quality, "UNKNOWN");
});

test("marks stale source snapshots and stale execution observations", () => {
  const staleSource = jiraSnapshot("project", [{ key: "RPL-115", status: "In Progress" }], {
    checked_at: "2026-10-30T08:00:00.000Z",
  });
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [staleSource],
    execution_observations: [{
      issue_key: "RPL-115",
      state: "RUNNING",
      source: "codex-task-observation",
      observed_at: "2026-10-30T08:00:00.000Z",
      evidence_ref: "task://old-observation",
    }],
  });
  assert.equal(result.status, "STALE");
  assert.equal(result.sources[0].quality, "STALE");
  assert.equal(result.issues[0].execution.state, "UNKNOWN");
  assert.equal(result.issues[0].execution.status, "STALE");
  assert.equal(result.issues[0].execution.verification_status, "UNKNOWN");
  assert.equal(result.issues[0].execution.reported_state, "RUNNING");
});

test("stale execution evidence lowers overall quality with a current source snapshot", () => {
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [jiraSnapshot("project", [{ key: "RPL-115", status: "To Do" }])],
    execution_observations: [{
      issue_key: "RPL-115",
      state: "RUNNING",
      source: "codex-task-observation",
      observed_at: "2026-10-30T08:00:00.000Z",
      evidence_ref: "task://stale-only-execution",
    }],
  });
  assert.equal(result.sources[0].quality, "CURRENT");
  assert.equal(result.issues[0].execution.status, "STALE");
  assert.equal(result.issues[0].quality, "STALE");
  assert.equal(result.status, "STALE");
});

test("conflicting latest execution observations lower portfolio quality to DRIFT", () => {
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [jiraSnapshot("project", [{ key: "RPL-115", status: "In Progress" }])],
    execution_observations: ["RUNNING", "DONE"].map(state => ({
      issue_key: "RPL-115",
      state,
      source: "codex-task-observation",
      observed_at: "2026-10-30T09:59:00.000Z",
      evidence_ref: `task://${state.toLowerCase()}`,
    })),
  });
  assert.equal(result.issues[0].execution.status, "DRIFT");
  assert.equal(result.issues[0].quality, "DRIFT");
  assert.equal(result.status, "DRIFT");
});

test("marks contradictory observations for the same Pull Request as DRIFT", () => {
  const github = {
    name: "github",
    scope: "oh-my-ai",
    uri: "https://api.github.com/repos/ranikun-labs/oh-my-ai/pulls",
    revision: "gh-r1",
    checked_at: "2026-10-30T09:56:00.000Z",
    status: "available",
    issues: [],
    pull_requests: [],
  };
  const record = { repository: "ranikun-labs/oh-my-ai", number: 121, state: "open", head_sha: "head-a", jira_keys: ["RPL-121"] };
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [
      { ...github, pull_requests: [{ ...record, url: "https://github.com/ranikun-labs/oh-my-ai/pull/121" }] },
      { ...github, revision: "gh-r2", pull_requests: [{ ...record, url: "https://github.com/ranikun-labs/oh-my-ai/pull/121", head_sha: "head-b" }] },
    ],
  });
  assert.equal(result.counts.unique_pull_requests, 1);
  assert.equal(result.pull_requests[0].quality, "DRIFT");
  assert.equal(result.pull_requests[0].head_sha, "DRIFT");
  assert.deepEqual(result.pull_requests[0].conflicts.head_sha.sort(), ["head-a", "head-b"]);
  assert.equal(result.pull_requests[0].observations.length, 2);
  assert.equal(result.status, "DRIFT");
});

test("deduplicates Pull Request records with repository identity or canonical URL", () => {
  const result = buildPortfolioBriefingSnapshot({
    captured_at: capturedAt,
    required_sources: ["github"],
    source_snapshots: [{
      name: "github",
      scope: "org/repo",
      uri: "https://api.github.com/repos/org/repo/pulls",
      revision: "gh-r1",
      checked_at: "2026-10-30T09:56:00.000Z",
      status: "available",
      issues: [],
      pull_requests: [
        { repository: "Org/Repo", number: 7, url: "https://github.com/org/repo/pull/7", state: "open", head_sha: "head-7" },
        { url: "https://github.com/org/repo/pull/7", state: "open", head_sha: "head-7" },
      ],
    }],
  });
  assert.equal(result.counts.unique_pull_requests, 1);
  assert.equal(result.pull_requests[0].id, "org/repo#7");
  assert.equal(result.status, "CURRENT");
});

test("marks Pull Request records without a canonical identity UNKNOWN", () => {
  const result = buildPortfolioBriefingSnapshot({
    captured_at: capturedAt,
    required_sources: ["github"],
    source_snapshots: [{
      name: "github",
      scope: "org/repo",
      uri: "https://api.github.com/repos/org/repo/pulls",
      revision: "gh-r1",
      checked_at: "2026-10-30T09:56:00.000Z",
      status: "available",
      issues: [],
      pull_requests: [{ state: "open", head_sha: "head-unknown" }],
    }],
  });
  assert.equal(result.counts.unique_pull_requests, 0);
  assert.equal(result.sources[0].quality, "UNKNOWN");
  assert.equal(result.sources[0].reasons.includes("pull_request_identity_incomplete"), true);
  assert.equal(result.status, "UNKNOWN");
});

test("marks partially supplied Pull Request identity conflicts as DRIFT", () => {
  const result = buildPortfolioBriefingSnapshot({
    captured_at: capturedAt,
    required_sources: ["jira", "github"],
    source_snapshots: [
      jiraSnapshot("project", [{ key: "RPL-121", status: "In Progress" }]),
      {
        name: "github",
        scope: "org/repo",
        uri: "https://api.github.com/repos/org/repo/pulls",
        revision: "gh-r1",
        checked_at: "2026-10-30T09:56:00.000Z",
        status: "available",
        issues: [],
        pull_requests: [{
          repository: "org/wrong",
          url: "https://github.com/org/repo/pull/7",
          jira_keys: ["RPL-121"],
          head_sha: "head-7",
        }],
      },
    ],
  });
  assert.equal(result.status, "DRIFT");
  assert.equal(result.counts.unique_pull_requests, 0);
  assert.equal(result.sources.find(source => source.name === "github").reasons.includes("pull_request_identity_conflict"), true);
  assert.deepEqual(result.issues[0].linked_pull_requests, []);
});

test("collects mixed-case source names after canonical normalization", () => {
  const result = buildPortfolioBriefingSnapshot({
    captured_at: capturedAt,
    required_sources: ["jira", "github"],
    source_snapshots: [
      jiraSnapshot("project", [{ key: "RPL-121", status: "In Progress" }], { name: "JIRA" }),
      {
        name: "GITHUB",
        scope: "org/repo",
        uri: "https://api.github.com/repos/org/repo/pulls",
        revision: "gh-r1",
        checked_at: "2026-10-30T09:56:00.000Z",
        status: "available",
        issues: [],
        pull_requests: [{
          repository: "org/repo",
          number: 7,
          url: "https://github.com/org/repo/pull/7",
          jira_keys: ["RPL-121"],
          head_sha: "head-7",
        }],
      },
    ],
  });
  assert.equal(result.status, "CURRENT");
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.issues[0].linked_pull_requests, ["org/repo#7"]);
});

test("propagates stale GitHub evidence to linked Pull Requests", () => {
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [{
      name: "github",
      scope: "oh-my-ai",
      uri: "https://api.github.com/repos/ranikun-labs/oh-my-ai/pulls",
      revision: "gh-r1",
      checked_at: "2026-10-30T08:00:00.000Z",
      status: "available",
      issues: [],
      pull_requests: [{
        repository: "ranikun-labs/oh-my-ai",
        number: 121,
        url: "https://github.com/ranikun-labs/oh-my-ai/pull/121",
        state: "open",
        head_sha: "head-a",
      }],
    }],
  });
  assert.equal(result.pull_requests[0].quality, "STALE");
  assert.equal(result.status, "STALE");
});

test("marks conflicting issue summaries and parent links as DRIFT", () => {
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [
      jiraSnapshot("project", [{ key: "RPL-121", summary: "Summary A", status: "To Do", parent_key: "RPL-112" }]),
      jiraSnapshot("project", [{ key: "RPL-121", summary: "Summary B", status: "To Do", parent_key: "RPL-113" }], { revision: "jira-snapshot-r2" }),
    ],
  });
  assert.equal(result.issues[0].quality, "DRIFT");
  assert.equal(result.issues[0].summary, null);
  assert.equal(result.issues[0].parent_key, null);
  assert.equal(result.issues[0].summary_observations.length, 2);
});

test("future source timestamps are UNKNOWN, not fresh evidence", () => {
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [jiraSnapshot("project", [{ key: "RPL-115", status: "To Do" }], { checked_at: "2026-10-30T10:01:00.000Z" })],
    execution_observations: [{
      issue_key: "RPL-115",
      state: "RUNNING",
      source: "codex-task-observation",
      observed_at: "2026-10-30T10:01:00.000Z",
      evidence_ref: "task://future-observation",
    }],
  });
  assert.equal(result.sources[0].quality, "UNKNOWN");
  assert.equal(result.sources[0].reasons.includes("source_time_after_snapshot"), true);
  assert.equal(result.issues[0].execution.state, "UNKNOWN");
  assert.equal(result.issues[0].execution.status, "NOT_OBSERVED");
});

test("ignores malformed issue keys and leaves unsupported execution states UNKNOWN", () => {
  const result = buildScopedSnapshot({
    captured_at: capturedAt,
    source_snapshots: [jiraSnapshot("project", [{ key: "not-a-jira-key", status: "Done" }, { key: "RPL-121", status: "Done" }])],
    execution_observations: [{
      issue_key: "RPL-121",
      state: "WORKER_DONE",
      source: "unknown-adapter",
      observed_at: "2026-10-30T09:59:00.000Z",
      evidence_ref: "task://untrusted",
    }],
  });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].execution.state, "UNKNOWN");
});

test("empty source input is UNKNOWN rather than an empty current portfolio", () => {
  const result = buildScopedSnapshot({ captured_at: capturedAt, source_snapshots: [] });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.counts.unique_jira_issues, 0);
});

test("invalid capture time fails closed", () => {
  const result = buildScopedSnapshot({ captured_at: "not-a-time", source_snapshots: [] });
  assert.equal(result.status, "INVALID");
  assert.deepEqual(result.errors, ["captured_at_invalid"]);
});

process.stdout.write(`F6 portfolio briefing fixtures: ${passed}/20 PASS\n`);
