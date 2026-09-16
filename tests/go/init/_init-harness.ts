// tests/go/init/_init-harness.ts
//
// Shared subprocess harness for the T3 init/token subprocess tests.
// Mirrors tests/go/shell/_hub-harness.ts but specialised for T3:
//   * builds the hub binary once per process (with -trimpath)
//   * exposes runHub() with a per-call fresh HOME so HUB_HOME /
//     HUB_OPENAPI can be overridden per case
//   * exposes freshHome() for the idempotent-init / token-permissions /
//     rotate tests, which need a real on-disk HUB_HOME
//
// The harness is hermetic — every evidence artifact lives under
// os.tmpdir()/hub-init-<pid>-<ts>/, and HUB_HOME is always a per-call
// temp dir so the operator's real ~/.local/share/hub is never read
// or written.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const repoOpenAPI = join(repoRoot, 'openapi', 'openapi.yaml');

let cachedBinary: string | null = null;
let cachedBuildTmp: string | null = null;

export interface HubBuildResult {
  binary: string;
  buildTmp: string;
  buildLog: string;
}

export function buildHubBinary(): HubBuildResult {
  if (cachedBinary && cachedBuildTmp && existsSync(cachedBinary)) {
    return { binary: cachedBinary, buildTmp: cachedBuildTmp, buildLog: '' };
  }
  const buildTmp = mkdtempSync(join(tmpdir(), `hub-init-${process.pid}-`));
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

export async function runHub(
  argv: readonly string[],
  envOverride: Record<string, string> = {},
  options: { cwd?: string } = {},
): Promise<HubRunResult> {
  const { binary } = buildHubBinary();
  const cleanedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') cleanedEnv[k] = v;
  }
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
  // ($HOME/.local/share/hub) is hermetic.
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

export interface FreshHome {
  home: string;
  cleanup: () => void;
}

export function freshHome(label: string): FreshHome {
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

export async function runHubOnFreshHome(
  argv: readonly string[],
  options: { label?: string; env?: Record<string, string>; cwd?: string } = {},
): Promise<HubRunResult & FreshHome> {
  const { home, cleanup } = freshHome(options.label ?? 'fresh');
  const env = {
    HUB_HOME: home,
    HUB_OPENAPI: repoOpenAPI,
    ...(options.env ?? {}),
  };
  const res = await runHub(argv, env, { cwd: options.cwd });
  return { ...res, home, cleanup };
}

/**
 * Stat a file and return its mode (the lower 12 bits of st_mode —
 * the unix permission bits). Returns null when the file is missing.
 *
 * The test surface asserts on the exact mode: 0o600 for hub.token.
 * We expose this helper because statSync().mode on Linux returns the
 * full mode (including file-type bits); the lower 12 bits are the
 * permission set and are the only ones the contract cares about.
 */
export function statMode(absPath: string): number | null {
  if (!existsSync(absPath)) return null;
  const st = statSync(absPath);
  // & 0o777 — permission bits only. Some platforms expose type bits
  // (S_IFREG, etc.) in the high nibble; the contract is the permission
  // set, never the file type.
  return (st.mode & 0o777);
}

export { repoRoot, repoOpenAPI };

// ---------------------------------------------------------------------------
// Bearer-shape predicates — mirrored from internal/output/output.go.
// ---------------------------------------------------------------------------
//
// JS regex literals do NOT support inline flags like `(?i)` (PCRE / Python
// syntax). The harness uses RegExp constructor flags instead, keeping the
// patterns identical to the Go side.

const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=\s*[^\s,'"]+/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const AUTHORIZATION_FILE = /\bauthorization\s*[:=]\s*(?:bearer\s+)?([A-Za-z0-9._~+/=-]{20,})/i;

export function looksLikeBearer(s: string): boolean {
  if (!s) return false;
  if (BEARER_PREFIXED_OPAQUE.test(s)) return true;
  if (HUB_BEARER_ENV_ASSIGNMENT.test(s)) return true;
  if (AUTHORIZATION_FILE.test(s)) return true;
  if (JWT_TRIPLE_SEGMENT.test(s)) return true;
  return false;
}

// Suppress unused-import linter warnings on helpers some consumers use
// indirectly (readFileSync, mkdirSync, chmodSync, writeFileSync).
void readFileSync;
void mkdirSync;
void chmodSync;
void writeFileSync;
