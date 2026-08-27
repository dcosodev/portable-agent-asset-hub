// packages/core/src/skills/explicit-relations.ts
//
// Production-side extractor for `metadata.hermes.related_skills`.
//
// Replaces the previous Python audit under
// `artifacts/audit-2026-08-24/explicit-related-skills/` so the product
// itself can list, review and stage these candidates without depending
// on external scripts.
//
// No FTS, no classifier, no body semantic matching. The extractor only
// looks at the structured `metadata.hermes.related_skills` field of the
// current head of each skill.
//
// Equality rules (related_to symmetric, all others directional) live in
// `relation-identity.ts` and are reused by canonical-duplicate detection
// in `relation-proposal.ts`.
import type { Scope } from '../storage/contracts.js';
import type { SkillRelationType } from './graph.js';
import type { RelationProposal, RelationProposalOrigin } from './relation-proposals.js';
import { isSymmetricRelationType, normalizeRelationIdentity } from './relation-identity.js';

export type ExplicitCandidateStatus =
  | 'READY_FOR_REVIEW'
  | 'ALREADY_STAGED'
  | 'ALREADY_CANONICAL'
  | 'UNRESOLVED'
  | 'AMBIGUOUS';

export const EXPLICIT_CANDIDATE_STATUSES: readonly ExplicitCandidateStatus[] = [
  'READY_FOR_REVIEW',
  'ALREADY_STAGED',
  'ALREADY_CANONICAL',
  'UNRESOLVED',
  'AMBIGUOUS',
] as const;

export const EXPLICIT_RELATION_DETECTOR = 'metadata-related-skills-v1';
export const EXPLICIT_RELATION_DETECTOR_VERSION = '1.0.0';
/**
 * Proposals staged from the explicit extractor persist with
 * `origin='manual'` (the schema's enum) and a discriminator
 * `detector='metadata-related-skills-v1'`. The provenance is also
 * mirrored in the `reason` field. No schema change is required.
 */
export const EXPLICIT_RELATION_ORIGIN: RelationProposalOrigin = 'manual';
export const EXPLICIT_RELATION_SOURCE_KIND = 'metadata' as const;

export type ExplicitCandidateEvidence = {
  metadataField: 'metadata.hermes.related_skills';
  sourceDeclaredTarget: boolean;
  targetDeclaredSource: boolean;
  reciprocal: boolean;
};

export type ExplicitRelationCandidate = {
  pairKey: string;
  sourceSkillId: string;
  sourceLogicalKey: string;
  sourceVersion: number;
  targetSkillId: string | null;
  targetLogicalKey: string | null;
  targetVersion: number | null;
  relationType: SkillRelationType;
  sourceDeclaresTarget: boolean;
  targetDeclaredSource: boolean;
  reciprocal: boolean;
  status: ExplicitCandidateStatus;
  activeProposalIds: string[];
  canonicalRelationId: string | null;
  evidence: ExplicitCandidateEvidence;
  unresolvedToken?: string;
  ambiguousTargets?: Array<{ skillId: string; logicalKey: string; version: number }>;
  discoveryOverlap?: DiscoveryOverlap;
};

export type DiscoveryOverlap = {
  // True iff at least one active OR terminal `discovered` proposal with
  // an equivalent normalized identity exists in the proposal store.
  hasActiveOrTerminal: boolean;
  // True iff the active duplicate (if any) is currently `proposed`.
  hasActiveProposed: boolean;
  // Number of distinct discovered proposals that match.
  totalProposals: number;
  activeProposalIds: string[];
  bestDetector?: string;
  bestConfidence?: number;
};

export type ExplicitCandidateSummary = {
  total: number;
  ready: number;
  readyReciprocal: number;
  readyOneWay: number;
  alreadyCanonical: number;
  alreadyStaged: number;
  unresolved: number;
  ambiguous: number;
};

export type ExplicitCandidateListOptions = {
  status?: ExplicitCandidateStatus;
  reciprocal?: boolean;
  skillId?: string;
  limit?: number;
  cursor?: string;
};

export type ExplicitCandidateListResult = {
  items: ExplicitRelationCandidate[];
  summary: ExplicitCandidateSummary;
  nextCursor: string | null;
};

