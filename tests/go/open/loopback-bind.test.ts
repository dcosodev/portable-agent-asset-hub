// tests/go/open/loopback-bind.test.ts
//
// T4 contract for the loopback-only `hub open` command.
//
// What this test proves (per docs/roadmap/slices.json T4):
//
//   * `hub open` serves the embedded Graph Explorer bundle on
//     127.0.0.1 only — a TCP probe to 127.0.0.1:<port> succeeds.
//   * GET / returns the embedded bundle's index.html (200, HTML).
//   * The dispatcher is fail-closed: `hub open --help` exits 0 and
//     mentions loopback-only publication.
//   * The handler refuses 0.0.0.0 — see rejects-non-loopback.test.ts
//     for the negative case (kept as a separate file per the T4
//     contract's test list).
//   * No bearer-shaped content leaks on stdout or stderr.
//
// These are real subprocess tests. The harness builds the binary
// with `go build -trimpath` once per process; each test case runs
// the binary in the background, asserts via TCP, then terminates
// it. We DO NOT mock the binary; the test that ships is the test
// that proves the contract.

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildOpenBinary,
  freshHome,
  pickFreeLoopbackPort,
  probeLoopback,
  repoOpenAPI,
  repoRoot,
  runOpen,
} from './_open-harness.js';

// Bearer-shape predicates, mirrored from internal/output/output.go
// (LooksLikeBearer). Kept local to this file because the open
// harness must stay minimal — duplicating four constants is cheaper
// than coupling every open test to the shell harness.
const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=\s*[^\s,'"]+/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

function looksLikeBearer(s: string): boolean {
  if (!s) return false;
  if (BEARER_PREFIXED_OPAQUE.test(s)) return true;
  if (HUB_BEARER_ENV_ASSIGNMENT.test(s)) return true;
  if (JWT_TRIPLE_SEGMENT.test(s)) return true;
  return false;
}

beforeAll(() => {
  // Build the binary up front so a failure is a clear error, not a
  // hung test. The harness caches the binary in a per-process temp
  // directory; vitest runs each describe in its own worker so the
  // cache is per-test-file.
  const { binary } = buildOpenBinary();
  if (!existsSync(binary)) {
    throw new Error(`hub binary not built: ${binary}`);
  }
});

afterEach(async () => {
  // Best-effort cleanup; the harness kills the child via SIGTERM
  // after killAfterMs, so we mostly wait for the promise to settle.
  await new Promise((r) => setTimeout(r, 50));
});

describe('hub open — loopback bind (T4 contract)', () => {
  it('probes 127.0.0.1:<port> while hub open is serving the bundle', async () => {
    const port = await pickFreeLoopbackPort();
    const { home, cleanup } = freshHome('loopback-bind-ok');
    try {
      const run = runOpen(
        ['open', '--port', String(port), '--bind', '127.0.0.1'],
        { HUB_HOME: home, HUB_OPENAPI: repoOpenAPI },
        { killAfterMs: 8_000 },
      );
      // Probe up to 5s — give the binary time to bind.
      const deadline = Date.now() + 5_000;
      let bound = false;
      while (Date.now() < deadline) {
        if (await probeLoopback('127.0.0.1', port, 250)) {
          bound = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      // Wait for the child to be killed by the harness.
      const result = await run;
      expect(bound).toBe(true);
      // The child was killed (SIGTERM/killAfterMs) — exit may be
      // non-zero or null. We do NOT assert on its exit code here;
      // the assertion is that the loopback probe succeeded while
      // the process was alive.
      expect(result.stdout + result.stderr).not.toMatch(/panic|traceback/i);
      // Bearer hygiene: the captured stdout/stderr must not include
      // any bearer-shaped content even when the server is running.
      expect(looksLikeBearer(result.stdout)).toBe(false);
      expect(looksLikeBearer(result.stderr)).toBe(false);
    } finally {
      cleanup();
    }
  }, 20_000);

  it('serves the embedded index.html with text/html on GET /', async () => {
    const port = await pickFreeLoopbackPort();
    const { home, cleanup } = freshHome('loopback-html');
    try {
      const run = runOpen(
        ['open', '--port', String(port), '--bind', '127.0.0.1'],
        { HUB_HOME: home, HUB_OPENAPI: repoOpenAPI },
        { killAfterMs: 10_000 },
      );
      // Wait for bind then issue a real HTTP GET via Node's
      // built-in http module. We import lazily so the harness stays
      // minimal when only the bind probe runs.
      const http = await import('node:http');
      const deadline = Date.now() + 5_000;
      let body = '';
      let status = 0;
      let contentType = '';
      let ok = false;
      while (Date.now() < deadline) {
        if (await probeLoopback('127.0.0.1', port, 250)) {
          try {
            const fetched = await new Promise<{ status: number; body: string; contentType: string }>(
              (resolveHttp, rejectHttp) => {
                const req = http.request(
                  { host: '127.0.0.1', port, path: '/', method: 'GET' },
                  (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => {
                      resolveHttp({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString('utf8'),
                        contentType: String(res.headers['content-type'] ?? ''),
                      });
                    });
                    res.on('error', rejectHttp);
                  },
                );
                req.on('error', rejectHttp);
                req.setTimeout(2000, () => req.destroy(new Error('http timeout')));
                req.end();
              },
            );
            status = fetched.status;
            body = fetched.body;
            contentType = fetched.contentType;
            ok = true;
            break;
          } catch {
            // transient; retry
            await new Promise((r) => setTimeout(r, 150));
          }
        } else {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      await run;
      expect(ok).toBe(true);
      expect(status).toBe(200);
      expect(contentType.toLowerCase()).toMatch(/text\/html/);
      expect(body.length).toBeGreaterThan(0);
      // Bearer hygiene — index.html must not contain bearer-shaped
      // content even if the bundle is the real Graph Explorer
      // (which embeds React, Cytoscape, and React-Markdown; none of
      // those emit bearer-shaped strings).
      expect(looksLikeBearer(body)).toBe(false);
    } finally {
      cleanup();
    }
  }, 25_000);

  it('hub open --help exits 0 and mentions loopback-only publication', async () => {
    const res = await runOpen(
      ['open', '--help'],
      { HUB_OPENAPI: repoOpenAPI },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/loopback|127\.0\.0\.1/i);
    expect(res.stdout).toMatch(/Usage:/i);
    // No bearer-shaped content on the help surface.
    expect(looksLikeBearer(res.stdout)).toBe(false);
    expect(looksLikeBearer(res.stderr)).toBe(false);
  }, 15_000);

  it('hub open without --bind defaults to 127.0.0.1', async () => {
    const port = await pickFreeLoopbackPort();
    const { home, cleanup } = freshHome('loopback-default');
    try {
      const run = runOpen(
        ['open', '--port', String(port)],
        { HUB_HOME: home, HUB_OPENAPI: repoOpenAPI },
        { killAfterMs: 8_000 },
      );
      const deadline = Date.now() + 5_000;
      let bound = false;
      while (Date.now() < deadline) {
        if (await probeLoopback('127.0.0.1', port, 250)) {
          bound = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      await run;
      expect(bound).toBe(true);
    } finally {
      cleanup();
    }
  }, 20_000);
});

// Silence unused-import warnings when the test file is parsed in
// isolation (vitest config + LSP).
void resolve;
void repoRoot;
