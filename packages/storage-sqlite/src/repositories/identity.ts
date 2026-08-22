import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorContext, Agent, Harness, User, UserId } from '@portable-agent-asset-hub/core';
import { auditActor, HubError } from '@portable-agent-asset-hub/core';
import type { AuditRepository } from './audit.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}_${randomUUID()}`;

function rowValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new HubError('INTERNAL', `invalid identity row: ${key}`, 500);
  return value;
}

export class IdentityRepository {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditRepository,
    private readonly actor: ActorContext,
  ) {}

  public createUser(input: { displayName: string }): User {
    const value: User = { id: id('usr') as UserId, kind: 'user', displayName: input.displayName, createdAt: now() };
    this.db.prepare('INSERT INTO users VALUES(?,?,?)').run(value.id, value.displayName, value.createdAt);
    this.audit.append({
      action: 'identity.user.create',
      actor: auditActor(this.actor),
      scope: { ownerUserId: value.id, agentId: this.actor.agentId },
      target: value.id,
    });
    return value;
  }

  public createAgent(input: { ownerUserId: UserId; name: string }): Agent {
    if (!this.getUser(input.ownerUserId)) throw new HubError('NOT_FOUND', 'resource not found', 404);
    const value: Agent = {
      id: id('agt') as Agent['id'],
      kind: 'agent',
      ownerUserId: input.ownerUserId,
      name: input.name,
      createdAt: now(),
    };
    this.db.prepare('INSERT INTO agents VALUES(?,?,?,?)').run(value.id, value.ownerUserId, value.name, value.createdAt);
    this.audit.append({
      action: 'identity.agent.create',
      actor: auditActor(this.actor),
      scope: { ownerUserId: value.ownerUserId, agentId: value.id },
      target: value.id,
    });
    return value;
  }

  public createHarness(input: { name: string; runtime: string }): Harness {
    const value: Harness = {
      id: id('hrn') as Harness['id'],
      kind: 'harness',
      name: input.name,
      runtime: input.runtime,
      createdAt: now(),
    };
    this.db.prepare('INSERT INTO harnesses VALUES(?,?,?,?)').run(value.id, value.name, value.runtime, value.createdAt);
    this.audit.append({
      action: 'identity.harness.create',
      actor: auditActor(this.actor),
      scope: this.actor.scope,
      target: value.id,
    });
    return value;
  }

  public getUser(id: string): User | undefined {
    const row = this.db.prepare('SELECT id,display_name,created_at FROM users WHERE id=?').get(id) as Row | undefined;
    return row ? { id: rowValue(row, 'id') as UserId, kind: 'user', displayName: rowValue(row, 'display_name'), createdAt: rowValue(row, 'created_at') } : undefined;
  }

  public getAgent(id: string): Agent | undefined {
    const row = this.db.prepare('SELECT id,owner_user_id,name,created_at FROM agents WHERE id=?').get(id) as Row | undefined;
    return row ? { id: rowValue(row, 'id') as Agent['id'], kind: 'agent', ownerUserId: rowValue(row, 'owner_user_id') as UserId, name: rowValue(row, 'name'), createdAt: rowValue(row, 'created_at') } : undefined;
  }

  public getHarness(id: string): Harness | undefined {
    const row = this.db.prepare('SELECT id,name,runtime,created_at FROM harnesses WHERE id=?').get(id) as Row | undefined;
    return row ? { id: rowValue(row, 'id') as Harness['id'], kind: 'harness', name: rowValue(row, 'name'), runtime: rowValue(row, 'runtime'), createdAt: rowValue(row, 'created_at') } : undefined;
  }
}
