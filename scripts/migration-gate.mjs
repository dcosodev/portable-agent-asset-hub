#!/usr/bin/env node
// Release gate for the migration package: package shape, safety scan (no
// `node:sqlite` imports, no reference to a harness's `state.db`), contract, safety
// and e2e tests, a focused Hermes/OpenClaw regression, lint/typecheck/build, and
// the catalog, OpenAPI, MCP, Hermes and OpenClaw gates. Writes a per-step record
// to artifacts/migration-gate.json.
//
//   PASS    every step passed. A BLOCKED OpenAPI gate (external generator
//           unavailable) is recorded on the artifact and does not fail this gate.
//   FAIL    any other step failed, or the OpenAPI gate failed outright. Exits 1.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRunId,
  recordInvocationEvidence,
} from './gate-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const artifactPath = resolve(repoRoot, 'artifacts/migration-gate.json');
// Unique per run. Child gate run IDs are generated inside their step so a snapshot
// of the prior artifact can be correlated with the file the step produced.
const thisRunId = buildRunId('migration-gate');
const openapiArtifactPath = resolve(repoRoot, 'artifacts/openapi-gate.json');
const mcpArtifactPath = resolve(repoRoot, 'artifacts/mcp-gate.json');
const hermesArtifactPath = resolve(repoRoot, 'artifacts/hermes-gate.json');
const openclawArtifactPath = resolve(repoRoot, 'artifacts/openclaw-gate.json');
const migrationPkgPath = resolve(repoRoot, 'packages/migration');
const migrationSrcPath = resolve(migrationPkgPath, 'src');
const materializersSrcPath = resolve(repoRoot, 'packages/materializers/src');

const REQUIRED_PACKAGE_NAME = '@portable-agent-asset-hub/migration';
const REQUIRED_PACKAGE_MAIN = './dist/index.js';
const REQUIRED_PACKAGE_TYPES = './dist/index.d.ts';
const REQUIRED_ADAPTER_SUBPATH = './adapters/python';
const REQUIRED_PUBLIC_API_KEYS = [
  'MIGRATION_STATES',
  'DATA_CLASSIFICATIONS',
  'SOURCE_ADAPTER_IDS',
  'LEGAL_TRANSITIONS',
  'isMigrationState',
  'isLegalTransition',
  'assertLegalTransition',
  'illegalTransitionError',
  'classifyFields',
  'isSecretKey',
  'redactPayload',
  'REDACTED_VALUE',
  'classifyAndRedact',
  'adaptMigrationStorage',
  'createExportService',
  'createImportService',
  'createShadowService',
  'createReplayService',
  'createCutoverService',
  'createRollbackService',
  'createRetirementService',
  'createMigrationService',
  'createPythonV2SourceAdapter',
];

const REQUIRED_TEST_FILES = {
  '03-migration-contracts': { path: 'tests/migration-contracts.test.ts', minTests: 13 },
  '04-migration-safety': { path: 'tests/migration-safety.test.ts', minTests: 3 },
  '05-migration-cutover-rollback-e2e': { path: 'tests/e2e/migration-cutover-rollback.e2e.test.ts', minTests: 1 },
};

const REQUIRED_REGRESSION_FILES = [
  { key: 'hermes-contracts',         path: 'tests/hermes-contracts.test.ts',                              minTests: 14 },
  { key: 'hermes-rest-integration',  path: 'tests/hermes-rest-integration.test.ts',                       minTests: 3 },
  { key: 'hermes-schemas',           path: 'tests/hermes-schemas.test.ts',                                minTests: 2 },
  { key: 'hermes-mat-e2e',    path: 'tests/e2e/hermes-materialization.e2e.test.ts',            minTests: 4 },
  { key: 'hermes-rollback',   path: 'tests/e2e/hermes-rollback.e2e.test.ts',                   minTests: 3 },
  { key: 'openclaw-contracts',         path: 'tests/openclaw-contracts.test.ts',                              minTests: 25 },
  { key: 'openclaw-rest-integration',  path: 'tests/openclaw-rest-integration.test.ts',                       minTests: 3 },
  { key: 'openclaw-schemas',           path: 'tests/openclaw-schemas.test.ts',                                minTests: 4 },
];

const REQUIRED_REGRESSION_TOTAL_MIN = 58;

