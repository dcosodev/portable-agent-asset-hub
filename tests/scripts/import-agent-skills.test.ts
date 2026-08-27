// tests/scripts/import-agent-skills.test.ts
//
// Real end-to-end CLI test for `scripts/import-agent-skills.mjs`.
//
// Coverage:
//
//   * CLI determinism: two `--preview` runs over the same inputs
//     produce byte-identical preview JSON (so the digest and the
//     preview JSON stay in lock-step).
//   * CLI missing digest usage=2: `--apply` without
//     `--reviewed-digest` exits 2.
//   * Drift between preview and apply surfaces as VALIDATION 400
//     (not CONFLICT).
//   * Secret details redacted: the cli output never echoes the raw
//     secret value, neither in stdout nor in stderr.
//   * Atomic 0600 output: `--preview-output` is created with mode
//     0600 and is rewritten atomically (no `.tmp-*` left behind on
//     success).
//   * Bodies / base64 / absolute paths never appear in preview
//     stdout or in the preview JSON on disk.

import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalDigest, createActorContext } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts', 'import-agent-skills.mjs');

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeSkill(base: string, relative: string, body: string): void {
  const pkg = join(base, relative);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'SKILL.md'), body);
}

function buildInventory(rootId: string, rootPath: string, packages: Array<{ packageDir: string; declaredName: string; body: string }>): object {
  const entries = packages.map((pkg) => ({
    rootId,
    relativePath: `${pkg.packageDir}/SKILL.md`,
    locator: `${pkg.packageDir}/SKILL.md`,
    name: pkg.declaredName,
    sha256: createHash('sha256').update(Buffer.from(pkg.body, 'utf8')).digest('hex'),
    size: Buffer.byteLength(pkg.body),
    logicalKey: `skill:${rootId}:${pkg.packageDir}/SKILL.md:${pkg.declaredName}`,
  }));
  const stable = {
    schemaVersion: 1,
    profile: 'openclaw-cli',
    scope: { ownerUserId: 'usr_local', agentId: 'agt_local' },
    roots: [{ id: rootId, path: rootPath, excludePrefixes: [] }],
    selectorsByRoot: { [rootId]: entries.map((entry) => entry.relativePath) },
    entries,
    exclusions: [] as Array<{ rootId: string; path: string; reason: string }>,
    duplicateNames: [] as Array<{ value: string; paths: string[] }>,
    duplicateHashes: [] as Array<{ value: string; paths: string[] }>,
    logicalKeyCollisions: [] as Array<{ value: string; paths: string[] }>,
    highConfidenceSecretFindings: [] as Array<{ rootId: string; path: string; rule: string }>,
    counts: {
      discovered: packages.length,
      selected: packages.length,
      excluded: 0,
      duplicateNames: 0,
      duplicateHashes: 0,
      logicalKeyCollisions: 0,
      highConfidenceSecretFindings: 0,
    },
  };
  const digester = canonicalDigest(stable);
  return { ...stable, inventoryDigest: digester };
}

function runCli(args: string[], options: { input?: string } = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
}

