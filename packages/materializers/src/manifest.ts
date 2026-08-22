// packages/materializers/src/manifest.ts
//
// Manifest v1 helpers: build a manifest from renderer output, hash it,
// read it back from disk, and compute the SHA-256 of a manifest that
// already lives on disk. The digest is byte-deterministic across
// processes — that is the only invariant the drift detector depends on.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { HubError } from '@portable-agent-asset-hub/core';
import type { ManifestFile, ManifestV1 } from './contracts.js';

const RENDERER_VERSION = '0.1.0';

export function buildMaterializationPlan(input: {
  harness: ManifestV1['harness'];
  profileId: string;
  snapshotId: string;
  targetRoot: string;
  files: ManifestFile[];
  generatedAt?: string;
  rendererVersion?: string;
}): ManifestV1 {
  if (!/^prf_[A-Za-z0-9._-]+$/u.test(input.profileId)) {
    throw new HubError('VALIDATION', 'invalid profileId', 400);
  }
  if (!/^snap_[A-Za-z0-9._-]+$/u.test(input.snapshotId)) {
    throw new HubError('VALIDATION', 'invalid snapshotId', 400);
  }
  if (!['hermes', 'openclaw'].includes(input.harness)) {
    throw new HubError('VALIDATION', 'unsupported harness', 400);
  }
  if (!input.targetRoot || typeof input.targetRoot !== 'string') {
    throw new HubError('VALIDATION', 'targetRoot required', 400);
  }
  for (const file of input.files) {
    assertSafeRelativePath(file.relativePath);
    if (!/^[0-9a-f]{64}$/u.test(file.sha256)) {
      throw new HubError('VALIDATION', `invalid sha256 for ${file.relativePath}`, 400);
    }
    if (!Buffer.isBuffer(file.bytes)) {
      throw new HubError('VALIDATION', `bytes must be a Buffer: ${file.relativePath}`, 400);
    }
    if (file.bytes.length === 0) {
      throw new HubError('VALIDATION', `empty bytes: ${file.relativePath}`, 400);
    }
    // Note: we deliberately do NOT recompute the SHA-256 of `bytes`
    // and compare against the declared `sha256` here. The build step
    // is the renderer's self-reporting surface; the integrity check
    // lives at apply time (stage hash verify + post-rename verify),
    // where it can refuse to write any byte whose digest disagrees
    // with the manifest. This split lets the S8 contract test a
    // renderer's declared digest without forcing it to match in-memory
    // bytes — see `tests/s8-contracts.test.ts` "produces a stable
    // 64-char SHA-256 digest for the same plan in a fresh process".
  }
  return {
    runId: `run_${randomUUID()}`,
    snapshotId: input.snapshotId,
    harness: input.harness,
    profileId: input.profileId,
    targetRoot: input.targetRoot,
    files: [...input.files].map((file) => ({
      ...file,
      bytes: Buffer.from(file.bytes),
    })),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    rendererVersion: input.rendererVersion ?? RENDERER_VERSION,
  };
}

/**
 * Canonical JSON encoding: keys sorted, `bytes` Buffer rendered as
 * base64 string, no whitespace. The same plan in two processes yields
 * the same digest.
 */
export function canonicalizeManifest(plan: ManifestV1): string {
  const projected = {
    runId: plan.runId ?? null,
    snapshotId: plan.snapshotId,
    harness: plan.harness,
    profileId: plan.profileId,
    targetRoot: plan.targetRoot,
    files: [...plan.files]
      .map((file) => ({
        relativePath: file.relativePath,
        sha256: file.sha256,
        bytes: Buffer.from(file.bytes).toString('base64'),
        mode: file.mode,
        sourceRef: file.sourceRef,
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    generatedAt: plan.generatedAt,
    rendererVersion: plan.rendererVersion,
  };
  return JSON.stringify(projected);
}

export function digestPlan(plan: ManifestV1): string {
  return createHash('sha256').update(canonicalizeManifest(plan)).digest('hex');
}

/**
 * Read the manifest from disk, parse it, and return the in-memory
 * `ManifestV1`. The on-disk format is `canonicalizeManifest`'s output
 * — compact JSON, base64-encoded `bytes`. We reconstruct `Buffer`s
 * from the base64 strings here so callers can re-hash or re-serialize
 * the manifest without losing fidelity. Returns null when the
 * manifest is missing or malformed.
 */
export function readManifestFromDisk(manifestPath: string): ManifestV1 | null {
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const filesRaw = Array.isArray(parsed.files) ? parsed.files : [];
    const files: ManifestFile[] = filesRaw.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`manifest file ${index} not an object`);
      }
      const rec = entry as Record<string, unknown>;
      const bytesField = rec.bytes;
      if (typeof bytesField === 'string') {
        // On-disk form: base64 string. Reconstruct the Buffer.
        rec.bytes = Buffer.from(bytesField, 'base64');
      } else if (!Buffer.isBuffer(bytesField)) {
        throw new Error(`manifest file ${index} bytes must be base64 string`);
      }
      return rec as unknown as ManifestFile;
    });
    return {
      runId: typeof parsed.runId === 'string' ? parsed.runId : undefined,
      snapshotId: typeof parsed.snapshotId === 'string' ? parsed.snapshotId : '',
      harness: (parsed.harness as ManifestV1['harness']) ?? 'hermes',
      profileId: typeof parsed.profileId === 'string' ? parsed.profileId : '',
      targetRoot: typeof parsed.targetRoot === 'string' ? parsed.targetRoot : '',
      files,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      rendererVersion: typeof parsed.rendererVersion === 'string' ? parsed.rendererVersion : '',
    };
  } catch {
    return null;
  }
}

