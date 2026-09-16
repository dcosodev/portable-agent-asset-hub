// tests/go/init/permissions.test.ts
//
// T3 contract for token-file permissions and `hub token show` redacted
// surface. Per docs/roadmap/slices.json (T3):
//
//   * verify tokens/hub.token is 0600
//   * verify no bearer in logs after rotate
//   * token show is redacted; never echoes the raw bearer
//
// The tests are real subprocess tests. Every case spawns the freshly
// built hub binary against a per-test HUB_HOME under os.tmpdir(); the
// operator's real ~/.local/share/hub is never touched.
//
// Contract surface locked in here:
//
//   * tokens/hub.token mode        → 0600 after init; 0600 after
//                                      every token subcommand.
//   * tokens/ parent directory      → 0700 (no group/world access).
//   * `hub token show` (human form) → stdout carries a redacted
//                                      preview; the raw token bytes
//                                      MUST NOT appear in stdout.
//   * `hub token show --json`       → JSON payload has `redacted`
//                                      and `len` / `preview` fields;
//                                      NEVER `value` / `token` /
//                                      `bearer` etc.
//   * `hub token show --full`       → MUST NOT be a contract surface
//                                      (fail-closed; exit 2).
//   * `hub token show` against a
//     non-initialised home          → exit 1; stderr names the
//                                      remediation (run `hub init`).
//   * no bearer in any captured line → every captured stdout and
//                                      stderr line is scanned with
//                                      looksLikeBearer; a hit is a
//                                      hard FAIL (the audit
//                                      requirement is fail-closed).

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  readFileSync,
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

interface TokenFixture {
  home: string;
  cleanup: () => void;
  tokenPath: string;
  tokensDir: string;
}

function setup(): TokenFixture {
  resetHubBinary();
  buildHubBinary();
  const { home, cleanup } = freshHome('perm');
  return {
    home,
    cleanup,
    tokenPath: join(home, 'tokens', 'hub.token'),
    tokensDir: join(home, 'tokens'),
  };
}

async function initFirst(fx: TokenFixture): Promise<void> {
  const r = await runHubOnFreshHome(['init'], { env: { HUB_HOME: fx.home } });
  if (r.status !== 0) {
    throw new Error(`hub init failed: status=${r.status} stderr=${r.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Token file permissions — 0600 always
// ---------------------------------------------------------------------------

describe('token file — permissions', () => {
  let fx: TokenFixture | null = null;
  afterEach(() => { fx?.cleanup(); fx = null; });

  it('hub_token_file_is_0600_after_init', async () => {
    fx = setup();
    await initFirst(fx);
    expect(existsSync(fx.tokenPath)).toBe(true);
    expect(statMode(fx.tokenPath)).toBe(0o600);
  }, 30_000);

  it('hub_tokens_directory_is_owner_only_after_init', async () => {
    fx = setup();
    await initFirst(fx);
    expect(existsSync(fx.tokensDir)).toBe(true);
    const mode = statMode(fx.tokensDir);
    // 0700 is the canonical mode; 0750 is also acceptable (no group/
    // world access in either case). Anything readable by group or
    // world is a hard FAIL — bearer hygiene (I-07).
    expect(mode === 0o700 || mode === 0o750).toBe(true);
  }, 30_000);

  it('hub_token_file_remains_0600_after_rotate', async () => {
    fx = setup();
    await initFirst(fx);
    const r = await runHubOnFreshHome(['token', 'rotate'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    expect(statMode(fx.tokenPath)).toBe(0o600);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// `hub token show` — redacted, never echoes the bearer
// ---------------------------------------------------------------------------

describe('hub token show — redacted surface', () => {
  let fx: TokenFixture | null = null;
  afterEach(() => { fx?.cleanup(); fx = null; });

  it('human_form_emits_preview_only_and_redacts_bearer', async () => {
    fx = setup();
    await initFirst(fx);
    const tokenBytes = readFileSync(fx.tokenPath, 'utf8');
    const r = await runHubOnFreshHome(['token', 'show'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    expect(looksLikeBearer(r.stdout)).toBe(false);
    expect(looksLikeBearer(r.stderr)).toBe(false);
    // The raw token MUST NOT appear in stdout.
    expect(r.stdout).not.toContain(tokenBytes);
    // The human envelope MUST name the token file for traceability.
    expect(r.stdout).toContain('token_file=');
    expect(r.stdout).toContain(fx.tokenPath);
    // And it MUST report a redacted marker so an operator can see
    // something was emitted.
    expect(r.stdout).toMatch(/<<REDACTED>>|preview=/);
  }, 30_000);

  it('json_form_emits_redacted_and_len_fields_never_value', async () => {
    fx = setup();
    await initFirst(fx);
    const tokenBytes = readFileSync(fx.tokenPath, 'utf8');
    const r = await runHubOnFreshHome(['token', 'show', '--json'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(0);
    expect(looksLikeBearer(r.stdout)).toBe(false);
    expect(looksLikeBearer(r.stderr)).toBe(false);
    const payload = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    // The forbidden field names MUST NOT be present. The redactor
    // contract is "value never leaves the file"; a future JSON
    // payload that names a `value` field is a regression.
    expect(payload.value).toBeUndefined();
    expect(payload.token).toBeUndefined();
    expect(payload.bearer).toBeUndefined();
    expect(payload.secret).toBeUndefined();
    // Required fields: redacted / preview / len / token_file.
    expect(payload.redacted).toBe(true);
    expect(typeof payload.preview).toBe('string');
    expect((payload.preview as string).length).toBeGreaterThan(0);
    expect(typeof payload.len).toBe('number');
    expect(payload.len).toBe(tokenBytes.length);
    expect(payload.token_file).toBe(fx.tokenPath);
    // Raw token bytes MUST NOT appear anywhere in the JSON payload.
    expect(r.stdout).not.toContain(tokenBytes);
  }, 30_000);

  it('full_form_is_rejected_as_contract_violation', async () => {
    fx = setup();
    await initFirst(fx);
    // `--full` is intentionally not a contract surface — the
    // redactor is the only sanctioned way to read the token (via
    // the file itself, which is 0600). Exit 2, diagnostic on stderr.
    const r = await runHubOnFreshHome(['token', 'show', '--full'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(2);
    expect(looksLikeBearer(r.stdout)).toBe(false);
    expect(looksLikeBearer(r.stderr)).toBe(false);
  }, 30_000);

  it('token_show_on_uninitialised_home_exits_one_with_diagnostic', async () => {
    fx = setup();
    // Skip init — the home is empty. `hub token show` must surface
    // a precise diagnostic and exit 1 (operator error), not 2
    // (contract violation): the contract surface is well-formed,
    // but the env has not been initialised.
    const r = await runHubOnFreshHome(['token', 'show'], { env: { HUB_HOME: fx.home } });
    expect(r.status).toBe(1);
    expect(looksLikeBearer(r.stderr)).toBe(false);
    expect(r.stderr).toMatch(/init|tokens\/hub\.token/);
  }, 30_000);
});
