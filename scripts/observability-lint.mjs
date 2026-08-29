#!/usr/bin/env node
// Scan the working tree and telemetry code for forbidden payloads that
// must never appear in attributes, labels, span names, OTLP headers or
// audit rows. The scanner is intentionally small: a few regexes
// against the source files added or modified by the telemetry slice.
//
// This is a static gate. It does NOT execute the kernel; it only
// ensures the operator can trust that nothing accidentally stores
// tokens, JWTs, raw queries or bodies. A failure here is a hard FAIL.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, '..');

const SCAN_DIRS = [
  'packages/telemetry/src',
  'packages/telemetry/dist',
  'packages/rest/src',
  'packages/rest/dist',
  'packages/mcp/src',
  'packages/mcp/dist',
  'tests/telemetry',
  'tests/fixtures',
  'tests/rest/telemetry-request.test.ts',
  'tests/mcp/rest-transport-telemetry.test.ts',
  'docs/observability.md',
  'observability',
];

const SECRET_PATTERNS = [
  // Bearer / Authorization header literals
  { re: /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g, label: 'bearer-token-literal' },
  // Raw JWT segments
  { re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./g, label: 'jwt-literal' },
  // PEM block markers
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, label: 'pem-block' },
  // apikey/password/api_key secret values in code (best-effort heuristic)
  { re: /(api[_-]?key|password|secret[_-]?token|authorization)\s*[:=]\s*['"][^'"]/gi, label: 'secret-literal' },
  // ngrok / LAN tunnels (the plan forbids reusing the Graph Explorer ngrok)
  { re: /(ngrok|serveo|localtunnel)\./g, label: 'public-tunnel' },
  // Grafana Cloud / OTLP off-box endpoints (the plan defers this decision)
  { re: /otlp\.grafana\.net|grafana\.net\/api\/otlp/g, label: 'grafana-cloud' },
];

// Test fixtures intentionally use these patterns to prove the kernel
// blocks or scrubs them. They are part of the negative contract, not a
// leak.
const ALLOWLIST_TOKEN_IN_TESTS = new Set([
  'tests/mcp/rest-transport-telemetry.test.ts',
  'tests/rest/telemetry-request.test.ts',
  'tests/telemetry/privacy-contract.test.ts',
  'tests/telemetry/otlp-process-smoke.test.ts',
  'tests/telemetry/fail-open.test.ts',
]);

const FORBIDDEN_TRACKED = [
  'tests/skills/explicit-auto-approval.test.ts',
  'tests/s2/integrity-and-boundaries.test.ts',
  'tests/storage-sqlite/skill-storage.test.ts',
  // The above are pre-existing failing tests NOT modified by telemetry;
  // we don't re-check them — the global test suite is the source of
  // truth for pre-existing failures.
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'artifacts' || entry === 'rejected') continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (['.ts', '.mjs', '.js', '.json', '.yaml', '.md'].includes(extname(entry))) {
      yield full;
    }
  }
}

function listFiles(target) {
  const full = join(workspaceRoot, target);
  if (!existsSync(full)) return [];
  const st = statSync(full);
  if (st.isFile()) return [full];
  return [...walk(full)];
}

const findings = [];
for (const target of SCAN_DIRS) {
  for (const file of listFiles(target)) {
    const rel = relative(workspaceRoot, file);
    if (FORBIDDEN_TRACKED.includes(rel)) continue;
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    for (const { re, label } of SECRET_PATTERNS) {
      const matches = content.match(re);
      if (matches && matches.length > 0) {
        if (ALLOWLIST_TOKEN_IN_TESTS.has(rel)) continue;
        findings.push({ file: rel, label, samples: matches.slice(0, 2) });
      }
    }
  }
}

const result = { gate: 'observability:lint', status: findings.length === 0 ? 'PASS' : 'FAIL', findings };
console.log(JSON.stringify(result, null, 2));
if (findings.length > 0) process.exit(1);