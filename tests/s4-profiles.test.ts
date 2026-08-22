import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HubError,
  ProfileService,
  createActorContext,
  materializeProfile,
  type Profile,
  type ProfileBlock,
} from '@portable-agent-asset-hub/core';
import { FileMaterializer } from '@portable-agent-asset-hub/storage-files';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const actor = createActorContext({ userId: 'usr_s4', agentId: 'agt_s4', role: 'user', capabilities: [] });
const blocks: ProfileBlock[] = [
  { blockId: 'b', ordinal: 2, kind: 'MEMORY', body: 'second' },
  { blockId: 'a', ordinal: 1, kind: 'USER', body: 'first' },
];
const profile = (): Profile => ({ id: 'prf_s4', scope: actor.scope, version: 1, blocks });
const mutation = (reason: string) => ({ reason, requestId: `req-${reason}` });
const errorCode = (operation: () => unknown): string | undefined => {
  try { operation(); } catch (error) { return error instanceof HubError ? error.code : undefined; }
  return undefined;
};

describe('S4 profiles', () => {
  it('profile_scope_requires_user_and_agent', () => {
    const store = new SqliteStore(':memory:');
    try {
      const service = new ProfileService(store, actor);
      service.create(profile(), mutation('create'));
      expect(errorCode(() => service.get('prf_s4', { ownerUserId: 'usr_other', agentId: 'agt_other' }))).toBe('NOT_FOUND');
      expect(errorCode(() => service.create({ ...profile(), id: 'prf_other', scope: { ownerUserId: '', agentId: '' } }, mutation('bad')))).toBe('VALIDATION');
    } finally { store.close(); }
  });

  it('profile_update_requires_expected_version', () => {
    const store = new SqliteStore(':memory:');
    try {
      const service = new ProfileService(store, actor);
      service.create(profile(), mutation('create'));
      expect(errorCode(() => service.update('prf_s4', { version: 0, blocks }, mutation('stale')))).toBe('CONFLICT');
      expect(service.update('prf_s4', { version: 1, blocks }, mutation('update')).version).toBe(2);
    } finally { store.close(); }
  });

  it('profile_versions_are_immutable', () => {
    const store = new SqliteStore(':memory:');
    try {
      const service = new ProfileService(store, actor);
      service.create(profile(), mutation('create'));
      service.update('prf_s4', { version: 1, blocks: [{ ...blocks[0], body: 'changed' }] }, mutation('update'));
      const history = service.history('prf_s4');
      expect(history.map((item) => item.version)).toEqual([1, 2]);
      expect(history[0].blocks).toEqual([...blocks].sort((a, b) => a.ordinal - b.ordinal || a.blockId.localeCompare(b.blockId)));
    } finally { store.close(); }
  });

  it('materialization_is_byte_and_hash_deterministic', () => {
    const first = materializeProfile(profile());
    const second = materializeProfile({ ...profile(), blocks: [...blocks].reverse() });
    expect(first.bytes).toEqual(second.bytes);
    expect(first.digest).toBe(createHash('sha256').update(first.bytes).digest('hex'));
    expect(first.bytes[0]).not.toBe(0xef);
    expect(first.bytes.toString('utf8')).not.toContain('\r');
    expect(first.bytes.toString('utf8')).toMatch(/[^\n]\n$/u);
    expect(materializeProfile({ ...profile(), blocks: [] }).bytes.toString('utf8')).toBe('---\n');
  });

  it('import_preview_does_not_mutate', () => {
    const store = new SqliteStore(':memory:');
    try {
      const service = new ProfileService(store, actor);
      service.create(profile(), mutation('create'));
      const before = service.get('prf_s4');
      const targetDigest = materializeProfile(before).digest;
      const preview = service.previewImport('prf_s4', '---\n', targetDigest, mutation('preview'));
      expect(preview.targetDigest).toBe(targetDigest);
      expect(service.get('prf_s4')).toEqual(before);
    } finally { store.close(); }
  });

  it('import_apply_requires_exact_digest', () => {
    const store = new SqliteStore(':memory:');
    try {
      const service = new ProfileService(store, actor);
      service.create(profile(), mutation('create'));
      const targetDigest = materializeProfile(service.get('prf_s4')).digest;
      const preview = service.previewImport('prf_s4', '---\n', targetDigest, mutation('preview'));
      expect(errorCode(() => service.applyImport(preview.id, '0'.repeat(64), targetDigest, mutation('apply')))).toBe('CONFLICT');
      expect(service.applyImport(preview.id, preview.digest, targetDigest, mutation('apply')).version).toBe(2);
      expect(errorCode(() => service.applyImport(preview.id, preview.digest, targetDigest, mutation('replay')))).toBe('CONFLICT');
    } finally { store.close(); }
  });

  it('import_apply_rejects_target_drift', () => {
    const store = new SqliteStore(':memory:');
    try {
      const service = new ProfileService(store, actor);
      service.create(profile(), mutation('create'));
      const targetDigest = materializeProfile(service.get('prf_s4')).digest;
      const preview = service.previewImport('prf_s4', '---\n', targetDigest, mutation('preview'));
      expect(errorCode(() => service.applyImport(preview.id, preview.digest, 'f'.repeat(64), mutation('drift')))).toBe('CONFLICT');
      service.update('prf_s4', { version: 1, blocks }, mutation('profile-drift'));
      expect(errorCode(() => service.applyImport(preview.id, preview.digest, targetDigest, mutation('apply')))).toBe('CONFLICT');
    } finally { store.close(); }
  });

  it('filesystem_failure_rolls_back_db_audit_and_files', () => {
    const root = mkdtempSync(join(tmpdir(), 's4-files-'));
    const target = join(root, 'profile.md');
    writeFileSync(target, 'prior\n');
    const store = new SqliteStore(':memory:');
    try {
      const service = new ProfileService(store, actor);
      service.create(profile(), mutation('create'));
      const files = new FileMaterializer(root, { write: () => { throw new Error('injected'); } });
      expect(() => files.materializeProfile(store, actor, 'prf_s4', 'profile.md', mutation('materialize'))).toThrow();
      expect(readFileSync(target, 'utf8')).toBe('prior\n');
      expect(store.transaction(actor, (tx) => tx.materializations.list('prf_s4', actor.scope))).toEqual([]);
      expect(store.transaction(actor, (tx) => tx.audit.list(actor.scope).map((event) => event.action))).toEqual(['profile.create']);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
