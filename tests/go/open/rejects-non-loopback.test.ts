// tests/go/open/rejects-non-loopback.test.ts
//
// T4 contract — negative path. The dispatcher MUST refuse any bind
// address that is not the loopback interface. The test covers:
//
//   * `hub open --bind 0.0.0.0`           → exit 2 (fail-closed)
//   * `hub open --bind 0`                 → exit 2 (fail-closed)
//   * `hub open --bind <public-ip>`       → exit 2 (fail-closed)
//   * Env var override `HUB_OPEN_BIND=0.0.0.0` → still exit 2
//     (the env knob MUST NOT widen the bind surface; the only
//     accepted values are loopback literals).
//   * Help text mentions the loopback-only invariant so operators
//     can grep for the rule.
//
// These are real subprocess tests. We deliberately do NOT have the
// binary actually try to bind to 0.0.0.0 — the validation rejects
// the request up front, so the audit trail proves the rejection
// happened before any sysctl / socket syscall against a non-
// loopback interface.

import {
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { existsSync } from 'node:fs';
import {
  buildOpenBinary,
  repoOpenAPI,
  runOpen,
} from './_open-harness.js';

const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=\s*[^\s,'"]+/i;
const JWT_TRIPLE_SEGMENT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

function looksLikeBearer(s: string): boolean {
  if (!s) return false;
  if (BEARER_PREFIXED_OPAQUE.test(s)) return true;
  if (HUB_BEARER_ENV_ASSIGNMENT.test(s)) return true;
  if (JWT_TRIPLE_SEGMENT.test(s)) return true;
  return false;
}

beforeAll(() => {
  const { binary } = buildOpenBinary();
  if (!existsSync(binary)) {
    throw new Error(`hub binary not built: ${binary}`);
  }
});

interface Case {
  name: string;
  argv: string[];
  env?: Record<string, string>;
  stderrMatch: RegExp;
  stdoutEmpty?: boolean;
}

const CASES: Case[] = [
  {
    name: 'refuses --bind 0.0.0.0',
    argv: ['open', '--port', '18765', '--bind', '0.0.0.0'],
    stderrMatch: /loopback|127\.0\.0\.1|non-loopback|refus/i,
  },
  {
    name: 'refuses --bind 0',
    argv: ['open', '--port', '18766', '--bind', '0'],
    stderrMatch: /loopback|127\.0\.0\.1|non-loopback|refus/i,
  },
  {
    name: 'refuses --bind <public ip>',
    argv: ['open', '--port', '18767', '--bind', '8.8.8.8'],
    stderrMatch: /loopback|127\.0\.0\.1|non-loopback|refus/i,
  },
  {
    name: 'refuses --bind ::',
    argv: ['open', '--port', '18768', '--bind', '::'],
    stderrMatch: /loopback|127\.0\.0\.1|non-loopback|refus/i,
  },
  {
    name: 'refuses HUB_OPEN_BIND=0.0.0.0 env override',
    argv: ['open', '--port', '18769'],
    env: { HUB_OPEN_BIND: '0.0.0.0' },
    stderrMatch: /loopback|127\.0\.0\.1|non-loopback|refus/i,
  },
  {
    name: 'refuses HUB_OPEN_BIND=<public> env override',
    argv: ['open', '--port', '18770'],
    env: { HUB_OPEN_BIND: '8.8.8.8' },
    stderrMatch: /loopback|127\.0\.0\.1|non-loopback|refus/i,
  },
];

describe('hub open — rejects non-loopback bind (T4 contract)', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const res = await runOpen(
        c.argv,
        { HUB_OPENAPI: repoOpenAPI, ...(c.env ?? {}) },
      );
      // Fail-closed: any non-loopback bind attempt exits 2.
      // Exit 0 is forbidden on the negative path because that
      // would mean the dispatcher silently widened the bind
      // surface.
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(c.stderrMatch);
      // The contract surface (stdout) MUST stay empty for the
      // negative path — the diagnostic lives on stderr so a CI
      // pipeline can route `hub open --bind 0.0.0.0` to stderr
      // and inspect the failure.
      expect(res.stdout.trim()).toBe('');
      // Bearer hygiene — fail-closed diagnostics must not echo
      // any captured token.
      expect(looksLikeBearer(res.stdout)).toBe(false);
      expect(looksLikeBearer(res.stderr)).toBe(false);
    }, 10_000);
  }

  it('hub open --help advertises the loopback-only invariant', async () => {
    const res = await runOpen(
      ['open', '--help'],
      { HUB_OPENAPI: repoOpenAPI },
    );
    expect(res.status).toBe(0);
    // The grep anchor must be either the literal loopback range
    // or the word "loopback" so an operator can verify the rule
    // by reading the help text.
    expect(res.stdout).toMatch(/127\.0\.0\.1|loopback/i);
    expect(looksLikeBearer(res.stdout)).toBe(false);
    expect(looksLikeBearer(res.stderr)).toBe(false);
  }, 10_000);
});
