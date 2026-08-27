// packages/core/src/importer/derivation.ts
//
// Phase 2 — Pure skill name derivation helpers.
//
// These helpers NEVER touch the filesystem, NEVER depend on `node:fs`
// or `node:path`, and have no observable side effects. They belong in
// `core` because both the catalog scanner, the importer, and any
// future tooling need to reason about skill ids and logical keys
// without paying the cost of importing `@portable-agent-asset-hub/storage-files`.
//
//   * `skl_` identifier: derived from the normalized declared name.
//     Different declared names never collide; the importer rejects
//     duplicate-name collisions upstream so two roots sharing the
//     same name collapse into a single `(id, logicalKey)` pair.
//   * `skill:<normalized>` logical key: identical to the
//     `CatalogRepository.getByLogicalKey` shape used by the catalog
//     FTS projection. Skills sourced from the inventory therefore
//     surface through the same catalog search path as skills
//     registered through `SyncService`.
//   * `normalizeName`: NFKC-trimmed, lowercased, whitespace- and
//     dash-collapsed. Pure.

import { createHash } from 'node:crypto';

import { HubError } from '../errors.js';

/**
 * Stable skill id of the form `skl_<16 hex chars>` derived from the
 * normalized declared name. Collisions across roots are impossible
 * once the name is normalized — the importer enforces a fail-closed
 * duplicate-name rejection upstream so the same name coming from two
 * different roots is rejected before this point.
 */
export function deriveSkillId(name: string): string {
  const normalized = normalizeName(name);
  if (normalized.length === 0) {
    throw new HubError('VALIDATION', 'skill name must be non-empty after normalization', 400);
  }
  const digest = createHash('sha256').update(`skill-id:${normalized}`).digest('hex');
  return `skl_${digest.slice(0, 16)}`;
}

/**
 * Stable logical key for the catalog. Format: `skill:<normalized-name>`.
 * Independent of roots, paths and runtime.
 */
export function deriveLogicalKey(name: string): string {
  const normalized = normalizeName(name);
  if (normalized.length === 0) {
    throw new HubError('VALIDATION', 'skill logical key name must be non-empty after normalization', 400);
  }
  return `skill:${normalized}`;
}

/**
 * Lowercased, trimmed, whitespace/dash-collapsed name.
 *
 *   "  Alpha Skill  " → "alpha-skill"
 *   "openclaw__skill" → "openclaw-skill"
 *   "weird/name!"     → "weird-name"
 */
export function normalizeName(name: string): string {
  return String(name)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-')
    .replace(/[^a-z0-9.-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
}
