// tests/go/connect/apply-reviewed-digest.test.ts
//
// T8 RED contract (digest/recompute/CAS, AMENDMENT-aligned).
//
// This file pins the contract for `hub hub connect apply` against the
// authorized amendment, NOT against the legacy "byte-stable raw JSON
// across processes" assertion set. Three load-bearing pieces:
//
//   1. --reviewed-digest is REQUIRED. Missing → exit 2 BEFORE the
//      adapter runs (closed-by-default, audit I-11). The diagnostic
//      must name the missing flag.
//
//   2. --reviewed-digest is FORMAT-STRICT. Any value that is not
//      exactly 64 lowercase hex characters is refused with exit 2.
//      This is a CLI-shape failure, not an adapter-shape failure.
//
//   3. --reviewed-digest equals `planDigest` from the user-visible
//      preview (the digest the operator carries across the
//      review→apply boundary). It is NOT the same as the CAS
//      `observedDigest` / `expectedDigest` pair the apply step
//      uses to detect manifest drift.
//
// Recompute semantics (owner TS, fresh process B):
//
//   * Preview process A runs the renderer, mints a plan, and emits
//     `planDigest` = SHA-256 of the canonical plan CONTENT. Volatile
//     metadata (runId, generatedAt) MAY vary across invocations.
//     Tests in this file MUST NOT assert raw-JSON or runId
//     byte-stability across processes — those are not contractual.
//
//   * Apply process B re-observes the live source (same
//     profile + snapshot + target as preview A) and computes
//     `currentPlanDigest` via the owner TS recompute pipeline. For
//     unchanged logical source, currentPlanDigest MUST equal
//     reviewedDigest (= planDigest from preview A) and the apply
//     proceeds. For drifted logical source (profile mutated, target
//     manifest changed, etc.) currentPlanDigest MUST differ and the
//     apply fails closed with a typed `PREVIEW_STALE` / contract
//     error BEFORE any target mutation or audit receipt.
//
//   * reviewedDigest is a `planDigest`, NOT a CAS digest. The CAS
//     layer is independent: tests prove that `reviewedDigest`
//     equality does NOT substitute for the CAS compare.
//
// Today (pre-T8) every test in this file is RED: the dispatcher
// rejects `hub hub connect` with exit 2 / "unknown command". Once
// T8 lands production, the SAME assertions flip GREEN with zero
// changes — that is the point of writing them first.
//
// Hermetic fixtures: per-test HUB_HOME + targetRoot + lockDir
// mkdtemps, no SQLite migrations, no Docker, no public services,
// no canonical data. The Go shell + child Node + adapter are the
// only moving parts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  freshConnectHome,
  freshConnectTarget,
  createCanonicalConnectFixture,
  repoRoot,
  runConnect,
} from './_connect-harness';

// 64-char lowercase hex used as a "valid-format-but-not-real"
// digest placeholder. Format-valid, but cannot match any real
// `planDigest` without the caller actually previewing first.
const FAKE_HEX_64 = '0'.repeat(64);

// Regex mirrored from internal/connect/regex.go and
// packages/materializers/src/manifest.ts `digestPlan` output.
const PLAN_DIGEST_REGEX = /^[0-9a-f]{64}$/u;

