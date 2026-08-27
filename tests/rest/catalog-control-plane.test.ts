// tests/rest/catalog-control-plane.test.ts
//
// Normative test for the catalog control plane REST surfaces wired by
// the launcher: `getCatalog`, `previewCatalogSync`, and
// `applyCatalogSync`. Exercises the real durable launcher binary
// against a temp SQLite store so the route dispatch hits the real
// `SqliteStore` + `SqliteCatalogRepository` + `SqliteCatalogSyncRepository`
// stack — there are no in-process mocks.
//
// Each test owns its own temp dir + SQLite DB + spawned launcher process
// so they cannot leak state into each other.
//
// Coverage:
//
//   GET /api/v1/catalog
//     - returns `{ items: [] }` for an empty catalog in the local scope
//     - returns entries seeded directly via `tx.catalog.upsert`
//     - excludes entries seeded in a different scope (scope isolation)
//
//   POST /api/v1/catalog/sync/preview
//     - 400 when the body is missing `roots` (the preview cannot scan)
//     - 200 with a deterministic preview for a real on-disk root
//     - the returned preview's `digest` is a 64-char hex SHA-256
//     - the preview persists and can be re-read via apply's CAS path
//
//   POST /api/v1/catalog/sync/apply
//     - 428 when `If-Match` is missing (route-level CAS precondition)
//     - 200 when the apply succeeds and the catalog now contains the
//       newly upserted entries (verified via a follow-up `getCatalog`)

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  createActorContext,
  type ActorContext,
  type CatalogEntry,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

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

async function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('probe did not return numeric address')));
        return;
      }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitReady(child: ChildProcess): Promise<{ url: string; dbPath: string }> {
  let stderr = '';
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`launcher readiness timeout: ${stderr}`)), 10_000);
    if (!child.stderr) throw new Error('launcher stderr pipe missing');
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const line = stderr.split('\n').find((entry) => entry.startsWith('AGENT_MEMORY_READY '));
      if (!line) return;
      clearTimeout(timer);
      resolveReady({ ...JSON.parse(line.slice('AGENT_MEMORY_READY '.length)) as { url: string; dbPath: string } });
    });
    child.once('error', reject);
  });
}

type LauncherHandle = { child: ChildProcess; url: string; dbPath: string; port: number };

async function spawnLauncher(dbPath: string): Promise<LauncherHandle> {
  const port = await allocateFreePort();
  const child = spawn(process.execPath, [bin], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_MEMORY_DB_PATH: dbPath, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const ready = await waitReady(child);
  expect(ready.dbPath).toBe(dbPath);
  return { child, url: ready.url, dbPath, port };
}

async function shutdownLauncher(handle: LauncherHandle): Promise<void> {
  handle.child.kill('SIGTERM');
  const [code] = await once(handle.child, 'exit') as [number | null, NodeJS.Signals | null];
  expect(code).toBe(0);
}

/**
 * Local actor used by the launcher's `localMode` (loopback trust). All
 * seeded catalog rows that should be visible to the launcher must use
 * this scope, or they will surface as cross-scope reads.
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
 * Foreign actor used to seed rows that must be invisible to the
 * loopback launcher.
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
 * Seed catalog entries directly via the storage layer. The catalog
 * repository's `upsert` is actor-bound and asserts the entry's scope
 * matches the actor's scope; each row therefore runs in its OWN
 * transaction under its OWN actor.
 */
function seedCatalogEntries(
  dbPath: string,
  rows: Array<{ actor: ActorContext; logicalKey: string; kind: CatalogEntry['kind']; name: string; summary?: string; metadata?: Record<string, unknown> }>,
): CatalogEntry[] {
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
            lifecycle: 'active',
            currentVersion: 1,
            metadata: row.metadata ?? {},
          },
          undefined,
          { reason: 'catalog-control-plane test seed', requestId: randomUUID() },
        ),
      );
      seeded.push(entry);
    }
    return seeded;
  } finally {
    store.close();
  }
}

describe('GET /api/v1/catalog (real SQLite-backed launcher)', () => {
  it('returns { items: [] } for an empty catalog in the local scope', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-catalog-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/catalog`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: unknown[] };
      expect(body.items).toEqual([]);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns every active entry seeded into the local scope', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-catalog-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    const seeded = seedCatalogEntries(dbPath, [
      { actor: localActor(), logicalKey: 'repository:docs:README.md', kind: 'repository', name: 'README', summary: 'top-level' },
      { actor: localActor(), logicalKey: 'skill:docs:runbook', kind: 'skill', name: 'runbook' },
      { actor: localActor(), logicalKey: 'document:docs:changelog.md', kind: 'document', name: 'changelog' },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/catalog`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: CatalogEntry[] };
      expect(body.items).toHaveLength(3);
      const keys = body.items.map((item) => item.logicalKey).sort();
      expect(keys).toEqual(seeded.map((entry) => entry.logicalKey).sort());
      for (const item of body.items) {
        expect(item.lifecycle).toBe('active');
        expect(item.scope).toEqual({ ownerUserId: 'usr_local', agentId: 'agt_local' });
      }
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('excludes entries seeded in a different scope', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-catalog-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    seedCatalogEntries(dbPath, [
      { actor: localActor(), logicalKey: 'repository:docs:README.md', kind: 'repository', name: 'README' },
      { actor: foreignActor(), logicalKey: 'repository:secret:HIDDEN.md', kind: 'repository', name: 'HIDDEN' },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/catalog`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: CatalogEntry[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.logicalKey).toBe('repository:docs:README.md');
      // Cross-scope rows must never be fabricated.
      expect(body.items.find((item) => item.logicalKey === 'repository:secret:HIDDEN.md')).toBeUndefined();
    } finally {
      await shutdownLauncher(handle);
    }
  });
});

describe('GET /api/v1/catalog/search (real SQLite-backed launcher)', () => {
  it('searches active local entries with kind filtering and validates q', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-catalog-search-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    seedCatalogEntries(dbPath, [
      { actor: localActor(), logicalKey: 'skill:docs:aurora', kind: 'skill', name: 'aurora skill', summary: 'northern lights' },
      { actor: localActor(), logicalKey: 'document:docs:aurora', kind: 'document', name: 'aurora document' },
      { actor: foreignActor(), logicalKey: 'skill:foreign:aurora', kind: 'skill', name: 'aurora hidden' },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/catalog/search?q=aurora&kind=skill&limit=5`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: CatalogEntry[] };
      expect(body.items.map((item) => item.logicalKey)).toEqual(['skill:docs:aurora']);

      const invalid = await fetch(`${handle.url}/api/v1/catalog/search?q=`);
      expect(invalid.status).toBe(400);
      const error = await invalid.json() as { error: { code: string } };
      expect(error.error.code).toBe('VALIDATION');
    } finally {
      await shutdownLauncher(handle);
    }
  });
});

