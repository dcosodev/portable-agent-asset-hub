// packages/core/src/skills/graph-service.ts
//
// Pure transformation layer that turns persisted skill/relation rows
// into the wire-stable graph DTOs. The storage layer provides:
//
//   * `getHeadVersion(id, scope)`     — single node materialization
//   * `getRelations(id, version?, scope)`     — adjacency per skill
//   * `getDependents(id, scope)`      — reverse adjacency
//   * `resolveGraph(id, version?, scope, limits)` — BFS for skills
//
// This module:
//   1. Traverses the adjacency once per call (BFS) bounded by
//      `maxDepth`, `maxNodes`, `maxEdges`.
//   2. Sorts nodes/edges deterministically so the Graph Explorer can
//      diff successive responses.
//   3. Projects only columns that pass the scope + lifecycle guards
//      upstream (storage filters cross-scope rows).
//   4. Optionally stamps `history` per node from `getHeadVersion` if
//      the caller wants historic versions.
//
// The service is authorization-agnostic: callers enforce
// `capabilities.includes('skill.read')` at their boundary (the REST
// routes, MCP, etc.). The service itself trusts that storage already
// scoped the rows. Anything past that boundary is the route's job.

import { HubError } from '../errors.js';
import type { Scope } from '../identity/types.js';
import { SKILL_RELATION_TYPES, type SkillRelationType } from './graph.js';
import {
  DEFAULT_SKILL_GRAPH_MODE,
  SKILL_GRAPH_ABSOLUTE_MAX_DEPTH,
  SKILL_GRAPH_ABSOLUTE_MAX_EDGES,
  SKILL_GRAPH_ABSOLUTE_MAX_NODES,
  SKILL_GRAPH_DEFAULT_MAX_DEPTH,
  SKILL_GRAPH_DEFAULT_MAX_EDGES,
  SKILL_GRAPH_DEFAULT_MAX_NODES,
  SKILL_GRAPH_VERSION_MODES,
  type GlobalSkillGraph,
  type GraphMetadata,
  type GraphRelationEdge,
  type GraphSkillNode,
  type SkillGraphMode,
  type SkillGraphResponse,
  type SkillGraphVersionMode,
  type SkillImpactResponse,
} from './graph-dto.js';

