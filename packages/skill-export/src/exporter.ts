// packages/skill-export/src/exporter.ts
//
// `SkillExportCoordinator` — the FASE 5 export coordinator.
//
// Responsibilities:
//
//   1. `preview()` opens the SQLite DB, lists every active head for
//      the actor's scope (in `(logicalKey, id)` POSIX order), walks
//      each head's resources (also in POSIX order) and produces a
//      metadata-only `SkillExportPlan`. The plan carries relative
//      paths, sizes, modes and sha256s but NEVER body or resource
//      bytes. The plan digest is stable across runs as long as the
//      active set of skills in SQLite does not change.
//
//   2. `apply()` requires a `--reviewed-digest` that must match the
//      freshly recomputed `planDigest` and `contentDigest` (the
//      latter is a fast comparator over the `(id, version,
//      bodySha256, resourceFingerprint)` tuples). The apply step
//      ALWAYS reopens the DB and re-reads every head, every body
//      and every resource — it never trusts cached state. A
//      mismatch between the caller's digests and the freshly
//      computed ones fails the apply with `CONFLICT/409`.
//
//   3. The filesystem write path is staged on the same filesystem
//      as the requested target dir: a `.staging-<digest>` directory
//      is created under the target's parent, files are written
//      there with `O_NOFOLLOW`, `fsync` is invoked when a helper is
//      provided, and the staging directory is renamed over the
//      target. A failed apply restores the previous target from
//      the registry and removes the new staging directory.
//
//   4. The materialization is treated as a CACHE — SQLite remains
//      the authority. The on-disk tree is a projection of the
//      active heads at apply time. A second apply against an
//      identical DB produces a byte-identical tree (modulo the
//      `appliedAt` timestamp in the registry).

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { HubError, type ActorContext, type Scope, type SkillHeadSummary, type SkillRepository } from '@portable-agent-asset-hub/core';
import { SqliteStore } from '@portable-agent-asset-hub/storage-sqlite';
import {
  SKILL_EXPORT_MANIFEST_NAME,
  SKILL_EXPORT_REGISTRY_NAME,
  SKILL_EXPORT_SCHEMA_VERSION,
  type SkillExportApplyHooks,
  type SkillExportApplyResult,
  type SkillExportFilePlan,
  type SkillExportPackagePlan,
  type SkillExportPlan,
  type SkillExportRegistry,
  type SkillExportRegistryFile,
  type SkillExportSelection,
} from './types.js';
import { canonicalExportDigest, computeContentDigest, sha256OfBytes } from './digest.js';
import {
  assertNoAbsolutePathsInPlan,
  assertNoCollision,
  assertNoSymlinkAncestors,
  assertSafeRoot,
  assertSafeStagingPath,
  assertSafeTargetPath,
  assertSizeWithinLimit,
  isReservedPath,
} from './validator.js';

export interface SkillExportCoordinatorOptions {
  dbPath: string;
  actor: ActorContext;
  selection: SkillExportSelection;
  targetDir: string;
  fsync?: (path: string) => void;
  hooks?: SkillExportApplyHooks;
}

export class SkillExportCoordinator {
  public constructor(private readonly options: SkillExportCoordinatorOptions) {}

  /**
   * Preview: fresh read of the DB. No state is held across calls;
   * the plan is rebuilt from scratch every time.
   */
  public preview(): SkillExportPlan {
    return this.scan();
  }

  /**
   * Apply: requires a fresh `reviewedDigest` and `reviewedContent`
   * to match the freshly recomputed digests. The DB is reopened
   * and re-read on every call.
   */
  public apply(reviewedDigest: string, reviewedContent: string): SkillExportApplyResult {
    if (!/^[0-9a-f]{64}$/u.test(reviewedDigest) || !/^[0-9a-f]{64}$/u.test(reviewedContent)) {
      throw new HubError('VALIDATION', 'apply requires 64-hex digests', 400);
    }
    const targetRoot = assertSafeRoot(this.options.targetDir, 'target-dir');
    const plan = this.scan();
    if (plan.planDigest !== reviewedDigest || plan.contentDigest !== reviewedContent) {
      throw new HubError(
        'CONFLICT',
        `reviewed digest mismatch: expected ${reviewedDigest}/${reviewedContent}, got ${plan.planDigest}/${plan.contentDigest}`,
        409,
      );
    }
    return this.materialize(plan, targetRoot);
  }

