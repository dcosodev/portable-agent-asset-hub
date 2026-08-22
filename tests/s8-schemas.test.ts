// tests/s8-schemas.test.ts
//
// Schema contract for S8 manifest v1. The manifest schema lives at
// `packages/materializers/src/manifest.v1.json` (resolved at runtime)
// and is validated with AJV2020 — the same validator the rest of the
// repo uses for schemas/*.v1.json contracts.

import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const schemaPath = join(repoRoot, 'packages/materializers/src/manifest.v1.json');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;

describe('S8 manifest schema', () => {
  it('exists on disk and declares the v1 frozen contract', () => {
    expect(schema).toBeTruthy();
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    for (const required of [
      'runId',
      'snapshotId',
      'harness',
      'profileId',
      'targetRoot',
      'files',
      'generatedAt',
      'rendererVersion',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(properties, required)).toBe(true);
    }
  });

  it('accepts a fixture manifest and rejects missing fields', () => {
    const ajv = new Ajv2020({ strict: true });
    // Register the standard JSON-schema formats (date-time, uri, email,
    // uuid, etc.) so the manifest's `generatedAt: { format: "date-time" }`
    // keyword is actually checked instead of being silently ignored.
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const fixture = {
      runId: 'run_1',
      snapshotId: 'snap_1',
      harness: 'hermes',
      profileId: 'prf_1',
      targetRoot: '/tmp/s8',
      files: [
        {
          relativePath: 'USER.md',
          sha256: createHash('sha256').update('user').digest('hex'),
          bytes: Buffer.from('user').toString('base64'),
          mode: 0o644,
          sourceRef: 'profile:block:user',
        },
      ],
      generatedAt: '2026-08-21T00:00:00.000Z',
      rendererVersion: '0.1.0',
    };
    expect(validate(fixture)).toBe(true);
    const broken = { ...fixture };
    delete (broken as { runId?: string }).runId;
    expect(validate(broken)).toBe(false);
  });
});
