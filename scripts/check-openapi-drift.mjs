#!/usr/bin/env node
// scripts/check-openapi-drift.mjs
//
// Drift detector for openapi/openapi.yaml and the split files in
// openapi/components/. Checks:
//
//   * Every $ref is resolvable, both for refs that point into ./components/
//     and for chained external refs that loop back into the same file.
//   * Every operation has a unique operationId and the required x-*
//     extensions.
//   * The set of operations matches the canonical 23-operation set
//     declared below — accidental renames or additions show up as
//     failures instead of silently shipping.
//   * Components declared under components.{schemas,parameters,
//     securitySchemes} all resolve and have no contradictory duplicates
//     (two literal definitions for the same key with different bytes).
//   * Components referenced from inside any operation resolve to a known
//     file/fragment. The "errors" file is treated as a logical alias of
//     "schemas" for the Error component so it does not surface as
//     undeclared / unreferenced noise.
//   * Drift between OpenAPI operationIds and the REST routes
//     (`packages/rest/src/routes/**/*.ts`) — both directions are checked
//     (REST must declare every OpenAPI op, and may not invent its own).
//
// Emits a single JSON object on stdout, writes artifacts/openapi-drift.json,
// and exits 0 on success, non-zero on failure.
//
// The repository root can be overridden via the OPENAPI_DRIFT_ROOT environment
// variable, which is what the test fixtures use to point the detector at a
// scratch directory instead of the real repo.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_GEN_VERSION = '7.10.0';
const REQUIRED_OPERATION_EXTENSIONS = ['x-mcp.exposed', 'x-mcp.capability', 'x-mcp.safety', 'x-idempotent', 'x-cas-required'];
const KNOWN_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
// Canonical 23-operation set. The drift detector refuses to pass unless the
// spec declares exactly these operationIds — in any order — so accidental
// renames or additions show up as failures instead of silently shipping.
const EXPECTED_OPERATION_IDS = Object.freeze([
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
]);

const here = dirname(fileURLToPath(import.meta.url));
// `OPENAPI_DRIFT_ROOT` lets the test fixtures (and ad-hoc debugging) point
// the detector at a scratch directory instead of the real repo. When the
// env var is set, it's used verbatim; otherwise we derive the repo root
// from this script's own location (…/scripts/check-openapi-drift.mjs).
const repoRoot = process.env.OPENAPI_DRIFT_ROOT
  ? resolve(process.env.OPENAPI_DRIFT_ROOT)
  : resolve(here, '..');
const openapiPath = resolve(repoRoot, 'openapi/openapi.yaml');
const routesDir = resolve(repoRoot, 'packages/rest/src/routes');
const artifactPath = resolve(repoRoot, 'artifacts/openapi-drift.json');

const errors = [];
const warnings = [];
const operations = [];
const seenOperationIds = new Set();
const duplicateOperationIds = [];
const refsSeen = [];
const declared = { schemas: [], parameters: [], securitySchemes: [] };
const referenced = { schemas: new Set(), parameters: new Set(), securitySchemes: new Set(), errors: new Set() };

async function loadDoc(path) {
  const raw = await readFile(path, 'utf8');
  // Both JSON content and YAML content are supported; the repo keeps component
  // fragments as JSON for legibility but the top-level file is JSON-shaped YAML.
  // Strip a single YAML front matter if present (none in this repo).
  if (raw.startsWith('---')) {
    const withoutFrontMatter = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
    return JSON.parse(withoutFrontMatter);
  }
  return JSON.parse(raw);
}

function decodeFragment(part) {
  return decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function walkFragment(doc, fragment) {
  if (!fragment || fragment === '/' || fragment === '') return doc;
  const parts = fragment.split('/').filter(Boolean).map(decodeFragment);
  let current = doc;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      throw new Error(`cannot walk into non-object at "${part}"`);
    }
    if (!(part in current)) {
      throw new Error(`dangling fragment at "${part}"`);
    }
    current = current[part];
  }
  return current;
}

async function resolveRef(ref, fromFile) {
  const hashIndex = ref.indexOf('#');
  if (hashIndex < 0) throw new Error(`ref missing '#': ${ref}`);
  const fileRel = ref.slice(0, hashIndex);
  const fragment = ref.slice(hashIndex + 1);
  let doc;
  if (fileRel === '' || fileRel === '#') {
    doc = await loadDoc(fromFile);
  } else {
    const filePath = resolve(dirname(fromFile), fileRel);
    doc = await loadDoc(filePath);
  }
  return walkFragment(doc, fragment);
}

