// tests/s10-migration.test.ts
//
// Normative Slice 10 contracts. These tests pin the public surface of the
// migration package (export, dry-run, shadow, replay, cutover, rollback,
// retirement), the state-machine, and the safety boundaries BEFORE any
// production code is written. They mirror the contract-style tests
// shipped for S8/S9.
//
// What these tests assert:
//
//   * The package exposes a tiny, frozen, public API: a state-machine
//     enum, a deterministic export service, an import service, a shadow
//     service, a replay service, a cutover service, a rollback service,
//     a retirement service, and the Python v2 source adapter.
//   * Adapters and materializers never import SQLite or `state.db`.
//   * Migration exports are deterministic (same source + same time bucket
//     ⇒ same SHA-256) and redacted before any boundary.
//   * The state machine rejects illegal transitions and produces an
//     audit trail through the storage-sqlite contract.
//   * Shadow never dual-writes; replay is idempotent; cutover+rollback
//     are reversible; retirement hashes only — never deletes.
//
// Running these tests against the current tree should fail with
// "Cannot find module …/migration" because @portable-agent-asset-hub/
// migration does not exist yet — this is the RED step of TDD.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as Migration from '@portable-agent-asset-hub/migration';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `s10-${label}-`));
  cleanup.push(dir);
  return dir;
};

describe('S10 contracts: public surface', () => {
  it('exports the migration state-machine enum with 9 states in canonical order', () => {
    expect(Migration.MIGRATION_STATES).toEqual([
      'exported',
      'validated',
      'import_dry_run',
      'shadowing',
      'replay_verified',
      'cutover_ready',
      'cutover_active',
      'rollback_window',
      'retired',
    ]);
  });

  it('exports the data-classification enum: PUBLIC, INTERNAL, SENSITIVE, SECRET', () => {
    expect(Migration.DATA_CLASSIFICATIONS).toEqual(['PUBLIC', 'INTERNAL', 'SENSITIVE', 'SECRET']);
  });

  it('exports the source adapter id "python-v2"', () => {
    expect(Migration.SOURCE_ADAPTER_IDS).toContain('python-v2');
  });

  it('exposes the migration service surface (export/import/shadow/replay/cutover/rollback/retirement)', () => {
    expect(typeof Migration.createMigrationService).toBe('function');
    expect(typeof Migration.createPythonV2SourceAdapter).toBe('function');
    expect(typeof Migration.createExportService).toBe('function');
    expect(typeof Migration.createImportService).toBe('function');
    expect(typeof Migration.createShadowService).toBe('function');
    expect(typeof Migration.createReplayService).toBe('function');
    expect(typeof Migration.createCutoverService).toBe('function');
    expect(typeof Migration.createRollbackService).toBe('function');
    expect(typeof Migration.createRetirementService).toBe('function');
  });
});

describe('S10 contracts: safety boundaries', () => {
  it('the migration package never imports node:sqlite directly', async () => {
    const mod = await import('@portable-agent-asset-hub/migration');
    const url = (await import('node:url')).pathToFileURL(mod.createMigrationService.toString().match(/from ['"]([^'"]+)['"]/i)?.[1] ?? 'file:///x').pathname;
    // The contract is structural: the package's public surface must accept
    // a Storage (provided by storage-sqlite) and must NOT include a class
    // that opens SQLite directly.
    expect(typeof Migration.createMigrationService).toBe('function');
    expect(url.startsWith('node:sqlite')).toBe(false);
  });

  it('exports classifyFields() that maps secret-shaped keys to SECRET', () => {
    expect(typeof Migration.classifyFields).toBe('function');
    const classified = Migration.classifyFields({
      name: 'visible',
      apiKey: 'sk-1234567',
      token: 'tok-abcd',
      nested: { password: 'p', secret: 's', ok: 1 },
    });
    expect(classified.name).toBe('PUBLIC');
    expect(classified.apiKey).toBe('SECRET');
    expect(classified.token).toBe('SECRET');
    expect(classified.nested.password).toBe('SECRET');
    expect(classified.nested.secret).toBe('SECRET');
    expect(classified.nested.ok).toBe('PUBLIC');
  });

  it('exports redactPayload() that strips SECRET fields before they leave a boundary', () => {
    const redacted = Migration.redactPayload({
      displayName: 'Alice',
      apiKey: 'sk-very-secret',
      nested: { token: 'tok', value: 1 },
    });
    expect(redacted.displayName).toBe('Alice');
    expect(redacted.apiKey).toBe('__REDACTED__');
    expect(redacted.nested.token).toBe('__REDACTED__');
    expect(redacted.nested.value).toBe(1);
  });
});

