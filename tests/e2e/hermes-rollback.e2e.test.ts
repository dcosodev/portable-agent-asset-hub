// tests/e2e/hermes-rollback.e2e.test.ts
//
// E2E for the S8 rollback path: every byte the materializer replaced or
// deleted during apply is restored from the staging backup on rollback.
// The forbidden Hermes state paths must remain untouched through both
// phases.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createActorContext,
  type Profile,
  type Storage,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import {
  applyPlan,
  computePreview,
  rollbackPlan,
} from '@portable-agent-asset-hub/materializers';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tempHome = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `s8-rb-${label}-`));
  cleanup.push(dir);
  return dir;
};

const actor = createActorContext({
  userId: 'usr_rb',
  agentId: 'agt_rb',
  role: 'user',
  capabilities: ['admin.materialize'],
});

const mutation = (reason: string): { reason: string; requestId: string } => ({
  reason,
  requestId: `req-${reason}`,
});

const seed = (store: Storage): void => {
  const profile: Profile = {
    id: 'prf_rb',
    scope: actor.scope,
    version: 1,
    blocks: [
      { blockId: 'user-1', ordinal: 1, kind: 'USER', body: 'rb USER' },
      { blockId: 'mem-1', ordinal: 2, kind: 'MEMORY', body: 'rb MEMORY' },
    ],
  };
  store.transaction(actor, (tx) => {
    tx.profiles.create(profile, mutation('create'));
  });
};

describe('E2E hermes-rollback (S8)', () => {
  it('restores the original bytes of every replaced file', () => {
    const home = tempHome('restore');
    const target = join(home, 'hermes', 'state');
    mkdirSync(target, { recursive: true });
    const userPath = join(target, 'USER.md');
    const memPath = join(target, 'MEMORY.md');
    writeFileSync(userPath, 'original-user-bytes');
    writeFileSync(memPath, 'original-mem-bytes');
    const store = new SqliteStore(join(home, 'hub.db'));
    try {
      seed(store);
      const preview = computePreview(store, actor, {
        harness: 'hermes',
        profileId: 'prf_rb',
        snapshotId: 'snap_rb',
        targetRoot: target,
      });
      const applied = applyPlan(store, actor, {
        preview,
        targetRoot: target,
        lockDir: target,
        reason: 'rb-apply',
      });
      expect(readFileSync(userPath)).not.toEqual(Buffer.from('original-user-bytes'));
      rollbackPlan(store, actor, { runId: applied.runId, reason: 'rb-rb' });
      expect(readFileSync(userPath)).toEqual(Buffer.from('original-user-bytes'));
      expect(readFileSync(memPath)).toEqual(Buffer.from('original-mem-bytes'));
    } finally {
      store.close();
    }
  });

  it('clears the staging backup directory and the lock after rollback', () => {
    const home = tempHome('cleanup');
    const target = join(home, 'hermes', 'state');
    mkdirSync(target, { recursive: true });
    const store = new SqliteStore(join(home, 'hub.db'));
    try {
      seed(store);
      const preview = computePreview(store, actor, {
        harness: 'hermes',
        profileId: 'prf_rb',
        snapshotId: 'snap_cleanup',
        targetRoot: target,
      });
      const applied = applyPlan(store, actor, {
        preview,
        targetRoot: target,
        lockDir: target,
        reason: 'rb-cleanup-apply',
      });
      rollbackPlan(store, actor, { runId: applied.runId, reason: 'rb-cleanup' });
      const backupDir = join(target, '.pah', 'backups', applied.runId);
      expect(existsSync(backupDir)).toBe(false);
      // Lock file is removed so a subsequent apply can acquire it.
      const lockFile = join(target, '.pah', 'locks', 'hermes__prf_rb.lock');
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('rejects rollback of an unknown run id', () => {
    const home = tempHome('unknown');
    const store = new SqliteStore(join(home, 'hub.db'));
    try {
      expect(() =>
        rollbackPlan(store, actor, { runId: 'run_missing', reason: 'rb-missing' }),
      ).toThrow(/not.found|unknown/i);
    } finally {
      store.close();
    }
  });
});
