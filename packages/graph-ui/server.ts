import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
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
  if (!LOOPBACK.has(host)) throw new Error('Graph UI binds to loopback only');
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
      const proposalMutation = url.pathname.startsWith('/api/v1/skill-relation-proposals/') && req.method === 'POST';
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
        if (proposalMutation) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); body = Buffer.concat(chunks).toString('utf8'); headers['content-type'] = req.headers['content-type'] ?? 'application/json'; }
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
