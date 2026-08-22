// packages/materializers/src/hermes/manifest.ts
//
// Hermes adapter: the canonical renderer for Slice 8. Slice 9 ships an
// `openclawAdapter` with the same shape but a different layout (see
// the S9 plan). The adapter is what the apply pipeline hands a
// Profile; it returns the file list the manifest will contain.

import type { ManifestV1, RendererAdapter } from '../contracts.js';
import { buildMaterializationPlan, canonicalizeManifest } from '../manifest.js';
import { renderHermesFiles } from './paths.js';
import { createHash } from 'node:crypto';

export const HERMES_RENDERER_VERSION = '0.1.0';

export const hermesAdapter: RendererAdapter = {
  id: 'hermes',
  manifestPath: '.pah/manifest.v1.json',
  rendererVersion: HERMES_RENDERER_VERSION,
  render(profile): { files: ReturnType<typeof renderHermesFiles> } {
    return { files: renderHermesFiles(profile) };
  },
};

/**
 * Build a frozen Hermes manifest for a profile + target. The caller
 * (preview pipeline) passes this straight to `applyPlan`.
 */
export function buildHermesManifest(input: {
  snapshotId: string;
  profileId: string;
  targetRoot: string;
  profile: Parameters<typeof renderHermesFiles>[0];
  generatedAt?: string;
}): ManifestV1 {
  return buildMaterializationPlan({
    harness: 'hermes',
    profileId: input.profileId,
    snapshotId: input.snapshotId,
    targetRoot: input.targetRoot,
    files: renderHermesFiles(input.profile),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    rendererVersion: HERMES_RENDERER_VERSION,
  });
}

/**
 * Helper for tests: hash the manifest bytes (the bytes-on-disk form,
 * not the canonical projection). Used by hermes-materialization.e2e.
 */
export function digestManifestBytes(plan: ManifestV1): string {
  return createHash('sha256').update(canonicalizeManifest(plan)).digest('hex');
}
