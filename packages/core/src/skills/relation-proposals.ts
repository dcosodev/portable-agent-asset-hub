import { createHash } from 'node:crypto';
import { HubError } from '../errors.js';
import { SKILL_RELATION_TYPES, type SkillRelationType } from './graph.js';

export const RELATION_PROPOSAL_STATUSES = ['proposed', 'approved', 'rejected', 'superseded', 'stale'] as const;
export type RelationProposalStatus = typeof RELATION_PROPOSAL_STATUSES[number];
export const RELATION_DISCOVERY_MODES = ['strict', 'balanced', 'exploratory'] as const;
export type RelationDiscoveryMode = typeof RELATION_DISCOVERY_MODES[number];
export type RelationProposalOrigin = 'discovered' | 'manual';
/**
 * Provenance discriminator for proposals that originated from
 * `metadata.hermes.related_skills`. Stored on the proposal as
 * `detector='metadata-related-skills-v1'` and surfaced in
 * `evidence.excerpt` (and on the canonical row's `metadata_json`),
 * so no schema change is needed. The union is exposed here so the
 * UI can switch on the discriminator without parsing strings.
 */
export const EXPLICIT_METADATA_PROPOSAL_DETECTOR = 'metadata-related-skills-v1';
export type ExplicitMetadataMarker = typeof EXPLICIT_METADATA_PROPOSAL_DETECTOR;
export const OPERATIONAL_RELATION_TYPES = ['requires', 'uses', 'extends', 'supersedes', 'conflicts_with', 'produces', 'consumes'] as const;
export const SEMANTIC_RELATION_TYPES = ['related_to'] as const;
export type ProposalEvidenceKind = 'source_text' | 'metadata' | 'fts_similarity' | 'tag_overlap' | 'structured_reference';
export type ProposalEvidenceSource = 'body' | 'frontmatter' | 'description' | 'resource' | 'metadata';
export type RelationProposalEvidence = {
  kind: ProposalEvidenceKind;
  sourceVersion: number;
  source?: ProposalEvidenceSource;
  sourceAsset?: string;
  excerpt?: string;
  startOffset?: number;
  endOffset?: number;
  targetMentionOffset?: number;
  score?: number;
};
export type RelationProposal = {
  id: string;
  scope: { ownerUserId: string; agentId: string };
  sourceSkillId: string;
  sourceVersion: number;
  targetSkillId: string;
  targetVersionSnapshot: number;
  relationType: SkillRelationType;
  targetVersionConstraint: string | null;
  reviewedRelationType: SkillRelationType | null;
  reviewedSourceSkillId: string | null;
  reviewedTargetSkillId: string | null;
  reviewedConstraint: string | null;
  reviewedConstraintSet: boolean;
  reviewModified: boolean;
  origin: RelationProposalOrigin;
  candidateScore: number | null;
  confidence: number;
  detector: string;
  detectorVersion: string;
  model: string | null;
  evidence: RelationProposalEvidence[];
  reason: string;
  status: RelationProposalStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  proposalFingerprint: string;
};
export type RelationDiscoveryOptions = { topK?: number; minRelatedConfidence?: number; dryRun?: boolean; skillIds?: string[]; mode?: RelationDiscoveryMode };
export type RelationProposalPreview = { proposalIds: string[]; changes: Array<{ proposalId: string; sourceSkillId: string; sourceVersion: number; targetSkillId: string; targetVersion: number; relationType: SkillRelationType; targetVersionConstraint: string | null; confidence: number; evidenceSummary: string[] }>; planDigest: string };
export interface RelationProposalRepository {
  discover(scope: { ownerUserId: string; agentId: string }, options?: RelationDiscoveryOptions): RelationDiscoveryResult;
  list(scope: { ownerUserId: string; agentId: string }, filters?: { status?: RelationProposalStatus; relationType?: SkillRelationType; detector?: string; minConfidence?: number }): RelationProposal[];
  get(id: string, scope: { ownerUserId: string; agentId: string }): RelationProposal;
  /**
   * Create a manual proposal that originates from
   * `metadata.hermes.related_skills`. Reuses the same lifecycle and
   * dedupe rules as `createManual` but carries `origin='explicit_metadata'`
   * and a detector field that distinguishes the source so review
   * tooling can recognize it.
   */
  createFromExplicitMetadata(input: {
    sourceSkillId: string;
    targetSkillId: string;
    relationType: SkillRelationType;
    constraint?: string | null;
    scope: { ownerUserId: string; agentId: string };
    /** Stable pair key from the explicit extractor; stored in evidence. */
    pairKey: string;
    /** Source vs target evidence; stored in the evidence excerpt. */
    reciprocal: boolean;
    sourceDeclaresTarget: boolean;
    targetDeclaredSource: boolean;
  }, actorId: string): RelationProposal;
  createManual(input: { sourceSkillId: string; targetSkillId: string; relationType: SkillRelationType; constraint?: string | null; scope: { ownerUserId: string; agentId: string } }, actorId: string): RelationProposal;
  review(id: string, status: 'approved' | 'rejected', scope: { ownerUserId: string; agentId: string }, actorId: string, reason?: string, changes?: { relationType?: SkillRelationType; reverseDirection?: boolean; constraint?: string | null }): RelationProposal;
  previewApply(ids: string[], scope: { ownerUserId: string; agentId: string }): RelationProposalPreview;
  apply(ids: string[], reviewedDigest: string, scope: { ownerUserId: string; agentId: string }, actorId: string, requestId: string): RelationProposalPreview;
  /**
   * Mark every active proposal that is semantically equivalent to a given
   * canonical relation as `superseded`, leaving terminal proposals (rejected,
   * applied, already superseded, stale) untouched.
   *
   * Equivalence rules:
   *   - `related_to` is symmetric: canonical (A,B) matches proposals
   *     (A,B) and (B,A).
   *   - All other relation types are directional: canonical (A,B) only
   *     matches proposals (A,B).
   *
   * The canonical identity is identified by
   * `(ownerUserId, scopeAgentId, relationType, sourceSkillId, sourceVersion,
   * targetSkillId)` and is encoded into the proposal's `rejection_reason`
   * field as `canonical_equivalent_exists:<relationKey>` so the audit trail
   * stays in the existing schema (no new columns).
   */
  supersedeCanonicalDuplicates(input: {
    canonical: {
      sourceSkillId: string;
      sourceVersion: number;
      targetSkillId: string;
      relationType: SkillRelationType;
    };
    scope: { ownerUserId: string; agentId: string };
    actorId: string;
    excludeProposalId?: string;
  }): RelationProposal[];
  /**
   * Run `supersedeCanonicalDuplicates` against every active discovered or
   * manual proposal whose equivalence matches any row currently in
   * `skill_relations`. Returns the list of proposals that were
   * transitioned from `proposed` to `superseded`.
   */
  reconcileCanonicalDuplicates(scope: { ownerUserId: string; agentId: string }, actorId: string): RelationProposal[];
}
export type RelationDiscoveryResult = {
  skillsScanned: number;
  candidatePairs: number;
  proposals: RelationProposal[];
  detectorStats: Record<string, number>;
};
export type EffectiveRelationProposal = { sourceSkillId: string; targetSkillId: string; relationType: SkillRelationType; targetVersionConstraint: string | null };
export function resolveEffectiveProposal(proposal: Pick<RelationProposal, 'sourceSkillId' | 'targetSkillId' | 'relationType' | 'targetVersionConstraint' | 'reviewedSourceSkillId' | 'reviewedTargetSkillId' | 'reviewedRelationType' | 'reviewedConstraint' | 'reviewedConstraintSet'>): EffectiveRelationProposal {
  return { sourceSkillId: proposal.reviewedSourceSkillId ?? proposal.sourceSkillId, targetSkillId: proposal.reviewedTargetSkillId ?? proposal.targetSkillId, relationType: proposal.reviewedRelationType ?? proposal.relationType, targetVersionConstraint: proposal.reviewedConstraintSet ? proposal.reviewedConstraint : proposal.targetVersionConstraint };
}
export type RelationClassification = {
  relation: SkillRelationType | 'none';
  confidence: number;
  reason: string;
  evidence: RelationProposalEvidence[];
  targetVersionConstraint: string | null;
};
export type RelationClassifierInput = {
  source: { id: string; version: number; logicalKey: string; name: string; summary?: string; metadata: Record<string, unknown>; bodyExcerpt: string; bodyOffset?: number };
  target: { id: string; version: number; logicalKey: string; name: string; summary?: string; metadata: Record<string, unknown>; bodyExcerpt: string };
  signals: { explicit: boolean; ftsScore: number; sharedTags: string[] };
};
export interface RelationClassifier { classify(input: RelationClassifierInput): RelationClassification; }

