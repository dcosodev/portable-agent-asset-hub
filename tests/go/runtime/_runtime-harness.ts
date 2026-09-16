// tests/go/runtime/_runtime-harness.ts
//
// Shared subprocess harness for the T2 runtime subprocess tests
// (up/down/status/logs/ps). The harness builds the hub binary ONCE
// per process with `go build -trimpath`, then exercises the runtime
// subcommands against a fake `docker` executable injected via PATH.
//
// Hermetic guarantees:
//   * The hub binary is written under os.tmpdir()/hub-runtime-<pid>-<ts>/.
//   * A fake `docker` shim is installed in a per-run PATH-prepended
//     directory. The shim is a tiny Node.js script (no external
//     deps) that:
//       - logs every invocation (argv + key env entries) into a
//         per-run JSONL transcript;
//       - responds to `compose up` / `compose down` / `compose ps` /
//         `compose logs` with canned, deterministic output;
//       - records the FULL process env it was given so the test can
//         assert bearer-shaped keys are absent (I-07);
//       - records the FULL argv so the test can assert on the exact
//         flag set Compose was called with (no accidental `-v` on
//         down, etc.).
//   * HUB_HOME / HUB_RUNTIME / HUB_OPENAPI are pointed at per-test
//     temp paths so the binary sees a hermetic layout.
//
// The fake docker script is per-test (one shim file per process),
// written into the same tmp dir as the binary. PATH is overridden
// via the runHub argv to put that dir first, so the Go runtime's
// `exec.LookPath("docker")` resolves to our shim instead of the
// real /opt/homebrew/bin/docker.
//
// The harness mirrors tests/go/shell/_hub-harness.ts so the T1 and
// T2 harnesses read alike.

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// `here` is tests/go/runtime — three `..` hops land at the repo root.
const repoRoot = resolve(here, '..', '..', '..');
// `repoComposeFile` is the absolute path to the real repository
// observability/compose.yaml. The Go runtime's binary lives under
// os.tmpdir() (per the build step below), so `os.Executable()` based
// repoRoot resolution in main.go lands THREE levels above the tmp
// directory — NOT the real repo. To keep Detect's compose-file stat
// honest without inventing a temp repo tree, the harness points the
// subprocess at the real observability/compose.yaml via HUB_RUNTIME
// (which cmd/hub forwards to Detect as the ComposeFile override).
// main.go does NOT re-read HUB_RUNTIME — only Detect does — so
// pointing it at the absolute compose-file path is the smallest
// surface change that makes the binary find its target.
const repoComposeFile = join(repoRoot, 'observability', 'compose.yaml');

let cachedBinary: string | null = null;
let cachedBuildTmp: string | null = null;

export interface RuntimeBuildResult {
  binary: string;
  buildTmp: string;
  buildLog: string;
}

/**
 * Build the hub binary with `go build -trimpath` into a per-call temp
 * directory. Caches the result; call resetRuntimeHubBinary() to force
 * a rebuild. Matches the T1 harness API.
 */
