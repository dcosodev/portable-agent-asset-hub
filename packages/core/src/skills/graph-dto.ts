// packages/core/src/skills/graph-dto.ts
//
// Wire-stable DTO types for the Web Graph Explorer backend.
//
// The DTO layer is intentionally separated from the SQLite storage
// model (graph.ts) so that:
//
//   * the storage layer keeps its internal `(sourceSkillId, targetSkillId)`
//     adjacency list and acyclic guards, while
//   * the Graph Explorer receives an ordered, JSON-friendly,
//     scope-checked, body-free projection (no bodies, no resource bytes,
//     no secret metadata). This is the contract the REST routes return.
//
// Rules enforced here:
//
//   * Nodes belong to the actor's scope. Cross-scope ids surface as
//     NOT_FOUND at the storage boundary, so they never reach this
//     layer.
//   * Edges reference only ids present in `nodes` (closed world) so a
//     graph cannot leak dangling edges.
//   * `metadata.counts` is the only numeric metadata the frontend
//     consumes — no per-node version history leak unless the caller
//     toggles `versions=history`.
//   * `truncated: true` is set when `limits` caused the BFS to stop
//     before saturation. The frontend uses it to render the "show
//     more" affordance.
//   * Deterministic ordering: nodes sorted by `(id, version)`
//     lex order; edges by `(source, type, target, version)`.
//
// Versioning policy:
//   * Default (and toggle value `versions=heads`): every node has a
//     single `{ version }` field equal to the skill's HEAD.
//   * Toggle value `versions=history`: the global graph emits one
//     version-qualified node per persisted version; centered graphs keep
//     HEAD topology and add a `history: number[]` summary. Bodies are NEVER
//     included in either mode — body bytes must come through `/skills/{id}`.

import type { SkillRelationType } from './graph.js';

/** Stable node shape returned by every graph endpoint. */
export interface GraphSkillNode {
  /** Stable skill id (matches `SkillVersion.id`). */
  id: string;
  /** Canonical skill id; `id` is version-qualified in history mode. */
  skillId: string;
  /** HEAD version surfaced by the resolver. */
  version: number;
  /** Human-readable display name; mirrors `SkillVersion.name`. */
  name: string;
  /** `skill` or `tool`; mirrors `SkillVersion.kind`. */
  kind: 'skill' | 'tool';
  /** Logical key used for catalog routing. */
  logicalKey: string;
  /** Active lifecycle state. Stale / rejected rows are filtered upstream. */
  lifecycle: 'candidate' | 'active' | 'stale' | 'rejected';
  /** Active total size of body+resources; bounded check stops here. */
  totalSize: number;
  /** Sorted list of resource metadata, paths only. */
  resources: Array<{ relativePath: string; mode: 0o644 | 0o755; mime: string; size: number; sha256: string }>;
  /** Body sha256 hex; supplied for graph diff/audit but never the bytes. */
  bodySha256: string;
  /** Optional timestamps (RFC 3339 ISO 8601). */
  createdAt?: string;
  updatedAt?: string;
  /** Optional metadata payload; opaque JSON. */
  metadata?: Record<string, unknown>;
  /** Effective visible owner/scope; always the already-authorized actor scope. */
  owner?: string;
  scope?: { ownerUserId: string; agentId: string };
  /** Past versions — only populated when `versions=history` is requested. */
  history?: number[];
  /** Present only in Retrieval Explorer projections. */
  selection?: { reason: 'direct_match' | 'dependency' | 'supporting'; score?: number; tier?: string; depth?: number };
}

/** Edge between two skill heads. */
export interface GraphRelationEdge {
  /** Source skill id (must match a node in `nodes`). */
  source: string;
  /** HEAD version of the source at the moment of resolution. */
  sourceVersion: number;
  /** Relation type discriminator. */
  type: SkillRelationType;
  /** Target skill id (must match a node in `nodes`). */
  target: string;
  /** Resolved target version snapshotted on the relation row. */
  targetVersion: number;
  /** Original constraint string, if declared. May be null for `head` selections. */
  constraint: string | null;
  /** Direction convention: `dependencies` means source->target reads as "depends on". */
  direction: 'dependencies' | 'dependents' | 'bidirectional';
}

