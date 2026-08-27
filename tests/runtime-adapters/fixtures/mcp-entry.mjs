#!/usr/bin/env node
// tests/runtime-adapters/fixtures/mcp-entry.mjs
//
// A minimal MCP stdio server fixture used by the FASE 4 descriptor
// tests. Reads JSON-RPC requests line-by-line from stdin, replies
// to `initialize` and `tools/list` with the canonical
// agent-memory tool surface used by every harness.
//
// This file is *not* part of the production surface; tests must
// only invoke it through the runtime-adapters wrapper, never
// directly.

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.length === 0) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    respond(request);
  }
});
process.stdin.on('end', () => process.exit(0));

function respond(request) {
  const id = request?.id ?? 0;
  if (request?.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'agent-memory-test-fixture', version: '0.0.0' },
        capabilities: { tools: {} },
      },
    });
    return;
  }
  if (request?.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'search_skills',
            description: 'fixture: list skills',
            inputSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'] },
          },
          {
            name: 'get_skill',
            description: 'fixture: get a skill by id',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, scope: { type: 'string' } }, required: ['id', 'scope'] },
          },
        ],
      },
    });
    return;
  }
  write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