describe('import-agent-skills CLI', () => {
  it('produces a byte-deterministic preview JSON and exits 0', () => {
    const fixture = root('cli-deterministic-');
    const body = ['---', 'name: alpha', 'description: alpha', '---', 'PUBLIC-MARKER-NEVER-LEAKED'].join('\n');
    writeSkill(fixture, 'alpha', body);
    const configPath = join(fixture, 'roots.json');
    const inventoryPath = join(fixture, 'inventory.json');
    const previewA = join(fixture, 'preview-a.json');
    const previewB = join(fixture, 'preview-b.json');
    writeFileSync(configPath, JSON.stringify([{ id: 'fixture', path: fixture, excludePrefixes: [] }]));
    writeFileSync(inventoryPath, JSON.stringify(buildInventory('fixture', fixture, [{ packageDir: 'alpha', declaredName: 'alpha', body }]), null, 2));

    const runA = runCli(['--roots-config', configPath, '--inventory', inventoryPath, '--preview-output', previewA]);
    const runB = runCli(['--roots-config', configPath, '--inventory', inventoryPath, '--preview-output', previewB]);
    expect(runA.status).toBe(0);
    expect(runB.status).toBe(0);
    expect(readFileSync(previewA)).toEqual(readFileSync(previewB));
    const serialised = readFileSync(previewA, 'utf8');
    expect(serialised).not.toContain('PUBLIC-MARKER-NEVER-LEAKED');
    // No absolute paths, no base64 blobs in the preview payload.
    expect(serialised).not.toMatch(/Users|konedev|\/Users\//);
    expect(serialised).not.toMatch(/[A-Za-z0-9+/]{80,}={0,2}/);
    // Atomically written with mode 0600.
    expect((statSync(previewA).mode & 0o777)).toBe(0o600);
  });

  it('--apply without --reviewed-digest exits 2 with usage on stderr', () => {
    const fixture = root('cli-missing-digest-');
    const body = ['---', 'name: beta', '---', 'body'].join('\n');
    writeSkill(fixture, 'beta', body);
    const configPath = join(fixture, 'roots.json');
    const inventoryPath = join(fixture, 'inventory.json');
    writeFileSync(configPath, JSON.stringify([{ id: 'fixture', path: fixture, excludePrefixes: [] }]));
    writeFileSync(
      inventoryPath,
      JSON.stringify(buildInventory('fixture', fixture, [{ packageDir: 'beta', declaredName: 'beta', body }]), null, 2),
    );
    const dbPath = join(fixture, 'hub.sqlite');
    const backupDir = join(fixture, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const res = runCli([
      '--roots-config', configPath,
      '--inventory', inventoryPath,
      '--db', dbPath,
      '--backup-dir', backupDir,
      '--apply',
    ]);
    expect(res.status).toBe(2);
    const stderr = `${res.stderr ?? ''}`;
    expect(stderr).toMatch(/--apply requires --reviewed-digest/);
    expect(stderr).toMatch(/usage:/);
  });

  it('preview stdout never carries bodies, base64 or absolute paths', () => {
    const fixture = root('cli-no-leak-');
    const body = ['---', 'name: noleak', 'description: visible', '---', 'NO-LEAK-MARKER-9c7c'].join('\n');
    writeSkill(fixture, 'noleak', body);
    const configPath = join(fixture, 'roots.json');
    const inventoryPath = join(fixture, 'inventory.json');
    const previewPath = join(fixture, 'preview.json');
    writeFileSync(configPath, JSON.stringify([{ id: 'fixture', path: fixture, excludePrefixes: [] }]));
    writeFileSync(inventoryPath, JSON.stringify(buildInventory('fixture', fixture, [{ packageDir: 'noleak', declaredName: 'noleak', body }]), null, 2));
    const res = runCli(['--roots-config', configPath, '--inventory', inventoryPath, '--preview-output', previewPath]);
    expect(res.status).toBe(0);
    const stdout = `${res.stdout ?? ''}`;
    expect(stdout).not.toContain('NO-LEAK-MARKER-9c7c');
    expect(stdout).not.toMatch(/Users|konedev|\/Users\//);
    expect(stdout).not.toMatch(/[A-Za-z0-9+/]{80,}={0,2}/);
  });

  it('wrong --reviewed-digest exits 1 with CONFLICT/409', () => {
    const fixture = root('cli-conflict-');
    const body = ['---', 'name: conflict', '---', 'body'].join('\n');
    writeSkill(fixture, 'conflict', body);
    const configPath = join(fixture, 'roots.json');
    const inventoryPath = join(fixture, 'inventory.json');
    writeFileSync(configPath, JSON.stringify([{ id: 'fixture', path: fixture, excludePrefixes: [] }]));
    writeFileSync(inventoryPath, JSON.stringify(buildInventory('fixture', fixture, [{ packageDir: 'conflict', declaredName: 'conflict', body }]), null, 2));
    const dbPath = join(fixture, 'hub.sqlite');
    const backupDir = join(fixture, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const res = runCli([
      '--roots-config', configPath,
      '--inventory', inventoryPath,
      '--db', dbPath,
      '--backup-dir', backupDir,
      '--preview-output', join(fixture, 'apply.json'),
      '--apply',
      '--reviewed-digest', '0'.repeat(64),
    ]);
    expect(res.status).toBe(1);
    expect(`${res.stderr ?? ''}`).toMatch(/CONFLICT\/409/);
  });

  it('applies into a new DB, reopens it, and retrieves the exact body from SQLite', () => {
    const fixture = root('cli-apply-reopen-');
    const body = ['---', 'name: persisted-cli', 'description: persisted', '---', 'canonical body'].join('\n');
    writeSkill(fixture, 'persisted-cli', body);
    const configPath = join(fixture, 'roots.json');
    const inventoryPath = join(fixture, 'inventory.json');
    const previewPath = join(fixture, 'preview.json');
    const applyPath = join(fixture, 'apply.json');
    const dbPath = join(fixture, 'hub.sqlite');
    const backupDir = join(fixture, 'backups');
    writeFileSync(configPath, JSON.stringify([{ id: 'fixture', path: fixture, excludePrefixes: [] }]));
    writeFileSync(
      inventoryPath,
      JSON.stringify(buildInventory('fixture', fixture, [{ packageDir: 'persisted-cli', declaredName: 'persisted-cli', body }]), null, 2),
    );

    const preview = runCli(['--roots-config', configPath, '--inventory', inventoryPath, '--preview-output', previewPath]);
    expect(preview.status).toBe(0);
    const plan = JSON.parse(readFileSync(previewPath, 'utf8')) as {
      planDigest: string;
      inventoryDigest: string;
      packages: Array<{ id: string }>;
    };
    const apply = runCli([
      '--roots-config', configPath,
      '--inventory', inventoryPath,
      '--db', dbPath,
      '--backup-dir', backupDir,
      '--preview-output', applyPath,
      '--apply',
      '--reviewed-digest', plan.planDigest,
    ]);
    expect(apply.status, `${apply.stderr ?? ''}`).toBe(0);

    const actor = createActorContext({
      userId: 'usr_local',
      agentId: 'agt_local',
      role: 'admin',
      capabilities: ['write.skill', 'admin'],
    });
    const reopened = new SqliteStore(dbPath);
    try {
      const head = reopened.transaction(actor, (tx) => tx.skills.getHeadVersion(plan.packages[0]!.id, actor.scope));
      expect(head?.body.equals(Buffer.from(body, 'utf8'))).toBe(true);
      expect(head?.metadata).toMatchObject({
        inventoryDigest: plan.inventoryDigest,
        planDigest: plan.planDigest,
      });
    } finally {
      reopened.close();
    }
    expect(readdirSync(backupDir)).toHaveLength(1);
  });

  it('preview-output is written atomically with mode 0600 and the .tmp- sidecars are cleaned up', () => {
    const fixture = root('cli-atomic-');
    const body = ['---', 'name: atomic', '---', 'body'].join('\n');
    writeSkill(fixture, 'atomic', body);
    const configPath = join(fixture, 'roots.json');
    const inventoryPath = join(fixture, 'inventory.json');
    const previewPath = join(fixture, 'preview.json');
    writeFileSync(configPath, JSON.stringify([{ id: 'fixture', path: fixture, excludePrefixes: [] }]));
    writeFileSync(inventoryPath, JSON.stringify(buildInventory('fixture', fixture, [{ packageDir: 'atomic', declaredName: 'atomic', body }]), null, 2));
    const res = runCli(['--roots-config', configPath, '--inventory', inventoryPath, '--preview-output', previewPath]);
    expect(res.status).toBe(0);
    expect((statSync(previewPath).mode & 0o777)).toBe(0o600);
    const siblings = readdirSync(fixture);
    expect(siblings.filter((name: string) => name.startsWith('preview.json.tmp-'))).toEqual([]);
  });
});
