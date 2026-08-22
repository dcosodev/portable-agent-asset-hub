import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { backupDatabase, SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { HubDatabase } from '../../packages/storage-sqlite/src/database.js';
import { loadMigrations, migrate } from '../../packages/storage-sqlite/src/migrations/runner.js';

describe('S2 migrations, doctor, backup, schemas and owner boundary', () => {
  it('public_storage_api_does_not_expose_raw_sqlite', async () => {
    const publicApi = await import('@portable-agent-asset-hub/storage-sqlite') as Record<string, unknown>;
    for (const name of ['HubDatabase', 'doctor', 'migrate', 'loadMigrations']) expect(name in publicApi).toBe(false);
    const store = new SqliteStore(':memory:');
    try {
      expect('database' in store).toBe(false);
      expect('db' in store).toBe(false);
    } finally {
      store.close();
    }
  });

  it('migrations_are_idempotent_contiguous_and_checksum_verified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's2-migrations-'));
    try {
      const dbPath = join(dir, 'db.sqlite');
      const db = new HubDatabase(dbPath);
      const first = db.doctor();
      db.withConnection((connection) => migrate(connection, join(process.cwd(), 'packages/storage-sqlite/src/migrations')));
      expect(first.ok).toBe(true);
      db.close();
      const driftDb = new HubDatabase(join(dir, 'drift.sqlite'));
      driftDb.withConnection((connection) => connection.prepare(`UPDATE schema_meta SET checksum='${'0'.repeat(64)}' WHERE version=1`).run());
      expect(driftDb.doctor().ok).toBe(false);
      expect(() => driftDb.withConnection((connection) => migrate(connection, join(process.cwd(), 'packages/storage-sqlite/src/migrations')))).toThrow();
      driftDb.close();
      expect(loadMigrations(join(process.cwd(), 'packages/storage-sqlite/src/migrations'))).toHaveLength(13);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('doctor_rejects_pending_idempotency_and_missing_audit_fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's2-doctor-'));
    const db = new HubDatabase(join(dir, 'db.sqlite'));
    try {
      db.withConnection((connection) => connection.prepare("INSERT INTO idempotency(key,actor_id,operation,request_digest,response_json,status,created_at) VALUES('k','usr_a','op','d','{}',102,'now')").run());
      expect(db.doctor().ok).toBe(false);
    } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('backup_restore_manifest_and_fresh_process_are_verified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's2-backup-'));
    try {
      const source = join(dir, 'source.sqlite');
      const destination = join(dir, 'backup.sqlite');
      const db = new HubDatabase(source);
      db.close();
      const manifest = await backupDatabase(source, destination);
      expect(manifest.sha256).toBe(createHash('sha256').update(await readFile(destination)).digest('hex'));
      const restored = new HubDatabase(destination);
      try { expect(restored.doctor().ok).toBe(true); } finally { restored.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('all_identity_binding_capability_schemas_compile_valid_and_invalid_fixtures', () => {
    const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
    const fixtures = {
      identity: [{ id: 'usr_valid', kind: 'user', displayName: 'Valid', createdAt: '2026-08-20T00:00:00.000Z' }, { id: 'not-opaque', kind: 'user' }],
      binding: [{ id: 'bnd_valid', assetId: 'asset', scope: { ownerUserId: 'usr_valid', agentId: 'agt_valid' }, harnessId: 'hrn_valid', version: 1, createdAt: '2026-08-20T00:00:00.000Z' }, { id: 'bad', version: 0 }],
      capabilities: ['read', 'not-a-capability'],
    } as const;
    for (const [name, values] of Object.entries(fixtures)) { const schema = JSON.parse(readFileSync(join(process.cwd(), `schemas/${name}.v1.json`), 'utf8')) as object; const validate = ajv.compile(schema); expect(validate(values[0]), `${name} valid fixture`).toBe(true); expect(validate(values[1]), `${name} invalid fixture`).toBe(false); }
  });

  it('single_sqlite_owner_scanner_rejects_non_storage_openings', async () => {
    const { scanSqliteOwners } = await import('../../scripts/scan-sqlite-owner.mjs');
    await expect(scanSqliteOwners(process.cwd())).resolves.toEqual({ ok: true, violations: [] });
  });
});
