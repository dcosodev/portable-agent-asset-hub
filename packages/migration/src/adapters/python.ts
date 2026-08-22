// packages/migration/src/adapters/python.ts
//
// Slice 10 source adapter for the legacy Python v2 hub. The Python v2
// hub exposed 8 row tables (identities, memories, catalog_entries,
// catalog_sources, catalog_relations, events, audit, sync_previews)
// keyed by stable string ids. The adapter is constructed from a
// pre-fetched snapshot (so it can be backed by either a live SQLite
// read or an in-memory fixture) and exposes the rows as-is to the
// exporter.
//
// The adapter never opens SQLite itself; the caller supplies the
// snapshot. This keeps the migration package decoupled from any
// specific upstream persistence mechanism.

import { SOURCE_ADAPTER_IDS, type SourceAdapterId } from '../state-machine.js';
import type { SourceAdapter, SourceRows } from '../source.js';

export type PythonV2AdapterConfig = {
  rows: SourceRows;
  sourceDigest: string;
  adapterId?: SourceAdapterId;
};

export type PythonV2SourceAdapter = SourceAdapter;

export function createPythonV2SourceAdapter(config: PythonV2AdapterConfig): PythonV2SourceAdapter {
  const adapterId = config.adapterId ?? SOURCE_ADAPTER_IDS[0];
  return {
    adapterId,
    sourceDigest: config.sourceDigest,
    rows: config.rows,
  };
}
