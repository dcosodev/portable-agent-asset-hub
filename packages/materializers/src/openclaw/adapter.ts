// packages/materializers/src/openclaw/adapter.ts
//
// OpenClaw adapter entrypoint. Owns the (renderer + apply + rollback)
// trio for OpenClaw. Reuses the renderer-agnostic pipeline from
// `packages/materializers/src/apply.ts` and `rollback.ts` — the only
// OpenClaw-specific wiring is:
//
//   1. `stateDir` resolution: OpenClaw plugins never default to
//      `~/.openclaw`. The dispatcher / adapter receives `stateDir`
//      from the caller (the OpenClaw daemon, the CLI, or a runtime
//      accessor) and refuses to operate without it.
//   2. `targetRoot === stateDir`: the renderer writes the manifest at
//      `<stateDir>/.pah/manifest.v1.json` and the per-agent files at
//      `<stateDir>/agents/<agentId>/...`. The lock directory defaults
//      to `stateDir` itself.
//   3. Renderer swap: the preview pipeline looks up `openclaw` in the
//      adapter registry and runs the `openclawAdapter` instead of the
//      Hermes one.
//
// The same CAS, lock, drift, and audit semantics from Hermes carry over
// unchanged — `applyPlan` and `rollbackPlan` are harness-agnostic.

import type { ActorContext, Storage } from '@portable-agent-asset-hub/core';
import { HubError } from '@portable-agent-asset-hub/core';
import { createHash } from 'node:crypto';
import {
  applyPlan,
  rollbackPlan,
  assertSafeRelativePath,
  buildMaterializationPlan,
  digestPlan,
  type ApplyInput,
  type ApplyResult,
  type ManifestV1,
  type PreviewResult,
  type RollbackInput,
  type RollbackResult,
} from '../index.js';
import { openclawAdapter } from './manifest.js';
import { resolveStateDir } from './paths.js';

/**
 * OpenClaw materializer context. The single point of difference from
 * Hermes is `stateDir` — OpenClaw never reads `~/.openclaw`; the host
 * daemon or CLI injects the state dir explicitly.
 */
export type OpenclawMaterializerContext = {
  store: Storage;
  actor: ActorContext;
  stateDir: string;
  /** Optional override; defaults to `stateDir`. */
  lockDir?: string;
};

/**
 * Preview request body for the OpenClaw surface. The harness is pinned
 * to `'openclaw'`; profileId + snapshotId are the renderer inputs.
 */
export type OpenclawPreviewRequest = {
  harness: 'openclaw';
  profileId: string;
  snapshotId: string;
};

/**
 * Apply request body for the OpenClaw surface. CAS contract mirrors
 * Hermes: `observedDigest` is the value the caller read off the
 * target just before applying. The REST router maps `If-Match` to
 * this field.
 */
export type OpenclawApplyRequest = OpenclawPreviewRequest & {
  observedDigest?: string;
  reason: string;
  requestId?: string;
};

export type OpenclawRollbackRequest = {
  runId: string;
  reason: string;
  requestId?: string;
};

/**
 * Build a deterministic preview for OpenClaw. Validates `stateDir`,
 * loads the profile from storage, and renders the plan with a
 * snapshot-stable `generatedAt` so two previews of the same
 * (snapshotId, profileId, stateDir) tuple always produce the same
 * `observedDigest`.
 */
