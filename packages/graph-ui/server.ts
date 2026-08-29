import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export function isLanHost(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/u.test(part))) return false;
  const [first, second, third, fourth] = parts.map(Number);
  if ([first, second, third, fourth].some((octet) => octet < 0 || octet > 255)) return false;
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}
/**
 * The exact set of governed relation mutations the BFF will forward.
 *
 * A prefix match is not good enough here: it let `POST
 * /api/v1/skill-relation-proposals/reconcile-canonical-duplicates` through
 * while refusing `POST /api/v1/skill-relation-proposals`, which the UI does
 * call. Each entry below is anchored, and every mutation still has to clear
 * capability, CAS and review on the REST side — this list only decides what
 * the browser is allowed to reach at all.
 */
const GOVERNED_MUTATIONS: readonly RegExp[] = [
  /^\/api\/v1\/skill-relation-proposals$/u,
  /^\/api\/v1\/skill-relation-proposals\/(?:apply|apply-preview|discover)$/u,
  /^\/api\/v1\/skill-relation-proposals\/[^/]+\/(?:approve|reject)$/u,
  /^\/api\/v1\/skill-relation-candidates\/explicit\/(?:impact|stage)$/u,
];
export function isGovernedMutation(pathname: string, method: string | undefined): boolean {
  return method === 'POST' && GOVERNED_MUTATIONS.some((pattern) => pattern.test(pathname));
}
const MIME: Record<string,string> = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.map':'application/json; charset=utf-8' };
export async function loadBearer(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('GRAPH_UI_BEARER_FILE must be a regular file with mode 0600');
  }
  let token: string;
  try {
    const info = await handle.stat();
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (currentUid !== undefined && info.uid !== currentUid)) {
      throw new Error('GRAPH_UI_BEARER_FILE must be an owner-controlled regular file with mode 0600');
    }
    token = (await handle.readFile('utf8')).trim();
  } finally {
    await handle.close();
  }
  if (!token) throw new Error('GRAPH_UI_BEARER_FILE is empty');
  return token;
}
export async function startGraphUi(env: NodeJS.ProcessEnv = process.env) {
  const host = env.GRAPH_UI_HOST ?? '127.0.0.1';
  const allowLan = env.GRAPH_UI_ALLOW_LAN === '1';
  if (!LOOPBACK.has(host) && !(allowLan && isLanHost(host))) {
    throw new Error('Graph UI binds to loopback only unless GRAPH_UI_ALLOW_LAN=1 and GRAPH_UI_HOST is a private IPv4 address');
  }
  const lanMode = !LOOPBACK.has(host);
  const port = Number(env.GRAPH_UI_PORT ?? '39422');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GRAPH_UI_PORT must be 1..65535');
  const upstream = new URL(env.GRAPH_UI_REST_URL ?? 'http://127.0.0.1:39421');
  if (upstream.protocol !== 'http:' || !LOOPBACK.has(upstream.hostname)) throw new Error('GRAPH_UI_REST_URL must be loopback http');
  const bearer = await loadBearer(env.GRAPH_UI_BEARER_FILE);
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const proposalMutation = !lanMode && isGovernedMutation(url.pathname, req.method);
      if (req.method !== 'GET' && req.method !== 'HEAD' && !proposalMutation) {
        res.writeHead(405, {'content-type':'application/json','allow':'GET, HEAD'});
        res.end(JSON.stringify({error:{code:'READ_ONLY',message:'Graph UI is read-only'}}));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && !proposalMutation) { res.writeHead(405, {'content-type':'application/json'}); res.end(JSON.stringify({error:{code:'READ_ONLY',message:'Graph UI is read-only outside governed relation proposal actions'}})); return; }
        const target = new URL(url.pathname + url.search, upstream);
        const headers: Record<string,string> = { accept: 'application/json' };
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        let body: string | undefined;
        if (proposalMutation) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); body = Buffer.concat(chunks).toString('utf8'); headers['content-type'] = req.headers['content-type'] ?? 'application/json'; // REST answers 428 without it, so a dropped If-Match silently breaks every governed mutation.
          const ifMatch = req.headers['if-match']; headers['if-match'] = typeof ifMatch === 'string' ? ifMatch : '*'; }
        const response = await fetch(target, { method: req.method, headers, body, signal: AbortSignal.timeout(15_000) });
        res.writeHead(response.status, {'content-type':response.headers.get('content-type') ?? 'application/json','cache-control':'no-store'});
        res.end(Buffer.from(await response.arrayBuffer())); return;
      }
      const root = join(fileURLToPath(new URL('.', import.meta.url)), '../dist');
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const safe = normalize(requested).replace(/^(\.\.(\/|\|$))+/, '');
      let file = join(root, safe);
      try { const info = await stat(file); if (!info.isFile()) file = join(root, 'index.html'); } catch { file = join(root, 'index.html'); }
      res.writeHead(200, {'content-type': MIME[extname(file)] ?? 'application/octet-stream','cache-control':file.endsWith('index.html')?'no-store':'public, max-age=31536000, immutable'});
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch { res.writeHead(502, {'content-type':'application/json'}); res.end(JSON.stringify({error:{code:'UPSTREAM_UNAVAILABLE',message:'Graph data is temporarily unavailable'}})); }
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) startGraphUi().then((server)=>{const address=server.address();process.stderr.write(`GRAPH_UI_READY ${JSON.stringify({address})}\n`);}).catch((error:unknown)=>{process.stderr.write(`GRAPH_UI_ERROR ${error instanceof Error?error.message:'startup failed'}\n`);process.exitCode=1;});
