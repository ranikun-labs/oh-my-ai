#!/usr/bin/env node
import { boundedJsonlLines } from './lib/role-usage-summary.mjs';
import { inspectUsageSegments } from './lib/app-server-usage-segments.mjs';
import { inspectCompletedTurnUsage } from './lib/app-server-turn-usage.mjs';
import { appServerTurnUsageF1Cell } from './lib/usage-f1.mjs';

// First line is a caller-supplied identity envelope; subsequent lines are
// app-server notifications. Neither is authenticated or printed back.
const [sourceFlag, mode, ...extra] = process.argv.slice(2);
const renderF1 = mode === '--format=f1';
const requireCompleted = mode === '--require-turn-completed' || renderF1;
if (sourceFlag !== '--unverified-input' || extra.length || (mode !== undefined && !requireCompleted)) {
  process.stderr.write('사용법: app-server-usage-jsonl --unverified-input [--require-turn-completed | --format=f1] < input.jsonl\n입력은 출처가 검증되지 않았으며 민감할 수 있습니다.\n--format=f1에는 한 스레드의 한 턴에 해당하는 완료·사용량 이벤트를 제공하세요.\n');
  process.exitCode = 2;
} else {
  let result;
  try {
    let expected = null;
    const events = [];
    for await (const line of boundedJsonlLines(process.stdin, {maxInputBytes:1048576,maxLineBytes:262144,maxInputLines:10001,maxUsageRecords:1000})) {
      const value = JSON.parse(line);
      if (expected === null) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !value.expected || typeof value.expected !== 'object' || Array.isArray(value.expected)) throw Error('INVALID_ENVELOPE');
        expected = value.expected;
      } else {
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.method !== 'string' || !value.method) throw Error('INVALID_NOTIFICATION');
        events.push(value);
      }
    }
    result = expected === null ? {status:'INVALID_INPUT'} : requireCompleted ? inspectCompletedTurnUsage(events,expected) : inspectUsageSegments([events],expected);
  } catch { result = {status:'INVALID_OR_LIMITED_INPUT'}; }
  const output = renderF1 ? appServerTurnUsageF1Cell(result) : JSON.stringify(result);
  process.stdout.write(`${output}\n`);
  if (result.status !== 'SNAPSHOT_UNVERIFIED_SOURCE') process.exitCode = 1;
}
