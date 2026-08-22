import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const openapiPath = resolve(here, '../openapi/openapi.yaml');
const componentsDir = resolve(here, '../openapi/components');

function loadJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
}

/**
 * Resolve a single $ref of the form "./components/<file>.yaml#/<name>" or
 * a fully-qualified "#/components/<area>/<name>" pointer.
 *
 * Only external file refs and the local #/components tree are resolved — the
 * fixture only needs to cover what openapi.yaml actually emits.
 */
function resolveRef(ref: string, fromFile: string, rootDoc: JsonObject): unknown {
  // We expect refs of the shape "./components/foo.yaml#/Bar" — anything else
  // is an upstream bug and we want a loud failure.
  const hashIndex = ref.indexOf('#');
  if (hashIndex < 0) throw new Error(`ref missing '#' fragment: ${ref}`);
  const fileRel = ref.slice(0, hashIndex);
  const fragment = ref.slice(hashIndex + 1);
  if (fileRel === '' || fileRel === '#') {
    return walkFragment(rootDoc, fragment, fromFile);
  }
  const filePath = resolve(dirname(fromFile), fileRel);
  const doc = loadJson(filePath);
  return walkFragment(doc, fragment, filePath);
}

function walkFragment(doc: JsonObject, fragment: string, filePath: string): unknown {
  if (fragment === '' || fragment === '/') return doc;
  const parts = fragment.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment.replace(/~1/g, '/').replace(/~0/g, '~')));
  let current: unknown = doc;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      throw new Error(`cannot walk into non-object at ${part} in ${filePath}#${fragment}`);
    }
    if (!(part in (current as JsonObject))) {
      throw new Error(`dangling ref: ${filePath}#${fragment} (missing "${part}")`);
    }
    current = (current as JsonObject)[part];
  }
  return current;
}

declare module 'vitest' {}

/** Walk every node, collecting $ref pointers encountered. */
function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (value === null || value === undefined) return refs;
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as JsonObject)) {
      if (k === '$ref' && typeof v === 'string') refs.push(v);
      else collectRefs(v, refs);
    }
  }
  return refs;
}

describe('S6 OpenAPI tracer bullet', () => {
  it('openapi_valid_and_operation_ids_unique', () => {
    const document = JSON.parse(readFileSync(openapiPath, 'utf8')) as { paths: Record<string, Record<string, { operationId?: string }>> };
    const operations = Object.values(document.paths).flatMap((path) => Object.values(path));
    expect(operations.length).toBeGreaterThan(0);
    const ids = operations.map((operation) => operation.operationId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('preserves_required_x_extensions_on_every_operation', () => {
    const document = loadJson(openapiPath) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const required = ['x-mcp.exposed', 'x-mcp.capability', 'x-mcp.safety', 'x-idempotent', 'x-cas-required'];
    const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
        .map(([method, op]) => ({ path, method, op })),
    );
    expect(operations).toHaveLength(23);
    for (const { path, method, op } of operations) {
      for (const key of required) {
        expect(key in op, `missing ${key} on ${method.toUpperCase()} ${path}`).toBe(true);
      }
      expect(typeof op.operationId).toBe('string');
    }
  });

  it('resolves_every_external_component_ref', () => {
    const document = loadJson(openapiPath);
    const refs = collectRefs(document);
    expect(refs.length).toBeGreaterThan(0);
    const visited: string[] = [];
    for (const ref of refs) {
      const resolved = resolveRef(ref, openapiPath, document);
      visited.push(`${ref} -> ${typeof resolved}`);
      expect(resolved).toBeDefined();
    }
    // Spot-check the named components are wired up:
    const names = ['./components/schemas.yaml#/Health', './components/schemas.yaml#/Status', './components/errors.yaml#/Error', './components/parameters.yaml#/RequestId', './components/parameters.yaml#/IfMatch', './components/security.yaml#/bearerAuth'];
    for (const expected of names) {
      expect(refs, `expected ref ${expected} to appear in openapi.yaml`).toContain(expected);
    }
  });

  it('external_component_files_exist_and_are_well_formed', () => {
    for (const file of ['schemas.yaml', 'errors.yaml', 'parameters.yaml', 'security.yaml']) {
      const path = resolve(componentsDir, file);
      expect(() => loadJson(path), `${file} must be valid JSON`).not.toThrow();
    }
  });

  it('fails_on_dangling_ref', () => {
    // Synthetic broken doc referencing a missing key — the helper must throw.
    const brokenDoc = {
      paths: {},
      components: {
        schemas: {
          Broken: { $ref: './components/schemas.yaml#/DoesNotExist' },
        },
      },
    };
    const refs = collectRefs(brokenDoc);
    expect(refs).toContain('./components/schemas.yaml#/DoesNotExist');
    expect(() => resolveRef('./components/schemas.yaml#/DoesNotExist', openapiPath, brokenDoc)).toThrow(/dangling ref/);
  });

  it('fails_on_missing_external_file', () => {
    const brokenDoc = {
      paths: {},
      components: {
        schemas: {
          Broken: { $ref: './components/nope.yaml#/X' },
        },
      },
    };
    expect(() => resolveRef('./components/nope.yaml#/X', openapiPath, brokenDoc)).toThrow();
  });
});
