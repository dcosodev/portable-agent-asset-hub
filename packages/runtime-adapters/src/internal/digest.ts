// packages/runtime-adapters/src/internal/digest.ts
//
// SHA-256 over canonicalised manifests. The canonicalisation is a
// strict subset of RFC 8785 (JSON Canonicalization Scheme), tuned
// for our own output so the apply can reproduce the byte stream:
//
//   * Object keys are sorted lexicographically by their UTF-16 code
//     units (which is identical to byte order for ASCII), so the
//     output of `canonicalise` is unique.
//   * Arrays preserve declaration order — they are deterministic in
//     our renderers because every renderer produces a fixed list.
//   * Numbers are emitted via `String(value)`.
//   * Strings are emitted verbatim (UTF-8), with no whitespace
//     collapse — renderers produce a single line each.
//   * Booleans / null are spelled `true` / `false` / `null`.
//   * We never emit the body of USER.md or SOUL.md into the digest.
//     Those bytes are summarised by sha256+size; their content is
//     pinned separately by file digest.

import { createHash } from 'node:crypto';

export type DigestibleFile = {
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
  readonly sourceRef: string;
};

export type DigestibleManifest = {
  readonly harness: string;
  readonly profile: string;
  readonly agentId: string;
  readonly targetDir: string;
  readonly restUrl: string;
  readonly mcpEntry: string;
  readonly wrapperRelativePath: string;
  readonly files: readonly DigestibleFile[];
  readonly descriptor: unknown;
  readonly commandFragments: readonly { label: string; argv: readonly string[]; env: Readonly<Record<string, string>> }[];
};

const ROOT_KEYS = [
  'harness',
  'profile',
  'agentId',
  'targetDir',
  'restUrl',
  'mcpEntry',
  'wrapperRelativePath',
  'files',
  'descriptor',
  'commandFragments',
] as const;

export function canonicalise(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number in canonicalisation: ${value}`);
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalise(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',') + '}';
  }
  throw new Error(`unsupported canonical value type: ${typeof value}`);
}

/**
 * Deterministic manifest digest. The serializer is locked so two
 * previews of the same inputs produce the same digest even if the
 * caller passes them through in a different shape.
 */
export function digestManifest(manifest: DigestibleManifest): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ROOT_KEYS) ordered[key] = (manifest as unknown as Record<string, unknown>)[key];
  const payload = canonicalise(ordered);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
export function fromBytes(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}