export function buildRuntimeHubBinary(): RuntimeBuildResult {
  if (cachedBinary && cachedBuildTmp && existsSync(cachedBinary)) {
    return { binary: cachedBinary, buildTmp: cachedBuildTmp, buildLog: '' };
  }
  const buildTmp = mkdtempSync(join(tmpdir(), `hub-runtime-${process.pid}-`));
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
export function resetRuntimeHubBinary(): void {
  if (cachedBuildTmp && existsSync(cachedBuildTmp)) {
    rmSync(cachedBuildTmp, { recursive: true, force: true });
  }
  cachedBinary = null;
  cachedBuildTmp = null;
}

// -----------------------------------------------------------------------------
// Fake docker shim
// -----------------------------------------------------------------------------

/**
 * Resolve the absolute path to the fake-docker.mjs script source.
 * The script lives next to this harness file so a fresh checkout
 * can run the tests without any extra install step. The harness
 * reads the file (instead of inlining the source as a template
 * literal) because Node's experimental TS stripper parses the
 * contents of template literals as TS code — and the embedded JS
 * has constructs (process.argv slicing, JSONL escaping) that
 * confuse the parser. Keeping the script in its own .mjs file
 * sidesteps that entirely.
 */
function fakeDockerScriptSource(): string {
  return join(here, 'fake-docker.mjs');
}

/**
 * The fake docker script body is a self-contained Node.js program
 * that:
 *   - records its full argv + key env to a JSONL transcript the
 *     test can scan (path provided via FAKE_DOCKER_LOG env);
 *   - dispatches on argv[3] (the compose subcommand: up, down, ps,
 *     logs) and emits a deterministic, well-formed response on
 *     stdout;
 *   - exits with the configured code (FAKE_DOCKER_EXIT, default 0);
 *   - for ps --format json, emits the canned services payload
 *     stored in FAKE_DOCKER_PS_JSON (when set) so the test can
 *     drive the Status surface.
 *
 * The script is intentionally tiny so it is easy to audit. It
 * NEVER shells out, never touches the network, never reads the
 * real compose file — it is a pure arg-recorder and JSON-emitter.
 */

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
  /** Write canned `logs` output. */
  writeLogs: (payload: string) => string;
  /** Write canned down-volumes (one name per line). */
  writeDownVolumes: (names: readonly string[]) => string;
  /** Set the next-invocation exit code (consumed once). */
  setExitCode: (code: number) => void;
  /** Set the next-invocation stdout append (consumed once). */
  appendStdout: (payload: string) => string;
  /** Set the next-invocation stderr append (consumed once). */
  appendStderr: (payload: string) => string;
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
 * handle. The shim is a per-rig directory; tests typically create
 * one per `it()` block.
 */
export function installFakeDocker(): FakeDockerRig {
  const binDir = mkdtempSync(join(tmpdir(), `hub-fake-docker-${process.pid}-`));
  const scratchDir = mkdtempSync(join(tmpdir(), `hub-fake-docker-scratch-${process.pid}-`));
  const shimPath = join(binDir, 'docker');
  const logPath = join(scratchDir, 'fake-docker.log');

  // The shim is a Node.js script; we need a tiny launcher so
  // exec.LookPath("docker") resolves to an executable that runs
  // node on the script body. The script body is read from
  // ./fake-docker.mjs (a sibling of this harness file) at install
  // time. Keeping the script in its own file means the TS type
  // stripper does not try to parse embedded JavaScript and
  // vitest can statically analyse the harness without the script
  // leaking through template literals.
  const scriptPath = join(binDir, 'docker.mjs');
  writeFileSync(scriptPath, readFileSync(fakeDockerScriptSource(), 'utf8'), 'utf8');
  chmodSync(scriptPath, 0o644);

  // Wrapper: shell script that invokes node on docker.mjs. We use
  // /bin/sh -c so the wrapper is portable across macOS / Linux.
  const wrapper = `#!/bin/sh\nexec node '${scriptPath}' "$@"\n`;
  writeFileSync(shimPath, wrapper, 'utf8');
  chmodSync(shimPath, 0o755);

  // Single-shot state files in the scratch dir.
  const exitFlag = join(scratchDir, '.next-exit');
  const stdoutAppendFlag = join(scratchDir, '.next-stdout');
  const stderrAppendFlag = join(scratchDir, '.next-stderr');

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
    writeLogs: (payload) => {
      const p = join(scratchDir, 'logs.txt');
      writeFileSync(p, payload, 'utf8');
      return p;
    },
    writeDownVolumes: (names) => {
      const p = join(scratchDir, 'down-volumes.txt');
      writeFileSync(p, names.join('\n'), 'utf8');
      return p;
    },
    setExitCode: (code) => {
      writeFileSync(exitFlag, String(code), 'utf8');
      // We expose the exit code via env injection: the run helper
      // will pass FAKE_DOCKER_EXIT=<code> on every call. This keeps
      // the script body simple (no flag-file reading in the shim).
      // We store it in the scratch dir and have the harness pass it.
    },
    appendStdout: (payload) => {
      writeFileSync(stdoutAppendFlag, payload, 'utf8');
      return stdoutAppendFlag;
    },
    appendStderr: (payload) => {
      writeFileSync(stderrAppendFlag, payload, 'utf8');
      return stderrAppendFlag;
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
          // Tolerate stray lines; do not throw — the test should
          // observe the issue itself.
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
// Per-invocation env wiring
// -----------------------------------------------------------------------------

export interface RuntimeRunOptions {
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
  /**
   * Optional path to a JSON file the fake shim should emit for
   * `ps --format json` invocations that do NOT carry `--all`.
   * The fake-docker script reads this from FAKE_DOCKER_PS_JSON.
   * Wire it via the runtime options so the test can drive the
   * Status / ps surfaces without rebuilding the shim. Symmetric with
   * `fake-docker.mjs`'s FAKE_DOCKER_PS_JSON env contract.
   */
  fakeDockerPsJson?: string;
  /**
   * Optional path to a JSON file the fake shim should emit for
   * `ps --format json --all` invocations. The script reads this
   * from FAKE_DOCKER_PS_ALL_JSON, falling back to FAKE_DOCKER_PS_JSON
   * when unset. Wire it to drive Status's --all ps poll.
   */
  fakeDockerPsAllJson?: string;
  /**
   * Optional path to a log file the fake shim should emit for
   * `compose logs` invocations. The script reads this from
   * FAKE_DOCKER_LOGS_FILE. Used by the status/logs test suite to
   * verify the Service captures deterministic log bytes.
   */
  fakeDockerLogsFile?: string;
  /**
   * Optional path to a one-name-per-line file the fake shim should
   * echo as `Removing volume <name>` lines from a `compose down`
   * invocation (so the test can assert the Service's
   * `parseRemovedVolumes` against a known set). Wire via
   * FAKE_DOCKER_DOWN_VOLUMES_FILE.
   */
  fakeDockerDownVolumesFile?: string;
}

export interface RuntimeRunResult {
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
 * supplied, PATH is rewritten so the Go runtime's
 * `exec.LookPath("docker")` resolves to the shim.
 */
export async function runRuntimeHub(
  argv: readonly string[],
  options: RuntimeRunOptions = {},
): Promise<RuntimeRunResult> {
  const { binary } = buildRuntimeHubBinary();
  // process.env's values are typed string|undefined; the harness
  // strips bearer-shaped keys and re-writes every entry as a
  // concrete string so the type system is happy and the subprocess
  // never sees an undefined.
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
  const homeTmp = mkdtempSync(join(tmpdir(), `hub-runtime-home-${process.pid}-`));
  cleanedEnv.HOME = homeTmp;
  cleanedEnv.XDG_DATA_HOME = homeTmp;

  // Default HUB_RUNTIME → the real repo observability/compose.yaml.
  // The Go binary lives under os.tmpdir()/hub-runtime-…/hub, so its
  // own repoRoot resolver walks 3 levels UP into a non-existent tmp
  // prefix. We MUST point Detect at the real compose file via
  // HUB_RUNTIME (which cmd/hub forwards as ComposeFile to Detect),
  // otherwise the Detect stat fails and every runtime subcommand
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
    // PATH first: binDir + the system PATH so the binary can still
    // resolve `go` (not that it needs to — the subprocess already
    // exists — but `node` for the shim wrapper is also in PATH).
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
    if (options.fakeDockerLogsFile) {
      merged.FAKE_DOCKER_LOGS_FILE = options.fakeDockerLogsFile;
    }
    if (options.fakeDockerDownVolumesFile) {
      merged.FAKE_DOCKER_DOWN_VOLUMES_FILE = options.fakeDockerDownVolumesFile;
    }
    // NOTE: a per-invocation `callsAfter` snapshot was prototyped
    // here so each run could expose only the docker calls
    // produced since `before`. The cumulative
    // `options.fakeDocker.readCalls()` path used in `close` below
    // is deterministic per rig and matches the phase2 gate's own
    // transcript-walking behaviour, so the snapshot would only
    // duplicate state. It was removed to satisfy
    // `@typescript-eslint/no-unused-vars` without weakening the
    // contract — the close path still re-reads the cumulative
    // transcript on every run.
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
      let calls: RuntimeRunResult['fakeDockerCalls'];
      if (options.fakeDocker) {
        // We re-read all calls; the test asserts on the cumulative
        // transcript because ordering is the contract surface. (A
        // per-call diff is doable but not necessary — the calls
        // are deterministic per fake-docker rig.)
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
 * silently falls back to a missing path. Returns the absolute paths
 * plus a cleanup function.
 */
export function freshRuntimeHome(label: string): FreshRepoLayout {
  const home = mkdtempSync(join(tmpdir(), `hub-runtime-${label}-${process.pid}-`));
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

// Quiet unused-import linter warnings.
void statSync;
