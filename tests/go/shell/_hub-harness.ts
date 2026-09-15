// tests/go/shell/_hub-harness.ts
//
// Shared subprocess harness for the T1 Go-shell subprocess tests
// (version / help / doctor). The harness builds the hub binary ONCE
// per test process with `go build -trimpath` into a per-suite temp
// directory, and exposes a small runner that captures stdout, stderr,
// and exit code. Every consumer (version.test.ts, help.test.ts,
// doctor.test.ts) imports this module so the build is amortised.
//
// The harness is intentionally hermetic:
//   * The binary is written under os.tmpdir()/hub-shell-<pid>-<ts>/.
//   * HUB_HOME is pointed at a per-test fresh temp directory so the
//     doctor sees a "fresh worktree" layout (no state/, runtime/,
//     logs/, tokens/).
//   * HUB_OPENAPI is pointed at the repo's real openapi/openapi.yaml
//     so the doctor check `openapi_accessible` passes without needing
//     a fake spec — the test asserts the doctor can read the canonical
//     spec, not that it generates one.
//
// The build is repeated per `describe` so the harness does NOT share
// state across vitest workers (each `describe` file runs in its own
// worker). The cost is ~1s per worker; the determinism win is the
// real reason we do this — there is no cross-file shared mutable state.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// `here` resolves to tests/go/shell — three `..` hops land at the
// repo root (the directory holding cmd/, internal/, go.mod).
const repoRoot = resolve(here, '..', '..', '..');

// Repo-local openapi.yaml is the canonical T1 target. The doctor test
// asserts it is readable; the version/help tests are openapi-
// independent but still need it set so the config loader never
// silently falls back to "<repoRoot>/openapi/openapi.yaml" — that
// fallback resolves to "/" when the binary is run from /tmp.
const repoOpenAPI = join(repoRoot, 'openapi', 'openapi.yaml');

let cachedBinary: string | null = null;
let cachedBuildTmp: string | null = null;

export interface HubBuildResult {
  binary: string;
  buildTmp: string;
  buildLog: string;
}

/**
 * Build the hub binary with `go build -trimpath` into a per-call temp
 * directory. The function caches the result so callers that need a
 * fresh build (e.g. after editing Go source) can clear the cache via
 * `resetHubBinary()`. The default behaviour — one build per process —
 * matches the s11 gate's hermetic test.
 */
export function buildHubBinary(): HubBuildResult {
  if (cachedBinary && cachedBuildTmp && existsSync(cachedBinary)) {
    return { binary: cachedBinary, buildTmp: cachedBuildTmp, buildLog: '' };
  }
  const buildTmp = mkdtempSync(join(tmpdir(), `hub-shell-${process.pid}-`));
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
export function resetHubBinary(): void {
  if (cachedBuildTmp && existsSync(cachedBuildTmp)) {
    rmSync(cachedBuildTmp, { recursive: true, force: true });
  }
  cachedBinary = null;
  cachedBuildTmp = null;
}

export interface HubRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
  command: string;
}

/**
 * Run the hub binary with the given argv and a sanitised env. The
 * sanitised env:
 *   * strips HUB_HOME, HUB_RUNTIME, HUB_OPENAPI so the test can
 *     opt-in to a specific value per case;
 *   * clears HUB_BEARER_TOKEN* so the bearer-hygiene check sees a
 *     clean env unless the test deliberately wants to probe it;
 *   * sets CI=true so the sink is in CI mode (no ANSI codes);
 *   * forwards HOME to a per-call temp dir so HUB_HOME's XDG-style
 *     fallback resolves inside that temp dir.
 */
