// Render a single caller-attributed stream as a report cell, not verified billing.
export function usageF1Cell(summary, agentId, runId) {
  const validId = (x) => typeof x === 'string' && x.trim().length > 0 && x.trim().toUpperCase() !== 'UNKNOWN' && x.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(x);
  const stdin = summary?.source === 'codex exec --json JSONL supplied on stdin' && summary?.caller_scope?.basis === 'caller_asserted_single_stdin_stream';
  const child = summary?.source === 'codex exec --json child stdout; allowlisted usage fields only' && summary?.caller_scope?.basis === 'explicit_single_child_stdout_stream' && summary?.caller_scope?.agent_attribution === 'CALLER_ASSERTED_SINGLE_RUN';
  if (!validId(agentId) || !validId(runId) || (!stdin && !child)) return 'UNKNOWN (출처 또는 범위 미확인)';
  agentId = agentId.trim();
  runId = runId.trim();
  if (!summary || summary.caller_scope?.agent_id !== agentId || summary.caller_scope?.run_id !== runId) return 'UNKNOWN (범위 불일치)';
  if (summary.observed_turn_completed_record_count !== 1 || !Array.isArray(summary.observed_usage_records) || summary.observed_usage_records.length !== 1) return 'UNKNOWN (사용량 없음 또는 중복 확인 불가)';
  const u = summary.observed_usage_records[0]?.usage;
  if (!u || typeof u !== 'object') return 'UNKNOWN (형식 불명)';
  const fields = ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens'];
  const labels = ['입력','캐시 읽기','캐시 쓰기','출력','추론 출력'];
  const numeric = fields.filter((f) => Number.isSafeInteger(u[f]) && u[f] >= 0).map((f) => u[f]);
  if (numeric.length === 0 || numeric.every((v) => v === 0)) return `UNKNOWN (수신 0 또는 미확인 값; codex exec --json ${child ? '자식 stdout' : 'stdin'} 단일 이벤트; 비용 UNKNOWN)`;
  const values = fields.map((f, i) => `${labels[i]} ${Number.isSafeInteger(u[f]) && u[f] >= 0 ? u[f] : 'UNKNOWN'}`);
  return `공식 토큰 UNKNOWN / 비용 UNKNOWN · codex exec --json ${child ? '자식 stdout' : 'stdin'} 관측값 ${values.join(' / ')} 토큰 (단일 수신 이벤트, 호출자 지정 범위, 재개 시 이전 턴 누적 가능·이번 턴 사용량 미확인, 0 의미 미확인)`;
}
