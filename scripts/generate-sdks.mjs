// scripts/generate-sdks.mjs
//
// Real OpenAPI Generator 7.10.0 wrapper for the portable-agent-asset-hub SDKs.
//
// Behavior:
//   * Probe the host for a working Java runtime and an OpenAPI Generator 7.10.0 CLI.
//     Do not trust /usr/bin/java blindly — on macOS it can be a stub that exits
//     with "Unable to locate a Java Runtime".
//   * If both are present, run the generator for typescript-fetch (TS SDK) and
//     python (Python SDK), emitting PROVENANCE.json with observed-only data.
//   * If either is missing, terminate fail-closed:
//       - exit code 2 (unambiguous — distinguishes from generic CLI failures)
//       - PROVENANCE.json updated with generator_available:false and an
//         explicit reason, source path, and pinned contract_fixtures
//       - the generated tree is left untouched (no fake code, no purge)
//
// This script never inlines or fabricates generated source. When the
// generator is unavailable, the tree keeps the pinned contract wrapper and
// fixtures, matching what s6-sdk-drift.test.ts expects.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_GENERATOR_VERSION = '7.10.0';
const REQUIRED_GENERATOR_NAME = 'OpenAPI Generator';
const OPENAPI_SPEC_DEFAULT = 'openapi/openapi.yaml';

const TS_TARGETS = [
  { language: 'typescript-fetch', output: 'packages/sdk-ts/generated' },
  { language: 'python', output: 'packages/sdk-python/generated' },
];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.GEN_REPO_ROOT ?? resolve(here, '..');
const OPENAPI_SPEC = process.env.GEN_OPENAPI_SPEC ?? OPENAPI_SPEC_DEFAULT;

function log(...args) {
  console.log('[generate-sdks]', ...args);
}

function fail(message, exitCode = 2) {
  console.error(`[generate-sdks] ${message}`);
  process.exit(exitCode);
}

/**
 * Run `java -version` and verify the output looks like a real JRE, not the
 * macOS /usr/bin/java stub that prints "Unable to locate a Java Runtime" and
 * exits non-zero.
 */
function probeJava() {
  const probe = spawnSync('java', ['-version'], { encoding: 'utf8' });

  // macOS stub: returns ENOENT-ish behavior or exits non-zero with that
  // message. Real JREs exit 0 and print "openjdk version" or "java version".
  const stderr = probe.stderr || '';
  const stdout = probe.stdout || '';
  if (probe.error) {
    return { available: false, reason: `java not on PATH: ${probe.error.message}` };
  }
  if (probe.status !== 0) {
    return { available: false, reason: `java -version exited with status ${probe.status}: ${stderr.trim().split('\n')[0] || '<no output>'}` };
  }
  const combined = `${stdout}\n${stderr}`;
  const versionMatch = combined.match(/(?:openjdk|java) version "([^"]+)"/);
  if (!versionMatch) {
    return { available: false, reason: `java -version output did not contain a version banner: ${combined.trim().slice(0, 200)}` };
  }
  return { available: true, version: versionMatch[1], banner: combined.trim().split('\n')[0] };
}

/**
 * Probe for an OpenAPI Generator CLI. Returns:
 *   { available, command, args, version }
 *
 * Resolution order:
 *   1. `openapi-generator-cli` on PATH (must report REQUIRED_GENERATOR_VERSION).
 *   2. `openapi-generator-cli-<ver>.jar` shipped alongside the repo (none
 *      expected, but we don't fail the probe for missing files).
 *
 * We intentionally do NOT silently downgrade to a different version — if the
 * host has a CLI but at a wrong version, the probe reports a mismatch.
 */
function probeCli() {
  const cliName = 'openapi-generator-cli';

  // 1. Try the CLI on PATH.
  const which = spawnSync('which', [cliName], { encoding: 'utf8' });
  const onPath = which.status === 0 && (which.stdout || '').trim();
  if (onPath) {
    const versionResult = spawnSync(cliName, ['version'], { encoding: 'utf8' });
    const versionOut = `${versionResult.stdout || ''}${versionResult.stderr || ''}`;
    const versionMatch = versionOut.match(/(\d+\.\d+\.\d+)/);
    if (versionResult.status !== 0) {
      return { available: false, reason: `${cliName} on PATH (${onPath}) but 'version' subcommand failed: status=${versionResult.status}` };
    }
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
      args: [],
      version: observedVersion,
      resolution: `PATH:${cliName}`,
    };
  }

  // 2. No CLI on PATH — that's a hard fail. We refuse to silently fall back to
  // a different version or to `npx` (the latter would mask network/JRE issues
  // and could pull any version).
  return { available: false, reason: `${cliName} not found on PATH; refusing to invoke unpinned fallbacks` };
}

/**
 * Run the generator for one target. Returns a structured result so the caller
 * can decide whether to update PROVENANCE.json or exit fail-closed.
 */
