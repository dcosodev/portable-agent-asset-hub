// tests/storage-sqlite/catalog-source-identity.test.ts
//
// TDD slice for persisted catalog source identity.
//
// `catalog_sources` carries two identities: the surrogate `id` and the
// logical `UNIQUE(owner_user_id, scope_agent_id, kind, locator)` tuple
// declared in `0013_catalog.sql`. `addSource` writes with
// `INSERT OR IGNORE`, so a caller proposing a *different* id for an
// already-persisted logical tuple silently loses the write.
//
// Normative contracts exercised against a real temp `SqliteStore`:
//
//   * `addSource` returns the row that is actually persisted. When the
//     logical tuple already exists, the caller gets the stored id back,
//     never the discarded one.
//   * `link` therefore succeeds on a repeated apply instead of failing
//     with `404 source or entry not found`.
//   * `applyPreview` is idempotent across runs whose candidates resolve
//     to the same (kind, locator) under a different `rootId`.
//   * A changed fingerprint updates the persisted row in place, keeps
//     the id stable, and is auditable.
//   * Logical identity stays scoped: a different (user, agent) owns its
//     own row for the same kind/locator.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createActorContext, type ActorContext, type CatalogSource, type MutationMeta, type SyncPreview } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'catalog-source-identity-'));
  tempRoots.push(root);
  return join(root, 'agent-memory.sqlite');
}

function actorFor(userId: string, agentId: string): ActorContext {
  return createActorContext({ userId, agentId, role: 'admin', capabilities: ['read', 'write.memory', 'write.catalog', 'admin'] });
}

const meta = (): MutationMeta => ({ reason: 'catalog source identity test', requestId: randomUUID() });

function source(actor: ActorContext, overrides: Partial<CatalogSource>): CatalogSource {
  return { id: 'src_proposed', scope: actor.scope, kind: 'document', locator: 'docs/README.md', fingerprint: 'a'.repeat(64), createdAt: new Date().toISOString(), ...overrides };
}

function previewFor(actor: ActorContext, rootId: string, bytes: string, expectedVersion?: number): SyncPreview {
  return {
    id: `prv_${randomUUID().replace(/-/gu, '').slice(0, 24)}`,
    scope: actor.scope,
    profile: 'default',
    roots: [{ id: rootId, path: `/tmp/${rootId}` }],
    selectors: [],
    inputFingerprint: 'i'.repeat(64), rootsFingerprint: 'r'.repeat(64), catalogFingerprint: 'c'.repeat(64),
    profileFingerprint: 'p'.repeat(64), targetFingerprint: 't'.repeat(64), digest: 'd'.repeat(64),
    operations: [{ action: 'upsert', logicalKey: 'document:docs/README.md', candidate: { kind: 'document', relativePath: 'docs/README.md', locator: 'docs/README.md', bytes: Buffer.from(bytes), rootId }, expectedVersion }],
    diagnostics: [], complete: true, expiresAt: Date.now() + 60_000,
  };
}

describe('catalog source identity', () => {
  it('returns the persisted row when the logical tuple already exists', () => {
    const dbPath = freshDb();
    const actor = actorFor('usr_ident', 'agt_ident');
    const store = new SqliteStore(dbPath);
    try {
      const first = store.transaction(actor, (tx) => tx.catalog.addSource(source(actor, { id: 'src_first' }), meta()));
      const second = store.transaction(actor, (tx) => tx.catalog.addSource(source(actor, { id: 'src_second' }), meta()));
      expect(first.id).toBe('src_first');
      expect(second.id).toBe('src_first');
      expect(store.transaction(actor, (tx) => tx.catalog.listSources(actor.scope))).toHaveLength(1);
    } finally { store.close(); }
  });

  it('links against the returned source on a repeated add', () => {
    const dbPath = freshDb();
    const actor = actorFor('usr_link', 'agt_link');
    const store = new SqliteStore(dbPath);
    try {
      const entry = store.transaction(actor, (tx) => tx.catalog.upsert({ id: 'cat_link', scope: actor.scope, logicalKey: 'document:docs/README.md', kind: 'document', name: 'README', summary: undefined, lifecycle: 'active', currentVersion: 1, metadata: {} }, undefined, meta()));
      store.transaction(actor, (tx) => tx.catalog.addSource(source(actor, { id: 'src_persisted' }), meta()));
      const repeated = store.transaction(actor, (tx) => tx.catalog.addSource(source(actor, { id: 'src_discarded' }), meta()));
      expect(() => store.transaction(actor, (tx) => tx.catalog.link(entry.id, repeated.id, actor.scope, meta()))).not.toThrow();
      const raw = new DatabaseSync(dbPath);
      try {
        const links = raw.prepare('SELECT source_id FROM catalog_entry_sources WHERE entry_id=?').all(entry.id) as Array<{ source_id: string }>;
        expect(links.map((link) => link.source_id)).toEqual(['src_persisted']);
      } finally { raw.close(); }
    } finally { store.close(); }
  });

  it('applies the same content twice under different root ids without orphan links', () => {
    const dbPath = freshDb();
    const actor = actorFor('usr_apply', 'agt_apply');
    const store = new SqliteStore(dbPath);
    try {
      store.transaction(actor, (tx) => { tx.catalog.applyPreview(previewFor(actor, 'docs-a', '# hi'), meta()); });
      expect(() => store.transaction(actor, (tx) => { tx.catalog.applyPreview(previewFor(actor, 'docs-b', '# hi', 1), meta()); })).not.toThrow();
      const stats = store.transaction(actor, (tx) => tx.catalog.stats(actor.scope));
      expect(stats.entries).toBe(1);
      expect(stats.sources).toBe(1);
      expect(stats.links).toBe(1);
    } finally { store.close(); }
  });

  it('updates the fingerprint in place and keeps the id stable', () => {
    const dbPath = freshDb();
    const actor = actorFor('usr_finger', 'agt_finger');
    const store = new SqliteStore(dbPath);
    try {
      store.transaction(actor, (tx) => tx.catalog.addSource(source(actor, { id: 'src_stable', fingerprint: 'a'.repeat(64) }), meta()));
      const updated = store.transaction(actor, (tx) => tx.catalog.addSource(source(actor, { id: 'src_other', fingerprint: 'b'.repeat(64) }), meta()));
      expect(updated.id).toBe('src_stable');
      expect(updated.fingerprint).toBe('b'.repeat(64));
      const persisted = store.transaction(actor, (tx) => tx.catalog.listSources(actor.scope));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.fingerprint).toBe('b'.repeat(64));
      const actions = store.transaction(actor, (tx) => tx.audit.list(actor.scope)).map((record) => record.action);
      expect(actions).toContain('catalog.source.refingerprinted');
    } finally { store.close(); }
  });

  it('keeps logical identity scoped to the owning user and agent', () => {
    const dbPath = freshDb();
    const mine = actorFor('usr_mine', 'agt_mine');
    const theirs = actorFor('usr_theirs', 'agt_theirs');
    const store = new SqliteStore(dbPath);
    try {
      const a = store.transaction(mine, (tx) => tx.catalog.addSource(source(mine, { id: 'src_mine' }), meta()));
      const b = store.transaction(theirs, (tx) => tx.catalog.addSource(source(theirs, { id: 'src_theirs' }), meta()));
      expect(a.id).toBe('src_mine');
      expect(b.id).toBe('src_theirs');
      expect(store.transaction(mine, (tx) => tx.catalog.listSources(mine.scope))).toHaveLength(1);
      expect(store.transaction(theirs, (tx) => tx.catalog.listSources(theirs.scope))).toHaveLength(1);
    } finally { store.close(); }
  });
});