  // ─── Plan construction ───────────────────────────────────────────────

  private scan(): SkillExportPlan {
    const store = new SqliteStore(this.options.dbPath);
    try {
      return store.transaction(this.options.actor, (tx) => {
        const scope: Scope = this.options.actor.scope;
        const heads = this.options.selection.mode === 'all'
          ? tx.skills.listActiveHeads(scope)
          : tx.skills.listActiveHeadsFiltered(scope, this.options.selection.ids);
        const packages: SkillExportPackagePlan[] = [];
        const seenNames = new Set<string>();
        for (const head of heads) {
          const packagePlan = this.buildPackagePlan(tx.skills, head);
          if (seenNames.has(packagePlan.name)) {
            throw new HubError(
              'CONFLICT',
              `normalized name collides across skills: ${packagePlan.name}`,
              409,
            );
          }
          seenNames.add(packagePlan.name);
          packages.push(packagePlan);
        }
        packages.sort(this.comparePackages);
        assertNoCollision(packages);
        const counts = {
          packages: packages.length,
          files: packages.reduce((sum, pkg) => sum + pkg.files.length, 0),
          totalBytes: packages.reduce(
            (sum, pkg) => sum + pkg.files.reduce((s, f) => s + f.size, 0),
            0,
          ),
        };
        const plan: Omit<SkillExportPlan, 'planDigest'> = {
          schemaVersion: SKILL_EXPORT_SCHEMA_VERSION,
          scope: this.options.actor.scope,
          ownerUserId: this.options.actor.userId,
          agentId: this.options.actor.agentId,
          selection: this.options.selection,
          contentDigest: computeContentDigest(
            packages.map((pkg) => ({
              id: pkg.id,
              version: pkg.files[0]?.skillVersion ?? 0,
              bodySha256: pkg.bodySha256,
              resourceFingerprint: pkg.resourceFingerprint,
            })),
          ),
          packages,
          counts,
        };
        const planDigest = canonicalExportDigest(plan);
        const fullPlan: SkillExportPlan = { ...plan, planDigest };
        assertNoAbsolutePathsInPlan(fullPlan);
        return fullPlan;
      });
    } finally {
      store.close();
    }
  }

  private buildPackagePlan(
    skills: SkillRepository,
    head: SkillHeadSummary,
  ): SkillExportPackagePlan {
    const scope = this.options.actor.scope;
    const full = skills.getVersion(head.id, head.version, scope);
    if (!full) {
      throw new HubError('NOT_FOUND', `skill version not found: ${head.id} v${head.version}`, 404);
    }
    const bodySha = sha256OfBytes(full.body);
    if (bodySha !== head.bodySha256) {
      throw new HubError('CONFLICT', `body sha mismatch on ${head.id} v${head.version}`, 409);
    }
    if (full.body.byteLength !== head.bodySize) {
      throw new HubError('CONFLICT', `body size mismatch on ${head.id} v${head.version}`, 409);
    }
    assertSizeWithinLimit(head.bodySize, 'body');

    const files: SkillExportFilePlan[] = [];
    const bodyFile: SkillExportFilePlan = {
      relativePath: `skills/${head.name}/SKILL.md`,
      size: head.bodySize,
      sha256: bodySha,
      mode: 0o644,
      skillId: head.id,
      logicalKey: head.logicalKey,
      skillVersion: head.version,
      isBody: true,
      sourceRelativePath: 'SKILL.md',
    };
    files.push(bodyFile);
    const relations = skills.getRelations(head.id, head.version, scope);
    const relationBytes = relationManifestBytes(head.id, head.version, relations);
    const relationManifestSha = sha256OfBytes(relationBytes);
    files.push({
      relativePath: `skills/${head.name}/skill-relations.json`,
      size: relationBytes.byteLength,
      sha256: relationManifestSha,
      mode: 0o644,
      skillId: head.id,
      logicalKey: head.logicalKey,
      skillVersion: head.version,
      isBody: false,
      isRelationsManifest: true,
      sourceRelativePath: 'skill-relations.json',
    });
    for (const resource of head.resources) {
      const record = skills.readResourceAtVersion(head.id, head.version, resource.relativePath, scope);
      if (record.size !== resource.size) {
        throw new HubError('CONFLICT', `resource size mismatch on ${head.id} v${head.version} ${resource.relativePath}`, 409);
      }
      if (record.sha256 !== resource.sha256) {
        throw new HubError('CONFLICT', `resource sha mismatch on ${head.id} v${head.version} ${resource.relativePath}`, 409);
      }
      assertSizeWithinLimit(record.size, 'resource');
      files.push({
        relativePath: `skills/${head.name}/${resource.relativePath}`,
        size: record.size,
        sha256: record.sha256,
        mode: resource.mode,
        skillId: head.id,
        logicalKey: head.logicalKey,
        skillVersion: head.version,
        isBody: false,
        sourceRelativePath: resource.relativePath,
      });
    }
    return {
      id: head.id,
      logicalKey: head.logicalKey,
      name: head.name,
      resourceFingerprint: sha256OfBytes(Buffer.from(`${head.resourceFingerprint}\n${relationManifestSha}`, 'utf8')),
      bodySha256: bodySha,
      bodySize: head.bodySize,
      relations,
      files,
    };
  }

