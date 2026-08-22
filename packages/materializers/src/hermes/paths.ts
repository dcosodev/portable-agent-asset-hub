// packages/materializers/src/hermes/paths.ts
//
// Hermes-specific path layout. The plan mandates three materialised
// files at the target root — USER.md, MEMORY.md, SKILL.md — plus the
// manifest itself. Every relative path is fixed by the adapter
// contract so a renderer swap cannot accidentally relocate files.

import type { ManifestFile } from '../contracts.js';
import { HubError, materializeProfile, type Profile } from '@portable-agent-asset-hub/core';
import { createHash } from 'node:crypto';

export const HERMES_FILES = ['USER.md', 'MEMORY.md', 'SKILL.md'] as const;
export type HermesFileName = (typeof HERMES_FILES)[number];

export function isHermesFile(name: string): name is HermesFileName {
  return (HERMES_FILES as readonly string[]).includes(name);
}

function renderBlock(kind: 'USER' | 'MEMORY' | 'SKILL', body: string): Buffer {
  const canonical = body.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
  return Buffer.from(`${kind}\n---\n${canonical}\n`, 'utf8');
}

/**
 * Render a Hermes USER.md from the canonical USER blocks of a profile.
 */
export function renderHermesUser(profile: Profile): Buffer {
  const blocks = profile.blocks
    .filter((block) => block.kind === 'USER')
    .sort((left, right) => left.ordinal - right.ordinal || left.blockId.localeCompare(right.blockId));
  if (blocks.length === 0) {
    return renderBlock('USER', '');
  }
  return Buffer.from(
    blocks.map((block) => renderBlock('USER', block.body).toString('utf8')).join('\n'),
    'utf8',
  );
}

/**
 * Render a Hermes MEMORY.md from the canonical MEMORY blocks. Same
 * canonicalisation rules as Slice 4's `materializeProfile` (LF, no
 * BOM, no trailing CRLF) so byte-identity across processes holds.
 */
export function renderHermesMemory(profile: Profile): Buffer {
  // Reuse the S4 helper so the byte format is identical to a
  // profile-mapped materialisation. Slice 8 ships a Hermes-specific
  // adapter but the byte contract is shared.
  const materialized = materializeProfile(profile);
  return materialized.bytes;
}

/**
 * Render a Hermes SKILL.md. Slice 8 has no skill store yet, so this
 * file is the empty header — Slice 6 already publishes a `skills`
 * route and the S10 cutover will fill SKILL.md from the SDK output.
 * Until then the file is stable and its digest is part of the
 * manifest contract.
 */
export function renderHermesSkill(profile: Profile): Buffer {
  // Stable placeholder so the renderer produces a deterministic file.
  return Buffer.from(
    `SKILL\n---\n# Hermes SKILL\nprofile=${profile.id}\nversion=${profile.version}\n`,
    'utf8',
  );
}

/**
 * Render the three canonical Hermes files. Returns them in a stable
 * order so `digestPlan` is deterministic.
 */
export function renderHermesFiles(profile: Profile): ManifestFile[] {
  const user = renderHermesUser(profile);
  const memory = renderHermesMemory(profile);
  const skill = renderHermesSkill(profile);
  const files: ManifestFile[] = [
    {
      relativePath: 'USER.md',
      sha256: createHash('sha256').update(user).digest('hex'),
      bytes: user,
      mode: 0o644,
      sourceRef: 'profile:user-blocks',
    },
    {
      relativePath: 'MEMORY.md',
      sha256: createHash('sha256').update(memory).digest('hex'),
      bytes: memory,
      mode: 0o644,
      sourceRef: 'profile:memory-blocks',
    },
    {
      relativePath: 'SKILL.md',
      sha256: createHash('sha256').update(skill).digest('hex'),
      bytes: skill,
      mode: 0o644,
      sourceRef: 'profile:skill-header',
    },
  ];
  for (const file of files) {
    if (!file.bytes || file.bytes.length === 0) {
      throw new HubError('VALIDATION', `empty render: ${file.relativePath}`, 500);
    }
  }
  return files;
}
