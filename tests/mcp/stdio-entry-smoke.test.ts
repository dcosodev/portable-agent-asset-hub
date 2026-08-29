// tests/mcp/stdio-entry-smoke.test.ts
//
// Focused process-level smoke for the compiled stdio entrypoint at
// `dist/packages/mcp/stdio-entry.js`, reached via the published bin
// shim `packages/mcp/bin/agent-memory-mcp.mjs`. Sister to
// `tests/mcp/stdio-smoke.test.ts`, which exercises the in-package
// `startMcpServer` directly; this test exercises the *real* entrypoint
// contract:
//
//   1. Launch the bin shim as a child process bound to stdio.
//   2. Verify the JSON-RPC handshake (initialize, tools/list) succeeds
//      and that stdout is clean (only JSON-RPC frames, no diagnostic
//      noise) and stderr never echoes the bearer token even when one
//      is provided in the environment.
//   3. Re-launch the bin shim with `AGENT_MEMORY_REST_URL` unset and
//      verify it exits non-zero with a diagnostic on stderr — and
//      again, no token text anywhere, even though
//      `AGENT_MEMORY_BEARER_TOKEN` is set in the environment.
//
// We use a real in-process REST server (the same `listen()` fixture
// the existing stdio smoke uses) so the child process has something
// legitimate to talk to on the loopback interface. No OpenAI, no
// external network, no credentials — the bearer token value used in
// the happy-path case is a distinctive, opaque sentinel string the
// test asserts does *not* leak into stderr.
//
// The temp artefact (the `.tmp-s7-mcp-entry-*` directory) is created in
// `beforeAll` and torn down in `afterAll` with `rmSync` inside
// `finally`-style guards. It lives next to the existing
// `.tmp-s7-mcp-*` fixtures from `stdio-smoke.test.ts` so the lint
// ignore pattern `.tmp-*/` covers them too.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { listen, type RestHub } from '@portable-agent-asset-hub/rest';
import { createActorContext, type ActorContext } from '@portable-agent-asset-hub/core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
// The compiled stdio entry — what the bin shim imports at runtime.
// `pnpm test`'s `pretest` hook runs `pnpm build`, so by the time this
// test runs the compiled artifact is guaranteed to be on disk; we
// still fail fast with a clear error if it is missing.
const entryDist = join(repoRoot, 'dist/packages/mcp/stdio-entry.js');
// The bin shim that stdio clients (OpenClaw, Claude Desktop, etc.)
// actually invoke. The test must spawn this — not a synthesised entry —
// because the integration we are validating is the contract between
// the bin field in `package.json` and the env-var reader in
// `stdio-entry.ts`.
const binShim = join(repoRoot, 'packages/mcp/bin/agent-memory-mcp.mjs');
// The compiled MCP server imports its workspace dependencies by bare
// specifier, and Node's ESM resolver only walks up ancestor
// `node_modules` directories of the importing file. The package's build
// step therefore runs `scripts/sync-workspace-deps.mjs mcp`, which links
// them under `dist/packages/mcp/node_modules/@portable-agent-asset-hub/`.
// This test relies on `pnpm build` having run; it no longer installs its
// own fixture links, which used to race with `stdio-smoke.test.ts`.

const fixtures = {
  health: { ok: true },
  status: { ok: true, service: 'portable-agent-asset-hub' },
};

// The bearer token used in both subtests is a distinctive, opaque
// sentinel. Asserting it does *not* appear in stderr is the whole
// point of these subtests — the entrypoint must redact secrets on
// every code path, including the refusal path.
const bearerTokenSentinel = 'stdio-entry-bearer-do-not-leak-9f3a';

const actor: ActorContext = createActorContext({
  userId: 'usr_stdio_entry',
  agentId: 'agt_stdio_entry',
  role: 'user',
  capabilities: ['read', 'write.memory'],
});

let base = '';
let server: Awaited<ReturnType<typeof listen>>;
let mcpEntryDir = '';