export interface GraphNodeMaterialization {
  id: string;
  scope: Scope;
  logicalKey: string;
  kind: 'skill' | 'tool';
  name: string;
  summary?: string;
  lifecycle: 'candidate' | 'active' | 'stale' | 'rejected';
  version: number;
  bodySha256: string;
  totalSize: number;
  resources: Array<{ relativePath: string; mode: 0o644 | 0o755; mime: string; size: number; sha256: string }>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GraphRelationRow {
  sourceSkillId: string;
  sourceVersion: number;
  type: SkillRelationType;
  targetSkillId: string;
  targetVersionConstraint: string | null;
  resolvedTargetVersion: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface GraphSkillServiceDeps {
  /**
   * Materialize a single HEAD node, including its resource metadata.
   * Returns `undefined` for cross-scope or unknown ids. Storage must
   * already have scope-filtered the row.
   */
  fetchHead: (id: string, scope: Scope) => GraphNodeMaterialization | undefined;
  /**
   * Fetch direct outgoing relations for a `(skillId, version)` pair.
   * Storage must scope + lifecycle-filter the rows. Returning fewer
   * rows than maxEdges is allowed; ordering is enforced by us.
   */
  fetchRelations: (id: string, version: number, scope: Scope) => GraphRelationRow[];
  /**
   * Fetch direct incoming relations pointing at `(skillId)`.
   * Joins against `skill_entries.current_version = source_version`
   * so the row points to an active HEAD. Storage must scope the rows.
   */
  fetchDependents: (id: string, scope: Scope) => GraphRelationRow[];
  /**
   * Optional: list every active HEAD for a scope, ordered by
   * `(logicalKey, id)`. Used by the global graph endpoint to keep
   * one bounded query per call.
   */
  listActiveHeads?: (scope: Scope) => GraphNodeMaterialization[];
  /**
   * Optional: list every persisted relation row (immutable PK) scoped
   * to the actor's scope. Used only by the global graph endpoint.
   */
  listAllRelations?: (scope: Scope, includeHistory?: boolean) => GraphRelationRow[];
  /** Optional aggregated read used by global history mode. */
  listAllVersions?: (scope: Scope) => GraphNodeMaterialization[];
  /**
   * Optional: list historical versions of a skill (active rows only).
   * Used when the caller opts into `versions=history`. Stable numeric
   * versions in ascending order; bodies NEVER returned.
   */
  listHistory?: (id: string, scope: Scope) => number[];
}

export interface GraphLimits {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
}

export const GRAPH_LIMITS_DEFAULT: GraphLimits = Object.freeze({
  maxDepth: SKILL_GRAPH_DEFAULT_MAX_DEPTH,
  maxNodes: SKILL_GRAPH_DEFAULT_MAX_NODES,
  maxEdges: SKILL_GRAPH_DEFAULT_MAX_EDGES,
}) as GraphLimits;

export interface CenteredGraphOptions {
  mode?: SkillGraphMode;
  limits?: Partial<GraphLimits>;
  includeHistory?: boolean;
  /** Generated-at timestamp; tests pass a fixed value. */
  generatedAt?: string;
}

export interface ImpactOptions {
  limits?: Partial<GraphLimits>;
  includeHistory?: boolean;
  generatedAt?: string;
}

export interface GlobalGraphOptions {
  limits?: Partial<GraphLimits>;
  includeHistory?: boolean;
  generatedAt?: string;
}

const isoNow = (): string => new Date().toISOString();

function clampLimit(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HubError('VALIDATION', `${label} must be an integer in ${min}..${max}`, 400);
  }
  return value;
}

export function normalizeGraphLimits(raw: Partial<GraphLimits> | undefined): GraphLimits {
  return {
    maxDepth: clampLimit(raw?.maxDepth, GRAPH_LIMITS_DEFAULT.maxDepth, 1, SKILL_GRAPH_ABSOLUTE_MAX_DEPTH, 'limits.maxDepth'),
    maxNodes: clampLimit(raw?.maxNodes, GRAPH_LIMITS_DEFAULT.maxNodes, 1, SKILL_GRAPH_ABSOLUTE_MAX_NODES, 'limits.maxNodes'),
    maxEdges: clampLimit(raw?.maxEdges, GRAPH_LIMITS_DEFAULT.maxEdges, 1, SKILL_GRAPH_ABSOLUTE_MAX_EDGES, 'limits.maxEdges'),
  };
}

export function normalizeGraphMode(raw: string | undefined, fallback: SkillGraphMode = 'dependencies'): SkillGraphMode {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'dependencies' || normalized === 'dependents' || normalized === 'both') {
    return normalized;
  }
  throw new HubError('VALIDATION', 'mode must be one of dependencies|dependents|both', 400);
}

export function normalizeGraphVersionMode(raw: string | undefined): SkillGraphVersionMode {
  if (raw === undefined) return 'heads';
  const normalized = raw.trim().toLowerCase();
  if ((SKILL_GRAPH_VERSION_MODES as readonly string[]).includes(normalized)) {
    return normalized as SkillGraphVersionMode;
  }
  throw new HubError('VALIDATION', 'versions must be one of heads|history', 400);
}

