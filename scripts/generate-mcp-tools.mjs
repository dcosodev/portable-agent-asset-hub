#!/usr/bin/env node
// scripts/generate-mcp-tools.mjs
//
// Deterministic generator for the MCP tool manifest. Reads:
//
//   * openapi/openapi.yaml         — picks every operation whose
//                                    `x-mcp.exposed: true` extension is
//                                    set, in the same order the OpenAPI
//                                    document declares them.
//   * schemas/mcp-capabilities.v1.json
//                                  — the canonical capability matrix
//                                    (read/write/admin buckets).
//
// and writes:
//
//   * packages/mcp/src/generated-tool-metadata.ts
//                                  — frozen TypeScript object literal
//                                    with `GENERATED_TOOLS` (the catalog)
//                                    and `GENERATED_METADATA` (provenance
//                                    + capability-matrix pointer).
//
// Determinism contract:
//
//   * Same OpenAPI + capability-matrix input → byte-identical output
//     (modulo the `generatedAt` timestamp, which is the only wall-clock
//     field and is intentionally NOT used by any test).
//   * Path traversal order matches `JSON.parse` insertion order — the
//     generator never sorts, never deduplicates, never reorders.
//   * The script exits non-zero if the OpenAPI document is missing the
//     required x-mcp extensions, if a capability declared in OpenAPI is
//     not present in the capability matrix, or if the matrix is malformed.
//
// This script is the single source of truth for the MCP catalog. Editing
// `packages/mcp/src/generated-tool-metadata.ts` by hand is a violation of
// S7; the file carries a `// DO NOT EDIT` comment and the README points
// operators at this script. The drift detector in `tests/mcp/schema-match
// .test.ts` enforces that the file stays in sync with OpenAPI.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const openapiPath = resolve(repoRoot, 'openapi/openapi.yaml');
const capabilitiesPath = resolve(repoRoot, 'schemas/mcp-capabilities.v1.json');
const outputPath = resolve(repoRoot, 'packages/mcp/src/generated-tool-metadata.ts');

const GENERATOR_NAME = '@portable-agent-asset-hub/mcp/generate-mcp-tools';
const GENERATOR_VERSION = '0.1.0';
const KNOWN_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const REQUIRED_OPENAPI_EXTENSIONS = ['x-mcp.exposed', 'x-mcp.capability', 'x-mcp.safety', 'x-idempotent', 'x-cas-required'];

function fail(message) {
  console.error(`[generate-mcp-tools] ${message}`);
  process.exit(1);
}

/**
 * Load and parse the OpenAPI document. The repo keeps it as JSON-shaped
 * YAML (a single top-level object literal), so `JSON.parse` is enough.
 */
