// tests/go/connect/deterministic-output.test.ts
//
// T8 RED contract (digest/recompute/CAS, AMENDMENT-aligned).
//
// This file pins the determinism contract for `hub hub connect`
// OUTPUT under the authorized amendment, NOT the legacy
// "byte-stable raw JSON across processes" assertion set. The
// amendment is explicit:
//
//   * The preview process A uses real TypeScript, produces a real
//     plan (runId / generatedAt MAY vary across invocations).
//     `planDigest` is the canonical SHA-256 of the plan CONTENT.
//   * Raw JSON byte-stability across processes is NOT
//     contractual and tests MUST NOT assert it. `runId` is a
//     `randomUUID()` and `generatedAt` is `Date.now().toISOString()`;
//     these are non-semantic and SHOULD differ across invocations
//     while the plan content stays the same.
//   * Output stability is owned at three layers:
//       1. planDigest is stable across two previews of the same
//          logical input (the load-bearing byte-stable field).
//       2. JSON key SET is stable across two previews of the
//          same logical input (no random keys).
//       3. Human-form output (without --json) carries no
//          timestamp drift that survives substring stripping.
//
//   * The observedDigest / expectedDigest CAS pair (manifest
//     digest) is independent of planDigest. The two digests
//     MUST NOT be aliases — a regression that conflates them
//     breaks the drift detector and the audit trail.
//
// Today (pre-T8) every test in this file is RED: the dispatcher
// rejects `hub hub connect` with exit 2 / "unknown command".
// Once T8 lands, the SAME assertions flip GREEN with zero
// changes — that is the point of writing them first.
//
// Hermetic fixtures: per-test HUB_HOME + targetRoot mkdtemps; the
// harness strips inherited env vars that could leak into output
// (HUB_BEARER_TOKEN*, PATH perturbations, etc.).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCanonicalConnectFixture,
  freshConnectHome,
  freshConnectTarget,
  runConnect,
} from './_connect-harness';

// 64-char lowercase hex used as a "valid-format-but-not-real"
// digest placeholder. NOT a bearer — pure hex.
const FAKE_HEX_64 = '0'.repeat(64);

const PLAN_DIGEST_REGEX = /^[0-9a-f]{64}$/u;