const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+['"]node:sqlite['"]/,
  /require\(\s*['"]node:sqlite['"]\s*\)/,
];

const FORBIDDEN_STATE_DB_PATTERNS = [
  /state\.db/,
  /['"]state\.db['"]/,
];

const steps = {};
const assertions = [];

function digest(value) {
  return createHash('sha256').update(value ?? '').digest('hex');
}

function recordAssertion(name, ok, detail) {
  assertions.push({ name, ok: !!ok, detail: detail ?? null });
}

function tail(s, n) {
  if (typeof s !== 'string') return '';
  if (s.length <= n) return s;
  return `…${s.slice(-n)}`;
}

/**
 * Run a single command, capture stdout/stderr (with a generous cap), and
 * record a structured step entry. Returns the exit code (null when the
 * process could not be spawned at all).
 */
async function runStep({ name, command, args, kind = 'hard', cwd = repoRoot, env = { ...process.env, CI: 'true' }, timeoutMs = 30 * 60 * 1000 }) {
  const step = {
    name,
    kind,
    status: 'PENDING',
    startedAt: new Date().toISOString(),
    command: [command, ...args].join(' '),
    args,
  };
  steps[name] = step;
  try {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    const maxCollector = (64 + 16) * 1024 * 1024;
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;
    let timedOut = false;
    let timeoutHandle;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, timeoutMs);
    }
    child.stdout.on('data', (chunk) => {
      if (truncated) return;
      stdoutLen += chunk.length;
      if (stdoutLen > maxCollector) { truncated = true; return; }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (truncated) return;
      stderrLen += chunk.length;
      if (stderrLen > maxCollector) { truncated = true; return; }
      stderrChunks.push(chunk);
    });
    const result = await new Promise((resolveRun) => {
      child.once('error', (err) => resolveRun({ status: null, error: err }));
      child.once('close', (code, signal) => resolveRun({ status: code, signal }));
    });
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    const exitCode = result.status ?? (result.signal ? 128 + (typeof result.signal === 'number' ? result.signal : 1) : 1);
    step.exit_code = exitCode;
    step.signal = result.signal ?? null;
    step.stdout_digest = digest(stdout);
    step.stderr_digest = digest(stderr);
    step.stdout_tail = tail(stdout, 2048);
    step.stderr_tail = tail(stderr, 2048);
    if (truncated) {
      step.truncated = true;
      step.max_collected_chars = maxCollector;
    }
    if (timedOut) step.timed_out = true;
    if (result.error) {
      step.spawn_error = String(result.error.message ?? result.error);
      step.status = 'FAIL';
    } else if (timedOut) {
      step.status = 'FAIL';
    } else {
      step.status = exitCode === 0 ? 'PASS' : 'FAIL';
    }
    return { exitCode, stdout, stderr };
  } catch (e) {
    step.finishedAt = new Date().toISOString();
    step.status = 'FAIL';
    step.error = String(e?.message ?? e);
    return { exitCode: 1, stdout: '', stderr: step.error };
  } finally {
    step.finishedAt = new Date().toISOString();
  }
}

// Strip ANSI escape codes from a captured vitest tail so the regex
// parser below sees plain whitespace between the field labels and the
// counts. The escape sequence is built character-by-character at runtime
// so eslint's no-control-regex rule does not flag the source.
const ANSI_RE = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g');
function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI_RE, '') : '';
}

/**
 * Parse `passed` / `failed` test counts out of the vitest tail we
 * captured. The reporter format is stable enough for the gate's needs;
 * the catalog gate uses vitest's JSON reporter instead.
 */
function parseVitestCounts(stdout) {
  const text = stripAnsi(typeof stdout === 'string' ? stdout : '');
  const testsMatch = text.match(/Tests\s+(\d+)\s+passed(?:\s+\((\d+)\))?/);
  const pass = testsMatch ? Number(testsMatch[1]) : null;
  const failMatch = text.match(/Tests\s+(?:\d+\s+passed\s+\|?\s*)?(\d+)\s+failed/);
  const fail = failMatch ? Number(failMatch[1]) : null;
  return { pass, fail };
}

/**
 * Recursively walk a directory returning the list of .ts/.js/.mjs files
 * (skipping node_modules and dist).
 */
function walkSourceFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) stack.push(full);
      else if (/\.(ts|js|mjs)$/.test(entry)) out.push(full);
    }
  }
  return out;
}

/**
 * Probe the @portable-agent-asset-hub/migration package shape and the
 * public surface it advertises. If its name, main, types, or subpath export drift, every
 * downstream consumer breaks silently.
 */
