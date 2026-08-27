// packages/mcp/src/server.ts
//
// The MCP stdio server. The transport is JSON-RPC 2.0 over stdin/stdout,
// exactly as the MCP TypeScript SDK expects. We deliberately do not use
// the high-level SDK wrappers because we want to keep the surface
// auditable — every method we handle is named in this file.

import { randomUUID } from 'node:crypto';
import { buildMcpToolInvoker, type McpToolContext, type McpResult, type ToolCatalogEntry, type Transport, RestTransport } from './index.js';
import { buildToolRegistry } from './tool-registry.js';
import { GENERATED_TOOLS } from './generated-tool-metadata.js';
import { computeProcessIdentity, createMcpIdentity } from './identity.js';
import type { ProcessIdentity } from './types.js';
import { filterToolsByCapability } from './capabilities.js';
import type { ActorContext } from '@portable-agent-asset-hub/core';
import { createActorContext } from '@portable-agent-asset-hub/core';

export type McpServerOptions = {
  restBaseUrl: string;
  bearerToken?: string;
  capabilities?: readonly string[];
  actor?: ActorContext;
  transport?: Transport;
  /** When true, the server reads JSON-RPC frames from a custom stream pair. */
  io?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr?: NodeJS.WritableStream };
};

const SERVER_INFO = { name: 'portable-agent-asset-hub-mcp', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

/**
 * Truthful, generic input schema for every tool surfaced via `tools/list`.
 *
 * The MCP layer is a thin facade over REST: the actual per-operation
 * payloads are defined by the OpenAPI contract, not invented here. Every
 * tool accepts the same four optional wrapper fields that `extractArgs`
 * already understands (`params`, `query`, `body`, `headers`); `body`
 * carries the operation-specific payload, `params` carries path
 * placeholders (e.g. `id`), `query` carries URL query parameters, and
 * `headers` carries request headers (CAS `if-match`, `idempotency-key`,
 * etc.). `additionalProperties: true` is preserved so a well-formed
 * tool call that happens to include an extra wrapper field (forward
 * compatibility) is not rejected at the JSON-RPC layer.
 */
const WRAPPER_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    params: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Path parameter overrides keyed by route placeholder name (e.g. { id }).',
    },
    query: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'URL query parameters forwarded to the REST endpoint.',
    },
    body: {
      type: 'object',
      additionalProperties: true,
      description: 'JSON request body matching the OpenAPI operation schema for this tool.',
    },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Request headers (e.g. If-Match for CAS, Idempotency-Key).',
    },
  },
} as const;

export type McpServerHandle = {
  identity: ProcessIdentity;
  stop(): void;
};

