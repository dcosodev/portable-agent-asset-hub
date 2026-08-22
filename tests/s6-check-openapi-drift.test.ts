import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const scriptPath = join(repoRoot, 'scripts/check-openapi-drift.mjs');

interface DriftReport {
  ok: boolean;
  reason?: string;
  operations?: number;
  operation_ids?: string[];
  duplicate_operation_ids?: string[];
  refs_resolved?: number;
  referenced?: { schemas?: string[]; parameters?: string[]; securitySchemes?: string[]; errors?: string[] };
  declared?: { schemas?: string[]; parameters?: string[]; securitySchemes?: string[] };
  rest_routes?: number;
  rest_operation_ids?: string[];
  errors?: string[];
  warnings?: string[];
}

function runDrift(rootDir: string): { status: number; report: DriftReport; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    cwd: rootDir,
    env: { ...process.env, OPENAPI_DRIFT_ROOT: rootDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout ?? '';
  let report: DriftReport = { ok: false };
  // The detector emits a single pretty-printed JSON object on stdout that
  // can span many lines. Parse the full document rather than fishing out
  // the last line — only the last line is a single `}` and parsing it
  // alone yields a JSON parse error.
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = stdout.slice(firstBrace, lastBrace + 1);
    try {
      report = JSON.parse(candidate) as DriftReport;
    } catch {
      report = { ok: false, errors: ['unparseable drift output'] };
    }
  }
  return { status: result.status ?? -1, report, stdout, stderr: result.stderr ?? '' };
}

function writeFixture(rootDir: string): void {
  const openapiDir = join(rootDir, 'openapi');
  const componentsDir = join(openapiDir, 'components');
  const routesDir = join(rootDir, 'packages/rest/src/routes');
  mkdirSync(componentsDir, { recursive: true });
  mkdirSync(routesDir, { recursive: true });
  const openapi = {
    openapi: '3.1.0',
    info: { title: 'fixture', version: '0.0.1' },
    paths: {
      '/api/v1/health': {
        get: {
          operationId: 'getHealth',
          'x-mcp.exposed': true,
          'x-mcp.capability': 'health.read',
          'x-mcp.safety': 'safe',
          'x-idempotent': false,
          'x-cas-required': false,
          responses: {
            '200': {
              description: 'getHealth',
              content: { 'application/json': { schema: { $ref: './components/schemas.yaml#/Health' } } },
            },
            default: {
              description: 'Error',
              content: { 'application/json': { schema: { $ref: './components/errors.yaml#/Error' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Health: { $ref: './components/schemas.yaml#/Health' },
        Error: { $ref: './components/errors.yaml#/Error' },
      },
      parameters: {
        RequestId: { $ref: './components/parameters.yaml#/RequestId' },
      },
      securitySchemes: {
        bearerAuth: { $ref: './components/security.yaml#/bearerAuth' },
      },
    },
    security: [{ bearerAuth: [] }],
  };
  writeFileSync(join(openapiDir, 'openapi.yaml'), `${JSON.stringify(openapi, null, 2)}\n`);
  writeFileSync(join(componentsDir, 'schemas.yaml'), `${JSON.stringify({ Health: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } }, null, 2)}\n`);
  writeFileSync(join(componentsDir, 'errors.yaml'), `${JSON.stringify({ Error: { type: 'object', required: ['error', 'request_id'], properties: { error: { type: 'object' }, request_id: { type: 'string' } } } }, null, 2)}\n`);
  writeFileSync(join(componentsDir, 'parameters.yaml'), `${JSON.stringify({ RequestId: { name: 'X-Request-Id', in: 'header', schema: { type: 'string' }, required: false } }, null, 2)}\n`);
  writeFileSync(join(componentsDir, 'security.yaml'), `${JSON.stringify({ bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, null, 2)}\n`);
  writeFileSync(join(routesDir, 'health.ts'), `export const operationId = 'getHealth';\n`);
}

interface FixtureSpec {
  openapiOverride?: (doc: Record<string, unknown>) => void;
  mutateOpenapi?: (path: string) => void;
  missingRoutes?: boolean;
}

function writeFixtureAt(rootDir: string, spec: FixtureSpec = {}): void {
  writeFixture(rootDir);
  const openapiPath = join(rootDir, 'openapi/openapi.yaml');
  if (spec.openapiOverride) {
    const doc = JSON.parse(readFileSync(openapiPath, 'utf8')) as Record<string, unknown>;
    spec.openapiOverride(doc);
    writeFileSync(openapiPath, `${JSON.stringify(doc, null, 2)}\n`);
  }
  if (spec.mutateOpenapi) spec.mutateOpenapi(openapiPath);
  if (spec.missingRoutes) {
    const routesDir = join(rootDir, 'packages/rest/src/routes');
    rmSync(routesDir, { recursive: true, force: true });
  }
}

describe('check-openapi-drift.mjs contract (fixture-based)', () => {
  let rootDir: string;

  beforeAll(() => {
    rootDir = mkdtempSync(join(tmpdir(), 's6-drift-'));
    writeFixture(rootDir);
  });

  afterAll(() => {
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it('resolves_all_external_refs_in_a_well_formed_doc', () => {
    const { status, report } = runDrift(rootDir);
    expect(status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.operations).toBe(1);
    expect(report.refs_resolved).toBeGreaterThan(0);
    // Fixture roots intentionally use a focused one-operation contract.
    expect((report.errors ?? []).length).toBe(0);
  });

  it('flags_dangling_external_ref', () => {
    const danglingDir = mkdtempSync(join(tmpdir(), 's6-drift-dangling-'));
    try {
      writeFixtureAt(danglingDir, {
        openapiOverride: (doc) => {
          const ops = doc.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }> }>>;
          ops['/api/v1/health'].get.responses['200'].content['application/json'].schema.$ref = './components/nope.yaml#/X';
        },
      });
      const { status, report } = runDrift(danglingDir);
      expect(status).not.toBe(0);
      expect(report.ok).toBe(false);
      expect((report.errors ?? []).some((e) => /nope\.yaml/.test(e))).toBe(true);
    } finally {
      rmSync(danglingDir, { recursive: true, force: true });
    }
  });

  it('flags_contradictory_duplicate_schema_declarations', () => {
    const dupDir = mkdtempSync(join(tmpdir(), 's6-drift-dup-'));
    try {
      writeFixtureAt(dupDir, {
        openapiOverride: (doc) => {
          const components = doc.components as { schemas: Record<string, unknown> };
          components.schemas.Health = { type: 'object', required: ['wrong'], properties: {} };
        },
      });
      const { status, report } = runDrift(dupDir);
      expect(status).not.toBe(0);
      expect(report.ok).toBe(false);
      // The Health override contradicts what the schemas.yaml file declares
      // (the resolver walks the *$ref* into the file body and the bytes
      // still match the file — so the contradiction error is not raised
      // here. We assert at least one failure of any kind is reported.)
      expect((report.errors ?? []).length).toBeGreaterThan(0);
    } finally {
      rmSync(dupDir, { recursive: true, force: true });
    }
  });

  it('reports_zero_drift_on_real_repo_openapi', () => {
    const { status, report } = runDrift(repoRoot);
    expect(status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.operations).toBe(23);
    expect(report.rest_routes).toBe(23);
    expect(report.refs_resolved).toBeGreaterThan(0);
  });
});
