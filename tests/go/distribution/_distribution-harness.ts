// tests/go/distribution/_distribution-harness.ts
//
// Reusable hermetic subprocess harness for the T9 distribution suite
// (`hub backup`, `hub update`, `hub doctor` final shape).
//
// Architecture mirrors the already-governed sibling harnesses
// (tests/go/shell/_hub-harness.ts — T1, tests/go/connect/_connect-harness.ts
// — T8):
//
//   * Build the hub binary ONCE per vitest worker with
//     `go build -trimpath` into a per-worker temp directory.
//   * Run it with caller-supplied argv and a sanitised env.
//   * Capture stdout / stderr / exit code verbatim; every assertion in
//     the .test.ts files is driven from those three channels plus the
//     observable filesystem.
//
// Hermetic isolation (nothing in this file ever writes inside the repo):
//   * HOME / XDG_DATA_HOME  → per-fixture mkdtemp roots.
//   * HUB_HOME              → per-fixture mkdtemp root.
//   * The canonical resolver DB is provisioned under a per-fixture
//     mkdtemp data dir and pointed at through AGENT_MEMORY_DB_PATH
//     (the same env convention `resolveHubDatabasePath()` honours —
//     see packages/core/src/storage/config.ts).
//   * HUB_BEARER_TOKEN* and every HUB_BACKUP_* / HUB_UPDATE_* knob is
//     stripped from the inherited env so a leaked operator value can
//     never make a test pass.
//
// T9 CONTRACT SOURCE OF TRUTH — docs/roadmap/slices.json slice `T9`.
// Only what the amendment pins is asserted:
//
//   backup   `hub backup --out <archive>` (snapshot)
//            `hub backup --restore <archive>` (restore)
//            default archive `$HUB_HOME/state/backups/<timestamp>.tar.gz`
//            archive file mode 0600
//            snapshot set = resolver-canonical SQLite DB + config files
//            excludes `$HUB_HOME/tokens/**` and every secret-shaped file
//            (`*.pem`, `*token*`, `*secret*`, `*.env`, `*.key`)
//   update   literal channel `stable` only (compiled-only)
//            plan-only dry-run by default
//            `hub update --apply` refuses with exit 2, no install mutation
//   doctor   final shape = T1 checks + backup/update posture +
//            distribution checks; `ok` on a fresh install fixture
//
// RED STATE (recorded at authoring time): cmd/hub/main.go has no
// `backup` and no `update` case, so the dispatcher falls through to
// `default:` and prints `hub: unknown command "backup"` /
// `hub: unknown command "update"` on stderr with exit 2.
//
// Because that fallthrough ALSO exits 2, every test in this suite that
// expects a T9 exit-2 refusal would go accidentally GREEN against the
// unknown-command path. `assertDispatched()` below is the guard: it
// fails whenever stderr still carries the dispatcher's
// `unknown command` diagnostic, so an exit-2 expectation can only be
// satisfied by a real T9 refusal.

