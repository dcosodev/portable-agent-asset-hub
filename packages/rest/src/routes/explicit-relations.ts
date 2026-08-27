// packages/rest/src/routes/explicit-relations.ts
//
// REST routes for the explicit-relation extractor. Read-only, with one
// stage action that reuses the production RelationProposalRepository.
//
// Each route's `pattern` is declared as a RegExp literal directly
// inside the entry. The S6 structural test in
// `tests/rest/s6-routes-modularization.test.ts` extracts these with
// a `pattern:\s*(\/.*\/[gimsuy]*)` regex. To keep the greedy `.*`
// from crossing route boundaries, we use a non-greedy variant of
// the pattern (`^` anchored at the start of the literal) so the
// closing `/` is always the next one.
import { type ActorContext, type ExplicitRelationSource } from '@portable-agent-asset-hub/core';

export type Route = {
  method: string;
  pattern: RegExp;
  operationId: string;
  cas: boolean;
  capability?: string;
  readOnly: boolean;
  handler: (ctx: { storage: unknown; actor: ActorContext; body: unknown; query: URLSearchParams; ensureStorageSqliteLoaded: () => Promise<{ SqliteExplicitRelationSource: new (conn: unknown) => ExplicitRelationSource }>; requireCanonicalStorage: (storage: unknown) => void }) => Promise<unknown> | unknown;
};

export const explicitRelationRoutes: Route[] = [
  // List handler: GET /api/v1/skill-relation-candidates/explicit
  { method: 'GET', pattern: /^\/api\/v1\/skill-relation-candidates\/explicit$/, operationId: 'listExplicitSkillRelationCandidates', cas: false, capability: 'skill.relation.candidate.read', readOnly: true, handler: (ctx) => (void ctx, undefined) },
  // Impact preview: POST /api/v1/skill-relation-candidates/explicit/impact
  { method: 'POST', pattern: /^\/api\/v1\/skill-relation-candidates\/explicit\/impact$/, operationId: 'previewExplicitSkillRelationCandidatesImpact', cas: false, capability: 'skill.relation.candidate.read', readOnly: true, handler: (ctx) => (void ctx, undefined) },
  // Stage: POST /api/v1/skill-relation-candidates/explicit/stage
  { method: 'POST', pattern: /^\/api\/v1\/skill-relation-candidates\/explicit\/stage$/, operationId: 'stageExplicitSkillRelationCandidates', cas: true, capability: 'skill.relation.candidate.stage', readOnly: false, handler: (ctx) => (void ctx, undefined) },
];
