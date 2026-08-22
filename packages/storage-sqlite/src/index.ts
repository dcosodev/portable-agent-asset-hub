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
import { transaction } from './transaction.js';
export { backupDatabase };

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
  };
};

export class SqliteStore implements Storage {
  readonly #database: HubDatabase;

  public constructor(path: string) {
    this.#database = new HubDatabase(path);
  }

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
        },
      };
    });
  }
}

export { HubError };
