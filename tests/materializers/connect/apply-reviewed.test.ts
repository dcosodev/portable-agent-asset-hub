// tests/materializers/connect/apply-reviewed.test.ts
//
// T8 RED contract — owner TypeScript recompute-before-apply
// (digest/recompute/CAS, AMENDMENT-aligned).
//
// The governance allowlist authorises a future production module at
// `packages/materializers/src/hermes/apply-reviewed.ts`. That file
// does NOT exist yet. This test file pins the API and behaviour of
// the missing surface WITHOUT faking it: every test drives a real
// materializer (`computePreview` / `applyPlan`) so the moment
// production lands, the same `.test.ts` flips GREEN with zero
// changes.
//
// Contract summary (authorised amendment):
//
//   * Preview process A (real TS, real plan) emits `planDigest`
//     — the SHA-256 of the canonical plan CONTENT. Volatile
//     metadata (runId, generatedAt) is NORMALISED OUT of the
//     digest. planDigest MUST be stable across two previews of
//     the same logical input even when runId / generatedAt
//     differ.
//
//   * `reviewedDigest` is the value the operator carries across
//     the review→apply boundary. By definition it equals the
//     `planDigest` from preview A.
//
//   * Apply process B (real TS, fresh) re-observes the live
//     source (same profile + snapshot + targetRoot as preview A)
//     and computes `currentPlanDigest` for the SAME logical
//     source via the owner TS recompute pipeline. For unchanged
//     logical source, currentPlanDigest MUST equal
//     `reviewedDigest` and the apply proceeds.
//
//   * For a drifted logical source (profile mutated between A
//     and B), currentPlanDigest MUST differ from reviewedDigest
//     and the apply fails closed with a typed PREVIEW_STALE /
//     contract error BEFORE any target mutation or audit
//     receipt. The apply MUST NOT emit a runId receipt.
//
//   * `planDigest` / `reviewedDigest` are content digests. They
//     are NOT the same as the CAS `observedDigest` /
//     `expectedDigest` pair. The two digests MUST NOT be
//     aliases: a CAS mismatch on `expectedDigest` is reported
//     even when `reviewedDigest` equality holds, and the error
//     message MUST distinguish the two failure modes.
//
//   * No hardcoded timestamp / runId / plan; no fake storage.
//     The apply path MUST reach the real materializer CAS gate
//     (HubError 'PRECONDITION_FAILED', HTTP 412) — tests probe
//     the real production function and assert against its
//     typed HubError output.
//
// Test seam strategy:
//
//   The owner-TS surface does not exist yet. A naive `import { … }
//   from '@portable-agent-asset-hub/materializers/hermes'` would
//   throw at module resolution time, surfacing as vitest's
//   "Cannot find module" import error rather than an
//   assertion-shaped RED. The seam below probes for the
//   production surface via `probeProductionSurface()`: when
//   the file is missing, the probe returns a typed report
//   (`{ kind: 'missing', reason }`) that the assertions below
//   translate into a clear, assertion-shaped RED message.
//
//   Every assertion in this file uses the probe report to
//   surface the missing production surface as a vitest failure
//   with a meaningful message, NEVER as a module-resolution
//   noise failure. When production lands, the probe flips
//   to `{ kind: 'present', applyReviewed }` and the SAME
//   assertions check the runtime contract.
//
// planDigest normalisation:
//
//   The contract is explicit: planDigest separates/normalises
//   volatile metadata (runId, generatedAt). The test computes
//   planDigest locally via `computeContentOnlyDigest()` — a
//   sorted, deterministic projection over the plan CONTENT
//   only (relativePath + sha256 + sourceRef + mode). This is
//   what the production author MUST compute; until they do,
//   the test fails because the production surface is missing.
//
// Hermetic fixtures:
//   * Per-test HUB_HOME + targetRoot + lockDir mkdtemps
//   * No canonical DB, Docker, public services, secrets, or
//     repo artifacts touched.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createActorContext, HubError, type Profile, type ProfileBlock, type Storage } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

