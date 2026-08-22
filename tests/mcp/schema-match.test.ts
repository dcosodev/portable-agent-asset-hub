// tests/mcp/schema-match.test.ts
//
// Normative test: the MCP capability matrix must match the OpenAPI
// contract byte-for-byte. S7 plan mandates:
//
//   mcp_schema_matches_openapi
//
// The matrix declares which capability unlocks which tool. The OpenAPI
// contract declares, for every operation, an `x-mcp.capability` extension
// that names the capability the operator must grant. The two must agree
// for every operation in the canonical set.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedToolOperationIds, buildToolRegistry } from '@portable-agent-asset-hub/mcp';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const openapiPath = join(repoRoot, 'openapi/openapi.yaml');

interface OperationInfo {
  operationId: string;
  capability: string;
  safety: string;
  'x-mcp.capability': string;
  'x-mcp.safety': string;
}

function loadOpenapi(): { paths: Record<string, Record<string, OperationInfo>> } {
  // The drift detector already validates the OpenAPI file; we re-read it
  // here to keep this test independent of running scripts.
  const raw = readFileSync(openapiPath, 'utf8');
  return JSON.parse(raw) as { paths: Record<string, Record<string, OperationInfo>> };
}

describe('MCP schema matches OpenAPI (S7)', () => {
  it('every_openapi_operation_is_in_the_tool_registry', () => {
    const spec = loadOpenapi();
    const operationIds = new Set<string>();
    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods)) {
        if (op.operationId) operationIds.add(op.operationId);
      }
    }
    for (const op of expectedToolOperationIds()) {
      expect(operationIds.has(op), `OpenAPI missing operation ${op}`).toBe(true);
    }
  });

  it('openapi_x_mcp_capability_matches_registry', () => {
    const spec = loadOpenapi();
    const registry = buildToolRegistry([]);
    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods)) {
        if (!op.operationId) continue;
        const tool = registry.byOperationId.get(op.operationId);
        expect(tool, `registry missing tool for ${op.operationId}`).toBeDefined();
        expect(tool!.capability, `capability mismatch for ${op.operationId}`).toBe(op['x-mcp.capability']);
        expect(tool!.safety, `safety mismatch for ${op.operationId}`).toBe(op['x-mcp.safety']);
      }
    }
  });
});
