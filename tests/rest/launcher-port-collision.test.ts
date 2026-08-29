// tests/rest/launcher-port-collision.test.ts
//
// The REST tests spawn `agent-memory-rest` on a port discovered by binding
// port 0 and reading it back. That port has to be released before the child
// can take it, and under parallel vitest workers another test can win the
// race in that window — CI hit exactly this as
// `EADDRINUSE: address already in use 127.0.0.1:43041`.
//
// Two properties make the harness survive it, and both are asserted here:
// the collision is reported promptly rather than stalling until the 10s
// readiness timeout, and `withFreePort` retries a colliding attempt while
// still letting a genuine failure through on the first try.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allocateFreePort, waitReady, withFreePort } from '../fixtures/rest-launcher';

const repoRoot = resolve(import.meta.dirname, '../..');
const bin = join(repoRoot, 'packages/rest/bin/agent-memory-rest.mjs');

const children: ChildProcess[] = [];
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) if (!child.killed) child.kill('SIGKILL');
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function occupy(port: number): Promise<void> {
  return new Promise((done, fail) => {
    const server = createServer();
    servers.push(server);
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => done());
  });
}

describe('launcher port collision', () => {
  it('reports a taken port promptly instead of waiting out the readiness timeout', async () => {
    const port = await allocateFreePort();
    await occupy(port);
    const root = mkdtempSync(join(tmpdir(), 'launcher-collision-'));
    roots.push(root);

    const child = spawn(process.execPath, [bin], {
      cwd: repoRoot,
      env: { ...process.env, AGENT_MEMORY_DB_PATH: join(root, 'hub.sqlite'), PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);

    const startedAt = Date.now();
    await expect(waitReady(child)).rejects.toThrow(/EADDRINUSE/u);
    // The readiness timeout is 10s; a collision must not cost that.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('retries a colliding attempt and returns the first that binds', async () => {
    let attempts = 0;
    const seen: number[] = [];
    const result = await withFreePort(async (port) => {
      attempts += 1;
      seen.push(port);
      if (attempts < 3) {
        await occupy(port);
        const child = spawn(process.execPath, [bin], {
          cwd: repoRoot,
          env: { ...process.env, AGENT_MEMORY_DB_PATH: join(mkdtempSync(join(tmpdir(), 'launcher-retry-')), 'hub.sqlite'), PORT: String(port), HOST: '127.0.0.1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(child);
        return waitReady(child);
      }
      return { url: `http://127.0.0.1:${port}`, dbPath: 'unused', stderr: '' };
    });

    expect(attempts).toBe(3);
    expect(new Set(seen).size).toBe(3);
    expect(result.url).toBe(`http://127.0.0.1:${seen[2]}`);
  });

  it('does not retry a failure that is not a port collision', async () => {
    let attempts = 0;
    await expect(withFreePort(async () => {
      attempts += 1;
      throw new Error('a genuine failure');
    })).rejects.toThrow('a genuine failure');
    expect(attempts).toBe(1);
  });
});
