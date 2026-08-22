#!/usr/bin/env node
// scripts/s6-gate.mjs
//
// Comprehensive S6 gate: fail-closed, auditable, single source of truth for
// the S6 release surface. Executes every validation step that touches the
// OpenAPI contract, REST routes, SDK generation, drift detection, and
// downstream packaging — and records each step's command, exit code,
// stdout/stderr digest, and PASS/BLOCKED/FAIL verdict under
// artifacts/s6-gate.json.
//
// Pipeline (every step always runs; failures short-circuit subsequent
// non-essential steps but never rewrite earlier verdicts):
//
//   01 generator-availability    — probe Java + openapi-generator-cli@7.10.0
//   02 generator-generation      — `scripts/generate-sdks.mjs` (real run)
//   03 openapi-drift             — `scripts/check-openapi-drift.mjs`
//   04 openapi-tests             — tests/s6-openapi.test.ts
//   05 rest-tests                — tests/rest/s6-rest.test.ts
//   06 drift-tests-legacy        — tests/check-openapi-drift.test.ts
//   07 drift-tests-new           — tests/s6-check-openapi-drift.test.ts
//   08 sdk-contract-tests        — tests/s6-sdk-ts-contract.test.ts
//   09 sdk-drift-tests           — tests/s6-sdk-drift.test.ts
//   10 lint                      — `pnpm lint`
//   11 typecheck                 — `pnpm typecheck`
//   12 build                     — `pnpm build`
//   13 s5-regression             — `pnpm s5:gate`
//   14 packaging-external-cwd    — `scripts/package-repro.mjs` and
//                                  `scripts/external-install-s5.mjs` when
//                                  present and runnable.
//
// Status semantics (exposed as `status` and `verdict` in the artifact):
//
//   * PASS    — every step PASSED, the generator actually ran successfully,
//               and drift is clean. Reserved for the case where the real
//               generator produced code. This is the only state that should
//               be treated as an APPROVE.
//
//   * BLOCKED — every deterministic step PASSED but the generator step is
//               in its honest fail-closed branch (`generator_available:false`
//               because Java or the CLI is missing, or exit code 2). The gate
//               refuses to mark this PASS — the S6 release surface requires
//               a real SDK regeneration. This is the expected state in this
//               host.
//
//   * FAIL    — at least one deterministic step (lint/typecheck/build/tests
//               /drift/s5) failed. The artifact always names the failing
//               step and the exit code so the next run can be diagnosed.
//
// The script never hides `generator_available:false`. When the generator
// reports its honest fail-closed state, that fact is forwarded verbatim
// into `generator_available`, `generator_reason`, and the per-step record
// so the artifact is auditable end-to-end.

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const artifactPath = resolve(repoRoot, 'artifacts/s6-gate.json');

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

  // 01 — Generator availability probe.
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

  // 02 — Real generator run. `soft` so a fail-closed exit code 2 surfaces as
  // BLOCKED rather than poisoning every subsequent step's PASS verdict.
  const genResult = await runStep({
    name: '02-generator-generation',
    kind: 'soft',
    command: process.execPath,
    args: [resolve(repoRoot, 'scripts/generate-sdks.mjs')],
  });
  recordAssertion('generator-generation', genResult.exitCode === 0,
    genResult.exitCode === 0 ? 'generator exit 0' : `generator exit ${genResult.exitCode}: ${tail(genResult.stderr, 240)}`);

  // Inspect the PROVENANCE files written by the generator step to detect
  // drift between the TS and Python SDKs — even when the generator was
  // fail-closed, the provenance files are still updated with the honest
  // `generator_available:false` record.
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

  // 03 — OpenAPI drift detector (the dedicated script).
  const driftResult = await runStep({
    name: '03-openapi-drift',
    kind: 'hard',
    command: process.execPath,
    args: [resolve(repoRoot, 'scripts/check-openapi-drift.mjs')],
  });
  recordAssertion('openapi-drift-detector', driftResult.exitCode === 0,
    driftResult.exitCode === 0 ? 'openapi drift ok' : `openapi drift exit ${driftResult.exitCode}`);

  // 04 — OpenAPI tests (the s6-openapi tracer bullet).
  const openapiTests = await runStep({
    name: '04-openapi-tests',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/s6-openapi.test.ts'],
  });
  recordAssertion('s6-openapi-tests', openapiTests.exitCode === 0,
    openapiTests.exitCode === 0 ? 's6-openapi tests ok' : `s6-openapi tests exit ${openapiTests.exitCode}`);

  // 05 — REST/S6 tests (split under tests/rest/).
  const restTests = await runStep({
    name: '05-rest-tests',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/rest/s6-rest.test.ts'],
  });
  recordAssertion('s6-rest-tests', restTests.exitCode === 0,
    restTests.exitCode === 0 ? 's6-rest tests ok' : `s6-rest tests exit ${restTests.exitCode}`);

  // 06 — Drift tests: LEGACY detector contract (tests/check-openapi-drift.test.ts).
  const legacyDriftTests = await runStep({
    name: '06-drift-tests-legacy',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/check-openapi-drift.test.ts'],
  });
  recordAssertion('drift-tests-legacy', legacyDriftTests.exitCode === 0,
    legacyDriftTests.exitCode === 0 ? 'legacy drift tests ok' : `legacy drift tests exit ${legacyDriftTests.exitCode}`);

  // 07 — Drift tests: NEW S6 detector contract (tests/s6-check-openapi-drift.test.ts).
  const newDriftTests = await runStep({
    name: '07-drift-tests-new',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/s6-check-openapi-drift.test.ts'],
  });
  recordAssertion('drift-tests-new', newDriftTests.exitCode === 0,
    newDriftTests.exitCode === 0 ? 'new drift tests ok' : `new drift tests exit ${newDriftTests.exitCode}`);

  // 08 — SDK TS contract tests (TS SDK ↔ REST roundtrip via the pinned fixtures).
  const sdkContract = await runStep({
    name: '08-sdk-contract-tests',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/s6-sdk-ts-contract.test.ts'],
  });
  recordAssertion('sdk-contract-tests', sdkContract.exitCode === 0,
    sdkContract.exitCode === 0 ? 'sdk contract tests ok' : `sdk contract tests exit ${sdkContract.exitCode}`);

  // 09 — SDK drift tests (TS↔PY generated trees stay in parity).
  const sdkDrift = await runStep({
    name: '09-sdk-drift-tests',
    kind: 'hard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'tests/s6-sdk-drift.test.ts'],
  });
  recordAssertion('sdk-drift-tests', sdkDrift.exitCode === 0,
    sdkDrift.exitCode === 0 ? 'sdk drift tests ok' : `sdk drift tests exit ${sdkDrift.exitCode}`);

  // 10 — lint.
  const lint = await runStep({
    name: '10-lint',
    kind: 'hard',
    command: 'pnpm',
    args: ['lint'],
  });
  recordAssertion('lint', lint.exitCode === 0,
    lint.exitCode === 0 ? 'lint ok' : `lint exit ${lint.exitCode}`);

  // 11 — typecheck.
  const typecheck = await runStep({
    name: '11-typecheck',
    kind: 'hard',
    command: 'pnpm',
    args: ['typecheck'],
  });
  recordAssertion('typecheck', typecheck.exitCode === 0,
    typecheck.exitCode === 0 ? 'typecheck ok' : `typecheck exit ${typecheck.exitCode}`);

  // 12 — build.
  const build = await runStep({
    name: '12-build',
    kind: 'hard',
    command: 'pnpm',
    args: ['build'],
  });
  recordAssertion('build', build.exitCode === 0,
    build.exitCode === 0 ? 'build ok' : `build exit ${build.exitCode}`);

  // 13 — s5:gate regression.
  const s5 = await runStep({
    name: '13-s5-regression',
    kind: 'hard',
    command: 'pnpm',
    args: ['s5:gate'],
    timeoutMs: 30 * 60 * 1000,
  });
  recordAssertion('s5-regression', s5.exitCode === 0,
    s5.exitCode === 0 ? 's5 gate ok' : `s5 gate exit ${s5.exitCode}`);

  // 14 — Packaging / external-cwd checks (available scripts only).
  // Each entry is independently opt-in: the script must exist on disk and
  // must be runnable in this host. Missing scripts are recorded as SKIPPED
  // (not as failures); a script that exists but fails is recorded as FAIL.
  const packagingCandidates = [
    { id: '14a-package-repro', label: 'package-reproducibility', script: 'scripts/package-repro.mjs' },
    { id: '14b-external-install-s5', label: 'external-install (s5)', script: 'scripts/external-install-s5.mjs' },
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

  // ----- Aggregate verdicts -----
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
    gate: 's6',
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
    artifact_path: 'artifacts/s6-gate.json',
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
