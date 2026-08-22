import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client, SdkError, type ErrorBody } from '@portable-agent-asset-hub/sdk-ts';
import { listen, type RestHub } from '@portable-agent-asset-hub/rest';
import type { ActorContext } from '@portable-agent-asset-hub/core';
import { HubError } from '@portable-agent-asset-hub/core';

const fixtures = {
  health: { ok: true },
  status: { ok: true, service: 'portable-agent-asset-hub' },
  identity: { id: 'usr_test', role: 'user' },
  conflict: { error: { code: 'CONFLICT', message: 'safe', status: 409 }, request_id: 'req_fixture_conflict' },
  notFound: { error: { code: 'NOT_FOUND', message: 'safe', status: 404 }, request_id: 'req_fixture_missing' },
};

const actor = { userId: 'usr_test', agentId: 'agt_test', role: 'user' as const, capabilities: [], scope: { ownerUserId: 'usr_test', agentId: 'agt_test' } };

let base: string;
let server: Awaited<ReturnType<typeof listen>>;
let serverOriginalCwd: string;
let serverCwd: string;

async function boot() {
  serverOriginalCwd = process.cwd();
  serverCwd = mkdtempSync(join(tmpdir(), 's6-sdk-ts-'));
  process.chdir(serverCwd);
  server = await listen({
    host: '127.0.0.1',
    port: 0,
    hub: {
      dispatch: ((operation: string, input: { body: unknown; params: Record<string, string>; query: Record<string, string>; actor: ActorContext; requestId: string }) => {
        if (operation === 'getHealth') return fixtures.health;
        if (operation === 'getStatus') return fixtures.status;
        if (operation === 'listIdentities') return [fixtures.identity];
        if (operation === 'createBinding') throw new HubError('CONFLICT', 'safe', 409);
        if (operation === 'getCatalog') throw new HubError('NOT_FOUND', 'safe', 404);
        return { op: operation, ...input };
      }) satisfies RestHub['dispatch'],
    },
    localMode: true,
    localActor: actor,
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
}

async function shutdown() {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (serverOriginalCwd) process.chdir(serverOriginalCwd);
}

beforeAll(boot);
afterAll(shutdown);

describe('S6 SDK-TS contract (fixtures)', () => {
  it('health fixture maps to typed ok response', async () => {
    const client = new Client({ baseUrl: base });
    const response = await client.health();
    expect(response).toEqual(fixtures.health);
    expect(response.ok).toBe(true);
  });

  it('status fixture maps to typed service response', async () => {
    const client = new Client({ baseUrl: base });
    const response = await client.status();
    expect(response).toEqual(fixtures.status);
    expect(response.service).toBe('portable-agent-asset-hub');
  });

  it('error fixture surfaces code, status and request_id from the envelope', async () => {
    const client = new Client({ baseUrl: base });
    let captured: SdkError | null = null;
    try {
      await client.request('/api/v1/bindings', { method: 'POST', headers: { 'if-match': '1' }, body: '{}' });
    } catch (error) {
      captured = error as SdkError;
    }
    expect(captured).not.toBeNull();
    expect(captured?.code).toBe('CONFLICT');
    expect(captured?.status).toBe(409);
    expect(captured?.requestId).toBeTruthy();
  });

  it('error envelope preserves request_id when supplied by server', async () => {
    const directClient = new Client({ baseUrl: base });
    let captured: SdkError | null = null;
    try {
      await directClient.request('/api/v1/catalog');
    } catch (error) {
      captured = error as SdkError;
    }
    expect(captured).not.toBeNull();
    expect(captured?.code).toBe('NOT_FOUND');
    expect(captured?.status).toBe(404);
    expect(typeof captured?.requestId).toBe('string');
  });

  it('SDK source never imports SQLite modules', () => {
    const repoRoot = resolve(new URL('..', import.meta.url).pathname);
    const root = join(repoRoot, 'packages/sdk-ts/src');
    const result = spawnSync('grep', ['-RIn', 'better-sqlite3\\|sqlite3\\|storage-sqlite', root], { encoding: 'utf8' });
    expect(result.stdout ?? '').toBe('');
  });

  it('SDK runs without inheriting process cwd', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 's6-sdk-ts-cwd-'));
    const previous = process.cwd();
    process.chdir(tempDir);
    try {
      const client = new Client({ baseUrl: base });
      return client.health().then((result: { ok: boolean }) => {
        expect(result.ok).toBe(true);
      });
    } finally {
      // chdir restored in shutdown; restore immediately too so subsequent tests see repo root.
      process.chdir(previous);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('S6 SDK-TS error envelope parity', () => {
  it('typed ErrorBody is structurally identical across fixtures', () => {
    const shapes: ErrorBody[] = [fixtures.conflict, fixtures.notFound];
    for (const shape of shapes) {
      expect(typeof shape.error.code).toBe('string');
      expect(typeof shape.error.message).toBe('string');
      expect(typeof shape.error.status).toBe('number');
      expect(typeof shape.request_id).toBe('string');
    }
  });
});
