// tests/go/telemetry/_telemetry-harness.ts
//
// Shared subprocess harness for the T5 telemetry subprocess tests
// (up / down / status). The harness builds the hub binary ONCE per
// process with `go build -trimpath`, then exercises the telemetry
// subcommands against a fake `docker` executable injected via PATH.
//
// Hermetic guarantees mirror _runtime-harness.ts:
//   * The hub binary is written under os.tmpdir()/hub-telemetry-<pid>-<ts>/.
//   * A fake `docker` shim is installed in a per-run PATH-prepended
//     directory. The shim is a tiny Node.js script (no external deps)
//     that:
//       - logs every invocation (argv + key env entries) into a
//         per-run JSONL transcript;
//       - responds to `compose up` / `compose down` / `compose ps`
//         with canned, deterministic output;
//       - records the FULL process env it was given so the test can
//         assert bearer-shaped keys are absent (I-07);
//       - records the FULL argv so the test can assert on the exact
//         flag set Compose was called with (no accidental `-v` on
//         down, etc.).
//   * HUB_HOME / HUB_RUNTIME / HUB_OPENAPI are pointed at per-test
//     temp paths so the binary sees a hermetic layout.
//
// T5 must NOT modify observability/**, so the harness always points
// HUB_RUNTIME at the same `<repoRoot>/observability/compose.yaml` the
// runtime harness uses — Detect's compose-file stat must succeed
// without the gate having to rewrite any ADR-0004-protected file.
//
// The harness mirrors tests/go/runtime/_runtime-harness.ts so the T2
// and T5 harnesses read alike; the only differences are:
//   * the tmp dir prefix (hub-telemetry-…);
//   * the exported build-helper name (buildTelemetryHubBinary);
//   * the lookup for the hub-telemetry helpers sibling.
//
// Adding a new helper here is a contract-visible change. New
// telemetry assertions belong in up-down.test.ts /
//loopback-only.test.ts, not the harness.

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// `here` is tests/go/telemetry — three `..` hops land at the repo root.
const repoRoot = resolve(here, '..', '..', '..');
// T5 owns docker-compose.observability.yml (top-level) — NOT
// observability/compose.yaml. The harness therefore defaults
// HUB_RUNTIME to the top-level docker-compose.observability.yml that
// the slice adds; tests that want to override the compose-file
// target can still pass envOverride.HUB_RUNTIME (same escape hatch
// the runtime harness documents).
const repoComposeFile = join(repoRoot, 'docker-compose.observability.yml');

let cachedBinary: string | null = null;
let cachedBuildTmp: string | null = null;

export interface TelemetryBuildResult {
  binary: string;
  buildTmp: string;
  buildLog: string;
}

/**
 * Build the hub binary with `go build -trimpath` into a per-call temp
 * directory. Caches the result; call resetTelemetryHubBinary() to
 * force a rebuild. Matches the T2 harness API.
 */
export function buildTelemetryHubBinary(): TelemetryBuildResult {
  if (cachedBinary && cachedBuildTmp && existsSync(cachedBinary)) {
    return { binary: cachedBinary, buildTmp: cachedBuildTmp, buildLog: '' };
  }
  const buildTmp = mkdtempSync(join(tmpdir(), `hub-telemetry-${process.pid}-`));
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
export function resetTelemetryHubBinary(): void {
  if (cachedBuildTmp && existsSync(cachedBuildTmp)) {
    rmSync(cachedBuildTmp, { recursive: true, force: true });
  }
  cachedBinary = null;
  cachedBuildTmp = null;
}

// -----------------------------------------------------------------------------
// Per-invocation env wiring
// -----------------------------------------------------------------------------

export interface TelemetryRunOptions {
  /** Per-call env (merged on top of the cleaned process env). */
  envOverride?: Record<string, string>;
  /** Working directory (defaults to repo root). */
  cwd?: string;
  /** Optional fake-docker rig; if present, PATH + FAKE_DOCKER_* are wired. */
  fakeDocker?: FakeDockerRig;
  /** Optional exit code the fake shim should return this invocation. */
  fakeDockerExitCode?: number;
  /** Optional stdout append file the fake shim should replay. */
  fakeDockerStdoutAppend?: string;
  /** Optional stderr append file the fake shim should replay. */
  fakeDockerStderrAppend?: string;
  /** Optional canned `ps --format json` payload (non-`--all`). */
  fakeDockerPsJson?: string;
  /** Optional canned `ps --format json --all` payload. */
  fakeDockerPsAllJson?: string;
}

export interface TelemetryRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
  command: string;
  /** When fakeDocker was provided, the docker calls made during this run. */
  fakeDockerCalls?: Array<{
    ts: string;
    argv: string[];
    env_bearers: Record<string, string>;
    cwd: string;
  }>;
}

