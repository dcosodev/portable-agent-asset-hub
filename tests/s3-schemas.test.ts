import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const schema = (name: string) => JSON.parse(readFileSync(join(root, 'schemas', name), 'utf8')) as object;
const scope = { ownerUserId: 'usr_schema', agentId: 'agt_schema' };
const event = { id: 'evt_schema', kind: 'observation', scope, scopeKey: 'fixture', payload: { ok: true }, requestId: 'request', provenance: { sourceEventIds: ['evt_source'] }, createdAt: '2026-08-20T00:00:00.000Z' };
const memory = { id: 'mem_schema', kind: 'fact', scope, scopeKey: 'fixture', lifecycle: 'active', confidence: 0.5, importance: 0.5, sourceEventIds: ['evt_schema'], version: 1, content: { ok: true }, redactionSummary: [], createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z' };
const provenance = { sourceEventIds: ['evt_schema'] };

function validators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return {
    event: ajv.compile(schema('event.v1.json')),
    memory: ajv.compile(schema('memory.v1.json')),
    provenance: ajv.compile(schema('provenance.v1.json')),
  };
}

describe('S3 AJV2020 public schemas', () => {
  it('valid event, memory, and provenance fixtures pass', () => {
    const validate = validators();
    expect(validate.event(event)).toBe(true);
    expect(validate.memory(memory)).toBe(true);
    expect(validate.provenance(provenance)).toBe(true);
  });

  it('invalid id, scope, range, lifecycle, missing, and additional properties fail', () => {
    const validate = validators();
    const cases: Array<[keyof ReturnType<typeof validators>, object]> = [
      ['event', { ...event, id: 'bad' }],
      ['event', { ...event, scope: { ownerUserId: 'bad', agentId: 'agt_schema' } }],
      ['event', { ...event, extra: true }],
      ['memory', { ...memory, id: 'bad' }],
      ['memory', { ...memory, scope: { ownerUserId: 'usr_schema' } }],
      ['memory', { ...memory, confidence: 2 }],
      ['memory', { ...memory, lifecycle: 'invalid' }],
      ['memory', { ...memory, missing: undefined }],
      ['memory', { ...memory, extra: true }],
      ['provenance', { sourceEventIds: [] }],
      ['provenance', { sourceEventIds: ['bad'] }],
      ['provenance', { sourceEventIds: ['evt_schema'], extra: true }],
    ];
    for (const [name, fixture] of cases) expect(validate[name](fixture)).toBe(false);
    const missing = { ...memory } as Record<string, unknown>;
    delete missing.content;
    expect(validate.memory(missing)).toBe(false);
  });
});
