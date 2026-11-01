import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd });
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

/** A repository whose `catalog` gate counts its runs and whose `parent` gate calls it via `steps`. */
function fixture(options: { exitCode?: number; repo?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'run-gate-test-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(repoRoot, 'scripts/run-gate.mjs'), join(root, 'scripts/run-gate.mjs'));
  writeFileSync(join(root, '.gitignore'), 'artifacts/\n');
  writeFileSync(join(root, 'scripts/catalog-gate.mjs'), `
    import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
    mkdirSync('artifacts', { recursive: true });
    appendFileSync('artifacts/runs.log', 'run\\n');
    writeFileSync('artifacts/catalog-evidence.json', '{"status":"PASS"}');
    console.log('catalog out'); console.error('catalog err');
    process.exitCode = ${options.exitCode ?? 0};
  `);
  writeFileSync(join(root, 'scripts/parent-gate.mjs'), `
    import { spawnSync } from 'node:child_process';
    import { readFileSync, rmSync, writeFileSync } from 'node:fs';
    const call = () => spawnSync(process.execPath, ['scripts/run-gate.mjs', 'catalog'], { env: process.env, encoding: 'utf8' });
    const steps = readFileSync('steps.txt', 'utf8').trim().split(',');
    const results = [];
    for (const step of steps) {
      if (step === 'call') { const r = call(); results.push({ status: r.status, stdout: r.stdout, stderr: r.stderr }); }
      if (step === 'tamper') writeFileSync('artifacts/catalog-evidence.json', '{"status":"FAKE"}');
      if (step === 'edit') writeFileSync('source.txt', 'changed');
    }
    writeFileSync('artifacts/results.json', JSON.stringify(results));
  `);
  writeFileSync(join(root, 'source.txt'), 'original');
  if (options.repo !== false) {
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
  }
  return root;
}

function runParent(root: string, steps: string, env: Record<string, string> = {}) {
  writeFileSync(join(root, 'steps.txt'), steps);
  const clean = { ...process.env, ...env };
  delete clean.GATE_MEMO_DIR;
  if (!env.GATE_NO_REUSE) delete clean.GATE_NO_REUSE;
  const top = spawnSync(process.execPath, ['scripts/run-gate.mjs', 'parent'], { cwd: root, env: clean, encoding: 'utf8' });
  expect(top.status).toBe(0);
  return {
    runs: readFileSync(join(root, 'artifacts/runs.log'), 'utf8').trim().split('\n').length,
    results: JSON.parse(readFileSync(join(root, 'artifacts/results.json'), 'utf8')) as Array<{ status: number; stdout: string; stderr: string }>,
  };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('run-gate', () => {
  it('runs a repeated gate once and replays its output and exit code', () => {
    const { runs, results } = runParent(fixture(), 'call,call,call');
    expect(runs).toBe(1);
    expect(results.map((r) => r.status)).toEqual([0, 0, 0]);
    expect(results[2].stdout).toBe(results[0].stdout);
    expect(results[0].stderr).toContain('catalog err');
    expect(results[0].stderr).not.toContain('[run-gate]');
    expect(results[2].stderr).toContain('catalog err');
    expect(results[2].stderr).toContain('[run-gate] catalog: reused');
  });

  it('replays a failure as a failure, never as a pass', () => {
    const { runs, results } = runParent(fixture({ exitCode: 1 }), 'call,call');
    expect(runs).toBe(1);
    expect(results.map((r) => r.status)).toEqual([1, 1]);
  });

  it('replays the blocked exit code unchanged', () => {
    const { results } = runParent(fixture({ exitCode: 2 }), 'call,call');
    expect(results.map((r) => r.status)).toEqual([2, 2]);
  });

  it('runs again when the tree changes', () => {
    expect(runParent(fixture(), 'call,edit,call').runs).toBe(2);
  });

  it('runs again when the evidence file no longer matches', () => {
    const root = fixture();
    expect(runParent(root, 'call,tamper,call').runs).toBe(2);
    expect(readFileSync(join(root, 'artifacts/catalog-evidence.json'), 'utf8')).toBe('{"status":"PASS"}');
  });

  it('keeps nothing between top-level commands', () => {
    const root = fixture();
    expect(runParent(root, 'call').runs).toBe(1);
    expect(runParent(root, 'call').runs).toBe(2);
  });

  it('runs every repeat outside a repository, where the tree cannot be described', () => {
    expect(runParent(fixture({ repo: false }), 'call,call').runs).toBe(2);
  });

  it('runs every repeat with GATE_NO_REUSE=1', () => {
    expect(runParent(fixture(), 'call,call', { GATE_NO_REUSE: '1' }).runs).toBe(2);
  });

  it('routes every chained gate through the wrapper', () => {
    const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const gate of ['baseline', 'storage', 'memory', 'profile', 'catalog', 'openapi', 'mcp', 'hermes', 'openclaw', 'migration']) {
      expect(scripts[`${gate}:gate`]).toBe(`node scripts/run-gate.mjs ${gate}`);
      expect(existsSync(join(repoRoot, 'scripts', `${gate}-gate.mjs`))).toBe(true);
    }
  });
});
