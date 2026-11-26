// Candidate discovery and repo-local link checks; never execute a Skill or write remotely.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillIndexWithStatus, matchSkillCandidatesWithStatus } from '../../../scripts/lib/routing-status.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const casesPath = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('cases.json', import.meta.url));
const name = path.basename(path.dirname(path.dirname(casesPath)));
assert.ok(['research', 'tech-hive'].includes(name), 'Expected Research or Tech Hive cases');
const index = loadSkillIndexWithStatus(path.join(root, 'skills/skill-index.json'));
assert.equal(index.status, 'ok');
assert.equal(index.skills.filter(skill => skill.name === name).length, 1);
for (const runtime of ['.agents', '.claude']) {
  const link = path.join(root, runtime, 'skills', name);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), runtime);
  assert.equal(fs.readlinkSync(link), `../../skills/${name}`);
  assert.equal(fs.realpathSync(path.join(link, 'SKILL.md')), fs.realpathSync(path.join(root, 'skills', name, 'SKILL.md')));
}
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
for (const c of cases) {
  const result = matchSkillCandidatesWithStatus(c.prompt.toLowerCase().trim(), { indexResult: index });
  assert.notEqual(result.status, 'unavailable', c.id);
  const actual = result.candidates.filter(x => ['research', 'tech-hive'].includes(x.name)).map(x => x.name).sort();
  assert.deepEqual(actual, [...c.candidates].sort(), c.id);
}
console.log(`${name}: ${cases.length}/${cases.length} candidate cases and 2 repo-local links PASS; semantic behavior and native execution NOT_RUN.`);
