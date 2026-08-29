// tests/fixtures/rest-launcher.ts
//
// Shared harness for the tests that drive `agent-memory-rest` as a real
// child process.
//
// Port allocation is inherently racy: binding port 0 and reading back the
// number tells you what was free at that instant, but the probe has to be
// closed before the launcher can bind it, and under parallel vitest workers
// another test can take it in that window. The failure surfaces as
// `EADDRINUSE` inside the child, which previously stalled until the 10s
// readiness timeout and failed the run.
//
// `withFreePort` closes that gap: it detects the bind failure as soon as the
// child reports it and retries on a fresh port. Retrying is the right shape
// rather than reserving harder — no reservation survives being handed to a
// different process.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/** How many colliding ports to tolerate before giving up. */
const MAX_ATTEMPTS = 5;

export type LauncherReady = { url: string; dbPath: string; stderr: string };

/** A port that was free at the moment the probe closed. */
export async function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('probe did not return numeric address')));
        return;
      }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

class PortInUseError extends Error {}

/**
 * Resolve when the launcher prints its readiness line. Rejects fast, with a
 * `PortInUseError`, when the child reports a bind failure instead — waiting
 * for the timeout would turn a retryable collision into a slow failure.
 */
export async function waitReady(child: ChildProcess): Promise<LauncherReady> {
  let stderr = '';
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`launcher readiness timeout: ${stderr}`)), 10_000);
    if (!child.stderr) throw new Error('launcher stderr pipe missing');
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.includes('EADDRINUSE')) {
        clearTimeout(timer);
        reject(new PortInUseError(stderr));
        return;
      }
      const line = stderr.split('\n').find((entry) => entry.startsWith('AGENT_MEMORY_READY '));
      if (!line) return;
      clearTimeout(timer);
      resolveReady({ ...JSON.parse(line.slice('AGENT_MEMORY_READY '.length)) as { url: string; dbPath: string }, stderr });
    });
    child.once('error', reject);
  });
}

/**
 * Run `attempt` with a free port, retrying on a port collision. Any other
 * failure propagates on the first try: this retries a race, not a bug.
 */
export async function withFreePort<T>(attempt: (port: number) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let tries = 0; tries < MAX_ATTEMPTS; tries += 1) {
    try {
      return await attempt(await allocateFreePort());
    } catch (error) {
      if (!(error instanceof PortInUseError)) throw error;
      last = error;
    }
  }
  throw new Error(`could not bind a free port in ${MAX_ATTEMPTS} attempts: ${String(last)}`);
}

export type SpawnLauncherOptions = {
  bin: string;
  repoRoot: string;
  dbPath: string;
  /** Extra environment for the child, merged over the defaults. */
  env?: Record<string, string | undefined>;
  /** Collected so a test's `afterEach` can kill whatever it started. */
  children: ChildProcess[];
};

export type LauncherHandle = { child: ChildProcess; url: string; dbPath: string; port: number; stderr: string };

/** Spawn `agent-memory-rest` on a free port and wait until it is serving. */
export async function spawnRestLauncher(options: SpawnLauncherOptions): Promise<LauncherHandle> {
  return withFreePort(async (port) => {
    const child = spawn(process.execPath, [options.bin], {
      cwd: options.repoRoot,
      env: { ...process.env, AGENT_MEMORY_DB_PATH: options.dbPath, PORT: String(port), HOST: '127.0.0.1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    options.children.push(child);
    const ready = await waitReady(child);
    return { child, url: ready.url, dbPath: ready.dbPath, port, stderr: ready.stderr };
  });
}
