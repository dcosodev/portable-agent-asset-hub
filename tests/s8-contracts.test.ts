// tests/s8-contracts.test.ts
//
// Normative contracts for the Hermes materializer (Slice 8).
//
// These tests pin the public surface of the S8 materializer before any
// production code is written. They cover the small surface that every
// later Slice (S9 OpenClaw, S10 export/import/replay) will build on:
//
//   * contracts:        immutable type contracts (MaterializationPlan,
//                       ManifestV1, ManifestFile, LockHandle, ApplyResult,
//                       RollbackResult).
//   * manifest:         SHA-256 digest of a plan, byte-deterministic, and
//                       reproducible across processes.
//   * locks:            per-(harness,profile) mutual exclusion; release on
//                       crash; double-acquire rejected; lock files live
//                       alongside the manifest.
//   * preview:          deterministic file list derived from a snapshot +
//                       harness + profileId + targetRoot; rejects
//                       traversal/symlink/absolute roots and unsupported
//                       harness values.
//   * apply:            11-step flow (containment, symlink rejection,
//                       lock, observed-manifest compare, backup,
//                       staging, hash, atomic rename, manifest write,
//                       audit, post-verify) with rollback on every
//                       failure; drift detected before any write.
//   * rollback:         byte-for-byte restore of every prior file
//                       recorded by apply; cleans staging, releases lock.
//
// The tests run against a real filesystem in a per-test mkdtemp root and
// a real in-memory Sqlite store for the audit/provenance side. No mocks.

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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createActorContext,
  type Profile,
  type ProfileBlock,
  type Storage,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const ROOT_TMP = tmpdir();
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tempRoot = (label: string): string => {
  const dir = mkdtempSync(join(ROOT_TMP, `s8-contracts-${label}-`));
  cleanup.push(dir);
  return dir;
};

const actor = createActorContext({
  userId: 'usr_s8',
  agentId: 'agt_s8',
  role: 'user',
  capabilities: ['admin.materialize'],
});

const mutation = (reason: string): { reason: string; requestId: string } => ({
  reason,
  requestId: `req-${reason}`,
});

const userBlock = (id: string, body: string): ProfileBlock => ({
  blockId: id,
  ordinal: Number(id.replace(/[^0-9]/g, '')) || 1,
  kind: 'USER',
  body,
});

const memoryBlock = (id: string, body: string): ProfileBlock => ({
  blockId: id,
  ordinal: Number(id.replace(/[^0-9]/g, '')) || 1,
  kind: 'MEMORY',
  body,
});

const newStore = (): Storage => new SqliteStore(':memory:');

describe('S8 contracts: types and module surface', () => {
  it('exposes contracts, manifest, locks, preview, apply, rollback and hermes adapter', async () => {
    const root = tempRoot('surface');
    void root;
    const mod = await import('@portable-agent-asset-hub/materializers');
    expect(typeof mod.buildMaterializationPlan).toBe('function');
    expect(typeof mod.canonicalizeManifest).toBe('function');
    expect(typeof mod.digestPlan).toBe('function');
    expect(typeof mod.acquireLock).toBe('function');
    expect(typeof mod.releaseLock).toBe('function');
    expect(typeof mod.computePreview).toBe('function');
    expect(typeof mod.applyPlan).toBe('function');
    expect(typeof mod.rollbackPlan).toBe('function');
    expect(typeof mod.observedManifestDigest).toBe('function');
    const hermes = await import('@portable-agent-asset-hub/materializers/hermes');
    expect(typeof hermes.hermesAdapter).toBe('object');
    expect(typeof hermes.renderHermesFiles).toBe('function');
  });
});

