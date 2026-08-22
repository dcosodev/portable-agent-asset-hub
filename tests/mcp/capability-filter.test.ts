// tests/mcp/capability-filter.test.ts
//
// Normative test: the MCP capability filter must hide write and admin tools
// when the actor does not hold the corresponding capability. This is one of
// the two S7 fail-closed gates — see plan Slice 7 §"Tests/gate":
//
//   mcp_hides_write_and_admin_without_capability
//
// The filter consumes a tool catalog (operationId + capability + safety)
// and the set of capabilities the actor was granted by the operator. The
// read capability is implicit and always present.

import { describe, expect, it } from 'vitest';
import { capabilityUnlocks, filterToolsByCapability, type ToolCatalogEntry } from '@portable-agent-asset-hub/mcp';
import { CAPABILITIES } from '@portable-agent-asset-hub/core';

const ALL_OPS: ToolCatalogEntry[] = [
  { operationId: 'getHealth', capability: 'health.read', safety: 'safe' },
  { operationId: 'listIdentities', capability: 'identity.read', safety: 'safe' },
  { operationId: 'createMemory', capability: 'memory.write', safety: 'mutating' },
  { operationId: 'forgetMemory', capability: 'memory.forget', safety: 'destructive' },
  { operationId: 'applyMaterialization', capability: 'materialization.apply', safety: 'mutating' },
  { operationId: 'rollbackMaterialization', capability: 'materialization.rollback', safety: 'destructive' },
  { operationId: 'applyCatalogSync', capability: 'catalog.sync.apply', safety: 'mutating' },
  { operationId: 'replay', capability: 'replay.run', safety: 'diagnostic' },
  { operationId: 'getDoctor', capability: 'admin.doctor', safety: 'diagnostic' },
];

describe('MCP capability filter (S7)', () => {
  it('hides_write_and_admin_without_capability', () => {
    const visible = filterToolsByCapability(ALL_OPS, ['read']);
    const visibleIds = visible.map((t) => t.operationId);
    expect(visibleIds).toContain('getHealth');
    expect(visibleIds).toContain('listIdentities');
    expect(visibleIds).not.toContain('createMemory');
    expect(visibleIds).not.toContain('forgetMemory');
    expect(visibleIds).not.toContain('applyMaterialization');
    expect(visibleIds).not.toContain('rollbackMaterialization');
    expect(visibleIds).not.toContain('applyCatalogSync');
    expect(visibleIds).not.toContain('replay');
    expect(visibleIds).not.toContain('getDoctor');
  });

  it('grants_write_memory_when_capability_present', () => {
    const visible = filterToolsByCapability(ALL_OPS, ['read', 'write.memory']);
    const ids = visible.map((t) => t.operationId);
    expect(ids).toContain('createMemory');
    expect(ids).toContain('forgetMemory');
    expect(ids).not.toContain('applyMaterialization');
    expect(ids).not.toContain('replay');
  });

  it('admin_capability_must_be_explicitly_granted', () => {
    const visible = filterToolsByCapability(ALL_OPS, ['read', 'admin.materialize']);
    const ids = visible.map((t) => t.operationId);
    expect(ids).toContain('applyMaterialization');
    expect(ids).not.toContain('rollbackMaterialization');
    expect(ids).not.toContain('replay');
  });

  it('every_visible_tool_is_unlocked_by_a_known_grant', () => {
    // Under the layered capability model a tool is visible iff at least
    // one of the actor's granted capabilities (the implicit `read`
    // baseline or an entry from the canonical CAPABILITIES table)
    // unlocks it via the documented rules. This replaces the older
    // assertion that the tool's capability must itself appear in
    // CAPABILITIES — leaf capabilities like `health.read` are matched
    // by the `read` baseline, not by an exact CAPABILITIES entry.
    const granted = ['read', ...CAPABILITIES];
    const visible = filterToolsByCapability(ALL_OPS, CAPABILITIES);
    expect(visible.length).toBeGreaterThan(0);
    for (const tool of visible) {
      const unlocked = granted.some((g) => capabilityUnlocks(g, tool.capability));
      expect(unlocked, `${tool.capability} must be unlocked by some granted capability`).toBe(true);
    }
  });

  it('empty_capability_set_only_yields_read_baseline_when_read_present', () => {
    const visible = filterToolsByCapability(ALL_OPS, []);
    const ids = visible.map((t) => t.operationId);
    // The read baseline is implicit, so identity/health/etc. are still visible
    // even with an empty capability list. The filter must never expose write
    // or admin tools without a matching capability.
    expect(ids).toContain('getHealth');
    expect(ids).not.toContain('createMemory');
    expect(ids).not.toContain('applyMaterialization');
    expect(ids).not.toContain('replay');
  });

  it('rejects_unknown_capability_strings_without_throwing', () => {
    const visible = filterToolsByCapability(ALL_OPS, ['read', 'unknown.capability']);
    // Unknown capabilities do not unlock anything; the baseline still applies.
    expect(visible.find((t) => t.operationId === 'createMemory')).toBeUndefined();
  });
});