async function probeMigrationPackageManifest() {
  if (!existsSync(migrationPkgPath)) {
    return { ok: false, reason: `migration package missing at ${migrationPkgPath}` };
  }
  const pkgJsonPath = join(migrationPkgPath, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return { ok: false, reason: `migration package.json missing at ${pkgJsonPath}` };
  }
  let pkg;
  try {
    pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `migration package.json malformed: ${e.message}` };
  }
  const indexTsPath = join(migrationSrcPath, 'index.ts');
  let indexTs = '';
  if (existsSync(indexTsPath)) {
    indexTs = await readFile(indexTsPath, 'utf8');
  }
  const missingExports = REQUIRED_PUBLIC_API_KEYS.filter((k) => !indexTs.includes(k));
  const exportsMap = (pkg.exports && typeof pkg.exports === 'object') ? pkg.exports : {};
  const rootExport = (exportsMap['.']
    && typeof exportsMap['.'] === 'object') ? exportsMap['.'] : null;
  const rootImport = rootExport?.import ?? null;
  const rootTypes = rootExport?.types ?? null;
  const adapterSubpath = exportsMap[`${REQUIRED_ADAPTER_SUBPATH}`] ?? null;
  const adapterImport = adapterSubpath?.import ?? null;
  const adapterTypes = adapterSubpath?.types ?? null;
  const pythonAdapterSrcPath = join(migrationSrcPath, 'adapters/python.ts');
  const pythonAdapterSrcExists = existsSync(pythonAdapterSrcPath);

  const ok = pkg.name === REQUIRED_PACKAGE_NAME
    && pkg.main === REQUIRED_PACKAGE_MAIN
    && pkg.types === REQUIRED_PACKAGE_TYPES
    && rootImport === REQUIRED_PACKAGE_MAIN
    && rootTypes === REQUIRED_PACKAGE_TYPES
    && adapterImport === './dist/adapters/python.js'
    && adapterTypes === './dist/adapters/python.js'
    && pythonAdapterSrcExists
    && missingExports.length === 0;

  return {
    ok,
    reason: ok ? null : [
      pkg.name !== REQUIRED_PACKAGE_NAME ? `package name must be '${REQUIRED_PACKAGE_NAME}', got '${pkg.name}'` : null,
      pkg.main !== REQUIRED_PACKAGE_MAIN ? `package main must be '${REQUIRED_PACKAGE_MAIN}', got '${pkg.main}'` : null,
      pkg.types !== REQUIRED_PACKAGE_TYPES ? `package types must be '${REQUIRED_PACKAGE_TYPES}', got '${pkg.types}'` : null,
      rootImport !== REQUIRED_PACKAGE_MAIN ? `exports['.'].import must be '${REQUIRED_PACKAGE_MAIN}', got '${rootImport}'` : null,
      rootTypes !== REQUIRED_PACKAGE_TYPES ? `exports['.'].types must be '${REQUIRED_PACKAGE_TYPES}', got '${rootTypes}'` : null,
      adapterImport !== './dist/adapters/python.js' ? `exports['./adapters/python'].import mismatch, got '${adapterImport}'` : null,
      adapterTypes !== './dist/adapters/python.js' ? `exports['./adapters/python'].types mismatch, got '${adapterTypes}'` : null,
      !pythonAdapterSrcExists ? `python adapter source missing at ${pythonAdapterSrcPath}` : null,
      missingExports.length ? `public surface missing: ${missingExports.join(', ')}` : null,
    ].filter(Boolean).join('; '),
    metadata: {
      package_name: pkg.name ?? null,
      package_version: pkg.version ?? null,
      package_main: pkg.main ?? null,
      package_types: pkg.types ?? null,
      root_import: rootImport,
      root_types: rootTypes,
      adapter_subpath: REQUIRED_ADAPTER_SUBPATH,
      adapter_import: adapterImport,
      adapter_types: adapterTypes,
      python_adapter_src_exists: pythonAdapterSrcExists,
      missing_exports: missingExports,
      index_ts_bytes: indexTs.length,
    },
    raw_digest: digest(JSON.stringify(pkg)),
  };
}

/**
 * Structural safety scan: walk the migration package src tree and the
 * materializer adapter tree, scanning each file for `node:sqlite`
 * imports and for any reference to a harness's `state.db`. A single
 * hit fails the gate.
 */
async function probeSafetyScan() {
  if (!existsSync(migrationSrcPath)) {
    return { ok: false, reason: `migration src missing at ${migrationSrcPath}`, violations: [] };
  }
  const files = walkSourceFiles(migrationSrcPath);
  const violations = [];
  for (const file of files) {
    let content;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const rel = file.slice(migrationSrcPath.length + 1);
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      if (pattern.test(content)) {
        violations.push({
          file: rel,
          kind: 'node:sqlite-import',
          pattern: pattern.toString(),
        });
      }
    }
    for (const pattern of FORBIDDEN_STATE_DB_PATTERNS) {
      if (pattern.test(content)) {
        violations.push({
          file: rel,
          kind: 'state.db-reference',
          pattern: pattern.toString(),
        });
      }
    }
  }
  // Materializers must not import `node:sqlite` or reference `state.db` either.
  let materializerAdapterFiles = [];
  if (existsSync(materializersSrcPath)) {
    materializerAdapterFiles = walkSourceFiles(materializersSrcPath);
    for (const file of materializerAdapterFiles) {
      let content;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const rel = file.slice(materializersSrcPath.length + 1);
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        if (pattern.test(content)) {
          violations.push({
            file: rel,
            kind: 'node:sqlite-import',
            pattern: pattern.toString(),
            scope: 'materializers/src',
          });
        }
      }
      for (const pattern of FORBIDDEN_STATE_DB_PATTERNS) {
        if (pattern.test(content)) {
          violations.push({
            file: rel,
            kind: 'state.db-reference',
            pattern: pattern.toString(),
            scope: 'materializers/src',
          });
        }
      }
    }
  }

  const ok = violations.length === 0;
  return {
    ok,
    reason: ok
      ? null
      : `found ${violations.length} forbidden reference(s): ${violations.slice(0, 5).map((v) => `${v.kind}@${v.file}`).join(', ')}`,
    violations,
    metadata: {
      migration_src_files_scanned: files.length,
      materializer_src_files_scanned: materializerAdapterFiles.length,
    },
  };
}

async function inspectGateArtifact(p) {
  if (!existsSync(p)) {
    return { ok: false, status: 'MISSING', reason: `artifact missing at ${p}`, artifact: null };
  }
  let obj;
  try {
    obj = JSON.parse(await readFile(p, 'utf8'));
  } catch (e) {
    return { ok: false, status: 'UNREADABLE', reason: `artifact unreadable: ${e.message}`, artifact: null };
  }
  const status = typeof obj.status === 'string' ? obj.status : 'UNKNOWN';
  return { ok: true, status, artifact: obj };
}

