import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  HubError,
  auditActor,
  notFound,
  type ActorContext,
  type AuditRepository,
  type ImportPreview,
  type MaterializationRecord,
  type MaterializationRepository as MaterializationRepositoryContract,
  type MutationMeta,
  type Profile,
  type ProfileBlock,
  type ProfileRepository as ProfileRepositoryContract,
  type ProfileScope,
} from '@portable-agent-asset-hub/core';

type Row = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function requireMeta(meta: MutationMeta): MutationMeta {
  if (!meta?.reason || !meta.requestId) throw new HubError('VALIDATION', 'reason and requestId required', 400);
  return meta;
}

function canonicalBlocks(blocks: ProfileBlock[]): ProfileBlock[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(block.blockId) || ids.has(block.blockId) ||
        !Number.isInteger(block.ordinal) || block.ordinal < 0 ||
        !['USER', 'MEMORY'].includes(block.kind) || typeof block.body !== 'string') {
      throw new HubError('VALIDATION', 'invalid or duplicate block', 400);
    }
    ids.add(block.blockId);
  }
  return clone([...blocks].sort(
    (left, right) => left.ordinal - right.ordinal || left.blockId.localeCompare(right.blockId),
  ));
}

export class SqliteProfileRepository implements ProfileRepositoryContract {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly actor: ActorContext,
    private readonly audit: AuditRepository,
    private readonly assertActive: () => void,
  ) {}

  private scope(scope: ProfileScope): void {
    this.assertActive();
    if (!scope.ownerUserId || !scope.agentId) throw new HubError('VALIDATION', 'scope required', 400);
    if (scope.ownerUserId !== this.actor.userId || scope.agentId !== this.actor.agentId) throw notFound();
  }

  private row(id: string): Row {
    const scope = this.actor.scope;
    const row = this.db.prepare(
      'SELECT * FROM profiles WHERE id=? AND owner_user_id=? AND scope_agent_id=?',
    ).get(id, scope.ownerUserId, scope.agentId) as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  private make(row: Row, version = Number(row.current_version)): Profile {
    const scope = this.actor.scope;
    const versionRow = this.db.prepare(
      'SELECT blocks_json FROM profile_versions WHERE id=? AND owner_user_id=? AND scope_agent_id=? AND version=?',
    ).get(String(row.id), scope.ownerUserId, scope.agentId, version) as Row | undefined;
    if (!versionRow) throw new HubError('INTERNAL', 'profile version missing', 500);
    return {
      id: String(row.id),
      scope: { ...scope },
      version,
      blocks: clone(JSON.parse(String(versionRow.blocks_json)) as ProfileBlock[]),
    };
  }

  private appendAudit(action: string, target: string, meta: MutationMeta, metadata: Record<string, unknown> = {}): void {
    const checked = requireMeta(meta);
    this.audit.append({
      action,
      actor: auditActor(this.actor),
      scope: this.actor.scope,
      target,
      metadata: { reason: checked.reason, requestId: checked.requestId, ...metadata },
    });
  }

  private updateWithAction(
    id: string,
    scope: ProfileScope,
    expectedVersion: number,
    blocks: ProfileBlock[],
    meta: MutationMeta,
    action: string,
    auditMetadata: Record<string, unknown> = {},
  ): Profile {
    this.scope(scope);
    const sorted = canonicalBlocks(blocks);
    const row = this.row(id);
    const currentVersion = Number(row.current_version);
    if (currentVersion !== expectedVersion) throw new HubError('CONFLICT', 'version conflict', 409);
    const nextVersion = currentVersion + 1;
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'UPDATE profiles SET current_version=?,updated_at=? WHERE id=? AND owner_user_id=? AND scope_agent_id=? AND current_version=?',
    ).run(nextVersion, now, id, scope.ownerUserId, scope.agentId, currentVersion);
    if (Number(result.changes) !== 1) throw new HubError('CONFLICT', 'version conflict', 409);
    this.db.prepare('INSERT INTO profile_versions VALUES(?,?,?,?,?,?)').run(
      id, scope.ownerUserId, scope.agentId, nextVersion, JSON.stringify(sorted), now,
    );
    this.appendAudit(action, id, meta, auditMetadata);
    return this.make({ ...row, current_version: nextVersion });
  }

  public create(profile: Profile, meta: MutationMeta): Profile {
    this.scope(profile.scope);
    if (!/^prf_[A-Za-z0-9._-]+$/u.test(profile.id) || profile.version !== 1) {
      throw new HubError('VALIDATION', 'invalid initial profile', 400);
    }
    const blocks = canonicalBlocks(profile.blocks);
    const now = new Date().toISOString();
    try {
      this.db.prepare('INSERT INTO profiles VALUES(?,?,?,?,?,?)').run(
        profile.id, profile.scope.ownerUserId, profile.scope.agentId, 1, now, now,
      );
      this.db.prepare('INSERT INTO profile_versions VALUES(?,?,?,?,?,?)').run(
        profile.id, profile.scope.ownerUserId, profile.scope.agentId, 1, JSON.stringify(blocks), now,
      );
      this.appendAudit('profile.create', profile.id, meta);
      return { ...clone(profile), blocks };
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new HubError('CONFLICT', 'profile already exists', 409);
    }
  }

  public get(id: string, scope: ProfileScope): Profile {
    this.scope(scope);
    return this.make(this.row(id));
  }

  public update(id: string, scope: ProfileScope, expectedVersion: number, blocks: ProfileBlock[], meta: MutationMeta): Profile {
    return this.updateWithAction(id, scope, expectedVersion, blocks, meta, 'profile.update');
  }

  public history(id: string, scope: ProfileScope): Profile[] {
    this.scope(scope);
    const row = this.row(id);
    const versions = this.db.prepare(
      'SELECT version FROM profile_versions WHERE id=? AND owner_user_id=? AND scope_agent_id=? ORDER BY version',
    ).all(id, scope.ownerUserId, scope.agentId) as Row[];
    return versions.map((item) => this.make(row, Number(item.version)));
  }

  public createPreview(preview: ImportPreview, meta: MutationMeta): ImportPreview {
    this.scope(preview.scope);
    this.row(preview.profileId);
    const blocks = canonicalBlocks(preview.blocks);
    if (!/^imp_[A-Za-z0-9-]+$/u.test(preview.id) || !/^[0-9a-f]{64}$/u.test(preview.digest) ||
        !/^[0-9a-f]{64}$/u.test(preview.targetDigest) || preview.expiresAt <= Date.now() || preview.used) {
      throw new HubError('VALIDATION', 'invalid preview', 400);
    }
    this.db.prepare('INSERT INTO profile_import_previews VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      preview.id, preview.profileId, preview.scope.ownerUserId, preview.scope.agentId,
      preview.expectedVersion, preview.digest, preview.targetDigest, preview.expiresAt, 0,
      JSON.stringify(blocks),
    );
    this.appendAudit('profile.import.preview', preview.profileId, meta, { previewId: preview.id });
    return { ...clone(preview), blocks };
  }

  public getPreview(id: string, scope: ProfileScope): ImportPreview {
    this.scope(scope);
    const row = this.db.prepare(
      'SELECT * FROM profile_import_previews WHERE id=? AND owner_user_id=? AND scope_agent_id=?',
    ).get(id, scope.ownerUserId, scope.agentId) as Row | undefined;
    if (!row) throw notFound();
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      scope: { ownerUserId: String(row.owner_user_id), agentId: String(row.scope_agent_id) },
      expectedVersion: Number(row.expected_version),
      digest: String(row.digest),
      targetDigest: String(row.target_digest),
      expiresAt: Number(row.expires_at),
      used: Boolean(row.used),
      blocks: canonicalBlocks(JSON.parse(String(row.blocks_json)) as ProfileBlock[]),
    };
  }

  public applyPreview(
    id: string,
    scope: ProfileScope,
    exactDigest: string,
    observedTargetDigest: string,
    meta: MutationMeta,
  ): Profile {
    const preview = this.getPreview(id, scope);
    if (preview.used || preview.expiresAt < Date.now() || preview.digest !== exactDigest ||
        preview.targetDigest !== observedTargetDigest) {
      throw new HubError('CONFLICT', 'preview expired, replayed or drifted', 409);
    }
    const current = this.get(preview.profileId, scope);
    if (current.version !== preview.expectedVersion) throw new HubError('CONFLICT', 'profile drift', 409);
    const output = this.updateWithAction(
      current.id, scope, current.version, preview.blocks, meta, 'profile.import.apply', { previewId: id },
    );
    const consumed = this.db.prepare(
      'UPDATE profile_import_previews SET used=1 WHERE id=? AND owner_user_id=? AND scope_agent_id=? AND used=0 AND expires_at>=?',
    ).run(id, scope.ownerUserId, scope.agentId, Date.now());
    if (Number(consumed.changes) !== 1) throw new HubError('CONFLICT', 'preview expired or replayed', 409);
    return output;
  }

  public restore(
    id: string,
    scope: ProfileScope,
    snapshotVersion: number,
    expectedVersion: number,
    meta: MutationMeta,
  ): Profile {
    const snapshot = this.history(id, scope).find((profile) => profile.version === snapshotVersion);
    if (!snapshot) throw notFound();
    return this.updateWithAction(
      id, scope, expectedVersion, snapshot.blocks, meta, 'profile.restore', { snapshotVersion },
    );
  }
}

