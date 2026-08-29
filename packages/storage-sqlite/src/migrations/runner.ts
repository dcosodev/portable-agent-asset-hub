import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubError } from '@portable-agent-asset-hub/core';

export type Migration = { version: number; name: string; sql: string; checksum: string };
export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir).filter((name) => /^\d{4}_.*\.sql$/u.test(name)).sort().map((name) => {
    const match = /^(\d{4})_(.*)\.sql$/u.exec(name);
    if (!match) throw new HubError('MIGRATION_GAP', `invalid migration name: ${name}`, 500);
    const sql = readFileSync(join(dir, name), 'utf8');
    return { version: Number(match[1]), name: match[2], sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}
export function migrate(db: DatabaseSync, dir: string): void {
  const migrations = loadMigrations(dir);
  if (migrations.length !== 20 || migrations.some((migration, index) => migration.version !== index + 1)) throw new HubError('MIGRATION_GAP', 'migration sequence must be continuous 0001-0020', 500);
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const migration of migrations) {
    const old = db.prepare('SELECT checksum,name FROM schema_meta WHERE version=?').get(migration.version) as { checksum: string; name: string } | undefined;
    if (old && (old.checksum !== migration.checksum || old.name !== migration.name)) throw new HubError('MIGRATION_DRIFT', `migration drift ${migration.version}`, 500);
    if (!old) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_meta(version,name,checksum,applied_at) VALUES(?,?,?,?)').run(migration.version, migration.name, migration.checksum, new Date().toISOString());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }
}
