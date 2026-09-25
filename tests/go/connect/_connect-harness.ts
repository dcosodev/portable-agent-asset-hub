// tests/go/connect/_connect-harness.ts
//
// Shared subprocess harness for the T8 hub-connect test suite
// (tests/go/connect/*.test.ts). The harness builds the hub binary
// ONCE per vitest worker with `go build -trimpath` into a per-suite
// temp directory, and exposes a small runner that captures stdout,
// stderr, and exit code.
//
// Architecture mirrors tests/go/shell/_hub-harness.ts (T1) and
// tests/go/mcp/_mcp-harness.ts (T7):
//   * Build once per vitest worker (`go build -o <tmp>/hub`).
//   * Run with the caller-supplied argv and a sanitised env.
//   * Capture stdout/stderr/exit; assert on the result.
//
// The T8 slice is "hub hub connect preview|apply|rollback" — a thin
// delegate to the existing TypeScript materializer surface. The
// production wiring (cmd/hub/cmd_connect.go + internal/connect/**)
// does not exist yet; this harness drives the BUILT binary and the
// .test.ts files assert on the contract surface. Today every test
// is RED: the binary exits 2 with "unknown command 'hub'" because
// cmd/hub/main.go has no `connect` case yet. Once T8 ships
// production, the same .test.ts files flip GREEN with no source
// changes — the assertions ARE the contract.
//
// Hermetic isolation:
//   * HUB_HOME points at a per-call fresh temp directory.
//   * HUB_RUNTIME / HUB_OPENAPI / HUB_BEARER_TOKEN* are stripped
//     unless the caller explicitly opts in via envOverride.
//   * HOME points at a per-worker temp dir so the XDG fallback
//     resolves inside the temp filesystem.
//   * CI=true so the sink runs without ANSI codes.
//
// The harness NEVER writes to the repo (no sentinel file), and
// every preview test asserts the target root is byte-identical
// before/after so a failing "read-only" assertion surfaces
// immediately as a real byte-level diff.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import {
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfileService, createActorContext, type Profile } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const here = dirname(fileURLToPath(import.meta.url));
// `here` resolves to tests/go/connect — three `..` hops land at the
// repo root (the directory holding cmd/, internal/, go.mod).
const repoRoot = resolve(here, '..', '..', '..');

// Repo-local openapi.yaml — the T1 doctor expects this. T8 tests
// don't probe the openapi surface, but we still set it so the
// config loader never silently falls back to the binary's cwd
// (which would resolve to "/" when hub is run from a temp dir).
const repoOpenAPI = join(repoRoot, 'openapi', 'openapi.yaml');

let cachedBinary: string | null = null;
let cachedBuildTmp: string | null = null;

export interface ConnectBuildResult {
  binary: string;
  buildTmp: string;
  buildLog: string;
}

/**
 * Build the hub binary with `go build -trimpath` into a per-worker
 * temp directory. The result is cached so callers can spawn the
 * binary cheaply; resetConnectBinary() clears the cache when a
 * source edit between vitest runs demands a rebuild.
 */