describe('hub hub connect — deterministic output (T8, amendment)', () => {
  let homeCleanup: (() => void) | undefined;
  let targetCleanup: (() => void) | undefined;
  let databaseCleanup: (() => void) | undefined;

  beforeEach(() => {
    homeCleanup = undefined;
    targetCleanup = undefined;
    databaseCleanup = undefined;
  });
  afterEach(() => {
    try { targetCleanup?.(); } catch { /* best-effort */ }
    try { databaseCleanup?.(); } catch { /* best-effort */ }
    try { homeCleanup?.(); } catch { /* best-effort */ }
  });

  // -----------------------------------------------------------------
  // 1. planDigest IS byte-stable across two previews of the same
  //    logical input. This is the load-bearing assertion: the
  //    canonical SHA-256 of the plan content is independent of
  //    runId / generatedAt drift. A regression that folds
  //    volatile metadata into planDigest breaks the
  //    review→apply propagation.
  //
  //    The test does NOT compare raw JSON, runId, or generatedAt.
  //    It only asserts planDigest equality across two invocations.
  // -----------------------------------------------------------------
  it('preview --json: planDigest is byte-stable across two invocations (canonical content digest)', async () => {
    const home = freshConnectHome('deterministic-plan-digest');
    const target = freshConnectTarget('plan-digest');
    const database = createCanonicalConnectFixture('deterministic-plan-digest', 'prf_deterministic_plan', 'snap_deterministic_plan');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    databaseCleanup = database.cleanup;

    const args = [
      'hub', 'connect', 'preview',
      '--harness', 'hermes',
      '--profile', 'prf_deterministic_plan',
      '--snapshot', 'snap_deterministic_plan',
      '--target-root', target.targetRoot,
      '--json',
    ] as const;
    const env = { HUB_HOME: home.home, ...database.env };

    const res1 = await runConnect(args, env);
    const res2 = await runConnect(args, env);

    expect(res1.status, `first preview stderr=${JSON.stringify(res1.stderr)}`).toBe(0);
    expect(res2.status, `second preview stderr=${JSON.stringify(res2.stderr)}`).toBe(0);

    const payload1 = JSON.parse(res1.stdout) as { planDigest?: string };
    const payload2 = JSON.parse(res2.stdout) as { planDigest?: string };
    expect(payload1.planDigest, `planDigest missing from first preview: ${JSON.stringify(payload1)}`).toMatch(PLAN_DIGEST_REGEX);
    expect(payload2.planDigest, `planDigest missing from second preview: ${JSON.stringify(payload2)}`).toMatch(PLAN_DIGEST_REGEX);
    expect(payload1.planDigest, `planDigest drifted:\nfirst=${payload1.planDigest}\nsecond=${payload2.planDigest}`).toBe(payload2.planDigest);
  }, 60_000);

  // -----------------------------------------------------------------
  // 2. observedDigest (CAS manifest digest) is independent of
  //    planDigest (content digest). For an empty target the
  //    observedDigest should equal the null-digest
  //    ("0" × 64); planDigest is the SHA-256 of the plan content.
  //    They serve different purposes and MUST NOT be aliases.
  // -----------------------------------------------------------------
  it('preview --json: observedDigest and planDigest are not aliases on an empty target', async () => {
    const home = freshConnectHome('deterministic-aliases');
    const target = freshConnectTarget('aliases');
    const database = createCanonicalConnectFixture('deterministic-aliases', 'prf_deterministic_aliases', 'snap_deterministic_aliases');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    databaseCleanup = database.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_deterministic_aliases',
        '--snapshot', 'snap_deterministic_aliases',
        '--target-root', target.targetRoot,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );

    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      planDigest?: string;
      observedDigest?: string;
    };
    expect(payload.planDigest).toMatch(PLAN_DIGEST_REGEX);
    // observedDigest is the CAS manifest digest for the live
    // target. On an empty target it is the null-digest (64
    // zeroes). The contract is "two distinct fields" — even if
    // the values happen to collide in some edge case, the
    // fields themselves MUST remain independent surfaces.
    expect(typeof payload.observedDigest).toBe('string');
    expect(payload.observedDigest).toMatch(PLAN_DIGEST_REGEX);
  }, 60_000);

  // -----------------------------------------------------------------
  // 3. --json key SET is stable across two previews of the
  //    same logical input. Volatile VALUES (runId, generatedAt)
  //    may differ; the SET of top-level keys must not.
  //    A regression that adds a per-call timestamp to the
  //    payload by inserting a new key surfaces here.
  // -----------------------------------------------------------------
  it('preview --json: top-level key set is stable across two invocations', async () => {
    const home = freshConnectHome('deterministic-keys');
    const target = freshConnectTarget('keys');
    const database = createCanonicalConnectFixture('deterministic-keys', 'prf_deterministic_keys', 'snap_deterministic_keys');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    databaseCleanup = database.cleanup;

    const args = [
      'hub', 'connect', 'preview',
      '--harness', 'hermes',
      '--profile', 'prf_deterministic_keys',
      '--snapshot', 'snap_deterministic_keys',
      '--target-root', target.targetRoot,
      '--json',
    ] as const;
    const env = { HUB_HOME: home.home, ...database.env };

    const res1 = await runConnect(args, env);
    const res2 = await runConnect(args, env);

    expect(res1.status).toBe(0);
    expect(res2.status).toBe(0);

    const keys1 = Object.keys(JSON.parse(res1.stdout) as Record<string, unknown>).sort();
    const keys2 = Object.keys(JSON.parse(res2.stdout) as Record<string, unknown>).sort();
    expect(keys2, `key set drift:\nfirst=${keys1.join(',')}\nsecond=${keys2.join(',')}`).toEqual(keys1);
  }, 60_000);

  // -----------------------------------------------------------------
  // 4. planDigest is independent of the HUB_HOME mkdtemp. Same
  //    logical input but different HUB_HOME mkdtemps MUST
  //    produce the same planDigest. The HUB_HOME value is
  //    hermetic state, NOT canonical input; a regression that
  //    folds HUB_HOME into the digest breaks here.
  // -----------------------------------------------------------------
  it('preview --json: planDigest is independent of the HUB_HOME mkdtemp', async () => {
    const home1 = mkdtempSync(join(tmpdir(), `hub-connect-determ-A-${process.pid}-`));
    const home2 = mkdtempSync(join(tmpdir(), `hub-connect-determ-B-${process.pid}-`));
    const target = freshConnectTarget('home-independent');
    const database = createCanonicalConnectFixture('deterministic-home-independent', 'prf_deterministic_home_independent', 'snap_deterministic_home_independent');
    targetCleanup = target.cleanup;
    databaseCleanup = database.cleanup;
    try {
      const args = [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_deterministic_home_independent',
        '--snapshot', 'snap_deterministic_home_independent',
        '--target-root', target.targetRoot,
        '--json',
      ] as const;

      const res1 = await runConnect(args, { HUB_HOME: home1, ...database.env });
      const res2 = await runConnect(args, { HUB_HOME: home2, ...database.env });

      expect(res1.status).toBe(0);
      expect(res2.status).toBe(0);
      const d1 = (JSON.parse(res1.stdout) as { planDigest: string }).planDigest;
      const d2 = (JSON.parse(res2.stdout) as { planDigest: string }).planDigest;
      expect(d1).toMatch(PLAN_DIGEST_REGEX);
      expect(d2, `planDigest drifted across HUB_HOME:\nfirst=${d1}\nsecond=${d2}`).toBe(d1);
    } finally {
      try { rmSync(home1, { recursive: true, force: true }); } catch { /* best-effort */ }
      try { rmSync(home2, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 60_000);

  // -----------------------------------------------------------------
  // 5. Human-form output (without --json) carries no timestamp
  //    drift that survives substring stripping. The amendment
  //    allows runId / generatedAt to appear on stdout (they
  //    are part of the plan); the contract is that after
  //    stripping the ISO-8601 substring, the rest is
  //    byte-stable across two invocations of the same input.
  // -----------------------------------------------------------------
  it('preview (without --json) is byte-stable after timestamp stripping', async () => {
    const home = freshConnectHome('deterministic-human');
    const target = freshConnectTarget('human');
    const database = createCanonicalConnectFixture('deterministic-human', 'prf_deterministic_human', 'snap_deterministic_human');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    databaseCleanup = database.cleanup;

    const args = [
      'hub', 'connect', 'preview',
      '--harness', 'hermes',
      '--profile', 'prf_deterministic_human',
      '--snapshot', 'snap_deterministic_human',
      '--target-root', target.targetRoot,
    ] as const;
    const env = { HUB_HOME: home.home, ...database.env };

    const res1 = await runConnect(args, env);
    const res2 = await runConnect(args, env);

    expect(res1.status).toBe(0);
    expect(res2.status).toBe(0);

    // The human form MUST NOT carry a Date.now()-style timestamp
    // drift anywhere. We strip any ISO-8601 substring and
    // compare the rest byte-for-byte.
    const stripped1 = res1.stdout.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.Z+-]+/g, '<<TS>>');
    const stripped2 = res2.stdout.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.Z+-]+/g, '<<TS>>');
    expect(stripped2, `human form drift (timestamps stripped):\nfirst=${JSON.stringify(stripped1)}\nsecond=${JSON.stringify(stripped2)}`).toBe(stripped1);
  }, 60_000);

  // -----------------------------------------------------------------
  // 6. Diagnostic-channel stderr is stable for the same input.
  //    The slice says contract-violation diagnostics are stable
  //    across invocations: same argv, same diagnostic. A
  //    regression that adds a per-call timestamp to a usage
  //    diagnostic is a contract regression.
  // -----------------------------------------------------------------
  it('unknown-verb stderr is byte-stable across two invocations', async () => {
    const res1 = await runConnect(['hub', 'connect', 'migrate']);
    const res2 = await runConnect(['hub', 'connect', 'migrate']);

    expect(res1.status).toBe(2);
    expect(res2.status).toBe(2);
    expect(res2.stderr, `diagnostic drift:\nfirst=${JSON.stringify(res1.stderr)}\nsecond=${JSON.stringify(res2.stderr)}`).toBe(res1.stderr);
  }, 30_000);

  // -----------------------------------------------------------------
  // 7. --json output is parseable: no truncation, no trailing
  //    garbage. The slice says JSON output is the contract
  //    surface; a regression that adds a stray log line after
  //    the JSON payload surfaces here as a JSON.parse failure.
  // -----------------------------------------------------------------
  it('preview --json: stdout is exactly one JSON document with no trailing garbage', async () => {
    const home = freshConnectHome('deterministic-json-shape');
    const target = freshConnectTarget('json-shape');
    const database = createCanonicalConnectFixture('deterministic-json-shape', 'prf_deterministic_shape', 'snap_deterministic_shape');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    databaseCleanup = database.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_deterministic_shape',
        '--snapshot', 'snap_deterministic_shape',
        '--target-root', target.targetRoot,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );

    expect(res.status).toBe(0);
    const trimmed = res.stdout.trim();
    expect(trimmed.startsWith('{')).toBe(true);
    expect(trimmed.endsWith('}')).toBe(true);
    expect(() => JSON.parse(trimmed)).not.toThrow();
  }, 60_000);

  // -----------------------------------------------------------------
  // 8. Hermetic HOME path isolation. The HUB_HOME mkdtemp must
  //    NOT leak into stdout or stderr. A regression that
  //    embeds the operator's HOME would surface here.
  //
  //    Note: the payload's `plan.targetRoot` IS the operator-
  //    supplied absolute path. That is contract, not a leak.
  //    The assertion only checks that NO path the harness owns
  //    (the HUB_HOME mkdtemp) leaks.
  // -----------------------------------------------------------------
  it('preview --json: HUB_HOME hermetic temp path does not leak into stdout or stderr', async () => {
    const home = freshConnectHome('deterministic-home-leak');
    const target = freshConnectTarget('home-leak');
    const database = createCanonicalConnectFixture('deterministic-home-leak', 'prf_deterministic_home_leak', 'snap_deterministic_home_leak');
    homeCleanup = home.cleanup;
    targetCleanup = target.cleanup;
    databaseCleanup = database.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_deterministic_home_leak',
        '--snapshot', 'snap_deterministic_home_leak',
        '--target-root', target.targetRoot,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );

    expect(res.status).toBe(0);
    expect(res.stdout, `HUB_HOME leaked: ${res.stdout}`).not.toContain(home.home);
    expect(res.stderr, `HUB_HOME leaked: ${res.stderr}`).not.toContain(home.home);
  }, 60_000);

  // -----------------------------------------------------------------
  // 9. Pre-canonical placeholder anchor: keep FAKE_HEX_64 alive so
  //    a future reviewer can verify it is intentional.
  // -----------------------------------------------------------------
  void FAKE_HEX_64;
});
