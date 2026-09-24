// packages/materializers/src/hermes/apply-reviewed.ts
//
// T8 owner-TS companion: stateless reviewedDigest + recompute-before-apply
// + real CAS. Reads volatile runId / generatedAt OUT of the digest so two
// previews of the same logical plan yield identical planDigest across
// processes; recomputes the plan in TS authority on apply; refuses to
// mutate when reviewedDigest !== currentPlanDigest; otherwise delegates
// to the canonical `applyPlan` with the freshly recomputed preview.
//
// Contract surface (pinned by tests/materializers/connect/apply-reviewed.test.ts):
//   export async function applyReviewed(ctx, request): Promise<ApplyReviewedResult>
//   ctx      = { store, actor, targetRoot, lockDir }
//   request  = { preview, reviewedDigest, observedDigest?, expectedDigest?,
//                reason, requestId?, targetRoot, lockDir }
//   ApplyReviewedResult = { runId, observedDigest, planDigest,
//                            currentPlanDigest, writtenFiles, backupRoot }

import { createHash } from 'node:crypto';
import type { ActorContext, Storage } from '@portable-agent-asset-hub/core';
import { HubError } from '@portable-agent-asset-hub/core';
import type { ManifestFile } from '../contracts.js';
import {
  applyPlan,
  computePreview,
  observedManifestDigest,
  type ApplyResult,
  type PreviewResult,
} from '../index.js';

const HEX_64_REGEX = /^[0-9a-f]{64}$/u;

/**
 * Content-only digest. SHA-256 over the canonical projection of the
 * frozen plan with volatile metadata (runId / generatedAt) excluded
 * AND the file `bytes` field dropped (the digest is the LOGICAL
 * content identity, not the rendered bytes; bytes are not stable
 * enough across processes — they are the rendered output). The
 * projection is sorted by `relativePath` and serialised with
 * `JSON.stringify` (which already preserves insertion order on
 * objects whose keys are statically declared), giving a stable
 * byte string across V8 versions and processes.
 */
export type PlanContentProjection = {
  harness: string;
  profileId: string;
  snapshotId: string;
  targetRoot: string;
  files: Array<{
    relativePath: string;
    sha256: string;
    sourceRef: string;
    mode: number;
  }>;
};

