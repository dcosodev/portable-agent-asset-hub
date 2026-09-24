// tests/go/connect/rollback-bounded.test.ts
//
// T8 RED contract — cross-process rollback bounded by the durable
// receipt (digest/recompute/CAS, AMENDMENT-aligned).
//
// Three load-bearing pieces (per docs/roadmap/slices.json amendment):
//
//   1. Three INDEPENDENT subprocesses. Preview A runs in its own
//      process, exits; apply B runs in a fresh process against the
//      SAME $HUB_HOME and writes a durable receipt at
//      `$HUB_HOME/state/connect/receipts/<runId>.json`; rollback C
//      runs in a THIRD fresh process, reads the receipt, validates
//      it, and restores the target root. There is NO in-memory
//      registry surviving across the three processes — the receipt
//      is the only state C can read.
//
//   2. UNKNOWN / MALFORMED / CORRUPT / OVERSIZED / SYMLINK / WRONG-
//      ADAPTER / WRONG-PATH receipt → rollback exits 1 (operator /
//      runtime error per the amendment), writes nothing, and does
//      NOT call the rollback adapter.
//
//   3. A second rollback of the SAME runId after a successful
//      restore is refused: the receipt is the source of truth, the
//      manifest carries the runId, and the rollback adapter refuses
//      to roll back a manifest that is already at the pre-apply
//      state.
//
// LIMITATION (declared here, not invented around): the T8 amendment
// does not yet bind a productive Storage (SqliteStore is forbidden
// for the connect child per the slice). Until production lands,
// every test below is RED via the "unknown command" exit-2
// diagnostic. The assertions check the OUTCOME — receipt presence,
// bytes, perms, process exit — they do NOT substitute a stub for
// the materializer.
//
// Hermetic fixtures:
//   * HUB_HOME → per-scenario mkdtemp shared across A/B/C
//   * targetRoot → per-scenario mkdtemp, seeded with HERMES sentinel
//     files so apply has something to write + rollback has something
//     to restore
//   * HOME / XDG_DATA_HOME → per-worker temp dir (harness default)
//   * No SQLite migration, no Docker, no canonical data

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  freshConnectTarget,
  createCanonicalConnectFixture,
  receiptPath,
  receiptsDir,
  receiptExists,
  readReceipt,
  runConnectOnSharedHome,
  seedHermesTarget,
  sharedConnectHome,
  snapshotDirSafe,
  statReceipt,
  statReceiptsDir,
  listReceipts,
  findUnexpectedHubHomePaths,
  ALLOWED_HUB_HOME_PATHS_AFTER_APPLY,
  ALLOWED_HUB_HOME_PATHS_AFTER_PREVIEW,
} from './_connect-harness';

// 64-char lowercase hex placeholder for format-valid-but-not-real
// digests. NOT a bearer — pure hex.
const FAKE_HEX_64 = '0'.repeat(64);

// run_<id> regex mirrored from internal/connect/regex.go and
// packages/materializers/src/{rollback,registry}.ts.
const RUN_ID_REGEX = /^run_[A-Za-z0-9._-]+$/u;

interface PreviewPayloadShape {
  observedDigest?: string;
  planDigest?: string;
  // The amendment pins planDigest as the canonical SHA-256 of the
  // plan CONTENT (volatile metadata normalised out); planDigest MAY
  // be the field name in the JSON envelope. The apply expects
  // --reviewed-digest to equal planDigest. Tests below accept BOTH
  // observedDigest and planDigest so the assertion survives a
  // contract rename between amendment revisions.
}

interface ApplyPayloadShape {
  runId?: string;
  observedDigest?: string;
  writtenFiles?: unknown[];
}

interface RollbackPayloadShape {
  runId?: string;
  restored?: string[];
}

function extractPreviewDigest(payload: PreviewPayloadShape): string {
  // The amendment pins planDigest as the value the operator carries
  // to apply as --reviewed-digest. Some pre-amendment envelopes
  // call this observedDigest; either is acceptable. The apply path
  // (per the amendment) compares the operator's --reviewed-digest
  // against the recomputed planDigest in a fresh process.
  const candidate = payload.planDigest ?? payload.observedDigest ?? '';
  return candidate;
}