  private comparePackages = (a: { logicalKey: string; id: string }, b: { logicalKey: string; id: string }): number => {
    if (a.logicalKey < b.logicalKey) return -1;
    if (a.logicalKey > b.logicalKey) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  };

  // ─── Materialization (staging, atomic rename, registry) ─────────────

  private materialize(plan: SkillExportPlan, targetRoot: string): SkillExportApplyResult {
    if (existsSync(targetRoot)) {
      const stat = lstatSync(targetRoot);
      if (stat.isSymbolicLink()) {
        throw new HubError('VALIDATION', `target-dir must not be a symlink: ${targetRoot}`, 400);
      }
      if (!stat.isDirectory()) {
        throw new HubError('VALIDATION', `target-dir must be a directory: ${targetRoot}`, 400);
      }
    } else {
      mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    }
    assertNoSymlinkAncestors(targetRoot, targetRoot, 'target-dir');

    const targetParent = dirname(targetRoot);
    const targetBase = targetRoot.split(sep).pop() ?? 'target';
    const stagingRelative = `.staging-${targetBase}-${plan.planDigest.slice(0, 12)}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const stagingPath = join(targetParent, stagingRelative);
    assertSafeTargetPath(targetParent, stagingRelative);
    assertNoSymlinkAncestors(targetParent, stagingPath, 'staging');

    if (existsSync(stagingPath)) {
      rmSync(stagingPath, { recursive: true, force: true });
    }
    mkdirSync(stagingPath, { recursive: true, mode: 0o700 });

    const fsync = this.options.fsync ?? ((path: string) => {
      try {
        // `fsyncSync` requires a file descriptor. For directories
        // we open read-only with `O_DIRECTORY`; for files the
        // `writeFileSync` + `fsyncSync(fd)` paths above already
        // cover the file contents. Here we only need to flush the
        // directory entry.
        const fd = openSync(path, constants.O_RDONLY | (statSync(path).isDirectory() ? constants.O_DIRECTORY : 0));
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } catch { /* fsync not supported */ }
    });

    // Open the DB once, read every body and resource, then close.
    const store = new SqliteStore(this.options.dbPath);
    const runId = `run_${randomUUID().replace(/-/gu, '')}`;
    const backupName = `.export-backup-${targetBase}-${runId}`;
    const backupPath = join(targetParent, backupName);
    let previousState: SkillExportRegistryFile[];
    let promoted = false;
    let filesWritten = 0;
    let filesReused = 0;
    let filesRemoved: number;
    try {
      previousState = capturePreApplyState(targetRoot, plan);
      if (existsSync(backupPath)) {
        throw new HubError('CONFLICT', `backup path already exists: ${backupName}`, 409);
      }

      // Write every plan file into staging.
      store.transaction(this.options.actor, (tx) => {
        for (const pkg of plan.packages) {
          for (const file of pkg.files) {
            const record = file.isBody
              ? { sha256: file.sha256, size: file.size, mode: file.mode, bytes: this.readBodyBytes(tx.skills, file.skillId, file.skillVersion) }
              : file.isRelationsManifest
                ? (() => { const bytes = relationManifestBytes(pkg.id, file.skillVersion, pkg.relations); return { sha256: sha256OfBytes(bytes), size: bytes.byteLength, mode: file.mode, bytes }; })()
                : { sha256: file.sha256, size: file.size, mode: file.mode, bytes: this.readResourceBytes(tx.skills, file.skillId, file.skillVersion, file.sourceRelativePath) };
            if (record.size !== file.size) {
              throw new HubError('CONFLICT', `size drift on ${file.relativePath}`, 409);
            }
            if (record.sha256 !== file.sha256) {
              throw new HubError('CONFLICT', `sha drift on ${file.relativePath}`, 409);
            }
            this.writeStagingFile(stagingPath, file.relativePath, record.bytes, file.mode, fsync);
          }
        }
        this.writeManifest(stagingPath, plan, fsync);
      });

      if (this.options.hooks?.failBeforePromote) {
        throw new HubError('INTERNAL', 'forced failure before promote', 500);
      }

      // Two-rename swap on the same filesystem. The complete previous
      // target remains available for explicit rollback.
      renameSync(targetRoot, backupPath);
      try {
        renameSync(stagingPath, targetRoot);
        promoted = true;
      } catch (error) {
        renameSync(backupPath, targetRoot);
        throw error;
      }
      // After promotion, snapshot the new target for the registry.
      const registry: SkillExportRegistryFile[] = [];
      for (const pkg of plan.packages) {
        for (const file of pkg.files) {
          const abs = join(targetRoot, file.relativePath);
          const stat = statSync(abs);
          if ((stat.mode & 0o777) !== file.mode) {
            throw new HubError('INTERNAL', `mode drift after promotion: ${file.relativePath}`, 500);
          }
          const sha = sha256OfBytes(readFileSync(abs));
          if (sha !== file.sha256) {
            throw new HubError('INTERNAL', `sha drift after promotion: ${file.relativePath}`, 500);
          }
          const prior = previousState.find((entry) => entry.relativePath === file.relativePath) ?? null;
          if (prior && prior.existed && prior.preApplySha256 === sha) {
            filesReused += 1;
          } else {
            filesWritten += 1;
          }
          registry.push({
            relativePath: file.relativePath,
            existed: prior?.existed ?? false,
            preApplySha256: prior?.preApplySha256 ?? null,
            preApplyMode: prior?.preApplyMode ?? null,
            preApplySize: prior?.preApplySize ?? null,
          });
        }
      }
      const newPaths = new Set(registry.map((entry) => entry.relativePath));
      filesRemoved = previousState.filter((entry) => entry.existed && !newPaths.has(entry.relativePath)).length;
      // Also roll back pre-existing files that match plan entries
      // and were NOT in the plan (cross-contamination from a
      // previous apply). We do this by writing back the registry's
      // pre-apply bytes — but only if the registry says the file
      // was NOT part of the previous plan. That situation cannot
      // arise here because we just promoted a clean tree.
      // Empty the staging dir if it lingers.
      if (existsSync(stagingPath)) {
        try { rmSync(stagingPath, { recursive: true, force: true }); } catch { /* best effort */ }
      }

      if (this.options.hooks?.failAfterPromote) {
        throw new HubError('INTERNAL', 'forced failure after promote', 500);
      }

      // Write the registry (0600).
      const registryDoc: SkillExportRegistry = {
        schemaVersion: SKILL_EXPORT_SCHEMA_VERSION,
        runId,
        backupName,
        planDigest: plan.planDigest,
        contentDigest: plan.contentDigest,
        appliedAt: new Date().toISOString(),
        selection: plan.selection,
        files: registry,
      };
      const registryPath = join(targetRoot, SKILL_EXPORT_REGISTRY_NAME);
      const tmpRegistry = `${registryPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
      mkdirSync(dirname(registryPath), { recursive: true });
      const registryFd = openSync(tmpRegistry, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(registryFd, `${JSON.stringify(registryDoc, null, 2)}\n`);
        try { fsyncSync(registryFd); } catch { /* not supported */ }
        closeSync(registryFd);
        renameSync(tmpRegistry, registryPath);
        chmodSync(registryPath, 0o600);
      } catch (error) {
        try { unlinkSync(tmpRegistry); } catch { /* best effort */ }
        throw error;
      }
      fsync(registryPath);
      return {
        runId,
        planDigest: plan.planDigest,
        contentDigest: plan.contentDigest,
        appliedAt: registryDoc.appliedAt,
        filesWritten,
        filesReused,
        filesRemoved,
        manifestPath: join(targetRoot, SKILL_EXPORT_MANIFEST_NAME),
        registryPath,
        targetDir: targetRoot,
        selection: plan.selection,
      };
    } catch (error) {
      if (promoted && existsSync(backupPath)) {
        try {
          rmSync(targetRoot, { recursive: true, force: true });
          renameSync(backupPath, targetRoot);
        } catch { /* surface original error */ }
      }
      try { rmSync(stagingPath, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    } finally {
      store.close();
    }
  }

  public rollback(): { runId: string; restoredTarget: string; finishedAt: string } {
    const targetRoot = assertSafeRoot(this.options.targetDir, 'target-dir');
    const registry = readRegistry(targetRoot);
    const targetParent = dirname(targetRoot);
    const backupPath = join(targetParent, registry.backupName);
    if (!existsSync(backupPath) || lstatSync(backupPath).isSymbolicLink() || !lstatSync(backupPath).isDirectory()) {
      throw new HubError('CONFLICT', `rollback backup unavailable: ${registry.backupName}`, 409);
    }
    const displaced = join(targetParent, `.export-rollback-current-${registry.runId}`);
    if (existsSync(displaced)) {
      throw new HubError('CONFLICT', 'rollback staging already exists', 409);
    }
    renameSync(targetRoot, displaced);
    try {
      renameSync(backupPath, targetRoot);
      rmSync(displaced, { recursive: true, force: true });
    } catch (error) {
      if (!existsSync(targetRoot) && existsSync(displaced)) renameSync(displaced, targetRoot);
      throw error;
    }
    return { runId: registry.runId, restoredTarget: targetRoot, finishedAt: new Date().toISOString() };
  }

  private readBodyBytes(
    skills: { getVersion: (id: string, version: number, scope: Scope) => { body: Buffer } | undefined },
    id: string,
    version: number,
  ): Buffer {
    const scope = this.options.actor.scope;
    const head = skills.getVersion(id, version, scope);
    if (!head) {
      throw new HubError('NOT_FOUND', `skill version not found: ${id} v${version}`, 404);
    }
    return head.body;
  }

  private readResourceBytes(
    skills: { readResourceAtVersion: (id: string, version: number, relativePath: string, scope: Scope) => { bytes: Buffer } },
    id: string,
    version: number,
    relativePath: string,
  ): Buffer {
    const scope = this.options.actor.scope;
    return skills.readResourceAtVersion(id, version, relativePath, scope).bytes;
  }

  private writeStagingFile(
    stagingRoot: string,
    relativePath: string,
    bytes: Buffer,
    mode: 0o644 | 0o755,
    fsync: (path: string) => void,
  ): void {
    assertSafeStagingPath(stagingRoot, relativePath);
    if (isReservedPath(relativePath)) {
      throw new HubError('VALIDATION', `reserved path rejected: ${relativePath}`, 400);
    }
    const absolute = join(stagingRoot, relativePath);
    assertNoSymlinkAncestors(stagingRoot, absolute, 'staging');
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const tempPath = `${absolute}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    const fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      writeFileSync(fd, bytes);
      try { fsyncSync(fd); } catch { /* not supported */ }
      closeSync(fd);
      renameSync(tempPath, absolute);
      chmodSync(absolute, mode);
    } catch (error) {
      try { unlinkSync(tempPath); } catch { /* best effort */ }
      throw error;
    }
    fsync(absolute);
  }

  private writeManifest(
    stagingRoot: string,
    plan: SkillExportPlan,
    fsync: (path: string) => void,
  ): void {
    const manifestPath = join(stagingRoot, SKILL_EXPORT_MANIFEST_NAME);
    // The manifest on disk must be byte-identical to the payload
    // whose digest was approved by the reviewer. The `planDigest`
    // field is a self-reference (its value is the sha256 of the
    // canonical serialization of every other field) so we must
    // NOT include it in the on-disk bytes — otherwise the digests
    // computed at preview time and at apply time would never
    // match. We re-serialise the plan minus the `planDigest` field
    // and use the same canonical algorithm as
    // `canonicalExportDigest`.
    const { planDigest: _self, ...withoutSelf } = plan;
    void _self;
    const digestPayload = serializePlan(withoutSelf);
    const expectedDigest = createHash('sha256').update(digestPayload).digest('hex');
    if (expectedDigest !== plan.planDigest) {
      throw new HubError('INTERNAL', 'manifest digest drift before write', 500);
    }
    const bytes = Buffer.from(serializePlan(plan), 'utf8');
    const tempPath = `${manifestPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    const fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      writeFileSync(fd, bytes);
      try { fsyncSync(fd); } catch { /* not supported */ }
      closeSync(fd);
      renameSync(tempPath, manifestPath);
      chmodSync(manifestPath, 0o644);
    } catch (error) {
      try { unlinkSync(tempPath); } catch { /* best effort */ }
      throw error;
    }
    fsync(manifestPath);
  }
}

function relationManifestBytes(
  sourceSkillId: string,
  sourceVersion: number,
  relations: SkillExportPackagePlan['relations'],
): Buffer {
  const document = {
    schemaVersion: 1,
    sourceSkillId,
    sourceVersion,
    relations: relations.map((relation) => ({
      type: relation.type,
      targetSkillId: relation.targetSkillId,
      targetVersion: relation.resolvedTargetVersion,
      metadata: relation.metadata,
      declaredTargetVersionConstraint: relation.targetVersionConstraint ?? 'head',
    })),
  };
  return Buffer.from(`${serializePlan(document)}\n`, 'utf8');
}

/**
 * Re-serialize a plan using the same canonical algorithm as
 * `canonicalExportDigest`. The canonical algorithm is JSON-like
 * (sorted keys, deterministic separators) and produces a stable
 * payload so the on-disk manifest is byte-identical to the
 * pre-approved planDigest.
 */
function serializePlan(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite numbers are not allowed');
    return Number.isInteger(value) ? value.toString() : JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializePlan).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serializePlan(obj[k])}`).join(',')}}`;
  }
  throw new TypeError(`unsupported value type: ${typeof value}`);
}

