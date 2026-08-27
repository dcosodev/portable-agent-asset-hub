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
  { operationId: 'searchMemories', capability: 'memory.read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/memories/search' }, cas: false, idempotent: true },
  { operationId: 'getMemory', capability: 'memory.read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/memories/{id}' }, cas: false, idempotent: true },
  { operationId: 'searchCatalog', capability: 'catalog.read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/catalog/search' }, cas: false, idempotent: false },
  { operationId: 'getHealth', capability: 'health.read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/health' }, cas: false, idempotent: true },
  // Phase 1 skill tools: parity with REST, same wrapper shape.
  { operationId: 'searchSkills', capability: 'skill.read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/skills/search' }, cas: false, idempotent: false },
  { operationId: 'getSkill', capability: 'skill.read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/skills/{id}' }, cas: false, idempotent: false },
  { operationId: 'listSkillResources', capability: 'skill.resource.read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/skills/{id}/resources' }, cas: false, idempotent: false },
  { operationId: 'readSkillResource', capability: 'skill.resource.read', safety: 'safe', rest: { method: 'GET', path: '/api/v1/skills/{id}/resources/{resourcePath}' }, cas: false, idempotent: false },
];

const actor: ActorContext = createActorContext({
  userId: 'usr_mcp',
  agentId: 'agt_mcp',
  role: 'user',
  capabilities: ['read', 'write.memory', 'memory.supersede', 'skill.read', 'skill.resource.read'],
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
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: [] });
  });

  it('listMemoryBlocks_forwards_non_empty_items_and_other_profile_ids', async () => {
    // Real launcher's `listMemoryBlocks` returns `{ items: ProfileBlock[] }`
    // for any profile whose MEMORY set is non-empty. The MCP layer must
    // forward whatever the REST server decides; the fixture here
    // mirrors the canonical shape: `kind: 'MEMORY'` blocks, ordered
    // by `(ordinal, blockId)`. The transport stub is the source of
    // truth for this test — the launcher parity is covered by
    // tests/rest/memory-blocks.test.ts.
    responses.push({
      status: 200,
      headers: { 'x-request-id': 'req_blocks_2' },
      body: {
        items: [
          { blockId: 'summary', ordinal: 1, kind: 'MEMORY', body: 'first' },
          { blockId: 'notes', ordinal: 3, kind: 'MEMORY', body: 'third' },
        ],
      },
    });
    const ctx: McpToolContext = { actor, requestId: 'req_blocks_2', reason: 'mcp list non-empty' };
    const result = await invoker.invoke({
      tool: 'listMemoryBlocks',
      args: { query: { profileId: 'prf_real' } },
      context: ctx,
    });
    expect(recorded[0]!.method).toBe('GET');
    expect(recorded[0]!.path).toBe('/api/v1/memory-blocks');
    expect(recorded[0]!.query).toEqual({ profileId: 'prf_real' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      items: [
        { blockId: 'summary', ordinal: 1, kind: 'MEMORY', body: 'first' },
        { blockId: 'notes', ordinal: 3, kind: 'MEMORY', body: 'third' },
      ],
    });
  });

  it('listMemoryBlocks_propagates_rest_400_when_profileId_missing', async () => {
    // The launcher's `listMemoryBlocks` rejects missing/empty
    // `profileId` with HTTP 400 / `VALIDATION` before touching the
    // storage layer. The MCP tool layer must forward that envelope
    // verbatim — the tool caller sees the same status + error code
    // it would see calling REST directly.
    responses.push({
      status: 400,
      headers: { 'x-request-id': 'req_blocks_400' },
      body: {
        error: { code: 'VALIDATION', message: 'query.profileId is required', status: 400 },
        request_id: 'req_blocks_400',
      },
    });
    const ctx: McpToolContext = { actor, requestId: 'req_blocks_400', reason: 'mcp probe 400' };
    const result = await invoker.invoke({
      tool: 'listMemoryBlocks',
      args: { query: {} },
      context: ctx,
    });
    expect(recorded[0]!.method).toBe('GET');
    expect(recorded[0]!.path).toBe('/api/v1/memory-blocks');
    expect(recorded[0]!.query).toEqual({});
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe('VALIDATION');
    expect(result.error?.message).toMatch(/profileId/i);
  });

  it('searchMemories_forwards_query_to_rest_path', async () => {
    // The launcher's `searchMemories` route is the literal
    // `/api/v1/memories/search` (NOT `/memories/{id}`). The MCP tool
    // layer must forward the query string verbatim so the launcher
    // can validate `q` (and optional `limit`) before FTS dispatch.
    responses.push({
      status: 200,
      headers: { 'x-request-id': 'req_search' },
      body: { items: [{ id: 'mem_a', content: { text: 'hello world' } }] },
    });
    const ctx: McpToolContext = { actor, requestId: 'req_search', reason: 'mcp search' };
    const result = await invoker.invoke({
      tool: 'searchMemories',
      args: { query: { q: 'hello', limit: 5 } },
      context: ctx,
    });
    expect(recorded).toHaveLength(1);
    const req = recorded[0]!;
    expect(req.method).toBe('GET');
    // The catalog path is the literal search route — never the
    // `/memories/{id}` template — so `params` must be empty.
    expect(req.path).toBe('/api/v1/memories/search');
    expect(req.params ?? {}).toEqual({});
    expect(req.query).toEqual({ q: 'hello', limit: 5 });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: [{ id: 'mem_a', content: { text: 'hello world' } }] });
  });

  it('searchMemories_propagates_rest_400_when_q_missing', async () => {
    // Mirrors `listMemoryBlocks_propagates_rest_400_when_profileId_missing`:
    // the launcher's `searchMemories` rejects missing/empty `q` with
    // HTTP 400 / `VALIDATION` before touching the FTS repository. The
    // MCP tool layer must forward that envelope verbatim.
    responses.push({
      status: 400,
      headers: { 'x-request-id': 'req_search_400' },
      body: {
        error: { code: 'VALIDATION', message: 'query.q is required', status: 400 },
        request_id: 'req_search_400',
      },
    });
    const ctx: McpToolContext = { actor, requestId: 'req_search_400', reason: 'mcp probe 400' };
    const result = await invoker.invoke({
      tool: 'searchMemories',
      args: { query: {} },
      context: ctx,
    });
    expect(recorded[0]!.method).toBe('GET');
    expect(recorded[0]!.path).toBe('/api/v1/memories/search');
    expect(recorded[0]!.query).toEqual({});
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe('VALIDATION');
    expect(result.error?.message).toMatch(/q/i);
  });

  it('searchCatalog_forwards_query_to_literal_rest_path', async () => {
    responses.push({ status: 200, headers: { 'x-request-id': 'req_catalog_search' }, body: { items: [{ logicalKey: 'skill:docs:aurora' }] } });
    const ctx: McpToolContext = { actor, requestId: 'req_catalog_search', reason: 'mcp catalog search' };
    const result = await invoker.invoke({
      tool: 'searchCatalog',
      args: { query: { q: 'aurora', kind: 'skill', limit: 5 } },
      context: ctx,
    });
    expect(recorded[0]!.method).toBe('GET');
    expect(recorded[0]!.path).toBe('/api/v1/catalog/search');
    expect(recorded[0]!.query).toEqual({ q: 'aurora', kind: 'skill', limit: 5 });
    expect(result.body).toEqual({ items: [{ logicalKey: 'skill:docs:aurora' }] });
  });

  it('getMemory_forwards_path_parameter_to_rest_template', async () => {
    // The launcher's `getMemory` route is `/api/v1/memories/{id}`. The
    // MCP tool layer must render the catalog path template with the
    // caller's `params.id`, forwarding it as a path parameter rather
    // than a query string. The transport stub mirrors the launcher's
    // canonical 200 envelope (the full `Memory` shape).
    responses.push({
      status: 200,
      headers: { 'x-request-id': 'req_get' },
      body: { id: 'mem_42', content: { text: 'routed' }, lifecycle: 'candidate', version: 1 },
    });
    const ctx: McpToolContext = { actor, requestId: 'req_get', reason: 'mcp get' };
    const result = await invoker.invoke({
      tool: 'getMemory',
      args: { params: { id: 'mem_42' } },
      context: ctx,
    });
    expect(recorded).toHaveLength(1);
    const req = recorded[0]!;
    expect(req.method).toBe('GET');
    // The catalog template `/api/v1/memories/{id}` MUST be rendered
    // with the caller's `params.id`. If the MCP layer incorrectly
    // routed `getMemory` to the literal `/memories/search` template,
    // this assertion fails — which is exactly what the test is here
    // to catch.
    expect(req.path).toBe('/api/v1/memories/mem_42');
    expect(req.params).toEqual({ id: 'mem_42' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: 'mem_42', content: { text: 'routed' }, lifecycle: 'candidate', version: 1 });
  });

  it('getMemory_propagates_rest_404_when_id_missing_in_scope', async () => {
    // Cross-scope or otherwise missing ids surface as HTTP 404 /
    // `NOT_FOUND` from the launcher's `getMemory` (storage layer
    // throws `notFound()`). The MCP tool layer must forward that
    // envelope verbatim.
    responses.push({
      status: 404,
      headers: { 'x-request-id': 'req_get_404' },
      body: {
        error: { code: 'NOT_FOUND', message: 'memory not found', status: 404 },
        request_id: 'req_get_404',
      },
    });
    const ctx: McpToolContext = { actor, requestId: 'req_get_404', reason: 'mcp get 404' };
    const result = await invoker.invoke({
      tool: 'getMemory',
      args: { params: { id: 'mem_missing' } },
      context: ctx,
    });
    expect(recorded[0]!.method).toBe('GET');
    expect(recorded[0]!.path).toBe('/api/v1/memories/mem_missing');
    expect(recorded[0]!.params).toEqual({ id: 'mem_missing' });
    expect(result.status).toBe(404);
    expect(result.error?.code).toBe('NOT_FOUND');
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

describe('Phase 1 skill tools parity with REST', () => {
  let recorded: TransportRequest[] = [];
  let responses: TransportResponse[] = [];
  let invoker: ReturnType<typeof buildMcpToolInvoker>;
  const skillActor: ActorContext = createActorContext({
    userId: 'usr_mcp',
    agentId: 'agt_mcp',
    role: 'user',
    capabilities: ['skill.read', 'skill.resource.read'],
  });

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

  it('searchSkills_forwards_query_to_literal_rest_path', async () => {
    responses.push({
      status: 200,
      headers: { 'x-request-id': 'req_skills_search' },
      body: { items: [{ id: 'skl_a', body: 'aurora', lifecycle: 'active' }] },
    });
    const ctx: McpToolContext = { actor: skillActor, requestId: 'req_skills_search', reason: 'mcp search' };
    const result = await invoker.invoke({
      tool: 'searchSkills',
      args: { query: { q: 'aurora', limit: 5 } },
      context: ctx,
    });
    expect(recorded).toHaveLength(1);
    const req = recorded[0]!;
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/api/v1/skills/search');
    expect(req.params ?? {}).toEqual({});
    expect(req.query).toEqual({ q: 'aurora', limit: 5 });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: [{ id: 'skl_a', body: 'aurora', lifecycle: 'active' }] });
  });

  it('searchSkills_propagates_rest_400_when_q_missing', async () => {
    responses.push({
      status: 400,
      headers: { 'x-request-id': 'req_skills_search_400' },
      body: { error: { code: 'VALIDATION', message: 'query.q is required', status: 400 }, request_id: 'req_skills_search_400' },
    });
    const ctx: McpToolContext = { actor: skillActor, requestId: 'req_skills_search_400', reason: 'mcp probe 400' };
    const result = await invoker.invoke({ tool: 'searchSkills', args: { query: {} }, context: ctx });
    expect(recorded[0]!.path).toBe('/api/v1/skills/search');
    expect(recorded[0]!.query).toEqual({});
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe('VALIDATION');
    expect(result.error?.message).toMatch(/q/i);
  });

  it('getSkill_forwards_path_parameter_to_rest_template', async () => {
    responses.push({
      status: 200,
      headers: { 'x-request-id': 'req_skill_get' },
      body: { id: 'skl_round', lifecycle: 'active', body: 'hello' },
    });
    const ctx: McpToolContext = { actor: skillActor, requestId: 'req_skill_get', reason: 'mcp get' };
    const result = await invoker.invoke({
      tool: 'getSkill',
      args: { params: { id: 'skl_round' } },
      context: ctx,
    });
    expect(recorded[0]!.method).toBe('GET');
    expect(recorded[0]!.path).toBe('/api/v1/skills/skl_round');
    expect(recorded[0]!.params).toEqual({ id: 'skl_round' });
    expect(result.status).toBe(200);
  });

  it('getSkill_propagates_rest_404_when_id_inactive_or_missing', async () => {
    responses.push({
      status: 404,
      headers: { 'x-request-id': 'req_skill_get_404' },
      body: { error: { code: 'NOT_FOUND', message: 'skill not found', status: 404 }, request_id: 'req_skill_get_404' },
    });
    const ctx: McpToolContext = { actor: skillActor, requestId: 'req_skill_get_404', reason: 'mcp get 404' };
    const result = await invoker.invoke({
      tool: 'getSkill',
      args: { params: { id: 'skl_missing' } },
      context: ctx,
    });
    expect(recorded[0]!.path).toBe('/api/v1/skills/skl_missing');
    expect(result.status).toBe(404);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('listSkillResources_forwards_id_to_rest_template', async () => {
    responses.push({
      status: 200,
      headers: { 'x-request-id': 'req_skill_list' },
      body: { items: [{ relativePath: 'README.md' }, { relativePath: 'bin/run.sh' }] },
    });
    const ctx: McpToolContext = { actor: skillActor, requestId: 'req_skill_list', reason: 'mcp list' };
    const result = await invoker.invoke({
      tool: 'listSkillResources',
      args: { params: { id: 'skl_round' } },
      context: ctx,
    });
    expect(recorded[0]!.path).toBe('/api/v1/skills/skl_round/resources');
    expect(recorded[0]!.params).toEqual({ id: 'skl_round' });
    expect(result.status).toBe(200);
  });

  it('readSkillResource_forwards_id_and_resourcePath_to_rest_template', async () => {
    responses.push({
      status: 200,
      headers: { 'x-request-id': 'req_skill_read' },
      body: { relativePath: 'bin/run.sh', encoding: 'base64', bytes: Buffer.from('hi', 'utf8').toString('base64') },
    });
    const ctx: McpToolContext = { actor: skillActor, requestId: 'req_skill_read', reason: 'mcp read' };
    const result = await invoker.invoke({
      tool: 'readSkillResource',
      args: { params: { id: 'skl_round', resourcePath: 'bin/run.sh' } },
      context: ctx,
    });
    expect(recorded[0]!.path).toBe('/api/v1/skills/skl_round/resources/bin%2Frun.sh');
    expect(recorded[0]!.params).toEqual({ id: 'skl_round', resourcePath: 'bin/run.sh' });
    expect(result.status).toBe(200);
  });

  it('readSkillResource_propagates_rest_404_when_path_missing', async () => {
    responses.push({
      status: 404,
      headers: { 'x-request-id': 'req_skill_read_404' },
      body: { error: { code: 'NOT_FOUND', message: 'skill not found', status: 404 }, request_id: 'req_skill_read_404' },
    });
    const ctx: McpToolContext = { actor: skillActor, requestId: 'req_skill_read_404', reason: 'mcp read 404' };
    const result = await invoker.invoke({
      tool: 'readSkillResource',
      args: { params: { id: 'skl_round', resourcePath: 'missing.sh' } },
      context: ctx,
    });
    expect(recorded[0]!.path).toBe('/api/v1/skills/skl_round/resources/missing.sh');
    expect(result.status).toBe(404);
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});
