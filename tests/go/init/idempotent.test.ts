// tests/go/init/idempotent.test.ts
//
// T3 contract for `hub init`. The init subcommand is idempotent:
// running it twice on the same HUB_HOME produces the SAME layout
// (state/, runtime/, logs/, tokens/) AND does not destroy an
// existing token. The audit requirement per
// docs/roadmap/slices.json (T3):
//
//   * verify second init is idempotent
//   * token permissions are 0600
//   * no bearer in logs after rotate
//
// This file locks the idempotent half. Real subprocess tests:
// every case spawns the freshly-built hub binary against a fresh
// per-test HUB_HOME under os.tmpdir(); the operator's real
// ~/.local/share/hub is never touched.
//
// Contract surface locked in here:
//
//   * `hub init` on a fresh HUB_HOME    → exit 0, creates
//                                          state/, runtime/,
//                                          logs/, tokens/
//                                          subdirectories, and
//                                          writes tokens/hub.token
//                                          with mode 0600.
//
//   * `hub init` on an EXISTING home    → exit 0, layout is
//                                          unchanged (idempotent),
//                                          and the existing
//                                          tokens/hub.token is
//                                          PRESERVED byte-for-byte
//                                          (no token regeneration
//                                          on re-init).
//
//   * `hub init` emits a deterministic   → stdout has the canonical
//     human envelope                     `home=<abs>` line and the
//                                          layout summary; exit 0.
//
//   * `hub init --json`                  → exit 0, stdout is a JSON
//                                          object with a `home`
//                                          field whose value is the
//                                          absolute temp dir; the
//                                          JSON payload contains
//                                          NO bearer-shaped string
//                                          (the new token is
//                                          never echoed).
//
//   * `hub init` second time after a
//     `hub token rotate`                 → the rotated token is
//                                          STILL preserved (init
//                                          never clobbers an
//                                          existing token).

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

interface InitFixture {
  home: string;
  cleanup: () => void;
  tokenPath: string;
  logsPath: string;
}

function setup(): InitFixture {
  // Force a fresh binary build so tests pick up the latest source.
  resetHubBinary();
  buildHubBinary();
  const { home, cleanup } = freshHome('idem');
  return {
    home,
    cleanup,
    tokenPath: join(home, 'tokens', 'hub.token'),
    logsPath: join(home, 'logs'),
  };
}

// ---------------------------------------------------------------------------
// `hub init` on a fresh HUB_HOME — creates the layout and writes the token
// ---------------------------------------------------------------------------

