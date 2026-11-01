#!/usr/bin/env node
// Release gate for the MCP surface: tool catalog generator, MCP/OpenAPI drift,
// tests/mcp, lint/typecheck/build, and the catalog and OpenAPI gates. Writes a
// per-step record to artifacts/mcp-gate.json.
//
//   PASS    every step passed. A BLOCKED OpenAPI gate (external generator
//           unavailable) is recorded on the artifact and does not fail this gate.
//   FAIL    any other step failed, or the OpenAPI gate failed outright. Exits 1.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const artifactPath = resolve(repoRoot, 'artifacts/mcp-gate.json');
const openapiArtifactPath = resolve(repoRoot, 'artifacts/openapi-gate.json');
const generatedToolMetadataPath = resolve(repoRoot, 'packages/mcp/src/generated-tool-metadata.ts');

const REQUIRED_GENERATOR_NAME = '@portable-agent-asset-hub/mcp/generate-mcp-tools';
const REQUIRED_GENERATOR_VERSION = '0.1.0';
const REQUIRED_TOOL_COUNT = 23;

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
 * record a structured step entry. `kind` distinguishes BLOCKED-friendly
 * steps from FAIL-only steps. The returned
 * `exitCode` mirrors the child process exit code (null when the process
 * could not be spawned at all).
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

/**
 * Parse the JSON summary line produced by `scripts/generate-mcp-tools.mjs`.
 * The script ends with `console.log(JSON.stringify({ generator, version,
 * output, operations, generatedAt }))` — that single line is the only
 * machine-readable signal the generator emits. We tolerate extra log lines
 * by scanning for the line whose JSON object has the `generator` field
 * matching the required generator name.
 */
function parseGeneratorSummary(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && obj.generator === REQUIRED_GENERATOR_NAME) {
        return obj;
      }
    } catch { /* ignore */ }
  }
  return null;
}

async function inspectGeneratedToolMetadata() {
  if (!existsSync(generatedToolMetadataPath)) {
    return { ok: false, reason: `generated file missing at ${generatedToolMetadataPath}` };
  }
  const raw = await readFile(generatedToolMetadataPath, 'utf8');
  // Count the operationId occurrences — the file format is stable and we
  // do not parse TS at runtime. The schema-match test enforces the exact
  // byte contract, this counter is only used for the generator self-check.
  const matches = raw.match(/^\s*"operationId"\s*:/gm) ?? [];
  const operationCount = matches.length;
  const metadata = {
    generator: extractExportString(raw, 'generator'),
    version: extractExportString(raw, 'version'),
    source: extractExportString(raw, 'source'),
    capabilityMatrix: extractExportString(raw, 'capabilityMatrix'),
    operationCount,
  };
  const ok = metadata.generator === REQUIRED_GENERATOR_NAME
    && metadata.version === REQUIRED_GENERATOR_VERSION
    && operationCount === REQUIRED_TOOL_COUNT;
  return { ok, metadata, raw_digest: digest(raw), raw_bytes: raw.length };
}

