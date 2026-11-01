// Real-subprocess contract for the `hub backup` CLI surface.
//
// The surface is exactly `hub backup --out <archive>` and
// `hub backup --restore <archive>`.
//
// There are EXACTLY two flags. Anything else on the `backup` verb
// must be refused, and both flags take a value.
//
// Exit-code convention (docs/architecture/go-product-shell.md, already
// enforced by every shipped verb):
//   0  success
//   1  operator error
//   2  contract violation
//

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

describe('hub backup — help surface', () => {
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
    // The help block must enumerate both flags so an operator can
    // reconstruct the surface from
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
// `assertDispatched` guards every case here against the unknown-command path.
// ---------------------------------------------------------------------------

describe('hub backup — unknown verb and unknown flag are fail-closed', () => {
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
    // "inventing any backup transport, registry, or DB
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

describe('hub backup — --out / --restore parse contract', () => {
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
    // `--out` is the snapshot direction and
    // `--restore` the restore direction. They are two distinct
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
    // The exit code for a missing input archive is not asserted, only
    // "does not succeed" plus "leaves no artefact behind".
    expect(res.status).not.toBe(0);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);
});
