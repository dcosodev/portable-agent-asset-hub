import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { backupDatabase, SqliteStore } from '../packages/storage-sqlite/dist/index.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const dir = await mkdtemp(join(tmpdir(), 's2-fresh-backup-'));
try {
  const source = join(dir, 'source.sqlite');
  const backup = join(dir, 'backup.sqlite');
  const store = new SqliteStore(source);
  store.close();
  const manifest = await backupDatabase(source, backup);
  const digest = createHash('sha256').update(await readFile(backup)).digest('hex');
  if (digest !== manifest.sha256) throw new Error('backup manifest hash mismatch');
  const child = join(dir, 'child.mjs');
  await writeFile(child, `
    import { SqliteStore } from ${JSON.stringify(join(root, 'packages/storage-sqlite/dist/index.js'))};
    const store = new SqliteStore(${JSON.stringify(backup)});
    const result = store.doctor();
    console.log(JSON.stringify({ doctor: result.ok }));
    store.close();
    if (!result.ok) process.exit(2);
  `);
  const output = await new Promise((resolvePromise, reject) => {
    const process = spawn(globalThis.process.execPath, [child], { cwd: dir });
    let out = '';
    let err = '';
    process.stdout.on('data', (bytes) => { out += bytes; });
    process.stderr.on('data', (bytes) => { err += bytes; });
    process.on('error', reject);
    process.on('close', (code, signal) => resolvePromise({ code, signal, out, err }));
  });
  if (output.code !== 0 || !output.out.includes('"doctor":true')) {
    throw new Error(`fresh process failed: ${JSON.stringify(output)}`);
  }
  console.log(JSON.stringify({ ok: true, manifest, childExit: output.code, childOutput: output.out.trim() }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
