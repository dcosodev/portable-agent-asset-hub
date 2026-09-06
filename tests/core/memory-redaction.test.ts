// tests/core/memory-redaction.test.ts
//
// Regression coverage for packages/core/src/memory/redaction.ts.
// `redact()` had no test file at all before this: the by-key
// full-field redaction compared a candidate key against a Set of
// no-separator spellings ('accesstoken', 'refreshtoken', 'privatekey')
// via an exact-match `.has(key.toLowerCase())`, so the far more common
// real-world spellings — 'access_token', 'refresh_token',
// 'private_key', 'client_secret' — fell through unredacted, because
// `MemoryRepository` calls `redact(input.content)` as the only
// sanitization step before persisting content_json.

import { describe, expect, it } from 'vitest';
import { redact } from '@portable-agent-asset-hub/core';

describe('redact: by-key full-field redaction', () => {
  it.each([
    ['access_token', 'ya29.RAW_OAUTH_TOKEN'],
    ['accessToken', 'ya29.RAW_OAUTH_TOKEN'],
    ['access-token', 'ya29.RAW_OAUTH_TOKEN'],
    ['refresh_token', '1//RAW_REFRESH_TOKEN'],
    ['private_key', '-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----'],
    ['client_secret', 'GOCSPX-raw-client-secret'],
    ['api_key', 'sk-raw-api-key'],
  ])('redacts a bare %s field regardless of separator style', (key, secretValue) => {
    const { value, summary } = redact({ [key]: secretValue });
    expect((value as Record<string, unknown>)[key]).toBe('[REDACTED:secret]');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('redacts nested access_token fields inside arrays and objects', () => {
    const { value } = redact({
      credentials: [{ access_token: 'ya29.NESTED_TOKEN', label: 'ok' }],
    });
    const nested = (value as { credentials: Array<Record<string, unknown>> }).credentials[0];
    expect(nested.access_token).toBe('[REDACTED:secret]');
    expect(nested.label).toBe('ok');
  });

  it('leaves ordinary fields untouched', () => {
    const { value, summary } = redact({ title: 'hello world', count: 3 });
    expect(value).toEqual({ title: 'hello world', count: 3 });
    expect(summary).toEqual([]);
  });
});

describe('redact: content-regex fallback patterns', () => {
  it('redacts a Bearer token embedded in free text', () => {
    const { value, summary } = redact({ note: 'call it with Bearer abc123.def456' });
    expect((value as { note: string }).note).toContain('[REDACTED:bearer]');
    expect(summary).toContain('bearer');
  });

  it('redacts a PEM private key block embedded in free text', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----';
    const { value } = redact({ note: `key follows:\n${pem}` });
    expect((value as { note: string }).note).not.toContain('MII...');
  });
});
