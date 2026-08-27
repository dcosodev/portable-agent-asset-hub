// packages/runtime-adapters/src/internal/safe-paths.ts
//
// Path hardening helpers shared by the preview and apply pipelines.
//
// `assertSafeRelativePath` is the gate every renderer output must
// pass before it can land in a plan. It enforces:
//
//   * forward-slash separators only (no backslash)
//   * no leading slash (no "absolute" relative)
//   * no `..` segments (no traversal)
//   * no empty segments (no `//`)
//
// `assertWithinRoot` is the apply-side companion that confirms a
// concrete `path` does not escape `targetDir` after symlink and
// absolute resolution.

import { isAbsolute, resolve, sep } from 'node:path';

export class SafePathError extends Error {
  public override readonly name = 'SafePathError';
  public constructor(public readonly code: 'ABSOLUTE' | 'TRAVERSAL' | 'EMPTY' | 'BACKSLASH' | 'OUTSIDE_ROOT', message: string) {
    super(message);
  }
}

export function assertSafeRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new SafePathError('EMPTY', 'relative path empty');
  if (value.includes('\0')) throw new SafePathError('EMPTY', 'NUL in relative path');
  if (value.includes('\\')) throw new SafePathError('BACKSLASH', `backslash in relative path: ${value}`);
  if (value.startsWith('/')) throw new SafePathError('ABSOLUTE', `absolute relative path: ${value}`);
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) throw new SafePathError('EMPTY', `empty segment in path: ${value}`);
    if (segment === '..' || segment === '.') throw new SafePathError('TRAVERSAL', `unsafe segment in path: ${value}`);
  }
  if (segments[segments.length - 1] === '') {
    throw new SafePathError('EMPTY', `trailing slash in path: ${value}`);
  }
  return value;
}

export function assertWithinRoot(rootDir: string, candidate: string): string {
  if (!isAbsolute(rootDir)) throw new SafePathError('ABSOLUTE', `root must be absolute: ${rootDir}`);
  const rootAbs = resolve(rootDir);
  const rootWithSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  const candidateAbs = resolve(candidate);
  if (candidateAbs !== rootAbs && !candidateAbs.startsWith(rootWithSep)) {
    throw new SafePathError('OUTSIDE_ROOT', `path escapes root: ${candidate} not under ${rootDir}`);
  }
  return candidateAbs;
}

export function normaliseRelative(value: string): string {
  return assertSafeRelativePath(value);
}