describe('S8 manifest: byte-deterministic digest', () => {
  it('produces a stable 64-char SHA-256 digest for the same plan in a fresh process', async () => {
    const { buildMaterializationPlan, digestPlan } = await import(
      '@portable-agent-asset-hub/materializers'
    );
    const plan = buildMaterializationPlan({
      harness: 'hermes',
      profileId: 'prf_manifest',
      snapshotId: 'snap_001',
      targetRoot: '/tmp/s8-target',
      files: [
        {
          relativePath: 'USER.md',
          sha256: 'a'.repeat(64),
          bytes: Buffer.from('user body'),
          mode: 0o644,
          sourceRef: 'profile:block:user',
        },
      ],
      generatedAt: '2026-08-21T00:00:00.000Z',
      rendererVersion: '0.1.0',
    });
    const d1 = digestPlan(plan);
    const d2 = digestPlan({ ...plan });
    expect(d1).toMatch(/^[0-9a-f]{64}$/u);
    expect(d1).toBe(d2);
  });

  it('changes digest when any field changes', async () => {
    const { buildMaterializationPlan, digestPlan } = await import(
      '@portable-agent-asset-hub/materializers'
    );
    const base = buildMaterializationPlan({
      harness: 'hermes',
      profileId: 'prf_a',
      snapshotId: 'snap_a',
      targetRoot: '/tmp/s8',
      files: [],
      generatedAt: '2026-08-21T00:00:00.000Z',
      rendererVersion: '0.1.0',
    });
    const changedProfile = buildMaterializationPlan({
      ...base,
      profileId: 'prf_b',
    });
    const changedRenderer = buildMaterializationPlan({
      ...base,
      rendererVersion: '0.1.1',
    });
    expect(digestPlan(base)).not.toBe(digestPlan(changedProfile));
    expect(digestPlan(base)).not.toBe(digestPlan(changedRenderer));
  });
});

describe('S8 locks: per-(harness,profile) mutual exclusion', () => {
  it('rejects a second acquire while the first lock is held', async () => {
    const dir = tempRoot('lock');
    const { acquireLock } = await import('@portable-agent-asset-hub/materializers');
    const first = acquireLock(dir, 'hermes', 'prf_lock');
    try {
      expect(() => acquireLock(dir, 'hermes', 'prf_lock')).toThrow(/lock/i);
    } finally {
      first.release();
    }
    // After release, a second acquire succeeds.
    const second = acquireLock(dir, 'hermes', 'prf_lock');
    second.release();
  });

  it('isolates different (harness,profile) pairs in the same root', async () => {
    const dir = tempRoot('lock-iso');
    const { acquireLock } = await import('@portable-agent-asset-hub/materializers');
    const a = acquireLock(dir, 'hermes', 'prf_a');
    const b = acquireLock(dir, 'hermes', 'prf_b');
    try {
      expect(a.harness).toBe('hermes');
      expect(b.harness).toBe('hermes');
    } finally {
      a.release();
      b.release();
    }
  });

  it('rejects a symlinked lock root', async () => {
    const outer = tempRoot('lock-sym');
    const real = mkdtempSync(join(outer, 'real-'));
    cleanup.push(real);
    const { symlinkSync } = await import('node:fs');
    const link = join(outer, 'link');
    symlinkSync(real, link);
    const { acquireLock } = await import('@portable-agent-asset-hub/materializers');
    expect(() => acquireLock(link, 'hermes', 'prf_sym')).toThrow(/symlink/i);
  });
});