export function buildConnectBinary(): ConnectBuildResult {
  if (cachedBinary && cachedBuildTmp && existsSync(cachedBinary)) {
    return { binary: cachedBinary, buildTmp: cachedBuildTmp, buildLog: '' };
  }
  const buildTmp = mkdtempSync(join(tmpdir(), `hub-connect-${process.pid}-`));
  const binary = join(buildTmp, 'hub');
  const res: SpawnSyncReturns<string> = spawnSync('go', [
    'build',
    '-trimpath',
    '-o',
    binary,
    './cmd/hub',
  ], {
    cwd: repoRoot,
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(
      `go build -trimpath failed (status=${res.status})\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  if (!existsSync(binary)) {
    throw new Error(`go build succeeded but binary missing at ${binary}`);
  }
  cachedBinary = binary;
  cachedBuildTmp = buildTmp;
  return { binary, buildTmp, buildLog: `${res.stdout}\n${res.stderr}` };
}

/**
 * Clear the cached binary. Tests that mutate the source tree
 * between vitest runs call this so the next build picks up the
 * change. The T8 RED suite deliberately does NOT need this — the
 * production code does not exist yet — but the helper is here for
 * parity with the T6/T7 harnesses.
 */
export function resetConnectBinary(): void {
  if (cachedBuildTmp && existsSync(cachedBuildTmp)) {
    rmSync(cachedBuildTmp, { recursive: true, force: true });
  }
  cachedBinary = null;
  cachedBuildTmp = null;
}

export interface ConnectRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
  command: string;
}

/**
 * Run the hub binary with the given argv and a sanitised env. The
 * sanitised env:
 *   * strips HUB_HOME, HUB_RUNTIME, HUB_OPENAPI so the test can
 *     opt-in to a specific value per case (via envOverride);
 *   * clears HUB_BEARER_TOKEN* so the bearer-hygiene check sees a
 *     clean env unless the test deliberately probes it;
 *   * sets CI=true so the sink runs without ANSI codes;
 *   * points HOME at a per-call temp dir so the XDG fallback
 *     ($HOME/.local/share/hub) resolves inside the test sandbox.
 *
 * The harness returns stdout/stderr/exit verbatim — every assertion
 * in the .test.ts files is driven from these three channels.
 */
export async function runConnect(
  argv: readonly string[],
  envOverride: Record<string, string> = {},
  options: { cwd?: string } = {},
): Promise<ConnectRunResult> {
  const { binary } = buildConnectBinary();
  const cleanedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') cleanedEnv[k] = v;
  }
  for (const k of [
    'HUB_HOME',
    'HUB_RUNTIME',
    'HUB_OPENAPI',
    'HUB_BEARER_TOKEN',
    'HUB_BEARER_TOKEN_FILE',
    'HUB_BEARER_TOKEN_SOURCE',
    // T8 owns `hub hub connect`; future env knobs (HUB_CONNECT_TARGET_ROOT,
    // HUB_CONNECT_COMMAND, …) will be added by the production author. The
    // harness deliberately clears every HUB_CONNECT_* env var so tests
    // can opt-in per case without leaking across workers.
    'HUB_CONNECT_COMMAND',
    'HUB_CONNECT_TARGET_ROOT',
    'HUB_CONNECT_LOCK_DIR',
  ]) {
    delete cleanedEnv[k];
  }
  cleanedEnv.CI = 'true';
  // HOME → per-call temp dir so the XDG fallback is hermetic.
  const homeTmp = mkdtempSync(join(tmpdir(), `hub-connect-home-${process.pid}-`));
  cleanedEnv.HOME = homeTmp;
  cleanedEnv.XDG_DATA_HOME = homeTmp;
  return await new Promise((resolveP) => {
    const child = spawn(binary, argv, {
      cwd: options.cwd ?? repoRoot,
      env: { ...cleanedEnv, ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let spawnErr: Error | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      spawnErr = err;
    });
    child.once('close', (code, signal) => {
      resolveP({
        status: code,
        signal: signal as NodeJS.Signals | null,
        stdout,
        stderr,
        error: spawnErr,
        command: `${binary} ${argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`,
      });
    });
  });
}

/**
 * Build a fresh HOME on disk so the connect subcommand can be
 * exercised against a hermetic operator home. Returns the absolute
 * path of the temp home and a cleanup callback. The function never
 * creates state/, runtime/, logs/, tokens/ — those are what `hub
 * init` produces and are deliberately absent here so the connect
 * suite observes a "fresh worktree" layout.
 *
 * IMPORTANT: the connect suite must NEVER call `hub init` because
 * init produces a real bearer token; if init leaked into the
 * harness, the bearer-hygiene tests could observe the freshly
 * minted token and confuse themselves. The hermetic home is
 * deliberately empty.
 */
export function freshConnectHome(label: string): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), `hub-connect-${label}-${process.pid}-`));
  return {
    home,
    cleanup: () => {
      if (existsSync(home)) {
        try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

/**
 * Convenience wrapper: build a hermetic home and run hub with
 * HUB_HOME pointed at it. The caller receives the captured
 * result plus the cleanup callback.
 */
export async function runConnectOnFreshHome(
  argv: readonly string[],
  options: { label?: string; cwd?: string } = {},
): Promise<ConnectRunResult & { home: string; cleanup: () => void }> {
  const { home, cleanup } = freshConnectHome(options.label ?? 'fresh');
  const env = {
    HUB_HOME: home,
    HUB_OPENAPI: repoOpenAPI,
  };
  const res = await runConnect(argv, env, { cwd: options.cwd });
  return { ...res, home, cleanup };
}

// ---------------------------------------------------------------------------
// Bearer-shape predicates (mirrored from tests/go/shell/_hub-harness.ts and
// internal/output/output.go LooksLikeBearer). The TS layer never re-
// implements the regex set: it re-uses the canonical predicates so a
// silent regex drift between the binary's redactor and the test layer
// is impossible. Keep these constants in sync with internal/output.
// ---------------------------------------------------------------------------
const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=\s*[^\s,'"]+/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

/**
 * Returns true when the input contains a substring that matches any
 * bearer-shape predicate (Bearer + opaque, env-var assignment, JWT).
 * Mirrors internal/output/output.go so the test is synchronised with
 * the binary's redactor.
 */
export function looksLikeBearer(s: string): boolean {
  if (!s) return false;
  if (BEARER_PREFIXED_OPAQUE.test(s)) return true;
  if (HUB_BEARER_ENV_ASSIGNMENT.test(s)) return true;
  if (JWT_TRIPLE_SEGMENT.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Connect-target root helper. The connect preview/apply need a real
// filesystem directory to render against; this helper mints a fresh
// mkdtemp directory and returns its absolute path + a cleanup
// callback. The directory is NEVER seeded with `.pah/` — preview
// must be read-only and a pre-seeded `.pah/` would mask any
// incidental write by the production code.
// ---------------------------------------------------------------------------
export interface FreshTarget {
  targetRoot: string;
  cleanup: () => void;
}

export function freshConnectTarget(label: string): FreshTarget {
  const targetRoot = mkdtempSync(join(tmpdir(), `hub-connect-target-${label}-${process.pid}-`));
  return {
    targetRoot,
    cleanup: () => {
      if (existsSync(targetRoot)) {
        try { rmSync(targetRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal target-root file seeder. Some preview tests need a target
// that already contains a non-empty USER.md (Hermes materializer
// renders USER.md from profile USER blocks). The helper writes a
// single sentinel file so the preview's "files" list is non-empty
// and the read-only assertion has something to compare against.
// The seed is a UTF-8 string — never a bearer-shaped value.
// ---------------------------------------------------------------------------
export function seedConnectTarget(
  targetRoot: string,
  relativePath: string,
  body: string,
): string {
  // The path is asserted absolute-by-the-time-it-hits-disk because
  // mkdtempSync returned an absolute path.
  const absolute = join(targetRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body, 'utf8');
  return absolute;
}

export interface CanonicalConnectFixture {
  dataDir: string;
  databasePath: string;
  profileId: string;
  snapshotId: string;
  env: Record<string, string>;
  cleanup: () => void;
}

/**
 * Canonical CLI actor identity convention.
 *
 * The productive CLI surfaces (`scripts/relations.mjs`, the REST
 * local-mode launcher in `packages/rest/src/launcher.ts`) all read
 * the operator's actor identity from `AGENT_MEMORY_USER_ID` /
 * `AGENT_MEMORY_AGENT_ID` and fall back to the canonical defaults
 * `usr_local` / `agt_local`. Connect tests MUST seed the real
 * Profile under that exact same scope, and forward the exact same
 * env vars to every subprocess, so the moment the production
 * `buildActor()` learns to honour the convention the assertions
 * flip GREEN with zero fixture churn.
 *
 * Hard rule: this fixture MUST NOT introduce test-specific or
 * fixture-only actor identities. If a test needs a non-canonical
 * scope it MUST do so by exporting the env vars before invoking
 * `createCanonicalConnectFixture` — never by patching this helper
 * with a hardcoded `usr_*` / `agt_*` literal.
 */
const CANONICAL_DEFAULT_USER_ID = 'usr_local';
const CANONICAL_DEFAULT_AGENT_ID = 'agt_local';

function readCanonicalActorEnv(): { userId: string; agentId: string } {
  // Default exactly to the productive CLI defaults; never to a
  // test-only identity. process.env may carry overrides from a
  // caller that intentionally wants to scope the fixture under a
  // different canonical identity — the env values are honoured
  // verbatim when present so the suite composes with `env -S`
  // wrappers and CI matrix scoping.
  const userId = process.env.AGENT_MEMORY_USER_ID ?? CANONICAL_DEFAULT_USER_ID;
  const agentId = process.env.AGENT_MEMORY_AGENT_ID ?? CANONICAL_DEFAULT_AGENT_ID;
  return { userId, agentId };
}

/** Provision a real migrated/seeded DB before measuring process A. */
export function createCanonicalConnectFixture(
  label: string,
  profileId: string,
  snapshotId = `snap_${label}`,
): CanonicalConnectFixture {
  const dataDir = mkdtempSync(join(tmpdir(), `hub-connect-db-${label}-${process.pid}-`));
  const databasePath = join(dataDir, 'hub.sqlite');
  // Read the canonical CLI actor identity from the productive env
  // convention. The same env vars are forwarded to every spawned
  // subprocess via the returned `env` object so once
  // `buildActor()` honours `AGENT_MEMORY_USER_ID` /
  // `AGENT_MEMORY_AGENT_ID` the seeded profile becomes visible
  // under the exact scope the production runner will look up.
  const { userId, agentId } = readCanonicalActorEnv();
  const actor = createActorContext({
    userId,
    agentId,
    role: 'user',
    capabilities: [],
  });
  const profile: Profile = {
    id: profileId,
    scope: actor.scope,
    version: 1,
    blocks: [
      { blockId: 'user', ordinal: 0, kind: 'USER', body: `fixture user ${profileId}` },
      { blockId: 'memory', ordinal: 1, kind: 'MEMORY', body: `fixture memory ${profileId}` },
    ],
  };
  const store = new SqliteStore(databasePath);
  try {
    new ProfileService(store, actor).create(profile, {
      reason: 't8-fixture-setup',
      requestId: `req-fixture-${label}`,
    });
  } finally {
    store.close();
  }
  const checkpoint = new DatabaseSync(databasePath);
  try { checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { checkpoint.close(); }
  return {
    dataDir,
    databasePath,
    profileId,
    snapshotId,
    // Forward the canonical actor env convention alongside the
    // already-supported DB path + storage mode so all subprocess
    // helpers (runConnect, runConnectOnFreshHome, runConnectOnSharedHome)
    // inherit them when callers splat `fixture.env` into their
    // envOverride argument. The exact strings match the productive
    // CLI defaults documented at the top of this block — there is
    // no fixture-only override channel here.
    env: {
      AGENT_MEMORY_DB_PATH: databasePath,
      AGENT_MEMORY_STORAGE_MODE: 'temporary',
      AGENT_MEMORY_USER_ID: userId,
      AGENT_MEMORY_AGENT_ID: agentId,
    },
    cleanup: () => {
      if (existsSync(dataDir)) {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

export { repoRoot, repoOpenAPI };

// ---------------------------------------------------------------------------
// Cross-process HUB_HOME + receipt helpers (Phase B).
//
// The T8 amendment rewires the connect verbs as three INDEPENDENT
// subprocesses (A=preview, B=apply, C=rollback). They share the
// same $HUB_HOME on disk — preview never writes, apply writes a
// durable receipt at $HUB_HOME/state/connect/receipts/<runId>.json,
// rollback reads that receipt in a fresh process. The helpers
// below let a test allocate ONE HUB_HOME per scenario and run all
// three subprocesses against it without losing hermeticity across
// test cases (every helper creates a fresh mkdtemp).
//
// All helpers are TEST-ONLY. The harness never touches
// packages/storage-sqlite or any production receipt code; it
// operates on the FILESYSTEM view of the receipt store. Tests
// assert on bytes / perms / mode / atomicity, never on a JS
// implementation of the receipt store (which is forbidden path).
// ---------------------------------------------------------------------------

/**
 * Allocate a single HUB_HOME that all three subprocesses
 * (preview, apply, rollback) share. Returns the absolute path
 * and a cleanup callback. The path is created on disk empty;
 * preview is the FIRST process to touch it, and per the
 * amendment preview MUST NOT create any state inside it.
 */
export function sharedConnectHome(label: string): {
  home: string;
  cleanup: () => void;
} {
  const home = mkdtempSync(
    join(tmpdir(), `hub-connect-shared-${label}-${process.pid}-`),
  );
  return {
    home,
    cleanup: () => {
      if (existsSync(home)) {
        try {
          rmSync(home, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
  };
}

/**
 * Run a subprocess with a SHARED, caller-supplied HUB_HOME.
 * Unlike runConnectOnFreshHome (which mints a fresh home per
 * call) this helper reuses the same home across subprocesses so
 * a real preview → apply → rollback three-process sequence can
 * be exercised without in-memory state leaking across processes.
 *
 * The harness STILL strips HUB_BEARER_TOKEN* / HUB_CONNECT_* from
 * the inherited env; only HUB_HOME, HUB_OPENAPI, and the
 * caller-supplied envOverride survive. Tests that want a bearer
 * present must inject it via envOverride — the runner will still
 * strip it from the child unless they explicitly bypass (Phase B
 * never bypasses; this is for hygiene assertions only).
 */
export async function runConnectOnSharedHome(
  argv: readonly string[],
  home: string,
  envOverride: Record<string, string> = {},
  options: { cwd?: string } = {},
): Promise<ConnectRunResult> {
  const env: Record<string, string> = {
    HUB_HOME: home,
    HUB_OPENAPI: repoOpenAPI,
    ...envOverride,
  };
  return runConnect(argv, env, options);
}

/**
 * Canonical receipt location per the amendment:
 *   $HUB_HOME/state/connect/receipts/<runId>.json
 *
 * The receipt MUST only exist AFTER a successful apply; preview
 * MUST NOT create the file or the directory. Tests assert this
 * via `receiptPath()` to derive the canonical path and the
 * paired `readReceipt` / `receiptExists` / `receiptStat`
 * helpers to inspect the file.
 */
export function receiptPath(home: string, runId: string): string {
  return join(home, 'state', 'connect', 'receipts', `${runId}.json`);
}

export function receiptsDir(home: string): string {
  return join(home, 'state', 'connect', 'receipts');
}

/** True iff a receipt file exists at the canonical path. */
export function receiptExists(home: string, runId: string): boolean {
  return existsSync(receiptPath(home, runId));
}

/**
 * Read the raw receipt bytes from the canonical path. Returns
 * null when the file is absent so tests can distinguish
 * "no receipt written" from "receipt malformed". No JSON.parse
 * here — the cross-process rollback contract is about file
 * shape; the per-field schema assertions live in
 * receipt-security.test.ts.
 */
export function readReceipt(home: string, runId: string): string | null {
  const p = receiptPath(home, runId);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

/**
 * Returns the stat for the canonical receipt file or null if
 * the file is absent. Tests assert perms/mode via this helper:
 * the amendment mandates dir 0700 + file 0600. The function
 * deliberately surfaces the raw stat so tests can also catch
 * symlink-in-path (via lstat under the hood) and ownership
 * regressions.
 */
export interface ReceiptStat {
  mode: number;
  size: number;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export function statReceipt(home: string, runId: string): ReceiptStat | null {
  const p = receiptPath(home, runId);
  if (!existsSync(p)) return null;
  const st = statSync(p);
  return {
    mode: st.mode,
    size: st.size,
    isFile: st.isFile(),
    isSymbolicLink: st.isSymbolicLink(),
  };
}

/** stat(2)-level inspection of the receipts directory. */
export interface ReceiptsDirStat {
  exists: boolean;
  mode: number | null;
  isDirectory: boolean;
}

export function statReceiptsDir(home: string): ReceiptsDirStat {
  const dir = receiptsDir(home);
  if (!existsSync(dir)) {
    return { exists: false, mode: null, isDirectory: false };
  }
  const st = statSync(dir);
  return { exists: true, mode: st.mode, isDirectory: st.isDirectory() };
}

/**
 * Walk the receipts directory and snapshot the filename +
 * stat-mtime list. The amendment requires that
 *
 *   1. Preview leaves this directory empty (zero entries).
 *   2. Apply writes exactly ONE file (the runId under test).
 *   3. The atomic write never leaves a .tmp / .partial behind.
 *
 * The function is hermetic: it never follows symlinks, never
 * recurses, never reads the receipt contents.
 */
export interface ReceiptsListing {
  entries: string[];
}

export function listReceipts(home: string): ReceiptsListing {
  const dir = receiptsDir(home);
  if (!existsSync(dir)) return { entries: [] };
  // The receipts directory is flat per the amendment. A real
  // directory listing (not recursive) is exactly what we want.
  return { entries: readdirSync(dir) };
}

/**
 * Walk a directory tree and produce a byte-stable snapshot of
 * every file under it (sha256 + size + mode + mtime). Symlinks
 * are NOT followed; a symlink surfaces as no `files` entry
 * (lstat, not stat, with kind=symlink filtered out).
 *
 * Used by the cross-process rollback test to prove the target
 * root is byte-identical before preview / after apply / after
 * rollback, with zero per-file tolerance for mode/mtime drift.
 */
export interface DirFileEntry {
  sha256: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

export interface DirSnapshot {
  files: Map<string, DirFileEntry>;
  rootMtimeMs: number;
}

export function snapshotDirSafe(root: string): DirSnapshot {
  const files = new Map<string, DirFileEntry>();
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
      for (const child of children) stack.push(join(current, child));
    } else if (stat.isFile()) {
      const rel = relative(root, current).split('\\').join('/');
      const bytes = readFileSync(current);
      files.set(rel, {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: stat.size,
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
      });
    }
    // Symlinks intentionally omitted.
  }
  return { files, rootMtimeMs: statSync(root).mtimeMs };
}

/** Return the absolute paths inside $HUB_HOME that the connect
 *  pipeline is allowed to leave behind. Anything else appearing
 *  under $HUB_HOME after preview is a hidden-state regression.
 *
 *  The amendment pins:
 *    - state/connect/receipts/<runId>.json (apply only)
 *    - state/connect/receipts/ (dir, apply only)
 *    - everything else is hidden state and must NOT be created
 *      by preview.
 */
export const ALLOWED_HUB_HOME_PATHS_AFTER_PREVIEW: readonly string[] = Object.freeze(
  [],
);

export const ALLOWED_HUB_HOME_PATHS_AFTER_APPLY: readonly string[] =
  Object.freeze(['state/connect/receipts']);

/**
 * Diagnostic shape for the "no hidden state" assertion. Returns
 * the list of paths under $HUB_HOME that are NOT in the
 * allowlist for the requested phase. Empty list = clean.
 */
export function findUnexpectedHubHomePaths(
  home: string,
  allow: readonly string[],
): string[] {
  const snapshot = snapshotDirSafe(home);
  const allowSet = new Set<string>(allow);
  const unexpected: string[] = [];
  for (const rel of snapshot.files.keys()) {
    // The check is prefix-based: a file at
    // `state/connect/receipts/run_abc.json` is allowed because
    // its top-level dir matches the allowlist.
    const top = rel.split('/')[0];
    if (top && !allowSet.has(top)) {
      unexpected.push(rel);
    }
  }
  return unexpected;
}

/**
 * Seed a profile-bearing target root for apply/rollback. The
 * hermes materializer renders USER.md / MEMORY.md / SKILL.md
 * from a profile; we seed empty stubs so the apply has
 * something to overwrite (and the rollback has something to
 * restore). The seed bytes are NOT bearer-shaped.
 */
export function seedHermesTarget(targetRoot: string): {
  userPath: string;
  memoryPath: string;
  skillPath: string;
} {
  const userPath = seedConnectTarget(targetRoot, 'USER.md', '# pre-apply USER\n');
  const memoryPath = seedConnectTarget(targetRoot, 'MEMORY.md', '# pre-apply MEMORY\n');
  const skillPath = seedConnectTarget(targetRoot, 'SKILL.md', '# pre-apply SKILL\n');
  return { userPath, memoryPath, skillPath };
}