function projectNode(material: GraphNodeMaterialization, history: number[] | undefined, nodeId = material.id): GraphSkillNode {
  const base: GraphSkillNode = {
    id: nodeId,
    skillId: material.id,
    version: material.version,
    name: material.name,
    kind: material.kind,
    logicalKey: material.logicalKey,
    lifecycle: material.lifecycle,
    totalSize: material.totalSize,
    resources: material.resources.map((resource) => ({
      relativePath: resource.relativePath,
      mode: resource.mode,
      mime: resource.mime,
      size: resource.size,
      sha256: resource.sha256,
    })),
    bodySha256: material.bodySha256,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
    metadata: material.metadata,
    owner: typeof material.metadata.owner === 'string' ? material.metadata.owner : material.scope.ownerUserId,
    scope: material.scope,
  };
  if (material.summary !== undefined) (base as { summary?: string }).summary = material.summary;
  if (history !== undefined) base.history = [...history].sort((a, b) => a - b);
  return base;
}

/**
 * Project a relation row to a wire edge. Requires source/target nodes
 * to be present in the visited set so the edge never dangles.
 */
function projectEdge(
  relation: GraphRelationRow,
  direction: GraphRelationEdge['direction'],
  source = relation.sourceSkillId,
  target = relation.targetSkillId,
): GraphRelationEdge {
  return {
    source,
    sourceVersion: relation.sourceVersion,
    type: relation.type,
    target,
    targetVersion: relation.resolvedTargetVersion,
    constraint: relation.targetVersionConstraint,
    direction,
  };
}

function stableNodeSort(a: GraphSkillNode, b: GraphSkillNode): number {
  return a.id.localeCompare(b.id) || a.version - b.version;
}

function stableEdgeSort(a: GraphRelationEdge, b: GraphRelationEdge): number {
  return (
    a.source.localeCompare(b.source) ||
    a.type.localeCompare(b.type) ||
    a.target.localeCompare(b.target) ||
    a.targetVersion - b.targetVersion
  );
}

interface CenteredContext {
  visited: Map<string, GraphNodeMaterialization>;
  truncatedNodes: number;
  truncatedEdges: number;
  edges: GraphRelationEdge[];
  edgesRaw: GraphRelationRow[];
  limitHit: boolean;
  rootMode: SkillGraphMode;
  limits: GraphLimits;
}

function pushNode(ctx: CenteredContext, material: GraphNodeMaterialization): void {
  if (ctx.visited.has(material.id)) return;
  if (ctx.visited.size >= ctx.limits.maxNodes) {
    ctx.truncatedNodes += 1;
    ctx.limitHit = true;
    return;
  }
  ctx.visited.set(material.id, material);
}

function pushEdge(ctx: CenteredContext, row: GraphRelationRow, direction: GraphRelationEdge['direction']): void {
  const duplicate = ctx.edgesRaw.some((current) =>
    current.sourceSkillId === row.sourceSkillId && current.sourceVersion === row.sourceVersion &&
    current.type === row.type && current.targetSkillId === row.targetSkillId &&
    current.resolvedTargetVersion === row.resolvedTargetVersion,
  );
  if (duplicate) return;
  if (ctx.edgesRaw.length >= ctx.limits.maxEdges) {
    ctx.truncatedEdges += 1;
    ctx.limitHit = true;
    return;
  }
  ctx.edgesRaw.push(row);
  ctx.edges.push(projectEdge(row, direction));
}

/**
 * Skill-centered BFS over the active HEAD graph. Strictly respects
 * the actor's scope because every materialization call goes through
 * `fetchHead`, which is the storage layer's scope boundary.
 */
