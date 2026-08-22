import { describe, expect, it } from 'vitest';
import { listen } from '@portable-agent-asset-hub/rest';
import { HubError } from '@portable-agent-asset-hub/core';

const actor = { userId: 'usr_test', agentId: 'agt_test', role: 'user' as const, capabilities: [], scope: { ownerUserId: 'usr_test', agentId: 'agt_test' } };
async function withServer(options: Parameters<typeof listen>[0], fn: (base: string) => Promise<void>) { const server = await listen({ ...options, port: 0 }); const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address'); try { await fn(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); } }

describe('S6 REST boundary', () => {
  it('rest_requires_cas_precondition', async () => withServer({ hub: {} , localMode: true }, async (base) => { const response = await fetch(`${base}/api/v1/bindings`, { method: 'POST', body: '{}' }); expect(response.status).toBe(428); }));
  it('rest_maps_conflict_409_and_scope_miss_404', async () => withServer({ localMode: true, localActor: actor, hub: { dispatch: (op: string) => { throw new HubError(op === 'getCatalog' ? 'NOT_FOUND' : 'CONFLICT', 'safe', op === 'getCatalog' ? 404 : 409); } } }, async (base) => { const conflict = await fetch(`${base}/api/v1/bindings`, { method: 'POST', headers: { 'if-match': '1' }, body: '{}' }); expect(conflict.status).toBe(409); const miss = await fetch(`${base}/api/v1/catalog`); expect(miss.status).toBe(404); }));
  it('rest_requires_bearer_non_loopback', async () => { await expect(listen({ host: '192.0.2.1', hub: {}, localMode: true })).rejects.toThrow(/non-loopback/); });
  it('rest_response_matches_openapi', async () => withServer({ hub: {}, localMode: true }, async (base) => { const response = await fetch(`${base}/api/v1/health`); expect(response.headers.get('content-type')).toContain('application/json'); expect(await response.json()).toEqual({ ok: true }); }));
  it('rest_unknown_method_on_known_path_is_405_with_allow', async () => withServer({ hub: {}, localMode: true }, async (base) => { const response = await fetch(`${base}/api/v1/health`, { method: 'POST', body: '{}' }); expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('GET'); const unknown = await fetch(`${base}/api/v1/nope`); expect(unknown.status).toBe(404); }));
  it('rest_create_operations_return_201', async () => withServer({ localMode: true, localActor: actor, hub: { dispatch: () => ({ ok: true }) } }, async (base) => { const created = await fetch(`${base}/api/v1/memories`, { method: 'POST', body: '{}' }); expect(created.status).toBe(201); const listed = await fetch(`${base}/api/v1/identities`); expect(listed.status).toBe(200); }));
  void actor;
});
