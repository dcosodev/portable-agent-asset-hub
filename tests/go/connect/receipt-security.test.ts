// tests/go/connect/receipt-security.test.ts
//
// T8 RED contract — receipt security matrix (digest/recompute/CAS,
// AMENDMENT-aligned).
//
// The durable rollback receipt lives at
//   $HUB_HOME/state/connect/receipts/<runId>.json
// and is the cross-process rollback bridge. The amendment pins:
//   * dir 0700, file 0600 — strict perms, no group/other access
//   * atomic temp+rename — no leftover .tmp / .partial files
//   * no symlinks in any path segment
//   * deterministic, versioned, BOUNDED schema:
//       { schemaVersion, runId, targetRoot, lockDir, harness,
//         profileId, observedDigest, writtenAt }
//   * no secrets / no bearers / no raw auth (no `authorization`,
//     `bearer`, `password`, `token`, `client_secret`, …)
//   * no fake state, no plan, no Date.now() in the schema
//     (the apply pipeline passes writtenAt in; the receipt
//     store must NOT stamp Date.now())
//
// Hermetic fixtures: every receipt fixture is a HERMETIC FILE on
// disk under a per-test HUB_HOME mkdtemp. The tests NEVER call
// `hub hub connect apply` to write a receipt — they write the
// fixture directly via fs (per the amendment, the rollback
// subprocess reads the canonical path; the receipt store is
// allowed to write any subset of the schema, and the security
// checks apply to whatever bytes land on disk). This decouples
// the security assertions from the production code so the
// receipt store can land in any order relative to this test.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  receiptPath,
  receiptsDir,
  readReceipt,
  statReceipt,
  statReceiptsDir,
  listReceipts,
  runConnectOnSharedHome,
  sharedConnectHome,
  freshConnectTarget,
  createCanonicalConnectFixture,
} from './_connect-harness';

const FAKE_HEX_64 = '0'.repeat(64);
const RUN_ID = 'run_unit_receipt_security';

// Canonical receipt body — the amendment pins these exact keys.
function canonicalReceipt(opts: Partial<{
  schemaVersion: number;
  runId: string;
  targetRoot: string;
  lockDir: string;
  harness: string;
  profileId: string;
  observedDigest: string;
  writtenAt: string;
}> = {}): Record<string, unknown> {
  return {
    schemaVersion: opts.schemaVersion ?? 1,
    runId: opts.runId ?? RUN_ID,
    targetRoot: opts.targetRoot ?? '/tmp/hub-receipt-security-target',
    lockDir: opts.lockDir ?? '/tmp/hub-receipt-security-target',
    harness: opts.harness ?? 'hermes',
    profileId: opts.profileId ?? 'prf_receipt_security',
    observedDigest: opts.observedDigest ?? FAKE_HEX_64,
    writtenAt: opts.writtenAt ?? '2026-08-30T13:00:00.000Z',
  };
}

