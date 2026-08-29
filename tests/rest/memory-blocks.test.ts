// tests/rest/memory-blocks.test.ts
//
// Normative test for the `listMemoryBlocks` REST surface. Exercises the
// real durable launcher binary against a temp SQLite store, seeds a
// profile with both USER and MEMORY blocks via `tx.profiles.create`,
// then asserts:
//
//   * 200 + filtered items for a valid MEMORY-bearing profile
//   * 400 when `profileId` is absent or empty (no storage read happens)
//   * 404 when the profile exists for a different scope (scope
//     isolation: the launcher's actor scope is `{usr_local, agt_local}`)
//   * 200 + empty items when the profile contains no MEMORY blocks
//
// Each test owns its own temp dir + SQLite DB + spawned launcher
// process so they cannot leak state into each other.

import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  createActorContext,
  type Profile,
  type ProfileBlock,
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
 * Seed a real profile directly via the storage layer using the local
 * actor's scope. The launcher only authenticates the loopback local
 * actor (`usr_local` / `agt_local`), so the profile must be scoped to
 * that actor to be readable from the launcher.
 */
function seedProfile(dbPath: string, profileId: string, blocks: ProfileBlock[]): void {
  const actor = createActorContext({
    userId: 'usr_local',
    agentId: 'agt_local',
    role: 'admin',
    capabilities: ['read', 'write.memory', 'write.profile', 'admin'],
  });
  const profile: Profile = {
    id: profileId,
    scope: actor.scope,
    version: 1,
    blocks,
  };
  const store = new SqliteStore(dbPath);
  try {
    store.transaction(actor, (tx) => {
      tx.profiles.create(profile, { reason: 'memory-blocks test seed', requestId: randomUUID() });
    });
  } finally {
    store.close();
  }
}
async function spawnLauncher(dbPath: string): Promise<LauncherHandle> {
  const handle = await spawnRestLauncher({ bin, repoRoot, dbPath, children });
  expect(handle.dbPath).toBe(dbPath);
  return handle;
}

describe('GET /api/v1/memory-blocks (real SQLite-backed launcher)', () => {
  it('returns only MEMORY blocks for the requested profile in canonical order', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-blocks-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    // Intentionally scrambled ordinals so we can verify the launcher
    // returns blocks in canonical `(ordinal, blockId)` order rather
    // than insertion order. The first USER block carries the highest
    // ordinal, the last MEMORY block carries the lowest ordinal — the
    // MEMORY set, sorted canonically, must come back as `notes` then
    // `facts`, then `summary`, NOT as the insertion order.
    const blocks: ProfileBlock[] = [
      { blockId: 'persona', ordinal: 100, kind: 'USER', body: 'You are a careful assistant.' },
      { blockId: 'facts', ordinal: 5, kind: 'MEMORY', body: 'second memory' },
      { blockId: 'personality', ordinal: 50, kind: 'USER', body: 'Tone: precise.' },
      { blockId: 'summary', ordinal: 1, kind: 'MEMORY', body: 'first memory' },
      { blockId: 'notes', ordinal: 3, kind: 'MEMORY', body: 'third memory' },
    ];
    seedProfile(dbPath, 'prf_blocks_e2e', blocks);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/memory-blocks?profileId=prf_blocks_e2e`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: ProfileBlock[] };
      // USER blocks must be filtered out, MEMORY blocks returned.
      expect(body.items).toHaveLength(3);
      expect(body.items.every((b) => b.kind === 'MEMORY')).toBe(true);
      // Canonical ordering: ordinal ascending, blockId ascending as tiebreaker.
      // summary(1) → notes(3) → facts(5).
      expect(body.items.map((b) => b.blockId)).toEqual(['summary', 'notes', 'facts']);
      expect(body.items.map((b) => b.body)).toEqual(['first memory', 'third memory', 'second memory']);
      // Bodies must round-trip verbatim.
      expect(body.items[0]).toEqual({ blockId: 'summary', ordinal: 1, kind: 'MEMORY', body: 'first memory' });
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 400 when profileId is missing, empty, or whitespace-only', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-blocks-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    seedProfile(dbPath, 'prf_blocks_400', [
      { blockId: 'only_user', ordinal: 1, kind: 'USER', body: 'no memory blocks here' },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      // Missing query param entirely.
      const missing = await fetch(`${handle.url}/api/v1/memory-blocks`);
      expect(missing.status).toBe(400);
      const missingBody = await missing.json() as { error: { code: string; message: string } };
      expect(missingBody.error.code).toBe('VALIDATION');
      expect(missingBody.error.message).toMatch(/profileId/i);

      // Empty string query value.
      const empty = await fetch(`${handle.url}/api/v1/memory-blocks?profileId=`);
      expect(empty.status).toBe(400);
      const emptyBody = await empty.json() as { error: { code: string; message: string } };
      expect(emptyBody.error.code).toBe('VALIDATION');

      // Whitespace-only query value.
      const blank = await fetch(`${handle.url}/api/v1/memory-blocks?profileId=%20%20%20`);
      expect(blank.status).toBe(400);
      const blankBody = await blank.json() as { error: { code: string; message: string } };
      expect(blankBody.error.code).toBe('VALIDATION');
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 404 when the requested profileId does not exist in this scope', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-blocks-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    seedProfile(dbPath, 'prf_blocks_existing', [
      { blockId: 'remembered', ordinal: 1, kind: 'MEMORY', body: 'should not be returned' },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/memory-blocks?profileId=prf_blocks_missing`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string; status: number } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.status).toBe(404);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 404 when the requested profileId exists only in a different scope', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-blocks-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');

    // Seed a profile under a non-local scope so it lives in the same
    // SQLite file but is invisible to the loopback launcher's actor
    // (which is always `usr_local`/`agt_local`). The launcher must
    // surface this as 404 — it must NEVER fabricate rows.
    const foreignActor = createActorContext({
      userId: 'usr_other',
      agentId: 'agt_other',
      role: 'admin',
      capabilities: ['read', 'write.profile'],
    });
    const store = new SqliteStore(dbPath);
    try {
      store.transaction(foreignActor, (tx) => {
        tx.profiles.create(
          {
            id: 'prf_blocks_other_scope',
            scope: foreignActor.scope,
            version: 1,
            blocks: [{ blockId: 'secret', ordinal: 1, kind: 'MEMORY', body: 'leak?' }],
          },
          { reason: 'scope-isolation test seed', requestId: randomUUID() },
        );
      });
    } finally {
      store.close();
    }

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/memory-blocks?profileId=prf_blocks_other_scope`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string; status: number } };
      expect(body.error.code).toBe('NOT_FOUND');

      // The local profile (none seeded) is also 404 — confirms there
      // is no fabricated empty-list fallback for unknown profiles.
      const localMissing = await fetch(`${handle.url}/api/v1/memory-blocks?profileId=prf_blocks_does_not_exist`);
      expect(localMissing.status).toBe(404);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 200 with items=[] for a profile that has only USER blocks (empty MEMORY set)', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-memory-blocks-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    seedProfile(dbPath, 'prf_blocks_user_only', [
      { blockId: 'persona', ordinal: 1, kind: 'USER', body: 'no memory blocks here' },
      { blockId: 'preferences', ordinal: 2, kind: 'USER', body: 'prefers terse answers' },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/memory-blocks?profileId=prf_blocks_user_only`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: unknown[] };
      expect(body.items).toEqual([]);
    } finally {
      await shutdownLauncher(handle);
    }
  });
});
