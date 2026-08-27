// tests/importer/skill-pack.test.ts
//
// TDD slice for Phase 2 skill pack importer + apply coordinator.
//
// Split:
//
//   * `SkillPackImporter` lives in `@portable-agent-asset-hub/storage-files`.
//     It exposes `scan(input)` returning `{ plan, bodies }`.
//   * `SkillPackApplyCoordinator` lives in
//     `@portable-agent-asset-hub/storage-sqlite`. It exposes:
//       - `preview()`: fresh scan, returns the `plan` only.
//       - `apply(reviewedDigest)`: fresh scan, validates digest
//         against `plan.planDigest`, validates scope/actor match,
//         then backups the SQLite DB, then BEGIN IMMEDIATE /
//         COMMITs each write. Force-failures mid-transaction
//         trigger a ROLLBACK so no partial state escapes.
//
// Normative contracts exercised below:
//
//   * Determinism: two scans over the same inputs are byte-identical
//     (no timestamps, POSIX byte-order comparator).
//   * Package complete: every regular file under the SKILL.md's
//     directory is included; the SKILL.md itself, symlinks, traversal,
//     special files and ambiguous nested SKILL.md files are rejected.
//   * Stable IDs: logicalKey + skill id derive from the declared
//     name (NOT the path), independent of roots / runtime paths.
//   * Bytes preservation: bodies, executable bits, MIME types and
//     binary resources survive byte-for-byte round-trip via the DB.
//   * Secret scan: high-confidence findings surface only as
//     rootId + path + rule (never the value), accessible through
//     `HubError.details.findings`.
//   * Drift handling: when the inventory's hash/size no longer
//     matches the on-disk source, the scan fails closed.
//   * Digest required: `apply` without `reviewedDigest` returns
//     HubError VALIDATION 400. A wrong digest returns CONFLICT 409.
//     A stale preview (mutated source after preview) returns
//     VALIDATION 400 drift.
//   * Backup integrity: a fresh backup file is produced after the
//     digest comparison and before the BEGIN IMMEDIATE. The backup
//     is a valid SQLite DB.
//   * Idempotency: applying the same digest twice does not advance
//     the version and reports `changed: false` for the no-op.
//   * v2 creation: changing the body creates v2 via CAS, preserving
//     v1 bytes. Outcomes reflect the second version with
//     `changed: true`.
//   * Reopen + roundtrip: closing the store and reopening it yields
//     byte-identical bodies and resource bytes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  canonicalDigest,
  createActorContext,
  deriveLogicalKey,
  deriveSkillId,
  HubError,
  normalizeName,
  type ActorContext,
  type Scope,
  type SkillInventoryV1,
  type SkillPackApplyOutcome,
  type SkillSecretFinding,
} from '@portable-agent-asset-hub/core';
import {
  SkillPackApplyCoordinator,
  SqliteStore,
} from '@portable-agent-asset-hub/storage-sqlite';
import {
  SkillPackImporter,
  readInventory,
  readRootsConfig,
} from '@portable-agent-asset-hub/storage-files';
import { SkillExportCoordinator } from '@portable-agent-asset-hub/skill-export';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function freshDb(): string {
  const dir = tempRoot('s2-pack-db-');
  return join(dir, 'agent-memory.sqlite');
}

function writeSkill(
  rootDir: string,
  packageDir: string,
  body: string,
  extra: {
    bin?: { name: string; content: Buffer; mode: 0o644 | 0o755 };
    docs?: Array<{ name: string; content: Buffer }>;
  } = {},
): void {
  const dir = join(rootDir, packageDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
  if (extra.bin) {
    const binPath = join(dir, extra.bin.name);
    mkdirSync(join(binPath, '..'), { recursive: true });
    writeFileSync(binPath, extra.bin.content);
    chmodSync(binPath, extra.bin.mode);
  }
  if (extra.docs) {
    for (const file of extra.docs) {
      const filePath = join(dir, file.name);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, file.content);
    }
  }
}

interface InventoryFixture {
  rootsConfigPath: string;
  inventoryPath: string;
  inventory: SkillInventoryV1;
}