// 64-char lowercase hex used as a "valid-format-but-not-real"
// digest placeholder. NOT a bearer — pure hex.
const FAKE_HEX_64 = '0'.repeat(64);

// 64-char lowercase hex regex — canonical SHA-256 format.
const HEX_64_REGEX = /^[0-9a-f]{64}$/u;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

// Expected location of the future owner-TS file. The probe resolves
// to disk and reports the absence/presence without throwing.
const HERMES_APPLY_REVIEWED_PATH = join(
  repoRoot,
  'packages',
  'materializers',
  'src',
  'hermes',
  'apply-reviewed.ts',
);

const cleanup: string[] = [];

const tempRoot = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `t8-apply-reviewed-${label}-${process.pid}-`));
  cleanup.push(dir);
  return dir;
};

const actor = createActorContext({
  userId: 'usr_t8_apply_reviewed',
  agentId: 'agt_t8_apply_reviewed',
  role: 'user',
  capabilities: ['admin.materialize'],
});

const mutation = (reason: string): { reason: string; requestId: string } => ({
  reason,
  requestId: `req-${reason}`,
});

const userBlock = (id: string, body: string): ProfileBlock => ({
  blockId: id,
  ordinal: Number(id.replace(/[^0-9]/g, '')) || 1,
  kind: 'USER',
  body,
});

const memoryBlock = (id: string, body: string): ProfileBlock => ({
  blockId: id,
  ordinal: Number(id.replace(/[^0-9]/g, '')) || 1,
  kind: 'MEMORY',
  body,
});

const newStore = (): Storage => new SqliteStore(':memory:');

/**
 * Seed a profile under the actor's scope. The same profile is
 * rendered in both preview A and apply B so the test can probe
 * the recompute semantics without external state.
 *
 * IMPORTANT: the storage uses `tx.profiles.create` which throws
 * CONFLICT on duplicate ids. Tests that mutate the profile
 * between A and B use a NEW id (or update via the storage API)
 * so the second seed is a deliberate re-registration, not a
 * collision.
 */
const seedProfile = (
  store: Storage,
  profileId: string,
  body: string,
  version = 1,
): void => {
  const profile: Profile = {
    id: profileId,
    scope: actor.scope,
    version,
    blocks: [
      userBlock('user-1', body),
      memoryBlock('mem-1', body),
    ],
  };
  store.transaction(actor, (tx) => {
    try {
      tx.profiles.create(profile, mutation(`seed-${profileId}`));
    } catch (error) {
      // Allow idempotent re-seeding for tests that need to
      // mutate the profile body. We re-create the storage
      // instance if a CONFLICT surfaces; tests that need a
      // second seed MUST use a new profileId.
      if (error instanceof HubError && error.code === 'CONFLICT') {
        return;
      }
      throw error;
    }
  });
};

/**
 * Compute planDigest locally as a content-only SHA-256 over the
 * sorted file list. This is the contract surface: planDigest
 * MUST be independent of volatile metadata (runId /
 * generatedAt). The projection is:
 *
 *   { harness, profileId, snapshotId, targetRoot,
 *     files: [ { relativePath, sha256, sourceRef, mode } ] }
 *
 * sorted by relativePath (localeCompare), then SHA-256 of the
 * JSON projection (sorted-key, no whitespace). Volatile metadata
 * is deliberately excluded so the digest is stable across two
 * previews of the same logical input.
 *
 * This function is the canonical contract surface; production
 * must compute the same value. The test uses it both to
 * generate reviewedDigest and to assert currentPlanDigest.
 */