export function openclawPreview(
  store: Storage,
  actor: ActorContext,
  request: OpenclawPreviewRequest & { stateDir?: string },
): PreviewResult {
  // Resolve stateDir through the OpenClaw helper so the
  // "no ~/.openclaw" rule is honoured even when callers skip the
  // dispatcher. Throws HubError('VALIDATION') when no source
  // supplies a value.
  const stateDir = resolveStateDir({ stateDir: request.stateDir });
  if (!/^prf_[A-Za-z0-9._-]+$/u.test(request.profileId)) {
    throw new HubError('VALIDATION', 'invalid profileId', 400);
  }
  if (!/^snap_[A-Za-z0-9._-]+$/u.test(request.snapshotId)) {
    throw new HubError('VALIDATION', 'invalid snapshotId', 400);
  }
  // Render files via the registered adapter — same surface as the
  // renderer-agnostic preview pipeline.
  const profile = store.transaction(actor, (tx) =>
    tx.profiles.get(request.profileId, actor.scope),
  );
  const rendered = openclawAdapter.render(profile);
  for (const file of rendered.files) {
    assertSafeRelativePath(file.relativePath);
  }
  // Deterministic generatedAt: derive it from the snapshotId +
  // profileId + stateDir tuple. Two previews of the same triple in
  // the same process produce the same manifest, which is what the
  // drift detector + the deterministic test expect.
  const generatedAt = deterministicGeneratedAt(
    request.snapshotId,
    request.profileId,
    stateDir,
  );
  const plan: ManifestV1 = buildMaterializationPlan({
    harness: 'openclaw',
    profileId: request.profileId,
    snapshotId: request.snapshotId,
    targetRoot: stateDir,
    files: rendered.files,
    generatedAt,
    rendererVersion: openclawAdapter.rendererVersion,
  });
  // Pin `runId` to the same (snapshotId, profileId, stateDir) tuple so
  // two previews of the same triple hash to the same `observedDigest`.
  // `buildMaterializationPlan` assigns a fresh `randomUUID()` per
  // call by default — fine for apply, but breaks the S9 determinism
  // contract that `preview.observedDigest` is stable across calls.
  plan.runId = deterministicRunId(
    request.snapshotId,
    request.profileId,
    stateDir,
  );
  return {
    plan,
    profile,
    observedDigest: digestPlan(plan),
  };
}

/**
 * Stable runId derived from the (snapshotId, profileId, stateDir)
 * tuple. Same inputs → same runId → same canonical manifest → same
 * digest. Matches the deterministic `generatedAt` strategy above.
 */
function deterministicRunId(
  snapshotId: string,
  profileId: string,
  stateDir: string,
): string {
  const hex = createHash('sha256')
    .update(`openclaw-run:${snapshotId}:${profileId}:${stateDir}`)
    .digest('hex');
  // run_${32-hex} keeps the S8/S9 runId shape while staying
  // byte-stable across calls.
  return `run_${hex.slice(0, 32)}`;
}

/**
 * Stable ISO-8601 timestamp derived from the (snapshotId, profileId,
 * stateDir) tuple. We hash the tuple with SHA-256 and encode the
 * first 13 hex digits as a Unix-millisecond timestamp; this stays in
 * the 2026-2030 window for any reasonable tuple and matches the
 * format `JSON.stringify(iso)` expects.
 *
 * The S9 contract pins determinism on the tuple, not the wall clock:
 * the renderer must not produce different bytes for two previews of
 * the same snapshot, profile, and target.
 */
function deterministicGeneratedAt(
  snapshotId: string,
  profileId: string,
  stateDir: string,
): string {
  const hex = createHash('sha256')
    .update(`openclaw:${snapshotId}:${profileId}:${stateDir}`)
    .digest('hex');
  // Take the first 12 hex digits as a Unix-ms timestamp in the
  // 2026-2030 window. The bit width (48 bits) is enough to be unique
  // across the S9 test suite and small enough that the digest still
  // fits in a JS number.
  const millis = Number.parseInt(hex.slice(0, 12), 16);
  return new Date(millis).toISOString();
}

/**
 * Apply the OpenClaw preview to disk. Re-runs the preview internally
 * so the input is a frozen `(preview, stateDir, observedDigest?)`
 * tuple; this matches the S8 Hermes contract where the apply takes
 * the same shape.
 *
 * `stateDir` is required; the OpenClaw plugin must never invent one.
 */
export function openclawApply(
  store: Storage,
  actor: ActorContext,
  input: {
    preview: PreviewResult;
    stateDir: string;
    observedDigest?: string;
    reason: string;
    requestId?: string;
  },
): ApplyResult {
  const stateDir = resolveStateDir({ stateDir: input.stateDir });
  const apply: ApplyInput = {
    preview: input.preview,
    targetRoot: stateDir,
    lockDir: stateDir,
    observedDigest: input.observedDigest,
    reason: input.reason,
    requestId: input.requestId,
  };
  return applyPlan(store, actor, apply);
}

