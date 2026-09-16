// tests/go/init/rotate.test.ts
//
// T3 contract for `hub token rotate`. Per docs/roadmap/slices.json
// (T3) — "verify no bearer in logs after rotate" and the exit
// criteria "rotate produces a working REST session".
//
// The tests are real subprocess tests. Every case spawns the
// freshly built hub binary against a per-test HUB_HOME under
// os.tmpdir(); the operator's real ~/.local/share/hub is never
// touched.
//
// Contract surface locked in here:
//
//   * `hub token rotate`              → exit 0; tokens/hub.token
//                                       is REPLACED with a fresh
//                                       bearer; the file mode is
//                                       STILL 0600; the old bytes
//                                       do NOT survive.
//   * captured stdout/stderr          → NO bearer-shaped string in
//                                       any line (audit requirement).
//   * `hub token rotate --json`       → JSON payload includes the
//                                       rotated-at timestamp, the
//                                       new len, and the token_file
//                                       absolute path; NEVER the
//                                       raw bearer.
//   * `hub token rotate` is idempotent in the sense that two
//     consecutive rotations produce
//     two distinct tokens (each rotation
//     is a fresh regeneration; rotate
//     never no-ops).
//   * `hub token rotate` against a
//     non-initialised home             → exit 1, stderr names the
//                                       remediation, no token is
//                                       written, captured output is
//                                       bearer-free.
//   * `hub token rotate` on a token
//     that was written 0600           → the post-rotate file mode
//                                       is STILL 0600 (no umask
//                                       drift).

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  buildHubBinary,
  freshHome,
  looksLikeBearer,
  resetHubBinary,
  runHubOnFreshHome,
  statMode,
} from './_init-harness';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

interface RotateFixture {
  home: string;
  cleanup: () => void;
  tokenPath: string;
}

function setup(): RotateFixture {
  resetHubBinary();
  buildHubBinary();
  const { home, cleanup } = freshHome('rotate');
  return {
    home,
    cleanup,
    tokenPath: join(home, 'tokens', 'hub.token'),
  };
}

async function initFirst(fx: RotateFixture): Promise<string> {
  const r = await runHubOnFreshHome(['init'], { env: { HUB_HOME: fx.home } });
  if (r.status !== 0) {
    throw new Error(`hub init failed: status=${r.status} stderr=${r.stderr}`);
  }
  return readFileSync(fx.tokenPath, 'utf8');
}

// ---------------------------------------------------------------------------
// Rotate regenerates the token — never a no-op
// ---------------------------------------------------------------------------