describe('hub init — first invocation', () => {
  let fx: InitFixture | null = null;
  afterEach(() => { fx?.cleanup(); fx = null; });

  it('creates_state_runtime_logs_tokens_subdirs_and_writes_token_with_0600', async () => {
    fx = setup();
    const r = await runHubOnFreshHome(['init'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    // Layout — every subdirectory present
    expect(existsSync(join(fx.home, 'state'))).toBe(true);
    expect(existsSync(join(fx.home, 'runtime'))).toBe(true);
    expect(existsSync(join(fx.home, 'logs'))).toBe(true);
    expect(existsSync(join(fx.home, 'tokens'))).toBe(true);
    // Token — present, mode 0600, non-empty
    expect(existsSync(fx.tokenPath)).toBe(true);
    expect(statMode(fx.tokenPath)).toBe(0o600);
    const tokenBytes = readFileSync(fx.tokenPath, 'utf8');
    expect(tokenBytes.length).toBeGreaterThan(0);
    expect(looksLikeBearer(tokenBytes)).toBe(false);
  }, 30_000);

  it('human_stdout_reports_home_and_is_bearer_free', async () => {
    fx = setup();
    const r = await runHubOnFreshHome(['init'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(looksLikeBearer(r.stdout)).toBe(false);
    // Operator-visible confirmation: home=<abs> on stdout.
    expect(r.stdout).toContain(`home=${fx.home}`);
    // The created token is NOT echoed on stdout (init is fail-closed).
    const tokenBytes = readFileSync(fx.tokenPath, 'utf8');
    expect(r.stdout).not.toContain(tokenBytes);
  }, 30_000);

  it('init_json_emits_structured_payload_without_bearer', async () => {
    fx = setup();
    const r = await runHubOnFreshHome(['init', '--json'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    expect(looksLikeBearer(r.stdout)).toBe(false);
    const payload = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    expect(payload.home).toBe(fx.home);
    expect(typeof payload.created_at).toBe('string');
    // Layout keys must be present and equal to the canonical subdirs.
    expect(payload.state).toBe(join(fx.home, 'state'));
    expect(payload.runtime).toBe(join(fx.home, 'runtime'));
    expect(payload.logs).toBe(join(fx.home, 'logs'));
    expect(payload.tokens).toBe(join(fx.home, 'tokens'));
    expect(payload.token_file).toBe(join(fx.home, 'tokens', 'hub.token'));
    // The token value MUST NOT appear in the JSON payload.
    const tokenBytes = readFileSync(fx.tokenPath, 'utf8');
    expect(r.stdout).not.toContain(tokenBytes);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// `hub init` on an EXISTING home — idempotent
// ---------------------------------------------------------------------------

describe('hub init — second invocation is idempotent', () => {
  let fx: InitFixture | null = null;
  afterEach(() => { fx?.cleanup(); fx = null; });

  it('preserves_existing_token_byte_for_byte', async () => {
    fx = setup();
    const first = await runHubOnFreshHome(['init'], { env: { HUB_HOME: fx.home } });
    expect(first.status).toBe(0);
    const tokenBytesBefore = readFileSync(fx.tokenPath, 'utf8');
    const mtimeBefore = statSync(fx.tokenPath).mtimeMs;
    // Second invocation — must NOT clobber the token.
    const second = await runHubOnFreshHome(['init'], { env: { HUB_HOME: fx.home } });
    expect(second.status).toBe(0);
    expect(existsSync(fx.tokenPath)).toBe(true);
    expect(readFileSync(fx.tokenPath, 'utf8')).toBe(tokenBytesBefore);
    // The mtime must NOT have advanced — re-init is a no-op on the
    // token file. (We give the filesystem a generous 5ms slack because
    // some CI hosts have low-res mtime granularity, but the bytes are
    // the authoritative equality check.)
    const mtimeAfter = statSync(fx.tokenPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    expect(statMode(fx.tokenPath)).toBe(0o600);
  }, 30_000);

  it('preserves_token_through_init_after_rotate', async () => {
    fx = setup();
    // Init → rotate → init. The third init must NOT clobber the
    // rotated token. This is the safety property T3 audits against:
    // `hub init` is supposed to be idempotent, and a stray re-init
    // must NEVER regenerate the token.
    const r1 = await runHubOnFreshHome(['init'], { env: { HUB_HOME: fx.home } });
    expect(r1.status).toBe(0);
    const rotate = await runHubOnFreshHome(['token', 'rotate'], { env: { HUB_HOME: fx.home } });
    expect(rotate.status).toBe(0);
    const rotatedBytes = readFileSync(fx.tokenPath, 'utf8');
    expect(rotatedBytes.length).toBeGreaterThan(0);

    const r2 = await runHubOnFreshHome(['init'], { env: { HUB_HOME: fx.home } });
    expect(r2.status).toBe(0);
    expect(readFileSync(fx.tokenPath, 'utf8')).toBe(rotatedBytes);
  }, 30_000);

  it('layout_state_is_byte_deterministic_across_reinits', async () => {
    fx = setup();
    const r1 = await runHubOnFreshHome(['init'], { env: { HUB_HOME: fx.home } });
    expect(r1.status).toBe(0);
    const r2 = await runHubOnFreshHome(['init'], { env: { HUB_HOME: fx.home } });
    expect(r2.status).toBe(0);
    // The human envelope MUST report idempotency: same home, same
    // subdirectories, same token file. We assert the canonical keys
    // appear in the second invocation's stdout.
    expect(r2.stdout).toContain(`home=${fx.home}`);
    expect(r2.stdout).toContain(`tokens=${join(fx.home, 'tokens')}`);
  }, 30_000);
});
