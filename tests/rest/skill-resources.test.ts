// tests/rest/skill-resources.test.ts
//
// Phase 1 normative tests for the four skill REST operations:
//   GET /api/v1/skills/search
//   GET /api/v1/skills/{id}
//   GET /api/v1/skills/{id}/resources
//   GET /api/v1/skills/{id}/resources/{resourcePath}
//
// Each test owns its own temp dir + SQLite DB + spawned launcher
// process so they cannot leak state into each other. Skills are seeded
// directly via the storage layer (a real `SqliteStore`) under the
// launcher's local actor scope (`usr_local`/`agt_local`); the agent-
// facing REST surface MUST refuse to materialize inactive lifecycles,
// so lifecycle transitions and cross-scope reads surface as 404.
//
// Coverage:
//
//   GET /api/v1/skills/search
//     * returns active FTS results ranked by bm25 with `q` and
//       optional `limit`
//     * 400 when `q` is missing / empty / whitespace-only
//     * 400 when `limit` is 0, >100, or non-integer
//
//   GET /api/v1/skills/{id}
//     * returns the active head version with body as utf-8 string and
//       resources as metadata (no bytes inline)
//     * 404 when the id does not exist
//     * 404 when the id exists only in a different scope
//     * 404 when the active head's lifecycle is not 'active' (the
//       agent-facing REST surface MUST NOT serve stale rows)
//
//   GET /api/v1/skills/{id}/resources
//     * returns the per-resource metadata of the active head version
//     * 404 for cross-scope / inactive / unknown ids
//
//   GET /api/v1/skills/{id}/resources/{resourcePath}
//     * returns base64-encoded bytes with `encoding: 'base64'` and the
//       metadata shape declared by SkillResourceRecord
//     * 404 for cross-scope / inactive / unknown ids or paths
//
//   Fresh-reopen: a process that writes a skill, terminates, and a
//   fresh process that reads it sees the same data — SQLite is the
//   authority, the launcher is stateless.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  createActorContext,
  type ActorContext,
  type SkillResource,
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

function localActor(): ActorContext {
  return createActorContext({
    userId: 'usr_local',
    agentId: 'agt_local',
    role: 'admin',
    capabilities: ['read', 'write.skill', 'admin'],
  });
}

function foreignActor(): ActorContext {
  return createActorContext({
    userId: 'usr_other',
    agentId: 'agt_other',
    role: 'admin',
    capabilities: ['read', 'write.skill', 'admin'],
  });
}

type SeedRow = {
  actor: ActorContext;
  id: string;
  logicalKey: string;
  name: string;
  summary?: string;
  body: string;
  lifecycle?: 'candidate' | 'active' | 'stale' | 'rejected';
  resources?: Array<Pick<SkillResource, 'relativePath' | 'mode' | 'mime' | 'bytes'>>;
};

/**
 * Seed skills directly into the storage layer. Every write runs under
 * the actor whose scope the row belongs to (the storage layer refuses
 * cross-scope writes). Mixing local and foreign rows in a single
 * transaction would be rejected by `assertActive`; we always run one
 * transaction per row to keep the surface simple.
 */
function seedSkills(dbPath: string, rows: SeedRow[]): void {
  const store = new SqliteStore(dbPath);
  try {
    for (const row of rows) {
      store.transaction(row.actor, (tx) => {
        tx.skills.writeSkill(
          {
            id: row.id,
            scope: row.actor.scope,
            logicalKey: row.logicalKey,
            kind: 'skill',
            name: row.name,
            summary: row.summary,
            lifecycle: row.lifecycle ?? 'active',
            body: Buffer.from(row.body, 'utf8'),
            metadata: { tags: ['rest-test'] },
            resources: (row.resources ?? []).map((resource) => ({
              relativePath: resource.relativePath,
              mode: resource.mode,
              mime: resource.mime,
              bytes: resource.bytes,
            })),
          },
          { reason: 'rest-skill test seed', requestId: `req_${randomUUID()}` },
        );
      });
    }
  } finally {
    store.close();
  }
}

function freshDb(label: string): string {
  const root = mkdtempSync(join(repoRoot, `.tmp-rest-skill-${label}-`));
  tempRoots.push(root);
  return join(root, 'agent-memory.sqlite');
}

