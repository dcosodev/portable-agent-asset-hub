// packages/storage-sqlite/src/repositories/skill.ts
//
// SQLite implementation of the `SkillRepository` contract.
//
//   * Bodies and resource bytes are persisted inline (BLOB); SQLite
//     is the authority and the same file can be reopened by a fresh
//     `SqliteStore` and read back via `skillGet` / `resourceRead`.
//   * Writes are CAS-guarded by `skill_entries.current_version`.
//     `expectedVersion` must match the head version (or be `0` /
//     `undefined` for the first write); mismatches surface as
//     `CONFLICT` with HTTP 409.
//   * All writes append a single audit row referencing the
//     `version`, `size`, and the resource count — never the body
//     bytes or the resource bytes (so secrets cannot leak via logs).
//   * All reads enforce the actor's scope; cross-scope reads throw
//     `NOT_FOUND` (HTTP 404).
//
// FTS coverage:
//   * `skill_fts` mirrors `skill_entries` for `lifecycle = 'active'`.
//   * Indexed columns: logical_key, name, summary, tags (from
//     metadata), body. Resource bytes are NEVER indexed.
//   * `skillSearch` ranks by `bm25(skill_fts)` with `body` given
//     the lowest weight (via `bm25` weights — `body` has the
//     longest text and the natural `unicode61` tokenizer).

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  HubError,
  type ActorContext,
  type AuditRepository,
  type Scope,
  type SkillHeadSummary,
  type SkillLifecycle,
  type SkillRepository,
  type SkillResourceMeta,
  type SkillResourceRecord,
  type SkillSearchHit,
  type SkillVersion,
  type SkillWriteInput,
  type SkillRelation,
  type SkillRelationInput,
  type ResolvedSkillGraph,
  type RetrievalLimits,
  type RetrievalResolution,
  type RetrievalSkillSelection,
  type CenteredGraphOptions,
  type GlobalGraphOptions,
  type ImpactOptions,
  type GlobalSkillGraph,
  type SkillGraphResponse,
  type SkillImpactResponse,
  type RetrievalEventSummary,
  type RetrievalEventGraphResponse,
  type GraphNodeMaterialization,
  type GraphRelationRow,
  type GraphSkillNode,
  buildCenteredSkillGraph,
  buildGlobalSkillGraph,
  buildSkillImpact,
  RETRIEVAL_EVENTS_DEFAULT_LIMIT,
  RETRIEVAL_EVENTS_MAX_LIMIT,
} from '@portable-agent-asset-hub/core';
import {
  boundedAuditQuery,
  classifyRetrievalRequest,
  DEFAULT_RETRIEVAL_LIMITS,
  parseSkillVersionSelector,
  retrievalKeywords,
  retrievalPolicy,
  retrievalQueryDigest,
  scanBuffer,
  SKILL_GRAPH_LIMITS,
  SKILL_RELATION_TYPES,
  SKILL_SEARCH_LIMIT_DEFAULT,
  SKILL_SEARCH_LIMIT_MAX,
  validateRelationInput,
  versionSatisfies,
  validateResourcePath,
  validateSkillInput,
} from '@portable-agent-asset-hub/core';

const now = (): string => new Date().toISOString();

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Canonical fingerprint over the sorted list of resource paths and
 * sha256 hashes. Used to short-circuit no-op writes in `writeSkill`.
 */
export function computeResourceFingerprint(resources: Array<{ relativePath: string; sha256: string }>): string {
  const sorted = [...resources].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return createHash('sha256')
    .update(sorted.map((resource) => `${resource.relativePath}\t${resource.sha256}`).join('\n'))
    .digest('hex');
}

function notFound(): HubError {
  return new HubError('NOT_FOUND', 'skill not found', 404);
}