describe('hub token rotate — regenerates the bearer', () => {
  let fx: RotateFixture | null = null;
  afterEach(() => { fx?.cleanup(); fx = null; });

  it('produces_a_new_token_byte_for_byte', async () => {
    fx = setup();
    const before = await initFirst(fx);
    const r = await runHubOnFreshHome(['token', 'rotate'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    expect(existsSync(fx.tokenPath)).toBe(true);
    const after = readFileSync(fx.tokenPath, 'utf8');
    expect(after.length).toBeGreaterThan(0);
    // The new token MUST differ from the old one.
    expect(after).not.toBe(before);
  }, 30_000);

  it('preserves_0600_mode_after_rotation', async () => {
    fx = setup();
    await initFirst(fx);
    const r = await runHubOnFreshHome(['token', 'rotate'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    expect(statMode(fx.tokenPath)).toBe(0o600);
  }, 30_000);

  it('mtime_advances_after_rotation', async () => {
    fx = setup();
    await initFirst(fx);
    const mtimeBefore = statSync(fx.tokenPath).mtimeMs;
    // Sleep a generous 5ms so the mtime comparison is robust on
    // hosts with low-resolution mtime granularity. The contract
    // surface (the bytes) is the authoritative equality check;
    // this is a defence-in-depth assertion.
    await new Promise((res) => setTimeout(res, 50));
    const r = await runHubOnFreshHome(['token', 'rotate'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    const mtimeAfter = statSync(fx.tokenPath).mtimeMs;
    expect(mtimeAfter).toBeGreaterThan(mtimeBefore);
  }, 30_000);

  it('two_consecutive_rotations_produce_two_distinct_tokens', async () => {
    fx = setup();
    await initFirst(fx);
    const r1 = await runHubOnFreshHome(['token', 'rotate'], { env: { HUB_HOME: fx.home } });
    expect(r1.status).toBe(0);
    const a = readFileSync(fx.tokenPath, 'utf8');
    const r2 = await runHubOnFreshHome(['token', 'rotate'], { env: { HUB_HOME: fx.home } });
    expect(r2.status).toBe(0);
    const b = readFileSync(fx.tokenPath, 'utf8');
    expect(a).not.toBe(b);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Audit requirement: NO bearer in captured stdout/stderr after rotate
// ---------------------------------------------------------------------------

describe('hub token rotate — bearer hygiene (no leakage)', () => {
  let fx: RotateFixture | null = null;
  afterEach(() => { fx?.cleanup(); fx = null; });

  it('human_form_captures_no_bearer_in_stdout_or_stderr', async () => {
    fx = setup();
    const before = await initFirst(fx);
    const r = await runHubOnFreshHome(['token', 'rotate'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    expect(looksLikeBearer(r.stdout)).toBe(false);
    expect(looksLikeBearer(r.stderr)).toBe(false);
    // The old token MUST NOT appear in any captured line — a leak
    // of the previous bearer would be a regression.
    expect(r.stdout).not.toContain(before);
    expect(r.stderr).not.toContain(before);
    // The human envelope MUST name the token file so the operator
    // knows where the rotated bearer now lives.
    expect(r.stdout).toContain('token_file=');
    expect(r.stdout).toContain(fx.tokenPath);
  }, 30_000);

  it('json_form_carries_no_bearer_in_payload', async () => {
    fx = setup();
    await initFirst(fx);
    const r = await runHubOnFreshHome(['token', 'rotate', '--json'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    expect(looksLikeBearer(r.stdout)).toBe(false);
    expect(looksLikeBearer(r.stderr)).toBe(false);
    const payload = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    // Forbidden fields: NEVER the raw bearer under any key.
    expect(payload.value).toBeUndefined();
    expect(payload.token).toBeUndefined();
    expect(payload.bearer).toBeUndefined();
    expect(payload.secret).toBeUndefined();
    // Required fields.
    expect(payload.token_file).toBe(fx.tokenPath);
    expect(typeof payload.rotated_at).toBe('string');
    expect(typeof payload.len).toBe('number');
    expect(payload.mode).toBe('0600');
  }, 30_000);

  it('rotate_on_uninitialised_home_exits_one_with_diagnostic_no_token_written', async () => {
    fx = setup();
    // No init — the home is empty.
    const r = await runHubOnFreshHome(['token', 'rotate'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(1);
    expect(looksLikeBearer(r.stderr)).toBe(false);
    expect(looksLikeBearer(r.stdout)).toBe(false);
    expect(r.stderr).toMatch(/init|tokens\/hub\.token/);
    // No token must have been written.
    expect(existsSync(fx.tokenPath)).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Safe restart semantics — the rotate subcommand must never crash
// on a partially initialised home (e.g. when tokens/ exists but
// hub.token is missing) — T3's safety contract is "rotate must
// produce a working token, always".
// ---------------------------------------------------------------------------

describe('hub token rotate — safe restart semantics', () => {
  let fx: RotateFixture | null = null;
  afterEach(() => { fx?.cleanup(); fx = null; });

  it('recovers_when_tokens_dir_exists_but_hub_token_is_missing', async () => {
    fx = setup();
    // Init then delete the token file (simulates a partial init or
    // an operator who rotated manually). The rotate command must
    // re-create hub.token with a fresh bearer.
    await initFirst(fx);
    const fs = await import('node:fs');
    fs.rmSync(fx.tokenPath, { force: true });
    const r = await runHubOnFreshHome(['token', 'rotate'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    expect(existsSync(fx.tokenPath)).toBe(true);
    expect(statMode(fx.tokenPath)).toBe(0o600);
    const bytes = readFileSync(fx.tokenPath, 'utf8');
    expect(bytes.length).toBeGreaterThan(0);
    expect(looksLikeBearer(bytes)).toBe(false);
  }, 30_000);
});
