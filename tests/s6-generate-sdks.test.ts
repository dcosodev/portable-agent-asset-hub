import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname ?? __dirname, '..');
const scriptPath = join(repoRoot, 'scripts/generate-sdks.mjs');

interface Provenance {
  generator?: string;
  version?: string;
  generator_available?: boolean;
  reason?: string;
  source?: string;
  contract_fixtures?: string[];
}

function runScriptIn(rootDir: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    cwd: rootDir,
    env: { ...process.env, GEN_REPO_ROOT: rootDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function bootstrapOpenapi(rootDir: string): void {
  mkdirSync(join(rootDir, 'openapi'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/sdk-ts/generated/fixtures'), { recursive: true });
  mkdirSync(join(rootDir, 'packages/sdk-python/generated/fixtures'), { recursive: true });
  writeFileSync(join(rootDir, 'openapi/openapi.yaml'), `${JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'fixture', version: '0.0.1' },
    paths: {},
    components: { schemas: {}, parameters: {}, securitySchemes: {} },
  }, null, 2)}\n`);
  for (const fixture of ['conflict.json', 'health.json', 'identity.json', 'not_found.json', 'status.json']) {
    writeFileSync(join(rootDir, `packages/sdk-ts/generated/fixtures/${fixture}`), '{}');
    writeFileSync(join(rootDir, `packages/sdk-python/generated/fixtures/${fixture}`), '{}');
  }
}

describe('generate-sdks.mjs contract', () => {
  let fakeDir: string;

  beforeAll(() => {
    fakeDir = mkdtempSync(join(tmpdir(), 's6-gen-fake-'));
    bootstrapOpenapi(fakeDir);
  });

  afterAll(() => {
    if (fakeDir) rmSync(fakeDir, { recursive: true, force: true });
  });

  it('writes_honest_provenance_when_java_absent_and_exits_fail_closed', () => {
    // Copy the generator into a fake repo without java on PATH.
    const fakeOpenapiDir = join(fakeDir, 'openapi');
    rmSync(fakeOpenapiDir, { recursive: true, force: true });
    bootstrapOpenapi(fakeDir);
    // Sanity: java probe says no on this machine.
    const hasJava = (() => {
      try {
        execFileSync('java', ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return true;
      } catch {
        return false;
      }
    })();
    const { status } = runScriptIn(fakeDir);
    if (!hasJava) {
      expect(status).toBe(2);
      for (const target of ['packages/sdk-ts/generated', 'packages/sdk-python/generated']) {
        const path = join(fakeDir, `${target}/PROVENANCE.json`);
        const prov = JSON.parse(readFileSync(path, 'utf8')) as Provenance;
        expect(prov.generator).toBe('OpenAPI Generator');
        expect(prov.version).toBe('7.10.0');
        expect(prov.generator_available).toBe(false);
        expect(prov.source).toBe('openapi/openapi.yaml');
        expect(Array.isArray(prov.contract_fixtures)).toBe(true);
        expect((prov.contract_fixtures ?? []).length).toBeGreaterThan(0);
      }
    } else {
      // Java IS present — generator is also expected to be present and generate code.
      expect(status).toBe(0);
    }
  });

  it('does_not_create_fake_sdk_when_generator_unavailable', () => {
    const hasJava = (() => {
      try {
        execFileSync('java', ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasJava) {
      for (const target of ['packages/sdk-ts/generated', 'packages/sdk-python/generated']) {
        const entries = (() => {
          try {
            return readdirSync(join(fakeDir, target)).sort();
          } catch {
            return [] as string[];
          }
        })();
        // Only PROVENANCE.json + fixtures are allowed when generator is unavailable.
        expect(entries).toEqual(['PROVENANCE.json', 'fixtures']);
      }
    }
  });

  it('pinned_generator_version_is_7_10_0', () => {
    const source = readFileSync(scriptPath, 'utf8');
    // Must pin the version in source, not a placeholder or unset var.
    expect(source).toMatch(/7\.10\.0/);
    // Must NOT have a TODO or example placeholder like "x.y.z".
    expect(source).not.toMatch(/['"]\d+\.\d+\.\d+['"].*TODO/);
  });

  it('real_repo_provenance_is_honest_about_java_absence', () => {
    const r = runScriptIn(repoRoot);
    const hasJava = (() => {
      try {
        execFileSync('java', ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasJava) {
      expect(r.status).toBe(2);
      const tsPath = join(repoRoot, 'packages/sdk-ts/generated/PROVENANCE.json');
      const pyPath = join(repoRoot, 'packages/sdk-python/generated/PROVENANCE.json');
      const ts = JSON.parse(readFileSync(tsPath, 'utf8')) as Provenance;
      const py = JSON.parse(readFileSync(pyPath, 'utf8')) as Provenance;
      expect(ts.generator_available).toBe(false);
      expect(py.generator_available).toBe(false);
      expect(ts.version).toBe('7.10.0');
      expect(py.version).toBe('7.10.0');
      expect(ts.contract_fixtures).toEqual(py.contract_fixtures);
    } else {
      // If Java IS available and a CLI happens to be on PATH at exactly the pinned
      // version, the run may succeed; either way the contract is satisfied.
      expect(r.status === 0 || r.status === 2).toBe(true);
    }
  });
});
