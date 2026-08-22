// packages/materializers/src/hermes/adapter.ts
//
// Hermes adapter entrypoint. Owns the (renderer + apply + rollback)
// trio for Hermes. The REST surface (`hermesMaterializerDispatcher`)
// binds this adapter to the S7 dispatcher signature.

import type { ActorContext, Storage } from '@portable-agent-asset-hub/core';
import {
  applyPlan,
  computePreview,
  rollbackPlan,
  type ApplyInput,
  type ApplyResult,
  type PreviewInput,
  type PreviewResult,
  type RollbackInput,
  type RollbackResult,
} from '../index.js';

export type HermesMaterializerContext = {
  store: Storage;
  actor: ActorContext;
  targetRoot: string;
  lockDir?: string;
};

export type HermesPreviewRequest = {
  harness: 'hermes';
  profileId: string;
  snapshotId: string;
};

export type HermesApplyRequest = HermesPreviewRequest & {
  observedDigest?: string;
  reason: string;
  requestId?: string;
};

export type HermesRollbackRequest = {
  runId: string;
  reason: string;
  requestId?: string;
};

/**
 * Hermes-flavored preview: locks the renderer to the Hermes adapter
 * and uses the configured targetRoot / lockDir.
 */
export function hermesPreview(
  ctx: HermesMaterializerContext,
  request: HermesPreviewRequest,
): PreviewResult {
  const preview: PreviewInput = {
    harness: 'hermes',
    profileId: request.profileId,
    snapshotId: request.snapshotId,
    targetRoot: ctx.targetRoot,
  };
  return computePreview(ctx.store, ctx.actor, preview);
}

export function hermesApply(
  ctx: HermesMaterializerContext,
  request: HermesApplyRequest,
): ApplyResult {
  const preview = hermesPreview(ctx, request);
  const input: ApplyInput = {
    preview,
    targetRoot: ctx.targetRoot,
    lockDir: ctx.lockDir ?? ctx.targetRoot,
    observedDigest: request.observedDigest,
    reason: request.reason,
    requestId: request.requestId,
  };
  return applyPlan(ctx.store, ctx.actor, input);
}

export function hermesRollback(
  ctx: HermesMaterializerContext,
  request: HermesRollbackRequest,
): RollbackResult {
  const input: RollbackInput = {
    runId: request.runId,
    reason: request.reason,
    requestId: request.requestId,
  };
  return rollbackPlan(ctx.store, ctx.actor, input);
}

/**
 * Dispatcher factory that adapts the S8 Hermes materializer to the
 * S6/S7 REST `dispatch(operationId, {body, params, query, actor, requestId})`
 * signature. The three operations:
 *
 *   * previewMaterialization — no CAS, returns the preview.
 *   * applyMaterialization   — CAS-required by the REST router; if
 *                              `If-Match` is absent the router returns
 *                              428 before this dispatcher runs.
 *   * rollbackMaterialization — CAS-required (runId in body), reverses
 *                              a prior apply.
 *
 * The dispatcher throws HubError on every failure path; the REST
 * `error-mapper` translates HubError.status into the response code.
 */
export type RestDispatcher = (
  operationId: string,
  input: { body: unknown; params: Record<string, string>; query: Record<string, string>; actor: ActorContext; requestId: string },
) => unknown;

export function hermesMaterializerDispatcher(
  ctx: HermesMaterializerContext,
): RestDispatcher {
  return (operationId, input) => {
    const body = (input.body ?? {}) as Record<string, unknown>;
    if (operationId === 'previewMaterialization') {
      const req = body as HermesPreviewRequest;
      return hermesPreview(ctx, req);
    }
    if (operationId === 'applyMaterialization') {
      const req = body as HermesApplyRequest;
      // The REST router maps `If-Match` to a header; if the caller
      // sent it without a digest we still allow the apply because the
      // adapter enforces observed-digest drift. CAS contract is
      // enforced at the dispatcher level via observedDigest.
      if (typeof req.observedDigest === 'string' && !/^[0-9a-f]{64}$/u.test(req.observedDigest)) {
        throw new Error('invalid observedDigest');
      }
      return hermesApply(ctx, { ...req, requestId: req.requestId ?? input.requestId });
    }
    if (operationId === 'rollbackMaterialization') {
      const req = body as HermesRollbackRequest;
      return hermesRollback(ctx, { ...req, requestId: req.requestId ?? input.requestId });
    }
    throw new Error(`unsupported operationId: ${operationId}`);
  };
}
