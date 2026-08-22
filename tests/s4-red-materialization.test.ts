import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProfileService, createActorContext, type AuditRepository, type Profile } from '@portable-agent-asset-hub/core';
import { FileMaterializer } from '@portable-agent-asset-hub/storage-files';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const actor = createActorContext({ userId: 'usr_files', agentId: 'agt_files', role: 'user', capabilities: [] });
const profile: Profile = {
  id: 'prf_files',
  scope: actor.scope,
  version: 1,
  blocks: [{ blockId: 'user', ordinal: 1, kind: 'USER', body: 'stable' }],
};
const mutation = (reason: string) => ({ reason, requestId: `req-${reason}` });

describe('S4 adversarial filesystem materialization', () => {
  it('rejects traversal and every symlink segment including root and target', () => {
    const root = mkdtempSync(join(tmpdir(), 's4-red-root-'));
    const outside = mkdtempSync(join(tmpdir(), 's4-red-out-'));
    try {
      mkdirSync(join(root, 'nested'));
      symlinkSync(outside, join(root, 'nested', 'link'));
      expect(() => new FileMaterializer(root).materialize('nested/link/file.md', { bytes: Buffer.from('x\n'), digest: '0'.repeat(64) })).toThrow();
      expect(() => new FileMaterializer(root).read('../outside')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('restores prior bytes and rolls back DB plus audit after a post-write audit failure', () => {
    const root = mkdtempSync(join(tmpdir(), 's4-red-rollback-'));
    const target = join(root, 'profile.md');
    writeFileSync(target, 'prior\n');
    const store = new SqliteStore(':memory:');
    try {
      new ProfileService(store, actor).create(profile, mutation('create'));
      const materializer = new FileMaterializer(root, {
        afterWrite: (transaction) => {
          (transaction.audit as AuditRepository & { failNextAppendForTest(): void }).failNextAppendForTest();
        },
      });
      expect(() => materializer.materializeProfile(
        store, actor, profile.id, 'profile.md', mutation('materialize'),
      )).toThrow();
      expect(readFileSync(target, 'utf8')).toBe('prior\n');
      expect(store.transaction(actor, (tx) => tx.materializations.list(profile.id, actor.scope))).toEqual([]);
      expect(store.transaction(actor, (tx) => tx.audit.list(actor.scope).map((event) => event.action))).toEqual(['profile.create']);
      expect([...readFileSync(target)]).toEqual([...Buffer.from('prior\n')]);
      expect(existsSync(join(root, 'profile.md.tmp-fixed'))).toBe(false);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