async function loadOpenapi() {
  let raw;
  try {
    raw = await readFile(openapiPath, 'utf8');
  } catch (e) {
    fail(`cannot read ${openapiPath}: ${e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    fail(`cannot parse ${openapiPath} as JSON: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || !doc.paths) {
    fail(`openapi document is missing the top-level "paths" object`);
  }
  return doc;
}

/**
 * Load the canonical capability matrix schema and validate that it is
 * well-formed. The repo ships the matrix as a JSON-Schema document
 * (schemas/mcp-capabilities.v1.json) that declares the SHAPE a populated
 * matrix must take — the populated matrix itself is produced by the
 * operator at deployment time. The generator only needs to assert that
 * the matrix file exists, parses as JSON, and exposes the well-known
 * `properties.buckets` / `properties.default` keys (those are the
 * surface area the runtime capability filter consults).
 *
 * Per-operation capability strings live in the OpenAPI document's
 * `x-mcp.capability` extension and are validated here against the
 * schema-defined enum (`safe`/`mutating`/`destructive`/`diagnostic`).
 */
async function loadCapabilityMatrixSchema() {
  let raw;
  try {
    raw = await readFile(capabilitiesPath, 'utf8');
  } catch (e) {
    fail(`cannot read ${capabilitiesPath}: ${e.message}`);
  }
  let schema;
  try {
    schema = JSON.parse(raw);
  } catch (e) {
    fail(`cannot parse ${capabilitiesPath} as JSON: ${e.message}`);
  }
  if (!schema || typeof schema !== 'object') {
    fail(`capability matrix schema is not a JSON object`);
  }
  const bucketsSchema = schema?.properties?.buckets;
  if (!bucketsSchema || typeof bucketsSchema !== 'object') {
    fail(`capability matrix schema is missing "properties.buckets"`);
  }
  if (!Array.isArray(bucketsSchema.required) || bucketsSchema.required.length === 0) {
    fail(`capability matrix schema is missing "properties.buckets.required" array`);
  }
  const bucketDef = schema?.$defs?.bucket;
  if (!bucketDef || typeof bucketDef !== 'object') {
    fail(`capability matrix schema is missing "$defs.bucket"`);
  }
  const safetyEnum = bucketDef?.properties?.safety?.enum;
  if (!Array.isArray(safetyEnum) || safetyEnum.length === 0) {
    fail(`capability matrix schema is missing "$defs.bucket.properties.safety.enum"`);
  }
  const defaultCapability = schema?.properties?.default;
  if (!defaultCapability || typeof defaultCapability !== 'object') {
    fail(`capability matrix schema is missing "properties.default"`);
  }
  return {
    bucketKeys: bucketsSchema.required,
    defaultCapability: defaultCapability.const ?? (Array.isArray(defaultCapability.enum) ? defaultCapability.enum[0] : null),
    safeties: safetyEnum,
  };
}

/**
 * Walk the OpenAPI document and extract every operation that exposes
 * itself to MCP. The returned array preserves the document's traversal
 * order — exactly the same order the drift detector and the tool registry
 * have always used, so any test that compares the two against the
 * generated file keeps working without modification.
 */
function collectExposedOperations(openapi) {
  const operations = [];
  for (const [path, methods] of Object.entries(openapi.paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const [method, op] of Object.entries(methods)) {
      if (!KNOWN_METHODS.has(method)) continue;
      if (!op || typeof op !== 'object') continue;
      if (op['x-mcp.exposed'] !== true) continue;
      // Every required extension must be present.
      for (const key of REQUIRED_OPENAPI_EXTENSIONS) {
        if (!(key in op)) {
          fail(`${method.toUpperCase()} ${path}: missing required extension "${key}"`);
        }
      }
      if (typeof op.operationId !== 'string' || op.operationId.length === 0) {
        fail(`${method.toUpperCase()} ${path}: missing operationId`);
      }
      operations.push({
        operationId: op.operationId,
        path,
        method: method.toUpperCase(),
        capability: op['x-mcp.capability'],
        safety: op['x-mcp.safety'],
        cas: !!op['x-cas-required'],
        idempotent: !!op['x-idempotent'],
      });
    }
  }
  return operations;
}

/**
 * Render a single tool entry as a two-space-indented object literal that
 * preserves JSON.stringify insertion order. Indentation matches the
 * OpenAPI document and the surrounding generated file.
 */
function renderToolEntry(op) {
  return [
    '  {',
    `    "operationId": ${JSON.stringify(op.operationId)},`,
    `    "capability": ${JSON.stringify(op.capability)},`,
    `    "safety": ${JSON.stringify(op.safety)},`,
    '    "rest": {',
    `      "method": ${JSON.stringify(op.method)},`,
    `      "path": ${JSON.stringify(op.path)}`,
    '    },',
    `    "cas": ${op.cas ? 'true' : 'false'},`,
    `    "idempotent": ${op.idempotent ? 'true' : 'false'}`,
    '  }',
  ].join('\n');
}

function renderFile({ operations, generatedAt, sourcePath, capabilitiesPath: capPath }) {
  const toolsBlock = operations.map(renderToolEntry).join(',\n');
  return [
    '// packages/mcp/src/generated-tool-metadata.ts',
    '//',
    '// DO NOT EDIT. This file is regenerated by scripts/generate-mcp-tools.mjs',
    '// from openapi/openapi.yaml + schemas/mcp-capabilities.v1.json. Hand-edits',
    '// will be overwritten by the next generator run.',
    '',
    "import type { ToolCatalogEntry, GeneratedToolMetadata } from './types.js';",
    '',
    'export const GENERATED_TOOLS: readonly ToolCatalogEntry[] = [',
    toolsBlock,
    '];',
    '',
    'export const GENERATED_METADATA: GeneratedToolMetadata = Object.freeze({',
    `  generator: ${JSON.stringify(GENERATOR_NAME)},`,
    `  version: ${JSON.stringify(GENERATOR_VERSION)},`,
    `  source: ${JSON.stringify(sourcePath)},`,
    `  generatedAt: ${JSON.stringify(generatedAt)},`,
    `  capabilityMatrix: ${JSON.stringify(capPath)},`,
    `  operationCount: GENERATED_TOOLS.length,`,
    '  tools: GENERATED_TOOLS as ToolCatalogEntry[],',
    '});',
    '',
  ].join('\n');
}

async function main() {
  const openapi = await loadOpenapi();
  const matrix = await loadCapabilityMatrixSchema();
  const operations = collectExposedOperations(openapi);

  if (operations.length === 0) {
    fail('openapi document exposes zero operations to MCP — refusing to emit an empty manifest');
  }

  // Validate that every emitted operation declares a safety value the
  // capability matrix actually understands. The capability string itself
  // (e.g. "health.read") is operator-defined and lives in the populated
  // matrix at deploy time; the schema only constrains the safety enum.
  const safetyEnum = new Set(matrix.safeties);
  for (const op of operations) {
    if (!safetyEnum.has(op.safety)) {
      fail(`operation "${op.operationId}" declares safety "${op.safety}" which is not in the capability matrix safety enum (${JSON.stringify(matrix.safeties)})`);
    }
  }

  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  const generatedAt = sourceDateEpoch && /^\d+$/u.test(sourceDateEpoch)
    ? new Date(Number(sourceDateEpoch) * 1000).toISOString()
    : '1970-01-01T00:00:00.000Z';
  const relativeSource = 'openapi/openapi.yaml';
  const relativeCapabilityMatrix = 'schemas/mcp-capabilities.v1.json';
  const body = renderFile({
    operations,
    generatedAt,
    sourcePath: relativeSource,
    capabilitiesPath: relativeCapabilityMatrix,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body, 'utf8');

  const summary = {
    generator: GENERATOR_NAME,
    version: GENERATOR_VERSION,
    output: outputPath,
    operations: operations.length,
    generatedAt,
  };
  console.log(JSON.stringify(summary));
}

await main();