export type ExplicitSkillHead = {
  id: string;
  logicalKey: string;
  version: number;
  body: Buffer;
  metadata: unknown;
  relatedSkills?: string[];
};

export interface ExplicitRelationSource {
  listActiveHeads(scope: Scope): ExplicitSkillHead[];
  listActiveProposals(scope: Scope, filters?: { status?: RelationProposal['status']; origin?: RelationProposal['origin'] }): RelationProposal[];
  listCanonicalRelations(scope: Scope): CanonicalRelationRow[];
}

export type CanonicalRelationRow = {
  id: string;
  sourceSkillId: string;
  sourceVersion: number;
  targetSkillId: string;
  relationType: SkillRelationType;
};

const META_HERMES_PATH = ['metadata', 'hermes', 'related_skills'] as const;
const ACTIVE_PROPOSAL_STATUSES: ReadonlyArray<RelationProposal['status']> = ['proposed', 'approved'];

function readRelatedSkills(head: ExplicitSkillHead): string[] {
  // 1. Structured metadata_json column (preferred when present).
  const meta = head.metadata;
  if (meta && typeof meta === 'object') {
    let cursor: unknown = meta;
    for (const key of META_HERMES_PATH) {
      if (!cursor || typeof cursor !== 'object') break;
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (Array.isArray(cursor)) {
      const fromJson = cursor.filter((value): value is string => typeof value === 'string' && value.length > 0);
      if (fromJson.length > 0) return fromJson;
    }
  }
  // 2. Frontmatter fallback: parse the YAML body. The body is
  //    `---<frontmatter>\n---\n<content>`. We extract the
  //    `related_skills: [a, b, c]` line via a targeted regex that
  //    does NOT depend on a YAML library.
  if (head.body && head.body.length > 0) {
    const text = head.body.toString('utf8');
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const inlineMatch = fm.match(/(?:^|\n)\s*related_skills\s*:\s*\[([^\]]*)\]/);
      if (inlineMatch) {
        return inlineMatch[1]
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
      }
      const blockMatch = fm.match(/(?:^|\n)\s*related_skills\s*:\s*\n((?:\s*-\s*[^\n]+\n)+)/);
      if (blockMatch) {
        return Array.from(blockMatch[1].matchAll(/^\s*-\s*([^\n]+)$/gm))
          .map((m) => m[1].trim())
          .filter((value) => value.length > 0);
      }
    }
  }
  return [];
}

function pairKey(source: string, target: string, type: string): string {
  return `${type}@${source}->${target}`;
}

/**
 * Walk every active head, parse `metadata.hermes.related_skills`, and
 * produce one candidate per (source, target, related_to) pair. Resolution
 * rules:
 *
 * - The metadata field is an array of short tokens. Each token is
 *   resolved by the candidate's `logicalKey` against the active heads.
 *   - short: matches a head whose `logicalKey` ends in `:<token>`.
 *   - long: matches a head whose `logicalKey` is exactly `<token>`.
 *   - self: skipped (never produced as a candidate).
 * - A token that matches zero heads is captured as `UNRESOLVED` with the
 *   raw token preserved for the unresolved-UX surface.
 * - A token that matches more than one head is captured as `AMBIGUOUS`
 *   with the list of matching head IDs.
 */