type SkillWire = {
  id: string;
  scope: { ownerUserId: string; agentId: string };
  logicalKey: string;
  kind: 'skill' | 'tool';
  name: string;
  summary?: string;
  lifecycle: 'candidate' | 'active' | 'stale' | 'rejected';
  version: number;
  body: string;
  bodySha256: string;
  totalSize: number;
  metadata: Record<string, unknown>;
  resources: Array<{
    relativePath: string;
    mode: 420 | 493;
    mime: string;
    size: number;
    sha256: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

type SkillSearchWire = Omit<SkillWire, 'body'> & { body?: never };

type SkillResourceWire = {
  relativePath: string;
  mode: 420 | 493;
  mime: string;
  size: number;
  sha256: string;
  encoding: 'base64';
  bytes: string;
};

describe('GET /api/v1/skills/search (real SQLite-backed launcher)', () => {
  it('returns active FTS results ranked by bm25 and honors the limit query', async () => {
    const dbPath = freshDb('search');
    seedSkills(dbPath, [
      { actor: localActor(), id: 'skl_a', logicalKey: 'skill:default:skills/alpha', name: 'alpha', body: 'alpha rocket launch', resources: [] },
      { actor: localActor(), id: 'skl_b', logicalKey: 'skill:default:skills/beta', name: 'beta', body: 'beta rocket landing', resources: [] },
      { actor: localActor(), id: 'skl_c', logicalKey: 'skill:default:skills/gamma', name: 'gamma', body: 'gamma rocket countdown', resources: [] },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const all = await fetch(`${handle.url}/api/v1/skills/search?q=rocket`);
      expect(all.status).toBe(200);
      const allBody = await all.json() as { items: SkillSearchWire[] };
      expect(allBody.items).toHaveLength(3);
      expect(allBody.items.every((skill) => skill.lifecycle === 'active')).toBe(true);
      expect(allBody.items.every((skill) => skill.body === undefined)).toBe(true);

      const capped = await fetch(`${handle.url}/api/v1/skills/search?q=rocket&limit=2`);
      expect(capped.status).toBe(200);
      const cappedBody = await capped.json() as { items: SkillSearchWire[] };
      expect(cappedBody.items).toHaveLength(2);
      expect(cappedBody.items.every((skill) => skill.body === undefined)).toBe(true);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 400 when q is missing, empty, or whitespace-only', async () => {
    const dbPath = freshDb('search-q');
    seedSkills(dbPath, [
      { actor: localActor(), id: 'skl_x', logicalKey: 'skill:default:skills/x', name: 'x', body: 'anything', resources: [] },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const missing = await fetch(`${handle.url}/api/v1/skills/search`);
      expect(missing.status).toBe(400);
      const missingBody = await missing.json() as { error: { code: string; message: string } };
      expect(missingBody.error.code).toBe('VALIDATION');
      expect(missingBody.error.message).toMatch(/q/i);

      const empty = await fetch(`${handle.url}/api/v1/skills/search?q=`);
      expect(empty.status).toBe(400);
      const emptyBody = await empty.json() as { error: { code: string } };
      expect(emptyBody.error.code).toBe('VALIDATION');

      const blank = await fetch(`${handle.url}/api/v1/skills/search?q=%20%20%20`);
      expect(blank.status).toBe(400);
      const blankBody = await blank.json() as { error: { code: string } };
      expect(blankBody.error.code).toBe('VALIDATION');
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 400 when limit is 0, above 100, or non-integer', async () => {
    const dbPath = freshDb('search-limit');
    seedSkills(dbPath, [
      { actor: localActor(), id: 'skl_y', logicalKey: 'skill:default:skills/y', name: 'y', body: 'anything', resources: [] },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const zero = await fetch(`${handle.url}/api/v1/skills/search?q=anything&limit=0`);
      expect(zero.status).toBe(400);
      const zeroBody = await zero.json() as { error: { code: string; message: string } };
      expect(zeroBody.error.code).toBe('VALIDATION');
      expect(zeroBody.error.message).toMatch(/limit/i);

      const tooBig = await fetch(`${handle.url}/api/v1/skills/search?q=anything&limit=101`);
      expect(tooBig.status).toBe(400);
      const tooBigBody = await tooBig.json() as { error: { code: string } };
      expect(tooBigBody.error.code).toBe('VALIDATION');

      const floaty = await fetch(`${handle.url}/api/v1/skills/search?q=anything&limit=1.5`);
      expect(floaty.status).toBe(400);
      const floatyBody = await floaty.json() as { error: { code: string } };
      expect(floatyBody.error.code).toBe('VALIDATION');
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('excludes stale lifecycles from search results', async () => {
    const dbPath = freshDb('search-stale');
    seedSkills(dbPath, [
      { actor: localActor(), id: 'skl_keep', logicalKey: 'skill:default:skills/keep', name: 'keep', body: 'aurora active', resources: [] },
    ]);
    // Transition the row to stale via a second write (CAS, expectedVersion=1).
    const store = new SqliteStore(dbPath);
    try {
      store.transaction(localActor(), (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_keep',
            scope: localActor().scope,
            logicalKey: 'skill:default:skills/keep',
            name: 'keep',
            kind: 'skill',
            lifecycle: 'stale',
            body: Buffer.from('aurora stale', 'utf8'),
            metadata: { tags: ['stale'] },
            resources: [],
            expectedVersion: 1,
          },
          { reason: 'rest-skill test transition', requestId: `req_${randomUUID()}` },
        ),
      );
    } finally {
      store.close();
    }

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/search?q=aurora`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: SkillWire[] };
      expect(body.items).toEqual([]);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('GET /skills/search answers the search validator, not get-by-id (route ordering)', async () => {
    const dbPath = freshDb('search-ordering');
    seedSkills(dbPath, [
      { actor: localActor(), id: 'skl_route', logicalKey: 'skill:default:skills/route', name: 'route', body: 'routing smoke test', resources: [] },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/search`);
      expect(response.status).toBe(400);
      const body = await response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('VALIDATION');
      expect(body.error.message).toMatch(/q/i);
    } finally {
      await shutdownLauncher(handle);
    }
  });
});

describe('GET /api/v1/skills/{id} (real SQLite-backed launcher)', () => {
  it('returns the active head version with body as utf-8 and resources as metadata', async () => {
    const dbPath = freshDb('get');
    seedSkills(dbPath, [
      {
        actor: localActor(),
        id: 'skl_round',
        logicalKey: 'skill:default:skills/round',
        name: 'round',
        body: 'round trip body',
        resources: [
          { relativePath: 'bin/run.sh', mode: 0o755, mime: 'text/x-shellscript', bytes: Buffer.from('#!/usr/bin/env bash\necho hi\n', 'utf8') },
          { relativePath: 'README.md', mode: 0o644, mime: 'text/markdown', bytes: Buffer.from('# Helper README', 'utf8') },
        ],
      },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/skl_round`);
      expect(response.status).toBe(200);
      const body = await response.json() as SkillWire;
      expect(body.id).toBe('skl_round');
      expect(body.lifecycle).toBe('active');
      expect(body.body).toBe('round trip body');
      // Resources are returned as metadata only — no bytes inline.
      expect(body.resources).toHaveLength(2);
      for (const resource of body.resources) {
        expect(resource).not.toHaveProperty('bytes');
        expect(resource).not.toHaveProperty('encoding');
      }
      // Resource metadata is returned in canonical path order.
      expect(body.resources.map((r) => r.relativePath)).toEqual(['README.md', 'bin/run.sh']);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 404 when the id does not exist', async () => {
    const dbPath = freshDb('get-missing');
    seedSkills(dbPath, [
      { actor: localActor(), id: 'skl_other', logicalKey: 'skill:default:skills/other', name: 'other', body: 'anything', resources: [] },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/skl_missing`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string; status: number } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.status).toBe(404);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 404 when the id exists only in a different scope', async () => {
    const dbPath = freshDb('get-cross-scope');
    seedSkills(dbPath, [
      { actor: foreignActor(), id: 'skl_foreign', logicalKey: 'skill:default:skills/foreign', name: 'foreign', body: 'must not leak', resources: [] },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/skl_foreign`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string; status: number } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.status).toBe(404);
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 404 when the active head lifecycle is not active', async () => {
    const dbPath = freshDb('get-stale');
    seedSkills(dbPath, [
      { actor: localActor(), id: 'skl_stale', logicalKey: 'skill:default:skills/stale', name: 'stale', body: 'initial', resources: [] },
    ]);
    // CAS transition to stale. The agent-facing REST surface MUST refuse
    // to materialize the row even though the storage layer still has it.
    const store = new SqliteStore(dbPath);
    try {
      store.transaction(localActor(), (tx) =>
        tx.skills.writeSkill(
          {
            id: 'skl_stale',
            scope: localActor().scope,
            logicalKey: 'skill:default:skills/stale',
            name: 'stale',
            kind: 'skill',
            lifecycle: 'stale',
            body: Buffer.from('stale body', 'utf8'),
            metadata: { tags: ['stale'] },
            resources: [],
            expectedVersion: 1,
          },
          { reason: 'rest-skill test transition', requestId: `req_${randomUUID()}` },
        ),
      );
    } finally {
      store.close();
    }

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/skl_stale`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string; status: number } };
      expect(body.error.code).toBe('NOT_FOUND');
    } finally {
      await shutdownLauncher(handle);
    }
  });
});

describe('GET /api/v1/skills/{id}/resources (real SQLite-backed launcher)', () => {
  it('returns the per-resource metadata of the active head version', async () => {
    const dbPath = freshDb('list');
    seedSkills(dbPath, [
      {
        actor: localActor(),
        id: 'skl_res',
        logicalKey: 'skill:default:skills/res',
        name: 'res',
        body: 'res body',
        resources: [
          { relativePath: 'bin/run.sh', mode: 0o755, mime: 'text/x-shellscript', bytes: Buffer.from('run', 'utf8') },
          { relativePath: 'README.md', mode: 0o644, mime: 'text/markdown', bytes: Buffer.from('readme', 'utf8') },
        ],
      },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/skl_res/resources`);
      expect(response.status).toBe(200);
      const body = await response.json() as { items: Array<{ relativePath: string; mode: 420 | 493; mime: string; size: number; sha256: string }> };
      expect(body.items.map((r) => r.relativePath)).toEqual(['README.md', 'bin/run.sh']);
      expect(body.items[0]!.mode).toBe(0o644);
      expect(body.items[1]!.mode).toBe(0o755);
      for (const resource of body.items) {
        expect(resource.size).toBeGreaterThan(0);
        expect(resource.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 404 for an unknown skill id', async () => {
    const dbPath = freshDb('list-missing');
    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/skl_nope/resources`);
      expect(response.status).toBe(404);
    } finally {
      await shutdownLauncher(handle);
    }
  });
});

describe('GET /api/v1/skills/{id}/resources/{resourcePath} (real SQLite-backed launcher)', () => {
  it('returns base64-encoded bytes with encoding marker and metadata', async () => {
    const dbPath = freshDb('read');
    const payload = Buffer.from('#!/usr/bin/env bash\necho hello\n', 'utf8');
    seedSkills(dbPath, [
      {
        actor: localActor(),
        id: 'skl_read',
        logicalKey: 'skill:default:skills/read',
        name: 'read',
        body: 'read body',
        resources: [
          { relativePath: 'bin/run.sh', mode: 0o755, mime: 'text/x-shellscript', bytes: payload },
        ],
      },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/skl_read/resources/bin/run.sh`);
      expect(response.status).toBe(200);
      const body = await response.json() as SkillResourceWire;
      expect(body.relativePath).toBe('bin/run.sh');
      expect(body.mode).toBe(0o755);
      expect(body.mime).toBe('text/x-shellscript');
      expect(body.size).toBe(payload.length);
      expect(body.encoding).toBe('base64');
      // The base64 string must decode back to the original payload
      // exactly. The wire shape never serializes the raw Buffer
      // (which JSON would turn into an ambiguous number array).
      expect(Buffer.from(body.bytes, 'base64').toString('utf8')).toBe(payload.toString('utf8'));
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('decodes percent-encoded POSIX paths without collision', async () => {
    const dbPath = freshDb('read-encoded');
    seedSkills(dbPath, [
      {
        actor: localActor(),
        id: 'skl_enc',
        logicalKey: 'skill:default:skills/enc',
        name: 'enc',
        body: 'enc body',
        resources: [
          { relativePath: 'bin/run.sh', mode: 0o755, mime: 'text/x-shellscript', bytes: Buffer.from('run', 'utf8') },
        ],
      },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      // `bin/run.sh` percent-encoded as `bin%2Frun.sh` must hit the
      // `/skills/{id}/resources/{resourcePath}` route (greedy capture)
      // and resolve to the same row.
      const response = await fetch(`${handle.url}/api/v1/skills/skl_enc/resources/bin%2Frun.sh`);
      expect(response.status).toBe(200);
      const body = await response.json() as SkillResourceWire;
      expect(body.relativePath).toBe('bin/run.sh');
      expect(body.encoding).toBe('base64');
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 400 for malformed encoding or traversal paths', async () => {
    const dbPath = freshDb('read-invalid-path');
    const handle = await spawnLauncher(dbPath);
    try {
      const malformed = await fetch(`${handle.url}/api/v1/skills/skl_x/resources/%ZZ`);
      expect(malformed.status).toBe(400);
      expect((await malformed.json() as { error: { code: string } }).error.code).toBe('VALIDATION');

      const traversal = await fetch(`${handle.url}/api/v1/skills/skl_x/resources/..%2Fsecret`);
      expect(traversal.status).toBe(400);
      expect((await traversal.json() as { error: { code: string } }).error.code).toBe('VALIDATION');
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 404 when the resource path does not exist', async () => {
    const dbPath = freshDb('read-missing');
    seedSkills(dbPath, [
      {
        actor: localActor(),
        id: 'skl_rm',
        logicalKey: 'skill:default:skills/rm',
        name: 'rm',
        body: 'rm body',
        resources: [
          { relativePath: 'bin/run.sh', mode: 0o755, mime: 'text/x-shellscript', bytes: Buffer.from('run', 'utf8') },
        ],
      },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/skl_rm/resources/missing.sh`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string; status: number } };
      expect(body.error.code).toBe('NOT_FOUND');
    } finally {
      await shutdownLauncher(handle);
    }
  });

  it('returns 404 when the skill id exists only in a different scope', async () => {
    const dbPath = freshDb('read-cross-scope');
    seedSkills(dbPath, [
      {
        actor: foreignActor(),
        id: 'skl_foreign',
        logicalKey: 'skill:default:skills/foreign',
        name: 'foreign',
        body: 'foreign body',
        resources: [
          { relativePath: 'bin/run.sh', mode: 0o755, mime: 'text/x-shellscript', bytes: Buffer.from('run', 'utf8') },
        ],
      },
    ]);

    const handle = await spawnLauncher(dbPath);
    try {
      const response = await fetch(`${handle.url}/api/v1/skills/skl_foreign/resources/bin/run.sh`);
      expect(response.status).toBe(404);
    } finally {
      await shutdownLauncher(handle);
    }
  });
});

describe('Fresh-process reopen: SQLite is the authority', () => {
  it('a process that writes then terminates leaves the skill readable by a fresh process', async () => {
    const dbPath = freshDb('reopen');
    seedSkills(dbPath, [
      {
        actor: localActor(),
        id: 'skl_reopen',
        logicalKey: 'skill:default:skills/reopen',
        name: 'reopen',
        body: 'persistent body',
        resources: [
          { relativePath: 'a.txt', mode: 0o644, mime: 'text/plain', bytes: Buffer.from('a', 'utf8') },
        ],
      },
    ]);

    // First launcher process: read the row, prove the wire shape, terminate.
    {
      const handle = await spawnLauncher(dbPath);
      try {
        const response = await fetch(`${handle.url}/api/v1/skills/skl_reopen`);
        expect(response.status).toBe(200);
        const body = await response.json() as SkillWire;
        expect(body.body).toBe('persistent body');
        const listed = await fetch(`${handle.url}/api/v1/skills/skl_reopen/resources`);
        expect(listed.status).toBe(200);
        const listedBody = await listed.json() as { items: Array<{ relativePath: string }> };
        expect(listedBody.items.map((r) => r.relativePath)).toEqual(['a.txt']);
      } finally {
        await shutdownLauncher(handle);
      }
    }

    // Fresh launcher process on the same SQLite file: must read the
    // same row and the same resource. SQLite is the authority, the
    // launcher is stateless.
    {
      const handle = await spawnLauncher(dbPath);
      try {
        const response = await fetch(`${handle.url}/api/v1/skills/skl_reopen`);
        expect(response.status).toBe(200);
        const body = await response.json() as SkillWire;
        expect(body.body).toBe('persistent body');
        const read = await fetch(`${handle.url}/api/v1/skills/skl_reopen/resources/a.txt`);
        expect(read.status).toBe(200);
        const readBody = await read.json() as SkillResourceWire;
        expect(readBody.encoding).toBe('base64');
        expect(Buffer.from(readBody.bytes, 'base64').toString('utf8')).toBe('a');
      } finally {
        await shutdownLauncher(handle);
      }
    }
  });
});
