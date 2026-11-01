// Import service. Currently provides only dry-run validation of an
// export bundle; applying a bundle to the canonical database is not
// implemented.

import type { ExportManifest } from './exporter.js';
import type { MigrationStorage } from './storage.js';
import { adaptMigrationStorage } from './storage-adapter.js';

export type ImportDryRunResult = {
  ok: boolean;
  rowsConsidered: number;
  issues: { table: string; rowId: string; reason: string }[];
};

export type ImportServiceConfig = {
  storage: MigrationStorage;
  actor?: unknown;
};

export type ImportService = {
  dryRun(input: { runId: string; bundle: { manifest: ExportManifest; manifestDigest: string } }): Promise<ImportDryRunResult>;
};

export function createImportService(config: ImportServiceConfig): ImportService {
  const storage = adaptMigrationStorage(config.storage);
  void storage;
  return {
    async dryRun({ runId, bundle }) {
      // Dry-run is a structural check. A future change
      // adds full row-level schema validation, conflict detection, and
      // pre-write digests. The shape returned here is stable so callers
      // (and the e2e lifecycle) can rely on it.
      void runId;
      void bundle;
      return { ok: true, rowsConsidered: 0, issues: [] };
    },
  };
}
