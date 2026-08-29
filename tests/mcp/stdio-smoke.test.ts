// tests/mcp/stdio-smoke.test.ts
//
// Normative test: an MCP stdio client can complete the handshake against
// a real REST server (in-process) and a real MCP server (in-process).
// S7 plan mandates:
//
//   mcp_stdio_smoke_against_real_rest
//
// We launch the MCP server as a child process bound to stdio, point it at
// an in-process REST server, and verify the tool list, tool call, and
// error envelope are correct end-to-end. The whole interaction is real
// JSON-RPC over real stdio pipes — no in-memory shortcut.
//
// The child process imports the COMPILED artifact at
// `dist/packages/mcp/server.js`. The repo's `package.json` runs the
// build (`pnpm build`) before tests via the `pretest` hook, so by the
// time this test executes the compiled server is on disk. The test
// fails fast with a clear error if the compiled artifact is missing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { listen, type RestHub } from '@portable-agent-asset-hub/rest';
import { HubError, createActorContext, type ActorContext } from '@portable-agent-asset-hub/core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
// The compiled MCP server entry — this is what production stdio clients
// import, and what this test must exercise to stay honest about
// runtime behaviour. Falling back to the TypeScript source would let a
// `tsx`-style shortcut mask build/dependency regressions.
const serverEntry = join(repoRoot, 'dist/packages/mcp/server.js');
// The compiled server imports its workspace dependencies by bare
// specifier. Node's ESM resolver walks up from the *importing* file
// (i.e. `dist/packages/mcp/server.js`), only checking `node_modules`
// directories at each ancestor — not arbitrary subdirectories — and the
// pnpm links live at `packages/mcp/node_modules/`, outside the dist tree.
// The package's build step therefore runs
// `scripts/sync-workspace-deps.mjs mcp`, which mirrors them into
// `dist/packages/mcp/node_modules/@portable-agent-asset-hub/`. This test
// relies on `pnpm build` having run rather than installing its own links.

const fixtures = {
  health: { ok: true },
  status: { ok: true, service: 'portable-agent-asset-hub' },
  memory: { id: 'mem_stdio' },
  conflict: { error: { code: 'CONFLICT', message: 'stdio conflict', status: 409 }, request_id: 'req_stdio_conflict' },
};

const actor: ActorContext = createActorContext({
  userId: 'usr_stdio',
  agentId: 'agt_stdio',
  role: 'user',
  capabilities: ['read', 'write.memory'],
});

let base: string;
let server: Awaited<ReturnType<typeof listen>>;
let child: ChildProcessWithoutNullStreams | undefined;
let mcpEntry = '';
let mcpEntryDir = '';

