// tests/check-openapi-drift.test.ts
//
// Detection tests for `scripts/check-openapi-drift.mjs`. The script is the
// gate that decides whether the OpenAPI surface, REST routes, and drift
// detection are still in parity. These tests pin three things:
//
//   1. Salida OK on the real repo: 23 operations, 23 REST routes, refs
//      resolved, no errors, artifact written.
//
//   2. The errors.yaml <-> schemas.yaml logical alias is honored:
//      declaring components.schemas.Error without referencing it under
//      schemas/* does NOT surface as "declared ... not referenced" when
//      errors/Error is referenced, and vice versa.
//
//   3. Failure modes surface as non-zero exit AND a populated errors[].
//
// Every fixture writes into a scratch directory under os.tmpdir() and is
// removed after the test; the real repo and artifact are never mutated.
// We also assert the artifact remains at the canonical path when the
// detector runs against the real repo.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..');
const scriptPath = join(repoRoot, 'scripts/check-openapi-drift.mjs');
const artifactPath = join(repoRoot, 'artifacts/openapi-drift.json');

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

interface Fixture {
  rootDir: string;
  openapiPath: string;
  componentsDir: string;
  routesDir: string;
}

function makeFixture(prefix: string): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  const openapiDir = join(rootDir, 'openapi');
  const componentsDir = join(openapiDir, 'components');
  const routesDir = join(rootDir, 'packages/rest/src/routes');
  mkdirSync(componentsDir, { recursive: true });
  mkdirSync(routesDir, { recursive: true });
  return {
    rootDir,
    openapiPath: join(openapiDir, 'openapi.yaml'),
    componentsDir,
    routesDir,
  };
}

