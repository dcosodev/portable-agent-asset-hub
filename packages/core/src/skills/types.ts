// packages/core/src/skills/types.ts
//
// Phase 1 contract surface for the versioned skill storage layer.
// Skills are immutable per write: a `writeSkill()` call always produces
// a new row in `skill_versions` keyed by `(id, version)` plus the
// monotonically increasing `skill_active_head.current_version` for
// that `(logical_key)` pair. Bodies and resource bytes are stored
// inline (SQLite is the authority) — there is no separate blob store
// in Phase 1.
//
// Lifecycle / scope are inherited from the catalog schema:
//   * `lifecycle` ∈ { 'candidate', 'active', 'stale', 'rejected' }
//     but `skillSearch` only ever returns `active` rows.
//   * `scope` is a `(ownerUserId, agentId)` pair and is enforced by
//     every read and write — cross-scope reads surface as NOT_FOUND.
//
// Constraints enforced by the repository (not by the type system
// because they depend on runtime byte values):
//   * body:        ≤ 1 MiB, valid UTF-8.
//   * resource:    ≤ 4 MiB.
//   * resources:   total ≤ 16 MiB per version.
//   * path:        ≤ 512 chars, no traversal, no absolute, no
//                  backslash, no NUL, no control chars, no empty.
//   * mode:        0o644 or 0o755.
//   * mime:        ≤ 128 chars, printable ASCII or RFC-6838 subset.
//
// The repository never logs resource bytes or body bytes; only size
// and digest are echoed.

import type { Scope } from '../identity/types.js';
import type { ResolvedSkillGraph, SkillRelation, SkillRelationInput } from './graph.js';
import type { RetrievalClassification, RetrievalLimits, RetrievalPolicyDecision } from './retrieval.js';
import type { GlobalSkillGraph, SkillGraphResponse, SkillImpactResponse } from './graph-dto.js';
import type { CenteredGraphOptions, GlobalGraphOptions, ImpactOptions } from './graph-service.js';
import type { RetrievalEventGraphResponse, RetrievalEventSummary } from './retrieval-dto.js';

export type SkillLifecycle = 'candidate' | 'active' | 'stale' | 'rejected';

/**
 * Single resource bound to a skill version. Resources are addressed
 * by their relative POSIX path (e.g. `bin/run.sh`). The repository
 * persists bytes inline and never indexes them in FTS.
 */
export interface SkillResource {
  /** POSIX-style relative path inside the skill; never absolute. */
  relativePath: string;
  /** File mode; only `0o644` and `0o755` are accepted by the repo. */
  mode: 0o644 | 0o755;
  /** RFC-6838 mime type; bounded length, no control characters. */
  mime: string;
  /** Raw bytes; size must equal `bytes.byteLength`. */
  bytes: Buffer;
}

/**
 * Persisted resource shape (bytes are not included — read separately
 * via `resourceRead`). The repository returns this shape from
 * `resourceList` so REST callers can stream or echo metadata
 * without pulling the entire body into the wire payload.
 */
export interface SkillResourceMeta {
  relativePath: string;
  mode: 0o644 | 0o755;
  mime: string;
  size: number;
  sha256: string;
}

/**
 * Full version returned by `writeSkill` / `skillGet` / `getVersion`.
 * Bodies are returned as `Buffer` so REST can choose the wire format
 * (utf-8 string for text, base64 for binary). Resource bytes are
 * kept on the `resources` array as `SkillResourceMeta` (without
 * bytes); use `resourceRead` for the actual payload.
 */
export interface SkillVersion {
  id: string;
  scope: Scope;
  logicalKey: string;
  kind: 'skill' | 'tool';
  name: string;
  summary?: string;
  lifecycle: SkillLifecycle;
  version: number;
  /** Full UTF-8 body. */
  body: Buffer;
  /** sha256 of the body, lowercase hex. */
  bodySha256: string;
  /** Total bytes of body + every resource. */
  totalSize: number;
  /** Metadata / provenance, opaque JSON. Never contains body bytes. */
  metadata: Record<string, unknown>;
  /** Resource metadata, ordered by `relativePath`. */
  resources: SkillResourceMeta[];
  createdAt: string;
  updatedAt: string;
}

/** Shape of the resource row returned by `resourceRead`. */
export interface SkillResourceRecord extends SkillResourceMeta {
  bytes: Buffer;
}

/**
 * Write input for `writeSkill`. The repository stamps `version`
 * monotonically, computes `bodySha256` from `body`, and stamps
 * `totalSize` from `body.byteLength + sum(resource.bytes.byteLength)`.
 */
export interface SkillWriteInput {
  /** Stable skill id; reused across versions. */
  id: string;
  scope: Scope;
  logicalKey: string;
  kind: 'skill' | 'tool';
  name: string;
  summary?: string;
  lifecycle: SkillLifecycle;
  body: Buffer;
  metadata: Record<string, unknown>;
  resources: SkillResource[];
  /** Relations are immutable constituents of the version being published. */
  relations?: SkillRelationInput[];
  /** CAS expected current version. `0` or `undefined` ⇒ first write. */
  expectedVersion?: number;
}

/**
 * Bounded discovery result returned by `skillSearch`.
 *
 * The body is deliberately excluded: callers first discover a stable
 * id/version and then opt in to full content via `skillGet`. This
 * prevents a broad search from injecting up to `limit * 1 MiB` into an
 * agent context while preserving hashes and resource metadata.
 */
export type SkillSearchHit = Omit<SkillVersion, 'body'>;

