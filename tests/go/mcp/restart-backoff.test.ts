// tests/go/mcp/restart-backoff.test.ts
//
// T7 real-subprocess contract for the MCP stdio supervisor's bounded
// restart/backoff behaviour. The Go test file
// tests/go/mcp/restart-backoff_test.go is the source of truth for
// every assertion; this TS file is the thin subprocess wrapper
// required by the slice contract (.test.ts naming + real subprocess +
// hermetic fixtures).
//
// Strategy mirrors tests/go/rest/auth.test.ts:
//   1. Compile the Go tests via _mcp-harness.ts (one `go test -c` per
//      vitest worker, cached).
//   2. Spawn the resulting binary with `-test.v -test.run <name>`.
//   3. Assert on exit code 0 and absence of FAIL lines on stderr.
//
// Each Go test drives the supervisor with a FAKE external MCP whose
// exit-on-N pattern is fully deterministic; the supervisor's
// backoff loop, child bookkeeping, and signal propagation are
// observable through the supervisor's structured stderr log.

import { describe, expect, it } from 'vitest';
import { runMcpTest } from './_mcp-harness';

const GO_BACKOFF_TESTS = [
  // On child exit, the supervisor must restart with a bounded
  // exponential backoff (50ms → 100ms → 200ms, capped) — no thundering
  // herd (no fixed-zero delay, no unbounded growth).
  'TestRestart_BoundedExponentialBackoff',
  // After max restarts, the supervisor must give up and exit non-zero
  // — never spin forever in a busy loop.
  'TestRestart_MaxAttemptsExhaustedExitsNonZero',
  // Successful child exit (clean shutdown via stdin close) must NOT
  // trigger a restart; the supervisor exits 0 in lock-step with the
  // child.
  'TestRestart_CleanChildExitDoesNotRespawn',
  // SIGINT to the supervisor must propagate to the child and then
  // exit the supervisor cleanly. The child must receive the signal
  // before the supervisor returns.
  'TestSignals_SIGINTPropagatesToChildAndExits',
  // SIGTERM must propagate to the child too; the contract is
  // "every signal the supervisor handles, the child sees".
  'TestSignals_SIGTERMPropagatesToChild',
  // The supervisor must REDACT bearer-shaped strings before they hit
  // its own stderr — a fake bearer in the child's stderr (an obvious
  // red-team vector) must surface as <<REDACTED>>.
  'TestRedact_BearerShapedChildStderrIsRedacted',
  // The supervisor's own diagnostic lines that quote the bearer env
  // must redact the value (so `hub mcp launch --stdio` never leaks
  // HUB_BEARER_TOKEN to stderr).
  'TestRedact_BearerEnvDiagnosticIsRedacted',
];

describe('mcp supervisor — restart/backoff and signals', () => {
  for (const name of GO_BACKOFF_TESTS) {
    const itName = name.replace(/[/_]/g, '_');
    it(itName, async () => {
      const res = await runMcpTest(['-test.run', `^${name}$`]);
      expect(res.status, `go test exited non-zero\nstderr: ${res.stderr}`).toBe(0);
      expect(res.stderr).not.toMatch(new RegExp(`--- FAIL:.*${name}`));
    }, 60_000);
  }
});