function buildInventory(
  rootId: string,
  rootPath: string,
  packages: Array<{ packageDir: string; declaredName: string; sha256: string; size: number }>,
): InventoryFixture {
  const entries = packages.map((pkg) => ({
    rootId,
    relativePath: `${pkg.packageDir}/SKILL.md`,
    locator: `${pkg.packageDir}/SKILL.md`,
    name: pkg.declaredName,
    sha256: pkg.sha256,
    size: pkg.size,
    logicalKey: `skill:${rootId}:${pkg.packageDir}/SKILL.md:${pkg.declaredName}`,
  }));
  const stable = {
    schemaVersion: 1,
    profile: 'test-profile',
    scope: { ownerUserId: 'usr_local', agentId: 'agt_local' } satisfies Scope,
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
  const inventoryDigest = canonicalDigest(stable);
  const fixtureRoot = tempRoot('s2-pack-inv-');
  const rootsConfigPath = join(fixtureRoot, 'roots.json');
  const inventoryPath = join(fixtureRoot, 'inventory.json');
  writeFileSync(rootsConfigPath, JSON.stringify([{ id: rootId, path: rootPath, excludePrefixes: [] }]));
  const inventory = { ...stable, inventoryDigest };
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  return { rootsConfigPath, inventoryPath, inventory };
}

function actor(userId = 'usr_local', agentId = 'agt_local'): ActorContext {
  return createActorContext({
    userId,
    agentId,
    role: 'admin',
    capabilities: ['write.skill', 'admin'],
  });
}

function scope(actor: ActorContext): Scope {
  return {
    ownerUserId: actor.userId as Scope['ownerUserId'],
    agentId: actor.agentId as Scope['agentId'],
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('SkillPackImporter (pure scan, storage-files)', () => {
  let rootDir: string;
  let importer: SkillPackImporter;

  beforeEach(() => {
    rootDir = tempRoot('s2-pack-roots-');
    importer = new SkillPackImporter();
  });

  it('produces a byte-identical plan when scanned twice over the same inputs (no timestamps)', () => {
    const body = Buffer.from('---\nname: alpha\ndescription: alpha desc\n---\nalpha body\n', 'utf8');
    writeSkill(rootDir, 'alpha', body.toString('utf8'), {
      bin: { name: 'run.sh', content: Buffer.from('#!/bin/sh\necho alpha\n', 'utf8'), mode: 0o755 },
      docs: [{ name: 'README.md', content: Buffer.from('# alpha\n', 'utf8') }],
    });
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'alpha', declaredName: 'alpha', sha256: sha256(body), size: body.byteLength },
    ]);

    const first = importer.scan({
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
    });
    const second = importer.scan({
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
    });
    expect(JSON.stringify(first.plan)).toBe(JSON.stringify(second.plan));
    expect(first.plan.planDigest).toBe(second.plan.planDigest);
    expect(first.plan.inventoryDigest).toBe(fixture.inventory.inventoryDigest);
    expect(first.plan.counts.packages).toBe(1);
    expect(first.plan.packages[0]?.resources).toHaveLength(2);
    expect((first.plan as unknown as { generatedAt?: string }).generatedAt).toBeUndefined();
  });

  it('orders resources in POSIX byte-order (README.md before docs/note.md, ASCII-before-slash)', () => {
    const body = Buffer.from('---\nname: beta\ndescription: beta\n---\nbeta body\n', 'utf8');
    writeSkill(rootDir, 'beta', body.toString('utf8'), {
      bin: { name: 'scripts/run.sh', content: Buffer.from('#!/bin/sh\necho beta\n', 'utf8'), mode: 0o755 },
      docs: [
        { name: 'README.md', content: Buffer.from('# beta\n', 'utf8') },
        { name: 'docs/note.md', content: Buffer.from('# note\n', 'utf8') },
      ],
    });
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'beta', declaredName: 'beta', sha256: sha256(body), size: body.byteLength },
    ]);

    const { plan } = importer.scan({
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
    });
    const pkg = plan.packages[0]!;
    expect(pkg.bodySha256).toBe(sha256(body));
    expect(pkg.bodySize).toBe(body.byteLength);
    expect(pkg.resources.map((r) => r.relativePath)).toEqual(['README.md', 'docs/note.md', 'scripts/run.sh']);
    const bin = pkg.resources.find((r) => r.relativePath === 'scripts/run.sh')!;
    expect(bin.mode).toBe(0o755);
    expect(bin.size).toBe(Buffer.from('#!/bin/sh\necho beta\n', 'utf8').byteLength);
    expect(bin.sha256).toBe(sha256(Buffer.from('#!/bin/sh\necho beta\n', 'utf8')));
    expect(bin.mime).toMatch(/^text\//);
  });

  it('roundtrips binary resources byte-for-byte', () => {
    const body = Buffer.from('---\nname: gamma\ndescription: binary roundtrip\n---\ngamma body\n', 'utf8');
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80, 0x90, 0xa0, 0xb0]);
    writeSkill(rootDir, 'gamma', body.toString('utf8'), {
      docs: [{ name: 'assets/blob.bin', content: binary }],
    });
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'gamma', declaredName: 'gamma', sha256: sha256(body), size: body.byteLength },
    ]);

    const { plan } = importer.scan({
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
    });
    const blob = plan.packages[0]!.resources.find((r) => r.relativePath === 'assets/blob.bin')!;
    expect(blob.size).toBe(binary.byteLength);
    expect(blob.sha256).toBe(sha256(binary));
    expect(blob.mime).toBe('application/octet-stream');
  });

  it('derives stable logicalKey + id across two roots hosting the same declared name', () => {
    const rootA = tempRoot('s2-pack-root-a-');
    const rootB = tempRoot('s2-pack-root-b-');
    const body = Buffer.from('---\nname: shared\ndescription: shared name\n---\nshared body\n', 'utf8');
    writeSkill(rootA, 'shared', body.toString('utf8'));
    writeSkill(rootB, 'shared', body.toString('utf8'));
    const fixtureRoot = tempRoot('s2-pack-stable-roots-');
    const rootsConfigPath = join(fixtureRoot, 'roots.json');
    const inventoryPath = join(fixtureRoot, 'inventory.json');
    writeFileSync(
      rootsConfigPath,
      JSON.stringify([
        { id: 'root-a', path: rootA, excludePrefixes: [] },
        { id: 'root-b', path: rootB, excludePrefixes: [] },
      ]),
    );
    const stable = {
      schemaVersion: 1,
      profile: 'test',
      scope: { ownerUserId: 'usr_local', agentId: 'agt_local' } satisfies Scope,
      roots: [
        { id: 'root-a', path: rootA, excludePrefixes: [] },
        { id: 'root-b', path: rootB, excludePrefixes: [] },
      ],
      selectorsByRoot: {
        'root-a': ['shared/SKILL.md'],
        'root-b': ['shared/SKILL.md'],
      },
      entries: [
        { rootId: 'root-a', relativePath: 'shared/SKILL.md', locator: 'shared/SKILL.md', name: 'shared', sha256: sha256(body), size: body.byteLength, logicalKey: 'skill:root-a:shared/SKILL.md:shared' },
        { rootId: 'root-b', relativePath: 'shared/SKILL.md', locator: 'shared/SKILL.md', name: 'shared', sha256: sha256(body), size: body.byteLength, logicalKey: 'skill:root-b:shared/SKILL.md:shared' },
      ],
      exclusions: [] as Array<{ rootId: string; path: string; reason: string }>,
      duplicateNames: [] as Array<{ value: string; paths: string[] }>,
      duplicateHashes: [{ value: sha256(body), paths: ['root-a:shared/SKILL.md', 'root-b:shared/SKILL.md'] }] as Array<{ value: string; paths: string[] }>,
      logicalKeyCollisions: [] as Array<{ value: string; paths: string[] }>,
      highConfidenceSecretFindings: [] as Array<{ rootId: string; path: string; rule: string }>,
      counts: { discovered: 2, selected: 2, excluded: 0, duplicateNames: 0, duplicateHashes: 1, logicalKeyCollisions: 0, highConfidenceSecretFindings: 0 },
    };
    writeFileSync(inventoryPath, `${JSON.stringify({ ...stable, inventoryDigest: canonicalDigest(stable) }, null, 2)}\n`);

    const { plan } = importer.scan({ rootsConfigPath, inventoryPath });
    expect(plan.counts.packages).toBe(1);
    expect(plan.packages[0]!.logicalKey).toBe(deriveLogicalKey('shared'));
    expect(plan.packages[0]!.id).toBe(deriveSkillId('shared'));
    expect(plan.packages[0]!.sources).toHaveLength(2);
    expect(plan.packages[0]!.sources.map((s) => s.rootId).sort()).toEqual(['root-a', 'root-b']);
  });

  it('rejects when the inventory contains a duplicate-name collision declared fail-closed', () => {
    const rootA = tempRoot('s2-pack-coll-a-');
    const rootB = tempRoot('s2-pack-coll-b-');
    const body = Buffer.from('---\nname: collide\n---\nbody\n', 'utf8');
    writeSkill(rootA, 'a', body.toString('utf8'));
    writeSkill(rootB, 'b', body.toString('utf8'));
    const fixtureRoot = tempRoot('s2-pack-coll-');
    const rootsConfigPath = join(fixtureRoot, 'roots.json');
    const inventoryPath = join(fixtureRoot, 'inventory.json');
    writeFileSync(
      rootsConfigPath,
      JSON.stringify([
        { id: 'root-a', path: rootA, excludePrefixes: [] },
        { id: 'root-b', path: rootB, excludePrefixes: [] },
      ]),
    );
    const stable = {
      schemaVersion: 1,
      profile: 'test',
      scope: { ownerUserId: 'usr_local', agentId: 'agt_local' } satisfies Scope,
      roots: [
        { id: 'root-a', path: rootA, excludePrefixes: [] },
        { id: 'root-b', path: rootB, excludePrefixes: [] },
      ],
      selectorsByRoot: { 'root-a': ['a/SKILL.md'], 'root-b': ['b/SKILL.md'] },
      entries: [
        { rootId: 'root-a', relativePath: 'a/SKILL.md', locator: 'a/SKILL.md', name: 'collide', sha256: sha256(body), size: body.byteLength, logicalKey: 'skill:root-a:a/SKILL.md:collide' },
        { rootId: 'root-b', relativePath: 'b/SKILL.md', locator: 'b/SKILL.md', name: 'collide', sha256: sha256(body), size: body.byteLength, logicalKey: 'skill:root-b:b/SKILL.md:collide' },
      ],
      exclusions: [] as Array<{ rootId: string; path: string; reason: string }>,
      duplicateNames: [{ value: 'collide', paths: ['root-a:a/SKILL.md', 'root-b:b/SKILL.md'] }] as Array<{ value: string; paths: string[] }>,
      duplicateHashes: [] as Array<{ value: string; paths: string[] }>,
      logicalKeyCollisions: [] as Array<{ value: string; paths: string[] }>,
      highConfidenceSecretFindings: [] as Array<{ rootId: string; path: string; rule: string }>,
      counts: { discovered: 2, selected: 2, excluded: 0, duplicateNames: 1, duplicateHashes: 0, logicalKeyCollisions: 0, highConfidenceSecretFindings: 0 },
    };
    writeFileSync(inventoryPath, `${JSON.stringify({ ...stable, inventoryDigest: canonicalDigest(stable) }, null, 2)}\n`);

    expect(() => importer.scan({ rootsConfigPath, inventoryPath })).toThrow(/duplicate.*name|collision/i);
  });

  it('rejects symlinks and special files inside the skill package', () => {
    const body = Buffer.from('---\nname: link\n---\nlink\n', 'utf8');
    writeSkill(rootDir, 'link', body.toString('utf8'));
    const outside = tempRoot('s2-pack-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'external');
    symlinkSync(join(outside, 'secret.txt'), join(rootDir, 'link', 'secret.lnk'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'link', declaredName: 'link', sha256: sha256(body), size: body.byteLength },
    ]);
    expect(() => importer.scan({
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
    })).toThrow(/symlink/i);
  });

  it('rejects ambiguous nested SKILL.md files', () => {
    const body = Buffer.from('---\nname: nest\n---\nbody\n', 'utf8');
    writeSkill(rootDir, 'nest', body.toString('utf8'));
    mkdirSync(join(rootDir, 'nest', 'sub'), { recursive: true });
    writeFileSync(join(rootDir, 'nest', 'sub', 'SKILL.md'), '---\nname: inner\n---\ninner\n');
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'nest', declaredName: 'nest', sha256: sha256(body), size: body.byteLength },
    ]);
    expect(() => importer.scan({
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
    })).toThrow(/nested.*SKILL\.md|ambiguous/i);
  });

  it('reports only rootId + path + rule for any secret hit (never the value) and reads through HubError.details.findings', () => {
    const secret = 'Ab9zY7xW6vU5tS4rQ3pN2mK1jH8gF0dC';
    const body = Buffer.from(['---', 'name: secret', '---', `api_key=${secret}`].join('\n'), 'utf8');
    writeSkill(rootDir, 'secret', body.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'secret', declaredName: 'secret', sha256: sha256(body), size: body.byteLength },
    ]);

    const captured: SkillSecretFinding[] = (() => {
      try {
        importer.scan({
          rootsConfigPath: fixture.rootsConfigPath,
          inventoryPath: fixture.inventoryPath,
        });
        throw new Error('scan should have failed');
      } catch (error) {
        const err = error as HubError;
        const details = err.details as { findings?: SkillSecretFinding[] } | undefined;
        return details?.findings ?? [];
      }
    })();
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toMatchObject({
      rootId: 'docs',
      path: 'secret/SKILL.md',
      rule: expect.stringMatching(/high-entropy|secret/i),
    });
    expect(JSON.stringify(captured)).not.toContain(secret);
    expect(JSON.stringify(captured)).not.toContain('api_key=Ab9zY7');
  });

  it('rejects when inventory drift (sha/size) does not match on-disk source', () => {
    const body = Buffer.from('---\nname: drift\n---\nbody\n', 'utf8');
    writeSkill(rootDir, 'drift', body.toString('utf8'));
    const fixtureRoot = tempRoot('s2-pack-drift-');
    const rootsConfigPath = join(fixtureRoot, 'roots.json');
    const inventoryPath = join(fixtureRoot, 'inventory.json');
    writeFileSync(rootsConfigPath, JSON.stringify([{ id: 'docs', path: rootDir, excludePrefixes: [] }]));
    const stable = {
      schemaVersion: 1,
      profile: 'test',
      scope: { ownerUserId: 'usr_local', agentId: 'agt_local' } satisfies Scope,
      roots: [{ id: 'docs', path: rootDir, excludePrefixes: [] }],
      selectorsByRoot: { docs: ['drift/SKILL.md'] },
      entries: [{ rootId: 'docs', relativePath: 'drift/SKILL.md', locator: 'drift/SKILL.md', name: 'drift', sha256: '0'.repeat(64), size: 9999, logicalKey: 'skill:docs:drift/SKILL.md:drift' }],
      exclusions: [] as Array<{ rootId: string; path: string; reason: string }>,
      duplicateNames: [] as Array<{ value: string; paths: string[] }>,
      duplicateHashes: [] as Array<{ value: string; paths: string[] }>,
      logicalKeyCollisions: [] as Array<{ value: string; paths: string[] }>,
      highConfidenceSecretFindings: [] as Array<{ rootId: string; path: string; rule: string }>,
      counts: { discovered: 1, selected: 1, excluded: 0, duplicateNames: 0, duplicateHashes: 0, logicalKeyCollisions: 0, highConfidenceSecretFindings: 0 },
    };
    writeFileSync(inventoryPath, `${JSON.stringify({ ...stable, inventoryDigest: canonicalDigest(stable) }, null, 2)}\n`);
    expect(() => importer.scan({ rootsConfigPath, inventoryPath })).toThrow(/drift/i);
  });

  it('rejects a tampered inventory whose canonical digest no longer matches', () => {
    const body = Buffer.from('---\nname: tampered\n---\nbody\n', 'utf8');
    writeSkill(rootDir, 'tampered', body.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'tampered', declaredName: 'tampered', sha256: sha256(body), size: body.byteLength },
    ]);
    const forged = JSON.parse(readFileSync(fixture.inventoryPath, 'utf8')) as Record<string, unknown>;
    forged.profile = 'forged-profile';
    writeFileSync(fixture.inventoryPath, JSON.stringify(forged));
    expect(() => importer.scan({
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
    })).toThrow(/inventoryDigest mismatch/i);
  });

  it('rejects a package whose body plus resources exceeds 16 MiB', () => {
    const body = Buffer.from('---\nname: oversized-pack\n---\nbody\n', 'utf8');
    const fourMiB = Buffer.alloc(4 * 1024 * 1024, 0x41);
    writeSkill(rootDir, 'oversized-pack', body.toString('utf8'), {
      docs: [
        { name: 'a.bin', content: fourMiB },
        { name: 'b.bin', content: fourMiB },
        { name: 'c.bin', content: fourMiB },
        { name: 'd.bin', content: fourMiB },
      ],
    });
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'oversized-pack', declaredName: 'oversized-pack', sha256: sha256(body), size: body.byteLength },
    ]);
    expect(() => importer.scan({
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
    })).toThrow(/exceeds 16 MiB/i);
  });

  it('excludes governed segments (node_modules, .git, cache, backups)', () => {
    const body = Buffer.from('---\nname: clean\n---\nbody\n', 'utf8');
    writeSkill(rootDir, 'clean', body.toString('utf8'));
    for (const segment of ['node_modules', '.git', 'cache', 'backups']) {
      mkdirSync(join(rootDir, 'clean', segment), { recursive: true });
      writeFileSync(join(rootDir, 'clean', segment, 'should-not-be-imported.md'), `inside ${segment}`);
    }
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'clean', declaredName: 'clean', sha256: sha256(body), size: body.byteLength },
    ]);
    const { plan } = importer.scan({ rootsConfigPath: fixture.rootsConfigPath, inventoryPath: fixture.inventoryPath });
    const paths = plan.packages[0]!.resources.map((r) => r.relativePath);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
    expect(paths.some((p) => p.includes('cache'))).toBe(false);
    expect(paths.some((p) => p.includes('backups'))).toBe(false);
  });

  it('exposes an inventoryDigest / scope / profile reading helper', () => {
    const body = Buffer.from('---\nname: hello\n---\nbody\n', 'utf8');
    writeSkill(rootDir, 'hello', body.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'hello', declaredName: 'hello', sha256: sha256(body), size: body.byteLength },
    ]);
    const inventory = readInventory(fixture.inventoryPath);
    expect(inventory.profile).toBe('test-profile');
    expect(inventory.scope.ownerUserId).toBe('usr_local');
    const roots = readRootsConfig(fixture.rootsConfigPath);
    expect(roots[0]!.id).toBe('docs');
  });

  it('returns binary resource bytes byte-for-byte through the bodies map', () => {
    const body = Buffer.from('---\nname: hex\n---\nbody\n', 'utf8');
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80, 0x90, 0xa0, 0xb0]);
    writeSkill(rootDir, 'hex', body.toString('utf8'), {
      docs: [{ name: 'bin/blob.bin', content: binary }],
    });
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'hex', declaredName: 'hex', sha256: sha256(body), size: body.byteLength },
    ]);
    const { plan, bodies } = importer.scan({ rootsConfigPath: fixture.rootsConfigPath, inventoryPath: fixture.inventoryPath });
    const id = plan.packages[0]!.id;
    const collected = bodies.get(id)!;
    expect(collected.body.equals(body)).toBe(true);
    const resource = collected.resources.find((r) => r.relativePath === 'bin/blob.bin')!;
    expect(resource.bytes.equals(binary)).toBe(true);
    expect(resource.bytes).not.toContain('base64-not-allowed');
  });
});