export function listExplicitCandidates(source: ExplicitRelationSource, scope: Scope, options: ExplicitCandidateListOptions = {}): ExplicitCandidateListResult {
  const heads = source.listActiveHeads(scope);
  const headByLogicalKey = new Map<string, ExplicitSkillHead[]>();
  for (const head of heads) {
    const lk = head.logicalKey;
    const arr = headByLogicalKey.get(lk);
    if (arr) arr.push(head);
    else headByLogicalKey.set(lk, [head]);
  }
  // Build short -> candidates map: every head contributes its
  // short token (the part after the last ':').
  const shortToHeads = new Map<string, ExplicitSkillHead[]>();
  for (const head of heads) {
    const lk = head.logicalKey;
    const idx = lk.lastIndexOf(':');
    const short = idx >= 0 ? lk.slice(idx + 1) : lk;
    if (!short) continue;
    const arr = shortToHeads.get(short);
    if (arr) arr.push(head);
    else shortToHeads.set(short, [head]);
  }

  const canonical = source.listCanonicalRelations(scope);
  const canonicalByKey = new Map<string, CanonicalRelationRow>();
  for (const row of canonical) {
    canonicalByKey.set(
      normalizeRelationIdentity({
        sourceSkillId: row.sourceSkillId,
        sourceVersion: row.sourceVersion,
        targetSkillId: row.targetSkillId,
        targetVersion: null,
        relationType: row.relationType,
      }),
      row,
    );
  }

  const active = source.listActiveProposals(scope);
  const activeByKey = new Map<string, RelationProposal[]>();
  for (const proposal of active) {
    if (!ACTIVE_PROPOSAL_STATUSES.includes(proposal.status)) continue;
    const key = normalizeRelationIdentity({
      sourceSkillId: proposal.sourceSkillId,
      sourceVersion: proposal.sourceVersion,
      targetSkillId: proposal.targetSkillId,
      targetVersion: proposal.targetVersionSnapshot,
      relationType: proposal.relationType,
    });
    const arr = activeByKey.get(key);
    if (arr) arr.push(proposal);
    else activeByKey.set(key, [proposal]);
  }

  // All discovered proposals (any status) for the overlap indicator.
  const allDiscovered = source.listActiveProposals(scope, { origin: 'discovered' });
  const discoveredByKey = new Map<string, RelationProposal[]>();
  for (const proposal of allDiscovered) {
    const key = normalizeRelationIdentity({
      sourceSkillId: proposal.sourceSkillId,
      sourceVersion: proposal.sourceVersion,
      targetSkillId: proposal.targetSkillId,
      targetVersion: proposal.targetVersionSnapshot,
      relationType: proposal.relationType,
    });
    const arr = discoveredByKey.get(key);
    if (arr) arr.push(proposal);
    else discoveredByKey.set(key, [proposal]);
  }
  function discoveryOverlap(sourceId: string, targetId: string): DiscoveryOverlap {
    const baseKey = normalizeRelationIdentity({
      sourceSkillId: sourceId,
      sourceVersion: 0,
      targetSkillId: targetId,
      targetVersion: null,
      relationType: 'related_to',
    });
    const reverseKey = normalizeRelationIdentity({
      sourceSkillId: targetId,
      sourceVersion: 0,
      targetSkillId: sourceId,
      targetVersion: null,
      relationType: 'related_to',
    });
    const matches = [...(discoveredByKey.get(baseKey) ?? []), ...(discoveredByKey.get(reverseKey) ?? [])];
    if (matches.length === 0) {
      return { hasActiveOrTerminal: false, hasActiveProposed: false, totalProposals: 0, activeProposalIds: [] };
    }
    const best = matches.reduce((acc, item) => (item.confidence > acc.confidence ? item : acc), matches[0]);
    return {
      hasActiveOrTerminal: true,
      hasActiveProposed: matches.some((item) => item.status === 'proposed'),
      totalProposals: matches.length,
      activeProposalIds: matches.filter((item) => item.status === 'proposed').map((item) => item.id),
      bestDetector: best.detector,
      bestConfidence: best.confidence,
    };
  }
  // (discoveryOverlap is hoisted via function declaration so it is
  // available inside the candidates loop body below.)

  const candidates: ExplicitRelationCandidate[] = [];
  for (const head of heads) {
    const tokens = readRelatedSkills(head);
    for (const token of tokens) {
      if (token === head.logicalKey || token === shortFor(head.logicalKey)) continue;
      const resolved = resolveToken(token, headByLogicalKey, shortToHeads);
      if (resolved.kind === 'zero') {
        candidates.push(buildUnresolved(head, token));
        continue;
      }
      if (resolved.kind === 'multiple') {
        candidates.push(buildAmbiguous(head, token, resolved.matches));
        continue;
      }
      const target = resolved.match;
      // Reverse direction check (only meaningful for symmetric relations).
      const targetTokens = readRelatedSkills(target);
      const reciprocal = targetTokens.includes(head.logicalKey) || targetTokens.includes(shortFor(head.logicalKey));
      const status = classify({
        source: head,
        target,
        relationType: 'related_to',
        canonicalByKey,
        activeByKey,
      });
      candidates.push(buildCandidate(head, target, status, reciprocal, canonicalByKey, activeByKey, discoveryOverlap));
    }
  }

  // Sort: READY first (reciprocal before one-way), then ALREADY_STAGED,
  // ALREADY_CANONICAL, UNRESOLVED, AMBIGUOUS. Within the same status
  // group, sort by (sourceLogicalKey, targetLogicalKey).
  candidates.sort((a, b) => {
    const rankA = statusRank(a.status);
    const rankB = statusRank(b.status);
    if (rankA !== rankB) return rankA - rankB;
    return (
      a.sourceLogicalKey.localeCompare(b.sourceLogicalKey) ||
      (a.targetLogicalKey ?? '').localeCompare(b.targetLogicalKey ?? '')
    );
  });

  const filtered = options.status || options.reciprocal !== undefined || options.skillId
    ? candidates.filter((candidate) => {
        if (options.status && candidate.status !== options.status) return false;
        if (options.reciprocal !== undefined && candidate.reciprocal !== options.reciprocal) return false;
        if (options.skillId && candidate.sourceSkillId !== options.skillId && candidate.targetSkillId !== options.skillId) return false;
        return true;
      })
    : candidates;

  const summary = summarize(candidates);
  const { items, nextCursor } = paginate(filtered, options.limit, options.cursor);
  return { items, summary, nextCursor };
}

