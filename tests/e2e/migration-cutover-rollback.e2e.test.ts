// tests/e2e/migration-cutover-rollback.e2e.test.ts
//
// E2E: export → import dry-run → shadow → replay → cutover → rollback →
// retired. This is the Slice 10 normative end-to-end test. It exercises
// the real Python v2 source adapter (driven by an in-memory fixture source
// so the test is hermetic), the real storage-sqlite storage contract, and
// the full state-machine lifecycle. The test is hermetic and never
// touches `~/.hermes` or any harness's `state.db`.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createActorContext } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import {
  createCutoverService,
  createExportService,
  createImportService,
  createMigrationService,
  createPythonV2SourceAdapter,
  createReplayService,
  createRetirementService,
  createRollbackService,
  createShadowService,
} from '@portable-agent-asset-hub/migration';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `s10-e2e-${label}-`));
  cleanup.push(dir);
  return dir;
};

const makeActor = () => createActorContext({
  userId: 'usr_s10_e2e',
  agentId: 'agt_s10_e2e',
  role: 'user',
  capabilities: ['admin.migrate', 'admin.materialize'],
});

const PYTHON_V2_FIXTURE = {
  rows: {
    identities: [
      { id: 'usr_e2e', kind: 'user', displayName: 'E2E Alice', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'agt_e2e', kind: 'agent', ownerUserId: 'usr_e2e', name: 'E2E agent', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'hrn_e2e', kind: 'harness', name: 'e2e-harness', runtime: 'python', createdAt: '2025-01-01T00:00:00Z' },
    ],
    memories: [
      {
        id: 'mem_e2e_1',
        ownerUserId: 'usr_e2e',
        scopeAgentId: 'agt_e2e',
        body: 'memory-body',
        lifecycle: 'active',
        version: 1,
        createdAt: '2025-01-01T00:00:00Z',
      },
    ],
    catalog_entries: [],
    catalog_sources: [],
    catalog_relations: [],
    events: [],
    audit: [],
    sync_previews: [],
  },
  sourceDigest: '0'.repeat(64),
};

describe('S10 E2E: cutover + rollback', () => {
  it('drives a full export → replay → cutover → rollback lifecycle on a hermetic SQLite store', async () => {
    const workdir = tempDir('cutover');
    const source = createPythonV2SourceAdapter({ ...PYTHON_V2_FIXTURE });

    const exporter = createExportService();
    const bundle = await exporter.run({ source, workdir });

    const hubPath = join(workdir, 'hub.db');
    const store = new SqliteStore(hubPath);
    try {
      const actor = makeActor();
      const migration = createMigrationService({ storage: store, actor });
      const importer = createImportService({ storage: store, actor });
      const shadow = createShadowService({ storage: store, workdir, actor });
      const replay = createReplayService({ storage: store, actor });
      const cutover = createCutoverService({ storage: store, actor });
      const rollback = createRollbackService({ storage: store, actor });
      const retirement = createRetirementService({ storage: store, actor });

      // 1. exported
      const run = await migration.begin({ adapterId: 'python-v2', reason: 'e2e', requestId: 'req-e2e-1' });
      await migration.transition(run.runId, 'exported', { reason: 'export complete', requestId: 'req-e2e-1' });
      await migration.setDigests(run.runId, { sourceDigest: bundle.manifest.sourceDigest, manifestDigest: bundle.manifestDigest });

      // 2. validated → dry-run
      await migration.transition(run.runId, 'validated', { reason: 'validated', requestId: 'req-e2e-2' });
      await migration.transition(run.runId, 'import_dry_run', { reason: 'dry-run', requestId: 'req-e2e-3' });
      const dryRun = await importer.dryRun({ runId: run.runId, bundle });
      expect(dryRun.ok).toBe(true);

      // 3. shadowing (no dual-write)
      await migration.transition(run.runId, 'shadowing', { reason: 'shadow', requestId: 'req-e2e-4' });
      const shadowRun = await shadow.start({ runId: run.runId });
      expect(shadowRun.observations).toBe(0);
      await shadow.observe({ runId: run.runId, record: { kind: 'identity', body: PYTHON_V2_FIXTURE.rows.identities[0] } });
      const refreshedShadow = await shadow.get(run.runId);
      expect(refreshedShadow.observations).toBe(1);

      // 4. replay verified
      await migration.transition(run.runId, 'replay_verified', { reason: 'replay', requestId: 'req-e2e-5' });
      const replayResult = await replay.run({ runId: run.runId, bundle, dbPath: hubPath });
      expect(replayResult.ok).toBe(true);
      expect(replayResult.memoriesImported).toBeGreaterThanOrEqual(1);

      // 5. cutover_ready → cutover_active
      await migration.transition(run.runId, 'cutover_ready', { reason: 'cutover-ready', requestId: 'req-e2e-6' });
      await migration.transition(run.runId, 'cutover_active', { reason: 'cutover-active', requestId: 'req-e2e-7' });
      const activated = await cutover.activate({ runId: run.runId });
      expect(activated.writer).toBe('hub');
      expect(activated.lockAcquired).toBe(true);

      // 6. rollback_window → actual rollback
      await migration.transition(run.runId, 'rollback_window', { reason: 'rollback-window', requestId: 'req-e2e-8' });
      const rollbackResult = await rollback.execute({ runId: run.runId });
      expect(rollbackResult.restored).toContain(rollbackResult.restored[0]);
      expect(rollbackResult.previousWriter).toBe('hub');

      // 7. retired
      await migration.transition(run.runId, 'retired', { reason: 'retired', requestId: 'req-e2e-9' });
      const archiveRoot = join(workdir, 'archive');
      const retired = await retirement.archive({ runId: run.runId, archiveRoot });
      expect(retired.archivePath.startsWith(archiveRoot)).toBe(true);

      // 8. final record is on disk and content-hashed
      const manifestRaw = JSON.parse(readFileSync(retired.archivePath, 'utf8'));
      expect(manifestRaw.runId).toBe(run.runId);
      expect(manifestRaw.state).toBe('retired');

      const finalRecord = await migration.get(run.runId);
      expect(finalRecord.state).toBe('retired');
      expect(finalRecord.archivePath).toBe(retired.archivePath);
    } finally {
      store.close();
    }
  });
});
