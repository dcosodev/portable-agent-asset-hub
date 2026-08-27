// packages/mcp/src/tool-invoker.ts
//
// The MCP tool invoker. For every tool call:
//   1. Look up the operation in the registry.
//   2. Verify the actor holds the required capability.
//   3. Substitute path parameters and forward the call to REST.
//   4. Translate the REST envelope (or transport failure) into an MCP
//      result.
//
// The invoker is the single funnel for all tool calls; the MCP server
// hands raw JSON-RPC requests to it and renders the response. This
// keeps the parity test, the stdio smoke test, and the production path
// on the same code.

import type {
  McpError,
  McpResult,
  McpToolInvocation,
  McpToolInvoker,
  ToolCatalogEntry,
  ToolRegistry,
  Transport,
  TransportRequest,
} from './types.js';
import { actorMayInvoke } from './capabilities.js';
import { mapRestErrorToMcp } from './error-mapper.js';
import { stripModelIdentityHeaders } from './identity.js';
import { substitutePathParams } from './rest-transport.js';

export type McpToolInvokerOptions = {
  catalog: readonly ToolCatalogEntry[];
  transport: Transport;
  /** Optional override for the registry lookup. */
  registry?: ToolRegistry;
};

function lookupEntry(toolName: string, registry: ToolRegistry, catalog: readonly ToolCatalogEntry[]): ToolCatalogEntry | undefined {
  // Tool names arrive in two forms: the operationId verbatim (e.g.
  // "createMemory") and the JSON-RPC snake_case form (e.g.
  // "create_memory"). The registry indexes by both, so we normalise the
  // input to snake_case and look it up. The verbatim operationId is
  // also accepted for direct callers that want to skip the conversion.
  const snakeCase = toToolName(toolName);
  return registry.byOperationId.get(toolName)
    ?? registry.byToolName.get(snakeCase)
    ?? registry.byToolName.get(toolName)
    ?? catalog.find((entry) => entry.operationId === toolName || toToolName(entry.operationId) === snakeCase);
}

function toToolName(operationId: string): string {
  // listMemoryBlocks -> list_memory_blocks
  return operationId === 'getCapabilities' ? 'get_hub_capabilities' : operationId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function notFound(toolName: string, requestId: string): McpResult {
  return {
    status: 404,
    error: {
      kind: 'not_found',
      code: 'NOT_FOUND',
      message: `tool not found: ${toolName}`,
      status: 404,
      requestId,
    },
  };
}

function forbidden(toolName: string, capability: string, requestId: string): McpResult {
  return {
    status: 403,
    error: {
      kind: 'capability',
      code: 'FORBIDDEN',
      message: `capability denied: ${capability} for tool ${toolName}`,
      status: 403,
      requestId,
    },
  };
}

/**
 * Build the header set we forward to REST. Three sources are merged
 * (later sources never overwrite earlier ones):
 *   1. The scope / correlation headers derived from `context`
 *      (`x-request-id`, `x-mcp-reason`).
 *   2. The CAS / idempotency / reason headers supplied via
 *      `args.headers` (these are caller-supplied and may override the
 *      defaults — that is intentional, the model decides what CAS
 *      value to forward).
 *   3. The model-supplied headers are stripped of any
 *      identity-override key (`x-mcp-*`) before merging.
 */
function buildForwardedHeaders(
  context: McpToolInvocation['context'],
  args: McpToolInvocation['args'],
): Record<string, string> {
  const scope: Record<string, string> = {
    'x-request-id': context.requestId,
    'x-mcp-reason': context.reason,
  };
  // The CAS / idempotency-key / reason headers may arrive under a few
  // casings; we lower-case keys when merging into the transport so the
  // caller doesn't have to.
  const callerHeaders = stripModelIdentityHeaders(args.headers ?? {});
  const merged: Record<string, string> = { ...scope };
  for (const [k, v] of Object.entries(callerHeaders)) {
    merged[k.toLowerCase()] = v;
  }
  return merged;
}

export function buildMcpToolInvoker(options: McpToolInvokerOptions): McpToolInvoker {
  const catalog = options.catalog;
  const transport = options.transport;
  const registry = options.registry ?? buildRegistryFromCatalog(catalog);
  return {
    async invoke(invocation: McpToolInvocation): Promise<McpResult> {
      const { tool, args, context } = invocation;
      const entry = lookupEntry(tool, registry, catalog);
      if (!entry) return notFound(tool, context.requestId);
      if (!actorMayInvoke(entry, context.actor.capabilities)) {
        return forbidden(tool, entry.capability, context.requestId);
      }
      const forwardedHeaders = buildForwardedHeaders(context, args);
      // Path params come from args.params — kept separate from the body
      // so the body remains the request payload verbatim. We resolve
      // the path template here so the transport receives an already-
      // substituted path; this keeps the parity test honest (it uses a
      // stub transport that records the resolved path verbatim).
      const path = substitutePathParams(entry.rest.path, args.params);
      const request: TransportRequest = {
        method: entry.rest.method,
        path,
        query: args.query,
        body: args.body,
        params: args.params,
        headers: forwardedHeaders,
      };
      try {
        const response = await transport(request);
        const requestId = response.headers['x-request-id'] ?? context.requestId;
        if (response.status >= 400) {
          const error: McpError = mapRestErrorToMcp(response.body, response.status);
          if (!error.requestId) Object.assign(error, { requestId });
          // Status is whatever the transport returned — we never invent
          // a status code, we just propagate the one REST gave us.
          return { status: response.status, error };
        }
        return { status: response.status, body: response.body, requestId };
      } catch (failure) {
        const error: McpError = mapRestErrorToMcp(null, 503);
        error.message = `transport failure: ${(failure as Error).message ?? 'unknown'}`;
        return { status: 503, error };
      }
    },
  };
}

function buildRegistryFromCatalog(catalog: readonly ToolCatalogEntry[]): ToolRegistry {
  const byOperationId = new Map<string, ToolCatalogEntry>();
  const byToolName = new Map<string, ToolCatalogEntry>();
  for (const entry of catalog) {
    byOperationId.set(entry.operationId, entry);
    byToolName.set(toolNameForOperation(entry.operationId), entry);
  }
  return { byOperationId, byToolName };
}

function toolNameForOperation(operationId: string): string {
  return toToolName(operationId);
}

export { buildRegistryFromCatalog };
