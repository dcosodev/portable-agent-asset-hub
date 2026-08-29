import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import { loadMigrations, migrate } from '../../packages/storage-sqlite/src/migrations/runner.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('migration 0020 relation proposal auto-approval provenance', () => {
  it('upgrades an existing schema 0019 database to 0020', () => {
    const root = mkdtempSync(join(tmpdir(), 'migration-0019-to-0020-'));
    roots.push(root);
    const dbPath = join(root, 'hub.sqlite');
    const migrationsDir = join(process.cwd(), 'packages/storage-sqlite/src/migrations');
    const migrations = loadMigrations(migrationsDir);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE schema_meta (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of migrations.slice(0, 19)) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_meta(version,name,checksum,applied_at) VALUES(?,?,?,?)')
          .run(migration.version, migration.name, migration.checksum, new Date(0).toISOString());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    expect((db.prepare('SELECT MAX(version) AS version FROM schema_meta').get() as { version: number }).version).toBe(19);
    expect((db.prepare('PRAGMA table_info(skill_relation_proposals)').all() as Array<{ name: string }>).map((column) => column.name)).not.toContain('approval_mode');

    migrate(db, migrationsDir);

    expect((db.prepare('SELECT MAX(version) AS version FROM schema_meta').get() as { version: number }).version).toBe(20);
    expect((db.prepare('PRAGMA table_info(skill_relation_proposals)').all() as Array<{ name: string }>).map((column) => column.name)).toEqual(expect.arrayContaining(['approval_mode', 'auto_approve_rule']));
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    db.close();

    const reopened = new SqliteStore(dbPath);
    try {
      expect(reopened.doctor().ok).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it('adds closed-by-default provenance columns and survives reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'migration-0020-'));
    roots.push(root);
    const dbPath = join(root, 'hub.sqlite');

    const store = new SqliteStore(dbPath);
    expect(store.doctor().ok).toBe(true);
    store.close();

    const probe = new DatabaseSync(dbPath);
    const columns = probe.prepare('PRAGMA table_info(skill_relation_proposals)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(columns).toContainEqual(expect.objectContaining({ name: 'approval_mode', notnull: 1, dflt_value: "'human'" }));
    expect(columns).toContainEqual(expect.objectContaining({ name: 'auto_approve_rule', notnull: 0, dflt_value: null }));

    const indexes = probe.prepare('PRAGMA index_list(skill_relation_proposals)').all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain('skill_relation_proposals_approval_mode');
    expect((probe.prepare('SELECT MAX(version) AS version FROM schema_meta').get() as { version: number }).version).toBe(20);
    expect((probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    probe.close();

    const reopened = new SqliteStore(dbPath);
    try {
      expect(reopened.doctor().ok).toBe(true);
    } finally {
      reopened.close();
    }
  });
});
