import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HubError, type ActorContext, type AuditRepository, type RelationDiscoveryOptions, type RelationDiscoveryResult, type RelationProposal, type RelationProposalEvidence, type RelationProposalPreview, type RelationProposalRepository, type RelationProposalStatus, type SkillRelationType, type Scope } from '@portable-agent-asset-hub/core';
import { DeterministicRelationClassifier, OPERATIONAL_RELATION_TYPES, proposalFingerprint, resolveEffectiveProposal, validateClassification } from '@portable-agent-asset-hub/core';

const now = (): string => new Date().toISOString();
const redactText = (text: string): string => text.replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]');
const operativeBody = (body: Buffer): { text: string; offset: number } => {
  const raw = body.toString('utf8');
  const frontmatter = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const offset = frontmatter?.[0].length ?? 0;
  return { text: redactText(raw.slice(offset, offset + 20000)), offset };
};
const normalized = (value: string): string => value.toLocaleLowerCase('en-US');
function tokens(value: string): string[] { return [...new Set(normalized(value).match(/[a-z0-9][a-z0-9_-]{2,}/giu) ?? [])]; }
function canonicalDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function id(): string { return `rprop_${randomUUID().replaceAll('-', '')}`; }

type Head = { id: string; version: number; logicalKey: string; name: string; summary: string; metadata: Record<string, unknown>; bodyExcerpt: string; bodyOffset: number };