describe('SkillPackApplyCoordinator (storage-sqlite, real DB + temp roots)', () => {
  let rootDir: string;
  let dbPath: string;

  beforeEach(() => {
    rootDir = tempRoot('s2-apply-roots-');
    dbPath = freshDb();
  });

  it('apply without reviewedDigest fails closed with VALIDATION 400', async () => {
    const body = Buffer.from('---\nname: nodigest\n---\nbody\n', 'utf8');
    writeSkill(rootDir, 'nodigest', body.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'nodigest', declaredName: 'nodigest', sha256: sha256(body), size: body.byteLength },
    ]);
    const backupDir = mkdtempSync(join(tmpdir(), 's2-apply-nodigest-'));
    tempRoots.push(backupDir);
    const coord = new SkillPackApplyCoordinator({
      dbPath,
      backupDir,
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
      actor: actor(),
    });
    // The type-system enforces the required param — we use a typed
    // any-cast in the test to verify the runtime guard as well, since
    // this is the canonical guard for callers that come in via JS.
    const apply = coord.apply as unknown as (digest?: unknown) => Promise<unknown>;
    await expect(apply(undefined)).rejects.toThrowError(
      expect.objectContaining({ code: 'VALIDATION', status: 400 }),
    );
  });

  it('apply with a digest mismatch fails closed (CONFLICT)', async () => {
    const body = Buffer.from('---\nname: dig\n---\nbody\n', 'utf8');
    writeSkill(rootDir, 'dig', body.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'dig', declaredName: 'dig', sha256: sha256(body), size: body.byteLength },
    ]);
    const backupDir = mkdtempSync(join(tmpdir(), 's2-apply-dig-'));
    tempRoots.push(backupDir);
    const coord = new SkillPackApplyCoordinator({
      dbPath,
      backupDir,
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
      actor: actor(),
    });
    await expect(coord.apply('0'.repeat(64))).rejects.toThrowError(
      expect.objectContaining({ code: 'CONFLICT', status: 409 }),
    );
  });

  it('apply is all-or-nothing on a 2-skill fixture: forced failure on second write rolls back the first', async () => {
    const bodyA = Buffer.from('---\nname: alpha\n---\nA\n', 'utf8');
    const bodyB = Buffer.from('---\nname: bravo\n---\nB\n', 'utf8');
    writeSkill(rootDir, 'alpha', bodyA.toString('utf8'));
    writeSkill(rootDir, 'bravo', bodyB.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'alpha', declaredName: 'alpha', sha256: sha256(bodyA), size: bodyA.byteLength },
      { packageDir: 'bravo', declaredName: 'bravo', sha256: sha256(bodyB), size: bodyB.byteLength },
    ]);
    const backupDir = mkdtempSync(join(tmpdir(), 's2-apply-rollback-'));
    tempRoots.push(backupDir);
    const importer = new SkillPackImporter();
    const { plan } = importer.scan({ rootsConfigPath: fixture.rootsConfigPath, inventoryPath: fixture.inventoryPath });
    expect(plan.counts.packages).toBe(2);

    const coord = new SkillPackApplyCoordinator({
      dbPath,
      backupDir,
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
      actor: actor(),
      hooks: { failWriteSkillAt: 2 },
    });
    await expect(coord.apply(plan.planDigest)).rejects.toThrow(/forced/i);

    const reopened = new SqliteStore(dbPath);
    try {
      const rows = reopened.transaction(actor(), (tx) => tx.skills.skillSearch(scope(actor()), 'alpha'));
      expect(rows).toHaveLength(0);
      const rowsB = reopened.transaction(actor(), (tx) => tx.skills.skillSearch(scope(actor()), 'bravo'));
      expect(rowsB).toHaveLength(0);
      // Also assert raw absence: no skill_entries rows for either id.
      const Database = await import('node:sqlite') as typeof import('node:sqlite');
      const probe = new Database.DatabaseSync(dbPath);
      try {
        const rowCount = probe.prepare("SELECT COUNT(*) AS c FROM skill_entries").get() as { c: number };
        expect(Number(rowCount.c)).toBe(0);
      } finally {
        probe.close();
      }
    } finally {
      reopened.close();
    }
  });

  it('apply produces a fresh backup before BEGIN; backup is itself a readable SQLite DB', async () => {
    const body = Buffer.from('---\nname: bk\n---\nbody\n', 'utf8');
    writeSkill(rootDir, 'bk', body.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'bk', declaredName: 'bk', sha256: sha256(body), size: body.byteLength },
    ]);
    const backupDir = mkdtempSync(join(tmpdir(), 's2-apply-backup-'));
    tempRoots.push(backupDir);
    const importer = new SkillPackImporter();
    const { plan } = importer.scan({
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
    });
    const coord = new SkillPackApplyCoordinator({
      dbPath,
      backupDir,
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
      actor: actor(),
    });
    const result = await coord.apply(plan.planDigest);
    expect(result.backup.path).toContain(backupDir);
    expect(result.backup.sha256).toMatch(/^[0-9a-f]{64}$/);

    const Database = await import('node:sqlite') as typeof import('node:sqlite');
    const probe = new Database.DatabaseSync(result.backup.path);
    try {
      // The backup is the PRE-apply snapshot. If the source DB file
      // has not been opened yet, the backup is just a valid SQLite
      // file with the header — no tables present. The invariants we
      // pin are: the file opens without error, sits under
      // `backupDir`, exposes the SQLite magic string, has a non-zero
      // size, and `result.backup.sha256` matches an independent
      // re-hash of the file's bytes.
      // Use top-level named imports for `node:fs` + `node:crypto`. The
      // open/read sequence below is the same primitives every other
      // test in the suite uses for byte-level inspection.
      expect(statSync(result.backup.path).size).toBeGreaterThan(0);
      const fd = openSync(result.backup.path, 0);
      try {
        const head = Buffer.alloc(16);
        readSync(fd, head, 0, 16, 0);
        expect(head.toString('utf8')).toBe('SQLite format 3\u0000');
      } finally {
        closeSync(fd);
      }
      // Independent SHA-256 re-hash so the test pins the contract
      // that the returned digest really matches the file on disk.
      const bytes = readFileSync(result.backup.path);
      const recomputed = createHash('sha256').update(bytes).digest('hex');
      expect(recomputed).toBe(result.backup.sha256);
    } finally {
      probe.close();
    }
  });

  it('idempotent reapply: same digest → outcomes[0].changed=false (no-op)', async () => {
    const body = Buffer.from('---\nname: idem\n---\nbody\n', 'utf8');
    writeSkill(rootDir, 'idem', body.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'idem', declaredName: 'idem', sha256: sha256(body), size: body.byteLength },
    ]);
    const backupDir = mkdtempSync(join(tmpdir(), 's2-apply-idem-'));
    tempRoots.push(backupDir);
    const importer = new SkillPackImporter();
    const { plan } = importer.scan({ rootsConfigPath: fixture.rootsConfigPath, inventoryPath: fixture.inventoryPath });
    const coord = new SkillPackApplyCoordinator({
      dbPath,
      backupDir,
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
      actor: actor(),
    });
    const first = await coord.apply(plan.planDigest);
    expect(first.outcomes[0]!.version).toBe(1);
    expect(first.outcomes[0]!.changed).toBe(true);
    const second = await coord.apply(plan.planDigest);
    expect(second.outcomes[0]!.version).toBe(1);
    expect(second.outcomes[0]!.changed).toBe(false);

    const store = new SqliteStore(dbPath);
    try {
      const head = store.transaction(actor(), (tx) => tx.skills.getHeadVersion(plan.packages[0]!.id, scope(actor())));
      expect(head).toBeDefined();
      expect(head!.version).toBe(1);
      expect(head!.body.equals(body)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('creates v2 (CAS) when the body changes; outcome.version=2 and v1 bytes preserved', async () => {
    const body1 = Buffer.from('---\nname: cas\n---\nfirst\n', 'utf8');
    writeSkill(rootDir, 'cas', body1.toString('utf8'));
    const fixture1 = buildInventory('docs', rootDir, [
      { packageDir: 'cas', declaredName: 'cas', sha256: sha256(body1), size: body1.byteLength },
    ]);
    const backupDir = mkdtempSync(join(tmpdir(), 's2-apply-cas-'));
    tempRoots.push(backupDir);
    const importer = new SkillPackImporter();
    const { plan: plan1 } = importer.scan({ rootsConfigPath: fixture1.rootsConfigPath, inventoryPath: fixture1.inventoryPath });
    const coord = new SkillPackApplyCoordinator({
      dbPath,
      backupDir,
      rootsConfigPath: fixture1.rootsConfigPath,
      inventoryPath: fixture1.inventoryPath,
      actor: actor(),
    });
    const first = await coord.apply(plan1.planDigest);
    expect(first.outcomes[0]!.version).toBe(1);
    expect(first.outcomes[0]!.changed).toBe(true);

    const body2 = Buffer.from('---\nname: cas\n---\nsecond\n', 'utf8');
    writeFileSync(join(rootDir, 'cas', 'SKILL.md'), body2);
    const fixture2 = buildInventory('docs', rootDir, [
      { packageDir: 'cas', declaredName: 'cas', sha256: sha256(body2), size: body2.byteLength },
    ]);
    const { plan: plan2 } = importer.scan({ rootsConfigPath: fixture2.rootsConfigPath, inventoryPath: fixture2.inventoryPath });
    const coord2 = new SkillPackApplyCoordinator({
      dbPath,
      backupDir,
      rootsConfigPath: fixture2.rootsConfigPath,
      inventoryPath: fixture2.inventoryPath,
      actor: actor(),
    });
    const second = await coord2.apply(plan2.planDigest);
    expect(second.outcomes[0]!.version).toBe(2);
    expect(second.outcomes[0]!.changed).toBe(true);

    const store = new SqliteStore(dbPath);
    try {
      const v1 = store.transaction(actor(), (tx) => tx.skills.getVersion(plan1.packages[0]!.id, 1, scope(actor())));
      const v2 = store.transaction(actor(), (tx) => tx.skills.getVersion(plan1.packages[0]!.id, 2, scope(actor())));
      expect(v1!.body.equals(body1)).toBe(true);
      expect(v2!.body.equals(body2)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('reopens the DB and reads back the exact same body and resource bytes', async () => {
    const body = Buffer.from('---\nname: rt\ndescription: roundtrip\n---\nrt body\n', 'utf8');
    const bin = Buffer.from('#!/bin/sh\necho roundtrip\n', 'utf8');
    writeSkill(rootDir, 'rt', body.toString('utf8'), {
      bin: { name: 'run.sh', content: bin, mode: 0o755 },
    });
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'rt', declaredName: 'rt', sha256: sha256(body), size: body.byteLength },
    ]);
    const backupDir = mkdtempSync(join(tmpdir(), 's2-apply-rt-'));
    tempRoots.push(backupDir);
    const importer = new SkillPackImporter();
    const { plan } = importer.scan({ rootsConfigPath: fixture.rootsConfigPath, inventoryPath: fixture.inventoryPath });
    const coord = new SkillPackApplyCoordinator({
      dbPath,
      backupDir,
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
      actor: actor(),
    });
    const result = await coord.apply(plan.planDigest);
    expect(result.outcomes).toHaveLength(1);

    const reopened = new SqliteStore(dbPath);
    try {
      const head = reopened.transaction(actor(), (tx) => tx.skills.getHeadVersion(plan.packages[0]!.id, scope(actor())));
      expect(head!.body.equals(body)).toBe(true);
      const resources = reopened.transaction(actor(), (tx) => tx.skills.resourceList(plan.packages[0]!.id, scope(actor())));
      expect(resources.find((r) => r.relativePath === 'run.sh')!.sha256).toBe(sha256(bin));
      const fetched = reopened.transaction(actor(), (tx) => tx.skills.resourceRead(plan.packages[0]!.id, 'run.sh', scope(actor())));
      expect(fetched.bytes.equals(bin)).toBe(true);
      expect(fetched.mode).toBe(0o755);
    } finally {
      reopened.close();
    }
  });

  it('preview JSON contains counts, IDs, hashes/sizes but never bodies, base64 or absolute paths', () => {
    const body = Buffer.from('---\nname: redacted\n---\nPRIVATE-MARKER-NEVER-LEAK\n', 'utf8');
    writeSkill(rootDir, 'redacted', body.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'redacted', declaredName: 'redacted', sha256: sha256(body), size: body.byteLength },
    ]);
    const importer = new SkillPackImporter();
    const { plan } = importer.scan({ rootsConfigPath: fixture.rootsConfigPath, inventoryPath: fixture.inventoryPath });
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('PRIVATE-MARKER-NEVER-LEAK');
    expect(serialized).not.toMatch(/[A-Za-z0-9+/]{80,}={0,2}/); // base64 blobs
    expect(serialized).not.toMatch(/Users|konedev|\/Users\//);
    expect(plan).toMatchObject({
      schemaVersion: 1,
      inventoryDigest: fixture.inventory.inventoryDigest,
      planDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(plan.packages[0]!.resources.every((r) => typeof r.sha256 === 'string' && r.sha256.length === 64)).toBe(true);
  });

  it('drift between preview and apply surfaces as VALIDATION 400 (not CONFLICT)', async () => {
    const body = Buffer.from('---\nname: stale\n---\nbody\n', 'utf8');
    writeSkill(rootDir, 'stale', body.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'stale', declaredName: 'stale', sha256: sha256(body), size: body.byteLength },
    ]);
    const backupDir = mkdtempSync(join(tmpdir(), 's2-apply-stale-'));
    tempRoots.push(backupDir);
    const importer = new SkillPackImporter();
    const { plan } = importer.scan({ rootsConfigPath: fixture.rootsConfigPath, inventoryPath: fixture.inventoryPath });
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(rootDir, 'stale', 'SKILL.md'), Buffer.from('---\nname: stale\n---\nchanged\n', 'utf8'));
    const coord = new SkillPackApplyCoordinator({
      dbPath,
      backupDir,
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
      actor: actor(),
    });
    await expect(coord.apply(plan.planDigest)).rejects.toThrowError(
      expect.objectContaining({ code: 'VALIDATION', status: 400 }),
    );
  });
});

