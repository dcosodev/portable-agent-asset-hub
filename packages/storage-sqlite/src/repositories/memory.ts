import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ActorContext,
  Memory,
  MemoryCreate,
  MemorySupersede,
  MemoryUpdate,
  Scope,
} from '@portable-agent-asset-hub/core';
import { HubError, notFound, redact, validateMemory } from '@portable-agent-asset-hub/core';
import { AuditRepository } from './audit.js';
import { MemorySourceRepository } from './memory-source.js';
import { MemoryFtsRepository } from '../search/memory-fts.js';

type Row = Record<string, unknown>;
const kinds = ['fact', 'preference', 'decision', 'episode', 'task', 'summary'];

export class MemoryRepository {
  private readonly sources: MemorySourceRepository;
  private readonly fts: MemoryFtsRepository;

  public constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditRepository,
    private readonly actor: ActorContext,
  ) {
    this.sources = new MemorySourceRepository(db);
    this.fts = new MemoryFtsRepository(db);
  }

  public failNextFtsForTest(): void {
    this.fts.failNextUpdateForTest();
  }

  private checkScope(scope: Scope): void {
    if (
      scope.ownerUserId !== this.actor.scope.ownerUserId ||
      scope.agentId !== this.actor.scope.agentId
    ) {
      throw notFound();
    }
  }

  private row(id: string, scope: Scope): Row {
    this.checkScope(scope);
    const row = this.db
      .prepare(
        'SELECT * FROM memories WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId) as Row | undefined;
    if (!row) throw notFound();
    return row;
  }

  private materialize(row: Row, scope: Scope): Memory {
    const version = Number(row.current_version);
    const body = this.db
      .prepare('SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?')
      .get(String(row.id), version) as Row;
    return {
      id: String(row.id),
      kind: row.kind as Memory['kind'],
      scope,
      scopeKey: String(row.scope_key),
      lifecycle: row.lifecycle as Memory['lifecycle'],
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      sourceEventIds: this.sources.ids(String(row.id), version),
      supersedesId: typeof row.supersedes_id === 'string' ? row.supersedes_id : undefined,
      version,
      content: JSON.parse(String(body.content_json)) as Record<string, unknown>,
      redactionSummary: JSON.parse(String(body.redaction_summary_json)) as string[],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private validateCreate(input: MemoryCreate): void {
    if ('supersedesId' in input && input.supersedesId !== undefined) {
      throw new HubError('VALIDATION', 'supersedesId is only valid through supersede()', 400);
    }
    this.checkScope(input.scope);
    if (!kinds.includes(input.kind)) {
      throw new HubError('VALIDATION', 'invalid memory kind', 400);
    }
    validateMemory(
      input.confidence ?? 0.5,
      input.importance ?? 0.5,
      input.lifecycle ?? 'candidate',
    );
  }

  private appendAudit(
    action: string,
    scope: Scope,
    target: string,
    reason: string,
    requestId: string,
    priorVersion: number,
    newVersion: number,
    redactionSummary: string[],
    metadata: Record<string, unknown> = {},
  ): void {
    const safeReason = redact(reason).value;
    this.audit.append({
      action,
      actor: this.actor,
      scope,
      target,
      metadata: {
        ...metadata,
        reason: safeReason,
        requestId,
        priorVersion,
        newVersion,
        redactionSummary,
      },
    });
  }

  public create(input: MemoryCreate): Memory {
    this.validateCreate(input);
    const sourceIds = input.sourceEventIds ?? [];
    const redacted = redact(input.content);
    const now = new Date().toISOString();
    const id = `mem_${randomUUID()}`;
    const lifecycle = input.lifecycle ?? 'candidate';
    const confidence = input.confidence ?? 0.5;
    const importance = input.importance ?? 0.5;
    this.db
      .prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        input.kind,
        input.scope.ownerUserId,
        input.scope.agentId,
        input.scopeKey,
        lifecycle,
        confidence,
        importance,
        null,
        1,
        now,
        now,
      );
    this.db
      .prepare('INSERT INTO memory_versions VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 1, JSON.stringify(redacted.value), JSON.stringify(redacted.summary), lifecycle, now);
    this.sources.validateAndInsert(input.scope, sourceIds, id, 1);
    const memory = this.materialize(this.row(id, input.scope), input.scope);
    this.fts.replace(memory);
    this.appendAudit(
      'memory.create',
      input.scope,
      id,
      input.reason,
      input.requestId,
      0,
      1,
      redacted.summary,
    );
    return memory;
  }

  public get(id: string, scope: Scope): Memory | undefined {
    try {
      return this.materialize(this.row(id, scope), scope);
    } catch (error) {
      if (error instanceof HubError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  public getOrThrow(id: string, scope: Scope): Memory {
    return this.materialize(this.row(id, scope), scope);
  }

  public update(id: string, input: MemoryUpdate, scope: Scope): Memory {
    const row = this.row(id, scope);
    const oldVersion = Number(row.current_version);
    if (oldVersion !== input.expectedVersion) {
      throw new HubError('CONFLICT', 'version conflict', 409, {
        expectedVersion: input.expectedVersion,
        actualVersion: oldVersion,
      });
    }
    if (row.lifecycle === 'forgotten') {
      throw new HubError('CONFLICT', 'forgotten memory cannot update', 409);
    }
    const oldBody = this.db
      .prepare('SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?')
      .get(id, oldVersion) as Row;
    const content = input.content ?? JSON.parse(String(oldBody.content_json));
    const sourceIds = input.sourceEventIds ?? this.sources.ids(id, oldVersion);
    const redacted = redact(content);
    const nextVersion = oldVersion + 1;
    const lifecycle = input.lifecycle ?? row.lifecycle as Memory['lifecycle'];
    validateMemory(input.confidence ?? Number(row.confidence), input.importance ?? Number(row.importance), lifecycle);
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE memories SET lifecycle = ?, confidence = ?, importance = ?, current_version = ?, updated_at = ? WHERE id = ? AND current_version = ?',
      )
      .run(
        lifecycle,
        input.confidence ?? Number(row.confidence),
        input.importance ?? Number(row.importance),
        nextVersion,
        now,
        id,
        oldVersion,
      );
    this.db
      .prepare('UPDATE memory_versions SET lifecycle = ? WHERE memory_id = ? AND version = ?')
      .run('superseded', id, oldVersion);
    this.db
      .prepare('INSERT INTO memory_versions VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, nextVersion, JSON.stringify(redacted.value), JSON.stringify(redacted.summary), lifecycle, now);
    this.sources.validateAndInsert(scope, sourceIds, id, nextVersion);
    const memory = this.materialize(this.row(id, scope), scope);
    this.fts.replace(memory);
    this.appendAudit('memory.update', scope, id, input.reason, input.requestId, oldVersion, nextVersion, redacted.summary);
    return memory;
  }

  public supersede(id: string, input: MemorySupersede, scope: Scope): Memory {
    const oldRow = this.row(id, scope);
    const oldVersion = Number(oldRow.current_version);
    if (oldVersion !== input.expectedVersion) {
      throw new HubError('CONFLICT', 'version conflict', 409, {
        expectedVersion: input.expectedVersion,
        actualVersion: oldVersion,
      });
    }
    if (oldRow.lifecycle === 'forgotten') {
      throw new HubError('CONFLICT', 'forgotten memory cannot supersede', 409);
    }
    this.validateCreate(input);
    const sourceIds = input.sourceEventIds ?? this.sources.ids(id, oldVersion);
    const redacted = redact(input.content);
    const now = new Date().toISOString();
    const replacementId = `mem_${randomUUID()}`;
    const lifecycle = input.lifecycle ?? 'candidate';
    this.db
      .prepare('UPDATE memories SET lifecycle = ?, updated_at = ? WHERE id = ? AND current_version = ?')
      .run('superseded', now, id, oldVersion);
    this.db
      .prepare('UPDATE memory_versions SET lifecycle = ? WHERE memory_id = ? AND version = ?')
      .run('superseded', id, oldVersion);
    this.db
      .prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        replacementId,
        input.kind,
        scope.ownerUserId,
        scope.agentId,
        input.scopeKey,
        lifecycle,
        input.confidence ?? 0.5,
        input.importance ?? 0.5,
        id,
        1,
        now,
        now,
      );
    this.db
      .prepare('INSERT INTO memory_versions VALUES (?, ?, ?, ?, ?, ?)')
      .run(replacementId, 1, JSON.stringify(redacted.value), JSON.stringify(redacted.summary), lifecycle, now);
    this.sources.validateAndInsert(scope, sourceIds, replacementId, 1);
    this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(id);
    const replacement = this.materialize(this.row(replacementId, scope), scope);
    this.fts.replace(replacement);
    this.appendAudit(
      'memory.supersede',
      scope,
      id,
      input.reason,
      input.requestId,
      oldVersion,
      1,
      redacted.summary,
      { replacementId },
    );
    return replacement;
  }

  public forget(id: string, expectedVersion: number, scope: Scope, reason = 'forget', requestId = ''): Memory {
    const row = this.row(id, scope);
    if (row.lifecycle === 'forgotten') return this.materialize(row, scope);
    const oldVersion = Number(row.current_version);
    if (oldVersion !== expectedVersion) throw new HubError('CONFLICT', 'version conflict', 409);
    const nextVersion = oldVersion + 1;
    const now = new Date().toISOString();
    const oldBody = this.db
      .prepare('SELECT content_json, redaction_summary_json FROM memory_versions WHERE memory_id = ? AND version = ?')
      .get(id, oldVersion) as Row;
    this.db
      .prepare('UPDATE memories SET lifecycle = ?, current_version = ?, updated_at = ? WHERE id = ? AND current_version = ?')
      .run('forgotten', nextVersion, now, id, oldVersion);
    this.db
      .prepare('UPDATE memory_versions SET lifecycle = ? WHERE memory_id = ? AND version = ?')
      .run('superseded', id, oldVersion);
    this.db
      .prepare('INSERT INTO memory_versions VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, nextVersion, String(oldBody.content_json), String(oldBody.redaction_summary_json), 'forgotten', now);
    this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(id);
    const memory = this.materialize(this.row(id, scope), scope);
    this.appendAudit('memory.forget', scope, id, reason, requestId, oldVersion, nextVersion, memory.redactionSummary);
    return memory;
  }

  public history(id: string, scope: Scope): Memory[] {
    const row = this.row(id, scope);
    const versions = this.db
      .prepare('SELECT version, lifecycle, content_json, redaction_summary_json, created_at FROM memory_versions WHERE memory_id = ? ORDER BY version')
      .all(id) as Row[];
    return versions.map((version) => ({
      ...this.materialize({ ...row, current_version: version.version, lifecycle: version.lifecycle }, scope),
      version: Number(version.version),
      lifecycle: version.lifecycle as Memory['lifecycle'],
      content: JSON.parse(String(version.content_json)) as Record<string, unknown>,
      redactionSummary: JSON.parse(String(version.redaction_summary_json)) as string[],
      createdAt: String(version.created_at),
    }));
  }

  public provenance(id: string, scope: Scope): string[] {
    this.row(id, scope);
    return this.sources.ids(id);
  }

  public search(scope: Scope, query: string, limit = 20): Memory[] {
    this.checkScope(scope);
    return this.fts.search(scope, query, limit).map((row) => this.materialize(row, scope));
  }
}