/**
 * Run the hub binary against a (optionally fake) docker. The harness
 * cleans the bearer-shaped + HUB_HOME / HUB_RUNTIME / HUB_OPENAPI
 * env keys so the test can opt-in explicitly. When fakeDocker is
 * supplied, PATH is rewritten so the Go telemetry's
 * `exec.LookPath("docker")` resolves to the shim.
 */
export async function runTelemetryHub(
  argv: readonly string[],
  options: TelemetryRunOptions = {},
): Promise<TelemetryRunResult> {
  const { binary } = buildTelemetryHubBinary();
  const cleanedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    cleanedEnv[k] = v;
  }
  for (const k of [
    'HUB_HOME',
    'HUB_RUNTIME',
    'HUB_OPENAPI',
    'HUB_BEARER_TOKEN',
    'HUB_BEARER_TOKEN_FILE',
    'HUB_BEARER_TOKEN_SOURCE',
    'HUB_ALLOW_HUB_DATA_REMOVAL',
    'PATH', // re-set below when fakeDocker is provided
  ]) {
    delete cleanedEnv[k];
  }
  cleanedEnv.CI = 'true';
  // HOME → per-call fresh temp so the XDG fallback is hermetic.
  const homeTmp = mkdtempSync(join(tmpdir(), `hub-telemetry-home-${process.pid}-`));
  cleanedEnv.HOME = homeTmp;
  cleanedEnv.XDG_DATA_HOME = homeTmp;

  // Default HUB_RUNTIME → the T5 top-level compose file. The Go
  // binary lives under os.tmpdir()/hub-telemetry-…/hub, so its own
  // repoRoot resolver walks 3 levels UP into a non-existent tmp
  // prefix. We MUST point Detect at the real compose file via
  // HUB_RUNTIME (which cmd/hub forwards as ComposeFile to Detect),
  // otherwise the Detect stat fails and every telemetry subcommand
  // exits 1. Tests that want to override compose-file can still
  // pass envOverride.HUB_RUNTIME; the harness never fabricates a
  // temp repo root (that would mask the very contract we are
  // asserting on — see cmd/hub/main.go's repoRoot resolution).
  if (!options.envOverride || options.envOverride.HUB_RUNTIME === undefined) {
    cleanedEnv.HUB_RUNTIME = repoComposeFile;
  }

  const merged: Record<string, string> = { ...cleanedEnv, ...(options.envOverride ?? {}) };

  if (options.fakeDocker) {
    const rig = options.fakeDocker;
    merged.PATH = `${rig.binDir}${process.env.PATH ? ':' + process.env.PATH : ''}`;
    merged.FAKE_DOCKER_LOG = rig.logPath;
    if (options.fakeDockerExitCode !== undefined) {
      merged.FAKE_DOCKER_EXIT = String(options.fakeDockerExitCode);
    }
    if (options.fakeDockerStdoutAppend) {
      merged.FAKE_DOCKER_STDOUT_APPEND = options.fakeDockerStdoutAppend;
    }
    if (options.fakeDockerStderrAppend) {
      merged.FAKE_DOCKER_STDERR_APPEND = options.fakeDockerStderrAppend;
    }
    if (options.fakeDockerPsJson) {
      merged.FAKE_DOCKER_PS_JSON = options.fakeDockerPsJson;
    }
    if (options.fakeDockerPsAllJson) {
      merged.FAKE_DOCKER_PS_ALL_JSON = options.fakeDockerPsAllJson;
    }
  }

  return await new Promise((resolveP) => {
    const child = spawn(binary, argv, {
      cwd: options.cwd ?? repoRoot,
      env: merged,
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
      let calls: TelemetryRunResult['fakeDockerCalls'];
      if (options.fakeDocker) {
        calls = options.fakeDocker.readCalls();
      }
      resolveP({
        status: code,
        signal: signal as NodeJS.Signals | null,
        stdout,
        stderr,
        error: spawnErr,
        command: `${binary} ${argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`,
        fakeDockerCalls: calls,
      });
    });
  });
}

// -----------------------------------------------------------------------------
// Fake docker rig — same surface as the T2 harness but trimmed to
// what T5 actually exercises (up / down / ps with `--all` and
// without). The T2 harness owns the comprehensive fake; we mirror
// the parts we use so a T5 regression that depends on a missing
// fake feature is impossible to land unnoticed. Adding a new
// canned payload here MUST also land in fake-docker.mjs's
// FAKE_DOCKER_* env contract.
// -----------------------------------------------------------------------------

