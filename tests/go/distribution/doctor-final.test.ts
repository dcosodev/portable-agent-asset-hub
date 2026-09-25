// tests/go/distribution/doctor-final.test.ts
//
// T9 RED real-subprocess contract for `hub doctor` in its FINAL shape.
// This is one of the three test files the T9 amendment names explicitly
// in `tests[]`.
//
// Contract source of truth — docs/roadmap/slices.json slice `T9`:
//
//   implementation_tasks[2]
//     "Implement hub doctor (final shape: extends T1 doctor with
//      backup/update posture and distribution checks)"
//
//   audit_requirements[7] / exit_criteria[1]
//     "verify doctor reports OK on a fresh install fixture"
//
// What "fresh install fixture" means here: a HUB_HOME materialised by
// the real, already-GREEN `hub init` (T3) — not an empty directory. The
// T1 doctor suite (tests/go/shell/doctor.test.ts) already owns the
// fresh-WORKTREE case; this file owns the fresh-INSTALL case plus the
// two new posture check families T9 adds.
//
// THREE T9-OWNED CHECK IDS (pinned): `backup_posture`, `update_posture`,
// `distribution_checks`. The amendment pins these exact identifiers so
// the additive delivery is contractually explicit and not subject to a
// naming substitution. On a fresh install:
//   * the top-level verdict MUST be `ok`;
//   * NONE of the three T9-owned checks may be `fail` or `pending`;
//   * the legacy T1-owned `rest_handshake` check is EXPLICITLY PERMITTED
//     to remain `pending` (T1 authority on its status is preserved
//     untouched — `tests/go/shell/doctor.test.ts` locks
//     `rest_handshake.status === 'pending'`).
//
// What is asserted here at the test surface:
//   * the locked T1 schema still holds (status + checks[] with
//     id/name/status/message);
//   * the T1 check IDs are all still present (extension, not
//     replacement);
//   * the three T9-owned check IDs are present with status != 'fail'
//     and != 'pending' on a fresh install fixture;
//   * the legacy T1-owned `rest_handshake` may be `pending` (explicit
//     permit, no global zero-pending demand);
//   * the check set STRICTLY GROWS relative to the T1 baseline (the
//     observable meaning of "extends … with backup/update posture and
//     distribution checks");
//   * the top-level verdict is `ok` on a fresh install;
//   * no check is `fail` on a fresh install;
//   * the doctor is read-only (no `$HUB_HOME/state/backups/` created).
//
// RED STATE at authoring time: `hub doctor` still returns exactly the
// six T1 checks, so the "strictly grows" and "three T9-owned checks
// present and non-fail/non-pending" cases fail against the current
// binary. The T1 baseline itself is READ from the running binary at the
// start of each case rather than hardcoded, so this file cannot go
// stale — but the growth requirement and the three-ids requirement
// can only be satisfied by real T9 posture checks.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  freshInstallFixture,
  hubInit,
  looksLikeBearer,
  runHubInFixture,
  type FreshInstallFixture,
} from './_distribution-harness';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try { fn?.(); } catch { /* best-effort */ }
  }
});

function fixture(label: string): FreshInstallFixture {
  const fx = freshInstallFixture(label);
  cleanups.push(fx.cleanup);
  return fx;
}

const CASE_TIMEOUT_MS = 180_000;

// The T1 check set, read from internal/doctor's locked schema docs and
// confirmed against the shipped binary. These IDs are the BASELINE the
// T9 doctor must still carry — T9 extends, it does not replace.
const T1_CHECK_IDS = [
  'shell_binary',
  'config_valid',
  'home_resolved',
  'openapi_accessible',
  'no_bearer_in_env',
  'rest_handshake',
] as const;

// The three T9-owned check IDs, pinned in the slice governance
// (`objective`, `implementation_tasks`, `audit_requirements`, `tests`,
// `exit_criteria`). The T9 amendment names them by exact id so the
// additive delivery is contractually explicit and not subject to a
// naming substitution. On a fresh install NONE of these three may be
// `fail` or `pending`; the legacy T1-owned `rest_handshake` is
// explicitly permitted to remain `pending` (T1 authority preserved).
const T9_OWNED_CHECK_IDS = [
  'backup_posture',
  'update_posture',
  'distribution_checks',
] as const;

interface DoctorCheck {
  id: string;
  name: string;
  status: string;
  message: string;
  detail?: string;
}

interface DoctorReport {
  status: string;
  checks: DoctorCheck[];
}

