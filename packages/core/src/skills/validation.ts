// packages/core/src/skills/validation.ts
//
// Centralized path / size / mode / mime / utf-8 validation for the
// skill repository. Every check throws a `HubError('VALIDATION', …)`
// with HTTP 400 (or 413 for size violations) so the REST app surfaces
// them without further mapping. No bytes are echoed — only safe
// metadata such as the offending value's shape.

import { HubError } from '../errors.js';
import type { SkillResource, SkillWriteInput } from './types.js';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_RESOURCE_MAX_BYTES,
  SKILL_RESOURCE_MIME_MAX,
  SKILL_RESOURCE_PATH_MAX,
  SKILL_RESOURCE_TOTAL_MAX_BYTES,
} from './types.js';

const SAFE_PATH = /^[A-Za-z0-9._/+-]+$/u;

function isValidUtf8(buffer: Buffer): boolean {
  // Quick check: Node treats Buffer.toString('utf8') as lossy on
  // invalid sequences. Compare against the round-tripped form.
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer);
}

/**
 * Validate a single resource path. The repository refuses:
 *   * absolute paths
 *   * backslash separators (POSIX only)
 *   * any `..` segment
 *   * any `//` or leading/trailing slash
 *   * NUL or control characters
 *   * empty strings or strings longer than `SKILL_RESOURCE_PATH_MAX`
 */
export function validateResourcePath(path: string): string {
  if (typeof path !== 'string') throw new HubError('VALIDATION', 'resource path must be a string', 400);
  if (path.length === 0) throw new HubError('VALIDATION', 'resource path must be non-empty', 400);
  if (path.length > SKILL_RESOURCE_PATH_MAX) {
    throw new HubError('VALIDATION', `resource path exceeds ${SKILL_RESOURCE_PATH_MAX} characters`, 400);
  }
  if (path.indexOf('\u0000') >= 0) throw new HubError('VALIDATION', 'resource path contains NUL', 400);
  if (path.includes('\\')) throw new HubError('VALIDATION', 'resource path must be POSIX', 400);
  if (path.startsWith('/')) throw new HubError('VALIDATION', 'resource path must be relative', 400);
  if (path.endsWith('/')) throw new HubError('VALIDATION', 'resource path must not end with /', 400);
  if (path.includes('//')) throw new HubError('VALIDATION', 'resource path must not contain //', 400);
  if (path === '.' || path === '..') throw new HubError('VALIDATION', 'resource path must not be . or ..', 400);
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.' || segment.length === 0) {
      throw new HubError('VALIDATION', 'resource path must not contain . or .. segments', 400);
    }
  }
  if (!SAFE_PATH.test(path)) throw new HubError('VALIDATION', 'resource path contains forbidden characters', 400);
  return path;
}

/** Validate that a mode is one of the two accepted values. */
export function validateResourceMode(mode: number): 0o644 | 0o755 {
  if (mode !== 0o644 && mode !== 0o755) {
    throw new HubError('VALIDATION', 'resource mode must be 0644 or 0755', 400);
  }
  return mode;
}

/** Validate a MIME type against a bounded RFC-6838-ish subset. */
export function validateResourceMime(mime: string): string {
  if (typeof mime !== 'string' || mime.length === 0 || mime.length > SKILL_RESOURCE_MIME_MAX) {
    throw new HubError('VALIDATION', `mime must be 1..${SKILL_RESOURCE_MIME_MAX} characters`, 400);
  }
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mime)) {
    throw new HubError('VALIDATION', 'mime must be of the form "type/subtype"', 400);
  }
  return mime;
}

/**
 * Validate a single resource's bytes. Throws 400 for malformed paths
 * and 413 for size violations; the REST app's error mapper passes
 * both through unchanged.
 */
