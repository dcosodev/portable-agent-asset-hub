import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillService } from '../src/core/service.js';
import { startRest } from '../src/rest/server.js';
import { SkillSdk } from '../src/sdk/client.js';
import { createMcpServer, SkillMcp } from '../src/mcp/server.js';

describe('real REST and MCP smokes', () => {
  it('REST to service to SQLite and compatibility wrapper to SDK to REST', async () => {
    const service = new SkillService({ root: await mkdtemp(join(tmpdir(), 's1-')) });
    const rest = await startRest(service);
    try {
      const sdk = new SkillSdk(rest.url);
      const mcp = new SkillMcp(sdk);
      const version = await mcp.skill_create({ slug: 'e2e', title: 'E2E', body: 'hello' });
      expect(version.version).toBe(1);
      expect((await mcp.skill_get({ slug: 'e2e' })).body).toBe('hello');
      expect(await mcp.skill_search({ q: 'hello' })).toHaveLength(1);
    } finally {
      rest.server.close();
      service.close();
    }
  });

  it('does not expose compatibility REST routes', async () => {
    const service = new SkillService({ root: await mkdtemp(join(tmpdir(), 's1-')) });
    const rest = await startRest(service);
    try {
      expect((await fetch(rest.url.replace('/api/v1', '/api/v2/skills'))).status).toBe(404);
    } finally {
      rest.server.close();
      service.close();
    }
  });

  it('exposes exactly the five official tools over Client and a real MCP transport', async () => {
    const service = new SkillService({ root: await mkdtemp(join(tmpdir(), 's1-')) });
    const rest = await startRest(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 's1-test-client', version: '1.0.0' });
    const server = createMcpServer(new SkillSdk(rest.url));
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'skill_search', 'skill_get', 'skill_create', 'skill_update', 'skill_resource_read',
      ]);
      const created = await client.callTool({ name: 'skill_create', arguments: { slug: 'mcp', title: 'MCP', body: 'transport body' } });
      expect(created.isError).not.toBe(true);
      const resource = await new SkillSdk(rest.url).resourcePut('mcp', 1, 'nested/resource.txt', new TextEncoder().encode('resource body'));
      expect(resource).toBeTruthy();
      const read = await client.callTool({ name: 'skill_resource_read', arguments: { skillId: 'mcp', version: 1, path: 'nested/resource.txt' } });
      expect(read.content).toEqual([{ type: 'text', text: Buffer.from('resource body').toString('base64') }]);
      const updated = await client.callTool({ name: 'skill_update', arguments: { slug: 'mcp', title: 'MCP v2', body: 'updated', expectedVersion: 1 } });
      expect(updated.isError).not.toBe(true);
      const stale = await client.callTool({ name: 'skill_update', arguments: { slug: 'mcp', title: 'bad', body: 'bad', expectedVersion: 1 } });
      expect(stale.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      rest.server.close();
      service.close();
    }
  });
});