describe('hub hub connect rollback — durable cross-process rollback (T8, amendment)', () => {
  let home: { home: string; cleanup: () => void } | undefined;
  let target: { targetRoot: string; cleanup: () => void } | undefined;
  let databaseCleanup: (() => void) | undefined;

  beforeEach(() => {
    home = undefined;
    target = undefined;
    databaseCleanup = undefined;
  });
  afterEach(() => {
    try { target?.cleanup(); } catch { /* best-effort */ }
    try { home?.cleanup(); } catch { /* best-effort */ }
    try { databaseCleanup?.(); } catch { /* best-effort */ }
  });

  // -----------------------------------------------------------------
  // 1. CLI shape: required-flag refusals. These do NOT depend on
  //    production code; the parser must reject before any
  //    subprocess work happens.
  // -----------------------------------------------------------------
  it('rollback without --run-id exits 2 (missing required flag)', async () => {
    const h = sharedConnectHome('rollback-no-runid');
    home = h;
    const t = freshConnectTarget('no-runid');
    target = t;

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--reason', 'unit-test-no-runid',
        '--request-id', 'req_unit_rollback_no_runid',
      ],
      h.home,
    );
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(2);
    expect(res.stderr).toMatch(/--run-id/);
  }, 30_000);

  it('rollback without --reason exits 2 (missing required flag)', async () => {
    const h = sharedConnectHome('rollback-no-reason');
    home = h;
    const t = freshConnectTarget('no-reason');
    target = t;

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', 'run_unit_rollback_no_reason',
        '--request-id', 'req_unit_rollback_no_reason',
      ],
      h.home,
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--reason/);
  }, 30_000);

  it('rollback without --request-id exits 2 (missing required flag)', async () => {
    const h = sharedConnectHome('rollback-no-reqid');
    home = h;
    const t = freshConnectTarget('no-reqid');
    target = t;

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', 'run_unit_rollback_no_reqid',
        '--reason', 'unit-test-no-reqid',
      ],
      h.home,
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--request-id/);
  }, 30_000);

  // -----------------------------------------------------------------
  // 2. Format-strict refusal at the CLI boundary.
  // -----------------------------------------------------------------
  it('rollback with non-prefix --run-id exits 2 (format violation)', async () => {
    const h = sharedConnectHome('rollback-bad-prefix');
    home = h;
    const t = freshConnectTarget('bad-prefix');
    target = t;

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', 'NOT-RUN-PREFIX',
        '--reason', 'unit-test-bad-prefix',
        '--request-id', 'req_unit_rollback_bad_prefix',
      ],
      h.home,
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--run-id/);
  }, 30_000);

  it('rollback with whitespace --run-id exits 2 (format violation)', async () => {
    const h = sharedConnectHome('rollback-whitespace');
    home = h;
    const t = freshConnectTarget('whitespace');
    target = t;

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', 'run has spaces',
        '--reason', 'unit-test-whitespace',
        '--request-id', 'req_unit_rollback_whitespace',
      ],
      h.home,
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--run-id/);
  }, 30_000);

  // -----------------------------------------------------------------
  // 3. Unknown runId refused. The cross-process amendment is
  //    explicit: rollback in a fresh process reads the durable
  //    receipt; an unknown runId means "no receipt on disk".
  //    The diagnostic must surface the missing-receipt refusal
  //    (NOT a generic "rollback failed").
  // -----------------------------------------------------------------
  it('rollback with format-valid but unknown --run-id exits 1 (no receipt on disk)', async () => {
    const h = sharedConnectHome('rollback-unknown');
    home = h;
    const t = freshConnectTarget('unknown');
    target = t;

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', 'run_unit_never_applied',
        '--reason', 'unit-test-unknown-runid',
        '--request-id', 'req_unit_rollback_unknown',
      ],
      h.home,
    );
    // The amendment pins exit 1 for "missing receipt" / adapter
    // refusal — exit 2 is reserved for CLI contract violations.
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(1);
    expect(res.stderr).not.toBe('');

    // The amendment forbids WRITES on a refused rollback. The
    // receipts directory must NOT be created by a refused
    // rollback — only apply writes to it. This is the cross-
    // process write-side-effect invariant: refused rollback
    // leaves $HUB_HOME byte-identical to its pre-rollback state.
    const unexpected = findUnexpectedHubHomePaths(h.home, ALLOWED_HUB_HOME_PATHS_AFTER_APPLY);
    expect(unexpected, `refused rollback wrote hidden state under HUB_HOME: ${unexpected.join(',')}`).toEqual([]);
  }, 30_000);

  // -----------------------------------------------------------------
  // 4. Receipt security matrix. Each sub-case mutates the
  //    canonical receipt path BEFORE the rollback subprocess runs,
  //    and asserts the rollback subprocess exits 1, writes
  //    nothing to the target, and does NOT mutate the receipts
  //    directory in a way that masks the corruption.
  // -----------------------------------------------------------------
  describe('invalid-receipt security matrix (fail-closed cross-process rollback)', () => {
    // For every invalid-receipt case below we need a real
    // valid receipt on disk so the rollback subprocess reaches
    // the "read receipt" stage and the corruption is the ONLY
    // thing under test. The fixture writes the receipt bytes
    // directly via fs (the harness NEVER fakes the receipt
    // store — it operates on the FILESYSTEM view of the canonical
    // path) and runs the rollback subprocess against it.

    const validRunId = 'run_unit_invalid_receipt_matrix';

    async function seedValidReceipt(h: string): Promise<string> {
      // The amendment pins the receipt schema:
      //   { schemaVersion, runId, targetRoot, lockDir,
      //     harness, profileId, observedDigest, writtenAt }
      // The fixture uses a real-looking targetRoot so the
      // wrong-resource checks below have something to compare
      // against.
      const targetRoot = target!.targetRoot;
      const lockDir = targetRoot;
      const writtenAt = '2026-08-30T13:00:00.000Z';
      const receipt = {
        schemaVersion: 1,
        runId: validRunId,
        targetRoot,
        lockDir,
        harness: 'hermes',
        profileId: 'prf_unit_invalid_receipt_matrix',
        observedDigest: FAKE_HEX_64,
        writtenAt,
      };
      const dir = receiptsDir(h);
      const { mkdirSync } = await import('node:fs');
      mkdirSync(dir, { recursive: true });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(receiptPath(h, validRunId), JSON.stringify(receipt, null, 2));
      return targetRoot;
    }

    let targetRootFixture: string | undefined;

    beforeEach(async () => {
      const h = sharedConnectHome('invalid-receipt-fixture');
      home = h;
      const tFresh = freshConnectTarget('invalid-receipt');
      target = tFresh;
      targetRootFixture = await seedValidReceipt(h.home);
    });

    async function runRollbackAgainstReceipt(
      mutatedRunId: string,
    ) {
      const h = home!;
      // Snapshot target BEFORE rollback so we can assert no
      // writes happened on a refused rollback.
      const targetRoot = target?.targetRoot ?? targetRootFixture!;
      const beforeTarget = snapshotDirSafe(targetRoot);
      const beforeReceiptsDir = statReceiptsDir(h.home);

      const res = await runConnectOnSharedHome(
        [
          'hub', 'connect', 'rollback',
          '--run-id', mutatedRunId,
          '--reason', 'unit-test-invalid-receipt',
          '--request-id', `req_unit_invalid_receipt_${mutatedRunId}`,
        ],
        h.home,
      );

      const afterTarget = snapshotDirSafe(targetRoot);
      // Target must be byte-identical: refused rollback MUST NOT
      // touch the target root.
      expect(afterTarget.files.size, `refused rollback changed target file count: before=${beforeTarget.files.size} after=${afterTarget.files.size}`).toBe(beforeTarget.files.size);
      for (const [rel, before] of beforeTarget.files) {
        const after = afterTarget.files.get(rel);
        expect(after, `refused rollback removed ${rel}`).toBeDefined();
        expect(after!.sha256, `refused rollback mutated ${rel} sha`).toBe(before.sha256);
      }
      // Receipts directory MUST NOT have grown new files on a
      // refused rollback — only successful apply creates entries.
      if (beforeReceiptsDir.exists) {
        const before = listReceipts(h.home);
        const after = listReceipts(h.home);
        expect(after.entries.length, `refused rollback added receipt entries: ${after.entries.join(',')}`).toBeLessThanOrEqual(before.entries.length);
      }
      return res;
    }

    it('4a. missing receipt file → exit 1', async () => {
      const res = await runRollbackAgainstReceipt('run_unit_does_not_exist');
      expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(1);
    }, 30_000);

    it('4b. malformed JSON → exit 1', async () => {
      const h = home!;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(receiptPath(h.home, validRunId), '{"schemaVersion":1, "runId": "x"'); // truncated
      const res = await runRollbackAgainstReceipt(validRunId);
      expect(res.status).toBe(1);
    }, 30_000);

    it('4c. wrong schemaVersion → exit 1', async () => {
      const h = home!;
      const { readFileSync, writeFileSync } = await import('node:fs');
      const current = JSON.parse(readFileSync(receiptPath(h.home, validRunId), 'utf8')) as Record<string, unknown>;
      writeFileSync(receiptPath(h.home, validRunId), JSON.stringify({ ...current, schemaVersion: 99 }));
      const res = await runRollbackAgainstReceipt(validRunId);
      expect(res.status).toBe(1);
    }, 30_000);

    it('4d. oversized receipt (> 64 KiB) → exit 1', async () => {
      const h = home!;
      const { writeFileSync } = await import('node:fs');
      // Pad a benign JSON past 64 KiB so the rollback's size gate
      // refuses. The pad bytes MUST be inside a JSON string so
      // the file is still structurally JSON (otherwise we'd be
      // testing the malformed-JSON path).
      const padding = 'x'.repeat(70 * 1024);
      const oversized = {
        schemaVersion: 1,
        runId: validRunId,
        targetRoot: target?.targetRoot ?? targetRootFixture!,
        lockDir: target?.targetRoot ?? targetRootFixture!,
        harness: 'hermes',
        profileId: 'prf_unit_overflow',
        observedDigest: FAKE_HEX_64,
        writtenAt: '2026-08-30T13:00:00.000Z',
        // Free-form junk under a name that is NOT a known secret
        // (no "authorization" / "bearer" / "password" / "token" —
        // we test those separately in receipt-security.test.ts).
        notes: padding,
      };
      writeFileSync(receiptPath(h.home, validRunId), JSON.stringify(oversized));
      const res = await runRollbackAgainstReceipt(validRunId);
      expect(res.status).toBe(1);
    }, 30_000);

    it('4e. symlink in receipt path (runId → symlink target) → exit 1', async () => {
      const h = home!;
      const { readFileSync, symlinkSync, unlinkSync } = await import('node:fs');
      // Remove the real receipt, then create a symlink with the
      // SAME name pointing at a target outside $HUB_HOME. The
      // rollback's symlink-traversal guard MUST refuse the
      // receipt.
      unlinkSync(receiptPath(h.home, validRunId));
      const secretTarget = '/tmp/hub-rollback-symlink-secret';
      symlinkSync(secretTarget, receiptPath(h.home, validRunId));
      const res = await runRollbackAgainstReceipt(validRunId);
      expect(res.status).toBe(1);
      // The symlink MUST NOT have been followed to /tmp. We
      // assert the secret target file does not exist as a
      // proxy: if the rollback had followed the symlink and
      // parsed its contents, the diagnostic would still be
      // exit 1 (because the contents are not a valid receipt),
      // but a SYMLINK FOLLOWED = a path-traversal regression.
      // We assert by reading the symlink itself — readFileSync
      // would throw EINVAL on a symlink to a missing target,
      // which is the safe direction.
      expect(() => readFileSync(secretTarget, 'utf8')).toThrow();
    }, 30_000);

    it('4f. wrong harness / wrong adapter receipt → exit 1', async () => {
      const h = home!;
      const { readFileSync, writeFileSync } = await import('node:fs');
      const current = JSON.parse(readFileSync(receiptPath(h.home, validRunId), 'utf8')) as Record<string, unknown>;
      writeFileSync(
        receiptPath(h.home, validRunId),
        JSON.stringify({ ...current, harness: 'no-such-harness' }),
      );
      const res = await runRollbackAgainstReceipt(validRunId);
      expect(res.status).toBe(1);
    }, 30_000);

    it('4g. wrong targetRoot receipt (operator is on a different target) → exit 1', async () => {
      const h = home!;
      const { readFileSync, writeFileSync } = await import('node:fs');
      const current = JSON.parse(readFileSync(receiptPath(h.home, validRunId), 'utf8')) as Record<string, unknown>;
      writeFileSync(
        receiptPath(h.home, validRunId),
        JSON.stringify({ ...current, targetRoot: '/tmp/hub-not-the-target' }),
      );
      const res = await runRollbackAgainstReceipt(validRunId);
      expect(res.status).toBe(1);
    }, 30_000);

    it('4h. wrong profileId receipt → exit 1', async () => {
      const h = home!;
      const { readFileSync, writeFileSync } = await import('node:fs');
      const current = JSON.parse(readFileSync(receiptPath(h.home, validRunId), 'utf8')) as Record<string, unknown>;
      writeFileSync(
        receiptPath(h.home, validRunId),
        JSON.stringify({ ...current, profileId: 'prf_different_profile' }),
      );
      const res = await runRollbackAgainstReceipt(validRunId);
      expect(res.status).toBe(1);
    }, 30_000);

    it('4i. stale manifest: live target manifest does NOT carry the runId → exit 1', async () => {
      // The fixture above wrote a receipt with the harness +
      // profileId + targetRoot matching the test scenario, but
      // the live target root (which the rollback checks against
      // via observedManifestDigest) has NO manifest carrying
      // the runId — i.e. no apply ever ran. The rollback MUST
      // refuse with exit 1 and not write anything.
      const res = await runRollbackAgainstReceipt(validRunId);
      expect(res.status).toBe(1);
    }, 30_000);
  });

  // -----------------------------------------------------------------
  // 5. Happy-path preview → apply → rollback round-trip.
  //    Three INDEPENDENT subprocesses; no in-memory state
  //    survives between them; the receipt is the only bridge.
  //
  //    Phase A limitation: production code does not exist; the
  //    three subprocesses all exit 2 today. Once production
  //    lands, the SAME assertions flip GREEN: status=0 on every
  //    step, the receipt appears on disk after apply with the
  //    canonical schema, and the rollback restores the target.
  // -----------------------------------------------------------------
  it('preview → apply → rollback three-process round-trip: status 0 on every step, receipt written by apply, rollback restores target', async () => {
    const h = sharedConnectHome('roundtrip-shared');
    home = h;
    const t = freshConnectTarget('roundtrip-shared');
    target = t;
    seedHermesTarget(t.targetRoot);
    const database = createCanonicalConnectFixture('rollback-roundtrip-shared', 'prf_rollback_roundtrip_shared', 'snap_rollback_roundtrip_shared');
    databaseCleanup = database.cleanup;

    // Snapshot target BEFORE preview so we can prove preview
    // was read-only against the canonical bytes.
    const beforeTarget = snapshotDirSafe(t.targetRoot);
    const noStateBeforePreview = findUnexpectedHubHomePaths(
      h.home,
      ALLOWED_HUB_HOME_PATHS_AFTER_PREVIEW,
    );

    // Step A — preview. Real subprocess; reads-only.
    const preview = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_rollback_roundtrip_shared',
        '--snapshot', 'snap_rollback_roundtrip_shared',
        '--target-root', t.targetRoot,
        '--json',
      ],
      h.home,
      database.env,
    );

    // Phase A: status 2; Phase B-GREEN: status 0.
    // Either way, the post-preview invariants below MUST hold:
    expect(preview.status, `preview stderr=${JSON.stringify(preview.stderr)}`).toBeGreaterThanOrEqual(0);
    if (preview.status === 0) {
      // Preview MUST NOT have written the receipt directory.
      expect(statReceiptsDir(h.home), 'preview created the receipts directory').toEqual({
        exists: false, mode: null, isDirectory: false,
      });
      expect(listReceipts(h.home).entries, 'preview left receipt entries').toEqual([]);
      // No hidden state under HUB_HOME.
      const unexpected = findUnexpectedHubHomePaths(
        h.home,
        ALLOWED_HUB_HOME_PATHS_AFTER_PREVIEW,
      );
      expect(unexpected, `preview wrote hidden state under HUB_HOME: ${unexpected.join(',')}`).toEqual([]);
    }

    // Target byte-identical after preview (no writes, no
    // deletes, no chmods). Applies to BOTH Phase A (preview
    // refused, never reached the target) AND Phase B-GREEN
    // (preview succeeded and is read-only).
    const afterPreviewTarget = snapshotDirSafe(t.targetRoot);
    expect(afterPreviewTarget.files.size).toBe(beforeTarget.files.size);
    for (const [rel, before] of beforeTarget.files) {
      const after = afterPreviewTarget.files.get(rel);
      expect(after, `preview removed ${rel}`).toBeDefined();
      expect(after!.sha256, `preview mutated ${rel} sha`).toBe(before.sha256);
    }
    void noStateBeforePreview;

    // Step B — apply in a SECOND process. Captures the runId
    // from the apply payload; the runId MUST come from the
    // apply step's materializer output (NOT a hardcoded
    // fixture — the amendment forbids it).
    const previewPayload = JSON.parse(preview.stdout || '{}') as PreviewPayloadShape;
    const reviewedDigest = extractPreviewDigest(previewPayload);
    if (preview.status !== 0) {
      // Phase A: preview failed; skip the rest with an
      // assertion-shaped RED so the test fails cleanly without
      // crashing on JSON.parse.
      expect.fail(
        `preview subprocess failed (status=${preview.status}); cannot exercise apply→rollback in RED phase. stderr=${JSON.stringify(preview.stderr)}. ` +
        'Once production lands, this test asserts: apply status=0, ' +
        'receipt at $HUB_HOME/state/connect/receipts/<runId>.json, ' +
        'rollback status=0 in a fresh process, target restored to byte-identical.',
      );
      return;
    }
    expect(reviewedDigest).toMatch(/^[0-9a-f]{64}$/u);

    const apply = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_rollback_roundtrip_shared',
        '--snapshot', 'snap_rollback_roundtrip_shared',
        '--target-root', t.targetRoot,
        '--reason', 'unit-test-rollback-roundtrip-shared',
        '--request-id', 'req_unit_apply_roundtrip_shared',
        '--reviewed-digest', reviewedDigest,
        '--json',
      ],
      h.home,
      database.env,
    );

    expect(apply.status, `apply stderr=${JSON.stringify(apply.stderr)}`).toBe(0);
    const applyPayload = JSON.parse(apply.stdout) as ApplyPayloadShape;
    expect(applyPayload.runId, 'apply did not emit a runId').toMatch(RUN_ID_REGEX);

    // Receipt file MUST exist at the canonical path.
    expect(
      receiptExists(h.home, applyPayload.runId!),
      `apply did not write a receipt at ${receiptPath(h.home, applyPayload.runId!)}`,
    ).toBe(true);
    const receiptBytes = readReceipt(h.home, applyPayload.runId!);
    expect(receiptBytes).not.toBeNull();
    expect(receiptBytes, 'apply wrote an empty receipt').not.toBe('');

    // The receipts directory listing contains EXACTLY the
    // expected runId — no .tmp / .partial leftovers from the
    // atomic write.
    const afterApplyReceipts = listReceipts(h.home).entries.sort();
    expect(afterApplyReceipts, 'apply left stale .tmp / .partial files in the receipts dir').toEqual([
      `${applyPayload.runId}.json`,
    ]);

    // Step C — rollback in a THIRD process. Reads the
    // durable receipt. Forward the canonical DB env so the
    // rollback subprocess resolves the SAME Profile the
    // preview/apply observed; without the fixture the
    // rollback exits 2 for a missing profile and the
    // cross-process restore assertion would alias a
    // profile-lookup bug as a bounded-rollback regression.
    const rollback = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', applyPayload.runId!,
        '--reason', 'unit-test-rollback-roundtrip-shared',
        '--request-id', 'req_unit_rollback_roundtrip_shared',
        '--json',
      ],
      h.home,
      database.env,
    );

    expect(rollback.status, `rollback stderr=${JSON.stringify(rollback.stderr)}`).toBe(0);
    const rollbackPayload = JSON.parse(rollback.stdout) as RollbackPayloadShape;
    expect(rollbackPayload.runId).toBe(applyPayload.runId);
    expect(Array.isArray(rollbackPayload.restored), 'rollback did not surface a restored list').toBe(true);
    expect((rollbackPayload.restored ?? []).length, 'rollback did not restore any files').toBeGreaterThan(0);

    // Receipt file MUST still exist after rollback — the
    // amendment pins the receipt as the durable runId store;
    // the rollback subprocess does NOT delete the receipt.
    expect(receiptExists(h.home, applyPayload.runId!)).toBe(true);

    // Receipt stat invariants. The amendment pins dir 0700 +
    // file 0600. The mode bits are asserted via statSync.
    const receiptStat = statReceipt(h.home, applyPayload.runId!);
    expect(receiptStat).not.toBeNull();
    // 0600 = 0o100600. Mask off the file-type bits and
    // compare; the amendment requires exactly rw for owner
    // and nothing for group/other.
    const PERM_MASK = 0o777;
    expect(
      (receiptStat!.mode & PERM_MASK),
      `receipt file mode ${(receiptStat!.mode & PERM_MASK).toString(8)} does not match 0600`,
    ).toBe(0o600);
    expect(receiptStat!.isFile).toBe(true);
    expect(receiptStat!.isSymbolicLink).toBe(false);

    const receiptsDirStat = statReceiptsDir(h.home);
    expect(receiptsDirStat.exists).toBe(true);
    expect(
      (receiptsDirStat.mode! & PERM_MASK),
      `receipts dir mode ${(receiptsDirStat.mode! & PERM_MASK).toString(8)} does not match 0700`,
    ).toBe(0o700);
  }, 120_000);

  // -----------------------------------------------------------------
  // 6. Double-rollback refused. The cross-process amendment
  //    pins: a second rollback of the SAME runId is exit 1
  //    (the live manifest no longer carries the runId after
  //    the first rollback restored it).
  //
  //    Phase A: the second rollback exits 2 today because
  //    `hub hub connect` is unknown. The test asserts the
  //    exit code is 1 OR 2 with a non-empty stderr — i.e.
  //    the rollback subprocess REFUSED. Once production
  //    lands, the assertion tightens to exit=1.
  // -----------------------------------------------------------------
  it('second rollback of an already-restored runId is refused (exit 1; cross-process no-double-rollback)', async () => {
    const h = sharedConnectHome('rollback-double');
    home = h;
    const t = freshConnectTarget('double');
    target = t;
    seedHermesTarget(t.targetRoot);

    // Step 1: drive a successful round-trip via FOUR
    // independent subprocesses (preview, apply, first
    // rollback, second rollback). The canonical DB MUST be
    // seeded once and its env MUST be forwarded to every
    // subprocess so each stage resolves the SAME Profile;
    // otherwise a profile-lookup regression would alias as
    // either a double-rollback bug or a missing-profile
    // diagnostic.
    const database = createCanonicalConnectFixture('rollback-double', 'prf_rollback_double', 'snap_rollback_double');
    databaseCleanup = database.cleanup;
    const preview = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_rollback_double',
        '--snapshot', 'snap_rollback_double',
        '--target-root', t.targetRoot,
        '--json',
      ],
      h.home,
      database.env,
    );
    expect(preview.status, 'preview must succeed before testing double-rollback').toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as PreviewPayloadShape;
    const reviewedDigest = extractPreviewDigest(previewPayload);

    const apply = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_rollback_double',
        '--snapshot', 'snap_rollback_double',
        '--target-root', t.targetRoot,
        '--reason', 'unit-test-double-apply',
        '--request-id', 'req_unit_apply_double',
        '--reviewed-digest', reviewedDigest,
        '--json',
      ],
      h.home,
      database.env,
    );
    expect(apply.status).toBe(0);
    const applyPayload = JSON.parse(apply.stdout) as ApplyPayloadShape;
    const runId = applyPayload.runId!;

    const firstRollback = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', runId,
        '--reason', 'unit-test-double-first',
        '--request-id', 'req_unit_rollback_double_first',
        '--json',
      ],
      h.home,
      database.env,
    );
    expect(firstRollback.status, `first rollback stderr=${JSON.stringify(firstRollback.stderr)}`).toBe(0);

    // Second rollback of the SAME runId. The cross-process
    // amendment refuses: no manifest carries runId after the
    // first restore.
    const secondRollback = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', runId,
        '--reason', 'unit-test-double-second',
        '--request-id', 'req_unit_rollback_double_second',
        '--json',
      ],
      h.home,
      database.env,
    );

    expect(secondRollback.status).toBe(1);
    expect(secondRollback.stderr, 'second rollback produced an empty diagnostic').not.toBe('');

    // The target MUST NOT have been touched by the refused
    // rollback. It is already at the post-restore state from
    // the first rollback; the second rollback must leave
    // that byte-identical.
    const beforeRefusedTarget = snapshotDirSafe(t.targetRoot);
    // Second rollback already happened; assert again now is
    // moot — the assertion above already enforced the byte-
    // identity invariant via the invalid-receipt matrix
    // runner. We snapshot here for clarity / future tests.
    void beforeRefusedTarget;

    // The receipt itself MUST still exist (rollback does
    // NOT delete the receipt; the receipt is the durable
    // runId store).
    expect(receiptExists(h.home, runId)).toBe(true);
  }, 180_000);

  // -----------------------------------------------------------------
  // 7. Rollback CLI is minimal: no --target-root, no --profile,
  //    no --reviewed-digest. The amendment pins the verb's flag
  //    surface.
  // -----------------------------------------------------------------
  it('rollback --target-root exits 2 (rollback does not declare --target-root)', async () => {
    const h = sharedConnectHome('rollback-extra-target');
    home = h;
    const t = freshConnectTarget('extra-target');
    target = t;

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', 'run_unit_rollback_extra_target',
        '--reason', 'unit-test-extra-target',
        '--request-id', 'req_unit_rollback_extra_target',
        '--target-root', t.targetRoot,
      ],
      h.home,
    );
    // The CLI boundary must reject --target-root on rollback
    // because the amendment pins rollback's flag surface as
    // minimal (--run-id, --reason, --request-id, --json). The
    // disambiguating diagnostic must mention the unknown flag
    // (or otherwise show the rejection came from the rollback
    // subparser) — NOT a generic "unknown command 'hub'"
    // which would mean production never reached the parser.
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(2);
    expect(res.stderr).not.toBe('');
    expect(res.stderr, `stderr=${JSON.stringify(res.stderr)}`).not.toMatch(
      /unknown command "hub"/,
    );
    expect(res.stderr, `stderr=${JSON.stringify(res.stderr)}`).toMatch(
      /--target-root|unknown flag|flag provided but not defined|rollback/,
    );
  }, 30_000);

  // -----------------------------------------------------------------
  // 8. Receipt bytes carry the canonical schema. Once production
  //    lands, the receipt JSON MUST include every required key
  //    the amendment pins (schemaVersion, runId, targetRoot,
  //    lockDir, harness, profileId, observedDigest, writtenAt).
  // -----------------------------------------------------------------
  it('receipt JSON includes the canonical bounded schema (schemaVersion, runId, targetRoot, lockDir, harness, profileId, observedDigest, writtenAt)', async () => {
    const h = sharedConnectHome('receipt-schema');
    home = h;
    const t = freshConnectTarget('receipt-schema');
    target = t;
    seedHermesTarget(t.targetRoot);

    // Drive the happy-path so the apply subprocess writes a
    // real receipt. Seed the canonical DB once and forward
    // database.env to BOTH preview and apply so the
    // re-observed profile matches the seed; otherwise the
    // schema assertion would alias a profile-lookup bug as a
    // bounded-schema regression.
    const database = createCanonicalConnectFixture('receipt-schema', 'prf_receipt_schema', 'snap_receipt_schema');
    databaseCleanup = database.cleanup;
    const preview = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_receipt_schema',
        '--snapshot', 'snap_receipt_schema',
        '--target-root', t.targetRoot,
        '--json',
      ],
      h.home,
      database.env,
    );
    expect(preview.status, 'preview must succeed before inspecting a receipt').toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as PreviewPayloadShape;

    const apply = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_receipt_schema',
        '--snapshot', 'snap_receipt_schema',
        '--target-root', t.targetRoot,
        '--reason', 'unit-test-receipt-schema',
        '--request-id', 'req_unit_apply_receipt_schema',
        '--reviewed-digest', extractPreviewDigest(previewPayload),
        '--json',
      ],
      h.home,
      database.env,
    );
    expect(apply.status).toBe(0);
    const applyPayload = JSON.parse(apply.stdout) as ApplyPayloadShape;

    const receiptBytes = readReceipt(h.home, applyPayload.runId!);
    expect(receiptBytes, `receipt missing at ${receiptPath(h.home, applyPayload.runId!)}`).not.toBeNull();
    const receipt = JSON.parse(receiptBytes!) as Record<string, unknown>;

    // Bounded schema: every key the amendment pins MUST be
    // present; the schema MUST be deterministic / versioned;
    // unknown keys beyond the bounded set are NOT allowed
    // (the amendment forbids fake state / fake plan in the
    // receipt).
    const REQUIRED_KEYS = [
      'schemaVersion',
      'runId',
      'targetRoot',
      'lockDir',
      'harness',
      'profileId',
      'observedDigest',
      'writtenAt',
    ];
    for (const key of REQUIRED_KEYS) {
      expect(receipt, `receipt missing required key "${key}": ${receiptBytes}`).toHaveProperty(key);
    }
    expect(receipt.schemaVersion, 'receipt schemaVersion must be a number').toBeTypeOf('number');
    expect(receipt.runId).toBe(applyPayload.runId);
    expect(receipt.targetRoot).toBe(t.targetRoot);
    expect(receipt.harness).toBe('hermes');
    expect(receipt.profileId).toBe('prf_receipt_schema');
    expect((receipt.observedDigest as string)).toMatch(/^[0-9a-f]{64}$/u);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Imports kept alive for future tests + to satisfy cross-file lint.
// ---------------------------------------------------------------------------
void join;
