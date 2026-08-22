// packages/materializers/src/preview.ts
//
// The renderer-agnostic preview pipeline. Given a (store, actor,
// harness, profileId, snapshotId, targetRoot) tuple, it:
//   1. Loads the Profile from storage under the actor's scope.
//   2. Runs the renderer adapter for the harness.
//   3. Builds the frozen ManifestV1 plan.
//   4. Returns the plan + the canonical digest (observedDigest).
//
// The function never writes to disk — it only validates inputs and
// renders the plan. Drift detection, apply, and rollback live in
// `apply.ts` / `rollback.ts`.

import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActorContext, Storage } from '@portable-agent-asset-hub/core';
import { HubError } from '@portable-agent-asset-hub/core';
import { hermesAdapter } from './hermes/index.js';
import { openclawAdapter } from './openclaw/manifest.js';
import { buildMaterializationPlan, digestPlan } from './manifest.js';
import type { HarnessId, ManifestV1, PreviewInput, PreviewResult, RendererAdapter } from './contracts.js';
import { assertSafeRelativePath } from './manifest.js';

/**
 * Reject target roots that are not real, existing, non-symlink
 * directories. The preview/apply/rollback pipeline must never operate
 * against an attacker-controlled symlink (defence in depth matches
 * Slice 4's `FileMaterializer` rule).
 */
export function assertSafeTargetRoot(targetRoot: string): string {
  if (!targetRoot || typeof targetRoot !== 'string') {
    throw new HubError('VALIDATION', 'targetRoot required', 400);
  }
  const absolute = resolve(targetRoot);
  if (!existsSync(absolute)) {
    throw new HubError('VALIDATION', `targetRoot not found: ${absolute}`, 400);
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    throw new HubError('VALIDATION', 'symlink targetRoot rejected', 400);
  }
  if (!stat.isDirectory()) {
    throw new HubError('VALIDATION', 'targetRoot must be a directory', 400);
  }
  return absolute;
}

const adapters: Record<HarnessId, RendererAdapter> = {
  hermes: hermesAdapter,
  openclaw: openclawAdapter,
};

export function registerAdapter(harness: HarnessId, adapter: RendererAdapter): void {
  adapters[harness] = adapter;
}

export function getAdapter(harness: HarnessId): RendererAdapter {
  const adapter = adapters[harness];
  if (!adapter) throw new HubError('VALIDATION', `unsupported harness: ${harness}`, 400);
  return adapter;
}

export function computePreview(
  store: Storage,
  actor: ActorContext,
  input: PreviewInput,
): PreviewResult {
  // Validate inputs up front so we never reach the renderer with bad
  // data.
  assertSafeTargetRoot(input.targetRoot);
  if (!/^prf_[A-Za-z0-9._-]+$/u.test(input.profileId)) {
    throw new HubError('VALIDATION', 'invalid profileId', 400);
  }
  if (!/^snap_[A-Za-z0-9._-]+$/u.test(input.snapshotId)) {
    throw new HubError('VALIDATION', 'invalid snapshotId', 400);
  }
  const adapter = getAdapter(input.harness);
  const profile = store.transaction(actor, (tx) => tx.profiles.get(input.profileId, actor.scope));
  const rendered = adapter.render(profile);
  for (const file of rendered.files) {
    assertSafeRelativePath(file.relativePath);
  }
  const plan: ManifestV1 = buildMaterializationPlan({
    harness: input.harness,
    profileId: input.profileId,
    snapshotId: input.snapshotId,
    targetRoot: input.targetRoot,
    files: rendered.files,
    rendererVersion: adapter.rendererVersion,
  });
  return {
    plan,
    profile,
    observedDigest: digestPlan(plan),
  };
}
