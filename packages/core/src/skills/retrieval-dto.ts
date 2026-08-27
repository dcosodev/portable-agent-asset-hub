// packages/core/src/skills/retrieval-dto.ts
//
// Wire-stable DTO types for the retrieval events surfaces
// (`GET /retrieval-events` and `GET /retrieval-events/{id}/graph`).
//
// The storage model persists bodies-free retrieval events in the
// `retrieval_events` SQLite table; this module is a strict projection
// of those columns so the Graph Explorer can render "what happened
// during this retrieval request" and "which skills/memories were
// involved" without ever pulling the raw query string back.
//
// Contract:
//   * `RetrievalEventSummary` mirrors exactly the columns we want to
//     expose: `requestId`, `profile`, `classification`, `policy`,
//     `createdAt`, `noMatch`, counts only. Query sha256 is included
//     for cross-referencing; the raw query (even redacted) is NOT
//     included unless `redactedQuery=true` is opted in.
//   * `RetrievalEventGraphResponse` projects ONLY the persisted JSON
//     columns (`candidates_json`, `selected_skills_json`,
//     `selected_memories_json`, `graph_expansions_json`). Whenever
//     a row is missing any of those fields, the projection falls back
//     to an empty array. Bodies, resource bytes and secrets are never
//     embedded.
//   * Deterministic ordering: nodes sorted by `(skillId, version)` and
//     edges by `(source, type, target, version)`.

import type { GraphRelationEdge, GraphSkillNode, SkillGraphMode } from './graph-dto.js';

export type RetrievalCategory =
  | 'conversational'
  | 'general_knowledge'
  | 'procedural'
  | 'operational'
  | 'configuration'
  | 'deployment'
  | 'debugging'
  | 'migration'
  | 'maintenance'
  | 'personal_context';

export interface RetrievalClassificationDto {
  primary: RetrievalCategory;
  labels: RetrievalCategory[];
}

export interface RetrievalPolicyDecisionDto {
  skillRetrievalRequired: boolean;
  memoryRetrievalRequired: boolean;
}

/** Per-skill selection persisted in `selected_skills_json`. */
export interface RetrievalSkillSelectionDto {
  skillId: string;
  version: number;
  score: number;
  tier: 'canonical' | 'supporting' | 'dependency';
  reason: 'direct_match' | 'dependency';
  parent?: string;
  relation?: string;
  depth: number;
}

/** Per-memory selection persisted in `selected_memories_json`. */
export interface RetrievalMemorySelectionDto {
  memoryId: string;
  version: number;
  kind: string;
  confidence: number;
  importance: number;
}

/** Edge shape between direct matches and graph-derived dependents. */
export interface RetrievalExpansionEdgeDto {
  source: string;
  sourceVersion: number;
  type: 'requires' | 'extends' | 'uses' | 'supersedes' | 'produces' | 'consumes' | 'conflicts_with' | 'related_to';
  target: string;
  targetVersion: number;
  reason: 'direct_match' | 'dependency';
}

/** Per-event summary returned by the list endpoint. */
export interface RetrievalEventSummary {
  /** Stable request id (`req_<uuid>` persisted as `request_id`). */
  requestId: string;
  /** Profile name. */
  profile: string;
  classification: RetrievalClassificationDto;
  policy: RetrievalPolicyDecisionDto;
  createdAt: string;
  noMatch: boolean;
  /** Counts only — never the bodies. */
  counts: {
    candidates: number;
    selectedSkills: number;
    selectedMemories: number;
    graphExpansions: number;
  };
  /** sha256 of the original query, useful for cross-referencing audit logs. */
  querySha256: string;
  /** Optional redacted preview, only present when caller opts in. */
  redactedQuery?: string;
}

/** Graph-shape projection of an event. */
export interface RetrievalEventGraphResponse {
  root: { requestId: string };
  /** Exact persisted skill versions referenced by direct and dependency selections. */
  nodes: GraphSkillNode[];
  /** Closed edge set, never dangling. */
  edges: Array<GraphRelationEdge & { reason: 'direct_match' | 'dependency' }>;
  /** Memories are projected flat, not as nodes (no relationship to the skill graph). */
  memories: RetrievalMemorySelectionDto[];
  metadata: {
    requestId: string;
    actor: { userId: string; agentId: string };
    query: string;
    createdAt: string;
    profile: string;
    classification: RetrievalClassificationDto;
    policy: RetrievalPolicyDecisionDto;
    noMatch: boolean;
    counts: RetrievalEventSummary['counts'];
    generatedAt: string;
    mode: SkillGraphMode;
    includeHistory: boolean;
    scope?: { ownerUserId: string; agentId: string };
  };
}

export const RETRIEVAL_EVENTS_DEFAULT_LIMIT = 50;
export const RETRIEVAL_EVENTS_MAX_LIMIT = 200;