function summarize(candidates: ExplicitRelationCandidate[]): ExplicitCandidateSummary {
  const summary: ExplicitCandidateSummary = {
    total: candidates.length,
    ready: 0,
    readyReciprocal: 0,
    readyOneWay: 0,
    alreadyCanonical: 0,
    alreadyStaged: 0,
    unresolved: 0,
    ambiguous: 0,
  };
  for (const c of candidates) {
    if (c.status === 'READY_FOR_REVIEW') {
      summary.ready += 1;
      if (c.reciprocal) summary.readyReciprocal += 1;
      else summary.readyOneWay += 1;
    } else if (c.status === 'ALREADY_CANONICAL') summary.alreadyCanonical += 1;
    else if (c.status === 'ALREADY_STAGED') summary.alreadyStaged += 1;
    else if (c.status === 'UNRESOLVED') summary.unresolved += 1;
    else if (c.status === 'AMBIGUOUS') summary.ambiguous += 1;
  }
  return summary;
}

function statusRank(status: ExplicitCandidateStatus): number {
  switch (status) {
    case 'READY_FOR_REVIEW': return 0;
    case 'ALREADY_STAGED': return 1;
    case 'ALREADY_CANONICAL': return 2;
    case 'UNRESOLVED': return 3;
    case 'AMBIGUOUS': return 4;
  }
}

function shortFor(logicalKey: string): string {
  const idx = logicalKey.lastIndexOf(':');
  return idx >= 0 ? logicalKey.slice(idx + 1) : logicalKey;
}

type Resolution =
  | { kind: 'one'; match: ExplicitSkillHead }
  | { kind: 'zero' }
  | { kind: 'multiple'; matches: ExplicitSkillHead[] };

function resolveToken(
  token: string,
  headByLogicalKey: Map<string, ExplicitSkillHead[]>,
  shortToHeads: Map<string, ExplicitSkillHead[]>,
): Resolution {
  // Exact logical key match.
  const exact = headByLogicalKey.get(token);
  if (exact && exact.length === 1) return { kind: 'one', match: exact[0] };
  if (exact && exact.length > 1) return { kind: 'multiple', matches: exact };

  // Short token (e.g. `pdf`).
  const shortMatches = shortToHeads.get(token);
  if (shortMatches && shortMatches.length === 1) return { kind: 'one', match: shortMatches[0] };
  if (shortMatches && shortMatches.length > 1) return { kind: 'multiple', matches: shortMatches };
  return { kind: 'zero' };
}

