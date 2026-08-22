import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../dist/src/core/service.js';
import { startRest } from '../dist/src/rest/server.js';
import { SkillSdk } from '../dist/src/sdk/client.js';
import { createMcpServer } from '../dist/src/mcp/server.js';
const root = await mkdtemp(join(tmpdir(), 's1-protocol-'));
const service = new SkillService({ root });
const rest = await startRest(service);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'protocol-smoke', version: '1.0.0' });
const server = createMcpServer(new SkillSdk(rest.url));
try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  if (names.join(',') !== 'skill_search,skill_get,skill_create,skill_update,skill_resource_read') throw new Error(`unexpected tools: ${names.join(',')}`);
  const created = await client.callTool({ name: 'skill_create', arguments: { slug: 'smoke', title: 'Smoke', body: 'body' } });
  if (created.isError) throw new Error('create failed');
  console.log(JSON.stringify({ protocol: 'mcp-client-inmemory', tools: names, create: 'PASS' }));
} finally {
  await client.close();
  await server.close();
  rest.server.close();
  service.close();
  await rm(root, { recursive: true, force: true });
}
