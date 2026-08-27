import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorContext, AgentId, Capability, CredentialBinding, HarnessId, IssuedCredential, UserId } from '@portable-agent-asset-hub/core';
import { actorContextFromCredential, hashCredential, issueCredential } from '@portable-agent-asset-hub/core';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const credentialId = (): string => `cred_${randomUUID()}`;

function binding(row: Row): CredentialBinding {
  const capabilities = JSON.parse(String(row.capabilities_json)) as Capability[];
  return Object.freeze({
    credentialId: String(row.id), userId: String(row.user_id) as UserId, agentId: String(row.agent_id) as AgentId,
    runtime: String(row.runtime), profile: String(row.profile),
    harnessId: typeof row.harness_id === 'string' ? row.harness_id as HarnessId : undefined,
    role: String(row.role) as CredentialBinding['role'], capabilities: Object.freeze(capabilities),
    scope: Object.freeze({ ownerUserId: String(row.user_id) as UserId, agentId: String(row.agent_id) as AgentId }),
    status: row.revoked_at === null ? 'active' : 'revoked', createdAt: String(row.created_at),
    revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : undefined,
  });
}

export class CredentialRepository {
  public constructor(private readonly db: DatabaseSync) {}
  public create(input: { userId: UserId; agentId: AgentId; runtime: string; profile: string; harnessId?: HarnessId; role: CredentialBinding['role']; capabilities: readonly Capability[] }): IssuedCredential {
    const issued = issueCredential({ credentialId: credentialId(), ...input });
    this.db.prepare('INSERT INTO runtime_credentials VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(issued.id, hashCredential(issued.token), issued.fingerprint, input.userId, input.agentId, input.runtime, input.profile, input.harnessId ?? null, input.role, JSON.stringify(input.capabilities), issued.binding.createdAt, null);
    return issued;
  }
  public getByToken(token: string): CredentialBinding | undefined {
    const row = this.db.prepare('SELECT * FROM runtime_credentials WHERE token_hash=?').get(hashCredential(token)) as Row | undefined;
    return row ? binding(row) : undefined;
  }
  public list(): CredentialBinding[] { return (this.db.prepare('SELECT * FROM runtime_credentials ORDER BY created_at').all() as Row[]).map(binding); }
  public rotate(id: string): IssuedCredential {
    const current = this.db.prepare('SELECT * FROM runtime_credentials WHERE id=?').get(id) as Row | undefined;
    if (!current) throw new Error('credential not found');
    this.revoke(id);
    return this.create({ userId: String(current.user_id) as UserId, agentId: String(current.agent_id) as AgentId, runtime: String(current.runtime), profile: String(current.profile), harnessId: typeof current.harness_id === 'string' ? current.harness_id as HarnessId : undefined, role: String(current.role) as CredentialBinding['role'], capabilities: JSON.parse(String(current.capabilities_json)) as Capability[] });
  }
  public revoke(id: string): void { this.db.prepare('UPDATE runtime_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(now(), id); }
  public authenticate(token: string, requestId: string, requested?: readonly string[]): ActorContext | null {
    const candidate = this.getByToken(token);
    const result = candidate?.status === 'revoked' ? 'revoked' : candidate ? 'authenticated' : 'rejected';
    const actor = candidate && result === 'authenticated' ? actorContextFromCredential(candidate, requested) : null;
    this.db.prepare('INSERT INTO auth_events VALUES(?,?,?,?,?,?,?,?,?)').run(`auth_${randomUUID()}`, candidate?.credentialId ?? null, candidate?.userId ?? null, candidate?.agentId ?? null, candidate?.runtime ?? null, candidate?.profile ?? null, requestId, result, now());
    return actor;
  }
}