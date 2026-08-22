import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SkillSdk } from '../sdk/client.js';

export function createMcpServer(sdk: SkillSdk): McpServer {
  const server = new McpServer({ name: 'spike-skills', version: '1.0.0' });
  server.tool('skill_search', 'Search head skill versions', { q: z.string().min(1) }, async ({ q }) => ({ content: [{ type: 'text', text: JSON.stringify(await sdk.search(q)) }] }));
  server.tool('skill_get', 'Get a skill head', { slug: z.string().min(1) }, async ({ slug }) => ({ content: [{ type: 'text', text: JSON.stringify(await sdk.get(slug)) }] }));
  server.tool('skill_create', 'Create a skill', { slug: z.string().min(1), title: z.string(), body: z.string() }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await sdk.create(args)) }] }));
  server.tool('skill_update', 'CAS update a skill', { slug: z.string().min(1), title: z.string(), body: z.string(), expectedVersion: z.number().int().positive() }, async ({ slug, title, body, expectedVersion }) => ({ content: [{ type: 'text', text: JSON.stringify(await sdk.update(slug, { slug, title, body }, expectedVersion)) }] }));
  server.tool('skill_resource_read', 'Read a skill resource', { skillId: z.string().min(1), version: z.number().int().positive(), path: z.string().min(1) }, async ({ skillId, version, path }) => ({ content: [{ type: 'text', text: Buffer.from(await sdk.resourceRead(skillId, version, path)).toString('base64') }] }));
  return server;
}

export class SkillMcp {
  public constructor(private readonly sdk: SkillSdk) {}
  public search(args: { q: string }) { return this.sdk.search(args.q); }
  public get(args: { slug: string }) { return this.sdk.get(args.slug); }
  public create(args: { slug: string; title: string; body: string }) { return this.sdk.create(args); }
  public update(args: { slug: string; title: string; body: string; expectedVersion: number }) { return this.sdk.update(args.slug, { slug: args.slug, title: args.title, body: args.body }, args.expectedVersion); }
  public resource_read(args: { skillId: string; version: number; path: string }) { return this.sdk.resourceRead(args.skillId, args.version, args.path); }
  public skill_search(args: { q: string }) { return this.search(args); }
  public skill_get(args: { slug: string }) { return this.get(args); }
  public skill_create(args: { slug: string; title: string; body: string }) { return this.create(args); }
  public skill_update(args: { slug: string; title: string; body: string; expectedVersion: number }) { return this.update(args); }
}