type Classification = {
  source: ExplicitSkillHead;
  target: ExplicitSkillHead;
  relationType: SkillRelationType;
  canonicalByKey: Map<string, CanonicalRelationRow>;
  activeByKey: Map<string, RelationProposal[]>;
};

function classify(input: Classification): ExplicitCandidateStatus {
  const { source, target, relationType, canonicalByKey, activeByKey } = input;
  const baseKey = normalizeRelationIdentity({
    sourceSkillId: source.id,
    sourceVersion: source.version,
    targetSkillId: target.id,
    targetVersion: null,
    relationType,
  });
  if (canonicalByKey.has(baseKey)) return 'ALREADY_CANONICAL';
  if (isSymmetricRelationType(relationType)) {
    const reverseKey = normalizeRelationIdentity({
      sourceSkillId: target.id,
      sourceVersion: target.version,
      targetSkillId: source.id,
      targetVersion: null,
      relationType,
    });
    if (canonicalByKey.has(reverseKey)) return 'ALREADY_CANONICAL';
  }
  if (activeByKey.has(baseKey)) return 'ALREADY_STAGED';
  if (isSymmetricRelationType(relationType)) {
    const reverseKey = normalizeRelationIdentity({
      sourceSkillId: target.id,
      sourceVersion: target.version,
      targetSkillId: source.id,
      targetVersion: null,
      relationType,
    });
    if (activeByKey.has(reverseKey)) return 'ALREADY_STAGED';
  }
  return 'READY_FOR_REVIEW';
}

function buildCandidate(
  source: ExplicitSkillHead,
  target: ExplicitSkillHead,
  status: ExplicitCandidateStatus,
  reciprocal: boolean,
  canonicalByKey: Map<string, CanonicalRelationRow>,
  activeByKey: Map<string, RelationProposal[]>,
  discoveryOverlapFn: (sourceId: string, targetId: string) => DiscoveryOverlap,
): ExplicitRelationCandidate {
  const baseKey = normalizeRelationIdentity({
    sourceSkillId: source.id,
    sourceVersion: source.version,
    targetSkillId: target.id,
    targetVersion: null,
    relationType: 'related_to',
  });
  const reverseKey = normalizeRelationIdentity({
    sourceSkillId: target.id,
    sourceVersion: target.version,
    targetSkillId: source.id,
    targetVersion: null,
    relationType: 'related_to',
  });
  const canonical = canonicalByKey.get(baseKey) ?? canonicalByKey.get(reverseKey) ?? null;
  const active = activeByKey.get(baseKey) ?? activeByKey.get(reverseKey) ?? [];
  return {
    pairKey: pairKey(source.id, target.id, 'related_to'),
    sourceSkillId: source.id,
    sourceLogicalKey: source.logicalKey,
    sourceVersion: source.version,
    targetSkillId: target.id,
    targetLogicalKey: target.logicalKey,
    targetVersion: target.version,
    relationType: 'related_to',
    sourceDeclaresTarget: true,
    targetDeclaredSource: reciprocal,
    reciprocal,
    status,
    activeProposalIds: active.map((p) => p.id),
    canonicalRelationId: canonical?.id ?? null,
    evidence: {
      metadataField: 'metadata.hermes.related_skills',
      sourceDeclaredTarget: true,
      targetDeclaredSource: reciprocal,
      reciprocal,
    },
    discoveryOverlap: discoveryOverlapFn(source.id, target.id),
  };
}

function buildUnresolved(source: ExplicitSkillHead, token: string): ExplicitRelationCandidate {
  return {
    pairKey: pairKey(source.id, token, 'related_to'),
    sourceSkillId: source.id,
    sourceLogicalKey: source.logicalKey,
    sourceVersion: source.version,
    targetSkillId: null,
    targetLogicalKey: null,
    targetVersion: null,
    relationType: 'related_to',
    sourceDeclaresTarget: true,
    targetDeclaredSource: false,
    reciprocal: false,
    status: 'UNRESOLVED',
    activeProposalIds: [],
    canonicalRelationId: null,
    evidence: {
      metadataField: 'metadata.hermes.related_skills',
      sourceDeclaredTarget: true,
      targetDeclaredSource: false,
      reciprocal: false,
    },
    unresolvedToken: token,
  };
}

