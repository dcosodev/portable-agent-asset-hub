import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { candidatesFrom, createActorContext, ProfileService } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { CatalogSyncCoordinator, FileSyncMarker } from '@portable-agent-asset-hub/storage-files';

const actor = createActorContext({ userId: 'usr_s5_coord', agentId: 'agt_s5_coord', role: 'user', capabilities: [] });
const meta = (name: string) => ({ reason: `s5 ${name}`, requestId: `req_${name}` });
const candidate = (bytes = 'catalog') => candidatesFrom([{
  kind: 'document', rootId: 'docs', relativePath: 'catalog.md', locator: 'catalog.md',
  bytes: Buffer.from(bytes), metadata: { name: 'catalog' },
}]);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's5-coordinator-'));
  const store = new SqliteStore(join(dir, 'hub.sqlite'));
  new ProfileService(store, actor).create({
    id: 'prf_coord', scope: actor.scope, version: 1,
    blocks: [{ blockId: 'user', ordinal: 1, kind: 'USER', body: 'coordinator' }],
  }, meta('profile'));
  const marker = new FileSyncMarker(dir, 'catalog.marker');
  return { dir, store, marker };
}

describe('S5 external coordinator and real marker', () => {
  it('binds actor/profile, publishes a real marker, and replays without mutation', () => {
    const { dir, store, marker } = setup();
    try {
      const coordinator = new CatalogSyncCoordinator({ storage: store, actor, scanner: candidate(), marker });
      const preview = coordinator.preview({ profileId: 'prf_coord', roots: [{ id: 'docs', path: '/logical/docs' }] }, meta('preview'));
      coordinator.review(preview.id, preview.digest, meta('review'));
      coordinator.apply(preview.id, preview.digest, meta('apply'));
      const firstBytes = marker.read();
      const first = store.transaction(actor, (tx) => ({ entries: tx.catalog.list(actor.scope), stats: tx.catalog.stats(actor.scope), audit: tx.audit.list(actor.scope) }));
      coordinator.apply(preview.id, preview.digest, meta('replay'));
      const second = store.transaction(actor, (tx) => ({ entries: tx.catalog.list(actor.scope), stats: tx.catalog.stats(actor.scope), audit: tx.audit.list(actor.scope) }));
      expect(first.entries).toHaveLength(1);
      expect(first.stats).toEqual({ entries: 1, versions: 1, sources: 1, links: 1, relations: 0 });
      expect(firstBytes.toString()).toBe(preview.digest);
      expect(second.entries).toEqual(first.entries);
      expect(second.stats).toEqual(first.stats);
      expect(second.audit).toEqual(first.audit);
      expect(marker.read()).toEqual(firstBytes);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('restores exact real marker and DB state after post-publication failure', () => {
    const { dir, store, marker } = setup();
    writeFileSync(join(dir, 'catalog.marker'), 'prior-marker');
    const before = marker.snapshot();
    try {
      const coordinator = new CatalogSyncCoordinator({
        storage: store, actor, scanner: candidate(), marker,
        afterMarker: () => { throw new Error('audit append failure'); },
      });
      const preview = coordinator.preview({ profileId: 'prf_coord', roots: [{ id: 'docs', path: '/logical/docs' }] }, meta('preview-fail'));
      coordinator.review(preview.id, preview.digest, meta('review-fail'));
      expect(() => coordinator.apply(preview.id, preview.digest, meta('apply-fail'))).toThrow('audit append failure');
      const after = store.transaction(actor, (tx) => ({
        entries: tx.catalog.list(actor.scope), stats: tx.catalog.stats(actor.scope), audit: tx.audit.list(actor.scope),
        saved: tx.catalogSync.getPreview(preview.id, actor.scope),
      }));
      expect(after.entries).toHaveLength(0);
      expect(after.stats).toEqual({ entries: 0, versions: 0, sources: 0, links: 0, relations: 0 });
      expect(after.saved.appliedAt).toBeUndefined();
      expect(after.audit.filter((event) => event.target === preview.id && event.action === 'catalog.preview.applied')).toHaveLength(0);
      expect(marker.snapshot()).toEqual(before);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects marker target drift after review before DB mutation', () => {
    const { dir, store, marker } = setup();
    try {
      const coordinator = new CatalogSyncCoordinator({ storage: store, actor, scanner: candidate(), marker });
      const preview = coordinator.preview({ profileId: 'prf_coord', roots: [{ id: 'docs', path: '/logical/docs' }] }, meta('preview-drift'));
      coordinator.review(preview.id, preview.digest, meta('review-drift'));
      marker.write(Buffer.from('changed-out-of-band'));
      expect(() => coordinator.apply(preview.id, preview.digest, meta('apply-drift'))).toThrow(/drift/i);
      expect(store.transaction(actor, (tx) => tx.catalog.list(actor.scope))).toHaveLength(0);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
