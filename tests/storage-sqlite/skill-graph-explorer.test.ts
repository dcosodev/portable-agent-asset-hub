import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActorContext, type ActorContext, type SkillRelationInput } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-explorer-')); roots.push(root);
  const store = new SqliteStore(join(root, 'hub.sqlite'));
  const actor = createActorContext({ userId: 'usr_graph', agentId: 'agt_graph', role: 'admin', capabilities: ['read', 'write.skill', 'admin'] });
  return { store, actor };
}
function write(store: SqliteStore, actor: ActorContext, id: string, relations?: SkillRelationInput[], expectedVersion?: number, revision = '') {
  return store.transaction(actor, (tx) => tx.skills.writeSkill({
    id, scope: actor.scope, logicalKey: `skill:default:${id}`, kind: 'skill', name: id,
    summary: `${id} summary`, lifecycle: 'active', body: Buffer.from(`# ${id}${revision}`), metadata: { tags: ['graph'] },
    resources: [{ relativePath: 'reference.md', mode: 0o644, mime: 'text/markdown', bytes: Buffer.from(id) }],
    ...(relations ? { relations } : {}), ...(expectedVersion ? { expectedVersion } : {}),
  }, { reason: 'graph test', requestId: `req_${id}_${expectedVersion ?? 0}` }));
}

describe('Web Graph Explorer storage projection', () => {
  it('returns stable global and centered graphs, history, impact and explicit truncation', () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'skl_c');
      write(store, actor, 'skl_b', [{ type: 'requires', targetSkillId: 'skl_c', targetVersion: 1 }]);
      write(store, actor, 'skl_d');
      write(store, actor, 'skl_e', [{ type: 'related_to', targetSkillId: 'skl_d' }]);
      write(store, actor, 'skl_a', [{ type: 'requires', targetSkillId: 'skl_b', targetVersion: 1 }, { type: 'related_to', targetSkillId: 'skl_e' }]);
      write(store, actor, 'skl_c', undefined, 1, ' v2');
      const global = store.transaction(actor, (tx) => tx.skills.buildGlobalGraph(actor.scope));
      expect(global.nodes.map((node) => node.id)).toEqual(['skl_a', 'skl_b', 'skl_c', 'skl_d', 'skl_e']);
      expect(global.edges.map((edge) => `${edge.source}:${edge.type}:${edge.target}`)).toEqual([
        'skl_a:related_to:skl_e', 'skl_a:requires:skl_b', 'skl_b:requires:skl_c', 'skl_e:related_to:skl_d',
      ]);
      expect(global.nodes.every((node) => !('body' in node))).toBe(true);
      const centered = store.transaction(actor, (tx) => tx.skills.buildCenteredGraph('skl_a', actor.scope, { mode: 'both', includeHistory: true }));
      expect(centered.root).toEqual({ id: 'skl_a', version: 1 });
      expect(centered.nodes.find((node) => node.id === 'skl_c')?.history).toEqual([1, 2]);
      expect(new Set(centered.edges.map((edge) => `${edge.source}:${edge.type}:${edge.target}`)).size).toBe(centered.edges.length);
      expect(centered.nodes.map((node) => node.id)).not.toContain('skl_d');
      const history = store.transaction(actor, (tx) => tx.skills.buildGlobalGraph(actor.scope, { includeHistory: true }));
      expect(history.nodes.map((node) => node.id)).toEqual(['skl_a@1', 'skl_b@1', 'skl_c@1', 'skl_c@2', 'skl_d@1', 'skl_e@1']);
      expect(history.nodes.every((node) => node.skillId === node.id.split('@')[0])).toBe(true);
      expect(history.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'skl_a@1', target: 'skl_b@1' }),
      ]));
      const impact = store.transaction(actor, (tx) => tx.skills.buildImpactGraph('skl_c', actor.scope));
      expect(impact.nodes.map((node) => node.id)).toEqual(['skl_a', 'skl_b', 'skl_c']);
      expect(impact.metadata.impactedCount).toBe(2);
      const limited = store.transaction(actor, (tx) => tx.skills.buildGlobalGraph(actor.scope, { limits: { maxNodes: 2 } }));
      expect(limited.metadata.truncated).toBe(true);
      expect(limited.nodes).toHaveLength(2);
      expect(limited.edges.every((edge) => limited.nodes.some((node) => node.id === edge.source) && limited.nodes.some((node) => node.id === edge.target))).toBe(true);
      const limitedCentered = store.transaction(actor, (tx) => tx.skills.buildCenteredGraph('skl_a', actor.scope, { limits: { maxNodes: 1 } }));
      expect(limitedCentered.nodes.map((node) => node.id)).toEqual(['skl_a']);
      expect(limitedCentered.edges).toEqual([]);
      expect(limitedCentered.metadata.truncated).toBe(true);
    } finally { store.close(); }
  });

  it('projects only persisted retrieval audit fields and distinguishes direct/dependency nodes', () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'skl_docker_build');
      write(store, actor, 'skl_kubernetes_deploy', [{ type: 'requires', targetSkillId: 'skl_docker_build', targetVersion: 1 }]);
      const resolution = store.transaction(actor, (tx) => tx.skills.resolveRetrieval('Deploy kubernetes application', 'default', actor.scope, { supportingThreshold: 0.2 }));
      write(store, actor, 'skl_docker_build', undefined, 1, ' v2');
      write(store, actor, 'skl_kubernetes_deploy', undefined, 1, ' v2');
      const events = store.transaction(actor, (tx) => tx.skills.listRetrievalEvents(actor.scope, 10, true));
      expect(events[0]).toEqual(expect.objectContaining({ requestId: resolution.requestId, redactedQuery: 'Deploy kubernetes application' }));
      const graph = store.transaction(actor, (tx) => tx.skills.getRetrievalEventGraph(resolution.requestId, actor.scope));
      expect(graph.metadata.query).toBe('Deploy kubernetes application');
      expect(graph.nodes.some((node) => node.selection?.reason === 'direct_match')).toBe(true);
      expect(graph.nodes.some((node) => node.selection?.reason === 'dependency')).toBe(true);
      expect(graph.edges.every((edge) => edge.reason === 'dependency')).toBe(true);
      expect(graph.nodes.every((node) => node.version === 1)).toBe(true);
      expect(graph.edges.every((edge) => edge.sourceVersion === 1 && edge.targetVersion === 1)).toBe(true);
    } finally { store.close(); }
  });

  it('does not leak skill graph or retrieval events across actor scope', () => {
    const { store, actor } = fixture();
    try {
      write(store, actor, 'skl_private');
      const event = store.transaction(actor, (tx) => tx.skills.resolveRetrieval('Deploy private application', 'default', actor.scope, { supportingThreshold: 0 }));
      const outsider = createActorContext({ userId: 'usr_other', agentId: 'agt_other', role: 'user', capabilities: ['read'] });
      expect(store.transaction(outsider, (tx) => tx.skills.buildGlobalGraph(outsider.scope).nodes)).toEqual([]);
      expect(() => store.transaction(outsider, (tx) => tx.skills.buildCenteredGraph('skl_private', outsider.scope))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
      expect(store.transaction(outsider, (tx) => tx.skills.listRetrievalEvents(outsider.scope))).toEqual([]);
      expect(() => store.transaction(outsider, (tx) => tx.skills.getRetrievalEventGraph(event.requestId, outsider.scope))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    } finally { store.close(); }
  });
});
