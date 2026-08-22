// tests/s9-schemas.test.ts
//
// Schema contract extensions for S9 OpenClaw. The S9 schema is the
// SAME frozen v1 manifest contract as S8 (`packages/materializers/src/manifest.v1.json`)
// — only the renderer-version stamp and the harness enum value
// (`openclaw`) differ. These tests verify:
//
//   1. The existing manifest schema accepts an `openclaw` harness
//      value (it must: the schema enum already lists both).
//   2. The OpenClaw plugin manifest schema (`openclaw.plugin.schema.json`)
//      is on disk, declares the v1 contract, and round-trips a
//      frozen fixture.

import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const manifestSchemaPath = join(repoRoot, 'packages/materializers/src/manifest.v1.json');
const pluginSchemaPath = join(repoRoot, 'integrations/openclaw/openclaw.plugin.schema.json');

const manifestSchema = JSON.parse(readFileSync(manifestSchemaPath, 'utf8')) as Record<string, unknown>;

describe('S9 manifest schema parity', () => {
  it('accepts harness="openclaw" in the v1 manifest contract', () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(manifestSchema);
    const fixture = {
      runId: 'run_oc1',
      snapshotId: 'snap_oc1',
      harness: 'openclaw',
      profileId: 'prf_oc1',
      targetRoot: '/tmp/openclaw',
      files: [
        {
          relativePath: 'agents/agt/user.md',
          sha256: 'a'.repeat(64),
          bytes: Buffer.from('user').toString('base64'),
          mode: 0o644,
          sourceRef: 'profile:block:user',
        },
      ],
      generatedAt: '2026-08-21T00:00:00.000Z',
      rendererVersion: '0.1.0',
    };
    expect(validate(fixture)).toBe(true);
  });

  it('rejects harness values outside the {hermes, openclaw} enum', () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(manifestSchema);
    const fixture = {
      runId: 'run_oc2',
      snapshotId: 'snap_oc2',
      harness: 'tencent',
      profileId: 'prf_oc2',
      targetRoot: '/tmp/openclaw',
      files: [],
      generatedAt: '2026-08-21T00:00:00.000Z',
      rendererVersion: '0.1.0',
    };
    expect(validate(fixture)).toBe(false);
  });
});

describe('S9 openclaw plugin manifest schema', () => {
  it('exists on disk and declares the v1 contract', () => {
    expect(existsSync(pluginSchemaPath)).toBe(true);
    const schema = JSON.parse(readFileSync(pluginSchemaPath, 'utf8')) as Record<string, unknown>;
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    for (const required of [
      'kind',
      'name',
      'version',
      'snapshotId',
      'profileId',
      'rendererVersion',
      'entry',
      'commands',
      'requiredCapabilities',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(properties, required)).toBe(true);
    }
  });

  it('accepts a frozen fixture and rejects missing fields', () => {
    const schema = JSON.parse(readFileSync(pluginSchemaPath, 'utf8')) as Record<string, unknown>;
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const fixture = {
      kind: 'openclaw',
      name: 'pah-openclaw',
      version: '0.1.0',
      snapshotId: 'snap_oc_schema',
      profileId: 'prf_oc_schema',
      rendererVersion: '0.1.0',
      entry: 'index.js',
      commands: [
        { name: 'init', description: 'init the openclaw state dir' },
        { name: 'recall', description: 'recall assets' },
      ],
      requiredCapabilities: ['openclaw.assets.read'],
    };
    expect(validate(fixture)).toBe(true);
    const broken = { ...fixture };
    delete (broken as { snapshotId?: string }).snapshotId;
    expect(validate(broken)).toBe(false);
  });
});
