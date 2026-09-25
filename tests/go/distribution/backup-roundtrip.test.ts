// tests/go/distribution/backup-roundtrip.test.ts
//
// T9 RED real-subprocess contract for `hub backup --out` / `hub backup
// --restore`. This is one of the three test files the T9 amendment names
// explicitly in `tests[]`.
//
// Contract source of truth — docs/roadmap/slices.json slice `T9`:
//
//   objective
//     "exact `hub backup --out <archive>` snapshot and `hub backup
//      --restore <archive>` restore, default archive path
//      `$HUB_HOME/state/backups/<timestamp>.tar.gz`, archive file mode
//      0600 … Backup snapshots cover the canonical resolver-selected
//      SQLite database plus config files, and MUST exclude any path
//      under `$HUB_HOME/tokens/**` and any secret-shaped file.
//      HUB_HOME/state/backups/** is the only backup target directory;
//      no invented transport or DB fallback."
//
//   audit_requirements[1..3]
//     default archive path + mode 0600
//     snapshot set is resolver-canonical SQLite (via
//       resolveHubDatabasePath()) plus config files only; no HUB_HOME
//       DB, no alternate/parallel DB, no invented transport/registry/DB
//       fallback
//     `$HUB_HOME/tokens/**` and any secret-shaped file is excluded
//
//   security_invariants
//     I-15 (product software / runtime separated from user canonical
//     data), I-07 (bearer hygiene)
//
// Fixture design — why the assertions can distinguish right from wrong:
//   * the resolver-canonical DB is provisioned OUTSIDE `$HUB_HOME`
//     (under a temp data dir pointed at by AGENT_MEMORY_DB_PATH) and
//     carries a unique marker string;
//   * three DECOY SQLite files live under `$HUB_HOME`
//     (hub.sqlite, state/hub.sqlite, backup.sqlite), each with its own
//     marker — a HUB_HOME-DB fallback regression captures one of them
//     and the marker scan catches it;
//   * secret-shaped decoys (tokens/hub.token, *.pem, *.key, *.env,
//     *token*, *secret*) each carry their own marker — an exclusion
//     regression captures one and the marker scan catches it.
//
// RED STATE at authoring time: `backup` is not registered in
// cmd/hub/main.go, so every invocation exits 2 with
// `hub: unknown command "backup"`.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  archiveContainsMarker,
  assertDispatched,
  corruptDatabase,
  databaseContainsMarker,
  fileMode,
  freshInstallFixture,
  hubInit,
  isSecretShapedEntry,
  listArchiveEntries,
  listBackupArchives,
  looksLikeBearer,
  readProfileBodies,
  runHubInFixture,
  snapshotTree,
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

// The pinned default archive filename shape: `<timestamp>.tar.gz`.
// The amendment does not pin the timestamp FORMAT, so the assertion
// only requires (a) the `.tar.gz` suffix and (b) a digit-bearing stem —
// enough to reject `latest.tar.gz` / `backup.tar.gz` without inventing
// a format the contract never specified.
const DEFAULT_ARCHIVE_NAME = /^(?=.*\d)[A-Za-z0-9._:+-]+\.tar\.gz$/u;

// ---------------------------------------------------------------------------
// 1. `hub backup --out <archive>` writes a real archive at mode 0600.
// ---------------------------------------------------------------------------

