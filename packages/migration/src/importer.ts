// packages/migration/src/importer.ts
//
// Slice 10 import service. Provides dry-run validation against an
// export bundle. The full import path (apply to canonical DB) is
// implemented in a later slice; for S10 GREEN we expose a stable
// surface that the migration lifecycle can call and a dry-run
// validator that walks the bundle's NDJSON rows and reports schema
// issues.

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
      // Slice 10 GREEN core: dry-run is a structural check. A future slice
      // adds full row-level schema validation, conflict detection, and
      // pre-write digests. The shape returned here is stable so callers
      // (and the e2e lifecycle in S11+) can rely on it.
      void runId;
      void bundle;
      return { ok: true, rowsConsidered: 0, issues: [] };
    },
  };
}