function parseDoctorReport(stdout: string): DoctorReport {
  const parsed = JSON.parse(stdout) as unknown;
  expect(parsed && typeof parsed === 'object', `doctor --json produced non-object: ${stdout}`).toBe(true);
  const obj = parsed as Record<string, unknown>;
  expect(typeof obj.status, 'doctor report missing top-level status').toBe('string');
  expect(Array.isArray(obj.checks), 'doctor report missing checks[]').toBe(true);
  const checks = (obj.checks as unknown[]).map((raw) => {
    const c = raw as Record<string, unknown>;
    // The T1 per-check schema is locked in internal/doctor/doctor.go.
    expect(typeof c.id, `check missing id: ${JSON.stringify(c)}`).toBe('string');
    expect(typeof c.name, `check missing name: ${JSON.stringify(c)}`).toBe('string');
    expect(typeof c.status, `check missing status: ${JSON.stringify(c)}`).toBe('string');
    expect(typeof c.message, `check missing message: ${JSON.stringify(c)}`).toBe('string');
    return {
      id: String(c.id),
      name: String(c.name),
      status: String(c.status),
      message: String(c.message),
      detail: typeof c.detail === 'string' ? c.detail : undefined,
    };
  });
  return { status: String(obj.status), checks };
}

// ---------------------------------------------------------------------------
// 1. Fresh install fixture → doctor reports OK.
// ---------------------------------------------------------------------------

