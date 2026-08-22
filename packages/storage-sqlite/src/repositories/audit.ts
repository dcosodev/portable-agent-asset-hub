import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditEvent, Scope } from '@portable-agent-asset-hub/core';
import { HubError } from '@portable-agent-asset-hub/core';

type Row = Record<string, unknown>;

export class AuditRepository {
  private failNext = false;

  public constructor(private readonly db: DatabaseSync) {}

  public failNextAppendForTest(): void {
    this.failNext = true;
  }

  public append(event: Omit<AuditEvent, 'id' | 'createdAt'>): AuditEvent {
    if (this.failNext) {
      this.failNext = false;
      throw new HubError('INTERNAL', 'audit append failed', 500);
    }
    const value: AuditEvent = {
      ...event,
      id: `aud_${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      value.id,
      value.action,
      value.capability ?? null,
      value.actor.userId,
      value.actor.agentId,
      value.actor.harnessId ?? null,
      value.scope.ownerUserId,
      value.scope.agentId,
      value.target ?? null,
      value.requestDigest ?? null,
      value.metadata ? JSON.stringify(value.metadata) : null,
      value.createdAt,
    );
    return value;
  }

  public list(scope?: Scope): AuditEvent[] {
    const statement = scope
      ? this.db.prepare('SELECT * FROM audit WHERE owner_user_id=? AND scope_agent_id=?')
      : this.db.prepare('SELECT * FROM audit');
    const rows = (scope ? statement.all(scope.ownerUserId, scope.agentId) : statement.all()) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      capability: typeof row.capability === 'string' ? row.capability as AuditEvent['capability'] : undefined,
      actor: {
        userId: String(row.actor_user_id),
        agentId: String(row.actor_agent_id),
        harnessId: typeof row.actor_harness_id === 'string' ? row.actor_harness_id : undefined,
      },
      scope: { ownerUserId: String(row.owner_user_id), agentId: String(row.scope_agent_id) },
      target: typeof row.target === 'string' ? row.target : undefined,
      requestDigest: typeof row.request_digest === 'string' ? row.request_digest : undefined,
      metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
      createdAt: String(row.created_at),
    }));
  }
}
