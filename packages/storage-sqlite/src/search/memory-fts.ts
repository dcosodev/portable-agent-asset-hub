import type { DatabaseSync } from 'node:sqlite';
import type { Memory, Scope } from '@portable-agent-asset-hub/core';
import { HubError } from '@portable-agent-asset-hub/core';

type Row = Record<string, unknown>;

export class MemoryFtsRepository {
  private failNext = false;

  public constructor(private readonly db: DatabaseSync) {}

  public failNextUpdateForTest(): void {
    this.failNext = true;
  }

  public replace(memory: Memory): void {
    if (this.failNext) {
      this.failNext = false;
      throw new HubError('INTERNAL', 'fts update failed', 500);
    }
    this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memory.id);
    if (memory.lifecycle === 'candidate' || memory.lifecycle === 'active') {
      this.db
        .prepare('INSERT INTO memory_fts VALUES (?, ?, ?, ?, ?)')
        .run(
          memory.id,
          memory.scope.ownerUserId,
          memory.scope.agentId,
          memory.version,
          JSON.stringify(memory.content),
        );
    }
  }

  public search(scope: Scope, query: string, limit: number): Row[] {
    return this.db
      .prepare(
        "SELECT m.* FROM memory_fts f JOIN memories m ON m.id = f.memory_id " +
        "WHERE f.owner_user_id = ? AND f.agent_id = ? AND f.content MATCH ? " +
        "AND m.lifecycle IN ('candidate', 'active') ORDER BY bm25(memory_fts) LIMIT ?",
      )
      .all(scope.ownerUserId, scope.agentId, query, limit) as Row[];
  }
}
