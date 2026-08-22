// packages/materializers/src/openclaw/manifest.ts
//
// OpenClaw adapter: the canonical renderer for Slice 9. Reuses the
// S8 renderer-agnostic contracts (ManifestV1, RendererAdapter) and
// pins the OpenClaw-specific layout under
// `<stateDir>/agents/<agentId>/...`. The rendererVersion stays at
// `0.1.0` so a Hermes and OpenClaw manifest compiled from the same
// snapshot share the same `rendererVersion` — only the layout
// (`harness` + relative paths) differs.

import type { ManifestV1, RendererAdapter } from '../contracts.js';
import { buildMaterializationPlan } from '../manifest.js';
import { renderOpenclawFiles } from './paths.js';

export const OPENCLAW_RENDERER_VERSION = '0.1.0';

export const openclawAdapter: RendererAdapter = {
  id: 'openclaw',
  manifestPath: '.pah/manifest.v1.json',
  rendererVersion: OPENCLAW_RENDERER_VERSION,
  render(profile): { files: ReturnType<typeof renderOpenclawFiles> } {
    return { files: renderOpenclawFiles(profile) };
  },
};

/**
 * Build a frozen OpenClaw manifest for a profile + state dir. The
 * caller (preview pipeline) passes this straight to `applyPlan`.
 */
export function buildOpenclawManifest(input: {
  snapshotId: string;
  profileId: string;
  targetRoot: string;
  profile: Parameters<typeof renderOpenclawFiles>[0];
  generatedAt?: string;
}): ManifestV1 {
  return buildMaterializationPlan({
    harness: 'openclaw',
    profileId: input.profileId,
    snapshotId: input.snapshotId,
    targetRoot: input.targetRoot,
    files: renderOpenclawFiles(input.profile),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    rendererVersion: OPENCLAW_RENDERER_VERSION,
  });
}
