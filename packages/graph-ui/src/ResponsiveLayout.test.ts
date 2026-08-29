import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

function topLevelTrackCount(value: string): number {
  let depth = 0;
  let tracks = 0;
  let inTrack = false;
  for (const character of value.trim()) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (/\s/u.test(character) && depth === 0) {
      if (inTrack) tracks += 1;
      inTrack = false;
    } else {
      inTrack = true;
    }
  }
  return tracks + (inTrack ? 1 : 0);
}

describe('responsive explorer workspace', () => {
  it('keeps one grid track for each of the five workspace children below 1100px', () => {
    const media = css.match(/@media \(max-width: 1100px\) \{([\s\S]+)\}\s*$/u)?.[1];
    expect(media).toBeDefined();

    for (const selector of [
      '.workspace.filters-open.inspector-open',
      '.workspace.filters-open',
      '.workspace.inspector-open',
    ]) {
      const escaped = selector.replaceAll('.', '\\.');
      const columns = media?.match(new RegExp(`${escaped}\\s*\\{[^}]*grid-template-columns:\\s*([^;]+);`, 'u'))?.[1];
      expect(columns, selector).toBeDefined();
      expect(topLevelTrackCount(columns ?? ''), selector).toBe(5);
      const fixedWidth = [...(columns ?? '').matchAll(/\b(\d+)px\b/gu)]
        .reduce((total, match) => total + Number(match[1]), 0);
      expect(fixedWidth, `${selector} fixed width`).toBeLessThanOrEqual(840);
    }
  });
});