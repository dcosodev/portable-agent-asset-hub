// packages/materializers/src/contracts.ts
//
// Frozen contract surface for the S8 materializer. The types in this
// file are the public API for every renderer (hermes, openclaw) and for
// every consumer (REST, MCP, SDKs). They must remain renderer-agnostic
// so that Slice 9 (OpenClaw) can reuse the same apply/rollback pipeline
// by swapping the `hermesAdapter` for an `openclawAdapter`.

import type { ActorContext, Profile, Storage } from '@portable-agent-asset-hub/core';

export type HarnessId = 'hermes' | 'openclaw';

export type SourceRef = string;

/**
 * One materialised file inside a plan. The renderer contract guarantees
 * that every `relativePath` is forward-slash, has no leading slash, no
 * `..` segment, and no empty segment. The bytes are the canonical UTF-8
 * content that will be written to disk after a successful apply.
 */
export type ManifestFile = {
  relativePath: string;
  sha256: string;
  bytes: Buffer;
  mode: number;
  sourceRef: SourceRef;
};

/**
 * The manifest v1 contract. This is the value the renderer hands to
 * `applyPlan`. Slice 9 reuses this exact shape — `harness` is the only
 * field that distinguishes a Hermes materialization from an OpenClaw
 * one.
 */
export type ManifestV1 = {
  runId?: string;
  snapshotId: string;
  harness: HarnessId;
  profileId: string;
  targetRoot: string;
  files: ManifestFile[];
  generatedAt: string;
  rendererVersion: string;
};

export type PreviewInput = {
  harness: HarnessId;
  profileId: string;
  snapshotId: string;
  targetRoot: string;
};

export type PreviewResult = {
  plan: ManifestV1;
  /**
   * SHA-256 of the bytes the renderer *would* write, computed over the
   * canonical manifest. This is what the caller sends back as the
   * `observedDigest` of the second apply, and what the server compares
   * to detect drift.
   */
  observedDigest: string;
  profile: Profile;
};

export type ApplyInput = {
  preview: PreviewResult;
  targetRoot: string;
  lockDir: string;
  observedDigest?: string;
  expectedDigest?: string;
  reason: string;
  requestId?: string;
};

export type ApplyResult = {
  runId: string;
  manifestPath: string;
  observedDigest: string;
  backupRoot: string;
  writtenFiles: ManifestFile[];
};

export type RollbackInput = {
  runId: string;
  reason: string;
  requestId?: string;
};

export type RollbackResult = {
  runId: string;
  restored: string[];
};

/**
 * A renderer adapter turns a Profile + harness metadata into a list of
 * `ManifestFile`s. The default Hermes adapter writes USER.md / MEMORY.md
 * / SKILL.md (per Slice 8 plan), and the manifest itself. Slice 9 ships
 * an `openclawAdapter` with the same shape but a different layout.
 */
export type RenderResult = { files: ManifestFile[] };

export type RendererAdapter = {
  id: HarnessId;
  manifestPath: string;
  rendererVersion: string;
  render(profile: Profile): RenderResult;
};

export type MaterializerDeps = {
  store: Storage;
  actor: ActorContext;
};