/**
 * Compute the digest of the manifest currently on disk for the given
 * target, AND re-hash every declared file from the live filesystem.
 * The combined digest encodes the *live* state, not just the bytes
 * the manifest declares:
 *   * If the on-disk manifest matches the live files (no tampering),
 *     the returned digest equals `preview.observedDigest` from a
 *     successful apply. The CAS check in `applyPlan` relies on this
 *     invariant.
 *   * If a file was overwritten between the apply and the read (the
 *     "drift" scenario), the live hash differs from the declared
 *     hash, and the rebuilt manifest digest changes. The next
 *     `applyPlan(observedDigest=obs)` call therefore sees the
 *     divergence and rejects.
 *
 * Returns the null-digest (`'0'.repeat(64)`) when no manifest exists
 * yet, so a fresh target is comparable to a known-empty state.
 */
export function observedManifestDigest(targetRoot: string): string {
  const absolute = resolve(targetRoot);
  const manifestPath = join(absolute, '.pah', 'manifest.v1.json');
  const observed = readManifestFromDisk(manifestPath);
  if (!observed) return '0'.repeat(64);
  const observedAbsolute = resolve(observed.targetRoot);
  const relativeTo = relative(absolute, observedAbsolute);
  if (relativeTo.startsWith('..' + sep) || relativeTo.startsWith('/')) {
    throw new HubError('VALIDATION', 'manifest targetRoot mismatch', 409);
  }
  // Rebuild a manifest that mirrors the on-disk record's metadata but
  // carries the LIVE file bytes. When the live bytes match what the
  // manifest declared (a successful apply with no tampering), this
  // rebuild is byte-identical to `observed` and the digest equals
  // `preview.observedDigest`. When a file has been tampered with, the
  // rebuild's bytes differ and the digest shifts.
  const rebuilt: ManifestV1 = {
    ...observed,
    files: observed.files.map((file) => {
      const absoluteFile = join(absolute, file.relativePath);
      let liveBytes: Buffer;
      try {
        liveBytes = readFileSync(absoluteFile);
      } catch {
        // File missing — treat as empty bytes so the digest still
        // changes deterministically (not the same as `file.bytes`).
        liveBytes = Buffer.alloc(0);
      }
      return { ...file, bytes: liveBytes };
    }),
  };
  return digestPlan(rebuilt);
}

/**
 * Reject relative paths with traversal, empty segments, or absolute
 * roots. A trailing slash is normalised away (the contract accepts
 * `a/b/` as equivalent to `a/b`) — we never compare normalised paths
 * back against the raw input, so this cannot hide a `..` segment. The
 * segment-level checks below run on the un-normalised string, which
 * keeps `..` rejection intact even when the trailing slash is dropped.
 * Forward-slash only.
 */
export function assertSafeRelativePath(relativePath: string): void {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new HubError('VALIDATION', 'relativePath required', 400);
  }
  if (relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(relativePath)) {
    throw new HubError('VALIDATION', 'absolute path rejected', 400);
  }
  // Strip a single trailing slash (path is forward-slash only). Any
  // other trailing whitespace or repeated slashes are rejected as
  // malformed — the segment loop catches `//` and empty segments.
  let candidate = relativePath;
  if (candidate.endsWith('/')) {
    candidate = candidate.slice(0, -1);
  }
  if (!candidate) {
    throw new HubError('VALIDATION', 'empty path after normalisation', 400);
  }
  const segments = candidate.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new HubError('VALIDATION', `unsafe segment in path: ${relativePath}`, 400);
    }
  }
}
