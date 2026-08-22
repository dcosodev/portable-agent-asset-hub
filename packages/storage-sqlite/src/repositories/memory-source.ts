import type { DatabaseSync } from 'node:sqlite';
import type { Scope } from '@portable-agent-asset-hub/core';
import { notFound } from '@portable-agent-asset-hub/core';

type Row = Record<string, unknown>;

export class MemorySourceRepository {
  public constructor(private readonly db: DatabaseSync) {}

  public validateAndInsert(scope: Scope, ids: string[], memoryId: string, version: number): void {
    for (const eventId of ids) {
      const event = this.db
        .prepare('SELECT owner_user_id, scope_agent_id FROM events WHERE id = ?')
        .get(eventId) as Row | undefined;
      if (
        !event ||
        event.owner_user_id !== scope.ownerUserId ||
        event.scope_agent_id !== scope.agentId
      ) {
        throw notFound();
      }
      this.db
        .prepare('INSERT INTO memory_sources VALUES (?, ?, ?)')
        .run(memoryId, version, eventId);
    }
  }

  public ids(memoryId: string, version?: number): string[] {
    const query = version === undefined
      ? 'SELECT event_id FROM memory_sources WHERE memory_id = ? ORDER BY version, event_id'
      : 'SELECT event_id FROM memory_sources WHERE memory_id = ? AND version = ? ORDER BY event_id';
    const rows = (version === undefined
      ? this.db.prepare(query).all(memoryId)
      : this.db.prepare(query).all(memoryId, version)) as Row[];
    return rows.map((row) => String(row.event_id));
  }
}
