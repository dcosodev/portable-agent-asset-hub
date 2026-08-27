// packages/skill-export/src/types.ts
//
// Public contract for the FASE 5 skill exporter. The exporter is a
// read-only projection that walks `skill_entries` (filtered by
// `lifecycle = 'active'` and the actor's scope) and produces a
// deterministic, metadata-only `SkillExportPlan`. Body bytes and
// resource bytes are NEVER carried in the plan — they are pulled
// from SQLite only at apply time, so a preview cannot leak content
// to a public artifact directory.
//
// The apply step writes files to a managed staging directory on the
// SAME filesystem as the requested `--target-dir`, then promotes
// them via an atomic rename + a JSON registry of pre-existing
// files. A failed apply leaves the previous target untouched
// because nothing in `--target-dir` is mutated before promotion.

import type { Scope } from '@portable-agent-asset-hub/core';
import type { SkillHeadSummary, SkillRelation } from '@portable-agent-asset-hub/core';

export const SKILL_EXPORT_SCHEMA_VERSION = 1 as const;
export const SKILL_EXPORT_MANIFEST_NAME = 'manifest.json' as const;
export const SKILL_EXPORT_REGISTRY_NAME = '.export-registry.json' as const;

export type SkillExportSelection = { mode: 'all' } | { mode: 'ids'; ids: string[] };

export interface SkillExportFilePlan {
  /** Absolute path inside the staging dir, relative to it. */
  relativePath: string;
  /** The size the apply step is expected to write. */
  size: number;
  /** sha256 of the bytes the apply step is expected to write. */
  sha256: string;
  /** File mode the apply step is expected to apply (`0644` / `0755`). */
  mode: 0o644 | 0o755;
  /** Source skill id. */
  skillId: string;
  /** Source skill logical key. */
  logicalKey: string;
  /** Source skill version. */
  skillVersion: number;
  /** Whether the file is the SKILL.md body (`true`) or a resource (`false`). */
  isBody: boolean;
  /** Deterministic relation projection generated from SQLite at apply time. */
  isRelationsManifest?: boolean;
  /** For resources, the original `relativePath` inside the skill. */
  sourceRelativePath: string;
}

export interface SkillExportPackagePlan {
  id: string;
  logicalKey: string;
  name: string;
  /** sha256 over the package's sorted `(relativePath, sha256)` resources. */
  resourceFingerprint: string;
  bodySha256: string;
  bodySize: number;
  /** Metadata-only relation projection; bodies/resources are still absent. */
  relations: SkillRelation[];
  /** Every file this package contributes to the staging dir. */
  files: SkillExportFilePlan[];
}

export interface SkillExportPlan {
  schemaVersion: typeof SKILL_EXPORT_SCHEMA_VERSION;
  scope: Scope;
  ownerUserId: string;
  agentId: string;
  selection: SkillExportSelection;
  /** sha256 over the canonical JSON serialization of the plan. */
  planDigest: string;
  /** sha256 over the sorted `(id, version, bodySha256, resourceFingerprint)` tuples. */
  contentDigest: string;
  /** Pre-aggregated package plans, sorted by `(logicalKey, id)` POSIX. */
  packages: SkillExportPackagePlan[];
  counts: {
    packages: number;
    files: number;
    totalBytes: number;
  };
}

export interface SkillExportApplyResult {
  runId: string;
  planDigest: string;
  contentDigest: string;
  appliedAt: string;
  /** Number of files actually written to the target. */
  filesWritten: number;
  /** Number of files that already matched the plan and were left untouched. */
  filesReused: number;
  /** Number of files removed from the previous materialization. */
  filesRemoved: number;
  /** Manifest path (always `manifest.json` inside `--target-dir`). */
  manifestPath: string;
  /** Registry path. */
  registryPath: string;
  /** Target path passed to the apply. */
  targetDir: string;
  /** Mode used for `--all` vs `--skill-id`. */
  selection: SkillExportSelection;
}

export interface SkillExportRegistryFile {
  /** Path relative to the target dir, as POSIX. */
  relativePath: string;
  /** sha256 of the bytes that existed before this apply. */
  existed: boolean;
  preApplySha256: string | null;
  preApplyMode: number | null;
  preApplySize: number | null;
}

export interface SkillExportRegistry {
  schemaVersion: typeof SKILL_EXPORT_SCHEMA_VERSION;
  runId: string;
  backupName: string;
  planDigest: string;
  contentDigest: string;
  appliedAt: string;
  selection: SkillExportSelection;
  files: SkillExportRegistryFile[];
}

export type SkillExportApplyHooks = {
  /** Force a failure after the staging files are written, before promotion. */
  failBeforePromote?: boolean;
  /** Force a failure after promotion, before the registry is finalised. */
  failAfterPromote?: boolean;
};

export type SkillExportApplyOptions = {
  /** Optional helper functions used for fsync — defaults to `fsyncSync`. */
  fsync?: (path: string) => void;
  /** Test-only hooks. Never wired in production. */
  hooks?: SkillExportApplyHooks;
};

export type { SkillHeadSummary };
