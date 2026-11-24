// Exact declarative adapter checks, not a YAML implementation or a Native execution test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const expected = [
  ['research-collector', 'haiku', 'medium'],
  ['research-analyst', 'sonnet', 'medium'],
  ['research-architect', 'sonnet', 'high'],
];
const allowed = 'Read, Grep, Glob, WebSearch, WebFetch';
const denied = 'Agent, Bash, Write, Edit, NotebookEdit';

function checkAgent(source, name, model, effort) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, name + ' frontmatter');
  const entries = match[1].split(/\r?\n/).map(line => {
    const parsed = line.match(/^([A-Za-z][A-Za-z0-9]*): (.+)$/);
    assert.ok(parsed, name + ': unexpected metadata shape');
    return [parsed[1], parsed[2]];
  });
  const keys = entries.map(([key]) => key);
  assert.equal(new Set(keys).size, keys.length, name + ': duplicate key');
  assert.deepEqual([...keys].sort(), ['description','disallowedTools','effort','model','name','tools'].sort(), name + ': unexpected metadata');
  const meta = Object.fromEntries(entries);
  assert.equal(meta.name, name);
  assert.ok(meta.description);
  assert.equal(meta.model, model);
  assert.equal(meta.effort, effort);
  assert.equal(meta.tools, allowed, name + ': read-only allowlist drift');
  assert.equal(meta.disallowedTools, denied, name + ': denylist drift');
  assert.ok(source.includes('Do not run commands, modify files, invoke MCP, spawn agents'), name + ': worker scope');
}

for (const [name, model, effort] of expected) {
  const source = read('.claude/agents/' + name + '.md');
  checkAgent(source, name, model, effort);
  assert.throws(() => checkAgent(source.replace('tools: ' + allowed, 'tools: ' + allowed + ', Bash'), name, model, effort));
  assert.throws(() => checkAgent(source.replace('model: ' + model, 'model: inherit'), name, model, effort));
  assert.throws(() => checkAgent(source.replace('effort: ' + effort, 'effort: low'), name, model, effort));
}
for (const skill of ['research','tech-hive']) {
  const source = read('skills/' + skill + '/SKILL.md');
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(frontmatter, skill);
  assert.ok(!/^(?:model|effort|context|agent):/m.test(frontmatter[1]), skill + ': Claude-specific shared frontmatter');
  assert.ok(source.includes('## Delegation (purpose-based default, runtime-dependent)'), skill);
  assert.ok(source.includes('even without an explicit delegation request'), skill + ': default delegation contract missing');
  const link = skill === 'research' ? 'references/delegation.md' : '../research/references/delegation.md';
  assert.ok(source.includes('](' + link + ')'), skill);
  assert.ok(fs.existsSync(path.resolve(root, 'skills', skill, link)), skill + ': missing shared procedure');
}
const delegation = read('skills/research/references/delegation.md');
assert.ok(delegation.includes('Never bypass a blocked formal dispatch or Reviewer gate.'));
assert.ok(delegation.includes('## Default action (before substantive work)'));
assert.ok(delegation.includes('without requiring the user to name the worker'));
assert.ok(delegation.includes('An explicit no-delegation request takes precedence.'));
assert.ok(delegation.includes('Do not silently substitute a weaker worker'));
assert.ok(read('docs/examples/research-worker-delegation.md').includes('explicit delegation only as a separate positive control'));
assert.ok(read('docs/examples/research-worker-delegation.md').includes('Acceptance probes'));
console.log('Research delegation: 3 agent definitions, 9 negative mutations, 2 shared skill contracts and default-action text PASS (static only); Native execution, effective settings and permission enforcement NOT_RUN.');