export function buildMcpServer(options: McpServerOptions): {
  handle(method: string, params: unknown): Promise<unknown>;
  identity: ProcessIdentity;
  actor: ActorContext;
  capabilities: readonly string[];
} {
  const identity = computeProcessIdentity(process.pid, process.argv);
  const actor = options.actor ?? createActorContext({
    userId: 'usr_mcp',
    agentId: 'agt_mcp',
    role: 'user',
    capabilities: options.capabilities ? [...options.capabilities] : [],
  });
  const granted = options.capabilities ?? actor.capabilities;
  const visible = filterToolsByCapability(GENERATED_TOOLS as readonly ToolCatalogEntry[], granted);
  const invoker = buildMcpToolInvoker({
    catalog: visible,
    transport: options.transport ?? defaultTransport(options),
  });
  return {
    identity,
    actor,
    capabilities: granted,
    async handle(method: string, params: unknown): Promise<unknown> {
      switch (method) {
        case 'initialize': {
          const result = (params as { protocolVersion?: string }) ?? {};
          if (result.protocolVersion && result.protocolVersion !== PROTOCOL_VERSION) {
            return { protocolVersion: PROTOCOL_VERSION, serverInfo: SERVER_INFO, capabilities: { tools: { listChanged: false } } };
          }
          return { protocolVersion: PROTOCOL_VERSION, serverInfo: SERVER_INFO, capabilities: { tools: { listChanged: false } } };
        }
        case 'tools/list': {
          return {
            tools: visible.map((entry) => ({
              name: toolNameFor(entry.operationId),
              description: toolDescription(entry),
              inputSchema: WRAPPER_INPUT_SCHEMA,
            })),
          };
        }
        case 'tools/call': {
          const call = params as { name?: string; arguments?: unknown };
          if (!call || typeof call.name !== 'string') {
            return { content: [{ type: 'text', text: 'invalid tool call' }], isError: true };
          }
          const args = extractArgs(call.arguments);
          const requestId = `req_${randomUUID()}`;
          const context: McpToolContext = { actor, requestId, reason: 'mcp tool call' };
          const result: McpResult = await invoker.invoke({ tool: call.name, args, context });
          if ('error' in result) {
            const body = JSON.stringify({ code: result.error.code, message: result.error.message, status: result.status, request_id: result.error.requestId });
            return { content: [{ type: 'text', text: body }], isError: true };
          }
          return { content: [{ type: 'text', text: JSON.stringify(result.body ?? {}) }] };
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return {};
        default:
          return { content: [{ type: 'text', text: `unknown method: ${method}` }], isError: true };
      }
    },
  };
}

function extractArgs(value: unknown): { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const args: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {};
  if (v.params && typeof v.params === 'object') args.params = v.params as Record<string, string>;
  if (v.query && typeof v.query === 'object') args.query = v.query as Record<string, string>;
  if (v.body !== undefined) args.body = v.body;
  if (v.headers && typeof v.headers === 'object') args.headers = v.headers as Record<string, string>;
  return args;
}

function toolDescription(entry: ToolCatalogEntry): string {
  const specific: Record<string, string> = {
    resolveRetrieval: 'Consulta obligatoriamente el registro canónico antes de ejecutar tareas procedurales, técnicas, operacionales, de configuración, despliegue, debugging, migración o mantenimiento. Si no hay un match suficientemente relevante, continúa con conocimiento general sin inventarlo.',
    resolveSkillGraph: 'Resuelve de forma determinista y acotada las dependencias versionadas de una skill seleccionada; úsala tras discovery o para explicar el contexto estructural requerido.',
    getSkillRelations: 'Obtiene las relaciones declaradas por una versión concreta de skill sin cargar su body.',
    getSkillDependents: 'Obtiene las skills head que dependen de la skill objetivo, respetando scope y permisos.',
    replaceSkillRelations: 'Reemplaza mediante CAS el conjunto completo de relaciones; crea una nueva versión inmutable y nunca muta semántica histórica.',
  };
  return specific[entry.operationId] ?? `REST ${entry.rest.method} ${entry.rest.path} (${entry.safety})`;
}

function toolNameFor(operationId: string): string {
  return operationId === 'getCapabilities' ? 'get_hub_capabilities' : operationId.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/_+/g, '_').toLowerCase();
}

function defaultTransport(options: McpServerOptions): Transport {
  const transport = new RestTransport({ restBaseUrl: options.restBaseUrl, bearerToken: options.bearerToken });
  return (request) => transport.send(request);
}

/**
 * Boot the MCP server bound to process stdio. Frames are newline-delimited
 * JSON. Exits with code 0 on SIGTERM, code 1 on uncaught errors.
 */
export async function startMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
  const stdin = options.io?.stdin ?? process.stdin;
  const stdout = options.io?.stdout ?? process.stdout;
  const stderr = options.io?.stderr ?? process.stderr;
  const server = buildMcpServer(options);
  let buffer = '';
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stdin.pause();
  };
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) void handleFrame(line);
      idx = buffer.indexOf('\n');
    }
  });
  async function handleFrame(line: string): Promise<void> {
    let request: { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown };
    try { request = JSON.parse(line) as typeof request; }
    catch { return; }
    if (!request.method) return;
    try {
      const result = await server.handle(request.method, request.params);
      if (request.id === undefined) return;
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch (error) {
      if (request.id === undefined) return;
      const message = error instanceof Error ? error.message : 'internal error';
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message } }) + '\n');
      stderr.write(`mcp error: ${message}\n`);
    }
  }
  process.once('SIGTERM', () => { stop(); process.exit(0); });
  process.once('SIGINT', () => { stop(); process.exit(0); });
  return { identity: server.identity, stop };
}

export { createMcpIdentity };
export { buildToolRegistry };
