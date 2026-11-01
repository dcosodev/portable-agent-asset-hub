#!/usr/bin/env node
// Release gate for the OpenAPI contract, REST routes, SDK generation and
// downstream packaging. Writes a per-step record to artifacts/openapi-gate.json.
//
//   PASS    every step passed and the real generator ran.
//   BLOCKED deterministic steps passed but the generator could not run (Java or
//           openapi-generator-cli missing). Exits 2. Regenerating the SDKs is
//           required for PASS, so this state is never reported as PASS.
//   FAIL    a deterministic step failed. Exits 1.

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const artifactPath = resolve(repoRoot, 'artifacts/openapi-gate.json');

const REQUIRED_GENERATOR_VERSION = '7.10.0';
const REQUIRED_GENERATOR_NAME = 'OpenAPI Generator';

const steps = {};
const assertions = [];

function digest(value) {
  return createHash('sha256').update(value ?? '').digest('hex');
}

function recordAssertion(name, ok, detail) {
  assertions.push({ name, ok: !!ok, detail: detail ?? null });
}

/**
 * Run a single command, capture stdout/stderr (with a generous cap), and
 * record a structured step entry. `kind` distinguishes BLOCKED-friendly
 * steps (the generator, when Java is missing) from FAIL-only steps. The
 * returned `exitCode` mirrors the child process exit code (null when the
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
      step.status = kind === 'soft' ? 'BLOCKED' : 'FAIL';
    } else if (timedOut) {
      step.status = kind === 'soft' ? 'BLOCKED' : 'FAIL';
    } else {
      step.status = exitCode === 0 ? 'PASS' : (kind === 'soft' ? 'BLOCKED' : 'FAIL');
    }
    return { exitCode, stdout, stderr };
  } catch (e) {
    step.finishedAt = new Date().toISOString();
    step.status = kind === 'soft' ? 'BLOCKED' : 'FAIL';
    step.error = String(e?.message ?? e);
    return { exitCode: 1, stdout: '', stderr: step.error };
  } finally {
    step.finishedAt = new Date().toISOString();
  }
}

function tail(s, n) {
  if (typeof s !== 'string') return '';
  if (s.length <= n) return s;
  return `…${s.slice(-n)}`;
}

function probeJava() {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (r.error) return { available: false, reason: `java not on PATH: ${r.error.message ?? r.error}` };
  if (r.status !== 0) return { available: false, reason: `java -version exited ${r.status}: ${(r.stderr ?? r.stdout ?? '').trim().split('\n')[0] || '<no output>'}` };
  const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = combined.match(/(?:openjdk|java) version "([^"]+)"/);
  if (!m) return { available: false, reason: 'java -version produced no version banner' };
  return { available: true, version: m[1], banner: combined.trim().split('\n')[0] };
}

function probeCli() {
  const cliName = 'openapi-generator-cli';
  const which = spawnSync('which', [cliName], { encoding: 'utf8' });
  const onPath = which.status === 0 && (which.stdout || '').trim();
  if (!onPath) {
    return { available: false, reason: `${cliName} not found on PATH; refusing to invoke unpinned fallbacks` };
  }
  const versionResult = spawnSync(cliName, ['version'], { encoding: 'utf8' });
  if (versionResult.status !== 0) {
    return { available: false, reason: `${cliName} on PATH (${onPath}) but 'version' subcommand failed: status=${versionResult.status}` };
  }
  const versionOut = `${versionResult.stdout ?? ''}${versionResult.stderr ?? ''}`;
  const versionMatch = versionOut.match(/(\d+\.\d+\.\d+)/);
  if (!versionMatch) {
    return { available: false, reason: `${cliName} on PATH (${onPath}) but version banner did not contain a semver: ${versionOut.trim().slice(0, 200)}` };
  }
  const observedVersion = versionMatch[1];
  if (observedVersion !== REQUIRED_GENERATOR_VERSION) {
    return { available: false, reason: `${cliName} reports ${observedVersion}, required ${REQUIRED_GENERATOR_VERSION}` };
  }
  return {
    available: true,
    command: cliName,
    resolution: `PATH:${onPath}`,
    version: observedVersion,
  };
}

async function inspectGeneratorProvenance() {
  const tsProvenance = resolve(repoRoot, 'packages/sdk-ts/generated/PROVENANCE.json');
  const pyProvenance = resolve(repoRoot, 'packages/sdk-python/generated/PROVENANCE.json');
  let tsProv, pyProv;
  try { tsProv = JSON.parse(await readFile(tsProvenance, 'utf8')); } catch (e) {
    return { ok: false, drift: `cannot read ts PROVENANCE: ${e.message}` };
  }
  try { pyProv = JSON.parse(await readFile(pyProvenance, 'utf8')); } catch (e) {
    return { ok: false, drift: `cannot read py PROVENANCE: ${e.message}` };
  }
  const drift = [];
  if (tsProv.version !== pyProv.version) drift.push(`version mismatch: ts=${tsProv.version} py=${pyProv.version}`);
  if (tsProv.generator !== pyProv.generator) drift.push('generator string mismatch between ts and py');
  if (tsProv.source !== pyProv.source) drift.push('source mismatch between ts and py');
  if (JSON.stringify(tsProv.contract_fixtures) !== JSON.stringify(pyProv.contract_fixtures)) {
    drift.push('contract_fixtures mismatch');
  }
  if (drift.length > 0) return { ok: false, drift: drift.join('; '), tsProv, pyProv };
  return { ok: true, drift: null, provenance: tsProv };
}

async function persistArtifact(artifact) {
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

async function main() {
  await mkdir(dirname(artifactPath), { recursive: true });

  const java = probeJava();
  const cli = probeCli();
  const availability = {
    java_available: java.available,
    java_version: java.available ? java.version : null,
    java_reason: java.available ? null : java.reason,
    cli_available: cli.available,
    cli_command: cli.available ? cli.command : null,
    cli_version: cli.available ? cli.version : null,
    cli_reason: cli.available ? null : cli.reason,
    generator_available: java.available && cli.available,
    generator_version_required: REQUIRED_GENERATOR_VERSION,
    generator_name: REQUIRED_GENERATOR_NAME,
  };
  steps['01-generator-availability'] = {
    name: '01-generator-availability',
    kind: 'probe',
    status: availability.generator_available ? 'PASS' : 'BLOCKED',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    availability,
    assertion: 'java+openapi-generator-cli@7.10.0 must both be reachable',
  };
  recordAssertion('generator-availability', availability.generator_available,
    availability.generator_available ? 'java and CLI both available' : (java.reason ?? cli.reason));

  // `soft`, so a fail-closed exit code 2 surfaces as BLOCKED rather than FAIL.
  const genResult = await runStep({
    name: '02-generator-generation',
    kind: 'soft',
    command: process.execPath,
    args: [resolve(repoRoot, 'scripts/generate-sdks.mjs')],
  });
  recordAssertion('generator-generation', genResult.exitCode === 0,
    genResult.exitCode === 0 ? 'generator exit 0' : `generator exit ${genResult.exitCode}: ${tail(genResult.stderr, 240)}`);

  // Compare the TS and Python PROVENANCE files. They are updated even when the
  // generator fails closed, recording `generator_available:false`.
  const inspect = await inspectGeneratorProvenance();
  steps['02b-generator-provenance'] = {
    name: '02b-generator-provenance',
    kind: 'probe',
    status: inspect.ok ? 'PASS' : 'BLOCKED',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    drift: inspect.drift,
    provenance: inspect.provenance ?? null,
  };
  recordAssertion('generator-provenance-parity', inspect.ok, inspect.drift ?? 'ts/py provenance identical');

  const generator_available_observed = !!(inspect.provenance && inspect.provenance.generator_available === true);

  const driftResult = await runStep({
    name: '03-openapi-drift',
    kind: 'hard',
    command: process.execPath,
    args: [resolve(repoRoot, 'scripts/check-openapi-drift.mjs')],
  });
  recordAssertion('openapi-drift-detector', driftResult.exitCode === 0,
    driftResult.exitCode === 0 ? 'openapi drift ok' : `openapi drift exit ${driftResult.exitCode}`);

  const openapiTests = await runStep({
    name: '04-openapi-tests',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/openapi-contract.test.ts'],
  });
  recordAssertion('openapi-contract-tests', openapiTests.exitCode === 0,
    openapiTests.exitCode === 0 ? 'openapi-contract tests ok' : `openapi-contract tests exit ${openapiTests.exitCode}`);

  const restTests = await runStep({
    name: '05-rest-tests',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/rest/rest-boundary.test.ts'],
  });
  recordAssertion('rest-boundary-tests', restTests.exitCode === 0,
    restTests.exitCode === 0 ? 'rest-boundary tests ok' : `rest-boundary tests exit ${restTests.exitCode}`);

  const driftScriptTests = await runStep({
    name: '06-drift-script-tests',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/check-openapi-drift.test.ts'],
  });
  recordAssertion('drift-script-tests', driftScriptTests.exitCode === 0,
    driftScriptTests.exitCode === 0 ? 'drift script tests ok' : `drift script tests exit ${driftScriptTests.exitCode}`);

  const driftDetectorTests = await runStep({
    name: '07-drift-detector-tests',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/openapi-drift-detector.test.ts'],
  });
  recordAssertion('drift-detector-tests', driftDetectorTests.exitCode === 0,
    driftDetectorTests.exitCode === 0 ? 'drift detector tests ok' : `drift detector tests exit ${driftDetectorTests.exitCode}`);

  const sdkContract = await runStep({
    name: '08-sdk-contract-tests',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/sdk-ts-contract.test.ts'],
  });
  recordAssertion('sdk-contract-tests', sdkContract.exitCode === 0,
    sdkContract.exitCode === 0 ? 'sdk contract tests ok' : `sdk contract tests exit ${sdkContract.exitCode}`);

  const sdkDrift = await runStep({
    name: '09-sdk-drift-tests',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/sdk-drift.test.ts'],
  });
  recordAssertion('sdk-drift-tests', sdkDrift.exitCode === 0,
    sdkDrift.exitCode === 0 ? 'sdk drift tests ok' : `sdk drift tests exit ${sdkDrift.exitCode}`);

  const lint = await runStep({
    name: '10-lint',
    kind: 'hard',
    command: 'pnpm',
    args: ['lint'],
  });
  recordAssertion('lint', lint.exitCode === 0,
    lint.exitCode === 0 ? 'lint ok' : `lint exit ${lint.exitCode}`);

  const typecheck = await runStep({
    name: '11-typecheck',
    kind: 'hard',
    command: 'pnpm',
    args: ['typecheck'],
  });
  recordAssertion('typecheck', typecheck.exitCode === 0,
    typecheck.exitCode === 0 ? 'typecheck ok' : `typecheck exit ${typecheck.exitCode}`);

  const build = await runStep({
    name: '12-build',
    kind: 'hard',
    command: 'pnpm',
    args: ['build'],
  });
  recordAssertion('build', build.exitCode === 0,
    build.exitCode === 0 ? 'build ok' : `build exit ${build.exitCode}`);

  const catalog = await runStep({
    name: '13-catalog-regression',
    kind: 'hard',
    command: 'pnpm',
    args: ['catalog:gate'],
    timeoutMs: 30 * 60 * 1000,
  });
  recordAssertion('catalog-regression', catalog.exitCode === 0,
    catalog.exitCode === 0 ? 'catalog gate ok' : `catalog gate exit ${catalog.exitCode}`);

  // A missing script is SKIPPED; a script that exists but fails is FAIL.
  const packagingCandidates = [
    { id: '14a-package-repro', label: 'package-reproducibility', script: 'scripts/package-repro.mjs' },
    { id: '14b-external-install-catalog', label: 'external-install (catalog)', script: 'scripts/external-install-catalog.mjs' },
  ];
  for (const candidate of packagingCandidates) {
    const scriptAbs = resolve(repoRoot, candidate.script);
    if (!existsSync(scriptAbs)) {
      steps[candidate.id] = {
        name: candidate.id,
        kind: 'opt-in',
        status: 'SKIPPED',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        command: `${process.execPath} ${candidate.script}`,
        reason: 'script not present in this repo state',
      };
      recordAssertion(candidate.label, null, 'script not present');
      continue;
    }
    const r = await runStep({
      name: candidate.id,
      kind: 'opt-in',
      command: process.execPath,
      args: [scriptAbs],
      timeoutMs: 15 * 60 * 1000,
    });
    recordAssertion(candidate.label, r.exitCode === 0,
      r.exitCode === 0 ? `${candidate.label} ok` : `${candidate.label} exit ${r.exitCode}`);
  }

  const allStepNames = Object.keys(steps);
  const hardFailures = allStepNames.filter((n) => steps[n].status === 'FAIL');
  const blockedSteps = allStepNames.filter((n) => steps[n].status === 'BLOCKED');
  const passedSteps = allStepNames.filter((n) => steps[n].status === 'PASS');
  const skippedSteps = allStepNames.filter((n) => steps[n].status === 'SKIPPED');

  const generatorStep = steps['02-generator-generation'];
  const generatorProbedAvailable = availability.generator_available;
  const generatorActuallyRan = generatorStep?.status === 'PASS' && generator_available_observed;
  const generatorBlocked = generatorStep?.status === 'BLOCKED' || !generatorActuallyRan;

  let verdict;
  if (hardFailures.length > 0) {
    verdict = 'FAIL';
  } else if (generatorBlocked) {
    verdict = 'BLOCKED';
  } else {
    verdict = 'PASS';
  }

  const passingAssertions = assertions.filter((a) => a.ok === true).length;
  const failingAssertions = assertions.filter((a) => a.ok === false).length;
  const skippedAssertions = assertions.filter((a) => a.ok === null).length;

  const artifact = {
    gate: 'openapi',
    status: verdict,
    verdict,
    complete: verdict === 'PASS',
    blocked: verdict === 'BLOCKED',
    failed: verdict === 'FAIL',
    java_available: java.available,
    java_reason: java.available ? null : java.reason,
    cli_available: cli.available,
    cli_reason: cli.available ? null : cli.reason,
    generator_available: generatorActuallyRan,
    generator_observed_available: generator_available_observed,
    generator_probed_available: generatorProbedAvailable,
    generator_blocked: generatorBlocked,
    generator_version_required: REQUIRED_GENERATOR_VERSION,
    generator_version_observed: (inspect.provenance && inspect.provenance.version) || null,
    summary: {
      steps_total: allStepNames.length,
      steps_passed: passedSteps.length,
      steps_blocked: blockedSteps.length,
      steps_failed: hardFailures.length,
      steps_skipped: skippedSteps.length,
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
    artifact_path: 'artifacts/openapi-gate.json',
    emitted_at: new Date().toISOString(),
  };

  if (inspect.drift) artifact.drift = inspect.drift;
  if (hardFailures.length > 0) artifact.failed_steps = hardFailures;
  if (blockedSteps.length > 0) artifact.blocked_steps = blockedSteps;

  await persistArtifact(artifact);
  console.log(JSON.stringify(artifact, null, 2));

  if (verdict === 'FAIL') process.exit(1);
  if (verdict === 'BLOCKED') process.exit(2);
}

await main();
