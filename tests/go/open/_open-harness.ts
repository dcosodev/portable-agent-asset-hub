// tests/go/open/_open-harness.ts
//
// Shared subprocess harness for the T4 Graph Explorer open tests
// (loopback-bind.test.ts, rejects-non-loopback.test.ts). The harness
// builds the hub binary ONCE per process with `go build -trimpath`
// into a per-suite temp directory, and exposes a small runner that
// captures stdout, stderr, and exit code.
//
// T4 invariants enforced by every consumer:
//   * The binary is built hermetically (no network, no state).
//   * HUB_HOME points at a per-test fresh temp directory.
//   * HUB_OPENAPI points at the repo's real openapi/openapi.yaml so
//     config.Load succeeds (the open handler does not need openapi,
//     but main.go's Load() is on the critical path before the
//     handler runs).
//   * Every test FAILS CLOSED: when the harness cannot build, the
//     test errors rather than skipping — a missing binary is a hard
//     regression, not a soft skip.
//
// The harness mirrors tests/go/shell/_hub-harness.ts but does NOT
// share its cache — open tests may edit source between runs and want
// a fresh build, so the default is per-call and the cache is opt-in.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
// `here` resolves to tests/go/open — three `..` hops land at the
// repo root (the directory holding cmd/, internal/, go.mod).
const repoRoot = resolve(here, '..', '..', '..');

// Repo-local openapi.yaml is the canonical T1+ target. The doctor
// and config.Load both default to <repoRoot>/openapi/openapi.yaml;
// we point HUB_OPENAPI at it explicitly so the binary does not have
// to re-discover it.
const repoOpenAPI = join(repoRoot, 'openapi', 'openapi.yaml');

// Bundle fixture for the gate's hermetic test. The fixture is a
// tiny synthetic dist tree (index.html + assets/) so the embed
// package can be exercised without depending on the real
// packages/graph-ui/dist/ tree shape. Tests must NOT assume the
// production bundle exists; the harness builds it on demand.
const fixtureDir = join(here, 'fixture-dist');

let cachedBinary: string | null = null;
let cachedBuildTmp: string | null = null;

export interface OpenBuildResult {
  binary: string;
  buildTmp: string;
  buildLog: string;
}

/**
 * Build the hub binary with `go build -trimpath` into a per-call temp
 * directory. The function caches the result so callers that need a
 * fresh build (e.g. after editing Go source) can clear the cache via
 * `resetOpenBinary()`. The default behaviour — one build per process —
 * matches the s11 gate's hermetic test.
 */
