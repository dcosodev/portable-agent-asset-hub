import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const restSrc = resolve(here, '../../packages/rest/src');

/**
 * Structural assertion suite for the S6 REST modularization. Verifies that
 * the route table is split into per-domain modules under packages/rest/src/routes
 * and that app.ts wires them together, without exercising any HTTP semantics.
 * All checks are static so they are independent of test environment, fixtures,
 * Java, or the SDK generator.
 */

type RouteEntry = { method: string; pattern: string; operationId: string; cas: boolean };

const DOMAINS: Array<{ module: string; export: string }> = [
  { module: 'health', export: 'healthRoutes' },
  { module: 'admin', export: 'adminRoutes' },
  { module: 'identities', export: 'identityRoutes' },
  { module: 'profiles', export: 'profileRoutes' },
  { module: 'memory-blocks', export: 'memoryBlockRoutes' },
  { module: 'memories', export: 'memoryRoutes' },
  { module: 'skills', export: 'skillRoutes' },
  { module: 'catalog', export: 'catalogRoutes' },
  { module: 'sync', export: 'syncRoutes' },
  { module: 'materializations', export: 'materializationRoutes' },
  { module: 'events', export: 'eventRoutes' },
];

const EXPECTED_OPERATION_IDS: ReadonlySet<string> = new Set([
  'getHealth',
  'getStatus',
  'getDoctor',
  'listAudit',
  'listSnapshots',
  'replay',
  'listIdentities',
  'createBinding',
  'createProfile',
  'listMemoryBlocks',
  'createMemory',
  'supersedeMemory',
  'forgetMemory',
  'listSkills',
  'listSkillVersions',
  'getResource',
  'getCatalog',
  'previewCatalogSync',
  'applyCatalogSync',
  'previewMaterialization',
  'applyMaterialization',
  'rollbackMaterialization',
  'createEvent',
]);

function extractRoutesFromModule(modulePath: string): RouteEntry[] {
  const source = readFileSync(modulePath, 'utf8');
  const entries: RouteEntry[] = [];
  const re = /\{\s*method:\s*'([^']+)'\s*,\s*pattern:\s*(\/.*?\/)\s*,\s*operationId:\s*'([^']+)'\s*,\s*cas:\s*(true|false)\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    entries.push({
      method: match[1]!,
      // Normalize to source form so equality works across flags
      pattern: match[2]!,
      operationId: match[3]!,
      cas: match[4] === 'true',
    });
  }
  return entries;
}

describe('S6 REST routes modularization (structural)', () => {
  it('s6_route_domain_modules_exist', () => {
    for (const { module, export: exportName } of DOMAINS) {
      const path = resolve(restSrc, 'routes', `${module}.ts`);
      const source = readFileSync(path, 'utf8');
      // Each module must declare and export the named *Routes const.
      const declRe = new RegExp(`export\\s+const\\s+${exportName}\\s*[:=]`, 'm');
      expect(declRe.test(source), `module ${module}.ts must export const ${exportName}`).toBe(true);
      // And it must be a non-empty array literal of route entries.
      const arrayRe = new RegExp(`export\\s+const\\s+${exportName}\\s*=\\s*\\[`, 'm');
      expect(arrayRe.test(source), `module ${module}.ts must declare ${exportName} as an array`).toBe(true);
    }
  });

  it('s6_app_imports_every_domain_module', () => {
    const appSource = readFileSync(resolve(restSrc, 'app.ts'), 'utf8');
    // Module basename may include '-', so allow word-or-dash in the capture.
    const importRe = /import\s*\{\s*(\w+Routes)\s*\}\s*from\s*'\.\/routes\/([\w-]+)\.js'/g;
    const imported = new Map<string, string>();
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(appSource)) !== null) {
      imported.set(match[2]!, match[1]!);
    }
    expect(imported.size, 'app.ts must import one *Routes const per domain').toBe(DOMAINS.length);
    for (const { module, export: exportName } of DOMAINS) {
      expect(imported.get(module), `app.ts must import ${exportName} from routes/${module}.js`).toBe(exportName);
    }
  });

  it('s6_app_no_inline_route_literals', () => {
    const appSource = readFileSync(resolve(restSrc, 'app.ts'), 'utf8');
    // app.ts must not contain any local route literal (method/pattern/operationId/cas).
    // Only the type annotation in the spread site may mention these names.
    expect(/\{\s*method:\s*'[^']+'\s*,\s*pattern:\s*\//.test(appSource),
      'app.ts must not contain a route literal (no inline { method, pattern, ... } entries)').toBe(false);
    // And it must spread each domain module into the final routes table.
    const spreadCount = (appSource.match(/\.\.\.\w+Routes/g) ?? []).length;
    expect(spreadCount, 'app.ts must spread each *Routes module into the final routes table').toBe(DOMAINS.length);
  });

  it('s6_all_23_operation_ids_present_across_modules', () => {
    const all = new Set<string>();
    const perModule: Record<string, string[]> = {};
    for (const { module } of DOMAINS) {
      const entries = extractRoutesFromModule(resolve(restSrc, 'routes', `${module}.ts`));
      const ops = entries.map((e) => e.operationId);
      perModule[module] = ops;
      for (const op of ops) all.add(op);
    }
    expect(all.size, 'no operationId may be duplicated across domain modules').toBe(23);
    const missing = [...EXPECTED_OPERATION_IDS].filter((op) => !all.has(op)).sort();
    const extra = [...all].filter((op) => !EXPECTED_OPERATION_IDS.has(op)).sort();
    expect(missing, `missing operationIds: ${missing.join(',')}`).toEqual([]);
    expect(extra, `unexpected operationIds: ${extra.join(',')}`).toEqual([]);
    // Sanity: at least one entry per module (no empty stubs).
    for (const { module } of DOMAINS) {
      expect(perModule[module]!.length, `routes/${module}.ts must declare at least one route`).toBeGreaterThan(0);
    }
  });

  it('s6_module_route_shapes_are_well_formed', () => {
    for (const { module, export: exportName } of DOMAINS) {
      const entries = extractRoutesFromModule(resolve(restSrc, 'routes', `${module}.ts`));
      for (const entry of entries) {
        expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], `${exportName} method`).toContain(entry.method);
        expect(entry.pattern.startsWith('/') && entry.pattern.endsWith('/'),
          `${exportName} pattern must be a RegExp literal`).toBe(true);
        expect(/^[a-zA-Z][a-zA-Z0-9_]*$/.test(entry.operationId),
          `${exportName} operationId must be an identifier: ${entry.operationId}`).toBe(true);
        expect(typeof entry.cas, `${exportName} cas must be boolean`).toBe('boolean');
      }
    }
  });
});