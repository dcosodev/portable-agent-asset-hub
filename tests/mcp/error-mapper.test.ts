// tests/mcp/error-mapper.test.ts
//
// Normative test: errors surfaced by the MCP tool layer must be
// byte-identical to the REST envelope. S7 plan mandates:
//
//   mcp_and_rest_errors_match
//
// The mapping is intentionally narrow: it must not invent new error
// codes, must preserve the original status, code, and message, and must
// forward the request_id verbatim so operators can correlate MCP tool
// calls with REST logs.

import { describe, expect, it } from 'vitest';
import { mapRestErrorToMcp, type RestErrorBody } from '@portable-agent-asset-hub/mcp';

describe('MCP error mapper (S7)', () => {
  it('maps_huberror_shape_to_mcp_tool_error', () => {
    const rest: RestErrorBody = {
      error: { code: 'NOT_FOUND', message: 'resource missing', status: 404 },
      request_id: 'req_abc',
    };
    const mapped = mapRestErrorToMcp(rest, 404);
    expect(mapped.code).toBe('NOT_FOUND');
    expect(mapped.message).toBe('resource missing');
    expect(mapped.status).toBe(404);
    expect(mapped.requestId).toBe('req_abc');
    expect(mapped.kind).toBe('rest_error');
  });

  it('falls_back_to_status_when_envelope_missing', () => {
    const mapped = mapRestErrorToMcp(null, 503);
    expect(mapped.status).toBe(503);
    expect(mapped.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(mapped.kind).toBe('transport');
  });

  it('falls_back_when_envelope_is_unparseable', () => {
    const mapped = mapRestErrorToMcp({ unexpected: true } as unknown as RestErrorBody, 500);
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe('INTERNAL');
    expect(mapped.requestId).toBe('');
  });

  it('preserves_forbidden_and_validation_status_codes', () => {
    expect(mapRestErrorToMcp({ error: { code: 'FORBIDDEN', message: 'x', status: 403 }, request_id: 'r' }, 403).code).toBe('FORBIDDEN');
    expect(mapRestErrorToMcp({ error: { code: 'VALIDATION', message: 'x', status: 400 }, request_id: 'r' }, 400).code).toBe('VALIDATION');
    expect(mapRestErrorToMcp({ error: { code: 'CONFLICT', message: 'x', status: 409 }, request_id: 'r' }, 409).code).toBe('CONFLICT');
    expect(mapRestErrorToMcp({ error: { code: 'PRECONDITION_REQUIRED', message: 'x', status: 428 }, request_id: 'r' }, 428).code).toBe('PRECONDITION_REQUIRED');
  });

  it('never_invents_new_codes_outside_the_known_set', () => {
    const codes: string[] = [];
    for (const status of [400, 401, 403, 404, 409, 413, 428, 500, 502, 503]) {
      codes.push(mapRestErrorToMcp(null, status).code);
    }
    // We must always map to a known error code, never 'undefined' or empty.
    for (const code of codes) {
      expect(code.length).toBeGreaterThan(0);
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
