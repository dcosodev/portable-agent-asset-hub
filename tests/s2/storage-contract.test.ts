import { describe, expect, it } from 'vitest';
import { createActorContextFromAuthenticated, HubError } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const actor = createActorContextFromAuthenticated({
  userId: 'usr_runtime',
  agentId: 'agt_runtime',
  role: 'agent',
  capabilities: ['identity.write', 'binding.write'],
});

function withStore<T>(fn: (store: SqliteStore) => T): T {
  const store = new SqliteStore(':memory:');
  try { return fn(store); } finally { store.close(); }
}

describe('S2 storage scope, binding, audit, idempotency contract', () => {
  it('binding_cannot_cross_user_scope_and_out_of_scope_is_404', () => withStore((store) => {
    const created = store.transaction(actor, (tx) => {
      const user = tx.identities.createUser({ displayName: 'owner' });
      const other = tx.identities.createUser({ displayName: 'other' });
      const agent = tx.identities.createAgent({ ownerUserId: user.id, name: 'agent' });
      const harness = tx.identities.createHarness({ name: 'h', runtime: 'node' });
      const binding = tx.bindings.create({ assetId: 'asset', scope: { ownerUserId: user.id, agentId: agent.id }, harnessId: harness.id });
      return { binding, other, agent };
    });
    expect(() => store.transaction(actor, (tx) => tx.bindings.getOrThrow(created.binding.id, { ownerUserId: created.other.id, agentId: created.agent.id }))).toThrowError(new HubError('NOT_FOUND', 'resource not found', 404));
  }));

  it('binding_versions_have_single_head_and_compare_and_swap', () => withStore((store) => {
    const data = store.transaction(actor, (tx) => {
      const user = tx.identities.createUser({ displayName: 'owner' });
      const agent = tx.identities.createAgent({ ownerUserId: user.id, name: 'agent' });
      const harness = tx.identities.createHarness({ name: 'h', runtime: 'node' });
      return { scope: { ownerUserId: user.id, agentId: agent.id }, harness };
    });
    const first = store.transaction(actor, (tx) => tx.bindings.create({ assetId: 'asset', scope: data.scope, harnessId: data.harness.id, expectedVersion: 0 }));
    expect(() => store.transaction(actor, (tx) => tx.bindings.create({ assetId: 'asset', scope: data.scope, harnessId: data.harness.id, expectedVersion: 0 }))).toThrow(HubError);
    const second = store.transaction(actor, (tx) => tx.bindings.create({ assetId: 'asset', scope: data.scope, harnessId: data.harness.id, expectedVersion: first.version }));
    expect(second.version).toBe(2);
  }));

  it('successful_mutations_append_audit_events_with_runtime_actor', () => withStore((store) => {
    const result = store.transaction(actor, (tx) => {
      const user = tx.identities.createUser({ displayName: 'owner' });
      const agent = tx.identities.createAgent({ ownerUserId: user.id, name: 'agent' });
      const harness = tx.identities.createHarness({ name: 'h', runtime: 'node' });
      const binding = tx.bindings.create({ assetId: 'asset', scope: { ownerUserId: user.id, agentId: agent.id }, harnessId: harness.id });
      return { events: tx.audit.list(), binding };
    });
    expect(result.events.map((event) => event.action)).toEqual([
      'identity.user.create',
      'identity.agent.create',
      'identity.harness.create',
      'binding.create',
    ]);
    expect(result.events.every((event) => event.actor.userId === actor.userId && event.actor.agentId === actor.agentId)).toBe(true);
    expect(result.events.at(-1)?.target).toBe(result.binding.id);
  }));

  it('mutation_and_audit_are_atomic_on_audit_failure', () => withStore((store) => {
    expect(() => store.transaction(actor, (tx) => {
      const user = tx.identities.createUser({ displayName: 'owner' });
      tx.audit.failNextAppendForTest();
      tx.identities.createAgent({ ownerUserId: user.id, name: 'must rollback' });
    })).toThrow(HubError);
    const { counts } = store.diagnostics();
    expect(counts).toMatchObject({ users: 0, agents: 0, audit: 0 });
  }));

  it('idempotency_replay_is_noop_and_digest_conflict_is_structured', () => withStore((store) => {
    let calls = 0;
    const input = { actorId: actor.userId, operation: 'create', key: 'k', digest: 'd' };
    const first = store.idempotent(actor, input, (tx) => {
      calls += 1;
      return tx.identities.createUser({ displayName: 'one' });
    });
    const replay = store.idempotent(actor, input, () => { calls += 1; return null; });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(calls).toBe(1);
    const events = store.transaction(actor, (tx) => tx.audit.list());
    expect(events.map((event) => event.action)).toEqual(['identity.user.create', 'idempotency.complete']);
    expect(() => store.idempotent(actor, { ...input, digest: 'different' }, () => null)).toThrow(HubError);
  }));
});