export function buildCenteredSkillGraph(
  deps: GraphSkillServiceDeps,
  rootId: string,
  scope: Scope,
  options: CenteredGraphOptions = {},
): SkillGraphResponse {
  if (typeof rootId !== 'string' || rootId.length === 0) {
    throw new HubError('VALIDATION', 'root id must be a non-empty string', 400);
  }
  const mode = normalizeGraphMode(options.mode, 'dependencies' as typeof DEFAULT_SKILL_GRAPH_MODE);
  const limits = normalizeGraphLimits(options.limits);
  const includeHistory = options.includeHistory === true;

  const rootMaterial = deps.fetchHead(rootId, scope);
  if (!rootMaterial) throw notFound();
  if (rootMaterial.lifecycle !== 'active') throw notFound();

  const generatedAt = options.generatedAt ?? isoNow();
  const ctx: CenteredContext = {
    visited: new Map<string, GraphNodeMaterialization>(),
    truncatedNodes: 0,
    truncatedEdges: 0,
    edges: [],
    edgesRaw: [],
    limitHit: false,
    rootMode: mode,
    limits,
  };

  pushNode(ctx, rootMaterial);

  type QueueItem = { id: string; version: number; depth: number };
  const queue: QueueItem[] = [{ id: rootId, version: rootMaterial.version, depth: 0 }];
  const queued = new Set<string>([rootId]);

  while (queue.length > 0 && !ctx.limitHit) {
    const head = queue.shift()!;
    if (head.depth >= limits.maxDepth) continue;

    if (mode === 'dependencies' || mode === 'both') {
      const out = deps
        .fetchRelations(head.id, head.version, scope)
        .slice()
        .sort((a, b) => a.type.localeCompare(b.type) || a.targetSkillId.localeCompare(b.targetSkillId) || a.resolvedTargetVersion - b.resolvedTargetVersion);
      for (const relation of out) {
        if (ctx.limitHit) break;
        const target = deps.fetchHead(relation.targetSkillId, scope);
        if (!target || target.lifecycle !== 'active') {
          if (!target) ctx.truncatedNodes += 1;
          continue;
        }
        if (!ctx.visited.has(target.id) && ctx.visited.size >= limits.maxNodes) {
          ctx.truncatedNodes += 1;
          ctx.limitHit = true;
          break;
        }
        ctx.visited.set(target.id, target);
        pushEdge(ctx, relation, mode === 'both' ? 'bidirectional' : 'dependencies');
        if (ctx.limitHit) break;
        if (SKILL_RELATION_TYPES[relation.type].transitive && !queued.has(target.id)) {
          queued.add(target.id);
          queue.push({ id: target.id, version: target.version, depth: head.depth + 1 });
        }
      }
    }
    if ((mode === 'dependents' || mode === 'both') && !ctx.limitHit) {
      const inbound = deps
        .fetchDependents(head.id, scope)
        .slice()
        .sort((a, b) => a.type.localeCompare(b.type) || a.sourceSkillId.localeCompare(b.sourceSkillId) || a.sourceVersion - b.sourceVersion);
      for (const relation of inbound) {
        if (ctx.limitHit) break;
        const target = deps.fetchHead(relation.sourceSkillId, scope);
        if (!target || target.lifecycle !== 'active') {
          if (!target) ctx.truncatedNodes += 1;
          continue;
        }
        if (!ctx.visited.has(target.id) && ctx.visited.size >= limits.maxNodes) {
          ctx.truncatedNodes += 1;
          ctx.limitHit = true;
          break;
        }
        ctx.visited.set(target.id, target);
        pushEdge(ctx, relation, mode === 'both' ? 'bidirectional' : 'dependents');
        if (ctx.limitHit) break;
        if (SKILL_RELATION_TYPES[relation.type].transitive && !queued.has(target.id)) {
          queued.add(target.id);
          queue.push({ id: target.id, version: target.version, depth: head.depth + 1 });
        }
      }
    }
  }

  const nodes: GraphSkillNode[] = [];
  for (const material of ctx.visited.values()) {
    const history = includeHistory && deps.listHistory ? deps.listHistory(material.id, scope) : undefined;
    nodes.push(projectNode(material, history));
  }
  nodes.sort(stableNodeSort);
  ctx.edges.sort(stableEdgeSort);

  const metadata: GraphMetadata = {
    nodes: nodes.length,
    edges: ctx.edges.length,
    truncatedNodes: ctx.truncatedNodes,
    truncatedEdges: ctx.truncatedEdges,
    limits,
    truncated: ctx.limitHit || ctx.truncatedEdges > 0 || ctx.truncatedNodes > 0,
    generatedAt,
    includeHistory,
    scope: { ownerUserId: scope.ownerUserId, agentId: scope.agentId },
  };

  return {
    root: { id: rootId, version: rootMaterial.version },
    nodes,
    edges: ctx.edges,
    metadata,
  };
}

