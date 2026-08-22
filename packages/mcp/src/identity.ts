// packages/mcp/src/identity.ts
//
// Process-bound identity. The MCP server derives its identity from the
// host process at boot and exposes it through a descriptor. The model
// layer is NEVER allowed to substitute this identity — any tool call
// arguments or capability headers that attempt to do so are rejected.

import { createHash } from 'node:crypto';
import type { McpIdentityDescriptor, ProcessIdentity } from './types.js';

/**
 * Compute a stable identity for the running process.
 *
 * Determinism contract:
 *   * `argvDigest` is a SHA-256 of the null-separated argv. Same argv
 *     across calls always yields the same digest.
 *   * `bootId` is derived purely from `(pid, argvDigest)`. Two calls
 *     with the same pid and argv produce the same bootId (no random
 *     components, no high-resolution clock), so re-computing the
 *     identity for the same process always yields the same descriptor.
 *     Two different pids (or two processes started with different argv)
 *     always yield different bootIds.
 *
 * `startedAt` is captured at the moment of the first call and frozen;
 * subsequent calls with the same pid+argv return the same startedAt.
 * This keeps the descriptor truly process-bound instead of being a
 * fresh snapshot on every call.
 */
const STARTED_AT_BY_PID_ARGV = new Map<string, string>();

function pidArgvKey(pid: number, argvDigest: string): string {
  return `${pid}\u0000${argvDigest}`;
}

export function computeProcessIdentity(pid: number, argv: readonly string[]): ProcessIdentity {
  const argvDigest = createHash('sha256').update(argv.join('\u0000')).digest('hex');
  const key = pidArgvKey(pid, argvDigest);
  let startedAt = STARTED_AT_BY_PID_ARGV.get(key);
  if (!startedAt) {
    startedAt = new Date().toISOString();
    STARTED_AT_BY_PID_ARGV.set(key, startedAt);
  }
  // bootId = SHA-256(pid || ":" || argvDigest), truncated to 16 hex chars.
  // No randomUUID, no process.hrtime — the result is a pure function of
  // (pid, argv) so two calls with the same inputs always agree.
  const bootId = createHash('sha256')
    .update(`${pid}:${argvDigest}`)
    .digest('hex')
    .slice(0, 16);
  return Object.freeze({
    pid,
    argvDigest,
    bootId,
    startedAt,
  });
}

/** Create the public descriptor that the server exposes to callers. */
export function createMcpIdentity(identity: ProcessIdentity): McpIdentityDescriptor {
  return Object.freeze({
    kind: 'mcp-process',
    pid: identity.pid,
    argvDigest: identity.argvDigest,
    bootId: identity.bootId,
    startedAt: identity.startedAt,
  });
}

/**
 * Returns true when the supplied headers carry an attempt by the model
 * to override the server-side identity. We treat the following headers
 * as attacker-controlled and refuse to honour them:
 *   - x-mcp-actor
 *   - x-mcp-user-id
 *   - x-mcp-agent-id
 *   - x-mcp-role
 *   - x-mcp-capability
 */
const FORBIDDEN_HEADERS = new Set([
  'x-mcp-actor',
  'x-mcp-user-id',
  'x-mcp-agent-id',
  'x-mcp-role',
  'x-mcp-capability',
  'x-mcp-identity',
]);

export function isModelIdentityOverride(headers: Readonly<Record<string, string>>): boolean {
  for (const key of Object.keys(headers)) {
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) return true;
  }
  return false;
}

/** Strip any model-supplied identity headers. */
export function stripModelIdentityHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}
