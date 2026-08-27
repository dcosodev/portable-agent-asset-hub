import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createActorContext } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { listen, type RestHub } from '../../packages/rest/src/app.js';
import type { Server } from 'node:http';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function actor(capabilities: string[]) {
  return createActorContext({ userId: 'usr_a', agentId: 'agt_a', role: 'agent', capabilities });
}

async function baseUrl(hub: RestHub, capabilities: string[]) {
  const server = await listen({ hub, localMode: true, localActor: actor(capabilities), host: '127.0.0.1', port: 0 });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}

describe('Graph Explorer REST routes', () => {
  it('fails closed before dispatch when skill.read is missing', async () => {
    const dispatch = vi.fn();
    const url = await baseUrl({ dispatch }, ['status.read']);
    const response = await fetch(`${url}/api/v1/graph/skills`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN', message: 'skill.read capability required' }) }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('routes global, centered, impact and retrieval reads with decoded params/query', async () => {
    const dispatch = vi.fn((operationId: string, input: unknown) => { void input; return { operationId, nodes: [], edges: [], metadata: {} }; });
    const url = await baseUrl({ dispatch }, ['skill.read']);
    const requests = [
      ['/api/v1/graph/skills?versions=history&maxNodes=8', 'getGlobalSkillGraph'],
      ['/api/v1/skills/deploy%20eks/graph?mode=both&depth=2', 'getSkillGraph'],
      ['/api/v1/skills/docker/impact?depth=3', 'getSkillImpact'],
      ['/api/v1/retrieval-events?limit=7', 'listRetrievalEvents'],
      ['/api/v1/retrieval-events/ret_1/graph', 'getRetrievalEventGraph'],
    ] as const;
    for (const [path, operationId] of requests) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(200);
      expect((await response.json() as { operationId: string }).operationId).toBe(operationId);
    }
    expect(dispatch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ params: { id: 'deploy eks' }, query: { mode: 'both', depth: '2' } }));
  });
  it('persists a manual proposal through real HTTP dispatch without creating a canonical edge', async () => {
    const root = mkdtempSync(join('/tmp', 'relation-rest-')); const store = new SqliteStore(join(root, 'hub.sqlite')); const current = actor(['skill.relation.proposal.create']);
    try {
      store.transaction(current, (tx) => { tx.skills.writeSkill({ id: 'a', scope: current.scope, logicalKey: 'a', kind: 'skill', name: 'A', summary: 'A', lifecycle: 'active', body: Buffer.from('A'), metadata: {}, resources: [] }, { reason: 'test', requestId: 'a' }); tx.skills.writeSkill({ id: 'b', scope: current.scope, logicalKey: 'b', kind: 'skill', name: 'B', summary: 'B', lifecycle: 'active', body: Buffer.from('B'), metadata: {}, resources: [] }, { reason: 'test', requestId: 'b' }); });
      const dispatch = async (operationId: string, input: { body: unknown; actor: typeof current }) => {
        if (operationId !== 'createManualSkillRelationProposal') throw new Error('unexpected operation');
        const body = input.body as { sourceSkillId: string; targetSkillId: string; relationType: 'uses'; constraint?: string | null };
        return store.transaction(input.actor, (tx) => tx.relationProposals.createManual({ ...body, scope: input.actor.scope }, input.actor.userId));
      };
      const url = await baseUrl({ dispatch }, current.capabilities);
      const response = await fetch(`${url}/api/v1/skill-relation-proposals`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': '*' }, body: JSON.stringify({ sourceSkillId: 'a', targetSkillId: 'b', relationType: 'uses', constraint: null }) });
      expect(response.status).toBe(201); const proposal = await response.json() as { id: string; origin: string };
      expect(proposal.origin).toBe('manual');
      expect(store.transaction(current, (tx) => tx.relationProposals.list(current.scope))).toHaveLength(1);
      expect(store.transaction(current, (tx) => tx.skills.getRelations('a', 1, current.scope))).toHaveLength(0);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
