// Real-subprocess contract for the MCP stdio launcher (supervisor).
// The Go test file at tests/go/mcp/spawn-forward_test.go is the source
// of truth for every assertion; this TS file is a thin wrapper so the
// suite runs under vitest as a real subprocess with hermetic fixtures.
//
// Strategy mirrors tests/go/rest/auth.test.ts:
//   1. Compile the Go tests via _mcp-harness.ts (one `go test -c` per
//      vitest worker, cached).
//   2. Spawn the resulting binary with `-test.v -test.run <name>`.
//   3. Assert on exit code 0 and absence of FAIL lines on stderr.
//
// The Go test file uses a hermetic FAKE external MCP (an embedded Node
// fixture) that speaks JSON-RPC frames over stdio. The fake MCP never
// touches packages/mcp/** or the real REST surface: these tests cover
// the supervisor only, and the TS MCP is replaced by a fake.

import { describe, expect, it } from 'vitest';
import { runMcpTest } from './_mcp-harness';

// The Go test names below MUST match the top-level Test* names in
// tests/go/mcp/spawn-forward_test.go. Each TS `it` drives a single Go
// subtest; failures inside the Go binary abort early and surface
// verbatim through stderr.
const GO_SPAWN_TESTS = [
  // The supervisor must spawn a TypeScript MCP-shaped process (the
  // fixture), wire its stdin to the supervisor's stdin, and forward
  // whatever the supervisor writes on stdin to the fixture verbatim.
  'TestSpawn_ForwardsStdinToChild',
  'TestSpawn_ForwardsChildStdoutToParentStdout',
  // The supervisor must forward child stderr to its own stderr with
  // no payload transformation — a literal byte-for-byte copy.
  'TestSpawn_ForwardsChildStderrVerbatim',
  // The supervisor must NOT decode/re-encode the JSON-RPC frames. A
  // framed "echo" frame from the fixture must round-trip byte-exact.
  'TestSpawn_PreservesJsonRpcFrameBytes',
  // The supervisor must not buffer or coalesce the stream: each write
  // is flushed through independently.
  'TestSpawn_DoesNotCoalesceWrites',
  // The supervisor must hand back the child PID so an external
  // supervisor (test harness) can introspect lifecycle.
  'TestSpawn_ExposesChildPID',
];

describe('mcp supervisor — spawn and stdio forwarding', () => {
  for (const name of GO_SPAWN_TESTS) {
    const itName = name.replace(/[/_]/g, '_');
    it(itName, async () => {
      const res = await runMcpTest(['-test.run', `^${name}$`]);
      expect(res.status, `go test exited non-zero\nstderr: ${res.stderr}`).toBe(0);
      expect(res.stderr).not.toMatch(new RegExp(`--- FAIL:.*${name}`));
    }, 60_000);
  }
});
