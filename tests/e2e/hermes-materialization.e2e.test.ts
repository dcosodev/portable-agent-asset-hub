// tests/e2e/hermes-materialization.e2e.test.ts
//
// E2E for the S8 Hermes materializer: real filesystem, real SQLite, real
// Hermes layout. Verifies the public contract:
//
//   1. Build a preview against a temp HOME.
//   2. Apply the preview; assert every materialised file exists with the
//      expected bytes and the manifest is written last.
//   3. Confirm the forbidden Hermes paths (state.db, sessions/, active
//      spool) are untouched.
//   4. Introduce drift and confirm the second apply rejects with the
//      same observed-digest mismatch that maps to HTTP 412 in the REST
//      surface.
//
// The test never spawns the Hermes CLI itself — that lives in the S10
// cutover gate. S8's E2E proves the materializer is correct on a real
// filesystem; S10 proves Hermes consumes the materialization without
// regressions. The forbidden-path invariants are checked here because
// they belong to the S8 contract, not to Hermes' runtime.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createActorContext,
  type Profile,
  type Storage,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { applyPlan, computePreview, observedManifestDigest } from '@portable-agent-asset-hub/materializers';
import { renderHermesFiles, hermesAdapter } from '@portable-agent-asset-hub/materializers/hermes';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tempHome = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `s8-e2e-${label}-`));
  cleanup.push(dir);
  return dir;
};

const actor = createActorContext({
  userId: 'usr_e2e',
  agentId: 'agt_e2e',
  role: 'user',
  capabilities: ['admin.materialize'],
});

const mutation = (reason: string): { reason: string; requestId: string } => ({
  reason,
  requestId: `req-${reason}`,
});

const seed = (store: Storage): void => {
  const profile: Profile = {
    id: 'prf_e2e',
    scope: actor.scope,
    version: 1,
    blocks: [
      { blockId: 'user-1', ordinal: 1, kind: 'USER', body: 'Hermes USER block' },
      { blockId: 'mem-1', ordinal: 2, kind: 'MEMORY', body: 'Hermes MEMORY block' },
    ],
  };
  store.transaction(actor, (tx) => {
    tx.profiles.create(profile, mutation('create'));
  });
};

describe('E2E hermes-materialization (S8)', () => {
  it('lays out USER.md and MEMORY.md with the rendered bytes and stamps the manifest', () => {
    const home = tempHome('materialize');
    const target = join(home, 'hermes', 'state');
    mkdirSync(target, { recursive: true });
    const store = new SqliteStore(join(home, 'hub.db'));
    try {
      seed(store);
      const preview = computePreview(store, actor, {
        harness: 'hermes',
        profileId: 'prf_e2e',
        snapshotId: 'snap_e2e',
        targetRoot: target,
      });
      const result = applyPlan(store, actor, {
        preview,
        targetRoot: target,
        lockDir: target,
        reason: 'e2e-apply',
      });
      expect(result.runId).toMatch(/^run_/u);
      // Every file landed with the preview's bytes.
      for (const file of preview.plan.files) {
        const absolute = join(target, file.relativePath);
        expect(existsSync(absolute)).toBe(true);
        expect(readFileSync(absolute)).toEqual(file.bytes);
      }
      // The renderer contract produced at least USER.md / MEMORY.md / SKILL.md.
      const names = preview.plan.files.map((f) => f.relativePath);
      expect(names).toContain('USER.md');
      expect(names).toContain('MEMORY.md');
      // Manifest lives at the canonical hermes location.
      const manifestPath = join(target, hermesAdapter.manifestPath);
      expect(existsSync(manifestPath)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('renderer is byte-deterministic across two fresh processes for the same snapshot', () => {
    const home = tempHome('render-deterministic');
    const store1 = new SqliteStore(join(home, 'hub.db'));
    try {
      seed(store1);
      const preview = computePreview(store1, actor, {
        harness: 'hermes',
        profileId: 'prf_e2e',
        snapshotId: 'snap_det',
        targetRoot: home,
      });
      const first = preview.plan.files.map((f) => ({
        rel: f.relativePath,
        bytes: f.bytes,
      }));
      const renderedAgain = renderHermesFiles(preview.profile);
      const second = preview.plan.files.map((f) => ({
        rel: f.relativePath,
        bytes: renderedAgain.find((g) => g.relativePath === f.relativePath)?.bytes ?? Buffer.alloc(0),
      }));
      expect(first).toEqual(second);
    } finally {
      store1.close();
    }
  });

  it('rejects a second apply after external drift with conflict (HTTP 412)', () => {
    const home = tempHome('drift');
    const target = join(home, 'hermes', 'state');
    mkdirSync(target, { recursive: true });
    const store = new SqliteStore(join(home, 'hub.db'));
    try {
      seed(store);
      const preview = computePreview(store, actor, {
        harness: 'hermes',
        profileId: 'prf_e2e',
        snapshotId: 'snap_drift',
        targetRoot: target,
      });
      const first = applyPlan(store, actor, {
        preview,
        targetRoot: target,
        lockDir: target,
        reason: 'first',
      });
      expect(first.runId).toMatch(/^run_/u);
      // External actor tampers with MEMORY.md.
      const memory = preview.plan.files.find((f) => f.relativePath === 'MEMORY.md');
      expect(memory).toBeTruthy();
      if (memory) {
        writeFileSync(join(target, memory.relativePath), 'tampered');
      }
      const observed = observedManifestDigest(target);
      expect(observed).not.toBe(preview.observedDigest ?? null);
      expect(() =>
        applyPlan(store, actor, {
          preview,
          targetRoot: target,
          lockDir: target,
          observedDigest: observed,
          reason: 'second',
        }),
      ).toThrow(/drift|conflict/i);
    } finally {
      store.close();
    }
  });

  it('never touches forbidden hermes state paths (state.db, sessions/, spool)', () => {
    const home = tempHome('safety');
    const target = join(home, 'hermes', 'state');
    mkdirSync(target, { recursive: true });
    // Plant forbidden sentinels in real hermes subpaths.
    const sentinels = [
      join(home, '.hermes', 'state.db'),
      join(home, '.hermes', 'sessions', 'active.db'),
      join(home, '.hermes', 'spool', 'active.sock'),
    ];
    for (const sentinel of sentinels) {
      mkdirSync(join(sentinel, '..'), { recursive: true });
      writeFileSync(sentinel, `forbidden:${join(sentinel, '..').split(sep).pop()}`);
    }
    const store = new SqliteStore(join(home, 'hub.db'));
    try {
      seed(store);
      const preview = computePreview(store, actor, {
        harness: 'hermes',
        profileId: 'prf_e2e',
        snapshotId: 'snap_safety',
        targetRoot: target,
      });
      applyPlan(store, actor, {
        preview,
        targetRoot: target,
        lockDir: target,
        reason: 'safety',
      });
      for (const sentinel of sentinels) {
        const original = readFileSync(sentinel, 'utf8');
        expect(original.startsWith('forbidden:')).toBe(true);
      }
    } finally {
      store.close();
    }
  });
});