describe('relation projection round-trip', () => {
  it('exports deterministic skill-relations.json, imports it in two atomic passes, and rolls back invalid targets', async () => {
    const a = actor();
    const sourceDb = freshDb();
    const source = new SqliteStore(sourceDb);
    const alphaId = deriveSkillId('alpha');
    const bravoId = deriveSkillId('bravo');
    const alphaBody = Buffer.from('---\nname: alpha\ndescription: alpha\n---\nalpha\n');
    const bravoBody = Buffer.from('---\nname: bravo\ndescription: bravo\n---\nbravo\n');
    try {
      source.transaction(a, (tx) => tx.skills.writeSkill({ id: bravoId, scope: scope(a), logicalKey: deriveLogicalKey('bravo'), kind: 'skill', name: 'bravo', lifecycle: 'active', body: bravoBody, metadata: {}, resources: [] }, { reason: 'roundtrip', requestId: 'req_bravo' }));
      source.transaction(a, (tx) => tx.skills.writeSkill({ id: alphaId, scope: scope(a), logicalKey: deriveLogicalKey('alpha'), kind: 'skill', name: 'alpha', lifecycle: 'active', body: alphaBody, metadata: {}, resources: [], relations: [{ type: 'requires', targetSkillId: bravoId, targetVersionConstraint: '>=1', metadata: { purpose: 'build' } }] }, { reason: 'roundtrip', requestId: 'req_alpha' }));
    } finally { source.close(); }

    const projected = tempRoot('relation-export-');
    const exporter = new SkillExportCoordinator({ dbPath: sourceDb, actor: a, selection: { mode: 'all' }, targetDir: projected });
    const exportPlan = exporter.preview();
    exporter.apply(exportPlan.planDigest, exportPlan.contentDigest);
    const relationPath = join(projected, 'skills', 'alpha', 'skill-relations.json');
    const originalRelationManifest = readFileSync(relationPath, 'utf8');
    expect(originalRelationManifest).toContain(bravoId);

    const fixture = buildInventory('exported', join(projected, 'skills'), [
      { packageDir: 'alpha', declaredName: 'alpha', sha256: sha256(alphaBody), size: alphaBody.byteLength },
      { packageDir: 'bravo', declaredName: 'bravo', sha256: sha256(bravoBody), size: bravoBody.byteLength },
    ]);
    const destinationDb = freshDb();
    const backupDir = tempRoot('relation-import-backup-');
    const coordinator = new SkillPackApplyCoordinator({ dbPath: destinationDb, backupDir, rootsConfigPath: fixture.rootsConfigPath, inventoryPath: fixture.inventoryPath, actor: a });
    const importPlan = await coordinator.preview();
    expect(importPlan.packages.find((pkg) => pkg.id === alphaId)?.relations).toHaveLength(1);
    const applied = await coordinator.apply(importPlan.planDigest);
    expect(applied.outcomes.find((outcome) => outcome.id === alphaId)?.version).toBe(2);
    const reopened = new SqliteStore(destinationDb);
    try {
      expect(reopened.transaction(a, (tx) => tx.skills.resolveGraph(alphaId, 2, scope(a))).resolved).toContainEqual(expect.objectContaining({ skillId: bravoId, version: 1 }));
      const importedRelation = reopened.transaction(a, (tx) => tx.skills.getRelations(alphaId, 2, scope(a)))[0];
      expect(importedRelation?.metadata).toEqual({ purpose: 'build' });
      expect(importedRelation?.targetVersionConstraint).toBe('>=1');
      const sourceGraph = new SqliteStore(sourceDb);
      try {
        const normalize = (row: { targetSkillId: string; type: string; targetVersion?: number; targetVersionConstraint?: string | null }) => ({ targetSkillId: row.targetSkillId, type: row.type, targetVersion: row.targetVersion ?? null, targetVersionConstraint: row.targetVersionConstraint ?? null });
        const sourceRelations = sourceGraph.transaction(a, (tx) => tx.skills.getRelations(alphaId, 1, scope(a))).map(normalize);
        const importedRelations = reopened.transaction(a, (tx) => tx.skills.getRelations(alphaId, 2, scope(a))).map(normalize);
        expect(importedRelations).toEqual(sourceRelations);
      } finally { sourceGraph.close(); }
    } finally { reopened.close(); }

    writeFileSync(relationPath, JSON.stringify({ schemaVersion: 1, sourceSkillId: alphaId, relations: [] }));
    const clearPlan = await coordinator.preview();
    expect(clearPlan.packages.find((pkg) => pkg.id === alphaId)?.relationsDeclared).toBe(true);
    await coordinator.apply(clearPlan.planDigest);
    const cleared = new SqliteStore(destinationDb);
    try { expect(cleared.transaction(a, (tx) => tx.skills.getRelations(alphaId, undefined, scope(a)))).toEqual([]); } finally { cleared.close(); }

    const malformed = JSON.parse(originalRelationManifest) as { relations: Array<{ targetSkillId: string }> };
    malformed.relations[0]!.targetSkillId = 'skl_missing';
    writeFileSync(relationPath, JSON.stringify(malformed));
    const invalidDb = freshDb();
    const invalidCoordinator = new SkillPackApplyCoordinator({ dbPath: invalidDb, backupDir: tempRoot('relation-invalid-backup-'), rootsConfigPath: fixture.rootsConfigPath, inventoryPath: fixture.inventoryPath, actor: a });
    const invalidPlan = await invalidCoordinator.preview();
    await expect(invalidCoordinator.apply(invalidPlan.planDigest)).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    const invalidStore = new SqliteStore(invalidDb);
    try { expect(invalidStore.transaction(a, (tx) => tx.skills.listActiveHeads(scope(a)))).toEqual([]); } finally { invalidStore.close(); }
  });
});