function extractExportString(raw, field) {
  const re = new RegExp(`\\b${field}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = raw.match(re);
  return m ? m[1] : null;
}

async function inspectOpenapiArtifact() {
  if (!existsSync(openapiArtifactPath)) {
    return { ok: false, status: 'MISSING', reason: `openapi artifact missing at ${openapiArtifactPath}` };
  }
  let obj;
  try {
    obj = JSON.parse(await readFile(openapiArtifactPath, 'utf8'));
  } catch (e) {
    return { ok: false, status: 'UNREADABLE', reason: `openapi artifact unreadable: ${e.message}` };
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

  // Generator failures are FAIL even if the drift detector happens to pass.
  const genResult = await runStep({
    name: '01-generator-mcp',
    kind: 'hard',
    command: process.execPath,
    args: [resolve(repoRoot, 'scripts/generate-mcp-tools.mjs')],
  });
  const genSummary = parseGeneratorSummary(genResult.stdout);
  recordAssertion('generator-mcp', genResult.exitCode === 0,
    genResult.exitCode === 0 ? 'generator exit 0' : `generator exit ${genResult.exitCode}: ${tail(genResult.stderr, 240)}`);

  // Guards against a generator that exits 0 but writes a degenerate manifest.
  const inspect = await inspectGeneratedToolMetadata();
  steps['02-generator-self-check'] = {
    name: '02-generator-self-check',
    kind: 'probe',
    status: inspect.ok ? 'PASS' : (existsSync(generatedToolMetadataPath) ? 'FAIL' : 'FAIL'),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    assertion: `generated tool metadata must declare ${REQUIRED_TOOL_COUNT} tools stamped by ${REQUIRED_GENERATOR_NAME}@${REQUIRED_GENERATOR_VERSION}`,
    metadata: inspect.metadata ?? null,
    reason: inspect.ok ? null : (inspect.reason ?? `expected ${REQUIRED_TOOL_COUNT} tools, got ${inspect.metadata?.operationCount ?? 'unknown'}; generator=${inspect.metadata?.generator ?? 'unknown'}; version=${inspect.metadata?.version ?? 'unknown'}`),
    raw_digest: inspect.raw_digest ?? null,
    raw_bytes: inspect.raw_bytes ?? null,
  };
  recordAssertion('generator-self-check', inspect.ok, inspect.ok ? 'generator stamped correct metadata' : (inspect.reason ?? 'metadata mismatch'));

  // Separate from the full suite so the artifact pinpoints a drift failure.
  const driftResult = await runStep({
    name: '03-drift-mcp-openapi',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/mcp/schema-match.test.ts'],
  });
  recordAssertion('drift-mcp-openapi', driftResult.exitCode === 0,
    driftResult.exitCode === 0 ? 'mcp↔openapi drift ok' : `mcp↔openapi drift exit ${driftResult.exitCode}`);

  const testsResult = await runStep({
    name: '04-tests-mcp',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/mcp'],
    timeoutMs: 10 * 60 * 1000,
  });
  recordAssertion('tests-mcp', testsResult.exitCode === 0,
    testsResult.exitCode === 0 ? 'tests/mcp ok' : `tests/mcp exit ${testsResult.exitCode}`);

  const lint = await runStep({
    name: '05-lint',
    kind: 'hard',
    command: 'pnpm',
    args: ['lint'],
  });
  recordAssertion('lint', lint.exitCode === 0,
    lint.exitCode === 0 ? 'lint ok' : `lint exit ${lint.exitCode}`);

  const typecheck = await runStep({
    name: '06-typecheck',
    kind: 'hard',
    command: 'pnpm',
    args: ['typecheck'],
  });
  recordAssertion('typecheck', typecheck.exitCode === 0,
    typecheck.exitCode === 0 ? 'typecheck ok' : `typecheck exit ${typecheck.exitCode}`);

  const build = await runStep({
    name: '07-build',
    kind: 'hard',
    command: 'pnpm',
    args: ['build'],
  });
  recordAssertion('build', build.exitCode === 0,
    build.exitCode === 0 ? 'build ok' : `build exit ${build.exitCode}`);

  // The catalog gate is deterministic, so it must PASS.
  const catalog = await runStep({
    name: '08-catalog-regression',
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
    name: '09-openapi-regression',
    kind: 'hard',
    command: 'pnpm',
    args: ['openapi:gate'],
    timeoutMs: 30 * 60 * 1000,
  });
  const openapiInspect = await inspectOpenapiArtifact();
  steps['09b-openapi-artifact'] = {
    name: '09b-openapi-artifact',
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
  // The authoritative OpenAPI verdicts are `openapiInheritedBlock` and `openapi_failed`,
  // computed below from the artifact.
  const openapiBlockedVerdict = openapiVerdict === 'BLOCKED';
  recordAssertion('openapi-regression', openapiVerdict === 'PASS' || openapiBlockedVerdict,
    openapiVerdict === 'PASS' ? 'openapi gate ok' : (openapiBlockedVerdict ? 'openapi gate BLOCKED (inherited from external generator)' : `openapi gate verdict=${openapiVerdict}`));

  // The OpenAPI step exits 2 when BLOCKED: the external generator is unavailable,
  // which is not an MCP failure. Reclassify the step from its artifact.
  const openapiArtifact = openapiInspect.artifact ?? {};
  const openapiStepsFailed = typeof openapiArtifact.summary?.steps_failed === 'number'
    ? openapiArtifact.summary.steps_failed
    : null;
  const openapiGeneratorBlocked = openapiArtifact.generator_blocked === true;
  const openapiInheritedBlock = openapiVerdict === 'BLOCKED'
    && openapiGeneratorBlocked
    && (openapiStepsFailed === 0 || openapiStepsFailed === null);
  const openapiHasHardFailures = openapiStepsFailed !== null && openapiStepsFailed > 0;
  // OpenAPI failed if its artifact is unreadable, its verdict is neither PASS nor
  // BLOCKED, any step failed, or it is BLOCKED for a reason other than the generator.
  const openapi_failed = openapiInspect.ok === false
    || (openapiVerdict !== 'PASS' && openapiVerdict !== 'BLOCKED')
    || openapiHasHardFailures
    || (openapiVerdict === 'BLOCKED' && !openapiInheritedBlock);

  const openapiStep = steps['09-openapi-regression'];
  if (openapiStep && openapiInheritedBlock && !openapi_failed) {
    openapiStep.status = 'PASS';
    openapiStep.note = 'openapi exited 2 (BLOCKED); re-classified as PASS for MCP aggregation';
  }

  const allStepNames = Object.keys(steps);
  const hardFailures = allStepNames.filter((n) => steps[n].status === 'FAIL');
  const passedSteps = allStepNames.filter((n) => steps[n].status === 'PASS');
  const pendingSteps = allStepNames.filter((n) => steps[n].status === 'PENDING');

  const mcpOwnFailures = hardFailures.filter((n) => n !== '09-openapi-regression' && n !== '09b-openapi-artifact');

  let verdict;
  let mcpStatus;
  if (mcpOwnFailures.length > 0) {
    verdict = 'FAIL';
    mcpStatus = 'CHANGES_REQUIRED';
  } else if (openapi_failed) {
    verdict = 'FAIL';
    mcpStatus = 'CHANGES_REQUIRED';
  } else if (pendingSteps.length > 0) {
    verdict = 'FAIL';
    mcpStatus = 'CHANGES_REQUIRED';
  } else {
    // An inherited BLOCKED passes (exit 0) but stays visible through
    // `openapi_inherited_blocked` and `openapi_status`.
    verdict = 'PASS';
    mcpStatus = 'APPROVE';
  }

  const passingAssertions = assertions.filter((a) => a.ok === true).length;
  const failingAssertions = assertions.filter((a) => a.ok === false).length;
  const skippedAssertions = assertions.filter((a) => a.ok === null).length;

  const artifact = {
    gate: 'mcp',
    status: verdict,
    verdict,
    mcp_status: mcpStatus,
    complete: verdict === 'PASS',
    blocked: verdict === 'BLOCKED',
    failed: verdict === 'FAIL',
    generator: {
      name: REQUIRED_GENERATOR_NAME,
      version_required: REQUIRED_GENERATOR_VERSION,
      version_observed: genSummary?.version ?? inspect.metadata?.version ?? null,
      tool_count_required: REQUIRED_TOOL_COUNT,
      tool_count_observed: inspect.metadata?.operationCount ?? null,
      generator_exit_code: genResult.exitCode,
      generator_summary: genSummary ?? null,
    },
    openapi_path: 'openapi/openapi.yaml',
    capability_matrix_schema_path: 'schemas/mcp-capabilities.v1.json',
    generated_metadata_path: 'packages/mcp/src/generated-tool-metadata.ts',
    openapi_status: openapiInspect.ok ? openapiInspect.status : openapiInspect.status,
    openapi_verdict: openapiInspect.artifact?.verdict ?? null,
    openapi_inherited_blocked: openapiBlockedVerdict,
    openapi_reason: openapiInspect.ok ? null : openapiInspect.reason,
    summary: {
      steps_total: allStepNames.length,
      steps_passed: passedSteps.length,
      steps_failed: hardFailures.length,
      steps_pending: pendingSteps.length,
      mcp_own_failures: mcpOwnFailures,
      openapi_failed,
      openapi_blocked: openapiBlockedVerdict,
      assertions_total: assertions.length,
      assertions_passed: passingAssertions,
      assertions_failed: failingAssertions,
      assertions_skipped: skippedAssertions,
    },
    steps,
    assertions,
    limits: {
      rawBodiesCaptured: false,
      buffersDrained: false,
      max_collected_chars_per_step: (64 + 16) * 1024 * 1024,
    },
    artifact_path: 'artifacts/mcp-gate.json',
    emitted_at: new Date().toISOString(),
  };

  if (mcpOwnFailures.length > 0) artifact.mcp_own_failed_steps = mcpOwnFailures;
  if (hardFailures.length > 0) artifact.failed_steps = hardFailures;

  await persistArtifact(artifact);
  console.log(JSON.stringify(artifact, null, 2));

  if (verdict === 'FAIL') process.exit(1);
}

await main();