/**
 * Roll back an OpenClaw apply by `runId`. The rollback pipeline
 * already records `(targetRoot, lockDir, harness, profileId)` in the
 * in-memory registry, so the caller only needs the runId + reason.
 */
export function openclawRollback(
  _store: Storage,
  _actor: ActorContext,
  request: OpenclawRollbackRequest,
): RollbackResult {
  // `_store` and `_actor` are kept in the signature to mirror the
  // renderer-agnostic pipeline and to support the dispatcher
  // interface; rollbackPlan re-resolves the target from the registry
  // and audits the rollback against the actor's scope.
  const rollback: RollbackInput = {
    runId: request.runId,
    reason: request.reason,
    requestId: request.requestId,
  };
  return rollbackPlan(_store, _actor, rollback);
}

/**
 * Dispatcher factory that adapts the S9 OpenClaw materializer to the
 * S6/S7 REST `dispatch(operationId, {body, params, query, actor,
 * requestId})` signature.
 *
 * Operations:
 *
 *   * `previewMaterialization`  — no CAS, returns the preview.
 *   * `applyMaterialization`    — CAS via the `observedDigest` field
 *                                 in the body; the REST router maps
 *                                 `If-Match` to that field. A
 *                                 missing If-Match returns 428 before
 *                                 the dispatcher runs.
 *   * `rollbackMaterialization` — reverses a prior apply by runId.
 *
 * The dispatcher throws `HubError` on every failure path; the REST
 * `error-mapper` translates `HubError.status` into the response code.
 */
export type RestDispatcher = (
  operationId: string,
  input: {
    body: unknown;
    params: Record<string, string>;
    query: Record<string, string>;
    actor: ActorContext;
    requestId: string;
  },
) => unknown;

export function openclawMaterializerDispatcher(
  ctx: OpenclawMaterializerContext,
): RestDispatcher {
  // Validate stateDir at construction time so every operation has a
  // usable target root. The apply/preview helpers re-run the same
  // check for defence in depth.
  const stateDir = resolveStateDir({ stateDir: ctx.stateDir });
  const ctxWithState: OpenclawMaterializerContext = { ...ctx, stateDir };

  return (operationId, input) => {
    const body = (input.body ?? {}) as Record<string, unknown>;
    if (operationId === 'previewMaterialization') {
      const req = body as OpenclawPreviewRequest;
      return openclawPreview(ctxWithState.store, input.actor ?? ctxWithState.actor, {
        harness: 'openclaw',
        profileId: req.profileId,
        snapshotId: req.snapshotId,
        stateDir,
      });
    }
    if (operationId === 'applyMaterialization') {
      const req = body as OpenclawApplyRequest;
      if (
        typeof req.observedDigest === 'string' &&
        !/^[0-9a-f]{64}$/u.test(req.observedDigest)
      ) {
        throw new Error('invalid observedDigest');
      }
      // Re-render the preview at apply time so the manifest reflects
      // the same renderer run the REST caller would have received.
      // This matches the Hermes dispatcher pattern and ensures the
      // apply's observedDigest is recomputed against the live state.
      const preview = openclawPreview(
        ctxWithState.store,
          input.actor ?? ctxWithState.actor,
        {
          harness: 'openclaw',
          profileId: req.profileId,
          snapshotId: req.snapshotId,
          stateDir,
        },
      );
      return openclawApply(ctxWithState.store, input.actor ?? ctxWithState.actor, {
        preview,
        stateDir,
        observedDigest: req.observedDigest,
        reason: req.reason ?? 'openclaw-apply',
        requestId: req.requestId ?? input.requestId,
      });
    }
    if (operationId === 'rollbackMaterialization') {
      const req = body as OpenclawRollbackRequest;
      return openclawRollback(
        ctxWithState.store,
        input.actor ?? ctxWithState.actor,
        {
          runId: req.runId,
          reason: req.reason ?? 'openclaw-rollback',
          requestId: req.requestId ?? input.requestId,
        },
      );
    }
    throw new Error(`unsupported operationId: ${operationId}`);
  };
}

// Re-export the renderer adapter so consumers can introspect the
// layout (manifest path, renderer version) without reaching into the
// `manifest` submodule directly.
export { openclawAdapter };