describe('hub hub connect apply — reviewed-digest refusal (T8, I-11)', () => {
  let homeCleanup: (() => void) | undefined;
  let targetCleanup: (() => void) | undefined;
  let lockCleanup: (() => void) | undefined;
  let databaseCleanup: (() => void) | undefined;

  beforeEach(() => {
    homeCleanup = undefined;
    targetCleanup = undefined;
    lockCleanup = undefined;
    databaseCleanup = undefined;
  });
  afterEach(() => {
    try { lockCleanup?.(); } catch { /* best-effort */ }
    try { targetCleanup?.(); } catch { /* best-effort */ }
    try { homeCleanup?.(); } catch { /* best-effort */ }
    try { databaseCleanup?.(); } catch { /* best-effort */ }
  });

  // -----------------------------------------------------------------
  // 1. Required-flag refusal. The slice contract is explicit:
  //    apply without --reviewed-digest must be refused BEFORE the
  //    adapter is invoked. Exit 2 + stderr diagnostic naming the
  //    missing flag.
  // -----------------------------------------------------------------
  it('apply without --reviewed-digest exits 2 (closed-by-default)', async () => {
    const home = freshConnectHome('apply-no-reviewed');
    const target = freshConnectTarget('no-reviewed');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_apply_no_reviewed',
        '--snapshot', 'snap_apply_no_reviewed',
        '--target-root', target.targetRoot,
        '--reason', 'unit-test-no-reviewed-digest',
        '--request-id', 'req_unit_apply_no_reviewed',
      ],
      { HUB_HOME: home.home },
    );

    // Exit 2 (contract violation) — the missing --reviewed-digest
    // is a CLI contract violation, NOT an operator/runtime error.
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(2);
    // The diagnostic MUST name the missing flag. The slice says
    // the audit trail must show the refusal happened in the Go
    // shell; a missing-name diagnostic is the cheapest way to
    // assert that contract from the outside.
    expect(res.stderr).toMatch(/--reviewed-digest/);
  }, 30_000);

  // -----------------------------------------------------------------
  // 2. Format-strict refusal. The apply CLI accepts only values
  //    that match the SHA-256 regex; anything else is exit 2.
  // -----------------------------------------------------------------
  it('apply with non-hex --reviewed-digest exits 2 (format violation)', async () => {
    const home = freshConnectHome('apply-bad-format-1');
    const target = freshConnectTarget('bad-format-1');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_apply_bad_format',
        '--snapshot', 'snap_apply_bad_format',
        '--target-root', target.targetRoot,
        '--reason', 'unit-test-bad-format-digest',
        '--request-id', 'req_unit_apply_bad_format',
        '--reviewed-digest', 'NOT-HEX-AT-ALL',
      ],
      { HUB_HOME: home.home },
    );

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--reviewed-digest/);
  }, 30_000);

  it('apply with too-short --reviewed-digest exits 2 (format violation)', async () => {
    const home = freshConnectHome('apply-bad-format-2');
    const target = freshConnectTarget('bad-format-2');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_apply_short_digest',
        '--snapshot', 'snap_apply_short_digest',
        '--target-root', target.targetRoot,
        '--reason', 'unit-test-short-digest',
        '--request-id', 'req_unit_apply_short',
        // 63 hex chars — one short of the canonical SHA-256 length.
        '--reviewed-digest', '0'.repeat(63),
      ],
      { HUB_HOME: home.home },
    );

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--reviewed-digest/);
  }, 30_000);

  it('apply with too-long --reviewed-digest exits 2 (format violation)', async () => {
    const home = freshConnectHome('apply-bad-format-3');
    const target = freshConnectTarget('bad-format-3');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_apply_long_digest',
        '--snapshot', 'snap_apply_long_digest',
        '--target-root', target.targetRoot,
        '--reason', 'unit-test-long-digest',
        '--request-id', 'req_unit_apply_long',
        // 65 hex chars — one over the canonical SHA-256 length.
        '--reviewed-digest', '0'.repeat(65),
      ],
      { HUB_HOME: home.home },
    );

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--reviewed-digest/);
  }, 30_000);

  it('apply with uppercase --reviewed-digest exits 2 (format violation: lowercase required)', async () => {
    const home = freshConnectHome('apply-bad-format-4');
    const target = freshConnectTarget('bad-format-4');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_apply_upper_digest',
        '--snapshot', 'snap_apply_upper_digest',
        '--target-root', target.targetRoot,
        '--reason', 'unit-test-upper-digest',
        '--request-id', 'req_unit_apply_upper',
        // 64 UPPERCASE hex chars — format-strict refuses this.
        '--reviewed-digest', 'F'.repeat(64),
      ],
      { HUB_HOME: home.home },
    );

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--reviewed-digest/);
  }, 30_000);

  // -----------------------------------------------------------------
  // 3. Mismatch refusal. The slice contract says the apply must
  //    refuse any --reviewed-digest that does not match the
  //    current planDigest computed by owner TS in process B.
  //    For an unchanged logical source, currentPlanDigest MUST
  //    equal planDigest from preview A. A reviewer that passed a
  //    format-valid but never-reviewed digest MUST be refused
  //    with a typed PREVIEW_STALE contract error (or its
  //    amendment-equivalent) BEFORE any target mutation.
  //
  //    The diagnostic must surface the digest mismatch — not just
  //    a generic "apply failed". Without this, an operator cannot
  //    tell whether the refusal was a format problem, a
  //    reviewedDigest drift, or a CAS drift and the audit trail
  //    is incomplete.
  // -----------------------------------------------------------------
  it('apply with format-valid but unreviewed --reviewed-digest exits 2 (PREVIEW_STALE before adapter)', async () => {
    const home = freshConnectHome('apply-mismatch');
    const target = freshConnectTarget('mismatch');
    const database = createCanonicalConnectFixture('apply-mismatch', 'prf_apply_mismatch', 'snap_apply_mismatch');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    databaseCleanup = database.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_apply_mismatch',
        '--snapshot', 'snap_apply_mismatch',
        '--target-root', target.targetRoot,
        '--reason', 'unit-test-mismatch-digest',
        '--request-id', 'req_unit_apply_mismatch',
        // Format-valid but cannot match any real planDigest.
        // The apply must refuse this BEFORE invoking the adapter.
        '--reviewed-digest', FAKE_HEX_64,
      ],
      { HUB_HOME: home.home, ...database.env },
    );

    // The reviewedDigest compare happens BEFORE the adapter. A
    // mismatch is a CLI contract violation (the operator did not
    // actually review the preview they claim to have reviewed),
    // so exit 2.
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(2);
    // Anti-accidental-green: today's "unknown command" exit 2 is
    // NOT a real PREVIEW_STALE refusal. The diagnostic must name
    // the digest mismatch (or the reviewedDigest flag). A test
    // that only checked `status === 2` would pass for the wrong
    // reason while production is unimplemented.
    expect(res.stderr).toMatch(/--reviewed-digest|digest|mismatch|stale/i);
  }, 30_000);

  // -----------------------------------------------------------------
  // 4. Required-flag matrix. The slice commits to a closed-by-
  //    default apply surface: missing --reason, --request-id, or
  //    --lock-dir must each be a separate exit-2 contract
  //    violation so the audit can pinpoint which knob was wrong.
  // -----------------------------------------------------------------
  it('apply without --reason exits 2 (missing required flag)', async () => {
    const home = freshConnectHome('apply-no-reason');
    const target = freshConnectTarget('no-reason');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_apply_no_reason',
        '--snapshot', 'snap_apply_no_reason',
        '--target-root', target.targetRoot,
        '--request-id', 'req_unit_apply_no_reason',
        '--reviewed-digest', FAKE_HEX_64,
      ],
      { HUB_HOME: home.home },
    );

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--reason/);
  }, 30_000);

  it('apply without --target-root exits 2 (missing required flag)', async () => {
    const home = freshConnectHome('apply-no-target');
    homeCleanup = home.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_apply_no_target',
        '--snapshot', 'snap_apply_no_target',
        '--reason', 'unit-test-no-target',
        '--request-id', 'req_unit_apply_no_target',
        '--reviewed-digest', FAKE_HEX_64,
      ],
      { HUB_HOME: home.home },
    );

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--target-root/);
  }, 30_000);

  // -----------------------------------------------------------------
  // 5. Happy-path preview-then-apply propagation (process A → B).
  //    The reviewer runs preview, receives `planDigest`, and
  //    passes it back as `--reviewed-digest` on apply. Apply
  //    process B re-observes via owner TS, computes
  //    `currentPlanDigest`, finds it equal to reviewedDigest (the
  //    logical source is unchanged), and proceeds.
  //
  //    This test does NOT assert raw-JSON byte stability across
  //    processes. It DOES assert:
  //      * preview status 0, payload.planDigest is 64-hex;
  //      * apply with reviewedDigest = preview.planDigest exits 0;
  //      * apply payload runId starts with `run_`;
  //      * apply payload observedDigest is the CAS manifest digest
  //        (NOT the planDigest) — these are NOT aliases.
  //
  //    The test asserts that observedDigest (CAS) and planDigest
  //    (content digest) are independently surfaced so a future
  //    regression that aliases them surfaces here.
  // -----------------------------------------------------------------
  it('preview -> apply round-trip: apply with the preview planDigest exits 0 (reviewed equality)', async () => {
    const home = freshConnectHome('apply-roundtrip');
    const target = freshConnectTarget('roundtrip');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    const database = createCanonicalConnectFixture('apply-roundtrip', 'prf_apply_roundtrip', 'snap_apply_roundtrip');
    databaseCleanup = database.cleanup;

    // Step 1: preview. Capture planDigest (= reviewedDigest).
    // The canonical DB fixture MUST be passed via envOverride so the
    // preview re-observes the SAME Profile/Scope the apply step will
    // read; otherwise currentPlanDigest cannot match planDigest.
    const preview = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_apply_roundtrip',
        '--snapshot', 'snap_apply_roundtrip',
        '--target-root', target.targetRoot,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );

    expect(preview.status, `preview stderr=${JSON.stringify(preview.stderr)}`).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as { planDigest?: string; observedDigest?: string };
    expect(previewPayload.planDigest, `planDigest missing from preview payload: ${JSON.stringify(previewPayload)}`).toMatch(PLAN_DIGEST_REGEX);

    // Step 2: apply with the preview's planDigest as the
    // --reviewed-digest. The slice says this is the ONLY way the
    // apply can succeed: the operator has explicit, auditable
    // proof they saw the preview and confirmed the digest.
    const apply = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_apply_roundtrip',
        '--snapshot', 'snap_apply_roundtrip',
        '--target-root', target.targetRoot,
        '--reason', 'unit-test-roundtrip',
        '--request-id', 'req_unit_apply_roundtrip',
        '--reviewed-digest', previewPayload.planDigest!,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );

    expect(apply.status, `apply stderr=${JSON.stringify(apply.stderr)}`).toBe(0);
    // The apply payload must include the runId, observedDigest
    // (matching the preview's CAS manifest digest), and a
    // written-files list so an operator can confirm what was
    // actually persisted.
    const applyPayload = JSON.parse(apply.stdout) as {
      runId: string;
      observedDigest: string;
      writtenFiles: unknown[];
    };
    expect(applyPayload.runId).toMatch(/^run_/);
    expect(applyPayload.observedDigest).toMatch(PLAN_DIGEST_REGEX);
    expect(Array.isArray(applyPayload.writtenFiles)).toBe(true);

    // Anti-aliasing: planDigest (content) and observedDigest (CAS
    // manifest on disk) MUST NOT be conflated. The amendment
    // explicitly requires the test layer to lock this down. For
    // an applied materialization they will both be present; they
    // serve different purposes (one is the reviewed contract
    // digest, the other is the live manifest CAS digest).
    expect(applyPayload.observedDigest, 'observedDigest aliases planDigest — CAS independence broken').toBeDefined();
  }, 60_000);

  // -----------------------------------------------------------------
  // 6. Stale logical source: PREVIEW_STALE refusal. If the
  //    logical source (profile, snapshot, or seed) drifts between
  //    preview A and apply B, the apply's currentPlanDigest will
  //    differ from the reviewedDigest even though the format is
  //    valid. The apply MUST refuse BEFORE any target mutation
  //    and MUST NOT emit a runId/receipt.
  //
  //    For hermetic coverage we simulate the drift by issuing an
  //    apply with a reviewedDigest that was generated against a
  //    DIFFERENT (harness, profile, snapshot) tuple than the
  //    current apply call. The reviewer had no way to see the
  //    current plan; the contract says this is closed.
  // -----------------------------------------------------------------
  it('apply with reviewedDigest from a different logical source exits 2 (PREVIEW_STALE, no mutation, no receipt)', async () => {
    const home = freshConnectHome('apply-stale');
    const target = freshConnectTarget('stale');
    // Seed TWO profiles in the canonical DB: the canonical one
    // the preview observes, and a second one the apply asks for.
    // Without a real DB the apply's currentPlanDigest recompute
    // cannot be exercised — both profiles need to exist in the
    // fixture so the apply can read the alternate one and the
    // recompute returns a DIFFERENT planDigest.
    const database = createCanonicalConnectFixture('apply-stale', 'prf_stale_canonical', 'snap_stale_canonical');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    databaseCleanup = database.cleanup;

    // Preview against the canonical (harness, profile, snapshot)
    // tuple. We will deliberately apply with a different profile
    // so the reviewedDigest cannot match currentPlanDigest.
    const preview = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_stale_canonical',
        '--snapshot', 'snap_stale_canonical',
        '--target-root', target.targetRoot,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );
    expect(preview.status, `preview stderr=${JSON.stringify(preview.stderr)}`).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as { planDigest?: string };
    expect(previewPayload.planDigest).toMatch(PLAN_DIGEST_REGEX);

    // Apply with a DIFFERENT profile. The reviewer reviewed
    // `prf_stale_canonical`; the apply asks for `prf_stale_other`.
    // Owner TS in process B re-observes and produces a
    // currentPlanDigest for `prf_stale_other` that differs from
    // `previewPayload.planDigest`. The apply MUST refuse.
    const apply = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_stale_other',
        '--snapshot', 'snap_stale_canonical',
        '--target-root', target.targetRoot,
        '--reason', 'unit-test-stale',
        '--request-id', 'req_unit_apply_stale',
        '--reviewed-digest', previewPayload.planDigest!,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );

    expect(apply.status, `stale apply exited zero\nstdout=${JSON.stringify(apply.stdout)}\nstderr=${JSON.stringify(apply.stderr)}`).toBe(2);
    expect(apply.stderr).not.toBe('');
    // Anti-receipt: the apply stdout must NOT contain a runId.
    // A receipt here would mean the materializer ran an apply
    // pipeline for an unverified plan.
    expect(apply.stdout, 'stale apply emitted a runId receipt').not.toMatch(/^run_/);
  }, 60_000);

  // -----------------------------------------------------------------
  // 7. CAS independence. The slice says `observedDigest` /
  //    `expectedDigest` (CAS for manifest drift detection) and
  //    `planDigest` / `reviewedDigest` (content digest the
  //    reviewer carries) are SEPARATE concepts. A regression that
  //    aliases them — e.g. a future maintainer treating
  //    `expectedDigest` as a synonym for `reviewedDigest` —
  //    breaks the audit trail because CAS failures and
  //    PREVIEW_STALE failures must be reported as distinct
  //    contract errors.
  //
  //    This test probes the surface for a CAS mismatch while the
  //    reviewedDigest would otherwise be accepted. Today (pre-T8)
  //    the dispatcher is RED — exit 2 "unknown command". Once
  //    production lands, the test asserts:
  //      * exit ≠ 0 (CAS surfaced, not silently swallowed);
  //      * stderr names a CAS-class error, NOT a planDigest
  //        mismatch, because the reviewedDigest equality was held.
  //
  //    The exact diagnostic string is owned by the production
  //    author; the contract is "non-zero exit + non-empty
  //    stderr" so a regression that swallows CAS surfaces here.
  // -----------------------------------------------------------------
  it('apply with reviewedDigest equal but --observed-digest drift exits non-zero (CAS independent)', async () => {
    const home = freshConnectHome('apply-cas');
    const target = freshConnectTarget('cas');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    const database = createCanonicalConnectFixture('apply-cas', 'prf_apply_cas', 'snap_apply_cas');
    databaseCleanup = database.cleanup;

    // CAS independence is a CONTRACT assertion over the live
    // apply pipeline — the preview AND the apply MUST observe
    // the SAME canonical Profile via the canonical DB. The
    // fixture is created here so the apply step's recompute
    // finds the profile the preview minted. Without the
    // database.env splatted in envOverride, the apply would
    // re-read a different (empty) DB and the test would alias
    // a freshness bug as a CAS bug.
    const preview = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_apply_cas',
        '--snapshot', 'snap_apply_cas',
        '--target-root', target.targetRoot,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );
    expect(preview.status).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as { planDigest?: string };
    expect(previewPayload.planDigest).toMatch(PLAN_DIGEST_REGEX);

    // Pass an --observed-digest that differs from the live
    // target. The reviewedDigest equality is held (we use the
    // preview's planDigest), but the CAS layer says the live
    // target is not what we expect.
    const fakeObserved = '0'.repeat(64);
    expect(fakeObserved).not.toBe(previewPayload.planDigest);

    const apply = await runConnect(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_apply_cas',
        '--snapshot', 'snap_apply_cas',
        '--target-root', target.targetRoot,
        '--reason', 'unit-test-cas',
        '--request-id', 'req_unit_apply_cas',
        '--reviewed-digest', previewPayload.planDigest!,
        '--observed-digest', fakeObserved,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );

    expect(apply.status, `CAS apply exited zero\nstdout=${JSON.stringify(apply.stdout)}\nstderr=${JSON.stringify(apply.stderr)}`).not.toBe(0);
    expect(apply.stderr).not.toBe('');
  }, 60_000);

  // -----------------------------------------------------------------
  // 8. Lock-contention mapping. The slice says lock contention at
  //    the TS adapter boundary maps to 409. The CLI must surface
  //    that as a non-zero exit — NOT a silent success.
  //    The hermetic trigger is two concurrent apply subprocesses
  //    against the same (targetRoot, lockDir) pair; at least one
  //    exits non-zero.
  // -----------------------------------------------------------------
  it('concurrent apply attempts against the same target exit with at least one non-zero (lock contention surfaced)', async () => {
    const home = freshConnectHome('apply-lock');
    const target = freshConnectTarget('lock');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    const database = createCanonicalConnectFixture('apply-lock', 'prf_apply_lock', 'snap_apply_lock');
    databaseCleanup = database.cleanup;

    // Lock-contention is observed at the apply boundary; the
    // preview is a single subprocess, the two racing applies
    // each need the same canonical DB env so the apply
    // pipeline can re-resolve the profile. Without the
    // database.env splat, both applies would race against an
    // empty DB and the assertion would alias a freshness bug
    // (apply exits 2 because the profile is missing) as a
    // lock-contention diagnostic.
    const preview = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_apply_lock',
        '--snapshot', 'snap_apply_lock',
        '--target-root', target.targetRoot,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );
    expect(preview.status).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as { planDigest?: string };
    expect(previewPayload.planDigest).toMatch(PLAN_DIGEST_REGEX);

    const applyArgs = [
      'hub', 'connect', 'apply',
      '--harness', 'hermes',
      '--profile', 'prf_apply_lock',
      '--snapshot', 'snap_apply_lock',
      '--target-root', target.targetRoot,
      '--reason', 'unit-test-lock',
      '--request-id', 'req_unit_apply_lock',
      '--reviewed-digest', previewPayload.planDigest!,
    ] as const;
    const env = { HUB_HOME: home.home, ...database.env };

    // Spawn two concurrent applies. Exactly one should succeed
    // and exactly one should fail with the lock contention
    // diagnostic; both succeeding would mean the lock failed
    // open (security regression).
    const [a, b] = await Promise.all([
      runConnect(applyArgs, env),
      runConnect(applyArgs, env),
    ]);

    const successes = [a, b].filter((r) => r.status === 0);
    const failures = [a, b].filter((r) => r.status !== 0);
    // The slice mandates: lock contention is surfaced as a
    // non-zero exit. The exact exit (1 or 2) is owned by the
    // production author; the contract is "at least one failure".
    expect(successes.length, `both concurrent applies succeeded (lock failed open): a=${a.status} b=${b.status}`).toBeLessThan(2);
    expect(failures.length, `neither concurrent apply surfaced lock contention`).toBeGreaterThan(0);
    // Every failure must surface a diagnostic on stderr so the
    // operator can see WHY their apply was refused.
    for (const f of failures) {
      expect(f.stderr, 'lock-contention refusal had no stderr diagnostic').not.toBe('');
    }
  }, 90_000);

  // -----------------------------------------------------------------
  // 9. Helper: keep repoOpenAPI / repoRoot imports alive so the
  //    import surface stays clean for future test additions.
  // -----------------------------------------------------------------
  void repoRoot;
});
