import { describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { SkillService } from '../src/core/service.js';

function service() { return new SkillService({ root: `/tmp/spike-skills-test-${Date.now()}-${Math.random()}` }); }

describe('S1 skill vertical slice', () => {
  it('skill_create_produces_v1', async () => {
    const instance = service();
    try {
      const result = instance.create({ slug: 'demo', title: 'Demo', body: 'portable skill' });
      expect(result.version).toBe(1);
      expect(result.head).toBe(true);
      expect(result.body).toBe('portable skill');
    } finally {
      const root = instance.resources.root.replace(/\/resources$/, '');
      instance.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