beforeAll(async () => {
  if (!existsSync(entryDist)) {
    throw new Error(
      `compiled stdio entry missing at ${entryDist}; run \`pnpm build\` before the test suite (pretest hook handles this).`,
    );
  }
  if (!existsSync(binShim)) {
    throw new Error(`bin shim missing at ${binShim}; expected \`bin/agent-memory-mcp.mjs\` in \`packages/mcp\`.`);
  }

  // Boot the REST server in the parent process so the MCP child can
  // talk to it on the loopback interface. Same dispatch fixture shape
  // as `tests/mcp/stdio-smoke.test.ts` — only the operations exercised
  // by the handshake need to be implemented.
  server = await listen({
    host: '127.0.0.1',
    port: 0,
    hub: {
      dispatch: ((operation: string) => {
        if (operation === 'getHealth') return fixtures.health;
        return null;
      }) satisfies RestHub['dispatch'],
    },
    localMode: true,
    localActor: actor,
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;

  // Reserve the temp dir up front so `afterAll` can clean it even if
  // an assertion fails before the test body runs. The directory is
  // also the per-run scratch space for the bin shim's child process
  // (the `.tmp-*/` ignore pattern keeps `pnpm lint` happy).
  mcpEntryDir = mkdtempSync(join(repoRoot, '.tmp-s7-mcp-entry-'));
});

afterAll(async () => {
  if (server) await new Promise<void>((res) => server.close(() => res()));
  // Always wipe our per-run scratch directory.
  if (mcpEntryDir) rmSync(mcpEntryDir, { force: true, recursive: true });
});

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function sendRpc(child: ChildProcessWithoutNullStreams, request: object): Promise<JsonRpcResponse> {
  child.stdin.write(JSON.stringify(request) + '\n');
  const [line] = (await once(child.stdout, 'data')) as [Buffer];
  return JSON.parse(line.toString('utf8').trim()) as JsonRpcResponse;
}

async function killChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.killed) child.kill('SIGTERM');
  // Best-effort drain so the child exits before the next test
  // starts; failures here do not affect the test outcome — they are
  // surfaced by the assertions above.
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise<void>((res) => setTimeout(res, 1000)),
  ]);
}

function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Hand the child a clean env so a developer-exported
  // `AGENT_MEMORY_BEARER_TOKEN` cannot silently turn the missing-URL
  // subtest into a happy path. We only carry PATH / NODE-related
  // vars the child needs to bootstrap.
  return {
    PATH: process.env.PATH,
    NODE_PATH: process.env.NODE_PATH,
    ...extra,
  };
}

describe('MCP stdio entrypoint (compiled) — focused process smoke', () => {
  it('handshake: initialize + tools/list emit clean JSON-RPC and never leak the bearer token', async () => {
    const child = spawn(process.execPath, [binShim], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({
        AGENT_MEMORY_REST_URL: base,
        AGENT_MEMORY_BEARER_TOKEN: bearerTokenSentinel,
        AGENT_MEMORY_CAPABILITIES: 'read,write.memory',
      }),
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));

    try {
      const initialize = await sendRpc(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'stdio-entry-smoke', version: '0.0.0' },
        },
      });
      expect(initialize.error).toBeUndefined();
      const initResult = initialize.result as { serverInfo?: { name?: string } };
      expect(initResult.serverInfo?.name).toBe('portable-agent-asset-hub-mcp');

      const tools = await sendRpc(child, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      });
      expect(tools.error).toBeUndefined();
      const toolList = (tools.result as { tools: Array<{ name: string }> }).tools;
      const toolNames = toolList.map((t) => t.name);
      // `tools/list` must surface at least one tool for the fixture
      // capabilities (`read`, `write.memory`) — the exact set is owned
      // by the registry and verified by `tool-registry.test.ts`; here
      // we just assert the response shape is well-formed.
      expect(Array.isArray(toolNames)).toBe(true);
      expect(toolNames.length).toBeGreaterThan(0);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      // Every stdout line we captured must be parseable JSON-RPC —
      // no log noise, no banner, no prompt. The bin shim contract
      // reserves stdout exclusively for JSON-RPC frames.
      const stdoutLines = stdout.split('\n').filter((line) => line.trim().length > 0);
      expect(stdoutLines.length).toBeGreaterThan(0);
      for (const line of stdoutLines) {
        const parsed = JSON.parse(line) as { jsonrpc?: string };
        expect(parsed.jsonrpc).toBe('2.0');
      }

      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      // The bearer token must never appear on stderr — not even as a
      // length hint, not even when it is set in the environment.
      expect(stderr).not.toContain(bearerTokenSentinel);
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it('missing AGENT_MEMORY_REST_URL: non-zero exit, diagnostic on stderr, no bearer token leaked', async () => {
    // The bearer token is set even though the REST URL is missing —
    // the entrypoint contract must refuse to start without a URL
    // regardless of how many other env vars are present, and the
    // refusal message must not echo the token.
    const child = spawn(process.execPath, [binShim], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv({
        AGENT_MEMORY_BEARER_TOKEN: bearerTokenSentinel,
      }),
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));

    const [exitCode, signalCode] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];

    // `runStdioEntry` returns exit code 2 for the missing-URL
    // pre-flight failure; the bin shim propagates that exit code
    // because the entry function never throws across the boundary.
    // The invariant we care about is "the process never silently
    // succeeds when the URL is absent" — the exact code is owned by
    // `stdio-entry.ts` and could change in the future.
    expect(signalCode).toBeNull();
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);

    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    // The diagnostic must mention the missing env var by name so an
    // operator reading the host's log surface can find the cause.
    expect(stderrText).toContain('AGENT_MEMORY_REST_URL');

    // Most importantly: the bearer token must not leak into stderr,
    // even when the entrypoint is refusing to start.
    expect(stderrText).not.toContain(bearerTokenSentinel);

    // Stdout must be empty for the missing-URL failure path — the
    // process never reaches the JSON-RPC loop, so no frame should
    // have been written to stdout.
    const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
    expect(stdoutText).toBe('');
  }, 30_000);
});