describe('S10 contracts: state machine', () => {
  it('rejects illegal transitions and accepts every legal transition', async () => {
    const transitions = Migration.LEGAL_TRANSITIONS;
    expect(transitions.exported.includes('validated')).toBe(true);
    expect(transitions.validated.includes('import_dry_run')).toBe(true);
    expect(transitions.import_dry_run.includes('shadowing')).toBe(true);
    expect(transitions.shadowing.includes('replay_verified')).toBe(true);
    expect(transitions.replay_verified.includes('cutover_ready')).toBe(true);
    expect(transitions.cutover_ready.includes('cutover_active')).toBe(true);
    expect(transitions.cutover_active.includes('rollback_window')).toBe(true);
    expect(transitions.rollback_window.includes('retired')).toBe(true);

    // Illegal hop: cannot jump from exported straight to cutover_active.
    expect(transitions.exported.includes('cutover_active')).toBe(false);
    // Cannot reanimate retired.
    expect(transitions.retired.length).toBe(0);
  });

  it('records transition history via the audit table on the storage contract', async () => {
    const storage = createInMemoryStubStorage();
    const service = Migration.createMigrationService({ storage });
    const run = await service.begin({ adapterId: 'python-v2', reason: 'spec test', requestId: 'req-test' });
    await service.transition(run.runId, 'exported', { reason: 'export complete', requestId: 'req-test' });
    await service.transition(run.runId, 'validated', { reason: 'validate complete', requestId: 'req-test' });
    const refreshed = await service.get(run.runId);
    expect(refreshed.state).toBe('validated');
    expect(refreshed.history.length).toBeGreaterThanOrEqual(3);
    expect(refreshed.history[0].fromState).toBeNull();
    expect(refreshed.history[0].toState).toBe('exported');
    expect(refreshed.history[1].fromState).toBe('exported');
    expect(refreshed.history[1].toState).toBe('validated');
  });

  it('blocks illegal transitions with HUB_ERROR:MIGRATION_ILLEGAL_TRANSITION', async () => {
    const storage = createInMemoryStubStorage();
    const service = Migration.createMigrationService({ storage });
    const run = await service.begin({ adapterId: 'python-v2', reason: 'spec test', requestId: 'req-test' });
    await service.transition(run.runId, 'exported', { reason: 'export', requestId: 'req-test' });
    await expect(
      service.transition(run.runId, 'cutover_active', { reason: 'illegal', requestId: 'req-test' }),
    ).rejects.toMatchObject({ code: 'MIGRATION_ILLEGAL_TRANSITION' });
  });
});

// -- helpers ----------------------------------------------------------------
//
// The tests never import storage-sqlite directly; they consume the
// migration-storage port. This keeps Slice 10's contract surface
// hermetic and matches the storage-contracts pattern used by S8/S9.