/**
 * Skill-impact BFS — transitive DEPENDENTS only, with explicit
 * impactedCount distinct from `nodes.length` (root counts as one).
 * Same scoping/lifecycle rules as the centered graph.
 */
export function buildSkillImpact(
  deps: GraphSkillServiceDeps,
  rootId: string,
  scope: Scope,
  options: ImpactOptions = {},
): SkillImpactResponse {
  if (typeof rootId !== 'string' || rootId.length === 0) {
    throw new HubError('VALIDATION', 'root id must be a non-empty string', 400);
  }
  const limits = normalizeGraphLimits(options.limits);
  const includeHistory = options.includeHistory === true;

  const rootMaterial = deps.fetchHead(rootId, scope);
  if (!rootMaterial) throw notFound();
  if (rootMaterial.lifecycle !== 'active') throw notFound();

  const generatedAt = options.generatedAt ?? isoNow();
  const ctx: CenteredContext = {
    visited: new Map<string, GraphNodeMaterialization>(),
    truncatedNodes: 0,
    truncatedEdges: 0,
    edges: [],
    edgesRaw: [],
    limitHit: false,
    rootMode: 'dependents',
    limits,
  };

  ctx.visited.set(rootMaterial.id, rootMaterial);

  type QueueItem = { id: string; depth: number };
  const queue: QueueItem[] = [{ id: rootId, depth: 0 }];
  const queued = new Set<string>([rootId]);

  while (queue.length > 0 && !ctx.limitHit) {
    const head = queue.shift()!;
    if (head.depth >= limits.maxDepth) continue;
    const inbound = deps
      .fetchDependents(head.id, scope)
      .slice()
      .sort((a, b) => a.type.localeCompare(b.type) || a.sourceSkillId.localeCompare(b.sourceSkillId) || a.sourceVersion - b.sourceVersion);
    for (const relation of inbound) {
      if (ctx.limitHit) break;
      const target = deps.fetchHead(relation.sourceSkillId, scope);
      if (!target || target.lifecycle !== 'active') {
        if (!target) ctx.truncatedNodes += 1;
        continue;
      }
      if (!ctx.visited.has(target.id) && ctx.visited.size >= limits.maxNodes) {
        ctx.truncatedNodes += 1;
        ctx.limitHit = true;
        break;
      }
      ctx.visited.set(target.id, target);
      pushEdge(ctx, relation, 'dependents');
      if (ctx.limitHit) break;
      if (SKILL_RELATION_TYPES[relation.type].transitive && !queued.has(target.id)) {
        queued.add(target.id);
        queue.push({ id: target.id, depth: head.depth + 1 });
      }
    }
  }

  const nodes: GraphSkillNode[] = [];
  for (const material of ctx.visited.values()) {
    const history = includeHistory && deps.listHistory ? deps.listHistory(material.id, scope) : undefined;
    nodes.push(projectNode(material, history));
  }
  nodes.sort(stableNodeSort);
  ctx.edges.sort(stableEdgeSort);

  const impactedCount = nodes.length - 1; // subtract the root

  const metadata: GraphMetadata & { mode: 'dependents'; impactedCount: number } = {
    nodes: nodes.length,
    edges: ctx.edges.length,
    truncatedNodes: ctx.truncatedNodes,
    truncatedEdges: ctx.truncatedEdges,
    limits,
    truncated: ctx.limitHit || ctx.truncatedEdges > 0 || ctx.truncatedNodes > 0,
    generatedAt,
    includeHistory,
    scope: { ownerUserId: scope.ownerUserId, agentId: scope.agentId },
    mode: 'dependents',
    impactedCount: impactedCount < 0 ? 0 : impactedCount,
  };

  return {
    root: { id: rootId, version: rootMaterial.version },
    nodes,
    edges: ctx.edges,
    metadata,
  };
}

