// scripts/docs-check.mjs
//
// A documentation contract, not a style checker. It answers three
// questions that silently rot as the code changes:
//
//   1. Does every document the index promises still exist?
//   2. Does every relative link in those documents still resolve?
//   3. Do the documents still describe the architecture that ships?
//
// The third check is deliberately narrow: it asserts the presence of the
// concepts a reader must find, and the absence of claims we know went
// stale, rather than trying to validate prose.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();

/**
 * The current schema version, derived from the migrations on disk rather
 * than hardcoded — the whole point is that the documents track the code,
 * so the number this gate compares against has to come from the code.
 */
const schemaVersion = Math.max(
  ...readdirSync(resolve(root, 'packages/storage-sqlite/src/migrations'))
    .map((name) => /^(\d{4})_/u.exec(name)?.[1])
    .filter((version) => version !== undefined)
    .map(Number),
);

/** Documents that describe how the shipped system behaves today. */
const currentDocs = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'docs/README.md',
  'docs/architecture.md',
  'docs/canonical-storage.md',
  'docs/skill-relations.md',
  'docs/skill-graph-retrieval.md',
  'docs/relation-proposal-workflow.md',
  'docs/web-graph-explorer.md',
  'docs/runtime-adapters.md',
  'docs/observability.md',
  'docs/demo.md',
  'docs/engineering-log.md',
  'observability/README.md',
  'slices/README.md',
  'docs/adr/0001-single-sqlite-owner.md',
  'docs/adr/0002-portable-v1-exclusions.md',
  'docs/adr/0003-tencent-extraction-boundary.md',
  'docs/adr/0004-opentelemetry-operational-side-channel.md',
];

const failures = [];
let linksChecked = 0;
let mermaidBlocks = 0;

const fail = (message) => failures.push(message);

for (const relative of currentDocs) {
  const absolute = resolve(root, relative);
  if (!existsSync(absolute)) {
    fail(`${relative}: current document is missing`);
    continue;
  }
  const text = readFileSync(absolute, 'utf8');
  mermaidBlocks += (text.match(/```mermaid\n/g) ?? []).length;

  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, '');
    // Anchors and absolute URLs are out of scope: this gate only owns
    // links whose target lives in the repository.
    if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const pathPart = decodeURIComponent(raw.split('#', 1)[0].split('?', 1)[0]);
    if (!pathPart) continue;
    const target = resolve(dirname(absolute), pathPart);
    linksChecked += 1;
    if (!existsSync(target)) {
      fail(`${relative}: broken relative link ${raw}`);
      continue;
    }
    if (pathPart.endsWith('/') && !statSync(target).isDirectory()) {
      fail(`${relative}: expected directory link ${raw}`);
    }
  }
}

const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

// Claims that were true of an earlier slice and would mislead now.
const staleClaims = [
  [/\b23 operations\b/i, 'the pre-0.2.0 operation count'],
  [/strictly read-only projection/i, 'the pre-0.3.0 read-only BFF claim'],
];

// A document that names a schema version or a migration chain must name the
// current one. `CHANGELOG.md` and the engineering log record history on
// purpose and are exempt; every other current document is not.
const historical = new Set(['CHANGELOG.md', 'docs/engineering-log.md']);
const current = String(schemaVersion).padStart(2, '0');
const schemaClaims = [
  [new RegExp(`\\bschema (?!${schemaVersion}\\b)\\d+`, 'iu'), 'a schema version that is not the current one'],
  [new RegExp(`\\b0001\\.\\.(?!00${current}\\b)\\d{4}\\b`, 'u'), 'a migration chain that does not end at the current migration'],
];

for (const relative of currentDocs) {
  const absolute = resolve(root, relative);
  if (!existsSync(absolute)) continue;
  const text = readFileSync(absolute, 'utf8');
  for (const [pattern, why] of staleClaims) {
    if (pattern.test(text)) fail(`${relative}: stale claim (${why}) matches ${pattern}`);
  }
  if (historical.has(relative)) continue;
  for (const [pattern, why] of schemaClaims) {
    const match = pattern.exec(text);
    if (match) fail(`${relative}: stale claim (${why}): ${JSON.stringify(match[0])}`);
  }
}

// Concepts a reader must be able to find in the entry document.
for (const required of ['MCP stdio', 'SQLite', 'OpenTelemetry', 'Graph Explorer']) {
  if (!readme.includes(required)) fail(`README.md: missing architecture concept ${required}`);
}

if (mermaidBlocks < 1) fail(`expected at least one Mermaid diagram across current docs, found ${mermaidBlocks}`);

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.stderr.write(`Documentation contract failed: ${failures.length} issue(s).\n`);
  process.exit(1);
}

process.stdout.write(`Documentation contract PASS: ${currentDocs.length} current docs, ${linksChecked} relative links, ${mermaidBlocks} Mermaid block(s), schema ${schemaVersion}.\n`);