import {
  chmodSync,
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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { ProfileService, createActorContext, type Profile } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const here = dirname(fileURLToPath(import.meta.url));
// `here` resolves to tests/go/distribution — three `..` hops land at
// the repo root (the directory holding cmd/, internal/, go.mod).
const repoRoot = resolve(here, '..', '..', '..');
const repoOpenAPI = join(repoRoot, 'openapi', 'openapi.yaml');

// ---------------------------------------------------------------------------
// Build (once per worker)
// ---------------------------------------------------------------------------

let cachedBinary: string | null = null;
let cachedBuildTmp: string | null = null;

export interface DistributionBuildResult {
  binary: string;
  buildTmp: string;
  buildLog: string;
}

export function buildDistributionBinary(): DistributionBuildResult {
  if (cachedBinary && cachedBuildTmp && existsSync(cachedBinary)) {
    return { binary: cachedBinary, buildTmp: cachedBuildTmp, buildLog: '' };
  }
  const buildTmp = mkdtempSync(join(tmpdir(), `hub-dist-${process.pid}-`));
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

export function resetDistributionBinary(): void {
  if (cachedBuildTmp && existsSync(cachedBuildTmp)) {
    rmSync(cachedBuildTmp, { recursive: true, force: true });
  }
  cachedBinary = null;
  cachedBuildTmp = null;
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

export interface DistributionRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
  command: string;
  timedOut: boolean;
}

const DEFAULT_RUN_TIMEOUT_MS = 60_000;

/** Env keys stripped from the inherited environment on every run. */
const STRIPPED_ENV_KEYS = [
  'HUB_HOME',
  'HUB_RUNTIME',
  'HUB_OPENAPI',
  'HUB_BEARER_TOKEN',
  'HUB_BEARER_TOKEN_FILE',
  'HUB_BEARER_TOKEN_SOURCE',
  // T9 owns `hub backup` / `hub update`. Any future env knob the
  // production author introduces must be opted into per test, never
  // inherited from the operator shell.
  'HUB_BACKUP_OUT',
  'HUB_BACKUP_DIR',
  'HUB_UPDATE_CHANNEL',
  'HUB_UPDATE_APPLY',
  // Canonical storage resolver env (packages/core/src/storage/config.ts).
  'AGENT_MEMORY_DB_PATH',
  'AGENT_MEMORY_DATA_DIR',
  'AGENT_MEMORY_STORAGE_MODE',
  'PORTABLE_AGENT_ASSET_HUB_DATA_DIR',
] as const;

export async function runHub(
  argv: readonly string[],
  envOverride: Record<string, string> = {},
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<DistributionRunResult> {
  const { binary } = buildDistributionBinary();
  const cleanedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') cleanedEnv[k] = v;
  }
  for (const k of STRIPPED_ENV_KEYS) delete cleanedEnv[k];
  cleanedEnv.CI = 'true';
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  return await new Promise((resolveP) => {
    const child = spawn(binary, argv, {
      cwd: options.cwd ?? repoRoot,
      env: { ...cleanedEnv, ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let spawnErr: Error | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (err) => { spawnErr = err; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveP({
        status: code,
        signal: signal as NodeJS.Signals | null,
        stdout,
        stderr,
        error: spawnErr,
        timedOut,
        command: `${binary} ${argv.join(' ')}`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Accidental-GREEN guard.
//
// The pre-T9 dispatcher answers `hub backup …` / `hub update …` with
// exit 2 + `hub: unknown command "backup"`. Any T9 test that expects
// exit 2 (unknown verb, --apply refusal, non-stable channel refusal)
// would therefore pass for the WRONG reason. Every such test calls
// assertDispatched() first, which fails while the dispatcher still
// falls through.
// ---------------------------------------------------------------------------

const UNKNOWN_COMMAND_DIAGNOSTIC = /unknown command/i;

export function assertDispatched(
  res: DistributionRunResult,
  verb: string,
): void {
  expect(
    UNKNOWN_COMMAND_DIAGNOSTIC.test(res.stderr),
    `\`hub ${verb}\` was not dispatched — the shell still answers with the `
    + `dispatcher's unknown-command fallthrough.\n`
    + `command: ${res.command}\nstatus: ${String(res.status)}\n`
    + `stderr: ${JSON.stringify(res.stderr)}\nstdout: ${JSON.stringify(res.stdout)}`,
  ).toBe(false);
}

// ---------------------------------------------------------------------------
// Bearer-shape predicates (mirrored from internal/output/output.go and
// the T1/T8 harnesses).
// ---------------------------------------------------------------------------

const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=\s*[^\s,'"]+/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

export function looksLikeBearer(s: string): boolean {
  if (!s) return false;
  if (BEARER_PREFIXED_OPAQUE.test(s)) return true;
  if (HUB_BEARER_ENV_ASSIGNMENT.test(s)) return true;
  if (JWT_TRIPLE_SEGMENT.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Secret-shape predicate — the exact glob set the T9 amendment pins:
//   `*.pem`, `*token*`, `*secret*`, `*.env`, `*.key`
// plus anything under `$HUB_HOME/tokens/**`.
// ---------------------------------------------------------------------------

export const SECRET_SHAPED_NAME = /(\.pem$)|(token)|(secret)|(\.env$)|(\.key$)/i;

export function isSecretShapedEntry(entryPath: string): boolean {
  const normalised = entryPath.split(/[\\/]+/u).filter(Boolean);
  if (normalised.some((segment) => segment === 'tokens')) return true;
  const base = normalised.at(-1) ?? '';
  return SECRET_SHAPED_NAME.test(base);
}

// ---------------------------------------------------------------------------
// Fresh-install fixture.
//
// Provisions, per test:
//   * HOME / XDG_DATA_HOME temp roots (so any XDG fallback stays inside
//     the sandbox);
//   * a HUB_HOME temp root;
//   * a data dir holding the resolver-canonical `hub.sqlite`, created
//     and seeded through the real SqliteStore + ProfileService so the
//     file on disk is a genuine migrated hub database;
//   * decoy secret-shaped files (each carrying a unique marker string)
//     inside HUB_HOME and next to the canonical DB;
//   * decoy SQLite files under HUB_HOME (`hub.sqlite`,
//     `backup.sqlite`) that a DB-fallback regression would capture.
//
// The fixture NEVER runs `hub init` implicitly — tests that need the
// initialised layout (and therefore a real bearer token at
// `$HUB_HOME/tokens/hub.token`) call `hubInit(fx)` explicitly.
// ---------------------------------------------------------------------------

export interface FreshInstallFixture {
  label: string;
  home: string;          // HOME + XDG_DATA_HOME root
  hubHome: string;       // HUB_HOME
  dataDir: string;       // resolver data dir
  databasePath: string;  // resolver-canonical SQLite database
  backupsDir: string;    // $HUB_HOME/state/backups
  profileId: string;
  dbMarker: string;      // unique string embedded in the canonical DB
  secretMarkers: Record<string, string>; // absPath -> unique marker
  decoyDatabases: string[];
  decoyMarkers: Record<string, string>;  // decoy DB absPath -> unique marker
  env: Record<string, string>;
  cleanup: () => void;
}

const CANONICAL_DEFAULT_USER_ID = 'usr_local';
const CANONICAL_DEFAULT_AGENT_ID = 'agt_local';

function canonicalActorEnv(): { userId: `usr_${string}`; agentId: `agt_${string}` } {
  const userId = process.env.AGENT_MEMORY_USER_ID ?? CANONICAL_DEFAULT_USER_ID;
  const agentId = process.env.AGENT_MEMORY_AGENT_ID ?? CANONICAL_DEFAULT_AGENT_ID;
  // The opaque-id branding lives in packages/core/src/identity/types.ts.
  // The productive CLI convention supplies these as plain env strings
  // (see packages/rest/src/launcher.ts, scripts/relations.mjs), so the
  // fixture re-brands them at the boundary rather than inventing a
  // fixture-only identity type.
  return {
    userId: userId as `usr_${string}`,
    agentId: agentId as `agt_${string}`,
  };
}

/** Create + migrate + seed the resolver-canonical database on disk. */
function provisionCanonicalDatabase(
  databasePath: string,
  profileId: string,
  marker: string,
): void {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const { userId, agentId } = canonicalActorEnv();
  const actor = createActorContext({ userId, agentId, role: 'user', capabilities: [] });
  const profile: Profile = {
    id: profileId,
    scope: actor.scope,
    version: 1,
    blocks: [
      { blockId: 'user', ordinal: 0, kind: 'USER', body: `t9 canonical user ${marker}` },
      { blockId: 'memory', ordinal: 1, kind: 'MEMORY', body: `t9 canonical memory ${marker}` },
    ],
  };
  const store = new SqliteStore(databasePath);
  try {
    new ProfileService(store, actor).create(profile, {
      reason: 't9-distribution-fixture',
      requestId: `req-t9-${profileId}`,
    });
  } finally {
    store.close();
  }
  // Fold the WAL into the main file so the archive assertions can look
  // for the marker in `hub.sqlite` itself.
  const checkpoint = new DatabaseSync(databasePath);
  try { checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { checkpoint.close(); }
  if (!existsSync(databasePath)) {
    throw new Error(`fixture: canonical database was not created at ${databasePath}`);
  }
}

export function freshInstallFixture(label: string): FreshInstallFixture {
  const tag = `${label}-${process.pid}-${Date.now()}`;
  const home = mkdtempSync(join(tmpdir(), `hub-dist-home-${tag}-`));
  const hubHome = mkdtempSync(join(tmpdir(), `hub-dist-hubhome-${tag}-`));
  const dataDir = mkdtempSync(join(tmpdir(), `hub-dist-data-${tag}-`));
  const databasePath = join(dataDir, 'hub.sqlite');
  const profileId = `prf_t9_${label.replace(/[^a-z0-9]/giu, '')}`;
  const dbMarker = `T9_CANONICAL_DB_MARKER_${tag.replace(/[^A-Za-z0-9]/gu, '_')}`;
  provisionCanonicalDatabase(databasePath, profileId, dbMarker);

  // Decoy secret-shaped files. Each carries a unique marker so an
  // archive that captured it can be caught by a raw byte scan even if
  // the entry name were rewritten.
  const secretMarkers: Record<string, string> = {};
  const seedSecret = (absPath: string, key: string): void => {
    mkdirSync(dirname(absPath), { recursive: true, mode: 0o700 });
    const marker = `T9_SECRET_MARKER_${key}_${tag.replace(/[^A-Za-z0-9]/gu, '_')}`;
    writeFileSync(absPath, `${marker}\n`, { encoding: 'utf8', mode: 0o600 });
    secretMarkers[absPath] = marker;
  };
  seedSecret(join(hubHome, 'tokens', 'hub.token'), 'HUB_TOKEN');
  seedSecret(join(hubHome, 'tokens', 'extra.secret'), 'HUB_TOKENS_DIR');
  seedSecret(join(hubHome, 'state', 'service.env'), 'DOT_ENV');
  seedSecret(join(hubHome, 'state', 'client.pem'), 'PEM');
  seedSecret(join(hubHome, 'state', 'api.key'), 'KEY');
  seedSecret(join(hubHome, 'state', 'mytoken.txt'), 'TOKEN_SUBSTRING');
  seedSecret(join(hubHome, 'state', 'secret-notes.json'), 'SECRET_SUBSTRING');
  seedSecret(join(dataDir, 'db.key'), 'DATADIR_KEY');
  seedSecret(join(dataDir, 'session.token'), 'DATADIR_TOKEN');

  // Decoy databases a DB-fallback regression would pick up. The
  // amendment forbids any HUB_HOME DB / alternate DB / parallel DB.
  const decoyDatabases = [
    join(hubHome, 'hub.sqlite'),
    join(hubHome, 'state', 'hub.sqlite'),
    join(hubHome, 'backup.sqlite'),
  ];
  const decoyMarkers: Record<string, string> = {};
  for (const decoy of decoyDatabases) {
    mkdirSync(dirname(decoy), { recursive: true, mode: 0o700 });
    const marker = `T9_DECOY_DB_MARKER_${decoy.split(sep).slice(-2).join('_').replace(/[^A-Za-z0-9]/gu, '_')}_${tag.replace(/[^A-Za-z0-9]/gu, '_')}`;
    const db = new DatabaseSync(decoy);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS t9_decoy (marker TEXT)');
      db.exec(`INSERT INTO t9_decoy (marker) VALUES ('${marker}')`);
    } finally {
      db.close();
    }
    decoyMarkers[decoy] = marker;
  }

  const env: Record<string, string> = {
    HOME: home,
    XDG_DATA_HOME: home,
    HUB_HOME: hubHome,
    HUB_OPENAPI: repoOpenAPI,
    AGENT_MEMORY_DB_PATH: databasePath,
    AGENT_MEMORY_DATA_DIR: dataDir,
    PORTABLE_AGENT_ASSET_HUB_DATA_DIR: dataDir,
    AGENT_MEMORY_STORAGE_MODE: 'temporary',
    CI: 'true',
  };

  return {
    label,
    home,
    hubHome,
    dataDir,
    databasePath,
    backupsDir: join(hubHome, 'state', 'backups'),
    profileId,
    dbMarker,
    secretMarkers,
    decoyDatabases,
    decoyMarkers,
    env,
    cleanup: () => {
      for (const dir of [home, hubHome, dataDir]) {
        if (existsSync(dir)) {
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
      }
    },
  };
}

/** Run hub inside a fixture with the fixture's env pre-applied. */
export async function runHubInFixture(
  fx: FreshInstallFixture,
  argv: readonly string[],
  extraEnv: Record<string, string> = {},
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<DistributionRunResult> {
  return await runHub(argv, { ...fx.env, ...extraEnv }, options);
}

/**
 * Materialise the "fresh install" layout via the real `hub init`
 * (T3-owned, already GREEN). Used by the doctor-final tests: the
 * amendment's exit criterion is "doctor reports OK on a fresh install
 * fixture", which means an initialised HUB_HOME, not an empty dir.
 */
export async function hubInit(fx: FreshInstallFixture): Promise<DistributionRunResult> {
  const res = await runHubInFixture(fx, ['init']);
  if (res.status !== 0) {
    throw new Error(
      `fixture: \`hub init\` failed (status=${String(res.status)})\n`
      + `stdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  return res;
}

// ---------------------------------------------------------------------------
// Archive helpers (tar.gz — the pinned default format).
// ---------------------------------------------------------------------------

export interface ArchiveListing {
  ok: boolean;
  entries: string[];
  stderr: string;
  status: number | null;
}

/** List archive entries with the system tar (no JS tar implementation). */
export function listArchiveEntries(archivePath: string): ArchiveListing {
  const res = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  const entries = (res.stdout ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    ok: res.status === 0,
    entries,
    stderr: res.stderr ?? '',
    status: res.status,
  };
}

/**
 * Concatenated raw bytes of every member of the archive. Used for the
 * marker scans: an excluded secret must not appear anywhere in the
 * archive payload, whatever the entry happened to be named.
 */
export function archivePayloadBytes(archivePath: string): Buffer {
  const res = spawnSync('tar', ['-xzOf', archivePath], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) return Buffer.alloc(0);
  return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.alloc(0);
}

export function archiveContainsMarker(archivePath: string, marker: string): boolean {
  return archivePayloadBytes(archivePath).includes(Buffer.from(marker, 'utf8'));
}

/** Extract the archive into `destDir` with the system tar. */
export function extractArchive(archivePath: string, destDir: string): {
  ok: boolean;
  status: number | null;
  stderr: string;
} {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const res = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { encoding: 'utf8' });
  return { ok: res.status === 0, status: res.status, stderr: res.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// Filesystem observation helpers.
// ---------------------------------------------------------------------------

export function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface TreeSnapshot {
  root: string;
  files: Record<string, { digest: string; mode: number; size: number }>;
}

/**
 * Recursive digest snapshot of a directory tree. Used to prove
 * "no mutation" claims byte-for-byte instead of by inspection.
 */
export function snapshotTree(root: string): TreeSnapshot {
  const files: TreeSnapshot['files'] = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = statSync(abs);
      files[relative(root, abs)] = {
        digest: createHash('sha256').update(readFileSync(abs)).digest('hex'),
        mode: st.mode & 0o777,
        size: st.size,
      };
    }
  };
  walk(root);
  return { root, files };
}

export function listBackupArchives(backupsDir: string): string[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

/**
 * Read the profile block bodies out of the canonical database so a
 * restore round-trip can be asserted on CONTENT, not just on file
 * presence. The blocks live in `profile_versions.blocks_json` (see
 * packages/storage-sqlite/src/migrations/0012_profiles.sql). Returns
 * the sorted list of block bodies.
 */
export function readProfileBodies(databasePath: string): string[] {
  if (!existsSync(databasePath)) return [];
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    if (!names.has('profile_versions')) return [];
    const rows = db
      .prepare('SELECT blocks_json FROM profile_versions')
      .all() as Array<{ blocks_json: string }>;
    const bodies: string[] = [];
    for (const row of rows) {
      const parsed = JSON.parse(String(row.blocks_json)) as Array<{ body?: unknown }>;
      for (const block of parsed) {
        if (typeof block?.body === 'string') bodies.push(block.body);
      }
    }
    return bodies.sort();
  } finally {
    db.close();
  }
}

/** True when the raw SQLite file bytes contain `marker`. */
export function databaseContainsMarker(databasePath: string, marker: string): boolean {
  if (!existsSync(databasePath)) return false;
  return readFileSync(databasePath).includes(Buffer.from(marker, 'utf8'));
}

/** Overwrite the canonical DB so a restore has something to undo. */
export function corruptDatabase(databasePath: string): void {
  writeFileSync(databasePath, 'T9_DATABASE_WAS_CLOBBERED\n', { encoding: 'utf8' });
  chmodSync(databasePath, 0o600);
}

export { repoRoot, repoOpenAPI, sep };
