import { createHash } from 'node:crypto';
import type { Profile } from '../profiles/types.js';

export type MaterializedProfile = { bytes: Buffer; digest: string };

export function materializeProfile(profile: Profile): MaterializedProfile {
  const blocks = [...profile.blocks].sort(
    (left, right) => left.ordinal - right.ordinal || left.blockId.localeCompare(right.blockId),
  );
  const text = blocks.length === 0
    ? '---\n'
    : blocks.map((block) => {
      const body = block.body.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
      return `<!-- ${block.kind} ${block.blockId} ordinal=${block.ordinal} -->\n${body}\n`;
    }).join('');
  const bytes = Buffer.from(text, 'utf8');
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}