/** Counts supplied to the frontend (cheap, summary only). */
export interface GraphMetadata {
  /** Number of nodes in the response. */
  nodes: number;
  /** Number of edges in the response. */
  edges: number;
  /** Number of nodes the traversal was unable to include due to limits. */
  truncatedNodes: number;
  /** Number of edges the traversal was unable to include due to limits. */
  truncatedEdges: number;
  /** Hard caps applied. */
  limits: { maxDepth: number; maxNodes: number; maxEdges: number };
  /** Whether the result was capped. */
  truncated: boolean;
  /** When the graph was materialized. */
  generatedAt: string;
  /** Whether the response included historical versions. */
  includeHistory: boolean;
  /** Optional scope echo for debugging; never carries credentials. */
  scope?: { ownerUserId: string; agentId: string };
}

/** Generic payload for any graph response. */
export interface SkillGraphResponse {
  /** Origin node id; absent for the global HEAD graph. */
  root?: { id: string; version: number };
  /** Bounded list of skill nodes. */
  nodes: GraphSkillNode[];
  /** Bounded list of relations between nodes. */
  edges: GraphRelationEdge[];
  /** Counts and limits exposed to the frontend. */
  metadata: GraphMetadata;
}

/** Dedicated shape for the global HEAD graph so the route is self-describing. */
export interface GlobalSkillGraph extends SkillGraphResponse {
  /** Always `false` for the global graph; the global endpoint never has a root. */
  root?: undefined;
  /** `mode` echoed back so the frontend can persist its UI state. */
  mode: 'all';
}

/** Skill-centered graph modes accepted by `GET /skills/{id}/graph`. */
export type SkillGraphMode = 'dependencies' | 'dependents' | 'both';

/** Response of the dedicated impact endpoint (transitive dependents only). */
export interface SkillImpactResponse {
  root: { id: string; version: number };
  nodes: GraphSkillNode[];
  edges: GraphRelationEdge[];
  metadata: GraphMetadata & { mode: 'dependents'; impactedCount: number };
}

/** Mode the impact route uses; declared as an exported constant for the tests. */
export const SKILL_GRAPH_DEFAULT_MAX_DEPTH = 4;
export const SKILL_GRAPH_DEFAULT_MAX_NODES = 200;
export const SKILL_GRAPH_DEFAULT_MAX_EDGES = 1000;
export const SKILL_GRAPH_ABSOLUTE_MAX_DEPTH = 32;
export const SKILL_GRAPH_ABSOLUTE_MAX_NODES = 4096;
export const SKILL_GRAPH_ABSOLUTE_MAX_EDGES = 16384;

/** Versions-toggle values accepted by the centered graph route. */
export const SKILL_GRAPH_VERSION_MODES = ['heads', 'history'] as const;
export type SkillGraphVersionMode = (typeof SKILL_GRAPH_VERSION_MODES)[number];

/** Per-skill metadata returned by the global graph endpoint. Optional summary. */
export interface GlobalSkillGraphEntry {
  id: string;
  version: number;
  logicalKey: string;
  name: string;
  lifecycle: GraphSkillNode['lifecycle'];
  totalSize: number;
  outgoingRelations: number;
  incomingRelations: number;
}

/** Default mode when `?mode=` is omitted on the centered route. */
export const DEFAULT_SKILL_GRAPH_MODE: SkillGraphMode = 'dependencies';

/** Allowed impact extension; mirrors `SKILL_GRAPH_VERSION_MODES`. */
export const SKILL_IMPACT_DEFAULT_MAX_DEPTH = 8;
export const SKILL_IMPACT_DEFAULT_MAX_NODES = 256;
export const SKILL_IMPACT_DEFAULT_MAX_EDGES = 1024;
