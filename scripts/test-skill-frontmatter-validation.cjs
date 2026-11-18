'use strict';

const assert = require('node:assert/strict');
const { validateSkillFrontmatter } = require('./lib/skill-frontmatter-validation.cjs');

const fixtures = [
  [
    'quoted key and values with comment',
    '"name": "review-case" # comment\ndescription: \'it\'\'s fine\'\n',
    'review-case',
    true,
  ],
  ['quoted name', 'name: "review-case"\ndescription: details\n', 'review-case', true],
  ['commented name', 'name: review-case # comment\ndescription: details\n', 'review-case', true],
  ['multiline plain description', 'name: review-case\ndescription: More\n  details\n', 'review-case', true],
  ['multiline quoted description', 'name: review-case\ndescription: "More\n  details"\n', 'review-case', true],
  ['escaped Unicode name', 'name: "review-\\u0063ase"\ndescription: details\n', 'review-case', true],
  ['folded block modifiers', 'name: review-case\ndescription: >-2\n  switched\n  to folded\n', 'review-case', true],
  ['literal block description', 'name: review-case\ndescription: |\n  useful\n', 'review-case', true],
  ['optional mapping and Claude flag', 'name: review-case\ndescription: details\ndisable-model-invocation: true\nmetadata:\n  source: born-here\n  summary: not validated here\n', 'review-case', true],
  ['name mismatch', 'name: another-skill\ndescription: details\n', 'review-case', false],
  ['missing name', 'description: details\n', 'review-case', false],
  ['missing description', 'name: review-case\n', 'review-case', false],
  ['non-string flow collection', 'name: review-case\ndescription: [details]\n', 'review-case', false],
  ['empty double-quoted description', 'name: review-case\ndescription: ""\n', 'review-case', false],
  ['empty single-quoted description', 'name: review-case\ndescription: \'\'\n', 'review-case', false],
  ['whitespace-only description', 'name: review-case\ndescription: "   "\n', 'review-case', false],
  ['comment-only description', 'name: review-case\ndescription: # comment\n', 'review-case', false],
  ['empty folded description', 'name: review-case\ndescription: >\n', 'review-case', false],
  ['empty literal description', 'name: review-case\ndescription: |\n  \n', 'review-case', false],
  ['null description', 'name: review-case\ndescription: null\n', 'review-case', false],
  ['empty null description', 'name: review-case\ndescription:\n', 'review-case', false],
  ['numeric description', 'name: review-case\ndescription: 2026\n', 'review-case', false],
  ['boolean description', 'name: review-case\ndescription: true\n', 'review-case', false],
  ['duplicate required key', 'name: review-case\ndescription: details\n"description": duplicate\n', 'review-case', false],
  ['duplicate nested key', 'name: review-case\ndescription: details\nmetadata:\n  source: born-here\n  source: external\n', 'review-case', false],
  ['unsupported custom tag', 'name: review-case\ndescription: !custom details\n', 'review-case', false],
  ['unexpanded description alias', 'name: review-case\nmetadata: &d details\ndescription: *d\n', 'review-case', false],
  ['unexpanded name alias', 'metadata: &n review-case\nname: *n\ndescription: details\n', 'review-case', false],
];

for (const [label, frontmatter, expectedName, expectedValid] of fixtures) {
  const validate = () => validateSkillFrontmatter(frontmatter, expectedName);
  if (expectedValid) {
    assert.doesNotThrow(validate, label);
  } else {
    assert.throws(validate, Error, label);
  }
}

console.log(`YAML scalar fixtures: ${fixtures.length}/${fixtures.length}`);
