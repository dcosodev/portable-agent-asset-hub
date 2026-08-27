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
import { relationProposalRoutes } from './routes/relation-proposals.js';
import { explicitRelationRoutes } from './routes/explicit-relations.js';
import type { HubDatabaseResolution } from '@portable-agent-asset-hub/core';

/**
 * The declared operation surface, as literal types.
 *
 * Every route module except `explicit-relations` is declared `as const`,
 * so its operation ids are inferred. `explicitRelationRoutes` carries
 * handlers and is typed `Route[]`, so its three ids are spelled out here
 * instead. `OperationId` is the union of both, and it is what
 * `RestHub.dispatch` accepts — a typo in a dispatcher is a type error,
 * not a 501 at runtime.
 */
type DeclaredRoute =
  | (typeof healthRoutes)[number]
  | (typeof adminRoutes)[number]
  | (typeof identityRoutes)[number]
  | (typeof profileRoutes)[number]
  | (typeof memoryBlockRoutes)[number]
  | (typeof memoryRoutes)[number]
  | (typeof skillRoutes)[number]
  | (typeof catalogRoutes)[number]
  | (typeof syncRoutes)[number]
  | (typeof materializationRoutes)[number]
  | (typeof eventRoutes)[number]
  | (typeof relationProposalRoutes)[number];

type ExplicitOperationId =
  | 'listExplicitSkillRelationCandidates'
  | 'previewExplicitSkillRelationCandidatesImpact'
  | 'stageExplicitSkillRelationCandidates';

export type OperationId = DeclaredRoute['operationId'] | ExplicitOperationId;

/**
 * Schema version advertised by `getStatus` and `getCapabilities`.
 *
 * This is the wire contract's view of the migration sequence and MUST
 * track `packages/storage-sqlite/src/migrations/runner.ts`, which
 * refuses to run unless the on-disk sequence is continuous 0001-0019.
 * It is a single named constant here so that bumping the schema is one
 * edit in this package rather than two inline literals.
 */
export const SCHEMA_VERSION = 19;

export type AuthVerifier = (token: string, requestId?: string) => ActorContext | null;
export type RestHub = {
  doctor?: () => unknown;
  storage?: HubDatabaseResolution;
  dispatch?: (operationId: OperationId, input: { body: unknown; params: Record<string,string>; query: Record<string,string>; actor: ActorContext; requestId: string; operationMode?: string; storage?: unknown }) => unknown | Promise<unknown>;
};
export type RestOptions = {
  hub: RestHub;
  verifier?: AuthVerifier;
  localMode?: boolean;
  localActor?: ActorContext;
  maxBodyBytes?: number;
  host?: string;
  port?: number;
  storage?: HubDatabaseResolution;
};

/**
 * One registry entry. The `paramNames` array declares, in order, the
 * names of the path-parameter capture groups declared by `pattern`. A
 * route with a single capture group (`/.../{id}`) sets `paramNames` to
 * `['id']`; a route with two captures (`/.../{id}/resources/{path}`)
 * sets `paramNames` to `['id', 'resourcePath']`. The app populates
 * `params` with `decodeURIComponent`-decoded values so the dispatcher
 * never has to deal with raw `%XX` escapes.
 *
 * `paramNames` is intentionally optional; routes without captures (or
 * routes whose only capture maps to the legacy `id` parameter) may
 * omit it and the app falls back to the single-`id` historical
 * contract.
 */
export type RestRoute = {
  method: string;
  pattern: RegExp;
  operationId: OperationId;
  cas: boolean;
  capability?: string;
  paramNames?: readonly string[];
};

function adaptExplicitRoute(r: { method: string; pattern: RegExp; operationId: string; capability?: string; readOnly: boolean }): RestRoute {
  return { method: r.method, pattern: r.pattern, operationId: r.operationId as OperationId, cas: !r.readOnly, capability: r.capability };
}

const routes: readonly RestRoute[] = [
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
  ...relationProposalRoutes,
  ...explicitRelationRoutes.map(adaptExplicitRoute),
];

/**
 * Operations that answer 201 on success. This is an explicit set rather
 * than a `startsWith('create')` heuristic so that adding a `create*`
 * operation which is NOT a resource creation cannot silently change its
 * status code.
 */
