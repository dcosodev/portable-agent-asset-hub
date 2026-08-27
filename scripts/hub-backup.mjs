#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
const db = arg('--db') ?? process.env.AGENT_MEMORY_DB_PATH;
const output = arg('--output');
if (!db || !output) {
  console.error('usage: hub-backup.mjs --db <hub.sqlite> --output <backup.sqlite>');
  process.exit(2);
}
const source = resolve(db); const target = resolve(output);
if (!existsSync(source)) { console.error(`source database does not exist: ${source}`); process.exit(2); }
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const result = spawnSync('sqlite3', [source, `.backup '${target.replaceAll("'", "''")}'`], { encoding: 'utf8' });
if (result.status !== 0) { process.stderr.write(result.stderr || 'sqlite backup failed\n'); process.exit(result.status ?? 1); }
console.log(JSON.stringify({ source, backup: target }));
