// packages/migration/src/rollback.ts
//
// Slice 10 rollback service. Rollback is the inverse of cutover: it
// restores the canonical writer to the previous (legacy) sink, using
// a snapshot taken before cutover. Rollback is only legal in the
// `rollback_window` state; outside of that window the service refuses.
//
// For S10 GREEN core the surface is pinned; the implementation ships in
// a later slice that wires the migration package to the canonical
// SqliteStore.

import type { MigrationStorage } from './storage.js';
import { adaptMigrationStorage } from './storage-adapter.js';

export type RollbackServiceConfig = {
  storage: MigrationStorage;
  actor?: unknown;
};

export type RollbackService = {
  execute(input: { runId: string }): Promise<{ restored: string[]; previousWriter: 'hub' | 'legacy' }>;
};

export function createRollbackService(config: RollbackServiceConfig): RollbackService {
  void adaptMigrationStorage(config.storage);
  return {
    async execute() {
      return { restored: ['__placeholder__'], previousWriter: 'hub' };
    },
  };
}
