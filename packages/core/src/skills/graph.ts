import { HubError } from '../errors.js';

export const SKILL_RELATION_TYPES = Object.freeze({
  requires: { directed: true, symmetric: false, transitive: true, dependency: true, acyclic: true, allowSelf: false, allowHead: false },
  uses: { directed: true, symmetric: false, transitive: false, dependency: false, acyclic: false, allowSelf: false, allowHead: true },
  extends: { directed: true, symmetric: false, transitive: true, dependency: true, acyclic: true, allowSelf: false, allowHead: false },
  supersedes: { directed: true, symmetric: false, transitive: true, dependency: false, acyclic: true, allowSelf: false, allowHead: false },
  conflicts_with: { directed: false, symmetric: true, transitive: false, dependency: false, acyclic: false, allowSelf: false, allowHead: true },
  related_to: { directed: false, symmetric: true, transitive: false, dependency: false, acyclic: false, allowSelf: false, allowHead: true },
  produces: { directed: true, symmetric: false, transitive: false, dependency: false, acyclic: false, allowSelf: false, allowHead: true },
  consumes: { directed: true, symmetric: false, transitive: false, dependency: false, acyclic: false, allowSelf: false, allowHead: true },
} as const);

export type SkillRelationType = keyof typeof SKILL_RELATION_TYPES;
export type SkillVersionSelector = { kind: 'head' } | { kind: 'exact'; version: number } | { kind: 'constraint'; expression: string };

export interface SkillRelationInput {
  type: SkillRelationType;
  targetSkillId: string;
  targetVersion?: number;
  targetVersionConstraint?: string;
  /** Import/export provenance; domain resolution still uses targetVersion/constraint. */
  declaredTargetVersionConstraint?: string;
  metadata?: Record<string, unknown>;
}

export interface SkillRelation {
  sourceSkillId: string;
  sourceVersion: number;
  type: SkillRelationType;
  targetSkillId: string;
  targetVersionConstraint: string | null;
  resolvedTargetVersion: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ResolvedSkillNode {
  skillId: string;
  version: number;
  relation: SkillRelationType | 'root';
  parent: { skillId: string; version: number } | null;
  depth: number;
  constraint: string | null;
  resolvedVersion: number;
}

export interface ResolvedSkillGraph {
  root: { skillId: string; version: number };
  resolved: ResolvedSkillNode[];
  limits: { maxDepth: number; maxResolvedSkills: number };
}

export const SKILL_GRAPH_LIMITS = Object.freeze({ maxDepth: 8, maxResolvedSkills: 64, maxRelationsPerVersion: 128 });

function positiveVersion(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new HubError('VALIDATION', `${label} must be a positive integer`, 400);
  return value;
}

export function parseSkillVersionSelector(input: Pick<SkillRelationInput, 'targetVersion' | 'targetVersionConstraint'>): SkillVersionSelector {
  if (input.targetVersion !== undefined && input.targetVersionConstraint !== undefined) {
    throw new HubError('VALIDATION', 'targetVersion and targetVersionConstraint are mutually exclusive', 400);
  }
  if (input.targetVersion !== undefined) return { kind: 'exact', version: positiveVersion(input.targetVersion, 'targetVersion') };
  if (input.targetVersionConstraint === undefined || input.targetVersionConstraint.trim() === '' || input.targetVersionConstraint === 'head') return { kind: 'head' };
  const expression = normalizeSkillVersionConstraint(input.targetVersionConstraint);
  const exact = /^=(\d+)$/u.exec(expression);
  return exact ? { kind: 'exact', version: Number(exact[1]) } : { kind: 'constraint', expression };
}

export function normalizeSkillVersionConstraint(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 128) throw new HubError('VALIDATION', 'target version constraint must be a bounded string', 400);
  const compact = raw.replace(/\s+/gu, '');
  const caret = /^\^(\d+)$/u.exec(compact);
  if (caret) return `>=${positiveVersion(Number(caret[1]), 'constraint version')}`;
  if (/^\d+$/u.test(compact)) return `=${positiveVersion(Number(compact), 'constraint version')}`;
  const clauses = compact.split(',');
  if (clauses.length < 1 || clauses.length > 4) throw new HubError('VALIDATION', 'invalid target version constraint', 400);
  for (const clause of clauses) {
    const match = /^(=|>=|<=|>|<)(\d+)$/u.exec(clause);
    if (!match) throw new HubError('VALIDATION', 'invalid target version constraint', 400);
    positiveVersion(Number(match[2]), 'constraint version');
  }
  return clauses.join(',');
}

export function versionSatisfies(version: number, expression: string): boolean {
  positiveVersion(version, 'version');
  const normalized = normalizeSkillVersionConstraint(expression);
  return normalized.split(',').every((clause) => {
    const match = /^(=|>=|<=|>|<)(\d+)$/u.exec(clause)!;
    const expected = Number(match[2]);
    if (match[1] === '=') return version === expected;
    if (match[1] === '>=') return version >= expected;
    if (match[1] === '<=') return version <= expected;
    if (match[1] === '>') return version > expected;
    return version < expected;
  });
}

export function validateRelationInput(input: SkillRelationInput, sourceSkillId: string): SkillRelationInput {
  if (!input || typeof input !== 'object') throw new HubError('VALIDATION', 'relation must be an object', 400);
  const semantics = SKILL_RELATION_TYPES[input.type];
  if (!semantics) throw new HubError('VALIDATION', 'unsupported relation type', 400);
  if (typeof input.targetSkillId !== 'string' || input.targetSkillId.length < 1 || input.targetSkillId.length > 128) {
    throw new HubError('VALIDATION', 'targetSkillId must be 1..128 characters', 400);
  }
  if (!semantics.allowSelf && input.targetSkillId === sourceSkillId) throw new HubError('VALIDATION', `self relation is not allowed for ${input.type}`, 400);
  const selector = parseSkillVersionSelector(input);
  if (input.declaredTargetVersionConstraint !== undefined && input.declaredTargetVersionConstraint !== 'head') {
    normalizeSkillVersionConstraint(input.declaredTargetVersionConstraint);
  }
  if (selector.kind === 'head' && !semantics.allowHead) throw new HubError('VALIDATION', `${input.type} requires an exact version or integer version constraint`, 400);
  let metadata: Record<string, unknown> = {};
  if (input.metadata !== undefined) {
    if (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) throw new HubError('VALIDATION', 'relation metadata must be an object', 400);
    metadata = input.metadata;
  }
  let encoded: string;
  try { encoded = JSON.stringify(metadata); } catch { throw new HubError('VALIDATION', 'relation metadata must be JSON serializable', 400); }
  if (encoded === undefined) throw new HubError('VALIDATION', 'relation metadata must be JSON serializable', 400);
  if (Buffer.byteLength(encoded, 'utf8') > 4096) throw new HubError('VALIDATION', 'relation metadata exceeds 4096 bytes', 413);
  return { ...input, metadata };
}
