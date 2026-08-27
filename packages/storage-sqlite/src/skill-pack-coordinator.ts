// packages/storage-sqlite/src/skill-pack-coordinator.ts
//
// Phase 2 — Skill pack apply coordinator.
//
// Responsibility split:
//
//   * `preview()` returns a deterministic `SkillPackPlan`. It calls
//     the storage-files `SkillPackImporter.scan()` fresh every time
//     so it never holds mutable state across calls.
//   * `apply()` is the only path that touches SQLite. It validates
//     that the caller's `reviewedDigest` equals the freshly
//     re-computed `planDigest` and that the plan's scope / profile
//     match the actor and the caller's expected profile. THEN it
//     produces the SQLite backup file. THEN it BEGIN IMMEDIATE's
//     and writes each package inside one `BEGIN IMMEDIATE` /
//     `COMMIT` block. A failure on the second write triggers a
//     full `ROLLBACK` — proven by the rollback test, which mutates
//     the second `writeSkill` call to throw.
//
// Audit metadata NEVER contains absolute paths or raw bytes. Per-
// package outcomes are returned as `[{ id, version, changed }]`
// rather than a single first id so a no-op return can be surfaced
// through `changed: false`.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  HubError,
  versionSatisfies,
  type ActorContext,
  type Scope,
  type SkillPackApplyHooks,
  type SkillPackApplyOutcome,
  type SkillPackApplyResult,
  type SkillPackPlan,
  type SkillPackScanResult,
} from '@portable-agent-asset-hub/core';
import { SkillPackImporter } from '@portable-agent-asset-hub/storage-files';

import { AuditRepository } from './repositories/audit.js';
import { backupDatabase } from './backup.js';
import { HubDatabase } from './database.js';
import { SqliteSkillRepository } from './repositories/skill.js';

export interface SkillPackApplyCoordinatorOptions {
  dbPath: string;
  backupDir: string;
  rootsConfigPath: string;
  inventoryPath: string;
  actor: ActorContext;
  /** Test-only: forces the Nth `writeSkill` to fail mid-transaction. */
  hooks?: SkillPackApplyHooks;
  /** Override the importer for tests / fault injection. */
  importer?: SkillPackImporter;
}

interface ApplyState {
  db: HubDatabase;
  raw: DatabaseSync;
  audit: AuditRepository;
}

export class SkillPackApplyCoordinator {
  public constructor(private readonly options: SkillPackApplyCoordinatorOptions) {}

  /**
   * Preview is a projection over the fresh scan. The plan never
   * carries bytes or timestamps.
   */
  public async preview(): Promise<SkillPackPlan> {
    const { plan } = this.scan();
    return plan;
  }

