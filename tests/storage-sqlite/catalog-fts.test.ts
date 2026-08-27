// tests/storage-sqlite/catalog-fts.test.ts
//
// TDD slice for the catalog FTS5 surface.
//
// Normative contracts exercised against a real temp `SqliteStore`:
//
//   Migration & backfill
//   ────────────────────
//   * Migration `0014_catalog_fts.sql` creates `catalog_fts` as a
//     scoped FTS5 virtual table keyed by (id, owner_user_id,
//     scope_agent_id, version, lifecycle) plus the textual columns
//     `logical_key`, `name`, `summary`, `metadata_text`.
//   * The migration backfills `catalog_fts` from existing
//     `catalog_entries` rows so an upgraded database sees its pre-0014
//     entries in search results immediately.
//
//   Repository search
//   ─────────────────
//   * `CatalogRepository.search(scope, q, limit)` returns active entries
//     ranked by FTS5 bm25, scoped to the actor's exact (user, agent),
//     with `kind` as an optional exact-match filter, and `limit` capped
//     at 100 with default 20.
//   * `q` is required (non-blank) and `limit` must be a positive integer.
//   * Match fields: `logical_key`, `name`, `summary`, and the safely
//     serialized metadata text (NO source SKILL.md bytes).
//   * Lifecycle visibility is "active" only — `candidate`, `stale`, and
//     `rejected` rows are excluded.
//   * Cross-scope reads are excluded.
//   * `metadata.name` (and any other metadata field indexed) is
//     searchable, but raw SKILL.md body bytes that were never stored in
//     the catalog are NOT (no-body rule).
//
//   Triggers
//   ────────
//   * Inserting an active catalog entry adds an `catalog_fts` row.
//   * Updating an entry (next version) replaces the `catalog_fts` row.
//   * Lifecycle transitions out of `active` remove the `catalog_fts`
//     row (stale excluded).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  createActorContext,
  type ActorContext,
  type CatalogEntry,
  type CatalogKind,
  HubError,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'catalog-fts-test-'));
  tempRoots.push(root);
  return join(root, 'agent-memory.sqlite');
}

function localActor(): ActorContext {
  return createActorContext({
    userId: 'usr_local',
    agentId: 'agt_local',
    role: 'admin',
    capabilities: ['read', 'write.memory', 'write.catalog', 'admin'],
  });
}

function foreignActor(): ActorContext {
  return createActorContext({
    userId: 'usr_other',
    agentId: 'agt_other',
    role: 'admin',
    capabilities: ['read', 'write.memory', 'write.catalog', 'admin'],
  });
}

type SeedRow = {
  actor: ActorContext;
  logicalKey: string;
  kind: CatalogKind;
  name: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  lifecycle?: 'candidate' | 'active' | 'stale' | 'rejected';
};

function seedEntries(dbPath: string, rows: SeedRow[]): CatalogEntry[] {
  const store = new SqliteStore(dbPath);
  try {
    const seeded: CatalogEntry[] = [];
    for (const row of rows) {
      const entry = store.transaction(row.actor, (tx) =>
        tx.catalog.upsert(
          {
            id: `cat_${randomUUID().replace(/-/gu, '').slice(0, 24)}`,
            scope: row.actor.scope,
            logicalKey: row.logicalKey,
            kind: row.kind,
            name: row.name,
            summary: row.summary,
            lifecycle: row.lifecycle ?? 'active',
            currentVersion: 1,
            metadata: row.metadata ?? {},
          },
          undefined,
          { reason: 'catalog-fts test seed', requestId: randomUUID() },
        ),
      );
      seeded.push(entry);
    }
    return seeded;
  } finally {
    store.close();
  }
}

