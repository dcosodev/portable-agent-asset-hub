// tests/go/distribution/update-dry-run-default.test.ts
//
// T9 RED real-subprocess contract for `hub update`. This is one of the
// three test files the T9 amendment names explicitly in `tests[]`.
//
// Contract source of truth — docs/roadmap/slices.json slice `T9`:
//
//   objective
//     "hub update (literal channel `stable` compiled-only; plan-only
//      dry-run by default; `hub update --apply` refuses with exit 2
//      pending a future separately governed apply transport)"
//
//   implementation_tasks[1]
//     "literal channel `stable` only, compiled binaries only (no source
//      / script / dev channels); plan-only dry-run is the default (no
//      network mutation, no download, no install); `hub update --apply`
//      refuses with exit code 2 with a message that says the apply
//      transport is out of scope and must be added by a future
//      separately governed slice"
//
//   audit_requirements[4..6]
//     non-stable channels are rejected with a clear error BEFORE any
//       network call
//     `hub update` defaults to plan-only dry-run and never auto-applies
//     `hub update --apply` refuses with exit code 2; no install mutation
//       occurs on refuse
//
//   forbidden_paths
//     internal/update/apply.go, and any install-mutating applier
//
// "No install mutation" is proven byte-for-byte: the test digests the
// built hub binary and the whole `$HUB_HOME` tree before and after each
// invocation and requires both snapshots to be identical.
//
// RED STATE at authoring time: `update` is not registered in
// cmd/hub/main.go, so every invocation exits 2 with
// `hub: unknown command "update"`. Note that the `--apply` refusal case
// ALSO expects exit 2 — `assertDispatched()` is what stops that from
// going accidentally GREEN against the missing verb.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertDispatched,
  buildDistributionBinary,
  freshInstallFixture,
  hubInit,
  looksLikeBearer,
  runHubInFixture,
  sha256File,
  snapshotTree,
  type DistributionRunResult,
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

/** Digest of the installed hub binary — the install-mutation witness. */
function binaryDigest(): { path: string; digest: string; size: number } {
  const { binary } = buildDistributionBinary();
  return { path: binary, digest: sha256File(binary), size: statSync(binary).size };
}

// ---------------------------------------------------------------------------
// 1. `hub update --help`.
// ---------------------------------------------------------------------------