function writeAll23Operations(openapiPath: string, routesDir: string): void {
  const expectedIds = [
    'getHealth',
    'getStatus',
    'getDoctor',
    'listIdentities',
    'createBinding',
    'createProfile',
    'listMemoryBlocks',
    'createEvent',
    'createMemory',
    'supersedeMemory',
    'forgetMemory',
    'listSkills',
    'listSkillVersions',
    'getResource',
    'getCatalog',
    'previewCatalogSync',
    'applyCatalogSync',
    'listAudit',
    'listSnapshots',
    'replay',
    'previewMaterialization',
    'applyMaterialization',
    'rollbackMaterialization',
  ];
  const paths: Record<string, Record<string, unknown>> = {};
  for (const id of expectedIds) {
    paths[`/api/v1/${id}`] = {
      get: {
        operationId: id,
        'x-mcp.exposed': true,
        'x-mcp.capability': 'fixture.read',
        'x-mcp.safety': 'safe',
        'x-idempotent': false,
        'x-cas-required': false,
        responses: {
          '200': {
            description: id,
            content: { 'application/json': { schema: { $ref: './components/schemas.yaml#/Health' } } },
          },
          default: {
            description: 'Error',
            content: { 'application/json': { schema: { $ref: './components/errors.yaml#/Error' } } },
          },
        },
      },
    };
  }
  const openapi = {
    openapi: '3.1.0',
    info: { title: 'fixture', version: '0.0.1' },
    paths,
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
  writeFileSync(openapiPath, `${JSON.stringify(openapi, null, 2)}\n`);
  // The detector also wants REST routes for the 23 canonical operations.
  // Three operations share a route file, the rest get one each.
  const routes: Record<string, string> = {};
  for (const id of expectedIds) {
    routes[`${id}.ts`] = `export const operationId = '${id}';\n`;
  }
  for (const [name, body] of Object.entries(routes)) {
    writeFileSync(join(routesDir, name), body);
  }
}

function writeBaseComponents(componentsDir: string): void {
  writeFileSync(
    join(componentsDir, 'schemas.yaml'),
    `${JSON.stringify(
      {
        Health: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(componentsDir, 'errors.yaml'),
    `${JSON.stringify(
      {
        Error: {
          type: 'object',
          required: ['error', 'request_id'],
          properties: { error: { type: 'object' }, request_id: { type: 'string' } },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(componentsDir, 'parameters.yaml'),
    `${JSON.stringify(
      { RequestId: { name: 'X-Request-Id', in: 'header', schema: { type: 'string' }, required: false } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(componentsDir, 'security.yaml'),
    `${JSON.stringify({ bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, null, 2)}\n`,
  );
}

function seedValidFixture(prefix: string): Fixture {
  const fx = makeFixture(prefix);
  writeAll23Operations(fx.openapiPath, fx.routesDir);
  writeBaseComponents(fx.componentsDir);
  return fx;
}

describe('check-openapi-drift.mjs detector', () => {
  const scratch: Fixture[] = [];

  afterEach(() => {
    while (scratch.length > 0) {
      const fx = scratch.pop();
      if (fx) rmSync(fx.rootDir, { recursive: true, force: true });
    }
  });

  describe('happy path on the real repo', () => {
    it('reports_zero_drift_on_real_repo', () => {
      const { status, report } = runDrift(repoRoot);
      expect(status).toBe(0);
      expect(report.ok).toBe(true);
      expect(report.reason).toBe('no_drift_detected');
      expect(report.operations).toBe(23);
      expect(report.rest_routes).toBe(23);
      expect(report.refs_resolved).toBeGreaterThan(0);
      expect(report.duplicate_operation_ids ?? []).toEqual([]);
      expect(report.errors ?? []).toEqual([]);
      // The 23 canonical operationIds must all be present.
      expect(new Set(report.operation_ids ?? []).size).toBe(23);
      // The 23 REST routes must all be present.
      expect(new Set(report.rest_operation_ids ?? []).size).toBe(23);
    });

    it('writes_artifact_to_artifacts_openapi_drift_json', () => {
      const { status } = runDrift(repoRoot);
      expect(status).toBe(0);
      expect(existsSync(artifactPath)).toBe(true);
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as DriftReport;
      expect(artifact.ok).toBe(true);
      expect(artifact.operations).toBe(23);
      expect(artifact.rest_routes).toBe(23);
    });
  });

  describe('happy path on a well-formed fixture', () => {
    let fx: Fixture;
    beforeEach(() => {
      fx = seedValidFixture('drift-detector-ok-');
      scratch.push(fx);
    });

    it('exit_0_on_canonical_23_ops_and_23_routes', () => {
      const { status, report } = runDrift(fx.rootDir);
      expect(status).toBe(0);
      expect(report.ok).toBe(true);
      expect(report.operations).toBe(23);
      expect(report.rest_routes).toBe(23);
      expect(report.refs_resolved).toBeGreaterThan(0);
    });

    it('errors_yaml_schemas_yaml_alias_does_not_surface_as_finding', () => {
      // The fixture intentionally references errors/Error from every
      // operation AND declares components.schemas.Error (the real-repo
      // shape). The alias policy must let both sides consider each other
      // satisfied and not emit:
      //   - "declared component 'schemas/Error' is not referenced anywhere"
      //   - "referenced component 'errors/Error' is not declared ..."
      const { report } = runDrift(fx.rootDir);
      expect(report.errors ?? []).toEqual([]);
      expect(report.referenced?.errors ?? []).toContain('Error');
      expect(report.declared?.schemas ?? []).toContain('Error');
    });

    it('artifact_path_is_canonical', () => {
      const { status } = runDrift(fx.rootDir);
      expect(status).toBe(0);
      // The fixture writes the artifact to <fixture>/artifacts/openapi-drift.json
      // because OPENAPI_DRIFT_ROOT points there. The fixture's artifact is
      // not the repo's — but the FACT that the artifact was written proves
      // the write path is exercised; the real-repo test above covers the
      // canonical artifact path.
      const fixtureArtifact = join(fx.rootDir, 'artifacts/openapi-drift.json');
      expect(existsSync(fixtureArtifact)).toBe(true);
    });
  });

  describe('failure modes', () => {
    it('fails_when_a_ref_dangles', () => {
      const fx = seedValidFixture('drift-detector-dangling-');
      scratch.push(fx);
      // Rewrite one operation's success response to point at a missing
      // fragment. The fixture never has a "NotARealSchema" entry so this
      // is a guaranteed dangling ref.
      const doc = JSON.parse(readFileSync(fx.openapiPath, 'utf8')) as {
        paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }> }>>;
      };
      doc.paths['/api/v1/getHealth'].get.responses['200'].content['application/json'].schema.$ref =
        './components/schemas.yaml#/NotARealSchema';
      writeFileSync(fx.openapiPath, `${JSON.stringify(doc, null, 2)}\n`);
      const { status, report } = runDrift(fx.rootDir);
      expect(status).not.toBe(0);
      expect(report.ok).toBe(false);
      expect((report.errors ?? []).length).toBeGreaterThan(0);
      expect((report.errors ?? []).some((e) => /NotARealSchema/.test(e))).toBe(true);
    });

    it('fails_when_a_canonical_operationId_is_missing', () => {
      const fx = seedValidFixture('drift-detector-missing-op-');
      scratch.push(fx);
      // Drop the getHealth OpenAPI path while leaving the REST route
      // file in place. The detector's canonical 23-operation check is
      // intentionally gated to the real repo root (so fixture-based
      // sub-tests can use smaller contracts), but the same intent is
      // surfaced through the REST↔OpenAPI drift check: any REST route
      // with no matching OpenAPI operationId is reported as an error
      // that mentions the orphaned operationId.
      const doc = JSON.parse(readFileSync(fx.openapiPath, 'utf8')) as {
        paths: Record<string, Record<string, unknown>>;
      };
      delete doc.paths['/api/v1/getHealth'];
      writeFileSync(fx.openapiPath, `${JSON.stringify(doc, null, 2)}\n`);
      // NOTE: getHealth.ts is deliberately kept so the drift detector
      // surfaces an error referencing the missing operationId.
      const { status, report } = runDrift(fx.rootDir);
      expect(status).not.toBe(0);
      expect(report.ok).toBe(false);
      expect((report.errors ?? []).length).toBeGreaterThan(0);
      expect((report.errors ?? []).some((e) => /getHealth/.test(e))).toBe(true);
    });

    it('fails_when_REST_route_has_no_matching_openapi_operation', () => {
      const fx = seedValidFixture('drift-detector-rabbit-');
      scratch.push(fx);
      // Add a REST route that no OpenAPI operation declares.
      writeFileSync(join(fx.routesDir, 'phantom.ts'), `export const operationId = 'phantomOp';\n`);
      const { status, report } = runDrift(fx.rootDir);
      expect(status).not.toBe(0);
      expect(report.ok).toBe(false);
      expect((report.errors ?? []).some((e) => /phantomOp/.test(e))).toBe(true);
    });

    it('alias_fix_does_not_hide_unrelated_orphans', () => {
      const fx = seedValidFixture('drift-detector-orphan-');
      scratch.push(fx);
      // Declare schemas/Orphan but never reference it from any operation.
      // It is NOT eligible for the errors/schemas alias (not the Error
      // name), so it must still surface as "declared ... not referenced".
      const doc = JSON.parse(readFileSync(fx.openapiPath, 'utf8')) as {
        components: { schemas: Record<string, unknown> };
      };
      doc.components.schemas.Orphan = { $ref: './components/schemas.yaml#/Health' };
      writeFileSync(fx.openapiPath, `${JSON.stringify(doc, null, 2)}\n`);
      const { status, report } = runDrift(fx.rootDir);
      expect(status).not.toBe(0);
      expect(report.ok).toBe(false);
      expect((report.errors ?? []).some((e) => /schemas\/Orphan/.test(e))).toBe(true);
    });
  });

  describe('repo is not mutated', () => {
    it('does_not_leave_temporary_changes_in_the_repo', () => {
      // Run the detector against the repo, then verify every file we
      // care about is byte-identical to a snapshot taken before the run.
      const snapshotTargets = [
        join(repoRoot, 'openapi/openapi.yaml'),
        join(repoRoot, 'openapi/components/schemas.yaml'),
        join(repoRoot, 'openapi/components/errors.yaml'),
        join(repoRoot, 'openapi/components/parameters.yaml'),
        join(repoRoot, 'openapi/components/security.yaml'),
      ];
      const before = new Map<string, string>();
      for (const target of snapshotTargets) before.set(target, readFileSync(target, 'utf8'));
      const { status } = runDrift(repoRoot);
      expect(status).toBe(0);
      for (const [target, bytes] of before) {
        expect(readFileSync(target, 'utf8')).toBe(bytes);
      }
    });
  });
});