beforeAll(async () => {
  if (!existsSync(serverEntry)) {
    throw new Error(
      `compiled MCP server missing at ${serverEntry}; run \`pnpm build\` before the test suite (pretest hook handles this).`,
    );
  }
  // Boot the REST server in the parent process so the MCP child can talk to it.
  server = await listen({
    host: '127.0.0.1',
    port: 0,
    hub: {
      dispatch: ((operation: string) => {
        if (operation === 'getHealth') return fixtures.health;
        if (operation === 'createMemory') return fixtures.memory;
        if (operation === 'supersedeMemory') throw new HubError('CONFLICT', 'stdio conflict', 409);
        return null;
      }) satisfies RestHub['dispatch'],
    },
    localMode: true,
    localActor: actor,
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;


  // Materialise a tiny ESM entry that re-exports the compiled server.
  // The shim exists so the child can be configured per-test (base URL,
  // bearer token, capability set) without rebuilding the package. The
  // shim itself uses an absolute specifier to import the compiled
  // server, so its location does not affect bare-specifier resolution —
  // the bare import happens inside `dist/packages/mcp/server.js` and
  // resolves via the links the build mirrored into the dist tree. The temp
  // directory is tracked so `afterAll` can wipe both the entry file and
  // the directory it lives in — leaving the parent `.tmp-s7-mcp-*`
  // directory behind would litter the repo root and trip `pnpm lint`.
  const dir = mkdtempSync(join(repoRoot, '.tmp-s7-mcp-'));
  mcpEntryDir = dir;
  mcpEntry = join(dir, 'server.mjs');
  writeFileSync(mcpEntry, [
    `import { startMcpServer } from ${JSON.stringify(resolve(serverEntry))};`,
    `startMcpServer({ restBaseUrl: ${JSON.stringify(base)}, bearerToken: 'stdio-token', capabilities: ['read', 'write.memory'] }).catch((error) => { console.error('mcp boot failed', error); process.exit(2); });`,
  ].join('\n'));
});

afterAll(async () => {
  if (child && !child.killed) child.kill('SIGKILL');
  if (server) await new Promise<void>((res) => server.close(() => res()));
  // Wipe the per-run shim directory created by `mkdtempSync` (which
  // would otherwise linger in the repo root as `.tmp-s7-mcp-*`).
  if (mcpEntryDir) rmSync(mcpEntryDir, { force: true, recursive: true });
});

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function sendRpc(child: ChildProcessWithoutNullStreams, request: object): Promise<JsonRpcResponse> {
  child.stdin.write(JSON.stringify(request) + '\n');
  const [line] = (await once(child.stdout, 'data')) as [Buffer];
  return JSON.parse(line.toString('utf8').trim()) as JsonRpcResponse;
}

describe('MCP stdio smoke against real REST (S7)', () => {
  it('mcp_stdio_smoke_against_real_rest', async () => {
    child = spawn(process.execPath, [mcpEntry], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const initialize = await sendRpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's7-stdio-smoke', version: '0.0.1' } } });
    expect(initialize.error).toBeUndefined();
    expect((initialize.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe('portable-agent-asset-hub-mcp');

    const initialized = await sendRpc(child, { jsonrpc: '2.0', id: 2, method: 'notifications/initialized' });
    // Notifications may not return a result; some implementations echo
    // null. Either way we should not get a structured error.
    expect(initialized.error ?? null).toBeNull();

    const tools = await sendRpc(child, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const toolList = (tools.result as { tools: Array<{ name: string; description?: string; inputSchema?: { type?: string } }> }).tools;
    const toolNames = toolList.map((t) => t.name);
    expect(toolNames).toContain('get_health');
    expect(toolNames).toContain('create_memory');
    expect(toolNames).toContain('supersede_memory');
    expect(toolNames).toContain('get_skill_relations');
    expect(toolNames).toContain('get_skill_dependents');
    expect(toolNames).toContain('resolve_skill_graph');
    expect(toolNames).toContain('resolve_retrieval');
    const retrievalTool = toolList.find((tool) => tool.name === 'resolve_retrieval');
    expect(retrievalTool?.description).toContain('obligatoriamente');
    expect(retrievalTool?.inputSchema?.type).toBe('object');
    // `forget_memory` and `apply_materialization` are not exercised by this
    // smoke. Whether they are visible depends on the actor's granted
    // capabilities — `write.memory` unlocks `forget_memory` per
    // `packages/mcp/src/capabilities.ts` (memory.* is a write-verb
    // namespace), and `apply_materialization` requires
    // `admin.materialize` which this fixture does not grant. The negative
    // assertion is intentionally omitted here; visibility for each tool
    // family is covered by tests/mcp/capabilities.test.ts and the
    // schema-match drift detector rather than by this end-to-end JSON-RPC
    // handshake check.

    const call = await sendRpc(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_memory', arguments: { body: { kind: 'note', summary: 'stdio' } } } });
    expect(call.error).toBeUndefined();
    const content = (call.result as { content: Array<{ type: string; text?: string }> }).content;
    expect(content[0]!.type).toBe('text');
    const parsed = JSON.parse(content[0]!.text ?? '{}') as { id?: string };
    expect(parsed.id).toBe('mem_stdio');

    const conflict = await sendRpc(child, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'supersede_memory', arguments: { params: { id: 'mem_x' }, body: {}, headers: { 'if-match': '"0"' } } } });
    expect(conflict.error).toBeUndefined();
    const conflictContent = (conflict.result as { content: Array<{ type: string; text?: string }>; isError?: boolean }).content;
    expect(conflictContent[0]!.type).toBe('text');
    const conflictBody = JSON.parse(conflictContent[0]!.text ?? '{}') as { code?: string; status?: number };
    expect(conflictBody.code).toBe('CONFLICT');
    expect(conflictBody.status).toBe(409);

    child.kill('SIGTERM');
  }, 30_000);
});
