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
    // Unlike SqliteSkillRepository's skill/catalog FTS (which quotes
    // every token to force a literal search), memory search
    // deliberately passes the raw query straight through as an FTS5
    // MATCH expression: `hybrid_or_fts_never_bypasses_scope` in
    // tests/s3-memory.test.ts exercises an explicit `OR` combinator as
    // an intentional, tested feature, so quoting it away here would be
    // a behavior regression, not a fix. What IS a bug is that
    // malformed syntax (an unbalanced quote, a dangling operator)
    // throws a raw node:sqlite ERR_SQLITE_ERROR straight out of this
    // method, which the REST/MCP error mappers don't know how to turn
    // into anything but an unhandled 500. Translate that one failure
    // mode into a clean, expected HubError instead, without touching
    // how a well-formed query (including one that uses FTS5 operators
    // on purpose) is matched.
    try {
      return this.db
        .prepare(
          "SELECT m.* FROM memory_fts f JOIN memories m ON m.id = f.memory_id " +
          "WHERE f.owner_user_id = ? AND f.agent_id = ? AND f.content MATCH ? " +
          "AND m.lifecycle IN ('candidate', 'active') ORDER BY bm25(memory_fts) LIMIT ?",
        )
        .all(scope.ownerUserId, scope.agentId, query, limit) as Row[];
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR') {
        throw new HubError('VALIDATION', `invalid search query: ${error.message}`, 400);
      }
      throw error;
    }
  }
}