function collectRefs(value, refs = []) {
  if (value === null || value === undefined) return refs;
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') refs.push(v);
      else collectRefs(v, refs);
    }
  }
  return refs;
}

function deepStableStringify(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) return '"[cycle]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((v) => deepStableStringify(v, seen)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${deepStableStringify(value[k], seen)}`).join(',')}}`;
}

function recordRefs(value, refs = []) {
  collectRefs(value, refs);
  for (const ref of refs) {
    if (ref.startsWith('./components/schemas.yaml#/')) referenced.schemas.add(ref.split('#/')[1]);
    else if (ref.startsWith('./components/errors.yaml#/')) referenced.errors.add(ref.split('#/')[1]);
    else if (ref.startsWith('./components/parameters.yaml#/')) referenced.parameters.add(ref.split('#/')[1]);
    else if (ref.startsWith('./components/security.yaml#/')) referenced.securitySchemes.add(ref.split('#/')[1]);
  }
  return refs;
}

async function collectRestRoutes() {
  let entries;
  try {
    entries = await readdir(routesDir, { withFileTypes: true });
  } catch (e) {
    // No routes directory is allowed in fixtures that don't ship REST routes.
    // Surface this as a configuration error so it doesn't accidentally pass.
    throw new Error(`failed to read REST routes directory ${routesDir}: ${e.message}`, { cause: e });
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const full = resolve(routesDir, entry.name);
    const text = await readFile(full, 'utf8');
    // Match either:
    //   operationId: 'foo'   (the real repo route definition shape)
    //   operationId = 'foo'  (a `const operationId = ...` export used by tests)
    // Both forms carry the same operationId value; the detector only needs the string.
    const opRegex = /operationId\s*[:=]\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = opRegex.exec(text)) !== null) {
      found.push({ operationId: match[1], file: relative(repoRoot, full) });
    }
  }
  return found;
}

/**
 * The OpenAPI spec re-exports the "Error" component both via
 * components.schemas.Error and via the dedicated errors.yaml file. The two
 * are treated as a logical alias: a reference to errors/Error satisfies any
 * corresponding declaration under schemas/Error, and vice versa. This helper
 * encodes the alias symmetrically so neither side trips the parity check.
 *
 * The alias is intentionally narrow — only "Error" is bridged. Adding a
 * second alias would require an explicit decision in this file AND in the
 * fixture used by the detector tests.
 */
function isLogicalAliasName(name) {
  return name === 'Error';
}

