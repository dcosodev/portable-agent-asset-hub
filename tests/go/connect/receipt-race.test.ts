// One receipt per runId must hold across processes, not only for writers that
// run one after another: the existence check alone lets racing writers through,
// and they would all report success. A barrier lines the writers up on the same
// millisecond. Exactly one succeeding holds for any interleaving, so this cannot
// fail on a correct writer, whatever the machine's load.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './_connect-harness';

const WRITERS = 4;
const STORE = pathToFileURL(resolve(repoRoot, 'internal/connect/receipt_store.mjs')).href;
const WORKER = `
  const { write } = await import(process.env.STORE);
  while (Date.now() < Number(process.env.AT)) { /* barrier */ }
  try {
    write(process.env.HOME_DIR, {
      schemaVersion: 1, runId: 'run_race', targetRoot: '/tmp/race', lockDir: '/tmp/race',
      harness: 'hermes', profileId: 'prf_race', observedDigest: '${'a'.repeat(64)}',
      writtenAt: '2026-01-01T00:00:00.000Z',
    });
    console.log('written');
  } catch (error) { console.log(error.code); }
`;

function runWriter(home: string, at: number): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER], {
      env: { ...process.env, STORE, HOME_DIR: home, AT: String(at) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.once('error', fail);
    child.once('close', () => done(out.trim()));
  });
}

describe('receipt store — racing writers', () => {
  it('lets exactly one of several racing writers publish a runId', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hub-receipt-race-'));
    try {
      const at = Date.now() + 1_000;
      const results = await Promise.all(Array.from({ length: WRITERS }, () => runWriter(home, at)));
      expect(results.filter((result) => result === 'written')).toHaveLength(1);
      expect(results.filter((result) => result !== 'written').every((result) => result === 'DUPLICATE')).toBe(true);
      expect(readdirSync(join(home, 'state', 'connect', 'receipts'))).toEqual(['run_race.json']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
