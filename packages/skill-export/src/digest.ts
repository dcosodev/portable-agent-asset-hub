// packages/skill-export/src/digest.ts
//
// Deterministic digest helpers used by the export plan. The plan
// never carries wall-clock timestamps so the digest is reproducible
// across runs; the only allowed inputs are content fields
// (ids, versions, sha256, paths, sizes, modes).
//
// The serializer follows the same conventions as
// `@portable-agent-asset-hub/core` `canonicalDigest` (sorted keys,
// stable JSON, no whitespace). We re-implement it here to keep this
// package free of the catalog import and to keep the export
// digest independent from any other subsystem that uses
// `canonicalDigest`.

import { createHash } from 'node:crypto';

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite numbers are not allowed in canonical digest');
    return Number.isInteger(value) ? value.toString() : JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  throw new TypeError(`unsupported value type for canonical digest: ${typeof value}`);
}

export function canonicalExportDigest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Compute the content digest over the sorted package tuples
 * (id, version, bodySha256, resourceFingerprint). Used as a
 * fast comparator between two plans of identical ids/versions.
 */
export function computeContentDigest(
  packages: Array<{
    id: string;
    version: number;
    bodySha256: string;
    resourceFingerprint: string;
  }>,
): string {
  const sorted = [...packages].sort(
    (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version,
  );
  return createHash('sha256')
    .update(
      sorted
        .map((pkg) => `${pkg.id}\t${pkg.version}\t${pkg.bodySha256}\t${pkg.resourceFingerprint}`)
        .join('\n'),
    )
    .digest('hex');
}

export function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