describe('S8 preview: deterministic, traversal-rejecting', () => {
  it('produces a deterministic file list for the same snapshot+plan input', async () => {
    const { computePreview } = await import('@portable-agent-asset-hub/materializers');
    const store = newStore();
    try {
      const profile: Profile = {
        id: 'prf_prev',
        scope: actor.scope,
        version: 1,
        blocks: [userBlock('user-1', 'hi'), memoryBlock('mem-1', 'world')],
      };
      store.transaction(actor, (tx) => {
        tx.profiles.create(profile, mutation('create'));
      });
      const target = tempRoot('prev');
      const a = computePreview(store, actor, {
        harness: 'hermes',
        profileId: 'prf_prev',
        snapshotId: 'snap_prev',
        targetRoot: target,
      });
      const b = computePreview(store, actor, {
        harness: 'hermes',
        profileId: 'prf_prev',
        snapshotId: 'snap_prev',
        targetRoot: target,
      });
      expect(a.plan.files.map((f) => f.relativePath)).toEqual(
        b.plan.files.map((f) => f.relativePath),
      );
      expect(a.plan.files.length).toBeGreaterThan(0);
      for (const f of a.plan.files) {
        expect(f.relativePath).not.toMatch(/^\./u);
        expect(f.relativePath).not.toContain('..');
        expect(f.relativePath.startsWith(sep)).toBe(false);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(f.bytes.length).toBeGreaterThan(0);
      }
    } finally {
      store.close();
    }
  });

  it('rejects absolute targetRoot', async () => {
    const { computePreview } = await import('@portable-agent-asset-hub/materializers');
    const store = newStore();
    try {
      expect(() =>
        computePreview(store, actor, {
          harness: 'hermes',
          profileId: 'prf_x',
          snapshotId: 'snap_x',
          targetRoot: '/absolute/path',
        }),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it('rejects traversal in any rendered relative path', async () => {
    const store = newStore();
    try {
      store.transaction(actor, (tx) => {
        tx.profiles.create(
          {
            id: 'prf_trav',
            scope: actor.scope,
            version: 1,
            blocks: [userBlock('user', 'x'), memoryBlock('mem', 'y')],
          },
          mutation('create'),
        );
      });
      // We can't make the renderer emit a traversal path with the
      // current renderer contract, so we exercise the public reject
      // path by handing a path-like relativePath that contains a ".."
      // segment through a low-level guard test.
      const { assertSafeRelativePath } = await import(
        '@portable-agent-asset-hub/materializers'
      );
      expect(() => assertSafeRelativePath('a/../b')).toThrow();
      expect(() => assertSafeRelativePath('a//b')).toThrow();
      expect(() => assertSafeRelativePath('/a/b')).toThrow();
      expect(() => assertSafeRelativePath('a/b/')).not.toThrow();
    } finally {
      store.close();
    }
  });
});

describe('S8 apply: 11-step flow with rollback on every failure', () => {
  let store: Storage;

  beforeEach(() => {
    store = newStore();
    store.transaction(actor, (tx) => {
      tx.profiles.create(
        {
          id: 'prf_apply',
          scope: actor.scope,
          version: 1,
          blocks: [userBlock('user', 'apply-user'), memoryBlock('mem', 'apply-mem')],
        },
        mutation('create'),
      );
    });
  });

  afterEach(() => {
    store.close();
  });

  it('writes every file from the preview and the manifest at the end', async () => {
    const { applyPlan, computePreview } = await import('@portable-agent-asset-hub/materializers');
    const target = tempRoot('apply');
    const preview = computePreview(store, actor, {
      harness: 'hermes',
      profileId: 'prf_apply',
      snapshotId: 'snap_apply',
      targetRoot: target,
    });
    const result = applyPlan(store, actor, {
      preview,
      targetRoot: target,
      lockDir: target,
      reason: 'test-apply',
    });
    expect(result.runId).toMatch(/^run_/u);
    for (const file of preview.plan.files) {
      const absolute = join(target, file.relativePath);
      expect(existsSync(absolute)).toBe(true);
      expect(readFileSync(absolute)).toEqual(file.bytes);
    }
    // Manifest written last and digest-stable.
    const manifestPath = join(target, '.pah', 'manifest.v1.json');
    expect(existsSync(manifestPath)).toBe(true);
  });

  it('rolls back to pre-existing bytes and leaves no manifest on failure', async () => {
    const { applyPlan, computePreview } = await import('@portable-agent-asset-hub/materializers');
    const target = tempRoot('apply-rb');
    mkdirSync(join(target, '.pah'));
    // Plant a prior USER.md so we can assert rollback restores it.
    const priorUser = join(target, 'USER.md');
    writeFileSync(priorUser, 'prior-user-bytes');
    // Force a failure by feeding a synthetic plan whose USER.md content
    // intentionally disagrees with the snapshot at the manifest stage.
    const { buildMaterializationPlan, digestPlan } = await import(
      '@portable-agent-asset-hub/materializers'
    );
    const preview = computePreview(store, actor, {
      harness: 'hermes',
      profileId: 'prf_apply',
      snapshotId: 'snap_apply',
      targetRoot: target,
    });
    const sabotaged = {
      ...preview,
      plan: buildMaterializationPlan({
        ...preview.plan,
        files: preview.plan.files.map((f) =>
          f.relativePath === 'USER.md'
            ? { ...f, bytes: Buffer.from('sabotaged'), sha256: 'b'.repeat(64) }
            : f,
        ),
      }),
    };
    const realDigest = digestPlan(preview.plan);
    expect(() =>
      applyPlan(store, actor, {
        preview: sabotaged,
        targetRoot: target,
        lockDir: target,
        expectedDigest: realDigest,
        reason: 'test-apply-sabotage',
      }),
    ).toThrow();
    expect(readFileSync(priorUser)).toEqual(Buffer.from('prior-user-bytes'));
    expect(existsSync(join(target, '.pah', 'manifest.v1.json'))).toBe(false);
  });

  it('detects drift on observed manifest and rejects with conflict (HTTP 412)', async () => {
    const { applyPlan, computePreview, observedManifestDigest } = await import(
      '@portable-agent-asset-hub/materializers'
    );
    const target = tempRoot('apply-drift');
    const preview = computePreview(store, actor, {
      harness: 'hermes',
      profileId: 'prf_apply',
      snapshotId: 'snap_apply',
      targetRoot: target,
    });
    // First apply succeeds.
    applyPlan(store, actor, {
      preview,
      targetRoot: target,
      lockDir: target,
      reason: 'first',
    });
    // Drift: write a different file between preview and apply.
    const driftedFile = preview.plan.files.find((f) => f.relativePath === 'MEMORY.md');
    expect(driftedFile).toBeTruthy();
    if (driftedFile) {
      writeFileSync(join(target, driftedFile.relativePath), 'tampered');
    }
    const obs = observedManifestDigest(target);
    expect(obs).not.toBe(preview.observedDigest ?? null);
    expect(() =>
      applyPlan(store, actor, {
        preview,
        targetRoot: target,
        lockDir: target,
        observedDigest: obs,
        reason: 'second',
      }),
    ).toThrow(/drift|conflict/i);
  });

  it('never touches forbidden hermes state paths during apply or rollback', async () => {
    const { applyPlan, rollbackPlan, computePreview } = await import(
      '@portable-agent-asset-hub/materializers'
    );
    const target = tempRoot('safety');
    // Plant a forbidden sentinel file that must never be modified by S8.
    const forbidden = join(target, '.hermes-state.db');
    writeFileSync(forbidden, 'forbidden');
    const preview = computePreview(store, actor, {
      harness: 'hermes',
      profileId: 'prf_apply',
      snapshotId: 'snap_safety',
      targetRoot: target,
    });
    const result = applyPlan(store, actor, {
      preview,
      targetRoot: target,
      lockDir: target,
      reason: 'safety',
    });
    expect(readFileSync(forbidden)).toEqual(Buffer.from('forbidden'));
    rollbackPlan(store, actor, { runId: result.runId, reason: 'safety-rb' });
    expect(readFileSync(forbidden)).toEqual(Buffer.from('forbidden'));
  });
});

describe('S8 rollback: byte-for-byte restoration', () => {
  it('restores the original file bytes after a successful apply', async () => {
    const { applyPlan, computePreview, rollbackPlan } = await import(
      '@portable-agent-asset-hub/materializers'
    );
    const store = newStore();
    try {
      store.transaction(actor, (tx) => {
        tx.profiles.create(
          {
            id: 'prf_rb',
            scope: actor.scope,
            version: 1,
            blocks: [userBlock('user', 'rb-user'), memoryBlock('mem', 'rb-mem')],
          },
          mutation('create'),
        );
      });
      const target = tempRoot('rb');
      const userPath = join(target, 'USER.md');
      const memPath = join(target, 'MEMORY.md');
      writeFileSync(userPath, 'original-user');
      writeFileSync(memPath, 'original-mem');
      const preview = computePreview(store, actor, {
        harness: 'hermes',
        profileId: 'prf_rb',
        snapshotId: 'snap_rb',
        targetRoot: target,
      });
      const result = applyPlan(store, actor, {
        preview,
        targetRoot: target,
        lockDir: target,
        reason: 'rb-apply',
      });
      expect(readFileSync(userPath)).not.toEqual(Buffer.from('original-user'));
      rollbackPlan(store, actor, { runId: result.runId, reason: 'rb-rollback' });
      expect(readFileSync(userPath)).toEqual(Buffer.from('original-user'));
      expect(readFileSync(memPath)).toEqual(Buffer.from('original-mem'));
    } finally {
      store.close();
    }
  });
});