describe('hub update — help surface (T9)', () => {
  it('`hub update --help` exits 0 and documents the plan-only default plus --apply', async () => {
    const fx = fixture('update-help');
    const res = await runUpdate(fx, ['update', '--help']);
    expect(
      res.status,
      `stdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
    ).toBe(0);
    expect(res.stdout).not.toBe('');
    expect(res.stderr).toBe('');
    // The amendment pins `--apply` as the (refused) flag and `stable`
    // as the only channel. Both must be discoverable from --help.
    expect(res.stdout).toMatch(/--apply\b/u);
    expect(res.stdout).toMatch(/\bstable\b/u);
  }, CASE_TIMEOUT_MS);

  it('`hub update --help` never emits a bearer-shaped string', async () => {
    const fx = fixture('update-help-bearer');
    const res = await runUpdate(fx, ['update', '--help']);
    expect(looksLikeBearer(res.stdout), `stdout leaked bearer-shape: ${res.stdout}`).toBe(false);
    expect(looksLikeBearer(res.stderr), `stderr leaked bearer-shape: ${res.stderr}`).toBe(false);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 2. Default invocation is a plan-only dry-run.
// ---------------------------------------------------------------------------

describe('hub update — plan-only dry-run is the default (T9)', () => {
  it('`hub update` exits 0, emits a plan on stdout, and mutates nothing', async () => {
    const fx = fixture('update-default');
    await hubInit(fx);
    const before = binaryDigest();
    const homeBefore = snapshotTree(fx.hubHome);

    const res = await runUpdate(fx, ['update']);
    assertDispatched(res, 'update');
    expect(
      res.status,
      `stdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
    ).toBe(0);
    // The default is described as a PLAN. The amendment does not pin the
    // plan's exact wording or schema, so the assertion is limited to
    // "something was reported on the contract stream" — no invented
    // fields, no invented keys.
    expect(res.stdout).not.toBe('');

    // No install mutation: the binary is byte-identical.
    const after = binaryDigest();
    expect(after.digest, 'hub update (default) mutated the installed binary').toBe(before.digest);
    expect(after.size).toBe(before.size);
    // No state mutation under $HUB_HOME either — a plan is read-only.
    expect(snapshotTree(fx.hubHome)).toEqual(homeBefore);
  }, CASE_TIMEOUT_MS);

  it('`hub update` never downloads a replacement binary into $HUB_HOME', async () => {
    const fx = fixture('update-no-download');
    await hubInit(fx);
    const res = await runUpdate(fx, ['update']);
    assertDispatched(res, 'update');
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    const tree = snapshotTree(fx.hubHome);
    const downloadLike = Object.keys(tree.files).filter(
      (rel) => /(^|[\\/])hub(\.new|\.download|\.tmp)?$/u.test(rel)
        || /\.(part|download|tmp-download)$/u.test(rel),
    );
    expect(
      downloadLike,
      `hub update wrote download-shaped artefacts into $HUB_HOME: ${JSON.stringify(downloadLike)}`,
    ).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it('`hub update --channel stable` (the literal pinned channel) is accepted and stays plan-only', async () => {
    const fx = fixture('update-stable');
    await hubInit(fx);
    const before = binaryDigest();
    const res = await runUpdate(fx, ['update', '--channel', 'stable']);
    assertDispatched(res, 'update');
    expect(
      res.status,
      `stdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
    ).toBe(0);
    expect(binaryDigest().digest, 'stable-channel plan mutated the installed binary').toBe(before.digest);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 3. Non-stable channels are refused.
// ---------------------------------------------------------------------------

describe('hub update — literal `stable` is the only channel (T9)', () => {
  const nonStable = [
    'beta',
    'dev',
    'nightly',
    'source',
    'script',
    'edge',
    'Stable',   // case-sensitivity: the amendment pins the LITERAL `stable`
    'stable-2', // near-miss must not be accepted by a prefix match
  ] as const;

  for (const channel of nonStable) {
    it(`\`hub update --channel ${channel}\` is refused non-zero with a diagnostic and mutates nothing`, async () => {
      const fx = fixture(`update-channel-${channel.replace(/[^a-z0-9]/giu, '')}`);
      await hubInit(fx);
      const before = binaryDigest();
      const homeBefore = snapshotTree(fx.hubHome);
      const res = await runUpdate(fx, ['update', '--channel', channel]);
      assertDispatched(res, 'update');
      // The amendment says "rejected with a clear error before any
      // network call" but does not pin 1 vs 2 for the channel refusal
      // (it pins exit 2 only for `--apply`). The assertion is therefore
      // "does not succeed" + "diagnostic on stderr" — no invented code.
      expect(
        res.status,
        `stdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
      ).not.toBe(0);
      expect(res.stderr).not.toBe('');
      expect(binaryDigest().digest, 'refused channel still mutated the binary').toBe(before.digest);
      expect(snapshotTree(fx.hubHome)).toEqual(homeBefore);
    }, CASE_TIMEOUT_MS);
  }

  it('`hub update --channel` with no value is refused', async () => {
    const fx = fixture('update-channel-no-value');
    await hubInit(fx);
    const res = await runUpdate(fx, ['update', '--channel']);
    assertDispatched(res, 'update');
    expect(res.status).not.toBe(0);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 4. `hub update --apply` refuses with exit 2 and mutates nothing.
//
// This is the single exit code the amendment pins numerically:
//   "`hub update --apply` refuses with exit code 2 and a message
//    declaring the apply transport out of scope; no install mutation
//    occurs on refuse"
// ---------------------------------------------------------------------------

describe('hub update --apply — refuses exit 2, no mutation (T9)', () => {
  it('exits exactly 2 with a diagnostic on stderr and no plan-success on stdout', async () => {
    const fx = fixture('update-apply');
    await hubInit(fx);
    const res = await runUpdate(fx, ['update', '--apply']);
    assertDispatched(res, 'update');
    expect(
      res.status,
      `stdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
    ).toBe(2);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);

  it('leaves the installed binary byte-identical (no install mutation on refuse)', async () => {
    const fx = fixture('update-apply-binary');
    await hubInit(fx);
    const before = binaryDigest();
    const res = await runUpdate(fx, ['update', '--apply']);
    assertDispatched(res, 'update');
    expect(res.status).toBe(2);
    const after = binaryDigest();
    expect(after.digest, '`hub update --apply` mutated the installed binary').toBe(before.digest);
    expect(after.size).toBe(before.size);
    // No sibling replacement binary next to the install either.
    const installDir = dirname(before.path);
    const siblings = existsSync(installDir) ? readdirSync(installDir).sort() : [];
    expect(siblings, `unexpected artefacts next to the install: ${JSON.stringify(siblings)}`).toEqual(['hub']);
  }, CASE_TIMEOUT_MS);

  it('leaves $HUB_HOME byte-identical (no staged install under state/)', async () => {
    const fx = fixture('update-apply-home');
    await hubInit(fx);
    const homeBefore = snapshotTree(fx.hubHome);
    const res = await runUpdate(fx, ['update', '--apply']);
    assertDispatched(res, 'update');
    expect(res.status).toBe(2);
    expect(snapshotTree(fx.hubHome)).toEqual(homeBefore);
  }, CASE_TIMEOUT_MS);

  it('`hub update --channel stable --apply` is still refused exit 2 (stable does not unlock apply)', async () => {
    const fx = fixture('update-apply-stable');
    await hubInit(fx);
    const before = binaryDigest();
    const res = await runUpdate(fx, ['update', '--channel', 'stable', '--apply']);
    assertDispatched(res, 'update');
    expect(
      res.status,
      `stdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
    ).toBe(2);
    expect(binaryDigest().digest).toBe(before.digest);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 5. Unknown verb / unknown flag under `update`.
// ---------------------------------------------------------------------------

describe('hub update — unknown verb and unknown flag are fail-closed (T9)', () => {
  it('`hub update install` (unknown positional verb) is refused non-zero', async () => {
    const fx = fixture('update-unknown-verb');
    const res = await runUpdate(fx, ['update', 'install']);
    assertDispatched(res, 'update');
    expect(res.status).not.toBe(0);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);

  it('`hub update --force` (flag outside the pinned surface) is refused non-zero', async () => {
    const fx = fixture('update-unknown-flag');
    const res = await runUpdate(fx, ['update', '--force']);
    assertDispatched(res, 'update');
    expect(res.status).not.toBe(0);
    expect(res.stderr).not.toBe('');
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Local runner: `hub update` must never reach the network in this slice,
// so every invocation is given an unroutable loopback endpoint alongside
// the standard fixture env. Keeping it in one helper means no test can
// accidentally run against a live endpoint.
// ---------------------------------------------------------------------------
async function runUpdate(
  fx: FreshInstallFixture,
  argv: readonly string[],
): Promise<DistributionRunResult> {
  return await runHubInFixture(fx, argv, {
    // Deliberately unroutable: port 1 on loopback. If the production
    // code ever performs a network call in the plan-only path, it fails
    // loudly here instead of silently reaching a real endpoint.
    AGENT_MEMORY_REST_URL: 'http://127.0.0.1:1',
    HUB_UPDATE_ENDPOINT: 'http://127.0.0.1:1',
  });
}
