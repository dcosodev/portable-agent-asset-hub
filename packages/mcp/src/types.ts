// packages/mcp/src/types.ts
//
// Shared types for the MCP package. The shapes here mirror the contract
// declared by `schemas/mcp-capabilities.v1.json` and the OpenAPI
// `x-mcp.*` extensions.

export type McpSafety = 'safe' | 'mutating' | 'destructive' | 'diagnostic';

export type ToolCatalogEntry = {
  /** OpenAPI operationId — also the canonical REST dispatcher key. */
  operationId: string;
  /** Capability the operator must grant for the tool to be visible. */
  capability: string;
  /** Coarse safety classification. Drives default refusal for destructive tools. */
  safety: McpSafety;
  /** REST binding. */
  rest: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string };
  /** Whether the operation requires an If-Match header. */
  cas: boolean;
  /** Whether the operation is idempotent and safe to retry. */
  idempotent: boolean;
};

export type ToolRegistry = {
  byOperationId: Map<string, ToolCatalogEntry>;
  byToolName: Map<string, ToolCatalogEntry>;
};

export type RestErrorBody = {
  error: { code: string; message: string; status: number };
  /** Optional — REST surfaces are allowed to omit it. */
  request_id?: string;
};

export type McpErrorKind = 'rest_error' | 'transport' | 'capability' | 'not_found' | 'invalid';

export type McpError = {
  kind: McpErrorKind;
  code: string;
  message: string;
  status: number;
  requestId: string;
};

export type McpOk = {
  status: number;
  body: unknown;
  requestId: string;
};

export type McpResult = McpOk | { status: number; error: McpError };

export type TransportRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Path parameters substituted into `:key` or `{key}` placeholders. */
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  bearer?: string;
};

export type TransportResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export type McpToolContext = {
  actor: import('@portable-agent-asset-hub/core').ActorContext;
  requestId: string;
  reason: string;
};

export type McpToolInvocation = {
  tool: string;
  args: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
  };
  context: McpToolContext;
};

export type McpToolInvoker = {
  invoke(invocation: McpToolInvocation): Promise<McpResult>;
};

export type ProcessIdentity = {
  pid: number;
  argvDigest: string;
  bootId: string;
  startedAt: string;
};

export type McpIdentityDescriptor = {
  kind: 'mcp-process';
  pid: number;
  argvDigest: string;
  bootId: string;
  startedAt: string;
};

/** Tool metadata emitted by the generator and consumed at startup. */
export type GeneratedToolMetadata = {
  generator: string;
  version: string;
  source: string;
  generatedAt: string;
  tools: ToolCatalogEntry[];
};
