import type {
  ActorContext,
  IdempotencyInput,
  IdempotencyResult,
  Storage,
  StorageTransaction,
} from '@portable-agent-asset-hub/core';
import { auditActor, HubError } from '@portable-agent-asset-hub/core';
import { backupDatabase } from './backup.js';
import { HubDatabase } from './database.js';
import type { DoctorReport } from './doctor.js';
import { BindingRepository } from './repositories/binding.js';
import { EventRepository } from './repositories/event.js';
import { IdempotencyRepository } from './repositories/idempotency.js';
import { IdentityRepository } from './repositories/identity.js';
import { MemoryRepository } from './repositories/memory.js';
import { CredentialRepository } from './repositories/credential.js';
import { SqliteExplicitRelationSource } from './repositories/explicit-relations.js';
import { transaction } from './transaction.js';
// NOTE: HubDatabase is intentionally not re-exported from the public
// surface; tests that need to open a parallel connection use the
// @portable-agent-asset-hub/storage-sqlite/internal entry point.
export { backupDatabase };
export { SkillPackApplyCoordinator, type SkillPackApplyCoordinatorOptions } from './skill-pack-coordinator.js';
export { SqliteExplicitRelationSource };

type Transaction = StorageTransaction;
export type StorageDiagnostics = {
  counts: {
    users: number;
    agents: number;
    audit: number;
    memories: number;
    memoryVersions: number;
    memorySources: number;
    memoryFts: number;
    canonicalRelations: number;
    relationProposals: number;
    approvedProposals: number;
    rejectedProposals: number;
    staleProposals: number;
    isolatedSkills: number;
  };
};

export class SqliteStore implements Storage {
  readonly #database: HubDatabase;
  readonly #databasePath: string;

  public constructor(path: string) {
    this.#databasePath = path;
    this.#database = new HubDatabase(path);
  }

  /** Returns the absolute filesystem path to the underlying SQLite database.
   * Intended for diagnostics, tests, and tooling. */
  public get databasePath(): string {
    return this.#databasePath;
  }

  public createCredential(input: Parameters<CredentialRepository['create']>[0]): ReturnType<CredentialRepository['create']> {
    return this.#database.withConnection((db) => { db.exec('BEGIN IMMEDIATE'); try { const value = new CredentialRepository(db).create(input); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } });
  }
  public authenticateCredential(token: string, requestId: string, requested?: readonly string[]): ActorContext | null {
    return this.#database.withConnection((db) => { db.exec('BEGIN IMMEDIATE'); try { const value = new CredentialRepository(db).authenticate(token, requestId, requested); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } });
  }
  public revokeCredential(id: string): void { this.#database.withConnection((db) => { db.exec('BEGIN IMMEDIATE'); try { new CredentialRepository(db).revoke(id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }); }
  public rotateCredential(id: string): ReturnType<CredentialRepository['rotate']> { return this.#database.withConnection((db) => { db.exec('BEGIN IMMEDIATE'); try { const value = new CredentialRepository(db).rotate(id); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }); }
  public listCredentials(): ReturnType<CredentialRepository['list']> { return this.#database.withConnection((db) => new CredentialRepository(db).list()); }

  public transaction<T>(actor: ActorContext, fn: (tx: Transaction) => T): T {
    return this.#database.withConnection((db) => transaction(db, actor, fn, (audit) => {
      const events = new EventRepository(db, audit, actor);
      const memories = new MemoryRepository(db, audit, actor);
      return {
        identities: new IdentityRepository(db, audit, actor),
        bindings: new BindingRepository(db, audit, actor),
        idempotency: new IdempotencyRepository(db),
        audit,
        events,
        memories,
      };
    }));
  }

  public idempotent<T>(actor: ActorContext, input: IdempotencyInput, fn: (tx: Transaction) => T): IdempotencyResult<T> {
    if (input.actorId !== actor.userId && input.actorId !== actor.agentId) {
      throw new HubError('FORBIDDEN', 'idempotency actor mismatch', 403);
    }
    return this.transaction(actor, (tx) => {
      const old = tx.idempotency.get(input.actorId, input.operation, input.key);
      if (old) {
        tx.idempotency.assertDigest(old, input.digest);
        return { replayed: true, value: JSON.parse(old.responseJson) as T };
      }
      const value = fn(tx);
      tx.idempotency.put({
        key: input.key,
        actorId: input.actorId,
        operation: input.operation,
        requestDigest: input.digest,
        responseJson: JSON.stringify(value),
        status: 200,
        createdAt: new Date().toISOString(),
      });
      tx.audit.append({
        action: 'idempotency.complete',
        actor: auditActor(actor),
        scope: actor.scope,
        target: `${input.operation}:${input.key}`,
        requestDigest: input.digest,
      });
      return { replayed: false, value };
    });
  }

  public close(): void {
    this.#database.close();
  }

  public doctor(): DoctorReport {
    return this.#database.doctor();
  }

  public diagnostics(): StorageDiagnostics {
    return this.#database.withConnection((db) => {
      const count = (table: string): number => Number(
        (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
      );
      return {
        counts: {
          users: count('users'),
          agents: count('agents'),
          audit: count('audit'),
          memories: count('memories'),
          memoryVersions: count('memory_versions'),
          memorySources: count('memory_sources'),
          memoryFts: count('memory_fts'),
          canonicalRelations: count('skill_relations'),
          relationProposals: count('skill_relation_proposals'),
          approvedProposals: Number((db.prepare("SELECT COUNT(*) AS count FROM skill_relation_proposals WHERE status='approved'").get() as { count: number }).count),
          rejectedProposals: Number((db.prepare("SELECT COUNT(*) AS count FROM skill_relation_proposals WHERE status='rejected'").get() as { count: number }).count),
          staleProposals: Number((db.prepare("SELECT COUNT(*) AS count FROM skill_relation_proposals WHERE status='stale'").get() as { count: number }).count),
          isolatedSkills: Number((db.prepare(`SELECT COUNT(*) AS count FROM skill_entries e WHERE e.lifecycle='active' AND NOT EXISTS (SELECT 1 FROM skill_relations r WHERE r.owner_user_id=e.owner_user_id AND r.scope_agent_id=e.scope_agent_id AND (r.source_skill_id=e.id OR r.target_skill_id=e.id))`).get() as { count: number }).count),
        },
      };
    });
  }
}

export { HubError };