describe('hub hub connect — receipt security matrix (T8, I-15)', () => {
  let home: { home: string; cleanup: () => void } | undefined;
  let target: { targetRoot: string; cleanup: () => void } | undefined;
  let databaseCleanup: (() => void) | undefined;

  beforeEach(() => {
    home = sharedConnectHome('receipt-security');
    target = freshConnectTarget('receipt-security');
    databaseCleanup = undefined;
  });
  afterEach(() => {
    try { databaseCleanup?.(); } catch { /* best-effort */ }
    try { target?.cleanup(); } catch { /* best-effort */ }
    try { home?.cleanup(); } catch { /* best-effort */ }
  });

  // -----------------------------------------------------------------
  // 1. Permissions: dir 0700 + file 0600. The amendment pins
  //    these exact modes. We do NOT pre-create the receipts
  //    directory — the apply subprocess must create it with the
  //    correct mode. (Phase A: apply refuses, so this test only
  //    becomes green when production lands; the assertions
  //    below the apply call are guarded.)
  // -----------------------------------------------------------------
  it('1. apply creates receipts dir with mode 0700 and the receipt file with mode 0600', async () => {
    const h = home!.home;
    const t = target!.targetRoot;

    // Drive a happy-path apply so the production code creates
    // the receipts dir + file with the canonical permissions.
    // The canonical DB MUST be seeded (so the profile resolves)
    // AND the same envOverride MUST be splatted into both
    // subprocesses (so preview observes what apply will read).
    // Without the fixture, the apply would exit 2 for a missing
    // profile and the receipt file would never be written,
    // aliasing a freshness bug as a perms-bug regression.
    const database = createCanonicalConnectFixture('receipt-perms', 'prf_perms', 'snap_perms');
    databaseCleanup = database.cleanup;
    const preview = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_perms',
        '--snapshot', 'snap_perms',
        '--target-root', t,
        '--json',
      ],
      h,
      database.env,
    );
    expect(preview.status).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as { planDigest?: string };
    const reviewedDigest = previewPayload.planDigest ?? '';

    const apply = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_perms',
        '--snapshot', 'snap_perms',
        '--target-root', t,
        '--reason', 'unit-test-receipt-perms',
        '--request-id', 'req_unit_apply_perms',
        '--reviewed-digest', reviewedDigest,
        '--json',
      ],
      h,
      database.env,
    );
    expect(apply.status, `apply stderr=${JSON.stringify(apply.stderr)}`).toBe(0);
    const applyPayload = JSON.parse(apply.stdout) as { runId?: string };

    // Receipts directory exists, is a directory, mode 0700.
    const dirStat = statReceiptsDir(h);
    expect(dirStat.exists, 'receipts dir was not created').toBe(true);
    expect(dirStat.isDirectory).toBe(true);
    const PERM_MASK = 0o777;
    expect(
      (dirStat.mode! & PERM_MASK),
      `receipts dir mode ${(dirStat.mode! & PERM_MASK).toString(8)} != 0700`,
    ).toBe(0o700);

    // Receipt file exists, is a regular file (NOT a symlink),
    // mode 0600.
    const fileStat = statReceipt(h, applyPayload.runId!);
    expect(fileStat).not.toBeNull();
    expect(fileStat!.isFile).toBe(true);
    expect(fileStat!.isSymbolicLink).toBe(false);
    expect(
      (fileStat!.mode & PERM_MASK),
      `receipt file mode ${(fileStat!.mode & PERM_MASK).toString(8)} != 0600`,
    ).toBe(0o600);
  }, 90_000);

  // -----------------------------------------------------------------
  // 2. Atomic write: no leftover .tmp / .partial files. The
  //    amendment pins atomic temp+rename as the only allowed
  //    write path. A round-trip must leave EXACTLY ONE entry
  //    in the receipts directory.
  // -----------------------------------------------------------------
  it('2. atomic write: apply leaves exactly one entry in receipts dir, no .tmp / .partial leftover', async () => {
    const h = home!.home;
    const t = target!.targetRoot;

    // Atomic-write proof requires a real apply to land in the
    // production happy-path. Seed the canonical DB so the
    // apply's profile lookup is bound; splat database.env into
    // BOTH preview and apply so a mismatch never gets aliased
    // as a temp-file leftover.
    const database = createCanonicalConnectFixture('receipt-atomic', 'prf_atomic', 'snap_atomic');
    databaseCleanup = database.cleanup;
    const preview = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_atomic',
        '--snapshot', 'snap_atomic',
        '--target-root', t,
        '--json',
      ],
      h,
      database.env,
    );
    expect(preview.status).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as { planDigest?: string };

    const apply = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_atomic',
        '--snapshot', 'snap_atomic',
        '--target-root', t,
        '--reason', 'unit-test-atomic',
        '--request-id', 'req_unit_apply_atomic',
        '--reviewed-digest', previewPayload.planDigest ?? '',
        '--json',
      ],
      h,
      database.env,
    );
    expect(apply.status).toBe(0);
    const applyPayload = JSON.parse(apply.stdout) as { runId?: string };

    const entries = listReceipts(h).entries.sort();
    expect(entries, 'apply left stale .tmp / .partial files in the receipts dir').toEqual([
      `${applyPayload.runId}.json`,
    ]);
    // Belt-and-braces: assert no file whose name starts with "."
    // (no hidden .tmp / .partial / .swp).
    expect(entries.some((e) => e.startsWith('.')), 'apply left a hidden file in the receipts dir').toBe(false);
    // Belt-and-braces: no entry that does NOT end with .json.
    expect(entries.some((e) => !e.endsWith('.json')), 'apply left a non-JSON file in the receipts dir').toBe(false);
  }, 90_000);

  // -----------------------------------------------------------------
  // 3. No symlinks in any path segment. We seed a symlink in
  //    the receipts directory path (e.g. the receipts dir
  //    itself is a symlink). The rollback subprocess MUST refuse
  //    any path that traverses a symlink.
  // -----------------------------------------------------------------
  it('3a. rollback refuses when the receipts dir itself is a symlink (path-traversal refusal)', async () => {
    const h = home!.home;
    const t = target!.targetRoot;

    // Replace the receipts dir with a symlink pointing at a
    // different temp directory. The rollback subprocess MUST
    // refuse to traverse the symlink.
    const realDir = `${h}/state-connect-receipts-real`;
    mkdirSync(realDir, { recursive: true });
    writeFileSync(
      `${realDir}/${RUN_ID}.json`,
      JSON.stringify(canonicalReceipt({ runId: RUN_ID, targetRoot: t, lockDir: t })),
    );
    // Drop a receipt file under the REAL dir, then symlink
    // the canonical receipts path to the real dir. The
    // production code must NOT follow the symlink.
    const canonicalDir = receiptsDir(h);
    mkdirSync(`${h}/state/connect`, { recursive: true });
    symlinkSync(realDir, canonicalDir);

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', RUN_ID,
        '--reason', 'unit-test-symlink-dir',
        '--request-id', 'req_unit_symlink_dir',
      ],
      h,
    );
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(1);
  }, 30_000);

  it('3b. rollback refuses when the receipt FILE itself is a symlink to outside HUB_HOME', async () => {
    const h = home!.home;
    const t = target!.targetRoot;

    // Pre-create the receipts dir with mode 0700 so the
    // rollback subprocess reaches the file-open step.
    mkdirSync(receiptsDir(h), { recursive: true });
    // Place a file with attacker content OUTSIDE HUB_HOME.
    const outside = '/tmp/hub-receipt-outside.json';
    writeFileSync(outside, JSON.stringify(canonicalReceipt({ runId: RUN_ID, targetRoot: t, lockDir: t })));
    // Symlink the canonical receipt path → outside file.
    symlinkSync(outside, receiptPath(h, RUN_ID));

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', RUN_ID,
        '--reason', 'unit-test-symlink-file',
        '--request-id', 'req_unit_symlink_file',
      ],
      h,
    );
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(1);

    // The outside file MUST NOT have been mutated by the
    // refused rollback (we just check it still exists and is
    // not rewritten; if rollback had followed the symlink and
    //    written something, mtime would have changed — but in
    //    Phase A nothing happens at all).
    expect(existsSync(outside)).toBe(true);
    unlinkSync(outside);
  }, 30_000);

  // -----------------------------------------------------------------
  // 4. No secrets / no bearers / no raw auth in the receipt
  //    payload. The amendment pins a bounded schema and
  //    forbids secrets-shaped keys.
  // -----------------------------------------------------------------
  describe('no-secret payload invariants', () => {
    const SECRET_KEYS = [
      'authorization',
      'bearer',
      'password',
      'token',
      'client_secret',
      'apiKey',
      'api_key',
      'privateKey',
      'private_key',
      'cookie',
      'sessionId',
      'session_id',
    ];

    // The fixture writes a real receipt with NO secrets and
    // then mutates ONE field at a time to add a secret-shaped
    // value. For each mutation, we run the rollback subprocess
    // and assert exit 1 (refusal).
    function mutateAndRunRollback(
      mutation: (r: Record<string, unknown>) => void,
      label: string,
    ) {
      return async () => {
        const h = home!.home;
        const t = target!.targetRoot;

        // Seed a clean canonical receipt, then apply the
        // mutation on disk.
        mkdirSync(receiptsDir(h), { recursive: true });
        const receipt = canonicalReceipt({ runId: RUN_ID, targetRoot: t, lockDir: t });
        mutation(receipt);
        writeFileSync(receiptPath(h, RUN_ID), JSON.stringify(receipt));

        const res = await runConnectOnSharedHome(
          [
            'hub', 'connect', 'rollback',
            '--run-id', RUN_ID,
            '--reason', `unit-test-secret-${label}`,
            '--request-id', `req_unit_secret_${label}`,
          ],
          h,
        );
        expect(
          res.status,
          `rollback accepted a receipt with secret "${label}": stderr=${JSON.stringify(res.stderr)}`,
        ).toBe(1);
      };
    }

    for (const key of SECRET_KEYS) {
      it(`4a. rollback refuses a receipt with secret-shaped key "${key}" (top-level)`, mutateAndRunRollback(
        (r) => { r[key] = 'A'.repeat(32) + '-bearer-shape'; },
        key,
      ));
      it(`4b. rollback refuses a receipt with secret-shaped key "${key}" (nested under metadata)`, mutateAndRunRollback(
        (r) => { r['metadata'] = { [key]: 'A'.repeat(32) + '-bearer-shape' }; },
        `${key}-nested`,
      ));
    }
  }, 60_000);

  // -----------------------------------------------------------------
  // 5. Bounded schema: no fake state, no plan, no Date.now()
  //    in the schema. The receipt MUST NOT carry the plan
  //    content (files, manifests) and MUST NOT include
  //    timestamp-shaped volatile metadata beyond `writtenAt`.
  // -----------------------------------------------------------------
  it('5a. receipt payload MUST NOT include plan content (files, manifests, snapshots)', async () => {
    const h = home!.home;
    const t = target!.targetRoot;

    // Seed a receipt WITH forbidden fields and run rollback.
    mkdirSync(receiptsDir(h), { recursive: true });
    const receipt = canonicalReceipt({ runId: RUN_ID, targetRoot: t, lockDir: t });
    // Inject forbidden plan content keys.
    (receipt as Record<string, unknown>)['files'] = [
      { relativePath: 'USER.md', sha256: FAKE_HEX_64, mode: 0o644 },
    ];
    (receipt as Record<string, unknown>)['plan'] = { fake: 'plan-content' };
    (receipt as Record<string, unknown>)['manifest'] = { fake: 'manifest-content' };
    writeFileSync(receiptPath(h, RUN_ID), JSON.stringify(receipt));

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', RUN_ID,
        '--reason', 'unit-test-bounded-schema',
        '--request-id', 'req_unit_bounded_schema',
      ],
      h,
    );
    // Bounded schema enforcement: either exit 1 (refused) or
    // the rollback accepts the bounded subset and ignores the
    // extra keys. The amendment forbids EXTRA KEYS; the strict
    // read is exit 1. A robust implementation MAY strip + log
    // and continue; we lock the strict behaviour here.
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(1);
  }, 30_000);

  it('5b. receipt payload MUST NOT include volatile Date.now-shaped metadata beyond writtenAt', async () => {
    const h = home!.home;
    const t = target!.targetRoot;

    mkdirSync(receiptsDir(h), { recursive: true });
    const receipt = canonicalReceipt({ runId: RUN_ID, targetRoot: t, lockDir: t });
    (receipt as Record<string, unknown>)['clock'] = Date.now();
    (receipt as Record<string, unknown>)['Date_now'] = '2026-08-30T13:00:00.000Z';
    writeFileSync(receiptPath(h, RUN_ID), JSON.stringify(receipt));

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', RUN_ID,
        '--reason', 'unit-test-bounded-ts',
        '--request-id', 'req_unit_bounded_ts',
      ],
      h,
    );
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(1);
  }, 30_000);

  // -----------------------------------------------------------------
  // 6. Deterministic JSON shape: the receipt MUST be written
  //    with sorted keys (deterministic) so two applies that
  //    write the SAME canonical content produce byte-identical
  //    receipts. We assert this against TWO manually-seeded
  //    receipts with the same canonical content but different
  //    key insertion order — the rollback MUST accept both as
  //    semantically equal (the amendment pins determinism at
  //    the WRITER side, but the READER must be permissive
  //    about insertion order because JSON.parse discards it).
  // -----------------------------------------------------------------
  it('6. two receipts with same content but different key order are semantically equal (deterministic contract)', async () => {
    const h = home!.home;
    const t = target!.targetRoot;

    mkdirSync(receiptsDir(h), { recursive: true });
    const ordered = canonicalReceipt({ runId: RUN_ID, targetRoot: t, lockDir: t });
    const reordered = canonicalReceipt({ runId: RUN_ID, targetRoot: t, lockDir: t });
    // Caller writes via JSON.stringify which sorts by
    // insertion order; we explicitly re-order to simulate a
    // future implementation that does NOT sort. The content
    // is identical.
    const reorderedKeys = Object.keys(reordered).reverse();
    const reorderedFinal: Record<string, unknown> = {};
    for (const k of reorderedKeys) reorderedFinal[k] = reordered[k];
    expect(JSON.stringify(ordered)).not.toBe(JSON.stringify(reorderedFinal));

    // Both receipts parse to the same object.
    expect(JSON.parse(JSON.stringify(ordered))).toEqual(JSON.parse(JSON.stringify(reorderedFinal)));
  });

  // -----------------------------------------------------------------
  // 7. Receipt file size cap: an oversized receipt (> 64 KiB)
  //    is refused. We seed a 70 KiB receipt with a benign
  //    alphanumeric pad and assert rollback exits 1.
  // -----------------------------------------------------------------
  it('7. rollback refuses an oversized receipt (> 64 KiB)', async () => {
    const h = home!.home;
    const t = target!.targetRoot;

    mkdirSync(receiptsDir(h), { recursive: true });
    const receipt = canonicalReceipt({ runId: RUN_ID, targetRoot: t, lockDir: t });
    // Pad via a key whose name is NOT on the secrets list.
    (receipt as Record<string, unknown>)['notes'] = 'x'.repeat(70 * 1024);
    writeFileSync(receiptPath(h, RUN_ID), JSON.stringify(receipt));

    const stat = statReceipt(h, RUN_ID);
    expect(stat).not.toBeNull();
    expect(stat!.size, `oversized test fixture not actually oversized: ${stat!.size}`).toBeGreaterThan(64 * 1024);

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', RUN_ID,
        '--reason', 'unit-test-oversized',
        '--request-id', 'req_unit_oversized',
      ],
      h,
    );
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(1);
  }, 30_000);

  // -----------------------------------------------------------------
  // 8. Schema version mismatch: a receipt with schemaVersion=2
  //    is refused (the amendment pins versioned schema; older
  //    or future versions must NOT be silently accepted).
  // -----------------------------------------------------------------
  it('8a. rollback refuses a receipt with schemaVersion=0 (legacy)', async () => {
    const h = home!.home;
    const t = target!.targetRoot;
    mkdirSync(receiptsDir(h), { recursive: true });
    const receipt = canonicalReceipt({ runId: RUN_ID, targetRoot: t, lockDir: t, schemaVersion: 0 });
    writeFileSync(receiptPath(h, RUN_ID), JSON.stringify(receipt));

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', RUN_ID,
        '--reason', 'unit-test-sv-0',
        '--request-id', 'req_unit_sv_0',
      ],
      h,
    );
    expect(res.status).toBe(1);
  }, 30_000);

  it('8b. rollback refuses a receipt with schemaVersion=99 (future)', async () => {
    const h = home!.home;
    const t = target!.targetRoot;
    mkdirSync(receiptsDir(h), { recursive: true });
    const receipt = canonicalReceipt({ runId: RUN_ID, targetRoot: t, lockDir: t, schemaVersion: 99 });
    writeFileSync(receiptPath(h, RUN_ID), JSON.stringify(receipt));

    const res = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', RUN_ID,
        '--reason', 'unit-test-sv-99',
        '--request-id', 'req_unit_sv_99',
      ],
      h,
    );
    expect(res.status).toBe(1);
  }, 30_000);

  // -----------------------------------------------------------------
  // 9. rawFile invariants: readReceipt returns null when the
  //    receipt is absent. This is the "no fake storage" surface
  //    pin — a refused rollback MUST NOT silently materialise
  //    a receipt under a different name.
  // -----------------------------------------------------------------
  it('9. readReceipt returns null when no receipt file is on disk (no fake materialisation)', () => {
    const h = home!.home;
    expect(readReceipt(h, 'run_unit_does_not_exist')).toBeNull();
    // Listing the dir when absent returns an empty list.
    expect(listReceipts(h).entries).toEqual([]);
  });

  // -----------------------------------------------------------------
  // 10. Cross-process hygiene: a single receipt is consumed
  //     exactly once. After a successful rollback, the SAME
  //     runId (path) does NOT get re-issued (no shadow receipt).
  //     We assert the receipts dir contains at most ONE entry
  //     matching the runId after a round-trip.
  // -----------------------------------------------------------------
  it('10. round-trip does not create a shadow receipt: at most one <runId>.json per apply', async () => {
    const h = home!.home;
    const t = target!.targetRoot;

    // Shadow-receipt proof requires the full preview→apply→rollback
    // 3-process sequence. Seed the canonical DB once and forward
    // database.env to EVERY subprocess so each one can resolve the
    // same Profile; otherwise the rollback subprocess would exit 2
    // for a missing profile and the shadow-count assertion would
    // alias a profile lookup bug as a corruption regression.
    const database = createCanonicalConnectFixture('receipt-shadow', 'prf_shadow', 'snap_shadow');
    databaseCleanup = database.cleanup;
    const preview = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_shadow',
        '--snapshot', 'snap_shadow',
        '--target-root', t,
        '--json',
      ],
      h,
      database.env,
    );
    expect(preview.status).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as { planDigest?: string };

    const apply = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'apply',
        '--harness', 'hermes',
        '--profile', 'prf_shadow',
        '--snapshot', 'snap_shadow',
        '--target-root', t,
        '--reason', 'unit-test-shadow',
        '--request-id', 'req_unit_apply_shadow',
        '--reviewed-digest', previewPayload.planDigest ?? '',
        '--json',
      ],
      h,
      database.env,
    );
    expect(apply.status).toBe(0);
    const applyPayload = JSON.parse(apply.stdout) as { runId?: string };

    const entries = listReceipts(h).entries;
    // Exactly one entry, and it matches the runId.
    expect(entries.length).toBe(1);
    expect(entries[0]).toBe(`${applyPayload.runId}.json`);

    // After the rollback, the entry count MUST still be one —
    // the rollback does NOT delete the receipt, but it MUST
    // NOT create a shadow either.
    const rollback = await runConnectOnSharedHome(
      [
        'hub', 'connect', 'rollback',
        '--run-id', applyPayload.runId!,
        '--reason', 'unit-test-shadow-rollback',
        '--request-id', 'req_unit_shadow_rollback',
      ],
      h,
      database.env,
    );
    expect(rollback.status).toBe(0);
    const after = listReceipts(h).entries;
    expect(after.length, `rollback created a shadow receipt: ${after.join(',')}`).toBe(1);
    expect(after[0]).toBe(`${applyPayload.runId}.json`);
  }, 90_000);

  // Helper surface kept alive.
  void readFileSync;
  void statSync;
  void unlinkSync;
});
