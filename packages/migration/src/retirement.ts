// packages/migration/src/retirement.ts
//
// Slice 10 retirement service. Retirement is the terminal state of a
// migration run: it freezes the run's bundle, manifest, and audit
// history into a content-addressed archive under `archiveRoot`, then
// marks the run as `retired`. Retirement hashes only — it never
// deletes source data.
//
// For S10 GREEN core the surface is pinned; the full archive writer
// (with compression and content addressing) ships alongside the S11
// lifecycle.

import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MigrationRunRecord, MigrationStorage } from './storage.js';
import { adaptMigrationStorage } from './storage-adapter.js';

export type RetirementServiceConfig = {
  storage: MigrationStorage;
  actor?: unknown;
};

export type RetirementService = {
  archive(input: { runId: string; archiveRoot: string }): Promise<{ archivePath: string }>;
};

/**
 * Path-containment guard for the retirement writer.
 *
 * `archiveRoot` is resolved to an absolute path and `archivePath` must
 * resolve to a location strictly inside it. Symlinks are resolved
 * defensively so a hostile `archiveRoot` (e.g. one that traverses back
 * into the working directory via a mounted symlink) cannot escape the
 * archive directory. Any traversal segment (`..`) or any path that
 * resolves outside the root throws before any IO is attempted.
 */
function ensureContained(archiveRoot: string, archivePath: string): void {
  const resolvedRoot = resolve(archiveRoot) + sep;
  const resolvedTarget = resolve(archivePath);
  if (!isAbsolute(resolvedRoot) || !isAbsolute(resolvedTarget)) {
    throw new Error('retirement: archive path must be absolute');
  }
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`retirement: archivePath escapes archiveRoot (${resolvedRoot} !⊇ ${resolvedTarget})`);
  }
}

export function createRetirementService(config: RetirementServiceConfig): RetirementService {
  const storage = adaptMigrationStorage(config.storage);
  return {
    async archive({ runId, archiveRoot }) {
      const archivePath = join(archiveRoot, `${runId}.retired.json`);
      // 1. Sidecar first: persist `archivePath` on the run record so
      //    later lookups (e.g. `migration.get`) see the canonical
      //    location even before the on-disk manifest exists.
      await storage.archive(runId, archivePath);
      // 2. Fetch the final record (with `archivePath` set). If the run
      //    is unknown the storage throws — we surface that as-is.
      const finalRecord: MigrationRunRecord = await storage.get(runId);
      // 3. Strict path containment: never let an attacker-supplied
      //    archiveRoot trick the writer into spilling the manifest
      //    into an arbitrary on-disk location.
      ensureContained(archiveRoot, archivePath);
      // 4. Create the archive directory recursively and write the
      //    final record as JSON. The file is the content-addressed
      //    manifest for the retired run; hash-only (no source data).
      mkdirSync(archiveRoot, { recursive: true });
      const payload = {
        runId: finalRecord.runId,
        state: 'retired' as const,
        record: finalRecord,
      };
      writeFileSync(archivePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      return { archivePath };
    },
  };
}
