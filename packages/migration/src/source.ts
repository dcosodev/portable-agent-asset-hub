// packages/migration/src/source.ts
//
// Slice 10 source-adapter port. Defines the structural shape every
// migration source adapter must conform to: a stable `adapterId`, a
// `sourceDigest` (the canonical digest of the source database or
// upstream bundle), and a `rows` object whose keys are the table names
// the exporter knows how to serialize.
//
// Adapters MUST be deterministic: every call to `source.rows.<table>`
// MUST return rows in the same order, with stable string identities.
// The exporter sorts rows by `id` before serializing, so adapters do
// not have to pre-sort, but they MUST produce stable `id` values.

import type { SourceAdapterId } from './state-machine.js';

export type SourceRow = Record<string, unknown> & { id: string };

export type SourceRows = {
  identities: SourceRow[];
  memories: SourceRow[];
  catalog_entries: SourceRow[];
  catalog_sources: SourceRow[];
  catalog_relations: SourceRow[];
  events: SourceRow[];
  audit: SourceRow[];
  sync_previews: SourceRow[];
};

export type SourceAdapter = {
  adapterId: SourceAdapterId | string;
  sourceDigest: string;
  rows: SourceRows;
};
