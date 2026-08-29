// tests/rest/memory-search.test.ts
//
// Normative test for the `searchMemories` and `getMemory` REST surfaces.
// Mirrors the helpers used by tests/rest/memory-blocks.test.ts: each test
// owns its own temp dir + SQLite DB + spawned launcher process so they
// cannot leak state into each other. Memory rows are seeded directly via
// the storage layer (a real `SqliteStore`) under the launcher's local
// actor scope (`usr_local`/`agt_local`); foreign-scope rows are seeded
// under a different actor to assert scope isolation.
//
// Each test owns its own temp dir + SQLite DB + spawned launcher
// process so they cannot leak state into each other.
//
// Coverage:
//
//   * GET /api/v1/memories/search
//       - returns visible FTS results (capped by `limit`)
//       - excludes forgotten / superseded / cross-scope rows
//       - 400 when `q` is missing, empty, or whitespace-only
//       - 400 when `limit` is 0, 101, or non-integer (1.5)
//   * GET /api/v1/memories/{id}
//       - returns the exact `id`, `content`, and current lifecycle
//       - 404 when the id does not exist
//       - 404 when the id exists only in a different scope
//   * route ordering: GET /api/v1/memories/search?q=... must answer
//     the search validator (q required), NOT the {id} get-by-id route
//     (which would silently treat "search" as a memory id and 404)

import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  createActorContext,
  type ActorContext,
  type Memory,
  type MemoryCreate,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { spawnRestLauncher, type LauncherHandle } from '../fixtures/rest-launcher';

const repoRoot = resolve(import.meta.dirname, '../..');
const bin = join(repoRoot, 'packages/rest/bin/agent-memory-rest.mjs');
const children: ChildProcess[] = [];
const tempRoots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});





async function shutdownLauncher(handle: LauncherHandle): Promise<void> {
  handle.child.kill('SIGTERM');
  const [code] = await once(handle.child, 'exit') as [number | null, NodeJS.Signals | null];
  expect(code).toBe(0);
}

/**
 * Local actor used by the launcher's `localMode` (loopback trust). All
 * seeded memories that should be visible to the launcher must use this
 * scope, or they will surface as cross-scope reads.
 */
function localActor(): ActorContext {
  return createActorContext({
    userId: 'usr_local',
    agentId: 'agt_local',
    role: 'admin',
    capabilities: ['read', 'write.memory', 'write.profile', 'admin'],
  });
}

/**
 * Foreign actor used to seed rows that must be invisible to the loopback
 * launcher. The launcher's local actor is always `usr_local`/`agt_local`,
 * so any row seeded under a different scope is a guaranteed cross-scope
 * read.
 */
function foreignActor(): ActorContext {
  return createActorContext({
    userId: 'usr_other',
    agentId: 'agt_other',
    role: 'admin',
    capabilities: ['read', 'write.memory', 'write.profile', 'admin'],
  });
}

/**
 * Seed memories directly into the storage layer. Every memory needs a
 * valid `sourceEventIds` entry, so each row creates its own event in
 * the same transaction. Because the storage layer's event/memory
 * repositories assert that the transaction actor matches the row's
 * scope, each row runs in its OWN transaction under its OWN actor —
 * mixing local and foreign rows in a single transaction is rejected
 * with `NOT_FOUND` at event-create time.
 */
function seedMemories(
  dbPath: string,
  rows: Array<{
    actor: ActorContext;
    kind?: MemoryCreate['kind'];
    scopeKey: string;
    content: Record<string, unknown>;
    lifecycle?: MemoryCreate['lifecycle'];
    reason?: string;
  }>,
): Memory[] {
  const store = new SqliteStore(dbPath);
  try {
    const seeded: Memory[] = [];
    for (const row of rows) {
      const memory = store.transaction(row.actor, (tx) => {
        const event = tx.events.create({
          kind: 'observation',
          scope: row.actor.scope,
          scopeKey: `evt_${row.scopeKey}`,
          payload: { text: row.content.text ?? '' },
          requestId: randomUUID(),
          provenance: { source: 'memory-search test seed' },
        });
        return tx.memories.create({
          kind: row.kind ?? 'fact',
          scope: row.actor.scope,
          scopeKey: row.scopeKey,
          content: row.content,
          sourceEventIds: [event.id],
          lifecycle: row.lifecycle,
          reason: row.reason ?? 'memory-search test seed',
          requestId: randomUUID(),
        });
      });
      seeded.push(memory);
    }
    return seeded;
  } finally {
    store.close();
  }
}
async function spawnLauncher(dbPath: string): Promise<LauncherHandle> {
  const handle = await spawnRestLauncher({ bin, repoRoot, dbPath, children });
  expect(handle.dbPath).toBe(dbPath);
  return handle;
}

