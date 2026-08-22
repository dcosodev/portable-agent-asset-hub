import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SkillService } from '../core/service.js';
import type { SkillInput } from '../core/types.js';

async function readBody(request: IncomingMessage): Promise<unknown> { let text = ''; for await (const chunk of request) text += String(chunk); if (!text) throw new Error('INVALID_BODY'); try { return JSON.parse(text) as unknown; } catch { throw new Error('INVALID_JSON'); } }
function input(value: unknown): SkillInput { if (!value || typeof value !== 'object') throw new Error('INVALID_INPUT'); const candidate = value as Record<string, unknown>; if (typeof candidate.slug !== 'string' || !candidate.slug || typeof candidate.title !== 'string' || typeof candidate.body !== 'string') throw new Error('INVALID_INPUT'); return { slug: candidate.slug, title: candidate.title, body: candidate.body }; }
function decode(value: string): string { try { return decodeURIComponent(value); } catch { throw new Error('INVALID_URI'); } }
function send(res: ServerResponse, status: number, value: unknown, type = 'application/json'): void { res.statusCode = status; res.setHeader('content-type', type); res.end(type === 'application/json' ? JSON.stringify(value) : value); }
function errorStatus(error: unknown): number { const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined; const message = error instanceof Error ? error.message : 'INTERNAL_ERROR'; if (code === 'ENOENT' || message === 'NOT_FOUND') return 404; if (['INVALID_BODY', 'INVALID_JSON', 'INVALID_INPUT', 'INVALID_RESOURCE_PATH', 'INVALID_URI'].includes(message)) return 400; if (message === 'STALE_VERSION') return 409; if (message === 'EXPECTED_VERSION_REQUIRED') return 428; return 500; }

export function startRest(service: SkillService, port = 0): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(async (request, response) => {
      try {
        let url: URL; try { url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`); } catch { throw new Error('INVALID_URI'); }
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] !== 'api' || parts[1] !== 'v1') return send(response, 404, { error: 'NOT_FOUND' });
        if (request.method === 'GET' && parts.length === 3 && parts[2] === 'skills') return send(response, 200, service.search(url.searchParams.get('q') ?? ''));
        if (request.method === 'POST' && parts.length === 3 && parts[2] === 'skills') return send(response, 201, service.create(input(await readBody(request))));
        if (parts[2] === 'skills' && parts.length === 4 && request.method === 'GET') { const skill = service.get(decode(parts[3])); return skill ? send(response, 200, skill) : send(response, 404, { error: 'NOT_FOUND' }); }
        if (parts[2] === 'skills' && parts.length === 4 && request.method === 'PUT') { const body = await readBody(request); if (!body || typeof body !== 'object') throw new Error('INVALID_INPUT'); const record = body as Record<string, unknown>; if (typeof record.expectedVersion !== 'number') throw new Error('EXPECTED_VERSION_REQUIRED'); return send(response, 200, service.update(decode(parts[3]), input(record.input), record.expectedVersion)); }
        if (request.method === 'GET' && parts.length === 3 && parts[2] === 'resources') { const skillId = url.searchParams.get('skillId'); const version = Number(url.searchParams.get('version')); const path = url.searchParams.get('path'); if (!skillId || !Number.isInteger(version) || version < 1 || !path) throw new Error('INVALID_INPUT'); return send(response, 200, await service.resourceRead(skillId, version, path), 'application/octet-stream'); }
        if (request.method === 'PUT' && parts.length >= 6 && parts[2] === 'resources') { const skillId = decode(parts[3]); const version = Number(parts[4]); const path = parts.slice(5).map(decode).join('/'); if (!Number.isInteger(version) || version < 1) throw new Error('INVALID_INPUT'); let data = ''; for await (const chunk of request) data += String(chunk); return send(response, 201, await service.resourcePut(skillId, version, path, new TextEncoder().encode(data))); }
        return send(response, 404, { error: 'NOT_FOUND' });
      } catch (error) { send(response, errorStatus(error), { error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }); }
    });
    server.listen(port, '127.0.0.1', () => { const address = server.address(); const actualPort = typeof address === 'object' && address ? address.port : port; resolve({ server, url: `http://127.0.0.1:${actualPort}/api/v1` }); });
  });
}