function buildAmbiguous(
  source: ExplicitSkillHead,
  token: string,
  matches: ExplicitSkillHead[],
): ExplicitRelationCandidate {
  return {
    pairKey: pairKey(source.id, token, 'related_to'),
    sourceSkillId: source.id,
    sourceLogicalKey: source.logicalKey,
    sourceVersion: source.version,
    targetSkillId: matches[0]?.id ?? null,
    targetLogicalKey: matches[0]?.logicalKey ?? null,
    targetVersion: matches[0]?.version ?? null,
    relationType: 'related_to',
    sourceDeclaresTarget: true,
    targetDeclaredSource: false,
    reciprocal: false,
    status: 'AMBIGUOUS',
    activeProposalIds: [],
    canonicalRelationId: null,
    evidence: {
      metadataField: 'metadata.hermes.related_skills',
      sourceDeclaredTarget: true,
      targetDeclaredSource: false,
      reciprocal: false,
    },
    unresolvedToken: token,
    ambiguousTargets: matches.map((m) => ({ skillId: m.id, logicalKey: m.logicalKey, version: m.version })),
  };
}

function paginate(items: ExplicitRelationCandidate[], limit: number | undefined, cursor: string | undefined): { items: ExplicitRelationCandidate[]; nextCursor: string | null } {
  if (!limit) return { items, nextCursor: null };
  const startIndex = cursor ? items.findIndex((item) => item.pairKey === cursor) : 0;
  const from = startIndex >= 0 ? startIndex + 1 : 0;
  const slice = items.slice(from, from + limit);
  const nextCursor = from + limit < items.length && slice.length > 0 ? slice[slice.length - 1].pairKey : null;
  return { items: slice, nextCursor };
}

// ---------- Stage pipeline ----------
//
// The stage flow reuses the production RelationProposalRepository: it
// re-reads the candidate immediately before creating the proposal and
// refuses to proceed if the candidate is stale, ambiguous, or already
// canonical. This protects against TOCTOU between the read API and the
// stage action.
import { HubError } from '../errors.js';

export type StageResult = {
  proposal: RelationProposal;
  candidate: ExplicitRelationCandidate;
};

export class ExplicitStageError extends HubError {
  public constructor(code: 'CONFLICT' | 'NOT_FOUND' | 'VALIDATION', message: string, public readonly status: 400 | 404 | 409) {
    super(code, message, status);
  }
}

export function stageExplicitCandidate(
  source: ExplicitRelationSource,
  pairKey: string,
  scope: Scope,
  actorId: string,
  stager: (input: {
    sourceSkillId: string;
    targetSkillId: string;
    relationType: SkillRelationType;
    constraint?: string | null;
    scope: Scope;
    pairKey: string;
    reciprocal: boolean;
    sourceDeclaresTarget: boolean;
    targetDeclaredSource: boolean;
  }, actorId: string) => RelationProposal,
): StageResult {
  const all = listExplicitCandidates(source, scope);
  const candidate = all.items.find((c) => c.pairKey === pairKey);
  if (!candidate) {
    throw new ExplicitStageError('NOT_FOUND', `explicit candidate not found: ${pairKey}`, 404);
  }
  if (candidate.status === 'UNRESOLVED' || candidate.status === 'AMBIGUOUS') {
    throw new ExplicitStageError('CONFLICT', `candidate ${pairKey} is in state ${candidate.status} and cannot be staged`, 409);
  }
  if (candidate.status === 'ALREADY_CANONICAL') {
    throw new ExplicitStageError('CONFLICT', `candidate ${pairKey} is already canonical`, 409);
  }
  if (candidate.targetSkillId === null) {
    throw new ExplicitStageError('CONFLICT', `candidate ${pairKey} has no resolved target`, 409);
  }
  if (candidate.sourceVersion <= 0 || candidate.targetVersion === null) {
    throw new ExplicitStageError('CONFLICT', `candidate ${pairKey} head versions drifted`, 409);
  }
  const proposal = stager({
    sourceSkillId: candidate.sourceSkillId,
    targetSkillId: candidate.targetSkillId,
    relationType: candidate.relationType,
    scope,
    pairKey: candidate.pairKey,
    reciprocal: candidate.reciprocal,
    sourceDeclaresTarget: candidate.sourceDeclaresTarget,
    targetDeclaredSource: candidate.targetDeclaredSource,
  }, actorId);
  return { proposal, candidate };
}

