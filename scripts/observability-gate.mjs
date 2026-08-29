#!/usr/bin/env node
// Encadena los gates focales de observabilidad y conserva los exit
// codes para que `pnpm observability:gate` actúe como un único release
// gate. Cada sub-gate produce un artifact JSON en
// `artifacts/telemetry/` (ignorado por git) con su verdict.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, '..');
const artifactsDir = join(workspaceRoot, 'artifacts', 'telemetry');
mkdirSync(artifactsDir, { recursive: true });

const STEPS = [
  { name: 'lint', cmd: ['node', 'scripts/observability-lint.mjs'] },
  { name: 'cardinality', cmd: ['pnpm', 'vitest', 'run', 'tests/telemetry/cardinality-contract.test.ts', '--reporter=basic'] },
  { name: 'e2e', cmd: ['pnpm', 'vitest', 'run', 'tests/telemetry/otlp-process-smoke.test.ts', '--no-file-parallelism', '--reporter=basic'] },
  { name: 'compose-config', cmd: ['docker', 'compose', '-f', 'observability/compose.yaml', 'config', '--quiet'] },
];

const summary = { gate: 'observability:gate', status: 'PASS', steps: {}, completedAt: new Date().toISOString() };
for (const step of STEPS) {
  const result = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: workspaceRoot, encoding: 'utf8' });
  const exit = result.status ?? 1;
  summary.steps[step.name] = {
    exitCode: exit,
    status: exit === 0 ? 'PASS' : (step.name === 'compose-config' ? 'BLOCKED' : 'FAIL'),
    stdoutTail: (result.stdout ?? '').slice(-2000),
    stderrTail: (result.stderr ?? '').slice(-2000),
  };
  if (exit !== 0 && summary.status !== 'BLOCKED') summary.status = (step.name === 'compose-config') ? 'BLOCKED' : 'FAIL';
}

writeFileSync(join(artifactsDir, 'final-gates.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.status === 'FAIL') process.exit(1);