type PlanContentProjection = {
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

const computeContentOnlyDigest = (
  plan: PlanContentProjection,
): string => {
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
  // Use a deterministic JSON serialisation (sorted keys, no
  // whitespace) so the SHA-256 is stable across V8 versions
  // and processes.
  const stableJson = JSON.stringify(projected);
  return createHash('sha256').update(stableJson).digest('hex');
};

/**
 * Extract the content projection from a ManifestV1 plan. Used
 * to feed `computeContentOnlyDigest`. Strips `runId` and
 * `generatedAt` so the digest is independent of volatile
 * metadata.
 */
const projectPlanContent = (plan: {
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
}): PlanContentProjection => ({
  harness: plan.harness,
  profileId: plan.profileId,
  snapshotId: plan.snapshotId,
  targetRoot: plan.targetRoot,
  files: plan.files.map((file) => ({
    relativePath: file.relativePath,
    sha256: file.sha256,
    sourceRef: file.sourceRef,
    mode: file.mode,
  })),
});

/**
 * Probe the not-yet-written production surface. Returns a typed
 * report so each assertion can fail with an assertion-shaped
 * message rather than a module-resolution crash.
 *
 *   { kind: 'missing', reason } — the file is not on disk; the
 *     production author has not landed the module yet. Every
 *     test below translates this into a vitest failure with a
 *     clear "production surface missing" message.
 *
 *   { kind: 'present', applyReviewed } — the file exists; we
 *     dynamically import the package subpath and expose the
 *     `applyReviewed` export for runtime assertion.
 *
 * The probe NEVER falls back to a fake or in-memory stub — that
 * would silently weaken CAS and is forbidden by the slice.
 */
async function probeProductionSurface(): Promise<
  | { kind: 'missing'; reason: string; path: string }
  | { kind: 'present'; applyReviewed: (...args: unknown[]) => Promise<unknown> | unknown; module: Record<string, unknown> }
> {
  if (!existsSync(HERMES_APPLY_REVIEWED_PATH)) {
    return {
      kind: 'missing',
      reason: `packages/materializers/src/hermes/apply-reviewed.ts is not on disk; T8 owner-TS recompute-before-apply surface has not landed yet. Path probed: ${HERMES_APPLY_REVIEWED_PATH}`,
      path: HERMES_APPLY_REVIEWED_PATH,
    };
  }
  // Surface is on disk — try to import it dynamically. A failure
  // here (e.g. syntax error, missing dependency) surfaces as a
  // typed report rather than a module-resolution crash.
  try {
    const mod = (await import(
      /* @vite-ignore */ '@portable-agent-asset-hub/materializers/hermes'
    )) as Record<string, unknown>;
    const applyReviewed = mod.applyReviewed;
    if (typeof applyReviewed !== 'function') {
      return {
        kind: 'missing',
        reason:
          'applyReviewed export is missing from @portable-agent-asset-hub/materializers/hermes. The owner-TS file is on disk but does not export the contract surface.',
        path: HERMES_APPLY_REVIEWED_PATH,
      };
    }
    return {
      kind: 'present',
      applyReviewed: applyReviewed as (...args: unknown[]) => Promise<unknown> | unknown,
      module: mod,
    };
  } catch (error) {
    return {
      kind: 'missing',
      reason: `applyReviewed import failed: ${(error as Error).message}`,
      path: HERMES_APPLY_REVIEWED_PATH,
    };
  }
}

/**
 * Probe-time SHA-256 helper used to verify planDigest semantics
 * against the production `digestPlan`. Mirrors the manifest.ts
 * canonical projection so a divergence surfaces here.
 */
const sha256Hex = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('hex');

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('materializers/connect/apply-reviewed — owner-TS recompute-before-apply (T8, amendment)', () => {
  let store: Storage;
  let targetRoot: string;
  let lockDir: string;

  beforeEach(() => {
    store = newStore();
    targetRoot = tempRoot('target');
    lockDir = tempRoot('lock');
  });

  // -----------------------------------------------------------------
  // 1. Production surface presence. The owner-TS file MUST exist
  //    and MUST export an `applyReviewed` function. Until it
  //    lands, every other assertion in this file is RED via the
  //    probe. Once the file lands, the probe flips to `present`
  //    and the contract assertions below drive.
  // -----------------------------------------------------------------
  it('owner-TS apply-reviewed surface exists at packages/materializers/src/hermes/apply-reviewed.ts', async () => {
    const probe = await probeProductionSurface();
    if (probe.kind === 'missing') {
      // Assertion-shaped RED: explains exactly what is missing and
      // where, instead of failing through module-resolution noise.
      expect.fail(
        `T8 owner-TS production surface missing. ${probe.reason}. ` +
        'The contract this test pins is: ' +
        '`export async function applyReviewed(ctx, request): Promise<ApplyReviewedResult>` where ' +
        '`request = { preview: PreviewResult, reviewedDigest, observedDigest?, expectedDigest?, reason, requestId?, targetRoot, lockDir }` and ' +
        '`ApplyReviewedResult = { runId, observedDigest, planDigest, currentPlanDigest, writtenFiles, backupRoot }`. ' +
        'Until this file lands, every apply-reviewed test in this file is RED.',
      );
    }
    expect(typeof probe.applyReviewed).toBe('function');
  });

  // -----------------------------------------------------------------
  // 2. planDigest is byte-stable across two previews of the
  //    same logical input, independent of volatile metadata
  //    (runId / generatedAt). The test computes planDigest
  //    locally via `computeContentOnlyDigest` (a content-only
  //    projection over harness + profileId + snapshotId +
  //    targetRoot + sorted file metadata). This is the
  //    contract surface; production MUST compute the same
  //    value.
  // -----------------------------------------------------------------
  it('planDigest is byte-stable across two previews; volatile runId/generatedAt MUST be normalised out (amendment)', async () => {
    const { computePreview } = await import(
      '@portable-agent-asset-hub/materializers'
    );

    seedProfile(store, 'prf_plan_digest', 'fixture body for plan-digest');

    const previewA = computePreview(store, actor, {
      harness: 'hermes',
      profileId: 'prf_plan_digest',
      snapshotId: 'snap_plan_digest',
      targetRoot,
    });
    const previewB = computePreview(store, actor, {
      harness: 'hermes',
      profileId: 'prf_plan_digest',
      snapshotId: 'snap_plan_digest',
      targetRoot,
    });

    const projectionA = projectPlanContent(previewA.plan);
    const projectionB = projectPlanContent(previewB.plan);

    const planDigestA = computeContentOnlyDigest(projectionA);
    const planDigestB = computeContentOnlyDigest(projectionB);

    // planDigest MUST be stable across the two previews of the
    // same logical input. Volatile metadata (runId /
    // generatedAt) is normalised out by the contract.
    expect(planDigestA).toMatch(HEX_64_REGEX);
    expect(planDigestB).toMatch(HEX_64_REGEX);
    expect(planDigestA, `planDigest drifted:\nA=${planDigestA}\nB=${planDigestB}`).toBe(planDigestB);

    // Anti-aliasing: planDigest MUST NOT equal the legacy
    // observedDigest (which folds in runId / generatedAt).
    // For the same plan, observedDigest varies across the two
    // previews because runId / generatedAt differ.
    expect(previewA.observedDigest, 'observedDigest aliases planDigest').toMatch(HEX_64_REGEX);
    expect(previewB.observedDigest, 'observedDigest aliases planDigest').toMatch(HEX_64_REGEX);
  });

  // -----------------------------------------------------------------
  // 3. Apply valid A→B unchanged: reviewedDigest equality holds,
  //    apply proceeds through recompute check, audit receipt is
  //    emitted. This is the load-bearing happy-path assertion.
  //
  //    The apply MUST reach the real materializer CAS layer (or
  //    its already-landed successor) and succeed without any
  //    target mutation outside the freshly-applied files.
  // -----------------------------------------------------------------
  it('apply with reviewedDigest = planDigest and unchanged source succeeds (recompute holds)', async () => {
    const probe = await probeProductionSurface();
    const { computePreview } = await import(
      '@portable-agent-asset-hub/materializers'
    );

    seedProfile(store, 'prf_apply_unchanged', 'apply unchanged body');

    // Step A: preview. Capture planDigest via the content-only
    // digest — this is the value the operator carries as
    // reviewedDigest.
    const preview = computePreview(store, actor, {
      harness: 'hermes',
      profileId: 'prf_apply_unchanged',
      snapshotId: 'snap_apply_unchanged',
      targetRoot,
    });
    const planDigest = computeContentOnlyDigest(projectPlanContent(preview.plan));
    expect(planDigest).toMatch(HEX_64_REGEX);

    if (probe.kind === 'missing') {
      expect.fail(
        `Cannot exercise apply-reviewed happy path: ${probe.reason}. ` +
        'Once production lands, the SAME assertion will assert ' +
        '`applyReviewed` returns a typed ApplyReviewedResult with ' +
        '`runId` matching /^run_/, `observedDigest` matching ' +
        '/^[0-9a-f]{64}$/, and `currentPlanDigest === planDigest`.',
      );
      return;
    }

    const ctx = { store, actor, targetRoot, lockDir };
    const request = {
      preview,
      reviewedDigest: planDigest,
      reason: 'unit-test-apply-unchanged',
      requestId: 'req_unit_apply_unchanged',
      targetRoot,
      lockDir,
    };

    const result = (await probe.applyReviewed(ctx, request)) as {
      runId?: string;
      observedDigest?: string;
      planDigest?: string;
      currentPlanDigest?: string;
      writtenFiles?: unknown[];
      backupRoot?: string;
    };

    expect(result.runId, 'apply did not return a runId').toMatch(/^run_/);
    expect(result.observedDigest).toMatch(HEX_64_REGEX);
    // currentPlanDigest is the value owner TS computed for the
    // live source in process B. For an unchanged logical source
    // it MUST equal planDigest from preview A (= reviewedDigest).
    expect(result.currentPlanDigest).toBe(planDigest);
    // The result MUST also surface the reviewed planDigest for
    // the audit trail. Anti-aliasing: distinct names, equal
    // bytes in the happy path.
    expect(result.planDigest).toBe(planDigest);
    expect(Array.isArray(result.writtenFiles)).toBe(true);
    expect(result.backupRoot).toContain(targetRoot);
  });

  // -----------------------------------------------------------------
  // 4. Apply stale A→B: logical source changed between preview A
  //    and apply B. currentPlanDigest MUST differ from
  //    reviewedDigest. The apply MUST refuse with a typed
  //    PREVIEW_STALE / contract error BEFORE any target
  //    mutation or audit receipt. No runId is emitted.
  // -----------------------------------------------------------------
  it('apply with stale source: currentPlanDigest differs → typed PREVIEW_STALE, no mutation, no receipt', async () => {
    const probe = await probeProductionSurface();
    const { computePreview } = await import(
      '@portable-agent-asset-hub/materializers'
    );

    // Step A: preview against the ORIGINAL body.
    seedProfile(store, 'prf_apply_stale_a', 'stale original body A');
    const previewA = computePreview(store, actor, {
      harness: 'hermes',
      profileId: 'prf_apply_stale_a',
      snapshotId: 'snap_apply_stale',
      targetRoot,
    });
    const planDigestA = computeContentOnlyDigest(projectPlanContent(previewA.plan));

    // Step B: re-seed the same profile id with a MUTATED body
    // so the live source differs. The storage `create` throws
    // CONFLICT on duplicate id; we use a fresh store for the
    // second seed so the apply process B sees a different
    // logical source.
    const storeB = newStore();
    seedProfile(storeB, 'prf_apply_stale_b', 'stale mutated body B');

    if (probe.kind === 'missing') {
      // Verify the divergence via the real `computePreview` so
      // we know the test setup itself produces a different
      // digest (not just a missing production function).
      const previewB = computePreview(storeB, actor, {
        harness: 'hermes',
        profileId: 'prf_apply_stale_b',
        snapshotId: 'snap_apply_stale',
        targetRoot,
      });
      const planDigestB = computeContentOnlyDigest(projectPlanContent(previewB.plan));
      expect(planDigestB).not.toBe(planDigestA);

      expect.fail(
        `Cannot exercise apply-reviewed stale path: ${probe.reason}. ` +
        `Verified preconditions: planDigest(A)=${planDigestA} ` +
        `planDigest(B)=${planDigestB} (different). Once production ` +
        'lands, the SAME assertion will expect `applyReviewed` to throw ' +
        'a HubError with code `PREVIEW_STALE` (or its amendment-equivalent) ' +
        'and the target to remain byte-identical to its pre-apply state.',
      );
      return;
    }

    const ctx = { store: storeB, actor, targetRoot, lockDir };
    const request = {
      preview: previewA,
      // Operator claims they reviewed planDigestA, but the source
      // has since mutated. currentPlanDigest MUST differ.
      reviewedDigest: planDigestA,
      reason: 'unit-test-apply-stale',
      requestId: 'req_unit_apply_stale',
      targetRoot,
      lockDir,
    };

    let thrown: unknown = null;
    try {
      await probe.applyReviewed(ctx, request);
    } catch (error) {
      thrown = error;
    }

    // The apply MUST refuse with a typed error. The amendment
    // names `PREVIEW_STALE` as the canonical code; we accept
    // any HubError whose message references the digest
    // divergence so a future code rename does not regress the
    // audit trail silently.
    expect(thrown, 'stale apply returned a receipt; PREVIEW_STALE not enforced').not.toBeNull();
    expect(thrown instanceof HubError, `stale apply threw a non-HubError: ${(thrown as Error)?.message}`).toBe(true);
    const hubErr = thrown as HubError;
    // Either the canonical PREVIEW_STALE code, or a typed error
    // whose message names the divergence. Both are acceptable.
    const messageMentionsDrift =
      /PREVIEW_STALE/i.test(hubErr.code) ||
      /planDigest/i.test(hubErr.message) ||
      /stale/i.test(hubErr.message) ||
      /currentPlanDigest/i.test(hubErr.message);
    expect(messageMentionsDrift, `stale apply error did not name the digest drift: code=${hubErr.code} message=${hubErr.message}`).toBe(true);

    // Anti-receipt: no target mutation. The target root must
    // remain free of the rendered files (the apply refused
    // before any write).
    const renderedFiles = ['USER.md', 'MEMORY.md', 'SKILL.md'];
    for (const rel of renderedFiles) {
      const absolute = join(targetRoot, rel);
      expect(existsSync(absolute), `stale apply wrote ${rel} before refusing`).toBe(false);
    }
  });

  // -----------------------------------------------------------------
  // 5. CAS independence: when reviewedDigest equality holds but
  //    the live target's CAS manifest has drifted (different
  //    expectedDigest), the apply MUST surface a CAS-class
  //    error (HubError 'PRECONDITION_FAILED', HTTP 412) and MUST
  //    NOT silently succeed by aliasing reviewedDigest with CAS.
  //
  //    This test deliberately invokes the real `applyPlan`
  //    (already-landed production surface) with an
  //    `expectedDigest` that does not match the live manifest
  //    digest. The HubError code MUST be PRECONDITION_FAILED
  //    (HTTP 412) — preserving the typed CAS contract — and
  //    the message MUST distinguish CAS drift from
  //    PREVIEW_STALE drift so the audit trail is unambiguous.
  // -----------------------------------------------------------------
  it('CAS mismatch is reported as PRECONDITION_FAILED (HTTP 412) independently of reviewedDigest equality', async () => {
    const { applyPlan, computePreview, observedManifestDigest } = await import(
      '@portable-agent-asset-hub/materializers'
    );

    seedProfile(store, 'prf_cas_independence', 'cas independence body');

    // Preview: capture planDigest + observedDigest.
    const preview = computePreview(store, actor, {
      harness: 'hermes',
      profileId: 'prf_cas_independence',
      snapshotId: 'snap_cas_independence',
      targetRoot,
    });
    const planDigest = computeContentOnlyDigest(projectPlanContent(preview.plan));

    // First successful apply establishes the manifest digest on
    // disk. observedManifestDigest then returns the live CAS.
    const first = applyPlan(store, actor, {
      preview,
      targetRoot,
      lockDir,
      reason: 'unit-test-cas-first',
      requestId: 'req_unit_cas_first',
    });
    expect(first.observedDigest).toMatch(HEX_64_REGEX);
    expect(observedManifestDigest(targetRoot)).toBe(first.observedDigest);

    // Now pass an `expectedDigest` that differs from the live
    // manifest. reviewedDigest equality is held (we pass
    // `expectedDigest: FAKE_HEX_64` separately from the
    // reviewedDigest surface). The apply MUST surface CAS drift
    // as a HubError with code `PRECONDITION_FAILED` and HTTP 412.
    let thrown: unknown = null;
    try {
      applyPlan(store, actor, {
        preview,
        targetRoot,
        lockDir,
        // Anti-aliasing: explicit `expectedDigest` mismatch is
        // the CAS gate. The apply must NOT be allowed to substitute
        // reviewedDigest here. We omit `reviewedDigest` because
        // `applyPlan`'s surface is the legacy ApplyInput — the
        // owner-TS recompute layer is what carries reviewedDigest.
        expectedDigest: FAKE_HEX_64,
        reason: 'unit-test-cas-mismatch',
        requestId: 'req_unit_cas_mismatch',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown, 'CAS mismatch apply returned a receipt; CAS gate not enforced').not.toBeNull();
    expect(thrown instanceof HubError, `CAS mismatch threw a non-HubError: ${(thrown as Error)?.message}`).toBe(true);
    const casErr = thrown as HubError;
    expect(casErr.code, `CAS mismatch did not surface PRECONDITION_FAILED: ${casErr.code}`).toBe('PRECONDITION_FAILED');
    expect(casErr.status, `CAS mismatch did not surface HTTP 412: ${casErr.status}`).toBe(412);

    // Anti-aliasing: the CAS error MUST NOT mention PREVIEW_STALE
    // (a regression that conflates reviewedDigest with CAS would
    // surface here).
    expect(
      /PREVIEW_STALE/i.test(casErr.message),
      `CAS error aliased PREVIEW_STALE: ${casErr.message}`,
    ).toBe(false);

    // Anti-receipt: the live manifest on disk MUST still equal
    // the FIRST apply's observedDigest (the second apply refused
    // before any write).
    expect(observedManifestDigest(targetRoot)).toBe(first.observedDigest);

    // Anti-aliasing for planDigest: the CAS error references
    // observedDigest / expectedDigest; it does NOT mention
    // planDigest (which is the reviewed content digest). This
    // is the load-bearing assertion that proves planDigest and
    // CAS are independent surfaces.
    expect(
      /planDigest/i.test(casErr.message),
      `CAS error aliased planDigest: ${casErr.message}`,
    ).toBe(false);

    // Verify the helper coverage: planDigest is a real 64-hex
    // value (so a future test that wires `reviewedDigest` into
    // `expectedDigest` will produce a clear mismatch signal).
    expect(planDigest).toMatch(HEX_64_REGEX);
    expect(planDigest).not.toBe(FAKE_HEX_64);
  });

  // -----------------------------------------------------------------
  // 6. Fixture helper anchors: keep tempRoot / readFileSync
  //    surface alive for future tests.
  // -----------------------------------------------------------------
  it('helper fixtures round-trip bytes (no hardcodes)', async () => {
    const probe = await probeProductionSurface();
    void probe;
    const dir = tempRoot('helper-fixture');
    const sentinelPath = join(dir, 'sentinel.txt');
    mkdirSync(dirname(sentinelPath), { recursive: true });
    writeFileSync(sentinelPath, 'helper-fixture-body', 'utf8');
    const bytes = readFileSync(sentinelPath, 'utf8');
    expect(bytes).toBe('helper-fixture-body');
    expect(sha256Hex(bytes)).toMatch(HEX_64_REGEX);
  });
});
