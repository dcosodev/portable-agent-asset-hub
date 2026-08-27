// packages/mcp/src/stdio-entry.ts
//
// Executable stdio entrypoint for the Agent Memory Hub MCP server. This
// file is the only piece of the @portable-agent-asset-hub/mcp package
// that reads environment variables and writes to the process logs.
// The transport contract is strict:
//
//   * stdout is reserved exclusively for newline-delimited JSON-RPC
//     frames emitted by `startMcpServer`. We never write a log line,
//     banner, or prompt to stdout — doing so would corrupt the MCP
//     protocol stream and break every stdio host (OpenClaw, Claude
//     Desktop, etc.).
//   * stderr is the only channel we use for diagnostics, including the
//     pre-flight configuration error path. The format is plain
//     `key: value` lines so a host can show the reason in its own
//     logging surface without parsing structured output.
//
// Configuration is read from environment variables only. Secrets (the
// bearer token) are forwarded verbatim to `startMcpServer` and are
// NEVER echoed back to the log surface — not even a length hint. The
// REST base URL is required; when it is absent we exit non-zero with a
// redacted error before the server starts so a misconfigured host gets
// a deterministic failure rather than a hung process.

import { startMcpServer } from './server.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstatSync, readFileSync } from 'node:fs';

/** Name of the env var carrying the REST base URL. */
export const REST_URL_ENV = 'AGENT_MEMORY_REST_URL';
/** Name of the env var carrying the bearer token (optional). */
export const BEARER_TOKEN_ENV = 'AGENT_MEMORY_BEARER_TOKEN';
export const TOKEN_FILE_ENV = 'AGENT_MEMORY_AUTH_TOKEN_FILE';
/** Name of the env var carrying the comma-separated capability list. */
export const CAPABILITIES_ENV = 'AGENT_MEMORY_CAPABILITIES';

const REDACTED = '<redacted>';

export type StdioEntryOptions = {
  /** Override `process.env` for tests. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Override the I/O streams for tests. */
  io?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr?: NodeJS.WritableStream };
  /** Override stderr writes for tests. */
  stderr?: NodeJS.WritableStream;
  /** Exit hook used in tests instead of `process.exit`. */
  exit?: (code: number) => void;
};

/**
 * Read configuration from the environment, validate the required
 * fields, and start the MCP stdio server. Returns the chosen exit
 * code (0 only when the server started cleanly). Diagnostics are
 * written to the supplied stderr; the function never throws across
 * the process boundary so it can be called from a top-level await.
 */
export async function runStdioEntry(options: StdioEntryOptions = {}): Promise<number> {
  const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);
  const stderr = options.stderr ?? process.stderr;

  const restBaseUrl = (env[REST_URL_ENV] ?? '').trim();
  if (restBaseUrl.length === 0) {
    writeDiagnostic(stderr, 'error', `${REST_URL_ENV} is required; the MCP stdio entrypoint refuses to start without a REST base URL.`);
    return exitWith(options.exit, 2);
  }

  // The bearer token is forwarded verbatim; it is never logged, never
  // length-counted, and never echoed in error messages.
  const bearerTokenRaw = env[BEARER_TOKEN_ENV];
  const tokenFile = env[TOKEN_FILE_ENV];
  let bearerToken = typeof bearerTokenRaw === 'string' && bearerTokenRaw.length > 0 ? bearerTokenRaw : undefined;
  if (!bearerToken && tokenFile) {
    const stat = lstatSync(tokenFile);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
      writeDiagnostic(stderr, 'error', `${TOKEN_FILE_ENV} must reference a regular 0600-or-more-restrictive file.`);
      return exitWith(options.exit, 2);
    }
    bearerToken = readFileSync(tokenFile, 'utf8').trim();
    if (!bearerToken) return exitWith(options.exit, 2);
  }

  const capabilities = parseCapabilities(env[CAPABILITIES_ENV]);

  // Pre-flight diagnostic — only the resolved URL, not the token, and
  // never a query string. This is the *only* log line we emit on the
  // happy path.
  writeDiagnostic(stderr, 'start', `${REST_URL_ENV}=${redactUrl(restBaseUrl)} bearer=${bearerToken ? 'set' : 'unset'} capabilities=${capabilities.length}`);

  try {
    await startMcpServer({
      restBaseUrl,
      bearerToken,
      capabilities,
      io: options.io,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    writeDiagnostic(stderr, 'error', `failed to start MCP server: ${message}`);
    return exitWith(options.exit, 1);
  }
  return 0;
}

function parseCapabilities(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Strip credentials, query string, and fragment from a URL so we can
 * mention the host in a diagnostic without leaking secrets. Falls back
 * to the raw value when parsing fails — the caller still benefits
 * from seeing a non-empty host hint.
 */
function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return REDACTED;
  }
}

function writeDiagnostic(stream: NodeJS.WritableStream, level: string, message: string): void {
  stream.write(`agent-memory-mcp ${level}: ${message}\n`);
}

function exitWith(hook: ((code: number) => void) | undefined, code: number): number {
  if (hook) {
    hook(code);
    return code;
  }
  // `process.exit` is intentionally only used in the real entrypoint
  // path — the harness passes its own `exit` so it can observe the
  // code without terminating the test runner.
  process.exit(code);
}

// Detect direct invocation: when this file is the program entry, run
// the entrypoint. Comparing `import.meta.url` to the file URL of
// `process.argv[1]` is the only ESM-safe way to detect "am I being
// run directly" without a CommonJS-style `require.main === module`.
// We resolve the argv path to an absolute file URL so the comparison
// works regardless of how Node was invoked (relative path, symlink,
// bin shim that re-exports, etc.).
const isDirectInvocation = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  void runStdioEntry();
}