/**
 * Global HEAD graph. Single bounded traversal: every active HEAD
 * becomes a node and every relation row bounded by limits becomes an
 * edge. Strict scope enforcement via `listActiveHeads` /
 * `listAllRelations`, which the storage layer must filter.
 */
export function buildGlobalSkillGraph(
  deps: GraphSkillServiceDeps,
  scope: Scope,
  options: GlobalGraphOptions = {},
): GlobalSkillGraph {
  const limits = normalizeGraphLimits(options.limits);
  const includeHistory = options.includeHistory === true;
  const listHeads = deps.listActiveHeads;
  const listRels = deps.listAllRelations;
  if (typeof listHeads !== 'function' || typeof listRels !== 'function') {
    throw new HubError('INTERNAL', 'global graph requires listActiveHeads + listAllRelations', 500);
  }
  const generatedAt = options.generatedAt ?? isoNow();

  const allHeads = listHeads(scope);
  const allMaterials = includeHistory && deps.listAllVersions
    ? deps.listAllVersions(scope)
    : allHeads;
  const materials = allMaterials.slice(0, limits.maxNodes);
  const headVersionBySkill = new Map(allHeads.map((material) => [material.id, material.version]));
  const historyBySkill = new Map<string, number[]>();
  for (const material of allMaterials) {
    const versions = historyBySkill.get(material.id) ?? [];
    versions.push(material.version);
    historyBySkill.set(material.id, versions);
  }
  const nodeId = (skillId: string, version: number): string => includeHistory ? `${skillId}@${version}` : skillId;
  const selectedNodeIds = new Set(materials.map((material) => nodeId(material.id, material.version)));
  const allNodeIds = new Set(allMaterials.map((material) => nodeId(material.id, material.version)));

  const nodes = materials.map((material) => projectNode(
    material,
    includeHistory ? historyBySkill.get(material.id) : undefined,
    nodeId(material.id, material.version),
  ));
  nodes.sort(stableNodeSort);

  const allRelations = listRels(scope, includeHistory);
  const endpoints = (relation: GraphRelationRow): [string, string] => [
    nodeId(relation.sourceSkillId, relation.sourceVersion),
    nodeId(
      relation.targetSkillId,
      includeHistory
        ? relation.resolvedTargetVersion
        : (headVersionBySkill.get(relation.targetSkillId) ?? relation.resolvedTargetVersion),
    ),
  ];
  const eligibleRelations = allRelations.filter((relation) => {
    const [source, target] = endpoints(relation);
    return allNodeIds.has(source) && allNodeIds.has(target);
  });
  const relations = eligibleRelations.filter((relation) => {
    const [source, target] = endpoints(relation);
    return selectedNodeIds.has(source) && selectedNodeIds.has(target);
  }).slice(0, limits.maxEdges);
  const edges = relations.map((relation) => {
    const [source, target] = endpoints(relation);
    return projectEdge(relation, 'bidirectional', source, target);
  });
  edges.sort(stableEdgeSort);

  const metadata: GraphMetadata = {
    nodes: nodes.length,
    edges: edges.length,
    truncatedNodes: Math.max(0, allMaterials.length - materials.length),
    truncatedEdges: Math.max(0, eligibleRelations.length - relations.length),
    limits,
    truncated: materials.length < allMaterials.length || relations.length < eligibleRelations.length,
    generatedAt,
    includeHistory,
    scope: { ownerUserId: scope.ownerUserId, agentId: scope.agentId },
  };

  return {
    root: undefined,
    nodes,
    edges,
    metadata,
    mode: 'all',
  };
}

function notFound(): HubError {
  return new HubError('NOT_FOUND', 'skill not found', 404);
}