export class SqliteRelationProposalRepository implements RelationProposalRepository {
  public constructor(private readonly db: DatabaseSync, private readonly actor: ActorContext, private readonly audit: AuditRepository, private readonly assertActive: () => void) {}
  private guard(scope: Scope): void {
    this.assertActive();
    if (!this.actor || scope.ownerUserId !== this.actor.scope.ownerUserId || scope.agentId !== this.actor.scope.agentId) throw new HubError('NOT_FOUND', 'proposal not found', 404);
  }
  private heads(scope: Scope, ids?: string[]): Head[] {
    const args: Array<string> = [scope.ownerUserId, scope.agentId];
    const filter = ids?.length ? ` AND e.id IN (${ids.map(() => '?').join(',')})` : '';
    if (ids) args.push(...ids);
    const rows = this.db.prepare(`SELECT e.id,e.current_version,e.logical_key,e.name,COALESCE(e.summary,'') AS summary,e.metadata_json,v.body FROM skill_entries e JOIN skill_versions v ON v.id=e.id AND v.owner_user_id=e.owner_user_id AND v.scope_agent_id=e.scope_agent_id AND v.version=e.current_version WHERE e.owner_user_id=? AND e.scope_agent_id=? AND e.lifecycle='active'${filter} ORDER BY e.logical_key,e.id`).all(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => { const body = operativeBody(Buffer.from(row.body as Uint8Array)); return { id: String(row.id), version: Number(row.current_version), logicalKey: String(row.logical_key), name: String(row.name), summary: String(row.summary ?? ''), metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>, bodyExcerpt: body.text, bodyOffset: body.offset }; });
  }
  private explicit(source: Head, target: Head): { found: boolean; phrase?: string } {
    const text = normalized(source.bodyExcerpt);
    const aliases = [target.id, target.logicalKey, target.name, ...((target.metadata.aliases as unknown[] | undefined)?.filter((v): v is string => typeof v === 'string') ?? [])].map(normalized).filter((v) => v.length >= 3);
    const hit = aliases.find((alias) => new RegExp(`(^|[^a-z0-9_-])${alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=$|[^a-z0-9_-])`, 'iu').test(text));
    if (!hit) return { found: false };
    const before = text.slice(Math.max(0, text.indexOf(hit) - 80), text.indexOf(hit) + hit.length + 120);
    return { found: true, phrase: before };
  }
  private ftsCandidates(source: Head, scope: Scope, limit: number): Array<{ id: string; score: number }> {
    const terms = tokens(`${source.logicalKey} ${source.name} ${source.summary}`).slice(0, 12);
    if (!terms.length) return [];
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const rows = this.db.prepare(`SELECT e.id FROM skill_fts f JOIN skill_entries e ON e.id=f.id AND e.owner_user_id=f.owner_user_id AND e.scope_agent_id=f.scope_agent_id WHERE f.owner_user_id=? AND f.scope_agent_id=? AND f.lifecycle='active' AND e.id<>? AND skill_fts MATCH ? ORDER BY bm25(skill_fts,6.0,5.0,4.0,4.0,1.0),e.logical_key LIMIT ?`).all(scope.ownerUserId, scope.agentId, source.id, expression, limit) as Array<{ id: string }>;
    return rows.map((row, index) => ({ id: String(row.id), score: Number(Math.max(0.25, 1 - index / Math.max(1, limit)).toFixed(6)) }));
  }
  public discover(scope: Scope, options: RelationDiscoveryOptions = {}): RelationDiscoveryResult {
    this.guard(scope);
    const mode = options.mode ?? 'balanced';
    const topK = Math.max(1, Math.min(32, Math.trunc(options.topK ?? (mode === 'exploratory' ? 12 : 10))));
    const minRelated = options.minRelatedConfidence ?? 0;
    if (!Number.isFinite(minRelated) || minRelated < 0 || minRelated > 1) throw new HubError('VALIDATION', 'minRelatedConfidence must be in 0..1', 400);
    const heads = this.heads(scope, options.skillIds);
    const byId = new Map(heads.map((head) => [head.id, head]));
    const canonical = new Set((this.db.prepare('SELECT source_skill_id,source_version,relation_type,target_skill_id FROM skill_relations WHERE owner_user_id=? AND scope_agent_id=?').all(scope.ownerUserId, scope.agentId) as Array<Record<string, unknown>>).map((row) => `${row.source_skill_id}@${row.source_version}|${row.relation_type}|${row.target_skill_id}`));
    const proposals: RelationProposal[] = [];
    let candidatePairs = 0;
    const detectorStats: Record<string, number> = { 'explicit-reference-v1': 0, 'fts-candidate-v1': 0, 'relation-heuristic-v2': 0, skippedCanonical: 0, rejectedSuppressed: 0 };
    const classifier = new DeterministicRelationClassifier();
    for (const source of heads) {
      const candidateIds = new Map<string, { explicit: boolean; score: number; phrase?: string }>();
      for (const target of heads) { if (target.id === source.id) continue; const signal = this.explicit(source, target); if (signal.found) candidateIds.set(target.id, { explicit: true, score: 1, phrase: signal.phrase }); }
      for (const candidate of this.ftsCandidates(source, scope, mode === 'strict' ? Math.min(topK, 8) : topK)) { const old = candidateIds.get(candidate.id); candidateIds.set(candidate.id, { explicit: old?.explicit ?? false, score: Math.max(old?.score ?? 0, candidate.score), phrase: old?.phrase }); }
      const selected = [...candidateIds.entries()].sort((a, b) => Number(b[1].explicit) - Number(a[1].explicit) || b[1].score - a[1].score || a[0].localeCompare(b[0])).slice(0, topK);
      candidatePairs += selected.length;
      for (const [targetId, signal] of selected) {
        const target = byId.get(targetId); if (!target) continue;
        const sharedTags = sharedTagsOf(source.metadata, target.metadata);
        const classification = validateClassification(classifier.classify({ source, target, signals: { explicit: signal.explicit, ftsScore: signal.score, sharedTags } }));
        if (classification.relation === 'none' || classification.confidence < minRelated) continue;
        const type = classification.relation as SkillRelationType;
        const key = `${source.id}@${source.version}|${type}|${target.id}`;
        if (canonical.has(key)) { detectorStats.skippedCanonical += 1; continue; }
        const evidence = classification.evidence;
        const fingerprint = proposalFingerprint({ scope, sourceSkillId: source.id, sourceVersion: source.version, targetSkillId: target.id, relationType: type, targetVersionConstraint: classification.targetVersionConstraint, evidence, detectorVersion: 'relation-heuristic-v2' });
        const existing = this.db.prepare('SELECT status FROM skill_relation_proposals WHERE owner_user_id=? AND scope_agent_id=? AND proposal_fingerprint=?').get(scope.ownerUserId, scope.agentId, fingerprint) as { status: RelationProposalStatus } | undefined;
        if (existing) { detectorStats.rejectedSuppressed += 1; continue; }
        const proposal: RelationProposal = { id: id(), scope, sourceSkillId: source.id, sourceVersion: source.version, targetSkillId: target.id, targetVersionSnapshot: target.version, relationType: type, targetVersionConstraint: classification.targetVersionConstraint, reviewedRelationType: null, reviewedSourceSkillId: null, reviewedTargetSkillId: null, reviewedConstraint: null, reviewedConstraintSet: false, reviewModified: false, origin: 'discovered', candidateScore: signal.score, confidence: classification.confidence, detector: signal.explicit ? 'explicit-reference-v1' : 'fts-candidate-v1', detectorVersion: 'relation-heuristic-v2', model: null, evidence, reason: classification.reason, status: 'proposed', createdAt: now(), reviewedAt: null, reviewedBy: null, rejectionReason: null, proposalFingerprint: fingerprint };
        detectorStats[proposal.detector] += 1; detectorStats['relation-heuristic-v2'] += 1;
        proposals.push(proposal);
        if (!options.dryRun) this.insertProposal(proposal);
      }
    }
    return { skillsScanned: heads.length, candidatePairs, proposals, detectorStats };
  }
  private insertProposal(proposal: RelationProposal): void {
    this.db.prepare(`INSERT INTO skill_relation_proposals(id,owner_user_id,scope_agent_id,source_skill_id,source_version,target_skill_id,target_version_snapshot,relation_type,target_version_constraint,reviewed_relation_type,reviewed_source_skill_id,reviewed_target_skill_id,reviewed_constraint,reviewed_constraint_set,review_modified,origin,candidate_score,confidence,detector,detector_version,model,evidence_json,reason,status,created_at,reviewed_at,reviewed_by,rejection_reason,proposal_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(proposal.id, proposal.scope.ownerUserId, proposal.scope.agentId, proposal.sourceSkillId, proposal.sourceVersion, proposal.targetSkillId, proposal.targetVersionSnapshot, proposal.relationType, proposal.targetVersionConstraint, proposal.reviewedRelationType, proposal.reviewedSourceSkillId, proposal.reviewedTargetSkillId, proposal.reviewedConstraint, proposal.reviewedConstraintSet ? 1 : 0, proposal.reviewModified ? 1 : 0, proposal.origin, proposal.candidateScore, proposal.confidence, proposal.detector, proposal.detectorVersion, proposal.model, JSON.stringify(proposal.evidence), proposal.reason, proposal.status, proposal.createdAt, null, null, null, proposal.proposalFingerprint);
    this.audit.append({ action: 'skill.relation.proposal.created', actor: { userId: this.actor.userId, agentId: this.actor.agentId, harnessId: this.actor.harnessId }, scope: this.actor.scope, target: proposal.id, requestDigest: proposal.proposalFingerprint, metadata: { source: proposal.sourceSkillId, target: proposal.targetSkillId, relation: proposal.relationType, confidence: proposal.confidence } });
  }
  private markDrifted(scope: Scope): void { this.db.prepare(`UPDATE skill_relation_proposals SET status='stale' WHERE owner_user_id=? AND scope_agent_id=? AND status IN ('proposed','approved') AND (source_version <> (SELECT current_version FROM skill_entries WHERE id=source_skill_id AND owner_user_id=? AND scope_agent_id=? AND lifecycle='active') OR target_version_snapshot <> (SELECT current_version FROM skill_entries WHERE id=target_skill_id AND owner_user_id=? AND scope_agent_id=? AND lifecycle='active'))`).run(scope.ownerUserId, scope.agentId, scope.ownerUserId, scope.agentId, scope.ownerUserId, scope.agentId); }
  public list(scope: Scope, filters: { status?: RelationProposalStatus; relationType?: SkillRelationType; detector?: string; minConfidence?: number } = {}): RelationProposal[] { this.guard(scope); this.markDrifted(scope); const where = ['owner_user_id=?','scope_agent_id=?']; const args: Array<string | number> = [scope.ownerUserId, scope.agentId]; if (filters.status) { where.push('status=?'); args.push(filters.status); } if (filters.relationType) { where.push('relation_type=?'); args.push(filters.relationType); } if (filters.detector) { where.push('detector=?'); args.push(filters.detector); } if (filters.minConfidence !== undefined) { where.push('confidence>=?'); args.push(filters.minConfidence); } const rows = this.db.prepare(`SELECT * FROM skill_relation_proposals WHERE ${where.join(' AND ')} ORDER BY confidence DESC,created_at,id`).all(...args) as Array<Record<string, unknown>>; return rows.map((row) => this.map(row)); }
  public get(idValue: string, scope: Scope): RelationProposal { this.guard(scope); const item = this.list(scope).find((proposal) => proposal.id === idValue); if (!item) throw new HubError('NOT_FOUND', 'proposal not found', 404); return item; }
  public createManual(input: { sourceSkillId: string; targetSkillId: string; relationType: SkillRelationType; constraint?: string | null; scope: Scope }, actorId: string): RelationProposal {
    this.guard(input.scope);
    void actorId;
    if (input.sourceSkillId === input.targetSkillId) throw new HubError('VALIDATION', 'self relation is not allowed', 400);
    const sourceVersion = this.headVersion(input.sourceSkillId, input.scope); const targetVersion = this.headVersion(input.targetSkillId, input.scope);
    const constraint = input.constraint ?? null;
    const evidence: RelationProposalEvidence[] = [{ kind: 'structured_reference', source: 'metadata', sourceVersion, excerpt: 'Manual relation staged by reviewer' }];
    const fingerprint = proposalFingerprint({ scope: input.scope, sourceSkillId: input.sourceSkillId, sourceVersion, targetSkillId: input.targetSkillId, relationType: input.relationType, targetVersionConstraint: constraint, evidence, detectorVersion: 'manual-v1' });
    const existing = this.db.prepare('SELECT id FROM skill_relation_proposals WHERE owner_user_id=? AND scope_agent_id=? AND proposal_fingerprint=?').get(input.scope.ownerUserId, input.scope.agentId, fingerprint) as { id: string } | undefined;
    if (existing) return this.get(existing.id, input.scope);
    const proposal: RelationProposal = { id: id(), scope: input.scope, sourceSkillId: input.sourceSkillId, sourceVersion, targetSkillId: input.targetSkillId, targetVersionSnapshot: targetVersion, relationType: input.relationType, targetVersionConstraint: constraint, reviewedRelationType: null, reviewedSourceSkillId: null, reviewedTargetSkillId: null, reviewedConstraint: null, reviewedConstraintSet: false, reviewModified: false, origin: 'manual', candidateScore: null, confidence: 0, detector: 'manual', detectorVersion: 'manual-v1', model: null, evidence, reason: 'manual relation creation', status: 'proposed', createdAt: now(), reviewedAt: null, reviewedBy: null, rejectionReason: null, proposalFingerprint: fingerprint };
    this.insertProposal(proposal); return proposal;
  }
  public createFromExplicitMetadata(input: { sourceSkillId: string; targetSkillId: string; relationType: SkillRelationType; constraint?: string | null; scope: Scope; pairKey: string; reciprocal: boolean; sourceDeclaresTarget: boolean; targetDeclaredSource: boolean }, actorId: string): RelationProposal {
    this.guard(input.scope);
    void actorId;
    if (input.sourceSkillId === input.targetSkillId) throw new HubError('VALIDATION', 'self relation is not allowed', 400);
    const sourceVersion = this.headVersion(input.sourceSkillId, input.scope); const targetVersion = this.headVersion(input.targetSkillId, input.scope);
    const constraint = input.constraint ?? null;
    const evidence: RelationProposalEvidence[] = [{
      kind: 'structured_reference',
      source: 'metadata',
      sourceVersion,
      excerpt: `pairKey=${input.pairKey}; sourceDeclaresTarget=${input.sourceDeclaresTarget}; targetDeclaredSource=${input.targetDeclaredSource}; reciprocal=${input.reciprocal}`,
    }];
    const fingerprint = proposalFingerprint({ scope: input.scope, sourceSkillId: input.sourceSkillId, sourceVersion, targetSkillId: input.targetSkillId, relationType: input.relationType, targetVersionConstraint: constraint, evidence, detectorVersion: 'metadata-related-skills-v1' });
    const existing = this.db.prepare('SELECT id FROM skill_relation_proposals WHERE owner_user_id=? AND scope_agent_id=? AND proposal_fingerprint=?').get(input.scope.ownerUserId, input.scope.agentId, fingerprint) as { id: string } | undefined;
    if (existing) return this.get(existing.id, input.scope);
    // The product's storage schema constrains `origin` to
    // ('discovered', 'manual'). We persist the explicit-metadata
    // provenance on `detector` (and audit it) so the row stays
    // schema-compatible and existing tooling recognizes the source
    // without parsing strings.
    const proposal: RelationProposal = {
      id: id(), scope: input.scope,
      sourceSkillId: input.sourceSkillId, sourceVersion,
      targetSkillId: input.targetSkillId, targetVersionSnapshot: targetVersion,
      relationType: input.relationType, targetVersionConstraint: constraint,
      reviewedRelationType: null, reviewedSourceSkillId: null, reviewedTargetSkillId: null, reviewedConstraint: null, reviewedConstraintSet: false, reviewModified: false,
      origin: 'manual', candidateScore: null, confidence: 0,
      detector: 'metadata-related-skills-v1', detectorVersion: '1.0.0', model: null,
      evidence, reason: 'explicit metadata.hermes.related_skills', status: 'proposed', createdAt: now(), reviewedAt: null, reviewedBy: null, rejectionReason: null,
      proposalFingerprint: fingerprint,
    };
    this.insertProposal(proposal);
    this.audit.append({ action: 'skill.relation.proposal.explicit_metadata.staged', actor: { userId: this.actor.userId, agentId: this.actor.agentId, harnessId: this.actor.harnessId }, scope: this.actor.scope, target: proposal.id, requestDigest: proposal.id, metadata: { source: input.sourceSkillId, target: input.targetSkillId, relationType: input.relationType, pairKey: input.pairKey, reciprocal: input.reciprocal, detector: 'metadata-related-skills-v1' } });
    return proposal;
  }
  public review(idValue: string, status: 'approved' | 'rejected', scope: Scope, actorId: string, reason?: string, changes?: { relationType?: SkillRelationType; reverseDirection?: boolean; constraint?: string | null }): RelationProposal {
    const proposal = this.get(idValue, scope); if (proposal.status !== 'proposed') throw new HubError('CONFLICT', 'proposal is not reviewable', 409);
    const relationType = changes?.relationType ?? null; const reverse = changes?.reverseDirection === true;
    if (reverse && relationType === 'related_to') throw new HubError('VALIDATION', 'reverse direction is not meaningful for symmetric relation', 400);
    const reviewedSource = reverse ? proposal.targetSkillId : null; const reviewedTarget = reverse ? proposal.sourceSkillId : null;
    const constraintSet = changes ? Object.hasOwn(changes, 'constraint') : false;
    const reviewedConstraint = constraintSet ? (changes?.constraint ?? null) : null;
    const modified = Boolean(relationType || reverse || constraintSet);
    if (relationType && !Object.hasOwn({ requires: 1, uses: 1, extends: 1, supersedes: 1, conflicts_with: 1, related_to: 1, produces: 1, consumes: 1 }, relationType)) throw new HubError('VALIDATION', 'unsupported reviewed relation type', 400);
    const reviewedAt = now();
    this.db.prepare('UPDATE skill_relation_proposals SET status=?,reviewed_relation_type=?,reviewed_source_skill_id=?,reviewed_target_skill_id=?,reviewed_constraint=?,reviewed_constraint_set=?,review_modified=?,reviewed_at=?,reviewed_by=?,rejection_reason=? WHERE id=? AND owner_user_id=? AND scope_agent_id=?').run(status, relationType, reviewedSource, reviewedTarget, reviewedConstraint, constraintSet ? 1 : 0, modified ? 1 : 0, reviewedAt, actorId, status === 'rejected' ? (reason ?? 'rejected by reviewer') : null, idValue, scope.ownerUserId, scope.agentId);
    this.audit.append({ action: `skill.relation.proposal.${modified ? 'edited' : status}`, actor: { userId: this.actor.userId, agentId: this.actor.agentId, harnessId: this.actor.harnessId }, scope: this.actor.scope, target: idValue, requestDigest: idValue, metadata: { reason, modified, reverseDirection: reverse } }); return this.get(idValue, scope);
  }
  public previewApply(ids: string[], scope: Scope): RelationProposalPreview { this.guard(scope); const proposals = ids.map((value) => this.get(value, scope)); const changes = proposals.map((proposal) => { const effective = resolveEffectiveProposal(proposal); const sourceVersion = effective.sourceSkillId === proposal.sourceSkillId ? proposal.sourceVersion : proposal.targetVersionSnapshot; const targetVersion = effective.targetSkillId === proposal.targetSkillId ? proposal.targetVersionSnapshot : proposal.sourceVersion; return ({ proposalId: proposal.id, sourceSkillId: effective.sourceSkillId, sourceVersion, targetSkillId: effective.targetSkillId, targetVersion, relationType: effective.relationType, targetVersionConstraint: effective.targetVersionConstraint, confidence: proposal.confidence, evidenceSummary: proposal.evidence.map((item) => `${item.kind}${item.excerpt ? `: ${redactText(item.excerpt).slice(0, 160)}` : ''}`) }); }); return { proposalIds: ids, changes, planDigest: canonicalDigest(changes) }; }
  public apply(ids: string[], reviewedDigest: string, scope: Scope, actorId: string, requestId: string): RelationProposalPreview {
    const preview = this.previewApply(ids, scope); if (preview.planDigest !== reviewedDigest) throw new HubError('CONFLICT', 'reviewed digest mismatch', 409);
    for (const item of ids.map((value) => this.get(value, scope))) {
      if (item.status !== 'approved') throw new HubError('CONFLICT', 'only approved proposals can be applied', 409);
      const effective = resolveEffectiveProposal(item);
      const effectiveSourceVersion = effective.sourceSkillId === item.sourceSkillId ? item.sourceVersion : item.targetVersionSnapshot;
      const effectiveTargetVersion = effective.targetSkillId === item.targetSkillId ? item.targetVersionSnapshot : item.sourceVersion;
      const source = this.headVersion(effective.sourceSkillId, scope); const target = this.headVersion(effective.targetSkillId, scope);
      if (source !== effectiveSourceVersion || target !== effectiveTargetVersion) { this.db.prepare("UPDATE skill_relation_proposals SET status='stale' WHERE id=?").run(item.id); throw new HubError('CONFLICT', 'proposal source or target head drifted', 409); }
      if (this.db.prepare('SELECT 1 FROM skill_relations WHERE owner_user_id=? AND scope_agent_id=? AND source_skill_id=? AND source_version=? AND relation_type=? AND target_skill_id=?').get(scope.ownerUserId, scope.agentId, effective.sourceSkillId, effectiveSourceVersion, effective.relationType, effective.targetSkillId)) throw new HubError('CONFLICT', 'canonical relation already exists', 409);
      this.assertAcyclic({ ...item, sourceSkillId: effective.sourceSkillId, targetSkillId: effective.targetSkillId, relationType: effective.relationType }, scope);
      this.db.prepare('INSERT INTO skill_relations(source_skill_id,source_version,owner_user_id,scope_agent_id,relation_type,target_skill_id,target_version_constraint,resolved_target_version,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(effective.sourceSkillId, effectiveSourceVersion, scope.ownerUserId, scope.agentId, effective.relationType, effective.targetSkillId, effective.targetVersionConstraint, effectiveTargetVersion,JSON.stringify({ proposalId: item.id, origin: item.origin === 'manual' ? 'manual_reviewed' : 'reviewed_proposal', detector: item.detector, confidence: item.confidence, reviewedBy: actorId, appliedAt: now() }),now());
      this.db.prepare("UPDATE skill_relation_proposals SET status='superseded',reviewed_at=?,reviewed_by=? WHERE id=?").run(now(), actorId, item.id);
      this.supersedeCanonicalDuplicates({ canonical: { sourceSkillId: effective.sourceSkillId, sourceVersion: effectiveSourceVersion, targetSkillId: effective.targetSkillId, relationType: effective.relationType }, scope, actorId, excludeProposalId: item.id });
      this.audit.append({ action:'skill.relation.proposal.applied', actor:{ userId:this.actor.userId, agentId:this.actor.agentId, harnessId:this.actor.harnessId }, scope:this.actor.scope, target:item.id, requestDigest:requestId, metadata:{ relation:effective.relationType, source:effective.sourceSkillId, target:effective.targetSkillId } });
    }
    return preview;
  }
  /**
   * Mark every active proposal that is semantically equivalent to a given
   * canonical relation as `superseded`, leaving terminal proposals
   * (rejected, applied, already superseded, stale) untouched.
   *
   * `related_to` is symmetric; all other types are directional. The audit
   * trail is stored in `rejection_reason` using the format
   * `canonical_equivalent_exists:<relationKey>` where `<relationKey>` is
   * the canonical identity (no new columns needed).
   */
  public supersedeCanonicalDuplicates(input: {
    canonical: { sourceSkillId: string; sourceVersion: number; targetSkillId: string; relationType: SkillRelationType };
    scope: Scope;
    actorId: string;
    excludeProposalId?: string;
  }): RelationProposal[] {
    this.guard(input.scope);
    const { canonical, scope, actorId, excludeProposalId } = input;
    const relationKey = `${canonical.relationType}@${canonical.sourceSkillId}@${canonical.sourceVersion}->${canonical.targetSkillId}`;
    const ts = now();
    const isSymmetric = canonical.relationType === 'related_to';
    const candidates = (() => {
      if (isSymmetric) {
        return this.db.prepare(`
          SELECT id FROM skill_relation_proposals
          WHERE owner_user_id=? AND scope_agent_id=?
            AND relation_type=?
            AND status IN ('proposed')
            AND ((source_skill_id=? AND target_skill_id=?) OR (source_skill_id=? AND target_skill_id=?))
        `).all(scope.ownerUserId, scope.agentId, canonical.relationType, canonical.sourceSkillId, canonical.targetSkillId, canonical.targetSkillId, canonical.sourceSkillId) as Array<{ id: string }>;
      }
      return this.db.prepare(`
        SELECT id FROM skill_relation_proposals
        WHERE owner_user_id=? AND scope_agent_id=?
          AND relation_type=?
          AND status IN ('proposed')
          AND source_skill_id=? AND target_skill_id=?
      `).all(scope.ownerUserId, scope.agentId, canonical.relationType, canonical.sourceSkillId, canonical.targetSkillId) as Array<{ id: string }>;
    })();
    const out: RelationProposal[] = [];
    for (const { id } of candidates) {
      if (excludeProposalId && id === excludeProposalId) continue;
      const existing = this.db.prepare(`SELECT 1 FROM skill_relation_proposals WHERE id=? AND status IN ('superseded','rejected','applied','stale')`).get(id);
      if (existing) continue;
      const rejectionReason = `canonical_equivalent_exists:${relationKey}`;
      this.db.prepare("UPDATE skill_relation_proposals SET status='superseded', reviewed_at=?, reviewed_by=?, rejection_reason=? WHERE id=? AND status='proposed'").run(ts, actorId, rejectionReason, id);
      this.audit.append({ action: 'skill.relation.proposal.superseded_by_canonical', actor: { userId: this.actor.userId, agentId: this.actor.agentId, harnessId: this.actor.harnessId }, scope: this.actor.scope, target: id, requestDigest: relationKey, metadata: { canonicalRelationKey: relationKey, supersedeReason: 'canonical_equivalent_exists' } });
      out.push(this.get(id, scope));
    }
    return out;
  }
  /**
   * Run `supersedeCanonicalDuplicates` against every active discovered or
   * manual proposal whose equivalence matches any row currently in
   * `skill_relations`. Returns the list of proposals that were
   * transitioned from `proposed` to `superseded`.
   */
  public reconcileCanonicalDuplicates(scope: Scope, actorId: string): RelationProposal[] {
    this.guard(scope);
    const canonicals = this.db.prepare(`
      SELECT source_skill_id, source_version, relation_type, target_skill_id
      FROM skill_relations
      WHERE owner_user_id=? AND scope_agent_id=?
    `).all(scope.ownerUserId, scope.agentId) as Array<{ source_skill_id: string; source_version: number; relation_type: SkillRelationType; target_skill_id: string }>;
    const seen = new Set<string>();
    const out: RelationProposal[] = [];
    for (const row of canonicals) {
      const key = `${row.relation_type}|${row.source_skill_id}|${row.target_skill_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(...this.supersedeCanonicalDuplicates({ canonical: { sourceSkillId: row.source_skill_id, sourceVersion: Number(row.source_version), targetSkillId: row.target_skill_id, relationType: row.relation_type }, scope, actorId }));
    }
    return out;
  }
  private headVersion(idValue: string, scope: Scope): number { const row = this.db.prepare(`SELECT current_version FROM skill_entries WHERE id=? AND owner_user_id=? AND scope_agent_id=? AND lifecycle='active'`).get(idValue,scope.ownerUserId,scope.agentId) as {current_version:number}|undefined; if (!row) throw new HubError('NOT_FOUND','skill not found',404); return Number(row.current_version); }
  private assertAcyclic(item: RelationProposal, scope: Scope): void { if (!OPERATIONAL_RELATION_TYPES.includes(item.relationType as typeof OPERATIONAL_RELATION_TYPES[number]) || !['requires','extends','supersedes'].includes(item.relationType)) return; const edges = this.db.prepare("SELECT source_skill_id,target_skill_id FROM skill_relations WHERE owner_user_id=? AND scope_agent_id=? AND relation_type=?").all(scope.ownerUserId,scope.agentId,item.relationType) as Array<{source_skill_id:string;target_skill_id:string}>; const graph = new Map<string,string[]>(); for (const edge of edges) graph.set(edge.source_skill_id,[...(graph.get(edge.source_skill_id)??[]),edge.target_skill_id]); graph.set(item.sourceSkillId,[...(graph.get(item.sourceSkillId)??[]),item.targetSkillId]); const visit=(node:string,stack:Set<string>,seen:Set<string>):boolean=>{if(stack.has(node))return false;if(seen.has(node))return true;stack.add(node);for(const next of graph.get(node)??[])if(!visit(next,stack,seen))return false;stack.delete(node);seen.add(node);return true;}; if (![...graph.keys()].every((node)=>visit(node,new Set(),new Set()))) throw new HubError('CONFLICT','proposal would create a cycle',409); }
  private map(row: Record<string, unknown>): RelationProposal { return { id:String(row.id), scope:{ownerUserId:String(row.owner_user_id),agentId:String(row.scope_agent_id)}, sourceSkillId:String(row.source_skill_id), sourceVersion:Number(row.source_version), targetSkillId:String(row.target_skill_id), targetVersionSnapshot:Number(row.target_version_snapshot), relationType:String(row.relation_type) as SkillRelationType, targetVersionConstraint:row.target_version_constraint===null?null:String(row.target_version_constraint), reviewedRelationType:row.reviewed_relation_type===null?null:String(row.reviewed_relation_type) as SkillRelationType, reviewedSourceSkillId:row.reviewed_source_skill_id===null?null:String(row.reviewed_source_skill_id), reviewedTargetSkillId:row.reviewed_target_skill_id===null?null:String(row.reviewed_target_skill_id), reviewedConstraint:row.reviewed_constraint===null?null:String(row.reviewed_constraint), reviewedConstraintSet:Boolean(row.reviewed_constraint_set), reviewModified:Boolean(row.review_modified), origin:(String(row.origin) === 'discovered' || String(row.origin) === 'manual' ? String(row.origin) : 'manual') as 'discovered'|'manual', candidateScore:row.candidate_score===null?null:Number(row.candidate_score), confidence:Number(row.confidence), detector:String(row.detector), detectorVersion:String(row.detector_version), model:row.model===null?null:String(row.model), evidence:JSON.parse(String(row.evidence_json)) as RelationProposalEvidence[], reason:String(row.reason), status:String(row.status) as RelationProposalStatus, createdAt:String(row.created_at), reviewedAt:row.reviewed_at===null?null:String(row.reviewed_at), reviewedBy:row.reviewed_by===null?null:String(row.reviewed_by), rejectionReason:row.rejection_reason===null?null:String(row.rejection_reason), proposalFingerprint:String(row.proposal_fingerprint) }; }
}
function sharedTagsOf(a: Record<string, unknown>, b: Record<string, unknown>): string[] { const left = Array.isArray(a.tags) ? a.tags.filter((v): v is string => typeof v === 'string').map(normalized) : []; const right = new Set(Array.isArray(b.tags) ? b.tags.filter((v): v is string => typeof v === 'string').map(normalized) : []); return left.filter((tag) => right.has(tag)); }
