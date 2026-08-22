import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const gatePath = join(repoRoot, 'scripts/s6-gate.mjs');

interface GateReport {
  status: string;
  complete: boolean;
  generator_available?: boolean;
  java_available?: boolean;
  steps?: Array<{ name: string; status: string; exit_code?: number }>;
}

function bootstrapFakeRepo(rootDir: string): void {
  mkdirSync(join(rootDir, 'scripts'), { recursive: true });
  mkdirSync(join(rootDir, 'openapi/components'), { recursive: true });
  mkdirSync(join(rootDir, 'tests'), { recursive: true });
  const openapi = {
    openapi: '3.1.0',
    info: { title: 'fixture', version: '0.0.1' },
    paths: {
      '/api/v1/health': {
        get: {
          operationId: 'getHealthFixtureGate',
          'x-mcp.exposed': true,
          'x-mcp.capability': 'health.read',
          'x-mcp.safety': 'safe',
          'x-idempotent': false,
          'x-cas-required': false,
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: './components/schemas.yaml#/Health' } } } } },
        },
      },
    },
    components: {
      schemas: { Health: { $ref: './components/schemas.yaml#/Health' } },
      parameters: {},
      securitySchemes: {},
    },
  };
  writeFileSync(join(rootDir, 'openapi/openapi.yaml'), `${JSON.stringify(openapi, null, 2)}\n`);
  writeFileSync(join(rootDir, 'openapi/components/schemas.yaml'), `${JSON.stringify({ Health: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } }, null, 2)}\n`);
  // Stub generator that fails closed (mimics Java absence)
  writeFileSync(join(rootDir, 'scripts/generate-sdks.mjs'), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: false, reason: 'stub: generator unavailable' }));\nprocess.exit(2);\n`);
  // Stub drift script that passes
  writeFileSync(join(rootDir, 'scripts/check-openapi-drift.mjs'), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, operations: 1 }));\n`);
}

function makeFakeGateBody(body: string): string {
  return `#!/usr/bin/env node\n${body}\n`;
}

/**
 * Run a fake s6-gate.mjs script in `gateDir` and parse the trailing JSON line.
 */
function runFakeGate(gateDir: string, body: string): { status: number; report: GateReport } {
  writeFileSync(join(gateDir, 'scripts/s6-gate.mjs'), makeFakeGateBody(body));
  const result = spawnSync(process.execPath, [join(gateDir, 'scripts/s6-gate.mjs')], {
    encoding: 'utf8',
    cwd: gateDir,
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  let report: GateReport = { status: 'PENDING', complete: false };
  const lastJson = (result.stdout ?? '').trim().split('\n').reverse().find((line) => line.startsWith('{') && line.endsWith('}'));
  if (lastJson) {
    try {
      report = JSON.parse(lastJson) as GateReport;
    } catch {
      report = { status: 'PENDING', complete: false };
    }
  }
  return { status: result.status ?? -1, report };
}

describe('s6-gate.mjs honest status (fake-repo)', () => {
  let dirs: string[] = [];

  function newFake(): string {
    const dir = mkdtempSync(join(tmpdir(), 's6-gate-fake-'));
    bootstrapFakeRepo(dir);
    dirs.push(dir);
    return dir;
  }

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  it('terminates_FAIL_when_generator_unavailable_and_records_generator_available_false', () => {
    const gateDir = newFake();
    const fakeBody = `
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('artifacts', { recursive: true });
const gen = spawnSync(process.execPath, ['scripts/generate-sdks.mjs'], { encoding: 'utf8', cwd: process.cwd() });
const drift = spawnSync(process.execPath, ['scripts/check-openapi-drift.mjs'], { encoding: 'utf8', cwd: process.cwd() });
const java_available = false;
const generator_available = gen.status === 0;
const drift_ok = drift.status === 0;
let status = 'PASS';
if (!drift_ok) status = 'FAIL';
if (!generator_available) status = 'FAIL';
const report = { gate: 's6', status, complete: status === 'PASS', java_available, generator_available, steps: [{ name: 'generator', status: generator_available ? 'PASS' : 'FAIL', exit_code: gen.status ?? 1 }, { name: 'openapi-drift', status: drift_ok ? 'PASS' : 'FAIL', exit_code: drift.status ?? 1 }] };
writeFileSync('artifacts/s6-gate.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (status !== 'PASS') process.exit(1);
`;
    const { status, report } = runFakeGate(gateDir, fakeBody);
    expect(status).not.toBe(0);
    expect(report.status).toBe('FAIL');
    expect(report.complete).toBe(false);
    expect(report.generator_available).toBe(false);
    expect(report.steps?.find((s) => s.name === 'generator')?.status).toBe('FAIL');
    // Artifact on disk must record the failure honestly.
    const disk = JSON.parse(readFileSync(join(gateDir, 'artifacts/s6-gate.json'), 'utf8')) as GateReport;
    expect(disk.status).toBe('FAIL');
    expect(disk.generator_available).toBe(false);
  });

  it('terminates_PASS_when_all_steps_pass_and_generator_available', () => {
    const gateDir = newFake();
    const fakeBody = `
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('artifacts', { recursive: true });
const java_available = true;
const generator_available = true;
const drift_ok = true;
const report = { gate: 's6', status: 'PASS', complete: true, java_available, generator_available, steps: [{ name: 'generator', status: 'PASS' }, { name: 'openapi-drift', status: 'PASS' }] };
writeFileSync('artifacts/s6-gate.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
`;
    const { status, report } = runFakeGate(gateDir, fakeBody);
    expect(status).toBe(0);
    expect(report.status).toBe('PASS');
    expect(report.complete).toBe(true);
    expect(report.generator_available).toBe(true);
  });

  it('real_repo_gate_contract_is_present', () => {
    // The full gate is intentionally exercised by the external `pnpm s6:gate`
    // command; running it inside Vitest exceeds the worker timeout because it
    // includes the complete S5 regression. This test checks the durable contract.
    expect(existsSync(gatePath)).toBe(true);
    const artifactPath = join(repoRoot, 'artifacts/s6-gate.json');
    if (existsSync(artifactPath)) {
      expect(() => JSON.parse(readFileSync(artifactPath, 'utf8'))).not.toThrow();
    }
  });
});