export function buildOpenBinary(): OpenBuildResult {
  if (cachedBinary && cachedBuildTmp && existsSync(cachedBinary)) {
    return { binary: cachedBinary, buildTmp: cachedBuildTmp, buildLog: '' };
  }
  const buildTmp = mkdtempSync(join(tmpdir(), `hub-open-${process.pid}-`));
  const binary = join(buildTmp, 'hub');
  const res: SpawnSyncReturns<string> = spawnSync('go', [
    'build',
    '-trimpath',
    '-o',
    binary,
    './cmd/hub',
  ], {
    cwd: repoRoot,
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(
      `go build -trimpath failed (status=${res.status})\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  if (!existsSync(binary)) {
    throw new Error(`go build succeeded but binary missing at ${binary}`);
  }
  cachedBinary = binary;
  cachedBuildTmp = buildTmp;
  return { binary, buildTmp, buildLog: `${res.stdout}\n${res.stderr}` };
}

/**
 * Clear the cached binary. Tests that mutate the source tree between
 * runs call this so the next build picks up the change.
 */
export function resetOpenBinary(): void {
  if (cachedBuildTmp && existsSync(cachedBuildTmp)) {
    rmSync(cachedBuildTmp, { recursive: true, force: true });
  }
  cachedBinary = null;
  cachedBuildTmp = null;
}

export interface OpenRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
  command: string;
}

/**
 * Run the hub binary with the given argv and a sanitised env. The
 * sanitised env mirrors the shell harness:
 *   * strips HUB_HOME, HUB_RUNTIME, HUB_OPENAPI so the test can
 *     opt-in to a specific value per case;
 *   * clears HUB_BEARER_TOKEN* so the bearer-hygiene check sees a
 *     clean env unless the test deliberately wants to probe it;
 *   * sets CI=true so the sink is in CI mode (no ANSI codes);
 *   * forwards HOME to a per-call temp dir so HUB_HOME's XDG-style
 *     fallback resolves inside that temp dir.
 */
export async function runOpen(
  argv: readonly string[],
  envOverride: Record<string, string> = {},
  options: { cwd?: string; killAfterMs?: number } = {},
): Promise<OpenRunResult> {
  const { binary } = buildOpenBinary();
  const cleanedEnv: Record<string, string> = { ...process.env };
  for (const k of [
    'HUB_HOME',
    'HUB_RUNTIME',
    'HUB_OPENAPI',
    'HUB_BEARER_TOKEN',
    'HUB_BEARER_TOKEN_FILE',
    'HUB_BEARER_TOKEN_SOURCE',
    'HUB_OPEN_BIND',
    'HUB_OPEN_PORT',
  ]) {
    delete cleanedEnv[k];
  }
  cleanedEnv.CI = 'true';
  // HOME goes to a per-call temp dir so the XDG fallback
  // ($HOME/.local/share/hub) is hermetic. Without this, an
  // operator's real ~/.local/share/hub could be read by the
  // binary on a developer's machine.
  const homeTmp = mkdtempSync(join(tmpdir(), `hub-open-home-${process.pid}-`));
  cleanedEnv.HOME = homeTmp;
  cleanedEnv.XDG_DATA_HOME = homeTmp;
  const mergedEnv: Record<string, string> = { ...cleanedEnv, ...envOverride };
  return await new Promise((resolveP) => {
    const child = spawn(binary, argv, {
      cwd: options.cwd ?? repoRoot,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let spawnErr: Error | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    if (options.killAfterMs && options.killAfterMs > 0) {
      killTimer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        // SIGKILL fallback after another second so a hung server
        // does not stall the test runner indefinitely.
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 1000);
      }, options.killAfterMs);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      spawnErr = err;
    });
    child.once('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      try { rmSync(homeTmp, { recursive: true, force: true }); } catch { /* ignore */ }
      resolveP({
        status: code,
        signal: signal as NodeJS.Signals | null,
        stdout,
        stderr,
        error: spawnErr,
        command: `${binary} ${argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`,
      });
    });
  });
}

/**
 * Build a fresh HOME / HUB_HOME pair on disk so the open handler
 * can be probed against a real "fresh worktree" layout. Returns the
 * absolute path of the temp home.
 */
export function freshHome(label: string): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), `hub-open-${label}-${process.pid}-`));
  return {
    home,
    cleanup: () => {
      if (existsSync(home)) {
        try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

/**
 * Probe a TCP port with a 250ms timeout. Resolves true iff the
 * kernel accepts a TCP connection on the loopback host:port. Used
 * by the loopback-bind tests to verify the server actually bound
 * (exit 0 alone is not enough — the process might have exited
 * cleanly without ever listening).
 */
export function probeLoopback(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolveP) => {
    const sock = createConnection({ host, port });
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolveP(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

/**
 * Pick a free loopback port via a one-shot bind+release. The OS may
 * reuse the port before the binary listens, so callers should pass
 * this hint and the binary should accept it via --port. (The current
 * contract defaults to a kernel-assigned port; tests use --port to
 * make the assertion deterministic.)
 */
export async function pickFreeLoopbackPort(): Promise<number> {
  return await new Promise((resolveP, rejectP) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rejectP);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        rejectP(new Error('unable to read assigned port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolveP(port));
    });
  });
}

export { repoRoot, repoOpenAPI, fixtureDir, mkdirSync, statSync };