export class SqliteSkillRepository implements SkillRepository {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly actor: ActorContext,
    private readonly audit: AuditRepository,
    private readonly assertActive: () => void,
  ) {}

  /**
   * Validate the actor is present and matches the scope of the
   * write/read. The contract is actor-bound; every method calls
   * this guard up front so callers cannot bypass it.
   */
  private guard(): void {
    this.assertActive();
    if (!this.actor) throw new HubError('FORBIDDEN', 'actor-bound skill repository required', 403);
  }

  private checkScope(scope: Scope): void {
    if (
      !scope.ownerUserId ||
      !scope.agentId ||
      scope.ownerUserId !== this.actor.scope.ownerUserId ||
      scope.agentId !== this.actor.scope.agentId
    ) {
      throw notFound();
    }
  }

  public writeSkill(input: SkillWriteInput, meta: { reason: string; requestId: string }): SkillVersion {
    this.guard();
    const cleaned = validateSkillInput(input);
    this.checkScope(cleaned.scope);
    if (cleaned.scope.ownerUserId !== this.actor.userId || cleaned.scope.agentId !== this.actor.agentId) {
      throw notFound();
    }
    if (!meta?.reason || !meta?.requestId) {
      throw new HubError('VALIDATION', 'reason and requestId are required', 400);
    }
    const t = now();
    const bodySha = sha256(cleaned.body);
    const totalSize = cleaned.body.byteLength + cleaned.resources.reduce((sum, r) => sum + r.bytes.byteLength, 0);
    const metadataJson = JSON.stringify(cleaned.metadata);

    const tx = this.db;
    // Load existing head (scoped by actor's scope via FK).
    const existing = tx
      .prepare(
        'SELECT current_version, lifecycle FROM skill_entries WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ?',
      )
      .get(cleaned.id, cleaned.scope.ownerUserId, cleaned.scope.agentId) as
      | { current_version: number; lifecycle: SkillLifecycle }
      | undefined;

    const expected = cleaned.expectedVersion ?? 0;
    const effectiveRelations: SkillRelationInput[] = cleaned.relations ?? (existing
      ? this.getRelations(cleaned.id, existing.current_version, cleaned.scope).map((relation) => ({
          type: relation.type,
          targetSkillId: relation.targetSkillId,
          targetVersion: relation.resolvedTargetVersion,
          metadata: relation.metadata,
        }))
      : []);
    if (existing) {
      if (expected !== existing.current_version) {
        throw new HubError('CONFLICT', 'skill CAS conflict', 409);
      }
      // Idempotent reapply: if the body sha256, sorted resource
      // sha256 list and lifecycle match the current head, do not
      // create a new version. Returning the materialized head keeps
      // the caller's contract while preventing duplicate writes.
      if (
        bodySha === this.headBodySha256(cleaned.id, existing.current_version, cleaned.scope) &&
        this.headResourceFingerprint(cleaned.id, existing.current_version, cleaned.scope) === computeResourceFingerprint(cleaned.resources.map((resource) => ({ relativePath: resource.relativePath, sha256: sha256(resource.bytes) }))) &&
        this.headLifecycle(cleaned.id, cleaned.scope) === cleaned.lifecycle &&
        this.headMetadata(cleaned.id, cleaned.scope) === metadataJson &&
        this.relationInputFingerprint(cleaned.id, existing.current_version, cleaned.scope) ===
          this.pendingRelationFingerprint(cleaned.id, effectiveRelations, cleaned.scope)
      ) {
        return this.materializeVersion(cleaned.id, existing.current_version, cleaned.scope);
      }
    } else if (expected !== 0) {
      throw new HubError('CONFLICT', 'skill CAS conflict on create', 409);
    }

    const nextVersion = existing ? existing.current_version + 1 : 1;

    if (existing) {
      tx.prepare(
        'UPDATE skill_entries SET logical_key = ?, kind = ?, name = ?, summary = ?, lifecycle = ?, current_version = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ? AND current_version = ?',
      ).run(
        cleaned.logicalKey,
        cleaned.kind,
        cleaned.name,
        cleaned.summary ?? null,
        cleaned.lifecycle,
        nextVersion,
        metadataJson,
        t,
        cleaned.id,
        cleaned.scope.ownerUserId,
        cleaned.scope.agentId,
        existing.current_version,
      );
    } else {
      tx.prepare(
        'INSERT INTO skill_entries(id, owner_user_id, scope_agent_id, logical_key, kind, name, summary, lifecycle, current_version, metadata_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        cleaned.id,
        cleaned.scope.ownerUserId,
        cleaned.scope.agentId,
        cleaned.logicalKey,
        cleaned.kind,
        cleaned.name,
        cleaned.summary ?? null,
        cleaned.lifecycle,
        nextVersion,
        metadataJson,
        t,
        t,
      );
    }

    tx.prepare(
      'INSERT INTO skill_versions(id, owner_user_id, scope_agent_id, version, body, body_sha256, total_size, metadata_json, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      cleaned.id,
      cleaned.scope.ownerUserId,
      cleaned.scope.agentId,
      nextVersion,
      cleaned.body,
      bodySha,
      totalSize,
      metadataJson,
      t,
    );

    for (const resource of cleaned.resources) {
      tx.prepare(
        'INSERT INTO skill_resources(id, owner_user_id, scope_agent_id, version, relative_path, mode, mime, size, sha256, bytes) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        cleaned.id,
        cleaned.scope.ownerUserId,
        cleaned.scope.agentId,
        nextVersion,
        resource.relativePath,
        resource.mode,
        resource.mime,
        resource.bytes.byteLength,
        sha256(resource.bytes),
        resource.bytes,
      );
    }

    this.insertRelations(cleaned.id, nextVersion, effectiveRelations, cleaned.scope, t);

    tx.prepare(
      'INSERT INTO skill_active_head(id, owner_user_id, scope_agent_id, current_version, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id, owner_user_id, scope_agent_id) DO UPDATE SET current_version = excluded.current_version, updated_at = excluded.updated_at',
    ).run(cleaned.id, cleaned.scope.ownerUserId, cleaned.scope.agentId, nextVersion, t);

    // Audit: log version + size only. Never echo body bytes.
    this.audit.append({
      action: 'skill.version written',
      actor: {
        userId: this.actor.userId,
        agentId: this.actor.agentId,
        harnessId: this.actor.harnessId,
      },
      scope: this.actor.scope,
      target: cleaned.id,
      requestDigest: meta.requestId,
      metadata: {
        reason: meta.reason,
        version: nextVersion,
        size: totalSize,
        resources: cleaned.resources.length,
        lifecycle: cleaned.lifecycle,
      },
    });

    return this.materializeVersion(cleaned.id, nextVersion, cleaned.scope);
  }

  public getHeadVersion(id: string, scope: Scope): SkillVersion | undefined {
    this.guard();
    this.checkScope(scope);
    const row = this.db
      .prepare(
        'SELECT current_version FROM skill_entries WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId) as { current_version: number } | undefined;
    if (!row) return undefined;
    return this.materializeVersion(id, row.current_version, scope);
  }

  public getVersion(id: string, version: number, scope: Scope): SkillVersion | undefined {
    this.guard();
    this.checkScope(scope);
    if (!Number.isInteger(version) || version < 1) {
      throw new HubError('VALIDATION', 'version must be a positive integer', 400);
    }
    const row = this.db
      .prepare(
        'SELECT 1 FROM skill_entries WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId) as unknown;
    if (!row) return undefined;
    return this.materializeVersion(id, version, scope);
  }

  public skillGet(id: string, scope: Scope): SkillVersion {
    const head = this.getHeadVersion(id, scope);
    if (!head) throw notFound();
    return head;
  }

  public skillSearch(scope: Scope, query: string, limit?: number): SkillSearchHit[] {
    this.guard();
    this.checkScope(scope);
    const q = typeof query === 'string' ? query.trim() : '';
    if (q.length === 0) {
      throw new HubError('VALIDATION', 'q must be a non-empty string', 400);
    }
    const effectiveLimit =
      typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= SKILL_SEARCH_LIMIT_MAX
        ? limit
        : SKILL_SEARCH_LIMIT_DEFAULT;
    // Tokenize on whitespace and quote each token to defeat FTS5
    // operator injection. Match across all indexed columns.
    const tokens = q.split(/\s+/u).filter(Boolean).map((token) => `"${token.replaceAll('"', '""')}"`);
    const expression = tokens.join(' AND ');
    const rows = this.db
      .prepare(
        "SELECT e.id FROM skill_fts f JOIN skill_entries e ON e.id = f.id AND e.owner_user_id = f.owner_user_id AND e.scope_agent_id = f.scope_agent_id WHERE f.owner_user_id = ? AND f.scope_agent_id = ? AND f.lifecycle = 'active' AND skill_fts MATCH ? ORDER BY bm25(skill_fts, 6.0, 5.0, 4.0, 4.0, 1.0), e.logical_key LIMIT ?",
      )
      .all(scope.ownerUserId, scope.agentId, expression, effectiveLimit) as Array<{ id: string }>;
    const hits: SkillSearchHit[] = [];
    for (const row of rows) {
      const materialized = this.materializeVersion(row.id, this.headVersion(row.id, scope), scope);
      const { body: discardedBody, ...hit } = materialized;
      void discardedBody;
      hits.push(hit);
    }
    return hits;
  }

  public resourceList(id: string, scope: Scope): SkillResourceMeta[] {
    this.guard();
    this.checkScope(scope);
    const head = this.headVersion(id, scope);
    if (head === 0) throw notFound();
    // Canonical path order makes readback and exports deterministic,
    // independent of importer traversal or insertion order.
    const rows = this.db
      .prepare(
        'SELECT relative_path, mode, mime, size, sha256 FROM skill_resources WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ? AND version = ? ORDER BY relative_path',
      )
      .all(id, scope.ownerUserId, scope.agentId, head) as Array<{
      relative_path: string;
      mode: number;
      mime: string;
      size: number;
      sha256: string;
    }>;
    return rows.map((row) => ({
      relativePath: String(row.relative_path),
      mode: row.mode === 493 ? (0o755 as const) : (0o644 as const),
      mime: String(row.mime),
      size: Number(row.size),
      sha256: String(row.sha256),
    }));
  }

  public resourceRead(id: string, relativePath: string, scope: Scope): SkillResourceRecord {
    this.guard();
    this.checkScope(scope);
    const safePath = validateResourcePath(relativePath);
    const head = this.headVersion(id, scope);
    if (head === 0) throw notFound();
    const row = this.db
      .prepare(
        'SELECT relative_path, mode, mime, size, sha256, bytes FROM skill_resources WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ? AND version = ? AND relative_path = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId, head, safePath) as
      | {
          relative_path: string;
          mode: number;
          mime: string;
          size: number;
          sha256: string;
          bytes: Buffer;
        }
      | undefined;
    if (!row) throw notFound();
    return {
      relativePath: String(row.relative_path),
      mode: row.mode === 493 ? (0o755 as const) : (0o644 as const),
      mime: String(row.mime),
      size: Number(row.size),
      sha256: String(row.sha256),
      bytes: Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes),
    };
  }

  public getRelations(id: string, version: number | undefined, scope: Scope): SkillRelation[] {
    this.guard();
    this.checkScope(scope);
    const sourceVersion = version ?? this.headVersion(id, scope);
    if (sourceVersion === 0) throw notFound();
    if (!this.getVersion(id, sourceVersion, scope)) throw notFound();
    const rows = this.db.prepare(
      `SELECT source_skill_id,source_version,relation_type,target_skill_id,target_version_constraint,resolved_target_version,metadata_json,created_at
       FROM skill_relations WHERE source_skill_id=? AND owner_user_id=? AND scope_agent_id=? AND source_version=?
       ORDER BY relation_type,target_skill_id,resolved_target_version`,
    ).all(id, scope.ownerUserId, scope.agentId, sourceVersion) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRelation(row));
  }

  public getDependents(id: string, scope: Scope): SkillRelation[] {
    this.guard();
    this.checkScope(scope);
    if (this.headVersion(id, scope) === 0) throw notFound();
    const rows = this.db.prepare(
      `SELECT r.source_skill_id,r.source_version,r.relation_type,r.target_skill_id,r.target_version_constraint,r.resolved_target_version,r.metadata_json,r.created_at
       FROM skill_relations r JOIN skill_entries e
         ON e.id=r.source_skill_id AND e.owner_user_id=r.owner_user_id AND e.scope_agent_id=r.scope_agent_id AND e.current_version=r.source_version
       WHERE r.target_skill_id=? AND r.owner_user_id=? AND r.scope_agent_id=?
       ORDER BY r.relation_type,r.source_skill_id,r.source_version`,
    ).all(id, scope.ownerUserId, scope.agentId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRelation(row));
  }

  public replaceRelations(
    id: string,
    expectedVersion: number,
    relations: SkillRelationInput[],
    scope: Scope,
    meta: { reason: string; requestId: string },
  ): SkillVersion {
    this.guard();
    this.checkScope(scope);
    const head = this.getHeadVersion(id, scope);
    if (!head) throw notFound();
    if (head.version !== expectedVersion) throw new HubError('CONFLICT', 'skill relation CAS conflict', 409);
    const resources = head.resources.map((resource) => {
      const record = this.readResourceAtVersion(id, head.version, resource.relativePath, scope);
      return { relativePath: record.relativePath, mode: record.mode, mime: record.mime, bytes: record.bytes };
    });
    return this.writeSkill({
      id: head.id, scope, logicalKey: head.logicalKey, kind: head.kind, name: head.name,
      ...(head.summary !== undefined ? { summary: head.summary } : {}),
      lifecycle: head.lifecycle, body: head.body, metadata: head.metadata, resources, relations, expectedVersion,
    }, meta);
  }

  public resolveGraph(
    id: string,
    version: number | undefined,
    scope: Scope,
    limits: Partial<{ maxDepth: number; maxResolvedSkills: number }> = {},
  ): ResolvedSkillGraph {
    this.guard();
    this.checkScope(scope);
    const rootVersion = version ?? this.headVersion(id, scope);
    if (rootVersion === 0 || !this.getVersion(id, rootVersion, scope)) throw notFound();
    const maxDepth = this.boundedLimit(limits.maxDepth, SKILL_GRAPH_LIMITS.maxDepth, 1, 32, 'maxDepth');
    const maxResolvedSkills = this.boundedLimit(limits.maxResolvedSkills, SKILL_GRAPH_LIMITS.maxResolvedSkills, 1, 256, 'maxResolvedSkills');
    const resolved: ResolvedSkillGraph['resolved'] = [];
    const selected = new Map<string, number>([[id, rootVersion]]);
    const queue: Array<{ skillId: string; version: number; depth: number }> = [{ skillId: id, version: rootVersion, depth: 0 }];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      if (parent.depth >= maxDepth) continue;
      const relations = this.getRelations(parent.skillId, parent.version, scope)
        .filter((relation) => SKILL_RELATION_TYPES[relation.type].dependency)
        .sort((a, b) => a.type.localeCompare(b.type) || a.targetSkillId.localeCompare(b.targetSkillId) || a.resolvedTargetVersion - b.resolvedTargetVersion);
      for (const relation of relations) {
        const prior = selected.get(relation.targetSkillId);
        if (prior !== undefined && prior !== relation.resolvedTargetVersion) {
          throw new HubError('CONFLICT', 'skill dependency version conflict', 409, { skillId: relation.targetSkillId });
        }
        if (prior !== undefined) continue;
        if (selected.size >= maxResolvedSkills) throw new HubError('VALIDATION', 'skill graph exceeds maxResolvedSkills', 413);
        const target = this.getVersion(relation.targetSkillId, relation.resolvedTargetVersion, scope);
        if (!target || target.lifecycle !== 'active') throw new HubError('NOT_FOUND', 'required skill dependency is unavailable', 404);
        selected.set(relation.targetSkillId, relation.resolvedTargetVersion);
        const node = {
          skillId: relation.targetSkillId,
          version: relation.resolvedTargetVersion,
          relation: relation.type,
          parent: { skillId: parent.skillId, version: parent.version },
          depth: parent.depth + 1,
          constraint: relation.targetVersionConstraint,
          resolvedVersion: relation.resolvedTargetVersion,
        };
        resolved.push(node);
        queue.push({ skillId: node.skillId, version: node.version, depth: node.depth });
      }
    }
    return { root: { skillId: id, version: rootVersion }, resolved, limits: { maxDepth, maxResolvedSkills } };
  }

  public resolveRetrieval(
    query: string,
    profile: string,
    scope: Scope,
    requested: Partial<RetrievalLimits> = {},
  ): RetrievalResolution {
    this.guard();
    this.checkScope(scope);
    if (typeof profile !== 'string' || profile.trim().length === 0 || profile.length > 128) throw new HubError('VALIDATION', 'profile must be 1..128 characters', 400);
    const classification = classifyRetrievalRequest(query);
    const policy = retrievalPolicy(classification);
    const limits: RetrievalLimits = {
      maxCandidates: this.boundedLimit(requested.maxCandidates, DEFAULT_RETRIEVAL_LIMITS.maxCandidates, 1, 100, 'maxCandidates'),
      maxGraphDepth: this.boundedLimit(requested.maxGraphDepth, DEFAULT_RETRIEVAL_LIMITS.maxGraphDepth, 1, 32, 'maxGraphDepth'),
      maxResolvedSkills: this.boundedLimit(requested.maxResolvedSkills, DEFAULT_RETRIEVAL_LIMITS.maxResolvedSkills, 1, 256, 'maxResolvedSkills'),
      maxBodyBytes: this.boundedLimit(requested.maxBodyBytes, DEFAULT_RETRIEVAL_LIMITS.maxBodyBytes, 1, 16 * 1024 * 1024, 'maxBodyBytes'),
      canonicalThreshold: this.boundedScore(requested.canonicalThreshold, DEFAULT_RETRIEVAL_LIMITS.canonicalThreshold, 'canonicalThreshold'),
      supportingThreshold: this.boundedScore(requested.supportingThreshold, DEFAULT_RETRIEVAL_LIMITS.supportingThreshold, 'supportingThreshold'),
    };
    if (limits.supportingThreshold > limits.canonicalThreshold) throw new HubError('VALIDATION', 'supportingThreshold must not exceed canonicalThreshold', 400);
    const terms = retrievalKeywords(query);
    const candidates = policy.skillRetrievalRequired && terms.length > 0 ? this.discoveryCandidates(scope, terms, limits.maxCandidates) : [];
    const memoryCandidates = policy.memoryRetrievalRequired && terms.length > 0 ? this.discoveryMemoryCandidates(scope, terms, limits.maxCandidates) : [];
    const selected: RetrievalSkillSelection[] = candidates.filter((candidate) => candidate.score >= limits.supportingThreshold).map((candidate) => ({
      skillId: candidate.id, version: candidate.version, score: candidate.score,
      tier: candidate.score >= limits.canonicalThreshold ? 'canonical' as const : 'supporting' as const,
      reason: 'direct_match' as const, depth: 0,
    }));
    const seen = new Map(selected.map((item) => [item.skillId, item.version]));
    for (const direct of [...selected]) {
      const graph = this.resolveGraph(direct.skillId, direct.version, scope, { maxDepth: limits.maxGraphDepth, maxResolvedSkills: limits.maxResolvedSkills });
      for (const node of graph.resolved) {
        const prior = seen.get(node.skillId);
        if (prior !== undefined && prior !== node.version) throw new HubError('CONFLICT', 'retrieval dependency version conflict', 409, { skillId: node.skillId });
        if (prior !== undefined) continue;
        if (selected.length >= limits.maxResolvedSkills) throw new HubError('VALIDATION', 'retrieval exceeds maxResolvedSkills', 413);
        seen.set(node.skillId, node.version);
        selected.push({ skillId: node.skillId, version: node.version, score: direct.score, tier: 'dependency', reason: 'dependency', parent: node.parent?.skillId, relation: node.relation, depth: node.depth });
      }
    }
    let selectedBytes = 0;
    for (const skill of selected) {
      const row = this.db.prepare(
        'SELECT total_size FROM skill_versions WHERE id=? AND owner_user_id=? AND scope_agent_id=? AND version=?',
      ).get(skill.skillId, scope.ownerUserId, scope.agentId, skill.version) as { total_size: number } | undefined;
      if (!row) throw notFound();
      selectedBytes += Number(row.total_size);
      if (selectedBytes > limits.maxBodyBytes) throw new HubError('VALIDATION', 'selected skill materialization exceeds maxBodyBytes', 413);
    }
    for (const memory of memoryCandidates) {
      selectedBytes += memory.bodyBytes;
      if (selectedBytes > limits.maxBodyBytes) throw new HubError('VALIDATION', 'selected canonical context exceeds maxBodyBytes', 413);
    }
    const requestId = `ret_${randomUUID()}`;
    const memories = memoryCandidates.map((memory) => ({ memoryId: memory.memoryId, version: memory.version, kind: memory.kind, confidence: memory.confidence, importance: memory.importance }));
    const noMatch = selected.length === 0 && memories.length === 0;
    const event = {
      id: requestId, requestId, actorUserId: this.actor.userId, actorAgentId: this.actor.agentId,
      ownerUserId: scope.ownerUserId, scopeAgentId: scope.agentId, profile: profile.trim(),
      queryRedacted: boundedAuditQuery(query), querySha256: retrievalQueryDigest(query), classification, policy,
      candidates: candidates.map(({ id: skillId, version, score }) => ({ skillId, version, score })),
      selected, memories, noMatch, createdAt: now(),
    };
    this.db.prepare(
      `INSERT INTO retrieval_events(id,request_id,actor_user_id,actor_agent_id,owner_user_id,scope_agent_id,profile,query_redacted,query_sha256,classification_json,policy_json,candidates_json,selected_skills_json,selected_memories_json,graph_expansions_json,no_match,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(event.id,event.requestId,event.actorUserId,event.actorAgentId,event.ownerUserId,event.scopeAgentId,event.profile,event.queryRedacted,event.querySha256,JSON.stringify(classification),JSON.stringify(policy),JSON.stringify(event.candidates),JSON.stringify(selected.filter((item) => item.reason==='direct_match')),JSON.stringify(memories),JSON.stringify(selected.filter((item) => item.reason==='dependency')),noMatch?1:0,event.createdAt);
    this.audit.append({ action: 'retrieval.resolved', actor: { userId: this.actor.userId, agentId: this.actor.agentId, harnessId: this.actor.harnessId }, scope, target: requestId, requestDigest: event.querySha256, metadata: { profile: event.profile, classification, policy, candidates: candidates.length, selected: selected.length, memories: memories.length, noMatch } });
    return { requestId, classification, policy, query: { digest: event.querySha256, terms }, candidatesConsidered: candidates.length, memoryCandidatesConsidered: memories.length, skills: selected, memories, noMatch, limits, materialization: { selectedBytes, maxBodyBytes: limits.maxBodyBytes } };
  }

  public buildGlobalGraph(scope: Scope, options: GlobalGraphOptions = {}): GlobalSkillGraph {
    this.guard();
    this.checkScope(scope);
    return buildGlobalSkillGraph(this.graphServiceDeps(), scope, options);
  }

  public buildCenteredGraph(id: string, scope: Scope, options: CenteredGraphOptions = {}): SkillGraphResponse {
    this.guard();
    this.checkScope(scope);
    return buildCenteredSkillGraph(this.graphServiceDeps(), id, scope, options);
  }

  public buildImpactGraph(id: string, scope: Scope, options: ImpactOptions = {}): SkillImpactResponse {
    this.guard();
    this.checkScope(scope);
    return buildSkillImpact(this.graphServiceDeps(), id, scope, options);
  }

  public listRetrievalEvents(scope: Scope, limit = RETRIEVAL_EVENTS_DEFAULT_LIMIT, includeRedactedQuery = false): RetrievalEventSummary[] {
    this.guard();
    this.checkScope(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > RETRIEVAL_EVENTS_MAX_LIMIT) {
      throw new HubError('VALIDATION', `limit must be an integer in 1..${RETRIEVAL_EVENTS_MAX_LIMIT}`, 400);
    }
    const rows = this.db.prepare(
      `SELECT request_id,profile,query_redacted,query_sha256,classification_json,policy_json,candidates_json,
              selected_skills_json,selected_memories_json,graph_expansions_json,no_match,created_at
       FROM retrieval_events WHERE owner_user_id=? AND scope_agent_id=?
       ORDER BY created_at DESC,request_id LIMIT ?`,
    ).all(scope.ownerUserId, scope.agentId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const candidates = this.jsonArray(row.candidates_json);
      const selectedSkills = this.jsonArray(row.selected_skills_json);
      const selectedMemories = this.jsonArray(row.selected_memories_json);
      const graphExpansions = this.jsonArray(row.graph_expansions_json);
      const item: RetrievalEventSummary = {
        requestId: String(row.request_id),
        profile: String(row.profile),
        classification: this.jsonObject(row.classification_json) as unknown as RetrievalEventSummary['classification'],
        policy: this.jsonObject(row.policy_json) as unknown as RetrievalEventSummary['policy'],
        createdAt: String(row.created_at),
        noMatch: Number(row.no_match) === 1,
        counts: { candidates: candidates.length, selectedSkills: selectedSkills.length + graphExpansions.length, selectedMemories: selectedMemories.length, graphExpansions: graphExpansions.length },
        querySha256: String(row.query_sha256),
      };
      if (includeRedactedQuery) item.redactedQuery = String(row.query_redacted);
      return item;
    });
  }

  public getRetrievalEventGraph(requestId: string, scope: Scope): RetrievalEventGraphResponse {
    this.guard();
    this.checkScope(scope);
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 160) {
      throw new HubError('VALIDATION', 'requestId must be 1..160 characters', 400);
    }
    const row = this.db.prepare(
      `SELECT request_id,actor_user_id,actor_agent_id,profile,query_redacted,classification_json,policy_json,candidates_json,
              selected_skills_json,selected_memories_json,graph_expansions_json,no_match,created_at
       FROM retrieval_events WHERE request_id=? AND owner_user_id=? AND scope_agent_id=?`,
    ).get(requestId, scope.ownerUserId, scope.agentId) as Record<string, unknown> | undefined;
    if (!row) throw new HubError('NOT_FOUND', 'retrieval event not found', 404);
    const direct = this.jsonArray(row.selected_skills_json) as Array<Record<string, unknown>>;
    const expanded = this.jsonArray(row.graph_expansions_json) as Array<Record<string, unknown>>;
    const selected = [...direct, ...expanded];
    const nodeById = new Map<string, GraphSkillNode>();
    const versionById = new Map<string, number>();
    for (const item of selected) {
      const skillId = String(item.skillId ?? '');
      const version = Number(item.version);
      if (!skillId || !Number.isInteger(version) || version < 1) continue;
      const material = this.getVersion(skillId, version, scope);
      if (!material) continue;
      const node = this.projectGraphNode(material);
      node.selection = {
        reason: item.reason === 'dependency' ? 'dependency' : (item.tier === 'supporting' ? 'supporting' : 'direct_match'),
        ...(typeof item.score === 'number' ? { score: item.score } : {}),
        ...(typeof item.tier === 'string' ? { tier: item.tier } : {}),
        ...(typeof item.depth === 'number' ? { depth: item.depth } : {}),
      };
      nodeById.set(skillId, node);
      versionById.set(skillId, version);
    }
    const edges = expanded.flatMap((item) => {
      const source = typeof item.parent === 'string' ? item.parent : '';
      const target = typeof item.skillId === 'string' ? item.skillId : '';
      const relation = typeof item.relation === 'string' ? item.relation : '';
      if (!source || !target || !nodeById.has(source) || !nodeById.has(target) || !SKILL_RELATION_TYPES[relation as keyof typeof SKILL_RELATION_TYPES]) return [];
      return [{
        source,
        sourceVersion: versionById.get(source) ?? nodeById.get(source)!.version,
        type: relation as keyof typeof SKILL_RELATION_TYPES,
        target,
        targetVersion: versionById.get(target) ?? nodeById.get(target)!.version,
        constraint: null,
        direction: 'dependencies' as const,
        reason: 'dependency' as const,
      }];
    }).sort((a, b) => a.source.localeCompare(b.source) || a.type.localeCompare(b.type) || a.target.localeCompare(b.target));
    return {
      root: { requestId },
      nodes: [...nodeById.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version),
      edges,
      memories: this.jsonArray(row.selected_memories_json) as unknown as RetrievalEventGraphResponse['memories'],
      metadata: {
        requestId,
        actor: { userId: String(row.actor_user_id), agentId: String(row.actor_agent_id) },
        query: String(row.query_redacted),
        createdAt: String(row.created_at),
        profile: String(row.profile),
        classification: this.jsonObject(row.classification_json) as unknown as RetrievalEventGraphResponse['metadata']['classification'],
        policy: this.jsonObject(row.policy_json) as unknown as RetrievalEventGraphResponse['metadata']['policy'],
        noMatch: Number(row.no_match) === 1,
        counts: {
          candidates: this.jsonArray(row.candidates_json).length,
          selectedSkills: selected.length,
          selectedMemories: this.jsonArray(row.selected_memories_json).length,
          graphExpansions: expanded.length,
        },
        generatedAt: now(),
        mode: 'dependencies',
        includeHistory: false,
        scope: { ownerUserId: scope.ownerUserId, agentId: scope.agentId },
      },
    };
  }

  private graphServiceDeps() {
    return {
      fetchHead: (id: string, scope: Scope) => {
        const skill = this.getHeadVersion(id, scope);
        return skill ? this.toGraphMaterialization(skill) : undefined;
      },
      fetchRelations: (id: string, version: number, scope: Scope) => this.getRelations(id, version, scope).map((relation) => this.toGraphRelation(relation)),
      fetchDependents: (id: string, scope: Scope) => this.getDependents(id, scope).map((relation) => this.toGraphRelation(relation)),
      listActiveHeads: (scope: Scope) => this.listGraphHeads(scope),
      listAllRelations: (scope: Scope, includeHistory = false) => this.listGraphRelations(scope, includeHistory),
      listAllVersions: (scope: Scope) => this.listGraphMaterials(scope, false),
      listHistory: (id: string, scope: Scope) => this.listGraphHistory(id, scope),
    };
  }

  private listGraphHeads(scope: Scope): GraphNodeMaterialization[] {
    return this.listGraphMaterials(scope, true);
  }

  private listGraphMaterials(scope: Scope, headsOnly: boolean): GraphNodeMaterialization[] {
    const headClause = headsOnly ? ' AND v.version=e.current_version' : '';
    const rows = this.db.prepare(
      `SELECT e.id,e.logical_key,e.kind,e.name,e.summary,e.lifecycle,e.metadata_json,e.updated_at,
              v.version,v.body_sha256,v.total_size,v.created_at
       FROM skill_entries e
       JOIN skill_versions v ON v.id=e.id AND v.owner_user_id=e.owner_user_id AND v.scope_agent_id=e.scope_agent_id
       WHERE e.owner_user_id=? AND e.scope_agent_id=? AND e.lifecycle='active'${headClause}
       ORDER BY e.logical_key,e.id,v.version`,
    ).all(scope.ownerUserId, scope.agentId) as Array<Record<string, unknown>>;
    const resources = this.db.prepare(
      `SELECT r.id,r.version,r.relative_path,r.mode,r.mime,r.size,r.sha256
       FROM skill_resources r
       JOIN skill_entries e ON e.id=r.id AND e.owner_user_id=r.owner_user_id AND e.scope_agent_id=r.scope_agent_id
       WHERE r.owner_user_id=? AND r.scope_agent_id=? AND e.lifecycle='active'${headsOnly ? ' AND r.version=e.current_version' : ''}
       ORDER BY r.id,r.version,r.relative_path`,
    ).all(scope.ownerUserId, scope.agentId) as Array<Record<string, unknown>>;
    const resourcesByVersion = new Map<string, GraphNodeMaterialization['resources']>();
    for (const row of resources) {
      const key = `${String(row.id)}@${Number(row.version)}`;
      const items = resourcesByVersion.get(key) ?? [];
      items.push({
        relativePath: String(row.relative_path),
        mode: Number(row.mode) === 0o755 ? 0o755 : 0o644,
        mime: String(row.mime),
        size: Number(row.size),
        sha256: String(row.sha256),
      });
      resourcesByVersion.set(key, items);
    }
    return rows.map((row) => ({
      id: String(row.id),
      scope: { ownerUserId: scope.ownerUserId, agentId: scope.agentId },
      logicalKey: String(row.logical_key),
      kind: String(row.kind) === 'tool' ? 'tool' : 'skill',
      name: String(row.name),
      ...(row.summary === null ? {} : { summary: String(row.summary) }),
      lifecycle: String(row.lifecycle) as GraphNodeMaterialization['lifecycle'],
      version: Number(row.version),
      bodySha256: String(row.body_sha256),
      totalSize: Number(row.total_size),
      resources: resourcesByVersion.get(`${String(row.id)}@${Number(row.version)}`) ?? [],
      metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  private listGraphRelations(scope: Scope, includeHistory: boolean): GraphRelationRow[] {
    const rows = this.db.prepare(
      `SELECT r.source_skill_id,r.source_version,r.relation_type,r.target_skill_id,r.target_version_constraint,
              r.resolved_target_version,r.metadata_json,r.created_at
       FROM skill_relations r
       JOIN skill_entries s ON s.id=r.source_skill_id AND s.owner_user_id=r.owner_user_id AND s.scope_agent_id=r.scope_agent_id${includeHistory ? '' : ' AND s.current_version=r.source_version'} AND s.lifecycle='active'
       JOIN skill_entries t ON t.id=r.target_skill_id AND t.owner_user_id=r.owner_user_id AND t.scope_agent_id=r.scope_agent_id AND t.lifecycle='active'
       WHERE r.owner_user_id=? AND r.scope_agent_id=?
       ORDER BY r.source_skill_id,r.relation_type,r.target_skill_id,r.resolved_target_version`,
    ).all(scope.ownerUserId, scope.agentId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toGraphRelation(this.mapRelation(row)));
  }

  private listGraphHistory(id: string, scope: Scope): number[] {
    if (this.headVersion(id, scope) === 0) throw notFound();
    return (this.db.prepare(
      'SELECT version FROM skill_versions WHERE id=? AND owner_user_id=? AND scope_agent_id=? ORDER BY version',
    ).all(id, scope.ownerUserId, scope.agentId) as Array<{ version: number }>).map((row) => Number(row.version));
  }

  private toGraphMaterialization(skill: SkillVersion): GraphNodeMaterialization {
    return { ...skill, body: undefined } as unknown as GraphNodeMaterialization;
  }

  private projectGraphNode(skill: SkillVersion): GraphSkillNode {
    const material = this.toGraphMaterialization(skill);
    return {
      id: material.id, skillId: material.id, version: material.version, name: material.name, kind: material.kind,
      logicalKey: material.logicalKey, lifecycle: material.lifecycle, totalSize: material.totalSize,
      resources: material.resources, bodySha256: material.bodySha256, createdAt: material.createdAt,
      updatedAt: material.updatedAt, metadata: material.metadata,
    };
  }

  private toGraphRelation(relation: SkillRelation): GraphRelationRow {
    return {
      sourceSkillId: relation.sourceSkillId, sourceVersion: relation.sourceVersion, type: relation.type,
      targetSkillId: relation.targetSkillId, targetVersionConstraint: relation.targetVersionConstraint ?? null,
      resolvedTargetVersion: relation.resolvedTargetVersion, metadata: relation.metadata, createdAt: relation.createdAt,
    };
  }

  private jsonArray(value: unknown): unknown[] {
    try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }

  private jsonObject(value: unknown): Record<string, unknown> {
    try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
  }

  public totalSize(id: string, scope: Scope): number {
    const head = this.headVersion(id, scope);
    if (head === 0) throw notFound();
    const row = this.db
      .prepare(
        'SELECT total_size FROM skill_versions WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ? AND version = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId, head) as { total_size: number } | undefined;
    return row ? Number(row.total_size) : 0;
  }

  public listActiveHeads(scope: Scope): SkillHeadSummary[] {
    this.guard();
    this.checkScope(scope);
    return this.queryActiveHeads(scope, undefined);
  }

  public listActiveHeadsFiltered(scope: Scope, ids: string[]): SkillHeadSummary[] {
    this.guard();
    this.checkScope(scope);
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'string') {
        throw new HubError('VALIDATION', 'skill id must be a string', 400);
      }
      if (id.length === 0 || id.length > 128) {
        throw new HubError('VALIDATION', `skill id length out of range: ${id.length}`, 400);
      }
      if (seen.has(id)) continue;
      seen.add(id);
      cleaned.push(id);
    }
    if (cleaned.length === 0) return [];
    return this.queryActiveHeads(scope, cleaned);
  }

  public readResourceAtVersion(
    id: string,
    version: number,
    relativePath: string,
    scope: Scope,
  ): SkillResourceRecord {
    this.guard();
    this.checkScope(scope);
    if (!Number.isInteger(version) || version < 1) {
      throw new HubError('VALIDATION', 'version must be a positive integer', 400);
    }
    const safePath = validateResourcePath(relativePath);
    const row = this.db
      .prepare(
        'SELECT relative_path, mode, mime, size, sha256, bytes FROM skill_resources WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ? AND version = ? AND relative_path = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId, version, safePath) as
      | {
          relative_path: string;
          mode: number;
          mime: string;
          size: number;
          sha256: string;
          bytes: Buffer;
        }
      | undefined;
    if (!row) throw notFound();
    return {
      relativePath: String(row.relative_path),
      mode: row.mode === 493 ? (0o755 as const) : (0o644 as const),
      mime: String(row.mime),
      size: Number(row.size),
      sha256: String(row.sha256),
      bytes: Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes),
    };
  }

  private mapRelation(row: Record<string, unknown>): SkillRelation {
    return {
      sourceSkillId: String(row.source_skill_id), sourceVersion: Number(row.source_version),
      type: String(row.relation_type) as SkillRelation['type'], targetSkillId: String(row.target_skill_id),
      targetVersionConstraint: row.target_version_constraint === null ? null : String(row.target_version_constraint),
      resolvedTargetVersion: Number(row.resolved_target_version),
      metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>, createdAt: String(row.created_at),
    };
  }

  private resolveRelationInputs(sourceSkillId: string, inputs: SkillRelationInput[], scope: Scope): Array<{ input: SkillRelationInput; constraint: string | null; resolved: number }> {
    if (!Array.isArray(inputs)) throw new HubError('VALIDATION', 'relations must be an array', 400);
    if (inputs.length > SKILL_GRAPH_LIMITS.maxRelationsPerVersion) throw new HubError('VALIDATION', 'too many relations for skill version', 413);
    const seen = new Set<string>();
    const resolved: Array<{ input: SkillRelationInput; constraint: string | null; resolved: number }> = [];
    for (const raw of inputs) {
      const input = validateRelationInput(raw, sourceSkillId);
      const metadataBytes = Buffer.from(canonicalJson(input.metadata ?? {}), 'utf8');
      const findings = scanBuffer(metadataBytes, { rootId: 'relation-metadata', relativePath: `${sourceSkillId}/${input.type}/${input.targetSkillId}`, isText: true });
      if (findings.length > 0) throw new HubError('VALIDATION', 'relation metadata blocked by secret scanning', 400, { findings });
      const duplicateKey = `${input.type}\u0000${input.targetSkillId}`;
      if (seen.has(duplicateKey)) throw new HubError('CONFLICT', 'duplicate skill relation', 409);
      seen.add(duplicateKey);
      const target = this.db.prepare(
        "SELECT current_version,lifecycle FROM skill_entries WHERE id=? AND owner_user_id=? AND scope_agent_id=?",
      ).get(input.targetSkillId, scope.ownerUserId, scope.agentId) as { current_version: number; lifecycle: string } | undefined;
      if (!target || target.lifecycle !== 'active') throw notFound();
      const selector = parseSkillVersionSelector(input);
      let targetVersion: number;
      let constraint: string | null;
      if (selector.kind === 'head') { targetVersion = Number(target.current_version); constraint = null; }
      else if (selector.kind === 'exact') { targetVersion = selector.version; constraint = `=${selector.version}`; }
      else {
        constraint = selector.expression;
        const versions = this.db.prepare(
          'SELECT version FROM skill_versions WHERE id=? AND owner_user_id=? AND scope_agent_id=? ORDER BY version DESC',
        ).all(input.targetSkillId, scope.ownerUserId, scope.agentId) as Array<{ version: number }>;
        const match = versions.find((row) => versionSatisfies(Number(row.version), selector.expression));
        if (!match) throw new HubError('CONFLICT', 'no target version satisfies relation constraint', 409);
        targetVersion = Number(match.version);
      }
      const exists = this.db.prepare(
        'SELECT 1 AS ok FROM skill_versions WHERE id=? AND owner_user_id=? AND scope_agent_id=? AND version=?',
      ).get(input.targetSkillId, scope.ownerUserId, scope.agentId, targetVersion);
      if (!exists) throw notFound();
      resolved.push({ input, constraint, resolved: targetVersion });
    }
    return resolved.sort((a, b) => a.input.type.localeCompare(b.input.type) || a.input.targetSkillId.localeCompare(b.input.targetSkillId));
  }

  private insertRelations(sourceSkillId: string, sourceVersion: number, inputs: SkillRelationInput[], scope: Scope, createdAt: string): void {
    const resolved = this.resolveRelationInputs(sourceSkillId, inputs, scope);
    this.assertNoDependencyCycle(sourceSkillId, resolved, scope);
    for (const relation of resolved) {
      this.db.prepare(
        `INSERT INTO skill_relations(source_skill_id,source_version,owner_user_id,scope_agent_id,relation_type,target_skill_id,target_version_constraint,resolved_target_version,metadata_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ).run(sourceSkillId,sourceVersion,scope.ownerUserId,scope.agentId,relation.input.type,relation.input.targetSkillId,relation.constraint,relation.resolved,canonicalJson(relation.input.metadata ?? {}),createdAt);
    }
  }

  private assertNoDependencyCycle(sourceSkillId: string, pending: Array<{ input: SkillRelationInput; resolved: number }>, scope: Scope): void {
    const acyclicTypes = Object.entries(SKILL_RELATION_TYPES)
      .filter(([, semantics]) => semantics.acyclic)
      .map(([type]) => type);
    for (const type of acyclicTypes) {
      const adjacency = new Map<string, string[]>();
      const rows = this.db.prepare(
        `SELECT r.source_skill_id,r.target_skill_id FROM skill_relations r JOIN skill_entries e
         ON e.id=r.source_skill_id AND e.owner_user_id=r.owner_user_id AND e.scope_agent_id=r.scope_agent_id AND e.current_version=r.source_version
         WHERE r.owner_user_id=? AND r.scope_agent_id=? AND r.relation_type=? AND r.source_skill_id!=?`,
      ).all(scope.ownerUserId, scope.agentId, type, sourceSkillId) as Array<{ source_skill_id: string; target_skill_id: string }>;
      for (const row of rows) adjacency.set(row.source_skill_id, [...(adjacency.get(row.source_skill_id) ?? []), row.target_skill_id]);
      adjacency.set(sourceSkillId, pending.filter((item) => item.input.type === type).map((item) => item.input.targetSkillId));
      const visiting = new Set<string>(); const visited = new Set<string>();
      const visit = (node: string): boolean => {
        if (visiting.has(node)) return true;
        if (visited.has(node)) return false;
        visiting.add(node);
        for (const next of adjacency.get(node) ?? []) if (visit(next)) return true;
        visiting.delete(node); visited.add(node); return false;
      };
      if (visit(sourceSkillId)) throw new HubError('CONFLICT', `${type} relation cycle`, 409);
    }
  }

  private relationFingerprintParts(resolved: Array<{ input: SkillRelationInput; constraint: string | null; resolved: number }>): string {
    return createHash('sha256').update(canonicalJson(resolved.map((item) => ({ type: item.input.type, targetSkillId: item.input.targetSkillId, constraint: item.constraint, resolved: item.resolved, metadata: item.input.metadata ?? {} })))).digest('hex');
  }

  private pendingRelationFingerprint(sourceSkillId: string, inputs: SkillRelationInput[], scope: Scope): string {
    return this.relationFingerprintParts(this.resolveRelationInputs(sourceSkillId, inputs, scope));
  }

  private relationInputFingerprint(sourceSkillId: string, sourceVersion: number, scope: Scope): string {
    const rows = this.db.prepare(
      'SELECT relation_type,target_skill_id,target_version_constraint,resolved_target_version,metadata_json FROM skill_relations WHERE source_skill_id=? AND owner_user_id=? AND scope_agent_id=? AND source_version=? ORDER BY relation_type,target_skill_id',
    ).all(sourceSkillId, scope.ownerUserId, scope.agentId, sourceVersion) as Array<Record<string, unknown>>;
    return createHash('sha256').update(canonicalJson(rows.map((row) => ({ type: row.relation_type, targetSkillId: row.target_skill_id, constraint: row.target_version_constraint, resolved: Number(row.resolved_target_version), metadata: JSON.parse(String(row.metadata_json)) })))).digest('hex');
  }

  private boundedLimit(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new HubError('VALIDATION', `${name} must be an integer in ${minimum}..${maximum}`, 400);
    return value;
  }

  private boundedScore(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new HubError('VALIDATION', `${name} must be in 0..1`, 400);
    return value;
  }

  private discoveryCandidates(scope: Scope, terms: string[], limit: number): Array<{ id: string; version: number; score: number }> {
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const rows = this.db.prepare(
      `SELECT e.id,e.current_version,e.logical_key,e.name,COALESCE(e.summary,'') AS summary,e.metadata_json
       FROM skill_fts f JOIN skill_entries e ON e.id=f.id AND e.owner_user_id=f.owner_user_id AND e.scope_agent_id=f.scope_agent_id
       WHERE f.owner_user_id=? AND f.scope_agent_id=? AND f.lifecycle='active' AND skill_fts MATCH ?
       ORDER BY bm25(skill_fts,6.0,5.0,4.0,4.0,1.0),e.logical_key LIMIT ?`,
    ).all(scope.ownerUserId, scope.agentId, expression, limit) as Array<{ id: string; current_version: number; logical_key: string; name: string; summary: string; metadata_json: string }>;
    return rows.map((row) => {
      const name = `${row.logical_key} ${row.name}`.toLocaleLowerCase('en-US');
      const support = `${row.summary} ${row.metadata_json}`.toLocaleLowerCase('en-US');
      let weighted = 0;
      for (const term of terms) weighted += name.includes(term) ? 1 : support.includes(term) ? 0.5 : 0;
      const score = Number(Math.min(1, 0.45 + 0.55 * (weighted / Math.max(1, terms.length))).toFixed(6));
      return { id: row.id, version: Number(row.current_version), score };
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }

  private discoveryMemoryCandidates(scope: Scope, terms: string[], limit: number): Array<{ memoryId: string; version: number; kind: string; confidence: number; importance: number; bodyBytes: number }> {
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const rows = this.db.prepare(
      `SELECT m.id,m.current_version,m.kind,m.confidence,m.importance,length(CAST(v.content_json AS BLOB)) AS body_bytes
       FROM memory_fts f
       JOIN memories m ON m.id=f.memory_id AND m.owner_user_id=f.owner_user_id AND m.scope_agent_id=f.agent_id
       JOIN memory_versions v ON v.memory_id=m.id AND v.version=m.current_version
       WHERE f.owner_user_id=? AND f.agent_id=? AND m.lifecycle IN ('candidate','active') AND memory_fts MATCH ?
       ORDER BY bm25(memory_fts),m.importance DESC,m.id LIMIT ?`,
    ).all(scope.ownerUserId, scope.agentId, expression, limit) as Array<{ id: string; current_version: number; kind: string; confidence: number; importance: number; body_bytes: number }>;
    return rows.map((row) => ({
      memoryId: row.id,
      version: Number(row.current_version),
      kind: row.kind,
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      bodyBytes: Number(row.body_bytes),
    }));
  }

  private queryActiveHeads(scope: Scope, ids: string[] | undefined): SkillHeadSummary[] {
    const params: Array<string | number> = [scope.ownerUserId, scope.agentId];
    let idClause = '';
    if (ids && ids.length > 0) {
      idClause = ` AND e.id IN (${ids.map(() => '?').join(',')})`;
      for (const id of ids) params.push(id);
    }
    const rows = this.db
      .prepare(
        `SELECT e.id, e.logical_key, e.name, e.current_version, v.body_sha256, v.body, v.total_size
         FROM skill_entries e
         JOIN skill_versions v
           ON v.id = e.id AND v.owner_user_id = e.owner_user_id AND v.scope_agent_id = e.scope_agent_id
          AND v.version = e.current_version
         WHERE e.owner_user_id = ? AND e.scope_agent_id = ? AND e.lifecycle = 'active'${idClause}
         ORDER BY e.logical_key, e.id`,
      )
      .all(...params) as Array<{
        id: string;
        logical_key: string;
        name: string;
        current_version: number;
        body_sha256: string;
        body: Buffer;
        total_size: number;
      }>;
    const summaries: SkillHeadSummary[] = [];
    for (const row of rows) {
      const version = Number(row.current_version);
      const resourceRows = this.db
        .prepare(
          'SELECT relative_path, mode, mime, size, sha256 FROM skill_resources WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ? AND version = ? ORDER BY relative_path',
        )
        .all(String(row.id), scope.ownerUserId, scope.agentId, version) as Array<{
          relative_path: string;
          mode: number;
          mime: string;
          size: number;
          sha256: string;
        }>;
      const resources: SkillResourceMeta[] = resourceRows.map((resource) => ({
        relativePath: String(resource.relative_path),
        mode: resource.mode === 493 ? (0o755 as const) : (0o644 as const),
        mime: String(resource.mime),
        size: Number(resource.size),
        sha256: String(resource.sha256),
      }));
      const bodySha = String(row.body_sha256);
      const bodySize = Buffer.from(row.body).byteLength;
      summaries.push({
        id: String(row.id),
        logicalKey: String(row.logical_key),
        name: String(row.name),
        version,
        bodySize,
        bodySha256: bodySha,
        resources,
        resourceFingerprint: computeResourceFingerprint(
          resources.map((resource) => ({ relativePath: resource.relativePath, sha256: resource.sha256 })),
        ),
      });
    }
    return summaries;
  }

  private headVersion(id: string, scope: Scope): number {
    const row = this.db
      .prepare(
        'SELECT current_version FROM skill_entries WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId) as { current_version: number } | undefined;
    return row ? Number(row.current_version) : 0;
  }

  private headBodySha256(id: string, version: number, scope: Scope): string {
    const row = this.db
      .prepare(
        'SELECT body_sha256 FROM skill_versions WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ? AND version = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId, version) as { body_sha256: string } | undefined;
    return row ? String(row.body_sha256) : '';
  }

  private headLifecycle(id: string, scope: Scope): string {
    const row = this.db
      .prepare(
        'SELECT lifecycle FROM skill_entries WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId) as { lifecycle: string } | undefined;
    return row ? String(row.lifecycle) : '';
  }

  private headMetadata(id: string, scope: Scope): string {
    const row = this.db
      .prepare(
        'SELECT metadata_json FROM skill_entries WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId) as { metadata_json: string } | undefined;
    return row ? String(row.metadata_json ?? '') : '';
  }

  private headResourceFingerprint(id: string, version: number, scope: Scope): string {
    const rows = this.db
      .prepare(
        'SELECT relative_path, sha256 FROM skill_resources WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ? AND version = ? ORDER BY relative_path',
      )
      .all(id, scope.ownerUserId, scope.agentId, version) as Array<{ relative_path: string; sha256: string }>;
    return computeResourceFingerprint(rows.map((row) => ({ relativePath: String(row.relative_path), sha256: String(row.sha256) })));
  }

  private materializeVersion(id: string, version: number, scope: Scope): SkillVersion {
    const entry = this.db
      .prepare(
        'SELECT * FROM skill_entries WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId) as
      | {
          id: string;
          owner_user_id: string;
          scope_agent_id: string;
          logical_key: string;
          kind: 'skill' | 'tool';
          name: string;
          summary: string | null;
          lifecycle: SkillLifecycle;
          current_version: number;
          metadata_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!entry) throw notFound();
    const versionRow = this.db
      .prepare(
        'SELECT body, body_sha256, total_size, metadata_json, created_at FROM skill_versions WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ? AND version = ?',
      )
      .get(id, scope.ownerUserId, scope.agentId, version) as
      | { body: Buffer; body_sha256: string; total_size: number; metadata_json: string; created_at: string }
      | undefined;
    if (!versionRow) throw notFound();
    // Canonical path order is part of the byte-for-byte round-trip
    // contract and must not depend on filesystem traversal order.
    const resourceRows = this.db
      .prepare(
        'SELECT relative_path, mode, mime, size, sha256 FROM skill_resources WHERE id = ? AND owner_user_id = ? AND scope_agent_id = ? AND version = ? ORDER BY relative_path',
      )
      .all(id, scope.ownerUserId, scope.agentId, version) as Array<{
      relative_path: string;
      mode: number;
      mime: string;
      size: number;
      sha256: string;
    }>;
    return {
      id: String(entry.id),
      scope,
      logicalKey: String(entry.logical_key),
      kind: entry.kind,
      name: String(entry.name),
      summary: typeof entry.summary === 'string' ? entry.summary : undefined,
      lifecycle: entry.lifecycle,
      version: Number(version),
      body: Buffer.isBuffer(versionRow.body) ? versionRow.body : Buffer.from(versionRow.body),
      bodySha256: String(versionRow.body_sha256),
      totalSize: Number(versionRow.total_size),
      metadata: JSON.parse(String(versionRow.metadata_json)) as Record<string, unknown>,
      resources: resourceRows.map((row) => ({
        relativePath: String(row.relative_path),
        mode: row.mode === 493 ? (0o755 as const) : (0o644 as const),
        mime: String(row.mime),
        size: Number(row.size),
        sha256: String(row.sha256),
      })),
      createdAt: String(entry.created_at),
      updatedAt: String(entry.updated_at),
    };
  }

  /** UUID helper used by callers/tests that need a fresh id. */
  public static newId(): string {
    return `skl_${randomUUID().replaceAll('-', '')}`;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new HubError('VALIDATION', 'relation metadata contains a non-finite number', 400);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new HubError('VALIDATION', 'relation metadata must contain JSON values only', 400);
}

// Re-export so callers don't need to import the validation module
// separately when they want to pre-validate (rare; mostly for tests).
export { validateSkillInput };