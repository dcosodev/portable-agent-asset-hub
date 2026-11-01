// Cutover service. The cutover is the moment the canonical
// store is repointed at the imported bundle. Until this point the
// canonical store is untouched; cutover acquires a process-wide lock,
// verifies digests, flips the writer, and unlocks.
//
// Not fully implemented: the surface is stable, but the package is not
// yet wired to the canonical SqliteStore.

import type { MigrationStorage } from './storage.js';
import { adaptMigrationStorage } from './storage-adapter.js';

export type CutoverServiceConfig = {
  storage: MigrationStorage;
  actor?: unknown;
};

export type CutoverService = {
  activate(input: { runId: string }): Promise<{ writer: 'hub' | 'legacy'; lockAcquired: boolean }>;
};

export function createCutoverService(config: CutoverServiceConfig): CutoverService {
  void adaptMigrationStorage(config.storage);
  return {
    async activate() {
      return { writer: 'hub', lockAcquired: true };
    },
  };
}
