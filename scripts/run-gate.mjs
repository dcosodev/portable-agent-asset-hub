// Runs one chained gate, at most once per top-level invocation.
//
// Most gates re-run earlier gates as regressions, and each level repeats the levels
// below it, so `migration:gate` used to run `catalog:gate` 16 times. This wrapper makes
// a repeat within one chain replay the recorded result instead.
//
// A result is reused only when all of these hold:
//   - it was recorded by the same top-level invocation: the record directory is created
//     here and removed on exit, so nothing survives into the next run;
//   - the tree was unchanged while the gate ran and is still unchanged;
//   - the gate's evidence file on disk is the one the gate left behind.
// Anything else runs the gate. A failure replays as the same failure, and a gate killed
// by a signal or timeout records nothing. GATE_NO_REUSE=1 runs every repeat for real.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MEMO_ENV = 'GATE_MEMO_DIR';
const EVIDENCE = {
  storage: 'artifacts/storage-evidence.json',
  memory: 'artifacts/memory-evidence.json',
  profile: 'artifacts/profile-evidence.json',
  catalog: 'artifacts/catalog-evidence.json',
  openapi: 'artifacts/openapi-gate.json',
  mcp: 'artifacts/mcp-gate.json',
  hermes: 'artifacts/hermes-gate.json',
  openclaw: 'artifacts/openclaw-gate.json',
  migration: 'artifacts/migration-gate.json',
};

const root = resolve(new URL('..', import.meta.url).pathname);
const name = process.argv[2];
if (!name || !/^[a-z0-9-]+$/.test(name)) {
  console.error('usage: node scripts/run-gate.mjs <gate>');
  process.exit(64);
}
const script = join(root, 'scripts', `${name}-gate.mjs`);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const evidencePath = EVIDENCE[name] ? join(root, EVIDENCE[name]) : null;
const evidenceDigest = () => (evidencePath && existsSync(evidencePath) ? sha256(readFileSync(evidencePath)) : null);

function git(args) {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 1024 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

/** A digest of the tree, or null when there is no repository to describe it. */
function fingerprint() {
  try {
    if (resolve(git(['rev-parse', '--show-toplevel']).toString().trim()) !== resolve(root)) return null;
    const hash = createHash('sha256');
    hash.update(git(['rev-parse', 'HEAD']));
    hash.update(git(['diff', 'HEAD', '--binary']));
    for (const file of git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)) {
      hash.update(file);
      hash.update(readFileSync(join(root, file)));
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function runGate() {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script], { cwd: root, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => { stdout.push(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr.push(chunk); process.stderr.write(chunk); });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.on('close', (exitCode, signal) => done({
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString('base64'),
      stderr: Buffer.concat(stderr).toString('base64'),
    }));
  });
}

function exitLike(result) {
  if (result.signal) process.exit(128 + (result.signal === 'SIGKILL' ? 9 : result.signal === 'SIGINT' ? 2 : 15));
  process.exit(result.exitCode ?? 1);
}

const isTopLevel = !process.env[MEMO_ENV];
if (process.env.GATE_NO_REUSE === '1') exitLike(await runGate());
if (isTopLevel) process.env[MEMO_ENV] = mkdtempSync(join(tmpdir(), 'gate-memo-'));
const memoDir = process.env[MEMO_ENV];
if (isTopLevel) process.on('exit', () => rmSync(memoDir, { recursive: true, force: true }));
mkdirSync(memoDir, { recursive: true });
const recordPath = join(memoDir, `${sha256(root).slice(0, 16)}-${name}.json`);

const before = fingerprint();
if (before && existsSync(recordPath)) {
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (record.fingerprint === before && record.evidence === evidenceDigest()) {
    process.stdout.write(Buffer.from(record.stdout, 'base64'));
    process.stderr.write(Buffer.from(record.stderr, 'base64'));
    process.stderr.write(`[run-gate] ${name}: reused the result from this run (exit ${record.exitCode}); tree unchanged\n`);
    process.exit(record.exitCode);
  }
}

const result = await runGate();
if (before && !result.signal && result.exitCode !== null && fingerprint() === before) {
  const temp = `${recordPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ fingerprint: before, evidence: evidenceDigest(), exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }));
  renameSync(temp, recordPath);
}
exitLike(result);
