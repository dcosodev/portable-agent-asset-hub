// packages/skill-export/src/validator.ts
//
// Centralised validation surface for the export plan and apply
// step. Every check that touches the filesystem or reads the
// target directory is performed here so the coordinator can stay
// focused on orchestration. All rejections throw `HubError` so the
// CLI surface maps them to the documented `validation=400`,
// `conflict=409`, `forbidden=403`, `not_found=404` codes.

import { existsSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { HubError } from '@portable-agent-asset-hub/core';
import { SKILL_BODY_MAX_BYTES, SKILL_RESOURCE_MAX_BYTES, SKILL_RESOURCE_PATH_MAX } from '@portable-agent-asset-hub/core';
import { SKILL_EXPORT_REGISTRY_NAME, SKILL_EXPORT_MANIFEST_NAME, type SkillExportPlan, type SkillExportRegistryFile } from './types.js';

export function assertSafeRelativePath(path: string): string {
  if (typeof path !== 'string') {
    throw new HubError('VALIDATION', 'path must be a string', 400);
  }
  if (path.length === 0) {
    throw new HubError('VALIDATION', 'path must be non-empty', 400);
  }
  if (path.length > SKILL_RESOURCE_PATH_MAX) {
    throw new HubError('VALIDATION', `path exceeds ${SKILL_RESOURCE_PATH_MAX} characters`, 400);
  }
  if (path.includes('\u0000')) {
    throw new HubError('VALIDATION', 'path contains NUL', 400);
  }
  if (path.includes('\\')) {
    throw new HubError('VALIDATION', 'path must be POSIX', 400);
  }
  if (path.startsWith('/')) {
    throw new HubError('VALIDATION', 'path must be relative', 400);
  }
  if (path.endsWith('/')) {
    throw new HubError('VALIDATION', 'path must not end with /', 400);
  }
  if (path.includes('//')) {
    throw new HubError('VALIDATION', 'path must not contain //', 400);
  }
  if (!/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/u.test(path)) {
    throw new HubError('VALIDATION', `path has forbidden characters: ${path}`, 400);
  }
  if (path === '.' || path === '..' || path.split('/').includes('..')) {
    throw new HubError('VALIDATION', `path must not contain . or .. segments: ${path}`, 400);
  }
  return path;
}

export function assertSafeStagingPath(stagingRoot: string, target: string): string {
  if (typeof target !== 'string' || target.length === 0) {
    throw new HubError('VALIDATION', 'staging path must be a non-empty string', 400);
  }
  if (isAbsolute(target)) {
    throw new HubError('VALIDATION', `staging path must be relative: ${target}`, 400);
  }
  if (target.split('/').some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
    throw new HubError('VALIDATION', `staging path escapes staging root: ${target}`, 400);
  }
  const absolute = resolve(stagingRoot, target);
  const rel = relative(stagingRoot, absolute);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new HubError('VALIDATION', `staging path escapes staging root: ${target}`, 400);
  }
  return rel;
}

export function assertSafeTargetPath(targetRoot: string, target: string): string {
  if (typeof target !== 'string' || target.length === 0) {
    throw new HubError('VALIDATION', 'target path must be a non-empty string', 400);
  }
  if (isAbsolute(target)) {
    throw new HubError('VALIDATION', `target path must be relative: ${target}`, 400);
  }
  if (target.split('/').some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
    throw new HubError('VALIDATION', `target path escapes target root: ${target}`, 400);
  }
  const absolute = resolve(targetRoot, target);
  const rel = relative(targetRoot, absolute);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || normalize(rel) !== rel) {
    throw new HubError('VALIDATION', `target path escapes target root: ${target}`, 400);
  }
  return rel;
}

export function assertSafeRoot(root: string, label: string): string {
  if (typeof root !== 'string' || root.length === 0) {
    throw new HubError('VALIDATION', `${label} must be a non-empty path`, 400);
  }
  if (existsSync(root)) {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink()) {
      throw new HubError('VALIDATION', `${label} must not be a symlink: ${root}`, 400);
    }
  }
  return resolve(root);
}

/**
 * Walk every ancestor (and the path itself) of `absolute` under
 * `root`; throw on the first symlink. Used to refuse staging /
 * target roots that contain symlinks anywhere along the way.
 */
export function assertNoSymlinkAncestors(root: string, absolute: string, label: string): void {
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new HubError('VALIDATION', `${label} root is a symlink: ${root}`, 400);
  }
  const rel = relative(root, absolute);
  if (rel === '' || rel === '.') return;
  let current = root;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    current = resolve(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new HubError('VALIDATION', `${label} path contains symlink: ${current}`, 400);
      }
    }
  }
}

