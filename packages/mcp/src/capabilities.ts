// packages/mcp/src/capabilities.ts
//
// Capability filter. The MCP server must NEVER expose a write or admin
// tool to an actor that does not hold the corresponding capability. The
// `read` capability is implicit and always present (the actor's identity
// only needs to be authenticated to see read-only tools).
//
// The matching rules are layered:
//   * `read` permits every tool whose capability ends in `.read` (the
//     baseline "discovery" surface).
//   * `write.<X>` permits every tool whose capability starts with `<X>.`
//     AND matches one of the write verbs `write`, `forget`, `supersede`.
//     Other verbs under the same namespace (e.g. `apply`, `rollback`)
//     are NOT unlocked by `write.<X>`.
//   * `admin.<X>` permits every tool whose capability starts with `<X>.`
//     AND matches one of the admin verbs `apply`. Other verbs under the
//     same namespace (e.g. `rollback`) are NOT unlocked by `admin.<X>`.
//   * Explicit capabilities listed in the canonical CAPABILITIES table
//     still permit their exact-named tools.

import type { ToolCatalogEntry } from './types.js';
import { CAPABILITIES } from '@portable-agent-asset-hub/core';

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(CAPABILITIES as readonly string[]);
const READ_CAPABILITY = 'read';
const WRITE_VERBS: ReadonlySet<string> = new Set(['write', 'forget', 'supersede']);
const ADMIN_VERBS: ReadonlySet<string> = new Set(['apply']);

/**
 * Split a capability string into its namespace and verb, e.g.
 *   "memory.write"  -> { ns: "memory", verb: "write" }
 *   "materialization.rollback" -> { ns: "materialization", verb: "rollback" }
 *   "read" -> { ns: "read", verb: "" }
 */
function splitCapability(capability: string): { ns: string; verb: string } {
  const idx = capability.indexOf('.');
  if (idx < 0) return { ns: capability, verb: '' };
  return { ns: capability.slice(0, idx), verb: capability.slice(idx + 1) };
}

/**
 * Test whether a single granted capability unlocks the given tool
 * capability, given the layered rules documented at the top of this
 * file. This is the single source of truth used by both
 * `filterToolsByCapability` and `actorMayInvoke`.
 */
export function capabilityUnlocks(granted: string, toolCapability: string): boolean {
  if (granted === toolCapability) return true;
  if (granted === READ_CAPABILITY) {
    // The baseline read capability permits every *.read tool.
    return toolCapability.endsWith('.read');
  }
  if (granted.startsWith('write.')) {
    const ns = granted.slice('write.'.length);
    // write.<X> permits exactly <X>.<write-verb>. The namespace must
    // match verbatim — no prefix tricks, because each write namespace
    // owns a single bounded set of write-style operations.
    return toolCapability.startsWith(`${ns}.`) && WRITE_VERBS.has(splitCapability(toolCapability).verb);
  }
  if (granted.startsWith('admin.')) {
    const ns = granted.slice('admin.'.length);
    // admin.<X> permits a tool whose capability's namespace matches
    // the bucket's verb either verbatim (`admin.replay` -> `replay`),
    // as a noun-form suffix (`admin.materialize` -> `materialization`),
    // or as a sub-namespace prefix (`admin.sync` -> `catalog.sync`).
    // Verb is restricted to the documented admin-verb set
    // (`apply`); destructive verbs like `rollback` and diagnostic verbs
    // like `run` are never unlocked by an `admin.*` grant.
    const tool = splitCapability(toolCapability);
    const namespaceMatches = tool.ns === ns
      || tool.ns === `${ns.replace(/e$/, '')}ation`
      || tool.ns.startsWith(`${ns}.`);
    if (!namespaceMatches) return false;
    return ADMIN_VERBS.has(tool.verb);
  }
  return false;
}

/**
 * Collect every granted capability (the implicit `read` baseline plus
 * each operator-granted string that the canonical table recognises) and
 * dedupe them into a single Set. This is the join key the filter
 * functions use to decide whether a tool is visible to the actor.
 */
function collectGrants(granted: readonly string[]): Set<string> {
  const set = new Set<string>([READ_CAPABILITY]);
  for (const cap of granted) {
    if (KNOWN_CAPABILITIES.has(cap)) set.add(cap);
  }
  return set;
}

/**
 * Filter the catalog to only the tools whose capability matches the
 * actor's grants. The `read` capability is implicit; any capability
 * outside the known set is ignored (the operator never asked for it).
 */
export function filterToolsByCapability(
  catalog: readonly ToolCatalogEntry[],
  granted: readonly string[],
): ToolCatalogEntry[] {
  const set = collectGrants(granted);
  return catalog.filter((tool) => {
    for (const cap of set) {
      if (capabilityUnlocks(cap, tool.capability)) return true;
    }
    return false;
  });
}

/** True when the actor is allowed to invoke a given tool. */
export function actorMayInvoke(
  tool: ToolCatalogEntry,
  granted: readonly string[],
): boolean {
  const set = collectGrants(granted);
  for (const cap of set) {
    if (capabilityUnlocks(cap, tool.capability)) return true;
  }
  return false;
}
