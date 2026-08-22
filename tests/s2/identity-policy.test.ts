import { describe, expect, it } from 'vitest';
import {
  HubError,
  authorize,
  createActorContextFromAuthenticated,
  type Capability,
} from '@portable-agent-asset-hub/core';

describe('S2 identity and policy nominal/adversarial contract', () => {
  it('agent_without_owner_is_rejected', async () => {
    const { SqliteStore } = await import('@portable-agent-asset-hub/storage-sqlite');
    const store = new SqliteStore(':memory:');
    const actor = createActorContextFromAuthenticated({ userId: 'usr_runtime', agentId: 'agt_runtime', role: 'agent', capabilities: [] });
    try {
      expect(() => store.transaction(actor, (tx) => tx.identities.createAgent({ ownerUserId: 'usr_missing', name: 'agent' }))).toThrow(HubError);
    } finally {
      store.close();
    }
  });

  it('admin_denied_by_default', () => {
    expect(() => authorize({ role: 'admin' }, 'admin.doctor')).toThrowError(/disabled by default/);
  });

  it('actor_context_is_server_derived_and_request_payload_cannot_override_it', () => {
    const authenticated = { userId: 'usr_real', agentId: 'agt_real', role: 'user' as const, capabilities: ['read'] as readonly Capability[] };
    const context = createActorContextFromAuthenticated(authenticated, {
      actor: 'usr_attacker', scope: { ownerUserId: 'usr_attacker', agentId: 'agt_attacker' }, role: 'admin', capabilities: ['admin.doctor'],
    });
    expect(context.userId).toBe('usr_real');
    expect(context.scope).toEqual({ ownerUserId: 'usr_real', agentId: 'agt_real' });
    expect(context.role).toBe('user');
    expect(context.capabilities).toEqual(['read']);
  });

  it('explicit_admin_policy_must_be_governed', () => {
    expect(() => authorize({ role: 'admin', capabilities: ['admin.doctor'], adminPolicy: { allow: false } }, 'admin.doctor')).toThrow(HubError);
    expect(() => authorize({ role: 'admin', capabilities: ['admin.doctor'], adminPolicy: { allow: true } }, 'admin.doctor')).not.toThrow();
  });
});
