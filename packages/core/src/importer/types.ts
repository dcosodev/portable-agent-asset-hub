// packages/core/src/importer/types.ts
//
// Phase 2 — Skill pack importer contract surface (pure types only).
//
// `SkillPackImporter` lives in `@portable-agent-asset-hub/storage-files`
// because the preview step reads the filesystem (`node:fs` / `node:path`)
// and the apply step opens the SQLite store. Core stays I/O-free.
//
// IDs and logical keys are stable, neutral to roots and runtime paths:
// they are derived from the declared `name` (with a stable hash suffix
// when needed) so two roots carrying the same package surface once with
// both roots listed as provenance.
//
// Absolute paths and locator paths are NEVER persisted anywhere in the
// preview or the database — only `rootId` + `relativePath` provenance is
// carried over.
//
// The preview contains `planDigest`, which is the value a human
// reviewer must echo back via `--reviewed-digest` to authorize the
// apply step. A successful apply creates v1 for new packages and vN+1
// (via CAS) for packages whose content actually changed.

import type { Scope } from '../identity/types.js';
import type { SkillRelationInput } from '../skills/graph.js';

/** Schema version of the inventory JSON consumed by the importer. */
export const SKILL_INVENTORY_SCHEMA_VERSION = 1;

/** Schema version of the preview JSON emitted by the importer. */
export const SKILL_PACK_PREVIEW_SCHEMA_VERSION = 1;

/**
 * Inventory entry as emitted by `scripts/inventory-agent-skills.mjs`.
 * The importer only ever treats `rootId` + `relativePath` as provenance
 * metadata — the absolute `root` path is read separately from the
 * roots-config file and is deliberately not inlined here.
 */
export interface SkillInventoryEntry {
  rootId: string;
  relativePath: string;
  locator: string;
  name: string;
  sha256: string;
  size: number;
  logicalKey: string;
}

/** Duplicate group used by the inventory — value plus sorted sources. */
export interface SkillInventoryDuplicate {
  value: string;
  paths: string[];
}

/** Single inventory secret finding. The value itself is never carried. */
export interface SkillInventorySecretFinding {
  rootId: string;
  path: string;
  rule: string;
}

/** Bounded inventory payload. The importer is tolerant of extra keys. */
export interface SkillInventoryV1 {
  schemaVersion: number;
  profile: string;
  scope: Scope;
  roots: Array<{ id: string; path: string; excludePrefixes?: string[] }>;
  selectorsByRoot: Record<string, string[]>;
  entries: SkillInventoryEntry[];
  exclusions: Array<{ rootId: string; path: string; reason: string }>;
  duplicateNames: SkillInventoryDuplicate[];
  duplicateHashes: SkillInventoryDuplicate[];
  logicalKeyCollisions: SkillInventoryDuplicate[];
  highConfidenceSecretFindings: SkillInventorySecretFinding[];
  counts: {
    discovered: number;
    selected: number;
    excluded: number;
    duplicateNames: number;
    duplicateHashes: number;
    logicalKeyCollisions: number;
    highConfidenceSecretFindings: number;
  };
  inventoryDigest: string;
}

/** Single resource candidate produced during preview. */
export interface SkillPackResourcePlan {
  relativePath: string;
  mode: 0o644 | 0o755;
  mime: string;
  size: number;
  sha256: string;
}

/** Single provenance source for a package. */
export interface SkillPackSource {
  rootId: string;
  relativePath: string;
  bodySha256: string;
  size: number;
}

/** Single package plan entry. */
export interface SkillPackPackagePlan {
  /** Stable skill id (prefixed `skl_`). */
  id: string;
  /** Normalized declared name (deduplicated across roots). */
  name: string;
  /** Optional declared summary (from `description:` frontmatter). */
  summary?: string;
  /** Stable logical key. Derived from the declared name, never the path. */
  logicalKey: string;
  /** sha256 of the SKILL.md body (the bytes that will become `body`). */
  bodySha256: string;
  bodySize: number;
  /** Every regular file under the SKILL.md's directory, in POSIX order. */
  resources: SkillPackResourcePlan[];
  /** Every source backing this package. One package may have several. */
  sources: SkillPackSource[];
  /** Explicit relations parsed from skill-relations.json; absent historical skills remain relation-free. */
  relations?: SkillRelationInput[];
  /** Distinguishes an explicit empty manifest (clear) from no declaration (inherit). */
  relationsDeclared?: boolean;
}

/** Secret finding surfaced during preview — value never included. */
export interface SkillSecretFinding {
  rootId: string;
  path: string;
  rule: string;
}

/** Aggregate preview counters. */
export interface SkillPackCounts {
  /** Number of packages that will be written. */
  packages: number;
  /** Total resources across all packages. */
  resources: number;
  /** Total bytes (body + resources) across all packages. */
  totalBytes: number;
  /** Number of sources (one package may have several sources). */
  sources: number;
  /** Number of secret findings. */
  secretFindings: number;
}

/**
 * Deterministic preview JSON. `generatedAt` and any other wall-clock
 * markers are deliberately ABSENT from this contract — the digest
 * must be reproducible and the apply step is the only moment where
 * the coordinator is permitted to attach a timestamp.
 */
export interface SkillPackPreviewV1 {
  schemaVersion: number;
  inventoryDigest: string;
  planDigest: string;
  scope: Scope;
  profile: string;
  roots: Array<{ id: string; excludePrefixes: string[] }>;
  packages: SkillPackPackagePlan[];
  counts: SkillPackCounts;
  secretFindings: SkillSecretFinding[];
}

/** Plan-level shape (preview, no volatile fields). */
export type SkillPackPlan = SkillPackPreviewV1;

/**
 * Raw bytes associated with a single package after a fresh scan.
 * `body` is the SKILL.md buffer; `resources` is the regular-file set
 * (paths + bytes), sorted in POSIX byte order.
 */
export interface SkillPackCollectedBytes {
  body: Buffer;
  resources: Array<{
    relativePath: string;
    mode: 0o644 | 0o755;
    mime: string;
    bytes: Buffer;
  }>;
}

/**
 * Output of a single fresh scan. `bodies` is indexed by `package.id`
 * so the apply step can resolve bodies without re-reading the
 * filesystem or holding mutable state across calls.
 */
export interface SkillPackScanResult {
  plan: SkillPackPlan;
  bodies: Map<string, SkillPackCollectedBytes>;
}

/**
 * Outcome of one package write inside an apply transaction. A write is
 * either `changed: true` (a new version row was written — first time
 * or CAS-bumped) or `changed: false` (idempotent no-op against the
 * existing head).
 */
export interface SkillPackApplyOutcome {
  id: string;
  version: number;
  changed: boolean;
}

/**
 * Apply result. Includes the per-package outcomes (never a single id),
 * the backup file descriptor, and the wall-clock instant the apply
 * finished. Bytes are never included.
 */
export interface SkillPackApplyResult {
  planDigest: string;
  outcomes: SkillPackApplyOutcome[];
  backup: { path: string; sha256: string };
  appliedAt: string;
}

/** Scope mismatch error payload (thrown by the coordinator). */
export interface SkillPackApplyScopeMismatch {
  planScope: Scope;
  actorScope: Scope;
}

/** Test-only hook for forced mid-transaction failures (never wired in production). */
export interface SkillPackApplyHooks {
  /** One-based write index that throws after that write, before COMMIT. */
  failWriteSkillAt?: number;
}
