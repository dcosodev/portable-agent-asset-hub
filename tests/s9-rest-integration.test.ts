// tests/s9-rest-integration.test.ts
//
// Normative integration test for the S9 OpenClaw REST surface. We
// run the real REST server against a real SqliteStore +
// openclawMaterializer; verify the drift-detected apply attempt maps
// to HTTP 412 (Precondition Failed), and that the
// openclawMaterializer dispatcher respects the same If-Match / 428
// contract covered by Slice 8 for Hermes.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createActorContext,
  type Profile,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { observedManifestDigest } from '@portable-agent-asset-hub/materializers';
import { openclawMaterializerDispatcher } from '@portable-agent-asset-hub/materializers/openclaw';
import { listen } from '@portable-agent-asset-hub/rest';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tempHome = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `s9-rest-${label}-`));
  cleanup.push(dir);
  return dir;
};

const actor = createActorContext({
  userId: 'usr_oc_rest',
  agentId: 'agt_oc_rest',
  role: 'user',
  capabilities: [
    'admin.materialize',
    'materialization.apply',
    'materialization.preview',
  ],
});

const mutation = (reason: string): { reason: string; requestId: string } => ({
  reason,
  requestId: `req-${reason}`,
});

describe('S9 REST integration: openclaw drift -> 412', () => {
  it('preview then apply with If-Match succeeds; tampered apply returns 412', async () => {
    const home = tempHome('drift-412');
    const stateDir = join(home, 'openclaw');
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(home, 'hub.db');
    const store = new SqliteStore(dbPath);
    try {
      const profile: Profile = {
        id: 'prf_oc_rest',
        scope: actor.scope,
        version: 1,
        blocks: [
          { blockId: 'user', ordinal: 1, kind: 'USER', body: 'rest openclaw user' },
          { blockId: 'mem', ordinal: 2, kind: 'MEMORY', body: 'rest openclaw mem' },
        ],
      };
      store.transaction(actor, (tx) => {
        tx.profiles.create(profile, mutation('create'));
      });
      const server = await listen({
        hub: {
          doctor: () => ({ ok: true }),
          dispatch: openclawMaterializerDispatcher({
            store,
            actor,
            stateDir,
          }),
        },
        localMode: true,
        localActor: actor,
      });
      try {
        const addr = server.address();
        expect(addr && typeof addr === 'object').toBe(true);
        const base = `http://127.0.0.1:${(addr as { port: number }).port}`;

        // Preview.
        const previewRes = await fetch(`${base}/api/v1/materializations/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            harness: 'openclaw',
            profileId: 'prf_oc_rest',
            snapshotId: 'snap_oc_rest',
          }),
        });
        expect(previewRes.status).toBe(200);
        const preview = await previewRes.json() as {
          plan: { files: Array<{ relativePath: string; sha256: string }> };
          observedDigest: string;
        };
        expect(preview.plan.files.length).toBeGreaterThan(0);

        // First apply succeeds.
        const firstApply = await fetch(`${base}/api/v1/materializations/apply`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'if-match': `"${preview.observedDigest}"`,
          },
          body: JSON.stringify({
            harness: 'openclaw',
            profileId: 'prf_oc_rest',
            snapshotId: 'snap_oc_rest',
          }),
        });
        expect(firstApply.status).toBe(200);

        // Tamper with the OpenClaw memory.md.
        const memory = preview.plan.files.find((f) => f.relativePath.endsWith('memory.md'));
        expect(memory).toBeTruthy();
        if (memory) writeFileSync(join(stateDir, memory.relativePath), 'tampered');

        const drifted = observedManifestDigest(stateDir);
        const apply2 = await fetch(`${base}/api/v1/materializations/apply`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'if-match': `"${preview.observedDigest}"`,
          },
          body: JSON.stringify({
            harness: 'openclaw',
            profileId: 'prf_oc_rest',
            snapshotId: 'snap_oc_rest',
            observedDigest: drifted,
          }),
        });
        expect(apply2.status).toBe(412);
        const body = await apply2.json() as { error: { code: string; status: number } };
        expect(body.error.status).toBe(412);
        expect(body.error.code).toBe('PRECONDITION_FAILED');
      } finally {
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      }
    } finally {
      store.close();
    }
  });

  it('rejects an apply without If-Match with 428 (CAS precondition required)', async () => {
    const home = tempHome('if-match');
    const stateDir = join(home, 'openclaw');
    mkdirSync(stateDir, { recursive: true });
    const store = new SqliteStore(join(home, 'hub.db'));
    try {
      store.transaction(actor, (tx) => {
        tx.profiles.create(
          {
            id: 'prf_oc_im',
            scope: actor.scope,
            version: 1,
            blocks: [{ blockId: 'user', ordinal: 1, kind: 'USER', body: 'x' }],
          },
          mutation('create'),
        );
      });
      const server = await listen({
        hub: {
          doctor: () => ({ ok: true }),
          dispatch: openclawMaterializerDispatcher({
            store,
            actor,
            stateDir,
          }),
        },
        localMode: true,
        localActor: actor,
      });
      try {
        const addr = server.address() as { port: number };
        const base = `http://127.0.0.1:${addr.port}`;
        const res = await fetch(`${base}/api/v1/materializations/apply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            harness: 'openclaw',
            profileId: 'prf_oc_im',
            snapshotId: 'snap_oc_im',
            observedDigest: 'a'.repeat(64),
          }),
        });
        expect(res.status).toBe(428);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      }
    } finally {
      store.close();
    }
  });

  it('reviewer can use the renderer-agnostic REST surface with harness=openclaw', async () => {
    const home = tempHome('sanity');
    const stateDir = join(home, 'openclaw');
    mkdirSync(stateDir, { recursive: true });
    const store = new SqliteStore(join(home, 'hub.db'));
    try {
      store.transaction(actor, (tx) => {
        tx.profiles.create(
          {
            id: 'prf_oc_disp',
            scope: actor.scope,
            version: 1,
            blocks: [{ blockId: 'user', ordinal: 1, kind: 'USER', body: 'd' }],
          },
          mutation('create'),
        );
      });
      const dispatcher = openclawMaterializerDispatcher({
        store,
        actor,
        stateDir,
      });
      const preview = dispatcher('previewMaterialization', {
        body: {
          harness: 'openclaw',
          profileId: 'prf_oc_disp',
          snapshotId: 'snap_oc_disp',
        },
        params: {},
        query: {},
        actor,
        requestId: 'req-sanity',
      }) as { plan: { files: Array<{ relativePath: string }> } };
      expect(preview.plan.files.length).toBeGreaterThan(0);
      expect(
        preview.plan.files.some((f) => f.relativePath.startsWith('agents/')),
      ).toBe(true);
    } finally {
      store.close();
    }
  });
});