async function main() {
  let openapi;
  try {
    openapi = await loadDoc(openapiPath);
  } catch (e) {
    errors.push(`top-level openapi parse failed: ${e.message}`);
    return finalize(openapi, null);
  }

  // 1. Validate operations.
  for (const [path, methods] of Object.entries(openapi.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!KNOWN_METHODS.has(method)) continue;
      operations.push({ path, method, operationId: op.operationId });
      if (!op.operationId || typeof op.operationId !== 'string') {
        errors.push(`${method.toUpperCase()} ${path}: missing operationId`);
      } else if (seenOperationIds.has(op.operationId)) {
        duplicateOperationIds.push(op.operationId);
        errors.push(`${method.toUpperCase()} ${path}: duplicate operationId "${op.operationId}"`);
      } else {
        seenOperationIds.add(op.operationId);
      }
      for (const key of REQUIRED_OPERATION_EXTENSIONS) {
        if (!(key in op)) errors.push(`${method.toUpperCase()} ${path}: missing ${key}`);
      }
      // Collect refs under each operation so we can attribute dangling ones.
      const refs = recordRefs(op);
      for (const ref of refs) refsSeen.push({ ref, from: `${method} ${path}` });
    }
  }
  if (operations.length === 0) errors.push('openapi.yaml declares no operations');

  // 1b. Enforce the canonical 23-operation set only for the real repository.
  // Fixture roots intentionally contain smaller contracts for focused tests.
  const actualRepoRoot = resolve(here, '..');
  const declaredIds = new Set(seenOperationIds);
  if (repoRoot === actualRepoRoot) {
    const expectedIds = new Set(EXPECTED_OPERATION_IDS);
    for (const id of EXPECTED_OPERATION_IDS) {
      if (!declaredIds.has(id)) {
        errors.push(`missing canonical operationId "${id}" (not declared under any path)`);
      }
    }
    for (const id of declaredIds) {
      if (!expectedIds.has(id)) {
        errors.push(`unexpected operationId "${id}" (not in the canonical set of 23)`);
      }
    }
  }

  // 2. Resolve every $ref we've seen.
  let refsResolved = 0;
  const dangling = [];
  for (const { ref, from } of refsSeen) {
    try {
      await resolveRef(ref, openapiPath);
      refsResolved += 1;
    } catch (e) {
      dangling.push(`${ref} (from ${from}): ${e.message}`);
    }
  }
  for (const d of dangling) errors.push(`dangling ref ${d}`);

  // 3. Detect contradictory duplicate schema declarations across components/.
  const componentGroups = [
    { area: 'schemas', files: ['schemas'] },
    { area: 'parameters', files: ['parameters'] },
    { area: 'errors', files: ['errors'] },
    { area: 'security', files: ['security'] },
  ];
  for (const { area, files } of componentGroups) {
    const seen = new Map(); // key -> { file, bytes }
    for (const name of files) {
      const path = resolve(repoRoot, `openapi/components/${name}.yaml`);
      let doc;
      try {
        doc = await loadDoc(path);
      } catch (e) {
        errors.push(`component file ${name}.yaml: parse failed: ${e.message}`);
        continue;
      }
      for (const [key, value] of Object.entries(doc)) {
        // Resolve through any indirection so we compare final shapes, not raw aliases.
        let resolvedValue;
        try {
          const refs = collectRefs(value);
          if (refs.length > 0) {
            resolvedValue = await resolveRef(refs[0], path);
          } else {
            resolvedValue = value;
          }
        } catch {
          resolvedValue = value;
        }
        const bytes = deepStableStringify(resolvedValue);
        const prior = seen.get(key);
        if (!prior) {
          seen.set(key, { file: name, bytes });
        } else if (prior.bytes !== bytes) {
          errors.push(`contradictory duplicate: "${area}/${key}" defined in ${prior.file}.yaml differs from ${name}.yaml`);
        }
      }
    }
  }

  // 4. Component-block connectivity and inline-vs-external contradiction checks.
  const componentFileByArea = { schemas: 'schemas.yaml', parameters: 'parameters.yaml', securitySchemes: 'security.yaml' };
  for (const area of ['schemas', 'parameters', 'securitySchemes']) {
    let externalDoc;
    try {
      externalDoc = await loadDoc(resolve(repoRoot, `openapi/components/${componentFileByArea[area]}`));
    } catch {
      // Missing component files are reported through unresolved refs/connectivity checks.
    }
    for (const [name, body] of Object.entries(openapi.components?.[area] ?? {})) {
      declared[area].push(name);
      try {
        if (body && typeof body === 'object' && '$ref' in body) {
          await resolveRef(body.$ref, openapiPath);
        } else if (externalDoc?.[name] && deepStableStringify(body) !== deepStableStringify(externalDoc[name])) {
          errors.push(`contradictory inline component ${area}/${name} differs from ${componentFileByArea[area]}#/${name}`);
        }
      } catch (e) {
        errors.push(`declared component ${area}/${name} does not resolve: ${e.message}`);
      }
    }
  }

  // 5. Every key referenced via $ref should be declared somewhere reachable.
  //
  // The errors/<Name> area is treated as a logical alias of schemas/<Name>
  // for names returned by {@link isLogicalAliasName} (currently just "Error").
  // A reference to errors/Error is satisfied by a declaration under
  // schemas/Error and vice versa; this keeps the alias from showing up as
  // both an "undeclared" and an "unreferenced" violation while still
  // surfacing genuine orphans in other areas.
  const referencedFlat = {
    schemas: new Set([...referenced.schemas]),
    parameters: new Set([...referenced.parameters]),
    securitySchemes: new Set([...referenced.securitySchemes]),
    errors: new Set([...referenced.errors]),
  };

  const declaredByArea = {
    schemas: new Set(declared.schemas),
    errors: new Set(Object.keys(openapi.components?.errors ?? {})),
    parameters: new Set(declared.parameters),
    securitySchemes: new Set(declared.securitySchemes),
  };

  // 5a. Referenced errors/Name → must be declared in components.errors OR
  //     satisfy the schemas↔errors alias.
  for (const key of referencedFlat.errors) {
    const directlyDeclared = declaredByArea.errors.has(key);
    const aliased = isLogicalAliasName(key) && declaredByArea.schemas.has(key);
    if (!directlyDeclared && !aliased) {
      // The errors file is allowed to exist as a pure alias without a
      // components.errors block; verify the file body still defines the key.
      const content = await loadDoc(resolve(repoRoot, 'openapi/components/errors.yaml'));
      if (!(key in content)) {
        errors.push(`referenced component "errors/${key}" not declared in components.errors and missing from components/errors.yaml`);
      }
    }
  }
  // 5b. Referenced schemas/Name → must be declared in components.schemas OR
  //     the referenced key must physically exist in components/schemas.yaml
  //     (this is the "logical alias" path for entries that are wired via
  //     components.schemas.<Name> but only declare a sub-set of names).
  for (const key of referencedFlat.schemas) {
    if (!declaredByArea.schemas.has(key)) {
      const content = await loadDoc(resolve(repoRoot, 'openapi/components/schemas.yaml'));
      if (!(key in content)) {
        errors.push(`referenced component "schemas/${key}" not declared in components.schemas and missing from components/schemas.yaml`);
      }
    }
  }
  // 5c. Referenced parameters/securitySchemes → must be declared in their
  //     own block; the alias policy does not apply.
  for (const key of referencedFlat.parameters) {
    const content = await loadDoc(resolve(repoRoot, 'openapi/components/parameters.yaml'));
    if (!(key in content)) errors.push(`referenced component "parameters/${key}" missing from components/parameters.yaml`);
  }
  for (const key of referencedFlat.securitySchemes) {
    const content = await loadDoc(resolve(repoRoot, 'openapi/components/security.yaml'));
    if (!(key in content)) errors.push(`referenced component "securitySchemes/${key}" missing from components/security.yaml`);
  }

  // 5d. Declared components.schemas/<Name> must be referenced from some
  //     operation. The alias policy applies here too: a declaration under
  //     schemas/Error is satisfied by a reference to errors/Error.
  for (const name of declaredByArea.schemas) {
    const directlyReferenced = referencedFlat.schemas.has(name);
    const aliased = isLogicalAliasName(name) && referencedFlat.errors.has(name);
    if (!directlyReferenced && !aliased) {
      errors.push(`declared component "schemas/${name}" is not referenced anywhere`);
    }
  }
  // 5e. Declared components.errors/<Name> must be referenced from some
  //     operation. Symmetric alias: a declaration under errors/Error is
  //     satisfied by a reference to schemas/Error.
  for (const name of declaredByArea.errors) {
    const directlyReferenced = referencedFlat.errors.has(name);
    const aliased = isLogicalAliasName(name) && referencedFlat.schemas.has(name);
    if (!directlyReferenced && !aliased) {
      errors.push(`declared component "errors/${name}" is not referenced anywhere`);
    }
  }

  // 6. REST drift: every OpenAPI operationId must have a REST route and
  //    every REST route must have an OpenAPI operation.
  let restRoutes = [];
  try {
    restRoutes = await collectRestRoutes();
  } catch (e) {
    errors.push(e.message);
  }

  const restIds = new Map();
  for (const { operationId, file } of restRoutes) {
    if (restIds.has(operationId)) {
      errors.push(`REST routes declare duplicate operationId "${operationId}" (in ${file} and ${restIds.get(operationId)})`);
    } else {
      restIds.set(operationId, file);
    }
  }
  for (const id of declaredIds) {
    if (!restIds.has(id)) {
      errors.push(`OpenAPI operation "${id}" has no matching REST route declaration`);
    }
  }
  for (const [id, file] of restIds) {
    if (!declaredIds.has(id)) {
      errors.push(`REST route "${id}" (in ${file}) has no matching OpenAPI operation`);
    }
  }

  return finalize(openapi, {
    refsResolved,
    referenced: Object.fromEntries(Object.entries(referencedFlat).map(([k, v]) => [k, [...v].sort()])),
    restRoutes: restRoutes.length,
    restIds: [...restIds.keys()].sort(),
  });
}

async function finalize(_openapi, summary) {
  const ok = errors.length === 0;
  const report = {
    ok,
    reason: ok ? 'no_drift_detected' : 'drift_detected',
    generator_required_version: REQUIRED_GEN_VERSION,
    operations: operations.length,
    operation_ids: [...seenOperationIds].sort(),
    duplicate_operation_ids: duplicateOperationIds,
    refs_resolved: summary ? summary.refsResolved : 0,
    referenced: summary ? summary.referenced : { schemas: [], parameters: [], securitySchemes: [], errors: [] },
    declared: {
      schemas: declared.schemas,
      parameters: declared.parameters,
      securitySchemes: declared.securitySchemes,
    },
    rest_routes: summary ? summary.restRoutes : 0,
    rest_operation_ids: summary ? summary.restIds : [],
    errors,
    warnings,
  };
  const json = JSON.stringify(report, null, 2);
  console.log(JSON.stringify(report));
  // Artifact write is best-effort: a failure here must not mask a real
  // validation failure, so we swallow any I/O problems after logging.
  try {
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, json, 'utf8');
  } catch (e) {
    console.error(`[check-openapi-drift] warning: could not write artifact: ${e.message}`);
  }
  if (!ok) process.exit(1);
}

await main();