const createdOperations: ReadonlySet<OperationId> = new Set<OperationId>([
  'createBinding',
  'createProfile',
  'createEvent',
  'createMemory',
  'createManualSkillRelationProposal',
]);

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
    // Match on path first, then on method, so a known path reached with
    // the wrong method answers 405 + Allow instead of a misleading 404.
    const pathMatches = routes.filter((candidate) => candidate.pattern.test(url.pathname));
    if (pathMatches.length === 0) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'route not found', status: 404 } }, id);
    const route = pathMatches.find((candidate) => candidate.method === req.method);
    if (!route) {
      res.setHeader('allow', [...new Set(pathMatches.map((candidate) => candidate.method))].join(', '));
      return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed', status: 405 } }, id);
    }
    const peer = req.socket.remoteAddress ?? '';
    const bearer = req.headers.authorization;
    let actor: ActorContext | undefined;
    if (options.localMode && loopback(peer)) actor = options.localActor;
    else {
      if (!bearer?.startsWith('Bearer ') || !options.verifier) return send(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'bearer required', status: 401 } }, id);
      actor = options.verifier(bearer.slice(7), id) ?? undefined;
      if (!actor) return send(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'invalid bearer', status: 401 } }, id);
    }
    if (route.cas && !req.headers['if-match'] && req.method !== 'GET') return send(res, 428, { error: { code: 'PRECONDITION_REQUIRED', message: 'If-Match required', status: 428 } }, id);
    try {
      if (route.capability && !actor?.capabilities.includes(route.capability) && !actor?.capabilities.includes('admin')) {
        throw new HubError('FORBIDDEN', `${route.capability} capability required`, 403);
      }
      const body = req.method === 'GET' ? undefined : await readBody(req, max);
      if (route.operationId === 'getHealth') return send(res, 200, { ok: true }, id);
      if (route.operationId === 'getStatus') return send(res, 200, { ok: true, service: 'portable-agent-asset-hub', ...(options.storage ? { schemaVersion: SCHEMA_VERSION, storage: storagePayload(options.storage, options.localMode === true) } : {}) }, id);
      if (route.operationId === 'getCapabilities') return send(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        apiVersion: 'v1',
        features: { skills: true, memories: true, skillGraph: true, relationProposals: true, mandatoryRetrieval: true, retrievalAudit: true },
        auth: { mode: options.localMode ? 'local-dev' : 'bearer' },
        actor: { userId: actor!.userId, agentId: actor!.agentId, capabilities: actor!.capabilities },
        storage: storagePayload(options.storage, options.localMode === true),
        limits: { maxGraphDepth: 8, maxResolvedSkills: 32 },
      }, id);
      if (route.operationId === 'getDoctor') return send(res, 200, options.hub.doctor?.() ?? { ok: true }, id);
      if (!options.hub.dispatch || !actor) throw new HubError('INTERNAL', 'operation unavailable', 501);
      const matches = route.pattern.exec(url.pathname) ?? [];
      const params: Record<string, string> = {};
      const names = route.paramNames ?? (matches[1] ? ['id'] : []);
      for (let index = 0; index < names.length; index += 1) {
        const raw = matches[index + 1];
        if (typeof raw === 'string' && raw.length > 0) {
          try {
            params[names[index]!] = decodeURIComponent(raw);
          } catch {
            throw new HubError('VALIDATION', 'malformed percent-encoding in path parameter', 400);
          }
        }
      }
      const result = await options.hub.dispatch(route.operationId, { body, params, query: Object.fromEntries(url.searchParams), actor, requestId: id, operationMode: typeof req.headers['x-agent-operation-mode'] === 'string' ? req.headers['x-agent-operation-mode'] : undefined, storage: options.hub.storage });
      if (result === undefined) throw new HubError('INTERNAL', 'operation returned no response', 500);
      return send(res, createdOperations.has(route.operationId) ? 201 : 200, result, id);
    } catch (error) { return fail(res, error, id); }
  };
}
export function createRestServer(options: RestOptions): Server { return createServer(createApp(options)); }
function storagePayload(storage: HubDatabaseResolution | undefined, localMode: boolean): Record<string, unknown> {
  if (!storage) return { mode: 'unknown', source: 'unknown' };
  return { mode: storage.mode, source: storage.source, databaseName: storage.databaseName, ...(localMode ? { databasePath: storage.path } : {}) };
}
export async function listen(options: RestOptions): Promise<Server> {
  const host = options.host ?? '127.0.0.1';
  if (!loopback(host) && (!options.verifier || options.localMode)) throw new Error('non-loopback requires bearer verifier and localMode=false');
  const server = createRestServer(options);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, host, () => resolve()); });
  return server;
}