export async function runHub(
  argv: readonly string[],
  envOverride: Record<string, string> = {},
  options: { cwd?: string } = {},
): Promise<HubRunResult> {
  const { binary } = buildHubBinary();
  // The harness cleans its own HUB_HOME via freshHome() — when the
  // caller does not supply one, the subprocess still inherits HOME
  // pointing at os.tmpdir(), so the XDG fallback resolves to a fresh
  // per-suite temp dir without polluting the operator's $HOME.
  const cleanedEnv: Record<string, string> = { ...process.env };
  for (const k of [
    'HUB_HOME',
    'HUB_RUNTIME',
    'HUB_OPENAPI',
    'HUB_BEARER_TOKEN',
    'HUB_BEARER_TOKEN_FILE',
    'HUB_BEARER_TOKEN_SOURCE',
  ]) {
    delete cleanedEnv[k];
  }
  cleanedEnv.CI = 'true';
  // HOME goes to a per-call temp dir so the XDG fallback
  // ($HOME/.local/share/hub) is hermetic. Without this, an
  // operator's real ~/.local/share/hub could be read by the
  // binary on a developer's machine.
  const homeTmp = mkdtempSync(join(tmpdir(), `hub-home-${process.pid}-`));
  cleanedEnv.HOME = homeTmp;
  cleanedEnv.XDG_DATA_HOME = homeTmp;
  return await new Promise((resolveP) => {
    const child = spawn(binary, argv, {
      cwd: options.cwd ?? repoRoot,
      env: { ...cleanedEnv, ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let spawnErr: Error | null = null;
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
 * Build a fresh HOME / HUB_HOME pair on disk so the doctor can be
 * probed against a real "fresh worktree" layout. Returns the
 * absolute path of the temp home. The function never creates
 * state/, runtime/, logs/, tokens/ — those are what `hub init`
 * produces and are deliberately absent here.
 */
export function freshHome(label: string): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), `hub-${label}-${process.pid}-`));
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
 * Run the binary with the openapi env wired so the doctor can pass
 * the openapi_accessible check. Tests that do NOT care about openapi
 * can call runHub() directly; tests that need doctor "ok" on a
 * fresh HOME should use this helper.
 */
export async function runHubOnFreshHome(
  argv: readonly string[],
  options: { label?: string; cwd?: string } = {},
): Promise<HubRunResult & { home: string; cleanup: () => void }> {
  const { home, cleanup } = freshHome(options.label ?? 'fresh');
  const env = {
    HUB_HOME: home,
    HUB_OPENAPI: repoOpenAPI,
  };
  const res = await runHub(argv, env, { cwd: options.cwd });
  return { ...res, home, cleanup };
}

export { repoRoot, repoOpenAPI };

/**
 * Returns true when the input contains a substring that matches the
 * hub's bearer-shape predicates. The predicate mirrors
 * internal/output/output.go (LooksLikeBearer) so the test is
 * synchronised with the binary's redactor — no need to re-implement
 * the regexes in TypeScript.
 *
 * The patterns are intentionally conservative: a substring must look
 * like a 20+ char long opaque token, prefixed by "Bearer "/"bearer "
 * (case-insensitive), or be a JWT triple-segment shape. This is the
 * shape the s11 gate rejects.
 */
// Bearer-shape predicates, mirrored from internal/output/output.go
// (LooksLikeBearer). Each is a top-level constant so vitest's
// transform step evaluates them once at module init; this also keeps
// the regex compilation out of the assertion hot path. JS regex
// literals do NOT support inline flags like `(?i)` — that is the
// PCRE/Python/Ruby syntax — so we use the `i` flag on a RegExp
// constructor instead, preserving the case-insensitive bearer and
// env-var shape detection.
const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=\s*[^\s,'"]+/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

export function looksLikeBearer(s: string): boolean {
  if (!s) return false;
  // Bearer-prefixed opaque token (20+ chars, base64url alphabet).
  if (BEARER_PREFIXED_OPAQUE.test(s)) return true;
  // env-var assignment with HUB_BEARER_TOKEN=
  if (HUB_BEARER_ENV_ASSIGNMENT.test(s)) return true;
  // JWT triple-segment shape.
  if (JWT_TRIPLE_SEGMENT.test(s)) return true;
  return false;
}

/**
 * Touch a sentinel file inside the repo's artifacts/ directory so
 * the test can prove that NO subprocess mutated it. Returned by
 * withRepoSentinel() / consumed by assertRepoSentinelUntouched().
 */
export const repoSentinelRel = 'artifacts/__hub-shell-test-sentinel.json';

export function withRepoSentinel(): { absPath: string; beforeMtime: number } {
  const abs = join(repoRoot, repoSentinelRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '{}\n', 'utf8');
  return { absPath: abs, beforeMtime: statSync(abs).mtimeMs };
}

export function assertRepoSentinelUntouched(s: { absPath: string; beforeMtime: number }): void {
  if (!existsSync(s.absPath)) {
    throw new Error(`repo sentinel disappeared: ${s.absPath}`);
  }
  const after = statSync(s.absPath).mtimeMs;
  if (after !== s.beforeMtime) {
    throw new Error(
      `repo sentinel mtime changed: before=${s.beforeMtime} after=${after} path=${s.absPath}`,
    );
  }
}

// Quiet unused-import linter when the consumer imports only a subset.
void readFileSync;
void sep;