export function stageExplicitCandidates(
  source: ExplicitRelationSource,
  pairKeys: string[],
  scope: Scope,
  actorId: string,
  stager: Parameters<typeof stageExplicitCandidate>[4],
): StageResult[] {
  const out: StageResult[] = [];
  for (const pairKey of pairKeys) {
    out.push(stageExplicitCandidate(source, pairKey, scope, actorId, stager));
  }
  return out;
}

// ---------- Impact preview (read-only) ----------
//
// Given a list of pair keys, project what the canonical graph would
// look like if those candidates were applied. This is a
// graph-structure projection over the existing `skill_relations`
// rows; it never writes to the database.

export type ExplicitImpact = {
  selected: number;
  current: { edges: number; components: number; isolated: number; largest: number };
  afterIfApplied: { edges: number; components: number; isolated: number; largest: number };
  newEdges: number;
};

export function previewExplicitImpact(
  source: ExplicitRelationSource,
  scope: Scope,
  pairKeys: string[],
): ExplicitImpact {
  const canonical = source.listCanonicalRelations(scope);
  const all = listExplicitCandidates(source, scope);
  const items = all.items.filter((c) => pairKeys.includes(c.pairKey) && c.status === 'READY_FOR_REVIEW');
  const newEdgeKeys = new Set<string>();
  for (const item of items) {
    if (!item.targetSkillId) continue;
    const forward = `${item.relationType}@${item.sourceSkillId}->${item.targetSkillId}`;
    const reverse = `${item.relationType}@${item.targetSkillId}->${item.sourceSkillId}`;
    if (!canonical.some((row) => `${row.relationType}@${row.sourceSkillId}->${row.targetSkillId}` === forward || (item.relationType === 'related_to' && `${row.relationType}@${row.sourceSkillId}->${row.targetSkillId}` === reverse))) {
      newEdgeKeys.add(forward);
    }
  }
  const allNodeIds = source.listActiveHeads(scope).map((head) => head.id);
  const current = graphMetrics(canonical, allNodeIds);
  const projected = graphMetrics([
    ...canonical,
    ...Array.from(newEdgeKeys).map((key) => {
      const [relationType, pair] = key.split('@');
      const [sourceSkillId, targetSkillId] = (pair ?? '').split('->');
      const [sourceVersion] = ['1'];
      return { id: `projected:${key}`, sourceSkillId, sourceVersion: Number(sourceVersion), relationType: relationType as SkillRelationType, targetSkillId };
    }),
  ], allNodeIds);
  return {
    selected: pairKeys.length,
    current,
    afterIfApplied: projected,
    newEdges: newEdgeKeys.size,
  };
}

function graphMetrics(rows: Array<{ sourceSkillId: string; targetSkillId: string }>, allNodeIds: string[]): { edges: number; components: number; isolated: number; largest: number } {
  const adj = new Map<string, Set<string>>();
  for (const id of allNodeIds) adj.set(id, new Set());
  for (const row of rows) {
    if (!adj.has(row.sourceSkillId)) adj.set(row.sourceSkillId, new Set());
    if (!adj.has(row.targetSkillId)) adj.set(row.targetSkillId, new Set());
    adj.get(row.sourceSkillId)!.add(row.targetSkillId);
    adj.get(row.targetSkillId)!.add(row.sourceSkillId);
  }
  let components = 0;
  let largest = 0;
  const visited = new Set<string>();
  for (const node of adj.keys()) {
    if (visited.has(node)) continue;
    let size = 0;
    const stack: string[] = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      size += 1;
      for (const next of adj.get(current) ?? []) {
        if (!visited.has(next)) stack.push(next);
      }
    }
    components += 1;
    if (size > largest) largest = size;
  }
  const isolated = [...adj.values()].filter((neighbors) => neighbors.size === 0).length;
  return { edges: rows.length, components, isolated, largest };
}
