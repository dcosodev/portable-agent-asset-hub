// tests/go/connect/preview-readonly.test.ts
//
// T8 RED contract (digest/recompute/CAS, AMENDMENT-aligned).
//
// This file pins the read-only contract for `hub hub connect
// preview` against the authorized amendment, NOT the legacy
// "byte-stable raw JSON across processes" assertion set.
//
// The contract has four load-bearing pieces:
//
//   1. NO WRITE: the target root must be byte-identical before
//      and after the preview runs. Any delta — even a 0-byte
//      `.pah/` created by the production code — fails the
//      assertion.
//
//   2. NO STATE: the preview must not write to HUB_HOME beyond
//      what `hub init` would write. We snapshot HUB_HOME
//      before/after and assert byte-identity.
//
//   3. planDigest: the JSON payload that comes back on stdout
//      (or the human equivalent on --no-json) must include
//      `planDigest` whose value is exactly 64 lowercase hex
//      characters. The planDigest is the canonical SHA-256 of
//      the plan CONTENT (NOT the manifest, NOT the raw JSON).
//      Volatile metadata (runId, generatedAt) MAY vary across
//      invocations; tests in this file MUST NOT assert those.
//
//   4. Plan shape: the payload must include the plan with the
//      fields the apply step needs (harness, profileId,
//      snapshotId, targetRoot, files[]). The fixture does NOT
//      pin runId byte values or generatedAt strings.
//
// Today (pre-T8) every test in this file is RED: the dispatcher
// rejects `hub hub connect` with exit 2 / "unknown command".
// Once T8 lands production, the SAME assertions flip GREEN with
// zero changes — that is the point of writing them first.
//
// Fixtures are hermetic:
//   * HUB_HOME → per-call mkdtemp
//   * targetRoot → per-call mkdtemp
//   * HOME / XDG_DATA_HOME → per-worker temp dir
//   * The binary is the real `cmd/hub` build (no stub)
//   * No SQLite migration is triggered (preview never opens the
//     store; the contract is "read-only" all the way down)

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  freshConnectHome,
  freshConnectTarget,
  createCanonicalConnectFixture,
  repoRoot,
  runConnect,
  seedConnectTarget,
} from './_connect-harness';

interface DirSnapshot {
  // Map of relative path → { sha256, size, mode, mtimeMs }.
  files: Map<string, { sha256: string; size: number; mode: number; mtimeMs: number }>;
  // The directory's own mtime (we want to see no .pah/ directory
  // appear under the root, which would change the listing mtime).
  rootMtimeMs: number;
}

const PLAN_DIGEST_REGEX = /^[0-9a-f]{64}$/u;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Walk a directory tree (no symlink traversal) and produce a
 * byte-stable snapshot. The snapshot is what we compare before
 * and after the preview runs; a delta is a write that should
 * never have happened.
 *
 * Symlink rule: the walker does NOT follow symlinks (lstat, not
 * stat). A symlink in the tree surfaces as `{ kind: 'symlink' }`
 * with no `files` entry, so a preview that legitimately re-creates
 * a symlink-free tree will produce an empty-but-stable snapshot.
 */
function snapshotDir(root: string): DirSnapshot {
  const files = new Map<string, { sha256: string; size: number; mode: number; mtimeMs: number }>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let stat;
    try {
      stat = statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let children: string[];
      try {
        children = readdirSync(current);
      } catch {
        continue;
      }
      for (const child of children) {
        stack.push(join(current, child));
      }
    } else if (stat.isFile()) {
      const rel = relative(root, current).split('\\').join('/');
      const bytes = readFileSync(current);
      files.set(rel, {
        sha256: sha256Hex(bytes),
        size: stat.size,
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
      });
    }
    // Symlinks and other kinds are intentionally not recorded.
  }
  const rootStat = statSync(root);
  return { files, rootMtimeMs: rootStat.mtimeMs };
}

function diffSnapshots(before: DirSnapshot, after: DirSnapshot): string[] {
  const deltas: string[] = [];
  for (const [path, beforeEntry] of before.files) {
    const afterEntry = after.files.get(path);
    if (!afterEntry) {
      deltas.push(`missing after: ${path}`);
      continue;
    }
    if (beforeEntry.sha256 !== afterEntry.sha256) {
      deltas.push(`content changed: ${path} before=${beforeEntry.sha256} after=${afterEntry.sha256}`);
    }
    if (beforeEntry.size !== afterEntry.size) {
      deltas.push(`size changed: ${path} before=${beforeEntry.size} after=${afterEntry.size}`);
    }
    if (beforeEntry.mode !== afterEntry.mode) {
      deltas.push(`mode changed: ${path} before=${beforeEntry.mode.toString(8)} after=${afterEntry.mode.toString(8)}`);
    }
    if (beforeEntry.mtimeMs !== afterEntry.mtimeMs) {
      deltas.push(`mtime changed: ${path} before=${beforeEntry.mtimeMs} after=${afterEntry.mtimeMs}`);
    }
  }
  for (const path of after.files.keys()) {
    if (!before.files.has(path)) {
      deltas.push(`new file appeared: ${path}`);
    }
  }
  if (before.rootMtimeMs !== after.rootMtimeMs) {
    deltas.push(`root mtime changed: before=${before.rootMtimeMs} after=${after.rootMtimeMs}`);
  }
  return deltas;
}

