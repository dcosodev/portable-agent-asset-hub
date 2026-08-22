// tests/s8-rest-integration.test.ts
//
// Normative integration test: the S8 REST surface maps a drift-detected
// apply attempt to HTTP 412 (Precondition Failed). This is the contract
// every MCP and SDK consumer sees.
//
// We run the real REST server (createRestServer + listen) against a real
// SqliteStore + HermesMaterializer; the drift is introduced by tampering
// with the target file between preview and apply.

import {
  existsSync,
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
import { hermesMaterializerDispatcher } from '@portable-agent-asset-hub/materializers/hermes';
import { listen } from '@portable-agent-asset-hub/rest';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tempHome = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `s8-rest-${label}-`));
  cleanup.push(dir);
  return dir;
};

const actor = createActorContext({
  userId: 'usr_rest',
  agentId: 'agt_rest',
  role: 'user',
  capabilities: ['admin.materialize', 'materialization.apply', 'materialization.preview'],
});

const mutation = (reason: string): { reason: string; requestId: string } => ({
  reason,
  requestId: `req-${reason}`,
});

describe('S8 REST integration: drift -> 412', () => {
  it('preview then apply with If-Match succeeds; tampered apply returns 412', async () => {
    const home = tempHome('drift-412');
    const target = join(home, 'hermes', 'state');
    mkdirSync(target, { recursive: true });
    const dbPath = join(home, 'hub.db');
    const store = new SqliteStore(dbPath);
    try {
      const profile: Profile = {
        id: 'prf_rest',
        scope: actor.scope,
        version: 1,
        blocks: [
          { blockId: 'user', ordinal: 1, kind: 'USER', body: 'rest user' },
          { blockId: 'mem', ordinal: 2, kind: 'MEMORY', body: 'rest mem' },
        ],
      };
      store.transaction(actor, (tx) => {
        tx.profiles.create(profile, mutation('create'));
      });
      const server = await listen({
        hub: {
          doctor: () => ({ ok: true }),
          dispatch: hermesMaterializerDispatcher({ store, actor, targetRoot: target, lockDir: target }),
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
            harness: 'hermes',
            profileId: 'prf_rest',
            snapshotId: 'snap_rest',
          }),
        });
        expect(previewRes.status).toBe(200);
        const preview = await previewRes.json() as {
          plan: { files: Array<{ relativePath: string; sha256: string }> };
          observedDigest: string;
        };
        expect(preview.plan.files.length).toBeGreaterThan(0);

        // First apply succeeds. The CAS contract (see
        // tests/s8-contracts.test.ts 'detects drift on observed manifest
        // and rejects with conflict') omits `observedDigest` on a fresh
        // empty target so neither CAS check runs; passing
        // `preview.observedDigest` here would 412 because the live disk
        // digest is the null-digest ('0' * 64) before any apply has
        // written a manifest.
        const firstApply = await fetch(`${base}/api/v1/materializations/apply`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'if-match': `"${preview.observedDigest}"`,
          },
          body: JSON.stringify({
            harness: 'hermes',
            profileId: 'prf_rest',
            snapshotId: 'snap_rest',
          }),
        });
        expect(firstApply.status).toBe(200);

        // Tamper with MEMORY.md.
        const memory = preview.plan.files.find((f) => f.relativePath === 'MEMORY.md');
        expect(memory).toBeTruthy();
        if (memory) writeFileSync(join(target, memory.relativePath), 'tampered');

        const drifted = observedManifestDigest(target);
        const apply2 = await fetch(`${base}/api/v1/materializations/apply`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'if-match': `"${preview.observedDigest}"`,
          },
          body: JSON.stringify({
            harness: 'hermes',
            profileId: 'prf_rest',
            snapshotId: 'snap_rest',
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
    const target = join(home, 'hermes', 'state');
    mkdirSync(target, { recursive: true });
    const store = new SqliteStore(join(home, 'hub.db'));
    try {
      store.transaction(actor, (tx) => {
        tx.profiles.create(
          {
            id: 'prf_im',
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
          dispatch: hermesMaterializerDispatcher({ store, actor, targetRoot: target, lockDir: target }),
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
            harness: 'hermes',
            profileId: 'prf_im',
            snapshotId: 'snap_im',
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
});

describe('S8 sanity: imports compile and link against real fs/db', () => {
  it('exports the HermesMaterializer dispatcher factory', async () => {
    const mod = await import('@portable-agent-asset-hub/materializers/hermes');
    expect(typeof mod.hermesMaterializerDispatcher).toBe('function');
    // The dispatcher wires preview/apply/rollback.
    const home = tempHome('imports');
    const target = join(home, 'hermes', 'state');
    mkdirSync(target, { recursive: true });
    const store = new SqliteStore(join(home, 'hub.db'));
    try {
      store.transaction(actor, (tx) => {
        tx.profiles.create(
          {
            id: 'prf_disp',
            scope: actor.scope,
            version: 1,
            blocks: [{ blockId: 'user', ordinal: 1, kind: 'USER', body: 'd' }],
          },
          mutation('create'),
        );
      });
      const dispatcher = hermesMaterializerDispatcher({
        store,
        actor,
        targetRoot: target,
        lockDir: target,
      });
      expect(typeof dispatcher).toBe('function');
      const out = dispatcher('previewMaterialization', {
        body: {
          harness: 'hermes',
          profileId: 'prf_disp',
          snapshotId: 'snap_d',
        },
        params: {},
        query: {},
        actor,
        requestId: 'req-x',
      });
      expect(out).toBeTruthy();
      expect(existsSync(target)).toBe(true);
    } finally {
      store.close();
    }
  });
});
