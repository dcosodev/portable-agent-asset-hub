import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { SkillInput, SkillVersion } from '../core/types.js';

type SkillRow = { id: string; version_id: string; slug: string; title: string; body: string; version: number; head: number; created_at: string };
function toSkill(row: SkillRow): SkillVersion { return { id: row.id, versionId: row.version_id, slug: row.slug, title: row.title, body: row.body, version: row.version, head: Boolean(row.head), createdAt: row.created_at }; }
function migrationSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(here, '../../migrations/001-skills.sql'), join(here, '../../../migrations/001-skills.sql')]) {
    try { return readFileSync(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error('MIGRATION_NOT_FOUND');
}

export class SkillSqliteStore {
  public readonly db: DatabaseSync;
  private failBeforeCommit = false;
  public constructor(path: string) { mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path); this.db.exec('PRAGMA journal_mode=WAL;'); this.db.exec(migrationSql()); }
  public create(input: SkillInput): SkillVersion {
    const now = new Date().toISOString(); const id = input.slug; const versionId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO skills VALUES(?,?,?,?,?,?,?,?)').run(id, versionId, input.slug, input.title, input.body, 1, 1, now);
      this.reindexHead(input.slug);
      if (this.failBeforeCommit) { this.failBeforeCommit = false; throw new Error('INJECTED_FAILURE'); }
      this.db.exec('COMMIT'); return { ...input, id, versionId, version: 1, head: true, createdAt: now };
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw error; }
  }
  public get(slug: string, version?: number): SkillVersion | undefined { const row = this.db.prepare('SELECT id,version_id,slug,title,body,version,head,created_at FROM skills WHERE slug=? AND (? IS NULL OR version=?) ORDER BY version DESC LIMIT 1').get(slug, version ?? null, version ?? null) as SkillRow | undefined; return row ? toSkill(row) : undefined; }
  public update(slug: string, expectedVersion: number, input: SkillInput): SkillVersion {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT id,version_id,slug,title,body,version,head,created_at FROM skills WHERE slug=? AND head=1').get(slug) as SkillRow | undefined;
      if (!current) throw new Error('NOT_FOUND'); if (expectedVersion !== current.version) throw new Error('STALE_VERSION');
      const now = new Date().toISOString(); const versionId = randomUUID();
      this.db.prepare('UPDATE skills SET head=0 WHERE slug=?').run(slug); this.db.prepare('INSERT INTO skills VALUES(?,?,?,?,?,?,?,?)').run(current.id, versionId, slug, input.title, input.body, current.version + 1, 1, now); this.reindexHead(slug);
      if (this.failBeforeCommit) { this.failBeforeCommit = false; throw new Error('INJECTED_FAILURE'); }
      this.db.exec('COMMIT'); return { ...input, slug, id: current.id, versionId, version: current.version + 1, head: true, createdAt: now };
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* already closed */ } throw error; }
  }
  public injectFailureBeforeCommit(): void { this.failBeforeCommit = true; }
  public versions(slug: string): SkillVersion[] { const rows = this.db.prepare('SELECT id,version_id,slug,title,body,version,head,created_at FROM skills WHERE slug=? ORDER BY version').all(slug) as unknown as SkillRow[]; return rows.map(toSkill); }
  public search(q: string): SkillVersion[] { const rows = this.db.prepare('SELECT s.id,s.version_id,s.slug,s.title,s.body,s.version,s.head,s.created_at FROM skills_fts JOIN skills s ON s.slug=skills_fts.slug AND s.version=(SELECT max(version) FROM skills h WHERE h.slug=s.slug AND h.head=1) WHERE skills_fts MATCH ? AND s.head=1 ORDER BY bm25(skills_fts)').all(q) as unknown as SkillRow[]; return rows.map(toSkill); }
  private reindexHead(slug: string): void { const head = this.db.prepare('SELECT id,version_id,slug,title,body,version,head,created_at FROM skills WHERE slug=? AND head=1').get(slug) as SkillRow | undefined; this.db.prepare('DELETE FROM skills_fts WHERE slug=?').run(slug); if (head) this.db.prepare('INSERT INTO skills_fts(rowid,slug,title,body) SELECT rowid,?,?,? FROM skills WHERE id=? AND version=?').run(slug, head.title, head.body, head.id, head.version); }
  public close(): void { this.db.close(); }
}