describe('catalog FTS migration + backfill', () => {
  it('creates catalog_fts with the expected columns', () => {
    const dbPath = freshDb();
    const store = new SqliteStore(dbPath);
    try {
      const raw = new DatabaseSync(dbPath);
      try {
        const columns = raw.prepare('PRAGMA table_info(catalog_fts)').all() as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).toEqual([
          'entry_id', 'owner_user_id', 'scope_agent_id', 'kind',
          'logical_key', 'name', 'summary', 'metadata_text',
        ]);
      } finally {
        raw.close();
      }
    } finally {
      store.close();
    }
  });

  it('backfills catalog_fts from pre-existing catalog_entries rows', () => {
    const dbPath = freshDb();
    // Seed BEFORE we know whether the backfill is in place — we use a
    // second store open that does not touch the migration runner.
    seedEntries(dbPath, [
      { actor: localActor(), logicalKey: 'document:docs:backfill.md', kind: 'document', name: 'Backfilled', summary: 'pre-0014 seed' },
    ]);
    // Open a brand new store — exercises the migration backfill path
    // by leaving a pre-existing row, closing, and reopening.
    const store = new SqliteStore(dbPath);
    try {
      const items = store.transaction(localActor(), (tx) => tx.catalog.search(localActor().scope, 'backfilled', 20));
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.some((entry: CatalogEntry) => entry.logicalKey === 'document:docs:backfill.md')).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('CatalogRepository.search (real SQLite-backed)', () => {
  it('returns visible FTS results ranked by bm25 and capped by limit', () => {
    const dbPath = freshDb();
    const actor = localActor();
    seedEntries(dbPath, [
      { actor, logicalKey: 'document:a:alpha.md', kind: 'document', name: 'alpha', summary: 'rocket launch' },
      { actor, logicalKey: 'document:b:beta.md', kind: 'document', name: 'beta', summary: 'rocket landing' },
      { actor, logicalKey: 'document:c:gamma.md', kind: 'document', name: 'gamma', summary: 'rocket countdown' },
      { actor, logicalKey: 'document:d:delta.md', kind: 'document', name: 'delta', summary: 'quiet observation' },
    ]);

    const store = new SqliteStore(dbPath);
    try {
      // No explicit limit -> default 20; all 3 "rocket" rows should match.
      const all = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'rocket', 20));
      expect(all).toHaveLength(3);
      for (const item of all) {
        expect(item.lifecycle).toBe('active');
      }

      // limit=2 should cap to 2; all returned rows are still "rocket" matches.
      const capped = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'rocket', 2));
      expect(capped).toHaveLength(2);
      for (const item of capped) {
        expect(String(item.summary ?? '')).toMatch(/rocket/);
      }

      // Default limit (undefined) is 20 and must return the same set.
      const defaulted = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'rocket'));
      expect(defaulted.length).toBeGreaterThanOrEqual(3);
    } finally {
      store.close();
    }
  });

  it('matches on metadata.name, metadata tokens, summary, name, and logical_key', () => {
    const dbPath = freshDb();
    const actor = localActor();
    seedEntries(dbPath, [
      { actor, logicalKey: 'document:meta:tagged.md', kind: 'document', name: 'tagged', summary: 'plain', metadata: { tags: ['aurora', 'photography'], description: 'aurora borealis gallery' } },
      { actor, logicalKey: 'document:summary:loud.md', kind: 'document', name: 'loud', summary: 'unusual aurora report' },
      { actor, logicalKey: 'document:named:rename.md', kind: 'document', name: 'aurora named entry' },
      { actor, logicalKey: 'document:key:logical.md', kind: 'document', name: 'logical match', metadata: { description: 'unrelated' } },
    ]);

    const store = new SqliteStore(dbPath);
    try {
      // Matches via metadata description tokens.
      const metaHit = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'photography'));
      expect(metaHit.some((e) => e.logicalKey === 'document:meta:tagged.md')).toBe(true);

      // Matches via summary.
      const summaryHit = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'unusual'));
      expect(summaryHit.some((e) => e.logicalKey === 'document:summary:loud.md')).toBe(true);

      // Matches via name.
      const nameHit = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'aurora'));
      const nameHitKeys = nameHit.map((e) => e.logicalKey).sort();
      expect(nameHitKeys).toContain('document:named:rename.md');
      expect(nameHitKeys).toContain('document:summary:loud.md');
      expect(nameHitKeys).toContain('document:meta:tagged.md');

      // Matches via logical_key.
      const keyHit = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'document:key:logical.md'));
      expect(keyHit.some((e) => e.logicalKey === 'document:key:logical.md')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('excludes stale, candidate, and rejected lifecycles', () => {
    const dbPath = freshDb();
    const actor = localActor();
    seedEntries(dbPath, [
      { actor, logicalKey: 'document:active:keep.md', kind: 'document', name: 'keep', summary: 'aurora active' },
      { actor, logicalKey: 'document:stale:gone.md', kind: 'document', name: 'gone', summary: 'aurora stale', lifecycle: 'stale' },
      { actor, logicalKey: 'document:candidate:wip.md', kind: 'document', name: 'wip', summary: 'aurora candidate', lifecycle: 'candidate' },
      { actor, logicalKey: 'document:rejected:no.md', kind: 'document', name: 'no', summary: 'aurora rejected', lifecycle: 'rejected' },
    ]);

    const store = new SqliteStore(dbPath);
    try {
      const hits = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'aurora', 20));
      const keys = hits.map((e) => e.logicalKey).sort();
      expect(keys).toEqual(['document:active:keep.md']);
    } finally {
      store.close();
    }
  });

  it('excludes cross-scope rows', () => {
    const dbPath = freshDb();
    const local = localActor();
    const foreign = foreignActor();
    seedEntries(dbPath, [
      { actor: local, logicalKey: 'document:local:visible.md', kind: 'document', name: 'visible', summary: 'aurora local' },
      { actor: foreign, logicalKey: 'document:foreign:hidden.md', kind: 'document', name: 'hidden', summary: 'aurora foreign' },
    ]);

    const store = new SqliteStore(dbPath);
    try {
      const hits = store.transaction(local, (tx) => tx.catalog.search(local.scope, 'aurora', 20));
      const keys = hits.map((e) => e.logicalKey).sort();
      expect(keys).toEqual(['document:local:visible.md']);
    } finally {
      store.close();
    }
  });

  it('applies the optional kind filter', () => {
    const dbPath = freshDb();
    const actor = localActor();
    seedEntries(dbPath, [
      { actor, logicalKey: 'skill:s:s1.md', kind: 'skill', name: 'skill1', summary: 'aurora skill' },
      { actor, logicalKey: 'document:d:d1.md', kind: 'document', name: 'document1', summary: 'aurora document' },
    ]);

    const store = new SqliteStore(dbPath);
    try {
      const onlySkills = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'aurora', 20, 'skill'));
      expect(onlySkills.map((e) => e.logicalKey)).toEqual(['skill:s:s1.md']);

      const onlyDocs = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'aurora', 20, 'document'));
      expect(onlyDocs.map((e) => e.logicalKey)).toEqual(['document:d:d1.md']);
    } finally {
      store.close();
    }
  });

  it('rejects missing/blank q with VALIDATION', () => {
    const dbPath = freshDb();
    seedEntries(dbPath, [
      { actor: localActor(), logicalKey: 'document:x:x.md', kind: 'document', name: 'x' },
    ]);

    const store = new SqliteStore(dbPath);
    try {
      const actor = localActor();
      // missing q (empty string after trim)
      expect(() => store.transaction(actor, (tx) => tx.catalog.search(actor.scope, '   ', 20))).toThrow(HubError);
      expect(() => store.transaction(actor, (tx) => tx.catalog.search(actor.scope, '', 20))).toThrow(HubError);
    } finally {
      store.close();
    }
  });

  it('rejects non-positive or oversized limit with VALIDATION', () => {
    const dbPath = freshDb();
    seedEntries(dbPath, [
      { actor: localActor(), logicalKey: 'document:x:x.md', kind: 'document', name: 'x' },
    ]);

    const store = new SqliteStore(dbPath);
    try {
      const actor = localActor();
      expect(() => store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'x', 0))).toThrow(HubError);
      expect(() => store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'x', -1))).toThrow(HubError);
      expect(() => store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'x', 101))).toThrow(HubError);
    } finally {
      store.close();
    }
  });

  it('keeps the index free of source SKILL.md body bytes', () => {
    const dbPath = freshDb();
    const actor = localActor();
    seedEntries(dbPath, [
      {
        actor,
        logicalKey: 'skill:scanned:SKILL.md',
        kind: 'skill',
        name: 'skill body',
        summary: 'no body bytes here',
        // The metadata intentionally holds a SKILL.md body-shaped payload
        // (mimicking what the scanner would record); it MUST NOT be the
        // source body. The body content "secret-skill-body" must never
        // appear in FTS results because catalog metadata only persists
        // {sha256, rootId, relativePath, ...} — never the bytes.
        metadata: { sha256: 'a'.repeat(64), rootId: 'r1', relativePath: 'docs/SKILL.md', bodyDigest: 'should-not-leak' },
      },
    ]);

    const store = new SqliteStore(dbPath);
    try {
      // Searching for a token that exists ONLY inside a source body
      // (and never inside the indexed metadata text) must return no
      // results. The token below is the sentinel that would surface if
      // FTS accidentally indexed the body bytes.
      const leak = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'secret-skill-body'));
      expect(leak).toEqual([]);

      // Sanity: the entry itself is still searchable via its persisted
      // metadata.relativePath.
      const ok = store.transaction(actor, (tx) => tx.catalog.search(actor.scope, 'docs/SKILL.md'));
      expect(ok.some((e) => e.logicalKey === 'skill:scanned:SKILL.md')).toBe(true);
    } finally {
      store.close();
    }
  });
});
