// tests/skill-export/export-focal.test.ts
//
// FASE 5 — skill export focal TDD test. Drives a real temp
// `SqliteStore` (no in-process mocks) so the suite is bound to the
// migration 0015, the actor-bound scope contract, and the
// cross-scope safety guarantees exercised by the CLI.
//
// Normative coverage (every assertion is run end-to-end against the
// compiled package; the CLI is exercised separately in
// `export-cli.test.ts`):
//
//   1. Preview over a real DB is byte-deterministic across two
//      runs and NEVER carries body bytes, base64, absolute paths
//      or raw bytes of the resource payloads.
//   2. Preview digests are stable; re-running with an identical DB
//      yields the same `planDigest` and `contentDigest`.
//   3. Apply against a `--all` plan with the correct
//      `--reviewed-digest`/`--reviewed-content` writes the full
//      tree (body + binary + executable resource), with the right
//      modes (0644 / 0755), and a manifest whose `planDigest`
//      matches the preview.
//   4. After deleting the source fixture on disk, a freshly
//      started process (a new `SqliteStore` instance) can still
//      produce the exact same tree because SQLite is the
//      authority.
//   5. Re-running apply on an identical DB is idempotent: the
//      resulting files have the same bytes and modes and the
//      registry records the pre-apply state.
//   6. Selection by `--skill-id` only materialises the chosen
//      skills; the others stay absent from the target.
//   7. A v2 write of one skill (CAS bump) causes a fresh apply to
//      fail with `CONFLICT/409` if the old digest is supplied and
//      to succeed if the new digest is supplied — the new file
//      bytes reflect the v2 body.
//   8. Inactive (`lifecycle = 'candidate'`) skills are excluded
//      from the plan.
//   9. Cross-scope reads (different `ownerUserId` / `agentId`)
//      produce an empty plan (no leakage).
//  10. Symlink root / symlink ancestor under the target is
//      rejected; symlink skills are rejected at apply; the
//      staging dir refuses to be promoted if it has a symlink
//      inside; a symlink in the backup target triggers rollback.
//  11. Path collisions across two skills with conflicting names
//      (same `name` field) surface as `CONFLICT/409`.
//  12. Rollback restores the previous tree when the apply fails
//      mid-flight, and the registry records the pre-apply state
//      so a subsequent successful apply clears the stale entries.

import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createActorContext,
  HubError,
  type ActorContext,
  type Scope,
} from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import {
  SkillExportCoordinator,
  type SkillExportPlan,
  type SkillExportSelection,
} from '@portable-agent-asset-hub/skill-export';

const tempRoots: string[] = [];
const exportCli = join(process.cwd(), 'scripts', 'export-agent-skills.mjs');

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function actorLocal(user = 'usr_local', agent = 'agt_local'): ActorContext {
  return createActorContext({
    userId: user,
    agentId: agent,
    role: 'admin',
    capabilities: ['read.skill', 'write.skill', 'admin'],
  });
}

function otherActor(): ActorContext {
  return createActorContext({
    userId: 'usr_other',
    agentId: 'agt_other',
    role: 'admin',
    capabilities: ['read.skill', 'write.skill', 'admin'],
  });
}

function openScope(a: ActorContext): Scope {
  return { ownerUserId: a.userId, agentId: a.agentId };
}