export function relationKind(type: SkillRelationType): 'operational' | 'semantic' { return type === 'related_to' ? 'semantic' : 'operational'; }
export function confidenceBand(value: number): 'high' | 'medium' | 'low' {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new HubError('VALIDATION', 'confidence must be in 0..1', 400);
  return value >= 0.85 ? 'high' : value >= 0.6 ? 'medium' : 'low';
}
function excerpt(text: string, start: number, end: number): { text: string; start: number; end: number } {
  const boundedStart = Math.max(0, start - 100);
  const boundedEnd = Math.min(text.length, Math.max(end + 100, boundedStart + 240));
  return { text: redactEvidence(text.slice(boundedStart, boundedEnd)), start: boundedStart, end: boundedEnd };
}
export function redactEvidence(text: string): string {
  return text.replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]');
}
function tokens(value: string): Set<string> { return new Set(value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/giu) ?? []); }
function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function isCommonName(name: string): boolean { return new Set(['plan', 'maps', 'docx', 'pdf', 'notion']).has(name.toLocaleLowerCase()); }
function hasNegativeOrConditional(text: string): boolean {
  return /\b(?:do\s+not|don't|never|not\s+required|without|avoid|instead\s+of|otherwise|when\s+not|if\s+input|for\s+.+\s+use|optional)\b/iu.test(text);
}
function relationForLocalText(local: string, targetName: string): { relation: SkillRelationType | 'none'; reason: string; confidence: number; constraint: string | null } {
  if (hasNegativeOrConditional(local)) return { relation: 'none', reason: 'negative or conditional routing; operational relation abstained', confidence: 0.18, constraint: null };
  const target = escaped(targetName);
  const rules: Array<{ pattern: RegExp; relation: SkillRelationType; reason: string; confidence: number }> = [
    { pattern: new RegExp(`(?:requires?|depends\\s+on|prerequisite)\\s+(?:the\\s+)?(?:skill\\s+)?${target}\\b`, 'iu'), relation: 'requires', reason: 'explicit prerequisite language', confidence: 0.97 },
    { pattern: new RegExp(`${target}\\s+(?:must\\s+exist|is\\s+required)\\s+before`, 'iu'), relation: 'requires', reason: 'target prerequisite before source', confidence: 0.97 },
    { pattern: new RegExp(`(?:run|use|invoke|complete)\\s+(?:the\\s+)?(?:skill\\s+)?${target}\\b[^.\\n]{0,50}\\bbefore\\b`, 'iu'), relation: 'requires', reason: 'target must run before source', confidence: 0.97 },
    { pattern: new RegExp(`(?:produces?|outputs?)\\s+(?:the\\s+)?${target}\\s+skill\\b`, 'iu'), relation: 'produces', reason: 'explicit skill capability output language', confidence: 0.95 },
    { pattern: new RegExp(`(?:consumes?|inputs?)\\s+(?:the\\s+)?${target}\\s+skill\\b`, 'iu'), relation: 'consumes', reason: 'explicit skill capability input language', confidence: 0.95 },
    { pattern: new RegExp(`(?:use|apply|invoke)\\s+(?:the\\s+)?(?:skill\\s+)?${target}\\b`, 'iu'), relation: 'uses', reason: 'explicit workflow usage language', confidence: 0.94 },
    { pattern: new RegExp(`(?:extends?|builds\\s+upon|speciali[sz]ation\\s+of|adds\\s+behavior\\s+to)\\s+(?:the\\s+)?${target}\\b`, 'iu'), relation: 'extends', reason: 'explicit extension language', confidence: 0.96 },
    { pattern: new RegExp(`(?:replaces?|supersedes?|successor\\s+to|deprecated\\s+in\\s+favor\\s+of)\\s+(?:the\\s+)?${target}\\b`, 'iu'), relation: 'supersedes', reason: 'explicit replacement language', confidence: 0.96 },
    { pattern: new RegExp(`(?:conflicts?\\s+with|incompatible\\s+with|cannot\\s+be\\s+used\\s+with|mutually\\s+exclusive\\s+with)\\s+(?:the\\s+)?${target}\\b`, 'iu'), relation: 'conflicts_with', reason: 'explicit conflict language', confidence: 0.96 },
  ];
  const match = rules.find((rule) => rule.pattern.test(local));
  if (!match) return { relation: 'none', reason: 'no local affirmative operational predicate', confidence: 0.22, constraint: null };
  return { relation: match.relation, reason: match.reason, confidence: isCommonName(targetName) ? Math.min(0.84, match.confidence) : match.confidence, constraint: match.relation === 'requires' ? inferConstraint(local, targetName) : null };
}
export function validateDirection(localText: string, targetName: string, relation: SkillRelationType): boolean {
  return relationForLocalText(localText, targetName).relation === relation;
}
export class DeterministicRelationClassifier implements RelationClassifier {
  public classify(input: RelationClassifierInput): RelationClassification {
    const text = input.source.bodyExcerpt;
    if (input.signals.explicit) {
      const aliases = [input.target.id, input.target.logicalKey, input.target.name, ...((input.target.metadata.aliases as unknown[] | undefined)?.filter((v): v is string => typeof v === 'string') ?? [])].filter((value) => value.length >= 3);
      const aliasPattern = aliases.map(escaped).join('|');
      const targetMatch = aliasPattern ? new RegExp(`(?:${aliasPattern})`, 'iu').exec(text) : null;
      if (targetMatch) {
        const mentionStart = targetMatch.index;
        const mentionEnd = mentionStart + targetMatch[0].length;
        const localStart = Math.max(0, mentionStart - 120);
        const localEnd = Math.min(text.length, mentionEnd + 120);
        const local = text.slice(localStart, localEnd);
        const decision = relationForLocalText(local, input.target.name);
        if (decision.relation !== 'none' && validateDirection(local, input.target.name, decision.relation)) {
          const found = excerpt(text, localStart, localEnd);
          const offset = input.source.bodyOffset ?? 0;
          return { relation: decision.relation, confidence: decision.confidence, reason: decision.reason, targetVersionConstraint: decision.constraint, evidence: [{ kind: 'source_text', source: 'body', sourceVersion: input.source.version, excerpt: found.text, startOffset: offset + found.start, endOffset: offset + found.end, targetMentionOffset: offset + mentionStart }] };
        }
        return { relation: 'none', confidence: decision.confidence, reason: decision.reason, targetVersionConstraint: null, evidence: [{ kind: 'source_text', source: 'body', sourceVersion: input.source.version, excerpt: redactEvidence(local), startOffset: (input.source.bodyOffset ?? 0) + localStart, endOffset: (input.source.bodyOffset ?? 0) + localEnd, targetMentionOffset: (input.source.bodyOffset ?? 0) + mentionStart }] };
      }
      return { relation: 'none', confidence: 0.1, reason: 'explicit signal without target identity in operative body', targetVersionConstraint: null, evidence: [] };
    }
    const sourceTokens = tokens(`${input.source.logicalKey} ${input.source.name} ${input.source.summary ?? ''}`);
    const targetTokens = tokens(`${input.target.logicalKey} ${input.target.name} ${input.target.summary ?? ''}`);
    const overlap = [...sourceTokens].filter((token) => targetTokens.has(token)).length;
    const union = new Set([...sourceTokens, ...targetTokens]).size;
    const similarity = union ? overlap / union : 0;
    if (similarity >= 0.35 || input.signals.ftsScore >= 0.4 || input.signals.sharedTags.length >= 2) {
      const signal = Math.max(similarity, input.signals.ftsScore);
      const score = Math.min(0.84, Math.max(0.6, 0.6 + 0.24 * signal + 0.04 * Math.min(2, input.signals.sharedTags.length)));
      return { relation: 'related_to', confidence: Number(score.toFixed(6)), reason: 'bounded semantic similarity; no operational evidence', targetVersionConstraint: null, evidence: [{ kind: 'fts_similarity', source: 'metadata', sourceVersion: input.source.version, score: Number(Math.max(similarity, input.signals.ftsScore).toFixed(6)) }] };
    }
    return { relation: 'none', confidence: 0, reason: 'insufficient evidence', targetVersionConstraint: null, evidence: [] };
  }
}
function inferConstraint(text: string, targetName: string): string | null {
  const target = escaped(targetName);
  const plus = new RegExp(`${target}\\s+(?:v|version)\\s*(\\d+)\\+`, 'iu').exec(text);
  if (plus) return `>=${plus[1]}`;
  const exact = new RegExp(`${target}\\s+(?:v|version)\\s*(\\d+)\\b`, 'iu').exec(text);
  return exact ? `=${exact[1]}` : null;
}
export function proposalFingerprint(input: Pick<RelationProposal, 'scope' | 'sourceSkillId' | 'sourceVersion' | 'targetSkillId' | 'relationType' | 'targetVersionConstraint' | 'evidence'> & { detectorVersion: string }): string {
  const identity = JSON.stringify({ owner: input.scope.ownerUserId, agent: input.scope.agentId, source: input.sourceSkillId, sourceVersion: input.sourceVersion, target: input.targetSkillId, relation: input.relationType, constraint: input.targetVersionConstraint, detectorVersion: input.detectorVersion, evidence: input.evidence.map((item) => ({ kind: item.kind, sourceVersion: item.sourceVersion, startOffset: item.startOffset, endOffset: item.endOffset, excerpt: item.excerpt, score: item.score })) });
  return createHash('sha256').update(identity).digest('hex');
}
export function validateClassification(value: unknown): RelationClassification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HubError('VALIDATION', 'invalid classifier result', 400);
  const record = value as Record<string, unknown>;
  if (record.relation !== 'none' && !Object.hasOwn(SKILL_RELATION_TYPES, record.relation as string)) throw new HubError('VALIDATION', 'classifier returned unsupported relation', 400);
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1 || typeof record.reason !== 'string' || !Array.isArray(record.evidence)) throw new HubError('VALIDATION', 'invalid classifier result schema', 400);
  return { relation: record.relation as RelationClassification['relation'], confidence: record.confidence, reason: record.reason, evidence: record.evidence as RelationProposalEvidence[], targetVersionConstraint: typeof record.targetVersionConstraint === 'string' ? record.targetVersionConstraint : null };
}
