import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorContext, Binding, BindingId, Scope } from '@portable-agent-asset-hub/core';
import { auditActor, HubError } from '@portable-agent-asset-hub/core';
import type { AuditRepository } from './audit.js';

type Row = Record<string, unknown>;
const value = (row: Row, key: string): string => {
  const result = row[key];
  if (typeof result !== 'string') throw new HubError('INTERNAL', `invalid binding row: ${key}`, 500);
  return result;
};

export class BindingRepository {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditRepository,
    private readonly actor: ActorContext,
  ) {}

  public create(input: { assetId: string; scope: Scope; harnessId: string; expectedVersion?: number }): Binding {
    const owner = this.db.prepare('SELECT owner_user_id FROM agents WHERE id=?').get(input.scope.agentId) as Row | undefined;
    if (!owner || value(owner, 'owner_user_id') !== input.scope.ownerUserId) throw new HubError('NOT_FOUND', 'resource not found', 404);
    if (!this.db.prepare('SELECT id FROM harnesses WHERE id=?').get(input.harnessId)) throw new HubError('NOT_FOUND', 'resource not found', 404);
    const prior = this.db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM bindings WHERE asset_id=? AND owner_user_id=? AND agent_id=? AND harness_id=?').get(input.assetId, input.scope.ownerUserId, input.scope.agentId, input.harnessId) as Row;
    const current = Number(prior.version ?? 0);
    if (input.expectedVersion !== undefined && input.expectedVersion !== current) throw new HubError('CONFLICT', 'binding version compare-and-swap failed', 409);
    const binding: Binding = {
      id: `bnd_${randomUUID()}` as BindingId,
      assetId: input.assetId,
      scope: input.scope,
      harnessId: input.harnessId as Binding['harnessId'],
      version: current + 1,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO bindings VALUES(?,?,?,?,?,?,?,?)').run(binding.id, binding.assetId, binding.scope.ownerUserId, binding.scope.agentId, binding.harnessId, binding.version, binding.createdAt, null);
    this.audit.append({
      action: 'binding.create',
      actor: auditActor(this.actor),
      scope: binding.scope,
      target: binding.id,
      metadata: { assetId: binding.assetId, version: binding.version },
    });
    return binding;
  }

  public get(id: string, scope?: Scope): Binding | undefined {
    const row = this.db.prepare('SELECT id,asset_id,owner_user_id,agent_id,harness_id,version,created_at,revoked_at FROM bindings WHERE id=?').get(id) as Row | undefined;
    if (!row) return undefined;
    const ownerUserId = value(row, 'owner_user_id');
    const agentId = value(row, 'agent_id');
    if (scope && (ownerUserId !== scope.ownerUserId || agentId !== scope.agentId)) return undefined;
    return {
      id: value(row, 'id') as BindingId,
      assetId: value(row, 'asset_id'),
      scope: { ownerUserId: ownerUserId as Scope['ownerUserId'], agentId: agentId as Scope['agentId'] },
      harnessId: value(row, 'harness_id') as Binding['harnessId'],
      version: Number(row.version),
      createdAt: value(row, 'created_at'),
      revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : undefined,
    };
  }

  public getOrThrow(id: string, scope: Scope): Binding {
    const binding = this.get(id, scope);
    if (!binding) throw new HubError('NOT_FOUND', 'resource not found', 404);
    return binding;
  }
}