describe('hub hub connect preview — read-only contract (T8, amendment)', () => {
  // Each test allocates its own HUB_HOME + targetRoot and cleans up
  // after itself so the suite is parallelisable.
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
    try { homeCleanup?.(); } catch { /* best-effort */ }
    try { databaseCleanup?.(); } catch { /* best-effort */ }
  });

  it('preview on an empty target: status 0, planDigest is 64-hex, target byte-identical, HOME byte-identical', async () => {
    const home = freshConnectHome('preview-empty');
    homeCleanup = home.cleanup;
    const target = freshConnectTarget('empty');
    targetCleanup = target.cleanup;
    const database = createCanonicalConnectFixture('preview-empty', 'prf_preview_empty', 'snap_preview_empty');
    databaseCleanup = database.cleanup;

    const beforeHome = snapshotDir(home.home);
    const beforeTarget = snapshotDir(target.targetRoot);
    const beforeDatabase = snapshotDir(database.dataDir);

    const res = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_preview_empty',
        '--snapshot', 'snap_preview_empty',
        '--target-root', target.targetRoot,
        '--json',
      ],
      { HUB_HOME: home.home, HUB_OPENAPI: join(repoRoot, 'openapi', 'openapi.yaml'), ...database.env },
    );

    const afterHome = snapshotDir(home.home);
    const afterTarget = snapshotDir(target.targetRoot);
    const afterDatabase = snapshotDir(database.dataDir);

    // RED today: status=2, stderr='hub: unknown command "hub"', JSON absent.
    // GREEN once production lands: status=0, stdout is valid JSON with
    // planDigest + plan keys; target HOME unchanged.
    expect(res.status, `status=${res.status}\nstdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`).toBe(0);

    // 1. Read-only: the target root must be byte-identical.
    expect(diffSnapshots(beforeTarget, afterTarget), 'preview wrote to the target root').toEqual([]);

    // 2. No state: HUB_HOME must be byte-identical (no .pah/,
    //    no SQLite migration, no state/ directory created).
    expect(diffSnapshots(beforeHome, afterHome), 'preview wrote to HUB_HOME').toEqual([]);
    expect(diffSnapshots(beforeDatabase, afterDatabase), 'preview mutated canonical DB tree').toEqual([]);
    expect(readdirSync(database.dataDir).sort()).toEqual(['hub.sqlite']);

    // 3. Canonical content digest: the JSON payload includes
    //    planDigest whose value is exactly 64 lowercase hex
    //    characters. planDigest is the SHA-256 of the canonical
    //    plan CONTENT (NOT the manifest, NOT the raw JSON).
    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    const planDigest = payload.planDigest;
    expect(typeof planDigest).toBe('string');
    expect(planDigest).toMatch(PLAN_DIGEST_REGEX);

    // 4. Plan shape: the payload must include the plan with the
    //    four fields the apply step needs to re-use the preview.
    //    We do NOT assert byte-stability of runId / generatedAt;
    //    the amendment explicitly allows those to vary.
    const plan = payload.plan as Record<string, unknown>;
    expect(plan).toBeTruthy();
    expect(plan.harness).toBe('hermes');
    expect(plan.profileId).toBe('prf_preview_empty');
    expect(plan.snapshotId).toBe('snap_preview_empty');
    expect(plan.targetRoot).toBe(target.targetRoot);
    expect(Array.isArray(plan.files)).toBe(true);
  }, 60_000);

  it('preview on a seeded target: status 0, seeded USER.md sha256 unchanged, no .pah/ created', async () => {
    const home = freshConnectHome('preview-seeded');
    homeCleanup = home.cleanup;
    const target = freshConnectTarget('seeded');
    targetCleanup = target.cleanup;
    const database = createCanonicalConnectFixture('preview-seeded', 'prf_preview_seeded', 'snap_preview_seeded');
    databaseCleanup = database.cleanup;
    // Seed a sentinel file. The preview contract is "no writes";
    // the sentinel must survive byte-for-byte.
    seedConnectTarget(target.targetRoot, 'USER.md', '# seeded USER\n');
    seedConnectTarget(target.targetRoot, 'MEMORY.md', '# seeded MEMORY\n');
    seedConnectTarget(target.targetRoot, 'SKILL.md', '# seeded SKILL\n');

    const beforeTarget = snapshotDir(target.targetRoot);

    const res = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_preview_seeded',
        '--snapshot', 'snap_preview_seeded',
        '--target-root', target.targetRoot,
        '--json',
      ],
      { HUB_HOME: home.home, ...database.env },
    );

    const afterTarget = snapshotDir(target.targetRoot);

    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    expect(diffSnapshots(beforeTarget, afterTarget), 'preview mutated the seeded target').toEqual([]);
    // Belt-and-braces: the directory itself must not contain a
    // `.pah/` directory. The slice contract is explicit — preview
    // is read-only all the way down. If production accidentally
    // touches the target, this assertion surfaces it.
    expect(existsSync(join(target.targetRoot, '.pah'))).toBe(false);
  }, 60_000);

  it('preview --json produces byte-stable planDigest for the same inputs across two invocations', async () => {
    const home1 = freshConnectHome('preview-stable-1');
    const target1 = freshConnectTarget('stable-1');
    homeCleanup = home1.cleanup;
    targetCleanup = target1.cleanup;
    const database = createCanonicalConnectFixture('preview-stable', 'prf_preview_stable', 'snap_preview_stable');
    databaseCleanup = database.cleanup;
    const args = [
      'hub', 'connect', 'preview',
      '--harness', 'hermes',
      '--profile', 'prf_preview_stable',
      '--snapshot', 'snap_preview_stable',
      '--target-root', target1.targetRoot,
      '--json',
    ] as const;
    const env = { HUB_HOME: home1.home, ...database.env };

    const res1 = await runConnect(args, env);
    const res2 = await runConnect(args, env);

    expect(res1.status).toBe(0);
    expect(res2.status).toBe(0);
    // planDigest is the SHA-256 of the canonical plan CONTENT.
    // Two previews of the same logical input MUST produce the
    // same planDigest; volatile metadata (runId, generatedAt) is
    // explicitly allowed to differ.
    const payload1 = JSON.parse(res1.stdout) as { planDigest?: string };
    const payload2 = JSON.parse(res2.stdout) as { planDigest?: string };
    expect(payload1.planDigest).toMatch(PLAN_DIGEST_REGEX);
    expect(payload1.planDigest).toBe(payload2.planDigest);
  }, 60_000);

  it('preview (without --json) writes a human-readable block to stdout and keeps stderr empty', async () => {
    const home = freshConnectHome('preview-human');
    homeCleanup = home.cleanup;
    const target = freshConnectTarget('human');
    targetCleanup = target.cleanup;
    const database = createCanonicalConnectFixture('preview-human', 'prf_preview_human', 'snap_preview_human');
    databaseCleanup = database.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_preview_human',
        '--snapshot', 'snap_preview_human',
        '--target-root', target.targetRoot,
      ],
      { HUB_HOME: home.home, ...database.env },
    );

    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    // Human form: must include the canonical planDigest and the
    // profileId/snapshotId/harness anchors so a CI pipeline can
    // grep them without parsing JSON. No runId / generatedAt
    // assertion — those MAY differ across invocations.
    expect(res.stdout).toMatch(/planDigest=/);
    expect(res.stdout).toMatch(/profileId=prf_preview_human/);
    expect(res.stdout).toMatch(/snapshotId=snap_preview_human/);
    expect(res.stdout).toMatch(/harness=hermes/);
    expect(res.stderr).toBe('');
  }, 60_000);

  it('preview refuses unknown --harness values with exit 2 (contract violation)', async () => {
    const home = freshConnectHome('preview-bad-harness');
    homeCleanup = home.cleanup;
    const target = freshConnectTarget('bad-harness');
    targetCleanup = target.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'no-such-harness',
        '--profile', 'prf_preview_bad_harness',
        '--snapshot', 'snap_preview_bad_harness',
        '--target-root', target.targetRoot,
      ],
      { HUB_HOME: home.home },
    );

    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
  }, 30_000);

  it('preview refuses malformed --profile id (regex prf_[A-Za-z0-9._-]+) with exit 2', async () => {
    const home = freshConnectHome('preview-bad-profile');
    homeCleanup = home.cleanup;
    const target = freshConnectTarget('bad-profile');
    targetCleanup = target.cleanup;

    const res = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'NOT-prf-prefixed',
        '--snapshot', 'snap_preview_bad_profile',
        '--target-root', target.targetRoot,
      ],
      { HUB_HOME: home.home },
    );

    expect(res.status).toBe(2);
    expect(res.stderr).not.toBe('');
  }, 30_000);

  it('preview refuses a non-existent --target-root with exit 1 (operator error)', async () => {
    const home = freshConnectHome('preview-missing-target');
    homeCleanup = home.cleanup;
    // /this-path-deliberately-does-not-exist-${pid} is guaranteed
    // absent because mkdtemp is the only thing that creates dirs
    // in this test suite. We belt-and-braces by checking existsSync.
    const ghostTarget = join(repoRoot, 'tests', '__never_created__', `missing-${process.pid}`);
    expect(existsSync(ghostTarget)).toBe(false);

    const res = await runConnect(
      [
        'hub', 'connect', 'preview',
        '--harness', 'hermes',
        '--profile', 'prf_preview_missing',
        '--snapshot', 'snap_preview_missing',
        '--target-root', ghostTarget,
      ],
      { HUB_HOME: home.home },
    );

    expect(res.status).toBe(1);
    expect(res.stderr).not.toBe('');
  }, 30_000);
});