describe('SkillPackApplyCoordinator outcomes surface', () => {
  it('returns one outcome per package with id, version, changed', async () => {
    const rootDir = tempRoot('s2-outcomes-roots-');
    const bodyA = Buffer.from('---\nname: one\n---\nA\n', 'utf8');
    const bodyB = Buffer.from('---\nname: two\n---\nB\n', 'utf8');
    const bodyC = Buffer.from('---\nname: three\n---\nC\n', 'utf8');
    writeSkill(rootDir, 'one', bodyA.toString('utf8'));
    writeSkill(rootDir, 'two', bodyB.toString('utf8'));
    writeSkill(rootDir, 'three', bodyC.toString('utf8'));
    const fixture = buildInventory('docs', rootDir, [
      { packageDir: 'one', declaredName: 'one', sha256: sha256(bodyA), size: bodyA.byteLength },
      { packageDir: 'two', declaredName: 'two', sha256: sha256(bodyB), size: bodyB.byteLength },
      { packageDir: 'three', declaredName: 'three', sha256: sha256(bodyC), size: bodyC.byteLength },
    ]);
    const backupDir = mkdtempSync(join(tmpdir(), 's2-outcomes-bk-'));
    tempRoots.push(backupDir);
    const importer = new SkillPackImporter();
    const { plan } = importer.scan({ rootsConfigPath: fixture.rootsConfigPath, inventoryPath: fixture.inventoryPath });
    expect(plan.packages).toHaveLength(3);
    const coord = new SkillPackApplyCoordinator({
      dbPath: freshDb(),
      backupDir,
      rootsConfigPath: fixture.rootsConfigPath,
      inventoryPath: fixture.inventoryPath,
      actor: actor(),
    });
    const result = await coord.apply(plan.planDigest);
    expect(result.outcomes).toHaveLength(3);
    for (const outcome of result.outcomes) {
      expect(outcome.id).toMatch(/^skl_/);
      expect(outcome.version).toBe(1);
      expect(outcome.changed).toBe(true);
    }
    const ids = result.outcomes.map((outcome: SkillPackApplyOutcome) => outcome.id);
    expect(new Set(ids).size).toBe(3);
  });
});

// Pure derivation helpers are exercised in the storage-files /
// storage-sqlite tests above; this single sanity case pins the
// public surface so a future rename doesn't go silent.
describe('derivation surface', () => {
  it('produces stable ids and logical keys independent of roots', () => {
    expect(deriveSkillId('hello world')).toBe(deriveSkillId('Hello World'));
    expect(deriveLogicalKey('Hello World')).toBe('skill:hello-world');
    expect(normalizeName('  Hello   WORLD  ')).toBe('hello-world');
  });
});

// Pure derivation helpers are exercised above; this single sanity
// case pins the public surface so a future rename doesn't go silent.
describe('derivation surface', () => {
  it('produces stable ids and logical keys independent of roots', () => {
    expect(deriveSkillId('hello world')).toBe(deriveSkillId('Hello World'));
    expect(deriveLogicalKey('Hello World')).toBe('skill:hello-world');
    expect(normalizeName('  Hello   WORLD  ')).toBe('hello-world');
  });
});
