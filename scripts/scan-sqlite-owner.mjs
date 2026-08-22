import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const forbidden = /(?:from\s+['"]node:sqlite|import\s*\(\s*['"]node:sqlite|new\s+DatabaseSync|DatabaseSync\s*\()/u;

async function files(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.(?:ts|mts|mjs|js)$/u.test(entry.name)) result.push(path);
  }
  return result;
}

export async function scanSqliteOwners(root) {
  const violations = [];
  for (const path of await files(join(root, 'packages'))) {
    if (path.includes('/packages/storage-sqlite/')) continue;
    const source = await import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8'));
    if (forbidden.test(source)) violations.push(relative(root, path));
  }
  return { ok: violations.length === 0, violations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await scanSqliteOwners(process.cwd());
  if (!result.ok) process.exitCode = 1;
  console.log(JSON.stringify(result));
}
