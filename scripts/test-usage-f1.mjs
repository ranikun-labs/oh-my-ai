import assert from 'node:assert/strict';
import { summarizeCodexExecJsonl } from './lib/role-usage-summary.mjs';
import { usageF1Cell } from './lib/usage-f1.mjs';
import { validateAiStatus } from './f1-report-advisory.mjs';
const scope = {role:'Main',agentId:'a',runId:'r'};
const item = JSON.stringify({type:'turn.completed',usage:{input_tokens:13,cached_input_tokens:2,output_tokens:4}});
const s = await summarizeCodexExecJsonl([item],scope);
const officialUnknown = /^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · /;
assert.match(usageF1Cell(s,'a','r'), /^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · codex exec --json stdin 관측값 /);
assert.match(usageF1Cell(s,'a','r'), /입력 13/);
assert.match(usageF1Cell(s,'a','r'), /재개 시 이전 턴 누적 가능·이번 턴 사용량 미확인/);
assert.match(usageF1Cell(s,' a ',' r '), /입력 13/);
assert.match(usageF1Cell(s,'a','r'), /추론 출력 UNKNOWN/);
assert.match(usageF1Cell(s,'b','r'), /^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · 관측값 UNKNOWN \(범위 불일치\)$/);
for (const events of [[],[JSON.stringify({type:'thread.started'})]]) {
 const empty = await summarizeCodexExecJsonl(events,scope);
 assert.equal(empty.schema_conformance,'NO_USAGE_RECORD_OBSERVED');
 assert.equal(empty.sum_of_received_records_may_include_duplicates.input_tokens,'UNKNOWN');
 assert.match(usageF1Cell(empty,'a','r'),/^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · 관측값 UNKNOWN \(완료 이벤트 없음 또는 단일 기록 확인 불가\)$/);
}
assert.match(usageF1Cell(await summarizeCodexExecJsonl([item,item],scope),'a','r'),/^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · 관측값 UNKNOWN \(완료 이벤트 없음 또는 단일 기록 확인 불가\)$/);
const threadStart = JSON.stringify({type:'thread.started',thread_id:'fixture-thread'});
const otherThreadStart = JSON.stringify({type:'thread.started',thread_id:'other-fixture-thread'});
const singleThread = await summarizeCodexExecJsonl([threadStart,item],scope);
assert.equal(singleThread.first_thread_start_event_index, 1);
assert.equal(s.first_thread_start_event_index, null);
assert.equal(usageF1Cell(singleThread,'a','r'), usageF1Cell(s,'a','r'));
for (const events of [[item,threadStart],[JSON.stringify({type:'turn.started'}),threadStart,item]]) {
 const lateStart = await summarizeCodexExecJsonl(events,scope);
 assert.equal(lateStart.observed_thread_start_record_count, 1);
 assert.equal(lateStart.first_thread_start_event_index, 2);
 assert.equal(lateStart.observed_turn_completed_record_count, 1);
 assert.match(usageF1Cell(lateStart,'a','r'), /^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · 관측값 UNKNOWN \(첫 이벤트가 스레드 시작이 아님\)$/);
 assert.doesNotMatch(JSON.stringify(lateStart), /fixture-thread/);
}
for (const events of [[threadStart,item,otherThreadStart],[threadStart,threadStart,item]]) {
 const mixed = await summarizeCodexExecJsonl(events,scope);
 assert.match(usageF1Cell(mixed,'a','r'), /^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · 관측값 UNKNOWN \(스레드 시작 이벤트 여러 건\)$/);
 assert.equal(mixed.observed_thread_start_record_count, 2);
 assert.equal(mixed.observed_turn_completed_record_count, 1);
 assert.doesNotMatch(JSON.stringify(mixed), /fixture-thread/);
}
assert.match(usageF1Cell(s,'a','wrong'),officialUnknown);
assert.match(usageF1Cell({observed_turn_completed_record_count:1,observed_usage_records:[{usage:{input_tokens:666}}]}),officialUnknown);
assert.match(usageF1Cell({...s,source:'fake'},'a','r'),officialUnknown);
assert.match(usageF1Cell({...s,caller_scope:{...s.caller_scope,basis:'fake'}},'a','r'),officialUnknown);
assert.match(usageF1Cell({...s,observed_usage_records:[{}]},'a','r'),/^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · 관측값 UNKNOWN \(형식 불명\)$/);
const child={...s,source:'codex exec --json child stdout; allowlisted usage fields only',caller_scope:{...s.caller_scope,basis:'explicit_single_child_stdout_stream',agent_attribution:'CALLER_ASSERTED_SINGLE_RUN'}};
assert.match(usageF1Cell(child,'a','r'), /^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · codex exec --json 자식 stdout 관측값 /);
assert.match(usageF1Cell(child,'a','r'),/재개 시 이전 턴 누적 가능·이번 턴 사용량 미확인/);
assert.match(usageF1Cell({...child,caller_scope:{...child.caller_scope,agent_id:'UNKNOWN',agent_attribution:'UNKNOWN'}},'UNKNOWN','r'),officialUnknown);
const zero = JSON.stringify({type:'turn.completed',usage:{input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0}});
assert.match(usageF1Cell(await summarizeCodexExecJsonl([zero],scope),'a','r'),/^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · codex exec --json stdin 관측값 UNKNOWN \(수신 0 또는 미확인 값/);
const partialZero = await summarizeCodexExecJsonl([JSON.stringify({type:'turn.completed',usage:{input_tokens:0}})],scope);
assert.match(usageF1Cell(partialZero,'a','r'),officialUnknown);
const childZero={...await summarizeCodexExecJsonl([zero],scope),source:child.source,caller_scope:child.caller_scope};
assert.match(usageF1Cell(childZero,'a','r'),/^공식 토큰 UNKNOWN \/ 비용 UNKNOWN · codex exec --json 자식 stdout 관측값 UNKNOWN \(수신 0 또는 미확인 값/);
const row = usageF1Cell(s,'a','r');
const report = `## AI 실행 현황\n관측 범위: complete\n확인된 참여자 수: 1\n전체 참여자 수: 1\n\n| Agent ID | 실제 역할 | 실제 참여 | Spawn Events | Resume Events | Continue Events | 요청 Model/Reasoning/Fast·출처 | 운영 선호·출처 | 실효 Model/Reasoning/Fast·출처 | 실제 작업·상태 | 공식 토큰·비용·구간·출처 |\n|---|---|---|---|---|---|---|---|---|---|---|\n| a | Main | YES | 1 | 0 | 0 | UNKNOWN | UNKNOWN | UNKNOWN | 완료 | ${row} |\n`;
assert.deepEqual(validateAiStatus(report,{observedParticipants:['a'],observationCoverage:'complete'}),{valid:true,errors:[],scope:'AI_STATUS_ONLY'});
console.log('usage F1 evidence mapping PASS');