// ─── Free helpers ──────────────────────────────────────────────────────

function capturePreApplyState(targetRoot: string, plan: SkillExportPlan): SkillExportRegistryFile[] {
  const entries: SkillExportRegistryFile[] = [];
  for (const pkg of plan.packages) {
    for (const file of pkg.files) {
      const absolute = join(targetRoot, file.relativePath);
      if (!existsSync(absolute)) {
        entries.push({ relativePath: file.relativePath, existed: false, preApplySha256: null, preApplyMode: null, preApplySize: null });
        continue;
      }
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new HubError('VALIDATION', `unsafe pre-apply file: ${file.relativePath}`, 400);
      }
      const bytes = readFileSync(absolute);
      entries.push({
        relativePath: file.relativePath,
        existed: true,
        preApplySha256: sha256OfBytes(bytes),
        preApplyMode: stat.mode & 0o777,
        preApplySize: bytes.byteLength,
      });
    }
  }
  return entries;
}


function readRegistry(targetRoot: string): SkillExportRegistry {
  const registryPath = join(targetRoot, SKILL_EXPORT_REGISTRY_NAME);
  const raw = readFileSync(registryPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<SkillExportRegistry> & { files?: SkillExportRegistryFile[] };
  if (
    !parsed
    || !Array.isArray(parsed.files)
    || typeof parsed.runId !== 'string'
    || typeof parsed.backupName !== 'string'
    || parsed.backupName.includes('/')
    || parsed.backupName.includes('..')
  ) {
    throw new HubError('CONFLICT', 'registry is malformed', 409);
  }
  return parsed as SkillExportRegistry;
}
