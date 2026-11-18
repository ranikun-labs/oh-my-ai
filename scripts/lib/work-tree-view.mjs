// Caller-supplied observations only: this module does not query Jira or infer completion.
// parent: parent -> child; membership: grouping -> member; blocks: prerequisite -> blocked.
// relates is symmetric. Evidence is supplied by the caller and is not independently verified.
// Caller must sanitize credentials, sensitive data and raw responses before providing observations.
const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const RELATIONS = new Set(['parent', 'membership', 'blocks', 'relates']);
const MAX_ITEMS = 500;
const MAX_RELATIONS = 2000;
const own = (o, keys) => Object.keys(o).every(k => keys.includes(k));
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o) && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
const safe = v => (String(v ?? '').replace(/[\r\n\u2028\u2029]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() || 'UNKNOWN').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\|`*_{}\[\]()#+!~]/g, '\\$&');

export function formatWorkTree(input) {
  if (!object(input) || !own(input, ['items', 'relations']) || !Array.isArray(input.items) || !Array.isArray(input.relations) || input.items.length > MAX_ITEMS || input.relations.length > MAX_RELATIONS) throw new TypeError('invalid work-tree input');
  const items = new Map();
  for (const x of input.items) {
    if (!object(x) || !own(x, ['key','title','status','source_ref','observed_at']) || typeof x.key !== 'string' || x.key.length > 100 || !KEY.test(x.key) || items.has(x.key)) throw new TypeError('invalid or duplicate item');
    for (const k of ['title','status','source_ref','observed_at']) if (x[k] != null && (typeof x[k] !== 'string' || x[k].length > 1000)) throw new TypeError('invalid item field');
    items.set(x.key, x);
  }
  const relations = [];
  const seen = new Map();
  for (const x of input.relations) {
    if (!object(x) || !own(x, ['from','to','type','source_ref','observed_at']) || !items.has(x.from) || !items.has(x.to) || x.from === x.to || !RELATIONS.has(x.type)) throw new TypeError('invalid relation');
    for (const k of ['source_ref','observed_at']) if (x[k] != null && (typeof x[k] !== 'string' || x[k].length > 1000)) throw new TypeError('invalid relation field');
    const endpoints = x.type === 'relates' ? [x.from, x.to].sort() : [x.from, x.to];
    const id = `${x.type}:${endpoints[0]}:${endpoints[1]}`;
    const evidence = { source_ref: x.source_ref, observed_at: x.observed_at };
    if (seen.has(id)) { seen.get(id).evidence.push(evidence); continue; }
    const row = { ...x, from: endpoints[0], to: endpoints[1], evidence: [evidence] };
    seen.set(id, row); relations.push(row);
  }
  const parents = new Map();
  const children = new Map();
  for (const r of relations.filter(r => r.type === 'parent')) {
    if (!parents.has(r.to)) parents.set(r.to, new Set());
    parents.get(r.to).add(r.from);
    if (!children.has(r.from)) children.set(r.from, []);
    children.get(r.from).push(r.to);
  }
  const warnings = [];
  for (const [key, values] of parents) if (values.size > 1) warnings.push(`DRIFT: ${key}의 Parent 관찰 ${values.size}개가 서로 다릅니다.`);
  const active = new Set(), done = new Set();
  function visit(key) {
    if (active.has(key)) return true;
    if (done.has(key)) return false;
    active.add(key);
    for (const child of children.get(key) ?? []) if (visit(child)) return true;
    active.delete(key); done.add(key); return false;
  }
  if ([...items.keys()].some(visit)) warnings.push('DRIFT: Parent 관찰에 순환이 있습니다.');
  // Flat edges preserve type, direction and many-to-many without fabricating a parent tree.
  return ['# 업무 관계 보기', '', '호출자가 정제해 전달한 관찰만 표시합니다. 출처와 확인 시각은 호출자가 제공했으며 검증되지 않았습니다. Parent와 소속·의존·관련 링크는 다르며 자동 조회·완료 판정을 하지 않습니다.', ...warnings.map(w => `- ${safe(w)}`), '', '| 이슈 | 제목 | 상태 | 출처 | 확인 시각 |', '|---|---|---|---|---|', ...[...items.values()].map(x => `| ${safe(x.key)} | ${safe(x.title)} | ${safe(x.status)} | ${safe(x.source_ref)} | ${safe(x.observed_at)} |`), '', '| 시작 | 관계 | 대상 | 관찰 근거 (출처, 확인 시각) |', '|---|---|---|---|', ...relations.map(x => `| ${safe(x.from)} | ${safe(x.type)} | ${safe(x.to)} | ${x.evidence.map(e => `${safe(e.source_ref)}, ${safe(e.observed_at)}`).join(' ; ')} |`)].join('\n');
}