describe('GET /api/v1/memories/search (real SQLite-backed launcher)', () => {
  it('returns visible FTS results and honors the limit query parameter', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-search-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');

    const actor = localActor();
    seedMemories(dbPath, [
      { actor, scopeKey: 'a', content: { text: 'alpha rocket launch' } },
      { actor, scopeKey: 'b', content: { text: 'beta rocket landing' } },
      { actor, scopeKey: 'c', content: { text: 'gamma rocket countdown' } },
      { actor, scopeKey: 'd', content: { text: 'delta quiet observation' } },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      // No limit: should match every "rocket" row (3). The launcher caps
      // at SEARCH_LIMIT_DEFAULT (20), which is more than enough.
      const all = await fetch(`${handle.url}/api/v1/memories/search?q=rocket`);
      expect(all.status).toBe(200);
      const allBody = await all.json() as { items: Memory[] };
      expect(allBody.items).toHaveLength(3);
      expect(allBody.items.every((m) => m.lifecycle === 'candidate')).toBe(true);
      // Bodies must round-trip verbatim — including the matched term.
      for (const item of allBody.items) {
        expect(String(item.content.text)).toMatch(/rocket/);
      }

      // limit=2: the launcher forwards a positive integer <= 100. The
      // exact ordering is determined by the FTS5 repository's rank;
      // we only assert the cap and that every returned row matches.
      const capped = await fetch(`${handle.url}/api/v1/memories/search?q=rocket&limit=2`);
      expect(capped.status).toBe(200);
      const cappedBody = await capped.json() as { items: Memory[] };
      expect(cappedBody.items).toHaveLength(2);
      for (const item of cappedBody.items) {
        expect(String(item.content.text)).toMatch(/rocket/);
      }
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('excludes forgotten, superseded, and cross-scope rows', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-search-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');

    const actor = localActor();
    const foreign = foreignActor();
    // Seed everything up front; mutate lifecycle / scope after the fact.
    seedMemories(dbPath, [
      { actor, scopeKey: 'visible', content: { text: 'visible aurora pattern' } },
      { actor, scopeKey: 'to_forget', content: { text: 'forget aurora tonight' } },
      { actor, scopeKey: 'to_supersede', content: { text: 'supersede aurora note' } },
      { actor: foreign, scopeKey: 'foreign', content: { text: 'foreign aurora report' } },
    ]);

    // Mark the second row forgotten and supersede the third with a
    // replacement whose content does NOT match the search term, so the
    // superseded row's content must not reappear in FTS results.
    const store = new SqliteStore(dbPath);
    try {
      const all = store.transaction(actor, (tx) => tx.memories.search(actor.scope, 'aurora'));
      expect(all).toHaveLength(3);
      const forgotten = all.find((m) => m.scopeKey === 'to_forget')!;
      const superseded = all.find((m) => m.scopeKey === 'to_supersede')!;
      store.transaction(actor, (tx) => tx.memories.forget(forgotten.id, 1, actor.scope, 'search-excludes test', 'r_forget'));
      store.transaction(actor, (tx) => tx.memories.supersede(
        superseded.id,
        {
          expectedVersion: 1,
          kind: 'fact',
          scope: actor.scope,
          scopeKey: 'replacement',
          content: { text: 'unrelated replacement body' },
          reason: 'search-excludes test',
          requestId: 'r_supersede',
        },
        actor.scope,
      ));
    } finally {
      store.close();
    }

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/memories/search?q=aurora`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: Memory[] };
      // Only the `visible` row survives: forgotten and superseded are
      // excluded by the FTS lifecycle predicate, cross-scope foreign
      // row is excluded by the storage layer's scope filter.
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.scopeKey).toBe('visible');
      expect(body.items[0]!.lifecycle).toBe('candidate');
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 400 when q is missing, empty, or whitespace-only', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-search-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    seedMemories(dbPath, [
      { actor: localActor(), scopeKey: 'x', content: { text: 'anything' } },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const missing = await fetch(`${handle.url}/api/v1/memories/search`);
      expect(missing.status).toBe(400);
      const missingBody = await missing.json() as { error: { code: string; message: string } };
      expect(missingBody.error.code).toBe('VALIDATION');
      expect(missingBody.error.message).toMatch(/q/i);

      const empty = await fetch(`${handle.url}/api/v1/memories/search?q=`);
      expect(empty.status).toBe(400);
      const emptyBody = await empty.json() as { error: { code: string; message: string } };
      expect(emptyBody.error.code).toBe('VALIDATION');

      const blank = await fetch(`${handle.url}/api/v1/memories/search?q=%20%20%20`);
      expect(blank.status).toBe(400);
      const blankBody = await blank.json() as { error: { code: string; message: string } };
      expect(blankBody.error.code).toBe('VALIDATION');
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 400 when limit is 0, above 100, or non-integer (1.5)', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-search-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    seedMemories(dbPath, [
      { actor: localActor(), scopeKey: 'x', content: { text: 'anything' } },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const zero = await fetch(`${handle.url}/api/v1/memories/search?q=anything&limit=0`);
      expect(zero.status).toBe(400);
      const zeroBody = await zero.json() as { error: { code: string; message: string } };
      expect(zeroBody.error.code).toBe('VALIDATION');
      expect(zeroBody.error.message).toMatch(/limit/i);

      const tooBig = await fetch(`${handle.url}/api/v1/memories/search?q=anything&limit=101`);
      expect(tooBig.status).toBe(400);
      const tooBigBody = await tooBig.json() as { error: { code: string; message: string } };
      expect(tooBigBody.error.code).toBe('VALIDATION');

      const floaty = await fetch(`${handle.url}/api/v1/memories/search?q=anything&limit=1.5`);
      expect(floaty.status).toBe(400);
      const floatyBody = await floaty.json() as { error: { code: string; message: string } };
      expect(floatyBody.error.code).toBe('VALIDATION');
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('GET /memories/search?q=... answers the search validator, not get-by-id (route ordering)', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-search-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    seedMemories(dbPath, [
      { actor: localActor(), scopeKey: 'x', content: { text: 'routing smoke test' } },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      // Missing q: if the `{id}` route shadowed `/memories/search`, the
      // launcher would treat "search" as an id and respond with 404
      // (NOT_FOUND). The literal `/memories/search` route MUST win,
      // and respond 400 (VALIDATION: query.q is required).
      const response = await fetch(`${handle.url}/api/v1/memories/search`);
      expect(response.status).toBe(400);
      const body = await response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('VALIDATION');
      expect(body.error.message).toMatch(/q/i);
    } finally {
      await shutdownLauncher(handle);
    }
  });
});

describe('GET /api/v1/memories/{id} (real SQLite-backed launcher)', () => {
  it('returns the exact id, content, and current lifecycle for an existing memory', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-search-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    const seeded = seedMemories(dbPath, [
      { actor: localActor(), scopeKey: 'round_trip', content: { text: 'get-by-id smoke test' } },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/memories/${seeded[0]!.id}`);
      expect(response.status).toBe(200);
      const body = await response.json() as Memory;
      // Identity is byte-exact.
      expect(body.id).toBe(seeded[0]!.id);
      // Content round-trips verbatim.
      expect(body.content).toEqual(seeded[0]!.content);
      // Lifecycle is the durable shape's current state.
      expect(body.lifecycle).toBe(seeded[0]!.lifecycle);
      expect(['candidate', 'active']).toContain(body.lifecycle);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 404 when the id does not exist in this scope', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-search-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    seedMemories(dbPath, [
      { actor: localActor(), scopeKey: 'x', content: { text: 'placeholder' } },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/memories/mem_does_not_exist`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string; status: number } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.status).toBe(404);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 404 when the id exists only in a different scope', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-search-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    const foreign = foreignActor();
    const seeded = seedMemories(dbPath, [
      { actor: foreign, scopeKey: 'foreign_only', content: { text: 'must not leak across scope' } },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/memories/${seeded[0]!.id}`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string; status: number } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.status).toBe(404);
    } finally {
      await shutdownLauncher(handle);
    }
  });
});