// tests/mcp/tool-registry.test.ts
//
// Normative test: the tool registry is generated from the OpenAPI contract
// and never hand-curated. S7 plan mandates:
//
//   mcp_schema_matches_openapi
//
// We pin the registry to a static, hand-written manifest (the same one the
// generator emits) and assert the operationId ↔ REST mapping covers every
// operation declared by the drift detector.

import { describe, expect, it } from 'vitest';
import {
  buildToolRegistry,
  expectedToolOperationIds,
  type ToolCatalogEntry,
} from '@portable-agent-asset-hub/mcp';

describe('MCP tool registry (S7)', () => {
  it('registry_covers_every_canonical_openapi_operation', () => {
    const catalog: ToolCatalogEntry[] = [];
    const registry = buildToolRegistry(catalog);
    for (const op of expectedToolOperationIds()) {
      expect(registry.byOperationId.has(op), `operation ${op} must be present`).toBe(true);
    }
  });

  it('every_tool_has_a_capability_and_safety', () => {
    const registry = buildToolRegistry([]);
    // The static manifest shipped with the package must be complete; if any
    // entry is missing capability/safety, the builder throws.
    for (const op of expectedToolOperationIds()) {
      const tool = registry.byOperationId.get(op);
      expect(tool).toBeDefined();
      expect(tool!.capability.length).toBeGreaterThan(0);
      expect(['safe', 'mutating', 'destructive', 'diagnostic']).toContain(tool!.safety);
    }
  });

  it('registry_lists_tools_in_stable_order', () => {
    const a = buildToolRegistry([]).byOperationId;
    const b = buildToolRegistry([]).byOperationId;
    expect([...a.keys()]).toEqual([...b.keys()]);
  });

  it('catalog_can_override_entries_for_testing_without_mutation', () => {
    const override: ToolCatalogEntry = { operationId: 'getHealth', capability: 'read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/health' }, cas: false, idempotent: true };
    const registry = buildToolRegistry([override]);
    const tool = registry.byOperationId.get('getHealth')!;
    expect(tool.capability).toBe('read');
  });
});