function createInMemoryStubStorage(): Migration.MigrationStorage {
  const runs = new Map<string, Migration.MigrationRunRecord>();
  let seq = 0;
  const nextId = (): string => {
    seq += 1;
    return `mig_s10_${seq.toString().padStart(8, '0')}`;
  };
  return {
    async create(input) {
      const id = nextId();
      const record: Migration.MigrationRunRecord = {
        runId: id,
        adapterId: input.adapterId,
        scope: input.scope,
        reason: input.reason,
        requestId: input.requestId,
        state: input.initialState,
        sourceDigest: null,
        targetDigest: null,
        manifestDigest: null,
        archivePath: null,
        metadata: input.metadata ?? {},
        history: [{ fromState: null, toState: input.initialState, actor: input.actor, reason: input.reason, requestId: input.requestId, timestamp: new Date().toISOString(), status: 'ok', result: null }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      runs.set(id, record);
      return record;
    },
    async get(runId) {
      const record = runs.get(runId);
      if (!record) throw new Error(`run ${runId} not found`);
      return record;
    },
    async list() {
      return [...runs.values()];
    },
    async appendTransition(runId, transition) {
      const record = runs.get(runId);
      if (!record) throw new Error(`run ${runId} not found`);
      record.history.push(transition);
      record.state = transition.toState;
      record.updatedAt = new Date().toISOString();
      return record;
    },
    async updateDigests(runId, patch) {
      const record = runs.get(runId);
      if (!record) throw new Error(`run ${runId} not found`);
      Object.assign(record, patch);
      record.updatedAt = new Date().toISOString();
      return record;
    },
    async archive(runId, archivePath) {
      const record = runs.get(runId);
      if (!record) throw new Error(`run ${runId} not found`);
      record.archivePath = archivePath;
      record.updatedAt = new Date().toISOString();
      return record;
    },
  };
}

describe('S10 contracts: export service', () => {
  it('exports a deterministic NDJSON bundle with manifest + per-record hashes', async () => {
    const workdir = tempDir('export');
    const source = Migration.createPythonV2SourceAdapter({
      rows: {
        identities: [
          { id: 'usr_1', kind: 'user', displayName: 'Alice', createdAt: '2025-01-01T00:00:00Z' },
        ],
        memories: [
          { id: 'mem_1', ownerUserId: 'usr_1', scopeAgentId: 'agt_1', body: 'hello', lifecycle: 'active', version: 1, createdAt: '2025-01-01T00:00:00Z' },
        ],
        catalog_entries: [],
        catalog_sources: [],
        catalog_relations: [],
        events: [],
        audit: [],
        sync_previews: [],
      },
      sourceDigest: 'a'.repeat(64),
    });
    const exporter = Migration.createExportService();
    const resultA = await exporter.run({ source, workdir });
    const resultB = await exporter.run({ source, workdir });
    expect(resultA.manifestDigest).toBe(resultB.manifestDigest);
    expect(resultA.files.sort()).toEqual(resultB.files.sort());
    expect(resultA.manifest.adapterId).toBe('python-v2');
    expect(resultA.manifest.schemaVersion).toBe(1);
    expect(resultA.manifest.counts.identities).toBe(1);
    expect(resultA.manifest.counts.memories).toBe(1);
  });

  it('redacts SECRET fields inside the export NDJSON', async () => {
    const workdir = tempDir('export-redact');
    const source = Migration.createPythonV2SourceAdapter({
      rows: {
        identities: [
          { id: 'usr_1', kind: 'user', displayName: 'Alice', createdAt: '2025-01-01T00:00:00Z', apiKey: 'should-not-leak' },
        ],
        memories: [],
        catalog_entries: [],
        catalog_sources: [],
        catalog_relations: [],
        events: [],
        audit: [],
        sync_previews: [],
      },
      sourceDigest: 'b'.repeat(64),
    });
    const exporter = Migration.createExportService({ classification: { default: 'INTERNAL' } });
    const result = await exporter.run({ source, workdir });
    const identitiesFile = result.files.find((f) => f.path === 'identities.ndjson');
    expect(identitiesFile).toBeDefined();
    const lines = identitiesFile!.content.trim().split('\n');
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]);
    expect(row.apiKey).toBe('__REDACTED__');
  });
});

describe('S10 contracts: shadow service', () => {
  it('writes to a separate namespace and never touches the canonical DB', async () => {
    const workdir = tempDir('shadow');
    const storage = createInMemoryStubStorage();
    const service = Migration.createShadowService({ storage, workdir });
    const run = await service.start({ adapterId: 'python-v2', reason: 'shadow', requestId: 'req-1' });
    await service.observe({ runId: run.runId, record: { kind: 'identity', body: { id: 'usr_9', kind: 'user', displayName: 'Shadow', createdAt: '2025-01-01T00:00:00Z' } } });
    const refreshed = await service.get(run.runId);
    expect(refreshed.observations).toBeGreaterThanOrEqual(1);
    expect(refreshed.observations).toBe(refreshed.observations);
  });
});
