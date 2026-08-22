// packages/migration/src/exporter.ts
//
// Slice 10 deterministic export service.
//
// The exporter reads rows from a SourceAdapter (e.g. the python-v2
// adapter) and writes a deterministic NDJSON bundle to `workdir`:
//
//   <workdir>/
//     manifest.json          # canonical manifest
//     identities.ndjson      # one JSON object per line, sorted by id
//     memories.ndjson
//     catalog_entries.ndjson
//     catalog_sources.ndjson
//     catalog_relations.ndjson
//     events.ndjson
//     audit.ndjson
//     sync_previews.ndjson
//
// Each NDJSON file is content-hashed (SHA-256). The manifest lists
// every file with its digest + row count. The manifest itself is then
// content-hashed to produce `manifestDigest`. The whole pipeline is
// pure: two calls with the same source and same classification policy
// MUST return identical `manifestDigest` and identical `files[]`.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactPayload } from './redactor.js';
import type { SourceAdapter } from './source.js';

export type ExportFileEntry = {
  path: string;
  digest: string;
  count: number;
  content: string;
};

export type ExportManifest = {
  schemaVersion: 1;
  adapterId: string;
  sourceDigest: string;
  counts: Record<string, number>;
  files: { path: string; digest: string; count: number }[];
  classification: { default: 'INTERNAL' | 'PUBLIC' | 'SENSITIVE' | 'SECRET' };
};

export type ExportResult = {
  manifest: ExportManifest;
  manifestDigest: string;
  files: ExportFileEntry[];
};

export type ExportServiceConfig = {
  classification?: { default: 'INTERNAL' | 'PUBLIC' | 'SENSITIVE' | 'SECRET' };
};

export type ExportService = {
  run(input: { source: SourceAdapter; workdir: string }): Promise<ExportResult>;
};

const TABLE_ORDER: ReadonlyArray<keyof SourceAdapter['rows']> = [
  'identities',
  'memories',
  'catalog_entries',
  'catalog_sources',
  'catalog_relations',
  'events',
  'audit',
  'sync_previews',
];

function stableStringify(value: unknown): string {
  // Deterministic JSON: keys sorted at every object level, no whitespace.
  // We require every leaf to be JSON-safe; undefined values are dropped
  // (standard JSON behaviour) and circular references throw.
  const seen = new WeakSet<object>();
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) {
      throw new Error('stableStringify: circular reference');
    }
    seen.add(node);
    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }
    const obj = node as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      sorted[key] = walk(v);
    }
    return sorted;
  };
  return JSON.stringify(walk(value));
}

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sortRows(rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    const ak = String(a.id ?? '');
    const bk = String(b.id ?? '');
    if (ak < bk) return -1;
    if (ak > bk) return 1;
    return 0;
  });
}

export function createExportService(config: ExportServiceConfig = {}): ExportService {
  const classificationDefault = config.classification?.default ?? 'INTERNAL';

  return {
    async run({ source, workdir }) {
      mkdirSync(workdir, { recursive: true });

      const counts: Record<string, number> = {};
      const files: ExportFileEntry[] = [];

      for (const table of TABLE_ORDER) {
        const rows = source.rows[table] ?? [];
        const sorted = sortRows(rows);
        const redactedRows = sorted.map((row) => redactPayload(row));
        const content = redactedRows.map((row) => stableStringify(row)).join('\n') + (sorted.length > 0 ? '\n' : '');
        const digest = digestOf(content);
        counts[table] = sorted.length;
        const relPath = `${table}.ndjson`;
        writeFileSync(join(workdir, relPath), content, 'utf8');
        files.push({ path: relPath, digest, count: sorted.length, content });
      }

      const fileDescriptors = files
        .map((f) => ({ path: f.path, digest: f.digest, count: f.count }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

      const manifest: ExportManifest = {
        schemaVersion: 1,
        adapterId: source.adapterId,
        sourceDigest: source.sourceDigest,
        counts,
        files: fileDescriptors,
        classification: { default: classificationDefault },
      };

      const manifestJson = stableStringify(manifest);
      const manifestDigest = digestOf(manifestJson);
      writeFileSync(join(workdir, 'manifest.json'), manifestJson + '\n', 'utf8');

      return {
        manifest,
        manifestDigest,
        files: files
          .map((f) => ({ path: f.path, digest: f.digest, count: f.count, content: f.content }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      };
    },
  };
}