export class SqliteMaterializationRepository implements MaterializationRepositoryContract {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly actor: ActorContext,
    private readonly audit: AuditRepository,
    private readonly assertActive: () => void,
  ) {}

  private check(scope: ProfileScope): void {
    this.assertActive();
    if (scope.ownerUserId !== this.actor.userId || scope.agentId !== this.actor.agentId) throw notFound();
  }

  public record(input: Omit<MaterializationRecord, 'id' | 'createdAt'>, meta: MutationMeta): MaterializationRecord {
    this.check(input.scope);
    requireMeta(meta);
    const profile = this.db.prepare(
      'SELECT current_version FROM profiles WHERE id=? AND owner_user_id=? AND scope_agent_id=?',
    ).get(input.profileId, input.scope.ownerUserId, input.scope.agentId) as Row | undefined;
    if (!profile || Number(profile.current_version) !== input.version ||
        !/^[0-9a-f]{64}$/u.test(input.digest) || input.bytes.length < 1) throw notFound();
    const output = { ...input, id: `mat_${randomUUID()}`, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO profile_materializations VALUES(?,?,?,?,?,?,?,?,?)').run(
      output.id, output.profileId, output.scope.ownerUserId, output.scope.agentId,
      output.version, output.target, output.digest, output.bytes, output.createdAt,
    );
    this.audit.append({
      action: 'profile.materialize',
      actor: auditActor(this.actor),
      scope: this.actor.scope,
      target: output.target,
      requestDigest: output.digest,
      metadata: { reason: meta.reason, requestId: meta.requestId, materializationId: output.id },
    });
    return output;
  }

  public list(profileId: string, scope: ProfileScope): MaterializationRecord[] {
    this.check(scope);
    return (this.db.prepare(
      'SELECT * FROM profile_materializations WHERE profile_id=? AND owner_user_id=? AND scope_agent_id=? ORDER BY created_at,id',
    ).all(profileId, scope.ownerUserId, scope.agentId) as Row[]).map((row) => ({
      id: String(row.id),
      profileId: String(row.profile_id),
      scope: { ownerUserId: String(row.owner_user_id), agentId: String(row.scope_agent_id) },
      version: Number(row.version),
      target: String(row.target),
      digest: String(row.digest),
      bytes: Buffer.from(row.bytes as Uint8Array),
      createdAt: String(row.created_at),
    }));
  }
}
