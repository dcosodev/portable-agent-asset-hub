// packages/mcp/src/tool-registry.ts
//
// The tool registry. The static manifest (generated-tool-metadata.ts) is
// the canonical source of truth; the registry exposes it as maps for
// fast lookup and lists the operationIds in the same order the contract
// declares them.

import { GENERATED_TOOLS } from './generated-tool-metadata.js';
import type { ToolCatalogEntry, ToolRegistry } from './types.js';

export function expectedToolOperationIds(): readonly string[] {
  return GENERATED_TOOLS.map((entry) => entry.operationId);
}

export function buildToolRegistry(overrides: readonly ToolCatalogEntry[] = []): ToolRegistry {
  const merged: ToolCatalogEntry[] = GENERATED_TOOLS.map((entry) => ({ ...entry, rest: { ...entry.rest } }));
  for (const override of overrides) {
    const idx = merged.findIndex((entry) => entry.operationId === override.operationId);
    if (idx >= 0) merged[idx] = { ...override, rest: { ...override.rest } };
  }
  const byOperationId = new Map<string, ToolCatalogEntry>();
  const byToolName = new Map<string, ToolCatalogEntry>();
  for (const entry of merged) {
    byOperationId.set(entry.operationId, entry);
    byToolName.set(toolNameForOperation(entry.operationId), entry);
  }
  return { byOperationId, byToolName };
}

export function toolNameForOperation(operationId: string): string {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/_+/g, '_')
    .toLowerCase();
}

export { GENERATED_TOOLS };
export type { ToolCatalogEntry };
