// tests/materializers/hermes-adapter-cas.test.ts
//
// Regression test for `hermesApply`'s CAS contract.
//
// `hermesApply` re-runs `hermesPreview` internally rather than taking
// an already-computed `PreviewResult`, so it is only correct if two
// independent `hermesPreview` calls over the same
// (profileId, snapshotId, targetRoot) tuple produce the exact same
// `observedDigest`. Before the `computePreview` fix (pinning `runId`
// and `generatedAt` to that tuple instead of a fresh `randomUUID()` /
// wall clock per call), the caller's own preview digest could never
// match the digest `hermesApply` recomputed, so `apply()` following
// the documented preview -> observedDigest -> apply flow always
// failed with 412 PRECONDITION_FAILED — the CAS-guarded Hermes apply
// path was unusable through this entry point.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createActorContext, type Profile, type Storage } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { observedManifestDigest } from '@portable-agent-asset-hub/materializers';
import { hermesApply, hermesPreview, type HermesMaterializerContext } from '@portable-agent-asset-hub/materializers/hermes';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempHome = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `hermes-adapter-cas-${label}-`));
  cleanup.push(dir);
  return dir;
};

const actor = createActorContext({
  userId: 'usr_hermes_cas',
  agentId: 'agt_hermes_cas',
  role: 'user',
  capabilities: ['admin.materialize'],
});

const seed = (store: Storage): void => {
  const profile: Profile = {
    id: 'prf_hermes_cas',
    scope: actor.scope,
    version: 1,
    blocks: [{ blockId: 'user-1', ordinal: 1, kind: 'USER', body: 'Hermes CAS regression' }],
  };
  store.transaction(actor, (tx) => tx.profiles.create(profile, { reason: 'seed', requestId: 'req-seed' }));
};

describe('hermesApply CAS round-trip via the public adapter surface', () => {
  it('two independent hermesPreview calls over the same inputs produce the same observedDigest', () => {
    const home = tempHome('digest-stable');
    const target = join(home, 'hermes', 'state');
    mkdirSync(target, { recursive: true });
    const store = new SqliteStore(join(home, 'hub.db'));
    const ctx: HermesMaterializerContext = { store, actor, targetRoot: target };
    try {
      seed(store);
      const request = { harness: 'hermes' as const, profileId: 'prf_hermes_cas', snapshotId: 'snap_cas' };
      const first = hermesPreview(ctx, request);
      const second = hermesPreview(ctx, request);
      expect(second.observedDigest).toBe(first.observedDigest);
      expect(second.plan.runId).toBe(first.plan.runId);
    } finally {
      store.close();
    }
  });

  it('re-applying an unchanged profile with the current on-disk digest as observedDigest succeeds (idempotent re-apply)', () => {
    const home = tempHome('reapply-idempotent');
    const target = join(home, 'hermes', 'state');
    mkdirSync(target, { recursive: true });
    const store = new SqliteStore(join(home, 'hub.db'));
    const ctx: HermesMaterializerContext = { store, actor, targetRoot: target };
    try {
      seed(store);
      const request = { harness: 'hermes' as const, profileId: 'prf_hermes_cas', snapshotId: 'snap_cas' };
      // Round 1: bootstrap the target. A first apply to an empty
      // target has nothing to CAS-check against, so observedDigest is
      // omitted here — exactly the pattern `examples/demo/demo.mjs`
      // step 5 (documented in docs/demo.md) uses for its first apply.
      const first = hermesApply(ctx, { ...request, reason: 'bootstrap' });
      expect(first.runId).toMatch(/^run_/u);
      // What a real caller reads off the target before a second,
      // idempotent apply of the *same, unchanged* profile.
      const onDiskDigest = observedManifestDigest(target);
      // Round 2: re-apply the unchanged profile, CAS-guarded by the
      // digest just read off disk. hermesApply re-runs hermesPreview
      // internally to build the plan it actually applies; before the
      // fix, that fresh internal preview minted a new random runId
      // (and wall-clock generatedAt) even though nothing about the
      // profile changed, so its digest never matched `onDiskDigest`
      // and this call always threw 412 PRECONDITION_FAILED — an
      // unchanged, idempotent re-apply was impossible through this
      // entry point.
      const second = hermesApply(ctx, { ...request, observedDigest: onDiskDigest, reason: 'idempotent-reapply' });
      expect(second.runId).toMatch(/^run_/u);
    } finally {
      store.close();
    }
  });
});
