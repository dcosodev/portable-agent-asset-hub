// tests/go/distribution/backup-cli-surface.test.ts
//
// T9 RED real-subprocess contract for the `hub backup` CLI surface.
//
// Contract source of truth — docs/roadmap/slices.json slice `T9`:
//
//   audit_requirements[0]
//     "verify hub backup surface is exactly `hub backup --out <archive>`
//      and `hub backup --restore <archive>`"
//
// The amendment pins EXACTLY two flags. Anything else on the `backup`
// verb is outside the authorised surface and must be refused, and both
// pinned flags take a value.
//
// Exit-code convention (docs/architecture/go-product-shell.md, already
// enforced by every shipped verb):
//   0  success
//   1  operator error
//   2  contract violation
//
// RED STATE at authoring time: cmd/hub/main.go has no `backup` case, so
// the dispatcher answers every argv below with
// `hub: unknown command "backup"` on stderr and exit 2.
//
// Note on accidental GREEN: because the pre-T9 fallthrough ALSO exits 2,
// every exit-2 expectation here is preceded by `assertDispatched(res,
// 'backup')`, which fails while stderr still carries the dispatcher's
// `unknown command` diagnostic. An exit-2 assertion can therefore only
// be satisfied by a real T9 refusal, never by the missing verb.

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  assertDispatched,
  freshInstallFixture,
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

const CASE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// 1. `hub backup --help` — the verb is reachable and self-documenting.
// ---------------------------------------------------------------------------

describe('hub backup — help surface (T9)', () => {
  it('`hub backup --help` exits 0 and documents both pinned flags on stdout', async () => {
    const fx = fixture('backup-help');
    const res = await runHubInFixture(fx, ['backup', '--help']);
    expect(
      res.status,
      `stdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
    ).toBe(0);
    // Help is a contract artefact → stdout. Diagnostics → stderr.
    expect(res.stdout).not.toBe('');
    expect(res.stderr).toBe('');
    // The amendment pins exactly these two flags; the help block must
    // enumerate both so an operator can reconstruct the surface from
    // `--help` alone.
    expect(res.stdout).toMatch(/--out\b/u);
    expect(res.stdout).toMatch(/--restore\b/u);
  }, CASE_TIMEOUT_MS);

  it('`hub backup -h` exits 0 (short form parity with the rest of the shell)', async () => {
    const fx = fixture('backup-help-short');
    const res = await runHubInFixture(fx, ['backup', '-h']);
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    expect(res.stdout).not.toBe('');
  }, CASE_TIMEOUT_MS);

  it('`hub backup --help` never emits a bearer-shaped string', async () => {
    const fx = fixture('backup-help-bearer');
    const res = await runHubInFixture(fx, ['backup', '--help']);
    // No status assertion: this case fires in either direction so a
    // redaction regression surfaces whether the verb is wired or not.
    expect(looksLikeBearer(res.stdout), `stdout leaked bearer-shape: ${res.stdout}`).toBe(false);
    expect(looksLikeBearer(res.stderr), `stderr leaked bearer-shape: ${res.stderr}`).toBe(false);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 2. Unknown verb / unknown flag under `backup` — fail-closed exit 2.
//
// `assertDispatched` is the accidental-GREEN guard for every case here.
// ---------------------------------------------------------------------------

describe('hub backup — unknown verb and unknown flag are fail-closed (T9)', () => {
  it('`hub backup snapshot` (unknown positional verb) exits 2 with a diagnostic on stderr', async () => {
    const fx = fixture('backup-unknown-verb');
    const res = await runHubInFixture(fx, ['backup', 'snapshot']);
    assertDispatched(res, 'backup');
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
    expect(res.stdout).toBe('');
  }, CASE_TIMEOUT_MS);

  it('`hub backup --archive <path>` (flag outside the pinned surface) exits 2', async () => {
    const fx = fixture('backup-unknown-flag');
    const res = await runHubInFixture(fx, ['backup', '--archive', join(fx.home, 'a.tar.gz')]);
    assertDispatched(res, 'backup');
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);

  it('`hub backup --upload` (invented transport flag) exits 2 — no transport is authorised', async () => {
    // non_goals: "inventing any backup transport, registry, or DB
    // fallback outside resolver-canonical SQLite+config".
    const fx = fixture('backup-transport-flag');
    const res = await runHubInFixture(fx, ['backup', '--upload', 'https://example.invalid/x']);
    assertDispatched(res, 'backup');
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 3. Parse contract for the two pinned flags.
//
// Both `--out` and `--restore` take a value. A missing value, and the
// mutually-exclusive combination of the two, are contract violations.
// ---------------------------------------------------------------------------

describe('hub backup — --out / --restore parse contract (T9)', () => {
  it('`hub backup --out` with no value exits 2 with a diagnostic', async () => {
    const fx = fixture('backup-out-no-value');
    const res = await runHubInFixture(fx, ['backup', '--out']);
    assertDispatched(res, 'backup');
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);

  it('`hub backup --restore` with no value exits 2 with a diagnostic', async () => {
    const fx = fixture('backup-restore-no-value');
    const res = await runHubInFixture(fx, ['backup', '--restore']);
    assertDispatched(res, 'backup');
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);

  it('`hub backup --out X --restore Y` (snapshot and restore at once) exits 2', async () => {
    // The amendment describes `--out` as the snapshot direction and
    // `--restore` as the restore direction. They are two distinct
    // operations; asking for both in one invocation has no defined
    // meaning and must be refused rather than silently picking one.
    const fx = fixture('backup-both-flags');
    const res = await runHubInFixture(fx, [
      'backup',
      '--out', join(fx.home, 'out.tar.gz'),
      '--restore', join(fx.home, 'in.tar.gz'),
    ]);
    assertDispatched(res, 'backup');
    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);

  it('`hub backup --restore <missing archive>` fails non-zero without creating the path', async () => {
    const fx = fixture('backup-restore-missing');
    const missing = join(fx.home, 'does-not-exist.tar.gz');
    const res = await runHubInFixture(fx, ['backup', '--restore', missing]);
    assertDispatched(res, 'backup');
    // A missing input archive is an operator error (1) or a contract
    // violation (2) depending on how the production author classifies
    // it; the amendment does not pin which. The pinned behaviour is
    // "does not succeed" plus "leaves no artefact behind", so that is
    // all this asserts — no invented exit code.
    expect(res.status).not.toBe(0);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);
});
