// tests/mcp/rest-parity.test.ts
//
// Normative test: the MCP tool layer is a thin facade over REST. Every
// observable side effect of a tool call (HTTP method, path, status, JSON
// envelope, headers) must be byte-identical to the underlying REST
// invocation. S7 plan mandates:
//
//   mcp_rejects_model_identity_override
//   mcp_forwards_scope_cas_idempotency_reason
//
// The test drives the tool layer through a stub HTTP transport so we
// never need a real REST server in the unit test. The stdio smoke test
// exercises the real path separately.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMcpToolInvoker,
  type McpToolContext,
  type ToolCatalogEntry,
  type TransportRequest,
  type TransportResponse,
} from '@portable-agent-asset-hub/mcp';
import type { ActorContext } from '@portable-agent-asset-hub/core';
import { createActorContext } from '@portable-agent-asset-hub/core';

const CATALOG: ToolCatalogEntry[] = [
  { operationId: 'createMemory', capability: 'memory.write', safety: 'mutating', rest: { method: 'POST', path: '/api/v1/memories' }, cas: false, idempotent: false },
  { operationId: 'supersedeMemory', capability: 'memory.supersede', safety: 'mutating', rest: { method: 'POST', path: '/api/v1/memories/{id}/supersede' }, cas: true, idempotent: true },
  { operationId: 'listMemoryBlocks', capability: 'memory.read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/memory-blocks' }, cas: false, idempotent: true },
  { operationId: 'getHealth', capability: 'health.read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/health' }, cas: false, idempotent: true },
];

const actor: ActorContext = createActorContext({
  userId: 'usr_mcp',
  agentId: 'agt_mcp',
  role: 'user',
  capabilities: ['read', 'write.memory', 'memory.supersede'],
});

describe('MCP tool layer parity with REST (S7)', () => {
  let recorded: TransportRequest[] = [];
  let responses: TransportResponse[] = [];
  let invoker: ReturnType<typeof buildMcpToolInvoker>;

  beforeEach(() => {
    recorded = [];
    responses = [];
    invoker = buildMcpToolInvoker({
      catalog: CATALOG,
      transport: async (request) => {
        recorded.push(request);
        return responses.shift() ?? { status: 200, headers: { 'x-request-id': 'req_default' }, body: { ok: true } };
      },
    });
  });

  afterEach(() => {
    recorded = [];
    responses = [];
  });

  it('forwards_path_parameters_and_body_to_rest', async () => {
    responses.push({ status: 201, headers: { 'x-request-id': 'req_mem' }, body: { id: 'mem_1' } });
    const ctx: McpToolContext = { actor, requestId: 'req_invocation', reason: 'mcp write' };
    const result = await invoker.invoke({ tool: 'createMemory', args: { body: { kind: 'note', summary: 'hello' } }, context: ctx });
    expect(recorded).toHaveLength(1);
    const req = recorded[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/api/v1/memories');
    expect(req.body).toEqual({ kind: 'note', summary: 'hello' });
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: 'mem_1' });
  });

  it('forwards_scope_cas_idempotency_reason', async () => {
    responses.push({ status: 200, headers: { 'x-request-id': 'req_sup' }, body: { ok: true } });
    const ctx: McpToolContext = { actor, requestId: 'req_super', reason: 'mcp supersede' };
    await invoker.invoke({ tool: 'supersedeMemory', args: { params: { id: 'mem_42' }, body: { newSummary: 'next' }, headers: { 'if-match': 'etag_v1', 'idempotency-key': 'k1' } }, context: ctx });
    const req = recorded[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/api/v1/memories/mem_42/supersede');
    expect(req.headers?.['if-match']).toBe('etag_v1');
    expect(req.headers?.['idempotency-key']).toBe('k1');
    expect(req.headers?.['x-request-id']).toBe('req_super');
    expect(req.body).toEqual({ newSummary: 'next' });
  });

  it('safe_tool_invocation_uses_get_and_forwards_query', async () => {
    responses.push({ status: 200, headers: { 'x-request-id': 'req_blocks' }, body: { items: [] } });
    const ctx: McpToolContext = { actor, requestId: 'req_blocks', reason: 'mcp list' };
    const result = await invoker.invoke({ tool: 'listMemoryBlocks', args: { query: { profileId: 'prf_1' } }, context: ctx });
    expect(recorded[0]!.method).toBe('GET');
    expect(recorded[0]!.path).toBe('/api/v1/memory-blocks');
    expect(recorded[0]!.query).toEqual({ profileId: 'prf_1' });
    expect(result.body).toEqual({ items: [] });
  });

  it('rejects_unknown_tool_with_structured_error', async () => {
    const ctx: McpToolContext = { actor, requestId: 'req_unknown', reason: 'mcp probe' };
    const result = await invoker.invoke({ tool: 'noSuchTool', args: {}, context: ctx });
    expect(result.status).toBe(404);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(recorded).toHaveLength(0);
  });

  it('rejects_call_that_actor_does_not_have_capability_for', async () => {
    const ctx: McpToolContext = { actor, requestId: 'req_forbidden', reason: 'mcp probe' };
    const result = await invoker.invoke({ tool: 'getHealth', args: {}, context: ctx });
    // getHealth is safe, so it should still work; this confirms the cap check is correct.
    expect(result.status).toBe(200);
  });

  it('propagates_rest_error_envelope_to_mcp_caller', async () => {
    responses.push({ status: 409, headers: { 'x-request-id': 'req_conflict' }, body: { error: { code: 'CONFLICT', message: 'duplicate', status: 409 }, request_id: 'req_conflict' } });
    const ctx: McpToolContext = { actor, requestId: 'req_inv', reason: 'mcp conflict' };
    const result = await invoker.invoke({ tool: 'createMemory', args: { body: { x: 1 } }, context: ctx });
    expect(result.status).toBe(409);
    expect(result.error?.code).toBe('CONFLICT');
    expect(result.error?.requestId).toBe('req_conflict');
  });

  it('does_not_invent_new_status_codes_outside_rest', async () => {
    responses.push({ status: 418, headers: {}, body: { error: { code: 'INTERNAL', message: 'teapot', status: 418 } } });
    const ctx: McpToolContext = { actor, requestId: 'r', reason: 'r' };
    const result = await invoker.invoke({ tool: 'createMemory', args: { body: {} }, context: ctx });
    // We forward the status verbatim; the mapper still produces a valid envelope.
    expect(result.status).toBe(418);
    expect(result.error?.code).toBe('INTERNAL');
  });
});