  /**
   * Apply a plan. `reviewedDigest` is REQUIRED — the coordinator
   * never accepts an implicit digest. The plan must come from a
   * fresh scan inside this call so the on-disk bytes cannot drift
   * between the preview the reviewer approved and the apply.
   *
   * The backup file is written AFTER the digest comparison and
   * BEFORE the BEGIN IMMEDIATE so a partial DB never escapes
   * across the apply boundary.
   */
  public async apply(reviewedDigest: string): Promise<SkillPackApplyResult> {
    if (typeof reviewedDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(reviewedDigest)) {
      throw new HubError('VALIDATION', 'apply requires a 64-hex-char reviewedDigest', 400);
    }
    const { plan, bodies } = this.scan();
    if (plan.secretFindings.length > 0) {
      throw new HubError('VALIDATION', `apply blocked: ${plan.secretFindings.length} secret findings`, 400);
    }

    if (plan.planDigest !== reviewedDigest) {
      throw new HubError(
        'CONFLICT',
        `reviewedDigest mismatch: expected ${reviewedDigest}, got ${plan.planDigest}`,
        409,
      );
    }
    if (!scopeEquals(plan.scope, this.options.actor.scope)) {
      throw new HubError('FORBIDDEN', 'plan.scope does not match actor.scope', 403);
    }

    mkdirSync(this.options.backupDir, { recursive: true });
    if (!existsSync(this.options.dbPath)) {
      const empty = new HubDatabase(this.options.dbPath);
      empty.close();
    }
    const backupPath = join(
      this.options.backupDir,
      `agent-memory-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}-${randomUUID().slice(0, 8)}.sqlite`,
    );
    const backup = await backupDatabase(this.options.dbPath, backupPath);

    const state = this.openDatabase();
    const outcomes: SkillPackApplyOutcome[] = [];
    try {
      this.runTransaction(state, () => {
        let writeIndex = 0;
        for (const pkg of plan.packages) {
          const repo = new SqliteSkillRepository(state.raw, this.options.actor, state.audit, () => undefined);
          const head = repo.getHeadVersion(pkg.id, this.options.actor.scope);
          const expectedVersion = head?.version ?? 0;
          const collected = bodies.get(pkg.id);
          if (!collected) throw new HubError('INTERNAL', `no bytes collected for ${pkg.id}`, 500);
          const metadata = this.buildMetadata(pkg, plan);
          const written = repo.writeSkill(
            {
              id: pkg.id,
              scope: this.options.actor.scope,
              logicalKey: pkg.logicalKey,
              kind: 'skill',
              name: pkg.name,
              ...(pkg.summary !== undefined ? { summary: pkg.summary } : {}),
              lifecycle: 'active',
              body: collected.body,
              metadata,
              resources: collected.resources,
              expectedVersion,
            },
            {
              reason: 'skill-pack-importer apply',
              requestId: `req_${plan.planDigest.slice(0, 12)}_${writeIndex}`,
            },
          );
          const changed = written.version > expectedVersion;
          outcomes.push({ id: written.id, version: written.version, changed });
          writeIndex += 1;
          if (this.options.hooks?.failWriteSkillAt === writeIndex) {
            throw new HubError('INTERNAL', 'forced writeSkill failure', 500);
          }
        }
        // Relations are applied only after every package body exists, so
        // targets may appear later in lexical package order and symmetric
        // relation cycles remain importable. The whole two-pass sequence is
        // inside the same BEGIN IMMEDIATE transaction and therefore rolls
        // back atomically on any invalid relation.
        for (const pkg of plan.packages) {
          if (!pkg.relationsDeclared) continue;
          const repo = new SqliteSkillRepository(state.raw, this.options.actor, state.audit, () => undefined);
          const sourceHead = repo.getHeadVersion(pkg.id, this.options.actor.scope);
          if (!sourceHead) throw new HubError('INTERNAL', `source missing during relation apply: ${pkg.id}`, 500);
          const remapped = (pkg.relations ?? []).map((relation) => {
            const targetHead = repo.getHeadVersion(relation.targetSkillId, this.options.actor.scope);
            if (!targetHead) throw new HubError('NOT_FOUND', 'relation target not found in actor scope', 404);
            const declared = relation.declaredTargetVersionConstraint;
            if (declared === 'head') {
              return { type: relation.type, targetSkillId: relation.targetSkillId, metadata: relation.metadata ?? {} };
            }
            if (declared && versionSatisfies(targetHead.version, declared)) {
              return { type: relation.type, targetSkillId: relation.targetSkillId, targetVersionConstraint: declared, metadata: relation.metadata ?? {} };
            }
            return {
              type: relation.type,
              targetSkillId: relation.targetSkillId,
              targetVersion: targetHead.version,
              metadata: declared
                ? { ...(relation.metadata ?? {}), portableOriginalConstraint: declared }
                : relation.metadata ?? {},
            };
          });
          const written = repo.replaceRelations(pkg.id, sourceHead.version, remapped, this.options.actor.scope, {
            reason: 'skill-pack-importer relation apply',
            requestId: `req_${plan.planDigest.slice(0, 12)}_relations_${pkg.id}`,
          });
          const outcome = outcomes.find((candidate) => candidate.id === pkg.id);
          if (outcome) {
            outcome.changed = outcome.changed || written.version > sourceHead.version;
            outcome.version = written.version;
          }
        }
      });

      return {
        planDigest: plan.planDigest,
        outcomes,
        backup: { path: backup.backup, sha256: backup.sha256 },
        appliedAt: new Date().toISOString(),
      };
    } finally {
      state.db.close();
    }
  }

  private buildMetadata(
    pkg: SkillPackPlan['packages'][number],
    plan: SkillPackPlan,
  ): Record<string, unknown> {
    return {
      provenance: 'skill-pack-importer',
      logicalKey: pkg.logicalKey,
      sources: pkg.sources.map((source) => ({ rootId: source.rootId, relativePath: source.relativePath })),
      resourceCount: pkg.resources.length,
      resourceHashes: Object.fromEntries(
        pkg.resources.map((resource) => [resource.relativePath, resource.sha256]),
      ),
      inventoryDigest: plan.inventoryDigest,
      planDigest: plan.planDigest,
    };
  }

  /**
   * Internal: fresh scan every time. No instance caches — the
   * coordinator is allowed to call this from both `preview` and
   * `apply` and the inputs are re-read from disk each call.
   */
  private scan(): SkillPackScanResult {
    const importer = this.options.importer ?? new SkillPackImporter();
    return importer.scan({
      rootsConfigPath: this.options.rootsConfigPath,
      inventoryPath: this.options.inventoryPath,
    });
  }

  private openDatabase(): ApplyState {
    const db = new HubDatabase(this.options.dbPath);
    const raw = (db as unknown as { withConnection: <T>(cb: (handle: DatabaseSync) => T) => T })
      .withConnection((handle) => handle);
    const audit = new AuditRepository(raw);
    return { db, raw, audit };
  }

  private runTransaction(state: ApplyState, body: () => void): void {
    state.raw.exec('BEGIN IMMEDIATE');
    try {
      body();
      state.raw.exec('COMMIT');
    } catch (error) {
      try {
        state.raw.exec('ROLLBACK');
      } catch {
        /* already closed */
      }
      throw error;
    }
  }
}

function scopeEquals(planScope: Scope, actorScope: Scope): boolean {
  return planScope.ownerUserId === actorScope.ownerUserId && planScope.agentId === actorScope.agentId;
}