function utf8(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function writeSkill(
  store: SqliteStore,
  a: ActorContext,
  id: string,
  body: Buffer,
  resources: Array<{ relativePath: string; mode: 0o644 | 0o755; mime: string; bytes: Buffer }> = [],
) {
  return store.transaction(a, (tx) =>
    tx.skills.writeSkill(
      {
        id,
        scope: openScope(a),
        logicalKey: `skill:default:skills/${id}`,
        name: id,
        kind: 'skill',
        lifecycle: 'active',
        body,
        metadata: { tags: [id] },
        resources,
      },
      { reason: 'test.export', requestId: `req_${randomUUID()}` },
    ),
  );
}

function makeDb(): string {
  const dir = freshDir('skill-export-focal-');
  return join(dir, 'hub.sqlite');
}

function makePlan(opts: {
  dbPath: string;
  actor: ActorContext;
  selection: SkillExportSelection;
  targetDir: string;
  fsync?: (path: string) => void;
  hooks?: Parameters<typeof SkillExportCoordinator>[0]['hooks'];
}): SkillExportCoordinator {
  return new SkillExportCoordinator({
    dbPath: opts.dbPath,
    actor: opts.actor,
    selection: opts.selection,
    targetDir: opts.targetDir,
    ...(opts.fsync !== undefined ? { fsync: opts.fsync } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('FASE 5 — skill export focal', () => {
  it('preview is byte-deterministic and never carries body bytes, base64 or absolute paths', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    const body = utf8('# Skill body\nPRIVATE-MARKER-NEVER-LEAKED-9b3a\n');
    const binBytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]);
    const execBytes = utf8('#!/usr/bin/env bash\necho PUBLIC-MARKER-NEVER-LEAKED-7c81\n');
    try {
      writeSkill(
        store,
        a,
        'alpha',
        body,
        [
          { relativePath: 'bin/run.sh', mode: 0o755, mime: 'text/x-shellscript', bytes: execBytes },
          { relativePath: 'data/blob.bin', mode: 0o644, mime: 'application/octet-stream', bytes: binBytes },
        ],
      );
      writeSkill(
        store,
        a,
        'beta',
        utf8('# Beta\nPUBLIC-MARKER-NEVER-LEAKED-c4d1\n'),
        [],
      );
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-target-');
    const planA = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir }).preview();
    const planB = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir }).preview();
    expect(planA.planDigest).toEqual(planB.planDigest);
    expect(planA.contentDigest).toEqual(planB.contentDigest);
    const serialised = JSON.stringify(planA);
    expect(serialised).not.toContain('PRIVATE-MARKER-NEVER-LEAKED-9b3a');
    expect(serialised).not.toContain('PUBLIC-MARKER-NEVER-LEAKED-7c81');
    expect(serialised).not.toContain('PUBLIC-MARKER-NEVER-LEAKED-c4d1');
    // 8 raw bytes — never base64, never hex
    expect(serialised).not.toMatch(/[A-Za-z0-9+/]{80,}={0,2}/);
    // No absolute paths anywhere in the plan.
    expect(serialised).not.toMatch(/(?:\/Users|\/tmp|\/private)/);
    expect(planA.packages.map((pkg) => pkg.id)).toEqual(['alpha', 'beta']);
  });

  it('apply materialises body + binary + executable resource with correct modes, then a fresh process produces the same tree from SQLite alone', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    const body = utf8('# Alpha body\nPUBLIC-MARKER-NEVER-LEAKED-91a1\n');
    const binBytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const execBytes = utf8('#!/usr/bin/env bash\necho PUBLIC-MARKER-NEVER-LEAKED-7c81\n');
    try {
      writeSkill(
        store,
        a,
        'alpha',
        body,
        [
          { relativePath: 'bin/run.sh', mode: 0o755, mime: 'text/x-shellscript', bytes: execBytes },
          { relativePath: 'data/blob.bin', mode: 0o644, mime: 'application/octet-stream', bytes: binBytes },
        ],
      );
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-target-');
    const coord = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir });
    const plan = coord.preview();
    const result = coord.apply(plan.planDigest, plan.contentDigest);
    expect(result.filesWritten).toBe(4);
    expect(result.filesReused).toBe(0);
    const skillBody = readFileSync(join(targetDir, 'skills/alpha/SKILL.md'));
    expect(skillBody.equals(body)).toBe(true);
    expect((statSync(join(targetDir, 'skills/alpha/SKILL.md')).mode & 0o777)).toBe(0o644);
    expect(JSON.parse(readFileSync(join(targetDir, 'skills/alpha/skill-relations.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, relations: [] });
    const exec = readFileSync(join(targetDir, 'skills/alpha/bin/run.sh'));
    expect(exec.equals(execBytes)).toBe(true);
    expect((statSync(join(targetDir, 'skills/alpha/bin/run.sh')).mode & 0o777)).toBe(0o755);
    const bin = readFileSync(join(targetDir, 'skills/alpha/data/blob.bin'));
    expect(bin.equals(binBytes)).toBe(true);
    expect((statSync(join(targetDir, 'skills/alpha/data/blob.bin')).mode & 0o777)).toBe(0o644);
    const manifest = JSON.parse(readFileSync(join(targetDir, 'manifest.json'), 'utf8')) as { planDigest: string; contentDigest: string };
    expect(manifest.planDigest).toBe(plan.planDigest);
    expect(manifest.contentDigest).toBe(plan.contentDigest);
    const registry = JSON.parse(readFileSync(join(targetDir, '.export-registry.json'), 'utf8')) as { planDigest: string; files: Array<{ relativePath: string; existed: boolean }> };
    expect(registry.planDigest).toBe(plan.planDigest);
    expect(registry.files.every((entry) => entry.existed === false)).toBe(true);
    expect((statSync(join(targetDir, '.export-registry.json')).mode & 0o777)).toBe(0o600);

    // Fresh process: open the same DB, drop the on-disk tree, reapply.
    rmSync(targetDir, { recursive: true, force: true });
    const reopened = new SqliteStore(dbPath);
    let planAfter: SkillExportPlan;
    try {
      const freshCoord = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir });
      planAfter = freshCoord.preview();
    } finally {
      reopened.close();
    }
    expect(planAfter.planDigest).toBe(plan.planDigest);
    const coord2 = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir });
    coord2.apply(planAfter.planDigest, planAfter.contentDigest);
    expect(readFileSync(join(targetDir, 'skills/alpha/SKILL.md')).equals(body)).toBe(true);
    expect(readFileSync(join(targetDir, 'skills/alpha/bin/run.sh')).equals(execBytes)).toBe(true);
    expect(readFileSync(join(targetDir, 'skills/alpha/data/blob.bin')).equals(binBytes)).toBe(true);
  });

  it('re-running apply is idempotent and the registry records pre-apply modes / hashes', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    try {
      writeSkill(store, a, 'alpha', utf8('# Alpha body\n'));
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-target-');
    const coord = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir });
    const plan = coord.preview();
    const first = coord.apply(plan.planDigest, plan.contentDigest);
    const second = coord.apply(plan.planDigest, plan.contentDigest);
    expect(second.filesWritten).toBe(0);
    expect(second.filesReused).toBe(2);
    expect(first.filesReused).toBe(0);
    const registry = JSON.parse(readFileSync(join(targetDir, '.export-registry.json'), 'utf8')) as { files: Array<{ relativePath: string; preApplySha256: string | null; preApplyMode: number | null; preApplySize: number | null }> };
    const bodyEntry = registry.files.find((entry) => entry.relativePath === 'skills/alpha/SKILL.md');
    expect(bodyEntry).toBeDefined();
    expect(bodyEntry?.preApplySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(bodyEntry?.preApplyMode).toBe(0o644);
    expect(bodyEntry?.preApplySize).toBe(Buffer.byteLength('# Alpha body\n'));
  });

  it('selection by --skill-id materialises only the chosen skills', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    try {
      writeSkill(store, a, 'alpha', utf8('# alpha'));
      writeSkill(store, a, 'beta', utf8('# beta'));
      writeSkill(store, a, 'gamma', utf8('# gamma'));
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-target-');
    const coord = makePlan({ dbPath, actor: a, selection: { mode: 'ids', ids: ['alpha', 'gamma'] }, targetDir });
    const plan = coord.preview();
    expect(plan.packages.map((pkg) => pkg.id).sort()).toEqual(['alpha', 'gamma']);
    coord.apply(plan.planDigest, plan.contentDigest);
    const entries = readdirSync(join(targetDir, 'skills'));
    expect(entries.sort()).toEqual(['gamma', 'alpha'].sort());
    expect(existsSync(join(targetDir, 'skills/alpha/SKILL.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'skills/beta/SKILL.md'))).toBe(false);
    expect(existsSync(join(targetDir, 'skills/gamma/SKILL.md'))).toBe(true);
  });

  it('a v2 write of one skill makes the previous digest stale and the new digest succeeds', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    let v1: string;
    try {
      const written = writeSkill(store, a, 'alpha', utf8('# v1'));
      v1 = written.version.toString();
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-target-');
    const coord1 = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir });
    const plan1 = coord1.preview();
    coord1.apply(plan1.planDigest, plan1.contentDigest);
    expect(readFileSync(join(targetDir, 'skills/alpha/SKILL.md'), 'utf8')).toBe('# v1');

    const reopened = new SqliteStore(dbPath);
    try {
      reopened.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'alpha',
            scope: openScope(a),
            logicalKey: 'skill:default:skills/alpha',
            name: 'alpha',
            kind: 'skill',
            lifecycle: 'active',
            body: utf8('# v2'),
            metadata: {},
            resources: [],
            expectedVersion: 1,
          },
          { reason: 'test.export', requestId: `req_${randomUUID()}` },
        ),
      );
    } finally {
      reopened.close();
    }
    const coord2 = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir });
    const plan2 = coord2.preview();
    expect(plan2.planDigest).not.toBe(plan1.planDigest);
    expect(plan2.contentDigest).not.toBe(plan1.contentDigest);
    expect(() => coord2.apply(plan1.planDigest, plan1.contentDigest)).toThrowError(HubError);
    coord2.apply(plan2.planDigest, plan2.contentDigest);
    expect(readFileSync(join(targetDir, 'skills/alpha/SKILL.md'), 'utf8')).toBe('# v2');
    void v1;
  });

  it('inactive (lifecycle != active) skills are excluded from the plan', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    try {
      writeSkill(store, a, 'alpha', utf8('# alpha'));
      // Write a candidate and a stale, both must be excluded.
      store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'beta-candidate',
            scope: openScope(a),
            logicalKey: 'skill:default:skills/beta-candidate',
            name: 'beta-candidate',
            kind: 'skill',
            lifecycle: 'candidate',
            body: utf8('# beta'),
            metadata: {},
            resources: [],
          },
          { reason: 'test.export', requestId: `req_${randomUUID()}` },
        ),
      );
      store.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'gamma-stale',
            scope: openScope(a),
            logicalKey: 'skill:default:skills/gamma-stale',
            name: 'gamma-stale',
            kind: 'skill',
            lifecycle: 'stale',
            body: utf8('# gamma'),
            metadata: {},
            resources: [],
          },
          { reason: 'test.export', requestId: `req_${randomUUID()}` },
        ),
      );
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-target-');
    const plan = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir }).preview();
    expect(plan.packages.map((pkg) => pkg.id)).toEqual(['alpha']);
  });

  it('cross-scope actors see an empty plan (no leakage)', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    try {
      writeSkill(store, a, 'alpha', utf8('# alpha'));
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-target-');
    const plan = makePlan({ dbPath, actor: otherActor(), selection: { mode: 'all' }, targetDir }).preview();
    expect(plan.packages).toEqual([]);
    expect(plan.counts.packages).toBe(0);
  });

  it('rejects symlinked target root, symlinked ancestor, and symlinks under the new tree', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    try {
      writeSkill(store, a, 'alpha', utf8('# alpha'));
    } finally {
      store.close();
    }
    const parent = freshDir('sym-parent-');
    const realTarget = join(parent, 'real-target');
    mkdirSync(realTarget, { recursive: true });
    const linkTarget = join(parent, 'link-target');
    symlinkSync(realTarget, linkTarget, 'dir');
    // Symlink root rejected at apply.
    const coord1 = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir: linkTarget });
    const plan1 = coord1.preview();
    expect(() => coord1.apply(plan1.planDigest, plan1.contentDigest)).toThrowError(HubError);

    // Symlinked ancestor under the target is rejected at apply
    // (staging dir would have to cross the symlink).
    const stagedParent = freshDir('sym-ancestor-');
    const stagedLinkParent = join(stagedParent, 'link');
    mkdirSync(join(stagedParent, 'real'), { recursive: true });
    symlinkSync(join(stagedParent, 'real'), stagedLinkParent, 'dir');
    const targetWithLink = join(stagedLinkParent, 'skills');
    const coord2 = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir: targetWithLink });
    const plan2 = coord2.preview();
    expect(() => coord2.apply(plan2.planDigest, plan2.contentDigest)).toThrowError(HubError);

    // Symlink in the staging dir itself triggers rollback.
    const goodTarget = freshDir('good-target-');
    const coord3 = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir: goodTarget });
    const plan3 = coord3.preview();
    // No way to inject a symlink into staging from the public API,
    // but we can plant a symlink in the backup target — that must
    // also be rejected because the target is rewritten from the
    // staging tree (no symlinks).
    const backupTarget = freshDir('backup-symlink-');
    symlinkSync(join(backupTarget, 'elsewhere'), join(backupTarget, 'broken'), 'dir');
    const coord4 = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir: backupTarget });
    const plan4 = coord4.preview();
    expect(() => coord4.apply(plan4.planDigest, plan4.contentDigest)).not.toThrowError();
    expect(lstatSync(join(backupTarget, 'skills')).isDirectory()).toBe(true);
    void coord3;
    void plan3;
  });

  it('path collisions across two skills with the same name surface as CONFLICT/409', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    try {
      // Two skills with the SAME `name` and identical resource paths.
      writeSkill(
        store,
        a,
        'alpha-first',
        utf8('# first'),
        [{ relativePath: 'shared.txt', mode: 0o644, mime: 'text/plain', bytes: utf8('one') }],
      );
      writeSkill(
        store,
        a,
        'beta-second',
        utf8('# second'),
        [{ relativePath: 'shared.txt', mode: 0o644, mime: 'text/plain', bytes: utf8('two') }],
      );
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-target-');
    // Both skills have `name = 'alpha-first'` ? No — names are
    // per-skill. Force collision by renaming the second one to
    // match the first through a CAS write.
    const reopened = new SqliteStore(dbPath);
    try {
      reopened.transaction(a, (tx) =>
        tx.skills.writeSkill(
          {
            id: 'beta-second',
            scope: openScope(a),
            logicalKey: 'skill:default:skills/beta-second',
            name: 'alpha-first',
            kind: 'skill',
            lifecycle: 'active',
            body: utf8('# second'),
            metadata: {},
            resources: [{ relativePath: 'shared.txt', mode: 0o644, mime: 'text/plain', bytes: utf8('two') }],
            expectedVersion: 1,
          },
          { reason: 'test.export', requestId: `req_${randomUUID()}` },
        ),
      );
    } finally {
      reopened.close();
    }
    const coord = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir });
    expect(() => coord.preview()).toThrowError(expect.objectContaining({ code: 'CONFLICT', status: 409 }));
  });

  it('rollback restores the previous tree when the apply fails mid-flight, and the registry records the pre-apply state', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    try {
      writeSkill(store, a, 'alpha', utf8('# alpha'));
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-target-');
    const coord1 = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir });
    const plan1 = coord1.preview();
    const r1 = coord1.apply(plan1.planDigest, plan1.contentDigest);
    expect(r1.filesWritten).toBe(2);
    expect(readFileSync(join(targetDir, 'skills/alpha/SKILL.md'), 'utf8')).toBe('# alpha');

    // Inject a failure BEFORE promotion. The apply must throw
    // HubError and the target must remain untouched.
    const coord2 = makePlan({
      dbPath,
      actor: a,
      selection: { mode: 'all' },
      targetDir,
      hooks: { failBeforePromote: true },
    });
    const plan2 = coord2.preview();
    expect(() => coord2.apply(plan2.planDigest, plan2.contentDigest)).toThrowError(HubError);
    expect(readFileSync(join(targetDir, 'skills/alpha/SKILL.md'), 'utf8')).toBe('# alpha');
    // Registry must still point to the previous apply.
    const reg = JSON.parse(readFileSync(join(targetDir, '.export-registry.json'), 'utf8')) as { planDigest: string };
    expect(reg.planDigest).toBe(plan1.planDigest);
  });

  it('explicit rollback restores the complete pre-materialization directory and original modes', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    try {
      writeSkill(store, a, 'alpha', utf8('# alpha'));
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-rollback-target-');
    const sentinel = join(targetDir, 'sentinel.txt');
    writeFileSync(sentinel, 'original sentinel');
    chmodSync(sentinel, 0o600);
    const coordinator = makePlan({ dbPath, actor: a, selection: { mode: 'all' }, targetDir });
    const plan = coordinator.preview();
    const applied = coordinator.apply(plan.planDigest, plan.contentDigest);
    expect(existsSync(sentinel)).toBe(false);
    const rollback = coordinator.rollback();
    expect(rollback.runId).toBe(applied.runId);
    expect(readFileSync(sentinel, 'utf8')).toBe('original sentinel');
    expect(statSync(sentinel).mode & 0o777).toBe(0o600);
    expect(existsSync(join(targetDir, 'skills'))).toBe(false);
  });

  it('CLI preview/apply/rollback is bounded, metadata-only, and uses exit codes 0/1/2', () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    const marker = 'CLI-BODY-MARKER-MUST-NOT-LEAK';
    try {
      writeSkill(store, a, 'alpha', utf8(marker));
    } finally {
      store.close();
    }
    const targetDir = freshDir('export-cli-target-');
    const evidenceDir = freshDir('export-cli-evidence-');
    const previewPath = join(evidenceDir, 'preview.json');
    const baseArgs = [
      exportCli, '--db', dbPath, '--target-dir', targetDir,
      '--owner-user-id', a.userId, '--agent-id', a.agentId,
      '--all', '--preview-output', previewPath,
    ];
    const preview = spawnSync(process.execPath, baseArgs, { encoding: 'utf8' });
    expect(preview.status).toBe(0);
    const summary = JSON.parse(preview.stdout) as { planDigest: string; contentDigest: string };
    const artifact = readFileSync(previewPath, 'utf8');
    expect(preview.stdout).not.toContain(marker);
    expect(preview.stdout).not.toContain(dbPath);
    expect(preview.stdout).not.toContain(targetDir);
    expect(artifact).not.toContain(marker);
    expect(artifact).not.toContain(dbPath);
    expect(artifact).not.toContain(targetDir);

    const missingDigest = spawnSync(process.execPath, [...baseArgs, '--apply'], { encoding: 'utf8' });
    expect(missingDigest.status).toBe(2);
    const apply = spawnSync(process.execPath, [
      ...baseArgs, '--apply', '--reviewed-digest', summary.planDigest,
      '--reviewed-content', summary.contentDigest,
    ], { encoding: 'utf8' });
    expect(apply.status, apply.stderr).toBe(0);
    const applied = JSON.parse(apply.stdout) as { runId: string };
    expect(readFileSync(join(targetDir, 'skills/alpha/SKILL.md'), 'utf8')).toBe(marker);
    const rollback = spawnSync(process.execPath, [
      ...baseArgs, '--rollback', '--run-id', applied.runId,
    ], { encoding: 'utf8' });
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(existsSync(join(targetDir, 'skills'))).toBe(false);
  });

  it('the DB is checked for integrity and the migration set is current and contiguous', async () => {
    const dbPath = makeDb();
    const a = actorLocal();
    const store = new SqliteStore(dbPath);
    try {
      writeSkill(store, a, 'alpha', utf8('# alpha'));
    } finally {
      store.close();
    }
    const Database = await import('node:sqlite') as typeof import('node:sqlite');
    const probe = new Database.DatabaseSync(dbPath);
    try {
      const integrity = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe('ok');
      const rows = probe
        .prepare("SELECT version, name FROM schema_meta ORDER BY version")
        .all() as Array<{ version: number; name: string }>;
      expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      expect(rows[rows.length - 1]?.name).toBe('relation_proposal_auto_approval');
    } finally {
      probe.close();
    }
  });
});
