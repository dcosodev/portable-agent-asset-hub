import type { DatabaseSync } from 'node:sqlite';
import { HubError, type ActorContext, type StorageTransaction } from '@portable-agent-asset-hub/core';
import { AuditRepository } from './repositories/audit.js';
import { SqliteMaterializationRepository, SqliteProfileRepository } from './profile-repository.js';
import { SqliteCatalogRepository } from './catalog-repository.js';
import { SqliteCatalogSyncRepository } from './catalog-sync-repository.js';

export function transaction<T>(
  db: DatabaseSync,
  actor: ActorContext,
  fn: (tx: StorageTransaction) => T,
  repositories: (audit: AuditRepository, assertActive: () => void) => Omit<StorageTransaction, 'audit' | 'profiles' | 'materializations' | 'catalog' | 'catalogSync'>,
): T {
  db.exec('BEGIN IMMEDIATE');
  let active = true;
  const assertActive = (): void => {
    if (!active) throw new HubError('INTERNAL', 'transaction repository expired', 500);
  };
  try {
    const audit = new AuditRepository(db);
    const base = repositories(audit, assertActive);
    const result = fn({
      ...base,
      audit,
      profiles: new SqliteProfileRepository(db, actor, audit, assertActive),
      materializations: new SqliteMaterializationRepository(db, actor, audit, assertActive),
      catalog: new SqliteCatalogRepository(db, actor, audit, assertActive),
      catalogSync: new SqliteCatalogSyncRepository(db, actor, audit, assertActive),
    });
    db.exec('COMMIT');
    active = false;
    return result;
  } catch (error) {
    active = false;
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    if (error instanceof HubError) throw error;
    throw new HubError('INTERNAL', error instanceof Error ? error.message : 'transaction failed', 500);
  } finally {
    active = false;
  }
}
