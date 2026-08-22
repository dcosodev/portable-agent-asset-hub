// packages/mcp/src/rest-transport.ts
//
// Transport that calls the real REST surface. The MCP server never opens
// a database, never reads from disk, never has a "local mode" fallback.
// If the REST base URL is unreachable the call fails with a structured
// transport error — there is no silent fallback.

import type { McpError, RestErrorBody, Transport, TransportRequest, TransportResponse } from './types.js';
import { mapRestErrorToMcp } from './error-mapper.js';

const FORBIDDEN_PATH_CHARS = /\s/;

/**
 * Substitute path parameters into the route template. Supports both
 * `{key}` (the OpenAPI / generator convention) and `:key` (the
 * Express / many REST clients convention) placeholders so the MCP
 * layer interoperates with either style of route declaration. Path
 * parameters come from `request.params` — never from the body, so the
 * request body stays verbatim.
 */
export function substitutePathParams(path: string, params: Record<string, string> | undefined): string {
  if (!params) return path;
  // Substitute {key} placeholders.
  let result = path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`missing path parameter: ${key}`);
    return encodeURIComponent(value);
  });
  // Substitute :key placeholders. We deliberately don't substitute
  // path-segment wildcards like `*` — only `:identifier` is recognised.
  result = result.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`missing path parameter: ${key}`);
    return encodeURIComponent(value);
  });
  return result;
}

function buildQuery(query: Record<string, string> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

function validatePath(path: string): void {
  if (path.length === 0 || !path.startsWith('/')) {
    throw new Error(`invalid path: ${path}`);
  }
  if (path.includes(String.fromCharCode(0)) || FORBIDDEN_PATH_CHARS.test(path)) {
    throw new Error(`invalid path: ${path}`);
  }
}

export class RestTransport {
  readonly #baseUrl: string;
  readonly #bearer: string | undefined;
  readonly #timeoutMs: number;

  public constructor(options: { restBaseUrl: string; bearerToken?: string; timeoutMs?: number }) {
    this.#baseUrl = options.restBaseUrl.replace(/\/+$/, '');
    this.#bearer = options.bearerToken;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  public async send(request: TransportRequest): Promise<TransportResponse> {
    validatePath(request.path);
    // Path params come exclusively from `request.params` — the body is
    // never inspected for placeholders, so the body is forwarded to REST
    // verbatim.
    const path = substitutePathParams(request.path, request.params);
    const url = `${this.#baseUrl}${path}${buildQuery(request.query)}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (request.bearer ?? this.#bearer) headers.authorization = `Bearer ${request.bearer ?? this.#bearer}`;
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    for (const [k, v] of Object.entries(request.headers ?? {})) headers[k.toLowerCase()] = v;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new TransportFailure('transport failed', 503, error);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    const body = text.length === 0 ? null : safeJsonParse(text);
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { respHeaders[key.toLowerCase()] = value; });
    // The status we surface is exactly what the upstream returned — the
    // MCP layer never invents or overwrites it.
    return { status: response.status, headers: respHeaders, body };
  }
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export class TransportFailure extends Error {
  public constructor(message: string, public readonly status: number, public readonly cause?: unknown) {
    super(message);
    this.name = 'TransportFailure';
  }
  public toMcpError(): McpError {
    return mapRestErrorToMcp(null, this.status);
  }
  public toRestErrorBody(): RestErrorBody | null { return null; }
}

/** Convenience helper for tests: build a Transport from a stub. */
export function makeStubTransport(stub: Transport): Transport { return stub; }
