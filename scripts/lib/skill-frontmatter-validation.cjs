'use strict';

const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const YAML = require(path.join(
  repoRoot,
  '.github',
  'ci',
  'yaml',
  'node_modules',
  'yaml',
));

const PARSER_OPTIONS = {
  strict: true,
  version: '1.2',
  schema: 'core',
  uniqueKeys: true,
  resolveKnownTags: false,
  merge: false,
};

function validateSkillFrontmatter(frontmatter, expectedName) {
  const document = YAML.parseDocument(frontmatter, PARSER_OPTIONS);
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const messages = [...document.errors, ...document.warnings]
      .map((issue) => issue.message)
      .join('; ');
    throw new Error(`invalid YAML frontmatter: ${messages}`);
  }
  if (!YAML.isMap(document.contents)) {
    throw new Error('frontmatter must be a YAML mapping');
  }

  const name = document.get('name', true);
  if (!YAML.isScalar(name) || name.value !== expectedName) {
    throw new Error('frontmatter name must be a scalar matching the Skill directory');
  }

  const description = document.get('description', true);
  if (
    !YAML.isScalar(description)
    || typeof description.value !== 'string'
    || description.value.trim().length === 0
  ) {
    throw new Error('frontmatter description must be a non-empty string scalar');
  }
}

module.exports = { validateSkillFrontmatter };
