import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ActorContext } from '@portable-agent-asset-hub/core';
import { HubError } from '@portable-agent-asset-hub/core';
import { healthRoutes } from './routes/health.js';
import { adminRoutes } from './routes/admin.js';
import { identityRoutes } from './routes/identities.js';
import { profileRoutes } from './routes/profiles.js';
import { memoryBlockRoutes } from './routes/memory-blocks.js';
import { memoryRoutes } from './routes/memories.js';
import { skillRoutes } from './routes/skills.js';
import { catalogRoutes } from './routes/catalog.js';
import { syncRoutes } from './routes/sync.js';
import { materializationRoutes } from './routes/materializations.js';
import { eventRoutes } from './routes/events.js';

export type AuthVerifier = (token: string) => ActorContext | null;
export type RestHub = {
  doctor?: () => unknown;
  dispatch?: (operationId: string, input: { body: unknown; params: Record<string,string>; query: Record<string,string>; actor: ActorContext; requestId: string }) => unknown | Promise<unknown>;
};
export type RestOptions = {
  hub: RestHub;
  verifier?: AuthVerifier;
  localMode?: boolean;
  localActor?: ActorContext;
  maxBodyBytes?: number;
  host?: string;
  port?: number;
};

const routes: Array<{ method: string; pattern: RegExp; operationId: string; cas: boolean }> = [
  ...healthRoutes,
  ...adminRoutes,
  ...identityRoutes,
  ...profileRoutes,
  ...memoryBlockRoutes,
  ...memoryRoutes,
  ...skillRoutes,
  ...catalogRoutes,
  ...syncRoutes,
  ...materializationRoutes,
  ...eventRoutes,
];

function requestId(req: IncomingMessage): string {
  const value = req.headers['x-request-id'];
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}
function loopback(host: string): boolean { return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '::ffff:127.0.0.1'; }
function send(res: ServerResponse, status: number, body: unknown, id: string): void {
  const payload = JSON.stringify(status >= 400 ? { ...(body as Record<string, unknown>), request_id: id } : body);
  res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('x-request-id', id); res.end(payload);
}
function fail(res: ServerResponse, error: unknown, id: string): void {
  if (error instanceof HubError) return send(res, error.status, { error: { code: error.code, message: error.message, status: error.status } }, id);
  send(res, 500, { error: { code: 'INTERNAL', message: 'internal error', status: 500 } }, id);
}
async function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += part.length; if (bytes > max) throw new HubError('VALIDATION', 'request body too large', 413); chunks.push(part); }
  if (!bytes) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new HubError('VALIDATION', 'malformed JSON', 400); }
}
export function createApp(options: RestOptions) {
  const max = options.maxBodyBytes ?? 1024 * 1024;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const id = requestId(req); const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes.find((candidate) => candidate.method === req.method && candidate.pattern.test(url.pathname));
    if (!route) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'route not found', status: 404 } }, id);
    const peer = req.socket.remoteAddress ?? '';
    const bearer = req.headers.authorization;
    let actor: ActorContext | undefined;
    if (options.localMode && loopback(peer)) actor = options.localActor;
    else {
      if (!bearer?.startsWith('Bearer ') || !options.verifier) return send(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'bearer required', status: 401 } }, id);
      actor = options.verifier(bearer.slice(7)) ?? undefined;
      if (!actor) return send(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'invalid bearer', status: 401 } }, id);
    }
    if (route.cas && !req.headers['if-match'] && req.method !== 'GET') return send(res, 428, { error: { code: 'PRECONDITION_REQUIRED', message: 'If-Match required', status: 428 } }, id);
    try {
      const body = req.method === 'GET' ? undefined : await readBody(req, max);
      if (route.operationId === 'getHealth') return send(res, 200, { ok: true }, id);
      if (route.operationId === 'getStatus') return send(res, 200, { ok: true, service: 'portable-agent-asset-hub' }, id);
      if (route.operationId === 'getDoctor') return send(res, 200, options.hub.doctor?.() ?? { ok: true }, id);
      if (!options.hub.dispatch || !actor) throw new HubError('INTERNAL', 'operation unavailable', 501);
      const matches = route.pattern.exec(url.pathname) ?? [];
      const params: Record<string,string> = {}; if (matches[1]) params.id = decodeURIComponent(matches[1]);
      const result = await options.hub.dispatch(route.operationId, { body, params, query: Object.fromEntries(url.searchParams), actor, requestId: id });
      if (result === undefined) throw new HubError('INTERNAL', 'operation returned no response', 500);
      return send(res, route.method === 'POST' && route.operationId.startsWith('create') ? 201 : 200, result, id);
    } catch (error) { return fail(res, error, id); }
  };
}
export function createRestServer(options: RestOptions): Server { return createServer(createApp(options)); }
export async function listen(options: RestOptions): Promise<Server> {
  const host = options.host ?? '127.0.0.1';
  if (!loopback(host) && (!options.verifier || options.localMode)) throw new Error('non-loopback requires bearer verifier and localMode=false');
  const server = createRestServer(options);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, host, () => resolve()); });
  return server;
}
