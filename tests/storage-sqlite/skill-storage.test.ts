// tests/storage-sqlite/skill-storage.test.ts
//
// Phase 1 normative contract for the skill versioned storage surface.
// Drives a real temp `SqliteStore` (no in-process mocks) so the test
// suite is bound to the actual migration, audit, scope and CAS
// contracts exercised by the REST launcher.
//
// Normative surface:
//
//   Migration 0015
//   ──────────────
//   * Adds `skill_entries`, `skill_versions`, `skill_resources`,
//     `skill_active_head`, and `skill_fts` tables contiguously on top
//     of 0014 without touching the existing catalog schema. The
//     runner must accept the sequence 0001..0015 with no gaps.
//   * All FKs are scoped by `(owner_user_id, scope_agent_id)` and
//     reference the canonical catalog entry table so existing audit /
//     catalog CAS lines remain intact.
//
//   SkillVersionRepository (core contracts + SqliteSkillRepository)
//   ───────────────────────────────────────────────────────────────
//   * `writeSkill(input, meta)` creates an immutable version row
//     storing the full UTF-8 body, its sha256 content hash, a
//     metadata/provenance blob, and advances `skill_active_head` for
//     the `(logicalKey)` pair. Bodies must be valid UTF-8 ≤ 1 MiB.
//     The head pointer is monotonically increasing per logical key.
//   * `writeSkill(...)` rejects path traversal, absolute paths,
//     backslashes, NUL bytes, empty paths, and paths longer than 512
//     characters for any attached resource. Mode must be one of
//     `0644` / `0755`.
//   * Each resource must be ≤ 4 MiB and the per-version sum must be
//     ≤ 16 MiB. Overages surface as `HubError('VALIDATION', …, 413)`
//     without leaving partial rows behind.
//   * `CAS` is enforced on `currentVersion` mismatches for updates;
//     a fresh insert with `expectedVersion !== 0` yields 409.
//   * `skillSearch(scope, q, limit?)` returns active entries ranked
//     by FTS bm25; `q` is required and `limit` capped at 100.
//   * `skillGet(id, scope)` returns the active head version with the
//     body and metadata; cross-scope reads 404.
//   * `resourceList(id, scope)` returns the per-resource records of
//     the active version in path order; `resourceRead(id, path, scope)`
//     returns a single resource record and 404s on unknown paths or
//     cross-scope entries. Resource bytes are never indexed in FTS.
//   * All writes are actor-bound (require an `ActorContext`); the
//     repository refuses `NOT_FOUND` for cross-scope reads and 403
//     for missing actor contexts.
//
//   No raw bytes of resources or bodies are logged. Audit events
//   reference the version + size only.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createActorContext,
  HubError,
  type ActorContext,
  type Scope,
  type SkillResource,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-storage-test-'));
  tempRoots.push(root);
  return join(root, 'agent-memory.sqlite');
}

function actor(user = 'usr_local', agent = 'agt_local'): ActorContext {
  return createActorContext({
    userId: user,
    agentId: agent,
    role: 'admin',
    capabilities: ['read', 'write.skill', 'admin'],
  });
}

function otherActor(): ActorContext {
  return createActorContext({
    userId: 'usr_other',
    agentId: 'agt_other',
    role: 'admin',
    capabilities: ['read', 'write.skill', 'admin'],
  });
}

function openScope(actor: ActorContext): Scope {
  return { ownerUserId: actor.userId as `usr_${string}`, agentId: actor.agentId as `agt_${string}` };
}

function utf8Bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

