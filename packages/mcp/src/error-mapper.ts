// packages/mcp/src/error-mapper.ts
//
// The MCP tool layer must surface REST errors byte-identically. This
// module is the single place where HubError-shaped envelopes are
// converted to the MCP-side error shape. It never invents new codes —
// it falls back to a small, well-known set when the envelope is missing
// or unparseable.

import type { McpError, RestErrorBody } from './types.js';

const FALLBACK_BY_STATUS: Record<number, { code: string; message: string }> = {
  400: { code: 'VALIDATION', message: 'bad request' },
  401: { code: 'UNAUTHENTICATED', message: 'bearer required' },
  403: { code: 'FORBIDDEN', message: 'capability denied' },
  404: { code: 'NOT_FOUND', message: 'resource not found' },
  409: { code: 'CONFLICT', message: 'conflict' },
  413: { code: 'VALIDATION', message: 'request body too large' },
  428: { code: 'PRECONDITION_REQUIRED', message: 'if-match required' },
  500: { code: 'INTERNAL', message: 'internal error' },
  502: { code: 'UPSTREAM_UNAVAILABLE', message: 'upstream error' },
  503: { code: 'UPSTREAM_UNAVAILABLE', message: 'service unavailable' },
};

function fallbackFor(status: number): { code: string; message: string } {
  if (status in FALLBACK_BY_STATUS) return FALLBACK_BY_STATUS[status]!;
  if (status >= 500) return { code: 'UPSTREAM_UNAVAILABLE', message: 'upstream error' };
  if (status >= 400) return { code: 'VALIDATION', message: 'request rejected' };
  return { code: 'INTERNAL', message: 'unexpected error' };
}

/**
 * Recognise a HubError-shaped envelope. The canonical shape is
 *   { error: { code, message, status }, request_id: string }
 *
 * We are deliberately tolerant: a request_id is NOT required for the
 * envelope to be valid — REST surfaces occasionally omit it (proxies,
 * edge caches, custom error handlers). The status / code / message
 * triple is the authoritative part, so as long as those three are
 * present and well-typed we surface the envelope verbatim.
 */
function isRestErrorBody(value: unknown): value is RestErrorBody {
  if (!value || typeof value !== 'object') return false;
  const v = value as { error?: unknown; request_id?: unknown };
  if (!v.error || typeof v.error !== 'object') return false;
  const err = v.error as { code?: unknown; message?: unknown; status?: unknown };
  if (typeof err.code !== 'string') return false;
  if (typeof err.message !== 'string') return false;
  if (typeof err.status !== 'number') return false;
  // request_id is optional. When present it must be a string; when
  // absent we still treat the envelope as valid and leave requestId
  // empty in the MCP error (the caller can correlate via x-request-id
  // instead).
  if (v.request_id !== undefined && typeof v.request_id !== 'string') return false;
  return true;
}

export function mapRestErrorToMcp(body: unknown, status: number): McpError {
  if (isRestErrorBody(body)) {
    // request_id may be undefined on the wire — surface an empty
    // string so the McpError type contract holds. The caller is
    // responsible for overriding with x-request-id when present.
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    return {
      kind: 'rest_error',
      code: body.error.code,
      message: body.error.message,
      status: body.error.status,
      requestId,
    };
  }
  const fallback = fallbackFor(status);
  return {
    kind: 'transport',
    code: fallback.code,
    message: fallback.message,
    status,
    requestId: '',
  };
}
