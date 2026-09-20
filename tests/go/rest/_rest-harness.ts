// tests/go/rest/_rest-harness.ts
//
// Shared subprocess harness for the T6 curated-REST-client test
// suite (tests/go/rest/auth.test.ts + token-reader.test.ts). The
// harness spawns the REAL Go test binary under the repo's Go
// module (which lives the test files at tests/go/rest/*_test.go
// next to the TS files in this same directory) — vitest owns the
// process; the Go `testing` package owns the assertions.
//
// Architecture: T6 is a Go-only deliverable (internal/rest/*.go)
// but the test contract specifies .test.ts filenames. Rather than
// fake-PASS, we run the Go tests through `go test -count=1` from a
// spawned child process. Each TS test case:
//
//   1. Builds (caches) the Go test binary with `go test -c -o ...`
//      so the package compiles once per vitest worker.
//   2. Runs the binary with a per-case `-run` filter, scoped
//      subtests via `-test.run` so a single table row drives a
//      single subtest.
//   3. Captures stdout/stderr/exit and asserts on exit code 0
//      with NO test FAIL lines on stderr.
//
// The harness never calls `go test` with -- -run for subtests
// without compiling first because compilation failures would
// otherwise be reported as test failures. The compile step is
// cached per-process and cleared by resetRestTest() so a source
// edit between vitest workers does not silently leak stale state.
//
// The Go test files under tests/go/rest/*_test.go drive the real
// httptest.Server fixtures; the TS files only own the subprocess
// boundary. This is the only honest way to satisfy ".test.ts
// naming" alongside "real tests with httptest.Server, not fake
// PASS".

import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// `here` is tests/go/rest — three `..` hops land at the repo
// root (the directory holding cmd/, internal/, go.mod).
const repoRoot = resolve(here, '..', '..', '..');
// tests/go/rest is the directory Go will compile + run tests from.
const goTestDir = here;

// Cached Go test binary. Cleared by resetRestTest() when a caller
// wants to force a re-compile.
let cachedTestBinary: string | null = null;
let cachedTestTmp: string | null = null;

export interface RestTestBuildResult {
  binary: string;
  buildTmp: string;
  buildLog: string;
}

/**
 * Compile the Go tests at tests/go/rest/*_test.go into a runnable
 * test binary at <tmp>/rest.test. The binary is the canonical
 * `go test` artifact; running it directly skips the `go test`
 * driver so the subprocess invocation is hermetic and
 * deterministic.
 *
 * We compile with `go test -c` (not `go build`) because the
 * `-c` flag produces a self-contained test binary that bundles
 * the testing package and matches what `go test` would have
 * invoked. This is the same binary `go test ./tests/go/rest`
 * would spawn.
 */
export function buildRestTestBinary(): RestTestBuildResult {
  if (cachedTestBinary && cachedTestTmp && existsSync(cachedTestBinary)) {
    return { binary: cachedTestBinary, buildTmp: cachedTestTmp, buildLog: '' };
  }
  const buildTmp = mkdtempSync(join(tmpdir(), `hub-rest-test-${process.pid}-`));
  const binary = join(buildTmp, 'rest.test');
  const res: SpawnSyncReturns<string> = spawnSync('go', [
    'test',
    '-trimpath',
    '-c',
    '-o', binary,
    './tests/go/rest',
  ], {
    cwd: repoRoot,
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(
      `go test -c failed (status=${res.status})\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
    );
  }
  if (!existsSync(binary)) {
    throw new Error(`go test -c succeeded but binary missing at ${binary}`);
  }
  cachedTestBinary = binary;
  cachedTestTmp = buildTmp;
  return { binary, buildTmp, buildLog: `${res.stdout}\n${res.stderr}` };
}

/** Clear the cached test binary. Tests that mutate Go source
 * between vitest runs call this so the next compile picks up the
 * change. */
export function resetRestTest(): void {
  if (cachedTestTmp && existsSync(cachedTestTmp)) {
    rmSync(cachedTestTmp, { recursive: true, force: true });
  }
  cachedTestBinary = null;
  cachedTestTmp = null;
}

export interface RestTestRunResult {
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
export async function runRestTest(
  args: readonly string[],
  envOverride: Record<string, string> = {},
): Promise<RestTestRunResult> {
  const { binary } = buildRestTestBinary();
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