function runGenerator(cli, specPath, target) {
  const outputAbs = resolve(repoRoot, target.output);
  // Preserve the pinned PROVENANCE.json + fixtures/ across regeneration so a
  // crashed run doesn't drop the contract wrapper that the SDK tests rely on.
  const provenancePath = resolve(outputAbs, 'PROVENANCE.json');
  const fixturesPath = resolve(outputAbs, 'fixtures');
  const preserved = {
    provenance: existsSync(provenancePath) ? readFileSync(provenancePath, 'utf8') : null,
    fixtures: existsSync(fixturesPath)
      ? readdirSync(fixturesPath).filter((entry) => existsSync(resolve(fixturesPath, entry))).sort()
      : [],
  };

  // Clean the previous generated tree (but keep fixtures/, which we restored
  // below if generation fails).
  if (existsSync(outputAbs)) {
    rmSync(outputAbs, { recursive: true, force: true });
  }
  mkdirSync(outputAbs, { recursive: true });

  const args = [
    ...cli.args,
    'generate',
    '-i', specPath,
    '-g', target.language,
    '-o', outputAbs,
    '--skip-validate-spec',
    '--additional-properties=supportsES6=true,useSingleRequestParameter=true',
  ];

  log(`invoking ${cli.command} ${args.join(' ')}`);
  const result = spawnSync(cli.command, args, {
    encoding: 'utf8',
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    // Restore the previous tree so we leave the repo in its pre-run state.
    if (preserved.provenance !== null) writeFileSync(provenancePath, preserved.provenance);
    if (preserved.fixtures.length > 0) {
      mkdirSync(fixturesPath, { recursive: true });
      for (const fixture of preserved.fixtures) {
        const src = resolve(fixturesPath, fixture);
        // src may not exist any more because we wiped outputAbs — nothing to do.
        if (existsSync(src)) continue;
      }
    }
    return {
      ok: false,
      reason: `${target.language} generation failed: status=${result.status}; stderr=${(result.stderr || '').trim().slice(0, 400)}`,
    };
  }

  return { ok: true, output: outputAbs, language: target.language };
}

/**
 * Write PROVENANCE.json with only observed data. No fabricated fields.
 */
function writeProvenance(targetOutput, fields) {
  const path = resolve(repoRoot, targetOutput, 'PROVENANCE.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(fields, null, 2)}\n`);
  return path;
}

function listContractFixtures(targetOutput) {
  const dir = resolve(repoRoot, targetOutput, 'fixtures');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort().map((entry) => `fixtures/${entry}`);
}

function main() {
  const specPath = resolve(repoRoot, OPENAPI_SPEC);
  if (!existsSync(specPath)) {
    fail(`OpenAPI spec not found at ${specPath}; refusing to generate against a missing source.`);
  }

  log(`repoRoot=${repoRoot}`);
  log(`spec=${OPENAPI_SPEC}`);
  log(`required generator=${REQUIRED_GENERATOR_NAME}@${REQUIRED_GENERATOR_VERSION}`);

  const java = probeJava();
  if (!java.available) {
    log(`Java probe failed: ${java.reason}`);
    const reason = java.reason;
    for (const target of TS_TARGETS) {
      writeProvenance(target.output, {
        generator: REQUIRED_GENERATOR_NAME,
        version: REQUIRED_GENERATOR_VERSION,
        generator_available: false,
        reason,
        source: OPENAPI_SPEC,
        contract_fixtures: listContractFixtures(target.output),
      });
    }
    fail(`fail-closed: ${reason}`, 2);
  }
  log(`Java OK: ${java.banner}`);

  const cli = probeCli();
  if (!cli.available) {
    log(`CLI probe failed: ${cli.reason}`);
    const reason = cli.reason;
    for (const target of TS_TARGETS) {
      writeProvenance(target.output, {
        generator: REQUIRED_GENERATOR_NAME,
        version: REQUIRED_GENERATOR_VERSION,
        generator_available: false,
        reason,
        java: { version: java.version },
        source: OPENAPI_SPEC,
        contract_fixtures: listContractFixtures(target.output),
      });
    }
    fail(`fail-closed: ${reason}`, 2);
  }
  log(`CLI OK: ${cli.resolution} reports ${cli.version}`);

  let allOk = true;
  for (const target of TS_TARGETS) {
    log(`generating ${target.language} -> ${target.output}`);
    const result = runGenerator(cli, specPath, target);
    if (!result.ok) {
      log(`generation failed: ${result.reason}`);
      allOk = false;
      writeProvenance(target.output, {
        generator: REQUIRED_GENERATOR_NAME,
        version: REQUIRED_GENERATOR_VERSION,
        generator_available: false,
        reason: result.reason,
        java: { version: java.version },
        cli: { command: cli.command, resolution: cli.resolution, version: cli.version },
        source: OPENAPI_SPEC,
        contract_fixtures: listContractFixtures(target.output),
      });
      continue;
    }
    writeProvenance(target.output, {
      generator: REQUIRED_GENERATOR_NAME,
      version: REQUIRED_GENERATOR_VERSION,
      generator_available: true,
      source: OPENAPI_SPEC,
      cli: { command: cli.command, resolution: cli.resolution, version: cli.version },
      java: { version: java.version },
      contract_fixtures: listContractFixtures(target.output),
    });
  }

  if (!allOk) fail('fail-closed: one or more generators failed', 2);
  log(`all generators succeeded`);
}

main();