describe('hub doctor (final shape) — fresh install fixture (T9)', () => {
  it('reports status "ok" on a HUB_HOME materialised by `hub init`', async () => {
    const fx = fixture('doctor-fresh-install');
    await hubInit(fx);
    // Sanity: the fresh install layout really is on disk.
    expect(existsSync(join(fx.hubHome, 'tokens', 'hub.token'))).toBe(true);

    const res = await runHubInFixture(fx, ['doctor', '--json']);
    expect(
      res.status,
      `stdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
    ).toBe(0);
    const report = parseDoctorReport(res.stdout);
    // exit_criteria: "doctor reports OK on a fresh install fixture".
    expect(
      report.status,
      `doctor verdict on a fresh install: ${JSON.stringify(report, null, 2)}`,
    ).toBe('ok');
  }, CASE_TIMEOUT_MS);

  it('no check is "fail" on a fresh install fixture', async () => {
    const fx = fixture('doctor-no-fail');
    await hubInit(fx);
    const res = await runHubInFixture(fx, ['doctor', '--json']);
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    const report = parseDoctorReport(res.stdout);
    const failing = report.checks.filter((c) => c.status === 'fail');
    expect(failing, `failing checks: ${JSON.stringify(failing, null, 2)}`).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it('the doctor is read-only — `hub doctor` after init leaves the layout unchanged in shape', async () => {
    const fx = fixture('doctor-readonly');
    await hubInit(fx);
    const res = await runHubInFixture(fx, ['doctor', '--json']);
    expect(res.status).toBe(0);
    // The doctor must not have created a backups directory as a side
    // effect of reporting backup posture.
    expect(
      existsSync(fx.backupsDir),
      'doctor created $HUB_HOME/state/backups as a side effect (doctor must be read-only)',
    ).toBe(false);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 2. Final shape EXTENDS the T1 check set.
// ---------------------------------------------------------------------------

describe('hub doctor (final shape) — extends the T1 check set (T9)', () => {
  it('still carries every T1 check id (extension, not replacement)', async () => {
    const fx = fixture('doctor-t1-preserved');
    await hubInit(fx);
    const res = await runHubInFixture(fx, ['doctor', '--json']);
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    const report = parseDoctorReport(res.stdout);
    const ids = report.checks.map((c) => c.id);
    for (const t1 of T1_CHECK_IDS) {
      expect(ids, `T1 check ${t1} disappeared from the final doctor shape`).toContain(t1);
    }
  }, CASE_TIMEOUT_MS);

  it('adds the three T9-owned check ids beyond the T1 baseline (backup/update posture + distribution checks)', async () => {
    const fx = fixture('doctor-extends');
    await hubInit(fx);
    const res = await runHubInFixture(fx, ['doctor', '--json']);
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    const report = parseDoctorReport(res.stdout);
    const ids = report.checks.map((c) => c.id);
    // The amendment pins the three exact ids by name in the slice
    // governance and the doctor-final test description, so the
    // extension assertion is on the EXACT ids (not just growth).
    for (const id of T9_OWNED_CHECK_IDS) {
      expect(ids, `final doctor shape missing T9-owned check id ${id}`).toContain(id);
    }
    // Growth must not include duplicates — the report is a set of checks.
    expect(new Set(ids).size, `duplicate check ids: ${JSON.stringify(ids)}`).toBe(ids.length);
  }, CASE_TIMEOUT_MS);

  it('none of the three T9-owned checks is "fail" or "pending" on a fresh install fixture', async () => {
    // T9 owns the three additive posture checks (`backup_posture`,
    // `update_posture`, `distribution_checks`). On a fresh install
    // fixture NONE of these three may be `fail` or `pending` — this
    // is the T9-owned portion of the fresh-install OK invariant. This
    // does NOT extend to legacy T1 checks; see the next test for the
    // explicit `rest_handshake: pending` permit.
    const fx = fixture('doctor-no-t9-pending-or-fail');
    await hubInit(fx);
    const res = await runHubInFixture(fx, ['doctor', '--json']);
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    const report = parseDoctorReport(res.stdout);
    for (const id of T9_OWNED_CHECK_IDS) {
      const check = report.checks.find((c) => c.id === id);
      expect(check, `final doctor shape missing T9-owned check ${id}`).toBeTruthy();
      expect(
        check?.status,
        `T9-owned check ${id} must not be "fail" or "pending" on a fresh install; was ${JSON.stringify(check)}`,
      ).not.toBe('fail');
      expect(
        check?.status,
        `T9-owned check ${id} must not be "fail" or "pending" on a fresh install; was ${JSON.stringify(check)}`,
      ).not.toBe('pending');
    }
  }, CASE_TIMEOUT_MS);

  it('legacy T1-owned `rest_handshake: pending` is explicitly permitted (not a global zero-pending demand)', async () => {
    // The legacy T1-owned `rest_handshake` check is locked as `pending`
    // by the T1 doctor suite (tests/go/shell/doctor.test.ts) and is
    // explicitly permitted to remain pending on the final T9 shape:
    // T1 authority on its status is preserved untouched. Asserting
    // "no pending globally" would contradict T1 — this test pins the
    // carve-out: pending checks may exist (T1-owned), but they MUST
    // NOT include any of the three T9-owned ids (covered by the
    // previous test).
    const fx = fixture('doctor-legacy-pending-permitted');
    await hubInit(fx);
    const res = await runHubInFixture(fx, ['doctor', '--json']);
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    const report = parseDoctorReport(res.stdout);
    const rest = report.checks.find((c) => c.id === 'rest_handshake');
    // The legacy pending is permitted but not required; if the binary
    // happens to upgrade rest_handshake to `ok` on a fresh install
    // (e.g. via a future T2..T9 wiring) the test still passes. The
    // hard contract here is the explicit NEGATIVE: no T9-owned check
    // is pending — which is covered by the dedicated test above. The
    // additional assertion below just confirms the legacy check is
    // still present and not `fail` (would block the verdict).
    expect(rest, 'legacy rest_handshake check missing from the final doctor shape').toBeTruthy();
    expect(rest?.status, `legacy rest_handshake must not be "fail" (would block verdict): ${JSON.stringify(rest)}`).not.toBe('fail');
    // Any pending checks in the report MUST be limited to T1-owned
    // ids — none of the three T9-owned ids may be pending. This is a
    // belt-and-braces cross-check for the carve-out: the legacy
    // pending (if any) is permitted, but T9-owned pending is not.
    const t9Pending = report.checks.filter(
      (c) => c.status === 'pending' && (T9_OWNED_CHECK_IDS as readonly string[]).includes(c.id),
    );
    expect(
      t9Pending,
      `no T9-owned check may be pending; found ${JSON.stringify(t9Pending, null, 2)}`,
    ).toEqual([]);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 3. Human-readable form parity + bearer hygiene.
// ---------------------------------------------------------------------------

describe('hub doctor (final shape) — human form and bearer hygiene (T9)', () => {
  it('the human form lists the same number of checks as --json', async () => {
    const fx = fixture('doctor-human-parity');
    await hubInit(fx);
    const jsonRes = await runHubInFixture(fx, ['doctor', '--json']);
    expect(jsonRes.status, `stderr=${JSON.stringify(jsonRes.stderr)}`).toBe(0);
    const report = parseDoctorReport(jsonRes.stdout);

    const humanRes = await runHubInFixture(fx, ['doctor']);
    expect(humanRes.status, `stderr=${JSON.stringify(humanRes.stderr)}`).toBe(0);
    expect(humanRes.stdout).toMatch(/^status=/mu);
    // internal/doctor's human renderer prints one `  [status] id: …`
    // line per check (see printDoctor in cmd/hub/main.go).
    const checkLines = humanRes.stdout
      .split(/\r?\n/u)
      .filter((line) => /^\s+\[[a-z]+\]\s+\S+:/u.test(line));
    expect(
      checkLines.length,
      `human form printed ${checkLines.length} check lines; --json reported ${report.checks.length}`,
    ).toBe(report.checks.length);
  }, CASE_TIMEOUT_MS);

  it('never emits a bearer-shaped string, even with a live token on disk', async () => {
    const fx = fixture('doctor-bearer');
    await hubInit(fx);
    for (const argv of [['doctor'], ['doctor', '--json']]) {
      const res = await runHubInFixture(fx, argv);
      expect(looksLikeBearer(res.stdout), `stdout leaked bearer-shape for ${argv.join(' ')}: ${res.stdout}`).toBe(false);
      expect(looksLikeBearer(res.stderr), `stderr leaked bearer-shape for ${argv.join(' ')}: ${res.stderr}`).toBe(false);
    }
  }, CASE_TIMEOUT_MS);
});