export function validateResource(resource: SkillResource): SkillResource {
  if (!resource || typeof resource !== 'object') {
    throw new HubError('VALIDATION', 'resource must be an object', 400);
  }
  const path = validateResourcePath(resource.relativePath);
  const mode = validateResourceMode(resource.mode);
  const mime = validateResourceMime(resource.mime);
  if (!Buffer.isBuffer(resource.bytes)) {
    throw new HubError('VALIDATION', 'resource.bytes must be a Buffer', 400);
  }
  if (resource.bytes.byteLength > SKILL_RESOURCE_MAX_BYTES) {
    throw new HubError(
      'VALIDATION',
      `resource exceeds ${SKILL_RESOURCE_MAX_BYTES} bytes (4 MiB)`,
      413,
    );
  }
  return { relativePath: path, mode, mime, bytes: resource.bytes };
}

/**
 * Validate an entire write input. Returns the cleaned input so the
 * repository can rely on it (no need to re-validate each field). All
 * size checks use HTTP 413 to signal "too big" — the REST surface
 * must surface those as `Payload Too Large`.
 */
export function validateSkillInput(input: SkillWriteInput): SkillWriteInput {
  if (!input || typeof input !== 'object') {
    throw new HubError('VALIDATION', 'skill input must be an object', 400);
  }
  if (typeof input.id !== 'string' || input.id.length === 0 || input.id.length > 128) {
    throw new HubError('VALIDATION', 'skill.id must be 1..128 characters', 400);
  }
  if (typeof input.logicalKey !== 'string' || input.logicalKey.length === 0 || input.logicalKey.length > 512) {
    throw new HubError('VALIDATION', 'skill.logicalKey must be 1..512 characters', 400);
  }
  if (input.kind !== 'skill' && input.kind !== 'tool') {
    throw new HubError('VALIDATION', 'skill.kind must be "skill" or "tool"', 400);
  }
  if (input.lifecycle !== 'candidate' && input.lifecycle !== 'active' && input.lifecycle !== 'stale' && input.lifecycle !== 'rejected') {
    throw new HubError('VALIDATION', 'skill.lifecycle invalid', 400);
  }
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > 256) {
    throw new HubError('VALIDATION', 'skill.name must be 1..256 characters', 400);
  }
  if (input.summary !== undefined && (typeof input.summary !== 'string' || input.summary.length > 1024)) {
    throw new HubError('VALIDATION', 'skill.summary must be ≤ 1024 characters when present', 400);
  }
  if (!Buffer.isBuffer(input.body)) {
    throw new HubError('VALIDATION', 'skill.body must be a Buffer', 400);
  }
  if (!isValidUtf8(input.body)) {
    throw new HubError('VALIDATION', 'skill.body is not valid UTF-8', 400);
  }
  if (input.body.byteLength > SKILL_BODY_MAX_BYTES) {
    throw new HubError(
      'VALIDATION',
      `skill.body exceeds ${SKILL_BODY_MAX_BYTES} bytes (1 MiB)`,
      413,
    );
  }
  if (!Array.isArray(input.resources)) {
    throw new HubError('VALIDATION', 'skill.resources must be an array', 400);
  }
  const seen = new Set<string>();
  let totalResources = 0;
  const cleaned: SkillResource[] = [];
  for (const resource of input.resources) {
    const ok = validateResource(resource);
    if (seen.has(ok.relativePath)) {
      throw new HubError('VALIDATION', `duplicate resource path ${ok.relativePath}`, 400);
    }
    seen.add(ok.relativePath);
    totalResources += ok.bytes.byteLength;
    cleaned.push(ok);
  }
  if (totalResources > SKILL_RESOURCE_TOTAL_MAX_BYTES) {
    throw new HubError(
      'VALIDATION',
      `skill.resources total ${totalResources} exceeds ${SKILL_RESOURCE_TOTAL_MAX_BYTES} bytes (16 MiB)`,
      413,
    );
  }
  if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)) {
    throw new HubError('VALIDATION', 'expectedVersion must be a non-negative integer', 400);
  }
  return {
    id: input.id,
    scope: input.scope,
    logicalKey: input.logicalKey,
    kind: input.kind,
    name: input.name,
    summary: input.summary,
    lifecycle: input.lifecycle,
    body: input.body,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    resources: cleaned,
    relations: input.relations,
    expectedVersion: input.expectedVersion,
  };
}