describe('POST /api/v1/catalog/sync/preview (real SQLite-backed launcher)', () => {
  it('returns 400 when the body is missing roots', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-catalog-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/catalog/sync/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'default' }),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('VALIDATION');
      expect(body.error.message).toMatch(/roots/i);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns a deterministic preview with operations for a real on-disk root', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-catalog-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    // Build a real on-disk root the scanner can discover.
    const scanRoot = mkdtempSync(join(tmpdir(), 'catalog-control-plane-scan-'));
    tempRoots.push(scanRoot);
    mkdirSync(join(scanRoot, 'docs'), { recursive: true });
    writeFileSync(join(scanRoot, 'docs', 'README.md'), '# hello world\n');
    writeFileSync(join(scanRoot, 'docs', 'CHANGELOG.md'), '# changelog\n');

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/catalog/sync/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roots: [{ id: 'docs', path: scanRoot }],
          profile: 'default',
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        id: string;
        profile: string;
        roots: Array<{ id: string; path: string }>;
        operations: Array<{ action: string; logicalKey: string }>;
        digest: string;
        complete: boolean;
      };
      expect(body.id).toMatch(/^catprev_/);
      expect(body.profile).toBe('default');
      expect(body.roots.map((r) => r.id)).toEqual(['docs']);
      expect(body.complete).toBe(true);
      expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
      // The scanner discovered the two markdown files.
      const upserts = body.operations.filter((op) => op.action === 'upsert');
      expect(upserts.length).toBeGreaterThanOrEqual(2);
      const keys = upserts.map((op) => op.logicalKey).sort();
      expect(keys).toContain('document:docs:docs/CHANGELOG.md');
      expect(keys).toContain('document:docs:docs/README.md');
    } finally {
      await shutdownLauncher(handle);
    }
  });
});

describe('POST /api/v1/catalog/sync/apply (real SQLite-backed launcher)', () => {
  it('returns 428 when the If-Match header is missing', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-catalog-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/catalog/sync/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId: 'catprev_does_not_exist' }),
      });
      // The route declares `cas: true` — the app layer rejects before
      // dispatch, so the launcher never sees the request. That is the
      // *real* wiring contract, not a 404.
      expect(response.status).toBe(428);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('applies a reviewed preview and the catalog reflects the upserted entries', async () => {
    const root = mkdtempSync(join(repoRoot, '.tmp-rest-catalog-'));
    tempRoots.push(root);
    const dbPath = join(root, 'agent-memory.sqlite');
    // Real on-disk root the scanner can discover.
    const scanRoot = mkdtempSync(join(tmpdir(), 'catalog-control-plane-apply-'));
    tempRoots.push(scanRoot);
    mkdirSync(join(scanRoot, 'docs'), { recursive: true });
    writeFileSync(join(scanRoot, 'docs', 'README.md'), '# apply smoke\n');

    const handle = await spawnLauncher(dbPath);
    try {
      // Step 1: preview the sync.
      const previewResponse = await fetch(`${handle.url}/api/v1/catalog/sync/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roots: [{ id: 'docs', path: scanRoot }],
          profile: 'default',
        }),
      });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as {
        id: string;
        digest: string;
        operations: Array<{ action: string; logicalKey: string }>;
      };
      expect(preview.id).toMatch(/^catprev_/);
      expect(preview.digest).toMatch(/^[0-9a-f]{64}$/);
      const upserts = preview.operations.filter((op) => op.action === 'upsert');
      expect(upserts.length).toBeGreaterThan(0);

      // Step 2: apply the preview, sending the digest both as the
      // If-Match header (route CAS precondition) and as the body's
      // reviewedDigest (SyncService digest check).
      const applyResponse = await fetch(`${handle.url}/api/v1/catalog/sync/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': `"${preview.digest}"` },
        body: JSON.stringify({ previewId: preview.id, reviewedDigest: preview.digest }),
      });
      expect(applyResponse.status).toBe(200);

      // Step 3: GET /catalog now reflects every upserted logical key.
      const catalogResponse = await fetch(`${handle.url}/api/v1/catalog`);
      expect(catalogResponse.status).toBe(200);
      const catalogBody = await catalogResponse.json() as { items: CatalogEntry[] };
      const keys = new Set(catalogBody.items.map((item) => item.logicalKey));
      for (const op of upserts) {
        expect(keys.has(op.logicalKey), `expected ${op.logicalKey} in catalog after apply`).toBe(true);
      }
    } finally {
      await shutdownLauncher(handle);
    }
  });
});