export function assertSizeWithinLimit(size: number, kind: 'body' | 'resource'): void {
  if (!Number.isInteger(size) || size < 0) {
    throw new HubError('VALIDATION', `${kind} size must be a non-negative integer`, 400);
  }
  const cap = kind === 'body' ? SKILL_BODY_MAX_BYTES : SKILL_RESOURCE_MAX_BYTES;
  if (size > cap) {
    throw new HubError('VALIDATION', `${kind} exceeds ${cap} bytes`, 413);
  }
}

export function assertNoCollision(packages: Array<{ id: string; files: Array<{ relativePath: string }> }>): void {
  const seen = new Set<string>();
  for (const pkg of packages) {
    for (const file of pkg.files) {
      if (seen.has(file.relativePath)) {
        throw new HubError(
          'CONFLICT',
          `relative path collides across packages: ${file.relativePath}`,
          409,
        );
      }
      seen.add(file.relativePath);
    }
  }
}

/**
 * Read a file's bytes + sha256, mode and size. Returns
 * `existed: false` when the file does not exist.
 */
export function snapshotPath(
  absolute: string,
): { existed: boolean; bytes?: Buffer; mode?: number; size?: number; sha256?: string } {
  if (!existsSync(absolute)) return { existed: false };
  const stat = statSync(absolute);
  if (stat.isSymbolicLink()) {
    throw new HubError('VALIDATION', `refusing to read symlink: ${absolute}`, 400);
  }
  if (!stat.isFile()) {
    throw new HubError('VALIDATION', `not a regular file: ${absolute}`, 400);
  }
  return {
    existed: true,
    bytes: undefined,
    mode: stat.mode & 0o777,
    size: stat.size,
    sha256: undefined,
  };
}

export function readRegistryFile(absolute: string): {
  existed: boolean;
  mode: number | null;
  size: number | null;
  bytes: Buffer | null;
} {
  if (!existsSync(absolute)) return { existed: false, mode: null, size: null, bytes: null };
  const stat = statSync(absolute);
  if (stat.isSymbolicLink()) {
    throw new HubError('VALIDATION', `registry is a symlink: ${absolute}`, 400);
  }
  if (!stat.isFile()) {
    throw new HubError('VALIDATION', `registry is not a regular file: ${absolute}`, 400);
  }
  // We never read the registry in the apply step until the new files
  // are already written, so a broken symlink is not a concern.
  return { existed: true, mode: stat.mode & 0o777, size: stat.size, bytes: null };
}

export function readLinkSafe(absolute: string): string | null {
  if (!existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) return readlinkSync(absolute);
  return null;
}

export function assertNoAbsolutePathsInPlan(plan: SkillExportPlan): void {
  for (const pkg of plan.packages) {
    for (const file of pkg.files) {
      if (isAbsolute(file.relativePath) || file.relativePath.includes('\\')) {
        throw new HubError('VALIDATION', `absolute or non-POSIX path in plan: ${file.relativePath}`, 400);
      }
      if (file.relativePath.startsWith('/') || file.relativePath.includes('..')) {
        throw new HubError('VALIDATION', `unsafe path in plan: ${file.relativePath}`, 400);
      }
    }
    if (isAbsolute(pkg.logicalKey) || isAbsolute(pkg.name)) {
      throw new HubError('VALIDATION', 'plan contains absolute logicalKey or name', 400);
    }
  }
  if (isAbsolute(plan.scope.ownerUserId) || isAbsolute(plan.scope.agentId)) {
    throw new HubError('VALIDATION', 'plan contains absolute scope identifiers', 400);
  }
}

export function assertRegistryIntegrity(registry: SkillExportRegistryFile[]): void {
  for (const entry of registry) {
    assertSafeRelativePath(entry.relativePath);
    if (entry.existed) {
      if (entry.preApplySha256 === null || entry.preApplySize === null || entry.preApplyMode === null) {
        throw new HubError('CONFLICT', `registry entry incomplete: ${entry.relativePath}`, 409);
      }
    } else {
      if (entry.preApplySha256 !== null || entry.preApplySize !== null || entry.preApplyMode !== null) {
        throw new HubError('CONFLICT', `registry entry has stale pre-apply data: ${entry.relativePath}`, 409);
      }
    }
  }
}

export function isReservedPath(path: string): boolean {
  return path === SKILL_EXPORT_MANIFEST_NAME || path === SKILL_EXPORT_REGISTRY_NAME;
}