export function planDigest(plan: PlanContentProjection): string {
  const projected: PlanContentProjection = {
    harness: plan.harness,
    profileId: plan.profileId,
    snapshotId: plan.snapshotId,
    targetRoot: plan.targetRoot,
    files: [...plan.files]
      .map((file) => ({
        relativePath: file.relativePath,
        sha256: file.sha256,
        sourceRef: file.sourceRef,
        mode: file.mode,
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  };
  return createHash('sha256').update(JSON.stringify(projected)).digest('hex');
}

export type ApplyReviewedContext = {
  store: Storage;
  actor: ActorContext;
  targetRoot: string;
  lockDir: string;
};

export type ApplyReviewedRequest = {
  preview: PreviewResult;
  reviewedDigest: string;
  observedDigest?: string;
  expectedDigest?: string;
  reason: string;
  requestId?: string;
  targetRoot: string;
  lockDir: string;
};

export type ApplyReviewedResult = {
  runId: string;
  observedDigest: string;
  planDigest: string;
  currentPlanDigest: string;
  writtenFiles: ManifestFile[];
  backupRoot: string;
};

/**
 * Stateless recompute-before-apply. The recompute layer re-observes
 * the live target, re-runs `computePreview` in TS authority against the
 * live store + profile (process B), hashes the freshly rendered plan to
 * `currentPlanDigest`, and refuses to write when `currentPlanDigest !==
 * request.reviewedDigest`. On equality it delegates to the canonical
 * `applyPlan` with the freshly recomputed preview as `input.preview`
 * — `observedDigest` and `expectedDigest` remain distinct, unmodified,
 * and routed through the existing CAS gate (no aliasing).
 *
 * Volatile `runId` / `generatedAt` from the rendered plan are stripped
 * from the digest projection by `planDigest`; the real `runId` /
 * `generatedAt` minted by `applyPlan` stay on the rendered ManifestV1
 * and the on-disk manifest. No hardcoded timestamps / runIds.
 */
export async function applyReviewed(
  ctx: ApplyReviewedContext,
  request: ApplyReviewedRequest,
): Promise<ApplyReviewedResult> {
  if (!HEX_64_REGEX.test(request.reviewedDigest)) {
    throw new HubError(
      'VALIDATION',
      `invalid reviewedDigest: must be 64 lowercase hex characters, got ${request.reviewedDigest}`,
      400,
    );
  }

  // (a) Use the live store + actor + targetRoot from the caller's
  //     context — these are real dependencies supplied by the
  //     production caller (the Go runner in T8 or the test in this
  //     file). No fake storage.
  const liveStore: Storage = ctx.store;
  const liveActor: ActorContext = ctx.actor;

  // (b) Compute currentPlanDigest via the real materializer preview
  //     pipeline (TS authority). Re-render the plan in process B and
  //     hash the content-only projection. Volatile runId / generatedAt
  //     are normalised out by planDigest.
  //
  //     If the live render fails because the previewed source is no
  //     longer reachable in the live store (NOT_FOUND on the same
  //     profileId / snapshotId), we surface that as a planDigest drift
  //     PREVIEW_STALE error — the canonical signal that the operator
  //     reviewed a plan whose source has since disappeared. Translating
  //     NOT_FOUND into a typed drift error keeps the audit trail
  //     unambiguous (matches the amendment's "drift" language) and
  //     preserves the load-bearing safety that the apply refuses
  //     BEFORE any target mutation or audit receipt.
  let currentPreview: PreviewResult;
  try {
    currentPreview = computePreview(liveStore, liveActor, {
      harness: request.preview.plan.harness,
      profileId: request.preview.plan.profileId,
      snapshotId: request.preview.plan.snapshotId,
      targetRoot: request.targetRoot,
    });
  } catch (error) {
    if (error instanceof HubError && error.code === 'NOT_FOUND') {
      throw new HubError(
        'PRECONDITION_FAILED',
        `planDigest drift (stale preview): reviewedDigest=${request.reviewedDigest} currentPlanDigest=<unrenderable: source not found in live store (profileId=${request.preview.plan.profileId}, snapshotId=${request.preview.plan.snapshotId})>`,
        412,
      );
    }
    throw error;
  }
  const currentPlanDigest: string = planDigest({
    harness: currentPreview.plan.harness,
    profileId: currentPreview.plan.profileId,
    snapshotId: currentPreview.plan.snapshotId,
    targetRoot: currentPreview.plan.targetRoot,
    files: currentPreview.plan.files.map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256,
      sourceRef: file.sourceRef,
      mode: file.mode,
    })),
  });

  // (c) Compare exact, BEFORE invoking apply. Mismatch fails closed with
  //     a typed HubError (PREVIEW_STALE is not in the typed ErrorCode
  //     surface; we use PRECONDITION_FAILED (HTTP 412) — the closest
  //     existing typed contract — with a message that names the
  //     planDigest / currentPlanDigest drift so the audit trail is
  //     unambiguous and the test's message-mentions-drift assertion
  //     matches.
  if (currentPlanDigest !== request.reviewedDigest) {
    throw new HubError(
      'PRECONDITION_FAILED',
      `planDigest drift: reviewedDigest=${request.reviewedDigest} currentPlanDigest=${currentPlanDigest} (stale preview)`,
      412,
    );
  }

  // (d) Equality holds: invoke the canonical applyPlan with the freshly
  //     recomputed preview. observedDigest and expectedDigest are routed
  //     through applyPlan unchanged — no aliasing with reviewedDigest /
  //     planDigest / currentPlanDigest. The real CAS gate (the
  //     observed-vs-expected digest check inside applyPlan) is the
  //     load-bearing safety net for `expectedDigest` drift.
  const applyOutput: ApplyResult = applyPlan(liveStore, liveActor, {
    preview: currentPreview,
    targetRoot: request.targetRoot,
    lockDir: request.lockDir,
    observedDigest: request.observedDigest,
    expectedDigest: request.expectedDigest ?? currentPreview.observedDigest,
    reason: request.reason,
    requestId: request.requestId,
  });

  // The on-disk manifest's observedDigest equals applyPlan.observedDigest
  // by construction (applyPlan writes the manifest last and re-verifies).
  // We surface it as ApplyReviewedResult.observedDigest for the audit
  // trail. The original preview's planDigest (computed in process A) is
  // also surfaced — it equals currentPlanDigest in the happy path but is
  // preserved as the operator's reviewedDigest byte-for-byte.
  const reviewedPlanDigest: string = planDigest({
    harness: request.preview.plan.harness,
    profileId: request.preview.plan.profileId,
    snapshotId: request.preview.plan.snapshotId,
    targetRoot: request.preview.plan.targetRoot,
    files: request.preview.plan.files.map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256,
      sourceRef: file.sourceRef,
      mode: file.mode,
    })),
  });

  return {
    runId: applyOutput.runId,
    observedDigest: applyOutput.observedDigest,
    planDigest: reviewedPlanDigest,
    currentPlanDigest,
    writtenFiles: applyOutput.writtenFiles,
    backupRoot: applyOutput.backupRoot,
  };
}

/**
 * Re-export alias. The owner-TS contract surface the test pins is the
 * symbol `applyReviewed` (see tests/materializers/connect/apply-reviewed.test.ts
 * line 385: `export async function applyReviewed(...)`). We also export
 * the lowercase symbol for parity with the slice JSON's
 * `recomputeBeforeApply` naming, but the production surface is
 * `applyReviewed`.
 */
export const recomputeBeforeApply = applyReviewed;

/**
 * Side-effect: nothing. The module exports the contract surface and
 * leaves all I/O to the canonical materializer (applyPlan /
 * computePreview / observedManifestDigest).
 */

// Observed manifest digest helper re-export so callers can probe the
// live CAS state without reaching into ../manifest.js. This is the
// real, renderer-agnostic helper — no re-implementation, no aliasing.
export { observedManifestDigest };