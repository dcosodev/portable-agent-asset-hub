import { describe, expect, it } from 'vitest';
import {
  ProfileService,
  createActorContext,
  materializeProfile,
  type Profile,
  type StorageTransaction,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const actor = createActorContext({ userId: 'usr_red', agentId: 'agt_red', role: 'user', capabilities: [] });
const profile = (): Profile => ({ id: 'prf_red', scope: actor.scope, version: 1, blocks: [] });
const mutation = (reason: string) => ({ reason, requestId: `req-${reason}` });

describe('S4 adversarial transactional profile contracts', () => {
  it('binds repositories to the actor transaction lifetime', () => {
    const store = new SqliteStore(':memory:');
    try {
      expect('profileRepository' in store).toBe(false);
      let leaked!: StorageTransaction;
      store.transaction(actor, (transaction) => { leaked = transaction; });
      expect(() => leaked.profiles.get('prf_missing', actor.scope)).toThrow(/expired/u);
      expect(() => leaked.materializations.list('prf_missing', actor.scope)).toThrow(/expired/u);
    } finally { store.close(); }
  });

  it('uses server-derived scope and requires mutation metadata', () => {
    const store = new SqliteStore(':memory:');
    try {
      const service = new ProfileService(store, actor);
      service.create(profile(), mutation('create'));
      expect(() => store.transaction(actor, (tx) =>
        (tx.profiles.create as unknown as (value: Profile) => Profile)({ ...profile(), id: 'prf_no_meta' }))).toThrow();
      expect(store.transaction(actor, (tx) => tx.audit.list(actor.scope).map((event) => event.action))).toEqual(['profile.create']);
    } finally { store.close(); }
  });

  it('applies persisted previews once with exact semantic audit', () => {
    const store = new SqliteStore(':memory:');
    try {
      const service = new ProfileService(store, actor);
      service.create(profile(), mutation('create'));
      const targetDigest = materializeProfile(service.get('prf_red')).digest;
      const preview = service.previewImport('prf_red', '---\n', targetDigest, mutation('preview'));
      expect(service.applyImport(preview.id, preview.digest, targetDigest, mutation('apply')).version).toBe(2);
      expect(() => service.applyImport(preview.id, preview.digest, targetDigest, mutation('replay'))).toThrow();
      expect(store.transaction(actor, (tx) => tx.audit.list(actor.scope).map((event) => event.action))).toEqual([
        'profile.create', 'profile.import.preview', 'profile.import.apply',
      ]);
    } finally { store.close(); }
  });

  it('restores immutable snapshots with one semantic audit event', () => {
    const store = new SqliteStore(':memory:');
    try {
      const service = new ProfileService(store, actor);
      service.create(profile(), mutation('create'));
      service.update('prf_red', {
        version: 1,
        blocks: [{ blockId: 'x', ordinal: 1, kind: 'USER', body: 'x' }],
      }, mutation('update'));
      const restored = service.restore('prf_red', 1, 2, mutation('restore'));
      expect(restored).toMatchObject({ version: 3, blocks: [] });
      expect(store.transaction(actor, (tx) => tx.audit.list(actor.scope).map((event) => event.action))).toEqual([
        'profile.create', 'profile.update', 'profile.restore',
      ]);
    } finally { store.close(); }
  });
});