describe('hub backup --out — explicit archive path (T9)', () => {
  it('writes the archive at the requested path with mode 0600 and exits 0', async () => {
    const fx = fixture('out-explicit');
    await hubInit(fx);
    const archive = join(fx.home, 'explicit-out.tar.gz');
    const res = await runHubInFixture(fx, ['backup', '--out', archive]);
    assertDispatched(res, 'backup');
    expect(
      res.status,
      `stdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
    ).toBe(0);
    expect(existsSync(archive), `archive missing at ${archive}`).toBe(true);
    // I-15: the archive holds user canonical data; mode 0600 is pinned.
    expect(fileMode(archive)).toBe(0o600);
    // It must be a real gzip tar, not a placeholder file.
    const listing = listArchiveEntries(archive);
    expect(listing.ok, `tar -tzf failed: ${listing.stderr}`).toBe(true);
    expect(listing.entries.length).toBeGreaterThan(0);
  }, CASE_TIMEOUT_MS);

  it('never emits a bearer-shaped string on either stream', async () => {
    const fx = fixture('out-bearer');
    await hubInit(fx);
    const archive = join(fx.home, 'bearer-probe.tar.gz');
    const res = await runHubInFixture(fx, ['backup', '--out', archive]);
    expect(looksLikeBearer(res.stdout), `stdout leaked bearer-shape: ${res.stdout}`).toBe(false);
    expect(looksLikeBearer(res.stderr), `stderr leaked bearer-shape: ${res.stderr}`).toBe(false);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 2. Default archive location: `$HUB_HOME/state/backups/<timestamp>.tar.gz`.
// ---------------------------------------------------------------------------

describe('hub backup — default archive location and mode (T9)', () => {
  it('with no --out, writes exactly one <timestamp>.tar.gz under $HUB_HOME/state/backups at mode 0600', async () => {
    const fx = fixture('default-location');
    await hubInit(fx);
    expect(listBackupArchives(fx.backupsDir)).toEqual([]);
    const res = await runHubInFixture(fx, ['backup']);
    assertDispatched(res, 'backup');
    expect(
      res.status,
      `stdout=${JSON.stringify(res.stdout)}\nstderr=${JSON.stringify(res.stderr)}`,
    ).toBe(0);
    const archives = listBackupArchives(fx.backupsDir);
    expect(archives.length, `expected 1 archive under ${fx.backupsDir}, saw ${JSON.stringify(archives)}`).toBe(1);
    const name = archives[0]!;
    expect(name, `default archive name ${name} is not <timestamp>.tar.gz`).toMatch(DEFAULT_ARCHIVE_NAME);
    const archive = join(fx.backupsDir, name);
    expect(fileMode(archive)).toBe(0o600);
    const listing = listArchiveEntries(archive);
    expect(listing.ok, `tar -tzf failed: ${listing.stderr}`).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('`$HUB_HOME/state/backups` is the only backup target directory — no archive lands elsewhere under $HUB_HOME', async () => {
    const fx = fixture('default-only-target');
    await hubInit(fx);
    const res = await runHubInFixture(fx, ['backup']);
    assertDispatched(res, 'backup');
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    const tree = snapshotTree(fx.hubHome);
    const archivesOutsideTarget = Object.keys(tree.files).filter(
      (rel) => /\.tar(\.gz)?$|\.tgz$/u.test(rel) && !rel.startsWith(join('state', 'backups')),
    );
    expect(
      archivesOutsideTarget,
      `archive written outside $HUB_HOME/state/backups: ${JSON.stringify(archivesOutsideTarget)}`,
    ).toEqual([]);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 3. Snapshot set: resolver-canonical DB + config only.
//    No HUB_HOME DB, no alternate/parallel DB.
// ---------------------------------------------------------------------------

describe('hub backup — snapshot set is the resolver-canonical DB, not a HUB_HOME DB (T9)', () => {
  it('captures the resolver-canonical database content', async () => {
    const fx = fixture('resolver-db');
    await hubInit(fx);
    const archive = join(fx.home, 'resolver.tar.gz');
    const res = await runHubInFixture(fx, ['backup', '--out', archive]);
    assertDispatched(res, 'backup');
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    // The canonical DB carries a unique marker written through the real
    // SqliteStore/ProfileService. If the archive does not contain it,
    // the snapshot did not include the resolver-selected database.
    expect(
      archiveContainsMarker(archive, fx.dbMarker),
      `archive does not contain the resolver-canonical DB marker ${fx.dbMarker}`,
    ).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('does NOT capture any decoy database under $HUB_HOME (no DB fallback)', async () => {
    const fx = fixture('no-db-fallback');
    await hubInit(fx);
    const archive = join(fx.home, 'no-fallback.tar.gz');
    const res = await runHubInFixture(fx, ['backup', '--out', archive]);
    assertDispatched(res, 'backup');
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    for (const [decoyPath, marker] of Object.entries(fx.decoyMarkers)) {
      expect(
        archiveContainsMarker(archive, marker),
        `archive captured the decoy database ${decoyPath} (DB fallback regression)`,
      ).toBe(false);
    }
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 4. Token / secret exclusion (I-15, I-07).
// ---------------------------------------------------------------------------

describe('hub backup — tokens and secret-shaped files are excluded (T9)', () => {
  it('excludes every seeded secret-shaped file by content marker', async () => {
    const fx = fixture('secret-exclusion');
    await hubInit(fx);
    const archive = join(fx.home, 'secrets.tar.gz');
    const res = await runHubInFixture(fx, ['backup', '--out', archive]);
    assertDispatched(res, 'backup');
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    for (const [secretPath, marker] of Object.entries(fx.secretMarkers)) {
      expect(
        archiveContainsMarker(archive, marker),
        `archive captured secret-shaped file ${secretPath} (marker ${marker})`,
      ).toBe(false);
    }
  }, CASE_TIMEOUT_MS);

  it('excludes the real bearer token minted by `hub init`', async () => {
    const fx = fixture('token-exclusion');
    await hubInit(fx);
    const tokenPath = join(fx.hubHome, 'tokens', 'hub.token');
    expect(existsSync(tokenPath), 'fixture: hub init did not mint a token').toBe(true);
    const tokenBytes = readFileSync(tokenPath, 'utf8').trim();
    expect(tokenBytes.length).toBeGreaterThan(0);
    const archive = join(fx.home, 'token.tar.gz');
    const res = await runHubInFixture(fx, ['backup', '--out', archive]);
    assertDispatched(res, 'backup');
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    expect(
      archiveContainsMarker(archive, tokenBytes),
      'archive captured the live bearer token from $HUB_HOME/tokens/hub.token',
    ).toBe(false);
  }, CASE_TIMEOUT_MS);

  it('no archive ENTRY NAME is secret-shaped or lives under tokens/', async () => {
    const fx = fixture('secret-entry-names');
    await hubInit(fx);
    const archive = join(fx.home, 'entry-names.tar.gz');
    const res = await runHubInFixture(fx, ['backup', '--out', archive]);
    assertDispatched(res, 'backup');
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    const listing = listArchiveEntries(archive);
    expect(listing.ok, `tar -tzf failed: ${listing.stderr}`).toBe(true);
    const offending = listing.entries.filter((entry) => isSecretShapedEntry(entry));
    expect(
      offending,
      `archive contains secret-shaped entries: ${JSON.stringify(offending)}`,
    ).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it('excludes a secret-shaped file created inside $HUB_HOME/state after init', async () => {
    // Belt-and-braces: exclusion must be a live rule over the snapshot
    // set, not a hardcoded list of fixture paths.
    const fx = fixture('late-secret');
    await hubInit(fx);
    const lateDir = join(fx.hubHome, 'state', 'late');
    mkdirSync(lateDir, { recursive: true, mode: 0o700 });
    const marker = 'T9_LATE_SECRET_MARKER_UNIQUE_STRING';
    writeFileSync(join(lateDir, 'late-secret.json'), `${marker}\n`, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(join(lateDir, 'late.key'), `${marker}_KEY\n`, { encoding: 'utf8', mode: 0o600 });
    const archive = join(fx.home, 'late.tar.gz');
    const res = await runHubInFixture(fx, ['backup', '--out', archive]);
    assertDispatched(res, 'backup');
    expect(res.status, `stderr=${JSON.stringify(res.stderr)}`).toBe(0);
    expect(archiveContainsMarker(archive, marker)).toBe(false);
    expect(archiveContainsMarker(archive, `${marker}_KEY`)).toBe(false);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 5. Restore round-trip.
// ---------------------------------------------------------------------------

describe('hub backup --restore — round-trip (T9)', () => {
  it('restores the resolver-canonical database content after it is clobbered', async () => {
    const fx = fixture('roundtrip');
    await hubInit(fx);
    const bodiesBefore = readProfileBodies(fx.databasePath);
    expect(bodiesBefore.length, 'fixture: canonical DB has no profile blocks').toBeGreaterThan(0);

    const archive = join(fx.home, 'roundtrip.tar.gz');
    const snapshot = await runHubInFixture(fx, ['backup', '--out', archive]);
    assertDispatched(snapshot, 'backup');
    expect(snapshot.status, `snapshot stderr=${JSON.stringify(snapshot.stderr)}`).toBe(0);

    // Destroy the canonical DB so a no-op restore cannot pass.
    corruptDatabase(fx.databasePath);
    expect(databaseContainsMarker(fx.databasePath, fx.dbMarker)).toBe(false);

    const restore = await runHubInFixture(fx, ['backup', '--restore', archive]);
    assertDispatched(restore, 'backup');
    expect(
      restore.status,
      `restore stdout=${JSON.stringify(restore.stdout)}\nrestore stderr=${JSON.stringify(restore.stderr)}`,
    ).toBe(0);

    // Content equivalence: the marker is back AND the profile blocks
    // read back identically through the real schema.
    expect(
      databaseContainsMarker(fx.databasePath, fx.dbMarker),
      'restore did not bring back the canonical DB marker',
    ).toBe(true);
    expect(readProfileBodies(fx.databasePath)).toEqual(bodiesBefore);
  }, CASE_TIMEOUT_MS);

  it('restore does not resurrect tokens or secret-shaped files (they were never captured)', async () => {
    const fx = fixture('roundtrip-no-secrets');
    await hubInit(fx);
    const archive = join(fx.home, 'roundtrip-secrets.tar.gz');
    const snapshot = await runHubInFixture(fx, ['backup', '--out', archive]);
    assertDispatched(snapshot, 'backup');
    expect(snapshot.status, `snapshot stderr=${JSON.stringify(snapshot.stderr)}`).toBe(0);

    // Replace each seeded secret with a distinguishable sentinel; a
    // restore that carried secrets would overwrite these back to the
    // original markers.
    for (const secretPath of Object.keys(fx.secretMarkers)) {
      if (!existsSync(secretPath)) continue;
      writeFileSync(secretPath, 'T9_SENTINEL_AFTER_SNAPSHOT\n', { encoding: 'utf8', mode: 0o600 });
    }
    const restore = await runHubInFixture(fx, ['backup', '--restore', archive]);
    assertDispatched(restore, 'backup');
    expect(restore.status, `restore stderr=${JSON.stringify(restore.stderr)}`).toBe(0);
    for (const [secretPath, marker] of Object.entries(fx.secretMarkers)) {
      if (!existsSync(secretPath)) continue;
      const body = readFileSync(secretPath, 'utf8');
      expect(
        body.includes(marker),
        `restore rewrote secret-shaped file ${secretPath} from the archive`,
      ).toBe(false);
    }
  }, CASE_TIMEOUT_MS);
});