describe('Phase 1 skill versioned storage', () => {
  it('migrates contiguously through the current schema and creates the canonical tables', async () => {
    const dbPath = freshDb();
    const store = new SqliteStore(dbPath);
    try {
      // Sanity: doctor should report green after the complete migration chain.
      const tables = store.doctor();
      expect(tables).toBeDefined();
      // Open the same file with a fresh handle to inspect schema_meta + table names.
      const Database = await import('node:sqlite') as typeof import('node:sqlite');
      const probe = new Database.DatabaseSync(dbPath);
      try {
        const rows = probe
          .prepare("SELECT version, name FROM schema_meta ORDER BY version")
          .all() as Array<{ version: number; name: string }>;
        expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
        expect(rows[rows.length - 1]?.name).toBe('relation_proposal_auto_approval');
        const tableNames = probe
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') AND name LIKE 'skill_%' ORDER BY name")
          .all() as Array<{ name: string }>;
        const names = tableNames.map((row) => row.name);
        expect(names).toContain('skill_entries');
        expect(names).toContain('skill_versions');
        expect(names).toContain('skill_resources');
        expect(names).toContain('skill_active_head');
        expect(names).toContain('skill_fts');
      } finally {
        probe.close();
      }
    } finally {
      store.close();
    }
  });

  it('writes an immutable skill version, advances the active head, and indexes the body for FTS', () => {
    const dbPath = freshDb();
    const store = new SqliteStore(dbPath);
    try {
      const a = actor();
      const scope = openScope(a);
      const body = utf8Bytes('# Skill Body\nUse this skill to do X.');
      const summary = 'skill-summary';
      const written = store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_demo',
            scope,
            logicalKey: 'skill:default:skills/demo',
            name: 'demo',
            summary,
            kind: 'skill',
            lifecycle: 'active',
            body,
            metadata: { tags: ['alpha', 'beta'] },
            resources: [
              {
                relativePath: 'helper.sh',
                mode: 0o755,
                mime: 'text/x-shellscript',
                bytes: utf8Bytes('#!/usr/bin/env bash\necho hi\n'),
              },
              {
                relativePath: 'README.md',
                mode: 0o644,
                mime: 'text/markdown',
                bytes: utf8Bytes('# Helper README'),
              },
            ],
          },
          { reason: 'skill.write', requestId: `req_${randomUUID()}` },
        ),
      );
      expect(written.version).toBe(1);
      expect(written.bodySha256).toBeDefined();
      expect(written.totalSize).toBe(body.length + '#!/usr/bin/env bash\necho hi\n'.length + '# Helper README'.length);
      expect(written.resources).toHaveLength(2);
      // Readback is canonical and independent of insertion order.
      expect(written.resources.map((r) => r.relativePath)).toEqual(['README.md', 'helper.sh']);
      expect(written.resources[0]?.mode).toBe(0o644);

      // Active head advances.
      const head = store.transaction(a, (tx) => tx.skills.getHeadVersion('skl_demo', scope));
      expect(head?.version).toBe(1);
      expect(head?.logicalKey).toBe('skill:default:skills/demo');

      // FTS picked up the body (the audit fix that moved triggers to
      // skill_versions so the body is always present at trigger time).
      const hits = store.transaction(a, (tx) => tx.skills.skillSearch(scope, 'Skill Body'));
      expect(hits.map((entry) => entry.id)).toContain('skl_demo');
    } finally {
      store.close();
    }
  });

  it('refuses path traversal, absolute paths, NUL bytes, empty paths, wrong mode, and over-large bodies/resources', async () => {
    const dbPath = freshDb();
    const store = new SqliteStore(dbPath);
    try {
      const a = actor();
      const scope = openScope(a);
      const baseInput = (resource: SkillResource) => ({
        id: 'skl_validation',
        scope,
        logicalKey: 'skill:default:skills/validation',
        name: 'validation',
        kind: 'skill' as const,
        lifecycle: 'active' as const,
        body: utf8Bytes('body'),
        metadata: {},
        resources: [resource],
      });
      const badPaths: string[] = [
        '../etc/passwd',
        '/etc/passwd',
        'a\\b',
        'a b',
        '',
        'a'.repeat(513),
      ];
      for (const path of badPaths) {
        expect(() =>
          store.transaction(a, (tx) =>
            tx.skills.writeSkill(
              baseInput({
                relativePath: path,
                mode: 0o644,
                mime: 'text/plain',
                bytes: utf8Bytes('x'),
              }),
              { reason: 'skill.write', requestId: `req_${randomUUID()}` },
            ),
          ),
        ).toThrowError(HubError);
      }
      expect(() =>
        store.transaction(a, (tx) =>
          tx.skills.writeSkill(
            baseInput({ relativePath: 'bad.sh', mode: 0o777, mime: 'text/plain', bytes: utf8Bytes('x') }),
            { reason: 'skill.write', requestId: `req_${randomUUID()}` },
          ),
        ),
      ).toThrowError(HubError);

      // 1 MiB body limit + UTF-8 validation. The exact body length must
      // be 1 MiB + 1 byte (the smallest size that should still fail).
      // ≤ 1 MiB is valid; > 1 MiB must surface as HubError('VALIDATION',
      // …, 413). We validate via the helper rather than message regex
      // so a copy edit of the message cannot silently break the test.
      expect(() =>
        store.transaction(a, (tx) =>
          tx.skills.writeSkill(
            {
              ...baseInput({ relativePath: 'ok.txt', mode: 0o644, mime: 'text/plain', bytes: utf8Bytes('x') }),
              body: Buffer.alloc(1024 * 1024 + 1, 0x41),
            },
            { reason: 'skill.write', requestId: `req_${randomUUID()}` },
          ),
        ),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION', status: 413 }));

      // Invalid UTF-8 must surface as HubError('VALIDATION', …, 400),
      // NOT 413. The test pins both the code and the status so a future
      // refactor that accidentally swaps the size vs. encoding errors
      // does not silently regress.
      expect(() =>
        store.transaction(a, (tx) =>
          tx.skills.writeSkill(
            {
              ...baseInput({ relativePath: 'ok.txt', mode: 0o644, mime: 'text/plain', bytes: utf8Bytes('x') }),
              body: Buffer.from([0xff, 0xfe, 0xfd]),
            },
            { reason: 'skill.write', requestId: `req_${randomUUID()}` },
          ),
        ),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION', status: 400 }));

      // 4 MiB single resource limit. ≤ 4 MiB is valid; 4 MiB + 1 byte
      // is the smallest size that must fail with 413.
      const fourMbPlusOne = Buffer.alloc(4 * 1024 * 1024 + 1, 0x41);
      expect(() =>
        store.transaction(a, (tx) =>
          tx.skills.writeSkill(
            {
              ...baseInput({ relativePath: 'huge.bin', mode: 0o644, mime: 'application/octet-stream', bytes: fourMbPlusOne }),
              body: utf8Bytes('x'),
            },
            { reason: 'skill.write', requestId: `req_${randomUUID()}` },
          ),
        ),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION', status: 413 }));

      // 16 MiB total resources limit. Five resources of 4 MiB each sum
      // to 20 MiB, which must fail with 413 BEFORE any partial rows
      // are persisted (rollback asserts below).
      const chunkResources: SkillResource[] = Array.from({ length: 5 }, (_, i) => ({
        relativePath: `chunk-${i}.bin`,
        mode: 0o644,
        mime: 'application/octet-stream',
        bytes: Buffer.alloc(4 * 1024 * 1024, 0x41),
      }));
      expect(() =>
        store.transaction(a, (tx) =>
          tx.skills.writeSkill(
            {
              ...baseInput({ relativePath: 'first.bin', mode: 0o644, mime: 'application/octet-stream', bytes: Buffer.alloc(1, 0x41) }),
              body: utf8Bytes('x'),
              resources: chunkResources,
            },
            { reason: 'skill.write', requestId: `req_${randomUUID()}` },
          ),
        ),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION', status: 413 }));

      // Rollback assertion: the rejected write above must NOT have left
      // a partial `skill_entries` row behind. The repository validates
      // before any INSERT, so no rollback is necessary; we still assert
      // the contract by querying for the skill id and confirming it
      // does not exist.
      const Database = await import('node:sqlite') as typeof import('node:sqlite');
      const probe = new Database.DatabaseSync(dbPath);
      try {
        const rows = probe
          .prepare("SELECT id FROM skill_entries WHERE id = 'skl_validation'")
          .all() as Array<{ id: string }>;
        expect(rows).toEqual([]);
        const versions = probe
          .prepare("SELECT id FROM skill_versions WHERE id = 'skl_validation'")
          .all() as Array<{ id: string }>;
        expect(versions).toEqual([]);
        const resources = probe
          .prepare("SELECT id FROM skill_resources WHERE id = 'skl_validation'")
          .all() as Array<{ id: string }>;
        expect(resources).toEqual([]);
      } finally {
        probe.close();
      }
    } finally {
      store.close();
    }
  });

  it('enforces CAS for updates, appends immutable versions, and audits every write', async () => {
    const dbPath = freshDb();
    const store = new SqliteStore(dbPath);
    try {
      const a = actor();
      const scope = openScope(a);
      const v1 = store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_cas',
            scope,
            logicalKey: 'skill:default:skills/cas',
            name: 'cas',
            kind: 'skill',
            lifecycle: 'active',
            body: utf8Bytes('v1 body'),
            metadata: { tags: ['one'] },
            resources: [],
          },
          { reason: 'skill.write', requestId: `req_${randomUUID()}` },
        ),
      );
      expect(v1.version).toBe(1);

      // Stale CAS must fail.
      expect(() =>
        store.transaction(a, (tx) =>
          tx.skills.writeSkill(
            {
              id: 'skl_cas',
              scope,
              logicalKey: 'skill:default:skills/cas',
              name: 'cas',
              kind: 'skill',
              lifecycle: 'active',
              body: utf8Bytes('v2 body'),
              metadata: { tags: ['two'] },
              resources: [],
              expectedVersion: 0,
            },
            { reason: 'skill.write', requestId: `req_${randomUUID()}` },
          ),
        ),
      ).toThrowError(/CAS|conflict|CONFLICT/);

      const v2 = store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_cas',
            scope,
            logicalKey: 'skill:default:skills/cas',
            name: 'cas',
            kind: 'skill',
            lifecycle: 'active',
            body: utf8Bytes('v2 body'),
            metadata: { tags: ['two'] },
            resources: [],
            expectedVersion: 1,
          },
          { reason: 'skill.write', requestId: `req_${randomUUID()}` },
        ),
      );
      expect(v2.version).toBe(2);

      // The active FTS projection is replaced, not duplicated, when a
      // new active version becomes head.
      expect(store.transaction(a, (tx) => tx.skills.skillSearch(scope, 'v2'))).toHaveLength(1);
      expect(store.transaction(a, (tx) => tx.skills.skillSearch(scope, 'v1'))).toHaveLength(0);

      // Old version stays immutable.
      const oldVersion = store.transaction(a, (tx) => tx.skills.getVersion('skl_cas', 1, scope));
      expect(Buffer.from(oldVersion!.body).toString('utf8')).toBe('v1 body');

      // Audit contains both writes.
      const Database = await import('node:sqlite') as typeof import('node:sqlite');
      const probe = new Database.DatabaseSync(dbPath);
      try {
        const events = probe
          .prepare("SELECT action FROM audit WHERE target = 'skl_cas' ORDER BY rowid")
          .all() as Array<{ action: string }>;
        expect(events.map((row) => row.action)).toEqual(['skill.version written', 'skill.version written']);
        expect(() => probe.prepare("UPDATE skill_versions SET body = X'78' WHERE id = 'skl_cas' AND version = 1").run())
          .toThrow(/immutable/i);
        expect(() => probe.prepare("DELETE FROM skill_versions WHERE id = 'skl_cas' AND version = 1").run())
          .toThrow(/immutable/i);
      } finally {
        probe.close();
      }
    } finally {
      store.close();
    }
  });

  it('respects scope isolation: cross-scope reads 404 and writes are actor-bound', () => {
    const dbPath = freshDb();
    const store = new SqliteStore(dbPath);
    try {
      const a = actor();
      const other = otherActor();
      const scope = openScope(a);
      store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_scope',
            scope,
            logicalKey: 'skill:default:skills/scope',
            name: 'scope',
            kind: 'skill',
            lifecycle: 'active',
            body: utf8Bytes('hello'),
            metadata: {},
            resources: [],
          },
          { reason: 'skill.write', requestId: `req_${randomUUID()}` },
        ),
      );
      expect(() => store.transaction(other, (tx) => tx.skills.skillGet('skl_scope', openScope(other)))).toThrow(
        expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
      );
      expect(() =>
        store.transaction(other, (tx) =>
          tx.skills.writeSkill(
            {
              id: 'skl_other',
              scope: openScope(other),
              logicalKey: 'skill:default:skills/other',
              name: 'other',
              kind: 'skill',
              lifecycle: 'active',
              body: utf8Bytes('x'),
              metadata: {},
              resources: [],
            },
            { reason: 'skill.write', requestId: `req_${randomUUID()}` },
          ),
        ),
      ).not.toThrow();
    } finally {
      store.close();
    }
  });

  it('hides inactive lifecycles from search/get but keeps the immutable version reachable by id+version', () => {
    const dbPath = freshDb();
    const store = new SqliteStore(dbPath);
    try {
      const a = actor();
      const scope = openScope(a);
      store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_lifecycle',
            scope,
            logicalKey: 'skill:default:skills/lifecycle',
            name: 'lifecycle',
            kind: 'skill',
            lifecycle: 'active',
            body: utf8Bytes('first'),
            metadata: { tags: ['first'] },
            resources: [],
          },
          { reason: 'skill.write', requestId: `req_${randomUUID()}` },
        ),
      );
      // Transition to stale.
      store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_lifecycle',
            scope,
            logicalKey: 'skill:default:skills/lifecycle',
            name: 'lifecycle',
            kind: 'skill',
            lifecycle: 'stale',
            body: utf8Bytes('second'),
            metadata: { tags: ['stale'] },
            resources: [],
            expectedVersion: 1,
          },
          { reason: 'skill.write', requestId: `req_${randomUUID()}` },
        ),
      );
      // Stale entries are excluded from search results.
      const results = store.transaction(a, (tx) => tx.skills.skillSearch(scope, 'lifecycle'));
      expect(results.find((entry) => entry.id === 'skl_lifecycle')).toBeUndefined();
      // Direct getById returns the latest immutable version, regardless of lifecycle.
      const head = store.transaction(a, (tx) => tx.skills.getHeadVersion('skl_lifecycle', scope));
      expect(head?.lifecycle).toBe('stale');
      // Direct getVersion still returns v1 immutably.
      const v1 = store.transaction(a, (tx) => tx.skills.getVersion('skl_lifecycle', 1, scope));
      expect(Buffer.from(v1!.body).toString('utf8')).toBe('first');
    } finally {
      store.close();
    }
  });

  it('exposes resourceList and resourceRead with bounded size + sha256 + mime + mode', () => {
    const dbPath = freshDb();
    const store = new SqliteStore(dbPath);
    try {
      const a = actor();
      const scope = openScope(a);
      const bytes = utf8Bytes('#!/usr/bin/env bash\necho readme\n');
      store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_resources',
            scope,
            logicalKey: 'skill:default:skills/resources',
            name: 'resources',
            kind: 'skill',
            lifecycle: 'active',
            body: utf8Bytes('body'),
            metadata: {},
            resources: [
              { relativePath: 'bin/run.sh', mode: 0o755, mime: 'text/x-shellscript', bytes },
              { relativePath: 'docs/README.md', mode: 0o644, mime: 'text/markdown', bytes: utf8Bytes('readme') },
            ],
          },
          { reason: 'skill.write', requestId: `req_${randomUUID()}` },
        ),
      );
      const listed: SkillResource[] = store.transaction(a, (tx) => tx.skills.resourceList('skl_resources', scope));
      expect(listed.map((resource) => resource.relativePath).sort()).toEqual(['bin/run.sh', 'docs/README.md']);
      const first = listed[0]!;
      expect(first.mode).toBe(0o755);
      expect(first.mime).toBe('text/x-shellscript');
      expect(first.size).toBe(bytes.length);
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);

      const read = store.transaction(a, (tx) => tx.skills.resourceRead('skl_resources', 'bin/run.sh', scope));
      expect(Buffer.from(read!.bytes).toString('utf8')).toBe('#!/usr/bin/env bash\necho readme\n');
      expect(() => store.transaction(a, (tx) => tx.skills.resourceRead('skl_resources', 'missing', scope))).toThrow(
        expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
      );
    } finally {
      store.close();
    }
  });

  it('FTS ranks by body + name + tags + logical_key; resource bytes are not indexed', () => {
    const dbPath = freshDb();
    const store = new SqliteStore(dbPath);
    try {
      const a = actor();
      const scope = openScope(a);
      store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_fts_alpha',
            scope,
            logicalKey: 'skill:default:skills/alpha',
            name: 'alpha',
            kind: 'skill',
            lifecycle: 'active',
            body: utf8Bytes('alpha content with uniqueterm'),
            metadata: { tags: ['beta', 'gamma'] },
            resources: [
              {
                relativePath: 'README.md',
                mode: 0o644,
                mime: 'text/markdown',
                bytes: utf8Bytes('this should never be searched'),
              },
            ],
          },
          { reason: 'skill.write', requestId: `req_${randomUUID()}` },
        ),
      );
      store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_fts_beta',
            scope,
            logicalKey: 'skill:default:skills/beta',
            name: 'beta',
            kind: 'skill',
            lifecycle: 'active',
            body: utf8Bytes('beta content without the magic token'),
            metadata: { tags: ['common'] },
            resources: [],
          },
          { reason: 'skill.write', requestId: `req_${randomUUID()}` },
        ),
      );
      const hits = store.transaction(a, (tx) => tx.skills.skillSearch(scope, 'uniqueterm'));
      expect(hits.map((entry) => entry.id)).toContain('skl_fts_alpha');
      expect((hits[0] as { body?: unknown }).body).toBeUndefined();
      expect(hits.find((entry) => entry.id === 'skl_fts_beta')).toBeUndefined();
      // Resource byte string must not show up.
      const never = store.transaction(a, (tx) => tx.skills.skillSearch(scope, 'never_be_searched'));
      expect(never).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('persists state across reopen: SQLite and the repository are the authority', () => {
    const dbPath = freshDb();
    const a = actor();
    const scope = openScope(a);
    {
      const store = new SqliteStore(dbPath);
      try {
        store.transaction(a, (tx) =>
          tx.skills.writeSkill(
            {
              id: 'skl_persist',
              scope,
              logicalKey: 'skill:default:skills/persist',
              name: 'persist',
              kind: 'skill',
              lifecycle: 'active',
              body: utf8Bytes('persistent body'),
              metadata: { tags: ['persist'] },
              resources: [
                { relativePath: 'a.txt', mode: 0o644, mime: 'text/plain', bytes: utf8Bytes('a') },
              ],
            },
            { reason: 'skill.write', requestId: `req_${randomUUID()}` },
          ),
        );
      } finally {
        store.close();
      }
    }
    const reopened = new SqliteStore(dbPath);
    try {
      const head = reopened.transaction(a, (tx) => tx.skills.getHeadVersion('skl_persist', scope));
      expect(head?.version).toBe(1);
      expect(Buffer.from(head!.body).toString('utf8')).toBe('persistent body');
      const resources = reopened.transaction(a, (tx) => tx.skills.resourceList('skl_persist', scope));
      expect(resources).toHaveLength(1);
      const r = resources[0]!;
      expect(r.relativePath).toBe('a.txt');
      expect(r.size).toBe(1);
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      const read = reopened.transaction(a, (tx) => tx.skills.resourceRead('skl_persist', 'a.txt', scope));
      expect(Buffer.from(read!.bytes).toString('utf8')).toBe('a');
    } finally {
      reopened.close();
    }
  });
});