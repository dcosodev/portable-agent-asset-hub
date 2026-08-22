import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../dist/src/core/service.js';
import { startRest } from '../dist/src/rest/server.js';
const root = await mkdtemp(join(tmpdir(), 's1-stdio-'));
const service = new SkillService({ root });
const rest = await startRest(service);
const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/src/mcp/stdio.js'], env: { ...process.env, SPIKE_SKILLS_REST_URL: rest.url } });
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  if (names.join(',') !== 'skill_search,skill_get,skill_create,skill_update,skill_resource_read') throw new Error(`unexpected tools: ${names.join(',')}`);
  console.log(JSON.stringify({ protocol: 'mcp-stdio', tools: names, transport: 'PASS' }));
} finally {
  await client.close();
  rest.server.close();
  service.close();
  await rm(root, { recursive: true, force: true });
}
