// tests/go/distribution/_harness-selfcheck.test.ts
//
// Harness self-check for the T9 distribution suite.
//
// This file does NOT assert anything about T9 production behaviour. Its
// only job is to prove the hermetic harness itself is sound, so that
// when the T9 contract tests fail they fail for a PRODUCT reason and not
// because the fixture, the go build, the tar helpers, or the SQLite
// provisioning is broken.
//
// The distinction matters: a RED suite whose failures come from harness
// breakage is worthless as TDD evidence. These checks are expected to be
// GREEN both before and after T9 lands.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  archiveContainsMarker,
  buildDistributionBinary,
  databaseContainsMarker,
  extractArchive,
  fileMode,
  freshInstallFixture,
  hubInit,
  isSecretShapedEntry,
  listArchiveEntries,
  looksLikeBearer,
  readProfileBodies,
  runHub,
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

describe('T9 harness self-check — build + dispatch', () => {
  it('go build -trimpath produces a runnable hub binary', () => {
    const { binary } = buildDistributionBinary();
    expect(existsSync(binary)).toBe(true);
  }, 120_000);

  it('an already-shipped verb (`hub --version`) exits 0 through the harness runner', async () => {
    const res = await runHub(['--version']);
    expect(res.error).toBeNull();
    expect(res.timedOut).toBe(false);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toMatch(/hub\s+\d+\.\d+\.\d+/u);
  }, 120_000);
});

describe('T9 harness self-check — fresh install fixture', () => {
  it('provisions a real migrated canonical database carrying the fixture marker', () => {
    const fx = fixture('selfcheck-db');
    expect(existsSync(fx.databasePath)).toBe(true);
    expect(databaseContainsMarker(fx.databasePath, fx.dbMarker)).toBe(true);
    const bodies = readProfileBodies(fx.databasePath);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join('\n')).toContain(fx.dbMarker);
  }, 120_000);

  it('seeds decoy secret-shaped files and decoy databases outside the canonical DB', () => {
    const fx = fixture('selfcheck-secrets');
    const secretPaths = Object.keys(fx.secretMarkers);
    expect(secretPaths.length).toBeGreaterThan(0);
    for (const p of secretPaths) {
      expect(existsSync(p), `missing seeded secret ${p}`).toBe(true);
    }
    for (const decoy of fx.decoyDatabases) {
      expect(existsSync(decoy), `missing decoy DB ${decoy}`).toBe(true);
      expect(decoy).not.toBe(fx.databasePath);
    }
    // The canonical DB must NOT live under HUB_HOME — that separation is
    // what makes the "resolver DB, not HUB_HOME DB" assertions meaningful.
    expect(fx.databasePath.startsWith(fx.hubHome)).toBe(false);
  }, 120_000);

  it('`hub init` succeeds inside the fixture (fresh install layout is reachable)', async () => {
    const fx = fixture('selfcheck-init');
    await hubInit(fx);
    expect(existsSync(join(fx.hubHome, 'tokens', 'hub.token'))).toBe(true);
    const doctor = await runHubInFixture(fx, ['doctor', '--json']);
    expect(doctor.status, `stderr: ${doctor.stderr}`).toBe(0);
    const parsed = JSON.parse(doctor.stdout) as { status?: string };
    expect(typeof parsed.status).toBe('string');
  }, 120_000);
});

describe('T9 harness self-check — archive + filesystem helpers', () => {
  it('listArchiveEntries / extractArchive / archiveContainsMarker work on a real tar.gz', () => {
    const fx = fixture('selfcheck-tar');
    const payloadDir = join(fx.home, 'payload');
    const archivePath = join(fx.home, 'probe.tar.gz');
    writeFileSync(join(fx.home, 'plain.txt'), 'HARNESS_PROBE_MARKER\n', 'utf8');
    const tarRes = spawnSync('tar', ['-czf', archivePath, '-C', fx.home, 'plain.txt'], {
      encoding: 'utf8',
    });
    expect(tarRes.status, `tar stderr: ${tarRes.stderr}`).toBe(0);
    const listing = listArchiveEntries(archivePath);
    expect(listing.ok).toBe(true);
    expect(listing.entries).toContain('plain.txt');
    expect(archiveContainsMarker(archivePath, 'HARNESS_PROBE_MARKER')).toBe(true);
    expect(archiveContainsMarker(archivePath, 'NOT_IN_THE_ARCHIVE_AT_ALL')).toBe(false);
    const extracted = extractArchive(archivePath, payloadDir);
    expect(extracted.ok, `tar -x stderr: ${extracted.stderr}`).toBe(true);
    expect(existsSync(join(payloadDir, 'plain.txt'))).toBe(true);
  }, 120_000);

  it('fileMode reports POSIX permission bits and snapshotTree detects a byte change', () => {
    const fx = fixture('selfcheck-mode');
    const p = join(fx.home, 'mode-probe.txt');
    writeFileSync(p, 'x', { encoding: 'utf8', mode: 0o600 });
    expect(fileMode(p)).toBe(0o600);
    const before = snapshotTree(fx.home);
    writeFileSync(p, 'y', { encoding: 'utf8', mode: 0o600 });
    const after = snapshotTree(fx.home);
    expect(after).not.toEqual(before);
  }, 120_000);

  it('secret-shape and bearer-shape predicates classify the pinned patterns', () => {
    // The exact glob set the T9 amendment pins.
    for (const secret of [
      'tokens/hub.token',
      'state/tokens/anything.txt',
      'client.pem',
      'api.key',
      'service.env',
      'mytoken.txt',
      'secret-notes.json',
    ]) {
      expect(isSecretShapedEntry(secret), `expected secret-shaped: ${secret}`).toBe(true);
    }
    for (const benign of ['hub.sqlite', 'config.json', 'state/config.yaml', 'README.md']) {
      expect(isSecretShapedEntry(benign), `expected benign: ${benign}`).toBe(false);
    }
    expect(looksLikeBearer('Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe(true);
    expect(looksLikeBearer('HUB_BEARER_TOKEN=abc123')).toBe(true);
    expect(looksLikeBearer('nothing to see here')).toBe(false);
  }, 60_000);
});
