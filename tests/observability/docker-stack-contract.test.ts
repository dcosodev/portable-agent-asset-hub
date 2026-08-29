// tests/observability/docker-stack-contract.test.ts
//
// Vitest wrapper for `scripts/docker-stack-contract.mjs`. The contract
// script is the authoritative source of truth (it is also runnable on
// its own via `node scripts/docker-stack-contract.mjs`); this test only
// exists so vitest can run it as part of the focused observability gate
// and surface a clean PASS/FAIL with diff-able findings.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const contractScript = join(repoRoot, 'scripts', 'docker-stack-contract.mjs');

interface ContractFinding {
  name: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

interface ContractVerdict {
  status: 'PASS' | 'FAIL';
  checked: number;
  failed: number;
  findings: ContractFinding[];
}

function runContract(): ContractVerdict {
  const result = spawnSync(process.execPath, [contractScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout ?? '';
  if (stdout.trim().length === 0) {
    throw new Error(`docker-stack-contract.mjs produced no JSON (exit=${result.status ?? 1}): ${result.stderr ?? ''}`);
  }
  return JSON.parse(stdout) as ContractVerdict;
}

describe('docker stack contract', () => {
  it('passes every static contract gate', () => {
    const verdict = runContract();
    if (verdict.status !== 'PASS') {
      const failures = verdict.findings
        .filter((finding) => finding.status === 'FAIL')
        .map((finding) => ` - ${finding.name}: ${finding.detail}`)
        .join('\n');
      throw new Error(`docker-stack-contract FAILED (${verdict.failed}/${verdict.checked}):\n${failures}`);
    }
    expect(verdict.failed).toBe(0);
  });
});