export interface FakeDockerRig {
  /** Absolute path to the shim directory (prepended to PATH). */
  binDir: string;
  /** Absolute path to the fake docker executable. */
  shimPath: string;
  /** Absolute path to the JSONL transcript (one line per call). */
  logPath: string;
  /** Absolute path to a temp scratch directory for canned inputs. */
  scratchDir: string;
  /** Write canned `ps` JSON (use `--format json`). */
  writePsJson: (payload: string) => string;
  /** Write canned `ps --all` JSON. */
  writePsAllJson: (payload: string) => string;
  /** Read all recorded docker calls (parsed JSONL). */
  readCalls: () => Array<{
    ts: string;
    argv: string[];
    env_bearers: Record<string, string>;
    cwd: string;
  }>;
  /** Cleanup the rig (best-effort). */
  cleanup: () => void;
}

/**
 * Install a fake docker shim in a fresh temp dir and return the rig
 * handle. The shim body is sourced from the T2 fake-docker.mjs file
 * (single source of truth) so the test/shim envelope never drifts.
 * Tests typically create one per `it()` block.
 */
export function installFakeDocker(): FakeDockerRig {
  const binDir = mkdtempSync(join(tmpdir(), `hub-telemetry-fake-docker-${process.pid}-`));
  const scratchDir = mkdtempSync(join(tmpdir(), `hub-telemetry-fake-docker-scratch-${process.pid}-`));
  const shimPath = join(binDir, 'docker');
  const logPath = join(scratchDir, 'fake-docker.log');

  // The shim body is read from the T2 fake-docker.mjs sibling. We
  // deliberately reuse that script so any future flag-skip bug fix
  // (e.g. a new value-bearing short flag in
  // locateComposeVerb) lands in BOTH test surfaces. The T5
  // subcommands (`up` / `down` / `ps` / `logs`) are all in the
  // T2 KNOWN_COMPOSE_VERBS set, so the shim answers T5 verbs
  // identically.
  const t2Script = join(repoRoot, 'tests', 'go', 'runtime', 'fake-docker.mjs');
  if (!existsSync(t2Script)) {
    throw new Error(`_telemetry-harness: T2 fake-docker.mjs missing at ${t2Script}`);
  }
  const scriptPath = join(binDir, 'docker.mjs');
  writeFileSync(scriptPath, readFileSync(t2Script, 'utf8'), 'utf8');
  chmodSync(scriptPath, 0o644);

  // Wrapper: shell script that invokes node on docker.mjs.
  const wrapper = `#!/bin/sh\nexec node '${scriptPath}' "$@"\n`;
  writeFileSync(shimPath, wrapper, 'utf8');
  chmodSync(shimPath, 0o755);

  return {
    binDir,
    shimPath,
    logPath,
    scratchDir,
    writePsJson: (payload) => {
      const p = join(scratchDir, 'ps.json');
      writeFileSync(p, payload, 'utf8');
      return p;
    },
    writePsAllJson: (payload) => {
      const p = join(scratchDir, 'ps-all.json');
      writeFileSync(p, payload, 'utf8');
      return p;
    },
    readCalls: () => {
      if (!existsSync(logPath)) return [];
      const raw = readFileSync(logPath, 'utf8');
      const out: Array<{
        ts: string;
        argv: string[];
        env_bearers: Record<string, string>;
        cwd: string;
      }> = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t));
        } catch {
          // Tolerate stray lines; do not throw.
        }
      }
      return out;
    },
    cleanup: () => {
      try { rmSync(binDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// -----------------------------------------------------------------------------
// Misc helpers
// -----------------------------------------------------------------------------

export interface FreshRepoLayout {
  home: string;
  openapi: string;
  cleanup: () => void;
}

/**
 * Allocate a per-test fresh HUB_HOME and point HUB_OPENAPI at the
 * real repo's openapi/openapi.yaml so the config loader never
 * silently falls back to a missing path.
 */
export function freshTelemetryHome(label: string): FreshRepoLayout {
  const home = mkdtempSync(join(tmpdir(), `hub-telemetry-${label}-${process.pid}-`));
  const openapi = join(repoRoot, 'openapi', 'openapi.yaml');
  return {
    home,
    openapi,
    cleanup: () => {
      if (existsSync(home)) {
        try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  };
}

export { repoRoot, repoComposeFile };