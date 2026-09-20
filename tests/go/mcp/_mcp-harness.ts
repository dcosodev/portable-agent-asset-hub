// tests/go/mcp/_mcp-harness.ts
//
// Shared subprocess harness for the T7 MCP supervisor test suite
// (tests/go/mcp/spawn-forward.test.ts + restart-backoff.test.ts).
// The harness builds the Go test binary ONCE per vitest worker via
// `go test -c` into a per-suite temp directory, and exposes a small
// runner that captures stdout, stderr, and exit code.
//
// Architecture mirrors tests/go/rest/_rest-harness.ts:
//   * Compile once per vitest worker (`go test -c -o <tmp>/mcp.test`).
//   * Run with `-test.v -test.count=1` and a `-test.run <regex>` so
//     one TS `it` drives one Go subtest.
//   * Capture stdout/stderr/exit; assert on exit 0 and absence of
//     FAIL lines on stderr.
//
// The Go tests live at tests/go/mcp/*_test.go (the package being
// tested is hub/internal/mcp) and the harness NEVER compiles the
// hub binary — it only compiles the Go test package and drives it.
// The Go test file in turn uses a FAKE Node child process as the
// "external MCP" (spawned via `node -e …`); that fake child is
// hermetic and never touches packages/mcp/**.

import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from 'node:child_process';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// `here` resolves to tests/go/mcp — three `..` hops land at the repo
// root (the directory holding cmd/, internal/, go.mod).
const repoRoot = resolve(here, '..', '..', '..');

// tests/go/mcp is the directory Go will compile + run tests from.
const goTestDir = here;

let cachedTestBinary: string | null = null;
let cachedTestTmp: string | null = null;

export interface McpTestBuildResult {
  binary: string;
  buildTmp: string;
  buildLog: string;
}

/**
 * Compile the Go tests at tests/go/mcp/*_test.go into a runnable
 * test binary at <tmp>/mcp.test. The binary is the canonical
 * `go test` artifact; running it directly skips the `go test`
 * driver so the subprocess invocation is hermetic and
 * deterministic.
 *
 * We compile with `go test -c` (not `go build`) because the
 * `-c` flag produces a self-contained test binary that bundles
 * the testing package and matches what `go test` would have
 * invoked.
 */
export function buildMcpTestBinary(): McpTestBuildResult {
  if (cachedTestBinary && cachedTestTmp && existsSync(cachedTestBinary)) {
    return { binary: cachedTestBinary, buildTmp: cachedTestTmp, buildLog: '' };
  }
  const buildTmp = mkdtempSync(join(tmpdir(), `hub-mcp-test-${process.pid}-`));
  const binary = join(buildTmp, 'mcp.test');
  const res: SpawnSyncReturns<string> = spawnSync('go', [
    'test',
    '-trimpath',
    '-c',
    '-o', binary,
    './tests/go/mcp',
  ], {
    cwd: repoRoot,
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(
      `go test -c failed (status=${res.status})\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  if (!existsSync(binary)) {
    throw new Error(`go test -c succeeded but binary missing at ${binary}`);
  }
  cachedTestBinary = binary;
  cachedTestTmp = buildTmp;
  return { binary, buildTmp, buildLog: `${res.stdout}\n${res.stderr}` };
}

/**
 * Clear the cached test binary. Tests that mutate Go source
 * between vitest runs call this so the next compile picks up the
 * change.
 */
export function resetMcpTest(): void {
  if (cachedTestTmp && existsSync(cachedTestTmp)) {
    rmSync(cachedTestTmp, { recursive: true, force: true });
  }
  cachedTestBinary = null;
  cachedTestTmp = null;
}

export interface McpTestRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
  command: string;
}

/**
 * Run the compiled Go test binary with the given args. Default
 * args include `-test.v -test.count=1` so subtest output is
 * captured verbatim and the cache is bypassed.
 *
 * The caller may pass a `-test.run <regex>` to scope to a single
 * subtest — this is how the TS test cases drive one table row at
 * a time.
 */
export async function runMcpTest(
  args: readonly string[],
  envOverride: Record<string, string> = {},
): Promise<McpTestRunResult> {
  const { binary } = buildMcpTestBinary();
  const argv: string[] = ['-test.v', '-test.count=1', ...args];
  return await new Promise((resolveP) => {
    const child = spawn(binary, argv, {
      cwd: goTestDir,
      env: { ...process.env, CI: 'true', ...envOverride },
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
        command: `${binary} ${argv.join(' ')}`,
      });
    });
  });
}

export { repoRoot };
