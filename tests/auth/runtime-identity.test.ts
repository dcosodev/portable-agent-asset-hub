import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createActorContext } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { createApp } from '@portable-agent-asset-hub/rest';
import { buildMcpServer } from '@portable-agent-asset-hub/mcp';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('runtime credential identity', () => {
  it('resolves two credentials to distinct actors and revocation is fail-closed', () => {
    const root = mkdtempSync(join(process.cwd(), '.tmp-auth-'));
    roots.push(root);
    const store = new SqliteStore(join(root, 'hub.sqlite'));
    const admin = createActorContext({ userId: 'usr_local', agentId: 'agt_local', role: 'admin', capabilities: ['read', 'write.memory'] });
    const identities = store.transaction(admin, (tx) => {
      const user = tx.identities.createUser({ displayName: 'test' });
      const codex = tx.identities.createAgent({ ownerUserId: user.id, name: 'codex-main' });
      const opencode = tx.identities.createAgent({ ownerUserId: user.id, name: 'opencode-main' });
      return { user, codex, opencode };
    });
    const codex = store.createCredential({ userId: identities.user.id, agentId: identities.codex.id, runtime: 'codex', profile: 'default', role: 'agent', capabilities: ['skill.read'] });
    const opencode = store.createCredential({ userId: identities.user.id, agentId: identities.opencode.id, runtime: 'opencode', profile: 'default', role: 'agent', capabilities: ['skill.read'] });
    expect(store.authenticateCredential(codex.token, 'req-codex')?.agentId).toBe(identities.codex.id);
    expect(store.authenticateCredential(opencode.token, 'req-opencode')?.agentId).toBe(identities.opencode.id);
    expect(store.authenticateCredential(codex.token, 'req-requested', ['skill.read', 'write.memory'])?.capabilities).toEqual(['skill.read']);
    store.revokeCredential(codex.id);
    expect(store.authenticateCredential(codex.token, 'req-revoked')).toBeNull();
    const rotated = store.rotateCredential(opencode.id);
    expect(store.authenticateCredential(opencode.token, 'req-old-rotation')).toBeNull();
    expect(store.authenticateCredential(rotated.token, 'req-new-rotation')?.agentId).toBe(identities.opencode.id);
    const report = store.doctor();
    expect(report.checks.credentialStoreHealthy).toBe(true);
    expect(report.checks.authAuditHealthy).toBe(true);
    store.close();
  });

  it('publishes a non-sensitive capability handshake over REST and MCP', async () => {
    const actor = createActorContext({ userId: 'usr_test', agentId: 'agt_opencode', role: 'agent', capabilities: ['capabilities.read'] });
    const app = createApp({ hub: {}, localMode: true, localActor: actor });
    const response = await new Promise<{ statusCode?: number; body: string }>((resolve) => {
      const req = { method: 'GET', url: '/api/v1/capabilities', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never;
      const res = { statusCode: undefined, setHeader() {}, end(value: string) { resolve({ statusCode: res.statusCode, body: value }); }, } as never;
      void app(req, res);
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ schemaVersion: 20, auth: { mode: 'local-dev' }, actor: { agentId: 'agt_opencode' } });
    const server = buildMcpServer({ restBaseUrl: 'http://hub.test', actor, transport: async (request: unknown) => { void request; return { status: 200, headers: {}, body: { schemaVersion: 20, features: { skillGraph: true } } }; } });
    const result = await server.handle('tools/call', { name: 'get_hub_capabilities', arguments: {} }) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ schemaVersion: 20 });
  });
});
