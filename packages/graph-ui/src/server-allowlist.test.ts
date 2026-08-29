// packages/graph-ui/src/server-allowlist.test.ts
//
// The BFF is read-mostly: it forwards a small, exact allowlist of governed
// relation mutations and refuses everything else. These tests pin the
// allowlist against a stub upstream that echoes back what it received, so a
// path or header that silently stops being forwarded fails here rather than
// in the browser. LAN mode, which refuses the whole allowlist, is covered in
// `server-lan.test.ts` because it needs a real private interface to bind.

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startGraphUi } from '../server';

type Echo = { method: string; path: string; ifMatch?: string; body: string };

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return; }
      closers.push(() => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())));
      resolve(address.port);
    });
  });
}

async function upstream(): Promise<number> {
  return listen(createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const echo: Echo = { method: req.method ?? '', path: req.url ?? '', ifMatch: req.headers['if-match'] as string | undefined, body: Buffer.concat(chunks).toString('utf8') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(echo));
  }));
}

async function bff(env: Record<string, string>): Promise<number> {
  const restPort = await upstream();
  const port = 41500 + Math.floor(Math.random() * 2000);
  const server = await startGraphUi({ GRAPH_UI_PORT: String(port), GRAPH_UI_REST_URL: `http://127.0.0.1:${restPort}`, ...env });
  closers.push(() => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())));
  return port;
}

async function post(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': '*' }, body: JSON.stringify({ pairKeys: ['a::b'] }) });
}

describe('Graph UI BFF mutation allowlist', () => {
  it.each([
    ['/api/v1/skill-relation-proposals'],
    ['/api/v1/skill-relation-proposals/apply'],
    ['/api/v1/skill-relation-proposals/apply-preview'],
    ['/api/v1/skill-relation-proposals/discover'],
    ['/api/v1/skill-relation-proposals/prop_1/approve'],
    ['/api/v1/skill-relation-candidates/explicit/impact'],
    ['/api/v1/skill-relation-candidates/explicit/stage'],
  ])('forwards the governed mutation %s', async (path) => {
    const port = await bff({ GRAPH_UI_HOST: '127.0.0.1' });
    const response = await post(port, path);
    expect(response.status).toBe(200);
    const echo = await response.json() as Echo;
    expect(echo).toMatchObject({ method: 'POST', path, ifMatch: '*' });
    expect(JSON.parse(echo.body)).toEqual({ pairKeys: ['a::b'] });
  });

  it.each([
    ['/api/v1/skill-relation-candidates/explicit'],
    ['/api/v1/memories'],
    ['/api/v1/skill-relation-proposals/reconcile-canonical-duplicates'],
    ['/api/v1/skills/deploy/resources'],
    ['/api/v1/skill-relation-candidates/explicit/impact/../../../memories'],
  ])('refuses the ungoverned mutation %s', async (path) => {
    const port = await bff({ GRAPH_UI_HOST: '127.0.0.1' });
    const response = await post(port, path);
    expect(response.status).toBe(405);
  });
});
