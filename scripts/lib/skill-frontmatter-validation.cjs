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

function parseSkillFrontmatter(frontmatter) {
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

  return document;
}

function validateExplicitOnlyFrontmatter(frontmatter) {
  const document = parseSkillFrontmatter(frontmatter);
  const name = document.get('name', true);
  if (!YAML.isScalar(name) || name.value !== 'dev-main-flow') {
    throw new Error('frontmatter name must be dev-main-flow');
  }
  const disabled = document.get('disable-model-invocation', true);
  if (!YAML.isScalar(disabled) || disabled.value !== true) {
    throw new Error('disable-model-invocation must be true');
  }
  const metadata = document.get('metadata', true);
  if (!YAML.isMap(metadata)) throw new Error('metadata block is required');
  const source = metadata.get('source', true);
  if (!YAML.isScalar(source) || source.value !== 'born-here') {
    throw new Error('metadata source must be born-here');
  }
  const summary = metadata.get('summary', true);
  if (!YAML.isScalar(summary) || typeof summary.value !== 'string' || !summary.value.trim()) {
    throw new Error('metadata summary is required');
  }
  if (metadata.has('route') || metadata.has('routing')) {
    throw new Error('this planning entry must not add routing');
  }
}

function validateExplicitOnlyAgentMetadata(agentMetadata) {
  const document = parseSkillFrontmatter(agentMetadata);
  const policy = document.get('policy', true);
  if (!YAML.isMap(policy)) throw new Error('policy mapping is required');
  const implicit = policy.get('allow_implicit_invocation', true);
  if (!YAML.isScalar(implicit) || implicit.value !== false) {
    throw new Error('policy.allow_implicit_invocation must be false');
  }
  const iface = document.get('interface', true);
  const prompt = YAML.isMap(iface) ? iface.get('default_prompt', true) : null;
  if (!YAML.isScalar(prompt) || typeof prompt.value !== 'string' || !prompt.value.includes('Use $dev-main-flow')) {
    throw new Error('interface.default_prompt must mention Use $dev-main-flow');
  }
}

function validateSkillFrontmatter(frontmatter, expectedName) {
  const document = parseSkillFrontmatter(frontmatter);
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

module.exports = { validateSkillFrontmatter, validateExplicitOnlyFrontmatter, validateExplicitOnlyAgentMetadata };