async function persistArtifact(artifact) {
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

async function main() {
  await mkdir(dirname(artifactPath), { recursive: true });

  const pkgManifestProbe = await probeMigrationPackageManifest();
  steps['01-migration-package-manifest'] = {
    name: '01-migration-package-manifest',
    kind: 'probe',
    status: pkgManifestProbe.ok ? 'PASS' : 'FAIL',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    assertion: `migration package must be '${REQUIRED_PACKAGE_NAME}', main='${REQUIRED_PACKAGE_MAIN}', types='${REQUIRED_PACKAGE_TYPES}', expose '${REQUIRED_ADAPTER_SUBPATH}' subpath export, and re-export the full public surface (${REQUIRED_PUBLIC_API_KEYS.length} symbols)`,
    reason: pkgManifestProbe.ok ? null : pkgManifestProbe.reason,
    metadata: pkgManifestProbe.metadata ?? null,
    raw_digest: pkgManifestProbe.raw_digest ?? null,
  };
  recordAssertion('migration-package-manifest', pkgManifestProbe.ok, pkgManifestProbe.ok ? 'migration package shape ok' : pkgManifestProbe.reason);

  const safetyProbe = await probeSafetyScan();
  steps['02-safety-scan'] = {
    name: '02-safety-scan',
    kind: 'probe',
    status: safetyProbe.ok ? 'PASS' : 'FAIL',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    assertion: 'packages/migration/src (and packages/materializers/src) must contain no `node:sqlite` imports and no `state.db` references',
    reason: safetyProbe.ok ? null : safetyProbe.reason,
    metadata: safetyProbe.metadata ?? null,
    violations: safetyProbe.violations ?? [],
  };
  recordAssertion('safety-scan', safetyProbe.ok, safetyProbe.ok ? 'safety scan clean' : safetyProbe.reason);

  // Each suite runs in isolation so the artifact pinpoints which file regressed.
  for (const [stepName, { path: testPath, minTests }] of Object.entries(REQUIRED_TEST_FILES)) {
    const result = await runStep({
      name: stepName,
      kind: 'hard',
      command: 'pnpm',
      args: ['exec', 'vitest', 'run', testPath],
      timeoutMs: 10 * 60 * 1000,
    });
    const counts = parseVitestCounts(result.stdout);
    const ok = result.exitCode === 0
      && counts.pass !== null
      && counts.pass >= minTests
      && (counts.fail === null || counts.fail === 0);
    recordAssertion(stepName, ok,
      ok
        ? `${testPath} passed (>= ${minTests})`
        : `${testPath} exit ${result.exitCode} pass=${counts.pass} fail=${counts.fail} expected>=${minTests}: ${tail(result.stderr, 240)}`);
    steps[stepName].test_path = testPath;
    steps[stepName].min_tests = minTests;
    steps[stepName].tests_passed = counts.pass;
    steps[stepName].tests_failed = counts.fail;
    steps[stepName].assertion = `${testPath} must pass with >= ${minTests} tests`;
  }

  // Only the Hermes and OpenClaw materializer tests the migration package depends on.
  // Their `Tests X passed` counts must total at least REQUIRED_REGRESSION_TOTAL_MIN.
  let regressionTotal = 0;
  const regressionResults = {};
  let regressionAnyFail = false;
  for (const { key, path: testPath, minTests } of REQUIRED_REGRESSION_FILES) {
    const stepName = `06-regression-${key}`;
    const result = await runStep({
      name: stepName,
      kind: 'hard',
      command: 'pnpm',
      args: ['exec', 'vitest', 'run', testPath],
      timeoutMs: 10 * 60 * 1000,
    });
    const counts = parseVitestCounts(result.stdout);
    const ok = result.exitCode === 0
      && counts.pass !== null
      && counts.pass >= minTests
      && (counts.fail === null || counts.fail === 0);
    regressionResults[key] = {
      path: testPath,
      min_tests: minTests,
      tests_passed: counts.pass,
      tests_failed: counts.fail,
      exit_code: result.exitCode,
      ok,
    };
    if (counts.pass !== null) regressionTotal += counts.pass;
    if (!ok) regressionAnyFail = true;
    recordAssertion(`regression-${key}`, ok,
      ok
        ? `${testPath} passed (>= ${minTests})`
        : `${testPath} exit ${result.exitCode} pass=${counts.pass} fail=${counts.fail} expected>=${minTests}: ${tail(result.stderr, 240)}`);
    steps[stepName].test_path = testPath;
    steps[stepName].min_tests = minTests;
    steps[stepName].tests_passed = counts.pass;
    steps[stepName].tests_failed = counts.fail;
    steps[stepName].assertion = `${testPath} must pass with >= ${minTests} tests`;
  }
  const regressionOk = !regressionAnyFail && regressionTotal >= REQUIRED_REGRESSION_TOTAL_MIN;
  steps['06-hermes-openclaw-focused-regression'] = {
    name: '06-hermes-openclaw-focused-regression',
    kind: 'aggregate',
    status: regressionOk ? 'PASS' : 'FAIL',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    assertion: `hermes/openclaw focused regression: ${REQUIRED_REGRESSION_FILES.length} files, total tests passed must be >= ${REQUIRED_REGRESSION_TOTAL_MIN}`,
    tests_total_passed: regressionTotal,
    tests_total_min: REQUIRED_REGRESSION_TOTAL_MIN,
    files: regressionResults,
    files_required: REQUIRED_REGRESSION_FILES.length,
  };
  recordAssertion('hermes-openclaw-focused-regression', regressionOk,
    regressionOk
      ? `hermes/openclaw focused regression passed (${regressionTotal} tests >= ${REQUIRED_REGRESSION_TOTAL_MIN})`
      : `hermes/openclaw focused regression failed (total=${regressionTotal}, expected>=${REQUIRED_REGRESSION_TOTAL_MIN})`);

  const lint = await runStep({
    name: '07-lint',
    kind: 'hard',
    command: 'pnpm',
    args: ['lint'],
  });
  recordAssertion('lint', lint.exitCode === 0,
    lint.exitCode === 0 ? 'lint ok' : `lint exit ${lint.exitCode}`);

  const typecheck = await runStep({
    name: '08-typecheck',
    kind: 'hard',
    command: 'pnpm',
    args: ['typecheck'],
  });
  recordAssertion('typecheck', typecheck.exitCode === 0,
    typecheck.exitCode === 0 ? 'typecheck ok' : `typecheck exit ${typecheck.exitCode}`);

  const build = await runStep({
    name: '09-build',
    kind: 'hard',
    command: 'pnpm',
    args: ['build'],
    timeoutMs: 30 * 60 * 1000,
  });
  recordAssertion('build', build.exitCode === 0,
    build.exitCode === 0 ? 'build ok' : `build exit ${build.exitCode}`);

  // The catalog gate is deterministic, so it must PASS.
  const catalog = await runStep({
    name: '10-catalog-regression',
    kind: 'hard',
    command: 'pnpm',
    args: ['catalog:gate'],
    timeoutMs: 30 * 60 * 1000,
  });
  recordAssertion('catalog-regression', catalog.exitCode === 0,
    catalog.exitCode === 0 ? 'catalog gate ok' : `catalog gate exit ${catalog.exitCode}`);

  // The OpenAPI gate may report BLOCKED when its external generator is missing,
  // so read its artifact rather than trusting the exit code alone.
  await runStep({
    name: '11-openapi-regression',
    kind: 'hard',
    command: 'pnpm',
    args: ['openapi:gate'],
    timeoutMs: 30 * 60 * 1000,
  });
  const openapiInspect = await inspectGateArtifact(openapiArtifactPath);
  steps['11b-openapi-artifact'] = {
    name: '11b-openapi-artifact',
    kind: 'probe',
    status: openapiInspect.ok ? 'PASS' : 'FAIL',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    assertion: 'openapi artifact must exist and declare a recognized status',
    openapi_status: openapiInspect.ok ? openapiInspect.status : openapiInspect.status,
    openapi_reason: openapiInspect.ok ? null : openapiInspect.reason,
    openapi_verdict: openapiInspect.artifact?.verdict ?? null,
    openapi_summary: openapiInspect.artifact?.summary ?? null,
    openapi_generator_blocked: openapiInspect.artifact?.generator_blocked ?? null,
    openapi_generator_available: openapiInspect.artifact?.generator_available ?? null,
  };
  const openapiVerdict = openapiInspect.artifact?.verdict ?? (openapiInspect.status ?? 'UNKNOWN');
  const openapiArtifact = openapiInspect.artifact ?? {};
  const openapiStepsFailed = typeof openapiArtifact.summary?.steps_failed === 'number'
    ? openapiArtifact.summary.steps_failed
    : null;
  const openapiGeneratorBlocked = openapiArtifact.generator_blocked === true;
  const openapiInheritedBlock = openapiVerdict === 'BLOCKED'
    && openapiGeneratorBlocked
    && (openapiStepsFailed === 0 || openapiStepsFailed === null);
  const openapiHasHardFailures = openapiStepsFailed !== null && openapiStepsFailed > 0;
  const openapi_failed = openapiInspect.ok === false
    || (openapiVerdict !== 'PASS' && openapiVerdict !== 'BLOCKED')
    || openapiHasHardFailures
    || (openapiVerdict === 'BLOCKED' && !openapiInheritedBlock);
  recordAssertion('openapi-regression', openapiVerdict === 'PASS' || openapiInheritedBlock,
    openapiVerdict === 'PASS' ? 'openapi gate ok' : (openapiInheritedBlock ? 'openapi gate BLOCKED (inherited from external generator)' : `openapi gate verdict=${openapiVerdict}`));

  // Exit 2 from the OpenAPI gate means BLOCKED, not failure.
  const openapiStep = steps['11-openapi-regression'];
  if (openapiStep && openapiInheritedBlock && !openapi_failed) {
    openapiStep.status = 'PASS';
    openapiStep.note = 'openapi exited 2 (BLOCKED); re-classified as PASS for migration aggregation';
  }

  // An inherited MCP BLOCKED is not accepted: its own verdict must be PASS.
  const mcp = await runStep({
    name: '12-mcp-regression',
    kind: 'hard',
    command: 'pnpm',
    args: ['mcp:gate'],
    // Budget, not a check: this regression re-runs its own chain of gates and takes
    // longer than the 30-minute default on a machine under load. A timeout still fails.
    timeoutMs: 60 * 60 * 1000,
  });
  const mcpInspect = await inspectGateArtifact(mcpArtifactPath);
  steps['12b-mcp-artifact'] = {
    name: '12b-mcp-artifact',
    kind: 'probe',
    status: mcpInspect.ok ? (mcpInspect.status === 'PASS' ? 'PASS' : 'FAIL') : 'FAIL',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    assertion: 'mcp artifact must exist and declare PASS (migration does not accept inherited BLOCKED from mcp)',
    mcp_status: mcpInspect.ok ? mcpInspect.status : mcpInspect.status,
    mcp_reason: mcpInspect.ok ? null : mcpInspect.reason,
    mcp_verdict: mcpInspect.artifact?.verdict ?? null,
    mcp_summary: mcpInspect.artifact?.summary ?? null,
  };
  const mcpVerdict = mcpInspect.artifact?.verdict ?? (mcpInspect.status ?? 'UNKNOWN');
  const mcp_failed = mcp.exitCode !== 0
    || !mcpInspect.ok
    || mcpVerdict !== 'PASS';
  recordAssertion('mcp-regression', !mcp_failed,
    !mcp_failed ? 'mcp gate ok' : `mcp gate exit ${mcp.exitCode} verdict=${mcpVerdict}${mcpInspect.ok ? '' : ` (${mcpInspect.reason})`}`);

  // An inherited Hermes BLOCKED is not accepted: its own verdict must be PASS.
  const hermes = await runStep({
    name: '13-hermes-regression',
    kind: 'hard',
    command: 'pnpm',
    args: ['hermes:gate'],
    // Budget, not a check: this regression re-runs its own chain of gates and takes
    // longer than the 30-minute default on a machine under load. A timeout still fails.
    timeoutMs: 90 * 60 * 1000,
  });
  const hermesInspect = await inspectGateArtifact(hermesArtifactPath);
  steps['13b-hermes-artifact'] = {
    name: '13b-hermes-artifact',
    kind: 'probe',
    status: hermesInspect.ok ? (hermesInspect.status === 'PASS' ? 'PASS' : 'FAIL') : 'FAIL',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    assertion: 'hermes artifact must exist and declare PASS (migration does not accept inherited BLOCKED from hermes)',
    hermes_status: hermesInspect.ok ? hermesInspect.status : hermesInspect.status,
    hermes_reason: hermesInspect.ok ? null : hermesInspect.reason,
    hermes_verdict: hermesInspect.artifact?.verdict ?? null,
    hermes_summary: hermesInspect.artifact?.summary ?? null,
  };
  const hermesVerdict = hermesInspect.artifact?.verdict ?? (hermesInspect.status ?? 'UNKNOWN');
  const hermes_failed = hermes.exitCode !== 0
    || !hermesInspect.ok
    || hermesVerdict !== 'PASS';
  recordAssertion('hermes-regression', !hermes_failed,
    !hermes_failed ? 'hermes gate ok' : `hermes gate exit ${hermes.exitCode} verdict=${hermesVerdict}${hermesInspect.ok ? '' : ` (${hermesInspect.reason})`}`);

  // Capture hermes-gate.json before the OpenClaw gate runs: its nested Hermes run
  // overwrites the file, and a later PASS must not hide this run's FAIL.
  const hermesStep = steps['13-hermes-regression'];
  const hermesDirectStartAt = hermesStep?.startedAt ?? null;
  const hermesDirectEndAt = new Date().toISOString();
  const hermesDirectInvocationRunId = buildRunId('migration-hermes-regression');
  const hermesDirectEntry = recordInvocationEvidence({
    repoRoot,
    parentRunId: thisRunId,
    invocationRunId: hermesDirectInvocationRunId,
    invocationName: '13-hermes-regression-direct',
    scope: 'migration-direct',
    command: hermesStep?.command ?? 'pnpm hermes:gate',
    exitCode: hermes.exitCode ?? null,
    status: hermesStep?.status ?? (hermes_failed ? 'FAIL' : 'PASS'),
    stdout: hermes.stdout ?? '',
    stderr: hermes.stderr ?? '',
    startAt: hermesDirectStartAt,
    endAt: hermesDirectEndAt,
    observedArtifactPath: hermesArtifactPath,
    observedArtifact: hermesInspect.artifact ?? null,
  });

  // An inherited OpenClaw BLOCKED is not accepted: its own verdict must be PASS.
  const openclaw = await runStep({
    name: '14-openclaw-regression',
    kind: 'hard',
    command: 'pnpm',
    args: ['openclaw:gate'],
    // Budget, not a check: this regression re-runs its own chain of gates and takes
    // longer than the 30-minute default on a machine under load. A timeout still fails.
    timeoutMs: 180 * 60 * 1000,
  });
  const openclawInspect = await inspectGateArtifact(openclawArtifactPath);
  steps['14b-openclaw-artifact'] = {
    name: '14b-openclaw-artifact',
    kind: 'probe',
    status: openclawInspect.ok ? (openclawInspect.status === 'PASS' ? 'PASS' : 'FAIL') : 'FAIL',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    assertion: 'openclaw artifact must exist and declare PASS (migration does not accept inherited BLOCKED from openclaw)',
    openclaw_status: openclawInspect.ok ? openclawInspect.status : openclawInspect.status,
    openclaw_reason: openclawInspect.ok ? null : openclawInspect.reason,
    openclaw_verdict: openclawInspect.artifact?.verdict ?? null,
    openclaw_summary: openclawInspect.artifact?.summary ?? null,
  };
  const openclawVerdict = openclawInspect.artifact?.verdict ?? (openclawInspect.status ?? 'UNKNOWN');
  const openclaw_failed = openclaw.exitCode !== 0
    || !openclawInspect.ok
    || openclawVerdict !== 'PASS';
  recordAssertion('openclaw-regression', !openclaw_failed,
    !openclaw_failed ? 'openclaw gate ok' : `openclaw gate exit ${openclaw.exitCode} verdict=${openclawVerdict}${openclawInspect.ok ? '' : ` (${openclawInspect.reason})`}`);

  // `hermes_failed` was computed before the OpenClaw gate ran, so a first Hermes FAIL
  // stays a FAIL even when the nested Hermes run passes. Fail-closed comes from the
  // aggregation order, not from re-reading the on-disk file.
  const openclawStep = steps['14-openclaw-regression'];
  const openclawInvocationRunId = buildRunId('migration-openclaw-regression');
  const openclawInvocationEntry = recordInvocationEvidence({
    repoRoot,
    parentRunId: thisRunId,
    invocationRunId: openclawInvocationRunId,
    invocationName: '14-openclaw-regression-direct',
    scope: 'migration-direct',
    command: openclawStep?.command ?? 'pnpm openclaw:gate',
    exitCode: openclaw.exitCode ?? null,
    status: openclawStep?.status ?? (openclaw_failed ? 'FAIL' : 'PASS'),
    stdout: openclaw.stdout ?? '',
    stderr: openclaw.stderr ?? '',
    startAt: openclawStep?.startedAt ?? null,
    endAt: new Date().toISOString(),
    observedArtifactPath: openclawArtifactPath,
    observedArtifact: openclawInspect.artifact ?? null,
  });

  // Record the nested Hermes run from the artifact it just wrote, so both runs stay
  // distinguishable by runId. If the OpenClaw artifact does not expose the inner
  // runId, record `unavailable` rather than inventing one.
  let hermesViaOpenclawEntry;
  const hermesAfterOpenclawInspect = await inspectGateArtifact(hermesArtifactPath);
  if (hermesAfterOpenclawInspect.ok) {
    const innerHermesArtifact = hermesAfterOpenclawInspect.artifact;
    const innerHermesRunId = typeof innerHermesArtifact?.runId === 'string'
      ? innerHermesArtifact.runId
      : null;
    const openclawParentRunId = typeof openclawInspect.artifact?.runId === 'string'
      ? openclawInspect.artifact.runId
      : 'unavailable';
    // The nested run's immediate parent is the OpenClaw gate, not this gate.
    hermesViaOpenclawEntry = recordInvocationEvidence({
      repoRoot,
      parentRunId: openclawParentRunId,
      invocationRunId: innerHermesRunId ?? `migration-via-openclaw-unknown-${Date.now()}`,
      invocationName: '12-hermes-regression-via-openclaw',
      scope: 'migration-via-openclaw',
      command: 'pnpm hermes:gate',
      exitCode: null,
      status: hermesAfterOpenclawInspect.status ?? 'UNKNOWN',
      stdout: '',
      stderr: '',
      startAt: null,
      endAt: innerHermesArtifact?.emitted_at ?? null,
      observedArtifactPath: hermesArtifactPath,
      observedArtifact: innerHermesArtifact,
    });
  } else {
    // The OpenClaw gate may have failed before its nested Hermes run. hermes-gate.json
    // then still reflects the direct run, so record `unavailable` to keep the array shape.
    hermesViaOpenclawEntry = {
      ok: false,
      error: 'openclaw invocation did not produce an hermes-gate.json — inner hermes runId unavailable',
      scope: 'migration-via-openclaw',
      invocationName: '12-hermes-regression-via-openclaw',
      observedArtifactPath: hermesArtifactPath,
      observed_status: 'UNAVAILABLE',
      observed_verdict: null,
      observedRunId: 'unavailable',
      parentRunId: typeof openclawInspect.artifact?.runId === 'string'
        ? openclawInspect.artifact.runId
        : 'unavailable',
      invocationRunId: 'unavailable',
      emitted_at: null,
      snapshot: { existed: false, path: null, digest: null, bytes: 0, preserved_previous_path: null },
      log: null,
    };
  }

  const allStepNames = Object.keys(steps);
  const hardFailures = allStepNames.filter((n) => steps[n].status === 'FAIL');
  const passedSteps = allStepNames.filter((n) => steps[n].status === 'PASS');
  const pendingSteps = allStepNames.filter((n) => steps[n].status === 'PENDING');

  // A BLOCKED OpenAPI gate is the only accepted upstream BLOCKED.
  const migrationOwnFailures = hardFailures.filter((n) => n !== '11-openapi-regression' && n !== '11b-openapi-artifact');

  let verdict;
  let migrationStatus;
  if (migrationOwnFailures.length > 0) {
    verdict = 'FAIL';
    migrationStatus = 'CHANGES_REQUIRED';
  } else if (openapi_failed) {
    verdict = 'FAIL';
    migrationStatus = 'CHANGES_REQUIRED';
  } else if (mcp_failed) {
    verdict = 'FAIL';
    migrationStatus = 'CHANGES_REQUIRED';
  } else if (hermes_failed) {
    verdict = 'FAIL';
    migrationStatus = 'CHANGES_REQUIRED';
  } else if (openclaw_failed) {
    verdict = 'FAIL';
    migrationStatus = 'CHANGES_REQUIRED';
  } else if (pendingSteps.length > 0) {
    verdict = 'FAIL';
    migrationStatus = 'CHANGES_REQUIRED';
  } else {
    verdict = 'PASS';
    migrationStatus = 'APPROVE';
  }

  const passingAssertions = assertions.filter((a) => a.ok === true).length;
  const failingAssertions = assertions.filter((a) => a.ok === false).length;

  const artifact = {
    gate: 'migration',
    status: verdict,
    verdict,
    migration_status: migrationStatus,
    complete: verdict === 'PASS',
    blocked: verdict === 'BLOCKED',
    failed: verdict === 'FAIL',
    migration_package: {
      name: REQUIRED_PACKAGE_NAME,
      name_observed: pkgManifestProbe.metadata?.package_name ?? null,
      version_observed: pkgManifestProbe.metadata?.package_version ?? null,
      main_required: REQUIRED_PACKAGE_MAIN,
      main_observed: pkgManifestProbe.metadata?.package_main ?? null,
      types_required: REQUIRED_PACKAGE_TYPES,
      types_observed: pkgManifestProbe.metadata?.package_types ?? null,
      adapter_subpath: REQUIRED_ADAPTER_SUBPATH,
      adapter_import_observed: pkgManifestProbe.metadata?.adapter_import ?? null,
      adapter_types_observed: pkgManifestProbe.metadata?.adapter_types ?? null,
      public_surface_required: REQUIRED_PUBLIC_API_KEYS.length,
      public_surface_missing: pkgManifestProbe.metadata?.missing_exports ?? [],
      python_adapter_src_exists: pkgManifestProbe.metadata?.python_adapter_src_exists ?? null,
    },
    safety_scan: {
      ok: safetyProbe.ok,
      violations: safetyProbe.violations ?? [],
      migration_src_files_scanned: safetyProbe.metadata?.migration_src_files_scanned ?? 0,
      materializer_src_files_scanned: safetyProbe.metadata?.materializer_src_files_scanned ?? 0,
    },
    openapi_status: openapiInspect.ok ? openapiInspect.status : openapiInspect.status,
    openapi_verdict: openapiVerdict,
    openapi_inherited_blocked: openapiInheritedBlock,
    openapi_reason: openapiInspect.ok ? null : openapiInspect.reason,
    mcp_status: mcpInspect.ok ? mcpInspect.status : mcpInspect.status,
    mcp_verdict: mcpVerdict,
    mcp_failed,
    hermes_status: hermesInspect.ok ? hermesInspect.status : hermesInspect.status,
    hermes_verdict: hermesVerdict,
    hermes_failed,
    openclaw_status: openclawInspect.ok ? openclawInspect.status : openclawInspect.status,
    openclaw_verdict: openclawVerdict,
    openclaw_failed,
    summary: {
      steps_total: allStepNames.length,
      steps_passed: passedSteps.length,
      steps_failed: hardFailures.length,
      steps_pending: pendingSteps.length,
      migration_own_failures: migrationOwnFailures,
      openapi_failed,
      openapi_blocked: openapiInheritedBlock,
      mcp_failed,
      hermes_failed,
      openclaw_failed,
      s8s9_regression_total: regressionTotal,
      s8s9_regression_min: REQUIRED_REGRESSION_TOTAL_MIN,
      assertions_total: assertions.length,
      assertions_passed: passingAssertions,
      assertions_failed: failingAssertions,
    },
    steps,
    assertions,
    test_inventory: Object.fromEntries(
      Object.entries(REQUIRED_TEST_FILES).map(([name, { path, minTests }]) => [
        name,
        {
          path,
          min_tests: minTests,
          tests_passed: steps[name]?.tests_passed ?? null,
          tests_failed: steps[name]?.tests_failed ?? null,
        },
      ]),
    ),
    regression_inventory: Object.fromEntries(
      REQUIRED_REGRESSION_FILES.map(({ key, path, minTests }) => [
        key,
        {
          path,
          min_tests: minTests,
          tests_passed: regressionResults[key]?.tests_passed ?? null,
          tests_failed: regressionResults[key]?.tests_failed ?? null,
        },
      ]),
    ),
    // Chronological: the direct Hermes run is always first, the nested run follows.
    // The OpenClaw run is recorded separately on `openclaw_invocation`.
    hermes_invocations: [
      hermesDirectEntry,
      hermesViaOpenclawEntry,
    ].filter(Boolean),
    openclaw_invocation: openclawInvocationEntry,
    // Correlates this artifact with its evidence dir at artifacts/.evidence/<runId>.
    runId: thisRunId,
    // Per-invocation paths live inside each `hermes_invocations[*].log` entry.
    evidence_paths: {
      runId: thisRunId,
      evidenceRoot: 'artifacts/.evidence',
      log_dir_pattern: 'artifacts/.evidence/<runId>/*.stdout.log',
      meta_dir_pattern: 'artifacts/.evidence/<runId>/*.meta.json',
      snapshot_pattern: 'artifacts/.evidence/<runId>/*.snapshot.json',
    },
    limits: {
      rawBodiesCaptured: false,
      buffersDrained: false,
      max_collected_chars_per_step: (64 + 16) * 1024 * 1024,
    },
    artifact_path: 'artifacts/migration-gate.json',
    emitted_at: new Date().toISOString(),
  };

  if (migrationOwnFailures.length > 0) artifact.migration_own_failed_steps = migrationOwnFailures;
  if (hardFailures.length > 0) artifact.failed_steps = hardFailures;

  await persistArtifact(artifact);
  console.log(JSON.stringify(artifact, null, 2));

  if (verdict === 'FAIL') process.exit(1);
}

await main();