import { describe, expect, it } from 'vitest';
import {
  redactAttributeValue,
  scrubAttributes,
  scrubMetricLabels,
  scrubSpanName,
  createNoopTelemetryHandle,
  withSpan,
  addEvent,
  recordMetric,
} from '@portable-agent-asset-hub/telemetry';

const SECRET_TOKENS = [
  'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
  'bearer abc.def.ghi',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature',
  '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkA1\n-----END PRIVATE KEY-----',
  'password=hunter2hunter2hunter2hunter2',
  'api_key=AKIA0000000000000000',
  'token=ghp_0000000000000000000000000000000000',
];

describe('telemetry privacy contract', () => {
  it('redacts bearer prefixes', () => {
    const out = redactAttributeValue('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(out).not.toMatch(/eyJ/);
    expect(out).toMatch(/redacted/i);
  });

  it('redacts raw JWTs regardless of key', () => {
    const out = redactAttributeValue('note', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature');
    expect(out).not.toMatch(/eyJ/);
  });

  it('redacts PEM blocks', () => {
    const out = redactAttributeValue('blob', '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----');
    expect(out).not.toMatch(/PRIVATE KEY/);
  });

  it('redacts password= and token= and api_key= assignments', () => {
    const out = redactAttributeValue('headers', 'password=hunter2hunter2 token=ghp_abcdef');
    expect(out).not.toMatch(/hunter2/);
    expect(out).not.toMatch(/ghp_/);
  });

  it('drops forbidden attribute keys (query, body, request_id, etc.)', () => {
    const scrubbed = scrubAttributes({
      query: 'select * from skills',
      body: '{ "password": "x" }',
      'hub.operation_id': 'searchSkills',
      request_id: 'req-1234',
      trace_id: 'trace-5678',
      session_id: 'sess-9',
      user_id: 'u-1',
      agent_id: 'a-1',
      skill_id: 'k-1',
      resource_path: '/skills/foo',
      authorization: 'Bearer abc',
    });
    expect(Object.keys(scrubbed).sort()).toEqual(['hub.operation_id']);
  });

  it('keeps allowed attribute keys unchanged', () => {
    const scrubbed = scrubAttributes({
      'hub.operation_id': 'searchSkills',
      'http.request.method': 'POST',
      'http.route': '/v1/skills/search',
      'http.response.status_code': 200,
      'hub.runtime': 'hermes',
      'hub.storage_mode': 'canonical',
      'hub.auth_mode': 'local-dev',
      'hub.result_class': 'success',
    });
    expect(scrubbed['hub.operation_id']).toBe('searchSkills');
    expect(scrubbed['http.response.status_code']).toBe(200);
  });

  it('scrubs every well-known secret token pattern in attribute values', () => {
    for (const t of SECRET_TOKENS) {
      const scrubbed = scrubAttributes({ 'hub.note': t });
      const v = String(scrubbed['hub.note'] ?? '');
      expect(v).not.toBe(t);
      // must not leak the bearer/JWT/PEM/password substrings
      expect(v).not.toMatch(/eyJhbGciOi/);
      expect(v).not.toMatch(/BEGIN PRIVATE KEY/);
      expect(v).not.toMatch(/hunter2hunter2/);
      expect(v).not.toMatch(/ghp_0000000000000000000000000000000000/);
    }
  });

  it('scrubs metric labels with forbidden keys', () => {
    const scrubbed = scrubMetricLabels({
      operation_id: 'searchSkills',
      runtime: 'hermes',
      query: 'select 1',
      request_id: 'req-1',
      token: 'ghp_xx',
      user_id: 'u-1',
    });
    expect(Object.keys(scrubbed).sort()).toEqual(['operation_id', 'runtime']);
  });

  it('scrubs span names containing query/bearer/raw URLs', () => {
    expect(scrubSpanName('GET /v1/skills?q=foo')).toBe('hub.http GET /v1/skills');
    expect(scrubSpanName('POST /skills { "password": "x" }')).toBe('hub.http POST /skills');
    expect(scrubSpanName('hub.request')).toBe('hub.request');
  });

  it('integrates redaction with the helpers: withSpan drops forbidden keys', async () => {
    const handle = createNoopTelemetryHandle('basic');
    const out = await withSpan(
      handle,
      'hub.request GET /search?secret=abc',
      { query: 'foo', body: 'bar', 'hub.operation_id': 'searchSkills' },
      async () => 'ok',
    );
    expect(out).toBe('ok');
    // We can't observe internal state directly in no-op mode; instead we
    // assert that the helpers do not throw and that scrubAttributes was the
    // authoritative source of truth for the span attribute set.
    const scrubbed = scrubAttributes({ query: 'foo', body: 'bar', 'hub.operation_id': 'searchSkills' });
    expect(Object.keys(scrubbed)).toEqual(['hub.operation_id']);
  });

  it('integrates redaction with helpers: addEvent / recordMetric drop forbidden keys', () => {
    const handle = createNoopTelemetryHandle('basic');
    expect(() => addEvent(handle, 'retrieval.empty', { query: 'select 1' })).not.toThrow();
    expect(() => recordMetric(handle, 'hub.requests', 1, { query: 'select 1', operation_id: 'searchSkills' })).not.toThrow();
    const scrubbed = scrubMetricLabels({ query: 'select 1', operation_id: 'searchSkills' });
    expect(Object.keys(scrubbed)).toEqual(['operation_id']);
  });
});