/**
 * Repository contract. Implementations must be actor-bound:
 *   * Every read enforces the actor's scope; cross-scope reads throw
 *     NOT_FOUND (HTTP 404) rather than leaking rows.
 *   * Every write requires the actor to be present (FORBIDDEN if
 *     missing) and writes a single audit row referencing the version
 *     + size — never the raw bytes.
 */
/**
 * Metadata-only snapshot of an active skill head, used by the
 * exporter so the preview never carries body bytes. The body /
 * resource bytes are pulled through `resourceRead` / `getHeadVersion`
 * during apply, never through the plan.
 */
export interface SkillHeadSummary {
  id: string;
  logicalKey: string;
  name: string;
  version: number;
  bodySize: number;
  bodySha256: string;
  resources: SkillResourceMeta[];
  /** sha256 over the sorted `(relativePath, sha256)` resource fingerprint. */
  resourceFingerprint: string;
}

export interface SkillRepository {
  writeSkill(input: SkillWriteInput, meta: { reason: string; requestId: string }): SkillVersion;
  getHeadVersion(id: string, scope: Scope): SkillVersion | undefined;
  getVersion(id: string, version: number, scope: Scope): SkillVersion | undefined;
  skillGet(id: string, scope: Scope): SkillVersion;
  skillSearch(scope: Scope, query: string, limit?: number): SkillSearchHit[];
  resourceList(id: string, scope: Scope): SkillResourceMeta[];
  resourceRead(id: string, relativePath: string, scope: Scope): SkillResourceRecord;
  /** Sum of bytes across the current head's resources + body. */
  totalSize(id: string, scope: Scope): number;
  /**
   * List every active head for the actor's scope in `(logicalKey, id)`
   * POSIX byte order. Cross-scope rows are NEVER included — the
   * export coordinator always filters by the actor's scope so the
   * plan cannot leak skills owned by other users/agents.
   */
  listActiveHeads(scope: Scope): SkillHeadSummary[];
  /**
   * Same shape as `listActiveHeads` but restricted to the supplied
   * `(id, version)` tuples. Useful for the `--skill-id` selection
   * mode in the export CLI.
   */
  listActiveHeadsFiltered(scope: Scope, ids: string[]): SkillHeadSummary[];
  /**
   * Read a single resource by `(id, version, relativePath)`. The
   * exporter uses this to validate that a target staging file has
   * the exact bytes the plan promised (no drift between preview
   * and apply).
   */
  readResourceAtVersion(
    id: string,
    version: number,
    relativePath: string,
    scope: Scope,
  ): SkillResourceRecord;
  getRelations(id: string, version: number | undefined, scope: Scope): SkillRelation[];
  getDependents(id: string, scope: Scope): SkillRelation[];
  replaceRelations(id: string, expectedVersion: number, relations: SkillRelationInput[], scope: Scope, meta: { reason: string; requestId: string }): SkillVersion;
  resolveGraph(id: string, version: number | undefined, scope: Scope, limits?: Partial<{ maxDepth: number; maxResolvedSkills: number }>): ResolvedSkillGraph;
  resolveRetrieval(query: string, profile: string, scope: Scope, limits?: Partial<RetrievalLimits>): RetrievalResolution;
  buildGlobalGraph(scope: Scope, options?: GlobalGraphOptions): GlobalSkillGraph;
  buildCenteredGraph(id: string, scope: Scope, options?: CenteredGraphOptions): SkillGraphResponse;
  buildImpactGraph(id: string, scope: Scope, options?: ImpactOptions): SkillImpactResponse;
  listRetrievalEvents(scope: Scope, limit?: number, includeRedactedQuery?: boolean): RetrievalEventSummary[];
  getRetrievalEventGraph(requestId: string, scope: Scope): RetrievalEventGraphResponse;
}

export interface RetrievalSkillSelection {
  skillId: string;
  version: number;
  score: number;
  tier: 'canonical' | 'supporting' | 'dependency';
  reason: 'direct_match' | 'dependency';
  parent?: string;
  relation?: string;
  depth: number;
}

export interface RetrievalMemorySelection {
  memoryId: string;
  version: number;
  kind: string;
  confidence: number;
  importance: number;
}

export interface RetrievalResolution {
  requestId: string;
  classification: RetrievalClassification;
  policy: RetrievalPolicyDecision;
  query: { digest: string; terms: string[] };
  candidatesConsidered: number;
  memoryCandidatesConsidered: number;
  skills: RetrievalSkillSelection[];
  memories: RetrievalMemorySelection[];
  noMatch: boolean;
  limits: RetrievalLimits;
  materialization: { selectedBytes: number; maxBodyBytes: number };
}

/** Hard upper bound on the body size, in bytes. */
export const SKILL_BODY_MAX_BYTES = 1024 * 1024;
/** Hard upper bound on a single resource, in bytes. */
export const SKILL_RESOURCE_MAX_BYTES = 4 * 1024 * 1024;
/** Hard upper bound on the sum of all resources per version. */
export const SKILL_RESOURCE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
/** Hard upper bound on `relativePath` length. */
export const SKILL_RESOURCE_PATH_MAX = 512;
/** Hard upper bound on `mime` length. */
export const SKILL_RESOURCE_MIME_MAX = 128;
/** Hard upper bound on `skillSearch` limit. */
export const SKILL_SEARCH_LIMIT_MAX = 100;
/** Default `skillSearch` limit. */
export const SKILL_SEARCH_LIMIT_DEFAULT = 20;